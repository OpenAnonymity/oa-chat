import { ToolRuntime, CompositeToolHost } from '../../shared/tool-runtime/index.js';
import { chatDB } from '../../db.js';
import BrowserToolHost from './browserToolHost.js';
import ElectronToolHost from './electronToolHost.js';
import OAChatModelAdapter from './OAChatModelAdapter.js';
import { ChatRunStoreAdapter, ChatArtifactStoreAdapter } from './storeAdapters.js';

function sanitizeFilename(value, fallback) {
    const normalized = (value || fallback || '').toString().trim();
    if (!normalized) return fallback;
    return normalized.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').slice(0, 120) || fallback;
}

function inferDownloadName(language, code) {
    const lang = (language || '').toLowerCase();
    if (lang === 'ics') return 'calendar.ics';
    if (lang === 'html' || lang === 'htm') return 'preview.html';
    if (lang === 'svg') return 'diagram.svg';
    if (lang === 'json') return 'data.json';
    if (/BEGIN:VCALENDAR/i.test(code || '')) return 'calendar.ics';
    return 'artifact.txt';
}

function inferMimeType(language, code) {
    const lang = (language || '').toLowerCase();
    if (lang === 'html' || lang === 'htm' || /^\s*<!doctype html/i.test(code) || /^\s*<html[\s>]/i.test(code)) {
        return 'text/html';
    }
    if (lang === 'svg' || /^\s*<svg[\s>]/i.test(code)) {
        return 'image/svg+xml';
    }
    if (lang === 'json') {
        return 'application/json';
    }
    if (lang === 'ics' || /BEGIN:VCALENDAR/i.test(code || '')) {
        return 'text/calendar';
    }
    return 'text/plain';
}

function isHtmlBlock(language, code) {
    const lang = (language || '').toLowerCase();
    return lang === 'html' || lang === 'htm' || /^\s*<!doctype html/i.test(code) || /^\s*<html[\s>]/i.test(code);
}

function isSvgBlock(language, code) {
    const lang = (language || '').toLowerCase();
    return lang === 'svg' || /^\s*<svg[\s>]/i.test(code);
}

function isCalendarBlock(language, code) {
    const lang = (language || '').toLowerCase();
    return lang === 'ics' || /BEGIN:VCALENDAR/i.test(code || '');
}

function isPythonBlock(language) {
    const lang = (language || '').toLowerCase();
    return lang === 'python' || lang === 'py';
}

function isShellBlock(language) {
    const lang = (language || '').toLowerCase();
    return ['bash', 'sh', 'shell', 'zsh'].includes(lang);
}

function buildPartForRun(run, artifacts = []) {
    return {
        id: `part-${run.id}`,
        type: 'tool-run',
        runId: run.id,
        artifactIds: artifacts.map(artifact => artifact.id),
        createdAt: run.createdAt || Date.now()
    };
}

function groupBy(items, key) {
    const map = new Map();
    (items || []).forEach((item) => {
        const value = item?.[key];
        if (!value) return;
        if (!map.has(value)) {
            map.set(value, []);
        }
        map.get(value).push(item);
    });
    return map;
}

function shouldPersistRun(run) {
    if (!run) return false;
    if (run.metadata?.source === 'code-block' && run.toolFamily === 'artifact') {
        return false;
    }
    return true;
}

function shouldEmbedArtifacts(run) {
    if (!run) return false;
    return run.metadata?.outputMode === 'embed' ||
        (run.metadata?.source === 'model' && run.toolFamily === 'artifact');
}

function shouldRenderRunCard(run) {
    return shouldPersistRun(run) && !shouldEmbedArtifacts(run);
}

export default class ChatToolController {
    constructor(app) {
        this.app = app;
        this.runtime = null;
        this.host = null;
        this.tools = [];
        this.toolMap = new Map();
        this.modelAdapter = new OAChatModelAdapter(app);
        this.refreshTimers = new Map();
        this.unsubscribeRuntime = null;
    }

    async init() {
        const hosts = [new BrowserToolHost()];
        const electronHost = new ElectronToolHost();
        if (electronHost.isAvailable()) {
            hosts.push(electronHost);
        }

        this.host = new CompositeToolHost(hosts);
        this.runtime = new ToolRuntime({
            host: this.host,
            runStore: new ChatRunStoreAdapter(chatDB),
            artifactStore: new ChatArtifactStoreAdapter(chatDB)
        });

        this.unsubscribeRuntime = this.runtime.subscribe(async (event) => {
            if (event?.type === 'tool.run.started' && shouldPersistRun(event.run)) {
                await this.attachRunPartToMessage(event.run.messageId, event.run);
            }
            if (event?.type === 'tool.run.completed' && shouldPersistRun(event.run)) {
                await this.attachRunArtifactsToMessage(event.run.messageId, event.run, event.artifacts || []);
            }
            if (event?.type === 'tool.run.failed' && shouldPersistRun(event.run)) {
                await this.attachRunPartToMessage(event.run.messageId, event.run);
            }
            const messageId = event?.run?.messageId || event?.messageId;
            if (messageId) {
                this.scheduleMessageRefresh(messageId);
            }
        });

        await this.refreshTools();
    }

