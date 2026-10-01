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
        info: { enabled: true, account_binding: true, key_id: LEGACY_KEY, until: 2_000_000_000, max_batch: 500, ...info },
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
        attemptStore: {
            get: async () => h.attempt && clone(h.attempt),
            put: async value => { h.attempt = clone(value); },
            clear: async () => { h.attempt = null; }
        },
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
    assert.deepEqual(result, { status: 'moved', moved: 3, redeemed: true, redeemError: null, stranded: [] });
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
        source: 'legacy-transfer', needsNewIssuer: true,
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

// An org that takes at most `cap` more tickets for this account.
function capped(h, cap) {
    let left = cap;
    h.options.submit = async tickets => {
        h.submits.push([...tickets]);
        if (tickets.length > left) {
            throw Object.assign(new Error('limit'), { code: 'LEGACY_TRANSFER_LIMIT', remaining: left });
        }
        left -= tickets.length;
        return h.respond(tickets);
    };
}

test('over the allowance, the part that fits moves and the rest is reported stranded', async () => {
    const h = harness({ legacy: 5, current: 1, info: { max_batch: 4 } });
    capped(h, 3);
    const result = await h.transfer().run();
    assert.equal(result.status, 'limit');
    assert.equal(result.moved, 3);
    assert.deepEqual(h.submits.map(batch => batch.length), [4, 3, 2], 'the refused batch is resent with what fits');
    assert.equal(result.stranded.length, 2);
    assert.equal(h.wallet.length, 3, 'two stranded old tickets and the current one stay');
    assert.deepEqual(new Set(result.stranded), new Set(h.wallet.slice(0, 2).map(ticket => ticket.finalized_ticket)));
    assert.equal(h.redeemCalls, 1, 'what moved is still redeemed');
    assert.deepEqual(h.held, [LEGACY_KEY]);
});

test('an allowance already used up strands everything, and moves nothing', async () => {
    const h = harness({ legacy: 3 });
    capped(h, 0);
    const result = await h.transfer().run();
    assert.equal(result.status, 'limit');
    assert.equal(result.moved, 0);
    assert.equal(result.stranded.length, 3);
    assert.equal(h.submits.length, 1);
    assert.equal(h.pending.size, 0);
});

test('invalid tickets are reported stranded so they stop counting as moving', async () => {
    const h = harness({ legacy: 2 });
    h.respond = () => ({ code: code(1), tickets: 1, transferred: [0], already_transferred: [], invalid: [1], recovered_codes: [] });
    const result = await h.transfer().run();
    assert.deepEqual(result.stranded, [h.submits[0][1]]);
    assert.equal(result.status, 'moved');
});

function parkedHarness({ live = 0, parked = 3, current = 0 } = {}) {
    const h = harness({ legacy: live, current });
    h.parked = Array.from({ length: parked }, (_, i) => ({ finalized_ticket: tokenForKeyId(LEGACY_KEY, 50 + i) }));
    h.parked.push({ finalized_ticket: tokenForKeyId(CURRENT_KEY, 150) });
    h.options.listParkedTickets = async () => h.parked.map(clone);
    h.options.removeParkedTickets = async tickets => {
        h.events.push('remove-parked');
        assert.ok(h.pending.size > 0, 'a code must be durable before parked tickets are dropped');
        const values = new Set(tickets.map(ticket => ticket.finalized_ticket));
        h.parked = h.parked.filter(ticket => !values.has(ticket.finalized_ticket));
    };
    return h;
}

test('old tickets a login set aside move to the account that logged in', async () => {
    const h = parkedHarness({ live: 0, parked: 3 });
    const result = await h.transfer().run();
    assert.equal(result.status, 'moved');
    assert.equal(result.moved, 3);
    assert.deepEqual(h.started, [3]);
    assert.deepEqual(h.events, ['submit', 'save', 'remove-parked']);
    assert.deepEqual(h.parked.map(ticket => ticket.finalized_ticket), [tokenForKeyId(CURRENT_KEY, 150)],
        'only the old tickets leave the set-aside wallet');
    assert.equal(h.redeemCalls, 1);
});

test('live and set-aside old tickets both move, live first, and a ticket in both is sent once', async () => {
    const h = parkedHarness({ live: 2, parked: 2 });
    h.parked.push(clone(h.wallet[0]));
    const result = await h.transfer().run();
    assert.equal(result.moved, 4);
    assert.deepEqual(h.started, [4]);
    assert.equal(h.submits.length, 2);
    assert.equal(new Set(h.submits.flat()).size, 4);
    assert.equal(h.wallet.length, 0);
});

