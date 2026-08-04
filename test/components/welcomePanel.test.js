import test from 'node:test';
import assert from 'node:assert/strict';
import WelcomePanel from '../../chat/components/WelcomePanel.js';

test('initial welcome screen offers Upgrade without mislabeling it as account creation', () => {
    const source = String(WelcomePanel.prototype.renderWelcomeStep);
    assert.match(source, /id="welcome-upgrade-btn"/);
    assert.match(source, /<span>Upgrade<\/span>/);
    assert.doesNotMatch(source, /id="create-account-btn"/);
});

test('Welcome Upgrade closes onboarding and opens Premium', () => {
    const panel = Object.create(WelcomePanel.prototype);
    let closed = 0;
    let opened = 0;
    panel.close = () => { closed += 1; };
    panel.app = { billingModal: { open: () => { opened += 1; } } };
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = callback => { callback(); return 1; };

    try {
        panel.handleUpgrade();
        assert.equal(closed, 1);
        assert.equal(opened, 1);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
    }
});

test('post-ticket success screen retains honest optional account creation', () => {
    const source = String(WelcomePanel.prototype.renderSuccessStep);
    assert.match(source, /id="create-account-btn"/);
    assert.match(source, /Create Account/);
});

test('an open Premium surface suppresses delayed first-run onboarding', () => {
    const panel = Object.create(WelcomePanel.prototype);
    panel.app = { billingModal: { isOpen: true } };
    assert.equal(panel.shouldShow(), false);
});
