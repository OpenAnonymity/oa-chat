import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EntitlementTicketPreparer,
    normalizeClaimResponses
} from '../../chat/application/entitlementTicketPreparer.js';

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createHarness() {
    const records = new Map();
    const tickets = [];
    let sequence = 0;
    const preparer = new EntitlementTicketPreparer({
        pendingStore: {
            async get(scope) { return clone(records.get(scope) || null); },
            async put(record) {
                records.set(record.accountScope, clone(record));
                return clone(record);
            },
            async delete(scope) { records.delete(scope); }
        },
        privacyPass: {
            async createSingleTokenRequest() {
                const index = sequence++;
                return { blindedRequest: `blind-${index}`, serializedState: `state-${index}` };
            },
            async finalizeToken(signed, state) { return `token:${signed}:${state}`; }
        },
        ticketStore: {
            async init() {},
            getCount: () => tickets.length,
            getTickets: () => clone(tickets),
            getArchiveTickets: () => [],
            async addTickets(values) { tickets.push(...clone(values)); }
        },
        lockManager: { request: (_name, _options, callback) => callback() }
    });
    return { preparer, records, tickets };
}

test('prepares a backend-sized entitlement without identity or billing metadata', async () => {
    const { preparer, records, tickets } = createHarness();
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
    assert.equal(tickets.length, 10);
    assert.equal(records.size, 0);
    tickets.forEach(ticket => assert.deepEqual(Object.keys(ticket).sort(), [
        'blinded_request', 'created_at', 'finalized_ticket', 'signed_response'
    ]));
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
