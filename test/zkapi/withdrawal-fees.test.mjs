import test from 'node:test';
import assert from 'node:assert/strict';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import AccountModal from '../../chat/zkapi/components/AccountModal.js';
import { addressFundingWallet } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import { getWalletMethod, setWalletMethod } from '../../chat/zkapi/services/walletMethod.mjs';
import { needsWithdrawalFees, refreshWithdrawalFees, renderWithdrawalFees, stopWithdrawalFees, withdrawalFeeReady, withdrawalFeeReceiptAmounts, attachWithdrawalFees } from '../../chat/zkapi/components/WithdrawalFees.js';
import { renderSponsoredFee } from '../../chat/zkapi/components/SponsoredFee.js';
import { withdrawalDestination } from '../../chat/zkapi/services/addressFunding.js';

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
    assert.match(html, /Add <b>0\.0006 ETH<\/b> to your deposit address to pay the fee\./);
    assert.match(html, /data-withdrawal-fee-topup[^>]*>Show deposit address</);
    assert.doesNotMatch(html, /Needed to start|Already available/, 'the form shows one fee line, not the receipt');
    owner.withdrawalFeeTopUp = owner.withdrawalFees.scope;
    const shown = owner.renderWithdrawal();
    assert.match(shown, /zkapi-fee-topup/, 'the address opens in place');
    assert.match(shown, /aria-label="Copy funding address"/);
    assert.doesNotMatch(shown, /data-withdrawal-fee-topup/);
    assert.match(html, /id="zkapi-withdraw-btn"[^>]*disabled/);
    assert.doesNotMatch(html, /Actual deposit network fee|Return ETH to your wallet|data-tone="error"/);
});

