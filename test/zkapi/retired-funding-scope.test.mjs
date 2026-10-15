import assert from 'node:assert/strict';
import test from 'node:test';
import { Transaction, Wallet, getAddress } from 'ethers';
import codec from '@openanonymity/zkapi-browser-sdk/wallet';
import { AddressFundingProvider, addressFundingWallet } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import { createAddressFundingStore } from '../../chat/zkapi/services/addressFundingStore.mjs';
import { checkRetiredScopeBalance, createScopedFundingProvider, fundingScopeOf, listRetiredScopes, recoverRetiredScope,
    sweepRetiredScope } from '../../chat/zkapi/services/scopedFundingProviders.mjs';
import { installActiveVersion, resetActiveVersionForTests } from '../../chat/zkapi/versioning/activeVersion.mjs';
import { noteBoundV1 } from '../../chat/zkapi/versioning/adapters/noteBoundV1.mjs';

// Funding addresses of other protocol versions: a scope per vault, local-facts
// listing, gesture-only balance reads, sweep-only providers.

const KEY_ONE = `0x${'11'.repeat(32)}`;
const KEY_TWO = `0x${'22'.repeat(32)}`;
const KEY_ZERO = `0x${'33'.repeat(32)}`;
const ADDRESS_ONE = new Wallet(KEY_ONE).address.toLowerCase();
const ADDRESS_TWO = new Wallet(KEY_TWO).address.toLowerCase();
const ADDRESS_ZERO = new Wallet(KEY_ZERO).address.toLowerCase();
const VAULT_ONE = `0x${'a1'.repeat(20)}`;
const VAULT_TWO = `0x${'b2'.repeat(20)}`;
const VAULT_ZERO = `0x${'c0'.repeat(20)}`;
const WALLET = `0x${'44'.repeat(20)}`;
const DEPLOYMENT_ONE = 'zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930';
const DEPLOYMENT_TWO = 'zkapi-native-eth-mainnet-concession-v1-fixture';
const RPC = 'https://rpc.example';
const hex = value => `0x${value.toString(16)}`;

function row(overrides) {
    return { id: 'v1', ordinal: 1, label: 'Version 1', adapter: 'note-bound-v1', circuitId: 'zkapi-v2-note-bound-v1', vaultRevision: 1,
        status: 'exit-only', depositsOpen: false, depositsClosedSince: 1_790_000_000_000, admissionClosesAt: null,
        deploymentId: DEPLOYMENT_ONE, chainId: 1, vault: VAULT_ONE, rpcUrl: RPC, configSha256: null,
        assetBase: 'zkapi/', proxyPath: '/zkapi-deployment/',
        transition: { closeByMarginSeconds: 259200, reminderDays: [7, 3, 1], promptWindowDays: 14 }, notices: [], ...overrides };
}
const V1 = row();
const V2 = row({ id: 'v2', ordinal: 2, label: 'Version 2', adapter: 'concession-v1', circuitId: 'zkapi-v2-concession-v1', vaultRevision: 3,
    status: 'active', depositsOpen: true, depositsClosedSince: null, deploymentId: DEPLOYMENT_TWO, vault: VAULT_TWO,
    assetBase: 'zkapi/v2c/', proxyPath: '/zkapi-deployment-v2c/' });
// A retired version keeps only its tombstone: no RPC, no assets.
const V0 = row({ id: 'v0', ordinal: 0, label: 'Version 0', status: 'retired', deploymentId: 'zkapi-retired-0', vault: VAULT_ZERO,
    rpcUrl: null, assetBase: null, proxyPath: null });
const TABLE = [V1, V2, V0];

function memoryStore({ withKeys = false } = {}) {
    const data = new Map();
    const loads = [];
    const store = {
        data, loads,
        async load(scope) { loads.push(scope); return structuredClone(data.get(scope) ?? null); },
        async save(scope, envelope, { createOnly = false } = {}) {
            if (createOnly && data.has(scope)) throw new Error('exists');
            data.set(scope, structuredClone(envelope));
        }
    };
    if (withKeys) store.keys = async () => [...data.keys()].sort();
    return store;
}

function locks() {
    const tails = new Map();
    return { names: [], request(name, options, callback) {
        this.names.push(name);
        const before = tails.get(name) || Promise.resolve();
        const run = before.then(() => callback({ name }));
        tails.set(name, run.catch(() => {}));
        return run;
    } };
}

