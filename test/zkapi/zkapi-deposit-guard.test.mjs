// The deposit guard over the REAL legacy ZkapiClient and BrowserWalletRuntime
// classes. Only the I/O boundaries are replaced: the wallet provider, fetch,
// and the first awaited collaborator of each entry point (init,
// ensureTestnetAccess, refreshEthUsdPrice), which here opens the real legacy
// wallet store over the fake IndexedDB so "no IDB access" is a measurement and
// not an absence of wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { ZkapiClient } from '@openanonymity/zkapi-browser-sdk/client';
import legacyClient from '@openanonymity/zkapi-browser-sdk/client';
import legacyRuntime, { BrowserWalletRuntime } from '@openanonymity/zkapi-browser-sdk/runtime';
import {
    DepositsClosedError, depositMethodNames, installDepositGuard, unclassifiedDepositEntryPoints,
    unclassifiedDepositMethods
} from '../../chat/zkapi/versioning/depositGuard.mjs';
import { installActiveVersion, resetActiveVersionForTests } from '../../chat/zkapi/versioning/activeVersion.mjs';
import { noteBoundV1 } from '../../chat/zkapi/versioning/adapters/noteBoundV1.mjs';
import { concessionV1 } from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { createFakeEnvironment } from './_fakeIndexedDb.mjs';

const DEPLOYMENT = 'zkapi-native-eth-sepolia-note-bound-v1-fresh-20260930';
const FROM = '0x00000000000000000000000000000000000000aa';
const HASH = `0x${'11'.repeat(32)}`;
const SENTINEL = new Error('reached the real method');
const here = path.dirname(fileURLToPath(import.meta.url));
const legacyStorePath = fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/store'));
let storeInstance = 0;

const startedPlan = (overrides = {}) => ({
    operationId: 'op-started', phase: 'submitted', amount: 100, secret: 'PLAN-SECRET', commitment: '0x01',
    next_note_id: 3, active_root: '0x02', zero_path: ['0x03'], submissionId: 'claim-1',
    transactionHash: HASH, ...overrides
});
const unsentPlan = (overrides = {}) => ({
    operationId: 'op-unsent', phase: 'prepared', amount: 100, secret: 'PLAN-SECRET', commitment: '0x01',
    next_note_id: 3, active_root: '0x02', zero_path: ['0x03'], ...overrides
});

const CLOSED = { canStart: false, canResume: false, code: 'deposits_closed', successor: { id: 'v2', label: 'Version 2' } };
const OPEN = { canStart: true, canResume: false, code: null, successor: null };
const VERSION = { id: 'v1', label: 'Version 1', status: 'exit-only', depositsClosedSince: Date.parse('2026-11-01T00:00:00Z') };

// A real client and runtime of the installed legacy SDK, with their first
// awaited collaborators replaced by recorders. `touched` is the ordered list
// of boundaries a call crossed.
async function harness(t, { gate = CLOSED, slot = null } = {}) {
    const env = createFakeEnvironment();
    const restoreEnvironment = env.install();
    const fetchCalls = [];
    t.mock.method(globalThis, 'fetch', async url => { fetchCalls.push(String(url)); throw SENTINEL; });
    const store = await import(`${pathToFileURL(legacyStorePath).href}?guard=${++storeInstance}`);
    const touched = [];
    const reach = name => async () => {
        touched.push(name);
        // The real store opens the fake database: a measurable IDB access.
        await store.readBrowserWallet();
        throw SENTINEL;
    };
    const client = new ZkapiClient();
    const runtime = new BrowserWalletRuntime();
    runtime.manifest = { deployment_id: DEPLOYMENT };
    runtime.runtime = slot;
    runtime.init = reach('runtime.init');
    client.init = reach('client.init');
    client.ensureTestnetAccess = reach('client.ensureTestnetAccess');
    client.refreshEthUsdPrice = reach('client.refreshEthUsdPrice');
    // Replacing these makes any use observable without breaking the call.
    runtime.pendingDeposit = async () => { touched.push('runtime.pendingDeposit'); throw SENTINEL; };
    runtime.reload = async () => { touched.push('runtime.reload'); throw SENTINEL; };
    runtime.commit = async () => { touched.push('runtime.commit'); throw SENTINEL; };
    client.setWalletProvider({ request: async () => { touched.push('wallet'); throw SENTINEL; } });

    const state = { gate };
    const uninstall = installDepositGuard({
        client, runtime, adapter: noteBoundV1, getGate: () => state.gate, version: VERSION
    });
    t.after(() => {
        uninstall();
        restoreEnvironment();
    });
    return { client, runtime, env, touched, fetchCalls, state, uninstall };
}

