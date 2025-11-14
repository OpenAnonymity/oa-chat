// IndexedDB implementation for chat history storage
class ChatDatabase {
    constructor() {
        this.dbName = 'openrouter-chat';
        this.version = 2;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create sessions store
                if (!db.objectStoreNames.contains('sessions')) {
                    const sessionsStore = db.createObjectStore('sessions', { keyPath: 'id' });
                    sessionsStore.createIndex('createdAt', 'createdAt', { unique: false });
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

    async getAllSessions() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sessions'], 'readonly');
            const store = transaction.objectStore('sessions');
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
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

            request.onsuccess = () => resolve(request.result);
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

