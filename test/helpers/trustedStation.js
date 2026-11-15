import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { buildTrustedStationFallback } from '../../chat/services/trustedStations.js';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

export function trustedStationPins(...stationIds) {
    return stationIds.map(stationId => ({ stationId, publicKey, verifierOrigin: 'https://verifier2.openanonymity.ai' }));
}

export function signStationKey(keyData) {
    return { ...keyData, stationSignature: sign(null,
        Buffer.from(`${keyData.stationId}|${keyData.key}|${keyData.expiresAtUnix}`), keys.privateKey).toString('hex') };
}

// Consumer tests model an already recorded admission; signature verification is
// exercised separately above with generated Ed25519 keys, never an operator key.
export function recordedTrustedAccess(key = 'child') {
    const expiresAtUnix = Math.floor(Date.now() / 1000) + 3600;
    return { key, stationId: 'oa-station', expiresAtUnix,
        expiresAt: new Date(expiresAtUnix * 1000).toISOString(), stationSignature: '00'.repeat(64) };
}

export function recordedTrustedResult(access) {
    return { status: 'verifier-unavailable', detail: 'recently_attested_outage',
        trustedStationFallback: buildTrustedStationFallback(access,
            createHash('sha256').update(access.key).digest('hex').slice(0, 16)) };
}
