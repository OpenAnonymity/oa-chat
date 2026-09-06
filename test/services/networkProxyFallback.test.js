import test from 'node:test';
import assert from 'node:assert/strict';

test('TLS inspection retains parsed metadata but never raw credential-bearing lines', async () => {
    const { default: networkProxy } = await import('../../chat/services/networkProxy.js');
    const originalEmit = networkProxy.emitChange;
    networkProxy.emitChange = () => {};
    try {
        networkProxy.resetTlsInfo();
        networkProxy.parseTlsOutput('Authorization: Bearer temporary-credential');
        networkProxy.parseTlsOutput('SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384');
        assert.ok(networkProxy.tlsInfo.version);
        assert.doesNotMatch(JSON.stringify(networkProxy.tlsInfo), /temporary-credential|Authorization/);
        assert.equal(networkProxy.tlsInfo.rawLogs, undefined);
    } finally {
        networkProxy.emitChange = originalEmit;
    }
});


test('direct fallback is per-request and does not persist a disabled relay', async () => {
    const previousFetch = globalThis.fetch;
    const previousWindow = globalThis.window;
    globalThis.window = {
        location: {
            hostname: 'staging.example',
            origin: 'https://staging.example'
        },
        addEventListener: () => {},
        dispatchEvent: () => {}
    };

    const { default: networkProxy } = await import(
        '../../chat/services/networkProxy.js?nonblocking-fallback-test'
    );
    const originalEnsureProxyApplied = networkProxy.ensureProxyApplied;
    const originalFetchThroughProxy = networkProxy.fetchThroughProxy;
    const originalSaveSettings = networkProxy.saveSettings;
    const originalSession = networkProxy.httpSession;
    const originalSettings = networkProxy.state.settings;
    let directCalls = 0;
    let saveCalls = 0;

    globalThis.fetch = async () => {
        directCalls += 1;
        return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    };
    networkProxy.state.settings = {
        enabled: true,
        fallbackToDirect: true
    };
    networkProxy.httpSession = {};
    networkProxy.ensureProxyApplied = async () => {};
    networkProxy.fetchThroughProxy = async () => {
        throw new TypeError('proxy unavailable');
    };
    networkProxy.saveSettings = async () => {
        saveCalls += 1;
    };

    try {
        const response = await Promise.race([
            networkProxy.fetch('https://staging.example/api/request_key'),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('direct fallback was blocked by persistence')),
                100
            ))
        ]);
        assert.equal(response.status, 200);
        assert.equal(directCalls, 1);
        assert.equal(networkProxy.state.settings.enabled, true);
        assert.equal(saveCalls, 0);
    } finally {
        networkProxy.ensureProxyApplied = originalEnsureProxyApplied;
        networkProxy.fetchThroughProxy = originalFetchThroughProxy;
        networkProxy.saveSettings = originalSaveSettings;
        networkProxy.httpSession = originalSession;
        networkProxy.state.settings = originalSettings;
        if (previousFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = previousFetch;
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});
