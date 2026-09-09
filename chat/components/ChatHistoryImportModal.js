import {
    parseChatHistoryFile,
    buildImportPlan,
    getChatHistoryImporters,
    getChatHistoryImportAccept
} from '../services/chatHistoryImporters.js';

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
            parseError: null,
            lastError: null,
            confirmingCancel: false,
            cancelRequested: false
        };
    }

    /**
     * @param {{ returnTo?: 'account' | null }} [options] — where Back goes.
     * Opened from the Account dialog, the header gets a back arrow that
     * reopens it; the X always returns to the chat.
     */
    open(options = {}) {
        if (this.isOpen) return;
        this.isOpen = true;
        this.returnTo = options.returnTo || null;
        this.state = this.getInitialState();

        document.querySelector('.chat-history-import-modal')?.remove();

        this.overlay = document.createElement('div');
        this.overlay.className = 'chat-history-import-modal fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in';

        this.render();
        document.body.appendChild(this.overlay);
        this.setupEventListeners();
    }

    close({ back = false } = {}) {
        if (!this.isOpen) return;
        if (this.state.step === 'importing' && !this.state.cancelRequested) {
            this.requestCancel();
            return;
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
        const returnTo = this.returnTo;
        this.returnTo = null;
        if (back && returnTo === 'account') this.app.settingsDialog?.open?.();
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
        const sourceName = label => String(label || '').replace(/\s*\(export\)$/i, '');
        const counts = items => `
                <div class="import-counts">
                    ${items.map(([name, value]) => `<div class="import-count"><span>${name}</span><strong>${value}</strong></div>`).join('')}
                </div>`;
        if (step === 'select') {
            const rows = visibleImporters.map(entry => {
                const ready = entry.enabled !== false;
                return `
                <div class="settings-row">
                    <span class="settings-row-label">${sourceName(entry.label)}</span>
                    <div class="settings-row-control">
                        ${ready
                            ? `<button type="button" class="settings-text-action" data-import-pick data-tooltip="${entry.fileHint && entry.fileHint.length < 40 ? `Choose ${entry.fileHint}` : 'Choose the export file'}">Choose file</button>`
                            : '<span class="import-soon">Coming soon</span>'}
                    </div>
                </div>`;
            }).join('');
            bodyHtml = `
                <section class="settings-section">
                    ${rows}
                    <details class="import-howto">
                        <summary>How to get your ChatGPT export</summary>
                        <ol>
                            <li>Open ChatGPT Settings, then Data controls.</li>
                            <li>Choose "Export data" and confirm by email.</li>
                            <li>Download and unzip the archive, then choose <code>conversations.json</code>.</li>
                        </ol>
                    </details>
                    ${parseError ? `<p class="import-error" role="alert">${parseError}</p>` : ''}
                </section>
            `;
        } else if (step === 'parsing') {
            bodyHtml = `
                <section class="settings-section">
                    <div class="settings-row"><span class="settings-row-label">Reading ${fileInfo}</span><span class="import-spinner" aria-hidden="true"></span></div>
                </section>
            `;
        } else if (step === 'preview') {
            bodyHtml = `
                <section class="settings-section">
                    <div class="settings-row"><span class="settings-row-label">${detectedLabel}</span><span class="import-soon">${fileInfo}</span></div>
                    ${counts([
                        ['Chats', preview?.importableSessions ?? preview?.sessionCount ?? 0],
                        ['Messages', preview?.messageCount || 0],
                        ['Media placeholders', preview?.mediaMessages || 0]
                    ])}
                </section>
                <section class="settings-section import-actions">
                    <button type="button" id="chat-import-pick-file" class="settings-text-action">Choose another file</button>
                    <button type="button" id="chat-import-start" class="settings-button settings-button-primary">Import</button>
                </section>
            `;
        } else if (step === 'importing') {
            const progressPercent = progress.total ? Math.round((progress.processed / progress.total) * 100) : 0;
            bodyHtml = `
                <section class="settings-section">
                    <div class="settings-row"><span class="settings-row-label">Importing</span><span id="import-progress-text" class="import-soon">${progress.processed} of ${progress.total}</span></div>
                    <div class="import-progress"><div id="import-progress-fill" style="width: ${progressPercent}%"></div></div>
                    ${counts([['Imported', `<span id="import-count">${progress.imported}</span>`], ['Skipped', `<span id="skip-count">${progress.skipped}</span>`], ['Duplicates', `<span id="dup-count">${progress.duplicates}</span>`]])}
                    ${cancelRequested ? '<p class="import-note">Stopping after the current chat.</p>' : ''}
                </section>
                <section class="settings-section import-actions">
                    ${confirmingCancel ? `
                        <span class="import-note">Stop the import? Chats already imported stay.</span>
                        <span class="import-actions-group">
                            <button type="button" id="chat-import-keep" class="settings-text-action">Keep going</button>
                            <button type="button" id="chat-import-confirm-cancel" class="settings-button settings-button-danger">Stop</button>
                        </span>
                    ` : `
                        <span></span>
                        <button type="button" id="chat-import-cancel" class="settings-button">Cancel</button>
                    `}
                </section>
            `;
        } else if (step === 'complete' || step === 'cancelled' || step === 'error') {
            const heading = step === 'complete' ? 'Import complete' : step === 'cancelled' ? 'Import stopped' : 'Import failed';
            bodyHtml = `
                <section class="settings-section">
                    <div class="settings-row"><span class="settings-row-label">${heading}</span></div>
                    ${counts([['Imported', progress.imported], ['Skipped', progress.skipped], ['Duplicates', progress.duplicates]])}
                    ${lastError ? `<p class="import-error" role="alert">${lastError}</p>` : ''}
                </section>
                <section class="settings-section import-actions">
                    <span></span>
                    <button type="button" id="chat-import-done" class="settings-button settings-button-primary">Done</button>
                </section>
            `;
        }

        const backButton = this.returnTo === 'account' ? `
                    <button type="button" id="chat-import-back" class="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-accent import-back" aria-label="Back to account">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.7" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"></path>
                        </svg>
                    </button>` : '';
        this.overlay.innerHTML = `
            <div role="dialog" aria-modal="true" aria-labelledby="chat-import-title" tabindex="-1" class="settings-dialog settings-panel">
                <header class="settings-dialog-head import-head${backButton ? ' has-back' : ''}">
                    ${backButton}
                    <h2 id="chat-import-title" class="account-dialog-title">Import chat history</h2>
                    <button type="button" id="chat-import-close" class="text-muted-foreground hover:text-foreground transition-colors p-1 -mr-1 rounded-lg hover:bg-accent" aria-label="Close">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </header>
                <input id="chat-import-input" type="file" class="hidden" accept="${acceptTypes}">
                ${bodyHtml}
            </div>
        `;
    }

    setupEventListeners() {
        if (!this.overlay) return;

        const closeBtn = this.overlay.querySelector('#chat-import-close');
        const backBtn = this.overlay.querySelector('#chat-import-back');
        const pickFileBtn = this.overlay.querySelector('#chat-import-pick-file');
        const rowPickBtns = [...this.overlay.querySelectorAll('[data-import-pick]')];
        const fileInput = this.overlay.querySelector('#chat-import-input');
        const startBtn = this.overlay.querySelector('#chat-import-start');
        const cancelBtn = this.overlay.querySelector('#chat-import-cancel');
        const keepBtn = this.overlay.querySelector('#chat-import-keep');
        const confirmCancelBtn = this.overlay.querySelector('#chat-import-confirm-cancel');
        const doneBtn = this.overlay.querySelector('#chat-import-done');

        if (closeBtn) {
            closeBtn.onclick = () => this.close();
        }
        if (backBtn) {
            backBtn.onclick = () => this.close({ back: true });
        }
        this.overlay.querySelector('[role="dialog"]')?.focus?.({ preventScroll: true });

        this.overlay.onclick = (e) => {
            if (e.target === this.overlay) this.close();
        };

        pickFileBtn?.addEventListener('click', () => fileInput?.click());
        rowPickBtns.forEach(button => button.addEventListener('click', () => fileInput?.click()));
        fileInput?.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (file) {
                this.handleFileSelected(file);
                fileInput.value = '';
            }
        });

        startBtn?.addEventListener('click', () => this.startImport());
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
        this.state.confirmingCancel = false;
        this.state.cancelRequested = false;
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

        await this.refreshSessionsFromDb();
        this.render();
        this.setupEventListeners();
    }

    async importSessions() {
        const importer = this.state.importer;
        const source = this.state.importerSource || importer?.source || 'imported';
        const getExternalId = typeof importer?.getExternalId === 'function'
            ? importer.getExternalId.bind(importer)
            : (session) => session.sourceId || null;

        const knownIds = await this.app.data.collectImportedSessionKeys(source);
        let existingSessions = null;

        if (source === 'oa-chat' || source === 'oa-fastchat') {
            const oaAliases = ['oa-chat', 'oa-fastchat'];
            if (this.app.data.hasImportedSessionKeyIndex) {
                for (const aliasSource of oaAliases) {
                    if (aliasSource === source) continue;
                    const aliasKeys = await this.app.data.collectImportedSessionKeys(aliasSource);
                    aliasKeys.forEach(key => {
                        knownIds.add(key);
                        const prefix = `${aliasSource}:`;
                        if (key.startsWith(prefix)) {
                            knownIds.add(`${source}:${key.slice(prefix.length)}`);
                        }
                    });
                }
            }

            if (!existingSessions) {
                existingSessions = await this.app.data.getAllSessions();
            }
            existingSessions.forEach(session => {
                const candidateIds = [];
                if (session?.id) {
                    candidateIds.push(session.id);
                }
                if (session?.importedExternalId) {
                    candidateIds.push(session.importedExternalId);
                }
                candidateIds.forEach(candidateId => {
                    oaAliases.forEach(aliasSource => {
                        knownIds.add(`${aliasSource}:${candidateId}`);
                    });
                });
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
                apiKey: null,
                apiKeyInfo: null,
                expiresAt: null,
                searchEnabled: this.app.searchEnabled,
                importedSource: source,
                importedExternalId: externalId,
                importedAt: Date.now(),
                importedMessageCount: messages.length
            };
            if (typeof this.app.applySessionConversationSearchText === 'function') {
                this.app.applySessionConversationSearchText(session, messages);
            }

            try {
                await this.app.data.saveSessionWithMessages(session, messages);
            } catch (error) {
                this.state.progress.errors += 1;
                this.state.progress.processed += 1;
                this.updateProgressUI();
                throw error;
            }

            if (sourceKey) {
                knownIds.add(sourceKey);
            }

            this.state.progress.imported += 1;
            this.state.progress.processed += 1;
            this.updateProgressUI();

            if (index % 8 === 0) {
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

    async refreshSessionsFromDb() {
        await this.app.reloadSessions();
    }
}

export default ChatHistoryImportModal;
