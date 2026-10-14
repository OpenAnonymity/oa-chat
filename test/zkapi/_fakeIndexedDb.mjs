// A small, spec-faithful in-memory IndexedDB, Web Locks, BroadcastChannel and
// Web Storage for the zkAPI payment tests (plain Node, no browser).
//
// It models what the SDK wallet store and the host holdings probe depend on:
//
//   IndexedDB
//     - databases keyed by NAME with a VERSION; an open without a version
//       creates the database at version 1 (upgradeneeded fires) or opens the
//       existing one without any upgrade
//     - open(name, higher) runs a versionchange transaction after sending
//       `versionchange` to the other connections, fires `blocked` if they stay
//       open, and waits for them (a never-closing connection hangs the open,
//       like a browser)
//     - aborting the versionchange transaction rolls the database back; a
//       database that was created by that open ceases to exist, the open
//       request fails with AbortError
//     - object stores with an in-line keyPath or out-of-line keys, optional
//       autoIncrement, key-ordered get/getAll/getKey/getAllKeys/count/cursors,
//       put/add/delete/clear, key ranges
//     - multi-store transactions with the scope/mode ordering rule, a
//       copy-on-write snapshot per readwrite transaction, auto-commit once no
//       request is pending after a macrotask, TransactionInactiveError after
//       that, abort that rolls back
//     - request errors that are not prevented abort the transaction; error and
//       abort events bubble request -> transaction -> connection
//     - structured-clone semantics on every value in and out
//     - connection.close() waits for live transactions; versionchange
//       handlers; every committed write and every upgrade is logged
//   Web Locks (navigator.locks)
//     - exclusive and shared requests, FIFO, `ifAvailable` (callback gets
//       null), `steal` (the holder's request rejects with AbortError),
//       AbortSignal for queued requests, query()
//   BroadcastChannel
//     - an in-process hub: a message reaches every OTHER open channel of the
//       same name asynchronously
//   Web Storage
//     - createFakeStorage(): Map-backed Storage with failure injection
//
// Not modelled: indexes, compound keyPaths, Date/array/binary keys, quota,
// eviction, real durability, cross-process timing. Tests that need those do
// not belong on this fake.
//
// Typical use:
//
//     const env = createFakeEnvironment();      // idb + locks + channels
//     const restore = env.install();            // sets the globals
//     try { ... } finally { restore(); }
//
// `env.trace` is one ordered log of IDB commits, lock grants/releases and
// channel posts, for asserting "the write happened under the lock" and "the
// message was posted after the commit".
//
// Timers: every internal wait uses the setImmediate captured when this module
// loaded, so tests that mock setTimeout/setImmediate (node:test mock.timers)
// do not stall the fake.

const nativeSetImmediate = globalThis.setImmediate;
const tick = () => new Promise(resolve => nativeSetImmediate(resolve));

function domError(name, message) {
    return new DOMException(message, name);
}

// ---------------------------------------------------------------- events

class Emitter {
    #listeners = new Map();

