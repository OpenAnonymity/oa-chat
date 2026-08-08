import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveOrgEndpoints } from '../../chat/services/orgEndpoints.js';

test('local dev endpoints keep the OAuth callback on canonical localhost', () => {
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
        authOrigin: 'http://localhost:8005'
    });
    assert.deepEqual(loopback, {
        apiBase: 'http://127.0.0.1:8080',
        authOrigin: 'http://localhost:8005'
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
