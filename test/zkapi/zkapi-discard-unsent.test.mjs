// The user-confirmed "Cancel unfinished deposit": discardUnsentDeposit
// (chat/zkapi/services/canceledDeposit.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { discardUnsentDeposit } from '../../chat/zkapi/services/canceledDeposit.mjs';

const DEPLOYMENT = 'zkapi-native-eth-sepolia-note-bound-v1-fresh-20260930';
const plan = (overrides = {}) => ({
    operationId: 'op-1', createdAt: 1, phase: 'prepared', amount: 5, secret: 'SECRET-PLAN-MARKER',
    commitment: '0x01', next_note_id: 9, active_root: '0x02', zero_path: ['0x03'], ...overrides
});
const quote = (overrides = {}) => ({
    operationId: 'quote-1', createdAt: 1, amount: 5, secret: 'SECRET-QUOTE-MARKER', commitment: '0x04',
    next_note_id: 9, active_root: '0x02', zero_path: ['0x03'], ...overrides
});

function fixture(state, { browserMode = true, pending = null } = {}) {
    const events = [];
    let locked = false;
    const runtime = {
        manifest: { deployment_id: DEPLOYMENT },
        runtime: state,
        async init() { events.push('init'); },
        async reload() { assert.equal(locked, true, 'reload under the lock'); events.push('reload'); },
        async commit(next) {
            assert.equal(locked, true, 'commit under the lock');
            events.push('commit');
            this.committed = next;
            this.runtime = next;
        }
    };
    const client = { browserMode, config: pending ? { pending_deposit: pending } : { pending_deposit: null } };
    const withWalletLock = async (scope, callback) => {
        assert.equal(scope, DEPLOYMENT);
        locked = true;
        events.push('lock');
        try { return await callback(); } finally { locked = false; events.push('unlock'); }
    };
    return { runtime, client, withWalletLock, events };
}

test('a deposit draft alone is released', async () => {
    const f = fixture({ version: 1, deploymentId: DEPLOYMENT, depositQuote: quote(), updatedAt: 5 });
    assert.equal(await discardUnsentDeposit(f), true);
    assert.deepEqual(f.events, ['init', 'lock', 'reload', 'commit', 'unlock']);
    assert.deepEqual(f.runtime.committed, { version: 1, deploymentId: DEPLOYMENT, depositQuote: null, pendingDeposit: null, updatedAt: 5 });
});

test('a never-sent plan (and the draft beside it) is released and the client view cleared', async () => {
    const f = fixture({ version: 1, deploymentId: DEPLOYMENT, pendingDeposit: plan(), depositQuote: quote(), updatedAt: 5, journal: null },
        { pending: { operation_id: 'op-1', phase: 'prepared' } });
    assert.equal(await discardUnsentDeposit(f), true);
    assert.equal(f.runtime.committed.pendingDeposit, null);
    assert.equal(f.runtime.committed.depositQuote, null);
    assert.equal(f.client.config.pending_deposit, null);
    // Fields that were not discarded are carried over untouched.
    assert.equal(f.runtime.committed.deploymentId, DEPLOYMENT);
    assert.equal(f.runtime.committed.updatedAt, 5);
});

test('another operation already shown by the client is never overwritten', async () => {
    const f = fixture({ version: 1, deploymentId: DEPLOYMENT, pendingDeposit: plan() },
        { pending: { operation_id: 'a-different-operation' } });
    assert.equal(await discardUnsentDeposit(f), true);
    assert.deepEqual(f.client.config.pending_deposit, { operation_id: 'a-different-operation' });
});

const PROTECTED = {
    'a submission claim': { pendingDeposit: plan({ submissionId: 'claim' }) },
    'a claim owner': { pendingDeposit: plan({ submissionOwner: 'tab' }) },
    'a claim sender': { pendingDeposit: plan({ submissionFrom: '0x1' }) },
    'a nonce': { pendingDeposit: plan({ submissionNonce: 0 }) },
    'a transaction hash': { pendingDeposit: plan({ transactionHash: '0x1' }) },
    'transaction hashes': { pendingDeposit: plan({ transactionHashes: ['0x1'] }) },
    'transaction attempts': { pendingDeposit: plan({ transactionAttempts: [{}] }) },
    'an ambiguous submission': { pendingDeposit: plan({ ambiguousSubmissions: [{}] }) },
    'an approval': { pendingDeposit: plan({ approvals: [{}] }) },
    'a legacy recovery marker': { pendingDeposit: plan({ legacyRecovery: true }) },
    'a non-prepared phase': { pendingDeposit: plan({ phase: 'awaiting_wallet' }) },
    'a plan field the host does not know': { pendingDeposit: plan({ somethingNew: { held: true } }) },
    'a late attempt of the same operation': { pendingDeposit: plan(), lateDepositAttempts: [{ operationId: 'op-1', status: 'pending' }] },
    'an active note': { depositQuote: quote(), state: { note_id: 5 } },
    'a journal': { depositQuote: quote(), journal: { phase: 'x' } },
    'an exit lock': { depositQuote: quote(), exitLock: { held: true } },
    'a prepared withdrawal': { depositQuote: quote(), preparedWithdrawal: { mode: 'mutual' } },
    'a lease': { depositQuote: quote(), lease: { id: 'k' } },
    'a late withdrawal attempt': { depositQuote: quote(), lateWithdrawalAttempts: [{ status: 'pending' }] },
    'an unknown slot field': { depositQuote: quote(), futureField: { value: 1 } }
};

for (const [label, fields] of Object.entries(PROTECTED)) {
    test(`it never releases a slot with ${label}`, async () => {
        const f = fixture({ version: 1, deploymentId: DEPLOYMENT, updatedAt: 5, ...fields });
        const before = structuredClone(f.runtime.runtime);
        assert.equal(await discardUnsentDeposit(f), false);
        assert.equal(f.events.includes('commit'), false);
        assert.deepEqual(f.runtime.runtime, before);
    });
}

test('an empty slot has nothing to release, and a missing slot is not an error', async () => {
    for (const state of [{ version: 1, deploymentId: DEPLOYMENT }, null, undefined]) {
        const f = fixture(state);
        assert.equal(await discardUnsentDeposit(f), false);
        assert.equal(f.events.includes('commit'), false);
    }
});

test('the decision is made on the re-read slot, not on what was seen before the lock', async () => {
    const f = fixture({ version: 1, deploymentId: DEPLOYMENT, pendingDeposit: plan() });
    f.runtime.reload = async function reload() {
        // Another tab claimed the plan while this one waited for the lock.
        this.runtime = { version: 1, deploymentId: DEPLOYMENT, pendingDeposit: plan({ submissionId: 'claim' }) };
    };
    assert.equal(await discardUnsentDeposit(f), false);
    assert.equal(f.events.includes('commit'), false);
});

test('outside browser mode there is no wallet to touch', async () => {
    const f = fixture({ version: 1, deploymentId: DEPLOYMENT, depositQuote: quote() }, { browserMode: false });
    assert.equal(await discardUnsentDeposit(f), false);
    assert.deepEqual(f.events, []);
});
