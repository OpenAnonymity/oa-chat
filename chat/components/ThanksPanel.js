/**
 * Thanks Panel Component
 * Returning-user panel for users who previously held tickets.
 */

import ticketClient from '../services/ticketClient.js';
import themeManager from '../services/themeManager.js';

const STORAGE_KEY_DISMISSED = 'oa-welcome-dismissed';
const MODAL_CLASSES = 'w-full max-w-md rounded-2xl border border-border shadow-lg mx-4 flex flex-col welcome-modal-enter welcome-modal-glass';
const SHARE_FEEDBACK_URL = 'https://forms.gle/HEmvxnJpN1jQC7CfA';

class ThanksPanel {
    constructor(app) {
        this.app = app;
        this.isOpen = false;
        this.overlay = document.getElementById('welcome-panel');

        this.step = 'thanks'; // 'thanks' | 'redeeming' | 'success'
        this.inviteCode = '';
        this.isRedeeming = false;
        this.redeemProgress = null;
        this.redeemError = null;
        this.ticketsRedeemed = 0;

        this.returnFocusEl = null;
        this.escapeHandler = null;
        this.themeUnsubscribe = null;
        this.ticketsUpdatedHandler = null;
    }

    async init() {
        if (!this.overlay) return;
        this.ensureTicketsUpdatedListener();
        if (!this.shouldShow()) return;
        this.open();
    }

    shouldShow() {
        if (localStorage.getItem(STORAGE_KEY_DISMISSED) === 'true') return false;
        if (ticketClient.getTicketCount() > 0) return false;
        return true;
    }

    open() {
        if (this.isOpen || !this.overlay) return;
        this.isOpen = true;
        this.returnFocusEl = document.activeElement;

        this.step = 'thanks';
        this.inviteCode = '';
        this.isRedeeming = false;
        this.redeemProgress = null;
        this.redeemError = null;
        this.ticketsRedeemed = 0;

        this.render();
        this.overlay.classList.remove('hidden');
        document.documentElement.removeAttribute('data-welcome-hidden');

        this.overlay.onclick = (e) => {
            if (e.target === this.overlay) this.handleCloseAttempt();
        };
        this.escapeHandler = (e) => {
            if (e.key === 'Escape') this.handleCloseAttempt();
        };
        document.addEventListener('keydown', this.escapeHandler);
    }

    handleCloseAttempt() {
        if (this.isRedeeming) return;
        this.close();
    }

    close() {
        if (!this.isOpen || !this.overlay) return;
        this.isOpen = false;

        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
        document.documentElement.setAttribute('data-welcome-hidden', 'true');

        this.themeUnsubscribe?.();
        this.themeUnsubscribe = null;

        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }

        if (this.returnFocusEl?.focus) this.returnFocusEl.focus();
        this.returnFocusEl = null;
    }

    ensureTicketsUpdatedListener() {
        if (this.ticketsUpdatedHandler) return;

        this.ticketsUpdatedHandler = () => {
            if (this.isOpen && this.step === 'thanks') {
                this.render();
            }
        };

        window.addEventListener('tickets-updated', this.ticketsUpdatedHandler);
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    async handleInviteSubmit(e) {
        if (e) e.preventDefault();

        const inputValue = this.inviteCode.trim();
        if (!inputValue) {
            this.redeemError = 'Please enter an invite code';
            this.render();
            return;
        }

        const inviteCode = inputValue.replace(/[\s-]+/g, '');
        if (inviteCode.length !== 24) {
            this.redeemError = 'Please enter a valid 24-character invite code';
            this.render();
            return;
        }

        this.step = 'redeeming';
        this.isRedeeming = true;
        this.redeemError = null;
        this.redeemProgress = { message: 'Starting...', percent: 0 };
        this.render();

        try {
            const result = await ticketClient.alphaRegister(inviteCode, (message, percent) => {
                this.redeemProgress = { message, percent };
                this.render();
            });

            this.ticketsRedeemed = result.tickets_issued;
            this.step = 'success';
            this.isRedeeming = false;
            this.render();

            window.dispatchEvent(new CustomEvent('tickets-updated'));
        } catch (error) {
            console.error('Thanks panel invite error:', error);
            this.step = 'thanks';
            this.isRedeeming = false;
            this.redeemError = error.message || 'Failed to redeem invite code';
            this.render();
        }
    }

    handleCreateAccount() {
        this.close();
        setTimeout(() => this.app.accountModal?.open(), 150);
    }

    handleStartChatting() {
        this.close();
        setTimeout(() => this.app.elements.messageInput?.focus(), 150);
    }

    render() {
        if (!this.overlay) return;

        switch (this.step) {
            case 'thanks':
                this.overlay.innerHTML = this.renderThanksStep();
                break;
            case 'redeeming':
                this.overlay.innerHTML = this.renderRedeemingStep();
                break;
            case 'success':
                this.overlay.innerHTML = this.renderSuccessStep();
                break;
        }

        this.attachEventListeners();
    }

    renderThanksStep() {
        const hasError = !!this.redeemError;

        return `
            <div id="welcome-theme-toggle" class="theme-toggle-container" role="radiogroup" aria-label="Theme selection" data-theme="${themeManager.getPreference()}" style="position:fixed;top:12px;right:12px;z-index:9999">
                <div class="theme-toggle-indicator"></div>
                <button type="button" class="theme-toggle-btn" data-theme-option="light" aria-checked="${themeManager.getPreference() === 'light'}" title="Light">
                    <svg class="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1.5m0 15V21m9-9h-1.5M4.5 12H3m15.364-6.364-1.06 1.06M6.697 17.303l-1.06 1.06m0-12.728 1.06 1.06m9.607 9.607 1.06 1.06M12 8.25a3.75 3.75 0 1 1 0 7.5 3.75 3.75 0 0 1 0-7.5z"></path>
                    </svg>
                </button>
                <button type="button" class="theme-toggle-btn" data-theme-option="dark" aria-checked="${themeManager.getPreference() === 'dark'}" title="Dark">
                    <svg class="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M21 12.79A9 9 0 0 1 11.21 3 7.5 7.5 0 1 0 21 12.79z"></path>
                    </svg>
                </button>
                <button type="button" class="theme-toggle-btn" data-theme-option="system" aria-checked="${themeManager.getPreference() === 'system'}" title="System">
                    <svg class="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M9 17v2h6v-2m2 0h.75A2.25 2.25 0 0 0 20 14.75V7.25A2.25 2.25 0 0 0 17.75 5H6.25A2.25 2.25 0 0 0 4 7.25v7.5A2.25 2.25 0 0 0 6.25 17H7.5"></path>
                    </svg>
                </button>
            </div>

            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}" style="padding:28px 28px 20px">
                <style>
                    @keyframes welcomeModalIn {
                        from { opacity: 0; transform: scale(0.97) translateY(6px); }
                        to { opacity: 1; transform: scale(1) translateY(0); }
                    }
                    .welcome-modal-enter {
                        animation: welcomeModalIn 0.2s ease-out;
                    }
                    .welcome-modal-glass {
                        background: hsl(var(--color-background) / 0.72);
                        backdrop-filter: blur(20px) saturate(1.2);
                        -webkit-backdrop-filter: blur(20px) saturate(1.2);
                    }
                    #welcome-panel {
                        background: rgba(0,0,0,0.35) !important;
                        backdrop-filter: blur(4px) !important;
                        -webkit-backdrop-filter: blur(4px) !important;
                    }
                    .invite-input-wrapper {
                        border-color: hsl(var(--color-border));
                        background: hsl(var(--color-background) / 0.45);
                    }
                    .invite-input-wrapper:focus-within {
                        border-color: hsl(var(--color-muted-foreground));
                    }
                    .invite-input-wrapper.input-error {
                        border-color: #ef4444;
                    }
                </style>

                <div class="relative flex items-center mb-2">
                    <h2 class="text-lg font-semibold text-foreground">Welcome back</h2>
                    <button id="close-thanks-btn" class="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-accent" style="position:absolute;top:-10px;right:-8px" aria-label="Close">
                        <svg class="w-4 h-4" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>

                <p class="text-sm text-muted-foreground mb-4">Thanks for trying this out! We will send an invite code via your email as soon as we have more capacity.</p>

                <form id="thanks-invite-form" class="w-full">
                    <div class="invite-input-wrapper flex items-center w-full h-10 border rounded-lg transition-all ${hasError ? 'input-error' : ''}">
                        <input
                            id="thanks-invite-code-input"
                            type="text"
                            maxlength="24"
                            placeholder="Invite code"
                            class="flex-1 h-full px-3 text-sm bg-transparent text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                            value="${this.escapeHtml(this.inviteCode)}"
                            autocomplete="off"
                            autocorrect="off"
                            autocapitalize="off"
                            spellcheck="false"
                        />
                        <button
                            type="submit"
                            class="flex-shrink-0 w-8 h-8 m-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors flex items-center justify-center disabled:opacity-50"
                            aria-label="Redeem invite code"
                        >
                            <svg class="w-4 h-4" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                            </svg>
                        </button>
                    </div>
                    <p class="text-xs leading-4 whitespace-pre-line mt-1.5 text-red-500 ${hasError ? '' : 'hidden'}">${this.escapeHtml(this.redeemError || '')}</p>
                </form>

                <div class="mt-3 flex items-stretch gap-2">
                    <a
                        href="https://openanonymity.ai/beta"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="btn-ghost-hover flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none bg-background text-foreground h-10 px-3 shadow-sm border border-border"
                    >
                        <svg class="w-4 h-4 flex-shrink-0" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"></path>
                        </svg>
                        <span>Request beta access</span>
                    </a>
                    <a
                        href="${SHARE_FEEDBACK_URL}"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="btn-ghost-hover flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none bg-background text-foreground h-10 px-3 shadow-sm border border-border"
                    >
                        <svg class="w-4 h-4 flex-shrink-0" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path>
                        </svg>
                        <span>Share Feedback</span>
                    </a>
                </div>
            </div>
        `;
    }

    renderRedeemingStep() {
        const progress = this.redeemProgress || { message: 'Processing...', percent: 0 };

        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}" style="padding:28px">
                <div class="flex flex-col items-center justify-center py-8">
                    <div class="w-12 h-12 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>

                    <p class="text-sm font-medium text-foreground mb-2">${this.escapeHtml(progress.message)}</p>

                    <div class="w-full max-w-xs h-2 bg-muted rounded-full overflow-hidden">
                        <div
                            class="h-full bg-blue-600 transition-all duration-300 ease-out"
                            style="width: ${progress.percent}%"
                        ></div>
                    </div>
                    <p class="text-xs text-muted-foreground mt-2">${progress.percent}% complete</p>
                </div>
            </div>
        `;
    }

    renderSuccessStep() {
        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES} welcome-modal-glass welcome-success-surface" style="padding:28px 28px 20px">
                <style>
                    .welcome-success-surface {
                        background: hsl(var(--color-background) / 0.72);
                        backdrop-filter: blur(20px) saturate(1.2);
                        -webkit-backdrop-filter: blur(20px) saturate(1.2);
                    }
                    .success-tick {
                        width: 22px; height: 22px;
                        border-radius: 50%;
                        background: hsl(152 60% 48%);
                        display: inline-flex; align-items: center; justify-content: center;
                        flex-shrink: 0;
                    }
                    .dark .success-tick { background: hsl(152 50% 40%); }
                </style>

                <div class="flex items-center gap-2" style="margin-bottom:10px">
                    <div class="success-tick">
                        <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path>
                        </svg>
                    </div>
                    <h2 class="text-lg font-semibold text-foreground">You're all set!</h2>
                </div>

                <p class="text-sm text-muted-foreground" style="margin-bottom:14px">
                    ${this.ticketsRedeemed} ticket${this.ticketsRedeemed !== 1 ? 's' : ''} added. Tickets authenticate chat sessions, and costs vary by model tier (see model picker).
                </p>

                <div class="flex items-stretch gap-3">
                    <button
                        id="create-account-btn"
                        class="btn-ghost-hover flex-1 h-9 rounded-lg text-sm border border-border bg-background text-foreground shadow-sm transition-colors flex items-center justify-center gap-1.5"
                    >
                        <svg class="w-3.5 h-3.5 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                        </svg>
                        Create Account
                    </button>
                    <button
                        id="start-chatting-btn"
                        class="flex-1 h-9 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 shadow-sm transition-colors flex items-center justify-center gap-1.5"
                    >
                        Start Chatting
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                        </svg>
                    </button>
                </div>
                <p class="text-muted-foreground" style="margin-top:16px;font-size:11px;line-height:1.3">
                    Account is optional and enables encrypted-sync of your data (tickets, preferences, and soon chat sessions) with Passkeys.
                </p>
            </div>
        `;
    }

    attachEventListeners() {
        const themeToggle = document.getElementById('welcome-theme-toggle');
        if (themeToggle) {
            themeToggle.onclick = (e) => {
                const btn = e.target.closest('.theme-toggle-btn');
                if (!btn) return;
                const preference = btn.dataset.themeOption;
                if (preference) {
                    themeManager.setPreference(preference);
                    this.updateThemeToggle(preference);
                }
            };
        }

        this.themeUnsubscribe?.();
        this.themeUnsubscribe = themeManager.onChange((preference) => {
            this.updateThemeToggle(preference);
        });

        const closeBtn = document.getElementById('close-thanks-btn');
        if (closeBtn) closeBtn.onclick = () => this.handleCloseAttempt();

        const form = document.getElementById('thanks-invite-form');
        if (form) {
            form.onsubmit = (e) => this.handleInviteSubmit(e);
        }

        const inviteInput = document.getElementById('thanks-invite-code-input');
        if (inviteInput) {
            inviteInput.oninput = (e) => {
                this.inviteCode = e.target.value;
                if (this.redeemError) {
                    this.redeemError = null;
                    this.render();
                }
            };
            if (this.step === 'thanks') {
                setTimeout(() => inviteInput.focus(), 100);
            }
        }

        const createAccountBtn = document.getElementById('create-account-btn');
        if (createAccountBtn) {
            createAccountBtn.onclick = () => this.handleCreateAccount();
        }

        const startChattingBtn = document.getElementById('start-chatting-btn');
        if (startChattingBtn) {
            startChattingBtn.onclick = () => this.handleStartChatting();
        }
    }

    updateThemeToggle(preference) {
        const container = document.getElementById('welcome-theme-toggle');
        if (!container) return;

        container.dataset.theme = preference;

        container.querySelectorAll('.theme-toggle-btn').forEach((btn) => {
            btn.setAttribute('aria-checked', String(btn.dataset.themeOption === preference));
        });
    }

    destroy() {
        this.themeUnsubscribe?.();
        this.themeUnsubscribe = null;
        if (this.ticketsUpdatedHandler) {
            window.removeEventListener('tickets-updated', this.ticketsUpdatedHandler);
            this.ticketsUpdatedHandler = null;
        }
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
    }
}

export default ThanksPanel;
