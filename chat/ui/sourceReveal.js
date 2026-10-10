// One short Sources reveal per transcript. Own scroll frames so a gesture or
// chat switch cancels without native smooth-scroll work left queued.
const pending = new WeakMap();

export function cancelSourceReveal(scroller) {
    pending.get(scroller)?.();
}

export function isSourceRevealActive(scroller) {
    return pending.has(scroller);
}

export function isLastSourceResponse(section, messages) {
    const turns = Array.from(messages?.children || []).filter(el => el.hasAttribute('data-message-id'));
    const last = turns.at(-1);
    if (!last?.contains(section)) return false;
    // Parallel responses can share a message but sit above another lane or
    // synthesis. Compare actual content ends, not stretched grid-cell bounds.
    const lane = section.closest('.council-response-panel, .council-synthesis-block');
    if (!lane) return true;
    const end = section.getBoundingClientRect().bottom;
    return !Array.from(last.querySelectorAll('.council-response-panel, .council-synthesis-block'))
        .some(other => other !== lane && other.getClientRects().length
            && other.lastElementChild?.getBoundingClientRect().bottom > end + 1);
}

export function revealSources({ scroller, panel, trigger, toolbar, composer,
    opening = true, followBottom = false,
    bottomTarget = () => scroller.scrollHeight - scroller.clientHeight,
    isCurrent = () => true, onUpdate = () => {} }) {
    cancelSourceReveal(scroller);
    const view = scroller?.ownerDocument?.defaultView;
    if (!view || !panel?.isConnected || !trigger?.isConnected) return;
    const from = scroller.scrollTop;
    // Measure the animated edge on every frame. A target captured at the start
    // is clamped against the closed panel's height and stops short of the bottom.
    const target = () => {
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (followBottom) return Math.min(max, Math.max(0, bottomTarget()));
        const bounds = scroller.getBoundingClientRect();
        const overlaps = rect => rect && rect.height > 0 && rect.right > bounds.left && rect.left < bounds.right;
        const toolbarBounds = toolbar?.getBoundingClientRect();
        const composerBounds = composer?.getBoundingClientRect();
        const viewport = view.visualViewport;
        const top = Math.max(bounds.top + scroller.clientTop,
            overlaps(toolbarBounds) ? toolbarBounds.bottom : bounds.top) + 12;
        const bottom = Math.min(bounds.top + scroller.clientTop + scroller.clientHeight,
            viewport ? viewport.offsetTop + viewport.height : view.innerHeight,
            overlaps(composerBounds) ? composerBounds.top : bounds.bottom) - 12;
        if (bottom <= top) return scroller.scrollTop;
        const distance = Math.min(panel.getBoundingClientRect().bottom - bottom, trigger.getBoundingClientRect().top - top);
        return Math.min(max, Math.max(from, scroller.scrollTop + distance));
    };
    if (view.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        if (opening || followBottom) scroller.scrollTo({ top: target(), behavior: 'instant' });
        onUpdate();
        return;
    }

    const style = view.getComputedStyle(panel);
    const cssDuration = style.getPropertyValue(opening ? '--acc-expand' : '--acc-collapse').trim();
    const duration = Math.max(0, parseFloat(cssDuration) * (cssDuration.endsWith('ms') ? 1 : 1000)) || 250;
    let frame;
    const started = view.performance.now();
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    const finish = () => {
        view.cancelAnimationFrame(frame);
        events.forEach(type => scroller.removeEventListener(type, finish));
        pending.delete(scroller);
        onUpdate();
    };
    const step = now => {
        if (!scroller.isConnected || !panel.isConnected || !trigger.isConnected || !isCurrent()) {
            finish();
            return;
        }
        const progress = Math.min(1, Math.max(0, (now - started) / duration));
        const eased = 1 - (1 - progress) ** 3;
        if (opening || followBottom) {
            scroller.scrollTo({ top: from + (target() - from) * eased, behavior: 'instant' });
        }
        if (progress < 1) frame = view.requestAnimationFrame(step);
        else finish();
    };
    pending.set(scroller, finish);
    events.forEach(type => scroller.addEventListener(type, finish, { passive: true }));
    frame = view.requestAnimationFrame(step);
}
