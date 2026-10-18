// Activation status and optional clearing of an empty or dust balance.
// No export controls: browser recovery remains in the existing wallet journal.
import { escapeHtml, versionCopyText } from '../versioning/copy.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function actionButton(action, label, { disabled = false, kind = 'quiet' } = {}) {
    return `<button type="button" class="zkapi-${kind}-button zkapi-extras-action" data-zkapi-version-action="${action}"`
        + `${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
}

/**
 * The balance card's extras, or '' when there is nothing to say.
 *
 * @param {object} state VersionState
 * @param {{busy?: boolean}} [ctx]
 *   `busy`: the dialog is working, so the buttons are disabled.
 * @returns {string}
 */
export function renderBalanceExtras(state, ctx = {}) {
    if (!isRecord(state)) return '';
    if (isRecord(state.held) && state.held.unreachable === true) return '';
    const busy = ctx.busy === true;
    const reloadFirst = state.phase === 'reload-required' || state.reload?.required === true;
    const rows = [];

    if (state.activation?.status === 'activating') {
        const text = state.activation.paused
            ? 'Your deposit is confirmed. Activation is paused by the vault owner; private chats must wait.'
            : 'Your deposit is confirmed and waiting for activation. Private chats will become available automatically; you can withdraw before activation.';
        rows.push(`<p class="zkapi-note zkapi-extras-note" data-zkapi-activation>${escapeHtml(text)}</p>`);
    } else if (state.activation?.status === 'unknown') {
        rows.push('<p class="zkapi-note zkapi-extras-note" data-zkapi-activation>Checking whether this balance is ready for private chats…</p>');
    }

    const abandon = isRecord(state.abandon) ? state.abandon : null;
    if (abandon && abandon.available === true && (abandon.kind === 'zero' || abandon.kind === 'dust') && !reloadFirst) {
        const label = versionCopyText(abandon.kind === 'zero' ? 'abandon.linkZero' : 'abandon.link');
        if (label) rows.push(`<div class="zkapi-extras-row zkapi-extras-row--link" data-zkapi-abandon-row>${actionButton('abandon-open', label, { disabled: busy })}</div>`);
    }

    if (!rows.length) return '';
    return `<div class="zkapi-balance-extras" data-zkapi-balance-extras>${rows.join('')}</div>`;
}
