// Main application logic
import RightPanel from './components/RightPanel.js';
// FEATURE DISABLED: Status indicator and activity banner - uncomment to re-enable
import FloatingPanel from './components/FloatingPanel.js';
import MessageNavigation from './components/MessageNavigation.js';
import Sidebar from './components/Sidebar.js';
import ChatArea from './components/ChatArea.js';
import ChatInput from './components/ChatInput.js';
import ModelPicker from './components/ModelPicker.js';
import { buildTypingIndicator } from './components/MessageTemplates.js';
import apiKeyStore from './services/apiKeyStore.js';
import themeManager from './services/themeManager.js';

/**
 * ChatApp - Main application controller
 * Manages application state, coordinates UI components, and handles business logic.
 */
class ChatApp {
    constructor() {
        this.state = {
            sessions: [],
            currentSessionId: null,
            models: [],
            modelsLoading: false,
            pendingModel: null // Model selected before session is created
        };

        this.elements = {
            newChatBtn: document.getElementById('new-chat-btn'),
            sessionsList: document.getElementById('sessions-list'),
            searchRoomsInput: document.getElementById('search-rooms'),
            chatArea: document.getElementById('chat-area'),
            messagesContainer: document.getElementById('messages-container'),
            messageInput: document.getElementById('message-input'),
            sendBtn: document.getElementById('send-btn'),
            modelPickerBtn: document.getElementById('model-picker-btn'),
            modelPickerModal: document.getElementById('model-picker-modal'),
            closeModalBtn: document.getElementById('close-modal-btn'),
            modelsList: document.getElementById('models-list'),
            modelSearch: document.getElementById('model-search'),
            settingsBtn: document.getElementById('settings-btn'),
            settingsMenu: document.getElementById('settings-menu'),
            searchToggle: document.getElementById('search-toggle'),
            searchSwitch: document.getElementById('search-switch'),
            clearChatBtn: document.getElementById('clear-chat-btn'),
            copyMarkdownBtn: document.getElementById('copy-markdown-btn'),
            toggleRightPanelBtn: document.getElementById('toggle-right-panel-btn'), // This might be legacy, but let's keep it for now.
            showRightPanelBtn: document.getElementById('show-right-panel-btn'),
            sidebar: document.getElementById('sidebar'),
            hideSidebarBtn: document.getElementById('hide-sidebar-btn'),
            showSidebarBtn: document.getElementById('show-sidebar-btn'),
            mobileSidebarBackdrop: document.getElementById('mobile-sidebar-backdrop'),
            sessionsScrollArea: document.getElementById('sessions-scroll-area'),
            modelListScrollArea: document.getElementById('model-list-scroll-area'),
            themeOptionButtons: Array.from(document.querySelectorAll('[data-theme-option]')),
            themeEffectiveLabel: document.getElementById('theme-effective-label'),
            fileUploadBtn: document.getElementById('file-upload-btn'),
            fileUploadInput: document.getElementById('file-upload-input'),
            filePreviewsContainer: document.getElementById('file-previews-container'),
            fileCountBadge: document.getElementById('file-count-badge'),
        };

        this.searchEnabled = false;
        this.sessionSearchQuery = '';
        this.uploadedFiles = [];
        this.rightPanel = null;
        this.floatingPanel = null;
        this.messageNavigation = null;
        this.sidebar = null;
        this.chatArea = null;
        this.chatInput = null;
        this.modelPicker = null;
        this.sessionStreamingStates = new Map(); // Track streaming state per session

        this.init();
    }

