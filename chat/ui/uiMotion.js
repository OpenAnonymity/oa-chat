function restoreDisplay(root, state) {
    if (state.display) root.style.setProperty('display', state.display, state.displayPriority);
    else root.style?.removeProperty('display');
}

// Presentation only: callers change their logical state before animating.
// Never clone dialogs: outgoing controls become inert and are discarded on close.
const surfaces = new WeakMap();
const reduced = el => el?.ownerDocument?.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export function motionDuration(el, property, fallback = 150) {
    if (reduced(el)) return 0;
    const value = el?.ownerDocument?.defaultView?.getComputedStyle?.(el).getPropertyValue(property)?.trim();
    return value ? parseFloat(value) * (value.endsWith('ms') ? 1 : 1000) : fallback;
}

export function showSurface(root, kind = 'modal') {
    if (!root?.classList) return;
    const old = surfaces.get(root);
    if (old) { clearTimeout(old.timer); restoreDisplay(root, old); }
    root.classList.remove('hidden');
    root.hidden = false;
    root.inert = false;
    root.removeAttribute?.('aria-hidden');
    if (!root.ownerDocument?.defaultView?.getComputedStyle) return;
    const panel = kind === 'modal' ? root.firstElementChild : root;
    if (!panel) return;
    const state = { panel, kind, timer: null, display: root.style.getPropertyValue('display'), displayPriority: root.style.getPropertyPriority('display') };
    surfaces.set(root, state);
    panel.classList.remove('is-closing', 'is-open');
    panel.classList.add(`t-${kind}`);
    if (kind === 'modal') root.classList.add('oa-motion-backdrop');
    root.dataset.motionPhase = 'opening';
    void panel.offsetWidth;
    panel.classList.add('is-open');
    root.dataset.motionPhase = 'open';
}

export function hideSurface(root, { remove = false, clear = false } = {}) {
    if (!root?.classList) return;
    const state = surfaces.get(root);
    if (state?.closing) return;
    const view = root.ownerDocument?.defaultView;
    const display = view?.getComputedStyle?.(root).display;
    if (state?.kind === 'modal' && root.firstElementChild) {
        state.panel = root.firstElementChild;
        state.panel.classList.add('t-modal', 'is-open');
        void state.panel.offsetWidth;
    }
    root.inert = true;
    root.classList.add('hidden');
    const finish = () => {
        if (state) restoreDisplay(root, state);
        state?.panel?.classList.remove('is-closing', 'is-open');
        if (remove) root.remove();
        else if (clear) root.innerHTML = '';
        surfaces.delete(root);
    };
    if (!state || reduced(root) || !root.isConnected) { finish(); return; }
    clearTimeout(state.timer);
    state.closing = true;
    // Keep .hidden as the logical state; the temporary display only paints the exit.
    root.style.setProperty('display', display || 'block', 'important');
    root.dataset.motionPhase = 'closing';
    state.panel.classList.remove('is-open');
    state.panel.classList.add('is-closing');
    state.timer = setTimeout(finish, motionDuration(state.panel,
        state.kind === 'toast' ? '--toast-close' : `--${state.kind}-close-dur`));
}

export function revealText(element) {
    if (!element?.classList || reduced(element)) return;
    element.classList.add('t-text-swap', 'is-enter-start');
    void element.offsetWidth;
    element.classList.remove('is-enter-start');
}

// Keep the native <details> state and keyboard behavior. The wrapper supplies
// the grid track; browsers without ::details-content retain a normal disclosure.
export function enhanceDetails(root) {
    for (const details of root?.querySelectorAll?.('details') || []) {
        if (details.dataset.motionDetails) continue;
        const summary = details.querySelector(':scope > summary');
        if (!summary) continue;
        details.dataset.motionDetails = 'true';
        details.classList.add('t-acc');
        const panel = details.ownerDocument.createElement('div');
        const inner = details.ownerDocument.createElement('div');
        panel.className = 't-acc-panel'; inner.className = 't-acc-panel-inner';
        for (const node of [...details.childNodes]) if (node !== summary) inner.appendChild(node);
        panel.appendChild(inner); details.appendChild(panel);
        const sync = () => {
            details.dataset.open = String(details.open);
            inner.inert = !details.open;
        };
        sync(); details.addEventListener('toggle', sync);
    }
}

export function slideTabs(bar, previous = null) {
    if (!bar?.ownerDocument) return;
    const buttons = [...bar.querySelectorAll('button[aria-pressed]')];
    const active = buttons.find(button => button.getAttribute('aria-pressed') === 'true');
    if (!active) return;
    bar.classList.add('t-tabs');
    buttons.forEach(button => button.classList.add('t-tab'));
    let pill = bar.querySelector('.t-tabs-pill');
    if (!pill) {
        pill = bar.ownerDocument.createElement('span');
        pill.className = 't-tabs-pill'; pill.setAttribute('aria-hidden', 'true');
        bar.prepend(pill);
    }
    const move = animate => {
        pill.style.transition = animate ? '' : 'none';
        pill.style.width = `${active.offsetWidth}px`;
        pill.style.height = `${active.offsetHeight}px`;
        pill.style.top = `${active.offsetTop}px`;
        pill.style.transform = `translateX(${active.offsetLeft}px)`;
        void pill.offsetWidth;
        pill.style.transition = '';
    };
    if (previous && !reduced(bar)) {
        pill.style.transition = 'none';
        pill.style.width = previous.width;
        pill.style.transform = previous.transform;
        void pill.offsetWidth;
        move(true);
    } else move(false);
    return () => move(false);
}

export function watchDisclosures(root) {
    if (!root?.ownerDocument?.defaultView?.MutationObserver) return () => {};
    enhanceDetails(root);
    const observer = new root.ownerDocument.defaultView.MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
            if (node.nodeType !== 1) continue;
            enhanceDetails(node.parentElement || node);
        }
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
}

const disclosures = new WeakMap();
export function setDisclosure(root, open, { remove = false } = {}) {
    if (!root?.classList) return;
    const previous = disclosures.get(root);
    const from = open && !previous ? 0 : root.getBoundingClientRect?.().height || 0;
    previous?.cancel();
    root.hidden = !open;
    root.classList.toggle('hidden', !open);
    root.inert = !open;
    if (!root.animate || reduced(root)) {
        root.style?.removeProperty('display'); root.style?.removeProperty('overflow');
        disclosures.delete(root);
        if (!open && remove) root.remove();
        return;
    }
    root.style.setProperty('display', 'block', 'important');
    root.style.overflow = 'hidden';
    const to = open ? root.scrollHeight : 0;
    const animation = root.animate([
        { height: `${from}px`, opacity: open && !previous ? 0 : 1 },
        { height: `${to}px`, opacity: open ? 1 : 0 }
    ], { duration: motionDuration(root, open ? '--acc-expand' : '--acc-collapse', 250), easing: 'cubic-bezier(.22,1,.36,1)' });
    disclosures.set(root, animation);
    animation.finished.then(() => {
        if (disclosures.get(root) !== animation) return;
        disclosures.delete(root);
        root.style.removeProperty('display'); root.style.removeProperty('overflow');
        if (!open && remove) root.remove();
    }).catch(() => {});
}
