// Operational status only: never include prompts, credentials or provider text.
export function renderInferenceWarnings(container, entries, sessionId) {
    if (!container?.querySelectorAll) return;
    container.querySelectorAll('[data-inference-warning]').forEach(node => node.remove());
    for (const [requestId, entry] of entries || []) {
        if (entry.sessionId !== sessionId || !entry.health) continue;
        const node = document.createElement('div');
        node.dataset.inferenceWarning = requestId;
        node.className = 'inference-silence-warning';
        node.setAttribute('role', 'status');
        node.setAttribute('aria-live', 'polite');
        node.textContent = entry.label ? `${entry.label}: ${entry.health.message}` : entry.health.message;
        container.appendChild(node);
    }
}
