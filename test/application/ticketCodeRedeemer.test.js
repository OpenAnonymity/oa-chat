import test from 'node:test';
import assert from 'node:assert/strict';
import { TicketCodeRedeemer } from '../../chat/application/ticketCodeRedeemer.js';

const CODE = 'abcdefghijklmnopqrst0002';
const KEY = 'a'.repeat(64);
const clone = value => structuredClone(value);

function harness() {
    const h = { records: new Map(), wallet: new Map(), requests: [], sequence: 0, scope: 'alice', issuerCalls: 0 };
    let queue = Promise.resolve();
    h.options = {
        lockManager: { request(name, fn) { const next = queue.then(fn); queue = next.catch(() => {}); return next; } },
        getAccountScope: async () => h.scope,
        pendingStore: {
            async list(scope) { return [...h.records.values()].filter(record => record.scope === scope).map(clone); },
            async put(record) {
                if (h.failSave) throw new Error('Storage full');
                h.records.set(`${record.scope}:${record.code}`, clone(record));
            },
            async delete(record) {
                if (h.failDelete) throw new Error('Cleanup interrupted');
                h.records.delete(`${record.scope}:${record.code}`);
            }
        },
        privacyPass: {
            async checkAvailability() { return true; },
            async getPublicKeyId() { return KEY; },
            async createChallenge() { return 'challenge'; },
            async createSingleTokenRequest() {
                const id = h.sequence++;
                return { blindedRequest: `blind-${id}`, serializedState: { id } };
            },
            async finalizeToken(signature, state) {
                if (h.failFinalize) throw new Error('Page interrupted while unblinding');
                return `ticket-${state.id}-${signature}`;
            }
        },
        ticketStore: {
            async addTickets(tickets, options) {
                assert.equal(options.requireDurable, true);
                assert.equal(options.expectedAccountId, h.scope);
                if (h.failWallet) throw new Error('Wallet storage unavailable');
                tickets.forEach(ticket => h.wallet.set(ticket.finalized_ticket, ticket));
            }
        },
        async fetchIssuer() { h.issuerCalls++; return { public_key: 'public', key_id: KEY }; },
        async submit(body) {
            assert.equal(h.records.size > 0, true, 'secrets must be committed before consumption');
            assert.deepEqual(Object.keys(body).sort(), ['blinded_requests', 'credential', 'expected_key_id']);
            h.requests.push(clone(body));
            if (h.changeScope) h.scope = 'bob';
            if (h.failRequest) throw new Error('Lost response after server commit');
            return h.response || { key_id: KEY, signed_responses: body.blinded_requests.map(([index]) => [index, `sig-${index}`]) };
        }
    };
    h.client = () => new TicketCodeRedeemer(h.options);
    return h;
}

test('reload after a lost response replays the exact blinded batch and original unblinding state', async () => {
    const h = harness();
    h.failRequest = true;
    await assert.rejects(h.client().run(CODE), /Lost response/);
    assert.equal(h.records.size, 1);
    h.failRequest = false;
    const result = await h.client().run(null);
    assert.equal(result.tickets_issued, 2);
    assert.deepEqual(h.requests[1], h.requests[0]);
    assert.equal(h.sequence, 2);
    assert.equal(h.issuerCalls, 1, 'recovery retains the original issuer even if discovery changes');
    assert.equal(h.wallet.size, 2);
    assert.equal(h.records.size, 0);
});

test('reload during unblinding uses saved signatures without resubmitting the code', async () => {
    const h = harness();
    h.failFinalize = true;
    await assert.rejects(h.client().run(CODE), /unblinding/);
    h.failFinalize = false;
    await h.client().run(null);
    assert.equal(h.requests.length, 1);
    assert.equal(h.wallet.size, 2);
});

test('recovery storage failure prevents consuming the code', async () => {
    const h = harness();
    h.failSave = true;
    await assert.rejects(h.client().run(CODE), /Storage full/);
    assert.equal(h.requests.length, 0);
});

test('failed durable wallet commit retains recovery across client recreation', async () => {
    const h = harness();
    h.failWallet = true;
    await assert.rejects(h.client().run(CODE), /Wallet storage/);
    assert.equal(h.records.size, 1);
    h.failWallet = false;
    await h.client().run(null);
    assert.equal(h.wallet.size, 2);
    assert.equal(h.requests.length, 1);
});

test('a crash after wallet commit reimports identical tokens instead of issuing new ones', async () => {
    const h = harness();
    h.failDelete = true;
    await assert.rejects(h.client().run(CODE), /Cleanup/);
    assert.equal(h.wallet.size, 2);
    h.failDelete = false;
    await h.client().run(null);
    assert.equal(h.wallet.size, 2);
    assert.equal(h.requests.length, 1);
});

