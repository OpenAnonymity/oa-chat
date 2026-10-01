import { getChatArrivalDestination } from './chatArrival.js';

const watchers = new WeakMap();

export function stopToastPositioning(toast) {
    watchers.get(toast)?.();
    watchers.delete(toast);
}

export function watchToastPosition(toast, environment) {
    stopToastPositioning(toast);
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
    const rect = getChatArrivalDestination(container) || card.getBoundingClientRect();
    const top = rect.top - 16 - toast.offsetHeight;
    // The composer stays docked in both empty and active chats. Keep notices
    // above it and within the visual viewport when the phone keyboard opens.
    const viewport = view.visualViewport;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportHeight = viewport?.height || view.innerHeight;
    const maxTop = viewportTop + viewportHeight - toast.offsetHeight - 16;
    // A bottom sheet (a dialog across the width of a phone) covers the
    // composer; a notice placed above the composer would sit on the sheet's
    // rows. Keep it above the sheet instead.
    const sheetTop = bottomSheetTop(doc, view);
    const clearOfSheet = sheetTop === null ? Infinity : sheetTop - 12 - toast.offsetHeight;
    toast.style.top = `${Math.max(viewportTop + 16, Math.min(top, maxTop, clearOfSheet))}px`;
    toast.style.bottom = 'auto';
}

function bottomSheetTop(doc, view) {
    const width = view.innerWidth || 0;
    if (!width || typeof doc.querySelectorAll !== 'function') return null;
    let top = null;
    for (const dialog of doc.querySelectorAll('[aria-modal="true"]')) {
        const rect = dialog.getBoundingClientRect?.();
        if (!rect || rect.height <= 0 || rect.width < width * 0.9) continue;
        if (rect.bottom < (view.innerHeight || 0) - 8) continue;
        top = top === null ? rect.top : Math.min(top, rect.top);
    }
    return top;
}
