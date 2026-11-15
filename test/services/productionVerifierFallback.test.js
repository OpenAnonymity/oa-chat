import test from 'node:test';
import assert from 'node:assert/strict';

// Exercise the real production configuration in this isolated test process.
const savedGlobals = Object.fromEntries(['__OA_VERIFIER_ORIGIN__', '__OA_VERIFIER_OUTAGE_POLICY__', 'window']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
globalThis.__OA_VERIFIER_ORIGIN__ = 'https://verifier-production-20260917.openanonymity.ai';
globalThis.__OA_VERIFIER_OUTAGE_POLICY__ = 'advisory';
globalThis.window = { location: { hostname: 'localhost' }, dispatchEvent() {}, addEventListener() {} };
const { TRUSTED_VERIFIER_STATIONS, VERIFIER_URL } = await import('../../chat/config.js');
const { StationVerifier } = await import('../../chat/services/verifier.js');
const { default: networkProxy } = await import('../../chat/services/networkProxy.js');
const { signStationKey, trustedStationPins } = await import('../helpers/trustedStation.js');
const { trustedStationPolicyRevision, isCurrentTrustedStationFallback } = await import('../../chat/services/trustedStations.js');
const { createProviderKeyVerifier, assertPrivateLeaseVerification } = await import('../../chat/zkapi/services/providerVerification.mjs');
// The repository bundles each suite's modules separately but runs suites in
// one process. Configuration has now been captured; leave other suites alone.
for (const [name, descriptor] of Object.entries(savedGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
}

const productionPin = TRUSTED_VERIFIER_STATIONS.find(pin => pin.verifierOrigin === VERIFIER_URL);
const key = signStationKey({ stationId: productionPin.stationId, key: 'synthetic-provider-key',
    expiresAtUnix: Math.floor(Date.now() / 1000) + 300, orgSignature: 'synthetic-org-signature', recentlyAttested: false });
// Generated test keys: no operator private keys, tickets, balances or network calls.
const testPins = [{ ...productionPin, publicKey: trustedStationPins(key.stationId)[0].publicKey }];
function fixture(t, reply) {
    const original = networkProxy.fetchWithRetryJson;
    networkProxy.fetchWithRetryJson = async () => {
        if (reply instanceof Error) throw reply;
        return reply;
    };
    t.after(() => { networkProxy.fetchWithRetryJson = original; });
    return new StationVerifier({ trustedStations: testPins });
}
const response = (status, data) => ({ response: { ok: status >= 200 && status < 300, status }, data });
const outage = () => Object.assign(new Error('Failed to fetch'), { name: 'TypeError' });

test('production pin matches independently checked public identity and limits recovery to outages', () => {
    assert.equal(productionPin.stationId, 'oa-production-station');
    assert.equal(productionPin.publicKey, '02a294fde1113c43bec88175429bab20d0795c5d51b2f27ebd596bd80fdc4585');
    assert.equal(productionPin.outageOnly, true);
});

test('adding production trust preserves the original staging proof revision', () => {
    const staging = TRUSTED_VERIFIER_STATIONS.filter(pin => pin.verifierOrigin !== VERIFIER_URL);
    const stagingUrl = 'https://verifier2.openanonymity.ai';
    assert.equal(trustedStationPolicyRevision(TRUSTED_VERIFIER_STATIONS, stagingUrl),
        `station-ed25519-v1:${stagingUrl}:${JSON.stringify(staging)}`);
    assert.notEqual(trustedStationPolicyRevision(testPins, VERIFIER_URL),
        trustedStationPolicyRevision(testPins, stagingUrl));
});

for (const [label, reply] of [
    ['network outage', outage()], ['service unavailable', response(503, { status: 'error' })],
    ['rate limit', response(429, { status: 'error' })],
    ['ownership service unavailable', response(503, { status: 'unverified', detail: 'ownership_check_error' })]
]) test(`production OA and zkAPI admit a correctly signed key during ${label}, without claiming verified`, async t => {
    const verifier = fixture(t, reply);
    const result = await verifier.submitKey(key);
    assert.equal(result.status, 'verifier-unavailable');
    assert.ok(verifier.pendingSubmissions.size);
    verifier.pendingSubmissions.clear();
    // The host's persisted-proof check uses production's real pins. This
    // synthetic signature was validated with the matching generated test key;
    // map only that local policy marker to model the real production result.
    const originalSubmit = verifier.submitKey.bind(verifier);
    verifier.submitKey = async (...args) => {
        const outcome = await originalSubmit(...args);
        if (outcome.trustedStationFallback) outcome.trustedStationFallback.policy = trustedStationPolicyRevision();
        return outcome;
    };
    const proof = await createProviderKeyVerifier(verifier)({ verifierUrl: VERIFIER_URL, keyData: key });
    assert.equal(proof.status, 'verifier-unavailable');
    assert.equal(verifier.pendingSubmissions.size, 0, 'zkAPI must not put wallet keys into the OA retry queue');
    assert.equal(isCurrentTrustedStationFallback(proof, key), true);
    const info = { station_id: key.stationId, verifierSubmitKeyProof: proof };
    assert.doesNotThrow(() => assertPrivateLeaseVerification(info, verifier));
    verifier.lastBroadcastData = { banned_stations: [{ station_id: key.stationId }], verified_stations: [] };
    assert.throws(() => assertPrivateLeaseVerification(info, verifier), /no longer/);
});

for (const [label, reply] of [
    ['refused ownership', response(200, { status: 'unverified', ownership_passed: false })],
    ['invalid org signature', response(401, { detail: 'Invalid org signature' })],
    ['invalid org signature inside server error', response(503, { status: 'error', detail: 'Invalid org signature' })],
    ['invalid station signature inside pending envelope', response(200, { status: 'pending', detail: 'Invalid station signature' })],
    ['refused key in a 5xx', response(503, { status: 'unverified', detail: 'ownership_failed' })],
    ['negative ownership inside temporary envelope', response(503, { status: 'unverified', detail: 'ownership_check_error', ownership_passed: false })],
    ['ban', response(503, { status: 'banned' })],
    ['denied success envelope', response(200, { status: 'denied' })],
    ['invalid success envelope', response(200, { status: 'invalid' })],
    ['privacy failure inside pending envelope', response(200, { status: 'pending', detail: 'privacy violation' })]
]) test(`production OA and zkAPI block ${label} even with advisory builds`, async t => {
    const verifier = fixture(t, reply);
    assert.equal((await verifier.submitKey(key)).status, 'rejected');
    assert.equal(verifier.pendingSubmissions.size, 0);
    await assert.rejects(createProviderKeyVerifier(verifier)({ verifierUrl: VERIFIER_URL, keyData: key }));
});

test('production outage never admits unknown stations, altered keys, expired keys or staging origins', async t => {
    const verifier = fixture(t, outage());
    for (const changed of [{ stationId: 'unknown' }, { key: 'substituted-key' },
        { stationSignature: '00'.repeat(64) }, { expiresAtUnix: 1 }]) {
        assert.equal((await verifier.submitKey({ ...key, ...changed })).status, 'rejected');
    }
    const wrongOrigin = new StationVerifier({ verifierUrl: 'https://verifier2.openanonymity.ai', trustedStations: testPins });
    assert.equal((await wrongOrigin.submitKey(key)).status, 'rejected');
    verifier.lastBroadcastData = { banned_stations: [{ station_id: key.stationId }], verified_stations: [] };
    assert.equal((await verifier.submitKey(key)).status, 'rejected');
});
