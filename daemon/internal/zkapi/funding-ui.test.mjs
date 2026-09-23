import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('./funding.js', import.meta.url), 'utf8');
const html = await readFile(new URL('./funding.html', import.meta.url), 'utf8');
const address = '0x3333333333333333333333333333333333333333';
const token = '0x2222222222222222222222222222222222222222';
const hash = '0x' + 'a'.repeat(64);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({chainID = 11155111, demoMintEnabled = false, addressState = {}, deposits = [{phase: 'active'}], responses = {}, stored = {}, noCapability = false, privateBalance = null, storageUnavailable = false} = {}) {
    const fields = new Map();
    const field = id => {
        if (!fields.has(id)) fields.set(id, {value: id === 'amount' ? '0.10' : '', disabled: false, readOnly: false, textContent: '', events: {}, addEventListener(type, callback) { this.events[type] = callback; }});
        return fields.get(id);
    };
    const storage = new Map(Object.entries(stored));
    const requests = [];
    const copies = [];
    const events = {};
    let depositIndex = 0;
    let funded = privateBalance !== null;
    const base = {address, chain_id: chainID, token_address: token, token_balance: '100000', eth_balance: '1000000000000000', phase: 'ready', ...addressState};
    const context = {
        document: {getElementById: field},
        location: {hash: noCapability ? '' : '#funding-capability'},
        history: {replaceState(...args) { events.history = args; }},
        sessionStorage: {
            setItem(key, value) { if (storageUnavailable) throw new Error('Storage restricted'); storage.set(key, value); },
            getItem(key) { if (storageUnavailable) throw new Error('Storage restricted'); return storage.get(key) || ''; },
            removeItem(key) { if (storageUnavailable) throw new Error('Storage restricted'); storage.delete(key); }
        },
        setTimeout: callback => setTimeout(callback, 0),
        navigator: {clipboard: {writeText: async value => { copies.push(value); }}},
        window: {addEventListener(type, callback) { events[type] = callback; }},
        fetch: async (url, options) => {
            requests.push({url, options});
            const path = url.replace('/funding/api/', '');
            let result;
            if (responses[path]) {
                const response = await responses[path](requests.filter(request => request.url === url).length, options, base);
                if (response) return {ok: response.status === 200, status: response.status, text: async () => response.text ?? JSON.stringify(response.body)};
            }
            if (path === 'config') result = {chain_id: chainID, demo_mint_enabled: demoMintEnabled, token_address: token, contract_address: '0x1111111111111111111111111111111111111111'};
            else if (path === 'address') result = base;
            else if (path === 'status') result = {has_note: funded, balance: privateBalance ?? 100000};
            else if (path === 'address/deposit') {
                result = {...base, amount: 100000, ...deposits[Math.min(depositIndex++, deposits.length - 1)]};
                funded = result.phase === 'active';
            } else if (path === 'confirm') { result = {active: true}; funded = true; }
            else throw new Error('Unexpected endpoint: ' + path);
            return {ok: true, status: 200, text: async () => JSON.stringify(result)};
        }
    };
    // Accessing an injected provider would fail even in a browser that has one.
    Object.defineProperty(context.window, 'ethereum', {get() { throw new Error('Ethereum provider must never be accessed'); }});
    vm.runInNewContext(script, context);
    return {field, requests, copies, events, storage, context, base};
}
const posts = fixture => fixture.requests.filter(({options}) => options.method === 'POST');

test('load shows a receiving address and balances with no provider or mutation', async () => {
    const f = fixture();
    await tick();
    assert.equal(f.field('address').textContent, address);
    assert.match(f.field('received').textContent, /0\.100000 test billing tokens · 0\.001000000000000000 Sepolia ETH/);
    assert.equal(f.field('fund').disabled, false);
    assert.equal(posts(f).length, 0);
    assert.ok(f.requests.every(({options}) => options.credentials === 'omit' && options.cache === 'no-store'));
    assert.ok(f.requests.every(({options}) => options.headers.Authorization === 'Bearer funding-capability'));
    assert.deepEqual(f.events.history, [null, '', '/funding']);
    assert.doesNotMatch(script + html, /MetaMask|eth_sendTransaction|eth_requestAccounts|window\.ethereum|connect wallet/i);
});

test('Check funds and copy do not authorize transactions', async () => {
    const f = fixture();
    await tick();
    f.base.token_balance = '999999999999999999999999';
    await f.field('check').events.click();
    await f.field('copy').events.click();
    assert.equal(posts(f).length, 0);
    assert.deepEqual(f.copies, [address]);
    assert.match(f.field('received').textContent, /999999999999999999\.999999/);
});