// A JSON-RPC transport with the answers an ETH return needs. `rpc.calls`
// records every method asked, so a test can prove nothing was.
function network() {
    const rpc = { calls: [], sent: [], chain: '0x1', nonce: '0x0', finalizedNonce: '0x0', failing: new Set(),
        balance: '0xde0b6b3a7640000', receipt: null,
        baseFee: '0x1dcd6500', priorityFee: '0x5f5e100', latest: '0x100', finalized: '0x100',
        timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, blockHash: `0x${'77'.repeat(32)}` };
    const feeHistory = () => {
        const count = 20;
        return { oldestBlock: hex(BigInt(rpc.latest) - BigInt(count) + 1n), baseFeePerGas: Array(count + 1).fill(rpc.baseFee),
            gasUsedRatio: Array(count).fill(0.5), reward: Array.from({ length: count }, () => [rpc.priorityFee]) };
    };
    rpc.transport = async (url, options) => {
        const request = JSON.parse(options.body);
        rpc.calls.push({ method: request.method, url, params: request.params });
        if (rpc.failing.has(request.method)) return { ok: false, json: async () => ({}) };
        let result;
        if (request.method === 'eth_chainId') result = rpc.chain;
        else if (request.method === 'eth_getTransactionCount') result = request.params[1] === 'finalized' ? rpc.finalizedNonce : rpc.nonce;
        else if (request.method === 'eth_getBalance') result = rpc.balance;
        else if (request.method === 'eth_estimateGas') result = '0x5208';
        else if (request.method === 'eth_call') result = '0x';
        else if (request.method === 'eth_getCode') result = '0x';
        else if (request.method === 'eth_feeHistory') result = feeHistory();
        else if (request.method === 'eth_getTransactionReceipt') result = rpc.receipt;
        else if (request.method === 'eth_getBlockByNumber') {
            result = { number: request.params[0] === 'finalized' ? rpc.finalized : request.params[0] === 'latest' ? rpc.latest : request.params[0],
                hash: rpc.blockHash, baseFeePerGas: rpc.baseFee, timestamp: rpc.timestamp };
        } else if (request.method === 'eth_sendRawTransaction') {
            rpc.sent.push(request.params[0]);
            result = Transaction.from(request.params[0]).hash;
        } else assert.fail(`Unexpected RPC ${request.method}`);
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) };
    };
    return rpc;
}

const methods = rpc => rpc.calls.map(call => call.method);

function world(options = {}) {
    const store = options.store ?? memoryStore();
    const lockManager = locks();
    const rpc = network();
    let nextKey = 0;
    const keys = [KEY_ONE, KEY_TWO, KEY_ZERO];
    const deps = { store, locks: lockManager, transport: rpc.transport, createWallet: () => new Wallet(keys[nextKey++ % keys.length]) };
    return { store, locks: lockManager, rpc, deps };
}

// The page that ran version 1 earlier: a full provider (it can deposit and
// exit) configured the way that build was, writing the shared funding store.
function legacyPage({ store, locks: lockManager, rpc }, { createWallet = () => new Wallet(KEY_ONE) } = {}) {
    return new AddressFundingProvider({
        getConfig: () => ({ chain_id: 1, contract_address: VAULT_ONE, billing_asset: 'native_eth', billing_unit: 'gwei',
            native_asset_wei_per_unit: '1000000000', demo_billing_token_address: null, demo_rpc_url: RPC }),
        protocol: () => ({ adapter: noteBoundV1, deploymentId: DEPLOYMENT_ONE, version: V1 }),
        depositGate: () => ({ canStart: true, canResume: false, code: null, successor: null }),
        store, locks: lockManager, transport: rpc.transport, createWallet, createChannel: () => null
    });
}

const PLAN = { commitment: '0x123', zero_path: Array(32).fill('0x0') };
async function signLegacyDeposit(page) {
    const amount = 5_000_000n;
    const input = { from: ADDRESS_ONE, to: VAULT_ONE, data: codec.encodeDeposit(PLAN, amount), value: hex(amount * 1_000_000_000n) };
    const recovery = { version: 1, kind: 'deposit', deploymentId: DEPLOYMENT_ONE, chainId: 1, contractAddress: VAULT_ONE,
        operationId: 'op', submissionId: 'sub', amount: amount.toString(), commitment: PLAN.commitment };
    return page.withAuthorizedAction({ kind: 'deposit', amount: amount.toString() },
        () => page.request({ method: 'eth_sendTransaction', params: [input], zkapiRecovery: recovery }));
}

