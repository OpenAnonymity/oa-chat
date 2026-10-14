// Host-owned view of what the shared zkAPI wallet database holds.
//
// Every protocol version's SDK opens ONE IndexedDB per lineage and network
// (docs/ZKAPI_VERSIONING.md), so which SDK build to load has to be decided
// before any SDK module is imported. The SDK's own holdings read cannot be
// used for that: an SDK build is only available after the choice, and the
// newer SDK's read writes a migrated journal record. This module therefore
// reads the database directly and only reads it:
//
//   readWalletHoldings     versionless open that can never create or upgrade
//                          anything, one readonly transaction, bounded.
//   classifyHoldings       pure; a port of the upstream classifier
//                          (browserRuntimeHoldsState, isOpenBrowserWithdrawal,
//                          browserWalletHoldings, isUnclaimedPayoutCredit),
//                          made fail-closed for anything it does not know.
//   describeSlot           what kind of thing pins the runtime slot.
//   openExistingDatabase, createDeadline, requestResult, transactionComplete,
//   getFactory             the read helpers above, exported so the other
//                          reader of this database (otherVersionHistory.mjs)
//                          opens, bounds and closes it by the same rules.
//   discardDepositDraft    the ONE place the host writes the wallet database:
//                          it clears a deposit draft or a never-sent plan
//                          that would otherwise pin a user to a version that
//                          no longer accepts deposits.
//
// No SDK import. Results are memory-only: holdings expose note ids, modes and
// phases that tie this browser to a public note, so callers must never log
// them, put them in a URL or send them anywhere.
import { isUnsentPreparedDeposit } from './unsentDeposit.mjs';

// The SDK's wallet mutation lock and change channel. These literals are the
// store's own (sdk/services/browserWalletStore.js); the build asserts the
// lock and channel literals of every live store equal these.
export const WALLET_LOCK_NAME = 'zkapi-wallet:active-runtime';
export const WALLET_CHANNEL_NAME = 'zkapi-wallet:active-runtime';

const RUNTIME_STORE = 'runtime';
const WITHDRAWAL_STORE = 'withdrawals';
const DEPOSIT_STORE = 'deposits';
const RUNTIME_KEY = 'active';
const DEFAULT_TIMEOUT_MS = 2000;

// Slot bookkeeping that never holds funds or recovery state. Everything else
// in the slot is either a known state field or, being unknown, held.
const METADATA_KEYS = new Set([
    'version', 'deploymentId', 'billingAsset', 'updatedAt', 'stateSeq', 'exitKitExportedSeq'
]);

// Every field either SDK generation keeps in the slot besides metadata.
const STATE_KEYS = new Set([
    'state', 'journal', 'exitLock', 'pendingDeposit', 'depositQuote', 'preparedWithdrawal',
    'lease', 'lateWithdrawalAttempts', 'lateDepositAttempts'
]);

const KNOWN_SLOT_KEYS = new Set([...METADATA_KEYS, ...STATE_KEYS]);

/**
 * The slot field names this module classifies, by role (copies). A field the
 * SDK adds that is in neither list is treated as held state: an empty slot
 * carrying it would read as holding something and pin the person to the
 * version that wrote it, and a discard would refuse it. The drift guard in
 * test/zkapi/zkapi-wallet-holdings.test.mjs compares these lists with the
 * field set of every installed SDK store; run it at every SDK activation.
 * @returns {{metadata: string[], state: string[]}}
 */
export function knownSlotKeys() {
    return { metadata: [...METADATA_KEYS], state: [...STATE_KEYS] };
}

// Late attempts that reached one of these are settled and hold nothing.
const LATE_WITHDRAWAL_TERMINAL_STATUSES = new Set([
    'closed', 'detached', 'reverted', 'challenged', 'superseded', 'quarantined'
]);
const LATE_DEPOSIT_TERMINAL_STATUSES = new Set(['confirmed', 'reverted', 'superseded']);

