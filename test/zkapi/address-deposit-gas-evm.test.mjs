import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { Transaction, Wallet } from 'ethers';
import codec from '@openanonymity/zkapi-browser-sdk/wallet';
import { bufferedGasLimit } from '@openanonymity/zkapi-browser-sdk/gas';
import { AddressFundingProvider } from '../../chat/zkapi/services/addressFundingProvider.mjs';

const KEY = `0x${'59'.repeat(32)}`; // Disposable local-chain fixture only.
const OWN = new Wallet(KEY).address.toLowerCase();
const VAULT = `0x${'71'.repeat(20)}`;
const INTENT = { amount: '2000000', ethAmount: '0.002', depositWei: '2000000000000000' };

// Small payable fixture, deliberately separate from private-vault proof tests.
// Require the actual deposit selector, 34 ABI words, and msg.value == amount *
// 1 gwei; store value in slot 0 and commitment in slot 1. This lets a real EVM
// verify that quoting and signing use the same payable calldata and state.
function depositFixtureBytecode() {
    let bytecode = '';
    const labelOffsets = [];
    const requireCondition = condition => {
        bytecode += condition;
        bytecode += '60';
        const patch = bytecode.length;
        bytecode += '005760006000fd';
        labelOffsets.push([patch, bytecode.length / 2]);
        bytecode += '5b';
    };
    requireCondition('3661044414'); // calldatasize == 4 + 34 * 32
    requireCondition('60003560e01c63c588341c14'); // first four bytes == deposit selector
    requireCondition('602435633b9aca00023414'); // amount * 1 gwei == msg.value
    bytecode += '3460005560043560015500';
    for (const [offset, destination] of labelOffsets) {
        bytecode = `${bytecode.slice(0, offset)}${destination.toString(16).padStart(2, '0')}${bytecode.slice(offset + 2)}`;
    }
    return `0x${bytecode}`;
}

function memoryStore() {
    const records = new Map();
    return {
        async load(scope) { return structuredClone(records.get(scope) ?? null); },
        async save(scope, record, { createOnly = false } = {}) {
            if (createOnly && records.has(scope)) throw new Error('Custody already exists');
            records.set(scope, structuredClone(record));
        }
    };
}

