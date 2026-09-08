import test from 'node:test';
import assert from 'node:assert/strict';

import SettingsDialog from '../../chat/components/SettingsDialog.js';

function element(extra = {}) {
    const listeners = new Map();
    return {
        classList: { list: new Set(['hidden']), add(c) { this.list.add(c); }, remove(c) { this.list.delete(c); }, contains(c) { return this.list.has(c); } },
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type) { listeners.delete(type); },
        listeners,
        children: [],
        append(node) { this.children.push(node); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        contains() { return true; },
        focus() { this.focused = true; },
        ...extra
    };
}

function harness({ deleteAllChats } = {}) {
    const dialog = element();
    const overlay = element({ querySelector: () => dialog });
    const menuItem = element();
    const originalDocument = globalThis.document;
    const docListeners = new Map();
    globalThis.document = {
        activeElement: null,
        getElementById: id => (id === 'settings-dialog' ? overlay : id === 'account-preferences-menu-item' ? menuItem : null),
        addEventListener(type, fn) { docListeners.set(type, fn); },
        removeEventListener(type) { docListeners.delete(type); },
        contains: () => true,
        createElement: () => element()
    };
    const events = [];
    const app = {
        accountModal: { closeAccountMenu() { events.push('menu-closed'); }, async handleAccountClear() { events.push('log-out'); } },
        chatHistoryImportModal: { open() { events.push('import-open'); } },
        showToast(message, kind) { events.push(`toast:${kind}:${message}`); },
        deleteAllChats: deleteAllChats || (async () => { events.push('chats-deleted'); })
    };
    const settings = new SettingsDialog(app);
    return { settings, overlay, dialog, menuItem, events, docListeners, restore: () => { globalThis.document = originalDocument; } };
}

const click = (h, button) => h.overlay.listeners.get('click')({ target: { closest: () => button } });

test('Settings opens from the account menu, closes on Escape, the close button and the backdrop', () => {
    const h = harness();
    try {
        h.menuItem.listeners.get('click')();
        assert.deepEqual(h.events, ['menu-closed']);
        assert.equal(h.settings.isOpen, true);
        assert.equal(h.overlay.classList.contains('hidden'), false);
        assert.equal(h.dialog.focused, true, 'focus moves into the dialog');

        h.docListeners.get('keydown')({ key: 'Escape', preventDefault() {} });
        assert.equal(h.settings.isOpen, false);
        assert.equal(h.overlay.classList.contains('hidden'), true);

        h.settings.open();
        h.overlay.listeners.get('pointerdown')({ target: h.dialog });
        assert.equal(h.settings.isOpen, true, 'a press on the card is not a dismissal');
        h.overlay.listeners.get('pointerdown')({ target: h.overlay });
        assert.equal(h.settings.isOpen, false);

        h.settings.open();
        click(h, { id: 'close-settings-dialog', dataset: {} });
        assert.equal(h.settings.isOpen, false);
    } finally {
        h.restore();
    }
});

test('the account actions: Log out leaves through the Account dialog; Delete asks first, then wipes chats and the account', async () => {
    const h = harness();
    try {
        h.settings.open();
        await click(h, { dataset: { action: 'log-out' } });
        assert.deepEqual(h.events, ['log-out']);
        assert.equal(h.settings.isOpen, false, 'the Log in dialog takes over');

        h.events.length = 0;
        h.settings.open();
        // No confirmation template in this harness: nothing happens, nothing is deleted.
        await click(h, { dataset: { action: 'delete-account' } });
        assert.deepEqual(h.events, []);
        assert.equal(h.settings.deleteConfirm, null);

        const confirmButton = { dataset: { deleteAccount: 'confirm' }, textContent: 'Delete account', disabled: false };
        await click(h, confirmButton);
        assert.deepEqual(h.events, ['chats-deleted', 'log-out', 'toast:success:Account deleted from this device']);
        assert.equal(h.settings.isOpen, false);
    } finally {
        h.restore();
    }
});

test('a failed deletion keeps the dialog and says so', async () => {
    const h = harness({ deleteAllChats: async () => { throw new Error('locked'); } });
    try {
        h.settings.open();
        const confirmButton = { dataset: { deleteAccount: 'confirm' }, textContent: 'Delete account', disabled: false };
        await click(h, confirmButton);
        assert.deepEqual(h.events, ['toast:error:Could not delete the account. Please try again.']);
        assert.equal(h.settings.isOpen, true);
        assert.equal(confirmButton.disabled, false);
        assert.equal(confirmButton.textContent, 'Delete account');
    } finally {
        h.restore();
    }
});

test('Import history hands over to the import dialog', async () => {
    const h = harness();
    try {
        h.settings.open();
        await click(h, { dataset: { action: 'import-history' } });
        assert.deepEqual(h.events, ['import-open']);
        assert.equal(h.settings.isOpen, false);
    } finally {
        h.restore();
    }
});
