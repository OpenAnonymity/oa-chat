// zkAPI payment boot (chat/zkapi/boot.js) and the startup that calls it.
//
// The boot is exercised with every seam injected: a fake origin (IndexedDB,
// Web Locks, BroadcastChannel, storage), recorded SDK imports and a recorded
// payment integration, so the ORDER of side effects, the bounded waits and the
// failure isolation are measured rather than assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootZkapiPayments } from '../../chat/zkapi/boot.js';
import { createZkapiVersioning } from '../../chat/zkapi/versioning/index.js';
import {
    getActiveVersion, getSelection, resetActiveVersionForTests
} from '../../chat/zkapi/versioning/activeVersion.mjs';
import { SWITCH_HINT_KEY } from '../../chat/zkapi/versioning/switchProtocol.mjs';
import { noteBoundV1 } from '../../chat/zkapi/versioning/adapters/noteBoundV1.mjs';
import { discardDepositDraft, readWalletHoldings } from '../../chat/zkapi/versioning/walletHoldings.mjs';
import { createFakeEnvironment, createFakeStorage } from './_fakeIndexedDb.mjs';
import { activatedRegistry, partialRevertRegistry, resolvedTable, validRegistry } from './_registryFixtures.mjs';

const NETWORK = 'sepolia';
const BASE = 'https://app.example/chat/';
const DB = 'zkapi-browser-wallet-fresh-20260930-sepolia-v1';
const NOW = Date.parse('2026-11-15T12:00:00Z');
const NOTE_EXPIRY = Math.floor(NOW / 1000) + 30 * 86_400;
const MULTI = resolvedTable(activatedRegistry(), NETWORK);
const SINGLE = resolvedTable(validRegistry(), NETWORK);
// v1 closed while v2 is still pending: one live row that is `exit-only`.
const LONE_EXIT_ONLY = resolvedTable(partialRevertRegistry(), NETWORK);
const [V1, V2] = MULTI;
const TIMEOUTS = { probeMs: 40, integrityMs: 40, variantMs: 120 };

const planOf = (overrides = {}) => ({
    operationId: 'op-1', createdAt: 1, phase: 'prepared', amount: 5, secret: 'SECRET-PLAN-MARKER',
    commitment: '0x01', next_note_id: 9, active_root: '0x02', zero_path: ['0x03'], ...overrides
});
const noteSlot = deploymentId => ({
    version: 1, deploymentId, updatedAt: 5, state: { note_id: 5, expiry_ts: NOTE_EXPIRY, secret: 'SECRET-NOTE-MARKER' }
});
const withdrawalOf = (version, overrides = {}) => ({
    recordId: `${version.deploymentId}:${version.chainId}:${version.vault}:7`, deploymentId: version.deploymentId,
    chainId: version.chainId, contractAddress: version.vault, noteId: 7, mode: 'mutual',
    phase: 'closed_unconfirmed', updatedAt: 10, ...overrides
});

function seedWallet(env, { slot = null, withdrawals = [] } = {}) {
    env.idb.seed(DB, { version: 3, stores: {
        runtime: slot ? { records: { active: slot } } : {},
        withdrawals: { keyPath: 'recordId', records: Object.fromEntries(withdrawals.map(record => [record.recordId, record])) },
        deposits: { keyPath: 'recordId' }
    } });
}

