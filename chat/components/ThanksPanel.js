/**
 * Thanks Panel Component
 * Returning-user panel for users who previously held tickets.
 */

import ticketClient from '../services/ticketClient.js';
import themeManager from '../services/themeManager.js';

const STORAGE_KEY_DISMISSED = 'oa-welcome-dismissed';
const MODAL_CLASSES = 'w-full max-w-md rounded-2xl border border-border shadow-lg mx-4 flex flex-col welcome-modal-glass';
const SHARE_FEEDBACK_URL = 'https://forms.gle/HEmvxnJpN1jQC7CfA';

class ThanksPanel {
    constructor(app) {
        this.app = app;
        this.isOpen = false;
        this.overlay = document.getElementById('welcome-panel');

        this.step = 'thanks';
        this.accessInput = '';
        this.isRedeeming = false;
        this.redeemProgress = null;
        this.redeemError = null;
        this.redeemInfo = null;
        this.ticketsRedeemed = 0;

        this.returnFocusEl = null;
        this.escapeHandler = null;
        this.themeUnsubscribe = null;
        this.ticketsUpdatedHandler = null;
        this.animateOnNextRender = false;
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
        this.accessInput = '';
        this.isRedeeming = false;
        this.redeemProgress = null;
        this.redeemError = null;
        this.redeemInfo = null;
        this.ticketsRedeemed = 0;
        this.animateOnNextRender = true;

        this.overlay.classList.remove('hidden');
        document.documentElement.removeAttribute('data-welcome-hidden');
        this.render();
        this.scheduleInitialInputFocus();

        this.overlay.onclick = (e) => {
            if (e.target === this.overlay) this.handleCloseAttempt();
        };
        this.escapeHandler = (e) => {
            if (e.key === 'Escape') this.handleCloseAttempt();
        };
        document.addEventListener('keydown', this.escapeHandler);
    }

    scheduleInitialInputFocus() {
        requestAnimationFrame(() => {
            this.focusAccessInput();
        });
    }

