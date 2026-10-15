import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWalletRuntime } from '@openanonymity/zkapi-browser-sdk/runtime';
import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import * as walletStore from '@openanonymity/zkapi-browser-sdk/store';
import * as withdrawalRecovery from '../../chat/zkapi/services/withdrawalRecovery.mjs';
import { availableWithdrawalEscape, canCancelPreparedWithdrawal, sameWithdrawalEscape, assertWithdrawalEscapeAvailable } from '../../chat/zkapi/services/withdrawalRecovery.mjs';
import { createFakeEnvironment, createFakeStorage } from './_fakeIndexedDb.mjs';

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

// ---------------------------------------------------------------------------
// The note-only recheck: what the person looked at is still what is held
// ---------------------------------------------------------------------------
//
// {kind: 'note', noteId, operationId|null} is the identity of a withdrawal
// about to start, in any mode and phase. It runs beside the strict identity
// check above, which the cases earlier in this file pin unchanged.

function noteFixture({ slotNote = 7, clientNote = 7, plan = { operationId: 'op-shown', noteId: 7, mode: 'mutual', phase: 'prepared' } } = {}) {
    const events = [];
    let locked = false;
    const runtime = {
        manifest: { deployment_id: 'recheck' },
        runtime: { state: slotNote === null ? null : { note_id: slotNote }, preparedWithdrawal: plan, lateWithdrawalAttempts: [] },
        async init() { events.push('init'); },
        preemptForExit(options) { events.push(['preempt', options]); },
        async reload() { assert.equal(locked, true, 'reload under the wallet lock'); events.push('reload'); }
    };
    const client = { browserMode: true, note: clientNote === null ? null : { note_id: clientNote }, config: { prepared_withdrawal: null } };
    const withWalletLock = async (deployment, operation) => {
        assert.equal(deployment, 'recheck');
        locked = true;
        events.push('lock');
        try { return await operation(); } finally { locked = false; events.push('unlock'); }
    };
    return { client, runtime, withWalletLock, events };
}

const CHANGED = { code: 'withdrawal_note_changed' };

test('wiring:withdrawal-operation-recheck the note and the prepared operation are checked after init, under the lock, on a fresh read', async () => {
    const context = noteFixture();
    await assertWithdrawalEscapeAvailable({ kind: 'note', noteId: 7, operationId: 'op-shown' }, context);
    // Pre-emption first (so nothing queues ahead of the exit), then the lock.
    assert.deepEqual(context.events, ['init', ['preempt', { requests: true }], 'lock', 'reload', 'unlock']);
    // The operation is optional: with none named only the note is bound.
    const bare = noteFixture({ plan: null });
    await assertWithdrawalEscapeAvailable({ kind: 'note', noteId: 7, operationId: null }, bare);
    await assertWithdrawalEscapeAvailable({ kind: 'note', noteId: '7' }, noteFixture());
    // Any mode and phase of the named plan is the same operation.
    for (const plan of [{ operationId: 'op-shown', mode: 'escape', phase: 'submitted' },
        { operationId: 'op-shown', mode: 'escape', phase: 'ambiguous', submissionId: 'wallet-prompt' }]) {
        await assertWithdrawalEscapeAvailable({ kind: 'note', noteId: 7, operationId: 'op-shown' }, noteFixture({ plan }));
    }
});