function legacyExitPlan(mode) {
    return { mode, siblings: Array(32).fill('0x0'), proof: { backend: 'groth16_bn254', proof: Buffer.alloc(256).toString('base64') },
        public_inputs: { protocol_version: 2, chain_id: 1, contract_address: VAULT_ONE, active_root: '0x1',
            state_signing_key_x: '0x1', state_signing_key_y: '0x1', clearance_signing_key_x: '0x1', clearance_signing_key_y: '0x1',
            note_id: 7, final_balance: 1_500_000, destination: WALLET, withdrawal_nullifier: '0x2a',
            has_clearance: mode === 'mutual', withdrawal_tag: '0x8' } };
}
async function signLegacyExit(page) {
    const data = codec.encodeWithdrawal(legacyExitPlan('mutual'), 'mutual', WALLET, VAULT_ONE);
    const recovery = { version: 1, kind: 'withdrawal', deploymentId: DEPLOYMENT_ONE, chainId: 1, contractAddress: VAULT_ONE,
        operationId: 'op', submissionId: 'sub', noteId: 7, destination: WALLET, finalBalance: 1_500_000, mode: 'mutual' };
    return page.withAuthorizedAction({ kind: 'withdrawal', destination: WALLET, noteId: 7, mode: 'mutual' },
        () => page.request({ method: 'eth_sendTransaction', params: [{ from: ADDRESS_ONE, to: VAULT_ONE, data }], zkapiRecovery: recovery }));
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

test('every version has its own scope, address and lock; neither sees the other', async () => {
    const w = world();
    const one = createScopedFundingProvider(V1, w.deps);
    const two = createScopedFundingProvider(V2, w.deps);
    assert.equal(await one.ensureAddress(), ADDRESS_ONE);
    assert.equal(await two.ensureAddress(), ADDRESS_TWO);
    assert.notEqual(ADDRESS_ONE, ADDRESS_TWO);
    const scopeOne = `1:${VAULT_ONE}:native-eth`;
    const scopeTwo = `1:${VAULT_TWO}:native-eth`;
    assert.deepEqual([...w.store.data.keys()].sort(), [scopeOne, scopeTwo].sort());
    assert.equal(fundingScopeOf(V1), scopeOne);
    assert.equal((await one.context()).scope, scopeOne);
    assert.equal((await two.context()).scope, scopeTwo);
    // Lock names are per scope, so one version's action never queues behind the other's.
    assert.ok(w.locks.names.includes(`oa-zkapi-address:${scopeOne}`));
    assert.ok(w.locks.names.includes(`oa-zkapi-address:${scopeTwo}`));
    // A second provider of the same scope finds the same row and creates nothing.
    const again = createScopedFundingProvider(V1, w.deps);
    assert.equal(await again.ensureAddress(), ADDRESS_ONE);
    assert.equal(w.store.data.size, 2);
    // Creating the other version's address read nothing from the network.
    assert.deepEqual(w.rpc.calls, []);
});

test('a retired version\'s scope resolves its network from the table, and has no transport without one', async () => {
    const w = world();
    const retired = createScopedFundingProvider(V0, { ...w.deps, table: TABLE });
    assert.equal(await retired.ensureAddress(), ADDRESS_ONE);
    const context = await retired.context();
    assert.equal(context.rpc, `${RPC}/`);
    assert.equal(context.scope, `1:${VAULT_ZERO}:native-eth`);

    // Nothing known about its network: local reads work, any request is refused before it leaves.
    const isolated = createScopedFundingProvider(V0, { ...w.deps, table: [V0] });
    await isolated.reload();
    assert.equal(isolated.exists, true);
    await assert.rejects(isolated.getStatus(), { code: 'address_rpc_error' });
    assert.deepEqual(w.rpc.calls, []);
});

test('a scope that cannot be judged or named has no provider', () => {
    assert.throws(() => createScopedFundingProvider({ ...V1, adapter: 'unheard-of' }), { code: 'unknown_adapter' });
    for (const broken of [null, { ...V1, vault: null }, { ...V1, chainId: null }, { ...V1, vault: '0x12' }, { ...V1, id: '' }]) {
        assert.throws(() => createScopedFundingProvider(broken), { code: 'address_scope_unknown' });
    }
    assert.equal(fundingScopeOf({ ...V1, vault: null }), null);
});

// ---------------------------------------------------------------------------
// Listing: local facts only
// ---------------------------------------------------------------------------

test('listing reports other versions\' funding rows from the store, with no network request', async () => {
    const w = world({ store: memoryStore({ withKeys: true }) });
    await createScopedFundingProvider(V1, w.deps).ensureAddress();
    await createScopedFundingProvider(V2, w.deps).ensureAddress();
    await createScopedFundingProvider(V0, { ...w.deps, table: TABLE }).ensureAddress();
    w.store.loads.length = 0;

    const listed = await listRetiredScopes({ table: TABLE, store: w.store, activeId: 'v2', deps: w.deps });
    assert.deepEqual(listed, [
        { versionId: 'v1', scope: `1:${VAULT_ONE}:native-eth`, address: ADDRESS_ONE, pending: false, lastReturn: null, unreadable: false },
        { versionId: 'v0', scope: `1:${VAULT_ZERO}:native-eth`, address: ADDRESS_ZERO, pending: false, lastReturn: null, unreadable: false }
    ]);
    // The loaded version's own scope, and a version that still takes deposits, are not "retired".
    assert.deepEqual((await listRetiredScopes({ table: TABLE, store: w.store, activeId: 'v1', deps: w.deps })).map(entry => entry.versionId), ['v0']);
    assert.deepEqual(w.rpc.calls, [], 'listing is local facts only');
    // Only scopes the key list names are loaded: the active version's row never is.
    assert.ok(!w.store.loads.includes(`1:${VAULT_TWO}:native-eth`));
});

test('listing works with a store that cannot enumerate, skips absent rows and never invents one', async () => {
    const w = world();
    const listed = await listRetiredScopes({ table: TABLE, store: w.store, activeId: 'v2', deps: w.deps });
    assert.deepEqual(listed, []);
    assert.equal(w.store.data.size, 0, 'listing creates nothing');
    assert.deepEqual(await listRetiredScopes({ table: [], store: w.store }), []);
    assert.deepEqual(await listRetiredScopes({ store: w.store }), []);
    await createScopedFundingProvider(V1, w.deps).ensureAddress();
    const again = await listRetiredScopes({ table: TABLE, store: w.store, activeId: 'v2', deps: w.deps });
    assert.deepEqual(again.map(entry => [entry.versionId, entry.address]), [['v1', ADDRESS_ONE]]);
    assert.deepEqual(w.rpc.calls, []);
});

test('an unreadable row is listed as unreadable rather than hidden', async () => {
    const w = world();
    await createScopedFundingProvider(V1, w.deps).ensureAddress();
    const scope = `1:${VAULT_ONE}:native-eth`;
    // Damaged custody: the browser key is gone. Plaintext facts remain.
    const damaged = w.store.data.get(scope);
    damaged.browserKey = null;
    w.store.data.set(scope, damaged);
    const listed = await listRetiredScopes({ table: TABLE, store: w.store, activeId: 'v2', deps: w.deps });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].address, ADDRESS_ONE);
    assert.equal(listed[0].unreadable, true);
    assert.equal(listed[0].lastReturn, null);
    // A store that fails to load is listed too, with nothing claimed about it.
    const failing = { async load() { throw new Error('storage unavailable'); } };
    assert.deepEqual(await listRetiredScopes({ table: TABLE, store: failing, activeId: 'v2', deps: w.deps }), [
        { versionId: 'v1', scope, address: null, pending: false, lastReturn: null, unreadable: true },
        { versionId: 'v0', scope: `1:${VAULT_ZERO}:native-eth`, address: null, pending: false, lastReturn: null, unreadable: true }
    ]);
    assert.deepEqual(w.rpc.calls, []);
});

