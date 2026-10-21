import test from 'node:test';
import assert from 'node:assert/strict';
// The real SDK auth class (not exported by the package), so restoration runs
// through its actual dedupe, change-password and 401 behavior.
import { TestnetPasswordAuth, TESTNET_PASSWORD_HEADER } from '../../node_modules/@openanonymity/zkapi-browser-sdk/sdk/services/testnetPasswordAuth.mjs';
import { createTestnetPasswordMemory, TESTNET_PASSWORD_STORAGE_KEY } from '../../chat/zkapi/services/testnetPasswordMemory.mjs';

const SERVICE = 'https://sepolia.zkapi.test/api';
const SEPOLIA = { chain_id: 11155111, protocol_server_url: `${SERVICE}/` };

function memoryStorage() {
    const values = new Map();
    const storage = {
        values,
        refuseSaves: false, // quota: the probe still succeeds, the real save throws
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => {
            if (storage.refuseSaves && key === TESTNET_PASSWORD_STORAGE_KEY) throw new DOMException('full', 'QuotaExceededError');
            values.set(key, String(value));
        },
        removeItem: key => values.delete(key)
    };
    return storage;
}

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

const entryFor = (service, password) => JSON.stringify({ v: 1, service, password });

// The browser state that survives a reload (storage, server password) is
// shared; each page() call is a fresh load with fresh SDK and host state.
function world({ storage = memoryStorage(), serverPassword = 'group-pass-one' } = {}) {
    const state = { storage, serverPassword, authCalls: [], online: true };
    // holdAuth: called with the sent password before /v2/auth answers, so a
    // test can delay this page's server response. onPrompt: runs when the
    // dialog opens, before it answers (another tab acting meanwhile).
    state.page = ({ funding = SEPOLIA, storageGetter = () => state.storage, dialogAnswers = [], holdAuth, onPrompt } = {}) => {
        const prompts = [];
        const auth = new TestnetPasswordAuth({
            funding,
            fetch: async (url, init) => {
                if (!state.online) throw new TypeError('Failed to fetch');
                if (url.endsWith('/health')) return Response.json({ chain_id: funding.chain_id, testnet_password_required: true });
                const sent = new Headers(init.headers).get(TESTNET_PASSWORD_HEADER);
                await holdAuth?.(sent);
                state.authCalls.push(sent);
                return sent === state.serverPassword ? Response.json({ authenticated: true })
                    : Response.json({ error_code: 'testnet_password_required' }, { status: 401 });
            },
            requestPassword: null
        });
        const memory = createTestnetPasswordMemory({ getFunding: () => funding, storage: storageGetter });
        auth.requestPassword = memory.wrap(async ({ authenticate, signal, remember }) => {
            prompts.push({ remember });
            await onPrompt?.();
            const answer = dialogAnswers.shift();
            if (!answer) throw Object.assign(new Error('canceled'), { code: 'testnet_auth_canceled' });
            await authenticate(answer.password, { signal, remember: answer.remember });
        });
        const client = {
            ensureTestnetAccess: options => auth.ensure(options),
            get testnetAuthenticated() { return auth.authenticated; }
        };
        return { auth, memory, client, prompts };
    };
    state.saved = () => JSON.parse(state.storage.values.get(TESTNET_PASSWORD_STORAGE_KEY) ?? 'null');
    return state;
}

test('an accepted password is saved for this Sepolia service and restored after reload without a dialog', async () => {
    const w = world();
    const first = w.page({ dialogAnswers: [{ password: 'group-pass-one', remember: true }] });
    await first.client.ensureTestnetAccess({ interactive: true });
    assert.deepEqual(first.prompts, [{ remember: true }]);
    assert.deepEqual(w.saved(), { v: 1, service: SERVICE, password: 'group-pass-one' });

    const reloaded = w.page();
    w.authCalls.length = 0;
    assert.equal(await reloaded.memory.restore(reloaded.client), true);
    assert.equal(reloaded.client.testnetAuthenticated, true);
    assert.deepEqual(reloaded.prompts, []);
    assert.deepEqual(w.authCalls, ['group-pass-one']);
    // A later explicit action reuses the restored credential.
    await reloaded.client.ensureTestnetAccess({ interactive: true });
    assert.deepEqual(reloaded.prompts, []);
});

test('initializeWith restores once, only after a successful client start', async () => {
    const w = world();
    w.storage.setItem(TESTNET_PASSWORD_STORAGE_KEY, JSON.stringify({ v: 1, service: SERVICE, password: 'group-pass-one' }));
    const p = w.page();
    let starts = 0;
    let fail = true;
    const initialize = p.memory.initializeWith(async () => {
        starts++;
        if (fail) throw new Error('start failed');
        if (starts === 2) assert.equal(p.client.testnetAuthenticated, false, 'restore runs after the start');
        return 'started';
    }, p.client);
    await assert.rejects(initialize(), /start failed/);
    assert.equal(w.authCalls.length, 0);
    fail = false;
    assert.equal(await initialize(), 'started');
    assert.equal(p.client.testnetAuthenticated, true);
    assert.equal(await initialize(), 'started');
    assert.equal(starts, 3);
    assert.equal(w.authCalls.length, 1);
});

