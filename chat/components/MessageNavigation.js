// Message Navigation Component
export default class MessageNavigation {
    constructor(app) {
        this.app = app;
        this.currentMessageIndex = 0;
        this.messages = [];
        this.container = null;
        this.isVisible = false;
        this.hideTimeout = null;
        this.isNavigating = false; // Flag to prevent scroll handler from overriding click navigation
        this.clickedIndex = null; // Tracks user-clicked bar, null = use viewport-based detection
        this.awaitingScrollEnd = false; // True while waiting for programmatic scroll to finish
        this.scrollEndTimer = null;

        this.init();
    }

    init() {
        this.createNavigationUI();
        this.setupEventListeners();
    }

    createNavigationUI() {
        // Create navigation container
        const nav = document.createElement('div');
        nav.id = 'message-navigation';
        nav.className = 'message-navigation hidden';
        nav.innerHTML = `
            <button id="prev-message-btn" class="nav-btn" aria-label="Previous message" title="Previous message (↑)">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                </svg>
            </button>
            <div id="message-indicators" class="message-indicators"></div>
            <button id="next-message-btn" class="nav-btn" aria-label="Next message" title="Next message (↓)">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
            </button>
        `;

        // Add to chat area
        const chatArea = document.getElementById('chat-area');
        if (chatArea) {
            chatArea.appendChild(nav);
            this.container = nav;
        }
    }

    setupEventListeners() {
        const prevBtn = document.getElementById('prev-message-btn');
        const nextBtn = document.getElementById('next-message-btn');

        if (prevBtn) {
            prevBtn.addEventListener('click', () => this.navigateToPrevious());
        }

        if (nextBtn) {
            nextBtn.addEventListener('click', () => this.navigateToNext());
        }

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            // Only handle when navigation is visible and no input is focused
            if (!this.isVisible || document.activeElement.tagName === 'TEXTAREA' ||
                document.activeElement.tagName === 'INPUT') {
                return;
            }

            // Arrow Up - Previous message
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.navigateToPrevious();
            }

