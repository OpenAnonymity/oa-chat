// Payment-history rows of the protocol versions this build did not load
// (docs/ZKAPI_VERSIONING.md, "5.4 The shared wallet database").
//
// Pure string renderers: no DOM, no storage, no clock, no facade import. The
// rows come from versioning/otherVersionHistory.mjs through the facade's
// `history` member; the account dialog hands this module those rows plus a few
// presentation facts and gets markup back, composed into
// `zkapiClient.oaVersioning.ui.historyItems` by versioning/ui.js.
//
// A row of another version is TEXT. The loaded SDK never reconciles another
// deployment and its note numbers repeat across vaults, so a foreign row must
// never carry a hook the dialog's delegated handlers would act on (sync,
// finalize, restore, retry, withdraw, view-deposit): the one button it may
// have opens that other version, through the facade, and only when the
// version can be opened right now.
//
// DOM hooks, stable for tests and CSS:
//   [data-other-version-record="<versionId>:<kind>:<n>"]   one payment row
//   [data-zkapi-history-version]                           the version tag
//   [data-zkapi-history-open="<versionId>"]                "Open version P"
//        + data-zkapi-history-reason="finish_previous|claim_credit"
//   [data-zkapi-history-omitted]                           "older payments not shown"
//        (a line, not a payment row: it never carries data-other-version-record,
//        so everything that has one is exactly one payment)
//
// Presentation facts, all optional (a missing fact only removes a line):
//   formatMoney(units)  dollars at the loaded SDK's current price of an amount
//                       in the LOADED SDK's own unit; '' or a dash when it has
//                       none (the row then shows ETH). It is only ever called
//                       for a row whose version says `sameUnitAsLoaded`.
//   dateText(ms)        the dialog's own date text
//   txUrl(hash, chainId) an explorer link or null
//   now                 epoch ms; expiry rows appear when a deadline passed
//   previous            VersionState.previous ({versionId, canOpen, ...})
//   slotHeld            this version's own balance holds the wallet
//
// Amounts are in the unit of the ROW's version (its adapter's `billing`),
// never the loaded SDK's. A dollar figure comes from the loaded SDK's
// formatter only when that unit IS the loaded one; any other unit is shown as
// ETH, computed from the row's own unit. A row of a version this build does
// not know has no amount at all. Dates are absolute: nothing here ticks.
//
// A list that was cut ends with an `omitted` row (the provider adds it); it
// renders as one quiet line and carries no hook.
import { escapeHtml } from '../versioning/copy.mjs';
import { billingDecimals, rowsAt } from '../versioning/otherVersionHistory.mjs';

// Words of these rows alone. Shared version copy stays in versioning/copy.mjs;
// units (ETH) are added in code, never in a template.
const WORDS = Object.freeze({
    deposit: 'Deposit',
    depositAdded: '+{amount} added to private balance',
    depositAddedNoAmount: 'Added to private balance',
    added: 'Added',
    fee: 'Actual network fee: {fee}',
    withdrawal: 'Withdrawal',
    withdrawalExit: 'Withdrawal · Emergency exit',
    returnedTo: '{amount} returned to {destination}',
    returnedToNoAmount: 'Returned to {destination}',
    savedDestination: 'your saved destination',
    returned: 'Returned',
    inProgressTo: '{amount} · to {destination}',
    setAsideTo: '{amount} set aside · to {destination}',
    closedHeading: 'Balance closed',
    closedBody: 'Payment not verified',
    closed: 'Closed',
    payoutHeading: 'Payout held',
    payoutBadge: 'To claim',
    payoutOpenable: 'A payout of {amount} is waiting. Claim it in {version}.',
    payoutOpenableNoAmount: 'A payout is waiting, and its amount isn’t known here. Claim it in {version}.',
    payoutUnopenable: 'A payout of {amount} is waiting in {version}, which this app can’t open anymore.',
    payoutUnopenableNoAmount: 'A payout is waiting in {version}, which this app can’t open anymore.',
    unfinished: 'Unfinished in {version}. Finish it there.',
    unfinishedUnopenable: 'Unfinished in {version}, which this app can’t open anymore.',
    unfinishedBadge: 'Unfinished',
    deviceUsed: 'This balance was used on another device, so this browser can’t safely continue this withdrawal. Open {version} to see where it stands.',
    deviceUsedUnopenable: 'This balance was used on another device, so this browser can’t safely continue this withdrawal in {version}, which this app can’t open anymore.',
    deviceBadge: 'Used on another device',
    canFinalize: 'Can be finalized after {date}.',
    slotHeld: 'First withdraw or finish the balance on this version, then open {version}.',
    open: 'Open {version}',
    alert: 'A withdrawal paid out less than your balance minus your last chat’s budget. The payment can’t be changed. Please report it to the service operator.',
    expiryClaim: 'Expiry claim',
    expiryClaimed: '{amount} from the original deposit was paid to the service treasury. No refund was made.',
    expiryClaimedNoAmount: 'The original deposit was paid to the service treasury. No refund was made.',
    claimed: 'Claimed',
    expiredHeading: 'Expiry deadline passed',
    expiredBody: 'No automatic refund. A treasury claim hasn’t been confirmed here.',
    expired: 'Expired',
    viewTransaction: 'View transaction',
    dateUnavailable: 'Date unavailable',
    retiredTag: '{label} · retired',
    anEarlierVersion: 'an earlier version',
    omitted: 'Older payments from other versions aren’t shown here.'
});