// A recorded stand-in for the SDK singletons: the deposit and recovery entry
// points the adapter names exist, so the guard has something to wrap.
function fakeSdk(order) {
    const listeners = new Set();
    const client = {
        initialized: false,
        lastError: null,
        config: null,
        wallet: null,
        withdrawals: [],
        deposits: [],
        activities: [],
        noteExpiryClaim: null,
        snapshot() {
            return { config: this.config, wallet: this.wallet, withdrawals: this.withdrawals,
                deposits: this.deposits, activities: this.activities };
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        emit(reason = 'update') {
            for (const listener of [...listeners]) listener(this.snapshot(), { reason });
        },
        listenerCount: () => listeners.size
    };
    for (const name of noteBoundV1.depositEntryPoints.client) {
        client[name] = async function (...args) { order.push(`client.${name}`); return `real:${name}:${args.length}`; };
    }
    for (const name of noteBoundV1.recoveryEntryPoints.client) {
        client[name] = async function () { order.push(`client.${name}`); return `recovery:${name}`; };
    }
    const runtime = { runtime: null, manifest: { deployment_id: V2.deploymentId } };
    for (const name of noteBoundV1.depositEntryPoints.runtime) {
        runtime[name] = async function () { order.push(`runtime.${name}`); return `real:${name}`; };
    }
    return { client, runtime, store: { withBrowserWalletLock: async (_deployment, operation) => operation() } };
}

function setup(t, options = {}) {
    const env = createFakeEnvironment();
    const restore = env.install();
    t.after(restore);
    const order = [];
    const calls = { integration: [], watcher: [], ui: 0 };
    const session = createFakeStorage();
    const local = createFakeStorage();
    const table = options.table || MULTI;
    const facade = createZkapiVersioning({
        buildTable: table, network: NETWORK, now: () => NOW, sessionStorage: session, localStorage: local,
        reload: () => order.push('reload')
    });
    const sdk = fakeSdk(order);
    resetActiveVersionForTests();
    t.after(() => { resetActiveVersionForTests(); facade.resetForTests(); });
    const boot = overrides => bootZkapiPayments({
        network: NETWORK,
        table,
        database: DB,
        baseURI: BASE,
        storage: session,
        now: NOW,
        facade,
        timeouts: TIMEOUTS,
        loadVariant: async id => {
            order.push(`loadVariant:${id}`);
            if (options.loadVariant) return options.loadVariant(id);
            const error = new Error('no variants');
            error.code = 'no_variants';
            throw error;
        },
        importSdk: async () => {
            order.push('importSdk');
            if (options.importSdk) return options.importSdk(sdk);
            return sdk;
        },
        importUi: async () => {
            order.push('importUi');
            calls.ui += 1;
            if (options.importUi) return options.importUi();
            return { versionUi: { marker: 'ui' } };
        },
        importIntegration: async () => {
            order.push('importIntegration');
            if (options.importIntegration) return options.importIntegration();
            return { createZkapiPaymentIntegration: input => {
                order.push('createIntegration');
                // The guard and the facade must already be on the client.
                calls.integration.push({
                    ...input,
                    guardedAtCreation: Object.prototype.hasOwnProperty.call(sdk.client, 'deposit')
                        && Object.getOwnPropertyDescriptor(sdk.client, 'deposit').enumerable === false,
                    facadeAtCreation: sdk.client.oaVersioning === facade
                });
                return { runtime: { marker: 'runtime' }, ui: { marker: 'ui' } };
            } };
        },
        verifyConfig: async version => {
            order.push(`verifyConfig:${version.id}`);
            if (options.verifyConfig) return options.verifyConfig(version);
            return 'ok';
        },
        startWatcher: input => {
            order.push('startWatcher');
            calls.watcher.push(input);
            return () => {};
        },
        ...options.boot,
        ...overrides
    });
    return { env, order, calls, session, local, facade, sdk, boot, table };
}

const quiet = t => t.mock.method(console, 'warn', () => {});

// ------------------------------------------------------------------ manual time
//
// The bounded waits are proved on a clock the test drives instead of by
// sleeping and measuring: setTimeout and performance.now stand still until
// `advance` moves them, and a test moves them only when the boot has been
// observed to be waiting (a recorded step, a gate it holds). A slow machine
// and a fast one then measure the same thing.
function manualClock(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // A whole number, so that every difference of two readings is exact: a
    // remaining budget of 170 ms is 170, not 170.00000000001.
    const origin = 1_000_000;
    let elapsed = 0;
    t.mock.method(performance, 'now', () => origin + elapsed);
    return {
        get elapsed() { return elapsed; },
        advance(ms) {
            elapsed += ms;
            t.mock.timers.tick(ms);
        }
    };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
// Lets the pending (microtask and fake-IndexedDB) work run until `condition`
// holds. Time is not moved here.
async function until(condition, label) {
    for (let turns = 0; turns < 20_000; turns += 1) {
        if (condition()) return;
        await turn();
    }
    assert.fail(`never reached: ${label}`);
}
// Gives work that is already runnable a fair number of turns to show itself.
async function settle(turns = 25) {
    for (let count = 0; count < turns; count += 1) await turn();
}
const deferred = () => {
    const gate = {};
    gate.promise = new Promise((resolve, reject) => { gate.resolve = resolve; gate.reject = reject; });
    return gate;
};
const watch = promise => {
    const state = { done: false };
    promise.then(() => { state.done = true; }, () => { state.done = true; });
    return state;
};
// The boot's answer, or a failed assertion: a boot that is waiting for time the
// test has not given it must not leave the test waiting forever.
async function answer(booting) {
    const state = watch(booting);
    await until(() => state.done, 'the boot answered');
    return booting;
}
// Moves the clock a few milliseconds at a time, only once the work that can run
// without time has run (the fake IndexedDB included), until the boot has
// answered. Returns the time it took; fails if that is more than `within`: how
// long a person could be left looking at a blank page.
async function waitOutBounds(h, clock, state, within, label) {
    const started = clock.elapsed;
    for (;;) {
        await h.env.idb.idle();
        await settle(10);
        if (state.done) return clock.elapsed - started;
        assert.ok(clock.elapsed - started < within, `${label}: still waiting after ${within} ms`);
        clock.advance(5);
    }
}

// ----------------------------------------------------------------- sdk-default

test('sdk-default builds (no registry) start exactly as startup always did', async t => {
    quiet(t);
    const h = setup(t, { table: [] });
    for (const baseURI of ['https://app.example/', 'https://app.example/chat/', 'http://localhost:8080/']) {
        h.order.length = 0;
        const result = await h.boot({ table: [], baseURI });
        assert.deepEqual(result.integration, { runtime: { marker: 'runtime' }, ui: { marker: 'ui' } });
        assert.equal(result.unavailable, undefined);
        const assetBase = new URL('./zkapi/', baseURI);
        const expected = {
            configUrl: new URL('browser-config.json', assetBase).href,
            workerUrl: new URL('assets/zkapiWasmWorker.js', assetBase).href,
            mode: 'browser'
        };
        const { guardedAtCreation, facadeAtCreation, ...seen } = h.calls.integration.at(-1);
        assert.deepEqual(seen, expected);
        assert.equal(guardedAtCreation, false);
        assert.equal(facadeAtCreation, false);
        // Nothing of the versioning machinery runs.
        assert.deepEqual(h.order, ['importIntegration', 'createIntegration']);
    }
    assert.equal(h.env.idb.log.length, 0, 'the wallet database is never opened');
    assert.equal(getActiveVersion(), null);
});

test('with no network and no registry there is nothing to boot', async t => {
    const h = setup(t, { table: [] });
    assert.deepEqual(await h.boot({ table: [], network: '' }), { integration: null });
    assert.deepEqual(h.order, []);
});

test('a transport option reaches the integration only when given', async t => {
    quiet(t);
    const h = setup(t, { table: [] });
    const transport = () => {};
    await h.boot({ table: [], transport });
    assert.equal(h.calls.integration.at(-1).transport, transport);
    await h.boot({ table: [] });
    assert.equal('transport' in h.calls.integration.at(-1), false);
});

// ------------------------------------------------------------ dormant single

test('a single live version: no probe, no integrity request, no guard, no watcher', async t => {
    quiet(t);
    const h = setup(t, { table: SINGLE });
    const result = await h.boot({ readHoldings: async () => assert.fail('the wallet must not be probed') });
    assert.ok(result.integration);
    assert.equal(h.env.idb.log.length, 0);
    // Nothing about versions is fetched for a dormant build, not even the notices.
    assert.deepEqual(h.order, ['loadVariant:v1', 'importSdk', 'importIntegration', 'createIntegration']);
    // Same asset URLs as the unversioned startup.
    const { configUrl, workerUrl } = h.calls.integration[0];
    assert.equal(configUrl, new URL('zkapi/browser-config.json', BASE).href);
    assert.equal(workerUrl, new URL('zkapi/assets/zkapiWasmWorker.js', BASE).href);
    assert.equal(h.calls.integration[0].guardedAtCreation, false, 'no deposit guard in a dormant build');
    assert.equal(h.calls.integration[0].facadeAtCreation, true);
    assert.equal(h.calls.watcher.length, 0);
    assert.equal(getActiveVersion().id, 'v1');
    assert.equal(getSelection().reason, 'single_version');
    // Dormant gates are open and the UI helpers are not offered.
    assert.deepEqual(h.facade.depositGate(), { canStart: true, canResume: false, code: null, successor: null });
    assert.equal(h.facade.state(), null);
    assert.equal(h.facade.ui, null);
    assert.equal(h.facade.multiVersion, false);
});

// A registry may close the only live version while its successor is still
// pending ("deposits unavailable"). That is NOT today's single-version app: the
// pinned legacy SDK ignores the profile's deposits flag, so the host guard is the
// only thing between a user and a new deposit into a vault the operator closed.
test('a lone exit-only version is versioned: guard, integrity check and watcher run, and deposits are refused', async t => {
    quiet(t);
    assert.equal(LONE_EXIT_ONLY.length, 1);
    assert.equal(LONE_EXIT_ONLY[0].status, 'exit-only');
    assert.equal(LONE_EXIT_ONLY[0].depositsOpen, false);
    const h = setup(t, { table: LONE_EXIT_ONLY });
    const result = await h.boot();
    assert.ok(result.integration);
    assert.deepEqual(h.order, [
        'verifyConfig:v1', 'loadVariant:v1', 'importSdk', 'importUi', 'importIntegration', 'createIntegration', 'startWatcher'
    ]);
    const integration = h.calls.integration[0];
    assert.equal(integration.guardedAtCreation, true, 'the deposit guard is on the SDK before the integration exists');
    assert.equal(integration.facadeAtCreation, true);
    // Today's asset URLs: the version loaded is v1, and nothing else exists.
    assert.equal(integration.configUrl, new URL('zkapi/browser-config.json', BASE).href);
    assert.equal(h.calls.watcher.length, 1);
    assert.equal(getActiveVersion().id, 'v1');
    assert.equal(getSelection().reason, 'single_version');
    assert.equal(h.env.idb.log.length, 0, 'there is nothing to choose between, so the wallet is not opened');

    // The gate is closed, with no successor to point at.
    assert.equal(h.facade.multiVersion, true);
    assert.deepEqual(h.facade.depositGate(), { canStart: false, canResume: false, code: 'deposits_closed', successor: null });
    const state = h.facade.state(NOW);
    assert.equal(state.gate.canStart, false);
    assert.equal(state.show, false, 'one live version shows no pill; the notice must key on the gate, not on show');
    assert.equal(state.target, null);

    // Every entry point that would start a deposit refuses before anything runs.
    await assert.rejects(h.sdk.client.deposit('1'), error => error.code === 'deposits_closed' && error.status === 409);
    await assert.rejects(h.sdk.client.prepareDepositQuote('1'), error => error.code === 'deposits_closed');
    await assert.rejects(h.sdk.runtime.prepareDeposit(1000), error => error.code === 'deposits_closed');
    assert.equal(h.order.some(entry => /^(client|runtime)\.(deposit|prepareDeposit)/.test(entry)), false);
    assert.equal(h.env.idb.log.length, 0, 'a refusal touches no storage');
    // Recovery of a deposit that already started is never refused.
    assert.equal(await h.sdk.client.recoverBrowserDeposit(), 'recovery:recoverBrowserDeposit');
});

test('a lone exit-only version still loads when the version notices or the integrity check fail', async t => {
    quiet(t);
    const h = setup(t, {
        table: LONE_EXIT_ONLY,
        importUi: async () => { throw new Error('ui chunk failed'); },
        verifyConfig: () => 'mismatch'
    });
    const result = await h.boot();
    assert.ok(result.integration);
    const gate = h.facade.depositGate();
    assert.equal(gate.canStart, false);
    // The served-config mismatch outranks "closed": it is the more specific reason.
    assert.equal(gate.code, 'config_mismatch');
});

test('a lone active version stays dormant, whatever its notes hold', async t => {
    quiet(t);
    const h = setup(t, { table: SINGLE });
    seedWallet(h.env, { slot: noteSlot(SINGLE[0].deploymentId) });
    const result = await h.boot({ startWatcher: () => assert.fail('no watcher in a dormant build') });
    assert.ok(result.integration);
    assert.equal(h.calls.integration[0].guardedAtCreation, false);
    assert.equal(h.facade.multiVersion, false);
    assert.equal(h.env.idb.log.length, 0);
    assert.equal(h.order.includes('importUi'), false);
    assert.equal(h.order.some(entry => entry.startsWith('verifyConfig')), false);
    // A deposit reaches the SDK unchanged.
    assert.equal(await h.sdk.client.deposit('1'), 'real:deposit:1');
});

// A build that is not versioned is today's app, which waited for its code
// without a limit: a slow link is not a failure. Its SDK and payment-module
// imports start together (today's startup fetched them as one graph), so the
// waits overlap. A versioned build keeps its bounds (below).
const factory = () => ({ createZkapiPaymentIntegration: () => ({ runtime: { marker: 'runtime' }, ui: { marker: 'ui' } }) });

test('a dormant build waits for its code without a limit, and the two imports overlap', async t => {
    quiet(t);
    const clock = manualClock(t);
    const events = [];
    const sdkArrives = deferred();
    const integrationArrives = deferred();
    const h = setup(t, {
        table: SINGLE,
        importSdk: async sdk => { events.push('sdk:start'); await sdkArrives.promise; events.push('sdk:end'); return sdk; },
        importIntegration: async () => {
            events.push('integration:start');
            await integrationArrives.promise;
            events.push('integration:end');
            return factory();
        }
    });
    const booting = h.boot({ timeouts: { ...TIMEOUTS, variantMs: 60, totalMs: 100 } });
    const state = watch(booting);
    // Both imports are under way before either has answered: the waits overlap.
    await until(() => events.length === 2, 'both imports started');
    assert.deepEqual(events, ['sdk:start', 'integration:start']);
    // A versioned build would have given up at 60 ms (its step) and at 100 ms
    // (its whole budget); a minute passes and nothing is abandoned.
    clock.advance(60_000);
    await settle();
    assert.equal(state.done, false, 'a slow link is not a failure');
    sdkArrives.resolve();
    await until(() => events.includes('sdk:end'), 'the SDK arrived');
    integrationArrives.resolve();
    const result = await answer(booting);
    assert.ok(result.integration, 'a slow link is not a failure');
    assert.equal(result.unavailable, undefined);
    assert.deepEqual(events, ['sdk:start', 'integration:start', 'sdk:end', 'integration:end']);
    // The facade is still on the client when the integration is created.
    assert.equal(h.sdk.client.oaVersioning, h.facade);
    assert.equal(getActiveVersion().id, 'v1');
});

test('a dormant build with no registry (sdk-default) waits for its payment module without a limit', async t => {
    quiet(t);
    const clock = manualClock(t);
    const h = setup(t, { table: [] });
    const arrives = deferred();
    let asked = false;
    const booting = h.boot({
        table: [],
        timeouts: { ...TIMEOUTS, variantMs: 40, totalMs: 80 },
        importIntegration: async () => { asked = true; await arrives.promise; return factory(); }
    });
    const state = watch(booting);
    await until(() => asked, 'the payment module was requested');
    clock.advance(60_000);
    await settle();
    assert.equal(state.done, false, 'it did wait');
    arrives.resolve();
    const result = await answer(booting);
    assert.ok(result.integration);
    assert.equal(result.unavailable, undefined);
});

test('a dormant build maps an import failure to the same unavailability, with no stray rejection', async t => {
    quiet(t);
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    // The integration chunk fails after boot has already answered.
    const integrationFails = deferred();
    const sdkFails = setup(t, { table: SINGLE, importSdk: async () => { throw new Error('sdk chunk failed'); },
        importIntegration: async () => { await integrationFails.promise; throw new Error('integration chunk failed'); } });
    await assertUnavailable(sdkFails, 'sdk_unavailable');
    integrationFails.resolve();
    const integrationAlone = setup(t, { table: SINGLE, importIntegration: async () => { throw new Error('index chunk failed'); } });
    await assertUnavailable(integrationAlone, 'integration_unavailable');
    // An unhandled rejection is reported once the microtask queue has drained.
    await settle();
    assert.deepEqual(unhandled, []);
});

test('a versioned build keeps its bounds: a code load that never answers is ticket-only, not a blank page', async t => {
    quiet(t);
    const clock = manualClock(t);
    const hung = () => new Promise(() => {});
    const cases = [
        ['an SDK import that never settles', { importSdk: hung }, 'sdk_unavailable', 'importSdk', {}],
        ['an integration import that never settles', { importIntegration: hung }, 'integration_unavailable', 'importIntegration', {}],
        // The same holds for a lone exit-only version, which is versioned.
        ['an integration import that never settles (lone exit-only)',
            { table: LONE_EXIT_ONLY, importIntegration: hung }, 'integration_unavailable', 'importIntegration', {}]
    ];
    for (const [label, options, code, step] of cases) {
        const h = setup(t, options);
        seedWallet(h.env);
        const booting = assertUnavailable(h, code);
        const state = watch(booting);
        await until(() => h.order.includes(step), `${label}: the load started`);
        // The limit of one step is variantMs; one tick short of it nothing has
        // been given up, and at it the boot answers.
        clock.advance(TIMEOUTS.variantMs - 1);
        await settle();
        assert.equal(state.done, false, `${label}: still inside its limit`);
        clock.advance(1);
        await answer(booting);
        resetActiveVersionForTests();
    }
});

test('a versioned build starts the payment module only after the SDK is bound and the guard is on', async t => {
    quiet(t);
    const sdkArrives = deferred();
    const h = setup(t, { importSdk: async sdk => { await sdkArrives.promise; return sdk; } });
    seedWallet(h.env);
    const booting = h.boot();
    await until(() => h.order.includes('importSdk'), 'the SDK was requested');
    // The SDK has not answered: the payment module is not requested beside it.
    await settle();
    assert.equal(h.order.includes('importIntegration'), false, 'not before the SDK is bound');
    sdkArrives.resolve();
    await answer(booting);
    assert.ok(h.order.indexOf('importSdk') < h.order.indexOf('importIntegration'));
    assert.equal(h.calls.integration[0].guardedAtCreation, true);
    assert.equal(h.calls.integration[0].facadeAtCreation, true);
});

// ------------------------------------------------------------ multiple versions

test('multi: probe, then variant, then SDK, then integration; guard and facade first', async t => {
    quiet(t);
    const h = setup(t);
    seedWallet(h.env, { slot: null });
    const result = await h.boot();
    assert.ok(result.integration);
    assert.deepEqual(h.order.filter(entry => !entry.startsWith('client.') && !entry.startsWith('runtime.')), [
        'verifyConfig:v2', 'loadVariant:v2', 'importSdk', 'importUi', 'importIntegration', 'createIntegration', 'startWatcher'
    ]);
    // The probe ran before anything was loaded: it opened the database, once,
    // read only, before the variant was requested.
    assert.ok(h.env.idb.log.length > 0);
    assert.deepEqual(h.env.idb.committedWrites(), []);
    const integration = h.calls.integration[0];
    assert.equal(integration.configUrl, new URL('zkapi/v2c/browser-config.json', BASE).href);
    assert.equal(integration.workerUrl, new URL('zkapi/v2c/assets/zkapiWasmWorker.js', BASE).href);
    assert.equal(integration.mode, 'browser');
    assert.equal(integration.guardedAtCreation, true);
    assert.equal(integration.facadeAtCreation, true);
    assert.equal(getActiveVersion().id, 'v2');
    assert.equal(getSelection().reason, 'no_runtime_note');
    assert.deepEqual(h.facade.ui, { marker: 'ui' });
    assert.equal(h.facade.multiVersion, true);
    // The watcher got the facade, the table, the database and the network.
    const watcher = h.calls.watcher[0];
    assert.equal(watcher.facade, h.facade);
    assert.equal(watcher.table, h.table);
    assert.equal(watcher.database, DB);
    assert.equal(watcher.network, NETWORK);
    assert.equal(watcher.baseURI, BASE);
});

test('multi: the wallet slot decides which build loads, and its assets', async t => {
    quiet(t);
    const h = setup(t);
    seedWallet(h.env, { slot: noteSlot(V1.deploymentId) });
    const result = await h.boot();
    assert.ok(result.integration);
    assert.equal(getActiveVersion().id, 'v1');
    assert.equal(getSelection().reason, 'runtime_holds_note');
    assert.equal(h.calls.integration[0].configUrl, new URL('zkapi/browser-config.json', BASE).href);
    assert.deepEqual(h.order.filter(entry => entry.startsWith('loadVariant')), ['loadVariant:v1']);
    // The closed version refuses new deposits at the SDK entry point.
    await assert.rejects(h.sdk.client.deposit('1'), error => error.code === 'deposits_closed');
    assert.equal(h.order.includes('client.deposit'), false);
});

test('multi: a one-shot hint is validated, consumed, and honored for an empty slot with unfinished work', async t => {
    quiet(t);
    const h = setup(t);
    seedWallet(h.env, { slot: null, withdrawals: [withdrawalOf(V1)] });
    h.session.setItem(SWITCH_HINT_KEY, JSON.stringify({
        v: 1, at: NOW, from: 'v2', reason: 'finish_previous', view: null, prefer: 'v1'
    }));
    await h.boot();
    assert.equal(getActiveVersion().id, 'v1');
    assert.equal(getSelection().reason, 'requested_previous');
    assert.equal(h.session.getItem(SWITCH_HINT_KEY), null, 'consumed');

    // Without the hint the same wallet loads the deposit target.
    resetActiveVersionForTests();
    await h.boot();
    assert.equal(getActiveVersion().id, 'v2');
    assert.equal(getSelection().reason, 'no_runtime_note');
    assert.equal(getSelection().open.v1.length, 1);
});

test('multi: a hint that names an unknown version, or arrives stale, is ignored', async t => {
    quiet(t);
    const h = setup(t);
    seedWallet(h.env, { slot: null, withdrawals: [withdrawalOf(V1)] });
    for (const hint of [
        { v: 1, at: NOW, from: 'v2', reason: 'finish_previous', view: null, prefer: 'v9' },
        { v: 1, at: NOW - 3_600_000, from: 'v2', reason: 'finish_previous', view: null, prefer: 'v1' },
        { v: 2, at: NOW, from: 'v2', reason: 'finish_previous', view: null, prefer: 'v1' },
        'not json'
    ]) {
        resetActiveVersionForTests();
        h.session.setItem(SWITCH_HINT_KEY, typeof hint === 'string' ? hint : JSON.stringify(hint));
        await h.boot();
        assert.equal(getActiveVersion().id, 'v2', JSON.stringify(hint));
        assert.equal(h.session.getItem(SWITCH_HINT_KEY), null);
    }
});

test('multi: an unsent deposit draft pinning the closed version is cleared before the build loads', async t => {
    quiet(t);
    const h = setup(t);
    seedWallet(h.env, { slot: { version: 1, deploymentId: V1.deploymentId, updatedAt: 5, pendingDeposit: planOf() } });
    const result = await h.boot();
    assert.ok(result.integration);
    assert.equal(getActiveVersion().id, 'v2');
    assert.equal(getSelection().draftDiscarded, true);
    assert.equal(h.env.idb.read(DB, 'runtime', 'active').pendingDeposit, null);
});

test('multi: a configuration mismatch blocks deposits but not startup', async t => {
    quiet(t);
    const h = setup(t, { verifyConfig: () => 'mismatch' });
    seedWallet(h.env, { slot: null });
    const result = await h.boot();
    assert.ok(result.integration);
    assert.equal(h.facade.depositGate().canStart, false);
    assert.equal(h.facade.depositGate().code, 'config_mismatch');
    assert.equal(h.facade.flags().configMismatch, true);
});

test('multi: unverified or verified configuration does not block', async t => {
    quiet(t);
    for (const answer of ['ok', 'unverified']) {
        const h = setup(t, { verifyConfig: () => answer });
        seedWallet(h.env, { slot: null });
        await h.boot();
        assert.deepEqual(h.facade.depositGate(), { canStart: true, canResume: false, code: null, successor: null });
        h.facade.resetForTests();
        resetActiveVersionForTests();
    }
});

test('multi: the deposit gate is open on the target and closed on the exit-only version', async t => {
    quiet(t);
    const target = setup(t);
    seedWallet(target.env);
    await target.boot();
    assert.equal(target.facade.depositGate().canStart, true);

    const closed = setup(t);
    seedWallet(closed.env, { slot: noteSlot(V1.deploymentId) });
    await closed.boot();
    const gate = closed.facade.depositGate();
    assert.equal(gate.canStart, false);
    assert.equal(gate.code, 'deposits_closed');
    assert.deepEqual(gate.successor, { id: 'v2', label: 'Version 2' });
});

// ------------------------------------------------------- failure isolation

async function assertUnavailable(h, code, overrides) {
    const result = await h.boot(overrides);
    assert.equal(result.integration, null);
    assert.equal(result.unavailable.code, code);
    assert.equal(result.unavailable.message,
        'zkAPI could not start in this tab. Reload to try again. Your balance is saved in this browser.');
    assert.deepEqual(Object.keys(result).sort(), ['integration', 'unavailable']);
}

test('failure isolation: every rejection yields ticket-only, never a throw', async t => {
    quiet(t);
    const cases = [
        ['an unknown variant', { loadVariant: async () => { throw Object.assign(new Error('x'), { code: 'unknown_variant' }); } }, 'variant_unavailable'],
        ['a conflicting variant', { loadVariant: async () => { throw Object.assign(new Error('x'), { code: 'variant_conflict' }); } }, 'variant_unavailable'],
        ['a failing variant import', { loadVariant: async () => { throw new Error('chunk failed'); } }, 'variant_unavailable'],
        ['a variant that never loads', { loadVariant: () => new Promise(() => {}) }, 'variant_timeout'],
        ['an SDK import failure', { importSdk: async () => { throw new Error('import failed'); } }, 'sdk_unavailable'],
        ['an SDK without a client', { importSdk: async () => ({}) }, 'sdk_unavailable'],
        ['an integration import failure', { importIntegration: async () => { throw new Error('import failed'); } }, 'integration_unavailable'],
        ['an integration factory that throws', { importIntegration: async () => ({ createZkapiPaymentIntegration() { throw new Error('configure failed'); } }) }, 'boot_failed'],
        ['an integration factory that returns nothing', { importIntegration: async () => ({ createZkapiPaymentIntegration() {} }) }, 'integration_unavailable']
    ];
    for (const [label, options, code] of cases) {
        const h = setup(t, options);
        seedWallet(h.env);
        await assertUnavailable(h, code);
        resetActiveVersionForTests();
        assert.ok(label);
    }
});

test('failure isolation: a table no registry could produce is unavailable, not a crash', async t => {
    quiet(t);
    // Two deposit targets: the registry validator can never produce this.
    const broken = MULTI.map(version => ({ ...version, status: 'active' }));
    const h = setup(t, { table: broken });
    seedWallet(h.env);
    await assertUnavailable(h, 'invalid_version_table');
});

test('failure isolation: the installed version stays unset when boot fails before choosing', async t => {
    quiet(t);
    const h = setup(t, { loadVariant: async () => { throw new Error('boom'); } });
    seedWallet(h.env);
    await assertUnavailable(h, 'variant_unavailable');
    assert.equal(getActiveVersion(), null);
});

test('failure isolation: garbage options and a throwing facade never throw', async t => {
    quiet(t);
    assert.deepEqual((await bootZkapiPayments(null)).integration, null);
    const h = setup(t);
    seedWallet(h.env);
    const facade = { attach() { throw new Error('facade broke'); } };
    await assertUnavailable(h, 'boot_failed', { facade });
});

test('failure isolation: a hung IndexedDB open is a bounded, unreadable probe, and boot goes on', async t => {
    quiet(t);
    const clock = manualClock(t);
    const h = setup(t);
    seedWallet(h.env, { slot: noteSlot(V1.deploymentId) });
    const release = h.env.idb.hangNextOpen();
    const booting = h.boot();
    const waited = await waitOutBounds(h, clock, watch(booting), TIMEOUTS.probeMs * 3 + 250, 'a hung open');
    assert.ok(waited <= TIMEOUTS.probeMs, `the probe's own limit decided it (${waited} ms)`);
    const result = await answer(booting);
    assert.ok(result.integration, 'an unreadable wallet is not an unavailability');
    assert.equal(getSelection().reason, 'holdings_unreadable');
    assert.equal(getSelection().depositBlock, 'holdings_unreadable');
    // Deposits are blocked until the wallet can be read; nothing else changes.
    const gate = h.facade.depositGate();
    assert.equal(gate.canStart, false);
    assert.equal(gate.code, 'holdings_unreadable');
    release();
});

test('failure isolation: a probe that rejects is an unreadable wallet, not a failure', async t => {
    quiet(t);
    const h = setup(t);
    const result = await h.boot({ readHoldings: async () => { throw new Error('IndexedDB is broken'); } });
    assert.ok(result.integration);
    assert.equal(getSelection().reason, 'holdings_unreadable');
});

test('selection: a slow but working database does not turn a committed discard into an unreadable wallet', async t => {
    quiet(t);
    const clock = manualClock(t);
    const h = setup(t);
    seedWallet(h.env, { slot: { version: 1, deploymentId: V1.deploymentId, updatedAt: 5, pendingDeposit: planOf() } });
    // Probe, discard and re-probe each take 95% of the probe's own limit. The
    // steps add up to more than twice the limit and well inside three times it.
    const probeMs = 400;
    const step = Math.floor(probeMs * 0.95);
    let reads = 0;
    let discards = 0;
    // Each step answers when the test says its time has passed.
    const answers = [];
    const takesTime = run => async args => {
        await new Promise(resolve => answers.push(resolve));
        return run(args);
    };
    const booting = h.boot({
        timeouts: { ...TIMEOUTS, probeMs, variantMs: 5000, totalMs: 30_000 },
        readHoldings: takesTime(args => { reads += 1; return readWalletHoldings(args); }),
        discardDraft: takesTime(args => { discards += 1; return discardDepositDraft(args); })
    });
    for (let stepNumber = 1; stepNumber <= 3; stepNumber += 1) {
        await until(() => answers.length === stepNumber, `step ${stepNumber} was asked`);
        clock.advance(step);
        answers[stepNumber - 1]();
        await h.env.idb.idle();
    }
    assert.ok(clock.elapsed > probeMs * 2 && clock.elapsed < probeMs * 3, 'more than two limits, inside three');
    const result = await answer(booting);
    assert.ok(result.integration);
    assert.equal(discards, 1);
    assert.equal(reads, 2);
    assert.equal(h.env.idb.read(DB, 'runtime', 'active').pendingDeposit, null, 'the draft is gone');
    assert.notEqual(getSelection().reason, 'holdings_unreadable');
    assert.equal(getSelection().draftDiscarded, true, 'and the page says so');
    assert.equal(getSelection().depositBlock, null);
    assert.equal(getActiveVersion().id, 'v2');
    assert.equal(h.facade.depositGate().canStart, true);
});

test('selection: a probe that stalls is still bounded by one budget', async t => {
    quiet(t);
    const clock = manualClock(t);
    const h = setup(t);
    seedWallet(h.env, { slot: { version: 1, deploymentId: V1.deploymentId, updatedAt: 5, pendingDeposit: planOf() } });
    const booting = h.boot({ readHoldings: () => new Promise(() => {}), discardDraft: () => new Promise(() => {}) });
    await waitOutBounds(h, clock, watch(booting), TIMEOUTS.probeMs * 3 + 250, 'a probe that never answers');
    const result = await answer(booting);
    assert.ok(result.integration);
    assert.equal(getSelection().reason, 'holdings_unreadable');
});

test('failure isolation: a wallet lock that never answers cannot stall boot', async t => {
    quiet(t);
    const clock = manualClock(t);
    const h = setup(t);
    seedWallet(h.env, { slot: { version: 1, deploymentId: V1.deploymentId, updatedAt: 5, depositQuote: planOf() } });
    const neverLocks = { request: () => new Promise(() => {}) };
    const booting = h.boot({ locks: neverLocks });
    await waitOutBounds(h, clock, watch(booting), TIMEOUTS.probeMs * 3 + 250, 'a wallet lock that never answers');
    const result = await answer(booting);
    assert.ok(result.integration);
    assert.equal(getSelection().reason, 'holdings_unreadable');
    // The draft was not touched.
    assert.ok(h.env.idb.read(DB, 'runtime', 'active').depositQuote);
});

test('failure isolation: an integrity check that rejects or hangs only means unverified', async t => {
    quiet(t);
    const clock = manualClock(t);
    for (const verifyConfig of [() => { throw new Error('boom'); }, () => new Promise(() => {})]) {
        const h = setup(t, { verifyConfig });
        seedWallet(h.env);
        const booting = h.boot();
        await waitOutBounds(h, clock, watch(booting), TIMEOUTS.integrityMs + 250 + 5, 'an integrity check');
        const result = await answer(booting);
        assert.ok(result.integration);
        assert.equal(h.facade.depositGate().canStart, true);
        resetActiveVersionForTests();
    }
});

test('failure isolation: a version-notice import failure costs only the notices', async t => {
    quiet(t);
    const h = setup(t, { importUi: async () => { throw new Error('ui chunk failed'); } });
    seedWallet(h.env);
    const result = await h.boot();
    assert.ok(result.integration);
    assert.equal(h.facade.ui, null);
    assert.equal(h.facade.depositGate().canStart, true);
});

test('failure isolation: the steps share one overall budget, not one limit each', async t => {
    quiet(t);
    const clock = manualClock(t);
    // Each load is well inside its own 5 s limit, but together they overrun the
    // 250 ms budget: boot gives up at the budget, not after the sum of the steps.
    // The variant takes 80 ms; the SDK would take 400 ms more.
    const variant = deferred();
    const sdkArrives = deferred();
    const h = setup(t, {
        loadVariant: () => variant.promise,
        importSdk: sdk => sdkArrives.promise.then(() => sdk)
    });
    seedWallet(h.env);
    const booting = assertUnavailable(h, 'sdk_unavailable', {
        timeouts: { ...TIMEOUTS, variantMs: 5000, totalMs: 250, uiMs: 50 }
    });
    const state = watch(booting);
    await until(() => h.order.includes('loadVariant:v2'), 'the variant was requested');
    clock.advance(80);
    variant.resolve();
    await until(() => h.order.includes('importSdk'), 'the SDK was requested');
    // 80 ms of the 250 are gone: the SDK has what is left, not its own 5 s.
    clock.advance(169);
    await settle();
    assert.equal(state.done, false, 'one millisecond of the budget is left');
    clock.advance(1);
    await answer(booting);
    assert.equal(clock.elapsed, 250, 'gave up at the budget, before the SDK would have arrived');
    assert.equal(h.order.includes('importIntegration'), false, 'nothing is started past the budget');
    assert.equal(h.calls.integration.length, 0);
});

test('failure isolation: a budget of zero or nonsense falls back to the default budget', async t => {
    quiet(t);
    for (const totalMs of [0, -1, Number.NaN, 'soon']) {
        const h = setup(t);
        seedWallet(h.env);
        const result = await h.boot({ timeouts: { ...TIMEOUTS, totalMs } });
        assert.ok(result.integration, String(totalMs));
        resetActiveVersionForTests();
    }
});

test('the version notices never hold the app: boot goes on after uiMs and they attach when they arrive', async t => {
    quiet(t);
    const clock = manualClock(t);
    let arrive;
    const notices = { marker: 'late-ui' };
    const h = setup(t, { importUi: () => new Promise(resolve => { arrive = () => resolve({ versionUi: notices }); }) });
    seedWallet(h.env);
    const booting = h.boot({ timeouts: { ...TIMEOUTS, variantMs: 5000, uiMs: 40 } });
    const state = watch(booting);
    // The integration exists; the boot now waits a little for the notices.
    await until(() => h.order.includes('createIntegration'), 'the integration was created');
    clock.advance(39);
    await settle();
    assert.equal(state.done, false, 'it waits for the notices, up to uiMs');
    clock.advance(1);
    const result = await answer(booting);
    assert.ok(result.integration, 'payments are not held for presentation');
    assert.equal(h.facade.ui, null, 'not here yet');
    assert.equal(h.calls.watcher.length, 1);
    // Subscribers hear about the arrival (the state itself did not change).
    const seen = [];
    h.facade.subscribe(state => seen.push(state));
    arrive();
    await until(() => h.facade.ui === notices, 'the notices attached');
    assert.equal(seen.length, 1, 'told once, so the notices can render');
});

test('the version notices that arrive in time are there for the first render', async t => {
    quiet(t);
    const noticesArrive = deferred();
    const h = setup(t, { importUi: () => noticesArrive.promise });
    seedWallet(h.env);
    const booting = h.boot();
    // They arrive while the boot is waiting for them, well inside uiMs.
    await until(() => h.order.includes('createIntegration'), 'the integration was created');
    noticesArrive.resolve({ versionUi: { marker: 'ui' } });
    const result = await answer(booting);
    assert.ok(result.integration);
    assert.deepEqual(h.facade.ui, { marker: 'ui' });
});

test('failure isolation: a notices import that fails late is a warning, never an unhandled rejection', async t => {
    const warnings = t.mock.method(console, 'warn', () => {});
    let fail;
    const h = setup(t, { importUi: () => new Promise((resolve, reject) => { fail = reject; }) });
    seedWallet(h.env);
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    const clock = manualClock(t);
    const booting = h.boot({ timeouts: { ...TIMEOUTS, variantMs: 5000, uiMs: 20 } });
    await until(() => h.order.includes('createIntegration'), 'the integration was created');
    clock.advance(20);
    const result = await answer(booting);
    assert.ok(result.integration);
    fail(new Error('ui chunk failed late'));
    // An unhandled rejection is reported once the microtask queue has drained.
    await settle();
    assert.deepEqual(unhandled, []);
    assert.equal(h.facade.ui, null);
    assert.ok(warnings.mock.calls.some(call => /notices could not load/.test(String(call.arguments[0]))));
});

test('failure isolation: a watcher that cannot start does not undo the boot', async t => {
    quiet(t);
    const h = setup(t);
    seedWallet(h.env);
    const result = await h.boot({ startWatcher() { throw new Error('no channel'); } });
    assert.ok(result.integration);
});

test('multi: "Cancel unfinished deposit" runs the SDK-sanctioned discard with the wallet lock and refreshes the client', async t => {
    quiet(t);
    const discards = [];
    const h = setup(t, { boot: { importCanceledDeposit: async () => ({
        discardUnsentDeposit: async args => { discards.push(args); return true; }
    }) } });
    seedWallet(h.env, { slot: noteSlot(V1.deploymentId) });
    h.sdk.client.refresh = async options => { h.order.push(`refresh:${options.quiet}`); };
    await h.boot();
    const outcome = await h.facade.discardUnsentDeposit();
    assert.deepEqual(outcome, { discarded: true });
    assert.equal(discards.length, 1);
    assert.equal(discards[0].client, h.sdk.client);
    assert.equal(discards[0].runtime, h.sdk.runtime);
    assert.equal(discards[0].withWalletLock, h.sdk.store.withBrowserWalletLock);
    assert.ok(h.order.includes('refresh:true'));
});

// ------------------------------------------- the give-up and the history readers

const heldNote = (balance = 0) => ({
    has_note: true, pending_request: false, note: { note_id: 5, expiry_ts: NOTE_EXPIRY, current_balance: balance }
});

test('multi: the give-up and the history reader are the facade\'s, bound to this page\'s SDK and loaded only on use', async t => {
    quiet(t);
    const loads = [];
    const abandoned = [];
    const histories = [];
    const h = setup(t, { boot: {
        importAbandonedNote: async () => {
            loads.push('abandonedNote');
            return { giveUpBalance: async args => { abandoned.push(args); return { done: true, kind: 'zero' }; } };
        },
        readHistory: async args => { histories.push(args); return { rows: [], truncated: false }; }
    } });
    seedWallet(h.env, { slot: noteSlot(V1.deploymentId) });
    h.sdk.client.wallet = heldNote(0);
    await h.boot();
    assert.equal(getActiveVersion().id, 'v1');
    assert.deepEqual(loads, [], 'the give-up is not imported at boot');
    assert.deepEqual(histories, [], 'the history is not read at boot');

    const answer = await h.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' });
    assert.deepEqual(answer, { done: true, kind: 'zero' });
    assert.deepEqual(loads, ['abandonedNote']);
    const [args] = abandoned;
    assert.equal(args.client, h.sdk.client);
    assert.equal(args.runtime, h.sdk.runtime);
    assert.equal(args.store, h.sdk.store);
    assert.equal(args.expectedNoteId, 5);
    assert.equal(args.expectedBalanceUnits, '0');
    assert.equal(args.expectedDeploymentId, V1.deploymentId);
    assert.equal(args.supported, true);
    assert.equal(args.enabled, true);
    assert.equal(Object.hasOwn(args, 'locks'), false, 'the service takes the browser\'s own locks');

    await h.facade.history.ensureFresh();
    assert.deepEqual(histories, [{ database: DB, table: h.table, loadedDeploymentId: V1.deploymentId }]);
    assert.equal(h.facade.history.status(), 'ready');
});

test('multi: the locks a boot was given reach the give-up', async t => {
    quiet(t);
    const abandoned = [];
    const locks = { request: async () => null };
    const h = setup(t, { boot: {
        importAbandonedNote: async () => ({ giveUpBalance: async args => { abandoned.push(args); return { done: false, why: 'lock_busy' }; } })
    } });
    seedWallet(h.env, { slot: noteSlot(V1.deploymentId) });
    h.sdk.client.wallet = heldNote(0);
    await h.boot({ locks });
    assert.deepEqual(await h.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: false, why: 'lock_busy' });
    assert.equal(abandoned[0].locks, locks);
});

test('multi: a give-up whose module cannot load is a failed give-up, not a thrown click', async t => {
    quiet(t);
    const h = setup(t, { boot: { importAbandonedNote: async () => { throw new Error('chunk failed'); } } });
    seedWallet(h.env, { slot: noteSlot(V1.deploymentId) });
    h.sdk.client.wallet = heldNote(0);
    await h.boot();
    assert.deepEqual(await h.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: false, why: 'failed' });
    // The page can ask again once the module can load.
    assert.equal(h.facade.state(NOW).abandon.available, true);
});