// Every guarded entry point with arguments a caller would plausibly pass.
const CALLS = {
    client: {
        quoteDepositUsd: client => client.quoteDepositUsd('25'),
        prepareDepositQuote: client => client.prepareDepositQuote('0.0000001', { from: FROM }),
        deposit: client => client.deposit('0.0000001', () => {}, { preparedOperationId: 'op-started' }),
        performDeposit: client => client.performDeposit('0.0000001', () => {}, { preparedOperationId: 'op-started' })
    },
    runtime: {
        prepareDepositQuote: runtime => runtime.prepareDepositQuote(100, '0xroot'),
        prepareDeposit: runtime => runtime.prepareDeposit(100, { preparedOperationId: 'op-started' })
    }
};

function assertNoAccess(h) {
    assert.deepEqual(h.touched, [], 'no collaborator was reached');
    assert.deepEqual(h.fetchCalls, [], 'no network request was made');
    assert.equal(h.env.idb.log.length, 0, 'IndexedDB was never opened');
    assert.deepEqual(h.env.idb.committedWrites(), []);
    assert.equal(h.env.trace.filter(entry => entry.type === 'lock-acquire').length, 0, 'no wallet lock was taken');
}

test('the adapter names exactly the entry points the test exercises', () => {
    assert.deepEqual(Object.keys(CALLS.client).sort(), [...noteBoundV1.depositEntryPoints.client].sort());
    assert.deepEqual(Object.keys(CALLS.runtime).sort(), [...noteBoundV1.depositEntryPoints.runtime].sort());
});

for (const side of ['client', 'runtime']) {
    for (const name of Object.keys(CALLS[side])) {
        test(`closed version: ${side}.${name} refuses before any RPC, IDB write, lock or wallet call`, async t => {
            const h = await harness(t);
            await assert.rejects(CALLS[side][name](h[side]), error => {
                assert.ok(error instanceof DepositsClosedError);
                assert.equal(error.code, 'deposits_closed');
                assert.equal(error.status, 409);
                assert.deepEqual(error.data, {
                    versionId: 'v1', successorId: 'v2', closedSince: VERSION.depositsClosedSince, gateCode: 'deposits_closed'
                });
                return true;
            });
            assertNoAccess(h);
        });

        test(`open gate: ${side}.${name} reaches the real method`, async t => {
            const h = await harness(t, { gate: OPEN });
            await assert.rejects(CALLS[side][name](h[side]), error => error === SENTINEL);
            assert.ok(h.touched.length > 0, 'the real method ran');
            assert.ok(h.env.idb.log.length > 0, 'and its first collaborator reached IndexedDB');
        });
    }
}

test('the refusal reads in plain language and names no internals', async t => {
    const h = await harness(t);
    await assert.rejects(h.client.deposit('1'), error => {
        assert.equal(error.message, 'Deposits moved to version 2. This page is on version 1, which no longer accepts new deposits.');
        assert.doesNotMatch(error.message, /nullifier|vault|circuit|deployment|note \d/i);
        return true;
    });
});

test('a started deposit stays completable: same amount, same operation', async t => {
    const h = await harness(t, { slot: { pendingDeposit: startedPlan() } });
    // The wallet session was already open: finish through the deposit path.
    await assert.rejects(h.client.deposit('0.0000001', () => {}, { preparedOperationId: 'op-started' }),
        error => error === SENTINEL);
    assert.deepEqual(h.touched.slice(0, 1), ['client.ensureTestnetAccess']);
    await assert.rejects(h.client.performDeposit('0.0000001'), error => error === SENTINEL);
    await assert.rejects(h.client.prepareDepositQuote('0.0000001', { from: FROM }), error => error === SENTINEL);
    await assert.rejects(h.runtime.prepareDeposit(100, { preparedOperationId: 'op-started' }), error => error === SENTINEL);
    await assert.rejects(h.runtime.prepareDeposit(100), error => error === SENTINEL, 'no operation named: the amount still binds');
    await assert.rejects(h.runtime.prepareDepositQuote(100, '0xroot'), error => error === SENTINEL);
});

