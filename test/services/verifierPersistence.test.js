import test from 'node:test';
import assert from 'node:assert/strict';

const globalNames = ['localStorage', 'sessionStorage', 'window', 'location', 'addEventListener', 'dispatchEvent', 'document'];
const captureGlobals = () => new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
function restoreGlobals(snapshot) {
    for (const [name, descriptor] of snapshot) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
    }
}
const events = [];
function installBrowser(t) {
    const previous = captureGlobals();
    globalThis.localStorage = globalThis.sessionStorage = {
        getItem() { return null; }, setItem() {}, removeItem() {}
    };
    globalThis.location = { hostname: 'staging.example', origin: 'https://staging.example', href: 'https://staging.example/' };
    globalThis.addEventListener = () => {};
    globalThis.dispatchEvent = event => events.push(event);
    globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
    globalThis.window = {
        location, document, localStorage, sessionStorage,
        addEventListener: globalThis.addEventListener, dispatchEvent: globalThis.dispatchEvent
    };
    if (t) t.after(() => restoreGlobals(previous));
    return previous;
}
const importGlobals = installBrowser();
const { chatDB } = await import('../../chat/db.js');
const { applyVerifierRetryResult } = await import('../../chat/application/verifierRecovery.js');
const { default: backend } = await import('../../chat/services/inference/backends/openRouterBackend.js');
const { default: verifier } = await import('../../chat/services/verifier.js');
restoreGlobals(importGlobals);

const access = key => ({
    key, stationId: 'station', expiresAtUnix: Math.floor(Date.now() / 1000) + 600,
    recentlyAttested: true, stationSignature: 'station-signature', orgSignature: 'org-signature',
    verifierSubmitKeyProof: { status: 'verifier-unavailable', detail: 'recently_attested_outage' }
});
const session = (key = 'pending-child') => ({
    id: 'chat-1', title: 'Original title', apiKey: key, apiKeyInfo: access(key)
});

// Model request/transaction completion separately: the production method must
// merge the latest stored row and await commit, not read a stale session snapshot.
function storageFixture(initial) {
    const rows = new Map(initial ? [[initial.id, structuredClone(initial)]] : []);
    let commits = 0;
    chatDB.db = {
        transaction(names, mode) {
            assert.deepEqual(names, ['sessions']);
            assert.equal(mode, 'readwrite');
            const transaction = {
                objectStore() { return {
                    get(id) {
                        const request = {};
                        queueMicrotask(() => {
                            request.result = structuredClone(rows.get(id));
                            request.onsuccess();
                            queueMicrotask(() => { commits++; transaction.oncomplete(); });
                        });
                        return request;
                    },
                    put(row) { rows.set(row.id, structuredClone(row)); }
                }; }
            };
            return transaction;
        }
    };
    return { rows, get commits() { return commits; } };
}

test('retry persistence does not recreate a deleted chat', async (t) => {
    installBrowser(t);
    const db = storageFixture();
    assert.equal(await chatDB.updateExistingSession('chat-1', row =>
        applyVerifierRetryResult(row, access('pending-child'), { status: 'verified' })), false);
    assert.equal(db.rows.size, 0);
    assert.equal(db.commits, 1);
});

test('retry persistence preserves newer title and replacement key', async (t) => {
    installBrowser(t);
    const replacement = { ...session('replacement-child'), title: 'Edited title' };
    const db = storageFixture(replacement);
    assert.equal(await chatDB.updateExistingSession('chat-1', row =>
        applyVerifierRetryResult(row, access('pending-child'), { status: 'rejected' })), false);
    assert.deepEqual(db.rows.get('chat-1'), replacement);
    assert.equal(db.commits, 1);
});

test('retry persistence merges approval without overwriting newer session metadata', async (t) => {
    installBrowser(t);
    const saved = { ...session(), title: 'Edited while verification was pending', updatedAt: 'newer' };
    const db = storageFixture(saved);
    assert.equal(await chatDB.updateExistingSession('chat-1', row =>
        applyVerifierRetryResult(row, access('pending-child'), { status: 'verified' })), true);
    assert.equal(db.rows.get('chat-1').title, saved.title);
    assert.equal(db.rows.get('chat-1').updatedAt, 'newer');
    assert.equal(db.rows.get('chat-1').apiKeyInfo.verifierSubmitKeyProof.status, 'verified');
    assert.equal(db.commits, 1);
});

for (const status of ['verified', 'rejected']) {
    test(`backend retry ${status} updates both live and persisted access without exposing credentials in events`, async (t) => {
        installBrowser(t);
        const live = session();
        const db = storageFixture({ ...live, title: 'New stored title' });
        events.length = 0;
        verifier.pendingSubmissions.clear();
        const originalSubmit = verifier.submitKey;
        try {
            backend.verification.trackPendingAccess(live.apiKeyInfo, live);
            // Hashing is asynchronous; wait for the actual adapter observer to register.
            for (let i = 0; i < 100 && ![...verifier.pendingSubmissions.values()].some(e => e.observers.size); i++) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            assert.equal(verifier.pendingSubmissions.size, 1);
            const pending = [...verifier.pendingSubmissions.values()][0];
            assert.equal(pending.observers.size, 1);
            pending.nextRetryAt = 0;
            verifier.submitKey = async () => ({ status });
            await verifier.processPendingSubmissions();
            const saved = db.rows.get(live.id);
            assert.equal(saved.title, 'New stored title');
            assert.equal(live.apiKey, status === 'verified' ? 'pending-child' : null);
            assert.equal(saved.apiKey, live.apiKey);
            if (status === 'verified') {
                assert.equal(saved.apiKeyInfo.verifierSubmitKeyProof.status, 'verified');
                assert.equal(live.apiKeyInfo.verifierSubmitKeyProof.status, 'verified');
            }
            assert.equal(db.commits, 1);
            assert.equal(verifier.pendingSubmissions.size, 0);
            assert.deepEqual(events.filter(e => e.type === 'access-verification-updated').map(e => e.detail), [{ sessionId: live.id }]);
        } finally {
            verifier.submitKey = originalSubmit;
            verifier.pendingSubmissions.clear();
        }
    });
}
