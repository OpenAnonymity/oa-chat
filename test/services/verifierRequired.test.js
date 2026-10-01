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
const { default: networkLogger } = await import('../../chat/services/networkLogger.js');
const { StationVerifier } = await import('../../chat/services/verifier.js');

test.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
});

const KEY_DATA = signStationKey({
    recentlyAttested: true,
    stationId: 'station-dominic-local-v2',
    key: 'child-secret',
    expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
    stationSignature: 'station-signature',
    orgSignature: 'org-signature'
});
const TRUSTED_STATIONS = trustedStationPins(KEY_DATA.stationId);
const KEY_HASH = '1b208a37bbf953ac';

test('submitKey sends child keys through the verifier path', async () => {
    const originalFetch = networkProxy.fetchWithRetryJson;
    const calls = [];
    const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
    networkProxy.fetchWithRetryJson = async (url, options) => {
        calls.push({ url, options });
        return {
            response: { ok: true, status: 200 },
            data: {
                status: 'verified',
                station_id: KEY_DATA.stationId,
                key_hash: KEY_HASH
            }
        };
    };

    try {
        const result = await verifier.submitKey(KEY_DATA);
        assert.equal(result.status, 'verified');
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /\/submit_key$/);
    } finally {
        networkProxy.fetchWithRetryJson = originalFetch;
    }
});

for (const mismatch of ['station_id', 'key_hash']) {
    test(`verified response rejects a mismatched ${mismatch}`, async () => {
        const originalFetch = networkProxy.fetchWithRetryJson;
        const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
        networkProxy.fetchWithRetryJson = async () => ({
            response: { ok: true, status: 200 },
            data: {
                status: 'verified',
                station_id: mismatch === 'station_id'
                    ? 'another-station'
                    : KEY_DATA.stationId,
                key_hash: mismatch === 'key_hash'
                    ? '0000000000000000'
                    : KEY_HASH
            }
        });

        try {
            const result = await verifier.submitKey(KEY_DATA);
            assert.equal(result.status, 'rejected');
            assert.match(result.error.message, /did not match/);
        } finally {
            networkProxy.fetchWithRetryJson = originalFetch;
        }
    });
}

test('broadcast polling remains active for verifier-backed access', async () => {
    const originalFetch = networkProxy.fetchWithRetryJson;
    const originalChatDB = window.chatDB;
    window.chatDB = null;
    networkProxy.fetchWithRetryJson = async (url) => {
        assert.match(url, /\/broadcast$/);
        return {
            response: { ok: true, status: 200 },
            data: {
                verified_stations: [{
                    station_id: 'station-dominic-local-v2',
                    public_key: '11'.repeat(32)
                }],
                banned_stations: []
            }
        };
    };

    try {
        const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
        const result = await verifier.queryBroadcast();
        assert.equal(result.verified_stations.length, 1);
        assert.equal(verifier.verifierOnline, true);
    } finally {
        networkProxy.fetchWithRetryJson = originalFetch;
        window.chatDB = originalChatDB;
    }
});

test('periodic polling can reuse the initial verifier check without another immediate request', async () => {
    const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
    let calls = 0;
    verifier.queryBroadcast = async () => {
        calls += 1;
        return { verified_stations: [], banned_stations: [] };
    };

    verifier.startBroadcastCheck(() => null, { immediate: false });
    try {
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(calls, 0);
        assert.ok(verifier.broadcastCheckInterval);
    } finally {
        verifier.stopBroadcastCheck();
    }
});

test('a successful HTTP response without verified status fails closed', async () => {
    const originalFetch = networkProxy.fetchWithRetryJson;
    networkProxy.fetchWithRetryJson = async () => ({
        response: { ok: true, status: 200 },
        data: { status: 'unknown' }
    });

    try {
        const result = await new StationVerifier({ trustedStations: TRUSTED_STATIONS }).submitKey(KEY_DATA);
        assert.equal(result.status, 'rejected');
        assert.match(result.error.message, /invalid success response/);
    } finally {
        networkProxy.fetchWithRetryJson = originalFetch;
    }
});

test('pending verification does not retain the provisional child key', async () => {
    const originalFetch = networkProxy.fetchWithRetryJson;
    networkProxy.fetchWithRetryJson = async () => ({
        response: { ok: true, status: 200 },
        data: { status: 'pending', detail: 'verification_pending' }
    });

    try {
        const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
        const result = await verifier.submitKey(KEY_DATA);

        assert.equal(result.status, 'pending');
        assert.equal(verifier.pendingSubmissions.size, 0);
        assert.doesNotMatch(JSON.stringify(verifier), /child-secret/);
    } finally {
        networkProxy.fetchWithRetryJson = originalFetch;
    }
});

