import { generateRuntimeId } from '../../shared/tool-runtime/index.js';

function byteSizeOf(value) {
    if (typeof value !== 'string') return 0;
    return new TextEncoder().encode(value).length;
}

function sanitizeArtifactName(name, fallback = 'artifact.txt') {
    const normalized = (name || fallback).toString().trim();
    if (!normalized) return fallback;
    return normalized.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').slice(0, 120) || fallback;
}

export default class BrowserToolHost {
    constructor() {
        this.hostId = 'browser';
    }

    async getCapabilities() {
        const tools = await this.listTools();
        return {
            hostId: this.hostId,
            toolNames: tools.map(tool => tool.name),
            families: ['artifact'],
            runtimeFamilies: [],
            supportsStructuredToolCalls: false
        };
    }

    async listTools() {
        return [
            {
                name: 'artifact.create',
                title: 'Create Artifact',
                description: 'Create a downloadable artifact.',
                family: 'artifact',
                approvalPolicy: 'never'
            },
            {
                name: 'html.render',
                title: 'Preview HTML',
                description: 'Create a sandboxed HTML preview artifact.',
                family: 'artifact',
                approvalPolicy: 'never'
            },
            {
                name: 'svg.render',
                title: 'Preview SVG',
                description: 'Create an SVG preview artifact.',
                family: 'artifact',
                approvalPolicy: 'never'
            },
            {
                name: 'download.file',
                title: 'Download File',
                description: 'Create a downloadable file artifact.',
                family: 'artifact',
                approvalPolicy: 'never'
            }
        ];
    }

    async runTool(call) {
        switch (call?.toolName) {
        case 'artifact.create':
            return this.createArtifact(call);
        case 'html.render':
            return this.renderHtml(call);
        case 'svg.render':
            return this.renderSvg(call);
        case 'download.file':
            return this.downloadFile(call);
        default:
            throw new Error(`Browser host does not support tool: ${call?.toolName || 'unknown'}`);
        }
    }

    async cancelRun() {
        return false;
    }

    subscribe() {
        return () => {};
    }

    async createArtifact(call) {
        const input = call?.input || {};
        const content = typeof input.content === 'string' ? input.content : '';
        const mimeType = input.mimeType || 'text/plain';
        const artifact = {
            id: generateRuntimeId('artifact'),
            name: sanitizeArtifactName(input.name, 'artifact.txt'),
            mimeType,
            kind: input.kind || 'file',
            content,
            byteSize: byteSizeOf(content),
            download: true,
            metadata: {
                title: input.title || null,
                originTool: call.toolName
            }
        };

        return {
            status: 'completed',
            artifacts: [artifact]
        };
    }

    async renderHtml(call) {
        const input = call?.input || {};
        const content = typeof input.content === 'string' ? input.content : '';
        const artifact = {
            id: generateRuntimeId('artifact'),
            name: sanitizeArtifactName(input.name, 'preview.html'),
            mimeType: 'text/html',
            kind: 'html',
            content,
            byteSize: byteSizeOf(content),
            download: true,
            metadata: {
                title: input.title || 'HTML Preview',
                originTool: call.toolName
            }
        };

        return {
            status: 'completed',
            artifacts: [artifact]
        };
    }

    async renderSvg(call) {
        const input = call?.input || {};
        const content = typeof input.content === 'string' ? input.content : '';
        const artifact = {
            id: generateRuntimeId('artifact'),
            name: sanitizeArtifactName(input.name, 'diagram.svg'),
            mimeType: 'image/svg+xml',
            kind: 'svg',
            content,
            byteSize: byteSizeOf(content),
            download: true,
            metadata: {
                title: input.title || 'SVG Preview',
                originTool: call.toolName
            }
        };

        return {
            status: 'completed',
            artifacts: [artifact]
        };
    }

    async downloadFile(call) {
        const input = call?.input || {};
        return this.createArtifact({
            ...call,
            input: {
                ...input,
                name: input.name || 'download.txt',
                kind: input.kind || 'file'
            }
        });
    }
}
