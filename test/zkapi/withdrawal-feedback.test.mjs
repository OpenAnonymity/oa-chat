import test from 'node:test';
import assert from 'node:assert/strict';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import { availableWithdrawalEscape } from '../../chat/zkapi/services/withdrawalRecovery.mjs';
import { addressFundingWallet } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import AccountModal from '../../chat/zkapi/components/AccountModal.js';
import { withdrawalFeeScope } from '../../chat/zkapi/components/WithdrawalFees.js';
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
    Object.assign(modal, { isOpen: true, walletMethodReady: true, render() {} });
    const quote = { address: destination, chainId: 1, mode: 'mutual', balanceWei: '100', feeReserveWei: '10', shortfallWei: '0', expiresAt: Date.now() + 30000 };
    modal.withdrawalFees = { scope: withdrawalFeeScope(modal), quote };
    t.mock.method(zkapiClient, 'getWithdrawalFeeBudget', async mode => ({ ...quote, mode }));
    return modal;
}

test('withdrawal amount does not claim funds were already returned before submission', t => {
    const modal = fixture(t);
    const html = modal.renderWithdrawal();
    assert.match(html, /You withdraw/);
    assert.match(html, /To your MetaMask account\. MetaMask pays the network fee\./);
    assert.doesNotMatch(html, /Returned to MetaMask/);
});

