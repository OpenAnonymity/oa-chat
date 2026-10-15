// Giving up a zero or dust balance on a version that no longer accepts deposits.
//
// The loader gives the owner of the runtime slot priority, and the SDK keeps
// one note per browser. A holder of a few cents on an exit-only version is
// therefore pinned to it: the only ways out today are an Ethereum withdrawal
// (a network fee that can exceed the balance) or waiting for the note to
// expire and be swept. This module is the decision half of the "Give up this
// balance" action: when a balance is worth giving up, and when the saved
// wallet is in a shape that makes archiving it safe. The write itself is
// services/abandonedNote.mjs.
//
// Pure module, same constraints as the other files in this directory: no SDK
// import, no DOM, no storage, no clock (a caller that has one passes it in).
//
// Two verdicts, deliberately different in strength:
//
//   abandonStatus   what the page can show from its normalized snapshot. It
//                   takes every fact the strict verdict would refuse on, so
//                   `available` means that only a change since the page last
//                   looked (a price move, a chat key issued, another tab's
//                   write) can still refuse at click time.
//   abandonVerdict  evaluated by the service inside the cross-tab wallet lock,
//                   on the raw slot it has just re-read. The only one that
//                   authorizes a write.
//
// Both are total (always an object, never a throw) and fail closed: the
// protocol family must be named as reviewed for this (`supported === true`),
// the operator's switch must be stated as on (`enabled === true`; a caller that
// does not pass it is refused, so a dropped switch is never read as "on"), and
// a fact that is absent, of an unknown shape or unreadable is a refusal, never
// "none".
//
// Money rules (amounts are gwei, the vault's private ledger unit):
//
//   zero   the balance is 0. Nothing is forfeited; no price is needed.
//   dust   0 < balance < limit, with
//            limit = min(ceiling, max(chargeCap, threshold at the quoted price))
//          Below max(chargeCap, the smallest chat key) the SDK itself refuses
//          to issue a chat key, so the balance cannot pay for a single chat.
//          The ceiling is an absolute amount that does not depend on the
//          quote: a feed answer is only bounded to (0, 1e18], so a depressed
//          quote would otherwise turn a multi-ETH note into "dust".
//   a missing, malformed, expired or future-dated quote is never used. Without
//   a usable quote only the quote-free part of the rule applies, and a balance
//   at or above the charge cap is "price_unknown" rather than guessed.

import { isOpenWithdrawalRecord, knownSlotKeys, slotHoldsState } from './walletHoldings.mjs';

/** The smallest chat key (USD micros): what the SDK itself refuses below. */
export const DEFAULT_SMALLEST_TIER_USD_MICROS = 1_000_000;
/** Default dust threshold (USD micros): the smallest chat key. */
export const DEFAULT_DUST_THRESHOLD_USD_MICROS = 1_000_000;
/** Default absolute dust ceiling in gwei: 0.005 ETH, whatever the quote says. */
export const DEFAULT_DUST_CEILING_UNITS = 5_000_000;

export const ABANDON_BLOCKED_BY = Object.freeze([
    'not_applicable', 'disabled', 'no_note', 'changed', 'claimed', 'in_flight', 'open_withdrawal',
    'pending_deposit', 'exit_lock', 'unresolved_request', 'unknown_state', 'reload_required',
    'config_mismatch', 'not_dust', 'price_unknown'
]);

const UNITS_PER_ETH = 1_000_000_000n;
const MICROS_PER_USD = 1_000_000n;
// The ledger's safe range: the SDK refuses any amount above it.
const MAX_LEDGER_UNITS = BigInt(Number.MAX_SAFE_INTEGER);
// A feed answer is bounded by the SDK to (0, 1e18].
const MAX_QUOTE_ANSWER = 10n ** 18n;
const MAX_QUOTE_DECIMALS = 36;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// A non-negative integer in the ledger's range, given as a number, a bigint or
// a canonical decimal string. Anything else (fractions, signs, "1e3", empty
// text, booleans) is not an amount the host acts on.
function parseUnits(value) {
    let amount;
    if (typeof value === 'bigint') amount = value;
    else if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) return null;
        amount = BigInt(value);
    } else if (typeof value === 'string' && DECIMAL.test(value) && value.length <= 20) {
        amount = BigInt(value);
    } else return null;
    return amount >= 0n && amount <= MAX_LEDGER_UNITS ? amount : null;
}

