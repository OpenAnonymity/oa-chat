const HELP = {
    billing: {
        label: 'How private billing works',
        title: 'How private billing works',
        text: 'Your deposit becomes a private prepaid balance. Each chat gets a temporary key with a spending cap; your device proves the balance covers it without revealing the amount. Only verified usage is deducted, and your wallet address never reaches a model request.'
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

/** The billing explanation as a disclosure among the dialog's guides,
 *  where "Set up your wallet" and "Payment history" live — not a card
 *  above the deposit. Open state is the owner's, so re-renders keep it. */
export function privateBalanceGuide(kind, open = false) {
    const help = HELP[kind];
    return `<details data-zkapi-help-guide="${kind}" class="zkapi-guide zkapi-guide-details" ${open ? 'open' : ''}>
        <summary class="zkapi-guide-trigger">${help.label}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
        <div class="zkapi-guide-body"><p class="zkapi-guide-lead">${help.text}</p></div>
    </details>`;
}

export function attachPrivateBalanceHelp(root, owner) {
    for (const guide of root?.querySelectorAll?.('[data-zkapi-help-guide]') || []) {
        guide.addEventListener('toggle', () => {
            const state = owner.privateBalanceHelpOpen ||= {};
            state[guide.dataset.zkapiHelpGuide] = guide.open;
        });
    }
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