// What a prepared-but-never-sent plan looks like (both SDK generations build
// it from exactly these fields). A plan carrying anything else that is set
// is not provably unsent, whatever the shared predicate says: the host write
// path only releases plans it fully recognizes.
const UNSENT_PLAN_FIELDS = new Set([
    'operationId', 'createdAt', 'phase', 'amount', 'secret', 'commitment',
    'next_note_id', 'active_root', 'zero_path'
]);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function positiveTimestamp(value) {
    return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
}

function coded(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
}

// A value of a key this module does not know: held when it is a truthy scalar,
// a non-empty array or a non-empty object.
function unknownValueHeld(value) {
    if (!value) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

function lateAttemptsHeld(value, terminalStatuses) {
    if (Array.isArray(value)) return value.some(attempt => !terminalStatuses.has(attempt?.status));
    return unknownValueHeld(value);
}

// The slot keys that hold state, as a Set. Port of upstream
// browserRuntimeHoldsState, key by key: a note, journal, exit lock, pending
// deposit, deposit draft, prepared withdrawal, lease or an unfinished late
// attempt. Unknown keys and malformed late-attempt containers count as held.
function heldKeys(slot) {
    const held = new Set();
    for (const key of Object.keys(slot)) {
        if (METADATA_KEYS.has(key)) continue;
        const value = slot[key];
        if (key === 'lateWithdrawalAttempts') {
            if (lateAttemptsHeld(value, LATE_WITHDRAWAL_TERMINAL_STATUSES)) held.add(key);
        } else if (key === 'lateDepositAttempts') {
            if (lateAttemptsHeld(value, LATE_DEPOSIT_TERMINAL_STATUSES)) held.add(key);
        } else if (STATE_KEYS.has(key)) {
            if (value) held.add(key);
        } else if (unknownValueHeld(value)) {
            held.add(key);
        }
    }
    return held;
}

/**
 * Whether a stored runtime slot holds durable wallet state. Missing slots are
 * empty; a slot that is not even an object is held (nothing is assumed about
 * it).
 */
export function slotHoldsState(slot) {
    if (slot === null || slot === undefined) return false;
    if (!isRecord(slot)) return true;
    return heldKeys(slot).size > 0;
}

/**
 * Whether a withdrawal record can still hold, return or pay out a note: every
 * record except a finalized close (phase 'closed' with no finalization in
 * flight). Port of upstream isOpenBrowserWithdrawal.
 */
export function isOpenWithdrawalRecord(record) {
    if (!record || record.phase !== 'closed') return Boolean(record);
    const hashes = Array.isArray(record.finalizeTransactionHashes)
        ? record.finalizeTransactionHashes
        : record.finalizeTransactionHash ? [record.finalizeTransactionHash] : [];
    return Boolean(record.finalizeSubmissionId || hashes.length);
}

/**
 * Whether a withdrawal record is a closed escape whose payout the vault only
 * credited and this browser has not seen delivered. Port of upstream
 * isUnclaimedPayoutCredit.
 */
export function isUnclaimedPayoutCredit(record) {
    return record?.payoutCredited === true && record.payoutClaimed !== true
        && ['closed_unconfirmed', 'closed'].includes(record.phase);
}

function deploymentIdOf(value) {
    return isRecord(value) && typeof value.deploymentId === 'string' && value.deploymentId
        ? value.deploymentId : null;
}

// The plan is recognized and has nothing else set. Used only for the slot kind
// and the discard; the predicate itself stays the shared one.
function planIsRecognizedAndUnsent(slot) {
    if (!isUnsentPreparedDeposit(slot)) return false;
    for (const key of Object.keys(slot.pendingDeposit)) {
        if (!UNSENT_PLAN_FIELDS.has(key) && unknownValueHeld(slot.pendingDeposit[key])) return false;
    }
    return true;
}

/**
 * What kind of thing is in the runtime slot.
 *   empty            nothing held
 *   draft_only       only a deposit quote draft (never signed, holds no funds)
 *   unsent_prepared  a prepared deposit plan that was never sent (and at most
 *                    a draft beside it)
 *   pending_deposit  a deposit that may have been started
 *   note             an active note
 *   other            anything else, including malformed or unknown content
 * @param {object|null|undefined} slot
 * @returns {'empty'|'draft_only'|'unsent_prepared'|'pending_deposit'|'note'|'other'}
 */
export function describeSlot(slot) {
    if (slot === null || slot === undefined) return 'empty';
    if (!isRecord(slot)) return 'other';
    const held = heldKeys(slot);
    if (!held.size) return 'empty';
    if (held.has('state')) return 'note';
    for (const key of held) {
        if (key !== 'depositQuote' && key !== 'pendingDeposit') return 'other';
    }
    if (held.has('pendingDeposit')) return planIsRecognizedAndUnsent(slot) ? 'unsent_prepared' : 'pending_deposit';
    return 'draft_only';
}

function withdrawalHolding(record, expiryTs) {
    return {
        recordId: typeof record?.recordId === 'string' ? record.recordId : '',
        noteId: record?.noteId == null ? null : Number(record.noteId),
        mode: record?.mode || null,
        phase: record?.phase || null,
        expiryTs
    };
}

function creditHolding(record) {
    return {
        recordId: typeof record.recordId === 'string' ? record.recordId : '',
        noteId: record.noteId == null ? null : Number(record.noteId),
        chainId: record.chainId == null ? null : Number(record.chainId),
        contractAddress: record.contractAddress || null,
        destination: record.destination || null,
        creditedAmount: record.creditedAmount == null ? null : String(record.creditedAmount)
    };
}

/**
 * The deployments this browser still holds funds or unfinished recovery for.
 *
 * @param {{runtime: object|null, withdrawals: object[], deposits?: object[]}} raw
 *   Raw stored values: the slot, the withdrawal records and the (optional)
 *   deposit history rows.
 * @returns {Array<{deploymentId: string|null, runtime: boolean,
 *   withdrawals: Array<{recordId: string, noteId: number|null, mode: string|null,
 *   phase: string|null, expiryTs: number|null}>,
 *   credits: Array<{recordId: string, noteId: number|null, chainId: number|null,
 *   contractAddress: string|null, destination: string|null, creditedAmount: string|null}>}>}
 *   The runtime slot's deployment first (only that one can load while its slot
 *   holds state), then by deployment id. `withdrawals` are the open records;
 *   `credits` the unclaimed payout credits. A deployment can appear for
 *   credits alone: a final close holds no note, but its payout still waits.
 */
export function classifyHoldings(raw) {
    if (!isRecord(raw) || !Array.isArray(raw.withdrawals)) {
        throw coded('holdings_unreadable', 'Wallet holdings need a slot and a list of withdrawal records.');
    }
    const deposits = Array.isArray(raw.deposits) ? raw.deposits : [];
    const expiryByNote = new Map();
    for (const row of deposits) {
        const deploymentId = deploymentIdOf(row);
        if (!deploymentId || row.noteId == null || !Number.isSafeInteger(Number(row.noteId))) continue;
        const expiryTs = positiveTimestamp(row.expiryTs);
        const key = `${deploymentId}\u0000${Number(row.noteId)}`;
        if (expiryTs !== null && !expiryByNote.has(key)) expiryByNote.set(key, expiryTs);
    }

    const entries = new Map();
    const entry = deploymentId => {
        if (!entries.has(deploymentId)) {
            entries.set(deploymentId, { deploymentId, runtime: false, withdrawals: [], credits: [] });
        }
        return entries.get(deploymentId);
    };
    if (slotHoldsState(raw.runtime)) entry(deploymentIdOf(raw.runtime)).runtime = true;

    // Newest first, as the SDK's own snapshot orders them.
    const records = raw.withdrawals.filter(Boolean)
        .sort((left, right) => Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0));
    for (const record of records) {
        const deploymentId = deploymentIdOf(record);
        if (isOpenWithdrawalRecord(record)) {
            const noteId = record.noteId == null ? null : Number(record.noteId);
            const recorded = deploymentId && noteId !== null ? expiryByNote.get(`${deploymentId}\u0000${noteId}`) : undefined;
            // The deposit history row is the public source; the record's own
            // note state is the fallback. Only the expiry leaves this function.
            const expiryTs = recorded !== undefined ? recorded : positiveTimestamp(record?.state?.expiry_ts);
            entry(deploymentId).withdrawals.push(withdrawalHolding(record, expiryTs));
        }
        if (isRecord(record) && isUnclaimedPayoutCredit(record)) {
            entry(deploymentId).credits.push(creditHolding(record));
        }
    }

    return [...entries.values()].sort((left, right) => Number(right.runtime) - Number(left.runtime)
        || String(left.deploymentId).localeCompare(String(right.deploymentId)));
}

