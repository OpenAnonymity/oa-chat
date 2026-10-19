import test from 'node:test';
import assert from 'node:assert/strict';
import { chatDB } from '../../chat/db.js';
import accountService from '../../chat/services/accountService.js';
import sessionService from '../../chat/services/sessionService.js';
import syncService from '../../chat/services/encryptedSyncService.js';
import { createFakeEnvironment } from '../zkapi/_fakeIndexedDb.mjs';

// The browser can close an IndexedDB connection without the page asking
// (site data cleared or evicted, disk errors). These tests use the isolated
// fake IndexedDB only: no browser profile, server, account or ticket.

const ACCOUNT = '1234567890123456';
const OTHER_ACCOUNT = '6543210987654321';
const NAME = 'oa-fastchat';

function request(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// The fake does not model indexes. Let chatDB's own upgrade run (so the
// "created from nothing" path is real) by making index creation a no-op.
async function allowSchemaUpgrades(t) {
    const probe = await new Promise((resolve, reject) => {
        const open = indexedDB.open('__probe__', 1);
        open.onupgradeneeded = () => {
            const store = open.result.createObjectStore('s', { keyPath: 'id' });
            resolve({ store, open });
        };
        open.onerror = () => reject(open.error);
    });
    const proto = Object.getPrototypeOf(probe.store);
    const saved = {
        createIndex: proto.createIndex,
        indexNames: Object.getOwnPropertyDescriptor(proto, 'indexNames')
    };
    proto.createIndex = () => ({});
    Object.defineProperty(proto, 'indexNames', { configurable: true, get: () => ({ contains: () => false }) });
    await new Promise(resolve => { probe.open.onsuccess = () => { probe.open.result.close(); resolve(); }; });
    t.after(() => {
        proto.createIndex = saved.createIndex;
        Object.defineProperty(proto, 'indexNames', saved.indexNames);
    });
}

const readAll = storeName => request(
    chatDB.db.transaction([storeName], 'readonly').objectStore(storeName).getAll()
);

async function fixture(t) {
    const environment = createFakeEnvironment();
    const restore = environment.install();
    const idb = globalThis.indexedDB;
    const previousWindow = globalThis.window;
    const events = [];
    const target = new EventTarget();
    for (const type of ['oa-db-connection-lost', 'oa-db-reconnected', 'oa-db-reconnect-failed',
        'oa-db-reset', 'oa-db-reset-write-refused']) {
        target.addEventListener(type, () => events.push(type));
    }
    globalThis.window = target;
    const fields = ['db', 'initInFlight', 'connectionLost', 'reconnectFailureReported',
        'closedForVersionChange', 'resetAt', 'resetRefusalReported', 'reconnectCount', 'resetReconnectCount',
        'incarnation', 'reopenFailure'];
    const saved = Object.fromEntries(fields.map(key => [key, chatDB[key]]));
    Object.assign(chatDB, {
        db: null, initInFlight: null, connectionLost: false, reconnectFailureReported: false,
        closedForVersionChange: false, resetAt: 0, resetRefusalReported: false,
        reconnectCount: 0, resetReconnectCount: 0, incarnation: null, reopenFailure: null
    });
    t.after(() => {
        for (const timer of chatDB.broadcastTimers.values()) clearTimeout(timer);
        chatDB.broadcastTimers.clear();
        try { chatDB.db?.close(); } catch { /* already closed */ }
        Object.assign(chatDB, saved);
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
        restore();
    });
    await allowSchemaUpgrades(t);
    await chatDB.init();
    return { environment, events, idb };
}

// What a browser does when it removes or loses the database under a page:
// the connection is force-closed (no versionchange) and `close` fires.
async function closeUnexpectedly({ removeData = false } = {}) {
    const connection = chatDB.db;
    connection.onversionchange = null;
    connection.close();
    if (removeData) await request(indexedDB.deleteDatabase(NAME));
    connection.onclose?.({ type: 'close' });
    return connection;
}

// ------------------------------------------------------------------ storage

test('an unexpected close reopens on the next read and every record is still there', async t => {
    const { events } = await fixture(t);
    await chatDB.saveSession({ id: 'chat-a', title: 'Kept', createdAt: 1, updatedAt: 2 });
    await chatDB.saveMessage({ id: 'msg-a', sessionId: 'chat-a', role: 'user', content: 'hello', timestamp: 1 });
    const lost = await closeUnexpectedly();

    // Code elsewhere tests `chatDB.db` for "no database" and then returns
    // empty values; a lost connection must not look like that.
    assert.ok(chatDB.db);
    assert.deepEqual(events, ['oa-db-connection-lost']);

    assert.deepEqual((await chatDB.getAllSessions()).map(s => s.id), ['chat-a']);
    assert.notEqual(chatDB.db, lost);
    assert.deepEqual((await readAll('messages')).map(m => m.id), ['msg-a']);
    assert.deepEqual(events, ['oa-db-connection-lost', 'oa-db-reconnected']);
    assert.equal(chatDB.resetAt, 0);

    await chatDB.saveSetting('after', 1);
    assert.equal(await chatDB.getSetting('after'), 1);
    assert.deepEqual(events, ['oa-db-connection-lost', 'oa-db-reconnected']);
});

test('a connection that is closing fails one request, which never ran, and the next one reopens', async t => {
    const { events } = await fixture(t);
    await chatDB.saveSetting('kept', 'yes');
    chatDB.db.close(); // closing; its close event has not arrived

    await assert.rejects(chatDB.saveSetting('during-close', 1), error => error?.name === 'InvalidStateError');
    assert.deepEqual(events, ['oa-db-connection-lost']);

    await chatDB.saveSetting('after-close', 2);
    assert.equal(await chatDB.getSetting('kept'), 'yes');
    assert.equal(await chatDB.getSetting('during-close'), undefined);
    assert.equal(await chatDB.getSetting('after-close'), 2);
    assert.deepEqual(events, ['oa-db-connection-lost', 'oa-db-reconnected']);
});

test('a reopen started by init() elsewhere does the same bookkeeping', async t => {
    const { events } = await fixture(t);
    await chatDB.saveSetting('kept', 'yes');
    await closeUnexpectedly();
    // e.g. ticketStore/preferencesStore/apiKeyStore call init() themselves.
    const reopened = await chatDB.init();
    assert.equal(reopened, chatDB.db);
    assert.equal(chatDB.connectionLost, false);
    assert.deepEqual(events, ['oa-db-connection-lost', 'oa-db-reconnected']);
    assert.equal(await chatDB.getSetting('kept'), 'yes');
});

test('reopening a removed database creates it empty, says so once, and writes nothing on its own', async t => {
    const { environment, events } = await fixture(t);
    await chatDB.saveSession({ id: 'chat-a', title: 'Was here', createdAt: 1, updatedAt: 2 });
    await closeUnexpectedly({ removeData: true });

    assert.deepEqual(await chatDB.getAllSessions(), []);
    assert.deepEqual(events, ['oa-db-connection-lost', 'oa-db-reset', 'oa-db-reconnected']);
    assert.ok(chatDB.resetAt > 0);
    assert.equal(chatDB.resetReconnectCount, chatDB.reconnectCount);
    const sessionWrites = environment.idb.committedWrites().filter(w => w.store === 'sessions');
    assert.equal(sessionWrites.filter(w => w.key === 'chat-a').length, 1); // only the original save
});

test('after a reset, chats this tab still shows are not written back; new chats and imports are', async t => {
    const { events } = await fixture(t);
    const old = { id: 'old-chat', title: 'Shown in this tab', createdAt: 1, updatedAt: 2 };
    await chatDB.saveSession(old);
    await closeUnexpectedly({ removeData: true });
    await chatDB.getAllSessions(); // reopen

    // Background save of what the tab shows (scroll anchor, migrations, …).
    await assert.rejects(chatDB.saveSession({ ...old, promptSlideAnchorUpdatedAt: 3 }),
        error => error?.code === 'CHAT_STORAGE_RESET');
    // A send into that chat, and a message for a chat whose row is gone.
    await assert.rejects(chatDB.saveSessionWithMessages(old,
        [{ id: 'm-new', sessionId: 'old-chat', role: 'user', content: 'x', timestamp: 5 }]),
    error => error?.code === 'CHAT_STORAGE_RESET');
    await assert.rejects(chatDB.saveMessage({ id: 'm-orphan', sessionId: 'old-chat', role: 'assistant', content: 'y', timestamp: 6 }),
        error => error?.code === 'CHAT_STORAGE_RESET');
    assert.equal(await chatDB.updateExistingSession('old-chat', s => { s.title = 'z'; return true; }), false);
    assert.deepEqual(await chatDB.getAllSessions(), []);
    assert.deepEqual(await readAll('messages'), []);
    // The person is told once.
    assert.equal(events.filter(type => type === 'oa-db-reset-write-refused').length, 1);

    // A chat started after the reset saves normally, with its messages.
    const fresh = { id: 'new-chat', title: 'New', createdAt: Date.now() + 1, updatedAt: Date.now() + 1 };
    await chatDB.saveSessionWithMessages(fresh, [{ id: 'm1', sessionId: 'new-chat', role: 'user', content: 'hi', timestamp: 1 }]);
    await chatDB.saveMessage({ id: 'm2', sessionId: 'new-chat', role: 'assistant', content: 'hello', timestamp: 2 });

    // An import is an explicit restore and may bring old chats back.
    await chatDB.saveSession(old, { allowRecreate: true });
    await chatDB.saveMessage({ id: 'm-imported', sessionId: 'old-chat', role: 'user', content: 'restored', timestamp: 1 });
    await chatDB.saveSession({ ...old, title: 'Edited after restore' });
    assert.deepEqual((await chatDB.getAllSessions()).map(s => s.id).sort(), ['new-chat', 'old-chat']);
    assert.deepEqual((await readAll('messages')).map(m => m.id).sort(), ['m-imported', 'm1', 'm2']);
});

test('a database another tab recreated first still counts as reset in this tab', async t => {
    const { environment, events } = await fixture(t);
    const old = { id: 'old-chat', title: 'Shown here', createdAt: 1, updatedAt: 2 };
    await chatDB.saveSession(old);
    const known = chatDB.incarnation;
    assert.ok(known);
    await closeUnexpectedly({ removeData: true });
    // Tab B reopens first: its own upgrade from nothing writes a new marker.
    const otherTab = environment.idb.forTab('tab-b');
    await new Promise((resolve, reject) => {
        const open = otherTab.open(NAME, 4);
        open.onupgradeneeded = () => {
            for (const name of ['sessions', 'messages', 'settings', 'networkLogs']) {
                open.result.createObjectStore(name, { keyPath: name === 'settings' ? 'key' : 'id' });
            }
            open.transaction.objectStore('settings').put({ key: 'db-incarnation', value: 'tab-b-made-this' });
        };
        open.onsuccess = () => { open.result.close(); resolve(); };
        open.onerror = () => reject(open.error);
    });

    assert.deepEqual(await chatDB.getAllSessions(), []);
    assert.deepEqual(events, ['oa-db-connection-lost', 'oa-db-reset', 'oa-db-reconnected']);
    assert.equal(chatDB.incarnation, 'tab-b-made-this');
    assert.equal(chatDB.resetReconnectCount, chatDB.reconnectCount);
    await assert.rejects(chatDB.saveSession({ ...old, updatedAt: 3 }), error => error?.code === 'CHAT_STORAGE_RESET');
});

test('a database an older build recreated (no marker) also counts as reset', async t => {
    const { events } = await fixture(t);
    await closeUnexpectedly({ removeData: true });
    await new Promise((resolve, reject) => {
        const open = indexedDB.open(NAME, 4);
        open.onupgradeneeded = () => {
            for (const name of ['sessions', 'messages', 'settings', 'networkLogs']) {
                open.result.createObjectStore(name, { keyPath: name === 'settings' ? 'key' : 'id' });
            }
        };
        open.onsuccess = () => { open.result.close(); resolve(); };
        open.onerror = () => reject(open.error);
    });
    await chatDB.getAllSessions();
    assert.deepEqual(events, ['oa-db-connection-lost', 'oa-db-reset', 'oa-db-reconnected']);
    assert.ok(chatDB.incarnation); // adopted a fresh marker for the next tab
});

test('a database from before markers existed gets one on first open, and a plain reopen is not a reset', async t => {
    const { events } = await fixture(t);
    await chatDB.deleteSetting('db-incarnation');
    chatDB.incarnation = null;
    // Simulate a fresh page on that database.
    chatDB.db.close();
    chatDB.db = null;
    await chatDB.init();
    const adopted = chatDB.incarnation;
    assert.ok(adopted);
    assert.equal((await chatDB.getSetting('db-incarnation')), adopted);
    await closeUnexpectedly();
    await chatDB.getAllSessions();
    assert.deepEqual(events, ['oa-db-connection-lost', 'oa-db-reconnected']);
    assert.equal(chatDB.resetAt, 0);
});

test('a marker that cannot be read on a plain reopen is not mistaken for a reset', async t => {
    const { events } = await fixture(t);
    const known = chatDB.incarnation;
    const realAdopt = chatDB.adoptIncarnation;
    chatDB.adoptIncarnation = async () => null;
    t.after(() => { chatDB.adoptIncarnation = realAdopt; });
    await closeUnexpectedly();
    await chatDB.getAllSessions();
    assert.deepEqual(events, ['oa-db-connection-lost', 'oa-db-reconnected']);
    assert.equal(chatDB.resetAt, 0);
    assert.equal(chatDB.incarnation, known);
});

test('an export never produces an empty file when reading fails', async t => {
    const { idb } = await fixture(t);
    const { collectChats } = await import('../../chat/services/globalExport.js');
    await chatDB.saveSession({ id: 'chat-a', title: 'Kept', createdAt: 1, updatedAt: 2 });
    await closeUnexpectedly();
    const realOpen = idb.open.bind(idb);
    idb.open = () => {
        const req = {};
        setImmediate(() => { req.error = new DOMException('Disk is full', 'UnknownError'); req.onerror?.(); });
        return req;
    };
    t.after(() => { idb.open = realOpen; });
    await assert.rejects(collectChats());
});

test('a ticket read during a failed reopen throws instead of reading as an empty wallet', async t => {
    const { idb } = await fixture(t);
    const { TicketStore } = await import('../../chat/services/ticketStore.js');
    await chatDB.saveSetting('tickets-active', [{ finalized_ticket: 'synthetic' }]);
    await closeUnexpectedly();
    const realOpen = idb.open.bind(idb);
    idb.open = () => {
        const req = {};
        setImmediate(() => { req.error = new DOMException('Disk is full', 'UnknownError'); req.onerror?.(); });
        return req;
    };
    t.after(() => { idb.open = realOpen; });
    const store = Object.create(TicketStore.prototype);
    await assert.rejects(store.readFromDatabase());
    idb.open = realOpen;
    chatDB.reopenFailure.at -= 10_000;
    const read = await store.readFromDatabase();
    assert.deepEqual(read.active, [{ finalized_ticket: 'synthetic' }]);
});

test('a failed reopen is reported once, and the next successful one clears it', async t => {
    const { events, idb } = await fixture(t);
    await closeUnexpectedly();
    const realOpen = idb.open.bind(idb);
    let failing = true;
    idb.open = (...args) => {
        if (!failing) return realOpen(...args);
        const req = {};
        setImmediate(() => {
            req.error = new DOMException('Disk is full', 'UnknownError');
            req.onerror?.();
        });
        return req;
    };
    t.after(() => { idb.open = realOpen; });

    await assert.rejects(chatDB.getSetting('anything'));
    await assert.rejects(chatDB.init());
    assert.deepEqual(events, ['oa-db-connection-lost', 'oa-db-reconnect-failed']);

    failing = false;
    // Within the fail-fast window the stored failure is returned at once,
    // without another open (no 20 s waits on every streaming save).
    let opens = 0;
    const counting = idb.open;
    idb.open = (...args) => { opens += 1; return counting(...args); };
    await assert.rejects(chatDB.getSetting('anything'), /Disk is full/);
    assert.equal(opens, 0);
    chatDB.reopenFailure.at -= 10_000;
    assert.equal(await chatDB.getSetting('anything'), undefined);
    assert.equal(opens, 1);
    assert.deepEqual(events, ['oa-db-connection-lost', 'oa-db-reconnect-failed', 'oa-db-reconnected']);
});

test('a schema upgrade from another tab still requires a reload; nothing reopens', async t => {
    const { events } = await fixture(t);
    chatDB.db.onversionchange?.({ type: 'versionchange' });
    assert.equal(chatDB.db, null);
    await assert.rejects(chatDB.getSetting('x'), /Reload to continue/);
    await assert.rejects(chatDB.init(), /Reload to continue/);
    assert.equal(chatDB.db, null);
    assert.deepEqual(events, []);
});

test('closing a connection that was already replaced is not treated as lost', async t => {
    const { events } = await fixture(t);
    const old = chatDB.db;
    chatDB.db = null;
    await chatDB.init();
    old.onclose?.({ type: 'close' });
    assert.equal(chatDB.connectionLost, false);
    assert.deepEqual(events, []);
});

// ------------------------------------------------------------------ account

function accountFixture(t, { verify = true } = {}) {
    const keys = ['cryptoKey', 'syncDerivationKey', 'syncIdKey', 'initializeSync', 'lock',
        'storageRecoveryInFlight', 'handledStorageReconnect', 'syncInitializationInFlight',
        'syncInitializationReconnect'];
    const originals = Object.fromEntries(keys.map(key => [key, accountService[key]]));
    const originalState = { ...accountService.state };
    const originalVerify = sessionService.verifySession;
    const originalScope = syncService.getLocalAccountScope();
    const calls = { verify: 0, initializeSync: 0, locks: 0 };
    Object.assign(accountService.state, {
        accountId: ACCOUNT, sessionVerified: true, username: null,
        googleLinked: true, oauthProvider: 'google', oauthEmail: 'member@example.test',
        encryptionMode: 'LEGACY_SSO', recoveryConfirmed: true,
        accountScopeReady: true, authBootstrapComplete: true, accountHandoffPending: false, busy: false
    });
    accountService.cryptoKey = { synthetic: 'crypto' };
    accountService.syncDerivationKey = { synthetic: 'derivation' };
    accountService.syncIdKey = { synthetic: 'id' };
    accountService.storageRecoveryInFlight = null;
    accountService.handledStorageReconnect = 0;
    accountService.syncInitializationInFlight = null;
    accountService.lock = () => { calls.locks += 1; };
    sessionService.verifySession = async () => { calls.verify += 1; return verify; };
    accountService.initializeSync = async () => { calls.initializeSync += 1; return true; };
    syncService.setLocalAccountScope(ACCOUNT);
    t.after(() => {
        Object.assign(accountService, originals);
        Object.keys(accountService.state).forEach(key => { if (!(key in originalState)) delete accountService.state[key]; });
        Object.assign(accountService.state, originalState);
        sessionService.verifySession = originalVerify;
        syncService.setLocalAccountScope(originalScope);
    });
    return calls;
}

async function signedInRecord() {
    await chatDB.saveSetting('account-settings', { accountId: ACCOUNT, marker: 'original' });
    await chatDB.saveSetting('sync-account-scope', ACCOUNT);
}

test('after a plain close the account record is untouched and sync restarts', async t => {
    await fixture(t);
    const calls = accountFixture(t);
    await signedInRecord();
    await closeUnexpectedly();

    assert.equal(await accountService.recoverAfterStorageReconnect(), true);
    assert.equal((await chatDB.getSetting('account-settings')).marker, 'original');
    assert.equal(calls.verify, 0);
    assert.equal(calls.initializeSync, 1);
});

test('a removed database gets this tab\'s account record and key bundle back, in one write', async t => {
    const { environment } = await fixture(t);
    const calls = accountFixture(t);
    await signedInRecord();
    await closeUnexpectedly({ removeData: true });
    await chatDB.getAllSessions(); // the reopen that recreates the database

    assert.equal(await accountService.recoverAfterStorageReconnect(), true);
    const record = await chatDB.getSetting('account-settings');
    assert.equal(record.accountId, ACCOUNT);
    assert.equal(record.oauthEmail, 'member@example.test');
    const bundle = await chatDB.getSetting('account-key-bundle-v1');
    assert.equal(bundle.accountId, ACCOUNT);
    assert.deepEqual(bundle.cryptoKey, { synthetic: 'crypto' });
    const commits = environment.idb.log.filter(entry => entry.op === 'commit' &&
        entry.writes.some(w => w.key === 'account-settings'));
    assert.ok(commits.at(-1).writes.some(w => w.key === 'account-key-bundle-v1'));
    assert.equal(calls.verify, 1);
    assert.equal(calls.initializeSync, 1);
    assert.deepEqual(await chatDB.getAllSessions(), []); // never writes chats
});

test('a record missing after a plain close (removed by a sign-out) is not restored', async t => {
    await fixture(t);
    const calls = accountFixture(t);
    await closeUnexpectedly();
    assert.equal(await accountService.recoverAfterStorageReconnect(), false);
    assert.equal(await chatDB.getSetting('account-settings'), undefined);
    assert.equal(calls.verify, 0);
    assert.equal(calls.initializeSync, 0);
});

test('a session that no longer exists in this browser is not restored', async t => {
    await fixture(t);
    const calls = accountFixture(t, { verify: false });
    await closeUnexpectedly({ removeData: true });
    await chatDB.getAllSessions();
    assert.equal(await accountService.recoverAfterStorageReconnect(), false);
    assert.equal(await chatDB.getSetting('account-settings'), undefined);
    assert.equal(await chatDB.getSetting('account-key-bundle-v1'), undefined);
    assert.equal(calls.initializeSync, 0);
});

test('another saved account or a sign-in in progress elsewhere is left alone', async t => {
    await fixture(t);
    const calls = accountFixture(t);
    await chatDB.saveSetting('account-settings', { accountId: OTHER_ACCOUNT });
    assert.equal(await accountService.recoverAfterStorageReconnect(), false);
    assert.equal((await chatDB.getSetting('account-settings')).accountId, OTHER_ACCOUNT);

    await chatDB.deleteSetting('account-settings');
    await chatDB.saveSetting('account-login-pending', { startedAt: 1 });
    chatDB.resetReconnectCount = chatDB.reconnectCount = 1;
    assert.equal(await accountService.recoverAfterStorageReconnect(), false);
    assert.equal(await chatDB.getSetting('account-settings'), undefined);
    assert.equal(calls.verify, 0);
    assert.equal(calls.initializeSync, 0);
});

test('a tab that is not signed in does nothing', async t => {
    await fixture(t);
    const calls = accountFixture(t);
    accountService.state.sessionVerified = false;
    assert.equal(await accountService.recoverAfterStorageReconnect(), false);
    assert.equal(calls.verify, 0);
    assert.equal(calls.initializeSync, 0);
});

test('a sync start already under way is awaited, not cancelled', async t => {
    await fixture(t);
    const calls = accountFixture(t);
    await signedInRecord();
    // Started after the current reconnect: it used the reopened database.
    accountService.syncInitializationReconnect = chatDB.reconnectCount;
    accountService.syncInitializationInFlight = Promise.resolve(true);
    assert.equal(await accountService.recoverAfterStorageReconnect(), true);
    assert.equal(calls.initializeSync, 0);

    // A failed one is followed by a fresh start.
    accountService.syncInitializationInFlight = Promise.resolve(false);
    assert.equal(await accountService.recoverAfterStorageReconnect(), true);
    assert.equal(calls.initializeSync, 1);
});

test('a sync start from before the reconnect is awaited, then run again on the reopened database', async t => {
    await fixture(t);
    const calls = accountFixture(t);
    await signedInRecord();
    accountService.syncInitializationReconnect = chatDB.reconnectCount;
    await closeUnexpectedly();
    await chatDB.getAllSessions();
    accountService.syncInitializationInFlight = Promise.resolve(true);
    assert.equal(await accountService.recoverAfterStorageReconnect(), true);
    assert.equal(calls.initializeSync, 1);
});

test('a focus after a plain close keeps the account signed in', async t => {
    await fixture(t);
    const calls = accountFixture(t);
    await signedInRecord();
    await closeUnexpectedly();
    // The window focus handler. On the previous code its first read threw on
    // the dead connection and the catch signed the tab out.
    await accountService.reconcileSharedAccount();
    assert.equal(calls.locks, 0);
});

test('a focus that is the first thing to touch a removed database recovers before checking', async t => {
    await fixture(t);
    const calls = accountFixture(t);
    await signedInRecord();
    await closeUnexpectedly({ removeData: true });
    // Nothing has reopened the database yet; no reconnect listener runs here.
    await accountService.reconcileSharedAccount();
    assert.equal(calls.locks, 0);
    assert.equal((await chatDB.getSetting('account-settings')).accountId, ACCOUNT);
    assert.equal(calls.initializeSync, 1);
});

test('a focus while storage cannot open leaves the account alone', async t => {
    const { idb } = await fixture(t);
    const calls = accountFixture(t);
    await signedInRecord();
    await closeUnexpectedly();
    const realOpen = idb.open.bind(idb);
    idb.open = () => {
        const req = {};
        setImmediate(() => { req.error = new DOMException('Disk is full', 'UnknownError'); req.onerror?.(); });
        return req;
    };
    t.after(() => { idb.open = realOpen; });
    await accountService.reconcileSharedAccount();
    assert.equal(calls.locks, 0);
});