// ---------------------------------------------------------------------------
// Balance reads happen only when asked for
// ---------------------------------------------------------------------------

test('no balance is read until the explicit check, which reads once and nothing repeats', async () => {
    const w = world();
    const scope = `1:${VAULT_ONE}:native-eth`;
    const provider = createScopedFundingProvider(V1, w.deps);
    await provider.ensureAddress();
    await provider.reload();
    await listRetiredScopes({ table: TABLE, store: w.store, activeId: 'v2', deps: w.deps });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(w.rpc.calls, [], 'creating, reloading, listing and waiting make no request');

    w.rpc.balance = hex(3_000_000_000_000_000n);
    const balance = await checkRetiredScopeBalance({ scope, table: TABLE, deps: w.deps });
    assert.deepEqual(balance, { balanceWei: '3000000000000000' });
    assert.deepEqual(methods(w.rpc), ['eth_chainId', 'eth_getBalance', 'eth_chainId']);
    assert.ok(w.rpc.calls.every(call => call.url === `${RPC}/`));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(w.rpc.calls.length, 3, 'a check schedules nothing');
});

test('a balance check refuses scopes that are unknown or have no saved address, before any request', async () => {
    const w = world();
    await assert.rejects(checkRetiredScopeBalance({ scope: `1:${VAULT_ONE}:native-eth`, table: TABLE, deps: w.deps }), { code: 'address_missing' });
    await assert.rejects(checkRetiredScopeBalance({ scope: '1:0x1234:native-eth', table: TABLE, deps: w.deps }), { code: 'address_scope_unknown' });
    await assert.rejects(checkRetiredScopeBalance({ scope: undefined, table: TABLE, deps: w.deps }), { code: 'address_scope_unknown' });
    await assert.rejects(checkRetiredScopeBalance({ scope: `1:${VAULT_ONE}:native-eth` }), { code: 'address_scope_unknown' });
    assert.deepEqual(w.rpc.calls, []);
});

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

test('an explicit sweep returns the whole balance to another address and is journaled', async () => {
    const w = world();
    const scope = `1:${VAULT_ONE}:native-eth`;
    await createScopedFundingProvider(V1, w.deps).ensureAddress();
    w.rpc.balance = hex(2_000_000_000_000_000n);

    const notices = [];
    const channel = { postMessage: message => notices.push(['post', message]), close: () => notices.push(['close']) };
    w.deps.createChannel = () => channel;
    const result = await sweepRetiredScope({ scope, table: TABLE, destination: WALLET, deps: w.deps });
    assert.deepEqual(notices, [['post', { changed: true }], ['close']], 'other tabs are told once, and no channel stays open');
    assert.equal(w.rpc.sent.length, 1);
    const signed = Transaction.from(w.rpc.sent[0]);
    assert.equal(result.transactionHash, signed.hash);
    assert.equal(result.versionId, 'v1');
    assert.equal(signed.from.toLowerCase(), ADDRESS_ONE);
    assert.equal(signed.to.toLowerCase(), WALLET);
    assert.equal(signed.data, '0x');
    assert.equal(signed.chainId, 1n);
    assert.equal(signed.value + signed.gasLimit * signed.maxFeePerGas, 2_000_000_000_000_000n, 'all of it, less the fee');

    // The saved sweep is visible as a local fact, and a second one waits for it.
    const listed = await listRetiredScopes({ table: TABLE, store: w.store, activeId: 'v2', deps: w.deps });
    assert.equal(listed[0].pending, true);
    await assert.rejects(sweepRetiredScope({ scope, table: TABLE, destination: WALLET, deps: w.deps }), { code: 'address_transaction_pending' });
    assert.equal(w.rpc.sent.length, 1);

    // Confirming it is an explicit check that reads the network.
    w.rpc.receipt = { transactionHash: signed.hash, status: '0x1', blockHash: w.rpc.blockHash, blockNumber: '0x10' };
    const outcome = await recoverRetiredScope({ scope, table: TABLE, deps: w.deps });
    assert.deepEqual(outcome, { transactionHash: signed.hash, status: 'confirmed' });
    const after = await listRetiredScopes({ table: TABLE, store: w.store, activeId: 'v2', deps: w.deps });
    assert.equal(after[0].pending, false);
    assert.equal(after[0].lastReturn.transactionHash, signed.hash);
    assert.equal(after[0].lastReturn.status, 'confirmed');
    assert.equal(after[0].lastReturn.destination.toLowerCase(), WALLET);
    assert.equal(after[0].lastReturn.asset, 'eth');
    assert.equal(after[0].lastReturn.amount, signed.value.toString());
    assert.equal(await recoverRetiredScope({ scope, table: TABLE, deps: w.deps }), null, 'nothing left to check');
});