            // Arrow Down - Next message
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.navigateToNext();
            }
        });
    }

    async update() {
        const session = this.app.getCurrentSession();
        if (!session) {
            this.hide();
            return;
        }

        // Get messages from database
        const messages = await chatDB.getSessionMessages(session.id);

        // Filter to only assistant messages for navigation
        this.messages = messages.filter(m => m.role === 'assistant');

        // Hide if fewer than 2 assistant messages
        if (this.messages.length < 2) {
            this.hide();
            return;
        }

        // Show navigation
        this.show();
        this.renderIndicators();
        this.updateCurrentMessageIndex();
    }

    renderIndicators() {
        const indicatorsContainer = document.getElementById('message-indicators');
        if (!indicatorsContainer) return;

        indicatorsContainer.innerHTML = this.messages.map((msg, index) => {
            const isCurrent = index === this.currentMessageIndex;
            const barHeight = this.calculateBarHeight(msg.content || '');
            return `
                <button
                    class="message-indicator ${isCurrent ? 'active' : ''}"
                    data-message-index="${index}"
                    data-message-id="${msg.id}"
                    aria-label="Jump to message ${index + 1}"
                    aria-current="${isCurrent}"
                    style="height: ${barHeight}px"
                ></button>
            `;
        }).join('');

        // Add click handlers for indicators
        indicatorsContainer.querySelectorAll('.message-indicator').forEach(btn => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.messageIndex);
                this.navigateToMessage(index);
            });

            // Show preview popover on hover
            btn.addEventListener('mouseenter', () => {
                this.cancelHideTimeout();
                const index = parseInt(btn.dataset.messageIndex);
                this.showPreview(btn, index);
            });

            btn.addEventListener('mouseleave', () => {
                this.scheduleHidePreview();
            });
        });
    }

    calculateBarHeight(content) {
        const length = content.length;
        // Height indicates message length (compact)
        if (length < 100) return 3;
        if (length < 300) return 5;
        if (length < 600) return 7;
        if (length < 1000) return 9;
        if (length < 2000) return 12;
        if (length < 4000) return 15;
        return 18;
    }

    showPreview(button, messageIndex) {
        const message = this.messages[messageIndex];
        if (!message) return;

        // Remove existing popover immediately (no delay for replacement)
        this.hidePreviewImmediate();

        // Create popover
        const popover = document.createElement('div');
        popover.id = 'message-preview-popover';
        popover.className = 'message-preview-popover';

        // Get preview text (first 200 chars)
        const previewText = message.content.substring(0, 200) + (message.content.length > 200 ? '…' : '');

        // Process markdown/latex like the main chat area
        const processedContent = this.app.processContentWithLatex(previewText);

        popover.innerHTML = `
            <div class="popover-header">Message ${messageIndex + 1}</div>
            <div class="popover-content message-content prose prose-sm">${processedContent}</div>
        `;

        document.body.appendChild(popover);

        // Add hover handlers to keep popover visible when mouse enters it
        popover.addEventListener('mouseenter', () => this.cancelHideTimeout());
        popover.addEventListener('mouseleave', () => this.scheduleHidePreview());

        // Render LaTeX in the popover content
        const contentEl = popover.querySelector('.popover-content');
        if (contentEl && typeof renderMathInElement === 'function') {
            renderMathInElement(contentEl, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '\\[', right: '\\]', display: true},
                    {left: '\\(', right: '\\)', display: false}
                ],
                throwOnError: false
            });
        }

        // Position popover to the left of navigation
        const navRect = this.container.getBoundingClientRect();

        popover.style.position = 'fixed';
        popover.style.right = (window.innerWidth - navRect.left + 16) + 'px';
        popover.style.top = navRect.top + (navRect.height / 2) + 'px';
        popover.style.transform = 'translateY(-50%)';

        // Ensure popover doesn't go off-screen
        const finalRect = popover.getBoundingClientRect();
        if (finalRect.top < 10) {
            popover.style.top = '10px';
            popover.style.transform = 'none';
        }
        if (finalRect.bottom > window.innerHeight - 10) {
            popover.style.top = 'auto';
            popover.style.bottom = '10px';
            popover.style.transform = 'none';
        }
    }

    scheduleHidePreview() {
        this.cancelHideTimeout();
        this.hideTimeout = setTimeout(() => this.hidePreviewImmediate(), 150);
    }

    cancelHideTimeout() {
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }
    }

    hidePreviewImmediate() {
        this.cancelHideTimeout();
        const popover = document.getElementById('message-preview-popover');
        if (popover) {
            popover.remove();
        }
    }

    hidePreview() {
        this.hidePreviewImmediate();
    }

    updateCurrentMessageIndex() {
        // Get the currently visible message in viewport
        const messageElements = document.querySelectorAll('[data-message-id]');
        const chatArea = document.getElementById('chat-area');

        if (!chatArea || messageElements.length === 0) return;

        const viewportMiddle = chatArea.scrollTop + (chatArea.clientHeight / 2);

        let closestIndex = 0;
        let closestDistance = Infinity;

        messageElements.forEach((el, index) => {
            const messageId = el.dataset.messageId;
            const msgIndex = this.messages.findIndex(m => m.id === messageId);

            if (msgIndex !== -1) {
                const rect = el.getBoundingClientRect();
                const elementMiddle = el.offsetTop + (rect.height / 2);
                const distance = Math.abs(elementMiddle - viewportMiddle);

                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestIndex = msgIndex;
                }
            }
        });

        this.currentMessageIndex = closestIndex;
        this.updateIndicators();
    }

    updateIndicators() {
        const activeIndex = this.clickedIndex !== null ? this.clickedIndex : this.currentMessageIndex;
        const indicators = document.querySelectorAll('.message-indicator');
        indicators.forEach((indicator, index) => {
            if (index === activeIndex) {
                indicator.classList.add('active');
                indicator.setAttribute('aria-current', 'true');
            } else {
                indicator.classList.remove('active');
                indicator.setAttribute('aria-current', 'false');
            }
        });
    }

    navigateToPrevious() {
        if (this.currentMessageIndex > 0) {
            this.navigateToMessage(this.currentMessageIndex - 1);
        }
    }

    navigateToNext() {
        if (this.currentMessageIndex < this.messages.length - 1) {
            this.navigateToMessage(this.currentMessageIndex + 1);
        }
    }

    navigateToMessage(index) {
        if (index < 0 || index >= this.messages.length) return;

        // Set flag to prevent scroll handler from overriding during navigation
        this.isNavigating = true;
        this.clickedIndex = index; // Remember which bar was clicked

        this.currentMessageIndex = index;
        const message = this.messages[index];

        // Scroll to message with custom logic to avoid scrolling past content bounds
        const messageElement = document.querySelector(`[data-message-id="${message.id}"]`);
        const chatArea = document.getElementById('chat-area');
        const toolbar = document.getElementById('chat-toolbar');

        if (messageElement && chatArea) {
            const messageTop = messageElement.offsetTop;
            const viewportHeight = chatArea.clientHeight;
            const maxScroll = chatArea.scrollHeight - viewportHeight;

            // Account for toolbar height + small gap so message appears below it with spacing
            const toolbarHeight = toolbar ? toolbar.offsetHeight : 0;
            const gap = 12; // Small gap between toolbar and message

            // Calculate target: put message top below toolbar with gap, but clamp to valid scroll range
            let targetScroll = messageTop - toolbarHeight - gap;
            targetScroll = Math.min(targetScroll, maxScroll); // Don't scroll past bottom
            targetScroll = Math.max(targetScroll, 0); // Don't scroll past top

            chatArea.scrollTo({ top: targetScroll, behavior: 'smooth' });
        }

        this.updateIndicators();

        // Clear navigation flag after initial delay, then wait for scroll to truly stop
        setTimeout(() => {
            this.isNavigating = false;
            this.awaitingScrollEnd = true; // Still waiting for scroll animation to finish
        }, 300);
    }

    show() {
        if (this.container) {
            this.container.classList.remove('hidden');
            this.isVisible = true;
        }
    }

    hide() {
        if (this.container) {
            this.container.classList.add('hidden');
            this.isVisible = false;
        }
        this.hidePreview();
        // Clear indicators when hiding to prevent showing stale data
        const indicatorsContainer = document.getElementById('message-indicators');
        if (indicatorsContainer) {
            indicatorsContainer.innerHTML = '';
        }
        this.messages = [];
        this.currentMessageIndex = 0;
        this.clickedIndex = null;
        this.awaitingScrollEnd = false;
        clearTimeout(this.scrollEndTimer);
    }

    // Track scroll position to update current message
    handleScroll() {
        if (!this.isVisible) return;
        if (this.isNavigating) return; // Still in programmatic scroll

        // If waiting for scroll animation to end, use debounce to detect scroll stop
        if (this.awaitingScrollEnd) {
            clearTimeout(this.scrollEndTimer);
            this.scrollEndTimer = setTimeout(() => {
                this.awaitingScrollEnd = false;
            }, 150); // Scroll has stopped for 150ms, ready to track manual scroll
            return;
        }

        // User is scrolling manually - clear clicked state
        this.clickedIndex = null;
        this.updateCurrentMessageIndex();
    }
}

