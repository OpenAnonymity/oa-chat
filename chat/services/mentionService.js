/**
 * Mention Service
 * Handles @mention functionality for quick access to features like @memory
 */

import { memoryRetrievalService } from './memoryRetrievalService.js';

export class MentionService {
    constructor() {
        this.mentionPopup = null;
        this.mentionInput = null;
        this.currentQuery = '';
        this.cursorPosition = 0;
    }

    /**
     * Initialize the mention service with references to DOM elements
     * @param {HTMLElement} popup - The mention popup element
     * @param {HTMLElement} input - The message input textarea
     */
    initialize(popup, input) {
        this.mentionPopup = popup;
        this.mentionInput = input;

        // Setup click handlers for mention popup items
        if (popup) {
            popup.addEventListener('click', (e) => {
                const mentionBtn = e.target.closest('.mention-item');
                if (mentionBtn) {
                    const mentionName = mentionBtn.dataset.mention;
                    if (mentionName) {
                        this.insertMention(mentionName);
                    }
                }
            });
        }

        // Setup keyboard handlers for mention input
        if (input) {
            input.addEventListener('keydown', (e) => {
                const context = this.checkMentionContext();
                if (!context) return;

                // When user presses space after @memory, complete the mention
                if (e.key === ' ' && context.query === 'memory') {
                    // Just hide the popup, user will continue typing their query
                    this.hideMentionPopup();
                }

                // When user presses Enter with @memory <query>, trigger retrieval
                if (e.key === 'Enter' && context.query.startsWith('memory ')) {
                    e.preventDefault();
                    const app = window.app;
                    if (app) {
                        this.invokeMemoryMention(app);
                    }
                }
            });
        }
    }

    /**
     * Check if the current cursor position contains an @ mention
     * @returns {Object|null} - { start, end, query } or null if not in mention mode
     */
    checkMentionContext() {
        if (!this.mentionInput) return null;

        const text = this.mentionInput.value;
        const cursorPos = this.mentionInput.selectionStart;

        // Find the last @ before cursor
        let atIndex = -1;
        for (let i = cursorPos - 1; i >= 0; i--) {
            if (text[i] === '@') {
                atIndex = i;
                break;
            }
            // If we hit a space or newline, stop looking
            if (text[i] === ' ' || text[i] === '\n') {
                break;
            }
        }

        if (atIndex === -1) return null;

        // Extract the query after @ (don't trim to preserve empty state)
        const query = text.substring(atIndex + 1, cursorPos);

        // Return context
        return {
            start: atIndex,
            end: cursorPos,
            query: query
        };
    }

    /**
     * Show the mention popup with suggestions
     * @param {Object} context - The mention context from checkMentionContext
     */
    showMentionPopup(context) {
        if (!this.mentionPopup || !this.mentionInput) return;

        // Filter available mentions based on query
        const mentions = this.getAvailableMentions();
        const filtered = mentions.filter(m =>
            m.name.toLowerCase().includes(context.query.toLowerCase())
        );

        // Don't show if no matches
        if (filtered.length === 0) {
            this.hideMentionPopup();
            return;
        }

        // Render mention list
        this.renderMentionList(filtered);

        // Position above the input container
        const inputRect = this.mentionInput.getBoundingClientRect();
        const parentRect = this.mentionInput.closest('.rounded-md')?.getBoundingClientRect() || inputRect;
        
        this.mentionPopup.style.left = `${parentRect.left}px`;
        this.mentionPopup.style.bottom = `${window.innerHeight - parentRect.top + 8}px`;
        this.mentionPopup.style.width = 'auto';
        this.mentionPopup.style.minWidth = '120px';
        this.mentionPopup.style.maxWidth = '240px';
        
        this.mentionPopup.classList.remove('hidden');
    }

    /**
     * Hide the mention popup
     */
    hideMentionPopup() {
        if (!this.mentionPopup) return;
        this.mentionPopup.classList.add('hidden');
    }

    /**
     * Get available mentions (placeholder for now)
     * @returns {Array} - Array of mention objects { name, icon, description }
     */
    getAvailableMentions() {
        return [
            // More mentions can be added here in the future
        ];
    }

    /**
     * Render the mention list in the popup
     * @param {Array} mentions - Filtered mention list
     */
    renderMentionList(mentions) {
        if (!this.mentionPopup) return;

        const list = this.mentionPopup.querySelector('.mention-list');
        if (!list) return;

        list.innerHTML = mentions.map((mention, index) => `
            <button
                class="mention-item"
                data-mention="${mention.name}"
                data-index="${index}"
                type="button"
            >
                @${mention.name}
            </button>
        `).join('');
    }

    /**
     * Insert a mention into the input
     * @param {string} mentionName - The name of the mention (e.g., 'memory')
     */
    insertMention(mentionName) {
        console.log('Inserting mention:', mentionName);
        if (!this.mentionInput) return;

        const context = this.checkMentionContext();
        if (!context) {
            console.log('No mention context found');
            return;
        }

        // Insert the mention text (e.g., "@memory ") into the input
        const input = this.mentionInput;
        const text = input.value;
        const beforeMention = text.substring(0, context.start);
        const afterMention = text.substring(context.end);
        
        const mentionText = `@${mentionName} `;
        input.value = beforeMention + mentionText + afterMention;
        
        // Set cursor position after the mention
        const cursorPos = context.start + mentionText.length;
        input.selectionStart = cursorPos;
        input.selectionEnd = cursorPos;
        
        // Update input height for autosize
        input.style.height = '24px';
        input.style.height = Math.min(input.scrollHeight, 384) + 'px';
        
        // Close the popup
        console.log('Inserted @' + mentionName + ', closing popup');
        this.hideMentionPopup();
        
        // Focus input so user can continue typing
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /**
     * Handle the mention action
     * @param {string} mentionName - The name of the mention
     */
    handleMention(mentionName) {
        console.log(`Mention handler invoked for: @${mentionName}`);

        // Get app instance from global window
        const app = window.app;
        
        if (!app) {
            console.error('ChatApp instance not found');
            return;
        }

        // Placeholder - actual functionality will be added here
        switch (mentionName.toLowerCase()) {
            case 'memory':
                this.invokeMemoryMention(app);
                break;
            default:
                console.warn(`Unknown mention: @${mentionName}`);
        }
    }

    /**
     * Invoke @memory mention functionality
     * @param {Object} app - ChatApp instance
     */
    async invokeMemoryMention(app) {
        console.log('Invoking @memory mention');
        
        // Get the current user message (everything after @memory)
        const input = this.mentionInput;
        if (!input) return;

        const text = input.value;
        const context = this.checkMentionContext();
        
        if (!context) {
            app.showToast?.('@memory not found', 'error');
            return;
        }

        // Extract the query after @memory
        const mentionStart = context.start + 7; // length of "@memory"
        const userQuery = text.substring(mentionStart).trim();

        if (!userQuery) {
            app.showToast?.('Please provide a query after @memory', 'info');
            return;
        }

        try {
            // Remove @memory from the input
            input.value = text.substring(0, context.start) + text.substring(context.end);
            input.style.height = '24px';
            input.style.height = Math.min(input.scrollHeight, 384) + 'px';
            input.dispatchEvent(new Event('input', { bubbles: true }));

            // Call memory retrieval with the user query
            await memoryRetrievalService.handleMemoryMention(userQuery, app);
        } catch (error) {
            console.error('Memory mention failed:', error);
            app.showToast?.(
                error.message || 'Failed to process memory',
                'error'
            );
        }
    }
}

// Export singleton instance
export const mentionService = new MentionService();