test('wiring:withdrawal-operation-recheck a changed note, client view or operation is refused', async () => {
    const refused = (label, options, expected) => assert.rejects(
        assertWithdrawalEscapeAvailable(expected, noteFixture(options)), CHANGED, label);
    await refused('another note in the slot', { slotNote: 8 }, { kind: 'note', noteId: 7, operationId: 'op-shown' });
    await refused('another note displayed', { clientNote: 8 }, { kind: 'note', noteId: 7, operationId: 'op-shown' });
    await refused('another note chosen', {}, { kind: 'note', noteId: 8, operationId: 'op-shown' });
    await refused('no note in the slot', { slotNote: null }, { kind: 'note', noteId: 7 });
    await refused('no note displayed', { clientNote: null }, { kind: 'note', noteId: 7 });
    await refused('another operation', { plan: { operationId: 'op-replaced', noteId: 7, mode: 'mutual', phase: 'prepared' } },
        { kind: 'note', noteId: 7, operationId: 'op-shown' });
    await refused('the operation is gone', { plan: null }, { kind: 'note', noteId: 7, operationId: 'op-shown' });
    // A missing id never reads as note 0.
    await refused('no id chosen', { slotNote: 0, clientNote: 0 }, { kind: 'note', noteId: null });
    await refused('no id at all', { slotNote: 0, clientNote: 0 }, { kind: 'note' });
    await refused('a fractional id', { slotNote: 7, clientNote: 7 }, { kind: 'note', noteId: 7.5 });
    await refused('an id that is not a number', { slotNote: 7, clientNote: 7 }, { kind: 'note', noteId: '7a' });
    await assertWithdrawalEscapeAvailable({ kind: 'note', noteId: 0 }, noteFixture({ slotNote: 0, clientNote: 0, plan: null }));
});

test('wiring:withdrawal-operation-recheck an id with nothing to compare never starts the SDK', async () => {
    const context = noteFixture();
    await assert.rejects(assertWithdrawalEscapeAvailable({ kind: 'note', noteId: undefined }, context), CHANGED);
    assert.deepEqual(context.events, []);
});

test('wiring:withdrawal-operation-recheck a runtime without pre-emption (the legacy SDK) is checked all the same', async () => {
    const context = noteFixture();
    delete context.runtime.preemptForExit;
    await assertWithdrawalEscapeAvailable({ kind: 'note', noteId: 7, operationId: 'op-shown' }, context);
    assert.deepEqual(context.events, ['init', 'lock', 'reload', 'unlock']);
});

test('wiring:withdrawal-operation-recheck the decision is made on what the re-read finds, not on what was displayed', async () => {
    const context = noteFixture();
    context.runtime.reload = async function reload() {
        // Another tab replaced the prepared withdrawal while this one waited.
        this.runtime = { ...this.runtime, preparedWithdrawal: { operationId: 'op-replaced', noteId: 7, mode: 'escape', phase: 'reserving' } };
    };
    await assert.rejects(assertWithdrawalEscapeAvailable({ kind: 'note', noteId: 7, operationId: 'op-shown' }, context), CHANGED);
});

test('the strict identity check is untouched and the note check is not reachable from it', async () => {
    // Without `kind` the original sequence runs: init, lock, reload, no pre-emption.
    const context = fixture();
    const events = [];
    let locked = false;
    context.runtime.init = async () => { events.push('init'); };
    context.runtime.preemptForExit = () => { events.push('preempt'); };
    context.runtime.reload = async () => { events.push(locked ? 'reload' : 'reload-outside'); };
    context.withWalletLock = async (_deployment, operation) => {
        locked = true;
        events.push('lock');
        try { return await operation(); } finally { locked = false; events.push('unlock'); }
    };
    const choice = availableWithdrawalEscape(context);
    // Reading the identity (and asking whether a plan can be cancelled) never
    // touches the runtime's lifecycle: no init, no lock, no pre-emption.
    canCancelPreparedWithdrawal(context);
    sameWithdrawalEscape(choice, choice);
    assert.deepEqual(events, []);
    await assertWithdrawalEscapeAvailable(choice, context);
    assert.deepEqual(events, ['init', 'lock', 'reload', 'unlock']);
    // An unsubmitted plan with a note-shaped expectation is not "the same
    // choice": a record without `kind` is only ever the strict identity.
    await assert.rejects(assertWithdrawalEscapeAvailable({ noteId: 7, operationId: 'withdraw-7' }, context), /saved withdrawal changed/);
    // The module's public surface is the one the dialog's import pin names.
    assert.deepEqual(Object.keys(withdrawalRecovery).sort(),
        ['assertEscapeReady', 'assertWithdrawalEscapeAvailable', 'availableWithdrawalEscape', 'canCancelPreparedWithdrawal',
            'escapeNeedsSettlement', 'sameWithdrawalEscape']);
    assert.equal(typeof canCancelPreparedWithdrawal, 'function');
});

