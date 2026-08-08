import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EntitlementTicketPreparer,
    normalizeClaimResponses
} from '../../chat/application/entitlementTicketPreparer.js';

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

async function sha256Hex(value) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function createHarness(options = {}) {
    const records = new Map();
    const active = [];
    let sequence = 0;
    const pendingStore = {
        async get(scope) {
            return clone(records.get(scope) || null);
        },
        async put(record) {
            const saved = clone(record);
            records.set(record.accountScope, saved);
            return clone(saved);
        },
        async delete(scope) {
            records.delete(scope);
        }
    };
    const privacyPass = {
        async createSingleTokenRequest() {
            const index = sequence++;
            return {
                blindedRequest: `blinded-${index}`,
                serializedState: `state-${index}`
            };
        },
        async finalizeToken(signedResponse, state) {
            return `finalized:${signedResponse}:${state}`;
        }
    };
    const ticketStore = {
        async init() {},
        getCount: () => active.length,
        getTickets: () => clone(active),
        getArchiveTickets: () => [],
        async addTickets(tickets) {
            active.push(...clone(tickets));
        }
    };
    const locks = [];
    const lockManager = {
        async request(name, lockOptions, callback) {
            locks.push({ name, lockOptions });
            return callback();
        }
    };
    const preparer = new EntitlementTicketPreparer({
        pendingStore,
        privacyPass,
        ticketStore,
        lockManager,
        ...options
    });
    return { preparer, records, active, locks };
}

test('prepares the backend-provided 300-ticket entitlement without identity metadata', async () => {
    const { preparer, records, active, locks } = createHarness();
    const progress = [];
    let claimed = null;

    const result = await preparer.prepare({
        scope: 'account:1234',
        ticketCount: 300,
        fetchIssuerPublicKey: async () => 'public-key',
        claimBlindedRequests: async (requests) => {
            claimed = requests;
            return {
                signed_responses: requests.map(([index]) => [index, `signed-${index}`]),
                tickets_issued: requests.length,
                replayed: false
            };
        },
        onProgress: (snapshot) => progress.push(snapshot)
    });

    assert.equal(claimed.length, 300);
    assert.equal(active.length, 300);
    assert.equal(result.ticketsAdded, 300);
    assert.equal(records.size, 0);
    assert.equal(locks.length, 1);
    assert.match(locks[0].name, /^oa-entitlement-claim-v1:[0-9a-f]{64}$/);
    assert.equal(progress.at(-1).completed, 300);
    active.forEach(ticket => {
        assert.deepEqual(Object.keys(ticket).sort(), [
            'blinded_request',
            'created_at',
            'finalized_ticket',
            'signed_response'
        ]);
    });
});

test('rejects finalized tickets and unexpected metadata from a claim response', () => {
    assert.throws(
        () => normalizeClaimResponses({ finalized_tickets: ['unsafe'] }, 1),
        /finalized ticket material/
    );
    assert.throws(
        () => normalizeClaimResponses({ signed_responses: [[0, 'signed']], account_id: 'unsafe' }, 1),
        /unexpected response metadata/
    );
    assert.throws(
        () => normalizeClaimResponses({ signed_responses: [[0, 'signed']], tickets_issued: 2 }, 1),
        /wrong issued ticket count/
    );
    assert.throws(
        () => normalizeClaimResponses({ signed_responses: [[0, 'signed']], replayed: 'yes' }, 1),
        /invalid replay marker/
    );
});

test('keeps mismatched recovery state instead of silently replacing it', async () => {
    const { preparer, records } = createHarness();
    records.set('account:1234', {
        accountScope: 'account:1234',
        issuerFingerprint: 'old',
        targetCount: 500,
        generatedCount: 0,
        requests: [],
        signedResponses: null,
        finalizedTickets: [],
        finalizedCount: 0
    });

    await assert.rejects(() => preparer.prepare({
        scope: 'account:1234',
        ticketCount: 300,
        fetchIssuerPublicKey: async () => 'public-key',
        claimBlindedRequests: async () => ({ signed_responses: [] })
    }), /does not match this account or allowance/);

    assert.equal(records.get('account:1234').targetCount, 500);
});

