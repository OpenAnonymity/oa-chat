import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressDepositFlow } from '../../chat/zkapi/services/addressDepositFlow.mjs';

function fixture(t, options = {}) {
    let saved = options.saved || null;
    let balance = '0';
    let quotes = 0;
    const client = {
        isNativeEthFunding: true,
        config: { funding: { chain_id: 11155111, contract_address: '0xVAULT' } },
        async quoteDepositUsd(usd) {
            quotes++;
            if (!/^\d+$/.test(usd)) throw new Error('Enter a valid dollar amount.');
            return { amount: `${usd}000000`, ethAmount: `0.${usd.padStart(3, '0')}`,
                depositWei: `${usd}000000000000000`, usdAmount: usd, priceUpdatedAt: 10 };
        }
    };
    const wallet = {
        hasPendingTransaction: false,
        async ensureAddress() { return '0xACCOUNT'; },
        async getStatus() { return { ethBalance: balance }; },
        async getDepositFeeQuote() { return { feeReserveWei: '1000000000000000' }; },
        request() { assert.fail('read-only funding flow must never request a transaction'); }
    };
    const store = {
        async read() { return structuredClone(saved); },
        async write(_scope, value) { saved = structuredClone(value); }
    };
    const flow = new AddressDepositFlow({ wallet, client, store, interval: 60_000, now: () => 12_000 });
    t.after(() => flow.stop());
    return { flow, wallet, client, store, setBalance(value) { balance = value; },
        saved: () => saved, quotes: () => quotes };
}

test('waiting continuously reads funds but never submits, then requires a fresh explicit readiness check', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    assert.equal(f.flow.ready, false);
    assert.equal(f.flow.totalWei, '11000000000000000');
    assert.equal(f.saved().depositWei, '10000000000000000');
    await assert.rejects(f.flow.verifyReady(), /Wait until/);
    f.setBalance('11000000000000000');
    await f.flow.check();
    assert.equal(f.flow.ready, true);
    assert.equal((await f.flow.verifyReady()).ethAmount, '0.010');
    f.setBalance('10999999999999999');
    await assert.rejects(f.flow.verifyReady(), /needs more ETH/);
});

test('reopening restores the original ETH amount without repricing or sending', async t => {
    const first = fixture(t);
    await first.flow.start('10');
    first.flow.stop();
    const restored = fixture(t, { saved: first.saved() });
    restored.setBalance('11000000000000000');
    await restored.flow.start('99');
    assert.equal(restored.quotes(), 0);
    assert.equal(restored.flow.intent.usdAmount, '10');
    assert.equal(restored.flow.ready, true);
});

test('storage commit must complete before displaying receiving instructions', async t => {
    const f = fixture(t);
    let resolveWrite;
    f.store.write = () => new Promise(resolve => { resolveWrite = resolve; });
    const pending = f.flow.start('10');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.flow.intent, null);
    assert.equal(f.flow.ready, false);
    resolveWrite();
    await pending;
    assert.equal(f.flow.intent.amount, '10000000');
});

test('an unavailable durable store never displays a payable amount', async t => {
    const f = fixture(t);
    f.store.write = async () => { throw new Error('Storage unavailable'); };
    await f.flow.start('10');
    assert.equal(f.flow.intent, null);
    assert.equal(f.flow.ready, false);
    assert.match(f.flow.error, /Storage unavailable/);
});

test('editing invalidates Next immediately and a previous pending RPC cannot restore it', async t => {
    const f = fixture(t);
    f.setBalance('99000000000000000');
    await f.flow.start('10');
    let resolveStatus;
    f.wallet.getStatus = () => new Promise(resolve => { resolveStatus = resolve; });
    const check = f.flow.check();
    f.flow.invalidate();
    resolveStatus({ ethBalance: '99000000000000000' });
    await check;
    assert.equal(f.flow.ready, false);
    await f.flow.check();
    assert.equal(f.flow.ready, false);
});

test('out-of-order USD quotations cannot replace the latest edited deposit', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    const quote = f.client.quoteDepositUsd;
    let resolveOld;
    f.client.quoteDepositUsd = usd => usd === '20' ? new Promise(resolve => { resolveOld = resolve; }) : quote(usd);
    const old = f.flow.setAmount('20');
    await f.flow.setAmount('30');
    resolveOld(await quote('20'));
    await old;
    assert.equal(f.flow.intent.usdAmount, '30');
    assert.equal(f.saved().usdAmount, '30');
});

test('a failed edit stays invalid instead of reviving the old amount during polling', async t => {
    const f = fixture(t);
    f.setBalance('99000000000000000');
    await f.flow.start('10');
    await f.flow.setAmount('no');
    await f.flow.check();
    assert.equal(f.flow.ready, false);
    assert.match(f.flow.error, /valid dollar/);
});

test('closing during a chain read cannot re-enable Next', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    let resolveStatus;
    f.wallet.getStatus = () => new Promise(resolve => { resolveStatus = resolve; });
    const pending = f.flow.check();
    f.flow.stop();
    resolveStatus({ ethBalance: '99000000000000000' });
    await pending;
    assert.equal(f.flow.ready, false);
});

test('another tab changing the saved deposit blocks use of the old amount', async t => {
    const f = fixture(t);
    f.setBalance('99000000000000000');
    await f.flow.start('10');
    await f.store.write(f.flow.scope, { ...f.saved(), usdAmount: '20' });
    await assert.rejects(f.flow.verifyReady(), /another tab/);
    assert.equal(f.flow.ready, false);
});

test('a pending transaction and fee quote failure both block a fresh deposit', async t => {
    const f = fixture(t);
    f.setBalance('99000000000000000');
    await f.flow.start('10');
    f.wallet.hasPendingTransaction = true;
    await f.flow.check();
    assert.equal(f.flow.ready, false);
    f.wallet.hasPendingTransaction = false;
    f.wallet.getDepositFeeQuote = async () => { throw new Error('Fees unavailable'); };
    await f.flow.check();
    assert.equal(f.flow.ready, false);
    assert.match(f.flow.error, /Fees unavailable/);
});

test('a token deployment cannot create an ETH address intent', async t => {
    const f = fixture(t);
    f.client.isNativeEthFunding = false;
    f.wallet.ensureAddress = () => assert.fail('incompatible deployment must be rejected first');
    await f.flow.start('10');
    assert.equal(f.saved(), null);
    assert.match(f.flow.error, /does not yet support ETH/);
});

test('tampered stored ETH units fail closed', async t => {
    const first = fixture(t);
    await first.flow.start('10');
    const f = fixture(t, { saved: { ...first.saved(), ethAmount: '1' } });
    await f.flow.start('10');
    assert.equal(f.flow.ready, false);
    assert.match(f.flow.error, /does not match/);
});
