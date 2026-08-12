/** Premium subscription UI. Pricing and interval always come from oa-org. */

import { BILLING_CHECKOUT_INTENT_KEY } from '../services/billingState.js';

const SAFE_SUBSCRIPTION_STATUSES = new Set([
    'active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete', 'paused', 'none'
]);

export default class BillingModal {
    constructor(app) {
        this.app = app;
        this.billing = app.services.billing;
        this.account = app.services.account;
        this.overlay = document.getElementById('billing-modal');
        this.navButton = document.getElementById('account-tab-btn');
        this.isOpen = false;
        this.busy = null;
        this.error = null;
        this.notice = null;
        this.planRequestFailed = false;
        this.snapshot = this.billing?.snapshot?.() || {};
        this.unsubscribe = this.billing?.subscribe?.(snapshot => {
            this.snapshot = snapshot;
            if (this.isOpen) this.render();
        });
        this.handleBillingReturn();
        void this.billing?.resumeKnownBilling?.().catch(error => {
            if (error?.name !== 'AbortError') {
                console.warn('[Billing] Saved Premium preparation is waiting for a safe retry.');
            }
        });
    }

    destroy() {
        this.unsubscribe?.();
    }

    rememberCheckoutIntent() {
        try { globalThis.sessionStorage?.setItem(BILLING_CHECKOUT_INTENT_KEY, '1'); } catch {}
    }

    hasCheckoutIntent() {
        try { return globalThis.sessionStorage?.getItem(BILLING_CHECKOUT_INTENT_KEY) === '1'; } catch { return false; }
    }

    clearCheckoutIntent() {
        try { globalThis.sessionStorage?.removeItem(BILLING_CHECKOUT_INTENT_KEY); } catch {}
    }

    cancelCheckoutIntent({ reopenPremium = true } = {}) {
        if (!this.hasCheckoutIntent()) return false;
        this.clearCheckoutIntent();
        if (reopenPremium) this.open();
        return true;
    }

    resumeCheckoutIntent() {
        const state = this.account?.getState?.() || {};
        if (!this.hasCheckoutIntent() || !state.accountId || !state.sessionVerified) return false;
        this.clearCheckoutIntent();
        this.open();
        queueMicrotask(() => void this.checkout());
        return true;
    }

