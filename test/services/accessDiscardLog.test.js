import test from 'node:test';
import assert from 'node:assert/strict';
import { clearUnverifiedOpenRouterAccess } from '../../chat/services/inference/verifiedAccess.js';
import { applyVerifierRetryResult } from '../../chat/application/verifierRecovery.js';
import { acquireSessionAccess } from '../../chat/application/accessController.js';
import {
    ACCESS_DISCARD_ACTION,
    ACCESS_MISSING_ACTION,
    ACCESS_OVERWRITE_ACTION,
    ACCESS_REPLACE_ACTION,
    describeAccessDiscard,
    logAccessDiscard,
    logAccessOverwrite,
    noteLoadedSession,
    rememberHeldAccess
} from '../../chat/services/inference/accessDiscardLog.js';

// A key that disappears between two messages must leave a reason in the
// Activity Timeline (release browser audit, 2026-09-29, finding 1).

function fakeSessionStorage() {
    const map = new Map();
    return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), map };
}

async function withTimeline(run) {
    const entries = [];
    const previousWindow = globalThis.window;
    const previousInfo = console.info;
    globalThis.window = { networkLogger: { logRequest: entry => { entries.push(entry); return entry; } }, sessionStorage: fakeSessionStorage() };
    console.info = () => {};
    try { return await run(entries); } finally {
        console.info = previousInfo;
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
}

const session = () => ({
    id: 'session-1',
    apiKey: 'sk-or-v1-secret-secret-secret',
    currentEphemeralKeyId: 'eph-7',
    expiresAt: '2026-09-29T10:00:00Z',
    apiKeyInfo: { stationId: 'station-9', verifierSubmitKeyProof: { status: 'unverified', detail: 'ownership_failed' } },
    ephemeralKeyMappings: { 'eph-7': { underlyingKeyId: 'sk-or-v1-secret-secret-secret' } }
});

test('a discard records its reason, the ephemeral id and the station, never the key', async () => {
    await withTimeline(entries => {
        const target = session();
        logAccessDiscard(target, 'credits-exhausted');
        assert.equal(entries.length, 1);
        const [entry] = entries;
        assert.equal(entry.type, 'local');
        assert.equal(entry.action, ACCESS_DISCARD_ACTION);
        assert.equal(entry.sessionId, 'session-1');
        assert.equal(entry.message, 'Session key discarded: the provider reported the key’s credit as used up');
        assert.deepEqual(entry.response, {
            reason: 'credits-exhausted', ephemeralKeyId: 'eph-7', stationId: 'station-9',
            verification: 'unverified', verificationDetail: 'ownership_failed',
            expiresAt: '2026-09-29T10:00:00Z', backend: 'openrouter'
        });
        assert.doesNotMatch(JSON.stringify(entry), /sk-or-v1/);
    });
});

test('nothing is logged for a session without a key, and an unknown reason still reads', async () => {
    await withTimeline(entries => {
        logAccessDiscard({ id: 'session-2', apiKey: null }, 'backend-change');
        assert.equal(entries.length, 0);
    });
    assert.equal(describeAccessDiscard('made-up'), 'no reason was given');
});

test('the persisted-access audit and a background verifier rejection say why the key went', async () => {
    await withTimeline(entries => {
        const target = session();
        assert.equal(clearUnverifiedOpenRouterAccess(target), true);
        assert.equal(target.apiKey, null);
        assert.equal(entries[0].response.reason, 'persisted-unverified');
        assert.equal(entries[0].response.ephemeralKeyId, 'eph-7', 'captured before the mapping is removed');

        const outage = session();
        outage.apiKeyInfo.verifierSubmitKeyProof = { status: 'verifier-unavailable', detail: 'verifier_outage' };
        const accessInfo = { key: outage.apiKey, stationId: 'station-9' };
        assert.equal(applyVerifierRetryResult(outage, accessInfo, { status: 'rejected', error: new Error('banned') }), true);
        assert.equal(outage.apiKey, null);
        assert.equal(entries[1].response.reason, 'verifier-retry-rejected');
    });
});

test('requesting a new key while one is stored is recorded with why it was passed over', async () => {
    await withTimeline(async entries => {
        const service = {
            setAccessInfo: (target, info) => { target.apiKey = info.token; },
            getAccessToken: target => target.usable ? target.apiKey : null,
            getVerificationAdapter: () => ({ supports: false })
        };
        const chatDB = { saveSession: async () => {} };
        const acquire = target => acquireSessionAccess({
            session: target, inferenceService: service, chatDB, acquireAccess: async () => ({ token: 'new-token' })
        });
        const valid = { ...session(), usable: true, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
        await acquire(valid);
        assert.equal(entries.at(-1).action, ACCESS_REPLACE_ACTION);
        assert.equal(entries.at(-1).response.reason, 'unspecified', 'a valid key replaced for no stated reason is the audit’s case');

        const expired = { ...session(), usable: true, expiresAt: '2020-01-01T00:00:00Z' };
        await acquire(expired);
        assert.equal(entries.at(-1).response.reason, 'expired');

        const unusable = { ...session(), usable: false };
        await acquire(unusable);
        assert.equal(entries.at(-1).response.reason, 'not-usable');

        const fresh = { id: 'session-3', apiKey: null };
        const before = entries.length;
        await acquire(fresh);
        assert.equal(entries.length, before, 'a first key is not a replacement');
    });
});

test('the Activity Timeline names the discard and spells out its facts in detail', async () => {
    const { getActivityDescription } = await import('../../chat/services/networkLogRenderer.js');
    const log = { type: 'local', method: 'LOCAL', action: ACCESS_DISCARD_ACTION,
        message: 'Session key discarded: the chat switched payment mode',
        response: { reason: 'backend-change', ephemeralKeyId: 'eph-7', stationId: 'station-9', verification: 'verified', expiresAt: '2026-09-29T10:00:00Z' } };
    assert.equal(getActivityDescription(log), 'Session key discarded: the chat switched payment mode');
    assert.match(getActivityDescription(log, true), /Ephemeral key eph-7, station station-9, verification verified, expires 2026-09-29T10:00:00Z\. The next message spends a ticket on a new key\./);
});

const valid = (overrides = {}) => ({ ...session(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    apiKeyInfo: { stationId: 'station-9', verifierSubmitKeyProof: { status: 'verified' } }, ...overrides });

test('a chat reloaded without the unexpired key this tab held is reported as missing', async () => {
    await withTimeline(entries => {
        const before = valid({ currentEphemeralKeyId: 'eph-20' });
        const loaded = { id: 'session-1', apiKey: null };
        noteLoadedSession(loaded, before);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].action, ACCESS_MISSING_ACTION);
        assert.equal(entries[0].response.reason, 'missing-after-reload');
        assert.equal(entries[0].response.ephemeralKeyId, 'eph-20');
        assert.doesNotMatch(JSON.stringify(entries), /sk-or-v1/);

        // An expired key, or one this tab discarded itself, is not missing.
        noteLoadedSession(loaded, valid({ currentEphemeralKeyId: 'eph-21', expiresAt: '2020-01-01T00:00:00Z' }));
        const discarded = valid({ id: 'session-2', currentEphemeralKeyId: 'eph-8' });
        logAccessDiscard(discarded, 'backend-change');
        noteLoadedSession({ id: 'session-2', apiKey: null }, discarded);
        assert.deepEqual(entries.slice(1).map(entry => entry.action), [ACCESS_DISCARD_ACTION]);
    });
});

test('a chat that comes back from navigation without the key this tab remembered is reported once', async () => {
    await withTimeline(entries => {
        const held = valid({ id: 'session-3', currentEphemeralKeyId: 'eph-9' });
        rememberHeldAccess(held);
        assert.match(globalThis.window.sessionStorage.getItem('oa-held-access'), /eph-9/);
        assert.doesNotMatch(globalThis.window.sessionStorage.getItem('oa-held-access'), /sk-or-v1/);
        // No in-memory copy after a navigation: only the per-tab record remains.
        noteLoadedSession({ id: 'session-3', apiKey: null }, null);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].response.reason, 'missing-after-navigation');
        assert.equal(entries[0].response.ephemeralKeyId, 'eph-9');
        noteLoadedSession({ id: 'session-3', apiKey: null }, null);
        assert.equal(entries.length, 1, 'the record is cleared after one report');

        // A chat that comes back with its key refreshes the record silently.
        noteLoadedSession(held, null);
        assert.equal(entries.length, 1);
        assert.match(globalThis.window.sessionStorage.getItem('oa-held-access'), /eph-9/);
    });
});

