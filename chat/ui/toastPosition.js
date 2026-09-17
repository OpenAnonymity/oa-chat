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
    const overlay = toast.dataset.position === 'account' ? environment.document.getElementById('account-modal') : null;
    const resize = overlay && view.ResizeObserver ? new view.ResizeObserver(update) : null;
    const observeDialog = () => {
        resize?.disconnect();
        resize?.observe(toast);
        const dialog = overlay?.querySelector('[role="dialog"]');
        if (dialog) resize?.observe(dialog);
        update();
    };
    const mutation = overlay && view.MutationObserver ? new view.MutationObserver(observeDialog) : null;
    mutation?.observe(overlay, { childList: true });
    if (overlay) observeDialog();
    watchers.set(toast, () => {
        resize?.disconnect();
        mutation?.disconnect();
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
    if (toast.dataset.position === 'account') {
        const overlay = doc.getElementById('account-modal');
        const dialog = overlay?.querySelector('[role="dialog"]');
        if (dialog && !overlay.classList.contains('hidden')) {
            const viewport = view.visualViewport;
            const top = viewport?.offsetTop || 0;
            const clearance = toast.offsetHeight + 32;
            // Leave space outside tall dialogs as well as desktop cards. Keep
            // the reservation until close so dismissal does not jump the form.
            overlay.style.setProperty('--account-notice-max-height', `max(0px, calc(100dvh - ${clearance * 2}px))`);
            overlay.setAttribute('data-account-notice', 'true');
            toast.style.maxWidth = 'calc(100vw - 32px)';
            toast.style.textAlign = 'center';
            toast.style.top = `${Math.max(top + 16, dialog.getBoundingClientRect().top - toast.offsetHeight - 16)}px`;
            toast.style.bottom = 'auto';
            return;
        }
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
