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
        nativePriceQuote: { answer: '100000000000', decimals: 8, updated_at: 10 },
        async refreshEthUsdPrice() { return this.nativePriceQuote; },
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
            return { expectedFeeWei: '600000000000000', requiredFeeWei: '800000000000000', feeBufferWei: '200000000000000',
                feeReserveWei: '1000000000000000', amount: intent.amount, depositWei: intent.depositWei,
                address: '0xACCOUNT', chainId: 11155111, contractAddress: '0xVAULT',
                operationId: 'operation-1', depositCommitment: 'commitment-1',
                quotedAt: now, expiresAt: now + 30_000 };
        },
        request() { assert.fail('read-only funding flow must never request a transaction'); }
    };
    const store = {
        async read() { return structuredClone(saved); },
        async write(_scope, value) { saved = structuredClone(value); },
        async compareAndSwap(_scope, expected, value) {
            if (JSON.stringify(saved) !== JSON.stringify(expected)) return false;
            saved = structuredClone(value);
            return true;
        }
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
    f.setBalance('10799999999999999');
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

test('a higher required fee beyond the displayed allowance requires another explicit click, even with enough ETH', async t => {
    const f = fixture(t);
    f.setBalance('99000000000000000');
    await f.flow.start('10');
    const original = f.wallet.getDepositFeeQuote;
    f.wallet.getDepositFeeQuote = async intent => ({ ...await original(intent),
        feeReserveWei: '1200000000000000', requiredFeeWei: '1100000000000000', feeBufferWei: '100000000000000' });
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
        feeReserveWei: '800000000000000', feeBufferWei: '0' });
    assert.equal((await f.flow.verifyReady()).feeLimitWei, '800000000000000');
});

test('exact required funds enable Next without requiring the optional buffer', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    assert.equal(f.flow.requiredWei, '10800000000000000');
    assert.equal(f.flow.requiredRemainingWei, '10800000000000000');
    f.setBalance('10799999999999999');
    await f.flow.check();
    assert.equal(f.flow.ready, false);
    assert.equal(f.flow.requiredRemainingWei, '1');
    f.setBalance('10800000000000000');
    await f.flow.check();
    assert.equal(f.flow.ready, true);
    assert.equal(f.flow.requiredRemainingWei, '0');
    assert.equal(f.flow.remainingWei, '200000000000000', 'recommended buffer still shows separately');
    const approved = await f.flow.verifyReady();
    assert.equal(approved.feeLimitWei, '800000000000000');
    assert.equal(approved.depositWei, '10000000000000000');
    assert.equal(approved.amount, '10000000');
});

test('a rising recommendation consumes existing funded buffer instead of blocking Next', async t => {
    const f = fixture(t);
    f.setBalance('11000000000000000');
    await f.flow.start('10');
    const original = f.wallet.getDepositFeeQuote;
    f.wallet.getDepositFeeQuote = async intent => ({ ...await original(intent),
        requiredFeeWei: '900000000000000', feeReserveWei: '1200000000000000', feeBufferWei: '300000000000000' });
    const approved = await f.flow.verifyReady();
    assert.equal(approved.feeLimitWei, '1000000000000000', 'the old displayed allowance stays the ceiling');
    assert.equal(approved.depositWei, '10000000000000000');
    assert.equal(f.flow.ready, true);
    assert.equal(f.flow.requiredRemainingWei, '0');
    assert.equal(f.flow.remainingWei, '200000000000000');
});

test('an incompletely funded buffer caps authorization to the remaining public balance', async t => {
    const f = fixture(t);
    f.setBalance('10800000000000001');
    await f.flow.start('10');
    assert.equal((await f.flow.verifyReady()).feeLimitWei, '800000000000001');
    f.wallet.hasPendingTransaction = true;
    await f.flow.check();
    assert.equal(f.flow.ready, false, 'available funds do not bypass the pending transaction gate');
    await assert.rejects(f.flow.verifyReady(), /Wait until/);
});

