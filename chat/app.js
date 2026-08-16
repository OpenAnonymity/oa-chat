// Main application logic
import themeManager from './services/themeManager.js';
import preferencesStore, { PREF_KEYS } from './services/preferencesStore.js';
import storageManager from './services/storageManager.js';
import storageEvents from './services/storageEvents.js';
import { getFileIconSvg } from './services/fileUtils.js';
import { exportChats, exportTickets } from './services/globalExport.js';
import { parseReasoningContent } from './services/reasoningParser.js';
import { DEFAULT_REASONING_EFFORT, normalizeReasoningEffort } from './services/reasoningConfig.js';
import { fetchUrlMetadata } from './services/urlMetadata.js';
import { resolveProvider, resolveProviderFromModelReference } from './services/providerRegistry.js';
import networkProxy from './services/networkProxy.js';
import inferenceService from './services/inference/inferenceService.js';
import ticketClient from './services/ticketClient.js';
import scrubberService from './services/scrubberService.js';
import {
    augmentQuery as runMemoryAugmentQuery,
    augmentQueryAdaptive as runMemoryAugmentQueryAdaptive,
    CONFIDENTIAL_KEY_TICKETS,
    ensureMemoryKey,
    ingestMessages as ingestMemoryMessages,
    invalidateMemoryKey,
    isMemoryAuthError,
    stripMemoryPromptUserData
} from './services/memoryBridge.js';
import shareService from './services/shareService.js';
import { getTicketCost, initModelTiers } from './services/modelTiers.js';
import { initPinnedModels, onPinnedModelsUpdate, getDefaultModelConfig, getDisabledModels, getPinnedModels, getStandardizedModelDisplayName } from './services/modelConfig.js';
import accountService from './services/accountService.js';
import apiKeyStore from './services/apiKeyStore.js';
import { generateUlid21 } from './services/ulid.js';
import { chatDB } from './db.js';
import { DEFAULT_MEMORY_AGENT_MODEL, isAllowedConfidentialModel } from './services/confidentialModelConfig.js';
import { normalizeMessagesForMemory } from './services/memoryMessageNormalization.js';
import { normalizeMemoryRetrievalAssessment } from './services/memoryRetrievalAssessment.js';
import {
    createMemoryRetrievalFailure,
    isExplicitMemoryRetrievalCancellation
} from './services/memoryRetrievalError.js';
import {
    buildLocalSessionTitle as buildLocalSessionTitleText,
    buildForkSessionTitleFields as buildForkSessionTitleFieldsValue,
    buildSessionTitleSearchText as buildSessionTitleSearchTextValue,
    normalizeSessionSearchText as normalizeSessionSearchTextValue,
    getSearchableMessageText as getSearchableMessageTextValue,
    buildSessionConversationSearchText as buildSessionConversationSearchTextValue,
    buildSessionSearchIndexFields as buildSessionSearchIndexFieldsValue,
    cleanGeneratedSessionTitle as cleanGeneratedSessionTitleText
} from './domain/sessionSearch.js';
import {
    getMessageTextContent as getMessageTextContentValue,
    processMessagesForApi
} from './domain/messageContent.js';
import {
    buildQuickAskMessages,
    buildQuickAskQuestion,
    normalizeQuickAskSelection
} from './domain/quickAsk.js';
import { normalizePendingPhase as normalizeStreamingPendingPhase } from './domain/streamingState.js';
import {
    filterDisabledModels as filterDisabledModelsValue,
    getFallbackModelEntry as getFallbackModelEntryValue,
    normalizeModelName as normalizeModelNameValue,
    resolveDefaultModelPreferenceUpdate as resolveDefaultModelPreferenceUpdateValue,
    upgradeDefaultModelPreference as upgradeDefaultModelPreferenceValue
} from './domain/modelSelection.js';
import {
    resolveMemoryFeatureState as resolveMemoryFeatureStateValue,
    resolveMemoryFeatureToggle as resolveMemoryFeatureToggleValue
} from './domain/memorySettings.js';
import {
    acquireSessionAccess,
    buildVerifierSubmitKeyProof as buildVerifierSubmitKeyProofValue,
    isAccessCreditExhaustedError as isAccessCreditExhaustedErrorValue,
    persistVerifierSubmitKeyProof as persistVerifierSubmitKeyProofValue
} from './application/accessController.js';
import CouncilController from './application/councilController.js';
import { hasExplicitVerifierApprovalForAccessInfo } from './services/inference/verifiedAccess.js';
import { prepareEntitlementBatch } from './application/entitlementTicketPreparer.js';
import { ExtensionHost } from './extensions/extensionHost.js';
import { toExtensionAccountSnapshot } from './extensions/extensionAccountSnapshot.js';
import { COUNCIL_MODE_FEATURE_FLAG } from './config.js';
import {
    RESPONSE_MODE_SINGLE,
    RESPONSE_MODE_COUNCIL,
    COUNCIL_OUTPUT_PARALLEL,
    COUNCIL_OUTPUT_SYNTHESIS,
    buildDefaultCouncilConfig,
    normalizeResponseMode,
    normalizeCouncilOutputMode,
    normalizeCouncilConfig,
    areCouncilConfigsEqual
} from './domain/councilConfig.js';
import VanillaChatUi from './ui/vanilla/VanillaChatUi.js';

const SESSION_PAGE_SIZE = 80;
const SESSION_SEARCH_LIMIT = 300;
const SESSION_SCROLL_LOAD_THRESHOLD = 160;
const SESSION_SEARCH_DEBOUNCE = 180;  // ms wait before triggering search
const SESSION_CONTENT_SEARCH_MAX_CHARS = 12000;
const SESSION_CONTENT_SEARCH_MESSAGE_MAX_CHARS = 2000;
const MEMORY_CONTEXT_MAX_ENTRIES = 16;
const MEMORY_CONTEXT_MAX_CHARS = 12000;
const MEMORY_CONTEXT_PROMPT_MAX_CHARS = 9000;
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const UPDATE_CHECK_INITIAL_DELAY_MS = 45 * 1000;
const SESSION_TITLE_MAX_LENGTH = 60;
const SESSION_TITLE_FALLBACK_LENGTH = 50;

// Layout constants for toolbar overlay prediction
const SIDEBAR_WIDTH = 220;      // Default sidebar width = minimum width
const RIGHT_PANEL_WIDTH = 288;  // 18rem = 288px
const TOOLBAR_PREDICTION_GRACE_MS = 350; // Grace period to respect predicted state during animations
const SIDEBAR_CLOSE_DURATION_MS = 220;

// Used to upgrade users who were implicitly on the prior default.
const PREVIOUS_DEFAULT_MODEL_NAMES = [
    'OpenAI: GPT-5.2 Instant',
    'OpenAI: GPT-5.1 Instant'
];

function generateSessionId() {
    return generateUlid21();
}

function emitDesktopEvent(name, detail = {}) {
    if (typeof window === 'undefined') return;
    if (typeof window.dispatchEvent !== 'function') return;
    if (typeof CustomEvent !== 'function') return;
    try {
        window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (err) {
        // No-op: desktop hooks should never break web behavior.
    }
}
const SESSION_STORAGE_KEY = 'oa-current-session'; // Tab-scoped session persistence
const DELETE_HISTORY_COPY = {
    title: 'Delete all chat history',
    body: 'Past chat history is stored locally on this browser. Prompts and responses are end-to-end encrypted to and from the model providers who only see mixed and unlinkable traffic.',
    highlightHeading: 'Deletion is irreversible!',
    highlightBody: 'This is the only copy of your chat history. Deletion cannot be undone. You can <a href="#download-chats-link" class="text-primary underline-offset-2 hover:underline focus-visible:underline dark:text-blue-300">download a copy</a> of your chat history before proceeding.',
    cancelLabel: 'Cancel',
    confirmLabel: 'Delete everything'
};

/**
 * ChatApp - Main application controller
 * Manages application state, coordinates UI components, and handles business logic.
 */
class ChatApp {
    constructor(options = {}) {
        this.state = {
            sessions: [],
            sessionsById: new Map(),
            sessionsPageCursor: null,
            hasMoreSessions: true,
            isLoadingSessions: false,
            sessionSearchResults: null,
            sessionSearchResultsQuery: '',
            sessionSearchResultsKey: '',
            sessionSearchPending: false,
            currentSessionId: null,
            models: [],
            modelsLoading: false,
            modelsVersion: 0,
            pendingModelName: null // Model selected before session is created (display name)
        };
        this.cachedModelDisplayMetadata = [];

        this.elements = {
            newChatBtn: document.getElementById('new-chat-btn'),
            sessionsList: document.getElementById('sessions-list'),
            searchRoomsInput: document.getElementById('search-rooms'),
            sidebarFilterBtn: document.getElementById('sidebar-filter-btn'),
            sidebarFilterMenu: document.getElementById('sidebar-filter-menu'),
            sidebarFilterRangeSelect: document.getElementById('sidebar-filter-range'),
            sidebarFilterDateInput: document.getElementById('sidebar-filter-date'),
            clearSidebarFiltersBtn: document.getElementById('clear-sidebar-filters'),
            chatArea: document.getElementById('chat-area'),
            messagesContainer: document.getElementById('messages-container'),
            messageInput: document.getElementById('message-input'),
            inputCard: document.getElementById('input-card'),
            scrubberPreviewDiff: document.getElementById('scrubber-preview-diff'),
            sendBtn: document.getElementById('send-btn'),
            composerMoreMenu: document.getElementById('composer-more-menu'),
            modelPickerBtn: document.getElementById('model-picker-btn'),
            councilInlineModels: document.getElementById('council-inline-models'),
            councilSecondaryInlineSelect: document.getElementById('council-secondary-inline-select'),
            modelPickerModal: document.getElementById('model-picker-modal'),
            closeModalBtn: document.getElementById('close-modal-btn'),
            modelsList: document.getElementById('models-list'),
            modelSearch: document.getElementById('model-search'),
            settingsBtn: document.getElementById('settings-btn'),
            settingsMenu: document.getElementById('settings-menu'),
            searchToggle: document.getElementById('search-toggle'),
            memoryToggle: document.getElementById('chat-mode-toggle'),
            memoryContextToggle: document.getElementById('memory-context-toggle'),
            toggleRightPanelBtn: document.getElementById('toggle-right-panel-btn'), // This might be legacy, but let's keep it for now.
            showRightPanelBtn: document.getElementById('show-right-panel-btn'),
            shareBtn: document.getElementById('share-btn'),
            shareBtnText: document.getElementById('share-btn-text'),
            wideModeBtn: document.getElementById('wide-mode-btn'),
            sidebar: document.getElementById('sidebar'),
            hideSidebarBtn: document.getElementById('hide-sidebar-btn'),
            showSidebarBtn: document.getElementById('show-sidebar-btn'),
            mobileSidebarBackdrop: document.getElementById('mobile-sidebar-backdrop'),
            sessionsScrollArea: document.getElementById('sessions-scroll-area'),
            modelListScrollArea: document.getElementById('model-list-scroll-area'),
            themeToggle: document.getElementById('theme-toggle'),
            themeOptionButtons: Array.from(document.querySelectorAll('[data-theme-option]')),
            themeEffectiveLabel: document.getElementById('theme-effective-label'),
            fileUploadBtn: document.getElementById('file-upload-btn'),
            fileUploadInput: document.getElementById('file-upload-input'),
            filePreviewsContainer: document.getElementById('file-previews-container'),
            fileCountBadge: document.getElementById('file-count-badge'),
            deleteHistoryBtn: document.getElementById('delete-history-btn'),
            deleteHistoryModal: document.getElementById('delete-history-modal'),
            deleteHistoryConfirmBtn: null,
            deleteHistoryCancelBtn: null,
            dropZoneOverlay: document.getElementById('drop-zone-overlay'),
        };

        this.searchEnabled = true;
        this.memoryFeatureEnabled = true;
        this.memoryMode = false;
        this.memoryAutoInclude = false;
        this.memoryAgentModel = DEFAULT_MEMORY_AGENT_MODEL;
        this.reasoningEnabled = true;
        this.reasoningEffort = DEFAULT_REASONING_EFFORT;
        this.sessionSearchQuery = '';
        this.sessionSearchDebounce = null;
        this.sessionSearchRequestId = 0;
        this.dbReadyPromise = Promise.resolve(null);
        this.eventListenersAttached = false;
        this.sessionFilters = {
            starredOnly: false,
            dateMode: 'all',
            customDate: ''
        };
        this.sidebarFilterControlsAttached = false;
        this.uploadedFiles = [];
        this.fileUndoStack = []; // Track file paste operations for undo
        this.filePreviewRenderVersion = 0; // Guard async preview renders against stale overwrites
        this.rightPanel = null;
        this.floatingPanel = null;
        this.messageNavigation = null;
        this.ui = null;
        this.sidebar = null;
        this.chatArea = null;
        this.chatInput = null;
        this.modelPicker = null;
        this.memoryEditor = null;
        this.sessionStreamingStates = new Map(); // Track streaming state per session
        this.accessAcquisitionInFlight = new Map(); // backend/session/model -> shared access acquisition
        this.sessionScrollPositions = new Map(); // Track scrollTop per session in-memory
        this.sessionChatbarStates = new Map(); // Track in-tab chatbar drafts per session
        this.chatScrollSaveFrame = null;
        this.isAutoScrollPaused = false; // Track if auto-scroll is paused during streaming
        this.activePromptScroll = null; // Tracks the visible prompt's temporary scroll runway
        this.sessionPromptScrollAnchors = new Map(); // Keeps prompt-slide anchors across session switches
        this.scrollToBottomButton = null; // Reference to the floating scroll-to-bottom button
        this.scrollButtonCheckInterval = null; // Interval for checking button visibility during streaming
        this.scrubberService = scrubberService;
        this.scrubberPending = null;
        this.memoryApprovalRequests = new Map();
        this.memoryExtractionInFlight = new Set();
        this.memoryExtractionAbortControllers = new Map();
        this.memoryAugmentAbortControllers = new Set();
        this.memoryWorkGeneration = 0;
        this._lastApiContent = null;
        this._lastApiContentGeneration = null;
        this.parallelModeEnabled = false;
        this.parallelSecondaryModel = null;
        this.parallelSynthesisModel = null;
        this.parallelOutputMode = COUNCIL_OUTPUT_PARALLEL;
        this.deleteHistoryReturnFocusEl = null;
        this.isDeletingAllChats = false;
        this.appVersionSignature = null;
        this.updateAvailableSignature = null;
        this.updateToastVisible = false;
        this.updateToastDismissed = false;
        this.updateCheckInterval = null;
        this.updateCheckInFlight = false;
        this.pendingStorageRefresh = false;
        this.storageReloadTimer = null;
        this.pendingModelAvailabilityRefresh = false;
        this.pendingTicketCode = null;
        this.pendingCouncilConfig = null;
        this.pendingCouncilLayoutPreference = false;
        this.hasInitialLinkContext = this.detectInitialLinkContext();
        this.splitCodeWarningOverlay = null;
        this.councilController = new CouncilController({
            app: this,
            chatDB,
            inferenceService,
            ticketClient
        });
        this.extensions = Array.isArray(options.extensions) ? options.extensions : [];
        this.extensionHost = new ExtensionHost();
        this.extensionSlots = this.extensionHost.slots;

        // Link preview state
        this.linkPreviewCard = document.getElementById('link-preview-card');
        this.linkPreviewTimeout = null;
        this.linkPreviewHideTimeout = null;
        this.currentPreviewLink = null;
        this.isHoveringPreviewCard = false;

        // Edit mode state
        this.editingMessageId = null; // Track which message is being edited
        this.editDrafts = new Map(); // messageId -> { content, files } for side-effect-free prompt edits

        this.ready = this.init();
    }

    async resolveExtensionAuthContext() {
        await accountService.init();
        let state = accountService.getState();
        if (!state?.accountId) {
            const error = new Error('An account is required.');
            error.code = 'ACCOUNT_AUTH_REQUIRED';
            throw error;
        }
        if (
            state.sessionVerified !== true ||
            state.status !== 'unlocked' ||
            state.accountScopeReady !== true
        ) {
            const error = new Error('Unlock the account before using account services.');
            error.code = 'ACCOUNT_AUTH_REQUIRED';
            throw error;
        }

        let token = accountService.getAccessToken();
        if (!token) {
            await accountService.refreshAccessToken().catch(() => false);
            state = accountService.getState();
            token = accountService.getAccessToken();
        }
        if (
            !token ||
            !state?.accountId ||
            state.sessionVerified !== true ||
            state.status !== 'unlocked' ||
            state.accountScopeReady !== true
        ) {
            const error = new Error('The account session is unavailable or expired.');
            error.code = 'ACCOUNT_AUTH_REQUIRED';
            throw error;
        }
        return Object.freeze({
            scope: `account:${state.accountId}`,
            headers: Object.freeze({ Authorization: `Bearer ${token}` })
        });
    }

    createExtensionContext() {
        const getAccountSnapshot = () => toExtensionAccountSnapshot(accountService.getState());
        return Object.freeze({
            slots: Object.freeze({
                mount: (name, element) => this.extensionSlots.mount(name, element)
            }),
            account: Object.freeze({
                getSnapshot: getAccountSnapshot,
                subscribe: (listener) => typeof listener === 'function'
                    ? accountService.subscribe(() => listener(getAccountSnapshot()))
                    : (() => {}),
                resolveAuthContext: () => this.resolveExtensionAuthContext()
            }),
            tickets: Object.freeze({
                prepareEntitlementBatch: (options) => prepareEntitlementBatch(options),
                getToolsSnapshot: () => this.rightPanel?.getMembershipTicketToolsSnapshot?.() ||
                    Object.freeze({ ticketCount: 0, maxShareCount: 0, busy: false }),
                importTickets: (file) => this.rightPanel?.handleImportTickets?.(
                    file,
                    null,
                    { throwOnError: true }
                ),
                exportTickets: () => this.rightPanel?.handleExportTickets?.({ throwOnError: true }),
                shareTickets: (count) => this.rightPanel?.splitTicketsForMembership?.(count),
                redeemAccessCode: (code, onProgress) => this.rightPanel?.handleRegister?.(
                    this.rightPanel.normalizeInvitationCode(code),
                    { throwOnError: true, onProgress }
                )
            }),
            ui: Object.freeze({
                openAccount: () => this.accountModal?.open?.(),
                getAccountMenuReturnTarget: () => this.accountModal?.getAccountMenuReturnTarget?.() || null,
                showToast: (...args) => this.showToast(...args)
            })
        });
    }

    detectInitialLinkContext() {
        try {
            const url = new URL(window.location.href);
            if (/^\/tickets\/[^/?#]+/i.test(url.pathname)) {
                return true;
            }

            const params = url.searchParams;
            return params.has('tickets') || params.has('sharing') || params.has('s');
        } catch (error) {
            return false;
        }
    }

    getDefaultModelId() {
        const session = this.getCurrentSession();
        const fallbackModel = this.getFallbackModelEntry(session);
        return fallbackModel?.id || inferenceService.getDefaultModelId(session);
    }

    getDefaultModelName() {
        const session = this.getCurrentSession();
        const fallbackModel = this.getFallbackModelEntry(session);
        return fallbackModel?.name || inferenceService.getDefaultModelName(session);
    }

    getDisabledModelSet() {
        return new Set(getDisabledModels());
    }

    filterDisabledModels(models) {
        return filterDisabledModelsValue(models, this.getDisabledModelSet());
    }

    getFallbackModelEntry(session) {
        const usePinnedDefaults = !session?.inferenceBackend ||
            session.inferenceBackend === inferenceService.getDefaultBackendId();
        return getFallbackModelEntryValue(
            this.state.models,
            inferenceService.getDefaultModelId(session),
            usePinnedDefaults ? getPinnedModels() : []
        );
    }

    applyDisabledModelFilter() {
        const previousModels = Array.isArray(this.state.models) ? this.state.models : [];
        const previousIds = previousModels.map(model => model.id).join('|');
        const filteredModels = this.filterDisabledModels(previousModels);
        const filteredIds = filteredModels.map(model => model.id).join('|');

        const changed = previousIds !== filteredIds;
        if (!changed) {
            return false;
        }

        this.state.models = filteredModels;
        this.state.modelsVersion += 1;

        if (this.modelPicker) {
            if (!this.elements.modelPickerModal.classList.contains('hidden')) {
                this.modelPicker.renderModels(this.elements.modelSearch?.value || '');
            } else {
                this.modelPicker.warmRender();
            }
        }

        this.renderCurrentModel();
        return true;
    }

    async refreshModelsForAvailabilityUpdate() {
        if (this.state.modelsLoading) {
            this.pendingModelAvailabilityRefresh = true;
            return;
        }

        try {
            await this.loadModels();
            this.applyDisabledModelFilter();
            await this.refreshDefaultModelPreferenceForAvailabilityUpdate();
            this.renderCurrentModel();
            if (this.modelPicker) {
                if (!this.elements.modelPickerModal.classList.contains('hidden')) {
                    this.modelPicker.renderModels(this.elements.modelSearch?.value || '');
                } else {
                    this.modelPicker.warmRender();
                }
            }
        } catch (error) {
            console.warn('Failed to refresh models after availability update:', error);
            this.applyDisabledModelFilter();
        }

        if (this.pendingModelAvailabilityRefresh) {
            this.pendingModelAvailabilityRefresh = false;
            await this.refreshModelsForAvailabilityUpdate();
        }
    }

    attachDownloadLinkHandler(rootEl) {
        if (!rootEl) return;

        const downloadLink = rootEl.querySelector('a[href="#download-chats-link"]');
        if (!downloadLink || downloadLink.dataset.downloadChatsBound === 'true') {
            return;
        }

        downloadLink.dataset.downloadChatsBound = 'true';
        downloadLink.addEventListener('click', async (event) => {
            event.preventDefault();
            try {
                const success = await exportChats();
                if (!success) {
                    console.error('Failed to download chat history from modal link');
                }
            } catch (error) {
                console.error('Error downloading chat history from modal link:', error);
            }
        });
    }

    /**
     * Adds images to an array while deduplicating by data URL.
     * Prevents the same image from being added multiple times when it arrives
     * through different channels (e.g., delta.images and reasoning_details).
     * @param {Array} existingImages - The existing images array (will be modified)
     * @param {Array} newImages - New images to add
     */
    /**
     * Adds images to an array while detecting near-duplicates.
     *
     * Problem: Image generation models (e.g., Gemini via inference backend) sometimes stream
     * the same image multiple times with minor encoding differences (~0.01% size variance).
     * These appear as visually identical images but have slightly different base64 data.
     *
     * Solution: Detect near-duplicates using two combined signals:
     * 1. Header match - First 100 chars of base64 (image format + early metadata)
     * 2. Size similarity - Within 1% of each other (same content, minor compression variance)
     *
     * This approach:
     * - Catches near-duplicates (same visual content, different encoding)
     * - Allows genuinely different images through (different headers or sizes)
     * - No hard cap on image count for multi-image responses
     *
     * @param {Array} existingImages - The existing images array (will be modified)
     * @param {Array} newImages - New images to add
     */
    addImagesWithDedup(existingImages, newImages) {
        if (!newImages || newImages.length === 0) return;

        // Extract header (first 100 chars of base64 data) for format/metadata comparison
        const getHeader = (url) => {
            if (!url) return null;
            const base64Start = url.indexOf('base64,');
            return base64Start === -1 ? url.substring(0, 100) : url.substring(base64Start, base64Start + 107);
        };

        // Two images are near-duplicates if headers match AND sizes are within 1%
        const isNearDuplicate = (newUrl, existingUrl) => {
            if (!newUrl || !existingUrl) return false;
            const newHeader = getHeader(newUrl);
            const existingHeader = getHeader(existingUrl);
            if (newHeader !== existingHeader) return false;
            const sizeDiff = Math.abs(newUrl.length - existingUrl.length);
            const maxSize = Math.max(newUrl.length, existingUrl.length);
            return sizeDiff / maxSize < 0.01;
        };

        for (const img of newImages) {
            const url = img.image_url?.url;
            if (!url) continue;
            const isDupe = existingImages.some(existing => isNearDuplicate(url, existing.image_url?.url));
            if (!isDupe) {
                existingImages.push(img);
            }
        }
    }

    /**
     * Configure marked.js with custom renderer for code blocks
     * Adds language label and copy button to fenced code blocks
     */
    configureMarkedRenderer() {
        const renderer = new marked.Renderer();
        const escapeHtml = this.escapeHtml.bind(this);
        const escapeHtmlAttribute = this.escapeHtmlAttribute.bind(this);
        const sanitizeUrl = this.sanitizeUrl.bind(this);

        // Custom code block renderer with header (language + copy button)
        renderer.code = (code, language) => {
            const infoString = typeof language === 'string' ? language.trim() : '';
            const lang = infoString.match(/^\S+/)?.[0] || '';
            const displayLang = lang ? this.formatLanguageName(lang) : '';

            // Apply syntax highlighting if available
            let highlightedCode = code;
            if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
                try {
                    highlightedCode = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
                } catch (e) {
                    highlightedCode = this.escapeHtml(code);
                }
            } else if (typeof hljs !== 'undefined') {
                // Auto-detect language
                try {
                    highlightedCode = hljs.highlightAuto(code).value;
                } catch (e) {
                    highlightedCode = this.escapeHtml(code);
                }
            } else {
                highlightedCode = this.escapeHtml(code);
            }

            // Compact HTML to avoid whitespace text nodes inside flex containers
            // which can create anonymous flex items and cause layout edge cases
            return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-block-lang">${escapeHtml(displayLang)}</span><button class="code-block-copy-btn" data-code="${escapeHtmlAttribute(code)}"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="copy-icon"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" /></svg><span class="copy-text">Copy code</span></button></div><pre><code class="hljs${lang ? ` language-${escapeHtmlAttribute(lang)}` : ''}">${highlightedCode}</code></pre></div>`;
        };

        renderer.html = (html) => escapeHtml(html);

        renderer.link = (href, title, text) => {
            const safeHref = sanitizeUrl(href);
            if (!safeHref) return text;
            const safeTitle = title ? ` title="${escapeHtmlAttribute(title)}"` : '';
            return `<a href="${escapeHtmlAttribute(safeHref)}"${safeTitle}>${text}</a>`;
        };

        renderer.image = (href, title, text) => {
            const safeSrc = sanitizeUrl(href, { allowHash: false, allowMailto: false, allowTel: false });
            if (!safeSrc) return escapeHtml(text || '');
            const safeTitle = title ? ` title="${escapeHtmlAttribute(title)}"` : '';
            const safeAlt = escapeHtmlAttribute(text || '');
            return `<img src="${escapeHtmlAttribute(safeSrc)}" alt="${safeAlt}"${safeTitle} />`;
        };

        marked.setOptions({ renderer });
    }

    /**
     * Format language name for display (e.g., 'javascript' -> 'JavaScript')
     */
    formatLanguageName(lang) {
        const langMap = {
            'js': 'JavaScript', 'javascript': 'JavaScript', 'jsx': 'JSX',
            'ts': 'TypeScript', 'typescript': 'TypeScript', 'tsx': 'TSX',
            'py': 'Python', 'python': 'Python',
            'rb': 'Ruby', 'ruby': 'Ruby',
            'go': 'Go', 'golang': 'Go',
            'rs': 'Rust', 'rust': 'Rust',
            'java': 'Java', 'kt': 'Kotlin', 'kotlin': 'Kotlin',
            'c': 'C', 'cpp': 'C++', 'c++': 'C++', 'csharp': 'C#', 'cs': 'C#',
            'swift': 'Swift', 'objc': 'Objective-C',
            'php': 'PHP', 'perl': 'Perl',
            'sh': 'Shell', 'bash': 'Bash', 'zsh': 'Zsh', 'shell': 'Shell',
            'sql': 'SQL', 'mysql': 'MySQL', 'postgres': 'PostgreSQL',
            'html': 'HTML', 'css': 'CSS', 'scss': 'SCSS', 'sass': 'Sass', 'less': 'Less',
            'json': 'JSON', 'yaml': 'YAML', 'yml': 'YAML', 'xml': 'XML', 'toml': 'TOML',
            'md': 'Markdown', 'markdown': 'Markdown',
            'dockerfile': 'Dockerfile', 'docker': 'Docker',
            'graphql': 'GraphQL', 'gql': 'GraphQL',
            'r': 'R', 'matlab': 'MATLAB', 'julia': 'Julia',
            'lua': 'Lua', 'elixir': 'Elixir', 'erlang': 'Erlang',
            'scala': 'Scala', 'clojure': 'Clojure', 'haskell': 'Haskell',
            'vim': 'Vim', 'powershell': 'PowerShell', 'ps1': 'PowerShell',
            'diff': 'Diff', 'plaintext': 'Text', 'text': 'Text'
        };
        return langMap[lang.toLowerCase()] || lang.charAt(0).toUpperCase() + lang.slice(1);
    }

    /**
     * Escape HTML special characters
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Escape HTML for use in attributes (handles quotes)
     */
    escapeHtmlAttribute(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '&#10;');
    }

    /**
     * Allowlist URL sanitizer for markdown output.
     */
    sanitizeUrl(url, options = {}) {
        if (!url || typeof url !== 'string') return null;
        const trimmed = url.trim();
        if (!trimmed) return null;

        const {
            allowRelative = true,
            allowHash = true,
            allowMailto = true,
            allowTel = true,
            allowData = false,
            allowBlob = false
        } = options;

        const lower = trimmed.toLowerCase();
        const normalized = lower.replace(/[\u0000-\u001f\u007f\s]+/g, '');

        if (allowHash && trimmed.startsWith('#')) return trimmed;
        if (allowRelative && (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../'))) {
            return trimmed;
        }
        if (allowMailto && normalized.startsWith('mailto:')) return trimmed;
        if (allowTel && normalized.startsWith('tel:')) return trimmed;
        if (allowData && normalized.startsWith('data:')) return trimmed;
        if (allowBlob && normalized.startsWith('blob:')) return trimmed;
        if (normalized.startsWith('http://') || normalized.startsWith('https://')) return trimmed;

        return null;
    }

    /**
     * Process content with protected LaTeX expressions
     * This prevents marked from breaking LaTeX delimiters
     */
    processContentWithLatex(content) {
        // Store block-level and inline LaTeX to prevent markdown from breaking them
        const blockLatexPlaceholders = [];
        const inlineLatexPlaceholders = [];
        let processedContent = content;

        // Extract block LaTeX \[...\] and replace with placeholders
        processedContent = processedContent.replace(/\\\[([\s\S]*?)\\\]/g, (match, latex) => {
            const placeholder = `BLOCKLATEX${blockLatexPlaceholders.length}PLACEHOLDER`;
            blockLatexPlaceholders.push(this.escapeHtml(match));
            return `\n\n${placeholder}\n\n`;
        });

        // Extract block LaTeX $$...$$ and replace with placeholders
        processedContent = processedContent.replace(/\$\$([\s\S]*?)\$\$/g, (match, latex) => {
            const placeholder = `BLOCKLATEX${blockLatexPlaceholders.length}PLACEHOLDER`;
            blockLatexPlaceholders.push(this.escapeHtml(match));
            return `\n\n${placeholder}\n\n`;
        });

        // Extract inline LaTeX \(...\) and replace with placeholders
        processedContent = processedContent.replace(/\\\(([\s\S]*?)\\\)/g, (match, latex) => {
            const placeholder = `INLINELATEX${inlineLatexPlaceholders.length}PLACEHOLDER`;
            inlineLatexPlaceholders.push(this.escapeHtml(match));
            return placeholder;
        });

        // Process markdown (uses custom renderer configured in init)
        let html = marked.parse(processedContent);

        // Restore block LaTeX without <p> wrapping
        blockLatexPlaceholders.forEach((latex, index) => {
            const placeholder = `BLOCKLATEX${index}PLACEHOLDER`;
            // Remove <p> tags around placeholder and replace with the LaTeX
            html = html.replace(new RegExp(`<p>${placeholder}</p>|${placeholder}`, 'g'), latex);
        });

        // Restore inline LaTeX
        inlineLatexPlaceholders.forEach((latex, index) => {
            const placeholder = `INLINELATEX${index}PLACEHOLDER`;
            html = html.replace(new RegExp(placeholder, 'g'), latex);
        });

        return html;
    }

    initScrollAwareScrollbars(element, hideDelayMs = 1500) {
        let scrollTimer = null;
        element.addEventListener('scroll', () => {
            element.classList.add('scrolling');
            if (scrollTimer) {
                clearTimeout(scrollTimer);
            }
            scrollTimer = setTimeout(() => {
                element.classList.remove('scrolling');
            }, hideDelayMs);
        });
    }

    /**
     * Reliably scroll chat area to bottom
     * Uses multiple RAF calls to ensure content is fully rendered
     */
    scrollToBottom(force = false) {
        const chatArea = this.elements.chatArea;
        if (!chatArea) return;

        if (!this.shouldAutoScrollChat(force)) {
            return;
        }

        // Check if user is near bottom (unless forced)
        if (!force) {
            const isNearBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 150;
            if (!isNearBottom) return;
        }

        // Use double requestAnimationFrame for more reliable scrolling
        // First RAF: wait for current render to complete
        requestAnimationFrame(() => {
            // Second RAF: wait for any triggered reflows/repaints
            requestAnimationFrame(() => {
                chatArea.scrollTop = chatArea.scrollHeight;

                // Third RAF: verify we actually reached the bottom, scroll again if needed
                requestAnimationFrame(() => {
                    const isAtBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 5;
                    if (!isAtBottom) {
                        chatArea.scrollTop = chatArea.scrollHeight;
                    }
                });
            });
        });
    }

    shouldAutoScrollChat(force = false) {
        if (force) return true;
        if (this.isPromptSlideUpEffectActive()) return false;
        return !this.isAutoScrollPaused;
    }

    /**
     * Temporarily disables smooth scrolling to jump the chat area instantly.
     * @param {number} targetTop - Desired scrollTop value
     */
    setChatAreaScrollTopInstant(targetTop) {
        const chatArea = this.elements.chatArea;
        if (!chatArea || typeof targetTop !== 'number' || Number.isNaN(targetTop)) {
            return;
        }

        const previousBehavior = chatArea.style.scrollBehavior;
        chatArea.style.scrollBehavior = 'auto';
        chatArea.scrollTop = targetTop;

        if (previousBehavior) {
            chatArea.style.scrollBehavior = previousBehavior;
        } else {
            chatArea.style.removeProperty('scroll-behavior');
        }
    }

    /**
     * Snaps the chat area to the bottom without animation.
     */
    scrollChatAreaToBottomInstant() {
        const chatArea = this.elements.chatArea;
        if (!chatArea) return;

        const maxScrollTop = Math.max(0, chatArea.scrollHeight - chatArea.clientHeight);
        this.setChatAreaScrollTopInstant(maxScrollTop);
    }

    /**
     * Starts the post-send prompt positioning effect. The sent prompt is placed
     * around 25% from the top of the chat viewport while streaming remains
     * paused so long responses do not pull the viewport downward.
     * @param {string} messageId
     */
    startPromptSlideUpEffect(messageId) {
        const sessionId = this.state.currentSessionId;
        if (!sessionId || !messageId) return;

        const existingSpacer = this.activePromptScroll?.sessionId === sessionId
            ? this.activePromptScroll.spacerEl
            : null;
        if (this.activePromptScroll && this.activePromptScroll.sessionId !== sessionId) {
            this.clearPromptSlideUpEffect();
        }
        this.setPromptSlideUpAnchor(sessionId, messageId);
        this.activePromptScroll = {
            sessionId,
            messageId,
            spacerEl: existingSpacer
        };
        this.elements.chatArea?.classList.add('prompt-slide-active');

        setTimeout(() => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this.updateActivePromptScrollSpacer({ scroll: true, behavior: 'smooth' });
                });
            });
        }, 50);
    }

    detachPromptSlideUpEffect() {
        if (this.activePromptScroll?.spacerEl?.isConnected) {
            this.activePromptScroll.spacerEl.remove();
        }
        this.elements.chatArea?.classList.remove('prompt-slide-active');
        this.activePromptScroll = null;
    }

    setPromptSlideUpAnchor(sessionId, messageId) {
        if (!sessionId || !messageId) return;
        this.sessionPromptScrollAnchors.set(sessionId, { messageId });

        const session = this.state.sessionsById.get(sessionId) || this.state.sessions.find(s => s.id === sessionId);
        if (!session) return;

        session.promptSlideAnchorMessageId = messageId;
        session.promptSlideAnchorUpdatedAt = Date.now();
        chatDB.saveSession(session).catch(error => {
            console.debug('Failed to persist prompt slide anchor:', error);
        });
    }

    clearPromptSlideUpAnchor(sessionId) {
        if (!sessionId) return;
        this.sessionPromptScrollAnchors.delete(sessionId);

        const session = this.state.sessionsById.get(sessionId) || this.state.sessions.find(s => s.id === sessionId);
        if (!session) return;

        if ('promptSlideAnchorMessageId' in session || 'promptSlideAnchorUpdatedAt' in session) {
            delete session.promptSlideAnchorMessageId;
            delete session.promptSlideAnchorUpdatedAt;
            chatDB.saveSession(session).catch(error => {
                console.debug('Failed to clear prompt slide anchor:', error);
            });
        }
    }

    detachStalePromptSlideUpEffect() {
        if (this.activePromptScroll &&
            this.activePromptScroll.sessionId !== this.state.currentSessionId) {
            this.detachPromptSlideUpEffect();
        }
    }

    clearPromptSlideUpEffect() {
        const sessionId = this.activePromptScroll?.sessionId || this.state.currentSessionId;
        this.detachPromptSlideUpEffect();
        this.clearPromptSlideUpAnchor(sessionId);
    }

    isPromptSlideUpEffectActive() {
        return Boolean(
            this.activePromptScroll &&
            this.activePromptScroll.sessionId === this.state.currentSessionId
        );
    }

    ensureActivePromptSpacer() {
        if (!this.isPromptSlideUpEffectActive()) return null;

        const messagesContainer = this.elements.messagesContainer;
        if (!messagesContainer) return null;

        let spacer = this.activePromptScroll.spacerEl;
        if (!spacer || !spacer.isConnected) {
            spacer = document.createElement('div');
            spacer.className = 'prompt-scroll-spacer';
            spacer.setAttribute('aria-hidden', 'true');
            this.activePromptScroll.spacerEl = spacer;
        }

        if (spacer.parentElement !== messagesContainer || messagesContainer.lastElementChild !== spacer) {
            messagesContainer.appendChild(spacer);
        }

        return spacer;
    }

    getPromptSlideUpMessageIdForSession(sessionId, messages = [], { allowStreamingFallback = false } = {}) {
        if (!sessionId || !Array.isArray(messages)) return null;

        const anchor = this.sessionPromptScrollAnchors.get(sessionId);
        if (anchor?.messageId && messages.some(message => message.id === anchor.messageId)) {
            return anchor.messageId;
        }
        if (anchor?.messageId) {
            this.clearPromptSlideUpAnchor(sessionId);
        }

        const session = this.state.sessionsById.get(sessionId) || this.state.sessions.find(s => s.id === sessionId);
        const persistedMessageId = session?.promptSlideAnchorMessageId;
        if (persistedMessageId && messages.some(message => message.id === persistedMessageId)) {
            this.sessionPromptScrollAnchors.set(sessionId, { messageId: persistedMessageId });
            return persistedMessageId;
        }
        if (persistedMessageId) {
            this.clearPromptSlideUpAnchor(sessionId);
        }

        if (!allowStreamingFallback) return null;

        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (message?.role === 'user' && !message.isLocalOnly) {
                this.setPromptSlideUpAnchor(sessionId, message.id);
                return message.id;
            }
        }

        return null;
    }

    restorePromptSlideUpEffectForSession(sessionId, messageId, { primeRunway = false } = {}) {
        if (!sessionId || !messageId || sessionId !== this.state.currentSessionId) return false;

        const alreadyActive = this.activePromptScroll?.sessionId === sessionId &&
            this.activePromptScroll?.messageId === messageId;
        if (!alreadyActive) {
            this.detachPromptSlideUpEffect();
            this.activePromptScroll = {
                sessionId,
                messageId,
                spacerEl: null
            };
        }

        this.setPromptSlideUpAnchor(sessionId, messageId);
        this.elements.chatArea?.classList.add('prompt-slide-active');

        const spacer = this.ensureActivePromptSpacer();
        const chatArea = this.elements.chatArea;
        if (primeRunway && spacer && chatArea) {
            spacer.hidden = false;
            spacer.style.height = `${Math.ceil(chatArea.clientHeight * 0.75)}px`;
        }

        return Boolean(spacer);
    }

    captureActivePromptScrollAnchor({ primeRunway = false } = {}) {
        if (!this.isPromptSlideUpEffectActive()) return null;

        const chatArea = this.elements.chatArea;
        const messageId = this.activePromptScroll.messageId;
        const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!chatArea || !messageEl) return null;

        const areaRect = chatArea.getBoundingClientRect();
        const messageRect = messageEl.getBoundingClientRect();
        const anchor = {
            sessionId: this.activePromptScroll.sessionId,
            messageId,
            offsetTop: messageRect.top - areaRect.top
        };

        if (primeRunway) {
            const spacer = this.ensureActivePromptSpacer();
            if (spacer) {
                const currentHeight = spacer.hidden ? 0 : spacer.getBoundingClientRect().height;
                spacer.hidden = false;
                spacer.style.height = `${Math.ceil(Math.max(currentHeight, chatArea.scrollHeight))}px`;
            }
        }

        return anchor;
    }

    restoreActivePromptScrollAnchor(anchor) {
        if (!anchor || !this.isPromptSlideUpEffectActive()) return false;
        if (anchor.sessionId !== this.activePromptScroll.sessionId ||
            anchor.messageId !== this.activePromptScroll.messageId) {
            return false;
        }

        const chatArea = this.elements.chatArea;
        const messageEl = document.querySelector(`[data-message-id="${anchor.messageId}"]`);
        if (!chatArea || !messageEl) return false;

        this.updateActivePromptScrollSpacer();

        const areaRect = chatArea.getBoundingClientRect();
        const messageRect = messageEl.getBoundingClientRect();
        const currentOffset = messageRect.top - areaRect.top;
        const delta = currentOffset - anchor.offsetTop;

        if (Math.abs(delta) > 1) {
            const maxScrollTop = Math.max(0, chatArea.scrollHeight - chatArea.clientHeight);
            this.setChatAreaScrollTopInstant(Math.min(maxScrollTop, Math.max(0, chatArea.scrollTop + delta)));
        }

        this.updateActivePromptScrollSpacer();
        this.saveCurrentSessionScrollPosition();
        return true;
    }

    /**
     * Maintains just enough temporary bottom runway to keep the active prompt
     * at the target viewport position. As assistant output grows, the spacer
     * shrinks to zero without auto-scrolling the chat area.
     */
    updateActivePromptScrollSpacer({ scroll = false, behavior = 'auto' } = {}) {
        if (!this.isPromptSlideUpEffectActive()) return;

        const chatArea = this.elements.chatArea;
        const messageId = this.activePromptScroll.messageId;
        const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
        const spacer = this.ensureActivePromptSpacer();

        if (!chatArea || !messageEl || !spacer) return;

        const spacerHeight = spacer.getBoundingClientRect().height;
        const areaRect = chatArea.getBoundingClientRect();
        const messageRect = messageEl.getBoundingClientRect();
        const promptTop = chatArea.scrollTop + messageRect.top - areaRect.top;
        const targetOffset = Math.round(chatArea.clientHeight * 0.25);
        const desiredScrollTop = Math.max(0, promptTop - targetOffset);
        const contentEndWithoutSpacer = chatArea.scrollHeight - spacerHeight;
        const requiredScrollHeight = desiredScrollTop + chatArea.clientHeight;
        const nextSpacerHeight = Math.max(0, Math.ceil(requiredScrollHeight - contentEndWithoutSpacer));

        spacer.style.height = `${nextSpacerHeight}px`;
        spacer.hidden = nextSpacerHeight <= 0;

        if (scroll) {
            requestAnimationFrame(() => {
                const maxScrollTop = Math.max(0, chatArea.scrollHeight - chatArea.clientHeight);
                const targetTop = Math.min(desiredScrollTop, maxScrollTop);
                chatArea.scrollTo({
                    top: targetTop,
                    behavior
                });
                setTimeout(() => {
                    this.saveCurrentSessionScrollPosition();
                    this.updateScrollButtonVisibility();
                }, behavior === 'smooth' ? 350 : 0);
            });
        }
    }

    /**
     * Saves the current session's scroll position in-memory for this tab.
     */
    saveCurrentSessionScrollPosition() {
        const chatArea = this.elements.chatArea;
        const sessionId = this.state.currentSessionId;
        if (!chatArea || !sessionId) return;

        const maxScrollTop = Math.max(0, chatArea.scrollHeight - chatArea.clientHeight);
        const atBottom = Math.abs(maxScrollTop - chatArea.scrollTop) <= 2;

        this.sessionScrollPositions.set(sessionId, {
            top: chatArea.scrollTop,
            atBottom
        });
    }

    /**
     * Restores the scroll position for the provided session if available.
     * @param {string} sessionId
     * @returns {boolean} True when a stored scroll position was applied
     */
    restoreSessionScrollPosition(sessionId) {
        const chatArea = this.elements.chatArea;
        if (!chatArea || !sessionId) return false;

        const stored = this.sessionScrollPositions.get(sessionId);
        if (!stored) {
            return false;
        }

        const maxScrollTop = Math.max(0, chatArea.scrollHeight - chatArea.clientHeight);
        const targetTop = stored.atBottom ? maxScrollTop : Math.min(stored.top, maxScrollTop);
        this.setChatAreaScrollTopInstant(Math.max(0, targetTop));
        if (this.state.currentSessionId === sessionId) {
            this.saveCurrentSessionScrollPosition();
        }
        return true;
    }

    /**
     * Internal per-session chatbar snapshot.
     * ChatbarDraftState = { text, uploadedFiles, fileUndoStack, scrubberPending }
     */
    buildCurrentChatbarState() {
        return {
            text: this.elements.messageInput?.value || '',
            uploadedFiles: [...this.uploadedFiles],
            fileUndoStack: [...this.fileUndoStack],
            scrubberPending: this.scrubberPending ? { ...this.scrubberPending } : null
        };
    }

    saveChatbarStateForSession(sessionId) {
        if (!sessionId) return;
        this.sessionChatbarStates.set(sessionId, this.buildCurrentChatbarState());
    }

    applyChatbarState(state) {
        const input = this.elements.messageInput;
        if (!input) return;

        this.chatInput?.clearScrubberPreview?.();

        const normalized = state && typeof state === 'object' ? state : null;
        const text = typeof normalized?.text === 'string' ? normalized.text : '';
        const uploadedFiles = Array.isArray(normalized?.uploadedFiles) ? [...normalized.uploadedFiles] : [];
        const fileUndoStack = Array.isArray(normalized?.fileUndoStack) ? [...normalized.fileUndoStack] : [];
        const scrubberPending = normalized?.scrubberPending ? { ...normalized.scrubberPending } : null;

        this.uploadedFiles = uploadedFiles;
        this.scrubberPending = scrubberPending;

        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));

        // Input listeners clear file undo state; restore it after the dispatch.
        this.fileUndoStack = fileUndoStack;

        this.renderFilePreviews();
        this.updateFileCountBadge();
        this.updateInputState();
    }

    restoreChatbarStateForSession(sessionId) {
        if (!sessionId) {
            this.applyChatbarState(null);
            return;
        }
        const state = this.sessionChatbarStates.get(sessionId) || null;
        this.applyChatbarState(state);
    }

    clearChatbarStateForSession(sessionId) {
        if (!sessionId) return;
        this.sessionChatbarStates.delete(sessionId);
    }

    clearAllChatbarStates() {
        this.sessionChatbarStates.clear();
    }

    /**
     * Debounces scroll position persistence to avoid excessive writes.
     */
    scheduleScrollPositionSave() {
        if (this.chatScrollSaveFrame) {
            cancelAnimationFrame(this.chatScrollSaveFrame);
        }

        this.chatScrollSaveFrame = requestAnimationFrame(() => {
            this.chatScrollSaveFrame = null;
            this.saveCurrentSessionScrollPosition();
        });
    }

    /**
     * Creates the scroll-to-bottom button element
     */
    createScrollToBottomButton() {
        if (this.scrollToBottomButton) return; // Already created

        const button = document.createElement('button');
        button.type = 'button';
        button.id = 'scroll-to-bottom-btn';
        button.className = 'scroll-to-bottom-btn hidden';
        button.setAttribute('aria-label', 'Scroll to bottom');
        button.innerHTML = `
            <span class="scroll-btn-label">Scroll to bottom</span>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 12.75 12 20.25 4.5 12.75M12 3.75v16.5" />
            </svg>
        `;

        // Add click handler
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.clearPromptSlideUpEffect();
            this.isAutoScrollPaused = false;
            this._scrollButtonClickPending = true;
            this.hideScrollToBottomButton();
            this.scrollToBottom(true);

            // Clear flag only after scroll animation completes and we're at bottom
            // Use longer timeout to account for smooth scroll animation
            const clearPendingFlag = () => {
                const chatArea = this.elements.chatArea;
                if (chatArea) {
                    const isAtBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 10;
                    if (isAtBottom) {
                        this._scrollButtonClickPending = false;
                        return;
                    }
                }
                // If not at bottom yet, check again
                setTimeout(clearPendingFlag, 100);
            };
            // Start checking after initial scroll animation time
            setTimeout(clearPendingFlag, 400);
        });

        // Insert into input container (not input-card which has isolation: isolate that breaks backdrop-filter)
        const inputContainer = document.querySelector('.absolute.bottom-0.left-0.right-0');
        if (inputContainer) {
            // Ensure container is positioned for absolute child
            if (getComputedStyle(inputContainer).position === 'static') {
                inputContainer.style.position = 'relative';
            }
            inputContainer.appendChild(button);
        }

        this.scrollToBottomButton = button;
    }

    /**
     * Shows the scroll-to-bottom button with fade-in animation
     */
    showScrollToBottomButton() {
        if (!this.scrollToBottomButton) {
            this.createScrollToBottomButton();
        }

        if (this.scrollToBottomButton && this.scrollToBottomButton.classList.contains('hidden')) {
            this.scrollToBottomButton.classList.remove('hidden');
            // Trigger reflow to ensure animation plays
            void this.scrollToBottomButton.offsetWidth;
            this.scrollToBottomButton.classList.add('visible');
        }
    }

    /**
     * Hides the scroll-to-bottom button with fade-out animation
     */
    hideScrollToBottomButton() {
        if (this.scrollToBottomButton && !this.scrollToBottomButton.classList.contains('hidden')) {
            this.scrollToBottomButton.classList.remove('visible');
            // Wait for fade-out animation before hiding
            setTimeout(() => {
                if (this.scrollToBottomButton) {
                    this.scrollToBottomButton.classList.add('hidden');
                }
            }, 200);
        }
    }

    /**
     * Updates toolbar mode and divider visibility.
     * - Wide screens (no overlap): toolbar floats over content, no blocking
     * - Narrow screens (overlap): toolbar blocks content, divider shows when content scrolls behind
     */
    /**
     * Updates toolbar state. Can predict final width with widthDelta parameter.
     * @param {number} widthDelta - Optional: predicted change in main area width (negative = narrower)
     */
    updateToolbarDivider(widthDelta = 0) {
        const chatArea = this.elements.chatArea;
        const toolbar = document.getElementById('chat-toolbar');
        const messagesContainer = this.elements.messagesContainer;
        if (!chatArea || !toolbar || !messagesContainer) return;

        // Track prediction timing to avoid overriding during panel animations
        const now = Date.now();

        if (widthDelta !== 0) {
            // This is a prediction call - record the timestamp
            this._toolbarPredictionTime = now;
        } else if (this._toolbarPredictionTime && (now - this._toolbarPredictionTime) < TOOLBAR_PREDICTION_GRACE_MS) {
            // Non-prediction call within grace period - skip to avoid overriding
            return;
        }

        // On mobile (< 768px), toolbar never floats - show divider when scrolled
        const isMobile = window.innerWidth < 768;
        const mobileDivider = document.getElementById('mobile-toolbar-divider');

        if (isMobile) {
            toolbar.classList.remove('toolbar-floating');
            toolbar.classList.remove('toolbar-divider-visible'); // Use separate divider element on mobile

            // On mobile, show divider element if user has scrolled down past threshold
            const hasScrolled = chatArea.scrollTop > 10; // Small threshold to avoid flickering
            if (mobileDivider) {
                mobileDivider.style.display = hasScrolled ? 'block' : 'none';
            }
            return;
        }

        // Hide mobile divider on desktop
        if (mobileDivider) {
            mobileDivider.style.display = 'none';
        }

        // Desktop: Check if content area overlaps with toolbar buttons
        // Use widthDelta to predict final width (before animation completes)
        const currentWidth = chatArea.clientWidth;
        const mainWidth = currentWidth + widthDelta;
        const actualContentWidth = messagesContainer.getBoundingClientRect().width;
        const sideMargin = (mainWidth - actualContentWidth) / 2;
        // Button area: ~80px (2×36px buttons + gaps + padding) - show-sidebar + wide-mode when sidebar hidden
        // But messages-container has internal padding (px-6 = 24px on md+), so actual text is further inward
        // With sideMargin=52 + internal padding=24, actual content at 76px - minimal overlap with 80px buttons
        const buttonAreaWidth = 52;

        // Wide screen: no overlap, make toolbar transparent (visual only, no layout change)
        const isWideScreen = sideMargin >= buttonAreaWidth;
        toolbar.classList.toggle('toolbar-wide', isWideScreen);

        // Only show divider on narrow screens when content scrolls past toolbar
        if (isWideScreen) {
            toolbar.classList.remove('toolbar-divider-visible');
            return;
        }

        // Narrow screen: show divider when content crosses toolbar
        const toolbarBottom = toolbar.getBoundingClientRect().bottom;
        const firstMessage = messagesContainer.firstElementChild;
        const threshold = 8;
        const contentCrossesToolbar = firstMessage &&
            firstMessage.getBoundingClientRect().top < (toolbarBottom - threshold);

        toolbar.classList.toggle('toolbar-divider-visible', contentCrossesToolbar);
    }

    /**
     * Checks scroll position and updates button visibility
     */
    updateScrollButtonVisibility() {
        const chatArea = this.elements.chatArea;
        if (!chatArea) return;

        // Don't re-show button while scroll-to-bottom click is still processing
        if (this._scrollButtonClickPending) return;

        if (this.isPromptSlideUpEffectActive() && this.isCurrentSessionStreaming()) {
            this.hideScrollToBottomButton();
            return;
        }

        const inputContainer = document.querySelector('.absolute.bottom-0.left-0.right-0');
        const spacer = this.activePromptScroll?.spacerEl?.isConnected
            ? this.activePromptScroll.spacerEl
            : null;
        let lastMessage = this.elements.messagesContainer ? this.elements.messagesContainer.lastElementChild : null;
        if (lastMessage === spacer) {
            lastMessage = spacer.previousElementSibling;
        }

        if (!inputContainer || !lastMessage) {
            this.hideScrollToBottomButton();
            return;
        }

        const spacerHeight = spacer && !spacer.hidden ? spacer.getBoundingClientRect().height : 0;
        const effectiveScrollHeight = chatArea.scrollHeight - spacerHeight;
        const hiddenDistance = Math.max(0, effectiveScrollHeight - chatArea.scrollTop - chatArea.clientHeight);
        const isAtBottom = hiddenDistance <= 4;
        const realBottomDistance = Math.max(0, chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight);
        const isAtRealBottom = realBottomDistance <= 4;

        if (isAtBottom) {
            if (this.isPromptSlideUpEffectActive() &&
                !this.isCurrentSessionStreaming() &&
                isAtRealBottom &&
                spacerHeight <= 4) {
                this.clearPromptSlideUpEffect();
            }
            this.isAutoScrollPaused = false;
            this.hideScrollToBottomButton();
            return;
        }

        const inputTop = inputContainer.getBoundingClientRect().top;
        const lastMessageBottom = lastMessage.getBoundingClientRect().bottom;
        const overlapsInput = lastMessageBottom > inputTop - 8;
        const messageHiddenDistance = Math.max(0, lastMessageBottom - chatArea.getBoundingClientRect().bottom);
        const shouldShow = overlapsInput || (spacer ? messageHiddenDistance > 12 : hiddenDistance > 12);

        if (shouldShow) {
            this.showScrollToBottomButton();
        } else {
            this.hideScrollToBottomButton();
        }
    }

    /**
     * Shows the link preview card with metadata.
     * @param {HTMLElement} linkElement - The link element being hovered
     * @param {Object} metadata - URL metadata object
     */
    showLinkPreview(linkElement, metadata) {
        if (!this.linkPreviewCard) return;

        const loader = this.linkPreviewCard.querySelector('.link-preview-loader');
        const content = this.linkPreviewCard.querySelector('.link-preview-content');

        if (metadata.loading) {
            // Show loading state
            loader.classList.remove('hidden');
            content.classList.add('hidden');
        } else {
            // Show content
            loader.classList.add('hidden');
            content.classList.remove('hidden');

            // Populate metadata
            const favicon = content.querySelector('.link-preview-favicon');
            const domain = content.querySelector('.link-preview-domain');
            const title = content.querySelector('.link-preview-title');
            const description = content.querySelector('.link-preview-description');

            favicon.src = metadata.favicon || '';
            favicon.alt = metadata.domain || '';
            domain.textContent = metadata.domain || '';
            title.textContent = metadata.title || metadata.domain || '';
            description.textContent = metadata.description || '';
        }

        // Position the preview card
        this.positionLinkPreview(linkElement);

        // Show the card
        this.linkPreviewCard.classList.remove('hidden');
        this.linkPreviewCard.classList.add('visible');
    }

    /**
     * Positions the link preview card relative to the link element.
     * @param {HTMLElement} linkElement - The link element
     */
    positionLinkPreview(linkElement) {
        if (!this.linkPreviewCard) return;

        const linkRect = linkElement.getBoundingClientRect();

        // Get actual rendered dimensions of the preview card
        this.linkPreviewCard.style.visibility = 'hidden';
        this.linkPreviewCard.classList.remove('hidden');
        const cardRect = this.linkPreviewCard.getBoundingClientRect();
        const cardWidth = cardRect.width;
        const cardHeight = cardRect.height;
        this.linkPreviewCard.style.visibility = '';

        const gap = 6; // Gap between link and card
        const viewportPadding = 12;

        // Always position below the link for consistency
        let top = linkRect.bottom + gap;

        // Center horizontally relative to the link
        let left = linkRect.left + (linkRect.width / 2) - (cardWidth / 2);

        // Horizontal adjustments for viewport edges
        if (left + cardWidth > window.innerWidth - viewportPadding) {
            // Align to right edge if would overflow
            left = window.innerWidth - cardWidth - viewportPadding;
        } else if (left < viewportPadding) {
            // Align to left edge if would overflow
            left = viewportPadding;
        }

        // Vertical adjustment if card would go below viewport
        const spaceBelow = window.innerHeight - linkRect.bottom;
        if (spaceBelow < cardHeight + gap + viewportPadding) {
            // If not enough space below, position above the link instead
            top = linkRect.top - cardHeight - gap;

            // But if that would go above viewport, keep below and scroll-align
            if (top < viewportPadding) {
                top = linkRect.bottom + gap;
                // Let it extend below viewport if necessary - browser will handle scrolling
            }
        }

        this.linkPreviewCard.style.top = `${top}px`;
        this.linkPreviewCard.style.left = `${left}px`;
    }

    /**
     * Hides the link preview card.
     */
    hideLinkPreview() {
        if (!this.linkPreviewCard) return;

        this.linkPreviewCard.classList.remove('visible');
        this.linkPreviewCard.classList.add('hidden');
        this.currentPreviewLink = null;
        this.isHoveringPreviewCard = false;
        this.cancelLinkPreviewHide();
    }

    /**
     * Handles mouse enter on inline link buttons.
     * @param {MouseEvent} event - Mouse event
     */
    async handleLinkMouseEnter(event) {
        const linkButton = event.target.closest('.inline-link-button');
        if (!linkButton) return;

        const url = linkButton.getAttribute('data-url');
        if (!url) return;

        this.currentPreviewLink = linkButton;

        // Clear any existing timeout
        if (this.linkPreviewTimeout) {
            clearTimeout(this.linkPreviewTimeout);
        }

        // Show preview after a short delay
        this.linkPreviewTimeout = setTimeout(async () => {
            if (this.currentPreviewLink !== linkButton) return;

            // Show loading state
            this.showLinkPreview(linkButton, { loading: true });

            try {
                // Fetch metadata
                const metadata = await fetchUrlMetadata(url);

                // Check if we're still hovering this link
                if (this.currentPreviewLink === linkButton) {
                    this.showLinkPreview(linkButton, metadata);
                }
            } catch (error) {
                console.debug('Failed to load link preview:', error);
                if (this.currentPreviewLink === linkButton) {
                    this.hideLinkPreview();
                }
            }
        }, 200); // 200ms delay
    }

    /**
     * Handles mouse leave on inline link buttons.
     * @param {MouseEvent} event - Mouse event
     */
    handleLinkMouseLeave(event) {
        const linkButton = event.target.closest('.inline-link-button');
        if (!linkButton) return;

        // Clear timeout
        if (this.linkPreviewTimeout) {
            clearTimeout(this.linkPreviewTimeout);
            this.linkPreviewTimeout = null;
        }

        // Schedule hiding the preview - give time to move to the preview card
        this.scheduleLinkPreviewHide();
    }

    /**
     * Schedules hiding the link preview with a delay.
     * Can be cancelled if mouse enters the preview card.
     */
    scheduleLinkPreviewHide() {
        // Clear any existing hide timeout
        if (this.linkPreviewHideTimeout) {
            clearTimeout(this.linkPreviewHideTimeout);
        }

        this.linkPreviewHideTimeout = setTimeout(() => {
            this.linkPreviewHideTimeout = null;
            // Only hide if not hovering over the preview card
            if (!this.isHoveringPreviewCard) {
                this.hideLinkPreview();
            }
        }, 150);
    }

    /**
     * Cancels the scheduled link preview hide.
     */
    cancelLinkPreviewHide() {
        if (this.linkPreviewHideTimeout) {
            clearTimeout(this.linkPreviewHideTimeout);
            this.linkPreviewHideTimeout = null;
        }
    }

    /**
     * Sets up event delegation for inline link previews.
     */
    setupLinkPreviewListeners() {
        // Use event delegation on messages container
        const messagesContainer = this.elements.messagesContainer;
        if (!messagesContainer) return;

        messagesContainer.addEventListener('mouseenter', (e) => {
            this.handleLinkMouseEnter(e);
        }, true);

        messagesContainer.addEventListener('mouseleave', (e) => {
            this.handleLinkMouseLeave(e);
        }, true);

        // Handle citation clicks
        messagesContainer.addEventListener('click', (e) => {
            // Handle citation toggle button
            const toggleBtn = e.target.closest('.citations-toggle-btn');
            if (toggleBtn) {
                const messageId = toggleBtn.getAttribute('data-message-id');
                this.toggleCitations(messageId);
                return;
            }

            // Handle inline citation clicks
            const citation = e.target.closest('.inline-citation');
            if (citation) {
                const messageId = citation.getAttribute('data-message-id');
                const citationNum = citation.getAttribute('data-citation');
                this.scrollToCitation(messageId, citationNum);
                return;
            }
        });

        // Track hover state on preview card
        if (this.linkPreviewCard) {
            this.linkPreviewCard.addEventListener('mouseenter', () => {
                this.isHoveringPreviewCard = true;
                this.cancelLinkPreviewHide();
            });
            this.linkPreviewCard.addEventListener('mouseleave', () => {
                this.isHoveringPreviewCard = false;
                this.hideLinkPreview();
            });
        }
    }

    /**
     * Initializes the application: loads data, sets up components, and renders initial state.
     */
    async init() {
        // Configure marked.js renderer for code blocks (with syntax highlighting + copy button)
        this.configureMarkedRenderer();

        // Setup image expand functionality
        window.expandImage = (imageId) => {
            const img = document.querySelector(`img[data-image-id="${imageId}"]`);
            if (!img) return;

            // Create modal overlay
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/80 animate-fade-in cursor-pointer p-4';
            modal.onclick = () => modal.remove();

            // Create image container
            const container = document.createElement('div');
            container.className = 'relative max-w-[90vw] max-h-[90vh] flex flex-col items-center';
            container.onclick = (e) => e.stopPropagation();

            // Create full-size image
            const fullImg = document.createElement('img');
            fullImg.src = img.src;
            fullImg.alt = img.alt;
            fullImg.className = 'max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl';

            // Create close button
            const closeBtn = document.createElement('button');
            closeBtn.className = 'absolute top-2 right-2 p-2 rounded-md bg-white/90 hover:bg-white text-gray-700 shadow-lg border border-gray-200 transition-colors';
            closeBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-5 h-5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
            `;
            closeBtn.onclick = () => modal.remove();

            // Assemble modal
            container.appendChild(fullImg);
            container.appendChild(closeBtn);
            modal.appendChild(container);
            document.body.appendChild(modal);

            // Add escape key handler
            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    modal.remove();
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);
        };

        // Setup global function to download inference tickets
        window.downloadInferenceTickets = async () => {
            try {
                const result = await exportTickets();
                if (result.cancelled) {
                    // User cancelled - no toast needed
                    return;
                }
                if (result.success) {
                    const total = result.activeCount + result.archivedCount;
                    this.showToast(`Exported ${total} ticket${total !== 1 ? 's' : ''} and cleared storage`, 'success');
                } else {
                    this.showToast('Failed to export tickets', 'error');
                }
            } catch (error) {
                console.error('Ticket export failed:', error);
                this.showToast('Failed to export tickets', 'error');
            }
        };

        // Initialize storage events early for multi-tab sync.
        window.storageEvents = storageEvents;
        storageEvents.init();

        // Initialize theme FIRST (sync, fast, prevents flash)
        themeManager.init();

        // Start DB init in background - components can show skeleton state
        const dbReady = chatDB.init();
        this.dbReadyPromise = dbReady;

        // Initialize UI components immediately (sync, fast) - shows loading states
        this.ui = new VanillaChatUi(this);
        Object.assign(this, this.ui.mountShell());
        this.setupSidebarFilterControls();

        // Render core shell immediately so non-sidebar UI is never blank on startup.
        this.chatArea.renderEmptyStateImmediate();
        this.renderCurrentModel();
        this.chatInput.updateSearchToggleUI();
        this.chatInput.updateReasoningToggleUI();
        this.renderDeleteHistoryModalContent();
        this.setupEventListeners();
        // Extensions are optional. A slow or broken extension must never delay
        // model, storage, or chat initialization.
        void this.extensionHost.mountAll(this.extensions, this.createExtensionContext());

        // Start model loading independently so the picker remains usable even
        // if local storage/session history work is slow.
        this.loadModels().then(() => {
            this.renderCurrentModel(); // Re-render button with model icons
            if (this.modelPicker) {
                // Re-render model list if modal is open, otherwise warm it in idle time.
                if (!this.elements.modelPickerModal.classList.contains('hidden')) {
                    this.modelPicker.renderModels(this.elements.modelSearch?.value || '');
                } else {
                    this.modelPicker.warmRender();
                }
            }
        }).catch(error => {
            console.warn('Background model loading failed:', error);
        });

        // Wait for DB before loading data
        try {
            await dbReady;
        } catch (error) {
            console.error('Failed to initialize local database:', error);
            this.state.sessions = [];
            this.state.sessionsById = new Map();
            this.state.hasMoreSessions = false;
            this.renderSessions();
            this.showToast('Failed to open local chat storage. Close other tabs and reload.', 'error');
            return;
        }

        if (chatDB.compatMode) {
            this.showToast('Chat storage is running in compatibility mode. Close other tabs and reload to finish the upgrade.', 'error');
        }

        // Establish this tab's account context before any account-scoped stores
        // read the shared live settings keys.
        try {
            await accountService.init();
        } catch (error) {
            console.warn('Account init failed:', error);
        }

        // Initialize preference-backed layout only after account context exists.
        void this.initWideMode();
        void this.initSidebarVisibility();

        window.addEventListener('oa-db-versionchange', () => {
            this.showToast('Chat storage updated in another tab. Reload to continue.', 'error');
        });

        window.addEventListener('oa-db-compat-mode', () => {
            this.showToast('Chat storage is running in compatibility mode. Close other tabs and reload to finish the upgrade.', 'error');
        });

        // Now set up theme controls after chatInput is initialized
        this.updateThemeControls(themeManager.getPreference(), themeManager.getEffectiveTheme());
        this.themeUnsubscribe = themeManager.onChange((preference, effectiveTheme) => {
            this.updateThemeControls(preference, effectiveTheme);
        });

        this.preferencesUnsubscribe = preferencesStore.onChange((key, value) => {
            if (key === PREF_KEYS.wideMode) {
                this.applyWideMode(!!value);
            }
            if (key === PREF_KEYS.leftSidebarVisible && typeof value === 'boolean' && !this.isMobileView()) {
                const isHidden = this.elements.sidebar?.classList.contains('sidebar-hidden');
                if (value) {
                    if (isHidden) {
                        this.showSidebar({ persist: false, predictToolbar: false });
                    }
                } else {
                    if (!isHidden) {
                        this.hideSidebar({ persist: false, predictToolbar: false });
                    }
                }
            }
        });

        this.storageEventsUnsubscribe = [
            storageEvents.on('sessions-updated', (payload) => {
                this.handleStorageEvent('sessions-updated', payload);
            }),
            storageEvents.on('sessions-cleared', (payload) => {
                this.handleStorageEvent('sessions-cleared', payload);
            }),
            storageEvents.on('messages-updated', (payload) => {
                this.handleStorageEvent('messages-updated', payload);
            })
        ];

        // Initialize message navigation
        this.messageNavigation = this.ui.mountMessageNavigation();

        // Initialize model tiers and model availability (loads cache, fetches fresh data in background)
        initModelTiers();
        initPinnedModels();
        onPinnedModelsUpdate(() => {
            void this.refreshModelsForAvailabilityUpdate();
        });

        // Keep slower service startup off the critical render path.
        void (async () => {
            try {
                await storageManager.init();
            } catch (error) {
                console.warn('Storage manager init failed:', error);
            }

            try {
                await apiKeyStore.loadApiKey();
            } catch (error) {
                console.warn('API key load failed:', error);
            }

            this.scrubberService.init().catch((error) => {
                console.warn('Scrubber init failed:', error);
            });

            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(() => accountService.maybeAutoUnlock());
            } else {
                setTimeout(() => accountService.maybeAutoUnlock(), 800);
            }

            await networkProxy.syncWithPreferences().catch(err => console.warn('Proxy pref sync failed:', err));
            networkProxy.initialize().catch(err => console.warn('Proxy init failed:', err));

        })();

        // Load settings from IndexedDB in parallel; this is independent of sidebar history load.
        const settingsPromise = Promise.all([
            chatDB.getSetting('selectedModel'),
            chatDB.getSetting('searchEnabled'),
            chatDB.getSetting('memoryFeatureEnabled'),
            chatDB.getSetting('memoryMode'),
            chatDB.getSetting('memoryAutoInclude'),
            chatDB.getSetting('memoryAgentModel'),
            chatDB.getSetting('reasoningEffort'),
            chatDB.getSetting('parallelModeEnabled'),
            chatDB.getSetting('parallelSecondaryModel'),
            chatDB.getSetting('parallelSynthesisModel'),
            chatDB.getSetting('parallelOutputMode')
        ]);

        // Restore session from sessionStorage as early as possible for chat area hydration.
        const savedSessionId = sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (savedSessionId) {
            await this.ensureSessionLoaded(savedSessionId);
            if (this.state.sessionsById.has(savedSessionId)) {
                this.state.currentSessionId = savedSessionId;
            }
        }

        const [
            storedModelPreference,
            savedSearchEnabled,
            savedMemoryFeatureEnabled,
            savedMemoryMode,
            savedMemoryAutoInclude,
            savedMemoryAgentModel,
            savedReasoningEffort,
            savedParallelModeEnabled,
            savedParallelSecondaryModel,
            savedParallelSynthesisModel,
            savedParallelOutputMode
        ] = await settingsPromise;

        // Process model preference
        const normalizedModelName = this.upgradeDefaultModelPreference(
            this.normalizeModelName(storedModelPreference)
        );
        if (normalizedModelName && normalizedModelName !== storedModelPreference) {
            // Save in background, don't block
            chatDB.saveSetting('selectedModel', normalizedModelName).catch(() => {});
        }
        if (normalizedModelName) {
            this.state.pendingModelName = normalizedModelName;
        }

        // Restore search state
        this.searchEnabled = savedSearchEnabled !== undefined ? savedSearchEnabled : true;
        const resolvedMemoryFeatureState = resolveMemoryFeatureStateValue({
            savedMemoryFeatureEnabled,
            savedMemoryMode
        });
        this.memoryFeatureEnabled = resolvedMemoryFeatureState.memoryFeatureEnabled;
        this.memoryMode = resolvedMemoryFeatureState.memoryMode;
        if (resolvedMemoryFeatureState.shouldPersistMemoryMode) {
            chatDB.saveSetting('memoryMode', false).catch(() => {});
        }
        this.memoryAutoInclude = savedMemoryAutoInclude === true;
        this.memoryAgentModel = isAllowedConfidentialModel(savedMemoryAgentModel)
            ? String(savedMemoryAgentModel).trim()
            : DEFAULT_MEMORY_AGENT_MODEL;
        if (savedMemoryAgentModel && savedMemoryAgentModel !== this.memoryAgentModel) {
            chatDB.saveSetting('memoryAgentModel', this.memoryAgentModel).catch(() => {});
        }

        // Extended-thinking toggle is intentionally removed from UI for now.
        // Keep the legacy flag always enabled and persist it for import/export compatibility.
        this.reasoningEnabled = true;
        chatDB.saveSetting('reasoningEnabled', true).catch(() => {});
        this.reasoningEffort = normalizeReasoningEffort(savedReasoningEffort);
        this.parallelModeEnabled = savedParallelModeEnabled === true;
        this.parallelSecondaryModel = typeof savedParallelSecondaryModel === 'string' && savedParallelSecondaryModel.trim()
            ? savedParallelSecondaryModel.trim()
            : null;
        this.parallelSynthesisModel = typeof savedParallelSynthesisModel === 'string' && savedParallelSynthesisModel.trim()
            ? savedParallelSynthesisModel.trim()
            : null;
        this.parallelOutputMode = normalizeCouncilOutputMode(savedParallelOutputMode);
        if (!this.state.currentSessionId) {
            this.applyPersistedParallelPendingConfig(this.state.pendingModelName);
        }

        // This cache is display-only: request-time selection continues to use
        // state.models after the active backend's live catalog has loaded.
        this.cachedModelDisplayMetadata = inferenceService.getCachedModels(this.getCurrentSession());

        // Render local data immediately (session from sessionStorage + model/settings from DB).
        this.renderMessages();
        this.renderCurrentModel();
        this.chatInput.updateSearchToggleUI();
        this.chatInput.updateMemoryToggleUI();
        this.chatInput.refreshMemorySettingsUI();
        this.chatInput.updateReasoningToggleUI();
        this.chatInput.updateReasoningEffortUI();
        this.updateShareButtonUI();
        // Force Safari to reset textarea layout after restoring session
        this.resetMessageInputLayout({ resetScroll: true });

        // Notify right panel of current session
        const currentSession = this.getCurrentSession();
        if (this.rightPanel && currentSession) {
            this.rightPanel.onSessionChange(currentSession);
        }
        if (this.floatingPanel && currentSession) {
            this.floatingPanel.render();
        }

        // Load sessions for the sidebar after core UI is already visible.
        try {
            await this.loadInitialSessions();
        } catch (error) {
            console.warn('Failed to load initial sessions:', error);
            this.state.sessions = [];
            this.state.sessionsById = new Map();
            this.state.hasMoreSessions = false;
        }
        if (this.state.currentSessionId) {
            await this.ensureSessionLoaded(this.state.currentSessionId);
        }
        this.renderSessions();

        // Migrate sessions in background (don't block UI)
        this.migrateSessionsInBackground(this.state.sessions);
        const scheduleBackfill = () => chatDB.backfillMissingUpdatedAt()
            .catch(err => console.warn('UpdatedAt backfill failed:', err));
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(scheduleBackfill);
        } else {
            setTimeout(scheduleBackfill, 1200);
        }

        this.renderDeleteHistoryModalContent();

        // Set up event listeners
        this.setupEventListeners();

        // Load models from inference backend in background (non-blocking)
        // Updates model picker with icons once loaded
        this.loadModels().then(async () => {
            await this.refreshDefaultModelPreferenceForAvailabilityUpdate();
            if (this.pendingModelAvailabilityRefresh) {
                this.pendingModelAvailabilityRefresh = false;
                await this.refreshModelsForAvailabilityUpdate();
                return;
            }

            this.renderCurrentModel(); // Re-render button with model icons
            if (this.modelPicker) {
                // Re-render model list if modal is open, otherwise warm it in idle time.
                if (!this.elements.modelPickerModal.classList.contains('hidden')) {
                    this.modelPicker.renderModels(this.elements.modelSearch?.value || '');
                } else {
                    this.modelPicker.warmRender();
                }
            }
        }).catch(error => {
            console.warn('Background model loading failed:', error);
        });

        // Chat area scrollbar hide delay: ~1s after scrolling ends (common overlay-scrollbar behavior).
        this.initScrollAwareScrollbars(this.elements.chatArea, 1000);
        this.initScrollAwareScrollbars(this.elements.sessionsScrollArea);
        this.initScrollAwareScrollbars(this.elements.modelListScrollArea);

        // Set up scroll listener for message navigation and scroll button (passive for performance)
        this.elements.chatArea.addEventListener('scroll', () => {
            if (this.messageNavigation) {
                this.messageNavigation.handleScroll();
            }
            this.updateScrollButtonVisibility();
            this.updateToolbarDivider();
            this.scheduleScrollPositionSave();
        }, { passive: true });

        // Set up resize listener for toolbar divider (content width changes)
        // Debounced to avoid overriding predicted state during panel animations (300ms)
        let resizeDebounceTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeDebounceTimer);
            resizeDebounceTimer = setTimeout(() => {
                this.updateWideModeButtonVisibility();
                this.updateToolbarDivider();
            }, 350);
        }, { passive: true });

        // Set up ResizeObserver to adjust chat area padding when input area expands
        this.setupInputAreaObserver();

        // Set up link preview event listeners
        this.setupLinkPreviewListeners();

        // Initialize verifier and start broadcast checks
        this.initVerifier();

        // Scroll to bottom after initial load (for refresh)
        setTimeout(() => {
            this.scrollToBottom(true);
            // Initialize toolbar divider state
            this.updateToolbarDivider();
        }, 100);

        // Auto-focus input field on startup (with retries for reliability)
        this.deferInitialInputFocus();

        // Check for pending send from early interaction
        if (window.oaPendingSend) {
            window.oaPendingSend = false;
            // Small delay to ensure everything is settled
            setTimeout(() => {
                this.sendMessage();
            }, 0);
        }

        // Capture ticket codes from URL before session handling (cleans URL if needed)
        this.captureTicketCodeFromUrl();

        // Check for session in URL (?s=sessionId)
        const sessionCheck = this.checkForUrlSession();
        if (sessionCheck && typeof sessionCheck.then === 'function') {
            sessionCheck.finally(() => this.handlePendingTicketCode());
        } else {
            this.handlePendingTicketCode();
        }

        // Start update checks for new app versions
        this.initUpdateWatcher();

        // Periodic check for share expiry status (every 30 seconds)
        setInterval(() => this.updateShareButtonUI(), 30000);
    }

    normalizeTicketCode(rawCode) {
        if (!rawCode) return '';
        return rawCode.trim().replace(/[\s-]+/g, '');
    }

    ingestTicketCode(code, options = {}) {
        if (!this.rightPanel) return false;

        const normalizedCode = this.normalizeTicketCode(code);
        if (!normalizedCode) return false;

        const autoRedeem = options.autoRedeem !== false;
        const source = options.source || null;

        this.rightPanel.show();
        this.rightPanel.applyInvitationCodeFromLink(normalizedCode, { autoRedeem, source });
        return true;
    }

    /**
     * Capture ticket code from URL and clean the path/query.
     * Supports /tickets/<code> and ?tickets=<code>.
     */
    captureTicketCodeFromUrl() {
        if (this.pendingTicketCode) return;

        const url = new URL(window.location.href);
        let code = null;
        let source = null;

        const pathMatch = url.pathname.match(/^\/tickets\/([^\/?#]+)/i);
        if (pathMatch && pathMatch[1]) {
            code = pathMatch[1];
            source = 'path';
        } else {
            const ticketParam = url.searchParams.get('tickets');
            if (ticketParam) {
                code = ticketParam;
                source = 'query';
            }
        }

        if (!code) return;

        const normalizedCode = this.normalizeTicketCode(code);
        const isValidLength = normalizedCode.length === 24;

        this.pendingTicketCode = {
            code: normalizedCode,
            autoRedeem: true,
            source,
            isValid: isValidLength
        };

        // Clean URL: remove /tickets path and tickets param, keep other params (e.g., s)
        let needsClean = false;
        if (source === 'path') {
            url.pathname = '/';
            needsClean = true;
        }
        if (url.searchParams.has('tickets')) {
            url.searchParams.delete('tickets');
            needsClean = true;
        }

        if (needsClean) {
            const nextUrl = url.toString();
            if (nextUrl !== window.location.href) {
                window.history.replaceState({}, '', nextUrl);
            }
        }
    }

    /**
     * Apply any pending ticket code after UI is ready.
     */
    handlePendingTicketCode() {
        if (!this.pendingTicketCode || !this.rightPanel) return;

        const { code, autoRedeem, source } = this.pendingTicketCode;
        this.pendingTicketCode = null;

        if (!code) return;
        this.ingestTicketCode(code, { autoRedeem: !!autoRedeem, source });
    }

    /**
     * Check URL for session parameter (?s=sessionId)
     * - First checks if it's a local session by ID
     * - Then checks if it's a local session by shareId (owned shares)
     * - Then checks if it's a local session by importedFrom (imported shares)
     * - If not found locally, tries to fetch as shared session from org
     */
    async checkForUrlSession() {
        const params = new URLSearchParams(window.location.search);
        const sessionId = params.get('s');

        if (!sessionId) {
            // No URL params - update URL to reflect current session (if any)
            if (this.state.currentSessionId) {
                this.updateUrlWithSession(this.state.currentSessionId);
            }
            return;
        }

        // Normalize input ID for comparison (handles dashes, case variations)
        const normalizedInput = this.normalizeId(sessionId);

        // Check if it's a local session by ID
        let localSessionById = this.state.sessions.find(s => this.normalizeId(s.id) === normalizedInput);
        if (!localSessionById) {
            const directSession = await chatDB.getSession(sessionId);
            if (directSession && this.normalizeId(directSession.id) === normalizedInput) {
                localSessionById = directSession;
                this.insertSessionIntoList(directSession);
            }
        }
        if (localSessionById) {
            await this.switchSession(localSessionById.id);
            return;
        }

        // Check if it's a local session by shareId (for sessions we shared)
        let localSessionByShareId = this.state.sessions.find(s =>
            s.shareInfo?.shareId && this.normalizeId(s.shareInfo.shareId) === normalizedInput
        );
        if (!localSessionByShareId) {
            localSessionByShareId = await chatDB.findSessionByShareId(sessionId);
            if (localSessionByShareId) {
                this.insertSessionIntoList(localSessionByShareId);
            }
        }
        if (localSessionByShareId) {
            await this.switchSession(localSessionByShareId.id);
            return;
        }

        // Check if it's a session we imported (by importedFrom field) - can receive updates
        let importedSession = this.state.sessions.find(s =>
            s.importedFrom && this.normalizeId(s.importedFrom) === normalizedInput
        );
        if (!importedSession) {
            importedSession = await chatDB.findSessionByImportedFrom(sessionId);
            if (importedSession) {
                this.insertSessionIntoList(importedSession);
            }
        }
        if (importedSession) {
            // User already imported this share - check for updates
            await this.checkForShareUpdates(sessionId, importedSession);
            return;
        }

        // Check if it's a session we forked from this share - user made their own changes
        let forkedSession = this.state.sessions.find(s =>
            s.forkedFrom && this.normalizeId(s.forkedFrom) === normalizedInput
        );
        if (!forkedSession) {
            forkedSession = await chatDB.findSessionByForkedFrom(sessionId);
            if (forkedSession) {
                this.insertSessionIntoList(forkedSession);
            }
        }
        if (forkedSession) {
            // User has a forked copy - ask if they want their copy or a fresh import
            const wantsFresh = await this.showForkedSessionPrompt(forkedSession);
            if (wantsFresh) {
                // User wants fresh copy - import as new session
                await this.importSharedSession(sessionId);
            } else {
                // User wants their forked copy
                await this.switchSession(forkedSession.id);
            }
            return;
        }

        // Not a local session - try to fetch as shared session from org
        await this.importSharedSession(sessionId);
    }

    /**
     * Show a prompt when user opens a share they've previously forked
     * @param {Object} forkedSession - The forked session
     * @returns {Promise<boolean>} True if user wants fresh import, false for their copy
     */
    showForkedSessionPrompt(forkedSession) {
        return this.ui.shareModals.showForkedPrompt(forkedSession);
    }

    /**
     * Check if a previously imported share has been updated
     * @param {string} shareId - The share ID to check
     * @param {Object} existingSession - The existing imported session
     */
    async checkForShareUpdates(shareId, existingSession) {
        const { hasUpdates, shareData } = await shareService.checkForUpdates(
            shareId,
            existingSession.importedCiphertext
        );

        if (!hasUpdates || !shareData) {
            await this.switchSession(existingSession.id);
            return;
        }

        // If local changes exist, never overwrite this session in place.
        // Offer "fresh copy" flow and keep local edits in the existing session.
        const hasLocalChanges = await this.hasLocalChangesSinceImport(existingSession);
        if (hasLocalChanges) {
            const wantsFresh = await this.showForkedSessionPrompt(existingSession);
            if (wantsFresh) {
                await this.markImportedSessionAsForked(existingSession);
                await this.importSharedSession(shareId);
            } else {
                await this.switchSession(existingSession.id);
            }
            return;
        }

        const wantsFresh = await this.showImportUpdatePrompt(existingSession);
        if (wantsFresh) {
            await this.importSharedSessionWithData(shareId, shareData);
        } else {
            await this.switchSession(existingSession.id);
        }
    }

    /**
     * Show a prompt asking user if they want to view their local copy or fetch latest
     * @param {Object} existingSession - The existing imported session
     * @returns {Promise<boolean>} True if user wants to fetch latest, false for local copy
     */
    showImportUpdatePrompt(existingSession) {
        return this.ui.shareModals.showUpdatePrompt(existingSession);
    }

    /**
     * Detect whether an imported session has local changes since the last import.
     * Uses timestamp baseline when available and falls back to message-count drift.
     * @param {Object} session - Imported session
     * @returns {Promise<boolean>} True if local changes are detected
     */
    async hasLocalChangesSinceImport(session) {
        if (!session?.importedFrom) return false;

        const baselineTs = Number(session.lastImportedAt);
        if (Number.isFinite(baselineTs) && Number(session.updatedAt) > baselineTs) {
            return true;
        }

        const importedCount = Number(session.importedMessageCount);
        if (!Number.isFinite(importedCount) || importedCount < 0) {
            return false;
        }

        const currentMessages = await chatDB.getSessionMessages(session.id);
        return currentMessages.length !== importedCount;
    }

    /**
     * Convert an imported session into a local fork so it no longer auto-updates from upstream share.
     * @param {Object} session - Current session
     */
    async markImportedSessionAsForked(session) {
        if (!session?.importedFrom) return;

        session.forkedFrom = session.importedFrom;
        session.importedFrom = null;
        session.importedCiphertext = null;
        await chatDB.saveSession(session);
    }

    /**
     * Simple password prompt for importing (no settings, just password)
     * @returns {Promise<string|null>} Password or null if cancelled
     */
    showImportPasswordPrompt(message) {
        return this.ui.shareModals.showImportPasswordPrompt(message);
    }

    /**
     * Decode share payload (handles both plaintext and encrypted)
     * @returns {Promise<Object|null>} Payload or null if cancelled/failed
     */
    async decodeSharePayload(shareData, promptMessage) {
        if (shareService.isPlaintextShare(shareData)) {
            // Plaintext - decode directly, no prompt needed
            return shareService.decodeShareData(shareData, null);
        }

        // Encrypted - show simple password prompt
        const password = await this.showImportPasswordPrompt(promptMessage);
        if (!password) return null;

        return shareService.decodeShareData(shareData, password);
    }

    /**
     * Normalize shared access payload (supports legacy sharedApiKey).
     * @param {Object|null} payload - Decoded share payload
     * @returns {Object|null} Normalized sharedAccess object
     */
    getSharedAccessFromPayload(payload) {
        if (!payload) return null;
        if (payload.sharedAccess?.token) {
            const backendId = payload.sharedAccess.backendId ||
                payload.session?.inferenceBackend ||
                inferenceService.getDefaultBackendId();
            return { ...payload.sharedAccess, backendId };
        }
        if (payload.sharedApiKey?.key) {
            return inferenceService.legacySharedApiKeyToSharedAccess(
                payload.sharedApiKey,
                payload.session?.inferenceBackend
            );
        }
        return null;
    }

    /**
     * Verify shared access credentials with the backend verifier (if supported).
     * @param {Object|null} sharedAccess - Shared access data from payload
     * @returns {Promise<Object|null|'cancel'>} Access data if valid, null to strip, 'cancel' to abort import
     */
    async verifySharedAccess(sharedAccess) {
        // No access data to verify
        if (!sharedAccess?.token) return null;

        const backendId = sharedAccess.backendId || inferenceService.getDefaultBackendId();
        const backend = inferenceService.getBackend(backendId);
        const verifier = backend?.verification;

        const validation = inferenceService.validateSharedAccess(sharedAccess, backendId);
        if (!validation.ok) {
            console.warn('⚠️ Shared access missing signature fields, cannot verify');
            const choice = await this.ui.shareModals.showSharedKeyVerificationFailedPrompt({
                error: 'Shared key is missing cryptographic signatures (legacy share format)',
                stationId: sharedAccess.stationId,
                isBanned: false,
                banReason: null
            });
            return choice === 'import_without_key' ? null : 'cancel';
        }

        // Check if key is already expired - silently strip without warning
        const nowUnix = Math.floor(Date.now() / 1000);
        if (sharedAccess.expiresAtUnix && sharedAccess.expiresAtUnix <= nowUnix) {
            console.log('⏰ Shared access expired, stripping silently');
            return null;
        }

        if (!verifier?.supports) {
            return sharedAccess;
        }

        const sessionAccess = inferenceService.sharedAccessToSessionAccess(backendId, sharedAccess);
        const accessInfo = sessionAccess?.info || sharedAccess;

        // Attempt verification with verifier
        console.log('🔐 Verifying shared access...');
        const verifyResult = await verifier.submitAccess(accessInfo);

        if (verifyResult?.status === 'verified') {
            console.log('✅ Shared access verified successfully');
            return {
                ...sharedAccess,
                verifierSubmitKeyProof: this.buildVerifierSubmitKeyProof(
                    verifyResult,
                    accessInfo
                )
            };
        }

        console.warn(
            '⚠️ Shared access was not explicitly verified; the key will not be imported'
        );

        const isBanned = !!verifyResult?.bannedStation;
        const banReason = verifyResult?.bannedStation?.reason;
        const detail = verifyResult?.detail || verifyResult?.data?.detail;
        const choice = await this.ui.shareModals.showSharedKeyVerificationFailedPrompt({
            error: verifyResult?.error?.message ||
                detail ||
                'The verifier did not explicitly approve this key',
            stationId: sharedAccess.stationId,
            isBanned,
            banReason
        });

        return choice === 'import_without_key' ? null : 'cancel';
    }

    /**
     * Update an existing imported session with new data from share
     * @param {string} shareId - Share ID
     * @param {Object} encryptedData - Already fetched encrypted data from org
     */
    async importSharedSessionWithData(shareId, encryptedData) {
        // Normalize shareId for consistent comparison and URL display
        const normalizedShareId = shareService.normalizeShareId(shareId);
        let existingSession = this.state.sessions.find(s => s.importedFrom === normalizedShareId);
        if (!existingSession) {
            existingSession = await chatDB.findSessionByImportedFrom(normalizedShareId);
            if (existingSession) {
                this.insertSessionIntoList(existingSession);
            }
        }
        if (!existingSession) {
            await this.importSharedSession(normalizedShareId);
            return;
        }

        try {
            // Decode payload (handles plaintext or encrypted with password prompt)
            const payload = await this.decodeSharePayload(
                encryptedData,
                'Enter the password to decrypt the updated chat:'
            );
            if (!payload) {
                await this.switchSession(existingSession.id);
                return;
            }

            shareService.validatePayload(payload);

            // Delete old messages for this session
            const oldMessages = await chatDB.getSessionMessages(existingSession.id);
            for (const msg of oldMessages) {
                await chatDB.deleteMessage(msg.id);
            }

            // Save new messages with existing session ID
            const messages = shareService.createMessagesFromPayload(
                payload.messages,
                existingSession.id,
                () => this.generateId()
            );
            for (const message of messages) {
                await chatDB.saveMessage(message);
            }

            // Update the existing session
            existingSession.title = payload.session.title || existingSession.title;
            existingSession.model = payload.session.model;
            existingSession.searchEnabled = payload.session.searchEnabled ?? true;
            existingSession.inferenceBackend = payload.session.inferenceBackend || existingSession.inferenceBackend || inferenceService.getDefaultBackendId();
            existingSession.responseMode = normalizeResponseMode(payload.session.responseMode);
            existingSession.councilConfig = normalizeCouncilConfig(payload.session.councilConfig, existingSession.model);
            existingSession.updatedAt = Date.now();
            existingSession.lastImportedAt = existingSession.updatedAt;
            existingSession.importedMessageCount = payload.messages.length;
            existingSession.importedCiphertext = encryptedData.ciphertext;
            this.applySessionConversationSearchText(existingSession, messages);

            // Verify and apply shared access if present
            const sharedAccess = this.getSharedAccessFromPayload(payload);
            if (sharedAccess?.token) {
                const verifiedAccess = await this.verifySharedAccess(sharedAccess);
                if (verifiedAccess === 'cancel') {
                    await this.switchSession(existingSession.id);
                    return;
                }
                if (verifiedAccess) {
                    const backendId = verifiedAccess.backendId || inferenceService.getDefaultBackendId();
                    const sessionAccess = inferenceService.sharedAccessToSessionAccess(backendId, verifiedAccess);
                    existingSession.inferenceBackend = backendId;
                    if (sessionAccess) {
                        existingSession.apiKey = sessionAccess.token;
                        existingSession.apiKeyInfo = sessionAccess.info;
                        existingSession.expiresAt = sessionAccess.expiresAt;
                    }
                } else {
                    // Verification failed, user chose to proceed without access
                    inferenceService.clearAccessInfo(existingSession);
                }
            }
            await chatDB.saveSession(existingSession);

            if (this.state.currentSessionId) {
                this.saveChatbarStateForSession(this.state.currentSessionId);
            }
            this.state.currentSessionId = existingSession.id;
            sessionStorage.setItem(SESSION_STORAGE_KEY, existingSession.id);
            await chatDB.saveSetting('currentSessionId', existingSession.id);

            this.updateUrlWithSession(normalizedShareId);
            this.renderSessions();
            await this.renderMessages();
            this.renderCurrentModel();
            this.resetMessageInputLayout({ resetScroll: true });
            this.restoreChatbarStateForSession(existingSession.id);
            this.updateShareButtonUI();

            if (this.rightPanel) {
                this.rightPanel.onSessionChange(existingSession);
            }

            console.log(`✅ Updated imported session: ${existingSession.title}`);
            this.showToast('Updated to latest version', 'success');

        } catch (error) {
            console.error('Failed to import shared session:', error);
            this.showToast(error.message || 'Failed to import shared chat', 'error');
            let session = this.state.sessions.find(s => s.importedFrom === normalizedShareId);
            if (!session) {
                session = await chatDB.findSessionByImportedFrom(normalizedShareId);
                if (session) {
                    this.insertSessionIntoList(session);
                }
            }
            if (session) {
                await this.switchSession(session.id);
            }
        }
    }

    /**
     * Update URL to include current session ID
     * @param {string} sessionId - Session ID (local or share)
     */
    updateUrlWithSession(sessionId) {
        if (!sessionId) {
            window.history.replaceState({}, '', window.location.pathname);
            return;
        }
        const url = new URL(window.location);
        url.searchParams.set('s', sessionId);
        window.history.replaceState({}, '', url);
    }

    /**
     * Copy the current session's URL to clipboard
     */
    async copySessionLink() {
        const session = this.getCurrentSession();
        if (!session) {
            this.showToast('No active session', 'error');
            return;
        }

        // Session ID is used for both local and shared URLs
        const url = new URL(window.location.origin + window.location.pathname);
        url.searchParams.set('s', session.id);

        await navigator.clipboard.writeText(url.toString());
        this.showToast('Link copied to clipboard', 'success');
    }

    /**
     * Import a shared session by downloading and decoding it
     * @param {string} shareId - Share ID from URL
     */
    async importSharedSession(shareId) {
        // Normalize shareId for consistent comparison and URL display
        const normalizedShareId = shareService.normalizeShareId(shareId);
        try {
            // Download share data (downloadShare also normalizes, but we need it for local use)
            const shareData = await shareService.downloadShare(normalizedShareId);

            // Decode payload (handles plaintext or encrypted with password prompt)
            const payload = await this.decodeSharePayload(
                shareData,
                'Enter the password to decrypt this shared chat:'
            );
            if (!payload) {
                window.history.replaceState({}, '', window.location.pathname);
                return;
            }

            // Validate payload structure
            shareService.validatePayload(payload);

            // Verify shared access if present with signature data
            const sharedAccess = this.getSharedAccessFromPayload(payload);
            const verifiedAccess = await this.verifySharedAccess(sharedAccess);
            if (verifiedAccess === 'cancel') {
                window.history.replaceState({}, '', window.location.pathname);
                return;
            }
            if (verifiedAccess) {
                payload.sharedAccess = verifiedAccess;
            } else {
                payload.sharedAccess = null;
                payload.sharedApiKey = null;
            }

            const session = shareService.createSessionFromPayload(
                payload,
                normalizedShareId,
                shareData.ciphertext,
                () => this.generateId()
            );

            // Save messages with new session ID
            const messages = shareService.createMessagesFromPayload(
                payload.messages,
                session.id,
                () => this.generateId()
            );
            this.applySessionConversationSearchText(session, messages);

            // Save session to DB
            this.state.sessions.unshift(session);
            this.state.sessionsById.set(session.id, session);
            await chatDB.saveSession(session);

            for (const message of messages) {
                await chatDB.saveMessage(message);
            }

            // Switch to imported session
            if (this.state.currentSessionId) {
                this.saveChatbarStateForSession(this.state.currentSessionId);
            }
            this.state.currentSessionId = session.id;
            sessionStorage.setItem(SESSION_STORAGE_KEY, session.id);
            await chatDB.saveSetting('currentSessionId', session.id);

            this.updateUrlWithSession(normalizedShareId);
            this.renderSessions();
            await this.renderMessages();
            this.renderCurrentModel();
            this.resetMessageInputLayout({ resetScroll: true });
            this.restoreChatbarStateForSession(session.id);
            this.updateShareButtonUI();

            if (this.rightPanel) {
                this.rightPanel.onSessionChange(session);
            }

            console.log(`✅ Imported shared session: ${session.title}`);
            this.showToast('Imported shared chat', 'success');

        } catch (error) {
            console.error('Failed to import shared session:', error);
            window.history.replaceState({}, '', window.location.pathname);
            this.showToast(error.message || 'Failed to import shared chat', 'error');
        }
    }


    /**
     * Share the current session with optional encryption
     * Opens the share management modal for settings
     */
    async shareCurrentSession() {
        const session = this.getCurrentSession();
        if (!session) {
            this.showToast('No active session to share', 'error');
            return null;
        }

        const messages = await chatDB.getSessionMessages(session.id);
        if (messages.length === 0) {
            this.showToast('Cannot share empty chat', 'error');
            return null;
        }

        // Use the management modal for all share operations
        return this.showShareManagementModal();
    }

    /**
     * Share current session with provided settings (no prompting)
     * @param {Object} settings - {password: string|null, ttlSeconds: number, shareApiKeyMetadata: boolean}
     */
    async shareCurrentSessionWithSettings(settings) {
        const session = this.getCurrentSession();
        if (!session) {
            this.showToast('No active session to share', 'error');
            return null;
        }

        const messages = await chatDB.getSessionMessages(session.id);
        if (messages.length === 0) {
            this.showToast('Cannot share empty chat', 'error');
            return null;
        }

        const isUpdate = !!session.shareInfo?.shareId;

        try {
            const result = await shareService.createOrUpdateShare(session, messages, settings);
            session.shareInfo = result.shareInfo;
            await chatDB.saveSession(session);

            await navigator.clipboard.writeText(result.shareUrl);
            this.showToast(isUpdate ? 'Share updated and link copied' : 'Share link copied to clipboard', 'success');

            this.renderSessions();
            if (this.rightPanel) this.rightPanel.render();

            return result.shareUrl;
        } catch (error) {
            console.error('Failed to share session:', error);
            this.showToast(error.message || 'Failed to share chat', 'error');
            return null;
        }
    }

    /**
     * Delete the share for the current session
     */
    async deleteCurrentSessionShare() {
        const session = this.getCurrentSession();
        if (!session?.shareInfo?.shareId || !session?.shareInfo?.token) {
            this.showToast('This session is not shared', 'error');
            return;
        }

        try {
            await shareService.deleteShare(session.shareInfo.shareId, session.shareInfo.token);

            // Clear share info from session
            delete session.shareInfo;
            await chatDB.saveSession(session);

            this.showToast('Share deleted', 'success');

            // Re-render sidebar to update button labels
            this.renderSessions();

        } catch (error) {
            console.error('Failed to delete share:', error);
            this.showToast(error.message || 'Failed to delete share', 'error');
        }
    }

    /**
     * Show share management modal with status, actions, and settings
     */
    async showShareManagementModal() {
        const session = this.getCurrentSession();
        if (!session) return;

        const messages = await chatDB.getSessionMessages(session.id);
        this.ui.shareModals.showManagementModal(session, messages, {
            onShare: async (settings) => {
                // Fork if imported
                if (session.importedFrom) {
                    session.forkedFrom = session.importedFrom;
                    session.importedFrom = null;
                    session.importedCiphertext = null;
                    await chatDB.saveSession(session);
                    this.updateUrlWithSession(session.id);
                }
                await this.shareCurrentSessionWithSettings(settings);
                this.updateShareButtonUI();
                await this.renderMessages();
            },
            onRevoke: async () => {
                await this.deleteCurrentSessionShare();
                this.updateShareButtonUI();
                await this.renderMessages();
            },
            showToast: (msg, type, durationMs) => this.showToast(msg, type, durationMs)
            });
    }

    /**
     * Update the share button visibility and state based on current session
     */
    updateShareButtonUI() {
        const btn = this.elements.shareBtn;
        const btnText = this.elements.shareBtnText;
        if (!btn) return;

        const session = this.getCurrentSession();

        // Hide if no session
        if (!session) {
            btn.classList.add('hidden');
            btn.classList.remove('flex');
            return;
        }

        // Show the button
        btn.classList.remove('hidden');
        btn.classList.add('flex');

        // Update button style based on share status
        const shareInfo = session.shareInfo;

        // Remove all color classes first
        btn.classList.remove('text-amber-600', 'text-status-success', 'text-muted-foreground');

        if (shareInfo?.shareId) {
            const isExpired = shareInfo.expiresAt && Date.now() > shareInfo.expiresAt;
            if (isExpired) {
                btn.classList.add('text-amber-600');
                if (btnText) btnText.textContent = 'Expired';
            } else {
                btn.classList.add('text-status-success');
                if (btnText) btnText.textContent = 'Shared';
            }
        } else {
            btn.classList.add('text-muted-foreground');
            if (btnText) btnText.textContent = 'Share';
        }
    }

    updateToastPosition() {
        const toast = document.getElementById('app-toast');
        if (!toast) return;

        const inputCard = document.getElementById('input-card');
        if (inputCard) {
            const rect = inputCard.getBoundingClientRect();
            // Position above input card with 16px gap
            const bottomSpace = window.innerHeight - rect.top + 16;
            toast.style.bottom = `${bottomSpace}px`;
        }
    }

    isWelcomeWorkflowActive() {
        if (!this.welcomePanel?.isOpen) return false;
        return ['welcome', 'redeeming', 'success'].includes(this.welcomePanel.step);
    }

    /**
     * Show a toast notification
     * @param {string} message - Message to display
     * @param {string} type - 'success' or 'error'
     * @param {number} durationMs - Time to auto-dismiss in milliseconds
     */
    showToast(message, type = 'success', durationMs = 3000) {
        if (this.isWelcomeWorkflowActive()) {
            return;
        }

        this.clearToast();

        const toast = document.createElement('div');
        toast.id = 'app-toast';
        const bgColor = type === 'error' ? 'bg-destructive text-destructive-foreground' : 'bg-muted text-foreground';
        // Removed fixed bottom-36, will be set by updateToastPosition
        toast.className = `fixed left-1/2 -translate-x-1/2 z-[100] px-4 py-2 rounded-lg shadow-lg text-sm border border-border/50 ${bgColor} animate-in fade-in slide-in-from-bottom-4`;
        toast.textContent = message;
        document.body.appendChild(toast);

        this.updateToastPosition();

        this._toastTimeout = setTimeout(() => {
            toast.classList.add('animate-out', 'fade-out', 'slide-out-to-bottom-4');
            setTimeout(() => toast.remove(), 150);
        }, durationMs);
    }

    clearToast() {
        document.getElementById('app-toast')?.remove();
        clearTimeout(this._toastTimeout);
        this._toastTimeout = null;
    }

    clearAccountHighlight() {
        const btn = document.getElementById('account-tab-btn');
        const showBtn = document.getElementById('show-sidebar-btn');
        if (btn) btn.classList.remove('account-glow');
        if (showBtn) showBtn.classList.remove('account-glow');
    }

    highlightAccountButton() {
        this.clearAccountHighlight();
        const sidebar = this.elements?.sidebar;
        const sidebarWidth = sidebar ? sidebar.getBoundingClientRect().width : 0;
        const sidebarHidden = sidebarWidth < 40;
        const btn = document.getElementById('account-tab-btn');
        const showBtn = document.getElementById('show-sidebar-btn');
        if (btn) {
            btn.classList.add('account-glow');
        }
        if (sidebarHidden && showBtn) {
            showBtn.classList.add('account-glow');
        }
    }

    showLoadingToast(message) {
        if (this.isWelcomeWorkflowActive()) {
            return () => {};
        }

        this.clearToast();

        const toast = document.createElement('div');
        toast.id = 'app-toast';
        // Use same styling as showToast for consistency
        toast.className = 'fixed left-1/2 -translate-x-1/2 z-[100] px-4 py-2 rounded-lg shadow-lg text-sm border border-border/50 bg-muted text-foreground animate-in fade-in slide-in-from-bottom-4 flex items-center gap-2';

        const spinner = document.createElement('span');
        spinner.className = 'link-preview-spinner';
        const text = document.createElement('span');
        text.textContent = message;

        toast.appendChild(spinner);
        toast.appendChild(text);
        document.body.appendChild(toast);

        this.updateToastPosition();

        return () => {
            toast.classList.add('animate-out', 'fade-out', 'slide-out-to-bottom-4');
            setTimeout(() => toast.remove(), 150);
        };
    }

    showUpdateToast() {
        if (this.isWelcomeWorkflowActive()) {
            return;
        }

        if (this.updateToastVisible) {
            return;
        }

        const existingToast = document.getElementById('app-update-toast');
        if (existingToast) {
            existingToast.remove();
        }

        const toast = document.createElement('div');
        toast.id = 'app-update-toast';
        toast.className = 'update-toast';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');

        const label = document.createElement('span');
        label.className = 'update-toast__label';
        label.textContent = 'Update available';

        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'update-toast__action';
        refreshBtn.textContent = 'Refresh';
        refreshBtn.addEventListener('click', () => {
            this.clearUpdateToast();
            window.location.reload();
        });

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'update-toast__dismiss';
        dismissBtn.setAttribute('aria-label', 'Dismiss update');
        dismissBtn.innerHTML = `
            <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
        `;
        dismissBtn.addEventListener('click', () => {
            this.updateToastDismissed = true;
            this.clearUpdateToast();
        });

        toast.appendChild(label);
        toast.appendChild(refreshBtn);
        toast.appendChild(dismissBtn);
        document.body.appendChild(toast);
        this.updateToastVisible = true;
    }


    openSplitCodeDismissWarning(onConfirm, splitDetails = {}) {
        if (this.splitCodeWarningOverlay) return;

        const details = typeof splitDetails === 'string'
            ? { code: splitDetails }
            : (splitDetails || {});
        const code = typeof details.code === 'string' ? details.code : '';
        const ticketsConsumed = Number.isFinite(details.ticketsConsumed) && details.ticketsConsumed > 0
            ? Math.floor(details.ticketsConsumed)
            : null;
        const shareUrl = typeof details.shareUrl === 'string' ? details.shareUrl : '';
        const safeCode = this.escapeHtml(code);
        const safeShareUrl = this.escapeHtml(shareUrl);
        const ticketCountNote = ticketsConsumed
            ? `Ticket code created for ${ticketsConsumed} valid ticket${ticketsConsumed === 1 ? '' : 's'}.`
            : '';

        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';

        overlay.innerHTML = `
            <div class="dialog-content max-w-[320px] rounded-xl border border-border bg-background shadow-xl p-6">
                <h3 class="text-sm font-medium text-foreground mb-4">Dismiss code?</h3>

                ${ticketCountNote ? `
                <p class="text-xs text-muted-foreground mb-3">
                    ${ticketCountNote}
                </p>
                ` : ''}

                <div class="mb-4 p-3 bg-muted/20 rounded-md border border-border">
                    <code class="block font-mono text-xs text-foreground break-all text-center">${safeCode}</code>
                </div>

                ${shareUrl ? `
                <div class="mb-4 p-3 bg-muted/20 rounded-md border border-border">
                    <div class="text-[10px] text-muted-foreground mb-1">Ticket share link</div>
                    <code class="block font-mono text-[10px] text-foreground break-all">${safeShareUrl}</code>
                </div>
                ` : ''}

                <p class="text-xs text-muted-foreground mb-4">
                    Make sure you've copied this code${shareUrl ? ' and link' : ''}.
                </p>

                <div class="flex gap-2">
                    <button id="cancel-split-code-dismiss" class="btn-ghost-hover flex-1 px-4 py-1.5 text-xs rounded-md border border-border bg-background text-foreground transition-colors" type="button">
                        Cancel
                    </button>
                    <button id="confirm-split-code-dismiss" class="flex-1 px-4 py-1.5 text-xs rounded-md bg-destructive text-destructive-foreground transition-all duration-200 hover:bg-destructive/90" type="button">
                        Dismiss
                    </button>
                </div>
            </div>
        `;

        const closeWarning = () => {
            overlay.remove();
            this.splitCodeWarningOverlay = null;
        };

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                closeWarning();
            }
        });

        const cancelBtn = overlay.querySelector('#cancel-split-code-dismiss');
        const confirmBtn = overlay.querySelector('#confirm-split-code-dismiss');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => closeWarning());
        }
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                closeWarning();
                if (typeof onConfirm === 'function') {
                    onConfirm();
                }
            });
        }

        document.body.appendChild(overlay);
        this.splitCodeWarningOverlay = overlay;
    }

    clearUpdateToast() {
        document.getElementById('app-update-toast')?.remove();
        this.updateToastVisible = false;
    }

    getCurrentAppHash() {
        // Extract hash from the loaded app script tag (e.g., app-a1b2c3d4.js)
        const scripts = document.querySelectorAll('script[src*="app-"]');
        for (const script of scripts) {
            const match = script.src.match(/app-([a-z0-9]+)\.js/i);
            if (match) return match[1];
        }
        return null;
    }

    async fetchBuildHash() {
        try {
            const response = await fetch('/build.json', {
                cache: 'no-store',
                credentials: 'omit',
                headers: { 'cache-control': 'no-cache', pragma: 'no-cache' }
            });
            if (!response.ok) return null;
            const data = await response.json();
            return data?.hash || null;
        } catch {
            return null;
        }
    }

    isElectronEnvironment() {
        const ua = navigator?.userAgent || '';
        return !!(window?.process?.versions?.electron || ua.includes('Electron'));
    }

    initUpdateWatcher() {
        // Skip in Electron or dev mode (no hashed script)
        const currentHash = this.getCurrentAppHash();
        if (this.isElectronEnvironment() || !currentHash) {
            return;
        }

        const checkForUpdate = async () => {
            if (this.updateCheckInFlight || this.updateToastDismissed) {
                return;
            }

            this.updateCheckInFlight = true;
            try {
                const latestHash = await this.fetchBuildHash();
                if (!latestHash) return;

                if (latestHash !== currentHash) {
                    this.showUpdateToast();
                }
            } finally {
                this.updateCheckInFlight = false;
            }
        };

        setTimeout(() => {
            checkForUpdate().catch(() => {});
        }, UPDATE_CHECK_INITIAL_DELAY_MS);

        this.updateCheckInterval = setInterval(() => {
            if (document.visibilityState === 'visible') {
                checkForUpdate().catch(() => {});
            }
        }, UPDATE_CHECK_INTERVAL_MS);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                checkForUpdate().catch(() => {});
            }
        });
    }

    /**
     * Initialize the verifier service for station verification
     */
    initVerifier() {
        const verifier = inferenceService.getVerificationAdapter();
        if (!verifier?.supports) {
            return;
        }

        // Initialize verifier (loads cached broadcast data)
        verifier.init();

        // Set up banned warning callback - show warning and clear API key when station gets banned
        verifier.setBannedWarningCallback(async ({ stationId, reason, bannedAt, session }) => {
            console.log(`🚫 Station ${stationId} banned: ${reason}`);

            const accessInfo = session ? inferenceService.getAccessInfo(session) : null;
            if (accessInfo?.info?.stationId === stationId) {
                // Show warning modal (which also clears the key)
                await this.showBannedStationWarningModal({
                    stationId,
                    reason,
                    bannedAt,
                    sessionId: session.id
                });
            }
        });

        // Start periodic broadcast checks
        verifier.startBroadcastCheck(() => this.getCurrentSession());
    }

    setupInputAreaObserver() {
        // Find the input container element
        const inputContainer = document.querySelector('.absolute.bottom-0.left-0.right-0');
        if (!inputContainer) return;

        // Create a ResizeObserver to watch for size changes
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const inputHeight = entry.contentRect.height;
                // Add extra padding to ensure messages aren't covered
                const paddingBottom = inputHeight + 16; // 16px extra for spacing
                this.elements.messagesContainer.style.paddingBottom = `${paddingBottom}px`;

                // Auto-scroll to bottom using our reliable scroll helper
                this.scrollToBottom();
            }
        });

        resizeObserver.observe(inputContainer);
    }

    async loadModels() {
        this.state.modelsLoading = true;

        // Tag model fetches with current session if available
        if (window.networkLogger && this.state.currentSessionId) {
            window.networkLogger.setCurrentSession(this.state.currentSessionId);
        }

        try {
            const fetchedModels = await inferenceService.fetchModels(this.getCurrentSession());
            this.state.models = this.filterDisabledModels(fetchedModels);
        } catch (error) {
            console.error('Failed to load models:', error);
            // Fallback models are already set in API
        }
        this.state.modelsVersion += 1;
        this.state.modelsLoading = false;
    }

    /**
     * Migrates sessions in background without blocking UI.
     * Updates local state immediately, persists to DB async.
     */
    migrateSessionsInBackground(sessions) {
        const sessionsToSave = [];

        for (const session of sessions) {
            let needsSave = false;

            // Migrate updatedAt if missing
            if (!session.updatedAt) {
                session.updatedAt = session.createdAt;
                needsSave = true;
            }

            // Normalize model name
            const normalizedModel = this.normalizeModelName(session.model);
            if (normalizedModel !== session.model) {
                session.model = normalizedModel;
                needsSave = true;
            }

            if (!session.inferenceBackend) {
                session.inferenceBackend = inferenceService.getDefaultBackendId();
                needsSave = true;
            }

            if (this.normalizeSessionCouncilState(session)) {
                needsSave = true;
            }

            if (needsSave) {
                sessionsToSave.push(session);
            }
        }

        // Save all migrations in parallel (non-blocking)
        if (sessionsToSave.length > 0) {
            Promise.all(sessionsToSave.map(s => chatDB.saveSession(s)))
                .catch(err => console.warn('Session migration failed:', err));
        }
    }

    /**
     * Generates a unique ID for sessions and messages using ULID.
     * Format: 5-5-5-6 lowercase (e.g., 01j7x-kqnp2-4mvwt-ghr85c)
     * Uses 21 chars: 10 timestamp (48-bit) + 11 random (55-bit)
     * @returns {string} Unique ULID with dashes for readability
     */
    generateId() {
        const raw = generateSessionId();
        return `${raw.slice(0,5)}-${raw.slice(5,10)}-${raw.slice(10,15)}-${raw.slice(15)}`;
    }

    /**
     * Normalize an ID for comparison/lookup (strip dashes, uppercase).
     * Handles both old format and new ULID format with dashes.
     * @param {string} id - ID to normalize
     * @returns {string} Normalized ID
     */
    normalizeId(id) {
        return id.replace(/-/g, '').toUpperCase();
    }

    /**
     * Formats a timestamp for display.
     * @param {number} timestamp - Unix timestamp
     * @returns {string} Formatted time string (HH:MM:SS)
     */
    formatTime(timestamp) {
        const messageTime = new Date(timestamp);
        return messageTime.toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    /**
     * Normalizes any stored model reference into the canonical display name
     * used throughout the UI.
     *
     * Accepts:
     * - A model ID (e.g. "openai/gpt-5.1-chat"), which is converted via
     *   backend display-name overrides when available.
     * - Legacy aliases (e.g. "OpenAI: GPT-5.1 Chat"), which are mapped to
     *   canonical display names.
     * - Provider labels with date suffixes (e.g. "... 20260219"), normalized
     *   by the shared model-name standardizer.
     *
     * Returns the original value when no conversion is necessary so that
     * newer/custom names remain untouched.
     *
     * @param {string|null} modelIdOrName
     * @returns {string|null}
     */
    normalizeModelName(modelIdOrName) {
        return normalizeModelNameValue(modelIdOrName, {
            getStandardizedModelDisplayName,
            getDisplayName: (modelId, fallback) => inferenceService.getDisplayName(modelId, fallback, this.getCurrentSession())
        });
    }

    /**
     * Upgrades users who were effectively on the old default model to the new
     * default model. Only applies to stored *preference* (not per-session model).
     * @param {string|null} normalizedModelName
     * @returns {string|null}
     */
    upgradeDefaultModelPreference(normalizedModelName) {
        return upgradeDefaultModelPreferenceValue(
            normalizedModelName,
            PREVIOUS_DEFAULT_MODEL_NAMES,
            this.getDefaultModelName()
        );
    }

    async refreshDefaultModelPreferenceForAvailabilityUpdate() {
        const storedModelPreference = await chatDB.getSetting('selectedModel');
        const update = resolveDefaultModelPreferenceUpdateValue({
            storedModelPreference,
            pendingModelName: this.state.pendingModelName,
            hasCurrentSession: !!this.getCurrentSession(),
            normalizeModelName: (modelName) => this.normalizeModelName(modelName),
            upgradeDefaultModelPreference: (modelName) => this.upgradeDefaultModelPreference(modelName)
        });

        if (update.shouldSaveStoredPreference) {
            await chatDB.saveSetting('selectedModel', update.upgradedStoredModelPreference);
        }

        if (update.pendingChanged) {
            this.state.pendingModelName = update.nextPendingModelName;
        }

        return update.changed;
    }

    /**
     * Creates a new chat session.
     * @param {string} title - Session title
     * @returns {Promise<Object>} The created session
     */
    async createSession(title = 'New Chat') {
        if (!await this.ensureDatabaseReady()) {
            return null;
        }

        // Use pending model if available, otherwise fall back to selected model
        const storedModelPreference = await chatDB.getSetting('selectedModel');
        const normalizedSelectedModelName = this.upgradeDefaultModelPreference(
            this.normalizeModelName(storedModelPreference)
        );
        if (normalizedSelectedModelName && normalizedSelectedModelName !== storedModelPreference) {
            await chatDB.saveSetting('selectedModel', normalizedSelectedModelName);
        }

        const pendingModelName = this.normalizeModelName(this.state.pendingModelName);
        if (pendingModelName !== this.state.pendingModelName) {
            this.state.pendingModelName = pendingModelName;
        }
        const modelNameForNewSession = pendingModelName || normalizedSelectedModelName || null;

        const pendingCouncilConfig = this.pendingCouncilConfig
            ? normalizeCouncilConfig(this.pendingCouncilConfig, modelNameForNewSession)
            : this.buildPersistedParallelCouncilConfig(modelNameForNewSession);
        const usePendingCouncilMode = pendingCouncilConfig.enabled === true;
        const useCouncilLayoutPreference = this.pendingCouncilLayoutPreference === true || usePendingCouncilMode;
        this.pendingCouncilConfig = null;
        this.pendingCouncilLayoutPreference = false;
        const session = {
            id: this.generateId(),
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            model: modelNameForNewSession,
            responseMode: usePendingCouncilMode ? RESPONSE_MODE_COUNCIL : RESPONSE_MODE_SINGLE,
            councilConfig: pendingCouncilConfig || buildDefaultCouncilConfig(modelNameForNewSession),
            inferenceBackend: inferenceService.getDefaultBackendId(),
            apiKey: null,
            apiKeyInfo: null,
            expiresAt: null,
            memoryKey: null,
            memoryKeyInfo: null,
            memoryRetrievedContext: { version: 1, entries: [] },
            scrubberKey: null,
            scrubberKeyInfo: null,
            searchEnabled: this.searchEnabled,
            ...(useCouncilLayoutPreference ? { hasCouncilLayoutPreference: true } : {})
        };

        // Clear pending model since it's now part of the session
        this.state.pendingModelName = null;

        this.state.sessions.unshift(session);
        this.state.sessionsById.set(session.id, session);
        this.state.currentSessionId = session.id;

        this.chatInput.updateSearchToggleUI();
        this.chatInput.updateMemoryToggleUI();

        await chatDB.saveSession(session);
        sessionStorage.setItem(SESSION_STORAGE_KEY, session.id);
        await chatDB.saveSetting('currentSessionId', session.id);

        // Update URL to reflect new session
        this.updateUrlWithSession(session.id);

        // Hide message navigation immediately for new empty session
        if (this.messageNavigation) {
            this.messageNavigation.hide();
        }

        // Hide scroll-to-bottom button for new session
        this.hideScrollToBottomButton();

        this.renderSessions();
        this.renderMessages();
        this.renderCurrentModel();

        // Update input state for new session
        this.updateInputState();
        this.updateShareButtonUI();

        // Notify right panel of session change
        if (this.rightPanel) {
            this.rightPanel.onSessionChange(session);
        }

        return session;
    }

    /**
     * Switches to a different session.
     * @param {string} sessionId - ID of the session to switch to
     */
    async switchSession(sessionId) {
        if (!sessionId || sessionId === this.state.currentSessionId) {
            return;
        }

        const previousSessionId = this.state.currentSessionId;
        await this.ensureSessionLoaded(sessionId);

        // Another user action may have switched/cleared sessions while loading.
        if (this.state.currentSessionId !== previousSessionId) {
            return;
        }

        this.saveCurrentSessionScrollPosition();
        if (previousSessionId) {
            this.saveChatbarStateForSession(previousSessionId);
        }

        // Clear edit state when switching sessions
        this.editingMessageId = null;
        this.editDrafts.clear();

        this.state.currentSessionId = sessionId;
        sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
        chatDB.saveSetting('currentSessionId', sessionId);

        // Keep current search state (global setting)
        const session = this.state.sessionsById.get(sessionId) || this.state.sessions.find(s => s.id === sessionId);
        this.cachedModelDisplayMetadata = inferenceService.getCachedModels(session);
        if (session) {
            this.chatInput.updateSearchToggleUI();
        }

        // Update URL to reflect current session
        this.updateUrlWithSession(sessionId);

        // Clear message navigation immediately before switching to prevent showing stale data
        if (this.messageNavigation) {
            this.messageNavigation.hide();
        }

        // Hide scroll-to-bottom button immediately to prevent it from persisting
        this.hideScrollToBottomButton();

        this.renderSessions();
        this.renderMessages();
        this.renderCurrentModel();
        if (this.sidebar && !this.isMobileView()) {
            this.sidebar.scrollToSession(sessionId);
        }

        // Update UI based on new session's streaming state
        this.resetMessageInputLayout({ resetScroll: true });
        this.restoreChatbarStateForSession(sessionId);
        this.updateShareButtonUI();

        // Notify right panel of session change
        if (this.rightPanel && session) {
            this.rightPanel.onSessionChange(session);
        }
        if (this.floatingPanel && session) {
            this.floatingPanel.render();
        }

        // Close sidebar on mobile after switching session
        if (this.isMobileView()) {
            this.hideSidebar();
        }
    }

    /**
     * Gets the current active session.
     * @returns {Object|undefined} Current session or undefined
     */
    getCurrentSession() {
        const sessionId = this.state.currentSessionId;
        if (!sessionId) return null;
        const session = this.state.sessionsById.get(sessionId) || this.state.sessions.find(s => s.id === sessionId);
        if (session) {
            inferenceService.ensureSessionBackend(session);
        }
        return session;
    }

    normalizeSessionCouncilState(session) {
        if (!session || typeof session !== 'object') {
            return false;
        }

        let needsSave = false;
        const normalizedResponseMode = normalizeResponseMode(session.responseMode);
        if (session.responseMode !== normalizedResponseMode) {
            session.responseMode = normalizedResponseMode;
            needsSave = true;
        }

        const fallbackModelName = this.normalizeModelName(session.model) || session.model || null;
        const normalizedCouncilState = normalizeCouncilConfig(session.councilConfig, fallbackModelName);
        const hasModernCouncilShape = Object.prototype.hasOwnProperty.call(session.councilConfig || {}, 'synthesisModel')
            && Object.prototype.hasOwnProperty.call(session.councilConfig || {}, 'outputMode')
            && Object.prototype.hasOwnProperty.call(session.councilConfig || {}, 'reviewEnabled')
            && !Object.prototype.hasOwnProperty.call(session.councilConfig || {}, 'chairmanModel');
        if (!areCouncilConfigsEqual(session.councilConfig, normalizedCouncilState) || !hasModernCouncilShape) {
            session.councilConfig = normalizedCouncilState;
            needsSave = true;
        }

        return needsSave;
    }

    isCouncilModeActive(session = this.getCurrentSession()) {
        if (!COUNCIL_MODE_FEATURE_FLAG || !session) {
            return false;
        }
        const fallbackModelName = this.normalizeModelName(session.model) || session.model || null;
        const normalizedCouncilState = normalizeCouncilConfig(session.councilConfig, fallbackModelName);
        return normalizeResponseMode(session.responseMode) === RESPONSE_MODE_COUNCIL
            && normalizedCouncilState.enabled === true;
    }

    messageUsesCouncilLayout(message) {
        return !!message?.council?.enabled || Array.isArray(message?.council?.stage1);
    }

    messagesUseCouncilLayout(messages = []) {
        return Array.isArray(messages) && messages.some((message) => this.messageUsesCouncilLayout(message));
    }

    sessionUsesCouncilLayout(session = this.getCurrentSession(), messages = null) {
        if (!COUNCIL_MODE_FEATURE_FLAG) return false;
        const isPendingCouncilMode = !session && this.pendingCouncilConfig?.enabled === true;
        const isPendingCouncilLayoutPreference = !session && this.pendingCouncilLayoutPreference === true;
        return this.isCouncilModeActive(session)
            || isPendingCouncilMode
            || isPendingCouncilLayoutPreference
            || session?.hasCouncilLayoutPreference === true
            || session?.hasCouncilTranscript === true
            || this.messagesUseCouncilLayout(messages);
    }

    shouldUpdateCouncilLayoutForSession(session) {
        return !!(session?.id && this.isViewingSession(session.id));
    }

    async setSessionCouncilTranscriptHint(session, hasCouncilTranscript, options = {}) {
        if (!session) return false;

        const nextHasCouncilTranscript = hasCouncilTranscript === true;
        const currentHasCouncilTranscript = session.hasCouncilTranscript === true;
        const changed = currentHasCouncilTranscript !== nextHasCouncilTranscript;

        if (changed) {
            if (nextHasCouncilTranscript) {
                session.hasCouncilTranscript = true;
            } else {
                delete session.hasCouncilTranscript;
            }
        }

        if (this.shouldUpdateCouncilLayoutForSession(session)) {
            this.updateCouncilLayoutMode(session);
        }

        if (changed && options.persist !== false) {
            await chatDB.saveSession(session);
        }

        return changed;
    }

    async markSessionHasCouncilTranscript(session, options = {}) {
        return this.setSessionCouncilTranscriptHint(session, true, options);
    }

    async recomputeSessionCouncilTranscriptHint(session, messages = null, options = {}) {
        if (!session?.id) return false;
        const sessionMessages = Array.isArray(messages)
            ? messages
            : await chatDB.getSessionMessages(session.id);
        return this.setSessionCouncilTranscriptHint(
            session,
            this.messagesUseCouncilLayout(sessionMessages),
            options
        );
    }

    persistCouncilLayoutHintFromMessages(session, messages = []) {
        return this.recomputeSessionCouncilTranscriptHint(session, messages, { persist: true });
    }

    async setCouncilModeForCurrentSession(options = {}) {
        const session = this.getCurrentSession();
        if (!session) return null;

        const fallbackModelName = this.normalizeModelName(session.model)
            || session.model
            || inferenceService.getDefaultModelName(session);
        const requestedEnabled = options.enabled !== undefined
            ? options.enabled === true
            : true;
        const requestedMembers = Array.isArray(options.members)
            ? options.members
            : (session.councilConfig?.members || []);
        const currentCouncilConfig = normalizeCouncilConfig(session.councilConfig, fallbackModelName);
        const requestedSynthesisModel = options.synthesisModel !== undefined
            ? options.synthesisModel
            : (options.chairmanModel !== undefined ? options.chairmanModel : currentCouncilConfig.synthesisModel);
        const requestedOutputMode = !requestedEnabled
            ? COUNCIL_OUTPUT_PARALLEL
            : (options.outputMode !== undefined
                ? options.outputMode
                : currentCouncilConfig.outputMode);

        session.responseMode = requestedEnabled
            ? RESPONSE_MODE_COUNCIL
            : RESPONSE_MODE_SINGLE;
        session.councilConfig = normalizeCouncilConfig(
            {
                enabled: requestedEnabled,
                members: requestedMembers,
                synthesisModel: requestedSynthesisModel,
                outputMode: requestedOutputMode,
                reviewEnabled: false
            },
            fallbackModelName
        );
        if (requestedEnabled) {
            session.hasCouncilLayoutPreference = true;
        }
        if (!requestedEnabled && this.councilController) {
            this.councilController.seedSessionAccessFromPrimaryLane(session);
        }
        await chatDB.saveSession(session);
        this.renderSessions();
        this.renderCurrentModel();
        if (this.editingMessageId && this.editDrafts.has(this.editingMessageId)) {
            await this.refreshEditMessage(this.editingMessageId);
        }
        return session;
    }

    getPendingCouncilConfig() {
        return this.pendingCouncilConfig;
    }

    setPendingCouncilConfig(config) {
        const fallbackModelName = this.normalizeModelName(this.state.pendingModelName)
            || this.state.pendingModelName
            || inferenceService.getDefaultModelName();
        this.pendingCouncilConfig = normalizeCouncilConfig(config, fallbackModelName);
        if (this.pendingCouncilConfig.enabled === true) {
            this.pendingCouncilLayoutPreference = true;
        }
        if (!this.state.currentSessionId) {
            this.rightPanel?.onSessionChange?.(null);
        }
        return this.pendingCouncilConfig;
    }

    buildPersistedParallelCouncilConfig(fallbackModelName = null) {
        const primaryModel = this.normalizeModelName(fallbackModelName)
            || fallbackModelName
            || this.normalizeModelName(this.state.pendingModelName)
            || this.state.pendingModelName
            || inferenceService.getDefaultModelName();
        const secondaryModel = typeof this.parallelSecondaryModel === 'string' && this.parallelSecondaryModel.trim()
            ? this.parallelSecondaryModel.trim()
            : null;
        const synthesisModel = typeof this.parallelSynthesisModel === 'string' && this.parallelSynthesisModel.trim()
            ? this.parallelSynthesisModel.trim()
            : primaryModel;
        return normalizeCouncilConfig({
            enabled: this.parallelModeEnabled === true,
            members: [primaryModel, secondaryModel].filter(Boolean),
            synthesisModel,
            outputMode: this.parallelOutputMode,
            reviewEnabled: false
        }, primaryModel);
    }

    setParallelDefaults(options = {}) {
        this.parallelModeEnabled = options.enabled === true;
        this.parallelSecondaryModel = typeof options.secondaryModel === 'string' && options.secondaryModel.trim()
            ? options.secondaryModel.trim()
            : null;
        this.parallelSynthesisModel = typeof options.synthesisModel === 'string' && options.synthesisModel.trim()
            ? options.synthesisModel.trim()
            : null;
        this.parallelOutputMode = normalizeCouncilOutputMode(options.outputMode);
        return {
            enabled: this.parallelModeEnabled,
            secondaryModel: this.parallelSecondaryModel,
            synthesisModel: this.parallelSynthesisModel,
            outputMode: this.parallelOutputMode
        };
    }

    applyPersistedParallelPendingConfig(fallbackModelName = null) {
        this.pendingCouncilConfig = this.buildPersistedParallelCouncilConfig(fallbackModelName);
        this.pendingCouncilLayoutPreference = this.parallelModeEnabled === true;
        if (!this.state.currentSessionId) {
            this.rightPanel?.onSessionChange?.(null);
        }
        return this.pendingCouncilConfig;
    }

    async ensureDatabaseReady() {
        try {
            await this.dbReadyPromise;
            return true;
        } catch (error) {
            console.error('Database is not ready:', error);
            this.showToast('Failed to open local chat storage. Close other tabs and reload.', 'error');
            return false;
        }
    }

    /**
     * Checks if the user is currently viewing the specified session.
     * Used to gate UI updates for streaming to prevent cross-session pollution.
     * @param {string} sessionId - Session ID to check
     * @returns {boolean} True if the user is viewing this session
     */
    isViewingSession(sessionId) {
        return this.state.currentSessionId === sessionId;
    }

    /**
     * Gets the streaming state for a session
     * @param {string} sessionId - Session ID
     * @returns {Object} Streaming state object with isStreaming and abortController
     */
    getSessionStreamingState(sessionId) {
        if (!this.sessionStreamingStates.has(sessionId)) {
            this.sessionStreamingStates.set(sessionId, {
                isStreaming: false,
                abortController: null,
                phase: 'requesting-key'
            });
        }
        return this.sessionStreamingStates.get(sessionId);
    }

    /**
     * Updates streaming state for a session
     * @param {string} sessionId - Session ID
     * @param {boolean} isStreaming - Whether session is streaming
     * @param {AbortController} abortController - Abort controller for the stream
     */
    normalizePendingPhase(phase) {
        return normalizeStreamingPendingPhase(phase);
    }

    advancePendingStateAfterAccessGranted(sessionId, typingId = null) {
        this.updateSessionStreamingPhase(sessionId, 'waiting-response');
        if (typingId) {
            this.updateTypingIndicator(typingId, 'waiting-response');
        }
    }

    isAccessCreditExhaustedError(error) {
        return isAccessCreditExhaustedErrorValue(error);
    }

    getTicketCost(modelId, reasoningEnabled = this.reasoningEnabled) {
        return getTicketCost(modelId, reasoningEnabled);
    }

    async refreshAccessAfterCreditExhaustion(session, { typingId = null } = {}) {
        if (!session) throw new Error('No active session found.');

        const accessLabel = inferenceService.getAccessLabel(session);
        this.showToast('Exhausted current ephemeral key, requesting a new key', 'success');

        inferenceService.clearAccessInfo(session);
        await chatDB.saveSession(session);
        this.updateSessionStreamingPhase(session.id, 'requesting-key');
        if (typingId) {
            this.updateTypingIndicator(typingId, 'requesting-key');
        }
        if (this.rightPanel) {
            this.rightPanel.onSessionChange(session);
        }
        if (this.floatingPanel) {
            this.floatingPanel.showMessage(`Refreshing ${accessLabel}...`, 'info');
        }

        await this.acquireAndSetAccess(session, {
            onGranted: () => {
                this.advancePendingStateAfterAccessGranted(session.id, typingId);
            }
        });

        if (this.floatingPanel) {
            this.floatingPanel.showMessage(`${accessLabel} refreshed`, 'success', 2000);
        }
    }

    setSessionStreamingState(sessionId, isStreaming, abortController = null, phase = 'requesting-key') {
        const existingState = this.getSessionStreamingState(sessionId);
        const normalizedPhase = this.normalizePendingPhase(phase);
        this.sessionStreamingStates.set(sessionId, {
            isStreaming,
            abortController,
            phase: isStreaming
                ? (existingState.isStreaming ? this.normalizePendingPhase(existingState.phase) : normalizedPhase)
                : 'requesting-key'
        });

        // Start periodic button visibility check when streaming starts
        if (isStreaming && !this.scrollButtonCheckInterval) {
            this.scrollButtonCheckInterval = setInterval(() => {
                this.updateScrollButtonVisibility();
            }, 200); // Check every 200ms during streaming
        } else if (!isStreaming && this.scrollButtonCheckInterval) {
            clearInterval(this.scrollButtonCheckInterval);
            this.scrollButtonCheckInterval = null;
        }

        if (!isStreaming) {
            this.flushPendingStorageRefresh();
        }

        // Update UI when streaming state changes
        this.updateInputState();
    }

    updateSessionStreamingPhase(sessionId, phase) {
        const state = this.getSessionStreamingState(sessionId);
        this.sessionStreamingStates.set(sessionId, {
            ...state,
            phase: this.normalizePendingPhase(phase)
        });
    }

    /**
     * Checks if current session is streaming
     * @returns {boolean}
     */
    isCurrentSessionStreaming() {
        const session = this.getCurrentSession();
        if (!session) return false;
        const state = this.getSessionStreamingState(session.id);
        return state.isStreaming;
    }

    getCurrentSessionStreamingPhase() {
        const session = this.getCurrentSession();
        if (!session) return 'requesting-key';
        const state = this.getSessionStreamingState(session.id);
        return this.normalizePendingPhase(state.phase);
    }

    /**
     * Stops streaming for the current session
     */
    stopCurrentSessionStreaming() {
        const session = this.getCurrentSession();
        if (!session) return;

        const state = this.getSessionStreamingState(session.id);
        if (state.isStreaming && state.abortController) {
            state.abortController.abort();
            // The finally block in sendMessage will handle cleanup
        }
    }

    /**
     * Interrupts the current session stream and waits for cleanup to finish.
     * Timeline-mutating actions use this so they can safely restart generation.
     * @param {Object} options
     * @param {number} options.timeoutMs - Max wait time before giving up
     * @returns {Promise<boolean>} True if streaming is stopped or was already idle
     */
    async stopCurrentSessionStreamingAndWait(options = {}) {
        const { timeoutMs = 10000 } = options;
        const session = this.getCurrentSession();
        if (!session) return true;

        const state = this.getSessionStreamingState(session.id);
        if (!state.isStreaming) {
            return true;
        }

        this.stopCurrentSessionStreaming();

        const startTime = Date.now();
        while (this.getSessionStreamingState(session.id).isStreaming) {
            if ((Date.now() - startTime) >= timeoutMs) {
                this.showToast('Unable to stop the current response', 'error');
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        return true;
    }

    /**
     * Handles new chat request with validation (prevents empty duplicate sessions).
     */
    async handleNewChatRequest(options = {}) {
        // Clear current session - no session is selected
        // The session will be created when the user sends their first message
        await this.clearCurrentSession(options);

        // Close sidebar on mobile after creating new chat
        if (this.isMobileView()) {
            this.hideSidebar();
        }
    }

    /**
     * Desktop-only helper to send a chatbar message without DOM polling.
     * This is a no-op for normal web usage unless invoked explicitly.
     * payload: { text, files, model, searchEnabled }
     */
    async handleChatbarSend(payload = {}) {
        const { text = '', files = [], model = null, searchEnabled } = payload || {};
        if (!text && (!files || files.length === 0)) return;

        await this.handleNewChatRequest({ awaitRender: true, immediate: true, emitDesktop: true });

        if (model && this.modelPicker) {
            await this.modelPicker.selectModel(model);
        }

        if (searchEnabled !== undefined) {
            this.searchEnabled = searchEnabled;
            if (this.chatInput) {
                this.chatInput.updateSearchToggleUI();
            }
        }

        if (files && files.length > 0) {
            await this.handleFileUpload(files);
        }

        if (this.elements.messageInput) {
            this.elements.messageInput.value = text || '';
            this.elements.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
        }

        this.sendMessage();
    }

    /**
     * Clears the current session, returning to the startup state.
     * No session is selected until the user sends their first message.
     */
    async clearCurrentSession(options = {}) {
        const { awaitRender = false, immediate = false, emitDesktop = false } = options;
        const previousSessionId = this.state.currentSessionId;
        if (previousSessionId) {
            this.saveChatbarStateForSession(previousSessionId);
        }
        this.saveCurrentSessionScrollPosition();
        this.state.currentSessionId = null;
        this.updateUrlWithSession(null);

        if (immediate && this.chatArea?.renderEmptyStateImmediate) {
            this.chatArea.renderEmptyStateImmediate();
        }

        // Load the selected model from settings so UI shows correct model
        const storedModelPreference = await chatDB.getSetting('selectedModel');
        const normalizedSelectedModelName = this.upgradeDefaultModelPreference(
            this.normalizeModelName(storedModelPreference)
        );
        if (normalizedSelectedModelName && normalizedSelectedModelName !== storedModelPreference) {
            await chatDB.saveSetting('selectedModel', normalizedSelectedModelName);
        }
        this.state.pendingModelName = normalizedSelectedModelName || null;
        this.cachedModelDisplayMetadata = inferenceService.getCachedModels();
        this.applyPersistedParallelPendingConfig(this.state.pendingModelName);

        // Update UI to reflect no session selected
        this.renderSessions();
        const renderMessagesPromise = this.renderMessages();
        this.renderCurrentModel();

        // New-chat state should always start with an empty composer.
        this.resetMessageInputLayout({ resetScroll: true });
        this.applyChatbarState(null);

        // Update input state
        this.updateShareButtonUI();

        // Hide message navigation
        if (this.messageNavigation) {
            this.messageNavigation.hide();
        }

        // Hide scroll-to-bottom button when clearing session
        this.hideScrollToBottomButton();

        // Clear right panel
        if (this.rightPanel) {
            this.rightPanel.onSessionChange(null);
        }

        if (emitDesktop) {
            emitDesktopEvent('oa-desktop:session-cleared', { sessionId: null });
        }

        if (awaitRender) {
            await renderMessagesPromise;
        }

        // Focus input after UI updates complete
        requestAnimationFrame(() => {
            if (this.elements.messageInput) {
                this.elements.messageInput.focus();
            }
        });
    }

    async updateSessionTitle(sessionId, title, options = {}) {
        const { titleSource = 'manual', titleGenerationPending = false, titleSearchText = null } = options;
        const session = this.state.sessions.find(s => s.id === sessionId);
        if (session) {
            session.title = title;
            session.titleSource = titleSource;
            session.titleGenerationPending = Boolean(titleGenerationPending);
            if (typeof titleSearchText === 'string') {
                session.titleSearchText = titleSearchText;
            }
            session.updatedAt = Date.now();
            await chatDB.saveSession(session);
            this.renderSessions();
        }
    }

    buildLocalSessionTitle(content) {
        return buildLocalSessionTitleText(content, {
            fallbackLength: SESSION_TITLE_FALLBACK_LENGTH
        });
    }

    buildSessionTitleSearchText(content) {
        return buildSessionTitleSearchTextValue(content);
    }

    buildForkSessionTitleFields(sourceSession, firstUserContent) {
        return buildForkSessionTitleFieldsValue(sourceSession, firstUserContent);
    }

    normalizeSessionSearchText(content) {
        return normalizeSessionSearchTextValue(content);
    }

    getSearchableMessageText(message) {
        return getSearchableMessageTextValue(message);
    }

    buildSessionConversationSearchText(messages) {
        return buildSessionConversationSearchTextValue(messages, {
            maxChars: SESSION_CONTENT_SEARCH_MAX_CHARS,
            maxMessageChars: SESSION_CONTENT_SEARCH_MESSAGE_MAX_CHARS
        });
    }

    buildSessionSearchIndexFields(messages) {
        return buildSessionSearchIndexFieldsValue(messages, {
            maxChars: SESSION_CONTENT_SEARCH_MAX_CHARS,
            maxMessageChars: SESSION_CONTENT_SEARCH_MESSAGE_MAX_CHARS
        });
    }

    applySessionConversationSearchText(session, messages) {
        if (!session) return null;
        const fields = this.buildSessionSearchIndexFields(messages);
        Object.assign(session, fields);
        const loadedSession = this.state.sessionsById.get(session.id);
        if (loadedSession && loadedSession !== session) {
            Object.assign(loadedSession, fields);
        }
        return fields;
    }

    async refreshSessionConversationSearchText(session, messages = null, options = {}) {
        if (!session?.id) return null;
        const sourceMessages = Array.isArray(messages)
            ? messages
            : await chatDB.getSessionMessages(session.id);
        const fields = this.applySessionConversationSearchText(session, sourceMessages);
        if (options.persist && typeof chatDB.updateSessionSearchIndex === 'function') {
            await chatDB.updateSessionSearchIndex(session.id, fields);
        }
        return fields;
    }

    cleanGeneratedSessionTitle(title) {
        return cleanGeneratedSessionTitleText(title, {
            maxLength: SESSION_TITLE_MAX_LENGTH
        });
    }

    async clearSessionTitleGenerationPending(sessionId) {
        const session = this.state.sessionsById.get(sessionId) || this.state.sessions.find(s => s.id === sessionId);
        if (!session?.titleGenerationPending || session.titleSource === 'manual') return;
        session.titleGenerationPending = false;
        session.updatedAt = Date.now();
        await chatDB.saveSession(session);
        this.renderSessions();
    }

    async generateSessionTitleIfNeeded(sessionId, userMessageId, options = {}) {
        const session = this.state.sessionsById.get(sessionId) || this.state.sessions.find(s => s.id === sessionId);
        if (!session || session.titleSource === 'manual' || session.titleSource === 'generated' || !session.titleGenerationPending) return;
        const accessSession = options.accessSession || session;
        if (!inferenceService.getAccessToken(accessSession) || inferenceService.isAccessExpired(accessSession)) {
            await this.clearSessionTitleGenerationPending(session.id);
            return;
        }

        const messages = await chatDB.getSessionMessages(session.id);
        const firstUserMessage = messages.find(message => message.role === 'user' && !message.isLocalOnly);
        if (!firstUserMessage || firstUserMessage.id !== userMessageId) return;

        const prompt = this.getMessageTextContent(firstUserMessage.content).trim();
        if (!prompt) {
            await this.clearSessionTitleGenerationPending(session.id);
            return;
        }

        const expectedTitle = session.title;
        const expectedSource = session.titleSource || 'local';

        try {
            const generated = await inferenceService.generateSessionTitle(accessSession, prompt, { timeoutMs: 10000 });
            const title = this.cleanGeneratedSessionTitle(generated);
            if (!title) {
                await this.clearSessionTitleGenerationPending(sessionId);
                return;
            }

            const latestSession = this.state.sessionsById.get(sessionId) || this.state.sessions.find(s => s.id === sessionId);
            if (!latestSession) return;
            const latestSource = latestSession.titleSource || 'local';
            if (latestSource !== expectedSource || latestSession.title !== expectedTitle) {
                return;
            }

            latestSession.title = title;
            latestSession.titleSource = 'generated';
            latestSession.titleGenerationPending = false;
            latestSession.titleGeneratedAt = Date.now();
            latestSession.updatedAt = Date.now();
            await chatDB.saveSession(latestSession);
            this.renderSessions();
        } catch (error) {
            console.debug('Session title generation skipped:', error);
            await this.clearSessionTitleGenerationPending(sessionId);
        }
    }

    /**
     * Adds a message to the current session.
     * @param {string} role - Message role ('user' or 'assistant')
     * @param {string} content - Message content
     * @param {Object} metadata - Optional metadata (model, tokenCount, etc.)
     * @returns {Promise<Object>} The created message
     */
    async addMessage(role, content, metadata = {}) {
        const session = this.getCurrentSession();
        if (!session) return;
        const extraFields = metadata.extra && typeof metadata.extra === 'object'
            ? metadata.extra
            : {};

        const message = {
            id: this.generateId(),
            sessionId: session.id,
            role,
            content,
            timestamp: Date.now(),
            model: metadata.model || session.model,
            tokenCount: metadata.tokenCount || null,
            streamingTokens: metadata.streamingTokens || null,
            files: metadata.files || null,
            searchEnabled: metadata.searchEnabled || false,
            citations: metadata.citations || null,
            isLocalOnly: Boolean(metadata.isLocalOnly),
            scrubber: metadata.scrubber || null,
            ...extraFields
        };

        await chatDB.saveMessage(message);

        // Update session's updatedAt timestamp
        session.updatedAt = Date.now();
        const messages = await chatDB.getSessionMessages(session.id);
        this.applySessionConversationSearchText(session, messages);
        await chatDB.saveSession(session);

        // Auto-generate title from first user message
        if (role === 'user') {
            if (messages.length === 1) {
                const title = this.buildLocalSessionTitle(content);
                await this.updateSessionTitle(session.id, title, {
                    titleSource: 'local',
                    titleGenerationPending: Boolean(this.getMessageTextContent(content).trim()),
                    titleSearchText: this.buildSessionTitleSearchText(content)
                });
            }
        }

        // Use incremental update instead of full re-render
        if (this.chatArea) {
            await this.chatArea.appendMessage(message);
        }
        this.renderSessions(); // Re-render sessions to update sorting
        return message;
    }

    buildConversationText(messages) {
        if (!Array.isArray(messages)) return '';
        return messages
            .filter((message) => !message.isLocalOnly)
            .map((message) => {
                const text = this.getMessageTextContent(message.content).trim();
                if (!text) return '';
                const role = message.role === 'assistant' ? 'Assistant' : 'User';
                return `${role}: ${text}`;
            })
            .filter(Boolean)
            .join('\n\n');
    }

    normalizeMessagesForMemory(messages) {
        return normalizeMessagesForMemory(messages, {
            getMessageTextContent: (content) => this.getMessageTextContent(content),
            getScrubberMessageContent: (message, mode) => this.getScrubberMessageContent(message, mode)
        });
    }

    createCancelledError(message = 'Request cancelled.') {
        const error = new Error(message);
        error.isCancelled = true;
        return error;
    }

    throwIfAborted(signal) {
        if (signal?.aborted) {
            throw this.createCancelledError();
        }
    }

    isCancelledError(error, signal = null) {
        return error?.isCancelled === true
            || error?.name === 'AbortError'
            || error?.aborted === true
            || signal?.aborted === true;
    }

    async persistLocalAssistantStatus(message) {
        if (!message?.id) return;
        await chatDB.saveMessage(message);
        if (this.chatArea && this.isViewingSession(message.sessionId)) {
            this.chatArea.updateMessage(message);
        }
    }

    triggerPostTurnMemoryExtraction(session) {
        if (!this.memoryFeatureEnabled) return;
        if (!session?.id) return;
        this.runPostTurnMemoryExtraction(session).catch((error) => {
            console.warn('[App] Background memory extraction failed:', error);
        });
    }

    async runPostTurnMemoryExtraction(session) {
        if (!this.memoryFeatureEnabled) {
            return { status: 'disabled', writeCalls: 0 };
        }
        const memoryRunGeneration = this.memoryWorkGeneration;
        if (!session?.id) {
            return { status: 'skipped', writeCalls: 0 };
        }
        if (this.memoryExtractionInFlight.has(session.id)) {
            return { status: 'skipped', writeCalls: 0 };
        }

        this.memoryExtractionInFlight.add(session.id);
        const abortController = new AbortController();
        this.memoryExtractionAbortControllers.set(session.id, abortController);
        try {
            const messages = await chatDB.getSessionMessages(session.id);
            const normalizedMessages = this.normalizeMessagesForMemory(messages);
            if (normalizedMessages.length < 2) {
                return { status: 'skipped', writeCalls: 0 };
            }
            if (!this.isMemoryFeatureActive(memoryRunGeneration)) {
                return { status: 'disabled', writeCalls: 0 };
            }

            const previousMemoryKey = session.memoryKey || null;
            const memoryKey = await ensureMemoryKey(session, ticketClient, {
                signal: abortController.signal
            });
            if (!this.isMemoryFeatureActive(memoryRunGeneration)) {
                invalidateMemoryKey(session);
                try {
                    await chatDB.saveSession(session);
                } catch (persistError) {
                    console.warn('[App] Failed to clear memory key after disabling memory extraction:', persistError);
                }
                return { status: 'disabled', writeCalls: 0 };
            }
            if (session.memoryKey && session.memoryKey !== previousMemoryKey) {
                await chatDB.saveSession(session);
            }
            if (!memoryKey) {
                return { status: 'no_key', writeCalls: 0 };
            }

            const result = await ingestMemoryMessages({
                messages: normalizedMessages,
                apiKey: memoryKey,
                model: this.memoryAgentModel,
                options: {
                    signal: abortController.signal
                }
            });
            if (!this.isMemoryFeatureActive(memoryRunGeneration)) {
                return { status: 'disabled', writeCalls: 0 };
            }

            if (result?.status !== 'error') {
                session.memoryProcessedAt = Date.now();
                await chatDB.saveSession(session);
            }

            return result || { status: 'processed', writeCalls: 0 };
        } catch (error) {
            if (this.isCancelledError(error, abortController.signal) && !this.isMemoryFeatureActive(memoryRunGeneration)) {
                return { status: 'disabled', writeCalls: 0 };
            }
            if (isMemoryAuthError(error)) {
                invalidateMemoryKey(session);
                try {
                    await chatDB.saveSession(session);
                } catch (persistError) {
                    console.warn('[App] Failed to persist invalidated memory key after extraction auth error:', persistError);
                }
            }
            throw error;
        } finally {
            this.memoryExtractionInFlight.delete(session.id);
            if (this.memoryExtractionAbortControllers.get(session.id) === abortController) {
                this.memoryExtractionAbortControllers.delete(session.id);
            }
        }
    }

    waitForMemoryApproval(messageId, signal = null) {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                if (signal && abortHandler) {
                    signal.removeEventListener('abort', abortHandler);
                }
                this.memoryApprovalRequests.delete(messageId);
            };

            const abortHandler = signal ? () => {
                cleanup();
                reject(this.createCancelledError());
            } : null;

            if (signal?.aborted) {
                reject(this.createCancelledError());
                return;
            }

            if (abortHandler) {
                signal.addEventListener('abort', abortHandler, { once: true });
            }

            this.memoryApprovalRequests.set(messageId, {
                resolve: (decision) => {
                    cleanup();
                    resolve(decision);
                }
            });
        });
    }

    async setMemoryAutoInclude(enabled, options = {}) {
        this.memoryAutoInclude = enabled === true;
        if (this.chatInput?.refreshMemorySettingsUI) {
            this.chatInput.refreshMemorySettingsUI();
        }
        if (options.persist === false) return;
        await chatDB.saveSetting('memoryAutoInclude', this.memoryAutoInclude);
    }

    isMemoryFeatureActive(generation = this.memoryWorkGeneration) {
        return this.memoryFeatureEnabled !== false && generation === this.memoryWorkGeneration;
    }

    clearMemoryApiOverrideContent() {
        this._lastApiContent = null;
        this._lastApiContentGeneration = null;
    }

    setMemoryApiOverrideContent(content, generation = this.memoryWorkGeneration) {
        if (!this.isMemoryFeatureActive(generation)) {
            this.clearMemoryApiOverrideContent();
            return false;
        }
        const normalizedContent = typeof content === 'string' ? content.trim() : '';
        if (!normalizedContent) {
            this.clearMemoryApiOverrideContent();
            return false;
        }
        this._lastApiContent = content;
        this._lastApiContentGeneration = generation;
        return true;
    }

    getMemoryApiOverrideContent() {
        if (!this.isMemoryFeatureActive(this._lastApiContentGeneration)) {
            this.clearMemoryApiOverrideContent();
            return null;
        }
        return (typeof this._lastApiContent === 'string' && this._lastApiContent.trim().length > 0)
            ? this._lastApiContent
            : null;
    }

    async setMemoryFeatureEnabled(enabled, options = {}) {
        const resolvedState = resolveMemoryFeatureToggleValue({
            currentMemoryMode: this.memoryMode,
            nextMemoryFeatureEnabled: enabled === true
        });
        this.memoryFeatureEnabled = resolvedState.memoryFeatureEnabled;
        this.memoryMode = resolvedState.memoryMode;
        if (!this.memoryFeatureEnabled) {
            this.memoryWorkGeneration += 1;
            this.clearMemoryApiOverrideContent();
            for (const controller of this.memoryExtractionAbortControllers.values()) {
                controller.abort();
            }
            for (const controller of this.memoryAugmentAbortControllers.values()) {
                controller.abort();
            }
            this.resolvePendingMemoryApprovalsAsSkipped();
            this.memoryEditor?.handleMemoryFeatureDisabled?.();
            this.clearPendingMemoryApprovalPromptsForCurrentSession().catch((error) => {
                console.warn('[App] Failed to clear pending memory approvals after disabling memory:', error);
            });
        }

        if (this.chatInput?.updateMemoryToggleUI) {
            this.chatInput.updateMemoryToggleUI();
        }
        if (this.chatInput?.refreshMemorySettingsUI) {
            this.chatInput.refreshMemorySettingsUI();
        }

        if (options.persist === false) return;

        const writes = [
            chatDB.saveSetting('memoryFeatureEnabled', this.memoryFeatureEnabled)
        ];
        if (resolvedState.shouldPersistMemoryMode) {
            writes.push(chatDB.saveSetting('memoryMode', false));
        }
        await Promise.all(writes);
    }

    resolvePendingMemoryApprovalsAsSkipped() {
        for (const request of Array.from(this.memoryApprovalRequests.values())) {
            request?.resolve?.({ approved: false, alwaysInclude: false });
        }
    }

    async clearPendingMemoryApprovalPromptsForCurrentSession() {
        const session = this.getCurrentSession();
        if (!session?.id) return;

        const messages = await chatDB.getSessionMessages(session.id);
        const pendingMessages = messages.filter((message) =>
            message?.memoryApprovalPrompt?.status === 'pending' || message?.ciPromptDraft?.status === 'pending'
        );
        if (pendingMessages.length === 0) return;

        for (const message of pendingMessages) {
            if (message.ciPromptDraft) {
                message.ciPromptDraft = {
                    ...message.ciPromptDraft,
                    status: 'denied'
                };
            }
            message.memoryApprovalPrompt = null;
            if (message.isLocalOnly) {
                message.content = 'Memory is off in settings. Sending without personal context.';
            }
            await chatDB.saveMessage(message);
            if (this.chatArea && this.isViewingSession(message.sessionId)) {
                this.chatArea.updateMessage(message);
            }
        }
    }

    async setMemoryAgentModel(modelId, options = {}) {
        const nextModel = isAllowedConfidentialModel(modelId)
            ? String(modelId).trim()
            : DEFAULT_MEMORY_AGENT_MODEL;
        this.memoryAgentModel = nextModel;
        if (this.chatInput?.refreshMemorySettingsUI) {
            this.chatInput.refreshMemorySettingsUI();
        }
        if (options.persist === false) return;
        await chatDB.saveSetting('memoryAgentModel', nextModel);
    }

    async handleMemoryApprovalDecision(messageId, decision) {
        if (!this.memoryFeatureEnabled) {
            const request = this.memoryApprovalRequests.get(messageId);
            if (request?.resolve) {
                request.resolve({ approved: false, alwaysInclude: false });
            } else {
                await this.resolveStaleMemoryApproval(messageId, false, false);
            }
            return;
        }

        const alwaysInclude = decision === 'always';
        const approved = decision === 'yes' || alwaysInclude;

        if (alwaysInclude) {
            try { await this.setMemoryAutoInclude(true); }
            catch { this.memoryAutoInclude = true; }
        }

        // Live flow: resolver exists from active runMemoryAugmentFlow
        const request = this.memoryApprovalRequests.get(messageId);
        if (request?.resolve) {
            request.resolve({ approved, alwaysInclude });
            return;
        }

        // Stale flow: page reloaded while approval was pending — resolve directly
        await this.resolveStaleMemoryApproval(messageId, approved, alwaysInclude);
    }

    async resolveStaleMemoryApproval(messageId, approved, alwaysInclude) {
        const memoryRunGeneration = this.memoryWorkGeneration;
        const session = this.getCurrentSession();
        if (!session) return;

        const messages = await chatDB.getSessionMessages(session.id);
        const msg = messages.find(m => m.id === messageId);
        if (!msg?.ciPromptDraft) return;

        const draft = msg.ciPromptDraft;

        if (approved) {
            draft.status = 'approved';
            const rawPrompt = (typeof draft.editedFullPrompt === 'string' && draft.editedFullPrompt.trim())
                ? draft.editedFullPrompt : draft.fullPrompt;
            const recordedContext = await this.recordApprovedMemoryContext(session, draft, memoryRunGeneration);
            if (!this.isMemoryFeatureActive(memoryRunGeneration) || !recordedContext) {
                this.clearMemoryApiOverrideContent();
                msg.content = 'Memory is off in settings. Sending without personal context.';
                msg.memoryApprovalPrompt = null;
                await this.persistLocalAssistantStatus(msg);
                return;
            }
            this.setMemoryApiOverrideContent(stripMemoryPromptUserData(rawPrompt), memoryRunGeneration);

            const files = draft.memoryFiles || [];
            if (draft.reusedPriorContext || typeof draft.newMemoryFileCount === 'number') {
                msg.content = this.buildMemoryContextSummary({
                    fileCount: draft.newMemoryFileCount || 0,
                    reused: draft.reusedPriorContext === true,
                    hasNewContext: draft.hasNewContext === true,
                    pending: false,
                    alwaysInclude
                });
            } else {
                msg.content = alwaysInclude
                    ? `Retrieved ${files.length} memory file${files.length === 1 ? '' : 's'}. Always include on. Sending now.`
                    : `Retrieved ${files.length} memory file${files.length === 1 ? '' : 's'}. Sending approved prompt.`;
            }
            msg.memoryApprovalPrompt = { status: 'approved', linkedUserMessageId: draft.linkedUserMessageId, autoIncluded: alwaysInclude };
        } else {
            draft.status = 'denied';
            this.clearMemoryApiOverrideContent();
            msg.content = 'Memory skipped. Sending without personal context.';
            msg.memoryApprovalPrompt = null;
        }

        await this.persistLocalAssistantStatus(msg);
        await this.regenerateResponse({ skipMemoryAugment: true });
    }

    async removeLocalOnlyMessagesAfter(sessionId, messageId) {
        if (!sessionId || !messageId) return;
        const messages = await chatDB.getSessionMessages(sessionId);
        const messageIndex = messages.findIndex((message) => message.id === messageId);
        if (messageIndex === -1) return;

        const localMessages = messages
            .slice(messageIndex + 1)
            .filter((message) => message.isLocalOnly);

        if (localMessages.length === 0) return;

        for (const message of localMessages) {
            await chatDB.deleteMessage(message.id);
            const messageEl = document.querySelector(`[data-message-id="${message.id}"]`);
            if (messageEl) {
                messageEl.remove();
            }
        }
    }

    normalizeMemoryContextText(text, maxChars = MEMORY_CONTEXT_MAX_CHARS) {
        const normalized = String(text || '')
            .replace(/\r\n/g, '\n')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        if (!normalized) return '';
        if (normalized.length <= maxChars) return normalized;
        return normalized.slice(0, maxChars).trimEnd() + '\n...(truncated)';
    }

    extractMemoryUserDataContext(reviewPrompt, fallbackText = '') {
        const prompt = String(reviewPrompt || '');
        const matches = [...prompt.matchAll(/\[\[user_data\]\]([\s\S]*?)\[\[\/user_data\]\]/g)]
            .map((match) => this.normalizeMemoryContextText(match[1], MEMORY_CONTEXT_PROMPT_MAX_CHARS))
            .filter(Boolean);
        if (matches.length > 0) {
            return this.normalizeMemoryContextText(matches.join('\n\n'), MEMORY_CONTEXT_PROMPT_MAX_CHARS);
        }
        return this.normalizeMemoryContextText(fallbackText, MEMORY_CONTEXT_PROMPT_MAX_CHARS);
    }

    getMemoryContextEntries(session) {
        const entries = session?.memoryRetrievedContext?.entries;
        if (!Array.isArray(entries)) return [];
        return entries
            .filter((entry) => typeof entry?.context === 'string' && entry.context.trim())
            .map((entry) => ({
                query: typeof entry.query === 'string' ? entry.query.trim() : '',
                context: this.normalizeMemoryContextText(entry.context, MEMORY_CONTEXT_PROMPT_MAX_CHARS),
                paths: Array.isArray(entry.paths)
                    ? entry.paths.filter((path) => typeof path === 'string' && path.trim())
                    : [],
                linkedUserMessageId: typeof entry.linkedUserMessageId === 'string' ? entry.linkedUserMessageId : null,
                createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0
            }))
            .filter((entry) => entry.context);
    }

    buildPreviouslyRetrievedMemoryContext(session) {
        const entries = this.getMemoryContextEntries(session);
        if (entries.length === 0) return '';

        const selected = [];
        let usedChars = 0;
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            const entry = entries[i];
            const heading = entry.query ? `Previously retrieved for: ${entry.query}` : 'Previously retrieved memory';
            const block = `${heading}\n${entry.context}`;
            const separatorCost = selected.length ? 2 : 0;
            if (usedChars + block.length + separatorCost > MEMORY_CONTEXT_MAX_CHARS) {
                if (selected.length > 0) break;
                selected.unshift(block.slice(0, MEMORY_CONTEXT_MAX_CHARS).trimEnd() + '\n...(truncated)');
                break;
            }
            selected.unshift(block);
            usedChars += block.length + separatorCost;
        }

        return selected.join('\n\n');
    }

    shouldReusePriorMemoryContext(result) {
        if (result?.skipped !== true) return false;
        const reason = String(result.skipReason || '').toLowerCase();
        if (!reason) return false;
        return /\b(already|covered|sufficient|existing|retrieved context)\b/.test(reason);
    }

    buildReusedMemoryApiPrompt(query, previouslyRetrievedContext) {
        const cleanQuery = this.normalizeMemoryContextText(query, MEMORY_CONTEXT_PROMPT_MAX_CHARS);
        const cleanContext = this.normalizeMemoryContextText(previouslyRetrievedContext, MEMORY_CONTEXT_PROMPT_MAX_CHARS);
        if (!cleanQuery || !cleanContext) return '';

        return `${cleanQuery}\n\nRelevant previously approved personal context for this chat:\n[[user_data]]\n${cleanContext}\n[[/user_data]]`;
    }

    buildMemoryContextSummary({ fileCount = 0, reused = false, hasNewContext = false, pending = true, alwaysInclude = false, autoIncluded = false }) {
        if (reused && !hasNewContext) {
            if (!pending) {
                return 'No new retrieval. Using previously approved memory.';
            }
            return 'Using earlier memory. Review before sending.';
        }

        const retrieved = fileCount > 0
            ? `Retrieved ${fileCount} new memory file${fileCount === 1 ? '' : 's'}`
            : 'Retrieved new memory';
        const prefix = reused ? `${retrieved} plus earlier memory` : retrieved;

        if (!pending) {
            if (autoIncluded) return `${prefix}. Sending automatically.`;
            if (alwaysInclude) return `${prefix}. Always include on. Sending now.`;
            return `${prefix}. Sending approved prompt.`;
        }
        return `${prefix}. Review before sending.`;
    }

    async recordApprovedMemoryContext(session, draft, generation = null) {
        if (!session || !draft) return false;
        if (generation !== null && !this.isMemoryFeatureActive(generation)) return false;
        const sourceEntry = draft.memoryContextEntry || null;
        if (!sourceEntry) return true;

        const usedEditedPrompt = typeof draft.editedFullPrompt === 'string' && draft.editedFullPrompt.trim();
        const approvedPrompt = usedEditedPrompt ? draft.editedFullPrompt : draft.fullPrompt;
        const approvedContext = this.extractMemoryUserDataContext(approvedPrompt, usedEditedPrompt ? '' : sourceEntry.context);
        if (!approvedContext) return true;

        const existingEntries = this.getMemoryContextEntries(session)
            .filter((entry) => entry.linkedUserMessageId !== sourceEntry.linkedUserMessageId);
        const nextEntry = {
            query: typeof sourceEntry.query === 'string' ? sourceEntry.query.slice(0, 1000) : '',
            context: approvedContext,
            paths: Array.isArray(sourceEntry.paths)
                ? [...new Set(sourceEntry.paths.filter((path) => typeof path === 'string' && path.trim()))]
                : [],
            linkedUserMessageId: sourceEntry.linkedUserMessageId || draft.linkedUserMessageId || null,
            createdAt: Date.now()
        };

        const nextEntries = [...existingEntries, nextEntry].slice(-MEMORY_CONTEXT_MAX_ENTRIES);
        session.memoryRetrievedContext = {
            version: 1,
            entries: nextEntries
        };
        await chatDB.saveSession(session);
        if (generation !== null && !this.isMemoryFeatureActive(generation)) {
            session.memoryRetrievedContext = {
                version: 1,
                entries: existingEntries
            };
            await chatDB.saveSession(session);
            return false;
        }
        return true;
    }

    async pruneMemoryRetrievedContextFromMessage(session, messages, messageIndex) {
        const entries = session?.memoryRetrievedContext?.entries;
        if (!session || !Array.isArray(entries) || entries.length === 0 || !Array.isArray(messages)) {
            return false;
        }

        const priorUserExists = messages
            .slice(0, Math.max(0, messageIndex))
            .some((message) => message?.role === 'user');
        const affectedUserIds = new Set(
            messages
                .slice(Math.max(0, messageIndex))
                .filter((message) => message?.role === 'user' && typeof message.id === 'string')
                .map((message) => message.id)
        );

        const nextEntries = priorUserExists
            ? entries.filter((entry) => !affectedUserIds.has(entry?.linkedUserMessageId))
            : [];

        if (nextEntries.length === entries.length) {
            return false;
        }

        session.memoryRetrievedContext = {
            version: 1,
            entries: nextEntries
        };
        await chatDB.saveSession(session);
        return true;
    }

    async runMemoryAugmentFlow(query, userMessage, session, options = {}) {
        if (!this.memoryFeatureEnabled || !this.memoryMode || !userMessage || !session) return null;
        if (!query || !query.trim()) return null;

        const { conversationText = '', signal = null } = options;
        const memoryRunGeneration = this.memoryWorkGeneration;
        const memoryAbortController = new AbortController();
        const memorySignal = memoryAbortController.signal;
        const parentAbortHandler = signal ? () => memoryAbortController.abort() : null;
        if (signal?.aborted) {
            memoryAbortController.abort();
        } else if (signal && parentAbortHandler) {
            signal.addEventListener('abort', parentAbortHandler, { once: true });
        }
        this.memoryAugmentAbortControllers.add(memoryAbortController);
        const cleanupMemoryAbortController = () => {
            this.memoryAugmentAbortControllers.delete(memoryAbortController);
            if (signal && parentAbortHandler) {
                signal.removeEventListener('abort', parentAbortHandler);
            }
        };
        try {
            this.throwIfAborted(memorySignal);
        } catch (error) {
            cleanupMemoryAbortController();
            throw error;
        }

        const retrievalMessage = await this.addMessage('assistant', '', {
            isLocalOnly: true,
            model: 'memory agent',
            extra: {
                agentTrace: [],
                agentTraceStreaming: true
            }
        });

        if (!retrievalMessage) {
            cleanupMemoryAbortController();
            return null;
        }

        const agentTrace = retrievalMessage.agentTrace;
        let traceRefreshTimer = null;
        const summarizeToolTraceResult = (result) => typeof result === 'string'
            ? result.slice(0, 320)
            : JSON.stringify(result || {}).slice(0, 320);
        const upsertToolTraceEntry = (progress) => {
            const toolCallId = typeof progress.toolCallId === 'string' && progress.toolCallId
                ? progress.toolCallId
                : '';
            const toolState = progress.toolState === 'started' ? 'started' : 'finished';
            let entryIndex = toolCallId
                ? agentTrace.findIndex((entry) => entry?.type === 'tool_call' && entry.toolCallId === toolCallId)
                : -1;

            if (entryIndex === -1 && toolState === 'finished') {
                entryIndex = [...agentTrace]
                    .reverse()
                    .findIndex((entry) => entry?.type === 'tool_call' && entry.tool === progress.tool && entry.state === 'started');
                if (entryIndex !== -1) {
                    entryIndex = agentTrace.length - 1 - entryIndex;
                }
            }

            const summarizedResult = toolState === 'finished'
                ? summarizeToolTraceResult(progress.result)
                : '';

            if (entryIndex === -1) {
                agentTrace.push({
                    type: 'tool_call',
                    tool: progress.tool,
                    args: progress.args || {},
                    result: summarizedResult,
                    state: toolState,
                    toolCallId
                });
                return;
            }

            agentTrace[entryIndex] = {
                ...agentTrace[entryIndex],
                type: 'tool_call',
                tool: progress.tool,
                args: progress.args || {},
                result: summarizedResult,
                state: toolState,
                toolCallId: toolCallId || agentTrace[entryIndex].toolCallId || ''
            };
        };
        const scheduleTraceRefresh = () => {
            if (traceRefreshTimer) return;
            traceRefreshTimer = setTimeout(() => {
                traceRefreshTimer = null;
                if (this.chatArea && this.isViewingSession(retrievalMessage.sessionId)) {
                    this.chatArea.updateMessage(retrievalMessage);
                }
            }, 80);
        };

        const flushTraceRefresh = async () => {
            if (!traceRefreshTimer) return;
            clearTimeout(traceRefreshTimer);
            traceRefreshTimer = null;
            if (this.chatArea && this.isViewingSession(retrievalMessage.sessionId)) {
                this.chatArea.updateMessage(retrievalMessage);
            }
        };
        const handleMemoryProgress = (progress) => {
            if (!progress?.stage) return;
            if (progress.stage === 'tool_call') {
                upsertToolTraceEntry(progress);
            } else if (progress.stage === 'reasoning') {
                const delta = typeof progress.message === 'string' ? progress.message : '';
                const lastEntry = agentTrace[agentTrace.length - 1];
                if (lastEntry?.type === 'reasoning') {
                    lastEntry.text += delta;
                } else {
                    agentTrace.push({ type: 'reasoning', text: delta });
                }
            } else {
                agentTrace.push({
                    type: 'phase',
                    label: progress.message || progress.stage
                });
            }
            scheduleTraceRefresh();
        };
        const handleMemoryModelText = (text, iteration) => {
            agentTrace.push({ type: 'model_text', text, iteration });
            scheduleTraceRefresh();
        };
        const markMemoryDisabled = async () => {
            this.clearMemoryApiOverrideContent();
            retrievalMessage.agentTraceStreaming = false;
            retrievalMessage.memoryApprovalPrompt = null;
            retrievalMessage.ciPromptDraft = null;
            retrievalMessage.content = 'Memory is off in settings. Sending original prompt.';
            await this.persistLocalAssistantStatus(retrievalMessage);
            return null;
        };

        try {
            if (!this.isMemoryFeatureActive(memoryRunGeneration)) {
                return await markMemoryDisabled();
            }
            const previousMemoryKey = session.memoryKey || null;
            const memoryKey = await ensureMemoryKey(session, ticketClient, {
                signal: memorySignal
            });
            if (memorySignal.aborted || !this.isMemoryFeatureActive(memoryRunGeneration)) {
                if (session.memoryKey && session.memoryKey !== previousMemoryKey) {
                    invalidateMemoryKey(session);
                }
                try {
                    if (session.memoryKey !== previousMemoryKey || session.memoryKeyInfo) {
                        await chatDB.saveSession(session);
                    }
                } catch (persistError) {
                    console.warn('[App] Failed to clear memory key after disabling memory retrieval:', persistError);
                }
                return await markMemoryDisabled();
            }
            this.throwIfAborted(memorySignal);
            if (session.memoryKey && session.memoryKey !== previousMemoryKey) {
                await chatDB.saveSession(session);
            }

            if (!memoryKey) {
                retrievalMessage.agentTraceStreaming = false;
                retrievalMessage.content = `Memory retrieval needs ${CONFIDENTIAL_KEY_TICKETS} available inference ticket${CONFIDENTIAL_KEY_TICKETS === 1 ? '' : 's'}. Sending without personal context.`;
                await this.persistLocalAssistantStatus(retrievalMessage);
                return null;
            }

            const previouslyRetrievedContext = this.buildPreviouslyRetrievedMemoryContext(session);
            const hasPriorMemoryContext = !!previouslyRetrievedContext;
            const result = hasPriorMemoryContext
                ? await runMemoryAugmentQueryAdaptive({
                    query,
                    alreadyRetrievedContext: previouslyRetrievedContext,
                    conversationText,
                    apiKey: memoryKey,
                    model: this.memoryAgentModel,
                    signal: memorySignal,
                    onProgress: handleMemoryProgress,
                    onModelText: handleMemoryModelText
                })
                : await runMemoryAugmentQuery({
                    query,
                    conversationText,
                    apiKey: memoryKey,
                    model: this.memoryAgentModel,
                    signal: memorySignal,
                    onProgress: handleMemoryProgress,
                    onModelText: handleMemoryModelText
                });
            const memoryRetrievalAssessment = normalizeMemoryRetrievalAssessment(result || {}, {
                treatConfidenceFieldAsExplicit: true
            });
            retrievalMessage.memoryRetrievalAssessment = memoryRetrievalAssessment;

            await flushTraceRefresh();
            this.throwIfAborted(memorySignal);
            if (!this.isMemoryFeatureActive(memoryRunGeneration)) {
                return await markMemoryDisabled();
            }

            retrievalMessage.agentTraceStreaming = false;

            const memoryFiles = Array.isArray(result?.files)
                ? result.files.filter((file) => typeof file?.path === 'string' && typeof file?.content === 'string' && file.content.trim())
                : [];
            const newMemoryFilePaths = [...new Set([
                ...memoryFiles.map((file) => file.path),
                ...(Array.isArray(result?.paths) ? result.paths.filter((path) => typeof path === 'string' && path.trim()) : [])
            ])];
            const fullPrompt = typeof result?.reviewPrompt === 'string' ? result.reviewPrompt : '';
            const apiPrompt = typeof result?.apiPrompt === 'string' ? result.apiPrompt : '';
            const memoryFilePaths = newMemoryFilePaths;
            let memoryContextEntry = null;
            let hasNewContext = false;

            if (fullPrompt && apiPrompt) {
                const storedContext = this.extractMemoryUserDataContext(result.reviewPrompt, result.assembledContext);
                if (storedContext) {
                    hasNewContext = true;
                    memoryContextEntry = {
                        query,
                        context: storedContext,
                        paths: newMemoryFilePaths,
                        linkedUserMessageId: userMessage.id
                    };
                }
            }

            if (!fullPrompt || !apiPrompt) {
                const shouldReusePriorContext = hasPriorMemoryContext && this.shouldReusePriorMemoryContext(result);
                const reusedPrompt = shouldReusePriorContext
                    ? this.buildReusedMemoryApiPrompt(query, previouslyRetrievedContext)
                    : '';
                if (reusedPrompt) {
                    if (!this.isMemoryFeatureActive(memoryRunGeneration)) {
                        return await markMemoryDisabled();
                    }
                    this.setMemoryApiOverrideContent(stripMemoryPromptUserData(reusedPrompt), memoryRunGeneration);
                    retrievalMessage.content = 'No new retrieval. Using previously approved memory.';
                } else {
                    retrievalMessage.content = 'No added memory. Sending original prompt.';
                }
                retrievalMessage.memoryApprovalPrompt = null;
                retrievalMessage.ciPromptDraft = null;
                await this.persistLocalAssistantStatus(retrievalMessage);
                if (!this.isMemoryFeatureActive(memoryRunGeneration)) {
                    return await markMemoryDisabled();
                }
                return null;
            }

            retrievalMessage.content = this.buildMemoryContextSummary({
                fileCount: newMemoryFilePaths.length,
                reused: hasPriorMemoryContext,
                hasNewContext,
                pending: true
            });
            retrievalMessage.memoryApprovalPrompt = {
                status: 'pending',
                linkedUserMessageId: userMessage.id
            };
            retrievalMessage.ciPromptDraft = {
                fullPrompt,
                editedFullPrompt: null,
                apiPrompt,
                model: this.normalizeModelName(session.model) || session.model || this.state.pendingModelName || inferenceService.getDefaultModelName(session),
                memoryFiles: memoryFilePaths,
                memoryContextEntry,
                memoryRetrievalAssessment,
                reusedPriorContext: hasPriorMemoryContext,
                hasNewContext,
                newMemoryFileCount: newMemoryFilePaths.length,
                linkedUserMessageId: userMessage.id,
                status: 'pending'
            };
            await this.persistLocalAssistantStatus(retrievalMessage);

            if (!this.isMemoryFeatureActive(memoryRunGeneration)) {
                return await markMemoryDisabled();
            }

            if (this.memoryAutoInclude) {
                const draft = retrievalMessage.ciPromptDraft;
                draft.status = 'approved';
                draft.model = this.normalizeModelName(session.model) || session.model || draft.model;
                const recordedContext = await this.recordApprovedMemoryContext(session, draft, memoryRunGeneration);
                if (!this.isMemoryFeatureActive(memoryRunGeneration) || !recordedContext) {
                    return await markMemoryDisabled();
                }
                this.setMemoryApiOverrideContent(stripMemoryPromptUserData(draft.fullPrompt), memoryRunGeneration);
                retrievalMessage.content = this.buildMemoryContextSummary({
                    fileCount: draft.newMemoryFileCount || 0,
                    reused: draft.reusedPriorContext === true,
                    hasNewContext: draft.hasNewContext === true,
                    pending: false,
                    autoIncluded: true
                });
                retrievalMessage.memoryApprovalPrompt = {
                    status: 'approved',
                    linkedUserMessageId: userMessage.id,
                    autoIncluded: true
                };
                await this.persistLocalAssistantStatus(retrievalMessage);
                if (!this.isMemoryFeatureActive(memoryRunGeneration)) {
                    return await markMemoryDisabled();
                }
                return draft;
            }

            const approval = await this.waitForMemoryApproval(retrievalMessage.id, memorySignal);
            this.throwIfAborted(memorySignal);
            if (!this.isMemoryFeatureActive(memoryRunGeneration)) {
                return await markMemoryDisabled();
            }

            const latestMessages = await chatDB.getSessionMessages(retrievalMessage.sessionId);
            const latestRetrievalMessage = latestMessages.find((message) => message.id === retrievalMessage.id);
            if (latestRetrievalMessage?.ciPromptDraft) {
                retrievalMessage.ciPromptDraft = latestRetrievalMessage.ciPromptDraft;
            }

            const draft = retrievalMessage.ciPromptDraft;
            const approved = approval?.approved === true;
            const alwaysInclude = approval?.alwaysInclude === true;
            if (approved) {
                draft.status = 'approved';
                draft.model = this.normalizeModelName(session.model) || session.model || draft.model;
                const rawPrompt = (typeof draft.editedFullPrompt === 'string' && draft.editedFullPrompt.trim())
                    ? draft.editedFullPrompt
                    : draft.fullPrompt;
                const recordedContext = await this.recordApprovedMemoryContext(session, draft, memoryRunGeneration);
                if (!this.isMemoryFeatureActive(memoryRunGeneration) || !recordedContext) {
                    return await markMemoryDisabled();
                }
                this.setMemoryApiOverrideContent(stripMemoryPromptUserData(rawPrompt), memoryRunGeneration);
                retrievalMessage.content = this.buildMemoryContextSummary({
                    fileCount: draft.newMemoryFileCount || 0,
                    reused: draft.reusedPriorContext === true,
                    hasNewContext: draft.hasNewContext === true,
                    pending: false,
                    alwaysInclude
                });
                retrievalMessage.memoryApprovalPrompt = {
                    status: 'approved',
                    linkedUserMessageId: userMessage.id,
                    autoIncluded: alwaysInclude
                };
            } else {
                draft.status = 'denied';
                this.clearMemoryApiOverrideContent();
                retrievalMessage.content = 'Memory skipped. Sending without personal context.';
                retrievalMessage.memoryApprovalPrompt = null;
            }

            await this.persistLocalAssistantStatus(retrievalMessage);
            if (!this.isMemoryFeatureActive(memoryRunGeneration)) {
                return await markMemoryDisabled();
            }
            return draft;
        } catch (error) {
            await flushTraceRefresh();
            retrievalMessage.agentTraceStreaming = false;
            retrievalMessage.memoryApprovalPrompt = null;
            retrievalMessage.ciPromptDraft = retrievalMessage.ciPromptDraft || null;

            if (isMemoryAuthError(error)) {
                invalidateMemoryKey(session);
                await chatDB.saveSession(session);
            }

            if (isExplicitMemoryRetrievalCancellation(error, memorySignal)) {
                if (!this.isMemoryFeatureActive(memoryRunGeneration)) {
                    return await markMemoryDisabled();
                }
                retrievalMessage.content = 'Memory retrieval cancelled.';
                await this.persistLocalAssistantStatus(retrievalMessage);
                throw this.createCancelledError();
            }

            console.error('Memory augment query failed:', error);
            const failure = createMemoryRetrievalFailure(error);
            retrievalMessage.content = failure.content;
            retrievalMessage.memoryRetrievalFailure = failure.reason;
            retrievalMessage.ciPromptDraft = null;
            await this.persistLocalAssistantStatus(retrievalMessage);
            return null;
        } finally {
            if (traceRefreshTimer) {
                clearTimeout(traceRefreshTimer);
            }
            this.memoryApprovalRequests.delete(retrievalMessage.id);
            cleanupMemoryAbortController();
        }
    }

    /**
     * Sanitizes messages for API calls by ensuring scrubbed content is used.
     * For assistant messages with scrubber metadata, always uses the redacted
     * (PII-free) response to prevent leaking restored PII to the model.
     *
     * @param {Array} messages - Array of messages from the database
     * @returns {Array} Messages safe for API calls
     */
    sanitizeMessagesForApi(messages) {
        return messages.map(msg => {
            // For assistant messages with scrubber data, always use redacted response
            if (msg.role === 'assistant' && msg.scrubber?.redactedResponse) {
                return { ...msg, content: msg.scrubber.redactedResponse };
            }
            // For user messages with scrubber data, always use redacted prompt
            if (msg.role === 'user' && msg.scrubber?.redacted) {
                return { ...msg, content: msg.scrubber.redacted };
            }
            return msg;
        });
    }

    /**
     * Check whether this session contains any scrubber data that can be restored.
     * @param {Array} messages - Array of messages from the database
     * @returns {boolean}
     */
    hasScrubberContext(messages) {
        if (!Array.isArray(messages)) return false;
        return messages.some(msg => (
            msg?.scrubber?.original ||
            msg?.scrubber?.redacted ||
            msg?.scrubber?.originalPrompt ||
            msg?.scrubber?.redactedPrompt
        ));
    }

    getMessageTextContent(content) {
        return getMessageTextContentValue(content);
    }

    getScrubberMessageContent(message, mode) {
        if (!message) return '';
        if (mode === 'redacted') {
            if (message.role === 'assistant' && message.scrubber?.redactedResponse) {
                return message.scrubber.redactedResponse;
            }
            if (message.role === 'user' && message.scrubber?.redacted) {
                return message.scrubber.redacted;
            }
            return message.content || '';
        }

        if (message.role === 'assistant') {
            if (message.scrubber?.restoredResponse) {
                return message.scrubber.restoredResponse;
            }
            return message.content || message.scrubber?.redactedResponse || '';
        }
        if (message.role === 'user' && message.scrubber?.original) {
            return message.scrubber.original;
        }
        return message.content || '';
    }

    buildScrubberTranscript(messages, mode) {
        if (!Array.isArray(messages)) return '';
        const lines = [];
        for (const message of messages) {
            const roleLabel = message.role === 'assistant'
                ? 'Assistant'
                : message.role === 'user'
                    ? 'User'
                    : message.role;
            const rawContent = this.getScrubberMessageContent(message, mode);
            const text = this.getMessageTextContent(rawContent).trim();
            if (!text) continue;
            lines.push(`${roleLabel}: ${text}`);
        }
        return lines.join('\n\n');
    }

    buildScrubberRestoreContext(messages) {
        return {
            original: this.buildScrubberTranscript(messages, 'original'),
            redacted: this.buildScrubberTranscript(messages, 'redacted')
        };
    }

    createAssistantScrubberMetadata({ originalPrompt, redactedPrompt, hasScrubberContext }) {
        const hasPrompt = !!(originalPrompt && redactedPrompt);
        const mode = hasPrompt ? 'prompt' : (hasScrubberContext ? 'context' : null);
        if (!mode) return null;
        return {
            mode,
            canRestore: true,
            originalPrompt: hasPrompt ? originalPrompt : null,
            redactedPrompt: hasPrompt ? redactedPrompt : null,
            redactedResponse: null,
            restoredResponse: null,
            restored: false
        };
    }

    /**
     * Processes messages with file metadata to convert them to multimodal content format.
     * This ensures files are included in conversation history for all API calls.
     *
     * Image attachment strategy:
     * - Only kicks in when switching from image-generating models to non-image models
     * - Only attaches MODEL OUTPUT images (not user uploads)
     * - Image models (matching /image/i) handle their own images natively
     * - Non-image models need images attached to user messages to see them
     *
     * @param {Array} messages - Array of messages from the database
     * @param {string} currentModelId - The model ID for the current request
     * @returns {Array} Processed messages with multimodal content
     */
    processMessagesWithFiles(messages, currentModelId) {
        const apiOverrideContent = this.getMemoryApiOverrideContent();
        return processMessagesForApi(messages, currentModelId, {
            apiOverrideContent,
            onTextFileDecodeError: (error, file) => {
                console.error('Failed to decode text file:', file.name, error);
            }
        });
    }

    refreshProcessedMessagesIfMemoryOverrideChanged(processedMessages, sourceMessages, modelIdForRequest, memoryGenerationAtProcess) {
        const currentGeneration = this._lastApiContentGeneration;
        const shouldRebuild = currentGeneration !== memoryGenerationAtProcess ||
            (currentGeneration !== null && !this.isMemoryFeatureActive(currentGeneration));
        if (!shouldRebuild) {
            return {
                processedMessages,
                memoryGenerationAtProcess
            };
        }
        return {
            processedMessages: this.processMessagesWithFiles(sourceMessages, modelIdForRequest),
            memoryGenerationAtProcess: this._lastApiContentGeneration
        };
    }

    /**
     * Regenerates the last assistant response without creating a new user message.
     * Used when the regenerate button is clicked on an assistant message.
     */
    async regenerateResponse(options = {}) {
        let session = this.getCurrentSession();
        if (!session) return;
        if (!options.skipMemoryAugment) this.clearMemoryApiOverrideContent();

        // Any local regeneration on an imported session forks it from upstream updates.
        if (session.importedFrom) {
            await this.markImportedSessionAsForked(session);
            this.updateUrlWithSession(session.id);
        }

        // Check if current session is already streaming
        const streamingState = this.getSessionStreamingState(session.id);
        if (streamingState.isStreaming) return;
        this.reserveAccessAcquisitionHandoff(session);
        this.chatArea?.closeQuickAskWindow?.();

        // Get the last user message to anchor during regeneration
        const messages = await chatDB.getSessionMessages(session.id);
        const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');

        // Create abort controller for this stream
        const abortController = new AbortController();
        const initialPendingPhase = this.resolvePendingPhaseForSession(session);
        this.setSessionStreamingState(session.id, true, abortController, initialPendingPhase);

        // Pause auto-scroll for streaming (set immediately)
        this.isAutoScrollPaused = true;

        // Reposition the prompt while the regenerated response streams.
        if (lastUserMessage && lastUserMessage.id) {
            this.startPromptSlideUpEffect(lastUserMessage.id);
        }

        try {
            const shouldAttemptMemoryAugment = lastUserMessage && !options.skipMemoryAugment;
            if (shouldAttemptMemoryAugment) {
                await this.removeLocalOnlyMessagesAfter(session.id, lastUserMessage.id);
                const memoryMessages = await chatDB.getSessionMessages(session.id);
                const conversationText = this.buildConversationText(memoryMessages);
                try {
                    await this.runMemoryAugmentFlow(lastUserMessage.content || '', lastUserMessage, session, {
                        conversationText,
                        signal: abortController.signal
                    });
                } catch (error) {
                    if (error?.isCancelled) {
                        return;
                    }
                    throw error;
                }
                if (abortController.signal.aborted) {
                    return;
                }
            }

            if (this.isCouncilModeActive(session)) {
                await this.councilController.runRegenerateTurn({
                    session,
                    userMessage: lastUserMessage,
                    searchEnabled: this.searchEnabled,
                    abortController,
                    initialPendingPhase,
                    preserveLocalOnlyMessages: shouldAttemptMemoryAugment || options.skipMemoryAugment === true
                });
                return;
            }

            const typingModelName = this.normalizeModelName(session.model) || session.model || this.state.pendingModelName || inferenceService.getDefaultModelName(session);
            const typingId = this.isViewingSession(session.id)
                ? this.showTypingIndicator(typingModelName, initialPendingPhase)
                : null;

            // Automatically acquire API key if needed
            const hasAccessToken = !!inferenceService.getAccessToken(session);
            const isAccessExpired = inferenceService.isAccessExpired(session);
            const accessLabel = inferenceService.getAccessLabel(session);
            if (!hasAccessToken || isAccessExpired) {
                try {
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage(`Acquiring ${accessLabel}...`, 'info');
                    }
                    await this.acquireAndSetAccess(session, {
                        signal: abortController.signal,
                        onGranted: () => {
                            this.advancePendingStateAfterAccessGranted(session.id, typingId);
                        }
                    });
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage(`Successfully acquired ${accessLabel}!`, 'success', 2000);
                    }
                } catch (error) {
                    if (typingId) this.removeTypingIndicator(typingId);
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage(error.message, 'error', 5000);
                    }
                    if (lastUserMessage?.id) {
                        await this.clearSessionTitleGenerationPending(session.id);
                    }
                    await this.addMessage('assistant', `**Error:** ${error.message}`, { isLocalOnly: true });
                    return;
                }
            }

            if (lastUserMessage?.id) {
                this.generateSessionTitleIfNeeded(session.id, lastUserMessage.id).catch(error => {
                    console.debug('Session title generation failed:', error);
                });
            }

            // Set current session for network logging
            if (window.networkLogger) {
                window.networkLogger.setCurrentSession(session.id);
            }

            let modelNameToUse = this.normalizeModelName(session.model);
            if (modelNameToUse !== session.model) {
                session.model = modelNameToUse;
                await chatDB.saveSession(session);
            }

            let selectedModelEntry = modelNameToUse
                ? this.state.models.find(m => m.name === modelNameToUse)
                : null;

            if (!selectedModelEntry) {
                const fallbackModel = this.getFallbackModelEntry(session);
                if (fallbackModel) {
                    selectedModelEntry = fallbackModel;
                    modelNameToUse = this.normalizeModelName(fallbackModel.name);
                    if (session.model !== modelNameToUse) {
                        session.model = modelNameToUse;
                        await chatDB.saveSession(session);
                        this.renderCurrentModel();
                    }
                }
            }

            if (!modelNameToUse || !selectedModelEntry) {
                console.warn('No available models to send message.');
                await this.addMessage('assistant', 'No models are available right now. Please add a model and try again.', { isLocalOnly: true });
                return;
            }

            const modelIdForRequest = selectedModelEntry.id;

            let streamingMessage = null;
            let streamedContent = '';
            let streamedReasoning = '';
            let firstChunkReceived = false;

            try {
                // Get AI response from inference backend with streaming
                const messages = await chatDB.getSessionMessages(session.id);
                const filteredMessages = messages.filter(msg => !msg.isLocalOnly);
                const sanitizedMessages = this.sanitizeMessagesForApi(filteredMessages);
                const hasScrubberContext = this.hasScrubberContext(filteredMessages);
                let scrubberOriginalPrompt = null;
                let scrubberRedactedPrompt = null;
                for (let i = filteredMessages.length - 1; i >= 0; i--) {
                    if (filteredMessages[i]?.role === 'user') {
                        scrubberOriginalPrompt = filteredMessages[i].scrubber?.original || null;
                        scrubberRedactedPrompt = filteredMessages[i].scrubber?.redacted || null;
                        break;
                    }
                }
                const scrubberMetadata = this.createAssistantScrubberMetadata({
                    originalPrompt: scrubberOriginalPrompt,
                    redactedPrompt: scrubberRedactedPrompt,
                    hasScrubberContext
                });

                // Process messages to include file content from stored metadata
                let processedMessages = this.processMessagesWithFiles(sanitizedMessages, modelIdForRequest);
                let memoryGenerationAtProcess = this._lastApiContentGeneration;

                // Create a placeholder message for streaming
                const streamingMessageId = this.generateId();
                let streamingTokenCount = 0;

                streamingMessage = {
                    id: streamingMessageId,
                    sessionId: session.id,
                    role: 'assistant',
                    content: '',
                    reasoning: '',
                    timestamp: Date.now(),
                    model: modelNameToUse,
                    tokenCount: null,
                    streamingTokens: 0,
                    streamingReasoning: false,
                    streamingPending: true, // Indicates waiting for first chunk
                    streamingPhase: this.getSessionStreamingState(session.id).phase || initialPendingPhase,
                    scrubber: scrubberMetadata
                };

                // Save placeholder immediately so switching sessions back can find it
                await chatDB.saveMessage(streamingMessage);
                ({
                    processedMessages,
                    memoryGenerationAtProcess
                } = this.refreshProcessedMessagesIfMemoryOverrideChanged(
                    processedMessages,
                    sanitizedMessages,
                    modelIdForRequest,
                    memoryGenerationAtProcess
                ));

                let lastSaveLength = 0;
                const SAVE_INTERVAL_CHARS = 100;
                let reasoningStartTime = null;

                // Stream the response with token tracking
                const tokenData = await inferenceService.streamCompletion(
                    processedMessages,
                    modelIdForRequest,
                    session,
                    async (chunk, imageData) => {
                        // On first chunk (of any kind), remove typing indicator and append message
                        if (!firstChunkReceived) {
                            firstChunkReceived = true;

                            // Clear pending flag now that we have actual content
                            streamingMessage.streamingPending = false;
                            streamingMessage.streamingPhase = null;

                            // Handle text content
                            if (chunk) {
                                streamedContent += chunk;
                                streamingMessage.content = streamedContent;
                                streamingMessage.streamingTokens = Math.ceil(streamedContent.length / 4);
                            }

                            // Handle image data
                            if (imageData && imageData.images) {
                                if (!streamingMessage.images) streamingMessage.images = [];
                                this.addImagesWithDedup(streamingMessage.images, imageData.images);
                            }

                            // Save message to DB (always) and append to UI (only if viewing this session)
                            if (chunk || (imageData && imageData.images)) {
                                await chatDB.saveMessage(streamingMessage);
                                if (this.chatArea && this.isViewingSession(session.id)) {
                                    await this.chatArea.appendMessage(streamingMessage);
                                }
                            }
                            return; // Exit after first chunk handling
                        }

                        // Handle subsequent chunks
                        if (chunk) streamedContent += chunk;

                        // Handle image data
                        if (imageData && imageData.images) {
                            if (!streamingMessage.images) streamingMessage.images = [];
                            this.addImagesWithDedup(streamingMessage.images, imageData.images);
                            await chatDB.saveMessage(streamingMessage);
                            // Only update UI if still viewing the same session
                            if (this.chatArea && this.isViewingSession(session.id)) {
                                this.chatArea.updateStreamingImages(streamingMessageId, streamingMessage.images);
                            }
                        }

                        if (streamedContent.length - lastSaveLength >= SAVE_INTERVAL_CHARS) {
                            streamingMessage.content = streamedContent;
                            streamingMessage.streamingTokens = Math.ceil(streamedContent.length / 4);
                            await chatDB.saveMessage(streamingMessage);
                            lastSaveLength = streamedContent.length;
                        }

                        // Only update UI if still viewing the same session
                        if (chunk && this.chatArea && this.isViewingSession(session.id)) {
                            this.chatArea.updateStreamingMessage(streamingMessageId, streamedContent);
                        }
                    },
                    (tokenUpdate) => {
                        streamingTokenCount = tokenUpdate.completionTokens || 0;
                    },
                    [], // No files for regeneration (files are included in processedMessages)
                    this.searchEnabled, // Use current search toggle state
                    abortController,
                    async () => {
                        this.updateSessionStreamingPhase(session.id, 'stream-open');
                        streamingMessage.streamingPhase = this.getSessionStreamingState(session.id).phase;
                        if (typingId) {
                            this.updateTypingIndicator(typingId, 'stream-open');
                        }
                    },
                    async (reasoningChunk) => {
                        // Handle reasoning trace streaming
                        if (!firstChunkReceived) {
                            firstChunkReceived = true;
                            reasoningStartTime = Date.now();
                            // Clear pending flag now that we have actual content
                            streamingMessage.streamingPending = false;
                            streamingMessage.streamingPhase = null;
                            streamingMessage.reasoning = reasoningChunk;
                            streamingMessage.streamingReasoning = true;
                            streamedReasoning = reasoningChunk;
                            await chatDB.saveMessage(streamingMessage);
                            // Only update UI if still viewing the same session
                            if (this.chatArea && this.isViewingSession(session.id)) {
                                await this.chatArea.appendMessage(streamingMessage);
                            }
                        } else {
                            streamedReasoning += reasoningChunk;
                            streamingMessage.reasoning = streamedReasoning;
                            // Save reasoning frequently so session switch can restore state
                            await chatDB.saveMessage(streamingMessage);
                        }

                        // Only update UI if still viewing the same session
                        if (this.chatArea && this.isViewingSession(session.id)) {
                            this.chatArea.updateStreamingReasoning(streamingMessageId, streamedReasoning);
                        }
                    },
                    this.reasoningEnabled, // Use current reasoning toggle state
                    this.reasoningEffort
                );

                // Save the final message content with token data, reasoning, and citations
                streamingMessage.content = streamedContent;
                if (streamingMessage.scrubber) {
                    streamingMessage.scrubber.redactedResponse = streamedContent;
                }
                const rawReasoning = tokenData.reasoning || streamedReasoning || null;
                // Parse and save the cleaned reasoning
                streamingMessage.reasoning = rawReasoning ? parseReasoningContent(rawReasoning) : null;
                streamingMessage.tokenCount = tokenData.totalTokens || tokenData.completionTokens || streamingTokenCount;
                const streamReportedModel = tokenData.model || modelIdForRequest;
                const resolvedFinalModelName = this.normalizeModelName(
                    inferenceService.getDisplayName(streamReportedModel, modelNameToUse, session)
                ) || modelNameToUse;
                streamingMessage.model = resolvedFinalModelName;
                streamingMessage.streamingTokens = null;
                streamingMessage.streamingReasoning = false;
                streamingMessage.streamingPending = false;
                streamingMessage.citations = tokenData.citations || null;

                // Calculate reasoning duration if reasoning was used
                if (streamingMessage.reasoning && reasoningStartTime) {
                    const reasoningEndTime = Date.now();
                    streamingMessage.reasoningDuration = reasoningEndTime - reasoningStartTime;
                }

                await chatDB.saveMessage(streamingMessage);
                await this.refreshSessionConversationSearchText(session, null, { persist: true });

                // Fetch metadata for citations asynchronously and update UI
                if (streamingMessage.citations && streamingMessage.citations.length > 0) {
                    this.enrichCitationsAndUpdateUI(streamingMessage);
                }

                // Only update UI if still viewing the same session
                if (this.chatArea && this.isViewingSession(session.id)) {
                    // Re-render the completed message so partial streaming markdown/citation DOM
                    // is replaced by the final render pipeline.
                    await this.chatArea.finalizeStreamingMessage(streamingMessage);
                    // Finalize reasoning display with markdown processing and timing
                    if (streamingMessage.reasoning) {
                        this.chatArea.finalizeReasoningDisplay(streamingMessageId, streamingMessage.reasoning, streamingMessage.reasoningDuration);
                    }
                }

                // Pre-cache scrubber restoration in background (if applicable)
                if (streamingMessage.scrubber?.canRestore) {
                    this.preCacheScrubberRestore(streamingMessage);
                }

                this.triggerPostTurnMemoryExtraction(session);

            } catch (error) {
                console.error('Error getting AI response:', error);
                if (typingId) this.removeTypingIndicator(typingId);

                if (error.isCancelled) {
                    // If cancelled before first chunk, delete the placeholder message
                    if (streamingMessage && !firstChunkReceived) {
                        await chatDB.deleteMessage(streamingMessage.id);
                        // Remove from UI if viewing this session
                        if (this.isViewingSession(session.id)) {
                            const messageEl = document.querySelector(`[data-message-id="${streamingMessage.id}"]`);
                            if (messageEl) {
                                messageEl.remove();
                            }
                        }
                    }
                    if (streamingMessage && firstChunkReceived) {
                        if (streamedContent.trim() || streamedReasoning.trim()) {
                            streamingMessage.content = streamedContent;
                            // Parse and save the cleaned reasoning
                            streamingMessage.reasoning = streamedReasoning ? parseReasoningContent(streamedReasoning) : null;
                            streamingMessage.tokenCount = null;
                            streamingMessage.streamingTokens = null;
                            streamingMessage.streamingReasoning = false;
                            streamingMessage.streamingPending = false;
                            await chatDB.saveMessage(streamingMessage);
                            // Only update UI if still viewing the same session
                            if (this.chatArea && this.isViewingSession(session.id)) {
                                await this.chatArea.finalizeStreamingMessage(streamingMessage);
                                // Finalize reasoning display with markdown processing
                                if (streamingMessage.reasoning) {
                                    this.chatArea.finalizeReasoningDisplay(streamingMessage.id, streamingMessage.reasoning);
                                }
                            }
                        } else {
                            await chatDB.deleteMessage(streamingMessage.id);
                            // Only remove from UI if still viewing the same session
                            if (this.isViewingSession(session.id)) {
                                const messageEl = document.querySelector(`[data-message-id="${streamingMessage.id}"]`);
                                if (messageEl) {
                                    messageEl.remove();
                                }
                            }
                        }
                    }
                } else {
                    if (firstChunkReceived && streamingMessage) {
                        streamingMessage.content = 'Sorry, I encountered an error while processing your request.';
                        streamingMessage.tokenCount = null;
                        streamingMessage.streamingTokens = null;
                        streamingMessage.streamingReasoning = false;
                        streamingMessage.streamingPending = false;
                        await chatDB.saveMessage(streamingMessage);
                        // Only update UI if still viewing the same session
                        if (this.chatArea && this.isViewingSession(session.id)) {
                            await this.chatArea.finalizeStreamingMessage(streamingMessage);
                        }
                    } else {
                        // Error before first chunk - delete placeholder and show error
                        if (streamingMessage) {
                            await chatDB.deleteMessage(streamingMessage.id);
                            // Remove from UI if viewing this session
                            if (this.isViewingSession(session.id)) {
                                const messageEl = document.querySelector(`[data-message-id="${streamingMessage.id}"]`);
                                if (messageEl) {
                                    messageEl.remove();
                                }
                            }
                        }
                        if (this.isViewingSession(session.id)) {
                            await this.addMessage('assistant', 'Sorry, I encountered an error while processing your request.', { isLocalOnly: true });
                        }
                    }
                }
            }
        } finally {
            this.clearMemoryApiOverrideContent();
            this.setSessionStreamingState(session.id, false, null);
            // Reset auto-scroll state and hide button
            this.isAutoScrollPaused = false;
            this.updateScrollButtonVisibility();
            requestAnimationFrame(() => {
                this.elements.messageInput.focus();
            });
        }
    }

    async regenerateCouncilLane(messageId, laneId, options = {}) {
        let session = this.getCurrentSession();
        if (!session || !messageId || !laneId) return;
        if (!options.skipMemoryAugment) this._lastApiContent = null;

        if (session.importedFrom) {
            await this.markImportedSessionAsForked(session);
            this.updateUrlWithSession(session.id);
        }

        const streamingState = this.getSessionStreamingState(session.id);
        if (streamingState.isStreaming) return;
        this.reserveAccessAcquisitionHandoff(session);
        this.chatArea?.closeQuickAskWindow?.();

        const messages = await chatDB.getSessionMessages(session.id);
        const messageIndex = messages.findIndex(m => m.id === messageId);
        if (messageIndex === -1) return;

        const assistantMessage = messages[messageIndex];
        if (assistantMessage?.role !== 'assistant' || !Array.isArray(assistantMessage?.council?.stage1)) return;
        if (assistantMessage.council.synthesis) {
            this.showToast?.('Per-model regenerate is available in Parallel mode before Council review.');
            return;
        }
        const stageEntry = this.findCouncilStageEntryByLane(assistantMessage, laneId);
        if (!stageEntry?.response) return;

        const userMessage = [...messages.slice(0, messageIndex)].reverse().find(m => m.role === 'user');
        if (!userMessage) return;

        const messagesToDelete = messages.slice(messageIndex + 1);
        for (const msg of messagesToDelete) {
            await chatDB.deleteMessage(msg.id);
        }
        const remainingMessages = messages.slice(0, messageIndex + 1);
        await this.recomputeSessionCouncilTranscriptHint?.(session, remainingMessages);
        if (this.chatArea && this.isViewingSession(session.id)) {
            await this.chatArea.render();
        }

        const abortController = new AbortController();
        const initialPendingPhase = this.resolvePendingPhaseForSession(session);
        this.setSessionStreamingState(session.id, true, abortController, initialPendingPhase);
        this.isAutoScrollPaused = true;

        if (userMessage.id) {
            this.startPromptSlideUpEffect(userMessage.id);
        }

        try {
            const shouldAttemptMemoryAugment = userMessage && !options.skipMemoryAugment;
            if (shouldAttemptMemoryAugment) {
                const conversationText = this.buildConversationText(messages.slice(0, messageIndex));
                try {
                    await this.runMemoryAugmentFlow(userMessage.content || '', userMessage, session, {
                        conversationText,
                        signal: abortController.signal
                    });
                } catch (error) {
                    if (error?.isCancelled) {
                        return;
                    }
                    throw error;
                }
                if (abortController.signal.aborted) {
                    return;
                }
            }

            await this.councilController.runRegenerateLaneTurn({
                session,
                assistantMessageId: messageId,
                laneId,
                userMessage,
                searchEnabled: this.searchEnabled,
                abortController,
                initialPendingPhase
            });

            if (this.chatArea && this.isViewingSession(session.id)) {
                await this.chatArea.render();
            }
        } catch (error) {
            if (!this.isCancelledError(error, abortController.signal)) {
                console.error('Error regenerating Parallel lane:', error);
                if (this.floatingPanel) {
                    this.floatingPanel.showMessage(error.message, 'error', 5000);
                }
                if (this.isViewingSession(session.id)) {
                    await this.addMessage('assistant', `**Error:** ${error.message}`, { isLocalOnly: true });
                }
            }
        } finally {
            this._lastApiContent = null;
            this.setSessionStreamingState(session.id, false, null);
            this.isAutoScrollPaused = false;
            this.updateScrollButtonVisibility();
            requestAnimationFrame(() => {
                this.elements.messageInput.focus();
            });
        }
    }

    /**
     * Sends a user message and streams the AI response.
     * Handles API key acquisition, model selection, and streaming updates.
     */
    async sendMessage() {
        if (!await this.ensureDatabaseReady()) {
            return;
        }

        // Check if there's content to send
        const rawContent = this.elements.messageInput.value || '';
        const content = rawContent.trim();
        const hasFiles = this.uploadedFiles.length > 0;
        if (!content && !hasFiles) return;
        this.clearMemoryApiOverrideContent();

        // Create session if none exists (first message creates the session)
        if (!this.getCurrentSession()) {
            await this.createSession();
        }

        let session = this.getCurrentSession();
        if (!session) return; // Safety check

        // Any local user message on an imported session forks it from upstream updates.
        if (session.importedFrom) {
            await this.markImportedSessionAsForked(session);
            this.updateUrlWithSession(session.id);
        }

        // Block sending if station is banned (check both state and cached broadcast data)
        const verifier = inferenceService.getVerificationAdapter(session);
        const accessInfo = inferenceService.getAccessInfo(session);
        const accessId = verifier?.getAccessId(accessInfo?.info);
        if (verifier?.supports &&
            accessId &&
            hasExplicitVerifierApprovalForAccessInfo(accessInfo?.info)) {
            const stationState = verifier.getAccessState(accessId);
            // Also check cached broadcast data directly
            const isBannedInCache = verifier.isAccessBanned(accessId);

            if (stationState?.banned || isBannedInCache) {
                console.log(`🚫 Station ${accessId} is banned (state: ${stationState?.banned}, cache: ${isBannedInCache})`);
                // Get ban info from state or cache
                const broadcastData = verifier.getLastBroadcastData();
                const bannedInfo = broadcastData?.banned_stations?.find(s => s.station_id === accessId);

                this.showBannedStationWarningModal({
                    stationId: accessId,
                    reason: stationState?.banReason || bannedInfo?.reason || 'Unknown',
                    bannedAt: stationState?.bannedAt || bannedInfo?.banned_at,
                    sessionId: session.id
                });
                return; // Block the message
            }
        }

        // Check if current session is already streaming
        const streamingState = this.getSessionStreamingState(session.id);
        if (streamingState.isStreaming) return;
        this.reserveAccessAcquisitionHandoff(session);
        this.chatArea?.closeQuickAskWindow?.();

        // Create abort controller for this stream
        const abortController = new AbortController();
        const initialPendingPhase = this.resolvePendingPhaseForSession(session);
        this.setSessionStreamingState(session.id, true, abortController, initialPendingPhase);

        // Store current files and search state before clearing
        const currentFiles = [...this.uploadedFiles];
        const searchEnabled = this.searchEnabled;

        try {

            let scrubberOriginalPrompt = null;
            let scrubberRedactedPrompt = null;
            if (this.scrubberPending && this.scrubberPending.redacted?.trim() === content) {
                scrubberOriginalPrompt = this.scrubberPending.original;
                scrubberRedactedPrompt = this.scrubberPending.redacted;
            }
            this.scrubberPending = null;

            // Add user message with file metadata
            const metadata = {};
            if (hasFiles) {
                metadata.files = await this.buildMessageFileMetadata(currentFiles);
            }
            if (searchEnabled) {
                metadata.searchEnabled = true;
            }
            // Store scrubber info on user message for toggle functionality
            if (scrubberOriginalPrompt && scrubberRedactedPrompt) {
                metadata.scrubber = {
                    original: scrubberOriginalPrompt,
                    redacted: scrubberRedactedPrompt,
                    showingOriginal: false
                };
            }
            this.isAutoScrollPaused = true;
            const userMessage = await this.addMessage('user', content || '', metadata);
            if (userMessage?.id) {
                emitDesktopEvent('oa-desktop:user-message-added', {
                    sessionId: session.id,
                    messageId: userMessage.id
                });
            }

            // Clear input and files
            this.elements.messageInput.value = '';
            this.uploadedFiles = [];
            this.fileUndoStack = []; // Clear undo stack when message is sent
            this.renderFilePreviews();
            this.updateFileCountBadge();
            this.updateInputState();
            this.resetMessageInputLayout({ resetScroll: true });

            // Auto-scroll remains paused while the response streams.
            if (userMessage && userMessage.id) {
                this.startPromptSlideUpEffect(userMessage.id);
            }

            if (this.memoryFeatureEnabled && this.memoryMode && content && userMessage) {
                const memoryMessages = await chatDB.getSessionMessages(session.id);
                const conversationText = this.buildConversationText(memoryMessages);
                try {
                    await this.runMemoryAugmentFlow(content, userMessage, session, {
                        conversationText,
                        signal: abortController.signal
                    });
                } catch (error) {
                    if (error?.isCancelled) {
                        return;
                    }
                    throw error;
                }
                if (abortController.signal.aborted) {
                    return;
                }
            }

            if (this.isCouncilModeActive(session)) {
                await this.councilController.runSendTurn({
                    session,
                    userMessage,
                    searchEnabled,
                    abortController,
                    initialPendingPhase,
                    scrubberOriginalPrompt,
                    scrubberRedactedPrompt
                });
                return;
            }

            const typingModelName = this.normalizeModelName(session.model) || session.model || this.state.pendingModelName || inferenceService.getDefaultModelName(session);
            let typingId = this.isViewingSession(session.id)
                ? this.showTypingIndicator(typingModelName, initialPendingPhase)
                : null;

            // Automatically acquire API key if needed
            const hasAccessToken = !!inferenceService.getAccessToken(session);
            const isAccessExpired = inferenceService.isAccessExpired(session);
            const accessLabel = inferenceService.getAccessLabel(session);
            if (!hasAccessToken || isAccessExpired) {
                try {
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage(`Acquiring ${accessLabel}...`, 'info');
                    }
                    await this.acquireAndSetAccess(session, {
                        signal: abortController.signal,
                        onGranted: () => {
                            this.advancePendingStateAfterAccessGranted(session.id, typingId);
                        }
                    });
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage(`${accessLabel} ready`, 'success', 2000);
                    }
                } catch (error) {
                    if (typingId) this.removeTypingIndicator(typingId);
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage(error.message, 'error', 5000);
                    }
                    if (userMessage?.id) {
                        await this.clearSessionTitleGenerationPending(session.id);
                    }
                    await this.addMessage('assistant', `**Error:** ${error.message}`, { isLocalOnly: true });
                    return; // Return early if key acquisition fails
                }
            }

            if (userMessage?.id) {
                this.generateSessionTitleIfNeeded(session.id, userMessage.id).catch(error => {
                    console.debug('Session title generation failed:', error);
                });
            }

            // Set current session for network logging
            if (window.networkLogger) {
                window.networkLogger.setCurrentSession(session.id);
            }

            let modelNameToUse = this.normalizeModelName(session.model);
            if (modelNameToUse !== session.model) {
                session.model = modelNameToUse;
                await chatDB.saveSession(session);
            }

            let selectedModelEntry = modelNameToUse
                ? this.state.models.find(m => m.name === modelNameToUse)
                : null;

            if (!selectedModelEntry) {
                const fallbackModel = this.getFallbackModelEntry(session);
                if (fallbackModel) {
                    selectedModelEntry = fallbackModel;
                    modelNameToUse = this.normalizeModelName(fallbackModel.name);
                    if (session.model !== modelNameToUse) {
                        session.model = modelNameToUse;
                        await chatDB.saveSession(session);
                        this.renderCurrentModel();
                    }
                }
            }

            if (!modelNameToUse || !selectedModelEntry) {
                console.warn('No available models to send message.');
                await this.addMessage('assistant', 'No models are available right now. Please add a model and try again.', { isLocalOnly: true });
                return; // Return early
            }

            const modelIdForRequest = selectedModelEntry.id;

            // Declare variables outside try block so they're accessible in catch
            let streamingMessage = null;
            let firstChunkReceived = false;
            let streamedContent = '';
            let streamedReasoning = '';

            // Retry configuration for transient errors
            const MAX_RETRIES = 2;
            let retryCount = 0;
            let accessRefreshAttempted = false;

            // Helper to check if error is retryable (only before streaming starts)
            const isRetryableError = (error) => {
                if (error.isCancelled) return false;
                // Gateway errors are retryable
                if ([502, 503, 504].includes(error.status)) return true;
                // Generic errors (no specific status or unrecognized) are retryable
                const errorMsg = error.message || '';
                const hasSpecificError = error.status === 401 || error.status === 402 ||
                    errorMsg.includes('proxy') || errorMsg.includes('Proxy') ||
                    errorMsg.includes('No API key');
                return !hasSpecificError;
            };

            retryLoop: while (retryCount <= MAX_RETRIES) {
            try {
                // Get AI response from inference backend with streaming
                const messages = await chatDB.getSessionMessages(session.id);
                const filteredMessages = messages.filter(msg => !msg.isLocalOnly);
                const sanitizedMessages = this.sanitizeMessagesForApi(filteredMessages);
                const hasScrubberContext = this.hasScrubberContext(filteredMessages);
                const scrubberMetadata = this.createAssistantScrubberMetadata({
                    originalPrompt: scrubberOriginalPrompt,
                    redactedPrompt: scrubberRedactedPrompt,
                    hasScrubberContext
                });

                // Process messages to include file content from stored metadata
                let processedMessages = this.processMessagesWithFiles(sanitizedMessages, modelIdForRequest);
                let memoryGenerationAtProcess = this._lastApiContentGeneration;

                // Create a placeholder message for streaming
                const streamingMessageId = this.generateId();
                streamedContent = '';
                streamedReasoning = '';
                let streamingTokenCount = 0;

                // Prepare assistant message object (don't save to DB yet - wait for first chunk)
                streamingMessage = {
                    id: streamingMessageId,
                    sessionId: session.id,
                    role: 'assistant',
                    content: '',
                    reasoning: '',
                    timestamp: Date.now(),
                    model: modelNameToUse,
                    tokenCount: null,
                    streamingTokens: 0,
                    streamingReasoning: false,
                    streamingPending: true,
                    streamingPhase: this.getSessionStreamingState(session.id).phase || initialPendingPhase,
                    scrubber: scrubberMetadata
                };

                // Track progress for periodic saves
                let lastSaveLength = 0;
                const SAVE_INTERVAL_CHARS = 100; // Save every 100 characters
                firstChunkReceived = false;
                let firstContentChunk = true; // Track when content starts (after reasoning)
                let reasoningStartTime = null;
                let reasoningEndTime = null;
                ({
                    processedMessages,
                    memoryGenerationAtProcess
                } = this.refreshProcessedMessagesIfMemoryOverrideChanged(
                    processedMessages,
                    sanitizedMessages,
                    modelIdForRequest,
                    memoryGenerationAtProcess
                ));

                // Stream the response with token tracking
                const tokenData = await inferenceService.streamCompletion(
                    processedMessages,
                    modelIdForRequest,
                    session,
                    async (chunk, imageData) => {
                        // On first chunk (of any kind), remove typing indicator and append message
                        if (!firstChunkReceived) {
                            firstChunkReceived = true;
                            streamingMessage.streamingPending = false;
                            streamingMessage.streamingPhase = null;

                            // Handle text content
                            if (chunk) {
                                streamedContent += chunk;
                                streamingMessage.content = streamedContent;
                                streamingMessage.streamingTokens = Math.ceil(streamedContent.length / 4);

                                // If reasoning happened before content, finalize reasoning display now
                                if (reasoningStartTime && streamedReasoning.length > 0) {
                                    reasoningEndTime = Date.now();
                                    const reasoningDuration = reasoningEndTime - reasoningStartTime;

                                    // Update the reasoning subtitle to show duration immediately (only if viewing this session)
                                    if (this.chatArea && this.isViewingSession(session.id)) {
                                        this.chatArea.updateReasoningSubtitleToDuration(
                                            streamingMessageId,
                                            reasoningDuration
                                        );
                                    }
                                    firstContentChunk = false; // Mark that we've handled the transition
                                }
                            }

                            // Handle image data
                            if (imageData && imageData.images) {
                                if (!streamingMessage.images) streamingMessage.images = [];
                                this.addImagesWithDedup(streamingMessage.images, imageData.images);
                            }

                            // Save message to DB (always) and append to UI (only if viewing this session)
                            if (chunk || (imageData && imageData.images)) {
                                await chatDB.saveMessage(streamingMessage);
                                if (this.chatArea && this.isViewingSession(session.id)) {
                                    await this.chatArea.appendMessage(streamingMessage);
                                }
                            }
                            return; // Exit after first chunk handling
                        }

                        // Handle subsequent chunks
                        if (chunk) {
                            streamedContent += chunk;

                            // If this is the first content chunk after reasoning, finalize reasoning display
                            if (firstContentChunk && reasoningStartTime && streamedReasoning.length > 0) {
                                firstContentChunk = false;
                                reasoningEndTime = Date.now();
                                const reasoningDuration = reasoningEndTime - reasoningStartTime;

                                // Update the reasoning subtitle to show duration immediately (only if viewing this session)
                                if (this.chatArea && this.isViewingSession(session.id)) {
                                    this.chatArea.updateReasoningSubtitleToDuration(
                                        streamingMessageId,
                                        reasoningDuration
                                    );
                                }
                            }
                        }

                        if (imageData && imageData.images) {
                            if (!streamingMessage.images) streamingMessage.images = [];
                            this.addImagesWithDedup(streamingMessage.images, imageData.images);
                            await chatDB.saveMessage(streamingMessage);
                            // Only update UI if still viewing the same session
                            if (this.chatArea && this.isViewingSession(session.id)) {
                                this.chatArea.updateStreamingImages(streamingMessageId, streamingMessage.images);
                            }
                        }

                        // Periodically save partial content
                        if (chunk && streamedContent.length - lastSaveLength >= SAVE_INTERVAL_CHARS) {
                            streamingMessage.content = streamedContent;
                            streamingMessage.streamingTokens = Math.ceil(streamedContent.length / 4);
                            await chatDB.saveMessage(streamingMessage);
                            lastSaveLength = streamedContent.length;
                        }

                        // Update UI with new content (only if viewing this session)
                        if (chunk && this.chatArea && this.isViewingSession(session.id)) {
                            this.chatArea.updateStreamingMessage(streamingMessageId, streamedContent);
                        }
                    },
                    (tokenUpdate) => {
                        streamingTokenCount = tokenUpdate.completionTokens || 0;
                    },
                    [], // Files are now included in processedMessages, not passed separately
                    searchEnabled,
                    abortController,
                    async () => {
                        this.updateSessionStreamingPhase(session.id, 'stream-open');
                        streamingMessage.streamingPhase = this.getSessionStreamingState(session.id).phase;
                        if (typingId) {
                            this.updateTypingIndicator(typingId, 'stream-open');
                        }
                    },
                    async (reasoningChunk) => {
                        // Handle reasoning trace streaming
                        if (!firstChunkReceived) {
                            firstChunkReceived = true;
                            reasoningStartTime = Date.now();
                            streamingMessage.streamingPending = false;
                            streamingMessage.streamingPhase = null;
                            streamingMessage.reasoning = reasoningChunk;
                            streamingMessage.streamingReasoning = true;
                            streamedReasoning = reasoningChunk;
                            await chatDB.saveMessage(streamingMessage);
                            // Only update UI if still viewing the same session
                            if (this.chatArea && this.isViewingSession(session.id)) {
                                await this.chatArea.appendMessage(streamingMessage);
                            }
                        } else {
                            streamedReasoning += reasoningChunk;
                            streamingMessage.reasoning = streamedReasoning;
                        }

                        // Update UI with new reasoning content (only if viewing this session)
                        if (this.chatArea && this.isViewingSession(session.id)) {
                            this.chatArea.updateStreamingReasoning(streamingMessageId, streamedReasoning);
                        }
                    },
                    this.reasoningEnabled,
                    this.reasoningEffort
                );

                // Save the final message content with token data, reasoning, and citations
                streamingMessage.content = streamedContent;
                if (streamingMessage.scrubber) {
                    streamingMessage.scrubber.redactedResponse = streamedContent;
                }
                const rawReasoning = tokenData.reasoning || streamedReasoning || null;
                // Parse and save the cleaned reasoning
                streamingMessage.reasoning = rawReasoning ? parseReasoningContent(rawReasoning) : null;
                streamingMessage.tokenCount = tokenData.completionTokens || streamingTokenCount;
                const streamReportedModel = tokenData.model || modelIdForRequest;
                const resolvedFinalModelName = this.normalizeModelName(
                    inferenceService.getDisplayName(streamReportedModel, modelNameToUse, session)
                ) || modelNameToUse;
                streamingMessage.model = resolvedFinalModelName;
                streamingMessage.streamingTokens = null; // Clear streaming tokens after completion
                streamingMessage.streamingReasoning = false; // Clear streaming reasoning flag
                streamingMessage.citations = tokenData.citations || null;

                // Calculate reasoning duration if reasoning was used
                if (streamingMessage.reasoning && reasoningStartTime) {
                    // Use already-calculated end time if available, otherwise calculate now
                    const finalReasoningEndTime = reasoningEndTime || Date.now();
                    streamingMessage.reasoningDuration = finalReasoningEndTime - reasoningStartTime;
                }

                await chatDB.saveMessage(streamingMessage);
                await this.refreshSessionConversationSearchText(session, null, { persist: true });

                // Fetch metadata for citations asynchronously and update UI
                if (streamingMessage.citations && streamingMessage.citations.length > 0) {
                    this.enrichCitationsAndUpdateUI(streamingMessage);
                }

                // Re-render the message to finalize its state (only if viewing this session)
                if (this.chatArea && this.isViewingSession(session.id)) {
                    await this.chatArea.finalizeStreamingMessage(streamingMessage);
                    // Finalize reasoning display with markdown processing and timing
                    if (streamingMessage.reasoning) {
                        this.chatArea.finalizeReasoningDisplay(streamingMessage.id, streamingMessage.reasoning, streamingMessage.reasoningDuration);
                    }
                }

                // Pre-cache scrubber restoration in background (if applicable)
                if (streamingMessage.scrubber?.canRestore) {
                    this.preCacheScrubberRestore(streamingMessage);
                }

                this.triggerPostTurnMemoryExtraction(session);

                break retryLoop; // Success - exit retry loop

            } catch (error) {
                console.error('Error getting AI response:', error);
                if (typingId) this.removeTypingIndicator(typingId);

                // Check if error was due to cancellation
                if (error.isCancelled) {
                    // Keep the partial message if there's content, otherwise remove it
                    if (streamingMessage && firstChunkReceived) {
                        if (streamedContent.trim() || streamedReasoning.trim()) {
                            // Save the partial content with a note
                            streamingMessage.content = streamedContent;
                            // Parse and save the cleaned reasoning
                            streamingMessage.reasoning = streamedReasoning ? parseReasoningContent(streamedReasoning) : null;
                            streamingMessage.tokenCount = null;
                            streamingMessage.streamingTokens = null;
                            streamingMessage.streamingReasoning = false;
                            await chatDB.saveMessage(streamingMessage);
                            // Only update UI if still viewing the same session
                            if (this.chatArea && this.isViewingSession(session.id)) {
                                await this.chatArea.finalizeStreamingMessage(streamingMessage);
                                // Finalize reasoning display with markdown processing
                                if (streamingMessage.reasoning) {
                                    this.chatArea.finalizeReasoningDisplay(streamingMessage.id, streamingMessage.reasoning);
                                }
                            }
                        } else {
                            // Remove empty message if no content was generated
                            await chatDB.deleteMessage(streamingMessage.id);
                            // Only remove from UI if still viewing the same session
                            if (this.isViewingSession(session.id)) {
                                const messageEl = document.querySelector(`[data-message-id="${streamingMessage.id}"]`);
                                if (messageEl) {
                                    messageEl.remove();
                                }
                            }
                        }
                    }
                    // If firstChunkReceived is false, message was never added to UI or DB, nothing to clean up
                    break retryLoop; // Don't retry cancelled requests
                }

                let terminalError = error;

                if (!firstChunkReceived && !accessRefreshAttempted && this.isAccessCreditExhaustedError(error)) {
                    accessRefreshAttempted = true;
                    const refreshPendingPhase = 'requesting-key';
                    this.updateSessionStreamingPhase(session.id, refreshPendingPhase);
                    typingId = this.isViewingSession(session.id) ? this.showTypingIndicator(modelNameToUse, refreshPendingPhase) : null;

                    try {
                        await this.refreshAccessAfterCreditExhaustion(session, { typingId });
                        continue retryLoop;
                    } catch (refreshError) {
                        console.error('Failed to refresh exhausted ephemeral key:', refreshError);
                        terminalError = refreshError;
                    }
                }

                // Check if we should retry (only if no content received yet)
                if (!firstChunkReceived && retryCount < MAX_RETRIES && isRetryableError(error)) {
                    retryCount++;
                    console.log(`Retrying request (attempt ${retryCount + 1}/${MAX_RETRIES + 1}) after error:`, error.message);
                    // Small delay before retry (500ms * attempt number)
                    await new Promise(r => setTimeout(r, 500 * retryCount));
                    // Re-show typing indicator for retry
                    if (typingId) this.removeTypingIndicator(typingId);
                    const retryPendingPhase = this.resolvePendingPhaseForSession(session);
                    this.updateSessionStreamingPhase(session.id, retryPendingPhase);
                    typingId = this.isViewingSession(session.id) ? this.showTypingIndicator(modelNameToUse, retryPendingPhase) : null;
                    continue retryLoop;
                }

                // Non-retryable or exhausted retries - show error to user
                const errorMessage = terminalError.message;

                // Customize messages for specific error types
                let userFriendlyMessage = `Sorry, I encountered an error while processing your request. Try re-submitting the query. **Error**: ${errorMessage}`;

                // The following are inference backend HTTP status codes, not OA infra
                if (terminalError.status === 402) {
                    // Credit/token limit errors
                    userFriendlyMessage = `Sorry, I encountered an error while processing your request. Try submitting the query again. **Error**: ${errorMessage}`;
                } else if (terminalError.status === 401) {
                    // Authentication errors
                    userFriendlyMessage = `Authentication error. Please check the system panel (right side) and submit an issue at [issue](https://docs.google.com/forms/d/e/1FAIpQLSfIwuJ6sMTm1XISiVyb3P1ueK3SFZ_4vLj9-KH4FATodVfyxA/viewform?usp=publish-editor)!`;
                } else if (terminalError.status === 503 || terminalError.status === 502 || terminalError.status === 504) {
                    // Service unavailable / gateway errors (after retries exhausted)
                    userFriendlyMessage = `Gateway error (after ${retryCount} retries). Please take a look at the system panel and submit an issue at [issue](https://docs.google.com/forms/d/e/1FAIpQLSfIwuJ6sMTm1XISiVyb3P1ueK3SFZ_4vLj9-KH4FATodVfyxA/viewform?usp=publish-editor).`;
                } else if (errorMessage.includes('proxy') || errorMessage.includes('Proxy')) {
                    // Proxy/connection errors
                    userFriendlyMessage = `Proxy error. Please take a look at the system panel and submit an issue at [issue](https://docs.google.com/forms/d/e/1FAIpQLSfIwuJ6sMTm1XISiVyb3P1ueK3SFZ_4vLj9-KH4FATodVfyxA/viewform?usp=publish-editor).`;
                } else if (errorMessage.includes('No API key')) {
                    // No API key errors
                    userFriendlyMessage = `API key error. Please take a look at the system panel and submit an issue at [issue](https://docs.google.com/forms/d/e/1FAIpQLSfIwuJ6sMTm1XISiVyb3P1ueK3SFZ_4vLj9-KH4FATodVfyxA/viewform?usp=publish-editor).`;
                } else {
                    // Generic fallback (after retries if applicable)
                    const retryNote = retryCount > 0 ? ` (after ${retryCount} retries)` : '';
                    userFriendlyMessage = `⚠️ **Error**${retryNote}: ${errorMessage}`;
                }

                if (firstChunkReceived && streamingMessage) {
                    // Message was already added to UI, update it with error
                    streamingMessage.content = userFriendlyMessage;
                    streamingMessage.tokenCount = null;
                    streamingMessage.streamingTokens = null;
                    streamingMessage.streamingReasoning = false;
                    streamingMessage.streamingPending = false;
                    streamingMessage.streamingPhase = null;
                    streamingMessage.isLocalOnly = true;
                    await chatDB.saveMessage(streamingMessage);
                    // Only update UI if still viewing the same session
                    if (this.chatArea && this.isViewingSession(session.id)) {
                        await this.chatArea.finalizeStreamingMessage(streamingMessage);
                    }
                } else if (this.isViewingSession(session.id)) {
                    if (typingId) this.removeTypingIndicator(typingId);
                    // Error before first chunk - message never added to UI, add new error message
                    await this.addMessage('assistant', userFriendlyMessage, { isLocalOnly: true });
                }
                break retryLoop; // Exit after showing error
            }
            } // End of retryLoop
        } finally {
            this.clearMemoryApiOverrideContent();
            // Clear streaming state for this session
            this.setSessionStreamingState(session.id, false, null);
            // Reset auto-scroll state and hide button
            this.isAutoScrollPaused = false;
            this.updateScrollButtonVisibility();
            // Use requestAnimationFrame to ensure focus happens after UI updates
            requestAnimationFrame(() => {
                this.elements.messageInput.focus();
            });
        }
    }

    /**
     * Shows a typing indicator at the bottom of the message list.
     * @param {string} modelName - Display name of the model that's "typing"
     * @returns {string} ID of the typing indicator element
     */
    showTypingIndicator(modelName, phase = 'requesting-key') {
        const model = this.state.models.find(m => m.name === modelName || m.id === modelName);
        const specialProviderName = ['LLM Council', 'Council', 'Compare', 'Parallel'].includes(modelName)
            ? modelName
            : '';
        const providerName = specialProviderName || (model?.provider
            ? resolveProvider(model.provider).displayName
            : resolveProviderFromModelReference(modelName).displayName);
        const id = 'typing-' + Date.now();
        const timestamp = Date.now();
        const typingHtml = this.ui.buildTypingIndicator(id, providerName, modelName, timestamp, phase);
        this.elements.messagesContainer.insertAdjacentHTML('beforeend', typingHtml);
        this.updateActivePromptScrollSpacer();
        if (this.shouldAutoScrollChat()) {
            this.scrollToBottom(true);
        }
        return id;
    }

    resolvePendingPhaseForSession(session) {
        if (!session) return 'requesting-key';
        const hasAccessToken = !!inferenceService.getAccessToken(session);
        const isAccessExpired = inferenceService.isAccessExpired(session);
        return (!hasAccessToken || isAccessExpired) ? 'requesting-key' : 'waiting-response';
    }

    isQuickAskPinnedInstantModel(model, modelName = '') {
        const id = String(model?.id || '').toLowerCase();
        const name = String(modelName || model?.name || '').toLowerCase();
        const isGpt = id.includes('openai/gpt') || name.includes('gpt');
        const isInstant = name.includes('instant') || id.endsWith('-chat') || id.includes('-chat:');
        return isGpt && isInstant;
    }

    getQuickAskPinnedInstantModel(defaults = {}) {
        const pinnedModelIds = Array.isArray(defaults.pinnedModels) ? defaults.pinnedModels : [];
        for (const modelId of pinnedModelIds) {
            const model = this.state.models.find(entry => entry.id === modelId);
            if (!model) continue;
            const modelName = this.normalizeModelName(model.name || model.id) || model.name || model.id;
            const modelNameFromId = this.normalizeModelName(modelId) || modelName;
            if (this.isQuickAskPinnedInstantModel(model, modelName) ||
                this.isQuickAskPinnedInstantModel({ id: modelId, name: modelNameFromId }, modelNameFromId)) {
                return {
                    model,
                    modelName
                };
            }
        }
        return null;
    }

    async resolveModelForQuickAsk(session) {
        const defaults = getDefaultModelConfig();
        const defaultModelId = defaults.defaultModelId || inferenceService.getDefaultModelId(session);
        const instantModel = this.getQuickAskPinnedInstantModel(defaults);
        let modelNameToUse = instantModel?.modelName ||
            this.normalizeModelName(defaults.defaultModelName || defaultModelId) ||
            defaults.defaultModelName ||
            inferenceService.getDefaultModelName(session);

        let selectedModelEntry = instantModel?.model ||
            (defaultModelId
                ? this.state.models.find(m => m.id === defaultModelId)
                : null);

        if (!selectedModelEntry) {
            selectedModelEntry = modelNameToUse
                ? this.state.models.find(m => m.name === modelNameToUse)
                : null;
        }

        if (!selectedModelEntry) {
            const fallbackModel = this.getFallbackModelEntry(session);
            if (fallbackModel) {
                selectedModelEntry = fallbackModel;
                modelNameToUse = this.normalizeModelName(fallbackModel.name);
            }
        }

        if (!modelNameToUse || !selectedModelEntry) {
            throw new Error('No models are available right now. Please add a model and try again.');
        }

        const quickAskModel = {
            modelId: selectedModelEntry.id,
            modelName: modelNameToUse
        };

        if (this.isCouncilModeActive(session) && this.councilController) {
            const entries = this.councilController.resolveModelEntries(session);
            const primaryEntry = entries.find(entry => entry.laneId === 'primary') || entries[0] || null;
            if (primaryEntry?.id === selectedModelEntry.id) {
                quickAskModel.laneId = primaryEntry.laneId || 'primary';
                quickAskModel.laneEntry = primaryEntry;
                quickAskModel.laneEntries = entries;
            }
        }

        return quickAskModel;
    }

    getQuickAskAccessSession(session, quickAskModel) {
        if (quickAskModel?.laneId && this.councilController?.buildLaneSession) {
            return this.councilController.buildLaneSession(session, quickAskModel.laneId);
        }
        return session;
    }

    getBannedAccessWarning(accessSession) {
        const verifier = inferenceService.getVerificationAdapter(accessSession);
        const accessInfo = inferenceService.getAccessInfo(accessSession);
        const accessId = verifier?.getAccessId(accessInfo?.info);
        if (!verifier?.supports ||
            !accessId ||
            !hasExplicitVerifierApprovalForAccessInfo(accessInfo?.info)) {
            return null;
        }

        const stationState = verifier.getAccessState(accessId);
        const isBannedInCache = verifier.isAccessBanned(accessId);
        if (!stationState?.banned && !isBannedInCache) return null;

        const broadcastData = verifier.getLastBroadcastData();
        const bannedInfo = broadcastData?.banned_stations?.find(s => s.station_id === accessId);
        return {
            stationId: accessId,
            reason: stationState?.banReason || bannedInfo?.reason || 'Unknown',
            bannedAt: stationState?.bannedAt || bannedInfo?.banned_at
        };
    }

    async ensureQuickAskAccess(session, quickAskModel, abortController, options = {}) {
        const accessLabel = inferenceService.getAccessLabel(session);

        if (quickAskModel?.laneId && quickAskModel?.laneEntry && this.councilController) {
            const entry = quickAskModel.laneEntry;
            this.councilController.seedPrimaryLaneAccessFromSession(session, entry);
            let quickAskAccessSession = this.getQuickAskAccessSession(session, quickAskModel);
            const needsFreshAccess = this.councilController.needsFreshLaneAccess(session, entry);

            if (needsFreshAccess) {
                options.onStatus?.('requesting-key');
                try {
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage(`Acquiring ${accessLabel} for ${entry.name}...`, 'info');
                    }
                    await this.councilController.ensureAccessForEntries(
                        session,
                        [entry],
                        null,
                        abortController.signal
                    );
                    options.onStatus?.('waiting-response');
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage(`${accessLabel} ready`, 'success', 2000);
                    }
                } catch (error) {
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage(error.message, 'error', 5000);
                    }
                    throw error;
                }
                quickAskAccessSession = this.getQuickAskAccessSession(session, quickAskModel);
            } else {
                options.onStatus?.('waiting-response');
            }

            if (abortController.signal.aborted) {
                const error = new Error('Quick ask cancelled.');
                error.isCancelled = true;
                throw error;
            }

            return quickAskAccessSession;
        }

        const accessSession = this.getQuickAskAccessSession(session, quickAskModel);
        const bannedAccess = this.getBannedAccessWarning(accessSession);
        if (bannedAccess) {
            this.showBannedStationWarningModal({
                ...bannedAccess,
                sessionId: session.id
            });
            throw new Error('The current station is banned.');
        }

        const hasAccessToken = !!inferenceService.getAccessToken(accessSession);
        const isAccessExpired = inferenceService.isAccessExpired(accessSession);
        if (!hasAccessToken || isAccessExpired) {
            options.onStatus?.('requesting-key');
            try {
                if (this.floatingPanel) {
                    this.floatingPanel.showMessage(`Acquiring ${accessLabel}...`, 'info');
                }
                await this.acquireAndSetAccess(session, {
                    modelIdOverride: quickAskModel.modelId,
                    modelNameOverride: quickAskModel.modelName,
                    signal: abortController.signal,
                    onGranted: () => {
                        options.onStatus?.('waiting-response');
                    }
                });
                if (this.floatingPanel) {
                    this.floatingPanel.showMessage(`${accessLabel} ready`, 'success', 2000);
                }
            } catch (error) {
                if (this.floatingPanel) {
                    this.floatingPanel.showMessage(error.message, 'error', 5000);
                }
                throw error;
            }
        } else {
            options.onStatus?.('waiting-response');
        }

        if (abortController.signal.aborted) {
            const error = new Error('Quick ask cancelled.');
            error.isCancelled = true;
            throw error;
        }

        return accessSession;
    }

    getQuickAskConversationMessages(filteredMessages, quickAskModel) {
        if (quickAskModel?.laneEntry && this.councilController?.buildLaneConversationMessages) {
            return this.councilController.buildLaneConversationMessages(
                filteredMessages,
                quickAskModel.laneEntry,
                quickAskModel.laneEntries || []
            );
        }
        return filteredMessages;
    }

    async inlineQuickAsk(selectionText, options = {}) {
        const selectedText = normalizeQuickAskSelection(selectionText);
        const question = buildQuickAskQuestion(selectedText);
        if (!question) {
            throw new Error('Select text in a model response to ask about it.');
        }

        const session = this.getCurrentSession();
        if (!session) {
            throw new Error('Start a chat before using inline quick ask.');
        }

        if (this.getSessionStreamingState(session.id).isStreaming) {
            throw new Error('Quick ask is unavailable while this chat is streaming.');
        }

        const abortController = options.abortController || new AbortController();
        if (abortController.signal.aborted) {
            const error = new Error('Quick ask cancelled.');
            error.isCancelled = true;
            throw error;
        }

        const quickAskModel = await this.resolveModelForQuickAsk(session);
        const { modelId, modelName } = quickAskModel;
        let quickAskAccessSession = await this.ensureQuickAskAccess(session, quickAskModel, abortController, options);
        if (this.getSessionStreamingState(session.id).isStreaming) {
            throw new Error('Quick ask is unavailable while this chat is streaming.');
        }

        if (window.networkLogger) {
            window.networkLogger.setCurrentSession(session.id);
        }

        const messages = await chatDB.getSessionMessages(session.id);
        const filteredMessages = messages.filter(msg => !msg.isLocalOnly);
        const conversationMessages = this.getQuickAskConversationMessages(filteredMessages, quickAskModel);
        const sanitizedMessages = this.sanitizeMessagesForApi(conversationMessages);
        const processedMessages = this.processMessagesWithFiles(sanitizedMessages, modelId);
        const quickAskMessages = buildQuickAskMessages(processedMessages, selectedText);
        if (this.getSessionStreamingState(session.id).isStreaming) {
            throw new Error('Quick ask is unavailable while this chat is streaming.');
        }
        if (abortController.signal.aborted) {
            const error = new Error('Quick ask cancelled.');
            error.isCancelled = true;
            throw error;
        }

        let content = '';
        let reasoning = '';
        let streamingTokenCount = 0;
        let firstChunkReceived = false;
        const streamQuickAsk = () => inferenceService.streamCompletion(
            quickAskMessages,
            modelId,
            quickAskAccessSession,
            async (chunk) => {
                if (!firstChunkReceived) {
                    firstChunkReceived = true;
                    options.onStatus?.('streaming');
                }
                if (!chunk) return;
                content += chunk;
                options.onChunk?.(content, chunk);
            },
            (tokenUpdate) => {
                streamingTokenCount = tokenUpdate.completionTokens || streamingTokenCount;
                options.onTokenUpdate?.(streamingTokenCount);
            },
            [],
            this.searchEnabled,
            abortController,
            () => {
                options.onStatus?.('stream-open');
            },
            async (reasoningChunk) => {
                if (!firstChunkReceived) {
                    firstChunkReceived = true;
                    options.onStatus?.('streaming');
                }
                reasoning += reasoningChunk || '';
                options.onReasoningChunk?.(reasoning, reasoningChunk);
            },
            this.reasoningEnabled,
            this.reasoningEffort
        );

        let tokenData;
        try {
            tokenData = await streamQuickAsk();
        } catch (error) {
            if (
                quickAskModel.laneId &&
                quickAskModel.laneEntry &&
                !firstChunkReceived &&
                this.isAccessCreditExhaustedError(error)
            ) {
                this.councilController.clearLaneAccess(session, quickAskModel.laneId);
                await chatDB.saveSession(session);
                options.onStatus?.('requesting-key');
                await this.councilController.requestLaneAccess(
                    session,
                    quickAskModel.laneEntry,
                    null,
                    abortController.signal
                );
                quickAskAccessSession = this.getQuickAskAccessSession(session, quickAskModel);
                if (abortController.signal.aborted) {
                    const cancelled = new Error('Quick ask cancelled.');
                    cancelled.isCancelled = true;
                    throw cancelled;
                }
                options.onStatus?.('waiting-response');
                tokenData = await streamQuickAsk();
            } else {
                throw error;
            }
        }

        const rawReasoning = tokenData.reasoning || reasoning || null;
        const result = {
            question,
            selectedText,
            content,
            reasoning: rawReasoning ? parseReasoningContent(rawReasoning) : null,
            tokenCount: tokenData.totalTokens || tokenData.completionTokens || streamingTokenCount || null,
            model: this.normalizeModelName(
                inferenceService.getDisplayName(tokenData.model || modelId, modelName, session)
            ) || modelName,
            citations: tokenData.citations || null
        };
        options.onDone?.(result);
        return result;
    }

    updateTypingIndicator(id, phase) {
        const indicator = document.getElementById(id);
        if (!indicator) return;
        const normalizedPhase = this.normalizePendingPhase(phase);
        if (indicator.dataset.phase === normalizedPhase) return;

        indicator.dataset.phase = normalizedPhase;
        const label = indicator.querySelector('.pending-response-label');
        if (label) {
            label.textContent = normalizedPhase === 'waiting-response'
                ? 'Waiting for response'
                : 'Requesting ephemeral key';
            label.classList.add('pending-response-streaming');
        }
    }

    /**
     * Removes a typing indicator from the DOM.
     * @param {string} id - ID of the typing indicator element
     */
    removeTypingIndicator(id) {
        const indicator = document.getElementById(id);
        if (indicator) {
            indicator.remove();
        }
    }

    /**
     * Deletes a session and its messages.
     * @param {string} sessionId - ID of the session to delete
     */
    async deleteSession(sessionId) {
        const index = this.state.sessions.findIndex(s => s.id === sessionId);
        if (index > -1) {
            const deletedCurrentSession = this.state.currentSessionId === sessionId;
            this.state.sessions.splice(index, 1);
            this.state.sessionsById.delete(sessionId);

            // Delete from DB
            await chatDB.deleteSession(sessionId);
            await chatDB.deleteSessionMessages(sessionId);
            this.sessionScrollPositions.delete(sessionId);
            this.sessionPromptScrollAnchors.delete(sessionId);
            if (this.activePromptScroll?.sessionId === sessionId) {
                this.detachPromptSlideUpEffect();
            }
            this.clearChatbarStateForSession(sessionId);

            // Clear edit state if deleting current session
            if (deletedCurrentSession) {
                this.editingMessageId = null;
                this.editDrafts.clear();
            }

            // Switch to another session if we deleted the current one
            if (deletedCurrentSession) {
                this.state.currentSessionId = this.state.sessions.length > 0 ? this.state.sessions[0].id : null;
                await chatDB.saveSetting('currentSessionId', this.state.currentSessionId);
            }

            this.renderSessions();
            this.renderMessages();
            this.renderCurrentModel();
            if (deletedCurrentSession) {
                this.resetMessageInputLayout({ resetScroll: true });
                this.restoreChatbarStateForSession(this.state.currentSessionId);
            }

            // Create new session if none exist
            if (this.state.sessions.length === 0) {
                await this.createSession();
            }
        }
    }

    /**
     * Returns template options for rendering a specific message
     * @param {string} messageId - Message ID
     * @returns {Object} Template options
     */
    getMessageTemplateOptions(messageId) {
        const editDraft = this.editDrafts.get(messageId) || null;
        const session = this.getCurrentSession();
        const editParallelEnabled = this.isCouncilModeActive(session);
        const editPrimaryModelName = this.chatInput?.getPrimaryModelName?.()
            || this.normalizeModelName(session?.model)
            || session?.model
            || this.getDefaultModelName();
        const editSecondaryModelName = editParallelEnabled
            ? (this.chatInput?.getSelectedCouncilSecondaryModelName?.(editPrimaryModelName) || '')
            : '';
        return {
            isEditing: this.editingMessageId === messageId,
            editContent: editDraft?.content,
            editFiles: editDraft?.files,
            editParallelEnabled,
            editPrimaryModelName,
            editSecondaryModelName,
            memoryFeatureEnabled: this.memoryFeatureEnabled !== false
        };
    }

    cloneMessageFiles(files) {
        return Array.isArray(files)
            ? files.map(file => ({ ...file }))
            : [];
    }

    async buildMessageFileMetadata(files) {
        const { getFileType, extractDocxText } = await import('./services/fileUtils.js');
        return Promise.all(files.map(async (file) => {
            const dataUrl = await this.createImagePreview(file);
            const detectedType = await getFileType(file);
            const metadata = {
                name: file.name,
                type: file.type,
                size: file.size,
                dataUrl,
                detectedType
            };
            if (detectedType === 'docx') {
                metadata.extractedText = await extractDocxText(file);
            }
            return metadata;
        }));
    }

    updateEditDraftContent(messageId, content) {
        const draft = this.editDrafts.get(messageId);
        if (!draft) return;
        draft.content = content;
    }

    async refreshEditMessage(messageId, { focusTextarea = false } = {}) {
        const session = this.getCurrentSession();
        if (!session || !this.chatArea) return;
        const messages = await chatDB.getSessionMessages(session.id);
        const message = messages.find(m => m.id === messageId);
        if (!message) return;
        this.chatArea.updateMessage(message);
        this.chatArea.initializeEditForm?.();
        if (focusTextarea) {
            requestAnimationFrame(() => {
                const textarea = document.querySelector(`.edit-prompt-textarea[data-message-id="${messageId}"]`);
                textarea?.focus();
            });
        }
    }

    async handleEditFileUpload(messageId, files) {
        const draft = this.editDrafts.get(messageId);
        if (!draft || !files?.length) return;

        const { validateFile } = await import('./services/fileUtils.js');
        const validFiles = [];
        const errors = [];

        for (const file of files) {
            const validation = await validateFile(file);
            if (validation.valid) {
                validFiles.push(file);
            } else {
                errors.push(validation.error);
            }
        }

        if (validFiles.length > 0) {
            const fileMetadata = await this.buildMessageFileMetadata(validFiles);
            draft.files.push(...fileMetadata);
            await this.refreshEditMessage(messageId, { focusTextarea: true });
        }

        if (errors.length > 0) {
            this.showErrorNotification(errors.join('\n\n'));
        }
    }

    async removeEditAttachment(messageId, index) {
        const draft = this.editDrafts.get(messageId);
        if (!draft || index < 0 || index >= draft.files.length) return;
        draft.files.splice(index, 1);
        await this.refreshEditMessage(messageId, { focusTextarea: true });
    }

    /**
     * Normalizes a message into a static snapshot for forked sessions.
     * Forks should capture visible content without carrying active streaming state.
     * @param {Object} message - Source message
     * @returns {Object|null} Snapshot message or null if it is only an empty pending placeholder
     */
    createForkMessageSnapshot(message) {
        if (!message) return null;

        const snapshot = { ...message };
        if (snapshot.role !== 'assistant') {
            return snapshot;
        }

        const hasText = typeof snapshot.content === 'string' && snapshot.content.trim().length > 0;
        const hasReasoning = typeof snapshot.reasoning === 'string' && snapshot.reasoning.trim().length > 0;
        const hasImages = Array.isArray(snapshot.images) && snapshot.images.length > 0;

        // Ignore empty pending placeholders; they have no user-visible content yet.
        if (snapshot.streamingPending && !hasText && !hasReasoning && !hasImages) {
            return null;
        }

        if (snapshot.streamingReasoning && hasReasoning) {
            snapshot.reasoning = parseReasoningContent(snapshot.reasoning);
        }

        snapshot.streamingPending = false;
        snapshot.streamingPhase = null;
        snapshot.streamingReasoning = false;
        snapshot.streamingTokens = null;

        return snapshot;
    }

    findCouncilStageEntryByLane(message, laneId) {
        const stageEntries = Array.isArray(message?.council?.stage1)
            ? message.council.stage1
            : [];
        if (!laneId || stageEntries.length === 0) return null;
        return stageEntries.find((entry) => entry?.laneId === laneId)
            || stageEntries.find((entry) => entry?.label === laneId)
            || null;
    }

    /**
     * Enters edit mode for a user message
     * @param {string} messageId - Message ID to edit
     */
    async enterEditMode(messageId) {
        const session = this.getCurrentSession();
        if (!session) return;

        const messages = await chatDB.getSessionMessages(session.id);
        const message = messages.find(m => m.id === messageId);

        if (!message || message.role !== 'user') {
            return;
        }

        this.editDrafts.clear();
        this.editDrafts.set(messageId, {
            content: message.content || '',
            files: this.cloneMessageFiles(message.files)
        });
        this.editingMessageId = messageId;
        await this.chatArea.render();

        // Focus the textarea
        requestAnimationFrame(() => {
            const textarea = document.querySelector(`.edit-prompt-textarea[data-message-id="${messageId}"]`);
            if (textarea) {
                textarea.focus();
                // Place cursor at end
                textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            }
        });
    }

    /**
     * Cancels edit mode
     * @param {string} messageId - Message ID being edited
     */
    cancelEditMode(messageId) {
        if (this.editingMessageId === messageId) {
            this.editingMessageId = null;
            this.editDrafts.delete(messageId);
            this.chatArea.render();
        }
    }

    /**
     * Confirms and applies the edited prompt
     * @param {string} messageId - Message ID being edited
     */
    async confirmEditPrompt(messageId) {
        const session = this.getCurrentSession();
        if (!session) return;

        const textarea = document.querySelector(`.edit-prompt-textarea[data-message-id="${messageId}"]`);
        if (!textarea) return;

        const newContent = textarea.value.trim();
        const draft = this.editDrafts.get(messageId);
        const draftFiles = this.cloneMessageFiles(draft?.files);
        if (!newContent && draftFiles.length === 0) return;

        if (this.isCurrentSessionStreaming()) {
            const stopped = await this.stopCurrentSessionStreamingAndWait();
            if (!stopped) return;
        }

        if (session.importedFrom) {
            await this.markImportedSessionAsForked(session);
            this.updateUrlWithSession(session.id);
        }

        const messages = await chatDB.getSessionMessages(session.id);
        const messageIndex = messages.findIndex(m => m.id === messageId);

        if (messageIndex === -1) return;

        const message = messages[messageIndex];

        // Update the message content and attachment set as one committed edit.
        message.content = newContent;
        message.files = draftFiles.length > 0 ? draftFiles : null;
        message.timestamp = Date.now();
        await chatDB.saveMessage(message);

        // Delete all messages after this one (truncate conversation)
        const messagesToDelete = messages.slice(messageIndex + 1);
        for (const msg of messagesToDelete) {
            await chatDB.deleteMessage(msg.id);
        }

        // Update session timestamp
        session.updatedAt = Date.now();

        // Update session title if this was the first message
        if (messageIndex === 0) {
            const title = this.buildLocalSessionTitle(newContent);
            session.title = title;
            session.titleSource = 'local';
            session.titleGenerationPending = Boolean(this.getMessageTextContent(newContent).trim());
            session.titleSearchText = this.buildSessionTitleSearchText(newContent);
            delete session.titleGeneratedAt;
        }

        const remainingMessages = messages.slice(0, messageIndex + 1);
        remainingMessages[messageIndex] = message;
        this.applySessionConversationSearchText(session, remainingMessages);
        await this.recomputeSessionCouncilTranscriptHint(session, remainingMessages, { persist: false });
        await chatDB.saveSession(session);

        // Clear edit mode
        this.editingMessageId = null;
        this.editDrafts.delete(messageId);

        // Log the edit action
        if (window.networkLogger) {
            window.networkLogger.logRequest({
                type: 'local',
                method: 'LOCAL',
                status: 200,
                sessionId: session.id,
                action: 'prompt-edit',
                message: 'Edited prompt and truncated conversation',
                response: {
                    messageIndex: messageIndex,
                    messagesDeleted: messagesToDelete.length
                }
            });
        }

        // Optimally update DOM instead of full re-render
        if (this.chatArea) {
            this.chatArea.updateMessage(message);
            this.chatArea.removeMessagesAfter(message.id);
        } else {
            await this.chatArea.render();
        }

        this.renderSessions();

        // Trigger regeneration
        await this.regenerateResponse();
    }

    /**
     * Forks the conversation from a specific message
     * @param {string} messageId - Message ID to fork from
     */
    async forkConversation(messageId) {
        const session = this.getCurrentSession();
        if (!session) return;

        const messages = await chatDB.getSessionMessages(session.id);
        const messageIndex = messages.findIndex(m => m.id === messageId);

        if (messageIndex === -1) return;

        // Copy messages up to and including the fork point
        const messagesToCopy = messages
            .slice(0, messageIndex + 1)
            .map(message => this.createForkMessageSnapshot(message))
            .filter(Boolean);

        // Create new session with same model and access context
        const newSessionId = this.generateId();
        const firstUserMessage = messagesToCopy.find(m => m.role === 'user');
        const titleFields = this.buildForkSessionTitleFields(session, firstUserMessage?.content);

        const newSession = {
            id: newSessionId,
            title: titleFields.title,
            titleSource: titleFields.titleSource,
            titleGenerationPending: false,
            titleSearchText: titleFields.titleSearchText,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            model: session.model,
            inferenceBackend: session.inferenceBackend || inferenceService.getDefaultBackendId(),
            apiKey: null,
            apiKeyInfo: null,
            expiresAt: null,
            searchEnabled: this.searchEnabled,
            hasCouncilLayoutPreference: session.hasCouncilLayoutPreference === true
                || this.messagesUseCouncilLayout(messagesToCopy),
            hasCouncilTranscript: this.messagesUseCouncilLayout(messagesToCopy),
            forkedFrom: session.id
        };
        this.applySessionConversationSearchText(newSession, messagesToCopy);

        const accessInfo = inferenceService.getAccessInfo(session);
        if (accessInfo?.token) {
            newSession.apiKey = accessInfo.token;
            newSession.apiKeyInfo = accessInfo.info;
            newSession.expiresAt = accessInfo.expiresAt;
        }

        // Save new session
        await chatDB.saveSession(newSession);
        this.state.sessions.unshift(newSession);
        this.state.sessionsById.set(newSession.id, newSession);

        // Copy messages to new session
        const baseTime = Date.now();
        for (let i = 0; i < messagesToCopy.length; i++) {
            const msg = messagesToCopy[i];
            const newMessage = {
                ...msg,
                id: this.generateId(),
                sessionId: newSessionId,
                timestamp: baseTime + i // Ensure strictly increasing timestamps to preserve order
            };
            await chatDB.saveMessage(newMessage);
        }

        // Insert divider message
        const dividerMessage = {
            id: this.generateId(),
            sessionId: newSessionId,
            role: 'system',
            type: 'divider',
            content: 'Branched from past session',
            forkedFromSessionId: session.id,
            timestamp: baseTime + messagesToCopy.length
        };
        await chatDB.saveMessage(dividerMessage);

        // Log the fork action
        if (window.networkLogger) {
            window.networkLogger.logRequest({
                type: 'local',
                method: 'LOCAL',
                status: 200,
                sessionId: newSessionId,
                action: 'session-fork',
                message: 'Forked chat to new session',
                response: {
                    sourceSessionId: session.id,
                    messagesCopied: messagesToCopy.length,
                    sharedAccess: !!accessInfo?.token,
                    sourceWasStreaming: this.getSessionStreamingState(session.id).isStreaming
                }
            });
        }

        // Switch to new session
        if (this.state.currentSessionId) {
            this.saveChatbarStateForSession(this.state.currentSessionId);
        }
        this.state.currentSessionId = newSessionId;
        await chatDB.saveSetting('currentSessionId', newSessionId);

        // Clear edit state
        this.editingMessageId = null;
        this.editDrafts.clear();

        this.renderSessions();
        // Scroll sidebar to top to show the new session
        if (this.sidebar) {
            this.sidebar.scrollToTop();
        }
        this.renderMessages();
        this.renderCurrentModel();
        this.resetMessageInputLayout({ resetScroll: true });
        this.restoreChatbarStateForSession(newSessionId);

        // Notify right panel of session change
        if (this.rightPanel) {
            this.rightPanel.onSessionChange(newSession);
        }

        // Close sidebar on mobile
        if (this.isMobileView()) {
            this.hideSidebar();
        }
    }

    async deleteAllChats() {
        // Stop any in-flight streaming to prevent inconsistent state
        this.sessionStreamingStates.forEach((state) => {
            if (state?.abortController) {
                state.abortController.abort();
            }
        });
        this.sessionStreamingStates.clear();
        this.sessionScrollPositions.clear();
        this.sessionPromptScrollAnchors.clear();
        this.detachPromptSlideUpEffect();
        this.clearAllChatbarStates();
        this.editingMessageId = null;
        this.editDrafts.clear();

        this.state.sessions = [];
        this.state.sessionsById = new Map();
        this.state.currentSessionId = null;

        if (typeof chatDB.clearAllChats === 'function') {
            await chatDB.clearAllChats();
        } else {
            await this.clearAllChatsIncompatFallback();
        }
        await chatDB.saveSetting('currentSessionId', null);

        // Render empty state while the new session is created
        this.renderSessions();
        this.renderMessages();
        this.applyChatbarState(null);

        await this.createSession();
    }

    async clearAllChatsIncompatFallback() {
        const sessions = await chatDB.getAllSessions();

        for (const session of sessions) {
            await chatDB.deleteSession(session.id);
            await chatDB.deleteSessionMessages(session.id);
        }
    }

    renderDeleteHistoryModalContent() {
        const modal = this.elements.deleteHistoryModal;
        const template = document.getElementById('delete-history-modal-template');
        if (!modal || !template) {
            return;
        }

        modal.innerHTML = '';
        modal.appendChild(template.content.cloneNode(true));

        const htmlEnabledKeys = new Set(['body', 'highlightBody']);

        modal.querySelectorAll('[data-delete-history]').forEach(el => {
            const key = el.dataset.deleteHistory;
            if (key && Object.prototype.hasOwnProperty.call(DELETE_HISTORY_COPY, key)) {
                if (htmlEnabledKeys.has(key)) {
                    el.innerHTML = DELETE_HISTORY_COPY[key];
                } else {
                    el.textContent = DELETE_HISTORY_COPY[key];
                }
            }
        });

        this.elements.deleteHistoryCancelBtn = document.getElementById('cancel-delete-history');
        this.elements.deleteHistoryConfirmBtn = document.getElementById('confirm-delete-history');
        if (this.elements.deleteHistoryConfirmBtn) {
            this.elements.deleteHistoryConfirmBtn.dataset.originalText = DELETE_HISTORY_COPY.confirmLabel;
        }

        this.attachDownloadLinkHandler(modal);
    }

    openDeleteHistoryModal() {
        const modal = this.elements.deleteHistoryModal;
        if (!modal) return;

        this.deleteHistoryReturnFocusEl = document.activeElement;
        modal.classList.remove('hidden');

        requestAnimationFrame(() => {
            this.elements.deleteHistoryConfirmBtn?.focus();
        });
    }

    closeDeleteHistoryModal() {
        const modal = this.elements.deleteHistoryModal;
        if (!modal) return;

        modal.classList.add('hidden');

        if (this.deleteHistoryReturnFocusEl && typeof this.deleteHistoryReturnFocusEl.focus === 'function') {
            this.deleteHistoryReturnFocusEl.focus();
        }
        this.deleteHistoryReturnFocusEl = null;
    }

    isDeleteHistoryModalOpen() {
        const modal = this.elements.deleteHistoryModal;
        if (!modal) return false;
        return !modal.classList.contains('hidden');
    }

    async handleConfirmDeleteHistory() {
        if (this.isDeletingAllChats) return;
        this.isDeletingAllChats = true;

        const confirmBtn = this.elements.deleteHistoryConfirmBtn;
        const defaultLabel = confirmBtn?.dataset.originalText || confirmBtn?.textContent?.trim() || 'Delete everything';

        if (confirmBtn) {
            confirmBtn.dataset.originalText = defaultLabel;
            confirmBtn.textContent = 'Deleting...';
            confirmBtn.disabled = true;
        }

        try {
            await this.deleteAllChats();
            this.closeDeleteHistoryModal();
        } catch (error) {
            console.error('Failed to delete chat history:', error);
            window.alert('Unable to delete chat history. Please try again.');
        } finally {
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.textContent = defaultLabel;
            }
            this.isDeletingAllChats = false;
        }
    }

    setupDeleteHistoryControls() {
        const {
            deleteHistoryBtn,
            deleteHistoryCancelBtn,
            deleteHistoryConfirmBtn,
            deleteHistoryModal
        } = this.elements;

        if (!deleteHistoryBtn || !deleteHistoryCancelBtn || !deleteHistoryConfirmBtn || !deleteHistoryModal) {
            return;
        }

        deleteHistoryBtn.addEventListener('click', () => {
            this.openDeleteHistoryModal();
        });

        deleteHistoryCancelBtn.addEventListener('click', () => {
            this.closeDeleteHistoryModal();
        });

        if (!deleteHistoryConfirmBtn.dataset.originalText) {
            deleteHistoryConfirmBtn.dataset.originalText = deleteHistoryConfirmBtn.textContent.trim();
        }
        deleteHistoryConfirmBtn.addEventListener('click', () => {
            this.handleConfirmDeleteHistory();
        });

        deleteHistoryModal.addEventListener('click', (event) => {
            if (event.target === deleteHistoryModal) {
                this.closeDeleteHistoryModal();
            }
        });
    }

    /**
     * Escapes HTML special characters in text.
     * @param {string} text - The text to escape
     * @returns {string} HTML-safe text
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    sanitizePersistedSessionAccess(session) {
        if (!inferenceService.sanitizePersistedAccess(session)) return;
        chatDB.saveSession(session).catch(error => {
            console.warn(
                'Failed to persist removal of an unverified session key:',
                error
            );
        });
    }

    cacheSessions(sessions) {
        if (!Array.isArray(sessions)) return;
        sessions.forEach(session => {
            if (session && session.id) {
                this.sanitizePersistedSessionAccess(session);
                this.normalizeSessionCouncilState(session);
                this.state.sessionsById.set(session.id, session);
            }
        });
    }

    insertSessionIntoList(session) {
        if (!session || !session.id) return;
        if (this.state.sessionsById.has(session.id)) return;
        this.sanitizePersistedSessionAccess(session);

        this.normalizeSessionCouncilState(session);

        const updatedAt = session.updatedAt || session.createdAt || 0;
        let insertIndex = this.state.sessions.length;
        for (let i = 0; i < this.state.sessions.length; i += 1) {
            const compareSession = this.state.sessions[i];
            const compareUpdatedAt = compareSession.updatedAt || compareSession.createdAt || 0;
            if (updatedAt > compareUpdatedAt) {
                insertIndex = i;
                break;
            }
        }

        this.state.sessions.splice(insertIndex, 0, session);
        this.state.sessionsById.set(session.id, session);
    }

    async loadInitialSessions() {
        this.state.isLoadingSessions = true;
        try {
            if (typeof chatDB.getSessionsPage === 'function') {
                const { sessions, nextCursor } = await chatDB.getSessionsPage(SESSION_PAGE_SIZE);
                this.state.sessions = sessions;
                this.state.sessionsById = new Map();
                this.cacheSessions(sessions);
                this.state.sessionsPageCursor = nextCursor;
                this.state.hasMoreSessions = Boolean(nextCursor);
                return;
            }

            const fallbackSessions = await chatDB.getAllSessions();
            fallbackSessions.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
            const page = fallbackSessions.slice(0, SESSION_PAGE_SIZE);
            this.state.sessions = page;
            this.state.sessionsById = new Map();
            this.cacheSessions(page);
            this.state.sessionsPageCursor = null;
            this.state.hasMoreSessions = fallbackSessions.length > page.length;
        } finally {
            this.state.isLoadingSessions = false;
        }
    }

    async loadMoreSessions() {
        if (this.state.isLoadingSessions || !this.state.hasMoreSessions) return;
        if (this.hasActiveSessionListCriteria()) return;

        this.state.isLoadingSessions = true;
        try {
            const { sessions, nextCursor } = await chatDB.getSessionsPage(
                SESSION_PAGE_SIZE,
                this.state.sessionsPageCursor
            );
            const newSessions = sessions.filter(session => !this.state.sessionsById.has(session.id));
            this.migrateSessionsInBackground(newSessions);
            this.cacheSessions(newSessions);
            this.state.sessions.push(...newSessions);
            this.state.sessionsPageCursor = nextCursor;
            this.state.hasMoreSessions = Boolean(nextCursor);
        } finally {
            this.state.isLoadingSessions = false;
        }
        this.renderSessions();
    }

    async ensureSessionLoaded(sessionId) {
        if (!sessionId || this.state.sessionsById.has(sessionId)) return;
        const session = await chatDB.getSession(sessionId);
        if (session) {
            this.migrateSessionsInBackground([session]);
            this.insertSessionIntoList(session);
        }
    }

    async reloadSessions() {
        this.state.sessions = [];
        this.state.sessionsById = new Map();
        this.state.sessionsPageCursor = null;
        this.state.hasMoreSessions = true;
        this.state.sessionSearchResults = null;
        this.state.sessionSearchResultsQuery = '';
        this.state.sessionSearchResultsKey = '';
        this.state.sessionSearchPending = false;
        await this.loadInitialSessions();
        await this.ensureSessionLoaded(this.state.currentSessionId);
        if (this.hasActiveSessionListCriteria()) {
            await this.updateSessionSearchResults();
        } else {
            this.renderSessions();
        }
    }

    handleStorageEvent(type, payload) {
        if (this.isCurrentSessionStreaming()) {
            this.pendingStorageRefresh = true;
            return;
        }

        if (type === 'sessions-updated' || type === 'sessions-cleared') {
            this.scheduleStorageReload();
        }

        if (type === 'messages-updated') {
            const sessionId = payload?.sessionId;
            if (!sessionId || sessionId === this.state.currentSessionId) {
                void this.renderMessages();
            }
        }
    }

    scheduleStorageReload() {
        if (this.storageReloadTimer) return;
        this.storageReloadTimer = setTimeout(async () => {
            this.storageReloadTimer = null;
            await this.reloadSessions();
        }, 400);
    }

    flushPendingStorageRefresh() {
        if (!this.pendingStorageRefresh) return;
        this.pendingStorageRefresh = false;
        this.scheduleStorageReload();
        void this.renderMessages();
    }

    mergeSessionLists(primary, secondary) {
        const merged = [];
        const seen = new Set();
        [primary, secondary].forEach(list => {
            if (!Array.isArray(list)) return;
            list.forEach(session => {
                if (!session || seen.has(session.id)) return;
                seen.add(session.id);
                merged.push(session);
            });
        });
        merged.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
        return merged;
    }

    getNormalizedSessionSearchQuery() {
        return this.sessionSearchQuery.trim().toLowerCase();
    }

    hasActiveSessionFilters() {
        return Boolean(
            this.sessionFilters.starredOnly ||
            this.sessionFilters.dateMode !== 'all' ||
            this.sessionFilters.customDate
        );
    }

    hasActiveSessionListCriteria() {
        return Boolean(this.getNormalizedSessionSearchQuery() || this.hasActiveSessionFilters());
    }

    getSessionResultsKey() {
        return JSON.stringify({
            query: this.getNormalizedSessionSearchQuery(),
            starredOnly: this.sessionFilters.starredOnly,
            dateMode: this.sessionFilters.dateMode,
            customDate: this.sessionFilters.customDate || ''
        });
    }

    getSessionTimestamp(session) {
        return Number(session?.updatedAt || session?.createdAt || 0);
    }

    getLocalDateKey(timestamp) {
        const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    getStartOfLocalDay(date = new Date()) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    }

    sessionMatchesDateFilter(session) {
        const timestamp = this.getSessionTimestamp(session);
        if (!timestamp) return false;

        const mode = this.sessionFilters.dateMode;
        if (this.sessionFilters.customDate) {
            return this.getLocalDateKey(timestamp) === this.sessionFilters.customDate;
        }
        if (mode === 'all') return true;

        const todayStart = this.getStartOfLocalDay();
        const sessionDayStart = this.getStartOfLocalDay(new Date(timestamp));
        const dayMs = 24 * 60 * 60 * 1000;

        if (mode === 'today') {
            return sessionDayStart === todayStart;
        }
        if (mode === 'yesterday') {
            return sessionDayStart === todayStart - dayMs;
        }
        if (mode === '7d') {
            return sessionDayStart >= todayStart - (6 * dayMs);
        }
        if (mode === '30d') {
            return sessionDayStart >= todayStart - (29 * dayMs);
        }
        return true;
    }

    sessionMatchesSidebarFilters(session) {
        if (!session) return false;
        if (this.sessionFilters.starredOnly && !session.starred) return false;
        return this.sessionMatchesDateFilter(session);
    }

    getSessionListEmptyText() {
        if (!this.hasActiveSessionListCriteria()) {
            return 'No chats yet';
        }
        if (this.sessionFilters.starredOnly && !this.getNormalizedSessionSearchQuery() &&
            this.sessionFilters.dateMode === 'all' && !this.sessionFilters.customDate) {
            return 'No starred chats';
        }
        return 'No matching chats';
    }

    resetSessionSearchResults() {
        this.state.sessionSearchResults = null;
        this.state.sessionSearchResultsQuery = '';
        this.state.sessionSearchResultsKey = '';
        this.state.sessionSearchPending = false;
    }

    async toggleSessionStar(sessionId) {
        if (!sessionId) return;
        await this.ensureSessionLoaded(sessionId);
        const session = this.state.sessionsById.get(sessionId) || this.state.sessions.find(s => s.id === sessionId);
        if (!session) return;

        const nextStarred = !session.starred;
        session.starred = nextStarred;
        if (nextStarred) {
            session.starredAt = Date.now();
        } else {
            delete session.starredAt;
        }

        await chatDB.saveSession(session);
        this.resetSessionSearchResults();
        this.renderSessions();
        if (this.hasActiveSessionListCriteria()) {
            void this.updateSessionSearchResults();
        }
    }

    isValidSessionDateInput(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
        const date = new Date(`${value}T00:00:00`);
        return !Number.isNaN(date.getTime()) && this.getLocalDateKey(date.getTime()) === value;
    }

    applySessionFilterChange(nextFilters = {}) {
        const current = this.sessionFilters;
        this.sessionFilters = {
            starredOnly: Boolean(nextFilters.starredOnly ?? current.starredOnly),
            dateMode: nextFilters.dateMode ?? current.dateMode,
            customDate: nextFilters.customDate ?? current.customDate
        };

        if (this.sessionFilters.dateMode !== 'custom' && nextFilters.customDate === undefined) {
            this.sessionFilters.customDate = '';
        }
        if (this.sessionFilters.customDate) {
            this.sessionFilters.dateMode = 'custom';
        }

        this.resetSessionSearchResults();
        this.renderSessions();
        this.updateSidebarFilterUI();
        if (this.sidebar) {
            this.sidebar.scrollToTop();
        }
        void this.updateSessionSearchResults();
    }

    clearSidebarFilters() {
        this.applySessionFilterChange({
            starredOnly: false,
            dateMode: 'all',
            customDate: ''
        });
    }

    updateSidebarFilterUI() {
        const btn = this.elements.sidebarFilterBtn;
        const menu = this.elements.sidebarFilterMenu;
        const rangeSelect = this.elements.sidebarFilterRangeSelect;
        const dateInput = this.elements.sidebarFilterDateInput;
        const filtersActive = this.hasActiveSessionFilters();

        if (btn) {
            btn.dataset.active = filtersActive ? 'true' : 'false';
            btn.setAttribute('aria-expanded', menu && !menu.classList.contains('hidden') ? 'true' : 'false');
        }
        if (!menu) return;

        const starToggle = menu.querySelector('[data-session-star-filter-toggle]');
        if (starToggle) {
            starToggle.classList.toggle('active', this.sessionFilters.starredOnly);
            starToggle.setAttribute('aria-pressed', this.sessionFilters.starredOnly ? 'true' : 'false');
        }
        if (rangeSelect && rangeSelect.value !== this.sessionFilters.dateMode) {
            rangeSelect.value = this.sessionFilters.customDate ? 'all' : this.sessionFilters.dateMode;
        }
        if (dateInput && dateInput.value !== this.sessionFilters.customDate) {
            dateInput.value = this.sessionFilters.customDate || '';
        }
        const clearBtn = this.elements.clearSidebarFiltersBtn;
        if (clearBtn) {
            clearBtn.disabled = !filtersActive;
            clearBtn.classList.toggle('opacity-50', !filtersActive);
        }
    }

    openSidebarFilterMenu() {
        const menu = this.elements.sidebarFilterMenu;
        if (!menu) return;
        menu.classList.remove('hidden');
        this.updateSidebarFilterUI();
    }

    closeSidebarFilterMenu() {
        const menu = this.elements.sidebarFilterMenu;
        if (!menu) return;
        menu.classList.add('hidden');
        this.updateSidebarFilterUI();
    }

    toggleSidebarFilterMenu() {
        const menu = this.elements.sidebarFilterMenu;
        if (!menu) return;
        if (menu.classList.contains('hidden')) {
            this.openSidebarFilterMenu();
        } else {
            this.closeSidebarFilterMenu();
        }
    }

    async updateSessionSearchResults() {
        const rawQuery = this.sessionSearchQuery.trim();
        const hasCriteria = this.hasActiveSessionListCriteria();
        const resultsKey = this.getSessionResultsKey();
        if (!hasCriteria) {
            this.sessionSearchRequestId += 1;
            this.state.sessionSearchResults = null;
            this.state.sessionSearchResultsQuery = '';
            this.state.sessionSearchResultsKey = '';
            this.state.sessionSearchPending = false;
            this.renderSessions();
            return;
        }

        if (typeof chatDB.getAllSessions !== 'function') {
            this.sessionSearchRequestId += 1;
            this.state.sessionSearchResults = null;
            this.state.sessionSearchResultsQuery = '';
            this.state.sessionSearchResultsKey = '';
            this.state.sessionSearchPending = false;
            this.renderSessions();
            return;
        }

        const query = rawQuery.toLowerCase();
        const requestId = ++this.sessionSearchRequestId;
        this.state.sessionSearchPending = true;
        this.renderSessions();

        const results = [];
        try {
            const allSessions = await chatDB.getAllSessions();
            allSessions.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

            for (const session of allSessions) {
                if (requestId !== this.sessionSearchRequestId) {
                    return;
                }

                let sessionToMatch = session;
                const filterMatches = this.sessionMatchesSidebarFilters(sessionToMatch);
                let matches = filterMatches;
                if (filterMatches && query) {
                    matches = this.sessionMatchesSearchQuery(sessionToMatch, query);
                }
                if (filterMatches && !matches && query && typeof sessionToMatch.conversationSearchText !== 'string') {
                    try {
                        await this.refreshSessionConversationSearchText(sessionToMatch, null, { persist: true });
                        matches = this.sessionMatchesSearchQuery(sessionToMatch, query);
                    } catch (error) {
                        console.warn('Failed to index session for sidebar search:', error);
                    }
                }

                if (matches) {
                    const loadedSession = this.state.sessionsById.get(sessionToMatch.id);
                    sessionToMatch = loadedSession || sessionToMatch;
                    results.push(sessionToMatch);
                    if (query && results.length >= SESSION_SEARCH_LIMIT) {
                        break;
                    }
                }
            }
        } catch (error) {
            console.warn('Session search failed:', error);
        }

        if (requestId !== this.sessionSearchRequestId) {
            return;
        }

        this.state.sessionSearchResults = results;
        this.state.sessionSearchResultsQuery = query;
        this.state.sessionSearchResultsKey = resultsKey;
        this.state.sessionSearchPending = false;
        this.cacheSessions(results);
        this.renderSessions();
    }

    /**
     * Filters sessions based on the sidebar search query.
     * @returns {Array} Filtered sessions array
     */
    getFilteredSessions() {
        if (!this.hasActiveSessionListCriteria()) {
            return this.state.sessions;
        }

        const query = this.getNormalizedSessionSearchQuery();
        const inMemory = this.state.sessions.filter(session => {
            if (!this.sessionMatchesSidebarFilters(session)) return false;
            return !query || this.sessionMatchesSearchQuery(session, query);
        });

        if (this.state.sessionSearchResults && this.state.sessionSearchResultsKey === this.getSessionResultsKey()) {
            return this.mergeSessionLists(inMemory, this.state.sessionSearchResults);
        }

        return inMemory;
    }

    sessionMatchesSearchQuery(session, query) {
        if (!session || !query) return false;
        return this.searchFieldMatches(query, session.title) ||
            this.searchFieldMatches(query, session.titleSource !== 'manual' ? session.titleSearchText : '') ||
            this.searchFieldMatches(query, session.conversationSearchText);
    }

    normalizeSearchQueryText(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    searchFieldMatches(query, field) {
        const normalizedQuery = this.normalizeSearchQueryText(query);
        const normalizedText = this.normalizeSearchQueryText(field);
        if (!normalizedQuery || !normalizedText) return false;

        if (normalizedText.includes(normalizedQuery)) {
            return true;
        }

        const queryTerms = normalizedQuery.split(' ').filter(Boolean);
        if (queryTerms.length > 1) {
            return queryTerms.every(term => this.searchTermMatchesText(term, normalizedText));
        }

        const [term] = queryTerms;
        if (this.searchTermMatchesText(term, normalizedText)) {
            return true;
        }
        return false;
    }

    searchTermMatchesText(term, text) {
        if (!term || !text) return false;
        const words = text.match(/[a-z0-9]+/g) || [];
        return words.some(word => {
            if (word === term) return true;
            if (term.length >= 3 && word.includes(term)) return true;
            return term.length >= 2 && word.startsWith(term);
        });
    }

    /**
     * Renders the sessions list (delegated to Sidebar component).
     */
    renderSessions() {
        // Hide skeleton loader when sessions are rendered for the first time
        const skeleton = document.getElementById('sessions-skeleton');
        const sessionsList = document.getElementById('sessions-list');
        const isFirstRender = skeleton && !skeleton.classList.contains('hidden');

        if (isFirstRender) {
            skeleton.classList.add('hidden');
            // Trigger reveal animation on sessions list
            if (sessionsList) {
                sessionsList.classList.add('sessions-revealing');
            }
        }

        if (this.sidebar) {
            this.sidebar.render();
        }
    }

    /**
     * Renders the current model display (delegated to ModelPicker component).
     */
    renderCurrentModel() {
        if (this.modelPicker) {
            this.modelPicker.renderCurrentModel();
        }
        this.chatInput?.refreshMultiModelSettingsUI?.();
        this.chatArea?.updateEditModelPickerButton?.();
        this.chatInput?.updateMemoryToggleUI?.();
        this.updateCouncilLayoutMode();
    }

    updateCouncilLayoutMode(session = this.getCurrentSession(), messages = null) {
        if (typeof document === 'undefined') return;
        const isCouncilLayoutMode = this.sessionUsesCouncilLayout(session, messages);
        const isCouncilModeEnabled = session
            ? this.isCouncilModeActive(session)
            : this.pendingCouncilConfig?.enabled === true;
        const storedOutputMode = session?.councilConfig?.outputMode
            || this.pendingCouncilConfig?.outputMode
            || COUNCIL_OUTPUT_PARALLEL;
        const outputMode = isCouncilModeEnabled ? storedOutputMode : COUNCIL_OUTPUT_PARALLEL;
        document.documentElement.classList.toggle('council-layout-mode', isCouncilLayoutMode);
        document.documentElement.classList.toggle(
            'council-synthesis-layout-mode',
            isCouncilLayoutMode && outputMode === COUNCIL_OUTPUT_SYNTHESIS
        );
        this.updateWideModeButtonVisibility();
    }

    /**
     * Renders all messages for the current session (delegated to ChatArea component).
     */
    async renderMessages() {
        if (this.chatArea) {
            await this.chatArea.render();
        }
        this.updateWideModeButtonVisibility();
    }

    /**
     * Updates wide mode button visibility and position.
     * Shows only when a session is active, adjusts position based on sidebar state.
     */
    updateWideModeButtonVisibility() {
        const btn = this.elements.wideModeBtn;
        if (!btn) return;

        const hasSession = !!this.getCurrentSession();
        const sidebarHidden = this.elements.sidebar?.classList.contains('sidebar-hidden');
        const isMobile = this.isMobileView();
        const usesParallelLayout = this.sessionUsesCouncilLayout(this.getCurrentSession());

        if (hasSession && !isMobile && !usesParallelLayout) {
            btn.classList.remove('hidden');
            btn.classList.add('flex');
            // When sidebar hidden: show-sidebar-btn at left-4, wide-mode at left-14
            // When sidebar visible: wide-mode at left-4
            if (sidebarHidden) {
                btn.classList.remove('left-4');
                btn.classList.add('left-14');
            } else {
                btn.classList.remove('left-14');
                btn.classList.add('left-4');
            }
        } else {
            btn.classList.add('hidden');
            btn.classList.remove('flex');
        }
    }

    /**
     * Initializes wide mode state from persistent preferences.
     */
    async initWideMode() {
        const isWide = await preferencesStore.getPreference(PREF_KEYS.wideMode);
        this.applyWideMode(!!isWide);
    }

    /**
     * Initializes left sidebar visibility from persistent preferences.
     * Desktop restores the last explicit toggle state; mobile defaults to hidden.
     */
    async initSidebarVisibility() {
        if (this.isMobileView()) {
            this.hideSidebar({ persist: false, predictToolbar: false });
            return;
        }

        const isVisible = await preferencesStore.getPreference(PREF_KEYS.leftSidebarVisible, {
            isMobile: false
        });

        if (isVisible === false) {
            this.hideSidebar({ persist: false, predictToolbar: false });
        } else {
            this.showSidebar({ persist: false, predictToolbar: false });
        }
    }

    applyWideMode(isWide) {
        document.documentElement.classList.toggle('wide-mode', isWide);
        this.elements.wideModeBtn?.classList.toggle('wide-active', isWide);
    }

    /**
     * Toggles wide mode on/off.
     */
    toggleWideMode() {
        const isWide = !document.documentElement.classList.contains('wide-mode');
        this.applyWideMode(isWide);
        preferencesStore.savePreference(PREF_KEYS.wideMode, isWide);
        // Recalculate toolbar divider after max-width transition completes (200ms)
        setTimeout(() => this.updateToolbarDivider(), 200);
    }

    /**
     * Exports the current chat session to a PDF file.
     * Delegates to pdfExport service.
     */
    async exportChatToPdf() {
        if (!this.getCurrentSession()) return;

        try {
            const { exportToPdf } = await import('./services/pdfExport.js');
            await exportToPdf(this.elements.messagesContainer);
        } catch (error) {
            console.error('PDF export failed:', error);
        }
    }

    setSidebarHiddenAttribute(isHidden) {
        if (isHidden) {
            document.documentElement.setAttribute('data-left-sidebar-hidden', 'true');
        } else {
            document.documentElement.removeAttribute('data-left-sidebar-hidden');
        }
    }

    setSidebarClosingAttribute(isClosing) {
        if (isClosing) {
            document.documentElement.setAttribute('data-left-sidebar-closing', 'true');
        } else {
            document.documentElement.removeAttribute('data-left-sidebar-closing');
        }
    }

    getCurrentSidebarWidth() {
        const sidebar = this.elements.sidebar;
        if (!sidebar) return SIDEBAR_WIDTH;

        const inlineWidth = parseFloat(sidebar.style.width);
        if (Number.isFinite(inlineWidth) && inlineWidth > 0) {
            return inlineWidth;
        }

        const measuredWidth = sidebar.getBoundingClientRect().width;
        if (measuredWidth > 0) {
            return measuredWidth;
        }

        return SIDEBAR_WIDTH;
    }

    toggleSidebar() {
        const sidebar = this.elements.sidebar;
        if (!sidebar) return;

        const isHidden = sidebar.classList.contains('sidebar-hidden')
            || (this.isMobileView() && !sidebar.classList.contains('mobile-visible'));

        if (isHidden) {
            this.showSidebar();
        } else {
            this.hideSidebar();
        }
    }

    hideSidebar(options = {}) {
        const shouldPersist = options.persist ?? !this.isMobileView();
        const shouldPredictToolbar = options.predictToolbar !== false;
        const sidebar = this.elements.sidebar;
        const showBtn = this.elements.showSidebarBtn;
        const backdrop = this.elements.mobileSidebarBackdrop;

        clearTimeout(this.sidebarToggleButtonTimer);
        this.setSidebarClosingAttribute(true);
        if (showBtn) {
            showBtn.classList.add('hidden');
            showBtn.classList.remove('flex');
        }

        if (sidebar) {
            // Use CSS class instead of inline styles
            sidebar.classList.add('sidebar-hidden');
            sidebar.classList.remove('mobile-visible');
        }
        this.setSidebarHiddenAttribute(true);
        if (showBtn) {
            this.sidebarToggleButtonTimer = setTimeout(() => {
                this.setSidebarClosingAttribute(false);
                showBtn.classList.remove('hidden');
                showBtn.classList.add('flex');
            }, SIDEBAR_CLOSE_DURATION_MS);
        }
        if (backdrop) {
            backdrop.classList.remove('visible');
        }
        if (shouldPersist) {
            preferencesStore.savePreference(PREF_KEYS.leftSidebarVisible, false);
        }
        this.updateWideModeButtonVisibility();
        if (shouldPredictToolbar) {
            const sidebarWidth = this.getCurrentSidebarWidth();
            // Predict final width: sidebar is closing, main area will be WIDER
            // Only affects width on desktop, on mobile sidebar overlays
            // Grace period in updateToolbarDivider blocks intermediate updates during animation
            this.updateToolbarDivider(this.isMobileView() ? 0 : sidebarWidth);
        } else {
            this.updateToolbarDivider();
        }
    }

    showSidebar(options = {}) {
        const shouldPersist = options.persist ?? !this.isMobileView();
        const shouldPredictToolbar = options.predictToolbar !== false;
        const sidebar = this.elements.sidebar;
        const showBtn = this.elements.showSidebarBtn;
        const backdrop = this.elements.mobileSidebarBackdrop;

        clearTimeout(this.sidebarToggleButtonTimer);
        this.setSidebarClosingAttribute(false);

        if (sidebar) {
            // Use CSS class instead of inline styles
            sidebar.classList.remove('sidebar-hidden');
            if (this.isMobileView()) {
                sidebar.classList.add('mobile-visible');
            } else {
                sidebar.classList.remove('mobile-visible');
            }
        }
        this.setSidebarHiddenAttribute(false);
        if (showBtn) {
            showBtn.classList.add('hidden');
            showBtn.classList.remove('flex');
        }
        // Show backdrop only on mobile
        if (backdrop && this.isMobileView()) {
            backdrop.classList.add('visible');
        }
        if (shouldPersist) {
            preferencesStore.savePreference(PREF_KEYS.leftSidebarVisible, true);
        }
        this.updateWideModeButtonVisibility();
        if (shouldPredictToolbar) {
            const sidebarWidth = this.getCurrentSidebarWidth();
            // Predict final width: sidebar is opening, main area will be NARROWER
            // Only affects width on desktop, on mobile sidebar overlays
            this.updateToolbarDivider(this.isMobileView() ? 0 : -sidebarWidth);
        } else {
            this.updateToolbarDivider();
        }
    }

    isMobileView() {
        return window.innerWidth <= 768;
    }

    setupSidebarFilterControls() {
        if (this.sidebarFilterControlsAttached) return;
        this.sidebarFilterControlsAttached = true;

        if (this.elements.sidebarFilterBtn) {
            this.elements.sidebarFilterBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                this.toggleSidebarFilterMenu();
            });
        }

        if (this.elements.sidebarFilterMenu) {
            this.elements.sidebarFilterMenu.addEventListener('click', (event) => {
                event.stopPropagation();

                const starToggle = event.target.closest('[data-session-star-filter-toggle]');
                if (starToggle) {
                    this.applySessionFilterChange({
                        starredOnly: !this.sessionFilters.starredOnly
                    });
                    return;
                }

                if (event.target.closest('#clear-sidebar-filters')) {
                    this.clearSidebarFilters();
                }
            });
        }

        if (this.elements.sidebarFilterRangeSelect) {
            this.elements.sidebarFilterRangeSelect.addEventListener('click', (event) => {
                event.stopPropagation();
            });
            this.elements.sidebarFilterRangeSelect.addEventListener('change', (event) => {
                this.applySessionFilterChange({
                    dateMode: event.target.value || 'all',
                    customDate: ''
                });
            });
        }

        if (this.elements.sidebarFilterDateInput) {
            this.elements.sidebarFilterDateInput.addEventListener('click', (event) => {
                event.stopPropagation();
            });
            this.elements.sidebarFilterDateInput.addEventListener('change', (event) => {
                const value = event.target.value;
                const isValidDate = this.isValidSessionDateInput(value);
                this.applySessionFilterChange({
                    dateMode: value && isValidDate ? 'custom' : 'all',
                    customDate: isValidDate ? value : ''
                });
            });
        }

        document.addEventListener('click', (event) => {
            const menu = this.elements.sidebarFilterMenu;
            const button = this.elements.sidebarFilterBtn;
            if (!menu || menu.classList.contains('hidden')) return;
            if (menu.contains(event.target) || button?.contains(event.target)) return;
            this.closeSidebarFilterMenu();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this.closeSidebarFilterMenu();
            }
        });
        this.updateSidebarFilterUI();
    }

    /**
     * Sets up all event listeners. Delegates component-specific listeners to respective components.
     */
    setupEventListeners() {
        if (this.eventListenersAttached) {
            return;
        }
        this.eventListenersAttached = true;

        // Delegate to components for their specific listeners
        if (this.chatInput) {
            this.chatInput.setupEventListeners();
        }
        if (this.modelPicker) {
            this.modelPicker.setupEventListeners();
        }

        this.setupDeleteHistoryControls();

        // New chat button
        this.elements.newChatBtn.addEventListener('click', () => {
            this.handleNewChatRequest();
        });

        // Status dot button handler - toggles floating panel
        const statusDotBtn = document.getElementById('status-dot-btn');
        if (statusDotBtn) {
            statusDotBtn.addEventListener('click', () => {
                if (this.floatingPanel) {
                    this.floatingPanel.toggle();
                }
            });
        }

        // Toggle right panel button (shows when panel is hidden, but acts as toggle)
        if (this.elements.showRightPanelBtn) {
            this.elements.showRightPanelBtn.addEventListener('click', () => {
                if (this.rightPanel) {
                    this.rightPanel.toggle();
                }
            });
        }

        // Share button
        if (this.elements.shareBtn) {
            this.elements.shareBtn.addEventListener('click', async () => {
                await this.showShareManagementModal();
            });
        }

        // Sidebar toggle buttons
        if (this.elements.hideSidebarBtn) {
            this.elements.hideSidebarBtn.addEventListener('click', () => {
                this.hideSidebar();
            });
        }

        if (this.elements.showSidebarBtn) {
            this.elements.showSidebarBtn.addEventListener('click', () => {
                this.showSidebar();
            });
        }

        // Wide mode button
        if (this.elements.wideModeBtn) {
            this.elements.wideModeBtn.addEventListener('click', () => {
                this.toggleWideMode();
            });
        }

        // Close sidebar on mobile when clicking outside
        document.addEventListener('click', (e) => {
            if (this.isMobileView()) {
                const sidebar = this.elements.sidebar;
                const showBtn = this.elements.showSidebarBtn;

                if (sidebar && sidebar.classList.contains('mobile-visible')) {
                    // Check if click is outside sidebar and not on the show button
                    if (!sidebar.contains(e.target) && !showBtn.contains(e.target)) {
                        this.hideSidebar();
                    }
                }
            }
        });

        this.setupFileDragAndDrop();

        // Close sidebar when clicking backdrop
        if (this.elements.mobileSidebarBackdrop) {
            this.elements.mobileSidebarBackdrop.addEventListener('click', () => {
                this.hideSidebar();
            });
        }

        // Session search input
        if (this.elements.searchRoomsInput) {
            this.elements.searchRoomsInput.addEventListener('input', (e) => {
                this.sessionSearchQuery = e.target.value;
                this.renderSessions();
                clearTimeout(this.sessionSearchDebounce);
                if (!this.sessionSearchQuery.trim()) {
                    this.updateSessionSearchResults();
                    return;
                }
                this.sessionSearchDebounce = setTimeout(() => {
                    this.updateSessionSearchResults();
                }, SESSION_SEARCH_DEBOUNCE);
            });
        }

        this.setupSidebarFilterControls();

        if (this.elements.sessionsScrollArea) {
            this.elements.sessionsScrollArea.addEventListener('scroll', () => {
                if (this.sidebar) {
                    this.sidebar.handleScroll();
                }
                if (this.hasActiveSessionListCriteria()) return;
                const { scrollTop, scrollHeight, clientHeight } = this.elements.sessionsScrollArea;
                if (scrollHeight - scrollTop - clientHeight < SESSION_SCROLL_LOAD_THRESHOLD) {
                    this.loadMoreSessions();
                }
            }, { passive: true });
        }

        // File upload button - triggers file input
        if (this.elements.fileUploadBtn) {
            this.elements.fileUploadBtn.addEventListener('click', () => {
                this.elements.fileUploadInput.click();
            });
        }

        // File input change - handles file selection
        if (this.elements.fileUploadInput) {
            this.elements.fileUploadInput.addEventListener('change', async (e) => {
                const files = Array.from(e.target.files);
                if (files.length > 0) {
                    await this.handleFileUpload(files);
                    // Reset the input value to allow re-selecting the same files
                    e.target.value = '';
                }
            });
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Cmd/Ctrl + / for new chat
            if ((e.metaKey || e.ctrlKey) && e.key === '/') {
                e.preventDefault();
                this.handleNewChatRequest();
            }

            // Cmd/Ctrl + K for model picker
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                if (this.modelPicker) {
                    this.modelPicker.toggle();
                }
            }

            // Cmd/Ctrl + J for the second Parallel model picker
            if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
                const session = this.getCurrentSession();
                const pendingCouncilEnabled = this.pendingCouncilConfig?.enabled === true;
                if (this.modelPicker && (this.isCouncilModeActive(session) || pendingCouncilEnabled)) {
                    e.preventDefault();
                    this.modelPicker.toggle({ selectionMode: 'council-secondary' });
                }
            }

            // Cmd/Ctrl + L for the Council synthesis model picker
            if ((e.metaKey || e.ctrlKey) && (e.key === 'l' || e.key === 'L')) {
                const session = this.getCurrentSession();
                const isCouncilReviewEnabled = session
                    ? this.isCouncilModeActive(session) && session?.councilConfig?.outputMode === COUNCIL_OUTPUT_SYNTHESIS
                    : this.pendingCouncilConfig?.enabled === true && this.pendingCouncilConfig?.outputMode === COUNCIL_OUTPUT_SYNTHESIS;
                const isSettingsOpen = this.elements.settingsMenu
                    && !this.elements.settingsMenu.classList.contains('hidden');
                if (this.modelPicker && (isCouncilReviewEnabled || isSettingsOpen)) {
                    e.preventDefault();
                    if (isSettingsOpen) {
                        this.elements.settingsMenu.classList.add('hidden');
                        this.elements.settingsBtn?.classList.remove('tooltip-disabled');
                    }
                    this.modelPicker.toggle({ selectionMode: 'council-synthesis' });
                }
            }

            // Cmd/Ctrl + \ for sidebar collapse/expand
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === '\\' || e.code === 'Backslash')) {
                e.preventDefault();
                this.toggleSidebar();
            }

            // Cmd/Ctrl + Shift + M for memory editor
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'm' || e.key === 'M')) {
                e.preventDefault();
                if (this.memoryFeatureEnabled === false) {
                    this.showToast?.('Memory is off in settings.', 'info', 3000);
                    return;
                }
                if (this.memoryEditor) {
                    this.memoryEditor.isOpen ? this.memoryEditor.close() : this.memoryEditor.open();
                }
            }

            // Cmd/Ctrl + Shift + F for search focus
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
                e.preventDefault();
                this.elements.searchRoomsInput?.focus();
            }

            // Cmd/Ctrl + Z for undo - handle file paste undo if there are file operations
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'z') {
                if (this.fileUndoStack.length > 0) {
                    e.preventDefault();
                    this.undoFilePaste();
                }
                // If no file undo available, let native text undo work
            }

            // Cmd/Ctrl + Shift + Backspace for clear chat (temporarily disabled)
            // if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Backspace') {
            //     e.preventDefault();
            //     const session = this.getCurrentSession();
            //     if (session) {
            //         chatDB.deleteSessionMessages(session.id);
            //         this.renderMessages();
            //     }
            // }

            // Escape to close modal
            if (e.key === 'Escape' && !this.elements.modelPickerModal.classList.contains('hidden')) {
                if (this.modelPicker) {
                    this.modelPicker.close();
                }
            }

            if (e.key === 'Escape' && this.isDeleteHistoryModalOpen()) {
                this.closeDeleteHistoryModal();
            }

            // Escape to close settings menu and session menus
            if (e.key === 'Escape') {
                if (!this.elements.settingsMenu.classList.contains('hidden')) {
                    this.elements.settingsMenu.classList.add('hidden');
                }
                document.querySelectorAll('.session-menu').forEach(menu => {
                    menu.classList.add('hidden');
                });
            }

            // Arrow key navigation for sidebar sessions
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && this.sidebar) {
                const active = document.activeElement;
                const isSearchFocused = active === this.elements.searchRoomsInput;
                const isTextInputFocused = active && (
                    active.tagName === 'TEXTAREA' ||
                    (active.tagName === 'INPUT' && !isSearchFocused) ||
                    active.isContentEditable
                );

                // Don't interfere with text input navigation
                if (isTextInputFocused) {
                    return;
                }

                // If search input is focused and pressing down, navigate to first result
                if (isSearchFocused && e.key === 'ArrowDown') {
                    e.preventDefault();
                    const orderedSessions = this.sidebar.getSessionsInDisplayOrder();
                    if (orderedSessions.length > 0) {
                        this.switchSession(orderedSessions[0].id);
                        this.elements.searchRoomsInput.blur();
                    }
                    return;
                }

                // If search is focused and up is pressed, do nothing (stay in input)
                if (isSearchFocused && e.key === 'ArrowUp') {
                    return;
                }

                // Navigate between sessions when no text input is focused
                e.preventDefault();
                const direction = e.key === 'ArrowUp' ? 'up' : 'down';
                this.sidebar.navigateSession(direction);
                return;
            }

            // Check if any input field is currently focused
            const activeElement = document.activeElement;
            const isInputFocused = activeElement && (
                activeElement.tagName === 'INPUT' ||
                activeElement.tagName === 'TEXTAREA' ||
                activeElement.isContentEditable
            );

            // Send message on Enter if no input is focused and there's unsent text
            if (e.key === 'Enter' &&
                !isInputFocused &&
                !e.shiftKey &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.altKey &&
                !this.elements.sendBtn.disabled &&
                this.elements.modelPickerModal.classList.contains('hidden')) {
                e.preventDefault();
                if (this.isCurrentSessionStreaming()) {
                    this.stopCurrentSessionStreaming();
                } else {
                    this.sendMessage();
                }
                return;
            }

            // Auto-focus message input when typing
            // Only auto-focus if:
            // - No input/textarea is currently focused
            // - Not using modifier keys (Cmd/Ctrl/Alt)
            // - Key is a printable character
            // - Model picker is closed
            // - No share modal is open
            if (!isInputFocused &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.altKey &&
                e.key.length === 1 &&
                this.elements.modelPickerModal.classList.contains('hidden') &&
                !this.ui.shareModals.currentModal) {
                this.elements.messageInput.focus();
            }
        });

        // Handle global paste events for files and text
        document.addEventListener('paste', async (e) => {
            const activeElement = document.activeElement;
            const isInputFocused = activeElement && (
                activeElement.tagName === 'INPUT' ||
                activeElement.tagName === 'TEXTAREA' ||
                activeElement.isContentEditable
            );

            const items = e.clipboardData?.items;
            if (!items) return;

            // Extract files and text SYNCHRONOUSLY before any async operations
            // (clipboard data becomes inaccessible after async operations)
            const fileBlobsData = [];
            let hasTextItem = false;

            for (let i = 0; i < items.length; i++) {
                if (items[i].kind === 'file') {
                    const blob = items[i].getAsFile();
                    if (blob) {
                        fileBlobsData.push({ blob, type: items[i].type });
                    }
                } else if (items[i].kind === 'string' && items[i].type === 'text/plain') {
                    hasTextItem = true;
                }
            }

            // If input is focused and there are NO files, let native text paste work
            if (isInputFocused && fileBlobsData.length === 0) {
                return;
            }

            // Handle files (always, regardless of focus state - native behavior doesn't support file paste)
            if (fileBlobsData.length > 0) {
                e.preventDefault();
                try {
                    const { getExtensionFromMimeType, validateFile } = await import('./services/fileUtils.js');
                    const filesToUpload = [];
                    const editTextarea = activeElement?.closest?.('.edit-prompt-textarea');
                    const editMessageId = editTextarea?.dataset?.messageId || null;

                    for (const { blob } of fileBlobsData) {
                        let filename = blob.name;
                        if (!filename) {
                            const extension = getExtensionFromMimeType(blob.type);
                            filename = `pasted-file-${Date.now()}.${extension || 'bin'}`;
                        }

                        const file = this.convertBlobToFile(blob, filename);
                        const validation = await validateFile(file);
                        if (validation.valid) {
                            filesToUpload.push(file);
                        } else {
                            console.warn('File validation failed:', validation.error);
                        }
                    }

                    if (filesToUpload.length > 0) {
                        if (editMessageId && this.editDrafts.has(editMessageId)) {
                            await this.handleEditFileUpload(editMessageId, filesToUpload);
                        } else {
                            await this.handleFileUpload(filesToUpload);
                            // Focus input after file upload
                            requestAnimationFrame(() => {
                                this.elements.messageInput.focus();
                            });
                        }
                    }
                } catch (error) {
                    console.error('Error handling pasted files:', error);
                }
                return; // Don't also paste text when pasting files
            }

            // Handle text paste only when NO input is focused (global text paste)
            const pastedText = e.clipboardData.getData('text/plain');
            if (pastedText) {
                e.preventDefault();
                const input = this.elements.messageInput;
                input.focus();
                // Use execCommand to insert text - preserves browser's undo/redo stack
                // Note: execCommand is deprecated but has no modern replacement for undo-compatible text insertion
                document.execCommand('insertText', false, pastedText); // eslint-disable-line
                // Trigger input event to update UI (auto-resize, send button state)
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
    }

    /**
     * Sets up file drag and drop events for the entire window.
     * Shows an overlay when files are dragged over the window.
     */
    setupFileDragAndDrop() {
        const overlay = this.elements.dropZoneOverlay;
        if (!overlay) return;

        let dragCounter = 0;
        let activeEditDropCard = null;

        const isFileDrag = (event) => (
            event.dataTransfer
            && event.dataTransfer.types
            && event.dataTransfer.types.includes('Files')
        );

        const getEditDropCard = (target) => {
            const hoveredCard = target?.closest?.('.edit-prompt-input-card') || null;
            if (hoveredCard) return hoveredCard;

            const activeTextarea = document.activeElement?.closest?.('.edit-prompt-textarea') || null;
            if (activeTextarea) return activeTextarea.closest?.('.edit-prompt-input-card') || null;

            if (this.editingMessageId && this.editDrafts.has(this.editingMessageId)) {
                const editingTextarea = Array.from(document.querySelectorAll('.edit-prompt-textarea'))
                    .find(textarea => textarea.dataset.messageId === this.editingMessageId);
                return editingTextarea?.closest?.('.edit-prompt-input-card') || null;
            }

            return null;
        };

        const clearEditDropCard = () => {
            if (activeEditDropCard) {
                activeEditDropCard.classList.remove('edit-prompt-drag-active');
                activeEditDropCard = null;
            }
        };

        const updateDragFeedback = (target) => {
            const editDropCard = getEditDropCard(target);
            if (editDropCard) {
                overlay.classList.add('hidden');
                if (activeEditDropCard && activeEditDropCard !== editDropCard) {
                    activeEditDropCard.classList.remove('edit-prompt-drag-active');
                }
                activeEditDropCard = editDropCard;
                activeEditDropCard.classList.add('edit-prompt-drag-active');
                return;
            }

            clearEditDropCard();
            overlay.classList.remove('hidden');
        };

        const clearDragFeedback = () => {
            overlay.classList.add('hidden');
            clearEditDropCard();
        };

        window.addEventListener('dragenter', (e) => {
            e.preventDefault();
            // Check if dragging files
            if (isFileDrag(e)) {
                dragCounter++;
                if (dragCounter === 1) {
                    updateDragFeedback(e.target);
                }
            }
        });

        window.addEventListener('dragleave', (e) => {
            e.preventDefault();
            if (isFileDrag(e)) {
                dragCounter--;
                if (dragCounter <= 0) {
                    dragCounter = 0;
                    clearDragFeedback();
                }
            }
        });

        window.addEventListener('dragover', (e) => {
            e.preventDefault(); // Necessary to allow dropping
            if (isFileDrag(e)) {
                updateDragFeedback(e.target);
            }
        });

        window.addEventListener('drop', async (e) => {
            e.preventDefault();
            dragCounter = 0;
            const editCard = getEditDropCard(e.target);
            clearDragFeedback();

            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                const files = Array.from(e.dataTransfer.files);
                const droppedEditMessageId = editCard?.querySelector?.('.edit-prompt-textarea')?.dataset?.messageId || null;
                const activeEditMessageId = document.activeElement?.closest?.('.edit-prompt-textarea')?.dataset?.messageId || null;
                const editMessageId = droppedEditMessageId || activeEditMessageId;

                if (editMessageId && this.editDrafts.has(editMessageId)) {
                    await this.handleEditFileUpload(editMessageId, files);
                } else {
                    await this.handleFileUpload(files);
                }
            }
        });
    }

    /**
     * Updates theme controls based on current preference (delegated to ChatInput).
     * @param {string} preference - Theme preference
     * @param {string} effectiveTheme - Actual theme being used
     */
    updateThemeControls(preference, effectiveTheme) {
        if (this.chatInput) {
            this.chatInput.updateThemeControls(preference, effectiveTheme);
        }
    }

    /**
     * Enriches citations with metadata and updates the UI.
     * @param {Object} message - The message containing citations
     */
    async enrichCitationsAndUpdateUI(message) {
        if (!message.citations || message.citations.length === 0) return;

        try {
            // Import the URL metadata service
            const { fetchUrlMetadata } = await import('./services/urlMetadata.js');

            // Fetch metadata for all citations in parallel
            const metadataPromises = message.citations.map(citation =>
                fetchUrlMetadata(citation.url)
                    .then(metadata => {
                        // Update citation with metadata
                        citation.title = metadata.title || citation.title;
                        citation.description = metadata.description;
                        citation.favicon = metadata.favicon;
                        citation.domain = metadata.domain;
                    })
                    .catch(err => {
                        console.debug('Failed to fetch metadata for', citation.url);
                    })
            );

            await Promise.all(metadataPromises);

            // Save updated message with enriched citations
            await chatDB.saveMessage(message);

            // Re-render the message to show updated citations
            if (this.chatArea) {
                await this.chatArea.finalizeStreamingMessage(message, { forceFullRender: true });
            }
        } catch (error) {
            console.debug('Error enriching citations:', error);
        }
    }

    resetMessageInputLayout({ resetScroll = false } = {}) {
        const input = this.elements.messageInput;
        if (!input) return;
        input.style.height = '24px';
        if (resetScroll) {
            input.scrollTop = 0;
            input.scrollLeft = 0;
            // Force Safari to completely recalculate textarea layout
            // by toggling display - this clears Safari's cached content rendering
            const origDisplay = input.style.display;
            input.style.display = 'none';
            void input.offsetHeight; // Force reflow
            input.style.display = origDisplay || '';
        }
    }

    deferInitialInputFocus() {
        const retryFocus = () => this.focusMessageInput();

        // Initial focus right away
        this.focusMessageInput({ force: true });
        // Re-assert focus after initial layout/render passes
        requestAnimationFrame(retryFocus);
        setTimeout(retryFocus, 150);
        window.addEventListener('load', retryFocus, { once: true });
        window.addEventListener('focus', retryFocus, { once: true });
    }

    focusMessageInput({ force = false } = {}) {
        const input = this.elements.messageInput;
        if (!input || input.disabled) return;

        const active = document.activeElement;
        if (!force && active && active !== document.body && active !== document.documentElement && active !== input) {
            return;
        }

        if (input.offsetParent === null) return;

        input.focus({ preventScroll: true });
        try {
            const len = input.value.length;
            input.setSelectionRange(len, len);
        } catch (error) {
            // Some browsers may not support selection on focus; ignore.
        }
    }

    updateInputState() {
        const hasContent = this.elements.messageInput.value.trim() || this.uploadedFiles.length > 0;
        const isStreaming = this.isCurrentSessionStreaming();
        const shouldBeDisabled = !isStreaming && !hasContent;

        // Don't disable input during streaming - allow typing
        this.elements.messageInput.disabled = false;
        this.elements.sendBtn.disabled = shouldBeDisabled;

        this.elements.sendBtn.classList.toggle('opacity-40', shouldBeDisabled);
        this.elements.sendBtn.classList.toggle('opacity-100', !shouldBeDisabled);

        // Update button icon based on streaming state
        if (isStreaming) {
            // Change to stop icon (simple square)
            this.elements.sendBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-3 h-3">
                    <rect x="4" y="4" width="16" height="16" rx="2"/>
                </svg>
            `;
            // Change button style to indicate stop
            this.elements.sendBtn.classList.add('bg-destructive', 'hover:bg-destructive/90', 'text-destructive-foreground');
            this.elements.sendBtn.classList.remove('bg-primary', 'hover:bg-primary/90', 'text-primary-foreground');
            this.elements.messageInput.placeholder = "Waiting for response...";
        } else {
            // Restore send icon
            this.elements.sendBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
                </svg>
            `;
            // Restore primary button style
            this.elements.sendBtn.classList.add('bg-primary', 'hover:bg-primary/90', 'text-primary-foreground');
            this.elements.sendBtn.classList.remove('bg-destructive', 'hover:bg-destructive/90', 'text-destructive-foreground');

            // Set placeholder based on state
            if (this.searchEnabled) {
                // For now, use the same placeholder as the default when search is enabled
                this.elements.messageInput.placeholder = "Ask anything";
            } else {
                this.elements.messageInput.placeholder = "Ask anything";
            }
        }
    }

    async handleFileUpload(files) {
        const { validateFile } = await import('./services/fileUtils.js');

        const validFiles = [];
        const errors = [];

        for (const file of files) {
            const validation = await validateFile(file);
            if (validation.valid) {
                validFiles.push(file);
            } else {
                errors.push(validation.error);
            }
        }

        if (validFiles.length > 0) {
            // Track for undo: record how many files were added
            this.fileUndoStack.push(validFiles.length);
            this.uploadedFiles.push(...validFiles);
            this.renderFilePreviews();
            this.updateFileCountBadge();
            this.updateInputState();
            // Focus the input field so user can immediately type
            this.elements.messageInput.focus();
        }

        if (errors.length > 0) {
            this.showErrorNotification(errors.join('\n\n'));
        }
    }

    /**
     * Undo the most recent file paste operation.
     * @returns {boolean} True if an undo was performed
     */
    undoFilePaste() {
        if (this.fileUndoStack.length === 0) return false;

        const count = this.fileUndoStack.pop();
        // Remove the last 'count' files from uploadedFiles
        this.uploadedFiles.splice(-count, count);
        this.renderFilePreviews();
        this.updateFileCountBadge();
        this.updateInputState();
        return true;
    }

    /**
     * Converts a Blob (from clipboard) to a File object with proper metadata.
     * @param {Blob} blob - The image blob from clipboard
     * @param {string} filename - The filename to assign
     * @returns {File} File object
     */
    convertBlobToFile(blob, filename) {
        return new File([blob], filename, {
            type: blob.type,
            lastModified: Date.now()
        });
    }

    showErrorNotification(message) {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = 'fixed top-4 right-4 z-50 max-w-md bg-destructive/90 text-white px-4 py-3 rounded-lg shadow-lg border border-destructive animate-in slide-in-from-top-5 fade-in';
        notification.innerHTML = `
            <div class="flex items-start gap-3">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5 flex-shrink-0 mt-0.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                </svg>
                <div class="flex-1">
                    <div class="font-semibold text-sm mb-1">Error</div>
                    <div class="text-sm opacity-90 whitespace-pre-line">${message}</div>
                </div>
                <button onclick="this.parentElement.parentElement.remove()" class="flex-shrink-0 hover:opacity-70 transition-opacity">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
        `;

        document.body.appendChild(notification);

        // Auto-remove after 6 seconds
        setTimeout(() => {
            notification.remove();
        }, 6000);
    }

    /**
     * Shows a warning when attempting to use a banned station's API key
     * Clears the key and shows an error message
     */
    async showBannedStationWarningModal({ stationId, reason, bannedAt, sessionId }) {
        // Get the session
        const session = this.state.sessions.find(s => s.id === sessionId) || this.getCurrentSession();

        if (session) {
            // Clear the API key
            inferenceService.clearAccessInfo(session);
            await chatDB.saveSession(session);

            // Update UI
            if (this.rightPanel) {
                this.rightPanel.onSessionChange(session);
            }
        }

        // Format the ban timestamp
        const bannedDate = bannedAt ? new Date(bannedAt).toLocaleString() : 'Unknown';

        // Show error message in chat with itemized format
        const errorMessage = `**Station Banned**

The station that issued your API key has been banned.

- **Station ID:** \`${stationId || 'Unknown'}\`
- **Reason:** ${reason || 'Not specified'}
- **Banned at:** ${bannedDate}

Your API key has been cleared. A new key from a different station will be obtained automatically when you send your next message.`;

        await this.addMessage('assistant', errorMessage, { isLocalOnly: true });

        // Also show a toast notification
        this.showErrorNotification(`Station banned: ${reason || 'Unknown reason'}. Your API key has been cleared.`);
    }

    async renderFilePreviews() {
        const container = this.elements.filePreviewsContainer;
        const renderVersion = ++this.filePreviewRenderVersion;
        const files = [...this.uploadedFiles];
        if (files.length === 0) {
            container.classList.add('hidden');
            return;
        }

        container.classList.remove('hidden');

        // Generate previews with a horizontal card layout
        const previewPromises = files.map(async (file, index) => {
            const fileSize = this.formatFileSize(file.size);
            const isImage = file.type.startsWith('image/');

            // Get icon or image preview
            let iconOrPreview = '';

            if (isImage) {
                const imageUrl = await this.createImagePreview(file);
                const imageId = `preview-image-${Date.now()}-${index}`;
                iconOrPreview = `
                    <img
                        src="${imageUrl}"
                        class="w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity"
                        alt="${file.name}"
                        data-image-id="${imageId}"
                        onclick="window.expandImage('${imageId}')"
                    >
                `;
            } else {
                // For non-images, determine file type and use the appropriate SVG icon
                const { getFileType } = await import('./services/fileUtils.js');
                const detectedType = await getFileType(file);
                const isPdf = detectedType === 'pdf' || file.type === 'application/pdf';
                const isDocx = detectedType === 'docx';
                const isAudio = detectedType === 'audio' || file.type.startsWith('audio/');
                const isText = detectedType === 'text' ||
                              file.type.startsWith('text/') ||
                              file.type.includes('json') ||
                              file.type.includes('javascript') ||
                              file.type.includes('xml') ||
                              file.type.includes('sh') ||
                              file.type.includes('yaml') ||
                              file.type.includes('toml') ||
                              // Also check by file extension for code files that might have generic MIME types
                              /\.(go|py|js|ts|jsx|tsx|java|c|cpp|h|hpp|cs|rb|php|swift|kt|rs|scala|r|m|mm|sql|sh|bash|zsh|pl|lua|vim|el|clj|ex|exs|erl|hrl|hs|lhs|ml|mli|fs|fsx|fsi|v|sv|svh|vhd|vhdl|tcl|awk|sed|diff|patch|md|markdown|rst|tex|bib|csv|tsv|txt|log|cfg|conf|ini|toml|yaml|yml|xml|html|css|scss|sass|less|json|jsonl|proto|thrift)$/i.test(file.name);

                let fileTypeForIcon = null;
                if (isPdf) fileTypeForIcon = 'pdf';
                else if (isDocx) fileTypeForIcon = 'docx';
                else if (isAudio) fileTypeForIcon = 'audio';
                else if (isText) fileTypeForIcon = 'text';

                iconOrPreview = getFileIconSvg(fileTypeForIcon, file.type, 'w-8 h-8');
            }

            return `
                <div class="group relative flex items-center p-2 gap-3 bg-muted/30 hover:bg-muted/50 dark:bg-secondary/10 dark:hover:bg-secondary/20 border border-border dark:border-border/50 rounded-xl w-auto max-w-[240px] transition-all select-none overflow-hidden">
                    <!-- Icon/Preview Container -->
                    <div class="flex-shrink-0 w-10 h-10 rounded-lg overflow-hidden flex items-center justify-center bg-background border border-border/50 shadow-sm">
                        ${iconOrPreview}
                    </div>

                    <!-- Text Info -->
                    <div class="flex flex-col min-w-0 pr-6">
                        <span class="text-xs font-medium text-foreground truncate leading-tight" title="${file.name}">
                            ${file.name}
                        </span>
                        <span class="text-[10px] text-muted-foreground truncate">
                            ${fileSize}
                        </span>
                    </div>

                    <!-- Remove Button -->
                    <button
                        class="absolute top-1.5 right-1.5 p-1 rounded-full text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 transition-all opacity-0 group-hover:opacity-100"
                        onclick="event.stopPropagation(); app.removeFile(${index})"
                        title="Remove file"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" class="w-3 h-3">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
            `;
        });

        const previews = await Promise.all(previewPromises);
        if (renderVersion !== this.filePreviewRenderVersion) return;
        container.innerHTML = previews.join('');
    }

    createImagePreview(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.readAsDataURL(file);
        });
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    updateFileCountBadge() {
        if (this.uploadedFiles.length > 0) {
            this.elements.fileCountBadge.textContent = this.uploadedFiles.length;
            this.elements.fileCountBadge.classList.remove('hidden');
        } else {
            this.elements.fileCountBadge.classList.add('hidden');
        }
    }

    removeFile(index) {
        this.uploadedFiles.splice(index, 1);
        this.fileUndoStack = []; // Clear undo stack - manual removal invalidates undo history
        this.renderFilePreviews();
        this.updateFileCountBadge();
        this.updateInputState();
    }

    /**
     * Build a persistable snapshot of the latest submit_key verification result.
     * Stored on session.apiKeyInfo so it survives page refreshes.
     */
    buildVerifierSubmitKeyProof(verifyResult, accessInfo = null) {
        return buildVerifierSubmitKeyProofValue(verifyResult, accessInfo);
    }

    /**
     * Persist verifier submit_key proof into the active session access record.
     */
    persistVerifierSubmitKeyProof(session, verifyResult) {
        persistVerifierSubmitKeyProofValue(session, verifyResult);
    }

    getAccessAcquisitionKey(session, modelNameOverride = null, modelIdOverride = null) {
        const backendId = session?.inferenceBackend || inferenceService.getDefaultBackendId();
        const modelKey = modelIdOverride ||
            this.normalizeModelName(modelNameOverride || session?.model) ||
            modelNameOverride ||
            session?.model ||
            inferenceService.getDefaultModelName(session) ||
            'default-model';
        return `${backendId}:${session?.id || 'no-session'}:${modelKey}`;
    }

    reserveAccessAcquisitionHandoff(session, durationMs = 5000) {
        const key = this.getAccessAcquisitionKey(session);
        const entry = this.accessAcquisitionInFlight.get(key);
        if (!entry) return;
        entry.keepAliveUntil = Math.max(entry.keepAliveUntil || 0, Date.now() + durationMs);
    }

    abortAccessAcquisitionWhenUnclaimed(entry) {
        if (!entry || entry.waiters > 0 || entry.controller.signal.aborted) return;

        const keepAliveDelay = Math.max(0, (entry.keepAliveUntil || 0) - Date.now());
        if (keepAliveDelay > 0) {
            if (entry.abortTimer) {
                clearTimeout(entry.abortTimer);
            }
            entry.abortTimer = window.setTimeout(() => {
                entry.abortTimer = null;
                if (entry.waiters === 0 && this.accessAcquisitionInFlight.get(entry.key) === entry) {
                    entry.controller.abort();
                }
            }, keepAliveDelay);
            return;
        }

        entry.controller.abort();
    }

    async waitForAccessAcquisition(entry, options = {}) {
        const signal = options.signal || null;
        this.throwIfAborted(signal);

        entry.waiters += 1;
        if (entry.abortTimer) {
            clearTimeout(entry.abortTimer);
            entry.abortTimer = null;
        }
        let abortHandler = null;

        try {
            const token = signal
                ? await Promise.race([
                    entry.promise,
                    new Promise((_, reject) => {
                        abortHandler = () => reject(this.createCancelledError());
                        signal.addEventListener('abort', abortHandler, { once: true });
                    })
                ])
                : await entry.promise;

            if (typeof options.onGranted === 'function') {
                try {
                    await options.onGranted(token);
                } catch (error) {
                    console.warn('Pending-state update after access grant failed:', error);
                }
            }

            return token;
        } finally {
            if (signal && abortHandler) {
                signal.removeEventListener('abort', abortHandler);
            }
            entry.waiters = Math.max(0, entry.waiters - 1);
            if (signal?.aborted && entry.waiters === 0) {
                this.abortAccessAcquisitionWhenUnclaimed(entry);
            }
        }
    }

    async acquireAndSetAccess(session, options = {}) {
        this.throwIfAborted(options.signal || null);
        const key = this.getAccessAcquisitionKey(session, options.modelNameOverride, options.modelIdOverride);
        let entry = this.accessAcquisitionInFlight.get(key);

        if (!entry) {
            const controller = new AbortController();
            entry = {
                key,
                controller,
                waiters: 0,
                keepAliveUntil: 0,
                abortTimer: null,
                promise: null
            };
            entry.promise = acquireSessionAccess({
                session,
                models: this.state.models,
                reasoningEnabled: this.reasoningEnabled,
                inferenceService,
                ticketClient,
                chatDB,
                getTicketCost,
                getFallbackModelEntry: (targetSession) => this.getFallbackModelEntry(targetSession),
                modelIdOverride: options.modelIdOverride,
                modelNameOverride: options.modelNameOverride,
                signal: controller.signal,
                ticketsRequiredOverride: options.ticketsRequiredOverride,
                ticketRequirementLabel: options.ticketRequirementLabel,
                onTicketUsed: () => {
                    this.showToast('Ticket already used, trying next available');
                },
                onNetworkSession: (sessionId) => {
                    if (window.networkLogger) {
                        window.networkLogger.setCurrentSession(sessionId);
                    }
                },
                onAccessRequestError: (error) => {
                    console.error('Failed to automatically acquire API access:', error);
                },
                onVerificationWarning: (...args) => {
                    console.warn(...args);
                },
                onSessionChanged: (changedSession) => {
                    if (this.rightPanel) {
                        this.rightPanel.onSessionChange(changedSession);
                    }
                }
            }).finally(() => {
                if (entry.abortTimer) {
                    clearTimeout(entry.abortTimer);
                    entry.abortTimer = null;
                }
                if (this.accessAcquisitionInFlight.get(key) === entry) {
                    this.accessAcquisitionInFlight.delete(key);
                }
            });
            this.accessAcquisitionInFlight.set(key, entry);
        }

        return this.waitForAccessAcquisition(entry, options);
    }

    /**
     * Toggles citation visibility for a message.
     * @param {string} messageId - The message ID
     */
    toggleCitations(messageId) {
        const contentEl = document.getElementById(`citations-content-${messageId}`);
        const chevronEl = document.querySelector(`#citations-toggle-${messageId} .citations-chevron`);

        if (!contentEl) {
            console.debug('[toggleCitations] Content element not found for message:', messageId);
            return;
        }

        const isHidden = contentEl.classList.contains('hidden');
        if (isHidden) {
            contentEl.classList.remove('hidden');
            if (chevronEl) {
                chevronEl.style.transform = 'rotate(180deg)';
            }
        } else {
            contentEl.classList.add('hidden');
            if (chevronEl) {
                chevronEl.style.transform = 'rotate(0deg)';
            }
        }

        // Update scroll button visibility after content change
        this.updateScrollButtonVisibility();
    }

    /**
     * Scrolls to a specific citation.
     * @param {string} messageId - The message ID
     * @param {string} citationNum - The citation number
     */
    scrollToCitation(messageId, citationNum) {
        // First expand the citations if collapsed
        const carousel = document.getElementById(`citations-content-${messageId}`);
        const chevronEl = document.querySelector(`#citations-toggle-${messageId} .citations-chevron`);

        if (carousel && carousel.classList.contains('hidden')) {
            carousel.classList.remove('hidden');
            if (chevronEl) {
                chevronEl.style.transform = 'rotate(180deg)';
            }

            // Update scroll button visibility after content change
            this.updateScrollButtonVisibility();
        }

        // Then find and scroll to the citation
        const citationEl = document.getElementById(`citation-${messageId}-${citationNum}`);
        if (citationEl && carousel) {
            // Add a brief highlight effect
            citationEl.classList.add('citation-highlight');
            setTimeout(() => {
                citationEl.classList.remove('citation-highlight');
            }, 2000);

            // Calculate scroll position to center the citation
            const citationLeft = citationEl.offsetLeft;
            const citationWidth = citationEl.offsetWidth;
            const carouselWidth = carousel.offsetWidth;
            const scrollPosition = citationLeft - (carouselWidth / 2) + (citationWidth / 2);

            carousel.scrollTo({
                left: scrollPosition,
                behavior: 'smooth'
            });

            // Also scroll the citation section into view if needed
            citationEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    /**
     * Toggle scrubber restoration for an assistant message.
     * @param {string} messageId
     */
    async toggleScrubberRestore(messageId) {
        const session = this.getCurrentSession();
        if (!session) return;

        const messages = await chatDB.getSessionMessages(session.id);
        const messageIndex = messages.findIndex(msg => msg.id === messageId);
        if (messageIndex === -1) return;
        const message = messages[messageIndex];
        const canRestore = message?.scrubber?.canRestore || message?.scrubber?.redactedPrompt;
        if (!canRestore) return;

        if (message.scrubber.restored) {
            // Toggle back to redacted version
            const redactedResponse = message.scrubber.redactedResponse || message.content || '';
            message.content = redactedResponse;
            message.scrubber.restored = false;
            await chatDB.saveMessage(message);
            if (this.chatArea && this.isViewingSession(session.id)) {
                this.chatArea.updateMessage(message);
            }
            return;
        }

        // Check if we have a pre-cached restored response
        if (message.scrubber.restoredResponse) {
            // Use cached version - instant restore!
            if (!message.scrubber.redactedResponse) {
                message.scrubber.redactedResponse = message.content || '';
            }
            message.scrubber.restored = true;
            message.content = message.scrubber.restoredResponse;
            message.tokenCount = Math.ceil(message.scrubber.restoredResponse.length / 4);
            await chatDB.saveMessage(message);
            if (this.chatArea && this.isViewingSession(session.id)) {
                this.chatArea.updateMessage(message);
            }
            this.showToast('PII restored', 'success');
            return;
        }

        // No cached version - need to call API
        const stopLoading = this.showLoadingToast('Restoring PII...');
        try {
            const responseText = message.content || message.scrubber.redactedResponse || '';
            if (!message.scrubber.redactedResponse) {
                message.scrubber.redactedResponse = responseText;
            }
            const useContextRestore = message.scrubber?.mode === 'context' ||
                (!message.scrubber?.redactedPrompt && message.scrubber?.canRestore);
            let restoreResult = null;
            if (useContextRestore) {
                const historyMessages = messages.slice(0, messageIndex).filter(msg => !msg.isLocalOnly);
                const { original, redacted } = this.buildScrubberRestoreContext(historyMessages);
                if (!original.trim() || !redacted.trim()) {
                    this.showToast('Restore failed', 'error');
                    return;
                }
                restoreResult = await this.scrubberService.restoreResponseWithContext({
                    originalContext: original,
                    redactedContext: redacted,
                    responseText,
                    session
                });
            } else {
                restoreResult = await this.scrubberService.restoreResponse({
                    originalPrompt: message.scrubber.originalPrompt || '',
                    redactedPrompt: message.scrubber.redactedPrompt || '',
                    responseText,
                    session
                });
            }
            if (restoreResult?.success && restoreResult.text) {
                message.scrubber.restoredResponse = restoreResult.text;
                message.scrubber.restored = true;
                message.content = restoreResult.text;
                message.tokenCount = Math.ceil(restoreResult.text.length / 4);
                await chatDB.saveMessage(message);
                if (this.chatArea && this.isViewingSession(session.id)) {
                    this.chatArea.updateMessage(message);
                }
                this.showToast('PII restored', 'success');
            } else {
                this.showToast('Restore failed', 'error');
            }
        } catch (error) {
            console.warn('Scrubber restore failed:', error);
            this.showToast('Restore failed', 'error');
        } finally {
            if (typeof stopLoading === 'function') {
                stopLoading();
            }
        }
    }

    /**
     * Pre-cache scrubber restoration for an assistant message in the background.
     * Called after response completes to have the restored version ready when user clicks restore.
     * @param {Object} message - The assistant message with scrubber metadata
     */
    async preCacheScrubberRestore(message) {
        // Only pre-cache if message has scrubber data and can be restored
        if (!message?.scrubber?.canRestore) return;
        // Skip if already cached
        if (message.scrubber.restoredResponse) return;
        // Skip if no response content
        if (!message.content) return;

        try {
            const session = this.getCurrentSession();
            if (!session) return;

            const messages = await chatDB.getSessionMessages(session.id);
            const messageIndex = messages.findIndex(msg => msg.id === message.id);
            if (messageIndex === -1) return;

            const responseText = message.content;
            const useContextRestore = message.scrubber?.mode === 'context' ||
                (!message.scrubber?.redactedPrompt && message.scrubber?.canRestore);

            let restoreResult = null;
            if (useContextRestore) {
                const historyMessages = messages.slice(0, messageIndex).filter(msg => !msg.isLocalOnly);
                const { original, redacted } = this.buildScrubberRestoreContext(historyMessages);
                if (!original.trim() || !redacted.trim()) return;
                restoreResult = await this.scrubberService.restoreResponseWithContext({
                    originalContext: original,
                    redactedContext: redacted,
                    responseText,
                    session
                });
            } else {
                if (!message.scrubber.originalPrompt || !message.scrubber.redactedPrompt) return;
                restoreResult = await this.scrubberService.restoreResponse({
                    originalPrompt: message.scrubber.originalPrompt,
                    redactedPrompt: message.scrubber.redactedPrompt,
                    responseText,
                    session
                });
            }

            if (restoreResult?.success && restoreResult.text) {
                // Cache the restored response without showing it
                message.scrubber.restoredResponse = restoreResult.text;
                message.scrubber.redactedResponse = responseText;
                await chatDB.saveMessage(message);
                console.log('[Scrubber] Pre-cached restoration for message:', message.id);
            }
        } catch (error) {
            // Silently fail - this is just a background optimization
            console.warn('[Scrubber] Pre-cache failed:', error);
        }
    }
}

export function createChatApp(options = {}) {
    const app = new ChatApp(options);
    if (typeof window !== 'undefined') {
        window.app = app;
        window.oaDesktopReady = true;
    }
    return app;
}

export { ChatApp };
