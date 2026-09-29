import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DepositAmount } from '../../chat/zkapi/services/depositAmount.mjs';
import { renderFundingPaymentQr } from '../../chat/zkapi/components/FundingPaymentQr.js';
import { renderFundingProgress } from '../../chat/zkapi/components/FundingProgress.js';
import { canQuotePendingAddressDeposit, formatFundingAmount, fundingAmount, fundingEthAmount, fundingDestination } from '../../chat/zkapi/services/addressFunding.js';

const recipient = '0x2222222222222222222222222222222222222222';
const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const source = fs.readFileSync(new URL('../../chat/zkapi/components/WalletMethodControls.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ').replaceAll('export async function ', 'async function ');

function fixture({ method = 'address', wallet = {}, client = {}, confirm = () => true } = {}) {
    const addressFundingWallet = { exists: true, address: recipient, unlocked: true, hasPendingTransaction: false, ...wallet };
    const zkapiClient = { networkName: () => 'Ethereum Mainnet', billingTokenSymbol: 'USDC', isMainnetFunding: true,
        config: { funding: { demo_billing_token_address: '0x4444444444444444444444444444444444444444' } }, ...client };
    const microtasks = [];
    const timers = new Map();
    const context = { DepositAmount, renderFundingPaymentQr, renderFundingProgress, addressFundingWallet, zkapiClient, getWalletMethod: () => method,
        canQuotePendingAddressDeposit: () => canQuotePendingAddressDeposit(zkapiClient, addressFundingWallet),
        walletMethodActionBusy: () => false, prepareWalletMethod: async () => () => {}, setWalletMethod: value => { method = value; }, fundingAmount, fundingEthAmount, fundingDestination,
        formatFundingAmount, confirm,
        queueMicrotask: callback => microtasks.push(callback),
        setTimeout: callback => { const id = timers.size + 1; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id),
        chatDB: { getSetting() {}, updateSettings() {} },
        navigator: { clipboard: { writeText: async () => {} } }, document: { activeElement: null } };
    const controls = vm.runInNewContext(`${source}\n({ renderWalletMethod, renderDepositAmount, renderFundingAccount, attachWalletMethodControls, captureWalletView, restoreWalletView, refreshWalletView });`, context);
    const renderAddress = controls.renderFundingAccount;
    controls.renderFundingAccount = owner => controls.renderDepositAmount(owner) + renderAddress(owner);
    const fields = new Map();
    const field = (name, value = '') => {
        const element = { value, events: {}, addEventListener(type, listener) { this.events[type] = listener; } };
        fields.set(`[data-funding-${name}]`, element);
        return element;
    };
    const owner = { view: 'withdraw', isOpen: false, busy: false, fundingBusy: false, fundingError: '', fundingNotice: '',
        escapeHtml, fundingDestination: recipient, render() {},
        overlay: { querySelector: selector => fields.get(selector) ?? null, querySelectorAll: () => [], contains: () => false } };
    return { controls, owner, field, wallet: addressFundingWallet, context, timers,
        flushMicrotasks() { while (microtasks.length) microtasks.shift()(); } };
}

function disclosureOwner(f) {
    const accountSource = fs.readFileSync(new URL('../../chat/zkapi/components/AccountModal.js', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\n/gm, '').replace('export default class AccountModal', 'class AccountModal');
    const AccountModal = vm.runInNewContext(`${accountSource}\nAccountModal;`, f.context);
    Object.assign(f.owner, {
        isOpen: true,
        canRefreshContent: AccountModal.prototype.canRefreshContent,
        handleDisclosureMotion: AccountModal.prototype.handleDisclosureMotion
    });
    let renders = 0;
    f.owner.render = () => { renders++; };
    f.owner.handleDisclosureMotion(true);
    return () => renders;
}

test('address subscriptions and public-balance polls coalesce through the modal disclosure animation', async () => {
    const f = fixture({ wallet: { async getStatus() { return { ethBalance: '123' }; } } });
    Object.assign(f.owner, { view: 'withdrawals' });
    const renders = disclosureOwner(f);
    f.controls.attachWalletMethodControls(f.owner);
    f.flushMicrotasks();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.owner.fundingStatus.ethBalance, '123', 'poll data is retained while rendering waits');
    for (let index = 0; index < 3; index++) f.controls.refreshWalletView(f.owner);
    const poll = [...f.timers.values()][0];
    await poll();
    assert.equal(renders(), 0);
    assert.equal(f.owner.disclosureRefreshPending, true);
    f.owner.handleDisclosureMotion(false);
    assert.equal(renders(), 1);
    assert.equal(f.owner.disclosureRefreshPending, false);
    f.owner.handleDisclosureMotion(false);
    assert.equal(renders(), 1, 'all background events share one deferred render');
});

test('fee-quote polling retains the focused amount and coalesces while a disclosure moves', () => {
    const f = fixture({ client: { isNativeEthFunding: true } });
    Object.assign(f.owner, { view: 'fund', fundingInputCurrency: 'eth', fundingInputAmount: '0.005' });
    const renders = disclosureOwner(f);
    let changed;
    f.context.AddressDepositFlow = class {
        constructor(options) { changed = options.changed; this.status = { ethBalance: '42' }; }
        start() {}
    };
    const amount = f.field('amount', '0.005');
    f.context.document.activeElement = amount;
    f.controls.attachWalletMethodControls(f.owner);
    f.flushMicrotasks();
    changed();
    changed();
    assert.equal(f.owner.fundingStatus.ethBalance, '42');
    assert.equal(renders(), 0);
    assert.equal(f.owner.fundingInputCurrency, 'eth');
    assert.equal(f.owner.fundingInputAmount, '0.005');
    assert.equal(f.context.document.activeElement, amount);
    f.owner.handleDisclosureMotion(false);
    assert.equal(renders(), 1);
    assert.equal(f.owner.disclosureRefreshPending, false);
});

test('new browser address setup has no password, backup, restore or lock controls', () => {
    const { controls, owner } = fixture({ wallet: { address: null, exists: false }, client: { isNativeEthFunding: true } });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /Preparing your address/);
    assert.doesNotMatch(html, /password|backup|restore|data-funding-lock/i);
    assert.doesNotMatch(html, /data-funding-address\b/);
});

test('an unsupported ERC20 deployment does not describe its funding address as native ETH setup', () => {
    const { controls, owner } = fixture({ wallet: { address: null, exists: false } });
    assert.match(controls.renderFundingAccount(owner), /ETH funding is not available on this deployment yet/);
});