test('quote failures retain a successful public balance read without granting readiness', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    f.setBalance('11000000000000000');
    f.wallet.getDepositFeeQuote = async () => { throw new Error('Network fees are unavailable.'); };
    await f.flow.check({ forceQuote: true });
    assert.equal(f.flow.status.ethBalance, '11000000000000000');
    assert.equal(f.flow.ready, false);
    assert.equal(f.flow.requiredWei, null);
    assert.equal(f.flow.requiredRemainingWei, null);
    assert.match(f.flow.error, /fees are unavailable/);
    f.wallet.getStatus = async () => { throw new Error('Balance unavailable'); };
    await f.flow.check({ forceQuote: true });
    assert.equal(f.flow.status, null, 'a failed balance read does not present an old balance as current');
    assert.equal(f.flow.ready, false);
    assert.match(f.flow.error, /balance could not be checked/);
});

test('invalid quote amounts, scope, times and fee arithmetic fail closed', async t => {
    const variants = [
        { amount: '1' }, { depositWei: '1' }, { chainId: 1 }, { address: '0xOTHER' },
        { contractAddress: '0xOTHER' }, { operationId: '' }, { depositCommitment: '' },
        { quotedAt: 13_000 }, { expiresAt: 12_000 }, { feeBufferWei: '1' }, { expectedFeeWei: '-1' },
        { requiredFeeWei: undefined }, { requiredFeeWei: '0' }, { requiredFeeWei: '500000000000000', feeBufferWei: '500000000000000' }
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
        feeReserveWei: '1200000000000000', feeBufferWei: '400000000000000' });
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

test('ETH input preserves every gwei without requiring a dollar price quote', async t => {
    const f = fixture(t);
    f.client.nativePriceQuote = null;
    f.client.refreshEthUsdPrice = () => assert.fail('ETH principal needs no price conversion');
    await f.flow.start('0.123456789', 'eth');
    assert.equal(f.quotes(), 0);
    assert.equal(f.flow.intent.amount, '123456789');
    assert.equal(f.flow.intent.depositWei, '123456789000000000');
    assert.equal(f.flow.intent.usdAmount, null);
    assert.equal(f.flow.intent.source, 'eth-input');
    assert.equal(f.saved().inputCurrency, 'eth');
    assert.equal(f.saved().inputAmount, '0.123456789');
});

test('ETH accepts exact smallest and largest supported principals and normalizes decimal input', async t => {
    const f = fixture(t);
    await f.flow.start('.000000001', 'eth');
    assert.equal(f.flow.intent.amount, '1');
    assert.equal(f.flow.intent.inputAmount, '0.000000001');
    assert.equal(await f.flow.setAmount('9007199.254740991', 'eth'), true);
    assert.equal(f.flow.intent.amount, String(Number.MAX_SAFE_INTEGER));
    assert.equal(await f.flow.setAmount(' 000.0100 ', 'eth'), true);
    assert.equal(f.flow.intent.inputAmount, '0.01');
});

test('invalid or imprecise ETH input cannot enable Next or replace the durable principal', async t => {
    const invalid = ['0', '-1', '1e-3', '0.0000000001', '9007199.254740992', '1,000', 'NaN', '', '.', '1'.repeat(129)];
    const f = fixture(t);
    f.setBalance('99000000000000000');
    await f.flow.start('0.01', 'eth');
    const original = structuredClone(f.saved());
    for (const value of invalid) {
        assert.equal(await f.flow.setAmount(value, 'eth'), false, value);
        await f.flow.check();
        assert.equal(f.flow.ready, false, value);
        assert.equal(f.flow.dirty, true, value);
        assert.deepEqual(f.saved(), original, value);
    }
});

test('USD and ETH display toggles preserve original principal, fee commitment and original dollar input', async t => {
    const f = fixture(t);
    f.setBalance('99000000000000000');
    await f.flow.start('10');
    const original = structuredClone(f.flow.intent);
    const fee = f.flow.fee;
    assert.equal(await f.flow.setCurrency('eth'), true);
    assert.equal(f.flow.intent.inputCurrency, 'eth');
    assert.equal(f.flow.intent.inputAmount, original.ethAmount);
    f.client.nativePriceQuote.answer = '987654321001';
    assert.equal(await f.flow.setCurrency('usd'), true);
    assert.equal(f.flow.intent.inputAmount, '10');
    assert.equal(f.flow.intent.amount, original.amount);
    assert.equal(f.flow.intent.depositWei, original.depositWei);
    assert.equal(f.flow.fee, fee);
    assert.equal(f.quotes(), 1);
    assert.equal(f.feeQuotes(), 1);
    await f.flow.check();
    assert.equal(f.flow.ready, true);
    assert.equal((await f.flow.verifyReady()).amount, original.amount);
});

test('currency switches complete locally while balance and expired fee checks remain unresolved', async t => {
    const f = fixture(t);
    f.setBalance('99000000000000000');
    await f.flow.start('0.01', 'eth');
    const principal = f.flow.intent.amount;
    f.advance(30_000);
    let statusReads = 0;
    let feeReads = 0;
    f.wallet.getStatus = () => { statusReads++; return new Promise(() => {}); };
    f.wallet.getDepositFeeQuote = () => { feeReads++; return new Promise(() => {}); };
    f.client.refreshEthUsdPrice = () => assert.fail('toggle must use the cached validated price');
    for (const currency of ['usd', 'eth', 'usd']) {
        const result = await Promise.race([
            f.flow.setCurrency(currency),
            new Promise(resolve => setImmediate(() => resolve('blocked')))
        ]);
        assert.equal(result, true, `${currency} toggle must not await blockchain reads`);
        assert.equal(f.saved().inputCurrency, currency);
        assert.equal(f.saved().amount, principal);
        assert.equal(f.flow.changingCurrency, false);
        assert.equal(f.flow.ready, false);
    }
    assert.equal(statusReads, 3);
    assert.equal(feeReads, 3);
    await assert.rejects(f.flow.verifyReady(), /Wait until/);
});

test('a draft USD edit can commit from the cached price without waiting for any network call', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    f.client.nativePriceQuote.answer = '123456789000';
    f.client.quoteDepositUsd = () => assert.fail('cached input conversion must not refresh the price');
    f.client.refreshEthUsdPrice = () => assert.fail('cached input conversion must not refresh the price');
    f.wallet.getStatus = () => assert.fail('draft flush must leave checking to the subsequent unit change');
    f.wallet.getDepositFeeQuote = () => assert.fail('draft flush must leave checking to the subsequent unit change');
    assert.equal(await f.flow.setAmount(' 0010.000001 ', 'usd', { check: false, useCachedPrice: true }), true);
    assert.equal(f.flow.intent.inputAmount, '10.000001');
    assert.equal(f.flow.intent.amount, '8100001');
    assert.equal(f.flow.intent.ethAmount, '0.008100001');
    assert.equal(f.flow.intent.depositWei, '8100001000000000');
    assert.equal(f.saved().priceUpdatedAt, 10);
    assert.equal(f.flow.fee, null);
    assert.equal(f.flow.ready, false);
    await assert.rejects(f.flow.verifyReady(), /Wait until/);
});

