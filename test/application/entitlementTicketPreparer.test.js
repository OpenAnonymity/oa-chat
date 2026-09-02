import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EntitlementTicketPreparer,
    normalizeClaimResponses
} from '../../chat/application/entitlementTicketPreparer.js';

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createLockManager() {
    const queues = new Map();
    const requests = [];
    const waiters = [];
    return {
        request(name, options, callback) {
            requests.push(name);
            waiters.splice(0).forEach(waiter => waiter());
            const previous = queues.get(name) || Promise.resolve();
            const current = previous.then(() => {
                if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                return callback();
            });
            queues.set(name, current.catch(() => {}));
            return current;
        },
        async waitForRequest(fragment, afterCount = 0) {
            while (requests.filter(name => name.includes(fragment)).length <= afterCount) {
                await new Promise(resolve => waiters.push(resolve));
            }
        }
    };
}

function createHarness() {
    const records = new Map();
    const tickets = [];
    const ticketWrites = [];
    const publications = [];
    const lockManager = createLockManager();
    let activeAccountId = '1234';
    let failImportedPut = false;
    let failDelete = false;
    let afterTicketWrite = null;
    let sequence = 0;
    const pendingStore = {
        async get(scope) { return clone(records.get(scope) || null); },
        async put(record) {
            if (failImportedPut && record.phase === 'imported') {
                const error = new Error('Injected imported checkpoint failure');
                error.code = 'INJECTED_IMPORTED_PUT_FAILURE';
                throw error;
            }
            records.set(record.accountScope, clone(record));
            return clone(record);
        },
        async delete(scope) {
            if (failDelete) {
                const error = new Error('Injected cleanup failure');
                error.code = 'INJECTED_CLEANUP_FAILURE';
                throw error;
            }
            records.delete(scope);
        }
    };
    const privacyPass = {
            async createSingleTokenRequest() {
                const index = sequence++;
                return { blindedRequest: `blind-${index}`, serializedState: `state-${index}` };
            },
            async finalizeToken(signed, state) { return `token:${signed}:${state}`; }
        };
    const ticketStore = {
            async init() {},
            getCount: () => tickets.length,
            getTickets: () => clone(tickets),
            getArchiveTickets: () => [],
            async assertAccountScope(expectedAccountId) {
                if ((expectedAccountId || null) !== (activeAccountId || null)) {
                    throw new Error('Prepared tickets belong to a different account scope');
                }
            },
            async addTickets(values, options) {
                if ((options.expectedAccountId || null) !== (activeAccountId || null)) {
                    throw new Error('Prepared tickets belong to a different account scope');
                }
                ticketWrites.push(clone(options));
                tickets.push(...clone(values));
                await afterTicketWrite?.();
            },
            publishUpdate(options = {}) {
                if ((options.expectedAccountId || null) !== (activeAccountId || null)) {
                    throw new Error('Prepared tickets belong to a different account scope');
                }
                publications.push(tickets.length);
            }
        };
    const makePreparer = () => new EntitlementTicketPreparer({
        pendingStore,
        privacyPass,
        ticketStore,
        lockManager
    });
    const preparer = makePreparer();
    return {
        preparer,
        records,
        tickets,
        ticketWrites,
        publications,
        lockManager,
        makePreparer,
        setActiveAccountId(value) { activeAccountId = value; },
        setFailImportedPut(value) { failImportedPut = value; },
        setFailDelete(value) { failDelete = value; },
        setAfterTicketWrite(callback) { afterTicketWrite = callback; }
    };
}

