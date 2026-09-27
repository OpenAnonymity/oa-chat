import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fundingAmount, fundingEthAmount, fundingDestination } from '../../chat/zkapi/services/addressFunding.js';

const recipient = '0x2222222222222222222222222222222222222222';
const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const source = fs.readFileSync(new URL('../../chat/zkapi/components/WalletMethodControls.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ');

function fixture({ method = 'address', wallet = {}, client = {}, confirm = () => true } = {}) {
    const addressFundingWallet = { exists: true, address: recipient, unlocked: true, hasPendingTransaction: false, ...wallet };
    const zkapiClient = { networkName: () => 'Ethereum Mainnet', billingTokenSymbol: 'USDC', isMainnetFunding: true,
        config: { funding: { demo_billing_token_address: '0x4444444444444444444444444444444444444444' } }, ...client };
    const microtasks = [];
    const timers = new Map();
    const context = { addressFundingWallet, zkapiClient, getWalletMethod: () => method,
        setWalletMethod: async value => { method = value; }, fundingAmount, fundingEthAmount, fundingDestination,
        formatFundingAmount: value => value ?? '—', confirm,
        queueMicrotask: callback => microtasks.push(callback),
        setTimeout: callback => { const id = timers.size + 1; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id),
        chatDB: { getSetting() {}, updateSettings() {} },
        navigator: { clipboard: { writeText: async () => {} } }, document: { activeElement: null } };
    const controls = vm.runInNewContext(`${source}\n({ renderWalletMethod, renderFundingAccount, attachWalletMethodControls, captureWalletView, restoreWalletView, refreshWalletView });`, context);
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

test('ordinary native funding shows USD input, ETH principal and fee reserve, then enables Next only on receipt', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, formatMoney: () => '$10.00' } });
    Object.assign(owner, { view: 'fund', isOpen: true, fundingFlow: {
        intent: { usdAmount: '10', amount: '5000000', ethAmount: '0.005' },
        totalWei: '5500000000000000', fee: { feeReserveWei: '500000000000000' },
        status: { ethBalance: '0' }, ready: false
    } });
    const waiting = controls.renderFundingAccount(owner);
    assert.match(waiting, /Amount to add to your wallet \(USD\)/);
    assert.match(waiting, /0\.005 ETH/);
    assert.match(waiting, /Maximum contract fee reserve/);
    assert.match(waiting, /sending wallet charges its own transfer fee separately/);
    assert.match(waiting, new RegExp(`data-funding-address[^>]*value="${recipient}"`));
    assert.match(waiting, /data-funding-next[^>]*disabled/);
    assert.doesNotMatch(waiting, /password|backup|restore|data-funding-lock/i);
    assert.match(waiting, /Return funds held at this address/);
    assert.doesNotMatch(waiting, /<details[^>]*open/);
    owner.fundingFlow.ready = true;
    const ready = controls.renderFundingAccount(owner);
    assert.match(ready, /Funds received\. Choose Next/);
    assert.doesNotMatch(ready, /data-funding-next[^>]*disabled/);
    assert.match(ready, /Its USD value changes with the ETH price/);
});

test('closing a private note leaves public ETH return controls accessible in the new-deposit view', () => {
    const { controls, owner } = fixture({ client: { isNativeEthFunding: true, note: null, formatMoney: () => '$10.00' } });
    Object.assign(owner, { view: 'balance', isOpen: true, fundingStatus: { ethBalance: '15208600000000000' } });
    const html = controls.renderFundingAccount(owner);
    assert.match(html, /Amount to add to your wallet \(USD\)/);
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
    assert.match(controls.renderFundingAccount(owner), /data-funding-recover/);
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
        start(value) { starts++; assert.equal(value, '10'); }
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
    f.owner.fundingFlow = { invalidate() { invalidated++; }, setAmount(value) { amounts.push(value); } };
    const usd = f.field('usd', '10');
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
    assert.deepEqual(amounts, ['12.50']);
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
        walletErrorMessage: error => error.message,
        zkapiClient: {
            beginActivity: () => 'activity', completeActivity: (...args) => completed.push(args),
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