test('multi: the default history reader reads the other versions\' rows from the shared wallet, read only', async t => {
    quiet(t);
    // The default reader takes its moment from Date.now (the facade's own
    // clock is not handed to it). Without this the deposit below, which expires
    // thirty days after the fixture's moment, reads as expired once the real
    // date passes that day and a derived expiry row appears.
    t.mock.method(Date, 'now', () => NOW);
    const h = setup(t);
    const foreign = {
        recordId: 'ignored', deploymentId: V1.deploymentId, noteId: 3, amount: 5_000_000, expiryTs: NOTE_EXPIRY,
        status: 'confirmed', createdAt: NOW - 86_400_000, confirmedAt: NOW - 86_000_000
    };
    h.env.idb.seed(DB, { version: 3, stores: {
        runtime: {},
        withdrawals: { keyPath: 'recordId' },
        deposits: { keyPath: 'recordId', records: { [foreign.recordId]: foreign } }
    } });
    await h.boot();
    assert.equal(getActiveVersion().id, 'v2');
    const writes = h.env.idb.committedWrites().length;
    await h.facade.history.ensureFresh();
    assert.equal(h.facade.history.status(), 'ready');
    const rows = h.facade.history.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'deposit');
    assert.equal(rows[0].version.versionId, 'v1');
    assert.equal(rows[0].amountUnits, '5000000');
    assert.equal(h.env.idb.committedWrites().length, writes, 'reading history writes nothing');
});

