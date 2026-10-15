import test from 'node:test';
import assert from 'node:assert/strict';
import { chatDB } from '../../chat/db.js';
import sessionService from '../../chat/services/sessionService.js';
import { SyncService } from '../../chat/services/encryptedSyncService.js';

function fixture(t, fetch) {
    const originalFetch = sessionService.fetch;
    const originalGet = chatDB.getSetting;
    t.after(() => { sessionService.fetch = originalFetch; chatDB.getSetting = originalGet; });
    sessionService.fetch = fetch;
    chatDB.getSetting = async () => 10;
    const service = new SyncService();
    service.isEnabled = () => true;
    service.isAccountScopeActive = async () => true;
    service.lastSyncTime = 123;
    const events = [];
    service.notify = (event, data) => events.push({ event, data });
    return { service, events };
}

for (const [name, fetch] of [
    ['network failure', async () => { throw new TypeError('synthetic network failure'); }],
    ['HTTP rejection', async () => new Response('{}', { status: 503 })],
    ['missing timestamp', async () => Response.json({})],
    ['invalid timestamp', async () => Response.json({ last_sync: 'invalid' })]
]) {
    test(`sync status ${name} is not reported as up to date`, async t => {
        const { service, events } = fixture(t, fetch);
        const result = await service.syncIfNeeded();
        assert.equal(result.success, false);
        assert.notEqual(result.reason, 'up-to-date');
        assert.equal(service.lastSyncTime, 123);
        assert.equal(service.lastSyncResult.success, false);
        assert.equal(events.some(e => e.event === 'status_checked'), false);
        assert.equal(events.filter(e => e.event === 'sync_error').length, 1);
    });
}

for (const last_sync of [null, 0, 10, 11]) {
    test(`valid sync timestamp ${last_sync} keeps the existing comparison`, async t => {
        const { service, events } = fixture(t, async () => Response.json({ last_sync }));
        assert.equal(await service.hasRemoteChanges(), last_sync === 11);
        assert.equal(events.some(e => e.event === 'status_checked'), last_sync !== 11);
    });
}

test('a status failure from old credentials cannot replace new-account state', async t => {
    let reject;
    const { service, events } = fixture(t, () => new Promise((_, r) => { reject = r; }));
    const pending = service.hasRemoteChanges();
    while (!reject) await new Promise(resolve => setImmediate(resolve));
    service.credentialGeneration++;
    service.lastSyncResult = { success: true, replacement: true };
    reject(new TypeError('old request failed'));
    assert.equal(await pending, null);
    assert.deepEqual(service.lastSyncResult, { success: true, replacement: true });
    assert.deepEqual(events, []);
});

test('a stalled status body times out without retries or a false success', { timeout: 8000 }, async t => {
    let attempts = 0;
    let signal;
    const { service, events } = fixture(t, async (_, init) => {
        attempts++;
        signal = init.signal;
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }));
    });
    const result = await service.syncIfNeeded();
    assert.equal(result.success, false);
    assert.equal(attempts, 1);
    assert.equal(signal.aborted, true);
    assert.equal(service.lastSyncTime, 123);
    assert.equal(events.some(e => e.event === 'status_checked'), false);
});
