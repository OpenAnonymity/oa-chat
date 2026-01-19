class StorageEvents {
    constructor() {
        this.channel = null;
        this.handlers = new Map();
        this.debounceTimers = new Map();
        this.tabId = this.createTabId();
        this.initialized = false;
    }

    createTabId() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    init() {
        if (this.initialized || typeof window === 'undefined') {
            return;
        }

        if (typeof BroadcastChannel === 'function') {
            this.channel = new BroadcastChannel('oa-storage-events');
            this.channel.addEventListener('message', (event) => {
                this.handleMessage(event.data);
            });
        }

        this.initialized = true;
    }

    handleMessage(message) {
        if (!message || message.sender === this.tabId) {
            return;
        }

        const { type, payload } = message;
        const listeners = this.handlers.get(type);
        if (!listeners) return;

        listeners.forEach((handler) => {
            try {
                handler(payload);
            } catch (error) {
                console.warn('Storage event handler failed:', error);
            }
        });
    }

    broadcast(type, payload) {
        if (!this.channel) {
            return;
        }
        this.channel.postMessage({
            type,
            payload,
            sender: this.tabId,
            timestamp: Date.now()
        });
    }

    broadcastDebounced(type, key, payload, delayMs = 250) {
        if (!this.channel) {
            return;
        }

        const timerKey = `${type}:${key || ''}`;
        if (this.debounceTimers.has(timerKey)) {
            return;
        }

        const timer = setTimeout(() => {
            this.debounceTimers.delete(timerKey);
            this.broadcast(type, payload);
        }, delayMs);

        this.debounceTimers.set(timerKey, timer);
    }

    on(type, handler) {
        if (typeof handler !== 'function') {
            return () => {};
        }

        const listeners = this.handlers.get(type) || new Set();
        listeners.add(handler);
        this.handlers.set(type, listeners);

        return () => {
            const current = this.handlers.get(type);
            if (!current) return;
            current.delete(handler);
            if (current.size === 0) {
                this.handlers.delete(type);
            }
        };
    }
}

const storageEvents = new StorageEvents();

export default storageEvents;
