import accountService from '../services/accountService.js';

/**
 * Account Modal Component
 *
 * FIXED HEIGHT MODAL: 380px total height for all states
 * - Header: 48px
 * - Content: 272px (flex, centers smaller content)
 * - Footer: 60px
 */

const MODAL_CLASSES = 'account-modal-panel w-full max-w-sm h-[380px] flex flex-col rounded-xl border border-border bg-background shadow-2xl mx-4';

class AccountModal {
    constructor(app) {
        this.app = app;
        this.isOpen = false;
        this.overlay = document.getElementById('account-modal');
        this.accountState = accountService.getState();

        // Login flow state
        this.accountInputValue = '';
        this.recoveryInputValue = '';
        this.showRecoveryInput = false;

        // Creation flow state
        this.creationStep = 'idle';
        this.generatedAccountId = null;
        this.generatedRecoveryCode = null;
        this.recoveryCodeCopied = false;
        this.creationError = null;
        this.isLoadingAccountId = false;

        // Animation state
        this.revealedDigits = 0;
        this.animationTimeouts = [];

        // UI state
        this.returnFocusEl = null;
        this.escapeHandler = null;

        this.accountUnsubscribe = accountService.subscribe(state => {
            this.accountState = state;
            this.updateTabIndicator();
            if (this.isOpen && (this.creationStep === 'idle' || this.creationStep === 'complete')) {
                this.render();
            }
        });

        this.attachTabListener();
        this.updateTabIndicator();
    }

    attachTabListener() {
        const tabBtn = document.getElementById('account-tab-btn');
        if (tabBtn) {
            tabBtn.onclick = () => this.isOpen ? this.close() : this.open();
        }
    }

    updateTabIndicator() {
        const tabBtn = document.getElementById('account-tab-btn');
        if (!tabBtn) return;
        const hasAccount = !!this.accountState?.accountId;
        tabBtn.dataset.status = hasAccount ? 'logged-in' : 'none';
        tabBtn.title = hasAccount ? 'Account (logged in)' : 'Account';
    }

    open() {
        if (this.isOpen || !this.overlay) return;
        this.isOpen = true;
        this.returnFocusEl = document.activeElement;

        this.resetCreationFlow();
        this.render();
        this.overlay.classList.remove('hidden');

        const tabBtn = document.getElementById('account-tab-btn');
        if (tabBtn) tabBtn.setAttribute('aria-expanded', 'true');

        this.overlay.onclick = (e) => { if (e.target === this.overlay) this.handleCloseAttempt(); };
        this.escapeHandler = (e) => { if (e.key === 'Escape') this.handleCloseAttempt(); };
        document.addEventListener('keydown', this.escapeHandler);
    }

    handleCloseAttempt() {
        if (this.creationStep !== 'idle' && this.creationStep !== 'complete') {
            this.handleCancelCreation();
        }
        this.close();
    }

    close() {
        if (!this.isOpen || !this.overlay) return;
        this.isOpen = false;
        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
        this.clearAnimationTimeouts();

        const tabBtn = document.getElementById('account-tab-btn');
        if (tabBtn) tabBtn.setAttribute('aria-expanded', 'false');
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
        if (this.returnFocusEl?.focus) this.returnFocusEl.focus();
        this.returnFocusEl = null;
    }

    resetCreationFlow() {
        this.creationStep = 'idle';
        this.generatedAccountId = null;
        this.generatedRecoveryCode = null;
        this.recoveryCodeCopied = false;
        this.creationError = null;
        this.isLoadingAccountId = false;
        this.revealedDigits = 0;
        this.clearAnimationTimeouts();
    }

