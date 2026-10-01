import test from 'node:test';
import assert from 'node:assert/strict';
import { signStationKey, trustedStationPins } from '../helpers/trustedStation.js';

const previousWindow = globalThis.window;
globalThis.window = {
    location: { hostname: '127.0.0.1' },
    dispatchEvent: () => {},
    addEventListener: () => {}
};

const { default: networkProxy } = await import('../../chat/services/networkProxy.js');
const { StationVerifier } = await import('../../chat/services/verifier.js');
const { VERIFIER_OUTAGE_POLICY } = await import('../../chat/config.js');

test.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
});

const UNATTESTED = signStationKey({
    recentlyAttested: false,
    stationId: 'station-unattested',
    key: 'child-secret',
    expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
    stationSignature: 'station-signature',
    orgSignature: 'org-signature'
});
const ATTESTED = signStationKey({ ...UNATTESTED, recentlyAttested: true, stationId: 'station-attested' });
const TRUSTED_STATIONS = trustedStationPins(UNATTESTED.stationId, ATTESTED.stationId);

function withVerifier(policy, replyOrError) {
    const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
    verifier.setOutagePolicy(policy);
    const originalFetch = networkProxy.fetchWithRetryJson;
    networkProxy.fetchWithRetryJson = async () => {
        if (replyOrError instanceof Error) throw replyOrError;
        return replyOrError;
    };
    return {
        verifier,
        restore: () => { networkProxy.fetchWithRetryJson = originalFetch; }
    };
}

const transportError = () => Object.assign(new Error('Failed to fetch'), { name: 'TypeError' });
const timeoutError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
const unverifiedReply = { response: { ok: true, status: 200 }, data: { status: 'unverified', detail: 'ownership_failed', ownership_passed: false } };
const pendingReply = { response: { ok: true, status: 200 }, data: { status: 'pending', detail: 'queued' } };
const serverErrorUnverifiedBody = { response: { ok: false, status: 500 }, data: { status: 'unverified', detail: 'internal' } };
const bannedReply = { response: { ok: false, status: 403 }, data: { status: 'banned', banned_station: { station_id: UNATTESTED.stationId, reason: 'logging detected' } } };
const malformedReply = { response: { ok: true, status: 200 }, data: { hello: 'world' } };

test('unbuilt sources default to the strict policy', () => {
    assert.equal(VERIFIER_OUTAGE_POLICY, 'strict');
    assert.equal(new StationVerifier({ trustedStations: TRUSTED_STATIONS }).outagePolicy, 'strict');
});

test('setOutagePolicy ignores unknown values', () => {
    const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
    verifier.setOutagePolicy('anything-goes');
    assert.equal(verifier.outagePolicy, 'strict');
});

test('strict: an unattested station blocks on a verifier outage', async () => {
    const { verifier, restore } = withVerifier('strict', transportError());
    try {
        const result = await verifier.submitKey(UNATTESTED);
        assert.equal(result.status, 'rejected');
        assert.match(result.error.message, /not recently attested/);
        assert.equal(verifier.pendingSubmissions.size, 0);
    } finally { restore(); }
});

test('strict: an attested station continues on a verifier outage (unchanged)', async () => {
    const { verifier, restore } = withVerifier('strict', transportError());
    try {
        const result = await verifier.submitKey(ATTESTED);
        assert.equal(result.status, 'verifier-unavailable');
        assert.equal(result.detail, 'recently_attested_outage');
        assert.equal(verifier.pendingSubmissions.size, 1);
    } finally { restore(); }
});