function quotedFlow(overrides = {}) {
    return {
        intent: { usdAmount: '10', amount: '5000000', ethAmount: '0.005', depositWei: '5000000000000000' },
        totalWei: '5500000000000000', remainingWei: '5500000000000000',
        requiredWei: '5450000000000000',
        get requiredRemainingWei() {
            if (!/^\d+$/.test(String(this.status?.ethBalance))) return null;
            return String(BigInt(this.requiredWei) > BigInt(this.status.ethBalance)
                ? BigInt(this.requiredWei) - BigInt(this.status.ethBalance) : 0n);
        },
        fee: { expectedFeeWei: '400000000000000', requiredFeeWei: '450000000000000', feeBufferWei: '50000000000000',
            feeReserveWei: '500000000000000', quotedAt: Date.now(), expiresAt: Date.now() + 60000 },
        status: { ethBalance: '0' }, ready: false, ...overrides
    };
}

test('ordinary native funding keeps the fee breakdown available and enables Next only when funded', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '$10.00' } });
    Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: quotedFlow() });
    const waiting = controls.renderFundingAccount(owner);
    assert.match(waiting, /Amount to add to your wallet/);
    assert.match(waiting, /0\.005 ETH/);
    assert.match(waiting, /data-funding-progress/);
    assert.match(waiting, /Estimated actual network fee<\/dt><dd>0\.0004 ETH/);
    assert.match(waiting, /Optional buffer/);
    assert.match(waiting, /Amount to send<\/dt><dd>0\.0055 ETH/);
    assert.doesNotMatch(waiting, /low network fee|take longer|slow/i);
    assert.doesNotMatch(waiting, /Maximum contract fee reserve/);
    assert.match(waiting, /sending wallet charges its own transfer fee separately/);
    assert.match(waiting, new RegExp(`data-funding-address[^>]*value="${recipient}"`));
    assert.match(waiting, /data-funding-next[^>]*disabled/);
    assert.doesNotMatch(waiting, /password|backup|restore|data-funding-lock/i);
    assert.match(waiting, /Return funds held at this address/);
    assert.doesNotMatch(waiting, /<details[^>]*open/);
    Object.assign(owner.fundingFlow, { ready: true, remainingWei: '0', status: { ethBalance: '5500000000000000' } });
    const ready = controls.renderFundingAccount(owner);
    assert.match(ready, /Ready to continue/);
    assert.doesNotMatch(ready, /Send 0(?:\.0)? ETH|Received/);
    assert.doesNotMatch(ready, /data-funding-next[^>]*disabled/);
    assert.match(ready, /Its USD value changes with the ETH price/);
});

test('existing ETH reduces the requested transfer instead of asking users to fund it twice', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '$1.00' } });
    Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: quotedFlow({
        remainingWei: '1500000000000000', status: { ethBalance: '4000000000000000' }
    }) });
    const html = controls.renderFundingAccount(owner);
    assert.match(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), /Send 0\.0015 ETH more/);
    assert.match(html, /Already at this address/);
    assert.match(html, /0\.004 ETH/);
    assert.match(html, /Amount to send<\/dt><dd>0\.0015 ETH/);
    assert.doesNotMatch(html, /Received/);
});

test('covering required fees enables Next without asking for the remaining optional buffer', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '$10.00' } });
    Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: quotedFlow({
        ready: true, remainingWei: '50000000000000', status: { ethBalance: '5450000000000000' }
    }) });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /Ready to deposit/);
    assert.match(html, /Ready to continue\./);
    assert.match(html, /0\.00545 ETH/);
    assert.doesNotMatch(html, /data-funding-next[^>]*disabled/);
    assert.doesNotMatch(html, /data-funding-payment-qr|zkapi-funding-send-number/);
    assert.match(html, /Optional buffer remaining/);
});

test('a fee outage retains the independently checked funding-address balance', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '—' } });
    Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: quotedFlow({
        fee: null, ready: false, totalWei: null, remainingWei: null,
        status: { ethBalance: '1234567890123456' }, error: 'Fee estimate unavailable.'
    }) });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /Available at this address: 0\.001234567890123456 ETH/);
    assert.match(html, /Fee estimate unavailable/);
    assert.doesNotMatch(html, /data-funding-next|data-funding-payment-qr|role="progressbar"/);
});


test('the visible send amount shows USD for the remaining transfer including fees and existing ETH', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true,
        formatMoney: amount => ({ '1500000': '$3.00', '5000000': '$10.00', '5500000': '$11.00' })[amount] || '$0.00' } });
    Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: quotedFlow({
        remainingWei: '1500000000000000', status: { ethBalance: '4000000000000000' }
    }) });
    const html = controls.renderFundingAccount(owner);
    const heading = html.match(/<h3 class="zkapi-funding-send-amount">([\s\S]*?)<\/h3>/)[1];
    assert.match(heading, /0\.0015/);
    assert.match(heading, /zkapi-funding-send-usd">≈ \$3\.00 USD/);
    assert.doesNotMatch(heading, /\$10\.00|\$11\.00/);
    assert.match(html, /data-funding-help-panel[^>]+hidden/);
    const details = html.match(/<div [^>]*data-funding-help-panel[^>]*hidden>([\s\S]*?)<\/div>\s*<\/div>\s*<div class="zkapi-funding-address">/);
    assert.ok(details, 'cost details are in the collapsed question-mark panel');
    assert.match(details[1], /data-funding-progress/);
    assert.match(details[1], /Already at this address/);
    assert.doesNotMatch(html.replace(details[1], ''), /data-funding-progress|Already at this address|Estimated actual network fee|Optional buffer/);
    assert.doesNotMatch(html, /Recommended to send|more is required for the deposit and network fee allowance/);
    owner.fundingHelpOpen = 'quote';
    assert.doesNotMatch(controls.renderFundingAccount(owner), /data-funding-help-panel[^>]+hidden/);
});

test('an unavailable USD conversion keeps exact ETH visible without a zero dollar estimate', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '—' } });
    Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: quotedFlow() });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /0\.0055/);
    assert.match(html, /zkapi-funding-send-usd">USD estimate unavailable/);
    assert.doesNotMatch(html, /≈ \$0/);
});

test('ETH-origin deposits render an exact editable ETH amount and a USD switch', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '$10.00' } });
    const flow = quotedFlow();
    flow.intent = { ...flow.intent, usdAmount: null, source: 'eth-input', inputCurrency: 'eth', inputAmount: '0.005000001' };
    Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: flow });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /data-funding-amount data-funding-eth[^>]*value="0\.005000001"/);
    assert.match(html, /data-funding-currency[^>]*aria-label="Switch amount to USD"/);
    assert.doesNotMatch(html, /data-funding-eth[^>]*readonly|data-funding-usd|Saved deposit/);
    assert.match(html, /zkapi-funding-send-usd">≈ \$10\.00 USD/);
});

