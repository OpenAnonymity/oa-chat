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
            sessionsScrollArea: document.getElementById('sessions-scroll-area'),
            modelListScrollArea: document.getElementById('model-list-scroll-area'),
            themeOptionButtons: Array.from(document.querySelectorAll('[data-theme-option]')),
            themeEffectiveLabel: document.getElementById('theme-effective-label'),
        };

        themeManager.init();
        this.updateThemeControls(themeManager.getPreference(), themeManager.getEffectiveTheme());
        this.themeUnsubscribe = themeManager.onChange((preference, effectiveTheme) => {
            this.updateThemeControls(preference, effectiveTheme);
        });

        this.searchEnabled = false;
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
        // Escape backslashes for LaTeX delimiters to prevent marked from stripping them
        // This is based on the solution from https://stackoverflow.com/questions/78220687/
        let processedContent = content
            .replace(/\\\[/g, '\\\\[')
            .replace(/\\\]/g, '\\\\]')
            .replace(/\\\(/g, '\\\\(')
            .replace(/\\\)/g, '\\\\)');

        // Process markdown
        let html = marked.parse(processedContent);

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

        // Scroll to bottom after initial load (for refresh)
        setTimeout(() => {
            this.elements.chatArea.scrollTop = this.elements.chatArea.scrollHeight;
        }, 100);
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
            expiresAt: null
        };

        this.state.sessions.unshift(session);
        this.state.currentSessionId = session.id;

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
        this.renderSessions();
        this.renderMessages();
        this.renderCurrentModel();

        // Notify right panel of session change
        const session = this.getCurrentSession();
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
            streamingTokens: metadata.streamingTokens || null
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
        if (!content) return;

        this.isWaitingForResponse = true;
        this.updateInputState();

        try {
            // Create session if none exists
            if (!this.getCurrentSession()) {
                await this.createSession();
            }

            // Add user message
            await this.addMessage('user', content);
            this.elements.messageInput.value = '';
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

                // Remove typing indicator and render messages to show the empty message
                this.removeTypingIndicator(typingId);
                await this.renderMessages();

                // Track progress for periodic saves
                let lastSaveLength = 0;
                const SAVE_INTERVAL_CHARS = 100; // Save every 100 characters

                // Stream the response with token tracking
                const tokenData = await openRouterAPI.streamCompletion(
                    messages,
                    modelId,
                    session.apiKey,
                    async (chunk) => {
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
                                        throwOnError: false
                                    });
                                }
                            }
                        }
                        // Keep scrolling to bottom
                        this.elements.chatArea.scrollTop = this.elements.chatArea.scrollHeight;
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
                    }
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
            <div id="${id}" class="max-w-4xl w-full px-2 md:px-3 fade-in">
                <div class="flex items-center gap-2">
                    <div class="flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full border border-border/50 shadow bg-muted p-0.5">
                        <span class="text-xs font-semibold">${providerInitial}</span>
                    </div>
                    <div class="flex gap-1">
                        <div class="w-2 h-2 bg-muted-foreground rounded-full animate-pulse"></div>
                        <div class="w-2 h-2 bg-muted-foreground rounded-full animate-pulse" style="animation-delay: 0.2s"></div>
                        <div class="w-2 h-2 bg-muted-foreground rounded-full animate-pulse" style="animation-delay: 0.4s"></div>
                    </div>
                </div>
            </div>
        `;
        this.elements.messagesContainer.insertAdjacentHTML('beforeend', typingHtml);
        const chatArea = this.elements.messagesContainer.parentElement;
        chatArea.scrollTop = chatArea.scrollHeight;
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
                            <div class="flex shrink-0 items-center">
                                <button class="delete-session-btn inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 gap-2 leading-6 text-muted-foreground hover:bg-accent hover:text-accent-foreground border border-transparent h-9 w-9 group-hover:opacity-100 md:opacity-0" aria-label="Delete session" data-session-id="${session.id}">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
                                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
                                    </svg>
                                </button>
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
                if (!e.target.closest('.delete-session-btn')) {
                    this.switchSession(el.dataset.sessionId);
                }
            });
        });

        document.querySelectorAll('.delete-session-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteSession(btn.dataset.sessionId);
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
                return `
                    <div class="w-full px-2 md:px-3 fade-in self-end" data-message-id="${message.id}">
                        <div class="group my-2 flex w-full flex-col gap-2 justify-end items-end">
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
                    throwOnError: false
                });
            });
        }

        // Scroll to bottom after a brief delay to ensure rendering is complete
        requestAnimationFrame(() => {
            this.elements.chatArea.scrollTop = this.elements.chatArea.scrollHeight;
        });

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

        // Close settings menu when clicking outside
        document.addEventListener('click', () => {
            if (!this.elements.settingsMenu.classList.contains('hidden')) {
                this.elements.settingsMenu.classList.add('hidden');
            }
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
        this.elements.searchToggle.addEventListener('click', () => {
            this.searchEnabled = !this.searchEnabled;
            this.elements.searchSwitch.setAttribute('aria-checked', this.searchEnabled);

            const thumb = this.elements.searchSwitch.querySelector('.search-switch-thumb');
            if (this.searchEnabled) {
                this.elements.searchSwitch.style.backgroundColor = 'hsl(217.2 91.2% 59.8%)';
                this.elements.searchSwitch.classList.remove('bg-muted', 'hover:bg-muted/80');
                thumb.classList.remove('translate-x-[2px]', 'bg-background/80');
                thumb.classList.add('translate-x-[19px]');
                thumb.style.backgroundColor = 'white';
            } else {
                this.elements.searchSwitch.style.backgroundColor = '';
                this.elements.searchSwitch.classList.add('bg-muted', 'hover:bg-muted/80');
                thumb.classList.remove('translate-x-[19px]');
                thumb.classList.add('translate-x-[2px]', 'bg-background/80');
                thumb.style.backgroundColor = '';
            }
            this.updateInputState();
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

            // Escape to close settings menu
            if (e.key === 'Escape' && !this.elements.settingsMenu.classList.contains('hidden')) {
                this.elements.settingsMenu.classList.add('hidden');
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
        const hasContent = this.elements.messageInput.value.trim();
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

