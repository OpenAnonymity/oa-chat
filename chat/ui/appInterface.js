import { chatDB } from '../db.js';

function pickElements(source, keys) {
    const elements = {};
    for (const key of keys) {
        Object.defineProperty(elements, key, {
            enumerable: true,
            get: () => source.elements[key]
        });
    }
    return elements;
}

export function createComponentDataInterface(options = {}) {
    const db = options.chatDBImpl || chatDB;

    return {
        get hasImportedSessionKeyIndex() {
            return typeof db.collectImportedSessionKeys === 'function';
        },
        getSessionMessages: (sessionId) => db.getSessionMessages(sessionId),
        getAllSessions: () => db.getAllSessions(),
        async collectImportedSessionKeys(source) {
            if (typeof db.collectImportedSessionKeys === 'function') {
                return db.collectImportedSessionKeys(source);
            }

            const knownIds = new Set();
            const sessions = await db.getAllSessions();
            sessions.forEach(session => {
                if (session.importedSource && session.importedExternalId) {
                    knownIds.add(`${session.importedSource}:${session.importedExternalId}`);
                }
                if (session.importedFrom && session.importedFrom.startsWith(`${source}:`)) {
                    knownIds.add(session.importedFrom);
                }
            });
            return knownIds;
        },
        saveMessage: (message) => db.saveMessage(message),
        deleteMessage: (messageId) => db.deleteMessage(messageId),
        deleteSessionMessages: (sessionId) => db.deleteSessionMessages(sessionId),
        saveSession: (session) => db.saveSession(session),
        async saveSessionWithMessages(session, messages) {
            if (typeof db.saveSessionWithMessages === 'function') {
                await db.saveSessionWithMessages(session, messages);
                return;
            }

            if (db.db) {
                await new Promise((resolve, reject) => {
                    const transaction = db.db.transaction(['sessions', 'messages'], 'readwrite');
                    const sessionsStore = transaction.objectStore('sessions');
                    const messagesStore = transaction.objectStore('messages');

                    transaction.oncomplete = () => resolve();
                    transaction.onerror = () => reject(transaction.error);

                    sessionsStore.put(session);
                    messages.forEach(message => messagesStore.put(message));
                });
                return;
            }

            await db.saveSession(session);
            for (const message of messages) {
                await db.saveMessage(message);
            }
        },
        getSetting: (key) => db.getSetting(key),
        saveSetting: (key, value) => db.saveSetting(key, value)
    };
}

export function createComponentServicesInterface(options = {}) {
    return {
        ...options.services,
        presentation: options.presentation || null,
        tickets: options.ticketClientImpl || globalThis.ticketClient || null,
        networkLogger: options.networkLoggerImpl || globalThis.networkLogger || null,
        networkProxy: options.networkProxyImpl || globalThis.networkProxy || null,
        inference: options.inferenceServiceImpl || globalThis.inferenceService || null,
        verifier: options.verifierServiceImpl || globalThis.stationVerifier || null,
        share: options.shareServiceImpl || globalThis.shareService || null,
        account: options.accountServiceImpl || globalThis.accountService || null,
        sync: options.syncServiceImpl || globalThis.syncService || null
    };
}

