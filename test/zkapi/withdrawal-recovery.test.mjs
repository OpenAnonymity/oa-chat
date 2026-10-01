import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWalletRuntime } from '@openanonymity/zkapi-browser-sdk/runtime';
import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { availableWithdrawalEscape, sameWithdrawalEscape, assertWithdrawalEscapeAvailable } from '../../chat/zkapi/services/withdrawalRecovery.mjs';

const destination = `0x${'12'.repeat(20)}`;

function fixture() {
    const plan = { operationId: 'withdraw-7', noteId: 7, destination, phase: 'reserving', mode: 'mutual', clearanceReserved: true };
    const client = { browserMode: true, note: { note_id: 7 }, config: { prepared_withdrawal: {
        note_id: 7, destination, phase: 'reserving', mode: 'mutual'
    } } };
    const runtime = { manifest: { deployment_id: 'test' }, runtime: {
        state: { note_id: 7 }, preparedWithdrawal: plan, lateWithdrawalAttempts: []
    }, async init() {}, async reload() {} };
    return { client, runtime, plan };
}

test('a close interrupted during clearance offers escape with only public operation identity', () => {
    const context = fixture();
    context.plan.proof = 'private-proof-must-not-escape';
    assert.deepEqual(availableWithdrawalEscape(context), { operationId: 'withdraw-7', noteId: 7, destination });
    context.plan.phase = 'prepared';
    assert.ok(availableWithdrawalEscape(context));
});

test('submission claims, ambiguous history, hashes and late callbacks never offer a mode change', () => {
    for (const fields of [
        { phase: 'awaiting_wallet' }, { phase: 'ambiguous' }, { phase: 'submitted' },
        { phase: 'dropped_or_pending' }, { mode: 'escape' }, { submissionId: 'prompt' },
        { submissionOwner: 'another-tab' }, { submissionFrom: destination }, { submissionNonce: 0 },
        { legacyRecovery: true }, { submissionNonceJournalRequired: true },
        { transactionHash: 'hash' }, { transactionHashes: ['hash'] },
        { transactionAttempts: [{ hash: 'hash' }] }, { ambiguousSubmissions: [{ submissionId: 'old-prompt' }] },
        { ambiguousReplacements: [{ submissionId: 'replacement' }] }
    ]) {
        const context = fixture();
        Object.assign(context.plan, fields);
        assert.equal(availableWithdrawalEscape(context), null, JSON.stringify(fields));
    }
    for (const status of ['submitted', 'receipt_mismatch', 'invalid_identity', undefined]) {
        const context = fixture();
        context.runtime.runtime.lateWithdrawalAttempts = [{ noteId: 7, status }];
        assert.equal(availableWithdrawalEscape(context), null, String(status));
    }
});

test('a different displayed note or destination cannot inherit the previous escape choice', () => {
    const context = fixture();
    const choice = availableWithdrawalEscape(context);
    context.client.config.prepared_withdrawal.destination = `0x${'34'.repeat(20)}`;
    assert.equal(availableWithdrawalEscape(context), null);
    assert.equal(sameWithdrawalEscape(choice, { ...choice, operationId: 'new-operation' }), false);
    assert.equal(sameWithdrawalEscape(choice, { ...choice, noteId: 8 }), false);
});

test('Continue rechecks the journal under the wallet lock and refuses another tab’s new submission', async () => {
    const context = fixture();
    const choice = availableWithdrawalEscape(context);
    let locked = false;
    context.runtime.reload = async () => {
        assert.equal(locked, true);
        context.plan.submissionId = 'other-tab-request';
    };
    context.withWalletLock = async (_deployment, operation) => {
        locked = true;
        try { return await operation(); } finally { locked = false; }
    };
    await assert.rejects(assertWithdrawalEscapeAvailable(choice, context), /saved withdrawal changed/);
});

