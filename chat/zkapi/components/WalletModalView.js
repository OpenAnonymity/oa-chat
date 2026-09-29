// Scroll restoration waits for the first complete funding layout. Browsers
// clamp scrollTop while the temporary loading view is shorter than the saved
// view; that clamp must not overwrite the user's intended position.
export function cancelWalletModalRestore(owner) {
    owner.restoredModalView = null;
}

export function attachWalletModalRestoreCancellation(owner) {
    const cancel = () => cancelWalletModalRestore(owner);
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'input']) {
        owner.overlay?.addEventListener?.(type, cancel, { capture: true, passive: true });
    }
}

export function currentWalletModalRestore(owner, method) {
    const saved = owner.restoredModalView;
    if (!saved) return null;
    if (!owner.isOpen || (saved.view != null && saved.view !== owner.view)
        || (saved.step != null && saved.step !== owner.step)
        || (saved.method != null && saved.method !== method)) {
        cancelWalletModalRestore(owner);
        return null;
    }
    return saved;
}

export function finishWalletModalRestore(owner, { hydrating = false, method } = {}) {
    const saved = currentWalletModalRestore(owner, method);
    if (!saved) return;
    const scroller = owner.overlay?.querySelector?.('[data-funding-scroll]');
    if (scroller) scroller.scrollTop = saved.scroll;
    if (hydrating) return;
    // open() renders before showSurface(). Retry once layout becomes visible.
    const view = owner.overlay?.ownerDocument?.defaultView;
    if (scroller?.clientHeight === 0 && view?.requestAnimationFrame) {
        if (!saved.framePending) {
            saved.framePending = true;
            view.requestAnimationFrame(() => {
                saved.framePending = false;
                if (owner.restoredModalView !== saved) return;
                finishWalletModalRestore(owner, { method });
                owner.rememberRunningModal?.();
            });
        }
        return;
    }
    cancelWalletModalRestore(owner);
}
