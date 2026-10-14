// The confirmed "Give up this balance": chat/zkapi/services/abandonedNote.mjs,
// over the REAL wallet store and runtime of the installed SDK on the in-memory
// IndexedDB and Web Locks of _fakeIndexedDb.mjs (and of every registry alias
// that is installed, or of an unpacked successor named by
// ZKAPI_V2_SDK_DIR for an activation-time run).
//
// Pins: one exclusive ifAvailable lock (and a test that fails fast instead of
// hanging when that is lost); runtime.init() before it, never inside it; a
// fresh reload and the strict verdict inside it; the SDK's own archive
// transaction (one commit over slot, archives and deposits) with the change
// announced after it and still inside the lock, and the note id handed to it so
// the SDK checks the note again itself; nothing written on any refusal; every
// fact that cannot be read refuses (client getters, request list, request
// archive, withdrawal list); the family opt-in and the operator switch are
// enforced by the service itself; the archive keeps the note state; the loader
// then picks the deposit target; the support restore procedure works; and every
// slot field an SDK's archive drops is one the strict verdict refuses on.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as installedStore from '@openanonymity/zkapi-browser-sdk/store';
import { defaultWalletStore, giveUpBalance } from '../../chat/zkapi/services/abandonedNote.mjs';
import { abandonVerdict } from '../../chat/zkapi/versioning/abandonNote.mjs';
import { chooseZkapiVersion } from '../../chat/zkapi/versioning/versionLoader.mjs';
import {
    WALLET_CHANNEL_NAME, WALLET_LOCK_NAME, describeSlot, knownSlotKeys, readWalletHoldings
} from '../../chat/zkapi/versioning/walletHoldings.mjs';
import { FakeLockManager, createFakeEnvironment, createFakeStorage } from './_fakeIndexedDb.mjs';

const DB = 'zkapi-browser-wallet-v1';
const DEPLOYMENT = 'zkapi-native-eth-sepolia-note-bound-v1-fresh-20260930';
const TARGET = 'zkapi-native-eth-sepolia-concession-v1-fixture';
const CAP = 50_000;
const EXPIRY = 1_900_000_000;
const SECRET = 'SECRET-NOTE-MARKER';

const env = createFakeEnvironment();
env.install();
globalThis.localStorage = createFakeStorage();

const TABLE = [
    { id: 'v1', ordinal: 1, status: 'exit-only', deploymentId: DEPLOYMENT, label: 'Version 1' },
    { id: 'v2', ordinal: 2, status: 'active', deploymentId: TARGET, label: 'Version 2' }
];

// ---------------------------------------------------------------- the SDKs

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function sdkRoots() {
    const roots = [{
        name: 'installed legacy SDK',
        root: path.dirname(fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/package.json')))
    }];
    const add = (name, root) => {
        const store = path.join(root, 'sdk/services/browserWalletStore.js');
        if (fs.existsSync(store) && !roots.some(entry => fs.realpathSync(path.join(entry.root, 'sdk/services/browserWalletStore.js')) === fs.realpathSync(store))) {
            roots.push({ name, root });
        }
    };
    const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'deployments/zkapi/registry.json'), 'utf8'));
    for (const row of registry.versions) add(`registry alias ${row.sdk.alias}`, path.join(repoRoot, 'node_modules', row.sdk.alias));
    if (process.env.ZKAPI_V2_SDK_DIR) add('ZKAPI_V2_SDK_DIR', path.resolve(process.env.ZKAPI_V2_SDK_DIR));
    return roots;
}

const sdkCache = new Map();
async function loadSdk({ root }) {
    if (!sdkCache.has(root)) {
        const services = path.join(root, 'sdk/services');
        const store = await import(pathToFileURL(path.join(services, 'browserWalletStore.js')).href);
        const { BrowserWalletRuntime } = await import(pathToFileURL(path.join(services, 'browserWalletRuntime.js')).href);
        sdkCache.set(root, { store, BrowserWalletRuntime });
    }
    return sdkCache.get(root);
}

// A fresh database for each test: deleting it makes the store close its cached
// connection (versionchange), exactly as another tab's upgrade would.
async function wipe() {
    await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB);
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
    });
    env.trace.length = 0;
}

beforeEach(wipe);

const noteState = (overrides = {}) => ({
    note_id: 7, current_balance: 120, deposit_amount: 500_000, expiry_ts: EXPIRY, secret: SECRET, ...overrides
});

// One browser tab: a real runtime bound to the shared store, with the network
// initialization stubbed out. `init` is replaceable; initCalls counts it.
function openTab(sdk, { deploymentId = DEPLOYMENT, label = 'tab0' } = {}) {
    const runtime = new sdk.BrowserWalletRuntime();
    runtime.manifest = { deployment_id: deploymentId };
    runtime.initCalls = 0;
    runtime.init = async () => { runtime.initCalls += 1; };
    runtime.channel = sdk.store.createWalletChannel(deploymentId, () => {});
    const client = {
        browserMode: true,
        config: { request_charge_cap: CAP },
        nativePriceQuote: null,
        // As the SDK client derives it from the deposit history it holds.
        get noteExpiryClaim() {
            const note = runtime.runtime?.state;
            return runtime.deposits.find(row => row.status === 'confirmed' && row.noteId === Number(note?.note_id))?.expiryClaim || null;
        }
    };
    return { runtime, client, store: sdk.store, label };
}

// Another tab holding the wallet lock until released (always released by the
// caller's finally, so a failing assertion cannot leave the shared lock held).
function holdLock(tab) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let granted;
    const ready = new Promise(resolve => { granted = resolve; });
    const done = env.locks.forTab(tab).request(WALLET_LOCK_NAME, { mode: 'exclusive' }, async () => {
        granted();
        await gate;
    });
    return { ready, done, release };
}