test('cached USD conversion preserves gwei rounding and rejects unsafe or imprecise amounts', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    const options = { check: false, useCachedPrice: true };
    f.client.quoteDepositUsd = () => assert.fail('cached conversions must not call the remote quote');
    f.client.nativePriceQuote.answer = '123456789000';
    assert.equal(await f.flow.setAmount('0.000001', 'usd', options), true);
    assert.equal(f.saved().amount, '1');
    f.client.nativePriceQuote.answer = '100000000000';
    assert.equal(await f.flow.setAmount('9007199254.740991', 'usd', options), true);
    assert.equal(f.saved().amount, String(Number.MAX_SAFE_INTEGER));
    const original = structuredClone(f.saved());
    for (const value of ['0', '-1', '0.0000001', '1e-3', '9007199254.740992', 'NaN', '', '.', '1'.repeat(129)]) {
        assert.equal(await f.flow.setAmount(value, 'usd', options), false, value);
        assert.deepEqual(f.saved(), original, value);
        assert.equal(f.flow.ready, false, value);
    }
});

test('a cached USD conversion without a valid price fails locally and leaves its saved principal intact', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    const original = structuredClone(f.saved());
    f.client.refreshEthUsdPrice = () => assert.fail('missing cached price must fail without blocking on RPC');
    f.client.quoteDepositUsd = () => assert.fail('missing cached price must fail without blocking on RPC');
    for (const price of [null, { answer: '0', decimals: 8 }, { answer: '100000000000', decimals: 18 }]) {
        f.client.nativePriceQuote = price;
        assert.equal(await f.flow.setAmount('20', 'usd', { check: false, useCachedPrice: true }), false);
        assert.deepEqual(f.saved(), original);
        assert.match(f.flow.error, /price is unavailable/);
        assert.equal(f.flow.ready, false);
    }
});

