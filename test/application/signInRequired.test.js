import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// On a host that requires sign-in (createChatApp({ signIn: { required } })),
// a page that loads without an unlocked account gets the Log in or sign up
// dialog at once: a refresh after Log out, a new tab, a mode that needs an
// account. The landing page is for a first visit only, so the app never
// sends anyone there. The sign-in hand-offs (?auth=…) open the dialog
// themselves and are left alone.
test('a required sign-in opens the dialog whenever the page loads signed out', () => {
    const app = fs.readFileSync(path.join(process.cwd(), 'chat/app.js'), 'utf8');
    const method = app.slice(app.indexOf('    async openSignInIfRequired() {'), app.indexOf('    registerLoggedOutHandler('));
    // The requirement is a Tickets one: in zkAPI mode the page opens freely.
    assert.match(method, /if \(!this\.signInRequiredNow\(\) \|\| !this\.accountModal\) return false;/);
    assert.match(app, /signInRequiredNow\(\) \{\s*return this\.signInPolicy\.required === true && this\.getPaymentMode\(\) !== 'zkapi';/);
    assert.match(method, /await accountService\.waitForAuthBootstrap\(\)/);
    assert.match(method, /if \(state\?\.accountId && state\.status === 'unlocked'\) return false;/);
    assert.match(method, /this\.accountModal\.open\?\.\(\);/);
    // Runs after the arrival route, only when that route had nothing to do.
    assert.match(app, /const route = this\.features\.accounts \? await routeAuthenticationIntent\(\{[\s\S]*?\}\) : null;\s*if \(this\.features\.accounts && !route\?\.handled\) await this\.openSignInIfRequired\(\);/);
    assert.doesNotMatch(app, /['"`]\/login['"`]/);
});

test('signed out, a send opens the dialog instead of a ticket shortage, and nothing sends from behind a dialog', () => {
    const app = fs.readFileSync(path.join(process.cwd(), 'chat/app.js'), 'utf8');
    const preflight = app.slice(app.indexOf('    async preflightTurnTicketBudget('), app.indexOf('const memoryTickets', app.indexOf('    async preflightTurnTicketBudget(')));
    assert.match(preflight, /if \(this\.signInRequiredNow\(\) && !accountService\.getState\(\)\?\.accountId\) \{\s*this\.accountModal\?\.open\?\.\(\);\s*return false;/);
    const send = app.slice(app.indexOf('    async sendMessage(options = {}) {'), app.indexOf('ensureDatabaseReady', app.indexOf('    async sendMessage(options = {}) {')));
    assert.match(send, /if \(hasOpenModalDialog\(\)\) return;/);
});

test('with zkAPI in the build the sign-in dialog has a close: closing a Tickets sign-in returns to zkAPI; logout in zkAPI asks nothing', () => {
    const modal = fs.readFileSync(path.join(process.cwd(), 'chat/components/AccountModal.js'), 'utf8');
    const gate = modal.slice(modal.indexOf('    mustStaySignedIn() {'), modal.indexOf('    closeLeavesTicketsForZkapi() {'));
    assert.match(gate, /if \(this\.app\?\.hasPaymentModes\?\.\(\) === true\) return false;/);
    assert.match(modal, /closeLeavesTicketsForZkapi\(\) \{[\s\S]*?if \(this\.app\?\.getPaymentMode\?\.\(\) === 'zkapi'\) return false;/);
    assert.match(modal, /handleCloseAttempt\(\) \{[\s\S]*?if \(this\.closeLeavesTicketsForZkapi\(\)\) \{\s*void this\.closeToZkapi\(\);\s*return;/);
    assert.match(modal, /await this\.app\.changePaymentMode\('zkapi'\);\s*this\.close\(\);/);
    assert.doesNotMatch(modal, /Use zkAPI instead/);
    // Logging out of zkAPI mode closes the dialog instead of showing the form.
    const logout = modal.slice(modal.indexOf('    async handleAccountClear() {'), modal.indexOf('    async handleAccountClear() {') + 1800);
    assert.match(logout, /if \(this\.app\?\.getPaymentMode\?\.\(\) === 'zkapi'\) \{\s*\/\/[^\n]*\n\s*this\.close\(\);/);
    // Signed out on a sign-in host, the footer says Log in; the dialog says the rest.
    assert.match(modal, /\? 'Log in'\s*: 'Account';/);
    const app = fs.readFileSync(path.join(process.cwd(), 'chat/app.js'), 'utf8');
    assert.match(app, /askToSignInForBackend\(backendId\) \{\s*if \(backendId === 'zkapi' \|\| !this\.signInPolicy\.required\) return;\s*if \(accountService\.getState\(\)\?\.accountId\) return;\s*this\.accountModal\?\.open\?\.\(\);/);
    assert.match(app, /payments: Object\.freeze\(\{[\s\S]*?getMode: \(\) => this\.getPaymentMode\(\),[\s\S]*?setMode: mode => this\.changePaymentMode\(mode\)/);
});