export function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || coded('holdings_unreadable', 'IndexedDB request failed.'));
    });
}

export function transactionComplete(transaction) {
    const done = new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || coded('holdings_unreadable', 'IndexedDB transaction aborted.'));
        transaction.onerror = () => reject(transaction.error || coded('holdings_unreadable', 'IndexedDB transaction failed.'));
    });
    // A caller that stops waiting (deadline, validation failure) must not
    // leave an unhandled rejection behind.
    done.catch(() => {});
    return done;
}

function resolveTimeout(timeoutMs) {
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

// One deadline for a whole operation. `promise` rejects when it passes.
export function createDeadline(timeoutMs) {
    let timer = null;
    const promise = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            reject(coded('holdings_timeout', 'Reading the saved wallet timed out.'));
        }, resolveTimeout(timeoutMs));
    });
    promise.catch(() => {});
    return { promise, cancel() { clearTimeout(timer); } };
}

// Open `name` WITHOUT a version. A versionless open never requests an upgrade
// of an existing database; if the database does not exist the browser would
// create it at version 1 and fire upgradeneeded, which is aborted here so
// nothing is created and the answer is "no wallet" (null).
// `lifecycle.abandoned` lets the caller disown a connection that arrives after
// the deadline: it is then closed instead of leaked.
export function openExistingDatabase(factory, name, lifecycle) {
    return new Promise((resolve, reject) => {
        let request;
        let aborted = false;
        try {
            request = factory.open(name);
        } catch (error) {
            reject(coded('holdings_unreadable', 'The saved wallet could not be opened.', error));
            return;
        }
        request.onupgradeneeded = () => {
            aborted = true;
            try { request.transaction.abort(); } catch { /* the open fails below either way */ }
        };
        request.onsuccess = () => {
            const database = request.result;
            if (aborted || lifecycle.abandoned) {
                try { database.close(); } catch { /* already closed */ }
                resolve(null);
                return;
            }
            // A newer build upgrading the database must never wait for this
            // short-lived connection.
            database.onversionchange = () => {
                try { database.close(); } catch { /* already closed */ }
            };
            resolve(database);
        };
        request.onerror = event => {
            if (aborted) {
                try { event?.preventDefault?.(); } catch { /* optional */ }
                resolve(null);
                return;
            }
            reject(coded('holdings_unreadable', 'The saved wallet could not be opened.', request.error));
        };
        request.onblocked = () => {
            reject(coded('holdings_unreadable', 'The saved wallet is blocked by another tab.'));
        };
    });
}