test('a single live version is handed neither reader, and neither is ever imported or called', async t => {
    quiet(t);
    let touched = 0;
    const h = setup(t, { table: SINGLE, boot: {
        importAbandonedNote: async () => { touched += 1; return { giveUpBalance: async () => ({ done: true }) }; },
        readHistory: async () => { touched += 1; return { rows: [], truncated: false }; }
    } });
    await h.boot();
    assert.equal(h.facade.multiVersion, false);
    assert.equal(h.facade.history, undefined);
    assert.deepEqual(await h.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: false, why: 'unavailable' });
    assert.equal(h.facade.abandonPreview(), null);
    assert.equal(touched, 0);
    assert.equal(h.env.idb.log.length, 0, 'no wallet database is opened');
});

test('a build with no registry is handed neither reader either', async t => {
    quiet(t);
    let touched = 0;
    const h = setup(t, { table: [], boot: {
        importAbandonedNote: async () => { touched += 1; return {}; },
        readHistory: async () => { touched += 1; return { rows: [] }; }
    } });
    await h.boot({ table: [] });
    assert.equal(touched, 0);
    assert.equal(h.env.idb.log.length, 0);
});

// What reaches `attach` is what the facade can use. The facade ignores a reader
// it should not have, so only the arguments themselves show whether boot held
// the line: a build that is not versioned is handed no give-up and no history
// reader at all, and a versioned one (a second row, or a lone row that is not
// the deposit target) is handed both.
test('boot passes the give-up and the history reader to the facade only when versions are told apart', async t => {
    quiet(t);
    const readers = {
        importAbandonedNote: async () => ({ giveUpBalance: async () => ({ done: true }) }),
        readHistory: async () => ({ rows: [], truncated: false })
    };
    const cases = [
        ['one live version', SINGLE, false],
        ['two versions', MULTI, true],
        ['a lone exit-only version', LONE_EXIT_ONLY, true]
    ];
    for (const [label, table, versioned] of cases) {
        const h = setup(t, { table, boot: readers });
        const attachments = [];
        const attach = h.facade.attach.bind(h.facade);
        h.facade.attach = input => { attachments.push(input); return attach(input); };
        seedWallet(h.env);
        await h.boot();
        assert.equal(attachments.length, 1, `${label}: the facade is attached once`);
        const [given] = attachments;
        assert.equal(Object.hasOwn(given, 'abandonNote'), versioned, `${label}: the give-up`);
        assert.equal(Object.hasOwn(given, 'readHistory'), versioned, `${label}: the history reader`);
        if (versioned) {
            assert.equal(typeof given.abandonNote, 'function', label);
            assert.equal(typeof given.readHistory, 'function', label);
        }
        resetActiveVersionForTests();
    }
    // With no registry there is no facade attachment at all.
    const none = setup(t, { table: [], boot: readers });
    let attached = 0;
    none.facade.attach = () => { attached += 1; };
    await none.boot({ table: [] });
    assert.equal(attached, 0, 'sdk-default: nothing is attached');
});

