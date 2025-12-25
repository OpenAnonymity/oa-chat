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
import { downloadInferenceTickets, downloadAllChats, getFileIconSvg } from './services/fileUtils.js';
import { parseReasoningContent } from './services/reasoningParser.js';
import { fetchUrlMetadata } from './services/urlMetadata.js';
import networkProxy from './services/networkProxy.js';
import stationVerifier from './services/verifier.js';
import openRouterAPI from './api.js';

const DEFAULT_MODEL_ID = 'openai/gpt-5.2-chat';
const DEFAULT_MODEL_NAME = 'OpenAI: GPT-5.2 Instant';

// Layout constants for toolbar overlay prediction
const SIDEBAR_WIDTH = 256;      // 16rem = 256px
const RIGHT_PANEL_WIDTH = 320;  // 20rem = 320px (w-80)
const TOOLBAR_PREDICTION_GRACE_MS = 350; // Grace period to respect predicted state during animations

// Used to upgrade users who were implicitly on the prior default.
const PREVIOUS_DEFAULT_MODEL_NAME = 'OpenAI: GPT-5.1 Instant';

// Legacy/alternate display names that may exist in persisted settings/sessions.
// Map them to the canonical display names used by the current UI.
const MODEL_NAME_ALIASES = new Map([
    // GPT-5.2 Instant (chat)
    ['OpenAI: GPT-5.2 Chat', 'OpenAI: GPT-5.2 Instant'],
    ['GPT-5.2 Chat', 'OpenAI: GPT-5.2 Instant'],
    // GPT-5.1 Instant (chat)
    ['OpenAI: GPT-5.1 Chat', 'OpenAI: GPT-5.1 Instant'],
    ['GPT-5.1 Chat', 'OpenAI: GPT-5.1 Instant'],
    // GPT-5 Instant (chat)
    ['OpenAI: GPT-5 Chat', 'OpenAI: GPT-5 Instant'],
    ['GPT-5 Chat', 'OpenAI: GPT-5 Instant'],
]);
const SESSION_STORAGE_KEY = 'oa-current-session'; // Tab-scoped session persistence
const DELETE_HISTORY_COPY = {
    title: 'Delete all chat history',
    body: 'Past chat history is stored locally on this browser. Prompts and responses are end-to-end encrypted to and from the model providers who only see anonymous traffic and cannot identify, link, or otherwise track you.',
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
    constructor() {
        this.state = {
            sessions: [],
            currentSessionId: null,
            models: [],
            modelsLoading: false,
            pendingModelName: null // Model selected before session is created (display name)
        };

        this.elements = {
            newChatBtn: document.getElementById('new-chat-btn'),
            sessionsScrollArea: document.getElementById('sessions-scroll-area'),
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
            // clearChatBtn: document.getElementById('clear-chat-btn'), // Temporarily removed
            // copyMarkdownBtn: document.getElementById('copy-markdown-btn'), // Temporarily removed
            toggleRightPanelBtn: document.getElementById('toggle-right-panel-btn'), // This might be legacy, but let's keep it for now.
            showRightPanelBtn: document.getElementById('show-right-panel-btn'),
            exportPdfBtn: document.getElementById('export-pdf-btn'),
            wideModeBtn: document.getElementById('wide-mode-btn'),
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
            deleteHistoryBtn: document.getElementById('delete-history-btn'),
            deleteHistoryModal: document.getElementById('delete-history-modal'),
            deleteHistoryConfirmBtn: null,
            deleteHistoryCancelBtn: null,
            dropZoneOverlay: document.getElementById('drop-zone-overlay'),
        };

        this.searchEnabled = true;
        this.sessionSearchQuery = '';
        this.uploadedFiles = [];
        this.fileUndoStack = []; // Track file paste operations for undo
        this.rightPanel = null;
        this.floatingPanel = null;
        this.messageNavigation = null;
        this.sidebar = null;
        this.chatArea = null;
        this.chatInput = null;
        this.modelPicker = null;
        this.sessionStreamingStates = new Map(); // Track streaming state per session
        this.sessionScrollPositions = new Map(); // Track scrollTop per session in-memory
        this.chatScrollSaveFrame = null;
        this.isAutoScrollPaused = false; // Track if auto-scroll is paused during streaming
        this.scrollToBottomButton = null; // Reference to the floating scroll-to-bottom button
        this.scrollButtonCheckInterval = null; // Interval for checking button visibility during streaming
        this.deleteHistoryReturnFocusEl = null;
        this.isDeletingAllChats = false;

        // Link preview state
        this.linkPreviewCard = document.getElementById('link-preview-card');
        this.linkPreviewTimeout = null;
        this.currentPreviewLink = null;

        // Edit mode state
        this.editingMessageId = null; // Track which message is being edited

        this.init();
    }

    getDefaultModelId() {
        return DEFAULT_MODEL_ID;
    }

    getDefaultModelName() {
        return DEFAULT_MODEL_NAME;
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
                const success = await downloadAllChats();
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
    addImagesWithDedup(existingImages, newImages) {
        if (!newImages || newImages.length === 0) return;

        const existingUrls = new Set(
            existingImages.map(img => img.image_url?.url).filter(Boolean)
        );

        for (const img of newImages) {
            const url = img.image_url?.url;
            if (url && !existingUrls.has(url)) {
                existingImages.push(img);
                existingUrls.add(url);
            }
        }
    }

    /**
     * Configure marked.js with custom renderer for code blocks
     * Adds language label and copy button to fenced code blocks
     */
    configureMarkedRenderer() {
        const renderer = new marked.Renderer();

        // Custom code block renderer with header (language + copy button)
        renderer.code = (code, language) => {
            const lang = language || '';
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

            return `<div class="code-block-wrapper">
                <div class="code-block-header">
                    <span class="code-block-lang">${displayLang}</span>
                    <button class="code-block-copy-btn" data-code="${this.escapeHtmlAttribute(code)}">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="copy-icon">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                        </svg>
                        <span class="copy-text">Copy code</span>
                    </button>
                </div>
                <pre><code class="hljs${lang ? ` language-${lang}` : ''}">${highlightedCode}</code></pre>
            </div>`;
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
            blockLatexPlaceholders.push(match);
            return `\n\n${placeholder}\n\n`;
        });

        // Extract block LaTeX $$...$$ and replace with placeholders
        processedContent = processedContent.replace(/\$\$([\s\S]*?)\$\$/g, (match, latex) => {
            const placeholder = `BLOCKLATEX${blockLatexPlaceholders.length}PLACEHOLDER`;
            blockLatexPlaceholders.push(match);
            return `\n\n${placeholder}\n\n`;
        });

        // Extract inline LaTeX \(...\) and replace with placeholders
        processedContent = processedContent.replace(/\\\(([\s\S]*?)\\\)/g, (match, latex) => {
            const placeholder = `INLINELATEX${inlineLatexPlaceholders.length}PLACEHOLDER`;
            inlineLatexPlaceholders.push(match);
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

        if (!force && this.isAutoScrollPaused) {
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
     * Scrolls a user message to the top of the chat area
     * @param {string} messageId - The message ID to scroll to top
     */
    scrollUserMessageToTop(messageId) {
        const chatArea = this.elements.chatArea;
        const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);

        console.log('[Scroll To Top]', { messageId, chatArea: !!chatArea, messageEl: !!messageEl });

        if (!chatArea || !messageEl) {
            console.warn('[Scroll To Top] Failed - missing elements');
            return;
        }

        const padding = 20;
        const messageTop = messageEl.offsetTop - chatArea.offsetTop - padding;

        console.log('[Scroll To Top] Scrolling to:', messageTop);

        chatArea.scrollTo({
            top: messageTop,
            behavior: 'smooth'
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

            // On mobile, show divider if user has scrolled down past threshold
            const hasScrolled = chatArea.scrollTop > 10; // Small threshold to avoid flickering
            toolbar.classList.toggle('toolbar-divider-visible', hasScrolled);

            // Also control the mobile divider element visibility
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
        // Button area: ~116px (3×36px buttons + gaps + padding)
        // But messages-container has internal padding (px-6 = 24px on md+), so actual text is further inward
        // With sideMargin=80 + internal padding=24, actual content at 104px - minimal overlap with 116px buttons
        const buttonAreaWidth = 80;

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

        const inputContainer = document.querySelector('.absolute.bottom-0.left-0.right-0');
        const lastMessage = this.elements.messagesContainer ? this.elements.messagesContainer.lastElementChild : null;

        if (!inputContainer || !lastMessage) {
            this.hideScrollToBottomButton();
            return;
        }

        const hiddenDistance = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight;
        const isAtBottom = hiddenDistance <= 4;

        if (isAtBottom) {
            this.isAutoScrollPaused = false;
            this.hideScrollToBottomButton();
            return;
        }

        const inputTop = inputContainer.getBoundingClientRect().top;
        const lastMessageBottom = lastMessage.getBoundingClientRect().bottom;
        const overlapsInput = lastMessageBottom > inputTop - 8;
        const shouldShow = overlapsInput || hiddenDistance > 12;

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

        // Hide preview after a short delay to allow moving to the preview card
        setTimeout(() => {
            // Check if mouse is over preview card
            const previewRect = this.linkPreviewCard?.getBoundingClientRect();
            if (previewRect) {
                const mouseX = event.clientX;
                const mouseY = event.clientY;
                const isOverPreview = mouseX >= previewRect.left && mouseX <= previewRect.right &&
                                     mouseY >= previewRect.top && mouseY <= previewRect.bottom;
                if (!isOverPreview) {
                    this.hideLinkPreview();
                }
            }
        }, 100);
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

        // Hide preview when mouse leaves preview card
        if (this.linkPreviewCard) {
            this.linkPreviewCard.addEventListener('mouseleave', () => {
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
            const img = document.querySelector(`[data-image-id="${imageId}"]`);
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
        window.downloadInferenceTickets = () => {
            downloadInferenceTickets();
        };

        // Initialize theme FIRST (sync, fast, prevents flash)
        themeManager.init();

        // Initialize wide mode state from localStorage
        this.initWideMode();

        // Start DB init in background - components can show skeleton state
        const dbReady = chatDB.init();

        // Initialize UI components immediately (sync, fast) - shows loading states
        this.sidebar = new Sidebar(this);
        this.chatArea = new ChatArea(this);
        this.chatInput = new ChatInput(this);
        this.modelPicker = new ModelPicker(this);
        this.rightPanel = new RightPanel(this);
        this.rightPanel.mount();

        // Wait for DB before loading data
        await dbReady;

        // Initialize network proxy in background (don't block UI)
        networkProxy.initialize().catch(err => console.warn('Proxy init failed:', err));

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

        // Load all data from IndexedDB in PARALLEL for speed
        const [sessions, storedModelPreference, savedSearchEnabled] = await Promise.all([
            chatDB.getAllSessions(),
            chatDB.getSetting('selectedModel'),
            chatDB.getSetting('searchEnabled')
        ]);

        this.state.sessions = sessions;

        // Migrate sessions in background (don't block UI)
        this.migrateSessionsInBackground(sessions);

        // Restore session from sessionStorage (persists across refreshes, not across tabs)
        const savedSessionId = sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (savedSessionId && this.state.sessions.some(s => s.id === savedSessionId)) {
            this.state.currentSessionId = savedSessionId;
        }

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

        // Render local data IMMEDIATELY (sessions from DB, model from settings)
        this.renderSessions();
        this.renderMessages();
        this.renderCurrentModel();
        this.chatInput.updateSearchToggleUI();

        // Notify right panel of current session
        const currentSession = this.getCurrentSession();
        if (this.rightPanel && currentSession) {
            this.rightPanel.onSessionChange(currentSession);
        }
        if (this.floatingPanel && currentSession) {
            this.floatingPanel.render();
        }

        this.renderDeleteHistoryModalContent();

        // Set up event listeners
        this.setupEventListeners();

        // Load models from OpenRouter API in background (non-blocking)
        // Updates model picker with icons once loaded
        this.loadModels().then(() => {
            this.renderCurrentModel(); // Re-render button with model icons
            // Also re-render model list if modal is open
            if (this.modelPicker && !this.elements.modelPickerModal.classList.contains('hidden')) {
                this.modelPicker.renderModels(this.elements.modelSearch?.value || '');
            }
        }).catch(error => {
            console.warn('Background model loading failed:', error);
        });

        this.initScrollAwareScrollbars(this.elements.chatArea);
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
            resizeDebounceTimer = setTimeout(() => this.updateToolbarDivider(), 350);
        }, { passive: true });

        // Set up ResizeObserver to adjust chat area padding when input area expands
        this.setupInputAreaObserver();

        // Set up link preview event listeners
        this.setupLinkPreviewListeners();

        // Initialize verifier and start broadcast checks
        this.initVerifier();

        // Handle mobile view on initial load
        if (this.isMobileView()) {
            this.hideSidebar();
        }

        // Scroll to bottom after initial load (for refresh)
        setTimeout(() => {
            this.scrollToBottom(true);
            // Initialize toolbar divider state
            this.updateToolbarDivider();
        }, 100);

        // Auto-focus input field on startup
        this.elements.messageInput.focus();

        // Check for pending send from early interaction
        if (window.oaPendingSend) {
            window.oaPendingSend = false;
            // Small delay to ensure everything is settled
            setTimeout(() => {
                this.sendMessage();
            }, 0);
        }
    }

    /**
     * Initialize the verifier service for station verification
     */
    initVerifier() {
        // Initialize verifier (loads cached broadcast data)
        stationVerifier.init();

        // Set up banned warning callback - show warning and clear API key when station gets banned
        stationVerifier.setBannedWarningCallback(async ({ stationId, reason, bannedAt, session }) => {
            console.log(`🚫 Station ${stationId} banned: ${reason}`);

            if (session && session.apiKeyInfo?.stationId === stationId) {
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
        stationVerifier.startBroadcastCheck(() => this.getCurrentSession());
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
     * Normalizes any stored model reference into the canonical display name
     * used throughout the UI.
     *
     * Accepts:
     * - A model ID (e.g. "openai/gpt-5.1-chat"), which is converted via
     *   OpenRouter display-name overrides when available.
     * - Legacy aliases (e.g. "OpenAI: GPT-5.1 Chat"), which are mapped to
     *   canonical display names.
     *
     * Returns the original value when no conversion is necessary so that
     * newer/custom names remain untouched.
     *
     * @param {string|null} modelIdOrName
     * @returns {string|null}
     */
    normalizeModelName(modelIdOrName) {
        if (!modelIdOrName) {
            return modelIdOrName;
        }

        // If model ID, get display name from OpenRouter API
        if (modelIdOrName.includes('/')) {
            if (typeof openRouterAPI !== 'undefined' && typeof openRouterAPI.getDisplayName === 'function') {
                return openRouterAPI.getDisplayName(modelIdOrName, modelIdOrName);
            }
            return modelIdOrName;
        }

        if (MODEL_NAME_ALIASES.has(modelIdOrName)) {
            return MODEL_NAME_ALIASES.get(modelIdOrName);
        }

        return modelIdOrName;
    }

    /**
     * Upgrades users who were effectively on the old default model to the new
     * default model. Only applies to stored *preference* (not per-session model).
     * @param {string|null} normalizedModelName
     * @returns {string|null}
     */
    upgradeDefaultModelPreference(normalizedModelName) {
        if (!normalizedModelName) return normalizedModelName;
        if (normalizedModelName === PREVIOUS_DEFAULT_MODEL_NAME) {
            return DEFAULT_MODEL_NAME;
        }
        return normalizedModelName;
    }

    /**
     * Creates a new chat session.
     * @param {string} title - Session title
     * @returns {Promise<Object>} The created session
     */
    async createSession(title = 'New Chat') {
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

        const session = {
            id: this.generateId(),
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            model: modelNameForNewSession,
            apiKey: null,
            apiKeyInfo: null,
            expiresAt: null,
            searchEnabled: this.searchEnabled
        };

        // Clear pending model since it's now part of the session
        this.state.pendingModelName = null;

        this.state.sessions.unshift(session);
        this.state.currentSessionId = session.id;

        this.chatInput.updateSearchToggleUI();

        await chatDB.saveSession(session);
        sessionStorage.setItem(SESSION_STORAGE_KEY, session.id);
        await chatDB.saveSetting('currentSessionId', session.id);

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
        if (!sessionId || sessionId === this.state.currentSessionId) {
            return;
        }

        this.saveCurrentSessionScrollPosition();

        // Clear edit state when switching sessions
        this.editingMessageId = null;

        this.state.currentSessionId = sessionId;
        sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
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

        // Hide scroll-to-bottom button immediately to prevent it from persisting
        this.hideScrollToBottomButton();

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

        // Start periodic button visibility check when streaming starts
        if (isStreaming && !this.scrollButtonCheckInterval) {
            this.scrollButtonCheckInterval = setInterval(() => {
                this.updateScrollButtonVisibility();
            }, 200); // Check every 200ms during streaming
        } else if (!isStreaming && this.scrollButtonCheckInterval) {
            clearInterval(this.scrollButtonCheckInterval);
            this.scrollButtonCheckInterval = null;
        }

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
        await this.clearCurrentSession();

        // Close sidebar on mobile after creating new chat
        if (this.isMobileView()) {
            this.hideSidebar();
        }
    }

    /**
     * Clears the current session, returning to the startup state.
     * No session is selected until the user sends their first message.
     */
    async clearCurrentSession() {
        this.saveCurrentSessionScrollPosition();
        this.state.currentSessionId = null;

        // Load the selected model from settings so UI shows correct model
        const storedModelPreference = await chatDB.getSetting('selectedModel');
        const normalizedSelectedModelName = this.upgradeDefaultModelPreference(
            this.normalizeModelName(storedModelPreference)
        );
        if (normalizedSelectedModelName && normalizedSelectedModelName !== storedModelPreference) {
            await chatDB.saveSetting('selectedModel', normalizedSelectedModelName);
        }
        this.state.pendingModelName = normalizedSelectedModelName || null;

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

        // Hide scroll-to-bottom button when clearing session
        this.hideScrollToBottomButton();

        // Clear right panel
        if (this.rightPanel) {
            this.rightPanel.onSessionChange(null);
        }

        // Focus input after UI updates complete
        requestAnimationFrame(() => {
            if (this.elements.messageInput) {
                this.elements.messageInput.focus();
            }
        });
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
            searchEnabled: metadata.searchEnabled || false,
            citations: metadata.citations || null,
            isLocalOnly: Boolean(metadata.isLocalOnly)
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
     * Processes messages with file metadata to convert them to multimodal content format.
     * This ensures files are included in conversation history for all API calls.
     * @param {Array} messages - Array of messages from the database
     * @returns {Array} Processed messages with multimodal content
     */
    processMessagesWithFiles(messages) {
        const filteredMessages = messages.filter(msg => !msg.isLocalOnly);

        return filteredMessages.map(msg => {
            // Only process user messages with files
            if (msg.role === 'user' && msg.files && msg.files.length > 0) {
                // Separate text files from other media
                let textContent = msg.content || '';
                const mediaFiles = [];

                msg.files.forEach(file => {
                    // Use the detected file type that was stored during upload
                    const isText = file.detectedType === 'text';

                    if (isText) {
                        // Extract content from base64 dataUrl
                        try {
                            // Data URL format: data:mime/type;base64,encodedData
                            const base64Data = file.dataUrl.split(',')[1];
                            const decodedContent = atob(base64Data);
                            textContent += `\n\n--- File: ${file.name} ---\n${decodedContent}`;
                        } catch (e) {
                            console.error('Failed to decode text file:', file.name, e);
                            textContent += `\n\n--- File: ${file.name} ---\n[Error reading file content]`;
                        }
                    } else {
                        mediaFiles.push(file);
                    }
                });

                // Convert to multimodal content array
                const contentArray = [
                    { type: 'text', text: textContent },
                    ...mediaFiles.map(file => {
                        if (file.type.startsWith('image/') || file.detectedType === 'image') {
                            return {
                                type: 'image_url',
                                image_url: { url: file.dataUrl }
                            };
                        } else {
                            // For PDFs and audio files
                            return {
                                type: 'file',
                                file: {
                                    filename: file.name,
                                    file_data: file.dataUrl
                                }
                            };
                        }
                    })
                ];
                return {
                    role: msg.role,
                    content: contentArray
                };
            }
            // For messages without files, return standard format
            return {
                role: msg.role,
                content: msg.content
            };
        });
    }

    /**
     * Regenerates the last assistant response without creating a new user message.
     * Used when the regenerate button is clicked on an assistant message.
     */
    async regenerateResponse() {
        let session = this.getCurrentSession();
        if (!session) return;

        // Check if current session is already streaming
        const streamingState = this.getSessionStreamingState(session.id);
        if (streamingState.isStreaming) return;

        // Get the last user message to scroll to top
        const messages = await chatDB.getSessionMessages(session.id);
        const lastUserMessage = messages.reverse().find(m => m.role === 'user');

        // Create abort controller for this stream
        const abortController = new AbortController();
        this.setSessionStreamingState(session.id, true, abortController);

        // Pause auto-scroll for streaming (set immediately)
        this.isAutoScrollPaused = true;

        // Scroll last user message to top after a brief delay
        if (lastUserMessage && lastUserMessage.id) {
            setTimeout(() => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        this.scrollUserMessageToTop(lastUserMessage.id);
                        // Check button visibility after scrolling
                        setTimeout(() => this.updateScrollButtonVisibility(), 100);
                    });
                });
            }, 50);
        }

        try {
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
                    await this.addMessage('assistant', `**Error:** ${error.message}`, { isLocalOnly: true });
                    return;
                }

                // Verify key with verifier before proceeding
                try {
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage('Verifying key...', 'info');
                    }
                    await stationVerifier.submitKey(session.apiKeyInfo);

                    // Set current station for broadcast monitoring
                    stationVerifier.setCurrentStation(session.apiKeyInfo.stationId, session);
                } catch (verifyError) {
                    // Clear the API key since it failed verification
                    session.apiKey = null;
                    session.apiKeyInfo = null;
                    session.expiresAt = null;
                    await chatDB.saveSession(session);

                    // Update UI components
                    if (this.rightPanel) {
                        this.rightPanel.onSessionChange(session);
                    }

                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage(verifyError.message, 'error', 5000);
                    }

                    // Show detailed error for banned stations
                    let errorMessage;
                    if (verifyError.status === 'banned' && verifyError.bannedStation) {
                        const bs = verifyError.bannedStation;
                        const bannedDate = bs.bannedAt ? new Date(bs.bannedAt).toLocaleString() : 'Unknown';
                        errorMessage = `**Station Banned**\n\n${verifyError.message}\n\n` +
                            `- **Station ID:** \`${bs.stationId}\`\n` +
                            `- **Reason:** ${bs.reason || 'Not specified'}\n` +
                            `- **Banned at:** ${bannedDate}`;
                    } else {
                        errorMessage = `**Verification Error:** ${verifyError.message}`;
                    }
                    await this.addMessage('assistant', errorMessage, { isLocalOnly: true });
                    return; // Block inference if verification fails
                }
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

            if (!modelNameToUse) {
                const defaultModel = this.state.models.find(m => m.id === DEFAULT_MODEL_ID);
                if (defaultModel) {
                    modelNameToUse = this.normalizeModelName(defaultModel.name);
                } else {
                    const gpt4oModel = this.state.models.find(m => m.name.toLowerCase().includes('gpt-4o'));
                    if (gpt4oModel) {
                        modelNameToUse = this.normalizeModelName(gpt4oModel.name);
                    } else if (this.state.models.length > 0) {
                        modelNameToUse = this.normalizeModelName(this.state.models[0].name);
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
                await this.addMessage('assistant', 'No models are available right now. Please add a model and try again.', { isLocalOnly: true });
                return;
            }

            const selectedModelEntry = this.state.models.find(m => m.name === modelNameToUse);
            let modelIdForRequest;

            if (selectedModelEntry) {
                modelIdForRequest = selectedModelEntry.id;
            } else {
                modelIdForRequest = 'openai/gpt-4o';
            }

            // Show typing indicator (only if still viewing this session)
            const typingId = this.isViewingSession(session.id) ? this.showTypingIndicator(modelNameToUse) : null;

            let streamingMessage = null;
            let streamedContent = '';
            let streamedReasoning = '';
            let firstChunkReceived = false;

            try {
                // Get AI response from OpenRouter with streaming
                const messages = await chatDB.getSessionMessages(session.id);
                const filteredMessages = messages.filter(msg => !msg.isLocalOnly);

                // Process messages to include file content from stored metadata
                const processedMessages = this.processMessagesWithFiles(filteredMessages);

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
                    streamingReasoning: false
                };

                let lastSaveLength = 0;
                const SAVE_INTERVAL_CHARS = 100;
                let reasoningStartTime = null;

                // Stream the response with token tracking
                const tokenData = await openRouterAPI.streamCompletion(
                    processedMessages,
                    modelIdForRequest,
                    session.apiKey,
                    async (chunk, imageData) => {
                        // On first chunk (of any kind), remove typing indicator and append message
                        if (!firstChunkReceived) {
                            firstChunkReceived = true;
                            if (typingId) this.removeTypingIndicator(typingId);

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
                        // FEATURE DISABLED: Token count display - uncomment to re-enable
                        streamingTokenCount = tokenUpdate.completionTokens || 0;
                        // if (tokenUpdate.isStreaming && this.chatArea) {
                        //     this.chatArea.updateStreamingTokens(streamingMessageId, streamingTokenCount);
                        // }
                    },
                    [], // No files for regeneration
                    false, // No search for regeneration
                    abortController,
                    async (reasoningChunk) => {
                        // Handle reasoning trace streaming
                        if (!firstChunkReceived) {
                            firstChunkReceived = true;
                            reasoningStartTime = Date.now();
                            if (typingId) this.removeTypingIndicator(typingId);
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

                        // Only update UI if still viewing the same session
                        if (this.chatArea && this.isViewingSession(session.id)) {
                            this.chatArea.updateStreamingReasoning(streamingMessageId, streamedReasoning);
                        }
                    }
                );

                // Save the final message content with token data, reasoning, and citations
                streamingMessage.content = streamedContent;
                const rawReasoning = tokenData.reasoning || streamedReasoning || null;
                // Parse and save the cleaned reasoning
                streamingMessage.reasoning = rawReasoning ? parseReasoningContent(rawReasoning) : null;
                streamingMessage.tokenCount = tokenData.totalTokens || tokenData.completionTokens || streamingTokenCount;
                streamingMessage.model = tokenData.model || modelNameToUse;
                streamingMessage.streamingTokens = null;
                streamingMessage.streamingReasoning = false;
                streamingMessage.citations = tokenData.citations || null;

                // Calculate reasoning duration if reasoning was used
                if (streamingMessage.reasoning && reasoningStartTime) {
                    const reasoningEndTime = Date.now();
                    streamingMessage.reasoningDuration = reasoningEndTime - reasoningStartTime;
                }

                await chatDB.saveMessage(streamingMessage);

                // Fetch metadata for citations asynchronously and update UI
                if (streamingMessage.citations && streamingMessage.citations.length > 0) {
                    this.enrichCitationsAndUpdateUI(streamingMessage);
                }

                // Only update UI if still viewing the same session
                if (this.chatArea && this.isViewingSession(session.id)) {
                    // FEATURE DISABLED: Token count display - uncomment to re-enable
                    // if (streamingMessage.tokenCount) {
                    //     this.chatArea.updateFinalTokens(streamingMessageId, streamingMessage.tokenCount);
                    // }
                    // Finalize reasoning display with markdown processing and timing
                    if (streamingMessage.reasoning) {
                        this.chatArea.finalizeReasoningDisplay(streamingMessageId, streamingMessage.reasoning, streamingMessage.reasoningDuration);
                    }
                    // Re-render message if no content (to show "no response" notice and clean up empty bubbles)
                    if (!streamingMessage.content && (!streamingMessage.images || streamingMessage.images.length === 0)) {
                        await this.chatArea.finalizeStreamingMessage(streamingMessage);
                    }
                }

            } catch (error) {
                console.error('Error getting AI response:', error);
                if (typingId) this.removeTypingIndicator(typingId);

                if (error.isCancelled) {
                    if (streamingMessage && firstChunkReceived) {
                        if (streamedContent.trim() || streamedReasoning.trim()) {
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
                        await chatDB.saveMessage(streamingMessage);
                        // Only update UI if still viewing the same session
                        if (this.chatArea && this.isViewingSession(session.id)) {
                            await this.chatArea.finalizeStreamingMessage(streamingMessage);
                        }
                    } else if (this.isViewingSession(session.id)) {
                        await this.addMessage('assistant', 'Sorry, I encountered an error while processing your request.', { isLocalOnly: true });
                    }
                }
            }
        } finally {
            this.setSessionStreamingState(session.id, false, null);
            // Reset auto-scroll state and hide button
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

        // TODO: Re-enable verifier offline check later
        // // Block if verifier is offline (unless user acknowledged)
        // // This must be checked FIRST before any message is sent
        // const verifierOffline = stationVerifier.isOffline();
        // console.log(`🔍 Verifier status check: online=${stationVerifier.verifierOnline}, isOffline=${verifierOffline}, skipOfflineCheck=${skipOfflineCheck}`);
        // if (verifierOffline && !skipOfflineCheck) {
        //     console.log('⚠️ Blocking - showing verifier offline warning');
        //     this.showVerifierOfflineWarningModal({
        //         lastSuccessful: stationVerifier.lastSuccessfulBroadcast,
        //         timeSince: stationVerifier.getTimeSinceLastBroadcast(),
        //         error: 'Verifier unreachable',
        //         onSendAnyway: () => {
        //             // Re-call sendMessage with skip flag
        //             this.sendMessage(true);
        //         }
        //     });
        //     return; // Block until user acknowledges
        // }

        // Block sending if station is banned (check both state and cached broadcast data)
        const stationId = session.apiKeyInfo?.stationId;
        if (stationId) {
            const stationState = stationVerifier.getStationState(stationId);
            // Also check cached broadcast data directly
            const isBannedInCache = stationVerifier.isStationBanned(stationId);

            if (stationState?.banned || isBannedInCache) {
                console.log(`🚫 Station ${stationId} is banned (state: ${stationState?.banned}, cache: ${isBannedInCache})`);
                // Get ban info from state or cache
                const broadcastData = stationVerifier.getLastBroadcastData();
                const bannedInfo = broadcastData?.banned_stations?.find(s => s.station_id === stationId);

                this.showBannedStationWarningModal({
                    stationId: stationId,
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
                // Store file data for preview rendering and include detected file type
                const { getFileType } = await import('./services/fileUtils.js');
                const fileData = await Promise.all(currentFiles.map(async (file) => {
                    const dataUrl = await this.createImagePreview(file);
                    const detectedType = await getFileType(file);
                    return {
                        name: file.name,
                        type: file.type,
                        size: file.size,
                        dataUrl: dataUrl,
                        detectedType: detectedType  // Store the detected type (image, pdf, audio, text)
                    };
                }));
                metadata.files = fileData;
            }
            if (searchEnabled) {
                metadata.searchEnabled = true;
            }
            this.isAutoScrollPaused = true;
            const userMessage = await this.addMessage('user', content || '', metadata);

            // Clear input and files
            this.elements.messageInput.value = '';
            this.uploadedFiles = [];
            this.fileUndoStack = []; // Clear undo stack when message is sent
            this.renderFilePreviews();
            this.updateFileCountBadge();
            this.updateInputState();
            this.elements.messageInput.style.height = '24px';

            // Auto-scroll remains paused while the response streams

            // Scroll user message to top after a brief delay to ensure rendering
            if (userMessage && userMessage.id) {
                // Use setTimeout with RAF to ensure message is fully rendered
                setTimeout(() => {
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            this.scrollUserMessageToTop(userMessage.id);
                            // Check button visibility after scrolling
                            setTimeout(() => this.updateScrollButtonVisibility(), 100);
                        });
                    });
                }, 50);
            }

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
                    await this.addMessage('assistant', `**Error:** ${error.message}`, { isLocalOnly: true });
                    return; // Return early if key acquisition fails
                }

                // Verify key with verifier before proceeding
                try {
                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage('Verifying key...', 'info');
                    }
                    await stationVerifier.submitKey(session.apiKeyInfo);

                    // Set current station for broadcast monitoring
                    stationVerifier.setCurrentStation(session.apiKeyInfo.stationId, session);
                } catch (verifyError) {
                    // Clear the API key since it failed verification
                    session.apiKey = null;
                    session.apiKeyInfo = null;
                    session.expiresAt = null;
                    await chatDB.saveSession(session);

                    // Update UI components
                    if (this.rightPanel) {
                        this.rightPanel.onSessionChange(session);
                    }

                    if (this.floatingPanel) {
                        this.floatingPanel.showMessage(verifyError.message, 'error', 5000);
                    }

                    // Show detailed error for banned stations
                    let errorMessage;
                    if (verifyError.status === 'banned' && verifyError.bannedStation) {
                        const bs = verifyError.bannedStation;
                        const bannedDate = bs.bannedAt ? new Date(bs.bannedAt).toLocaleString() : 'Unknown';
                        errorMessage = `**Station Banned**\n\n${verifyError.message}\n\n` +
                            `- **Station ID:** \`${bs.stationId}\`\n` +
                            `- **Reason:** ${bs.reason || 'Not specified'}\n` +
                            `- **Banned at:** ${bannedDate}`;
                    } else {
                        errorMessage = `**Verification Error:** ${verifyError.message}`;
                    }
                    await this.addMessage('assistant', errorMessage, { isLocalOnly: true });
                    return; // Block inference if verification fails
                }
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

            // Use GPT-5.2 Chat as default
            if (!modelNameToUse) {
                const defaultModel = this.state.models.find(m => m.id === DEFAULT_MODEL_ID);
                if (defaultModel) {
                    modelNameToUse = this.normalizeModelName(defaultModel.name);
                } else {
                    const gpt4oModel = this.state.models.find(m => m.name.toLowerCase().includes('gpt-4o'));
                    if (gpt4oModel) {
                        modelNameToUse = this.normalizeModelName(gpt4oModel.name);
                    } else if (this.state.models.length > 0) {
                        modelNameToUse = this.normalizeModelName(this.state.models[0].name);
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
                await this.addMessage('assistant', 'No models are available right now. Please add a model and try again.', { isLocalOnly: true });
                return; // Return early
            }

            const selectedModelEntry = this.state.models.find(m => m.name === modelNameToUse);
            let modelIdForRequest;

            if (selectedModelEntry) {
                modelIdForRequest = selectedModelEntry.id;
            } else {
                // Models may not be loaded yet - fall back to default
                modelIdForRequest = DEFAULT_MODEL_ID;
            }

            // Show typing indicator (only if still viewing this session)
            const typingId = this.isViewingSession(session.id) ? this.showTypingIndicator(modelNameToUse) : null;

            // Declare streaming message outside try block so it's accessible in catch
            let streamingMessage = null;

            try {
                // Get AI response from OpenRouter with streaming
                const messages = await chatDB.getSessionMessages(session.id);
                const filteredMessages = messages.filter(msg => !msg.isLocalOnly);

                // Process messages to include file content from stored metadata
                const processedMessages = this.processMessagesWithFiles(filteredMessages);

                // Create a placeholder message for streaming
                const streamingMessageId = this.generateId();
                let streamedContent = '';
                let streamedReasoning = '';
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
                    streamingReasoning: false
                };

                // Track progress for periodic saves
                let lastSaveLength = 0;
                const SAVE_INTERVAL_CHARS = 100; // Save every 100 characters
                let firstChunkReceived = false;
                let firstContentChunk = true; // Track when content starts (after reasoning)
                let reasoningStartTime = null;
                let reasoningEndTime = null;

                // Stream the response with token tracking
                const tokenData = await openRouterAPI.streamCompletion(
                    processedMessages,
                    modelIdForRequest,
                    session.apiKey,
                    async (chunk, imageData) => {
                        // On first chunk (of any kind), remove typing indicator and append message
                        if (!firstChunkReceived) {
                            firstChunkReceived = true;
                            if (typingId) this.removeTypingIndicator(typingId);

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
                        // FEATURE DISABLED: Token count display - uncomment to re-enable
                        // Update streaming token count in real-time
                        streamingTokenCount = tokenUpdate.completionTokens || 0;
                        // if (tokenUpdate.isStreaming && this.chatArea) {
                        //     this.chatArea.updateStreamingTokens(streamingMessageId, streamingTokenCount);
                        // }
                    },
                    [], // Files are now included in processedMessages, not passed separately
                    searchEnabled,
                    abortController,
                    async (reasoningChunk) => {
                        // Handle reasoning trace streaming
                        if (!firstChunkReceived) {
                            firstChunkReceived = true;
                            reasoningStartTime = Date.now();
                            if (typingId) this.removeTypingIndicator(typingId);
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
                    }
                );

                // Save the final message content with token data, reasoning, and citations
                streamingMessage.content = streamedContent;
                const rawReasoning = tokenData.reasoning || streamedReasoning || null;
                // Parse and save the cleaned reasoning
                streamingMessage.reasoning = rawReasoning ? parseReasoningContent(rawReasoning) : null;
                streamingMessage.tokenCount = tokenData.completionTokens || streamingTokenCount;
                streamingMessage.model = tokenData.model || modelNameToUse;
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
                } else {
                    // Non-cancellation error
                    if (firstChunkReceived && streamingMessage) {
                        // Message was already added to UI, update it with error
                        streamingMessage.content = 'Sorry, I encountered an error while processing your request.';
                        streamingMessage.tokenCount = null;
                        streamingMessage.streamingTokens = null;
                        streamingMessage.streamingReasoning = false;
                        streamingMessage.isLocalOnly = true;
                        await chatDB.saveMessage(streamingMessage);
                        // Only update UI if still viewing the same session
                        if (this.chatArea && this.isViewingSession(session.id)) {
                            await this.chatArea.finalizeStreamingMessage(streamingMessage);
                        }
                    } else if (this.isViewingSession(session.id)) {
                        // Error before first chunk - message never added to UI, add new error message
                        await this.addMessage('assistant', 'Sorry, I encountered an error while processing your request.', { isLocalOnly: true });
                    }
                }
            }
        } finally {
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
    showTypingIndicator(modelName) {
        const model = this.state.models.find(m => m.name === modelName);
        const providerName = model ? model.provider : 'OpenAI';
        const id = 'typing-' + Date.now();
            const typingHtml = buildTypingIndicator(id, providerName);
        this.elements.messagesContainer.insertAdjacentHTML('beforeend', typingHtml);
        if (!this.isAutoScrollPaused) {
            this.scrollToBottom(true);
        }
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
            this.sessionScrollPositions.delete(sessionId);

            // Clear edit state if deleting current session
            if (this.state.currentSessionId === sessionId) {
                this.editingMessageId = null;
            }

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
     * Returns template options for rendering a specific message
     * @param {string} messageId - Message ID
     * @returns {Object} Template options
     */
    getMessageTemplateOptions(messageId) {
        return {
            isEditing: this.editingMessageId === messageId
        };
    }

    /**
     * Enters edit mode for a user message
     * @param {string} messageId - Message ID to edit
     */
    async enterEditMode(messageId) {
        const session = this.getCurrentSession();
        if (!session) return;

        // Prevent editing if streaming
        if (this.isCurrentSessionStreaming()) {
            return;
        }

        const messages = await chatDB.getSessionMessages(session.id);
        const message = messages.find(m => m.id === messageId);

        if (!message || message.role !== 'user') {
            return;
        }

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
        if (!newContent) return;

        const messages = await chatDB.getSessionMessages(session.id);
        const messageIndex = messages.findIndex(m => m.id === messageId);

        if (messageIndex === -1) return;

        const message = messages[messageIndex];

        // Update the message content
        message.content = newContent;
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
            const title = newContent.substring(0, 50) + (newContent.length > 50 ? '...' : '');
            session.title = title;
        }

        await chatDB.saveSession(session);

        // Clear edit mode
        this.editingMessageId = null;

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

        // Prevent forking if streaming
        if (this.isCurrentSessionStreaming()) {
            return;
        }

        const messages = await chatDB.getSessionMessages(session.id);
        const messageIndex = messages.findIndex(m => m.id === messageId);

        if (messageIndex === -1) return;

        // Copy messages up to and including the fork point
        const messagesToCopy = messages.slice(0, messageIndex + 1);

        // Create new session with same model and API key
        const newSessionId = this.generateId();
        const firstUserMessage = messagesToCopy.find(m => m.role === 'user');
        const title = firstUserMessage
            ? firstUserMessage.content.substring(0, 50) + (firstUserMessage.content.length > 50 ? '...' : '')
            : 'Forked Chat';

        const newSession = {
            id: newSessionId,
            title: `${title} (fork)`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            model: session.model,
            apiKey: session.apiKey, // Reuse the same ephemeral key
            apiKeyInfo: session.apiKeyInfo,
            expiresAt: session.expiresAt,
            searchEnabled: this.searchEnabled,
            forkedFrom: session.id
        };

        // Save new session
        await chatDB.saveSession(newSession);
        this.state.sessions.unshift(newSession);

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
                    sharedApiKey: !!session.apiKey
                }
            });
        }

        // Switch to new session
        this.state.currentSessionId = newSessionId;
        await chatDB.saveSetting('currentSessionId', newSessionId);

        // Clear edit state
        this.editingMessageId = null;

        this.renderSessions();
        // Scroll sidebar to top to show the new session
        if (this.sidebar) {
            this.sidebar.scrollToTop();
        }
        this.renderMessages();
        this.renderCurrentModel();

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

        this.state.sessions = [];
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
    }

    /**
     * Renders all messages for the current session (delegated to ChatArea component).
     */
    async renderMessages() {
        if (this.chatArea) {
            await this.chatArea.render();
        }
        this.updateExportPdfButtonVisibility();
        this.updateWideModeButtonVisibility();
    }

    /**
     * Updates export PDF button visibility and position.
     * Shows only when a session is active, adjusts position based on sidebar state.
     */
    updateExportPdfButtonVisibility() {
        const btn = this.elements.exportPdfBtn;
        if (!btn) return;

        const hasSession = !!this.getCurrentSession();
        const sidebarHidden = this.elements.sidebar?.classList.contains('sidebar-hidden');
        const isMobile = this.isMobileView();

        if (hasSession) {
            btn.classList.remove('hidden');
            btn.classList.add('flex');
            // Adjust position: left-14 when sidebar is hidden (to avoid overlap with show-sidebar-btn)
            if (sidebarHidden || isMobile) {
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
     * Updates wide mode button visibility and position.
     * Shows only when a session is active, adjusts position based on sidebar state.
     */
    updateWideModeButtonVisibility() {
        const btn = this.elements.wideModeBtn;
        if (!btn) return;

        const hasSession = !!this.getCurrentSession();
        const sidebarHidden = this.elements.sidebar?.classList.contains('sidebar-hidden');
        const isMobile = this.isMobileView();

        if (hasSession) {
            btn.classList.remove('hidden');
            btn.classList.add('flex');
            // Adjust position based on sidebar state
            // When sidebar hidden: show-sidebar-btn at left-4, export-pdf at left-14, wide-mode at left-24
            // When sidebar visible: export-pdf at left-4, wide-mode at left-14
            if (sidebarHidden || isMobile) {
                btn.classList.remove('left-4', 'left-14');
                btn.classList.add('left-24');
            } else {
                btn.classList.remove('left-4', 'left-24');
                btn.classList.add('left-14');
            }
        } else {
            btn.classList.add('hidden');
            btn.classList.remove('flex');
        }
    }

    /**
     * Initializes wide mode state from localStorage.
     */
    initWideMode() {
        const isWide = localStorage.getItem('oa-wide-mode') === 'true';
        if (isWide) {
            document.documentElement.classList.add('wide-mode');
            this.elements.wideModeBtn?.classList.add('wide-active');
        }
    }

    /**
     * Toggles wide mode on/off.
     */
    toggleWideMode() {
        const isWide = document.documentElement.classList.toggle('wide-mode');
        localStorage.setItem('oa-wide-mode', isWide ? 'true' : 'false');
        this.elements.wideModeBtn?.classList.toggle('wide-active', isWide);
        // Recalculate toolbar divider after max-width transition completes (200ms)
        setTimeout(() => this.updateToolbarDivider(), 200);
    }

    /**
     * Exports the current chat session to a PDF file.
     * Delegates to pdfExport service.
     */
    async exportChatToPdf() {
        if (!this.getCurrentSession()) return;

        const btn = this.elements.exportPdfBtn;
        if (btn) {
            btn.disabled = true;
            btn.classList.add('opacity-50');
        }

        try {
            const { exportToPdf } = await import('./services/pdfExport.js');
            await exportToPdf(this.elements.messagesContainer);
        } catch (error) {
            console.error('PDF export failed:', error);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.classList.remove('opacity-50');
            }
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
        this.updateExportPdfButtonVisibility();
        this.updateWideModeButtonVisibility();
        // Predict final width: sidebar is closing, main area will be WIDER
        // Only affects width on desktop, on mobile sidebar overlays
        // Grace period in updateToolbarDivider blocks intermediate updates during animation
        this.updateToolbarDivider(this.isMobileView() ? 0 : SIDEBAR_WIDTH);
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
        this.updateExportPdfButtonVisibility();
        this.updateWideModeButtonVisibility();
        // Predict final width: sidebar is opening, main area will be NARROWER
        // Only affects width on desktop, on mobile sidebar overlays
        this.updateToolbarDivider(this.isMobileView() ? 0 : -SIDEBAR_WIDTH);
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

        // Export PDF button
        if (this.elements.exportPdfBtn) {
            this.elements.exportPdfBtn.addEventListener('click', () => {
                this.exportChatToPdf();
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

            // Cmd/Ctrl + K for model picker (toggle)
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                if (this.modelPicker) {
                    this.modelPicker.toggle();
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
                        await this.handleFileUpload(filesToUpload);
                        // Focus input after file upload
                        requestAnimationFrame(() => {
                            this.elements.messageInput.focus();
                        });
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

        window.addEventListener('dragenter', (e) => {
            e.preventDefault();
            // Check if dragging files
            if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
                dragCounter++;
                if (dragCounter === 1) {
                    overlay.classList.remove('hidden');
                }
            }
        });

        window.addEventListener('dragleave', (e) => {
            e.preventDefault();
            if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
                dragCounter--;
                if (dragCounter <= 0) {
                    dragCounter = 0;
                    overlay.classList.add('hidden');
                }
            }
        });

        window.addEventListener('dragover', (e) => {
            e.preventDefault(); // Necessary to allow dropping
        });

        window.addEventListener('drop', async (e) => {
            e.preventDefault();
            dragCounter = 0;
            overlay.classList.add('hidden');

            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                const files = Array.from(e.dataTransfer.files);
                await this.handleFileUpload(files);
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
                await this.chatArea.finalizeStreamingMessage(message);
            }
        } catch (error) {
            console.debug('Error enriching citations:', error);
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
            session.apiKey = null;
            session.apiKeyInfo = null;
            session.expiresAt = null;
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
        if (this.uploadedFiles.length === 0) {
            container.classList.add('hidden');
            return;
        }

        container.classList.remove('hidden');

        // Generate previews with a horizontal card layout
        const previewPromises = this.uploadedFiles.map(async (file, index) => {
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
                const isPdf = file.type === 'application/pdf';
                const isAudio = file.type.startsWith('audio/');
                const isText = file.type.startsWith('text/') ||
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
            session.expiresAt = result.expiresAt;

            await chatDB.saveSession(session);

            // Update the UI components
            if (this.rightPanel) {
                this.rightPanel.onSessionChange(session);
            }

            return result.key;
        } catch (error) {
            console.error('Failed to automatically acquire API key:', error);
            // Pass through the original error message without wrapping
            throw error;
        }
    }

    /**
     * Toggles citation visibility for a message.
     * @param {string} messageId - The message ID
     */
    toggleCitations(messageId) {
        const contentEl = document.getElementById(`citations-content-${messageId}`);
        const chevronEl = document.querySelector(`#citations-toggle-${messageId} .citations-chevron`);

        if (contentEl && chevronEl) {
            const isHidden = contentEl.classList.contains('hidden');
            if (isHidden) {
                contentEl.classList.remove('hidden');
                chevronEl.style.transform = 'rotate(180deg)';
            } else {
                contentEl.classList.add('hidden');
                chevronEl.style.transform = 'rotate(0deg)';
            }

            // Update scroll button visibility after content change
            this.updateScrollButtonVisibility();
        }
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
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new ChatApp();
});