test('a cached edit wins over an older pending remote USD quote', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    let resolveQuote;
    f.client.quoteDepositUsd = () => new Promise(resolve => { resolveQuote = resolve; });
    const old = f.flow.setAmount('20');
    assert.equal(await f.flow.setAmount('30', 'usd', { check: false, useCachedPrice: true }), true);
    resolveQuote({ amount: '20000000', ethAmount: '0.02', depositWei: '20000000000000000', usdAmount: '20' });
    assert.equal(await old, false);
    assert.equal(f.saved().usdAmount, '30');
    assert.equal(f.saved().amount, '30000000');
    assert.equal(f.flow.ready, false);
});

test('ETH-origin USD reference rounds only its display and never changes the ETH principal on roundtrips', async t => {
    const f = fixture(t);
    f.client.nativePriceQuote.answer = '123456789000';
    await f.flow.start('0.000000001', 'eth');
    assert.equal(await f.flow.setCurrency('usd'), true);
    assert.equal(f.flow.intent.inputAmount, '0.000002');
    assert.equal(f.flow.intent.usdAmount, null);
    assert.equal(f.flow.intent.source, 'eth-input');
    assert.equal(await f.flow.setCurrency('eth'), true);
    assert.equal(f.flow.intent.inputAmount, '0.000000001');
    assert.equal(f.saved().amount, '1');
    assert.equal(f.quotes(), 0);
});

test('ETH-to-USD display conversion uses only a validated cached price and fails immediately when unavailable', async t => {
    const f = fixture(t);
    await f.flow.start('0.01', 'eth');
    f.client.nativePriceQuote = null;
    f.client.refreshEthUsdPrice = () => assert.fail('a currency toggle must not fetch a price');
    assert.equal(await f.flow.setCurrency('usd'), false);
    assert.equal(f.flow.intent.inputCurrency, 'eth');
    assert.match(f.flow.error, /price is unavailable/);
    f.client.nativePriceQuote = { answer: '200000000000', decimals: 8 };
    assert.equal(await f.flow.setCurrency('usd'), true);
    assert.equal(f.flow.intent.inputAmount, '20');
});

test('reopening ETH-origin intent restores its chosen input denomination without repricing', async t => {
    const first = fixture(t);
    await first.flow.start('0.123456789', 'eth');
    await first.flow.setCurrency('usd');
    const f = fixture(t, { saved: first.saved() });
    f.client.nativePriceQuote.answer = '300000000000';
    await f.flow.start('99');
    assert.equal(f.flow.intent.inputCurrency, 'usd');
    assert.equal(f.flow.intent.inputAmount, '123.456789');
    assert.equal(f.flow.intent.amount, '123456789');
    assert.equal(f.quotes(), 0);
    assert.equal(await f.flow.setCurrency('eth'), true);
    assert.equal(f.flow.intent.inputAmount, '0.123456789');
});

test('legacy USD intent migrates input metadata durably before readiness verification', async t => {
    const first = fixture(t);
    await first.flow.start('10');
    const legacy = { ...first.saved() };
    delete legacy.inputCurrency;
    delete legacy.inputAmount;
    const f = fixture(t, { saved: legacy });
    f.setBalance('99000000000000000');
    await f.flow.start();
    assert.equal(f.flow.intent.inputCurrency, 'usd');
    assert.equal(f.saved().inputAmount, '10');
    assert.equal((await f.flow.verifyReady()).amount, legacy.amount);
});

test('prepared deposit can change display currency but cannot edit its principal', async t => {
    const f = fixture(t);
    f.client.config.pending_deposit = { amount: 1234567, funding_quote_available: true };
    await f.flow.start();
    assert.equal(await f.flow.setCurrency('usd'), true);
    assert.equal(f.flow.intent.inputAmount, '1.234567');
    assert.equal(f.flow.intent.source, 'saved-deposit');
    assert.equal(await f.flow.setAmount('0.02', 'eth'), false);
    assert.equal(f.saved().amount, '1234567');
    assert.equal(f.quotes(), 0);
});

test('a currency toggle refuses dirty inputs without silently replacing them', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    f.flow.invalidate();
    assert.equal(await f.flow.setCurrency('eth'), false);
    assert.equal(f.flow.intent.inputCurrency, 'usd');
    assert.equal(f.flow.dirty, true);
});