const rawSlot = () => env.idb.read(DB, 'runtime', 'active');
const rawArchives = () => Object.values(env.idb.dump()[DB]?.stores.archives?.records || {});
const rawDeposits = () => Object.values(env.idb.dump()[DB]?.stores.deposits?.records || {});
const commits = () => env.trace.filter(entry => entry.type === 'idb-commit');

async function seed(tab, fields = {}) {
    await tab.store.writeBrowserWallet({ version: 1, deploymentId: DEPLOYMENT, state: noteState(), ...fields });
    await tab.runtime.reload();
    env.trace.length = 0;
}

// A lock request that loses `ifAvailable` queues behind the holder and never
// settles: the suite would hang instead of failing. Every call is therefore
// raced against a timer that answers 'DEADLOCK', which no assertion expects.
function within(promise, ms = 3000) {
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve('DEADLOCK'), ms); });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// The two switches are the caller's to pass (the service refuses without
// them); every test passes them unless it is about them.
const request = (tab, overrides = {}) => giveUpBalance({
    client: tab.client, runtime: tab.runtime, store: tab.store, supported: true, enabled: true,
    expectedNoteId: 7, expectedBalanceUnits: '120', expectedDeploymentId: DEPLOYMENT,
    ...overrides
});
const giveUp = (tab, overrides = {}) => within(request(tab, overrides));