test('funding the displayed reserve enables readiness without starting a withdrawal', async t => {
    const { owner, quote } = fixture(t);
    await refreshWithdrawalFees(owner);
    assert.equal(withdrawalFeeReady(owner), true);
    const form = owner.renderWithdrawal();
    assert.match(form, /Paid from the ETH at your deposit address\./);
    assert.match(form, /placeholder="Your wallet address \(0x…\)"/);
    assert.match(form, /data-funding-withdrawal-paste[^>]*>Paste</);
    assert.doesNotMatch(form, /data-withdrawal-fee-topup/);
    owner.withdrawMode = 'escape';
    assert.match(owner.renderWithdrawal(), /Use the normal withdrawal instead/);
    owner.withdrawMode = 'mutual';
    assert.match(renderWithdrawalFees(owner), /You have enough ETH/);
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
    assert.doesNotMatch(renderWithdrawalFees(owner), /RPC internal details|You have enough ETH/);
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

test('a failed or underfunded refresh returns confirmation to actionable fee review', async t => {
    const { owner, quote } = fixture(t);
    for (const failure of ['shortfall', 'unavailable']) {
        t.mock.method(addressFundingWallet, 'getWithdrawalFeeBudget', async () => ({ ...quote }));
        await refreshWithdrawalFees(owner, { force: true });
        owner.withdrawalConfirmation = owner.withdrawalReviewScope();
        assert.match(owner.renderWithdrawal(), /Closing this window afterward/);
        t.mock.method(addressFundingWallet, 'getWithdrawalFeeBudget', async () => {
            if (failure === 'unavailable') throw new Error('offline');
            return { ...quote, balanceWei: '0', shortfallWei: quote.feeReserveWei };
        });
        await refreshWithdrawalFees(owner, { force: true });
        assert.equal(owner.withdrawalConfirmation, null);
        const html = owner.renderWithdrawal();
        assert.match(html, failure === 'shortfall' ? /data-withdrawal-fee-topup/ : /data-withdrawal-fee-refresh/);
        assert.match(html, /id="zkapi-withdraw-btn"[^>]*disabled/);
    }
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


test('balance view preloads a quote and loading uses the same fee slots', async t => {
    const { owner } = fixture(t);
    owner.view = 'balance';
    await refreshWithdrawalFees(owner);
    owner.view = 'withdraw';
    assert.equal(withdrawalFeeReady(owner), true);
    const ready = renderWithdrawalFees(owner);
    stopWithdrawalFees(owner);
    const loading = renderWithdrawalFees(owner);
    for (const label of ['Needed to start', 'Already available', 'zkapi-fee-result', 'zkapi-fee-action']) {
        assert.ok(loading.includes(label));
        assert.ok(ready.includes(label));
    }
    assert.match(loading, /aria-busy="true"/);
    assert.equal(withdrawalFeeReady(owner), false);
});

test('shortfall shows Add ETH and reveals transfer instructions on request', async t => {
    const { owner, quote } = fixture(t);
    quote.balanceWei = '0'; quote.shortfallWei = quote.feeReserveWei;
    await refreshWithdrawalFees(owner);
    assert.match(renderWithdrawalFees(owner), /data-withdrawal-fee-topup[^>]*>Add 0\.001 ETH/);
    assert.doesNotMatch(renderWithdrawalFees(owner), /Fee-paying address/);
    owner.withdrawalFeeTopUp = owner.withdrawalFees.scope;
    assert.match(renderWithdrawalFees(owner), /Fee-paying address/);
    assert.match(renderWithdrawalFees(owner), /Check now/);
    assert.match(renderWithdrawalFees(owner), /class="zkapi-fee-action" hidden/);
    assert.doesNotMatch(renderWithdrawalFees(owner), /Hide address|data-withdrawal-fee-topup/);
    owner.withdrawalFees.error = 'Couldn’t check fees. Try again.';
    assert.equal((renderWithdrawalFees(owner).match(/data-withdrawal-fee-refresh/g) || []).length, 1, 'the visible balance check remains the only refresh control');
});


test('cancelling a pending fee check prevents withdrawal even after returning to the form', async t => {
    const { owner, quote } = fixture(t);
    await refreshWithdrawalFees(owner);
    owner.withdrawEntry = 'balance';
    let finish;
    t.mock.method(addressFundingWallet, 'getWithdrawalFeeBudget', () => new Promise(resolve => { finish = resolve; }));
    const run = t.mock.method(owner, 'run', () => assert.fail('cancelled intent must not reach settlement'));
    const pending = owner.submitWithdrawal();
    owner.dismissWithdrawal();
    assert.equal(owner.view, 'balance');
    owner.view = 'withdraw';
    finish(quote);
    await pending;
    assert.equal(run.mock.callCount(), 0);
    assert.equal(owner.withdrawalPreflightBusy, false);
});

test('review cannot reserve a balance before explicit confirmation', async t => {
    const { owner } = fixture(t);
    await refreshWithdrawalFees(owner);
    const submit = t.mock.method(owner, 'submitWithdrawal', async () => {});
    owner.requestWithdrawal();
    assert.ok(owner.withdrawalConfirmation);
    assert.equal(submit.mock.callCount(), 0);
    const review = owner.renderWithdrawal();
    assert.match(review, /Once the server approves/);
    assert.match(review, /<span class="zkapi-transfer-label">You withdraw<\/span>[\s\S]*<span class="zkapi-transfer-label">To<\/span>[\s\S]*<span class="zkapi-transfer-label">Network fee<\/span>[\s\S]*<span class="zkapi-transfer-label">You receive<\/span>/, 'review rows in a wallet’s order');
    assert.match(review, /id="zkapi-withdraw-review-confirm"[^>]*>Withdraw [^<]+</, 'the button names the amount');
    assert.match(review, /id="zkapi-withdraw-review-back"[^>]*>Back</);
    await owner.confirmWithdrawal();
    assert.equal(submit.mock.callCount(), 1);
    await owner.confirmWithdrawal();
    assert.equal(submit.mock.callCount(), 1, 'confirmation is single-use');
});

test('missing destination blocks both review and submission even with funded fees', async t => {
    const { owner } = fixture(t);
    await refreshWithdrawalFees(owner);
    const run = t.mock.method(owner, 'run', () => assert.fail('invalid destination must not settle or reserve'));
    for (const destination of ['', '0x123', `0x${'0'.repeat(40)}`]) {
        owner.fundingDestination = destination;
        owner.requestWithdrawal();
        await owner.submitWithdrawal();
        assert.ok(!owner.withdrawalConfirmation);
        assert.equal(owner.withdrawalInputReady(), false);
    }
    assert.equal(run.mock.callCount(), 0);
});

test('changed destination, note or fee readiness invalidates confirmation', async t => {
    for (const change of [owner => { owner.fundingDestination = `0x${'4'.repeat(40)}`; },
        () => { zkapiClient.wallet.note.note_id++; }, owner => { owner.withdrawalFees.quote.expiresAt = 0; }]) {
        const { owner } = fixture(t);
        await refreshWithdrawalFees(owner);
        owner.requestWithdrawal();
        assert.ok(owner.withdrawalConfirmation);
        change(owner);
        const submit = t.mock.method(owner, 'submitWithdrawal', async () => assert.fail('stale confirmation'));
        await owner.confirmWithdrawal();
        assert.equal(submit.mock.callCount(), 0);
        assert.equal(owner.withdrawalConfirmation, null);
    }
});

test('MetaMask gets the same irreversible confirmation before first withdrawal', async t => {
    const { owner, quote } = fixture(t);
    setWalletMethod('metamask');
    t.mock.method(zkapiClient, 'getWithdrawalFeeBudget', async () => quote);
    await refreshWithdrawalFees(owner);
    const submit = t.mock.method(owner, 'submitWithdrawal', async () => {});
    assert.doesNotMatch(owner.renderWithdrawal(), /Once the server approves/);
    owner.requestWithdrawal();
    assert.match(owner.renderWithdrawal(), /Closing this window afterward does not cancel the withdrawal/);
    assert.equal(submit.mock.callCount(), 0);
    owner.withdrawalConfirmation = null;
    await owner.confirmWithdrawal();
    assert.equal(submit.mock.callCount(), 0, 'back does not approve the action');
});

test('editing the destination during final fee preflight cannot redirect an approved withdrawal', async t => {
    const { owner, quote } = fixture(t);
    await refreshWithdrawalFees(owner);
    owner.requestWithdrawal();
    let finish;
    t.mock.method(addressFundingWallet, 'getWithdrawalFeeBudget', () => new Promise(resolve => { finish = resolve; }));
    const run = t.mock.method(owner, 'run', () => assert.fail('changed destination must be reviewed again'));
    const pending = owner.confirmWithdrawal();
    owner.fundingDestination = `0x${'4'.repeat(40)}`;
    finish(quote);
    await pending;
    assert.equal(run.mock.callCount(), 0);
    assert.match(owner.outcome.message, /Withdrawal details changed/);
});


test('receipt uses the screenshot amounts and removes the paid-separately paragraph', async t => {
    const { owner, quote } = fixture(t);
    Object.assign(quote, { feeReserveWei: '1773000000000000', balanceWei: '713000000000000', shortfallWei: '1060000000000000' });
    await refreshWithdrawalFees(owner);
    const html = renderWithdrawalFees(owner);
    assert.match(html, /Needed to start<\/dt><dd>0\.001773 ETH/);
    assert.match(html, /aria-label="minus">−<\/span> 0\.000713 ETH/);
    assert.match(html, /You need to add<\/dt><dd>0\.00106 ETH/);
    assert.match(html, />Add 0\.00106 ETH<\/button>/);
    assert.doesNotMatch(html, /Paid separately|fee allowance|unused ETH/);
    owner.withdrawalFeeTopUp = owner.withdrawalFees.scope;
    assert.match(renderWithdrawalFees(owner), /zkapi-fee-send-amount">Send 0\.00106 ETH/);
});

test('rounded receipt subtraction always equals its safe top-up recommendation', () => {
    for (const [reserve,balance] of [[1773000000000001n,713000000000001n], [1n,0n], [1000000000000001n,1000000000000001n], [1000000000000001n,1000000000000002n]]) {
        const receipt = withdrawalFeeReceiptAmounts({ feeReserveWei:String(reserve), balanceWei:String(balance) });
        const difference = BigInt(receipt.needed)-BigInt(receipt.available);
        assert.equal(BigInt(receipt.shortfall), difference>0n?difference:0n);
        if(balance>=reserve) assert.equal(receipt.shortfall,'0');
        else {
            assert.ok(BigInt(receipt.shortfall)>=reserve-balance);
            assert.ok(BigInt(receipt.shortfall)-(reserve-balance)<2000000000000n);
        }
    }
});


test('expanded inline top-up stays open after enough ETH arrives and reports failed reads honestly', async t => {
    const { owner, quote } = fixture(t);
    quote.balanceWei = '0'; quote.shortfallWei = quote.feeReserveWei;
    await refreshWithdrawalFees(owner);
    owner.withdrawalFeeTopUp = owner.withdrawalFees.scope;
    let html = renderWithdrawalFees(owner);
    assert.match(html, /Send 0\.001 ETH/);
    assert.match(html, /Waiting for your transfer/);
    assert.match(html, /aria-label="Copy funding address"/);
    assert.doesNotMatch(html, /then check again:|Hide address/);
    quote.balanceWei = quote.feeReserveWei; quote.shortfallWei = '0';
    await refreshWithdrawalFees(owner, { force: true });
    html = renderWithdrawalFees(owner);
    assert.match(html, /Available 0\.001 ETH/);
    assert.match(html, /Fee-paying address/);
    assert.match(html, /You have enough ETH for fees/);
    assert.doesNotMatch(html, /Send for network fees|Waiting for your transfer/);
    owner.withdrawalFees.error = 'Couldn’t check fees. Try again.';
    html = renderWithdrawalFees(owner);
    assert.match(html, /Couldn’t check fees/);
    assert.doesNotMatch(html, /You have enough ETH for fees/);
    assert.equal((html.match(/data-withdrawal-fee-refresh/g)||[]).length, 1);
});

for (const failure of [false, true]) {
    test(`inline copy ${failure ? 'failure gives selectable fallback' : 'copies the exact funding address'}`, async t => {
        const { owner } = fixture(t);
        await refreshWithdrawalFees(owner);
        const feedback = { textContent: '' };
        const button = { dataset: {}, setAttribute(name,value) { this[name] = value; }, addEventListener(type,handler) { this[type] = handler; } };
        owner.overlay.querySelector = selector => selector === '[data-withdrawal-fee-copy]' ? button : selector === '[data-withdrawal-fee-copy-status]' ? feedback : null;
        let copied;
        const original = Object.getOwnPropertyDescriptor(globalThis,'navigator');
        Object.defineProperty(globalThis,'navigator',{ configurable:true, value:{ clipboard:{ async writeText(text) { if(failure) throw Error('Clipboard unavailable'); copied=text; } } } });
        t.after(()=>{if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;});
        attachWithdrawalFees(owner);
        await button.click({ currentTarget:button });
        assert.equal(copied, failure ? undefined : address);
        assert.match(feedback.textContent, failure ? /Select the address/ : /Address copied/);
        assert.equal(button.dataset.copied, failure ? undefined : 'true');
    });
}

function useSponsored(t, owner) {
    const quote = { available: true, mode: 'mutual', maxCostWei: '100000000000', flatFeeWei: '10000000000',
        minimumReceivedWei: '890000000000', payoutWei: '1000000000000' };
    const api = { supported: () => true, bundlerUrl: () => 'https://app.example/bundler', plan: q => ({
        options: { fees: 'payout', maxCostWei: '100000000000000', maxTotalFeeWei: String(100000000000000n + BigInt(q.flatFeeWei)), feeCapWei: q.flatFeeWei },
        sponsored: { maxCostWei: '100000000000000', feeCapWei: q.flatFeeWei }
    }) };
    t.mock.method(owner, 'sponsoredApi', () => api);
    owner.sponsoredChoice = 'payout';
    owner.sponsoredQuote = { key: owner.sponsoredKeyFor('mutual'), status: 'ready', quote };
    t.mock.method(owner, 'renderSponsoredFee', () => renderSponsoredFee({ choice: 'payout', status: 'ready', quote }));
    return quote;
}

test('payout-paid withdrawal reaches review with zero signer ETH and shows the net payout', async t => {
    const { owner, quote } = fixture(t);
    quote.balanceWei = '0'; quote.shortfallWei = quote.feeReserveWei;
    await refreshWithdrawalFees(owner);
    assert.equal(withdrawalFeeReady(owner), false);
    useSponsored(t, owner);
    assert.equal(needsWithdrawalFees(owner), false);
    assert.equal(owner.withdrawalInputReady(), true);
    const form = owner.renderWithdrawal();
    assert.doesNotMatch(form, /Add <b>|Show deposit address|Checking available ETH/);
    assert.match(form, /Paid from this withdrawal/);
    assert.doesNotMatch(form, /id="zkapi-withdraw-btn"[^>]*disabled/);
    owner.requestWithdrawal();
    assert.ok(owner.withdrawalConfirmation);
    const review = owner.renderWithdrawal();
    assert.match(review, /No ETH is needed in your signing account/);
    assert.match(review, /about <b>0\.00000089 ETH<\/b>/);
    assert.match(review, /about 0\.00000011 ETH/);
    assert.match(review, /Estimates may change before signing/);
    assert.doesNotMatch(review, /at least|at most|up to/);
    const submit = t.mock.method(owner, 'submitWithdrawal', async () => {});
    await owner.confirmWithdrawal();
    assert.equal(submit.mock.callCount(), 1);
});

test('sponsored review is invalidated by changed balance, destination, signer or fee choice', async t => {
    const { owner } = fixture(t);
    const submit = t.mock.method(owner, 'submitWithdrawal', async () => assert.fail('stale review must not submit'));
    for (const mutate of [() => { zkapiClient.wallet.note.current_balance++; },
        () => { owner.fundingDestination = `0x${'4'.repeat(40)}`; },
        () => { addressFundingWallet.state.address = `0x${'5'.repeat(40)}`; },
        () => { owner.sponsoredChoice = 'wallet'; }]) {
        useSponsored(t, owner);
        owner.requestWithdrawal();
        assert.ok(owner.withdrawalConfirmation);
        mutate();
        await owner.confirmWithdrawal();
        assert.equal(owner.withdrawalConfirmation, null);
    }
    assert.equal(submit.mock.callCount(), 0);
});

test('saved payout-paid withdrawal replaces stale quote caps without wallet funding or changing its address', async t => {
    const { owner } = fixture(t);
    useSponsored(t, owner);
    const payee = owner.fundingDestination;
    zkapiClient.config.prepared_withdrawal = { mode: 'mutual', phase: 'prepared', fee_payer: 'payout',
        destination: `0x${'6'.repeat(40)}`, payout: payee, max_cost_wei: '100', max_total_fee_wei: '110', flat_fee_cap_wei: '10' };
    owner.sponsoredChoice = 'wallet'; owner.sponsoredQuote = null;
    assert.equal(withdrawalDestination(owner), payee);
    assert.equal(needsWithdrawalFees(owner), false);
    assert.equal(owner.withdrawalInputReady(), true);
    assert.deepEqual(owner.sponsoredPlanFor('mutual').bounds, { maxCostWei: '100000000000000', feeCapWei: '10' });
    assert.equal(owner.sponsoredPlanFor('mutual').options.maxTotalFeeWei, '100000000000010');
    for (const status of ['loading', 'unavailable']) {
        owner.sponsoredQuote = { key: owner.sponsoredKeyFor('mutual'), status };
        assert.equal(owner.sponsoredPlanFor('mutual').options.maxCostWei, '100000000000000',
            'continuing a saved withdrawal does not depend on another estimate');
    }
    assert.doesNotMatch(owner.renderWithdrawal(), /ETH for network fees|Add ETH|Checking available ETH/);
});

test('an old balance without sponsorship retains the ordinary wallet-funded path', async t => {
    const { owner, quote } = fixture(t);
    owner.sponsoredChoice = 'payout';
    quote.balanceWei = '0'; quote.shortfallWei = quote.feeReserveWei;
    await refreshWithdrawalFees(owner);
    assert.equal(needsWithdrawalFees(owner), true);
    assert.equal(owner.withdrawalInputReady(), false);
    assert.match(owner.renderWithdrawal(), /Show deposit address/);
});

test('wallet-paid review retains its fee ceiling wording without sponsored estimate copy', async t => {
    const { owner } = fixture(t);
    await refreshWithdrawalFees(owner);
    owner.requestWithdrawal();
    const review = owner.renderWithdrawal();
    assert.match(review, /up to 0\.001 ETH/);
    assert.doesNotMatch(review, /Estimates may change before signing|You receive<[^]*?about <b>/);
});

test('payout-paid escape review retains two steps and labels fee and net amount as estimates', t => {
    const { owner } = fixture(t);
    const quote = useSponsored(t, owner);
    owner.withdrawMode = 'escape';
    quote.mode = 'escape';
    quote.estimatedReceivedWei = quote.minimumReceivedWei;
    quote.minimumReceivedWei = null;
    owner.sponsoredQuote.key = owner.sponsoredKeyFor('escape');
    owner.requestWithdrawal();
    assert.ok(owner.withdrawalConfirmation);
    const review = owner.renderWithdrawal();
    assert.match(review, /Network fees/);
    assert.match(review, /two steps/);
    assert.match(review, /about <b>0\.00000089 ETH<\/b>/);
    assert.match(review, /Estimates may change before signing/);
    assert.match(review, /Start escape hatch/);
    assert.doesNotMatch(review, /at least|at most|up to/);
});
