/**
 * Account Modal Component
 * Modern, clean design matching ShareModals aesthetic
 */

import { SLOT_NAMES } from '../extensions/extensionHost.js';

const MODAL_CLASSES = 'w-full max-w-md rounded-2xl border border-border/80 bg-background shadow-xl p-5 mx-4 flex flex-col';
const MODAL_FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

class AccountModal {
    constructor(app) {
        this.app = app;
        this.accountService = this.app.services.account;
        this.syncService = this.app.services.sync;
        this.isOpen = false;
        this.overlay = document.getElementById('account-modal');
        this.accountState = this.accountService.getState();

        // Login flow state
        this.accountInputValue = '';
        this.usernameInputValue = '';
        this.identifierMode = null;
        this.usernameContinuePending = false;
        this.usernameHandoffPending = false;
        this.loginViewVersion = 0;
        this.recoveryInputValue = '';
        this.showRecoveryInput = false;

        // Recovery flow state (for multi-step recovery UI)
        this.recoveryStep = 'idle'; // 'idle' | 'verifying' | 'adding_passkey' | 'complete'

        // Creation flow state
        this.creationStep = 'idle';
        this.generatedAccountId = null;
        this.generatedUsername = null;
        this.generatedRecoveryCode = null;
        this.accountIdCopied = false;
        this.recoveryCodeCopied = false;
        this.creationError = null;
        this.isLoadingAccountId = false;
        this.oauthProvider = null;
        this.authenticationExitPending = false;

        // Animation state
        this.revealedDigits = 0;
        this.animationTimeouts = [];

        // Sync state
        this.syncStatus = this.syncService.getStatus();

        // UI state
        this.returnFocusEl = null;
        this.escapeHandler = null;
        this.menuOpen = false;
        this.passkeyDetailsOpen = false;
        this.accountMenuTrigger = null;
        this.onDocumentPointerDown = event => {
            const nav = document.getElementById('account-nav');
            if (this.menuOpen && !nav?.contains(event.target)) this.closeAccountMenu();
        };

        this.accountUnsubscribe = this.accountService.subscribe(state => {
            this.accountState = state;
            this.updateTabIndicator();
            if (
                this.isOpen &&
                !this.shouldSuppressAuthenticationExitRender(state) &&
                (this.creationStep === 'idle' || this.creationStep === 'complete')
            ) {
                this.render();
            }
        });

        this.syncUnsubscribe = this.syncService.subscribe(() => {
            this.syncStatus = this.syncService.getStatus();
            if (
                this.isOpen &&
                this.accountState?.accountId &&
                !this.shouldSuppressAuthenticationExitRender()
            ) {
                this.render();
            }
        });

        this.attachAccountNavListeners();
        this.updateTabIndicator();
    }

    shouldSuppressAuthenticationExitRender(state = this.accountState) {
        return this.authenticationExitPending &&
            state?.sessionVerified === true &&
            state?.status === 'unlocked';
    }

    attachAccountNavListeners() {
        const tabBtn = document.getElementById('account-tab-btn');
        if (tabBtn) {
            tabBtn.onclick = () => {
                if (this.isAccountMenuAvailable()) {
                    this.menuOpen ? this.closeAccountMenu(true) : this.openAccountMenu(tabBtn);
                    return;
                }
                this.isOpen ? this.close() : this.open(tabBtn);
            };
            tabBtn.onblur = () => tabBtn.removeAttribute('data-auth-restored-focus');
            tabBtn.onkeydown = event => {
                // Automatic login focus is quiet until the user uses the keyboard.
                tabBtn.removeAttribute('data-auth-restored-focus');
                if (!this.isAccountMenuAvailable()) return;
                if (['ArrowDown', 'Enter', ' '].includes(event.key)) {
                    event.preventDefault();
                    this.openAccountMenu(tabBtn);
                }
            };
        }
        const menu = document.getElementById('account-settings-menu');
        const accountItem = document.getElementById('account-security-menu-item');
        const logoutItem = document.getElementById('account-logout-menu-item');
        if (menu) {
            menu.onkeydown = event => this.handleAccountMenuKeydown(event);
            menu.onclick = event => {
                if (event.target.closest?.('[role="menuitem"]')) this.closeAccountMenu();
            };
        }
        if (accountItem) accountItem.onclick = () => {
            this.closeAccountMenu();
            this.open(tabBtn);
        };
        if (logoutItem) logoutItem.onclick = () => {
            this.closeAccountMenu();
            void this.handleAccountClear();
        };
        document.addEventListener?.('pointerdown', this.onDocumentPointerDown);
    }

    getAccountMenuItems() {
        const menu = document.getElementById('account-settings-menu');
        return menu ? [...menu.querySelectorAll('[role="menuitem"]:not([disabled])')] : [];
    }

    isAccountMenuAvailable() {
        return Boolean(
            this.accountState?.authBootstrapComplete !== false &&
            this.accountState?.accountId &&
            this.accountState?.sessionVerified &&
            this.accountState?.status === 'unlocked'
        );
    }

    getAccountMenuReturnTarget() {
        const trigger = this.accountMenuTrigger;
        if (trigger && !trigger.hidden) return trigger;
        return document.getElementById('account-tab-btn');
    }

    openAccountMenu(trigger = null) {
        const tabBtn = document.getElementById('account-tab-btn');
        const menu = document.getElementById('account-settings-menu');
        if (!tabBtn || !menu || !this.isAccountMenuAvailable()) return;
        this.close();
        this.menuOpen = true;
        this.accountMenuTrigger = trigger || tabBtn;
        menu.hidden = false;
        tabBtn?.setAttribute('aria-expanded', 'true');
        this.app.extensionSlots?.refresh?.(SLOT_NAMES.ACCOUNT_MENU_ACTIONS);
        this.getAccountMenuItems()[0]?.focus();
    }

    closeAccountMenu(restoreFocus = false) {
        const tabBtn = document.getElementById('account-tab-btn');
        const menu = document.getElementById('account-settings-menu');
        const returnTarget = this.accountMenuTrigger || tabBtn;
        this.menuOpen = false;
        if (menu) menu.hidden = true;
        tabBtn?.setAttribute('aria-expanded', 'false');
        this.accountMenuTrigger = null;
        if (restoreFocus) returnTarget?.focus?.();
    }