test('an unreadable set-aside wallet stops the move and is retried intact', async () => {
    const h = parkedHarness({ live: 2, parked: 2 });
    const read = h.options.listParkedTickets;
    h.options.listParkedTickets = async () => { throw new Error('IndexedDB read failed'); };
    await assert.rejects(h.transfer().run(), /IndexedDB read failed/);
    assert.equal(h.submits.length, 0);
    assert.equal(h.redeemCalls, 0);
    h.options.listParkedTickets = read;
    assert.equal((await h.transfer().run()).moved, 4);
});

test('the allowance running out on live tickets strands the set-aside ones too', async () => {
    const h = parkedHarness({ live: 2, parked: 2 });
    capped(h, 1);
    const result = await h.transfer().run();
    assert.equal(result.moved, 1);
    assert.equal(result.stranded.length, 3);
    assert.equal(h.parked.length, 3, 'set-aside old tickets stay where they are');
});

test('a code already saved is not saved again (its redemption progress stays)', async () => {
    const h = harness({ legacy: 2 });
    h.pending.set('account:account-a:first', { scope: 'account:account-a', source: 'legacy-transfer', code: code(1), source: 'legacy-transfer', needsNewIssuer: true, progress: 'signed' });
    h.options.redeemPending = async () => { h.redeemCalls += 1; };
    await h.transfer().run();
    assert.deepEqual(h.pending.get('account:account-a:first').progress, 'signed');
    assert.equal(h.events.filter(event => event === 'save').length, 0);
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
    h.pending.set('account:account-a:x', { scope: 'account:account-a', source: 'legacy-transfer', code: code(3), needsNewIssuer: true });
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

for (const stage of ['parked read', 'pending read', 'response', 'code save', 'removal']) {
    test(`account switch during ${stage} cannot continue transferring or redeem into B`, async () => {
        const h = harness({ legacy: 2, current: 0, info: { max_batch: 1 } });
        let switched = false;
        const switchOnce = () => { if (!switched) { switched = true; h.accountId = 'account-b'; } };
        if (stage === 'parked read') h.options.listParkedTickets = async () => { switchOnce(); return []; };
        if (stage === 'pending read') {
            const list = h.options.pendingStore.list;
            h.options.pendingStore.list = async scope => { const result = await list(scope); switchOnce(); return result; };
        }
        if (stage === 'response') {
            const submit = h.options.submit;
            h.options.submit = async (tickets, options) => {
                assert.equal(options.expectedAccountId, 'account-a');
                const result = await submit(tickets); switchOnce(); return result;
            };
        }
        if (stage === 'code save') {
            const put = h.options.pendingStore.put;
            h.options.pendingStore.put = async record => { await put(record); switchOnce(); };
        }
        if (stage === 'removal') {
            const remove = h.options.removeTickets;
            h.options.removeTickets = async (...args) => { await remove(...args); switchOnce(); };
        }
        await assert.rejects(h.transfer().run(), /account changed/i);
        assert.ok(h.submits.length <= 1);
        assert.equal(h.redeemCalls, 0);
        assert.equal(h.wallet.length, stage === 'removal' ? 1 : 2);
        for (const record of h.pending.values()) assert.equal(record.scope, 'account:account-a');
        if (['response', 'code save', 'removal'].includes(stage)) assert.equal(h.pending.size, 1);
    });
}

test('old servers without account binding keep tickets and issue no transfer', async () => {
    const h = harness({ info: { account_binding: undefined } });
    await assert.rejects(h.transfer().run(), /server update/);
    assert.equal(h.submits.length, 0);
    assert.equal(h.wallet.length, 4);
});

test('a switch after the final removal does not redeem the replacement wallet', async () => {
    const h = harness({ legacy: 1, current: 0 });
    const remove = h.options.removeTickets;
    h.options.removeTickets = async (...args) => { await remove(...args); h.accountId = 'account-b'; };
    await assert.rejects(h.transfer().run(), /account changed/i);
    assert.equal(h.redeemCalls, 0);
    assert.equal(h.pending.size, 1);
});


test('lost committed reply stays owned by A across switching to B and back', async () => {
    const h = parkedHarness({ live: 0, parked: 2 });
    const respond = h.respond;
    let reply;
    let committed = false;
    h.options.submit = async (tickets, { expectedAccountId }) => {
        assert.equal(expectedAccountId, h.accountId);
        h.submits.push([...tickets]);
        if (!committed) {
            committed = true;
            reply = respond(tickets);
            throw new Error('Reply lost after credit committed');
        }
        assert.equal(h.accountId, 'account-a', 'B must never submit A’s uncertain batch');
        assert.deepEqual(tickets, h.submits[0], 'retry exactly the original batch');
        return reply;
    };
    await assert.rejects(h.transfer().run(), /Reply lost/);
    assert.equal(h.pending.size, 0);
    assert.equal(h.attempt.accountId, 'account-a');
    h.accountId = 'account-b';
    assert.equal((await h.transfer().run()).moved, 0);
    assert.equal(h.submits.length, 1);
    h.accountId = 'account-a';
    // Replay must survive a changed batch setting and even loss/replacement
    // of the snapshot at login: the journal itself retains the exact request.
    h.info.max_batch = 1;
    h.options.listParkedTickets = async () => [];
    const result = await h.transfer().run();
    assert.equal(result.moved, 2);
    assert.equal(result.redeemed, true);
    assert.equal(h.submits.length, 2);
    assert.equal(h.attempt, null);
});

test('journal commit failure never sends tickets', async () => {
    const h = harness();
    h.options.attemptStore.put = async () => { throw new Error('Journal transaction aborted'); };
    await assert.rejects(h.transfer().run(), /transaction aborted/);
    assert.equal(h.submits.length, 0);
    assert.equal(h.wallet.length, 4);
});

test('journal cleanup failure preserves a replayable request and saved credit', async () => {
    const h = harness({ legacy: 1, current: 0 });
    h.options.attemptStore.clear = async () => { throw new Error('Cleanup transaction aborted'); };
    await assert.rejects(h.transfer().run(), /Cleanup/);
    assert.equal(h.attempt.tickets.length, 1);
    assert.equal(h.pending.size, 1);
    assert.equal(h.redeemCalls, 0);
});

test('journal read failure is retryable and cannot skip unfinished credit', async () => {
    const h = harness();
    h.options.attemptStore.get = async () => { throw new Error('Journal read failed'); };
    await assert.rejects(h.transfer().run(), /Journal read failed/);
    assert.equal(h.submits.length, 0);
});


test('a new run under B cannot take the remaining batches of A’s interrupted move', async () => {
    const h = parkedHarness({ live: 0, parked: 2, info: { max_batch: 1 } });
    h.info.max_batch = 1;
    const remove = h.options.removeParkedTickets;
    h.options.removeParkedTickets = async (...args) => { await remove(...args); h.accountId = 'account-b'; };
    await assert.rejects(h.transfer().run(), /account changed/i);
    assert.equal(h.submits.length, 1);
    assert.equal((await h.transfer().run()).moved, 0);
    assert.equal(h.submits.length, 1);
    assert.equal(h.attempt.accountId, 'account-a');
});

test('a reply lost before closure is replayed after reload without transferring fresh tickets', async () => {
    const h = harness({ legacy: 3, current: 0, info: { max_batch: 1 } });
    const result = h.respond([h.wallet[0].finalized_ticket]);
    h.options.submit = async tickets => { h.submits.push(tickets); throw new Error('Lost reply'); };
    await assert.rejects(h.transfer().run(), /Lost reply/);
    const saved = clone(h.attempt);
    h.info.enabled = false;
    h.info.key_id = null; // Completed replies remain replayable after configuration is removed.
    h.options.submit = async tickets => { h.submits.push(tickets); assert.deepEqual(tickets, saved.tickets); return result; };
    const restored = await h.transfer().run();
    assert.equal(restored.redeemed, true);
    assert.equal(h.wallet.length, 2, 'new batches stay untouched after closure');
    assert.equal(h.submits.length, 2);
    assert.equal(h.attempt, null);
    assert.equal((await h.transfer().run()).status, 'closed');
    assert.equal(h.submits.length, 2);
});

test('saved credit still redeems after the window closes, even with issuer config removed', async () => {
    const h = harness({ info: { enabled: false, key_id: null } });
    h.pending.set('saved', { scope: 'account:account-a', source: 'legacy-transfer', code: code(2) });
    h.failRedeem = true;
    assert.ok((await h.transfer().run()).redeemError);
    assert.equal(h.pending.size, 1);
    h.failRedeem = false;
    assert.equal((await h.transfer().run()).redeemed, true);
    assert.equal(h.pending.size, 0);
    assert.equal(h.submits.length, 0);
});

test('closed replay refusal retains its journal and never starts fresh transfers', async () => {
    const h = harness({ info: { enabled: false } });
    h.attempt = { accountId: h.accountId, tickets: [h.wallet[0].finalized_ticket] };
    h.failSubmit = Object.assign(new Error('closed'), { code: 'LEGACY_TRANSFER_CLOSED' });
    const result = await h.transfer().run();
    assert.equal(result.recoveryPending, true);
    assert.ok(h.attempt);
    assert.equal(h.submits.length, 1);
    assert.equal(h.submits[0].length, 1);
    h.accountId = 'account-b';
    assert.equal((await h.transfer().run()).moved, 0);
    assert.equal(h.submits.length, 1);
    assert.ok(h.attempt);
});


test('a retained journal does not block saved-code recovery when issuer config is removed', async () => {
    const h = harness({ info: { enabled: false, key_id: null } });
    h.attempt = { accountId: h.accountId, tickets: [h.wallet[0].finalized_ticket] };
    h.pending.set('saved', { scope: 'account:account-a', source: 'legacy-transfer', code: code(4) });
    h.failSubmit = Object.assign(new Error('closed'), { code: 'LEGACY_TRANSFER_CLOSED' });
    const result = await h.transfer().run();
    assert.equal(result.redeemed, true);
    assert.equal(h.pending.size, 0);
    assert.equal(result.recoveryPending, true);
    assert.ok(h.attempt);
    assert.equal(h.submits.length, 1);
});


test('unrelated pending trial cannot hold a completed restoration open', async () => {
    const h = harness({ legacy: 1 });
    const trial = { scope: 'account:account-a', code: code(9), source: 'trial' };
    h.pending.set('trial', trial);
    h.options.redeemPending = async options => {
        assert.equal(options.source, 'legacy-transfer');
        for (const [key, record] of h.pending) if (record.source === 'legacy-transfer') h.pending.delete(key);
        return { success: true, pendingCount: 1 };
    };
    const result = await h.transfer().run();
    assert.equal(result.redeemed, true);
    assert.equal(result.redeemError, null);
    assert.equal(h.pending.size, 1);
});

test('refused live and parked tickets remain parked across reload until policy changes', async () => {
    const h = parkedHarness({ live: 2, parked: 2 });
    let saved;
    h.options.rejectedStore = { get: async () => clone(saved), put: async (_, value) => { saved = clone(value); } };
    h.options.submit = async () => { h.submits.push('post'); throw Object.assign(new Error('limit'), { code: 'LEGACY_TRANSFER_LIMIT', remaining: 0 }); };
    const first = await h.transfer().run();
    assert.equal(first.stranded.length, 4);
    const posts = h.submits.length;
    const starts = h.started.length;
    const second = await h.transfer().run();
    assert.equal(second.stranded.length, 4);
    assert.equal(h.submits.length, posts);
    assert.equal(h.started.length, starts, 'no misleading moving notice on reload');
    h.info.policy_revision = 'raised';
    await h.transfer().run();
    assert.equal(h.submits.length, posts + 1);
});

test('B can restore unrelated tickets while preserving A journal for replay', async () => {
    const h = harness({ legacy: 2 });
    const aTicket = tokenForKeyId(LEGACY_KEY, 91);
    const journals = new Map([['account-a', { accountId: 'account-a', tickets: [aTicket], reservedTickets: [aTicket] }]]);
    h.options.attemptStore = {
        list: async () => [...journals.values()].map(clone),
        put: async value => journals.set(value.accountId, clone(value)),
        clear: async accountId => journals.delete(accountId)
    };
    h.accountId = 'account-b';
    h.wallet.push({ finalized_ticket: aTicket });
    const result = await h.transfer().run();
    assert.equal(result.moved, 2);
    assert.deepEqual(result.reserved, [aTicket]);
    assert.equal(journals.has('account-a'), true);
    assert.equal(journals.has('account-b'), false);
    assert.ok(h.wallet.some(ticket => ticket.finalized_ticket === aTicket));
});


test('journal retains and restores the owned remainder even when the wallet snapshot disappears', async () => {
    const h = harness({ legacy: 2, current: 0 });
    const saved = h.wallet.map(ticket => ticket.finalized_ticket);
    h.attempt = { accountId: h.accountId, tickets: [saved[0]], reservedTickets: saved };
    h.wallet = [];
    const result = await h.transfer().run();
    assert.equal(result.moved, 2);
    assert.deepEqual(h.submits.flat(), saved);
    assert.equal(h.attempt, null);
});

test('failed refusal persistence keeps the recovery journal', async () => {
    const h = harness({ legacy: 1 });
    h.options.rejectedStore = { get: async () => null, put: async () => { throw new Error('Disk full'); } };
    h.options.submit = async () => { throw Object.assign(new Error('limit'), { code: 'LEGACY_TRANSFER_LIMIT', remaining: 0 }); };
    await assert.rejects(h.transfer().run(), /Disk full/);
    assert.equal(h.attempt.accountId, h.accountId);
    assert.equal(h.wallet.length, 2);
});

test('untagged older recovery is retried without letting a paused unrelated code block migration', async () => {
    const h = harness({ legacy: 0 });
    h.pending.set('old', { scope: 'account:account-a', code: code(3) });
    h.failRedeem = true;
    let notice;
    h.options.onAttention = message => { notice = message; };
    const result = await h.transfer().run();
    assert.equal(result.redeemError, null);
    assert.equal(h.pending.size, 1);
    assert.match(notice, /saved ticket codes/);
});
