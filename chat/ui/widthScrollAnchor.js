const BOTTOM_TOLERANCE = 8;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

function transitionTime(style) {
    const milliseconds = value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000) || 0;
    const durations = style.transitionDuration.split(',').map(milliseconds);
    const delays = style.transitionDelay.split(',').map(milliseconds);
    return Math.max(0, ...durations.map((duration, index) => duration + delays[index % delays.length]));
}

// Capture before changing width. Follow the bottom throughout CSS reflow, not
// just for the first frame (widening clamps scrollTop; narrowing grows it again).
export function preserveBottomDuringWidthChange({ scroller, content, isCurrent = () => true }) {
    const view = scroller?.ownerDocument?.defaultView;
    if (!view || !content || scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > BOTTOM_TOLERANCE) {
        return () => {};
    }

    const duration = transitionTime(view.getComputedStyle(content));
    const started = view.performance.now();
    const previousBehavior = scroller.style.scrollBehavior;
    const previousAnchor = scroller.style.overflowAnchor;
    const document = scroller.ownerDocument;
    let frame;
    let timer;
    let stopped = false;
    scroller.style.scrollBehavior = 'auto';
    scroller.style.overflowAnchor = 'none';

    const stop = () => {
        if (stopped) return;
        stopped = true;
        view.cancelAnimationFrame(frame);
        view.clearTimeout(timer);
        scroller.style.scrollBehavior = previousBehavior;
        scroller.style.overflowAnchor = previousAnchor;
        for (const event of ['wheel', 'touchstart', 'pointerdown']) scroller.removeEventListener(event, stop);
        document.removeEventListener('keydown', onKey);
    };
    const onKey = event => { if (SCROLL_KEYS.has(event.key)) stop(); };
    const pin = () => {
        if (!isCurrent() || scroller.isConnected === false) {
            stop();
            return false;
        }
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        return true;
    };
    const tick = now => {
        if (stopped || !pin()) return;
        // Allow the final layout frame, including a zero-duration transition.
        if (now - started >= duration + 32) stop();
        else frame = view.requestAnimationFrame(tick);
    };
    for (const event of ['wheel', 'touchstart', 'pointerdown']) scroller.addEventListener(event, stop, { passive: true });
    document.addEventListener('keydown', onKey);
    frame = view.requestAnimationFrame(tick);
    // Background tabs may suspend animation frames; do not leave a live lock.
    timer = view.setTimeout(() => { if (!stopped) { pin(); stop(); } }, duration + 100);
    return stop;
}