    handleAccountMenuKeydown(event) {
        const items = this.getAccountMenuItems();
        if (event.key === 'Escape') {
            event.preventDefault();
            this.closeAccountMenu(true);
            return;
        }
        if (event.key === 'Tab') {
            this.closeAccountMenu();
            return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return;
        event.preventDefault();
        const current = Math.max(0, items.indexOf(event.target));
        const next = event.key === 'Home' ? 0
            : event.key === 'End' ? items.length - 1
                : event.key === 'ArrowDown' ? (current + 1) % items.length
                    : (current - 1 + items.length) % items.length;
        items[next].focus();
    }

    updateTabIndicator() {
        const tabBtn = document.getElementById('account-tab-btn');
        const identityLabel = document.getElementById('account-identity-label');
        const bootstrapStatus = document.getElementById('account-bootstrap-status');
        if (!tabBtn) return;
        const isAuthResolving = this.accountState?.authBootstrapComplete === false;
        // Only show logged-in (green) after session is verified with server
        const isLoggedIn = this.accountState?.accountId &&
            this.accountState?.sessionVerified &&
            this.accountState?.status === 'unlocked';
        const needsEncryptionUnlock = Boolean(
            this.accountState?.accountId &&
            this.accountState?.sessionVerified &&
            !isLoggedIn && (
                this.accountState?.oauthKeyringRequired ||
                this.accountState?.oauthRecoveryRequired ||
                this.accountState?.oauthLegacyPasskeyRequired ||
                this.accountState?.status === 'locked'
            )
        );
        const needsEncryptionSetup = Boolean(
            this.accountState?.accountId &&
            this.accountState?.sessionVerified &&
            this.accountState?.oauthSetupRequired
        );
        tabBtn.dataset.status = isAuthResolving
            ? 'loading'
            : isLoggedIn
            ? 'logged-in'
            : needsEncryptionUnlock || needsEncryptionSetup
                ? 'locked'
                : 'none';
        // Account restoration can include a network round trip. Keep the visible
        // control operable during that wait so it never behaves like a dead
        // button; opening it renders a neutral progress view without exposing
        // account actions before the session is verified.
        tabBtn.disabled = false;
        if (isAuthResolving) tabBtn.setAttribute('aria-busy', 'true');
        else tabBtn.removeAttribute?.('aria-busy');
        tabBtn.title = isAuthResolving
            ? 'Restoring account'
            : isLoggedIn
            ? 'Account (logged in)'
            : needsEncryptionSetup
                ? 'Finish account setup'
                : needsEncryptionUnlock
                    ? 'Google is signed in; encrypted data is locked'
                    : 'Account';
        const accountLabel = this.accountState?.username ||
            this.accountState?.oauthEmail ||
            this.accountState?.email;
        const identity = typeof accountLabel === 'string'
            ? accountLabel.trim()
            : '';
        const identityText = isAuthResolving
            ? ''
            : isLoggedIn && identity
                ? identity
            : needsEncryptionSetup
                ? 'Finish account setup'
                : needsEncryptionUnlock
                    ? 'Unlock encrypted data'
                    : 'Account';
        if (identityLabel) identityLabel.textContent = identityText;
        if (bootstrapStatus) {
            bootstrapStatus.textContent = isAuthResolving ? 'Restoring account' : '';
        }
        tabBtn.setAttribute(
            'aria-label',
            isAuthResolving
                ? 'Restoring account'
                : isLoggedIn && identity
                    ? `Account for ${identity}`
                : needsEncryptionSetup
                    ? 'Finish account setup'
                    : needsEncryptionUnlock
                        ? 'Unlock encrypted data; Google is signed in'
                        : 'Account'
        );
        tabBtn.setAttribute('aria-controls', isLoggedIn ? 'account-settings-menu' : 'account-modal');
        if (isLoggedIn && !isAuthResolving) tabBtn.setAttribute('aria-haspopup', 'menu');
        else tabBtn.removeAttribute?.('aria-haspopup');
        if (!isLoggedIn || isAuthResolving) this.closeAccountMenu();
    }

    open(returnFocusEl = null) {
        if (this.isOpen || !this.overlay) return;
        this.closeAccountMenu();
        this.isOpen = true;
        this.passkeyDetailsOpen = false;
        this.returnFocusEl = returnFocusEl || document.activeElement;

        this.resetCreationFlow();
        this.recoveryStep = 'idle';
        // Clear any stale errors when opening
        this.accountService.clearErrors();
        this.render();
        this.overlay.classList.remove('hidden');
        this.focusModal();

        const tabBtn = document.getElementById('account-tab-btn');
        if (tabBtn) tabBtn.setAttribute('aria-expanded', 'true');

        this.escapeHandler = (e) => this.handleModalKeydown(e);
        document.addEventListener('keydown', this.escapeHandler);
    }

    async openForUsername(username, returnFocusEl = null, { autoContinue = false } = {}) {
        if (this.isOpen || !this.overlay) return;
        this.identifierMode = 'username';
        this.usernameInputValue = String(username || '')
            .normalize('NFKC')
            .trim()
            .toLowerCase();
        const state = this.accountState || {};
        // Only a submitted landing username skips the form. Preserve saved
        // legacy/Google recovery and unlock surfaces, and unsupported browsers.
        this.usernameHandoffPending = autoContinue && Boolean(this.usernameInputValue) &&
            this.getIdentifierMode() === 'username' && !state.busy &&
            state.passkeySupported !== false &&
            !state.oauthRecoveryRequired && !state.oauthKeyringRequired &&
            !state.oauthSetupRequired && !state.oauthLegacyPasskeyRequired;
        this.open(returnFocusEl);
        if (!this.usernameHandoffPending) {
            this.focusModal('account-username-input');
            return;
        }
        const viewVersion = this.loginViewVersion;
        try {
            await this.handleAccountContinue();
        } finally {
            if (viewVersion === this.loginViewVersion) {
                this.usernameHandoffPending = false;
                if (this.isOpen) {
                    this.render();
                    this.focusModal('account-username-input');
                }
            }
        }
    }

    getModalFocusable() {
        return this.overlay
            ? [...this.overlay.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)]
            : [];
    }

    focusModal(preferredId = '') {
        if (!this.isOpen || !this.overlay) return;
        const preferred = preferredId ? document.getElementById(preferredId) : null;
        if (preferred && this.overlay.contains(preferred) && preferred.focus) {
            preferred.focus();
            return;
        }
        const target = this.getModalFocusable()[0] ||
            this.overlay.querySelector('[role="dialog"]');
        target?.focus?.();
    }