for (const policy of ['tolerant', 'advisory']) {
    test(`${policy}: an unattested station continues on a transport outage and queues a retry`, async () => {
        const { verifier, restore } = withVerifier(policy, transportError());
        try {
            const result = await verifier.submitKey(UNATTESTED);
            assert.equal(result.status, 'verifier-unavailable');
            assert.equal(result.detail, 'verifier_outage');
            const entry = verifier.pendingSubmissions.get(result.keyHash);
            assert.ok(entry, 'queued for background re-verification');
            assert.equal(entry.maxAttempts, 3);
        } finally { restore(); }
    });

    test(`${policy}: a verifier timeout continues`, async () => {
        const { verifier, restore } = withVerifier(policy, timeoutError());
        try {
            assert.equal((await verifier.submitKey(UNATTESTED)).status, 'verifier-unavailable');
        } finally { restore(); }
    });

    test(`${policy}: a 5xx with a verdict-shaped body is still an outage`, async () => {
        const { verifier, restore } = withVerifier(policy, serverErrorUnverifiedBody);
        try {
            const result = await verifier.submitKey(UNATTESTED);
            assert.equal(result.status, 'verifier-unavailable');
            assert.equal(result.detail, 'verifier_outage');
        } finally { restore(); }
    });

    test(`${policy}: a pending reply continues and keeps retrying`, async () => {
        const { verifier, restore } = withVerifier(policy, pendingReply);
        try {
            const result = await verifier.submitKey(UNATTESTED);
            assert.equal(result.status, 'verifier-unavailable');
            assert.equal(verifier.pendingSubmissions.size, 1);
        } finally { restore(); }
    });

    test(`${policy}: a malformed success reply continues`, async () => {
        const { verifier, restore } = withVerifier(policy, malformedReply);
        try {
            assert.equal((await verifier.submitKey(UNATTESTED)).status, 'verifier-unavailable');
        } finally { restore(); }
    });

    test(`${policy}: a banned station still blocks`, async () => {
        const { verifier, restore } = withVerifier(policy, bannedReply);
        try {
            const result = await verifier.submitKey(UNATTESTED);
            assert.equal(result.status, 'rejected');
            assert.equal(result.bannedStation?.reason, 'logging detected');
            assert.equal(verifier.pendingSubmissions.size, 0);
        } finally { restore(); }
    });

    test(`${policy}: a cached ban still blocks during an outage`, async () => {
        const { verifier, restore } = withVerifier(policy, transportError());
        verifier.lastBroadcastData = { banned_stations: [{ station_id: UNATTESTED.stationId }], verified_stations: [] };
        try {
            const result = await verifier.submitKey(UNATTESTED);
            assert.equal(result.status, 'rejected');
            assert.match(result.error.message, /banned/);
        } finally { restore(); }
    });

    test(`${policy}: an expired key still blocks during an outage`, async () => {
        const { verifier, restore } = withVerifier(policy, transportError());
        try {
            const result = await verifier.submitKey({ ...UNATTESTED, expiresAtUnix: Math.floor(Date.now() / 1000) - 5 });
            assert.equal(result.status, 'rejected');
            assert.match(result.error.message, /expired/);
        } finally { restore(); }
    });

    test(`${policy}: a station/key mismatch on a verified reply still blocks`, async () => {
        const { verifier, restore } = withVerifier(policy, {
            response: { ok: true, status: 200 },
            data: { status: 'verified', station_id: 'someone-else', key_hash: 'ffff' }
        });
        try {
            assert.equal((await verifier.submitKey(UNATTESTED)).status, 'rejected');
        } finally { restore(); }
    });
}

test('tolerant: an explicit unverified verdict still blocks', async () => {
    const { verifier, restore } = withVerifier('tolerant', unverifiedReply);
    try {
        const result = await verifier.submitKey(UNATTESTED);
        assert.equal(result.status, 'unverified');
        assert.equal(verifier.pendingSubmissions.size, 0);
    } finally { restore(); }
});

test('advisory: an explicit unverified verdict continues without a retry queue', async () => {
    const { verifier, restore } = withVerifier('advisory', unverifiedReply);
    try {
        const result = await verifier.submitKey(UNATTESTED);
        assert.equal(result.status, 'verifier-unavailable');
        assert.equal(result.detail, 'unverified_advisory');
        assert.equal(result.verdict, 'ownership_failed');
        assert.equal(verifier.pendingSubmissions.size, 0, 'a verdict is final; nothing to retry');
    } finally { restore(); }
});

test('advisory: an invalid org signature continues only after the trusted station signature passes', async () => {
    const { verifier, restore } = withVerifier('advisory', { response: { ok: false, status: 401 }, data: { detail: 'Invalid org signature' } });
    try {
        const result = await verifier.submitKey(UNATTESTED);
        assert.equal(result.status, 'verifier-unavailable');
        assert.equal(result.detail, 'unverified_advisory');
        assert.equal(result.trustedStationFallback.stationId, UNATTESTED.stationId);
        assert.equal(result.trustedStationFallback.stationSignature, UNATTESTED.stationSignature);
    } finally { restore(); }
});

test('tolerant: a 4xx refusal blocks', async () => {
    const { verifier, restore } = withVerifier('tolerant', { response: { ok: false, status: 401 }, data: { detail: 'signature mismatch' } });
    try {
        assert.equal((await verifier.submitKey(UNATTESTED)).status, 'rejected');
    } finally { restore(); }
});