export function getFactory(option) {
    const factory = option || globalThis.indexedDB;
    if (!factory || typeof factory.open !== 'function') {
        throw coded('holdings_unreadable', 'IndexedDB is not available.');
    }
    return factory;
}

/**
 * Read the shared wallet database, read-only.
 *
 * Never creates the database or a store, never changes a version, never
 * writes, closes its connection before returning and gives up after
 * `timeoutMs`. Missing stores read as empty.
 *
 * @param {{database: string, indexedDB?: IDBFactory, timeoutMs?: number}} options
 * @returns {Promise<{holdings: ReturnType<typeof classifyHoldings>,
 *   slot: {deploymentId: string|null, kind: ReturnType<typeof describeSlot>}}>}
 *   Rejects (code `holdings_unreadable` or `holdings_timeout`) when the
 *   database cannot be read; callers must then treat holdings as unknown.
 */
export async function readWalletHoldings({ database, indexedDB: factoryOption, timeoutMs } = {}) {
    if (typeof database !== 'string' || !database) {
        throw coded('holdings_unreadable', 'A wallet database name is required.');
    }
    const factory = getFactory(factoryOption);
    const deadline = createDeadline(timeoutMs);
    const lifecycle = { abandoned: false };
    let connection = null;
    try {
        connection = await Promise.race([openExistingDatabase(factory, database, lifecycle), deadline.promise]);
        if (!connection) return { holdings: [], slot: { deploymentId: null, kind: 'empty' } };
        const present = [RUNTIME_STORE, WITHDRAWAL_STORE, DEPOSIT_STORE]
            .filter(name => connection.objectStoreNames.contains(name));
        if (!present.length) return { holdings: [], slot: { deploymentId: null, kind: 'empty' } };
        const raw = await Promise.race([readStores(connection, present), deadline.promise]);
        const holdings = classifyHoldings(raw);
        return { holdings, slot: { deploymentId: deploymentIdOf(raw.runtime), kind: describeSlot(raw.runtime) } };
    } catch (error) {
        if (error?.code === 'holdings_unreadable' || error?.code === 'holdings_timeout') throw error;
        throw coded('holdings_unreadable', 'The saved wallet could not be read.', error);
    } finally {
        deadline.cancel();
        lifecycle.abandoned = true;
        if (connection) {
            try { connection.close(); } catch { /* already closed */ }
        }
    }
}