    /**
     * Process content with protected LaTeX expressions
     * This prevents marked from breaking LaTeX delimiters
     */
    processContentWithLatex(content) {
        // Store block-level LaTeX to prevent wrapping in <p> tags
        const blockLatexPlaceholders = [];
        let processedContent = content;

        // Extract block LaTeX \[...\] and replace with placeholders
        processedContent = processedContent.replace(/\\\[([\s\S]*?)\\\]/g, (match, latex) => {
            const placeholder = `BLOCKLATEX${blockLatexPlaceholders.length}PLACEHOLDER`;
            blockLatexPlaceholders.push(match);
            return `\n\n${placeholder}\n\n`;
        });

        // Extract block LaTeX $$...$$ and replace with placeholders
        processedContent = processedContent.replace(/\$\$([\s\S]*?)\$\$/g, (match, latex) => {
            const placeholder = `BLOCKLATEX${blockLatexPlaceholders.length}PLACEHOLDER`;
            blockLatexPlaceholders.push(match);
            return `\n\n${placeholder}\n\n`;
        });

        // Escape inline LaTeX delimiters
        processedContent = processedContent
            .replace(/\\\(/g, '\\\\(')
            .replace(/\\\)/g, '\\\\)');

        // Process markdown
        let html = marked.parse(processedContent);

        // Restore block LaTeX without <p> wrapping
        blockLatexPlaceholders.forEach((latex, index) => {
            const placeholder = `BLOCKLATEX${index}PLACEHOLDER`;
            // Remove <p> tags around placeholder and replace with the LaTeX
            html = html.replace(new RegExp(`<p>${placeholder}</p>|${placeholder}`, 'g'), latex);
        });

        return html;
    }

    initScrollAwareScrollbars(element) {
        let scrollTimer = null;
        element.addEventListener('scroll', () => {
            element.classList.add('scrolling');
            if (scrollTimer) {
                clearTimeout(scrollTimer);
            }
            scrollTimer = setTimeout(() => {
                element.classList.remove('scrolling');
            }, 1500);
        });
    }

    /**
     * Reliably scroll chat area to bottom
     * Uses multiple RAF calls to ensure content is fully rendered
     */
    scrollToBottom(force = false) {
        const chatArea = this.elements.chatArea;
        if (!chatArea) return;

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

    /**
     * Initializes the application: loads data, sets up components, and renders initial state.
     */
    async init() {
        // Initialize IndexedDB
        await chatDB.init();

        // Load network logs from database - DISABLED (logs are now memory-only, ephemeral per tab)
        // await networkLogger.loadLogs();

        // Initialize theme management first
        themeManager.init();

        // Initialize UI components
        this.sidebar = new Sidebar(this);
        this.chatArea = new ChatArea(this);
        this.chatInput = new ChatInput(this);
        this.modelPicker = new ModelPicker(this);
        this.rightPanel = new RightPanel(this);
        this.rightPanel.mount();

        // Now set up theme controls after chatInput is initialized
        this.updateThemeControls(themeManager.getPreference(), themeManager.getEffectiveTheme());
        this.themeUnsubscribe = themeManager.onChange((preference, effectiveTheme) => {
            this.updateThemeControls(preference, effectiveTheme);
        });

        // FEATURE DISABLED: Status indicator and activity banner - uncomment to re-enable
        // Initialize floating panel
        // this.floatingPanel = new FloatingPanel(this);

        // Initialize message navigation
        this.messageNavigation = new MessageNavigation(this);

        // Load data from IndexedDB FIRST (to get existing sessions for sidebar)
        await this.loadFromDB();

        // Don't create or select any session on startup
        // A new session will be created when the user sends their first message

        // Load models from OpenRouter API (now we have a session)
        await this.loadModels();

        // Render initial state
        this.renderSessions();
        this.renderMessages();
        this.renderCurrentModel();

        // Notify right panel of current session
        const currentSession = this.getCurrentSession();
        if (this.rightPanel && currentSession) {
            this.rightPanel.onSessionChange(currentSession);
        }
        if (this.floatingPanel && currentSession) {
            this.floatingPanel.render();
        }

        // Restore search state from global setting
        const savedSearchEnabled = await chatDB.getSetting('searchEnabled');
        this.searchEnabled = savedSearchEnabled !== undefined ? savedSearchEnabled : false;
        this.chatInput.updateSearchToggleUI();

        // Set up event listeners
        this.setupEventListeners();

        this.initScrollAwareScrollbars(this.elements.chatArea);
        this.initScrollAwareScrollbars(this.elements.sessionsScrollArea);
        this.initScrollAwareScrollbars(this.elements.modelListScrollArea);

        // Set up scroll listener for message navigation
        this.elements.chatArea.addEventListener('scroll', () => {
            if (this.messageNavigation) {
                this.messageNavigation.handleScroll();
            }
        });

        // Set up ResizeObserver to adjust chat area padding when input area expands
        this.setupInputAreaObserver();
        // Handle mobile view on initial load
        if (this.isMobileView()) {
            this.hideSidebar();
        }

        // Scroll to bottom after initial load (for refresh)
        setTimeout(() => {
            this.scrollToBottom(true);
        }, 100);

        // Auto-focus input field on startup
        this.elements.messageInput.focus();
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
            this.state.models = await openRouterAPI.fetchModels();
        } catch (error) {
            console.error('Failed to load models:', error);
            // Fallback models are already set in API
        }
        this.state.modelsLoading = false;
    }

