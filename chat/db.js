// IndexedDB implementation for chat history storage
function normalizeId(id) {
    return (id || '').toString().replace(/-/g, '').toUpperCase();
}

class ChatDatabase {
    constructor() {
        this.dbName = 'openrouter-chat';
        this.version = 3;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Database upgrade blocked by another tab.'));
            request.onsuccess = () => {
                this.db = request.result;
                this.db.onversionchange = () => {
                    this.db.close();
                    this.db = null;
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(new CustomEvent('oa-db-versionchange'));
                    }
                };
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

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
    }

    // Sessions
    async saveSession(session) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions'], 'readwrite');
            const store = transaction.objectStore('sessions');
            const request = store.put(session);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async saveSessionWithMessages(session, messages) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions', 'messages'], 'readwrite');
            const sessionsStore = transaction.objectStore('sessions');
            const messagesStore = transaction.objectStore('messages');

            transaction.oncomplete = () => resolve();
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

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async clearAllChats() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions', 'messages'], 'readwrite');
            const sessionsStore = transaction.objectStore('sessions');
            const messagesStore = transaction.objectStore('messages');

            const handleError = (event) => reject(event.target.error);

            transaction.oncomplete = () => resolve();
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

            request.onsuccess = () => resolve();
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

            request.onsuccess = () => resolve();
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

    async getSetting(key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['settings'], 'readonly');
            const store = transaction.objectStore('settings');
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result?.value);
            request.onerror = () => reject(request.error);
        });
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

// Export for use in app.js
const chatDB = new ChatDatabase();
