/**
 * Data controls, Appearance and Share feedback live in the composer gear for
 * every mode, so a zkAPI user without an account finds them too; this class
 * runs the gear's data actions (export, import). What remains account-bound
 * — Delete account — is reached from the account menu and opens straight
 * into its confirmation over the #settings-dialog overlay.
 */
import { exportChats, exportAllData } from '../services/globalExport.js';

/** Must match DELETE_ACCOUNT_CONFIRMATION in accountService.js and the org. */
const DELETE_ACCOUNT_CONFIRMATION = 'DELETE';

/** One line the person can act on; the org's own message is already plain. */
function deletionErrorMessage(error) {
    if (error?.status === 401) return 'Your session has expired. Log in again, then delete the account.';
    if (error?.code === 'BILLING_UNAVAILABLE') return 'Your membership could not be cancelled, so nothing was deleted. Please try again.';
    if (error?.name === 'AbortError' || error?.status === 0) return 'Could not reach OA. Check your connection and try again.';
    return 'Could not delete the account. Please try again.';
}

const EXPORT_CONFIRMATIONS = {
    'export-all-data': {
        title: 'Export your chats and settings?',
        body: 'This downloads one file with your chats and settings to this device.'
    },
    'export-chats': {
        title: 'Export your chats?',
        body: 'This downloads a file with your chats to this device.'
    },
    'export-memory': {
        title: 'Export your memories?',
        body: 'This downloads a portable file with what oa-chat remembers about you.'
    }
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

class SettingsDialog {
    constructor(app) {
        this.app = app;
        this.overlay = document.getElementById('settings-dialog');
        this.dialog = this.overlay?.querySelector('[role="dialog"]') || null;
        this.isOpen = false;
        this.returnFocusEl = null;
        this.deleteConfirm = null;
        this.onKeydown = event => this.handleKeydown(event);
        this.onOverlayPointerDown = event => {
            // Backdrop only: a press that starts on the card is not a dismissal.
            if (event.target === this.overlay) this.close();
        };
        this.onClick = event => this.handleClick(event);
        if (this.overlay) {
            this.overlay.addEventListener('pointerdown', this.onOverlayPointerDown);
            this.overlay.addEventListener('click', this.onClick);
        }
        document.getElementById('account-delete-menu-item')?.addEventListener('click', () => {
            this.app.accountModal?.closeAccountMenu?.();
            this.openDeleteAccount();
        });
        // The gear's Data controls: exports run at once (the gear is a menu,
        // not a place for a second card), imports open their pickers.
        this.dataSection = document.getElementById('data-management-section');
        this.onDataClick = event => this.handleDataClick(event);
        this.dataSection?.addEventListener('click', this.onDataClick);
    }

    /** From the account menu: only the confirmation, over the backdrop. */
    openDeleteAccount(returnFocusEl = null) {
        if (!this.overlay) return;
        this.open(returnFocusEl);
        this.dialog?.setAttribute?.('hidden', '');
        this.standaloneConfirm = true;
        this.showDeleteConfirm();
    }

    async handleDataClick(event) {
        const button = event.target.closest?.('button[data-action]');
        if (!button || !this.dataSection?.contains(button)) return;
        event.stopPropagation();
        switch (button.dataset.action) {
            case 'export-chats':
            case 'export-all-data':
            case 'export-memory':
                button.disabled = true;
                try { await this.runExport(button.dataset.action); }
                finally { button.disabled = false; }
                break;
            case 'import-data':
                document.getElementById('global-import-input')?.click?.();
                break;
            case 'import-memory':
                document.getElementById('memory-import-input')?.click?.();
                break;
            case 'import-history':
                this.app.chatInput?.closeSettingsMenu?.();
                this.app.chatHistoryImportModal?.open?.();
                break;
            default:
                break;
        }
    }

    open(returnFocusEl = null) {
        if (this.isOpen || !this.overlay) return;
        this.isOpen = true;
        this.returnFocusEl = returnFocusEl || document.activeElement;
        this.overlay.classList.remove('hidden');
        document.addEventListener('keydown', this.onKeydown);
        this.dialog?.focus?.({ preventScroll: true });
    }

    close() {
        if (!this.isOpen || !this.overlay) return;
        this.isOpen = false;
        this.dismissDeleteConfirm();
        this.dialog?.removeAttribute?.('hidden');
        this.standaloneConfirm = false;
        this.overlay.classList.add('hidden');
        document.removeEventListener('keydown', this.onKeydown);
        const target = this.returnFocusEl;
        this.returnFocusEl = null;
        if (target?.focus && document.contains?.(target)) target.focus({ preventScroll: true });
    }

    handleKeydown(event) {
        if (!this.isOpen) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            if (this.deleteConfirm) this.dismissDeleteConfirm();
            else this.close();
            return;
        }
        if (event.key !== 'Tab') return;
        const scope = this.deleteConfirm || this.dialog;
        const items = scope ? [...scope.querySelectorAll(FOCUSABLE)] : [];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    async handleClick(event) {
        const button = event.target.closest?.('button');
        if (!button || !this.overlay.contains(button)) return;
        if (button.id === 'close-settings-dialog') {
            this.close();
            return;
        }
        const confirmRole = button.dataset.deleteAccount;
        if (confirmRole === 'cancel') {
            this.dismissDeleteConfirm();
            return;
        }
        if (confirmRole === 'confirm') {
            await this.deleteAccount(button);
            return;
        }
        const exportRole = button.dataset.exportConfirm;
        if (exportRole === 'cancel') {
            this.dismissDeleteConfirm();
            return;
        }
        if (exportRole) {
            this.dismissDeleteConfirm();
            await this.runExport(exportRole);
            return;
        }
        switch (button.dataset.action) {
            case 'export-chats':
            case 'export-all-data':
            case 'export-memory':
                // A download should not be a surprise: say what the file is first.
                this.showExportConfirm(button.dataset.action);
                break;
            case 'import-data':
                // The file picker takes over; ChatInput handles the chosen file.
                document.getElementById('global-import-input')?.click?.();
                break;
            case 'import-memory':
                document.getElementById('memory-import-input')?.click?.();
                break;
            case 'import-history':
                // The import dialog takes the page over; this one steps aside.
                this.close();
                this.app.chatHistoryImportModal?.open?.({ returnTo: 'account' });
                break;
            case 'log-out':
                this.close();
                await this.app.accountModal?.handleAccountClear?.();
                break;
            case 'delete-account':
                this.showDeleteConfirm();
                break;
            default:
                break;
        }
    }

    async exportChats() {
        try {
            const ok = await exportChats();
            this.app.showToast?.(ok ? 'Chats exported successfully' : 'Failed to export chats', ok ? 'success' : 'error');
        } catch (error) {
            console.error('Chat export failed:', error);
            this.app.showToast?.('Failed to export chats', 'error');
        }
    }

    /** Chats plus display settings, one file: for moving to another device. */
    async exportAll() {
        try {
            const ok = await exportAllData();
            this.app.showToast?.(ok ? 'Data exported successfully' : 'Failed to export data', ok ? 'success' : 'error');
        } catch (error) {
            console.error('Export failed:', error);
            this.app.showToast?.('Failed to export data', 'error');
        }
    }

    /** Memories work whether or not Memory is on: they are the person's data either way. */
    async exportMemories() {
        if (!this.app.memoryEditor?.exportMemories) {
            this.app.showToast?.('Memory export unavailable', 'error');
            return;
        }
        await this.app.memoryEditor.exportMemories();
    }

    /**
     * A second, smaller card over the dialog: what goes, then the word to
     * type. The Delete button stays disabled until the word matches, so the
     * only way to delete is to have read the sentence above it.
     */
    /**
     * The export confirmations share the delete card's layer and layout:
     * one question, one sentence on what the file holds, Cancel / Export.
     */
    showExportConfirm(action) {
        if (this.deleteConfirm || !this.overlay) return;
        const copy = EXPORT_CONFIRMATIONS[action];
        if (!copy) return;
        const layer = document.createElement('div');
        layer.className = 'settings-confirm-layer';
        layer.innerHTML = `
            <div role="dialog" aria-modal="true" aria-labelledby="export-confirm-title" tabindex="-1" class="w-full max-w-md rounded-2xl border border-border bg-background shadow-2xl">
                <div class="p-6">
                    <p id="export-confirm-title" class="text-base font-semibold text-foreground">${copy.title}</p>
                    <p class="text-sm text-muted-foreground mt-1">${copy.body}</p>
                    <div class="settings-confirm-actions">
                        <button type="button" data-export-confirm="cancel" class="settings-button">Cancel</button>
                        <button type="button" data-export-confirm="${action}" class="settings-button settings-button-primary">Export</button>
                    </div>
                </div>
            </div>`;
        this.overlay.append(layer);
        this.deleteConfirm = layer;
        this.confirmReturnFocus = this.dialog?.querySelector?.(`[data-action="${action}"]`) || null;
        layer.querySelector(`[data-export-confirm="${action}"]`)?.focus?.();
    }

    async runExport(action) {
        if (action === 'export-chats') await this.exportChats();
        else if (action === 'export-all-data') await this.exportAll();
        else if (action === 'export-memory') await this.exportMemories();
    }

    showDeleteConfirm() {
        if (this.deleteConfirm || !this.overlay) return;
        const template = document.getElementById('settings-delete-account-template');
        const card = template?.content?.firstElementChild?.cloneNode(true);
        if (!card) return;
        const layer = document.createElement('div');
        layer.className = 'settings-confirm-layer';
        layer.append(card);
        this.overlay.append(layer);
        this.deleteConfirm = layer;
        this.confirmReturnFocus = this.dialog?.querySelector?.('[data-action="delete-account"]') || null;
        const input = card.querySelector('[data-delete-account="input"]');
        const confirm = card.querySelector('[data-delete-account="confirm"]');
        if (input && confirm) {
            confirm.disabled = true;
            input.addEventListener('input', () => {
                confirm.disabled = !this.confirmationMatches(input.value);
            });
            input.addEventListener('keydown', event => {
                if (event.key === 'Enter' && !confirm.disabled) {
                    event.preventDefault();
                    confirm.click();
                }
            });
        }
        (input || card.querySelector('[data-delete-account="cancel"]'))?.focus?.();
    }

    confirmationMatches(value) {
        return String(value ?? '').trim() === DELETE_ACCOUNT_CONFIRMATION;
    }

    dismissDeleteConfirm() {
        if (!this.deleteConfirm) return;
        this.deleteConfirm.remove();
        this.deleteConfirm = null;
        const target = this.confirmReturnFocus;
        this.confirmReturnFocus = null;
        target?.focus?.();
        // Opened from the account menu there is nothing behind the card.
        if (this.standaloneConfirm && this.isOpen) this.close();
    }

    /**
     * The org goes first: it cancels the membership, revokes every session
     * and drops the account row. Only after its 204 does this device wipe
     * chats and the local account, so a failed request (Stripe unreachable,
     * session already gone) leaves everything exactly as it was.
     */
    async deleteAccount(button) {
        if (this.deleting) return;
        const input = this.deleteConfirm?.querySelector?.('[data-delete-account="input"]');
        if (input && !this.confirmationMatches(input.value)) return;
        this.deleting = true;
        const label = button.textContent;
        button.disabled = true;
        button.textContent = 'Deleting…';
        if (input) input.disabled = true;
        try {
            const service = this.app.services?.account || this.app.accountModal?.accountService;
            if (!service?.deleteAccount) throw new Error('Account service unavailable');
            await service.deleteAccount();
        } catch (error) {
            console.error('Account deletion failed:', error);
            this.app.showToast?.(deletionErrorMessage(error), 'error');
            button.disabled = false;
            button.textContent = label;
            if (input) {
                input.disabled = false;
                input.focus?.();
            }
            this.deleting = false;
            return;
        }
        // The account is gone at the org; whatever happens below is local
        // tidying and must not read as a failed deletion.
        try {
            await this.app.deleteAllChats?.();
        } catch (error) {
            console.warn('Local chat wipe after account deletion failed:', error);
        }
        this.close();
        try {
            await this.app.accountModal?.handleAccountClear?.();
        } catch (error) {
            console.warn('Local account clear after account deletion failed:', error);
        }
        this.app.showToast?.('Account deleted', 'success');
        this.deleting = false;
    }

    destroy() {
        document.removeEventListener('keydown', this.onKeydown);
        this.overlay?.removeEventListener('pointerdown', this.onOverlayPointerDown);
        this.overlay?.removeEventListener('click', this.onClick);
    }
}

export default SettingsDialog;