// A non-negative micro-USD integer (a threshold or tier), without a ledger bound.
function parseMicros(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    if (typeof value === 'bigint') return value >= 0n ? value : null;
    return null;
}

// The usable part of an ETH/USD quote, or null. Same shape rules as the SDK's
// quote validation (asset, unit scale, answer range, ordered timestamps); when
// `nowSeconds` is given the quote must also be current at that instant. A
// caller that read the quote through the SDK client's getter already has a
// current one; the explicit instant is for the lock-time recheck.
function readQuote(quote, nowSeconds = null) {
    if (!isRecord(quote) || quote.asset !== 'native_eth' || quote.units_per_eth !== Number(UNITS_PER_ETH)) return null;
    const text = typeof quote.answer === 'number' || typeof quote.answer === 'string' ? String(quote.answer) : '';
    if (!DECIMAL.test(text)) return null;
    const answer = BigInt(text);
    if (answer <= 0n || answer > MAX_QUOTE_ANSWER) return null;
    const { decimals, updated_at: updatedAt, expires_at: expiresAt } = quote;
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAX_QUOTE_DECIMALS) return null;
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0
        || !Number.isSafeInteger(expiresAt) || expiresAt <= updatedAt) return null;
    if (nowSeconds !== null) {
        if (!Number.isSafeInteger(nowSeconds) || updatedAt > nowSeconds || expiresAt <= nowSeconds) return null;
    }
    return { answer, decimals };
}

/**
 * Gwei needed to be worth `usdMicros` at `quote`, rounded up: the SDK's
 * nativeUnitsForUsd (zkapiNativeEth.mjs) on an integer micro-USD input.
 * Null where the SDK throws (a non-positive amount, a result above the ledger
 * range) and for a quote it would not accept.
 * @returns {bigint|null}
 */
export function nativeUnitsForUsdMicros(usdMicros, quote, nowSeconds = null) {
    const micros = parseMicros(usdMicros);
    const read = readQuote(quote, nowSeconds);
    if (micros === null || micros <= 0n || !read) return null;
    const numerator = micros * UNITS_PER_ETH * 10n ** BigInt(read.decimals);
    const denominator = read.answer * MICROS_PER_USD;
    const amount = (numerator + denominator - 1n) / denominator;
    return amount > 0n && amount <= MAX_LEDGER_UNITS ? amount : null;
}

/**
 * The USD value, in micro-USD rounded down, of `units` gwei at `quote`: the
 * SDK's nativeUsdMicros. Null for an amount outside the ledger range, a quote
 * the SDK would not accept, or a result that is not a safe integer.
 * @returns {number|null}
 */
