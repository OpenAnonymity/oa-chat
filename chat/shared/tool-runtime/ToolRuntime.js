import { generateRuntimeId, shallowClone, SimpleEventEmitter } from './utils.js';

function normalizeArtifactKind(mimeType = '', suggestedKind = '') {
    if (suggestedKind) return suggestedKind;
    if (mimeType === 'text/html') return 'html';
    if (mimeType === 'image/svg+xml') return 'svg';
    if (mimeType === 'application/json') return 'json';
    if (mimeType.startsWith('text/')) return 'text';
    return 'file';
}

function getModelToolName(tool = {}) {
    const candidate = (tool.skillName || tool.name || '').toString().trim();
    if (!candidate) return '';
    const normalized = candidate.replace(/[^a-zA-Z0-9_-]/g, '_');
    return normalized.slice(0, 64);
}

function parseToolArguments(rawArguments) {
    if (!rawArguments || !rawArguments.trim()) {
        return {};
    }
    return JSON.parse(rawArguments);
}

function normalizeToolCalls(toolCalls = []) {
    return (toolCalls || []).map((toolCall) => ({
        id: toolCall?.id || generateRuntimeId('call'),
        type: toolCall?.type || 'function',
        function: {
            name: toolCall?.function?.name || toolCall?.name || '',
            arguments: toolCall?.function?.arguments || toolCall?.arguments || '{}'
        }
    })).filter(toolCall => toolCall.function.name);
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
        return tools.find((tool) => tool.name === toolName || getModelToolName(tool) === toolName) || null;
    }

    async getModelTools() {
        const tools = await this.listTools();
        return tools
            .filter(tool => tool.modelEnabled !== false)
            .map((tool) => ({
                type: 'function',
                function: {
                    name: getModelToolName(tool),
                    description: tool.description || tool.title || tool.name,
                    parameters: shallowClone(tool.inputSchema || {
                        type: 'object',
                        properties: {},
                        additionalProperties: false
                    })
                }
            }));
    }

    subscribe(listener) {
        return this.emitter.subscribe(listener);
    }

    async runEphemeralTool({
        sessionId = null,
        messageId = null,
        toolName,
        input,
        metadata = {},
        context = {}
    }) {
        const tool = await this.getTool(toolName);
        if (!tool) {
            throw new Error(`Unsupported tool: ${toolName}`);
        }

        const result = await this.host.runTool({
            id: generateRuntimeId('call'),
            runId: null,
            sessionId,
            messageId,
            toolName: tool.name,
            input: shallowClone(input),
            metadata: shallowClone(metadata),
            context: shallowClone(context)
        });

        const artifacts = this.normalizeArtifacts(result?.artifacts || [], {
            sessionId,
            messageId,
            runId: null
        });

        return {
            tool: shallowClone(tool),
            status: result?.status || 'completed',
            stdout: typeof result?.stdout === 'string' ? result.stdout : '',
            stderr: typeof result?.stderr === 'string' ? result.stderr : '',
            errorMessage: result?.error?.message || null,
            artifacts
        };
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
            toolName: tool.name,
            toolSkillName: getModelToolName(tool),
            toolTitle: tool.title || tool.name,
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
            toolSkillName: getModelToolName(tool),
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

    normalizeArtifacts(rawArtifacts = [], { sessionId = null, messageId = null, runId = null } = {}) {
        return (rawArtifacts || []).map((rawArtifact) => ({
            id: rawArtifact.id || generateRuntimeId('artifact'),
            sessionId,
            messageId,
            runId,
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
        }));
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

            const artifacts = this.normalizeArtifacts(result?.artifacts || [], {
                sessionId: run.sessionId,
                messageId: run.messageId,
                runId: run.id
            });

            for (const artifact of artifacts) {
                await this.artifactStore.saveArtifact(artifact);
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

            this.emit({
                type: 'tool.run.completed',
                run: shallowClone(run),
                tool: shallowClone(tool),
                artifacts: artifacts.map(artifact => shallowClone(artifact))
            });
            return { run: shallowClone(run), artifacts: artifacts.map(artifact => shallowClone(artifact)) };
        } catch (error) {
            run.status = 'failed';
            run.updatedAt = Date.now();
            run.failedAt = run.updatedAt;
            run.completedAt = run.updatedAt;
            run.errorMessage = error.message || 'Tool execution failed.';
            await this.runStore.saveRun(run);
            this.emit({
                type: 'tool.run.failed',
                run: shallowClone(run),
                tool: shallowClone(tool),
                error: { message: run.errorMessage }
            });
            throw error;
        }
    }

    buildToolResultMessage(run, artifacts = []) {
        return JSON.stringify({
            status: run?.status || 'completed',
            stdout: run?.stdout || '',
            stderr: run?.stderr || '',
            error: run?.errorMessage || null,
            artifacts: (artifacts || []).map((artifact) => ({
                id: artifact.id,
                name: artifact.name,
                mimeType: artifact.mimeType,
                kind: artifact.kind,
                download: artifact.download !== false
            })),
            outputSummary: shallowClone(run?.outputSummary || null)
        });
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

    async *streamTurn({ modelAdapter, request, approvalResolver = this.approvalResolver, maxRounds = 6 } = {}) {
        if (!modelAdapter || typeof modelAdapter.streamTurn !== 'function') {
            throw new Error('streamTurn requires a modelAdapter with streamTurn().');
        }

        const modelTools = await this.getModelTools();
        let workingMessages = Array.isArray(request?.messages)
            ? request.messages.map(message => shallowClone(message))
            : [];

        for (let round = 0; round < maxRounds; round += 1) {
            let assistantResult = null;

            for await (const event of modelAdapter.streamTurn({
                ...request,
                messages: workingMessages.map(message => shallowClone(message)),
                tools: modelTools
            })) {
                if (event?.type === 'assistant.completed') {
                    assistantResult = shallowClone(event.result || null);
                }
                this.emit(event);
                yield event;
            }

            if (!assistantResult) {
                const completed = { type: 'turn.completed' };
                this.emit(completed);
                yield completed;
                return;
            }

            const toolCalls = normalizeToolCalls(
                assistantResult?.message?.toolCalls || assistantResult?.toolCalls || []
            );

            if (toolCalls.length === 0) {
                const completed = { type: 'turn.completed', result: shallowClone(assistantResult) };
                this.emit(completed);
                yield completed;
                return;
            }

            workingMessages = [
                ...workingMessages,
                {
                    role: 'assistant',
                    content: assistantResult?.message?.content || '',
                    toolCalls: toolCalls.map(toolCall => shallowClone(toolCall))
                }
            ];

            for (const rawToolCall of toolCalls) {
                let parsedInput;
                try {
                    parsedInput = parseToolArguments(rawToolCall.function.arguments || '{}');
                } catch (error) {
                    parsedInput = { raw_arguments: rawToolCall.function.arguments || '' };
                }

                const resolvedTool = await this.getTool(rawToolCall.function.name);
                const toolCall = {
                    id: rawToolCall.id || generateRuntimeId('call'),
                    sessionId: request?.session?.id || request?.sessionId || null,
                    messageId: request?.messageId || null,
                    toolName: rawToolCall.function.name,
                    input: parsedInput,
                    metadata: {
                        source: 'model',
                        round,
                        providerToolCallId: rawToolCall.id || null,
                        outputMode: resolvedTool?.family === 'artifact' ? 'embed' : 'execution-run'
                    },
                    context: shallowClone(request?.context || {})
                };

                const result = await this.executeToolCall(toolCall, { approvalResolver });
                workingMessages = [
                    ...workingMessages,
                    {
                        role: 'tool',
                        toolCallId: rawToolCall.id || toolCall.id,
                        name: rawToolCall.function.name,
                        content: this.buildToolResultMessage(result.run, result.artifacts)
                    }
                ];
            }
        }

        const completed = { type: 'turn.completed', reason: 'max-rounds-exceeded' };
        this.emit(completed);
        yield completed;
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