test('an account change during submission retains recovery for its original wallet', async () => {
    const h = harness();
    h.changeScope = true;
    await assert.rejects(h.client().run(CODE), /wallet changed/);
    assert.equal(h.wallet.size, 0);
    assert.deepEqual(await h.client().getPending(), { count: 0 });
    assert.equal(await h.client().run(null), null);
    h.scope = 'alice';
    h.changeScope = false;
    await h.client().run(null);
    assert.equal(h.wallet.size, 2);
});

test('two recovering tabs serialize so only one imports and clears the pending redemption', async () => {
    const h = harness();
    h.failRequest = true;
    await assert.rejects(h.client().run(CODE));
    h.failRequest = false;
    const results = await Promise.all([h.client().run(null), h.client().run(null)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(h.requests.length, 2);
    assert.equal(h.wallet.size, 2);
});

test('malformed signature batches cannot partially publish a wallet', async () => {
    const h = harness();
    h.response = { signed_responses: [[0, 'one'], [0, 'duplicate']] };
    await assert.rejects(h.client().run(CODE), /invalid ticket signature batch/);
    assert.equal(h.wallet.size, 0);
    assert.equal(h.records.size, 1);
});

test('anonymous recovery is isolated from account recovery and never puts code metadata in tickets', async () => {
    const h = harness();
    h.scope = null;
    h.failRequest = true;
    await assert.rejects(h.client().run(CODE));
    h.scope = 'alice';
    assert.equal(await h.client().run(null), null);
    h.scope = null;
    h.failRequest = false;
    await h.client().run(null);
    for (const ticket of h.wallet.values()) {
        assert.deepEqual(Object.keys(ticket).sort(), ['blinded_request', 'created_at', 'finalized_ticket', 'signed_response', 'ticket_key_id']);
        assert.equal(JSON.stringify(ticket).includes(CODE), false);
    }
});

test('missing cross-tab coordination fails before submitting a code', async () => {
    const h = harness();
    h.options.lockManager = null;
    await assert.rejects(h.client().run(CODE), /coordinate/);
    assert.equal(h.requests.length, 0);
});

test('one terminal invalid code cannot block recovery of another saved code', async () => {
    const h = harness();
    const other = 'zyxwvutsrqponmlkjihg0002';
    h.failRequest = true;
    await assert.rejects(h.client().run(CODE));
    await assert.rejects(h.client().run(other));
    h.failRequest = false;
    const submit = h.options.submit;
    h.options.submit = async body => {
        if (body.credential === CODE) throw Object.assign(new Error('Invalid code: Code not found or expired'), { status: 400 });
        return submit(body);
    };
    await h.client().run(null);
    assert.equal(h.wallet.size, 2);
    assert.equal(h.records.size, 0);
});

test('one transient failure retains its batch while other saved codes recover', async () => {
    const h = harness();
    h.failRequest = true;
    await assert.rejects(h.client().run(CODE));
    await assert.rejects(h.client().run('zyxwvutsrqponmlkjihg0002'));
    h.failRequest = false;
    const submit = h.options.submit;
    h.options.submit = async body => {
        if (body.credential === CODE) throw new Error('Temporary network failure');
        return submit(body);
    };
    const result = await h.client().run(null);
    assert.equal(h.wallet.size, 2);
    assert.equal(result.pendingCount, 1);
    assert.equal(h.records.size, 1);
});

test('key rotation retains the code across reload and interruption during replacement blinding', async () => {
    const h = harness();
    const submit = h.options.submit;
    h.options.submit = async () => { throw Object.assign(new Error('Signing key changed; invite not consumed'), { code: 'TICKET_KEY_CHANGED' }); };
    await assert.rejects(h.client().run(CODE), /Signing key changed/);
    const saved = [...h.records.values()][0];
    assert.equal(saved.code, CODE);
    assert.equal(saved.needsNewIssuer, true);
    const create = h.options.privacyPass.createSingleTokenRequest;
    h.options.privacyPass.createSingleTokenRequest = async () => { throw new Error('Reload while replacing batch'); };
    await assert.rejects(h.client().run(null), /Reload/);
    assert.equal([...h.records.values()][0].code, CODE);
    h.options.privacyPass.createSingleTokenRequest = create;
    h.options.submit = submit;
    await h.client().run(null);
    assert.equal(h.wallet.size, 2);
    assert.equal(h.records.size, 0);
});
