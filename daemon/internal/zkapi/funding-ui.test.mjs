import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('./funding.js', import.meta.url), 'utf8');
function fixture({changeChainDuringPath = false, changeChainDuringEstimate, changeAccountDuringEstimate, estimateErrorAt, estimateErrorData, estimateValues = ['0xb4df', '0x6d094d'], allowance = '0x' + '0'.repeat(64), allowanceError = false, changeChainDuringAllowance = false, changeAccountDuringAllowance = false, balance = '0x' + (1000000n).toString(16).padStart(64, '0'), balanceError = false, changeChainDuringBalance = false, changeAccountDuringBalance = false, expireAtPath = false, demoMintEnabled = false, chainID = 11155111, confirmedMintBalances = ['0x' + (100000n).toString(16).padStart(64, '0')], mintReverted = false, mintReorg = false} = {}) {
    const fields = new Map();
    const field = id => {
        if (!fields.has(id)) fields.set(id, {value: id === 'amount' ? '0.10' : '', disabled: false, textContent: '', events: {}, addEventListener(type, callback) { this.events[type] = callback; }});
        return fields.get(id);
    };
    const transactions = [];
    const estimates = [];
    const prompts = [];
    const requests = [];
    const walletCalls = [];
    const events = [];
    const confirmedBalanceReads = [];
    let chain = '0x' + chainID.toString(16);
    let account = '0x3333333333333333333333333333333333333333';
    const context = {
        document: {getElementById: field},
        location: {hash: '#funding-capability'},
        history: {replaceState() {}},
        sessionStorage: {setItem() {}, getItem() { return ''; }},
        setTimeout: callback => setTimeout(callback, 0),
        fetch: async (url, options) => {
            requests.push({url, options});
            const path = url.split('/').pop();
            events.push('api:' + path);
            let result;
            if (path === 'config') result = {chain_id: chainID, demo_mint_enabled: demoMintEnabled, token_address: '0x2222222222222222222222222222222222222222', contract_address: '0x1111111111111111111111111111111111111111'};
            if (path === 'status') result = {has_note: false};
            if (path === 'prepare') result = {amount: 100000, commitment: '0x1234', zero_path: Array(32).fill('0x0')};
            if (path === 'path') {
                if (expireAtPath) return {ok: false, status: 401, text: async () => JSON.stringify({error: 'unauthorized'})};
                if (changeChainDuringPath) chain = '0x1';
                result = {zero_path: Array(32).fill('0xa')};
            }
            if (path === 'confirm') result = {active: true};
            return {ok: true, status: 200, text: async () => JSON.stringify(result)};
        },
        window: {ethereum: {request: async ({method, params}) => {
            walletCalls.push({method, params: JSON.parse(JSON.stringify(params))});
            events.push(method);
            if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
            if (method === 'eth_chainId') return chain;
            if (method === 'eth_call') {
                if (params[0].data === '0x313ce567') return '0x6';
                if (params[0].data.startsWith('0x70a08231')) {
                    if (params[1] !== 'latest') {
                        confirmedBalanceReads.push(params[1]);
                        return confirmedMintBalances[Math.min(confirmedBalanceReads.length - 1, confirmedMintBalances.length - 1)];
                    }
                    if (balanceError) throw new Error('Cannot read token balance.');
                    if (changeChainDuringBalance) chain = '0x1';
                    if (changeAccountDuringBalance) account = '0x4444444444444444444444444444444444444444';
                    return balance;
                }
                assert.ok(params[0].data.startsWith('0xdd62ed3e'), 'only decimals and allowance reads are expected');
                if (changeChainDuringAllowance) chain = '0x1';
                if (changeAccountDuringAllowance) account = '0x4444444444444444444444444444444444444444';
                if (allowanceError) throw new Error('Cannot read token allowance.');
                return allowance;
            }
            if (method === 'eth_getTransactionReceipt') return {status: mintReverted ? '0x0' : '0x1', blockNumber: '0x123', blockHash: '0x' + 'b'.repeat(64)};
            if (method === 'eth_getBlockByNumber') return {hash: '0x' + (mintReorg ? 'c' : 'b').repeat(64)};
            if (method === 'eth_estimateGas') {
                estimates.push(JSON.parse(JSON.stringify(params[0])));
                if (estimates.length === changeChainDuringEstimate) chain = '0x1';
                if (estimates.length === changeAccountDuringEstimate) account = '0x4444444444444444444444444444444444444444';
                if (estimates.length === estimateErrorAt) {
                    const error = new Error('execution reverted: stale witness');
                    error.data = estimateErrorData;
                    throw error;
                }
                return estimateValues[estimates.length - 1];
            }
            if (method === 'eth_sendTransaction') {
                transactions.push(params[0]);
                prompts.push(field('status').textContent);
                return '0x' + String(transactions.length).repeat(64);
            }
            throw new Error('Unexpected wallet method: ' + method);
        }}}
    };
    vm.runInNewContext(script, context);
    return {field, transactions, requests, estimates, prompts, walletCalls, events, confirmedBalanceReads};
}

