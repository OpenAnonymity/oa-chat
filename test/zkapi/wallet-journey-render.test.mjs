import test from 'node:test';
import assert from 'node:assert/strict';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import AccountModal from '../../chat/zkapi/components/AccountModal.js';
import { deriveZkapiUxState } from '../../chat/zkapi/services/zkapiUxState.mjs';

function modalWith(config, extra = {}) {
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, { view: 'withdraw', busy: false, status: '', statusError: false, withdrawMode: 'mutual',
        journeyKind: null, journeyLast: null, privateBalanceHelpOpen: {},
        overlay: { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] }, ...extra });
    modal.escapeHtml = value => String(value ?? '');
    return modal;
}
const note = { note_id: 7, deposit_amount: 2_000_000, current_balance: 1_780_000, expiry_ts: Math.floor(Date.now() / 1000) + 86400 };

for (const failureKind of ['receipt', 'indexer', 'reverted', 'mismatch']) {
    test(`deposit ${failureKind} interruption keeps truthful activity status and SDK recovery unchanged`, async t => {
        const original = { wallet: zkapiClient.wallet, config: zkapiClient.config };
        const plan = { phase: 'submitted', operation_id: 'saved-operation', amount: 4_000_000 };
        Object.assign(zkapiClient, { wallet: { note: null }, config: { funding: {}, pending_deposit: plan } });
        t.after(() => Object.assign(zkapiClient, original));
        const changes = [];
        const failures = [];
        t.mock.method(zkapiClient, 'beginActivity', () => 'deposit-activity');
        t.mock.method(zkapiClient, 'updateActivity', (id, value) => { changes.push(value); });
        t.mock.method(zkapiClient, 'completeActivity', () => assert.fail('An interrupted deposit cannot claim success'));
        t.mock.method(zkapiClient, 'failActivity', (id, error) => { failures.push(error); });
        const error = failureKind === 'indexer' ? Object.assign(new Error('Indexer catching up'), { code: 'indexer_root_lag' })
            : failureKind === 'mismatch' ? new Error('The mined deposit did not match this browser’s durable private note.')
                : Object.assign(new Error(failureKind === 'reverted' ? 'Transaction reverted.' : 'RPC connection lost'), {
                    broadcastPossible: true, transactionStage: 'receipt',
                    ...(failureKind === 'reverted' ? { transactionReceipt: { status: '0x0' } } : {})
                });
        const modal = modalWith({}, { view: 'balance', render() {} });
        let calls = 0;
        await modal.run(async () => { calls++; throw error; }, { kind: 'deposit', title: 'Adding funds' });
        assert.equal(calls, 1);
        assert.equal(zkapiClient.config.pending_deposit, plan);
        if (['receipt', 'indexer'].includes(failureKind)) {
            assert.equal(modal.outcome.tone, 'info');
            assert.equal(modal.statusError, false);
            assert.equal(failures.length, 0);
            assert.equal(changes.at(-1).status, 'pending');
            assert.equal(changes.at(-1).error, null);
            assert.equal(changes.at(-1).blocksSend, false, 'Activity ends; SDK recovery still controls eligibility');
            const ux = deriveZkapiUxState({ snapshot: { wallet: { note: null }, config: zkapiClient.config,
                activities: [{ kind: 'deposit', ...changes.at(-1) }] } });
            assert.notEqual(ux.balancePrimary.tone, 'error');
            assert.notEqual(ux.balancePrimary.phase, 'ready', 'Recovery remains pending in the shared UI');
        } else {
            assert.equal(modal.outcome.tone, 'error');
            assert.equal(modal.statusError, true);
            assert.deepEqual(failures, [error]);
        }
    });
}

test('while a withdrawal runs, the form folds to its method and the steps follow the status line', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals, lastError: zkapiClient.lastError };
    Object.assign(zkapiClient, { wallet: { note }, config: {}, withdrawal: null, withdrawals: [], lastError: null });
    try {
        const modal = modalWith({}, { busy: true, journeyKind: 'withdraw', status: 'Confirm the mutual close in MetaMask…' });
        const html = modal.renderWithdrawal();
        assert.match(html, /zkapi-meta">To your MetaMask account · Mutual close/);
        assert.doesNotMatch(html, /zkapi-withdraw-confirm|name="zkapi-withdraw-mode"/);
        assert.match(html, /data-zkapi-journey data-kind="withdraw"/);
        assert.match(html, /data-step="proof" data-state="complete"/);
        assert.match(html, /data-step="wallet" data-state="waiting" aria-current="step"/);
        assert.match(html, /data-step="chain" data-state="upcoming"/);
        assert.match(html, /Confirm your withdrawal in MetaMask/);
        assert.match(html, /Approve the transaction in MetaMask\./);
        assert.match(html, /data-zkapi-busy-label>Waiting for MetaMask…/, 'the busy action says what it waits for');
        assert.doesNotMatch(html, /zkapi-progress-text/);
    } finally { Object.assign(zkapiClient, original); }
});

