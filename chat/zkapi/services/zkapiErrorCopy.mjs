// Plain-language copy for zkAPI errors that are expected states, not
// faults. The SDK's wording is accurate but assumes the reader knows what
// an indexer or a vault root is.
import { getActiveVersion, getSelection, getVersionTable } from '../versioning/activeVersion.mjs';
import { formatLocalDateTime, gateCopyKey, serviceCopyKey, versionCopyText } from '../versioning/copy.mjs';
import { readExitRefusal, readServiceRefusal } from '../versioning/exitRefusal.mjs';
import { isVersioningActive, zkapiVersioning } from '../versioning/index.js';

/** The indexer (which reads the vault from Ethereum) has not yet seen the
 *  block a proof must be built against. It catches up on its own; the SDK
 *  has already waited about ten seconds before giving up. */
export const INDEXER_LAG_MESSAGE = 'zkAPI is still reading your latest transaction from Ethereum, so your balance can’t be proven against it yet. Nothing was lost. This usually clears within a minute of the transaction confirming. Wait, then try again.';

export function isIndexerLag(error) {
    return error?.code === 'indexer_root_lag'
        || /indexer is still catching up/i.test(error?.message || error?.shortMessage || '');
}

/** A transport failure after submission does not establish that the deposit
 * failed. Use only SDK submission evidence plus the saved recovery plan; a
 * reverted receipt or a validation failure must keep its actual error. */
export function pendingDepositMessage(error, plan) {
    if (!plan || !['submitted', 'dropped_or_pending', 'awaiting_wallet', 'ambiguous'].includes(plan.phase)
        || error?.transactionReceipt || error?.broadcastPossible === false) return null;
    const receiptWait = /Timed out waiting for transaction/i.test(error?.message || '');
    if (error?.broadcastPossible !== true && !receiptWait) return null;
    return 'Your deposit status is not yet confirmed. Its progress is saved in this browser. Check payment status before trying again.';
}

// ---------------------------------------------------------------------------
// Protocol versions
// ---------------------------------------------------------------------------
// Expected states the SDK words for an engineer: a version that no longer
// takes deposits, another version's unfinished withdrawal, a deployment that
// stopped starting chats, a browser wallet that belongs to another
// deployment, and, from a revision 3 SDK, a paused service and the refusals
// about exiting a balance (too close to expiry, a chat still settling, an
// ownership proof about to expire, an earlier exit that can still land, a
// device that is not the newest), and the failure of a version's SDK to start
// while the wallet holds a balance of that version (its words can name the
// operator's address; the facade knows which errors those are). They are told
// in the words of
// versioning/copy.mjs (no deployment, circuit or vault ids, no operator
// address, no exit RPC the host does not have) and, for the wallet refusal,
// by what the boot-time selection says the situation is.
//
// All of them are rewritten only on a page that has versions to tell apart
// (`isVersioningActive`: more than one row, or a lone row that is not the
// deposit target). A page with one active version, or none, shows the SDK's
// own words exactly as it always has: its sentences would name "version 1" in
// an app that never shows a version number, and a legacy SDK's own
// `incompatible_proof_circuit` (a plain error about a deployment it cannot
// use, with no status and no `exits`) is not a paused service.

const FOREIGN_WALLET = /This browser contains a wallet for (.+?)\.\s+Switch back to that deployment/i;

const hasCode = (error, code) => [error, error?.cause, error?.data, error?.data?.error]
    .some(source => source && typeof source === 'object' && source.code === code);

/** `deposits_closed`: the host's DepositsClosedError or the SDK's own refusal. */
export function isDepositsClosed(error) {
    return Boolean(error) && typeof error === 'object' && error.code === 'deposits_closed';
}

/** A refusal because another version still has a withdrawal in flight. */
export function isPreviousWithdrawalOpen(error) {
    return Boolean(error) && typeof error === 'object'
        && (error.code === 'previous_withdrawal_open' || error.data?.gateCode === 'previous_withdrawal_open');
}

/**
 * The error carries the `deployment_retiring` code (the deployment stopped
 * starting new chats). Reads the code only; chat/zkapi/api.js decides from the
 * HTTP response whether admission closed (isAdmissionClosedResponse).
 */
export function isRetiringErrorCode(error) {
    return Boolean(error) && typeof error === 'object' && hasCode(error, 'deployment_retiring');
}

