import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressDepositFlow } from '../../chat/zkapi/services/addressDepositFlow.mjs';

// A version that no longer accepts deposits must end the Send Ethereum deposit
// flow instead of polling it. Every poll would ask the SDK for a prepared plan,
// and a prepared plan is saved in the browser wallet.

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Polls until `condition` holds, so a loaded machine cannot fail a test that
// only needs "eventually".
async function until(condition, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) await pause(5);
}

function closedError(data = { versionId: 'v1', successorId: 'v2', closedSince: 1_700_000_000_000 }) {
    return Object.assign(new Error('Deposits moved to another version.'), { code: 'deposits_closed', status: 409, data });
}

function fixture(t, options = {}) {
    let saved = options.saved || null;
    let balance = '0';
    const counts = { ensureAddress: 0, status: 0, feeQuote: 0, usdQuote: 0, writes: 0, changed: 0 };
    let now = 12_000;
    const client = {
        isNativeEthFunding: true,
        config: { funding: { chain_id: 11155111, contract_address: '0xVAULT' }, ...(options.config || {}) },
        nativePriceQuote: { answer: '100000000000', decimals: 8, updated_at: 10 },
        async quoteDepositUsd(usd) {
            counts.usdQuote++;
            if (options.quote) return options.quote(usd);
            return { amount: `${usd}000000`, ethAmount: `0.${usd.padStart(3, '0')}`,
                depositWei: `${usd}000000000000000`, usdAmount: usd, priceUpdatedAt: 10 };
        }
    };
    const wallet = {
        hasPendingTransaction: false,
        async ensureAddress() { counts.ensureAddress++; return '0xACCOUNT'; },
        async getStatus() { counts.status++; return { ethBalance: balance }; },
        async getDepositFeeQuote(intent) {
            counts.feeQuote++;
            if (options.feeQuote) return options.feeQuote(intent, counts.feeQuote);
            return { expectedFeeWei: '600000000000000', requiredFeeWei: '800000000000000', feeBufferWei: '200000000000000',
                feeReserveWei: '1000000000000000', amount: intent.amount, depositWei: intent.depositWei,
                address: '0xACCOUNT', chainId: 11155111, contractAddress: '0xVAULT',
                operationId: 'operation-1', depositCommitment: 'commitment-1', quotedAt: now, expiresAt: now + 30_000 };
        }
    };
    const store = {
        async read() { return structuredClone(saved); },
        async write(_scope, value) { counts.writes++; saved = structuredClone(value); },
        async compareAndSwap(_scope, expected, value) {
            if (JSON.stringify(saved) !== JSON.stringify(expected)) return false;
            saved = structuredClone(value);
            return true;
        }
    };
    const gate = { current: options.gate ?? null };
    const flow = new AddressDepositFlow({ wallet, client, store, interval: options.interval ?? 5, now: () => now,
        changed: () => { counts.changed++; },
        ...(options.gate !== undefined ? { depositGate: () => gate.current } : {}) });
    t.after(() => flow.stop());
    return { flow, wallet, client, store, counts, gate, setBalance(value) { balance = value; }, saved: () => saved };
}

const CLOSED_GATE = { canStart: false, canResume: false, code: 'deposits_closed', successor: { id: 'v2', label: 'Version 2' } };
const OPEN_GATE = { canStart: true, canResume: false, code: null, successor: null };

test('a closed refusal of the fee quote ends the flow: one attempt, no retry, closed state surfaced', async t => {
    const f = fixture(t, { feeQuote() { throw closedError(); } });
    await f.flow.start('10');
    assert.equal(f.counts.feeQuote, 1);
    assert.deepEqual(f.flow.closed, { code: 'deposits_closed', gateCode: 'deposits_closed', versionId: 'v1',
        successorId: 'v2', closedSince: 1_700_000_000_000 });
    assert.equal(f.flow.running, false);
    assert.equal(f.flow.timer, null);
    assert.equal(f.flow.ready, false);
    assert.equal(f.flow.fee, null);
    assert.equal(f.flow.displayQuote, null);
    assert.equal(f.flow.error, 'Deposits moved to another version.');
    // No retry storm: several poll intervals later nothing has been asked again.
    await pause(60);
    assert.deepEqual({ status: f.counts.status, feeQuote: f.counts.feeQuote, usdQuote: f.counts.usdQuote },
        { status: 1, feeQuote: 1, usdQuote: 1 });
    // The flow is finished: Deposit cannot be authorized from it, and the
    // answer is the closed reason (in the shape of the host's own refusal),
    // never "wait for more ETH".
    await assert.rejects(f.flow.verifyReady(), error => {
        assert.equal(error.message, 'Deposits moved to another version.');
        assert.equal(error.code, 'deposits_closed');
        assert.equal(error.status, 409);
        assert.deepEqual(error.data, { gateCode: 'deposits_closed', versionId: 'v1', successorId: 'v2', closedSince: 1_700_000_000_000 });
        return true;
    });
    assert.equal(f.counts.feeQuote, 1, 'answering verifyReady asks for no quote');
});

