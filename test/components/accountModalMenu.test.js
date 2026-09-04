import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import AccountModal from '../../chat/components/AccountModal.js';
import { SLOT_NAMES } from '../../chat/extensions/extensionHost.js';

test('account footer only outlines the avatar outside automatic post-auth focus, including high contrast', () => {
    const css = readFileSync('chat/styles.css', 'utf8');
    const focusRule = css.match(/\.account-tab-btn:focus-visible\s*\{([^}]+)\}/)?.[1];
    assert.ok(focusRule);
    assert.match(focusRule, /outline: none/);
    assert.doesNotMatch(focusRule, /background(?:-color)?:|box-shadow:|border:/);
    const avatarFocusRule = css.match(/\.account-tab-btn:focus-visible:not\(\[data-auth-restored-focus\]\) \.account-tab-avatar\s*\{([^}]+)\}/)?.[1];
    assert.ok(avatarFocusRule);
    assert.match(avatarFocusRule, /outline: 2px solid hsl\(var\(--color-ring\)\)/);
    assert.match(avatarFocusRule, /outline-offset: 2px/);
    assert.match(css, /@media \(forced-colors: active\)\s*\{\s*\.account-tab-btn:focus-visible:not\(\[data-auth-restored-focus\]\) \.account-tab-avatar\s*\{\s*outline: 2px solid Highlight/);
    assert.doesNotMatch(css, /\.account-tab-btn:focus-visible \.account-tab-avatar\s*\{/);
    assert.doesNotMatch(css, /\.account-tab-btn:focus-visible\s*,\s*\.account-menu-item:focus-visible/);
});

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
            if (documentImpl.activeElement !== this) documentImpl.activeElement?.onblur?.();
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

function createFocusHarness(state = {}) {
    const previousDocument = globalThis.document;
    const elements = new Map();
    const documentImpl = {
        activeElement: null,
        getElementById(id) { return elements.get(id) || null; },
        addEventListener() {},
        removeEventListener() {}
    };
    const tab = createElement(documentImpl);
    const overlay = createElement(documentImpl);
    const accountItem = createElement(documentImpl);
    const menu = createElement(documentImpl, { hidden: true, children: [accountItem] });
    elements.set('account-tab-btn', tab);
    elements.set('account-modal', overlay);
    elements.set('account-settings-menu', menu);
    globalThis.document = documentImpl;
    const modal = Object.create(AccountModal.prototype);
    let firstAccountReady = 0;
    Object.assign(modal, {
        isOpen: true, overlay, returnFocusEl: tab, animationTimeouts: [],
        loginViewVersion: 0, menuOpen: false, accountState: state,
        app: { showToast() {}, notifyFirstAccountReady() { firstAccountReady += 1; } },
        accountService: { getState: () => state, clearErrors() {} },
        render() {}
    });
    modal.attachAccountNavListeners();
    return {
        modal, tab, overlay, menu, accountItem, documentImpl,
        firstAccountReady: () => firstAccountReady,
        cleanup() { globalThis.document = previousDocument; }
    };
}

test('automatic authentication focus stays on the footer without a highlight until keyboard use or blur', () => {
    const h = createFocusHarness({ accountId: 'test', sessionVerified: true, status: 'unlocked' });
    const { modal, tab, documentImpl, accountItem, menu } = h;
    try {
        let markerAtFocus;
        const focus = tab.focus.bind(tab);
        tab.focus = () => { markerAtFocus = tab.getAttribute('data-auth-restored-focus'); focus(); };
        modal.close({ afterAuthentication: true });
        assert.equal(modal.isOpen, false);
        assert.equal(documentImpl.activeElement, tab);
        assert.equal(markerAtFocus, 'true', 'Suppress before restoring focus, not after a flash');

        tab.onkeydown({ key: 'ArrowDown', preventDefault() {} });
        assert.equal(tab.getAttribute('data-auth-restored-focus'), null);
        assert.equal(documentImpl.activeElement, accountItem);
        assert.equal(menu.hidden, false);
        modal.handleAccountMenuKeydown({ key: 'Escape', target: accountItem, preventDefault() {} });
        assert.equal(documentImpl.activeElement, tab);
        assert.equal(tab.getAttribute('data-auth-restored-focus'), null);

        // The same account can unlock again; leaving then returning must not
        // suppress a later keyboard focus (including Tab/Shift+Tab).
        modal.isOpen = true;
        modal.returnFocusEl = tab;
        modal.close({ afterAuthentication: true });
        createElement(documentImpl).focus();
        assert.equal(tab.getAttribute('data-auth-restored-focus'), null);
        tab.focus();
        assert.equal(tab.getAttribute('data-auth-restored-focus'), null);
    } finally { h.cleanup(); }
});

test('ordinary dismissal and non-footer authentication return targets retain normal focus', () => {
    const h = createFocusHarness();
    try {
        h.modal.close();
        assert.equal(h.documentImpl.activeElement, h.tab);
        assert.equal(h.tab.getAttribute('data-auth-restored-focus'), null);

        const otherTarget = createElement(h.documentImpl);
        h.modal.isOpen = true;
        h.modal.returnFocusEl = otherTarget;
        h.modal.close({ afterAuthentication: true });
        assert.equal(h.documentImpl.activeElement, otherTarget);
        assert.equal(otherTarget.getAttribute('data-auth-restored-focus'), null);
        assert.equal(h.tab.getAttribute('data-auth-restored-focus'), null);
    } finally { h.cleanup(); }
});

test('all successful authentication exits quietly restore footer focus without changing Membership routing', async () => {
    const cases = [
        { handler: 'handleAccountPasskeyUnlock', method: 'unlockWithUsername', state: { username: 'member' } },
        { handler: 'handleAccountPasskeyUnlock', method: 'unlockWithPasskey' },
        { handler: 'handleAccountRecoveryUnlock', method: 'unlockWithRecoveryCode' },
        { handler: 'handleOAuthRecoveryUnlock', method: 'unlockOAuthWithRecoveryCode' },
        { handler: 'handleOAuthKeyringUnlock', method: 'unlockOAuthKeyring' },
        { handler: 'handleOAuthKeyringUnlock', method: 'unlockWithPasskey', state: { oauthLegacyPasskeyRequired: true } },
        { handler: 'handleOAuthKeyringUnlock', method: 'setupOAuthKeyring', state: { oauthSetupRequired: true }, first: true },
        { handler: 'handleOAuthAuthentication', method: 'authenticateWithOAuth', result: { status: 'unlocked' } },
        { handler: 'handleOAuthAuthentication', method: 'authenticateWithOAuth', result: { status: 'unlocked', newAccount: true }, first: true },
        { handler: 'completeFirstAccountRouting', first: true }
    ];
    for (const entry of cases) {
        const h = createFocusHarness({ accountId: 'test', ...entry.state });
        try {
            if (entry.method) h.modal.accountService[entry.method] = async () => entry.result ?? true;
            await h.modal[entry.handler]();
            assert.equal(h.modal.isOpen, false, entry.handler);
            assert.equal(h.documentImpl.activeElement, h.tab, entry.handler);
            assert.equal(h.tab.getAttribute('data-auth-restored-focus'), 'true', entry.handler);
            assert.equal(h.firstAccountReady(), Number(Boolean(entry.first)), entry.handler);
        } finally { h.cleanup(); }
    }
});

test('failed authentication does not mark the footer or move focus', async () => {
    for (const entry of [
        { handler: 'handleAccountPasskeyUnlock', method: 'unlockWithUsername', state: { username: 'member' } },
        { handler: 'handleOAuthKeyringUnlock', method: 'unlockOAuthKeyring' },
        { handler: 'handleOAuthAuthentication', method: 'authenticateWithOAuth' }
    ]) {
        const h = createFocusHarness({ accountId: 'test', ...entry.state });
        try {
            h.modal.accountService[entry.method] = async () => false;
            h.overlay.focus();
            await h.modal[entry.handler]();
            assert.equal(h.modal.isOpen, true);
            assert.equal(h.documentImpl.activeElement, h.overlay);
            assert.equal(h.tab.getAttribute('data-auth-restored-focus'), null);
            assert.equal(h.firstAccountReady(), 0);
        } finally { h.cleanup(); }
    }
});

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