test('a save without a key over a stored, unexpired key is reported by the storage layer', async () => {
    await withTimeline(async entries => {
        const stored = valid({ id: 'session-4', currentEphemeralKeyId: 'eph-10' });
        logAccessOverwrite(stored, { id: 'session-4', apiKey: null });
        assert.equal(entries.length, 1);
        assert.equal(entries[0].action, ACCESS_OVERWRITE_ACTION);
        assert.equal(entries[0].response.reason, 'stale-save');
        // Not when the incoming copy keeps a key, when the stored one expired,
        // when the ids differ, or when this tab discarded it on purpose.
        logAccessOverwrite(stored, { id: 'session-4', apiKey: 'other' });
        logAccessOverwrite(valid({ id: 'session-5', expiresAt: '2020-01-01T00:00:00Z' }), { id: 'session-5', apiKey: null });
        logAccessOverwrite(stored, { id: 'session-6', apiKey: null });
        logAccessDiscard(stored, 'credits-exhausted');
        logAccessOverwrite(stored, { id: 'session-4', apiKey: null });
        assert.deepEqual(entries.slice(1).map(entry => entry.action), [ACCESS_DISCARD_ACTION]);

        // chatDB reads the stored copy in the same transaction only when the
        // incoming copy has no key, and always writes what it was given.
        const { chatDB } = await import('../../chat/db.js');
        const writes = [];
        const store = {
            get: id => { const request = { onsuccess: null }; queueMicrotask(() => request.onsuccess?.({ target: request })); request.result = id === 'session-7' ? valid({ id: 'session-7', currentEphemeralKeyId: 'eph-11' }) : null; return request; },
            put: value => writes.push(value)
        };
        chatDB.putSessionNotingOverwrite(store, { id: 'session-7', apiKey: null });
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(writes.length, 1);
        assert.equal(entries.at(-1).action, ACCESS_OVERWRITE_ACTION);
        assert.equal(entries.at(-1).response.ephemeralKeyId, 'eph-11');
        const before = entries.length;
        chatDB.putSessionNotingOverwrite(store, { id: 'session-7', apiKey: 'kept' });
        assert.equal(writes.length, 2, 'a keyed save is written without a read');
        assert.equal(entries.length, before);
    });
});

test('a key granted again after a discard is live again: losing it is reported', async () => {
    await withTimeline(entries => {
        const held = valid({ id: 'session-8', currentEphemeralKeyId: 'eph-30' });
        logAccessDiscard(held, 'backend-change');
        rememberHeldAccess(held); // setAccessInfo with the same underlying key reuses the ephemeral id
        noteLoadedSession({ id: 'session-8', apiKey: null }, held);
        assert.deepEqual(entries.map(entry => entry.action), [ACCESS_DISCARD_ACTION, ACCESS_MISSING_ACTION]);
    });
});
