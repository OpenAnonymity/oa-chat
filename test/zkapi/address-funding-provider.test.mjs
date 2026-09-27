import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet, Transaction } from 'ethers';
import { AddressFundingProvider } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import { createAddressFundingStore } from '../../chat/zkapi/services/addressFundingStore.mjs';
import { ZkapiClient } from '@openanonymity/zkapi-browser-sdk/client';
import runtime from '@openanonymity/zkapi-browser-sdk/runtime';
import codec from '@openanonymity/zkapi-browser-sdk/wallet';
import { bufferedGasLimit, MAX_TRANSACTION_GAS_LIMIT } from '@openanonymity/zkapi-browser-sdk/gas';

const KEY = `0x${'11'.repeat(32)}`;
const OWN = new Wallet(KEY).address.toLowerCase();
const VAULT = `0x${'22'.repeat(20)}`;
const TOKEN = `0x${'33'.repeat(20)}`;
const DESTINATION = `0x${'44'.repeat(20)}`;
const PASSWORD = 'not-a-real-wallet-password';
const FUNDING = { chain_id: 1, contract_address: VAULT, demo_billing_token_address: TOKEN,
    demo_rpc_url: 'https://rpc.example', billing_token_decimals: 6 };
const NATIVE_FUNDING = { billing_asset: 'native_eth', billing_unit: 'gwei',
    native_asset_wei_per_unit: '1000000000', demo_billing_token_address: null };
const CONTEXT = { version: 1, deploymentId: 'fixture', chainId: 1, contractAddress: VAULT, kind: 'token' };
const auth = { kind: 'deposit', amount: '2000000' };
const approve = amount => ({ from: OWN, to: TOKEN, data: codec.callData(codec.ABI.approve, [codec.addressWord(VAULT), codec.abiWord(amount)]) });
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function memoryStore() {
    const data = new Map();
    return { data, fail: false, load: async scope => structuredClone(data.get(scope) ?? null),
        async save(scope, envelope, { createOnly = false } = {}) {
            if (this.fail || (createOnly && data.has(scope))) throw new Error('storage write failed');
            data.set(scope, structuredClone(envelope));
        } };
}
function locks() {
    const running = new Set();
    const tails = new Map();
    return { request(name, options, callback) {
        if (options.ifAvailable && running.has(name)) return Promise.resolve(callback(null));
        const before = tails.get(name) || Promise.resolve();
        const run = before.then(async () => {
            running.add(name);
            try { return await callback({ name }); } finally { running.delete(name); }
        });
        tails.set(name, run.catch(() => {}));
        return run;
    } };
}
function harness(options = {}) {
    const store = options.store || memoryStore();
    const lockManager = options.locks || locks();
    const calls = [];
    const sent = [];
    const resumes = [];
    const rpc = { chain: '0x1', nonce: '0x0', balance: '0xde0b6b3a7640000', gas: '0x186a0',
        gasPrice: '0x3b9aca00', baseFee: '0x1dcd6500', priorityFee: '0x5f5e100', receipt: null, ambiguous: false, simulationFails: false,
        code: '0x', finalized: '0x20', blockHash: `0x${'77'.repeat(32)}` };
    let generated = 0;
    let provider;
    const config = { ...FUNDING, ...options.config };
    const init = {
        store, locks: lockManager, getConfig: options.getConfig || (() => config), createChannel: () => null,
        createWallet: () => { generated += 1; return new Wallet(KEY); },
        resumeTransaction: async record => { resumes.push(record); await provider.acknowledgeTransaction(record.hash); return { status: 'submitted' }; },
        transport: async (url, requestOptions) => {
            const request = JSON.parse(requestOptions.body);
            calls.push({ ...request, url, options: requestOptions });
            let result;
            if (request.method === 'eth_chainId') result = rpc.chain;
            else if (request.method === 'eth_getTransactionCount') result = rpc.nonce;
            else if (request.method === 'eth_getBalance') result = rpc.balance;
            else if (request.method === 'eth_gasPrice') result = rpc.gasPrice;
            else if (request.method === 'eth_maxPriorityFeePerGas') result = rpc.priorityFee;
            else if (request.method === 'eth_estimateGas') result = rpc.gas;
            else if (request.method === 'eth_getCode') result = rpc.code;
            else if (request.method === 'eth_call') {
                if (rpc.simulationFails) throw new Error(`revert private details ${KEY}`);
                result = '0x1e8480';
            } else if (request.method === 'eth_getTransactionReceipt') result = rpc.receipt;
            else if (request.method === 'eth_getBlockByNumber') result = { number: request.params[0] === 'finalized' ? rpc.finalized : request.params[0], hash: rpc.blockHash, baseFeePerGas: rpc.baseFee };
            else if (request.method === 'eth_getTransactionByHash') {
                const raw = sent.find(value => Transaction.from(value).hash === request.params[0]);
                const tx = raw && Transaction.from(raw);
                result = tx ? { hash: tx.hash, from: tx.from, to: tx.to, nonce: `0x${tx.nonce.toString(16)}`,
                    input: tx.data, value: `0x${tx.value.toString(16)}`, chainId: `0x${tx.chainId.toString(16)}` } : null;
            } else if (request.method === 'eth_sendRawTransaction') {
                assert.equal(store.data.size, 1, 'custody has been durably saved before broadcast');
                const pendingHash = [...store.data.values()][0].pendingHash;
                if (pendingHash) assert.equal(pendingHash, Transaction.from(request.params[0]).hash);
                sent.push(request.params[0]);
                if (rpc.ambiguous) throw new Error(`ambiguous ${request.params[0]}`);
                result = Transaction.from(request.params[0]).hash;
            } else assert.fail(`Unexpected RPC ${request.method}`);
            return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) };
        }, ...options
    };
    provider = new AddressFundingProvider(init);
    return { provider, store, locks: lockManager, calls, sent, resumes, rpc, init, config, get generated() { return generated; },
        ready: () => provider.ensureAddress(),
        async legacyReady() { const result = await provider.create(PASSWORD); await provider.markBackedUp(); return result; },
        send(input = approve(2000000), context = CONTEXT, authorization = auth) {
            return provider.withAuthorizedAction(authorization, () => provider.request({ method: 'eth_sendTransaction', params: [input], zkapiRecovery: context }));
        } };
}

async function saveSignedFixture(h, fees) {
    const ctx = await h.provider.context();
    const record = await h.provider.read(ctx, true);
    const raw = await new Wallet(KEY).signTransaction({ to: TOKEN, data: approve(2000000).data,
        value: 0n, nonce: 0, chainId: 1, gasLimit: 120000n, ...fees });
    const hash = Transaction.from(raw).hash;
    record.transactions = [{ hash, raw, kind: 'deposit', authorization: auth, context: CONTEXT,
        transaction: { ...approve(2000000), value: '0x0', nonce: '0x0', gas: '0x1d4c0', chainId: '0x1' } }];
    record.pending = hash;
    record.highestNonce = '1';
    await h.provider.save(ctx, record);
    return { hash, raw };
}

test('initialization before SDK config and later read-only status never creates or spends', async () => {
    let config;
    const h = harness({ getConfig: () => config });
    await h.provider.init();
    assert.equal(h.generated, 0);
    config = FUNDING;
    const status = await h.provider.getStatus();
    assert.equal(status.exists, false);
    assert.equal(h.generated, 0);
    assert.equal(h.calls.length, 0);
});