    async refreshTools() {
        this.tools = await this.runtime.listTools({ force: true });
        this.toolMap = new Map(this.tools.map(tool => [tool.name, tool]));
        return this.tools;
    }

    getCodeBlockActions({ language, code, messageId }) {
        if (!messageId || !this.toolMap.size) {
            return [];
        }

        const actions = [];
        if (isHtmlBlock(language, code) && this.toolMap.has('html.render')) {
            actions.push({
                actionId: 'preview-html',
                label: 'Preview',
                toolName: 'html.render',
                effect: 'open'
            });
            actions.push({
                actionId: 'download-html',
                label: 'Download',
                toolName: 'download.file',
                effect: 'download'
            });
        } else if (isSvgBlock(language, code) && this.toolMap.has('svg.render')) {
            actions.push({
                actionId: 'preview-svg',
                label: 'Preview',
                toolName: 'svg.render',
                effect: 'open'
            });
            actions.push({
                actionId: 'download-svg',
                label: 'Download',
                toolName: 'download.file',
                effect: 'download'
            });
        }

        if (isCalendarBlock(language, code) && this.toolMap.has('download.file')) {
            actions.push({
                actionId: 'download-file',
                label: 'Download',
                toolName: 'download.file',
                effect: 'download'
            });
        }

        if (isPythonBlock(language) && this.toolMap.has('python.exec')) {
            actions.push({
                actionId: 'run-python',
                label: 'Run',
                toolName: 'python.exec',
                effect: 'none'
            });
        }

        if (isShellBlock(language) && this.toolMap.has('bash.exec')) {
            actions.push({
                actionId: 'run-shell',
                label: 'Run',
                toolName: 'bash.exec',
                effect: 'none'
            });
        }

        return actions;
    }

    buildManualToolInput({ actionId, language, code }) {
        const lang = (language || '').toLowerCase();
        switch (actionId) {
        case 'preview-html':
            return {
                toolName: 'html.render',
                input: {
                    name: sanitizeFilename(inferDownloadName(language, code), 'preview.html'),
                    mimeType: 'text/html',
                    content: code,
                    title: 'HTML Preview'
                },
                effect: 'open',
                persist: false
            };
        case 'preview-svg':
            return {
                toolName: 'svg.render',
                input: {
                    name: sanitizeFilename(inferDownloadName(language, code), 'diagram.svg'),
                    mimeType: 'image/svg+xml',
                    content: code,
                    title: 'SVG Preview'
                },
                effect: 'open',
                persist: false
            };
        case 'download-html':
        case 'download-svg':
        case 'download-file':
            return {
                toolName: 'download.file',
                input: {
                    name: sanitizeFilename(inferDownloadName(language, code), 'artifact.txt'),
                    mimeType: inferMimeType(language, code),
                    content: code,
                    kind: lang || 'file'
                },
                effect: 'download',
                persist: false
            };
        case 'run-python':
            return {
                toolName: 'python.exec',
                input: {
                    language: lang || 'python',
                    command: code
                },
                effect: 'none',
                persist: true
            };
        case 'run-shell':
            return {
                toolName: 'bash.exec',
                input: {
                    language: lang || 'bash',
                    command: code
                },
                effect: 'none',
                persist: true
            };
        default:
            throw new Error(`Unsupported manual tool action: ${actionId}`);
        }
    }

    async executeCodeBlockAction({ messageId, language, code, actionId }) {
        const session = this.app.getCurrentSession();
        if (!session) {
            throw new Error('No active session.');
        }

        const manual = this.buildManualToolInput({ actionId, language, code });
        if (manual.persist === false) {
            const result = await this.runtime.runEphemeralTool({
                sessionId: session.id,
                messageId,
                toolName: manual.toolName,
                input: manual.input,
                metadata: {
                    source: 'code-block',
                    actionId,
                    language: language || '',
                    outputMode: 'inline-action'
                }
            });

            if (manual.effect === 'open' && result.artifacts[0]) {
                this.app.chatArea?.showArtifactViewer?.(result.artifacts[0]);
            } else if (manual.effect === 'download' && result.artifacts[0]) {
                await this.downloadArtifactContent(result.artifacts[0]);
            }
            return result;
        }

        const { done } = await this.runtime.startManualToolRun({
            sessionId: session.id,
            messageId,
            toolName: manual.toolName,
            input: manual.input,
            metadata: {
                source: 'code-block',
                actionId,
                language: language || '',
                outputMode: 'execution-run'
            }
        });

        const result = await done;
        if (manual.effect === 'open' && result.artifacts[0]) {
            await this.openArtifact(result.artifacts[0].id);
        } else if (manual.effect === 'download' && result.artifacts[0]) {
            await this.downloadArtifact(result.artifacts[0].id);
        }
        return result;
    }