test('verifier network errors allow outage access with a bounded browser-memory retry', async () => {
    const originalFetch = networkProxy.fetchWithRetryJson;
    networkProxy.fetchWithRetryJson = async () => {
        throw new Error('network unavailable');
    };

    try {
        const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
        const result = await verifier.submitKey({
            ...KEY_DATA,
            recentlyAttested: true
        });

        assert.equal(result.status, 'verifier-unavailable');
        assert.equal(verifier.pendingSubmissions.size, 1);
        assert.doesNotMatch(JSON.stringify(verifier), /child-secret/);
    } finally {
        networkProxy.fetchWithRetryJson = originalFetch;
    }
});

test('verifier failures cannot echo a child key into diagnostics', async () => {
    const originalFetch = networkProxy.fetchWithRetryJson;
    const originalConsoleError = console.error;
    const consoleMessages = [];
    networkLogger.clearLogs();
    console.error = (...args) => consoleMessages.push(args.join(' '));
    networkProxy.fetchWithRetryJson = async () => ({
        response: { ok: false, status: 400 },
        data: {
            status: 'rejected',
            detail: 'child-secret is invalid',
            api_key: 'child-secret'
        }
    });

    try {
        const result = await new StationVerifier({ trustedStations: TRUSTED_STATIONS }).submitKey(KEY_DATA);

        assert.equal(result.status, 'rejected');
        assert.doesNotMatch(result.error.message, /child-secret/);
        assert.doesNotMatch(JSON.stringify(networkLogger.getAllLogs()), /child-secret/);
        assert.doesNotMatch(consoleMessages.join('\n'), /child-secret/);
    } finally {
        networkProxy.fetchWithRetryJson = originalFetch;
        console.error = originalConsoleError;
        networkLogger.clearLogs();
    }
});

for (const status of [408, 429, 500, 502, 503, 504]) {
    test(`HTTP ${status} permits clearly labeled outage access`, async () => {
        const originalFetch = networkProxy.fetchWithRetryJson;
        networkProxy.fetchWithRetryJson = async () => ({ response: { ok: false, status }, data: null });
        networkLogger.clearLogs();
        try {
            const result = await new StationVerifier({ trustedStations: TRUSTED_STATIONS }).submitKey(KEY_DATA);
            assert.equal(result.status, 'verifier-unavailable');
            assert.doesNotMatch(JSON.stringify(networkLogger.getAllLogs()), /child-secret/);
        } finally { networkProxy.fetchWithRetryJson = originalFetch; }
    });
}

for (const data of [
    { status: 'banned' }, { status: 'rejected' }, { status: 'unverified', detail: 'ownership_mismatch' },
    { error: 'invalid signature' }, { message: 'invalid key' }, { message: 'privacy check failed' },
    { status: 'denied' }, { status: 'invalid' }, { status: 'pending' }, { status: 'unknown' }, { error: { message: 'privacy check failed' } },
    { ownership_passed: false }, { ownership: { ownership_passed: false } }
]) {
    test(`explicit refusal on a 503 never becomes outage access: ${JSON.stringify(data)}`, async () => {
        const originalFetch = networkProxy.fetchWithRetryJson;
        networkProxy.fetchWithRetryJson = async () => ({ response: { ok: false, status: 503 }, data });
        try { assert.equal((await new StationVerifier({ trustedStations: TRUSTED_STATIONS }).submitKey(KEY_DATA)).status, 'rejected'); }
        finally { networkProxy.fetchWithRetryJson = originalFetch; }
    });
}

for (const status of [400, 401, 403, 404, 409, 422]) {
    test(`HTTP ${status} still blocks inference`, async () => {
        const originalFetch = networkProxy.fetchWithRetryJson;
        networkProxy.fetchWithRetryJson = async () => ({ response: { ok: false, status }, data: {} });
        try { assert.equal((await new StationVerifier({ trustedStations: TRUSTED_STATIONS }).submitKey(KEY_DATA)).status, 'rejected'); }
        finally { networkProxy.fetchWithRetryJson = originalFetch; }
    });
}

for (const [error, expected] of [
    [new TypeError('Failed to fetch'), 'verifier-unavailable'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'verifier-unavailable'],
    [Object.assign(new Error('aborted'), { name: 'AbortError', isUserAbort: true }), 'rejected'],
    [new TypeError('Cannot read properties of undefined'), 'rejected'],
    [new SyntaxError('Invalid JSON'), 'rejected']
]) {
    test(`transport ${error.name}: ${error.message} (user abort ${error.isUserAbort})`, async () => {
        const originalFetch = networkProxy.fetchWithRetryJson;
        networkProxy.fetchWithRetryJson = async () => { throw error; };
        try { assert.equal((await new StationVerifier({ trustedStations: TRUSTED_STATIONS }).submitKey(KEY_DATA)).status, expected); }
        finally { networkProxy.fetchWithRetryJson = originalFetch; }
    });
}

