// "Give up this balance": a standalone modal dialog that confirms, and then
// asks the facade to carry out, the removal of an empty or very small balance
// from a version that no longer takes deposits (docs/ZKAPI_VERSIONING.md,
// section 7, "Upgrade UX").
//
// What the dialog owes the person, because this is the one action that removes
// a balance from the browser:
//
//   - what is given up, in the person's money AND in ether. A dollar figure
//     alone depends on a price quote, so the ether amount is always beside it
//   - nothing moves on Ethereum, the deposit stays where it is, and this app
//     can not bring the balance back. Nothing is called "safe" or "lost"
//   - an empty balance is one button: nothing is forfeited, so nothing is
//     asked. A balance with value needs a checkbox AND a button that names the
//     amount, and the button stays off until the box is ticked
//   - the confirmation is bound to what was shown: `giveUp` receives the note
//     number and the exact balance of the preview, and the service refuses if
//     either changed
//   - the outcome is said in a status region and focus moves to what comes
//     next; no native `confirm()`
//
// A pure view over injected functions (`preview`, `giveUp`, `reload`): no
// facade, no SDK, no storage.
//
// DOM hooks: [data-zkapi-abandon-dialog] on the <dialog>,
// [data-zkapi-abandon-kind="zero|dust"], [data-zkapi-abandon-check],
// [data-zkapi-abandon-action="confirm|cancel|reload|close"],
// [data-zkapi-abandon-status] (role status), [data-zkapi-abandon-intro] (the
// question, which an answer replaces).
import { escapeHtml, versionCopy, versionCopyText } from '../versioning/copy.mjs';
import { formatEthUnits, formatUsdMicros } from '../versioning/abandonNote.mjs';

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export const ABANDON_WORDS = Object.freeze({
    understand: 'I understand I won’t get this balance back.',
    checkHint: 'Check the box to continue.',
    confirmDust: 'Give up {amount}',
    cancel: 'Cancel',
    working: 'Working…',
    reload: 'Reload',
    close: 'Close',
    doneZero: 'Balance cleared from this browser.',
    doneDust: 'Balance given up. It was cleared from this browser.',
    doneTitleZero: 'Balance cleared',
    doneTitleDust: 'Balance given up',
    doneReload: 'Reload to add funds{?version} to version {version}{/version}.',
    unavailableTitle: 'Balance unavailable',
    unavailable: 'This balance can’t be given up right now.',
    // What a refusal or a failure is called, by the reason the service gave.
    refused: Object.freeze({
        in_flight: 'A chat key is still settling. Try again in a moment.',
        unresolved_request: 'A chat is still settling. Try again in a moment.',
        lock_busy: 'Another tab is working on this balance. Close it or wait, then try again.',
        busy: 'Another step is still finishing. Try again in a moment.',
        no_locks: 'This browser can’t check whether another tab is using this balance, so it can’t be cleared here.',
        price_unknown: 'The price isn’t available right now, so this balance can’t be checked. Try again in a moment.',
        not_dust: 'This balance is now worth more than can be given up here. You can withdraw it or keep using it.',
        changed: 'This balance changed while this window was open. Close it and try again.',
        claimed: 'This balance expired and was claimed, so there is nothing to give up. Use Start a new balance instead.',
        no_note: 'This balance is already cleared. Reload to continue.',
        open_withdrawal: 'A withdrawal of this balance is in progress. Finish it first.',
        pending_deposit: 'A deposit is still in progress. Finish it first.',
        exit_lock: 'This balance is frozen while a withdrawal can still go through, so it can’t be given up right now.',
        not_applicable: 'This balance can’t be given up here.',
        disabled: 'This balance can’t be given up here.',
        unavailable: 'This balance can’t be given up right now.',
        not_available: 'This balance can’t be given up right now.',
        unknown_state: 'This page is out of date. Reload and try again.',
        reload_required: 'This page is out of date. Reload and try again.',
        config_mismatch: 'This page is out of date. Reload and try again.',
        failed: 'The balance couldn’t be cleared. Reload to see where it stands, then try again.'
    })
});