test('a saved ETH-origin deposit locks both its exact amount and denomination control', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true,
        config: { pending_deposit: { phase: 'prepared', amount: 5000000, funding_quote_available: true } } } });
    const flow = quotedFlow();
    flow.intent = { ...flow.intent, usdAmount: null, source: 'eth-input', inputCurrency: 'eth', inputAmount: '0.005' };
    Object.assign(owner, { view: 'fund', isOpen: true, fundingInputAmount: '999', fundingInputCurrency: 'usd', fundingFlow: flow });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /data-funding-eth[^>]*value="0\.005" readonly/);
    assert.match(html, /data-funding-currency[^>]*disabled/);
    assert.doesNotMatch(html, /value="999"|data-funding-usd/);
});

test('a missing balance never presents the full funding requirement as a known transfer amount', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '$1.00' } });
    Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: quotedFlow({ remainingWei: null, status: null }) });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /Checking your funding address/);
    assert.match(html, /Amount to send<\/dt><dd>— ETH/);
    assert.doesNotMatch(html, /<h3>Send/);
    assert.match(html, /data-funding-next[^>]*disabled/);
});

test('an expired quote hides stale transfer instructions and disables Next while refreshing', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '$1.00' } });
    const flow = quotedFlow({ ready: true });
    flow.fee.expiresAt = Date.now() - 1;
    Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: flow });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /Refreshing the network fee estimate/);
    assert.doesNotMatch(html, /<h3>Send|data-funding-next|0\.0055 ETH/);
    assert.match(html, /data-funding-address/);
});

test('a definitely unsubmitted saved deposit refreshes its quote with the original amount locked', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '$10.00',
        config: { funding: {}, pending_deposit: { phase: 'prepared', amount: 5000000, funding_quote_available: true } } } });
    Object.assign(owner, { view: 'fund', isOpen: true, fundingUsdAmount: '999', fundingFlow: quotedFlow({
        ready: true, remainingWei: '0', status: { ethBalance: '5500000000000000' }
    }) });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /data-funding-usd[^>]*value="10" readonly/);
    assert.doesNotMatch(html, /value="999"/);
    assert.match(html, /saved deposit keeps its original ETH amount/);
    assert.match(html, /Estimated actual network fee/);
    assert.doesNotMatch(html, /data-funding-next[^>]*disabled/);
});

test('a saved ETH deposit from MetaMask shows its fixed principal and current USD without an invented dollar input', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '$12.50',
        config: { pending_deposit: { phase: 'prepared', amount: 5000000, funding_quote_available: true } } } });
    const flow = quotedFlow();
    flow.intent = { ...flow.intent, usdAmount: null, source: 'saved-deposit' };
    Object.assign(owner, { view: 'fund', isOpen: true, fundingUsdAmount: '999', fundingFlow: flow });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /aria-label="Saved deposit amount"/);
    assert.match(html, /data-funding-eth[^>]*value="0\.005" readonly/);
    assert.match(html, /saved deposit keeps its original ETH amount/);
    assert.match(html, /Estimated actual network fee/);
    assert.doesNotMatch(html, /data-funding-usd|value="999"|value="" readonly/);
    owner.fundingFlow.intent = null;
    const loading = controls.renderFundingAccount(owner);
    assert.match(loading, /data-funding-eth[^>]*value="0\.005" readonly/);
    assert.doesNotMatch(loading, /data-funding-usd/);
});

test('a quotable saved address deposit omits the legacy resume button that lacks its displayed fee limit', () => {
    const f = fixture({ client: { isNativeEthFunding: true,
        config: { pending_deposit: { phase: 'prepared', amount: 5000000, funding_quote_available: true } } } });
    const text = fs.readFileSync(new URL('../../chat/zkapi/components/AccountModal.js', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\n/gm, '').replace('export default class AccountModal', 'class AccountModal');
    const AccountModal = vm.runInNewContext(`${text}\nAccountModal;`, f.context);
    const account = Object.create(AccountModal.prototype);
    Object.assign(account, { busy: false, renderOutcome: () => 'saved status', renderWithdrawalStatusLink: () => '' });
    const html = account.renderBalance();
    assert.equal(html, 'saved status');
    assert.doesNotMatch(html, /zkapi-deposit-btn|Resume with MetaMask/);
});

test('explicit address retry preparation cannot sign and returns to the quoted funding review', async () => {
    const f = fixture({ client: { isNativeEthFunding: true,
        config: { pending_deposit: { phase: 'ambiguous', funding_quote_available: false } } } });
    let prepared = 0;
    f.context.zkapiClient.prepareDepositRetry = async report => {
        prepared++;
        assert.equal(typeof report, 'function');
        f.context.zkapiClient.config.pending_deposit = { phase: 'retry_exact', funding_quote_available: true };
        return { status: 'retry_exact', operationId: 'saved' };
    };
    f.context.zkapiClient.deposit = () => assert.fail('review must not submit');
    f.context.stopFundingFlow = owner => { owner.fundingFlow = null; };
    const text = fs.readFileSync(new URL('../../chat/zkapi/components/AccountModal.js', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\n/gm, '').replace('export default class AccountModal', 'class AccountModal');
    const AccountModal = vm.runInNewContext(`${text}\nAccountModal;`, f.context);
    const account = Object.create(AccountModal.prototype);
    Object.assign(account, { busy: false, fundingFlow: { ready: true },
        setStatus(value) { this.status = value; },
        async run(action, details) {
            assert.equal(details.phase, 'local', 'review never enters provider signing authorization');
            await action(() => {});
        }, renderOutcome: () => '', renderWithdrawalStatusLink: () => '' });
    await account.prepareAddressDepositRetry();
    assert.equal(prepared, 1);
    assert.equal(account.view, 'fund');
    assert.equal(account.fundingFlow, null);
    assert.match(account.status, /Check the updated fee estimate before choosing Next/);
    const html = account.renderBalance();
    assert.match(html, /retry keeps the original deposit transaction/);
    assert.match(html, /id="zkapi-check-deposit-btn"/);
    assert.doesNotMatch(html, /id="zkapi-deposit-btn"/);
});

test('an exact saved retry cannot proceed when its original transaction no longer simulates', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true,
        config: { pending_deposit: { phase: 'retry_exact', amount: 5000000, funding_quote_available: true } } } });
    Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: quotedFlow({
        fee: null, totalWei: null, remainingWei: null, ready: false,
        error: 'The saved deposit could not be simulated. Check payment status before retrying.'
    }) });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /saved deposit could not be simulated/);
    assert.match(html, /data-funding-usd[^>]*readonly/);
    assert.doesNotMatch(html, /data-funding-next/);
});

