/** One-time product composition of OA's shared shell. Preserve existing nodes
 * (and their handlers) instead of rebuilding the toolbar on status updates.
 * `getApp` resolves the component app lazily: the shell can mount before the
 * components that capture it are constructed. */
export function mountZkapiShell(doc = document, getApp = () => null) {
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
    mountZkapiSettings(doc, getApp);
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

/** zkAPI users have no account, and the Account dialog's Data controls open
 * only from the account menu the shell removes above. Appearance already
 * lives in the composer gear for every mode; give the gear — which the shell
 * has just emptied of Privacy, Memory and Tools — a one-row Data section for
 * chat export and import as well. */
export function mountZkapiSettings(doc = document, getApp = () => null) {
    const menu = doc.getElementById('settings-menu');
    if (!menu || menu.dataset.zkapiSettingsMounted === 'true') return null;
    const foot = doc.getElementById('composer-settings-actions');
    const data = doc.createElement('section');
    data.id = 'zkapi-data-settings-section';
    data.className = 'settings-section';
    data.setAttribute('aria-labelledby', 'zkapi-data-settings-title');
    data.innerHTML = `
        <h3 id="zkapi-data-settings-title" class="settings-section-title">Data</h3>
        <div class="settings-row">
            <span class="settings-row-label">Chats</span>
            <div class="settings-row-control">
                <button type="button" data-action="zkapi-export-chats" class="settings-button" data-tooltip="Downloads a file with your chats" data-tooltip-position="left">Export</button>
                <button type="button" data-action="zkapi-import-chats" class="settings-button" data-tooltip="Bring in chats from ChatGPT or an oa-chat file" data-tooltip-position="left">Import</button>
            </div>
        </div>`;
    if (foot && foot.parentElement === menu) foot.before(data);
    else menu.append(data);
    data.addEventListener('click', async event => {
        const button = event.target.closest?.('button[data-action]');
        if (!button) return;
        event.stopPropagation();
        const app = getApp();
        if (button.dataset.action === 'zkapi-export-chats') {
            button.disabled = true;
            try {
                // Loaded on use: the export service pulls in the database.
                const { exportChats } = await import('../../services/globalExport.js');
                const ok = await exportChats();
                app?.showToast?.(ok ? 'Chats exported successfully' : 'Failed to export chats', ok ? 'success' : 'error');
            } catch (error) {
                console.error('Chat export failed:', error);
                app?.showToast?.('Failed to export chats', 'error');
            } finally {
                button.disabled = false;
            }
        } else if (button.dataset.action === 'zkapi-import-chats') {
            if (app?.chatHistoryImportModal?.open) app.chatHistoryImportModal.open();
            else doc.getElementById('global-import-input')?.click?.();
        }
    });
    menu.dataset.zkapiSettingsMounted = 'true';
    return data;
}