// Reasons after which asking again can succeed. The others are final for
// this window: it shows the reason and only offers to close. `no_locks` is
// final: a browser without Web Locks stays without them, so the same request
// can only be refused the same way.
const RETRYABLE = new Set(['busy', 'in_flight', 'unresolved_request', 'lock_busy', 'price_unknown', 'failed']);

// How long a close that arrives while the service is still working waits for
// its answer before the result says the outcome is not known.
const SETTLE_GRACE_MS = 3000;

const AMOUNT = /^(?:0|[1-9][0-9]{0,19})$/;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fill(template, tokens) {
    const kept = template.replace(/\{\?(\w+)\}([\s\S]*?)\{\/\1\}/g, (match, name, inner) => (tokens[name] ? inner : ''));
    return kept.replace(/\{(\w+)\}/g, (match, name) => (tokens[name] ? tokens[name] : '')).replace(/\s{2,}/g, ' ').trim();
}

// The words of a refusal: the table's, else the generic failure. The reason
// is a machine word the service chose; it is never printed.
export function abandonRefusalWords(why) {
    if (why === 'price_unknown') return versionCopyText('abandon.dustNoPrice') || ABANDON_WORDS.refused.price_unknown;
    if (typeof why === 'string' && hasOwn(ABANDON_WORDS.refused, why)) return ABANDON_WORDS.refused[why];
    return ABANDON_WORDS.refused.failed;
}

// Whether asking again can change the answer. A reason this table does not
// know reads as a failure ('failed'), which can be asked again: the service
// checks everything afresh on every request, so asking is never unsafe.
function canAskAgain(why) {
    if (typeof why === 'string' && hasOwn(ABANDON_WORDS.refused, why)) return RETRYABLE.has(why);
    return true;
}

// The preview, re-read and reduced to what the dialog uses; null when it is
// not one the dialog may act on.
function readPreview(value) {
    if (!isRecord(value)) return null;
    if (value.kind !== 'zero' && value.kind !== 'dust') return null;
    if (!Number.isSafeInteger(value.noteId) || value.noteId < 0) return null;
    const balanceUnits = typeof value.balanceUnits === 'number' && Number.isSafeInteger(value.balanceUnits) && value.balanceUnits >= 0
        ? String(value.balanceUnits) : value.balanceUnits;
    if (typeof balanceUnits !== 'string' || !AMOUNT.test(balanceUnits)) return null;
    if (value.kind === 'zero' && BigInt(balanceUnits) !== 0n) return null;
    if (value.kind === 'dust' && BigInt(balanceUnits) === 0n) return null;
    const limitUnits = typeof value.limitUnits === 'string' && AMOUNT.test(value.limitUnits) ? value.limitUnits : null;
    const micros = number => (Number.isSafeInteger(number) && number >= 0 ? number : null);
    const label = text => (typeof text === 'string' ? text.trim() : '');
    return {
        kind: value.kind,
        noteId: value.noteId,
        balanceUnits,
        limitUnits,
        balanceUsdMicros: micros(value.balanceUsdMicros),
        limitUsdMicros: micros(value.limitUsdMicros),
        currentLabel: label(value.currentLabel),
        targetLabel: label(value.targetLabel)
    };
}

