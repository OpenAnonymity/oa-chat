// The deposit guard over the REAL singletons of a successor SDK (circuit
// zkapi-v2-concession-v1). zkapi-deposit-guard.test.mjs covers the legacy SDK
// and the fixture stand-in, and the fixture only has the names somebody copied
// into it. This file reads the real client and runtime classes, so a
// /deposit/i method an SDK revision adds is found here, before a closed
// version lets it start or finish a deposit by accident.
//
// It found two at 4b955d9 (confirmedDepositFor, completeConfirmedDeposit): the
// background reconcile and the foreground confirmation of one deposit can race,
// and confirmDeposit finishes the second path through them. Deny by default
// wraps an unclassified /deposit/i function, so unclassified they would have
// been refused on a closed version, and a deposit that was already sent could
// not have been completed there.
//
// Skipped unless a successor SDK is installed under its registry alias or
// unpacked at ZKAPI_V2_SDK_DIR (the same rule as the other activation-time
// tests); nothing of the SDK is run beyond evaluating its modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    installDepositGuard, unclassifiedDepositEntryPoints
} from '../../chat/zkapi/versioning/depositGuard.mjs';
import { concessionV1 } from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { createFakeEnvironment, createFakeStorage } from './_fakeIndexedDb.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function successorRoot() {
    if (process.env.ZKAPI_V2_SDK_DIR) {
        const root = path.resolve(process.env.ZKAPI_V2_SDK_DIR);
        return fs.existsSync(path.join(root, 'sdk/wallet.js')) ? root : null;
    }
    const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'deployments/zkapi/registry.json'), 'utf8'));
    for (const row of registry.versions) {
        if (row.sdk.alias === '@openanonymity/zkapi-browser-sdk') continue;
        const root = path.join(repoRoot, 'node_modules', row.sdk.alias);
        if (fs.existsSync(path.join(root, 'sdk/wallet.js'))) return root;
    }
    return null;
}

const SDK_ROOT = successorRoot();
const skip = SDK_ROOT ? false : 'no successor SDK is installed (registry alias, or ZKAPI_V2_SDK_DIR)';

// Evaluating the client publishes globalThis.zkapiClient (one SDK per page);
// put back whatever was there so no other test sees this one's singleton.
const publishedClient = globalThis.zkapiClient;
let client = null;
let runtime = null;
if (SDK_ROOT) {
    if (!globalThis.crypto) globalThis.crypto = webcrypto;
    createFakeEnvironment().install();
    globalThis.localStorage = createFakeStorage();
    globalThis.location ??= { href: 'https://app.example/', origin: 'https://app.example', search: '' };
    globalThis.window ??= { dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setInterval: () => 0, clearInterval() {} };
    globalThis.CustomEvent ??= class CustomEvent extends Event {
        constructor(type, options) { super(type); this.detail = options?.detail; }
    };
    const services = path.join(SDK_ROOT, 'sdk/services');
    const load = file => import(pathToFileURL(file).href);
    const [runtimeModule, clientModule] = await Promise.all([
        load(path.join(services, 'browserWalletRuntime.js')),
        load(path.join(services, 'zkapiClient.js'))
    ]);
    runtime = runtimeModule.default;
    client = clientModule.default;
    if (publishedClient === undefined) delete globalThis.zkapiClient;
    else globalThis.zkapiClient = publishedClient;
}

const CLOSED = { canStart: false, canResume: false, code: 'deposits_closed', successor: { id: 'v3', label: 'Version 3' } };
const VERSION = { id: 'v2', label: 'Version 2', status: 'exit-only', depositsClosedSince: Date.parse('2026-11-01T00:00:00Z') };

test('the drift detector classifies every /deposit/i method of the REAL successor singletons', { skip }, () => {
    const drift = unclassifiedDepositEntryPoints({ client, runtime, adapter: concessionV1 });
    assert.deepEqual(drift, { client: [], runtime: [] },
        'a /deposit/i method the adapter does not classify: name it in depositEntryPoints (it starts or quotes a '
        + 'deposit) or recoveryEntryPoints (it finishes, reads or recovers one) in adapters/concessionV1.mjs');
    // Every method the adapter guards exists on the SDK: a rename would leave a hole.
    for (const name of concessionV1.depositEntryPoints.client) assert.equal(typeof client[name], 'function', name);
    for (const name of concessionV1.depositEntryPoints.runtime) assert.equal(typeof runtime[name], 'function', name);
});

test('on a closed version only the listed entry points are refused; every recovery name reaches the SDK', { skip }, t => {
    const uninstall = installDepositGuard({ client, runtime, adapter: concessionV1, getGate: () => CLOSED, version: VERSION });
    t.after(uninstall);
    assert.deepEqual([...uninstall.wrapped.client].sort(), [...concessionV1.depositEntryPoints.client].sort());
    assert.deepEqual([...uninstall.wrapped.runtime].sort(), [...concessionV1.depositEntryPoints.runtime].sort());
    // The two the race needs, named: confirming a deposit that was already sent
    // goes through them and must stay possible after deposits close. They exist
    // from 4b955d9 on; an older revision (82c8504) has only confirmDeposit.
    assert.equal(typeof runtime.confirmDeposit, 'function');
    for (const name of ['completeConfirmedDeposit', 'confirmedDepositFor', 'confirmDeposit']) {
        if (typeof runtime[name] !== 'function') continue;
        assert.equal(Object.prototype.hasOwnProperty.call(runtime, name), false, `${name} is not wrapped`);
    }
    assert.equal(typeof runtime.completeConfirmedDeposit, typeof runtime.confirmedDepositFor,
        'the two helpers come together');
    for (const side of [['client', client], ['runtime', runtime]]) {
        for (const name of concessionV1.recoveryEntryPoints[side[0]]) {
            if (typeof side[1][name] !== 'function') continue;
            assert.equal(Object.prototype.hasOwnProperty.call(side[1], name), false, `${side[0]}.${name} is not wrapped`);
        }
    }
});
