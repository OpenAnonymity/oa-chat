import test from 'node:test';
import assert from 'node:assert/strict';

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

const KEY_DATA = {
    stationId: 'station-dominic-local-v2',
    key: 'child-secret',
    expiresAtUnix: 1785413400,
    stationSignature: 'station-signature',
    orgSignature: 'org-signature'
};
const KEY_HASH = '1b208a37bbf953ac';

test('the low-level verifier adapter can submit child keys when called directly', async () => {
    const originalFetch = networkProxy.fetchWithRetryJson;
    const calls = [];
    const verifier = new StationVerifier();
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
        assert.equal(JSON.parse(calls[0].options.body).api_key, 'child-secret');
    } finally {
        networkProxy.fetchWithRetryJson = originalFetch;
    }
});

for (const mismatch of ['station_id', 'key_hash']) {
    test(`verified response rejects a mismatched ${mismatch}`, async () => {
        const originalFetch = networkProxy.fetchWithRetryJson;
        const verifier = new StationVerifier();
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

test('broadcast polling remains active on loopback', async () => {
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
        const verifier = new StationVerifier();
        const result = await verifier.queryBroadcast();
        assert.equal(result.verified_stations.length, 1);
        assert.equal(verifier.verifierOnline, true);
    } finally {
        networkProxy.fetchWithRetryJson = originalFetch;
        window.chatDB = originalChatDB;
    }
});

test('a successful HTTP response without verified status fails closed', async () => {
    const originalFetch = networkProxy.fetchWithRetryJson;
    networkProxy.fetchWithRetryJson = async () => ({
        response: { ok: true, status: 200 },
        data: { status: 'unknown' }
    });

    try {
        const result = await new StationVerifier().submitKey(KEY_DATA);
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
        const verifier = new StationVerifier();
        const result = await verifier.submitKey(KEY_DATA);

        assert.equal(result.status, 'pending');
        assert.equal('pendingSubmissions' in verifier, false);
        assert.doesNotMatch(JSON.stringify(verifier), /child-secret/);
    } finally {
        networkProxy.fetchWithRetryJson = originalFetch;
    }
});

test('verifier network errors reject without retaining the provisional child key', async () => {
    const originalFetch = networkProxy.fetchWithRetryJson;
    networkProxy.fetchWithRetryJson = async () => {
        throw new Error('network unavailable');
    };

    try {
        const verifier = new StationVerifier();
        const result = await verifier.submitKey({
            ...KEY_DATA,
            recentlyAttested: true
        });

        assert.equal(result.status, 'rejected');
        assert.equal('pendingSubmissions' in verifier, false);
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
        const result = await new StationVerifier().submitKey(KEY_DATA);

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