test('browser custody is atomic, non-extractable and automatically restores the same address', async () => {
    const h = harness();
    assert.equal(await h.provider.ensureAddress(), OWN);
    assert.equal(h.provider.address, OWN);
    assert.equal(h.provider.unlocked, true);
    assert.equal(h.provider.backedUp, true, 'legacy callers have no backup gate for browser custody');
    assert.equal(h.provider.migrationRequired, false);
    const envelope = [...h.store.data.values()][0];
    assert.equal(envelope.version, 2);
    assert.equal(envelope.browserKey.extractable, false);
    assert.equal(envelope.browserKey.algorithm.name, 'AES-GCM');
    assert(!JSON.stringify(envelope).includes(KEY));
    assert(!JSON.stringify(envelope).includes('privateKey'));
    await assert.rejects(crypto.subtle.exportKey('raw', envelope.browserKey));
    const restored = new AddressFundingProvider(h.init);
    await restored.init();
    assert.equal(restored.address, OWN);
    assert.equal(restored.unlocked, true);
    assert.equal(await restored.ensureAddress(), OWN);
    assert.equal(h.generated, 1);
    assert.equal(h.calls.length, 0, 'create/restore never touches the network');
    assert.equal(h.sent.length, 0);
    await assert.rejects(restored.exportBackup(PASSWORD), { code: 'address_browser_only' });
});

test('lost, substituted or extractable browser keys fail closed without replacing the saved address', async () => {
    for (const replacement of [null, await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
        await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])]) {
        const h = harness();
        await h.ready();
        const [scope, envelope] = [...h.store.data.entries()][0];
        envelope.browserKey = replacement;
        h.store.data.set(scope, envelope);
        const restored = new AddressFundingProvider(h.init);
        await assert.rejects(restored.init(), { code: 'address_browser_key' });
        await assert.rejects(restored.ensureAddress(), { code: 'address_browser_key' });
        await assert.rejects(h.provider.reload(), { code: 'address_browser_key' });
        assert.equal(restored.address, null);
        assert.equal(h.provider.address, null, 'failed reload invalidates the prior usable state');
        assert.equal(h.provider.unlocked, false);
        assert.equal(h.generated, 1);
        assert.equal(h.store.data.get(scope), envelope, 'malformed custody stays untouched');
        assert.equal(h.sent.length, 0);
    }
});

test('browser envelope metadata is authenticated before any address can be used', async () => {
    const h = harness();
    await h.ready();
    const [scope, envelope] = [...h.store.data.entries()][0];
    envelope.pendingHash = `0x${'aa'.repeat(32)}`;
    h.store.data.set(scope, envelope);
    await assert.rejects(h.provider.ensureAddress(), { code: 'address_browser_key' });
    assert.equal(h.provider.address, null);
    assert.equal(h.generated, 1);
    assert.equal(h.sent.length, 0);
});

test('legacy records require explicit migration and are never replaced by automatic setup', async () => {
    const h = harness();
    await h.legacyReady();
    const before = [...h.store.data.entries()][0];
    const restored = new AddressFundingProvider(h.init);
    await restored.init();
    assert.equal(restored.migrationRequired, true);
    await assert.rejects(restored.ensureAddress(), { code: 'address_migration_required' });
    await assert.rejects(restored.migrateLegacy('incorrect-password'), { code: 'address_unlock' });
    assert.deepEqual([...h.store.data.entries()][0], before);
    assert.equal(h.generated, 1);
    assert.equal(h.sent.length, 0);
});

test('legacy migration durably preserves the exact journal and nonce across a new instance', async () => {
    const h = harness();
    await h.legacyReady();
    const hash = await h.send();
    const before = [...h.store.data.entries()][0];
    const ctx = await h.provider.context();
    const record = await h.provider.read(ctx, true);
    h.store.fail = true;
    await assert.rejects(h.provider.migrateLegacy(PASSWORD), { code: 'address_storage' });
    assert.deepEqual([...h.store.data.entries()][0], before, 'failed migration retains original decryptable row');
    h.store.fail = false;
    assert.equal(await h.provider.migrateLegacy(PASSWORD), OWN);
    assert.equal(h.provider.migrationRequired, false);
    assert.equal([...h.store.data.values()][0].version, 2);
    const restored = new AddressFundingProvider(h.init);
    await restored.init();
    assert.equal(restored.address, OWN);
    assert.equal(restored.pending.hash, hash);
    assert.deepEqual(await restored.read(ctx, true), record);
    assert.equal(h.sent.length, 1, 'migration and reload do not replay or sign');
    assert.equal(h.generated, 1);
    await assert.rejects(restored.restoreBackup(JSON.stringify(before[1]), PASSWORD), { code: 'address_exists' });
    assert.equal((await restored.read(ctx, true)).highestNonce, '1');
});

test('legacy creation preserves the old encrypted envelope and backup acknowledgment boundary', async () => {
    const h = harness();
    const result = await h.provider.create(PASSWORD);
    assert.equal(result.address, OWN);
    assert.equal(h.provider.address, null);
    assert.equal(h.provider.backedUp, false);
    assert(!result.backup.includes(KEY));
    assert(!JSON.stringify([...h.store.data.values()]).includes('privateKey'));
    assert.deepEqual(await h.provider.request({ method: 'eth_accounts' }), []);
    await assert.rejects(h.send(), { code: 'address_backup_required' });
    await h.provider.markBackedUp();
    assert.equal(h.provider.address, OWN);
    assert.equal(h.calls.length, 0);
});

test('failed browser custody persistence never exposes an address', async () => {
    const h = harness();
    h.store.fail = true;
    await assert.rejects(h.provider.ensureAddress(), { code: 'address_storage' });
    assert.equal(h.provider.address, null);
    assert.equal(h.provider.exists, false);
    assert.equal(h.sent.length, 0);
});

test('address setup cannot expose an address before custody reaches durable completion', async () => {
    const store = memoryStore();
    const entered = gate();
    const release = gate();
    const save = store.save.bind(store);
    store.save = async (...args) => { entered.resolve(); await release.promise; return save(...args); };
    const h = harness({ store });
    let settled = false;
    const setup = h.provider.ensureAddress().then(value => { settled = true; return value; });
    await entered.promise;
    assert.equal(settled, false);
    assert.equal(h.provider.address, null);
    assert.equal(h.provider.exists, false);
    assert.equal(store.data.size, 0);
    release.resolve();
    assert.equal(await setup, OWN);
    assert.equal(store.data.size, 1);
});

test('legacy reload stays password locked; wrong password and metadata tampering fail closed', async () => {
    const h = harness();
    await h.legacyReady();
    const restored = new AddressFundingProvider(h.init);
    await restored.init();
    assert.equal(restored.unlocked, false);
    assert.equal(restored.address, OWN);
    await assert.rejects(restored.request({ method: 'eth_requestAccounts' }), { code: 4100 });
    await assert.rejects(restored.unlock('incorrect-password'), { code: 'address_unlock' });
    await restored.unlock(PASSWORD);
    assert.equal(restored.unlocked, true);
    const [scope, envelope] = [...h.store.data.entries()][0];
    envelope.pendingHash = `0x${'aa'.repeat(32)}`;
    h.store.data.set(scope, envelope);
    await assert.rejects(restored.reload(), { code: 'address_unlock' });
    assert.equal(h.sent.length, 0);
});

test('transaction is exactly signed and saved before broadcast; only SDK acknowledgement releases it', async () => {
    const h = harness();
    await h.ready();
    const hash = await h.send();
    const decoded = Transaction.from(h.sent[0]);
    assert.equal(hash, decoded.hash);
    assert.equal(decoded.from.toLowerCase(), OWN);
    assert.equal(decoded.chainId, 1n);
    assert.equal(decoded.type, 2);
    assert.equal(decoded.maxPriorityFeePerGas, BigInt(h.rpc.priorityFee));
    assert.equal(decoded.maxFeePerGas, BigInt(h.rpc.baseFee) * 2n + BigInt(h.rpc.priorityFee));
    assert.equal(decoded.nonce, 0);
    assert.equal(decoded.to.toLowerCase(), TOKEN);
    assert.equal(decoded.data, approve(2000000).data);
    assert.equal(h.provider.pending.hash, hash);
    h.rpc.receipt = { transactionHash: hash, status: '0x1' };
    await h.provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    assert.equal(h.provider.pending.hash, hash);
    await assert.rejects(h.send(), { code: 'address_transaction_pending' });
    await h.provider.acknowledgeTransaction(hash);
    assert.equal(h.provider.pending, null);
    assert(h.calls.every(call => call.options.credentials === 'omit' && call.options.redirect === 'error'));
});