test('after a reload a prepared withdrawal draws the same steps from its persisted phase, with the notice on the current step', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals, lastError: zkapiClient.lastError };
    Object.assign(zkapiClient, { wallet: { note }, config: { prepared_withdrawal: { phase: 'awaiting_wallet', mode: 'mutual' } }, withdrawal: null, withdrawals: [], lastError: null });
    try {
        const html = modalWith().renderWithdrawal();
        assert.match(html, /data-step="proof" data-state="complete"/);
        assert.match(html, /data-step="wallet" data-state="waiting"/);
        assert.match(html, /MetaMask may still be open\. Check it, or recover the request/);
        assert.match(html, /Recover withdrawal/);
        assert.match(html, /id="zkapi-recover-withdrawal-btn"/);
        assert.match(html, /id="zkapi-sync-withdrawal-btn" class="zkapi-primary-button"/);

        zkapiClient.config = { prepared_withdrawal: { phase: 'submitted', mode: 'mutual', transaction_hash: '0xabc' } };
        const submitted = modalWith().renderWithdrawal();
        assert.match(submitted, /data-step="chain" data-state="active"/);
        assert.match(submitted, /Ethereum confirmation/);
        assert.match(submitted, /Your withdrawal has been submitted and is waiting to be confirmed on Ethereum\./);
        assert.match(submitted, /id="zkapi-sync-withdrawal-btn" class="zkapi-quiet-button"[^>]*>Check now/, 'a submitted withdrawal resolves itself; the check is a quiet fallback');

        zkapiClient.config = { prepared_withdrawal: { phase: 'ambiguous', mode: 'mutual' } };
        const unknown = modalWith().renderWithdrawal();
        assert.match(unknown, /whether your withdrawal went through/);
        assert.doesNotMatch(unknown, /whether your deposit went through/);

        zkapiClient.config = { prepared_withdrawal: { phase: 'prepared', mode: 'mutual' } };
        const ready = modalWith().renderWithdrawal();
        assert.match(ready, /data-step="proof" data-state="complete"/);
        assert.match(ready, /id="zkapi-withdraw-btn" class="zkapi-primary-button" type="button" disabled>Continue in MetaMask/);
        assert.doesNotMatch(ready, /id="zkapi-park-withdrawal-btn"/, "withdrawal recovery does not offer set aside");
    } finally { Object.assign(zkapiClient, original); }
});

test('a deposit in flight shows its steps under the figure; a persisted pending deposit shows them with its actions', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals, lastError: zkapiClient.lastError };
    Object.assign(zkapiClient, { wallet: { note: null }, config: { funding: {} }, withdrawal: null, withdrawals: [], lastError: null });
    try {
        const busy = modalWith({}, { view: 'balance', busy: true, journeyKind: 'deposit', status: 'Approving USDC… confirm in MetaMask.' });
        const html = busy.renderBalance();
        assert.match(html, /data-zkapi-journey data-kind="deposit"/);
        assert.match(html, /data-step="connect" data-state="complete"/);
        assert.match(html, /data-step="approve" data-state="waiting"/);
        assert.doesNotMatch(html, /id="zkapi-deposit-btn"/);

        zkapiClient.config = { funding: {}, pending_deposit: { phase: 'submitted', amount: 4_000_000 } };
        const pending = modalWith({}, { view: 'balance' }).renderBalance();
        assert.match(pending, /data-step="deposit" data-state="complete"/);
        assert.match(pending, /data-step="chain" data-state="active"/);
        assert.match(pending, /Ethereum confirmation/);
        assert.match(pending, /Your deposit has been submitted and is waiting to be confirmed on Ethereum\./);
        assert.match(pending, /id="zkapi-check-deposit-btn" class="zkapi-quiet-button"[^>]*>Check payment status/, 'a submitted deposit resolves itself; the check is a quiet fallback');

        zkapiClient.config = { funding: {}, pending_deposit: { phase: 'ambiguous', amount: 4_000_000 } };
        const ambiguous = modalWith({}, { view: 'balance' }).renderBalance();
        assert.match(ambiguous, /id="zkapi-check-deposit-btn" class="zkapi-primary-button"[^>]*>Check payment status/, 'an unknown outcome still asks for a check');
        assert.match(ambiguous, /Deposit status unknown/);
        assert.match(ambiguous, /id="zkapi-retry-deposit-btn" class="zkapi-secondary-button"[^>]*>Try again in MetaMask/);
        assert.match(ambiguous, /whether your deposit went through/);
    } finally { Object.assign(zkapiClient, original); }
});

