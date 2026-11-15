// "Still working · 4s": a reply (or Parallel lane) whose text has gone quiet
// says how long it has been quiet, counted from its last text. The line only
// appears after STILL_WORKING_DELAY_MS, so the count starts at 1s.
//
// The element carries its start time (data-still-working-since); one shared
// clock rewrites the number on every such element while any is on screen, so
// a re-render, a session switch or a second lane never restarts the count.

const SINCE_ATTRIBUTE = 'data-still-working-since';
const TICK_MS = 250;
let clock = null;

export function stillWorkingSeconds(since, now = Date.now()) {
    if (!Number.isFinite(since)) return 1;
    return Math.max(1, Math.floor((now - since) / 1000));
}

/** The label inside the line. The count is hidden from screen readers so the
 *  status is announced once, not every second. */
export function buildStillWorkingLabel(since, now = Date.now()) {
    const seconds = stillWorkingSeconds(since, now);
    return `<span class="pending-response-label pending-response-streaming">Still working<span aria-hidden="true"> · <span class="still-working-seconds">${seconds}</span>s</span></span>`;
}

export function stillWorkingSinceAttribute(since) {
    return Number.isFinite(since) ? ` ${SINCE_ATTRIBUTE}="${Math.round(since)}"` : '';
}

/** Rewrites every visible count; returns how many lines are on screen. */
export function tickStillWorkingClocks(root = globalThis.document, now = Date.now()) {
    if (!root?.querySelectorAll) return 0;
    const lines = root.querySelectorAll(`[${SINCE_ATTRIBUTE}]`);
    lines.forEach(line => {
        const out = line.querySelector('.still-working-seconds');
        if (!out) return;
        const next = String(stillWorkingSeconds(Number(line.getAttribute(SINCE_ATTRIBUTE)), now));
        if (out.textContent !== next) out.textContent = next;
    });
    return lines.length;
}

/** Starts the shared clock if it is not running; it stops itself once no line is left. */
export function startStillWorkingClock() {
    if (clock || typeof document === 'undefined' || typeof setInterval !== 'function') return;
    clock = setInterval(() => {
        if (tickStillWorkingClocks() === 0) {
            clearInterval(clock);
            clock = null;
        }
    }, TICK_MS);
    clock?.unref?.();
}
