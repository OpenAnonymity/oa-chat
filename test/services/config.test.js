import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrgApiBase } from '../../chat/config.js';

test('routes localhost development to the local org', () => {
    assert.equal(
        resolveOrgApiBase({ hostname: 'localhost' }),
        'http://localhost:8005'
    );
    assert.equal(
        resolveOrgApiBase({ hostname: '127.0.0.1' }),
        'http://127.0.0.1:8005'
    );
    assert.equal(
        resolveOrgApiBase({ hostname: '[::1]' }),
        'http://[::1]:8005'
    );
});

test('preserves the production org for non-local hosts and server contexts', () => {
    assert.equal(
        resolveOrgApiBase({ hostname: 'chat.openanonymity.ai' }),
        'https://org.openanonymity.ai'
    );
    assert.equal(
        resolveOrgApiBase({ hostname: '0.0.0.0' }),
        'https://org.openanonymity.ai'
    );
    assert.equal(
        resolveOrgApiBase({ hostname: '192.168.1.25' }),
        'https://org.openanonymity.ai'
    );
    assert.equal(resolveOrgApiBase(), 'https://org.openanonymity.ai');
});
