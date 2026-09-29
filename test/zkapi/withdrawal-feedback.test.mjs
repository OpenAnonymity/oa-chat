import test from 'node:test';
import assert from 'node:assert/strict';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import AccountModal from '../../chat/zkapi/components/AccountModal.js';
import { walletJourney } from '../../chat/zkapi/domain/walletJourney.js';

const destination = `0x${'a'.repeat(40)}`;
const note = { note_id: 7, deposit_amount: 2_000_000, current_balance: 1_780_000,
    expiry_ts: Math.floor(Date.now() / 1000) + 86400 };

function fixture(t, { prepared = null, balance = note.current_balance, native = false } = {}) {
    const previous = { config: zkapiClient.config, wallet: zkapiClient.wallet,
        withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals,
        lastError: zkapiClient.lastError };
    Object.assign(zkapiClient, { config: { prepared_withdrawal: prepared,
        funding: native ? { billing_asset: 'native_eth', billing_unit: 'gwei' } : {} },
        wallet: { note: { ...note, current_balance: balance } }, withdrawal: null,
        withdrawals: [], lastError: null });
    t.after(() => Object.assign(zkapiClient, previous));
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, { view: 'withdraw', busy: false, status: '', statusError: false,
        withdrawMode: 'mutual', journeyKind: null, journeyLast: null,
        overlay: { querySelector: () => null, querySelectorAll: () => [] },
        escapeHtml: value => String(value ?? '') });
    return modal;
}

test('withdrawal amount does not claim funds were already returned before submission', t => {
    const modal = fixture(t);
    const html = modal.renderWithdrawal();
    assert.match(html, /Amount to withdraw/);
    assert.match(html, /Your MetaMask wallet pays the network fee separately/);
    assert.doesNotMatch(html, /Returned to MetaMask/);
});

test('an absent balance does not produce a dash under a withdrawal success caption', t => {
    const modal = fixture(t, { balance: null });
    const html = modal.renderWithdrawal();
    assert.match(html, /Checking your remaining balance/);
    assert.doesNotMatch(html, /data-withdraw-amount|Returned to/);
});

test('native withdrawal amount retains exact ETH when the USD quote is unavailable', t => {
    const modal = fixture(t, { native: true });
    t.mock.method(zkapiClient, 'formatMoney', () => '—');
    t.mock.method(zkapiClient, 'formatBillingAmount', () => '0.00178');
    assert.match(modal.renderWithdrawal(), /data-withdraw-amount[^>]*>0\.00178 ETH</);
    const amountNode = { textContent: '' };
    modal.overlay.querySelector = selector => selector === '[data-withdraw-amount]' ? amountNode : null;
    modal.setStatus('Preparing withdrawal');
    assert.equal(amountNode.textContent, '0.00178 ETH');
});

test('saved withdrawal names its unchanged destination without pretending it is running', t => {
    const modal = fixture(t, { prepared: { phase: 'prepared', mode: 'mutual', destination } });
    const html = modal.renderWithdrawal();
    assert.match(html, /Withdrawal ready to continue/);
    assert.match(html, /keeps the same destination when you switch payment methods/);
    assert.match(html, /Nothing has been sent yet/);
    assert.doesNotMatch(html, /Returning your balance|Returned to MetaMask/);
});

test('only the SDK matched withdrawal event produces a completion banner and history navigation', t => {
    const modal = fixture(t);
    modal.recordWithdrawalOutcome({ status: 'submitted' });
    assert.equal(modal.withdrawalCompleted, undefined);
    assert.equal(modal.view, 'withdraw');
    modal.recordWithdrawalOutcome({ status: 'closed' });
    assert.equal(modal.withdrawalCompleted, false);
    assert.equal(modal.withdrawalOutcomePending, true);
    assert.doesNotMatch(modal.status, /Withdrawal confirmed|Funds sent|returned/);
    modal.recordWithdrawalOutcome({ status: 'closed', event: { destination, finalBalance: 1_780_000n } });
    assert.equal(modal.withdrawalCompleted, true);
    assert.equal(modal.withdrawalOutcomePending, false);
    assert.equal(modal.view, 'withdrawals');
    assert.equal(modal.status, 'Withdrawal confirmed. Funds sent to your saved wallet address.');
    assert.equal(walletJourney({ kind: 'withdraw', message: modal.status }).done, true);
});

test('an escape start stays pending without a completed-withdrawal banner', t => {
    const modal = fixture(t);
    modal.recordWithdrawalOutcome({ status: 'pending_withdrawal', deadline: 1_900_000_000,
        event: { destination, finalBalance: 1_780_000n } });
    assert.equal(modal.withdrawalCompleted, undefined);
    assert.equal(modal.view, 'withdraw');
    assert.match(modal.status, /Escape started\. Finalize after/);
    assert.doesNotMatch(modal.status, /Withdrawal confirmed|Funds sent|returned/);
});

test('payment history shows the brief outcome once, outside embedded history disclosures', t => {
    const modal = fixture(t);
    zkapiClient.withdrawals = [{ recordId: 'completed', phase: 'closed', mode: 'mutual',
        payoutVerified: true, destination, finalBalance: 1_780_000, createdAt: Date.now() }];
    modal.outcome = { message: 'Withdrawal confirmed.', tone: 'success' };
    assert.match(modal.renderWithdrawalRecords(), /zkapi-outcome[^>]*>Withdrawal confirmed\./);
    assert.doesNotMatch(modal.renderWithdrawalRecords({ inline: true }), /zkapi-outcome/);
});
