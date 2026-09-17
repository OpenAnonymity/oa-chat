import { getChatArrivalDestination } from './chatArrival.js';

const placements = new WeakMap();
const watchers = new WeakMap();

export function stopToastPositioning(toast) {
    watchers.get(toast)?.();
    watchers.delete(toast);
    // Retain the weak placement through the exit fade: input events can still
    // find this toast until removal. The WeakMap releases it with the element.
}

export function watchToastPosition(toast, environment) {
    stopToastPositioning(toast);
    placements.delete(toast);
    const update = () => positionAppToast(toast, environment);
    const view = environment.window;
    view.addEventListener('resize', update);
    view.visualViewport?.addEventListener('resize', update);
    view.visualViewport?.addEventListener('scroll', update);
    watchers.set(toast, () => {
        view.removeEventListener('resize', update);
        view.visualViewport?.removeEventListener('resize', update);
        view.visualViewport?.removeEventListener('scroll', update);
    });
    update();
}

export function positionAppToast(toast, { document: doc, window: view }) {
    if (!toast) return;
    if (toast.dataset.position === 'top-center') {
        toast.style.top = 'calc(env(safe-area-inset-top, 0px) + 72px)';
        toast.style.bottom = 'auto';
        toast.style.maxWidth = 'calc(100vw - 32px)';
        toast.style.textAlign = 'center';
        return;
    }
    const card = doc.getElementById('input-card');
    if (!card) return;
    const container = doc.getElementById('messages-container');
    const mode = container?.querySelector(':scope > .welcome-landing') ? 'centered' : 'docked';
    let placement = placements.get(toast);
    if (placement && placement.mode !== mode) placement.frozen = true;
    if (!placement?.frozen) {
        const rect = getChatArrivalDestination(container) || card.getBoundingClientRect();
        placement = { mode, top: mode === 'centered' ? rect.bottom + 16 : rect.top - 16 - toast.offsetHeight };
        placements.set(toast, placement);
    }
    // Keep an existing toast still when the composer changes layout. Clamp only
    // to keep it readable if the viewport shrinks (for example, a phone keyboard).
    const viewport = view.visualViewport;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportHeight = viewport?.height || view.innerHeight;
    const maxTop = viewportTop + viewportHeight - toast.offsetHeight - 16;
    toast.style.top = `${Math.max(viewportTop + 16, Math.min(placement.top, maxTop))}px`;
    toast.style.bottom = 'auto';
}
