import { TRUSTED_VERIFIER_STATIONS, VERIFIER_URL } from '../config.js';

function normalizedOrigin(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
    } catch { return null; }
}

export function trustedStationPolicyRevision(stations = TRUSTED_VERIFIER_STATIONS, verifierUrl = VERIFIER_URL) {
    return `station-ed25519-v1:${normalizedOrigin(verifierUrl)}:${JSON.stringify(stations)}`;
}

function stationPin(stationId, stations, verifierUrl) {
    const origin = normalizedOrigin(verifierUrl);
    return origin && stations.find(pin => pin.stationId === stationId &&
        pin.verifierOrigin === origin && /^[a-f0-9]{64}$/i.test(pin.publicKey));
}

function hexBytes(value, byteLength) {
    if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${byteLength * 2}}$`, 'i').test(value)) return null;
    return Uint8Array.from(value.match(/../g), pair => Number.parseInt(pair, 16));
}

// Registry metadata and a station name do not authenticate a key. Check the
// exact inner signature format used by the OA verifier before granting trust.
export async function isTrustedStationKey(keyData, {
    trustedStations = TRUSTED_VERIFIER_STATIONS, verifierUrl = VERIFIER_URL,
    subtle = globalThis.crypto?.subtle
} = {}) {
    const pin = stationPin(keyData?.stationId, trustedStations, verifierUrl);
    const expiresAt = Number(keyData?.expiresAtUnix);
    const signature = hexBytes(keyData?.stationSignature, 64);
    if (!pin || !subtle || !signature || typeof keyData?.key !== 'string' || !keyData.key ||
        !Number.isSafeInteger(expiresAt) || expiresAt <= 0 ||
        String(expiresAt) !== String(keyData.expiresAtUnix)) return false;
    try {
        const publicKey = await subtle.importKey('raw', hexBytes(pin.publicKey, 32), 'Ed25519', false, ['verify']);
        return await subtle.verify('Ed25519', publicKey, signature,
            new TextEncoder().encode(`${keyData.stationId}|${keyData.key}|${expiresAt}`));
    } catch { return false; }
}

export function buildTrustedStationFallback(keyData, keyHash, stations = TRUSTED_VERIFIER_STATIONS, verifierUrl = VERIFIER_URL) {
    return {
        policy: trustedStationPolicyRevision(stations, verifierUrl),
        stationId: keyData.stationId,
        keyValidTill: Number(keyData.expiresAtUnix),
        stationSignature: keyData.stationSignature,
        keyHash
    };
}

// Only our locally validated, current-policy records survive persistence. Old
// advisory records have no marker and must obtain fresh approval on their next use.
export function isCurrentTrustedStationFallback(proof, accessInfo = null) {
    const trust = proof?.trustedStationFallback;
    if (!trust || trust.policy !== trustedStationPolicyRevision() ||
        !stationPin(trust.stationId, TRUSTED_VERIFIER_STATIONS, VERIFIER_URL) ||
        !Number.isSafeInteger(trust.keyValidTill) || trust.keyValidTill * 1000 <= Date.now() ||
        !hexBytes(trust.stationSignature, 64) || !/^[a-f0-9]{16}$/.test(trust.keyHash || '')) return false;
    if (!accessInfo) return true;
    return trust.stationId === accessInfo.stationId &&
        trust.keyValidTill === Number(accessInfo.expiresAtUnix) &&
        trust.stationSignature === accessInfo.stationSignature;
}