for (const entry of sdkRoots()) {
    const suffix = ` [${entry.name}]`;

    test(`a dust note is archived by the SDK's own transaction, under the lock, and announced inside it${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        env.trace.length = 0;
        const before = structuredClone(rawSlot());

        assert.deepEqual(await giveUp(tab), { done: true, kind: 'dust' });

        // One commit, over the slot, the archive and the deposit history,
        // inside one exclusive grant of the wallet lock, followed by the
        // change announcement and only then the release.
        const kinds = env.trace.map(item => item.type);
        assert.deepEqual(kinds, ['lock-acquire', 'idb-commit', 'channel-post', 'lock-release']);
        assert.equal(env.trace[0].name, WALLET_LOCK_NAME);
        assert.equal(env.trace[0].mode, 'exclusive');
        assert.deepEqual([...commits()[0].stores].sort(), ['archives', 'deposits', 'runtime']);
        assert.equal(env.trace[2].name, WALLET_CHANNEL_NAME);

        // The slot is empty; the note, secret included, is in the archive.
        assert.equal(describeSlot(rawSlot()), 'empty');
        assert.equal(rawSlot().state, null);
        assert.equal(rawSlot().deploymentId, before.deploymentId);
        const archives = rawArchives();
        assert.equal(archives.length, 1);
        assert.equal(archives[0].reason, 'abandoned');
        assert.equal(archives[0].deploymentId, DEPLOYMENT);
        assert.deepEqual(archives[0].state, before.state);
        assert.equal(archives[0].state.secret, SECRET);
        // The deposit history keeps the row.
        assert.ok(rawDeposits().some(row => row.noteId === 7 && row.deploymentId === DEPLOYMENT));
        // The runtime was re-read and announced: nothing stale is left in this tab.
        assert.equal(tab.runtime.runtime.state, null);
        assert.equal(tab.runtime.initCalls, 1);
    });

    test(`an empty note is cleared without any price${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab, { state: noteState({ current_balance: 0 }) });
        tab.client.config = {};
        assert.deepEqual(await giveUp(tab, { expectedBalanceUnits: '0' }), { done: true, kind: 'zero' });
        assert.equal(describeSlot(rawSlot()), 'empty');
    });

    test(`the SDK's holdings probe reads an empty slot and the loader then picks the deposit target${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        let holdings = await readWalletHoldings({ database: DB });
        let selection = chooseZkapiVersion({ table: TABLE, holdings: holdings.holdings, slotKind: holdings.slot.kind });
        assert.equal(selection.version.id, 'v1', 'the slot owner pins the person to the exit-only version');
        assert.equal(selection.reason, 'runtime_holds_note');

        assert.equal((await giveUp(tab)).done, true);
        holdings = await readWalletHoldings({ database: DB });
        assert.equal(holdings.slot.kind, 'empty');
        assert.deepEqual(holdings.holdings, []);
        selection = chooseZkapiVersion({ table: TABLE, holdings: holdings.holdings, slotKind: holdings.slot.kind });
        assert.equal(selection.version.id, 'v2');
        assert.equal(selection.reason, 'no_runtime_note');
    });

    test(`a second call finds nothing and writes nothing${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        assert.equal((await giveUp(tab)).done, true);
        env.trace.length = 0;
        assert.deepEqual(await giveUp(tab), { done: false, why: 'no_note' });
        assert.equal(commits().length, 0);
        assert.equal(rawArchives().length, 1);
    });

    test(`without Web Locks nothing is written, and init is not even started${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        const before = structuredClone(rawSlot());
        env.trace.length = 0;
        assert.deepEqual(await giveUp(tab, { locks: null }), { done: false, why: 'no_locks' });
        assert.deepEqual(await giveUp(tab, { locks: {} }), { done: false, why: 'no_locks' });
        assert.deepEqual(rawSlot(), before);
        assert.equal(commits().length, 0);
        assert.equal(tab.runtime.initCalls, 0);

        // The default is navigator.locks: a browser without it refuses too.
        const restore = env.install({ locks: false });
        try {
            assert.deepEqual(await giveUp(tab, { locks: undefined }), { done: false, why: 'no_locks' });
        } finally {
            restore();
        }
        assert.deepEqual(rawSlot(), before);
        assert.equal(commits().length, 0);
    });

    test(`a busy lock is reported and nothing is written; once free the action goes through${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        const before = structuredClone(rawSlot());
        const other = holdLock('another-tab');
        try {
            await other.ready;
            env.trace.length = 0;
            assert.deepEqual(await giveUp(tab), { done: false, why: 'lock_busy' });
            assert.deepEqual(rawSlot(), before);
            assert.equal(commits().length, 0);
        } finally {
            other.release();
        }
        await other.done;
        assert.equal((await giveUp(tab)).done, true);
    });

    test(`init runs before the lock: an init that takes the lock itself cannot deadlock${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        // What BrowserWalletRuntime.initialize() does: join the wallet lock.
        const order = [];
        tab.runtime.init = async () => {
            order.push('init-start');
            await sdk.store.withBrowserWalletLock(DEPLOYMENT, async () => { order.push('init-locked'); });
            order.push('init-done');
        };
        const result = await Promise.race([
            giveUp(tab),
            new Promise(resolve => setTimeout(() => resolve('DEADLOCK'), 2000))
        ]);
        assert.deepEqual(result, { done: true, kind: 'dust' });
        assert.deepEqual(order, ['init-start', 'init-locked', 'init-done']);
        // Init's own grant is released before the give-up's own is taken.
        const grants = env.trace.filter(item => item.type === 'lock-acquire' || item.type === 'lock-release').map(item => item.type);
        assert.deepEqual(grants, ['lock-acquire', 'lock-release', 'lock-acquire', 'lock-release']);
    });

    test(`the order matters: awaiting init inside the host's own lock never finishes (control)${suffix}`, async () => {
        // On a lock table of its own: the stuck request must not hold the
        // shared one for the tests that follow.
        const table = new FakeLockManager();
        const init = () => table.request(WALLET_LOCK_NAME, { mode: 'exclusive' }, async () => {});
        const nested = table.request(WALLET_LOCK_NAME, { mode: 'exclusive', ifAvailable: true },
            async lock => { if (lock) await init(); return 'finished'; });
        const outcome = await Promise.race([nested, new Promise(resolve => setTimeout(() => resolve('blocked'), 150))]);
        assert.equal(outcome, 'blocked', 'a request for a lock the same code holds is queued behind it forever');
    });

    test(`init waits behind another tab's lock without holding the give-up's own${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        tab.runtime.init = async () => {
            await sdk.store.withBrowserWalletLock(DEPLOYMENT, async () => {});
        };
        const other = holdLock('another-tab');
        try {
            await other.ready;
            env.trace.length = 0;
            const pending = giveUp(tab);
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.equal(commits().length, 0, 'nothing happens while init is queued');
            other.release();
            await other.done;
            assert.deepEqual(await pending, { done: true, kind: 'dust' });
        } finally {
            other.release();
        }
    });

    test(`what was shown is re-checked on a fresh read inside the lock: a lease committed after display refuses${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        // Another tab issues a chat key between display and click.
        const otherTab = openTab(sdk, { label: 'another-tab' });
        await otherTab.runtime.reload();
        await sdk.store.withBrowserWalletLock(DEPLOYMENT, async () => {
            await sdk.store.writeBrowserWallet({ ...otherTab.runtime.runtime,
                journal: { phase: 'prepared', client_request_id: 'r1' },
                lease: { sessionId: 's1', client_request_id: 'r1', expires_at: 4_000_000_000, settle_after: 4_000_000_000 } });
        });
        const before = structuredClone(rawSlot());
        env.trace.length = 0;
        // This tab's memory still holds the note it displayed.
        assert.equal(tab.runtime.runtime.journal, null);
        assert.deepEqual(await giveUp(tab), { done: false, why: 'in_flight' });
        assert.deepEqual(rawSlot(), before);
        assert.equal(commits().length, 0);
        assert.equal(rawArchives().length, 0);
    });

    for (const [label, change, expected] of [
        ['the balance moved (a chat settled)', slot => ({ ...slot, state: { ...slot.state, current_balance: 100 } }), 'changed'],
        ['another note took the slot', slot => ({ ...slot, state: { ...slot.state, note_id: 8 } }), 'changed'],
        ['a withdrawal was prepared', slot => ({ ...slot, preparedWithdrawal: { mode: 'mutual', phase: 'prepared', operationId: 'w1', noteId: 7 } }), 'open_withdrawal'],
        ['an unfinished late withdrawal appeared', slot => ({ ...slot, lateWithdrawalAttempts: [{ status: 'submitted', noteId: 7 }] }), 'open_withdrawal'],
        ['a deposit was started', slot => ({ ...slot, pendingDeposit: { operationId: 'd1', phase: 'prepared', amount: 5 } }), 'pending_deposit'],
        ['a deposit draft appeared', slot => ({ ...slot, depositQuote: { operationId: 'q1' } }), 'pending_deposit'],
        ['an unfinished late deposit appeared', slot => ({ ...slot, lateDepositAttempts: [{ status: 'submitted', noteId: 9 }] }), 'pending_deposit'],
        ['the slot gained a field this build does not know', slot => ({ ...slot, futureRecoveryState: { held: true } }), 'unknown_state']
    ]) {
        test(`it refuses and leaves the slot as it was when ${label}${suffix}`, async () => {
            const sdk = await loadSdk(entry);
            const tab = openTab(sdk);
            await seed(tab);
            await sdk.store.writeBrowserWallet(change(structuredClone(rawSlot())));
            const before = structuredClone(rawSlot());
            env.trace.length = 0;
            assert.deepEqual(await giveUp(tab), { done: false, why: expected });
            assert.deepEqual(rawSlot(), before);
            assert.equal(commits().length, 0);
            assert.equal(rawArchives().length, 0);
        });
    }

    test(`an unfinished withdrawal record of this deployment refuses; one of another deployment does not${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        const record = { recordId: `${DEPLOYMENT}:11155111:0xvault:9`, deploymentId: DEPLOYMENT, chainId: 11155111,
            contractAddress: `0x${'aa'.repeat(20)}`, noteId: 9, mode: 'mutual', phase: 'parked', updatedAt: 10,
            state: noteState({ note_id: 9 }) };
        await sdk.store.putBrowserWithdrawal(record);
        assert.deepEqual(await giveUp(tab), { done: false, why: 'open_withdrawal' });
        assert.equal(rawArchives().length, 0);
        // Replace the record by a closed one (a finished close holds nothing)
        // and add one that belongs to another deployment.
        await sdk.store.putBrowserWithdrawal({ ...record, phase: 'closed' });
        await sdk.store.putBrowserWithdrawal({ ...record, recordId: `${TARGET}:1:0xvault:3`, deploymentId: TARGET, noteId: 3, phase: 'parked' });
        assert.deepEqual(await giveUp(tab), { done: true, kind: 'dust' });
    });

    test(`a treasury claim already recorded for the note refuses; "Start a new balance" is the way out${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        await sdk.store.recordBrowserExpiryClaims(DEPLOYMENT, [{ noteId: 7, amount: 500_000,
            transactionHash: `0x${'aa'.repeat(32)}`, blockHash: `0x${'bb'.repeat(32)}`, blockNumber: 100,
            claimedAt: EXPIRY * 1000 + 1 }]);
        env.trace.length = 0;
        assert.deepEqual(await giveUp(tab), { done: false, why: 'claimed' });
        assert.equal(commits().length, 0);
        assert.equal(rawArchives().length, 0);
    });

    test(`a claim the client has not seen yet is read from the fresh deposit history, inside the lock${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        // The client's own view of the claim comes from the deposit list it
        // cached; another tab recorded the claim after that. Only the history
        // the service re-reads under the lock knows it.
        tab.client = { ...tab.client, noteExpiryClaim: null };
        await sdk.store.recordBrowserExpiryClaims(DEPLOYMENT, [{ noteId: 7, amount: 500_000,
            transactionHash: `0x${'aa'.repeat(32)}`, blockHash: `0x${'bb'.repeat(32)}`, blockNumber: 100,
            claimedAt: EXPIRY * 1000 + 1 }]);
        const before = structuredClone(rawSlot());
        env.trace.length = 0;
        // The premise: the client reports no claim, the history holds one.
        assert.equal(tab.client.noteExpiryClaim, null);
        assert.ok(rawDeposits().some(row => row.noteId === 7 && row.expiryClaim), 'the claim is in the saved history');
        assert.deepEqual(await giveUp(tab), { done: false, why: 'claimed' });
        assert.deepEqual(rawSlot(), before);
        assert.equal(commits().length, 0);
        assert.equal(rawArchives().length, 0);
    });

    test(`this tab's own chat key in memory refuses even before it reaches the slot${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        tab.runtime.activeLease = { sessionId: 's', inFlight: 1 };
        assert.deepEqual(await giveUp(tab), { done: false, why: 'in_flight' });
        assert.equal(rawArchives().length, 0);
    });

    test(`the amount is judged again at click time, with a quote that must be current${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        const now = 1_800_000_000;
        const quote = (answer, updatedAt = now - 60) => ({ asset: 'native_eth', units_per_eth: 1_000_000_000, chain_id: 11155111,
            feed_address: `0x${'ab'.repeat(20)}`, decimals: 8, round_id: '77', answer, updated_at: updatedAt, expires_at: updatedAt + 4500 });
        // 200,000 gwei: dust at $1000 per ETH (a dollar is 1,000,000 gwei),
        // not dust at $10,000 (a dollar is 100,000 gwei).
        await seed(tab, { state: noteState({ current_balance: 200_000 }) });
        const options = { expectedBalanceUnits: '200000', now: () => now * 1000 };
        tab.client.nativePriceQuote = quote('1000000000000');
        assert.deepEqual(await giveUp(tab, options), { done: false, why: 'not_dust' });
        // No usable price at all: a balance past the cap is not guessed at.
        tab.client.nativePriceQuote = null;
        assert.deepEqual(await giveUp(tab, options), { done: false, why: 'price_unknown' });
        // A quote the clock has outlived is no price either, even if the
        // client still hands it out.
        tab.client.nativePriceQuote = quote('100000000000', now - 9000);
        assert.deepEqual(await giveUp(tab, options), { done: false, why: 'price_unknown' });
        assert.equal(rawArchives().length, 0);
        tab.client.nativePriceQuote = quote('100000000000');
        assert.deepEqual(await giveUp(tab, options), { done: true, kind: 'dust' });
        // The same bound holds with a price that would call a large note dust.
        await wipe();
        await seed(tab, { state: noteState({ current_balance: 90_000_000 }) });
        tab.client.nativePriceQuote = quote('1000000');
        assert.deepEqual(await giveUp(tab, { expectedBalanceUnits: '90000000', now: () => now * 1000 }),
            { done: false, why: 'not_dust' });
    });

    test(`every misuse of the arguments refuses before anything is read or written${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        const before = structuredClone(rawSlot());
        for (const [overrides, why] of [
            [{ expectedNoteId: undefined }, 'unknown_state'],
            [{ expectedNoteId: '7' }, 'unknown_state'],
            [{ expectedNoteId: -1 }, 'unknown_state'],
            [{ expectedDeploymentId: '' }, 'unknown_state'],
            [{ expectedDeploymentId: 'zkapi-another' }, 'config_mismatch'],
            [{ expectedBalanceUnits: '119' }, 'changed'],
            [{ expectedBalanceUnits: 'many' }, 'unknown_state'],
            [{ expectedNoteId: 8 }, 'changed'],
            [{ supported: false }, 'not_applicable'],
            [{ enabled: false }, 'disabled']
        ]) {
            assert.deepEqual(await giveUp(tab, overrides), { done: false, why }, JSON.stringify(overrides));
        }
        assert.deepEqual(await giveUp({ ...tab, client: { ...tab.client, browserMode: false } }),
            { done: false, why: 'not_applicable' });
        // A store without the SDK's archive is never written around.
        const started = tab.runtime.initCalls;
        assert.deepEqual(await giveUp(tab, { store: {} }), { done: false, why: 'failed' });
        assert.equal(tab.runtime.initCalls, started, 'nothing was started');
        assert.deepEqual(rawSlot(), before);
        assert.equal(rawArchives().length, 0);
    });

    test(`a failing SDK call is a plain 'failed' with no wallet text${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        tab.runtime.init = async () => { throw new Error(`manifest unreachable ${SECRET}`); };
        const result = await giveUp(tab);
        assert.deepEqual(result, { done: false, why: 'failed' });
        assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
        // A failing archive is the same, and leaves the slot as it was.
        tab.runtime.init = async () => {};
        const failing = { ...tab.store, archiveBrowserWallet: async () => { throw new Error(`write failed ${SECRET}`); } };
        assert.deepEqual(await giveUp(tab, { store: failing }), { done: false, why: 'failed' });
        assert.equal(describeSlot(rawSlot()), 'note');
    });

    test(`two tabs: the lock serializes a give-up against a tab that issues a chat key${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const a = openTab(sdk, { label: 'a' });
        const b = openTab(sdk, { label: 'b' });
        const issueLease = async () => {
            // What every SDK writer does: lock, re-read, then commit.
            return sdk.store.withBrowserWalletLock(DEPLOYMENT, async () => {
                await b.runtime.reload();
                if (!b.runtime.runtime.state) return 'no_note';
                await sdk.store.writeBrowserWallet({ ...b.runtime.runtime, journal: { phase: 'prepared' },
                    lease: { sessionId: 's', expires_at: 4_000_000_000, settle_after: 4_000_000_000 } });
                return 'leased';
            });
        };

        // The lease request is queued right behind the give-up: the give-up
        // wins the lock, so the lease finds no note to key on.
        await seed(a);
        const giving = giveUp(a);
        await new Promise(resolve => setImmediate(resolve));
        const leasing = issueLease();
        assert.deepEqual(await giving, { done: true, kind: 'dust' });
        assert.equal(await leasing, 'no_note');
        assert.equal(describeSlot(rawSlot()), 'empty');
        assert.equal(rawSlot().lease, null);

        // The other way round: the lease holds the lock first, so the give-up
        // does not queue behind it; it is refused as busy and then, once the
        // lease is in the slot, as in flight.
        await wipe();
        await seed(a);
        await b.runtime.reload();
        let finish;
        const gate = new Promise(resolve => { finish = resolve; });
        let entered;
        const inside = new Promise(resolve => { entered = resolve; });
        const holding = sdk.store.withBrowserWalletLock(DEPLOYMENT, async () => {
            entered();
            await gate;
            await sdk.store.writeBrowserWallet({ ...b.runtime.runtime, journal: { phase: 'prepared' },
                lease: { sessionId: 's', expires_at: 4_000_000_000, settle_after: 4_000_000_000 } });
        });
        try {
            await inside;
            assert.deepEqual(await giveUp(a), { done: false, why: 'lock_busy' });
        } finally {
            finish();
        }
        await holding;
        assert.deepEqual(await giveUp(a), { done: false, why: 'in_flight' });
        assert.equal(rawArchives().length, 0);
    });

    test(`support restore: the archived state is committed back under the lock and the balance is whole${suffix}`, async () => {
        // Not an in-app feature: there is no undo. This is the procedure the
        // recovery review documents for support, run against the real store.
        //   1. Find the archive record: reason 'abandoned', the note's id.
        //   2. Under the wallet lock, re-read the slot; it must be empty.
        //   3. Commit the slot with `state` set to the archived state (and
        //      nothing else changed), so the SDK loads it as an ordinary note.
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        const original = structuredClone(rawSlot().state);
        assert.equal((await giveUp(tab)).done, true);
        assert.equal(describeSlot(rawSlot()), 'empty');

        const archive = rawArchives().find(row => row.reason === 'abandoned' && row.state?.note_id === 7);
        assert.ok(archive, 'the archive record exists');
        await sdk.store.withBrowserWalletLock(DEPLOYMENT, async () => {
            await tab.runtime.reload();
            assert.equal(describeSlot(tab.runtime.runtime), 'empty', 'restoring over a non-empty slot is never done');
            await sdk.store.writeBrowserWallet({ ...tab.runtime.runtime, deploymentId: archive.deploymentId, state: archive.state });
        });
        await sdk.store.withBrowserWalletLock(DEPLOYMENT, () => tab.runtime.reload());
        assert.equal(describeSlot(rawSlot()), 'note');
        assert.deepEqual(tab.runtime.runtime.state, original, 'the same note, secret and balance');
        assert.equal(tab.runtime.runtime.state.current_balance, 120);
        // And the host reads it back as the exit-only version's own balance.
        const holdings = await readWalletHoldings({ database: DB });
        assert.equal(holdings.slot.kind, 'note');
        assert.equal(chooseZkapiVersion({ table: TABLE, holdings: holdings.holdings, slotKind: 'note' }).version.id, 'v1');
    });

    // The SDK's archive replaces the slot with a fresh one. Whatever it drops
    // must be something the strict verdict already refuses on, so no recovery
    // state can be archived over silently. A field a future SDK adds that is
    // neither known nor empty refuses by itself (isBareNote).
    test(`every slot field the archive drops is one the verdict refuses on${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const empty = await sdk.store.readBrowserWallet();
        const known = knownSlotKeys();
        const classified = new Set([...known.metadata, ...known.state]);
        for (const key of Object.keys(empty)) {
            assert.ok(classified.has(key), `the slot field "${key}" of ${entry.name} is not classified by walletHoldings.mjs`);
        }
        // Every field truthy at once, except unfinished late attempts (those
        // are kept by the archive and checked separately below).
        const holdable = ['journal', 'lease', 'preparedWithdrawal', 'pendingDeposit', 'depositQuote', 'exitLock']
            .filter(key => Object.hasOwn(empty, key));
        const full = { ...empty, deploymentId: DEPLOYMENT, state: noteState() };
        for (const key of holdable) full[key] = { held: key };
        for (const key of ['billingAsset', 'stateSeq', 'exitKitExportedSeq']) {
            if (Object.hasOwn(empty, key)) full[key] = key === 'billingAsset' ? 'native_eth' : 3;
        }
        await sdk.store.writeBrowserWallet(full);
        const stored = structuredClone(rawSlot());
        await sdk.store.archiveBrowserWallet('abandoned', 7);
        const after = rawSlot();
        assert.equal(describeSlot(after), 'empty');
        const dropped = Object.keys(stored).filter(key => stored[key] && !after[key]);
        for (const key of dropped) {
            assert.ok(['state', ...holdable, 'billingAsset', 'stateSeq', 'exitKitExportedSeq'].includes(key),
                `${entry.name}: the archive drops "${key}", which the verdict does not look at`);
        }
        for (const key of holdable) {
            assert.ok(dropped.includes(key) || !stored[key], `${key} is dropped or absent`);
            const refusal = abandonVerdict({ supported: true, enabled: true, slot: { ...slotWithBareNote(empty), [key]: { held: key } },
                withdrawals: [], deposits: [], noteId: 7, balanceUnits: '120', deploymentId: DEPLOYMENT, chargeCapUnits: CAP });
            assert.equal(refusal.ok, false, `${key} must refuse`);
            assert.equal(refusal.blockedBy, REFUSED_AS[key], `${key} is refused for what it holds`);
        }
        // The archive record keeps the note and drops nothing it holds.
        const archive = rawArchives().find(row => row.reason === 'abandoned');
        assert.equal(archive.state.secret, SECRET);
        assert.equal(archive.deploymentId, DEPLOYMENT);
    });

    test(`unfinished late attempts survive the archive, so the verdict refuses them${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        await sdk.store.writeBrowserWallet({ version: 1, deploymentId: DEPLOYMENT, state: noteState(),
            lateWithdrawalAttempts: [{ status: 'pending', operationId: 'late-1', noteId: 7 }],
            lateDepositAttempts: [{ status: 'submitted', operationId: 'late-2', noteId: 9 }] });
        const stored = structuredClone(rawSlot());
        const refusal = abandonVerdict({ supported: true, enabled: true, slot: stored, withdrawals: [], deposits: [], noteId: 7,
            balanceUnits: '120', deploymentId: DEPLOYMENT, chargeCapUnits: CAP });
        assert.deepEqual(refusal, { ok: false, blockedBy: 'open_withdrawal' });
        await sdk.store.archiveBrowserWallet('abandoned', 7);
        // The attempts are still there and still pin the slot: archiving over
        // them would have left the person pinned and the balance gone.
        assert.deepEqual(rawSlot().lateWithdrawalAttempts, stored.lateWithdrawalAttempts);
        assert.deepEqual(rawSlot().lateDepositAttempts, stored.lateDepositAttempts);
        assert.equal(describeSlot(rawSlot()), 'other');
    });

    // ------------------------------------------------- fail closed, by the service itself

    test(`the service enforces the family opt-in and the operator switch itself; nothing is started without them${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        const before = structuredClone(rawSlot());
        const started = tab.runtime.initCalls;
        env.trace.length = 0;
        // The opt-in must be exactly true: omitted, or merely truthy, refuses.
        for (const supported of [undefined, null, false, 0, 1, 'true', {}]) {
            assert.deepEqual(await giveUp(tab, { supported }), { done: false, why: 'not_applicable' },
                `supported ${JSON.stringify(supported)}`);
        }
        // The operator's switch is held to the same rule: only a stated true
        // is "on". A caller that drops it (a wrapper that forgot the field)
        // must not turn the action on for a version whose row switched it off.
        for (const enabled of [false, undefined, null, 0, 1, 'true', {}]) {
            assert.deepEqual(await giveUp(tab, { enabled }), { done: false, why: 'disabled' },
                `enabled ${JSON.stringify(enabled)}`);
        }
        // The opt-in is judged first.
        assert.deepEqual(await giveUp(tab, { supported: false, enabled: false }), { done: false, why: 'not_applicable' });
        // A caller that passes neither at all (what an unwired wrapper would do).
        const bare = await within(giveUpBalance({ client: tab.client, runtime: tab.runtime, store: tab.store,
            expectedNoteId: 7, expectedBalanceUnits: '120', expectedDeploymentId: DEPLOYMENT }));
        assert.deepEqual(bare, { done: false, why: 'not_applicable' });
        // The opt-in alone is not enough either: the switch left out refuses.
        const unswitched = await within(giveUpBalance({ client: tab.client, runtime: tab.runtime, store: tab.store, supported: true,
            expectedNoteId: 7, expectedBalanceUnits: '120', expectedDeploymentId: DEPLOYMENT }));
        assert.deepEqual(unswitched, { done: false, why: 'disabled' });
        // Before init, before any lock, before any read or write.
        assert.equal(tab.runtime.initCalls, started);
        assert.deepEqual(rawSlot(), before);
        assert.equal(env.trace.filter(item => item.type === 'lock-acquire').length, 0);
        assert.equal(commits().length, 0);
        // Both stated: it goes through.
        assert.deepEqual(await giveUp(tab, { supported: true, enabled: true }), { done: true, kind: 'dust' });
    });

    // ------------------------------------------------- the lock and the SDK's own guards

    test(`the lock is requested once, exclusive and only if available, under the wallet lock's name${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        const requests = [];
        const locks = { request: (name, options, callback) => {
            requests.push([name, options]);
            return globalThis.navigator.locks.request(name, options, callback);
        } };
        assert.deepEqual(await giveUp(tab, { locks }), { done: true, kind: 'dust' });
        assert.deepEqual(requests, [[WALLET_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }]]);
    });

    test(`control: a lock request that loses ifAvailable queues behind the holder, and the suite reports it instead of hanging${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        const queuing = { request: (name, options, callback) =>
            globalThis.navigator.locks.request(name, { mode: options.mode }, callback) };
        const other = holdLock('another-tab');
        let pending;
        try {
            await other.ready;
            // With ifAvailable the same situation is 'lock_busy' at once (the
            // busy-lock test). Without it the request waits for the holder.
            pending = request(tab, { locks: queuing });
            assert.equal(await within(pending, 200), 'DEADLOCK');
        } finally {
            other.release();
        }
        await other.done;
        assert.deepEqual(await pending, { done: true, kind: 'dust' }, 'it ran once the holder let go');
    });

    test(`the archive is given the note id, so the SDK checks the note again inside its own transaction${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        const calls = [];
        const recording = { ...tab.store, archiveBrowserWallet: async (...args) => {
            calls.push(args);
            return tab.store.archiveBrowserWallet(...args);
        } };
        assert.deepEqual(await giveUp(tab, { store: recording }), { done: true, kind: 'dust' });
        assert.deepEqual(calls, [['abandoned', 7]]);
    });

    test(`a note that takes the slot between the verdict and the archive is refused by the SDK and left alone${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        // A writer that does not take the wallet lock swaps the note after the
        // verdict and before the archive. Only the note id given to the SDK's
        // own transaction stands between that note and the archive.
        let swaps = 0;
        const swap = async () => {
            const slot = structuredClone(rawSlot());
            await tab.store.writeBrowserWallet({ ...slot, state: { ...slot.state, note_id: 8, current_balance: 30 } });
            swaps += 1;
        };
        const racing = { ...tab.store, archiveBrowserWallet: async (...args) => {
            await swap();
            return tab.store.archiveBrowserWallet(...args);
        } };
        env.trace.length = 0;
        const result = await giveUp(tab, { store: racing });
        assert.deepEqual(result, { done: false, why: 'failed' });
        assert.equal(swaps, 1);
        assert.equal(rawSlot().state.note_id, 8, 'the other note is still in the slot');
        assert.equal(rawSlot().state.current_balance, 30);
        assert.equal(rawArchives().length, 0, 'nothing was archived');
        // The premise of the guard: handed no id, the SDK archives whatever is there.
        await tab.store.archiveBrowserWallet('abandoned');
        assert.equal(rawArchives().length, 1);
        assert.equal(rawArchives()[0].state.note_id, 8);
    });

    // ------------------------------------------------- facts that cannot be read refuse

    test(`a request archive that cannot be read, or is not a list, refuses; a non-empty one refuses${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        const before = structuredClone(rawSlot());
        const asked = [];
        const readerOf = reader => ({ ...tab.store, listBrowserRequestArchive: reader });
        for (const [label, reader, why] of [
            ['it throws', async () => { throw new Error(`unreadable ${SECRET}`); }, 'unknown_state'],
            ['it throws synchronously', () => { throw new Error(`unreadable ${SECRET}`); }, 'unknown_state'],
            ['it answers with no list', async () => ({ records: [] }), 'unknown_state'],
            ['it answers null', async () => null, 'unknown_state'],
            ['it answers nothing', async () => undefined, 'unknown_state'],
            ['the reader is not a function', 'a request archive', 'unknown_state'],
            ['it holds one transmitted request', async deploymentId => {
                asked.push(deploymentId);
                return [{ clientRequestId: 'r1', type: 'request-journal' }];
            }, 'unresolved_request']
        ]) {
            const result = await giveUp(tab, { store: readerOf(reader) });
            assert.deepEqual(result, { done: false, why }, label);
            assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
        }
        assert.deepEqual(rawSlot(), before);
        assert.equal(commits().length, 0);
        assert.equal(rawArchives().length, 0);
        assert.deepEqual(asked, [DEPLOYMENT], 'asked about this deployment');
        // An empty archive is not a reason to refuse.
        assert.deepEqual(await giveUp(tab, { store: readerOf(async () => []) }), { done: true, kind: 'dust' });
    });

    test(`an SDK that has no request archive is not refused for it, however the name is bound${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        // A faceted build binds a name only another SDK exports to undefined.
        assert.deepEqual(await giveUp(tab, { store: { ...tab.store, listBrowserRequestArchive: undefined } }),
            { done: true, kind: 'dust' });
        await wipe();
        await seed(tab);
        const without = { ...tab.store };
        delete without.listBrowserRequestArchive;
        assert.deepEqual(await giveUp(tab, { store: without }), { done: true, kind: 'dust' });
    });

    test(`every withdrawal record of the database counts, whatever deployment it names; one that names none refuses${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        const record = { recordId: 'unscoped-1', noteId: 9, mode: 'mutual', phase: 'parked', updatedAt: 10,
            state: noteState({ note_id: 9 }) };
        // The SDK's runtime list is filtered by deployment id with a strict
        // equality: a record that names none never reaches it.
        for (const named of [{}, { deploymentId: null }, { deploymentId: '' }]) {
            await sdk.store.putBrowserWithdrawal({ ...record, ...named });
            await tab.runtime.reload();
            assert.equal(tab.runtime.withdrawals.some(item => item.recordId === 'unscoped-1'), false,
                'the runtime list does not carry it');
            env.trace.length = 0;
            assert.deepEqual(await giveUp(tab), { done: false, why: 'open_withdrawal' }, JSON.stringify(named));
            assert.equal(commits().length, 0);
            assert.equal(rawArchives().length, 0);
        }
        // A finished close of no named deployment holds nothing.
        await sdk.store.putBrowserWithdrawal({ ...record, phase: 'closed' });
        assert.deepEqual(await giveUp(tab), { done: true, kind: 'dust' });
    });

    test(`a withdrawal list that cannot be read refuses, and a store without one is never written through${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        const before = structuredClone(rawSlot());
        for (const [label, list] of [
            ['it throws', async () => { throw new Error(`unreadable ${SECRET}`); }],
            ['it answers with no list', async () => ({ records: [] })],
            ['it answers nothing', async () => undefined]
        ]) {
            const result = await giveUp(tab, { store: { ...tab.store, listBrowserWithdrawals: list } });
            assert.deepEqual(result, { done: false, why: 'unknown_state' }, label);
            assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
        }
        assert.deepEqual(rawSlot(), before);
        assert.equal(rawArchives().length, 0);
        // Without the reader nothing is started at all.
        const started = tab.runtime.initCalls;
        const missing = { ...tab.store };
        delete missing.listBrowserWithdrawals;
        assert.deepEqual(await giveUp(tab, { store: missing }), { done: false, why: 'failed' });
        assert.equal(tab.runtime.initCalls, started);
    });

    test(`a client fact that cannot be read refuses instead of counting as none${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab);
        const before = structuredClone(rawSlot());
        const clientOf = (properties = {}) => {
            const client = { browserMode: true, config: { request_charge_cap: CAP }, nativePriceQuote: null, noteExpiryClaim: null };
            Object.defineProperties(client, Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(properties))
                .map(([key, descriptor]) => [key, { ...descriptor, enumerable: true, configurable: true }])));
            return client;
        };
        const boom = () => { throw new Error(`getter ${SECRET}`); };
        const refused = async (properties, why, label) => {
            const result = await within(giveUpBalance({ client: clientOf(properties), runtime: tab.runtime, store: tab.store,
                supported: true, enabled: true, expectedNoteId: 7, expectedBalanceUnits: '120', expectedDeploymentId: DEPLOYMENT }));
            assert.deepEqual(result, { done: false, why }, label);
            assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
        };
        await refused({ get noteExpiryClaim() { return boom(); } }, 'unknown_state', 'the claim getter throws');
        await refused({ get config() { return boom(); } }, 'unknown_state', 'the config getter throws');
        await refused({ noteExpiryClaim: { transactionHash: `0x${'aa'.repeat(32)}` } }, 'claimed', 'a claim is reported');
        for (const [label, unresolved] of [
            ['null', null], ['an object', {}], ['a string', 'none'], ['a number', 1], ['true', true],
            ['a request', [{ client_request_id: 'r1' }]]
        ]) {
            await refused({ config: { request_charge_cap: CAP, unresolved_requests: unresolved } }, 'unresolved_request',
                `unresolved_requests is ${label}`);
        }
        assert.deepEqual(rawSlot(), before);
        assert.equal(commits().length, 0);
        assert.equal(rawArchives().length, 0);
        // An SDK that keeps no list leaves the field out, and an empty list is none.
        const done = await within(giveUpBalance({ client: clientOf({ config: { request_charge_cap: CAP, unresolved_requests: [] } }),
            runtime: tab.runtime, store: tab.store, supported: true, enabled: true,
            expectedNoteId: 7, expectedBalanceUnits: '120', expectedDeploymentId: DEPLOYMENT }));
        assert.deepEqual(done, { done: true, kind: 'dust' });
        await wipe();
        await seed(tab);
        assert.deepEqual(await giveUp(tab), { done: true, kind: 'dust' });
    });

    test(`a price that cannot be read is no price: a balance past the cap is not guessed at${suffix}`, async () => {
        const sdk = await loadSdk(entry);
        const tab = openTab(sdk);
        await seed(tab, { state: noteState({ current_balance: 200_000 }) });
        const client = { browserMode: true, config: { request_charge_cap: CAP }, noteExpiryClaim: null,
            get nativePriceQuote() { throw new Error(`feed ${SECRET}`); } };
        const result = await within(giveUpBalance({ client, runtime: tab.runtime, store: tab.store, supported: true, enabled: true,
            expectedNoteId: 7, expectedBalanceUnits: '200000', expectedDeploymentId: DEPLOYMENT }));
        assert.deepEqual(result, { done: false, why: 'price_unknown' });
        assert.equal(rawArchives().length, 0);
    });
}

