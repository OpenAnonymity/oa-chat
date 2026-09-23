import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForOAuthPopup } from '../../chat/services/accountService.js';
import { ORG_AUTH_ORIGIN } from '../../chat/services/orgEndpoints.js';

const token = 'x'.repeat(43);
function harness() {
    const listeners = new Set();
    const popup = { closed: false, close() { this.closed = true; }, location: { replace() {} } };
    const windowImpl = {
        addEventListener(type, listener) { assert.equal(type, 'message'); listeners.add(listener); },
        removeEventListener(type, listener) { listeners.delete(listener); }
    };
    const deliver = (overrides = {}) => {
        for (const listener of listeners) listener({
            origin: ORG_AUTH_ORIGIN, source: popup,
            data: { type: 'oa-google-auth', ok: true, completionToken: token }, ...overrides
        });
    };
    return { popup, windowImpl, deliver, listeners };
}

test('a close poll before the queued completion does not cancel Google sign-in', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const h = harness();
    const result = waitForOAuthPopup(h.popup, 'google', h);
    h.popup.closed = true;
    t.mock.timers.tick(500);
    h.deliver();
    assert.equal(await result, token);
    assert.equal(h.listeners.size, 0);
    t.mock.timers.tick(300000);
});

test('listener is installed before navigating to a fast OAuth callback', async () => {
    const h = harness();
    h.popup.location.replace = url => {
        assert.equal(url, 'https://accounts.google.com/example');
        assert.equal(h.listeners.size, 1);
        h.deliver();
    };
    assert.equal(await waitForOAuthPopup(h.popup, 'google', { ...h, authorizationUrl: 'https://accounts.google.com/example' }), token);
});

test('real closure without completion reports the observation and cleans up', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const h = harness();
    const result = waitForOAuthPopup(h.popup, 'google', h);
    const rejected = assert.rejects(result, /window closed before sign-in finished/);
    h.popup.closed = true;
    t.mock.timers.tick(500);
    t.mock.timers.tick(1500);
    await rejected;
    assert.equal(h.listeners.size, 0);
});

test('temporary popup closure or unreadable state can still complete', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const h = harness();
    let state = true;
    Object.defineProperty(h.popup, 'closed', { get() { if (state === 'unreadable') throw Error('Restricted'); return state; } });
    const result = waitForOAuthPopup(h.popup, 'google', h);
    t.mock.timers.tick(500);
    state = false;
    t.mock.timers.tick(500);
    state = 'unreadable';
    t.mock.timers.tick(3000);
    h.deliver();
    assert.equal(await result, token);
});

test('wrong origin, source, or event type cannot complete sign-in during the grace period', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const h = harness();
    const result = waitForOAuthPopup(h.popup, 'google', h);
    const rejected = assert.rejects(result, /window closed before sign-in finished/);
    h.popup.closed = true;
    t.mock.timers.tick(500);
    h.deliver({ origin: 'https://wrong.example' });
    h.deliver({ source: {} });
    h.deliver({ data: { type: 'oa-other-auth', ok: true, completionToken: token } });
    t.mock.timers.tick(1500);
    await rejected;
});

test('invalid tokens, provider errors, navigation failures and timeouts still fail closed', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    for (const data of [
        { type: 'oa-google-auth', ok: true, completionToken: 'short' },
        { type: 'oa-google-auth', ok: false, error: 'Provider denied access' }
    ]) {
        const h = harness();
        const result = waitForOAuthPopup(h.popup, 'google', h);
        h.deliver({ data });
        await assert.rejects(result, /invalid|Provider denied/);
        assert.equal(h.listeners.size, 0);
    }
    const h = harness();
    h.popup.location.replace = () => { throw Error('Navigation failed'); };
    await assert.rejects(waitForOAuthPopup(h.popup, 'google', { ...h, authorizationUrl: 'https://example.com' }), /Navigation failed/);
    assert.equal(h.listeners.size, 0);
    const timeout = waitForOAuthPopup(h.popup, 'google', { ...h, timeoutMs: 1000 });
    const rejected = assert.rejects(timeout, /timed out/);
    t.mock.timers.tick(1000);
    await rejected;
    assert.equal(h.listeners.size, 0);
});