test('stages a backend-sized entitlement outside the live wallet until publication', async () => {
    const { preparer, records, tickets, ticketWrites, publications } = createHarness();
    const keyId = 'a'.repeat(64);
    const result = await preparer.prepare({
        scope: 'account:1234',
        ticketCount: 10,
        fetchIssuerPublicKey: async () => ({ publicKey: 'issuer-public-key', keyId }),
        claimBlindedRequests: async (requests, context) => {
            assert.equal(context.expectedKeyId, keyId);
            return {
                signed_responses: requests.map(([index]) => [index, `signed-${index}`]),
                tickets_issued: requests.length,
                replayed: false
            };
        }
    });

    assert.equal(result.ticketsAdded, 10);
    assert.equal(result.ticketUpdateDeferred, true);
    assert.equal(tickets.length, 0);
    assert.equal(records.size, 1);
    assert.equal(records.get('account:1234').phase, 'ready-to-publish');
    assert.equal(records.get('account:1234').finalizedTickets.length, 10);
    assert.deepEqual(ticketWrites, []);
    assert.deepEqual(publications, []);

    assert.equal(await preparer.publishPreparedTicketUpdate(result), true);
    assert.equal(tickets.length, 10);
    assert.equal(records.size, 0);
    assert.deepEqual(ticketWrites, [{
        requireDurable: true,
        emitUpdate: false,
        skipBroadcast: true,
        skipSync: true,
        expectedAccountId: '1234'
    }]);
    assert.deepEqual(publications, [10]);
    assert.equal(await preparer.publishPreparedTicketUpdate(result), false);
    tickets.forEach(ticket => assert.deepEqual(Object.keys(ticket).sort(), [
        'blinded_request', 'created_at', 'finalized_ticket', 'signed_response'
    ]));
});

test('a reload recovers staged tickets without adding them before publication', async () => {
    const { preparer, makePreparer, records, tickets, publications } = createHarness();
    const operations = {
        scope: 'account:1234',
        ticketCount: 2,
        fetchIssuerPublicKey: async () => ({ publicKey: 'issuer-public-key', keyId: 'a'.repeat(64) }),
        claimBlindedRequests: async requests => ({
            signed_responses: requests.map(([index]) => [index, `signed-${index}`]),
            tickets_issued: requests.length,
            replayed: false
        })
    };
    const interrupted = await preparer.prepare(operations);
    assert.equal(tickets.length, 0);
    assert.equal(records.get('account:1234').phase, 'ready-to-publish');
    assert.equal(preparer.releasePreparedTicketPublication(interrupted), true);

    const resumedPreparer = makePreparer();
    const recovered = await resumedPreparer.prepare({ ...operations, ticketCount: null });
    assert.equal(recovered.ticketsAdded, 2);
    assert.equal(tickets.length, 0);
    assert.equal(await resumedPreparer.publishPreparedTicketUpdate(recovered), true);
    assert.equal(tickets.length, 2);
    assert.deepEqual(publications, [2]);
});

test('one tab owns completion while another waits and observes its publication', async () => {
    const { preparer, makePreparer, tickets, publications, lockManager } = createHarness();
    const operations = {
        scope: 'account:1234',
        ticketCount: 2,
        fetchIssuerPublicKey: async () => ({ publicKey: 'issuer-public-key', keyId: 'a'.repeat(64) }),
        claimBlindedRequests: async requests => ({
            signed_responses: requests.map(([index]) => [index, `signed-${index}`]),
            tickets_issued: requests.length,
            replayed: false
        })
    };
    const ownerResult = await preparer.prepare(operations);
    const observer = makePreparer();
    let observerSettled = false;
    const observerWork = observer.prepare({ ...operations, ticketCount: null })
        .then(result => {
            observerSettled = true;
            return result;
        });

    await lockManager.waitForRequest('oa-entitlement-publication-v1:', 1);
    assert.equal(observerSettled, false);
    assert.equal(tickets.length, 0);

    assert.equal(await preparer.publishPreparedTicketUpdate(ownerResult), true);
    const observedResult = await observerWork;
    assert.equal(observedResult.publicationObserved, true);
    assert.equal(observedResult.ticketsAdded, 0);
    assert.equal(tickets.length, 2);
    assert.deepEqual(publications, [2]);
});

test('refuses to publish a staged entitlement after the active account changes', async () => {
    const { preparer, records, tickets, setActiveAccountId } = createHarness();
    const result = await preparer.prepare({
        scope: 'account:1234',
        ticketCount: 1,
        fetchIssuerPublicKey: async () => ({ publicKey: 'issuer-public-key', keyId: 'a'.repeat(64) }),
        claimBlindedRequests: async requests => ({
            signed_responses: requests.map(([index]) => [index, `signed-${index}`]),
            tickets_issued: requests.length,
            replayed: false
        })
    });

    setActiveAccountId('5678');
    await assert.rejects(
        () => preparer.publishPreparedTicketUpdate(result),
        /different account scope/
    );
    assert.equal(tickets.length, 0);
    assert.equal(records.get('account:1234').phase, 'ready-to-publish');
});