test('real SDK reload of an interrupted clearance can prepare escape without another clearance request', async () => {
    let durable = { deploymentId: 'reloaded-withdrawal', state: { note_id: 7, current_balance: 1000000 },
        preparedWithdrawal: null, journal: null, lease: null, lateWithdrawalAttempts: [] };
    const interrupted = new Error('page closed during clearance');
    let clearanceRequests = 0;
    function runtimeForPage() {
        const runtime = new BrowserWalletRuntime();
        runtime.manifest = { deployment_id: durable.deploymentId };
        runtime.config = { funding: { protocol_server_url: 'https://protocol.invalid' }, wallet_core: {},
            proving_keys: { withdrawal: {} } };
        runtime.runtime = structuredClone(durable);
        runtime.init = async () => {};
        runtime.settleActiveLease = async () => {};
        runtime.recoverPendingLocked = async () => {};
        runtime.reload = async () => { runtime.runtime = structuredClone(durable); };
        runtime.commit = async next => { durable = structuredClone(next); runtime.runtime = structuredClone(next); };
        runtime.treePath = async () => ({ active_root: '1', siblings: [] });
        runtime.remoteJson = async () => { clearanceRequests++; throw interrupted; };
        runtime.worker = { async call(method, payload) {
            if (method === 'withdrawalNullifier') return '2';
            assert.equal(method, 'prepareWithdrawal');
            assert.equal(payload.args.mode, 'escape');
            assert.equal(payload.args.clearance, null);
            assert.equal(payload.args.destination, destination);
            return { mode: 'escape', proof: 'local-proof', public_inputs: { note_id: 7, active_root: '1', withdrawal_nullifier: '2' } };
        } };
        return runtime;
    }
    await assert.rejects(runtimeForPage().prepareWithdrawal('mutual', destination), interrupted);
    assert.equal(durable.preparedWithdrawal.phase, 'reserving');
    const operationId = durable.preparedWithdrawal.operationId;
    const reloaded = runtimeForPage();
    const context = fixture();
    context.runtime = reloaded;
    assert.equal(availableWithdrawalEscape(context)?.operationId, operationId);
    const escape = await reloaded.prepareWithdrawal('escape', destination);
    assert.equal(escape.phase, 'prepared');
    assert.equal(escape.mode, 'escape');
    assert.equal(escape.operationId, operationId);
    assert.equal(escape.destination, destination);
    assert.equal(escape.clearanceReserved, true);
    assert.equal(clearanceRequests, 1, 'escape recovery does not depend on the unavailable clearance service');
});

for (const mode of ['mutual', 'escape']) for (const timing of ['before preparation', 'during pending-lease recovery']) {
    test(`the SDK cannot prepare ${mode} on a successor note that appears ${timing}`, async () => {
        const runtime = new BrowserWalletRuntime();
        let durable = { deploymentId: 'withdraw-note-ownership', state: { note_id: timing === 'before preparation' ? 8 : 7 },
            preparedWithdrawal: null, journal: null, lease: null, lateWithdrawalAttempts: [] };
        runtime.manifest = { deployment_id: durable.deploymentId };
        runtime.config = { funding: { protocol_server_url: 'https://protocol.invalid' }, wallet_core: {},
            proving_keys: { withdrawal: {} } };
        runtime.runtime = structuredClone(durable);
        runtime.init = async () => {};
        runtime.settleActiveLease = async () => {};
        let reloads = 0;
        runtime.reload = async () => {
            if (mode === 'escape' && timing === 'during pending-lease recovery' && ++reloads === 2) durable.state.note_id = 8;
            runtime.runtime = structuredClone(durable);
        };
        runtime.recoverPendingLocked = async () => {
            if (timing === 'during pending-lease recovery') durable.state.note_id = 8;
        };
        runtime.treePath = async () => assert.fail('a successor note must be rejected before its proof path is read');
        runtime.commit = async () => assert.fail('a successor note must not be reserved');
        runtime.remoteJson = async () => assert.fail('a successor note must never request clearance');
        runtime.worker = { call: async () => assert.fail('a successor note must never start a proof') };
        await assert.rejects(runtime.prepareWithdrawal(mode, destination, { expectedNoteId: 7 }), /private balance changed/i);
        assert.equal(durable.preparedWithdrawal, null);
    });
}