test('broadcast ambiguity survives automatic browser restore without signing or replay on init', async () => {
    const h = harness();
    await h.ready();
    h.rpc.ambiguous = true;
    const hash = await h.send();
    const recovered = [];
    const provider = new AddressFundingProvider({ ...h.init, resumeTransaction: async record => {
        recovered.push(record);
        assert.equal(provider.pending.hash, hash);
        await provider.acknowledgeTransaction(record.hash);
    } });
    await provider.init();
    assert.equal(provider.pending.hash, hash);
    assert.equal(provider.unlocked, true);
    await provider.getStatus();
    assert.equal(h.sent.length, 1, 'status does not replay');
    h.rpc.baseFee = undefined;
    h.rpc.priorityFee = undefined;
    await provider.recoverPending();
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[0], h.sent[1]);
    assert.equal(Transaction.from(h.sent[1]).type, 2);
    assert.equal(h.calls.filter(call => call.method === 'eth_maxPriorityFeePerGas').length, 1, 'recovery never requotes fees');
    assert.deepEqual(recovered[0].context, CONTEXT);
    assert.equal(recovered[0].transaction.nonce, '0x0');
    assert.equal(provider.pending, null);
});

test('a restored legacy encrypted journal replays its original signed bytes without fetching new fees', async () => {
    const original = harness();
    await original.legacyReady();
    const legacy = await saveSignedFixture(original, { type: 0, gasPrice: 935000000n });
    const backup = await original.provider.exportBackup(PASSWORD);
    const restored = harness();
    await restored.provider.restoreBackup(backup, PASSWORD);
    assert.equal(restored.provider.pending.hash, legacy.hash);
    await restored.provider.recoverPending();
    assert.deepEqual(restored.sent, [legacy.raw]);
    assert.equal(Transaction.from(restored.sent[0]).type, 0);
    assert.equal(restored.provider.pending, null);
    assert.equal(restored.calls.some(call => ['eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_getBlockByNumber'].includes(call.method)), false);
});

test('encrypted journals reject unsupported transaction types and unsafe type-2 fee fields', async () => {
    const h = harness();
    await h.ready();
    for (const fees of [
        { type: 1, gasPrice: 1000000000n, accessList: [] },
        { type: 2, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 0n },
        { type: 2, maxFeePerGas: 301000000000n, maxPriorityFeePerGas: 1000000n },
        { type: 2, maxFeePerGas: 200000000000n, maxPriorityFeePerGas: 1000000n },
        { type: 2, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000n,
            accessList: [{ address: TOKEN, storageKeys: [] }] }
    ]) {
        // Start each corrupted-but-authentically-encrypted fixture from a clean record.
        h.store.data.clear();
        await h.ready();
        await saveSignedFixture(h, fees);
        const restored = new AddressFundingProvider(h.init);
        await assert.rejects(restored.init(), { code: 'address_storage_invalid' });
    }
    assert.equal(h.sent.length, 0);
});

test('missing or malformed fee data fails before signing without a legacy fallback', async () => {
    const h = harness();
    await h.ready();
    const goodBase = h.rpc.baseFee;
    const goodTip = h.rpc.priorityFee;
    for (const value of [undefined, null, '', 'not-a-fee', '-1', 0.5]) {
        h.rpc.baseFee = value;
        h.rpc.priorityFee = goodTip;
        await assert.rejects(h.send(), { code: 4100, addressCode: 'address_fee_data' });
        h.rpc.baseFee = goodBase;
        h.rpc.priorityFee = value;
        await assert.rejects(h.send(), { code: 4100, addressCode: 'address_fee_data' });
    }
    assert.equal(h.sent.length, 0);
    assert.equal(h.provider.pending, null);
    assert.equal(h.calls.some(call => call.method === 'eth_gasPrice'), false);
});

test('zero fee suggestions retain a small tip and enough room for the next block', async () => {
    const h = harness();
    await h.ready();
    h.rpc.baseFee = '0x0';
    h.rpc.priorityFee = '0x0';
    await h.send();
    const transaction = Transaction.from(h.sent[0]);
    assert.equal(transaction.maxPriorityFeePerGas, 1000000n);
    assert.equal(transaction.maxFeePerGas, 1000001n);
});

test('the total fee ceiling clips headroom but rejects a quote that cannot cover the next block and tip', async () => {
    const h = harness();
    await h.ready();
    const gas = `0x${8000000n.toString(16)}`;
    h.rpc.baseFee = `0x${2133333335n.toString(16)}`;
    await assert.rejects(h.send({ ...approve(2000000), gas }), { code: 4100, addressCode: 'address_fee_limit' });
    assert.equal(h.sent.length, 0);
    h.rpc.baseFee = `0x${2133333334n.toString(16)}`;
    await h.send({ ...approve(2000000), gas });
    const transaction = Transaction.from(h.sent[0]);
    assert.equal(transaction.maxFeePerGas, 2500000000n);
    assert.equal(transaction.maxPriorityFeePerGas, BigInt(h.rpc.priorityFee));
    assert.equal(transaction.maxFeePerGas * transaction.gasLimit, 20000000000000000n);
    await h.provider.reload();
});

test('the per-gas price ceiling clips headroom and is enforced independently of total fees', async () => {
    const h = harness();
    await h.ready();
    h.rpc.gas = '0x5208';
    h.rpc.baseFee = `0x${200000000000n.toString(16)}`;
    h.rpc.priorityFee = `0x${10000000000n.toString(16)}`;
    await h.send();
    const transaction = Transaction.from(h.sent[0]);
    assert.equal(transaction.maxFeePerGas, 300000000000n);
    assert(transaction.maxFeePerGas * transaction.gasLimit < 20000000000000000n);
});

test('funding must cover maximum fee liability even when it covers the current effective fee', async () => {
    const h = harness();
    await h.ready();
    h.rpc.balance = `0x${(120000n * (BigInt(h.rpc.baseFee) + BigInt(h.rpc.priorityFee))).toString(16)}`;
    await assert.rejects(h.send(), { code: 4100, addressCode: 'address_insufficient_eth' });
    assert.equal(h.sent.length, 0);
});

test('journal failure prevents broadcast, and recovery callback failure preserves its journal', async () => {
    const h = harness();
    await h.ready();
    h.store.fail = true;
    await assert.rejects(h.send(), { code: 4100, addressCode: 'address_storage' });
    assert.equal(h.sent.length, 0);
    h.store.fail = false;
    const hash = await h.send();
    h.provider.resumeTransaction = async () => { throw new Error('SDK journal unavailable'); };
    await assert.rejects(h.provider.recoverPending(), /SDK journal unavailable/);
    assert.equal(h.provider.pending.hash, hash);
    assert.equal(h.sent[0], h.sent[1]);
});

test('restoring an older backup cannot overwrite a newer local signed journal', async () => {
    const h = harness();
    const { backup } = await h.legacyReady();
    const hash = await h.send();
    await h.provider.restoreBackup(backup, PASSWORD);
    assert.equal(h.provider.pending.hash, hash);
    const other = harness({ createWallet: () => Wallet.createRandom() });
    const alternate = await other.legacyReady();
    await assert.rejects(h.provider.restoreBackup(alternate.backup, PASSWORD), { code: 'address_exists' });
    const fresh = harness();
    await fresh.provider.restoreBackup(backup, PASSWORD);
    assert.equal(fresh.provider.address, OWN);
    assert.equal(fresh.provider.backedUp, true);
});