/** The SDK's "This browser contains a wallet for <deployment>" refusal. */
export function isForeignWalletRefusal(error) {
    return Boolean(error) && typeof error === 'object'
        && FOREIGN_WALLET.test(String(error.message || error.shortMessage || ''));
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readContext(options) {
    const given = isRecord(options) ? options : {};
    const guard = read => { try { return read(); } catch { return null; } };
    return {
        selection: given.selection !== undefined ? given.selection : guard(getSelection),
        table: Array.isArray(given.table) ? given.table : (guard(getVersionTable) || []),
        active: given.active !== undefined ? given.active : guard(getActiveVersion),
        formatter: given.formatter ?? null,
        now: Number.isFinite(given.now) ? given.now : Date.now()
    };
}

// The instant an ownership-proof wait ends, fixed the first time an error is
// read. The SDK gives a delay ("retry_after", seconds), not an instant, and
// the words are rebuilt every time the error is rendered: counted from each
// render's own clock, an error thrown a minute ago would still say "30
// seconds". Keyed by the error object, so a new error counts from its own
// time and nothing is kept past the error.
const proofRetryInstants = new WeakMap();

function proofRetryInstant(error, instant) {
    if (proofRetryInstants.has(error)) return proofRetryInstants.get(error);
    if (instant !== null) proofRetryInstants.set(error, instant);
    return instant;
}

// The words for a refusal about exiting a balance or for a paused service, or
// null when the error is neither. Dates are the person's local date and time.
function exitRefusalMessage(error, context) {
    const service = readServiceRefusal(error);
    if (service) {
        const key = serviceCopyKey(service.code);
        return key ? versionCopyText(key) : null;
    }
    const refusal = readExitRefusal(error, context.now);
    if (!refusal) return null;
    const date = ms => formatLocalDateTime(ms, context.formatter);
    switch (refusal.kind) {
        // The same sentence the send gate says before a chat is attempted.
        case 'near':
            return versionCopyText('near_expiry');
        case 'device':
            return versionCopyText('exit.device');
        case 'settlement':
            return versionCopyText('exit.settlement', { escapeAt: date(refusal.escapeAtMs) });
        case 'proof': {
            const until = proofRetryInstant(error, refusal.untilMs);
            const seconds = until === null ? null : Math.ceil((until - context.now) / 1000);
            return versionCopyText('exit.proofWait', seconds !== null && seconds > 0 ? { retryIn: seconds } : {});
        }
        case 'release':
            return versionCopyText('exit.releasePending');
        case 'locked':
            return versionCopyText('exit.frozen', { until: date(refusal.untilMs) });
        default:
            return null;
    }
}

// The label of the live version that takes deposits, when it is not the one
// this page is on.
function successorLabel(context) {
    const target = context.table.find(row => isRecord(row) && row.status === 'active');
    return target && target.id !== context.active?.id ? target.label || target.id : '';
}

// Another version with unfinished business, by registry order: the first of
// the selection's open or credited versions that is not this page's own.
function previousLabel(context) {
    const { selection, table, active } = context;
    if (!isRecord(selection)) return '';
    const holders = [selection.open, selection.credits].flatMap(source => (isRecord(source)
        ? Object.keys(source).filter(id => Array.isArray(source[id]) && source[id].length > 0) : []));
    const rows = table.filter(row => isRecord(row) && holders.includes(row.id) && row.id !== active?.id)
        .sort((a, b) => (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity));
    return rows[0] ? rows[0].label || rows[0].id : '';
}

// While this page's own balance holds the wallet, the other version can not
// be opened: the words say to withdraw first, and name no button.
function previousWithdrawalText(context) {
    const blocked = isRecord(context.selection) && context.selection.slotOwner != null;
    return versionCopyText('deposits.blocked.previous', { P: previousLabel(context), blocked });
}

function foreignWalletKey(error, context) {
    const { selection, table } = context;
    if (!isRecord(selection) || !isVersioningActive(table)) return { key: null };
    const id = FOREIGN_WALLET.exec(String(error.message || error.shortMessage || ''))?.[1] || '';
    const owner = id ? table.find(row => isRecord(row) && row.deploymentId === id) || null : null;
    // By what the boot-time selection said the situation was.
    if (selection.reason === 'holdings_unreadable') return { key: 'deposits.blocked.unreadable' };
    if (selection.reason === 'retired_deployment' || owner?.status === 'retired') {
        return { key: 'deposits.blocked.retired' };
    }
    if (selection.reason === 'unknown_deployment' || (id && !owner)) return { key: 'deposits.blocked.foreign' };
    // A live version holds the wallet now: it moved after this page loaded.
    return { key: 'reload.otherTab', R: owner && owner.id !== context.active?.id ? owner.label || owner.id : '' };
}

// The words for the error that stopped a version's SDK from starting, when the
// wallet holds a balance of that version: one sentence, no address and no
// SDK text. The facade decides (it knows the balance is held and which errors
// its client reported while it had not started), so a stand-in or an absent
// facade is simply "not that". `options.facade` replaces the page's own, for
// callers that bind their own.
function heldStartMessage(error, options) {
    try {
        const given = isRecord(options) ? options : {};
        const facade = given.facade !== undefined ? given.facade : zkapiVersioning;
        if (!facade || typeof facade.isStartFailure !== 'function') return null;
        return facade.isStartFailure(error) === true ? versionCopyText('held.summary') : null;
    } catch {
        return null;
    }
}

/**
 * Plain text for the protocol-version errors above, or null for any other
 * error and for any page that has no versions to tell apart (the SDK's words
 * stand there). Never throws. `options` ({selection, table, active}) default
 * to the version this page installed at boot, so a caller normally passes
 * nothing; `formatter` (a date formatter, see copy.mjs) and `now` (epoch
 * milliseconds) only matter to the refusals that name a time.
 */
export function versionRefusalMessage(error, options = {}) {
    try {
        if (!error || typeof error !== 'object') return null;
        const retiring = isRetiringErrorCode(error);
        const previousOpen = isPreviousWithdrawalOpen(error);
        const closed = isDepositsClosed(error);
        const foreign = isForeignWalletRefusal(error);
        const exiting = !retiring && !previousOpen && !closed && !foreign
            && (readServiceRefusal(error) !== null || readExitRefusal(error, 0) !== null);
        // Most errors are none of these; they cost nothing more than this,
        // except on a page that holds a balance it could not read, where the
        // error that stopped the SDK is told in plain words.
        if (!retiring && !previousOpen && !closed && !foreign && !exiting) return heldStartMessage(error, options);
        const context = readContext(options);
        // Nothing to tell apart: the SDK's own words stand.
        if (!isVersioningActive(context.table)) return null;
        if (exiting) return exitRefusalMessage(error, context);
        const F = context.active?.label || context.active?.id || '';
        const N = successorLabel(context);
        if (retiring) {
            return versionCopyText('admission.closed', { F, N });
        }
        if (previousOpen) return previousWithdrawalText(context);
        if (closed) {
            const code = error.data?.gateCode;
            const retired = isRecord(context.selection) && context.selection.reason === 'retired_deployment';
            if (typeof code === 'string' && code && code !== 'deposits_closed') {
                const key = gateCopyKey({ canStart: false, code }, { retired });
                if (key === 'deposits.blocked.previous') return previousWithdrawalText(context);
                if (key) return versionCopyText(key, {});
            }
            return versionCopyText('deposits.closed', { F, N });
        }
        if (foreign) {
            const { key, R } = foreignWalletKey(error, context);
            return key ? versionCopyText(key, { R: R || '', F, N }) : null;
        }
    } catch { /* an unreadable context leaves the SDK's own words */ }
    return null;
}

// Which balance an attempt was about, when the caller knows and it was not the
// balance in the wallet slot: `{noteId?, recordId?}` (a set-aside record being
// finished or restored). A refusal carries no balance of its own, so without
// this the facade can only assume the slot balance.
function attemptAbout(options) {
    const about = isRecord(options) && isRecord(options.about) ? options.about : null;
    if (!about) return null;
    const noteId = Number.isSafeInteger(about.noteId) ? about.noteId : null;
    const recordId = typeof about.recordId === 'string' && about.recordId ? about.recordId : null;
    return noteId === null && recordId === null ? null : { noteId, recordId };
}

// Tells the version facade about a refusal before the error is reworded: the
// facade holds what an exit attempt was refused for (a wait, a frozen balance,
// a paused service) so the balance can say it as a notice and not only as a
// toast. Presentation only and best effort: the facade decides what it keeps,
// never throws into the caller's error path, and is not asked on a page that
// has no versions to tell apart.
function noteRefusal(error, options) {
    try {
        const given = isRecord(options) ? options : {};
        const context = readContext(options);
        if (!isVersioningActive(context.table)) return;
        const facade = given.facade !== undefined ? given.facade : zkapiVersioning;
        if (!facade || typeof facade.noteRefusal !== 'function') return;
        // The second argument is only given when the caller named the balance,
        // so the facade's one-argument contract is what every other call sees.
        const about = attemptAbout(options);
        if (about) facade.noteRefusal(error, about);
        else facade.noteRefusal(error);
    } catch { /* the error itself is what the caller handles */ }
}

/** Rewrites a caught error's message in place so every surface — toast,
 *  activity log, panel — says the same clear thing. Returns the error.
 *  `options.about` ({noteId, recordId}) names the balance the attempt was
 *  about when that is not the one in the wallet slot, so the facade does not
 *  attach the refusal to the wrong balance. */
export function explainZkapiError(error, options = {}) {
    if (error && typeof error === 'object' && isIndexerLag(error)) {
        try {
            error.message = INDEXER_LAG_MESSAGE;
            if ('shortMessage' in error) error.shortMessage = INDEXER_LAG_MESSAGE;
            error.code = 'indexer_root_lag';
        } catch { /* frozen error: the message getters below still apply */ }
    } else if (error && typeof error === 'object') {
        noteRefusal(error, options);
        const text = versionRefusalMessage(error, options);
        if (text) {
            try {
                error.message = text;
                if ('shortMessage' in error) error.shortMessage = text;
            } catch { /* frozen error: zkapiErrorMessage applies the same text */ }
        }
    }
    return error;
}

export function zkapiErrorMessage(error, fallback = 'The wallet could not complete this request.') {
    if (isIndexerLag(error)) return INDEXER_LAG_MESSAGE;
    const version = versionRefusalMessage(error);
    if (version) return version;
    return error?.shortMessage || error?.message || fallback;
}
