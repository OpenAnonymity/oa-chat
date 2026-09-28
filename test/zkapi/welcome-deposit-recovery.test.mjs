import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { isIndexerLag, pendingDepositMessage, zkapiErrorMessage } from '../../chat/zkapi/services/zkapiErrorCopy.mjs';

const source = fs.readFileSync(new URL('../../chat/zkapi/components/WelcomePanel.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class WelcomePanel', 'class WelcomePanel');

function fixture(method, phase) {
    const actions = [];
    const client = {
        suggestedDeposit: 10,
        isNativeEthFunding: true,
        config: { pending_deposit: { phase, amount: '4000000' } },
        formatMoney: amount => { assert.equal(amount, '4000000'); return '$12.00'; },
        deposit() { assert.fail('Opening saved progress cannot submit a deposit'); },
        quoteDepositUsd() { assert.fail('A saved deposit must never be repriced'); }
    };
    const context = {
        isIndexerLag, pendingDepositMessage, zkapiErrorMessage,
        zkapiClient: client,
        addressFundingWallet: { pending: null },
        getWalletMethod: () => method,
        walletMethodText: value => value,
        renderDepositAmount: () => '', prepareDepositAmount: async () => '0.005', renderWalletMethod: () => '', renderFundingAccount: () => '', fundingSetupGuide: () => '',
        stopFundingFlow() {},
        prepareWalletMethod() { assert.fail('Opening saved progress cannot request wallet access'); }
    };
    const WelcomePanel = vm.runInNewContext(`${source}\nWelcomePanel;`, context);
    const welcome = Object.create(WelcomePanel.prototype);
    Object.assign(welcome, {
        busy: false, fundingBusy: false, escapeHtml: String,
        close() { actions.push('close'); },
        app: { accountModal: { openFunding() { actions.push('open-funding'); } } }
    });
    return { welcome, actions, client, context };
}

for (const failureKind of ['receipt', 'indexer', 'reverted', 'mismatch']) {
    test(`Welcome preserves the saved deposit and correctly presents ${failureKind} interruption`, async () => {
        const { welcome, client, context, actions } = fixture('metamask', null);
        client.config.pending_deposit = null;
        client.quoteDepositUsd = async () => ({ ethAmount: '0.005' });
        context.prepareWalletMethod = async () => {};
        const plan = { phase: 'submitted', amount: '4000000', operation_id: 'original-operation' };
        const error = failureKind === 'indexer' ? Object.assign(new Error('Indexer catching up'), { code: 'indexer_root_lag' })
            : failureKind === 'mismatch' ? new Error('The mined deposit did not match this browser’s durable private note.')
                : Object.assign(new Error(failureKind === 'reverted' ? 'Transaction reverted.' : 'RPC connection lost'), {
                    broadcastPossible: true, transactionStage: 'receipt',
                    ...(failureKind === 'reverted' ? { transactionReceipt: { status: '0x0' } } : {})
                });
        let calls = 0;
        client.deposit = async () => { calls++; client.config.pending_deposit = plan; throw error; };
        Object.assign(welcome, { overlay: { querySelector: () => ({ value: '10' }) }, render() {} });
        await welcome.fund();
        assert.equal(calls, 1);
        assert.equal(client.config.pending_deposit, plan, 'Presentation never modifies the SDK recovery plan');
        assert.deepEqual(actions, [], 'Failure never automatically resubmits or opens a wallet');
        const html = welcome.renderWelcome();
        assert.match(html, /Continue saved deposit/);
        assert.doesNotMatch(html, /id="welcome-fund-btn"/);
        if (['receipt', 'indexer'].includes(failureKind)) {
            assert.equal(welcome.error, '');
            assert.ok(welcome.notice);
            assert.match(html, /role="status"/);
            assert.doesNotMatch(html, /text-destructive/);
        } else {
            assert.equal(welcome.notice, '');
            assert.equal(welcome.error, error.message);
            assert.match(html, /text-destructive/);
        }
    });
}

for (const method of ['address', 'metamask']) {
    test(`Welcome passes the prepared operation only for a new ${method} deposit`, async () => {
        const { welcome, client, context } = fixture(method, null);
        const calls = [];
        client.config.pending_deposit = null;
        client.quoteDepositUsd = async amount => { assert.equal(amount, '10'); return { ethAmount: '0.005' }; };
        client.deposit = async (...args) => { calls.push(args); };
        context.prepareWalletMethod = async () => {};
        context.runAddressAction = async (owner, details, report, action) => {
            assert.equal(details.kind, 'deposit');
            owner.fundingDepositIntent = { ethAmount: '0.005', preparedOperationId: 'quoted-deposit-operation' };
            await action();
        };
        let completed = 0;
        Object.assign(welcome, { overlay: { querySelector: () => ({ value: '10' }) },
            render() {}, fundingFlow: { complete: async () => { completed++; } } });
        await welcome.fund();
        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], '0.005');
        assert.equal(typeof calls[0][1], 'function');
        if (method === 'address') {
            assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), { preparedOperationId: 'quoted-deposit-operation' });
        } else assert.equal(calls[0].length, 2, 'MetaMask call signature stays unchanged');
        assert.equal(completed, 1);
        assert.equal(welcome.step, 'success');
    });
}