// ----------------------------------------------------------- gate fail-closed

test('without an installed version a versioned build refuses every deposit', () => {
    resetActiveVersionForTests();
    const facade = createZkapiVersioning({ buildTable: MULTI, network: NETWORK });
    assert.deepEqual(facade.depositGate(), { canStart: false, canResume: false, code: 'version_unavailable', successor: null });
    assert.equal(facade.multiVersion, true);
    assert.equal(facade.state(), null);
    assert.deepEqual(facade.sendGate(), { canSend: true, code: null }, 'chat is never a deposit');
});

test('the gate fails open only without the build table or in a build that is not versioned', () => {
    resetActiveVersionForTests();
    const open = { canStart: true, canResume: false, code: null, successor: null };
    assert.deepEqual(createZkapiVersioning({ buildTable: null }).depositGate(), open, 'define absent');
    assert.deepEqual(createZkapiVersioning({ buildTable: [] }).depositGate(), open, 'sdk-default');
    assert.deepEqual(createZkapiVersioning({ buildTable: SINGLE }).depositGate(), open, 'single version');
    assert.equal(createZkapiVersioning({ buildTable: SINGLE }).multiVersion, false);
    // One live version and a retired one is versioned.
    const withTombstone = [...SINGLE, { id: 'v0', ordinal: 0, status: 'retired', deploymentId: 'old', chainId: 1, vault: '0x01' }];
    assert.equal(createZkapiVersioning({ buildTable: withTombstone }).depositGate().code, 'version_unavailable');
    // A table the facade cannot read at all fails closed in a versioned build.
    assert.equal(createZkapiVersioning({ buildTable: MULTI, context: () => { throw new Error('x'); } }).depositGate().code,
        'version_unavailable');
});