for (const phase of ['prepared', 'retry_exact']) {
    test(`an older ${phase} address deposit has status recovery instead of an unquoted submit button`, () => {
        const f = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '$10.00',
            config: { pending_deposit: { phase, funding_quote_available: false } } } });
        const text = fs.readFileSync(new URL('../../chat/zkapi/components/AccountModal.js', import.meta.url), 'utf8')
            .replace(/^import[\s\S]*?;\n/gm, '').replace('export default class AccountModal', 'class AccountModal');
        const AccountModal = vm.runInNewContext(`${text}\nAccountModal;`, f.context);
        const account = Object.create(AccountModal.prototype);
        Object.assign(account, { busy: false, renderOutcome: () => '', renderWithdrawalStatusLink: () => '' });
        const html = account.renderBalance();
        assert.match(html, /id="zkapi-check-deposit-btn"/);
        assert.doesNotMatch(html, /id="zkapi-deposit-btn"/);
        if (phase === 'retry_exact') assert.match(html, /id="zkapi-retry-deposit-btn"[^>]*>Review fees for saved retry/);
        else assert.doesNotMatch(html, /id="zkapi-retry-deposit-btn"/);
    });
}

for (const pending of [
    { phase: 'prepared', funding_quote_available: false },
    { phase: 'prepared' },
    { phase: 'retry_exact', funding_quote_available: false },
    { phase: 'submitted', funding_quote_available: false },
    { phase: 'ambiguous', funding_quote_available: false }
]) {
    test(`${pending.phase} without an SDK quote capability keeps existing recovery, never inferred quote readiness`, () => {
        const { controls, owner } = fixture({ client: { isNativeEthFunding: true,
            config: { funding: {}, pending_deposit: pending } } });
        Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: quotedFlow({ ready: true }) });
        const html = controls.renderFundingAccount(owner);
        assert.doesNotMatch(html, /data-funding-usd|data-funding-next|Estimated actual network fee/);
    });
}

test('a saved signed transaction overrides the SDK unsubmitted flag and keeps its recovery controls', () => {
    const { controls, owner } = fixture({ wallet: { hasPendingTransaction: true }, client: { isNativeEthFunding: true,
        config: { funding: {}, pending_deposit: { phase: 'prepared', amount: 5000000, funding_quote_available: true } } } });
    Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: quotedFlow({ ready: true }) });
    const html = controls.renderFundingAccount(owner);
    assert.doesNotMatch(html, /data-funding-next|data-funding-usd/);
    assert.match(html, /data-funding-recover/);
});

test('Welcome keeps saved deposits on its balance-dialog handoff instead of starting a second quote flow', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true,
        config: { funding: {}, pending_deposit: { phase: 'prepared', amount: 5000000, funding_quote_available: true } } } });
    Object.assign(owner, { view: undefined, isOpen: true, resumeSavedDeposit() {}, fundingFlow: quotedFlow({ ready: true }) });
    assert.doesNotMatch(controls.renderFundingAccount(owner), /data-funding-next|data-funding-usd/);
});

test('stale USD pricing leaves exact ETH fees visible without a fictitious conversion', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '—' } });
    Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: quotedFlow() });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /Estimated actual network fee<\/dt><dd>0\.0004 ETH<\/dd>/);
    assert.doesNotMatch(html, /≈ —|NaN|undefined/);
});

test('a confirmed deposit displays its receipt fee separately from the current public balance after reopening', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '$1.00',
        note: { note_id: 3 }, deposits: [
            { status: 'confirmed', noteId: 2, fundingAddress: recipient, feeWei: '999000000000000000' },
            { status: 'confirmed', noteId: 3, fundingAddress: recipient, feeWei: '350000000000000' }
        ] } });
    Object.assign(owner, { view: 'balance', isOpen: true, fundingStatus: { ethBalance: '250000000000000' } });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /Actual deposit network fee<\/dt><dd>0\.00035 ETH/);
    assert.match(html, /Currently at this address: 0\.00025 ETH/);
    assert.match(html, /may also hold ETH from other transfers/);
    assert.doesNotMatch(html, /0\.999 ETH/);
    owner.fundingFlow = { status: { ethBalance: '5500000000000000' } };
    owner.fundingStatus = owner.fundingFlow.status;
    const transitioning = controls.renderFundingAccount(owner);
    assert.match(transitioning, /Actual deposit network fee<\/dt><dd>0\.00035 ETH/);
    assert.match(transitioning, /Currently at this address: — ETH/);
    assert.doesNotMatch(transitioning, /0\.0055 ETH/);
});

test('confirmation without a matched account receipt never invents a paid fee or leftover amount', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, note: { note_id: 3 },
        deposits: [{ status: 'confirmed', noteId: 3, fundingAddress: '0x3333333333333333333333333333333333333333', feeWei: '350000000000000' }] } });
    Object.assign(owner, { view: 'balance', isOpen: true, fundingStatus: null });
    const html = controls.renderFundingAccount(owner);
    assert.doesNotMatch(html, /Actual deposit network fee|unused fee buffer remains|0\.00035 ETH/);
    assert.match(html, /Currently at this address: — ETH/);
});

test('closing a private note leaves public ETH return controls accessible in the new-deposit view', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, note: null, formatMoney: () => '$10.00' } });
    Object.assign(owner, { view: 'balance', isOpen: true, fundingStatus: { ethBalance: '15208600000000000' } });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /Amount to add to your wallet/);
    assert.match(html, /Return funds held at this address/);
    assert.match(html, /data-funding-return-eth/);
    assert.doesNotMatch(html, /<details[^>]*open/);
    owner.fundingFlow = { status: { ethBalance: '15208600000000000' }, ready: false };
    assert.match(controls.renderFundingAccount(owner), /Return funds held at this address/);
    owner.fundingFlow.status.ethBalance = '0';
    owner.fundingStatus.ethBalance = '0';
    assert.match(controls.renderFundingAccount(owner), /Return funds held at this address/);
});

test('public ETH return is available without a saved intent, USD price or successful balance read', () => {
    const failIfCalled = () => assert.fail('rendering recovery must never create, poll or sign');
    const { controls, owner } = fixture({ wallet: { ensureAddress: failIfCalled, getStatus: failIfCalled, withAuthorizedAction: failIfCalled },
        client: { isNativeEthFunding: true, note: null, quoteDepositUsd: failIfCalled } });
    Object.assign(owner, { view: 'balance', isOpen: true, fundingStatus: null,
        fundingFlow: { intent: null, status: null, error: 'The ETH/USD reference price is unavailable.', ready: false } });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /ETH\/USD reference price is unavailable/);
    assert.match(html, /Return funds held at this address/);
    assert.match(html, /data-funding-return-eth/);
    assert.match(html, new RegExp(`data-funding-address[^>]*value="${recipient}"`));
    assert.doesNotMatch(html, /<details[^>]*open/);
    assert.doesNotMatch(html, /data-funding-next/);
});