test('funding preflights the exact allowance and refreshed deposit, bounds gas, and leaves fees to MetaMask', async () => {
    const f = fixture();
    await new Promise(resolve => setImmediate(resolve));
    await f.field('fund').events.click();
    assert.equal(f.transactions.length, 2);
    assert.equal(f.estimates.length, 2);
    for (const transaction of f.transactions) assert.equal(transaction.chainId, '0xaa36a7');
    for (let i = 0; i < f.transactions.length; i++) {
        const {gas, ...call} = JSON.parse(JSON.stringify(f.transactions[i]));
        assert.deepEqual(call, f.estimates[i], 'the submitted call must match its successful estimate');
        assert.ok(BigInt(gas) <= 1n << 24n);
        for (const fee of ['gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
            assert.equal(fee in f.transactions[i], false, 'the wallet must choose the fee');
        }
    }
    assert.equal(BigInt(f.transactions[0].gas), 105563n);
    assert.equal(f.transactions[1].gas, '0x839b46');
    assert.match(f.prompts[0], /Approve exactly 0\.100000 USDC/);
    assert.match(f.prompts[0], /Estimated gas: 46,303 units; gas limit: 105,563 units/);
    assert.match(f.prompts[1], /Approve the vault deposit/);
    assert.match(f.prompts[1], /MetaMask shows the ETH fee/);
    assert.equal(f.transactions[0].to, '0x2222222222222222222222222222222222222222');
    assert.equal(f.transactions[0].data, '0x095ea7b3' + '1111111111111111111111111111111111111111'.padStart(64, '0') + (100000).toString(16).padStart(64, '0'));
    assert.equal(f.transactions[1].data, '0xc588341c' + '1234'.padStart(64, '0') + (100000).toString(16).padStart(64, '0') + 'a'.padStart(64, '0').repeat(32));
    assert.ok(f.events.indexOf('api:path') > f.events.indexOf('eth_getTransactionReceipt'), 'the shared Merkle witness must be refreshed after the allowance transaction confirms');
    assert.ok(f.requests.every(({options}) => options.credentials === 'omit'));
    assert.match(f.field('status').textContent, /private balance is funded/);
});

for (const allowanceAmount of [100000n, 200000n]) {
    test(`existing allowance of ${allowanceAmount} skips approval and still preflights the refreshed deposit`, async () => {
        const f = fixture({allowance: '0x' + allowanceAmount.toString(16).padStart(64, '0'), estimateValues: ['0x6d094d']});
        await new Promise(resolve => setImmediate(resolve));
        await f.field('fund').events.click();
        assert.equal(f.transactions.length, 1);
        assert.equal(f.estimates.length, 1);
        assert.equal(f.transactions[0].data, '0xc588341c' + '1234'.padStart(64, '0') + (100000).toString(16).padStart(64, '0') + 'a'.padStart(64, '0').repeat(32));
        assert.equal(f.transactions[0].gas, '0x839b46');
        const {gas, ...call} = JSON.parse(JSON.stringify(f.transactions[0]));
        assert.deepEqual(call, f.estimates[0]);
        const allowanceRead = f.walletCalls.find(({method, params}) => method === 'eth_call' && params[0].data.startsWith('0xdd62ed3e'));
        assert.deepEqual(allowanceRead.params, [{to: '0x2222222222222222222222222222222222222222', data: '0xdd62ed3e' + '3333333333333333333333333333333333333333'.padStart(64, '0') + '1111111111111111111111111111111111111111'.padStart(64, '0')}, 'latest']);
        assert.equal(f.events.includes('eth_getTransactionReceipt'), false, 'no allowance transaction was sent');
        assert.match(f.field('status').textContent, /private balance is funded/);
    });
}

test('insufficient existing allowance submits exactly the requested amount', async () => {
    const f = fixture({allowance: '0x' + (50000n).toString(16).padStart(64, '0')});
    await new Promise(resolve => setImmediate(resolve));
    await f.field('fund').events.click();
    assert.equal(f.transactions.length, 2);
    assert.equal(f.transactions[0].data, '0x095ea7b3' + '1111111111111111111111111111111111111111'.padStart(64, '0') + (100000).toString(16).padStart(64, '0'));
});

for (const [reason, options, message] of [
    ['read failure', {allowanceError: true}, /Cannot read token allowance/],
    ['invalid value', {allowance: '0x'}, /invalid token allowance/],
    ['network change', {changeChainDuringAllowance: true}, /network changed/],
    ['account change', {changeAccountDuringAllowance: true}, /account changed/]
]) {
    test(`allowance ${reason} prevents all transaction prompts`, async () => {
        const f = fixture(options);
        await new Promise(resolve => setImmediate(resolve));
        await f.field('fund').events.click();
        assert.equal(f.transactions.length, 0);
        assert.equal(f.estimates.length, 0);
        assert.match(f.field('status').textContent, message);
    });
}

test('session expiry after successful approval explains how to resume without repeating approval', async () => {
    const f = fixture({expireAtPath: true});
    await new Promise(resolve => setImmediate(resolve));
    await f.field('fund').events.click();
    assert.equal(f.transactions.length, 1);
    assert.match(f.field('status').textContent, /token allowance is ready.*session expired before the deposit was submitted.*existing approval will be reused/);
    assert.equal(f.field('tx').value, '', 'an allowance hash must never appear as a deposit hash');
    assert.equal(f.requests.filter(({url}) => url.endsWith('/prepare')).length, 1, 'expiry must not trigger an automatic retry');
});

test('network change during path refresh never submits deposit on another chain', async () => {
    const f = fixture({changeChainDuringPath: true});
    await new Promise(resolve => setImmediate(resolve));
    await f.field('fund').events.click();
    assert.equal(f.transactions.length, 1, 'only the already approved allowance may be sent');
    assert.match(f.field('status').textContent, /network changed/);
});

for (const attempt of [1, 2]) {
    const action = attempt === 1 ? 'approval' : 'deposit';
    test(`${action} estimate failure never opens a transaction prompt`, async () => {
        const f = fixture({estimateErrorAt: attempt});
        await new Promise(resolve => setImmediate(resolve));
        await f.field('fund').events.click();
        assert.equal(f.transactions.length, attempt - 1);
        assert.match(f.field('status').textContent, new RegExp((attempt === 1 ? 'Token approval' : 'Vault deposit') + ' simulation failed.*This transaction was not submitted.*stale witness'));
    });
    test(`${action} gas above the transaction cap never opens a transaction prompt`, async () => {
        const values = ['0xb4df', '0x6d094d'];
        values[attempt - 1] = '0xf42400'; // 16M estimated + margin exceeds 2^24.
        const f = fixture({estimateValues: values});
        await new Promise(resolve => setImmediate(resolve));
        await f.field('fund').events.click();
        assert.equal(f.transactions.length, attempt - 1);
        assert.match(f.field('status').textContent, /exceeds Ethereum’s per-transaction gas limit.*Nothing was submitted/);
    });
    test(`${action} network change during gas estimation prevents submission`, async () => {
        const f = fixture({changeChainDuringEstimate: attempt});
        await new Promise(resolve => setImmediate(resolve));
        await f.field('fund').events.click();
        assert.equal(f.transactions.length, attempt - 1);
        assert.match(f.field('status').textContent, /network changed/);
    });
    test(`${action} account change during gas estimation prevents submission`, async () => {
        const f = fixture({changeAccountDuringEstimate: attempt});
        await new Promise(resolve => setImmediate(resolve));
        await f.field('fund').events.click();
        assert.equal(f.transactions.length, attempt - 1);
        assert.match(f.field('status').textContent, /account changed/);
    });
}

for (const [reason, options, message] of [
    ['insufficient balance', {balance: '0x' + (99999n).toString(16).padStart(64, '0')}, /needs at least 0\.100000 USDC/],
    ['read failure', {balanceError: true}, /Cannot read token balance/],
    ['invalid balance', {balance: '0x1'}, /invalid token balance/],
    ['network change', {changeChainDuringBalance: true}, /network changed/],
    ['account change', {changeAccountDuringBalance: true}, /account changed/]
]) {
    test(`token balance ${reason} prevents transaction prompts`, async () => {
        const f = fixture(options);
        await new Promise(resolve => setImmediate(resolve));
        await f.field('fund').events.click();
        assert.equal(f.transactions.length, 0);
        assert.equal(f.estimates.length, 0);
        assert.match(f.field('status').textContent, message);
    });
}

test('funding displays the exact connected account, balance, and existing allowance', async () => {
    const f = fixture({balance: '0x' + (100000n).toString(16).padStart(64, '0')});
    await new Promise(resolve => setImmediate(resolve));
    await f.field('fund').events.click();
    assert.match(f.field('wallet-status').textContent, /Funding account: 0x3333333333333333333333333333333333333333/);
    assert.match(f.field('wallet-status').textContent, /Wallet balance: 0\.100000 USDC\. Vault allowance: 0\.000000 USDC/);
    assert.equal(f.transactions.length, 2, 'exactly sufficient balance may proceed');
});

for (const invalid of ['0x0', '-0x1', '0x1.5', '0x', 'nonsense', null, true, 46303]) {
    test(`invalid gas estimate ${JSON.stringify(invalid)} prevents submission`, async () => {
        const f = fixture({estimateValues: [invalid]});
        await new Promise(resolve => setImmediate(resolve));
        await f.field('fund').events.click();
        assert.equal(f.transactions.length, 0);
        assert.match(f.field('status').textContent, /invalid gas estimate.*Nothing was submitted/);
    });
}

test('Sepolia mints only the shortfall to the selected account before approval and deposit', async () => {
    const f = fixture({demoMintEnabled: true, balance: '0x' + (40000n).toString(16).padStart(64, '0'), estimateValues: ['0xb4df', '0xb4df', '0x6d094d']});
    await new Promise(resolve => setImmediate(resolve));
    await f.field('fund').events.click();
    assert.equal(f.transactions.length, 3);
    assert.equal(f.transactions[0].to, '0x2222222222222222222222222222222222222222');
    assert.equal(f.transactions[0].data, '0x40c10f19' + '3333333333333333333333333333333333333333'.padStart(64, '0') + (60000).toString(16).padStart(64, '0'));
    assert.equal(BigInt(f.transactions[0].gas), 105563n);
    assert.match(f.prompts[0], /Mint exactly 0\.060000 test USDC/);
    assert.deepEqual(f.confirmedBalanceReads, ['0x123'], 'read the canonical mint block, not cached latest');
    assert.ok(f.transactions[1].data.startsWith('0x095ea7b3'));
    assert.ok(f.transactions[2].data.startsWith('0xc588341c'));
    assert.ok(f.events.indexOf('api:path') > f.events.lastIndexOf('eth_getTransactionReceipt'));
    assert.match(f.field('status').textContent, /private balance is funded/);
});

test('mint retries only receipt-block reads when wallet state lags and reuses sufficient allowance', async () => {
    const zero = '0x' + '0'.repeat(64);
    const enough = '0x' + (100000n).toString(16).padStart(64, '0');
    const f = fixture({demoMintEnabled: true, balance: zero, allowance: enough, confirmedMintBalances: [zero, zero, enough]});
    await new Promise(resolve => setImmediate(resolve));
    await f.field('fund').events.click();
    assert.equal(f.transactions.length, 2);
    assert.ok(f.transactions[0].data.startsWith('0x40c10f19'));
    assert.ok(f.transactions[1].data.startsWith('0xc588341c'));
    assert.deepEqual(f.confirmedBalanceReads, ['0x123', '0x123', '0x123']);
    assert.equal(f.transactions.filter(tx => tx.data.startsWith('0x40c10f19')).length, 1);
});

for (const [label, options, message] of [
    ['reverted receipt', {mintReverted: true}, /transaction reverted/],
    ['changed receipt block', {mintReorg: true}, /mint block changed/],
    ['persistently stale balance', {confirmedMintBalances: ['0x' + '0'.repeat(64)]}, /mint was confirmed.*No further transaction was submitted/]
]) {
    test(`mint ${label} never repeats mint or proceeds to another transaction`, async () => {
        const f = fixture({demoMintEnabled: true, balance: '0x' + '0'.repeat(64), ...options});
        await new Promise(resolve => setImmediate(resolve));
        await f.field('fund').events.click();
        assert.equal(f.transactions.length, 1);
        assert.ok(f.transactions[0].data.startsWith('0x40c10f19'));
        assert.match(f.field('status').textContent, message);
    });
}

for (const [label, options] of [
    ['mainnet even with flag enabled', {chainID: 1, demoMintEnabled: true}],
    ['Sepolia flag disabled', {demoMintEnabled: false}],
    ['Sepolia non-boolean flag', {demoMintEnabled: 'true'}]
]) {
    test(`${label} never requests test-token minting`, async () => {
        const f = fixture({balance: '0x' + '0'.repeat(64), ...options});
        await new Promise(resolve => setImmediate(resolve));
        await f.field('fund').events.click();
        assert.equal(f.transactions.length, 0);
        assert.match(f.field('status').textContent, /needs at least/);
    });
}

test('nested simulation revert data displays only its four-byte selector', async () => {
    const f = fixture({estimateErrorAt: 1, estimateErrorData: {originalError: {data: '0x607447de' + '1234'.repeat(16)}}});
    await new Promise(resolve => setImmediate(resolve));
    await f.field('fund').events.click();
    assert.equal(f.transactions.length, 0);
    assert.match(f.field('status').textContent, /Contract error: 0x607447de\./);
    assert.doesNotMatch(f.field('status').textContent, /1234/);
});
