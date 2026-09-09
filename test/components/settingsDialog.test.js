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
        remove() { this.removed = true; },
        ...extra
    };
}

function harness({ deleteAllChats, deleteAccount } = {}) {
    const dialog = element();
    const overlay = element({ querySelector: () => dialog });
    const menuItem = element();
    const originalDocument = globalThis.document;
    const docListeners = new Map();
    globalThis.document = {
        activeElement: null,
        getElementById: id => (id === 'settings-dialog' ? overlay : id === 'account-delete-menu-item' ? menuItem : null),
        addEventListener(type, fn) { docListeners.set(type, fn); },
        removeEventListener(type) { docListeners.delete(type); },
        contains: () => true,
        createElement: () => element()
    };
    const events = [];
    const app = {
        accountModal: {
            closeAccountMenu() { events.push('menu-closed'); },
            async handleAccountClear() { events.push('log-out'); },
            accountService: { deleteAccount: deleteAccount || (async () => { events.push('org-deleted'); }) }
        },
        chatHistoryImportModal: { open() { events.push('import-open'); } },
        showToast(message, kind) { events.push(`toast:${kind}:${message}`); },
        deleteAllChats: deleteAllChats || (async () => { events.push('chats-deleted'); })
    };
    const settings = new SettingsDialog(app);
    return { settings, overlay, dialog, menuItem, events, docListeners, restore: () => { globalThis.document = originalDocument; } };
}

const click = (h, button) => h.overlay.listeners.get('click')({ target: { closest: () => button } });

test('Delete account opens from the account menu straight into its confirmation; the dialog closes on Escape, the close button and the backdrop', () => {
    const h = harness();
    try {
        h.menuItem.listeners.get('click')();
        assert.deepEqual(h.events, ['menu-closed']);
        assert.equal(h.settings.isOpen, true);
        assert.equal(h.overlay.classList.contains('hidden'), false);
        assert.equal(h.settings.standaloneConfirm, true, 'only the confirmation shows; the card behind is hidden');
        // No confirmation template in this harness, so nothing is appended.
        assert.equal(h.settings.deleteConfirm, null);

        h.docListeners.get('keydown')({ key: 'Escape', preventDefault() {} });
        assert.equal(h.settings.isOpen, false);
        assert.equal(h.overlay.classList.contains('hidden'), true);
        assert.equal(h.settings.standaloneConfirm, false);

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
        assert.deepEqual(h.events, ['org-deleted', 'chats-deleted', 'log-out', 'toast:success:Account deleted'],
            'the org deletes first; the device is wiped only after its answer');
        assert.equal(h.settings.isOpen, false);
    } finally {
        h.restore();
    }
});

test('a refused deletion keeps the dialog, keeps the device intact and says why', async () => {
    const stripeDown = Object.assign(new Error('Billing could not be closed'), { status: 503, code: 'BILLING_UNAVAILABLE' });
    const h = harness({ deleteAccount: async () => { throw stripeDown; } });
    try {
        h.settings.open();
        const confirmButton = { dataset: { deleteAccount: 'confirm' }, textContent: 'Delete account', disabled: false };
        await click(h, confirmButton);
        assert.deepEqual(h.events, ['toast:error:Your membership could not be cancelled, so nothing was deleted. Please try again.']);
        assert.equal(h.settings.isOpen, true);
        assert.equal(confirmButton.disabled, false);
        assert.equal(confirmButton.textContent, 'Delete account');
    } finally {
        h.restore();
    }
});

test('a local wipe failure after the org deleted the account still signs out and reports success', async () => {
    const h = harness({ deleteAllChats: async () => { throw new Error('locked'); } });
    try {
        h.settings.open();
        const confirmButton = { dataset: { deleteAccount: 'confirm' }, textContent: 'Delete account', disabled: false };
        await click(h, confirmButton);
        assert.deepEqual(h.events, ['org-deleted', 'log-out', 'toast:success:Account deleted']);
        assert.equal(h.settings.isOpen, false);
    } finally {
        h.restore();
    }
});

test('the typed word gates the Delete button and Enter submits only once it matches', () => {
    const h = harness();
    try {
        const listeners = new Map();
        const input = { value: '', addEventListener(type, fn) { listeners.set(type, fn); }, focus() { this.focused = true; } };
        const confirm = { disabled: false, clicked: 0, click() { this.clicked += 1; } };
        const card = {
            cloneNode() { return card; },
            querySelector(selector) {
                if (selector.includes('"input"')) return input;
                if (selector.includes('"confirm"')) return confirm;
                return null;
            }
        };
        globalThis.document.getElementById = id => (
            id === 'settings-dialog' ? h.overlay
            : id === 'settings-delete-account-template' ? { content: { firstElementChild: card } }
            : null
        );
        h.settings.open();
        h.settings.showDeleteConfirm();
        assert.equal(confirm.disabled, true, 'disabled until the word is typed');
        assert.equal(input.focused, true, 'focus lands in the field');

        input.value = 'delete';
        listeners.get('input')();
        assert.equal(confirm.disabled, true, 'case matters: the word is DELETE');
        listeners.get('keydown')({ key: 'Enter', preventDefault() {} });
        assert.equal(confirm.clicked, 0);

        input.value = ' DELETE ';
        listeners.get('input')();
        assert.equal(confirm.disabled, false, 'stray whitespace is forgiven');
        listeners.get('keydown')({ key: 'Enter', preventDefault() {} });
        assert.equal(confirm.clicked, 1);
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

test('Export asks first: the download only starts from the confirmation card', async () => {
    const h = harness();
    try {
        h.settings.exportChats = async () => { h.events.push('export-chats'); };
        h.settings.open();
        await click(h, { dataset: { action: 'export-chats' } });
        assert.deepEqual(h.events, [], 'no download on the first click');
        assert.ok(h.settings.deleteConfirm, 'a confirmation card is up');
        assert.match(h.settings.deleteConfirm.innerHTML, /Export your chats\?/);
        assert.match(h.settings.deleteConfirm.innerHTML, /This downloads a file with your chats to this device\./);
        assert.match(h.settings.deleteConfirm.innerHTML, /data-export-confirm="export-chats" class="settings-button settings-button-primary">Export</);

        await click(h, { dataset: { exportConfirm: 'cancel' } });
        assert.deepEqual(h.events, [], 'Cancel downloads nothing');
        assert.equal(h.settings.deleteConfirm, null);

        await click(h, { dataset: { action: 'export-chats' } });
        await click(h, { dataset: { exportConfirm: 'export-chats' } });
        assert.deepEqual(h.events, ['export-chats']);
        assert.equal(h.settings.deleteConfirm, null, 'the card closes with the download');
    } finally {
        h.restore();
    }
});
