import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressDepositFlow } from '../../chat/zkapi/services/addressDepositFlow.mjs';

function fixture(t, options = {}) {
    let saved = options.saved || null;
    let balance = '0';
    let quotes = 0;
    let feeQuotes = 0;
    let now = 12_000;
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
        async getDepositFeeQuote(intent) {
            feeQuotes++;
            return { expectedFeeWei: '600000000000000', feeBufferWei: '400000000000000',
                feeReserveWei: '1000000000000000', amount: intent.amount, depositWei: intent.depositWei,
                address: '0xACCOUNT', chainId: 11155111, contractAddress: '0xVAULT',
                operationId: 'operation-1', depositCommitment: 'commitment-1',
                quotedAt: now, expiresAt: now + 30_000 };
        },
        request() { assert.fail('read-only funding flow must never request a transaction'); }
    };
    const store = {
        async read() { return structuredClone(saved); },
        async write(_scope, value) { saved = structuredClone(value); }
    };
    const flow = new AddressDepositFlow({ wallet, client, store, interval: 60_000, now: () => now });
    t.after(() => flow.stop());
    return { flow, wallet, client, store, setBalance(value) { balance = value; },
        saved: () => saved, quotes: () => quotes, feeQuotes: () => feeQuotes, advance(ms) { now += ms; } };
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
    await f.flow.check({ forceQuote: true });
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


test('existing address ETH reduces the requested transfer without reducing the private principal', async t => {
    const f = fixture(t);
    f.setBalance('2000000000000000');
    await f.flow.start('10');
    assert.equal(f.flow.remainingWei, '9000000000000000');
    assert.equal(f.flow.intent.depositWei, '10000000000000000');
    f.setBalance('12000000000000000');
    await f.flow.check();
    assert.equal(f.flow.remainingWei, '0');
    assert.equal(f.flow.ready, true);
});

test('polls reuse a fresh quote while checking funds, then renew it at expiry and on every Next', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    assert.equal(f.feeQuotes(), 1);
    f.setBalance('99000000000000000');
    await f.flow.check();
    assert.equal(f.feeQuotes(), 1);
    assert.equal(f.flow.ready, true);
    f.advance(30_000);
    await f.flow.check();
    assert.equal(f.feeQuotes(), 2);
    const verified = await f.flow.verifyReady();
    assert.equal(f.feeQuotes(), 3);
    assert.equal(verified.preparedOperationId, 'operation-1');
    assert.equal(verified.depositCommitment, 'commitment-1');
    assert.equal(verified.feeLimitWei, '1000000000000000');
    assert.equal(verified.feeQuoteExpiresAt, 72_000);
});

test('an increased fee requires reviewing the new quote and another explicit click, even with enough ETH', async t => {
    const f = fixture(t);
    f.setBalance('99000000000000000');
    await f.flow.start('10');
    const original = f.wallet.getDepositFeeQuote;
    f.wallet.getDepositFeeQuote = async intent => ({ ...await original(intent),
        feeReserveWei: '1200000000000000', feeBufferWei: '600000000000000' });
    await assert.rejects(f.flow.verifyReady(), /Network fees changed/);
    assert.equal(f.flow.ready, true);
    assert.equal(f.flow.totalWei, '11200000000000000');
    assert.equal((await f.flow.verifyReady()).feeLimitWei, '1200000000000000');
});

test('a reduced fee is bound to the lower limit on Next', async t => {
    const f = fixture(t);
    f.setBalance('99000000000000000');
    await f.flow.start('10');
    const original = f.wallet.getDepositFeeQuote;
    f.wallet.getDepositFeeQuote = async intent => ({ ...await original(intent),
        feeReserveWei: '800000000000000', feeBufferWei: '200000000000000' });
    assert.equal((await f.flow.verifyReady()).feeLimitWei, '800000000000000');
});

