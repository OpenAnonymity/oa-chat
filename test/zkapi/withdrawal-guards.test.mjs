import test from 'node:test';
import assert from 'node:assert/strict';
import { ZkapiClient } from '@openanonymity/zkapi-browser-sdk/client';
import runtime, { BrowserWalletRuntime } from '@openanonymity/zkapi-browser-sdk/runtime';
import { withBrowserWalletLock } from '@openanonymity/zkapi-browser-sdk/store';
import { MAX_TRANSACTION_GAS_LIMIT } from '@openanonymity/zkapi-browser-sdk/gas';

const account = `0x${'12'.repeat(20)}`;
const vault = `0x${'34'.repeat(20)}`;
function fixture(t) {
    const client = new ZkapiClient();
    client.config = { funding: { chain_id: 1, contract_address: vault }, prepared_withdrawal: null };
    client.wallet = { note: { note_id: 7, current_balance: 1000000 } };
    client.browserMode = true;
    const state = { account, balance: '0xde0b6b3a7640000', gasPrice: '0x3b9aca00', chain: '0x1', calls: [] };
    client.setWalletProvider({request: async ({method}) => {
        state.calls.push(method);
        if (method === 'eth_accounts') return state.account ? [state.account] : [];
        if (method === 'eth_chainId') return state.chain;
        if (method === 'eth_getBalance') return state.balance;
        if (method === 'eth_gasPrice') return state.gasPrice;
        assert.fail(`unexpected wallet operation ${method}`);
    }});
    t.mock.method(client, 'connectWallet', async () => state.account);
    t.mock.method(client, 'assertBalanceNotClaimed', async () => {});
    t.mock.method(runtime, 'currentPreparedWithdrawal', async () => null);
    return {client, state};
}

test('MetaMask quote is read-only, accounts for both escape steps and uses exact integers', async t => {
    const {client, state} = fixture(t);
    const mutual = await client.getWithdrawalFeeBudget();
    const escape = await client.getWithdrawalFeeBudget('escape');
    assert.equal(BigInt(mutual.feeReserveWei), BigInt(MAX_TRANSACTION_GAS_LIMIT) * 2000000000n);
    assert.equal(BigInt(escape.feeReserveWei), BigInt(mutual.feeReserveWei) * 2n);
    assert.equal(mutual.shortfallWei, '0');
    assert.ok(mutual.expiresAt > Date.now());
    assert.ok(!state.calls.some(method => /send|requestAccounts|sign|switch/.test(method)));
});

test('zero-ETH MetaMask cannot settle or reserve a private balance', async t => {
    const {client, state} = fixture(t);
    state.balance = '0x0';
    t.mock.method(client, 'settleActiveLease', async () => assert.fail('settlement must not start'));
    t.mock.method(runtime, 'prepareWithdrawal', async () => assert.fail('clearance must not start'));
    await assert.rejects(client.performWithdrawal('mutual'), {code: 'withdrawal_insufficient_eth'});
    assert.ok(state.calls.includes('eth_getBalance'));
    assert.equal(client.config.prepared_withdrawal, null);
});

test('history withdrawal cannot request clearance without ETH for fees', async t => {
    const {client, state} = fixture(t);
    state.balance = '0x0';
    t.mock.method(client, 'syncEscapeWithdrawals', async () => {});
    t.mock.method(runtime, 'currentWithdrawal', async () => ({ mode: 'mutual', phase: 'parked', noteId: 7, destination: account }));
    t.mock.method(runtime, 'prepareBackgroundWithdrawal', async () => assert.fail('clearance must not start'));
    await assert.rejects(client.performBackgroundWithdrawal('record', () => {}), {code: 'withdrawal_insufficient_eth'});
});

for (const change of ['account', 'price', 'chain', 'balance']) test(`recheck refuses changed MetaMask ${change} before clearance`, async t => {
    const {client, state} = fixture(t);
    const reviewedFunding = await client.getWithdrawalFeeBudget();
    if (change === 'account') state.account = `0x${'56'.repeat(20)}`;
    if (change === 'price') state.gasPrice = '0x77359400';
    if (change === 'chain') state.chain = '0xaa36a7';
    if (change === 'balance') state.balance = '0x0';
    t.mock.method(client, 'settleActiveLease', async () => assert.fail('must re-review before settlement'));
    t.mock.method(runtime, 'prepareWithdrawal', async () => assert.fail('must re-review before clearance'));
    await assert.rejects(client.performWithdrawal('mutual', () => {}, {reviewedFunding}));
});