test('aborted preparation leaves recovery state intact', async () => {
    const { preparer, records } = createHarness();
    const controller = new AbortController();

    await assert.rejects(() => preparer.prepare({
        scope: 'account:1234',
        ticketCount: 20,
        signal: controller.signal,
        fetchIssuerPublicKey: async () => 'public-key',
        claimBlindedRequests: async () => {
            controller.abort();
            return {
                signed_responses: Array.from({ length: 20 }, (_, index) => [index, `signed-${index}`])
            };
        }
    }), error => error?.name === 'AbortError');

    assert.equal(records.get('account:1234').targetCount, 20);
});

test('reload resumes the saved finalization phase without regenerating or reclaiming', async () => {
    let generated = 0;
    let claimed = 0;
    let finalized = 0;
    const { preparer, records, active } = createHarness({
        privacyPass: {
            async createSingleTokenRequest() { generated += 1; throw new Error('must not regenerate'); },
            async finalizeToken(signed, state) { finalized += 1; return `final:${signed}:${state}`; }
        }
    });
    const requests = Array.from({ length: 20 }, (_, index) => ({
        index,
        blindedRequest: `blinded-${index}`,
        serializedState: `state-${index}`
    }));
    const finalizedTickets = Array.from({ length: 10 }, (_, index) => ({
        blinded_request: `blinded-${index}`,
        signed_response: `signed-${index}`,
        finalized_ticket: `final-${index}`,
        created_at: '2026-01-01T00:00:00.000Z'
    }));
    records.set('account:1234', {
        accountScope: 'account:1234',
        issuerFingerprint: await sha256Hex('public-key'),
        targetCount: 20,
        generatedCount: 20,
        requests,
        signedResponses: Array.from({ length: 20 }, (_, index) => [index, `signed-${index}`]),
        finalizedTickets,
        finalizedCount: 10,
        phase: 'finalizing'
    });

    const result = await preparer.prepare({
        scope: 'account:1234',
        ticketCount: 20,
        fetchIssuerPublicKey: async () => 'public-key',
        claimBlindedRequests: async () => { claimed += 1; throw new Error('must not reclaim'); }
    });

    assert.equal(generated, 0);
    assert.equal(claimed, 0);
    assert.equal(finalized, 10);
    assert.equal(result.ticketsAdded, 20);
    assert.equal(active.length, 20);
    assert.equal(records.size, 0);
});

test('recovery can use its saved count when the server no longer advertises a new batch', async () => {
    const { preparer, records, active } = createHarness();
    records.set('account:legacy', {
        accountScope: 'account:legacy',
        issuerFingerprint: await sha256Hex('public-key'),
        targetCount: 3,
        generatedCount: 3,
        requests: Array.from({ length: 3 }, (_, index) => ({
            index, blindedRequest: `blinded-${index}`, serializedState: `state-${index}`
        })),
        signedResponses: Array.from({ length: 3 }, (_, index) => [index, `signed-${index}`]),
        finalizedTickets: [],
        finalizedCount: 0,
        phase: 'signed'
    });

    const result = await preparer.prepare({
        scope: 'account:legacy',
        ticketCount: null,
        fetchIssuerPublicKey: async () => 'public-key',
        claimBlindedRequests: async () => { throw new Error('must not reclaim'); }
    });

    assert.equal(result.ticketsAdded, 3);
    assert.equal(active.length, 3);
    assert.equal(records.size, 0);
});

test('signed legacy 500-ticket recovery takes precedence over a newly advertised 300-ticket batch', async () => {
    const { preparer, records, active } = createHarness();
    const targetCount = 500;
    const finalizedCount = 490;
    records.set('account:legacy-500', {
        accountScope: 'account:legacy-500',
        issuerFingerprint: await sha256Hex('public-key'),
        targetCount,
        generatedCount: targetCount,
        requests: Array.from({ length: targetCount }, (_, index) => ({
            index, blindedRequest: `blinded-${index}`, serializedState: `state-${index}`
        })),
        signedResponses: Array.from({ length: targetCount }, (_, index) => [index, `signed-${index}`]),
        finalizedTickets: Array.from({ length: finalizedCount }, (_, index) => ({
            blinded_request: `blinded-${index}`,
            signed_response: `signed-${index}`,
            finalized_ticket: `final-${index}`,
            created_at: '2026-01-01T00:00:00.000Z'
        })),
        finalizedCount,
        phase: 'finalizing'
    });

    const result = await preparer.prepare({
        scope: 'account:legacy-500',
        ticketCount: 300,
        fetchIssuerPublicKey: async () => { throw new Error('must not refetch after signing'); },
        claimBlindedRequests: async () => { throw new Error('must not reclaim'); }
    });

    assert.equal(result.ticketsAdded, 500);
    assert.equal(active.length, 500);
    assert.equal(records.size, 0);
});

