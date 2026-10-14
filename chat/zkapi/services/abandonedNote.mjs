import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import * as sdkWalletStore from '@openanonymity/zkapi-browser-sdk/store';
import { abandonVerdict } from '../versioning/abandonNote.mjs';
import { WALLET_LOCK_NAME } from '../versioning/walletHoldings.mjs';

// The user-confirmed "Give up this balance": retire a zero or dust note from the
// runtime slot so that a version that accepts deposits can load.
//
// Nothing moves on Ethereum and nothing is deleted. The SDK's own
// archiveBrowserWallet writes the note, secret included, to its `archives`
// store in the same IndexedDB transaction that empties the slot, keeps the
// deposit history row, and refuses unless the slot still holds the note it was
// asked about. The deposit stays in the vault until its expiry, when it is
// swept as it would have been anyway.
//
// Safety argument:
//   - Value is bounded twice: by the dust threshold at a current quote and by
//     an absolute ETH ceiling that does not depend on the quote
//     (versioning/abandonNote.mjs).
//   - The decision is taken on a fresh read under the SDK's cross-tab wallet
//     lock, the lock every SDK writer takes, so no lease, withdrawal plan or
//     deposit can be started between the check and the archive.
//   - The check is strict and fails closed: any key or state this host does not
//     recognize refuses, and so does any fact that cannot be read (a client
//     getter that throws, a request list that is not a list, a request archive
//     that cannot be read, a withdrawal list that cannot be read).
//   - The protocol family must be named as reviewed for this (`supported`) and
//     the operator's switch must be stated as on (`enabled`). Both must be
//     exactly true, and the service enforces them itself: a caller that
//     forgets either one gets "not applicable" or "disabled" and nothing is
//     started. A switch that is not stated is never read as on, so a wrapper
//     that drops it cannot turn the action on for a row that switched it off.
//   - It is an explicit action with a confirmation bound to the note and
//     balance that were shown; a changed note or balance refuses, and the SDK's
//     archive repeats the note check inside its own transaction.
//
// Order matters twice:
//   - runtime.init() runs BEFORE the host's lock. initialize() takes the same
//     lock itself and Web Locks are not re-entrant: awaiting init() inside it
//     can never finish. (canceledDeposit.mjs takes the same order.)
//   - The slot is re-read and the change announced INSIDE the lock. The SDK
//     forbids an unlocked reload, which could install an older slot over a
//     writer's newer one.
// runtime.archiveNote is not used: it takes the wallet lock itself, so wrapping
// it in the host's lock deadlocks, and calling it unwrapped leaves a gap
// between the check and the write.

/**
 * The SDK's wallet store namespace, the default `store` of giveUpBalance. It is
 * the whole namespace and not a hand-picked set of names on purpose: the
 * successor protocol's store also exports listBrowserRequestArchive, which an
 * SDK that has no request archive does not, and a named import of it would not
 * link under that SDK. Reading it from the namespace reaches it exactly when
 * the installed SDK provides it.
 */
export const defaultWalletStore = sdkWalletStore;

const FAILED = Object.freeze({ done: false, why: 'failed' });
const NOT_APPLICABLE = Object.freeze({ done: false, why: 'not_applicable' });
const DISABLED = Object.freeze({ done: false, why: 'disabled' });
const UNKNOWN = Object.freeze({ done: false, why: 'unknown_state' });

function safeQuote(client) {
    try { return client?.nativePriceQuote ?? null; } catch { return null; }
}

// What the SDK client says about the note, read once. A fact that cannot be
// read is an unknown and refuses: a getter that throws is never read as "no
// claim", and the raw request list goes to the verdict, which judges its shape
// (absent means the protocol keeps none; anything that is not a list refuses).
function readClientFacts(client, runtime) {
    try {
        const config = client.config;
        return {
            ok: true,
            claimed: Boolean(client.noteExpiryClaim),
            unresolvedRequests: config?.unresolved_requests,
            chargeCapUnits: config?.request_charge_cap ?? runtime.config?.request_charge_cap,
            quote: safeQuote(client)
        };
    } catch {
        return { ok: false };
    }
}