    async loadFromDB() {
        // Load sessions (for display in sidebar)
        this.state.sessions = await chatDB.getAllSessions();

        // Migrate old sessions to add updatedAt if missing
        const sessionsToMigrate = this.state.sessions.filter(s => !s.updatedAt);
        if (sessionsToMigrate.length > 0) {
            for (const session of sessionsToMigrate) {
                session.updatedAt = session.createdAt;
                await chatDB.saveSession(session);
            }
        }

        // Don't restore currentSessionId - we always create a new session on startup
    }

    /**
     * Generates a unique ID for sessions and messages.
     * @returns {string} Unique ID
     */
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
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
     * Creates a new chat session.
     * @param {string} title - Session title
     * @returns {Promise<Object>} The created session
     */
    async createSession(title = 'New Chat') {
        const session = {
            id: this.generateId(),
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            model: this.state.pendingModel || null, // Use pending model if available
            apiKey: null,
            apiKeyInfo: null,
            expiresAt: null,
            searchEnabled: this.searchEnabled
        };

        // Clear pending model since it's now part of the session
        this.state.pendingModel = null;

        this.state.sessions.unshift(session);
        this.state.currentSessionId = session.id;

        this.chatInput.updateSearchToggleUI();

        await chatDB.saveSession(session);
        await chatDB.saveSetting('currentSessionId', session.id);

        // Hide message navigation immediately for new empty session
        if (this.messageNavigation) {
            this.messageNavigation.hide();
        }

        this.renderSessions();
        this.renderMessages();
        this.renderCurrentModel();

        // Update input state for new session
        this.updateInputState();

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
    switchSession(sessionId) {
        this.state.currentSessionId = sessionId;
        chatDB.saveSetting('currentSessionId', sessionId);

        // Keep current search state (global setting)
        const session = this.getCurrentSession();
        if (session) {
            this.chatInput.updateSearchToggleUI();
        }

        // Clear message navigation immediately before switching to prevent showing stale data
        if (this.messageNavigation) {
            this.messageNavigation.hide();
        }

        this.renderSessions();
        this.renderMessages();
        this.renderCurrentModel();

        // Update UI based on new session's streaming state
        this.updateInputState();

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
        return this.state.sessions.find(s => s.id === this.state.currentSessionId);
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
                abortController: null
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
    setSessionStreamingState(sessionId, isStreaming, abortController = null) {
        this.sessionStreamingStates.set(sessionId, {
            isStreaming,
            abortController
        });
        // Update UI when streaming state changes
        this.updateInputState();
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
     * Handles new chat request with validation (prevents empty duplicate sessions).
     */
    async handleNewChatRequest() {
        // Clear current session - no session is selected
        // The session will be created when the user sends their first message
        this.clearCurrentSession();

        // Close sidebar on mobile after creating new chat
        if (this.isMobileView()) {
            this.hideSidebar();
        }
    }

    /**
     * Clears the current session, returning to the startup state.
     * No session is selected until the user sends their first message.
     */
    clearCurrentSession() {
        this.state.currentSessionId = null;
        this.state.pendingModel = null; // Clear any pending model selection

        // Update UI to reflect no session selected
        this.renderSessions();
        this.renderMessages();
        this.renderCurrentModel();

        // Clear input
        if (this.elements.messageInput) {
            this.elements.messageInput.value = '';
        }

        // Update input state
        this.updateInputState();

        // Hide message navigation
        if (this.messageNavigation) {
            this.messageNavigation.hide();
        }

        // Clear right panel
        if (this.rightPanel) {
            this.rightPanel.onSessionChange(null);
        }
    }

    async updateSessionTitle(sessionId, title) {
        const session = this.state.sessions.find(s => s.id === sessionId);
        if (session) {
            session.title = title;
            session.updatedAt = Date.now();
            await chatDB.saveSession(session);
            this.renderSessions();
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
            searchEnabled: metadata.searchEnabled || false
        };

        await chatDB.saveMessage(message);

        // Update session's updatedAt timestamp
        session.updatedAt = Date.now();
        await chatDB.saveSession(session);

        // Auto-generate title from first user message
        if (role === 'user') {
            const messages = await chatDB.getSessionMessages(session.id);
            if (messages.length === 1) {
                const title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
                await this.updateSessionTitle(session.id, title);
            }
        }

        // Use incremental update instead of full re-render
        if (this.chatArea) {
            await this.chatArea.appendMessage(message);
        }
        this.renderSessions(); // Re-render sessions to update sorting
        return message;
    }

    /**
     * Sends a user message and streams the AI response.
     * Handles API key acquisition, model selection, and streaming updates.
     */
    async sendMessage() {
        // Check if there's content to send
        const content = this.elements.messageInput.value.trim();
        const hasFiles = this.uploadedFiles.length > 0;
        if (!content && !hasFiles) return;

        // Create session if none exists (first message creates the session)
        if (!this.getCurrentSession()) {
            await this.createSession();
        }

        let session = this.getCurrentSession();
        if (!session) return; // Safety check

        // Check if current session is already streaming
        const streamingState = this.getSessionStreamingState(session.id);
        if (streamingState.isStreaming) return;

        // Create abort controller for this stream
        const abortController = new AbortController();
        this.setSessionStreamingState(session.id, true, abortController);

        // Store current files and search state before clearing
        const currentFiles = [...this.uploadedFiles];
        const searchEnabled = this.searchEnabled;

        try {

            // Add user message with file metadata
            const metadata = {};
            if (hasFiles) {
                // Store file data for preview rendering
                const fileData = await Promise.all(currentFiles.map(async (file) => {
                    const dataUrl = await this.createImagePreview(file);
                    return {
                        name: file.name,
                        type: file.type,
                        size: file.size,
                        dataUrl: dataUrl
                    };
                }));
                metadata.files = fileData;
            }
            if (searchEnabled) {
                metadata.searchEnabled = true;
            }
            await this.addMessage('user', content || 'Please analyze these files:', metadata);

            // Clear input and files
            this.elements.messageInput.value = '';
            this.uploadedFiles = [];
            this.renderFilePreviews();
            this.updateFileCountBadge();
            this.updateInputState();
            this.elements.messageInput.style.height = '24px';

            // Automatically acquire API key if needed
            const isKeyExpired = session.expiresAt ? new Date(session.expiresAt) <= new Date() : true;
            if (!session.apiKey || isKeyExpired) {
                try {
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage('Acquiring API key...', 'info');
                    }
                    await this.acquireAndSetApiKey(session);
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage('Successfully acquired API key!', 'success', 2000);
                    }
                } catch (error) {
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage(error.message, 'error', 5000);
                    }
                    await this.addMessage('assistant', `**Error:** ${error.message}`);
                    return; // Return early if key acquisition fails
                }
            }

            // Set current session for network logging
            if (window.networkLogger) {
                window.networkLogger.setCurrentSession(session.id);
            }

            let modelNameToUse = session.model;

            if (!modelNameToUse) {
                const gpt5Model = this.state.models.find(m => m.name.toLowerCase().includes('gpt-5 chat'));
                if (gpt5Model) {
                    modelNameToUse = gpt5Model.name;
                } else {
                    const gpt4oModel = this.state.models.find(m => m.name.toLowerCase().includes('gpt-4o'));
                    if (gpt4oModel) {
                        modelNameToUse = gpt4oModel.name;
                    } else if (this.state.models.length > 0) {
                        modelNameToUse = this.state.models[0].name;
                    }
                }

                if (modelNameToUse) {
                    session.model = modelNameToUse;
                    await chatDB.saveSession(session);
                    this.renderCurrentModel();
                }
            }

            if (!modelNameToUse) {
                console.warn('No available models to send message.');
                await this.addMessage('assistant', 'No models are available right now. Please add a model and try again.');
                return; // Return early
            }

            let selectedModel = this.state.models.find(m => m.name === modelNameToUse);
            let modelId;

            if (selectedModel) {
                modelId = selectedModel.id;
            } else {
                // Fallback if model from session is somehow not in the list anymore
                modelId = 'openai/gpt-4o';
            }

            // Show typing indicator
            const typingId = this.showTypingIndicator(modelNameToUse);

            // Declare streaming message outside try block so it's accessible in catch
            let streamingMessage = null;

            try {
                // Get AI response from OpenRouter with streaming
                const messages = await chatDB.getSessionMessages(session.id);

                // Create a placeholder message for streaming
                const streamingMessageId = this.generateId();
                let streamedContent = '';
                let streamingTokenCount = 0;

                // Prepare assistant message object (don't save to DB yet - wait for first chunk)
                streamingMessage = {
                    id: streamingMessageId,
                    sessionId: session.id,
                    role: 'assistant',
                    content: '',
                    timestamp: Date.now(),
                    model: modelNameToUse,
                    tokenCount: null,
                    streamingTokens: 0
                };

                // Track progress for periodic saves
                let lastSaveLength = 0;
                const SAVE_INTERVAL_CHARS = 100; // Save every 100 characters
                let firstChunk = true;

                // Stream the response with token tracking
                const tokenData = await openRouterAPI.streamCompletion(
                    messages,
                    modelId,
                    session.apiKey,
                    async (chunk) => {
                        // Remove typing indicator on first chunk BEFORE adding content
                        if (firstChunk) {
                            this.removeTypingIndicator(typingId);
                            firstChunk = false;
                            // First add the chunk content
                            streamedContent += chunk;
                            // Update message with first chunk content before saving to DB
                            streamingMessage.content = streamedContent;
                            streamingMessage.streamingTokens = Math.ceil(streamedContent.length / 4);
                            // Save message to DB and append to UI on first chunk
                            await chatDB.saveMessage(streamingMessage);
                            if (this.chatArea) {
                                await this.chatArea.appendMessage(streamingMessage);
                            }
                        } else {
                            // Not first chunk - just accumulate content
                            streamedContent += chunk;
                        }

                        // Periodically save partial content to handle refresh during streaming
                        if (streamedContent.length - lastSaveLength >= SAVE_INTERVAL_CHARS) {
                            streamingMessage.content = streamedContent;
                            streamingMessage.streamingTokens = Math.ceil(streamedContent.length / 4);
                            await chatDB.saveMessage(streamingMessage);
                            lastSaveLength = streamedContent.length;
                        }

                        // Delegate to ChatArea for streaming message updates
                        if (this.chatArea) {
                            this.chatArea.updateStreamingMessage(streamingMessageId, streamedContent);
                        }
                    },
                    (tokenUpdate) => {
                        // Update streaming token count in real-time
                        streamingTokenCount = tokenUpdate.completionTokens || 0;
                        if (tokenUpdate.isStreaming && this.chatArea) {
                            this.chatArea.updateStreamingTokens(streamingMessageId, streamingTokenCount);
                        }
                    },
                    currentFiles,
                    searchEnabled,
                    abortController
                );

                // Save the final message content with token data
                streamingMessage.content = streamedContent;
                streamingMessage.tokenCount = tokenData.totalTokens || tokenData.completionTokens || streamingTokenCount;
                streamingMessage.model = tokenData.model || modelNameToUse;
                streamingMessage.streamingTokens = null; // Clear streaming tokens after completion
                await chatDB.saveMessage(streamingMessage);

                // Update final token count incrementally instead of full re-render
                if (this.chatArea && streamingMessage.tokenCount) {
                    this.chatArea.updateFinalTokens(streamingMessageId, streamingMessage.tokenCount);
                }

            } catch (error) {
                console.error('Error getting AI response:', error);
                this.removeTypingIndicator(typingId);

                // Check if error was due to cancellation
                if (error.isCancelled) {
                    // Keep the partial message if there's content, otherwise remove it
                    // Only handle if message was already added to UI (firstChunk was false)
                    if (streamingMessage && !firstChunk) {
                        if (streamedContent.trim()) {
                            // Save the partial content with a note
                            streamingMessage.content = streamedContent;
                            streamingMessage.tokenCount = null;
                            streamingMessage.streamingTokens = null;
                            await chatDB.saveMessage(streamingMessage);
                            // Update in place - the message is already visible, just update streaming status
                            if (this.chatArea) {
                                const messageEl = document.querySelector(`[data-message-id="${streamingMessage.id}"]`);
                                if (messageEl) {
                                    const tokenEl = messageEl.querySelector('.streaming-token-count');
                                    if (tokenEl) {
                                        tokenEl.remove(); // Remove streaming token indicator
                                    }
                                }
                            }
                        } else {
                            // Remove empty message if no content was generated
                            await chatDB.deleteMessage(streamingMessage.id);
                            const messageEl = document.querySelector(`[data-message-id="${streamingMessage.id}"]`);
                            if (messageEl) {
                                messageEl.remove();
                            }
                        }
                    }
                    // If firstChunk is still true, message was never added to UI or DB, nothing to clean up
                } else {
                    // Non-cancellation error
                    if (!firstChunk && streamingMessage) {
                        // Message was already added to UI, update it with error
                        streamingMessage.content = 'Sorry, I encountered an error while processing your request.';
                        streamingMessage.tokenCount = null;
                        streamingMessage.streamingTokens = null;
                        await chatDB.saveMessage(streamingMessage);
                        // Update message content in place
                        if (this.chatArea) {
                            this.chatArea.updateStreamingMessage(streamingMessage.id, streamingMessage.content);
                            const messageEl = document.querySelector(`[data-message-id="${streamingMessage.id}"]`);
                            if (messageEl) {
                                const tokenEl = messageEl.querySelector('.streaming-token-count');
                                if (tokenEl) {
                                    tokenEl.remove(); // Remove streaming token indicator
                                }
                            }
                        }
                    } else {
                        // Error before first chunk - message never added to UI, add new error message
                        await this.addMessage('assistant', 'Sorry, I encountered an error while processing your request.');
                    }
                }
            }
        } finally {
            // Clear streaming state for this session
            this.setSessionStreamingState(session.id, false, null);
            this.elements.messageInput.focus();
        }
    }

