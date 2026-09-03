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
        removeAttribute(name) { attributes.delete(name); },
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
    const label = createElement(documentImpl);
    const bootstrapStatus = createElement(documentImpl);
    const overlay = createElement(documentImpl);
    const nav = createElement(documentImpl, { children: [tab, menu] });
    elements.set('account-nav', nav);
    elements.set('account-tab-btn', tab);
    elements.set('account-settings-menu', menu);
    elements.set('account-security-menu-item', accountItem);
    elements.set('account-logout-menu-item', logoutItem);
    elements.set('account-identity-label', label);
    elements.set('account-bootstrap-status', bootstrapStatus);
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
        assert.equal(bootstrapStatus.textContent, '');
        assert.equal(modal.getAccountMenuReturnTarget(), tab);

        tab.onclick();
        assert.equal(menu.hidden, false);
        assert.equal(tab.getAttribute('aria-expanded'), 'true');
        assert.equal(accountItem.focusCount, 1);
        assert.deepEqual(refreshedSlots, [SLOT_NAMES.ACCOUNT_MENU_ACTIONS]);

        menu.onkeydown({ key: 'Escape', target: accountItem, preventDefault() {} });
        assert.equal(menu.hidden, true);
        assert.equal(tab.focusCount, 1);

        tab.onclick();
        assert.equal(menu.hidden, false);
        assert.equal(tab.getAttribute('aria-expanded'), 'true');
        assert.equal(accountItem.focusCount, 2);
        assert.deepEqual(refreshedSlots, [
            SLOT_NAMES.ACCOUNT_MENU_ACTIONS,
            SLOT_NAMES.ACCOUNT_MENU_ACTIONS
        ]);

        menu.onkeydown({ key: 'ArrowDown', target: accountItem, preventDefault() {} });
        assert.equal(membershipItem.focusCount, 1);

        menu.onkeydown({ key: 'Escape', target: membershipItem, preventDefault() {} });
        assert.equal(menu.hidden, true);
        assert.equal(tab.getAttribute('aria-expanded'), 'false');
        assert.equal(tab.focusCount, 2);

        tab.onclick();
        documentListeners.get('pointerdown')({ target: {} });
        assert.equal(menu.hidden, true);

        accountState = {
            isReady: true,
            accountId: 'account-123',
            sessionVerified: true,
            status: 'locked',
            oauthKeyringRequired: true
        };
        accountListener({ ...accountState });
        assert.equal(label.textContent, 'Unlock encrypted data');
        assert.equal(tab.dataset.status, 'locked');
        assert.equal(tab.getAttribute('aria-label'), 'Unlock encrypted data; Google is signed in');
        assert.equal(tab.getAttribute('aria-controls'), 'account-modal');
        assert.equal(tab.getAttribute('aria-haspopup'), null);

        accountState = { isReady: true, accountId: null, sessionVerified: false, status: 'none' };
        accountListener({ ...accountState });
        assert.equal(label.textContent, 'Account');
        assert.equal(menu.hidden, true);
    } finally {
        modal.destroy();
        globalThis.document = previousDocument;
    }
});

test('account footer stays stable while cached identity verification settles', () => {
    const previousDocument = globalThis.document;
    const elements = new Map();
    const documentImpl = {
        getElementById(id) { return elements.get(id) || null; }
    };
    const tab = createElement(documentImpl);
    const label = createElement(documentImpl);
    const bootstrapStatus = createElement(documentImpl);
    const menu = createElement(documentImpl, { hidden: true });
    elements.set('account-tab-btn', tab);
    elements.set('account-identity-label', label);
    elements.set('account-bootstrap-status', bootstrapStatus);
    elements.set('account-settings-menu', menu);
    globalThis.document = documentImpl;

    const modal = Object.create(AccountModal.prototype);
    modal.menuOpen = false;
    modal.accountMenuTrigger = null;
    modal.accountState = {
        isReady: true,
        authBootstrapComplete: false,
        accountId: 'account-123',
        sessionVerified: false,
        status: 'unlocked',
        oauthEmail: 'member@example.com'
    };

    try {
        modal.updateTabIndicator();
        assert.equal(label.textContent, '');
        assert.equal(bootstrapStatus.textContent, 'Restoring account');
        assert.equal(tab.dataset.status, 'loading');
        assert.equal(tab.disabled, false);
        assert.equal(tab.getAttribute('aria-busy'), 'true');
        assert.equal(tab.getAttribute('aria-label'), 'Restoring account');
        assert.equal(tab.getAttribute('aria-haspopup'), null);

        modal.accountState = {
            ...modal.accountState,
            authBootstrapComplete: true,
            sessionVerified: true
        };
        modal.updateTabIndicator();
        assert.equal(label.textContent, 'member@example.com');
        assert.equal(bootstrapStatus.textContent, '');
        assert.equal(tab.dataset.status, 'logged-in');
        assert.equal(tab.disabled, false);
        assert.equal(tab.getAttribute('aria-busy'), null);
        assert.equal(tab.getAttribute('aria-haspopup'), 'menu');

        modal.accountState = {
            isReady: true,
            authBootstrapComplete: true,
            accountId: null,
            sessionVerified: false,
            status: 'none'
        };
        modal.updateTabIndicator();
        assert.equal(label.textContent, 'Account');
        assert.equal(tab.dataset.status, 'none');
        assert.equal(tab.disabled, false);
    } finally {
        globalThis.document = previousDocument;
    }
});

