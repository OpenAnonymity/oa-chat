// One short Sources reveal per transcript. Own the scroll frames so a gesture,
// collapse or chat switch cancels without native smooth-scroll work left queued.
const pending = new WeakMap();

export function cancelSourceReveal(scroller) {
    pending.get(scroller)?.();
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
    const from = scroller.scrollTop;
    const finish = () => {
        view.cancelAnimationFrame(frame);
        events.forEach(type => scroller.removeEventListener(type, finish));
        pending.delete(scroller);
    };
    const step = now => {
        if (!scroller.isConnected || !panel.isConnected || !isCurrent() || panel.classList.contains('hidden')) {
            finish();
            return;
        }
        const progress = Math.min(1, Math.max(0, (now - started) / 250));
        const eased = 1 - (1 - progress) ** 3;
        const end = Math.min(target, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTo({ top: from + (end - from) * eased, behavior: 'instant' });
        if (progress < 1) frame = view.requestAnimationFrame(step);
        else finish();
    };
    pending.set(scroller, finish);
    events.forEach(type => scroller.addEventListener(type, finish, { passive: true }));
    frame = view.requestAnimationFrame(step);
}