// The transmitted-request archive of a protocol that keeps one. Only some
// stores export it; an SDK without one binds the name to nothing (undefined or
// absent), which means the protocol has no such archive. Anything else that is
// not a working reader, and an archive that cannot be read or is not a list, is
// an unknown, never an empty one. The records are not filtered here: the
// verdict refuses on any of them (see nonEmptyRequestArchive for why that is
// coarse on purpose).
async function readRequestArchive(store, deploymentId) {
    const reader = store?.listBrowserRequestArchive;
    if (reader === undefined || reader === null) return { archive: null };
    if (typeof reader !== 'function') return { unreadable: true };
    try {
        const archive = await reader.call(store, deploymentId);
        return Array.isArray(archive) ? { archive } : { unreadable: true };
    } catch {
        return { unreadable: true };
    }
}

// Every withdrawal record of the wallet database, whatever deployment it names.
// The runtime's own list is filtered by deployment id with a strict equality, so
// a record that names none never reaches it; this read takes no argument and
// returns them all, and the verdict decides which belong here (one that names no
// deployment counts as this one). A list that cannot be read is an unknown.
async function readEveryWithdrawal(store) {
    try {
        const records = await store.listBrowserWithdrawals();
        return Array.isArray(records) ? { records } : { unreadable: true };
    } catch {
        return { unreadable: true };
    }
}

/**
 * Give up the balance in the runtime slot, if it is still exactly the one the
 * person was shown and is still worth giving up.
 *
 * Never throws. Nothing is written unless the strict verdict passes on a fresh
 * read under the exclusive cross-tab wallet lock.
 *
 * @param {object} options
 * @param {boolean} options.supported  the protocol family has been reviewed for
 *   giving up (adapter data); must be exactly true, otherwise 'not_applicable'
 * @param {boolean} options.enabled    the registry's operator switch as the
 *   caller computed it (`transition.abandonEnabled !== false`); must be exactly
 *   true, otherwise 'disabled'. Omitting it refuses: the registry's own default
 *   (on) is applied by the caller that reads the registry, never here.
 * @param {object} [options.client]   the SDK client singleton (default)
 * @param {object} [options.runtime]  the SDK wallet runtime singleton (default)
 * @param {{archiveBrowserWallet: Function, listBrowserWithdrawals: Function, listBrowserRequestArchive?: Function}} [options.store]
 *   the SDK store module (default: its whole namespace, defaultWalletStore)
 * @param {number} options.expectedNoteId       the note shown to the person
 * @param {string|number} options.expectedBalanceUnits  its balance, gwei
 * @param {string} options.expectedDeploymentId the loaded deployment
 * @param {number} [options.thresholdUsdMicros]       registry data
 * @param {number} [options.smallestTierUsdMicros]    adapter data
 * @param {number} [options.ceilingUnits]             adapter data
 * @param {{request: Function}} [options.locks]  Web Locks (default navigator.locks)
 * @param {() => number} [options.now]   epoch milliseconds
 * @returns {Promise<{done: true, kind: 'zero'|'dust'}
 *   |{done: false, why: string}>} `why` is 'no_locks', 'lock_busy', 'failed'
 *   or one of ABANDON_BLOCKED_BY ('changed' when the note or balance differs
 *   from what was shown).
 */