// ------------------------------------------------------------------- startup

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Bundle the REAL chat/startup.js with its two collaborators replaced by
// recorders, then run the bundle.
async function loadStartup(t, { network = 'sepolia', boot, app, failImport = false }) {
    const { build } = await import('esbuild');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-startup-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const appFile = path.join(directory, 'app.js');
    const bootFile = path.join(directory, 'boot.js');
    await fs.writeFile(appFile, 'export function createChatApp(options) { return globalThis.__startupProbe.createChatApp(options); }\n');
    // `failImport` makes the module itself throw when evaluated: the dynamic
    // import() rejects, exactly like a chunk that cannot be fetched.
    await fs.writeFile(bootFile, [
        'if (globalThis.__startupProbe.failImport) throw new Error("the boot chunk could not be loaded");',
        'export async function bootZkapiPayments(...args) { return globalThis.__startupProbe.boot(...args); }',
        ''
    ].join('\n'));
    const result = await build({
        entryPoints: [path.join(repoRoot, 'chat/startup.js')], bundle: true, write: false, format: 'esm',
        platform: 'node', logLevel: 'silent', define: { __OA_ZKAPI_NETWORK__: JSON.stringify(network) },
        plugins: [{ name: 'startup-doubles', setup(b) {
            b.onResolve({ filter: /^\.\/app\.js$/ }, () => ({ path: appFile }));
            b.onResolve({ filter: /^\.\/zkapi\/boot\.js$/ }, () => ({ path: bootFile }));
        } }]
    });
    const text = Buffer.from(result.outputFiles[0].contents).toString('utf8');
    const calls = { boot: [], app: [] };
    globalThis.__startupProbe = {
        failImport,
        boot: (...args) => { calls.boot.push(args); return boot(...args); },
        createChatApp: options => { calls.app.push(options); return app(options); }
    };
    t.after(() => { delete globalThis.__startupProbe; });
    const module = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
    return { startChatApp: module.startChatApp, calls };
}