test('verifyReady on a flow the gate closed before it started names the closed reason too', async t => {
    const f = fixture(t, { gate: CLOSED_GATE });
    await f.flow.start('10');
    await assert.rejects(f.flow.verifyReady(), error => error.code === 'deposits_closed'
        && /no longer accepts new deposits/.test(error.message) && error.data.successorId === 'v2');
    assert.deepEqual({ ensureAddress: f.counts.ensureAddress, feeQuote: f.counts.feeQuote }, { ensureAddress: 0, feeQuote: 0 });
});

test('the SDK\'s own deposits_closed refusal is recognized by its code and shows plain text without data', async t => {
    const f = fixture(t, { feeQuote() { throw Object.assign(new Error(''), { code: 'deposits_closed', status: 409 }); } });
    await f.flow.start('10');
    assert.equal(f.counts.feeQuote, 1);
    assert.equal(f.flow.closed.code, 'deposits_closed');
    assert.equal(f.flow.closed.versionId, null);
    assert.equal(f.flow.closed.successorId, null);
    assert.match(f.flow.error, /no longer accepts new deposits/);
    await pause(30);
    assert.equal(f.counts.feeQuote, 1);
});

test('only the closed refusal is final: other quote failures keep retrying on the poll cadence', async t => {
    let failures = 2;
    const f = fixture(t, { feeQuote(intent) {
        if (failures-- > 0) throw new Error('The payment network could not complete this request.');
        return { expectedFeeWei: '600000000000000', requiredFeeWei: '800000000000000', feeBufferWei: '200000000000000',
            feeReserveWei: '1000000000000000', amount: intent.amount, depositWei: intent.depositWei,
            address: '0xACCOUNT', chainId: 11155111, contractAddress: '0xVAULT',
            operationId: 'operation-1', depositCommitment: 'commitment-1', quotedAt: 12_000, expiresAt: 42_000 };
    } });
    await f.flow.start('10');
    assert.equal(f.flow.closed, null);
    assert.match(f.flow.error, /payment network/);
    await until(() => f.counts.feeQuote >= 3 && f.flow.error === '');
    assert.ok(f.counts.feeQuote >= 3, `retried (${f.counts.feeQuote})`);
    assert.equal(f.flow.closed, null);
    assert.equal(f.flow.error, '');
});

test('a gate that is closed before the flow starts prevents every address, amount and quote request', async t => {
    const f = fixture(t, { gate: CLOSED_GATE });
    await f.flow.start('10');
    assert.deepEqual(f.counts, { ensureAddress: 0, status: 0, feeQuote: 0, usdQuote: 0, writes: 0, changed: 1 });
    assert.equal(f.saved(), null, 'no amount draft is written for a version that cannot deposit');
    assert.deepEqual(f.flow.closed, { code: 'deposits_closed', gateCode: 'deposits_closed', versionId: null, successorId: 'v2',
        closedSince: null });
    assert.equal(f.flow.running, false);
    assert.match(f.flow.error, /no longer accepts new deposits/);
    await pause(30);
    assert.equal(f.counts.status + f.counts.feeQuote + f.counts.usdQuote, 0);
});

test('a gate that closes while the flow polls ends it before the next quote', async t => {
    const f = fixture(t, { gate: OPEN_GATE, interval: 10 });
    await f.flow.start('10');
    assert.equal(f.counts.feeQuote, 1);
    assert.equal(f.flow.closed, null);
    f.gate.current = { ...CLOSED_GATE, code: 'stale_build', successor: null };
    await pause(60);
    assert.equal(f.counts.feeQuote, 1, 'no quote after the gate closed');
    assert.equal(f.flow.closed.gateCode, 'stale_build');
    assert.equal(f.flow.running, false);
    assert.equal(f.flow.ready, false);
    assert.equal(f.flow.timer, null);
});

test('a deposit that already started may resume although new deposits are closed', async t => {
    const f = fixture(t, { gate: { ...CLOSED_GATE, canResume: true } });
    await f.flow.start('10');
    assert.equal(f.flow.closed, null);
    assert.equal(f.counts.feeQuote, 1);
    assert.equal(f.flow.running, true);
});