// The words the rows are made of, for the vocabulary sweep that guards them.
export const HISTORY_WORDS = WORDS;

const ETH = 'ETH';
const DASH = /^[—–-]$/;
const CLOSED_PHASES = new Set(['closed', 'closed_unconfirmed']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? escapeHtml(values[key]) : ''));
}

// ---------------------------------------------------------------------------
// Presentation facts
// ---------------------------------------------------------------------------

function safeCall(fn, ...args) {
    if (typeof fn !== 'function') return undefined;
    try {
        return fn(...args);
    } catch {
        return undefined;
    }
}

// Canonical decimal digits, as the projection writes every amount and fee
// (otherVersionHistory.mjs): no sign, no leading zeros, no exponent. BigInt()
// alone would also take '', ' 7' and '0x10', and read them as numbers.
const DECIMAL_UNITS = /^(?:0|[1-9][0-9]{0,77})$/;

// `units` (a decimal string) shown in `decimals` places, trailing zeros cut.
function decimalText(units, decimals) {
    if (typeof units !== 'string' || !DECIMAL_UNITS.test(units)) return null;
    try {
        const amount = BigInt(units);
        if (amount < 0n) return null;
        const scale = 10n ** BigInt(decimals);
        const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
        return `${amount / scale}${fraction ? `.${fraction}` : ''}`;
    } catch {
        return null;
    }
}

// An amount of the ROW's version, in words.
//
// Dollars only when the loaded SDK's formatter reads the very unit this row
// counts in (`version.sameUnitAsLoaded`, set by the provider from both
// adapters' own data) and has a price for them. The formatter is never asked
// about any other unit: it would take the number as its own unit and print a
// figure off by the ratio between the two. Otherwise ETH, from the row's own
// unit. Null when the amount is not known: a version this build has no unit
// for, a unit that is not an amount of ETH, or a bad value.
function amountText(units, row, ctx) {
    const billing = row.version?.billing;
    if (typeof units !== 'string' || !isRecord(billing) || billing.asset !== 'native_eth') return null;
    if (row.version.sameUnitAsLoaded === true) {
        const usd = safeCall(ctx.formatMoney, units);
        if (typeof usd === 'string' && usd.trim() && !DASH.test(usd.trim())) return usd;
    }
    const decimals = billingDecimals(billing.perEth);
    const text = decimals === null ? null : decimalText(units, decimals);
    return text === null ? null : `${text} ${ETH}`;
}

function feeText(feeWei) {
    const text = typeof feeWei === 'string' ? decimalText(feeWei, 18) : null;
    return text === null ? null : `${text} ${ETH}`;
}

function compactAddress(address) {
    if (typeof address !== 'string' || !address) return '';
    return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}

function dateText(ms, ctx) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return WORDS.dateUnavailable;
    const text = safeCall(ctx.dateText, value);
    if (typeof text === 'string' && text) return text;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? WORDS.dateUnavailable : date.toISOString().slice(0, 10);
}

function transactionUrl(hash, row, ctx) {
    const chainId = row.version?.chainId;
    // The explorer of the ROW's chain: a version with no chain has no link.
    if (typeof hash !== 'string' || !hash || !Number.isSafeInteger(chainId) || chainId <= 0) return null;
    const url = safeCall(ctx.txUrl, hash, chainId);
    // Only a web link: the row text is data and this href reaches the page.
    return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
}