test('SDK withdrawal keeps the original note identity across a delayed wallet connection', async t => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, browserMode: zkapiClient.browserMode };
    Object.assign(zkapiClient, { browserMode: true, wallet: { note: { note_id: 7 } }, config: {
        funding: { contract_address: `0x${'34'.repeat(20)}` }, prepared_withdrawal: null
    } });
    t.after(() => Object.assign(zkapiClient, original));
    t.mock.method(zkapiClient, 'assertBalanceNotClaimed', async () => {});
    t.mock.method(zkapiClient, 'settleActiveLease', async () => {});
    t.mock.method(zkapiClient, 'connectWallet', async () => {
        zkapiClient.wallet = { note: { note_id: 8 } };
        return destination;
    });
    t.mock.method(walletRuntime, 'assertEscapeReady', async () => {});
    t.mock.method(zkapiClient, 'assertWithdrawalFunding', async () => {});
    t.mock.method(walletRuntime, 'currentPreparedWithdrawal', async () => null);
    t.mock.method(zkapiClient, 'readContractUint', async () => 1n);
    t.mock.method(walletRuntime, 'prepareWithdrawal', async (_mode, _destination, options) => {
        assert.equal(options.expectedNoteId, 7, 'the runtime must receive the pre-connection note identity');
        assert.equal(options.expectedWithdrawalOperationId, 'original-operation', 'the runtime must receive the explicitly chosen operation');
        throw new Error('The private balance changed.');
    });
    t.mock.method(zkapiClient, 'recoverFailedWithdrawalSubmission', async () => null);
    const send = t.mock.method(zkapiClient, 'sendContractTransaction', async () => assert.fail('must not send a successor withdrawal'));
    await assert.rejects(zkapiClient.performWithdrawal('escape', () => {}, {
        destination, expectedWithdrawalOperationId: 'original-operation'
    }), /private balance changed/);
    assert.equal(send.mock.callCount(), 0);
});

for (const change of ['unknown retry', 'operation', 'destination', 'late attempt', 'during recovery', 'same mode unknown retry']) {
    test(`escape submission revalidates ${change} after the host releases its precheck lock`, async () => {
        const context = fixture();
        const runtime = new BrowserWalletRuntime();
        let durable = structuredClone(context.runtime.runtime);
        let pathReads = 0;
        let commits = 0;
        runtime.manifest = { deployment_id: 'escape-switch-recheck' };
        runtime.config = { funding: { protocol_server_url: 'https://protocol.invalid' }, wallet_core: {},
            proving_keys: { withdrawal: {} } };
        runtime.runtime = structuredClone(durable);
        runtime.init = async () => {};
        runtime.settleActiveLease = async () => {};
        runtime.reload = async () => { runtime.runtime = structuredClone(durable); };
        runtime.commit = async next => { commits++; durable = structuredClone(next); runtime.runtime = structuredClone(next); };
        runtime.treePath = async () => { pathReads++; return { active_root: '1', siblings: [] }; };
        runtime.worker = { call: async () => ({ mode: 'escape', proof: 'proof',
            public_inputs: { note_id: 7, active_root: '1', withdrawal_nullifier: '2' } }) };
        const makeUnknownRetry = () => Object.assign(durable.preparedWithdrawal, {
            phase: 'prepared', submissionOutcome: 'retry_authorized',
            ambiguousSubmissions: [{ submissionId: 'another-tab-unknown-request' }]
        });
        let guarded = false;
        runtime.assertEscapeReady = async () => { if (change === 'during recovery') makeUnknownRetry(); guarded = true; };
        runtime.recoverPendingLocked = async () => assert.fail('escape must not invoke server recovery');
        context.runtime = runtime;
        const choice = availableWithdrawalEscape(context);
        assert.ok(choice);
        await assertWithdrawalEscapeAvailable(choice, context);
        // A different tab now changes durable state after the host check but
        // before the SDK acquires its own preparation lock.
        if (change === 'unknown retry' || change === 'same mode unknown retry') makeUnknownRetry();
        if (change === 'same mode unknown retry') durable.preparedWithdrawal.mode = 'escape';
        if (change === 'operation') durable.preparedWithdrawal.operationId = 'successor-operation';
        if (change === 'destination') durable.preparedWithdrawal.destination = `0x${'56'.repeat(20)}`;
        if (change === 'late attempt') durable.lateWithdrawalAttempts = [{ noteId: 7, status: 'submitted', transactionHash: `0x${'1'.repeat(64)}` }];
        await assert.rejects(runtime.prepareWithdrawal('escape', choice.destination, {
            expectedNoteId: choice.noteId, expectedWithdrawalOperationId: choice.operationId
        }));
        assert.equal(pathReads, 0, 'reject before generating a replacement proof');
        assert.equal(commits, 0, 'preserve every original ambiguity and ownership signal');
    });
}