// "$0.42 (0.00014 ETH)", or "0.00014 ETH" without a price. Ether is always
// there: it is the amount the balance is held in.
function money(usdMicros, units) {
    const eth = formatEthUnits(units);
    const usd = usdMicros === null ? '' : formatUsdMicros(usdMicros);
    return {
        usd,
        eth: eth ? `${eth} ETH` : '',
        both: usd && eth ? `${usd} (${eth} ETH)` : (usd || (eth ? `${eth} ETH` : ''))
    };
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function bodyHtml(preview) {
    const balance = money(preview.balanceUsdMicros, preview.balanceUnits);
    const limit = preview.limitUnits === null ? null : money(preview.limitUsdMicros, preview.limitUnits);
    const tokens = {
        F: preview.currentLabel, N: preview.targetLabel,
        amount: balance.usd, eth: balance.eth, limit: limit ? limit.both : ''
    };
    const key = preview.kind === 'zero' ? 'abandon.zero' : 'abandon.dust';
    const title = versionCopyText(preview.kind === 'zero' ? 'abandon.linkZero' : 'abandon.link');
    const confirmLabel = preview.kind === 'zero' ? title : fill(ABANDON_WORDS.confirmDust, { amount: balance.both });
    const check = preview.kind === 'dust'
        ? `<label class="zkapi-check"><input type="checkbox" data-zkapi-abandon-check />`
            + `<span>${escapeHtml(ABANDON_WORDS.understand)}</span></label>`
            + `<p id="zkapi-abandon-hint" class="zkapi-sheet-hint" data-zkapi-abandon-hint>${escapeHtml(ABANDON_WORDS.checkHint)}</p>`
        : '';
    return `<div class="zkapi-sheet-body" data-zkapi-abandon-kind="${preview.kind}">`
        + `<h2 id="zkapi-abandon-title" class="zkapi-sheet-title" tabindex="-1">${escapeHtml(title)}</h2>`
        + `<p id="zkapi-abandon-intro" class="zkapi-note" data-zkapi-abandon-intro>${versionCopy(key, tokens)}</p>`
        + `<p class="zkapi-note">${versionCopy('abandon.chain')}</p>`
        + `<p class="zkapi-note zkapi-note--attention">${versionCopy('abandon.irreversible')}</p>`
        + check
        + '<p id="zkapi-abandon-status" class="zkapi-sheet-status" role="status" data-zkapi-abandon-status></p>'
        + '<div class="zkapi-sheet-actions" data-zkapi-abandon-actions>'
        + `<button type="button" class="zkapi-quiet-button" data-zkapi-abandon-action="cancel">${escapeHtml(ABANDON_WORDS.cancel)}</button>`
        + `<button type="button" class="zkapi-primary-button" data-zkapi-abandon-action="confirm"`
        + `${preview.kind === 'dust' ? ' disabled aria-describedby="zkapi-abandon-hint"' : ''}>${escapeHtml(confirmLabel)}</button>`
        + '</div></div>';
}

function unavailableHtml() {
    return '<div class="zkapi-sheet-body" data-zkapi-abandon-kind="unavailable">'
        + `<h2 id="zkapi-abandon-title" class="zkapi-sheet-title" tabindex="-1">${escapeHtml(ABANDON_WORDS.unavailableTitle)}</h2>`
        + `<p id="zkapi-abandon-intro" class="zkapi-note">${escapeHtml(ABANDON_WORDS.unavailable)}</p>`
        + '<div class="zkapi-sheet-actions">'
        + `<button type="button" class="zkapi-primary-button" data-zkapi-abandon-action="close">${escapeHtml(ABANDON_WORDS.close)}</button>`
        + '</div></div>';
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

const open = new WeakMap();

/**
 * Open the give-up dialog.
 *
 * @param {object} options
 * @param {object|null} options.preview  `facade.abandonPreview()`: `{kind:
 *   'zero'|'dust', noteId, balanceUnits, limitUnits, balanceUsdMicros,
 *   limitUsdMicros, expiryMs, currentLabel, targetLabel}`. Null or a preview
 *   the dialog can not act on opens an explanation with only "Close"
 * @param {(args: {noteId: number, balanceUnits: string}) => Promise<{done: boolean,
 *   kind?: string, why?: string}>} options.giveUp  the facade's `giveUpBalance`
 * @param {() => void} [options.reload]  what "Reload" does after a success
 * @param {Document} [options.doc]
 * @param {(fn: Function, ms: number) => any} [options.setTimer]
 * @param {(handle: any) => void} [options.clearTimer]
 * @returns {{close: () => void, result: Promise<{done: boolean, kind: string|null, why: string|null}>}}
 *   `result` settles once, when the dialog is gone: `done` is true only when
 *   the service reported the balance given up.
 */
export function openAbandonDialog(options = {}) {
    const {
        preview: given, giveUp, reload, doc = globalThis.document,
        setTimer = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimer = handle => globalThis.clearTimeout(handle)
    } = options;
    if (!doc || typeof doc.createElement !== 'function' || !doc.body) {
        return { close() {}, result: Promise.resolve({ done: false, kind: null, why: 'unavailable' }) };
    }
    const existing = open.get(doc);
    if (existing) return existing;

    const preview = typeof giveUp === 'function' ? readPreview(given) : null;
    const dialog = doc.createElement('dialog');
    dialog.className = 'zkapi-sheet';
    dialog.setAttribute('aria-labelledby', 'zkapi-abandon-title');
    dialog.setAttribute('aria-describedby', 'zkapi-abandon-intro');
    dialog.setAttribute('data-zkapi-abandon-dialog', '');

    let phase = preview ? 'confirm' : 'unavailable';   // confirm | working | done | refused | unavailable
    let outcome = { done: false, kind: null, why: preview ? null : 'unavailable' };
    let closed = false;
    let working = null;              // the service's answer while it is pending
    let resolveResult;
    const result = new Promise(resolve => { resolveResult = resolve; });
    const previousFocus = doc.activeElement;

    const find = selector => dialog.querySelector(selector);
    const status = text => {
        const element = find('[data-zkapi-abandon-status]');
        if (element) element.textContent = text;
    };
    const control = action => find(`[data-zkapi-abandon-action="${action}"]`);
    const focus = element => {
        if (element && typeof element.focus === 'function') element.focus();
    };

    function syncConfirm() {
        const confirm = control('confirm');
        if (!confirm) return;
        const check = find('[data-zkapi-abandon-check]');
        const needsCheck = preview && preview.kind === 'dust';
        const ready = phase === 'confirm' && (!needsCheck || Boolean(check && check.checked));
        confirm.disabled = !ready;
        if (check) check.disabled = phase !== 'confirm';
        const hint = find('[data-zkapi-abandon-hint]');
        if (hint) hint.textContent = needsCheck && phase === 'confirm' && !ready ? ABANDON_WORDS.checkHint : '';
    }

    function finish() {
        if (closed) return;
        closed = true;
        open.delete(doc);
        try {
            if (dialog.open !== false && typeof dialog.close === 'function') dialog.close();
        } catch { /* already closed */ }
        dialog.innerHTML = '';
        if (typeof dialog.remove === 'function') dialog.remove();
        if (previousFocus && previousFocus.isConnected !== false && typeof previousFocus.focus === 'function') {
            previousFocus.focus();
        }
        if (!working) {
            resolveResult(outcome);
            return;
        }
        // Closed while the service was still working: what it answers is what
        // the caller should learn, so wait for it a moment. Without an answer
        // the outcome is reported as not known, never as "done".
        let settled = false;
        let timer = null;
        const settle = () => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimer(timer);
            resolveResult(outcome);
        };
        working.then(settle, settle);
        timer = setTimer(() => {
            if (!outcome.done) outcome = { done: false, kind: null, why: 'pending' };
            settle();
        }, SETTLE_GRACE_MS);
    }

    async function confirm() {
        if (phase !== 'confirm' || closed || !preview) return;
        const check = find('[data-zkapi-abandon-check]');
        if (preview.kind === 'dust' && !(check && check.checked)) return;
        phase = 'working';
        status(ABANDON_WORDS.working);
        syncConfirm();
        let answer;
        const asked = (async () => {
            try {
                answer = await giveUp({ noteId: preview.noteId, balanceUnits: preview.balanceUnits });
            } catch {
                answer = { done: false, why: 'failed' };
            }
            working = null;
            if (closed) {
                outcome = isRecord(answer) && answer.done === true
                    ? { done: true, kind: preview.kind, why: null }
                    : { done: false, kind: null, why: isRecord(answer) && typeof answer.why === 'string' ? answer.why : 'failed' };
            }
        })();
        working = asked;
        await asked;
        if (closed) return;
        if (isRecord(answer) && answer.done === true) {
            phase = 'done';
            outcome = { done: true, kind: preview.kind, why: null };
            showDone();
            return;
        }
        const why = isRecord(answer) && typeof answer.why === 'string' ? answer.why : 'failed';
        outcome = { done: false, kind: null, why };
        status(abandonRefusalWords(why));
        if (canAskAgain(why)) {
            phase = 'confirm';
            syncConfirm();
            focus(control('confirm'));
        } else {
            phase = 'refused';
            showFinal();
        }
    }

    // After a refusal that asking again can not change: only "Close".
    function showFinal() {
        const confirmButton = control('confirm');
        const cancelButton = control('cancel');
        if (confirmButton && typeof confirmButton.remove === 'function') confirmButton.remove();
        if (cancelButton) {
            cancelButton.textContent = ABANDON_WORDS.close;
            cancelButton.className = 'zkapi-primary-button';
            focus(cancelButton);
        }
        const check = find('[data-zkapi-abandon-check]');
        if (check) check.disabled = true;
    }

    function showDone() {
        const version = preview.targetLabel ? preview.targetLabel.replace(/^\s*version\s+/i, '').trim() : '';
        const first = preview.kind === 'zero' ? ABANDON_WORDS.doneZero : ABANDON_WORDS.doneDust;
        // The question has been answered: what it offered ("you can give it
        // up, or withdraw it instead") is no longer true to read, so the
        // heading and the status say what happened and the dialog is
        // described by that.
        const title = find('#zkapi-abandon-title');
        if (title) title.textContent = preview.kind === 'zero' ? ABANDON_WORDS.doneTitleZero : ABANDON_WORDS.doneTitleDust;
        const intro = find('[data-zkapi-abandon-intro]');
        if (intro && typeof intro.remove === 'function') intro.remove();
        dialog.setAttribute('aria-describedby', 'zkapi-abandon-status');
        status(`${first} ${fill(ABANDON_WORDS.doneReload, { version })}`);
        const actions = find('[data-zkapi-abandon-actions]');
        if (actions) {
            actions.innerHTML = `<button type="button" class="zkapi-quiet-button" data-zkapi-abandon-action="close">${escapeHtml(ABANDON_WORDS.close)}</button>`
                + `<button type="button" class="zkapi-primary-button" data-zkapi-abandon-action="reload">${escapeHtml(ABANDON_WORDS.reload)}</button>`;
            wireActions();
        }
        const check = find('[data-zkapi-abandon-check]');
        const hint = find('[data-zkapi-abandon-hint]');
        if (check && typeof check.remove === 'function') {
            const label = typeof check.closest === 'function' ? check.closest('label') : null;
            (label || check).remove();
        }
        if (hint && typeof hint.remove === 'function') hint.remove();
        focus(control('reload'));
    }

    function doReload() {
        const run = typeof reload === 'function' ? reload : () => globalThis.location?.reload?.();
        finish();
        try {
            run();
        } catch { /* a reload that fails leaves the page as it is */ }
    }

    function wireActions() {
        const bind = (action, handler) => {
            const element = control(action);
            if (element) element.addEventListener('click', handler);
        };
        bind('confirm', () => { void confirm(); });
        bind('cancel', finish);
        bind('close', finish);
        bind('reload', doReload);
    }

    dialog.innerHTML = preview ? bodyHtml(preview) : unavailableHtml();
    wireActions();
    const check = find('[data-zkapi-abandon-check]');
    if (check) {
        check.addEventListener('change', syncConfirm);
        check.addEventListener('click', syncConfirm);
    }
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        finish();
    });
    dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') event.stopPropagation();
    });

    doc.body.append(dialog);
    try {
        dialog.showModal();
    } catch {
        dialog.setAttribute('open', '');
    }
    focus(find('#zkapi-abandon-title'));

    const handle = { close: finish, result };
    open.set(doc, handle);
    return handle;
}
