// Pre-render the empty state before app bootstrap for a fast first paint.
(async () => {
    try {
        const container = document.getElementById('messages-container');
        const hasSavedSession = sessionStorage.getItem('oa-current-session');
        if (container && container.childElementCount === 0 && !hasSavedSession) {
            const { buildEmptyState } = await import('./components/MessageTemplates.js');
            container.innerHTML = buildEmptyState();
        }
    } catch (error) {
        console.warn('Prerender failed:', error);
    }
})();