    addEventListener(type, listener) {
        if (!this.#listeners.has(type)) this.#listeners.set(type, []);
        this.#listeners.get(type).push(listener);
    }

    removeEventListener(type, listener) {
        const list = this.#listeners.get(type);
        if (list) this.#listeners.set(type, list.filter(item => item !== listener));
    }

    // Calls `on<type>` then the listeners. Returns the event. A throwing
    // handler is reported through `onHandlerError` (the caller aborts the
    // transaction, as a browser does) and never escapes into the scheduler.
    _dispatch(type, props = {}, onHandlerError = null) {
        const event = {
            type,
            target: props.target || this,
            currentTarget: this,
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; },
            ...props
        };
        const handlers = [];
        if (typeof this[`on${type}`] === 'function') handlers.push(this[`on${type}`]);
        handlers.push(...(this.#listeners.get(type) || []));
        for (const handler of handlers) {
            try {
                handler.call(this, event);
            } catch (error) {
                if (onHandlerError) onHandlerError(error);
                else throw error;
            }
        }
        return event;
    }
}

// ------------------------------------------------------------------ keys

function validKey(key) {
    return (typeof key === 'number' && Number.isFinite(key)) || typeof key === 'string';
}

function compareKeys(left, right) {
    const leftType = typeof left;
    if (leftType !== typeof right) return leftType === 'number' ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
}

function keyAtPath(value, keyPath) {
    let current = value;
    for (const part of keyPath.split('.')) {
        if (current === null || typeof current !== 'object') return undefined;
        current = current[part];
    }
    return current;
}

function setKeyAtPath(value, keyPath, key) {
    const parts = keyPath.split('.');
    let current = value;
    for (const part of parts.slice(0, -1)) {
        if (current[part] === null || typeof current[part] !== 'object') current[part] = {};
        current = current[part];
    }
    current[parts[parts.length - 1]] = key;
}

export class FakeKeyRange {
    constructor(lower, upper, lowerOpen, upperOpen) {
        this.lower = lower;
        this.upper = upper;
        this.lowerOpen = lowerOpen;
        this.upperOpen = upperOpen;
    }

    static only(key) {
        if (!validKey(key)) throw domError('DataError', 'Invalid key.');
        return new FakeKeyRange(key, key, false, false);
    }

    static lowerBound(lower, open = false) {
        if (!validKey(lower)) throw domError('DataError', 'Invalid key.');
        return new FakeKeyRange(lower, undefined, Boolean(open), true);
    }

    static upperBound(upper, open = false) {
        if (!validKey(upper)) throw domError('DataError', 'Invalid key.');
        return new FakeKeyRange(undefined, upper, true, Boolean(open));
    }

    static bound(lower, upper, lowerOpen = false, upperOpen = false) {
        if (!validKey(lower) || !validKey(upper)) throw domError('DataError', 'Invalid key.');
        if (compareKeys(lower, upper) > 0) throw domError('DataError', 'The lower key is greater than the upper key.');
        return new FakeKeyRange(lower, upper, Boolean(lowerOpen), Boolean(upperOpen));
    }

    includes(key) {
        if (this.lower !== undefined) {
            const order = compareKeys(key, this.lower);
            if (order < 0 || (order === 0 && this.lowerOpen)) return false;
        }
        if (this.upper !== undefined) {
            const order = compareKeys(key, this.upper);
            if (order > 0 || (order === 0 && this.upperOpen)) return false;
        }
        return true;
    }
}

function toRange(query) {
    if (query === undefined || query === null) return null;
    if (query instanceof FakeKeyRange) return query;
    if (validKey(query)) return FakeKeyRange.only(query);
    throw domError('DataError', 'The query is not a valid key or key range.');
}

// -------------------------------------------------------------- data model

class StoreData {
    constructor(name, keyPath, autoIncrement) {
        this.name = name;
        this.keyPath = keyPath ?? null;
        this.autoIncrement = Boolean(autoIncrement);
        this.records = new Map();
        this.keyGen = 1;
    }

    snapshot() {
        const copy = new StoreData(this.name, this.keyPath, this.autoIncrement);
        copy.records = new Map([...this.records].map(([key, value]) => [key, structuredClone(value)]));
        copy.keyGen = this.keyGen;
        return copy;
    }
}

class DatabaseData {
    constructor(name) {
        this.name = name;
        this.version = 0;
        this.stores = new Map();
        this.connections = new Set();
        this.live = [];
        this.closeWaiters = [];
    }

    notifyClosed() {
        const waiters = this.closeWaiters;
        this.closeWaiters = [];
        for (const waiter of waiters) waiter();
    }

    waitUntil(predicate) {
        return new Promise(resolve => {
            const check = () => {
                if (predicate()) resolve();
                else this.closeWaiters.push(check);
            };
            check();
        });
    }
}

class Origin {
    constructor(trace) {
        this.databases = new Map();
        this.queues = new Map();
        this.log = [];
        this.trace = trace;
        this.faults = { failOpen: null, hangOpen: null };
        this.handlerErrors = [];
    }

    note(entry) {
        this.log.push(entry);
    }
}

// ---------------------------------------------------------------- requests

class FakeRequest extends Emitter {
    constructor(source = null, transaction = null) {
        super();
        this.result = undefined;
        this.error = null;
        this.source = source;
        this.transaction = transaction;
        this.readyState = 'pending';
        this.onsuccess = null;
        this.onerror = null;
    }
}

class FakeOpenRequest extends FakeRequest {
    constructor() {
        super();
        this.onupgradeneeded = null;
        this.onblocked = null;
    }
}

// ------------------------------------------------------------- transaction

class FakeTransaction extends Emitter {
    #connection;
    #origin;
    #db;
    #scope;
    #mode;
    #state = 'active';
    #pending = 0;
    #error = null;
    #writes = [];
    #working = new Map();
    #started;
    #done;
    #finish;
    #commitRequested = false;
    #structure = null;
    #stores = new Map();

    constructor(connection, scope, mode, options = {}) {
        super();
        this.#connection = connection;
        this.#origin = connection._origin;
        this.#db = connection._db;
        this.#scope = scope;
        this.#mode = mode;
        this.durability = options.durability || 'default';
        this.oncomplete = null;
        this.onabort = null;
        this.onerror = null;
        const earlier = this.#db.live.filter(other => other._overlaps(scope, mode));
        this.#done = new Promise(resolve => { this.#finish = resolve; });
        this.#db.live.push(this);
        this.#started = Promise.all(earlier.map(other => other._done));
        if (mode === 'versionchange') {
            // Roll back to this on abort: every store with its records.
            this.#structure = {
                version: this.#db.version,
                stores: new Map([...this.#db.stores].map(([name, store]) => [name, store.snapshot()]))
            };
        }
        // A transaction that never receives a request commits at the next
        // macrotask once its predecessors are done.
        this.#started.then(() => this.#scheduleCommit());
    }

    get mode() { return this.#mode; }
    get db() { return this.#connection; }
    get error() { return this.#error; }
    get objectStoreNames() { return [...this.#storeNames()].sort(); }

    get _done() { return this.#done; }
    get _state() { return this.#state; }
    get _connection() { return this.#connection; }

    _overlaps(scope, mode) {
        if (this.#state !== 'active') return false;
        if (this.#mode === 'readonly' && mode === 'readonly') return false;
        if (this.#mode === 'versionchange' || mode === 'versionchange') return true;
        return this.#scope.some(name => scope.includes(name));
    }

    #storeNames() {
        return this.#mode === 'versionchange' ? this.#db.stores.keys() : this.#scope;
    }

    objectStore(name) {
        if (this.#state !== 'active') throw domError('TransactionInactiveError', 'The transaction has finished.');
        if (this.#mode === 'versionchange' ? !this.#db.stores.has(name) : !this.#scope.includes(name)) {
            throw domError('NotFoundError', `No object store named ${name} in this transaction.`);
        }
        if (!this.#stores.has(name)) this.#stores.set(name, new FakeObjectStore(this, name));
        return this.#stores.get(name);
    }

    _meta(name) {
        return this.#db.stores.get(name);
    }

    // The records a transaction operates on: the live map for readonly, a
    // lazily cloned map for everything that can write.
    _working(name) {
        if (!this.#working.has(name)) {
            const source = this.#db.stores.get(name);
            this.#working.set(name, this.#mode === 'readonly'
                ? { records: source.records, keyGen: source.keyGen }
                : { records: new Map([...source.records].map(([key, value]) => [key, structuredClone(value)])),
                    keyGen: source.keyGen });
        }
        return this.#working.get(name);
    }

    _recordWrite(entry) {
        this.#writes.push(entry);
    }

    _assertWritable() {
        if (this.#mode === 'readonly') throw domError('ReadOnlyError', 'The transaction is read-only.');
    }

    // Queue one request's work; the request's events fire in a later task.
    _enqueue(request, operation) {
        if (this.#state !== 'active') throw domError('TransactionInactiveError', 'The transaction has finished.');
        this.#pending += 1;
        this.#started.then(() => nativeSetImmediate(() => this.#execute(request, operation)));
        return request;
    }

    #execute(request, operation) {
        try {
            if (this.#state !== 'active') {
                request.error = domError('AbortError', 'The transaction was aborted.');
                request.readyState = 'done';
                this.#bubbleError(request, true);
                return;
            }
            try {
                request.result = operation();
                request.readyState = 'done';
            } catch (error) {
                request.error = error;
                request.readyState = 'done';
                this.#bubbleError(request, false);
                return;
            }
            request._dispatch('success', {}, error => this.#handlerFailed(error));
        } finally {
            this.#pending -= 1;
            if (this.#state === 'active') this.#scheduleCommit();
            else this.#maybeFinishAbort();
        }
    }

    #handlerFailed(error) {
        this.#origin.handlerErrors.push(error);
        this.#abortWith(error);
    }

    // error events bubble request -> transaction -> connection; one that is not
    // prevented aborts the transaction.
    #bubbleError(request, aborted) {
        const event = request._dispatch('error', {}, error => this.#handlerFailed(error));
        if (!event.propagationStopped) {
            const bubbled = this._dispatch('error', { target: request }, error => this.#handlerFailed(error));
            if (!bubbled.propagationStopped) {
                this.#connection._dispatch('error', { target: request });
            }
            if (bubbled.defaultPrevented) event.defaultPrevented = true;
        }
        if (!event.defaultPrevented && !aborted && this.#state === 'active') this.#abortWith(request.error);
    }

    #scheduleCommit() {
        nativeSetImmediate(() => {
            if (this.#state !== 'active' || this.#pending > 0) return;
            this.#commit();
        });
    }

    commit() {
        if (this.#state !== 'active') throw domError('InvalidStateError', 'The transaction has finished.');
        this.#commitRequested = true;
        if (this.#pending === 0) this.#scheduleCommit();
    }

    #commit() {
        this.#state = 'committed';
        if (this.#mode !== 'readonly') {
            for (const [name, working] of this.#working) {
                const store = this.#db.stores.get(name);
                if (!store) continue;
                store.records = working.records;
                store.keyGen = working.keyGen;
            }
        }
        this.#db.live.splice(this.#db.live.indexOf(this), 1);
        if (this.#writes.length) {
            const entry = { op: 'commit', db: this.#db.name, tab: this.#connection._tab, mode: this.#mode,
                stores: [...this.#storeNames()], durability: this.durability, writes: this.#writes };
            this.#origin.note(entry);
            this.#origin.trace?.push({ type: 'idb-commit', db: this.#db.name, tab: this.#connection._tab,
                stores: entry.stores, writes: this.#writes.map(write => ({ ...write })) });
        }
        // The complete event is its own task, as in a browser: a handler
        // attached in the microtask after the last request's callback still
        // sees it.
        nativeSetImmediate(() => {
            this._dispatch('complete', {}, error => this.#origin.handlerErrors.push(error));
            this.#finish();
            this.#connection._transactionFinished();
        });
    }

    abort() {
        if (this.#state !== 'active') throw domError('InvalidStateError', 'The transaction has finished.');
        this.#abortWith(null);
    }

    #abortWith(error) {
        if (this.#state !== 'active') return;
        this.#state = 'aborted';
        this.#error = error;
        this.#origin.note({ op: 'abort', db: this.#db.name, tab: this.#connection._tab, mode: this.#mode,
            discardedWrites: this.#writes });
        if (this.#mode === 'versionchange') {
            this.#db.version = this.#structure.version;
            this.#db.stores = this.#structure.stores;
        }
        // Requests still queued each fail with AbortError when their turn comes.
        this.#maybeFinishAbort();
    }

    #maybeFinishAbort() {
        if (this.#state !== 'aborted' || this.#pending > 0) return;
        this.#state = 'aborted-final';
        const index = this.#db.live.indexOf(this);
        if (index >= 0) this.#db.live.splice(index, 1);
        // The abort event is its own task (after the request's error event).
        nativeSetImmediate(() => {
            this._dispatch('abort', {}, handlerError => this.#origin.handlerErrors.push(handlerError));
            this.#connection._dispatch('abort', { target: this });
            this.#finish();
            this.#connection._transactionFinished();
        });
    }

    _isFinished() {
        return this.#state === 'committed' || this.#state === 'aborted-final';
    }

    // The upgrade transaction's abort is observed by the open request.
    _wasAborted() {
        return this.#state === 'aborted' || this.#state === 'aborted-final';
    }
}

// ------------------------------------------------------------ object store

class FakeCursor {
    #request;
    #transaction;
    #name;
    #keys;
    #index = -1;
    #withValue;

    constructor(request, transaction, name, keys, withValue) {
        this.#request = request;
        this.#transaction = transaction;
        this.#name = name;
        this.#keys = keys;
        this.#withValue = withValue;
        this.key = undefined;
        this.primaryKey = undefined;
        this.value = undefined;
        this.direction = 'next';
    }

    // Moves to the next position and fires the shared request's success event.
    _step() {
        this.#index += 1;
        const records = this.#transaction._working(this.#name).records;
        if (this.#index >= this.#keys.length) {
            this.#request.result = null;
            return null;
        }
        const key = this.#keys[this.#index];
        this.key = key;
        this.primaryKey = key;
        if (this.#withValue) this.value = structuredClone(records.get(key));
        this.#request.result = this;
        return this;
    }

    continue() {
        this.#request.readyState = 'pending';
        this.#transaction._enqueue(this.#request, () => {
            this._step();
            return this.#request.result;
        });
    }

    update(value) {
        this.#transaction._assertWritable();
        const meta = this.#transaction._meta(this.#name);
        const request = new FakeRequest(this, this.#transaction);
        const cloned = structuredClone(value);
        const key = this.primaryKey;
        if (meta.keyPath !== null && keyAtPath(cloned, meta.keyPath) !== key) {
            throw domError('DataError', 'The cursor update changes the record key.');
        }
        return this.#transaction._enqueue(request, () => {
            this.#transaction._working(this.#name).records.set(key, cloned);
            this.#transaction._recordWrite({ store: this.#name, op: 'put', key: String(key) });
            return key;
        });
    }

    delete() {
        this.#transaction._assertWritable();
        const request = new FakeRequest(this, this.#transaction);
        const key = this.primaryKey;
        return this.#transaction._enqueue(request, () => {
            this.#transaction._working(this.#name).records.delete(key);
            this.#transaction._recordWrite({ store: this.#name, op: 'delete', key: String(key) });
            return undefined;
        });
    }
}

class FakeObjectStore {
    #transaction;

    constructor(transaction, name) {
        this.#transaction = transaction;
        this.name = name;
        this.transaction = transaction;
    }

    get keyPath() { return this.#transaction._meta(this.name).keyPath; }
    get autoIncrement() { return this.#transaction._meta(this.name).autoIncrement; }
    get indexNames() { return []; }

    #request() {
        return new FakeRequest(this, this.#transaction);
    }

    #sortedKeys(range, direction = 'next') {
        const records = this.#transaction._working(this.name).records;
        const keys = [...records.keys()].filter(key => !range || range.includes(key)).sort(compareKeys);
        return direction === 'prev' || direction === 'prevunique' ? keys.reverse() : keys;
    }

    // Resolve the record key for put/add and normalize the stored value.
    #prepare(value, key) {
        const meta = this.#transaction._meta(this.name);
        if (meta.keyPath !== null) {
            if (key !== undefined) throw domError('DataError', 'An in-line store takes no explicit key.');
            const cloned = structuredClone(value);
            let resolved = cloned !== null && typeof cloned === 'object' ? keyAtPath(cloned, meta.keyPath) : undefined;
            if (resolved === undefined) {
                if (!meta.autoIncrement || cloned === null || typeof cloned !== 'object') {
                    throw domError('DataError', 'The record has no key.');
                }
                resolved = null;
            } else if (!validKey(resolved)) {
                throw domError('DataError', 'The record key is not a valid key.');
            }
            return { cloned, key: resolved, generate: resolved === null };
        }
        if (key === undefined) {
            if (!meta.autoIncrement) throw domError('DataError', 'An out-of-line store needs a key.');
            return { cloned: structuredClone(value), key: null, generate: true };
        }
        if (!validKey(key)) throw domError('DataError', 'The key is not a valid key.');
        return { cloned: structuredClone(value), key, generate: false };
    }

    #store(op, value, key) {
        if (this.#transaction._state !== 'active') {
            throw domError('TransactionInactiveError', 'The transaction has finished.');
        }
        this.#transaction._assertWritable();
        const prepared = this.#prepare(value, key);
        const request = this.#request();
        return this.#transaction._enqueue(request, () => {
            const meta = this.#transaction._meta(this.name);
            const working = this.#transaction._working(this.name);
            let resolved = prepared.key;
            if (prepared.generate) {
                resolved = working.keyGen;
                working.keyGen += 1;
                if (meta.keyPath !== null) setKeyAtPath(prepared.cloned, meta.keyPath, resolved);
            } else if (meta.autoIncrement && typeof resolved === 'number' && resolved >= working.keyGen) {
                working.keyGen = Math.floor(resolved) + 1;
            }
            if (op === 'add' && working.records.has(resolved)) {
                throw domError('ConstraintError', 'A record with this key already exists.');
            }
            working.records.set(resolved, prepared.cloned);
            this.#transaction._recordWrite({ store: this.name, op, key: String(resolved) });
            return resolved;
        });
    }

    put(value, key) { return this.#store('put', value, key); }
    add(value, key) { return this.#store('add', value, key); }

    get(query) {
        const range = toRange(query);
        if (!range) throw domError('DataError', 'A key is required.');
        return this.#transaction._enqueue(this.#request(), () => {
            const records = this.#transaction._working(this.name).records;
            const key = this.#sortedKeys(range)[0];
            return key === undefined ? undefined : structuredClone(records.get(key));
        });
    }

    getKey(query) {
        const range = toRange(query);
        if (!range) throw domError('DataError', 'A key is required.');
        return this.#transaction._enqueue(this.#request(), () => this.#sortedKeys(range)[0]);
    }

    getAll(query, count) {
        const range = toRange(query);
        return this.#transaction._enqueue(this.#request(), () => {
            const records = this.#transaction._working(this.name).records;
            const keys = this.#sortedKeys(range);
            return (count ? keys.slice(0, count) : keys).map(key => structuredClone(records.get(key)));
        });
    }

    getAllKeys(query, count) {
        const range = toRange(query);
        return this.#transaction._enqueue(this.#request(), () => {
            const keys = this.#sortedKeys(range);
            return count ? keys.slice(0, count) : keys;
        });
    }

    count(query) {
        const range = toRange(query);
        return this.#transaction._enqueue(this.#request(), () => this.#sortedKeys(range).length);
    }

    delete(query) {
        this.#transaction._assertWritable();
        const range = toRange(query);
        if (!range) throw domError('DataError', 'A key is required.');
        return this.#transaction._enqueue(this.#request(), () => {
            const working = this.#transaction._working(this.name);
            for (const key of this.#sortedKeys(range)) {
                working.records.delete(key);
                this.#transaction._recordWrite({ store: this.name, op: 'delete', key: String(key) });
            }
            return undefined;
        });
    }

    clear() {
        this.#transaction._assertWritable();
        return this.#transaction._enqueue(this.#request(), () => {
            this.#transaction._working(this.name).records.clear();
            this.#transaction._recordWrite({ store: this.name, op: 'clear', key: null });
            return undefined;
        });
    }

    #cursor(query, direction, withValue) {
        const range = toRange(query);
        const request = this.#request();
        return this.#transaction._enqueue(request, () => {
            const cursor = new FakeCursor(request, this.#transaction, this.name,
                this.#sortedKeys(range, direction), withValue);
            cursor.direction = direction;
            return cursor._step();
        });
    }

    openCursor(query, direction = 'next') { return this.#cursor(query, direction, true); }
    openKeyCursor(query, direction = 'next') { return this.#cursor(query, direction, false); }

    index() {
        throw domError('NotFoundError', 'Indexes are not modelled by the fake IndexedDB.');
    }

    createIndex() {
        throw domError('InvalidStateError', 'Indexes are not modelled by the fake IndexedDB.');
    }
}

// -------------------------------------------------------------- connection

class FakeConnection extends Emitter {
    #origin;
    #db;
    #tab;
    #closePending = false;
    #closed = false;
    #upgradeTransaction = null;

    constructor(origin, db, tab) {
        super();
        this.#origin = origin;
        this.#db = db;
        this.#tab = tab;
        this.onversionchange = null;
        this.onabort = null;
        this.onerror = null;
        this.onclose = null;
        const connection = this;
        this.objectStoreNames = {
            contains: name => connection.#db.stores.has(name),
            item: index => [...connection.#db.stores.keys()].sort()[index] ?? null,
            get length() { return connection.#db.stores.size; },
            [Symbol.iterator]() { return [...connection.#db.stores.keys()].sort()[Symbol.iterator](); }
        };
    }

    get name() { return this.#db.name; }
    get version() { return this.#db.version; }
    get _origin() { return this.#origin; }
    get _db() { return this.#db; }
    get _tab() { return this.#tab; }
    get _closed() { return this.#closed; }

    _beginUpgrade(transaction) {
        this.#upgradeTransaction = transaction;
    }

    _endUpgrade() {
        this.#upgradeTransaction = null;
    }

    createObjectStore(name, options = {}) {
        if (!this.#upgradeTransaction || this.#upgradeTransaction._state !== 'active') {
            throw domError('InvalidStateError', 'createObjectStore needs an active versionchange transaction.');
        }
        if (this.#db.stores.has(name)) throw domError('ConstraintError', `An object store named ${name} exists.`);
        const keyPath = options.keyPath ?? null;
        if (keyPath !== null && typeof keyPath !== 'string') {
            throw domError('SyntaxError', 'Only string key paths are modelled.');
        }
        this.#db.stores.set(name, new StoreData(name, keyPath, options.autoIncrement));
        this.#origin.note({ op: 'create-store', db: this.#db.name, tab: this.#tab, store: name, keyPath });
        return this.#upgradeTransaction.objectStore(name);
    }

    deleteObjectStore(name) {
        if (!this.#upgradeTransaction || this.#upgradeTransaction._state !== 'active') {
            throw domError('InvalidStateError', 'deleteObjectStore needs an active versionchange transaction.');
        }
        if (!this.#db.stores.has(name)) throw domError('NotFoundError', `No object store named ${name}.`);
        this.#db.stores.delete(name);
        this.#origin.note({ op: 'delete-store', db: this.#db.name, tab: this.#tab, store: name });
    }

    transaction(storeNames, mode = 'readonly', options = {}) {
        if (this.#closePending || this.#closed) {
            throw domError('InvalidStateError', 'The database connection is closing.');
        }
        if (this.#upgradeTransaction) {
            throw domError('InvalidStateError', 'A version change transaction is running.');
        }
        if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError(`Invalid transaction mode: ${mode}`);
        const scope = [...new Set(Array.isArray(storeNames) ? storeNames : [storeNames])];
        if (!scope.length) throw domError('InvalidAccessError', 'A transaction needs at least one object store.');
        for (const name of scope) {
            if (!this.#db.stores.has(name)) throw domError('NotFoundError', `No object store named ${name}.`);
        }
        return new FakeTransaction(this, scope, mode, options);
    }

    _versionChangeTransaction() {
        return new FakeTransaction(this, [], 'versionchange', {});
    }

    close() {
        if (this.#closed) return;
        this.#closePending = true;
        this.#origin.note({ op: 'close', db: this.#db.name, tab: this.#tab });
        this.#settleClose();
    }

    _transactionFinished() {
        if (this.#closePending) this.#settleClose();
    }

    #settleClose() {
        if (this.#db.live.some(transaction => transaction._connection === this && !transaction._isFinished())) return;
        this.#closed = true;
        this.#db.connections.delete(this);
        this.#db.notifyClosed();
    }
}

// ------------------------------------------------------------- the factory

export class FakeIndexedDb {
    #origin;
    #tab;

    constructor({ trace = [], tab = 'tab0', origin = null } = {}) {
        this.#origin = origin || new Origin(trace);
        this.#tab = tab;
    }

    /** A view of the same origin whose connections are attributed to `label`. */
    forTab(label) {
        return new FakeIndexedDb({ origin: this.#origin, tab: label });
    }

    // ---- IDBFactory

    open(name, version) {
        if (typeof name !== 'string') throw new TypeError('The database name must be a string.');
        if (version !== undefined && (!Number.isInteger(version) || version < 1 || version > Number.MAX_SAFE_INTEGER)) {
            throw new TypeError('The version must be a positive integer.');
        }
        const origin = this.#origin;
        const tab = this.#tab;
        const request = new FakeOpenRequest();
        origin.note({ op: 'open-request', db: name, tab, version: version ?? null });
        const start = () => this.#enqueue(name, () => this.#processOpen(name, version, request, tab));
        if (origin.faults.hangOpen) {
            // Never answered until the test releases it.
            origin.faults.hangOpen.parked.push(start);
            origin.faults.hangOpen = null;
            return request;
        }
        nativeSetImmediate(start);
        return request;
    }

    deleteDatabase(name) {
        const origin = this.#origin;
        const tab = this.#tab;
        const request = new FakeOpenRequest();
        nativeSetImmediate(() => this.#enqueue(name, () => this.#processDelete(name, request, tab)));
        origin.note({ op: 'delete-request', db: name, tab });
        return request;
    }

    async databases() {
        return [...this.#origin.databases.values()]
            .filter(db => db.version > 0)
            .map(db => ({ name: db.name, version: db.version }));
    }

    cmp(left, right) {
        if (!validKey(left) || !validKey(right)) throw domError('DataError', 'Invalid key.');
        return compareKeys(left, right);
    }

    // ---- test API

    /** Every log entry so far: opens, upgrades, store creation, commits, aborts, closes. */
    get log() { return this.#origin.log; }

    /** Exceptions thrown by event handlers (each aborted its transaction). */
    get handlerErrors() { return this.#origin.handlerErrors; }

    /** Committed writes in order: [{db, tab, store, op, key}]. */
    committedWrites() {
        return this.#origin.log.filter(entry => entry.op === 'commit')
            .flatMap(entry => entry.writes.map(write => ({ db: entry.db, tab: entry.tab, ...write })));
    }

    /** Whether a database exists (committed, version above zero). */
    has(name) {
        return (this.#origin.databases.get(name)?.version ?? 0) > 0;
    }

    version(name) {
        return this.#origin.databases.get(name)?.version ?? 0;
    }

    storeNames(name) {
        return [...(this.#origin.databases.get(name)?.stores.keys() || [])].sort();
    }

    /** Number of open (not yet closed) connections to `name`. */
    connectionCount(name) {
        return this.#origin.databases.get(name)?.connections.size ?? 0;
    }

    /** Synchronous committed read of one record (a clone), or undefined. */
    read(name, storeName, key) {
        const value = this.#origin.databases.get(name)?.stores.get(storeName)?.records.get(key);
        return value === undefined ? undefined : structuredClone(value);
    }

    /** Deep snapshot: { [db]: { version, stores: { [store]: { keyPath, records: { [key]: value } } } } }. */
    dump() {
        const out = {};
        for (const [name, db] of this.#origin.databases) {
            if (db.version === 0) continue;
            out[name] = { version: db.version, stores: {} };
            for (const [storeName, store] of db.stores) {
                const entries = [...store.records].sort((left, right) => compareKeys(left[0], right[0]));
                out[name].stores[storeName] = {
                    keyPath: store.keyPath,
                    autoIncrement: store.autoIncrement,
                    records: Object.fromEntries(entries.map(([key, value]) => [String(key), structuredClone(value)]))
                };
            }
        }
        return out;
    }

    /**
     * Create (or replace) a database directly, as a previous page load of some
     * build would have left it. `stores`: { name: { keyPath?, autoIncrement?, records?: {key: value} } }.
     */
    seed(name, { version = 1, stores = {} } = {}) {
        const db = new DatabaseData(name);
        db.version = version;
        for (const [storeName, spec] of Object.entries(stores)) {
            const store = new StoreData(storeName, spec.keyPath ?? null, spec.autoIncrement);
            // An object's keys are strings; pass an array of [key, value]
            // pairs for numeric keys.
            const pairs = Array.isArray(spec.records) ? spec.records : Object.entries(spec.records || {});
            for (const [key, value] of pairs) store.records.set(key, structuredClone(value));
            db.stores.set(storeName, store);
        }
        this.#origin.databases.set(name, db);
        return this;
    }

    /** Remove a database without any events (test cleanup). */
    drop(name) {
        this.#origin.databases.delete(name);
    }

    /** The next open() fails with `error` (default an UnknownError). */
    failNextOpen(error = domError('UnknownError', 'The open request failed.')) {
        this.#origin.faults.failOpen = error;
    }

    /**
     * The next open() is accepted but never answered, like a browser that
     * never responds. Returns release(): processes it as if it had just arrived.
     */
    hangNextOpen() {
        const hang = { parked: [] };
        this.#origin.faults.hangOpen = hang;
        return () => {
            for (const start of hang.parked.splice(0)) nativeSetImmediate(start);
        };
    }

    /** Resolve after live transactions and queued opens have settled. */
    async idle() {
        for (let quiet = 0; quiet < 4;) {
            await tick();
            const busy = [...this.#origin.databases.values()].some(db => db.live.length > 0);
            quiet = busy ? 0 : quiet + 1;
        }
    }

    // ---- internals

    // Opens of one database name are processed one at a time, in order.
    #enqueue(name, work) {
        const queues = this.#origin.queues;
        const previous = queues.get(name) || Promise.resolve();
        const next = previous.then(work, work).catch(error => { this.#origin.handlerErrors.push(error); });
        queues.set(name, next);
        return next;
    }

    #fail(request, error) {
        request.error = error;
        request.readyState = 'done';
        request._dispatch('error', {}, handlerError => this.#origin.handlerErrors.push(handlerError));
    }

    async #processOpen(name, requestedVersion, request, tab) {
        const origin = this.#origin;
        if (origin.faults.failOpen) {
            const error = origin.faults.failOpen;
            origin.faults.failOpen = null;
            this.#fail(request, error);
            return;
        }
        let db = origin.databases.get(name);
        const existed = Boolean(db) && db.version > 0;
        const oldVersion = existed ? db.version : 0;
        const newVersion = requestedVersion ?? (existed ? oldVersion : 1);
        if (existed && newVersion < oldVersion) {
            origin.note({ op: 'open-error', db: name, tab, code: 'VersionError' });
            this.#fail(request, domError('VersionError',
                `The requested version (${newVersion}) is less than the existing version (${oldVersion}).`));
            return;
        }
        if (!db) {
            db = new DatabaseData(name);
            origin.databases.set(name, db);
        }
        const connection = new FakeConnection(origin, db, tab);
        if (newVersion > oldVersion) {
            const others = [...db.connections];
            for (const other of others) {
                origin.note({ op: 'versionchange', db: name, to: other._tab, from: tab, oldVersion, newVersion });
                other._dispatch('versionchange', { oldVersion, newVersion },
                    error => origin.handlerErrors.push(error));
            }
            await tick();
            if ([...db.connections].some(other => !other._closed)) {
                origin.note({ op: 'blocked', db: name, tab, oldVersion, newVersion });
                request._dispatch('blocked', { oldVersion, newVersion },
                    error => origin.handlerErrors.push(error));
                await db.waitUntil(() => db.connections.size === 0);
            }
            await this.#upgrade({ origin, db, name, tab, connection, request, existed, oldVersion, newVersion });
            return;
        }
        db.connections.add(connection);
        request.result = connection;
        request.readyState = 'done';
        origin.note({ op: 'open-success', db: name, tab, version: db.version, upgraded: false });
        request._dispatch('success', {}, error => origin.handlerErrors.push(error));
    }

    async #upgrade({ origin, db, name, tab, connection, request, existed, oldVersion, newVersion }) {
        const transaction = connection._versionChangeTransaction();
        connection._beginUpgrade(transaction);
        db.connections.add(connection);
        db.version = newVersion;
        request.result = connection;
        request.transaction = transaction;
        origin.note({ op: 'upgrade-start', db: name, tab, oldVersion, newVersion, storesBefore: [...db.stores.keys()].sort() });
        request._dispatch('upgradeneeded', { oldVersion, newVersion },
            error => { origin.handlerErrors.push(error); try { transaction.abort(); } catch { /* finished */ } });
        // The handler may close the connection or abort; the transaction then
        // finishes on its own. Wait for it.
        await transaction._done;
        connection._endUpgrade();
        if (transaction._wasAborted() || connection._closed) {
            // Roll back: a database this open created ceases to exist.
            if (!existed) origin.databases.delete(name);
            else db.version = oldVersion;
            db.connections.delete(connection);
            origin.note({ op: 'upgrade-aborted', db: name, tab, existed });
            db.notifyClosed();
            request.result = undefined;
            this.#fail(request, domError('AbortError', 'The version change transaction was aborted.'));
            return;
        }
        origin.note({ op: 'upgrade-committed', db: name, tab, oldVersion, newVersion, stores: [...db.stores.keys()].sort() });
        request.readyState = 'done';
        request.transaction = null;
        origin.note({ op: 'open-success', db: name, tab, version: db.version, upgraded: true });
        request._dispatch('success', {}, error => origin.handlerErrors.push(error));
    }

    async #processDelete(name, request, tab) {
        const origin = this.#origin;
        const db = origin.databases.get(name);
        if (!db || db.version === 0) {
            request.result = undefined;
            request.readyState = 'done';
            request._dispatch('success', {}, error => origin.handlerErrors.push(error));
            return;
        }
        const oldVersion = db.version;
        for (const other of [...db.connections]) {
            other._dispatch('versionchange', { oldVersion, newVersion: null },
                error => origin.handlerErrors.push(error));
        }
        await tick();
        if ([...db.connections].some(other => !other._closed)) {
            request._dispatch('blocked', { oldVersion, newVersion: null }, error => origin.handlerErrors.push(error));
            await db.waitUntil(() => db.connections.size === 0);
        }
        origin.databases.delete(name);
        origin.note({ op: 'delete-database', db: name, tab });
        request.result = undefined;
        request.readyState = 'done';
        request._dispatch('success', {}, error => origin.handlerErrors.push(error));
    }
}

// ---------------------------------------------------------------- Web Locks

/**
 * navigator.locks. Exclusive and shared, FIFO, `ifAvailable`, `steal`, `signal`.
 * `forTab(label)` shares the lock table, attributing grants to a tab.
 */
export class FakeLockManager {
    #state;
    #tab;

    constructor({ trace = [], tab = 'tab0', state = null } = {}) {
        this.#state = state || { names: new Map(), trace };
        this.#tab = tab;
    }

    forTab(label) {
        return new FakeLockManager({ state: this.#state, tab: label });
    }

    #entry(name) {
        if (!this.#state.names.has(name)) this.#state.names.set(name, { held: new Set(), queue: [] });
        return this.#state.names.get(name);
    }

    #grantable(entry, mode) {
        if (entry.queue.length) return false;
        if (mode === 'exclusive') return entry.held.size === 0;
        return [...entry.held].every(grant => grant.mode === 'shared');
    }

    #drain(name) {
        const entry = this.#entry(name);
        while (entry.queue.length) {
            const next = entry.queue[0];
            const ok = next.mode === 'exclusive'
                ? entry.held.size === 0
                : [...entry.held].every(grant => grant.mode === 'shared');
            if (!ok) break;
            entry.queue.shift();
            this.#grant(name, entry, next);
        }
    }

    #grant(name, entry, pending) {
        const grant = { name, mode: pending.mode, tab: pending.tab, stolen: false };
        entry.held.add(grant);
        this.#state.trace?.push({ type: 'lock-acquire', name, mode: grant.mode, tab: grant.tab });
        grant.reject = pending.reject;
        Promise.resolve().then(() => pending.callback({ name, mode: pending.mode })).then(
            value => this.#release(name, entry, grant, () => pending.resolve(value)),
            error => this.#release(name, entry, grant, () => pending.reject(error))
        );
    }

    #release(name, entry, grant, settle) {
        if (!grant.stolen) {
            entry.held.delete(grant);
            this.#state.trace?.push({ type: 'lock-release', name, mode: grant.mode, tab: grant.tab });
            settle();
            this.#drain(name);
        }
        // A stolen grant's request already rejected with AbortError.
    }

    request(name, optionsOrCallback, maybeCallback) {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        const options = typeof optionsOrCallback === 'function' ? {} : (optionsOrCallback || {});
        if (typeof callback !== 'function') throw new TypeError('A lock callback is required.');
        if (typeof name !== 'string' || !name || name.startsWith('-')) {
            return Promise.reject(domError('NotSupportedError', 'Invalid lock name.'));
        }
        const mode = options.mode || 'exclusive';
        if (mode !== 'exclusive' && mode !== 'shared') throw new TypeError(`Invalid lock mode: ${mode}`);
        if (options.steal && (options.ifAvailable || mode !== 'exclusive')) {
            return Promise.reject(domError('NotSupportedError', 'steal needs an exclusive request without ifAvailable.'));
        }
        if (options.signal?.aborted) {
            return Promise.reject(options.signal.reason || domError('AbortError', 'The lock request was aborted.'));
        }
        const entry = this.#entry(name);
        return new Promise((resolve, reject) => {
            const pending = { name, mode, tab: this.#tab, callback, resolve, reject };
            if (options.steal) {
                for (const grant of [...entry.held]) {
                    grant.stolen = true;
                    entry.held.delete(grant);
                    this.#state.trace?.push({ type: 'lock-steal', name, from: grant.tab, to: this.#tab });
                    grant.reject(domError('AbortError', 'The lock was stolen.'));
                }
                this.#grant(name, entry, pending);
                return;
            }
            if (this.#grantable(entry, mode)) {
                this.#grant(name, entry, pending);
                return;
            }
            if (options.ifAvailable) {
                this.#state.trace?.push({ type: 'lock-unavailable', name, tab: this.#tab });
                Promise.resolve().then(() => callback(null)).then(resolve, reject);
                return;
            }
            entry.queue.push(pending);
            if (options.signal) {
                options.signal.addEventListener('abort', () => {
                    const index = entry.queue.indexOf(pending);
                    if (index < 0) return;
                    entry.queue.splice(index, 1);
                    reject(options.signal.reason || domError('AbortError', 'The lock request was aborted.'));
                    this.#drain(name);
                }, { once: true });
            }
        });
    }

    async query() {
        const held = [];
        const pending = [];
        for (const [name, entry] of this.#state.names) {
            for (const grant of entry.held) held.push({ name, mode: grant.mode, clientId: grant.tab });
            for (const item of entry.queue) pending.push({ name, mode: item.mode, clientId: item.tab });
        }
        return { held, pending };
    }

    /** Number of grants currently held for `name`. */
    heldCount(name) {
        return this.#state.names.get(name)?.held.size ?? 0;
    }

    /** Number of requests queued behind the holders of `name`. */
    queuedCount(name) {
        return this.#state.names.get(name)?.queue.length ?? 0;
    }
}

// ---------------------------------------------------------- BroadcastChannel

/** An in-process BroadcastChannel hub. `posted` records every message. */
export class FakeBroadcastHub {
    constructor({ trace = [] } = {}) {
        this.trace = trace;
        this.channels = new Map();
        this.posted = [];
    }

    /** A BroadcastChannel class bound to this hub (assign to globalThis.BroadcastChannel). */
    channelClass() {
        const hub = this;
        return class FakeBroadcastChannel extends Emitter {
            constructor(name) {
                super();
                this.name = String(name);
                this.closed = false;
                this.onmessage = null;
                if (!hub.channels.has(this.name)) hub.channels.set(this.name, new Set());
                hub.channels.get(this.name).add(this);
            }

            postMessage(data) {
                if (this.closed) throw domError('InvalidStateError', 'The channel is closed.');
                const message = structuredClone(data);
                hub.posted.push({ name: this.name, data: message });
                hub.trace?.push({ type: 'channel-post', name: this.name, data: structuredClone(message) });
                for (const other of [...hub.channels.get(this.name)]) {
                    if (other === this || other.closed) continue;
                    nativeSetImmediate(() => {
                        if (!other.closed) other._dispatch('message', { data: structuredClone(message) });
                    });
                }
            }

            close() {
                this.closed = true;
                hub.channels.get(this.name)?.delete(this);
            }
        };
    }

    /** Number of open channels with `name`. */
    openCount(name) {
        return this.channels.get(name)?.size ?? 0;
    }
}

// -------------------------------------------------------------- Web Storage

/**
 * A Map-backed Storage. `failReads` / `failWrites` make getItem / setItem and
 * removeItem throw (blocked site data, quota); both can be flipped at any time.
 */
export function createFakeStorage({ failReads = false, failWrites = false, initial = {} } = {}) {
    const map = new Map(Object.entries(initial));
    const storage = {
        failReads,
        failWrites,
        get length() { return map.size; },
        key(index) { return [...map.keys()][index] ?? null; },
        getItem(key) {
            if (storage.failReads) throw domError('SecurityError', 'Storage is not readable.');
            return map.has(String(key)) ? map.get(String(key)) : null;
        },
        setItem(key, value) {
            if (storage.failWrites) throw domError('QuotaExceededError', 'Storage is not writable.');
            map.set(String(key), String(value));
        },
        removeItem(key) {
            if (storage.failWrites) throw domError('SecurityError', 'Storage is not writable.');
            map.delete(String(key));
        },
        clear() {
            if (storage.failWrites) throw domError('SecurityError', 'Storage is not writable.');
            map.clear();
        },
        // test helpers
        snapshot() { return Object.fromEntries(map); },
        has(key) { return map.has(String(key)); }
    };
    return storage;
}

// -------------------------------------------------------------- environment

function setGlobal(name, value) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, name);
    const previous = globalThis[name];
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
    return () => {
        if (had) Object.defineProperty(globalThis, name, { value: previous, configurable: true, writable: true, enumerable: true });
        else delete globalThis[name];
    };
}

function setNavigatorLocks(locks) {
    if (!globalThis.navigator) {
        return setGlobal('navigator', { locks });
    }
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
    Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true, writable: true });
    return () => {
        if (descriptor) Object.defineProperty(globalThis.navigator, 'locks', descriptor);
        else delete globalThis.navigator.locks;
    };
}

/**
 * Install a fake IndexedDB as globalThis.indexedDB (and IDBKeyRange).
 * @returns {() => void} restore
 */
function installFakeIndexedDb(fake) {
    const restores = [setGlobal('indexedDB', fake), setGlobal('IDBKeyRange', FakeKeyRange)];
    return () => restores.reverse().forEach(restore => restore());
}

/**
 * Install a fake lock manager as navigator.locks; `null` makes navigator.locks
 * undefined (a browser without Web Locks).
 * @returns {() => void} restore
 */
export function installFakeLocks(locks) {
    return setNavigatorLocks(locks === null ? undefined : locks);
}

/**
 * Install a hub's BroadcastChannel as globalThis.BroadcastChannel.
 * @returns {() => void} restore
 */
export function installFakeBroadcastChannel(hub) {
    return setGlobal('BroadcastChannel', hub.channelClass());
}

/**
 * One fake origin: IndexedDB, Web Locks and BroadcastChannel sharing a single
 * ordered `trace`.
 *
 *   const env = createFakeEnvironment();
 *   const restore = env.install({ locks: true });   // locks: false = no navigator.locks
 */
export function createFakeEnvironment({ trace = [] } = {}) {
    const idb = new FakeIndexedDb({ trace });
    const locks = new FakeLockManager({ trace });
    const channels = new FakeBroadcastHub({ trace });
    return {
        idb,
        locks,
        channels,
        trace,
        install({ locks: withLocks = true, broadcast = true } = {}) {
            const restores = [installFakeIndexedDb(idb), installFakeLocks(withLocks ? locks : null)];
            if (broadcast) restores.push(installFakeBroadcastChannel(channels));
            return () => restores.reverse().forEach(restore => restore());
        }
    };
}
