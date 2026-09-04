import test from 'node:test';
import assert from 'node:assert/strict';
import { TicketStore } from '../../chat/services/ticketStore.js';
import syncService from '../../chat/services/encryptedSyncService.js';

for (const held of ['oa-inference-tickets', 'oa-sync']) {
    for (const interruption of ['abort', 'timeout']) {
        test(`wallet refresh ${interruption} cancels only queued ${held} ownership`, async t => {
            const timers = new Set();
            let arrived;
            const queued = new Promise(resolve => { arrived = resolve; });
            const requests = [];
            t.mock.method(syncService, 'assertAccountDataAccess', async () => 'account-a');
            const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
            Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
                request(name, options, run) {
                    requests.push({ name, options });
                    if (name !== held) return Promise.resolve().then(run);
                    arrived();
                    return new Promise((_, reject) => options.signal.addEventListener('abort',
                        () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
                }
            } } });
            t.after(() => original ? Object.defineProperty(globalThis, 'navigator', original) : delete globalThis.navigator);
            const store = new TicketStore();
            store.ensureDbReady = async () => {};
            let reads = 0;
            store.loadFromDatabase = async () => { reads++; };
            const controller = new AbortController();
            const work = store.refreshForAccount('account-a', {
                signal: controller.signal,
                setTimeoutImpl: (callback, delay) => { assert.equal(delay, 30_000); timers.add(callback); return callback; },
                clearTimeoutImpl: callback => timers.delete(callback)
            });
            const rejection = assert.rejects(work, interruption === 'abort'
                ? { name: 'AbortError' } : { code: 'ENTITLEMENT_LOCK_TIMEOUT' });
            await queued;
            if (interruption === 'abort') controller.abort();
            else [...timers].forEach(callback => callback());
            await rejection;
            assert.equal(reads, 0);
            assert.ok(requests.every(({ options }) => !options.steal));
            assert.equal(timers.size, 0);
        });
    }
}

test('wallet refresh retains acquired locks until its scoped read finishes', async t => {
    let finishRead, beginRead;
    const reading = new Promise(resolve => { beginRead = resolve; });
    const timers = new Set(), events = [];
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
        async request(name, options, run) { events.push(`acquire:${name}`); try { return await run(); } finally { events.push(`release:${name}`); } }
    } } });
    t.after(() => original ? Object.defineProperty(globalThis, 'navigator', original) : delete globalThis.navigator);
    t.mock.method(syncService, 'assertAccountDataAccess', async () => 'account-a');
    const store = new TicketStore();
    store.ensureDbReady = async () => {};
    store.loadFromDatabase = async () => { beginRead(); await new Promise(resolve => { finishRead = resolve; }); };
    store.emitUpdate = () => events.push('update');
    const work = store.refreshForAccount('account-a', {
        setTimeoutImpl: callback => { timers.add(callback); return callback; },
        clearTimeoutImpl: callback => timers.delete(callback)
    });
    await reading;
    assert.equal(timers.size, 0);
    assert.deepEqual(events, ['acquire:oa-inference-tickets', 'acquire:oa-sync']);
    finishRead(); await work;
    assert.deepEqual(events.slice(2), ['update', 'release:oa-sync', 'release:oa-inference-tickets']);
});
