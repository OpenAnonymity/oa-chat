import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseTokenAmount } from '@openanonymity/zkapi-browser-sdk/wallet';

const source = fs.readFileSync(new URL('../../chat/zkapi/components/AccountModal.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace('export default class AccountModal', 'class AccountModal');

function fixture() {
    const buttons = new Map();
    const client = { config: { funding: {} }, note: null, formatMoney: value => {
        assert.notEqual(value, null, 'an unavailable balance is never formatted as zero');
        return '$12.00';
    }, isNativeEthFunding: true, quoteDepositUsd: async () => ({ ethAmount: '0.005' }) };
    const noop = () => {};
    const context = {
        parseTokenAmount, zkapiClient: client, getWalletMethod: () => 'metamask', walletMethodText: value => value,
        renderDepositAmount: () => '', prepareDepositAmount: async () => '0.005', renderWalletMethod: () => '', renderFundingAccount: () => '', attachWalletMethodControls: noop,
        captureWalletView: noop, restoreWalletView: noop, captureFundingDisclosureView: noop,
        restoreFundingDisclosureView: noop, capturePrivateBalanceHelpFocus: noop,
        restorePrivateBalanceHelpFocus: noop, captureFundingSetupView: noop,
        restoreFundingSetupView: noop, attachPrivateBalanceHelp: noop,
        attachFundingDisclosures: () => noop, stopFundingFlow: owner => { owner.fundingFlow = null; },
        confirm: () => true, document: { activeElement: null }, console
    };
    const Modal = vm.runInNewContext(`${source}\nAccountModal;`, context);
    const modal = Object.create(Modal.prototype);
    Object.assign(modal, { view: 'balance', busy: false, status: '', statusError: false, escapeHtml: String,
        privateBalanceHelpOpen: {}, renderBalance: () => '', renderWithdrawalStatusLink: () => '',
        overlay: { innerHTML: '', querySelector: id => buttons.get(id) || null, querySelectorAll: () => [] },
        async run(action) { await action(() => {}); }
    });
    function button(id) {
        const node = { addEventListener(type, handler) { this[type] = handler; } };
        buttons.set(id, node);
        return node;
    }
    return { client, modal, context, buttons, button, renderBalance: () => Modal.prototype.renderBalance.call(modal) };
}

for (const [selector, method] of [
    ['#zkapi-deposit-btn', 'deposit'],
    ['#zkapi-retry-deposit-btn', 'retryUnknownDeposit'],
    ['#zkapi-retry-dropped-deposit-btn', 'retryDroppedDeposit'],
    ['#zkapi-check-deposit-btn', 'recoverBrowserDeposit']
]) {
    test(`${method} preserves confirmed success without claiming an unavailable balance is ready`, async () => {
        const f = fixture();
        const trigger = f.button(selector);
        f.buttons.set('#zkapi-deposit-amount', { value: '10', style: {}, addEventListener() {} });
        let calls = 0;
        f.client[method] = async () => { calls++; return { status: 'confirmed', balanceRefreshPending: true, noteId: 7 }; };
        f.modal.render();
        await trigger.click();
        assert.equal(calls, 1);
        assert.equal(f.modal.view, 'balance');
        assert.equal(f.modal.statusError, false);
        assert.match(f.modal.status, /Deposit confirmed and saved.*Refreshing/);
        assert.doesNotMatch(f.modal.status, /ready/);
        const html = f.renderBalance();
        assert.match(html, /Deposit confirmed|Refreshing your private balance/);
        assert.match(html, /id="zkapi-refresh-btn"/);
        assert.doesNotMatch(html, /zkapi-deposit-btn|zkapi-deposit-amount|Continue with MetaMask|Available|\$0/);
        f.client.note = { note_id: 6 };
        f.modal.syncConfirmedDepositBalance();
        assert.equal(f.modal.depositBalanceRefreshPending, true);
        f.client.note = { note_id: 7 };
        f.modal.syncConfirmedDepositBalance();
        assert.equal(f.modal.depositBalanceRefreshPending, false);
        assert.match(f.modal.status, /private balance is ready/);
        f.client.note = null;
        f.modal.syncConfirmedDepositBalance();
        assert.equal(f.modal.depositBalanceRefreshPending, false, 'later closure cannot resurrect the old display guard');
    });
}

for (const method of ['submitAddressDeposit', 'prepareAddressDepositRetry']) {
    test(`${method} preserves confirmed address success while balance refresh is pending`, async () => {
        const f = fixture();
        let calls = 0;
        const result = { status: 'confirmed', balanceRefreshPending: true, noteId: 7 };
        f.client.deposit = async () => { calls++; return result; };
        f.client.prepareDepositRetry = async () => { calls++; return result; };
        f.modal.fundingDepositIntent = { ethAmount: '0.005', preparedOperationId: 'exact-operation' };
        f.modal.fundingFlow = { async complete() {} };
        await f.modal[method]();
        assert.equal(calls, 1);
        assert.equal(f.modal.depositBalanceRefreshPending, true);
        assert.match(f.modal.status, /Deposit confirmed and saved.*Refreshing/);
        assert.doesNotMatch(f.renderBalance(), /zkapi-deposit-btn|zkapi-deposit-amount|ready/);
        await f.modal.submitAddressDeposit();
        assert.equal(calls, 1, 'no second address deposit while projection is pending');
    });
}
