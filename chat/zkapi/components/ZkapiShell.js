/** One-time product composition of OA's shared shell. Preserve existing nodes
 * (and their handlers) instead of rebuilding the toolbar on status updates. */
export function mountZkapiShell(doc = document) {
    const balance = doc.getElementById('account-tab-btn');
    const panelToggle = doc.getElementById('show-right-panel-btn');
    if (balance && panelToggle && balance.dataset.zkapiShellMounted !== 'true') {
        balance.dataset.zkapiShellMounted = 'true';
        balance.classList.add('zkapi-private-balance-control');
        balance.setAttribute('aria-label', 'Private balance');
        balance.setAttribute('aria-busy', 'false');
        balance.setAttribute('aria-expanded', 'false');
        balance.innerHTML = '<span class="account-tab-dot" aria-hidden="true"></span><span data-private-balance-label>Private balance</span>';
        panelToggle.before(balance);
        doc.getElementById('account-nav')?.remove();
    }
    const disabledIds = [
        'scrubber-shortcut-hint', 'scrubber-preview-hint', 'scrubber-settings-section',
        'memory-settings-section', 'memory-context-toggle', 'parallel-settings-section',
        'council-inline-models', 'chat-mode-toggle'
    ];
    for (const id of disabledIds) {
        const element = doc.getElementById(id);
        if (!element) continue;
        element.hidden = true;
        element.inert = true;
        element.style.display = 'none';
        element.setAttribute('aria-hidden', 'true');
        element.querySelectorAll('button, select, input').forEach(control => { control.disabled = true; });
        if ('disabled' in element) element.disabled = true;
    }
    doc.querySelectorAll('[data-action="import-tickets"]').forEach(button => {
        button.disabled = true;
        const row = button.parentElement;
        if (row) {
            row.hidden = true;
            row.inert = true;
            row.style.display = 'none';
        }
    });
    return balance || null;
}