test('cross-tab action ownership rejects concurrent spending and serializes account creation', async () => {
    const h = harness();
    const other = new AddressFundingProvider(h.init);
    const creations = await Promise.all([h.provider.ensureAddress(), other.ensureAddress()]);
    assert.deepEqual(creations, [OWN, OWN]);
    assert.equal(h.generated, 1);
    const entered = gate();
    const release = gate();
    const running = h.provider.withAuthorizedAction(auth, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    await assert.rejects(other.withAuthorizedAction(auth, async () => {}), { code: 'address_busy' });
    release.resolve();
    await running;
});

test('authorization rejects unexpected contract, allowance, call shape, value and automatic signing', async () => {
    const h = harness();
    await h.ready();
    await assert.rejects(h.provider.request({ method: 'eth_sendTransaction', params: [approve(2000000)], zkapiRecovery: CONTEXT }), { code: 4100 });
    for (const input of [approve(2000001), { ...approve(2000000), to: DESTINATION },
        { ...approve(2000000), value: '0x1' }, { ...approve(2000000), data: `${approve(2000000).data}00` },
        { ...approve(2000000), gasPrice: '0x1' }]) await assert.rejects(h.send(input));
    await assert.rejects(h.send(approve(2000000), { ...CONTEXT, secret: KEY }));
    await assert.rejects(h.send(approve(2000000), CONTEXT, { kind: 'recovery' }), { code: 4100 });
    assert.equal(h.sent.length, 0);
});

test('wrong chain, failed simulation, high fees, and signed nonce rollback cannot send', async () => {
    const h = harness();
    await h.ready();
    h.rpc.chain = '0x2';
    await assert.rejects(h.send(), { code: 4100, addressCode: 'wrong_network' });
    h.rpc.chain = '0x1';
    h.rpc.simulationFails = true;
    await assert.rejects(h.send(), error => error.code === 4100 && error.addressCode === 'address_rpc_error' && !error.message.includes(KEY));
    h.rpc.simulationFails = false;
    h.rpc.baseFee = '0x45d964b800'; // 300 gwei; buffered gas * price exceeds total fee cap.
    await assert.rejects(h.send(), { code: 4100, addressCode: 'address_fee_limit' });
    h.rpc.baseFee = '0x1dcd6500';
    assert.equal(h.sent.length, 0);
    const hash = await h.send();
    await h.provider.acknowledgeTransaction(hash);
    await assert.rejects(h.send(), { code: 4100, addressCode: 'address_nonce' });
    assert.equal(h.sent.length, 1);
});

test('an acknowledged missing transaction is only replayed by an explicit recovery action', async () => {
    const h = harness();
    await h.ready();
    const hash = await h.send();
    await h.provider.acknowledgeTransaction(hash);
    const check = () => h.provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    await check();
    assert.equal(h.sent.length, 1);
    await h.provider.withAuthorizedAction({ kind: 'recovery' }, check);
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[0], h.sent[1]);
});

test('late acknowledgements never erase a newer pending transaction', async () => {
    const h = harness();
    await h.ready();
    const first = await h.send();
    await h.provider.acknowledgeTransaction(first);
    h.rpc.nonce = '0x1';
    const second = await h.send();
    await h.provider.acknowledgeTransaction(first);
    assert.equal(h.provider.pending.hash, second);
});

test('token sweep uses explicit amount and destination, remains blocked until canonical finality', async () => {
    const h = harness();
    await h.ready();
    await assert.rejects(h.provider.transferTokens(DESTINATION, '1000'), { code: 4100 });
    const hash = await h.provider.withAuthorizedAction({ kind: 'sweep', asset: 'token', destination: DESTINATION, amount: '1000' },
        () => h.provider.transferTokens(DESTINATION, '1000'));
    assert.equal(Transaction.from(h.sent[0]).data, `0xa9059cbb${DESTINATION.slice(2).padStart(64, '0')}${'3e8'.padStart(64, '0')}`);
    await assert.rejects(h.provider.acknowledgeTransaction(hash), { code: 4100 });
    h.rpc.receipt = { transactionHash: hash, blockHash: h.rpc.blockHash, blockNumber: '0x21', status: '0x1' };
    assert.equal((await h.provider.recoverPending()).status, 'pending');
    assert.equal(h.provider.pending.hash, hash);
    h.rpc.finalized = '0x21';
    assert.equal((await h.provider.recoverPending()).status, 'confirmed');
    assert.equal(h.provider.pending, null);
    assert.equal(h.resumes.length, 0, 'public sweeps never enter private-note recovery');
});

test('ETH max sweep reserves the signed maximum fee using one quote on an ordinary account', async () => {
    const h = harness();
    await h.ready();
    h.rpc.gas = '0x5208';
    const hash = await h.provider.withAuthorizedAction({ kind: 'sweep', asset: 'eth', destination: DESTINATION, amount: 'max' },
        () => h.provider.transferEth(DESTINATION, 'max'));
    const transaction = Transaction.from(h.sent[0]);
    assert.equal(hash, transaction.hash);
    assert.equal(transaction.value + transaction.gasLimit * transaction.maxFeePerGas, BigInt(h.rpc.balance));
    assert.equal(transaction.gasLimit, 21000n);
    assert.equal(h.calls.filter(call => call.method === 'eth_maxPriorityFeePerGas').length, 1);
    assert.equal(h.calls.filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] === 'latest').length, 1);
    assert.equal(h.calls.filter(call => call.method === 'eth_gasPrice').length, 0);
});

test('ETH max return refuses contract recipients and insufficient fee reserves without signing', async () => {
    const h = harness();
    await h.ready();
    h.rpc.gas = '0x5208';
    const send = () => h.provider.withAuthorizedAction({ kind: 'sweep', asset: 'eth', destination: DESTINATION, amount: 'max' },
        () => h.provider.transferEth(DESTINATION, 'max'));
    h.rpc.code = '0x6000';
    await assert.rejects(send(), { code: 'address_sweep_contract' });
    h.rpc.code = '0x';
    h.rpc.balance = `0x${(21000n * (BigInt(h.rpc.baseFee) * 2n + BigInt(h.rpc.priorityFee))).toString(16)}`;
    await assert.rejects(send(), { code: 'address_insufficient_eth' });
    assert.equal(h.sent.length, 0);
});

test('an exact ETH return keeps its authorized wei amount and supports contract destinations', async () => {
    const h = harness();
    await h.ready();
    const amount = '10000000000000001';
    const hash = await h.provider.withAuthorizedAction({ kind: 'sweep', asset: 'eth', destination: DESTINATION, amount },
        () => h.provider.transferEth(DESTINATION, amount));
    assert.equal(h.sent.length, 1);
    const transaction = Transaction.from(h.sent[0]);
    assert.equal(transaction.hash, hash);
    assert.equal(transaction.value, BigInt(amount));
    assert.equal(transaction.to.toLowerCase(), DESTINATION);
    assert.equal(transaction.data, '0x');
    assert.equal(transaction.gasLimit, 120000n, 'exact amounts use simulated gas rather than the EOA-only sweep limit');
    assert.equal(h.calls.some(call => call.method === 'eth_getCode'), false, 'exact amount transfers do not impose the max-sweep EOA restriction');
});