test('background retry stops at an advisory verdict instead of exhausting attempts', async () => {
    const { verifier, restore } = withVerifier('advisory', transportError());
    try {
        const first = await verifier.submitKey(UNATTESTED);
        assert.equal(first.detail, 'verifier_outage');
        const results = [];
        await verifier.trackPendingAccess({ ...UNATTESTED, verifierSubmitKeyProof: { status: 'verifier-unavailable', detail: 'verifier_outage' } }, 'observer', r => { results.push(r); });
        const entry = verifier.pendingSubmissions.get(first.keyHash);
        entry.nextRetryAt = 0;
        networkProxy.fetchWithRetryJson = async () => unverifiedReply;
        await verifier.processPendingSubmissions();
        assert.equal(results.length, 1);
        assert.equal(results[0].detail, 'unverified_advisory');
        assert.equal(verifier.pendingSubmissions.size, 0);
    } finally { restore(); }
});

test('background retry upgrades an outage-admitted unattested key once the verifier approves', async () => {
    const { verifier, restore } = withVerifier('tolerant', transportError());
    try {
        const first = await verifier.submitKey(UNATTESTED);
        const results = [];
        await verifier.trackPendingAccess({ ...UNATTESTED, verifierSubmitKeyProof: { status: 'verifier-unavailable', detail: 'verifier_outage' } }, 'observer', r => { results.push(r); });
        verifier.pendingSubmissions.get(first.keyHash).nextRetryAt = 0;
        const keyHash = await verifier._hashKey(UNATTESTED.key);
        networkProxy.fetchWithRetryJson = async () => ({ response: { ok: true, status: 200 }, data: { status: 'verified', station_id: UNATTESTED.stationId, key_hash: keyHash } });
        await verifier.processPendingSubmissions();
        assert.equal(results[0]?.status, 'verified');
    } finally { restore(); }
});


for (const policy of ['strict', 'tolerant', 'advisory']) {
    for (const reply of [transportError(), timeoutError(), pendingReply, malformedReply,
        { response: { ok: false, status: 429 }, data: {} },
        { response: { ok: false, status: 503 }, data: { status: 'unverified', detail: 'ownership_check_error' } },
        { response: { ok: false, status: 401 }, data: { detail: 'Invalid org signature' } },
        unverifiedReply]) {
        test(`${policy}: no fallback without a valid explicitly trusted station (${reply.status || reply.response?.status || reply.name})`, async () => {
            const { verifier, restore } = withVerifier(policy, reply);
            try {
                for (const changes of [{ stationId: 'unknown-station' }, { stationSignature: '00'.repeat(64) },
                    { key: 'swapped-child' }, { expiresAtUnix: ATTESTED.expiresAtUnix + 1 }]) {
                    const result = await verifier.submitKey({ ...ATTESTED, ...changes });
                    assert.notEqual(result.status, 'verifier-unavailable');
                    assert.notEqual(result.status, 'verified');
                    assert.equal(verifier.pendingSubmissions.size, 0);
                }
            } finally { restore(); }
        });
    }
    test(`${policy}: a station outside the fallback trust list can still get matching verifier approval`, async () => {
        const { verifier, restore } = withVerifier(policy, null);
        const unknown = { ...UNATTESTED, stationId: 'unknown-station' };
        networkProxy.fetchWithRetryJson = async () => ({ response: { ok: true, status: 200 },
            data: { status: 'verified', station_id: unknown.stationId, key_hash: await verifier._hashKey(unknown.key) } });
        try { assert.equal((await verifier.submitKey(unknown)).status, 'verified'); }
        finally { restore(); }
    });
    for (const data of [
        { detail: 'Station is banned' },
        { status: 'banned' },
        { status: 'pending', banned_station: { station_id: UNATTESTED.stationId, reason: 'logging detected' } },
        { status: 'verified', banned_station: { station_id: UNATTESTED.stationId, reason: 'logging detected' } }
    ]) {
        test(`${policy}: HTTP 200 with ${data.status} ban data blocks before recovery`, async () => {
            const { verifier, restore } = withVerifier(policy, { response: { ok: true, status: 200 }, data });
            try {
                const result = await verifier.submitKey(ATTESTED);
                assert.equal(result.status, 'rejected');
                assert.equal(result.error.status, 'banned');
                assert.equal(verifier.pendingSubmissions.size, 0);
            } finally { restore(); }
        });
    }
}
