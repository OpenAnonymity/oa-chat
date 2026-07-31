import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildTicketIssuanceRequest,
    extractTicketKeyId,
    filterTicketsByInvalidatedKeyIds,
    getStructuredTicketError,
    getTicketKeyId,
    partitionTicketsByKeyId
} from '../../chat/domain/ticketKeys.js';

function tokenForKeyId(keyId, nonceByte = 1) {
    const bytes = new Uint8Array(2 + 32 + 32 + 32 + 256);
    bytes[0] = 0;
    bytes[1] = 2;
    bytes.fill(nonceByte, 2, 34);
    bytes.set(Buffer.from(keyId, 'hex'), 66);
    return Buffer.from(bytes)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

test('extractTicketKeyId reads the RFC 9578 token_key_id field', () => {
    const keyId = 'ab'.repeat(32);
    assert.equal(extractTicketKeyId(tokenForKeyId(keyId)), keyId);
});

test('partitionTicketsByKeyId removes every local ticket in one generation', () => {
    const oldKeyId = '11'.repeat(32);
    const currentKeyId = '22'.repeat(32);
    const tickets = [
        { finalized_ticket: tokenForKeyId(oldKeyId, 1) },
        { finalized_ticket: tokenForKeyId(currentKeyId, 2) },
        { finalized_ticket: tokenForKeyId(oldKeyId, 3), ticket_key_id: oldKeyId }
    ];

    const { matching, remaining } = partitionTicketsByKeyId(tickets, oldKeyId);

    assert.equal(matching.length, 2);
    assert.equal(remaining.length, 1);
    assert.equal(getTicketKeyId(remaining[0]), currentKeyId);
});

test('embedded token key ID overrides stale imported metadata', () => {
    const embeddedKeyId = '33'.repeat(32);
    const staleMetadataKeyId = '44'.repeat(32);
    const ticket = {
        finalized_ticket: tokenForKeyId(embeddedKeyId),
        ticket_key_id: staleMetadataKeyId
    };

    assert.equal(getTicketKeyId(ticket), embeddedKeyId);
    const { matching, remaining } = partitionTicketsByKeyId(
        [ticket],
        embeddedKeyId
    );
    assert.equal(matching.length, 1);
    assert.equal(remaining.length, 0);
});

test('invalidated key tombstones filter tickets by embedded generation', () => {
    const invalidatedKeyId = '55'.repeat(32);
    const currentKeyId = '66'.repeat(32);
    const remaining = filterTicketsByInvalidatedKeyIds([
        { finalized_ticket: tokenForKeyId(invalidatedKeyId, 1) },
        { finalized_ticket: tokenForKeyId(currentKeyId, 2) }
    ], [invalidatedKeyId, invalidatedKeyId.toUpperCase(), 'invalid']);

    assert.equal(remaining.length, 1);
    assert.equal(getTicketKeyId(remaining[0]), currentKeyId);
});

test('ticket issuance request binds blinded batch to the fetched key generation', () => {
    const keyId = '77'.repeat(32);
    const blindedRequests = [[0, 'blinded-request']];
    const request = buildTicketIssuanceRequest(
        'single-use-invite',
        blindedRequests,
        keyId.toUpperCase()
    );

    assert.deepEqual(request, {
        credential: 'single-use-invite',
        blinded_requests: blindedRequests,
        expected_key_id: keyId
    });
    assert.throws(
        () => buildTicketIssuanceRequest('invite', [], 'invalid'),
        /valid expected ticket key ID/
    );
});

test('getStructuredTicketError unwraps FastAPI invalidation details', () => {
    const keyId = 'cd'.repeat(32);
    const parsed = getStructuredTicketError({
        detail: {
            error_code: 'TICKET_KEY_INVALIDATED',
            message: 'Ticket signing key has already been invalidated',
            invalidated_key_id: keyId
        }
    }, 'fallback');

    assert.equal(parsed.code, 'TICKET_KEY_INVALIDATED');
    assert.equal(parsed.message, 'Ticket signing key has already been invalidated');
    assert.equal(parsed.invalidatedKeyId, keyId);
});