test('an installed gate must explicitly allow: anything else closes the flow', async t => {
    // Falsy and non-object answers are refusals, not "no gate": only exactly
    // null or undefined means none is installed.
    const answers = [{}, { canStart: 'yes' }, { canStart: false }, { canStart: 1, canResume: 1 },
        false, 0, '', true, 'allow', [], NaN, () => OPEN_GATE];
    for (const gate of answers) {
        const label = `${typeof gate}:${String(typeof gate === 'object' ? JSON.stringify(gate) : gate)}`;
        const f = fixture(t, { gate });
        await f.flow.start('10');
        assert.notEqual(f.flow.closed, null, label);
        assert.equal(f.flow.running, false, label);
        assert.equal(f.counts.feeQuote, 0, label);
        assert.equal(f.counts.ensureAddress, 0, label);
    }
});

test('a falsy but installed gate answer closes a running flow: only null or undefined is no gate', async t => {
    for (const answer of [false, 0, '']) {
        const f = fixture(t, { gate: OPEN_GATE });
        await f.flow.start('10');
        assert.equal(f.flow.running, true);
        f.gate.current = answer;
        assert.notEqual(f.flow.gateRefusal(), null, `gateRefusal(${JSON.stringify(answer)})`);
        assert.equal(f.flow.closeIfRefused(), true, `closeIfRefused(${JSON.stringify(answer)})`);
        assert.notEqual(f.flow.closed, null);
        assert.equal(f.flow.running, false);
        assert.equal(f.flow.timer, null);
    }
    for (const answer of [null, undefined]) {
        const f = fixture(t, { gate: OPEN_GATE });
        await f.flow.start('10');
        f.gate.current = answer;
        assert.equal(f.flow.gateRefusal(), null);
        assert.equal(f.flow.closeIfRefused(), false);
        assert.equal(f.flow.closed, null);
        assert.equal(f.flow.running, true);
    }
});

test('a gate that throws, or an allow that is not strictly true, refuses', async t => {
    const f = fixture(t, { gate: OPEN_GATE });
    f.flow.depositGate = () => { throw new Error('gate failed'); };
    assert.equal(f.flow.closeIfRefused(), true);
    assert.equal(f.flow.closed.gateCode, null);
    for (const answer of [{ canStart: 'true' }, { canStart: 1 }, { canResume: 'true' }, { canStart: [true] }]) {
        const flow = fixture(t, { gate: answer }).flow;
        assert.equal(flow.closeIfRefused(), true, JSON.stringify(answer));
    }
});

test('a refused USD quote ends the flow when the gate is what refused it', async t => {
    const f = fixture(t, { gate: OPEN_GATE, interval: 10,
        quote() { f.gate.current = CLOSED_GATE; throw closedError(); } });
    await f.flow.start('10');
    assert.notEqual(f.flow.closed, null);
    assert.equal(f.flow.running, false);
    await pause(50);
    assert.equal(f.counts.usdQuote, 1, 'the refused quote is not retried');
    assert.equal(f.counts.feeQuote, 0);
});

test('without versioning there is no gate and nothing changes', async t => {
    const f = fixture(t);
    f.setBalance('11000000000000000');
    await f.flow.start('10');
    assert.equal(f.flow.closed, null);
    assert.equal(f.flow.ready, true);
    assert.equal(f.counts.feeQuote, 1);
});

test('the default gate is the facade attached to the SDK client', async t => {
    let open = false;
    const f = fixture(t, { config: {} });
    f.client.oaVersioning = { depositGate: () => (open ? OPEN_GATE : CLOSED_GATE) };
    // The default reads the client's facade at call time.
    const flow = new AddressDepositFlow({ wallet: f.wallet, client: f.client, store: f.store, interval: 60_000, now: () => 12_000 });
    t.after(() => flow.stop());
    await flow.start('10');
    assert.equal(flow.closed.successorId, 'v2');
    assert.equal(f.counts.feeQuote, 0);
    open = true;
    await flow.start('10');
    assert.equal(flow.closed, null, 'a later start re-reads the gate and clears the closed state');
    assert.equal(f.counts.feeQuote, 1);
});