test('a saved withdrawal shows its durable recipient read-only and escapes drafts', () => {
    const { controls, owner } = fixture({ client: { config: { prepared_withdrawal: { destination: recipient }, funding: {} } } });
    owner.fundingDestination = '<script>wrong destination</script>';
    owner.fundingReturnDestination = '"><script>draft</script>';
    const html = controls.renderFundingAccount(owner);
    assert.match(html, new RegExp(`data-funding-withdrawal-destination[^>]*value="${recipient}" readonly`));
    assert.match(html, /This withdrawal keeps its saved destination/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&quot;&gt;&lt;script&gt;draft/);
});

test('a saved transaction disables method switching and retains recovery controls', () => {
    const { controls, owner } = fixture({ wallet: { hasPendingTransaction: true } });
    const method = controls.renderWalletMethod(owner);
    assert.match(method, /data-wallet-method="metamask"[^>]*disabled/);
    assert.match(method, /data-wallet-method="address"[^>]*disabled/);
    const account = controls.renderFundingAccount(owner);
    assert.match(account, /data-funding-recover/);
    assert.doesNotMatch(account, /low network fees|take longer|slow/i);
});

test('legacy migration captures the existing password locally and never stores it on the owner', async () => {
    const actions = [];
    const f = fixture({ wallet: {
        migrationRequired: true,
        async migrateLegacy(password) { actions.push(['migrate', password]); }
    } });
    const html = f.controls.renderFundingAccount(f.owner);
    assert.match(html, /data-funding-legacy-password type="password"/);
    assert.doesNotMatch(html, /type="password"[^>]*value=/);
    assert.doesNotMatch(html, /backup|data-funding-create|data-funding-restore/i);
    f.field('legacy-password', 'a sufficiently long password');
    const button = f.field('migrate');
    f.owner.render = () => { f.field('legacy-password', ''); };
    f.controls.attachWalletMethodControls(f.owner);
    await button.events.click();
    assert.deepEqual(actions, [['migrate', 'a sufficiently long password']]);
    assert.equal(f.owner.fundingError, '');
    assert.equal(f.owner.fundingBusy, false);
    assert.equal(JSON.stringify(f.owner).includes('a sufficiently long password'), false);
});

test('failed legacy migration preserves the old address and reports the failure without attempting setup', async () => {
    const f = fixture({ wallet: {
        migrationRequired: true,
        async migrateLegacy() { throw new Error('Existing password is incorrect.'); },
        async ensureAddress() { assert.fail('failed migration cannot create another address'); }
    } });
    f.field('legacy-password', 'incorrect password');
    const button = f.field('migrate');
    f.controls.attachWalletMethodControls(f.owner);
    await button.events.click();
    assert.equal(f.owner.fundingError, 'Existing password is incorrect.');
    assert.equal(f.wallet.address, recipient);
    assert.equal(f.wallet.migrationRequired, true);
});

test('returning tokens snapshots the destination and exact amount before the UI rerenders', async () => {
    const calls = [];
    const f = fixture({ wallet: {
        async withAuthorizedAction(auth, action) { calls.push(JSON.parse(JSON.stringify(auth))); return action(); },
        async transferTokens(to, units) { calls.push({ to, units }); return '0xtransaction'; },
        async getStatus() { return { tokenBalance: '0', ethBalance: '1' }; }
    } });
    f.field('return-destination', recipient);
    f.field('return-amount', '1.123456');
    const button = f.field('return-token');
    f.owner.render = () => { f.field('return-destination', 'invalid'); f.field('return-amount', '999'); };
    f.controls.attachWalletMethodControls(f.owner);
    await button.events.click();
    assert.equal(f.owner.fundingError, '');
    assert.deepEqual(calls, [
        { kind: 'sweep', destination: recipient, asset: 'token', amount: '1123456' },
        { to: recipient, units: '1123456' }
    ]);
});

test('declining a public-fund return never authorizes or invokes the signer', async () => {
    let called = false;
    const f = fixture({ confirm: () => false, wallet: { async withAuthorizedAction() { called = true; } } });
    f.field('return-destination', recipient);
    f.field('return-amount', '2');
    const button = f.field('return-token');
    f.controls.attachWalletMethodControls(f.owner);
    await button.events.click();
    assert.equal(called, false);
    assert.equal(f.owner.fundingError, '');
});

for (const [draft, amount] of [['0.010000000000000001', '10000000000000001'], [' ', 'max']]) {
    test(`ETH return authorizes and sends the same ${amount === 'max' ? 'remaining balance' : 'exact wei amount'}`, async () => {
        const calls = [];
        const confirmations = [];
        const f = fixture({ confirm: text => { confirmations.push(text); return true; }, wallet: {
            async withAuthorizedAction(auth, action) { calls.push(JSON.parse(JSON.stringify(auth))); return action(); },
            async transferEth(to, units) { calls.push({ to, units }); return '0xethtransaction'; },
            async getStatus() { return { tokenBalance: '0', ethBalance: '1' }; }
        } });
        f.field('return-destination', recipient);
        f.field('return-amount', '999');
        f.field('return-eth-amount', draft);
        const button = f.field('return-eth');
        f.owner.render = () => { f.field('return-destination', 'invalid'); f.field('return-eth-amount', '42'); };
        f.controls.attachWalletMethodControls(f.owner);
        await button.events.click();
        assert.equal(f.owner.fundingError, '');
        assert.deepEqual(calls, [
            { kind: 'sweep', destination: recipient, asset: 'eth', amount },
            { to: recipient, units: amount }
        ]);
        assert.match(confirmations[0], amount === 'max' ? /remaining ETH after reserving network fees \(a small balance may remain\)/ : /0\.010000000000000001 ETH/);
    });
}

test('hydration and received-funds renders never submit; only an explicit Next click invokes the deposit', async () => {
    const f = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '$10.00' } });
    Object.assign(f.owner, { view: 'fund', isOpen: true });
    let starts = 0;
    let submits = 0;
    f.context.AddressDepositFlow = class {
        constructor() { this.ready = true; }
        start(value) { starts++; assert.equal(value, '10.00'); }
    };
    f.owner.submitAddressDeposit = async () => { submits++; };
    const button = f.field('next');
    f.controls.attachWalletMethodControls(f.owner);
    assert.equal(starts, 0, 'hydration waits until render bindings are attached');
    f.flushMicrotasks();
    assert.equal(starts, 1);
    f.controls.renderFundingAccount(f.owner);
    f.controls.attachWalletMethodControls(f.owner);
    f.flushMicrotasks();
    assert.equal(starts, 1, 'rerender retains the same polling controller');
    assert.equal(submits, 0);
    await button.events.click();
    assert.equal(submits, 1);
});