test('SDK mode switches reject ambiguity even without the host’s expected-operation option', async () => {
    const context = fixture();
    const runtime = new BrowserWalletRuntime();
    runtime.manifest = { deployment_id: 'escape-switch-without-host' };
    runtime.runtime = context.runtime.runtime;
    runtime.runtime.preparedWithdrawal.phase = 'prepared';
    runtime.runtime.preparedWithdrawal.ambiguousSubmissions = [{ submissionId: 'unknown' }];
    runtime.init = async () => {};
    runtime.settleActiveLease = async () => {};
    runtime.reload = async () => {};
    runtime.recoverPendingLocked = async () => {};
    let paths = 0;
    runtime.treePath = async () => { paths++; throw new Error('should not read a new proof path'); };
    await assert.rejects(runtime.prepareWithdrawal('escape', destination, { expectedNoteId: 7 }));
    assert.equal(paths, 0);
    assert.equal(runtime.runtime.preparedWithdrawal.ambiguousSubmissions.length, 1);
});

test('canceling an escape after an unknown retry cannot discard its original recovery history', async () => {
    const runtime = new BrowserWalletRuntime();
    runtime.manifest = { deployment_id: 'cancel-unknown-escape' };
    runtime.runtime = { state: { note_id: 7 }, preparedWithdrawal: {
        operationId: 'escape-7', noteId: 7, destination, mode: 'escape', phase: 'prepared',
        clearanceReserved: false, ambiguousSubmissions: [{ submissionId: 'unknown-wallet-prompt' }]
    }, lateWithdrawalAttempts: [] };
    runtime.reload = async () => {};
    let commits = 0;
    runtime.commit = async next => { commits++; runtime.runtime = next; };
    await assert.rejects(runtime.clearPreparedWithdrawal());
    assert.equal(commits, 0);
    assert.equal(runtime.runtime.preparedWithdrawal.ambiguousSubmissions.length, 1);
});

for (const [field, value] of [['operationId', 'different-operation'], ['noteId', 8],
    ['mode', 'mutual'], ['destination', `0x${'56'.repeat(20)}`]]) {
    test(`claiming a withdrawal rejects a changed ${field} after its calldata was prepared`, async () => {
        const expected = { operationId: 'prepared-escape', noteId: 7, mode: 'escape', destination };
        const durable = { state: { note_id: 7 }, preparedWithdrawal: { ...expected, phase: 'prepared', [field]: value } };
        const runtime = new BrowserWalletRuntime();
        runtime.manifest = { deployment_id: 'claim-encoded-withdrawal' };
        runtime.runtime = { state: { note_id: 7 }, preparedWithdrawal: { ...expected, phase: 'prepared' } };
        runtime.reload = async () => { runtime.runtime = structuredClone(durable); };
        let commits = 0;
        runtime.commit = async next => { commits++; runtime.runtime = next; };
        await assert.rejects(runtime.claimPreparedWithdrawalSubmission(expected));
        assert.equal(commits, 0, 'a mismatched plan must never acquire a wallet submission claim');
        assert.deepEqual(runtime.runtime, durable, 'the concurrent operation stays intact');
    });
}

