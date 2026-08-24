import test from 'node:test';
import assert from 'node:assert/strict';

// networkProxy assigns window.networkProxy at import time, so stub window first
globalThis.window = {
    dispatchEvent() {},
    addEventListener() {},
    removeEventListener() {},
    location: { hostname: 'localhost', search: '' }
};

const { default: networkProxy } = await import('../../chat/services/networkProxy.js');

let directCalls;
let savedSettings;

function primeProxy({ fallbackToDirect = true, enabled = true } = {}) {
    networkProxy.state.settings = { enabled, url: 'wss://relay.test', fallbackToDirect };
    networkProxy.state.fallbackActive = false;
    networkProxy.activeRequestCount = 0;
    networkProxy.ensureProxyApplied = async () => {};
    networkProxy.httpSession = {
        fetch: async () => {
            throw new Error('relay down');
        }
    };
    networkProxy.saveSettings = async (settings) => {
        savedSettings.push({ ...settings });
    };

    directCalls = [];
    savedSettings = [];
    globalThis.fetch = async (resource, init) => {
        directCalls.push({ resource, init });
        return new Response('ok');
    };
}

test('proxy failure falls back to direct without disabling the proxy', async () => {
    primeProxy();

    const response = await networkProxy.fetch('https://api.test/completions', { method: 'POST' });

    assert.equal(response.ok, true);
    assert.equal(directCalls.length, 1);
    assert.equal(directCalls[0].init.credentials, 'omit');
    assert.equal(networkProxy.state.fallbackActive, true);
    assert.equal(networkProxy.state.settings.enabled, true);
    assert.deepEqual(savedSettings, []);
});

test('proxy failure rejects when fallbackToDirect is off', async () => {
    primeProxy({ fallbackToDirect: false });

    await assert.rejects(
        networkProxy.fetch('https://api.test/completions', { method: 'POST' }),
        /relay down/
    );

    assert.equal(directCalls.length, 0);
    assert.equal(networkProxy.state.settings.enabled, true);
    assert.deepEqual(savedSettings, []);
});

test('proxy failure rejects when forceProxy is set', async () => {
    primeProxy();

    await assert.rejects(
        networkProxy.fetch('https://api.test/completions', { method: 'POST' }, { forceProxy: true }),
        /relay down/
    );

    assert.equal(directCalls.length, 0);
    assert.deepEqual(savedSettings, []);
});

test('disabled proxy uses direct fetch without proxy attempts', async () => {
    primeProxy({ enabled: false });
    let proxyAttempts = 0;
    networkProxy.httpSession.fetch = async () => {
        proxyAttempts++;
        throw new Error('relay down');
    };

    const response = await networkProxy.fetch('https://api.test/models', {});

    assert.equal(response.ok, true);
    assert.equal(proxyAttempts, 0);
    assert.equal(directCalls.length, 1);
    assert.equal(directCalls[0].init.credentials, 'omit');
});
