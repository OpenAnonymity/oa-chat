import test from 'node:test';
import assert from 'node:assert/strict';

import networkLogger from '../../chat/services/networkLogger.js';

test('redacts inference tickets even when a request may roll back', () => {
    const headers = networkLogger.sanitizeHeaders({
        Authorization: 'InferenceTicket token=still-usable-after-rollback'
    });

    assert.equal(headers.Authorization, 'InferenceTicket [REDACTED]');
});

test('redacts bearer tokens without retaining prefixes or suffixes', () => {
    const headers = networkLogger.sanitizeHeaders({
        authorization: 'Bearer child-secret-value'
    });

    assert.equal(headers.authorization, 'Bearer [REDACTED]');
});

test('log entries redact nested child keys without mutating the response', () => {
    const response = {
        key: 'child-secret-value',
        key_hash: 'safe-hash',
        nested: { api_key: 'nested-secret' }
    };

    const entry = networkLogger.logRequest({
        type: 'api-key',
        method: 'POST',
        status: 200,
        response
    });

    assert.equal(entry.response.key, '[REDACTED]');
    assert.equal(entry.response.key_hash, 'safe-hash');
    assert.equal(entry.response.nested.api_key, '[REDACTED]');
    assert.equal(response.key, 'child-secret-value');
});
