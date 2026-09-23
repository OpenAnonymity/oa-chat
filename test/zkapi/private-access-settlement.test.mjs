import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
window.location = { hostname: 'localhost', origin: 'http://localhost', search: '' };
globalThis.location = window.location;
globalThis.localStorage = globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { createPrivateAccessSettlement } = await import('../../chat/zkapi/services/privateAccessSettlement.js');
const deferred = () => {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
};

test('settlement reconciles interrupted issuance before the scoped SDK call', async () => {
    const calls = [];
    const settle = createPrivateAccessSettlement({
        client: { browserMode: true, init: async () => {},
            settleActiveLease: async (_report, options) => calls.push(['settle', options]) },
        recover: async options => calls.push(['recover', options.sessionId, options.signal.aborted])
    });
    await settle(undefined, { sessionId: 'old-chat' });
    assert.deepEqual(calls, [['recover', 'old-chat', false], ['settle', { sessionId: 'old-chat' }]]);
});

test('a failed recovery never proceeds to settlement or releases a reserved request', async () => {
    const failure = new Error('Issuer unavailable');
    const settle = createPrivateAccessSettlement({
        client: { browserMode: true, init: async () => {}, settleActiveLease: async () => assert.fail('unsafe continuation') },
        recover: async () => { throw failure; }
    });
    await assert.rejects(settle(), error => error === failure);
});

test('normal daemon New Chat keeps global settlement while explicit owner operations stay scoped', async () => {
    const calls = [];
    const settle = createPrivateAccessSettlement({
        client: { browserMode: false, init: async () => {},
            settleActiveLease: async (_status, options) => calls.push(options) },
        recover: async () => assert.fail('daemon recovery belongs to the daemon')
    });
    await settle(undefined, { sessionId: 'old-chat', expectedOwner: false });
    await settle(undefined, { sessionId: 'old-chat', expectedOwner: true });
    assert.deepEqual(calls, [{}, { sessionId: 'old-chat' }]);
});

test('a scoped SDK success cannot hide an ownerless journal, but a different owner is untouched', async () => {
    let owner = null;
    const settle = createPrivateAccessSettlement({
        client: { browserMode: true, init: async () => {}, settleActiveLease: async () => {},
            hasPendingLease: async () => true, getPendingLeaseOwner: async () => owner },
        recover: async () => false
    });
    await assert.rejects(settle(undefined, { sessionId: 'old-chat' }), /still needs recovery/);
    owner = 'new-chat';
    await settle(undefined, { sessionId: 'old-chat' });
});

test('a hung SDK mutation times out for withdrawal and remains owned until it exits', async () => {
    const held = deferred();
    let count = 0;
    const settle = createPrivateAccessSettlement({ timeoutMs: 10,
        client: { browserMode: false, init: async () => {}, settleActiveLease: async () => { count++; await held.promise; } },
        recover: async () => assert.fail('daemon must retain its own protocol')
    });
    await assert.rejects(settle(), /could not finish in time/);
    await assert.rejects(settle(), /could not finish in time/);
    assert.equal(count, 1);
    held.resolve();
    await new Promise(resolve => setImmediate(resolve));
    await settle();
    assert.equal(count, 2);
});

test('canceling a second waiter does not cancel the owner or start another operation', async () => {
    const held = deferred();
    let count = 0;
    const settle = createPrivateAccessSettlement({
        client: { browserMode: false, init: async () => {}, settleActiveLease: async () => { count++; await held.promise; } }
    });
    const first = settle(undefined, { sessionId: 'old-chat' });
    const controller = new AbortController();
    const second = settle(undefined, { sessionId: 'new-chat', signal: controller.signal });
    controller.abort();
    await assert.rejects(second, { name: 'AbortError' });
    held.resolve();
    await first;
    assert.equal(count, 1);
});

test('cancellation while recovery is in flight cannot later start settlement', async () => {
    const held = deferred();
    let recoverySignal;
    const settle = createPrivateAccessSettlement({
        client: { browserMode: true, init: async () => {}, settleActiveLease: async () => assert.fail('canceled') },
        recover: async ({ signal }) => { recoverySignal = signal; await held.promise; }
    });
    const controller = new AbortController();
    const waiting = settle(undefined, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(recoverySignal.aborted, true);
    held.resolve();
    await new Promise(resolve => setImmediate(resolve));
});
