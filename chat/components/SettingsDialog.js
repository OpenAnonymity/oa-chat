/**
 * Settings dialog: what you set once and leave. Data controls, Appearance,
 * feedback, and the account actions (Log out, Delete account). The gear on
 * the composer keeps what changes between one prompt and the next.
 *
 * The markup lives in index.html (#settings-dialog); the Appearance
 * controls keep their ids, so ChatInput binds them as before. This class
 * only opens, closes, and routes the data-action buttons.
 */
import { exportChats } from '../services/globalExport.js';

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
        document.getElementById('account-preferences-menu-item')?.addEventListener('click', () => {
            this.app.accountModal?.closeAccountMenu?.();
            this.open();
        });
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
        switch (button.dataset.action) {
            case 'export-chats':
                await this.exportChats();
                break;
            case 'import-history':
                // The import dialog takes the page over; this one steps aside.
                this.close();
                this.app.chatHistoryImportModal?.open?.();
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

    /** A second, smaller card over the dialog: one sentence on what goes, one action. */
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
        card.querySelector('[data-delete-account="cancel"]')?.focus?.();
    }

    dismissDeleteConfirm() {
        if (!this.deleteConfirm) return;
        this.deleteConfirm.remove();
        this.deleteConfirm = null;
        this.dialog?.querySelector?.('[data-action="delete-account"]')?.focus?.();
    }

    /**
     * Everything about the account leaves this device: chats, then the
     * account itself (which also revokes the server session). The org keeps
     * nothing readable, so this is the whole deletion from the person's side.
     */
    async deleteAccount(button) {
        if (this.deleting) return;
        this.deleting = true;
        const label = button.textContent;
        button.disabled = true;
        button.textContent = 'Deleting…';
        try {
            await this.app.deleteAllChats?.();
            this.close();
            await this.app.accountModal?.handleAccountClear?.();
            this.app.showToast?.('Account deleted from this device', 'success');
        } catch (error) {
            console.error('Account deletion failed:', error);
            this.app.showToast?.('Could not delete the account. Please try again.', 'error');
            button.disabled = false;
            button.textContent = label;
        } finally {
            this.deleting = false;
        }
    }

    destroy() {
        document.removeEventListener('keydown', this.onKeydown);
        this.overlay?.removeEventListener('pointerdown', this.onOverlayPointerDown);
        this.overlay?.removeEventListener('click', this.onClick);
    }
}

export default SettingsDialog;