    /**
     * Shows a typing indicator at the bottom of the message list.
     * @param {string} modelName - Name of the model that's "typing"
     * @returns {string} ID of the typing indicator element
     */
    showTypingIndicator(modelName) {
        const model = this.state.models.find(m => m.name === modelName);
        const providerName = model ? model.provider : 'OpenAI';
        const id = 'typing-' + Date.now();
        const typingHtml = buildTypingIndicator(id, providerName);
        this.elements.messagesContainer.insertAdjacentHTML('beforeend', typingHtml);
        this.scrollToBottom(true);
        return id;
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
            this.state.sessions.splice(index, 1);

            // Delete from DB
            await chatDB.deleteSession(sessionId);
            await chatDB.deleteSessionMessages(sessionId);

            // Switch to another session if we deleted the current one
            if (this.state.currentSessionId === sessionId) {
                this.state.currentSessionId = this.state.sessions.length > 0 ? this.state.sessions[0].id : null;
                await chatDB.saveSetting('currentSessionId', this.state.currentSessionId);
            }

            this.renderSessions();
            this.renderMessages();

            // Create new session if none exist
            if (this.state.sessions.length === 0) {
                await this.createSession();
            }
        }
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

    /**
     * Filters sessions based on search query using fuzzy subsequence matching.
     * @returns {Array} Filtered sessions array
     */
    getFilteredSessions() {
        if (!this.sessionSearchQuery.trim()) {
            return this.state.sessions;
        }

        const query = this.sessionSearchQuery.toLowerCase();
        return this.state.sessions.filter(session => {
            const title = session.title.toLowerCase();
            return this.fuzzyMatch(query, title);
        });
    }