test('editing USD disables Next immediately and debounces quote calculation without signing', async () => {
    const f = fixture();
    const amounts = [];
    let invalidated = 0;
    f.owner.fundingFlow = { invalidate() { invalidated++; }, setAmount(value, currency) { amounts.push([value, currency]); } };
    const usd = f.field('amount', '10');
    const next = f.field('next');
    next.disabled = false;
    f.controls.attachWalletMethodControls(f.owner);
    usd.events.input({ target: { value: '12' } });
    usd.events.input({ target: { value: '12.50' } });
    assert.equal(next.disabled, true);
    assert.equal(invalidated, 2);
    assert.deepEqual(amounts, []);
    assert.equal(f.timers.size, 1);
    [...f.timers.values()][0]();
    assert.deepEqual(amounts, [['12.50', 'usd']]);
});



test('editing an amount immediately hides stale transfer instructions before the debounce finishes', () => {
    const f = fixture({ client: { isNativeEthFunding: true } });
    Object.assign(f.owner, { isOpen: true, view: 'fund', disclosureAnimating: true, fundingFlow: quotedFlow({
        invalidate() { this.dirty = true; this.ready = false; this.fee = null; }
    }) });
    const amount = f.field('amount');
    const renders = [];
    f.owner.render = () => renders.push(f.controls.renderFundingAccount(f.owner));
    f.controls.attachWalletMethodControls(f.owner);
    amount.events.input({ target: { value: '12' } });
    assert.equal(renders.length, 1);
    assert.match(renders[0], /Updating the ETH amount/);
    assert.doesNotMatch(renders[0], /zkapi-funding-send-number|data-funding-next|0\.0055 ETH/);
    assert.equal(f.timers.size, 1);
});

test('an unavailable initial USD quote can switch to a blank ETH draft without a ten ETH default', async () => {
    const f = fixture();
    const calls = [];
    const flow = { intent: null, dirty: true, requestedAmount: { value: '10', currency: 'usd' },
        invalidate() { calls.push('invalidate'); },
        async setAmount(value, currency) { calls.push([value, currency]); this.error = 'Enter ETH'; return false; },
        setCurrency() { assert.fail('there is no principal to convert yet'); } };
    Object.assign(f.owner, { isOpen: true, fundingFlow: flow, fundingInputCurrency: 'usd', fundingInputAmount: '10' });
    const button = f.field('currency');
    f.controls.attachWalletMethodControls(f.owner);
    await button.events.click();
    assert.deepEqual(calls, ['invalidate', ['', 'eth']]);
    assert.equal(f.owner.fundingInputCurrency, 'eth');
    assert.equal(f.owner.fundingInputAmount, '');
    assert.equal(flow.error, '');
});

test('ETH edits debounce in their selected unit without going through the USD quote path', () => {
    const f = fixture();
    const calls = [];
    f.owner.fundingInputCurrency = 'eth';
    f.owner.fundingFlow = { invalidate() {}, setAmount(...args) { calls.push(args); } };
    const amount = f.field('amount');
    f.controls.attachWalletMethodControls(f.owner);
    amount.events.input({ target: { value: '0.005000001' } });
    [...f.timers.values()][0]();
    assert.deepEqual(calls, [['0.005000001', 'eth']]);
    assert.equal(f.owner.fundingInputAmount, '0.005000001');
});

test('a clean currency switch renders immediately even during disclosure motion and preserves principal and focus', async () => {
    const f = fixture();
    const calls = [];
    const flow = quotedFlow({ dirty: false,
        setAmount() { assert.fail('unit switching must not reprice a valid principal'); },
        async setCurrency(currency) {
            calls.push(currency);
            this.intent = { ...this.intent, inputCurrency: currency, inputAmount: this.intent.ethAmount };
            return true;
        } });
    Object.assign(f.owner, { isOpen: true, fundingFlow: flow, fundingInputCurrency: 'usd', fundingInputAmount: '10', disclosureAnimating: true });
    const renderedCurrencies = [];
    f.owner.render = () => renderedCurrencies.push(f.owner.fundingInputCurrency);
    const button = f.field('currency');
    let focuses = 0;
    button.focus = () => focuses++;
    f.context.document.activeElement = button;
    f.controls.attachWalletMethodControls(f.owner);
    await button.events.click();
    assert.deepEqual(calls, ['eth']);
    assert.equal(flow.intent.depositWei, '5000000000000000');
    assert.equal(f.owner.fundingInputCurrency, 'eth');
    assert.equal(f.owner.fundingInputAmount, '0.005');
    assert.equal(f.owner.fundingBusy, false);
    assert.equal(focuses, 1);
    assert.deepEqual(renderedCurrencies, ['usd', 'eth'], 'explicit currency action never waits for disclosure completion');
});

test('switching after typing saves with the loaded price and skips chain checks before conversion', async () => {
    const f = fixture();
    const calls = [];
    let finishQuote;
    const flow = quotedFlow({ dirty: false,
        invalidate() { this.dirty = true; },
        setAmount(amount, currency, options) {
            assert.equal(options.check, false);
            assert.equal(options.useCachedPrice, true);
            calls.push(['amount', amount, currency]);
            return new Promise(resolve => { finishQuote = () => {
                this.dirty = false;
                this.intent = { ...this.intent, usdAmount: amount, ethAmount: '0.00625' };
                resolve(true);
            }; });
        },
        async setCurrency(currency) {
            calls.push(['currency', currency]);
            this.intent = { ...this.intent, inputCurrency: currency, inputAmount: this.intent.ethAmount };
            return true;
        } });
    Object.assign(f.owner, { isOpen: true, fundingFlow: flow });
    const amount = f.field('amount');
    const button = f.field('currency');
    f.controls.attachWalletMethodControls(f.owner);
    amount.events.input({ target: { value: '12.50' } });
    const switched = button.events.click();
    assert.deepEqual(calls, [['amount', '12.50', 'usd']]);
    assert.equal(f.timers.size, 0);
    assert.equal(f.owner.fundingBusy, true);
    await button.events.click();
    assert.equal(calls.length, 1, 'a second click cannot race the active conversion');
    finishQuote();
    await switched;
    assert.deepEqual(calls, [['amount', '12.50', 'usd'], ['currency', 'eth']]);
    assert.equal(f.owner.fundingInputAmount, '0.00625');
    assert.equal(f.owner.fundingInputCurrency, 'eth');
});

test('an invalid draft does not switch units or fall back to a previous valid amount', async () => {
    const f = fixture();
    const flow = quotedFlow({ dirty: true,
        async setAmount(amount, currency) { assert.equal(amount, 'invalid'); assert.equal(currency, 'eth'); return false; },
        setCurrency() { assert.fail('invalid drafts must not convert the previous principal'); } });
    Object.assign(f.owner, { isOpen: true, fundingFlow: flow, fundingInputCurrency: 'eth', fundingInputAmount: 'invalid' });
    const button = f.field('currency');
    f.controls.attachWalletMethodControls(f.owner);
    await button.events.click();
    assert.equal(f.owner.fundingInputCurrency, 'eth');
    assert.equal(f.owner.fundingInputAmount, 'invalid');
    assert.equal(f.owner.fundingBusy, false);
});