export async function giveUpBalance(options) {
    try {
        // Total, like everything else here: arguments that are not an object
        // are a caller that passed nothing, which is refused below.
        const {
            client = zkapiClient, runtime = walletRuntime, store = defaultWalletStore,
            expectedNoteId, expectedBalanceUnits, expectedDeploymentId,
            thresholdUsdMicros, smallestTierUsdMicros, ceilingUnits, supported, enabled,
            locks = globalThis.navigator?.locks, now = Date.now
        } = options !== null && typeof options === 'object' ? options : {};
        // The two switches first: a caller that does not pass them is refused
        // before anything is read or started. The operator switch is the one
        // control that can turn the action off for a whole version, so its
        // absence is a refusal like its being false (the display verdict,
        // abandonStatus, already reads it the same way).
        if (supported !== true) return NOT_APPLICABLE;
        if (enabled !== true) return DISABLED;
        if (!client || client.browserMode !== true) return NOT_APPLICABLE;
        // The SDK's own archive is the only way this slot is ever written, and
        // its own list of every withdrawal record is the only read that cannot
        // be narrowed by a deployment id.
        if (typeof store?.archiveBrowserWallet !== 'function' || typeof store.listBrowserWithdrawals !== 'function') {
            return FAILED;
        }
        if (!Number.isSafeInteger(expectedNoteId) || expectedNoteId < 0
            || typeof expectedDeploymentId !== 'string' || !expectedDeploymentId) {
            return UNKNOWN;
        }
        // Without cross-tab locks nothing serializes this write with another
        // tab's chat or withdrawal, and the re-check below could not be trusted.
        if (!locks || typeof locks.request !== 'function') return { done: false, why: 'no_locks' };

        // BEFORE the lock: see the header.
        await runtime.init();
        if (runtime.manifest?.deployment_id !== expectedDeploymentId) return { done: false, why: 'config_mismatch' };

        const outcome = await locks.request(WALLET_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async lock => {
            if (!lock) return { done: false, why: 'lock_busy' };
            // The decision is made on what is there now, never on what was
            // displayed. A reload that finds another deployment's wallet throws
            // and ends in 'failed'.
            await runtime.reload();
            const facts = readClientFacts(client, runtime);
            if (!facts.ok) return UNKNOWN;
            const archived = await readRequestArchive(store, expectedDeploymentId);
            if (archived.unreadable) return UNKNOWN;
            const listed = await readEveryWithdrawal(store);
            if (listed.unreadable) return UNKNOWN;
            const verdict = abandonVerdict({
                supported,
                enabled,
                slot: runtime.runtime,
                // The runtime's own list and the unfiltered one: a record in
                // either refuses.
                withdrawals: Array.isArray(runtime.withdrawals) ? [...runtime.withdrawals, ...listed.records] : null,
                deposits: runtime.deposits,
                activeLease: runtime.activeLease,
                noteId: expectedNoteId,
                balanceUnits: expectedBalanceUnits,
                deploymentId: expectedDeploymentId,
                quote: facts.quote,
                chargeCapUnits: facts.chargeCapUnits,
                thresholdUsdMicros,
                smallestTierUsdMicros,
                ceilingUnits,
                claimed: facts.claimed,
                unresolvedRequests: facts.unresolvedRequests,
                requestArchive: archived.archive,
                nowSeconds: Math.floor(Number(now()) / 1000)
            });
            if (!verdict.ok) return { done: false, why: verdict.blockedBy };

            // One IndexedDB transaction over the slot, the archive and the
            // deposit history, owned by the SDK. The note id is passed so that
            // the SDK compares it again inside that transaction and aborts if
            // the slot holds another note: the last defence against a writer
            // that does not take the wallet lock.
            await store.archiveBrowserWallet('abandoned', expectedNoteId);

            // Still inside the lock: re-read the committed slot and announce it,
            // so this tab's client and every other tab pick up the empty slot.
            try { await runtime.reload(); } catch { /* the archive is committed; readers re-read it */ }
            try { runtime.notify(); } catch { /* optional change notice */ }
            return { done: true, kind: verdict.kind };
        });
        return outcome && typeof outcome === 'object' ? outcome : FAILED;
    } catch {
        // No error text: it can embed wallet state.
        return FAILED;
    }
}