test('wiring:withdrawal-operation-recheck over the real store and runtime: a replaced plan is caught under the lock', async t => {
    const env = createFakeEnvironment();
    const restore = env.install();
    const storage = globalThis.localStorage;
    globalThis.localStorage = createFakeStorage();
    t.after(async () => {
        await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase('zkapi-browser-wallet-v1');
            request.onsuccess = resolve;
            request.onerror = () => reject(request.error);
        });
        restore();
        globalThis.localStorage = storage;
    });
    const DEPLOYMENT = 'zkapi-native-eth-sepolia-concession-v1-recheck';
    const plan = (operationId, extra = {}) => ({ operationId, mode: 'mutual', phase: 'prepared', noteId: 7, destination,
        clearanceReserved: true, withdrawalNullifier: '0x2a', public_inputs: { note_id: 7, final_balance: 4_000_000, kind: 1 }, ...extra });
    const note = id => ({ note_id: id, current_balance: 4_000_000, deposit_amount: 5_000_000, expiry_ts: 1_900_000_000, secret: 'SECRET' });
    const slot = (id, preparedWithdrawal) => ({ version: 1, deploymentId: DEPLOYMENT, state: note(id), preparedWithdrawal });

    const runtime = new BrowserWalletRuntime();
    runtime.manifest = { deployment_id: DEPLOYMENT };
    runtime.init = async () => {};
    const client = { browserMode: true, note: { note_id: 7 }, config: {} };
    const deps = { client, runtime, withWalletLock: walletStore.withBrowserWalletLock };
    const expected = { kind: 'note', noteId: 7, operationId: 'op-displayed' };

    // The person looks at this plan...
    await walletStore.writeBrowserWallet(slot(7, plan('op-displayed')));
    await runtime.reload();
    env.trace.length = 0;
    await assertWithdrawalEscapeAvailable(expected, deps);
    assert.deepEqual(env.trace.map(entry => entry.type), ['lock-acquire', 'lock-release'], 'a read under the exclusive wallet lock, no write');

    // ...another tab cancels it and prepares another...
    await walletStore.writeBrowserWallet(slot(7, plan('op-replaced', { phase: 'reserving' })));
    await assert.rejects(assertWithdrawalEscapeAvailable(expected, deps), CHANGED);
    // ...which is fine when that is the one that was looked at.
    await assertWithdrawalEscapeAvailable({ ...expected, operationId: 'op-replaced' }, deps);

    // A successor note in the slot is another balance entirely.
    await walletStore.writeBrowserWallet(slot(8, null));
    await assert.rejects(assertWithdrawalEscapeAvailable({ kind: 'note', noteId: 7, operationId: null }, deps), CHANGED);

    // The check waits its turn: a plan replaced while it is queued behind
    // another tab's critical section is judged as it is when the lock comes.
    await walletStore.writeBrowserWallet(slot(7, plan('op-displayed')));
    await runtime.reload();
    let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    let entered;
    const inside = new Promise(resolve => { entered = resolve; });
    const other = walletStore.withBrowserWalletLock(DEPLOYMENT, async () => {
        entered();
        await gate;
        await walletStore.writeBrowserWallet(slot(7, plan('op-replaced')));
    });
    await inside;
    const waiting = assertWithdrawalEscapeAvailable(expected, deps);
    let settled = false;
    waiting.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(settled, false, 'it does not decide before the lock is its own');
    finish();
    await other;
    await assert.rejects(waiting, CHANGED);
});