for (const value of ['0x0', '-1', '1', '0xzz', '0x' + 'f'.repeat(65)]) test(`invalid fee data ${value.slice(0,16)} cannot enable withdrawal`, async t => {
    const {client, state} = fixture(t);
    state.gasPrice = value;
    await assert.rejects(client.getWithdrawalFeeBudget());
});

test('a disconnected MetaMask needs an explicit connection, never a background prompt', async t => {
    const {client, state} = fixture(t);
    state.account = null;
    await assert.rejects(client.getWithdrawalFeeBudget(), {code: 'withdrawal_wallet_disconnected'});
    assert.deepEqual(state.calls, ['eth_accounts']);
});

function escapeFixture() {
    const wallet = new BrowserWalletRuntime();
    wallet.manifest = {deployment_id: 'escape-guard'};
    wallet.runtime = {state: {note_id: 7}, preparedWithdrawal: null, journal: null, lease: null};
    wallet.init = wallet.reload = async () => {};
    wallet.config = {funding: {}, wallet_core: {}, proving_keys: {withdrawal: {}}};
    wallet.remoteJson = async () => assert.fail('escape must not request service clearance or settlement');
    wallet.settleActiveLease = async () => assert.fail('escape must not silently settle');
    wallet.recoverPendingLocked = async () => assert.fail('escape must not recover through the service');
    wallet.treePath = async () => ({active_root: '1', siblings: []});
    wallet.worker = {call: async (_method, data) => {
        assert.equal(data.args.mode, 'escape');
        assert.equal(data.args.clearance, null);
        return {mode: 'escape', proof: 'test-proof', public_inputs: {note_id: 7, active_root: '1'}};
    }};
    wallet.commit = async next => {wallet.runtime = next;};
    return wallet;
}

test('escape with a settled balance does not contact the settlement service', async () => {
    const wallet = escapeFixture();
    const plan = await wallet.prepareWithdrawal('escape', account, {expectedNoteId: 7});
    assert.equal(plan.mode, 'escape');
});

for (const field of ['journal', 'lease', 'activeLease']) test(`unfinished ${field} blocks escape without deleting recovery evidence or contacting the server`, async () => {
    const wallet = escapeFixture();
    const data = {client_request_id: 'saved-request'};
    if (field === 'activeLease') wallet.activeLease = data;
    else wallet.runtime[field] = data;
    const before = structuredClone(wallet.runtime);
    await assert.rejects(wallet.prepareWithdrawal('escape', account), {code: 'escape_settlement_required'});
    assert.deepEqual(wallet.runtime, before);
});

test('another tab starting a key between the escape guard and preparation is blocked under the second lock', async () => {
    const wallet = escapeFixture();
    let reads = 0;
    wallet.reload = async () => { if (++reads === 2) wallet.runtime.journal = {prepared_request: {client_request_id: 'other-tab'}}; };
    await assert.rejects(wallet.prepareWithdrawal('escape', account), {code: 'escape_settlement_required'});
    assert.equal(wallet.runtime.journal.prepared_request.client_request_id, 'other-tab');
    assert.equal(wallet.runtime.preparedWithdrawal, null);
});

test('without Web Locks no wallet mutation can enter, even across separate module instances', async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    try {
        let entered = 0;
        const other = await import(new URL('../../node_modules/@openanonymity/zkapi-browser-sdk/sdk/services/browserWalletStore.js?other-tab', import.meta.url));
        for (const lock of [withBrowserWalletLock, other.withBrowserWalletLock]) {
            await assert.rejects(lock('same-wallet', () => { entered++; }), {code: 'wallet_lock_unavailable'});
        }
        assert.equal(entered, 0);
    } finally { Object.defineProperty(navigator, 'locks', previous); }
});