test('a USD price quote carries no plan amount and passes only while a started deposit exists', async t => {
    const started = await harness(t, { slot: { pendingDeposit: startedPlan() } });
    await assert.rejects(started.client.quoteDepositUsd('25'), error => error === SENTINEL);
    const none = await harness(t, { slot: null });
    await assert.rejects(none.client.quoteDepositUsd('25'), error => error instanceof DepositsClosedError);
});

test('a started deposit is refused when the amount or the prepared operation changes', async t => {
    const h = await harness(t, { slot: { pendingDeposit: startedPlan() } });
    for (const call of [
        () => h.client.deposit('0.0000002', () => {}, { preparedOperationId: 'op-started' }),
        () => h.client.deposit('0.0000001', () => {}, { preparedOperationId: 'another-operation' }),
        () => h.client.performDeposit('1'),
        () => h.client.prepareDepositQuote('0.0000002', { from: FROM }),
        () => h.runtime.prepareDeposit(200, { preparedOperationId: 'op-started' }),
        () => h.runtime.prepareDeposit(100, { preparedOperationId: 'another-operation' }),
        () => h.runtime.prepareDepositQuote(101, '0xroot')
    ]) {
        await assert.rejects(call(), error => error instanceof DepositsClosedError);
    }
    assertNoAccess(h);
});

test('an unreadable amount never matches a started deposit', async t => {
    const h = await harness(t, { slot: { pendingDeposit: startedPlan() } });
    for (const value of ['abc', '', '1e3', '0.0000000001', '-1', '9'.repeat(40)]) {
        await assert.rejects(h.client.deposit(value), error => error instanceof DepositsClosedError, JSON.stringify(value));
    }
    await assert.rejects(h.runtime.prepareDeposit('nope'), error => error instanceof DepositsClosedError);
    assertNoAccess(h);
});

test('a prepared plan that was never sent is not a deposit to finish', async t => {
    const h = await harness(t, { slot: { pendingDeposit: unsentPlan() } });
    await assert.rejects(h.client.deposit('0.0000001', () => {}, { preparedOperationId: 'op-unsent' }),
        error => error instanceof DepositsClosedError);
    await assert.rejects(h.runtime.prepareDeposit(100, { preparedOperationId: 'op-unsent' }),
        error => error instanceof DepositsClosedError);
    await assert.rejects(h.client.prepareDepositQuote('0.0000001', { from: FROM }),
        error => error instanceof DepositsClosedError);
    assertNoAccess(h);
});

for (const [label, change] of [
    ['a submission claim', { submissionId: 'claim', transactionHash: undefined }],
    ['a transaction hash', { submissionId: undefined, transactionHash: HASH }],
    ['transaction hashes', { submissionId: undefined, transactionHash: undefined, transactionHashes: [HASH] }],
    ['transaction attempts', { submissionId: undefined, transactionHash: undefined, transactionAttempts: [{ hash: HASH }] }],
    ['an ambiguous submission', { submissionId: undefined, transactionHash: undefined, ambiguousSubmissions: [{ submissionId: 'a' }] }],
    ['a legacy recovery marker', { submissionId: undefined, transactionHash: undefined, legacyRecovery: true }],
    ['a non-prepared phase', { phase: 'awaiting_wallet', submissionId: undefined, transactionHash: undefined }]
]) {
    test(`${label} makes a plan a started deposit`, async t => {
        const h = await harness(t, { slot: { pendingDeposit: unsentPlan(change) } });
        await assert.rejects(h.runtime.prepareDeposit(100, { preparedOperationId: 'op-unsent' }), error => error === SENTINEL);
    });
}

test('a late deposit attempt of the same operation makes the plan a started deposit', async t => {
    const h = await harness(t, { slot: {
        pendingDeposit: unsentPlan(), lateDepositAttempts: [{ operationId: 'op-unsent', status: 'pending' }]
    } });
    await assert.rejects(h.runtime.prepareDeposit(100, { preparedOperationId: 'op-unsent' }), error => error === SENTINEL);
});