test('recovery without a saved record fails before issuer or claim requests', async () => {
    const { preparer } = createHarness();
    let networkCalls = 0;

    await assert.rejects(() => preparer.prepare({
        scope: 'account:missing',
        ticketCount: null,
        fetchIssuerPublicKey: async () => { networkCalls += 1; return 'public-key'; },
        claimBlindedRequests: async () => { networkCalls += 1; return {}; }
    }), error => error.code === 'ENTITLEMENT_RECOVERY_NOT_FOUND');

    assert.equal(networkCalls, 0);
});

test('wallet write failure preserves a fully prepared recovery record', async () => {
    const finalizedTickets = Array.from({ length: 3 }, (_, index) => ({
        blinded_request: `blinded-${index}`,
        signed_response: `signed-${index}`,
        finalized_ticket: `final-${index}`,
        created_at: '2026-01-01T00:00:00.000Z'
    }));
    const { preparer, records } = createHarness({
        ticketStore: {
            async init() {},
            getCount: () => 0,
            getTickets: () => [],
            getArchiveTickets: () => [],
            async addTickets(_tickets, options) {
                assert.equal(options.requireDurable, true);
                throw new Error('IndexedDB write failed');
            }
        }
    });
    records.set('account:1234', {
        accountScope: 'account:1234',
        issuerFingerprint: await sha256Hex('public-key'),
        targetCount: 3,
        generatedCount: 3,
        requests: Array.from({ length: 3 }, (_, index) => ({
            index, blindedRequest: `blinded-${index}`, serializedState: `state-${index}`
        })),
        signedResponses: Array.from({ length: 3 }, (_, index) => [index, `signed-${index}`]),
        finalizedTickets,
        finalizedCount: 3,
        phase: 'finalizing'
    });

    await assert.rejects(() => preparer.prepare({
        scope: 'account:1234',
        ticketCount: 3,
        fetchIssuerPublicKey: async () => 'public-key',
        claimBlindedRequests: async () => ({ signed_responses: [] })
    }), /IndexedDB write failed/);

    assert.equal(records.get('account:1234').finalizedTickets.length, 3);
    assert.equal(records.get('account:1234').phase, 'finalizing');
});

test('recovery accepts an already spent archived ticket without resurrecting it', async () => {
    const finalizedTickets = Array.from({ length: 3 }, (_, index) => ({
        blinded_request: `blinded-${index}`,
        signed_response: `signed-${index}`,
        finalized_ticket: `final-${index}`,
        created_at: '2026-01-01T00:00:00.000Z'
    }));
    const active = finalizedTickets.slice(1);
    const archive = [{ ...finalizedTickets[0], consumed_at: '2026-01-01T00:01:00.000Z' }];
    const { preparer, records } = createHarness({
        ticketStore: {
            async init() {},
            getCount: () => active.length,
            getTickets: () => clone(active),
            getArchiveTickets: () => clone(archive),
            async addTickets() {
                // The ticket store preserves archive precedence and adds nothing.
            }
        }
    });
    records.set('account:1234', {
        accountScope: 'account:1234',
        issuerFingerprint: await sha256Hex('public-key'),
        targetCount: 3,
        generatedCount: 3,
        requests: Array.from({ length: 3 }, (_, index) => ({
            index, blindedRequest: `blinded-${index}`, serializedState: `state-${index}`
        })),
        signedResponses: Array.from({ length: 3 }, (_, index) => [index, `signed-${index}`]),
        finalizedTickets,
        finalizedCount: 3,
        phase: 'imported'
    });

    const result = await preparer.prepare({
        scope: 'account:1234',
        ticketCount: 3,
        fetchIssuerPublicKey: async () => 'public-key',
        claimBlindedRequests: async () => ({ signed_responses: [] })
    });

    assert.equal(result.totalActive, 2);
    assert.equal(archive.length, 1);
    assert.equal(active.some(ticket => ticket.finalized_ticket === 'final-0'), false);
    assert.equal(records.size, 0);
});