    async rerunExecution(runId) {
        const run = await chatDB.getExecutionRun(runId);
        if (!run) {
            throw new Error('Run not found.');
        }

        const { done } = await this.runtime.startManualToolRun({
            sessionId: run.sessionId,
            messageId: run.messageId,
            toolName: run.toolName,
            input: run.input,
            metadata: {
                ...(run.metadata || {}),
                rerunOf: runId
            }
        });

        return done;
    }

    async *streamAssistantTurn(request) {
        if (!this.runtime) {
            throw new Error('Tool runtime is not initialized.');
        }

        for await (const event of this.runtime.streamTurn({
            modelAdapter: this.modelAdapter,
            request
        })) {
            yield event;
        }
    }

    shouldEmbedArtifacts(run) {
        return shouldEmbedArtifacts(run);
    }

    shouldRenderRunCard(run) {
        return shouldRenderRunCard(run);
    }

    async attachRunPartToMessage(messageId, run) {
        const message = await this.findMessageById(messageId);
        if (!message) return;

        const parts = Array.isArray(message.parts) ? [...message.parts] : [];
        if (!parts.some(part => part?.runId === run.id)) {
            parts.push(buildPartForRun(run, []));
            message.parts = parts;
            await chatDB.saveMessage(message);
        }
    }

    async attachRunArtifactsToMessage(messageId, run, artifacts = []) {
        const message = await this.findMessageById(messageId);
        if (!message) return;

        const parts = Array.isArray(message.parts) ? [...message.parts] : [];
        const partIndex = parts.findIndex(part => part?.runId === run.id);
        if (partIndex >= 0) {
            parts[partIndex] = buildPartForRun(run, artifacts);
        } else {
            parts.push(buildPartForRun(run, artifacts));
        }
        message.parts = parts;
        await chatDB.saveMessage(message);
    }

    async findMessageById(messageId) {
        return chatDB.getMessage(messageId);
    }

    async hydrateMessages(messages = []) {
        if (!Array.isArray(messages) || messages.length === 0) {
            return messages;
        }

        const sessionId = messages[0]?.sessionId;
        if (!sessionId) return messages;

        const [runs, artifacts] = await Promise.all([
            chatDB.getSessionExecutionRuns(sessionId),
            chatDB.getSessionArtifacts(sessionId)
        ]);

        const runsByMessage = groupBy(runs, 'messageId');
        const artifactsByRun = groupBy(artifacts, 'runId');

        return messages.map((message) => {
            const messageRuns = (runsByMessage.get(message.id) || []).map((run) => ({
                ...run,
                artifacts: artifactsByRun.get(run.id) || []
            }));

            messageRuns.sort((a, b) => {
                const aIndex = Array.isArray(message.parts) ? message.parts.findIndex(part => part?.runId === a.id) : -1;
                const bIndex = Array.isArray(message.parts) ? message.parts.findIndex(part => part?.runId === b.id) : -1;
                if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
                return (a.createdAt || 0) - (b.createdAt || 0);
            });

            const executionRuns = messageRuns.filter(run => shouldRenderRunCard(run));
            const embeddedArtifacts = messageRuns
                .filter(run => shouldEmbedArtifacts(run))
                .flatMap(run => run.artifacts || []);

            return {
                ...message,
                executionRuns,
                embeddedArtifacts
            };
        });
    }

    async hydrateMessageById(messageId) {
        const message = await this.findMessageById(messageId);
        if (!message) return null;
        const [hydrated] = await this.hydrateMessages([message]);
        return hydrated || null;
    }

    scheduleMessageRefresh(messageId) {
        if (!messageId) return;
        if (this.refreshTimers.has(messageId)) {
            clearTimeout(this.refreshTimers.get(messageId));
        }

        const timer = setTimeout(async () => {
            this.refreshTimers.delete(messageId);
            const hydrated = await this.hydrateMessageById(messageId);
            if (!hydrated) return;
            if (this.app.chatArea && this.app.isViewingSession(hydrated.sessionId)) {
                this.app.chatArea.updateMessage(hydrated);
            }
        }, 40);

        this.refreshTimers.set(messageId, timer);
    }

    async getArtifact(artifactId) {
        return chatDB.getArtifact(artifactId);
    }

    async downloadArtifactContent(artifact) {
        if (!artifact) {
            throw new Error('Artifact not found.');
        }

        const blob = new Blob([artifact.content || ''], { type: artifact.mimeType || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = artifact.name || 'artifact';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return artifact;
    }

    async openArtifact(artifactId) {
        const artifact = await this.getArtifact(artifactId);
        if (!artifact) {
            throw new Error('Artifact not found.');
        }
        this.app.chatArea?.showArtifactViewer?.(artifact);
        return artifact;
    }

    async downloadArtifact(artifactId) {
        const artifact = await this.getArtifact(artifactId);
        return this.downloadArtifactContent(artifact);
    }

    dispose() {
        if (typeof this.unsubscribeRuntime === 'function') {
            this.unsubscribeRuntime();
        }
        this.refreshTimers.forEach(timer => clearTimeout(timer));
        this.refreshTimers.clear();
        this.runtime?.dispose?.();
        this.host?.dispose?.();
    }
}
