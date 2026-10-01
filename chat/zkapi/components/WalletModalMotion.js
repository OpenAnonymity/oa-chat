// Presentation only. A one-shot Add ETH intent survives a deferred/background
// render, but never a close, changed fee scope, or the person's own navigation.
export function revealWithdrawalTopUp(owner, layoutAnimation) {
    owner.cancelTopUpMotion?.();
    const request = owner.withdrawalTopUpReveal;
    if (!request) return;
    const root = owner.overlay;
    const panel = root?.querySelector?.('.zkapi-fee-topup');
    const scroller = root?.querySelector?.('[data-funding-scroll]');
    const current = () => owner.isOpen && owner.view === 'withdraw'
        && owner.withdrawalTopUpReveal === request
        && owner.withdrawalFees?.scope === request.scope
        && owner.withdrawalFeeTopUp === request.scope
        && root.querySelector('.zkapi-fee-topup') === panel;
    if (!panel || !scroller || !current()) {
        owner.withdrawalTopUpReveal = null;
        return;
    }
    const view = panel.ownerDocument?.defaultView;
    const reduced = view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let canceled = false;
    let cancel;
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    const cleanup = () => {
        events.forEach(type => scroller.removeEventListener?.(type, interrupt));
        if (owner.cancelTopUpMotion === cancel) owner.cancelTopUpMotion = null;
    };
    const interrupt = () => {
        canceled = true;
        if (owner.withdrawalTopUpReveal === request) owner.withdrawalTopUpReveal = null;
        cleanup();
    };
    cancel = () => { canceled = true; cleanup(); };
    owner.cancelTopUpMotion = cancel;
    events.forEach(type => scroller.addEventListener?.(type, interrupt, { passive: true }));

    if (!request.started) {
        request.started = true;
        if (!reduced && panel.style && panel.dataset) {
            panel.style.transition = 'none';
            panel.dataset.open = 'false';
            void panel.offsetWidth;
            panel.style.transition = '';
            panel.dataset.open = 'true';
        }
        // The Add ETH trigger is removed. Keep keyboard users in the newly
        // opened section, without the browser jumping its scroll position.
        panel.querySelector?.('[data-withdrawal-fee-copy]')?.focus?.({ preventScroll: true });
    }
    Promise.resolve(layoutAnimation?.finished).then(() => {
        cleanup();
        if (canceled || !current()) return;
        owner.withdrawalTopUpReveal = null;
        const viewport = scroller.getBoundingClientRect();
        const bounds = panel.getBoundingClientRect();
        const top = viewport.top + 8;
        const bottom = viewport.bottom - 8;
        // Reveal only the missing part. For a section taller than the viewport,
        // show its amount first, rather than jumping past it to the buttons.
        const delta = bounds.height > bottom - top || bounds.top < top
            ? bounds.top - top : Math.max(0, bounds.bottom - bottom);
        if (Math.abs(delta) < 1) return;
        const target = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + delta));
        scroller.scrollTo?.({ top: target, behavior: reduced ? 'instant' : 'smooth' });
    }).catch(() => { cleanup(); });
}