test('outages cannot authorize expired, malformed, or known-banned keys', async () => {
    const originalFetch = networkProxy.fetchWithRetryJson;
    networkProxy.fetchWithRetryJson = async () => { throw new TypeError('Failed to fetch'); };
    try {
        const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
        for (const changes of [{ expiresAtUnix: 1 }, { expiresAtUnix: 'invalid' }, { stationSignature: null }]) {
            assert.equal((await verifier.submitKey({ ...KEY_DATA, ...changes })).status, 'rejected');
        }
        verifier.lastBroadcastData = { banned_stations: [{ station_id: KEY_DATA.stationId }] };
        assert.equal((await verifier.submitKey(KEY_DATA)).status, 'rejected');
    } finally { networkProxy.fetchWithRetryJson = originalFetch; }
});

for (const recentlyAttested of [false, undefined, 'true']) {
    test(`ordinary verifier outage blocks without the production attestation flag: ${recentlyAttested}`, async () => {
        const originalFetch = networkProxy.fetchWithRetryJson;
        networkProxy.fetchWithRetryJson = async () => { throw new TypeError('Failed to fetch'); };
        try {
            const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
            assert.equal((await verifier.submitKey({ ...KEY_DATA, recentlyAttested })).status, 'rejected');
            assert.equal(verifier.pendingSubmissions.size, 0);
        } finally { networkProxy.fetchWithRetryJson = originalFetch; }
    });
}

for (const [status, data, detail] of [
    [503, { status: 'unverified', detail: 'ownership_check_error' }, 'ownership_check_error'],
    [429, {}, 'rate_limited']
]) {
    test(`production temporary ${detail} queues retry even without a recent attestation flag`, async () => {
        const originalFetch = networkProxy.fetchWithRetryJson;
        networkProxy.fetchWithRetryJson = async () => ({ response: { ok: false, status }, data });
        try {
            const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
            const result = await verifier.submitKey({ ...KEY_DATA, recentlyAttested: false });
            assert.equal(result.status, 'verifier-unavailable');
            assert.equal(result.detail, detail);
            assert.equal(verifier.pendingSubmissions.get(KEY_HASH).maxAttempts, 10);
        } finally { networkProxy.fetchWithRetryJson = originalFetch; }
    });
}

test('background retry upgrades only after matching key verification, without new key issuance', async () => {
    const originalFetch = networkProxy.fetchWithRetryJson;
    let available = false;
    const requests = [];
    networkProxy.fetchWithRetryJson = async (url, options) => {
        requests.push({ url, options });
        if (!available) throw new TypeError('Failed to fetch');
        return { response: { ok: true, status: 200 }, data: { status: 'verified', station_id: KEY_DATA.stationId, key_hash: KEY_HASH } };
    };
    try {
        const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
        const pending = await verifier.submitKey({ ...KEY_DATA, ticketsUsed: [{ finalizedTicket: 'ticket-secret' }] });
        assert.equal(pending.status, 'verifier-unavailable');
        assert.doesNotMatch(JSON.stringify(verifier.pendingSubmissions.get(KEY_HASH).keyData), /ticket-secret|ticketsUsed/);
        let recovered;
        const accessInfo = { ...KEY_DATA, verifierSubmitKeyProof: pending };
        await verifier.trackPendingAccess(accessInfo, 'session-1', result => { recovered = result; });
        available = true;
        verifier.pendingSubmissions.get(KEY_HASH).nextRetryAt = 0;
        await verifier.processPendingSubmissions();
        assert.equal(recovered.status, 'verified');
        assert.equal(verifier.pendingSubmissions.size, 0);
        assert.equal(requests.length, 2);
        assert.ok(requests.every(r => r.url.endsWith('/submit_key')));
    } finally { networkProxy.fetchWithRetryJson = originalFetch; }
});

for (const responseData of [{ status: 'verified', station_id: 'wrong-station', key_hash: KEY_HASH }, { status: 'rejected', detail: 'privacy check failed' }]) {
    test(`background ${responseData.status} result cannot override a rejection or mismatched approval`, async () => {
        const originalFetch = networkProxy.fetchWithRetryJson;
        networkProxy.fetchWithRetryJson = async () => { throw new TypeError('Failed to fetch'); };
        try {
            const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
            const result = await verifier.submitKey(KEY_DATA);
            let finalResult;
            await verifier.trackPendingAccess({ ...KEY_DATA, verifierSubmitKeyProof: result }, 'session', r => { finalResult = r; });
            networkProxy.fetchWithRetryJson = async () => ({ response: { ok: true, status: 200 }, data: responseData });
            verifier.pendingSubmissions.get(KEY_HASH).nextRetryAt = 0;
            await verifier.processPendingSubmissions();
            assert.equal(finalResult.status, 'rejected');
            assert.equal(verifier.pendingSubmissions.size, 0);
        } finally { networkProxy.fetchWithRetryJson = originalFetch; }
    });
}