    /**
     * Performs fuzzy subsequence matching.
     * Returns true if all characters in query appear in text in order.
     * @param {string} query - Search query
     * @param {string} text - Text to search in
     * @returns {boolean} True if match found
     */
    fuzzyMatch(query, text) {
        let queryIndex = 0;
        let textIndex = 0;

        while (queryIndex < query.length && textIndex < text.length) {
            if (query[queryIndex] === text[textIndex]) {
                queryIndex++;
            }
            textIndex++;
        }

        return queryIndex === query.length;
    }

    /**
     * Renders the sessions list (delegated to Sidebar component).
     */
    renderSessions() {
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
    }

    /**
     * Renders all messages for the current session (delegated to ChatArea component).
     */
    async renderMessages() {
        if (this.chatArea) {
            await this.chatArea.render();
        }
    }


    hideSidebar() {
        const sidebar = this.elements.sidebar;
        const showBtn = this.elements.showSidebarBtn;
        const backdrop = this.elements.mobileSidebarBackdrop;

        if (sidebar) {
            // Use CSS class instead of inline styles
            sidebar.classList.add('sidebar-hidden');
            sidebar.classList.remove('mobile-visible');
        }
        if (showBtn) {
            showBtn.classList.remove('hidden');
            showBtn.classList.add('flex');
        }
        if (backdrop) {
            backdrop.classList.remove('visible');
        }
    }