    handleModalKeydown(event) {
        if (!this.isOpen) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            this.handleCloseAttempt();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = this.getModalFocusable();
        if (focusable.length === 0) {
            event.preventDefault();
            this.overlay.querySelector('[role="dialog"]')?.focus?.();
            return;
        }
        const first = focusable[0];
        const last = focusable.at(-1);
        const active = document.activeElement;
        const outside = !this.overlay.contains(active);
        if ((event.shiftKey && (active === first || outside)) ||
            (!event.shiftKey && (active === last || outside))) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        }
    }

    handleCloseAttempt() {
        // Don't allow closing during recovery step - user must save their codes
        if (
            this.creationStep === 'recovery' ||
            this.creationStep === 'oauth_authorizing'
        ) {
            return;
        }
        if (this.creationStep !== 'idle' && this.creationStep !== 'complete') {
            this.handleCancelCreation();
        }
        this.close();
    }

    close({ afterAuthentication = false } = {}) {
        if (!this.isOpen || !this.overlay) return;
        this.isOpen = false;
        this.loginViewVersion += 1;
        this.usernameHandoffPending = false;
        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
        this.clearAnimationTimeouts();

        const tabBtn = document.getElementById('account-tab-btn');
        if (tabBtn) tabBtn.setAttribute('aria-expanded', 'false');
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
        if (this.returnFocusEl?.focus) {
            // Preserve the return target without leaving a focus ring after login.
            // Blur or the next keyboard interaction restores normal focus styling.
            if (afterAuthentication && this.returnFocusEl === tabBtn) {
                tabBtn.setAttribute('data-auth-restored-focus', 'true');
            }
            this.returnFocusEl.focus();
        }
        this.returnFocusEl = null;
    }

    resetCreationFlow() {
        this.creationStep = 'idle';
        this.generatedAccountId = null;
        this.generatedUsername = null;
        this.generatedRecoveryCode = null;
        this.accountIdCopied = false;
        this.recoveryCodeCopied = false;
        this.creationError = null;
        this.isLoadingAccountId = false;
        this.oauthProvider = null;
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

    formatTimeAgo(timestamp) {
        if (!timestamp) return '';
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 10) return 'just now';
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }

    // =========================================================================
    // Creation Flow Handlers
    // =========================================================================

    getOAuthProviderLabel() {
        return 'Google';
    }

    async handleOAuthAuthentication(provider) {
        this.oauthProvider = provider;
        this.creationStep = 'oauth_authorizing';
        this.creationError = null;
        this.render();

        const result = await this.accountService.authenticateWithOAuth(provider);
        if (!result) {
            this.creationStep = 'idle';
            this.oauthProvider = null;
            this.render();
            return;
        }

        const providerLabel = this.getOAuthProviderLabel(provider);
        this.creationStep = 'idle';
        if (result.status === 'unlocked') {
            this.app?.showToast?.(`Signed in with ${providerLabel}`, 'success');
            if (result.newAccount === true) {
                this.completeFirstAccountRouting();
            } else {
                this.close({ afterAuthentication: true });
            }
            return;
        }
        this.render();
    }

    completeFirstAccountRouting() {
        this.close({ afterAuthentication: true });
        this.app?.notifyFirstAccountReady?.();
    }

    async handleConnectOAuth(provider) {
        const providerLabel = this.getOAuthProviderLabel(provider);
        const result = await this.accountService.authenticateWithOAuth(
            provider,
            { link: true }
        );
        if (result?.status === 'linked') {
            this.app?.showToast?.(`${providerLabel} connected`, 'success');
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
        const success = await this.accountService.registerPasskeyForPreparedAccount();

        if (success) {
            if (this.generatedUsername) {
                this.creationStep = 'confirming';
                this.creationError = null;
                this.render();
                try {
                    await this.accountService.completeAccountRegistration();
                    this.creationStep = 'complete';
                    this.app?.showToast?.('Account created successfully', 'success');
                    this.completeFirstAccountRouting();
                } catch (error) {
                    this.creationStep = 'error';
                    this.creationError = error.message || 'Registration failed.';
                    this.render();
                }
                return;
            }
            this.generatedRecoveryCode = this.accountService.generateRecoveryForPreparedAccount();
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
            this.app?.showToast?.('Account ID copied', 'success');
        } catch (error) {
            console.error('Failed to copy account ID:', error);
            this.app?.showToast?.('Failed to copy, please copy manually', 'error');
        }
    }

    async handleCopyRecoveryCode() {
        if (!this.generatedRecoveryCode) return;
        try {
            await navigator.clipboard.writeText(this.generatedRecoveryCode);
            this.recoveryCodeCopied = true;
            this.render();
            this.app?.showToast?.('Recovery code copied', 'success');
        } catch (error) {
            console.error('Failed to copy recovery code:', error);
            this.app?.showToast?.('Failed to copy, please copy manually', 'error');
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
            this.app?.showToast?.('Both copied', 'success');
        } catch (error) {
            console.error('Failed to copy:', error);
            this.app?.showToast?.('Failed to copy, please copy manually', 'error');
        }
    }

    async handleConfirmRecoverySaved() {
        this.creationStep = 'confirming';
        this.creationError = null;
        this.render();

        try {
            await this.accountService.completeAccountRegistration();
            this.creationStep = 'complete';
            this.app?.showToast?.('Account created successfully', 'success');
            this.completeFirstAccountRouting();
        } catch (error) {
            this.creationStep = 'error';
            this.creationError = error.message || 'Registration failed.';
            this.render();
        }
    }

    async handleCancelCreation() {
        if (this.creationStep.startsWith('oauth_') || this.accountState?.oauthSetupRequired) {
            this.accountService.cancelPendingOAuthAccount();
            await this.accountService.clearLocalAccount();
        }
        this.accountService.cancelPendingAccount();
        this.resetCreationFlow();
        this.render();
    }

    async handleStartOver() {
        if (this.accountState?.oauthSetupRequired) {
            this.accountService.cancelPendingOAuthAccount();
            await this.accountService.clearLocalAccount();
        }
        this.accountService.cancelPendingAccount();
        this.resetCreationFlow();
        this.render();
    }

    // =========================================================================
    // Existing Account Handlers
    // =========================================================================

    getIdentifierMode() {
        const state = this.accountState || {};
        // A landing-page username intent cannot hide a remembered legacy
        // account's unlock/recovery path. Switching still requires Forget.
        if (state.accountId && !state.username &&
            (!state.googleLinked || state.encryptionMode === 'LEGACY_PASSKEY')) return 'accountId';
        return this.identifierMode || 'username';
    }

    async handleAccountContinue() {
        if (this.usernameContinuePending || this.accountState?.busy ||
            this.accountState?.passkeySupported === false) return;
        if (this.getIdentifierMode() === 'accountId') {
            return this.handleAccountPasskeyUnlock();
        }
        const username = this.usernameInputValue || this.accountState?.username || '';
        const viewVersion = this.loginViewVersion;
        this.usernameContinuePending = true;
        this.accountService.clearErrors();
        this.render();
        try {
            const next = await this.accountService.prepareUsernameContinuation(username);
            if (!this.isOpen || viewVersion !== this.loginViewVersion) {
                if (next.kind === 'register') this.accountService.cancelPendingAccount();
                return;
            }
            if (next.kind === 'login') {
                await this.handleAccountPasskeyUnlock(next.challenge);
            } else {
                this.generatedAccountId = this.accountService.getPendingAccountId();
                this.generatedUsername = this.accountService.getPendingUsername();
                this.creationStep = 'passkey';
                this.creationError = null;
                this.isLoadingAccountId = false;
                this.render();
                await this.handlePasskeyRegistration();
            }
        } catch (error) {
            if (this.isOpen && viewVersion === this.loginViewVersion) {
                this.accountService.setError(error.message || 'Unable to continue. Please try again.');
            }
        } finally {
            this.usernameContinuePending = false;
            if (this.isOpen) this.render();
        }
    }

    async handleAccountPasskeyUnlock(preparedChallenge = null) {
        const usesAccountId = this.getIdentifierMode() === 'accountId';
        this.authenticationExitPending = true;
        try {
            const success = usesAccountId
                ? await this.accountService.unlockWithPasskey(
                    this.accountState?.accountId || this.accountInputValue?.trim()
                )
                : await this.accountService.unlockWithUsername(
                    this.usernameInputValue || this.accountState?.username,
                    { action: 'username_login', ...(preparedChallenge ? { preparedChallenge } : {}) }
                );
            if (success) {
                this.close({ afterAuthentication: true });
                this.app?.showToast?.('Account unlocked', 'success');
            } else if (usesAccountId && this.accountService.getState().recoveryRequired) {
                this.showRecoveryInput = true;
                this.render();
            }
        } finally {
            this.authenticationExitPending = false;
        }
    }

    async handleAccountRecoveryUnlock() {
        const usesAccountId = this.getIdentifierMode() === 'accountId';
        const recoveryCode = this.recoveryInputValue;

        // Clear any previous errors before starting
        this.accountService.clearErrors();

        // Show "adding passkey" state before prompting
        this.recoveryStep = 'adding_passkey';
        this.render();

        // Brief delay for user to see the message before passkey prompt
        await new Promise(resolve => setTimeout(resolve, 0));

        this.authenticationExitPending = true;
        try {
            // Step 3: Call recovery (this triggers the passkey prompt)
            if (!usesAccountId) {
                throw new Error('Username accounts do not support recovery codes');
            }
            const success = await this.accountService.unlockWithRecoveryCode(
                this.accountState?.accountId || this.accountInputValue?.trim(),
                recoveryCode
            );

            if (success) {
                this.recoveryStep = 'idle';
                this.showRecoveryInput = false;
                this.recoveryInputValue = '';
                this.close({ afterAuthentication: true });
                this.app?.showToast?.('Account recovered successfully', 'success');
            } else {
                this.recoveryStep = 'idle';
                this.render();
            }
        } catch (error) {
            this.recoveryStep = 'idle';
            this.render();
        } finally {
            this.authenticationExitPending = false;
        }
    }

    async handleOAuthRecoveryUnlock() {
        const providerLabel = this.getOAuthProviderLabel(
            this.accountState?.oauthProvider
        );
        this.authenticationExitPending = true;
        try {
            const success = await this.accountService.unlockOAuthWithRecoveryCode(
                this.recoveryInputValue
            );
            if (success) {
                this.recoveryInputValue = '';
                this.close({ afterAuthentication: true });
                this.app?.showToast?.(`Signed in with ${providerLabel}`, 'success');
            }
        } finally {
            this.authenticationExitPending = false;
        }
    }

    async handleOAuthKeyringUnlock() {
        const state = this.accountService.getState();
        const isFirstAccountSetup = state.oauthSetupRequired === true;
        this.authenticationExitPending = true;
        try {
            const success = state.oauthLegacyPasskeyRequired
                ? await this.accountService.unlockWithPasskey(
                    state.accountId,
                    { action: 'oauth_legacy_passkey' }
                )
                : state.oauthSetupRequired
                    ? await this.accountService.setupOAuthKeyring()
                    : await this.accountService.unlockOAuthKeyring();
            if (success) {
                this.app?.showToast?.('Encrypted data unlocked', 'success');
                if (isFirstAccountSetup) this.completeFirstAccountRouting();
                else this.close({ afterAuthentication: true });
            }
        } finally {
            this.authenticationExitPending = false;
        }
    }

    async handleAccountCopyId() {
        if (!this.accountState?.accountId) return;
        try {
            await navigator.clipboard.writeText(this.accountState.accountId);
            this.app?.showToast?.('Account ID copied', 'success');
        } catch (error) {
            console.error('Failed to copy account ID:', error);
        }
    }

    handleAccountToggleRecovery() {
        this.showRecoveryInput = !this.showRecoveryInput;
        this.render();
    }

    async handleAccountClear() {
        this.closeAccountMenu();
        await this.accountService.clearLocalAccount();
        this.accountInputValue = '';
        this.usernameInputValue = '';
        this.identifierMode = null;
        this.recoveryInputValue = '';
        this.showRecoveryInput = false;
        this.resetCreationFlow();
        this.render();
        this.app?.showToast?.('Logged out', 'success');
    }

    togglePasskeyDetails() {
        this.passkeyDetailsOpen = !this.passkeyDetailsOpen;
        this.render();
    }

    async handleForgetSavedAccount() {
        await this.accountService.clearLocalAccount();
        this.accountInputValue = '';
        this.usernameInputValue = '';
        this.identifierMode = null;
        this.recoveryInputValue = '';
        this.showRecoveryInput = false;
        this.resetCreationFlow();
        this.render();
        this.app?.showToast?.('Saved account removed from this device', 'success');
    }

    // =========================================================================
    // Render
    // =========================================================================

    render() {
        if (!this.overlay) return;

        const activeElement = document.activeElement;
        const hadModalFocus = this.isOpen && this.overlay.contains(activeElement);
        const activeElementId = hadModalFocus ? activeElement?.id || '' : '';

        const state = this.accountState || {};
        const accountId = state.accountId;

        const oauthCreationInProgress = this.creationStep.startsWith('oauth_');
        // Registration owns this surface until it closes into Membership.
        // Sync may publish the new account ID before registration returns.
        const isCreationFlow = this.creationStep !== 'idle' &&
            (oauthCreationInProgress || Boolean(this.generatedUsername) || !accountId);
        if (isCreationFlow) {
            this.overlay.innerHTML = this.renderCreationFlow();
        } else if (this.usernameHandoffPending) {
            this.overlay.innerHTML = `
                <div role="dialog" aria-modal="true" aria-labelledby="account-modal-title" tabindex="-1" class="${MODAL_CLASSES}">
                    ${this.renderHeader('Log in')}
                    <div class="flex items-center justify-center gap-3 py-6" role="status">
                        <span class="h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-foreground" aria-hidden="true"></span>
                        <p class="text-sm text-muted-foreground">Opening passkey…</p>
                    </div>
                </div>
            `;
        } else {
            this.overlay.innerHTML = this.renderAccountUI();
        }

        const dialog = this.overlay.querySelector('[role="dialog"]');
        if (
            dialog &&
            !isCreationFlow &&
            !this.usernameHandoffPending &&
            this.recoveryStep === 'idle' &&
            state.authBootstrapComplete !== false
        ) {
            const commercialSlot = document.createElement('div');
            commercialSlot.dataset.oaExtensionSlot = SLOT_NAMES.ACCOUNT_COMMERCIAL;
            commercialSlot.hidden = true;
            const actionRow = dialog.querySelector('[data-account-actions]');
            const actionParent = actionRow?.parentNode;
            if (actionParent?.insertBefore) actionParent.insertBefore(commercialSlot, actionRow);
            else dialog.appendChild(commercialSlot);
            this.app.refreshExtensionSlot?.(SLOT_NAMES.ACCOUNT_COMMERCIAL);
        }

        this.attachEventListeners();
        if (hadModalFocus) this.focusModal(activeElementId);
    }

    renderHeader(title, showClose = true, className = '') {
        return `
            <div class="flex items-center justify-between mb-4 ${className}">
                <h3 id="account-modal-title" class="text-base font-medium text-foreground">${title}</h3>
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
        const providerLabel = this.getOAuthProviderLabel();
        const title = this.generatedUsername && step !== 'error'
            ? 'Log in'
            : step === 'complete' ? 'Account Created'
                : step === 'error' ? 'Error'
                    : step.startsWith('oauth_') ? `Continue with ${providerLabel}`
                        : 'Create a passkey account';

        return `
            <div role="dialog" aria-modal="true" aria-labelledby="account-modal-title" tabindex="-1" class="${MODAL_CLASSES}">
                ${this.renderHeader(title)}
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
        const providerLabel = this.getOAuthProviderLabel();
        if (this.generatedUsername && ['passkey', 'passkey_retry', 'confirming', 'complete'].includes(step)) {
            const retry = step === 'passkey_retry';
            return `
                <div class="w-full text-center py-6" role="${retry ? 'alert' : 'status'}">
                    ${retry ? '' : '<div class="w-10 h-10 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" aria-hidden="true"></div>'}
                    <p class="text-sm ${retry ? 'text-destructive' : 'text-muted-foreground'}">${retry
                        ? this.escapeHtml(this.creationError || 'Passkey cancelled. Try again.')
                        : 'Setting up your account…'}</p>
                </div>
            `;
        }
        switch (step) {
            case 'oauth_authorizing':
                {
                    const handoffLocation = window.electronAPI?.isElectron === true
                        ? 'your browser'
                        : 'the popup window';
                return `
                    <div class="w-full text-center py-6">
                        <div class="w-10 h-10 border-2 border-foreground border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
                        <p class="text-sm font-medium text-foreground mb-1">Waiting for ${providerLabel}...</p>
                        <p class="text-xs text-muted-foreground">Complete sign in in ${handoffLocation}.</p>
                    </div>
                `;
                }

            case 'passkey':
            case 'passkey_retry': {
                const isWaiting = this.isLoadingAccountId || this.revealedDigits < 16;
                const accountIdDisplay = (() => {
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
                        <div class="account-number-text tracking-widest whitespace-nowrap font-mono text-xl text-foreground mb-4 ${isWaiting ? 'animate-pulse' : ''}">
                            ${accountIdDisplay}
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
                            ${this.escapeHtml(this.formatAccountId(this.generatedAccountId))}
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
                        <p class="text-[11px] leading-relaxed text-muted-foreground mt-3 text-center">Keep the recovery code private. It can replace a lost passkey.</p>
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
                        <p class="font-mono text-sm text-muted-foreground">${this.escapeHtml(this.generatedUsername || '')}</p>
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
            case 'oauth_authorizing':
                {
                    const handoffLocation = window.electronAPI?.isElectron === true
                        ? 'your browser'
                        : 'the popup';
                return `
                    <button class="w-full h-9 rounded-lg text-sm bg-muted text-muted-foreground cursor-not-allowed" type="button" disabled>
                        Complete sign in in ${handoffLocation}
                    </button>
                `;
                }

            case 'passkey':
                return `
                    <button id="cancel-creation-btn" class="btn-ghost-hover w-full h-9 rounded-lg text-sm border border-border bg-background text-foreground transition-colors" type="button">
                        Cancel
                    </button>
                `;

            case 'passkey_retry':
                return `
                    <div class="flex gap-3">
                        <button id="cancel-creation-btn" class="btn-ghost-hover flex-1 h-9 rounded-lg text-sm border border-border bg-background text-foreground transition-colors" type="button">
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
                    <button id="close-complete-btn" class="btn-ghost-hover w-full h-9 rounded-lg text-sm border border-border bg-background text-foreground transition-colors" type="button">
                        Done
                    </button>
                `;

            case 'error':
                return `
                    <button id="start-over-btn" class="btn-ghost-hover w-full h-9 rounded-lg text-sm border border-border bg-background text-foreground transition-colors" type="button">
                        Start Over
                    </button>
                `;

            default:
                return '';
        }
    }

    renderOAuthProviderIcon(provider, className = 'w-4 h-4') {
        return `
            <svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.19-2.07H12v3.91h5.38a4.6 4.6 0 01-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4z"></path>
                <path fill="#34A853" d="M12 22c2.7 0 4.98-.9 6.63-2.37l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0012 22z"></path>
                <path fill="#FBBC05" d="M6.39 13.92A6.02 6.02 0 016.08 12c0-.67.11-1.32.31-1.92V7.46H3.04A10 10 0 002 12c0 1.61.39 3.14 1.04 4.54l3.35-2.62z"></path>
                <path fill="#EA4335" d="M12 5.95c1.47 0 2.79.51 3.83 1.5l2.87-2.88A9.63 9.63 0 0012 2a10 10 0 00-8.96 5.46l3.35 2.62C7.18 7.71 9.39 5.95 12 5.95z"></path>
            </svg>
        `;
    }

    renderOAuthConnection(provider, state, isBusy, action) {
        const providerLabel = this.getOAuthProviderLabel(provider);
        if (state[`${provider}Linked`]) {
            return `
                <div class="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                    ${this.renderOAuthProviderIcon(provider, 'w-3.5 h-3.5')}
                    ${providerLabel} connected
                </div>
            `;
        }
        return `
            <button id="account-connect-${provider}-btn" class="btn-ghost-hover w-full h-9 rounded-lg text-sm border border-border bg-background text-foreground transition-colors flex items-center justify-center gap-2" type="button" ${isBusy ? 'disabled' : ''}>
                ${this.renderOAuthProviderIcon(provider)}
                ${action === `${provider}_link` ? `Connecting ${providerLabel}...` : `Connect ${providerLabel}`}
            </button>
        `;
    }

    renderAccountUI() {
        const state = this.accountState || {};
        const accountId = state.accountId;
        const formattedAccountId = accountId ? this.formatAccountId(accountId) : '';
        const passkeySupported = state.passkeySupported;
        const isBusy = state.busy || this.usernameContinuePending;
        const action = state.action;
        const hasSignedOutSavedAccount = Boolean(
            !state.sessionVerified &&
            (
                state.hasSavedAccountBinding ||
                accountId ||
                String(state.error || '').includes(
                    'does not match the OA account saved on this device'
                )
            )
        );
        const usesIdentityLogin =
            state.googleLinked &&
            state.encryptionMode !== 'LEGACY_PASSKEY';
        const usesNamedLogin = usesIdentityLogin || Boolean(state.username);

        if (state.authBootstrapComplete === false) {
            const accountEmail = state.oauthEmail || state.email;
            const email = typeof accountEmail === 'string'
                ? accountEmail.trim()
                : '';
            return `
                <div role="dialog" aria-modal="true" aria-labelledby="account-modal-title" aria-describedby="account-restoring-description" aria-busy="true" tabindex="-1" class="${MODAL_CLASSES}">
                    ${this.renderHeader('Account')}
                    <div class="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/15 p-3">
                        <span class="account-restoring-spinner h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-muted border-t-foreground" aria-hidden="true"></span>
                        <div class="min-w-0">
                            <p class="text-sm font-medium text-foreground">Restoring your account…</p>
                            <p id="account-restoring-description" class="mt-1 truncate text-xs text-muted-foreground"${email ? ` title="${this.escapeHtml(email)}"` : ''}>
                                ${email ? this.escapeHtml(email) : 'Checking your saved sign-in.'}
                            </p>
                        </div>
                    </div>
                </div>
            `;
        }

        // Recovery flow UI (verifying/adding passkey)
        if (this.recoveryStep === 'verifying' || this.recoveryStep === 'adding_passkey') {
            return this.renderRecoveryFlowUI();
        }

        // Recovery complete UI
        if (this.recoveryStep === 'complete') {
            return this.renderRecoveryCompleteUI();
        }

        if (
            state.oauthRecoveryRequired ||
            state.oauthKeyringRequired ||
            state.oauthSetupRequired ||
            state.oauthLegacyPasskeyRequired
        ) {
            return this.renderOAuthUnlockUI();
        }

        // Logged in state - don't show errors here since login was successful
        if (
            accountId &&
            state.sessionVerified &&
            (
                state.status === 'unlocked' ||
                action === 'google_link'
            )
        ) {
            // Always get fresh status
            const syncStatus = this.syncService.getStatus();
            const isSyncing = syncStatus.syncing;
            const lastSync = syncStatus.lastSyncTime;
            const lastResult = syncStatus.lastSyncResult;

            // Determine sync freshness for indicator color
            const syncAgeMs = lastSync ? Date.now() - lastSync : Infinity;
            const isStale = syncAgeMs > 5 * 60 * 1000;  // > 5 minutes = stale

            const syncIndicatorColor = (() => {
                if (isSyncing) return 'is-syncing';
                if (!lastSync) return 'is-neutral';
                if (lastResult?.success === false) return 'is-attention';
                if (isStale) return 'is-attention';
                return 'is-success';
            })();

            const syncStatusText = (() => {
                if (isSyncing) return 'Syncing...';
                if (lastSync) {
                    const ago = this.formatTimeAgo(lastSync);
                    if (lastResult?.success === false) return `Sync failed ${ago}`;
                    return `Synced ${ago}`;
                }
                return 'Not synced yet';
            })();

            const syncStatusColor = (() => {
                if (isSyncing) return 'is-syncing';
                if (!lastSync) return 'is-neutral';
                if (lastResult?.success === false) return 'is-attention';
                if (isStale) return 'is-attention';
                return 'is-success';
            })();
            const accountIdentity = state.username || state.oauthEmail || state.email || formattedAccountId;
            const accountInitial = String(accountIdentity || 'A').trim().charAt(0).toUpperCase() || 'A';
            const syncActionText = isSyncing
                ? 'Syncing…'
                : lastResult?.success === false
                    ? 'Retry sync'
                    : 'Sync now';
            return `
                <div role="dialog" aria-modal="true" aria-labelledby="account-modal-title" tabindex="-1" class="${MODAL_CLASSES} account-compact-dialog">
                    ${this.renderHeader('Account', true, 'account-compact-header')}
                    <section class="account-compact-identity" aria-labelledby="account-identity-heading">
                        <span class="account-compact-avatar" aria-hidden="true">${this.escapeHtml(accountInitial)}</span>
                        <div class="account-compact-identity-copy">
                            <p id="account-identity-heading" title="${this.escapeHtml(accountIdentity)}">${this.escapeHtml(accountIdentity)}</p>
                            <span><span class="account-compact-dot is-success"></span>Logged in</span>
                        </div>
                    </section>
                    <div class="account-compact-divider" aria-hidden="true"></div>
                    <div class="account-compact-list">
                        <button id="account-sync-btn" class="account-compact-row" type="button" ${isSyncing || isBusy ? 'disabled' : ''}>
                            <span class="account-compact-row-label">
                                <svg class="${isSyncing ? 'animate-spin' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"></path>
                                </svg>
                                ${syncActionText}
                            </span>
                            <span class="account-compact-meta ${syncStatusColor}">
                                <span class="account-compact-dot ${syncIndicatorColor} ${isSyncing ? 'animate-pulse' : ''}"></span>${syncStatusText}
                            </span>
                        </button>
                        <button id="account-passkey-details-btn" class="account-compact-row" type="button" aria-expanded="${this.passkeyDetailsOpen}" aria-controls="account-passkey-details">
                            <span class="account-compact-row-label">Passkey &amp; encryption</span>
                            <svg class="account-compact-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg>
                        </button>
                        <div id="account-passkey-details" class="account-compact-detail" ${this.passkeyDetailsOpen ? '' : 'hidden'}>
                            <p class="account-compact-detail-status"><span class="account-compact-dot is-success"></span>${usesNamedLogin ? 'End-to-end encrypted' : 'Passkey unlocked'}</p>
                            <p>Tickets and preferences sync encrypted with your passkey.</p>
                            ${state.googleLinked ? `<p class="account-compact-provider">${this.renderOAuthProviderIcon('google', 'w-3.5 h-3.5')} Google connected</p>` : ''}
                            ${!usesNamedLogin ? `<button id="account-copy-id-btn" class="account-compact-copy-id account-number-text" type="button" title="Copy account ID">Copy account ID · ${this.escapeHtml(formattedAccountId)}</button>` : ''}
                        </div>
                        <div data-account-actions>
                            <button id="account-clear-btn" class="account-compact-row" type="button" ${isBusy ? 'disabled' : ''}>Log out</button>
                        </div>
                    </div>
                </div>
            `;
        }

        const identifierMode = this.getIdentifierMode();
        const usesAccountId = identifierMode === 'accountId';
        const usernameValue = this.escapeHtml(this.usernameInputValue || state.username || '');
        const accountIdValue = this.escapeHtml(
            this.accountInputValue || formattedAccountId
        );
        const recoveryVisible = this.showRecoveryInput;
        return `
            <div role="dialog" aria-modal="true" aria-labelledby="account-modal-title" tabindex="-1" class="${MODAL_CLASSES}${usesAccountId ? '' : ' account-login-dialog'}"${usesAccountId ? ' style="padding:24px 24px 18px"' : ''}>
                <div class="${usesAccountId ? 'flex items-center justify-between mb-4' : 'account-login-heading'}">
                    <h3 id="account-modal-title" class="text-base font-medium text-foreground">Log in</h3>
                    <button id="close-account-modal" class="text-muted-foreground hover:text-foreground transition-colors p-1 -mr-1 rounded-lg hover:bg-accent" aria-label="Close">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>

                ${!passkeySupported ? `
                    <div class="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive mb-4">
                        Passkeys are not supported in this browser.
                    </div>
                ` : ''}

                <button id="account-google-btn" class="w-full h-10 rounded-lg text-sm font-medium border border-border bg-background text-foreground hover:bg-accent transition-colors disabled:opacity-50 flex items-center justify-center gap-2" type="button" ${isBusy || !passkeySupported ? 'disabled' : ''}>
                    ${this.renderOAuthProviderIcon('google')}
                    Continue with Google
                </button>

                ${usesAccountId ? `<div class="flex items-center gap-3 my-4" aria-hidden="true">
                    <span class="h-px flex-1 bg-border"></span>
                    <span class="text-[11px] uppercase tracking-wider text-muted-foreground">or</span>
                    <span class="h-px flex-1 bg-border"></span>
                </div>` : '<div class="account-login-divider" aria-hidden="true">or</div>'}

                <div class="${usesAccountId ? 'account-input-wrap flex items-center w-full h-10 rounded-lg border border-border bg-muted/25' : 'account-login-control'}">
                    ${usesAccountId ? `
                        <input
                            id="account-id-input"
                            aria-label="Account number"
                            type="text"
                            inputmode="numeric"
                            autocomplete="off"
                            maxlength="19"
                            placeholder="1234 5678 9012 3456"
                            class="account-number-text flex-1 h-full px-3 text-sm bg-transparent text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                            value="${accountIdValue}"
                            ${isBusy ? 'disabled' : ''}
                        />
                    ` : `
                        <input
                            id="account-username-input"
                            aria-label="Username"
                            type="text"
                            autocomplete="username webauthn"
                            autocapitalize="none"
                            spellcheck="false"
                            maxlength="32"
                            placeholder="Username"
                            class="account-login-input"
                            value="${usernameValue}"
                            ${isBusy ? 'disabled' : ''}
                        />
                        <button id="account-passkey-btn" class="account-login-submit" type="button" aria-label="${isBusy ? 'Continuing' : 'Continue'}" title="Continue" aria-busy="${Boolean(isBusy)}" ${isBusy || !passkeySupported ? 'disabled' : ''}>
                            ${isBusy ? '<span class="account-login-spinner" aria-hidden="true"></span>' : `
                                <svg class="account-login-arrow" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M5 12h14m-6-6 6 6-6 6"></path>
                                </svg>
                            `}
                        </button>
                    `}
                </div>
                ${usesAccountId ? `<button id="account-passkey-btn" class="mt-3 w-full h-10 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50" type="button" ${isBusy || !passkeySupported ? 'disabled' : ''}>
                    ${isBusy ? 'Continuing…' : 'Continue'}
                </button>` : ''}

                ${usesAccountId ? `
                    <button id="account-recovery-toggle-btn" class="mt-2 w-full text-xs text-muted-foreground hover:text-foreground" type="button" ${isBusy ? 'disabled' : ''}>
                        ${recoveryVisible ? 'Hide recovery' : 'Lost your passkey?'}
                    </button>

                    ${recoveryVisible ? `
                        <div class="mt-3 border-t border-border pt-3">
                            <label for="account-recovery-code-input" class="block text-xs font-medium text-foreground mb-1.5">Five-word recovery code</label>
                            <input
                                id="account-recovery-code-input"
                                type="text"
                                autocomplete="off"
                                placeholder="word word word word word"
                                class="w-full h-10 rounded-lg border border-border bg-muted/25 px-3 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                                value="${this.escapeHtml(this.recoveryInputValue || '')}"
                                ${isBusy ? 'disabled' : ''}
                            />
                            <button id="account-recovery-submit-btn" class="mt-2 w-full h-9 rounded-lg text-sm font-medium border border-border bg-background text-foreground hover:bg-accent transition-colors disabled:opacity-50" type="button" ${isBusy || !passkeySupported ? 'disabled' : ''}>
                                Replace passkey
                            </button>
                        </div>
                    ` : ''}
                ` : ''}

                ${state.error ? `<p class="text-xs text-destructive mt-3 text-center" role="alert">${this.escapeHtml(state.error)}</p>` : ''}

                ${hasSignedOutSavedAccount ? `
                    <div class="mt-4 pt-4 border-t border-border text-center">
                        <p class="text-xs text-muted-foreground mb-2">
                            This device remembers a signed-out OA account. Sign in to that account, or forget it before switching accounts.
                        </p>
                        <button id="account-forget-saved-btn" class="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors disabled:opacity-50" type="button" ${isBusy ? 'disabled' : ''}>
                            Forget saved account
                        </button>
                    </div>
                ` : ''}
            </div>
        `;
    }

    renderOAuthUnlockUI() {
        const state = this.accountState || {};
        const recoveryValue = this.escapeHtml(this.recoveryInputValue || '');
        const isLegacyMigration = state.oauthRecoveryRequired;
        const isSetup = state.oauthSetupRequired;
        const isLegacyPasskey = state.oauthLegacyPasskeyRequired;
        const busy = Boolean(state.busy);
        const error = state.error ? String(state.error) : '';

        // Setup and legacy paths share the Welcome back card's shell.
        const title = isLegacyMigration
            ? 'Upgrade encrypted data'
            : isSetup
                ? 'Encrypt your data'
                : 'Welcome back';
        const body = busy
            ? isLegacyMigration
                ? 'Confirm with your passkey to finish the upgrade.'
                : isSetup
                    ? 'Confirm with your passkey to finish.'
                    : 'Confirm with your passkey to continue.'
            : isLegacyMigration
                ? 'Enter the recovery code from the previous account system once. It will be replaced with an encryption passkey.'
                : isLegacyPasskey
                    ? 'This account predates encryption-only passkeys. Use its existing passkey to unlock it.'
                    : isSetup
                        ? 'Create a passkey. It encrypts your tickets and preferences so only you can access them.'
                        : 'The Open Anonymity Project encrypts your tickets and preferences so only you can access them.';
        const idleCta = isLegacyMigration
            ? 'Upgrade with passkey'
            : isSetup
                ? 'Create passkey'
                : isLegacyPasskey
                    ? 'Use legacy passkey'
                    : 'Unlock';
        const cta = busy ? 'Waiting…' : error ? 'Try again' : idleCta;
        const alertText = /cancel/i.test(error) ? "Passkey wasn't confirmed." : error;

        return `
            <div role="dialog" aria-modal="true" aria-labelledby="account-modal-title" tabindex="-1" class="account-unlock-card">
                <button id="close-account-modal" class="account-unlock-close" type="button" aria-label="Close">
                    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true">
                        <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
                <div class="account-unlock-copy">
                    <h2 id="account-modal-title" class="account-unlock-title">${title}</h2>
                    <p class="account-unlock-body">${body}</p>
                    ${isLegacyPasskey ? `
                        <p class="account-unlock-account-id account-number-text">${this.escapeHtml(this.formatAccountId(state.accountId))}</p>
                    ` : ''}
                </div>
                <div class="account-unlock-actions">
                    ${isLegacyMigration ? `
                        <input
                            id="oauth-recovery-code-input"
                            type="text"
                            class="account-unlock-input"
                            placeholder="Legacy 5-word recovery code"
                            autocomplete="off"
                            value="${recoveryValue}"
                            ${busy ? 'disabled' : ''}
                        />
                        <button id="oauth-recovery-submit-btn" class="account-unlock-btn" type="button" ${busy ? 'disabled' : ''} aria-busy="${busy}">
                            ${busy ? '<span class="account-unlock-spinner" aria-hidden="true"></span>' : ''}<span>${cta}</span>
                        </button>
                    ` : `
                        <button id="oauth-keyring-submit-btn" class="account-unlock-btn" type="button" ${busy ? 'disabled' : ''} aria-busy="${busy}">
                            ${busy ? '<span class="account-unlock-spinner" aria-hidden="true"></span>' : ''}<span>${cta}</span>
                        </button>
                    `}
                    ${error && !busy ? `<p role="alert" class="account-unlock-alert">${this.escapeHtml(alertText)}</p>` : ''}
                    <button id="account-clear-btn" class="account-unlock-signout" type="button" ${busy ? 'disabled' : ''}>Log out</button>
                </div>
            </div>
        `;
    }

    renderRecoveryFlowUI() {
        const state = this.accountState || {};
        const isVerifying = this.recoveryStep === 'verifying';
        const isAddingPasskey = this.recoveryStep === 'adding_passkey';

        if (isVerifying) {
            return `
                <div role="dialog" aria-modal="true" aria-labelledby="account-modal-title" tabindex="-1" class="${MODAL_CLASSES}">
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
            <div role="dialog" aria-modal="true" aria-labelledby="account-modal-title" tabindex="-1" class="${MODAL_CLASSES}">
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
            <div role="dialog" aria-modal="true" aria-labelledby="account-modal-title" tabindex="-1" class="${MODAL_CLASSES}">
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

        const googleBtn = document.getElementById('account-google-btn');
        if (googleBtn) {
            googleBtn.onclick = () => this.handleOAuthAuthentication('google');
        }

        const forgetSavedBtn = document.getElementById('account-forget-saved-btn');
        if (forgetSavedBtn) {
            forgetSavedBtn.onclick = () => this.handleForgetSavedAccount();
        }

        const connectGoogleBtn = document.getElementById('account-connect-google-btn');
        if (connectGoogleBtn) {
            connectGoogleBtn.onclick = () => this.handleConnectOAuth('google');
        }

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
            accountInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); this.handleAccountContinue(); } };
        }

        const usernameInput = document.getElementById('account-username-input');
        if (usernameInput) {
            usernameInput.oninput = (event) => {
                this.usernameInputValue = event.target.value;
            };
            usernameInput.onkeydown = (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    this.handleAccountContinue();
                }
            };
        }

        const recoveryInput = document.getElementById('account-recovery-code-input');
        if (recoveryInput) {
            recoveryInput.oninput = (e) => { this.recoveryInputValue = e.target.value; };
            recoveryInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); this.handleAccountRecoveryUnlock(); } };
        }

        const passkeyBtn = document.getElementById('account-passkey-btn');
        if (passkeyBtn) passkeyBtn.onclick = () => this.handleAccountContinue();

        const recoveryToggleBtn = document.getElementById('account-recovery-toggle-btn');
        if (recoveryToggleBtn) recoveryToggleBtn.onclick = () => this.handleAccountToggleRecovery();

        const recoverySubmitBtn = document.getElementById('account-recovery-submit-btn');
        if (recoverySubmitBtn) recoverySubmitBtn.onclick = () => this.handleAccountRecoveryUnlock();

        const oauthRecoveryInput = document.getElementById('oauth-recovery-code-input');
        if (oauthRecoveryInput) {
            oauthRecoveryInput.oninput = (e) => { this.recoveryInputValue = e.target.value; };
            oauthRecoveryInput.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.handleOAuthRecoveryUnlock();
                }
            };
        }

        const oauthRecoverySubmitBtn = document.getElementById('oauth-recovery-submit-btn');
        if (oauthRecoverySubmitBtn) {
            oauthRecoverySubmitBtn.onclick = () => this.handleOAuthRecoveryUnlock();
        }

        const oauthKeyringSubmitBtn = document.getElementById('oauth-keyring-submit-btn');
        if (oauthKeyringSubmitBtn) {
            oauthKeyringSubmitBtn.onclick = () => this.handleOAuthKeyringUnlock();
        }

        const copyIdBtn = document.getElementById('account-copy-id-btn');
        if (copyIdBtn) copyIdBtn.onclick = () => this.handleAccountCopyId();

        const clearBtn = document.getElementById('account-clear-btn');
        if (clearBtn) clearBtn.onclick = () => this.handleAccountClear();

        const passkeyDetailsBtn = document.getElementById('account-passkey-details-btn');
        if (passkeyDetailsBtn) passkeyDetailsBtn.onclick = () => this.togglePasskeyDetails();

        const syncBtn = document.getElementById('account-sync-btn');
        if (syncBtn) syncBtn.onclick = () => this.handleSyncNow();

    }

    async handleSyncNow() {
        // this.syncService.sync() will set syncInProgress and notify immediately
        try {
            const result = await this.syncService.sync();
            if (result.success) {
                this.app?.showToast?.('Synced successfully', 'success');
            } else if (result.error !== 'Sync already in progress') {
                this.app?.showToast?.(result.error || 'Sync failed', 'error');
            }
        } catch (error) {
            this.app?.showToast?.('Sync failed', 'error');
        }
    }

    destroy() {
        this.clearAnimationTimeouts();
        this.closeAccountMenu();
        document.removeEventListener?.('pointerdown', this.onDocumentPointerDown);
        if (this.accountUnsubscribe) {
            this.accountUnsubscribe();
            this.accountUnsubscribe = null;
        }
        if (this.syncUnsubscribe) {
            this.syncUnsubscribe();
            this.syncUnsubscribe = null;
        }
    }
}

export default AccountModal;