async function readStores(connection, present) {
    const transaction = connection.transaction(present, 'readonly');
    const complete = transactionComplete(transaction);
    const has = name => present.includes(name);
    const [runtime, withdrawals, deposits] = await Promise.all([
        has(RUNTIME_STORE) ? requestResult(transaction.objectStore(RUNTIME_STORE).get(RUNTIME_KEY)) : undefined,
        has(WITHDRAWAL_STORE) ? requestResult(transaction.objectStore(WITHDRAWAL_STORE).getAll()) : [],
        has(DEPOSIT_STORE) ? requestResult(transaction.objectStore(DEPOSIT_STORE).getAll()) : []
    ]);
    await complete;
    if (!Array.isArray(withdrawals) || !Array.isArray(deposits)) {
        throw coded('holdings_unreadable', 'The saved wallet returned unexpected records.');
    }
    return { runtime: runtime ?? null, withdrawals, deposits };
}

// Re-verified under the lock, inside the write transaction. Returns the kind
// that may be discarded or null.
function discardableKind(slot, expectedDeploymentId) {
    if (!isRecord(slot) || slot.version !== 1) return null;
    if (typeof slot.deploymentId !== 'string' || !slot.deploymentId) return null;
    if (expectedDeploymentId !== undefined && slot.deploymentId !== expectedDeploymentId) return null;
    // Only a slot made of fields both SDK generations are known to write.
    for (const key of Object.keys(slot)) {
        if (!KNOWN_SLOT_KEYS.has(key)) return null;
    }
    const kind = describeSlot(slot);
    return kind === 'draft_only' || kind === 'unsent_prepared' ? kind : null;
}

function postWalletChange(channelOption, updatedAt) {
    let channel = channelOption || null;
    let owned = false;
    try {
        if (!channel) {
            if (typeof globalThis.BroadcastChannel !== 'function') return;
            channel = new globalThis.BroadcastChannel(WALLET_CHANNEL_NAME);
            owned = true;
        }
        channel.postMessage({ updatedAt });
    } catch { /* Other tabs re-read on focus; the write itself is committed. */ } finally {
        if (owned) {
            try { channel.close(); } catch { /* already closed */ }
        }
    }
}

