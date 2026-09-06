import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import AccountModal from '../../chat/components/AccountModal.js';
import { SLOT_NAMES } from '../../chat/extensions/extensionHost.js';
import { toFriendlyOAuthError } from '../../chat/services/accountService.js';

test('account restoration renders an operable neutral progress dialog', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        authBootstrapComplete: false,
        accountId: 'account-123',
        sessionVerified: false,
        status: 'unlocked',
        oauthEmail: 'member@example.com'
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderAccountUI();
        assert.match(html, /Restoring your account…/);
        assert.match(html, /member@example\.com/);
        assert.match(html, /aria-busy="true"/);
        assert.doesNotMatch(html, /Continue with Google/);
        assert.doesNotMatch(html, /Log out/);
        assert.doesNotMatch(html, /Synchronization/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('account rerenders refresh the commercial slot through the UI facade', () => {
    const source = String(AccountModal.prototype.render);
    assert.match(source, /refreshExtensionSlot\?\.\(SLOT_NAMES\.ACCOUNT_COMMERCIAL\)/);
    assert.match(source, /actionRow\?\.parentNode/);
    assert.match(source, /actionParent\.insertBefore\(commercialSlot, actionRow\)/);
    assert.doesNotMatch(source, /dialog\.insertBefore\(commercialSlot, actionRow\)/);
    assert.doesNotMatch(source, /extensionSlots/);
    // The whole component must stay on the facade: `app.extensionSlots` is
    // undefined in the real app, which silently disabled the menu-item sync.
    assert.doesNotMatch(String(AccountModal), /this\.app\.extensionSlots/);
    assert.match(String(AccountModal.prototype.syncCoreAccountMenuItem), /this\.app\.hasExtensionSlotNode\?\.\(/);
    assert.match(String(AccountModal.prototype.openAccountMenu), /this\.app\.refreshExtensionSlot\?\.\(SLOT_NAMES\.ACCOUNT_MENU_ACTIONS\)/);
});

test('signed-in Account opens beside the nested action row without backdrop dismissal', () => {
    const originalDocument = globalThis.document;
    const inserted = [];
    const refreshed = [];
    const actionParent = {
        insertBefore(node, reference) {
            inserted.push({ node, reference });
        }
    };
    const actionRow = { parentNode: actionParent };
    const dialog = {
        focus() {},
        appendChild() {
            throw new Error('The nested action row must use its own parent');
        },
        querySelector(selector) {
            return selector === '[data-account-actions]' ? actionRow : null;
        }
    };
    const removedClasses = [];
    const overlay = {
        onclick: null,
        classList: {
            add() {},
            remove(name) { removedClasses.push(name); }
        },
        contains() { return false; },
        querySelector(selector) {
            return selector === '[role="dialog"]' ? dialog : null;
        },
        querySelectorAll() { return []; },
        set innerHTML(value) { this.html = value; }
    };
    const state = {
        authBootstrapComplete: true,
        accountId: 'account-123',
        sessionVerified: true,
        status: 'unlocked',
        googleLinked: true,
        encryptionMode: 'PRF',
        passkeySupported: true,
        busy: false,
        action: null
    };
    globalThis.document = {
        activeElement: null,
        createElement() {
            return { dataset: {}, hidden: false };
        },
        getElementById(id) {
            return id === 'account-modal' ? overlay : null;
        },
        addEventListener() {},
        removeEventListener() {}
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {},
                clearErrors() {}
            },
            sync: {
                getStatus: () => ({
                    syncing: false,
                    lastSyncTime: null,
                    lastSyncResult: null
                }),
                subscribe: () => () => {}
            }
        },
        refreshExtensionSlot(name) {
            refreshed.push(name);
        }
    });
    modal.escapeHtml = value => String(value ?? '');

    try {
        modal.open();
        assert.equal(modal.isOpen, true);
        assert.deepEqual(removedClasses, ['hidden']);
        assert.equal(overlay.onclick, null);
        assert.equal(inserted.length, 1);
        assert.equal(inserted[0].reference, actionRow);
        assert.equal(inserted[0].node.dataset.oaExtensionSlot, SLOT_NAMES.ACCOUNT_COMMERCIAL);
        assert.deepEqual(refreshed, [SLOT_NAMES.ACCOUNT_COMMERCIAL]);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('account entry offers Google and pseudonymous username passkeys', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        accountId: null,
        passkeySupported: true,
        busy: false,
        action: null,
        error: null
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderAccountUI();
        assert.match(html, /Continue with Google/);
        assert.match(html, /Username/);
        assert.match(html, />Log in<\/h2>/);
        assert.match(html, /placeholder="Enter a username"/);
        assert.match(html, /aria-label="Username"/);
        assert.match(html, /class="account-login-heading"/);
        assert.match(html, /account-login-dialog"\s*>/);
        assert.match(html, /id="account-google-btn"[\s\S]*class="account-login-divider" aria-hidden="true">or<\/div>[\s\S]*id="account-username-input"/);
        // The field stands alone; the filled Continue button follows it, like the landing card.
        assert.match(html, /class="account-login-control">[\s\S]*id="account-username-input"[\s\S]*<\/div>\s*<button id="account-passkey-btn" class="account-login-submit" type="button" aria-busy="false"\s*>/);
        assert.doesNotMatch(html, /class="account-login-control"[\s\S]*id="account-passkey-btn"[\s\S]*<\/div>\s*<\/div>/);
        assert.match(html, /<span class="account-login-submit-label">Continue with username<\/span>/);
        assert.doesNotMatch(html, /id="account-passkey-btn"[^>]*aria-label=/);
        assert.doesNotMatch(html, /id="account-google-btn"[^>]*hover:bg-accent/);
        assert.match(html, /<span class="account-login-submit-indicator" aria-hidden="true">\s*<svg class="account-login-arrow" viewBox="0 0 16 16"[^>]*fill="none"[^>]*stroke="currentColor"[^>]*stroke-width="1.5"/);
        assert.equal((html.match(/id="account-passkey-btn"/g) || []).length, 1);
        assert.doesNotMatch(html, /bg-blue-600|>\s*Continue\s*<\/button>/);
        assert.doesNotMatch(html, /Sign in to OA|Choose Google|Use a pseudonym|winter-owl/);
        assert.doesNotMatch(html, /<label|Create a passkey account|account-identifier-mode-btn/);
        assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="account-modal-title" tabindex="-1"/);
        assert.match(html, /id="account-modal-title"/);
        assert.doesNotMatch(html, /generate-account-btn/);
        assert.match(html, /account-passkey-btn/);
        assert.doesNotMatch(html, /account-recovery-toggle-btn/);
        assert.doesNotMatch(html, /Five-word recovery code/);
        assert.doesNotMatch(html, /Continue with GitHub/);
        assert.doesNotMatch(html, /account-github-btn/);

        state.busy = true;
        state.error = 'A previous error';
        const busyHtml = modal.renderAccountUI();
        assert.match(busyHtml, /id="account-passkey-btn"[^>]*aria-busy="true"[^>]*disabled/);
        assert.match(busyHtml, /<span class="account-login-submit-indicator" aria-hidden="true"><span class="account-login-spinner"><\/span><\/span>/);
        assert.match(busyHtml, /Continue with username/);
        assert.doesNotMatch(busyHtml, /class="account-login-arrow"/);
        state.busy = false;
        state.passkeySupported = false;
        assert.match(modal.renderAccountUI(), /id="account-passkey-btn"[^>]*disabled/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('username arrow and Enter retain the same Continue handler, and Google remains separate', () => {
    const originalDocument = globalThis.document;
    const nodes = {
        'account-username-input': {},
        'account-passkey-btn': {},
        'account-google-btn': {}
    };
    globalThis.document = { getElementById: id => nodes[id] || null };
    const modal = Object.create(AccountModal.prototype);
    const calls = [];
    modal.handleAccountContinue = () => calls.push(['username', modal.usernameInputValue]);
    modal.handleOAuthAuthentication = provider => calls.push(['oauth', provider]);
    try {
        modal.attachEventListeners();
        nodes['account-username-input'].oninput({ target: { value: 'preview-user' } });
        nodes['account-passkey-btn'].onclick();
        let prevented = false;
        nodes['account-username-input'].onkeydown({ key: 'Enter', preventDefault() { prevented = true; } });
        nodes['account-google-btn'].onclick();
        assert.equal(prevented, true);
        assert.deepEqual(calls, [['username', 'preview-user'], ['username', 'preview-user'], ['oauth', 'google']]);
    } finally {
        globalThis.document = originalDocument;
    }
});

test('account dialogs share one accent focus ring, close control, dark edges and mobile sheet', () => {
    const css = fs.readFileSync('chat/styles.css', 'utf8');
    // Rings are keyboard-only: programmatic focus (dialog open, restore after
    // close, model search) must never draw one, whatever :focus-visible says.
    assert.match(css, /:where\(html\[data-keyboard-nav\] :is\(a\[href\], button, input, select, textarea, summary, \[role="button"\], \[tabindex\]:not\(\[tabindex="-1"\]\)\)\):focus-visible\s*\{[^}]*outline: 2px solid hsl\(var\(--color-focus-ring\)\);[^}]*outline-offset: 2px/);
    assert.match(css, /:where\(html:not\(\[data-keyboard-nav\]\) :is\([^)]*\)\):focus-visible\s*\{[^}]*outline: none/);
    assert.doesNotMatch(css, /^:where\(a\[href\]/m);
    for (const selector of ['.account-unlock-close', '.account-unlock-btn', '.account-unlock-input', '.account-login-submit', '.account-menu-item', '.account-compact-row']) {
        const escaped = selector.replace(/[.\-]/g, '\\$&');
        assert.match(css, new RegExp(`html\\[data-keyboard-nav\\] ${escaped}:focus-visible`), selector);
        assert.doesNotMatch(css, new RegExp(`(^|,\\s*)${escaped}:focus-visible\\s*(,|\\{)`, 'm'), `${selector} ring must be gated`);
    }
    const html = fs.readFileSync('chat/index.html', 'utf8');
    assert.match(html, /root\.setAttribute\('data-keyboard-nav', ''\)/);
    assert.match(html, /addEventListener\('pointerdown', clear, true\)/);
    assert.ok(html.indexOf('data-keyboard-nav') < html.indexOf('tailwind.generated.css'), 'modality script runs before any stylesheet or focus');
    assert.match(css, /html\[data-keyboard-nav\] \.model-picker-search:has\(> #model-search:focus-visible\)/);
    assert.match(css, /html\[data-keyboard-nav\] \.account-login-control:focus-within/);
    assert.match(css, /#close-account-modal\s*\{[^}]*width: 2rem;[^}]*height: 2rem;[^}]*border-radius: 0.625rem/);
    assert.match(css, /\.dark \.account-login-control\s*\{[^}]*border-color: hsl\(0 0% 100% \/ 0.18\)/);
    assert.match(css, /\.dark \.account-login-dialog #account-google-btn\s*\{[^}]*border-color: hsl\(0 0% 100% \/ 0.18\) !important/);
    assert.match(css, /@media \(max-width: 720px\)\s*\{\s*#account-modal\s*\{[^}]*align-items: flex-end;[^}]*padding: 0/);
    assert.match(css, /#account-modal > \[role="dialog"\]\s*\{[^}]*width: 100%;[^}]*max-width: none;[^}]*border-radius: 1.5rem 1.5rem 0 0/);
});

test('opening an account dialog closes the overlay sidebar without persisting the preference', () => {
    const calls = [];
    const make = visible => ({
        app: {
            elements: { sidebar: { classList: { contains: name => visible && name === 'mobile-visible' } } },
            hideSidebar: options => calls.push(options)
        }
    });
    AccountModal.prototype.dismissOverlaySidebar.call(make(true));
    AccountModal.prototype.dismissOverlaySidebar.call(make(false));
    AccountModal.prototype.dismissOverlaySidebar.call({ app: { elements: {} } });
    assert.deepEqual(calls, [{ persist: false }]);
});

test('closing that dialog brings the overlay sidebar back, except after a completed sign-in', () => {
    const shows = [];
    const app = {
        elements: { sidebar: { classList: { contains: name => name === 'mobile-visible' } } },
        hideSidebar() {},
        showSidebar: options => shows.push(options)
    };
    const modal = { app };
    AccountModal.prototype.dismissOverlaySidebar.call(modal);
    AccountModal.prototype.reopenOverlaySidebar.call(modal, {});
    AccountModal.prototype.reopenOverlaySidebar.call(modal, {});
    assert.deepEqual(shows, [{ persist: false }]);

    const authModal = { app };
    AccountModal.prototype.dismissOverlaySidebar.call(authModal);
    AccountModal.prototype.reopenOverlaySidebar.call(authModal, { afterAuthentication: true });
    assert.deepEqual(shows, [{ persist: false }]);
    assert.equal(authModal.restoreOverlaySidebar, false);

    const untouched = { app };
    AccountModal.prototype.reopenOverlaySidebar.call(untouched, {});
    assert.deepEqual(shows, [{ persist: false }]);
});

test('username login uses the narrower reference card with neutral accessible controls', () => {
    const css = fs.readFileSync('chat/styles.css', 'utf8');
    assert.match(css, /\.account-login-dialog\s*\{[^}]*width: calc\(100% - 2rem\);[^}]*max-width: 22.5rem;[^}]*padding: 2rem;[^}]*border-radius: 1.5rem/);
    assert.match(css, /\.account-login-heading\s*\{[^}]*display: flex;[^}]*justify-content: space-between/);
    assert.match(css, /\.account-login-heading > h2\s*\{[^}]*text-align: left/);
    assert.match(css, /\.account-dialog-title\s*\{[^}]*font-size: 1.375rem;[^}]*font-weight: 600;[^}]*line-height: 1.2;[^}]*letter-spacing: -0.01em/);
    assert.match(css, /\.account-unlock-title\s*\{[^}]*font-size: 1.625rem;[^}]*font-weight: 600/);
    assert.match(css, /--font-sans: system-ui, -apple-system, 'SF Pro Text'/);
    assert.match(css, /\.account-login-dialog #account-google-btn\s*\{[^}]*font-size: 0.9375rem/);
    assert.match(css, /\.account-login-dialog #account-google-btn\s*\{[^}]*height: 3rem;[^}]*font-size: 0.9375rem;[^}]*font-weight: 400;[^}]*line-height: 1.25/);
    assert.match(css, /\.account-login-arrow\s*\{[^}]*width: 1.125rem;[^}]*height: 1.125rem/);
    assert.match(css, /\.account-login-heading > button\s*\{[^}]*width: 2rem;[^}]*height: 2rem/);
    assert.match(css, /\.account-login-control\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*height: 3rem/);
    // Filled ink Continue button under the field, matching the landing card.
    assert.match(css, /\.account-login-submit\s*\{[^}]*grid-template-columns: 1\.125rem minmax\(0, 1fr\) 1\.125rem;[^}]*width: 100%;[^}]*height: 3rem;[^}]*margin-top: 0\.625rem;[^}]*border: 1px solid #000;[^}]*border-radius: 0\.75rem;[^}]*background: #000;[^}]*color: #fff;[^}]*font-weight: 500/s);
    assert.match(css, /\.dark \.account-login-submit\s*\{[^}]*background: hsl\(0 0% 100% \/ 0\.92\);[^}]*color: hsl\(222\.2 84% 4\.9%\)/s);
    assert.match(css, /\.account-login-submit:hover:not\(:disabled\)\s*\{[^}]*background: #262626/s);
    assert.doesNotMatch(css, /border-left[^;]*;[^}]*\}[^{]*\.account-login-submit|\.account-login-submit\s*\{[^}]*border-left/);
    assert.match(css, /\.account-login-divider\s*\{[^}]*margin: 0.75rem 0/);
    assert.match(css, /@media \(max-width: 400px\)\s*\{\s*\.account-login-dialog\s*\{\s*padding: 1.5rem/);
    assert.match(css, /\.account-login-input\s*\{[^}]*font-size: 1rem/);
    assert.match(css, /html\[data-keyboard-nav\] \.account-login-submit:focus-visible\s*\{[^}]*outline: 2px solid/);
    assert.match(css, /\.account-login-input:is\(:autofill, :-webkit-autofill\)\s*\{[^}]*box-shadow: inset 0 0 0 1000px hsl\(var\(--color-background\)\)/);
    assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)\s*\{/);
    assert.match(css, /\.account-login-dialog #account-google-btn:hover:not\(:disabled\),\s*\.account-login-dialog \.account-login-control:not\(:focus-within\):hover\s*\{[^}]*background-color: hsl\(var\(--color-foreground\) \/ 0\.03\) !important;[^}]*border-color: hsl\(var\(--color-muted-foreground\) \/ 0\.5\) !important/);
    assert.match(css, /\.account-login-control:not\(:focus-within\):hover \.account-login-input:is\(:autofill, :-webkit-autofill\)\s*\{[^}]*box-shadow:[^}]*hsl\(var\(--color-foreground\) \/ 0\.03\)[^}]*hsl\(var\(--color-background\)\)/);
    assert.match(css, /\.dark \.account-login-dialog #account-google-btn:hover:not\(:disabled\),\s*\.dark \.account-login-dialog \.account-login-control:not\(:focus-within\):hover\s*\{[^}]*background-color: hsl\(0 0% 100% \/ 0\.06\) !important;[^}]*border-color: hsl\(0 0% 100% \/ 0\.3\) !important/);
    assert.doesNotMatch(css, /\.dark \.account-login-dialog #account-google-btn:hover:not\(:disabled\)\s*\{/);
    assert.doesNotMatch(css, /:has\(\.account-login-submit/);
    assert.doesNotMatch(css, /\.account-login-dialog #account-google-btn:hover:not\(:disabled\)[^{]*\{[^}]*(?:box-shadow|transform):/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.account-login-spinner\s*\{\s*animation: none/);
});

test('shared Account and Welcome headings use the aligned title treatment', () => {
    const css = fs.readFileSync('chat/styles.css', 'utf8');
    assert.match(AccountModal.prototype.renderHeader('Account'), /<h2 id="account-modal-title" class="account-dialog-title">Account<\/h2>/);
});

test('ordinary username entry prefills and focuses the username field', () => {
    const originalDocument = globalThis.document;
    const focused = [];
    const usernameInput = { focus() { focused.push('account-username-input'); } };
    globalThis.document = {
        activeElement: null,
        addEventListener() {},
        getElementById(id) {
            return id === 'account-username-input' ? usernameInput : null;
        }
    };
    const state = {
        accountId: null,
        passkeySupported: true,
        busy: false,
        action: null,
        error: null
    };
    const overlay = {
        classList: { remove() {} },
        contains(node) { return node === usernameInput; },
        querySelectorAll() { return []; },
        querySelector() { return null; }
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {},
                clearErrors() {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.overlay = overlay;
    modal.render = () => {};

    try {
        modal.openForUsername('  Winter-OWL  ');
        assert.equal(modal.isOpen, true);
        assert.equal(modal.identifierMode, 'username');
        assert.equal(modal.usernameInputValue, 'winter-owl');
        assert.deepEqual(focused, ['account-username-input']);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('blank username creation cannot fall through to legacy account creation', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById() { return null; } };
    let requestedUsername;
    const state = {
        accountId: null,
        username: null,
        passkeySupported: true,
        busy: false,
        action: null,
        error: null
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {},
                clearErrors() {},
                setError(message) { state.error = message; },
                async prepareUsernameContinuation(username) {
                    requestedUsername = username;
                    throw new Error('Username is required');
                }
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.isOpen = true;
    modal.render = () => {};

    try {
        await modal.handleAccountContinue();
        assert.equal(requestedUsername, '');
        assert.equal(state.error, 'Username is required');
        assert.equal(modal.creationStep, 'idle');
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('first username account completes after one passkey and routes to Membership', async () => {
    const modal = Object.create(AccountModal.prototype);
    modal.isOpen = true;
    let completeCount = 0;
    let recoveryGenerationCount = 0;
    let closed = 0;
    let firstAccountReady = 0;
    modal.generatedUsername = 'winter-owl';
    modal.creationStep = 'passkey';
    modal.creationError = null;
    modal.render = () => {};
    modal.close = () => { closed += 1; };
    modal.accountService = {
        async registerPasskeyForPreparedAccount() { return true; },
        generateRecoveryForPreparedAccount() {
            recoveryGenerationCount += 1;
            return 'should-not-be-generated';
        },
        async completeAccountRegistration() { completeCount += 1; }
    };
    modal.app = {
        showToast() {},
        notifyFirstAccountReady() { firstAccountReady += 1; }
    };

    await modal.handlePasskeyRegistration();

    assert.equal(completeCount, 1);
    assert.equal(recoveryGenerationCount, 0);
    assert.equal(modal.creationStep, 'complete');
    assert.equal(closed, 1);
    assert.equal(firstAccountReady, 1);
});

test('first username setup never displays the username while awaiting or finishing the passkey', () => {
    const modal = Object.create(AccountModal.prototype);
    modal.generatedUsername = 'winter-owl';
    modal.escapeHtml = value => String(value ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    for (const step of ['passkey', 'confirming', 'complete']) {
        modal.creationStep = step;
        const html = modal.renderCreationFlow();
        assert.match(html, /class="account-unlock-card"/);
        assert.match(html, />Encrypt your data<\/h2>/);
        assert.match(html, /Confirm with your passkey to finish\./);
        assert.match(html, /id="account-username-unlock-btn"[^>]*disabled aria-busy="true"/);
        assert.doesNotMatch(html, /winter-owl|Your username|Your account number|Create a passkey account|You're all set/);
    }
    modal.creationStep = 'passkey_retry';
    modal.creationError = '<unavailable>';
    const retry = modal.renderCreationFlow();
    assert.match(retry, /role="alert"/);
    assert.match(retry, /&lt;unavailable&gt;/);
    assert.match(retry, /id="account-username-unlock-btn"/);
    assert.match(retry, /id="account-username-back-btn"/);
    assert.doesNotMatch(retry, /winter-owl|Your username|Setting up your account/);
    modal.creationStep = 'error';
    assert.match(modal.renderCreationFlow(), /id="start-over-btn"/);
});

test('new username registration keeps progress through account/sync notifications until Membership', async () => {
    const originalDocument = globalThis.document;
    let accountListener;
    let syncListener;
    let finishRegistration;
    let firstAccountReady = 0;
    const frames = [];
    const state = { accountId: null, passkeySupported: true };
    globalThis.document = {
        activeElement: null,
        getElementById() { return null; },
        removeEventListener() {}
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe(listener) { accountListener = listener; return () => {}; },
                async registerPasskeyForPreparedAccount() { return true; },
                completeAccountRegistration() {
                    accountListener({ accountId: '1234567890123456', username: 'winter-owl', sessionVerified: true, status: 'unlocked' });
                    syncListener();
                    return new Promise(resolve => { finishRegistration = resolve; });
                }
            },
            sync: {
                getStatus: () => ({}),
                subscribe(listener) { syncListener = listener; return () => {}; }
            }
        },
        showToast() {},
        notifyFirstAccountReady() { firstAccountReady += 1; }
    });
    modal.overlay = {
        contains() { return false; },
        querySelector() { return null; },
        classList: { add() {} },
        set innerHTML(html) { frames.push(html); }
    };
    modal.attachEventListeners = () => {};
    modal.isOpen = true;
    modal.generatedUsername = 'winter-owl';
    modal.creationStep = 'passkey';
    modal.escapeHtml = value => String(value ?? '');
    modal.renderAccountUI = () => { throw new Error('Account summary must not flash during setup'); };
    try {
        modal.render();
        const registration = modal.handlePasskeyRegistration();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(modal.creationStep, 'confirming');
        assert.equal(modal.isOpen, true);
        assert.equal(frames.length, 3); // waiting, confirming, and sync notification
        for (const html of frames) {
            assert.match(html, /Confirm with your passkey to finish\./);
            assert.doesNotMatch(html, /Your username|winter-owl|Your account number/);
        }
        assert.equal(firstAccountReady, 0);
        finishRegistration();
        await registration;
        assert.equal(modal.isOpen, false);
        assert.equal(firstAccountReady, 1);
        assert.equal(frames.at(-1), '');
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

function continuationModal(next = 'register') {
    const modal = Object.create(AccountModal.prototype);
    const calls = [];
    Object.assign(modal, {
        isOpen: true,
        loginViewVersion: 0,
        usernameContinuePending: false,
        identifierMode: 'username',
        usernameInputValue: 'winter-owl',
        creationStep: 'idle',
        accountState: { passkeySupported: true },
        render() {},
        focusModal() {},
        escapeHtml: value => String(value ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        accountService: {
            clearErrors() {},
            setError(message) { calls.push(['error', message]); },
            async prepareUsernameContinuation(username, options) {
                assert.deepEqual(options, { lookupOnly: true });
                calls.push(['prepare', username]);
                return { kind: next };
            },
            async prepareAccount(username) { calls.push(['init', username]); },
            getPendingAccountId() { return '1234567890123456'; },
            getPendingUsername() { return 'winter-owl'; },
            cancelPendingAccount() { calls.push(['cancel']); }
        },
        async handlePasskeyRegistration() { calls.push(['register']); },
        async handleAccountPasskeyUnlock() { calls.push(['login']); return false; }
    });
    return { modal, calls };
}

function landingContinuationModal(next = 'login') {
    const { modal, calls } = continuationModal(next);
    const frames = [];
    Object.assign(modal, {
        isOpen: false,
        overlay: {
            contains() { return false; },
            querySelector() { return null; },
            set innerHTML(html) { frames.push(html); }
        },
        recoveryStep: 'idle',
        render: AccountModal.prototype.render,
        renderAccountUI() { return '<form>Username form</form>'; },
        renderCreationFlow: AccountModal.prototype.renderCreationFlow,
        attachEventListeners() {},
        focusModal() {},
        open() { this.isOpen = true; this.render(); },
        close() {
            this.isOpen = false;
            this.loginViewVersion += 1;
            this.usernameHandoffPending = false;
            this.usernameUnlockReady = false;
        }
    });
    return { modal, calls, frames };
}

test('landing handoff goes straight to the passkey for a returning account; new accounts get the setup card', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { activeElement: null };
    try {
        for (const next of ['login', 'register']) {
            const { modal, calls, frames } = landingContinuationModal(next);
            modal.handleAccountPasskeyUnlock = modal.handlePasskeyRegistration = async () => {
                calls.push([next]);
                modal.render(); // Account/sync updates during the ceremony.
                modal.close();
            };
            await modal.openForUsername(' Winter-OWL ', null, { autoContinue: true });
            assert.match(frames[0], /Checking username…/);
            assert.ok(frames.every(html => !html.includes('Username form')));
            assert.ok(frames.every(html => !html.includes('Welcome back')));
            if (next === 'login') {
                // The lookup resolved to an existing account: the passkey prompt
                // opened at once, behind an untitled "Confirm with your passkey" card.
                assert.deepEqual(calls, [['prepare', 'winter-owl'], ['login']]);
                const waiting = frames.find(html => html.includes('aria-busy="true"'));
                assert.match(waiting, /account-unlock-card-untitled" data-waiting="true"/);
                // Spinner only on the dimmed page; the card itself is not drawn.
                assert.match(waiting, /<div class="account-unlock-waiting" role="status" aria-label="Confirming your passkey"><span class="account-unlock-spinner account-unlock-waiting-spinner" aria-hidden="true"><\/span><\/div>/);
                assert.match(waiting, /aria-label="Unlock your encrypted data"/);
                assert.doesNotMatch(waiting, /<h2/);
                assert.match(waiting, /Confirm with your passkey to continue\./);
                assert.equal(modal.isOpen, false);
            } else {
                assert.deepEqual(calls, [['prepare', 'winter-owl']]);
                assert.match(frames.at(-1), />Encrypt your data<\/h2>/);
                assert.match(frames.at(-1), /encrypts your tickets and preferences/i);
                assert.equal(modal.isOpen, true);
                await modal.handleUsernamePasskeyContinue();
                assert.deepEqual(calls, [['prepare', 'winter-owl'], ['init', 'winter-owl'], ['register']]);
                assert.equal(modal.isOpen, false);
            }
            assert.equal(modal.usernameHandoffPending, false);
        }
    } finally {
        globalThis.document = originalDocument;
    }
});

test('a cancelled username prompt keeps retry on the explanation; lookup errors keep the editable form', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { activeElement: null };
    try {
        for (const failure of ['cancel', 'network']) {
            const { modal, calls, frames } = landingContinuationModal();
            if (failure === 'network') {
                modal.accountService.prepareUsernameContinuation = async () => { throw new Error('Offline'); };
            }
            if (failure === 'cancel') {
                modal.handleAccountPasskeyUnlock = async () => {
                    calls.push(['login']);
                    modal.accountState.error = 'Passkey cancelled';
                };
            }
            await modal.openForUsername('winter-owl', null, { autoContinue: true });
            if (failure === 'cancel') {
                // The automatic prompt was cancelled: retry waits for a click.
                assert.doesNotMatch(frames.at(-1), /Welcome back|<h2/);
                assert.match(frames.at(-1), /account-unlock-card-untitled/);
                assert.doesNotMatch(frames.at(-1), /data-waiting/); // failed: the card is drawn
                assert.doesNotMatch(frames.at(-1), /account-unlock-waiting/);
                assert.match(frames.at(-1), /Try again/);
                assert.match(frames.at(-1), /Passkey wasn't confirmed\./);
                assert.equal(modal.isOpen, true);
            } else {
                assert.equal(frames.at(-1), '<form>Username form</form>');
            }
            assert.equal(modal.usernameHandoffPending, false);
            assert.equal(modal.usernameInputValue, 'winter-owl');
            assert.deepEqual(calls, failure === 'cancel'
                ? [['prepare', 'winter-owl'], ['login']]
                : [['error', 'Offline']]);
        }
    } finally {
        globalThis.document = originalDocument;
    }
});

test('a cancelled automatic username prompt restores focus to Try again', async () => {
    const originalDocument = globalThis.document;
    const body = { id: 'body' };
    const retry = {
        id: 'account-username-unlock-btn',
        focus() { globalThis.document.activeElement = this; }
    };
    globalThis.document = {
        activeElement: body,
        getElementById(id) { return id === retry.id ? retry : null; }
    };
    try {
        const { modal } = continuationModal('login');
        modal.overlay = {
            contains(element) { return element === retry; },
            querySelectorAll() { return [retry]; },
            querySelector() { return null; }
        };
        modal.focusModal = AccountModal.prototype.focusModal;
        modal.handleAccountPasskeyUnlock = async () => {
            globalThis.document.activeElement = body;
            modal.accountState.error = 'Passkey cancelled';
            return false;
        };

        await modal.handleAccountContinue();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(globalThis.document.activeElement, retry);
        assert.equal(modal.usernamePasskeyBusy, false);
        assert.equal(modal.usernameUnlockReady, true);
    } finally {
        globalThis.document = originalDocument;
    }
});

test('landing auto-continue preserves missing-name, unsupported, busy, legacy and Google surfaces', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { activeElement: null };
    try {
        for (const state of [
            { passkeySupported: false }, { busy: true },
            { accountId: '1234567890123456', encryptionMode: 'LEGACY_PASSKEY' },
            { oauthRecoveryRequired: true }, { oauthKeyringRequired: true },
            { oauthSetupRequired: true }, { oauthLegacyPasskeyRequired: true }, {}
        ]) {
            const { modal, calls, frames } = landingContinuationModal();
            Object.assign(modal.accountState, state);
            await modal.openForUsername(Object.keys(state).length ? 'winter-owl' : '', null, { autoContinue: true });
            assert.deepEqual(calls, []);
            assert.deepEqual(frames, ['<form>Username form</form>']);
        }
    } finally {
        globalThis.document = originalDocument;
    }
});

test('closing a landing lookup prevents a late prompt and duplicate handoffs are ignored', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { activeElement: null };
    try {
        const { modal, calls, frames } = landingContinuationModal('register');
        let finishLookup;
        modal.accountService.prepareUsernameContinuation = () => new Promise(resolve => { finishLookup = resolve; });
        const handoff = modal.openForUsername('winter-owl', null, { autoContinue: true });
        await modal.openForUsername('other-name', null, { autoContinue: true });
        assert.equal(modal.usernameInputValue, 'winter-owl');
        modal.close();
        const frameCount = frames.length;
        finishLookup({ kind: 'register' });
        await handoff;
        assert.deepEqual(calls, []);
        assert.equal(frames.length, frameCount);
        assert.equal(modal.usernameHandoffPending, false);
    } finally {
        globalThis.document = originalDocument;
    }
});

test('Continue prompts a returning account at once; setup waits for Create passkey', async () => {
    for (const next of ['register', 'login']) {
        const { modal, calls } = continuationModal(next);
        await modal.handleAccountContinue();
        assert.equal(modal.usernameContinuePending, false);
        assert.equal(modal.creationStep, next === 'register' ? 'username_ready' : 'idle');
        if (next === 'register') {
            assert.equal(modal.generatedUsername, 'winter-owl');
            assert.deepEqual(calls, [['prepare', 'winter-owl']]);
            await modal.handleUsernamePasskeyContinue();
            assert.deepEqual(calls, [['prepare', 'winter-owl'], ['init', 'winter-owl'], ['register']]);
        } else {
            assert.equal(modal.usernameUnlockReady, true);
            assert.deepEqual(calls, [['prepare', 'winter-owl'], ['login']]);
        }
    }
});

test('username and Google share exactly the same encryption explanation shell and copy', () => {
    for (const isSetup of [false, true]) {
        const { modal } = continuationModal();
        modal.generatedUsername = isSetup ? 'winter-owl' : null;
        modal.creationStep = isSetup ? 'username_ready' : 'idle';
        modal.accountState.oauthSetupRequired = isSetup;
        const google = modal.renderOAuthUnlockUI();
        const username = modal.renderUsernameUnlockUI();
        const withoutSecondaryAction = html => html.replace(/<button[^>]*class="account-unlock-signout"[^>]*>[\s\S]*?<\/button>/, '');
        assert.equal(withoutSecondaryAction(username).replaceAll('account-username-unlock-btn', 'oauth-keyring-submit-btn'), withoutSecondaryAction(google));
        assert.match(username, /id="account-username-back-btn"[^>]*>Back<\/button>/);
        assert.doesNotMatch(username, /Log out/);
        assert.doesNotMatch(username, /winter-owl|oauth-recovery-code-input|account-number-text/);
    }
});

test('username Unlock fetches a fresh challenge and stays single-flight', async () => {
    const { modal, calls } = continuationModal('login');
    const staleChallenge = { challenge: 'do-not-reuse' };
    modal.accountService.prepareUsernameContinuation = async () => ({ kind: 'login', challenge: staleChallenge });
    let finish;
    modal.handleAccountPasskeyUnlock = async (...args) => {
        calls.push(['login', args]);
        return new Promise(resolve => { finish = resolve; });
    };
    await modal.handleAccountContinue(); // starts the automatic prompt
    await modal.handleUsernamePasskeyContinue();
    await modal.handleAccountContinue();
    assert.deepEqual(calls, [['login', []]]);
    assert.equal(modal.usernamePasskeyBusy, true);
    assert.match(modal.renderUsernameUnlockUI(), /disabled aria-busy="true"/);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(modal.usernamePasskeyBusy, false);
});

test('Back from username explanation preserves the identifier and does not sign out an account', async () => {
    for (const next of ['login', 'register']) {
        const { modal, calls } = continuationModal(next);
        modal.animationTimeouts = [];
        await modal.handleAccountContinue();
        modal.handleUsernamePasskeyBack();
        assert.equal(modal.usernameInputValue, 'winter-owl');
        assert.equal(modal.usernameUnlockReady, false);
        assert.equal(modal.creationStep, 'idle');
        assert.deepEqual(calls, next === 'register' ? [['prepare', 'winter-owl'], ['cancel']] : [['prepare', 'winter-owl'], ['login']]);
    }
});

test('a closed dialog never invokes authentication, not even the automatic prompt', async () => {
    const { modal, calls } = continuationModal('login');
    modal.accountService.prepareUsernameContinuation = async (username, options) => {
        calls.push(['prepare', username]);
        modal.isOpen = false; // closed during the lookup
        return { kind: 'login' };
    };
    await modal.handleAccountContinue();
    await modal.handleUsernamePasskeyContinue();
    assert.deepEqual(calls, [['prepare', 'winter-owl']]);
    assert.ok(!modal.usernameUnlockReady);
});

test('delayed new-account setup does not reserve a username or start a challenge until Create', async () => {
    const { modal, calls } = continuationModal('register');
    await modal.handleAccountContinue();
    assert.equal(modal.generatedAccountId, null);
    assert.deepEqual(calls, [['prepare', 'winter-owl']]);
    // The card can remain open arbitrarily long: no registration challenge exists.
    modal.animationTimeouts = [];
    modal.handleUsernamePasskeyBack();
    await modal.handleAccountContinue();
    assert.equal(modal.generatedAccountId, null);
    assert.equal(calls.filter(([action]) => action === 'init').length, 0);
    await modal.handleUsernamePasskeyContinue();
    assert.equal(calls.filter(([action]) => action === 'init').length, 1);
    assert.equal(calls.at(-1)[0], 'register');
});

test('late username credential success or failure cannot mutate a reopened dialog', async () => {
    for (const succeeds of [true, false]) {
        const { modal } = continuationModal('register');
        let finish;
        let commits = 0;
        let renders = 0;
        modal.animationTimeouts = [];
        modal.handlePasskeyRegistration = AccountModal.prototype.handlePasskeyRegistration;
        modal.accountService.registerPasskeyForPreparedAccount = () => new Promise((resolve, reject) => {
            finish = () => succeeds ? resolve(true) : reject(new Error('Late credential failure'));
        });
        modal.accountService.completeAccountRegistration = async () => { commits += 1; };
        await modal.handleAccountContinue();
        const operation = modal.handleUsernamePasskeyContinue();
        await new Promise(resolve => setImmediate(resolve));
        modal.loginViewVersion += 1;
        modal.resetCreationFlow();
        modal.render = () => { renders += 1; };
        finish();
        await operation;
        assert.equal(modal.creationStep, 'idle');
        assert.equal(modal.generatedUsername, null);
        assert.equal(modal.creationError, null);
        assert.equal(commits, 0);
        assert.equal(renders, 0);
    }
});

test('username registration finalization cannot be dismissed while committing its key', () => {
    const { modal, calls } = continuationModal('register');
    modal.generatedUsername = 'winter-owl';
    modal.creationStep = 'confirming';
    modal.close = () => calls.push(['close']);
    modal.handleCloseAttempt();
    assert.deepEqual(calls, []);
    assert.match(modal.renderUsernameUnlockUI(), /id="close-account-modal"[^>]*disabled/);
});

test('Continue is single-flight and closing during lookup never launches a passkey', async () => {
    const { modal, calls } = continuationModal();
    let resolve;
    modal.accountService.prepareUsernameContinuation = () => new Promise(done => { resolve = done; });
    const first = modal.handleAccountContinue();
    await modal.handleAccountContinue();
    assert.equal(modal.usernameContinuePending, true);
    // A close/reopen must also invalidate the earlier request.
    modal.loginViewVersion += 1;
    resolve({ kind: 'register' });
    await first;
    assert.deepEqual(calls, []);
    assert.equal(modal.usernameContinuePending, false);
});

test('lookup failures stay on the login form and do not launch a passkey', async () => {
    const { modal, calls } = continuationModal();
    modal.accountService.prepareUsernameContinuation = async () => { throw new Error('Try again later'); };
    await modal.handleAccountContinue();
    assert.deepEqual(calls, [['error', 'Try again later']]);
    assert.equal(modal.creationStep, 'idle');
    assert.equal(modal.usernameContinuePending, false);
});

test('Continue preserves saved legacy login and honors unsupported/busy guards', async () => {
    const { modal, calls } = continuationModal();
    modal.identifierMode = 'accountId';
    await modal.handleAccountContinue();
    assert.deepEqual(calls, [['login']]);
    modal.accountState.busy = true;
    await modal.handleAccountContinue();
    modal.accountState.busy = false;
    modal.accountState.passkeySupported = false;
    await modal.handleAccountContinue();
    assert.deepEqual(calls, [['login']]);
});

test('returning username account closes sign-in without first-account routing', async () => {
    const modal = Object.create(AccountModal.prototype);
    let closed = 0;
    let firstAccountReady = 0;
    modal.identifierMode = 'username';
    modal.usernameInputValue = 'winter-owl';
    modal.accountState = { username: 'winter-owl' };
    modal.close = () => { closed += 1; };
    modal.accountService = {
        async unlockWithUsername(username, options) {
            assert.equal(username, 'winter-owl');
            assert.deepEqual(options, { action: 'username_login' });
            return true;
        }
    };
    modal.app = {
        showToast() {},
        notifyFirstAccountReady() { firstAccountReady += 1; }
    };

    await modal.handleAccountPasskeyUnlock();

    assert.equal(closed, 1);
    assert.equal(firstAccountReady, 0);
});

test('saved legacy passkey accounts keep the account-number login path', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById() { return null; } };
    const state = {
        accountId: '1234567890123456',
        username: null,
        googleLinked: false,
        encryptionMode: 'LEGACY_PASSKEY',
        sessionVerified: false,
        status: 'locked',
        passkeySupported: true,
        busy: false,
        action: null,
        error: null
    };
    let unlockedAccountId = null;
    const account = {
        getState: () => state,
        subscribe: () => () => {},
        clearErrors() {},
        async unlockWithPasskey(accountId) {
            unlockedAccountId = accountId;
            return true;
        },
        async unlockWithUsername() {
            throw new Error('legacy account unexpectedly used username login');
        }
    };
    const modal = new AccountModal({
        services: {
            account,
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        },
        showToast() {}
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        modal.openForUsername('another-name');
        assert.equal(modal.getIdentifierMode(), 'accountId');
        const html = modal.renderAccountUI();
        assert.match(html, /id="account-id-input"/);
        assert.match(html, /id="account-google-btn"[^>]*hover:bg-accent/);
        assert.match(html, /style="padding:24px 24px 18px"/);
        assert.doesNotMatch(html, /account-login-dialog|account-login-heading|account-login-divider|account-login-arrow/);
        assert.match(html, /1234 5678 9012 3456/);
        assert.match(html, /id="account-recovery-toggle-btn"/);
        assert.doesNotMatch(html, /account-identifier-mode-btn/);
        await modal.handleAccountPasskeyUnlock();
        assert.equal(unlockedAccountId, state.accountId);
        // Pre-migration Google-linked accounts still use the legacy passkey
        // when their session has expired and OAuth unlock flags are unset.
        state.googleLinked = true;
        state.oauthLegacyPasskeyRequired = false;
        assert.equal(modal.getIdentifierMode(), 'accountId');
        const linkedLegacyHtml = modal.renderAccountUI();
        assert.match(linkedLegacyHtml, /id="account-id-input"/);
        assert.match(linkedLegacyHtml, /id="account-recovery-toggle-btn"/);
        await modal.handleAccountContinue();
        assert.equal(unlockedAccountId, state.accountId);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('signed-out saved account exposes an explicit account-switch recovery', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        accountId: null,
        hasSavedAccountBinding: true,
        sessionVerified: false,
        passkeySupported: true,
        busy: false,
        action: null,
        error: 'This Google account does not match the OA account saved on this device.'
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderAccountUI();
        assert.match(html, /Continue with Google/);
        assert.match(html, /This device remembers a signed-out OA account/);
        assert.match(html, /id="account-forget-saved-btn"/);
        assert.match(html, /Forget saved account/);
        assert.doesNotMatch(html, /id="generate-account-btn"/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('desktop account-mismatch recovery does not depend on a visible account ID', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        accountId: null,
        hasSavedAccountBinding: false,
        sessionVerified: false,
        passkeySupported: true,
        busy: false,
        action: null,
        error: 'This Google account does not match the OA account saved on this device.'
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderAccountUI();
        assert.match(html, /id="account-forget-saved-btn"/);
        assert.match(html, /Forget saved account/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('forgetting a signed-out saved account clears only after explicit action', async () => {
    let clearCount = 0;
    let toast = '';
    const modal = Object.create(AccountModal.prototype);
    modal.accountService = {
        async clearLocalAccount() {
            clearCount += 1;
        }
    };
    modal.accountInputValue = 'saved';
    modal.recoveryInputValue = 'saved';
    modal.showRecoveryInput = true;
    modal.resetCreationFlow = () => {};
    modal.render = () => {};
    modal.app = { showToast(message) { toast = message; } };

    await modal.handleForgetSavedAccount();

    assert.equal(clearCount, 1);
    assert.equal(modal.accountInputValue, '');
    assert.equal(modal.recoveryInputValue, '');
    assert.equal(modal.showRecoveryInput, false);
    assert.equal(toast, 'Saved account removed from this device');
});

test('account service turns upstream failures into actionable Google copy', () => {
    assert.equal(
        toFriendlyOAuthError(Object.assign(new Error('Bad Gateway'), { status: 502 })),
        'Google sign-in is temporarily unavailable. Please retry.'
    );
});

test('an already-unlocked Google account completes without commercial coupling', async () => {
    const modal = Object.create(AccountModal.prototype);
    let toast = '';
    modal.accountService = {
        authenticateWithOAuth: async () => ({ status: 'unlocked' })
    };
    modal.render = () => {};
    modal.app = { showToast(message) { toast = message; } };

    await modal.handleOAuthAuthentication('google');

    assert.equal(toast, 'Signed in with Google');
    assert.equal('resumePremiumCheckoutIfPending' in modal, false);
});

test('OAuth resolving to a returning keyring starts the passkey without reopening Account', async () => {
    const modal = Object.create(AccountModal.prototype);
    let prompts = 0;
    modal.accountService = {
        authenticateWithOAuth: async () => ({ status: 'keyring_unlock' })
    };
    modal.render = () => {};
    modal.maybeAutoPromptPasskey = () => { prompts += 1; };
    modal.app = {};

    await modal.handleOAuthAuthentication('google');

    assert.equal(prompts, 1);
    assert.equal(modal.creationStep, 'idle');
});

test('a first Google account closes authentication and routes directly to Membership', async () => {
    const modal = Object.create(AccountModal.prototype);
    let closed = 0;
    let firstAccountReady = 0;
    modal.accountService = {
        authenticateWithOAuth: async () => ({ status: 'unlocked', newAccount: true })
    };
    modal.render = () => {};
    modal.close = () => { closed += 1; };
    modal.app = {
        showToast() {},
        notifyFirstAccountReady() { firstAccountReady += 1; }
    };

    await modal.handleOAuthAuthentication('google');

    assert.equal(closed, 1);
    assert.equal(firstAccountReady, 1);
});

test('a returning Google account stays in Chat without first-account routing', async () => {
    const modal = Object.create(AccountModal.prototype);
    let closed = 0;
    let firstAccountReady = 0;
    let renders = 0;
    modal.accountService = {
        authenticateWithOAuth: async () => ({ status: 'unlocked', newAccount: false })
    };
    modal.render = () => { renders += 1; };
    modal.close = () => { closed += 1; };
    modal.app = {
        showToast() {},
        notifyFirstAccountReady() { firstAccountReady += 1; }
    };

    await modal.handleOAuthAuthentication('google');

    assert.equal(closed, 1);
    assert.equal(firstAccountReady, 0);
    assert.equal(renders, 1);
});

test('returning passkey and recovery unlocks close Account without Membership routing', async () => {
    const cases = [
        ['handleAccountPasskeyUnlock', 'unlockWithPasskey'],
        ['handleOAuthRecoveryUnlock', 'unlockOAuthWithRecoveryCode'],
        ['handleOAuthKeyringUnlock', 'unlockOAuthKeyring']
    ];

    for (const [handler, serviceMethod] of cases) {
        const modal = Object.create(AccountModal.prototype);
        let closed = 0;
        let firstAccountReady = 0;
        modal.accountState = {
            accountId: 'account-1',
            oauthProvider: 'google'
        };
        modal.accountInputValue = '';
        modal.recoveryInputValue = 'recovery-code';
        modal.accountService = {
            getState: () => ({
                accountId: 'account-1',
                oauthSetupRequired: false,
                oauthLegacyPasskeyRequired: false
            }),
            [serviceMethod]: async () => true
        };
        modal.close = () => { closed += 1; };
        modal.app = {
            showToast() {},
            notifyFirstAccountReady() { firstAccountReady += 1; }
        };

        await modal[handler]();

        assert.equal(closed, 1, handler);
        assert.equal(firstAccountReady, 0, handler);
        assert.equal(modal.authenticationExitPending, false, handler);
    }
});

test('legacy recovery closes Account after the replacement passkey succeeds', async () => {
    const modal = Object.create(AccountModal.prototype);
    let closed = 0;
    let toast = '';
    modal.accountState = { accountId: 'account-1' };
    modal.accountInputValue = '';
    modal.recoveryInputValue = 'recovery-code';
    modal.showRecoveryInput = true;
    modal.recoveryStep = 'idle';
    modal.accountService = {
        clearErrors() {},
        unlockWithRecoveryCode: async () => true
    };
    modal.render = () => {};
    modal.close = () => { closed += 1; };
    modal.app = { showToast(message) { toast = message; } };

    await modal.handleAccountRecoveryUnlock();

    assert.equal(closed, 1);
    assert.equal(toast, 'Account recovered successfully');
    assert.equal(modal.recoveryStep, 'idle');
    assert.equal(modal.showRecoveryInput, false);
    assert.equal(modal.recoveryInputValue, '');
    assert.equal(modal.authenticationExitPending, false);
});

test('first Google keyring setup closes Account and routes once to Membership', async () => {
    const modal = Object.create(AccountModal.prototype);
    let closed = 0;
    let firstAccountReady = 0;
    modal.accountService = {
        getState: () => ({
            accountId: 'account-1',
            oauthSetupRequired: true,
            oauthLegacyPasskeyRequired: false
        }),
        setupOAuthKeyring: async () => true
    };
    modal.close = () => { closed += 1; };
    modal.app = {
        showToast() {},
        notifyFirstAccountReady() { firstAccountReady += 1; }
    };

    await modal.handleOAuthKeyringUnlock();

    assert.equal(closed, 1);
    assert.equal(firstAccountReady, 1);
    assert.equal(modal.authenticationExitPending, false);
});

test('successful unlock does not flash the signed-in Account summary before closing', () => {
    const originalDocument = globalThis.document;
    let accountListener = null;
    let syncListener = null;
    globalThis.document = {
        getElementById() { return null; },
        addEventListener() {},
        removeEventListener() {}
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => ({ status: 'locked' }),
                subscribe(listener) {
                    accountListener = listener;
                    return () => {};
                }
            },
            sync: {
                getStatus: () => ({}),
                subscribe(listener) {
                    syncListener = listener;
                    return () => {};
                }
            }
        }
    });
    let renders = 0;
    modal.isOpen = true;
    modal.authenticationExitPending = true;
    modal.render = () => { renders += 1; };

    try {
        accountListener({
            accountId: 'account-1',
            sessionVerified: true,
            status: 'unlocked'
        });
        syncListener();
        assert.equal(renders, 0);

        accountListener({
            accountId: 'account-1',
            sessionVerified: true,
            status: 'locked',
            busy: false,
            error: 'Try again'
        });
        assert.equal(renders, 1);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('a Google-authenticated locked account explains that passkey unlock is still required', () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById() { return null; } };
    const state = {
        accountId: 'identity-account',
        sessionVerified: true,
        status: 'locked',
        oauthProvider: 'google',
        oauthKeyringRequired: true,
        busy: false,
        error: 'No passkey found for this account on this device'
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderOAuthUnlockUI();
        assert.doesNotMatch(html, /Welcome back|<h2/);
        assert.match(html, /account-unlock-card account-unlock-card-untitled/);
        assert.match(html, /aria-label="Unlock your encrypted data"/);
        assert.doesNotMatch(html, /aria-labelledby/);
        assert.doesNotMatch(html, /account-login-dialog|account-login-heading|account-login-divider|account-login-arrow/);
        assert.match(html, /encrypts your tickets and preferences so only you can access them/);
        assert.match(html, /id="oauth-keyring-submit-btn"/);
        assert.match(html, />\s*Try again\s*</);
        assert.match(html, /role="alert"[^>]*>No passkey found for this account on this device</);
        assert.doesNotMatch(html, /Signed in with Google/);
        assert.doesNotMatch(html, /account-clear-btn|Log out/);
        assert.match(html, /id="close-account-modal"[^>]*aria-label="Close"/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('opening a locked Google account prompts its passkey at once, once, and only for the plain keyring unlock', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        activeElement: null,
        getElementById() { return null; },
        addEventListener() {},
        removeEventListener() {}
    };
    const cases = [
        [{ oauthKeyringRequired: true }, 1],
        [{ oauthKeyringRequired: true, error: 'Passkey cancelled' }, 0],
        [{ oauthKeyringRequired: true, busy: true }, 0],
        [{ oauthKeyringRequired: true, passkeySupported: false }, 0],
        [{ oauthKeyringRequired: true, oauthLegacyPasskeyRequired: true }, 0],
        [{ oauthSetupRequired: true }, 0],
        [{ oauthRecoveryRequired: true }, 0]
    ];
    for (const [flags, expectedPrompts] of cases) {
        const state = {
            accountId: 'identity-account', sessionVerified: true, status: 'locked',
            oauthProvider: 'google', passkeySupported: true, busy: false,
            authBootstrapComplete: true, ...flags
        };
        let prompts = 0;
        const modal = new AccountModal({
            services: {
                account: {
                    getState: () => state,
                    subscribe: () => () => {},
                    clearErrors() {},
                    async unlockOAuthKeyring() { prompts += 1; return false; },
                    async setupOAuthKeyring() { prompts += 100; return false; },
                    async unlockWithPasskey() { prompts += 100; return false; }
                },
                sync: { getStatus: () => ({}), subscribe: () => () => {} }
            },
            showToast() {}
        });
        modal.overlay = { classList: { add() {}, remove() {} }, innerHTML: '', querySelector() { return null; }, querySelectorAll() { return []; } };
        modal.render = () => {};
        modal.focusModal = () => {};
        modal.escapeHtml = value => String(value ?? '');
        try {
            modal.open();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(prompts, expectedPrompts, JSON.stringify(flags));
            // A second render/open of the same dialog never re-prompts on its own.
            modal.maybeAutoPromptPasskey();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(prompts, expectedPrompts, `repeat ${JSON.stringify(flags)}`);
        } finally {
            modal.destroy();
        }
    }
    globalThis.document = originalDocument;
});

test('a cancelled automatic Google prompt restores focus to Try again', async () => {
    const originalDocument = globalThis.document;
    const retry = {
        id: 'oauth-keyring-submit-btn',
        focus() { globalThis.document.activeElement = this; }
    };
    const state = {
        accountId: 'identity-account', sessionVerified: true, status: 'locked',
        oauthProvider: 'google', oauthKeyringRequired: true,
        passkeySupported: true, busy: false, authBootstrapComplete: true
    };
    globalThis.document = {
        activeElement: { id: 'body' },
        getElementById(id) { return id === retry.id ? retry : null; },
        addEventListener() {},
        removeEventListener() {}
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {},
                clearErrors() {},
                async unlockOAuthKeyring() {
                    globalThis.document.activeElement = { id: 'body' };
                    state.error = 'Passkey cancelled';
                    return false;
                }
            },
            sync: { getStatus: () => ({}), subscribe: () => () => {} }
        }
    });
    modal.overlay = {
        classList: { add() {}, remove() {} },
        contains(element) { return element === retry; },
        querySelectorAll() { return [retry]; },
        querySelector() { return null; },
        set innerHTML(_) {}
    };
    modal.render = () => {};
    try {
        modal.open();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(globalThis.document.activeElement, retry);
        assert.equal(modal.passkeyAutoPromptAttempted, true);
        assert.equal(modal.isOpen, true);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('Welcome dismissal keeps the account locked and Account-settings logout still works', async () => {
    const originalDocument = globalThis.document;
    const buttons = { 'close-account-modal': {} };
    globalThis.document = {
        getElementById(id) { return buttons[id] || null; },
        removeEventListener() {}
    };
    const state = {
        accountId: 'identity-account', sessionVerified: true, status: 'locked',
        oauthProvider: 'google', oauthKeyringRequired: true,
        passkeySupported: true, busy: false, authBootstrapComplete: true
    };
    let cleared = 0;
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {},
                async clearLocalAccount() {
                    cleared += 1;
                    Object.assign(state, {
                        accountId: null, sessionVerified: false,
                        oauthProvider: null, oauthKeyringRequired: false
                    });
                }
            },
            sync: { getStatus: () => ({}), subscribe: () => () => {} }
        }
    });
    modal.overlay = { classList: { add() {} }, innerHTML: '' };
    modal.isOpen = true;
    modal.render = () => {};
    modal.escapeHtml = value => String(value ?? '');
    try {
        assert.match(modal.renderAccountUI(), /account-unlock-card-untitled/);
        assert.doesNotMatch(modal.renderAccountUI(), /Welcome back/);
        modal.attachEventListeners();
        buttons['close-account-modal'].onclick();
        assert.equal(modal.isOpen, false);
        assert.equal(state.sessionVerified, true);
        assert.equal(state.status, 'locked');
        assert.equal(cleared, 0);

        // Logout remains in the normal Account settings after unlock, not Welcome.
        modal.isOpen = true;
        state.status = 'unlocked';
        state.oauthKeyringRequired = false;
        buttons['account-clear-btn'] = {};
        modal.attachEventListeners();
        state.busy = true;
        assert.match(modal.renderAccountUI(), /id="account-clear-btn"[^>]*disabled/);
        state.busy = false;
        assert.match(modal.renderAccountUI(), /id="account-clear-btn"[^>]*>Log out<\/button>/);
        await buttons['account-clear-btn'].onclick();
        assert.equal(cleared, 1);
        assert.equal(state.sessionVerified, false);
        assert.match(modal.renderAccountUI(), /id="account-username-input"/);
        assert.doesNotMatch(modal.renderAccountUI(), /account-unlock-card/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('the unlock card never shows logout, including waiting, retry, and legacy-passkey states', () => {
    const modal = Object.create(AccountModal.prototype);
    modal.escapeHtml = value => String(value ?? '');
    for (const oauthLegacyPasskeyRequired of [false, true]) {
        for (const [busy, error] of [[false, null], [true, null], [false, 'Passkey cancelled']]) {
            modal.accountState = { accountId: '1234567890123456', oauthKeyringRequired: true, oauthLegacyPasskeyRequired, busy, error };
            const html = modal.renderOAuthUnlockUI();
            // Only the legacy-passkey account keeps a heading; the ordinary
            // returning account is prompted on arrival and its card is untitled.
            if (oauthLegacyPasskeyRequired) assert.match(html, />Welcome back<\/h2>/);
            else assert.doesNotMatch(html, /<h2|Welcome back/);
            assert.match(html, /id="close-account-modal"/);
            assert.match(html, /id="oauth-keyring-submit-btn"/);
            assert.doesNotMatch(html, /account-clear-btn|account-unlock-signout|Log out/);
        }
    }
    for (const flag of ['oauthSetupRequired', 'oauthRecoveryRequired']) {
        modal.accountState = { [flag]: true };
        assert.match(modal.renderOAuthUnlockUI(), /id="account-clear-btn"[^>]*>Log out<\/button>/);
    }
});

test('legacy linked account uses its existing passkey unlock path', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        accountId: '1234567890123456',
        oauthProvider: 'google',
        oauthLegacyPasskeyRequired: true
    };
    let unlockAccountId = null;
    let closed = 0;
    const account = {
        getState: () => state,
        subscribe: () => () => {},
        async unlockWithPasskey(accountId) {
            unlockAccountId = accountId;
            return true;
        }
    };
    const modal = new AccountModal({
        services: {
            account,
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        },
        showToast() {}
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');
    modal.close = () => { closed += 1; };

    try {
        const html = modal.renderOAuthUnlockUI();
        assert.match(html, /Use legacy passkey/);
        assert.match(html, /aria-labelledby="account-modal-title"/);
        assert.match(html, /id="account-modal-title"/);
        assert.match(html, /1234 5678 9012 3456/);
        await modal.handleOAuthKeyringUnlock();
        assert.equal(unlockAccountId, state.accountId);
        assert.equal(closed, 1);
        assert.equal('resumePremiumCheckoutIfPending' in modal, false);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('identity account describes ticket and preference sync', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        accountId: '1234567890123456',
        googleLinked: true,
        oauthEmail: 'dominic@example.com',
        encryptionMode: 'PRF',
        sessionVerified: true,
        status: 'unlocked',
        busy: false,
        action: null,
        passkeySupported: true
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({
                    syncing: false,
                    lastSyncTime: null,
                    lastSyncResult: null
                }),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        let html = modal.renderAccountUI();
        assert.match(html, /account-compact-dialog/);
        assert.match(html, /account-compact-avatar[^>]*>D</);
        assert.match(html, /dominic@example\.com/);
        assert.match(html, /Sync now|Retry sync/);
        assert.match(html, /Passkey &amp; encryption/);
        assert.match(html, /id="account-passkey-details"[^>]*data-open="false"[^>]*aria-hidden="true" inert/);
        assert.match(html, /Tickets and preferences sync encrypted with your passkey/);
        assert.doesNotMatch(html, /Account identity|Synchronization|Connected provider/);
        assert.doesNotMatch(html, /device-only/);

        modal.togglePasskeyDetails();
        html = modal.renderAccountUI();
        assert.match(html, /aria-expanded="true"/);
        assert.match(html, /id="account-passkey-details"[^>]*data-open="true"[^>]*aria-hidden="false">/);
        assert.match(html, /End-to-end encrypted/);
        assert.match(html, /Google connected/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('passkey disclosure updates mounted nodes without rerendering', () => {
    const attributes = {};
    const detailAttributes = {};
    const button = {
        setAttribute(name, value) { attributes[name] = value; }
    };
    const detail = {
        setAttribute(name, value) { detailAttributes[name] = value; },
        toggleAttribute(name, enabled) { detailAttributes[name] = enabled; }
    };
    const modal = {
        passkeyDetailsOpen: false,
        overlay: {
            querySelector(selector) {
                return selector === '#account-passkey-details-btn' ? button : detail;
            }
        },
        render() { throw new Error('Disclosure toggle must not rebuild the modal'); }
    };

    AccountModal.prototype.togglePasskeyDetails.call(modal);
    assert.equal(modal.passkeyDetailsOpen, true);
    assert.deepEqual(attributes, { 'aria-expanded': 'true' });
    assert.deepEqual(detailAttributes, {
        'data-open': 'true',
        'aria-hidden': 'false',
        inert: false
    });

    AccountModal.prototype.togglePasskeyDetails.call(modal);
    assert.equal(modal.passkeyDetailsOpen, false);
    assert.deepEqual(attributes, { 'aria-expanded': 'false' });
    assert.deepEqual(detailAttributes, {
        'data-open': 'false',
        'aria-hidden': 'true',
        inert: true
    });
});

test('username account displays the pseudonym and hides its internal account ID', () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById() { return null; } };
    const state = {
        accountId: '1234567890123456',
        username: 'winter-owl',
        googleLinked: false,
        encryptionMode: 'LEGACY_PASSKEY',
        sessionVerified: true,
        status: 'unlocked',
        busy: false,
        action: null,
        passkeySupported: true
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({
                    syncing: false,
                    lastSyncTime: null,
                    lastSyncResult: null
                }),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderAccountUI();
        assert.match(html, /winter-owl/);
        assert.doesNotMatch(html, /1234 5678 9012 3456/);
        assert.doesNotMatch(html, /Copy account ID/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('legacy recovery completion displays only the account number', () => {
    const modal = Object.create(AccountModal.prototype);
    modal.accountState = {
        accountId: '1234567890123456',
        username: null
    };
    modal.formatAccountId = accountId => accountId.replace(/(.{4})/g, '$1 ').trim();
    modal.escapeHtml = value => String(value ?? '');
    modal.renderHeader = title => `<h2>${title}</h2>`;

    const html = modal.renderRecoveryCompleteUI();

    assert.match(html, /Account Recovered/);
    assert.match(html, /1234 5678 9012 3456/);
});

test('legacy registration recovery screen pairs the code with its account number', () => {
    const modal = Object.create(AccountModal.prototype);
    modal.generatedAccountId = '1234567890123456';
    modal.generatedUsername = null;
    modal.generatedRecoveryCode = 'alpha-bravo-charlie-delta-echo';
    modal.accountIdCopied = false;
    modal.recoveryCodeCopied = false;
    modal.escapeHtml = value => String(value ?? '');
    modal.formatAccountId = accountId => accountId.replace(/(.{4})/g, '$1 ').trim();

    const html = modal.renderCreationBody('recovery');

    assert.match(html, /Your account number/);
    assert.match(html, /1234 5678 9012 3456/);
    assert.match(html, /alpha-bravo-charlie-delta-echo/);
    assert.doesNotMatch(html, /Your username/);
});

test('missing legacy SSO email returns to provider sign in before passkey setup', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        accountId: '1234567890123456',
        googleLinked: true,
        oauthProvider: 'google',
        oauthEmail: null,
        encryptionMode: 'PRF_PENDING',
        sessionVerified: false,
        oauthSetupRequired: false,
        oauthRecoveryRequired: false,
        oauthKeyringRequired: false,
        oauthLegacyPasskeyRequired: false,
        passkeySupported: true,
        busy: false,
        action: null,
        error: 'Continue with Google again so OA can label your encryption passkey'
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderAccountUI();
        assert.match(html, /Continue with Google/);
        assert.match(html, /label your encryption passkey/);
        assert.doesNotMatch(html, /Google sign in complete/);
        assert.doesNotMatch(html, /Create encryption passkey/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});
