import { statusIcon } from '../../chat/zkapi/components/StatusIcon.js';
import { attachWalletModalRestoreCancellation, cancelWalletModalRestore, currentWalletModalRestore, finishWalletModalRestore } from '../../chat/zkapi/components/WalletModalView.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DepositAmount, ethUnits, formatSuggestedDeposit } from '../../chat/zkapi/services/depositAmount.mjs';
import { AddressDepositFlow } from '../../chat/zkapi/services/addressDepositFlow.mjs';
import { formatFundingAmount } from '../../chat/zkapi/services/addressFunding.js';
import { renderFundingProgress } from '../../chat/zkapi/components/FundingProgress.js';
import { parseTokenAmount } from '@openanonymity/zkapi-browser-sdk/wallet';

const source = name => fs.readFileSync(new URL(`../../chat/zkapi/components/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/export (async )?function /g, '$1function ')
    .replace(/export default class /g, 'class ');
const tick = () => new Promise(resolve => setImmediate(resolve));
const address = '0x2222222222222222222222222222222222222222';
const vault = '0x4444444444444444444444444444444444444444';

function fixture(t, { method = 'metamask', input = '10', currency = 'usd' } = {}) {
    const effects = { quotes: 0, addresses: 0, authorizations: 0, deposits: [], qr: [] };
    const records = new Map();
    const client = { isNativeEthFunding: true, suggestedDeposit: 10, note: null,
        config: { funding: { chain_id: 1, contract_address: vault } },
        nativePriceQuote: { answer: '300000000000', decimals: 8, updated_at: 1 },
        networkName: () => 'Ethereum Mainnet', formatMoney: () => '$10.00',
        async quoteDepositUsd(value) {
            effects.quotes++;
            const model = new DepositAmount({ client: this });
            model.running = true; model.scope = 'quote';
            if (!await model.setAmount(value, 'usd', { useCachedPrice: true })) throw new Error(model.error);
            return model.intent;
        },
        async deposit(amount) { effects.deposits.push(amount); return { status: 'confirmed' }; }
    };
    const wallet = { address: null, unlocked: true, exists: false, hasPendingTransaction: false,
        async ensureAddress() { effects.addresses++; this.address = address; return address; },
        async getStatus() { return { ethBalance: '0' }; },
        async getDepositFeeQuote(intent) { return {
            amount: intent.amount, depositWei: intent.depositWei, chainId: 1, contractAddress: vault, address,
            expectedFeeWei: '100', requiredFeeWei: '120', feeBufferWei: '30', feeReserveWei: '150',
            operationId: 'operation', depositCommitment: 'commitment', quotedAt: Date.now(), expiresAt: Date.now() + 60_000
        }; },
        request() { assert.fail('amount entry cannot request a wallet'); }
    };
    const fields = new Map();
    const element = () => ({ events: {}, addEventListener(type, handler) { this.events[type] = handler; } });
    for (const name of ['amount', 'currency']) fields.set(`[data-funding-${name}]`, element());
    const methods = ['metamask', 'address'].map(value => Object.assign(element(), { dataset: { walletMethod: value } }));
    const context = { attachWalletModalRestoreCancellation, cancelWalletModalRestore, currentWalletModalRestore, finishWalletModalRestore, isFundingViewHydrating: () => false, formatFundingAmount, renderFundingProgress, DepositAmount, formatSuggestedDeposit, AddressDepositFlow, ethUnits, parseTokenAmount, zkapiClient: client,
        depositOperationId: () => null, isWalletCancellation: () => false,
        readWelcomeModalIntent: () => null, writeWelcomeModalIntent() {},
        addressFundingWallet: wallet, getWalletMethod: () => method, walletMethodActionBusy: () => false, setWalletMethod: value => { method = value; },
        canQuotePendingAddressDeposit: () => Boolean(client.config.pending_deposit?.funding_quote_available),
        chatDB: { getSetting: async key => records.get(key) ?? null,
            updateSettings: async values => { for (const { key, value } of values) records.set(key, value); },
            compareAndSetSetting: async (key, expected, value) => {
                if (JSON.stringify(records.get(key) ?? null) !== JSON.stringify(expected)) return false;
                records.set(key, value); return true;
            } },
        renderFundingPaymentQr: options => { effects.qr.push(options); return '<svg data-test-qr></svg>'; },
        prepareWalletMethod: async () => { effects.authorizations++; }, walletMethodText: value => value, statusIcon,
        fundingSetupGuide: () => '', pendingDepositMessage: () => '', isIndexerLag: () => false,
        document: { activeElement: null }, queueMicrotask, setTimeout, clearTimeout
    };
    const controls = vm.runInNewContext(`${source('WalletMethodControls')}\n({ renderDepositAmount, renderFundingAccount, renderWalletMethod, attachWalletMethodControls, stopFundingFlow, prepareDepositAmount });`, context);
    const Account = vm.runInNewContext(`(() => { ${source('AccountModal')}\nreturn AccountModal; })()`, context);
    const Welcome = vm.runInNewContext(`(() => { ${source('WelcomePanel')}\nreturn WelcomePanel; })()`, context);
    const owner = { isOpen: true, view: 'fund', step: 'welcome', busy: false, fundingBusy: false,
        fundingInputAmount: input, fundingInputCurrency: currency, escapeHtml: String, render() {},
        overlay: { querySelector: key => fields.get(key) ?? null,
            querySelectorAll: key => key === '[data-wallet-method]' ? methods : [], contains: () => false } };
    t.after(() => controls.stopFundingFlow(owner));
    const hydrate = async () => { controls.attachWalletMethodControls(owner); await tick(); };
    const changeMethod = async value => { await methods.find(button => button.dataset.walletMethod === value).events.click(); await hydrate(); };
    const edit = value => { const input = fields.get('[data-funding-amount]'); input.value = value; input.events.input({ target: input }); };
    const toggle = async () => { await fields.get('[data-funding-currency]').events.click(); await tick(); };
    return { owner, controls, effects, client, wallet, records, hydrate, changeMethod, edit, toggle, Account, Welcome, context };
}

test('one shared amount precedes method choice in both native deposit dialogs', async t => {
    const f = fixture(t);
    await f.hydrate();
    const welcome = Object.assign(Object.create(f.Welcome.prototype), f.owner);
    const html = welcome.renderWelcome();
    assert.equal((html.match(/data-funding-amount\b/g) || []).length, 1);
    assert.ok(html.indexOf('data-funding-amount') < html.indexOf('data-wallet-method'));
    assert.doesNotMatch(html, /welcome-deposit-amount/);
    const accountSource = source('AccountModal');
    assert.ok(accountSource.indexOf('${renderDepositAmount(this)}') < accountSource.indexOf('renderWalletMethod(this)', accountSource.indexOf('${renderDepositAmount(this)}')));
    const account = Object.assign(Object.create(f.Account.prototype), f.owner, {
        renderOutcome: () => '', renderWithdrawalStatusLink: () => '', justCanceled: () => false,
        privateBalanceHelpOpen: {}
    });
    f.context.privateBalanceGuide = () => '';
    assert.doesNotMatch(account.renderBalance(), /zkapi-deposit-amount/);
    assert.doesNotMatch(account.renderBalance(), /Ethereum Mainnet · ETH/);
    assert.equal(f.effects.addresses, 0, 'MetaMask amount hydration never creates a local address');
    assert.equal(f.effects.authorizations, 0);
});

test('USD to ETH and both method switches keep the exact quoted principal through Account submission', async t => {
    const f = fixture(t);
    await f.hydrate();
    assert.equal(f.owner.depositAmountFlow.intent.amount, '3333334');
    await f.toggle();
    assert.equal(f.owner.fundingInputAmount, '0.003333334');
    f.client.nativePriceQuote.answer = '400000000000';
    await f.changeMethod('address');
    assert.equal(f.owner.fundingFlow.intent.amount, '3333334');
    await f.toggle();
    assert.equal(f.owner.fundingInputCurrency, 'usd');
    await f.changeMethod('metamask');
    assert.equal(f.owner.depositAmountFlow.intent.amount, '3333334');
    assert.equal(f.effects.quotes, 1, 'presentation changes do not request a new price');
    const account = Object.assign(Object.create(f.Account.prototype), f.owner, {
        run: action => action(() => {}), recordDepositConfirmation() {}
    });
    await account.startDeposit(account.fundingInputAmount);
    assert.deepEqual(f.effects.deposits, ['0.003333334']);
    assert.equal(f.effects.quotes, 1);
});

test('an exact ETH input reaches Welcome MetaMask submission without an address or USD oracle', async t => {
    const f = fixture(t, { input: '0.000000001', currency: 'eth' });
    f.client.nativePriceQuote = null;
    await f.hydrate();
    const welcome = Object.assign(Object.create(f.Welcome.prototype), f.owner, {
        syncConfirmedDepositBalance() {}, app: { accountModal: {} }
    });
    await welcome.fund();
    assert.deepEqual(f.effects.deposits, ['0.000000001']);
    assert.equal(f.effects.authorizations, 1);
    assert.equal(f.effects.addresses, 0);
    assert.equal(f.effects.quotes, 0);
    assert.equal(welcome.step, 'success');
});

test('invalid native amounts fail before either dialog can authorize a wallet', async t => {
    const f = fixture(t, { input: '0.0000000001', currency: 'eth' });
    await f.hydrate();
    const welcome = Object.assign(Object.create(f.Welcome.prototype), f.owner);
    await welcome.fund();
    assert.match(welcome.error, /9 decimal/);
    const account = Object.assign(Object.create(f.Account.prototype), f.owner, { run() { assert.fail('wallet action'); } });
    await account.startDeposit('0.0000000001');
    assert.match(account.outcome.message, /9 decimal/);
    assert.equal(f.effects.authorizations, 0);
    assert.equal(f.effects.addresses, 0);
    assert.deepEqual(f.effects.deposits, []);
});

test('a dirty draft survives a method switch and replaces an older address-scoped intent', async t => {
    const f = fixture(t);
    await f.hydrate();
    await f.changeMethod('address');
    const original = f.owner.fundingFlow.intent;
    await f.changeMethod('metamask');
    f.edit('23');
    await f.changeMethod('address');
    assert.equal(f.owner.fundingInputAmount, '23');
    assert.equal(f.owner.fundingFlow.intent.usdAmount, '23');
    assert.notEqual(f.owner.fundingFlow.intent.amount, original.amount);
    assert.equal([...f.records.values()][0].usdAmount, '23');
});

test('QR uses exact remaining wei, stays during fee refresh, and clears on edits or full funding', async t => {
    const f = fixture(t, { method: 'address', input: '0.005', currency: 'eth' });
    await f.hydrate();
    f.owner.fundingFlow.status = { ethBalance: '4000000000000000' };
    let html = f.controls.renderFundingAccount(f.owner);
    assert.match(html, /data-test-qr/);
    assert.deepEqual(JSON.parse(JSON.stringify(f.effects.qr.at(-1))), {
        address, chainId: 1, amountWei: '1000000000000150', caption: false
    });
    f.edit('0.006');
    assert.doesNotMatch(f.controls.renderFundingAccount(f.owner), /data-test-qr/);
    await f.owner.fundingFlow.setAmount('0.006', 'eth');
    f.owner.fundingFlow.fee.expiresAt = Date.now() - 1;
    const refreshing = f.controls.renderFundingAccount(f.owner);
    assert.match(refreshing, /data-test-qr/);
    assert.doesNotMatch(refreshing, /data-funding-next/, 'no Deposit while the address still needs ETH');
    f.owner.fundingFlow.fee.expiresAt = Date.now() + 60_000;
    f.owner.fundingFlow.status = { ethBalance: f.owner.fundingFlow.totalWei };
    assert.doesNotMatch(f.controls.renderFundingAccount(f.owner), /data-test-qr/);
});

test('closing while USD resolution is pending never proceeds to wallet authorization', async t => {
    const f = fixture(t);
    let finish;
    f.client.quoteDepositUsd = () => new Promise(resolve => { finish = resolve; });
    await f.hydrate();
    const promise = f.controls.prepareDepositAmount(f.owner);
    f.owner.isOpen = false;
    f.controls.stopFundingFlow(f.owner);
    finish({ amount: '100', ethAmount: '0.0000001', depositWei: '100000000000', usdAmount: '10' });
    await assert.rejects(promise, /changed|amount/);
    assert.equal(f.effects.authorizations, 0);
    assert.deepEqual(f.effects.deposits, []);
});

for (const dialog of ['Account', 'Welcome']) {
    test(`${dialog} locks the visible input and methods before a pending price read`, async t => {
        const f = fixture(t);
        let finish;
        f.client.quoteDepositUsd = () => new Promise(resolve => { finish = resolve; });
        await f.hydrate();
        const renders = [];
        const owner = Object.assign(Object.create(f[dialog].prototype), f.owner, {
            render() { renders.push(f.controls.renderDepositAmount(this) + f.controls.renderWalletMethod(this)); },
            run: action => action(() => {}), recordDepositConfirmation() {}, syncConfirmedDepositBalance() {},
            app: { accountModal: {} }
        });
        const submission = dialog === 'Account' ? owner.startDeposit('10') : owner.fund();
        assert.equal(owner.fundingBusy, true);
        assert.match(renders[0], /data-funding-amount[^>]*disabled/);
        assert.match(renders[0], /data-wallet-method="metamask"[^>]*disabled/);
        assert.equal(f.effects.authorizations, 0);
        finish({ amount: '3333334', ethAmount: '0.003333334', depositWei: '3333334000000000', usdAmount: '10' });
        await submission;
        assert.deepEqual(f.effects.deposits, ['0.003333334']);
    });
}

test('an explicit ETH draft switches units before its debounce without losing its principal', async t => {
    const f = fixture(t);
    let finish;
    f.client.quoteDepositUsd = () => new Promise(resolve => { finish = resolve; });
    await f.hydrate();
    await f.toggle(); // Unavailable initial USD quote permits direct ETH entry.
    assert.equal(f.owner.fundingInputCurrency, 'eth');
    f.edit('0.000000001');
    await f.toggle();
    assert.equal(f.owner.fundingInputCurrency, 'usd');
    assert.equal(f.owner.depositAmountFlow.intent.amount, '1');
    assert.equal(f.owner.fundingInputAmount, '0.000003');
    finish({ amount: '3333334', ethAmount: '0.003333334', depositWei: '3333334000000000', usdAmount: '10' });
    await tick();
    assert.equal(f.owner.depositAmountFlow.intent.amount, '1', 'late initial quote cannot replace the edit');
    await f.toggle();
    assert.equal(f.owner.fundingInputAmount, '0.000000001');
});

test('a failed initial USD read can retry the same input after the oracle recovers', async t => {
    const f = fixture(t);
    const quote = f.client.quoteDepositUsd;
    f.client.quoteDepositUsd = async () => { throw new Error('Temporary price read failure.'); };
    await f.hydrate();
    assert.match(f.owner.depositAmountFlow.error, /Temporary/);
    f.client.quoteDepositUsd = quote;
    assert.equal(await f.controls.prepareDepositAmount(f.owner), '0.003333334');
    assert.equal(f.effects.authorizations, 0);
});


test('rapid switches and a draft stay responsive while an old address fee quote and balance read stall', async t => {
    const f = fixture(t, { input: '0.005', currency: 'eth' });
    await f.hydrate();
    const quote = f.wallet.getDepositFeeQuote;
    const status = f.wallet.getStatus;
    let finishQuote;
    let finishStatus;
    f.wallet.getDepositFeeQuote = async intent => {
        const result = await quote(intent);
        return new Promise(resolve => { finishQuote = () => resolve(result); });
    };
    f.wallet.getStatus = () => new Promise(resolve => { finishStatus = () => resolve({ ethBalance: '0' }); });
    await f.changeMethod('address');
    const oldFlow = f.owner.fundingFlow;
    assert.equal(typeof finishQuote, 'function');
    assert.doesNotMatch(f.controls.renderFundingAccount(f.owner), /<p class="zkapi-helper">Ethereum Mainnet<\/p>/);
    await f.changeMethod('metamask');
    assert.equal(f.owner.fundingBusy, false);
    assert.equal(f.owner.fundingInputAmount, '0.005');
    f.edit('0.007');
    f.wallet.getDepositFeeQuote = quote;
    f.wallet.getStatus = status;
    await f.changeMethod('address');
    const newFlow = f.owner.fundingFlow;
    assert.notEqual(newFlow, oldFlow);
    assert.equal(newFlow.intent.ethAmount, '0.007');
    assert.doesNotMatch(f.controls.renderFundingAccount(f.owner), /On <strong>Ethereum Mainnet/);
    finishQuote();
    finishStatus();
    await tick();
    assert.equal(f.owner.fundingFlow, newFlow);
    assert.equal(newFlow.intent.ethAmount, '0.007');
    assert.equal(oldFlow.running, false);
    assert.equal(oldFlow.fee, null, 'late quote never becomes payable in the old view');
    assert.equal(f.effects.authorizations, 0);
    assert.deepEqual(f.effects.deposits, []);
});

// A quote failure is one error, said once, under a heading that does not
// keep promising an update (release browser audit, 2026-09-29, finding 3).
test('a failed quote is shown once after Deposit echoes it, and the input points at that copy', async t => {
    const f = fixture(t);
    f.client.quoteDepositUsd = async () => { throw new Error('Temporary price read failure.'); };
    await f.hydrate();
    const before = f.controls.renderDepositAmount(f.owner);
    assert.equal((before.match(/Temporary price read failure\./g) || []).length, 1);
    assert.match(before, /aria-invalid="true" aria-describedby="zkapi-amount-error"/);
    assert.match(before, /id="zkapi-amount-error" class="zkapi-funding-error" role="alert"/);
    const account = Object.assign(Object.create(f.Account.prototype), f.owner, {
        run: () => assert.fail('a failed quote never reaches the wallet'), recordDepositConfirmation() {}
    });
    await account.startDeposit(account.fundingInputAmount);
    assert.equal(account.outcome?.message, 'Temporary price read failure.');
    const after = f.controls.renderDepositAmount(account) + account.renderOutcome();
    assert.equal((after.match(/Temporary price read failure\./g) || []).length, 1, 'the outcome is the only copy');
    assert.match(after, /aria-describedby="zkapi-deposit-error"/);
    assert.doesNotMatch(after, /zkapi-amount-error/);
});

test('Send Ethereum names a failed estimate instead of "Updating the ETH amount…" and says it retries', async t => {
    const f = fixture(t, { method: 'address' });
    f.client.quoteDepositUsd = async () => { throw new Error('Temporary price read failure.'); };
    await f.hydrate();
    const html = f.controls.renderDepositAmount(f.owner) + f.controls.renderFundingAccount(f.owner);
    assert.match(html, /<span class="zkapi-transfer-muted">Estimate unavailable<\/span>/);
    assert.doesNotMatch(html, /Updating the ETH amount|when the estimate is ready/);
    assert.equal((html.match(/Temporary price read failure\./g) || []).length, 1);
    assert.match(html, /aria-describedby="zkapi-amount-error"/);
    assert.match(html, /Retrying automatically\. Changing the amount or its currency also starts a new estimate\./);
    assert.match(html, /data-funding-copy/, 'the address stays available');
});
