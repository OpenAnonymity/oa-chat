/**
 * ShareModals Component
 * Handles all share-related modal UI (create, import, update, revoke)
 * Following the same pattern as ProxyInfoModal.js and TLSSecurityModal.js
 */

import shareService from '../services/shareService.js';

// LocalStorage keys for share preferences
const PASSWORD_MODE_KEY = 'oa-share-password-mode';
const EXPIRY_TTL_KEY = 'oa-share-expiry-ttl';
const CUSTOM_EXPIRY_VALUE_KEY = 'oa-share-custom-expiry-value';
const CUSTOM_EXPIRY_UNIT_KEY = 'oa-share-custom-expiry-unit';

// TTL preset options for segmented control
const TTL_PRESETS = [
    { value: 86400, label: '1 day', short: '1d' },
    { value: 604800, label: '7 days', short: '7d' },
    { value: 2592000, label: '30 days', short: '30d' },
    { value: 0, label: 'Indefinite', short: '∞' }
];

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Process content with markdown for preview (truncated, simplified)
 * Uses window.app.processContentWithLatex if available, falls back to marked or escapeHtml
 */
function processPreviewContent(text) {
    if (!text) return '';
    // Use app's processor if available (handles LaTeX + markdown)
    if (window.app?.processContentWithLatex) {
        return window.app.processContentWithLatex(text);
    }
    // Fallback: use marked directly if available
    if (typeof marked !== 'undefined') {
        return marked.parse(text);
    }
    return escapeHtml(text);
}

/**
 * Apply LaTeX rendering to an element's message-content children
 */
function renderLatexInElement(container) {
    if (typeof renderMathInElement !== 'function') return;
    container.querySelectorAll('.message-content').forEach(el => {
        renderMathInElement(el, {
            delimiters: [
                {left: '$$', right: '$$', display: true},
                {left: '\\[', right: '\\]', display: true},
                {left: '\\(', right: '\\)', display: false}
            ],
            throwOnError: false
        });
    });
}

/**
 * Format TTL seconds to human-readable string
 */
function formatTtl(seconds) {
    if (!seconds || seconds === 0) return 'Never';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} hour${seconds >= 7200 ? 's' : ''}`;
    return `${Math.round(seconds / 86400)} day${seconds >= 172800 ? 's' : ''}`;
}

/**
 * Format API key expiry as relative time (e.g., "in 2h", "in 30m")
 * @param {number|string} expiresAt - Expiry timestamp (ms) or ISO date string
 * @returns {{text: string, isExpired: boolean}}
 */
function formatKeyExpiry(expiresAt) {
    if (!expiresAt) return { text: '', isExpired: false };

    const now = Date.now();
    // Handle both timestamp (number) and ISO string formats
    const expiryMs = typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime();
    const diff = expiryMs - now;

    if (diff <= 0) {
        return { text: 'expired', isExpired: true };
    }

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    let text;
    if (days > 0) {
        text = `in ${days}d`;
    } else if (hours > 0) {
        text = `in ${hours}h`;
    } else if (minutes > 0) {
        text = `in ${minutes}m`;
    } else {
        text = 'in <1m';
    }

    return { text, isExpired: false };
}

/**
 * Get saved password mode preference
 */
function getPasswordMode() {
    return localStorage.getItem(PASSWORD_MODE_KEY) || 'pin';
}

/**
 * Save password mode preference
 */
function setPasswordMode(mode) {
    localStorage.setItem(PASSWORD_MODE_KEY, mode);
}

/**
 * Get saved expiry TTL preference
 */
function getExpiryTtl() {
    const saved = localStorage.getItem(EXPIRY_TTL_KEY);
    return saved !== null ? parseInt(saved, 10) : 604800; // Default to 7 days
}

/**
 * Save expiry TTL preference
 */
function setExpiryTtl(ttl) {
    localStorage.setItem(EXPIRY_TTL_KEY, ttl.toString());
}

/**
 * Get saved custom expiry value
 */
function getCustomExpiryValue() {
    const saved = localStorage.getItem(CUSTOM_EXPIRY_VALUE_KEY);
    return saved !== null ? parseInt(saved, 10) : 1;
}

/**
 * Get saved custom expiry unit
 */
function getCustomExpiryUnit() {
    return localStorage.getItem(CUSTOM_EXPIRY_UNIT_KEY) || '86400';
}

/**
 * Save custom expiry value and unit
 */
function setCustomExpiry(value, unit) {
    localStorage.setItem(CUSTOM_EXPIRY_VALUE_KEY, value.toString());
    localStorage.setItem(CUSTOM_EXPIRY_UNIT_KEY, unit);
}

/**
 * Sanitize PIN input - strip non-alphanumeric characters
 */
function sanitizePinInput(value) {
    return value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6);
}

const PIN_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateRandomPin(length = 6) {
    const output = [];
    const max = 256 - (256 % PIN_CHARSET.length);

    while (output.length < length) {
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        for (let i = 0; i < bytes.length && output.length < length; i++) {
            const value = bytes[i];
            if (value < max) {
                output.push(PIN_CHARSET[value % PIN_CHARSET.length]);
            }
        }
    }

    return output.join('');
}

/**
 * Password visibility toggle icon SVGs
 */
const EYE_CLOSED_SVG = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
</svg>`;

const EYE_OPEN_SVG = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
</svg>`;

const RANDOM_ICON_SVG = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <circle cx="9" cy="9" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="15" cy="15" r="0.9" fill="currentColor" stroke="none" />
</svg>`;

const COPY_ICON_SVG = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
</svg>`;

const CHECK_ICON_SVG = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
</svg>`;