    clearAnimationTimeouts() {
        this.animationTimeouts.forEach(id => clearTimeout(id));
        this.animationTimeouts = [];
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatAccountId(accountId) {
        if (!accountId) return '';
        const normalized = accountId.replace(/\s+/g, '');
        return normalized.match(/.{1,4}/g)?.join(' ') || normalized;
    }

    // =========================================================================
    // Creation Flow Handlers
    // =========================================================================

    async handleGenerateAccountNumber() {
        this.creationStep = 'passkey';
        this.creationError = null;
        this.generatedAccountId = null;
        this.isLoadingAccountId = true;
        this.revealedDigits = 0;
        this.render();

        try {
            this.generatedAccountId = await accountService.prepareAccount();
            this.isLoadingAccountId = false;
            this.render();
            this.startDigitRevealAnimation();
        } catch (error) {
            this.creationStep = 'error';
            this.creationError = error.message || 'Failed to create account. Please try again.';
            this.isLoadingAccountId = false;
            this.render();
        }
    }

    startDigitRevealAnimation() {
        const totalDigits = 16;
        const revealDelay = 60;

        for (let i = 0; i <= totalDigits; i++) {
            const timeoutId = setTimeout(() => {
                this.revealedDigits = i;
                this.updateDigitDisplay();

                if (i === totalDigits) {
                    const triggerTimeout = setTimeout(() => this.handlePasskeyRegistration(), 400);
                    this.animationTimeouts.push(triggerTimeout);
                }
            }, i * revealDelay);
            this.animationTimeouts.push(timeoutId);
        }
    }

    updateDigitDisplay() {
        const display = this.overlay.querySelector('.account-number-text');
        if (!display || !this.generatedAccountId) return;
        const digits = this.generatedAccountId.substring(0, this.revealedDigits);
        display.textContent = this.formatAccountId(digits.padEnd(16, ' '));
    }

    async handlePasskeyRegistration() {
        const success = await accountService.registerPasskeyForPreparedAccount();

        if (success) {
            this.generatedRecoveryCode = accountService.generateRecoveryForPreparedAccount();
            this.creationStep = 'recovery';
            this.recoveryCodeCopied = false;
            this.creationError = null;
        } else {
            this.creationStep = 'passkey_retry';
            this.creationError = this.accountState?.error || 'Passkey registration failed.';
        }
        this.render();
    }

    handleRetryPasskey() {
        this.creationStep = 'passkey';
        this.creationError = null;
        this.revealedDigits = 16;
        this.render();

        const timeoutId = setTimeout(() => this.handlePasskeyRegistration(), 200);
        this.animationTimeouts.push(timeoutId);
    }

    async handleCopyRecoveryCode() {
        if (!this.generatedRecoveryCode) return;
        try {
            await navigator.clipboard.writeText(this.generatedRecoveryCode);
            this.recoveryCodeCopied = true;
            this.render();
            this.app?.showToast?.('Recovery code copied.', 'success');
        } catch (error) {
            console.error('Failed to copy recovery code:', error);
            this.app?.showToast?.('Failed to copy. Please copy manually.', 'error');
        }
    }

    async handleConfirmRecoverySaved() {
        this.creationStep = 'confirming';
        this.creationError = null;
        this.render();

        try {
            await accountService.completeAccountRegistration();
            this.creationStep = 'complete';
            this.render();
            this.app?.showToast?.('Account created successfully!', 'success');
        } catch (error) {
            this.creationStep = 'error';
            this.creationError = error.message || 'Registration failed.';
            this.render();
        }
    }

    handleCancelCreation() {
        accountService.cancelPendingAccount();
        this.resetCreationFlow();
        this.render();
    }

    handleStartOver() {
        accountService.cancelPendingAccount();
        this.resetCreationFlow();
        this.render();
    }

    // =========================================================================
    // Existing Account Handlers
    // =========================================================================

    async handleAccountPasskeyUnlock() {
        const accountId = this.accountState?.accountId || this.accountInputValue?.trim();
        const success = await accountService.unlockWithPasskey(accountId);
        if (success) this.app?.showToast?.('Account unlocked.', 'success');
    }

    async handleAccountRecoveryUnlock() {
        const accountId = this.accountState?.accountId || this.accountInputValue?.trim();
        const success = await accountService.unlockWithRecoveryCode(accountId, this.recoveryInputValue);
        if (success) this.app?.showToast?.('Account unlocked with recovery code.', 'success');
    }

    async handleAccountCopyId() {
        if (!this.accountState?.accountId) return;
        try {
            await navigator.clipboard.writeText(this.accountState.accountId);
            this.app?.showToast?.('Account ID copied.', 'success');
        } catch (error) {
            console.error('Failed to copy account ID:', error);
        }
    }

    handleAccountToggleRecovery() {
        this.showRecoveryInput = !this.showRecoveryInput;
        this.render();
    }

    async handleAccountClear() {
        await accountService.clearLocalAccount();
        this.accountInputValue = '';
        this.recoveryInputValue = '';
        this.showRecoveryInput = false;
        this.resetCreationFlow();
        this.render();
        this.app?.showToast?.('Logged out.', 'success');
    }

    // =========================================================================
    // Render
    // =========================================================================

    render() {
        if (!this.overlay) return;

        const state = this.accountState || {};
        const accountId = state.accountId;

        if (this.creationStep !== 'idle' && !accountId) {
            this.overlay.innerHTML = this.renderCreationFlow();
        } else {
            this.overlay.innerHTML = this.renderAccountUI();
        }

        this.attachEventListeners();
    }

    renderHeader(title, subtitle = null) {
        return `
            <div class="flex items-center justify-between border-b border-border px-5 h-12 shrink-0">
                <div class="flex items-center gap-2">
                    <h2 class="text-sm font-semibold text-foreground">${title}</h2>
                    ${subtitle ? `<span class="text-xs text-muted-foreground">${subtitle}</span>` : ''}
                </div>
                <button id="close-account-modal" class="text-muted-foreground hover:text-foreground transition-colors p-1.5 -mr-1.5 rounded-lg hover:bg-accent" aria-label="Close">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
            </div>
        `;
    }

    renderCreationFlow() {
        const step = this.creationStep;
        const title = step === 'complete' ? 'Account Created' : step === 'error' ? 'Error' : 'Create Account';

        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}">
                ${this.renderHeader(title)}
                <div class="flex-1 px-5 flex items-center justify-center overflow-hidden">
                    <div class="w-full">
                        ${this.renderCreationBody(step)}
                    </div>
                </div>
                <div class="px-5 pb-5 shrink-0">
                    ${this.renderCreationActions(step)}
                </div>
            </div>
        `;
    }

    renderCreationBody(step) {
        switch (step) {
            case 'passkey':
            case 'passkey_retry': {
                const isWaiting = this.isLoadingAccountId || this.revealedDigits < 16;
                const displayText = this.generatedAccountId
                    ? this.formatAccountId(this.generatedAccountId.substring(0, this.revealedDigits).padEnd(16, '\u2007'))
                    : '\u2007\u2007\u2007\u2007 \u2007\u2007\u2007\u2007 \u2007\u2007\u2007\u2007 \u2007\u2007\u2007\u2007';

                const errorMsg = step === 'passkey_retry' ? `
                    <div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400 mb-5">
                        <svg class="w-4 h-4 text-amber-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"></path>
                        </svg>
                        <span>${this.escapeHtml(this.creationError || 'Passkey cancelled. Try again.')}</span>
                    </div>
                ` : '';

                return `
                    <div class="text-center">
                        ${errorMsg}
                        <div class="text-xs text-muted-foreground mb-3">Your account number</div>
                        <div class="account-number-text font-mono text-2xl tracking-widest text-foreground mb-4 ${isWaiting ? 'animate-pulse' : ''}">
                            ${displayText}
                        </div>
                        <div class="text-sm text-muted-foreground">
                            ${isWaiting ? 'Generating...' : 'Complete passkey registration...'}
                        </div>
                    </div>
                `;
            }

            case 'recovery':
                return `
                    <div class="space-y-4">
                        <div class="flex items-center justify-between">
                            <div>
                                <div class="text-xs text-muted-foreground mb-1">Account</div>
                                <div class="font-mono text-base tracking-wide text-foreground">${this.formatAccountId(this.generatedAccountId)}</div>
                            </div>
                            <div class="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path>
                                </svg>
                                <span class="text-xs font-medium">Passkey saved</span>
                            </div>
                        </div>
                        <div>
                            <div class="flex items-center justify-between mb-2">
                                <span class="text-xs text-muted-foreground">Recovery code</span>
                                <button id="copy-recovery-btn" class="text-xs text-blue-600 dark:text-blue-400 hover:underline" type="button">
                                    ${this.recoveryCodeCopied ? 'Copied!' : 'Copy'}
                                </button>
                            </div>
                            <code class="block font-mono text-base text-foreground bg-muted/50 rounded-lg px-4 py-3 select-all border border-border">
                                ${this.escapeHtml(this.generatedRecoveryCode || '')}
                            </code>
                        </div>
                        <p class="text-xs text-muted-foreground text-center">Save this code somewhere safe. You'll need it to recover your account.</p>
                    </div>
                `;

            case 'confirming':
                return `
                    <div class="text-center">
                        <div class="w-12 h-12 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                        <div class="text-sm text-muted-foreground">Securing your account...</div>
                    </div>
                `;

            case 'complete':
                return `
                    <div class="text-center">
                        <div class="w-16 h-16 bg-emerald-100 dark:bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                            <svg class="w-8 h-8 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path>
                            </svg>
                        </div>
                        <div class="text-lg font-medium text-foreground mb-1">You're all set!</div>
                        <div class="font-mono text-sm text-muted-foreground">${this.formatAccountId(this.generatedAccountId)}</div>
                    </div>
                `;

            case 'error':
                return `
                    <div class="text-center">
                        <div class="w-16 h-16 bg-destructive/10 rounded-full flex items-center justify-center mx-auto mb-4">
                            <svg class="w-8 h-8 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                            </svg>
                        </div>
                        <div class="text-base text-destructive font-medium mb-1">Something went wrong</div>
                        <div class="text-sm text-muted-foreground">${this.escapeHtml(this.creationError || 'Please try again.')}</div>
                    </div>
                `;

            default:
                return '';
        }
    }

    renderCreationActions(step) {
        switch (step) {
            case 'passkey':
                return `
                    <button id="cancel-creation-btn" class="w-full h-10 rounded-lg text-sm border border-border bg-background text-foreground hover:bg-accent transition-colors" type="button">
                        Cancel
                    </button>
                `;

            case 'passkey_retry':
                return `
                    <div class="flex gap-3">
                        <button id="cancel-creation-btn" class="flex-1 h-10 rounded-lg text-sm border border-border bg-background text-foreground hover:bg-accent transition-colors" type="button">
                            Cancel
                        </button>
                        <button id="retry-passkey-btn" class="flex-1 h-10 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors" type="button">
                            Try Again
                        </button>
                    </div>
                `;

            case 'recovery':
                return `
                    <button id="confirm-saved-btn" class="w-full h-10 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" type="button" ${this.recoveryCodeCopied ? '' : 'disabled'}>
                        I've saved my recovery code
                    </button>
                `;

            case 'confirming':
                return `
                    <button class="w-full h-10 rounded-lg text-sm bg-muted text-muted-foreground cursor-not-allowed" type="button" disabled>
                        Creating account...
                    </button>
                `;

            case 'complete':
                return `
                    <button id="close-complete-btn" class="w-full h-10 rounded-lg text-sm border border-border bg-background text-foreground hover:bg-accent transition-colors" type="button">
                        Done
                    </button>
                `;

            case 'error':
                return `
                    <button id="start-over-btn" class="w-full h-10 rounded-lg text-sm border border-border bg-background text-foreground hover:bg-accent transition-colors" type="button">
                        Start Over
                    </button>
                `;

            default:
                return '';
        }
    }

    renderAccountUI() {
        const state = this.accountState || {};
        const accountId = state.accountId;
        const formattedAccountId = accountId ? this.formatAccountId(accountId) : '';
        const passkeySupported = state.passkeySupported;

        const errorMessage = state.error ? `
            <div class="text-xs text-destructive mt-3">${this.escapeHtml(state.error)}</div>
        ` : '';

        // Logged in state
        if (accountId) {
            return `
                <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}">
                    ${this.renderHeader('Account', '<span class="inline-flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>Logged in</span>')}
                    <div class="flex-1 px-5 flex items-center justify-center overflow-hidden">
                        <div class="w-full text-center">
                            <div class="text-xs text-muted-foreground mb-2">Account ID</div>
                            <div class="font-mono text-2xl tracking-widest text-foreground mb-3">${this.escapeHtml(formattedAccountId)}</div>
                            <div class="text-sm text-muted-foreground">Encrypted sync coming soon</div>
                        </div>
                    </div>
                    <div class="px-5 pb-5 shrink-0">
                        <div class="flex gap-3">
                            <button id="account-copy-id-btn" class="flex-1 h-10 rounded-lg text-sm border border-border bg-background hover:bg-accent transition-colors" type="button">
                                Copy ID
                            </button>
                            <button id="account-clear-btn" class="flex-1 h-10 rounded-lg text-sm border border-border bg-background hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors" type="button">
                                Log out
                            </button>
                        </div>
                        ${errorMessage}
                    </div>
                </div>
            `;
        }

        // No account - show create/login
        const accountValue = this.escapeHtml(this.accountInputValue || '');
        const recoveryValue = this.escapeHtml(this.recoveryInputValue || '');
        const showRecovery = this.showRecoveryInput;
        const isBusy = state.busy;
        const action = state.action;

        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}">
                ${this.renderHeader('Account', 'for encrypted sync')}
                <div class="flex-1 px-5 flex flex-col justify-center overflow-y-auto">
                    ${!passkeySupported ? `
                        <div class="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive mb-4 shrink-0">
                            Passkeys are not supported in this browser.
                        </div>
                    ` : ''}

                    <!-- Create section -->
                    <button id="generate-account-btn" class="w-full h-10 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 shrink-0" type="button" ${!passkeySupported ? 'disabled' : ''}>
                        Create new account
                    </button>

                    <!-- Divider -->
                    <div class="relative my-4 shrink-0">
                        <div class="absolute inset-0 flex items-center">
                            <div class="w-full border-t border-border"></div>
                        </div>
                        <div class="relative flex justify-center">
                            <span class="bg-background px-3 text-xs text-muted-foreground">or log in</span>
                        </div>
                    </div>

                    <!-- Login section -->
                    <div class="space-y-3 shrink-0">
                        <input
                            id="account-id-input"
                            type="text"
                            inputmode="numeric"
                            maxlength="19"
                            placeholder="0000 0000 0000 0000"
                            class="w-full h-10 px-4 text-center font-mono text-sm tracking-widest border border-border rounded-lg bg-background text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                            value="${accountValue}"
                            autocomplete="off"
                        />

                        <div class="flex gap-3">
                            <button id="account-passkey-btn" class="flex-1 h-10 rounded-lg text-sm border border-border bg-background text-foreground hover:bg-accent transition-colors disabled:opacity-50" type="button" ${isBusy || !passkeySupported ? 'disabled' : ''}>
                                ${isBusy && action === 'unlock' ? 'Logging in...' : 'Log in with passkey'}
                            </button>
                            <button id="account-recovery-toggle-btn" class="h-10 px-4 rounded-lg text-sm border border-border bg-background hover:bg-accent transition-colors" type="button">
                                ${showRecovery ? 'Hide' : 'Recovery'}
                            </button>
                        </div>

                        ${showRecovery ? `
                            <input
                                id="account-recovery-code-input"
                                type="text"
                                placeholder="recovery-code-words"
                                class="w-full h-10 px-4 text-sm font-mono border border-border rounded-lg bg-background text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                                value="${recoveryValue}"
                                ${isBusy ? 'disabled' : ''}
                            />
                            <button id="account-recovery-submit-btn" class="w-full h-10 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50" type="button" ${isBusy ? 'disabled' : ''}>
                                ${isBusy && action === 'recover' ? 'Logging in...' : 'Log in with recovery'}
                            </button>
                        ` : ''}
                    </div>

                    ${errorMessage}
                </div>
            </div>
        `;
    }

    // =========================================================================
    // Event Listeners
    // =========================================================================

    attachEventListeners() {
        const closeBtn = document.getElementById('close-account-modal');
        if (closeBtn) closeBtn.onclick = () => this.handleCloseAttempt();

        const closeCompleteBtn = document.getElementById('close-complete-btn');
        if (closeCompleteBtn) closeCompleteBtn.onclick = () => this.close();

        const generateBtn = document.getElementById('generate-account-btn');
        if (generateBtn) generateBtn.onclick = () => this.handleGenerateAccountNumber();

        const cancelCreationBtn = document.getElementById('cancel-creation-btn');
        if (cancelCreationBtn) cancelCreationBtn.onclick = () => this.handleCancelCreation();

        const retryPasskeyBtn = document.getElementById('retry-passkey-btn');
        if (retryPasskeyBtn) retryPasskeyBtn.onclick = () => this.handleRetryPasskey();

        const copyRecoveryBtn = document.getElementById('copy-recovery-btn');
        if (copyRecoveryBtn) copyRecoveryBtn.onclick = () => this.handleCopyRecoveryCode();

        const confirmSavedBtn = document.getElementById('confirm-saved-btn');
        if (confirmSavedBtn) confirmSavedBtn.onclick = () => this.handleConfirmRecoverySaved();

        const startOverBtn = document.getElementById('start-over-btn');
        if (startOverBtn) startOverBtn.onclick = () => this.handleStartOver();

        const accountInput = document.getElementById('account-id-input');
        if (accountInput) {
            accountInput.oninput = (e) => {
                const raw = e.target.value.replace(/\s+/g, '').replace(/\D/g, '').slice(0, 16);
                const formatted = raw.match(/.{1,4}/g)?.join(' ') || raw;
                e.target.value = formatted;
                this.accountInputValue = formatted;
            };
            accountInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); this.handleAccountPasskeyUnlock(); } };
        }

        const recoveryInput = document.getElementById('account-recovery-code-input');
        if (recoveryInput) {
            recoveryInput.oninput = (e) => { this.recoveryInputValue = e.target.value; };
            recoveryInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); this.handleAccountRecoveryUnlock(); } };
        }

        const passkeyBtn = document.getElementById('account-passkey-btn');
        if (passkeyBtn) passkeyBtn.onclick = () => this.handleAccountPasskeyUnlock();

        const recoveryToggleBtn = document.getElementById('account-recovery-toggle-btn');
        if (recoveryToggleBtn) recoveryToggleBtn.onclick = () => this.handleAccountToggleRecovery();

        const recoverySubmitBtn = document.getElementById('account-recovery-submit-btn');
        if (recoverySubmitBtn) recoverySubmitBtn.onclick = () => this.handleAccountRecoveryUnlock();

        const copyIdBtn = document.getElementById('account-copy-id-btn');
        if (copyIdBtn) copyIdBtn.onclick = () => this.handleAccountCopyId();

        const clearBtn = document.getElementById('account-clear-btn');
        if (clearBtn) clearBtn.onclick = () => this.handleAccountClear();
    }

    destroy() {
        this.clearAnimationTimeouts();
        if (this.accountUnsubscribe) {
            this.accountUnsubscribe();
            this.accountUnsubscribe = null;
        }
    }
}

export default AccountModal;
