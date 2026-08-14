import test from 'node:test';
import assert from 'node:assert/strict';

import {
    guardProxyFetch,
    resolveProxyFetchTimeoutMs
} from '../../chat/services/proxyFetchGuard.js';

test('demo timeout applies only to same-origin API traffic', () => {
    const origin = 'https://demo.example';
    assert.equal(resolveProxyFetchTimeoutMs('/api/request_key', origin, 10000), 10000);
    assert.equal(resolveProxyFetchTimeoutMs('https://openrouter.ai/api/v1/chat', origin, 10000), null);
    assert.equal(resolveProxyFetchTimeoutMs('/api/request_key', origin, null), null);
});

test('slow provider fetch remains unbounded when no demo timeout applies', async () => {
    const result = await guardProxyFetch(
        () => new Promise(resolve => setTimeout(() => resolve('ok'), 20)),
        { timeoutMs: null }
    );
    assert.equal(result, 'ok');
});

test('a stalled same-origin demo fetch fails with a proxy timeout', async () => {
    await assert.rejects(
        guardProxyFetch(() => new Promise(() => {}), { timeoutMs: 5 }),
        error => error?.code === 'PROXY_TIMEOUT'
    );
});

test('user cancellation aborts without waiting for the transport', async () => {
    const controller = new AbortController();
    const guarded = guardProxyFetch(
        () => new Promise(() => {}),
        { signal: controller.signal }
    );
    controller.abort();
    await assert.rejects(guarded, error => error?.name === 'AbortError');
});
