/**
 * ShareModals Component
 * Handles all share-related modal UI (create, import, update, revoke)
 * Following the same pattern as ProxyInfoModal.js and TLSSecurityModal.js
 */

import shareService from '../services/shareService.js';

// TTL preset options used across modals
const TTL_PRESETS = [
    { value: 60, label: '1 minute' },
    { value: 3600, label: '1 hour' },
    { value: 86400, label: '1 day' },
    { value: 604800, label: '7 days' },
    { value: 1209600, label: '14 days' },
    { value: 2592000, label: '30 days' }
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
 * Format TTL seconds to human-readable string
 */
function formatTtl(seconds) {
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} hour${seconds >= 7200 ? 's' : ''}`;
    return `${Math.round(seconds / 86400)} day${seconds >= 172800 ? 's' : ''}`;
}

/**
 * Get TTL seconds from form elements
 */
function getTtlSeconds(presetEl, customValueEl, customUnitEl) {
    if (presetEl?.value === 'custom') {
        const val = parseInt(customValueEl?.value, 10) || 1;
        const unit = parseInt(customUnitEl?.value, 10) || 86400;
        return Math.max(60, Math.min(val * unit, 2592000));
    }
    return parseInt(presetEl?.value, 10) || 604800;
}

/**
 * Build TTL options HTML with custom value support
 */
function buildTtlOptionsHtml(prevTtl = 604800) {
    const isCustomPrev = prevTtl && !TTL_PRESETS.some(opt => opt.value === prevTtl);
    let html = '';
    if (isCustomPrev) {
        html += `<option value="${prevTtl}" selected>${formatTtl(prevTtl)} (last time)</option>`;
    }
    html += TTL_PRESETS.map(opt =>
        `<option value="${opt.value}"${!isCustomPrev && opt.value === prevTtl ? ' selected' : ''}>${opt.label}</option>`
    ).join('');
    html += '<option value="custom">Custom...</option>';
    return html;
}

/**
 * Password visibility toggle icon SVGs
 */
const EYE_CLOSED_SVG = `<svg class="w-4 h-4 eye-closed" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
</svg>`;

const EYE_OPEN_SVG = `<svg class="w-4 h-4 eye-open hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
</svg>`;

class ShareModals {
    constructor() {
        this.currentModal = null;
    }

    /**
     * Clean up current modal
     */
    cleanup() {
        // Remove escape key handler if present
        if (this._escapeHandler) {
            document.removeEventListener('keydown', this._escapeHandler);
            this._escapeHandler = null;
        }
        if (this.currentModal) {
            this.currentModal.classList.add('fade-out');
            const modal = this.currentModal;
            setTimeout(() => modal.remove(), 150);
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
        return modal;
    }

    /**
     * Setup password toggle functionality
     */
    setupPasswordToggle(container) {
        const toggleBtn = container.querySelector('.toggle-password-btn');
        const passwordInput = container.querySelector('.password-input');
        if (!toggleBtn || !passwordInput) return;

        toggleBtn.onclick = () => {
            const isHidden = passwordInput.type === 'password';
            passwordInput.type = isHidden ? 'text' : 'password';
            toggleBtn.querySelector('.eye-open')?.classList.toggle('hidden', !isHidden);
            toggleBtn.querySelector('.eye-closed')?.classList.toggle('hidden', isHidden);
        };
    }

    /**
     * Setup custom TTL toggle functionality
     */
    setupTtlToggle(container) {
        const preset = container.querySelector('.ttl-preset');
        const customContainer = container.querySelector('.ttl-custom-container');
        const customValue = container.querySelector('.ttl-custom-value');
        if (!preset || !customContainer) return;

        preset.onchange = () => {
            const isCustom = preset.value === 'custom';
            customContainer.classList.toggle('hidden', !isCustom);
            if (isCustom && customValue) customValue.focus();
        };
    }

    // =========================================================================
    // IMPORT MODALS
    // =========================================================================

    /**
     * Show prompt when user opens a share they've previously forked
     * @param {Object} forkedSession - The forked session
     * @returns {Promise<boolean>} True if user wants fresh import, false for their copy
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
     * @param {Object} existingSession - The existing imported session
     * @returns {Promise<boolean>} True if user wants to fetch latest, false for local copy
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
     * @param {Object} opts - {error, stationId, isBanned, banReason}
     * @returns {Promise<'import_without_key'|'cancel'>}
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
                    
                    <p class="text-sm text-muted-foreground mb-3">
                        ${explanationText}
                    </p>
                    
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
     * Simple password prompt for importing encrypted shares
     * @param {string} message - Prompt message
     * @returns {Promise<string|null>} Password or null if cancelled
     */
    showImportPasswordPrompt(message) {
        return new Promise((resolve) => {
            const modal = this.createModalContainer();
            modal.innerHTML = `
                <div class="w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl p-6 mx-4">
                    <p class="text-sm text-foreground mb-4">${message}</p>
                    <div class="relative mb-3">
                        <input type="password" class="password-input w-full px-3 py-2 pr-10 text-sm border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary" placeholder="Password">
                        <button type="button" class="toggle-password-btn absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1">
                            ${EYE_CLOSED_SVG}${EYE_OPEN_SVG}
                        </button>
                    </div>
                    <p class="password-error text-xs text-destructive mb-3 hidden"></p>
                    <div class="flex gap-2 justify-end">
                        <button id="cancel-btn" class="px-4 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors">Cancel</button>
                        <button id="confirm-btn" class="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">Import</button>
                    </div>
                </div>
            `;

            const passwordInput = modal.querySelector('.password-input');
            const errorEl = modal.querySelector('.password-error');

            this.setupPasswordToggle(modal);

            const finish = (result) => {
                this.cleanup();
                resolve(result);
            };

            const handleConfirm = () => {
                const password = passwordInput.value;
                if (!password) {
                    errorEl.textContent = 'Password is required';
                    errorEl.classList.remove('hidden');
                    return;
                }
                finish(password);
            };

            modal.querySelector('#cancel-btn').onclick = () => finish(null);
            modal.querySelector('#confirm-btn').onclick = handleConfirm;
            passwordInput.onkeydown = (e) => {
                if (e.key === 'Enter') handleConfirm();
                else if (e.key === 'Escape') finish(null);
            };
            modal.onclick = (e) => { if (e.target === modal) finish(null); };
            passwordInput.focus();
        });
    }

    // =========================================================================
    // SHARE CREATION MODALS
    // =========================================================================

    /**
     * Show share settings modal for creating/updating shares
     * @param {Object} opts - {message, isCreate, hasApiKey}
     * @returns {Promise<{password: string|null, ttlSeconds: number, shareApiKeyMetadata: boolean}|null>}
     */
    showSettingsPrompt({ message, isCreate = false, hasApiKey = false }) {
        return new Promise((resolve) => {
            const modal = this.createModalContainer();
            modal.innerHTML = `
                <div class="w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl p-6 mx-4">
                    <p class="text-sm text-foreground mb-3">${message}</p>
                    
                    <!-- Info message -->
                    <div class="flex items-center gap-2 mb-4 text-muted-foreground">
                        <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                        <span class="text-xs">Chat will be shared till the bottom</span>
                    </div>

                    <!-- No password checkbox -->
                    <label class="flex items-center gap-2 mb-3 cursor-pointer select-none">
                        <input type="checkbox" class="no-password-checkbox w-4 h-4 rounded border-border text-primary focus:ring-primary">
                        <span class="text-sm text-foreground">No password (plaintext)</span>
                    </label>

                    <!-- Password input -->
                    <div class="password-section relative mb-3">
                        <input type="text" class="password-input w-full px-3 py-2 pr-10 text-sm border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary" placeholder="Password">
                        <button type="button" class="toggle-password-btn absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1">
                            ${EYE_CLOSED_SVG}${EYE_OPEN_SVG}
                        </button>
                    </div>
                    <p class="password-error text-xs text-destructive mb-3 hidden"></p>

                    <!-- TTL Settings -->
                    <div class="mb-3">
                        <label class="block text-xs text-muted-foreground mb-1.5">Expires after</label>
                        <div class="flex gap-2">
                            <select class="ttl-preset flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary">
                                ${buildTtlOptionsHtml()}
                            </select>
                            <div class="ttl-custom-container hidden flex gap-1">
                                <input type="number" class="ttl-custom-value w-16 px-2 py-2 text-sm border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary" min="1" max="999" placeholder="1">
                                <select class="ttl-custom-unit px-2 py-2 text-sm border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary">
                                    <option value="60">min</option>
                                    <option value="3600">hour</option>
                                    <option value="86400" selected>day</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    ${hasApiKey ? `
                        <label class="flex items-start gap-2 mb-4 cursor-pointer select-none">
                            <input type="checkbox" class="api-metadata-checkbox w-4 h-4 mt-0.5 rounded border-border text-primary focus:ring-primary">
                            <div>
                                <span class="text-sm text-foreground">Share API key metadata</span>
                                <p class="text-xs text-muted-foreground mt-0.5">Station, expiry, usage stats</p>
                            </div>
                        </label>
                    ` : ''}

                    <div class="flex gap-2 justify-end">
                        <button id="cancel-btn" class="px-4 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors">Cancel</button>
                        <button id="confirm-btn" class="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                            ${isCreate ? 'Share' : 'Import'}
                        </button>
                    </div>
                </div>
            `;

            const noPasswordCheckbox = modal.querySelector('.no-password-checkbox');
            const passwordSection = modal.querySelector('.password-section');
            const passwordInput = modal.querySelector('.password-input');
            const errorEl = modal.querySelector('.password-error');
            const ttlPreset = modal.querySelector('.ttl-preset');
            const ttlCustomValue = modal.querySelector('.ttl-custom-value');
            const ttlCustomUnit = modal.querySelector('.ttl-custom-unit');
            const apiMetadataCheckbox = modal.querySelector('.api-metadata-checkbox');

            this.setupPasswordToggle(modal);
            this.setupTtlToggle(modal);

            // Toggle no-password mode
            noPasswordCheckbox.onchange = () => {
                const isPlaintext = noPasswordCheckbox.checked;
                passwordSection.classList.toggle('hidden', isPlaintext);
                passwordSection.classList.toggle('opacity-50', isPlaintext);
                if (isPlaintext) {
                    passwordInput.value = '';
                    errorEl.classList.add('hidden');
                }
            };

            const finish = (result) => {
                this.cleanup();
                resolve(result);
            };

            const handleConfirm = () => {
                const isPlaintext = noPasswordCheckbox.checked;
                const password = isPlaintext ? null : passwordInput.value;

                if (!isPlaintext && !password) {
                    errorEl.textContent = 'Password is required';
                    errorEl.classList.remove('hidden');
                    return;
                }

                finish({
                    password,
                    ttlSeconds: getTtlSeconds(ttlPreset, ttlCustomValue, ttlCustomUnit),
                    shareApiKeyMetadata: apiMetadataCheckbox?.checked || false
                });
            };

            modal.querySelector('#cancel-btn').onclick = () => finish(null);
            modal.querySelector('#confirm-btn').onclick = handleConfirm;
            passwordInput.onkeydown = (e) => {
                if (e.key === 'Enter') handleConfirm();
                else if (e.key === 'Escape') finish(null);
            };
            modal.onclick = (e) => { if (e.target === modal) finish(null); };
            passwordInput.focus();
        });
    }

    // =========================================================================
    // SHARE MANAGEMENT MODAL
    // =========================================================================

    /**
     * Show share management modal with status, actions, and settings
     * @param {Object} session - Current session
     * @param {Object} callbacks - {onShare, onRevoke, onCopyLink, showToast}
     */
    showManagementModal(session, callbacks) {
        if (!session) return;

        const { onShare, onRevoke, onCopyLink, showToast } = callbacks;
        const shareInfo = session.shareInfo;
        const isShared = !!shareInfo?.shareId;
        const isExpired = shareInfo?.expiresAt && Date.now() > shareInfo.expiresAt;
        const hasApiKey = !!session.apiKeyInfo;
        const prevTtl = shareInfo?.ttlSeconds || 604800;

        // Determine status
        let status = 'Not shared';
        let statusClass = 'text-muted-foreground';
        if (isShared) {
            if (isExpired) {
                status = 'Expired';
                statusClass = 'text-amber-600 dark:text-amber-400';
            } else {
                status = 'Active';
                statusClass = 'text-green-600 dark:text-green-400';
            }
        }

        const expiryDate = shareInfo?.expiresAt ? new Date(shareInfo.expiresAt).toLocaleString() : null;

        const modal = this.createModalContainer('bg-black/60');
        modal.innerHTML = `
            <div class="w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl p-6 mx-4">
                <h3 class="text-base font-medium text-foreground mb-4">Share Settings</h3>
                
                <!-- Status section -->
                <div id="status-section">
                    <div class="mb-4 pb-4 border-b border-border">
                        <div class="flex items-center justify-between">
                            <span class="text-sm text-muted-foreground">Status</span>
                            <div class="flex items-center gap-1.5">
                                ${isShared && shareInfo?.isPlaintext ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Unencrypted</span>' : ''}
                                ${isShared && shareInfo?.apiKeyShared ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">Key shared</span>' : ''}
                                <span class="text-sm font-medium ${statusClass}">${status}</span>
                            </div>
                        </div>
                    </div>

                    ${isShared ? `
                        <div class="space-y-1.5 mb-4 text-xs text-muted-foreground">
                            ${expiryDate ? `<div>Expires: ${expiryDate}</div>` : ''}
                            <div>Messages: ${shareInfo.messageCount || 0}</div>
                        </div>
                    ` : ''}
                </div>

                ${isShared ? `
                    <!-- Actions for shared session -->
                    <div id="actions-section" class="flex flex-col gap-2 mb-4">
                        ${isExpired ? `
                            <button id="share-again-btn" class="w-full px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                                Share Again
                            </button>
                        ` : `
                            <button id="copy-link-btn" class="w-full px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                                Copy Share Link
                            </button>
                            <button id="update-btn" class="w-full px-4 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors">
                                Update Share
                            </button>
                            <button id="revoke-btn" class="w-full px-4 py-2 text-sm rounded-lg text-destructive border border-destructive/30 hover:bg-destructive/10 transition-colors">
                                Revoke Share
                            </button>
                        `}
                    </div>
                    
                    <!-- Hidden share form -->
                    <div id="form-section" class="hidden">
                ` : `
                    <div id="form-section">`}
                    
                    <!-- Password input -->
                    <div class="relative mb-3">
                        <input type="password" class="password-input w-full px-3 py-2 pr-10 text-sm border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary" placeholder="Password (leave blank for no encryption)">
                        <button type="button" class="toggle-password-btn absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1">
                            ${EYE_CLOSED_SVG}${EYE_OPEN_SVG}
                        </button>
                    </div>

                    <!-- TTL Settings -->
                    <div class="mb-3">
                        <label class="block text-xs text-muted-foreground mb-1.5">Expires after</label>
                        <div class="flex gap-2">
                            <select class="ttl-preset flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary">
                                ${buildTtlOptionsHtml(prevTtl)}
                            </select>
                            <div class="ttl-custom-container hidden flex gap-1">
                                <input type="number" class="ttl-custom-value w-16 px-2 py-2 text-sm border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary" min="1" max="999" placeholder="1">
                                <select class="ttl-custom-unit px-2 py-2 text-sm border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary">
                                    <option value="60">min</option>
                                    <option value="3600">hour</option>
                                    <option value="86400" selected>day</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    ${hasApiKey ? `
                        <div class="mb-4">
                            <label class="flex items-center gap-2 cursor-pointer select-none">
                                <input type="checkbox" class="api-metadata-checkbox w-4 h-4 rounded border-border text-primary focus:ring-primary">
                                <span class="text-sm text-foreground">Share API key</span>
                            </label>
                            <p class="text-xs text-muted-foreground mt-1 ml-6">Others can use your ephemeral key</p>
                        </div>
                    ` : ''}

                    <!-- Info message -->
                    <div class="flex items-center gap-2 mb-4 text-muted-foreground">
                        <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                        <span class="text-xs">Chat will be shared till the bottom</span>
                    </div>

                    <button id="submit-btn" class="w-full px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                        ${isShared ? 'Update' : 'Share'}
                    </button>
                </div>

                <button id="close-btn" class="w-full mt-2 px-4 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors">
                    Close
                </button>
            </div>
        `;

        const statusSection = modal.querySelector('#status-section');
        const actionsSection = modal.querySelector('#actions-section');
        const formSection = modal.querySelector('#form-section');
        const passwordInput = modal.querySelector('.password-input');
        const ttlPreset = modal.querySelector('.ttl-preset');
        const ttlCustomValue = modal.querySelector('.ttl-custom-value');
        const ttlCustomUnit = modal.querySelector('.ttl-custom-unit');
        const apiMetadataCheckbox = modal.querySelector('.api-metadata-checkbox');

        this.setupPasswordToggle(modal);
        this.setupTtlToggle(modal);

        const showForm = () => {
            if (actionsSection) actionsSection.classList.add('hidden');
            if (statusSection) statusSection.classList.add('hidden');
            if (formSection) formSection.classList.remove('hidden');
            passwordInput?.focus();
        };

        // Close handlers
        modal.querySelector('#close-btn').onclick = () => this.cleanup();
        modal.onclick = (e) => { if (e.target === modal) this.cleanup(); };
        
        // Escape key closes modal
        const handleEscape = (e) => { if (e.key === 'Escape') this.cleanup(); };
        document.addEventListener('keydown', handleEscape);
        // Store for cleanup
        this._escapeHandler = handleEscape;

        // Submit handler
        const handleSubmit = async () => {
            const password = passwordInput.value.trim() || null;
            const settings = {
                password,
                ttlSeconds: getTtlSeconds(ttlPreset, ttlCustomValue, ttlCustomUnit),
                shareApiKeyMetadata: apiMetadataCheckbox?.checked || false
            };
            this.cleanup();
            await onShare(settings);
        };
        
        modal.querySelector('#submit-btn')?.addEventListener('click', handleSubmit);
        
        // Keyboard shortcuts in password input
        if (passwordInput) {
            passwordInput.onkeydown = (e) => {
                if (e.key === 'Enter') handleSubmit();
                else if (e.key === 'Escape') this.cleanup();
            };
        }

        // Action handlers for shared sessions
        if (isShared && !isExpired) {
            modal.querySelector('#copy-link-btn')?.addEventListener('click', async () => {
                const shareUrl = shareService.buildShareUrl(session.id);
                await navigator.clipboard.writeText(shareUrl);
                showToast('Share link copied!', 'success');
            });

            modal.querySelector('#update-btn')?.addEventListener('click', showForm);

            modal.querySelector('#revoke-btn')?.addEventListener('click', async () => {
                this.cleanup();
                await onRevoke();
                showToast('Share revoked', 'success');
            });
        } else if (isShared && isExpired) {
            modal.querySelector('#share-again-btn')?.addEventListener('click', showForm);
        }
        
        // Auto-focus password input if form is visible on open
        if (!isShared) {
            passwordInput?.focus();
        }
    }
}

const shareModals = new ShareModals();
export default shareModals;