    showSidebar() {
        const sidebar = this.elements.sidebar;
        const showBtn = this.elements.showSidebarBtn;
        const backdrop = this.elements.mobileSidebarBackdrop;

        if (sidebar) {
            // Use CSS class instead of inline styles
            sidebar.classList.remove('sidebar-hidden');
            if (this.isMobileView()) {
                sidebar.classList.add('mobile-visible');
            }
        }
        if (showBtn) {
            showBtn.classList.add('hidden');
            showBtn.classList.remove('flex');
        }
        // Show backdrop only on mobile
        if (backdrop && this.isMobileView()) {
            backdrop.classList.add('visible');
        }
    }

    isMobileView() {
        return window.innerWidth <= 768;
    }

    /**
     * Sets up all event listeners. Delegates component-specific listeners to respective components.
     */
    setupEventListeners() {
        // Delegate to components for their specific listeners
        if (this.chatInput) {
            this.chatInput.setupEventListeners();
        }
        if (this.modelPicker) {
            this.modelPicker.setupEventListeners();
        }

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

        // Show right panel button
        if (this.elements.showRightPanelBtn) {
            this.elements.showRightPanelBtn.addEventListener('click', () => {
                if (this.rightPanel) {
                    this.rightPanel.show();
                }
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
            });
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
                    this.modelPicker.open();
                }
            }