test('clicking the account footer during restoration opens progress then rerenders safely', () => {
    const previousDocument = globalThis.document;
    let accountState = {
        isReady: true,
        authBootstrapComplete: false,
        accountId: 'account-123',
        sessionVerified: true,
        status: 'unlocked',
        oauthEmail: 'member@example.com'
    };
    let accountListener = null;
    const elements = new Map();
    const documentImpl = {
        activeElement: null,
        getElementById(id) { return elements.get(id) || null; },
        addEventListener() {},
        removeEventListener() {}
    };
    const tab = createElement(documentImpl);
    const label = createElement(documentImpl);
    const menu = createElement(documentImpl, { hidden: true });
    const overlay = createElement(documentImpl);
    const nav = createElement(documentImpl, { children: [tab, menu] });
    elements.set('account-nav', nav);
    elements.set('account-tab-btn', tab);
    elements.set('account-settings-menu', menu);
    elements.set('account-identity-label', label);
    elements.set('account-modal', overlay);
    globalThis.document = documentImpl;

    const modal = new AccountModal({
        services: {
            account: {
                getState: () => ({ ...accountState }),
                subscribe(listener) { accountListener = listener; return () => {}; },
                clearErrors() {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        },
        refreshExtensionSlot() {}
    });
    modal.escapeHtml = value => String(value ?? '');

    try {
        assert.equal(modal.isAccountMenuAvailable(), false);
        assert.equal(tab.disabled, false);
        tab.onclick();
        assert.equal(modal.isOpen, true);
        assert.equal(menu.hidden, true);
        assert.match(overlay.innerHTML, /Restoring your account…/);
        assert.doesNotMatch(overlay.innerHTML, /Log out/);

        accountState = { ...accountState, authBootstrapComplete: true };
        accountListener({ ...accountState });
        assert.match(overlay.innerHTML, /account-compact-identity/);
        assert.match(overlay.innerHTML, /member@example\.com/);
        assert.match(overlay.innerHTML, /Log out/);
    } finally {
        modal.destroy();
        globalThis.document = previousDocument;
    }
});

test('account dialog traps keyboard focus and restores the focused control after rerender', () => {
    const previousDocument = globalThis.document;
    const elements = new Map();
    const documentImpl = {
        activeElement: null,
        getElementById(id) { return elements.get(id) || null; }
    };
    const first = createElement(documentImpl);
    first.id = 'close-account-modal';
    const last = createElement(documentImpl);
    last.id = 'oauth-keyring-submit-btn';
    const dialog = createElement(documentImpl);
    const overlay = createElement(documentImpl, { children: [first, last, dialog] });
    overlay.querySelectorAll = () => [first, last];
    overlay.querySelector = selector => selector === '[role="dialog"]' ? dialog : null;
    const modal = Object.create(AccountModal.prototype);
    modal.isOpen = true;
    modal.overlay = overlay;
    modal.handleCloseAttempt = () => {};
    elements.set(first.id, first);
    elements.set(last.id, last);
    globalThis.document = documentImpl;

    try {
        let prevented = false;
        documentImpl.activeElement = last;
        modal.handleModalKeydown({
            key: 'Tab',
            shiftKey: false,
            preventDefault() { prevented = true; }
        });
        assert.equal(prevented, true);
        assert.equal(documentImpl.activeElement, first);

        prevented = false;
        modal.handleModalKeydown({
            key: 'Tab',
            shiftKey: true,
            preventDefault() { prevented = true; }
        });
        assert.equal(prevented, true);
        assert.equal(documentImpl.activeElement, last);

        documentImpl.activeElement = first;
        modal.focusModal('oauth-keyring-submit-btn');
        assert.equal(documentImpl.activeElement, last);
    } finally {
        globalThis.document = previousDocument;
    }
});
