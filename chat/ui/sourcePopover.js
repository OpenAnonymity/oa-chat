import { motionDuration } from './uiMotion.js';

// A mouse user must be able to click the same spot to close Sources. Lift only
// the collapsed panel into the top layer; its section keeps its original spacing.
const active = new WeakMap();
const positionProperties = ['--sources-left', '--sources-top', '--sources-bottom', '--sources-width', '--sources-height'];

export function canAnchorSources(view, pointerType) {
    return pointerType !== 'touch' && !!view?.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
}

export function setSourcePopover({ scroller, section, panel, trigger, toolbar, composer,
    opening, wasOpen, preferPopover, onDismiss = () => {} }) {
    const previous = active.get(scroller);
    if (previous?.panel === panel) {
        if (opening) previous.open();
        else previous.close();
        return true;
    }
    const view = scroller?.ownerDocument?.defaultView;
    if (!opening || wasOpen || !preferPopover || !panel?.showPopover || !view) return false;
    const rect = trigger.getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    const viewport = view.visualViewport;
    const top = Math.max(bounds.top, viewport?.offsetTop || 0, toolbar?.getBoundingClientRect().bottom || 0) + 12;
    const bottom = Math.min(bounds.bottom, viewport ? viewport.offsetTop + viewport.height : view.innerHeight,
        composer?.getBoundingClientRect().top || view.innerHeight) - 12;
    // Inline citations can refer to a Sources button far offscreen. Keep the
    // normal reveal for that case rather than displaying an unanchored popup.
    if (rect.top < top || rect.bottom > bottom) return false;
    previous?.dispose();
    const doc = panel.ownerDocument;
    const sectionBounds = section.getBoundingClientRect();
    const leftEdge = Math.max(bounds.left, viewport?.offsetLeft || 0) + 8;
    const rightEdge = Math.min(bounds.right, viewport ? viewport.offsetLeft + viewport.width : view.innerWidth) - 8;
    const width = Math.min(sectionBounds.width, rightEdge - leftEdge);
    // The inline grid is already mounted (at zero height). Commit the popup's
    // hidden starting style without accidentally animating from its old opacity.
    panel.style.transition = 'none';
    panel.classList.add('sources-popover', 't-dropdown');
    panel.setAttribute('popover', 'manual');
    panel.style.setProperty('--sources-left', `${Math.max(leftEdge, Math.min(sectionBounds.left, rightEdge - width))}px`);
    panel.style.setProperty('--sources-width', `${width}px`);
    panel.showPopover();
    const above = Math.max(0, rect.top - top - 8);
    const below = Math.max(0, bottom - rect.bottom - 8);
    const placeAbove = below < panel.scrollHeight && above > below;
    panel.dataset.origin = placeAbove ? 'bottom-right' : 'top-right';
    panel.style.setProperty('--sources-top', placeAbove ? 'auto' : `${rect.bottom + 8}px`);
    panel.style.setProperty('--sources-bottom', placeAbove ? `${view.innerHeight - rect.top + 8}px` : 'auto');
    panel.style.setProperty('--sources-height', `${Math.max(1, placeAbove ? above : below)}px`);

    let timer;
    let disposed = false;
    const valid = () => panel.isConnected && trigger.isConnected && section.contains(panel);
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        view.clearTimeout(timer);
        observer.disconnect();
        doc.removeEventListener('pointerdown', outside, true);
        doc.removeEventListener('keydown', keydown, true);
        doc.removeEventListener('focusin', focus);
        scroller.removeEventListener('scroll', dismiss);
        view.removeEventListener('resize', dismiss);
        viewport?.removeEventListener('resize', dismiss);
        viewport?.removeEventListener('scroll', dismiss);
        pointer.removeEventListener('change', dismiss);
        // Restore the already-collapsed inline grid without starting a second
        // height transition when it leaves the top layer.
        panel.style.transition = 'none';
        section.dataset.open = 'false';
        trigger.dataset.open = 'false';
        trigger.setAttribute('aria-expanded', 'false');
        const inner = panel.firstElementChild;
        inner.inert = true;
        inner.setAttribute('aria-hidden', 'true');
        if (panel.matches(':popover-open')) panel.hidePopover();
        panel.removeAttribute('popover');
        panel.classList.remove('sources-popover', 't-dropdown', 'is-open', 'is-closing', 'hidden');
        panel.inert = false;
        positionProperties.forEach(name => panel.style.removeProperty(name));
        delete panel.dataset.origin;
        void panel.offsetHeight;
        panel.style.removeProperty('transition');
        if (active.get(scroller)?.panel === panel) active.delete(scroller);
    };
    const open = () => {
        view.clearTimeout(timer);
        panel.inert = false;
        panel.classList.add('t-dropdown');
        void panel.offsetWidth;
        panel.classList.remove('is-closing');
        panel.classList.add('is-open');
    };
    const close = () => {
        panel.inert = true;
        panel.classList.remove('is-open');
        panel.classList.add('is-closing');
        view.clearTimeout(timer);
        const duration = motionDuration(panel, '--dropdown-close-dur');
        if (duration === 0) dispose();
        else timer = view.setTimeout(dispose, duration);
    };
    const dismiss = () => { if (valid()) onDismiss(); else dispose(); };
    const outside = event => {
        if (!panel.contains(event.target) && !trigger.contains(event.target)) dismiss();
    };
    const focus = event => {
        if (!panel.contains(event.target) && !trigger.contains(event.target)) dismiss();
    };
    const keydown = event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
    };
    const observer = new view.MutationObserver(() => {
        if (!valid()) dispose();
        else if (Math.abs(trigger.getBoundingClientRect().top - rect.top) > 1) dismiss();
    });
    const pointer = view.matchMedia('(hover: hover) and (pointer: fine)');
    active.set(scroller, { panel, open, close, dispose });
    observer.observe(scroller, { childList: true, subtree: true });
    doc.addEventListener('pointerdown', outside, true);
    doc.addEventListener('keydown', keydown, true);
    doc.addEventListener('focusin', focus);
    scroller.addEventListener('scroll', dismiss, { passive: true });
    view.addEventListener('resize', dismiss);
    viewport?.addEventListener('resize', dismiss);
    viewport?.addEventListener('scroll', dismiss);
    pointer.addEventListener('change', dismiss);
    void panel.offsetWidth;
    panel.style.removeProperty('transition');
    open();
    return true;
}
