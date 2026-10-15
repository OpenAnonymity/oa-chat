// What a payment-history row of the loaded version says about its payout and
// its device (docs/ZKAPI_VERSIONING.md).
//
// Pure string renderer: no DOM, no storage, no clock, no facade, no SDK. The
// account dialog hands this module one public withdrawal record (an entry of
// `zkapiClient.withdrawals`) plus a few presentation facts and gets back what
// to ADD to that record's row. It never replaces the row: the dialog's own
// heading, amount line, countdown and buttons stay, and the dialog applies the
// fields below where its markup has a place for them. A record with nothing to
// say yields the empty result, so a row of a version that has no payouts to
// claim and no device state renders exactly as it always has.
//
// Three facts a record of the concession protocol (vault revision 3) can
// carry are told here, each in the words the version notices use
// (versioning/copy.mjs):
//
//   Payout held      A closed escape whose payout the payment contract could
//                    not send to its address and only credited. It is never
//                    "returned" or "sent" until a claim is proven. The row
//                    gets a card (amount when this browser knows it, the
//                    address, what claiming does) and a Claim payout button;
//                    a claim already sent is said and linked, and after the
//                    claim is proven the row says where the payout went and
//                    links the claim transaction.
//   Paid less        A close that paid out less than the balance minus the
//   than expected    last chat's budget. The payment cannot be changed; the
//                    row keeps a persistent attention note and a badge. The
//                    payment is still a payment: nothing here claims it was
//                    "all back".
//   Used on another  A set-aside balance that another device or copy spent
//   device           the next state of (the record carries `deviceNotNewest`
//                    or `challengeObserved`). This browser cannot safely
//                    withdraw it, so the row explains that and asks the
//                    dialog to render none of its own buttons: "Use this
//                    balance" and "Finish withdrawal" would each be refused
//                    after costing a network fee. The words never promise an
//                    in-app restore (there is none; only the companion tool
//                    opens an exit kit).
//
// Result, every field always present (label and badge are plain text for the
// dialog to escape; the two html fields are already safe to insert):
//   label        string|null  the status pill's text instead of the dialog's
//                             own ("Payout held", "Used on another device")
//   badge        string|null  text of a second small pill beside it
//                             ("Paid less than expected")
//   noteHtml     string       paragraphs for under the row's header, above
//                             its buttons; trusted markup, text escaped here
//   actionsHtml  string       buttons to sit in the same `flex gap-2` row as
//                             the row's own. A closed record has no such row
//                             today: the dialog makes one when this is not ''
//   hideActions  boolean      render none of the row's own buttons
//   hideError    boolean      do not print the record's own `error` line (it
//                             is the SDK's device message, which tells the
//                             person to restore a backup the app cannot open)
//
// Presentation facts (`ctx`), all optional; a missing fact only removes a
// line or a link:
//   formatMoney(units)  the dialog's money text for an amount in units (its
//                       own `formatWithdrawalAmount`, which falls back to ETH,
//                       or `zkapiClient.formatMoney`): '' or a dash when there
//                       is no figure, and the amount is then left out
//   compact(address)    a shortened address (`zkapiClient.compact`)
//   txUrl(hash)         an https explorer link for a transaction, or null
//   busy                the dialog is running something: the button is
//                       disabled, as the row's own buttons are
//   method              'metamask' | 'address': whose wallet sends a
//                       transaction. A sponsored row offers a wallet-paid
//                       action only where the wallet is a person's own
//
// A withdrawal whose network fee was paid from the withdrawal itself (a
// sponsored withdrawal: the record names `feePayer: "payout"`, the address
// that is paid in `payout` and a holding address in `transit`) has two more
// things to say, in the same words:
//
//   Fee paid         what the network fee was and what was received, once the
//                    withdrawal is over; and for an exit still waiting, that
//                    its fee is taken from the withdrawal when it finishes.
//   Payout waiting   The withdrawal went through, but the payout is at its
//                    holding address and has to be collected. Collecting is
//                    free to the person (the service pays for it), or one
//                    transaction from the wallet.
//   Payout held      The receiving address would not take a plain ETH
//                    payment, so it is held for them to claim (one
//                    transaction from an account that holds a little ETH).
//
// DOM hooks, stable for tests and CSS:
//   [data-claim-payout="<recordId>"]   the Claim payout button; the dialog
//                                      delegates a click to
//                                      `zkapiClient.claimEscapePayout(id)`
//   [data-collect-transit="<recordId>"]        Collect payout (free to the person)
//   [data-sweep-transit="<recordId>"]          Collect with my wallet
//   [data-claim-gasless-credit="<recordId>"]   Claim a held sponsored payout
//   [data-zkapi-record-sponsored]              the fee lines of a sponsored row
//   [data-zkapi-record-credit]         the held-payout card
//   [data-zkapi-record-claimed]        the delivered-payout lines
//   [data-zkapi-record-alert]          the paid-less attention note
//   [data-zkapi-record-device]         the used-on-another-device note
// The result carries none of the hooks the dialog's other handlers act on
// (sync, finalize, restore, retry, withdraw, cancel) and no version action.
import { escapeHtml, versionCopy, versionCopyText } from '../versioning/copy.mjs';
import { isUnclaimedPayoutCredit } from '../versioning/walletHoldings.mjs';