test('outage retries stop after three total attempts and preserve an honest unverified state', async () => {
    const originalFetch = networkProxy.fetchWithRetryJson;
    networkProxy.fetchWithRetryJson = async () => { throw new TypeError('Failed to fetch'); };
    try {
        const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
        const proof = await verifier.submitKey(KEY_DATA);
        let result;
        await verifier.trackPendingAccess({ ...KEY_DATA, verifierSubmitKeyProof: proof }, 'session', r => { result = r; });
        for (let i = 0; i < 2; i++) {
            verifier.pendingSubmissions.get(KEY_HASH).nextRetryAt = 0;
            await verifier.processPendingSubmissions();
        }
        assert.equal(verifier.pendingSubmissions.size, 0);
        assert.equal(result.status, 'verifier-unavailable');
        assert.equal(result.detail, 'verification_retry_exhausted');
        await verifier.trackPendingAccess({ ...KEY_DATA, verifierSubmitKeyProof: result }, 'session', () => {});
        assert.equal(verifier.pendingSubmissions.size, 0);
    } finally { networkProxy.fetchWithRetryJson = originalFetch; }
});

test('restoring pending access resumes verification, but expired access never queues', async () => {
    const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
    const info = { ...KEY_DATA, verifierSubmitKeyProof: { status: 'verifier-unavailable', detail: 'recently_attested_outage' } };
    await verifier.trackPendingAccess({ ...info, expiresAtUnix: 1 }, 'session', () => {});
    assert.equal(verifier.pendingSubmissions.size, 0);
    await verifier.trackPendingAccess(info, 'session', () => {});
    assert.equal(verifier.pendingSubmissions.size, 1);
});

test('overlapping polling never submits the same pending key concurrently', async () => {
    const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
    verifier.queuePendingSubmission(KEY_DATA, KEY_HASH, 'recently_attested_outage');
    verifier.pendingSubmissions.get(KEY_HASH).nextRetryAt = 0;
    let complete;
    let calls = 0;
    verifier.submitKey = () => { calls++; return new Promise(resolve => { complete = resolve; }); };
    const first = verifier.processPendingSubmissions();
    await verifier.processPendingSubmissions();
    assert.equal(calls, 1);
    complete({ status: 'verified' });
    await first;
    assert.equal(verifier.pendingSubmissions.size, 0);
});

test('expired queued credentials are discarded without a request', async () => {
    const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
    verifier.queuePendingSubmission({ ...KEY_DATA, expiresAtUnix: 1 }, KEY_HASH, 'recently_attested_outage');
    const entry = verifier.pendingSubmissions.get(KEY_HASH);
    entry.nextRetryAt = 0;
    let result;
    entry.observers.set('session', value => { result = value; });
    verifier.submitKey = () => { throw new Error('Expired key must never be sent'); };
    await verifier.processPendingSubmissions();
    assert.equal(result.detail, 'key_expired_or_station_banned');
    assert.equal(verifier.pendingSubmissions.size, 0);
});

for (const [status, data, nextFailure] of [
    [429, {}, 'timeout'],
    [503, { status: 'unverified', detail: 'ownership_check_error' }, '502']
]) {
    test(`an admitted ${status} retry stays pending through a subsequent ${nextFailure} without recent attestation`, async () => {
        const originalFetch = networkProxy.fetchWithRetryJson;
        networkProxy.fetchWithRetryJson = async () => ({ response: { ok: false, status }, data });
        try {
            const verifier = new StationVerifier({ trustedStations: TRUSTED_STATIONS });
            await verifier.submitKey({ ...KEY_DATA, recentlyAttested: false });
            networkProxy.fetchWithRetryJson = async () => {
                if (nextFailure === 'timeout') throw new TypeError('Failed to fetch');
                return { response: { ok: false, status: 502 }, data: {} };
            };
            verifier.pendingSubmissions.get(KEY_HASH).nextRetryAt = 0;
            await verifier.processPendingSubmissions();
            assert.equal(verifier.pendingSubmissions.size, 1);
            assert.equal(verifier.pendingSubmissions.get(KEY_HASH).attempts, 2);
        } finally { networkProxy.fetchWithRetryJson = originalFetch; }
    });
}
