import test from 'node:test';
import assert from 'node:assert/strict';
import AccountModal from '../../chat/components/AccountModal.js';
import { SLOT_NAMES } from '../../chat/extensions/extensionHost.js';

function createElement(documentImpl, options = {}) {
    const attributes = new Map();
    return {
        hidden: options.hidden ?? false,
        dataset: {},
        focusCount: 0,
        children: options.children || [],
        classList: { add() {}, remove() {} },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        focus() {
            this.focusCount += 1;
            documentImpl.activeElement = this;
        },
        contains(target) { return this === target || this.children.includes(target); },
        querySelector() { return null; },
        querySelectorAll(selector) {
            return selector.includes('[role="menuitem"]') ? this.children : [];
        }
    };
}

test('signed-in account footer exposes an accessible keyboard settings menu', () => {
    const previousDocument = globalThis.document;
    let accountState = {
        isReady: true,
        accountId: 'account-123',
        sessionVerified: true,
        status: 'unlocked',
        oauthEmail: 'member@example.com'
    };
    let accountListener = null;
    const documentListeners = new Map();
    const elements = new Map();
    const documentImpl = {
        activeElement: null,
        getElementById(id) { return elements.get(id) || null; },
        addEventListener(type, listener) { documentListeners.set(type, listener); },
        removeEventListener(type, listener) {
            if (documentListeners.get(type) === listener) documentListeners.delete(type);
        }
    };
    const accountItem = createElement(documentImpl);
    const membershipItem = createElement(documentImpl);
    const logoutItem = createElement(documentImpl);
    const menu = createElement(documentImpl, {
        hidden: true,
        children: [accountItem, membershipItem, logoutItem]
    });
    const tab = createElement(documentImpl);
    const settings = createElement(documentImpl, { hidden: true });
    const label = createElement(documentImpl);
    const overlay = createElement(documentImpl);
    const nav = createElement(documentImpl, { children: [tab, settings, menu] });
    elements.set('account-nav', nav);
    elements.set('account-tab-btn', tab);
    elements.set('account-settings-btn', settings);
    elements.set('account-settings-menu', menu);
    elements.set('account-security-menu-item', accountItem);
    elements.set('account-logout-menu-item', logoutItem);
    elements.set('account-identity-label', label);
    elements.set('account-modal', overlay);

    const refreshedSlots = [];
    const accountService = {
        getState: () => ({ ...accountState }),
        subscribe(listener) { accountListener = listener; return () => { accountListener = null; }; },
        clearErrors() {},
        async clearLocalAccount() {}
    };
    const syncService = {
        getStatus: () => ({}),
        subscribe() { return () => {}; }
    };
    globalThis.document = documentImpl;
    const modal = new AccountModal({
        services: { account: accountService, sync: syncService },
        extensionSlots: { refresh: name => refreshedSlots.push(name) },
        showToast() {}
    });

    try {
        assert.equal(label.textContent, 'member@example.com');
        assert.equal(settings.hidden, false);
        assert.equal(modal.getAccountMenuReturnTarget(), settings);

        settings.onclick();
        assert.equal(menu.hidden, false);
        assert.equal(settings.getAttribute('aria-expanded'), 'true');
        assert.equal(accountItem.focusCount, 1);
        assert.deepEqual(refreshedSlots, [SLOT_NAMES.ACCOUNT_MENU_ACTIONS]);

        menu.onkeydown({ key: 'ArrowDown', target: accountItem, preventDefault() {} });
        assert.equal(membershipItem.focusCount, 1);

        menu.onkeydown({ key: 'Escape', target: membershipItem, preventDefault() {} });
        assert.equal(menu.hidden, true);
        assert.equal(settings.getAttribute('aria-expanded'), 'false');
        assert.equal(settings.focusCount, 1);

        settings.onclick();
        documentListeners.get('pointerdown')({ target: {} });
        assert.equal(menu.hidden, true);

        accountState = { isReady: true, accountId: null, sessionVerified: false, status: 'none' };
        accountListener({ ...accountState });
        assert.equal(label.textContent, 'Account');
        assert.equal(settings.hidden, true);
        assert.equal(menu.hidden, true);
    } finally {
        modal.destroy();
        globalThis.document = previousDocument;
    }
});