test('publishes once when the imported checkpoint fails after the durable wallet write', async () => {
    const {
        preparer,
        records,
        tickets,
        publications,
        setFailImportedPut
    } = createHarness();
    const operations = {
        scope: 'account:1234',
        ticketCount: 2,
        fetchIssuerPublicKey: async () => ({ publicKey: 'issuer-public-key', keyId: 'a'.repeat(64) }),
        claimBlindedRequests: async requests => ({
            signed_responses: requests.map(([index]) => [index, `signed-${index}`]),
            tickets_issued: requests.length,
            replayed: false
        })
    };
    const result = await preparer.prepare(operations);
    setFailImportedPut(true);
    assert.equal(await preparer.publishPreparedTicketUpdate(result), true);
    assert.equal(tickets.length, 2);
    assert.equal(records.size, 0);
    assert.deepEqual(publications, [2]);
    setFailImportedPut(false);
});

test('a cleanup failure after publication is successful and remains idempotent', async () => {
    const {
        preparer,
        makePreparer,
        records,
        tickets,
        publications,
        setFailDelete
    } = createHarness();
    const operations = {
        scope: 'account:1234',
        ticketCount: 1,
        fetchIssuerPublicKey: async () => ({ publicKey: 'issuer-public-key', keyId: 'a'.repeat(64) }),
        claimBlindedRequests: async requests => ({
            signed_responses: requests.map(([index]) => [index, `signed-${index}`]),
            tickets_issued: requests.length,
            replayed: false
        })
    };
    const result = await preparer.prepare(operations);
    setFailDelete(true);
    assert.equal(await preparer.publishPreparedTicketUpdate(result), true);
    assert.equal(tickets.length, 1);
    assert.equal(records.get('account:1234').phase, 'published');
    assert.deepEqual(publications, [1]);

    setFailDelete(false);
    const recovered = await makePreparer().prepare({ ...operations, ticketCount: null });
    assert.equal(recovered.publicationObserved, true);
    assert.equal(tickets.length, 1);
    assert.equal(records.size, 0);
    assert.deepEqual(publications, [1]);
});

test('account switching during the durable wallet write suppresses publication', async () => {
    const {
        preparer,
        makePreparer,
        records,
        tickets,
        publications,
        setActiveAccountId,
        setAfterTicketWrite
    } = createHarness();
    const operations = {
        scope: 'account:1234',
        ticketCount: 1,
        fetchIssuerPublicKey: async () => ({ publicKey: 'issuer-public-key', keyId: 'a'.repeat(64) }),
        claimBlindedRequests: async requests => ({
            signed_responses: requests.map(([index]) => [index, `signed-${index}`]),
            tickets_issued: requests.length,
            replayed: false
        })
    };
    const result = await preparer.prepare(operations);
    setAfterTicketWrite(() => setActiveAccountId('5678'));
    await assert.rejects(
        () => preparer.publishPreparedTicketUpdate(result),
        /different account scope/
    );
    assert.equal(tickets.length, 1);
    assert.equal(records.get('account:1234').phase, 'imported');
    assert.deepEqual(publications, []);

    setAfterTicketWrite(null);
    setActiveAccountId('1234');
    const recoveredPreparer = makePreparer();
    const recovered = await recoveredPreparer.prepare({ ...operations, ticketCount: null });
    assert.equal(recovered.ticketUpdateDeferred, true);
    assert.equal(recovered.publicationOnly, true);
    assert.deepEqual(publications, []);
    assert.equal(await recoveredPreparer.publishPreparedTicketUpdate(recovered), true);
    assert.equal(tickets.length, 1);
    assert.equal(records.size, 0);
    assert.deepEqual(publications, [1]);
});