    async handleBillingReturn() {
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);
        const outcome = params.get('billing');
        const sessionId = params.get('session_id');
        if (!outcome) {
            try {
                const resumed = await this.billing.resumeSavedCheckout?.();
                if (resumed) {
                    this.open();
                    this.app.showToast?.('Premium payment confirmed. Preparing private tickets.', 'success');
                    void this.startPreparation({ automatic: true });
                }
            } catch (error) {
                this.open();
                this.error = this.safeErrorMessage(error, 'Payment confirmation is still pending.');
                this.render();
            }
            return;
        }
        this.open();
        if (['success', 'topup_success'].includes(outcome) && sessionId) {
            const kind = outcome === 'topup_success' ? 'topup' : 'subscription';
            this.busy = 'confirming';
            this.render();
            try {
                const confirmed = await this.billing.reconcileCheckout(sessionId, { kind });
                if (confirmed) {
                    this.app.showToast?.(
                        kind === 'topup'
                            ? 'Ticket-pack payment confirmed. Preparing private tickets.'
                            : 'Premium payment confirmed. Preparing private tickets.',
                        'success'
                    );
                    void this.startPreparation({ automatic: true });
                } else if (kind === 'topup') {
                    this.notice = 'This ticket-pack Checkout expired before payment was confirmed.';
                }
            } catch (error) {
                this.error = this.safeErrorMessage(error, 'Payment confirmation is still pending.');
            } finally {
                this.busy = null;
                if (kind === 'topup') this.billing.clearTopupReturnSession?.(sessionId);
                this.clearReturnParams();
                this.render();
            }
        } else if (outcome === 'topup_cancelled') {
            const returnSession = this.billing.getTopupReturnSession?.();
            try {
                if (returnSession?.sessionId) {
                    await this.cancelTicketPackCheckout(returnSession.sessionId);
                } else {
                    this.notice = 'Ticket-pack Checkout was interrupted. Continue it or cancel it here.';
                }
            } finally {
                this.billing.clearTopupReturnSession?.(returnSession?.sessionId);
                this.clearReturnParams();
                this.render();
            }
        } else {
            if (outcome === 'cancelled') this.billing.discardKnownCheckout?.('subscription');
            this.clearReturnParams();
        }
    }

    clearReturnParams() {
        const params = new URLSearchParams(window.location.search);
        params.delete('billing');
        params.delete('session_id');
        const search = params.toString();
        window.history.replaceState({}, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
    }

    open() {
        if (!this.overlay) return;
        this.isOpen = true;
        this.returnFocus = document.activeElement;
        this.overlay.classList.remove('hidden');
        this.navButton?.setAttribute('aria-expanded', 'true');
        this.render();
        void this.refresh();
    }

    close() {
        if (!this.overlay) return;
        this.isOpen = false;
        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
        this.navButton?.setAttribute('aria-expanded', 'false');
        this.returnFocus?.focus?.();
        this.returnFocus = null;
    }

    async refresh() {
        this.busy = 'loading';
        this.error = null;
        this.notice = null;
        this.planRequestFailed = false;
        this.render();
        let planLoaded = false;
        try {
            await this.billing.getPlan({ force: true });
            planLoaded = true;
            try {
                const status = await this.billing.getStatus({ force: true, createDemo: true });
                this.snapshot = this.billing.snapshot();
                if (Number(status.available_batches || 0) > 0 ||
                    ['claimable', 'claiming'].includes(status?.ticket_pack?.state)) {
                    void this.startPreparation({ automatic: true });
                }
            } catch (error) {
                if (error?.code !== 'BILLING_AUTH_REQUIRED') throw error;
            }
        } catch (error) {
            this.planRequestFailed = !planLoaded;
            this.error = this.safeErrorMessage(error, 'Premium billing is unavailable.');
        } finally {
            if (this.busy === 'loading') this.busy = null;
            if (this.isOpen) this.render();
        }
    }

    async startPreparation({ automatic = false } = {}) {
        if (this.busy === 'preparing') return;
        this.busy = 'preparing';
        this.error = null;
        this.render();
        try {
            const result = automatic
                ? await this.billing.automaticallyPrepareOneBatch()
                : await this.billing.prepareOneBatch();
            if (result) {
                this.app.showToast?.(`${result.ticketsAdded} private tickets added to this browser.`, 'success', 6000);
            }
        } catch (error) {
            if (error?.name !== 'AbortError') {
                this.error = this.safeErrorMessage(error, 'Private ticket preparation paused safely.');
                this.app.showToast?.('Private ticket preparation paused. You can retry safely.', 'error', 6000);
            }
        } finally {
            this.busy = null;
            if (this.isOpen) this.render();
        }
    }

    async checkout() {
        this.busy = 'checkout';
        this.error = null;
        this.render();
        try {
            await this.billing.checkout();
        } catch (error) {
            if (error?.code === 'BILLING_AUTH_REQUIRED' && this.app.accountModal?.open) {
                this.rememberCheckoutIntent();
                this.close();
                this.app.accountModal.open();
                return;
            }
            this.error = this.safeErrorMessage(error, 'Unable to open Stripe Checkout.');
            this.busy = null;
            this.render();
        }
    }

    async purchaseTicketPack() {
        this.busy = 'topup-checkout';
        this.error = null;
        this.notice = null;
        this.render();
        try {
            await this.billing.purchaseTicketPack();
        } catch (error) {
            this.error = this.safeErrorMessage(error, 'Unable to open ticket-pack Checkout.');
            this.busy = null;
            this.render();
        }
    }

    async cancelTicketPackCheckout(sessionId = null) {
        const activeSession = sessionId
            ? { sessionId }
            : this.billing.getKnownCheckoutSession?.('topup');
        if (!activeSession?.sessionId) {
            this.error = 'No recoverable ticket-pack Checkout is available to cancel.';
            this.render();
            return null;
        }
        this.busy = 'topup-cancel';
        this.error = null;
        this.notice = null;
        this.render();
        try {
            const result = await this.billing.cancelTicketPackCheckout(activeSession.sessionId);
            if (result.outcome === 'cancelled') {
                this.app.showToast?.('Ticket-pack Checkout cancelled.', 'success');
            } else if (result.outcome === 'payment_confirmed') {
                this.app.showToast?.(
                    'Ticket-pack payment confirmed. Preparing private tickets.',
                    'success'
                );
                void this.startPreparation({ automatic: true });
            } else if (result.outcome === 'payment_pending') {
                this.notice = 'Stripe is still confirming this payment. Continue or check again shortly.';
            }
            return result;
        } catch (error) {
            if (error?.name !== 'AbortError') {
                this.error = this.safeErrorMessage(
                    error,
                    'Unable to cancel ticket-pack Checkout. Recovery remains available.'
                );
            }
            return null;
        } finally {
            if (this.busy === 'topup-cancel') this.busy = null;
            if (this.isOpen) this.render();
        }
    }

    async portal() {
        this.busy = 'portal';
        this.error = null;
        this.render();
        try {
            await this.billing.portal();
        } catch (error) {
            this.error = this.safeErrorMessage(error, 'Unable to open the billing portal.');
            this.busy = null;
            this.render();
        }
    }

    formatPrice(plan, { failed = false } = {}) {
        if (!plan || !Number.isFinite(Number(plan.unit_amount))) {
            return failed ? 'Price unavailable' : 'Loading price…';
        }
        const amount = new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: String(plan.currency || 'usd').toUpperCase(),
            maximumFractionDigits: Number(plan.unit_amount) % 100 === 0 ? 0 : 2
        }).format(Number(plan.unit_amount) / 100);
        return `${amount} / ${plan.interval || 'period'}`;
    }

    formatMoney(offer) {
        if (!offer || !Number.isFinite(Number(offer.unit_amount))) return 'Loading price…';
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: String(offer.currency || 'usd').toUpperCase(),
            minimumFractionDigits: Number(offer.unit_amount) % 100 === 0 ? 0 : 2,
            maximumFractionDigits: 2
        }).format(Number(offer.unit_amount) / 100);
    }

    safeErrorMessage(error, fallback) {
        const safeByCode = {
            BILLING_AUTH_REQUIRED: 'Sign in to your OA account to continue.',
            BILLING_BROWSER_LOCK_UNAVAILABLE: 'This browser cannot safely prepare Premium tickets across tabs.',
            BILLING_NO_ENTITLEMENT: 'No Premium ticket allowance is ready yet.',
            BILLING_ALLOWANCE_UNAVAILABLE: 'Your Premium ticket allowance is not ready yet.',
            BILLING_ALLOWANCE_INVALID: 'Your Premium ticket allowance could not be verified.',
            BILLING_ISSUER_ROTATED: 'The monthly ticket period changed. Retry to prepare the current allowance.',
            BILLING_INCOMPLETE_RESPONSE: 'Private ticket preparation received an incomplete response.',
            BILLING_TOPUP_PENDING: 'Finish preparing the current ticket pack before buying another.',
            BILLING_TOPUP_INELIGIBLE: 'An active Premium subscription is required for ticket packs.',
            BILLING_TOPUP_UNAVAILABLE: 'Ticket packs are temporarily unavailable.',
            BILLING_TOPUP_CHECKOUT_CHANGED: 'This Checkout is no longer current. Use the recovery controls shown here.',
            BILLING_TOPUP_INVALID_CHECKOUT: 'This ticket-pack Checkout could not be verified.'
        };
        return safeByCode[error?.code] || fallback;
    }

    formatSubscriptionStatus(value) {
        const normalized = String(value || 'none').toLowerCase();
        return SAFE_SUBSCRIPTION_STATUSES.has(normalized) ? normalized : 'unavailable';
    }

    formatTicketEpochEnd(value) {
        const date = new Date(Number(value) * 1000);
        if (!Number.isFinite(date.getTime())) return 'the next UTC month boundary';
        return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    }

    render() {
        if (!this.isOpen || !this.overlay) return;
        const plan = this.snapshot.plan;
        const status = this.snapshot.status;
        const progress = this.snapshot.progress;
        const active = status?.premium_active === true ||
            ['active', 'trialing'].includes(status?.subscription?.status);
        const planReady = !this.planRequestFailed &&
            Number.isFinite(Number(plan?.unit_amount)) &&
            Number(plan?.unit_amount) > 0 && Number(plan?.tickets_per_period) > 0;
        const accountState = this.account?.getState?.() || {};
        const checkoutLabel = accountState.sessionVerified
            ? 'Upgrade with Stripe'
            : 'Register and upgrade';
        const remaining = Number(status?.available_batches || 0);
        const ticketCount = Number(plan?.tickets_per_period || 0);
        const nextTicketCount = Number(status?.next_claim_ticket_count || 0);
        const ticketPack = plan?.ticket_pack || null;
        const ticketPackStatus = status?.ticket_pack || null;
        const showTicketPack = Boolean(ticketPack && ticketPackStatus?.eligible === true);
        const ticketPackCount = Number(ticketPack?.tickets || ticketPackStatus?.ticket_count || 0);
        const ticketPackExpiry = this.formatTicketEpochEnd(
            ticketPack?.tickets_expire_at || plan?.ticket_epoch_expires_at
        );
        const ticketPackState = String(ticketPackStatus?.state || 'ineligible');
        const progressLabel = progress
            ? `${progress.phase === 'finalizing' ? 'Finalizing' : progress.phase === 'claiming' ? 'Requesting signatures' : 'Preparing'}${progress.source === 'topup' ? ' ticket-pack' : ''} private tickets — ${progress.completed} / ${progress.total}`
            : '';

        this.overlay.innerHTML = `
            <div role="dialog" aria-modal="true" aria-labelledby="billing-title" class="w-full max-w-md rounded-xl border border-border bg-background shadow-2xl p-5 mx-4">
                <div class="flex items-center justify-between mb-4">
                    <div>
                        <h2 id="billing-title" class="text-base font-semibold text-foreground">OA Premium</h2>
                        <p class="text-xs text-muted-foreground">Secure checkout by Stripe</p>
                    </div>
                    <button id="billing-close-btn" class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent" aria-label="Close">✕</button>
                </div>
                <div class="rounded-lg border border-border p-4 bg-muted/20">
                    <p class="text-2xl font-semibold text-foreground">${this.formatPrice(plan, { failed: this.planRequestFailed })}</p>
                    <p class="mt-1 text-sm text-muted-foreground">${ticketCount && !this.planRequestFailed ? `${ticketCount} privacy-preserving tickets per full monthly period.` : this.planRequestFailed ? 'Ticket allowance unavailable.' : 'Loading ticket allowance…'}</p>
                    <p class="mt-2 text-xs text-muted-foreground">Your first payment and ticket allowance are prorated until the next renewal.</p>
                    <p class="mt-3 text-xs text-muted-foreground">Your account proves payment only while tickets are issued. The finished tickets remain in this browser and are redeemed without your billing identity.</p>
                </div>
                ${showTicketPack ? `
                    <div class="mt-3 rounded-lg border border-border p-4">
                        <p class="text-sm font-semibold text-foreground">Buy ${ticketPackCount} tickets — ${this.escape(this.formatMoney(ticketPack))}</p>
                        <p class="mt-1 text-xs text-muted-foreground">A one-time Premium add-on. Prepare the tickets privately in this browser after payment.</p>
                        <p class="mt-1 text-xs text-muted-foreground">Prepared pack tickets expire with the global issuer at ${this.escape(ticketPackExpiry)}. An unprepared paid pack remains available for a later month.</p>
                        ${ticketPackState === 'ready' && ticketPackStatus?.can_purchase === true ? `
                            <button id="billing-topup-btn" class="mt-3 w-full h-10 rounded-lg bg-blue-600 text-white font-medium disabled:opacity-50" ${this.busy ? 'disabled' : ''}>${this.busy === 'topup-checkout' ? 'Opening Checkout…' : `Buy ${ticketPackCount} tickets — ${this.escape(this.formatMoney(ticketPack))}`}</button>
                        ` : ''}
                        ${ticketPackState === 'checkout_pending' ? `
                            <p class="mt-3 text-xs text-muted-foreground">Ticket-pack Checkout is waiting for payment or confirmation.</p>
                            <button id="billing-topup-btn" class="mt-3 w-full h-10 rounded-lg bg-blue-600 text-white font-medium disabled:opacity-50" ${this.busy ? 'disabled' : ''}>${this.busy === 'topup-checkout' ? 'Opening Checkout…' : 'Continue ticket-pack Checkout'}</button>
                            <button id="billing-topup-cancel-btn" class="mt-2 w-full h-9 rounded-lg border border-border text-muted-foreground text-sm font-medium disabled:opacity-50" ${this.busy ? 'disabled' : ''}>${this.busy === 'topup-cancel' ? 'Cancelling…' : 'Cancel Checkout'}</button>
                        ` : ''}
                        ${['claimable', 'claiming'].includes(ticketPackState) && !progress ? `
                            <button id="billing-topup-prepare-btn" class="mt-3 w-full h-10 rounded-lg border border-border text-foreground font-medium disabled:opacity-50" ${this.busy ? 'disabled' : ''}>${ticketPackState === 'claiming' ? 'Resume preparing' : 'Prepare'} ${ticketPackCount} private tickets</button>
                        ` : ''}
                    </div>
                ` : ''}
                ${this.notice ? `<div class="mt-3 rounded-md bg-muted text-muted-foreground text-xs p-3">${this.escape(this.notice)}</div>` : ''}
                ${this.error ? `<div class="mt-3 rounded-md bg-destructive/10 text-destructive text-xs p-3">${this.escape(this.error)}</div>` : ''}
                ${progress ? `
                    <div class="mt-4">
                        <div class="flex justify-between text-xs text-muted-foreground mb-1"><span>${this.escape(progressLabel)}</span><span>${Math.round((progress.completed / progress.total) * 100)}%</span></div>
                        <div class="h-2 rounded-full bg-muted overflow-hidden"><div class="h-full bg-blue-600 transition-all" style="width:${(progress.completed / progress.total) * 100}%"></div></div>
                        <p class="mt-2 text-[11px] text-muted-foreground">You may close this window. Progress remains local and resumes after reload.</p>
                    </div>
                ` : ''}
                ${status ? `<p class="mt-4 text-sm text-muted-foreground">Subscription: <span class="text-foreground">${this.escape(this.formatSubscriptionStatus(status.subscription?.status))}</span></p>` : ''}
                <div class="mt-5 flex flex-col gap-2">
                    ${!active && planReady ? `<button id="billing-checkout-btn" class="w-full h-10 rounded-lg bg-blue-600 text-white font-medium disabled:opacity-50" ${this.busy ? 'disabled' : ''}>${this.busy === 'checkout' ? 'Opening Checkout…' : checkoutLabel}</button>` : ''}
                    ${!active && !planReady ? `<button id="billing-retry-btn" class="w-full h-10 rounded-lg border border-border text-foreground font-medium disabled:opacity-50" ${this.busy ? 'disabled' : ''}>${this.busy === 'loading' ? 'Loading pricing…' : 'Retry pricing'}</button>` : ''}
                    ${remaining > 0 && !progress ? `<button id="billing-prepare-btn" class="w-full h-10 rounded-lg border border-border text-foreground font-medium disabled:opacity-50" ${this.busy ? 'disabled' : ''}>Prepare ${nextTicketCount || ticketCount || 300} private tickets</button>` : ''}
                    ${status?.portal_available ? `<button id="billing-portal-btn" class="w-full h-9 rounded-lg text-sm text-muted-foreground hover:text-foreground" ${this.busy ? 'disabled' : ''}>Manage billing</button>` : ''}
                </div>
            </div>`;
        this.overlay.onclick = event => { if (event.target === this.overlay) this.close(); };
        this.overlay.querySelector('#billing-close-btn')?.addEventListener('click', () => this.close());
        this.overlay.querySelector('#billing-checkout-btn')?.addEventListener('click', () => void this.checkout());
        this.overlay.querySelector('#billing-retry-btn')?.addEventListener('click', () => void this.refresh());
        this.overlay.querySelector('#billing-prepare-btn')?.addEventListener('click', () => void this.startPreparation());
        this.overlay.querySelector('#billing-topup-btn')?.addEventListener('click', () => void this.purchaseTicketPack());
        this.overlay.querySelector('#billing-topup-cancel-btn')?.addEventListener('click', () => void this.cancelTicketPackCheckout());
        this.overlay.querySelector('#billing-topup-prepare-btn')?.addEventListener('click', () => void this.startPreparation());
        this.overlay.querySelector('#billing-portal-btn')?.addEventListener('click', () => void this.portal());
    }

    escape(value) {
        const div = document.createElement('div');
        div.textContent = String(value || '');
        return div.innerHTML;
    }
}
