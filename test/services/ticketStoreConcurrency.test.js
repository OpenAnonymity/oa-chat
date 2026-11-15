import test from 'node:test';
import assert from 'node:assert/strict';
import { TicketStore } from '../../chat/services/ticketStore.js';
import syncService from '../../chat/services/encryptedSyncService.js';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

for (const balance of [1, 2]) {
    test(`separate ticket stores coordinate overlapping redemption with ${balance} available`, async t => {
        // Simulate two tab-local stores sharing origin-wide Web Locks and DB.
        // Exercise the real withLock/consumeTickets code, replacing only browser
        // infrastructure, account authentication and durable I/O.
        const queues = new Map();
        const lockNames = [];
        const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
            request(name, options, handler) {
                assert.equal(options.mode, 'exclusive');
                lockNames.push(name);
                const next = (queues.get(name) || Promise.resolve()).then(handler);
                queues.set(name, next.catch(() => {}));
                return next;
            }
        } } });
        t.after(() => {
            if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
            else delete globalThis.navigator;
        });
        t.mock.method(syncService, 'assertAccountDataAccess', async () => 'test-account');
        t.mock.method(syncService, 'shouldDeferRedemptionSync', () => true);
        let stored = { active: Array.from({ length: balance }, (_, i) => ({ finalized_ticket: `test-ticket-${i}` })), archived: [] };
        const stores = [new TicketStore(), new TicketStore()];
        for (const store of stores) {
            store.ensureDbReady = async () => {};
            store.readFromDatabase = async () => structuredClone(stored);
            store.persistTickets = async (active, archived) => { stored = structuredClone({ active, archived }); };
        }
        const entered = deferred();
        const finishRedemption = deferred();
        const first = stores[0].consumeTickets(1, async ({ tickets }) => {
            entered.resolve();
            await finishRedemption.promise;
            return tickets[0].finalized_ticket;
        }, { expectedAccountId: 'test-account' });
        await entered.promise;
        let secondEntered = false;
        const second = stores[1].consumeTickets(1, async ({ tickets }) => {
            secondEntered = true;
            return tickets[0].finalized_ticket;
        }, { expectedAccountId: 'test-account' });
        // Attach the rejection handler before releasing the first redemption.
        const results = Promise.allSettled([first, second]);
        await Promise.resolve();
        assert.equal(secondEntered, false);
        finishRedemption.resolve();
        const [a, b] = await results;
        assert.equal(a.status, 'fulfilled');
        if (balance === 2) {
            assert.equal(b.status, 'fulfilled');
            assert.notEqual(a.value.result, b.value.result);
        } else {
            assert.equal(b.status, 'rejected');
            assert.equal(b.reason.code, 'NO_TICKETS');
            assert.equal(secondEntered, false);
        }
        assert.equal(stored.active.length, 0);
        assert.equal(stored.archived.length, balance);
        assert.equal(new Set(stored.archived.map(ticket => ticket.finalized_ticket)).size, balance);
        assert.ok(lockNames.includes('oa-inference-tickets'));
        assert.ok(lockNames.includes('oa-sync'));
    });
}