test('a late unit conversion cannot write its display into a replaced or closed flow', async () => {
    const f = fixture();
    let finish;
    const flow = quotedFlow({ dirty: false, setCurrency() { return new Promise(resolve => { finish = resolve; }); } });
    Object.assign(f.owner, { isOpen: true, fundingFlow: flow, fundingInputCurrency: 'usd', fundingInputAmount: '10' });
    const button = f.field('currency');
    f.controls.attachWalletMethodControls(f.owner);
    const switched = button.events.click();
    f.owner.isOpen = false;
    f.owner.fundingFlow = null;
    flow.intent = { ...flow.intent, inputCurrency: 'eth', inputAmount: '0.005' };
    finish(true);
    await switched;
    assert.equal(f.owner.fundingInputCurrency, 'usd');
    assert.equal(f.owner.fundingInputAmount, '10');
});

test('hydration restores the persisted denomination and exact input without a new amount edit', () => {
    const f = fixture();
    let changes;
    f.context.AddressDepositFlow = class {
        constructor({ changed }) { changes = changed; }
        start() {
            this.intent = { ...quotedFlow().intent, usdAmount: null, source: 'eth-input', inputCurrency: 'eth', inputAmount: '0.005000001' };
            changes();
        }
    };
    Object.assign(f.owner, { view: 'fund', isOpen: true, fundingUsdAmount: '99' });
    f.controls.attachWalletMethodControls(f.owner);
    f.flushMicrotasks();
    assert.equal(f.owner.fundingInputCurrency, 'eth');
    assert.equal(f.owner.fundingInputAmount, '0.005000001');
    assert.equal(f.owner.fundingUsdAmount, null);
});

test('currency-specific input IDs prevent preserving a USD node after an ETH switch', () => {
    const f = fixture();
    const oldInput = { id: 'funding-usd', matches: () => true, value: '10' };
    f.context.document.activeElement = oldInput;
    f.owner.overlay.contains = () => true;
    const saved = f.controls.captureWalletView(f.owner);
    assert.equal(saved.preservedInput, oldInput);
    const eth = { id: 'funding-eth', value: '0.005', replaceWith() { assert.fail('old USD input must not replace ETH input'); } };
    f.owner.overlay.querySelector = selector => selector === '#funding-eth' ? eth : null;
    f.controls.restoreWalletView(f.owner, saved);
    assert.equal(eth.value, '0.005');
});

test('a saved deposit ignores amount edits, including dispatched input events on its readonly field', () => {
    const f = fixture({ client: { config: { pending_deposit: { funding_quote_available: true } } } });
    f.owner.fundingUsdAmount = '10';
    f.owner.fundingFlow = { invalidate() { assert.fail('saved amount must stay fixed'); } };
    const input = f.field('amount', '10');
    f.controls.attachWalletMethodControls(f.owner);
    input.events.input({ target: { value: '20' } });
    assert.equal(f.owner.fundingUsdAmount, '10');
    assert.equal(f.timers.size, 0);
});

test('preserving a focused amount input applies its new readonly saved-deposit state and value', () => {
    const f = fixture();
    const saved = { id: 'funding-usd', preservedInput: { value: '999', focus() {} } };
    const rendered = { disabled: false, readOnly: true, value: '10', replaceWith(node) { this.replacement = node; } };
    f.owner.overlay.querySelector = selector => selector === '#funding-usd' ? rendered : null;
    f.controls.restoreWalletView(f.owner, saved);
    assert.equal(rendered.replacement, saved.preservedInput);
    assert.equal(saved.preservedInput.readOnly, true);
    assert.equal(saved.preservedInput.value, '10');
});

test('view snapshots never retain password values or password focus state', () => {
    const f = fixture();
    f.context.document.activeElement = { id: 'funding-password', value: 'must remain only in input', selectionStart: 3,
        selectionEnd: 3, matches: () => false };
    f.owner.overlay.contains = () => true;
    const snapshot = f.controls.captureWalletView(f.owner);
    assert.equal(snapshot.id, null);
    assert.equal(JSON.stringify(snapshot).includes('must remain only in input'), false);
});

test('background provider updates preserve a password being typed without saving it on the owner', () => {
    const f = fixture();
    f.owner.isOpen = true;
    f.context.document.activeElement = { type: 'password', value: 'secret being typed' };
    let renders = 0;
    f.owner.render = () => { renders++; };
    f.controls.refreshWalletView(f.owner);
    assert.equal(renders, 0);
    assert.equal(JSON.stringify(f.owner).includes('secret being typed'), false);
    f.context.document.activeElement = null;
    f.controls.refreshWalletView(f.owner);
    assert.equal(renders, 1);
});

test('copy remains usable while funding waits without changing the active action or rerendering', async () => {
    const f = fixture();
    const copied = [];
    f.context.navigator.clipboard.writeText = async value => { copied.push(value); };
    f.owner.busy = true;
    f.owner.fundingWait = new AbortController();
    f.owner.render = () => { assert.fail('copy must not replace the funding wait UI'); };
    const notice = f.field('notice');
    const button = f.field('copy');
    f.controls.attachWalletMethodControls(f.owner);
    await button.events.click();
    assert.deepEqual(copied, [recipient]);
    assert.equal(notice.textContent, 'Funding address copied.');
    assert.equal(f.owner.busy, true);
    assert.equal(f.owner.fundingBusy, false);
    assert.equal(f.owner.fundingWait.signal.aborted, false);
});

test('a denied clipboard permission selects the funding address without interrupting its wait', async () => {
    const f = fixture();
    f.context.navigator.clipboard.writeText = async () => { throw new Error('permission denied'); };
    f.owner.busy = true;
    const address = f.field('address', recipient);
    const selected = [];
    address.focus = () => selected.push('focus');
    address.select = () => selected.push('select');
    const notice = f.field('notice');
    const button = f.field('copy');
    f.controls.attachWalletMethodControls(f.owner);
    await button.events.click();
    assert.deepEqual(selected, ['focus', 'select']);
    assert.match(notice.textContent, /Copy the selected address/);
    assert.equal(f.owner.busy, true);
});

