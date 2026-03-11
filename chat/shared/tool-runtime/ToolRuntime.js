import { generateRuntimeId, shallowClone, SimpleEventEmitter } from './utils.js';

function normalizeArtifactKind(mimeType = '', suggestedKind = '') {
    if (suggestedKind) return suggestedKind;
    if (mimeType === 'text/html') return 'html';
    if (mimeType === 'image/svg+xml') return 'svg';
    if (mimeType === 'application/json') return 'json';
    if (mimeType.startsWith('text/')) return 'text';
    return 'file';
}

export class ToolRuntime {
    constructor({ host, runStore, artifactStore, approvalResolver = null } = {}) {
        if (!host) {
            throw new Error('ToolRuntime requires a host.');
        }
        if (!runStore || !artifactStore) {
            throw new Error('ToolRuntime requires runStore and artifactStore adapters.');
        }

        this.host = host;
        this.runStore = runStore;
        this.artifactStore = artifactStore;
        this.approvalResolver = approvalResolver;
        this.emitter = new SimpleEventEmitter();
        this.cachedTools = null;
        this.unsubscribeHost = typeof host.subscribe === 'function'
            ? host.subscribe((event) => this.handleHostEvent(event))
            : () => {};
    }

    async getCapabilities() {
        if (!this.host || typeof this.host.getCapabilities !== 'function') {
            return {
                toolNames: [],
                families: [],
                runtimeFamilies: [],
                hostIds: []
            };
        }
        return this.host.getCapabilities();
    }

    async listTools({ force = false } = {}) {
        if (!force && Array.isArray(this.cachedTools)) {
            return this.cachedTools.map(tool => shallowClone(tool));
        }

        const tools = this.host && typeof this.host.listTools === 'function'
            ? await this.host.listTools()
            : [];
        this.cachedTools = (tools || []).map(tool => shallowClone(tool));
        return this.cachedTools.map(tool => shallowClone(tool));
    }

    async getTool(toolName) {
        const tools = await this.listTools();
        return tools.find(tool => tool.name === toolName) || null;
    }

    subscribe(listener) {
        return this.emitter.subscribe(listener);
    }

    async startManualToolRun({
        sessionId,
        messageId,
        toolName,
        input,
        metadata = {},
        context = {}
    }) {
        const tool = await this.getTool(toolName);
        if (!tool) {
            throw new Error(`Unsupported tool: ${toolName}`);
        }

        const now = Date.now();
        const run = {
            id: generateRuntimeId('run'),
            callId: generateRuntimeId('call'),
            sessionId,
            messageId,
            toolName,
            toolTitle: tool.title || toolName,
            toolFamily: tool.family || 'generic',
            status: 'requested',
            approvalState: 'approved',
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            completedAt: null,
            failedAt: null,
            errorMessage: null,
            stdout: '',
            stderr: '',
            artifactIds: [],
            input: shallowClone(input),
            metadata: {
                ...metadata,
                manual: true
            },
            context: shallowClone(context)
        };

        await this.runStore.saveRun(run);
        this.emit({ type: 'tool.call.requested', run: shallowClone(run), tool: shallowClone(tool) });
        this.emit({ type: 'tool.call.approved', run: shallowClone(run), tool: shallowClone(tool) });

        const done = this.executeRun(run, tool);
        return { run: shallowClone(run), done };
    }

    async executeToolCall(toolCall, { approvalResolver = this.approvalResolver } = {}) {
        const tool = await this.getTool(toolCall?.toolName);
        if (!tool) {
            throw new Error(`Unsupported tool: ${toolCall?.toolName || 'unknown'}`);
        }

        const now = Date.now();
        const run = {
            id: generateRuntimeId('run'),
            callId: toolCall.id || generateRuntimeId('call'),
            sessionId: toolCall.sessionId || null,
            messageId: toolCall.messageId || null,
            toolName: tool.name,
            toolTitle: tool.title || tool.name,
            toolFamily: tool.family || 'generic',
            status: 'requested',
            approvalState: 'pending',
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            completedAt: null,
            failedAt: null,
            errorMessage: null,
            stdout: '',
            stderr: '',
            artifactIds: [],
            input: shallowClone(toolCall.input),
            metadata: shallowClone(toolCall.metadata || {}),
            context: shallowClone(toolCall.context || {})
        };

        await this.runStore.saveRun(run);
        this.emit({ type: 'tool.call.requested', run: shallowClone(run), tool: shallowClone(tool) });

        const approvalPolicy = tool.approvalPolicy || 'always';
        let approved = approvalPolicy === 'never';
        if (!approved && typeof approvalResolver === 'function') {
            approved = await approvalResolver({ run: shallowClone(run), tool: shallowClone(tool) });
        }

        if (!approved) {
            run.status = 'cancelled';
            run.approvalState = 'denied';
            run.updatedAt = Date.now();
            run.completedAt = run.updatedAt;
            await this.runStore.saveRun(run);
            this.emit({ type: 'tool.run.failed', run: shallowClone(run), tool: shallowClone(tool) });
            return { run: shallowClone(run), artifacts: [] };
        }

        run.approvalState = 'approved';
        await this.runStore.saveRun(run);
        this.emit({ type: 'tool.call.approved', run: shallowClone(run), tool: shallowClone(tool) });
        return this.executeRun(run, tool);
    }

