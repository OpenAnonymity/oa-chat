import test from 'node:test';
import assert from 'node:assert/strict';
import runtimeSingleton, { BrowserWalletRuntime } from '@openanonymity/zkapi-browser-sdk/runtime';
import { ZkapiClient } from '@openanonymity/zkapi-browser-sdk/client';

const ADDRESS = `0x${'12'.repeat(20)}`;
const VAULT = `0x${'34'.repeat(20)}`;
const HASH = `0x${'56'.repeat(32)}`;
const DEPLOYMENT = 'deposit-recovery-test';

function savedPlan(overrides = {}) {
    return { operationId: 'saved-deposit', phase: 'prepared', amount: 100,
        next_note_id: 7, commitment: '0x1234', secret: 'local-test-secret',
        active_root: 'original-root', zero_path: ['original-path'], ...overrides };
}

function attachRuntime(durable, runtime = new BrowserWalletRuntime()) {
    runtime.manifest = { deployment_id: DEPLOYMENT };
    runtime.config = { funding: { chain_id: 1, contract_address: VAULT }, wallet_core: {} };
    runtime.runtime = structuredClone(durable.value);
    runtime.init = async () => {};
    runtime.reload = async () => { runtime.runtime = structuredClone(durable.value); };
    runtime.commit = async next => { durable.value = structuredClone(next); runtime.runtime = structuredClone(next); };
    runtime.prewarmRequestProver = async () => {};
    runtime.nextDepositPath = async () => assert.fail('an unresolved send must retain its exact append path');
    runtime.worker = { call: async () => assert.fail('an unresolved send must retain its original secret') };
    return runtime;
}

for (const fundingQuote of [false, true]) {
    test(`rejected ${fundingQuote ? 'address' : 'MetaMask'} retries preserve the original unknown send across reload`, async () => {
        const durable = { value: { pendingDeposit: savedPlan() } };
        let runtime = attachRuntime(durable);
        const original = await runtime.claimPendingDepositSubmission();
        await runtime.rememberPendingDepositSubmissionMetadata(original, { from: ADDRESS, nonce: 0 });
        await runtime.markPendingDepositAmbiguous(original, 'The provider timed out after accepting the send.');
        await runtime.authorizePendingDepositRetry({ forFundingQuote: fundingQuote });
        for (let cancellation = 0; cancellation < 3; cancellation++) {
            const retry = await runtime.claimPendingDepositSubmission();
            await runtime.rememberPendingDepositSubmissionMetadata(retry, { from: ADDRESS, nonce: cancellation + 1 });
            await runtime.markPendingDepositRetryable(null, retry);
            runtime = attachRuntime(durable);
            const plan = await runtime.pendingDeposit();
            assert.equal(plan.phase, 'retry_exact');
            assert.equal(plan.next_note_id, 7);
            assert.equal(plan.secret, 'local-test-secret');
            assert.deepEqual(plan.zero_path, ['original-path']);
            assert.equal(plan.ambiguousSubmissions[0].submissionId, original.submissionId);
            await assert.rejects(runtime.refreshPendingDeposit(100, 'changed-root'), /wallet attempt/);
            assert.equal((await runtime.prepareDeposit(100)).phase, 'retry_exact');
            await assert.rejects(runtime.prepareDeposit(200), /Recover it before changing the amount/);
        }
        // A delayed hash still attaches to the exact original recovery note.
        await runtime.rememberPendingDepositTransaction(HASH, original, { from: ADDRESS, nonce: 0 });
        assert.equal(durable.value.pendingDeposit.phase, 'submitted');
        assert.deepEqual(durable.value.pendingDeposit.transactionHashes, [HASH]);
        assert.equal(durable.value.pendingDeposit.next_note_id, 7);
    });
}

for (const entry of ['pendingDeposit', 'prepareDeposit']) {
    for (const ambiguity of [{ ambiguousSubmissions: [{ submissionId: 'old' }] }, { legacyRecovery: true }]) {
        test(`${entry} repairs an older incorrectly prepared unknown deposit without changing its identity`, async () => {
            const durable = { value: { pendingDeposit: savedPlan(ambiguity) } };
            const runtime = attachRuntime(durable);
            const result = await runtime[entry](100);
            assert.equal(result.phase, 'retry_exact');
            assert.equal(durable.value.pendingDeposit.phase, 'retry_exact');
            assert.equal(result.active_root, 'original-root');
            assert.deepEqual(result.zero_path, ['original-path']);
            assert.equal(result.secret, 'local-test-secret');
        });
    }
}

test('a rejected first send remains safely prepared and can rebase after reload', async () => {
    const durable = { value: { pendingDeposit: savedPlan() } };
    const runtime = attachRuntime(durable);
    const claim = await runtime.claimPendingDepositSubmission();
    await runtime.markPendingDepositRetryable(null, claim);
    assert.equal((await runtime.pendingDeposit()).phase, 'prepared');
    runtime.nextDepositPath = async () => ({ note_id: 8, active_root: 'new-root', siblings: ['new-path'] });
    const updated = await runtime.refreshPendingDeposit(100, 'new-root');
    assert.equal(updated.next_note_id, 8);
    assert.equal(updated.secret, 'local-test-secret');
});