test('a sweep can target the loaded version\'s own funding address but never a vault or itself', async () => {
    const w = world();
    const scope = `1:${VAULT_ONE}:native-eth`;
    await createScopedFundingProvider(V1, w.deps).ensureAddress();
    w.rpc.calls.length = 0;
    for (const bad of [VAULT_ONE, VAULT_TWO, VAULT_ZERO, `0x${'0'.repeat(40)}`, ADDRESS_ONE, getAddress(ADDRESS_ONE), 'nonsense']) {
        await assert.rejects(sweepRetiredScope({ scope, table: TABLE, destination: bad, deps: w.deps }), Error, String(bad));
    }
    assert.deepEqual(w.rpc.calls, [], 'refused before any request');
    assert.equal(w.rpc.sent.length, 0);
    // The funding address of the loaded version is a legitimate target.
    const result = await sweepRetiredScope({ scope, table: TABLE, destination: ADDRESS_TWO, deps: w.deps });
    assert.equal(Transaction.from(w.rpc.sent[0]).to.toLowerCase(), ADDRESS_TWO);
    assert.equal(result.versionId, 'v1');
});

test('a funding address only returns ETH: no deposit, exit, claim, finalization or quote', async () => {
    const w = world();
    const provider = createScopedFundingProvider(V1, w.deps);
    await provider.ensureAddress();
    for (const kind of ['deposit', 'withdrawal', 'finalization']) {
        await assert.rejects(provider.withAuthorizedAction({ kind }, async () => assert.fail('no action runs')),
            { code: 'address_scope_retired' }, kind);
    }
    // A claim is not even an action of this scope's protocol.
    await assert.rejects(provider.withAuthorizedAction({ kind: 'payout-claim' }, async () => assert.fail('no action runs')), { code: 4100 });
    await assert.rejects(provider.getDepositFeeQuote({ amount: '5000000', depositWei: '5000000000000000', ethAmount: '0.005' }),
        { code: 'deposits_closed' });
    await assert.rejects(provider.prepareDepositQuote('0.005', { from: ADDRESS_ONE }), { code: 'address_scope_retired' });
    assert.deepEqual(w.rpc.calls, []);
});

// ---------------------------------------------------------------------------
// Protocol rules belong to the scope
// ---------------------------------------------------------------------------

test('a retired scope validates its journal with its own protocol while the page runs another', async t => {
    const w = world();
    const page = legacyPage(w);
    await page.ensureAddress();
    const exitHash = await signLegacyExit(page);
    await page.acknowledgeTransaction(exitHash);
    assert.equal(w.rpc.sent.length, 1);

    // The page reloads as version 2 (revision 3 call layouts, another deployment id).
    t.after(resetActiveVersionForTests);
    resetActiveVersionForTests();
    installActiveVersion({ table: TABLE, version: V2, selection: { version: V2, reason: 'no_runtime_note' } });
    // A signer following the page's version would judge version 1's saved exit by revision 3 rules.
    const confused = new AddressFundingProvider({
        getConfig: () => ({ chain_id: 1, contract_address: VAULT_ONE, billing_asset: 'native_eth', billing_unit: 'gwei',
            native_asset_wei_per_unit: '1000000000', demo_billing_token_address: null, demo_rpc_url: RPC }),
        store: w.store, locks: w.locks, transport: w.rpc.transport, createChannel: () => null });
    await assert.rejects(confused.reload(), { code: 'address_storage_invalid' });
    // The retired scope's provider judges it by version 1's rules.
    const listed = await listRetiredScopes({ table: TABLE, store: w.store, deps: w.deps });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].unreadable, false);
    assert.equal(listed[0].address, ADDRESS_ONE);
    // And a new sweep appends to that journal, after the exit it holds was mined.
    w.rpc.nonce = '0x1';
    w.rpc.balance = hex(1_000_000_000_000_000n);
    await sweepRetiredScope({ scope: listed[0].scope, table: TABLE, destination: WALLET, deps: w.deps });
    assert.equal(w.rpc.sent.length, 2);
});