test('explicit deposit progresses with one frozen amount through confirmation', async () => {
    const f = fixture({deposits: [
        {phase: 'approval_pending', message: 'Approval awaiting finality.'},
        {phase: 'deposit_pending', transaction_hash: hash},
        {phase: 'confirming'},
        {phase: 'active'}
    ]});
    await tick();
    f.field('amount').value = '0.123456';
    await f.field('fund').events.click();
    assert.equal(posts(f).length, 4);
    assert.ok(posts(f).every(({url, options}) => url.endsWith('/address/deposit') && JSON.parse(options.body).amount === 123456));
    assert.match(f.field('status').textContent, /private balance is funded/);
    assert.equal(f.field('fund').disabled, true);
});

for (const phase of ['waiting_funds', 'reverted', 'legacy_recovery', 'recovery_required', 'error', 'ready', 'unknown']) {
    test(`deposit stops after ${phase} without automatically authorizing more work`, async () => {
        const f = fixture({deposits: [{phase, message: 'Saved progress needs attention.'}]});
        await tick();
        await f.field('fund').events.click();
        assert.equal(posts(f).length, 1);
        assert.equal(f.field('status').textContent, 'Saved progress needs attention.');
        assert.equal(f.field('amount').readOnly, true);
    });
}

test('reload restores the saved amount and transaction without resuming POSTs', async () => {
    const f = fixture({addressState: {amount: 987654, phase: 'deposit_pending', transaction_hash: hash, message: 'Waiting for Ethereum finality.'}});
    await tick();
    assert.equal(posts(f).length, 0);
    assert.equal(f.field('amount').value, '0.987654');
    assert.equal(f.field('amount').readOnly, true);
    assert.match(f.field('transaction').textContent, new RegExp(hash));
    assert.equal(f.field('fund').textContent, 'Continue saved deposit');
    assert.equal(f.field('status').textContent, 'Waiting for Ethereum finality.');
});

for (const statusCode of [401, 403]) {
    test(`authorization ${statusCode} stops deposit polling and keeps actions disabled`, async () => {
        const f = fixture({responses: {'address/deposit': count => count === 1 ? {status: 200, body: {address, chain_id: 11155111, token_address: token, phase: 'approval_pending'}} : {status: statusCode, body: {error: 'unauthorized'}}}});
        await tick();
        await f.field('fund').events.click();
        assert.equal(posts(f).length, 2);
        assert.match(f.field('status').textContent, /no longer authorized.*oa-chat fund --browser/);
        for (const id of ['fund', 'resume', 'check']) assert.equal(f.field(id).disabled, true);
        assert.equal(f.storage.has('oa-funding-capability'), false);
        await f.field('fund').events.click();
        assert.equal(posts(f).length, 2);
    });
}

test('interrupted POST never retries automatically', async () => {
    const f = fixture({responses: {'address/deposit': () => { throw new Error('Connection lost'); }}});
    await tick();
    await f.field('fund').events.click();
    assert.equal(posts(f).length, 1);
    assert.match(f.field('status').textContent, /Connection lost.*interrupted request may have submitted a transaction/);
});

test('a second click cannot overlap an active deposit and pagehide stops progression', async () => {
    let release;
    const f = fixture({responses: {'address/deposit': async () => {
        await new Promise(resolve => { release = resolve; });
        return {status: 200, body: {address, chain_id: 11155111, token_address: token, phase: 'approval_pending'}};
    }}});
    await tick();
    const running = f.field('fund').events.click();
    await tick();
    await f.field('fund').events.click();
    assert.equal(posts(f).length, 1);
    assert.equal(f.field('fund').disabled, true);
    f.events.pagehide();
    release();
    await running;
    assert.equal(posts(f).length, 1);
});

for (const value of ['0', '-1', '0.0000001', '1e3', '1000000.000001', '', '<script>']) {
    test(`invalid amount ${JSON.stringify(value)} never reaches the signer`, async () => {
        const f = fixture();
        await tick();
        f.field('amount').value = value;
        await f.field('fund').events.click();
        assert.equal(posts(f).length, 0);
        assert.match(f.field('status').textContent, /Enter a/);
    });
}

test('existing private balance blocks deposits and displays current rather than original amount', async () => {
    const f = fixture({privateBalance: 98723});
    await tick();
    assert.equal(f.field('fund').disabled, true);
    assert.match(f.field('balance').textContent, /0\.098723/);
    await f.field('fund').events.click();
    assert.equal(posts(f).length, 0);
});

test('legacy transaction recovery is explicit and never starts a new deposit', async () => {
    const f = fixture({stored: {'oa-funding-deposit-tx': hash}, addressState: {phase: 'legacy_recovery', amount: 100000}});
    await tick();
    assert.equal(f.field('tx').value, hash);
    assert.equal(f.field('fund').disabled, true);
    assert.equal(posts(f).length, 0);
    await f.field('resume').events.click();
    assert.equal(posts(f).length, 1);
    assert.equal(posts(f)[0].url, '/funding/api/confirm');
    assert.equal(JSON.parse(posts(f)[0].options.body).transaction_hash, hash);
    assert.match(f.field('status').textContent, /private balance is funded/);
});

