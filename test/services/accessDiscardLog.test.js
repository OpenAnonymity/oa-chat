import test from 'node:test';
import assert from 'node:assert/strict';
import { clearUnverifiedOpenRouterAccess } from '../../chat/services/inference/verifiedAccess.js';
import { applyVerifierRetryResult } from '../../chat/application/verifierRecovery.js';
import { acquireSessionAccess } from '../../chat/application/accessController.js';
import {
    ACCESS_DISCARD_ACTION,
    ACCESS_REPLACE_ACTION,
    describeAccessDiscard,
    logAccessDiscard
} from '../../chat/services/inference/accessDiscardLog.js';

// A key that disappears between two messages must leave a reason in the
// Activity Timeline (release browser audit, 2026-09-29, finding 1).

async function withTimeline(run) {
    const entries = [];
    const previousWindow = globalThis.window;
    const previousInfo = console.info;
    globalThis.window = { networkLogger: { logRequest: entry => { entries.push(entry); return entry; } } };
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