test('nothing from another version\'s journal can be resumed or replayed through this page', async () => {
    const w = world();
    const scope = `1:${VAULT_ONE}:native-eth`;
    const page = legacyPage(w);
    await page.ensureAddress();
    const depositHash = await signLegacyDeposit(page);
    assert.equal(w.rpc.sent.length, 1);
    const resumes = [];
    const deps = { ...w.deps, resumeTransaction: async record => { resumes.push(record); } };

    // The signed deposit is a saved fact...
    const listed = await listRetiredScopes({ table: TABLE, store: w.store, activeId: 'v2', deps });
    assert.equal(listed[0].pending, true);
    // ...which only the build that started it may finish. The network has not
    // seen it and no nonce has displaced it: it stays saved, and only reads are made.
    const before = w.rpc.calls.length;
    await assert.rejects(recoverRetiredScope({ scope, table: TABLE, deps }), { code: 'address_scope_retired' });
    assert.equal(w.rpc.sent.length, 1, 'its bytes are not rebroadcast');
    assert.deepEqual(methods(w.rpc).slice(before), ['eth_chainId', 'eth_getTransactionReceipt', 'eth_getTransactionCount']);
    assert.deepEqual(w.rpc.calls[w.rpc.calls.length - 1].params, [ADDRESS_ONE, 'finalized']);
    assert.deepEqual(resumes, []);
    assert.equal(w.store.data.get(scope).pendingHash, depositHash);
    // Nor can a sweep be stacked on top of it.
    await assert.rejects(sweepRetiredScope({ scope, table: TABLE, destination: WALLET, deps }), { code: 'address_transaction_pending' });
    assert.equal(w.rpc.sent.length, 1);

    // The page's own scope is another row: it sees none of this.
    const own = new AddressFundingProvider({
        getConfig: () => ({ chain_id: 1, contract_address: VAULT_TWO, billing_asset: 'native_eth', billing_unit: 'gwei',
            native_asset_wei_per_unit: '1000000000', demo_billing_token_address: null, demo_rpc_url: RPC }),
        store: w.store, locks: w.locks, transport: w.rpc.transport, createChannel: () => null, createWallet: () => new Wallet(KEY_TWO) });
    await own.init();
    assert.equal(own.exists, false);
    assert.equal(own.hasPendingTransaction, false);
    assert.equal(await own.ensureAddress(), ADDRESS_TWO);
    assert.equal(own.hasPendingTransaction, false);
    assert.equal(w.store.data.get(scope).pendingHash, depositHash);
});

// ---------------------------------------------------------------------------
// A saved transaction of another build: released once the network settled it
// ---------------------------------------------------------------------------

// A funding address of version 1 holding a signed, unacknowledged deposit or
// exit that this page's sweep-only provider may not resume. `resumes` records
// any SDK resume attempt, `notices` the change announcements.
async function foreignPending(kind) {
    const w = world();
    const scope = `1:${VAULT_ONE}:native-eth`;
    const page = legacyPage(w);
    await page.ensureAddress();
    const hash = kind === 'deposit' ? await signLegacyDeposit(page) : await signLegacyExit(page);
    const resumes = [];
    const notices = [];
    const deps = { ...w.deps, resumeTransaction: async record => { resumes.push(record); },
        createChannel: () => ({ postMessage: message => notices.push(message), close() {} }) };
    return { w, scope, page, hash, deps, resumes, notices };
}

const journal = async (w, scope) => {
    const provider = createScopedFundingProvider(V1, w.deps);
    return provider.read(await provider.context(), true);
};

test('a finalized transaction of another build is released without a resume or a rebroadcast, and the ETH can then be returned', async () => {
    for (const [kind, status, finalState] of [['deposit', '0x1', 'confirmed'], ['withdrawal', '0x0', 'reverted']]) {
        const { w, scope, page, hash, deps, resumes, notices } = await foreignPending(kind === 'deposit' ? 'deposit' : 'exit');
        w.rpc.receipt = { transactionHash: hash, status, blockHash: w.rpc.blockHash, blockNumber: '0x10' };
        const before = w.rpc.calls.length;

        const outcome = await recoverRetiredScope({ scope, table: TABLE, deps });
        assert.deepEqual(outcome, { transactionHash: hash, status: 'released', kind, finalState }, kind);
        assert.equal(w.rpc.sent.length, 1, `${kind}: nothing was rebroadcast`);
        assert.ok(!methods(w.rpc).slice(before).includes('eth_sendRawTransaction'), `${kind}: no send request`);
        assert.deepEqual(resumes, [], `${kind}: no SDK resume`);
        assert.deepEqual(notices, [{ changed: true }], `${kind}: other tabs are told once`);

        // A saved fact now: nothing pending, the entry kept in the journal, acknowledged.
        const listed = await listRetiredScopes({ table: TABLE, store: w.store, activeId: 'v2', deps });
        assert.equal(listed[0].pending, false);
        assert.equal(w.store.data.get(scope).pendingHash, null);
        const record = await journal(w, scope);
        assert.equal(record.pending, null);
        assert.equal(record.transactions.length, 1);
        assert.equal(record.transactions[0].hash, hash);
        assert.equal(record.transactions[0].acknowledged, true);
        assert.equal(record.transactions[0].outcome, undefined, 'only a sweep keeps an outcome');

        // The build that started it may still acknowledge it later: a no-op.
        await page.acknowledgeTransaction(hash);
        assert.equal((await journal(w, scope)).pending, null);

        // Checking again has nothing left to settle...
        assert.equal(await recoverRetiredScope({ scope, table: TABLE, deps }), null);
        // ...and the ETH can be returned now.
        w.rpc.nonce = '0x1';
        w.rpc.balance = hex(1_000_000_000_000_000n);
        const sweep = await sweepRetiredScope({ scope, table: TABLE, destination: WALLET, deps });
        assert.equal(w.rpc.sent.length, 2, kind);
        assert.equal(sweep.transactionHash, Transaction.from(w.rpc.sent[1]).hash);
        assert.deepEqual(resumes, [], kind);
    }
});