test('finalized slot conflict resolves earlier ambiguity and permits a new append path', async () => {
    const plan = savedPlan({ phase: 'retry_exact', ambiguousSubmissions: [{ submissionId: 'old' }] });
    const durable = { value: { pendingDeposit: plan } };
    const runtime = attachRuntime(durable);
    await runtime.resolvePendingDepositSlotConflict({ operationId: plan.operationId, noteId: 7,
        amount: 100, commitment: plan.commitment, phase: plan.phase, transactionHashes: [] });
    assert.equal((await runtime.pendingDeposit()).phase, 'prepared');
    const claim = await runtime.claimPendingDepositSubmission();
    await runtime.markPendingDepositRetryable(null, claim);
    assert.equal((await runtime.pendingDeposit()).phase, 'prepared');
    runtime.nextDepositPath = async () => ({ note_id: 8, active_root: 'new-root', siblings: ['new-path'] });
    assert.equal((await runtime.refreshPendingDeposit(100)).next_note_id, 8);
});

test('closing a replacement prompt after reload releases only that claim and retains same-nonce recovery', async t => {
    const durable = { value: { pendingDeposit: savedPlan({ phase: 'dropped_or_pending',
        transactionHash: HASH, transactionHashes: [HASH],
        transactionAttempts: [{ hash: HASH, from: ADDRESS, nonce: 0 }] }) } };
    const originalRuntime = attachRuntime(durable);
    const replacement = await originalRuntime.claimPendingDepositReplacement(ADDRESS);
    const runtime = attachRuntime(durable);
    const client = new ZkapiClient();
    client.browserMode = true;
    for (const name of ['pendingDeposit', 'releasePendingDepositReplacementClaim', 'markPendingDepositUnknown']) {
        t.mock.method(runtimeSingleton, name, runtime[name].bind(runtime));
    }
    t.mock.method(client, 'refresh', async () => { client.config = { pending_deposit: structuredClone(durable.value.pendingDeposit) }; });
    await client.recoverUnknownDeposit();
    const plan = durable.value.pendingDeposit;
    assert.equal(plan.phase, 'dropped_or_pending');
    assert.equal(plan.submissionId, undefined);
    assert.deepEqual(plan.transactionHashes, [HASH]);
    assert.equal(plan.ambiguousReplacements[0].submissionId, replacement.submissionId);
    const next = await runtime.claimPendingDepositReplacement(ADDRESS);
    assert.equal(next.replacementNonce, 0);
    assert.equal(next.replacementFrom, ADDRESS);
    assert.equal(next.plan.next_note_id, 7);
    assert.notEqual(next.submissionId, replacement.submissionId);
});

test('ordinary interrupted sends remain ambiguous and cannot be silently replaced', async t => {
    const durable = { value: { pendingDeposit: savedPlan() } };
    const runtime = attachRuntime(durable);
    const claim = await runtime.claimPendingDepositSubmission();
    await runtime.rememberPendingDepositSubmissionMetadata(claim, { from: ADDRESS, nonce: 0 });
    const client = new ZkapiClient();
    client.browserMode = true;
    for (const name of ['pendingDeposit', 'markPendingDepositUnknown']) {
        t.mock.method(runtimeSingleton, name, runtime[name].bind(runtime));
    }
    t.mock.method(runtimeSingleton, 'releasePendingDepositReplacementClaim', async () => assert.fail('not a replacement'));
    t.mock.method(client, 'refresh', async () => { client.config = { pending_deposit: durable.value.pendingDeposit }; });
    await client.recoverUnknownDeposit();
    assert.equal(durable.value.pendingDeposit.phase, 'ambiguous');
    assert.equal(durable.value.pendingDeposit.submissionId, claim.submissionId);
});

test('read-only status repairs a replacement dismissed before the patch without opening a wallet', async t => {
    const durable = { value: { pendingDeposit: savedPlan({ phase: 'dropped_or_pending',
        transactionHash: HASH, transactionHashes: [HASH],
        transactionAttempts: [{ hash: HASH, from: ADDRESS, nonce: 0 }] }) } };
    const runtime = attachRuntime(durable);
    await runtime.claimPendingDepositReplacement(ADDRESS);
    await runtime.markPendingDepositUnknown();
    assert.equal(durable.value.pendingDeposit.phase, 'ambiguous');
    const client = new ZkapiClient();
    client.browserMode = true;
    client.setWalletProvider({ request: async ({ method }) => {
        assert.equal(method, 'eth_getTransactionReceipt', 'status never opens MetaMask or signs');
        return null;
    } });
    for (const name of ['pendingDeposit', 'releasePendingDepositReplacementClaim', 'markPendingDepositMissingReceipts']) {
        t.mock.method(runtimeSingleton, name, runtime[name].bind(runtime));
    }
    t.mock.method(client, 'refresh', async () => { client.config = { pending_deposit: durable.value.pendingDeposit }; });
    t.mock.method(client, 'readBrowserNote', async () => ({ status: 0 }));
    t.mock.method(client, 'browserDepositNonceConsumed', async () => ({ consumed: false }));
    const result = await client.recoverBrowserDeposit();
    assert.equal(result.status, 'dropped_or_pending');
    assert.equal(result.replacement_available, true);
    assert.equal(durable.value.pendingDeposit.submissionId, undefined);
    assert.equal(durable.value.pendingDeposit.transactionHashes[0], HASH);
    assert.equal(durable.value.pendingDeposit.next_note_id, 7);
});