function ambiguousReproofHarness(mode) {
    let activeRoot = '1';
    let interruptClearance = false;
    let durable = { deploymentId: `reproof-${mode}`, state: { note_id: 7, current_balance: 100 },
        journal: null, lease: null, lateWithdrawalAttempts: [], preparedWithdrawal: {
            operationId: 'original-withdrawal', noteId: 7, destination, mode, phase: 'prepared',
            clearanceReserved: mode === 'mutual', withdrawalNullifier: '2', proof: 'original-proof',
            public_inputs: { note_id: 7, active_root: activeRoot, final_balance: 100, withdrawal_nullifier: '2' }
        } };
    const commits = [];
    const newPage = () => {
        const runtime = new BrowserWalletRuntime();
        runtime.manifest = { deployment_id: durable.deploymentId };
        runtime.config = { funding: { protocol_server_url: 'https://protocol.invalid', chain_id: 1,
            contract_address: `0x${'34'.repeat(20)}` }, wallet_core: {}, proving_keys: { withdrawal: {} } };
        runtime.runtime = structuredClone(durable);
        runtime.init = async () => {};
        runtime.settleActiveLease = async () => {};
        runtime.recoverPendingLocked = async () => {};
        runtime.reload = async () => { runtime.runtime = structuredClone(durable); };
        runtime.commit = async next => {
            durable = structuredClone(next);
            runtime.runtime = structuredClone(next);
            commits.push(structuredClone(next.preparedWithdrawal));
        };
        runtime.treePath = async () => ({ active_root: activeRoot, siblings: [] });
        runtime.remoteJson = async () => {
            if (interruptClearance) throw new Error('page closed during replacement clearance');
            return { signature: 'clearance' };
        };
        runtime.worker = { call: async (method, payload) => {
            if (method === 'withdrawalNullifier') return '2';
            return { mode: payload.args.mode, proof: 'regenerated-proof', public_inputs: {
                note_id: 7, active_root: payload.args.active_root, final_balance: 100, withdrawal_nullifier: '2'
            } };
        } };
        return runtime;
    };
    return { newPage, commits, snapshot: () => structuredClone(durable),
        changeRoot: () => { activeRoot = '3'; }, interrupt: value => { interruptClearance = value; } };
}

for (const mode of ['mutual', 'escape']) {
    test(`same-mode ${mode} reproof and a rejected retry preserve the original unknown wallet request`, async () => {
        const fixture = ambiguousReproofHarness(mode);
        const runtime = fixture.newPage();
        const original = await runtime.claimPreparedWithdrawalSubmission();
        await runtime.markPreparedWithdrawalAmbiguous(original);
        await runtime.authorizePreparedWithdrawalRetry();
        const history = fixture.snapshot().preparedWithdrawal.ambiguousSubmissions;
        fixture.changeRoot();
        fixture.commits.length = 0;
        await runtime.prepareWithdrawal(mode, destination, { expectedNoteId: 7 });
        assert.equal(fixture.snapshot().preparedWithdrawal.proof, 'regenerated-proof', 'normal same-mode retry can still refresh its proof');
        for (const plan of fixture.commits) {
            assert.deepEqual(plan.ambiguousSubmissions, history, 'every reservation and proof commit retains old request ownership');
        }
        const replacement = await runtime.claimPreparedWithdrawalSubmission();
        await runtime.markPreparedWithdrawalRetryable(null, replacement);
        assert.deepEqual(fixture.snapshot().preparedWithdrawal.ambiguousSubmissions, history);
        if (mode === 'mutual') {
            await assert.rejects(runtime.prepareWithdrawal('escape', destination, {
                expectedNoteId: 7, expectedWithdrawalOperationId: original.operationId
            }));
        } else {
            await assert.rejects(runtime.clearPreparedWithdrawal());
        }
        assert.deepEqual(fixture.snapshot().preparedWithdrawal.ambiguousSubmissions, history);
    });
}

test('closing during a replacement mutual reservation retains ambiguity through reload and eventual reproof', async () => {
    const fixture = ambiguousReproofHarness('mutual');
    const runtime = fixture.newPage();
    const original = await runtime.claimPreparedWithdrawalSubmission();
    await runtime.markPreparedWithdrawalAmbiguous(original);
    await runtime.authorizePreparedWithdrawalRetry();
    const history = fixture.snapshot().preparedWithdrawal.ambiguousSubmissions;
    fixture.changeRoot();
    fixture.interrupt(true);
    await assert.rejects(runtime.prepareWithdrawal('mutual', destination, { expectedNoteId: 7 }), /page closed/);
    assert.equal(fixture.snapshot().preparedWithdrawal.phase, 'reserving');
    assert.deepEqual(fixture.snapshot().preparedWithdrawal.ambiguousSubmissions, history);
    const reloaded = fixture.newPage();
    await assert.rejects(reloaded.prepareWithdrawal('escape', destination, {
        expectedNoteId: 7, expectedWithdrawalOperationId: original.operationId
    }));
    fixture.interrupt(false);
    await reloaded.prepareWithdrawal('mutual', destination, { expectedNoteId: 7 });
    assert.equal(fixture.snapshot().preparedWithdrawal.phase, 'prepared');
    assert.deepEqual(fixture.snapshot().preparedWithdrawal.ambiguousSubmissions, history);
});
