// Main application logic
import RightPanel from './components/RightPanel.js';
import FloatingPanel from './components/FloatingPanel.js';
import MessageNavigation from './components/MessageNavigation.js';
import apiKeyStore from './services/apiKeyStore.js';
import themeManager from './services/themeManager.js';

class ChatApp {
    constructor() {
        this.state = {
            sessions: [],
            currentSessionId: null,
            models: [],
            modelsLoading: false
        };

        this.elements = {
            newChatBtn: document.getElementById('new-chat-btn'),
            sessionsList: document.getElementById('sessions-list'),
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
            toggleRightPanelBtn: document.getElementById('toggle-right-panel-btn'), // This might be legacy, but let's keep it for now.
            showRightPanelBtn: document.getElementById('show-right-panel-btn'),
            sidebar: document.getElementById('sidebar'),
            hideSidebarBtn: document.getElementById('hide-sidebar-btn'),
            showSidebarBtn: document.getElementById('show-sidebar-btn'),
            sessionsScrollArea: document.getElementById('sessions-scroll-area'),
            modelListScrollArea: document.getElementById('model-list-scroll-area'),
            themeOptionButtons: Array.from(document.querySelectorAll('[data-theme-option]')),
            themeEffectiveLabel: document.getElementById('theme-effective-label'),
            fileUploadBtn: document.getElementById('file-upload-btn'),
            fileUploadInput: document.getElementById('file-upload-input'),
            filePreviewsContainer: document.getElementById('file-previews-container'),
            fileCountBadge: document.getElementById('file-count-badge'),
        };

        themeManager.init();
        this.updateThemeControls(themeManager.getPreference(), themeManager.getEffectiveTheme());
        this.themeUnsubscribe = themeManager.onChange((preference, effectiveTheme) => {
            this.updateThemeControls(preference, effectiveTheme);
        });

        this.searchEnabled = false;
        this.uploadedFiles = [];
        this.rightPanel = null;
        this.floatingPanel = null;
        this.messageNavigation = null;
        this.isWaitingForResponse = false;

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

    async init() {
        // Initialize IndexedDB
        await chatDB.init();

        // Initialize right panel with app context
        this.rightPanel = new RightPanel(this);
        this.rightPanel.mount();

        // Initialize floating panel
        this.floatingPanel = new FloatingPanel(this);

        // Initialize message navigation
        this.messageNavigation = new MessageNavigation(this);

        // Load data from IndexedDB FIRST (to get session)
        await this.loadFromDB();

        // Create initial session if none exist
        if (this.state.sessions.length === 0) {
            await this.createSession();
        }

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

        // Restore search state from current session
        if (currentSession) {
            this.searchEnabled = currentSession.searchEnabled || false;
            this.updateSearchToggle();
        }

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

        // Scroll to bottom after initial load (for refresh)
        setTimeout(() => {
            this.scrollToBottom(true);
        }, 100);
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
        // Load sessions
        this.state.sessions = await chatDB.getAllSessions();

        // Migrate old sessions to add updatedAt if missing
        const sessionsToMigrate = this.state.sessions.filter(s => !s.updatedAt);
        if (sessionsToMigrate.length > 0) {
            for (const session of sessionsToMigrate) {
                session.updatedAt = session.createdAt;
                await chatDB.saveSession(session);
            }
        }

        // Load current session
        const currentId = await chatDB.getSetting('currentSessionId');
        if (currentId && this.state.sessions.find(s => s.id === currentId)) {
            this.state.currentSessionId = currentId;
        } else if (this.state.sessions.length > 0) {
            this.state.currentSessionId = this.state.sessions[0].id;
        }
    }

    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    formatTime(timestamp) {
        const messageTime = new Date(timestamp);
        return messageTime.toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    async createSession(title = 'New Chat') {
        const session = {
            id: this.generateId(),
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            model: null,
            apiKey: null,
            apiKeyInfo: null,
            expiresAt: null,
            searchEnabled: false
        };

        this.state.sessions.unshift(session);
        this.state.currentSessionId = session.id;

        // Reset search toggle for new session
        this.searchEnabled = false;
        this.updateSearchToggle();

        await chatDB.saveSession(session);
        await chatDB.saveSetting('currentSessionId', session.id);

        this.renderSessions();
        this.renderMessages();
        this.renderCurrentModel();

        // Notify right panel of session change
        if (this.rightPanel) {
            this.rightPanel.onSessionChange(session);
        }

        return session;
    }

    switchSession(sessionId) {
        this.state.currentSessionId = sessionId;
        chatDB.saveSetting('currentSessionId', sessionId);

        // Load session-specific search state
        const session = this.getCurrentSession();
        if (session) {
            this.searchEnabled = session.searchEnabled || false;
            this.updateSearchToggle();
        }

        this.renderSessions();
        this.renderMessages();
        this.renderCurrentModel();

        // Notify right panel of session change
        if (this.rightPanel && session) {
            this.rightPanel.onSessionChange(session);
        }
        if (this.floatingPanel && session) {
            this.floatingPanel.render();
        }
    }

    getCurrentSession() {
        return this.state.sessions.find(s => s.id === this.state.currentSessionId);
    }

    async handleNewChatRequest() {
        const current = this.getCurrentSession();
        if (current) {
            const messages = await chatDB.getSessionMessages(current.id);
            const isEmptyNoKey = messages.length === 0 && !current.apiKey;
            if (isEmptyNoKey) {
                if (this.floatingPanel) {
                    this.floatingPanel.showMessage(
                        "You're already in a new chat. Send a message or acquire a key first.",
                        'plain',
                        3000
                    );
                }
                return; // Block creating another new session
            }
        }
        await this.createSession();
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

        this.renderMessages();
        this.renderSessions(); // Re-render sessions to update sorting
        return message;
    }

    async sendMessage() {
        if (this.isWaitingForResponse) return;

        const content = this.elements.messageInput.value.trim();
        const hasFiles = this.uploadedFiles.length > 0;
        if (!content && !hasFiles) return;

        this.isWaitingForResponse = true;
        this.updateInputState();

        // Store current files and search state before clearing
        const currentFiles = [...this.uploadedFiles];
        const searchEnabled = this.searchEnabled;

        try {
            // Create session if none exists
            if (!this.getCurrentSession()) {
                await this.createSession();
            }

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

            let session = this.getCurrentSession();

            // Automatically acquire API key if needed
            const isKeyExpired = session.expiresAt ? new Date(session.expiresAt) <= new Date() : true;
            if (!session.apiKey || isKeyExpired) {
                try {
                    this.floatingPanel.showMessage('Acquiring API key...', 'info');
                    await this.acquireAndSetApiKey(session);
                    this.floatingPanel.showMessage('Successfully acquired API key!', 'success', 2000);
                } catch (error) {
                    this.floatingPanel.showMessage(error.message, 'error', 5000);
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

            try {
                // Get AI response from OpenRouter with streaming
                const messages = await chatDB.getSessionMessages(session.id);

                // Create a placeholder message for streaming
                const streamingMessageId = this.generateId();
                let streamedContent = '';
                let streamingTokenCount = 0;

                // Add empty assistant message that we'll update
                const streamingMessage = {
                    id: streamingMessageId,
                    sessionId: session.id,
                    role: 'assistant',
                    content: '',
                    timestamp: Date.now(),
                    model: modelNameToUse,
                    tokenCount: null,
                    streamingTokens: 0
                };
                await chatDB.saveMessage(streamingMessage);

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
                        // Remove typing indicator on first chunk
                        if (firstChunk) {
                            this.removeTypingIndicator(typingId);
                            await this.renderMessages();
                            firstChunk = false;
                        }

                        streamedContent += chunk;

                        // Periodically save partial content to handle refresh during streaming
                        if (streamedContent.length - lastSaveLength >= SAVE_INTERVAL_CHARS) {
                            streamingMessage.content = streamedContent;
                            streamingMessage.streamingTokens = Math.ceil(streamedContent.length / 4);
                            await chatDB.saveMessage(streamingMessage);
                            lastSaveLength = streamedContent.length;
                        }

                        // Update the message content in real-time
                        const messageEl = document.querySelector(`[data-message-id="${streamingMessageId}"]`);
                        if (messageEl) {
                            const contentEl = messageEl.querySelector('.message-content');
                            if (contentEl) {
                                // Use our LaTeX-safe processor
                                contentEl.innerHTML = this.processContentWithLatex(streamedContent);
                                // Re-render LaTeX for the updated content
                                if (typeof renderMathInElement !== 'undefined') {
                                    renderMathInElement(contentEl, {
                                        delimiters: [
                                            {left: '$$', right: '$$', display: true},
                                            {left: '\\[', right: '\\]', display: true},
                                            {left: '\\(', right: '\\)', display: false},
                                            {left: '$', right: '$', display: false}
                                        ],
                                        throwOnError: false,
                                        errorColor: '#cc0000',
                                        strict: false
                                    });
                                }
                            }
                        }
                        // Auto-scroll if user is already at bottom
                        this.scrollToBottom();
                    },
                    (tokenUpdate) => {
                        // Update streaming token count in real-time
                        streamingTokenCount = tokenUpdate.completionTokens || 0;
                        const messageEl = document.querySelector(`[data-message-id="${streamingMessageId}"]`);
                        if (messageEl && tokenUpdate.isStreaming) {
                            const tokenEl = messageEl.querySelector('.streaming-token-count');
                            if (tokenEl) {
                                tokenEl.textContent = streamingTokenCount;
                            }
                        }
                    },
                    currentFiles,
                    searchEnabled
                );

                // Save the final message content with token data
                streamingMessage.content = streamedContent;
                streamingMessage.tokenCount = tokenData.totalTokens || tokenData.completionTokens || streamingTokenCount;
                streamingMessage.model = tokenData.model || modelNameToUse;
                streamingMessage.streamingTokens = null; // Clear streaming tokens after completion
                await chatDB.saveMessage(streamingMessage);

                // Re-render to show final token count
                this.renderMessages();

            } catch (error) {
                console.error('Error getting AI response:', error);
                await this.addMessage('assistant', 'Sorry, I encountered an error while processing your request.');
                this.removeTypingIndicator(typingId);
            }
        } finally {
            this.isWaitingForResponse = false;
            this.updateInputState();
            this.elements.messageInput.focus();
        }
    }

    showTypingIndicator(modelName) {
        const model = this.state.models.find(m => m.name === modelName);
        const providerInitial = model ? model.provider.charAt(0) : 'A';
        const id = 'typing-' + Date.now();
        const typingHtml = `
            <div id="${id}" class="w-full px-2 md:px-3 fade-in">
                <div class="flex items-center gap-2">
                    <div class="flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full border border-border/50 shadow bg-muted p-0.5">
                        <span class="text-xs font-semibold">${providerInitial}</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <div class="flex gap-1">
                            <div class="w-2 h-2 bg-primary rounded-full animate-bounce" style="animation-delay: 0s"></div>
                            <div class="w-2 h-2 bg-primary rounded-full animate-bounce" style="animation-delay: 0.15s"></div>
                            <div class="w-2 h-2 bg-primary rounded-full animate-bounce" style="animation-delay: 0.3s"></div>
                        </div>
                        <span class="text-sm text-muted-foreground animate-pulse">
                            Processing...
                        </span>
                    </div>
                </div>
            </div>
        `;
        this.elements.messagesContainer.insertAdjacentHTML('beforeend', typingHtml);
        this.scrollToBottom(true);
        return id;
    }

    removeTypingIndicator(id) {
        const indicator = document.getElementById(id);
        if (indicator) {
            indicator.remove();
        }
    }

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

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    getSessionDateGroup(timestamp) {
        const now = new Date();
        const sessionDate = new Date(timestamp);

        const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const sessionDay = new Date(sessionDate.getFullYear(), sessionDate.getMonth(), sessionDate.getDate());
        const diffDays = Math.floor((nowDay - sessionDay) / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'TODAY';
        if (diffDays === 1) return 'YESTERDAY';
        if (diffDays <= 7) return 'PREVIOUS 7 DAYS';
        if (diffDays <= 30) return 'PREVIOUS 30 DAYS';
        return 'OLDER';
    }

    renderSessions() {
        // Group sessions by date (using updatedAt so active sessions move to TODAY)
        const grouped = {};
        const groupOrder = ['TODAY', 'YESTERDAY', 'PREVIOUS 7 DAYS', 'PREVIOUS 30 DAYS', 'OLDER'];

        this.state.sessions.forEach(session => {
            // Use updatedAt if available, otherwise fall back to createdAt
            const timestamp = session.updatedAt || session.createdAt;
            const group = this.getSessionDateGroup(timestamp);
            if (!grouped[group]) {
                grouped[group] = [];
            }
            grouped[group].push(session);
        });

        // Sort sessions within each group by updatedAt (most recent first)
        Object.keys(grouped).forEach(groupName => {
            grouped[groupName].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
        });

        // Render grouped sessions
        const html = groupOrder.map(groupName => {
            const sessions = grouped[groupName];
            if (!sessions || sessions.length === 0) return '';

            return `
                <div class="mb-3">
                    <div class="model-category-header px-3 flex items-center h-9">${groupName}</div>
                    ${sessions.map(session => `
                        <div class="group relative flex h-9 items-center rounded-lg ${session.id === this.state.currentSessionId ? 'chat-session active' : 'hover:bg-accent/30'} transition-colors pl-3 chat-session" data-session-id="${session.id}">
                            <a class="flex flex-1 items-center justify-between h-full min-w-0 text-foreground hover:text-foreground cursor-pointer">
                                <div class="flex min-w-0 flex-1 items-center">
                                    <input class="w-full cursor-pointer truncate bg-transparent text-sm leading-5 focus:outline-none text-foreground ${session.title === 'New Chat' ? 'italic text-muted-foreground' : ''}" placeholder="Untitled Chat" readonly value="${session.title}">
                                </div>
                            </a>
                            <div class="flex shrink-0 items-center relative">
                                <button class="session-menu-btn inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 gap-2 leading-6 text-muted-foreground hover:bg-accent hover:text-accent-foreground border border-transparent h-9 w-9 group-hover:opacity-100 md:opacity-0" aria-label="Session options" data-session-id="${session.id}">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
                                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
                                    </svg>
                                </button>
                                <div class="session-menu hidden absolute right-0 top-10 z-[100] rounded-lg border border-border bg-popover shadow-lg p-1 min-w-[140px]" data-session-id="${session.id}">
                                    <button class="delete-session-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover:bg-accent/30 hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">Delete</button>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }).join('');

        this.elements.sessionsList.innerHTML = html;

        // Add click handlers
        document.querySelectorAll('.chat-session').forEach(el => {
            el.addEventListener('click', (e) => {
                if (!e.target.closest('.session-menu-btn') && !e.target.closest('.session-menu')) {
                    this.switchSession(el.dataset.sessionId);
                }
            });
        });

        // Session menu toggle
        document.querySelectorAll('.session-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sessionId = btn.dataset.sessionId;
                const menu = document.querySelector(`.session-menu[data-session-id="${sessionId}"]`);

                // Close all other session menus
                document.querySelectorAll('.session-menu').forEach(m => {
                    if (m !== menu) m.classList.add('hidden');
                });

                menu.classList.toggle('hidden');
            });
        });

        // Delete session action
        document.querySelectorAll('.delete-session-action').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sessionId = btn.dataset.sessionId;
                this.deleteSession(sessionId);
                // Menu will be removed when sessions are re-rendered
            });
        });
    }

    renderCurrentModel() {
        const session = this.getCurrentSession();
        const modelName = session ? session.model : null;

        if (modelName) {
            const model = this.state.models.find(m => m.name === modelName);
            const providerInitial = model ? model.provider.charAt(0) : '';
            this.elements.modelPickerBtn.innerHTML = `
                <div class="flex items-center justify-center w-5 h-5 flex-shrink-0 rounded-full border border-border/50 bg-muted">
                    <span class="text-[10px] font-semibold">${providerInitial}</span>
                </div>
                <span class="truncate">${modelName}</span>
            `;
            this.elements.modelPickerBtn.classList.add('gap-1.5');
        } else {
            const shortcutHtml = `
                <div class="flex items-center gap-0.5 ml-2">
                    <kbd class="flex items-center justify-center h-4 w-4 p-1 rounded-sm bg-muted border border-border text-foreground text-xs">⌘</kbd>
                    <kbd class="flex items-center justify-center h-4 w-4 p-1 rounded-sm bg-muted border border-border text-foreground text-xs">K</kbd>
                </div>
            `;
            this.elements.modelPickerBtn.innerHTML = `
                <span>Select Model</span>
                ${shortcutHtml}
            `;
            this.elements.modelPickerBtn.classList.remove('gap-1.5');
        }
    }

    async renderMessages() {
        const session = this.getCurrentSession();
        if (!session) {
            this.elements.messagesContainer.innerHTML = `
                <div class="text-center text-muted-foreground mt-20">
                    <p class="text-lg">Ask anonymously</p>
                    <p class="text-sm mt-2">Type a message below to get started</p>
                </div>
            `;
            return;
        }

        // Load messages from IndexedDB
        const messages = await chatDB.getSessionMessages(session.id);

        if (messages.length === 0) {
            this.elements.messagesContainer.innerHTML = `
                <div class="text-center text-muted-foreground mt-20">
                    <p class="text-lg">Ask anonymously</p>
                    <p class="text-sm mt-2">Type a message below to get started</p>
                </div>
            `;
            return;
        }

        this.elements.messagesContainer.innerHTML = messages.map(message => {
            if (message.role === 'user') {
                // Check for file attachments
                const hasFiles = message.files && message.files.length > 0;

                const filePreview = hasFiles ? `
                    <div class="flex flex-wrap gap-2 mt-3">
                        ${message.files.map(fileData => {
                            // Handle both old format (string) and new format (object)
                            const fileName = typeof fileData === 'string' ? fileData : fileData.name;
                            const fileType = typeof fileData === 'string' ? '' : fileData.type;
                            const dataUrl = typeof fileData === 'string' ? null : fileData.dataUrl;

                            const isPdf = fileType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
                            const isImage = fileType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp)$/i.test(fileName);
                            const isAudio = fileType.startsWith('audio/') || /\.(wav|mp3|ogg|webm)$/i.test(fileName);

                            if (isPdf) {
                                return `
                                    <div class="bg-background relative h-32 w-48 cursor-pointer select-none overflow-hidden rounded-lg border border-border shadow-sm hover:shadow-md transition-shadow">
                                        <div class="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-red-50 to-red-100 dark:from-red-900/20 dark:to-red-800/20">
                                            <div class="flex flex-col items-center justify-center text-red-600 dark:text-red-400">
                                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-10 h-10 mb-1">
                                                    <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                                                </svg>
                                                <span class="text-xs font-semibold">PDF</span>
                                            </div>
                                        </div>
                                        <div class="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/60 to-transparent">
                                            <div class="text-xs font-medium text-white truncate" title="${fileName}">
                                                ${fileName}
                                            </div>
                                        </div>
                                    </div>
                                `;
                            } else if (isImage && dataUrl) {
                                return `
                                    <div class="bg-background relative h-32 w-48 cursor-pointer select-none overflow-hidden rounded-lg border border-border shadow-sm hover:shadow-md transition-shadow">
                                        <img src="${dataUrl}" class="absolute inset-0 w-full h-full object-cover" alt="${fileName}">
                                        <div class="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent"></div>
                                        <div class="absolute bottom-0 left-0 right-0 p-2">
                                            <div class="text-xs font-medium text-white truncate" title="${fileName}">
                                                ${fileName}
                                            </div>
                                        </div>
                                    </div>
                                `;
                            } else if (isImage) {
                                // Fallback for old messages without dataUrl
                                return `
                                    <div class="bg-background relative h-32 w-48 cursor-pointer select-none overflow-hidden rounded-lg border border-border shadow-sm hover:shadow-md transition-shadow">
                                        <div class="p-3 h-full flex flex-col">
                                            <div class="flex items-center gap-2 mb-2">
                                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4 text-primary flex-shrink-0">
                                                    <path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                                                </svg>
                                                <span class="font-medium text-foreground text-xs truncate">${fileName}</span>
                                            </div>
                                            <div class="text-muted-foreground text-xs leading-relaxed">
                                                Image
                                            </div>
                                        </div>
                                    </div>
                                `;
                            } else if (isAudio) {
                                return `
                                    <div class="bg-background relative h-32 w-48 cursor-pointer select-none overflow-hidden rounded-lg border border-border text-xs shadow-sm hover:shadow-md transition-shadow">
                                        <div class="p-3 h-full flex flex-col">
                                            <div class="flex items-center gap-2 mb-2">
                                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4 text-green-600 flex-shrink-0">
                                                    <path stroke-linecap="round" stroke-linejoin="round" d="m9 9 10.5-3m0 6.553v3.75a2.25 2.25 0 0 1-1.632 2.163l-1.32.377a1.803 1.803 0 1 1-.99-3.467l2.31-.66a2.25 2.25 0 0 0 1.632-2.163Zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 0 1-1.632 2.163l-1.32.377a1.803 1.803 0 0 1-.99-3.467l2.31-.66A2.25 2.25 0 0 0 9 15.553Z" />
                                                </svg>
                                                <span class="font-medium text-foreground truncate">${fileName}</span>
                                            </div>
                                            <div class="text-muted-foreground leading-relaxed">
                                                Audio File
                                            </div>
                                        </div>
                                    </div>
                                `;
                            } else {
                                return `
                                    <div class="bg-background relative h-32 w-48 cursor-pointer select-none overflow-hidden rounded-lg border border-border text-xs shadow-sm hover:shadow-md transition-shadow">
                                        <div class="p-3 h-full flex flex-col">
                                            <div class="flex items-center gap-2 mb-2">
                                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4 text-muted-foreground flex-shrink-0">
                                                    <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                                                </svg>
                                                <span class="font-medium text-foreground truncate">${fileName}</span>
                                            </div>
                                            <div class="text-muted-foreground leading-relaxed">
                                                File
                                            </div>
                                        </div>
                                    </div>
                                `;
                            }
                        }).join('')}
                    </div>
                ` : '';

                return `
                    <div class="w-full px-2 md:px-3 fade-in self-end" data-message-id="${message.id}">
                        <div class="group my-2 flex w-full flex-col gap-2 justify-end items-end">
                            ${filePreview}
                            <div class="py-3 px-4 font-normal rounded-lg message-user max-w-full">
                                <div class="min-w-0 w-full overflow-hidden break-words">
                                    <p class="mb-0">${this.escapeHtml(message.content)}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                const session = this.getCurrentSession();
                // Use the model from the session for displaying the message bubble info
                const modelName = session ? session.model : 'GPT-5 Chat';
                const model = this.state.models.find(m => m.name === modelName);
                const providerInitial = model ? model.provider.charAt(0) : 'A';

                // Display token count if available
                const tokenDisplay = message.tokenCount
                    ? `<span class="text-xs text-muted-foreground ml-auto" style="font-size: 0.7rem;">${message.tokenCount}</span>`
                    : (message.streamingTokens !== null && message.streamingTokens !== undefined
                        ? `<span class="text-xs text-muted-foreground ml-auto streaming-token-count" style="font-size: 0.7rem;">${message.streamingTokens}</span>`
                        : '');

                return `
                    <div class="w-full px-2 md:px-3 fade-in self-start" data-message-id="${message.id}">
                        <div class="group flex w-full flex-col items-start justify-start gap-2">
                            <div class="flex w-full items-center justify-start gap-2">
                                <div class="flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full border border-border/50 shadow bg-muted">
                                    <span class="text-xs font-semibold text-foreground">${providerInitial}</span>
                                </div>
                                <span class="text-xs text-foreground font-medium" style="font-size: 0.7rem;">${modelName}</span>
                                <span class="text-xs text-muted-foreground" style="font-size: 0.7rem;">${this.formatTime(message.timestamp)}</span>
                                ${tokenDisplay}
                            </div>
                            <div class="py-3 px-4 font-normal rounded-lg message-assistant w-full flex items-center">
                                <div class="min-w-0 w-full overflow-hidden message-content prose">
                                    ${this.processContentWithLatex(message.content || '')}
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }
        }).join('');

        // Render LaTeX
        if (typeof renderMathInElement !== 'undefined') {
            document.querySelectorAll('.message-content').forEach(el => {
                renderMathInElement(el, {
                    delimiters: [
                        {left: '$$', right: '$$', display: true},
                        {left: '\\[', right: '\\]', display: true},
                        {left: '\\(', right: '\\)', display: false},
                        {left: '$', right: '$', display: false}
                    ],
                    throwOnError: false,
                    errorColor: '#cc0000',
                    strict: false
                });
            });
        }

        // Scroll to bottom after rendering is complete
        this.scrollToBottom(true);

        // Update message navigation if it exists
        if (this.messageNavigation) {
            this.messageNavigation.update();
        }
    }

    filterModels(searchTerm = '') {
        const term = searchTerm.toLowerCase();
        if (!term) return this.state.models;

        return this.state.models.filter(model =>
            model.name.toLowerCase().includes(term) ||
            model.provider.toLowerCase().includes(term) ||
            model.category.toLowerCase().includes(term)
        );
    }

    renderModels(searchTerm = '') {
        const filteredModels = this.filterModels(searchTerm);
        const categories = [...new Set(filteredModels.map(m => m.category))];

        this.elements.modelsList.innerHTML = categories.map(category => `
            <div class="mb-3">
                <div class="model-category-header px-2 py-1 text-xs font-medium text-muted-foreground">${category}</div>
                <div class="space-y-0">
                    ${filteredModels
                        .filter(m => m.category === category)
                        .map(model => {
                            const session = this.getCurrentSession();
                            const isSelected = session && session.model === model.name;
                            return `
                                <div class="model-option px-2 py-1.5 rounded-sm cursor-pointer transition-colors hover:bg-accent ${isSelected ? 'bg-accent' : ''}" data-model="${model.name}">
                                    <div class="flex items-center gap-2">
                                        <div class="flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full border border-border/50 bg-muted">
                                            <span class="text-[10px] font-semibold">${model.provider.charAt(0)}</span>
                                        </div>
                                        <div class="flex-1 min-w-0">
                                            <div class="font-medium text-sm text-foreground truncate">${model.name}</div>
                                        </div>
                                        ${isSelected ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4 text-primary flex-shrink-0"><path fill-rule="evenodd" d="M19.916 4.626a.75.75 0 0 1 .208 1.04l-9 13.5a.75.75 0 0 1-1.154.114l-6-6a.75.75 0 0 1 1.06-1.06l5.353 5.353 8.493-12.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd" /></svg>' : ''}
                                    </div>
                                </div>
                            `;
                        }).join('')}
                </div>
            </div>
        `).join('');

        // Add click handlers
        document.querySelectorAll('.model-option').forEach(el => {
            el.addEventListener('click', () => {
                this.selectModel(el.dataset.model);
            });
        });
    }

    async selectModel(modelName) {
        const session = this.getCurrentSession();
        if (session) {
            session.model = modelName;
            await chatDB.saveSession(session);
            this.renderCurrentModel();
            this.closeModelPicker();
        }
    }

    openModelPicker() {
        this.elements.modelPickerModal.classList.remove('hidden');
        this.renderModels();
        // Focus search input
        setTimeout(() => {
            this.elements.modelSearch.focus();
        }, 100);
    }

    closeModelPicker() {
        this.elements.modelPickerModal.classList.add('hidden');
        // Clear search
        this.elements.modelSearch.value = '';
    }

    hideSidebar() {
        if (this.elements.sidebar) {
            this.elements.sidebar.classList.add('hidden');
            this.elements.sidebar.classList.remove('md:flex');
        }
        if (this.elements.showSidebarBtn) {
            this.elements.showSidebarBtn.classList.remove('hidden');
            this.elements.showSidebarBtn.classList.add('flex');
        }
    }

    showSidebar() {
        if (this.elements.sidebar) {
            this.elements.sidebar.classList.remove('hidden');
            this.elements.sidebar.classList.add('md:flex');
        }
        if (this.elements.showSidebarBtn) {
            this.elements.showSidebarBtn.classList.add('hidden');
            this.elements.showSidebarBtn.classList.remove('flex');
        }
    }

    setupEventListeners() {
        this.setupThemeControls();

        // New chat button
        this.elements.newChatBtn.addEventListener('click', () => {
            this.handleNewChatRequest();
        });

        // Auto-resize textarea
        this.elements.messageInput.addEventListener('input', () => {
            this.elements.messageInput.style.height = '24px';
            this.elements.messageInput.style.height = Math.min(this.elements.messageInput.scrollHeight, 384) + 'px';
            this.updateInputState();
        });

        // Send on Enter
        this.elements.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!this.elements.sendBtn.disabled) {
                    this.sendMessage();
                }
            }
        });

        // Send button
        this.elements.sendBtn.addEventListener('click', () => {
            this.sendMessage();
        });

        // Model picker
        this.elements.modelPickerBtn.addEventListener('click', () => {
            this.openModelPicker();
        });

        this.elements.closeModalBtn.addEventListener('click', () => {
            this.closeModelPicker();
        });

        // Close modal on backdrop click
        this.elements.modelPickerModal.addEventListener('click', (e) => {
            if (e.target === this.elements.modelPickerModal) {
                this.closeModelPicker();
            }
        });

        // Model search
        this.elements.modelSearch.addEventListener('input', (e) => {
            this.renderModels(e.target.value);
        });

        // Settings menu toggle
        this.elements.settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.elements.settingsMenu.classList.toggle('hidden');
        });

        this.elements.settingsMenu.addEventListener('click', async (e) => {
            if (e.target.tagName === 'BUTTON') {
                const action = e.target.textContent.trim();
                if (action === 'Clear Models') {
                    const session = this.getCurrentSession();
                    if (session) {
                        session.model = null;
                        await chatDB.saveSession(session);
                        this.renderCurrentModel();
                    }
                }
                this.elements.settingsMenu.classList.add('hidden');
            }
        });

        // Close settings menu and session menus when clicking outside
        document.addEventListener('click', () => {
            if (!this.elements.settingsMenu.classList.contains('hidden')) {
                this.elements.settingsMenu.classList.add('hidden');
            }
            // Close all session menus
            document.querySelectorAll('.session-menu').forEach(menu => {
                menu.classList.add('hidden');
            });
        });

        // Clear chat functionality
        this.elements.clearChatBtn.addEventListener('click', async () => {
            const session = this.getCurrentSession();
            if (session) {
                await chatDB.deleteSessionMessages(session.id);
                this.renderMessages();
                this.elements.settingsMenu.classList.add('hidden');
            }
        });

        // Search toggle functionality
        this.elements.searchToggle.addEventListener('click', async () => {
            this.searchEnabled = !this.searchEnabled;
            this.elements.searchSwitch.setAttribute('aria-checked', this.searchEnabled);

            const thumb = this.elements.searchSwitch.querySelector('.search-switch-thumb');
            if (this.searchEnabled) {
                this.elements.searchSwitch.classList.remove('bg-muted', 'hover:bg-muted/80');
                this.elements.searchSwitch.classList.add('search-switch-active');
                thumb.classList.remove('translate-x-[2px]', 'bg-background/80');
                thumb.classList.add('translate-x-[19px]', 'search-switch-thumb-active');
            } else {
                this.elements.searchSwitch.classList.remove('search-switch-active');
                this.elements.searchSwitch.classList.add('bg-muted', 'hover:bg-muted/80');
                thumb.classList.remove('translate-x-[19px]', 'search-switch-thumb-active');
                thumb.classList.add('translate-x-[2px]', 'bg-background/80');
            }

            // Save to current session
            const session = this.getCurrentSession();
            if (session) {
                session.searchEnabled = this.searchEnabled;
                await chatDB.saveSession(session);
            }
            this.updateInputState();
        });

        // File upload button
        if (this.elements.fileUploadBtn && this.elements.fileUploadInput) {
            this.elements.fileUploadBtn.addEventListener('click', () => {
                this.elements.fileUploadInput.click();
            });

            this.elements.fileUploadInput.addEventListener('change', async (e) => {
                const files = Array.from(e.target.files);
                await this.handleFileUpload(files);
                e.target.value = ''; // Reset input
            });
        }

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
                this.openModelPicker();
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
                this.closeModelPicker();
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

            // Auto-focus message input when typing
            const activeElement = document.activeElement;
            const isInputFocused = activeElement && (
                activeElement.tagName === 'INPUT' ||
                activeElement.tagName === 'TEXTAREA' ||
                activeElement.isContentEditable
            );

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

    setupThemeControls() {
        if (!this.elements.themeOptionButtons || this.elements.themeOptionButtons.length === 0) {
            return;
        }

        this.elements.themeOptionButtons.forEach((button) => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();

                const preference = button.dataset.themeOption || 'system';
                themeManager.setPreference(preference);

                if (this.elements.settingsMenu) {
                    this.elements.settingsMenu.classList.add('hidden');
                }
                document.querySelectorAll('.session-menu').forEach(menu => {
                    menu.classList.add('hidden');
                });
            });
        });
    }

    updateThemeControls(preference, effectiveTheme) {
        if (this.elements.themeOptionButtons && this.elements.themeOptionButtons.length > 0) {
            this.elements.themeOptionButtons.forEach((button) => {
                const option = button.dataset.themeOption;
                const isActive = option === preference;

                button.classList.toggle('theme-option-active', isActive);
                button.setAttribute('aria-checked', String(isActive));

                const checkIcon = button.querySelector('.theme-option-check');
                if (checkIcon) {
                    checkIcon.classList.toggle('opacity-100', isActive);
                    checkIcon.classList.toggle('opacity-0', !isActive);
                }
            });
        }

        if (this.elements.themeEffectiveLabel) {
            if (preference === 'system') {
                this.elements.themeEffectiveLabel.textContent = `Follows system appearance (${this.formatThemeName(effectiveTheme)})`;
            } else {
                this.elements.themeEffectiveLabel.textContent = `Using ${this.formatThemeName(preference)} theme`;
            }
        }
    }

    formatThemeName(theme) {
        if (!theme) return '';
        return theme.charAt(0).toUpperCase() + theme.slice(1);
    }

    updateInputState() {
        const hasContent = this.elements.messageInput.value.trim() || this.uploadedFiles.length > 0;
        const shouldBeDisabled = !hasContent || this.isWaitingForResponse;

        this.elements.messageInput.disabled = this.isWaitingForResponse;
        this.elements.sendBtn.disabled = shouldBeDisabled;

        this.elements.sendBtn.classList.toggle('opacity-40', shouldBeDisabled);
        this.elements.sendBtn.classList.toggle('opacity-100', !shouldBeDisabled);

        if (this.isWaitingForResponse) {
            this.elements.messageInput.placeholder = "Waiting for response...";
        } else if (this.searchEnabled) {
            this.elements.messageInput.placeholder = "Search the web anonymously";
        } else {
            this.elements.messageInput.placeholder = "Ask anonymously";
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

    updateSearchToggle() {
        this.elements.searchSwitch.setAttribute('aria-checked', this.searchEnabled);

        const thumb = this.elements.searchSwitch.querySelector('.search-switch-thumb');
        if (this.searchEnabled) {
            this.elements.searchSwitch.classList.remove('bg-muted', 'hover:bg-muted/80');
            this.elements.searchSwitch.classList.add('search-switch-active');
            thumb.classList.remove('translate-x-[2px]', 'bg-background/80');
            thumb.classList.add('translate-x-[19px]', 'search-switch-thumb-active');
        } else {
            this.elements.searchSwitch.classList.remove('search-switch-active');
            this.elements.searchSwitch.classList.add('bg-muted', 'hover:bg-muted/80');
            thumb.classList.remove('translate-x-[19px]', 'search-switch-thumb-active');
            thumb.classList.add('translate-x-[2px]', 'bg-background/80');
        }
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