test('a transaction of another build that is not final yet stays saved', async () => {
    const mined = async (receiptOverrides, blockNumber = '0x10') => {
        const { w, scope, hash, deps, resumes } = await foreignPending('deposit');
        w.rpc.receipt = { transactionHash: hash, status: '0x1', blockHash: w.rpc.blockHash, blockNumber, ...receiptOverrides };
        const before = w.rpc.calls.length;
        const outcome = await recoverRetiredScope({ scope, table: TABLE, deps });
        assert.deepEqual(outcome, { transactionHash: hash, status: 'pending' });
        assert.equal(w.rpc.sent.length, 1, 'not rebroadcast');
        assert.ok(!methods(w.rpc).slice(before).includes('eth_sendRawTransaction'));
        assert.deepEqual(resumes, []);
        assert.equal(w.store.data.get(scope).pendingHash, hash, 'the marker is kept');
        const record = await journal(w, scope);
        assert.equal(record.pending, hash);
        assert.equal(record.transactions[0].acknowledged, undefined);
        // And nothing else can be started on top of it.
        await assert.rejects(sweepRetiredScope({ scope, table: TABLE, destination: WALLET, deps }), { code: 'address_transaction_pending' });
        return w;
    };
    // Mined in a block the network has not finalized.
    await mined({}, '0x200');
    // Its block is no longer the canonical block at that height (a reorganization).
    await mined({ blockHash: `0x${'88'.repeat(32)}` });
});

test('a transaction the network has not seen and no nonce has displaced is left to the build that started it', async () => {
    const { w, scope, hash, deps, resumes } = await foreignPending('exit');
    w.rpc.receipt = null;
    w.rpc.finalizedNonce = '0x0';
    await assert.rejects(recoverRetiredScope({ scope, table: TABLE, deps }), { code: 'address_scope_retired' });
    assert.equal(w.rpc.sent.length, 1, 'its bytes are not rebroadcast');
    assert.deepEqual(resumes, []);
    assert.equal(w.store.data.get(scope).pendingHash, hash);
});

test('a replaced or dropped transaction of another build is released once its nonce is finalized by another', async () => {
    const { w, scope, hash, deps, resumes, notices } = await foreignPending('deposit');
    // Never mined, and the sender's finalized transaction count has moved past its nonce (0).
    w.rpc.receipt = null;
    w.rpc.finalizedNonce = '0x1';
    const before = w.rpc.calls.length;
    const outcome = await recoverRetiredScope({ scope, table: TABLE, deps });
    assert.deepEqual(outcome, { transactionHash: hash, status: 'released', kind: 'deposit', finalState: 'replaced' });
    assert.deepEqual(methods(w.rpc).slice(before), ['eth_chainId', 'eth_getTransactionReceipt', 'eth_getTransactionCount', 'eth_chainId']);
    assert.deepEqual(w.rpc.calls[before + 2].params, [ADDRESS_ONE, 'finalized']);
    assert.equal(w.rpc.sent.length, 1, 'nothing was rebroadcast');
    assert.deepEqual(resumes, []);
    assert.deepEqual(notices, [{ changed: true }]);
    assert.equal(w.store.data.get(scope).pendingHash, null);
    assert.equal((await journal(w, scope)).transactions[0].acknowledged, true);

    // Its nonce is spent, so the next transaction of this address uses the next one.
    w.rpc.nonce = '0x1';
    w.rpc.balance = hex(1_000_000_000_000_000n);
    await sweepRetiredScope({ scope, table: TABLE, destination: WALLET, deps });
    assert.equal(Transaction.from(w.rpc.sent[1]).nonce, 1);
});

test('releasing another build\'s transaction fails closed on an invalid receipt or an unanswered request', async () => {
    const cases = {
        'a receipt of another transaction': [w => { w.rpc.receipt = { transactionHash: `0x${'55'.repeat(32)}`, status: '0x1',
            blockHash: w.rpc.blockHash, blockNumber: '0x10' }; }, /invalid receipt/],
        'a receipt with an unknown status': [(w, hash) => { w.rpc.receipt = { transactionHash: hash, status: '0x2',
            blockHash: w.rpc.blockHash, blockNumber: '0x10' }; }, /invalid receipt/],
        'a receipt with a malformed block': [(w, hash) => { w.rpc.receipt = { transactionHash: hash, status: '0x1',
            blockHash: w.rpc.blockHash, blockNumber: 'latest' }; }, /Invalid receipt block/],
        'an unanswered nonce request': [w => { w.rpc.receipt = null; w.rpc.failing.add('eth_getTransactionCount'); }, /could not complete/],
        'an unanswered receipt request': [w => { w.rpc.failing.add('eth_getTransactionReceipt'); }, /could not complete/],
        'a malformed finalized nonce': [w => { w.rpc.receipt = null; w.rpc.finalizedNonce = 'one'; }, /Invalid finalized transaction count/]
    };
    for (const [name, [arrange, message]] of Object.entries(cases)) {
        const { w, scope, hash, deps, resumes } = await foreignPending('deposit');
        arrange(w, hash);
        await assert.rejects(recoverRetiredScope({ scope, table: TABLE, deps }), error => message.test(error.message), name);
        assert.equal(w.store.data.get(scope).pendingHash, hash, `${name}: the marker is kept`);
        assert.equal(w.rpc.sent.length, 1, name);
        assert.deepEqual(resumes, [], name);
    }
});