test('actual SDK accepts observed deposit gas, sends its public context and persists hash before acknowledgement', async t => {
    const h = harness();
    await h.ready();
    // Historical deployed-vault usage: the SDK adds 20% plus 50k padding.
    h.rpc.gas = `0x${6_897_262n.toString(16)}`;
    const oldManifest = runtime.manifest;
    runtime.manifest = { deployment_id: 'fixture' };
    t.after(() => { runtime.manifest = oldManifest; });
    const client = new ZkapiClient();
    client.config = { funding: FUNDING };
    client.browserMode = true;
    client.setWalletProvider(h.provider);
    const plan = { commitment: '0x123', zero_path: Array(32).fill('0x0') };
    const submission = { operationId: 'deposit-op', submissionId: 'deposit-claim', amount: 2000000, commitment: plan.commitment, noteId: 7 };
    let persisted;
    const originalAck = h.provider.acknowledgeTransaction.bind(h.provider);
    h.provider.acknowledgeTransaction = async hash => { assert.equal(hash, persisted); return originalAck(hash); };
    client.waitForReceipt = async hash => ({ transactionHash: hash, status: '0x1' });
    const receipt = await h.provider.withAuthorizedAction(auth, () => client.sendContractTransaction(OWN, VAULT, codec.encodeDeposit(plan, 2000000n),
        async hash => { assert.equal(h.provider.pending.hash, hash); persisted = hash; },
        async metadata => { assert.deepEqual(metadata, { from: OWN, nonce: 0 }); }, null, { kind: 'deposit', submission }));
    assert.equal(receipt.transactionHash, persisted);
    assert.equal(h.provider.pending, null);
    assert.equal(h.sent.length, 1);
    assert.equal(Transaction.from(h.sent[0]).gasLimit, 8_326_714n);
    assert.equal(BigInt(bufferedGasLimit(6_897_262n)), 8_326_714n);
    await h.provider.reload(); // The durable signed-journal validator uses the same ceiling.
});

test('native deposit signs only the exact authorized gwei-to-wei principal and restores its payable journal', async () => {
    const h = harness({ config: NATIVE_FUNDING });
    await h.ready();
    const amount = 2_000_000n;
    const plan = { commitment: '0x123', zero_path: Array(32).fill('0x0') };
    const context = { ...CONTEXT, kind: 'deposit', operationId: 'deposit-op', submissionId: 'deposit-sub',
        amount: amount.toString(), commitment: plan.commitment };
    const input = { from: OWN, to: VAULT, data: codec.encodeDeposit(plan, amount), value: `0x${(amount * 1_000_000_000n).toString(16)}` };
    for (const value of ['0x0', `0x${(amount * 1_000_000_000n - 1n).toString(16)}`, `0x${(amount * 1_000_000_000n + 1n).toString(16)}`]) {
        await assert.rejects(h.send({ ...input, value }, context, { kind: 'deposit', amount: amount.toString() }), { code: 4100 });
    }
    await assert.rejects(h.send(input, context, { kind: 'deposit', amount: (amount + 1n).toString() }), { code: 4100 });
    await assert.rejects(h.send(input, { ...context, amount: (amount + 1n).toString() }, { kind: 'deposit', amount: amount.toString() }), { code: 4100 });
    assert.equal(h.sent.length, 0);
    const hash = await h.send(input, context, { kind: 'deposit', amount: amount.toString() });
    assert.equal(Transaction.from(h.sent[0]).value, amount * 1_000_000_000n);
    const restored = new AddressFundingProvider(h.init);
    await restored.init();
    assert.equal(restored.address, OWN);
    assert.equal(restored.pending.hash, hash);
    assert.equal(restored.pending.transaction.value, input.value);
    assert.equal(h.sent.length, 1, 'reopening never rebroadcasts');
    await restored.recoverPending();
    assert.equal(h.sent[0], h.sent[1]);
});

test('one native deposit authorization cannot spend the principal again after acknowledgement', async () => {
    const h = harness({ config: NATIVE_FUNDING });
    await h.ready();
    const amount = 2_000_000n;
    const plan = { commitment: '0x123', zero_path: Array(32).fill('0x0') };
    const context = { ...CONTEXT, kind: 'deposit', operationId: 'deposit-op', submissionId: 'deposit-sub',
        amount: amount.toString(), commitment: plan.commitment };
    const input = { from: OWN, to: VAULT, data: codec.encodeDeposit(plan, amount), value: `0x${(amount * 1_000_000_000n).toString(16)}` };
    await h.provider.withAuthorizedAction({ kind: 'deposit', amount: amount.toString() }, async () => {
        const hash = await h.provider.request({ method: 'eth_sendTransaction', params: [input], zkapiRecovery: context });
        await h.provider.acknowledgeTransaction(hash);
        h.rpc.nonce = '0x1';
        await assert.rejects(h.provider.request({ method: 'eth_sendTransaction', params: [input], zkapiRecovery: context }), /transaction limit/);
    });
    assert.equal(h.sent.length, 1);
});

test('storage read failures clear previously usable custody state', async () => {
    const h = harness();
    await h.ready();
    h.store.load = async () => { throw new Error('Read unavailable'); };
    await assert.rejects(h.provider.reload(), /Read unavailable/);
    assert.equal(h.provider.address, null);
    assert.equal(h.provider.unlocked, false);
    assert.equal(h.provider.session, null);
    assert.equal(h.generated, 1);
});

test('native vault rejects token calls, positive-value finalization and invalid ledger scales', async () => {
    const h = harness({ config: NATIVE_FUNDING });
    await h.ready();
    await assert.rejects(h.send(), { code: 4100 });
    await assert.rejects(h.provider.withAuthorizedAction({ kind: 'sweep', asset: 'token', amount: '1', destination: DESTINATION },
        () => h.provider.transferTokens(DESTINATION, '1')), { code: 'address_native_config' });
    const context = { ...CONTEXT, kind: 'finalization', noteId: 7, operationId: 'finalize-op', submissionId: 'finalize-sub' };
    const input = { from: OWN, to: VAULT, data: `0xff8f5585${codec.abiWord(7)}`, value: '0x1' };
    await assert.rejects(h.send(input, context, { kind: 'finalization', noteId: 7 }), { code: 4100 });
    assert.equal(h.sent.length, 0);
    const wrongScale = harness({ config: { ...NATIVE_FUNDING, native_asset_wei_per_unit: '1000000' } });
    await assert.rejects(wrongScale.provider.ensureAddress(), { code: 'address_native_config' });
    const wrongDecimals = harness({ config: { ...NATIVE_FUNDING, billing_unit: 'wei' } });
    await assert.rejects(wrongDecimals.provider.ensureAddress(), { code: 'address_native_config' });
    assert.equal(wrongScale.generated, 0);
    assert.equal(wrongDecimals.generated, 0);
});

test('native status reads only ETH and conservatively exposes its whole gwei ledger units', async () => {
    const h = harness({ config: NATIVE_FUNDING });
    await h.ready();
    h.rpc.balance = `0x${1_234_567_890_123_456n.toString(16)}`;
    const status = await h.provider.getStatus();
    assert.equal(status.assetKind, 'native_eth');
    assert.equal(status.tokenSymbol, 'ETH');
    assert.equal(status.tokenDecimals, 9);
    assert.equal(status.ethBalance, '1234567890123456');
    assert.equal(status.tokenBalance, '1234567');
    assert.equal(h.calls.some(call => call.method === 'eth_call'), false);
    assert.equal(h.sent.length, 0);
});

test('pre-funding ETH reserve uses the spending ceiling without authorizing hypothetical transaction fees', async () => {
    const h = harness({ config: NATIVE_FUNDING });
    for (const baseFee of [1_112_000_000n, 10_000_000_000n]) {
        h.rpc.baseFee = `0x${baseFee.toString(16)}`;
        const before = Date.now();
        const quote = await h.provider.getDepositFeeQuote();
        assert.equal(quote.feeReserveWei, '20000000000000000');
        assert.equal(quote.feeWei, quote.feeReserveWei);
        assert.equal(quote.reserveKind, 'transaction_fee_ceiling');
        assert.equal(quote.chainId, 1);
        assert.equal(Object.hasOwn(quote, 'gasLimit'), false);
        assert.equal(Object.hasOwn(quote, 'maxFeePerGas'), false);
        assert.equal(Object.hasOwn(quote, 'maxPriorityFeePerGas'), false);
        assert(quote.quotedAt >= before && quote.quotedAt <= Date.now());
        assert.equal(quote.expiresAt - quote.quotedAt, 60_000);
    }
    assert.equal(h.generated, 0);
    assert.equal(h.store.data.size, 0);
    assert.equal(h.sent.length, 0);
    assert(h.calls.every(call => call.method === 'eth_chainId'), 'a reserve read checks only network identity');
    h.rpc.chain = '0x2';
    await assert.rejects(h.provider.getDepositFeeQuote(), { code: 'wrong_network' });
});