export function createModelPickerInterface(app, options = {}) {
    const db = options.chatDBImpl || chatDB;
    const elements = pickElements(app, [
        'modelPickerBtn',
        'modelPickerModal',
        'closeModalBtn',
        'modelsList',
        'modelSearch',
        'modelListScrollArea',
        'messageInput'
    ]);

    return {
        elements,
        state: app.state,
        presentation: options.presentation || null,
        get reasoningEnabled() {
            return app.reasoningEnabled;
        },
        get cachedModelDisplayMetadata() {
            return app.cachedModelDisplayMetadata;
        },
        getCurrentSession: () => app.getCurrentSession(),
        getDefaultModelName: () => app.getDefaultModelName(),
        normalizeModelName: (modelName) => app.normalizeModelName(modelName),
        getPrimaryModelName: () => {
            if (app.chatInput?.getPrimaryModelName) {
                return app.chatInput.getPrimaryModelName();
            }
            const session = app.getCurrentSession();
            const rawModelName = session?.model || app.state.pendingModelName || null;
            return rawModelName ? (app.normalizeModelName(rawModelName) || rawModelName) : null;
        },
        getCouncilSecondaryModelName: () => app.chatInput?.getSelectedCouncilSecondaryModelName?.() || '',
        getCouncilSynthesisModelName: () => app.chatInput?.getCouncilSynthesisModelForSelection?.() || '',
        renderCurrentModel: () => app.renderCurrentModel(),
        refreshEditModelPickerButton: () => app.chatArea?.updateEditModelPickerButton?.(),
        actions: {
            async selectModel(modelName) {
                const normalizedModelName = app.normalizeModelName(modelName);
                const session = app.getCurrentSession();
                const reservation = session ? app.beginSessionMutation?.(session.id) : null;
                if (session && app.beginSessionMutation && !reservation) {
                    await app.acknowledgeSessionMutationBusy?.(session.id);
                    return { session, modelName: session.model, busy: true };
                }
                try {

                    await db.saveSetting('selectedModel', normalizedModelName);

                    if (!session) {
                        app.state.pendingModelName = normalizedModelName;
                        app.applyPersistedParallelPendingConfig?.(normalizedModelName);
                        app.renderCurrentModel();
                        return { session: null, modelName: normalizedModelName };
                    }

                    session.model = normalizedModelName;
                    await db.saveSession(session);
                    app.renderCurrentModel();
                    return { session, modelName: normalizedModelName };
                } finally {
                    if (reservation) app.endSessionMutation(session.id, reservation);
                }
            },
            async selectCouncilSecondaryModel(modelName) {
                const normalizedModelName = app.normalizeModelName(modelName);
                if (app.chatInput?.selectCouncilSecondaryModel) {
                    await app.chatInput.selectCouncilSecondaryModel(normalizedModelName);
                }
                return { session: app.getCurrentSession(), modelName: normalizedModelName };
            },
            async selectCouncilSynthesisModel(modelName) {
                const normalizedModelName = app.normalizeModelName(modelName);
                if (app.chatInput?.selectCouncilSynthesisModel) {
                    await app.chatInput.selectCouncilSynthesisModel(normalizedModelName);
                }
                return { session: app.getCurrentSession(), modelName: normalizedModelName };
            }
        }
    };
}

export function createSidebarInterface(app, options = {}) {
    const elements = pickElements(app, [
        'sessionsScrollArea',
        'sessionsList',
        'sidebar'
    ]);

    return {
        elements,
        state: app.state,
        presentation: options.presentation || null,
        get sessionSearchQuery() {
            return app.sessionSearchQuery;
        },
        getFilteredSessions: () => app.getFilteredSessions(),
        toggleSessionStar: (sessionId) => app.toggleSessionStar(sessionId),
        deleteSession: (sessionId) => app.deleteSession(sessionId),
        switchSession: (sessionId) => app.switchSession(sessionId),
        shareCurrentSession: () => app.shareCurrentSession(),
        copySessionLink: () => app.copySessionLink(),
        deleteCurrentSessionShare: () => app.deleteCurrentSessionShare(),
        exportChatToPdf: () => app.exportChatToPdf(),
        exportChatAsMarkdown: (sessionId) => app.exportChatAsMarkdown(sessionId),
        updateSessionTitle: (sessionId, title) => app.updateSessionTitle(sessionId, title),
        updateToolbarDivider: () => app.updateToolbarDivider(),
        hasActiveSessionListCriteria: () => app.hasActiveSessionListCriteria(),
        getSessionListEmptyText: () => app.getSessionListEmptyText()
    };
}

