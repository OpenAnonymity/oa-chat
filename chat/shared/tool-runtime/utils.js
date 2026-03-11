export function generateRuntimeId(prefix = 'rt') {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return `${prefix}_${globalThis.crypto.randomUUID()}`;
    }
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export class SimpleEventEmitter {
    constructor() {
        this.listeners = new Set();
    }

    subscribe(listener) {
        if (typeof listener !== 'function') {
            return () => {};
        }

        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    emit(event) {
        this.listeners.forEach((listener) => {
            try {
                listener(event);
            } catch (error) {
                console.warn('[tool-runtime] Listener error:', error);
            }
        });
    }
}

export function shallowClone(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => shallowClone(item));
    return { ...value };
}

export function mergeCapabilities(capabilitiesList = []) {
    const merged = {
        toolNames: [],
        families: [],
        runtimeFamilies: [],
        hostIds: [],
        supportsStructuredToolCalls: false
    };

    const toolNames = new Set();
    const families = new Set();
    const runtimeFamilies = new Set();
    const hostIds = new Set();

    capabilitiesList.forEach((capabilities) => {
        if (!capabilities || typeof capabilities !== 'object') return;

        if (Array.isArray(capabilities.toolNames)) {
            capabilities.toolNames.forEach(name => toolNames.add(name));
        }
        if (Array.isArray(capabilities.families)) {
            capabilities.families.forEach(name => families.add(name));
        }
        if (Array.isArray(capabilities.runtimeFamilies)) {
            capabilities.runtimeFamilies.forEach(name => runtimeFamilies.add(name));
        }
        if (capabilities.hostId) {
            hostIds.add(capabilities.hostId);
        }
        if (capabilities.supportsStructuredToolCalls) {
            merged.supportsStructuredToolCalls = true;
        }
    });

    merged.toolNames = Array.from(toolNames);
    merged.families = Array.from(families);
    merged.runtimeFamilies = Array.from(runtimeFamilies);
    merged.hostIds = Array.from(hostIds);
    return merged;
}