for (const method of ['address', 'metamask']) {
    for (const phase of ['prepared', 'retry_exact', 'submitted', 'awaiting_wallet', 'ambiguous']) {
        test(`Welcome keeps ${method} ${phase} recovery reachable without changing or submitting the saved amount`, async () => {
            const { welcome, actions } = fixture(method, phase);
            const html = welcome.renderWelcome();
            assert.match(html, /Saved deposit: \$12\.00/);
            assert.match(html, /id="welcome-resume-deposit-btn"/);
            assert.doesNotMatch(html, /id="welcome-deposit-amount"|id="welcome-fund-btn"/);
            assert.deepEqual(actions, [], 'Rendering is read-only');
            // Also cover a pending plan appearing after the ordinary Next button
            // was rendered: its existing click handler must hand off recovery.
            await welcome.fund();
            assert.deepEqual(actions, ['close', 'open-funding']);
        });
    }
}

for (const method of ['address', 'metamask']) {
    test(`Welcome keeps a confirmed ${method} deposit successful while its exact balance refresh is pending`, async () => {
        const { welcome, client, context } = fixture(method, null);
        client.config.pending_deposit = null;
        client.quoteDepositUsd = async () => ({ ethAmount: '0.005' });
        context.prepareWalletMethod = async () => {};
        let deposits = 0;
        const result = { status: 'confirmed', balanceRefreshPending: true, noteId: 7, amount: 4_000_000 };
        client.deposit = async () => { deposits++; return result; };
        context.runAddressAction = async (owner, details, report, action) => {
            owner.fundingDepositIntent = { ethAmount: '0.005', preparedOperationId: 'operation' };
            return action();
        };
        let handedOff;
        welcome.app.accountModal.recordDepositConfirmation = value => { handedOff = value; };
        Object.assign(welcome, { overlay: { querySelector: () => ({ value: '10' }) }, render() {} });
        await welcome.fund();
        assert.equal(welcome.step, 'success');
        assert.equal(welcome.error, '');
        assert.equal(handedOff, result, 'opening Private balance retains the same pending projection');
        assert.match(welcome.renderSuccess(), /Deposit confirmed|Refreshing your private balance/);
        assert.doesNotMatch(welcome.renderSuccess(), /ready to chat|Start chatting|Private balance:|\$0/);
        client.note = { note_id: 6, current_balance: '4000000' };
        assert.match(welcome.renderSuccess(), /Refreshing your private balance/);
        assert.equal(welcome.depositBalanceRefreshPending, true, 'an unrelated note cannot clear the outcome');
        await welcome.fund();
        assert.equal(deposits, 1, 'a pending projection never permits rebroadcast');
        client.note = { note_id: 7, current_balance: '4000000' };
        assert.match(welcome.renderSuccess(), /You’re ready to chat/);
        assert.match(welcome.renderSuccess(), /\$12\.00/);
        assert.equal(welcome.depositBalanceRefreshPending, false);
    });
}

test('Welcome rerenders the success view when the exact confirmed note becomes available', () => {
    const { client, context } = fixture('metamask', null);
    let notify;
    client.subscribe = fn => { notify = fn; return () => {}; };
    context.document = { getElementById: () => null };
    context.addressFundingWallet.subscribe = () => () => {};
    context.subscribeWalletMethod = () => () => {};
    const Panel = vm.runInNewContext(`${source}\nWelcomePanel;`, { ...context });
    const panel = new Panel({});
    let renders = 0;
    Object.assign(panel, { isOpen: true, step: 'success', depositBalanceRefreshPending: true,
        confirmedDepositNoteId: 7, render() { renders++; } });
    client.hasNote = true;
    client.note = { note_id: 6 };
    notify({}, { reason: 'runtime' });
    assert.equal(renders, 0);
    client.note = { note_id: 7 };
    notify({}, { reason: 'runtime' });
    assert.equal(renders, 1);
    assert.equal(panel.depositBalanceRefreshPending, false);
});