test('a provider of the loaded version still resumes through the SDK: only a sweep-only scope releases', async () => {
    const w = world();
    const resumes = [];
    const page = new AddressFundingProvider({
        getConfig: () => ({ chain_id: 1, contract_address: VAULT_ONE, billing_asset: 'native_eth', billing_unit: 'gwei',
            native_asset_wei_per_unit: '1000000000', demo_billing_token_address: null, demo_rpc_url: RPC }),
        protocol: () => ({ adapter: noteBoundV1, deploymentId: DEPLOYMENT_ONE, version: V1 }),
        depositGate: () => ({ canStart: true, canResume: false, code: null, successor: null }),
        resumeTransaction: async record => { resumes.push(record); return { status: 'submitted' }; },
        store: w.store, locks: w.locks, transport: w.rpc.transport, createWallet: () => new Wallet(KEY_ONE), createChannel: () => null });
    await page.ensureAddress();
    const hash = await signLegacyDeposit(page);
    w.rpc.receipt = { transactionHash: hash, status: '0x1', blockHash: w.rpc.blockHash, blockNumber: '0x10' };
    const outcome = await page.recoverPending();
    assert.deepEqual(outcome, { status: 'submitted' });
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].hash, hash);
    assert.equal(w.rpc.sent.length, 2, 'the full provider replays its own bytes');
    assert.equal(w.store.data.get(`1:${VAULT_ONE}:native-eth`).pendingHash, hash, 'the SDK acknowledges, not the provider');
});

// ---------------------------------------------------------------------------
// The funding store's key list
// ---------------------------------------------------------------------------

// A minimal IndexedDB: one database with named stores, asynchronous request
// callbacks and completion events, enough for the funding store's operations.
function fakeIndexedDB() {
    const databases = new Map();
    const opens = [];
    return { databases, opens, open(name, version) {
        opens.push({ name, version });
        const request = {};
        queueMicrotask(() => {
            let database = databases.get(name);
            const created = !database;
            if (created) { database = { version, stores: new Map() }; databases.set(name, database); }
            const connection = {
                close() {},
                createObjectStore(store) { database.stores.set(store, new Map()); },
                transaction(storeName, mode) {
                    const transaction = { mode, oncomplete: null, onerror: null, onabort: null, pending: 0 };
                    const finish = () => queueMicrotask(() => { if (--transaction.pending === 0) transaction.oncomplete?.(); });
                    const operation = work => {
                        const op = { onsuccess: null, result: undefined };
                        transaction.pending += 1;
                        queueMicrotask(() => { op.result = work(); op.onsuccess?.(); finish(); });
                        return op;
                    };
                    transaction.objectStore = () => {
                        const rows = database.stores.get(storeName);
                        return {
                            get: key => operation(() => structuredClone(rows.get(key))),
                            put: (value, key) => operation(() => { rows.set(key, structuredClone(value)); return key; }),
                            add: (value, key) => operation(() => { rows.set(key, structuredClone(value)); return key; }),
                            getAllKeys: () => operation(() => [...rows.keys()].sort())
                        };
                    };
                    return transaction;
                }
            };
            request.result = connection;
            if (created) request.onupgradeneeded?.();
            request.onsuccess?.();
        });
        return request;
    } };
}

test('the funding store lists its scopes without changing rows, format or database version', async () => {
    const indexedDB = fakeIndexedDB();
    const store = createAddressFundingStore({ indexedDB });
    assert.deepEqual(await store.keys(), []);
    const row = scope => ({ format: 'oa-address-wallet', version: 1, scope, address: ADDRESS_ONE, backedUp: true, pendingHash: null,
        salt: 'AAAA', iterations: 600000, iv: 'AAAA', ciphertext: 'AAAA' });
    for (const scope of ['11155111:0xb:native-eth', '1:0xa:native-eth', '1:0xa:0xtoken']) await store.save(scope, row(scope));
    const rows = () => structuredClone([...indexedDB.databases.get('oa-zkapi-address-funding-v1').stores.get('addresses')]);
    const before = rows();
    // Key order, as IndexedDB sorts strings (by code unit).
    assert.deepEqual(await store.keys(), ['11155111:0xb:native-eth', '1:0xa:0xtoken', '1:0xa:native-eth']);
    assert.deepEqual(rows(), before);
    assert.deepEqual(indexedDB.opens.map(open => open.version), [1], 'one connection, always version 1');
    assert.equal(indexedDB.databases.get('oa-zkapi-address-funding-v1').version, 1);
    // The listing of retired scopes uses it.
    const listed = await listRetiredScopes({ table: [V1, V2], store, activeId: 'v2', deps: { locks: locks(), transport: network().transport } });
    assert.deepEqual(listed, []);
});

test('the funding store\'s key list fails as storage unavailable, never as an empty list', async () => {
    const store = createAddressFundingStore({ indexedDB: undefined });
    await assert.rejects(store.keys(), { code: 'address_storage' });
    const broken = createAddressFundingStore({ indexedDB: { open() {
        const request = {};
        queueMicrotask(() => request.onerror?.());
        return request;
    } } });
    await assert.rejects(broken.keys(), { code: 'address_storage' });
});

test('the page\'s funding address is unaffected by this module', async () => {
    const before = addressFundingWallet.state;
    const w = world();
    await createScopedFundingProvider(V1, w.deps).ensureAddress();
    await listRetiredScopes({ table: TABLE, store: w.store, activeId: 'v2', deps: w.deps });
    assert.equal(addressFundingWallet.state, before);
});