export { isUnclaimedPayoutCredit };

// Words of these rows alone. The notice wording stays in versioning/copy.mjs
// (payout.credited, payout.alert, payout.alert.badge, exit.device,
// exit.device.label); units such as ETH never appear in a template.
const WORDS = Object.freeze({
    heldLabel: 'Payout held',
    claimButton: 'Claim payout',
    amountUnknown: 'The amount isn’t shown here. The claim pays everything the payment contract holds for this address.',
    claimNote: 'Claiming is one transaction, and the account that sends it pays the network fee. It also pays any other payout held for the same address, and it works even when the service is unavailable.',
    claimSent: 'A claim for this payout was already sent. Claiming again checks it before sending anything new.',
    claimedTo: 'This payout was claimed and paid to {destination}.',
    claimedToAddress: 'This payout was claimed and paid to its address.',
    claimedAmount: 'The claim paid {amount} in total, including any other payout held for that address.',
    clearedTo: 'The payment contract no longer holds this payout, so it was already paid to {destination}.',
    clearedToAddress: 'The payment contract no longer holds this payout, so it was already paid to its address.',
    viewClaim: 'View claim transaction',
    alertFigures: 'The withdrawal paid out {paid}. Your balance minus your last chat’s budget was {floor}.',
    feePaid: 'The network fee, {fee}, was paid from this withdrawal.',
    feeAndReceived: 'The network fee, {fee}, was paid from this withdrawal, and {received} was sent to {destination}.',
    feePending: 'The network fee of this exit is paid from the withdrawal when it finishes.',
    waitingLabel: 'Payout waiting',
    waitingNote: 'This withdrawal went through, but the payout is still waiting at a holding address and has to be sent on to {destination}.',
    waitingNoteAddress: 'This withdrawal went through, but the payout is still waiting at a holding address and has to be sent on to its address.',
    collectNote: 'Collecting it costs you nothing: the service pays for it.',
    collectButton: 'Collect payout',
    collectWalletNote: 'Or collect it with your wallet: that is one transaction, and the account that sends it pays the network fee.',
    collectWalletButton: 'Collect with my wallet',
    creditedHeldNote: '{amount} is held for {destination}: that address would not accept the payment.',
    creditedHeldNoteAddress: 'The payout is held for its address: that address would not accept the payment.',
    creditedClaimNote: 'Claiming it is one transaction, and the account that sends it pays the network fee.',
    creditedClaimButton: 'Claim payout'
});

/** The words these rows are made of, for the vocabulary sweep that guards them. */
export const RECORD_EXTRAS_WORDS = WORDS;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DASH = /^[—–-]+$/;
const DEVICE_PHASES = new Set(['parked', 'restored']);
// The SDK's own sentence for a defeated escape. It is told in the words of the
// version notices instead, because it sends the person to a restore this app
// does not have; any other error on the record is kept.
const SDK_DEVICE_ERROR = /another device spent|not the newest|newest backup or exit kit/i;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function emptyExtras() {
    return { label: null, badge: null, noteHtml: '', actionsHtml: '', hideActions: false, hideError: false };
}

/**
 * Whether the record is a set-aside balance this browser cannot exit because
 * another device or copy spent its next state: flagged `deviceNotNewest` when
 * it was restored, or defeated by a newer state the SDK observed.
 */
export function isDeviceNotNewestRecord(record) {
    return isRecord(record) && DEVICE_PHASES.has(record.phase)
        && (record.deviceNotNewest === true || record.challengeObserved === true);
}