test('invalid quote amounts, scope, times and fee arithmetic fail closed', async t => {
    const variants = [
        { amount: '1' }, { depositWei: '1' }, { chainId: 1 }, { address: '0xOTHER' },
        { contractAddress: '0xOTHER' }, { operationId: '' }, { depositCommitment: '' },
        { quotedAt: 13_000 }, { expiresAt: 12_000 }, { feeBufferWei: '1' }, { expectedFeeWei: '-1' }
    ];
    for (const invalid of variants) {
        const f = fixture(t);
        const original = f.wallet.getDepositFeeQuote;
        f.wallet.getDepositFeeQuote = async intent => ({ ...await original(intent), ...invalid });
        await f.flow.start('10');
        assert.equal(f.flow.ready, false, JSON.stringify(invalid));
        assert.equal(f.flow.totalWei, null);
        assert.match(f.flow.error, /could not be verified/);
    }
});

test('out-of-order same-amount fee reads cannot replace a newer quote', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    const original = f.wallet.getDepositFeeQuote;
    const oldQuote = await original(f.flow.intent);
    let resolveOld;
    f.wallet.getDepositFeeQuote = () => new Promise(resolve => { resolveOld = resolve; });
    const oldCheck = f.flow.check({ forceQuote: true });
    f.wallet.getDepositFeeQuote = async intent => ({ ...await original(intent),
        feeReserveWei: '1200000000000000', feeBufferWei: '600000000000000' });
    await f.flow.check({ forceQuote: true });
    resolveOld(oldQuote);
    await oldCheck;
    assert.equal(f.flow.fee.feeReserveWei, '1200000000000000');
});

test('an intent changed in storage during the explicit fee refresh cannot be authorized', async t => {
    const f = fixture(t);
    f.setBalance('99000000000000000');
    await f.flow.start('10');
    const original = f.wallet.getDepositFeeQuote;
    f.wallet.getDepositFeeQuote = async intent => {
        await f.store.write(f.flow.scope, { ...f.saved(), usdAmount: '20' });
        return original(intent);
    };
    await assert.rejects(f.flow.verifyReady(), /another tab/);
    assert.equal(f.flow.ready, false);
});

test('closing during explicit quote refresh cannot authorize the operation', async t => {
    const f = fixture(t);
    f.setBalance('99000000000000000');
    await f.flow.start('10');
    const original = f.wallet.getDepositFeeQuote;
    f.wallet.getDepositFeeQuote = async intent => { f.flow.stop(); return original(intent); };
    await assert.rejects(f.flow.verifyReady(), /needs more ETH/);
    assert.equal(f.flow.ready, false);
});

test('a safe prepared deposit restores its fixed principal and prevents edits', async t => {
    const first = fixture(t);
    await first.flow.start('10');
    const f = fixture(t, { saved: first.saved() });
    f.client.config.pending_deposit = { amount: 10000000, funding_quote_available: true };
    f.setBalance('99000000000000000');
    await f.flow.start('99');
    assert.equal(f.quotes(), 0);
    assert.equal(f.flow.intent.amount, '10000000');
    assert.equal(f.flow.ready, true);
    await f.flow.setAmount('20');
    assert.equal(f.flow.intent.amount, '10000000');
    assert.equal(f.saved().amount, '10000000');
    assert.match(f.flow.error, /cannot change/);
});

test('the SDK saved principal replaces a stale host intent without repricing', async t => {
    const first = fixture(t);
    await first.flow.start('10');
    const f = fixture(t, { saved: first.saved() });
    f.client.config.pending_deposit = { amount: 20000000, funding_quote_available: true };
    await f.flow.start('99');
    assert.equal(f.flow.intent.amount, '20000000');
    assert.equal(f.flow.intent.ethAmount, '0.020000000');
    assert.equal(f.flow.intent.usdAmount, null);
    assert.equal(f.quotes(), 0);
    assert.equal(f.saved().amount, '20000000');
    assert.equal(f.flow.totalWei, '21000000000000000');
});


test('a MetaMask prepared deposit can switch to address funding without a prior USD intent', async t => {
    const f = fixture(t);
    f.client.config.pending_deposit = { amount: 1234567, funding_quote_available: true };
    await f.flow.start('99');
    assert.equal(f.quotes(), 0);
    assert.equal(f.flow.intent.amount, '1234567');
    assert.equal(f.flow.intent.ethAmount, '0.001234567');
    assert.equal(f.flow.intent.depositWei, '1234567000000000');
    assert.equal(f.flow.intent.usdAmount, null);
    assert.equal(f.saved().source, 'saved-deposit');
    assert.equal(f.flow.error, '');
});
