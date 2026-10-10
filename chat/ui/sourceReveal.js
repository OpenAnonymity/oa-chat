// One explicit Sources reveal per transcript. Native smooth scrolling owns the
// motion; the guard only cancels stale work or yields to the reader's input.
const pending = new WeakMap();

export function cancelSourceReveal(scroller) {
    pending.get(scroller)?.(true);
}

export function isSourceRevealActive(scroller) {
    return pending.has(scroller);
}

export function revealSources({ scroller, panel, trigger, toolbar, composer, isCurrent = () => true }) {
    cancelSourceReveal(scroller);
    const view = scroller?.ownerDocument?.defaultView;
    if (!view || !panel?.isConnected || !trigger?.isConnected) return;
    const bounds = scroller.getBoundingClientRect();
    const panelBounds = panel.getBoundingClientRect();
    const overlaps = rect => rect && rect.height > 0 && rect.right > bounds.left && rect.left < bounds.right;
    const toolbarBounds = toolbar?.getBoundingClientRect();
    const composerBounds = composer?.getBoundingClientRect();
    const viewport = view.visualViewport;
    const top = Math.max(bounds.top + scroller.clientTop,
        overlaps(toolbarBounds) ? toolbarBounds.bottom : bounds.top) + 12;
    const bottom = Math.min(bounds.top + scroller.clientTop + scroller.clientHeight,
        viewport ? viewport.offsetTop + viewport.height : view.innerHeight,
        overlaps(composerBounds) ? composerBounds.top : bounds.bottom) - 12;
    if (bottom <= top) return;
    // Show all cards if they fit; keep the Sources trigger visible for a tall
    // disclosure. Never scroll upward or move an already visible source list.
    const distance = Math.min(panelBounds.bottom - bottom, trigger.getBoundingClientRect().top - top);
    const target = Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + Math.max(0, distance));
    if (target <= scroller.scrollTop + 1) return;
    if (view.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        scroller.scrollTo({ top: target, behavior: 'instant' });
        return;
    }

    let frame;
    const started = view.performance.now();
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    const finish = (interrupt = false) => {
        view.cancelAnimationFrame(frame);
        events.forEach(type => scroller.removeEventListener(type, interruptScroll));
        pending.delete(scroller);
        if (interrupt) scroller.scrollTo({ top: scroller.scrollTop, behavior: 'instant' });
    };
    const interruptScroll = () => finish(true);
    const check = now => {
        // Do not stop a newer chat's own scroll when this panel was replaced.
        if (!scroller.isConnected || !isCurrent()) return finish();
        if (!panel.isConnected) return finish(true);
        if (panel.classList.contains('hidden')) return finish(true);
        const end = Math.min(target, scroller.scrollHeight - scroller.clientHeight);
        if (Math.abs(scroller.scrollTop - end) <= 1) return finish();
        if (now - started >= 1500) return finish(true);
        frame = view.requestAnimationFrame(check);
    };
    pending.set(scroller, finish);
    events.forEach(type => scroller.addEventListener(type, interruptScroll, { passive: true }));
    scroller.scrollTo({ top: target, behavior: 'smooth' });
    frame = view.requestAnimationFrame(check);
}