test('startup boots payments with no arguments and never forwards its options to boot', async t => {
    const integration = { runtime: { marker: 'runtime' }, ui: { marker: 'ui' } };
    const { startChatApp, calls } = await loadStartup(t, {
        boot: async () => ({ integration }),
        app: options => ({ options })
    });
    const seams = {
        table: [{ id: 'evil' }], database: 'chosen-by-the-caller', importSdk: () => {}, loadVariant: () => {},
        readHoldings: () => {}, facade: {}, network: 'mainnet', baseURI: 'https://evil.example/'
    };
    const app = await startChatApp({ ...seams, theme: 'dark' });
    assert.deepEqual(calls.boot, [[]], 'bootZkapiPayments() received no argument at all');
    assert.deepEqual(app.options, { ...seams, theme: 'dark', ...integration, analytics: false });
});

test('startup skips payments for ticket-only options without booting', async t => {
    const { startChatApp, calls } = await loadStartup(t, {
        boot: async () => assert.fail('must not boot'), app: options => ({ options })
    });
    for (const options of [{ payments: false }, { payments: { zkapi: false } }, { runtime: { custom: true } }]) {
        calls.app.length = 0;
        await startChatApp(options);
        assert.equal(calls.boot.length, 0);
        assert.equal(calls.app.length, 1);
        assert.equal('payments' in calls.app[0], false, 'payments is consumed, not forwarded');
    }
    const noNetwork = await loadStartup(t, { network: '', boot: async () => assert.fail('must not boot'), app: options => ({ options }) });
    await noNetwork.startChatApp({});
    assert.equal(noNetwork.calls.boot.length, 0);
});