test('a display toggle cannot overwrite a newer principal saved by another tab', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    const other = { ...f.saved(), usdAmount: '20' };
    await f.store.write(f.flow.scope, other);
    assert.equal(await f.flow.setCurrency('eth'), false);
    assert.deepEqual(f.saved(), other);
    assert.equal(f.flow.intent.inputCurrency, 'usd');
    assert.equal(f.flow.ready, false);
    assert.match(f.flow.error, /another tab/);
});

test('a late display commit cannot replace a newer ETH edit or revive readiness while switching', async t => {
    const f = fixture(t);
    f.setBalance('99000000000000000');
    await f.flow.start('0.01', 'eth');
    const compareAndSwap = f.store.compareAndSwap;
    let finishWrite;
    f.store.compareAndSwap = (scope, expected, value) => new Promise(resolve => {
        finishWrite = async () => resolve(await compareAndSwap(scope, expected, value));
    });
    const toggle = f.flow.setCurrency('usd');
    await new Promise(resolve => setImmediate(resolve));
    await f.flow.check();
    assert.equal(f.flow.ready, false);
    await assert.rejects(f.flow.verifyReady(), /Wait until/);
    const edit = f.flow.setAmount('0.02', 'eth');
    await finishWrite();
    assert.equal(await toggle, false);
    assert.equal(await edit, true);
    assert.equal(f.flow.intent.inputCurrency, 'eth');
    assert.equal(f.saved().amount, '20000000');
});

test('closing before a queued currency commit cannot persist or publish its late result', async t => {
    const f = fixture(t);
    await f.flow.start('0.01', 'eth');
    let resolvePrevious;
    f.flow.writes = new Promise(resolve => { resolvePrevious = resolve; });
    const toggle = f.flow.setCurrency('usd');
    f.flow.stop();
    resolvePrevious();
    assert.equal(await toggle, false);
    assert.equal(f.saved().inputCurrency, 'eth');
    assert.equal(f.flow.ready, false);
});

test('a currency display is published only after durable commit and failed writes do not change it', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    const compareAndSwap = f.store.compareAndSwap;
    let finishWrite;
    f.store.compareAndSwap = (scope, expected, value) => new Promise(resolve => {
        finishWrite = async () => resolve(await compareAndSwap(scope, expected, value));
    });
    const toggle = f.flow.setCurrency('eth');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.flow.intent.inputCurrency, 'usd');
    await finishWrite();
    assert.equal(await toggle, true);
    assert.equal(f.flow.intent.inputCurrency, 'eth');
    f.store.compareAndSwap = async () => { throw new Error('Storage unavailable'); };
    assert.equal(await f.flow.setCurrency('usd'), false);
    assert.equal(f.flow.intent.inputCurrency, 'eth');
    assert.equal(f.saved().inputCurrency, 'eth');
    assert.match(f.flow.error, /Storage unavailable/);
});

test('a paused currency update cannot overwrite another tab editing the deposit before its atomic commit', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    const other = fixture(t);
    other.flow.store = f.store;
    await other.flow.start();
    const compareAndSwap = f.store.compareAndSwap;
    let commitToggle;
    f.store.compareAndSwap = (scope, expected, value) => new Promise(resolve => {
        commitToggle = async () => resolve(await compareAndSwap(scope, expected, value));
    });
    const toggle = f.flow.setCurrency('eth');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await other.flow.setAmount('20'), true);
    await commitToggle();
    assert.equal(await toggle, false);
    assert.equal(f.saved().amount, '20000000');
    assert.equal(f.saved().inputCurrency, 'usd');
    assert.match(f.flow.error, /another tab/);
    assert.equal(f.flow.ready, false);
});

test('legacy metadata migration cannot overwrite a principal updated after its initial read', async t => {
    const first = fixture(t);
    await first.flow.start('10');
    const legacy = { ...first.saved() };
    delete legacy.inputCurrency;
    delete legacy.inputAmount;
    const latest = { ...first.saved(), amount: '20000000', ethAmount: '0.02',
        depositWei: '20000000000000000', usdAmount: '20', inputAmount: '20' };
    const f = fixture(t, { saved: legacy });
    const compareAndSwap = f.store.compareAndSwap;
    f.store.compareAndSwap = async (scope, expected, value) => {
        await f.store.write(scope, latest);
        return compareAndSwap(scope, expected, value);
    };
    await f.flow.start();
    assert.deepEqual(f.saved(), latest);
    assert.equal(f.flow.intent, null);
    assert.equal(f.flow.ready, false);
    assert.match(f.flow.error, /another tab/);
});