/** Whether the record's close paid out less than the balance minus the last chat's budget. */
export function hasPayoutAlert(record) {
    return isRecord(record) && record.payoutAlert === 'concession_exceeded_bound';
}

// A credit this browser saw delivered: the claim's own evidence, set only by a
// proven claim receipt or a vault that no longer holds the credit.
function isClaimedPayoutCredit(record) {
    return isRecord(record) && record.payoutCredited === true && record.payoutClaimed === true
        && (record.phase === 'closed' || record.phase === 'closed_unconfirmed');
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

function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? escapeHtml(values[key]) : ''));
}

// An amount in units as a canonical decimal string. The SDK writes some
// amounts as numbers (`finalBalance`, `creditedAmount`) and some as decimal
// strings (`stateBalance`, `boundAtState`); anything else is not an amount.
function unitsText(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    if (typeof value === 'bigint') return value >= 0n ? String(value) : null;
    if (typeof value === 'string' && /^[0-9]{1,30}$/.test(value)) return String(BigInt(value));
    return null;
}

// The dialog's money text for an amount, '' when it has none (no price, a
// dash, a failing formatter): the figure is then left out, never guessed.
function pricedAmount(units, ctx) {
    if (units === null) return '';
    const text = safeCall(ctx.formatMoney, units);
    if (typeof text !== 'string') return '';
    const trimmed = text.trim();
    return trimmed && !DASH.test(trimmed) ? trimmed : '';
}