test('startup: when boot reports unavailable the app starts ticket-only and toasts once', async t => {
    const toasts = [];
    let ready;
    const { startChatApp, calls } = await loadStartup(t, {
        boot: async () => ({ integration: null, unavailable: { code: 'sdk_unavailable', message: 'zkAPI could not start.' } }),
        app: options => {
            const app = { options, ready: new Promise(resolve => { ready = resolve; }),
                showToast: (...args) => toasts.push(args) };
            return app;
        }
    });
    const app = await startChatApp({ theme: 'dark' });
    assert.deepEqual(calls.app, [{ theme: 'dark', analytics: false }], 'no payment integration');
    assert.equal(app.options.runtime, undefined);
    assert.deepEqual(toasts, [], 'not before the app has finished starting');
    ready();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(toasts, [['zkAPI could not start.', 'error', 9000]]);
});

test('startup: a boot chunk that cannot be loaded starts the app ticket-only and says so', async t => {
    const toasts = [];
    const { startChatApp, calls } = await loadStartup(t, {
        failImport: true,
        boot: async () => assert.fail('the chunk never loaded'),
        app: options => ({ options, ready: Promise.resolve(), showToast: (...args) => toasts.push(args) })
    });
    const app = await startChatApp({ theme: 'dark' });
    assert.ok(app, 'the app starts instead of the page staying blank');
    assert.deepEqual(calls.app, [{ theme: 'dark', analytics: false }], 'no payment integration');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0][1], 'error');
    assert.match(toasts[0][0], /could not start/);
});

test('startup: an app whose readiness fails still starts and never throws for the toast', async t => {
    const { startChatApp } = await loadStartup(t, {
        boot: async () => ({ integration: null, unavailable: { code: 'boot_failed' } }),
        app: () => ({ ready: Promise.reject(new Error('init failed')), showToast() { throw new Error('toast broke'); } })
    });
    const app = await startChatApp({});
    assert.ok(app);
    await new Promise(resolve => setImmediate(resolve));
});

test('startup: a ticket-only stub boot (no integration, no unavailability) starts silently', async t => {
    const toasts = [];
    const { startChatApp, calls } = await loadStartup(t, {
        boot: async () => ({ integration: null }),
        app: options => ({ options, ready: Promise.resolve(), showToast: (...args) => toasts.push(args) })
    });
    await startChatApp({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.app.length, 1);
    assert.deepEqual(toasts, []);
});

// ------------------------------------------------- the static import contract

test('boot.js statically reaches no SDK module: the SDK and the payment adapter load only after loadVariant', async t => {
    const { build } = await import('esbuild');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-boot-graph-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const result = await build({
        entryPoints: { boot: path.join(repoRoot, 'chat/zkapi/boot.js') },
        bundle: true, splitting: true, format: 'esm', platform: 'node', outdir: directory, write: false,
        metafile: true, logLevel: 'silent', absWorkingDir: repoRoot,
        // Anything the browser app would resolve to the SDK stays a visible,
        // external import: nothing here ever executes it.
        external: ['@openanonymity/*', 'ethers', 'qrcode', 'supertokens-web-js']
    });
    const outputs = result.metafile.outputs;
    const entry = Object.entries(outputs).find(([, info]) => info.entryPoint?.endsWith('chat/zkapi/boot.js'));
    assert.ok(entry, 'boot.js is an entry');
    // Every chunk reachable from the entry through STATIC imports only.
    const reachable = new Set();
    const visit = file => {
        if (reachable.has(file)) return;
        reachable.add(file);
        for (const imported of outputs[file].imports) {
            if (imported.kind === 'import-statement' && outputs[imported.path]) visit(imported.path);
        }
    };
    visit(entry[0]);
    const staticInputs = new Set();
    for (const file of reachable) {
        for (const imported of outputs[file].imports) {
            if (imported.kind === 'import-statement') {
                assert.doesNotMatch(imported.path, /@openanonymity|ethers/, `${file} statically imports ${imported.path}`);
            }
        }
        for (const input of Object.keys(outputs[file].inputs)) staticInputs.add(input);
    }
    for (const forbidden of ['chat/zkapi/index.js', 'chat/zkapi/services/canceledDeposit.mjs',
        'chat/zkapi/versioning/ui.js', 'chat/zkapi/services/paymentModeRuntime.js',
        // The give-up imports the SDK (reached only when a person confirms
        // it), and the history reader is needed only when the payment
        // history is opened: neither belongs to the boot chunk of a build
        // that has no versions to tell apart.
        'chat/zkapi/services/abandonedNote.mjs', 'chat/zkapi/versioning/otherVersionHistory.mjs']) {
        assert.equal(staticInputs.has(forbidden), false, `${forbidden} must load dynamically`);
    }
    // They are bundled, as chunks of their own, so the dynamic import resolves.
    const everyInput = new Set(Object.values(outputs).flatMap(info => Object.keys(info.inputs)));
    for (const loaded of ['chat/zkapi/services/abandonedNote.mjs', 'chat/zkapi/versioning/otherVersionHistory.mjs']) {
        assert.ok(everyInput.has(loaded), `${loaded} is part of the bundle`);
    }
    // And the SDK-facing modules ARE reachable, but only dynamically.
    const dynamic = new Set();
    for (const info of Object.values(outputs)) {
        for (const imported of info.imports) if (imported.kind === 'dynamic-import') dynamic.add(imported.path);
    }
    assert.ok([...dynamic].some(file => /@openanonymity\/zkapi-browser-sdk\/client/.test(file)));
    assert.ok([...dynamic].some(file => /@openanonymity\/zkapi-browser-sdk\/runtime/.test(file)));
    assert.ok([...dynamic].some(file => /@openanonymity\/zkapi-browser-sdk\/store/.test(file)));
    // The loader is used for real (a side-effect-only import is tree-shaken).
    assert.ok(staticInputs.has('chat/zkapi/versioning/variants.js'));
});

test('the checked-in variant loader stub has exactly one export and rejects with no_variants', async () => {
    const module = await import('../../chat/zkapi/versioning/variants.js');
    assert.deepEqual(Object.keys(module), ['loadVariant']);
    await assert.rejects(module.loadVariant('v1'), error => error.code === 'no_variants');
    await assert.rejects(module.loadVariant(), error => error.code === 'no_variants');
});