test('funded native deposit uses its actual gas at reproduced Sepolia fees and retains the total fee cap', async () => {
    const h = harness({ config: NATIVE_FUNDING });
    await h.ready();
    h.rpc.baseFee = `0x${1_112_000_000n.toString(16)}`;
    h.rpc.gas = `0x${6_897_262n.toString(16)}`;
    const gas = bufferedGasLimit(BigInt(h.rpc.gas));
    const amount = 2_000_000n;
    const principal = amount * 1_000_000_000n;
    const quote = await h.provider.getDepositFeeQuote();
    h.rpc.balance = `0x${(principal + BigInt(quote.feeReserveWei)).toString(16)}`;
    const plan = { commitment: '0x123', zero_path: Array(32).fill('0x0') };
    const context = { ...CONTEXT, kind: 'deposit', operationId: 'deposit-op', submissionId: 'deposit-sub',
        amount: amount.toString(), commitment: plan.commitment };
    const input = { from: OWN, to: VAULT, data: codec.encodeDeposit(plan, amount), gas, value: `0x${principal.toString(16)}` };
    await assert.rejects(h.provider.request({ method: 'eth_sendTransaction', params: [input], zkapiRecovery: context }),
        { code: 4100 }, 'getting a reserve never authorizes signing');
    await h.send(input, context, { kind: 'deposit', amount: amount.toString() });
    const signed = Transaction.from(h.sent[0]);
    assert.equal(signed.value, principal);
    assert.equal(signed.gasLimit, BigInt(gas));
    assert.equal(signed.maxFeePerGas, BigInt(h.rpc.baseFee) * 2n + BigInt(h.rpc.priorityFee));
    assert(signed.gasLimit * signed.maxFeePerGas <= BigInt(quote.feeReserveWei));
    assert(h.calls.some(call => call.method === 'eth_estimateGas'));
    assert(h.calls.some(call => call.method === 'eth_getBlockByNumber' && call.params[0] === 'latest'));
});

test('prefunding reserve never bypasses actual native fee, fee-data or affordability rejection', async () => {
    for (const failure of ['expensive', 'malformed', 'underfunded']) {
        const h = harness({ config: NATIVE_FUNDING });
        await h.ready();
        h.rpc.gas = `0x${6_897_262n.toString(16)}`;
        h.rpc.baseFee = `0x${1_112_000_000n.toString(16)}`;
        const gas = bufferedGasLimit(BigInt(h.rpc.gas));
        const amount = 2_000_000n;
        const principal = amount * 1_000_000_000n;
        const quote = await h.provider.getDepositFeeQuote();
        h.rpc.balance = `0x${(principal + BigInt(quote.feeReserveWei)).toString(16)}`;
        const plan = { commitment: '0x123', zero_path: Array(32).fill('0x0') };
        const context = { ...CONTEXT, kind: 'deposit', operationId: 'deposit-op', submissionId: 'deposit-sub',
            amount: amount.toString(), commitment: plan.commitment };
        const input = { from: OWN, to: VAULT, data: codec.encodeDeposit(plan, amount), gas, value: `0x${principal.toString(16)}` };
        let addressCode;
        if (failure === 'expensive') {
            h.rpc.baseFee = `0x${10_000_000_000n.toString(16)}`;
            addressCode = 'address_fee_limit';
        } else if (failure === 'malformed') {
            h.rpc.baseFee = undefined;
            addressCode = 'address_fee_data';
        } else {
            const exactLiability = BigInt(gas) * (BigInt(h.rpc.baseFee) * 2n + BigInt(h.rpc.priorityFee));
            h.rpc.balance = `0x${(principal + exactLiability - 1n).toString(16)}`;
            addressCode = 'address_insufficient_eth';
        }
        await assert.rejects(h.send(input, context, { kind: 'deposit', amount: amount.toString() }), { code: 4100, addressCode });
        assert.equal(h.sent.length, 0);
        assert.equal(h.provider.pending, null);
        const record = await h.provider.read(await h.provider.context(), true);
        assert.equal(record.transactions.length, 0, 'no signed bytes are added after a pre-signing rejection');
    }
});

test('withdrawal reports the exact safe top-up after SDK error handling and only retries explicitly', async () => {
    const h = harness({ config: NATIVE_FUNDING });
    await h.ready();
    h.rpc.balance = '0x9184e72a000'; // 0.00001 ETH; quoted liability is 0.000132 ETH.
    const plan = { mode: 'mutual', siblings: Array(32).fill('0x0'), proof: { backend: 'groth16_bn254', proof: Buffer.alloc(256).toString('base64') },
        public_inputs: { protocol_version: 2, chain_id: 1, contract_address: VAULT, active_root: '0x1',
            state_signing_key_x: '0x1', state_signing_key_y: '0x1', clearance_signing_key_x: '0x1', clearance_signing_key_y: '0x1',
            note_id: 7, final_balance: 1500000, destination: DESTINATION, withdrawal_nullifier: '0x7', has_clearance: true, withdrawal_tag: '0x8' } };
    const input = { from: OWN, to: VAULT, data: codec.encodeWithdrawal(plan, 'mutual', DESTINATION, VAULT) };
    const context = { ...CONTEXT, kind: 'withdrawal', operationId: 'op', submissionId: 'sub', noteId: 7,
        destination: DESTINATION, finalBalance: 1500000, mode: 'mutual' };
    const authorization = { kind: 'withdrawal', destination: DESTINATION, noteId: 7, mode: 'mutual' };
    const unchanged = structuredClone({ plan, context });
    let sdkHandled = false;
    await assert.rejects(h.provider.withAuthorizedAction(authorization, async () => {
        try { await h.provider.request({ method: 'eth_sendTransaction', params: [input], zkapiRecovery: context }); }
        catch (error) {
            // The SDK preserves the Error object while replacing its display copy.
            error.shortMessage = 'The wallet refused the transaction before broadcast.';
            error.withdrawalNeedsAction = true;
            error.broadcastPossible = false;
            sdkHandled = true;
            throw error;
        }
    }), error => {
        assert.equal(sdkHandled, true);
        assert.equal(error.code, 4100);
        assert.equal(error.addressCode, 'address_insufficient_eth');
        assert.equal(error.withdrawalNeedsAction, true);
        assert.equal(error.broadcastPossible, false);
        assert.match(error.shortMessage, /0\.000122 ETH more/);
        assert.match(error.shortMessage, new RegExp(OWN));
        assert.match(error.shortMessage, /Ethereum Mainnet, then retry the action/);
        assert.equal(error.message, error.shortMessage);
        assert.deepEqual(error.fundingRequirement, { address: OWN, chainId: 1, balanceWei: '10000000000000',
            feeReserveWei: '132000000000000', requiredWei: '132000000000000', shortfallWei: '122000000000000' });
        assert(!error.shortMessage.includes(input.data));
        assert(!JSON.stringify(error.fundingRequirement).includes(KEY));
        return true;
    });
    assert.deepEqual({ plan, context }, unchanged);
    assert.equal(h.provider.action, null, 'the explanation is not retained between actions');
    assert.equal(h.provider.pending, null);
    assert.equal(h.sent.length, 0);
    h.rpc.balance = '0x780de2874000'; // The exact 0.000132 ETH quoted liability.
    await h.provider.getStatus();
    assert.equal(h.sent.length, 0, 'a top-up and status check never resubmit');
    await h.send(input, context, authorization);
    assert.equal(h.sent.length, 1);
    assert.equal(h.provider.pending.context.destination, DESTINATION);
});