    async executeRun(run, tool) {
        run.status = 'running';
        run.startedAt = Date.now();
        run.updatedAt = run.startedAt;
        await this.runStore.saveRun(run);
        this.emit({ type: 'tool.run.started', run: shallowClone(run), tool: shallowClone(tool) });

        try {
            const result = await this.host.runTool({
                id: run.callId,
                runId: run.id,
                sessionId: run.sessionId,
                messageId: run.messageId,
                toolName: run.toolName,
                input: shallowClone(run.input),
                metadata: shallowClone(run.metadata),
                context: shallowClone(run.context)
            });

            const artifacts = [];
            for (const rawArtifact of (result?.artifacts || [])) {
                const artifact = {
                    id: rawArtifact.id || generateRuntimeId('artifact'),
                    sessionId: run.sessionId,
                    messageId: run.messageId,
                    runId: run.id,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    name: rawArtifact.name || 'artifact',
                    mimeType: rawArtifact.mimeType || 'application/octet-stream',
                    kind: normalizeArtifactKind(rawArtifact.mimeType, rawArtifact.kind),
                    content: rawArtifact.content ?? '',
                    encoding: rawArtifact.encoding || 'utf8',
                    byteSize: rawArtifact.byteSize || String(rawArtifact.content ?? '').length,
                    download: rawArtifact.download !== false,
                    metadata: shallowClone(rawArtifact.metadata || {})
                };
                await this.artifactStore.saveArtifact(artifact);
                artifacts.push(artifact);
                this.emit({ type: 'artifact.created', run: shallowClone(run), artifact: shallowClone(artifact) });
            }

            run.status = result?.status === 'cancelled' ? 'cancelled' : 'completed';
            run.updatedAt = Date.now();
            run.completedAt = run.updatedAt;
            run.stdout = typeof result?.stdout === 'string' ? result.stdout : run.stdout;
            run.stderr = typeof result?.stderr === 'string' ? result.stderr : run.stderr;
            run.errorMessage = result?.error?.message || null;
            run.artifactIds = artifacts.map(artifact => artifact.id);
            run.outputSummary = shallowClone(result?.outputSummary || null);
            await this.runStore.saveRun(run);

            this.emit({ type: 'tool.run.completed', run: shallowClone(run), tool: shallowClone(tool), artifacts: artifacts.map(artifact => shallowClone(artifact)) });
            return { run: shallowClone(run), artifacts: artifacts.map(artifact => shallowClone(artifact)) };
        } catch (error) {
            run.status = 'failed';
            run.updatedAt = Date.now();
            run.failedAt = run.updatedAt;
            run.completedAt = run.updatedAt;
            run.errorMessage = error.message || 'Tool execution failed.';
            await this.runStore.saveRun(run);
            this.emit({ type: 'tool.run.failed', run: shallowClone(run), tool: shallowClone(tool), error: { message: run.errorMessage } });
            throw error;
        }
    }

    async cancelRun(runId) {
        const cancelled = await this.host.cancelRun(runId);
        if (!cancelled) return false;

        const run = await this.runStore.getRun(runId);
        if (!run) return true;

        run.status = 'cancelled';
        run.updatedAt = Date.now();
        run.completedAt = run.updatedAt;
        await this.runStore.saveRun(run);
        this.emit({ type: 'tool.run.failed', run: shallowClone(run), error: { message: 'Tool run cancelled.' } });
        return true;
    }

    async streamTurn({ modelAdapter, request, approvalResolver = this.approvalResolver } = {}) {
        if (!modelAdapter || typeof modelAdapter.streamTurn !== 'function') {
            throw new Error('streamTurn requires a modelAdapter with streamTurn().');
        }

        const turnEvents = [];
        for await (const event of modelAdapter.streamTurn(request)) {
            turnEvents.push(event);
            this.emit(event);

            if (event?.type === 'tool.call.requested' && event.toolCall) {
                const result = await this.executeToolCall(event.toolCall, { approvalResolver });
                turnEvents.push({ type: 'tool.run.completed', run: result.run, artifacts: result.artifacts });
            }
        }

        const completed = { type: 'turn.completed' };
        turnEvents.push(completed);
        this.emit(completed);
        return turnEvents;
    }

    async handleHostEvent(event) {
        if (!event?.runId) {
            this.emit(event);
            return;
        }

        const run = await this.runStore.getRun(event.runId);
        if (!run) {
            this.emit(event);
            return;
        }

        if (event.type === 'tool.run.stdout') {
            run.stdout = `${run.stdout || ''}${event.chunk || ''}`;
            run.updatedAt = Date.now();
            await this.runStore.saveRun(run);
        } else if (event.type === 'tool.run.stderr') {
            run.stderr = `${run.stderr || ''}${event.chunk || ''}`;
            run.updatedAt = Date.now();
            await this.runStore.saveRun(run);
        }

        this.emit({ ...event, run: shallowClone(run) });
    }

    emit(event) {
        this.emitter.emit(event);
    }

    dispose() {
        if (typeof this.unsubscribeHost === 'function') {
            this.unsubscribeHost();
        }
    }
}
