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

test('late rejection retires retained paid access without touching its replacement', () => {
    const old = { ...access(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    const replacement = { ...access(), key: 'replacement', verifierSubmitKeyProof: { status: 'verified' } };
    const session = { apiKey: replacement.key, apiKeyInfo: replacement,
        ticketAccessHistory: [old], ticketLaneHistory: { primary: [{ apiKey: old.key, apiKeyInfo: { ...old }, expiresAt: old.expiresAt }] } };
    assert.equal(applyVerifierRetryResult(session, old, { status: 'rejected' }), true);
    assert.equal(session.apiKey, 'replacement');
    assert.equal(session.ticketAccessHistory.length, 0);
    assert.equal(session.ticketLaneHistory.primary.length, 0);
    assert.ok(session.retiredTicketAccess.some(item => item.key === old.key));
});

test('late approval promotes retained paid access', () => {
    const old = { ...access(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    const session = { ticketAccessHistory: [old] };
    assert.equal(applyVerifierRetryResult(session, old, { status: 'verified' }), true);
    assert.equal(session.ticketAccessHistory[0].verifierSubmitKeyProof.status, 'verified');
});

test('active rejection prevents a stale tab resurrecting the key as paid history', async () => {
    const { mergeTicketAccessHistory } = await import('../../chat/services/inference/ticketTierAccess.js');
    const old = { ...access(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    const stored = { apiKey: old.key, apiKeyInfo: old, expiresAt: old.expiresAt };
    const stale = structuredClone(stored);
    assert.equal(applyVerifierRetryResult(stored, old, { status: 'rejected' }), true);
    const merged = mergeTicketAccessHistory({ ticketAccessHistory: [stale.apiKeyInfo] }, stored);
    assert.equal(merged.ticketAccessHistory.length, 0);
    assert.ok(merged.retiredTicketAccess.some(item => item.key === old.key));
});