test('real EVM quotes an unfunded payable deposit, enforces its cap, and accounts for the actual fee and remainder', { timeout: 30_000 }, async t => {
    if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status !== 0) {
        t.skip('Anvil is not installed; deterministic provider fee tests still run.');
        return;
    }
    const allocation = createServer();
    await new Promise(resolve => allocation.listen(0, '127.0.0.1', resolve));
    const port = allocation.address().port;
    await new Promise(resolve => allocation.close(resolve));
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '1', '--silent'], { stdio: 'ignore' });
    t.after(() => child.kill('SIGTERM'));
    const url = `http://127.0.0.1:${port}`;
    let rpcId = 0;
    const rpc = async (method, params = []) => {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) }).then(result => result.json());
        if (response.error) throw Object.assign(new Error(`Local chain rejected ${method}`), { code: response.error.code });
        return response.result;
    };
    let started = false;
    for (let attempt = 0; attempt < 50; attempt++) {
        try { await rpc('eth_chainId'); started = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert(started, 'local chain starts');
    await rpc('anvil_setCode', [VAULT, depositFixtureBytecode()]);
    assert.equal(await rpc('eth_getBalance', [OWN, 'latest']), '0x0');

    const config = { chain_id: 1, contract_address: VAULT, demo_rpc_url: url,
        billing_asset: 'native_eth', billing_unit: 'gwei', native_asset_wei_per_unit: '1000000000' };
    const plan = { commitment: '0x123', zero_path: Array(32).fill('0x0') };
    const prepared = { operationId: 'evm-prepared-deposit', commitment: plan.commitment,
        amount: INTENT.amount, depositWei: INTENT.depositWei, chainId: 1, contractAddress: VAULT,
        transaction: { from: OWN, to: VAULT, data: codec.encodeDeposit(plan, BigInt(INTENT.amount)),
            value: `0x${BigInt(INTENT.depositWei).toString(16)}` } };
    const calls = [];
    const signedBytes = [];
    let provider;
    const init = { getConfig: () => config, store: memoryStore(), createChannel: () => null,
        locks: { request: (_name, _options, callback) => callback({}) },
        createWallet: () => new Wallet(KEY),
        prepareDepositQuote: async (amount, { from }) => {
            assert.equal(amount, INTENT.ethAmount);
            assert.equal(from, OWN);
            return structuredClone(prepared);
        },
        transport: async (target, options) => {
            assert.equal(target, new URL(url).href);
            assert.equal(options.credentials, 'omit');
            const request = JSON.parse(options.body);
            calls.push(request);
            if (request.method === 'eth_sendRawTransaction') {
                signedBytes.push(request.params[0]);
                assert.equal(provider.pending.hash, Transaction.from(request.params[0]).hash, 'journal saved before broadcast');
            }
            return fetch(target, options);
        }
    };
    provider = new AddressFundingProvider(init);
    await provider.ensureAddress();
    await assert.rejects(rpc('eth_call', [prepared.transaction, 'pending']), 'the native value cannot execute from an unfunded account');

    const quoteBlock = await rpc('eth_getBlockByNumber', ['latest', false]);
    const quote = await provider.getDepositFeeQuote(INTENT);
    assert.equal(signedBytes.length, 0);
    assert.equal(await rpc('eth_getTransactionCount', [OWN, 'pending']), '0x0');
    assert.equal(await rpc('eth_getBalance', [OWN, 'latest']), '0x0', 'state override did not fund the real account');
    assert.equal(BigInt(await rpc('eth_getStorageAt', [VAULT, '0x0', 'latest'])), 0n, 'simulation did not alter contract state');
    assert.equal(quote.gasLimit, BigInt(bufferedGasLimit(quote.estimatedGas)).toString());
    assert.equal(quote.feePolicy, 'low');
    assert.deepEqual(calls.find(call => call.method === 'eth_feeHistory').params, ['0x14', quoteBlock.number, [10]]);
    assert.equal(calls.some(call => call.method === 'eth_maxPriorityFeePerGas'), false);
    assert.equal(BigInt(quote.maxFeePerGas), (BigInt(quoteBlock.baseFeePerGas) * 5n + 3n) / 4n + BigInt(quote.maxPriorityFeePerGas));
    assert(BigInt(quote.feeReserveWei) < BigInt(quote.gasLimit) * (2n * BigInt(quoteBlock.baseFeePerGas) + BigInt(quote.maxPriorityFeePerGas)));
    assert(BigInt(quote.expectedFeeWei) > 0n);
    assert(BigInt(quote.feeBufferWei) > 0n);
    assert.equal(BigInt(quote.expectedFeeWei) + BigInt(quote.feeBufferWei), BigInt(quote.feeReserveWei));
    const estimateCall = calls.find(call => call.method === 'eth_estimateGas');
    assert.deepEqual(Object.keys(estimateCall.params[2]), [OWN]);
    assert.deepEqual(Object.keys(estimateCall.params[2][OWN]), ['balance']);
    assert.deepEqual(estimateCall.params[0], prepared.transaction);

    const totalWei = BigInt(INTENT.depositWei) + BigInt(quote.feeReserveWei);
    await rpc('anvil_setBalance', [OWN, `0x${totalWei.toString(16)}`]);
    const context = { version: 1, kind: 'deposit', deploymentId: 'local-gas-integration', chainId: 1,
        contractAddress: VAULT, operationId: prepared.operationId, submissionId: 'explicit-local-submission',
        amount: prepared.amount, commitment: prepared.commitment };
    const authorization = { kind: 'deposit', amount: INTENT.amount, preparedOperationId: quote.operationId,
        depositCommitment: quote.depositCommitment, feeLimitWei: quote.feeReserveWei, feeQuoteExpiresAt: quote.expiresAt };
    const transaction = { ...prepared.transaction, gas: `0x${BigInt(quote.gasLimit).toString(16)}` };
    const send = auth => provider.withAuthorizedAction(auth, () => provider.request({ method: 'eth_sendTransaction',
        params: [transaction], zkapiRecovery: context }));
    const beforeFeesRise = await rpc('eth_getBlockByNumber', ['latest', false]);
    await rpc('anvil_setNextBlockBaseFeePerGas', [`0x${(BigInt(beforeFeesRise.baseFeePerGas) * 4n).toString(16)}`]);
    await rpc('anvil_mine', ['0x1']);
    await assert.rejects(send(authorization), { code: 4100, addressCode: 'address_fee_quote_changed' });
    assert.equal(signedBytes.length, 0, 'even a funded account cannot spend beyond the confirmed quote');
    assert.equal(await rpc('eth_getTransactionCount', [OWN, 'pending']), '0x0');
    assert.equal(provider.pending, null);

    // Return to a modest 10% increase over the original base fee. The already
    // approved quote has enough headroom; no new quote, top-up or higher fee
    // authorization is needed to spend within its original total allowance.
    await rpc('anvil_setNextBlockBaseFeePerGas', [`0x${(BigInt(beforeFeesRise.baseFeePerGas) * 11n / 10n).toString(16)}`]);
    await rpc('anvil_mine', ['0x1']);
    const hash = await send(authorization);
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    assert.equal(receipt.status, '0x1');
    assert.equal(signedBytes.length, 1);
    const signed = Transaction.from(signedBytes[0]);
    const actualFee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    assert.equal(signed.value, BigInt(INTENT.depositWei));
    assert.equal(signed.data, prepared.transaction.data);
    assert.equal(signed.gasLimit, BigInt(quote.gasLimit));
    assert.equal(signed.maxFeePerGas, BigInt(quote.feeReserveWei) / signed.gasLimit);
    assert(signed.gasLimit * signed.maxFeePerGas <= BigInt(quote.feeReserveWei));
    assert(actualFee <= BigInt(quote.feeReserveWei));
    assert.equal(BigInt(await rpc('eth_getBalance', [VAULT, 'latest'])), BigInt(INTENT.depositWei));
    assert.equal(BigInt(await rpc('eth_getStorageAt', [VAULT, '0x0', 'latest'])), BigInt(INTENT.depositWei));
    assert.equal(BigInt(await rpc('eth_getStorageAt', [VAULT, '0x1', 'latest'])), BigInt(plan.commitment));
    assert.equal(BigInt(await rpc('eth_getBalance', [OWN, 'latest'])), BigInt(quote.feeReserveWei) - actualFee,
        'the remainder is exactly the unused quoted network-fee allowance');

    const restored = new AddressFundingProvider(init);
    await restored.init();
    assert.equal(restored.pending.hash, hash);
    assert.equal(signedBytes.length, 1, 'browser restoration never repeats the deposit');
    assert.equal(await rpc('eth_getTransactionCount', [OWN, 'latest']), '0x1');
});
