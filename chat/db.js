// IndexedDB implementation for chat history storage
import { MessageReplacement } from './services/messageReplacement.js';
import { logAccessOverwrite } from './services/inference/accessDiscardLog.js';

function normalizeId(id) {
    return (id || '').toString().replace(/-/g, '').toUpperCase();
}

const COMPAT_RELOAD_KEY = 'oa-db-force-compat';
const OPEN_TIMEOUT_MS = 2500;
const UPGRADE_TIMEOUT_MS = 12000;
const OVERALL_TIMEOUT_MS = 20000;
const REOPEN_RETRY_MS = 3000;
const INCARNATION_KEY = 'db-incarnation';

function newIncarnation() {
    try {
        if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    } catch { /* fall through */ }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function canUseSessionStorage() {
    try {
        sessionStorage.setItem('__oa_db_test__', '1');
        sessionStorage.removeItem('__oa_db_test__');
        return true;
    } catch (error) {
        return false;
    }
}

function consumeCompatFlag() {
    try {
        const value = sessionStorage.getItem(COMPAT_RELOAD_KEY) === '1';
        if (value) {
            sessionStorage.removeItem(COMPAT_RELOAD_KEY);
        }
        return value;
    } catch (error) {
        return false;
    }
}

function setCompatFlag() {
    try {
        sessionStorage.setItem(COMPAT_RELOAD_KEY, '1');
        return true;
    } catch (error) {
        return false;
    }
}

// What a person sees when a message cannot be written to this device; the
// browser's own reason stays on the error (and in the console) for debugging.
function messageSaveError(cause) {
    const error = new Error('This message could not be saved on this device. Please try again.');
    error.cause = cause || null;
    if (cause) console.error('[ChatDB] Saving the message failed:', cause);
    return error;
}

class ChatDatabase {
    constructor() {
        this.dbName = 'oa-fastchat'; // Intentional: preserve existing IndexedDB data across app rename to oa-chat
        this.version = 4;
        this.db = null;
        this.compatMode = false;
        this.connectionLost = false;
        this.reconnectFailureReported = false;
        this.closedForVersionChange = false;
        // Set when a reopen found the database had to be created again: the
        // browser removed it. Rows from before that moment are not written
        // back on their own (see refusesPreResetRow).
        this.resetAt = 0;
        this.resetRefusalReported = false;
        this.reconnectCount = 0;
        this.resetReconnectCount = 0;
        // Random per created database, stored in `settings`. A reopen that
        // finds another (or none) means the database was replaced, whichever
        // tab recreated it.
        this.incarnation = null;
        this.reopenFailure = null;
        this.initInFlight = null;
        this.broadcastTimers = new Map();
        this.messageReplacements = new Map();
        this.discardedReplacementIds = new Set();
    }

    async init() {
        // Another tab is upgrading the schema; this code must not reopen it.
        if (this.closedForVersionChange) {
            throw new Error('Chat storage updated in another tab. Reload to continue.');
        }
        // A lost connection stays referenced (so `chatDB.db` checks elsewhere
        // do not read "no database" and fall back to empty values); any init()
        // or operation reopens it.
        if (this.db && !this.connectionLost) return this.db;
        if (this.initInFlight) return this.initInFlight;
        // After a failed reopen, fail fast for a moment instead of making
        // every save (including streaming checkpoints) wait for a new open.
        if (this.connectionLost && this.reopenFailure &&
            Date.now() - this.reopenFailure.at < REOPEN_RETRY_MS) {
            throw this.reopenFailure.error;
        }

        this.initInFlight = new Promise((resolve, reject) => {
            let settled = false;
            let createdFresh = false;
            let timeoutId = null;
            let upgradeTimeoutId = null;
            let overallTimeoutId = null;
            let upgradeStarted = false;
            let fallbackStarted = false;
            let versionedFailed = null;
            let fallbackFailed = null;
            const storageAvailable = canUseSessionStorage();
            const forceCompat = storageAvailable && consumeCompatFlag();

            const startTimeout = () => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
                timeoutId = setTimeout(() => {
                    if (!settled && !upgradeStarted) {
                        triggerCompatFallback(new Error('Database open timed out.'));
                    }
                }, OPEN_TIMEOUT_MS);
            };

            const startUpgradeTimeout = () => {
                if (upgradeTimeoutId) {
                    clearTimeout(upgradeTimeoutId);
                }
                upgradeTimeoutId = setTimeout(() => {
                    if (!settled) {
                        triggerCompatFallback(new Error('Database upgrade stalled.'));
                    }
                }, UPGRADE_TIMEOUT_MS);
            };

            const startOverallTimeout = () => {
                if (overallTimeoutId) {
                    clearTimeout(overallTimeoutId);
                }
                overallTimeoutId = setTimeout(() => {
                    if (!settled) {
                        fail(new Error('Database open timed out.'));
                    }
                }, OVERALL_TIMEOUT_MS);
            };

            const cleanup = () => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
                if (upgradeTimeoutId) {
                    clearTimeout(upgradeTimeoutId);
                    upgradeTimeoutId = null;
                }
                if (overallTimeoutId) {
                    clearTimeout(overallTimeoutId);
                    overallTimeoutId = null;
                }
            };

            const finalize = (db, compatMode) => {
                if (settled) return;
                settled = true;
                cleanup();
                const resolvedCompatMode = compatMode && db.version < this.version;
                const reopened = this.connectionLost;
                const previous = this.db;
                this.db = db;
                this.compatMode = resolvedCompatMode;
                // The browser can close a connection without the page asking
                // (storage cleared or evicted, disk errors). It never says why.
                let closedDuringAdoption = false;
                db.onclose = () => {
                    closedDuringAdoption = true;
                    this.markConnectionLost(db);
                };
                db.onversionchange = () => {
                    closedDuringAdoption = true;
                    // A late event from a replaced handle must not close the
                    // current connection.
                    if (this.db !== db) return;
                    db.close();
                    this.db = null;
                    this.closedForVersionChange = true;
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(new CustomEvent('oa-db-versionchange'));
                    }
                };
                if (resolvedCompatMode && typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('oa-db-compat-mode'));
                }
                if (previous && previous !== db) {
                    try { previous.close(); } catch { /* already closed */ }
                }
                const known = this.incarnation;
                void this.adoptIncarnation(db).then(current => {
                    this.initInFlight = null;
                    // The marker read is asynchronous: this handle can close
                    // again before it finishes. Never announce a dead handle
                    // as recovered or erase the new connection-lost state.
                    if (closedDuringAdoption || this.db !== db || this.closedForVersionChange) {
                        const error = new Error(this.closedForVersionChange
                            ? 'Chat storage updated in another tab. Reload to continue.'
                            : 'Chat storage closed during recovery. Please try again.');
                        if (this.connectionLost) {
                            this.reopenFailure = { at: Date.now(), error };
                            if (!this.reconnectFailureReported) {
                                this.reconnectFailureReported = true;
                                this.dispatchWindowEvent('oa-db-reconnect-failed');
                            }
                        }
                        reject(error);
                        return;
                    }
                    // A failed marker read is "unknown", never "different".
                    if (current) this.incarnation = current;
                    if (reopened) {
                        this.connectionLost = false;
                        this.reconnectFailureReported = false;
                        this.reopenFailure = null;
                        this.reconnectCount += 1;
                        // Replaced if this open created it, or if the marker
                        // differs from the one this tab knew (another tab, or
                        // an older build that left none, recreated it first;
                        // a missing marker is replaced by a new one on read).
                        if (createdFresh || (known && current && current !== known)) {
                            this.resetReconnectCount = this.reconnectCount;
                            this.resetAt = Date.now();
                            this.resetRefusalReported = false;
                            this.dispatchWindowEvent('oa-db-reset');
                        }
                        // Synchronous, before any caller gets the connection,
                        // so account recovery starts before anything reads.
                        this.dispatchWindowEvent('oa-db-reconnected');
                    }
                    resolve(this.db);
                });
            };

            const fail = (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                this.initInFlight = null;
                if (this.connectionLost) this.reopenFailure = { at: Date.now(), error };
                if (this.connectionLost && !this.reconnectFailureReported) {
                    this.reconnectFailureReported = true;
                    this.dispatchWindowEvent('oa-db-reconnect-failed');
                }
                reject(error);
            };

            const upgradeSchema = (event) => {
                if (event.oldVersion === 0) createdFresh = true;
                const db = event.target.result;
                const transaction = event.target.transaction;

                let sessionsStore;
                if (!db.objectStoreNames.contains('sessions')) {
                    sessionsStore = db.createObjectStore('sessions', { keyPath: 'id' });
                    sessionsStore.createIndex('createdAt', 'createdAt', { unique: false });
                } else if (transaction && transaction.objectStore) {
                    sessionsStore = transaction.objectStore('sessions');
                }

                if (sessionsStore && !sessionsStore.indexNames.contains('updatedAt')) {
                    sessionsStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                }
                if (sessionsStore && !sessionsStore.indexNames.contains('updatedAt_id')) {
                    sessionsStore.createIndex('updatedAt_id', ['updatedAt', 'id'], { unique: false });
                }

                if (!db.objectStoreNames.contains('messages')) {
                    const messagesStore = db.createObjectStore('messages', { keyPath: 'id' });
                    messagesStore.createIndex('sessionId', 'sessionId', { unique: false });
                    messagesStore.createIndex('timestamp', 'timestamp', { unique: false });
                }

                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
                if (event.oldVersion === 0 && transaction?.objectStore) {
                    try {
                        transaction.objectStore('settings').put({ key: INCARNATION_KEY, value: newIncarnation() });
                    } catch { /* the marker is adopted on open instead */ }
                }

                if (!db.objectStoreNames.contains('networkLogs')) {
                    const logsStore = db.createObjectStore('networkLogs', { keyPath: 'id' });
                    logsStore.createIndex('timestamp', 'timestamp', { unique: false });
                    logsStore.createIndex('sessionId', 'sessionId', { unique: false });
                }
            };

            const maybeFinalizeOrClose = (request, compatMode) => {
                if (settled) {
                    try {
                        request.result?.close();
                    } catch (error) {
                        // Ignore cleanup errors
                    }
                    return;
                }
                finalize(request.result, compatMode);
            };

            const recordFailure = (slot, error) => {
                if (slot === 'versioned') {
                    versionedFailed = error || new Error('Database open failed.');
                } else {
                    fallbackFailed = error || new Error('Database open failed.');
                }

                if (versionedFailed && fallbackFailed) {
                    fail(versionedFailed);
                }
            };

            const triggerCompatFallback = (error) => {
                if (settled || fallbackStarted) return;
                fallbackStarted = true;
                const fallbackRequest = indexedDB.open(this.dbName);

                fallbackRequest.onerror = () => recordFailure('fallback', fallbackRequest.error || error);
                fallbackRequest.onblocked = () => recordFailure('fallback', new Error('Database open blocked by another tab.'));
                fallbackRequest.onsuccess = () => maybeFinalizeOrClose(fallbackRequest, true);
                fallbackRequest.onupgradeneeded = (event) => {
                    upgradeSchema(event);
                };
            };

            startOverallTimeout();

            if (forceCompat || !storageAvailable) {
                const request = indexedDB.open(this.dbName);
                request.onerror = () => fail(request.error);
                request.onblocked = () => fail(new Error('Database open blocked by another tab.'));
                request.onsuccess = () => finalize(request.result, forceCompat);
                request.onupgradeneeded = (event) => {
                    upgradeSchema(event);
                };
                return;
            }

            const request = indexedDB.open(this.dbName, this.version);
            startTimeout();

            request.onerror = () => {
                recordFailure('versioned', request.error || new Error('Database open failed.'));
                triggerCompatFallback(request.error);
            };
            request.onblocked = () => {
                recordFailure('versioned', new Error('Database upgrade blocked by another tab.'));
                triggerCompatFallback(new Error('Database upgrade blocked by another tab.'));
            };
            request.onsuccess = () => {
                maybeFinalizeOrClose(request, false);
            };

            request.onupgradeneeded = (event) => {
                upgradeStarted = true;
                startUpgradeTimeout();
                upgradeSchema(event);
            };
        });

        return this.initInFlight;
    }

    // Read this database's marker; a database made before markers existed
    // gets one (only if still absent, so concurrent tabs agree on it).
    // Never fails the open: without a marker a later reopen counts as a reset.
    adoptIncarnation(db) {
        return new Promise(resolve => {
            let value = null;
            try {
                const transaction = db.transaction(['settings'], 'readwrite');
                const store = transaction.objectStore('settings');
                const request = store.get(INCARNATION_KEY);
                request.onsuccess = () => {
                    value = request.result?.value || null;
                    if (!value) {
                        value = newIncarnation();
                        store.put({ key: INCARNATION_KEY, value });
                    }
                };
                transaction.oncomplete = () => resolve(value);
                transaction.onerror = () => resolve(null);
                transaction.onabort = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }

    // An unexpected close leaves no usable connection. The next operation
    // (or any init() call) reopens the database instead of failing until a
    // reload. Reopening says nothing about what the database still holds;
    // nothing here rewrites what other code had loaded.
    markConnectionLost(db) {
        if (!db || this.db !== db || this.connectionLost) return;
        this.connectionLost = true;
        this.dispatchWindowEvent('oa-db-connection-lost');
    }

    async connection() {
        if (this.db && !this.connectionLost) return this.db;
        return this.init();
    }

    // A connection the browser is closing throws InvalidStateError before its
    // close event arrives. That request never ran; the following one reopens.
    openTransaction(storeNames, mode) {
        const db = this.db;
        if (!db || this.connectionLost) throw new Error('Chat storage is reconnecting. Please try again.');
        try {
            return db.transaction(storeNames, mode);
        } catch (error) {
            if (error?.name === 'InvalidStateError') this.markConnectionLost(db);
            throw error;
        }
    }

    // After the browser recreated the database, a session row from before
    // that moment is written only by an explicit restore (import), never by
    // background saves of what this tab still shows. New chats save normally.
    refusesPreResetRow(session, existing, options = {}) {
        return Boolean(this.resetAt && !options.allowRecreate && !existing &&
            !(Number(session?.createdAt) >= this.resetAt));
    }

    // The reset checks' own read (not getSession, which callers may wrap).
    readSessionRow(sessionId) {
        return new Promise((resolve, reject) => {
            const request = this.openTransaction(['sessions'], 'readonly').objectStore('sessions').get(sessionId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    resetWriteRefused() {
        const error = new Error('This chat is no longer saved on this device. Copy anything you need from this tab before reloading it.');
        error.code = 'CHAT_STORAGE_RESET';
        if (!this.resetRefusalReported) {
            this.resetRefusalReported = true;
            this.dispatchWindowEvent('oa-db-reset-write-refused');
        }
        return error;
    }

    dispatchWindowEvent(type) {
        if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
        try {
            window.dispatchEvent(new CustomEvent(type));
        } catch { /* no listeners possible */ }
    }

    // Sessions
    // A save without a key that lands on a stored, unexpired key is how a key
    // vanishes with no discard (a stale copy from another tab). The read runs
    // inside the same transaction, only when the incoming copy has no key, and
    // never changes what is written; it only leaves an access-overwrite event.
    putSessionNotingOverwrite(store, session) {
        if (session?.apiKey || typeof store.get !== 'function') {
            store.put(session);
            return;
        }
        const incoming = { id: session.id, apiKey: session.apiKey };
        const request = store.get(session.id);
        request.onsuccess = () => {
            try { logAccessOverwrite(request.result, incoming); } catch { /* diagnostics only */ }
        };
        // IDB processes these requests in order, but clones put's argument now.
        // Waiting for the read would let later caller mutations change this save.
        store.put(session);
    }

    async saveSession(session, options = {}) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions'], 'readwrite');
            const store = transaction.objectStore('sessions');
            let refused = false;
            // A successful put can still be rolled back by an aborted
            // transaction (including a reload). Access callers must not
            // advance to inference until the credential record is committed.
            transaction.oncomplete = () => {
                if (refused) { reject(this.resetWriteRefused()); return; }
                this.emitStorageEvent('sessions-updated', { sessionId: session.id });
                resolve();
            };
            transaction.onerror = () => reject(transaction.error || new Error('The chat session could not be saved.'));
            transaction.onabort = () => reject(transaction.error || new Error('The chat session was not committed.'));
            if (!this.resetAt || options.allowRecreate) {
                this.putSessionNotingOverwrite(store, session);
                return;
            }
            const existing = store.get(session.id);
            existing.onsuccess = () => {
                if (this.refusesPreResetRow(session, existing.result, options)) { refused = true; return; }
                this.putSessionNotingOverwrite(store, session);
            };
        });
    }

    // Mutate only an existing row, atomically with the read. Background results
    // must not recreate deleted chats or overwrite unrelated session edits.
    async updateExistingSession(sessionId, update) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions'], 'readwrite');
            const store = transaction.objectStore('sessions');
            let changed = false;
            transaction.oncomplete = () => {
                if (changed) this.emitStorageEvent('sessions-updated', { sessionId });
                resolve(changed);
            };
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('Session update aborted'));
            const request = store.get(sessionId);
            request.onsuccess = () => {
                if (!request.result) return;
                try {
                    changed = update(request.result) === true;
                    if (changed) store.put(request.result);
                } catch (error) {
                    transaction.abort();
                    reject(error);
                }
            };
        });
    }

    async saveSessionWithMessages(session, messages, options = {}) {
        if (this.messageReplacements.has(session.id)) {
            await this.saveSession(session, options);
            for (const message of messages || []) await this.saveMessage(message);
            return;
        }
        if (this.connectionLost || !this.db) await this.connection();
        if (this.resetAt && !options.allowRecreate) {
            // Rare path (only after the browser recreated the database):
            // check the parent row first, then write both together.
            const existing = await this.readSessionRow(session.id);
            if (this.refusesPreResetRow(session, existing, options)) throw this.resetWriteRefused();
            if (this.connectionLost || !this.db) await this.connection();
        }
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions', 'messages'], 'readwrite');
            const sessionsStore = transaction.objectStore('sessions');
            const messagesStore = transaction.objectStore('messages');

            transaction.oncomplete = () => {
                this.emitStorageEvent('sessions-updated', { sessionId: session.id });
                this.emitStorageEventDebounced('messages-updated', session.id, { sessionId: session.id }, 500);
                resolve();
            };
            // A failed put reaches the transaction before the transaction has
            // an error of its own, so read the request's: rejecting with null
            // showed only a generic "Could not send the message".
            transaction.onerror = event => reject(messageSaveError(event?.target?.error || transaction.error));

            this.putSessionNotingOverwrite(sessionsStore, session);
            (messages || []).forEach(message => {
                messagesStore.put(message);
            });
            transaction.onabort = () => reject(messageSaveError(transaction.error));
        });
    }

    async updateSessionSearchIndex(sessionId, fields) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions'], 'readwrite');
            const store = transaction.objectStore('sessions');
            const request = store.get(sessionId);

            request.onsuccess = () => {
                const session = request.result;
                if (!session) {
                    resolve(null);
                    return;
                }

                const updatedSession = {
                    ...session,
                    ...fields
                };
                const putRequest = store.put(updatedSession);
                putRequest.onsuccess = () => resolve(updatedSession);
                putRequest.onerror = () => reject(putRequest.error);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getSession(sessionId) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions'], 'readonly');
            const store = transaction.objectStore('sessions');
            const request = store.get(sessionId);

            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllSessions() {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions'], 'readonly');
            const store = transaction.objectStore('sessions');
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getSessionsPage(limit = 80, cursor = null) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions'], 'readonly');
            const store = transaction.objectStore('sessions');
            let source;
            try {
                source = store.index('updatedAt_id');
            } catch (error) {
                source = store;
            }

            let range = null;
            if (cursor && cursor.updatedAt !== undefined && cursor.updatedAt !== null && cursor.id) {
                range = IDBKeyRange.upperBound([cursor.updatedAt, cursor.id], true);
            }

            const request = source.openCursor(range, 'prev');
            const sessions = [];
            let lastKey = null;

            request.onsuccess = (event) => {
                const cursorResult = event.target.result;
                if (!cursorResult) {
                    resolve({ sessions, nextCursor: null });
                    return;
                }

                sessions.push(cursorResult.value);
                lastKey = cursorResult.key;
                if (sessions.length >= limit) {
                    resolve({
                        sessions,
                        nextCursor: lastKey && Array.isArray(lastKey)
                            ? { updatedAt: lastKey[0], id: lastKey[1] }
                            : null
                    });
                    return;
                }

                cursorResult.continue();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async searchSessions(matchFn, limit = 200) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions'], 'readonly');
            const store = transaction.objectStore('sessions');
            const request = store.openCursor();
            const matches = [];
            let done = false;

            request.onsuccess = (event) => {
                if (done) return;
                const cursor = event.target.result;
                if (!cursor) {
                    done = true;
                    resolve(matches);
                    return;
                }
                const session = cursor.value;
                if (matchFn(session)) {
                    matches.push(session);
                    if (matches.length >= limit) {
                        done = true;
                        resolve(matches);
                        return;
                    }
                }
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async findSessionByShareId(shareId) {
        const normalized = normalizeId(shareId);
        return this.findSession(session =>
            session.shareInfo?.shareId && normalizeId(session.shareInfo.shareId) === normalized
        );
    }

    async findSessionByImportedFrom(importedFrom) {
        const normalized = normalizeId(importedFrom);
        return this.findSession(session =>
            session.importedFrom && normalizeId(session.importedFrom) === normalized
        );
    }

    async findSessionByForkedFrom(forkedFrom) {
        const normalized = normalizeId(forkedFrom);
        return this.findSession(session =>
            session.forkedFrom && normalizeId(session.forkedFrom) === normalized
        );
    }

    async findSession(matchFn) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions'], 'readonly');
            const store = transaction.objectStore('sessions');
            const request = store.openCursor();

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) {
                    resolve(null);
                    return;
                }
                if (matchFn(cursor.value)) {
                    resolve(cursor.value);
                    return;
                }
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async backfillMissingUpdatedAt() {
        // A session without updatedAt is absent from the updatedAt index, so
        // two counts say whether anything needs the walk. The walk itself is
        // one readwrite transaction over every session record; it used to run
        // on every page load, and a send issued while it ran queued behind it
        // (the user message is written to the same store).
        if (this.connectionLost || !this.db) await this.connection();
        const needsWalk = await new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions'], 'readonly');
            const store = transaction.objectStore('sessions');
            let total = null;
            let indexed = null;
            const settle = () => { if (total !== null && indexed !== null) resolve(total !== indexed); };
            const all = store.count();
            all.onsuccess = () => { total = all.result; settle(); };
            all.onerror = () => reject(all.error);
            let index;
            try { index = store.index('updatedAt'); } catch { resolve(true); return; }
            const withUpdatedAt = index.count();
            withUpdatedAt.onsuccess = () => { indexed = withUpdatedAt.result; settle(); };
            withUpdatedAt.onerror = () => reject(withUpdatedAt.error);
        });
        if (!needsWalk) return;
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions'], 'readwrite');
            const store = transaction.objectStore('sessions');
            const request = store.openCursor();

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                const session = cursor.value;
                if (!session.updatedAt && session.createdAt) {
                    session.updatedAt = session.createdAt;
                    cursor.update(session);
                }
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async collectImportedSessionKeys(source) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions'], 'readonly');
            const store = transaction.objectStore('sessions');
            const request = store.openCursor();
            const keys = new Set();

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) {
                    resolve(keys);
                    return;
                }
                const session = cursor.value;
                if (session.importedSource === source && session.importedExternalId) {
                    keys.add(`${source}:${session.importedExternalId}`);
                }
                if (session.importedFrom && session.importedFrom.startsWith(`${source}:`)) {
                    keys.add(session.importedFrom);
                }
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteSession(sessionId) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions'], 'readwrite');
            const store = transaction.objectStore('sessions');
            const request = store.delete(sessionId);

            request.onsuccess = () => {
                this.emitStorageEvent('sessions-updated', { sessionId });
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteSessionWithMessages(sessionId) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions', 'messages'], 'readwrite');
            transaction.oncomplete = () => {
                this.emitStorageEvent('sessions-updated', { sessionId });
                this.emitStorageEventDebounced('messages-updated', sessionId, { sessionId }, 500);
                resolve();
            };
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('Chat deletion was not committed.'));
            transaction.objectStore('sessions').delete(sessionId);
            const cursor = transaction.objectStore('messages').index('sessionId').openCursor(IDBKeyRange.only(sessionId));
            cursor.onsuccess = () => {
                const entry = cursor.result;
                if (entry) { entry.delete(); entry.continue(); }
            };
        });
    }

    async clearAllChats() {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['sessions', 'messages'], 'readwrite');
            const sessionsStore = transaction.objectStore('sessions');
            const messagesStore = transaction.objectStore('messages');

            const handleError = (event) => reject(event.target.error);

            transaction.oncomplete = () => {
                this.emitStorageEvent('sessions-cleared', {});
                resolve();
            };
            transaction.onerror = handleError;

            const sessionClearRequest = sessionsStore.clear();
            const messageClearRequest = messagesStore.clear();

            sessionClearRequest.onerror = handleError;
            messageClearRequest.onerror = handleError;
        });
    }

    // A regeneration drafts messages in memory. The previous transcript stays on
    // disk until the completed replacement commits in one IndexedDB transaction.
    async beginMessageReplacement(sessionId, messageId) {
        if (this.messageReplacements.has(sessionId)) throw new Error('A replacement is already running.');
        const baseline = await this.getSessionMessages(sessionId);
        const draft = new MessageReplacement(sessionId, messageId, baseline);
        this.messageReplacements.set(sessionId, draft);
        return draft;
    }

    async finishMessageReplacement(draft, { commit = false, notice = null } = {}) {
        if (this.messageReplacements.get(draft.sessionId) !== draft) return;
        let committed = false;
        try {
            if (this.connectionLost || !this.db) await this.connection();
            await new Promise((resolve, reject) => {
                const tx = this.openTransaction(['sessions', 'messages'], 'readwrite');
                const store = tx.objectStore('messages');
                let failure = null;
                tx.oncomplete = () => { committed = commit; resolve(); };
                tx.onabort = () => reject(failure || tx.error || new Error('The replacement could not be saved.'));
                tx.onerror = () => reject(tx.error);
                const session = tx.objectStore('sessions').get(draft.sessionId);
                session.onsuccess = () => {
                    if (!session.result) { if (commit) { failure = new Error('The chat was removed.'); tx.abort(); } return; }
                    const read = store.index('sessionId').getAll(draft.sessionId);
                    read.onsuccess = () => {
                        const current = (read.result || []).sort((a, b) => a.timestamp - b.timestamp);
                        // Do not overwrite another tab's edits or resurrect deleted messages.
                        if (!draft.matches(current)) {
                            if (commit) { failure = new Error('The chat changed during regeneration. The saved conversation was kept.'); tx.abort(); }
                            return;
                        }
                        if (commit) {
                            for (const message of current) store.delete(message.id);
                            for (const message of draft.messages()) store.put(message);
                        } else if (notice) {
                            const original = current.find(message => message.id === draft.messageId);
                            if (original) store.put({ ...original, regenerationNotice: notice });
                        }
                    };
                };
            });
        } finally {
            // Late citation enrichment must not re-create a discarded draft.
            if (!commit || committed) {
                const keptIds = new Set(committed ? draft.messages().map(message => message.id) : draft.originalIds);
                for (const id of [...draft.originalIds, ...draft.createdIds]) {
                    if (!keptIds.has(id)) this.discardedReplacementIds.add(id);
                }
                this.messageReplacements.delete(draft.sessionId);
                this.emitStorageEvent('messages-updated', { sessionId: draft.sessionId });
            }
        }
    }

    // Messages
    async saveMessage(message) {
        if (this.discardedReplacementIds.has(message.id)) return;
        let draft = this.messageReplacements.get(message.sessionId);
        if (draft) { draft.save(message); return; }
        if (this.connectionLost || !this.db) await this.connection();
        // A replacement can begin while a reopen was pending.
        if (this.discardedReplacementIds.has(message.id)) return;
        draft = this.messageReplacements.get(message.sessionId);
        if (draft) { draft.save(message); return; }
        if (this.resetAt) {
            // Only after the browser recreated the database: a message whose
            // chat row is gone would be an orphan nobody can open.
            const parent = await this.readSessionRow(message.sessionId);
            if (!parent) throw this.resetWriteRefused();
            if (this.connectionLost || !this.db) await this.connection();
        }
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['messages'], 'readwrite');
            const store = transaction.objectStore('messages');
            const request = store.put(message);

            request.onsuccess = () => {
                this.emitStorageEventDebounced('messages-updated', message.sessionId, { sessionId: message.sessionId }, 500);
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getSessionMessages(sessionId) {
        let draft = this.messageReplacements.get(sessionId);
        if (draft) return draft.messages();
        if (this.connectionLost || !this.db) await this.connection();
        draft = this.messageReplacements.get(sessionId);
        if (draft) return draft.messages();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['messages'], 'readonly');
            const store = transaction.objectStore('messages');
            const index = store.index('sessionId');
            const request = index.getAll(sessionId);

            request.onsuccess = () => {
                const messages = request.result || [];
                // Ensure messages are sorted by timestamp
                messages.sort((a, b) => a.timestamp - b.timestamp);
                resolve(messages);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteSessionMessages(sessionId) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['messages'], 'readwrite');
            const store = transaction.objectStore('messages');
            const index = store.index('sessionId');
            const request = index.openCursor(IDBKeyRange.only(sessionId));

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    this.emitStorageEvent('messages-updated', { sessionId });
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteMessage(messageId) {
        const inDraft = () => {
            for (const draft of this.messageReplacements.values()) {
                if (draft.has(messageId)) { draft.delete(messageId); return true; }
            }
            return false;
        };
        if (inDraft()) return;
        if (this.connectionLost || !this.db) await this.connection();
        if (inDraft()) return;
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['messages'], 'readwrite');
            const store = transaction.objectStore('messages');
            const request = store.delete(messageId);

            request.onsuccess = () => {
                this.emitStorageEvent('messages-updated', { messageId });
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    // Settings
    async saveSetting(key, value) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['settings'], 'readwrite');
            const store = transaction.objectStore('settings');
            const request = store.put({ key, value });

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async saveSettings(entries) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['settings'], 'readwrite');
            const store = transaction.objectStore('settings');

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);

            (entries || []).forEach(({ key, value }) => {
                store.put({ key, value });
            });
        });
    }

    /**
     * Atomically apply settings puts and deletes in one IndexedDB transaction.
     * This is used for account-scope transitions where a partial commit could
     * otherwise associate one account's live data with another account marker.
     */
    async updateSettings(entries = [], deleteKeys = []) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['settings'], 'readwrite');
            const store = transaction.objectStore('settings');

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(
                transaction.error || new Error('Settings transaction aborted')
            );

            entries.forEach(({ key, value }) => {
                store.put({ key, value });
            });
            deleteKeys.forEach(key => {
                store.delete(key);
            });
        });
    }

    /** Compare ownership markers and delete atomically, including against older tabs
     * that do not participate in our Web Lock. Resolves only on commit. */
    async deleteSettingsIfUnchanged(expected, deleteKeys) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const tx = this.openTransaction(['settings'], 'readwrite');
            const store = tx.objectStore('settings');
            let matches = true;
            let remaining = expected.length;
            tx.oncomplete = () => resolve(matches);
            tx.onerror = tx.onabort = () => reject(tx.error || new Error('Account cleanup transaction failed'));
            if (!remaining) { matches = false; return; }
            for (const { key, value } of expected) {
                const request = store.get(key);
                request.onsuccess = () => {
                    try {
                        if (JSON.stringify(request.result?.value ?? null) !== JSON.stringify(value ?? null)) matches = false;
                    } catch { matches = false; tx.abort(); return; }
                    if (--remaining === 0 && matches) for (const key of deleteKeys) store.delete(key);
                };
            }
        });
    }

    async getSetting(key) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['settings'], 'readonly');
            const store = transaction.objectStore('settings');
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result?.value);
            request.onerror = () => reject(request.error);
        });
    }

    // Read related account markers together. Separate getSetting transactions
    // can observe opposite sides of a cross-tab account transition.
    async getSettingsSnapshot(keys) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['settings'], 'readonly');
            const store = transaction.objectStore('settings');
            const values = Object.create(null);
            transaction.oncomplete = () => resolve(values);
            transaction.onerror = () => reject(transaction.error || new Error('Settings snapshot failed'));
            transaction.onabort = () => reject(transaction.error || new Error('Settings snapshot aborted'));
            for (const key of keys) {
                const request = store.get(key);
                request.onsuccess = () => { values[key] = request.result?.value; };
            }
        });
    }

    // Compare JSON-compatible settings and write in the same transaction so a
    // display-only update cannot replace another tab's newer deposit amount.
    // A missing record and a cleared (null) setting both mean no current value.
    async compareAndSetSetting(key, expected, value) {
        const expectedJson = JSON.stringify(expected ?? null);
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['settings'], 'readwrite');
            const store = transaction.objectStore('settings');
            let matched = false;
            transaction.oncomplete = () => resolve(matched);
            transaction.onerror = () => reject(transaction.error || new Error('Settings transaction failed'));
            transaction.onabort = () => reject(transaction.error || new Error('Settings transaction aborted'));
            const request = store.get(key);
            request.onsuccess = () => {
                try {
                    if (JSON.stringify(request.result?.value ?? null) !== expectedJson) return;
                    store.put({ key, value });
                    matched = true;
                } catch (error) {
                    transaction.abort();
                    reject(error);
                }
            };
        });
    }

    async deleteSetting(key) {
        if (this.connectionLost || !this.db) await this.connection();
        return new Promise((resolve, reject) => {
            const transaction = this.openTransaction(['settings'], 'readwrite');
            const store = transaction.objectStore('settings');
            const request = store.delete(key);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    emitStorageEvent(type, detail) {
        if (typeof window === 'undefined') return;
        const events = window.storageEvents;
        if (events && typeof events.broadcast === 'function') {
            // The write has already committed. A closed/unavailable cross-tab
            // channel must not strand its promise (and leave Send spinning).
            try { events.broadcast(type, detail); }
            catch { console.warn('[ChatDB] Cross-tab notification unavailable.'); }
        }
    }

    emitStorageEventDebounced(type, key, detail, delayMs = 250) {
        if (typeof window === 'undefined') return;
        const events = window.storageEvents;
        if (events && typeof events.broadcastDebounced === 'function') {
            try { events.broadcastDebounced(type, key, detail, delayMs); }
            catch { console.warn('[ChatDB] Cross-tab notification unavailable.'); }
        } else if (events && typeof events.broadcast === 'function') {
            const debounceKey = `${type}:${key || ''}`;
            if (this.broadcastTimers.has(debounceKey)) return;
            const timer = setTimeout(() => {
                this.broadcastTimers.delete(debounceKey);
                this.emitStorageEvent(type, detail);
            }, delayMs);
            this.broadcastTimers.set(debounceKey, timer);
        }
    }

}

// Export for use in app.js and preserve legacy global access.
const chatDB = new ChatDatabase();
if (typeof window !== 'undefined') {
    window.chatDB = chatDB;
}

export { chatDB };
