import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForOAuthPopup } from '../../chat/services/accountService.js';
import { ORG_AUTH_ORIGIN } from '../../chat/services/orgEndpoints.js';

function fixture(t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const oldWindow = globalThis.window;
    const listeners = new Set();
    const popup = { closed: false, close() { this.closed = true; } };
    const windowImpl = {
        location: { search: '' },
        addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
        removeEventListener(type, fn) { listeners.delete(fn); }
    };
    globalThis.window = windowImpl;
    t.after(() => { globalThis.window = oldWindow; });
    const token = 'a'.repeat(43);
    const deliver = (overrides = {}) => {
        const event = {
            origin: ORG_AUTH_ORIGIN, source: popup,
            data: { type: 'oa-google-auth', ok: true, completionToken: token },
            ...overrides
        };
        for (const fn of [...listeners]) fn(event);
    };
    return { popup, listeners, token, deliver, windowImpl };
}

test('a valid completion queued behind the popup close check still succeeds', async t => {
    const f = fixture(t);
    const result = waitForOAuthPopup(f.popup, 'google');
    f.popup.closed = true;
    t.mock.timers.tick(500);
    f.deliver();
    assert.equal(await result, f.token);
    assert.equal(f.listeners.size, 0);
    t.mock.timers.tick(300000);
});

test('wrong origin, window, or provider cannot complete sign-in during the grace period', async t => {
    const f = fixture(t);
    const result = waitForOAuthPopup(f.popup, 'google');
    let settled = false;
    result.then(() => { settled = true; }, () => { settled = true; });
    f.popup.closed = true;
    t.mock.timers.tick(500);
    f.deliver({ origin: 'https://attacker.example' });
    f.deliver({ source: {} });
    f.deliver({ data: { type: 'oa-other-auth', ok: true, completionToken: f.token } });
    await Promise.resolve();
    assert.equal(settled, false);
    f.deliver();
    assert.equal(await result, f.token);
});

test('actual closure settles once, cleans up, and does not accept a late completion', async t => {
    const f = fixture(t);
    const result = waitForOAuthPopup(f.popup, 'google');
    const rejection = assert.rejects(result, /window closed before sign-in finished/);
    f.popup.closed = true;
    t.mock.timers.tick(500);
    assert.equal(f.listeners.size, 1);
    t.mock.timers.tick(1499);
    assert.equal(f.listeners.size, 1);
    t.mock.timers.tick(1);
    await rejection;
    assert.equal(f.listeners.size, 0);
    f.deliver();
    t.mock.timers.tick(300000);
});

test('transient closed observation does not terminate an open popup', async t => {
    const f = fixture(t);
    const result = waitForOAuthPopup(f.popup, 'google');
    f.popup.closed = true;
    t.mock.timers.tick(500);
    f.popup.closed = false;
    t.mock.timers.tick(2000);
    assert.equal(f.listeners.size, 1);
    f.deliver();
    assert.equal(await result, f.token);
});

test('malformed completion and provider rejection fail closed', async t => {
    const f = fixture(t);
    for (const completionToken of ['short', 'é'.repeat(43), ['a'.repeat(43)]]) {
        const result = waitForOAuthPopup(f.popup, 'google');
        f.deliver({ data: { type: 'oa-google-auth', ok: true, completionToken } });
        await assert.rejects(result, /completion was invalid/);
        assert.equal(f.listeners.size, 0);
    }
    const result = waitForOAuthPopup(f.popup, 'google');
    f.deliver({ data: { type: 'oa-google-auth', ok: false, error: 'Access denied' } });
    await assert.rejects(result, /Access denied/);
    assert.equal(f.listeners.size, 0);
});

test('listener is installed before navigation and navigation errors clean up', async t => {
    const f = fixture(t);
    const result = waitForOAuthPopup(f.popup, 'google', undefined, () => f.deliver());
    assert.equal(await result, f.token);
    assert.equal(f.listeners.size, 0);
    await assert.rejects(waitForOAuthPopup(f.popup, 'google', undefined, () => {
        throw new Error('Navigation failed');
    }), /Navigation failed/);
    assert.equal(f.listeners.size, 0);
});

test('inaccessible popup state waits for verified completion or the existing timeout', async t => {
    const f = fixture(t);
    Object.defineProperty(f.popup, 'closed', { configurable: true, get() { throw new Error('blocked'); } });
    let result = waitForOAuthPopup(f.popup, 'google', 2000);
    t.mock.timers.tick(500);
    f.deliver();
    assert.equal(await result, f.token);
    result = waitForOAuthPopup(f.popup, 'google', 2000);
    const rejected = assert.rejects(result, /timed out/);
    t.mock.timers.tick(2000);
    await rejected;
    assert.equal(f.listeners.size, 0);
});

test('fresh retry ignores the previous popup and accepts only its own result', async t => {
    const f = fixture(t);
    const first = waitForOAuthPopup(f.popup, 'google');
    const rejected = assert.rejects(first, /window closed/);
    f.popup.closed = true;
    t.mock.timers.tick(500);
    t.mock.timers.tick(1500);
    await rejected;
    const nextPopup = { closed: false, close() {} };
    const next = waitForOAuthPopup(nextPopup, 'google');
    f.deliver();
    assert.equal(f.listeners.size, 1);
    f.deliver({ source: nextPopup });
    assert.equal(await next, f.token);
});

test('diagnostics are opt-in and log only fixed event names and elapsed time', async t => {
    const f = fixture(t);
    const debug = t.mock.method(console, 'debug', () => {});
    let result = waitForOAuthPopup(f.popup, 'google');
    f.deliver();
    await result;
    assert.equal(debug.mock.callCount(), 0);
    f.windowImpl.location.search = '?oauthDiagnostics=1';
    result = waitForOAuthPopup(f.popup, 'google');
    f.popup.closed = true;
    t.mock.timers.tick(500);
    f.deliver();
    await result;
    assert.deepEqual(debug.mock.calls.map(call => call.arguments), [
        ['[OAuth popup]', 'listening', 0],
        ['[OAuth popup]', 'popup-closed-observed', 500],
        ['[OAuth popup]', 'completion-received', 500]
    ]);
});