test('both wallet surfaces present stopped funding as a neutral outcome', async () => {
    const stopped = Object.assign(new Error('Stopped waiting for funds. Your funding address is saved.'), { code: 'address_wait_stopped' });
    const completed = [];
    const context = {
        prepareWalletMethod: async () => {}, getWalletMethod: () => 'address', walletMethodText: value => value,
        runAddressAction: async () => { throw stopped; }, isIndexerLag: () => false, explainZkapiError: () => {},
        pendingDepositMessage: () => null,
        walletErrorMessage: error => error.message,
        zkapiClient: {
            beginActivity: () => 'activity', updateActivity: (...args) => completed.push(args),
            completeActivity: () => assert.fail('stopping a funding wait is not a completed deposit'),
            failActivity: () => assert.fail('stopping a funding wait is not an error activity')
        }
    };
    const loadClass = name => {
        const text = fs.readFileSync(new URL(`../../chat/zkapi/components/${name}.js`, import.meta.url), 'utf8')
            .replace(/^import[\s\S]*?;\n/gm, '').replace(`export default class ${name}`, `class ${name}`);
        return vm.runInNewContext(`${text}\n${name};`, { ...context });
    };
    const account = Object.create(loadClass('AccountModal').prototype);
    Object.assign(account, { busy: false, view: 'fund', render() {}, rememberRunningModal() {},
        setStatus(message, error) { this.status = message; this.statusError = error; } });
    await account.run(async () => assert.fail('the SDK action must not start'), { kind: 'deposit', phase: 'wallet' });
    assert.equal(account.status, stopped.message);
    assert.equal(account.statusError, false);
    assert.equal(account.outcome.tone, 'info');
    assert.equal(account.busy, false);
    assert.equal(completed[0][1].title, 'Stopped waiting for funds');
    assert.equal(completed[0][1].status, 'pending');

    const welcome = Object.create(loadClass('WelcomePanel').prototype);
    Object.assign(welcome, { busy: false, overlay: { querySelector: () => ({ value: '2' }) }, render() {} });
    await welcome.fund();
    assert.equal(welcome.fundingNotice, stopped.message);
    assert.equal(welcome.error, '');
    assert.equal(welcome.step, 'welcome');
    assert.equal(welcome.busy, false);
});

for (const state of [{ note: {} }, { config: { pending_deposit: { phase: 'prepared' } } }]) {
    test(`restored ${state.note ? 'private balance' : 'saved deposit'} polls public ETH without creating or signing`, async () => {
        let calls = 0;
        const f = fixture({ client: state, wallet: {
            async getStatus() { calls++; return { ethBalance: String(calls) }; },
            ensureAddress() { assert.fail('status must not create an address'); },
            withAuthorizedAction() { assert.fail('status must not authorize signing'); }
        } });
        f.owner.isOpen = true;
        f.controls.attachWalletMethodControls(f.owner);
        f.flushMicrotasks();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.owner.fundingStatus.ethBalance, '1');
        const callback = [...f.timers.values()][0];
        f.timers.clear();
        await callback();
        assert.equal(f.owner.fundingStatus.ethBalance, '2');
        f.owner.isOpen = false;
        await [...f.timers.values()][0]();
        assert.equal(calls, 2, 'closed view makes no new read');
    });
}

test('a late public ETH response cannot repopulate a closed view', async () => {
    let resolve;
    const f = fixture({ client: { note: {} }, wallet: {
        getStatus() { return new Promise(done => { resolve = done; }); }
    } });
    f.owner.isOpen = true;
    f.controls.attachWalletMethodControls(f.owner);
    f.flushMicrotasks();
    f.owner.isOpen = false;
    resolve({ ethBalance: '99' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.owner.fundingStatus, null);
    assert.equal(f.timers.size, 0);
});

test('public status retries after a storage failure clears cached custody', async () => {
    let calls = 0;
    const f = fixture({ client: { note: {} }, wallet: {
        async getStatus() {
            if (++calls === 1) {
                this.address = null;
                this.unlocked = false;
                throw new Error('storage temporarily unavailable');
            }
            this.address = recipient;
            this.unlocked = true;
            return { ethBalance: '42' };
        }
    } });
    f.owner.isOpen = true;
    f.owner.render = () => f.controls.attachWalletMethodControls(f.owner);
    f.controls.attachWalletMethodControls(f.owner);
    f.flushMicrotasks();
    await new Promise(resolve => setImmediate(resolve));
    f.flushMicrotasks();
    assert.match(f.owner.fundingStatusError, /Retrying/);
    await [...f.timers.values()][0]();
    assert.equal(calls, 2);
    assert.equal(f.owner.fundingStatus.ethBalance, '42');
    assert.equal(f.owner.fundingStatusError, '');
});

test('a committed deposit waiting for its balance projection cannot offer another address deposit', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '$10.00' } });
    Object.assign(owner, { view: 'balance', isOpen: true, depositBalanceRefreshPending: true,
        fundingInputCurrency: 'eth', fundingInputAmount: '0.005', fundingFlow: quotedFlow() });
    const html = controls.renderFundingAccount(owner);
    assert.doesNotMatch(html, /Amount to add to your wallet|data-funding-next|data-funding-amount/);
    assert.equal(owner.fundingInputCurrency, 'eth');
    assert.equal(owner.fundingInputAmount, '0.005');
    assert.match(html, /Your funding address/);
});

test('correcting the shared amount clears its validation outcome and preserved accessibility error state', () => {
    const f = fixture({ client: { isNativeEthFunding: true } });
    const field = f.field('amount', '0.005');
    f.owner.outcome = { field: 'deposit', message: 'Enter a valid amount.' };
    f.owner.fundingFlow = { invalidate() {}, setAmount() {} };
    f.controls.attachWalletMethodControls(f.owner);
    field.events.input({ target: field });
    assert.equal(f.owner.outcome, null);
    const attributes = new Map([['aria-invalid', 'true'], ['aria-describedby', 'zkapi-deposit-error']]);
    const preserved = { focus() {}, setSelectionRange() {}, removeAttribute: name => attributes.delete(name),
        setAttribute: (name, value) => attributes.set(name, value) };
    f.owner.overlay.querySelector = selector => selector === '#funding-usd'
        ? { disabled: false, readOnly: false, getAttribute: () => null, replaceWith() {} } : null;
    f.controls.restoreWalletView(f.owner, { id: 'funding-usd', preservedInput: preserved });
    assert.equal(attributes.size, 0);
});

test('quote expiry repaints stale instructions even during a disclosure or pending wallet action', () => {
    const f = fixture({ client: { isNativeEthFunding: true } });
    Object.assign(f.owner, { view: 'fund', isOpen: true });
    let changed;
    f.context.AddressDepositFlow = class {
        constructor(options) { changed = options.changed; }
        start() {}
    };
    let renders = 0;
    f.owner.render = () => { renders++; };
    f.controls.attachWalletMethodControls(f.owner);
    f.flushMicrotasks();
    f.owner.disclosureAnimating = true;
    f.owner.fundingBusy = true;
    changed({ expired: true });
    assert.equal(renders, 1, 'expiry does not wait for another RPC or animation');
});
