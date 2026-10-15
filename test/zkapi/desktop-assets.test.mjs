import test from 'node:test';
import assert from 'node:assert/strict';
import { configureBrowserSdk } from '@openanonymity/zkapi-browser-sdk/configure';
import runtime from '@openanonymity/zkapi-browser-sdk/runtime';

function page(t, href) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(href) });
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, 'location', previous);
        else delete globalThis.location;
    });
}

function deployment(t) {
    const previous = runtime.browserConfig;
    t.after(() => { runtime.browserConfig = previous; });
    runtime.browserConfig = {
        deployment_api_proxy_path: '/zkapi-deployment/',
        trusted_deployment: { protocol_server_url: 'https://zkapi-mainnet.openanonymity.ai' }
    };
}

test('desktop startup accepts bundled configuration and module-worker URLs', t => {
    page(t, 'app://openanonymity.ai/index.html');
    const options = configureBrowserSdk({
        configUrl: './zkapi/browser-config.json',
        workerUrl: './zkapi/assets/zkapiWasmWorker.js'
    });
    assert.equal(options.configUrl, 'app://openanonymity.ai/zkapi/browser-config.json');
    assert.equal(options.workerUrl, 'app://openanonymity.ai/zkapi/assets/zkapiWasmWorker.js');
});

test('desktop asset exception rejects other hosts, ports, credentials and schemes', t => {
    page(t, 'app://openanonymity.ai/index.html');
    for (const value of [
        'app://attacker.example/config.json',
        'app://openanonymity.ai.attacker.example/config.json',
        'app://openanonymity.ai:443/config.json',
        'app://user:password@openanonymity.ai/config.json',
        'data:text/javascript,alert(1)', 'javascript:alert(1)',
        'custom://openanonymity.ai/config.json'
    ]) {
        for (const field of ['configUrl', 'workerUrl']) {
            assert.throws(() => configureBrowserSdk({ configUrl: null, workerUrl: null, [field]: value }));
        }
    }
});

for (const href of ['https://chat.openanonymity.ai/', 'app://attacker.example/',
    'app://openanonymity.ai:443/', 'app://user@openanonymity.ai/']) {
    test(`a page at ${href} cannot opt into the desktop asset exception`, t => {
        page(t, href);
        assert.throws(() => configureBrowserSdk({
            configUrl: 'app://openanonymity.ai/zkapi/browser-config.json', workerUrl: null
        }));
    });
}

test('ordinary web configuration and deployment rewrites retain their behavior', t => {
    page(t, 'https://chat.openanonymity.ai/index.html');
    const options = configureBrowserSdk({ configUrl: './zkapi/browser-config.json', workerUrl: null });
    assert.equal(options.configUrl, 'https://chat.openanonymity.ai/zkapi/browser-config.json');
    deployment(t);
    assert.equal(runtime.deploymentProxyUrl('https://zkapi-mainnet.openanonymity.ai/config.json'),
        'https://chat.openanonymity.ai/zkapi-deployment/config.json');
    assert.equal(runtime.deploymentProxyUrl('https://unrelated.example/config.json'), null);
});

test('desktop remote API requests use the host transport with cookies omitted', async t => {
    page(t, 'app://openanonymity.ai/index.html');
    deployment(t);
    const calls = [];
    configureBrowserSdk({ configUrl: './zkapi/browser-config.json', workerUrl: null,
        transport: async (...args) => { calls.push(args); return new Response('{}'); } });
    t.after(() => configureBrowserSdk({ configUrl: null, workerUrl: null, transport: null }));
    await runtime.remoteFetchRaw('https://zkapi-mainnet.openanonymity.ai/v1/tree/snapshot', {
        credentials: 'include', method: 'GET'
    });
    assert.deepEqual(calls, [['https://zkapi-mainnet.openanonymity.ai/v1/tree/snapshot',
        { credentials: 'omit', method: 'GET' }, { preferProxy: true }]]);
});

test('desktop public manifest reads do not construct an opaque-origin web rewrite', async t => {
    page(t, 'app://openanonymity.ai/index.html');
    deployment(t);
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (...args) => {
        calls.push(args);
        return new Response('{"deployment_id":"fixture"}');
    });
    const result = await runtime.directJson('https://zkapi-mainnet.openanonymity.ai/config.json');
    assert.equal(result.deployment_id, 'fixture');
    assert.deepEqual(calls, [['https://zkapi-mainnet.openanonymity.ai/config.json',
        { cache: 'no-store', credentials: 'omit' }]]);
});
