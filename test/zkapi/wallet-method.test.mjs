import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../chat/zkapi/services/walletMethod.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ saved = null, pending = false } = {}) {
    const effects = { activated: [], stored: [], addresses: 0, reloads: 0, initializations: 0 };
    let active = null;
    const wallet = { hasPendingTransaction: pending,
        async init() {}, async reload() { effects.reloads++; },
        async ensureAddress() { effects.addresses++; }
    };
    const client = { walletProviderBusy: false,
        setWalletProvider(provider) {
            if (provider === active) return;
            if (this.walletProviderBusy || active?.hasPendingTransaction) {
                throw Object.assign(new Error('SDK read or wallet action in progress'), { code: 'wallet_provider_busy' });
            }
            active = provider;
            effects.activated.push(provider === wallet ? 'address' : 'metamask');
        },
        async init() { effects.initializations++; return this; }
    };
    let now = 0;
    const timers = [];
    const context = { zkapiClient: client, addressFundingWallet: wallet,
        localStorage: { getItem: () => saved, setItem: (_key, value) => effects.stored.push(value) },
        Date: { now: () => now }, setTimeout: callback => { timers.push(callback); }
    };
    const api = vm.runInNewContext(`${source}\n({ initWalletMethod, initWalletClient, getWalletMethod, setWalletMethod, prepareWalletMethod, walletMethodActionBusy });`, context);
    const releaseRead = async () => { client.walletProviderBusy = false; timers.splice(0).forEach(callback => callback()); await tick(); };
    return { api, effects, client, wallet, releaseRead,
        timeout: async () => { now = 30_001; timers.splice(0).forEach(callback => callback()); await tick(); } };
}

test('rapid method selection never activates a signer or waits for a stalled background quote', async () => {
    const f = fixture();
    await f.api.initWalletMethod();
    f.client.walletProviderBusy = true;
    for (const method of ['address', 'metamask', 'address', 'metamask']) {
        assert.equal(f.api.setWalletMethod(method), undefined, 'selection is synchronous');
        assert.equal(f.api.getWalletMethod(), method);
    }
    assert.deepEqual(f.effects.activated, []);
    assert.equal(f.effects.reloads, 0, 'selection does not await custody storage or public balances');
    assert.equal(f.effects.addresses, 0);
    await f.releaseRead();
    assert.equal(f.api.getWalletMethod(), 'metamask');
    assert.deepEqual(f.effects.activated, [], 'a late quote completion cannot activate an older choice');
});

test('explicit action waits for the previous read, then holds the chosen signer until released', async () => {
    const f = fixture();
    await f.api.initWalletMethod();
    f.api.setWalletMethod('address');
    f.client.walletProviderBusy = true;
    const preparing = f.api.prepareWalletMethod();
    await tick();
    assert.equal(f.api.walletMethodActionBusy(), true);
    assert.throws(() => f.api.setWalletMethod('metamask'), /current transaction/);
    assert.deepEqual(f.effects.activated, []);
    await f.releaseRead();
    const release = await preparing;
    assert.deepEqual(f.effects.activated, ['address']);
    assert.equal(f.effects.addresses, 1);
    assert.throws(() => f.api.setWalletMethod('metamask'), /current transaction/);
    release();
    f.api.setWalletMethod('metamask');
    const releaseMetaMask = await f.api.prepareWalletMethod();
    assert.deepEqual(f.effects.activated, ['address', 'metamask']);
    releaseMetaMask();
    assert.equal(f.api.walletMethodActionBusy(), false);
});

test('saved address preference restores the UI even while a background read owns the SDK', async () => {
    const f = fixture({ saved: 'address' });
    f.client.walletProviderBusy = true;
    await f.api.initWalletClient();
    assert.equal(f.api.getWalletMethod(), 'address');
    f.api.setWalletMethod('metamask');
    await f.releaseRead();
    assert.equal(f.api.getWalletMethod(), 'metamask');
    assert.deepEqual(f.effects.activated, []);
});

test('a stored signed transaction forces its address recovery and still prevents switching', async () => {
    const f = fixture({ saved: 'metamask', pending: true });
    await f.api.initWalletClient();
    assert.equal(f.api.getWalletMethod(), 'address');
    assert.deepEqual(f.effects.activated, ['address']);
    assert.throws(() => f.api.setWalletMethod('metamask'), /saved funding transaction/);
    const release = await f.api.prepareWalletMethod();
    assert.equal(f.api.walletMethodActionBusy(), true);
    release();
});

test('action-time reload detects a transaction saved by another tab before activating MetaMask', async () => {
    const f = fixture();
    await f.api.initWalletMethod();
    f.wallet.reload = async () => { f.wallet.hasPendingTransaction = true; };
    await assert.rejects(f.api.prepareWalletMethod(), /saved funding transaction/);
    assert.deepEqual(f.effects.activated, []);
    assert.equal(f.api.walletMethodActionBusy(), false);
});

test('a failed preparation releases the action lease and never switches an active SDK provider', async () => {
    const f = fixture();
    await f.api.initWalletMethod();
    f.api.setWalletMethod('address');
    f.client.walletProviderBusy = true;
    const preparing = f.api.prepareWalletMethod();
    const rejected = assert.rejects(preparing, /previous wallet check/);
    await tick();
    await f.timeout();
    await rejected;
    assert.equal(f.api.walletMethodActionBusy(), false);
    f.api.setWalletMethod('metamask');
    assert.deepEqual(f.effects.activated, []);
});

test('unavailable optional address storage does not disable a MetaMask action', async () => {
    const f = fixture();
    f.wallet.init = f.wallet.reload = async () => { throw new Error('Storage unavailable'); };
    const release = await f.api.prepareWalletMethod();
    assert.equal(f.api.getWalletMethod(), 'metamask');
    assert.equal(f.api.walletMethodActionBusy(), true);
    release();
});


test('pending-address startup waits for its signer before SDK reconciliation can run', async () => {
    const f = fixture({ pending: true });
    f.client.walletProviderBusy = true;
    const initialization = f.api.initWalletClient();
    await tick();
    assert.equal(f.api.getWalletMethod(), 'address');
    assert.equal(f.effects.initializations, 0, 'no reconciliation can run with the wrong provider');
    await f.releaseRead();
    await initialization;
    assert.deepEqual(f.effects.activated, ['address']);
    assert.equal(f.effects.initializations, 1);
});
