import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveOrgEndpoints } from '../../chat/services/orgEndpoints.js';

test('local dev endpoints keep OAuth callback cookies on the API host', () => {
    const localhost = resolveOrgEndpoints({
        hostname: 'localhost',
        origin: 'http://localhost:8080',
        localProxyEnabled: true
    });
    const loopback = resolveOrgEndpoints({
        hostname: '127.0.0.1',
        origin: 'http://127.0.0.1:8080',
        localProxyEnabled: true
    });

    assert.deepEqual(localhost, {
        apiBase: 'http://localhost:8080',
        authOrigin: 'http://localhost:8080'
    });
    assert.deepEqual(loopback, {
        apiBase: 'http://127.0.0.1:8080',
        authOrigin: 'http://127.0.0.1:8080'
    });
});

test('localhost preview without the dev marker uses production org', () => {
    assert.deepEqual(resolveOrgEndpoints({
        hostname: 'localhost',
        origin: 'http://localhost:8080',
        localProxyEnabled: false
    }), {
        apiBase: 'https://org.openanonymity.ai',
        authOrigin: 'https://org.openanonymity.ai'
    });
});

test('demo build routes account and API traffic through its own HTTPS origin', () => {
    assert.deepEqual(resolveOrgEndpoints({
        hostname: 'oa-demo.vercel.app',
        origin: 'https://oa-demo.vercel.app',
        sameOriginEnabled: true
    }), {
        apiBase: 'https://oa-demo.vercel.app',
        authOrigin: 'https://oa-demo.vercel.app'
    });
});

test('same-origin mode rejects paths and non-HTTP browser schemes', () => {
    for (const origin of ['https://oa-demo.vercel.app/path', 'app://openanonymity.ai']) {
        assert.throws(() => resolveOrgEndpoints({
            hostname: 'oa-demo.vercel.app',
            origin,
            sameOriginEnabled: true
        }), /exact HTTP\(S\) origin/);
    }
});
