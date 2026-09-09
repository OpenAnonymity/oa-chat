const HELP = {
    billing: {
        label: 'How private billing works',
        title: 'How private billing works',
        text: 'Your deposit creates a private prepaid balance. The model list shows each model’s temporary-key spending cap and minimum balance. Your device proves you have at least that amount without revealing your exact balance. The cap covers all usage on that key; it is not a fee. When the key closes, verified usage is deducted and unused funds remain in your balance. Your wallet address is not attached to model requests.'
    },
    expiry: {
        label: 'What happens when my private balance expires?',
        title: 'Withdraw before this deadline',
        text: 'This deadline belongs to your private balance, not a temporary chat key. Expiry does not automatically refund funds. Withdraw before the deadline to return unused funds to an address you choose; used funds go to the service. After the deadline, the service treasury can claim the full original deposit.'
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

export function privateBalanceHelpContent(scope, kind, open = false) {
    const help = HELP[kind];
    return `<div id="zkapi-${scope}-${kind}-help" data-zkapi-help-content="${kind}" ${open ? '' : 'hidden'}>
        <div class="mt-2 rounded-lg border border-border bg-muted/5 p-2 text-[10px] leading-relaxed text-muted-foreground">
            <p class="font-medium text-foreground">${help.title}</p><p class="mt-1">${help.text}</p>
        </div>
    </div>`;
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
            content.hidden = !state[kind];
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