test('a rotated password is forgotten on restore without opening a dialog, then asked for on the next action', async () => {
    const w = world();
    w.storage.setItem(TESTNET_PASSWORD_STORAGE_KEY, JSON.stringify({ v: 1, service: SERVICE, password: 'group-pass-one' }));
    w.serverPassword = 'group-pass-two';
    const p = w.page({ dialogAnswers: [{ password: 'group-pass-two', remember: true }] });
    assert.equal(await p.memory.restore(p.client), false);
    assert.deepEqual(p.prompts, []);
    assert.equal(w.saved(), null);
    await p.client.ensureTestnetAccess({ interactive: true });
    assert.equal(p.prompts.length, 1);
    assert.equal(w.saved().password, 'group-pass-two');
});

test('Change password opens the dialog even with a saved value, and replaces or forgets it', async () => {
    const w = world();
    w.storage.setItem(TESTNET_PASSWORD_STORAGE_KEY, JSON.stringify({ v: 1, service: SERVICE, password: 'group-pass-one' }));
    const p = w.page({ dialogAnswers: [
        { password: 'group-pass-one', remember: true },
        { password: 'group-pass-one', remember: false }
    ] });
    assert.equal(await p.memory.restore(p.client), true);
    await p.client.ensureTestnetAccess({ interactive: true, changePassword: true });
    assert.equal(p.prompts.length, 1, 'the saved value is not silently reused');
    assert.equal(w.saved().password, 'group-pass-one');
    // Unchecking "Remember" is the explicit clear: this tab stays unlocked.
    await p.client.ensureTestnetAccess({ interactive: true, changePassword: true });
    assert.equal(p.prompts.length, 2);
    assert.equal(w.saved(), null);
    assert.equal(p.client.testnetAuthenticated, true);
    const reloaded = w.page();
    w.authCalls.length = 0;
    assert.equal(await reloaded.memory.restore(reloaded.client), false);
    assert.deepEqual(w.authCalls, [], 'nothing is sent after clearing');
});

test('a server 401 after restore asks again instead of resending the saved value', async () => {
    const w = world();
    w.storage.setItem(TESTNET_PASSWORD_STORAGE_KEY, JSON.stringify({ v: 1, service: SERVICE, password: 'group-pass-one' }));
    const p = w.page({ dialogAnswers: [{ password: 'group-pass-two', remember: true }] });
    assert.equal(await p.memory.restore(p.client), true);
    w.serverPassword = 'group-pass-two';
    p.auth.clear(); // what the SDK does when a protected request returns 401
    w.authCalls.length = 0;
    await p.client.ensureTestnetAccess({ interactive: true });
    assert.equal(p.prompts.length, 1);
    assert.deepEqual(w.authCalls, ['group-pass-two']);
    assert.equal(w.saved().password, 'group-pass-two');
});

test('a network failure during restore keeps the saved value for the next action', async () => {
    const w = world();
    w.storage.setItem(TESTNET_PASSWORD_STORAGE_KEY, JSON.stringify({ v: 1, service: SERVICE, password: 'group-pass-one' }));
    const p = w.page();
    w.online = false;
    assert.equal(await p.memory.restore(p.client), false);
    assert.equal(w.saved().password, 'group-pass-one');
    w.online = true;
    await p.client.ensureTestnetAccess({ interactive: true });
    assert.deepEqual(p.prompts, [], 'the saved value is offered before any dialog');
    assert.equal(p.client.testnetAuthenticated, true);
});

test('unavailable or failing storage falls back to the tab-only dialog without errors', async () => {
    const throwing = () => { throw new DOMException('denied', 'SecurityError'); };
    const refusing = { getItem: () => null, setItem: throwing, removeItem: throwing };
    for (const storageGetter of [throwing, () => null, () => refusing]) {
        const w = world();
        const p = w.page({ storageGetter, dialogAnswers: [{ password: 'group-pass-one', remember: true }] });
        assert.equal(await p.memory.restore(p.client), false);
        await p.client.ensureTestnetAccess({ interactive: true });
        assert.deepEqual(p.prompts, [{ remember: undefined }], 'no Remember choice is offered');
        assert.equal(p.client.testnetAuthenticated, true);
        assert.equal(w.storage.values.size, 0);
    }
});

test('Mainnet and other Sepolia services never read, send or write the saved value', async () => {
    const w = world();
    const entry = JSON.stringify({ v: 1, service: SERVICE, password: 'group-pass-one' });
    w.storage.setItem(TESTNET_PASSWORD_STORAGE_KEY, entry);
    let ensured = 0;
    const mainnet = createTestnetPasswordMemory({ getFunding: () => ({ chain_id: 1, protocol_server_url: `${SERVICE}/` }), storage: () => w.storage });
    assert.equal(await mainnet.restore({ ensureTestnetAccess: async () => { ensured++; } }), false);
    assert.equal(ensured, 0);
    const mainnetDialog = mainnet.wrap(async options => { assert.equal(options.remember, undefined); });
    await mainnetDialog({ authenticate: async () => assert.fail('nothing is offered') });

    const other = w.page({ funding: { chain_id: 11155111, protocol_server_url: 'https://other.zkapi.test/' } });
    assert.equal(await other.memory.restore(other.client), false);
    assert.deepEqual(w.authCalls, []);
    assert.equal(w.storage.values.get(TESTNET_PASSWORD_STORAGE_KEY), entry);
});

