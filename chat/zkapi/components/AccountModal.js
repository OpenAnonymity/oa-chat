import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { walletErrorMessage } from '@openanonymity/zkapi-browser-sdk/wallet-error';
import { updateZkapiBalanceControl } from './ZkapiStateExperience.js';
import { captureFundingSetupView, fundingSetupGuide, restoreFundingSetupView } from './FundingSetupGuide.js';
import {
    attachPrivateBalanceHelp, capturePrivateBalanceHelpFocus, privateBalanceExpiryLabel,
    privateBalanceExpired, privateBalanceHelpButton, privateBalanceHelpContent,
    restorePrivateBalanceHelpFocus, updatePrivateBalanceExpiryState
} from './PrivateBalanceHelp.js';

// The OA dialog frame (Account, Welcome): 560px, 24px radius, 40px inset, no
// header hairline. Sizing and colour live in zkapi.css (.zkapi-dialog).
const MODAL_CLASSES = 'zkapi-dialog';
// Wallet progress ("Approving USDC… confirm in MetaMask") shows as a toast
// under the dialog that holds until the next step replaces it; the final
// result gets an ordinary timed toast from run().
const PROGRESS_TOAST_MS = 120000;

export default class AccountModal {
    constructor(app, { triggerId = 'account-tab-btn', overlayId = 'account-modal' } = {}) {
        this.app = app;
        this.triggerId = triggerId;
        this.isOpen = false;
        this.overlay = document.getElementById(overlayId);
        this.view = 'balance';
        this.withdrawMode = 'mutual';
        this.busy = false;
        this.status = '';
        this.statusError = false;
        this.depositAmount = null;
        this.historyOpen = false;
        this.returnFocusEl = null;
        this.escapeHandler = null;
        this.unsubscribe = zkapiClient.subscribe((_snapshot, detail) => {
            if (detail?.reason === 'clock') return;
            this.updateTabIndicator();
            // An unfunded modal contains an editable amount. Rebuilding it on
            // background refreshes resets that value and steals input focus.
            // Mutating actions render once from run() after they complete.
            const editingDeposit = ['balance', 'fund'].includes(this.view)
                && !zkapiClient.note
                && document.activeElement?.id === 'zkapi-deposit-amount';
            if (this.isOpen && !this.busy && !editingDeposit) this.render();
        });
        this.clockUnsubscribe = zkapiClient.subscribeClock(({ now } = {}) => {
            this.handleZkapiClock(now);
        });
        this.attachTabListener();
        this.updateTabIndicator();
        void zkapiClient.init().catch(() => this.updateTabIndicator());

        window.addEventListener('zkapi-payment-required', (event) => {
            this.open(event.detail?.view || 'fund');
        });
    }

    attachTabListener() {
        const tabBtn = document.getElementById(this.triggerId);
        if (tabBtn) tabBtn.onclick = () => this.isOpen ? this.close() : this.open();
    }

    updateTabIndicator() {
        const tabBtn = document.getElementById(this.triggerId);
        if (!tabBtn) return;
        updateZkapiBalanceControl(tabBtn, this.app);
    }

    open(view = 'balance') {
        if (!this.overlay) return;
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
        if (!this.isOpen) this.returnFocusEl = document.activeElement;
        this.view = view;
        this.isOpen = true;
        this.status = '';
        this.statusError = false;
        this.render();
        this.overlay.classList.remove('hidden');
        document.getElementById(this.triggerId)?.setAttribute('aria-expanded', 'true');
        this.overlay.onclick = event => { if (event.target === this.overlay) this.close(); };
        this.escapeHandler = event => { if (event.key === 'Escape') this.close(); };
        document.addEventListener('keydown', this.escapeHandler);
        void zkapiClient.refresh({ quiet: true });
    }

    openFunding() {
        this.open('fund');
    }

