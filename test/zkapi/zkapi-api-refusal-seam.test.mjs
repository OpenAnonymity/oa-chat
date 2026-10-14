// A refused key request is the one place a chat learns why it cannot start.
// chat/zkapi/api.js hands that refusal to the versioning facade (when the page
// has versions to tell apart) so the balance can say it as a notice, and
// rethrows the very same error. The request path itself is untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Replace only browser storage, network and wallet boundaries (as the header
// normalization test does); the production API composition runs for real.
const values = new Map();
const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
};
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', origin: 'https://chat.example', href: 'https://chat.example/', search: '' };
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.document = {
    querySelector: () => null, getElementById: () => null, addEventListener() {},
    documentElement: { dataset: {}, classList: { contains: () => false } }
};
const request = result => {
    const value = {};
    queueMicrotask(() => { value.result = result; value.onsuccess?.({ target: value }); });
    return value;
};
const settings = { get: () => request(undefined), put: () => request(undefined), delete: () => request(undefined) };
globalThis.indexedDB = { open: () => request({ version: 4, close() {}, transaction: () => ({ objectStore: () => settings }) }) };
globalThis.zkapiWallet = new Proxy({ ABI: [] }, {
    get: (target, key) => key in target ? target[key] : (() => null)
});

const { ZkapiAPI } = await import('../../chat/zkapi/api.js');
const { default: zkapiClient } = await import('@openanonymity/zkapi-browser-sdk/client');
const { createZkapiVersioning } = await import('../../chat/zkapi/versioning/index.js');
const { chooseZkapiVersion } = await import('../../chat/zkapi/versioning/versionLoader.mjs');
const { installActiveVersion, resetActiveVersionForTests } = await import('../../chat/zkapi/versioning/activeVersion.mjs');
const { activatedRegistry, resolvedTable, validRegistry } = await import('./_registryFixtures.mjs');
const { createFakeStorage } = await import('./_fakeIndexedDb.mjs');

const FIXTURE = JSON.parse(fs.readFileSync(
    new URL('../fixtures/zkapi-v2-real-shapes/snapshots.json', import.meta.url), 'utf8'
));
const NOW = FIXTURE.generatedAtMs;

async function keyRequestFailing(t, error, options) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ 'provider/cheap-mini': 1 })));
    t.mock.method(zkapiClient, 'acquireInferenceAccess', async () => { throw error; });
    const api = new ZkapiAPI({ modelCatalog: { getCachedModels: () => [] }, ...options });
    return api.options.acquireRequestAccess('session-1', { modelId: 'provider/cheap-mini' });
}

const sdkError = name => {
    const { name: errorName, status, code, data, message } = FIXTURE.errors[name];
    return Object.assign(new Error(message), { name: errorName, status, code, data: structuredClone(data) });
};

test('a refused key request is handed to the attached facade once and thrown unchanged', async t => {
    const seen = [];
    zkapiClient.oaVersioning = { multiVersion: true, noteRefusal: (...args) => seen.push(args) };
    try {
        const error = sdkError('note_near_expiry');
        await assert.rejects(keyRequestFailing(t, error), candidate => candidate === error);
        // A chat key is drawn from the balance in the slot and from no other:
        // the one producer that can say which balance an attempt was about.
        assert.deepEqual(seen, [[error, { slot: true }]], 'the error object itself, said to be about the slot balance');
        assert.equal(error.message, FIXTURE.errors.note_near_expiry.message, 'the words are the SDK\'s until a surface rewrites them');
    } finally {
        delete zkapiClient.oaVersioning;
    }
});

test('a page with no versions to tell apart is told nothing', async t => {
    const seen = [];
    zkapiClient.oaVersioning = { multiVersion: false, noteRefusal: (...args) => seen.push(args) };
    try {
        await assert.rejects(keyRequestFailing(t, sdkError('note_near_expiry')), /too close to its expiry/);
        assert.deepEqual(seen, []);
        t.mock.restoreAll();
        // And no facade at all is the same page.
        delete zkapiClient.oaVersioning;
        await assert.rejects(keyRequestFailing(t, sdkError('note_near_expiry')), /too close to its expiry/);
    } finally {
        delete zkapiClient.oaVersioning;
    }
});

