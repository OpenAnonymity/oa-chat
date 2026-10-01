import { motionDuration } from '../../ui/uiMotion.js';

// Shared Transitions.dev accordion hooks. Callers supply trusted markup, and
// continue to own their payment state; opening a guide never calls the wallet.
export function fundingDisclosure({ key, label, body, open = false, attributes = '', triggerAttributes = '', id = `zkapi-funding-${key}`, triggerId = `${id}-toggle` }) {
    return `<div class="zkapi-guide t-acc" data-funding-disclosure="${key}" data-open="${Boolean(open)}" ${attributes}>
        <button id="${triggerId}" class="zkapi-guide-trigger t-acc-head" type="button" aria-expanded="${Boolean(open)}" aria-controls="${id}" ${triggerAttributes}>
            <span>${label}</span><span class="t-acc-chevron"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5L8 10.5L12 6.5"/></svg></span>
        </button>
        <div id="${id}" class="t-acc-panel" role="region" aria-labelledby="${triggerId}" ${open ? '' : 'inert'}><div class="t-acc-panel-inner"><div class="zkapi-guide-body">${body}</div></div></div>
    </div>`;
}

// Scroll in step with the accordion, not after it. The panel's final height is
// known up front (its content is laid out, only clipped), as is the height any
// panel above it gives up while it closes, so the final position can be computed
// at the click and reached with the same duration and easing as the expansion.
// One motion instead of "grow, pause, then scroll".
const easeOutQuint = t => 1 - (1 - t) ** 5;

export function measureClosingAbove(item, items) {
    let shift = 0;
    for (const other of items) {
        if (other === item || other.dataset?.open !== 'true') continue;
        const panel = other.querySelector?.('.t-acc-panel');
        const otherRect = other.getBoundingClientRect?.();
        const itemRect = item.getBoundingClientRect?.();
        if (!panel?.getBoundingClientRect || !otherRect || !itemRect || otherRect.top >= itemRect.top) continue;
        shift += panel.getBoundingClientRect().height || 0;
    }
    return shift;
}

export function revealFundingDisclosure(item, scroller, { shiftAbove = 0 } = {}) {
    const doc = item?.ownerDocument;
    const view = doc?.defaultView;
    if (!view || !scroller) return () => {};
    let frame, stopped = false;
    const stop = () => {
        stopped = true;
        view.cancelAnimationFrame(frame);
        for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) doc.removeEventListener(name, stop, true);
    };
    const valid = () => !stopped && item.isConnected && item.dataset.open === 'true';
    const start = scroller.scrollTop;
    const height = scroller.clientHeight;
    const rect = item.getBoundingClientRect();
    const head = item.querySelector?.('.t-acc-head');
    const inner = item.querySelector?.('.t-acc-panel-inner');
    const finalHeight = head?.offsetHeight != null && inner?.scrollHeight != null
        ? head.offsetHeight + inner.scrollHeight : rect.height;
    const top = rect.top - scroller.getBoundingClientRect().top + start - shiftAbove;
    const desired = finalHeight > height - 24 ? top - 12
        : Math.min(top - 12, Math.max(start, top + finalHeight - height + 12));
    const maxScroll = Math.max(0, scroller.scrollHeight - shiftAbove + (finalHeight - rect.height) - height);
    const target = Math.max(0, Math.min(maxScroll, desired));
    if (Math.abs(target - start) < 1) return () => {};
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) doc.addEventListener(name, stop, { capture: true, passive: true });
    const duration = motionDuration(item, '--acc-expand', 360);
    let started = null;
    const tick = now => {
        if (!valid()) return stop();
        started ??= now;
        const progress = duration === 0 ? 1 : Math.min(1, (now - started) / duration);
        scroller.scrollTop = start + (target - start) * easeOutQuint(progress);
        if (progress < 1) frame = view.requestAnimationFrame(tick);
        else stop();
    };
    frame = view.requestAnimationFrame(tick);
    return stop;
}

export function attachFundingDisclosures(root, onChange = () => {}, onMotion = () => {}) {
    const items = [...(root?.querySelectorAll?.('[data-funding-disclosure]') || [])];
    let cancel = () => {};
    const handlers = [];
    const view = root?.ownerDocument?.defaultView;
    let motionTimer;
    const setOpen = (item, open) => {
        item.dataset.open = String(open);
        item.querySelector('.t-acc-head').setAttribute('aria-expanded', String(open));
        item.querySelector('.t-acc-panel').inert = !open;
        onChange(item.dataset.fundingDisclosure, open);
    };
    for (const item of items) {
        const button = item.querySelector?.('.t-acc-head');
        if (!button) continue;
        const click = () => {
            cancel();
            view?.clearTimeout(motionTimer);
            // Keep background wallet refreshes from replacing an animating
            // history arrow/panel with a freshly rendered final state.
            const open = item.dataset.open !== 'true';
            const scroller = root.querySelector('[data-funding-scroll]');
            const duration = view ? Math.max(...items.flatMap(entry => [
                motionDuration(entry, '--acc-expand', 420),
                motionDuration(entry, '--acc-collapse', 420),
                motionDuration(entry, '--acc-chevron', 320)
            ])) : 0;
            // The scroll runs alongside the expansion, so one duration covers both.
            const settleDuration = duration > 0 ? duration + 50 : 0;
            onMotion(settleDuration > 0);
            if (settleDuration > 0) motionTimer = view.setTimeout(() => onMotion(false), settleDuration);
            const shiftAbove = open ? measureClosingAbove(item, items) : 0;
            for (const other of items) setOpen(other, other === item && open);
            if (open) cancel = revealFundingDisclosure(item, scroller, { shiftAbove });
        };
        button.addEventListener('click', click);
        handlers.push([button, click]);
    }
    return () => {
        cancel();
        view?.clearTimeout(motionTimer);
        for (const [button, click] of handlers) button.removeEventListener('click', click);
    };
}

export function captureFundingDisclosureView(root) {
    const active = root?.ownerDocument?.activeElement;
    return {
        focusId: active?.closest?.('[data-funding-disclosure]') && root.contains(active) ? active.id : null,
        scrollTop: root?.querySelector?.('[data-funding-scroll]')?.scrollTop || 0
    };
}

export function restoreFundingDisclosureView(root, state) {
    if (!state) return;
    if (state.focusId) {
        const active = root.ownerDocument.getElementById(state.focusId);
        if (root.contains(active)) active?.focus({ preventScroll: true });
    }
    const scroller = root.querySelector('[data-funding-scroll]');
    if (scroller) scroller.scrollTop = state.scrollTop;
}
