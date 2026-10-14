// What sits under a balance card besides the balance: the exit kit's status
// and the way to give up an empty or very small balance on a version that no
// longer takes deposits (docs/ZKAPI_VERSIONING.md, section 7, "Upgrade UX").
//
// A pure string renderer over a VersionState: no DOM, no storage, no clock,
// no facade. The balance dialog places the markup (`ui.balanceExtras()`); the
// buttons carry `data-zkapi-version-action` hooks that the dialog's existing
// version-action wiring turns into `ui.act` calls, so this module never binds
// a click itself.
//
// The exit kit row is a quiet status, never a nag. The SDK counts a kit as out
// of date after every settled chat, so a stale kit is one line with a one-click
// way to create a new one. Only a balance that has never had a kit and a kit
// that was created and not saved are said in full (and by the banner too).
//
// What the row can claim is only what the SDK recorded: a kit was CREATED at
// the balance's latest state. It is not proof that a file exists (the SDK marks
// a kit as created before the browser delivers it, and the page forgets that
// the file was never saved when it reloads), so the row never says "saved" or
// "up to date".
//
// Nothing here is shown for a balance this browser can not exit (a copy that
// another device used since: a kit made here would be an older state), for a
// balance that is about to be cleared, while the page must reload first, or
// for a balance the page holds and can not read (`state.held`: the SDK did
// not start, so a kit cannot be made and nothing can be given up).
//
// DOM hooks: [data-zkapi-balance-extras] (the container),
// [data-zkapi-kit-row] with data-kit-state="never|unsaved|stale|current",
// [data-zkapi-version-action="export-exit-kit"],
// [data-zkapi-version-action="abandon-open"], [data-zkapi-exit-rpc].
import { escapeHtml, versionCopy, versionCopyText } from '../versioning/copy.mjs';

export const BALANCE_EXTRAS_WORDS = Object.freeze({
    kitLabel: 'Exit kit',
    never: 'Not created yet',
    current: 'Created for this balance',
    create: 'Create exit kit',
    createNew: 'Create a new exit kit'
});

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The state of the exit kit, or null when no row is called for.
function kitStateOf(state) {
    const exit = isRecord(state.exit) ? state.exit : null;
    if (!exit || !isRecord(exit.kit)) return null;
    if (exit.deviceNotNewest === true) return null;
    if (exit.kit.unsaved === true) return 'unsaved';
    if (exit.kit.exported !== true) return 'never';
    return exit.kit.outOfDate === true ? 'stale' : 'current';
}

function actionButton(action, label, { disabled = false, kind = 'quiet' } = {}) {
    return `<button type="button" class="zkapi-${kind}-button zkapi-extras-action" data-zkapi-version-action="${action}"`
        + `${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
}

/**
 * The balance card's extras, or '' when there is nothing to say.
 *
 * @param {object} state VersionState
 * @param {{busy?: boolean, canExport?: boolean}} [ctx]
 *   `busy`: the dialog is working, so the buttons are disabled.
 *   `canExport: false`: this page's client can not make a kit (the exit kit
 *   row is left out).
 * @returns {string}
 */
export function renderBalanceExtras(state, ctx = {}) {
    if (!isRecord(state)) return '';
    if (isRecord(state.held) && state.held.unreachable === true) return '';
    const busy = ctx.busy === true;
    const reloadFirst = state.phase === 'reload-required' || state.reload?.required === true;
    const rows = [];

    const kit = ctx.canExport === false || reloadFirst || state.abandon?.available === true ? null : kitStateOf(state);
    if (kit !== null) {
        // The two states that need a sentence name the kit themselves; the
        // two that are one word take the row's label.
        const sentence = kit === 'unsaved' ? versionCopy('kit.unsaved') : kit === 'stale' ? versionCopy('kit.stale') : '';
        const word = kit === 'never' ? BALANCE_EXTRAS_WORDS.never : BALANCE_EXTRAS_WORDS.current;
        const text = sentence
            ? `<span class="zkapi-extras-value" data-zkapi-kit-state-text>${sentence}</span>`
            : `<span class="zkapi-extras-label">${escapeHtml(BALANCE_EXTRAS_WORDS.kitLabel)}</span>`
                + `<span class="zkapi-extras-value" data-zkapi-kit-state-text>${escapeHtml(word)}</span>`;
        const label = kit === 'never' || kit === 'unsaved' ? BALANCE_EXTRAS_WORDS.create : BALANCE_EXTRAS_WORDS.createNew;
        rows.push(`<div class="zkapi-extras-row" data-zkapi-kit-row data-kit-state="${kit}">`
            + `<p class="zkapi-extras-text">${text}</p>`
            + `${actionButton('export-exit-kit', label, { disabled: busy })}</div>`);
        const exit = state.exit;
        if (isRecord(exit.rpc) && (exit.rpc.recommended === true || exit.rpc.wrongChain === true)) {
            rows.push(`<p class="zkapi-note zkapi-extras-note" data-zkapi-exit-rpc>${versionCopy('exit.rpc')}</p>`);
        }
    }

    const abandon = isRecord(state.abandon) ? state.abandon : null;
    if (abandon && abandon.available === true && (abandon.kind === 'zero' || abandon.kind === 'dust') && !reloadFirst) {
        const label = versionCopyText(abandon.kind === 'zero' ? 'abandon.linkZero' : 'abandon.link');
        if (label) rows.push(`<div class="zkapi-extras-row zkapi-extras-row--link" data-zkapi-abandon-row>${actionButton('abandon-open', label, { disabled: busy })}</div>`);
    }

    if (!rows.length) return '';
    return `<div class="zkapi-balance-extras" data-zkapi-balance-extras>${rows.join('')}</div>`;
}