test('safe fee-limit and fee-data explanations survive generic SDK copy without RPC details', async () => {
    for (const scenario of [
        { baseFee: `0x${300_000_000_000n.toString(16)}`, code: 'address_fee_limit', text: /Wait for lower fees, then retry/ },
        { baseFee: undefined, code: 'address_fee_data', text: /fees could not be read reliably/ }
    ]) {
        const h = harness();
        await h.ready();
        h.rpc.baseFee = scenario.baseFee;
        await assert.rejects(h.provider.withAuthorizedAction(auth, async () => {
            try { await h.provider.request({ method: 'eth_sendTransaction', params: [approve(2000000)], zkapiRecovery: CONTEXT }); }
            catch (error) { error.shortMessage = `Generic SDK copy ${KEY}`; throw error; }
        }), error => {
            assert.equal(error.addressCode, scenario.code);
            assert.match(error.shortMessage, scenario.text);
            assert(!error.shortMessage.includes(KEY));
            assert.equal(error.fundingRequirement, undefined);
            return true;
        });
        assert.equal(h.sent.length, 0);
        assert.equal(h.provider.pending, null);
    }
});

test('a later SDK failure or a new action never inherits a prior safe funding explanation', async () => {
    const h = harness();
    await h.ready();
    h.rpc.baseFee = undefined;
    const different = new Error('SDK journal persistence failed');
    await assert.rejects(h.provider.withAuthorizedAction(auth, async () => {
        try { await h.provider.request({ method: 'eth_sendTransaction', params: [approve(2000000)], zkapiRecovery: CONTEXT }); }
        catch { throw different; }
    }), error => error === different && error.shortMessage === undefined);
    const next = new Error('Different action failed');
    await assert.rejects(h.provider.withAuthorizedAction(auth, async () => { throw next; }), error => error === next && error.shortMessage === undefined);
    assert.equal(h.provider.action, null);
    assert.equal(h.sent.length, 0);
});

test('actual SDK withdrawal codec is accepted only for proof-bound authorized recipient and mode', async () => {
    const h = harness();
    await h.ready();
    const plan = { mode: 'mutual', siblings: Array(32).fill('0x0'), proof: { backend: 'groth16_bn254', proof: Buffer.alloc(256).toString('base64') },
        public_inputs: { protocol_version: 2, chain_id: 1, contract_address: VAULT, active_root: '0x1',
            state_signing_key_x: '0x1', state_signing_key_y: '0x1', clearance_signing_key_x: '0x1', clearance_signing_key_y: '0x1',
            note_id: 7, final_balance: 1500000, destination: DESTINATION, withdrawal_nullifier: '0x7', has_clearance: true, withdrawal_tag: '0x8' } };
    const transaction = { from: OWN, to: VAULT, data: codec.encodeWithdrawal(plan, 'mutual', DESTINATION, VAULT) };
    const context = { ...CONTEXT, kind: 'withdrawal', operationId: 'op', submissionId: 'sub', noteId: 7,
        destination: DESTINATION, finalBalance: 1500000, mode: 'mutual' };
    const authorization = { kind: 'withdrawal', destination: DESTINATION, noteId: 7, mode: 'mutual' };
    await assert.rejects(h.send(transaction, context, { ...authorization, mode: 'escape' }));
    await assert.rejects(h.send(transaction, context, { ...authorization, destination: OWN }));
    await h.send(transaction, context, authorization);
    assert.equal(h.sent.length, 1);
});

test('IndexedDB store resolves writes only after strict transaction completion, including abort after put', async () => {
    const opened = {};
    const transaction = { objectStore: () => ({ put: () => request }) };
    const request = {};
    let options;
    const database = { transaction: (_store, _mode, passedOptions) => { options = passedOptions; return transaction; } };
    const indexedDB = { open: () => { queueMicrotask(() => { opened.result = database; opened.onsuccess(); }); return opened; } };
    const store = createAddressFundingStore({ indexedDB });
    let settled = false;
    const write = store.save('scope', { format: 'oa-address-wallet', version: 1, ciphertext: 'ciphertext' }).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    request.result = 1;
    request.onsuccess();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(options.durability, 'strict');
    transaction.oncomplete();
    await write;
    const failed = store.save('scope', { format: 'oa-address-wallet', version: 1, ciphertext: 'ciphertext' });
    await new Promise(resolve => setImmediate(resolve));
    request.onsuccess();
    transaction.onabort();
    await assert.rejects(failed, { code: 'address_storage' });
});

test('IndexedDB atomically adds the browser key with its envelope and cannot overwrite on creation', async () => {
    const opened = {};
    const request = {};
    let captured;
    let options;
    const transaction = { objectStore: () => ({
        add: (record, scope) => { captured = { record: structuredClone(record), scope }; return request; },
        put: () => assert.fail('first creation must never overwrite an existing row')
    }) };
    const database = { transaction: (_store, _mode, passedOptions) => { options = passedOptions; return transaction; } };
    const indexedDB = { open: () => { queueMicrotask(() => { opened.result = database; opened.onsuccess(); }); return opened; } };
    const store = createAddressFundingStore({ indexedDB });
    const h = harness();
    await h.ready();
    const [scope, envelope] = [...h.store.data.entries()][0];
    const pending = store.save(scope, envelope, { createOnly: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(options.durability, 'strict');
    assert.equal(captured.scope, scope);
    assert.equal(captured.record.ciphertext, envelope.ciphertext);
    assert.equal(captured.record.browserKey.extractable, false);
    assert.equal(captured.record.browserKey.algorithm.name, 'AES-GCM');
    transaction.onabort(); // An existing-key constraint or disk failure aborts both together.
    await assert.rejects(pending, { code: 'address_storage' });
    assert.throws(() => store.save(scope, { ...envelope, browserKey: undefined }), { code: 'address_storage' });
    assert.throws(() => store.save(scope, { ...envelope, privateKey: KEY }), { code: 'address_storage' });
});

test('local Anvil executes native deposit value, signed approval, exact recovery replay and ETH return', { timeout: 30_000 }, async t => {
    const { spawn, spawnSync } = await import('node:child_process');
    if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status !== 0) {
        t.skip('Anvil is not installed; deterministic signing/recovery tests still run.');
        return;
    }
    const { createServer } = await import('node:net');
    const allocation = createServer();
    await new Promise(resolve => allocation.listen(0, '127.0.0.1', resolve));
    const port = allocation.address().port;
    await new Promise(resolve => allocation.close(resolve));
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '1', '--silent'], { stdio: 'ignore' });
    t.after(() => child.kill('SIGTERM'));
    const url = `http://127.0.0.1:${port}`;
    let rpcId = 0;
    const rpc = async (method, params = []) => {
        const result = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) }).then(response => response.json());
        if (result.error) throw new Error(`Local Anvil ${method} failed`);
        return result.result;
    };
    let started = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try { await rpc('eth_chainId'); started = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert(started, 'local chain starts');
    // Deliberately minimal fixture: records the second call argument in slot0.
    // This validates EVM execution/signing, not the private-vault proof protocol.
    await rpc('anvil_setCode', [TOKEN, '0x602435600055600160005260206000f3']);
    await rpc('anvil_setBalance', [OWN, '0xde0b6b3a7640000']);
    const broadcastBytes = [];
    let interruptResponse = true;
    const h = harness({ config: { demo_rpc_url: url }, transport: async (target, options) => {
        const request = JSON.parse(options.body);
        assert.equal(options.credentials, 'omit');
        const result = await fetch(target, options);
        if (request.method === 'eth_sendRawTransaction') {
            broadcastBytes.push(request.params[0]);
            if (interruptResponse) { interruptResponse = false; await result.text(); throw new Error('Simulated lost response after node accepted transaction'); }
        }
        return result;
    } });
    await h.ready();
    const hash = await h.send();
    assert.equal(BigInt(await rpc('eth_getStorageAt', [TOKEN, '0x0', 'latest'])), 2000000n);
    const client = new ZkapiClient();
    client.config = { funding: { ...FUNDING, demo_rpc_url: url } };
    client.browserMode = true;
    const oldManifest = runtime.manifest;
    runtime.manifest = { deployment_id: 'fixture' };
    t.after(() => { runtime.manifest = oldManifest; });
    const restored = new AddressFundingProvider({ ...h.init,
        resumeTransaction: record => client.resumeExternalTransaction(record) });
    client.setWalletProvider(restored);
    await restored.init();
    const recovered = await restored.recoverPending();
    assert.equal(recovered.transactionHash, hash);
    assert.equal(recovered.status, 'confirmed');
    assert.equal(restored.pending, null);
    assert.equal(broadcastBytes.length, 2);
    assert.equal(broadcastBytes[0], broadcastBytes[1]);
    const returnHash = await restored.withAuthorizedAction({ kind: 'sweep', asset: 'eth', destination: DESTINATION, amount: 'max' },
        () => restored.transferEth(DESTINATION, 'max'));
    const receipt = await rpc('eth_getTransactionReceipt', [returnHash]);
    assert.equal(receipt.status, '0x1');
    const returnTransaction = Transaction.from(broadcastBytes.at(-1));
    const unusedFeeAllowance = returnTransaction.gasLimit * (returnTransaction.maxFeePerGas - BigInt(receipt.effectiveGasPrice));
    assert.equal(BigInt(await rpc('eth_getBalance', [OWN, 'latest'])), unusedFeeAllowance);
    assert(BigInt(await rpc('eth_getBalance', [DESTINATION, 'latest'])) > 0n);
    await rpc('anvil_mine', ['0x40']);
    assert.equal((await restored.recoverPending()).status, 'confirmed');
    assert.equal(restored.pending, null);

    // A payable EVM fixture records msg.value. It verifies native execution and
    // durable signer restart, while the full vault/proof flow has separate E2E.
    await rpc('anvil_setCode', [VAULT, '0x34600055600160005260206000f3']);
    await rpc('anvil_setBalance', [OWN, '0xde0b6b3a7640000']);
    const native = harness({ config: { ...NATIVE_FUNDING, demo_rpc_url: url }, transport: h.init.transport });
    await native.ready();
    const plan = { commitment: '0x123', zero_path: Array(32).fill('0x0') };
    const amount = 2_000_000n;
    const depositWei = amount * 1_000_000_000n;
    const context = { ...CONTEXT, kind: 'deposit', operationId: 'native-op', submissionId: 'native-sub',
        amount: amount.toString(), commitment: plan.commitment };
    const depositHash = await native.send({ from: OWN, to: VAULT, data: codec.encodeDeposit(plan, amount),
        value: `0x${depositWei.toString(16)}` }, context, { kind: 'deposit', amount: amount.toString() });
    assert.equal((await rpc('eth_getTransactionReceipt', [depositHash])).status, '0x1');
    assert.equal(BigInt(await rpc('eth_getStorageAt', [VAULT, '0x0', 'latest'])), depositWei);
    assert.equal(BigInt(await rpc('eth_getBalance', [VAULT, 'latest'])), depositWei);
    const nativeRestored = new AddressFundingProvider(native.init);
    const count = broadcastBytes.length;
    await nativeRestored.init();
    assert.equal(nativeRestored.pending.hash, depositHash);
    assert.equal(nativeRestored.pending.context.amount, amount.toString());
    assert.equal(broadcastBytes.length, count, 'restoring the payable journal does not resend it');
});