test('restoring a prepared SDK deposit cannot overwrite a concurrent host intent update', async t => {
    const f = fixture(t);
    f.client.config.pending_deposit = { amount: 1234567, funding_quote_available: true };
    const compareAndSwap = f.store.compareAndSwap;
    const concurrent = { version: 1, scope: '11155111:0xvault:0xaccount',
        amount: '20000000', ethAmount: '0.02', depositWei: '20000000000000000',
        usdAmount: '20', inputCurrency: 'usd', inputAmount: '20' };
    f.store.compareAndSwap = async (scope, expected, value) => {
        assert.equal(expected, null);
        await f.store.write(scope, concurrent);
        return compareAndSwap(scope, expected, value);
    };
    await f.flow.start();
    assert.deepEqual(f.saved(), concurrent);
    assert.equal(f.flow.intent, null);
    assert.equal(f.flow.ready, false);
    assert.match(f.flow.error, /another tab/);
});

test('currency changes fail closed if atomic storage is unavailable rather than falling back to unsafe writes', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    const original = structuredClone(f.saved());
    delete f.store.compareAndSwap;
    f.store.write = () => assert.fail('display changes must never use an unconditional write');
    assert.equal(await f.flow.setCurrency('eth'), false);
    assert.deepEqual(f.saved(), original);
    assert.equal(f.flow.ready, false);
    assert.match(f.flow.error, /Safe deposit storage is unavailable/);
});

test('tampered currency metadata fails closed instead of showing a mismatched ETH input', async t => {
    const first = fixture(t);
    await first.flow.start('0.01', 'eth');
    for (const metadata of [{ inputAmount: '0.02' }, { inputCurrency: 'other' }, { inputCurrency: 'usd', inputAmount: '0' }]) {
        const f = fixture(t, { saved: { ...first.saved(), ...metadata } });
        await f.flow.start();
        assert.equal(f.flow.intent, null);
        assert.equal(f.flow.ready, false);
        assert.match(f.flow.error, /saved deposit input/);
    }
});

test('a draft typed while address storage is loading wins over saved restoration', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    const saved = structuredClone(f.saved());
    f.flow.stop();
    let read;
    f.store.read = () => new Promise(resolve => { read = resolve; });
    const loading = f.flow.start('10');
    await new Promise(resolve => setImmediate(resolve));
    f.flow.invalidate();
    f.flow.requestedAmount = { value: '0.000000001', currency: 'eth' };
    read(saved);
    await loading;
    assert.equal(f.flow.intent.amount, '1');
    assert.equal(f.flow.intent.inputCurrency, 'eth');
    assert.equal(f.saved().amount, '1');
});

test('an expired fee hides payment instructions before awaiting a stalled replacement quote', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    f.setBalance(f.flow.totalWei);
    await f.flow.check();
    assert.equal(f.flow.ready, true);
    f.advance(30_001);
    let finish;
    f.wallet.getDepositFeeQuote = () => new Promise(resolve => { finish = resolve; });
    let invalidations = 0;
    f.flow.changed = () => {
        if (f.flow.fee === null) {
            invalidations++;
            assert.equal(f.flow.totalWei, null);
            assert.equal(f.flow.ready, false);
        }
    };
    const checking = f.flow.check();
    assert.equal(invalidations, 1, 'render invalidation precedes RPC completion');
    assert.equal(f.flow.remainingWei, null);
    await assert.rejects(f.flow.verifyReady(), /Wait until/);
    finish(null);
    await checking;
    assert.equal(f.flow.ready, false);
    assert.equal(f.flow.fee, null);
});

test('quote expiry invalidates readiness while a balance-only RPC remains unresolved', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t);
    await f.flow.start('10');
    f.setBalance(f.flow.totalWei);
    await f.flow.check();
    const quoteReads = f.feeQuotes();
    let finish;
    f.wallet.getStatus = () => new Promise(resolve => { finish = resolve; });
    const checking = f.flow.check();
    assert.equal(f.feeQuotes(), quoteReads, 'a fresh cached fee starts only a balance read');
    let expiryEvents = 0;
    f.flow.changed = event => { if (event?.expired) expiryEvents++; };
    f.advance(30_001);
    t.mock.timers.tick(30_001);
    assert.equal(expiryEvents, 1);
    assert.equal(f.flow.fee, null);
    assert.equal(f.flow.remainingWei, null);
    assert.equal(f.flow.ready, false);
    finish({ ethBalance: '999999999999999999' });
    await checking;
    assert.equal(f.flow.ready, false, 'a late read cannot restore an expired quote');
});