    openWithdrawal() {
        this.open('withdraw');
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
        document.getElementById(this.triggerId)?.setAttribute('aria-expanded', 'false');
        if (this.escapeHandler) document.removeEventListener('keydown', this.escapeHandler);
        this.escapeHandler = null;
        const returnFocus = this.returnFocusEl?.isConnected === false
            ? this.returnFocusEl.id ? document.getElementById(this.returnFocusEl.id) : null
            : this.returnFocusEl;
        returnFocus?.focus?.();
        this.returnFocusEl = null;
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    setStatus(message, isError = false) {
        this.status = message;
        this.statusError = isError;
        const withdrawalAmount = this.overlay?.querySelector('[data-withdraw-amount]');
        if (withdrawalAmount && zkapiClient.note) {
            withdrawalAmount.textContent = zkapiClient.formatMoney(zkapiClient.note.current_balance);
        }
        if (!zkapiClient.activeLease) {
            this.overlay?.querySelector('[data-active-lease-notice]')?.remove();
        }
        // Progress lives in the toast, not in a line inside the card. While a
        // wallet step runs the toast holds; run() replaces it with the result.
        if (message && this.busy && !isError) this.app?.showToast?.(message, 'info', PROGRESS_TOAST_MS);
    }

    handleZkapiClock(now = Date.now()) {
        if (!this.isOpen || !this.overlay) return;
        if (this.view === 'withdrawals' && !this.busy) {
            const signature = this.expiryHistorySignature();
            // Only a deadline crossing changes history on a clock tick.
            if (signature !== this.renderedExpiryHistorySignature) { this.render(); return; }
        }
        const setText = (element, value) => {
            if (element && element.textContent !== value) element.textContent = value;
        };

        const noteExpiry = this.overlay.querySelector('[data-zkapi-balance-expiry]');
        if (noteExpiry && zkapiClient.note) {
            setText(noteExpiry, privateBalanceExpiryLabel(zkapiClient, zkapiClient.note.expiry_ts));
        }
        updatePrivateBalanceExpiryState(this.overlay, zkapiClient.note, now);

        const withdrawal = zkapiClient.withdrawal;
        if (this.view === 'withdraw' && withdrawal?.phase === 'pending') {
            const deadline = Number(withdrawal.challengeDeadline || 0);
            const clockNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
            const ready = deadline > 0 && clockNow >= deadline * 1000;
            const remaining = zkapiClient.formatExpiry(deadline);
            setText(
                this.overlay.querySelector('[data-zkapi-escape-countdown]'),
                ready ? 'The safety window is complete.' : `Finalize in ${remaining}.`
            );
            const finalizeButton = this.overlay.querySelector('#zkapi-finalize-btn');
            if (finalizeButton) {
                setText(finalizeButton, ready ? 'Finalize in MetaMask' : `Finalize in ${remaining}`);
                finalizeButton.disabled = !ready || this.busy;
            }
        }

        const clockNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        (this.overlay.querySelectorAll?.('[data-zkapi-withdrawal-countdown]') || []).forEach(element => {
            const deadline = Number(element.dataset.zkapiWithdrawalCountdown || 0);
            if (!deadline) return;
            const ready = clockNow >= deadline * 1000;
            const phase = element.dataset.recordPhase;
            if (phase !== 'pending') return;
            setText(element, ready ? 'Ready to finalize' : `Ready in ${zkapiClient.formatExpiry(deadline)}`);
            const button = this.overlay.querySelector(`[data-finalize-withdrawal="${element.dataset.recordId}"]`);
            if (button) {
                setText(button, ready ? 'Finalize' : `Ready in ${zkapiClient.formatExpiry(deadline)}`);
                button.disabled = !ready || this.busy;
            }
        });
    }

    async run(action, activityDetails = null) {
        if (this.busy) return;
        this.busy = true;
        this.backgroundProgress = activityDetails?.withdrawalRecordId
            ? { recordId: activityDetails.withdrawalRecordId, phase: 'preparing' } : null;
        this.render();
        const activityId = activityDetails
            ? zkapiClient.beginActivity(activityDetails.kind, {
                ...activityDetails,
                message: activityDetails.message || 'Starting…'
            })
            : null;
        const report = (message, phase = null) => {
            this.setStatus(message);
            if (this.backgroundProgress && phase) {
                this.backgroundProgress.phase = phase;
                this.updateBackgroundProgress();
            }
            if (activityId) zkapiClient.updateActivity(activityId, {
                message,
                ...(phase ? { phase } : {})
            });
        };
        try {
            await action(report);
            if (activityId) zkapiClient.completeActivity(activityId, {
                message: this.status || 'Complete.'
            });
            this.app.showToast?.(this.status || 'Private balance updated.', 'success', 5000);
        } catch (error) {
            const confirmationPending = error?.withdrawalConfirmationPending === true;
            const rejected = error?.code === 4001
                || error?.cause?.code === 4001
                || error?.data?.originalError?.code === 4001
                || error?.error?.code === 4001
                || error?.code === 'ACTION_REJECTED'
                || /(?:user|wallet).*(?:reject|denied|cancel)|request rejected/i.test(error?.message || '');
            this.setStatus(rejected
                ? error.shortMessage || 'MetaMask canceled the transaction. No funds moved; you can safely try again.'
                : walletErrorMessage(error), !rejected && !confirmationPending);
            if (activityId) {
                if (confirmationPending) zkapiClient.completeActivity(activityId, {
                    title: 'Withdrawal transaction mined',
                    phase: 'mined',
                    message: this.status
                });
                else if (rejected) zkapiClient.cancelActivity(activityId, this.status);
                else zkapiClient.failActivity(activityId, error);
            }
            // Closing a wallet prompt is an ordinary user decision. The
            // durable recovery path above has already put the operation into a
            // safe retry/canceled state, so do not present it as an app error.
            this.app.showToast?.(this.status, confirmationPending ? 'info' : rejected ? 'success' : 'error', 6000);
        } finally {
            this.busy = false;
            this.backgroundProgress = null;
            this.render();
        }
    }

    backgroundProgressLabel(recordId) {
        if (!this.busy || this.backgroundProgress?.recordId !== recordId) return null;
        return this.backgroundProgress.phase === 'wallet' ? 'Waiting for MetaMask'
            : this.backgroundProgress.phase === 'confirming' ? 'Confirming transaction' : 'Preparing withdrawal';
    }

    updateBackgroundProgress() {
        // Update just the busy row: never rebuild the modal or restart its
        // animation while a wallet request is open.
        this.overlay?.querySelectorAll('[data-background-progress]')?.forEach(element => {
            const label = this.backgroundProgressLabel(element.dataset.backgroundProgress);
            if (label && element.textContent !== label) element.textContent = label;
        });
    }

    progressPercent(note) {
        if (!note?.deposit_amount) return 0;
        return Math.max(0, Math.min(100,
            Number(note.current_balance) / Number(note.deposit_amount) * 100));
    }

    /**
     * The SDK method that drops a prepared (never broadcast) deposit, under
     * whichever name this SDK version gives it; null when it has none, in
     * which case the option is not offered.
     */
    pendingDepositDiscarder() {
        for (const name of ['discardPendingDeposit', 'cancelPendingDeposit', 'clearPendingDeposit', 'abandonPendingDeposit', 'resetPendingDeposit']) {
            if (typeof zkapiClient[name] === 'function') return () => zkapiClient[name]();
        }
        return null;
    }

    renderWithdrawalStatusLink() {
        const records = zkapiClient.withdrawals.filter(record => !this.hasVerifiedExpiryClaim(record));
        const lateAttempts = zkapiClient.unresolvedLateWithdrawals;
        const open = records.filter(record => !['closed', 'closed_unconfirmed'].includes(record.phase));
        const toCheck = open.length + lateAttempts.length;
        const expanded = Boolean(this.historyOpen);
        return `
            <div class="zkapi-guide" data-state="${expanded ? 'open' : 'closed'}">
                <button id="zkapi-withdrawal-status-btn" class="zkapi-guide-trigger" type="button" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="zkapi-payment-history">
                    <span>Payment history</span>${toCheck ? `<span class="zkapi-guide-note">${toCheck} withdrawal${toCheck === 1 ? '' : 's'} to check</span>` : ''}
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
                </button>
                <div id="zkapi-payment-history" class="zkapi-guide-body" ${expanded ? '' : 'hidden'}>${expanded ? this.renderWithdrawalRecords({ inline: true }) : ''}</div>
            </div>`;
    }

    withdrawalRecordLabel(record) {
        if (['closed', 'closed_unconfirmed'].includes(record.phase)) {
            return record.payoutVerified === true ? 'Returned' : 'Balance closed';
        }
        if (record.backgroundPreparationCancelable) return 'Preparation incomplete';
        if (record.mode === 'escape' && record.chainStatus === 'active'
            && (record.finalizeTransactionHash || record.finalizeSubmissionId)) {
            return 'Escape challenged';
        }
        if (record.startSubmissionId) return record.startSubmissionOutcome === 'ambiguous'
            ? 'Status unknown' : 'Waiting for MetaMask';
        if (record.phase === 'submitted_unconfirmed') return 'Transaction · checking';
        if (record.phase === 'recovery_unconfirmed') return 'Checking balance';
        if (record.phase === 'challenged_unconfirmed') return record.mode === 'escape'
            ? 'Challenge · confirming' : 'Checking balance';
        if (record.finalizeTransactionHash) return 'Transaction submitted';
        if (record.finalizeSubmissionId && record.phase === 'ambiguous') return 'Status unknown';
        if (record.finalizeSubmissionId) return 'Waiting for MetaMask';
        if (record.phase === 'restored') return 'Balance restored';
        if (record.phase === 'parked') return 'Ready to withdraw';
        if (record.phase === 'finalizing') return 'Transaction submitted';
        if (record.phase === 'awaiting_wallet') return 'Waiting for MetaMask';
        if (record.phase === 'ambiguous') return 'Status unknown';
        const deadline = Number(record.challengeDeadline || 0);
        if (!deadline) return 'Checking status';
        return deadline && Date.now() >= deadline * 1000
            ? 'Ready to finalize'
            : `Ready in ${zkapiClient.formatExpiry(deadline)}`;
    }

    finalizationReplacementAvailable(record) {
        if (record.phase !== 'finalizing'
            || record.chainStatus !== 'pending_withdrawal'
            || !['receipt_missing', 'replacement_result_unknown']
                .includes(record.finalizeSubmissionOutcome)
            || record.finalizeSubmissionId) return false;
        const hashes = new Set((Array.isArray(record.finalizeTransactionHashes)
            ? record.finalizeTransactionHashes
            : record.finalizeTransactionHash ? [record.finalizeTransactionHash] : [])
            .map(hash => String(hash).toLowerCase()));
        const identities = new Set((record.finalizeAttempts || [])
            .filter(attempt => hashes.has(String(attempt.hash || '').toLowerCase())
                && /^0x[0-9a-fA-F]{40}$/.test(attempt.from || '')
                && Number.isSafeInteger(Number(attempt.nonce))
                && Number(attempt.nonce) >= 0)
            .map(attempt => `${attempt.from.toLowerCase()}:${Number(attempt.nonce)}`));
        return hashes.size > 0 && identities.size === 1;
    }

    withdrawalTransactionUrl(record) {
        // An escape's initial transaction starts its wait; it is not the payout.
        const hash = record.mode === 'escape'
            ? record.finalizeTransactionHash
            : record.transactionHash;
        return this.paymentTransactionUrl(hash);
    }

    paymentTransactionUrl(hash) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) return null;
        const chainId = Number(zkapiClient.config?.funding?.chain_id);
        const origin = chainId === 1 ? 'https://etherscan.io'
            : chainId === 11155111 ? 'https://sepolia.etherscan.io' : null;
        return origin ? `${origin}/tx/${hash}` : null;
    }

    paymentDate(timestamp) {
        if (!Number.isFinite(Number(timestamp)) || Number(timestamp) <= 0) return 'Date unavailable';
        const date = new Date(Number(timestamp));
        return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        });
    }

    renderDepositRecord(record) {
        const confirmed = record.status === 'confirmed';
        const status = confirmed ? 'Added' : record.status === 'failed' ? 'Failed'
            : record.pendingPhase === 'awaiting_wallet' ? 'Waiting for MetaMask'
            : record.pendingPhase === 'ambiguous' ? 'Status unknown'
            : record.pendingPhase === 'dropped_or_pending' ? 'Check transaction' : 'Pending';
        const transactionUrl = this.paymentTransactionUrl(record.transactionHash);
        const currentDeposit = !confirmed && record.operationId
            && record.operationId === zkapiClient.config?.pending_deposit?.operation_id;
        return `
            <section class="rounded-lg border border-border bg-muted/20 p-3" data-deposit-record="${this.escapeHtml(record.recordId)}">
                <div class="flex items-start justify-between gap-3">
                    <div>
                        <p class="text-xs font-medium text-foreground">Deposit</p>
                        <p class="mt-0.5 text-[11px] text-muted-foreground">${confirmed ? '+' : ''}${zkapiClient.formatMoney(record.amount)}${confirmed ? ' added to private balance' : ''}</p>
                        <p class="mt-1 text-[11px] text-muted-foreground">${this.escapeHtml(this.paymentDate(record.confirmedAt || record.createdAt))}</p>
                    </div>
                    <span class="rounded-full ${confirmed ? 'badge-status-success' : 'bg-muted text-muted-foreground'} px-2 py-1 text-[10px]">${status}</span>
                </div>
                ${transactionUrl ? `<a class="mt-2 inline-flex text-[11px] text-muted-foreground underline underline-offset-2" href="${this.escapeHtml(transactionUrl)}" target="_blank" rel="noopener noreferrer">View transaction</a>` : ''}
                ${currentDeposit ? `<button data-view-current-deposit class="zkapi-secondary-button mt-3 w-full" type="button" ${this.busy ? 'disabled' : ''}>View deposit</button>` : ''}
            </section>`;
    }

    expiryHistorySignature() {
        return zkapiClient.expiryHistory.map(record => `${record.recordId}:${record.status}`).join('|');
    }

    hasVerifiedExpiryClaim(record, expiries = zkapiClient.expiryHistory) {
        const noteId = record.noteId ?? record.note_id;
        return typeof record.deploymentId === 'string' && record.deploymentId.length > 0
            && Number.isSafeInteger(noteId) && expiries.some(expiry => expiry.status === 'claimed'
                && expiry.deploymentId === record.deploymentId && expiry.noteId === noteId);
    }

    renderExpiryRecord(record) {
        const claimed = record.status === 'claimed';
        const transactionUrl = claimed ? this.paymentTransactionUrl(record.transactionHash) : null;
        return `<section class="rounded-lg border border-border bg-muted/20 p-3" data-expiry-record="${this.escapeHtml(record.recordId)}">
            <div class="flex items-start justify-between gap-3">
                <div><p class="text-xs font-medium text-foreground">${claimed ? 'Expiry claim' : 'Expiry deadline passed'}</p>
                    <p class="mt-1 text-[11px] text-muted-foreground">${claimed
                        ? `${zkapiClient.formatMoney(record.amount)} from the original deposit was paid to the service treasury. No refund was made.`
                        : 'No automatic refund. A treasury claim has not been confirmed here.'}</p>
                    <p class="mt-1 text-[11px] text-muted-foreground">${this.escapeHtml(this.paymentDate(record.claimedAt || record.createdAt))}</p>
                </div><span class="rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">${claimed ? 'Claimed' : 'Check status'}</span>
            </div>
            ${transactionUrl ? `<a class="mt-2 inline-flex text-[11px] text-muted-foreground underline underline-offset-2" href="${this.escapeHtml(transactionUrl)}" target="_blank" rel="noopener noreferrer">View transaction</a>` : ''}
        </section>`;
    }

    backgroundStartReplacementAvailable(record) {
        if (record.phase !== 'submitted_unconfirmed'
            || record.chainStatus !== 'active'
            || record.startRecoveryPending !== true) return false;
        if (record.startSubmissionId) {
            return /^0x[0-9a-fA-F]{40}$/.test(record.startSubmissionFrom || '')
                && Number.isSafeInteger(Number(record.startSubmissionNonce))
                && Number(record.startSubmissionNonce) >= 0;
        }
        if (/^0x[0-9a-fA-F]{40}$/.test(record.startRetryFrom || '')
            && Number.isSafeInteger(Number(record.startRetryNonce))
            && Number(record.startRetryNonce) >= 0) return true;
        if (!['receipt_missing', 'replacement_result_unknown']
            .includes(record.startSubmissionOutcome)) return false;
        const hashes = new Set((Array.isArray(record.startReplacementTransactionHashes)
            ? record.startReplacementTransactionHashes
            : [])
            .map(hash => String(hash).toLowerCase()));
        const identities = new Set((record.transactionAttempts || [])
            .filter(attempt => hashes.has(String(attempt.hash || '').toLowerCase())
                && /^0x[0-9a-fA-F]{40}$/.test(attempt.from || '')
                && Number.isSafeInteger(Number(attempt.nonce))
                && Number(attempt.nonce) >= 0)
            .map(attempt => `${attempt.from.toLowerCase()}:${Number(attempt.nonce)}`));
        return hashes.size > 0 && identities.size === 1;
    }

    renderWithdrawalRecords({ inline = false } = {}) {
        const deposits = zkapiClient.deposits || [];
        const expiries = zkapiClient.expiryHistory;
        const records = zkapiClient.withdrawals.filter(record => !this.hasVerifiedExpiryClaim(record, expiries));
        this.renderedExpiryHistorySignature = this.expiryHistorySignature();
        const lateAttempts = zkapiClient.unresolvedLateWithdrawals;
        if (!records.length && !lateAttempts.length && !deposits.length) {
            return `<div class="zkapi-stack"><p class="text-sm text-muted-foreground">Your deposits and withdrawals will appear here.</p>${inline ? '' : '<button id="zkapi-back-balance-btn" class="zkapi-secondary-button w-full" type="button">Back to balance</button>'}</div>`;
        }
        const payments = [...deposits.map(record => ({ type: 'deposit', record })),
            ...expiries.map(record => ({ type: 'expiry', record })),
            ...records.map(record => ({ type: 'withdrawal', record }))];
        const timestamp = ({ record }) => Number(record.confirmedAt || record.createdAt || record.updatedAt || 0);
        payments.sort((left, right) => timestamp(right) - timestamp(left));
        const hasSelectedNote = Boolean(zkapiClient.note);
        const hasPendingDeposit = Boolean(zkapiClient.config?.pending_deposit);
        const hasPendingReturn = lateAttempts.length > 0
            || records.some(record => !['closed', 'closed_unconfirmed'].includes(record.phase));
        return `
            <div class="p-5 space-y-3">
                ${expiries.some(record => record.status === 'expired') ? `<button id="zkapi-check-expiry-payments-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Check expiry payments</button>` : ''}
                ${hasPendingReturn ? (hasSelectedNote ? '<p class="text-xs text-muted-foreground">These withdrawals run separately from your current private balance, so you can keep chatting normally.</p>' : '<p class="text-xs text-muted-foreground">You can add a new private balance while a return is pending.</p>') : ''}
                <div class="space-y-2">
                    ${lateAttempts.map(attempt => {
                        const needsAttention = Boolean(attempt.error)
                            || attempt.status === 'receipt_mismatch';
                        return `
                        <section class="rounded-lg border border-blue-300/50 bg-blue-50/40 p-3 dark:border-blue-500/20 dark:bg-blue-500/5">
                            <div class="flex items-start justify-between gap-3">
                                <div>
                                    <p class="text-xs font-medium text-foreground">Submitted withdrawal</p>
                                    <p class="mt-0.5 text-[11px] ${needsAttention ? 'text-destructive' : 'text-muted-foreground'}">${this.escapeHtml(needsAttention
                                        ? attempt.error || 'The saved receipt did not match this withdrawal.'
                                        : 'Saved from a wallet window in another tab')}</p>
                                </div>
                                <span class="rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">${needsAttention ? 'Needs attention' : 'Checking'}</span>
                            </div>
                            <button data-sync-late-withdrawal="${this.escapeHtml(attempt.transaction_hash)}" class="zkapi-primary-button mt-3 w-full" type="button" ${this.busy ? 'disabled' : ''}>Check transaction</button>
                        </section>`;
                    }).join('')}
                    ${payments.map(({ type, record }) => {
                        if (type === 'deposit') return this.renderDepositRecord(record);
                        if (type === 'expiry') return this.renderExpiryRecord(record);
                        const deadline = Number(record.challengeDeadline || 0);
                        const ready = deadline > 0 && Date.now() >= deadline * 1000;
                        const closed = ['closed', 'closed_unconfirmed'].includes(record.phase);
                        const returned = closed && record.payoutVerified === true;
                        const open = !closed;
                        const transactionUrl = this.withdrawalTransactionUrl(record);
                        const withdrawalOnly = record.mode === 'mutual'
                            || record.clearanceReserved === true;
                        const unresolvedFinalization = Boolean(record.finalizeTransactionHash
                            || record.finalizeSubmissionId);
                        const backgroundReady = record.mode === 'mutual'
                            && ['parked', 'restored'].includes(record.phase)
                            && !unresolvedFinalization && !record.startSubmissionId
                            && record.startRecoveryPending !== true
                            && record.backgroundWithdrawalReady !== false
                            && !record.transactionHash && !record.transactionHashes?.length
                            && !record.transactionAttempts?.length && !record.resolvedStartClaims?.length
                            && !record.startResolutionBlock;
                        const parkedNeedsCheck = record.mode === 'mutual' && !backgroundReady
                            && ['parked', 'restored'].includes(record.phase);
                        const challengedFinalization = record.mode === 'escape' && record.chainStatus === 'active'
                            && unresolvedFinalization;
                        const finalizationReplacement = this.finalizationReplacementAvailable(record);
                        const backgroundStartReplacement = this
                            .backgroundStartReplacementAvailable(record);
                        const progressLabel = this.backgroundProgressLabel(record.recordId);
                        return `
                            <section class="rounded-lg border border-border bg-muted/20 p-3" data-withdrawal-record="${this.escapeHtml(record.recordId)}">
                                <div class="flex items-start justify-between gap-3">
                                    <div>
                                        <p class="text-xs font-medium text-foreground">${closed && !returned ? 'Balance closed' : `Withdrawal · ${record.mode === 'escape' ? 'Escape hatch' : 'Mutual close'}`}</p>
                                        <p class="mt-0.5 text-[11px] text-muted-foreground">${closed && !returned ? 'Payment not verified' : `${zkapiClient.formatMoney(record.finalBalance)} ${returned ? 'returned to' : ['parked', 'restored'].includes(record.phase) ? 'set aside · to' : '· to'} ${record.destination ? zkapiClient.compact(record.destination, 6) : 'your saved destination'}`}</p>
                                        <p class="mt-1 text-[11px] text-muted-foreground">${this.escapeHtml(this.paymentDate(record.createdAt))}</p>
                                    </div>
                                    <span class="rounded-full ${returned ? 'badge-status-success' : 'bg-muted text-muted-foreground'} px-2 py-1 text-[10px]" ${record.mode === 'escape' && open && deadline && record.phase === 'pending' ? `data-zkapi-withdrawal-countdown="${deadline}" data-record-id="${this.escapeHtml(record.recordId)}" data-record-phase="pending"` : ''}>${progressLabel ? '<span class="mr-1 inline-block size-2 rounded-full bg-current animate-pulse motion-reduce:animate-none" aria-hidden="true"></span>' : ''}<span data-background-progress="${this.escapeHtml(record.recordId)}" ${progressLabel ? 'role="status"' : ''}>${this.escapeHtml(progressLabel || (parkedNeedsCheck ? 'Checking balance' : this.withdrawalRecordLabel(record)))}</span></span>
                                </div>
                                ${returned && record.phase === 'closed_unconfirmed' ? '<p class="mt-2 text-[11px] text-muted-foreground">Funds are in your wallet. Network confirmation continues automatically; no action is needed.</p>' : ''}
                                ${closed && transactionUrl ? `<a class="mt-2 inline-flex text-[11px] text-muted-foreground underline underline-offset-2" href="${this.escapeHtml(transactionUrl)}" target="_blank" rel="noopener noreferrer">View transaction</a>` : ''}
                                ${record.phase === 'submitted_unconfirmed' ? '<p class="mt-2 text-[11px] text-muted-foreground">This withdrawal is being checked in the background. Your current balance is unchanged.</p>' : ['challenged_unconfirmed', 'recovery_unconfirmed'].includes(record.phase) ? `<p class="mt-2 text-[11px] text-muted-foreground">${record.mode === 'escape' ? 'The challenge is being confirmed in the background.' : 'Checking the previous withdrawal’s on-chain status.'} Your current balance is unchanged.</p>` : challengedFinalization ? '<p class="mt-2 text-[11px] text-muted-foreground">The escape was challenged. Do not retry finalization. Check any submitted transaction, or close the old MetaMask prompt before restoring this balance.</p>' : record.error ? `<p class="mt-2 text-[11px] text-destructive">${this.escapeHtml(record.error)}</p>` : ''}
                                ${open ? `<div class="mt-3 flex gap-2">
                                    ${record.mode === 'escape' && record.phase === 'pending' ? `<button data-finalize-withdrawal="${this.escapeHtml(record.recordId)}" class="zkapi-primary-button flex-1" type="button" ${!ready || this.busy ? 'disabled' : ''}>${ready ? 'Finalize' : `Ready in ${zkapiClient.formatExpiry(deadline)}`}</button>` : ''}
                                    ${parkedNeedsCheck || (record.mode === 'escape' && (unresolvedFinalization || ['finalizing', 'awaiting_wallet', 'ambiguous'].includes(record.phase))) || ['submitted_unconfirmed', 'challenged_unconfirmed', 'recovery_unconfirmed', 'closed_unconfirmed'].includes(record.phase) ? `<button data-sync-withdrawal="${this.escapeHtml(record.recordId)}" class="zkapi-primary-button flex-1" type="button" ${this.busy ? 'disabled' : ''}>Check status</button>` : ''}
                                    ${record.mode === 'escape' && record.phase === 'awaiting_wallet' && !challengedFinalization ? `<button data-recover-finalization="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button flex-1" type="button" ${this.busy ? 'disabled' : ''}>Prompt closed</button>` : ''}
                                    ${record.mode === 'escape' && record.phase === 'ambiguous' && !challengedFinalization ? `<button data-retry-finalization="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button flex-1" type="button" ${this.busy ? 'disabled' : ''}>Retry transaction</button>` : ''}
                                    ${record.mode === 'escape' && finalizationReplacement && !challengedFinalization ? `<button data-retry-dropped-finalization="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button flex-1" type="button" ${this.busy ? 'disabled' : ''}>Replace transaction</button>` : ''}
                                    ${backgroundStartReplacement ? `<button data-retry-dropped-background-withdrawal="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button flex-1" type="button" ${this.busy ? 'disabled' : ''}>Replace transaction</button>` : ''}
                                    ${record.backgroundPreparationCancelable ? `<button data-cancel-background-preparation="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button flex-1" type="button" ${this.busy ? 'disabled' : ''}>Cancel preparation</button>` : ''}
                                    ${record.mode === 'escape' && challengedFinalization && record.finalizeSubmissionId && !record.finalizeTransactionHash ? `<button data-resolve-challenged-finalization="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button flex-1" type="button" ${this.busy ? 'disabled' : ''}>I closed MetaMask</button>` : ''}
                                    ${backgroundReady ? `<button data-withdraw-background="${this.escapeHtml(record.recordId)}" class="zkapi-primary-button flex-1" type="button" ${this.busy ? 'disabled' : ''}>Withdraw ${zkapiClient.formatMoney(record.finalBalance)}</button>` : record.mode !== 'mutual' && ['restored', 'parked'].includes(record.phase) && !unresolvedFinalization ? `<button data-restore-withdrawal="${this.escapeHtml(record.recordId)}" data-withdrawal-only="${withdrawalOnly}" class="zkapi-primary-button flex-1" type="button" ${hasSelectedNote || hasPendingDeposit || this.busy ? 'disabled' : ''}>${withdrawalOnly ? 'Finish withdrawal' : 'Use this balance'}</button>` : ''}
                                </div>` : ''}
                            </section>`;
                    }).join('')}
                </div>
                ${hasPendingReturn ? `<button id="zkapi-sync-all-withdrawals-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Check on-chain status</button>` : ''}
                ${!hasSelectedNote && hasPendingDeposit ? '<button id="zkapi-add-new-balance-btn" class="zkapi-secondary-button w-full" type="button">View current deposit</button>' : ''}
                ${inline ? '' : `<button id="zkapi-back-balance-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Back to balance</button>`}
            </div>`;
    }

    renderBalance(fundingSetup = null) {
        const note = zkapiClient.note;
        const pendingDeposit = zkapiClient.config?.pending_deposit;
        if (!note) {
            if (pendingDeposit && ['submitted', 'dropped_or_pending', 'awaiting_wallet', 'ambiguous'].includes(pendingDeposit.phase)) {
                const title = pendingDeposit.phase === 'submitted'
                    ? 'Deposit submitted'
                    : pendingDeposit.phase === 'dropped_or_pending'
                        ? 'Deposit transaction not found'
                    : pendingDeposit.phase === 'awaiting_wallet'
                        ? 'Waiting for MetaMask'
                        : 'Deposit status unknown';
                return `
                    <div class="zkapi-stack">
                        <div class="rounded-lg border border-blue-300/60 bg-blue-50/60 p-4 dark:border-blue-500/30 dark:bg-blue-500/10">
                            <div class="flex items-center justify-between gap-3">
                                <p class="text-sm font-medium text-foreground">${title}</p>
                                <span class="rounded-full bg-blue-600 px-2 py-1 text-[10px] font-semibold text-white">${zkapiClient.formatMoney(pendingDeposit.amount)}</span>
                            </div>
                            <p class="mt-2 text-xs text-muted-foreground">Your private note is saved in this browser.</p>
                        </div>
                        <button id="zkapi-check-deposit-btn" class="zkapi-primary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Check deposit</button>
                        ${pendingDeposit.phase === 'dropped_or_pending' && pendingDeposit.replacement_available ? `<button id="zkapi-retry-dropped-deposit-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Replace transaction</button>` : ''}
                        ${pendingDeposit.phase === 'awaiting_wallet' ? `<button id="zkapi-recover-deposit-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>MetaMask prompt was closed</button>` : ''}
                        ${pendingDeposit.phase === 'ambiguous' ? `<button id="zkapi-retry-deposit-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Retry same deposit</button>` : ''}
                        ${this.renderWithdrawalStatusLink()}
                    </div>`;
            }
            const resumingDeposit = pendingDeposit
                && ['prepared', 'retry_exact'].includes(pendingDeposit.phase);
            const depositAmount = resumingDeposit
                ? zkapiClient.formatBillingAmount(pendingDeposit.amount)
                : this.depositAmount
                    ?? zkapiClient.suggestedDeposit.toFixed(zkapiClient.suggestedDeposit < 0.01 ? 6 : 2);
            const mainnet = zkapiClient.isMainnetFunding;
            const demoMintEnabled = zkapiClient.config?.funding?.demo_mint_enabled;
            const helper = mainnet
                ? 'USDC on Ethereum · ETH in the same account covers the fee'
                : demoMintEnabled
                    ? 'Sepolia testnet · demo billing tokens are provided when needed'
                    : 'Install MetaMask to get started';
            return `
                <div class="zkapi-stack">
                    ${resumingDeposit ? '<p class="zkapi-lede">Private deposit ready to resume. No funds moved when the earlier MetaMask prompt closed; the same saved private note will be reused.</p>' : ''}
                    <section class="zkapi-section zkapi-deposit" aria-label="Add funds">
                        <label class="zkapi-balance-caption" for="zkapi-deposit-amount">${resumingDeposit ? 'Saved deposit' : 'Deposit'}</label>
                        <div class="zkapi-figure"><span aria-hidden="true">$</span><input id="zkapi-deposit-amount" inputmode="decimal" aria-label="Deposit amount" size="4" value="${this.escapeHtml(depositAmount)}" ${resumingDeposit ? 'readonly' : ''} /></div>
                        <p class="zkapi-helper">${helper}</p>
                        <div class="zkapi-actions">
                            <button id="zkapi-deposit-btn" class="zkapi-primary-button" type="button" ${this.busy ? 'disabled' : ''}>
                                ${this.busy ? 'Waiting for MetaMask…' : resumingDeposit ? 'Resume deposit with MetaMask' : 'Continue with MetaMask'}
                            </button>
                        </div>
                    </section>
                    <div class="zkapi-guides">
                        ${fundingSetupGuide({ mainnet, demoMintEnabled, open: fundingSetup?.open })}
                        ${this.renderWithdrawalStatusLink()}
                    </div>
                </div>`;
        }

        const claimed = Boolean(zkapiClient.noteExpiryClaim);
        const expired = privateBalanceExpired(note);
        const spent = Math.max(0, Number(note.deposit_amount) - Number(note.current_balance));
        const percent = claimed ? 0 : this.progressPercent(note);
        return `
            <div class="zkapi-stack">
                <div class="zkapi-balance-card">
                    <div class="zkapi-balance-top">
                        <div>
                            <p class="zkapi-balance-caption">Available</p>
                            <p class="zkapi-balance-amount">${zkapiClient.formatMoney(claimed ? 0 : note.current_balance)}</p>
                        </div>
                        <span ${!claimed && !zkapiClient.withdrawalBlocksChat ? 'data-private-balance-readiness' : ''} class="zkapi-pill ${claimed ? 'bg-muted text-muted-foreground' : zkapiClient.withdrawalBlocksChat || expired ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200' : 'badge-status-success'}">${claimed ? 'claimed' : zkapiClient.withdrawalBlocksChat ? (['submitted', 'late_submitted'].includes(zkapiClient.activeWithdrawal?.phase) ? 'Submitted' : 'Needs attention') : expired ? 'expired' : 'ready'}</span>
                    </div>
                    <div class="zkapi-bar"><div class="zkapi-bar-fill" style="width:${percent}%"></div></div>
                    <div class="zkapi-balance-foot"><span>${claimed ? 'Claimed after expiry' : `${zkapiClient.formatMoney(spent)} used of ${zkapiClient.formatMoney(note.deposit_amount)}`}</span><span class="inline-flex items-center gap-1"><span data-zkapi-balance-expiry>${privateBalanceExpiryLabel(zkapiClient, note.expiry_ts)}</span>${privateBalanceHelpButton('modal', 'expiry', this.privateBalanceHelpOpen?.expiry)}</span></div>
                    ${privateBalanceHelpContent('modal', 'expiry', this.privateBalanceHelpOpen?.expiry)}
                </div>
                ${claimed ? '<p class="zkapi-helper">After expiry, the original deposit was paid to the service treasury. No refund was made.</p>' : `<div data-private-balance-expired-notice ${expired ? '' : 'hidden'}><p class="rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-xs leading-relaxed text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">This private balance has expired. You can still try withdrawing while it remains unclaimed.</p></div>`}
                ${!claimed && zkapiClient.withdrawalBlocksChat ? `<div class="rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">${['submitted', 'late_submitted'].includes(zkapiClient.activeWithdrawal?.phase) ? 'Your withdrawal transaction was submitted. Check its status before using this balance.' : zkapiClient.activeWithdrawal?.phase === 'dropped_or_pending' ? 'The saved transaction has no receipt yet. Open Withdraw to check or safely resubmit it with the same nonce.' : zkapiClient.activeWithdrawal?.phase === 'awaiting_wallet' ? 'MetaMask may still be open. Open Withdraw to check or recover the prompt.' : zkapiClient.activeWithdrawal?.phase === 'ambiguous' ? 'MetaMask did not return a transaction ID. Open Withdraw to check the vault or retry.' : 'No transaction is moving. This balance is ready to finish withdrawing.'}</div>` : ''}
                <div class="zkapi-actions">
                    ${claimed ? '' : `<button id="zkapi-withdraw-view-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Withdraw</button>`}
                    <button id="zkapi-refresh-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Refresh</button>
                    ${claimed ? `<button id="zkapi-archive-expired-balance-btn" class="zkapi-primary-button" type="button" ${this.busy ? 'disabled' : ''}>Start a new balance</button>` : ''}
                    ${zkapiClient.config?.funding?.demo_mint_enabled ? `<button id="zkapi-mint-token-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Get 10 test ZKAPI</button>` : ''}
                </div>
                <div class="zkapi-guides">${this.renderWithdrawalStatusLink()}</div>
            </div>`;
    }

    shouldShowClaimedBalance() {
        if (!zkapiClient.noteExpiryClaim || this.busy) return false;
        const prepared = zkapiClient.config?.prepared_withdrawal;
        return !zkapiClient.activeLateWithdrawal && !prepared?.transaction_hash
            && !['submitted', 'dropped_or_pending', 'awaiting_wallet', 'ambiguous'].includes(prepared?.phase);
    }

    renderWithdrawal() {
        if (this.shouldShowClaimedBalance()) return this.renderBalance();
        if (zkapiClient.noteExpiryClaim) {
            const awaitingWallet = zkapiClient.config?.prepared_withdrawal?.phase === 'awaiting_wallet';
            return `<div class="zkapi-stack">
                <p class="rounded-lg border border-border bg-muted/5 p-3 text-xs leading-relaxed text-muted-foreground">This balance was claimed after expiry. No refund was made. You can still check the earlier withdrawal request.</p>
                <button id="zkapi-sync-withdrawal-btn" class="zkapi-primary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Check transaction</button>
                ${awaitingWallet ? `<button id="zkapi-recover-withdrawal-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>MetaMask prompt was closed</button>` : ''}
                <button id="zkapi-back-balance-btn" class="zkapi-quiet-button" type="button" ${this.busy ? 'disabled' : ''}>Back to balance</button>
            </div>`;
        }
        const note = zkapiClient.note;
        const withdrawal = zkapiClient.withdrawal;
        const prepared = zkapiClient.config?.prepared_withdrawal;
        const lateWithdrawal = zkapiClient.activeLateWithdrawal;
        if (!note && withdrawal?.phase !== 'pending') {
            return zkapiClient.withdrawals.length
                ? this.renderWithdrawalRecords()
                : '<div class="p-5 text-sm text-muted-foreground">There is no active private note to withdraw.</div>';
        }

        if (lateWithdrawal) {
            const needsAttention = Boolean(lateWithdrawal.error)
                || lateWithdrawal.status === 'receipt_mismatch';
            return `
                <div class="zkapi-stack">
                    <div class="rounded-lg border ${needsAttention ? 'border-amber-300/60 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10' : 'border-blue-300/60 bg-blue-50/60 dark:border-blue-500/30 dark:bg-blue-500/10'} p-4">
                        <div class="flex items-center justify-between gap-3">
                            <p class="text-sm font-medium text-foreground">${needsAttention ? 'Withdrawal needs attention' : 'Checking submitted withdrawal'}</p>
                            <span class="rounded-full ${needsAttention ? 'bg-amber-600' : 'bg-blue-600'} px-2 py-1 text-[10px] font-semibold text-white">${needsAttention ? 'Check required' : 'Recovering'}</span>
                        </div>
                        <p class="mt-2 text-xs ${needsAttention ? 'text-amber-900 dark:text-amber-100' : 'text-muted-foreground'}">${this.escapeHtml(needsAttention
                            ? lateWithdrawal.error || 'The saved receipt did not match this withdrawal. Recheck the canonical vault state.'
                            : 'A MetaMask window returned after this tab changed state. OA Chat saved the transaction and paused only this balance until the chain confirms what happened.')}</p>
                    </div>
                    <button id="zkapi-sync-withdrawal-btn" class="zkapi-primary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>${needsAttention ? 'Recheck vault state' : 'Check transaction'}</button>
                    <button id="zkapi-back-balance-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Back to balance</button>
                </div>`;
        }

        if (withdrawal?.phase === 'pending') {
            const deadline = Number(withdrawal.challengeDeadline || 0);
            const ready = deadline > 0 && Date.now() >= deadline * 1000;
            return `
                <div class="zkapi-stack">
                    <div class="rounded-lg border border-blue-300/60 bg-blue-50/60 p-4 dark:border-blue-500/30 dark:bg-blue-500/10">
                        <div class="flex items-center justify-between gap-3">
                            <p class="text-sm font-medium text-foreground">Escape hatch pending</p>
                            <span class="rounded-full bg-blue-600 px-2 py-1 text-[10px] font-semibold text-white">${zkapiClient.escapePeriodBadge()}</span>
                        </div>
                        <p class="mt-2 text-xs leading-relaxed text-muted-foreground">Your note is frozen. <span data-zkapi-escape-countdown>${ready ? 'The safety window is complete.' : `Finalize in ${zkapiClient.formatExpiry(deadline)}.`}</span></p>
                    </div>
                    <dl class="zkapi-details">
                        <div><dt>Destination</dt><dd>${zkapiClient.compact(withdrawal.destination, 9)}</dd></div>
                        <div><dt>Ready</dt><dd>${deadline ? new Date(deadline * 1000).toLocaleString() : 'Checking…'}</dd></div>
                    </dl>
                    <button id="zkapi-finalize-btn" class="zkapi-primary-button w-full" type="button" ${!ready || this.busy ? 'disabled' : ''}>${ready ? 'Finalize in MetaMask' : `Finalize in ${zkapiClient.formatExpiry(deadline)}`}</button>
                    <button id="zkapi-sync-withdrawal-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Check on-chain status</button>
                </div>`;
        }

        const activeLease = zkapiClient.activeLease;
        const preparedMode = prepared?.mode;
        const droppedOrPending = prepared?.phase === 'dropped_or_pending';
        const submitted = !droppedOrPending
            && (prepared?.phase === 'submitted' || Boolean(prepared?.transaction_hash));
        const awaitingWallet = prepared?.phase === 'awaiting_wallet';
        const ambiguous = prepared?.phase === 'ambiguous';
        const submissionActive = droppedOrPending || submitted || awaitingWallet || ambiguous;
        const clearanceReserved = prepared?.clearance_reserved === true || preparedMode === 'mutual';
        if (preparedMode === 'escape') this.withdrawMode = 'escape';
        const notice = !prepared ? ''
            : droppedOrPending ? 'No receipt was found for the saved transaction. It may still be pending, or MetaMask may have dropped it. Check again, or resubmit the same withdrawal with its original nonce.'
            : submitted ? 'Transaction submitted. Check the chain before trying again.'
            : awaitingWallet ? 'MetaMask may still be open in this or another tab.'
            : ambiguous ? 'MetaMask did not return a transaction ID. Check the vault before retrying.'
            : clearanceReserved ? 'This balance already has a close authorization. Finish it in MetaMask, or set it aside and add a new balance.'
            : 'The proof is ready; no transaction has been submitted yet.';
        const primaryLabel = this.busy ? 'Waiting for MetaMask…'
            : this.withdrawMode === 'mutual' ? 'Close balance and withdraw' : `Start ${zkapiClient.escapePeriodLabel()} escape`;
        return `
            <div class="zkapi-stack">
                <div class="zkapi-balance-card">
                    <div class="zkapi-balance-top">
                        <div>
                            <p class="zkapi-balance-caption">Amount returned</p>
                            <p data-withdraw-amount class="zkapi-balance-amount">${zkapiClient.formatMoney(note?.current_balance)}</p>
                        </div>
                    </div>
                    ${notice ? `<p class="zkapi-note ${submissionActive || clearanceReserved ? '' : 'zkapi-note--attention'}">${notice}</p>` : ''}
                </div>
                <fieldset class="zkapi-section zkapi-choices" ${this.busy || submissionActive ? 'disabled' : ''}>
                    <legend class="zkapi-section-title">Withdrawal method</legend>
                    <label class="zkapi-choice ${this.withdrawMode === 'mutual' ? 'selected' : ''}">
                        <input type="radio" name="zkapi-withdraw-mode" value="mutual" ${this.withdrawMode === 'mutual' ? 'checked' : ''} ${preparedMode === 'escape' && !clearanceReserved ? 'disabled' : ''} />
                        <span><strong>Mutual close</strong><small>Fastest. The zkAPI server co-signs the close.</small></span>
                    </label>
                    <label class="zkapi-choice ${this.withdrawMode === 'escape' ? 'selected' : ''}">
                        <input type="radio" name="zkapi-withdraw-mode" value="escape" ${this.withdrawMode === 'escape' ? 'checked' : ''} />
                        <span><strong>Escape hatch</strong><small>Unilateral recovery. Start now, wait ${zkapiClient.escapePeriodPhrase()}, then finalize.</small></span>
                    </label>
                </fieldset>
                ${submissionActive ? '' : '<label class="zkapi-check"><input id="zkapi-withdraw-confirm" type="checkbox" /><span>I understand that withdrawing closes this private balance.</span></label>'}
                ${activeLease ? '<p data-active-lease-notice class="zkapi-note">The active chat key will settle automatically before withdrawal.</p>' : ''}
                <div class="zkapi-actions">
                    ${submissionActive
                        ? `<button id="zkapi-sync-withdrawal-btn" class="zkapi-primary-button" type="button" ${this.busy ? 'disabled' : ''}>${this.busy ? 'Checking…' : 'Check transaction'}</button>`
                        : `<button id="zkapi-withdraw-btn" class="zkapi-primary-button" type="button" disabled>${primaryLabel}</button>`}
                    ${droppedOrPending && prepared?.replacement_available ? `<button id="zkapi-retry-dropped-withdrawal-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Resubmit with original nonce</button>` : ''}
                    ${awaitingWallet ? `<button id="zkapi-recover-withdrawal-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>MetaMask prompt was closed</button>` : ''}
                    ${ambiguous ? `<button id="zkapi-retry-withdrawal-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Retry transaction</button>` : ''}
                    ${prepared && !submissionActive && !clearanceReserved ? '<button id="zkapi-cancel-withdrawal-btn" class="zkapi-secondary-button" type="button">Cancel withdrawal</button>' : ''}
                    ${prepared && !submissionActive && clearanceReserved ? '<button id="zkapi-park-withdrawal-btn" class="zkapi-secondary-button" type="button">Set aside and add a new balance</button>' : ''}
                    <button id="zkapi-back-balance-btn" class="zkapi-quiet-button" type="button" ${this.busy ? 'disabled' : ''}>Back to balance</button>
                </div>
            </div>`;
    }

    render() {
        if (!this.overlay) return;
        if (this.view === 'withdraw' && this.shouldShowClaimedBalance()) this.view = 'balance';
        const helpFocus = capturePrivateBalanceHelpFocus(this.overlay);
        const fundingSetup = captureFundingSetupView(this.overlay);
        const showsBalance = !['withdraw', 'withdrawals'].includes(this.view);
        const title = this.view === 'withdraw'
            ? 'Withdraw private balance'
            : this.view === 'withdrawals'
                ? 'Payment history'
                : 'Private balance';
        const subtitle = this.view === 'withdraw'
            ? 'Return the remaining balance to MetaMask'
            : this.view === 'withdrawals'
                ? 'Deposits and withdrawals saved in this browser'
                : 'OA Chat · private prepaid access';
        this.overlay.innerHTML = `
            <div role="dialog" aria-modal="true" aria-labelledby="zkapi-payment-title" class="${MODAL_CLASSES}">
                <div class="zkapi-dialog-head">
                    <h2 id="zkapi-payment-title" class="zkapi-dialog-title">${title}</h2>
                    ${showsBalance ? privateBalanceHelpButton('modal', 'billing', this.privateBalanceHelpOpen?.billing) : ''}
                    <button id="zkapi-payment-close" class="zkapi-dialog-close" type="button" aria-label="Close">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
                    </button>
                </div>
                <div data-funding-scroll class="zkapi-dialog-scroll">
                    ${showsBalance ? '' : `<p class="zkapi-lede">${subtitle}</p>`}
                    ${showsBalance ? privateBalanceHelpContent('modal', 'billing', this.privateBalanceHelpOpen?.billing) : ''}
                    ${this.view === 'withdraw' ? this.renderWithdrawal() : this.view === 'withdrawals' ? this.renderWithdrawalRecords() : this.renderBalance(fundingSetup)}
                </div>
            </div>`;

        attachPrivateBalanceHelp(this.overlay, this);
        restorePrivateBalanceHelpFocus(this.overlay, helpFocus);
        restoreFundingSetupView(this.overlay, fundingSetup);
        this.overlay.querySelector('#zkapi-payment-close')?.addEventListener('click', () => this.close());
        const depositInput = this.overlay.querySelector('#zkapi-deposit-amount');
        // The figure grows with what is typed, like a number, not a field.
        const fitDeposit = () => {
            if (depositInput?.style) depositInput.style.width = `${Math.max(3, String(depositInput.value || '').length + 0.5)}ch`;
        };
        fitDeposit();
        depositInput?.addEventListener('input', () => {
            this.depositAmount = depositInput.value;
            fitDeposit();
        });
        this.overlay.querySelector('#zkapi-deposit-btn')?.addEventListener('click', () => {
            // Capture the edited amount before run() marks the modal busy and
            // re-renders it with the suggested default value.
            const amount = depositInput?.value ?? this.depositAmount;
            this.depositAmount = amount;
            return this.run(async (report) => {
                await zkapiClient.deposit(amount, report);
                this.depositAmount = null;
                this.view = 'balance';
                this.setStatus('Deposit confirmed. Your private balance is ready.');
            }, { kind: 'deposit', title: 'Adding funds', phase: 'wallet', message: 'Connecting to MetaMask…', blocksSend: true });
        });
        this.overlay.querySelector('#zkapi-discard-deposit-btn')?.addEventListener('click', () => this.run(async () => {
            const discard = this.pendingDepositDiscarder();
            if (!discard) throw new Error('This deposit cannot be changed here.');
            await discard();
            // Start from the suggested amount again; the field is editable.
            this.depositAmount = null;
            this.setStatus('Deposit cancelled. Choose an amount to continue.');
        }, { kind: 'deposit', title: 'Cancelling deposit', phase: 'local', message: 'Discarding the saved deposit…', blocksSend: false }));
        this.overlay.querySelector('#zkapi-check-deposit-btn')?.addEventListener('click', () => this.run(async (report) => {
            const result = await zkapiClient.recoverBrowserDeposit(report);
            if (result?.status !== 'confirmed') this.setStatus('The deposit has not appeared on-chain yet.');
        }, { kind: 'deposit', title: 'Checking deposit', phase: 'syncing', blocksSend: true }));
        this.overlay.querySelector('#zkapi-recover-deposit-btn')?.addEventListener('click', () => this.run(async (report) => {
            await zkapiClient.recoverUnknownDeposit(report);
        }, { kind: 'deposit', title: 'Recovering wallet request', phase: 'syncing', blocksSend: true }));
        this.overlay.querySelector('#zkapi-retry-deposit-btn')?.addEventListener('click', () => {
            if (!globalThis.confirm('Only retry if MetaMask is closed and Check deposit still finds no deposit. The exact same vault action will be retried.')) return;
            return this.run(async (report) => {
                await zkapiClient.retryUnknownDeposit(report);
                this.depositAmount = null;
                this.view = 'balance';
                this.setStatus('Deposit confirmed. Your private balance is ready.');
            }, { kind: 'deposit', title: 'Retrying deposit', phase: 'wallet', blocksSend: true });
        });
        this.overlay.querySelector('#zkapi-retry-dropped-deposit-btn')?.addEventListener('click', () => {
            if (!globalThis.confirm('Resubmit the exact same deposit with its original account nonce? MetaMask may charge a replacement gas fee, but only one transaction at that nonce can execute.')) return;
            return this.run(async (report) => {
                await zkapiClient.retryDroppedDeposit(report);
                this.depositAmount = null;
                this.view = 'balance';
                this.setStatus('Deposit confirmed. Your private balance is ready.');
            }, { kind: 'deposit', title: 'Replacing pending deposit', phase: 'wallet', blocksSend: true });
        });
        this.overlay.querySelectorAll('[data-view-current-deposit]').forEach(button => {
            button.addEventListener('click', () => { this.view = 'balance'; this.render(); });
        });
        this.overlay.querySelector('#zkapi-mint-token-btn')?.addEventListener('click', () => this.run(async (report) => {
            await zkapiClient.mintDemoTokens('10', report);
        }, { kind: 'token', title: 'Getting test ZKAPI', phase: 'wallet' }));
        this.overlay.querySelector('#zkapi-refresh-btn')?.addEventListener('click', () => this.run(async (report) => {
            report('Reading the latest private balance…', 'syncing');
            await zkapiClient.refresh();
            await zkapiClient.syncExpiryHistory();
            this.setStatus('Private balance refreshed.');
        }, { kind: 'refresh', title: 'Refreshing balance', phase: 'syncing' }));
        this.overlay.querySelector('#zkapi-check-expiry-payments-btn')?.addEventListener('click', () => this.run(async () => {
            const result = await zkapiClient.syncExpiryHistory();
            this.setStatus(result.complete ? 'Expiry history checked against finalized transactions.'
                : 'Checked part of the expiry history. Check again to continue.');
        }));
        this.overlay.querySelector('#zkapi-archive-expired-balance-btn')?.addEventListener('click', () => this.run(async () => {
            await zkapiClient.archiveClaimedBalance();
            this.view = 'balance';
            this.setStatus('Closed balance archived. Its payment history is preserved.');
        }));
        this.overlay.querySelector('#zkapi-withdraw-view-btn')?.addEventListener('click', () => {
            this.view = 'withdraw';
            this.render();
        });
        this.overlay.querySelector('#zkapi-withdrawal-status-btn')?.addEventListener('click', () => {
            // Opens in place, like Invoices in the Account dialog.
            this.historyOpen = !this.historyOpen;
            this.render();
            this.overlay.querySelector('#zkapi-withdrawal-status-btn')?.focus?.({ preventScroll: true });
        });
        this.overlay.querySelector('#zkapi-back-balance-btn')?.addEventListener('click', () => {
            this.view = 'balance';
            this.render();
        });
        this.overlay.querySelector('#zkapi-add-new-balance-btn')?.addEventListener('click', () => {
            this.view = 'balance';
            this.render();
        });
        this.overlay.querySelectorAll('input[name="zkapi-withdraw-mode"]').forEach(input => {
            input.addEventListener('change', () => {
                this.withdrawMode = input.value;
                this.render();
            });
        });
        const confirm = this.overlay.querySelector('#zkapi-withdraw-confirm');
        const withdrawButton = this.overlay.querySelector('#zkapi-withdraw-btn');
        confirm?.addEventListener('change', () => {
            withdrawButton.disabled = !confirm.checked || this.busy;
        });
        withdrawButton?.addEventListener('click', () => this.run(async (report) => {
            const result = await zkapiClient.withdraw(this.withdrawMode, report);
            if (result.status === 'closed') this.view = 'balance';
            this.setStatus(result.status === 'closed'
                ? `${zkapiClient.formatMoney(result.event.finalBalance)} returned to MetaMask.`
                : `Escape started. Finalize after ${new Date(result.deadline * 1000).toLocaleString()}.`);
        }, {
            kind: this.withdrawMode === 'escape' ? 'escape' : 'withdraw',
            title: this.withdrawMode === 'escape' ? 'Starting account recovery' : 'Returning your balance',
            phase: 'settling',
            blocksSend: true
        }));
        this.overlay.querySelector('#zkapi-cancel-withdrawal-btn')?.addEventListener('click', () => this.run(async (report) => {
            await zkapiClient.cancelPreparedWithdrawal(report);
            this.view = 'balance';
        }, { kind: 'withdraw-sync', title: 'Canceling withdrawal', phase: 'syncing' }));
        this.overlay.querySelector('#zkapi-park-withdrawal-btn')?.addEventListener('click', () => this.run(async (report) => {
            await zkapiClient.parkPreparedWithdrawal(report);
            this.view = 'balance';
        }, { kind: 'withdraw-sync', title: 'Setting balance aside', phase: 'syncing' }));
        this.overlay.querySelector('#zkapi-sync-withdrawal-btn')?.addEventListener('click', () => this.run(async (report) => {
            const result = await zkapiClient.syncWithdrawal(report);
            if ([
                'error',
                'receipt_mismatch',
                'invalid_identity',
                'missing_recovery_state',
                'provider_unavailable'
            ].includes(result?.status)) {
                throw new Error(result.error
                    || 'This withdrawal still needs attention. Recheck the vault state.');
            }
        }, { kind: 'withdraw-sync', title: 'Checking withdrawal', phase: 'syncing', blocksSend: true }));
        this.overlay.querySelector('#zkapi-recover-withdrawal-btn')?.addEventListener('click', () => this.run(async (report) => {
            await zkapiClient.recoverUnknownWithdrawal(report);
        }, { kind: 'withdraw-sync', title: 'Recovering wallet request', phase: 'syncing', blocksSend: true }));
        this.overlay.querySelector('#zkapi-retry-withdrawal-btn')?.addEventListener('click', () => {
            if (!globalThis.confirm('Only retry if MetaMask is closed and Check transaction still shows this balance as active. A previously broadcast transaction could otherwise use gas twice.')) return;
            return this.run(async (report) => {
                const result = await zkapiClient.retryUnknownWithdrawal(report);
                if (result.status === 'closed') this.view = 'balance';
                this.setStatus(result.status === 'closed'
                    ? `${zkapiClient.formatMoney(result.event.finalBalance)} returned to MetaMask.`
                    : `Escape started. Finalize after ${new Date(result.deadline * 1000).toLocaleString()}.`);
            }, { kind: 'withdraw', title: 'Retrying withdrawal', phase: 'wallet', blocksSend: true });
        });
        this.overlay.querySelector('#zkapi-retry-dropped-withdrawal-btn')?.addEventListener('click', () => {
            if (!globalThis.confirm('Resubmit the exact same withdrawal with its original account nonce? MetaMask may charge a replacement gas fee, but only one transaction at that nonce can execute.')) return;
            return this.run(async (report) => {
                const result = await zkapiClient.retryDroppedWithdrawal(report);
                if (result?.status === 'closed') this.view = 'balance';
            }, {
                kind: 'withdraw',
                title: 'Replacing pending withdrawal',
                phase: 'wallet',
                blocksSend: true
            });
        });
        this.overlay.querySelector('#zkapi-sync-all-withdrawals-btn')?.addEventListener('click', () => this.run(async (report) => {
            const late = await zkapiClient.syncLateWithdrawalAttempts(report);
            const background = await zkapiClient.syncEscapeWithdrawals(report);
            const needsAttention = [...late, ...background].find(entry => [
                'error',
                'receipt_mismatch',
                'invalid_identity',
                'missing_recovery_state'
            ].includes(entry.status));
            if (needsAttention) {
                throw new Error(needsAttention.error
                    || 'A withdrawal still needs attention. Open its details and recheck the vault state.');
            }
            report('Withdrawal status is up to date.');
        }, { kind: 'withdraw-sync', title: 'Checking withdrawals', phase: 'syncing' }));
        this.overlay.querySelectorAll('[data-sync-late-withdrawal]').forEach(button => {
            button.addEventListener('click', () => this.run(async (report) => {
                const results = await zkapiClient.syncLateWithdrawalAttempts(report);
                const needsAttention = results.find(entry => [
                    'error',
                    'receipt_mismatch',
                    'invalid_identity',
                    'missing_recovery_state'
                ].includes(entry.status));
                if (needsAttention) {
                    throw new Error(needsAttention.error
                        || 'This withdrawal still needs attention. Recheck the vault state.');
                }
            }, { kind: 'withdraw-sync', title: 'Checking withdrawal', phase: 'syncing' }));
        });
        this.overlay.querySelector('#zkapi-finalize-btn')?.addEventListener('click', () => this.run(async (report) => {
            const result = await zkapiClient.finalizeEscape(report);
            this.view = 'balance';
            this.setStatus(`${zkapiClient.formatMoney(result.event.finalBalance)} returned to MetaMask.`);
        }, { kind: 'escape-finalize', title: 'Finishing account recovery', phase: 'wallet', blocksSend: true }));
        this.overlay.querySelectorAll('[data-finalize-withdrawal]').forEach(button => {
            button.addEventListener('click', () => this.run(async (report) => {
                const result = await zkapiClient.finalizeEscape(button.dataset.finalizeWithdrawal, report);
                this.setStatus(`${zkapiClient.formatMoney(result.event.finalBalance)} returned to MetaMask.`);
            }, { kind: 'escape-finalize', title: 'Finishing withdrawal', phase: 'wallet' }));
        });
        this.overlay.querySelectorAll('[data-sync-withdrawal]').forEach(button => {
            button.addEventListener('click', () => this.run(async (report) => {
                await zkapiClient.syncEscapeWithdrawals(report, button.dataset.syncWithdrawal);
            }, { kind: 'withdraw-sync', title: 'Checking withdrawal', phase: 'syncing' }));
        });
        this.overlay.querySelectorAll('[data-recover-finalization]').forEach(button => {
            button.addEventListener('click', () => this.run(async (report) => {
                await zkapiClient.recoverUnknownFinalization(
                    button.dataset.recoverFinalization,
                    report
                );
            }, { kind: 'withdraw-sync', title: 'Recovering wallet request', phase: 'syncing' }));
        });
        this.overlay.querySelectorAll('[data-resolve-challenged-finalization]').forEach(button => {
            button.addEventListener('click', () => {
                if (!globalThis.confirm('Confirm that the old MetaMask prompt is closed. This only releases the local prompt marker; no transaction will be sent.')) return;
                return this.run(async (report) => {
                    await zkapiClient.resolveChallengedFinalization(
                        button.dataset.resolveChallengedFinalization,
                        report
                    );
                }, { kind: 'withdraw-sync', title: 'Releasing old wallet prompt', phase: 'syncing' });
            });
        });
        this.overlay.querySelectorAll('[data-retry-finalization]').forEach(button => {
            button.addEventListener('click', () => {
                if (!globalThis.confirm('Only retry if MetaMask is closed and Check transaction still shows this escape as pending. A previously broadcast transaction could otherwise use gas twice.')) return;
                return this.run(async (report) => {
                    const result = await zkapiClient.retryUnknownFinalization(
                        button.dataset.retryFinalization,
                        report
                    );
                    this.setStatus(`${zkapiClient.formatMoney(result.event.finalBalance)} returned to MetaMask.`);
                }, { kind: 'escape-finalize', title: 'Retrying finalization', phase: 'wallet' });
            });
        });
        this.overlay.querySelectorAll('[data-retry-dropped-finalization]').forEach(button => {
            button.addEventListener('click', () => {
                if (!globalThis.confirm('Resubmit the exact same finalization with its original account nonce? MetaMask may charge a replacement gas fee, but only one transaction at that nonce can execute.')) return;
                return this.run(async (report) => {
                    const result = await zkapiClient.retryDroppedFinalization(
                        button.dataset.retryDroppedFinalization,
                        report
                    );
                    if (result?.status === 'closed') {
                        this.setStatus('Escape withdrawal returned to MetaMask.');
                    }
                }, { kind: 'escape-finalize', title: 'Replacing finalization', phase: 'wallet' });
            });
        });
        this.overlay.querySelectorAll('[data-retry-dropped-background-withdrawal]').forEach(button => {
            button.addEventListener('click', () => {
                if (!globalThis.confirm('Resubmit this saved background withdrawal with its original account nonce? MetaMask may charge a replacement gas fee, but only one transaction at that nonce can execute.')) return;
                return this.run(async (report) => {
                    await zkapiClient.retryDroppedBackgroundWithdrawal(
                        button.dataset.retryDroppedBackgroundWithdrawal,
                        report
                    );
                }, {
                    kind: 'withdraw',
                    title: 'Replacing background withdrawal',
                    phase: 'wallet'
                });
            });
        });
        this.overlay.querySelectorAll('[data-withdraw-background]').forEach(button => {
            button.addEventListener('click', () => this.run(async (report) => {
                await zkapiClient.withdrawBackground(button.dataset.withdrawBackground, report);
            }, { kind: 'withdraw', title: 'Withdrawing set-aside balance', phase: 'preparing', blocksSend: false,
                withdrawalRecordId: button.dataset.withdrawBackground }));
        });
        this.overlay.querySelectorAll('[data-cancel-background-preparation]').forEach(button => {
            button.addEventListener('click', () => this.run(async report => {
                await zkapiClient.cancelBackgroundWithdrawalPreparation(button.dataset.cancelBackgroundPreparation, report);
            }, { kind: 'withdraw-sync', title: 'Canceling preparation', phase: 'syncing', blocksSend: false }));
        });
        this.overlay.querySelectorAll('[data-restore-withdrawal]').forEach(button => {
            button.addEventListener('click', () => this.run(async (report) => {
                await zkapiClient.restoreWithdrawal(button.dataset.restoreWithdrawal, report);
                this.view = button.dataset.withdrawalOnly === 'true' ? 'withdraw' : 'balance';
            }, { kind: 'withdraw-sync', title: 'Restoring balance', phase: 'syncing' }));
        });
    }
}
