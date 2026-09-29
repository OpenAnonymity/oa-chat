import test from 'node:test';
import assert from 'node:assert/strict';
import { resetCanceledDeposit, isWalletCancellation } from '../../chat/zkapi/services/canceledDeposit.mjs';

const rejection = () => Object.assign(new Error('User rejected the request.'), { code: 4001, broadcastPossible: false });

function fixture(overrides = {}, stateOverrides = {}) {
    const plan = { phase: 'prepared', operationId: 'original', secret: 'unused-note-secret', ...overrides };
    const state = { pendingDeposit: plan, journal: { private: 'keep' }, depositQuote: { secret: 'keep' }, ...stateOverrides };
    let locked = false;
    let commits = 0;
    const runtime = {
        manifest: { deployment_id: 'deployment' }, runtime: state,
        async init() {},
        async reload() { assert.equal(locked, true); },
        async commit(next) { assert.equal(locked, true); commits++; this.runtime = next; }
    };
    const client = { browserMode: true, config: { pending_deposit: { operation_id: 'original' } } };
    const withWalletLock = async (scope, callback) => {
        assert.equal(scope, 'deployment'); locked = true;
        try { return await callback(); } finally { locked = false; }
    };
    return { client, runtime, withWalletLock, plan, commits: () => commits };
}

test('a definite wallet rejection releases only the exact unused deposit draft', async () => {
    const f = fixture();
    assert.equal(await resetCanceledDeposit(rejection(), 'original', f), true);
    assert.equal(f.runtime.runtime.pendingDeposit, null);
    assert.equal(f.client.config.pending_deposit, null);
    assert.deepEqual(f.runtime.runtime.journal, { private: 'keep' });
    assert.deepEqual(f.runtime.runtime.depositQuote, { secret: 'keep' });
    assert.equal(f.commits(), 1);
});

for (const change of [
    { phase: 'submitted' }, { phase: 'ambiguous' }, { phase: 'awaiting_wallet' }, { phase: 'retry_exact' },
    { operationId: 'other-tab' }, { legacyRecovery: true }, { submissionId: 'claim' },
    { submissionNonce: 0 }, { transactionHash: '0x123' }, { transactionHashes: ['0x123'] },
    { transactionAttempts: [{ hash: '0x123' }] }, { ambiguousSubmissions: [{}] }, { approvals: [{}] }
]) {
    test(`cancellation preserves recovery state with ${JSON.stringify(change)}`, async () => {
        const f = fixture(change);
        assert.equal(await resetCanceledDeposit(rejection(), 'original', f), false);
        assert.equal(f.runtime.runtime.pendingDeposit, f.plan);
        assert.equal(f.commits(), 0);
    });
}

for (const change of [{ state: { secret: 'active-note' } }, { lateDepositAttempts: [{ operationId: 'original' }] }]) {
    test(`cancellation preserves active or late recovery: ${JSON.stringify(change)}`, async () => {
        const f = fixture({}, change);
        assert.equal(await resetCanceledDeposit(rejection(), 'original', f), false);
        assert.equal(f.commits(), 0);
    });
}

for (const error of [new Error('User rejected request'), { code: 4001, broadcastPossible: true },
    { code: 4001, transactionHash: '0x123' }, { code: 4001, transactionReceipt: {} },
    { code: 4001, journalRecoveryError: new Error('save failed') }]) {
    test(`uncertain cancellation evidence preserves the draft: ${JSON.stringify(error)}`, async () => {
        const f = fixture();
        assert.equal(await resetCanceledDeposit(error, 'original', f), false);
        assert.equal(f.commits(), 0);
    });
}

test('cleanup rechecks a replacement written by another tab while waiting for its lock', async () => {
    const f = fixture();
    f.runtime.reload = async () => { f.runtime.runtime.pendingDeposit = { ...f.plan, operationId: 'replacement', secret: 'new-secret' }; };
    assert.equal(await resetCanceledDeposit(rejection(), 'original', f), false);
    assert.equal(f.runtime.runtime.pendingDeposit.secret, 'new-secret');
    assert.equal(f.commits(), 0);
});

test('rejection before a deposit plan exists needs only a presentation reset', async () => {
    const f = fixture();
    f.client.config.pending_deposit = null;
    assert.equal(await resetCanceledDeposit(rejection(), null, f), true);
    assert.equal(f.commits(), 0);
});

test('wrapped MetaMask rejection codes are recognized, arbitrary prose is not', () => {
    assert.equal(isWalletCancellation({ cause: { code: 4001 } }), true);
    assert.equal(isWalletCancellation({ code: 'ACTION_REJECTED' }), true);
    assert.equal(isWalletCancellation(new Error('Wallet rejected network request')), false);
});
