import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('a composed client can suppress the legacy welcome panel without changing the public default', () => {
    const appSource = readFileSync('chat/app.js', 'utf8');
    assert.match(appSource, /this\.welcomePanelEnabled\s*=\s*options\.welcomePanel\s*!==\s*false/);
    assert.match(appSource, /else if \(this\.welcomePanelEnabled\)[\s\S]*?this\.welcomePanel\.init/);
    assert.match(appSource, /this\.welcomePanel\.close\(\)/);
});
