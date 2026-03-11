import { SimpleEventEmitter, mergeCapabilities } from './utils.js';

export class CompositeToolHost {
    constructor(hosts = []) {
        this.hosts = (hosts || []).filter(Boolean);
        this.emitter = new SimpleEventEmitter();
        this.toolHostCache = new Map();
        this.hostUnsubscribers = this.hosts.map((host) => {
            if (!host || typeof host.subscribe !== 'function') return () => {};
            return host.subscribe((event) => {
                this.emitter.emit(event);
            });
        });
    }

    async getCapabilities() {
        const capabilitiesList = await Promise.all(this.hosts.map(async (host) => {
            if (!host || typeof host.getCapabilities !== 'function') return null;
            try {
                return await host.getCapabilities();
            } catch (error) {
                console.warn('[tool-runtime] Host capability lookup failed:', error);
                return null;
            }
        }));
        return mergeCapabilities(capabilitiesList.filter(Boolean));
    }

    async listTools() {
        this.toolHostCache.clear();
        const seen = new Set();
        const tools = [];

        for (const host of this.hosts) {
            if (!host || typeof host.listTools !== 'function') continue;
            let hostTools = [];
            try {
                hostTools = await host.listTools();
            } catch (error) {
                console.warn('[tool-runtime] Host tool listing failed:', error);
                hostTools = [];
            }

            (hostTools || []).forEach((tool) => {
                if (!tool?.name || seen.has(tool.name)) return;
                seen.add(tool.name);
                this.toolHostCache.set(tool.name, host);
                tools.push(tool);
            });
        }

        return tools;
    }

    async runTool(call) {
        if (!call?.toolName) {
            throw new Error('Tool call is missing a toolName.');
        }

        if (!this.toolHostCache.has(call.toolName)) {
            await this.listTools();
        }

        const host = this.toolHostCache.get(call.toolName);
        if (!host || typeof host.runTool !== 'function') {
            throw new Error(`No host is available for tool: ${call.toolName}`);
        }

        return host.runTool(call);
    }

    async cancelRun(runId) {
        const results = await Promise.allSettled(this.hosts.map(async (host) => {
            if (!host || typeof host.cancelRun !== 'function') return false;
            return host.cancelRun(runId);
        }));

        const succeeded = results.some(result => result.status === 'fulfilled' && result.value);
        return succeeded;
    }

    subscribe(listener) {
        return this.emitter.subscribe(listener);
    }

    dispose() {
        this.hostUnsubscribers.forEach(unsubscribe => unsubscribe());
        this.hostUnsubscribers = [];
        this.toolHostCache.clear();
    }
}