export function nativeUsdMicros(units, quote, nowSeconds = null) {
    const amount = parseUnits(units);
    const read = readQuote(quote, nowSeconds);
    if (amount === null || !read) return null;
    const micros = amount * read.answer * MICROS_PER_USD / (UNITS_PER_ETH * 10n ** BigInt(read.decimals));
    return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

/**
 * "$0.42": whole cents, rounded down so a value is never shown larger than it
 * is (a balance just under a dollar must not read as "$1.00"). A positive value
 * under one cent reads "less than $0.01". Empty text for anything that is not
 * a non-negative amount.
 */
export function formatUsdMicros(micros) {
    const value = parseMicros(typeof micros === 'string' && DECIMAL.test(micros) ? BigInt(micros) : micros);
    if (value === null) return '';
    if (value > 0n && value < 10_000n) return 'less than $0.01';
    const cents = value / 10_000n;
    const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `$${dollars}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/**
 * Gwei as an ETH figure without the unit word: 420000 reads "0.00042".
 * Exact (no rounding), trailing zeros trimmed; empty text for an amount that
 * is not a non-negative integer.
 */
export function formatEthUnits(units) {
    const amount = parseUnits(units);
    if (amount === null) return '';
    const whole = (amount / UNITS_PER_ETH).toString();
    const fraction = (amount % UNITS_PER_ETH).toString().padStart(9, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}

// A parameter that is absent takes its default; one that is present and
// malformed turns the dust leg off (fail closed) instead of falling back.
function parameter(value, fallback) {
    if (value === undefined || value === null) return fallback;
    return parseMicros(value);
}

/**
 * Is a balance worth giving up?
 *
 * @param {object} input
 * @param {number|string|bigint} input.balanceUnits  the note's balance, gwei
 * @param {number|string|bigint} [input.chargeCapUnits]  the deployment's request
 *   charge cap, gwei; missing means only an exactly empty balance qualifies
 * @param {object|null} [input.quote]  the client's ETH/USD quote
 * @param {number|bigint} [input.thresholdUsdMicros]  default one dollar; 0 turns
 *   the dust leg off; above the smallest chat key it is lowered to it
 * @param {number|bigint} [input.smallestTierUsdMicros]  the smallest chat key
 * @param {number|bigint} [input.ceilingUnits]  absolute dust bound, gwei
 * @param {number} [input.nowSeconds]  when given, a quote must be current then
 * @returns {{kind: 'zero'|'dust'|'above'|'price_unknown'|'unknown', limitUnits: string|null}}
 *   `limitUnits` is the bound a dust verdict was measured against (also given
 *   for 'above', so a person can be told what the line was); null for zero,
 *   price_unknown and unknown.
 */
export function classifyBalance(input) {
    const {
        balanceUnits, chargeCapUnits, quote, thresholdUsdMicros, smallestTierUsdMicros, ceilingUnits, nowSeconds = null
    } = isRecord(input) ? input : {};
    const balance = parseUnits(balanceUnits);
    if (balance === null) return { kind: 'unknown', limitUnits: null };
    if (balance === 0n) return { kind: 'zero', limitUnits: null };

    const tier = parameter(smallestTierUsdMicros, BigInt(DEFAULT_SMALLEST_TIER_USD_MICROS));
    let threshold = parameter(thresholdUsdMicros, BigInt(DEFAULT_DUST_THRESHOLD_USD_MICROS));
    const ceiling = parameter(ceilingUnits, BigInt(DEFAULT_DUST_CEILING_UNITS));
    const cap = parseUnits(chargeCapUnits);
    // No dust leg: a malformed parameter, a zero threshold or ceiling, or no
    // known charge cap. Only the exactly empty balance was eligible.
    if (threshold === null || ceiling === null || tier === null || threshold === 0n || ceiling === 0n
        || cap === null || cap === 0n) {
        return { kind: 'above', limitUnits: null };
    }
    if (threshold > tier) threshold = tier;

    const usable = readQuote(quote, nowSeconds);
    const atThreshold = usable ? nativeUnitsForUsdMicros(threshold, quote, nowSeconds) : null;
    let limit = atThreshold !== null && atThreshold > cap ? atThreshold : cap;
    if (limit > ceiling) limit = ceiling;
    if (balance < limit) return { kind: 'dust', limitUnits: limit.toString() };
    // Without a price the smallest chat key cannot be valued: the balance may
    // or may not pay for one. Say so instead of guessing either way.
    if (atThreshold === null && balance >= cap) return { kind: 'price_unknown', limitUnits: null };
    return { kind: 'above', limitUnits: limit.toString() };
}

/**
 * The display verdict. Every fact comes from the page's own normalized view of
 * the wallet; none of it is re-read here, so a `true` only means "show the
 * action". The service decides again inside the lock (abandonVerdict).
 *
 * Refusals are checked in a fixed order; the first one is `blockedBy`. It
 * always returns an object and never throws: input that is not a record is
 * "not applicable".
 *
 * @param {object} input
 * @param {string} input.status           the loaded version's registry status
 * @param {boolean} input.supported       the protocol family has been reviewed
 *   for giving up; must be exactly true
 * @param {boolean} input.enabled         the registry row does not switch it
 *   off; the display wants this stated, so only exactly true counts
 * @param {boolean} input.hasTarget       a version that accepts deposits exists
 * @param {boolean} input.hasNote         the slot holds a note
 * @param {boolean} [input.reloadRequired]  the page is stale (a fresh load would
 *   pick another version)
 * @param {boolean} [input.configMismatch]  the integrity or identity latch fired
 * @param {boolean} input.inFlight        a chat key or request is unsettled
 * @param {boolean} input.claimed         the treasury already claimed the note
 * @param {boolean} input.hasOpenWithdrawal
 * @param {boolean} input.hasPreparedWithdrawal
 * @param {boolean} input.hasPendingDeposit
 * @param {boolean} input.hasUnsentPrepared
 * @param {boolean} input.lockHeld        an exit decision is in force
 * @param {number} input.setAsideCount    set-aside records of this version
 * @param {number} input.unresolvedRequests
 * @returns {{available: boolean, kind: 'zero'|'dust'|null, blockedBy: string|null}}
 */
export function abandonStatus(input) {
    const refuse = blockedBy => ({ available: false, kind: null, blockedBy });
    // Always an object, whatever it is given: a caller that passes nothing, or
    // something that is not a record, gets "not applicable" and nothing else.
    if (!isRecord(input)) return refuse('not_applicable');
    try {
        return statusOf(input, refuse);
    } catch {
        // A hostile getter or an exotic value. Never a throw, never available.
        return refuse('unknown_state');
    }
}

function statusOf(input, refuse) {
    // Display-only facts must be explicitly true: an input that was never
    // computed does not enable anything.
    if (input.status !== 'exit-only' || input.hasTarget !== true || input.supported !== true) {
        return refuse('not_applicable');
    }
    if (input.enabled !== true) return refuse('disabled');
    if (input.configMismatch === true) return refuse('config_mismatch');
    if (input.reloadRequired === true) return refuse('reload_required');
    if (input.hasNote !== true) return refuse('no_note');
    if (input.claimed === true) return refuse('claimed');
    if (input.inFlight === true) return refuse('in_flight');
    const setAside = Number(input.setAsideCount ?? 0);
    if (input.hasOpenWithdrawal === true || input.hasPreparedWithdrawal === true
        || !Number.isFinite(setAside) || setAside > 0) return refuse('open_withdrawal');
    if (input.hasPendingDeposit === true || input.hasUnsentPrepared === true) return refuse('pending_deposit');
    if (input.lockHeld === true) return refuse('exit_lock');
    const unresolved = Number(input.unresolvedRequests ?? 0);
    if (!Number.isFinite(unresolved) || unresolved > 0) return refuse('unresolved_request');

    const verdict = classifyBalance(input);
    if (verdict.kind === 'zero' || verdict.kind === 'dust') {
        return { available: true, kind: verdict.kind, blockedBy: null };
    }
    if (verdict.kind === 'price_unknown') return refuse('price_unknown');
    if (verdict.kind === 'above') return refuse('not_dust');
    return refuse('unknown_state');
}

/**
 * Whether the stored slot holds a note and nothing else: the one shape that
 * archiving the note cannot lose anything from. Metadata keys are ignored; a
 * late attempt that already reached a terminal status holds nothing (the
 * archive keeps those); every other key must be a field the host knows, and
 * empty. A field this build has never heard of refuses, so a newer SDK that
 * adds recovery state cannot be archived over by an older host.
 */
export function isBareNote(slot) {
    if (!isRecord(slot) || !isRecord(slot.state)) return false;
    const { metadata, state } = knownSlotKeys();
    const known = new Set([...metadata, ...state]);
    for (const key of Object.keys(slot)) {
        if (!known.has(key)) return false;
    }
    const { state: _note, ...rest } = slot;
    return !slotHoldsState(rest);
}

function slotRefusal(slot) {
    const held = key => hasOwn(slot, key) && slotHoldsState({ [key]: slot[key] });
    // The journal and the lease belong to an unsettled chat key: settlement
    // installs the next note state and changes the balance.
    if (held('journal') || held('lease')) return 'in_flight';
    // A prepared or escape plan, or an unfinished late attempt, belongs to a
    // withdrawal that may already be on-chain; the archive would drop the plan.
    if (held('preparedWithdrawal') || held('lateWithdrawalAttempts')) return 'open_withdrawal';
    if (held('pendingDeposit') || held('depositQuote') || held('lateDepositAttempts')) return 'pending_deposit';
    // An exit decision freezes the note; the archive does not carry it over.
    if (held('exitLock')) return 'exit_lock';
    if (!isBareNote(slot)) return 'unknown_state';
    return null;
}

// Whether a count or list of unresolved requests is anything but "none".
// Only an absent value (undefined: the protocol keeps no such list), zero and
// an empty list are none. `null`, a negative or fractional number and every
// other shape are not a count of nothing.
function nonEmptyUnresolved(value) {
    if (value === undefined) return false;
    if (typeof value === 'number') return value !== 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
}

// The transmitted-request archive of a protocol that keeps one. Absent
// (undefined, or null for "this protocol has none") is none; a list is judged by
// whether it is empty; anything else is unknown and refuses.
//
// The rule is deliberately coarse: any record of the deployment refuses,
// whatever its disposition and whichever note it belongs to. A family that
// keeps such an archive also keeps terminal records in it (requests that were
// installed or superseded, proofs of earlier notes), so a person who ever chatted
// on it would be refused. That is the safe way to fail: such a family is not
// `supported`, so this branch is unreachable for it today. When one is reviewed
// for giving up, this rule is replaced by that family's own (the records of THIS
// note that are still unresolved, judged by the family's disposition names), and
// not loosened here by guessing at them.
function nonEmptyRequestArchive(value) {
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
}

// A record belongs to another deployment only when it says so with a different,
// non-empty deployment id. A record that names none, or names something that is
// not an id, is treated as this deployment's: the check fails closed.
function ofAnotherDeployment(record, deploymentId) {
    return isRecord(record) && typeof record.deploymentId === 'string' && record.deploymentId !== ''
        && record.deploymentId !== deploymentId;
}

/**
 * The strict verdict, for the fresh slot read inside the wallet lock. Returns
 * `{ok: true, kind}` only when every condition holds; anything unexpected is a
 * refusal (`blockedBy`, one of ABANDON_BLOCKED_BY). It never throws.
 *
 * Fail closed on the two page switches as well: the protocol family must be
 * named as reviewed for this (`supported === true`) and the operator's switch
 * must be stated as on (`enabled === true`). The registry's default (on) is
 * applied by the caller that reads the registry; a caller that omits the
 * switch is refused as `disabled`, so it cannot enable the action for a
 * version whose operator switched it off. A caller that passes neither gets
 * `not_applicable`.
 *
 * @param {object} input
 * @param {boolean} input.supported          the protocol family opted in; must be exactly true
 * @param {boolean} input.enabled            the registry switch as computed by the
 *   caller; must be exactly true
 * @param {object|null} input.slot           the runtime slot as just re-read
 * @param {object[]} input.withdrawals       every withdrawal record of the
 *   wallet database (the service reads them unfiltered); a record that names no
 *   deployment counts as this one
 * @param {object[]} [input.deposits]        this deployment's deposit history
 * @param {object|null} [input.activeLease]  the tab's in-memory chat key
 * @param {number} input.noteId              the note the person was shown
 * @param {string|number} input.balanceUnits the balance the person was shown
 * @param {string} input.deploymentId        the loaded deployment
 * @param {object|null} [input.quote]
 * @param {number|string} [input.chargeCapUnits]
 * @param {number} [input.thresholdUsdMicros]
 * @param {number} [input.smallestTierUsdMicros]
 * @param {number} [input.ceilingUnits]
 * @param {boolean} [input.claimed]          the client reports a claim; only
 *   an absent value or exactly false means "no"
 * @param {number|object[]} [input.unresolvedRequests]  absent (undefined) means none
 * @param {object[]|null} [input.requestArchive]        absent (undefined or null) means none
 * @param {number} [input.nowSeconds]        instant a quote must be current at
 * @returns {{ok: true, kind: 'zero'|'dust'}|{ok: false, blockedBy: string}}
 */
export function abandonVerdict(input) {
    const refuse = blockedBy => ({ ok: false, blockedBy });
    if (!isRecord(input)) return refuse('not_applicable');
    try {
        return verdictOf(input, refuse);
    } catch {
        // A hostile getter or an exotic value: no decision is no permission.
        return refuse('unknown_state');
    }
}

function verdictOf(input, refuse) {
    const { slot } = input;
    if (input.supported !== true) return refuse('not_applicable');
    if (input.enabled !== true) return refuse('disabled');
    if (slot === null || slot === undefined) return refuse('no_note');
    if (!isRecord(slot)) return refuse('unknown_state');
    if (slot.state === null || slot.state === undefined) return refuse('no_note');
    if (!isRecord(slot.state)) return refuse('unknown_state');

    if (typeof input.deploymentId !== 'string' || !input.deploymentId
        || slot.deploymentId !== input.deploymentId) return refuse('config_mismatch');

    const { note_id: slotNoteId, current_balance: slotBalance } = slot.state;
    if (!Number.isSafeInteger(slotNoteId) || slotNoteId < 0
        || !Number.isSafeInteger(slotBalance) || slotBalance < 0) return refuse('unknown_state');
    const expectedBalance = parseUnits(input.balanceUnits);
    if (!Number.isSafeInteger(input.noteId) || input.noteId < 0 || expectedBalance === null) return refuse('unknown_state');
    if (slotNoteId !== input.noteId || expectedBalance !== BigInt(slotBalance)) return refuse('changed');

    const lateRefusal = slotRefusal(slot);
    if (lateRefusal) return refuse(lateRefusal);
    // The tab's own key, which is in memory and may not have reached the slot.
    if (input.activeLease) return refuse('in_flight');

    if (!Array.isArray(input.withdrawals)) return refuse('unknown_state');
    for (const record of input.withdrawals) {
        if (!ofAnotherDeployment(record, input.deploymentId) && isOpenWithdrawalRecord(record)) {
            return refuse('open_withdrawal');
        }
    }

    if (input.deposits !== undefined && !Array.isArray(input.deposits)) return refuse('unknown_state');
    const rows = input.deposits || [];
    if ((input.claimed !== undefined && input.claimed !== false)
        || rows.some(row => isRecord(row) && row.status === 'confirmed'
            && Number(row.noteId) === slotNoteId && Boolean(row.expiryClaim)
            && !ofAnotherDeployment(row, input.deploymentId))) {
        return refuse('claimed');
    }

    if (nonEmptyUnresolved(input.unresolvedRequests) || nonEmptyRequestArchive(input.requestArchive)) {
        return refuse('unresolved_request');
    }

    const verdict = classifyBalance({
        balanceUnits: slotBalance,
        chargeCapUnits: input.chargeCapUnits,
        quote: input.quote,
        thresholdUsdMicros: input.thresholdUsdMicros,
        smallestTierUsdMicros: input.smallestTierUsdMicros,
        ceilingUnits: input.ceilingUnits,
        nowSeconds: input.nowSeconds ?? null
    });
    if (verdict.kind === 'zero' || verdict.kind === 'dust') return { ok: true, kind: verdict.kind };
    if (verdict.kind === 'price_unknown') return refuse('price_unknown');
    if (verdict.kind === 'above') return refuse('not_dust');
    return refuse('unknown_state');
}
