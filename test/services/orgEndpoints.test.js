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

test('direct local org OAuth never changes localhost and 127.0.0.1 hosts', () => {
    assert.equal(resolveOrgEndpoints({
        hostname: '127.0.0.1',
        origin: 'http://127.0.0.1:8081'
    }).authOrigin, 'http://127.0.0.1:8005');
    assert.equal(resolveOrgEndpoints({
        hostname: 'localhost',
        origin: 'http://localhost:8081'
    }).authOrigin, 'http://localhost:8005');
});

test('localhost preview without the dev marker uses the local org', () => {
    assert.deepEqual(resolveOrgEndpoints({
        hostname: 'localhost',
        origin: 'http://localhost:8080',
        localProxyEnabled: false
    }), {
        apiBase: 'http://localhost:8005',
        authOrigin: 'http://localhost:8005'
    });
});