test('the pending plan is read from memory and never through the SDK read that initializes and locks', async t => {
    const h = await harness(t, { slot: { pendingDeposit: startedPlan() } });
    await assert.rejects(h.runtime.prepareDeposit(999), error => error instanceof DepositsClosedError);
    assert.ok(!h.touched.includes('runtime.pendingDeposit'));
    assert.ok(!h.touched.includes('runtime.reload'));
    assert.ok(!h.touched.includes('runtime.init'));
    assertNoAccess(h);
});

test('recovery entry points are never wrapped and keep working while deposits are closed', async t => {
    const h = await harness(t, { slot: { pendingDeposit: startedPlan() } });
    for (const side of ['client', 'runtime']) {
        for (const name of noteBoundV1.recoveryEntryPoints[side]) {
            const target = h[side];
            if (typeof target[name] !== 'function') continue;
            assert.equal(Object.prototype.hasOwnProperty.call(target, name)
                && Object.getOwnPropertyDescriptor(target, name).value?.name === 'guardedDepositEntryPoint', false,
            `${side}.${name} must not be wrapped`);
        }
    }
    // A recovery method runs its real body (here: up to its first collaborator).
    await assert.rejects(h.runtime.refreshPendingDeposit(100), error => error === SENTINEL);
    assert.ok(h.touched.includes('runtime.init'));
});

// Reading what a call asks for can itself throw (a Symbol has no number, an
// options getter can throw). That must close the entry point: with a started
// deposit in memory a failed read that fell through would let it pass.
test('a call whose request cannot be read is refused, never passed through', async t => {
    const h = await harness(t, { slot: { pendingDeposit: startedPlan() } });
    // Sanity: the same plan lets a readable, matching call through.
    await assert.rejects(h.runtime.prepareDeposit(100, { preparedOperationId: 'op-started' }), error => error === SENTINEL);
    const unreadable = [
        () => h.runtime.prepareDeposit(Symbol('amount')),
        () => h.runtime.prepareDepositQuote(Symbol('amount'), '0xroot'),
        () => h.runtime.prepareDeposit(100, { get preparedOperationId() { throw new Error('getter broke'); } }),
        () => h.client.deposit('0.0000001', () => {}, { get preparedOperationId() { throw new Error('getter broke'); } })
    ];
    for (const call of unreadable) {
        await assert.rejects(call(), error => {
            assert.ok(error instanceof DepositsClosedError);
            assert.equal(error.data.gateCode, 'version_unavailable');
            return true;
        });
    }
});

test('a refusal for a required reload carries its gate code and says so in plain words', async t => {
    const RELOAD = { canStart: false, canResume: false, code: 'reload_required', successor: null };
    const h = await harness(t, { gate: RELOAD });
    await assert.rejects(h.client.deposit('1'), error => {
        assert.ok(error instanceof DepositsClosedError);
        assert.equal(error.code, 'deposits_closed');
        assert.equal(error.data.gateCode, 'reload_required');
        assert.match(error.message, /balance changed in another tab\. Reload to keep going/);
        assert.doesNotMatch(error.message, /no longer accepts|nullifier|vault|circuit|deployment/i);
        return true;
    });
    // Restrict-only: the started deposit of this wallet still passes.
    const started = await harness(t, { gate: RELOAD, slot: { pendingDeposit: startedPlan() } });
    await assert.rejects(started.client.deposit('0.0000001', () => {}, { preparedOperationId: 'op-started' }),
        error => error === SENTINEL);
    assertNoAccess(h);
});

test('a slot owned by a retired deployment is told so, not told to reload', async t => {
    const FOREIGN = { canStart: false, canResume: false, code: 'foreign_runtime', successor: null };
    resetActiveVersionForTests();
    t.after(resetActiveVersionForTests);
    const h = await harness(t, { gate: FOREIGN });
    // Without a selection (or for an unknown owner) a reload may help.
    await assert.rejects(h.client.deposit('1'), error => {
        assert.match(error.message, /Reload to try again/);
        return true;
    });
    // A retired owner cannot be reached by a reload: say what happened.
    installActiveVersion({ table: [VERSION], version: VERSION, selection: { reason: 'retired_deployment', version: VERSION } });
    await assert.rejects(h.client.deposit('1'), error => {
        assert.match(error.message, /retired/);
        assert.doesNotMatch(error.message, /try again/i);
        assert.equal(error.data.gateCode, 'foreign_runtime');
        return true;
    });
    assertNoAccess(h);
});