test('aborting a staged owner releases the publication lock for recovery', async () => {
    const { preparer, makePreparer, tickets } = createHarness();
    const controller = new AbortController();
    const operations = {
        scope: 'account:1234',
        ticketCount: 1,
        signal: controller.signal,
        fetchIssuerPublicKey: async () => ({ publicKey: 'issuer-public-key', keyId: 'a'.repeat(64) }),
        claimBlindedRequests: async requests => ({
            signed_responses: requests.map(([index]) => [index, `signed-${index}`]),
            tickets_issued: requests.length,
            replayed: false
        })
    };
    await preparer.prepare(operations);
    controller.abort();

    const recoveredPreparer = makePreparer();
    const recovered = await recoveredPreparer.prepare({
        ...operations,
        signal: undefined,
        ticketCount: null
    });
    assert.equal(recovered.ticketUpdateDeferred, true);
    assert.equal(await recoveredPreparer.publishPreparedTicketUpdate(recovered), true);
    assert.equal(tickets.length, 1);
});

test('external release cannot unlock a publication commit in flight', async () => {
    const {
        preparer,
        makePreparer,
        tickets,
        publications,
        lockManager,
        setAfterTicketWrite
    } = createHarness();
    let continueWrite;
    const writeGate = new Promise(resolve => { continueWrite = resolve; });
    setAfterTicketWrite(() => writeGate);
    const operations = {
        scope: 'account:1234',
        ticketCount: 1,
        fetchIssuerPublicKey: async () => ({ publicKey: 'issuer-public-key', keyId: 'a'.repeat(64) }),
        claimBlindedRequests: async requests => ({
            signed_responses: requests.map(([index]) => [index, `signed-${index}`]),
            tickets_issued: requests.length,
            replayed: false
        })
    };
    const owner = await preparer.prepare(operations);
    const publishing = preparer.publishPreparedTicketUpdate(owner);
    await Promise.resolve();
    assert.equal(preparer.releasePreparedTicketPublication(owner), false);

    const observer = makePreparer();
    let observerSettled = false;
    const observing = observer.prepare({ ...operations, ticketCount: null }).then(value => {
        observerSettled = true;
        return value;
    });
    await lockManager.waitForRequest('oa-entitlement-publication-v1:', 1);
    assert.equal(observerSettled, false);

    continueWrite();
    assert.equal(await publishing, true);
    const observed = await observing;
    assert.equal(observed.publicationObserved, true);
    assert.equal(tickets.length, 1);
    assert.deepEqual(publications, [1]);
});

test('commercial recovery metadata never exposes staged ticket material', async () => {
    const { preparer, records } = createHarness();
    records.set('account:1234', {
        accountScope: 'account:1234',
        source: 'topup',
        claimRef: 'claim-safe',
        issuerFingerprint: 'a'.repeat(64),
        phase: 'ready-to-publish',
        requests: [{ serializedState: 'private' }],
        finalizedTickets: [{ finalized_ticket: 'private' }]
    });

    assert.deepEqual(await preparer.getPending('account:1234'), {
        source: 'topup',
        claimRef: 'claim-safe',
        issuerFingerprint: 'a'.repeat(64),
        phase: 'ready-to-publish'
    });
});

test('signed responses reject server-side finalization and entitlement metadata', () => {
    assert.throws(() => normalizeClaimResponses({ finalized_tickets: ['unsafe'] }, 1), /finalized ticket/);
    assert.throws(() => normalizeClaimResponses({
        signed_responses: [[0, 'signed']], stripe_customer_id: 'unsafe'
    }, 1), /unexpected response metadata/);
});

test('issuer rotation discards a stale saved blind batch before claiming', async () => {
    const { preparer, records } = createHarness();
    records.set('account:1234', {
        accountScope: 'account:1234',
        source: 'subscription',
        issuerFingerprint: 'b'.repeat(64),
        issuerFingerprintVersion: 2,
        targetCount: 1,
        generatedCount: 1,
        requests: [{ index: 0, blindedRequest: 'blind', serializedState: 'state' }],
        signedResponses: null,
        finalizedTickets: [],
        finalizedCount: 0
    });
    let claimed = false;
    await assert.rejects(() => preparer.prepare({
        scope: 'account:1234',
        ticketCount: 1,
        fetchIssuerPublicKey: async () => ({ publicKey: 'new-key', keyId: 'c'.repeat(64) }),
        claimBlindedRequests: async () => { claimed = true; return {}; }
    }), error => error.code === 'ENTITLEMENT_ISSUER_ROTATED');
    assert.equal(claimed, false);
    assert.equal(records.size, 0);
});