    focusAccessInput() {
        if (!this.isOpen || this.isRedeeming) return;
        const input = document.getElementById('thanks-access-input');
        if (!input || document.activeElement === input) return;
        input.focus({ preventScroll: true });
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

    isEmailInput(value) {
        const trimmed = (value || '').trim();
        if (!trimmed || trimmed.length > 254) return false;
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    }

    normalizeInviteCode(value) {
        return (value || '').trim().replace(/[\s-]+/g, '');
    }

    isInviteCodeInput(value) {
        const normalized = this.normalizeInviteCode(value);
        return normalized.length === 24 && /^[a-zA-Z0-9]+$/.test(normalized);
    }

    getInputKind(value) {
        const trimmed = (value || '').trim();
        if (!trimmed) return 'empty';
        if (this.isEmailInput(trimmed)) return 'email';
        if (this.isInviteCodeInput(trimmed)) return 'inviteCode';
        return 'unknown';
    }

    getSubmitButtonConfig(kind) {
        if (kind === 'email') return { ariaLabel: 'Join waitlist by email' };
        if (kind === 'inviteCode') return { ariaLabel: 'Redeem invite code' };
        return { ariaLabel: 'Continue' };
    }

    getInputHint(kind) {
        if (kind === 'email') {
            return 'Press Enter to submit your email to the request waitlist.';
        }

        if (kind === 'inviteCode') {
            return 'Press Enter to redeem this 24-character invite code.';
        }

        return '';
    }

    async redeemInviteCode(inviteCode) {
        const result = await ticketClient.alphaRegister(inviteCode, (message, percent) => {
            this.redeemProgress = { message, percent };
            this.render();
        });

        this.ticketsRedeemed = result.tickets_issued;
        this.isRedeeming = false;
        this.redeemProgress = null;

        // Notify ticket UI and close the panel (skip success screen in ThanksPanel).
        window.dispatchEvent(new CustomEvent('tickets-updated'));
        const redeemedCount = Number.isFinite(this.ticketsRedeemed)
            ? this.ticketsRedeemed
            : ticketClient.getTicketCount();
        if (redeemedCount > 0) {
            this.app?.showToast?.(
                `${redeemedCount} ticket${redeemedCount === 1 ? '' : 's'} added.`,
                'success'
            );
        } else {
            this.app?.showToast?.('Tickets added.', 'success');
        }
        this.close();
    }

    async handleInviteSubmit(e) {
        if (e) e.preventDefault();

        const inputValue = this.accessInput.trim();
        const inputKind = this.getInputKind(inputValue);

        if (inputKind === 'empty') {
            this.redeemError = 'Please enter an email or invite code.';
            this.redeemInfo = null;
            this.render();
            return;
        }

        if (inputKind === 'unknown') {
            const maybeEmail = inputValue.includes('@');
            this.redeemError = maybeEmail
                ? 'Please enter a valid email address.'
                : 'Please enter a valid email or 24-character invite code.';
            this.redeemInfo = null;
            this.render();
            return;
        }

        this.isRedeeming = true;
        this.redeemError = null;
        this.redeemInfo = null;
        this.redeemProgress = inputKind === 'email'
            ? { message: 'Submitting waitlist form...', percent: 20 }
            : { message: 'Starting...', percent: 0 };
        this.render();

        try {
            if (inputKind === 'email') {
                const waitlistResult = await ticketClient.joinWaitlist({
                    email: inputValue,
                    source: 'thanks_panel'
                });

                this.isRedeeming = false;
                this.redeemProgress = null;
                this.redeemError = null;
                this.redeemInfo = waitlistResult?.message
                    || "Thanks for joining! We'll be in touch soon.";
                this.accessInput = '';
                this.render();
                return;
            }

            const inviteCode = this.normalizeInviteCode(inputValue);
            await this.redeemInviteCode(inviteCode);
            return;
        } catch (error) {
            console.error('Thanks panel invite error:', error);
            this.isRedeeming = false;
            this.redeemProgress = null;
            this.redeemInfo = null;
            this.redeemError = error.message || (
                inputKind === 'email'
                    ? 'Failed to submit invite request'
                    : 'Failed to redeem invite code'
            );
            this.render();
        }
    }

    render() {
        if (!this.overlay) return;

        this.overlay.innerHTML = this.renderThanksStep();
        this.animateOnNextRender = false;

        this.attachEventListeners();
    }

    renderThanksStep() {
        const hasError = !!this.redeemError;
        const hasInfo = !!this.redeemInfo;
        const inputKind = this.getInputKind(this.accessInput);
        const submitButton = this.getSubmitButtonConfig(inputKind);
        const hintText = this.isRedeeming && this.redeemProgress?.message
            ? this.redeemProgress.message
            : this.getInputHint(inputKind);
        const submitToneClass = inputKind === 'inviteCode'
            ? 'invite-submit-redeem'
            : 'invite-submit-email';
        const isSubmitDisabled = this.isRedeeming || !this.accessInput.trim();
        const feedbackText = hasError ? this.redeemError : this.redeemInfo;
        const feedbackClass = hasError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400';
        const modalClass = this.animateOnNextRender
            ? `${MODAL_CLASSES} welcome-modal-enter`
            : MODAL_CLASSES;

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

            <div role="dialog" aria-modal="true" class="${modalClass}" style="padding:28px 28px 20px">
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
                    .invite-input-wrapper.input-error:focus-within {
                        border-color: #ef4444;
                    }
                    .invite-submit-btn {
                        box-shadow: inset 0 1px 0 rgba(255,255,255,0.14);
                    }
                    .invite-submit-btn.invite-submit-email {
                        background: hsl(var(--blue-600));
                    }
                    .invite-submit-btn.invite-submit-email:hover {
                        background: hsl(var(--blue-700));
                    }
                    .invite-submit-btn.invite-submit-redeem {
                        background: #0f766e;
                    }
                    .invite-submit-btn.invite-submit-redeem:hover {
                        background: #0d5f59;
                    }
                    .invite-submit-btn:disabled {
                        opacity: 0.45;
                        cursor: not-allowed;
                    }
                    .invite-submit-spinner {
                        width: 14px;
                        height: 14px;
                        border: 2px solid rgba(255,255,255,0.28);
                        border-top-color: #fff;
                        border-radius: 9999px;
                        animation: thanksSubmitSpin 0.7s linear infinite;
                    }
                    @keyframes thanksSubmitSpin {
                        from { transform: rotate(0deg); }
                        to { transform: rotate(360deg); }
                    }
                </style>

                <div class="relative flex items-center mb-2">
                    <h2 class="text-lg font-semibold text-foreground">You have no inference tickets left :(</h2>
                    <button id="close-thanks-btn" class="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-accent" style="position:absolute;top:-10px;right:-8px" aria-label="Close">
                        <svg class="w-4 h-4" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>

                <p class="text-sm text-muted-foreground mb-4">Thanks for trying oa-chat! Enter your email to request an invite code for more tickets, or redeem if you have one.</p>

                <form id="thanks-invite-form" class="w-full">
                    <div class="invite-input-wrapper flex items-center w-full h-10 border rounded-lg transition-all ${hasError ? 'input-error' : ''}">
                        <input
                            id="thanks-access-input"
                            type="text"
                            maxlength="254"
                            placeholder="Enter email or 24-character invite code"
                            class="flex-1 h-full px-3 text-sm bg-transparent text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                            value="${this.escapeHtml(this.accessInput)}"
                            autocomplete="off"
                            autocorrect="off"
                            autocapitalize="off"
                            spellcheck="false"
                            ${this.isRedeeming ? 'disabled' : ''}
                        />
                        <button
                            id="thanks-submit-btn"
                            type="submit"
                            class="invite-submit-btn ${submitToneClass} flex-shrink-0 w-8 h-8 m-1 rounded-md text-white transition-colors flex items-center justify-center"
                            aria-label="${submitButton.ariaLabel}"
                            ${isSubmitDisabled ? 'disabled' : ''}
                        >
                            ${this.isRedeeming
                                ? '<span class="invite-submit-spinner" aria-hidden="true"></span>'
                                : `<svg class="w-4 h-4" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                            </svg>`
                            }
                        </button>
                    </div>
                    <p id="thanks-input-hint" class="text-[11px] leading-4 mt-1.5 text-muted-foreground">${this.escapeHtml(hintText)}</p>
                    <p id="thanks-form-feedback" class="text-xs leading-4 whitespace-pre-line mt-1.5 ${feedbackClass} ${(hasError || hasInfo) ? '' : 'hidden'}">${this.escapeHtml(feedbackText || '')}</p>
                </form>

                <div class="mt-3">
                    <a
                        href="${SHARE_FEEDBACK_URL}"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="btn-ghost-hover w-full inline-flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none bg-background text-foreground h-10 px-3 shadow-sm border border-border"
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

        const accessInput = document.getElementById('thanks-access-input');
        if (accessInput) {
            accessInput.oninput = (e) => {
                this.accessInput = e.target.value;

                if (this.redeemError || this.redeemInfo) {
                    this.redeemError = null;
                    this.redeemInfo = null;
                    this.clearInlineFeedbackUI();
                }

                this.updateInputActionUI();
            };
            this.focusAccessInput();
        }

        this.updateInputActionUI();
    }

    clearInlineFeedbackUI() {
        const feedback = document.getElementById('thanks-form-feedback');
        if (feedback) {
            feedback.textContent = '';
            feedback.classList.add('hidden');
            feedback.classList.remove('text-red-500', 'text-emerald-600', 'dark:text-emerald-400');
        }

        const input = document.getElementById('thanks-access-input');
        const wrapper = input?.closest('.invite-input-wrapper');
        if (wrapper) {
            wrapper.classList.remove('input-error');
        }
    }

    updateInputActionUI() {
        const inputKind = this.getInputKind(this.accessInput);
        const submitConfig = this.getSubmitButtonConfig(inputKind);
        const isDisabled = this.isRedeeming || !this.accessInput.trim();

        const submitBtn = document.getElementById('thanks-submit-btn');
        if (submitBtn) {
            submitBtn.setAttribute('aria-label', submitConfig.ariaLabel);
            submitBtn.disabled = isDisabled;
            submitBtn.classList.toggle('invite-submit-redeem', inputKind === 'inviteCode');
            submitBtn.classList.toggle('invite-submit-email', inputKind !== 'inviteCode');
        }

        const hint = document.getElementById('thanks-input-hint');
        if (hint) {
            hint.textContent = this.isRedeeming && this.redeemProgress?.message
                ? this.redeemProgress.message
                : this.getInputHint(inputKind);
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
