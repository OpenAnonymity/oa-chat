import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import AccountModal from '../../chat/components/AccountModal.js';
import { SLOT_NAMES } from '../../chat/extensions/extensionHost.js';

test('account footer rings are keyboard-only and never frame the full row, including high contrast', () => {
    const css = readFileSync('chat/styles.css', 'utf8');
    const focusRule = css.match(/\.account-tab-btn:focus-visible\s*\{([^}]+)\}/)?.[1];
    assert.ok(focusRule);
    assert.match(focusRule, /outline: none/);
    assert.doesNotMatch(focusRule, /background(?:-color)?:|box-shadow:|border:/);
    const avatarFocusRule = css.match(/html\[data-keyboard-nav\] \.account-tab-btn:focus-visible \.account-tab-avatar\s*\{([^}]+)\}/)?.[1];
    assert.ok(avatarFocusRule);
    assert.match(avatarFocusRule, /outline: 2px solid hsl\(var\(--color-focus-ring\)\)/);
    assert.match(avatarFocusRule, /outline-offset: 2px/);
    assert.match(css, /@media \(forced-colors: active\)\s*\{\s*html\[data-keyboard-nav\] \.account-tab-btn:focus-visible \.account-tab-avatar\s*\{\s*outline: 2px solid Highlight/);
    assert.doesNotMatch(css, /(^|,\s*)\.account-tab-btn:focus-visible \.account-tab-avatar\s*\{/m);
    assert.doesNotMatch(css, /data-auth-restored-focus|data-pointer-focus/);
});

test('account menu items show focus and tint only during keyboard navigation, hover always', () => {
    const css = readFileSync('chat/styles.css', 'utf8');
    assert.match(css, /html\[data-keyboard-nav\] \.account-menu-item:focus-visible\s*\{\s*outline: 2px solid/);
    assert.match(css, /\.account-menu-item:hover,\s*html\[data-keyboard-nav\] \.account-menu-item:focus-visible\s*\{\s*background:/);
    assert.doesNotMatch(css, /(^|,\s*)\.account-menu-item:focus-visible\s*\{/m);
    // The core Account item is hidden with [hidden] once an extension mounts the
    // account surface; the class's display:flex must not win over it, or the
    // menu shows two Account entries.
    assert.match(css, /\.account-menu-item\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
    assert.ok(css.indexOf('.account-menu-item[hidden]') < css.indexOf('.account-menu-item {'));
    // The untitled unlock card is not drawn while the automatic prompt is up.
    assert.match(css, /\.account-unlock-card-untitled\[data-waiting="true"\]\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none/s);
    assert.match(css, /\.account-unlock-waiting\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*place-items:\s*center;[^}]*pointer-events:\s*none/s);
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
            return selector.includes('[role="menuitem"]')
                ? this.children.filter(child => !selector.includes(':not([hidden])') || !child.hidden)
                : [];
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
    elements.set('account-security-menu-item', accountItem);
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

test('authentication focus returns to the footer without any marker attributes', () => {
    const h = createFocusHarness({ accountId: 'test', sessionVerified: true, status: 'unlocked' });
    const { modal, tab, documentImpl, accountItem, menu } = h;
    try {
        modal.close({ afterAuthentication: true });
        assert.equal(modal.isOpen, false);
        assert.equal(documentImpl.activeElement, tab);
        assert.equal(tab.getAttribute('data-auth-restored-focus'), null, 'Ring visibility is html[data-keyboard-nav], not a per-element marker');

        tab.onkeydown({ key: 'ArrowDown', preventDefault() {} });
        assert.equal(documentImpl.activeElement, accountItem);
        assert.equal(menu.hidden, false);
        modal.handleAccountMenuKeydown({ key: 'Escape', target: accountItem, preventDefault() {} });
        assert.equal(documentImpl.activeElement, tab);
        assert.equal(menu.hidden, true);
    } finally { h.cleanup(); }
});

test('pointer and keyboard menu opening both focus the first item and set no pointer marker', () => {
    const h = createFocusHarness({ accountId: 'test', sessionVerified: true, status: 'unlocked' });
    try {
        const membershipItem = createElement(h.documentImpl);
        h.menu.children.push(membershipItem);
        h.modal.close({ afterAuthentication: true });
        h.tab.onclick({ detail: 1 }); // Native mouse/touch click.
        assert.equal(h.menu.hidden, false);
        assert.equal(h.documentImpl.activeElement, h.accountItem, 'Keep focus for accessible menu navigation');
        assert.equal(h.menu.getAttribute('data-pointer-focus'), null);
        assert.equal(h.menu.onpointerdown, undefined);

        for (const [key, expected] of [['ArrowDown', membershipItem], ['ArrowUp', h.accountItem], ['End', membershipItem], ['Home', h.accountItem]]) {
            h.menu.onkeydown({ key, target: h.documentImpl.activeElement, preventDefault() {} });
            assert.equal(h.documentImpl.activeElement, expected, key);
        }
        h.menu.onkeydown({ key: 'Escape', target: h.accountItem, preventDefault() {} });
        assert.equal(h.menu.hidden, true);
        assert.equal(h.documentImpl.activeElement, h.tab);

        for (const key of ['ArrowDown', 'Enter', ' ']) {
            h.tab.onkeydown({ key, preventDefault() {} });
            assert.equal(h.menu.hidden, false, key);
            assert.equal(h.documentImpl.activeElement, h.accountItem, key);
            h.modal.closeAccountMenu(true);
        }
        h.tab.onclick({ detail: 1 });
        h.menu.onkeydown({ key: 'Tab', target: h.accountItem });
        assert.equal(h.menu.hidden, true);
    } finally { h.cleanup(); }
});

test('standalone account menu retains the core Account route when no extension is mounted', () => {
    const h = createFocusHarness({ accountId: 'test', sessionVerified: true, status: 'unlocked' });
    let opened = 0;
    try {
        h.modal.open = () => { opened += 1; };
        h.tab.onclick();
        assert.equal(h.accountItem.hidden, false);
        assert.equal(h.documentImpl.activeElement, h.accountItem);
        h.accountItem.onclick();
        assert.equal(opened, 1);
        assert.equal(h.menu.hidden, true);
    } finally { h.cleanup(); }
});

test('ordinary dismissal and non-footer authentication return targets restore focus', () => {
    const h = createFocusHarness();
    try {
        h.modal.close();
        assert.equal(h.documentImpl.activeElement, h.tab);

        const otherTarget = createElement(h.documentImpl);
        h.modal.isOpen = true;
        h.modal.returnFocusEl = otherTarget;
        h.modal.close({ afterAuthentication: true });
        assert.equal(h.documentImpl.activeElement, otherTarget);
    } finally { h.cleanup(); }
});

test('all successful authentication exits restore footer focus without changing Membership routing', async () => {
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
            assert.equal(h.firstAccountReady(), Number(Boolean(entry.first)), entry.handler);
        } finally { h.cleanup(); }
    }
});

test('failed authentication does not move focus', async () => {
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
    let hasCommercialAccountAction = true;
    let accountMenuSlotListener = null;
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
        // The real app hands components a facade (appInterface.js) that exposes
        // only these slot methods — never `extensionSlots` itself.
        refreshExtensionSlot: name => refreshedSlots.push(name),
        hasExtensionSlotNode(name, selector) {
            assert.equal(name, SLOT_NAMES.ACCOUNT_MENU_ACTIONS);
            assert.equal(selector, '[role="menuitem"]:not([disabled]):not([hidden])');
            return hasCommercialAccountAction;
        },
        subscribeExtensionSlot(name, listener) {
            assert.equal(name, SLOT_NAMES.ACCOUNT_MENU_ACTIONS);
            accountMenuSlotListener = listener;
            return () => { accountMenuSlotListener = null; };
        },
        showToast() {}
    });

    try {
        assert.equal(label.textContent, 'member@example.com');
        assert.equal(modal.getAccountIdentityLabel(), 'member@example.com');
        assert.equal(bootstrapStatus.textContent, '');
        assert.equal(modal.getAccountMenuReturnTarget(), tab);

        tab.onclick();
        assert.equal(menu.hidden, false);
        assert.equal(accountItem.hidden, true);
        assert.equal(tab.getAttribute('aria-expanded'), 'true');
        assert.equal(membershipItem.focusCount, 1);
        assert.deepEqual(refreshedSlots, [SLOT_NAMES.ACCOUNT_MENU_ACTIONS]);

        // If the commercial action disappears while the menu is open, the
        // standalone Account route becomes available immediately.
        hasCommercialAccountAction = false;
        accountMenuSlotListener();
        assert.equal(accountItem.hidden, false);
        hasCommercialAccountAction = true;
        accountMenuSlotListener();
        assert.equal(accountItem.hidden, true);

        menu.onkeydown({ key: 'Escape', target: membershipItem, preventDefault() {} });
        assert.equal(menu.hidden, true);
        assert.equal(tab.focusCount, 1);

        tab.onclick();
        assert.equal(menu.hidden, false);
        assert.equal(tab.getAttribute('aria-expanded'), 'true');
        assert.equal(membershipItem.focusCount, 2);
        assert.deepEqual(refreshedSlots, [
            SLOT_NAMES.ACCOUNT_MENU_ACTIONS,
            SLOT_NAMES.ACCOUNT_MENU_ACTIONS
        ]);

        menu.onkeydown({ key: 'ArrowDown', target: membershipItem, preventDefault() {} });
        assert.equal(logoutItem.focusCount, 1);

        menu.onkeydown({ key: 'Escape', target: logoutItem, preventDefault() {} });
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

test('identity labels are exposed only for a verified, unlocked account', () => {
    const modal = Object.create(AccountModal.prototype);
    for (const [state, expected] of [
        [{ authBootstrapComplete: false, accountId: 'cached', sessionVerified: true, status: 'unlocked', username: 'cached-name' }, ''],
        [{ authBootstrapComplete: true, accountId: 'locked', sessionVerified: true, status: 'locked', username: 'locked-name' }, ''],
        [{ authBootstrapComplete: true, accountId: null, sessionVerified: false, status: 'none', oauthEmail: 'old@example.com' }, ''],
        [{ authBootstrapComplete: true, accountId: 'ready', sessionVerified: true, status: 'unlocked', username: ' member ' }, 'member'],
        [{ authBootstrapComplete: true, accountId: 'ready', sessionVerified: true, status: 'unlocked', oauthEmail: ' member@example.com ' }, 'member@example.com']
    ]) {
        modal.accountState = state;
        assert.equal(modal.getAccountIdentityLabel(), expected);
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
        assert.equal(modal.getAccountIdentityLabel(), 'member@example.com');
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
