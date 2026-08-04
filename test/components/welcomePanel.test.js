import test from 'node:test';
import assert from 'node:assert/strict';
import WelcomePanel from '../../chat/components/WelcomePanel.js';

test('initial welcome screen offers account creation', () => {
    const source = String(WelcomePanel.prototype.renderWelcomeStep);
    assert.match(source, /id="create-account-btn"/);
    assert.match(source, /Create Account/);
});

test('an open Premium surface suppresses delayed first-run onboarding', () => {
    const panel = Object.create(WelcomePanel.prototype);
    panel.app = { billingModal: { isOpen: true } };
    assert.equal(panel.shouldShow(), false);
});
