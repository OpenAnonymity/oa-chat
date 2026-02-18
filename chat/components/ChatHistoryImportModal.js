import {
    parseChatHistoryFile,
    buildImportPlan,
    getChatHistoryImporters,
    getChatHistoryImportAccept
} from '../services/chatHistoryImporters.js';
import { chatDB } from '../db.js';
import sessionEmbedder from '../services/sessionEmbedder.js';
import keywordsGenerator from '../services/keywordsGenerator.js';

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

class ChatHistoryImportModal {
    constructor(app) {
        this.app = app;
        this.isOpen = false;
        this.overlay = null;
        this.state = this.getInitialState();
        this.escapeHandler = null;
    }

    getInitialState() {
        return {
            step: 'select',
            file: null,
            importer: null,
            importerLabel: null,
            importerSource: null,
            importerDescription: null,
            preview: null,
            plan: [],
            progress: {
                total: 0,
                processed: 0,
                imported: 0,
                skipped: 0,
                duplicates: 0,
                errors: 0
            },
            embeddingProgress: {
                total: 0,
                processed: 0,
                embedded: 0,
                keyworded: 0,
                errors: 0
            },
            generateEmbeddings: false,
            parseError: null,
            lastError: null,
            confirmingCancel: false,
            cancelRequested: false,
            embeddingCancelRequested: false
        };
    }

    open() {
        if (this.isOpen) return;
        this.isOpen = true;
        this.state = this.getInitialState();

        document.querySelector('.chat-history-import-modal')?.remove();

        this.overlay = document.createElement('div');
        this.overlay.className = 'chat-history-import-modal fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-in fade-in';

        this.render();
        document.body.appendChild(this.overlay);
        this.setupEventListeners();
    }

    close() {
        if (!this.isOpen) return;
        if (this.state.step === 'importing' && !this.state.cancelRequested) {
            this.requestCancel();
            return;
        }
        if (this.state.step === 'embedding') {
            this.state.embeddingCancelRequested = true;
        }
        this.isOpen = false;
        this.state.plan = [];
        this.state.preview = null;
        this.overlay?.remove();
        this.overlay = null;
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
    }

