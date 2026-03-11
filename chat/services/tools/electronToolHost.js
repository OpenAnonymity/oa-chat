export default class ElectronToolHost {
    constructor() {
        this.api = typeof window !== 'undefined' ? window.electronAPI?.tools : null;
        this.listenerCleanup = null;
    }

    isAvailable() {
        return !!(this.api &&
            typeof this.api.listTools === 'function' &&
            typeof this.api.runTool === 'function');
    }

    async getCapabilities() {
        if (!this.isAvailable()) {
            return {
                hostId: 'electron',
                toolNames: [],
                families: [],
                runtimeFamilies: [],
                supportsStructuredToolCalls: false
            };
        }

        const capabilities = typeof this.api.getCapabilities === 'function'
            ? await this.api.getCapabilities()
            : {};

        return {
            hostId: 'electron',
            toolNames: Array.isArray(capabilities.toolNames) ? capabilities.toolNames : [],
            families: Array.isArray(capabilities.families) ? capabilities.families : [],
            runtimeFamilies: Array.isArray(capabilities.runtimeFamilies) ? capabilities.runtimeFamilies : [],
            supportsStructuredToolCalls: Boolean(capabilities.supportsStructuredToolCalls)
        };
    }

    async listTools() {
        if (!this.isAvailable()) return [];
        const tools = await this.api.listTools();
        return Array.isArray(tools) ? tools : [];
    }

    async runTool(call) {
        if (!this.isAvailable()) {
            throw new Error('Electron tool host is unavailable.');
        }
        return this.api.runTool(call);
    }

    async cancelRun(runId) {
        if (!this.isAvailable() || typeof this.api.cancelRun !== 'function') {
            return false;
        }
        return this.api.cancelRun(runId);
    }

    subscribe(listener) {
        if (!this.isAvailable() || typeof listener !== 'function') {
            return () => {};
        }

        if (typeof this.api.subscribe === 'function') {
            return this.api.subscribe(listener);
        }

        if (typeof this.api.onEvent === 'function') {
            const unsubscribe = this.api.onEvent(listener);
            return typeof unsubscribe === 'function' ? unsubscribe : () => {};
        }

        return () => {};
    }
}