test('a gate that throws or is not a gate closes every entry point', async t => {
    for (const gate of [
        () => { throw new Error('gate broke'); }, () => undefined, () => null, () => ({ canStart: 'yes' }),
        () => ({ canStart: 1 }), () => 'open'
    ]) {
        const h = await harness(t, { gate: OPEN });
        h.uninstall();
        const uninstall = installDepositGuard({
            client: h.client, runtime: h.runtime, adapter: noteBoundV1, getGate: gate, version: VERSION
        });
        t.after(uninstall);
        await assert.rejects(h.client.deposit('1'), error => error instanceof DepositsClosedError);
        await assert.rejects(h.runtime.prepareDeposit(100), error => error instanceof DepositsClosedError);
        assertNoAccess(h);
    }
});

test('the wrappers are instance-level, not a proxy, and uninstall restores the singleton exactly', async t => {
    const h = await harness(t);
    const { client, runtime } = h;
    assert.ok(client instanceof ZkapiClient);
    assert.equal(Object.getPrototypeOf(client), ZkapiClient.prototype);
    assert.ok(runtime instanceof BrowserWalletRuntime);
    for (const name of noteBoundV1.depositEntryPoints.client) {
        const descriptor = Object.getOwnPropertyDescriptor(client, name);
        assert.equal(typeof descriptor.value, 'function');
        assert.equal(descriptor.enumerable, false, 'the own-property surface is unchanged');
        assert.notEqual(client[name], ZkapiClient.prototype[name]);
    }
    assert.deepEqual(h.uninstall.wrapped.client.sort(), [...noteBoundV1.depositEntryPoints.client].sort());
    assert.deepEqual(h.uninstall.wrapped.runtime.sort(), [...noteBoundV1.depositEntryPoints.runtime].sort());
    h.uninstall();
    for (const name of noteBoundV1.depositEntryPoints.client) {
        assert.equal(Object.prototype.hasOwnProperty.call(client, name), false);
        assert.equal(client[name], ZkapiClient.prototype[name]);
    }
    // After uninstall a closed gate no longer matters.
    await assert.rejects(client.quoteDepositUsd('1'), error => error === SENTINEL);
});

test('installing twice does not wrap twice', async t => {
    const h = await harness(t, { gate: OPEN });
    const second = installDepositGuard({
        client: h.client, runtime: h.runtime, adapter: noteBoundV1, getGate: () => OPEN
    });
    assert.deepEqual(second.wrapped, { client: [], runtime: [] });
    await assert.rejects(h.client.quoteDepositUsd('1'), error => error === SENTINEL);
    assert.equal(h.touched.filter(name => name === 'client.refreshEthUsdPrice').length, 1);
});

test('the guard needs an adapter that names its entry points and a gate reader', () => {
    const client = new ZkapiClient();
    const runtime = new BrowserWalletRuntime();
    assert.throws(() => installDepositGuard({ client, runtime, adapter: {}, getGate: () => OPEN }), /entry points/);
    assert.throws(() => installDepositGuard({ client, runtime, adapter: noteBoundV1 }), /gate reader/);
    assert.throws(() => installDepositGuard({ runtime, adapter: noteBoundV1, getGate: () => OPEN }), /client/);
    assert.throws(() => installDepositGuard({ client, adapter: noteBoundV1, getGate: () => OPEN }), /runtime/);
});

test('the drift detector classifies every /deposit/i method of the REAL legacy singletons', () => {
    const drift = unclassifiedDepositEntryPoints({ client: legacyClient, runtime: legacyRuntime, adapter: noteBoundV1 });
    assert.deepEqual(drift, { client: [], runtime: [] });
    // Every method that starts or quotes a deposit is guarded, and every listed
    // name exists on the SDK (a rename would otherwise leave a hole).
    for (const name of noteBoundV1.depositEntryPoints.client) assert.equal(typeof legacyClient[name], 'function', name);
    for (const name of noteBoundV1.depositEntryPoints.runtime) assert.equal(typeof legacyRuntime[name], 'function', name);
    assert.ok(depositMethodNames(legacyClient).includes('deposit'));
    assert.ok(depositMethodNames(legacyRuntime).includes('prepareDeposit'));
});