test('actual SDK normalization keeps safe provider fee copy and pre-broadcast classification recoverable', async t => {
    const h = harness();
    await h.ready();
    const oldManifest = runtime.manifest;
    runtime.manifest = { deployment_id: 'fixture' };
    t.after(() => { runtime.manifest = oldManifest; });
    const client = new ZkapiClient();
    client.config = { funding: FUNDING };
    client.browserMode = true;
    client.setWalletProvider(h.provider);
    h.rpc.baseFee = '0x45d964b800';
    await assert.rejects(h.provider.withAuthorizedAction(auth, async () => {
        try { return await client.sendContractTransaction(OWN, TOKEN, approve(2000000).data); }
        catch (error) {
            // sendContractTransaction has run the real SDK normalization and
            // stage tagging. Its later withdrawal handler changes this copy.
            assert.equal(error.transactionStage, 'send');
            assert.equal(error.broadcastPossible, false);
            error.shortMessage = 'The wallet refused the transaction before broadcast.';
            throw error;
        }
    }), error => {
        assert.equal(error.transactionStage, 'send');
        assert.equal(error.broadcastPossible, false);
        assert.equal(error.code, 4100);
        assert.equal(error.addressCode, 'address_fee_limit');
        assert.match(error.shortMessage, /Current Ethereum fees exceed/);
        return true;
    });
    assert.equal(h.sent.length, 0);
    assert.equal(h.provider.pending, null);
});

test('test-token mint is bounded by explicit authorization and unavailable on mainnet', async () => {
    const mint = { from: OWN, to: TOKEN, data: codec.callData(codec.ABI.mint, [codec.addressWord(OWN), codec.abiWord(1000)]) };
    const mainnet = harness();
    await mainnet.ready();
    await assert.rejects(mainnet.send(mint, CONTEXT, { kind: 'token', amount: '1000' }), { code: 4100 });
    const sepolia = harness({ config: { chain_id: 11155111, demo_mint_enabled: true } });
    sepolia.rpc.chain = '0xaa36a7';
    await sepolia.ready();
    const context = { ...CONTEXT, chainId: 11155111 };
    await assert.rejects(sepolia.send(mint, context, { kind: 'token', amount: '999' }), { code: 4100 });
    await sepolia.send(mint, context, { kind: 'token', amount: '1000' });
    assert.equal(Transaction.from(sepolia.sent[0]).chainId, 11155111n);
});

test('sweep overrides cannot turn a deposit action into an arbitrary transfer', async () => {
    const h = harness();
    await h.ready();
    await assert.rejects(h.provider.withAuthorizedAction(auth, () => h.provider.send({ from: OWN, to: DESTINATION, value: '0x1' }, null,
        { kind: 'sweep', asset: 'eth', destination: DESTINATION, amount: '1' })), { code: 4100 });
    assert.equal(h.sent.length, 0);
});

test('SDK-aligned gas ceiling still rejects oversized requests and excessive transaction fees', async () => {
    const h = harness();
    await h.ready();
    h.rpc.gas = `0x${6_897_262n.toString(16)}`;
    const gas = bufferedGasLimit(6_897_262n);
    await assert.rejects(h.send({ ...approve(2000000), gas: `0x${(MAX_TRANSACTION_GAS_LIMIT + 1n).toString(16)}` }), { code: 4100 });
    h.rpc.gas = `0x${(MAX_TRANSACTION_GAS_LIMIT + 1n).toString(16)}`;
    await assert.rejects(h.send({ ...approve(2000000), gas }), { code: 4100 });
    h.rpc.gas = `0x${6_897_262n.toString(16)}`;
    h.rpc.baseFee = `0x${3_000_000_000n.toString(16)}`;
    await assert.rejects(h.send({ ...approve(2000000), gas }), { code: 4100, addressCode: 'address_fee_limit' });
    h.rpc.gas = '0x5208';
    h.rpc.baseFee = `0x${300_000_000_001n.toString(16)}`;
    await assert.rejects(h.send(), { code: 4100 });
    assert.equal(h.sent.length, 0, 'neither ceiling nor fee rejection broadcasts');
    assert.equal(h.provider.pending, null);
    h.rpc.baseFee = '0x1dcd6500';
    await h.send({ ...approve(2000000), gas: `0x${MAX_TRANSACTION_GAS_LIMIT.toString(16)}` });
    assert.equal(Transaction.from(h.sent[0]).gasLimit, 16_777_216n, 'the exact SDK/network ceiling remains allowed within the fee cap');
    await h.provider.reload();
});