// Why the verdict refuses a slot that holds each field the SDK's archive drops.
const REFUSED_AS = Object.freeze({
    journal: 'in_flight', lease: 'in_flight', preparedWithdrawal: 'open_withdrawal', pendingDeposit: 'pending_deposit',
    depositQuote: 'pending_deposit', exitLock: 'exit_lock'
});

// A bare slot of the shape `empty` has, holding the note of the tests.
function slotWithBareNote(empty) {
    return { ...empty, deploymentId: DEPLOYMENT, state: noteState() };
}

// The default store is the SDK's whole store namespace, so whatever the
// installed SDK exports is reachable: the successor protocol's request archive
// among it, which a hand-picked set of names (or a named import that does not
// link under an SDK without it) would miss.
test('the default store is the SDK\'s whole store namespace, and a give-up through it works', async () => {
    assert.equal(defaultWalletStore, installedStore);
    for (const name of ['archiveBrowserWallet', 'listBrowserWithdrawals']) {
        assert.equal(typeof defaultWalletStore[name], 'function', name);
    }
    const sdk = await loadSdk(sdkRoots()[0]);
    assert.equal(sdk.store.archiveBrowserWallet, installedStore.archiveBrowserWallet, 'the same module instance');
    await wipe();
    const tab = openTab(sdk);
    await seed(tab);
    // No `store` named: the default is used.
    const result = await within(giveUpBalance({ client: tab.client, runtime: tab.runtime, supported: true, enabled: true,
        expectedNoteId: 7, expectedBalanceUnits: '120', expectedDeploymentId: DEPLOYMENT }));
    assert.deepEqual(result, { done: true, kind: 'dust' });
    assert.equal(describeSlot(rawSlot()), 'empty');
});

// A caller that hands over nothing usable is a caller that passed neither
// switch: refused as not applicable, and not a rejected promise.
test('arguments that are not an object are refused, never thrown', async () => {
    for (const options of [undefined, null, 'give up', 7, true, []]) {
        assert.deepEqual(await within(giveUpBalance(options)), { done: false, why: 'not_applicable' },
            `arguments ${JSON.stringify(options)}`);
    }
});

// A successor SDK's own store and runtime come under every test above the
// moment its alias is installed (or ZKAPI_V2_SDK_DIR names an unpacked copy).
test('the installed legacy SDK is always covered', () => {
    const roots = sdkRoots();
    assert.ok(roots.length >= 1 && roots[0].name === 'installed legacy SDK');
});