async function commitDiscard(connection, { expectedDeploymentId, now, deadline }) {
    let transaction;
    try {
        transaction = connection.transaction([RUNTIME_STORE], 'readwrite', { durability: 'strict' });
    } catch {
        transaction = connection.transaction([RUNTIME_STORE], 'readwrite');
    }
    const complete = transactionComplete(transaction);
    const abort = () => {
        try { transaction.abort(); } catch { /* already finished */ }
    };
    try {
        const work = (async () => {
            const store = transaction.objectStore(RUNTIME_STORE);
            const slot = await requestResult(store.get(RUNTIME_KEY));
            const kind = discardableKind(slot, expectedDeploymentId);
            if (!kind) {
                abort();
                return { discarded: false, why: 'not_discardable' };
            }
            const previous = Number(slot.updatedAt);
            const updatedAt = Math.max(now(), Number.isFinite(previous) ? previous + 1 : 0);
            // Every other field, including its position, is carried over as
            // read. Only the two fields below and the change stamp differ.
            const next = { ...slot, updatedAt };
            if (hasOwn(next, 'depositQuote')) next.depositQuote = null;
            if (kind === 'unsent_prepared') next.pendingDeposit = null;
            store.put(next, RUNTIME_KEY);
            await complete;
            return { discarded: true, updatedAt };
        })();
        return await Promise.race([work, deadline.promise]);
    } catch (error) {
        abort();
        throw error;
    }
}

/**
 * Clear a deposit draft or a never-sent deposit plan that pins the runtime
 * slot, under the SDK's wallet lock.
 *
 * This is the single documented exception to "the host never writes the
 * wallet slot". It exists because a version that no longer accepts deposits
 * cannot discard its own unused draft, and a draft counts as wallet state: it
 * would pin the user to that version forever. A draft or an unsent plan holds
 * no funds and no chain footprint; anything else is refused.
 *
 * Safety argument: the SDK commits a deposit's submission claim under this
 * same lock before it ever opens a wallet prompt, so a plan that is claimed,
 * sent or ambiguous is visible here as such and is never touched. The
 * decision is made from a fresh read inside the write transaction, never from
 * an earlier probe.
 *
 * Fails closed: no Web Locks, a busy lock, an unreadable database or any
 * precondition that does not hold means no write.
 *
 * @param {{database: string, indexedDB?: IDBFactory, locks?: LockManager,
 *   channel?: {postMessage: Function}|null, timeoutMs?: number,
 *   expectedDeploymentId?: string, now?: () => number}} options
 *   `expectedDeploymentId`, when given, must equal the slot's owner.
 * @returns {Promise<{discarded: boolean,
 *   why?: 'not_discardable'|'no_locks'|'lock_busy'|'unreadable'}>} Never rejects.
 */
export async function discardDepositDraft({
    database, indexedDB: factoryOption, locks, channel = null, timeoutMs, expectedDeploymentId,
    now = Date.now
} = {}) {
    const lockManager = locks || globalThis.navigator?.locks;
    if (!lockManager || typeof lockManager.request !== 'function') return { discarded: false, why: 'no_locks' };
    if (typeof database !== 'string' || !database) return { discarded: false, why: 'unreadable' };
    const deadline = createDeadline(timeoutMs);
    const lifecycle = { abandoned: false };
    let connection = null;
    try {
        const factory = getFactory(factoryOption);
        connection = await Promise.race([openExistingDatabase(factory, database, lifecycle), deadline.promise]);
        if (!connection || !connection.objectStoreNames.contains(RUNTIME_STORE)) {
            return { discarded: false, why: 'not_discardable' };
        }
        const outcome = await lockManager.request(WALLET_LOCK_NAME, { mode: 'exclusive', ifAvailable: true },
            async lock => {
                if (!lock) return { discarded: false, why: 'lock_busy' };
                return commitDiscard(connection, { expectedDeploymentId, now, deadline });
            });
        if (outcome?.discarded === true) {
            // After the commit: other tabs re-read the slot under the lock.
            postWalletChange(channel, outcome.updatedAt);
            return { discarded: true };
        }
        return { discarded: false, why: outcome?.why || 'not_discardable' };
    } catch {
        return { discarded: false, why: 'unreadable' };
    } finally {
        deadline.cancel();
        lifecycle.abandoned = true;
        if (connection) {
            try { connection.close(); } catch { /* already closed */ }
        }
    }
}