    render() {
        if (!this.overlay) return;

        const {
            step,
            file,
            importer,
            importerLabel,
            importerDescription,
            preview,
            progress,
            embeddingProgress,
            generateEmbeddings,
            parseError,
            lastError,
            confirmingCancel,
            cancelRequested
        } = this.state;

        const fileInfo = file ? `${file.name} (${formatBytes(file.size)})` : 'No file selected';
        const importers = getChatHistoryImporters();
        const visibleImporters = importers.filter(entry => entry.showInList !== false);
        const acceptTypes = getChatHistoryImportAccept();
        const detectedLabel = importerLabel || importer?.label || 'Chat history';
        const detectedDescription = importerDescription || importer?.description || '';

        let bodyHtml = '';
        if (step === 'select') {
            const importerListHtml = visibleImporters.length
                ? `
                    <div class="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground space-y-2">
                        <div class="text-xs text-muted-foreground">Supported Formats</div>
                        ${visibleImporters.map(entry => {
                            const status = entry.enabled === false ? 'Coming soon' : 'Ready';
                            const statusClass = entry.enabled === false ? 'text-muted-foreground' : 'text-foreground';
                            const hint = entry.fileHint || entry.label;
                            return `
                                <div class="space-y-1">
                                    <div class="flex items-center justify-between gap-2">
                                        <div class="text-sm text-foreground">${entry.label}</div>
                                        <div class="text-xs ${statusClass}">${status}</div>
                                    </div>
                                    <div class="text-[11px] text-muted-foreground">${hint}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `
                : '';
            bodyHtml = `
                <div class="space-y-3">
                    <p class="text-sm text-foreground">Import chat history into your local browser database.</p>
                    ${importerListHtml}
                    <div class="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground space-y-2">
                        <div class="text-xs text-muted-foreground">Find your ChatGPT export</div>
                        <ol class="list-decimal list-inside space-y-1">
                            <li>Open ChatGPT Settings and go to Data Controls.</li>
                            <li>Select "Export data" and confirm via email.</li>
                            <li>Download and unzip the export archive.</li>
                            <li>Choose <span class="font-mono">conversations.json</span> below.</li>
                        </ol>
                    </div>
                    <div class="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground space-y-2">
                        <div>Imports text, reasoning trace, citations, and web-search thumbnails if possible.</div>
                        <div>Other media is shown as placeholders.</div>
                        <div>Everything stays in your browser. Nothing is uploaded.</div>
                        <div>More sources can be added over time.</div>
                    </div>
                    <div class="flex items-center justify-between gap-2">
                        <div class="text-xs text-muted-foreground">${fileInfo}</div>
                        <button id="chat-import-pick-file" class="btn-primary-bright px-3 py-2 text-sm font-medium rounded-md bg-blue-600 text-white transition-all duration-200">Choose file</button>
                    </div>
                    ${parseError ? `<div class="text-sm text-red-600">${parseError}</div>` : ''}
                </div>
            `;
        } else if (step === 'parsing') {
            bodyHtml = `
                <div class="space-y-4 text-sm">
                    <div class="flex items-center gap-2 text-foreground">
                        <span class="inline-flex h-2.5 w-2.5 rounded-full bg-primary animate-pulse"></span>
                        Parsing export file...
                    </div>
                    <div class="text-xs text-muted-foreground">${fileInfo}</div>
                </div>
            `;
        } else if (step === 'preview') {
            bodyHtml = `
                <div class="space-y-4 text-sm">
                    <div class="rounded-lg border border-border bg-muted/40 p-3 space-y-2">
                        <div class="text-xs text-muted-foreground">Detected format</div>
                        <div class="text-sm text-foreground font-medium">${detectedLabel}</div>
                        ${detectedDescription ? `<div class="text-xs text-muted-foreground">${detectedDescription}</div>` : ''}
                        <div class="text-xs text-muted-foreground">${fileInfo}</div>
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                        <div class="rounded-lg border border-border p-3">
                            <div class="text-xs text-muted-foreground">Sessions</div>
                            <div class="text-lg font-semibold text-foreground">${preview?.importableSessions ?? preview?.sessionCount ?? 0}</div>
                        </div>
                        <div class="rounded-lg border border-border p-3">
                            <div class="text-xs text-muted-foreground">Messages</div>
                            <div class="text-lg font-semibold text-foreground">${preview?.messageCount || 0}</div>
                        </div>
                        <div class="rounded-lg border border-border p-3">
                            <div class="text-xs text-muted-foreground">Media placeholders</div>
                            <div class="text-lg font-semibold text-foreground">${preview?.mediaMessages || 0}</div>
                        </div>
                        <div class="rounded-lg border border-border p-3">
                            <div class="text-xs text-muted-foreground">Import order</div>
                            <div class="text-sm text-foreground">Newest first</div>
                        </div>
                    </div>
                    <div class="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                        Imports text, reasoning trace, citations, and web-search thumbnails if possible. Other media is shown as placeholders.
                    </div>
                    <label class="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-3 cursor-pointer">
                        <input id="chat-import-generate-embeddings" type="checkbox" class="mt-0.5" ${generateEmbeddings ? 'checked' : ''}>
                        <span class="text-xs text-muted-foreground">
                            Generate embeddings and keywords now (slower import). If enabled, import finishes only after embedding is complete.
                        </span>
                    </label>
                    <div class="flex items-center justify-between gap-2">
                        <button id="chat-import-pick-file" class="px-3 py-2 text-sm font-medium rounded-md border border-border hover-highlight transition-colors">Choose another file</button>
                        <button id="chat-import-start" class="px-3 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">Start import</button>
                    </div>
                </div>
            `;
        } else if (step === 'importing') {
            const progressPercent = progress.total ? Math.round((progress.processed / progress.total) * 100) : 0;
            bodyHtml = `
                <div class="space-y-4 text-sm">
                    <div class="text-sm text-foreground font-medium">Importing chats</div>
                    <div class="text-xs text-muted-foreground">${fileInfo}</div>
                    <div class="w-full h-2 bg-muted rounded-full overflow-hidden">
                        <div id="import-progress-fill" class="h-full bg-primary transition-all" style="width: ${progressPercent}%"></div>
                    </div>
                    <div id="import-progress-text" class="text-xs text-muted-foreground">
                        ${progress.processed} of ${progress.total} sessions processed (${progressPercent}%)
                    </div>
                    <div class="grid grid-cols-3 gap-2 text-xs">
                        <div class="rounded-lg border border-border p-2 text-center">
                            <div class="text-muted-foreground">Imported</div>
                            <div id="import-count" class="text-foreground font-semibold">${progress.imported}</div>
                        </div>
                        <div class="rounded-lg border border-border p-2 text-center">
                            <div class="text-muted-foreground">Skipped</div>
                            <div id="skip-count" class="text-foreground font-semibold">${progress.skipped}</div>
                        </div>
                        <div class="rounded-lg border border-border p-2 text-center">
                            <div class="text-muted-foreground">Duplicates</div>
                            <div id="dup-count" class="text-foreground font-semibold">${progress.duplicates}</div>
                        </div>
                    </div>
                    ${cancelRequested ? `<div class="text-xs text-muted-foreground">Stopping after the current session...</div>` : ''}
                    <div class="flex items-center justify-end gap-2">
                        <button id="chat-import-cancel" class="px-3 py-2 text-sm font-medium rounded-md border border-border hover-highlight transition-colors">Cancel</button>
                    </div>
                    ${confirmingCancel ? `
                        <div class="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground space-y-2">
                            <div>Cancel the import? Imported sessions remain available.</div>
                            <div class="flex items-center justify-end gap-2">
                                <button id="chat-import-keep" class="px-3 py-1.5 text-xs font-medium rounded-md border border-border hover-highlight transition-colors">Keep importing</button>
                                <button id="chat-import-confirm-cancel" class="px-3 py-1.5 text-xs font-medium rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors">Cancel import</button>
                            </div>
                        </div>
                    ` : ''}
                </div>
            `;
        } else if (step === 'embedding') {
            const progressPercent = embeddingProgress.total
                ? Math.round((embeddingProgress.processed / embeddingProgress.total) * 100)
                : 0;
            bodyHtml = `
                <div class="space-y-4 text-sm">
                    <div class="text-sm text-foreground font-medium">Generating embeddings</div>
                    <div class="text-xs text-muted-foreground">Please wait until embedding and keyword generation complete.</div>
                    <div class="w-full h-2 bg-muted rounded-full overflow-hidden">
                        <div id="embedding-progress-fill" class="h-full bg-primary transition-all" style="width: ${progressPercent}%"></div>
                    </div>
                    <div id="embedding-progress-text" class="text-xs text-muted-foreground">
                        ${embeddingProgress.processed} of ${embeddingProgress.total} sessions processed (${progressPercent}%)
                    </div>
                    <div class="grid grid-cols-3 gap-2 text-xs">
                        <div class="rounded-lg border border-border p-2 text-center">
                            <div class="text-muted-foreground">Embedded</div>
                            <div id="embedding-count" class="text-foreground font-semibold">${embeddingProgress.embedded}</div>
                        </div>
                        <div class="rounded-lg border border-border p-2 text-center">
                            <div class="text-muted-foreground">Keywords</div>
                            <div id="keyword-count" class="text-foreground font-semibold">${embeddingProgress.keyworded}</div>
                        </div>
                        <div class="rounded-lg border border-border p-2 text-center">
                            <div class="text-muted-foreground">Errors</div>
                            <div id="embedding-error-count" class="text-foreground font-semibold">${embeddingProgress.errors}</div>
                        </div>
                    </div>
                </div>
            `;
        } else if (step === 'complete' || step === 'cancelled' || step === 'error') {
            const heading = step === 'complete' ? 'Import complete' : step === 'cancelled' ? 'Import cancelled' : 'Import failed';
            const summaryText = lastError ? lastError : '';
            bodyHtml = `
                <div class="space-y-4 text-sm">
                    <div class="text-sm text-foreground font-medium">${heading}</div>
                    <div class="grid grid-cols-3 gap-2 text-xs">
                        <div class="rounded-lg border border-border p-2 text-center">
                            <div class="text-muted-foreground">Imported</div>
                            <div class="text-foreground font-semibold">${progress.imported}</div>
                        </div>
                        <div class="rounded-lg border border-border p-2 text-center">
                            <div class="text-muted-foreground">Skipped</div>
                            <div class="text-foreground font-semibold">${progress.skipped}</div>
                        </div>
                        <div class="rounded-lg border border-border p-2 text-center">
                            <div class="text-muted-foreground">Duplicates</div>
                            <div class="text-foreground font-semibold">${progress.duplicates}</div>
                        </div>
                    </div>
                    ${summaryText ? `<div class="text-xs text-red-600">${summaryText}</div>` : ''}
                    <div class="flex items-center justify-end">
                        <button id="chat-import-done" class="px-3 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">Done</button>
                    </div>
                </div>
            `;
        }

        this.overlay.innerHTML = `
            <div class="bg-background border border-border rounded-xl shadow-2xl max-w-lg w-full mx-4 animate-in zoom-in-95 overflow-hidden">
                <div class="p-4 border-b border-border flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <svg class="w-5 h-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                        </svg>
                        <h2 class="text-base font-semibold text-foreground">Import Chat History</h2>
                    </div>
                    <button id="chat-import-close" class="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-muted">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>
                <div class="p-4">
                    <input id="chat-import-input" type="file" class="hidden" accept="${acceptTypes}">
                    ${bodyHtml}
                </div>
            </div>
        `;
    }

    setupEventListeners() {
        if (!this.overlay) return;

        const closeBtn = this.overlay.querySelector('#chat-import-close');
        const pickFileBtn = this.overlay.querySelector('#chat-import-pick-file');
        const fileInput = this.overlay.querySelector('#chat-import-input');
        const startBtn = this.overlay.querySelector('#chat-import-start');
        const cancelBtn = this.overlay.querySelector('#chat-import-cancel');
        const keepBtn = this.overlay.querySelector('#chat-import-keep');
        const confirmCancelBtn = this.overlay.querySelector('#chat-import-confirm-cancel');
        const doneBtn = this.overlay.querySelector('#chat-import-done');
        const generateEmbeddingsInput = this.overlay.querySelector('#chat-import-generate-embeddings');

        if (closeBtn) {
            closeBtn.onclick = () => this.close();
        }

        this.overlay.onclick = (e) => {
            if (e.target === this.overlay) this.close();
        };

        pickFileBtn?.addEventListener('click', () => fileInput?.click());
        fileInput?.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (file) {
                this.handleFileSelected(file);
                fileInput.value = '';
            }
        });

        startBtn?.addEventListener('click', () => this.startImport());
        generateEmbeddingsInput?.addEventListener('change', () => {
            this.state.generateEmbeddings = !!generateEmbeddingsInput.checked;
        });
        cancelBtn?.addEventListener('click', () => this.requestCancel());
        keepBtn?.addEventListener('click', () => {
            this.state.confirmingCancel = false;
            this.render();
            this.setupEventListeners();
        });
        confirmCancelBtn?.addEventListener('click', () => {
            this.state.cancelRequested = true;
            this.state.confirmingCancel = false;
            this.render();
            this.setupEventListeners();
        });
        doneBtn?.addEventListener('click', () => this.close());

        if (!this.escapeHandler) {
            this.escapeHandler = (e) => {
                if (e.key === 'Escape') this.close();
            };
            document.addEventListener('keydown', this.escapeHandler);
        }
    }

    async handleFileSelected(file) {
        this.state.file = file;
        this.state.parseError = null;
        this.state.importer = null;
        this.state.importerLabel = null;
        this.state.importerSource = null;
        this.state.importerDescription = null;
        this.state.step = 'parsing';
        this.render();
        this.setupEventListeners();

        try {
            const { importer, parsed } = await parseChatHistoryFile(file);
            const plan = buildImportPlan(parsed.sessions, importer);
            const planStats = plan.reduce((acc, session) => {
                acc.messageCount += session.messages.length;
                session.messages.forEach(message => {
                    if (message.hasMedia) acc.mediaMessages += 1;
                });
                return acc;
            }, { messageCount: 0, mediaMessages: 0 });
            const importerSource = importer?.source || parsed?.source || importer?.id || 'imported';
            this.state.importer = importer;
            this.state.importerLabel = importer?.label || null;
            this.state.importerSource = importerSource;
            this.state.importerDescription = importer?.description || importer?.fileHint || null;
            this.state.preview = {
                ...parsed.stats,
                ...planStats,
                importableSessions: plan.length
            };
            this.state.plan = plan;
            this.state.progress.total = plan.length;
            this.state.step = 'preview';
        } catch (error) {
            this.state.parseError = error.message || 'Failed to parse file.';
            this.state.step = 'select';
        }

        this.render();
        this.setupEventListeners();
    }

    requestCancel() {
        if (this.state.step !== 'importing') {
            this.close();
            return;
        }
        if (this.state.cancelRequested) return;
        this.state.confirmingCancel = true;
        this.render();
        this.setupEventListeners();
    }

    async startImport() {
        if (!this.state.plan.length) {
            this.state.parseError = 'No sessions found to import.';
            this.state.step = 'select';
            this.render();
            this.setupEventListeners();
            return;
        }

        this.state.progress.processed = 0;
        this.state.progress.imported = 0;
        this.state.progress.skipped = 0;
        this.state.progress.duplicates = 0;
        this.state.progress.errors = 0;
        this.state.embeddingProgress.total = 0;
        this.state.embeddingProgress.processed = 0;
        this.state.embeddingProgress.embedded = 0;
        this.state.embeddingProgress.keyworded = 0;
        this.state.embeddingProgress.errors = 0;
        this.state.confirmingCancel = false;
        this.state.cancelRequested = false;
        this.state.embeddingCancelRequested = false;
        this.state.lastError = null;
        this.state.step = 'importing';
        this.render();
        this.setupEventListeners();

        try {
            await this.importSessions();
        } catch (error) {
            this.state.lastError = error.message || 'Import failed.';
            this.state.step = 'error';
        } finally {
            this.state.plan = [];
        }

        if (this.state.step === 'importing') {
            this.state.step = this.state.cancelRequested ? 'cancelled' : 'complete';
        }

        if (this.state.step !== 'error' && !this.state.cancelRequested && this.state.generateEmbeddings && this._importedSessionIds.length > 0) {
            this.state.step = 'embedding';
            this.state.embeddingProgress.total = this._importedSessionIds.length;
            this.state.embeddingProgress.processed = 0;
            this.state.embeddingProgress.embedded = 0;
            this.state.embeddingProgress.keyworded = 0;
            this.state.embeddingProgress.errors = 0;
            this.render();
            this.setupEventListeners();
            await this.generateImportedEmbeddings();
            if (this.state.step === 'embedding') {
                this.state.step = 'complete';
            }
        }

        await this.refreshSessionsFromDb();
        this.render();
        this.setupEventListeners();
    }

    async importSessions() {
        this._importedSessionIds = [];
        const importer = this.state.importer;
        const source = this.state.importerSource || importer?.source || 'imported';
        const getExternalId = typeof importer?.getExternalId === 'function'
            ? importer.getExternalId.bind(importer)
            : (session) => session.sourceId || null;

        const knownIds = typeof chatDB.collectImportedSessionKeys === 'function'
            ? await chatDB.collectImportedSessionKeys(source)
            : new Set();
        let existingSessions = null;
        if (knownIds.size === 0 && typeof chatDB.collectImportedSessionKeys !== 'function') {
            existingSessions = await chatDB.getAllSessions();
            existingSessions.forEach(session => {
                if (session.importedSource && session.importedExternalId) {
                    knownIds.add(`${session.importedSource}:${session.importedExternalId}`);
                }
                if (session.importedFrom && session.importedFrom.startsWith(`${source}:`)) {
                    knownIds.add(session.importedFrom);
                }
            });
        }

        if (source === 'oa-fastchat') {
            if (!existingSessions) {
                existingSessions = await chatDB.getAllSessions();
            }
            existingSessions.forEach(session => {
                if (session?.id) {
                    knownIds.add(`${source}:${session.id}`);
                }
            });
        }

        for (let index = 0; index < this.state.plan.length; index += 1) {
            if (this.state.cancelRequested) {
                break;
            }

            const sessionData = this.state.plan[index];
            const externalId = getExternalId(sessionData);
            const sourceKey = externalId ? `${source}:${externalId}` : null;
            if (sourceKey && knownIds.has(sourceKey)) {
                this.state.progress.skipped += 1;
                this.state.progress.duplicates += 1;
                this.state.progress.processed += 1;
                this.updateProgressUI();
                continue;
            }

            const sessionId = this.app.generateId();
            const sessionModel = sessionData.model || null;
            const messages = sessionData.messages.map(message => ({
                id: this.app.generateId(),
                sessionId,
                role: message.role,
                content: message.content,
                reasoning: message.reasoning || null,
                reasoningDuration: message.reasoningDuration || null,
                timestamp: message.timestamp,
                model: message.model || sessionModel,
                tokenCount: null,
                streamingTokens: null,
                files: null,
                searchEnabled: false,
                citations: message.citations || null,
                images: message.images || null,
                isLocalOnly: false
            }));

            const updatedAt = sessionData.updatedAt || messages[messages.length - 1]?.timestamp || Date.now();

            const session = {
                id: sessionId,
                title: sessionData.title,
                createdAt: sessionData.createdAt || Date.now(),
                updatedAt,
                model: sessionModel,
                summary: typeof sessionData.summary === 'string' ? sessionData.summary : null,
                keywords: Array.isArray(sessionData.keywords) ? sessionData.keywords : [],
                keywordsGeneratedAt: sessionData.keywordsGeneratedAt || null,
                messageCountAtGeneration: sessionData.messageCountAtGeneration || null,
                apiKey: null,
                apiKeyInfo: null,
                expiresAt: null,
                searchEnabled: this.app.searchEnabled,
                importedSource: source,
                importedExternalId: externalId,
                importedAt: Date.now(),
                importedMessageCount: messages.length,
                disableAutoEmbeddingKeywords: !this.state.generateEmbeddings
            };

            try {
                if (typeof chatDB.saveSessionWithMessages === 'function') {
                    await chatDB.saveSessionWithMessages(session, messages);
                } else if (chatDB.db) {
                    await new Promise((resolve, reject) => {
                        const transaction = chatDB.db.transaction(['sessions', 'messages'], 'readwrite');
                        const sessionsStore = transaction.objectStore('sessions');
                        const messagesStore = transaction.objectStore('messages');

                        transaction.oncomplete = () => resolve();
                        transaction.onerror = () => reject(transaction.error);

                        sessionsStore.put(session);
                        messages.forEach(message => messagesStore.put(message));
                    });
                } else {
                    await chatDB.saveSession(session);
                    for (const message of messages) {
                        await chatDB.saveMessage(message);
                    }
                }
            } catch (error) {
                this.state.progress.errors += 1;
                this.state.progress.processed += 1;
                this.updateProgressUI();
                throw error;
            }

            if (sourceKey) {
                knownIds.add(sourceKey);
            }

            this._importedSessionIds.push(sessionId);
            this.state.progress.imported += 1;
            this.state.progress.processed += 1;
            this.updateProgressUI();

            if (index % 8 === 0) {
                await new Promise(requestAnimationFrame);
            }
        }
    }

    async generateImportedEmbeddings() {
        if (!sessionEmbedder.initialized) {
            await sessionEmbedder.init();
        }
        if (!keywordsGenerator.initialized) {
            await keywordsGenerator.init();
        }

        for (let index = 0; index < this._importedSessionIds.length; index += 1) {
            if (this.state.embeddingCancelRequested) {
                break;
            }
            const sessionId = this._importedSessionIds[index];

            try {
                const keywords = await keywordsGenerator.ensureSessionKeywords(sessionId, { force: true });
                if (keywords) {
                    this.state.embeddingProgress.keyworded += 1;
                }

                if (this.state.embeddingCancelRequested) {
                    break;
                }
                const embedded = await sessionEmbedder.embedSession(sessionId);
                if (embedded) {
                    this.state.embeddingProgress.embedded += 1;
                }
            } catch (error) {
                this.state.embeddingProgress.errors += 1;
                console.warn('[ChatHistoryImportModal] Failed embedding imported session:', sessionId, error);
            } finally {
                this.state.embeddingProgress.processed += 1;
                this.updateEmbeddingProgressUI();
            }

            if (index % 4 === 0) {
                await new Promise(requestAnimationFrame);
            }
        }
    }

    updateProgressUI() {
        if (!this.overlay) return;

        const { processed, total, imported, skipped, duplicates } = this.state.progress;
        const percent = total ? Math.round((processed / total) * 100) : 0;

        const fill = this.overlay.querySelector('#import-progress-fill');
        const text = this.overlay.querySelector('#import-progress-text');
        const importedEl = this.overlay.querySelector('#import-count');
        const skippedEl = this.overlay.querySelector('#skip-count');
        const dupEl = this.overlay.querySelector('#dup-count');

        if (fill) fill.style.width = `${percent}%`;
        if (text) text.textContent = `${processed} of ${total} sessions processed (${percent}%)`;
        if (importedEl) importedEl.textContent = `${imported}`;
        if (skippedEl) skippedEl.textContent = `${skipped}`;
        if (dupEl) dupEl.textContent = `${duplicates}`;
    }

    updateEmbeddingProgressUI() {
        if (!this.overlay) return;

        const { processed, total, embedded, keyworded, errors } = this.state.embeddingProgress;
        const percent = total ? Math.round((processed / total) * 100) : 0;

        const fill = this.overlay.querySelector('#embedding-progress-fill');
        const text = this.overlay.querySelector('#embedding-progress-text');
        const embeddedEl = this.overlay.querySelector('#embedding-count');
        const keywordEl = this.overlay.querySelector('#keyword-count');
        const errorEl = this.overlay.querySelector('#embedding-error-count');

        if (fill) fill.style.width = `${percent}%`;
        if (text) text.textContent = `${processed} of ${total} sessions processed (${percent}%)`;
        if (embeddedEl) embeddedEl.textContent = `${embedded}`;
        if (keywordEl) keywordEl.textContent = `${keyworded}`;
        if (errorEl) errorEl.textContent = `${errors}`;
    }

    async refreshSessionsFromDb() {
        await this.app.reloadSessions();
    }
}

export default ChatHistoryImportModal;