test('a canceled MetaMask prompt is said in the dialog, on the step it stopped at, not as a toast', async t => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals, lastError: zkapiClient.lastError };
    Object.assign(zkapiClient, { wallet: { note }, config: { prepared_withdrawal: { phase: 'prepared', mode: 'mutual' } }, withdrawal: null, withdrawals: [], lastError: null });
    const toasts = [];
    const modal = modalWith({}, { app: { showToast: (...args) => toasts.push(args) } });
    modal.render = function () { this.rendered = this.renderWithdrawal(); };
    t.mock.method(zkapiClient, 'beginActivity', () => 'a1');
    t.mock.method(zkapiClient, 'cancelActivity', () => {});
    try {
        await modal.run(async report => { report('Confirm the mutual close in MetaMask…'); throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }, { kind: 'withdraw', title: 'Returning your balance' });
        assert.deepEqual(toasts, []);
        assert.equal(modal.outcome.tone, 'info');
        assert.match(modal.rendered, /data-step="wallet" data-state="paused"/, 'nothing was submitted: the persisted phase is still prepared');
        assert.match(modal.rendered, /Withdrawal canceled\./);
        assert.match(modal.rendered, /id="zkapi-withdraw-btn"[^>]*>Continue in MetaMask/);
    } finally { Object.assign(zkapiClient, original); }
});

test('a canceled deposit retains any recovery plan that could not safely be cleared', async t => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals, lastError: zkapiClient.lastError };
    Object.assign(zkapiClient, { wallet: { note: null }, config: { funding: {}, pending_deposit: { phase: 'prepared', amount: 2_000_000 } }, withdrawal: null, withdrawals: [], lastError: null });
    const modal = modalWith({}, { view: 'balance', app: { showToast: () => {} } });
    modal.renderWithdrawalStatusLink = () => '';
    modal.render = function () { this.rendered = this.renderBalance(); };
    t.mock.method(zkapiClient, 'beginActivity', () => 'a1');
    t.mock.method(zkapiClient, 'cancelActivity', () => {});
    try {
        // Found after a reload: the saved plan, and how to pick it up.
        const saved = modal.renderBalance();
        assert.match(saved, /Saved deposit/);
        assert.match(saved, /Before resuming, check MetaMask for a pending transaction\./);
        assert.match(saved, /Resume with MetaMask/);
        assert.doesNotMatch(saved, /Deposit canceled/);

        await modal.run(async report => { report('Confirm the deposit in MetaMask…'); throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }, { kind: 'deposit', title: 'Adding your balance' });
        assert.equal(modal.outcome.canceled, true);
        assert.match(modal.rendered, /Deposit canceled\./);
        assert.match(modal.rendered, /Saved deposit/);
        assert.doesNotMatch(modal.rendered, /Saved in this browser/);
        assert.doesNotMatch(modal.rendered, /Try again with Ethereum wallet/);
        assert.match(modal.rendered, /Resume with MetaMask/);
    } finally { Object.assign(zkapiClient, original); }
});

test('a deposit keeps one page from its first step to its confirmation', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals, lastError: zkapiClient.lastError };
    Object.assign(zkapiClient, { wallet: { note: null }, config: { funding: {}, pending_deposit: { phase: 'prepared', amount: 4_000_000 } }, withdrawal: null, withdrawals: [], lastError: null });
    try {
        const modal = modalWith({}, { view: 'fund', busy: true, journeyKind: 'deposit', status: 'Depositing into the private-note vault… confirm in MetaMask.', isOpen: true });
        assert.equal(modal.depositInMotion(), true);
        const running = modal.dialogMarkup();
        assert.match(running, /aria-label="Deposit in progress"/);
        assert.match(running, /<p class="zkapi-balance-caption">Deposit<\/p>/);
        assert.match(running, /data-zkapi-journey data-kind="deposit"/);
        assert.match(running, /data-step="deposit" data-state="waiting"/);
        assert.match(running, /class="zkapi-funding-wait zkapi-deposit-wait" role="status">[^]*data-zkapi-deposit-wait>Confirm the deposit in MetaMask</, 'a quiet line names the current step');
        assert.doesNotMatch(running, /zkapi-deposit-dismiss-btn|<button class="zkapi-primary-button" type="button" disabled>|Saved in this browser/, 'no dead button or Close while it runs');
        assert.doesNotMatch(running, /data-wallet-method|data-funding-amount|id="zkapi-deposit-btn"|zkapi-progress/, 'no amount field, method switch or loose status line while it runs');
        assert.equal(modal.pageKey(), 'deposit-progress');

        zkapiClient.config = { funding: {}, pending_deposit: { phase: 'submitted', amount: 4_000_000 } };
        modal.status = 'Deposit submitted 0xabc… waiting for confirmation…';
        const submitted = modal.dialogMarkup();
        assert.match(submitted, /aria-label="Deposit in progress"/);
        assert.match(submitted, /data-step="chain" data-state="active"/);
        assert.match(submitted, /data-zkapi-deposit-wait>Waiting for Ethereum · usually under a minute</);
        assert.equal(modal.pageKey(), 'deposit-progress', 'the SDK saving it does not change the page');

        modal.busy = false;
        modal.journeyKind = null;
        zkapiClient.config = { funding: {} };
        assert.notEqual(modal.pageKey(), 'deposit-progress');
        assert.equal(modal.depositInMotion(), false);
    } finally { Object.assign(zkapiClient, original); }
});

