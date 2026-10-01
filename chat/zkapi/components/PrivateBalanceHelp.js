import { fundingDisclosure } from './FundingDisclosures.js';
import { setDisclosure } from '../../ui/uiMotion.js';
const HELP = {
    billing: {
        label: 'How private billing works',
        text: 'No account or Google sign-in is required to fund your wallet or chat with zkAPI. Your deposit becomes a private prepaid balance. Each chat gets a temporary key with a spending cap; your device proves the balance covers it without revealing the amount. Only verified usage is deducted, and your wallet address never reaches a model request.'
    },
    expiry: {
        label: 'What happens when my private balance expires?',
        text: 'Withdraw your unused balance before it expires. Funds are not returned automatically. After expiry, the service can claim the full original deposit.'
    }
};

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
    const notice = root.querySelector('[data-private-balance-expired-notice]');
    if (notice && notice.hidden !== !expired) notice.hidden = !expired;
}

export function privateBalanceHelpButton(scope, kind, open = false) {
    const help = HELP[kind];
    return `<button id="zkapi-${scope}-${kind}-help-toggle" data-zkapi-help="${kind}" type="button"
        class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border border-border text-[9px] text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="${help.label}" title="${help.label}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="zkapi-${scope}-${kind}-help">?</button>`;
}

export function privateBalanceHelpContent(scope, kind, open = false) {
    const help = HELP[kind];
    return `<div id="zkapi-${scope}-${kind}-help" data-zkapi-help-content="${kind}" ${open ? '' : 'hidden'}>
        <div class="oa-panel-help mt-2">
            <p>${help.text}</p>
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
    owner.disposePrivateBalanceHelp?.();
    if (!root?.querySelectorAll) return;
    const buttons = [...root.querySelectorAll('[data-zkapi-help]')];
    const guide = root.querySelector('[data-zkapi-help-guide="billing"]');
    const doc = root.ownerDocument;
    const close = (except = null) => {
        const state = owner.privateBalanceHelpOpen ||= {};
        for (const button of buttons) {
            const kind = button.dataset.zkapiHelp;
            if (kind === except) continue;
            state[kind] = false;
            setDisclosure(root.querySelector(`[data-zkapi-help-content="${kind}"]`), false);
            button.setAttribute('aria-expanded', 'false');
        }
        if (guide && except !== 'billing') {
            state.billing = false;
            guide.dataset.open = 'false';
            guide.querySelector('.t-acc-head')?.setAttribute('aria-expanded', 'false');
            const panel = guide.querySelector('.t-acc-panel');
            if (panel) panel.inert = true;
        }
    };
    for (const button of buttons) {
        button.addEventListener('click', () => {
            const kind = button.dataset.zkapiHelp;
            if (!HELP[kind]) return;
            // The System Panel shares OA's controller, including its outside
            // click and Escape handling for key/proxy explanations.
            if (owner.togglePanelHelp) {
                owner.togglePanelHelp(kind === 'billing' ? 'zkapiBillingHelp' : 'zkapiExpiryHelp');
                return;
            }
            const content = root.querySelector(`[data-zkapi-help-content="${kind}"]`);
            if (!content) return;
            const state = owner.privateBalanceHelpOpen ||= {};
            const open = !state[kind];
            close();
            state[kind] = open;
            setDisclosure(content, open);
            button.setAttribute('aria-expanded', String(open));
        });
    }
    if (owner.togglePanelHelp || !doc?.addEventListener) return;
    const guideClick = () => { if (guide.dataset.open === 'true') close('billing'); };
    guide?.querySelector('.t-acc-head')?.addEventListener('click', guideClick);
    const outside = event => {
        if (buttons.some(button => button.contains(event.target)
            || root.querySelector(`[data-zkapi-help-content="${button.dataset.zkapiHelp}"]`)?.contains(event.target))
            || guide?.contains(event.target)) return;
        close();
    };
    const escape = event => {
        if (event.key !== 'Escape' || event.defaultPrevented || !root.contains(event.target)) return;
        const open = buttons.find(button => owner.privateBalanceHelpOpen?.[button.dataset.zkapiHelp]);
        if (!open && guide?.dataset.open !== 'true') return;
        event.preventDefault(); event.stopImmediatePropagation();
        close();
        (open || guide?.querySelector('.t-acc-head'))?.focus({ preventScroll: true });
    };
    doc.addEventListener('click', outside);
    doc.addEventListener('keydown', escape, true);
    owner.disposePrivateBalanceHelp = () => {
        doc.removeEventListener('click', outside);
        doc.removeEventListener('keydown', escape, true);
        guide?.querySelector('.t-acc-head')?.removeEventListener('click', guideClick);
    };
}

export function capturePrivateBalanceHelpFocus(root) {
    const active = document.activeElement;
    return active?.dataset?.zkapiHelp && root?.contains?.(active) ? active.id : null;
}

export function restorePrivateBalanceHelpFocus(root, id) {
    if (id) root?.querySelector?.(`#${id}`)?.focus?.({ preventScroll: true });
}
