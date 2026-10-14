import { fundingDisclosure } from './FundingDisclosures.js';
import { setDisclosure } from '../../ui/uiMotion.js';
import { copyTokens, versionCopy } from '../versioning/copy.mjs';
const HELP = {
    billing: {
        label: 'How private billing works',
        title: 'How private billing works',
        text: 'No account or Google sign-in is required to fund your wallet or chat with zkAPI. Your deposit becomes a private prepaid balance. Each chat gets a temporary key with a spending cap; your device proves the balance covers it without revealing the amount. Only verified usage is deducted, and your wallet address never reaches a model request.'
    },
    expiry: {
        label: 'What happens when my private balance expires?',
        title: 'Withdraw before this deadline',
        text: 'This deadline belongs to your private balance, not a temporary chat key. Expiry does not automatically refund funds. Withdraw before the deadline to return unused funds to an address you choose; used funds go to the service. After the deadline, the service treasury can claim the full original deposit.'
    },
    // Only offered where a build carries more than one protocol version. The
    // text here is what is true of every such build; the one that names the
    // person's own version comes from versionHelpDetail (below).
    version: {
        label: 'About versions',
        title: 'About versions',
        text: 'Your balance stays on the version it was deposited into. New deposits go to the latest version, and a balance can’t move between versions.'
    }
};

/**
 * The state-aware text of the `version` help: the version the balance is on,
 * and, when a newer one takes deposits, what upgrading means. `body` is HTML
 * made safe by the copy table. Without a state it is the build-wide text.
 *
 * @param {object|null} state VersionState
 * @param {{table?: object[]}} [options]
 * @returns {{title: string, body: string}}
 */
export function versionHelpDetail(state, options = {}) {
    const title = versionCopy('help.title') || HELP.version.title;
    if (!state || typeof state !== 'object' || !state.current) return { title, body: HELP.version.text };
    const newer = state.target && state.target.id !== state.current.id;
    const body = versionCopy(newer ? 'help.previous' : 'help.current', copyTokens(state, options));
    return { title, body: body || HELP.version.text };
}

export function privateBalanceExpiryLabel(client, expiry) {
    const remaining = client.formatExpiry(expiry);
    return remaining === 'expired' ? 'expired' : `expires in ${remaining}`;
}

export function privateBalanceExpired(note, now = Date.now()) {
    const expiry = Number(note?.expiry_ts);
    return Number.isFinite(expiry) && expiry > 0 && now >= expiry * 1000;
}

export function updatePrivateBalanceExpiryState(root, note, now = Date.now()) {
    if (!root?.querySelector || !note) return;
    const expired = privateBalanceExpired(note, now);
    const badge = root.querySelector('[data-private-balance-readiness]');
    if (badge) {
        badge.textContent = expired ? 'expired' : 'ready';
        badge.classList.toggle('badge-status-success', !expired);
        for (const name of ['bg-amber-100', 'text-amber-800', 'dark:bg-amber-500/15', 'dark:text-amber-200']) {
            badge.classList.toggle(name, expired);
        }
    }
    const notice = root.querySelector('[data-private-balance-expired-notice]');
    if (notice && notice.hidden !== !expired) notice.hidden = !expired;
}

export function privateBalanceHelpButton(scope, kind, open = false) {
    const help = HELP[kind];
    return `<button id="zkapi-${scope}-${kind}-help-toggle" data-zkapi-help="${kind}" type="button"
        class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border border-border text-[9px] text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="${help.label}" title="${help.label}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="zkapi-${scope}-${kind}-help">?</button>`;
}

// `detail` ({title, body}) replaces the static text of a kind whose words
// depend on state (`version`). Both parts are trusted HTML, already escaped by
// the copy table; a caller never passes operator text here.
export function privateBalanceHelpContent(scope, kind, open = false, detail = null) {
    const help = HELP[kind];
    const title = typeof detail?.title === 'string' && detail.title ? detail.title : help.title;
    const text = typeof detail?.body === 'string' && detail.body ? detail.body : help.text;
    return `<div id="zkapi-${scope}-${kind}-help" data-zkapi-help-content="${kind}" ${open ? '' : 'hidden'}>
        <div class="mt-2 rounded-lg border border-border bg-muted/5 p-2 text-[10px] leading-relaxed text-muted-foreground">
            <p class="font-medium text-foreground">${title}</p><p class="mt-1">${text}</p>
        </div>
    </div>`;
}

/** The billing explanation as a disclosure among the dialog's guides,
 *  where "Set up your wallet" and "Payment history" live — not a card
 *  above the deposit. Open state is the owner's, so re-renders keep it. */
export function privateBalanceGuide(kind, open = false) {
    const help = HELP[kind];
    const text = kind === 'billing'
        ? 'No account or Google sign-in is required to fund your wallet or chat with zkAPI. Your deposit funds a private prepaid balance that is charged only for verified usage, while your wallet address stays separate from the requests sent to models.'
        : help.text;
    return fundingDisclosure({ key: kind, label: help.label, open,
        attributes: `data-zkapi-help-guide="${kind}"`, body: `<p class="zkapi-guide-lead">${text}</p>` });
}

export function attachPrivateBalanceHelp(root, owner) {
    if (!root?.querySelectorAll) return;
    for (const button of root.querySelectorAll('[data-zkapi-help]')) {
        button.addEventListener('click', () => {
            const kind = button.dataset.zkapiHelp;
            if (!HELP[kind]) return;
            const content = root.querySelector(`[data-zkapi-help-content="${kind}"]`);
            if (!content) return;
            const state = owner.privateBalanceHelpOpen ||= {};
            state[kind] = !state[kind];
            setDisclosure(content, state[kind]);
            button.setAttribute('aria-expanded', String(state[kind]));
        });
    }
}

export function capturePrivateBalanceHelpFocus(root) {
    const active = document.activeElement;
    return active?.dataset?.zkapiHelp && root?.contains?.(active) ? active.id : null;
}

export function restorePrivateBalanceHelpFocus(root, id) {
    if (id) root?.querySelector?.(`#${id}`)?.focus?.({ preventScroll: true });
}
