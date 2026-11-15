import test from 'node:test';
import assert from 'node:assert/strict';
import { signStationKey, trustedStationPins } from '../helpers/trustedStation.js';
globalThis.window = { location: { hostname: 'localhost' }, addEventListener() {}, dispatchEvent() {} };
const { StationVerifier } = await import('../../chat/services/verifier.js');
const { default: networkProxy } = await import('../../chat/services/networkProxy.js');
const { VERIFIER_URL } = await import('../../chat/config.js');
const mainnet = 'https://verifier-production-20260917.openanonymity.ai';
const key = signStationKey({ stationId: 'same-station', key: 'test-key', expiresAtUnix: Math.floor(Date.now() / 1000) + 300, orgSignature: 'test-signature' });

test('separate verifier sends key, broadcasts and attestation only to its configured origin', async t => {
    const original = networkProxy.fetchWithRetryJson;
    t.after(() => { networkProxy.fetchWithRetryJson = original; });
    const verifier = new StationVerifier({ verifierUrl: mainnet });
    const calls = [];
    networkProxy.fetchWithRetryJson = async url => {
        calls.push(url);
        return { response: { ok: true, status: 200 }, data: url.endsWith('/submit_key')
            ? { status: 'verified', station_id: key.stationId, key_hash: await verifier._hashKey(key.key) }
            : { verified_stations: [], banned_stations: [] } };
    };
    const result = await verifier.submitKey(key, { queueOnFailure: false });
    assert.equal(result.status, 'verified');
    await verifier.queryBroadcast();
    await verifier.getAttestation();
    assert.deepEqual(calls, [`${mainnet}/submit_key`, `${mainnet}/broadcast`, `${mainnet}/attestation`]);
});

test('same station ID cannot import another verifier cache or overwrite its bans', async t => {
    const previous = window.chatDB;
    t.after(() => { window.chatDB = previous; });
    const store = new Map([['lastBroadcastData', { verified_stations: [{ station_id: key.stationId }] }]]);
    window.chatDB = { getSetting: async name => store.get(name), saveSetting: async (name, value) => store.set(name, value) };
    const tickets = new StationVerifier();
    const payments = new StationVerifier({ verifierUrl: mainnet });
    assert.notEqual(tickets.broadcastStorageKey, payments.broadcastStorageKey);
    tickets.lastBroadcastData = { banned_stations: [{ station_id: key.stationId }], verified_stations: [] };
    payments.lastBroadcastData = { banned_stations: [], verified_stations: [{ station_id: key.stationId }] };
    await tickets.persistBroadcastData();
    await payments.persistBroadcastData();
    const reloadedTickets = new StationVerifier();
    const reloadedPayments = new StationVerifier({ verifierUrl: mainnet });
    reloadedTickets.queryBroadcast = reloadedPayments.queryBroadcast = async () => ({});
    await reloadedTickets.init();
    await reloadedPayments.init();
    assert.equal(reloadedTickets.isStationBanned(key.stationId), true);
    assert.equal(reloadedPayments.isStationBanned(key.stationId), false);
    assert.equal(store.size, 2, 'ticket cache retains its existing key');
    assert.equal(tickets.broadcastStorageKey, 'lastBroadcastData');
});

test('a key signed under the ticket verifier pin cannot receive payment outage approval', async t => {
    const original = networkProxy.fetchWithRetryJson;
    t.after(() => { networkProxy.fetchWithRetryJson = original; });
    networkProxy.fetchWithRetryJson = async () => { throw new Error('offline'); };
    const verifier = new StationVerifier({ verifierUrl: mainnet, trustedStations: trustedStationPins(key.stationId) });
    verifier.outagePolicy = 'advisory';
    const result = await verifier.submitKey(key, { queueOnFailure: false });
    assert.equal(result.status, 'rejected');
    assert.equal(result.trustedStationFallback, undefined);
    assert.equal(verifier.pendingSubmissions.size, 0);
    assert.deepEqual(new StationVerifier({ verifierUrl: mainnet }).trustedStations, []);
});

test('alternate verifier URL must be an exact HTTPS origin', () => {
    assert.notEqual(mainnet, VERIFIER_URL);
    for (const url of ['http://verifier.example', `${mainnet}/path`, `${mainnet}/`, 'https://u:p@verifier.example', `${mainnet}?redirect=1`]) {
        assert.throws(() => new StationVerifier({ verifierUrl: url }));
    }
});