test('a facade that throws never changes what the chat sees', async t => {
    zkapiClient.oaVersioning = { multiVersion: true, noteRefusal() { throw new Error('facade bug'); } };
    try {
        const error = sdkError('exit_locked');
        await assert.rejects(keyRequestFailing(t, error), candidate => candidate === error);
        t.mock.restoreAll();
        const hostile = {};
        Object.defineProperty(hostile, 'multiVersion', { get() { throw new Error('getter bug'); } });
        zkapiClient.oaVersioning = hostile;
        await assert.rejects(keyRequestFailing(t, error), candidate => candidate === error);
    } finally {
        delete zkapiClient.oaVersioning;
    }
});

test('the hook can be replaced, runs after the retirement signal, and cannot mask the error', async t => {
    zkapiClient.oaVersioning = { multiVersion: true, noteRefusal() { throw new Error('the default must not run'); } };
    try {
        const order = [];
        const error = Object.assign(new Error('gone'), { status: 410, code: 'deployment_retiring' });
        await assert.rejects(keyRequestFailing(t, error, {
            onAdmissionClosed: code => order.push(`closed:${code}`),
            onAccessRefused: candidate => order.push(candidate === error ? 'refused' : 'other')
        }), candidate => candidate === error);
        assert.deepEqual(order, ['closed:deployment_retiring', 'refused']);
        t.mock.restoreAll();

        const plain = new Error('plain');
        await assert.rejects(keyRequestFailing(t, plain, {
            onAccessRefused() { throw new Error('hook bug'); }
        }), candidate => candidate === plain);
    } finally {
        delete zkapiClient.oaVersioning;
    }
});

test('through the real facade a chat refused near expiry leaves the balance told, not only the toast', async t => {
    const table = resolvedTable(activatedRegistry(), 'mainnet');
    const version = table.find(row => row.id === 'v2');
    resetActiveVersionForTests();
    installActiveVersion({
        table, version,
        selection: chooseZkapiVersion({
            table, slotKind: 'note',
            holdings: [{ deploymentId: version.deploymentId, runtime: true, withdrawals: [], credits: [] }]
        })
    });
    const facade = createZkapiVersioning({
        buildTable: table, network: 'mainnet', now: () => NOW,
        sessionStorage: createFakeStorage(), localStorage: createFakeStorage()
    });
    const scenario = structuredClone(FIXTURE.scenarios.just_outside_near_expiry);
    const config = {
        ...scenario.clientSnapshot.config,
        funding: { ...scenario.clientSnapshot.config.funding, contract_address: version.vault, chain_id: version.chainId }
    };
    facade.attach({
        client: {
            initialized: true, lastError: null, activities: [], withdrawals: [], deposits: [], noteExpiryClaim: null,
            config, wallet: scenario.clientSnapshot.wallet,
            snapshot() { return { config: this.config, wallet: this.wallet, withdrawals: [], deposits: [], activities: [] }; },
            subscribe: () => () => {}
        },
        runtime: { runtime: scenario.runtime, manifest: { deployment_id: version.deploymentId } },
        integrity: 'ok'
    });
    zkapiClient.oaVersioning = facade;
    t.after(() => {
        delete zkapiClient.oaVersioning;
        facade.resetForTests();
        resetActiveVersionForTests();
    });
    assert.equal(facade.state(NOW).exit.nearExpiry, false);
    const error = sdkError('note_near_expiry');
    await assert.rejects(keyRequestFailing(t, error), candidate => candidate === error);
    assert.equal(facade.state(NOW).exit.nearExpiry, true);
    // It is a fact about the balance the chat was refused for: it stands
    // until the slot holds another note, not for a minute.
    assert.equal(facade.state(NOW + 2 * 60 * 60 * 1000).exit.nearExpiry, true);

    // A single-version page (the same facade type, one row) stays unaware.
    t.mock.restoreAll();
    const single = resolvedTable(validRegistry(), 'mainnet');
    resetActiveVersionForTests();
    installActiveVersion({
        table: single, version: single[0],
        selection: chooseZkapiVersion({
            table: single, slotKind: 'note',
            holdings: [{ deploymentId: single[0].deploymentId, runtime: true, withdrawals: [], credits: [] }]
        })
    });
    const calm = createZkapiVersioning({ buildTable: single, network: 'mainnet', now: () => NOW });
    let reads = 0;
    const original = calm.noteRefusal;
    calm.noteRefusal = (...args) => { reads += 1; return original(...args); };
    zkapiClient.oaVersioning = calm;
    await assert.rejects(keyRequestFailing(t, sdkError('note_near_expiry')), /too close to its expiry/);
    assert.equal(reads, 0, 'a page with one version is never asked');
});