test('reload checking explains the delay, hides X and cannot queue a withdrawal', async t => {
    const modal = fixture(t, { prepared: { phase: 'reserving', mode: 'mutual', destination } });
    modal.walletMethodReady = false;
    modal.isOpen = true;
    const run = t.mock.method(modal, 'run', () => assert.fail('startup must not queue withdrawal'));
    const html = modal.dialogMarkup();
    assert.match(html, /Checking saved withdrawal/);
    assert.match(html, /Nothing new will be sent until you choose Continue/);
    assert.doesNotMatch(html, /Getting ready|Paused before MetaMask/);
    assert.match(html, /id="zkapi-payment-close"[^>]*hidden/);
    assert.match(html, /id="zkapi-withdraw-btn"[^>]*disabled/);
    assert.match(html, /id="zkapi-withdraw-dismiss-btn"/);
    await modal.requestWithdrawal();
    await modal.submitWithdrawal();
    assert.equal(run.mock.callCount(), 0);
    modal.walletMethodReady = true;
    assert.match(modal.renderWithdrawal(), />Continue in MetaMask/);
    assert.equal(run.mock.callCount(), 0, 'finishing startup still needs a fresh click');
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
    assert.match(html, /aria-label="Withdrawal, paused"/);
    assert.match(html, /zkapi-meta">To 0xaaaaaaa…aaaaaaaaa · Mutual close/, 'the saved destination is named once, beside the method');
    assert.match(html, /data-step="wallet" data-state="paused" aria-current="step"/);
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

function interruptedMutual(t) {
    const modal = fixture(t, { prepared: { note_id: 7, phase: 'reserving', mode: 'mutual', destination } });
    const previousRuntime = walletRuntime.runtime;
    const previousMode = zkapiClient.browserMode;
    zkapiClient.browserMode = true;
    walletRuntime.runtime = { state: { note_id: 7 }, preparedWithdrawal: {
        operationId: 'withdraw-7', noteId: 7, phase: 'reserving', mode: 'mutual', destination
    } };
    t.after(() => { walletRuntime.runtime = previousRuntime; zkapiClient.browserMode = previousMode; });
    return modal;
}

test('interrupted mutual-close UI offers an explicit escape choice and shows its safety window before submission', t => {
    const modal = interruptedMutual(t);
    let html = modal.renderWithdrawal();
    assert.match(html, /Paused before MetaMask/);
    assert.match(html, /data-step="proof" data-state="paused"/);
    assert.match(html, /id="zkapi-use-escape-btn"[^>]*>Use escape hatch/);
    assert.match(html, /safety window/);
    assert.doesNotMatch(html, /data-state="active"/);
    modal.withdrawalEscapeIntent = availableWithdrawalEscape();
    html = modal.renderWithdrawal();
    assert.equal(modal.withdrawMode, 'escape');
    assert.match(html, /then return here to finalize/);
    assert.match(html, /id="zkapi-withdraw-btn"[^>]*>Start .* escape/);
    assert.equal(walletRuntime.runtime.preparedWithdrawal.mode, 'mutual', 'selection itself never changes durable transaction state');
    assert.doesNotMatch(html, /data-step="proof" data-state="complete"/);
});

test('reopening defaults to the durable withdrawal mode and stale choices cannot carry onto another operation', t => {
    const modal = interruptedMutual(t);
    modal.withdrawMode = 'escape';
    modal.renderWithdrawal();
    assert.equal(modal.withdrawMode, 'mutual', 'a stale presentation preference is not escape consent');
    modal.withdrawalEscapeIntent = availableWithdrawalEscape();
    walletRuntime.runtime.preparedWithdrawal.operationId = 'successor-operation';
    modal.renderWithdrawal();
    assert.equal(modal.withdrawalEscapeIntent, null);
    assert.equal(modal.withdrawMode, 'mutual');
});

test('a pending or ambiguously retried wallet request cannot offer escape through the recovery UI', t => {
    const modal = interruptedMutual(t);
    walletRuntime.runtime.preparedWithdrawal.ambiguousSubmissions = [{ submissionId: 'old-prompt' }];
    assert.doesNotMatch(modal.renderWithdrawal(), /id="zkapi-use-escape-btn"/);
    zkapiClient.config.prepared_withdrawal.phase = 'awaiting_wallet';
    walletRuntime.runtime.preparedWithdrawal.phase = 'awaiting_wallet';
    assert.match(modal.renderWithdrawal(), /id="zkapi-recover-withdrawal-btn"/);
    assert.doesNotMatch(modal.renderWithdrawal(), /id="zkapi-use-escape-btn"/);
});

function submissionFixture(t) {
    const modal = fixture(t);
    const previousMode = zkapiClient.browserMode;
    zkapiClient.browserMode = false;
    t.after(() => { zkapiClient.browserMode = previousMode; });
    t.mock.method(addressFundingWallet, 'init', async () => {});
    t.mock.method(addressFundingWallet, 'reload', async () => {});
    t.mock.method(zkapiClient, 'init', async () => {});
    t.mock.method(zkapiClient, 'settleActiveLease', async () => {});
    return modal;
}

test('a refresh while waiting for the wallet cannot silently switch the chosen withdrawal mode', async t => {
    const modal = submissionFixture(t);
    modal.withdrawMode = 'escape';
    modal.withdrawalFees.scope = withdrawalFeeScope(modal);
    modal.run = async (action, details) => {
        assert.equal(details.kind, 'escape');
        modal.withdrawMode = 'mutual';
        return action(() => {});
    };
    let submittedMode;
    t.mock.method(zkapiClient, 'withdraw', async mode => { submittedMode = mode; return { status: 'submitted' }; });
    await assert.rejects(modal.submitWithdrawal(), /Withdrawal details changed/);
    assert.equal(submittedMode, undefined, 'a changed review requires a fresh confirmation');
});

test('a new private balance arriving during settlement cannot inherit the old withdrawal click', async t => {
    const modal = submissionFixture(t);
    modal.run = async action => {
        zkapiClient.wallet = { note: { ...note, note_id: 8 } };
        return action(() => {});
    };
    const withdraw = t.mock.method(zkapiClient, 'withdraw', async () => assert.fail('must not withdraw a successor note'));
    await assert.rejects(modal.submitWithdrawal(), /private balance changed/);
    assert.equal(withdraw.mock.callCount(), 0);
});

test('escape Continue carries the captured operation and destination without server settlement into the SDK', async t => {
    const modal = interruptedMutual(t);
    const previousManifest = walletRuntime.manifest;
    walletRuntime.manifest = { deployment_id: 'host-escape-options' };
    t.after(() => { walletRuntime.manifest = previousManifest; });
    t.mock.method(walletRuntime, 'init', async () => {});
    t.mock.method(walletRuntime, 'reload', async () => {});
    t.mock.method(addressFundingWallet, 'init', async () => {});
    t.mock.method(addressFundingWallet, 'reload', async () => {});
    t.mock.method(zkapiClient, 'init', async () => {});
    t.mock.method(zkapiClient, 'settleActiveLease', async () => {
        zkapiClient.config.prepared_withdrawal.destination = `0x${'b'.repeat(40)}`;
    });
    modal.withdrawalEscapeIntent = availableWithdrawalEscape();
    modal.withdrawMode = 'escape';
    modal.withdrawalFees.scope = withdrawalFeeScope(modal);
    modal.run = async action => action(() => {});
    const withdraw = t.mock.method(zkapiClient, 'withdraw', async (mode, _report, options) => {
        assert.equal(mode, 'escape');
        assert.equal(options.destination, destination);
        assert.equal(options.expectedWithdrawalOperationId, 'withdraw-7');
        assert.ok(options.reviewedFunding);
        return { status: 'submitted' };
    });
    await modal.submitWithdrawal();
    assert.equal(withdraw.mock.callCount(), 1);
});

test('an escape with unresolved retry history offers a status check instead of forgetting its recovery data', t => {
    const modal = interruptedMutual(t);
    zkapiClient.config.prepared_withdrawal.mode = 'escape';
    zkapiClient.config.prepared_withdrawal.phase = 'prepared';
    Object.assign(walletRuntime.runtime.preparedWithdrawal, { mode: 'escape', phase: 'prepared', clearanceReserved: false });
    assert.match(modal.renderWithdrawal(), /id="zkapi-cancel-withdrawal-btn"/);
    walletRuntime.runtime.preparedWithdrawal.ambiguousSubmissions = [{ submissionId: 'unknown-old-prompt' }];
    const html = modal.renderWithdrawal();
    assert.doesNotMatch(html, /id="zkapi-cancel-withdrawal-btn"/);
    assert.match(html, /id="zkapi-sync-withdrawal-btn"/);
});

test('payment history shows the brief outcome once, outside embedded history disclosures', t => {
    const modal = fixture(t);
    zkapiClient.withdrawals = [{ recordId: 'completed', phase: 'closed', mode: 'mutual',
        payoutVerified: true, destination, finalBalance: 1_780_000, createdAt: Date.now() }];
    modal.outcome = { message: 'Withdrawal confirmed.', tone: 'success' };
    assert.match(modal.renderWithdrawalRecords(), /zkapi-outcome[^>]*>Withdrawal confirmed\./);
    assert.doesNotMatch(modal.renderWithdrawalRecords({ inline: true }), /zkapi-outcome/);
});


test('reserved mutual withdrawal never calls dismissal Cancel', t => {
    const modal = interruptedMutual(t);
    const html = modal.renderWithdrawal();
    assert.match(html, /id="zkapi-withdraw-dismiss-btn"[^>]*>Close<\/button>/);
    assert.doesNotMatch(html, /id="zkapi-cancel-withdrawal-btn"/);
    assert.match(html, /can’t be cancelled/);
});


test('withdrawal recovery cannot set aside a balance even with a prepared journal', t => {
    const modal = interruptedMutual(t);
    assert.doesNotMatch(modal.renderWithdrawal(), /id="zkapi-park-withdrawal-btn"/);
    zkapiClient.config.prepared_withdrawal.phase = 'prepared';
    walletRuntime.runtime.preparedWithdrawal.phase = 'prepared';
    assert.doesNotMatch(modal.renderWithdrawal(), /id="zkapi-park-withdrawal-btn"/);
    walletRuntime.runtime.preparedWithdrawal.ambiguousSubmissions = [{ submissionId: 'unknown' }];
    assert.doesNotMatch(modal.renderWithdrawal(), /id="zkapi-park-withdrawal-btn"/);
});