test('editing and stopping cancel the quote expiry callback', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t);
    await f.flow.start('10');
    let expired = 0;
    f.flow.changed = event => { if (event?.expired) expired++; };
    f.flow.invalidate();
    assert.equal(f.flow.quoteExpiryTimer, null);
    f.advance(30_001);
    t.mock.timers.tick(30_001);
    assert.equal(expired, 0);
    await f.flow.setAmount('0.01', 'eth');
    f.flow.stop();
    assert.equal(f.flow.quoteExpiryTimer, null);
    f.advance(30_001);
    t.mock.timers.tick(30_001);
    assert.equal(expired, 0);
});

test('a quote refresh starts before expiry and keeps the last public estimate until replacement', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    const original = f.flow.displayQuote;
    f.advance(20_001);
    let finish;
    const quote = f.wallet.getDepositFeeQuote.bind(f.wallet);
    f.wallet.getDepositFeeQuote = () => new Promise(resolve => { finish = resolve; });
    const checking = f.flow.check();
    assert.equal(typeof finish, 'function', 'refresh begins while the old quote is still valid');
    assert.equal(f.flow.displayQuote, original);
    const replacement = await quote(f.flow.intent);
    finish(replacement);
    await checking;
    assert.equal(f.flow.displayQuote, replacement);
    f.advance(30_001);
    const stalled = f.flow.check();
    assert.equal(f.flow.fee, null, 'expired quote cannot authorize a deposit');
    assert.equal(f.flow.displayQuote, replacement, 'public estimate survives a stalled read');
    assert.equal(f.flow.ready, false);
    finish(null);
    await stalled;
    assert.equal(f.flow.displayQuote, replacement, 'details survive a failed refresh');
    assert.ok(f.flow.error);
    f.flow.invalidate();
    assert.equal(f.flow.displayQuote, null, 'editing removes an estimate for the old principal');
});

test('a USD quote that fails after an edit is retried on the next poll instead of staying dirty', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    assert.equal(f.flow.dirty, false);
    const quote = f.client.quoteDepositUsd;
    f.client.quoteDepositUsd = async () => { throw new Error('Temporary price read failure.'); };
    // The controls set requestedAmount on input before the debounced setAmount.
    f.flow.invalidate();
    f.flow.requestedAmount = { value: '12', currency: 'usd' };
    assert.equal(await f.flow.setAmount('12', 'usd'), false);
    assert.equal(f.flow.dirty, true);
    assert.match(f.flow.error, /Temporary/);
    // check() ignores a dirty flow, so the poll has to re-run the quote.
    const quotesBefore = f.quotes();
    f.client.quoteDepositUsd = quote;
    const originalSetTimeout = globalThis.setTimeout;
    let scheduled;
    globalThis.setTimeout = (callback, delay) => { scheduled = { callback, delay }; return originalSetTimeout(() => {}, 0); };
    try { f.flow.schedule(); } finally { globalThis.setTimeout = originalSetTimeout; }
    assert.equal(scheduled.delay, 60_000);
    f.flow.schedule = () => {};
    await scheduled.callback();
    assert.equal(f.quotes(), quotesBefore + 1, 'the requested amount was quoted again');
    assert.equal(f.flow.dirty, false);
    assert.equal(f.flow.error, '');
    assert.equal(f.flow.intent.usdAmount, '12');
});

test('the poll leaves a clean in-progress edit alone', async t => {
    const f = fixture(t);
    await f.flow.start('10');
    f.flow.invalidate();
    f.flow.requestedAmount = { value: '12', currency: 'usd' };
    const quotesBefore = f.quotes();
    const originalSetTimeout = globalThis.setTimeout;
    let scheduled;
    globalThis.setTimeout = (callback) => { scheduled = callback; return originalSetTimeout(() => {}, 0); };
    try { f.flow.schedule(); } finally { globalThis.setTimeout = originalSetTimeout; }
    f.flow.schedule = () => {};
    await scheduled();
    assert.equal(f.quotes(), quotesBefore, 'no quote while the debounce still owns the edit');
    assert.equal(f.flow.dirty, true);
});
