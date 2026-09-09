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
    assert.match(method, /if \(!this\.signInPolicy\.required \|\| !this\.accountModal\) return false;/);
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
    assert.match(preflight, /if \(this\.signInPolicy\.required && !accountService\.getState\(\)\?\.accountId\) \{\s*this\.accountModal\?\.open\?\.\(\);\s*return false;/);
    const send = app.slice(app.indexOf('    async sendMessage(options = {}) {'), app.indexOf('ensureDatabaseReady', app.indexOf('    async sendMessage(options = {}) {')));
    assert.match(send, /if \(hasOpenModalDialog\(\)\) return;/);
});