test('the drift detector reports a new unclassified /deposit/i method', () => {
    class Next extends ZkapiClient {
        async depositFromAddress() {}
        async refreshDepositHistory() {}
        helper() {}
    }
    const instance = new Next();
    assert.deepEqual(unclassifiedDepositMethods(instance, {
        guarded: noteBoundV1.depositEntryPoints.client, recovery: noteBoundV1.recoveryEntryPoints.client
    }), ['depositFromAddress', 'refreshDepositHistory']);
    assert.deepEqual(unclassifiedDepositMethods(instance, {
        guarded: [...noteBoundV1.depositEntryPoints.client, 'depositFromAddress'],
        recovery: [...noteBoundV1.recoveryEntryPoints.client, 'refreshDepositHistory']
    }), []);
});

test('the drift detector passes the fixture SDK of the next generation against its adapter', async () => {
    const fixture = path.join(here, '../fixtures/zkapi-sdk-v2-fixture/sdk/services');
    const { default: fixtureClient } = await import(pathToFileURL(path.join(fixture, 'zkapiClient.js')).href);
    const { default: fixtureRuntime } = await import(pathToFileURL(path.join(fixture, 'browserWalletRuntime.js')).href);
    const drift = unclassifiedDepositEntryPoints({ client: fixtureClient, runtime: fixtureRuntime, adapter: concessionV1 });
    assert.deepEqual(drift, { client: [], runtime: [] });
    for (const name of concessionV1.depositEntryPoints.client) assert.equal(typeof fixtureClient[name], 'function', name);
    for (const name of concessionV1.depositEntryPoints.runtime) assert.equal(typeof fixtureRuntime[name], 'function', name);
    // An adapter of the wrong generation does not know the next SDK's methods:
    // this is how loading the wrong adapter for an SDK would be noticed.
    const wrong = unclassifiedDepositEntryPoints({ client: fixtureClient, runtime: fixtureRuntime, adapter: noteBoundV1 });
    assert.ok(wrong.client.includes('assertDepositMayStart'));
    assert.ok(wrong.runtime.includes('verifyDeploymentForDeposit'));
});

// ---------------------------------------------------------------------------
// Deny by default
// ---------------------------------------------------------------------------
//
// The adapter's lists say what is known. A /deposit/i function it does not
// name is wrapped anyway, so a method an SDK adds or renames cannot start a
// deposit on a closed version before somebody has classified it.

// SDK classes of "the next release": the real legacy classes plus methods no
// adapter lists. `calls` records what actually ran.
function futureSingletons(t, { gate = CLOSED, slot = null, recoveryExtras = {} } = {}) {
    const calls = [];
    let getterReads = 0;
    class FutureClient extends ZkapiClient {
        async fundNewNoteDeposit(...args) { calls.push(['client.fundNewNoteDeposit', args]); return 'ran'; }
        async estimateDepositFee(...args) { calls.push(['client.estimateDepositFee', args]); return 'fee'; }
        get depositLimitUsd() { getterReads += 1; return 5; }
    }
    class FutureRuntime extends BrowserWalletRuntime {
        async depositFromVoucher(...args) { calls.push(['runtime.depositFromVoucher', args]); return 'ran'; }
        async depositFeeHint(...args) { calls.push(['runtime.depositFeeHint', args]); return 'hint'; }
    }
    const client = new FutureClient();
    const runtime = new FutureRuntime();
    runtime.runtime = slot;
    // The legacy adapter, plus two read-only methods the "new" SDK added and
    // the adapter's author classified as recovery.
    const adapter = {
        depositEntryPoints: noteBoundV1.depositEntryPoints,
        recoveryEntryPoints: {
            client: [...noteBoundV1.recoveryEntryPoints.client, ...(recoveryExtras.client || [])],
            runtime: [...noteBoundV1.recoveryEntryPoints.runtime, ...(recoveryExtras.runtime || [])]
        }
    };
    const state = { gate };
    const uninstall = installDepositGuard({ client, runtime, adapter, getGate: () => state.gate, version: VERSION });
    t.after(uninstall);
    return { client, runtime, calls, state, uninstall, adapter, getterReads: () => getterReads };
}