test('a closed flow cannot be revived by an in-flight read', async t => {
    const f = fixture(t, { gate: OPEN_GATE });
    await f.flow.start('10');
    let resolveStatus;
    f.wallet.getStatus = () => new Promise(resolve => { resolveStatus = resolve; });
    const pending = f.flow.check();
    f.gate.current = CLOSED_GATE;
    f.flow.closeIfRefused();
    resolveStatus({ ethBalance: '99000000000000000' });
    await pending;
    assert.equal(f.flow.ready, false);
    assert.equal(f.flow.fee, null);
    assert.notEqual(f.flow.closed, null);
});

// ---------------------------------------------------------------------------
// Reopening a closed flow
// ---------------------------------------------------------------------------

test('reopenIfAllowed restarts a closed flow only when the gate now explicitly allows', async t => {
    const f = fixture(t, { gate: CLOSED_GATE, interval: 60_000 });
    await f.flow.start('10');
    assert.notEqual(f.flow.closed, null);
    const quiet = () => ({ ensureAddress: f.counts.ensureAddress, status: f.counts.status, feeQuote: f.counts.feeQuote,
        usdQuote: f.counts.usdQuote, writes: f.counts.writes });
    const events = f.counts.changed;
    const before = quiet();

    // A gate that is still closed, or that does not strictly allow, changes nothing.
    for (const answer of [CLOSED_GATE, false, 0, '', {}, { canStart: 'yes' }, { canStart: 1 }]) {
        f.gate.current = answer;
        assert.equal(await f.flow.reopenIfAllowed(), false, JSON.stringify(answer));
        assert.notEqual(f.flow.closed, null);
        assert.equal(f.flow.running, false);
    }
    assert.deepEqual(quiet(), before);
    assert.equal(f.counts.changed, events, 'a gate that stays closed does not re-render the flow');

    // The gate reopens: closed clears at once and the flow runs again.
    f.gate.current = OPEN_GATE;
    const reopening = f.flow.reopenIfAllowed();
    assert.equal(f.flow.closed, null, 'cleared before the restart settles');
    assert.equal(await reopening, true);
    assert.equal(f.flow.running, true);
    assert.equal(f.counts.feeQuote, 1);
    assert.equal(f.flow.error, '');
    assert.notEqual(f.flow.timer, null, 'polling resumes');
});

test('reopenIfAllowed also reopens for a deposit that may only resume', async t => {
    const f = fixture(t, { gate: CLOSED_GATE });
    await f.flow.start('10');
    f.gate.current = { ...CLOSED_GATE, canResume: true };
    assert.equal(await f.flow.reopenIfAllowed(), true);
    assert.equal(f.flow.closed, null);
    assert.equal(f.counts.feeQuote, 1);
});

test('a reopened flow starts again with the amount it last asked for, and a flow that is not closed is left alone', async t => {
    const f = fixture(t, { gate: OPEN_GATE, interval: 10 });
    const starts = [];
    const start = f.flow.start.bind(f.flow);
    f.flow.start = (...args) => { starts.push(args); return start(...args); };
    await f.flow.start('30');
    assert.equal(f.flow.intent.usdAmount, '30');
    starts.length = 0;

    // Running and not closed: nothing to reopen, nothing restarted.
    assert.equal(await f.flow.reopenIfAllowed(), false);
    assert.deepEqual(starts, []);

    f.gate.current = CLOSED_GATE;
    await until(() => f.flow.closed !== null);
    assert.equal(f.flow.running, false);
    f.gate.current = OPEN_GATE;
    assert.equal(await f.flow.reopenIfAllowed(), true);
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].slice(0, 2), ['30', 'usd']);
    assert.equal(f.flow.intent.usdAmount, '30');
    assert.equal(f.flow.closed, null);
});

test('reopenIfAllowed starts one flow even when called twice', async t => {
    const f = fixture(t, { gate: CLOSED_GATE });
    await f.flow.start('10');
    f.gate.current = OPEN_GATE;
    const first = f.flow.reopenIfAllowed();
    assert.equal(await f.flow.reopenIfAllowed(), false, 'the second call finds a running flow');
    assert.equal(await first, true);
    assert.equal(f.counts.feeQuote, 1);
});

test('a reopened flow that the gate closes again ends closed, and reports that it did not stay open', async t => {
    const f = fixture(t, { gate: CLOSED_GATE });
    await f.flow.start('10');
    // The gate allows when asked first and refuses on the start's own read.
    let answers = [OPEN_GATE, CLOSED_GATE];
    f.flow.depositGate = () => answers.length > 1 ? answers.shift() : answers[0];
    assert.equal(await f.flow.reopenIfAllowed(), false);
    assert.notEqual(f.flow.closed, null);
    assert.equal(f.flow.running, false);
    assert.equal(f.counts.feeQuote, 0);
});
