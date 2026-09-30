import test from 'node:test';
import assert from 'node:assert/strict';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import AccountModal from '../../chat/zkapi/components/AccountModal.js';
import { addressFundingWallet } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import { getWalletMethod, setWalletMethod } from '../../chat/zkapi/services/walletMethod.mjs';
import { refreshWithdrawalFees, renderWithdrawalFees, stopWithdrawalFees, withdrawalFeeReady } from '../../chat/zkapi/components/WithdrawalFees.js';

const address = `0x${'1'.repeat(40)}`;
function fixture(t) {
    const original = { config: zkapiClient.config, wallet: zkapiClient.wallet,
        withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals };
    const method = getWalletMethod();
    const walletState = addressFundingWallet.state;
    addressFundingWallet.state = { address, exists: true, backedUp: true, unlocked: true };
    setWalletMethod('address');
    Object.assign(zkapiClient, { config: { funding: { chain_id: 1, contract_address: `0x${'2'.repeat(40)}`, billing_asset: 'native_eth' } },
        wallet: { note: { note_id: 7, current_balance: 1000 } }, withdrawal: null, withdrawals: [] });
    const owner = Object.assign(Object.create(AccountModal.prototype), { isOpen: true, view: 'withdraw', withdrawMode: 'mutual',
        withdrawConfirmed: true, busy: false, fundingDestination: `0x${'3'.repeat(40)}`, render() {},
        escapeHtml: value => String(value ?? ''), overlay: { querySelector: () => null, querySelectorAll: () => [] } });
    const quote = { address, chainId: 1, mode: 'mutual', feeReserveWei: '1000000000000000',
        balanceWei: '1000000000000000', shortfallWei: '0', transactionFeeWei: '1000000000000000', expiresAt: Date.now() + 30000 };
    t.mock.method(addressFundingWallet, 'getWithdrawalFeeBudget', async () => quote);
    t.after(() => { stopWithdrawalFees(owner); Object.assign(zkapiClient, original); setWalletMethod(method); addressFundingWallet.state = walletState; });
    return { owner, quote };
}

test('insufficient ETH prevents the first withdrawal action and renders one neutral top-up section', async t => {
    const { owner, quote } = fixture(t);
    quote.balanceWei = '400000000000000'; quote.shortfallWei = '600000000000000';
    await refreshWithdrawalFees(owner);
    assert.equal(withdrawalFeeReady(owner), false);
    const run = t.mock.method(owner, 'run', () => assert.fail('withdrawal must not start'));
    await owner.submitWithdrawal();
    assert.equal(run.mock.callCount(), 0);
    const html = owner.renderWithdrawal();
    assert.match(html, /Fee reserve to start/);
    assert.match(html, /Already available/);
    assert.match(html, /Add .*0\.0006/);
    assert.match(html, /id="zkapi-withdraw-btn"[^>]*disabled/);
    assert.doesNotMatch(html, /Actual deposit network fee|Return ETH to your wallet|data-tone="error"/);
});

test('funding the displayed reserve enables readiness without starting a withdrawal', async t => {
    const { owner, quote } = fixture(t);
    await refreshWithdrawalFees(owner);
    assert.equal(withdrawalFeeReady(owner), true);
    assert.match(renderWithdrawalFees(owner), /Fee covered/);
    assert.doesNotMatch(renderWithdrawalFees(owner), /data-withdrawal-fee-copy/);
    quote.expiresAt = Date.now() - 1;
    assert.equal(withdrawalFeeReady(owner), false);
});

test('late fee reads cannot revive a closed dialog or a different note or method', async t => {
    for (const change of [owner => { owner.isOpen = false; stopWithdrawalFees(owner); },
        () => { zkapiClient.wallet.note.note_id = 8; }, owner => { owner.withdrawMode = 'escape'; }]) {
        const { owner, quote } = fixture(t);
        let finish;
        t.mock.method(addressFundingWallet, 'getWithdrawalFeeBudget', () => new Promise(resolve => { finish = resolve; }));
        const pending = refreshWithdrawalFees(owner);
        change(owner);
        finish(quote);
        assert.equal(await pending, false);
        assert.equal(withdrawalFeeReady(owner), false);
    }
});

test('failed balance reads clear readiness even if an earlier quote had enough ETH', async t => {
    const { owner } = fixture(t);
    await refreshWithdrawalFees(owner);
    t.mock.method(addressFundingWallet, 'getWithdrawalFeeBudget', async () => { throw new Error('RPC internal details'); });
    await refreshWithdrawalFees(owner, { force: true });
    assert.equal(withdrawalFeeReady(owner), false);
    assert.match(renderWithdrawalFees(owner), /Couldn’t check/);
    assert.doesNotMatch(renderWithdrawalFees(owner), /RPC internal details|Fee covered/);
});

test('a higher fee on click requires another review even when fully funded', async t => {
    const { owner, quote } = fixture(t);
    await refreshWithdrawalFees(owner);
    t.mock.method(addressFundingWallet, 'getWithdrawalFeeBudget', async () => ({ ...quote, feeReserveWei: '2000000000000000', balanceWei: '3000000000000000' }));
    const run = t.mock.method(owner, 'run', async () => {});
    await owner.submitWithdrawal();
    assert.equal(run.mock.callCount(), 0);
    assert.match(owner.outcome.message, /Review the updated reserve/);
    await owner.submitWithdrawal();
    assert.equal(run.mock.callCount(), 1, 'a second explicit click approves the now visible reserve');
});


test('fresh fee reads clear a fee-read warning without replaying the withdrawal', async t => {
    const { owner } = fixture(t);
    const run = t.mock.method(owner, 'run', () => assert.fail('refresh must not send'));
    owner.outcome = { withdrawalFeeIssue: 'address_fee_data', message: 'Old fee failure', tone: 'info' };
    owner.status = 'Old fee failure'; owner.statusError = true;
    await refreshWithdrawalFees(owner);
    assert.equal(owner.outcome, null);
    assert.equal(owner.statusError, false);
    assert.equal(run.mock.callCount(), 0);
    assert.doesNotMatch(renderWithdrawalFees(owner), /<details|<summary|About this reserve|data-withdrawal-fee-refresh/);
    owner.outcome = { message: 'Different transaction error', tone: 'error' };
    await refreshWithdrawalFees(owner, { force: true });
    assert.equal(owner.outcome.message, 'Different transaction error');
});