function addressText(address, ctx) {
    if (typeof address !== 'string' || !ADDRESS.test(address)) return '';
    const text = safeCall(ctx.compact, address);
    if (typeof text === 'string' && text.trim() && !DASH.test(text.trim())) return text.trim();
    return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function recordIdOf(record) {
    return typeof record.recordId === 'string' && record.recordId.trim() ? record.recordId : '';
}

// The newest claim this browser sent for the payout (the SDK keeps them oldest
// first), or '' when none was. Only a real transaction hash counts.
function sentClaimHash(record) {
    const hashes = record.payoutClaimTransactionHashes;
    if (!Array.isArray(hashes)) return '';
    for (let index = hashes.length - 1; index >= 0; index -= 1) {
        if (typeof hashes[index] === 'string' && HASH.test(hashes[index])) return hashes[index];
    }
    return '';
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

const LINE = 'text-[11px] text-muted-foreground';

function transactionLink(hash, ctx) {
    if (typeof hash !== 'string' || !HASH.test(hash)) return '';
    const url = safeCall(ctx.txUrl, hash);
    // Only a web link: this href reaches the page.
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return '';
    return `<a class="inline-flex ${LINE} underline underline-offset-2" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(WORDS.viewClaim)}</a>`;
}

// A credited escape payout that is still waiting: what it is, what it is
// worth when this browser knows, and what claiming does.
function heldCard(record, ctx) {
    const units = unitsText(record.creditedAmount);
    const amount = pricedAmount(units, ctx);
    const destination = addressText(record.destination, ctx);
    const sent = sentClaimHash(record);
    const lines = [
        `<p class="text-[11px] text-foreground">${versionCopy('payout.credited', { amount, destination })}</p>`,
        // The amount is not in the record (the vault holds a credit no receipt
        // told this browser about), as opposed to a price that is missing.
        units === null ? `<p class="${LINE}">${escapeHtml(WORDS.amountUnknown)}</p>` : '',
        `<p class="${LINE}">${escapeHtml(WORDS.claimNote)}</p>`,
        // A claim that was sent and is not proven yet: the person can watch it,
        // and pressing Claim again checks it before anything new is sent.
        sent ? `<p class="${LINE}">${escapeHtml(WORDS.claimSent)}</p>` : '',
        sent ? transactionLink(sent, ctx) : ''
    ].filter(Boolean);
    return `<div class="mt-2 space-y-1" data-zkapi-record-credit>${lines.join('')}</div>`;
}

// A credit this browser saw delivered: where it went, and the claim.
function deliveredCard(record, ctx) {
    const destination = addressText(record.destination, ctx);
    const cleared = record.payoutClaimEvidence === 'credit_cleared';
    const sentence = cleared
        ? (destination ? fill(WORDS.clearedTo, { destination }) : escapeHtml(WORDS.clearedToAddress))
        : (destination ? fill(WORDS.claimedTo, { destination }) : escapeHtml(WORDS.claimedToAddress));
    // The claim pays every credit of the address at once, so the amount of the
    // claim is the total, and a claim that was only seen to be over has none.
    const paid = cleared ? '' : pricedAmount(unitsText(record.payoutClaimedAmount), ctx);
    const link = cleared ? '' : transactionLink(record.payoutClaimTransactionHash, ctx);
    const lines = [
        `<p class="${LINE}">${sentence}</p>`,
        paid ? `<p class="${LINE}">${fill(WORDS.claimedAmount, { amount: paid })}</p>` : '',
        link
    ].filter(Boolean);
    return `<div class="mt-2 space-y-1" data-zkapi-record-claimed>${lines.join('')}</div>`;
}

// What the close paid, against what the protocol's rule says it should have
// paid at least. Figures are shown only when this record's own numbers agree
// with the alert and both can be priced; the note stands without them.
function alertFigures(record, ctx) {
    const paid = unitsText(record.finalBalance);
    const balance = unitsText(record.stateBalance);
    const bound = unitsText(record.boundAtState);
    if (paid === null || balance === null || bound === null) return '';
    const floor = BigInt(balance) - BigInt(bound);
    if (floor <= 0n || BigInt(paid) >= floor) return '';
    const paidText = pricedAmount(paid, ctx);
    const floorText = pricedAmount(String(floor), ctx);
    if (!paidText || !floorText || paidText === floorText) return '';
    return fill(WORDS.alertFigures, { paid: paidText, floor: floorText });
}

function alertNote(record, ctx) {
    const figures = alertFigures(record, ctx);
    return `<div class="mt-2 rounded-md border border-amber-300/60 bg-amber-50/60 p-2 text-[11px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100" data-zkapi-record-alert><p>${versionCopy('payout.alert')}</p>${figures ? `<p class="mt-1">${figures}</p>` : ''}</div>`;
}

function deviceNote() {
    return `<p class="mt-2 ${LINE}" data-zkapi-record-device>${versionCopy('exit.device')}</p>`;
}

// ---------------------------------------------------------------------------
// A withdrawal that paid its own network fee
// ---------------------------------------------------------------------------

/** Whether the record is a sponsored withdrawal: it names who is paid and its holding address. */
export function isSponsoredRecord(record) {
    return isRecord(record) && record.feePayer === 'payout'
        && ADDRESS.test(String(record.payout)) && ADDRESS.test(String((record.transit || {}).account));
}

// An amount in wei as ledger units (gwei), or null: the unit every other
// figure of a row is in.
function unitsFromWei(value) {
    const text = typeof value === 'string' && /^[0-9]{1,40}$/.test(value) ? value
        : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    return text === null ? null : (BigInt(text) / 1_000_000_000n).toString();
}

const isClosedPhase = record => record.phase === 'closed' || record.phase === 'closed_unconfirmed';

function sponsoredBlocks(record, ctx, extras) {
    const notes = [];
    const recordId = recordIdOf(record);
    const destination = addressText(record.payout, ctx);
    const fee = pricedAmount(unitsFromWei(record.chargedWei), ctx);
    const received = pricedAmount(unitsFromWei(record.paidOutWei), ctx);
    const actions = [];
    const wallet = ctx.method === 'metamask' || ctx.method === undefined;
    if (record.paymasterCredited === true && isClosedPhase(record)) {
        // The payout was credited, not sent: held, and claimed from the wallet.
        extras.label = WORDS.heldLabel;
        const amount = pricedAmount(unitsFromWei(record.paymasterCreditedWei), ctx);
        const heldLine = amount && destination ? fill(WORDS.creditedHeldNote, { amount, destination })
            : destination ? fill(WORDS.creditedHeldNote, { amount: 'The payout', destination })
                : escapeHtml(WORDS.creditedHeldNoteAddress);
        notes.push(`<div class="mt-2 space-y-1" data-zkapi-record-credit data-zkapi-record-sponsored>
            <p class="text-[11px] text-foreground">${heldLine}</p>
            ${fee ? `<p class="${LINE}">${fill(WORDS.feePaid, { fee })}</p>` : ''}
            <p class="${LINE}">${escapeHtml(WORDS.creditedClaimNote)}</p>
        </div>`);
        if (recordId && wallet) {
            actions.push(`<button data-claim-gasless-credit="${escapeHtml(recordId)}" class="zkapi-primary-button flex-1" type="button"${ctx.busy ? ' disabled' : ''}>${escapeHtml(WORDS.creditedClaimButton)}</button>`);
        }
    } else if (record.fundsWaitingInTransit === true && isClosedPhase(record)) {
        extras.label = WORDS.waitingLabel;
        notes.push(`<div class="mt-2 space-y-1" data-zkapi-record-sponsored>
            <p class="text-[11px] text-foreground">${destination ? fill(WORDS.waitingNote, { destination }) : escapeHtml(WORDS.waitingNoteAddress)}</p>
            <p class="${LINE}">${escapeHtml(WORDS.collectNote)}</p>
            ${wallet ? `<p class="${LINE}">${escapeHtml(WORDS.collectWalletNote)}</p>` : ''}
        </div>`);
        if (recordId) {
            actions.push(`<button data-collect-transit="${escapeHtml(recordId)}" class="zkapi-primary-button flex-1" type="button"${ctx.busy ? ' disabled' : ''}>${escapeHtml(WORDS.collectButton)}</button>`);
            if (wallet) {
                actions.push(`<button data-sweep-transit="${escapeHtml(recordId)}" class="zkapi-secondary-button flex-1" type="button"${ctx.busy ? ' disabled' : ''}>${escapeHtml(WORDS.collectWalletButton)}</button>`);
            }
        }
    } else if (isClosedPhase(record) && fee) {
        notes.push(`<p class="mt-2 ${LINE}" data-zkapi-record-sponsored>${received && destination
            ? fill(WORDS.feeAndReceived, { fee, received, destination }) : fill(WORDS.feePaid, { fee })}</p>`);
    } else if (!isClosedPhase(record) && record.mode === 'escape') {
        notes.push(`<p class="mt-2 ${LINE}" data-zkapi-record-sponsored>${escapeHtml(WORDS.feePending)}</p>`);
    }
    if (actions.length) extras.actionsHtml += actions.join('');
    return notes;
}

function claimButton(recordId, ctx) {
    return `<button data-claim-payout="${escapeHtml(recordId)}" class="zkapi-primary-button flex-1" type="button"${ctx.busy ? ' disabled' : ''}>${escapeHtml(WORDS.claimButton)}</button>`;
}

// Whether the record is device-flagged, answered even when reading it fails:
// a balance that may not be withdrawn from here must keep its buttons hidden
// whatever else goes wrong while the row is composed.
function deviceFlagged(record) {
    try {
        return isDeviceNotNewestRecord(record);
    } catch {
        return false;
    }
}

/**
 * What to add to one withdrawal record's row.
 * @param {object} record  an entry of `zkapiClient.withdrawals`
 * @param {object} [ctx]  the presentation facts in the header
 * @returns {{label: string|null, badge: string|null, noteHtml: string,
 *   actionsHtml: string, hideActions: boolean, hideError: boolean}}
 */
export function recordExtras(record, ctx = {}) {
    const flagged = deviceFlagged(record);
    try {
        if (!isRecord(record)) return emptyExtras();
        const context = isRecord(ctx) ? ctx : {};
        const extras = emptyExtras();
        const notes = [];

        if (isUnclaimedPayoutCredit(record)) {
            extras.label = WORDS.heldLabel;
            notes.push(heldCard(record, context));
            // A claim needs the record it settles and the address it pays: a
            // row missing either explains itself and offers nothing to click.
            const recordId = recordIdOf(record);
            if (recordId && ADDRESS.test(String(record.destination))) {
                extras.actionsHtml = claimButton(recordId, context);
            }
        } else if (isClaimedPayoutCredit(record)) {
            notes.push(deliveredCard(record, context));
        }

        if (isSponsoredRecord(record)) notes.push(...sponsoredBlocks(record, context, extras));

        if (hasPayoutAlert(record)) {
            extras.badge = versionCopyText('payout.alert.badge');
            notes.push(alertNote(record, context));
        }

        if (flagged) {
            extras.label = versionCopyText('exit.device.label');
            notes.push(deviceNote());
            extras.hideActions = true;
            extras.hideError = typeof record.error === 'string' && SDK_DEVICE_ERROR.test(record.error);
        }

        extras.noteHtml = notes.join('');
        return extras;
    } catch {
        return { ...emptyExtras(), hideActions: flagged };
    }
}
