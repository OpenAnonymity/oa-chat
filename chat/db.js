// IndexedDB implementation for chat history storage
function normalizeId(id) {
    return (id || '').toString().replace(/-/g, '').toUpperCase();
}

const COMPAT_RELOAD_KEY = 'oa-db-force-compat';

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

class ChatDatabase {
    constructor() {
        this.dbName = 'oa-fastchat';
        this.version = 4;
        this.db = null;
        this.compatMode = false;
        this.initInFlight = null;
        this.broadcastTimers = new Map();
    }

    async init() {
        if (this.db) return this.db;
        if (this.initInFlight) return this.initInFlight;

        this.initInFlight = new Promise((resolve, reject) => {
            let settled = false;
            let timeoutId = null;
            let upgradeStarted = false;
            const storageAvailable = canUseSessionStorage();
            const forceCompat = storageAvailable && consumeCompatFlag();

            const startTimeout = () => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
                timeoutId = setTimeout(() => {
                    if (!settled && !upgradeStarted) {
                        triggerCompatReload(new Error('Database upgrade timed out.'));
                    }
                }, 2500);
            };

            const cleanup = () => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            };

            const finalize = (db, compatMode) => {
                if (settled) return;
                settled = true;
                cleanup();
                this.db = db;
                this.compatMode = compatMode;
                this.db.onversionchange = () => {
                    this.db.close();
                    this.db = null;
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(new CustomEvent('oa-db-versionchange'));
                    }
                };
                if (compatMode && typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('oa-db-compat-mode'));
                }
                this.initInFlight = null;
                resolve(this.db);
            };

            const fail = (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                this.initInFlight = null;
                reject(error);
            };

            const triggerCompatReload = (error) => {
                if (settled) return;
                if (!storageAvailable || typeof window === 'undefined') {
                    fail(error);
                    return;
                }
                if (!setCompatFlag()) {
                    fail(error);
                    return;
                }
                settled = true;
                cleanup();
                this.initInFlight = null;
                window.location.reload();
            };

            const request = (forceCompat || !storageAvailable)
                ? indexedDB.open(this.dbName)
                : indexedDB.open(this.dbName, this.version);

            if (!forceCompat && storageAvailable) {
                startTimeout();
            }

            request.onerror = () => {
                if (!forceCompat && storageAvailable) {
                    triggerCompatReload(request.error || new Error('Database open failed.'));
                } else {
                    fail(request.error);
                }
            };
            request.onblocked = () => {
                if (!forceCompat && storageAvailable) {
                    triggerCompatReload(new Error('Database upgrade blocked by another tab.'));
                } else {
                    fail(new Error('Database open blocked by another tab.'));
                }
            };
            request.onsuccess = () => {
                finalize(request.result, forceCompat);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                upgradeStarted = true;

                let sessionsStore;
                if (!db.objectStoreNames.contains('sessions')) {
                    sessionsStore = db.createObjectStore('sessions', { keyPath: 'id' });
                    sessionsStore.createIndex('createdAt', 'createdAt', { unique: false });
                } else {
                    sessionsStore = event.target.transaction.objectStore('sessions');
                }

                if (sessionsStore && !sessionsStore.indexNames.contains('updatedAt')) {
                    sessionsStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                }
                if (sessionsStore && !sessionsStore.indexNames.contains('updatedAt_id')) {
                    sessionsStore.createIndex('updatedAt_id', ['updatedAt', 'id'], { unique: false });
                }

                // Create messages store
                if (!db.objectStoreNames.contains('messages')) {
                    const messagesStore = db.createObjectStore('messages', { keyPath: 'id' });
                    messagesStore.createIndex('sessionId', 'sessionId', { unique: false });
                    messagesStore.createIndex('timestamp', 'timestamp', { unique: false });
                }

                // Create settings store
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }

                // Create network logs store
                if (!db.objectStoreNames.contains('networkLogs')) {
                    const logsStore = db.createObjectStore('networkLogs', { keyPath: 'id' });
                    logsStore.createIndex('timestamp', 'timestamp', { unique: false });
                    logsStore.createIndex('sessionId', 'sessionId', { unique: false });
                }
            };
        });

        return this.initInFlight;
    }

    // Sessions
    async saveSession(session) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions'], 'readwrite');
            const store = transaction.objectStore('sessions');
            const request = store.put(session);

            request.onsuccess = () => {
                this.emitStorageEvent('sessions-updated', { sessionId: session.id });
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async saveSessionWithMessages(session, messages) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions', 'messages'], 'readwrite');
            const sessionsStore = transaction.objectStore('sessions');
            const messagesStore = transaction.objectStore('messages');

            transaction.oncomplete = () => {
                this.emitStorageEvent('sessions-updated', { sessionId: session.id });
                this.emitStorageEventDebounced('messages-updated', session.id, { sessionId: session.id }, 500);
                resolve();
            };
            transaction.onerror = () => reject(transaction.error);

            sessionsStore.put(session);
            (messages || []).forEach(message => {
                messagesStore.put(message);
            });
        });
    }

    async getSession(sessionId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions'], 'readonly');
            const store = transaction.objectStore('sessions');
            const request = store.get(sessionId);

            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllSessions() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions'], 'readonly');
            const store = transaction.objectStore('sessions');
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getSessionsPage(limit = 80, cursor = null) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions'], 'readonly');
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
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions'], 'readonly');
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
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions'], 'readonly');
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
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions'], 'readwrite');
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
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions'], 'readonly');
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
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions'], 'readwrite');
            const store = transaction.objectStore('sessions');
            const request = store.delete(sessionId);

            request.onsuccess = () => {
                this.emitStorageEvent('sessions-updated', { sessionId });
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async clearAllChats() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions', 'messages'], 'readwrite');
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

    // Messages
    async saveMessage(message) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['messages'], 'readwrite');
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
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['messages'], 'readonly');
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
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['messages'], 'readwrite');
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
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['messages'], 'readwrite');
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
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['settings'], 'readwrite');
            const store = transaction.objectStore('settings');
            const request = store.put({ key, value });

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async saveSettings(entries) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['settings'], 'readwrite');
            const store = transaction.objectStore('settings');

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);

            (entries || []).forEach(({ key, value }) => {
                store.put({ key, value });
            });
        });
    }

    async getSetting(key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['settings'], 'readonly');
            const store = transaction.objectStore('settings');
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result?.value);
            request.onerror = () => reject(request.error);
        });
    }

    emitStorageEvent(type, detail) {
        if (typeof window === 'undefined') return;
        const events = window.storageEvents;
        if (events && typeof events.broadcast === 'function') {
            events.broadcast(type, detail);
        }
    }

    emitStorageEventDebounced(type, key, detail, delayMs = 250) {
        if (typeof window === 'undefined') return;
        const events = window.storageEvents;
        if (events && typeof events.broadcastDebounced === 'function') {
            events.broadcastDebounced(type, key, detail, delayMs);
        } else if (events && typeof events.broadcast === 'function') {
            const debounceKey = `${type}:${key || ''}`;
            if (this.broadcastTimers.has(debounceKey)) return;
            const timer = setTimeout(() => {
                this.broadcastTimers.delete(debounceKey);
                events.broadcast(type, detail);
            }, delayMs);
            this.broadcastTimers.set(debounceKey, timer);
        }
    }

    // Network logs
    async saveNetworkLog(log) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['networkLogs'], 'readwrite');
            const store = transaction.objectStore('networkLogs');
            const request = store.put(log);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getAllNetworkLogs() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['networkLogs'], 'readonly');
            const store = transaction.objectStore('networkLogs');
            const index = store.index('timestamp');
            const request = index.openCursor(null, 'prev'); // Reverse order by timestamp
            const logs = [];

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    logs.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(logs);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    async clearOldNetworkLogs(maxLogs = 200) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['networkLogs'], 'readwrite');
            const store = transaction.objectStore('networkLogs');
            const index = store.index('timestamp');
            const request = index.openCursor(null, 'prev');
            let count = 0;

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    count++;
                    if (count > maxLogs) {
                        cursor.delete();
                    }
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    async clearAllNetworkLogs() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['networkLogs'], 'readwrite');
            const store = transaction.objectStore('networkLogs');
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}

// Export for use in app.js and preserve legacy global access.
const chatDB = new ChatDatabase();
if (typeof window !== 'undefined') {
    window.chatDB = chatDB;
}

export { chatDB };
