import test from 'node:test';
import assert from 'node:assert/strict';
import { signStationKey, trustedStationPins } from '../helpers/trustedStation.js';
import { isTrustedStationKey, buildTrustedStationFallback, isCurrentTrustedStationFallback } from '../../chat/services/trustedStations.js';
import { TRUSTED_VERIFIER_STATIONS } from '../../chat/config.js';

const key = signStationKey({ stationId: 'test-station', key: 'test-provider-key',
    expiresAtUnix: Math.floor(Date.now() / 1000) + 3600 });
const trustedStations = trustedStationPins(key.stationId);

test('station fallback requires the pinned key signature, station and exact verifier origin', async () => {
    assert.equal(await isTrustedStationKey(key, { trustedStations }), true);
    for (const changed of [
        { stationId: 'unknown-station' }, { key: 'other-provider-key' },
        { expiresAtUnix: key.expiresAtUnix + 1 }, { expiresAtUnix: `${key.expiresAtUnix}.0` },
        { stationSignature: '00'.repeat(64) }, { stationSignature: 'not-hex' }
    ]) {
        assert.equal(await isTrustedStationKey({ ...key, ...changed }, { trustedStations }), false);
    }
    assert.equal(await isTrustedStationKey(key, { trustedStations: [] }), false);
    assert.equal(await isTrustedStationKey(key, { trustedStations, verifierUrl: 'https://other-verifier.example' }), false);
    assert.equal(await isTrustedStationKey(key, { trustedStations, subtle: null }), false);
    assert.equal(await isTrustedStationKey(key, { trustedStations: [{ ...trustedStations[0], publicKey: '11'.repeat(32) }] }), false);
});

test('saved fallback records require current pins and matching station, expiry and signature', () => {
    const saved = { ...key, stationId: TRUSTED_VERIFIER_STATIONS[0].stationId };
    const proof = { status: 'verifier-unavailable',
        trustedStationFallback: buildTrustedStationFallback(saved, 'abcdef1234567890') };
    assert.equal(isCurrentTrustedStationFallback(proof, saved), true);
    // Org keyHash is the provider's management identifier, not this locally
    // derived SHA-256 proof binding. A different identifier cannot block use.
    assert.equal(isCurrentTrustedStationFallback(proof, { ...saved, keyHash: '11'.repeat(32) }), true);
    assert.equal(isCurrentTrustedStationFallback({ status: 'verifier-unavailable' }, saved), false);
    for (const changed of [{ stationId: 'untrusted' }, { expiresAtUnix: saved.expiresAtUnix + 1 },
        { stationSignature: '11'.repeat(64) }]) {
        assert.equal(isCurrentTrustedStationFallback(proof, { ...saved, ...changed }), false);
    }
    assert.equal(isCurrentTrustedStationFallback({ ...proof, trustedStationFallback: {
        ...proof.trustedStationFallback, policy: 'old-pins'
    } }, saved), false);
});
