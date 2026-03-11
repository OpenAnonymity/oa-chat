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

        this.unsubscribeRuntime = this.runtime.subscribe((event) => {
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

    getModelAdapter() {
        return this.modelAdapter;
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
        } else if (isSvgBlock(language, code) && this.toolMap.has('svg.render')) {
            actions.push({
                actionId: 'preview-svg',
                label: 'Preview',
                toolName: 'svg.render',
                effect: 'open'
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
                effect: 'open'
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
                effect: 'open'
            };
        case 'download-file':
            return {
                toolName: 'download.file',
                input: {
                    name: sanitizeFilename(inferDownloadName(language, code), 'artifact.txt'),
                    mimeType: isCalendarBlock(language, code) ? 'text/calendar' : 'text/plain',
                    content: code,
                    kind: lang || 'file'
                },
                effect: 'download'
            };
        case 'run-python':
            return {
                toolName: 'python.exec',
                input: {
                    language: lang || 'python',
                    command: code
                },
                effect: 'none'
            };
        case 'run-shell':
            return {
                toolName: 'bash.exec',
                input: {
                    language: lang || 'bash',
                    command: code
                },
                effect: 'none'
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
        const { run, done } = await this.runtime.startManualToolRun({
            sessionId: session.id,
            messageId,
            toolName: manual.toolName,
            input: manual.input,
            metadata: {
                source: 'code-block',
                actionId,
                language: language || ''
            }
        });

        await this.attachRunPartToMessage(messageId, run);
        this.scheduleMessageRefresh(messageId);

        try {
            const result = await done;
            await this.attachRunArtifactsToMessage(messageId, result.run, result.artifacts);

            if (manual.effect === 'open' && result.artifacts[0]) {
                await this.openArtifact(result.artifacts[0].id);
            } else if (manual.effect === 'download' && result.artifacts[0]) {
                await this.downloadArtifact(result.artifacts[0].id);
            }

            this.scheduleMessageRefresh(messageId);
            return result;
        } catch (error) {
            this.scheduleMessageRefresh(messageId);
            throw error;
        }
    }

    async rerunExecution(runId) {
        const run = await chatDB.getExecutionRun(runId);
        if (!run) {
            throw new Error('Run not found.');
        }

        const { run: newRun, done } = await this.runtime.startManualToolRun({
            sessionId: run.sessionId,
            messageId: run.messageId,
            toolName: run.toolName,
            input: run.input,
            metadata: {
                ...(run.metadata || {}),
                rerunOf: runId
            }
        });

        await this.attachRunPartToMessage(run.messageId, newRun);
        this.scheduleMessageRefresh(run.messageId);

        try {
            const result = await done;
            await this.attachRunArtifactsToMessage(run.messageId, result.run, result.artifacts);
            this.scheduleMessageRefresh(run.messageId);
            return result;
        } catch (error) {
            this.scheduleMessageRefresh(run.messageId);
            throw error;
        }
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
        const session = this.app.getCurrentSession();
        if (!session) return null;
        const messages = await chatDB.getSessionMessages(session.id);
        return messages.find(message => message.id === messageId) || null;
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

            return {
                ...message,
                executionRuns: messageRuns
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
