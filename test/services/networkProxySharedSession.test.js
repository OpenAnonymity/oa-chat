import test from 'node:test';
import assert from 'node:assert/strict';

// The relay HTTPSession is shared by every proxied request. One request's
// abort (a fetch timeout, Stop, a session switch) must not close it while a
// completion stream is still using it, and must not mark the relay as failed.

async function loadProxy() {
    const previousWindow = globalThis.window;
    globalThis.window = {
        location: { hostname: 'staging.example', origin: 'https://staging.example' },
        addEventListener: () => {},
        dispatchEvent: () => {}
    };
    const { default: networkProxy } = await import('../../chat/services/networkProxy.js');
    const originalEmit = networkProxy.emitChange;
    networkProxy.emitChange = () => {};
    return { networkProxy, restore: () => {
        networkProxy.emitChange = originalEmit;
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    } };
}

function fakeSession() {
    const session = {
        closed: 0,
        close() { this.closed += 1; },
        fetch() { return new Promise(() => {}); } // never settles; the guard decides
    };
    return session;
}

test('a request abort leaves the shared session open while another relayed request is in flight', async () => {
    const { networkProxy, restore } = await loadProxy();
    const session = fakeSession();
    networkProxy.httpSession = session;
    networkProxy.activeRequestCount = 2; // this request plus a streaming completion
    const controller = new AbortController();
    const pending = networkProxy.fetchThroughProxy('https://openrouter.ai/api/v1/models', { signal: controller.signal });
    controller.abort();
    try {
        await assert.rejects(pending, error => error?.name === 'AbortError');
        assert.equal(session.closed, 0, 'the stream sharing the session must survive');
        assert.equal(networkProxy.httpSession, session);
    } finally {
        networkProxy.httpSession = null;
        networkProxy.activeRequestCount = 0;
        restore();
    }
});

test('a request abort with nothing else in flight still recycles the session', async () => {
    const { networkProxy, restore } = await loadProxy();
    const session = fakeSession();
    networkProxy.httpSession = session;
    networkProxy.activeRequestCount = 1;
    const controller = new AbortController();
    const pending = networkProxy.fetchThroughProxy('https://openrouter.ai/api/v1/models', { signal: controller.signal });
    controller.abort();
    try {
        await assert.rejects(pending, error => error?.name === 'AbortError');
        assert.equal(session.closed, 1);
        assert.equal(networkProxy.httpSession, null);
    } finally {
        networkProxy.httpSession = null;
        networkProxy.activeRequestCount = 0;
        restore();
    }
});

test('an aborted relayed request does not mark the relay as failed', async () => {
    const { networkProxy, restore } = await loadProxy();
    const originalEnsure = networkProxy.ensureProxyApplied;
    const originalThrough = networkProxy.fetchThroughProxy;
    const originalSettings = networkProxy.state.settings;
    networkProxy.state.settings = { enabled: true, fallbackToDirect: true };
    networkProxy.httpSession = {};
    networkProxy.ensureProxyApplied = async () => {};
    const before = { ...networkProxy.state };
    networkProxy.state.usingProxy = true;
    networkProxy.state.connectionVerified = true;
    networkProxy.state.transport = 'proxy';
    networkProxy.state.lastError = null;
    const controller = new AbortController();
    networkProxy.fetchThroughProxy = async () => {
        controller.abort();
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        throw error;
    };
    try {
        await assert.rejects(
            networkProxy.fetch('https://openrouter.ai/api/v1/chat/completions', { signal: controller.signal }),
            error => error?.name === 'AbortError'
        );
        assert.equal(networkProxy.state.usingProxy, true);
        assert.equal(networkProxy.state.connectionVerified, true);
        assert.equal(networkProxy.state.transport, 'proxy');
        assert.equal(networkProxy.state.lastError, null);
    } finally {
        networkProxy.ensureProxyApplied = originalEnsure;
        networkProxy.fetchThroughProxy = originalThrough;
        Object.assign(networkProxy.state, before, { settings: originalSettings });
        networkProxy.httpSession = null;
        networkProxy.activeRequestCount = 0;
        restore();
    }
});


test('refused disable cannot persist a disabled setting during an active relay request', async () => {
    const { networkProxy, restore } = await loadProxy();
    const original = { ...networkProxy.state.settings, enabled: true };
    const save = networkProxy.saveSettings;
    let persisted = 0;
    networkProxy.state.settings = original;
    networkProxy.activeRequestCount = 1;
    networkProxy.saveSettings = async () => { persisted++; };
    try {
        await assert.rejects(networkProxy.updateSettings({ enabled: false }), /requests are in progress/);
        assert.equal(networkProxy.getSettings().enabled, true);
        assert.equal(persisted, 0);
    } finally {
        networkProxy.activeRequestCount = 0;
        networkProxy.saveSettings = save;
        restore();
    }
});