test('deny by default: a closed gate refuses a /deposit/i method no list names', async t => {
    const h = futureSingletons(t);
    // Both are reported as unclassified AND guarded.
    assert.deepEqual(unclassifiedDepositEntryPoints({ client: h.client, runtime: h.runtime, adapter: h.adapter }), {
        client: ['estimateDepositFee', 'fundNewNoteDeposit'], runtime: ['depositFeeHint', 'depositFromVoucher']
    });
    assert.ok(h.uninstall.wrapped.client.includes('fundNewNoteDeposit'));
    assert.ok(h.uninstall.wrapped.runtime.includes('depositFromVoucher'));
    await assert.rejects(h.client.fundNewNoteDeposit('1'), error => {
        assert.ok(error instanceof DepositsClosedError);
        assert.equal(error.code, 'deposits_closed');
        assert.equal(error.data.gateCode, 'deposits_closed');
        return true;
    });
    await assert.rejects(h.runtime.depositFromVoucher('v'), error => error instanceof DepositsClosedError);
    assert.deepEqual(h.calls, [], 'neither method ran');
});

test('deny by default: an open gate lets the same methods run, and uninstall removes the wrappers', async t => {
    const h = futureSingletons(t, { gate: OPEN });
    assert.equal(await h.client.fundNewNoteDeposit('1'), 'ran');
    assert.equal(await h.runtime.depositFromVoucher('v'), 'ran');
    assert.deepEqual(h.calls.map(([name]) => name), ['client.fundNewNoteDeposit', 'runtime.depositFromVoucher']);
    h.state.gate = CLOSED;
    await assert.rejects(h.client.fundNewNoteDeposit('1'), error => error instanceof DepositsClosedError);
    h.uninstall();
    assert.equal(await h.client.fundNewNoteDeposit('1'), 'ran');
    assert.equal(Object.prototype.hasOwnProperty.call(h.client, 'fundNewNoteDeposit'), false);
});

