import test from 'node:test';
import assert from 'node:assert/strict';
import WelcomePanel from '../../chat/components/WelcomePanel.js';

test('initial welcome screen exposes an isolated commercial action slot', () => {
    const source = String(WelcomePanel.prototype.renderWelcomeStep);
    assert.match(source, /data-oa-extension-slot="welcome\.actions"/);
    assert.doesNotMatch(source, /welcome-upgrade-btn/);
    assert.doesNotMatch(source, /Register and upgrade/);
    assert.doesNotMatch(source, /id="create-account-btn"/);
});

test('post-ticket success screen retains honest optional account creation', () => {
    const source = String(WelcomePanel.prototype.renderSuccessStep);
    assert.match(source, /id="create-account-btn"/);
    assert.match(source, /Create Account/);
});

test('public welcome panel has no direct commercial implementation references', () => {
    const source = String(WelcomePanel);
    assert.doesNotMatch(source, /billingModal|billingState|Premium/);
});
