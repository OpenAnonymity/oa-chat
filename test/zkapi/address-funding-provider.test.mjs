import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet, Transaction, parseUnits } from 'ethers';
import { AddressFundingProvider } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import { createAddressFundingStore } from '../../chat/zkapi/services/addressFundingStore.mjs';
import { ZkapiClient } from '@openanonymity/zkapi-browser-sdk/client';
import runtime from '@openanonymity/zkapi-browser-sdk/runtime';
import codec from '@openanonymity/zkapi-browser-sdk/wallet';
import { bufferedGasLimit, MAX_TRANSACTION_GAS_LIMIT } from '@openanonymity/zkapi-browser-sdk/gas';

const UINT256_MAX = (1n << 256n) - 1n;
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
const NATIVE_INTENT = { amount: '2000000', depositWei: '2000000000000000', ethAmount: '0.002' };
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
function sampleFeeHistory(rpc) {
    const count = Number(BigInt(rpc.latest) + 1n < 20n ? BigInt(rpc.latest) + 1n : 20n);
    return { oldestBlock: `0x${(BigInt(rpc.latest) - BigInt(count) + 1n).toString(16)}`,
        baseFeePerGas: Array(count + 1).fill(rpc.baseFee), gasUsedRatio: Array(count).fill(0.5),
        reward: Array.from({ length: count }, () => [rpc.priorityFee]) };
}
function harness(options = {}) {
    const store = options.store || memoryStore();
    const lockManager = options.locks || locks();
    const calls = [];
    const sent = [];
    const resumes = [];
    const rpc = { chain: '0x1', nonce: '0x0', balance: '0xde0b6b3a7640000', gas: '0x186a0',
        gasPrice: '0x3b9aca00', baseFee: '0x1dcd6500', priorityFee: '0x5f5e100', receipt: null, ambiguous: false, simulationFails: false,
        code: '0x', finalized: '0x20', latest: '0x100', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, blockHash: `0x${'77'.repeat(32)}` };
    let generated = 0;
    let provider;
    const config = { ...FUNDING, ...options.config };
    const init = {
        store, locks: lockManager, getConfig: options.getConfig || (() => config), createChannel: () => null,
        createWallet: () => { generated += 1; return new Wallet(KEY); },
        prepareDepositQuote: async (ethAmount, { from }) => {
            const amount = parseUnits(ethAmount, 9);
            const plan = { commitment: '0x123', zero_path: Array(32).fill('0x0') };
            return { operationId: 'deposit-op', commitment: plan.commitment, amount: amount.toString(),
                depositWei: (amount * 1_000_000_000n).toString(), chainId: config.chain_id, contractAddress: config.contract_address,
                transaction: { from, to: config.contract_address, data: codec.encodeDeposit(plan, amount),
                    value: `0x${(amount * 1_000_000_000n).toString(16)}` } };
        },
        resumeTransaction: async record => { resumes.push(record); await provider.acknowledgeTransaction(record.hash); return { status: 'submitted' }; },
        transport: async (url, requestOptions) => {
            const request = JSON.parse(requestOptions.body);
            calls.push({ ...request, url, options: requestOptions });
            let result;
            if (request.method === 'eth_chainId') result = rpc.chain;
            else if (request.method === 'eth_getTransactionCount') result = rpc.nonce;
            else if (request.method === 'eth_getBalance') result = rpc.balance;
            else if (request.method === 'eth_gasPrice') result = rpc.gasPrice;
            else if (request.method === 'eth_maxPriorityFeePerGas') result = rpc.suggestedPriorityFee ?? rpc.priorityFee;
            else if (request.method === 'eth_feeHistory') result = Object.hasOwn(rpc, 'feeHistory') ? rpc.feeHistory : sampleFeeHistory(rpc);
            else if (request.method === 'eth_estimateGas') result = rpc.gas;
            else if (request.method === 'eth_getCode') result = rpc.code;
            else if (request.method === 'eth_call') {
                if (rpc.simulationFails) throw new Error(`revert private details ${KEY}`);
                result = '0x1e8480';
            } else if (request.method === 'eth_getTransactionReceipt') result = rpc.receipt;
            else if (request.method === 'eth_getBlockByNumber') result = { number: request.params[0] === 'finalized' ? rpc.finalized : request.params[0] === 'latest' ? rpc.latest : request.params[0], hash: rpc.blockHash, baseFeePerGas: rpc.baseFee, timestamp: rpc.timestamp };
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
    assert.equal(decoded.maxFeePerGas, (BigInt(h.rpc.baseFee) * 5n + 3n) / 4n + BigInt(h.rpc.priorityFee));
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
    assert.equal(h.calls.filter(call => call.method === 'eth_feeHistory').length, 1, 'recovery never requotes fees');
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
    assert.equal(restored.calls.some(call => ['eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBlockByNumber'].includes(call.method)), false);
});

test('encrypted journals reject unsupported transaction types and unsafe type-2 fee fields', async () => {
    const h = harness();
    await h.ready();
    for (const fees of [
        { type: 1, gasPrice: 1000000000n, accessList: [] },
        { type: 2, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 0n },
        { type: 2, maxFeePerGas: UINT256_MAX, maxPriorityFeePerGas: 1000000n },
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

test('low pricing uses median tenth-percentile rewards from anchored recent blocks, ignoring expensive RPC suggestions', async () => {
    const h = harness({ config: NATIVE_FUNDING });
    await h.ready();
    h.rpc.suggestedPriorityFee = '0x174876e800'; // 100 gwei would overpay on this quiet chain.
    const history = sampleFeeHistory(h.rpc);
    history.reward = Array.from({ length: 20 }, () => ['0x0']);
    history.gasUsedRatio = Array(20).fill(0);
    for (const [index, reward] of [2_000_000n, 4_000_000n, 6_000_000n, 300_000_000_000n].entries()) {
        history.reward[index] = [`0x${reward.toString(16)}`];
        history.gasUsedRatio[index] = 0.5;
    }
    h.rpc.feeHistory = history;
    const quote = await h.provider.getDepositFeeQuote(NATIVE_INTENT);
    assert.equal(quote.feePolicy, 'low');
    assert.equal(quote.maxPriorityFeePerGas, '5000000');
    assert.equal(quote.maxFeePerGas, '630000000');
    assert.equal(quote.expectedFeeWei, (BigInt(h.rpc.gas) * 505_000_000n).toString());
    assert.equal(BigInt(quote.feeReserveWei), BigInt(quote.gasLimit) * 630_000_000n);
    assert(BigInt(quote.feeReserveWei) < BigInt(quote.gasLimit) * (2n * BigInt(h.rpc.baseFee) + BigInt(h.rpc.suggestedPriorityFee)));
    assert.deepEqual(h.calls.find(call => call.method === 'eth_feeHistory').params, ['0x14', '0x100', [10]]);
    assert.equal(h.calls.some(call => ['eth_gasPrice', 'eth_maxPriorityFeePerGas'].includes(call.method)), false);
    const prepared = await h.provider.prepareDepositQuote(NATIVE_INTENT.ethAmount, { from: OWN });
    await h.send({ ...prepared.transaction, gas: `0x${BigInt(quote.gasLimit).toString(16)}` },
        { ...CONTEXT, kind: 'deposit', operationId: prepared.operationId, submissionId: 'low-fee-sub',
            amount: prepared.amount, commitment: prepared.commitment },
        { kind: 'deposit', amount: prepared.amount, preparedOperationId: quote.operationId,
            depositCommitment: quote.depositCommitment, feeLimitWei: quote.feeReserveWei, feeQuoteExpiresAt: quote.expiresAt });
    const signed = Transaction.from(h.sent[0]);
    assert.equal(signed.maxPriorityFeePerGas, 5_000_000n);
    assert.equal(signed.maxFeePerGas, 630_000_000n);
    assert.equal(signed.gasLimit, BigInt(quote.gasLimit), 'low pricing never reduces execution gas');
});

test('empty blocks retain the minimum tip and short histories are allowed only near genesis', async () => {
    const h = harness();
    h.rpc.latest = '0x3';
    h.rpc.feeHistory = sampleFeeHistory(h.rpc);
    h.rpc.feeHistory.reward = Array.from({ length: 4 }, () => ['0x0']);
    h.rpc.feeHistory.gasUsedRatio = Array(4).fill(0);
    const quote = await h.provider.transactionFees(await h.provider.context(), 21_000n);
    assert.equal(quote.maxPriorityFeePerGas, 1_000_000n);
    assert.equal(quote.maxFeePerGas, 626_000_000n);
    assert.deepEqual(h.calls.find(call => call.method === 'eth_feeHistory').params, ['0x14', '0x3', [10]]);
    h.rpc.latest = '0x100';
    h.rpc.feeHistory.oldestBlock = '0xfd';
    await assert.rejects(h.provider.transactionFees(await h.provider.context(), 21_000n), { code: 'address_fee_data' });
});

test('malformed, stale and unanchored fee histories cannot authorize a signature or invoke an expensive fallback', async () => {
    const mutations = [
        rpc => { rpc.feeHistory = undefined; },
        rpc => { rpc.feeHistory = null; },
        rpc => { rpc.feeHistory.oldestBlock = '0xec'; },
        rpc => { rpc.feeHistory.oldestBlock = '0xee'; },
        rpc => { rpc.feeHistory.reward.pop(); },
        rpc => { rpc.feeHistory.reward.push(['0x1']); },
        rpc => { rpc.feeHistory.reward[0] = []; },
        rpc => { rpc.feeHistory.reward[0] = ['0x1', '0x2']; },
        rpc => { rpc.feeHistory.reward[0] = [1]; },
        rpc => { rpc.feeHistory.reward[0] = [`0x1${'0'.repeat(64)}`]; },
        rpc => { rpc.feeHistory.baseFeePerGas.pop(); },
        rpc => { rpc.feeHistory.baseFeePerGas[19] = '0x1'; },
        rpc => { rpc.feeHistory.baseFeePerGas[20] = null; },
        rpc => { rpc.feeHistory.gasUsedRatio.pop(); },
        rpc => { rpc.feeHistory.gasUsedRatio[0] = -0.1; },
        rpc => { rpc.feeHistory.gasUsedRatio[0] = 1.1; },
        rpc => { rpc.feeHistory.gasUsedRatio[0] = NaN; },
        rpc => { rpc.feeHistory.gasUsedRatio[0] = '0.5'; },
        rpc => { rpc.feeHistory.gasUsedRatio[0] = 0; }, // Empty blocks cannot have a reward.
        rpc => { rpc.latest = 'latest'; },
        rpc => { rpc.timestamp = undefined; },
        rpc => { rpc.timestamp = `0x${(Math.floor(Date.now() / 1000) - 121).toString(16)}`; },
        rpc => { rpc.timestamp = `0x${(Math.floor(Date.now() / 1000) + 60).toString(16)}`; }
    ];
    for (const mutate of mutations) {
        const h = harness();
        await h.ready();
        h.rpc.feeHistory = sampleFeeHistory(h.rpc);
        mutate(h.rpc);
        await assert.rejects(h.send(), { code: 4100, addressCode: 'address_fee_data' });
        assert.equal(h.sent.length, 0);
        assert.equal(h.provider.pending, null);
        assert.equal(h.calls.some(call => ['eth_gasPrice', 'eth_maxPriorityFeePerGas'].includes(call.method)), false);
        assert.equal((await h.provider.read(await h.provider.context(), true)).transactions.length, 0);
    }
});

test('unsupported fee history fails with fixed public copy and no RPC suggestion fallback', async () => {
    const h = harness();
    await h.ready();
    h.provider.transport = async (url, options) => {
        if (JSON.parse(options.body).method === 'eth_feeHistory') throw new Error(`Unsupported private details ${KEY}`);
        return h.init.transport(url, options);
    };
    await assert.rejects(h.send(), error => {
        assert.equal(error.addressCode, 'address_fee_data');
        assert.match(error.message, /could not be read reliably/);
        assert(!error.message.includes(KEY));
        return true;
    });
    assert.equal(h.sent.length, 0);
    assert.equal(h.calls.some(call => ['eth_gasPrice', 'eth_maxPriorityFeePerGas'].includes(call.method)), false);
});

test('a preexisting conservative type-2 journal replays identical bytes without applying low pricing', async () => {
    const h = harness();
    await h.ready();
    const original = await saveSignedFixture(h, { type: 2, maxFeePerGas: 1_100_000_000n, maxPriorityFeePerGas: 100_000_000n });
    h.rpc.baseFee = undefined;
    h.rpc.feeHistory = null;
    const restored = new AddressFundingProvider(h.init);
    await restored.init();
    await restored.recoverPending();
    assert.deepEqual(h.sent, [original.raw]);
    assert.equal(Transaction.from(h.sent[0]).maxFeePerGas, 1_100_000_000n);
    assert.equal(h.calls.some(call => ['eth_feeHistory', 'eth_maxPriorityFeePerGas', 'eth_getBlockByNumber'].includes(call.method)), false);
});

test('zero historical rewards retain a small tip and enough room for the next block', async () => {
    const h = harness();
    await h.ready();
    h.rpc.baseFee = '0x0';
    h.rpc.priorityFee = '0x0';
    await h.send();
    const transaction = Transaction.from(h.sent[0]);
    assert.equal(transaction.maxPriorityFeePerGas, 1000000n);
    assert.equal(transaction.maxFeePerGas, 1000001n);
});

test('low base-fee headroom rounds up to whole wei without lowering the next-block minimum', async () => {
    const h = harness();
    const ctx = await h.provider.context();
    h.rpc.priorityFee = '0x0';
    for (const [base, maximum] of [[0n, 1n], [1n, 2n], [5n, 7n], [8n, 10n]]) {
        h.rpc.baseFee = `0x${base.toString(16)}`;
        const fees = await h.provider.transactionFees(ctx, 21_000n);
        assert.equal(fees.maxFeePerGas, maximum + 1_000_000n);
        assert(fees.maxFeePerGas >= base + (base / 8n || 1n) + fees.maxPriorityFeePerGas);
    }
});

test('explicitly authorized transactions can exceed the former total fee and per-gas ceilings', async () => {
    const h = harness();
    await h.ready();
    h.rpc.baseFee = `0x${400_000_000_000n.toString(16)}`;
    h.rpc.priorityFee = `0x${10_000_000_000n.toString(16)}`;
    await h.send();
    const transaction = Transaction.from(h.sent[0]);
    assert.equal(transaction.maxFeePerGas, 510_000_000_000n);
    assert.equal(transaction.maxPriorityFeePerGas, 10_000_000_000n);
    assert(transaction.maxFeePerGas * transaction.gasLimit > 20_000_000_000_000_000n);
    await h.provider.reload();
    assert.equal(h.provider.pending.hash, transaction.hash);
});

test('fee data whose transaction liability exceeds uint256 never signs', async () => {
    const h = harness();
    await h.ready();
    for (const baseFee of [UINT256_MAX, UINT256_MAX / 120_000n]) {
        h.rpc.baseFee = `0x${baseFee.toString(16)}`;
        await assert.rejects(h.send(), { code: 4100, addressCode: 'address_fee_data' });
    }
    assert.equal(h.sent.length, 0);
    assert.equal(h.provider.pending, null);
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

test('wrong chain, failed simulation and signed nonce rollback cannot send', async () => {
    const h = harness();
    await h.ready();
    h.rpc.chain = '0x2';
    await assert.rejects(h.send(), { code: 4100, addressCode: 'wrong_network' });
    h.rpc.chain = '0x1';
    h.rpc.simulationFails = true;
    await assert.rejects(h.send(), error => error.code === 4100 && error.addressCode === 'address_rpc_error' && !error.message.includes(KEY));
    h.rpc.simulationFails = false;
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
    assert.equal(h.calls.filter(call => call.method === 'eth_feeHistory').length, 1);
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
    h.rpc.balance = `0x${(21000n * ((BigInt(h.rpc.baseFee) * 5n + 3n) / 4n + BigInt(h.rpc.priorityFee))).toString(16)}`;
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

test('unfunded deposit quotes simulate the exact prepared call with only its sender balance overridden', async () => {
    const h = harness({ config: NATIVE_FUNDING });
    await h.ready();
    const beforeRecord = structuredClone([...h.store.data]);
    h.rpc.balance = '0x0';
    const before = Date.now();
    const quote = await h.provider.getDepositFeeQuote(NATIVE_INTENT);
    const estimate = BigInt(h.rpc.gas);
    const gasLimit = BigInt(bufferedGasLimit(estimate));
    assert.equal(quote.expectedFeeWei, (estimate * (BigInt(h.rpc.baseFee) + BigInt(h.rpc.priorityFee))).toString());
    assert.equal(quote.feeReserveWei, (gasLimit * ((BigInt(h.rpc.baseFee) * 5n + 3n) / 4n + BigInt(h.rpc.priorityFee))).toString());
    assert.equal(BigInt(quote.expectedFeeWei) + BigInt(quote.feeBufferWei), BigInt(quote.feeReserveWei));
    assert.equal(quote.gasLimit, gasLimit.toString());
    assert.equal(quote.estimatedGas, estimate.toString());
    assert.equal(quote.reserveKind, 'estimated_transaction');
    assert.equal(quote.chainId, 1);
    assert.equal(quote.operationId, 'deposit-op');
    assert.equal(quote.depositCommitment, '0x123');
    assert.equal(quote.address, OWN);
    assert.equal(quote.amount, NATIVE_INTENT.amount);
    assert.equal(quote.depositWei, NATIVE_INTENT.depositWei);
    assert(quote.quotedAt >= before && quote.quotedAt <= Date.now());
    assert.equal(quote.expiresAt - quote.quotedAt, 30_000);
    for (const method of ['eth_call', 'eth_estimateGas']) {
        const call = h.calls.find(call => call.method === method);
        assert.deepEqual(Object.keys(call.params[0]), ['from', 'to', 'data', 'value']);
        assert.equal(call.params[0].from, OWN);
        assert.equal(call.params[0].to, VAULT);
        assert.equal(BigInt(call.params[0].value), BigInt(NATIVE_INTENT.depositWei));
        assert.equal(call.params[1], 'pending');
        assert.deepEqual(call.params[2], { [OWN]: { balance: `0x${UINT256_MAX.toString(16)}` } });
        assert.equal(call.options.credentials, 'omit');
    }
    assert.deepEqual([...h.store.data], beforeRecord, 'quote does not change funding custody or create a transaction journal');
    assert.equal(h.sent.length, 0);
    assert.equal(h.provider.action, null);
    h.rpc.chain = '0x2';
    await assert.rejects(h.provider.getDepositFeeQuote(NATIVE_INTENT), { code: 'wrong_network' });
});

test('deposit quotes require existing custody and matching exact prepared principal, account, chain and vault', async () => {
    const empty = harness({ config: NATIVE_FUNDING });
    await assert.rejects(empty.provider.getDepositFeeQuote(NATIVE_INTENT), { code: 'address_missing' });
    assert.equal(empty.generated, 0);
    assert.equal(empty.calls.length, 0);
    for (const change of [
        quote => { quote.amount = '1'; },
        quote => { quote.depositWei = '1'; },
        quote => { quote.chainId = 11155111; },
        quote => { quote.contractAddress = DESTINATION; },
        quote => { quote.commitment = '0x999'; },
        quote => { quote.operationId = ''; },
        quote => { quote.transaction.value = '0x1'; },
        quote => { quote.transaction.from = DESTINATION; },
        quote => { quote.transaction.to = DESTINATION; },
        quote => { quote.transaction.gasPrice = '0x1'; }
    ]) {
        const h = harness({ config: NATIVE_FUNDING });
        await h.ready();
        const prepare = h.provider.prepareDepositQuote;
        h.provider.prepareDepositQuote = async (...args) => { const quote = await prepare(...args); change(quote); return quote; };
        await assert.rejects(h.provider.getDepositFeeQuote(NATIVE_INTENT));
        assert.equal(h.calls.some(call => ['eth_call', 'eth_estimateGas'].includes(call.method)), false);
        assert.equal(h.sent.length, 0);
    }
});

test('unfunded simulation failures expose no RPC details and never fall back to a guessed fee', async () => {
    for (const failedMethod of ['eth_call', 'eth_estimateGas']) {
        const h = harness({ config: NATIVE_FUNDING });
        await h.ready();
        const transport = h.provider.transport;
        h.provider.transport = async (url, options) => {
            const request = JSON.parse(options.body);
            if (request.method === failedMethod) {
                assert.equal(request.params.length, 3, 'simulation keeps the required balance override');
                throw new Error(`unsupported override with sensitive calldata ${KEY}`);
            }
            return transport(url, options);
        };
        await assert.rejects(h.provider.getDepositFeeQuote(NATIVE_INTENT), error => {
            assert.equal(error.code, 'address_rpc_error');
            assert(!error.message.includes(KEY));
            return true;
        });
        assert.equal(h.sent.length, 0);
        assert.equal(h.calls.some(call => call.method === 'eth_maxPriorityFeePerGas'), false);
    }
});

test('deposit quotes enforce buffered gas and valid bounded fee data', async () => {
    for (const failure of ['gas', 'overflow', 'malformed']) {
        const h = harness({ config: NATIVE_FUNDING });
        await h.ready();
        if (failure === 'gas') h.rpc.gas = `0x${MAX_TRANSACTION_GAS_LIMIT.toString(16)}`;
        if (failure === 'overflow') h.rpc.baseFee = `0x${UINT256_MAX.toString(16)}`;
        if (failure === 'malformed') h.rpc.baseFee = undefined;
        await assert.rejects(h.provider.getDepositFeeQuote(NATIVE_INTENT), {
            code: failure === 'gas' ? 'transaction_gas_limit_exceeded' : 'address_fee_data'
        });
        assert.equal(h.sent.length, 0);
    }
});

test('native deposit cannot exceed the displayed fee cap or substitute a prepared note before signing', async () => {
    for (const changed of ['fee', 'gas', 'expired', 'operation', 'commitment', 'missing-cap']) {
        const h = harness({ config: NATIVE_FUNDING });
        await h.ready();
        const quote = await h.provider.getDepositFeeQuote(NATIVE_INTENT);
        const prepared = await h.provider.prepareDepositQuote(NATIVE_INTENT.ethAmount, { from: OWN });
        const context = { ...CONTEXT, kind: 'deposit', operationId: prepared.operationId, submissionId: 'deposit-sub',
            amount: prepared.amount, commitment: prepared.commitment };
        const authorization = { kind: 'deposit', amount: prepared.amount, feeLimitWei: quote.feeReserveWei,
            preparedOperationId: quote.operationId, depositCommitment: quote.depositCommitment, feeQuoteExpiresAt: quote.expiresAt };
        if (changed === 'fee') h.rpc.baseFee = `0x${(BigInt(h.rpc.baseFee) * 2n).toString(16)}`;
        if (changed === 'gas') h.rpc.gas = '0x30d40';
        if (changed === 'expired') authorization.feeQuoteExpiresAt = Date.now() - 1;
        if (changed === 'operation') authorization.preparedOperationId = 'other-operation';
        if (changed === 'commitment') authorization.depositCommitment = '0x456';
        if (changed === 'missing-cap') delete authorization.feeLimitWei;
        const input = { ...prepared.transaction, gas: bufferedGasLimit(BigInt(h.rpc.gas)) };
        await assert.rejects(h.send(input, context, authorization), error => {
            assert.equal(error.code, 4100);
            if (['fee', 'gas', 'expired'].includes(changed)) {
                assert.equal(error.addressCode, 'address_fee_quote_changed');
                assert.match(error.message, /Review the updated deposit quote/);
            }
            return true;
        });
        assert.equal(h.sent.length, 0);
        assert.equal(h.provider.pending, null);
        const record = await h.provider.read(await h.provider.context(), true);
        assert.equal(record.transactions.length, 0);
    }
});

test('approved deposit fee buffer covers modest fee or gas changes without increasing the authorized total', async () => {
    for (const changed of ['fee', 'gas', 'both']) {
        const h = harness({ config: NATIVE_FUNDING });
        await h.ready();
        const quote = await h.provider.getDepositFeeQuote(NATIVE_INTENT);
        const prepared = await h.provider.prepareDepositQuote(NATIVE_INTENT.ethAmount, { from: OWN });
        const context = { ...CONTEXT, kind: 'deposit', operationId: prepared.operationId, submissionId: 'deposit-sub',
            amount: prepared.amount, commitment: prepared.commitment };
        const authorization = { kind: 'deposit', amount: prepared.amount, feeLimitWei: quote.feeReserveWei,
            preparedOperationId: quote.operationId, depositCommitment: quote.depositCommitment, feeQuoteExpiresAt: quote.expiresAt };
        if (changed !== 'gas') h.rpc.baseFee = `0x${(BigInt(h.rpc.baseFee) * 105n / 100n).toString(16)}`;
        if (changed !== 'fee') h.rpc.gas = `0x${(BigInt(h.rpc.gas) * 105n / 100n).toString(16)}`;
        h.rpc.balance = `0x${(BigInt(NATIVE_INTENT.depositWei) + BigInt(quote.feeReserveWei)).toString(16)}`;
        const gasLimit = BigInt(bufferedGasLimit(BigInt(h.rpc.gas)));
        await h.send({ ...prepared.transaction, gas: `0x${gasLimit.toString(16)}` }, context, authorization);
        const signed = Transaction.from(h.sent[0]);
        const approvedPerGas = BigInt(quote.feeReserveWei) / gasLimit;
        const minimumFee = BigInt(h.rpc.baseFee) + (BigInt(h.rpc.baseFee) / 8n || 1n) + BigInt(h.rpc.priorityFee);
        assert.equal(signed.maxFeePerGas, approvedPerGas);
        assert(signed.maxFeePerGas >= minimumFee);
        assert(signed.gasLimit * signed.maxFeePerGas <= BigInt(quote.feeReserveWei));
        if (changed !== 'fee') {
            assert(BigInt(quote.feeReserveWei) % gasLimit > 0n, 'non-divisible total fee rounds down safely');
        }
        await h.provider.reload();
        assert.equal(h.provider.pending.hash, signed.hash);
    }
});

test('approved deposit pricing rejects an exhausted quote buffer at any market price', async () => {
    const h = harness({ config: NATIVE_FUNDING });
    const ctx = await h.provider.context();
    const gasLimit = 170_000n;
    const minimumFee = BigInt(h.rpc.baseFee) + BigInt(h.rpc.baseFee) / 8n + BigInt(h.rpc.priorityFee);
    const exactMinimum = minimumFee * gasLimit;
    const exact = await h.provider.transactionFees(ctx, gasLimit, exactMinimum);
    assert.equal(exact.maxFeePerGas, minimumFee);
    await assert.rejects(h.provider.transactionFees(ctx, gasLimit, exactMinimum - 1n), { code: 'address_fee_quote_changed' });
    h.rpc.baseFee = `0x${300_000_000_001n.toString(16)}`;
    await assert.rejects(h.provider.transactionFees(ctx, gasLimit, '1'), { code: 'address_fee_quote_changed' });
    assert.equal(h.sent.length, 0);
});

test('funded native deposit uses its actual gas at reproduced Sepolia fees and retains the approved quote allowance', async () => {
    const h = harness({ config: NATIVE_FUNDING });
    await h.ready();
    h.rpc.baseFee = `0x${1_112_000_000n.toString(16)}`;
    h.rpc.gas = `0x${6_897_262n.toString(16)}`;
    const gas = bufferedGasLimit(BigInt(h.rpc.gas));
    const amount = 2_000_000n;
    const principal = amount * 1_000_000_000n;
    const quote = await h.provider.getDepositFeeQuote(NATIVE_INTENT);
    h.rpc.balance = `0x${(principal + BigInt(quote.feeReserveWei)).toString(16)}`;
    const plan = { commitment: '0x123', zero_path: Array(32).fill('0x0') };
    const context = { ...CONTEXT, kind: 'deposit', operationId: 'deposit-op', submissionId: 'deposit-sub',
        amount: amount.toString(), commitment: plan.commitment };
    const input = { from: OWN, to: VAULT, data: codec.encodeDeposit(plan, amount), gas, value: `0x${principal.toString(16)}` };
    await assert.rejects(h.provider.request({ method: 'eth_sendTransaction', params: [input], zkapiRecovery: context }),
        { code: 4100 }, 'getting a reserve never authorizes signing');
    await h.send(input, context, { kind: 'deposit', amount: amount.toString(), preparedOperationId: quote.operationId,
        depositCommitment: quote.depositCommitment, feeLimitWei: quote.feeReserveWei, feeQuoteExpiresAt: quote.expiresAt });
    const signed = Transaction.from(h.sent[0]);
    assert.equal(signed.value, principal);
    assert.equal(signed.gasLimit, BigInt(gas));
    assert.equal(signed.maxFeePerGas, (BigInt(h.rpc.baseFee) * 5n + 3n) / 4n + BigInt(h.rpc.priorityFee));
    assert(signed.gasLimit * signed.maxFeePerGas <= BigInt(quote.feeReserveWei));
    assert(h.calls.some(call => call.method === 'eth_estimateGas'));
    assert(h.calls.some(call => call.method === 'eth_getBlockByNumber' && call.params[0] === 'latest'));
    await h.provider.reload();
    assert.equal(h.provider.pending.hash, signed.hash, 'persisted quote bindings survive journal validation');
});

test('both networks quote, explicitly authorize and recover deposits above both former fee ceilings', async () => {
    for (const chainId of [1, 11155111]) {
        const h = harness({ config: { ...NATIVE_FUNDING, chain_id: chainId } });
        h.rpc.chain = `0x${chainId.toString(16)}`;
        h.rpc.gas = `0x${6_897_262n.toString(16)}`;
        const baseFee = 400_000_000_000n;
        h.rpc.baseFee = `0x${baseFee.toString(16)}`;
        await h.ready();
        const quote = await h.provider.getDepositFeeQuote(NATIVE_INTENT);
        const reserve = BigInt(quote.feeReserveWei);
        assert(reserve > 20_000_000_000_000_000n);
        assert(BigInt(quote.maxFeePerGas) > 300_000_000_000n);
        assert.equal(BigInt(quote.maxFeePerGas), baseFee * 5n / 4n + BigInt(h.rpc.priorityFee));
        assert.equal(h.sent.length, 0, 'a high quote grants no signing permission');
        const prepared = await h.provider.prepareDepositQuote(NATIVE_INTENT.ethAmount, { from: OWN });
        const context = { ...CONTEXT, chainId, kind: 'deposit', operationId: prepared.operationId,
            submissionId: 'high-fee-sub', amount: prepared.amount, commitment: prepared.commitment };
        const input = { ...prepared.transaction, gas: `0x${BigInt(quote.gasLimit).toString(16)}` };
        const authorization = { kind: 'deposit', amount: prepared.amount, preparedOperationId: quote.operationId,
            depositCommitment: quote.depositCommitment, feeLimitWei: quote.feeReserveWei, feeQuoteExpiresAt: quote.expiresAt };
        await assert.rejects(h.provider.request({ method: 'eth_sendTransaction', params: [input], zkapiRecovery: context }), { code: 4100 });
        h.rpc.balance = `0x${(BigInt(NATIVE_INTENT.depositWei) + reserve).toString(16)}`;
        h.rpc.baseFee = `0x${(baseFee * 2n).toString(16)}`;
        await assert.rejects(h.send(input, context, authorization), { code: 4100, addressCode: 'address_fee_quote_changed' });
        h.rpc.baseFee = `0x${baseFee.toString(16)}`;
        h.rpc.balance = `0x${(BigInt(NATIVE_INTENT.depositWei) + reserve - 1n).toString(16)}`;
        await assert.rejects(h.send(input, context, authorization), { code: 4100, addressCode: 'address_insufficient_eth' });
        assert.equal(h.sent.length, 0, 'higher market prices never bypass approval or affordability');
        h.rpc.balance = `0x${(BigInt(NATIVE_INTENT.depositWei) + reserve).toString(16)}`;
        await h.send(input, context, authorization);
        const signed = Transaction.from(h.sent[0]);
        assert.equal(signed.chainId, BigInt(chainId));
        assert.equal(signed.value, BigInt(NATIVE_INTENT.depositWei));
        assert.equal(signed.gasLimit * signed.maxFeePerGas, reserve);
        const restored = new AddressFundingProvider(h.init);
        await restored.init();
        assert.equal(restored.pending.hash, signed.hash);
        assert.equal(h.sent.length, 1, 'restoration cannot sign or rebroadcast');
        const feeReadCount = h.calls.filter(call => call.method === 'eth_feeHistory').length;
        h.rpc.baseFee = undefined;
        h.rpc.feeHistory = null;
        await restored.recoverPending();
        assert.deepEqual(h.sent, [signed.serialized, signed.serialized]);
        assert.equal(h.calls.filter(call => call.method === 'eth_feeHistory').length, feeReadCount,
            'recovery replays the exact approved bytes without repricing');

        const ctx = await h.provider.context();
        const record = await h.provider.read(ctx, true);
        record.transactions[0].authorization.feeLimitWei = (reserve - 1n).toString();
        await h.provider.save(ctx, record);
        await assert.rejects(new AddressFundingProvider(h.init).init(), { code: 'address_storage_invalid' },
            'a saved signature cannot exceed its recorded user-approved allowance');
    }
});

test('transaction value plus network fee must fit uint256 before signing', async () => {
    const h = harness();
    await h.ready();
    h.rpc.balance = `0x${UINT256_MAX.toString(16)}`;
    await assert.rejects(h.send({ from: OWN, to: DESTINATION, value: `0x${UINT256_MAX.toString(16)}` }, null,
        { kind: 'sweep', asset: 'eth', amount: UINT256_MAX.toString(), destination: DESTINATION }), { code: 4100 });
    assert.equal(h.sent.length, 0);
    assert.equal(h.provider.pending, null);
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
        const quote = await h.provider.getDepositFeeQuote(NATIVE_INTENT);
        h.rpc.balance = `0x${(principal + BigInt(quote.feeReserveWei)).toString(16)}`;
        const plan = { commitment: '0x123', zero_path: Array(32).fill('0x0') };
        const context = { ...CONTEXT, kind: 'deposit', operationId: 'deposit-op', submissionId: 'deposit-sub',
            amount: amount.toString(), commitment: plan.commitment };
        const input = { from: OWN, to: VAULT, data: codec.encodeDeposit(plan, amount), gas, value: `0x${principal.toString(16)}` };
        let addressCode;
        if (failure === 'expensive') {
            h.rpc.baseFee = `0x${10_000_000_000n.toString(16)}`;
            addressCode = 'address_insufficient_eth';
        } else if (failure === 'malformed') {
            h.rpc.baseFee = undefined;
            addressCode = 'address_fee_data';
        } else {
            const exactLiability = BigInt(gas) * ((BigInt(h.rpc.baseFee) * 5n + 3n) / 4n + BigInt(h.rpc.priorityFee));
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
        assert.match(error.shortMessage, /0\.000077 ETH more/);
        assert.match(error.shortMessage, new RegExp(OWN));
        assert.match(error.shortMessage, /Ethereum Mainnet, then retry the action/);
        assert.equal(error.message, error.shortMessage);
        assert.deepEqual(error.fundingRequirement, { address: OWN, chainId: 1, balanceWei: '10000000000000',
            feeReserveWei: '87000000000000', requiredWei: '87000000000000', shortfallWei: '77000000000000' });
        assert(!error.shortMessage.includes(input.data));
        assert(!JSON.stringify(error.fundingRequirement).includes(KEY));
        return true;
    });
    assert.deepEqual({ plan, context }, unchanged);
    assert.equal(h.provider.action, null, 'the explanation is not retained between actions');
    assert.equal(h.provider.pending, null);
    assert.equal(h.sent.length, 0);
    h.rpc.balance = `0x${87_000_000_000_000n.toString(16)}`; // The exact 0.000087 ETH quoted liability.
    await h.provider.getStatus();
    assert.equal(h.sent.length, 0, 'a top-up and status check never resubmit');
    await h.send(input, context, authorization);
    assert.equal(h.sent.length, 1);
    assert.equal(h.provider.pending.context.destination, DESTINATION);
});

test('safe malformed-fee explanations survive generic SDK copy without RPC details', async () => {
    for (const scenario of [
        { baseFee: `0x${UINT256_MAX.toString(16)}`, code: 'address_fee_data', text: /fees could not be read reliably/ },
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
    await rpc('anvil_setBalance', [OWN, '0x0']);
    const native = harness({ config: { ...NATIVE_FUNDING, demo_rpc_url: url }, transport: h.init.transport });
    await native.ready();
    const plan = { commitment: '0x123', zero_path: Array(32).fill('0x0') };
    const amount = 2_000_000n;
    const depositWei = amount * 1_000_000_000n;
    const nativeBaseFee = BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).baseFeePerGas);
    const nativeQuote = await native.provider.getDepositFeeQuote(NATIVE_INTENT);
    assert.equal(nativeQuote.feePolicy, 'low');
    assert.equal(BigInt(await rpc('eth_getBalance', [OWN, 'latest'])), 0n, 'quoting never funds or signs');
    assert(BigInt(nativeQuote.maxFeePerGas) < 2n * nativeBaseFee + BigInt(nativeQuote.maxPriorityFeePerGas),
        'the real EVM quote uses less fee headroom than the old conservative policy');
    await rpc('anvil_setBalance', [OWN, `0x${(depositWei + BigInt(nativeQuote.feeReserveWei)).toString(16)}`]);
    const context = { ...CONTEXT, kind: 'deposit', operationId: nativeQuote.operationId, submissionId: 'native-sub',
        amount: amount.toString(), commitment: plan.commitment };
    const depositHash = await native.send({ from: OWN, to: VAULT, data: codec.encodeDeposit(plan, amount),
        gas: `0x${BigInt(nativeQuote.gasLimit).toString(16)}`, value: `0x${depositWei.toString(16)}` }, context,
        { kind: 'deposit', amount: amount.toString(), preparedOperationId: nativeQuote.operationId,
            depositCommitment: nativeQuote.depositCommitment, feeLimitWei: nativeQuote.feeReserveWei,
            feeQuoteExpiresAt: nativeQuote.expiresAt });
    const nativeReceipt = await rpc('eth_getTransactionReceipt', [depositHash]);
    assert.equal(nativeReceipt.status, '0x1');
    const nativeActualFee = BigInt(nativeReceipt.gasUsed) * BigInt(nativeReceipt.effectiveGasPrice);
    assert(nativeActualFee <= BigInt(nativeQuote.feeReserveWei));
    assert.equal(BigInt(await rpc('eth_getBalance', [OWN, 'latest'])), BigInt(nativeQuote.feeReserveWei) - nativeActualFee);
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
    h.rpc.baseFee = undefined;
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
        assert.equal(error.addressCode, 'address_fee_data');
        assert.match(error.shortMessage, /Current Ethereum fees could not be read reliably/);
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

test('SDK-aligned gas ceiling still rejects oversized requests', async () => {
    const h = harness();
    await h.ready();
    h.rpc.gas = `0x${6_897_262n.toString(16)}`;
    const gas = bufferedGasLimit(6_897_262n);
    await assert.rejects(h.send({ ...approve(2000000), gas: `0x${(MAX_TRANSACTION_GAS_LIMIT + 1n).toString(16)}` }), { code: 4100 });
    h.rpc.gas = `0x${(MAX_TRANSACTION_GAS_LIMIT + 1n).toString(16)}`;
    await assert.rejects(h.send({ ...approve(2000000), gas }), { code: 4100 });
    h.rpc.gas = `0x${6_897_262n.toString(16)}`;
    assert.equal(h.sent.length, 0, 'gas-limit rejection never broadcasts');
    assert.equal(h.provider.pending, null);
    h.rpc.baseFee = '0x1dcd6500';
    await h.send({ ...approve(2000000), gas: `0x${MAX_TRANSACTION_GAS_LIMIT.toString(16)}` });
    assert.equal(Transaction.from(h.sent[0]).gasLimit, 16_777_216n, 'the exact SDK/network gas ceiling remains allowed');
    await h.provider.reload();
});
