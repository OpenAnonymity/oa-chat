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

// Read final geometry only after the accordion has settled. Scrolling toward a
// destination that changes each frame made the long setup guide feel jumpy.
export function revealFundingDisclosure(item, scroller) {
    const doc = item?.ownerDocument;
    const view = doc?.defaultView;
    if (!view || !scroller) return () => {};
    let frame, timer, stopped = false;
    const stop = () => {
        stopped = true;
        view.clearTimeout(timer);
        view.cancelAnimationFrame(frame);
        for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) doc.removeEventListener(name, stop, true);
    };
    const valid = () => !stopped && item.isConnected && item.dataset.open === 'true';
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) doc.addEventListener(name, stop, { capture: true, passive: true });
    timer = view.setTimeout(() => {
        frame = view.requestAnimationFrame(() => {
            if (!valid()) return stop();
            const start = scroller.scrollTop;
            const height = scroller.clientHeight;
            const rect = item.getBoundingClientRect();
            const top = rect.top - scroller.getBoundingClientRect().top + start;
            const desired = rect.height > height - 24 ? top - 12
                : Math.min(top - 12, Math.max(start, top + rect.height - height + 12));
            const target = Math.max(0, Math.min(scroller.scrollHeight - height, desired));
            if (Math.abs(target - start) < 1) return stop();
            const started = view.performance.now();
            const duration = motionDuration(item, '--funding-scroll-duration', 320);
            const tick = now => {
                if (!valid()) return stop();
                const progress = duration === 0 ? 1 : Math.min(1, (now - started) / duration);
                const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
                scroller.scrollTop = start + (target - start) * eased;
                if (progress < 1) frame = view.requestAnimationFrame(tick);
                else stop();
            };
            frame = view.requestAnimationFrame(tick);
        });
    }, motionDuration(item, '--acc-expand', 420));
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
            // Opening can scroll after expansion; let that finish before replacing DOM.
            const settleDuration = duration + (duration > 0 && open && scroller
                ? motionDuration(item, '--funding-scroll-duration', 320) + 50 : 0);
            onMotion(settleDuration > 0);
            if (settleDuration > 0) motionTimer = view.setTimeout(() => onMotion(false), settleDuration);
            for (const other of items) setOpen(other, other === item && open);
            if (open) cancel = revealFundingDisclosure(item, scroller);
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