test('legacy confirmation stops immediately on expired authorization', async () => {
    const f = fixture({responses: {confirm: () => ({status: 401, body: {error: 'not confirmed yet'}})}});
    await tick();
    f.field('tx').value = hash;
    await f.field('resume').events.click();
    assert.equal(posts(f).length, 1);
    assert.equal(f.field('resume').disabled, true);
});

for (const [label, patch] of [
    ['network', {chain_id: 1}],
    ['token', {token_address: '0x4444444444444444444444444444444444444444'}],
    ['address', {address: '<script>invalid</script>'}]
]) {
    test(`a mismatched ${label} never enables deposits`, async () => {
        const f = fixture({addressState: patch});
        await tick();
        assert.equal(f.field('fund').disabled, true);
        assert.equal(posts(f).length, 0);
        assert.match(f.field('status').textContent, /does not match/);
    });
}

test('network failure on load permits a read-only check without enabling a deposit prematurely', async () => {
    const f = fixture({responses: {status: count => count === 1 ? {status: 503, body: {error: 'Companion unavailable'}} : null}});
    await tick();
    assert.equal(f.field('fund').disabled, true);
    assert.equal(f.field('check').disabled, false);
    await f.field('check').events.click();
    assert.equal(f.field('fund').disabled, false);
    assert.equal(posts(f).length, 0);
});

test('network requirements distinguish mainnet from the exact Sepolia test token without claiming mint support', async () => {
    const mainnet = fixture({chainID: 1, demoMintEnabled: true});
    const sepolia = fixture({demoMintEnabled: true});
    const exact = fixture();
    await tick();
    assert.match(mainnet.field('requirements').textContent, /Send USDC.*ETH.*Ethereum Mainnet/);
    assert.doesNotMatch(mainnet.field('requirements').textContent, /mint/);
    assert.match(sepolia.field('requirements').textContent, /test billing token and Sepolia ETH.*does not mint test tokens/);
    assert.match(exact.field('requirements').textContent, /Other test USDC contracts will not work/);
});

test('missing authorization never queries the daemon or enables actions', async () => {
    const f = fixture({noCapability: true});
    await tick();
    assert.equal(f.requests.length, 0);
    assert.equal(f.field('fund').disabled, true);
    assert.match(f.field('status').textContent, /secure funding session/);
});

test('restricted session storage still supports an explicit fragment-authorized session', async () => {
    const f = fixture({storageUnavailable: true});
    await tick();
    assert.equal(f.field('fund').disabled, false);
    assert.equal(posts(f).length, 0);
});


test('a finalized reverted transaction stops and requires another explicit click to retry', async () => {
    const f = fixture({deposits: [{phase: 'reverted', message: 'The transaction reverted. Retry explicitly.'}, {phase: 'active'}]});
    await tick();
    await f.field('fund').events.click();
    assert.equal(posts(f).length, 1);
    assert.equal(f.field('fund').disabled, false);
    assert.equal(f.field('fund').textContent, 'Retry saved deposit');
    await f.field('fund').events.click();
    assert.equal(posts(f).length, 2);
    assert.match(f.field('status').textContent, /private balance is funded/);
});

test('deposit consent states the network fee cap and public funding boundary', () => {
    assert.match(html, /network fees, capped at 0\.02 ETH per transaction/);
    assert.match(html, /Funding transfers and deposits are public Ethereum transactions; they are not anonymous/);
    assert.match(html, /Back up your private OA Chat configuration directory before sending funds/);
});


test('active saved deposit with missing companion note cannot authorize a duplicate', async () => {
    const f = fixture({addressState: {phase: 'active', amount: 100000}});
    await tick();
    assert.equal(f.field('fund').disabled, true);
    assert.match(f.field('status').textContent, /private balance is unavailable.*do not send another deposit/);
    await f.field('fund').events.click();
    assert.equal(posts(f).length, 0);
});

test('read-only confirmed closure can unlock an amount for a new deposit', async () => {
    const f = fixture({addressState: {phase: 'active', amount: 100000}});
    await tick();
    assert.equal(f.field('amount').readOnly, true);
    f.base.phase = 'ready';
    delete f.base.amount;
    await f.field('check').events.click();
    assert.equal(f.field('amount').readOnly, false);
    assert.equal(f.field('fund').disabled, false);
    assert.equal(f.field('fund').textContent, 'Deposit into private balance');
    assert.equal(posts(f).length, 0);
});


test('missing companion state requiring recovery keeps funding disabled after reload', async () => {
    const f = fixture({addressState: {phase: 'recovery_required', amount: 100000, message: 'Restore the original companion state before continuing.'}});
    await tick();
    assert.equal(f.field('fund').disabled, true);
    assert.equal(f.field('status').textContent, 'Restore the original companion state before continuing.');
    await f.field('fund').events.click();
    assert.equal(posts(f).length, 0);
});