const LINK_ICON_SVG = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
</svg>`;

const LINK_ICON_SMALL_SVG = `<svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
</svg>`;

const UPLOAD_ICON_SVG = `<svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
</svg>`;

/**
 * Build info row HTML for share modal status panels
 */
function buildInfoRow(label, valueHtml, marginClass = 'mb-3') {
    return `
        <div class="${marginClass}">
            <div class="flex items-center justify-between">
                <label class="text-xs text-muted-foreground">${label}</label>
                ${valueHtml}
            </div>
        </div>
    `;
}

/**
 * Build preview container HTML for share modals
 */
function buildPreviewContainerHtml(previewHtml, label = 'Shared content preview') {
    if (!previewHtml) return '';
    return `
        <div class="mb-4 rounded-lg border border-border/50 overflow-hidden">
            <div class="flex items-center gap-1.5 text-xs text-muted-foreground px-2.5 py-1.5 bg-muted/30 border-b border-border/30">
                ${UPLOAD_ICON_SVG}
                ${label}
            </div>
            <div class="share-cutoff-chat max-h-32 overflow-y-auto py-2 px-2 flex flex-col gap-1">
                ${previewHtml}
            </div>
        </div>
    `;
}

/**
 * Build the shared status panel HTML for after-sharing and share control views
 * @param {Object} opts - {isPlaintext, apiKeyShared, apiKeyExpiresAt, isExpired, expiryDate, messageCount, shareUrl, previewHtml}
 */
function buildStatusPanelHtml(opts) {
    const { isPlaintext, apiKeyShared, apiKeyExpiresAt, isExpired, expiryDate, messageCount, shareUrl, previewHtml } = opts;

    // Format API key expiry as relative time
    const keyExpiry = apiKeyExpiresAt ? formatKeyExpiry(apiKeyExpiresAt) : null;
    const statusText = isExpired ? 'Expired' : 'Active';
    const statusClass = isExpired ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400';

    const encryptionValue = isPlaintext
        ? '<span class="text-xs text-foreground">None</span>'
        : '<span class="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Encrypted</span>';

    const apiKeyValue = apiKeyShared
        ? (keyExpiry
            ? (keyExpiry.isExpired
                ? '<span class="text-amber-600 dark:text-amber-400">Included (expired)</span>'
                : `<span class="text-xs text-foreground">Included (expires ${keyExpiry.text})</span>`)
            : '<span class="text-xs text-foreground">Included</span>')
        : '<span class="text-xs text-foreground">Not included</span>';

    return `
        <!-- Content section that grows -->
        <div class="flex-1">
            ${buildInfoRow('Sharing Status', `<span class="text-sm font-medium ${statusClass}">${statusText}</span>`)}
            ${buildInfoRow('Encrypted Sharing', encryptionValue)}
            ${buildInfoRow('Expires', `<span class="text-xs text-foreground">${expiryDate || 'Never'}</span>`)}
            ${buildInfoRow('Messages', `<span class="text-xs text-foreground">${messageCount || 0}</span>`)}
            ${buildInfoRow('Session API key', apiKeyValue, 'mb-4')}

            <!-- Share link box -->
            <div class="mb-4 rounded-lg border border-border/50 overflow-hidden">
                <div class="flex items-center gap-1.5 text-xs text-muted-foreground px-2.5 py-1.5 bg-muted/30 border-b border-border/30">
                    ${LINK_ICON_SMALL_SVG}
                    Share link
                </div>
                <div class="px-2.5 py-2 flex items-center gap-2">
                    <input type="text" readonly class="share-url-input flex-1 text-xs bg-transparent text-foreground/80 outline-none truncate" value="${shareUrl}">
                </div>
            </div>

            ${buildPreviewContainerHtml(previewHtml, 'Shared content preview')}
        </div>

        <!-- Bottom buttons (equally spaced) -->
        <div class="flex justify-between items-center mt-auto">
            <button id="done-btn" class="btn-ghost-hover px-4 py-1.5 text-sm rounded-md border border-border bg-background text-foreground transition-colors">
                Done
            </button>
            <button id="revoke-btn" class="btn-destructive-bright inline-flex items-center justify-center rounded-md bg-destructive px-4 py-1.5 text-sm font-medium text-destructive-foreground shadow-sm transition-all duration-200">
                Stop Sharing
            </button>
            <button id="copy-link-btn" class="btn-primary-bright px-4 py-1.5 text-sm rounded-md bg-blue-600 text-white transition-all duration-200 flex items-center gap-1.5">
                ${COPY_ICON_SVG}
                <span>Copy link</span>
            </button>
        </div>
    `;
}

/**
 * Build expired share panel with "Share Again" button
 */
function buildExpiredPanelHtml(opts) {
    const { expiryDate, messageCount, previewHtml } = opts;

    return `
        <!-- Content section that grows -->
        <div class="flex-1">
            ${buildInfoRow('Sharing status', '<span class="text-sm font-medium text-amber-600 dark:text-amber-400">Expired</span>')}
            ${buildInfoRow('Expired on', `<span class="text-xs text-foreground">${expiryDate || 'Unknown'}</span>`)}
            ${buildInfoRow('Messages', `<span class="text-xs text-foreground">${messageCount || 0}</span>`, 'mb-4')}
            ${buildPreviewContainerHtml(previewHtml, 'Content preview')}
        </div>

        <!-- Bottom buttons (consistent positions with form) -->
        <div class="flex justify-between mt-auto">
            <button id="close-btn" class="btn-ghost-hover px-4 py-1.5 text-sm rounded-md border border-border bg-background text-foreground transition-colors">
                Cancel
            </button>
            <button id="share-again-btn" class="px-4 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors">
                Share Again
            </button>
        </div>
    `;
}

class ShareModals {
    constructor() {
        this.currentModal = null;
    }

    /**
     * Clean up current modal
     */
    cleanup() {
        if (this._escapeHandler) {
            document.removeEventListener('keydown', this._escapeHandler);
            this._escapeHandler = null;
        }
        if (this._restoreMainInput) {
            this._restoreMainInput();
            this._restoreMainInput = null;
        }
        if (this.currentModal) {
            this.currentModal.remove();
            this.currentModal = null;
        }
    }

    /**
     * Create modal container with backdrop
     */
    createModalContainer(className = '') {
        const modal = document.createElement('div');
        modal.className = `fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm fade-in ${className}`;
        this.currentModal = modal;
        document.body.appendChild(modal);

        // Prevent main input from stealing focus while modal is open
        const mainInput = document.getElementById('message-input');
        if (mainInput) {
            mainInput.setAttribute('tabindex', '-1');
            this._restoreMainInput = () => mainInput.removeAttribute('tabindex');
        }

        // Focus trap: keep focus within modal
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                const focusable = modal.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
                if (focusable.length === 0) return;

                const first = focusable[0];
                const last = focusable[focusable.length - 1];

                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        });

        return modal;
    }

    /**
     * Setup password toggle functionality (uses CSS masking since type="text" to avoid password managers)
     */
    setupPasswordToggle(container) {
        const toggleBtn = container.querySelector('.toggle-password-btn');
        const passwordInput = container.querySelector('.password-input');
        if (!toggleBtn || !passwordInput) return;

        // Prevent button from stealing focus
        toggleBtn.onmousedown = (e) => e.preventDefault();

        // Default: password is shown (not masked)
        toggleBtn.onclick = () => {
            const isMasked = passwordInput.classList.contains('text-masked');
            passwordInput.classList.toggle('text-masked');
            // When masked: show eye-closed, hide eye-open
            // When shown: show eye-open, hide eye-closed
            toggleBtn.querySelector('.eye-open')?.classList.toggle('hidden', !isMasked);
            toggleBtn.querySelector('.eye-closed')?.classList.toggle('hidden', isMasked);
        };
    }

    /**
     * Setup PIN input with visual boxes
     */
    setupPinInput(container) {
        const pinInput = container.querySelector('.pin-hidden-input');
        const boxes = container.querySelectorAll('.pin-box');
        const toggleBtn = container.querySelector('.toggle-pin-visibility');
        const randomBtn = container.querySelector('.random-pin-btn');
        if (!pinInput || !boxes.length) return;

        let isRevealed = true; // Show PIN by default (low-stakes sharing)

        const updateBoxes = () => {
            const value = pinInput.value;
            boxes.forEach((box, i) => {
                const char = value[i] || '';
                if (char) {
                    box.textContent = isRevealed ? char : '•';
                    box.classList.add('filled');
                } else {
                    box.textContent = '';
                    box.classList.remove('filled');
                }
                // Highlight current box
                box.classList.toggle('active', i === value.length && value.length < 6);
            });
        };

        // Handle input
        pinInput.addEventListener('input', (e) => {
            pinInput.value = sanitizePinInput(e.target.value);
            updateBoxes();
        });

        // Handle paste
        pinInput.addEventListener('paste', (e) => {
            e.preventDefault();
            const pasted = (e.clipboardData || window.clipboardData).getData('text');
            pinInput.value = sanitizePinInput(pasted);
            updateBoxes();
        });

        // Click on container focuses input
        container.querySelector('.pin-input-container')?.addEventListener('click', () => {
            pinInput.focus();
        });

        // Toggle visibility - prevent button from stealing focus
        if (toggleBtn) {
            toggleBtn.onmousedown = (e) => e.preventDefault();
            toggleBtn.onclick = () => {
                isRevealed = !isRevealed;
                toggleBtn.querySelector('.eye-open')?.classList.toggle('hidden', !isRevealed);
                toggleBtn.querySelector('.eye-closed')?.classList.toggle('hidden', isRevealed);
                updateBoxes();
            };
        }

        if (randomBtn) {
            randomBtn.onmousedown = (e) => e.preventDefault();
            randomBtn.onclick = () => {
                pinInput.value = generateRandomPin();
                updateBoxes();
                pinInput.focus();
            };
        }

        // Initial state
        updateBoxes();
    }

    /**
     * Setup expiry segmented control
     */
    setupExpiryToggle(container, initialValue = 604800) {
        const toggleContainer = container.querySelector('.expiry-toggle-container');
        const buttons = container.querySelectorAll('.expiry-toggle-btn');
        const indicator = container.querySelector('.expiry-toggle-indicator');
        const customContainer = container.querySelector('.expiry-custom-container');
        const customValue = container.querySelector('.expiry-custom-value');
        const customUnit = container.querySelector('.expiry-custom-unit');

        if (!buttons.length || !indicator || !toggleContainer) return;

        // Find initial selection
        let selectedIndex = TTL_PRESETS.findIndex(p => p.value === initialValue);
        const isCustomInitial = selectedIndex === -1 && initialValue !== 604800 && initialValue !== 0;
        if (selectedIndex === -1) selectedIndex = 1; // Default to 7 days

        const updateIndicator = (index) => {
            const isCustom = index === buttons.length - 1;
            const btn = buttons[index];
            if (btn) {
                const containerRect = toggleContainer.getBoundingClientRect();
                const btnRect = btn.getBoundingClientRect();
                indicator.style.width = `${btnRect.width}px`;
                indicator.style.transform = `translateX(${btnRect.left - containerRect.left - 3}px)`;
            }

            // Update aria states
            buttons.forEach((b, i) => {
                b.setAttribute('aria-checked', i === index ? 'true' : 'false');
            });

            // Show/hide custom input
            if (customContainer) {
                customContainer.classList.toggle('hidden', !isCustom);
                if (isCustom && customValue && customUnit) {
                    // Pre-fill with saved custom values
                    customValue.value = getCustomExpiryValue();
                    customUnit.value = getCustomExpiryUnit();
                    setTimeout(() => customValue.focus(), 100);
                }
            }
        };

        // Save custom values when changed and handle Enter key
        if (customValue && customUnit) {
            const saveCustom = () => {
                const val = parseInt(customValue.value, 10) || 1;
                const unit = customUnit.value;
                setCustomExpiry(val, unit);
            };
            customValue.addEventListener('input', saveCustom);
            customUnit.addEventListener('change', saveCustom);

            // Enter key triggers submit button
            customValue.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const submitBtn = container.querySelector('#submit-btn, #confirm-btn');
                    submitBtn?.click();
                }
            });
        }

        buttons.forEach((btn, index) => {
            btn.onclick = () => {
                selectedIndex = index;
                updateIndicator(index);
                // Save preference (for presets, not custom)
                if (index < TTL_PRESETS.length) {
                    setExpiryTtl(TTL_PRESETS[index].value);
                }
            };
        });

        // Set initial state
        if (isCustomInitial) {
            selectedIndex = buttons.length - 1; // Custom
            // Pre-fill custom values
            if (customValue && customUnit) {
                if (initialValue >= 86400) {
                    customValue.value = Math.round(initialValue / 86400);
                    customUnit.value = '86400';
                } else if (initialValue >= 3600) {
                    customValue.value = Math.round(initialValue / 3600);
                    customUnit.value = '3600';
                } else {
                    customValue.value = Math.round(initialValue / 60);
                    customUnit.value = '60';
                }
            }
        }
        // Set initial position without animation
        requestAnimationFrame(() => {
            indicator.style.transition = 'none';
            updateIndicator(selectedIndex);
            // Re-enable transitions after a frame
            requestAnimationFrame(() => {
                indicator.style.transition = '';
            });
        });

        return () => {
            const isCustom = selectedIndex === buttons.length - 1;
            if (isCustom && customValue && customUnit) {
                const val = parseInt(customValue.value, 10) || 1;
                const unit = parseInt(customUnit.value, 10) || 86400;
                return Math.max(60, Math.min(val * unit, 2592000));
            }
            const preset = TTL_PRESETS[selectedIndex];
            return preset !== undefined ? preset.value : 604800;
        };
    }

    /**
     * Setup action handlers for status panel (shared between initial render and after-share)
     */
    setupStatusPanelHandlers(modal, shareUrl, onRevoke, showToast, showFormCallback) {
        const copyBtn = modal.querySelector('#copy-link-btn');
        const revokeBtn = modal.querySelector('#revoke-btn');
        const doneBtn = modal.querySelector('#done-btn');
        const urlInput = modal.querySelector('.share-url-input');

        // Select URL on click for easy copying
        urlInput?.addEventListener('click', () => urlInput.select());

        // Done button closes the modal
        doneBtn?.addEventListener('click', () => this.cleanup());

        copyBtn?.addEventListener('click', async () => {
            await navigator.clipboard.writeText(shareUrl);
            const spanEl = copyBtn.querySelector('span');
            const originalText = spanEl?.textContent;
            if (spanEl) spanEl.textContent = 'Copied!';
            setTimeout(() => {
                if (spanEl) spanEl.textContent = originalText;
            }, 2000);
        });

        // Stop Sharing revokes and shows the pre-share form
        revokeBtn?.addEventListener('click', async () => {
            await onRevoke();
            showToast('Share revoked', 'success');
            // Show the pre-share form instead of closing
            if (showFormCallback) {
                showFormCallback();
            }
        });
    }

    // =========================================================================
    // IMPORT MODALS
    // =========================================================================

    /**
     * Show prompt when user opens a share they've previously forked
     */
    showForkedPrompt(forkedSession) {
        return new Promise((resolve) => {
            const modal = this.createModalContainer();
            modal.innerHTML = `
                <div class="bg-background border border-border rounded-xl shadow-2xl p-6 max-w-md mx-4 w-full">
                    <h3 class="text-lg font-semibold text-foreground mb-2">You Have a Local Copy</h3>
                    <p class="text-sm text-muted-foreground mb-4">
                        You previously imported this shared chat and made your own changes as "<strong>${escapeHtml(forkedSession.title)}</strong>".
                    </p>
                    <div class="flex flex-col gap-2">
                        <button id="use-forked-btn" class="w-full px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                            Open My Copy <span class="opacity-60 ml-1">(Enter)</span>
                        </button>
                        <button id="fetch-fresh-btn" class="w-full px-4 py-2 text-sm font-medium rounded-lg border border-border text-foreground hover:bg-muted transition-colors">
                            Fetch Fresh Copy
                        </button>
                    </div>
                </div>
            `;

            const handleKeydown = (e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                    e.preventDefault();
                    finish(false);
                }
            };

            const finish = (result) => {
                document.removeEventListener('keydown', handleKeydown);
                this.cleanup();
                resolve(result);
            };

            document.addEventListener('keydown', handleKeydown);
            modal.querySelector('#use-forked-btn').onclick = () => finish(false);
            modal.querySelector('#fetch-fresh-btn').onclick = () => finish(true);
            modal.onclick = (e) => { if (e.target === modal) finish(false); };
        });
    }

    /**
     * Show prompt asking user if they want to view their local copy or fetch latest
     */
    showUpdatePrompt(existingSession) {
        return new Promise((resolve) => {
            const modal = this.createModalContainer();
            modal.innerHTML = `
                <div class="bg-background border border-border rounded-xl shadow-2xl p-6 max-w-md mx-4 w-full">
                    <h3 class="text-lg font-semibold text-foreground mb-2">Updates Available</h3>
                    <p class="text-sm text-muted-foreground mb-4">
                        The shared chat "<strong>${escapeHtml(existingSession.title)}</strong>" has been updated since you imported it.
                    </p>
                    <div class="flex flex-col gap-2">
                        <button id="fetch-latest-btn" class="w-full px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                            Fetch Latest Version <span class="opacity-60 ml-1">(Enter)</span>
                        </button>
                        <button id="use-local-btn" class="w-full px-4 py-2 text-sm font-medium rounded-lg border border-border text-foreground hover:bg-muted transition-colors">
                            Use My Local Copy <span class="opacity-60 ml-1">(Esc)</span>
                        </button>
                    </div>
                </div>
            `;

            const handleKeydown = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); finish(true); }
                else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
            };

            const finish = (result) => {
                document.removeEventListener('keydown', handleKeydown);
                this.cleanup();
                resolve(result);
            };

            document.addEventListener('keydown', handleKeydown);
            modal.querySelector('#fetch-latest-btn').onclick = () => finish(true);
            modal.querySelector('#use-local-btn').onclick = () => finish(false);
            modal.onclick = (e) => { if (e.target === modal) finish(false); };
        });
    }

    /**
     * Show prompt when shared API key verification fails
     */
    showSharedKeyVerificationFailedPrompt({ error, stationId, isBanned, banReason }) {
        return new Promise((resolve) => {
            const modal = this.createModalContainer();

            const title = isBanned ? 'Shared Key From Banned Station' : 'Shared Key Verification Failed';
            const description = isBanned
                ? `The included API key is from a station that has been banned.`
                : `We cannot verify the integrity of the included API key shared with this chat.`;
            const explanationText = isBanned
                ? `Keys from banned stations cannot be trusted.`
                : `It may be that the original chat session owner tampered with the key. For your safety, we blocked this key, and your data are not affected.`;

            modal.innerHTML = `
                <div class="bg-background border-2 border-amber-500/50 rounded-xl shadow-2xl p-6 max-w-md mx-4 w-full">
                    <div class="flex items-center gap-2 mb-2">
                        <svg class="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                        </svg>
                        <h3 class="text-lg font-semibold text-amber-600 dark:text-amber-400">${title}</h3>
                    </div>
                    <p class="text-sm text-muted-foreground mb-3">${description}</p>

                    <div class="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 mb-3 text-xs">
                        ${stationId ? `<div class="mb-1"><span class="text-muted-foreground">Station:</span> <code class="text-amber-700 dark:text-amber-300 font-medium">${escapeHtml(stationId)}</code></div>` : ''}
                        ${isBanned && banReason ? `<div class="mb-1"><span class="text-muted-foreground">Ban reason:</span> <span class="text-amber-700 dark:text-amber-300">${escapeHtml(banReason)}</span></div>` : ''}
                        <div><span class="text-muted-foreground">Error:</span> <span class="text-amber-700 dark:text-amber-300 font-medium">${escapeHtml(error)}</span></div>
                    </div>

                    <p class="text-sm text-muted-foreground mb-3">${explanationText}</p>

                    <p class="text-xs text-muted-foreground mb-4">
                        Be cautious with shared API keys from untrusted sources. You can import the chat without the key and request your own when needed.
                    </p>

                    <div class="flex flex-col gap-2">
                        <button id="import-without-key-btn" class="w-full px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                            Import without the shared API key <span class="opacity-60 ml-1">(Enter)</span>
                        </button>
                        <button id="cancel-btn" class="w-full px-4 py-2 text-sm font-medium rounded-lg border border-border text-foreground hover:bg-muted transition-colors">
                            Cancel Import <span class="opacity-60 ml-1">(Esc)</span>
                        </button>
                    </div>
                </div>
            `;

            const handleKeydown = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); finish('import_without_key'); }
                else if (e.key === 'Escape') { e.preventDefault(); finish('cancel'); }
            };

            const finish = (result) => {
                document.removeEventListener('keydown', handleKeydown);
                this.cleanup();
                resolve(result);
            };

            document.addEventListener('keydown', handleKeydown);
            modal.querySelector('#import-without-key-btn').onclick = () => finish('import_without_key');
            modal.querySelector('#cancel-btn').onclick = () => finish('cancel');
            modal.onclick = (e) => { if (e.target === modal) finish('cancel'); };
        });
    }

    /**
     * Password/PIN prompt for importing encrypted shares with mode toggle
     */
    showImportPasswordPrompt(message) {
        return new Promise((resolve) => {
            const passwordMode = getPasswordMode();
            const modal = this.createModalContainer();

            modal.innerHTML = `
                <div class="w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl p-6 mx-4">
                    <h3 class="text-base font-medium text-foreground mb-2">Decrypt Shared Chat</h3>
                    <p class="text-sm text-muted-foreground mb-4">${message}</p>

                    <!-- PIN/Password Section -->
                    <div class="mb-4">
                        <div class="flex items-center justify-between mb-2">
                            <label class="text-xs text-muted-foreground">Decryption</label>
                            <div class="encryption-mode-toggle" role="radiogroup" aria-label="Decryption mode">
                                <button type="button" class="encryption-mode-btn ${passwordMode === 'pin' ? 'active' : ''}" data-mode="pin">PIN</button>
                                <button type="button" class="encryption-mode-btn ${passwordMode === 'password' ? 'active' : ''}" data-mode="password">Password</button>
                                <div class="encryption-mode-indicator"></div>
                            </div>
                        </div>

                        <!-- Decryption input container (fixed height to prevent layout shift) -->
                        <div class="h-20 flex items-center">
                            <!-- PIN Input (OTP-style) -->
                            <div class="pin-section w-full ${passwordMode === 'password' ? 'hidden' : ''}">
                                <div class="pin-input-container">
                                    <input type="text" class="pin-hidden-input" maxlength="6" autocomplete="off" inputmode="text">
                                    <div class="pin-boxes">
                                        <div class="pin-box"></div>
                                        <div class="pin-box"></div>
                                        <div class="pin-box"></div>
                                        <span class="pin-separator">-</span>
                                        <div class="pin-box"></div>
                                        <div class="pin-box"></div>
                                        <div class="pin-box"></div>
                                    </div>
                                </div>
                            </div>

                            <!-- Password Input (Traditional) -->
                            <div class="password-section w-full ${passwordMode === 'pin' ? 'hidden' : ''}">
                                <div class="relative">
                                    <input type="text" class="password-input w-full px-3 py-2.5 pr-10 text-sm border border-border/60 rounded-lg bg-background text-foreground focus:outline-none focus:border-primary" placeholder="Enter password" autocomplete="off">
                                    <button type="button" class="toggle-password-btn absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 rounded-md hover-highlight transition-colors">
                                        <span class="eye-closed hidden">${EYE_CLOSED_SVG}</span>
                                        <span class="eye-open">${EYE_OPEN_SVG}</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <p class="password-error text-xs text-destructive mb-3 hidden"></p>

                    <div class="flex gap-2 justify-end">
                        <button id="cancel-btn" class="px-3 py-1.5 text-sm rounded-md border border-border bg-background hover:bg-muted transition-all duration-200 hover:shadow-sm">Cancel</button>
                        <button id="confirm-btn" class="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-200 hover:shadow-sm">Import</button>
                    </div>
                </div>
            `;

            const pinSection = modal.querySelector('.pin-section');
            const passwordSection = modal.querySelector('.password-section');
            const pinInput = modal.querySelector('.pin-hidden-input');
            const passwordInput = modal.querySelector('.password-input');
            const modeToggle = modal.querySelector('.encryption-mode-toggle');
            const modeBtns = modal.querySelectorAll('.encryption-mode-btn');
            const modeIndicator = modal.querySelector('.encryption-mode-indicator');
            const errorEl = modal.querySelector('.password-error');

            let currentMode = passwordMode;

            this.setupPinInput(modal);
            this.setupPasswordToggle(modal);

            // Helper to update indicator position/width based on active button
            const updateModeIndicator = (activeBtn) => {
                if (!modeIndicator || !activeBtn) return;
                const containerRect = modeToggle.getBoundingClientRect();
                const btnRect = activeBtn.getBoundingClientRect();
                modeIndicator.style.width = `${btnRect.width}px`;
                modeIndicator.style.transform = `translateX(${btnRect.left - containerRect.left - 2}px)`;
            };

            // Toggle between PIN and password mode
            modeBtns.forEach(btn => {
                btn.onclick = () => {
                    const newMode = btn.dataset.mode;
                    if (newMode === currentMode) return;

                    currentMode = newMode;
                    setPasswordMode(currentMode);
                    pinSection.classList.toggle('hidden', currentMode !== 'pin');
                    passwordSection.classList.toggle('hidden', currentMode !== 'password');

                    // Update toggle UI
                    modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === currentMode));
                    updateModeIndicator(btn);

                    // Clear error when switching modes
                    errorEl.classList.add('hidden');

                    if (currentMode === 'pin') {
                        pinInput?.focus();
                    } else {
                        passwordInput?.focus();
                    }
                };
            });

            // Initialize indicator position without animation
            const initialActiveBtn = modal.querySelector('.encryption-mode-btn.active');
            if (initialActiveBtn && modeIndicator) {
                requestAnimationFrame(() => {
                    modeIndicator.style.transition = 'none';
                    updateModeIndicator(initialActiveBtn);
                    requestAnimationFrame(() => {
                        modeIndicator.style.transition = '';
                    });
                });
            }

            const finish = (result) => {
                this.cleanup();
                resolve(result);
            };

            const handleConfirm = () => {
                const password = currentMode === 'pin'
                    ? (pinInput?.value || '')
                    : (passwordInput?.value || '');

                if (!password) {
                    errorEl.textContent = currentMode === 'pin' ? 'PIN is required' : 'Password is required';
                    errorEl.classList.remove('hidden');
                    return;
                }

                // Validate PIN length
                if (currentMode === 'pin' && password.length < 6) {
                    const pinBoxes = modal.querySelector('.pin-boxes');
                    if (pinBoxes) {
                        pinBoxes.classList.add('shake');
                        setTimeout(() => pinBoxes.classList.remove('shake'), 500);
                    }
                    errorEl.textContent = 'PIN must be 6 characters';
                    errorEl.classList.remove('hidden');
                    pinInput?.focus();
                    return;
                }

                finish(password);
            };

            modal.querySelector('#cancel-btn').onclick = () => finish(null);
            modal.querySelector('#confirm-btn').onclick = handleConfirm;

            // Handle Enter key
            const handleKeydown = (e) => {
                if (e.key === 'Enter') handleConfirm();
                else if (e.key === 'Escape') finish(null);
            };
            pinInput?.addEventListener('keydown', handleKeydown);
            passwordInput?.addEventListener('keydown', handleKeydown);

            modal.onclick = (e) => { if (e.target === modal) finish(null); };

            // Focus appropriate input
            if (currentMode === 'pin') {
                pinInput?.focus();
            } else {
                passwordInput?.focus();
            }
        });
    }

    // =========================================================================
    // SHARE CREATION MODALS (Legacy - kept for compatibility)
    // =========================================================================

    /**
     * Show share settings modal for creating/updating shares
     */
    showSettingsPrompt({ message, isCreate = false, hasApiKey = false }) {
        return new Promise((resolve) => {
            const passwordMode = getPasswordMode();
            const savedExpiryTtl = getExpiryTtl();
            const modal = this.createModalContainer();

            modal.innerHTML = `
                <div class="w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl p-6 mx-4">
                    <h3 class="text-base font-medium text-foreground mb-4">Share Chat</h3>

                    <!-- PIN/Password Section -->
                    <div class="mb-4">
                        <div class="flex items-center justify-between mb-2">
                            <label class="text-xs text-foreground">Encryption</label>
                            <div class="encryption-mode-toggle" role="radiogroup" aria-label="Encryption mode">
                                <button type="button" class="encryption-mode-btn ${passwordMode === 'pin' ? 'active' : ''}" data-mode="pin">PIN</button>
                                <button type="button" class="encryption-mode-btn ${passwordMode === 'password' ? 'active' : ''}" data-mode="password">Password</button>
                                <div class="encryption-mode-indicator"></div>
                            </div>
                        </div>
                        <p class="text-[11px] text-muted-foreground mb-2">This chat can be encrypted on-device before sharing. Only someone with this PIN/password can decrypt. The PIN is for <strong>this specific share only</strong>. You can revoke and re-share anytime.</p>

                        <!-- Encryption input container (fixed height to prevent layout shift) -->
                        <div class="h-20 flex items-center">
                            <!-- PIN Input (OTP-style) -->
                            <div class="pin-section w-full ${passwordMode === 'password' ? 'hidden' : ''}">
                                <div class="pin-input-container">
                                    <input type="text" class="pin-hidden-input" maxlength="6" autocomplete="off" inputmode="text">
                                    <div class="pin-boxes">
                                        <div class="pin-box"></div>
                                        <div class="pin-box"></div>
                                        <div class="pin-box"></div>
                                        <span class="pin-separator">-</span>
                                        <div class="pin-box"></div>
                                        <div class="pin-box"></div>
                                        <div class="pin-box"></div>
                                    </div>
                                </div>
                                <div class="flex items-center justify-center gap-2 mt-1.5">
                                    <span class="text-xs text-muted-foreground">Leave empty for no encryption</span>
                                    <span class="text-muted-foreground">·</span>
                                    <button type="button" class="random-pin-btn text-muted-foreground hover:text-foreground flex items-center p-1 rounded-md hover-highlight transition-colors" title="Generate random PIN" aria-label="Generate random PIN">
                                        ${RANDOM_ICON_SVG}
                                    </button>
                                    <span class="text-muted-foreground">·</span>
                                    <button type="button" class="toggle-pin-visibility text-muted-foreground hover:text-foreground flex items-center p-1 rounded-md hover-highlight transition-colors" title="Toggle PIN visibility" aria-label="Toggle PIN visibility">
                                        <span class="eye-closed hidden">${EYE_CLOSED_SVG}</span>
                                        <span class="eye-open">${EYE_OPEN_SVG}</span>
                                    </button>
                                </div>
                            </div>

                            <!-- Password Input (Traditional) -->
                            <div class="password-section w-full ${passwordMode === 'pin' ? 'hidden' : ''}">
                                <div class="relative">
                                    <input type="text" class="password-input w-full px-3 py-2.5 pr-10 text-sm border border-border/60 rounded-lg bg-background text-foreground focus:outline-none focus:border-primary" placeholder="Enter password" autocomplete="off">
                                    <button type="button" class="toggle-password-btn absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 rounded-md hover-highlight transition-colors">
                                        <span class="eye-closed hidden">${EYE_CLOSED_SVG}</span>
                                        <span class="eye-open">${EYE_OPEN_SVG}</span>
                                    </button>
                                </div>
                                <p class="text-xs text-muted-foreground mt-2 text-center">Leave empty for no encryption</p>
                            </div>
                        </div>
                    </div>

                    <!-- Expiry Segmented Control -->
                    <div class="mb-4">
                        <label class="block text-xs text-foreground mb-2">Expires after</label>
                        <div class="expiry-toggle-container" role="radiogroup" aria-label="Expiry selection">
                            <div class="expiry-toggle-indicator"></div>
                            ${TTL_PRESETS.map((p) => `
                                <button type="button" class="expiry-toggle-btn" data-value="${p.value}" aria-checked="${p.value === savedExpiryTtl ? 'true' : 'false'}">
                                    ${p.short}
                                </button>
                            `).join('')}
                            <button type="button" class="expiry-toggle-btn" data-value="custom" aria-checked="false">
                                Custom
                            </button>
                        </div>
                        <div class="expiry-custom-container hidden mt-2 flex items-center justify-end gap-2">
                            <input type="number" class="expiry-custom-value w-16 px-2 py-1.5 text-sm border border-border/60 rounded-lg bg-background text-foreground focus:outline-none focus:border-primary text-center" min="1" max="999" value="1">
                            <select class="expiry-custom-unit px-2 py-1.5 text-sm border border-border/60 rounded-lg bg-background text-foreground focus:outline-none focus:border-primary">
                                <option value="60">minutes</option>
                                <option value="3600">hours</option>
                                <option value="86400" selected>days</option>
                            </select>
                        </div>
                    </div>

                    ${hasApiKey ? `
                        <label class="flex items-center gap-2.5 mb-4 cursor-pointer select-none">
                            <input type="checkbox" class="api-metadata-checkbox w-4 h-4 rounded border-border text-primary focus:ring-primary">
                            <div>
                                <span class="text-sm text-foreground">Include this session's API key</span>
                                <p class="text-xs text-muted-foreground">Recipients can borrow your key and continue chatting</p>
                            </div>
                        </label>
                    ` : ''}

                    <p class="text-xs text-muted-foreground mb-4 flex items-center gap-1.5">
                        <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                        All messages in this chat will be shared
                    </p>

                    <div class="flex gap-2 justify-end">
                        <button id="cancel-btn" class="px-3 py-1.5 text-sm rounded-md border border-border bg-background hover:bg-muted transition-all duration-200 hover:shadow-sm">Cancel</button>
                        <button id="confirm-btn" class="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-200 hover:shadow-sm">
                            ${isCreate ? 'Create Link' : 'Import'}
                        </button>
                    </div>
                </div>
            `;

            const pinSection = modal.querySelector('.pin-section');
            const passwordSection = modal.querySelector('.password-section');
            const pinInput = modal.querySelector('.pin-hidden-input');
            const passwordInput = modal.querySelector('.password-input');
            const modeToggle = modal.querySelector('.encryption-mode-toggle');
            const modeBtns = modal.querySelectorAll('.encryption-mode-btn');
            const modeIndicator = modal.querySelector('.encryption-mode-indicator');
            const apiMetadataCheckbox = modal.querySelector('.api-metadata-checkbox');

            let currentMode = passwordMode;

            this.setupPinInput(modal);
            this.setupPasswordToggle(modal);
            const getTtlSeconds = this.setupExpiryToggle(modal, savedExpiryTtl);

// Helper to update indicator position/width based on active button
            const updateModeIndicator = (activeBtn) => {
                if (!modeIndicator || !activeBtn) return;
                const containerRect = modeToggle.getBoundingClientRect();
                const btnRect = activeBtn.getBoundingClientRect();
                modeIndicator.style.width = `${btnRect.width}px`;
                modeIndicator.style.transform = `translateX(${btnRect.left - containerRect.left - 2}px)`;
            };

            // Toggle between PIN and password mode
            modeBtns.forEach(btn => {
                btn.onclick = () => {
                    const newMode = btn.dataset.mode;
                    if (newMode === currentMode) return;

                    currentMode = newMode;
                    setPasswordMode(currentMode);
                    pinSection.classList.toggle('hidden', currentMode !== 'pin');
                    passwordSection.classList.toggle('hidden', currentMode !== 'password');

                    // Update toggle UI
                    modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === currentMode));
                    updateModeIndicator(btn);

                    if (currentMode === 'pin') {
                        pinInput?.focus();
                    } else {
                        passwordInput?.focus();
                    }
                };
            });

            // Initialize indicator position without animation
            const initialActiveBtn = modal.querySelector('.encryption-mode-btn.active');
            if (initialActiveBtn && modeIndicator) {
                requestAnimationFrame(() => {
                    modeIndicator.style.transition = 'none';
                    updateModeIndicator(initialActiveBtn);
                    requestAnimationFrame(() => {
                        modeIndicator.style.transition = '';
                    });
                });
            }

            const finish = (result) => {
                this.cleanup();
                resolve(result);
            };

            const handleConfirm = () => {
                const password = currentMode === 'pin'
                    ? (pinInput?.value || null)
                    : (passwordInput?.value || null);

                finish({
                    password,
                    ttlSeconds: getTtlSeconds(),
                    shareApiKeyMetadata: apiMetadataCheckbox?.checked || false
                });
            };

            modal.querySelector('#cancel-btn').onclick = () => finish(null);
            modal.querySelector('#confirm-btn').onclick = handleConfirm;

            // Handle Enter key
            const handleKeydown = (e) => {
                if (e.key === 'Enter') handleConfirm();
                else if (e.key === 'Escape') finish(null);
            };
            pinInput?.addEventListener('keydown', handleKeydown);
            passwordInput?.addEventListener('keydown', handleKeydown);

            modal.onclick = (e) => { if (e.target === modal) finish(null); };

            // Focus appropriate input
            if (currentMode === 'pin') {
                pinInput?.focus();
            } else {
                passwordInput?.focus();
            }
        });
    }

    // =========================================================================
    // SHARE MANAGEMENT MODAL
    // =========================================================================

    /**
     * Build preview messages HTML
     */
    buildPreviewHtml(previewMessages) {
        if (!previewMessages || previewMessages.length === 0) {
            return `<div class="py-3 text-xs text-muted-foreground italic text-center">No messages yet</div>`;
        }
        return previewMessages.map(msg =>
            msg.role === 'user'
                ? `<div class="flex justify-end">
                    <div class="max-w-[85%] px-2 py-1 rounded-lg text-[11px] bg-muted text-foreground break-words line-clamp-2 message-content share-preview-content">
                        ${processPreviewContent(msg.content?.substring(0, 80) || '')}${msg.content?.length > 80 ? '…' : ''}
                    </div>
                </div>`
                : `<div class="flex justify-start gap-1.5 items-start">
                    <div class="w-4 h-4 rounded-full bg-muted flex items-center justify-center flex-shrink-0 mt-0.5">
                        <svg class="w-2.5 h-2.5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"/>
                        </svg>
                    </div>
                    <div class="max-w-[85%] text-[11px] text-foreground/80 break-words line-clamp-2 message-content share-preview-content">
                        ${processPreviewContent(msg.content?.substring(0, 100) || '')}${msg.content?.length > 100 ? '…' : ''}
                    </div>
                </div>`
        ).join('');
    }

    /**
     * Show share management modal with status, actions, and settings
     */
    showManagementModal(session, messages, callbacks) {
        if (!session) return;

        const { onShare, onRevoke, onCopyLink, showToast } = callbacks;
        const shareInfo = session.shareInfo;
        const isShared = !!shareInfo?.shareId;
        // Never consider expired if ttlSeconds is 0 (no expiry)
        const isExpired = shareInfo?.ttlSeconds !== 0 && shareInfo?.expiresAt && Date.now() > shareInfo.expiresAt;
        const hasApiKey = !!session.apiKeyInfo;
        // API key expiry is stored at session.expiresAt (can be ISO string or timestamp)
        const isApiKeyExpired = hasApiKey && session.expiresAt && new Date(session.expiresAt) <= new Date();
        const prevTtl = shareInfo?.ttlSeconds ?? getExpiryTtl(); // Use saved preference for new shares
        const passwordMode = getPasswordMode();

        // Show "Never" if ttlSeconds is 0, otherwise show the expiry date
        const expiryDate = shareInfo?.ttlSeconds === 0 ? null : (shareInfo?.expiresAt ? new Date(shareInfo.expiresAt).toLocaleString() : null);
        const shareUrl = isShared ? shareService.buildShareUrl(session.id) : '';
        // API key expiry is at session.expiresAt, not inside apiKeyInfo
        const apiKeyExpiresAt = shareInfo?.apiKeyShared && session.expiresAt
            ? session.expiresAt
            : null;

        // Compute preview variants from messages
        const sharedCount = shareInfo?.messageCount;
        const sharedMessages = sharedCount ? messages.slice(0, sharedCount) : messages;
        const previewHtml = this.buildPreviewHtml(sharedMessages.slice(-6));
        const allMessagesPreviewHtml = this.buildPreviewHtml(messages.slice(-6));

        // Build status panel HTML using shared helper
        const statusPanelHtml = isShared ? (isExpired
            ? buildExpiredPanelHtml({ expiryDate, messageCount: shareInfo?.messageCount, previewHtml })
            : buildStatusPanelHtml({
                isPlaintext: shareInfo?.isPlaintext,
                apiKeyShared: shareInfo?.apiKeyShared,
                apiKeyExpiresAt,
                isExpired: false,
                expiryDate,
                messageCount: shareInfo?.messageCount,
                shareUrl,
                previewHtml
            })
        ) : '';

        const modal = this.createModalContainer('bg-black/60');
        modal.innerHTML = `
            <div class="w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl p-5 mx-4 flex flex-col">
                <h3 class="text-base font-medium text-foreground mb-4">Share Chat</h3>

                <!-- Status section (for already shared) -->
                <div id="status-section" class="flex-1 flex flex-col ${isShared ? '' : 'hidden'}">
                    ${statusPanelHtml}
                </div>

                <!-- Form section -->
                <div id="form-section" class="flex-1 flex flex-col ${isShared ? 'hidden' : ''}">

                    <!-- PIN/Password Section -->
                    <div class="mb-4">
                        <div class="flex items-center justify-between mb-2">
                            <label class="text-xs text-foreground">Encryption</label>
                            <div class="encryption-mode-toggle" role="radiogroup" aria-label="Encryption mode">
                                <button type="button" class="encryption-mode-btn ${passwordMode === 'pin' ? 'active' : ''}" data-mode="pin">PIN</button>
                                <button type="button" class="encryption-mode-btn ${passwordMode === 'password' ? 'active' : ''}" data-mode="password">Password</button>
                                <div class="encryption-mode-indicator"></div>
                            </div>
                        </div>
                        <p class="text-[11px] text-muted-foreground mb-2">This chat can be encrypted on-device before sharing. Only someone with this PIN/password can decrypt. The PIN is for <strong>this specific share only</strong>. You can revoke and re-share anytime.</p>

                        <!-- Encryption input container (fixed height to prevent layout shift) -->
                        <div class="h-20 flex items-center">
                            <!-- PIN Input (OTP-style) -->
                            <div class="pin-section w-full ${passwordMode === 'password' ? 'hidden' : ''}">
                                <div class="pin-input-container">
                                    <input type="text" class="pin-hidden-input" maxlength="6" autocomplete="off" inputmode="text">
                                    <div class="pin-boxes">
                                        <div class="pin-box"></div>
                                        <div class="pin-box"></div>
                                        <div class="pin-box"></div>
                                        <span class="pin-separator">-</span>
                                        <div class="pin-box"></div>
                                        <div class="pin-box"></div>
                                        <div class="pin-box"></div>
                                    </div>
                                </div>
                                <div class="flex items-center justify-center gap-2 mt-1.5">
                                    <span class="text-xs text-muted-foreground">Leave empty for no encryption</span>
                                    <span class="text-muted-foreground">·</span>
                                    <button type="button" class="random-pin-btn text-muted-foreground hover:text-foreground flex items-center p-1 rounded-md hover-highlight transition-colors" title="Generate random PIN" aria-label="Generate random PIN">
                                        ${RANDOM_ICON_SVG}
                                    </button>
                                    <span class="text-muted-foreground">·</span>
                                    <button type="button" class="toggle-pin-visibility text-muted-foreground hover:text-foreground flex items-center p-1 rounded-md hover-highlight transition-colors" title="Toggle PIN visibility" aria-label="Toggle PIN visibility">
                                        <span class="eye-closed hidden">${EYE_CLOSED_SVG}</span>
                                        <span class="eye-open">${EYE_OPEN_SVG}</span>
                                    </button>
                                </div>
                            </div>

                            <!-- Password Input (Traditional) -->
                            <div class="password-section w-full ${passwordMode === 'pin' ? 'hidden' : ''}">
                                <div class="relative">
                                    <input type="text" class="password-input w-full px-3 py-2.5 pr-10 text-sm border border-border/60 rounded-lg bg-background text-foreground focus:outline-none focus:border-primary" placeholder="Enter password" autocomplete="off">
                                    <button type="button" class="toggle-password-btn absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 rounded-md hover-highlight transition-colors">
                                        <span class="eye-closed hidden">${EYE_CLOSED_SVG}</span>
                                        <span class="eye-open">${EYE_OPEN_SVG}</span>
                                    </button>
                                </div>
                                <p class="text-xs text-muted-foreground mt-2 text-center">Leave empty for no encryption</p>
                            </div>
                        </div>
                    </div>

                    <!-- Expiry Segmented Control -->
                    <div class="mb-4">
                        <label class="block text-xs text-foreground mb-2">Expires after</label>
                        <div class="expiry-toggle-container" role="radiogroup" aria-label="Expiry selection">
                            <div class="expiry-toggle-indicator"></div>
                            ${TTL_PRESETS.map((p, i) => `
                                <button type="button" class="expiry-toggle-btn" data-value="${p.value}" aria-checked="${p.value === prevTtl ? 'true' : 'false'}">
                                    ${p.short}
                                </button>
                            `).join('')}
                            <button type="button" class="expiry-toggle-btn" data-value="custom" aria-checked="false">
                                Custom
                            </button>
                        </div>
                        <div class="expiry-custom-container hidden mt-2 flex items-center justify-end gap-2">
                            <input type="number" class="expiry-custom-value w-16 px-2 py-1.5 text-sm border border-border/60 rounded-lg bg-background text-foreground focus:outline-none focus:border-primary text-center" min="1" max="999" value="1">
                            <select class="expiry-custom-unit px-2 py-1.5 text-sm border border-border/60 rounded-lg bg-background text-foreground focus:outline-none focus:border-primary">
                                <option value="60">minutes</option>
                                <option value="3600">hours</option>
                                <option value="86400" selected>days</option>
                            </select>
                        </div>
                    </div>

                    ${hasApiKey ? `
                        <label class="flex items-center gap-2.5 mb-4 ${isApiKeyExpired ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} select-none">
                            <input type="checkbox" class="api-metadata-checkbox w-4 h-4 rounded border-border text-primary focus:ring-primary" ${isApiKeyExpired ? 'disabled' : ''}>
                            <div>
                                <span class="text-sm text-foreground">Include this session's API key</span>
                                <p class="text-xs text-muted-foreground">
                                    ${isApiKeyExpired
                                        ? 'Key expired — recipients will view only'
                                        : 'Recipients can borrow your key and continue chatting'}
                                </p>
                            </div>
                        </label>
                    ` : ''}

                    ${buildPreviewContainerHtml(previewHtml, 'Share cutoff preview')}

                    <div class="flex justify-between">
                        <button id="close-btn" class="btn-ghost-hover px-4 py-1.5 text-sm rounded-md border border-border bg-background text-foreground transition-colors">
                            ${isShared && !isExpired ? 'Done' : 'Cancel'}
                        </button>
                        <button id="submit-btn" class="btn-primary-bright px-4 py-1.5 text-sm rounded-md bg-blue-600 text-white transition-all duration-200">
                            ${isShared ? 'Copy link' : 'Share'}
                        </button>
                    </div>
                </div>
            </div>
        `;

        const statusSection = modal.querySelector('#status-section');
        const formSection = modal.querySelector('#form-section');
        const pinSection = modal.querySelector('.pin-section');
        const passwordSection = modal.querySelector('.password-section');
        const pinInput = modal.querySelector('.pin-hidden-input');
        const passwordInput = modal.querySelector('.password-input');
        const modeToggle = modal.querySelector('.encryption-mode-toggle');
        const modeBtns = modal.querySelectorAll('.encryption-mode-btn');
        const modeIndicator = modal.querySelector('.encryption-mode-indicator');
        const apiMetadataCheckbox = modal.querySelector('.api-metadata-checkbox');
        const closeBtn = modal.querySelector('#close-btn');

        let currentMode = passwordMode;

        this.setupPinInput(modal);
        this.setupPasswordToggle(modal);
        const getTtlSeconds = this.setupExpiryToggle(modal, prevTtl);

        // Helper to scroll all cutoff previews to bottom (immediate, no flash)
        const scrollPreviewToBottom = () => {
            modal.querySelectorAll('.share-cutoff-chat').forEach(preview => {
                preview.scrollTop = preview.scrollHeight;
            });
        };

        // Render LaTeX in preview content
        renderLatexInElement(modal);

        // Auto-scroll cutoff preview to bottom
        scrollPreviewToBottom();

// Helper to update indicator position/width based on active button
        const updateModeIndicator = (activeBtn) => {
            if (!modeIndicator || !activeBtn) return;
            const containerRect = modeToggle.getBoundingClientRect();
            const btnRect = activeBtn.getBoundingClientRect();
            modeIndicator.style.width = `${btnRect.width}px`;
            modeIndicator.style.transform = `translateX(${btnRect.left - containerRect.left - 2}px)`;
        };

        // Toggle between PIN and password mode
        modeBtns.forEach(btn => {
            btn.onclick = () => {
                const newMode = btn.dataset.mode;
                if (newMode === currentMode) return;

                currentMode = newMode;
                setPasswordMode(currentMode);
                pinSection?.classList.toggle('hidden', currentMode !== 'pin');
                passwordSection?.classList.toggle('hidden', currentMode !== 'password');

                // Update toggle UI
                modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === currentMode));
                updateModeIndicator(btn);

                if (currentMode === 'pin') {
                    pinInput?.focus();
                } else {
                    passwordInput?.focus();
                }
            };
        });

        // Initialize indicator position without animation
        const initialActiveBtn = modal.querySelector('.encryption-mode-btn.active');
        if (initialActiveBtn && modeIndicator) {
            requestAnimationFrame(() => {
                modeIndicator.style.transition = 'none';
                updateModeIndicator(initialActiveBtn);
                requestAnimationFrame(() => {
                    modeIndicator.style.transition = '';
                });
            });
        }

        const showForm = (useAllMessages = false) => {
            if (statusSection) statusSection.classList.add('hidden');
            if (formSection) formSection.classList.remove('hidden');
            closeBtn.textContent = 'Cancel';

            // Update preview if returning after revoke (now sharing all messages)
            if (useAllMessages) {
                const previewContainer = formSection.querySelector('.share-cutoff-chat');
                if (previewContainer) {
                    previewContainer.innerHTML = allMessagesPreviewHtml;
                    renderLatexInElement(previewContainer);
                }
            }

            // Update submit button and ensure handler is attached
            const submitBtn = modal.querySelector('#submit-btn');
            if (submitBtn) {
                submitBtn.textContent = 'Share';
                submitBtn.disabled = false;
                submitBtn.onclick = handleSubmit;
            }

            if (currentMode === 'pin') {
                pinInput?.focus();
            } else {
                passwordInput?.focus();
            }

            // Scroll preview to bottom when form becomes visible
            scrollPreviewToBottom();
        };

        // Close handlers
        closeBtn.onclick = () => this.cleanup();
        modal.onclick = (e) => { if (e.target === modal) this.cleanup(); };

        // Auto-focus input when typing anywhere in the modal (while form is visible)
        modal.addEventListener('keydown', (e) => {
            if (formSection.classList.contains('hidden')) return;
            if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'Tab') return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;

            const activeEl = document.activeElement;
            const isInputFocused = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
            if (isInputFocused) return;

            // Focus the appropriate input for typing
            if (currentMode === 'pin') {
                pinInput?.focus();
            } else {
                passwordInput?.focus();
            }
        });

        // Escape key closes modal
        const handleEscape = (e) => { if (e.key === 'Escape') this.cleanup(); };
        document.addEventListener('keydown', handleEscape);
        this._escapeHandler = handleEscape;

        // Submit handler
        const handleSubmit = async () => {
            const pinValue = pinInput?.value || '';
            const passwordValue = passwordInput?.value || '';

            // Validate PIN: must be empty (no encryption) or exactly 6 characters
            if (currentMode === 'pin' && pinValue.length > 0 && pinValue.length < 6) {
                // Shake the PIN boxes to indicate error
                const pinBoxes = modal.querySelector('.pin-boxes');
                if (pinBoxes) {
                    pinBoxes.classList.add('shake');
                    setTimeout(() => pinBoxes.classList.remove('shake'), 500);
                }
                pinInput?.focus();
                return;
            }

            const password = currentMode === 'pin'
                ? (pinValue || null)
                : (passwordValue || null);

            const settings = {
                password,
                ttlSeconds: getTtlSeconds(),
                shareApiKeyMetadata: apiMetadataCheckbox?.checked || false
            };

            // Show loading state
            const submitBtn = modal.querySelector('#submit-btn');
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Sharing...';
            }

            try {
                await onShare(settings);

                // Get updated share info from session
                const newShareInfo = session.shareInfo;
                // Show "Never" if ttlSeconds is 0, otherwise show the expiry date
                const newExpiryDate = newShareInfo?.ttlSeconds === 0 ? null : (newShareInfo?.expiresAt ? new Date(newShareInfo.expiresAt).toLocaleString() : null);
                const newShareUrl = shareService.buildShareUrl(session.id);
                // API key expiry is at session.expiresAt, not inside apiKeyInfo
                const newApiKeyExpiresAt = (apiMetadataCheckbox?.checked && session.expiresAt)
                    ? session.expiresAt
                    : null;

                // Build success panel using shared helper
                const successPanelHtml = buildStatusPanelHtml({
                    isPlaintext: !password,
                    apiKeyShared: apiMetadataCheckbox?.checked || false,
                    apiKeyExpiresAt: newApiKeyExpiresAt,
                    isExpired: false,
                    expiryDate: newExpiryDate,
                    messageCount: newShareInfo?.messageCount,
                    shareUrl: newShareUrl,
                    previewHtml
                });

                // Replace status section content with success panel
                if (statusSection) {
                    statusSection.innerHTML = successPanelHtml;
                    statusSection.classList.remove('hidden');
                }

                // Hide form
                if (formSection) formSection.classList.add('hidden');

                // Scroll preview to bottom
                scrollPreviewToBottom();

                // Wire up action handlers
                this.setupStatusPanelHandlers(modal, newShareUrl, onRevoke, showToast, () => showForm(true));

            } catch (error) {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = isShared ? 'Copy link' : 'Share';
                }
                showToast('Failed to create share link', 'error');
            }
        };

        const submitBtnEl = modal.querySelector('#submit-btn');
        if (submitBtnEl) submitBtnEl.onclick = handleSubmit;

        // Keyboard shortcuts
        const handleFormKeydown = (e) => {
            if (e.key === 'Enter') handleSubmit();
        };
        pinInput?.addEventListener('keydown', handleFormKeydown);
        passwordInput?.addEventListener('keydown', handleFormKeydown);

        // Action handlers for shared sessions (using shared setup method)
        if (isShared && !isExpired) {
            this.setupStatusPanelHandlers(modal, shareUrl, onRevoke, showToast, () => showForm(true));
        } else if (isShared && isExpired) {
            // Wire up close button in expired panel
            const expiredCloseBtn = statusSection?.querySelector('#close-btn');
            if (expiredCloseBtn) {
                expiredCloseBtn.onclick = () => this.cleanup();
            }
            modal.querySelector('#share-again-btn')?.addEventListener('click', () => showForm(true));
        }

        // Auto-focus if form is visible
        if (!isShared) {
            if (currentMode === 'pin') {
                pinInput?.focus();
            } else {
                passwordInput?.focus();
            }
        }
    }
}

const shareModals = new ShareModals();
export default shareModals;
