import test from 'node:test';
import assert from 'node:assert/strict';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import AccountModal from '../../chat/zkapi/components/AccountModal.js';

function modalWith(config, extra = {}) {
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, { view: 'withdraw', busy: false, status: '', statusError: false, withdrawMode: 'mutual',
        journeyKind: null, journeyLast: null, privateBalanceHelpOpen: {},
        overlay: { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] }, ...extra });
    modal.escapeHtml = value => String(value ?? '');
    return modal;
}
const note = { note_id: 7, deposit_amount: 2_000_000, current_balance: 1_780_000, expiry_ts: Math.floor(Date.now() / 1000) + 86400 };

test('while a withdrawal runs, the form folds to its method and the steps follow the status line', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals, lastError: zkapiClient.lastError };
    Object.assign(zkapiClient, { wallet: { note }, config: {}, withdrawal: null, withdrawals: [], lastError: null });
    try {
        const modal = modalWith({}, { busy: true, journeyKind: 'withdraw', status: 'Confirm the mutual close in MetaMask…' });
        const html = modal.renderWithdrawal();
        assert.match(html, /zkapi-summary-line">Withdraw your remaining balance and close this private balance\./);
        assert.doesNotMatch(html, /zkapi-withdraw-confirm|name="zkapi-withdraw-mode"/);
        assert.match(html, /data-zkapi-journey data-kind="withdraw"/);
        assert.match(html, /data-step="proof" data-state="complete"/);
        assert.match(html, /data-step="wallet" data-state="waiting" aria-current="step"/);
        assert.match(html, /data-step="chain" data-state="upcoming"/);
        assert.match(html, /Review the withdrawal and network fee\./);
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
        assert.match(html, /MetaMask may still be open in this or another tab\./);
        assert.match(html, /id="zkapi-recover-withdrawal-btn"/);
        assert.match(html, /id="zkapi-sync-withdrawal-btn"/);

        zkapiClient.config = { prepared_withdrawal: { phase: 'prepared', mode: 'mutual' } };
        const ready = modalWith().renderWithdrawal();
        assert.match(ready, /data-step="proof" data-state="complete"/);
        assert.match(ready, /id="zkapi-withdraw-btn" class="zkapi-primary-button" type="button" >Continue in MetaMask/);
        assert.match(ready, /id="zkapi-park-withdrawal-btn"/, "a mutual close already holds a clearance: set aside, not cancel");
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
        assert.match(pending, /Waiting for deposit confirmation\./);
        assert.match(pending, /id="zkapi-check-deposit-btn"/);
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
        assert.match(modal.rendered, /data-step="wallet" data-state="upcoming"/, 'nothing was submitted: the persisted phase is still prepared');
        assert.match(modal.rendered, /MetaMask canceled the transaction\. No funds moved; you can safely try again\./);
        assert.match(modal.rendered, /id="zkapi-withdraw-btn"[^>]*>Continue in MetaMask/);
    } finally { Object.assign(zkapiClient, original); }
});
