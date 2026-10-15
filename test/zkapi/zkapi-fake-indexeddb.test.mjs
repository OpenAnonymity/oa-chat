// Self-test for test/zkapi/_fakeIndexedDb.mjs. Other zkAPI tests rely on that
// fake to stand in for a browser, so the behaviors they depend on are pinned
// here against what the IndexedDB and Web Locks specifications say.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FakeIndexedDb, FakeKeyRange, FakeLockManager, FakeBroadcastHub, createFakeStorage,
    createFakeEnvironment, installFakeLocks, installFakeBroadcastChannel
} from './_fakeIndexedDb.mjs';

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error('aborted'));
    });
}

// Opens `name`; `upgrade(db, request, event)` runs inside upgradeneeded.
function open(factory, name, version, upgrade = null) {
    return new Promise((resolve, reject) => {
        const request = version === undefined ? factory.open(name) : factory.open(name, version);
        request.onupgradeneeded = event => upgrade?.(request.result, request, event);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

const createStores = db => {
    db.createObjectStore('runtime');
    db.createObjectStore('rows', { keyPath: 'id' });
};

test('a versionless open of a missing database creates version 1 through upgradeneeded', async () => {
    const idb = new FakeIndexedDb();
    let seen = null;
    const db = await open(idb, 'a', undefined, (database, request, event) => {
        seen = { oldVersion: event.oldVersion, newVersion: event.newVersion };
        createStores(database);
    });
    assert.deepEqual(seen, { oldVersion: 0, newVersion: 1 });
    assert.equal(db.version, 1);
    assert.deepEqual(idb.storeNames('a'), ['rows', 'runtime']);
    assert.equal(idb.has('a'), true);
    db.close();
});

test('aborting the versionchange transaction leaves no database and fails the open with AbortError', async () => {
    const idb = new FakeIndexedDb();
    await assert.rejects(open(idb, 'a', undefined, (database, request) => {
        createStores(database);
        request.transaction.abort();
    }), error => error.name === 'AbortError');
    assert.equal(idb.has('a'), false);
    assert.deepEqual(await idb.databases(), []);
    assert.deepEqual(idb.storeNames('a'), []);
    assert.equal(idb.connectionCount('a'), 0);
    // The next open starts from nothing again.
    let upgrades = 0;
    const db = await open(idb, 'a', undefined, database => { upgrades += 1; createStores(database); });
    assert.equal(upgrades, 1);
    db.close();
});

test('a versionless open of an existing database never upgrades', async () => {
    const idb = new FakeIndexedDb();
    (await open(idb, 'a', 3, createStores)).close();
    let upgrades = 0;
    const db = await open(idb, 'a', undefined, () => { upgrades += 1; });
    assert.equal(upgrades, 0);
    assert.equal(db.version, 3);
    db.close();
});

test('opening below the stored version is a VersionError and changes nothing', async () => {
    const idb = new FakeIndexedDb();
    (await open(idb, 'a', 3, createStores)).close();
    await assert.rejects(open(idb, 'a', 2), error => error.name === 'VersionError');
    assert.equal(idb.version('a'), 3);
});

test('a higher version sends versionchange, fires blocked while another connection stays open, then upgrades', async () => {
    const idb = new FakeIndexedDb();
    const first = await open(idb, 'a', 1, createStores);
    let versionChange = null;
    first.onversionchange = event => { versionChange = { oldVersion: event.oldVersion, newVersion: event.newVersion }; };
    let blocked = false;
    const second = new Promise((resolve, reject) => {
        const request = idb.open('a', 2);
        request.onblocked = () => {
            blocked = true;
            // The other tab finally closes.
            nextTask().then(() => first.close());
        };
        request.onupgradeneeded = () => request.result.createObjectStore('extra');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const db = await second;
    assert.deepEqual(versionChange, { oldVersion: 1, newVersion: 2 });
    assert.equal(blocked, true);
    assert.equal(db.version, 2);
    assert.deepEqual(idb.storeNames('a'), ['extra', 'rows', 'runtime']);
    db.close();
});

test('a connection that closes in versionchange lets the upgrade proceed without blocked', async () => {
    const idb = new FakeIndexedDb();
    const first = await open(idb, 'a', 1, createStores);
    first.onversionchange = () => first.close();
    let blocked = false;
    const db = await new Promise((resolve, reject) => {
        const request = idb.open('a', 2);
        request.onblocked = () => { blocked = true; };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    assert.equal(blocked, false);
    db.close();
});

test('records, key ordering, in-line and out-of-line keys, add conflicts and structured cloning', async () => {
    const idb = new FakeIndexedDb();
    const db = await open(idb, 'a', 1, createStores);
    const original = { id: 'b', nested: { n: 1 } };
    let transaction = db.transaction(['runtime', 'rows'], 'readwrite');
    transaction.objectStore('rows').put(original);
    transaction.objectStore('rows').put({ id: 'a' });
    transaction.objectStore('rows').put({ id: 'c' });
    transaction.objectStore('runtime').put({ hello: 'world' }, 'active');
    original.nested.n = 99; // after put: must not leak into the store
    await transactionDone(transaction);

    transaction = db.transaction(['runtime', 'rows'], 'readonly');
    const rows = await requestResult(transaction.objectStore('rows').getAll());
    assert.deepEqual(rows.map(row => row.id), ['a', 'b', 'c']);
    assert.equal(rows[1].nested.n, 1);
    rows[1].nested.n = 5; // a returned value is a copy
    assert.deepEqual(await requestResult(transaction.objectStore('runtime').get('active')), { hello: 'world' });
    assert.equal(await requestResult(transaction.objectStore('rows').count()), 3);
    await transactionDone(transaction);
    assert.equal(idb.read('a', 'rows', 'b').nested.n, 1);

    transaction = db.transaction(['rows'], 'readwrite');
    const addRequest = transaction.objectStore('rows').add({ id: 'a' });
    await assert.rejects(requestResult(addRequest), error => error.name === 'ConstraintError');
    await assert.rejects(transactionDone(transaction));
    assert.equal(idb.read('a', 'rows', 'a').id, 'a');

    transaction = db.transaction(['rows'], 'readwrite');
    assert.throws(() => transaction.objectStore('rows').put({ id: 'x' }, 'explicit'), error => error.name === 'DataError');
    assert.throws(() => transaction.objectStore('rows').put({ no: 'key' }), error => error.name === 'DataError');
    transaction.abort();
    db.close();
});

test('an aborted multi-store transaction rolls every store back', async () => {
    const idb = new FakeIndexedDb();
    const db = await open(idb, 'a', 1, createStores);
    const transaction = db.transaction(['runtime', 'rows'], 'readwrite');
    transaction.objectStore('rows').put({ id: 'a' });
    transaction.objectStore('runtime').put('v', 'active');
    const aborted = transactionDone(transaction);
    transaction.abort();
    await assert.rejects(aborted);
    assert.equal(idb.read('a', 'rows', 'a'), undefined);
    assert.equal(idb.read('a', 'runtime', 'active'), undefined);
    assert.equal(idb.committedWrites().length, 0);
    db.close();
});

test('a transaction auto-commits once idle and is inactive afterwards; readonly refuses writes', async () => {
    const idb = new FakeIndexedDb();
    const db = await open(idb, 'a', 1, createStores);
    const transaction = db.transaction(['rows'], 'readwrite');
    transaction.objectStore('rows').put({ id: 'a' });
    await transactionDone(transaction);
    assert.throws(() => transaction.objectStore('rows'), error => error.name === 'TransactionInactiveError');
    const readonly = db.transaction(['rows'], 'readonly');
    assert.throws(() => readonly.objectStore('rows').put({ id: 'b' }), error => error.name === 'ReadOnlyError');
    await transactionDone(readonly);
    assert.throws(() => db.transaction(['missing'], 'readonly'), error => error.name === 'NotFoundError');
    db.close();
});

test('promise continuations inside request callbacks keep the transaction alive', async () => {
    const idb = new FakeIndexedDb();
    const db = await open(idb, 'a', 1, createStores);
    const transaction = db.transaction(['rows'], 'readwrite');
    const store = transaction.objectStore('rows');
    store.put({ id: 'a', n: 1 });
    const current = await requestResult(store.get('a'));
    store.put({ id: 'a', n: current.n + 1 });
    await transactionDone(transaction);
    assert.equal(idb.read('a', 'rows', 'a').n, 2);
    db.close();
});

test('overlapping readwrite transactions run in creation order; a later readonly sees their result', async () => {
    const idb = new FakeIndexedDb();
    const db = await open(idb, 'a', 1, createStores);
    const order = [];
    const first = db.transaction(['rows'], 'readwrite');
    const second = db.transaction(['rows'], 'readwrite');
    const reader = db.transaction(['rows'], 'readonly');
    const firstGet = requestResult(first.objectStore('rows').get('k')).then(value => { order.push(['first-read', value]); });
    first.objectStore('rows').put({ id: 'k', v: 1 });
    second.objectStore('rows').put({ id: 'k', v: 2 });
    const readValue = requestResult(reader.objectStore('rows').get('k'));
    await firstGet;
    await Promise.all([transactionDone(first), transactionDone(second), transactionDone(reader)]);
    assert.deepEqual(order, [['first-read', undefined]]);
    assert.equal((await readValue).v, 2);
    assert.equal(idb.read('a', 'rows', 'k').v, 2);
    db.close();
});

test('cursors walk records in key order and can delete', async () => {
    const idb = new FakeIndexedDb();
    const db = await open(idb, 'a', 1, createStores);
    let transaction = db.transaction(['rows'], 'readwrite');
    for (const id of ['b', 'c', 'a']) transaction.objectStore('rows').put({ id });
    await transactionDone(transaction);

    transaction = db.transaction(['rows'], 'readwrite');
    const seen = [];
    await new Promise((resolve, reject) => {
        const request = transaction.objectStore('rows').openCursor();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) { resolve(); return; }
            seen.push(cursor.key);
            if (cursor.key === 'b') cursor.delete();
            cursor.continue();
        };
    });
    await transactionDone(transaction);
    assert.deepEqual(seen, ['a', 'b', 'c']);
    assert.equal(idb.read('a', 'rows', 'b'), undefined);

    transaction = db.transaction(['rows'], 'readonly');
    assert.deepEqual(await requestResult(transaction.objectStore('rows')
        .getAllKeys(FakeKeyRange.lowerBound('b', true))), ['c']);
    await transactionDone(transaction);
    db.close();
});

test('close() waits for live transactions; new transactions on a closing connection throw', async () => {
    const idb = new FakeIndexedDb();
    const db = await open(idb, 'a', 1, createStores);
    const transaction = db.transaction(['rows'], 'readwrite');
    transaction.objectStore('rows').put({ id: 'a' });
    db.close();
    assert.throws(() => db.transaction(['rows'], 'readonly'), error => error.name === 'InvalidStateError');
    assert.equal(idb.connectionCount('a'), 1);
    await transactionDone(transaction);
    assert.equal(idb.connectionCount('a'), 0);
    assert.equal(idb.read('a', 'rows', 'a').id, 'a');
});

test('failNextOpen, hangNextOpen and forTab attribution', async () => {
    const idb = new FakeIndexedDb();
    idb.failNextOpen();
    await assert.rejects(open(idb, 'a'), error => error.name === 'UnknownError');

    const release = idb.hangNextOpen();
    let settled = false;
    const hung = open(idb, 'a', 1, createStores).then(db => { settled = true; return db; });
    await idb.idle();
    assert.equal(settled, false);
    release();
    (await hung).close();
    assert.equal(settled, true);

    const other = idb.forTab('tab-b');
    (await open(other, 'a')).close();
    assert.ok(idb.log.some(entry => entry.op === 'close' && entry.tab === 'tab-b'));
});

test('seed creates a database as an earlier page load would have left it', async () => {
    const idb = new FakeIndexedDb();
    idb.seed('a', { version: 3, stores: {
        runtime: { records: { active: { deploymentId: 'x' } } },
        rows: { keyPath: 'id', records: { r1: { id: 'r1' } } }
    } });
    const db = await open(idb, 'a');
    assert.equal(db.version, 3);
    const transaction = db.transaction(['runtime', 'rows'], 'readonly');
    assert.deepEqual(await requestResult(transaction.objectStore('runtime').get('active')), { deploymentId: 'x' });
    assert.deepEqual(await requestResult(transaction.objectStore('rows').getAll()), [{ id: 'r1' }]);
    await transactionDone(transaction);
    db.close();
});

test('locks: exclusive requests are FIFO and callbacks do not overlap', async () => {
    const locks = new FakeLockManager();
    const events = [];
    const run = (label, hold) => locks.request('l', async () => {
        events.push(`${label}:start`);
        await hold;
        events.push(`${label}:end`);
        return label;
    });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = run('a', gate);
    const second = run('b', Promise.resolve());
    await tick();
    assert.deepEqual(events, ['a:start']);
    assert.equal(locks.queuedCount('l'), 1);
    release();
    assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
    assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end']);
    assert.equal(locks.heldCount('l'), 0);
});

test('locks: ifAvailable gives null when held, shared locks coexist, steal aborts the holder', async () => {
    const locks = new FakeLockManager();
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const holder = locks.request('l', () => hold);
    await tick();
    assert.equal(await locks.request('l', { ifAvailable: true }, lock => lock), null);
    release();
    await holder;
    assert.deepEqual(await locks.request('l', { ifAvailable: true }, lock => lock?.mode), 'exclusive');

    let releaseShared;
    const sharedHold = new Promise(resolve => { releaseShared = resolve; });
    const shared = locks.request('s', { mode: 'shared' }, () => sharedHold);
    await tick();
    assert.equal(await locks.request('s', { mode: 'shared', ifAvailable: true }, lock => lock?.mode), 'shared');
    assert.equal(await locks.request('s', { ifAvailable: true }, lock => lock), null);
    releaseShared();
    await shared;

    let neverEnds;
    const stolenFrom = locks.request('t', () => new Promise(resolve => { neverEnds = resolve; }));
    stolenFrom.catch(() => {});
    await tick();
    assert.equal(await locks.request('t', { steal: true }, () => 'stolen'), 'stolen');
    await assert.rejects(stolenFrom, error => error.name === 'AbortError');
    neverEnds();
});

test('locks: an aborted queued request rejects without running', async () => {
    const locks = new FakeLockManager();
    let release;
    const holder = locks.request('l', () => new Promise(resolve => { release = resolve; }));
    await tick();
    const controller = new AbortController();
    let ran = false;
    const queued = locks.request('l', { signal: controller.signal }, () => { ran = true; });
    controller.abort();
    await assert.rejects(queued, error => error.name === 'AbortError');
    release();
    await holder;
    assert.equal(ran, false);
});

test('installFakeLocks(null) hides navigator.locks and restore brings the previous value back', () => {
    const before = globalThis.navigator?.locks;
    const restore = installFakeLocks(null);
    assert.equal(globalThis.navigator.locks, undefined);
    restore();
    assert.equal(globalThis.navigator?.locks, before);
});

test('broadcast: messages reach other open channels of the same name only', async () => {
    const hub = new FakeBroadcastHub();
    const restore = installFakeBroadcastChannel(hub);
    try {
        const sender = new BroadcastChannel('c');
        const receiver = new BroadcastChannel('c');
        const stranger = new BroadcastChannel('d');
        const received = [];
        receiver.onmessage = event => received.push(event.data);
        stranger.onmessage = () => received.push('stranger');
        sender.postMessage({ updatedAt: 1 });
        await tick();
        assert.deepEqual(received, [{ updatedAt: 1 }]);
        assert.deepEqual(hub.posted, [{ name: 'c', data: { updatedAt: 1 } }]);
        receiver.close();
        sender.postMessage({ updatedAt: 2 });
        await tick();
        assert.equal(received.length, 1);
        assert.equal(hub.openCount('c'), 1);
        sender.close();
        stranger.close();
    } finally {
        restore();
    }
});

test('createFakeStorage: Storage semantics and failure injection', () => {
    const storage = createFakeStorage();
    storage.setItem('a', 1);
    assert.equal(storage.getItem('a'), '1');
    assert.equal(storage.getItem('missing'), null);
    storage.failReads = true;
    assert.throws(() => storage.getItem('a'));
    storage.failReads = false;
    storage.failWrites = true;
    assert.throws(() => storage.setItem('b', 'x'));
    assert.throws(() => storage.removeItem('a'));
    storage.failWrites = false;
    storage.removeItem('a');
    assert.equal(storage.length, 0);
});

test('the environment trace orders lock grants, commits and channel posts', async () => {
    const env = createFakeEnvironment();
    const restore = env.install();
    try {
        const db = await open(env.idb, 'a', 1, createStores);
        await navigator.locks.request('l', async () => {
            const transaction = db.transaction(['rows'], 'readwrite');
            transaction.objectStore('rows').put({ id: 'a' });
            await transactionDone(transaction);
        });
        new BroadcastChannel('c').postMessage(1);
        db.close();
        assert.deepEqual(env.trace.map(entry => entry.type),
            ['lock-acquire', 'idb-commit', 'lock-release', 'channel-post']);
    } finally {
        restore();
    }
});

function tick() {
    return new Promise(resolve => setImmediate(resolve));
}

function nextTask() {
    return tick();
}