            // Cmd/Ctrl + Shift + F for search focus
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
                e.preventDefault();
                this.elements.searchRoomsInput?.focus();
            }

            // Cmd/Ctrl + Shift + Backspace for clear chat
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Backspace') {
                e.preventDefault();
                const session = this.getCurrentSession();
                if (session) {
                    chatDB.deleteSessionMessages(session.id);
                    this.renderMessages();
                }
            }

            // Escape to close modal
            if (e.key === 'Escape' && !this.elements.modelPickerModal.classList.contains('hidden')) {
                if (this.modelPicker) {
                    this.modelPicker.close();
                }
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
            if (!isInputFocused &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.altKey &&
                e.key.length === 1 &&
                this.elements.modelPickerModal.classList.contains('hidden')) {
                this.elements.messageInput.focus();
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
            // Change to stop icon
            this.elements.sendBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-3.5 h-3.5">
                    <rect x="6" y="6" width="12" height="12" rx="2" ry="2"/>
                </svg>
            `;
            // Change button style to indicate stop
            this.elements.sendBtn.classList.add('bg-destructive', 'hover:bg-destructive/90');
            this.elements.sendBtn.classList.remove('bg-primary', 'hover:bg-primary/90');
            this.elements.messageInput.placeholder = "Waiting for response...";
        } else {
            // Restore send icon
            this.elements.sendBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-3.5 h-3.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
                </svg>
            `;
            // Restore primary button style
            this.elements.sendBtn.classList.add('bg-primary', 'hover:bg-primary/90');
            this.elements.sendBtn.classList.remove('bg-destructive', 'hover:bg-destructive/90');

            if (this.searchEnabled) {
                // For now, use the same placeholder as the default when search is enabled
                this.elements.messageInput.placeholder = "Ask anonymously";
            } else {
                this.elements.messageInput.placeholder = "Ask anonymously";
            }
        }
    }

    async handleFileUpload(files) {
        const { validateFile } = await import('./services/fileUtils.js');

        const validFiles = [];
        const errors = [];

        for (const file of files) {
            const validation = validateFile(file);
            if (validation.valid) {
                validFiles.push(file);
            } else {
                errors.push(validation.error);
            }
        }

        if (validFiles.length > 0) {
            this.uploadedFiles.push(...validFiles);
            this.renderFilePreviews();
            this.updateFileCountBadge();
            this.updateInputState();
        }

        if (errors.length > 0) {
            this.showErrorNotification(errors.join('\n\n'));
        }
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
                    <div class="font-semibold text-sm mb-1">Upload Error</div>
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

    async renderFilePreviews() {
        const container = this.elements.filePreviewsContainer;
        if (this.uploadedFiles.length === 0) {
            container.classList.add('hidden');
            return;
        }

        container.classList.remove('hidden');

        // Generate previews with image and PDF thumbnails
        const previewPromises = this.uploadedFiles.map(async (file, index) => {
            const fileSize = this.formatFileSize(file.size);
            const isImage = file.type.startsWith('image/');
            const isPdf = file.type === 'application/pdf';

            let preview = '';
            if (isImage) {
                // Create image preview
                const imageUrl = await this.createImagePreview(file);
                preview = `
                    <img src="${imageUrl}" class="absolute inset-0 w-full h-full object-cover" alt="${file.name}">
                    <div class="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent"></div>
                `;
            } else if (isPdf) {
                // Create PDF preview
                const pdfUrl = await this.createImagePreview(file);
                preview = `
                    <div class="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-red-50 to-red-100 dark:from-red-900/20 dark:to-red-800/20">
                        <div class="flex flex-col items-center justify-center text-red-600 dark:text-red-400">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-12 h-12 mb-1">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                            </svg>
                            <span class="text-xs font-semibold">PDF</span>
                        </div>
                    </div>
                    <div class="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent"></div>
                `;
            } else {
                // Icon-based preview for other files
                const icon = this.getFileTypeIcon(file);
                preview = `
                    <div class="absolute inset-0 flex items-center justify-center bg-muted/50">
                        ${icon}
                    </div>
                `;
            }

            return `
                <div class="bg-background relative h-28 w-40 cursor-default select-none overflow-hidden rounded-xl border border-border shadow-md hover:shadow-lg transition-shadow">
                    ${preview}
                    <div class="absolute top-2 right-2 z-10">
                        <button class="flex items-center justify-center w-5 h-5 rounded-full bg-destructive/90 hover:bg-destructive text-white transition-colors shadow-sm" onclick="app.removeFile(${index})" title="Remove file">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    <div class="absolute bottom-0 left-0 right-0 p-2 ${isImage || isPdf ? 'text-white' : 'text-foreground'}">
                        <div class="text-xs font-medium truncate" title="${file.name}">
                            ${file.name}
                        </div>
                        <div class="text-xs ${isImage || isPdf ? 'text-white/80' : 'text-muted-foreground'}">
                            ${fileSize}
                        </div>
                    </div>
                </div>
            `;
        });

        const previews = await Promise.all(previewPromises);
        container.innerHTML = previews.join('');
    }

    createImagePreview(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.readAsDataURL(file);
        });
    }

    getFileTypeIcon(file) {
        const type = file.type;

        if (type.startsWith('image/')) {
            return `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-8 h-8 text-primary">
                    <path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                </svg>
            `;
        } else if (type === 'application/pdf') {
            return `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-8 h-8 text-destructive">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
            `;
        } else if (type.startsWith('audio/')) {
            return `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-8 h-8 text-green-600">
                    <path stroke-linecap="round" stroke-linejoin="round" d="m9 9 10.5-3m0 6.553v3.75a2.25 2.25 0 0 1-1.632 2.163l-1.32.377a1.803 1.803 0 1 1-.99-3.467l2.31-.66a2.25 2.25 0 0 0 1.632-2.163Zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 0 1-1.632 2.163l-1.32.377a1.803 1.803 0 0 1-.99-3.467l2.31-.66A2.25 2.25 0 0 0 9 15.553Z" />
                </svg>
            `;
        }
        return '';
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
        this.renderFilePreviews();
        this.updateFileCountBadge();
        this.updateInputState();
    }


    async acquireAndSetApiKey(session) {
        if (!session) throw new Error("No active session found.");

        const ticketCount = stationClient.getTicketCount();
        if (ticketCount === 0) {
            throw new Error("You have no inference tickets. Please open the right panel to register an invitation code and get tickets.");
        }

        // Set current session for network logging
        if (window.networkLogger) {
            window.networkLogger.setCurrentSession(session.id);
        }

        try {
            const result = await stationClient.requestApiKey();

            session.apiKey = result.key;
            session.apiKeyInfo = result;
            session.expiresAt = result.expires_at;

            await chatDB.saveSession(session);

            // Update the UI components
            if (this.rightPanel) {
                this.rightPanel.onSessionChange(session);
            }

            return result.key;
        } catch (error) {
            console.error('Failed to automatically acquire API key:', error);
            throw new Error(`A network error occurred while trying to get an API key: ${error.message}`);
        }
    }
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new ChatApp();
});

