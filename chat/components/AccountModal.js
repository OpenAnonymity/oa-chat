import accountService from '../services/accountService.js';

/**
 * Account Modal Component
 * Modern, clean design matching ShareModals aesthetic
 */

const MODAL_CLASSES = 'w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl p-5 mx-4 flex flex-col';

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

        // Recovery flow state (for multi-step recovery UI)
        this.recoveryStep = 'idle'; // 'idle' | 'verifying' | 'adding_passkey' | 'complete'

        // Creation flow state
        this.creationStep = 'idle';
        this.generatedAccountId = null;
        this.generatedRecoveryCode = null;
        this.accountIdCopied = false;
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
        this.recoveryStep = 'idle';
        // Clear any stale errors when opening
        accountService.clearErrors();
        this.render();
        this.overlay.classList.remove('hidden');

        const tabBtn = document.getElementById('account-tab-btn');
        if (tabBtn) tabBtn.setAttribute('aria-expanded', 'true');

        this.overlay.onclick = (e) => { if (e.target === this.overlay) this.handleCloseAttempt(); };
        this.escapeHandler = (e) => { if (e.key === 'Escape') this.handleCloseAttempt(); };
        document.addEventListener('keydown', this.escapeHandler);
    }

    handleCloseAttempt() {
        // Don't allow closing during recovery step - user must save their codes
        if (this.creationStep === 'recovery') {
            return;
        }
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
        this.accountIdCopied = false;
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
        const revealed = this.generatedAccountId.substring(0, this.revealedDigits);
        const placeholder = '\u2007'.repeat(16 - this.revealedDigits);
        const full = revealed + placeholder;
        display.textContent = full.match(/.{1,4}/g)?.join(' ') || full;
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

    async handleCopyAccountId() {
        if (!this.generatedAccountId) return;
        try {
            await navigator.clipboard.writeText(this.generatedAccountId);
            this.accountIdCopied = true;
            this.render();
            this.app?.showToast?.('Account ID copied.', 'success');
        } catch (error) {
            console.error('Failed to copy account ID:', error);
            this.app?.showToast?.('Failed to copy. Please copy manually.', 'error');
        }
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

    async handleCopyBoth() {
        if (!this.generatedAccountId || !this.generatedRecoveryCode) return;
        try {
            const text = `Account ID: ${this.generatedAccountId}\nRecovery code: ${this.generatedRecoveryCode}`;
            await navigator.clipboard.writeText(text);
            this.accountIdCopied = true;
            this.recoveryCodeCopied = true;
            this.render();
            this.app?.showToast?.('Both copied.', 'success');
        } catch (error) {
            console.error('Failed to copy:', error);
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
        const recoveryCode = this.recoveryInputValue;
        
        // Clear any previous errors before starting
        accountService.clearErrors();
        
        // Show "adding passkey" state before prompting
        this.recoveryStep = 'adding_passkey';
        this.render();

        // Brief delay for user to see the message before passkey prompt
        await new Promise(resolve => setTimeout(resolve, 0));

        try {
            // Step 3: Call recovery (this triggers the passkey prompt)
            const success = await accountService.unlockWithRecoveryCode(accountId, recoveryCode);
            
            if (success) {
                // Step 4: Show success
                this.recoveryStep = 'complete';
                this.render();
                // Brief delay to show success state
                setTimeout(() => {
                    this.recoveryStep = 'idle';
                    this.showRecoveryInput = false;
                    this.recoveryInputValue = '';
                    this.render();
                    this.app?.showToast?.('Account recovered successfully!', 'success');
                }, 1500);
            } else {
                this.recoveryStep = 'idle';
                this.render();
            }
        } catch (error) {
            this.recoveryStep = 'idle';
            this.render();
        }
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

    renderHeader(title, showClose = true) {
        return `
            <div class="flex items-center justify-between mb-4">
                <h3 class="text-base font-medium text-foreground">${title}</h3>
                ${showClose ? `
                    <button id="close-account-modal" class="text-muted-foreground hover:text-foreground transition-colors p-1 -mr-1 rounded-lg hover:bg-accent" aria-label="Close">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                ` : ''}
            </div>
        `;
    }

    renderCreationFlow() {
        const step = this.creationStep;

        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}">
                ${this.renderHeader(step === 'complete' ? 'Account Created' : step === 'error' ? 'Error' : 'Create Account')}
                <div class="flex-1 flex items-center justify-center">
                    ${this.renderCreationBody(step)}
                </div>
                <div class="mt-4">
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
                // Build display text manually to avoid formatAccountId stripping figure spaces
                const displayText = (() => {
                    if (!this.generatedAccountId || this.revealedDigits === 0) {
                        return '\u2007\u2007\u2007\u2007 \u2007\u2007\u2007\u2007 \u2007\u2007\u2007\u2007 \u2007\u2007\u2007\u2007';
                    }
                    const revealed = this.generatedAccountId.substring(0, this.revealedDigits);
                    const placeholder = '\u2007'.repeat(16 - this.revealedDigits);
                    const full = revealed + placeholder;
                    return full.match(/.{1,4}/g)?.join(' ') || full;
                })();

                const errorMsg = step === 'passkey_retry' ? `
                    <div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400 mb-4">
                        <svg class="w-4 h-4 text-amber-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"></path>
                        </svg>
                        <span>${this.escapeHtml(this.creationError || 'Passkey cancelled. Try again.')}</span>
                    </div>
                ` : '';

                return `
                    <div class="w-full text-center">
                        ${errorMsg}
                        <p class="text-xs text-muted-foreground mb-3">Your account number</p>
                        <div class="account-number-text font-mono text-xl tracking-widest text-foreground mb-4 whitespace-nowrap ${isWaiting ? 'animate-pulse' : ''}">
                            ${displayText}
                        </div>
                        <p class="text-sm text-muted-foreground">
                            ${isWaiting ? 'Generating...' : 'Complete passkey registration...'}
                        </p>
                    </div>
                `;
            }

            case 'recovery':
                return `
                    <div class="w-full">
                        <div class="flex items-center justify-between mb-2">
                            <span class="text-xs text-muted-foreground">Your account number</span>
                            <button id="copy-account-btn" class="text-xs text-blue-600 dark:text-blue-400 hover:underline" type="button">
                                ${this.accountIdCopied ? 'Copied!' : 'Copy'}
                            </button>
                        </div>
                        <div class="account-number-text font-mono text-xl tracking-widest text-foreground mb-4 whitespace-nowrap text-center">
                            ${this.formatAccountId(this.generatedAccountId)}
                        </div>
                        <div class="flex items-center justify-between mb-2">
                            <span class="text-xs text-muted-foreground">Recovery code</span>
                            <button id="copy-recovery-btn" class="text-xs text-blue-600 dark:text-blue-400 hover:underline" type="button">
                                ${this.recoveryCodeCopied ? 'Copied!' : 'Copy'}
                            </button>
                        </div>
                        <code class="block font-mono text-sm text-foreground select-all text-center mb-4">
                            ${this.escapeHtml(this.generatedRecoveryCode || '')}
                        </code>
                        <p class="text-[11px] text-muted-foreground mt-4 text-center">
                            <button id="copy-both-btn" class="text-blue-600 dark:text-blue-400 hover:underline" type="button">${this.accountIdCopied && this.recoveryCodeCopied ? 'Both copied' : 'Copy both'}</button> to continue
                        </p>
                    </div>
                `;

            case 'confirming':
                return `
                    <div class="w-full text-center py-6">
                        <div class="w-10 h-10 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
                        <p class="text-sm text-muted-foreground">Securing your account...</p>
                    </div>
                `;

            case 'complete':
                return `
                    <div class="w-full text-center py-4">
                        <div class="w-14 h-14 bg-emerald-100 dark:bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto mb-3">
                            <svg class="w-7 h-7 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path>
                            </svg>
                        </div>
                        <p class="text-base font-medium text-foreground mb-1">You're all set!</p>
                        <p class="account-number-text font-mono text-sm text-muted-foreground whitespace-nowrap">${this.formatAccountId(this.generatedAccountId)}</p>
                    </div>
                `;

            case 'error':
                return `
                    <div class="w-full text-center py-4">
                        <div class="w-14 h-14 bg-destructive/10 rounded-full flex items-center justify-center mx-auto mb-3">
                            <svg class="w-7 h-7 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                            </svg>
                        </div>
                        <p class="text-base text-destructive font-medium mb-1">Something went wrong</p>
                        <p class="text-sm text-muted-foreground">${this.escapeHtml(this.creationError || 'Please try again.')}</p>
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
                    <button id="cancel-creation-btn" class="w-full h-9 rounded-lg text-sm border border-border bg-background text-foreground hover:bg-accent transition-colors" type="button">
                        Cancel
                    </button>
                `;

            case 'passkey_retry':
                return `
                    <div class="flex gap-3">
                        <button id="cancel-creation-btn" class="flex-1 h-9 rounded-lg text-sm border border-border bg-background text-foreground hover:bg-accent transition-colors" type="button">
                            Cancel
                        </button>
                        <button id="retry-passkey-btn" class="flex-1 h-9 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors" type="button">
                            Try Again
                        </button>
                    </div>
                `;

            case 'recovery': {
                const bothCopied = this.accountIdCopied && this.recoveryCodeCopied;
                return `
                    <button id="confirm-saved-btn" class="w-full h-9 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" type="button" ${bothCopied ? '' : 'disabled'}>
                        I've saved both
                    </button>
                `;
            }

            case 'confirming':
                return `
                    <button class="w-full h-9 rounded-lg text-sm bg-muted text-muted-foreground cursor-not-allowed" type="button" disabled>
                        Creating account...
                    </button>
                `;

            case 'complete':
                return `
                    <button id="close-complete-btn" class="w-full h-9 rounded-lg text-sm border border-border bg-background text-foreground hover:bg-accent transition-colors" type="button">
                        Done
                    </button>
                `;

            case 'error':
                return `
                    <button id="start-over-btn" class="w-full h-9 rounded-lg text-sm border border-border bg-background text-foreground hover:bg-accent transition-colors" type="button">
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
        const isBusy = state.busy;
        const action = state.action;

        // Recovery flow UI (verifying/adding passkey)
        if (this.recoveryStep === 'verifying' || this.recoveryStep === 'adding_passkey') {
            return this.renderRecoveryFlowUI();
        }

        // Recovery complete UI
        if (this.recoveryStep === 'complete') {
            return this.renderRecoveryCompleteUI();
        }

        // Logged in state - don't show errors here since login was successful
        if (accountId) {
            return `
                <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}">
                    ${this.renderHeader('Account')}
                    <div class="flex-1 flex flex-col items-center justify-center py-4">
                        <div class="flex items-center gap-2 mb-4">
                            <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
                            <span class="text-xs text-muted-foreground">Logged in</span>
                        </div>
                        <p class="account-number-text font-mono text-lg tracking-widest text-foreground mb-2 whitespace-nowrap">${this.escapeHtml(formattedAccountId)}</p>
                        <p class="text-xs text-muted-foreground">Encrypted sync coming soon</p>
                    </div>
                    <div class="flex gap-3 mt-4">
                        <button id="account-copy-id-btn" class="flex-1 h-9 rounded-lg text-sm border border-border bg-background hover:bg-accent transition-colors" type="button">
                            Copy ID
                        </button>
                        <button id="account-clear-btn" class="flex-1 h-9 rounded-lg text-sm border border-border bg-background hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors" type="button">
                            Log out
                        </button>
                    </div>
                </div>
            `;
        }

        // No account - show create/login
        const accountValue = this.escapeHtml(this.accountInputValue || '');
        const recoveryValue = this.escapeHtml(this.recoveryInputValue || '');
        const showRecovery = this.showRecoveryInput;

        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}">
                ${this.renderHeader('Account')}
                
                <p class="text-xs text-muted-foreground mb-4">Create or log in to enable encrypted sync across devices.</p>
                
                ${!passkeySupported ? `
                    <div class="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive mb-4">
                        Passkeys are not supported in this browser.
                    </div>
                ` : ''}

                <!-- Create account button -->
                <button id="generate-account-btn" class="w-full h-9 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50" type="button" ${!passkeySupported ? 'disabled' : ''}>
                    Create new account
                </button>

                <!-- Divider -->
                <div class="flex items-center gap-3 my-4">
                    <div class="flex-1 h-px bg-border"></div>
                    <span class="text-xs text-muted-foreground">or log in</span>
                    <div class="flex-1 h-px bg-border"></div>
                </div>

                <!-- Login section -->
                <div class="space-y-3">
                    <input
                        id="account-id-input"
                        type="text"
                        inputmode="numeric"
                        maxlength="19"
                        placeholder="0000 0000 0000 0000"
                        class="w-full h-9 px-3 text-center font-mono text-sm tracking-widest border border-border rounded-lg bg-background text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                        value="${accountValue}"
                        autocomplete="off"
                    />

                    ${showRecovery ? `
                        <input
                            id="account-recovery-code-input"
                            type="text"
                            placeholder="Enter recovery code"
                            class="w-full h-9 px-3 text-center font-mono text-sm border border-border rounded-lg bg-background text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                            value="${recoveryValue}"
                            ${isBusy ? 'disabled' : ''}
                        />
                        <button id="account-recovery-submit-btn" class="w-full h-9 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50" type="button" ${isBusy ? 'disabled' : ''}>
                            ${isBusy && action === 'recover' ? 'Recovering...' : 'Recover account'}
                        </button>
                        <button id="account-recovery-toggle-btn" class="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1" type="button">
                            Back to passkey login
                        </button>
                    ` : `
                        <button id="account-passkey-btn" class="w-full h-9 rounded-lg text-sm border border-border bg-background text-foreground hover:bg-accent transition-colors disabled:opacity-50" type="button" ${isBusy || !passkeySupported ? 'disabled' : ''}>
                            ${isBusy && action === 'unlock' ? 'Logging in...' : 'Log in with passkey'}
                        </button>

                        <button id="account-recovery-toggle-btn" class="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1" type="button">
                            Recover your account
                        </button>
                    `}
                </div>

                ${state.error ? `<p class="text-xs text-destructive mt-3 text-center">${this.escapeHtml(state.error)}</p>` : ''}
            </div>
        `;
    }

    renderRecoveryFlowUI() {
        const state = this.accountState || {};
        const isVerifying = this.recoveryStep === 'verifying';
        const isAddingPasskey = this.recoveryStep === 'adding_passkey';
        
        if (isVerifying) {
            return `
                <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}">
                    ${this.renderHeader('Recovering Account', false)}
                    <div class="flex-1 flex flex-col items-center justify-center py-8">
                        <div class="w-10 h-10 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p class="text-sm font-medium text-foreground mb-1">Verifying recovery code...</p>
                        <p class="text-xs text-muted-foreground text-center">Please wait while we verify your code.</p>
                    </div>
                    ${state.error ? `<p class="text-xs text-destructive mt-3 text-center">${this.escapeHtml(state.error)}</p>` : ''}
                </div>
            `;
        }
        
        // Adding passkey step - show explanation before passkey prompt
        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}">
                ${this.renderHeader('Replace Passkey', false)}
                <div class="flex-1 flex flex-col items-center justify-center py-6">
                    <div class="w-12 h-12 bg-blue-100 dark:bg-blue-500/20 rounded-full flex items-center justify-center mb-4">
                        <svg class="w-6 h-6 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"></path>
                        </svg>
                    </div>
                    <p class="text-sm font-medium text-foreground mb-2">Add a new passkey</p>
                    <p class="text-xs text-muted-foreground text-center max-w-[260px]">
                        Your recovery code was verified. You'll now be prompted to add a new passkey to secure your account.
                    </p>
                </div>
                ${state.error ? `<p class="text-xs text-destructive mt-3 text-center">${this.escapeHtml(state.error)}</p>` : ''}
            </div>
        `;
    }

    renderRecoveryCompleteUI() {
        const accountId = this.accountState?.accountId;
        const formattedAccountId = accountId ? this.formatAccountId(accountId) : '';

        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}">
                ${this.renderHeader('Account Recovered', false)}
                <div class="flex-1 flex flex-col items-center justify-center py-6">
                    <div class="w-14 h-14 bg-emerald-100 dark:bg-emerald-500/20 rounded-full flex items-center justify-center mb-3">
                        <svg class="w-7 h-7 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path>
                        </svg>
                    </div>
                    <p class="text-base font-medium text-foreground mb-1">Account recovered!</p>
                    <p class="account-number-text font-mono text-sm text-muted-foreground mb-2 whitespace-nowrap">${this.escapeHtml(formattedAccountId)}</p>
                    <p class="text-xs text-muted-foreground">New passkey has been added.</p>
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

        const copyAccountBtn = document.getElementById('copy-account-btn');
        if (copyAccountBtn) copyAccountBtn.onclick = () => this.handleCopyAccountId();

        const copyRecoveryBtn = document.getElementById('copy-recovery-btn');
        if (copyRecoveryBtn) copyRecoveryBtn.onclick = () => this.handleCopyRecoveryCode();

        const copyBothBtn = document.getElementById('copy-both-btn');
        if (copyBothBtn) copyBothBtn.onclick = () => this.handleCopyBoth();

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