test('deny by default: recovery entry points are never wrapped, and read-only ones keep working closed', async t => {
    const h = futureSingletons(t, {
        slot: { pendingDeposit: startedPlan() },
        recoveryExtras: { client: ['estimateDepositFee'], runtime: ['depositFeeHint'] }
    });
    // Classified as recovery: not wrapped, so a closed gate never sees them.
    assert.equal(h.uninstall.wrapped.client.includes('estimateDepositFee'), false);
    assert.equal(h.uninstall.wrapped.runtime.includes('depositFeeHint'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(h.client, 'estimateDepositFee'), false);
    assert.equal(await h.client.estimateDepositFee('1'), 'fee');
    assert.equal(await h.runtime.depositFeeHint(), 'hint');
    // The same with no started deposit at all.
    const bare = futureSingletons(t, { recoveryExtras: { client: ['estimateDepositFee'], runtime: ['depositFeeHint'] } });
    assert.equal(await bare.client.estimateDepositFee('1'), 'fee');
    assert.equal(await bare.runtime.depositFeeHint(), 'hint');
    // Every recovery entry point the adapter names stays exactly as the SDK
    // has it, whatever else is wrapped.
    for (const name of noteBoundV1.recoveryEntryPoints.client) {
        assert.equal(h.uninstall.wrapped.client.includes(name), false, name);
    }
    for (const name of noteBoundV1.recoveryEntryPoints.runtime) {
        assert.equal(h.uninstall.wrapped.runtime.includes(name), false, name);
    }
    // The listed deposit entry points are still guarded.
    for (const name of noteBoundV1.depositEntryPoints.client) assert.ok(h.uninstall.wrapped.client.includes(name), name);
    for (const name of noteBoundV1.depositEntryPoints.runtime) assert.ok(h.uninstall.wrapped.runtime.includes(name), name);
});

test('deny by default: getters are never read, and a started deposit lets its own helpers through', async t => {
    const h = futureSingletons(t, { slot: { pendingDeposit: startedPlan() } });
    assert.equal(h.getterReads(), 0, 'enumerating names never reads a getter');
    assert.equal(h.uninstall.wrapped.client.includes('depositLimitUsd'), false);
    // The unclassified method carries no amount to compare: with a deposit
    // that already started it passes (the helper calls of that deposit's own
    // completion), exactly as a USD quote does. Without one it is refused.
    assert.equal(await h.client.fundNewNoteDeposit('9'), 'ran');
    const none = futureSingletons(t, { slot: { pendingDeposit: unsentPlan() } });
    await assert.rejects(none.client.fundNewNoteDeposit('9'), error => error instanceof DepositsClosedError);
    const empty = futureSingletons(t, { slot: null });
    await assert.rejects(empty.runtime.depositFromVoucher('v'), error => error instanceof DepositsClosedError);
});

test('deny by default: a name listed as both a deposit entry point and a recovery one is guarded', async t => {
    const client = new ZkapiClient();
    const runtime = new BrowserWalletRuntime();
    const uninstall = installDepositGuard({
        client, runtime, getGate: () => CLOSED, version: VERSION,
        adapter: {
            depositEntryPoints: { client: ['quoteDepositUsd'], runtime: [] },
            recoveryEntryPoints: { client: ['quoteDepositUsd'], runtime: ['prepareDeposit', 'prepareDepositQuote'] }
        }
    });
    t.after(uninstall);
    // Listed as a deposit entry point, so guarded despite the recovery entry.
    assert.ok(uninstall.wrapped.client.includes('quoteDepositUsd'));
    await assert.rejects(client.quoteDepositUsd('1'), error => error instanceof DepositsClosedError);
    // Named only as recovery: left as the SDK has it.
    assert.equal(uninstall.wrapped.runtime.includes('prepareDeposit'), false);
    assert.equal(uninstall.wrapped.runtime.includes('prepareDepositQuote'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(runtime, 'prepareDeposit'), false);
    // (Every other deposit-named runtime method this adapter did not classify
    // is wrapped: that is the rule.)
    assert.ok(uninstall.wrapped.runtime.includes('pendingDeposit'));
});

test('deny by default over the fixture SDK singletons of the next generation', async t => {
    const fixture = path.join(here, '../fixtures/zkapi-sdk-v2-fixture/sdk/services');
    const { default: fixtureClient } = await import(pathToFileURL(path.join(fixture, 'zkapiClient.js')).href);
    const { default: fixtureRuntime } = await import(pathToFileURL(path.join(fixture, 'browserWalletRuntime.js')).href);
    const { fixtureCallLog } = await import(pathToFileURL(path.join(fixture, 'fixtureSupport.js')).href);
    const uninstall = installDepositGuard({
        client: fixtureClient, runtime: fixtureRuntime, adapter: concessionV1, getGate: () => CLOSED, version: VERSION
    });
    t.after(uninstall);
    // The adapter classifies every /deposit/i method of this SDK, so deny by
    // default wraps exactly the listed entry points and nothing else.
    assert.deepEqual([...uninstall.wrapped.client].sort(), [...concessionV1.depositEntryPoints.client].sort());
    assert.deepEqual([...uninstall.wrapped.runtime].sort(), [...concessionV1.depositEntryPoints.runtime].sort());
    const before = fixtureCallLog().length;
    await assert.rejects(fixtureClient.deposit('1'), error => error instanceof DepositsClosedError);
    await assert.rejects(fixtureClient.performDeposit('1'), error => error instanceof DepositsClosedError);
    await assert.rejects(fixtureClient.prepareDepositQuote('1'), error => error instanceof DepositsClosedError);
    await assert.rejects(fixtureClient.quoteDepositUsd('1'), error => error instanceof DepositsClosedError);
    await assert.rejects(fixtureRuntime.prepareDeposit(1), error => error instanceof DepositsClosedError);
    await assert.rejects(fixtureRuntime.prepareDepositQuote(1, '0x'), error => error instanceof DepositsClosedError);
    assert.equal(fixtureCallLog().length, before, 'no SDK method ran');
    // Recovery and reads of the next generation reach the SDK.
    for (const name of ['recoverBrowserDeposit', 'confirmBrowserDepositReceipt', 'assertDepositMayStart']) {
        assert.equal(Object.prototype.hasOwnProperty.call(fixtureClient, name), false, name);
        await fixtureClient[name]();
    }
    await fixtureRuntime.refreshPendingDeposit();
    await fixtureRuntime.verifyDeploymentForDeposit();
    assert.ok(fixtureCallLog().length >= before + 5, 'the recovery entry points ran');
});