const COMPONENT_APP_KEYS = new Set([
    'accountModal',
    'acquireAndSetAccess',
    'acknowledgeSessionMutationBusy',
    'beginSessionMutation',
    'endSessionMutation',
    'isSessionDeleted',
    'stopSessionStreamingAndWait',
    'actions',
    'applySessionConversationSearchText',
    'cancelEditMode',
    'chatHistoryImportModal',
    'confirmEditPrompt',
    'continueLimitedResponse',
    'copySessionLink',
    'createSession',
    'captureActivePromptScrollAnchor',
    'data',
    'deleteCurrentSessionShare',
    'deleteSession',
    'detachStalePromptSlideUpEffect',
    'editingMessageId',
    'elements',
    'enterEditMode',
    'escapeHtml',
    'exportChatAsMarkdown',
    'exportChatToPdf',
    'fileUndoStack',
    'features',
    'floatingPanel',
    'forkConversation',
    'formatTime',
    'generateId',
    'getCurrentSession',
    'getCurrentSessionStreamingPhase',
    'getSessionPendingProgress',
    'getDefaultModelId',
    'getDefaultModelName',
    'getFallbackModelEntry',
    'getFilteredSessions',
    'getMessageTemplateOptions',
    'getPromptSlideUpMessageIdForSession',
    'getPendingCouncilConfig',
    'getSessionListEmptyText',
    'handleMemoryApprovalDecision',
    'handleEditFileUpload',
    'hasActiveSessionListCriteria',
    'hasTicketManagementAction',
    'inlineQuickAsk',
    'isCurrentSessionStreaming',
    'isElectronEnvironment',
    'memoryAgentModel',
    'memoryAutoInclude',
    'memoryEditor',
    'memoryFeatureEnabled',
    'memoryMode',
    'messageNavigation',
    'modelPicker',
    'normalizeModelName',
    'openTicketManagement',
    'processContentWithLatex',
    'pruneMemoryRetrievedContextFromMessage',
    'refreshExtensionSlot',
    'reasoningEffort',
    'reasoningEnabled',
    'regenerateCouncilLane',
    'regenerateResponse',
    'reloadSessions',
    'renderMessages',
    'resetMessageInputLayout',
    'restoreSessionScrollPosition',
    'restoreActivePromptScrollAnchor',
    'restorePromptSlideUpEffectForSession',
    'rightPanel',
    'saveCurrentSessionScrollPosition',
    'scrollChatAreaToBottomInstant',
    'scrubberPending',
    'searchEnabled',
    'services',
    'sendMessage',
    'sessionSearchQuery',
    'setMemoryAgentModel',
    'setMemoryAutoInclude',
    'setMemoryFeatureEnabled',
    'setCouncilModeForCurrentSession',
    'setPendingCouncilConfig',
    'setParallelDefaults',
    'shareCurrentSession',
    'shouldAutoScrollChat',
    'showLoadingToast',
    'showToast',
    'state',
    'stopCurrentSessionStreaming',
    'stopCurrentSessionStreamingAndWait',
    'switchSession',
    'toggleScrubberRestore',
    'toggleSessionStar',
    'removeEditAttachment',
    'updateEditDraftContent',
    'updateActivePromptScrollSpacer',
    'updateInputState',
    'updateScrollButtonVisibility',
    'updateSessionTitle',
    'updateToastPosition',
    'updateToolbarDivider'
]);

export function createComponentAppFacade(app, allowedKeys = COMPONENT_APP_KEYS, options = {}) {
    const extras = {
        integration: options.integration || null,
        data: createComponentDataInterface(options),
        services: createComponentServicesInterface(options)
    };

    return new Proxy({}, {
        get(_target, prop) {
            if (prop === '__appFacade') return true;
            if (prop === 'hasOwnProperty') {
                return (key) => allowedKeys.has(key);
            }
            if (Object.prototype.hasOwnProperty.call(extras, prop)) {
                return extras[prop];
            }
            if (!allowedKeys.has(prop)) {
                return undefined;
            }
            const value = app[prop];
            return typeof value === 'function' ? value.bind(app) : value;
        },
        set(_target, prop, value) {
            if (!allowedKeys.has(prop)) {
                throw new Error(`UI attempted to set unsupported app field: ${String(prop)}`);
            }
            app[prop] = value;
            return true;
        },
        has(_target, prop) {
            return allowedKeys.has(prop) || Object.prototype.hasOwnProperty.call(extras, prop);
        },
        ownKeys() {
            return Array.from(new Set([...allowedKeys, ...Object.keys(extras)]));
        },
        getOwnPropertyDescriptor(_target, prop) {
            if (!allowedKeys.has(prop) && !Object.prototype.hasOwnProperty.call(extras, prop)) return undefined;
            return {
                enumerable: true,
                configurable: true
            };
        }
    });
}

export function createVanillaUiInterface(app, options = {}) {
    const componentApp = createComponentAppFacade(app, COMPONENT_APP_KEYS, options);
    return {
        modelPicker: createModelPickerInterface(app, options),
        sidebar: createSidebarInterface(app, options),
        componentApp
    };
}
