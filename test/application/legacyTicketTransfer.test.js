import test from 'node:test';
import assert from 'node:assert/strict';
import { LegacyTicketTransfer } from '../../chat/application/legacyTicketTransfer.js';

const LEGACY_KEY = '61'.repeat(32);
const CURRENT_KEY = '22'.repeat(32);
const clone = value => structuredClone(value);

function tokenForKeyId(keyId, nonceByte) {
    const bytes = new Uint8Array(2 + 32 + 32 + 32 + 256);
    bytes[1] = 2;
    bytes.fill(nonceByte, 2, 34);
    bytes.set(Buffer.from(keyId, 'hex'), 66);
    return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const code = n => `legacycode${String(n).padStart(10, '0')}0005`;

function harness({ legacy = 3, current = 1, info = {} } = {}) {
    const h = {
        info: { enabled: true, key_id: LEGACY_KEY, until: 2_000_000_000, max_batch: 500, ...info },
        wallet: [
            ...Array.from({ length: legacy }, (_, i) => ({ finalized_ticket: tokenForKeyId(LEGACY_KEY, 10 + i) })),
            ...Array.from({ length: current }, (_, i) => ({ finalized_ticket: tokenForKeyId(CURRENT_KEY, 100 + i) }))
        ],
        held: null,
        pending: new Map(),
        submits: [],
        removed: [],
        redeemCalls: 0,
        accountId: 'account-a',
        codes: 0,
        events: [],
        started: []
    };
    let queue = Promise.resolve();
    h.respond = tickets => ({
        code: code(++h.codes),
        tickets: tickets.length,
        transferred: tickets.map((_, index) => index),
        already_transferred: [],
        invalid: [],
        recovered_codes: []
    });
    h.options = {
        lockManager: { request(name, fn) { h.lockName = name; const next = queue.then(fn); queue = next.catch(() => {}); return next; } },
        fetchInfo: async () => clone(h.info),
        submit: async tickets => {
            h.events.push('submit');
            h.submits.push([...tickets]);
            if (h.failSubmit) throw h.failSubmit;
            return h.respond(tickets);
        },
        listTickets: () => h.wallet.map(clone),
        removeTickets: async (tickets, options) => {
            h.events.push('remove');
            assert.equal(options.expectedAccountId, h.accountId);
            for (const ticket of tickets) {
                const key = `account:${h.accountId}`;
                assert.ok([...h.pending.values()].some(record => record.scope === key),
                    'a code must be durable before old tickets leave the wallet');
            }
            const values = new Set(tickets.map(ticket => ticket.finalized_ticket));
            h.removed.push(...values);
            h.wallet = h.wallet.filter(ticket => !values.has(ticket.finalized_ticket));
        },
        holdKeyIds: keyIds => { h.held = [...keyIds]; },
        pendingStore: {
            async list(scope) { return [...h.pending.values()].filter(record => record.scope === scope).map(clone); },
            async put(record) {
                h.events.push('save');
                if (h.failSave) throw new Error('Storage full');
                h.pending.set(`${record.scope}:${record.code}`, clone(record));
            }
        },
        getAccountScope: async () => h.accountId,
        onStart: ({ tickets }) => { h.started.push(tickets); },
        redeemPending: async () => {
            h.redeemCalls += 1;
            if (h.failRedeem) throw new Error('Relay unavailable');
            h.pending.clear();
            return { success: true };
        },
        now: () => '2026-10-02T00:00:00.000Z'
    };
    h.transfer = () => new LegacyTicketTransfer(h.options);
    return h;
}

test('old tickets become a saved code, leave the wallet, and the code is redeemed', async () => {
    const h = harness();
    const result = await h.transfer().run();
    assert.deepEqual(result, { status: 'moved', moved: 3, redeemed: true, redeemError: null });
    assert.deepEqual(h.started, [3]);
    assert.deepEqual(h.held, [LEGACY_KEY]);
    assert.equal(h.submits.length, 1);
    assert.equal(h.submits[0].length, 3, 'only previous-org tickets are sent');
    assert.deepEqual(h.events, ['submit', 'save', 'remove']);
    assert.equal(h.wallet.length, 1);
    assert.equal(h.redeemCalls, 1);
    assert.equal(h.lockName, 'oa-legacy-ticket-transfer-v1');
});

test('saved code record is a plain pending redemption for the signed-in wallet', async () => {
    const h = harness();
    h.options.redeemPending = async () => { h.redeemCalls += 1; };
    await h.transfer().run();
    assert.deepEqual([...h.pending.values()], [{
        scope: 'account:account-a',
        code: code(1),
        needsNewIssuer: true,
        createdAt: '2026-10-02T00:00:00.000Z'
    }]);
});

test('a lost reply keeps every old ticket and saves nothing; the retry is the identical request', async () => {
    const h = harness();
    h.failSubmit = new Error('Network lost');
    await assert.rejects(h.transfer().run(), /Network lost/);
    assert.equal(h.wallet.length, 4);
    assert.equal(h.pending.size, 0);
    h.failSubmit = null;
    await h.transfer().run();
    assert.deepEqual(h.submits[1], h.submits[0], 'stable order makes the retry the identical request');
    assert.equal(h.wallet.length, 1);
});

test('a failed code save keeps the old tickets in the wallet', async () => {
    const h = harness();
    h.failSave = true;
    await assert.rejects(h.transfer().run(), /Storage full/);
    assert.equal(h.wallet.length, 4);
    assert.deepEqual(h.removed, []);
});

test('tickets another device already moved leave, and codes this account already got are saved too', async () => {
    const h = harness({ legacy: 3 });
    h.respond = () => ({
        code: code(9),
        tickets: 1,
        transferred: [2],
        already_transferred: [0, 1],
        invalid: [],
        recovered_codes: [code(7)]
    });
    h.options.redeemPending = async () => { h.redeemCalls += 1; };
    const result = await h.transfer().run();
    assert.equal(result.moved, 1);
    assert.equal(h.wallet.length, 1);
    assert.deepEqual([...h.pending.values()].map(record => record.code).sort(), [code(7), code(9)]);
});

test('invalid tickets are reported, not removed', async () => {
    const h = harness({ legacy: 2 });
    h.respond = () => ({ code: code(1), tickets: 1, transferred: [0], already_transferred: [], invalid: [1], recovered_codes: [] });
    await h.transfer().run();
    assert.equal(h.wallet.length, 2, 'the invalid old ticket stays (held) and the current one stays');
});

test('large wallets go in batches in a stable order', async () => {
    const h = harness({ legacy: 5, info: { max_batch: 2 } });
    await h.transfer().run();
    assert.deepEqual(h.submits.map(batch => batch.length), [2, 2, 1]);
    const sent = h.submits.flat();
    assert.deepEqual(sent, [...sent].sort());
    assert.equal(h.wallet.length, 1);
    assert.equal(h.pending.size, 0);
    assert.equal(h.redeemCalls, 1);
});

test('closed or unconfigured transfer holds nothing back and sends nothing', async () => {
    for (const info of [{ enabled: false }, { key_id: null }, { key_id: 'not-hex' }]) {
        const h = harness({ info });
        h.held = ['stale'];
        const result = await h.transfer().run();
        assert.equal(result.status, 'closed');
        assert.deepEqual(h.held, []);
        assert.equal(h.submits.length, 0);
    }
});

test('the org closing mid-run releases the hold; a limit keeps the tickets held', async () => {
    const closed = harness();
    closed.failSubmit = Object.assign(new Error('closed'), { code: 'LEGACY_TRANSFER_CLOSED' });
    assert.equal((await closed.transfer().run()).status, 'closed');
    assert.deepEqual(closed.held, []);
    assert.equal(closed.wallet.length, 4);

    const limited = harness();
    limited.failSubmit = Object.assign(new Error('limit'), { code: 'LEGACY_TRANSFER_LIMIT' });
    assert.equal((await limited.transfer().run()).status, 'limit');
    assert.deepEqual(limited.held, [LEGACY_KEY]);
    assert.equal(limited.wallet.length, 4);
});

test('a code saved by an interrupted run is redeemed even with no old tickets left', async () => {
    const h = harness({ legacy: 0 });
    h.pending.set('account:account-a:x', { scope: 'account:account-a', code: code(3), needsNewIssuer: true });
    const result = await h.transfer().run();
    assert.equal(result.status, 'none');
    assert.equal(h.redeemCalls, 1);
    assert.equal(h.submits.length, 0);
});

test('a redeem failure is reported, and the saved code stays for the next run', async () => {
    const h = harness();
    h.failRedeem = true;
    const result = await h.transfer().run();
    assert.equal(result.moved, 3);
    assert.match(result.redeemError.message, /Relay unavailable/);
    assert.equal(h.pending.size, 1);
});

test('a signed-out wallet sends nothing', async () => {
    const h = harness();
    h.accountId = null;
    assert.equal((await h.transfer().run()).status, 'signed-out');
    assert.equal(h.submits.length, 0);
});

test('the host hears that a move started, with the count, before anything is sent', async () => {
    const h = harness({ legacy: 4 });
    h.options.onStart = ({ tickets }) => { h.events.push(`start:${tickets}`); };
    await h.transfer().run();
    assert.deepEqual(h.events.slice(0, 2), ['start:4', 'submit']);
});

test('nothing to move means no start signal', async () => {
    const h = harness({ legacy: 0 });
    await h.transfer().run();
    assert.deepEqual(h.started, []);
});

test('a failed redeem reports redeemed: false; the next run reports redeemed: true', async () => {
    const h = harness();
    h.failRedeem = true;
    const first = await h.transfer().run();
    assert.equal(first.redeemed, false);
    h.failRedeem = false;
    const second = await h.transfer().run();
    assert.equal(second.moved, 0);
    assert.equal(second.redeemed, true);
});
