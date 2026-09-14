import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRefreshAccountSession } from '../../chat/services/sessionService.js';
import { ORG_API_BASE } from '../../chat/services/orgEndpoints.js';

test('pre-login challenge failures bypass session refresh while protected APIs retain it', () => {
    const original = globalThis.window;
    globalThis.window = { location: { href: `${ORG_API_BASE}/` } };
    try {
        assert.equal(shouldRefreshAccountSession(`${ORG_API_BASE}/auth/challenge`), false);
        assert.equal(shouldRefreshAccountSession(`${ORG_API_BASE}/auth/challenge?source=login`), false);
        assert.equal(shouldRefreshAccountSession(new Request(`${ORG_API_BASE}/auth/challenge`)), false);
        for (const path of ['/auth/keyring', '/auth/session', '/api/billing/status', '/auth/login']) {
            assert.equal(shouldRefreshAccountSession(`${ORG_API_BASE}${path}`), true);
        }
        for (const url of ['https://unrelated.example/auth/keyring', `${ORG_API_BASE}/api/request_key`, `${ORG_API_BASE}/chat/completions`]) {
            assert.equal(shouldRefreshAccountSession(url), false);
        }
    } finally { globalThis.window = original; }
});