test('a delayed rejection in one tab keeps the replacement another tab saved meanwhile', async () => {
    const w = world({ serverPassword: 'group-pass-two' });
    w.storage.setItem(TESTNET_PASSWORD_STORAGE_KEY, entryFor(SERVICE, 'group-pass-one'));
    const sent = deferred();
    const answer = deferred();
    const tabA = w.page({ holdAuth: async () => { sent.resolve(); await answer.promise; } });
    const restoringA = tabA.memory.restore(tabA.client);
    await sent.promise; // tab A offered the old value; the server's 401 is still in flight

    const tabB = w.page({ dialogAnswers: [{ password: 'group-pass-two', remember: true }] });
    assert.equal(await tabB.memory.restore(tabB.client), false);
    assert.equal(w.saved(), null, 'tab B forgets the old value it was refused');
    await tabB.client.ensureTestnetAccess({ interactive: true });
    assert.deepEqual(w.saved(), { v: 1, service: SERVICE, password: 'group-pass-two' });

    answer.resolve();
    assert.equal(await restoringA, false);
    assert.deepEqual(tabA.prompts, []);
    assert.deepEqual(w.saved(), { v: 1, service: SERVICE, password: 'group-pass-two' }, 'the late 401 does not delete the newer value');

    const reloaded = w.page();
    w.authCalls.length = 0;
    assert.equal(await reloaded.memory.restore(reloaded.client), true);
    assert.deepEqual(w.authCalls, ['group-pass-two']);
});

test('another service never removes this service\'s entry by a rejection, opt-out or failed save', async () => {
    const OTHER = { chain_id: 11155111, protocol_server_url: 'https://other.zkapi.test/' };
    const w = world();
    w.storage.setItem(TESTNET_PASSWORD_STORAGE_KEY, entryFor('https://other.zkapi.test', 'other-stale'));
    const sent = deferred();
    const answer = deferred();
    const otherTab = w.page({ funding: OTHER, holdAuth: async () => { sent.resolve(); await answer.promise; } });
    const restoringOther = otherTab.memory.restore(otherTab.client);
    await sent.promise;

    const tab = w.page({ dialogAnswers: [{ password: 'group-pass-one', remember: true }] });
    await tab.client.ensureTestnetAccess({ interactive: true });
    const saved = entryFor(SERVICE, 'group-pass-one');
    assert.equal(w.storage.values.get(TESTNET_PASSWORD_STORAGE_KEY), saved);

    answer.resolve();
    assert.equal(await restoringOther, false);
    assert.equal(w.storage.values.get(TESTNET_PASSWORD_STORAGE_KEY), saved, 'the late 401 for the other service keeps it');

    const optOut = w.page({ funding: OTHER, dialogAnswers: [{ password: 'group-pass-one', remember: false }] });
    await optOut.client.ensureTestnetAccess({ interactive: true });
    assert.equal(optOut.prompts.length, 1);
    assert.equal(w.storage.values.get(TESTNET_PASSWORD_STORAGE_KEY), saved, 'unchecking Remember elsewhere keeps it');

    const failedSave = w.page({
        funding: OTHER,
        dialogAnswers: [{ password: 'group-pass-one', remember: true }],
        onPrompt: () => { w.storage.refuseSaves = true; }
    });
    await failedSave.client.ensureTestnetAccess({ interactive: true });
    assert.equal(failedSave.client.testnetAuthenticated, true);
    assert.equal(w.storage.values.get(TESTNET_PASSWORD_STORAGE_KEY), saved, 'a failed save elsewhere keeps it');
});

test('a failed save drops only the value its dialog replaced, not one another tab saved meanwhile', async () => {
    for (const anotherTabSaves of [false, true]) {
        const w = world();
        w.storage.setItem(TESTNET_PASSWORD_STORAGE_KEY, entryFor(SERVICE, 'group-pass-one'));
        const p = w.page({
            dialogAnswers: [{ password: 'group-pass-two', remember: true }],
            onPrompt: () => {
                w.serverPassword = 'group-pass-two';
                if (anotherTabSaves) w.storage.setItem(TESTNET_PASSWORD_STORAGE_KEY, entryFor(SERVICE, 'group-pass-two'));
                w.storage.refuseSaves = true;
            }
        });
        assert.equal(await p.memory.restore(p.client), true);
        await p.client.ensureTestnetAccess({ interactive: true, changePassword: true });
        assert.equal(p.client.testnetAuthenticated, true);
        assert.equal(w.saved()?.password ?? null, anotherTabSaves ? 'group-pass-two' : null);
    }
});