// ---------------------------------------------------------------------------
// Version words
// ---------------------------------------------------------------------------

function versionPhrase(version) {
    if (!isRecord(version) || version.versionId === null || version.versionId === undefined) {
        return WORDS.anEarlierVersion;
    }
    const label = typeof version.label === 'string' ? version.label.trim() : '';
    const match = /^version\s+(.+)$/i.exec(label);
    if (match) return `version ${match[1]}`;
    return label || WORDS.anEarlierVersion;
}

function versionTag(version) {
    const label = isRecord(version) && typeof version.label === 'string' ? version.label : '';
    return version?.status === 'retired' ? fill(WORDS.retiredTag, { label }) : escapeHtml(label);
}

// A version the app can no longer open: a retired one, or one this build has
// no table row for.
function isUnopenable(version) {
    return !isRecord(version) || version.versionId === null || version.versionId === undefined
        || version.status === 'retired' || version.status === 'unknown';
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function line(html) {
    return `<p class="mt-2 text-[11px] text-muted-foreground">${html}</p>`;
}

function transactionLink(url) {
    return `<a class="mt-2 inline-flex text-[11px] text-muted-foreground underline underline-offset-2" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(WORDS.viewTransaction)}</a>`;
}

function card(row, ctx, { heading, body, badge, success = false, extras = '' }) {
    return `<section class="rounded-lg border border-border bg-muted/20 p-3" data-other-version-record="${escapeHtml(row.key)}">
            <div class="flex items-start justify-between gap-3">
                <div>
                    <p class="text-xs font-medium text-foreground">${escapeHtml(heading)}</p>
                    <p class="mt-0.5 text-[11px] text-muted-foreground">${body}</p>
                    <p class="mt-1 text-[11px] text-muted-foreground">${escapeHtml(dateText(row.at, ctx))}</p>
                </div>
                <div class="flex shrink-0 flex-col items-end gap-1">
                    <span class="rounded-full ${success ? 'badge-status-success' : 'bg-muted text-muted-foreground'} px-2 py-1 text-[10px]">${escapeHtml(badge)}</span>
                    <span class="rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground" data-zkapi-history-version="${escapeHtml(row.scope || '')}">${versionTag(row.version)}</span>
                </div>
            </div>${extras}
        </section>`;
}

// The way forward for a row that needs the other version: the button when
// that version is the one the state names and it can be opened now, a reason
// when this version's own balance holds the wallet, nothing otherwise. A
// `reason` of null is a row that is only to be read: it never gets the
// button, and still gets the reason a version cannot be opened yet.
function forwardLine(row, ctx, reason) {
    if (isUnopenable(row.version)) return '';
    const previous = isRecord(ctx.previous) ? ctx.previous : null;
    const named = versionPhrase(row.version);
    if (previous && previous.versionId === row.version.versionId && previous.canOpen === true) {
        if (reason === null) return '';
        return `<button type="button" class="zkapi-secondary-button mt-3 w-full" data-zkapi-history-open="${escapeHtml(row.version.versionId)}" data-zkapi-history-reason="${reason}">${fill(WORDS.open, { version: named })}</button>`;
    }
    if (ctx.slotHeld === true) return line(fill(WORDS.slotHeld, { version: named }));
    return '';
}

function renderDeposit(row, ctx) {
    const amount = amountText(row.amountUnits, row, ctx);
    const fee = feeText(row.feeWei);
    const url = transactionUrl(row.transactionHash, row, ctx);
    return card(row, ctx, {
        heading: WORDS.deposit,
        body: amount === null ? escapeHtml(WORDS.depositAddedNoAmount) : fill(WORDS.depositAdded, { amount }),
        badge: WORDS.added,
        success: true,
        extras: `${fee ? line(fill(WORDS.fee, { fee })) : ''}${url ? transactionLink(url) : ''}`
    });
}

function withdrawalHeading(row) {
    return row.mode === 'escape' ? WORDS.withdrawalExit : WORDS.withdrawal;
}

function renderWithdrawal(row, ctx) {
    const closed = CLOSED_PHASES.has(row.phase);
    const alert = row.payoutAlert === 'concession_exceeded_bound' ? line(escapeHtml(WORDS.alert)) : '';
    const unopenable = isUnopenable(row.version);
    const version = versionPhrase(row.version);

    if (closed && row.payoutCredited === true && row.payoutClaimed !== true) {
        const amount = amountText(row.creditedUnits, row, ctx);
        const template = unopenable
            ? (amount === null ? WORDS.payoutUnopenableNoAmount : WORDS.payoutUnopenable)
            : (amount === null ? WORDS.payoutOpenableNoAmount : WORDS.payoutOpenable);
        return card(row, ctx, {
            heading: WORDS.payoutHeading,
            body: fill(template, { amount: amount ?? '', version }),
            badge: WORDS.payoutBadge,
            extras: `${forwardLine(row, ctx, 'claim_credit')}${alert}`
        });
    }

    if (closed) {
        const url = transactionUrl(row.transactionHash, row, ctx);
        if (row.payoutVerified === true) {
            const amount = amountText(row.amountUnits, row, ctx);
            const destination = compactAddress(row.destination) || WORDS.savedDestination;
            return card(row, ctx, {
                heading: withdrawalHeading(row),
                body: amount === null
                    ? fill(WORDS.returnedToNoAmount, { destination })
                    : fill(WORDS.returnedTo, { amount, destination }),
                badge: WORDS.returned,
                success: true,
                extras: `${alert}${url ? transactionLink(url) : ''}`
            });
        }
        return card(row, ctx, {
            heading: WORDS.closedHeading,
            body: escapeHtml(WORDS.closedBody),
            badge: WORDS.closed,
            extras: `${alert}${url ? transactionLink(url) : ''}`
        });
    }

    const amount = amountText(row.amountUnits, row, ctx);
    const destination = compactAddress(row.destination) || WORDS.savedDestination;
    const setAside = row.phase === 'parked' || row.phase === 'restored';
    const summary = amount === null ? ''
        : fill(setAside ? WORDS.setAsideTo : WORDS.inProgressTo, { amount, destination });

    // The build that kept this record found that another device had used the
    // balance's next state. Withdrawing it from this browser would cost
    // network fees and be rejected, so the row neither says "finish it there"
    // nor offers the button, and promises no finalization date. It says what
    // is so and where the status lives; the way out is that version's to give.
    if (row.deviceNotNewest === true) {
        return card(row, ctx, {
            heading: withdrawalHeading(row),
            body: fill(unopenable ? WORDS.deviceUsedUnopenable : WORDS.deviceUsed, { version }),
            badge: WORDS.deviceBadge,
            extras: `${summary ? line(summary) : ''}${forwardLine(row, ctx, null)}`
        });
    }

    const deadline = row.mode === 'escape' && row.phase === 'pending' && Number(row.challengeDeadline) > 0
        ? line(fill(WORDS.canFinalize, { date: dateText(Number(row.challengeDeadline) * 1000, ctx) })) : '';
    return card(row, ctx, {
        heading: withdrawalHeading(row),
        body: fill(unopenable ? WORDS.unfinishedUnopenable : WORDS.unfinished, { version }),
        badge: WORDS.unfinishedBadge,
        extras: `${summary ? line(summary) : ''}${deadline}${forwardLine(row, ctx, 'finish_previous')}`
    });
}

function renderExpiry(row, ctx) {
    if (row.status === 'claimed') {
        const amount = amountText(row.claimAmountUnits, row, ctx);
        const url = transactionUrl(row.claimTransactionHash, row, ctx);
        return card(row, ctx, {
            heading: WORDS.expiryClaim,
            body: amount === null ? escapeHtml(WORDS.expiryClaimedNoAmount) : fill(WORDS.expiryClaimed, { amount }),
            badge: WORDS.claimed,
            extras: url ? transactionLink(url) : ''
        });
    }
    return card(row, ctx, {
        heading: WORDS.expiredHeading,
        body: escapeHtml(WORDS.expiredBody),
        badge: WORDS.expired
    });
}

// The line a cut list ends with: older payments exist that this list does not
// show. Quiet, dateless and without a hook.
function renderOmitted() {
    return `<section class="rounded-lg border border-border bg-muted/20 p-3" data-zkapi-history-omitted="true">
            <p class="text-[11px] text-muted-foreground">${escapeHtml(WORDS.omitted)}</p>
        </section>`;
}

/**
 * The markup of one row, '' for a row this module does not know.
 * @param {object} row  a row of otherVersionHistory.projectOtherHistory
 * @param {object} [ctx]  the presentation facts in the header
 */
export function renderHistoryRow(row, ctx = {}) {
    if (!isRecord(row) || typeof row.key !== 'string') return '';
    const context = isRecord(ctx) ? ctx : {};
    if (row.kind === 'deposit') return renderDeposit(row, context);
    if (row.kind === 'withdrawal') return renderWithdrawal(row, context);
    if (row.kind === 'expiry') return renderExpiry(row, context);
    if (row.kind === 'omitted') return renderOmitted();
    return '';
}

/**
 * The rows as list items, as they read at `ctx.now`.
 * @param {object[]} rows  facade.history.rows()
 * @param {object} [ctx]
 * @returns {Array<{key: string, at: number, html: string}>} `at` is the row's
 *   own time in epoch ms (0 when it has none), for the dialog's ordering.
 */
export function renderHistoryItems(rows, ctx = {}) {
    const context = isRecord(ctx) ? ctx : {};
    const now = typeof context.now === 'number' && Number.isFinite(context.now) ? context.now : Number.NaN;
    const items = [];
    for (const row of rowsAt(rows, now)) {
        const html = renderHistoryRow(row, context);
        if (html) items.push({ key: row.key, at: Number.isFinite(row.at) ? row.at : 0, html });
    }
    return items;
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

// Rows are immutable snapshots of a read and a list is replaced by the next
// read, never edited: its part of the signature is computed once per list.
const BASE_SIGNATURES = new WeakMap();

function mix(text, seed = 0x811c9dc5) {
    let hash = seed;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

function rowFingerprint(row) {
    // Everything the markup of a row depends on besides the presentation facts.
    return [
        row.key, row.kind, row.at, row.status, row.phase, row.mode, row.open, row.payoutVerified,
        row.payoutCredited, row.payoutClaimed, row.payoutAlert, row.deviceNotNewest, row.amountUnits,
        row.creditedUnits, row.claimAmountUnits, row.feeWei, row.destination, row.challengeDeadline,
        row.transactionHash, row.claimTransactionHash, row.expiryTs, row.expiryState,
        row.version?.versionId, row.version?.label, row.version?.status, row.version?.chainId,
        row.version?.billing?.asset, row.version?.billing?.perEth, row.version?.sameUnitAsLoaded
    ].map(value => (value === null || value === undefined ? '' : String(value))).join('\u0001');
}

function baseSignature(rows) {
    if (!Array.isArray(rows)) return '0:0';
    const cached = BASE_SIGNATURES.get(rows);
    if (cached && cached.length === rows.length) return cached.signature;
    let hash = 0x811c9dc5;
    let count = 0;
    for (const row of rows) {
        if (!isRecord(row) || typeof row.key !== 'string') continue;
        hash = mix(`${rowFingerprint(row)}\u0002`, hash);
        count += 1;
    }
    const signature = `${count}:${hash.toString(36)}`;
    BASE_SIGNATURES.set(rows, { length: rows.length, signature });
    return signature;
}

/**
 * A short string that changes exactly when the rendered rows would: a new
 * read that changed a row, or a deadline crossed since the last read. It
 * carries no amount of the loaded version and no ticking time, so it can sit
 * in the facade's change signature and the dialog's re-render check.
 * @param {object[]} rows
 * @param {number} nowMs
 */
export function historySignature(rows, nowMs) {
    const base = baseSignature(rows);
    if (!Array.isArray(rows) || !Number.isFinite(nowMs)) return base;
    const present = new Set(rows.filter(row => isRecord(row) && row.kind === 'expiry')
        .map(row => `${row.scope}:${row.noteId}`));
    const crossed = [];
    for (const row of rows) {
        if (!isRecord(row) || row.kind !== 'deposit' || row.expiryState !== 'open') continue;
        if (!(Number(row.expiryTs) > 0) || row.expiryTs * 1000 > nowMs) continue;
        if (!present.has(`${row.scope}:${row.noteId}`)) crossed.push(`${row.scope}:${row.noteId}`);
    }
    return crossed.length ? `${base}+${crossed.length}:${mix(crossed.join('\u0001')).toString(36)}` : base;
}
