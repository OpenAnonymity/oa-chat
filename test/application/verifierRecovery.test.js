import test from 'node:test';
import assert from 'node:assert/strict';
import { applyVerifierRetryResult } from '../../chat/application/verifierRecovery.js';
const access = () => ({ key: 'child', stationId: 'station', verifierSubmitKeyProof: { status: 'verifier-unavailable' } });

test('verification recovery updates matching primary and Council keys', () => {
    const info = access();
    const session = { apiKey: info.key, apiKeyInfo: info, councilAccess: { primary: {
        apiKey: info.key, apiKeyInfo: access(), expiresAt: new Date(Date.now() + 60000).toISOString()
    } } };
    assert.equal(applyVerifierRetryResult(session, info, { status: 'verified' }), true);
    assert.equal(session.apiKeyInfo.verifierSubmitKeyProof.status, 'verified');
    assert.equal(session.councilAccess.primary.apiKeyInfo.verifierSubmitKeyProof.status, 'verified');
});

test('a late verification result never touches a replacement key or different station', () => {
    for (const changes of [{ key: 'replacement' }, { stationId: 'other-station' }]) {
        const info = { ...access(), ...changes };
        const session = { apiKey: info.key, apiKeyInfo: info };
        assert.equal(applyVerifierRetryResult(session, access(), { status: 'verified' }), false);
        assert.equal(session.apiKeyInfo.verifierSubmitKeyProof.status, 'verifier-unavailable');
    }
});

test('background rejection clears the pending key and its raw mapping', () => {
    const info = access();
    const session = { apiKey: info.key, apiKeyInfo: info, ephemeralKeyMappings: { alias: { underlyingKeyId: info.key } } };
    assert.equal(applyVerifierRetryResult(session, info, { status: 'rejected', error: new Error('privacy violation') }), true);
    assert.equal(session.apiKey, null);
    assert.equal(session.apiKeyInfo, null);
    assert.equal(session.ephemeralKeyMappings, undefined);
});