for (const code of ['address_insufficient_eth', 'address_fee_data', 'address_fee_quote_changed']) {
    test(`a deposit stopped by ${code} keeps its explanation and saved plan`, async t => {
        const original = { wallet: zkapiClient.wallet, config: zkapiClient.config };
        const plan = { phase: 'prepared', operation_id: 'saved-operation', amount: 4_000_000 };
        Object.assign(zkapiClient, { wallet: { note: null }, config: { funding: {}, pending_deposit: plan } });
        t.after(() => Object.assign(zkapiClient, original));
        const changes = [];
        t.mock.method(zkapiClient, 'beginActivity', () => 'deposit-activity');
        t.mock.method(zkapiClient, 'updateActivity', (id, value) => changes.push(value));
        t.mock.method(zkapiClient, 'completeActivity', () => assert.fail('A deposit that was not sent cannot succeed'));
        const modal = modalWith({}, { view: 'balance', render() {} });
        await modal.run(async () => { throw Object.assign(new Error('Provider error'), { addressCode: code }); }, { kind: 'deposit' });
        assert.match(modal.outcome.message, /^Deposit not sent\./);
        assert.match(modal.outcome.message, /then try again/);
        assert.equal(modal.outcome.tone, 'info');
        assert.equal(modal.outcomeTimer, null, 'the explanation does not disappear on a timer');
        assert.match(modal.renderOutcome(), /Deposit not sent/);
        assert.equal(changes.at(-1).title, 'Review deposit funding');
        assert.equal(zkapiClient.config.pending_deposit, plan);
    });
}

test('the running modal uses the durable deposit phase during status checks', t => {
    const original = zkapiClient.config;
    t.after(() => { zkapiClient.config = original; });
    const modal = modalWith({}, { journeyKind: 'deposit' });
    zkapiClient.config = { pending_deposit: { phase: 'prepared' } };
    assert.equal(modal.currentJourney('deposit', { message: 'Checking the private-vault deposit…' }).position.step, 'connect');
    zkapiClient.config.pending_deposit.phase = 'submitted';
    assert.equal(modal.currentJourney('deposit', { message: 'Checking the private-vault deposit…' }).position.step, 'chain');
});

test('Ethereum wallet deposits show the transfer rows, then one button', async () => {
    const { getWalletMethod, setWalletMethod } = await import('../../chat/zkapi/services/walletMethod.mjs');
    const method = getWalletMethod();
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals, lastError: zkapiClient.lastError };
    Object.assign(zkapiClient, { wallet: { note: null }, config: { funding: { billing_asset: 'native_eth', chain_id: 1 } }, withdrawal: null, withdrawals: [], lastError: null });
    setWalletMethod('metamask');
    try {
        const modal = modalWith({}, { view: 'fund', isOpen: true });
        const html = modal.renderBalance();
        assert.equal(zkapiClient.isNativeEthFunding, true, "fixture is a native ETH deployment");
        assert.match(html, /data-metamask-transfer/);
        for (const label of ['Deposit', 'Network fee', 'From', 'Network']) assert.match(html, new RegExp(`zkapi-transfer-label">${label}<`));
        assert.match(html, /Shown in Ethereum wallet/);
        assert.match(html, /Your Ethereum wallet account/);
        assert.match(html, /id="zkapi-deposit-btn" class="zkapi-primary-button w-full"[^>]*>Continue with Ethereum wallet</);
    } finally { Object.assign(zkapiClient, original); setWalletMethod(method); }
});
