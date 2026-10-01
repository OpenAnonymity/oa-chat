import { revealWithdrawalTopUp } from './WalletModalMotion.js';
import { statusIcon } from './StatusIcon.js';
import { attachWithdrawalFees, needsWithdrawalFees, refreshWithdrawalFees, renderWithdrawalFees, stopWithdrawalFees, withdrawalFeeReady } from './WithdrawalFees.js';
import { fundingDisclosure, attachFundingDisclosures, captureFundingDisclosureView, restoreFundingDisclosureView } from './FundingDisclosures.js';
import { showSurface, hideSurface, revealText, motionDuration } from '../../ui/uiMotion.js';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { settlePrivateAccess } from '../services/privateAccessSettlement.js';
import { availableWithdrawalEscape, sameWithdrawalEscape, assertWithdrawalEscapeAvailable, canCancelPreparedWithdrawal, escapeNeedsSettlement, assertEscapeReady } from '../services/withdrawalRecovery.mjs';
import { ethUnits } from '../services/depositAmount.mjs';
import { depositOperationId, isWalletCancellation, resetCanceledDeposit } from '../services/canceledDeposit.mjs';
import { readWelcomeModalIntent, writeWelcomeModalIntent } from '../services/welcomeModalIntent.mjs';
import { attachWalletModalRestoreCancellation, cancelWalletModalRestore, currentWalletModalRestore, finishWalletModalRestore } from './WalletModalView.js';
import { parseTokenAmount } from '@openanonymity/zkapi-browser-sdk/wallet';
import { walletErrorMessage } from '@openanonymity/zkapi-browser-sdk/wallet-error';
import { explainZkapiError, isIndexerLag, pendingDepositMessage } from '../services/zkapiErrorCopy.mjs';
import { updateZkapiBalanceControl } from './ZkapiStateExperience.js';
import { captureFundingSetupView, fundingSetupGuide, restoreFundingSetupView } from './FundingSetupGuide.js';
import { walletJourney } from '../domain/walletJourney.js';
import { addressFundingWallet } from '../services/addressFundingProvider.mjs';
import { canQuotePendingAddressDeposit, runAddressAction, withdrawalDestination } from '../services/addressFunding.js';
import { getWalletMethod, initWalletClient, initWalletMethod, prepareWalletMethod, setWalletMethod, subscribeWalletMethod, walletMethodText } from '../services/walletMethod.mjs';
import { attachWalletMethodControls, captureWalletView, fundingInstructionsVisible, refreshWalletView, renderDepositAmount, prepareDepositAmount, renderFundingAccount, renderFundingWei, renderWalletMethod, restoreWalletView, stopFundingFlow, isFundingViewHydrating, syncWalletFlows } from './WalletMethodControls.js';
import {
    attachPrivateBalanceHelp, capturePrivateBalanceHelpFocus, privateBalanceExpiryLabel,
    privateBalanceExpired, privateBalanceGuide, privateBalanceHelpButton, privateBalanceHelpContent,
    restorePrivateBalanceHelpFocus, updatePrivateBalanceExpiryState
} from './PrivateBalanceHelp.js';

// The OA dialog frame (Account, Welcome): 560px, 24px radius, 40px inset, no
// header hairline. Sizing and colour live in zkapi.css (.zkapi-dialog).
const MODAL_CLASSES = 'zkapi-dialog';
// Closing the MetaMask prompt is the person's own decision, said once, in
// a short notice identifies the operation without asserting a fund outcome.
const CANCELED_LINE = 'Canceled in MetaMask.';
// A submitted transaction needs nothing from the person: the SDK checks
// the chain every 15 s and on focus, and the dialog re-renders on change.
// The check button stays as a quiet fallback for a slow indexer.
// UI intent only; wallet secrets and transaction recovery remain in the SDK.
const RUNNING_MODAL_KEY = 'oa-zkapi-running-modal';
const RESTORABLE_VIEWS = ['balance', 'fund', 'withdraw', 'withdrawals'];
const IN_MOTION_PHASES = ['submitted', 'awaiting_wallet', 'dropped_or_pending', 'ambiguous'];
const CONFIRMED_REFRESHING_LINE = 'Deposit confirmed and saved. Refreshing your private balance…';
const DEPOSIT_READY_LINE = 'Deposit confirmed. Your private balance is ready.';
const CONFIRMING_LINE = 'Your deposit has been submitted and is waiting to be confirmed on Ethereum.';
// Wallet work narrates in the dialog — the steps while it runs, one line
// with the outcome when it ends. No toasts: with the dialog closed, the
// right panel's activity rows carry the same words.

export default class AccountModal {
    constructor(app, { triggerId = 'account-tab-btn', overlayId = 'account-modal', canRestore = () => true, canOpen = () => true } = {}) {
        this.app = app;
        this.triggerId = triggerId;
        this.isOpen = false;
        this.restorePendingOnInit = true;
        this.restoreStateReady = false;
        // Whether a reload may reopen saved wallet progress here at all —
        // the payment-mode shell says no while the current chat pays with
        // tickets, where a zkAPI dialog would be an intrusion.
        this.canRestore = canRestore;
        this.canOpen = canOpen;
        this.overlay = document.getElementById(overlayId);
        attachWalletModalRestoreCancellation(this);
        const rememberView = () => queueMicrotask(() => this.rememberRunningModal());
        this.overlay?.addEventListener?.('scroll', rememberView, true);
        this.overlay?.addEventListener?.('toggle', rememberView, true);
        // A press holds background renders until it lands (see render()).
        this.overlay?.addEventListener?.('pointerdown', () => { this.pointerPressed = true; }, true);
        const releasePress = () => {
            if (!this.pointerPressed) return;
            this.pointerPressed = false;
            // After the click that follows pointerup has run.
            if (this.renderDeferred) setTimeout(() => { if (!this.pointerPressed && this.renderDeferred && this.isOpen) this.render(); }, 0);
        };
        for (const type of ['pointerup', 'pointercancel']) globalThis.addEventListener?.(type, releasePress, true);
        globalThis.addEventListener?.('blur', releasePress);
        this.view = 'balance';
        this.withdrawMode = 'mutual';
        this.busy = false;
        this.status = '';
        this.statusError = false;
        this.depositAmount = null;
        this.depositBalanceRefreshPending = false;
        this.confirmedDepositNoteId = null;
        this.fundingDestination = null;
        this.fundingError = '';
        this.walletMethodReady = false;
        const renderFundingUpdate = () => refreshWalletView(this);
        this.fundingUnsubscribe = addressFundingWallet.subscribe(renderFundingUpdate);
        this.methodUnsubscribe = subscribeWalletMethod(renderFundingUpdate);
        this.historyOpen = false;
        this.returnFocusEl = null;
        this.escapeHandler = null;
        this.unsubscribe = zkapiClient.subscribe((_snapshot, detail) => {
            if (detail?.reason === 'clock') return;
            this.syncConfirmedDepositBalance();
            this.updateTabIndicator();
            this.restorePendingOperation();
            if (this.isOpen && !this.busy) this.rememberRunningModal();
            // An unfunded modal contains an editable amount. Rebuilding it on
            // background refreshes resets that value and steals input focus.
            // Mutating actions render once from run() after they complete.
            if (this.canRefreshContent()) {
                if (this.disclosureAnimating) this.disclosureRefreshPending = true;
                else this.render();
            }
        });
        this.clockUnsubscribe = zkapiClient.subscribeClock(({ now } = {}) => {
            this.handleZkapiClock(now);
        });
        this.attachTabListener();
        this.updateTabIndicator();
        const finishInit = () => {
            this.walletMethodReady = true;
            this.restoreStateReady = true;
            this.updateTabIndicator();
            this.restorePendingOperation();
            if (this.isOpen) this.render();
        };
        this.walletReady = initWalletClient().then(finishInit, error => {
            this.fundingError = error.message;
            finishInit();
        });
        // A reload must bring the dialog back as soon as the saved wallet is
        // read. Startup then checks the chain (every saved withdrawal,
        // through MetaMask), which can take many seconds; restoring only
        // after that made the dialog look like it never came back.
        void initWalletMethod().then(() => {
            this.walletMethodKnown = true;
            this.restorePendingOperation();
        }, () => {});

        window.addEventListener('zkapi-payment-required', (event) => {
            this.open(event.detail?.view || 'fund');
        });
    }

    canRefreshContent() {
        const editingDeposit = ['balance', 'fund'].includes(this.view)
            && !zkapiClient.note
            && ['zkapi-deposit-amount', 'funding-usd', 'funding-eth'].includes(document.activeElement?.id);
        return this.isOpen && !this.busy && !this.fundingBusy && !editingDeposit
            && document.activeElement?.type !== 'password';
    }

    // Transitions.dev "Card resize": a render that changes the dialog's height
    // (MetaMask ↔ Send ETH, a quote arriving, another view) glides from the
    // old height to the new one, and the dialog stays centred while it does,
    // instead of jumping. The scroll area holds still until it lands.
    glideDialogHeight(from) {
        this.dialogHeightAnimation?.cancel?.();
        this.dialogHeightAnimation = null;
        const panel = this.overlay?.querySelector?.('.zkapi-dialog');
        if (!from || typeof panel?.animate !== 'function' || typeof panel.getBoundingClientRect !== 'function') return;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        const to = panel.getBoundingClientRect().height;
        if (!to || Math.abs(to - from) < 2) return;
        const scroll = panel.querySelector('[data-funding-scroll]');
        if (scroll?.style) scroll.style.overflowY = 'hidden';
        const glide = panel.animate([{ height: `${from}px` }, { height: `${to}px` }],
            { duration: motionDuration(panel, '--resize-dur', 300), easing: panel.ownerDocument?.defaultView?.getComputedStyle?.(panel).getPropertyValue('--resize-ease').trim() || 'cubic-bezier(0.22, 1, 0.36, 1)' });
        this.dialogHeightAnimation = glide;
        const settle = () => {
            if (scroll?.style) scroll.style.overflowY = '';
            if (this.dialogHeightAnimation === glide) this.dialogHeightAnimation = null;
        };
        glide.onfinish = settle;
        glide.oncancel = settle;
        return glide;
    }

    /** Which page the dialog shows. A deposit keeps one page from its first
     *  step to its confirmation, whether or not the SDK has saved it yet. */
    pageKey() {
        const pending = zkapiClient.config?.pending_deposit;
        if (!zkapiClient.note && (this.depositInMotion()
            || ['submitted', 'dropped_or_pending', 'awaiting_wallet', 'ambiguous'].includes(pending?.phase))) return 'deposit-progress';
        if (this.view === 'withdraw') {
            const stage = this.withdrawalConfirmation ? 'confirmation'
                : zkapiClient.withdrawal?.phase === 'pending' ? 'escape-wait'
                : zkapiClient.config?.prepared_withdrawal || this.busy && ['withdraw', 'escape'].includes(this.journeyKind) ? 'progress' : 'form';
            return `withdraw:${stage}`;
        }
        return `${this.view}:${zkapiClient.note ? 'balance' : 'funding'}:${this.depositBalanceRefreshPending ? 'refreshing' : ''}`;
    }

    // A new page settles in under the height glide rather than cutting in.
    fadeInPage() {
        const content = this.overlay?.querySelector?.('[data-funding-scroll]');
        if (typeof content?.animate !== 'function') return;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        content.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
            { duration: motionDuration(content, '--modal-open-dur', 250), easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    }

    handleDisclosureMotion(animating) {
        this.disclosureAnimating = animating;
        if (!animating && this.disclosureRefreshPending && this.canRefreshContent()) {
            this.disclosureRefreshPending = false;
            this.render();
        }
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

    rememberRunningModal(running = this.isOpen) {
        try {
            if (running && this.isOpen) {
                const scroll = this.restoredModalView?.scroll ?? this.overlay?.querySelector?.('[data-funding-scroll]')?.scrollTop ?? 0;
                const amount = this.fundingInputAmount ?? this.depositAmount;
                window.sessionStorage?.setItem(RUNNING_MODAL_KEY, JSON.stringify({
                    view: this.view, mode: this.withdrawMode, method: getWalletMethod(),
                    amount: typeof amount === 'string' && amount.length <= 50 && /^[\d.]*$/.test(amount) ? amount : null,
                    currency: this.fundingInputCurrency === 'eth' ? 'eth' : 'usd',
                    help: this.fundingHelpOpen || null, returnOpen: this.fundingReturnOpen === true, history: Boolean(this.historyOpen),
                    setup: this.overlay?.querySelector?.('[data-funding-setup-details]')?.dataset.open === 'true',
                    scroll: Number.isFinite(scroll) ? scroll : 0
                }));
            } else {
                window.sessionStorage?.removeItem(RUNNING_MODAL_KEY);
            }
        } catch { /* Restricted storage must not block wallet work. */ }
    }

    readRunningModal() {
        try {
            const saved = JSON.parse(window.sessionStorage?.getItem(RUNNING_MODAL_KEY) || 'null');
            return RESTORABLE_VIEWS.includes(saved?.view) ? saved : null;
        } catch { return null; }
    }

    // A reload loses the dialog, not the work: the SDK keeps reconciling the
    // saved deposit or withdrawal in the background. Once, after startup, put
    // the steps back where they were. Opening only refreshes status; a wallet
    // request still needs the user's own click. A close, or any manual open
    // during startup, wins over restoration.
    /** The saved wallet is readable: the signer choice is known and the SDK
     *  has loaded its local snapshot, even if startup is still checking the
     *  chain. Enough to put the saved view back; nothing is sent from here. */
    savedStateReadable() {
        return this.restoreStateReady || (this.walletMethodKnown === true && zkapiClient.config != null);
    }

    restorePendingOperation() {
        if (!this.restorePendingOnInit || !this.savedStateReadable()) return;
        const saved = this.readRunningModal();
        const withdrawalNeedsRecovery = [...IN_MOTION_PHASES, 'reserving', 'prepared', 'retry_exact']
            .includes(zkapiClient.config?.prepared_withdrawal?.phase)
            || [...IN_MOTION_PHASES, 'reserving', 'prepared', 'retry_exact'].includes(zkapiClient.withdrawal?.phase)
            || Boolean(zkapiClient.activeLateWithdrawal);
        const backgroundNeedsRecovery = zkapiClient.withdrawals?.some(record =>
            ['submitted_unconfirmed', 'finalizing', 'awaiting_wallet', 'ambiguous'].includes(record.phase)
            || record.startSubmissionId || record.finalizeSubmissionId || record.backgroundPreparationCancelable === true);
        // The standalone welcome dialog owns its saved view, including an
        // interrupted deposit. A withdrawal started in another tab takes
        // precedence: Welcome has no controls to recover it.
        if (!saved && readWelcomeModalIntent() && !withdrawalNeedsRecovery && !backgroundNeedsRecovery) {
            this.restorePendingOnInit = false;
            return;
        }
        if (this.isOpen || this.busy || !this.canRestore({ hasSavedModal: Boolean(saved) })) return;
        this.restorePendingOnInit = false;
        if (withdrawalNeedsRecovery || backgroundNeedsRecovery) writeWelcomeModalIntent(null);
        if (saved) {
            this.withdrawMode = saved.mode === 'escape' ? 'escape' : 'mutual';
            if (['metamask', 'address'].includes(saved.method)) {
                try { setWalletMethod(saved.method); } catch { /* A saved signed transaction owns its provider. */ }
            }
            // Address amounts already have a durable exact principal. Never
            // reprice that saved intent from its older USD presentation.
            if (getWalletMethod() !== 'address' && typeof saved.amount === 'string' && saved.amount.length <= 50 && /^[\d.]*$/.test(saved.amount)) {
                this.fundingInputAmount = saved.amount;
                this.depositAmount = saved.amount;
                this.fundingInputCurrency = saved.currency === 'eth' ? 'eth' : 'usd';
                this.preferDepositInput = true;
            }
            this.fundingHelpOpen = ['quote', 'receipt'].includes(saved.help) ? saved.help : null;
            this.fundingReturnOpen = saved.returnOpen === true;
            this.historyOpen = saved.history === true;
            this.restoredModalView = { setup: saved.setup === true, view: saved.view, method: getWalletMethod(),
                scroll: Number.isFinite(saved.scroll) ? Math.max(0, saved.scroll) : 0 };
            this.open(saved.view);
            return;
        }
        if (addressFundingWallet.pending) {
            const selector = (addressFundingWallet.pending.transaction?.data || '').slice(0, 10);
            this.open(['0x7fca9c82', '0x9073639b', '0xff8f5585'].includes(selector) ? 'withdraw' : 'fund');
            return;
        }
        // Only work that is actually in motion — a transaction sent, a
        // MetaMask prompt possibly still open, an outcome the chain has to
        // settle. A plan that is merely saved (prepared, the proof made) is
        // not: it waits quietly until the person comes back for it. Prepared
        // withdrawals have already started closing a balance, so restore those too.
        const inMotion = phase => IN_MOTION_PHASES.includes(phase);
        const plan = zkapiClient.config?.pending_deposit;
        if (!zkapiClient.note && (inMotion(plan?.phase)
            || plan?.approvals?.some(approval => inMotion(approval.phase)))) {
            this.open('fund');
        } else if (withdrawalNeedsRecovery) {
            this.withdrawMode = (zkapiClient.config?.prepared_withdrawal?.mode
                || zkapiClient.withdrawal?.mode || zkapiClient.activeLateWithdrawal?.mode) === 'escape'
                ? 'escape' : 'mutual';
            this.open('withdraw');
        } else if (backgroundNeedsRecovery) {
            this.open('withdrawals');
        }
    }

    open(view = 'balance') {
        if (this.canOpen?.() === false) return;
        this.restorePendingOnInit = false;
        if (!this.overlay) return;
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
        if (!this.isOpen) this.returnFocusEl = document.activeElement;
        this.view = view;
        this.isOpen = true;
        this.renderedMarkup = null;
        this.renderedPage = null;
        // Cancel on a new withdrawal goes back where it came from.
        this.withdrawEntry = null;
        this.withdrawConfirmed = false;
        this.withdrawalConfirmation = null;
        // Preserve explicit dialog intent even while idle or after completion.
        // Only dismissal removes it; reopening never submits a transaction.
        this.rememberRunningModal();
        this.clearTransientOutcome();
        this.status = '';
        this.statusError = false;
        this.render();
        this.overlay.classList.add('zkapi-funding-overlay');
        showSurface(this.overlay);
        document.getElementById(this.triggerId)?.setAttribute('aria-expanded', 'true');
        // Wallet work is not interruptible from here: while it runs the
        // dialog stays, and the close affordances go quiet.
        this.overlay.onclick = event => { if (event.target === this.overlay && !this.busy) this.close(); };
        this.escapeHandler = event => { if (event.key === 'Escape' && !this.busy) this.close(); };
        document.addEventListener('keydown', this.escapeHandler);
        // Startup must restore the provider before any SDK scope captures it.
        // init() performs the initial refresh if this surface opens early.
        if (this.walletMethodReady !== false) void zkapiClient.refresh({ quiet: true }).catch(() => {});
    }

    openFunding() {
        this.open('fund');
    }

    openWithdrawal() {
        this.open('withdraw');
    }

    close({ forModeChange = false } = {}) {
        if (!this.isOpen || (this.busy && !forModeChange)) return;
        this.withdrawalSubmitGeneration = (this.withdrawalSubmitGeneration || 0) + 1;
        this.withdrawalConfirmation = null;
        stopWithdrawalFees(this);
        this.dialogHeightAnimation?.cancel?.();
        this.isOpen = false;
        this.renderedMarkup = null;
        this.renderedPage = null;
        this.pointerPressed = false;
        cancelWalletModalRestore(this);
        this.clearTransientOutcome();
        stopFundingFlow(this);
        if (!forModeChange) this.rememberRunningModal(false);
        else this.restorePendingOnInit = true;
        this.disposeFundingDisclosures?.();
        this.disposePrivateBalanceHelp?.();
        this.disclosureAnimating = false;
        this.disclosureRefreshPending = false;
        this.outcome = null;
        hideSurface(this.overlay, { clear: true });
        document.getElementById(this.triggerId)?.setAttribute('aria-expanded', 'false');
        if (this.escapeHandler) document.removeEventListener('keydown', this.escapeHandler);
        this.escapeHandler = null;
        const returnFocus = this.returnFocusEl?.isConnected === false
            ? this.returnFocusEl.id ? document.getElementById(this.returnFocusEl.id) : null
            : this.returnFocusEl;
        if (!forModeChange) returnFocus?.focus?.();
        this.returnFocusEl = null;
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    clearTransientOutcome() {
        clearTimeout(this.outcomeTimer);
        this.outcomeTimer = null;
        this.outcome = null;
        this.status = '';
        this.statusError = false;
    }

    expireOutcome() {
        clearTimeout(this.outcomeTimer);
        const outcome = this.outcome;
        if (!outcome || (!outcome.canceled && !this.withdrawalCompleted)) return;
        this.outcomeTimer = setTimeout(() => {
            if (this.outcome !== outcome) return;
            this.clearTransientOutcome();
            if (this.isOpen && !this.busy) this.render();
        }, 7000);
        this.outcomeTimer?.unref?.();
    }

    async startDeposit(amount) {
        if (this.busy || this.fundingBusy || this.depositBalanceRefreshPending) return;
        this.depositAmount = amount;
        const pending = zkapiClient.config?.pending_deposit;
        // Validate before run() or the SDK can open a wallet request.
        try {
            if (!pending && !String(amount ?? '').trim()) throw new Error('Enter an amount to deposit.');
            // Saved SDK amounts are already in billing units; never parse
            // their USD display or reprice a native deposit during recovery.
            const parsed = pending ? BigInt(pending.amount) : zkapiClient.isNativeEthFunding && this.fundingInputCurrency === 'eth' ? ethUnits(amount) : parseTokenAmount(amount);
            if (parsed <= 0n) throw new Error('Enter an amount greater than zero.');
            if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Choose a smaller deposit amount.');
        } catch (error) {
            this.outcome = { tone: 'error', message: error.message, field: 'deposit', view: this.view };
            this.render();
            const input = this.overlay?.querySelector('[data-funding-amount], #zkapi-deposit-amount');
            input?.focus();
            return;
        }
        let selectedDeposit = amount;
        if (!pending && zkapiClient.isNativeEthFunding) {
            if (this.fundingInputAmount !== amount) {
                this.depositAmountFlow?.invalidate();
                this.sharedDepositIntent = null;
                this.fundingInputAmount = amount;
            }
            this.fundingBusy = true;
            this.render();
            try { selectedDeposit = await prepareDepositAmount(this); }
            catch (error) {
                this.outcome = { tone: 'error', message: error.message, field: 'deposit', view: this.view };
                return;
            } finally {
                this.fundingBusy = false;
                if (this.isOpen) this.render();
            }
        }
        return this.run(async (report) => {
            const currentPending = zkapiClient.config?.pending_deposit;
            const deposit = currentPending ? zkapiClient.formatBillingAmount(currentPending.amount) : selectedDeposit;
            const result = await zkapiClient.deposit(deposit, report);
            this.depositAmount = null;
            stopFundingFlow(this);
            this.recordDepositConfirmation(result);
        }, { kind: 'deposit', title: 'Adding funds', phase: 'wallet', message: 'Connecting to MetaMask…', blocksSend: true });
    }

    setStatus(message, isError = false) {
        this.status = message;
        this.statusError = isError;
        const withdrawalAmount = this.overlay?.querySelector('[data-withdraw-amount]');
        if (withdrawalAmount && zkapiClient.note) {
            withdrawalAmount.textContent = this.formatWithdrawalAmount(zkapiClient.note.current_balance);
        }
        if (!zkapiClient.activeLease) {
            this.overlay?.querySelector('[data-active-lease-notice]')?.remove();
        }
        // Progress lives in the dialog while it is open: the action row
        // becomes a status row and each step's words settle into it. With
        // the dialog closed (work continued in the background) the toast
        // over the chat bar carries the same words.
        if (!message || !this.busy || isError) return;
        this.outcome = null;
        if (this.journeyKind) {
            const journey = this.currentJourney(this.journeyKind, { message });
            this.journeyLast = journey.position;
            const mounted = this.isOpen ? this.overlay?.querySelector?.('[data-zkapi-journey]') : null;
            if (mounted) { mounted.outerHTML = this.renderJourney(journey);
                const busyLabel = this.overlay.querySelector('[data-zkapi-busy-label]');
                if (busyLabel) busyLabel.textContent = walletMethodText(this.busyLabel(journey));
                revealText(this.overlay.querySelector('[data-zkapi-journey] .zkapi-step[aria-current] .zkapi-step-text')); return; }
        }
        const progress = this.isOpen ? this.overlay?.querySelector?.('[data-zkapi-progress-text]') : null;
        if (progress) this.swapProgressText(progress, walletMethodText(message));
    }

    /** The last run ended with the MetaMask prompt closed. Two states share
     *  a saved deposit or withdrawal — just canceled, or found again after a
     *  reload — and each gets its own one line, never both. */
    justCanceled() {
        return !this.busy && this.outcome?.canceled === true;
    }

    /** The last run's result, shown in the dialog until the next run or
     *  view change replaces it. */
    renderOutcome() {
        if (this.busy || !this.outcome?.message) return '';
        return `<p class="zkapi-outcome" data-tone="${this.escapeHtml(this.outcome.tone)}" ${this.outcome.field === 'deposit' ? 'id="zkapi-deposit-error" role="alert"' : 'role="status"'}>${this.outcome.tone === 'error' ? statusIcon() : ''}${this.escapeHtml(this.outcome.message)}</p>`;
    }

    /** The journey for a kind of wallet work, from the latest status line
     *  while busy, or from what is persisted (a reload lands here). */
    currentJourney(kind, { message = '', persistedPhase = '', failed = false } = {}) {
        return walletJourney({
            kind,
            message,
            persistedPhase: persistedPhase || (kind === 'deposit' ? zkapiClient.config?.pending_deposit?.phase : ''),
            last: this.journeyKind === kind ? this.journeyLast : null,
            failed,
            hasLease: Boolean(zkapiClient.activeLease),
            tokenSymbol: zkapiClient.billingTokenSymbol || 'USDC',
            nativeEth: zkapiClient.isNativeEthFunding,
            addressFunding: getWalletMethod() === 'address',
            demoMint: Boolean(zkapiClient.config?.funding?.demo_mint_enabled),
            escapePeriod: typeof zkapiClient.escapePeriodPhrase === 'function' ? zkapiClient.escapePeriodPhrase() : ''
        });
    }

    /** The steps, the current one saying what it is doing or waiting for.
     *  `detail` replaces the current step's own line (a persisted-state
     *  notice such as "MetaMask may still be open in this or another tab."). */
    renderJourney(journey, { detail = '' } = {}) {
        const current = journey.steps.find(step => ['active', 'waiting', 'paused', 'error'].includes(step.state))
            || journey.steps.find(step => step.id === journey.position?.step);
        // The dialog title already names the work; the list keeps its name
        // for assistive technology only.
        return walletMethodText(`<div class="zkapi-steps" data-zkapi-journey data-kind="${this.escapeHtml(journey.kind)}" role="status" aria-live="polite" aria-atomic="false">
            <ol class="zkapi-steps-list" aria-label="${this.escapeHtml(journey.category)}">
                ${journey.steps.map(step => {
                    const line = step === current ? (detail || step.detail || '') : '';
                    return `<li class="zkapi-step" data-step="${this.escapeHtml(step.id)}" data-state="${step.state}" ${step === current ? 'aria-current="step"' : ''}>
                        <span class="zkapi-step-mark" aria-hidden="true">${step.state === 'complete' ? '<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"/></svg>' : step.state === 'error' ? statusIcon() : ''}</span>
                        <span class="zkapi-step-text"><span class="zkapi-step-label">${this.escapeHtml(step.label)}</span>${line ? `<small class="zkapi-step-detail">${this.escapeHtml(line)}</small>` : ''}</span>
                    </li>`;
                }).join('')}
            </ol>
        </div>`);
    }

    /** What the disabled primary says while the steps run. */
    busyLabel(journey) {
        return journey?.steps?.some(step => step.state === 'waiting') ? 'Waiting for MetaMask…'
            : journey?.kind === 'deposit' ? 'Depositing…' : 'Working…';
    }

    /** A deposit this dialog is running right now, before the SDK has saved
     *  it as submitted. It gets the same page as a submitted one — the
     *  amount, the steps, one row of actions — from the first click, so the
     *  dialog doesn't rearrange itself halfway through. */
    depositInMotion() {
        return this.busy && this.journeyKind === 'deposit' && !zkapiClient.note && !this.depositBalanceRefreshPending
            && !['withdraw', 'withdrawals'].includes(this.view);
    }

    depositInMotionAmount() {
        const units = zkapiClient.config?.pending_deposit?.amount ?? this.fundingDepositIntent?.amount
            ?? this.fundingFlow?.intent?.amount ?? this.depositAmountFlow?.intent?.amount ?? this.sharedDepositIntent?.amount;
        if (units != null) return zkapiClient.formatMoney(units);
        const typed = this.fundingInputCurrency === 'eth' ? null : this.depositAmount;
        return typed && /^\d+(?:\.\d+)?$/.test(String(typed)) ? `$${Number(typed).toFixed(2)}` : '';
    }

    renderDepositInMotion(address) {
        const journey = this.currentJourney('deposit', { message: this.status });
        const amount = this.depositInMotionAmount();
        return `
            <div class="zkapi-stack">
                <section class="zkapi-figure-block" aria-label="Deposit in progress">
                    <p class="zkapi-balance-caption">Deposit</p>
                    ${amount ? `<p class="zkapi-balance-amount">${this.escapeHtml(amount)}</p>` : ''}
                    <p class="zkapi-meta">Saved in this browser.</p>
                </section>
                ${this.renderJourney(journey)}
                <div class="zkapi-actions"><button class="zkapi-primary-button" type="button" disabled><span class="zkapi-pill-spinner" aria-hidden="true"></span><span data-zkapi-busy-label>${this.busyLabel(journey)}</span></button><button id="zkapi-deposit-dismiss-btn" class="zkapi-quiet-button" type="button" disabled>Close</button></div>
                ${address ? this.literal(renderFundingAccount(this, { receipt: true })) : ''}
                <div class="zkapi-guides">${this.renderWithdrawalStatusLink()}</div>
            </div>`;
    }

    /** New words fade in over the old ones; the row itself never moves. */
    swapProgressText(element, message) {
        if (element.textContent === message) return;
        element.textContent = message;
        revealText(element);
    }

    renderProgress(message) {
        return `<div class="zkapi-progress" role="status" aria-live="polite"><span class="zkapi-pill-spinner" aria-hidden="true"></span><span data-zkapi-progress-text class="zkapi-progress-text is-entering">${this.escapeHtml(message)}</span></div>`;
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
                setText(finalizeButton, ready ? walletMethodText('Finalize in MetaMask') : `Finalize in ${remaining}`);
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
        if (this.canOpen?.() === false || this.busy || this.fundingBusy || this.startingAfterInit) return;
        if (this.walletMethodReady === false) {
            // Startup is still checking the chain. Keep the click instead of
            // dropping it: the button says so, and the action goes ahead once
            // the wallet is ready. Closing the dialog meanwhile abandons it.
            if (!this.walletReady) return;
            const generation = this.withdrawalSubmitGeneration || 0;
            const view = this.view;
            this.startingAfterInit = true;
            if (this.isOpen) this.render();
            try { await this.walletReady; } finally { this.startingAfterInit = false; }
            if (!this.isOpen || this.canOpen?.() === false || generation !== (this.withdrawalSubmitGeneration || 0) || view !== this.view) return;
        }
        cancelWalletModalRestore(this);
        this.clearTransientOutcome();
        this.withdrawalCompleted = false;
        this.withdrawalOutcomePending = false;
        let depositOperation = activityDetails?.kind === 'deposit' ? depositOperationId() : null;
        this.busy = true;
        this.rememberRunningModal(true);
        this.status = activityDetails?.message || 'Waiting for MetaMask…';
        this.statusError = false;
        // Deposits and withdrawals show their steps; other work shows a line.
        this.journeyKind = ['deposit', 'withdraw', 'escape'].includes(activityDetails?.kind) ? activityDetails.kind : null;
        this.journeyLast = null;
        this.backgroundProgress = activityDetails?.withdrawalRecordId
            ? { recordId: activityDetails.withdrawalRecordId, phase: 'preparing' } : null;
        this.render();
        const activityId = activityDetails
            ? zkapiClient.beginActivity(activityDetails.kind, {
                ...activityDetails,
                message: walletMethodText(activityDetails.message || 'Starting…')
            })
            : null;
        const report = (message, phase = null) => {
            if (activityDetails?.kind === 'deposit') depositOperation = depositOperationId() || depositOperation;
            this.setStatus(message);
            if (this.backgroundProgress && phase) {
                this.backgroundProgress.phase = phase;
                this.updateBackgroundProgress();
            }
            if (activityId) zkapiClient.updateActivity(activityId, {
                message: walletMethodText(message),
                ...(phase ? { phase } : {})
            });
        };
        let releaseWalletMethod;
        try {
            releaseWalletMethod = await prepareWalletMethod();
            if (getWalletMethod() === 'address') await runAddressAction(this, activityDetails, report, () => action(report));
            else await action(report);
            if (activityId) zkapiClient.completeActivity(activityId, {
                    message: walletMethodText(this.status || 'Complete.')
            });
            this.outcome = { message: this.status || 'Private balance updated.', tone: this.withdrawalOutcomePending ? 'info' : 'success' };
        } catch (error) {
            const confirmationPending = error?.withdrawalConfirmationPending === true;
            const fundingWaitStopped = error?.code === 'address_wait_stopped';
            const fundingSaved = error?.code === 'address_transaction_pending' || fundingWaitStopped;
            const rejected = isWalletCancellation(error) && !error?.transactionHash && error?.broadcastPossible !== true;
            if (rejected && activityDetails?.kind === 'deposit' && getWalletMethod() === 'metamask') {
                try {
                    if (await resetCanceledDeposit(error, depositOperation)) {
                        stopFundingFlow(this);
                        this.depositAmount = null;
                        this.fundingNotice = '';
                        this.fundingError = '';
                    }
                } catch { /* A failed cleanup keeps the SDK recovery record. */ }
            }
            // An indexer that has not caught up is a wait, not a fault.
            const indexerLag = isIndexerLag(error);
            const depositPending = activityDetails?.kind === 'deposit'
                ? pendingDepositMessage(error, zkapiClient.config?.pending_deposit) : null;
            const feeChanged = ['address_insufficient_eth', 'address_fee_quote_changed', 'address_fee_data', 'withdrawal_fee_changed', 'withdrawal_insufficient_eth'].includes(error?.addressCode || error?.code);
            if (feeChanged) stopWithdrawalFees(this);
            const recoverable = feeChanged || fundingSaved || indexerLag || Boolean(depositPending);
            explainZkapiError(error);
            const canceledMessage = activityDetails?.kind === 'deposit' ? 'Deposit canceled.'
                : activityDetails?.kind === 'withdraw' ? 'Withdrawal canceled.' : CANCELED_LINE;
            const depositFeeIssue = feeChanged && activityDetails?.kind === 'deposit';
            const depositFeeMessage = (error?.addressCode || error?.code) === 'address_insufficient_eth'
                ? 'Deposit not sent. Add the ETH shown below to cover the deposit and network fee, then try again.'
                : (error?.addressCode || error?.code) === 'address_fee_data'
                    ? 'Deposit not sent. The network fee could not be checked. Wait for the fee estimate below, then try again.'
                    : 'Deposit not sent. The fee estimate changed or expired. Review the updated amount below, then try again.';
            const hasFeePanel = feeChanged && this.view === 'withdraw' && needsWithdrawalFees(this);
            const feeMessage = (error?.addressCode || error?.code) === 'address_insufficient_eth'
                ? 'Add ETH for the network fee, then check again. Nothing was sent.'
                : (error?.addressCode || error?.code) === 'address_fee_data'
                    ? 'Fee check interrupted. Checking again… Nothing was sent.'
                    : 'Network fees changed. Review the updated reserve before continuing.';
            this.setStatus(depositFeeIssue ? depositFeeMessage : hasFeePanel ? feeMessage : fundingWaitStopped ? error.message : fundingSaved ? 'Your funding transaction is saved. Use Check saved transaction to resume it safely.' : rejected ? canceledMessage : depositPending || walletErrorMessage(error),
                !rejected && !confirmationPending && !recoverable);
            if (activityId) {
                if (recoverable) zkapiClient.updateActivity(activityId, {
                    title: feeChanged ? (depositFeeIssue ? 'Review deposit funding' : 'Review withdrawal funding') : fundingWaitStopped ? 'Stopped waiting for funds' : indexerLag ? 'Waiting for balance update'
                        : depositPending ? 'Deposit status pending' : 'Funding transaction saved',
                    status: 'pending', phase: 'waiting', message: this.status,
                    finishedAt: Date.now(), blocksSend: false, error: null
                });
                else if (confirmationPending) zkapiClient.completeActivity(activityId, {
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
            this.outcome = { message: this.status, tone: recoverable || confirmationPending || rejected ? 'info' : 'error', canceled: rejected, withdrawalFeeIssue: hasFeePanel ? (error?.addressCode || error?.code) : null };
        } finally {
            releaseWalletMethod?.();
            this.rememberRunningModal();
            this.busy = false;
            this.backgroundProgress = null;
            // Ended: the steps are drawn from what is persisted from here on.
            this.journeyKind = null;
            this.journeyLast = null;
            // The outcome belongs to the view the run ended on; moving to
            // another view (Withdraw, Back to balance) leaves it behind.
            if (this.outcome) {
                this.outcome.view = this.view;
                this.outcome.method = getWalletMethod();
            }
            this.expireOutcome();
            this.render();
        }
    }

    syncConfirmedDepositBalance() {
        if (this.depositBalanceRefreshPending && zkapiClient.note
            && Number(zkapiClient.note.note_id) === this.confirmedDepositNoteId) {
            this.depositBalanceRefreshPending = false;
            this.confirmedDepositNoteId = null;
            if (this.status === CONFIRMED_REFRESHING_LINE) this.status = DEPOSIT_READY_LINE;
            if (this.outcome?.message === CONFIRMED_REFRESHING_LINE) this.outcome.message = DEPOSIT_READY_LINE;
        }
    }

    recordDepositConfirmation(result) {
        this.depositBalanceRefreshPending = result?.balanceRefreshPending === true;
        this.confirmedDepositNoteId = this.depositBalanceRefreshPending ? Number(result.noteId) : null;
        this.syncConfirmedDepositBalance();
        this.view = 'balance';
        this.setStatus(this.depositBalanceRefreshPending ? CONFIRMED_REFRESHING_LINE : DEPOSIT_READY_LINE);
    }

    async submitAddressDeposit() {
        if (this.depositBalanceRefreshPending) return;
        const flow = this.fundingFlow;
        await this.run(async report => {
            const result = await zkapiClient.deposit(this.fundingDepositIntent.ethAmount, report,
                { preparedOperationId: this.fundingDepositIntent.preparedOperationId });
            await flow.complete();
            stopFundingFlow(this);
            this.fundingUsdAmount = null;
            this.fundingInputAmount = null;
            this.fundingInputCurrency = null;
            this.recordDepositConfirmation(result);
        }, { kind: 'deposit', title: 'Adding ETH', phase: 'wallet', message: 'Checking funds…', blocksSend: true });
    }

    async prepareAddressDepositRetry() {
        await this.run(async report => {
            const result = await zkapiClient.prepareDepositRetry(report);
            stopFundingFlow(this);
            if (result?.status === 'confirmed') this.recordDepositConfirmation(result);
            else {
                this.view = 'fund';
                this.setStatus('Your saved deposit is ready to review. Check the updated fee estimate before choosing Deposit.');
            }
        }, { kind: 'deposit', title: 'Reviewing saved deposit', phase: 'local', message: 'Checking the saved deposit…', blocksSend: true });
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
            if (label && element.textContent !== walletMethodText(label)) element.textContent = walletMethodText(label);
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
        return fundingDisclosure({ key: 'history', id: 'zkapi-payment-history', triggerId: 'zkapi-withdrawal-status-btn',
            label: `Payment history${toCheck ? `<span class="zkapi-guide-note">${toCheck} withdrawal${toCheck === 1 ? '' : 's'} to check</span>` : ''}`,
            open: expanded, body: this.renderWithdrawalRecords({ inline: true })
        });
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
            <section class="zkapi-record" data-deposit-record="${this.escapeHtml(record.recordId)}">
                <div class="zkapi-record-head">
                    <div>
                        <p class="zkapi-record-title">Deposit</p>
                        <p class="zkapi-record-sub">${confirmed ? '+' : ''}${zkapiClient.formatMoney(record.amount)}${confirmed ? ' added to private balance' : ''}</p>
                        <p class="zkapi-record-date">${this.escapeHtml(this.paymentDate(record.confirmedAt || record.createdAt))}</p>
                    </div>
                    <span class="zkapi-record-status" data-tone="${confirmed ? 'success' : 'neutral'}">${status}</span>
                </div>
                ${confirmed && /^\d+$/.test(String(record.feeWei)) ? `<p class="zkapi-record-line">Actual network fee: ${renderFundingWei(this, record.feeWei)}</p>` : ''}
                ${transactionUrl ? `<a class="zkapi-record-link" href="${this.escapeHtml(transactionUrl)}" target="_blank" rel="noopener noreferrer">View transaction</a>` : ''}
                ${currentDeposit ? `<button data-view-current-deposit class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>View deposit</button>` : ''}
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
        return `<section class="zkapi-record" data-expiry-record="${this.escapeHtml(record.recordId)}">
            <div class="zkapi-record-head">
                <div><p class="zkapi-record-title">${claimed ? 'Expiry claim' : 'Expiry deadline passed'}</p>
                    <p class="zkapi-record-date">${claimed
                        ? `${zkapiClient.formatMoney(record.amount)} from the original deposit was paid to the service treasury. No refund was made.`
                        : 'No automatic refund. A treasury claim has not been confirmed here.'}</p>
                    <p class="zkapi-record-date">${this.escapeHtml(this.paymentDate(record.claimedAt || record.createdAt))}</p>
                </div><span class="zkapi-record-status" data-tone="neutral">${claimed ? 'Claimed' : 'Check status'}</span>
            </div>
            ${transactionUrl ? `<a class="zkapi-record-link" href="${this.escapeHtml(transactionUrl)}" target="_blank" rel="noopener noreferrer">View transaction</a>` : ''}
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
            return `<div class="zkapi-stack"><p class="zkapi-helper">Your deposits and withdrawals will appear here.</p>${inline ? '' : '<div class="zkapi-actions"><button id="zkapi-back-balance-btn" class="zkapi-quiet-button" type="button">Back to balance</button></div>'}</div>`;
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
            <div class="zkapi-stack zkapi-records">
                ${inline ? '' : this.renderOutcome()}
                ${expiries.some(record => record.status === 'expired') ? `<button id="zkapi-check-expiry-payments-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Check expiry payments</button>` : ''}
                ${hasPendingReturn ? (hasSelectedNote ? '<p class="zkapi-note">These withdrawals run separately from your current private balance, so you can keep chatting normally.</p>' : '<p class="zkapi-note">You can add a new private balance while a return is pending.</p>') : ''}
                <div class="zkapi-record-list">
                    ${lateAttempts.map(attempt => {
                        const needsAttention = Boolean(attempt.error)
                            || attempt.status === 'receipt_mismatch';
                        return `
                        <section class="zkapi-record">
                            <div class="zkapi-record-head">
                                <div>
                                    <p class="zkapi-record-title">Submitted withdrawal</p>
                                    <p class="zkapi-record-sub" ${needsAttention ? 'data-tone="error"' : ''}>${this.escapeHtml(needsAttention
                                        ? attempt.error || 'The saved receipt did not match this withdrawal.'
                                        : 'Saved from a wallet window in another tab')}</p>
                                </div>
                                <span class="zkapi-record-status" data-tone="${needsAttention ? 'error' : 'neutral'}">${needsAttention ? 'Needs attention' : 'Checking'}</span>
                            </div>
                            <button data-sync-late-withdrawal="${this.escapeHtml(attempt.transaction_hash)}" class="zkapi-primary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Check transaction</button>
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
                            <section class="zkapi-record" data-withdrawal-record="${this.escapeHtml(record.recordId)}">
                                <div class="zkapi-record-head">
                                    <div>
                                        <p class="zkapi-record-title">${closed && !returned ? 'Balance closed' : `Withdrawal · ${record.mode === 'escape' ? 'Escape hatch' : 'Mutual close'}`}</p>
                                        <p class="zkapi-record-sub">${closed && !returned ? 'Payment not verified' : `${zkapiClient.formatMoney(record.finalBalance)} ${returned ? 'returned to' : ['parked', 'restored'].includes(record.phase) ? 'set aside · to' : '· to'} ${record.destination ? zkapiClient.compact(record.destination, 6) : 'your saved destination'}`}</p>
                                        <p class="zkapi-record-date">${this.escapeHtml(this.paymentDate(record.createdAt))}</p>
                                    </div>
                                     <span class="zkapi-record-status" data-tone="${returned ? 'success' : 'neutral'}" ${record.mode === 'escape' && open && deadline && record.phase === 'pending' ? `data-zkapi-withdrawal-countdown="${deadline}" data-record-id="${this.escapeHtml(record.recordId)}" data-record-phase="pending"` : ''}>${progressLabel ? '<span class="zkapi-pill-spinner" aria-hidden="true"></span>' : ''}<span data-background-progress="${this.escapeHtml(record.recordId)}" ${progressLabel ? 'role="status"' : ''}>${this.escapeHtml(progressLabel || (parkedNeedsCheck ? 'Checking balance' : this.withdrawalRecordLabel(record)))}</span></span>
                                </div>
                                ${returned && record.phase === 'closed_unconfirmed' ? '<p class="zkapi-record-line">Funds are in your wallet. Network confirmation continues automatically; no action is needed.</p>' : ''}
                                ${closed && transactionUrl ? `<a class="zkapi-record-link" href="${this.escapeHtml(transactionUrl)}" target="_blank" rel="noopener noreferrer">View transaction</a>` : ''}
                                ${record.phase === 'submitted_unconfirmed' ? '<p class="zkapi-record-line">This withdrawal is being checked in the background. Your current balance is unchanged.</p>' : ['challenged_unconfirmed', 'recovery_unconfirmed'].includes(record.phase) ? `<p class="zkapi-record-line">${record.mode === 'escape' ? 'The challenge is being confirmed in the background.' : 'Checking the previous withdrawal’s on-chain status.'} Your current balance is unchanged.</p>` : challengedFinalization ? '<p class="zkapi-record-line">The escape was challenged. Do not retry finalization. Check any submitted transaction, or close the old MetaMask prompt before restoring this balance.</p>' : record.error ? `<p class="zkapi-record-line" data-tone="error">${this.escapeHtml(record.error)}</p>` : ''}
                                ${open ? `<div class="zkapi-record-actions">
                                    ${record.mode === 'escape' && record.phase === 'pending' ? `<button data-finalize-withdrawal="${this.escapeHtml(record.recordId)}" class="zkapi-primary-button" type="button" ${!ready || this.busy ? 'disabled' : ''}>${ready ? 'Finalize' : `Ready in ${zkapiClient.formatExpiry(deadline)}`}</button>` : ''}
                                    ${parkedNeedsCheck || (record.mode === 'escape' && (unresolvedFinalization || ['finalizing', 'awaiting_wallet', 'ambiguous'].includes(record.phase))) || ['submitted_unconfirmed', 'challenged_unconfirmed', 'recovery_unconfirmed', 'closed_unconfirmed'].includes(record.phase) ? `<button data-sync-withdrawal="${this.escapeHtml(record.recordId)}" class="zkapi-primary-button" type="button" ${this.busy ? 'disabled' : ''}>Check status</button>` : ''}
                                    ${record.mode === 'escape' && record.phase === 'awaiting_wallet' && !challengedFinalization ? `<button data-recover-finalization="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Prompt closed</button>` : ''}
                                    ${record.mode === 'escape' && record.phase === 'ambiguous' && !challengedFinalization ? `<button data-retry-finalization="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Retry transaction</button>` : ''}
                                    ${record.mode === 'escape' && finalizationReplacement && !challengedFinalization ? `<button data-retry-dropped-finalization="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Replace transaction</button>` : ''}
                                    ${backgroundStartReplacement ? `<button data-retry-dropped-background-withdrawal="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Replace transaction</button>` : ''}
                                    ${record.backgroundPreparationCancelable ? `<button data-cancel-background-preparation="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Cancel preparation</button>` : ''}
                                    ${record.mode === 'escape' && challengedFinalization && record.finalizeSubmissionId && !record.finalizeTransactionHash ? `<button data-resolve-challenged-finalization="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>I closed MetaMask</button>` : ''}
                                    ${backgroundReady ? `<button data-withdraw-background="${this.escapeHtml(record.recordId)}" class="zkapi-primary-button" type="button" ${this.busy ? 'disabled' : ''}>Withdraw ${zkapiClient.formatMoney(record.finalBalance)}</button>` : record.mode !== 'mutual' && ['restored', 'parked'].includes(record.phase) && !unresolvedFinalization ? `<button data-restore-withdrawal="${this.escapeHtml(record.recordId)}" data-withdrawal-only="${withdrawalOnly}" class="zkapi-primary-button" type="button" ${hasSelectedNote || hasPendingDeposit || this.busy ? 'disabled' : ''}>${withdrawalOnly ? 'Finish withdrawal' : 'Use this balance'}</button>` : ''}
                                </div>` : ''}
                            </section>`;
                    }).join('')}
                </div>
                ${hasPendingReturn || (!hasSelectedNote && hasPendingDeposit) || !inline ? `<div class="zkapi-actions">
                    ${hasPendingReturn ? `<button id="zkapi-sync-all-withdrawals-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Check on-chain status</button>` : ''}
                    ${!hasSelectedNote && hasPendingDeposit ? '<button id="zkapi-add-new-balance-btn" class="zkapi-secondary-button" type="button">View current deposit</button>' : ''}
                    ${inline ? '' : `<button id="zkapi-back-balance-btn" class="zkapi-quiet-button" type="button" ${this.busy ? 'disabled' : ''}>Back to balance</button>`}
                </div>` : ''}
            </div>`;
    }

    renderBalance(fundingSetup = null) {
        this.syncConfirmedDepositBalance();
        const address = getWalletMethod() === 'address';
        if (this.depositBalanceRefreshPending) return `<div class="zkapi-stack">
            <section class="zkapi-figure-block" aria-label="Deposit confirmed">
                <p class="zkapi-balance-caption">Deposit confirmed</p>
                <p class="zkapi-helper" role="status">Refreshing your private balance…</p>
            </section>
            <div class="zkapi-actions">${this.busy ? this.renderProgress(this.status) : '<button id="zkapi-refresh-btn" class="zkapi-secondary-button" type="button">Refresh balance</button>'}</div>
            <div class="zkapi-guides">${this.renderWithdrawalStatusLink()}</div>
        </div>`;
        const note = zkapiClient.note;
        const pendingDeposit = zkapiClient.config?.pending_deposit;
        if (!note) {
            if (pendingDeposit && ['submitted', 'dropped_or_pending', 'awaiting_wallet', 'ambiguous'].includes(pendingDeposit.phase)) {
                const pendingDetail = pendingDeposit.phase === 'submitted' ? CONFIRMING_LINE
                    : pendingDeposit.phase === 'dropped_or_pending' ? 'No receipt yet. It may still be pending, or MetaMask may have dropped it.'
                    : pendingDeposit.phase === 'awaiting_wallet' ? 'MetaMask may still be open in this or another tab.'
                    : 'We couldn’t confirm whether your deposit went through. Check its status before trying again.';
                const pendingJourney = this.busy && this.journeyKind === 'deposit'
                    ? this.currentJourney('deposit', { message: this.status })
                    : this.currentJourney('deposit', { persistedPhase: pendingDeposit.phase, failed: this.statusError && !this.busy });
                // The same page as while it ran: the amount, the steps, one
                // row of actions. Only the current step's line changes.
                const primary = this.busy
                    ? '<button class="zkapi-primary-button" type="button" disabled><span class="zkapi-pill-spinner" aria-hidden="true"></span>Checking…</button>'
                    : `<button id="zkapi-check-deposit-btn" class="${pendingDeposit.phase === 'submitted' ? 'zkapi-quiet-button' : 'zkapi-primary-button'}" type="button">Check payment status</button>`;
                const secondary = this.busy ? '' : [
                    pendingDeposit.phase === 'dropped_or_pending' && pendingDeposit.replacement_available ? '<button id="zkapi-retry-dropped-deposit-btn" class="zkapi-secondary-button" type="button">Replace transaction</button>' : '',
                    pendingDeposit.phase === 'awaiting_wallet' ? '<button id="zkapi-recover-deposit-btn" class="zkapi-secondary-button" type="button">Recover request</button>' : '',
                    pendingDeposit.phase === 'ambiguous' ? `<button id="zkapi-retry-deposit-btn" class="zkapi-secondary-button" type="button">${address ? 'Review fees for saved retry' : 'Try again in MetaMask'}</button>` : ''
                ].join('');
                return `
                    <div class="zkapi-stack">
                        <section class="zkapi-figure-block" aria-label="Deposit in progress">
                            <p class="zkapi-balance-caption">Deposit</p>
                            <p class="zkapi-balance-amount">${zkapiClient.formatMoney(pendingDeposit.amount)}</p>
                            <p class="zkapi-meta">Saved in this browser.</p>
                        </section>
                        ${this.renderJourney(pendingJourney, { detail: this.busy ? '' : pendingDetail })}
                        ${this.renderOutcome()}
                        <div class="zkapi-actions">${primary}${secondary}<button id="zkapi-deposit-dismiss-btn" class="zkapi-quiet-button" type="button" ${this.busy ? 'disabled' : ''}>Close</button></div>
                        ${address ? this.literal(renderFundingAccount(this)) : ''}
                        <div class="zkapi-guides">${this.renderWithdrawalStatusLink()}</div>
                    </div>`;
            }
            if (this.depositInMotion()) return this.renderDepositInMotion(address);
            const resumingDeposit = pendingDeposit
                && ['prepared', 'retry_exact'].includes(pendingDeposit.phase);
            if (address && (!pendingDeposit || canQuotePendingAddressDeposit())) return `<div class="zkapi-stack">
                ${this.renderOutcome()}
                ${this.busy ? this.renderProgress(this.status) : pendingDeposit?.phase === 'retry_exact' ? '<p class="zkapi-note">This retry keeps the original deposit transaction. If its network fee cannot be estimated, check the saved payment status first.</p><div class="zkapi-actions"><button id="zkapi-check-deposit-btn" class="zkapi-secondary-button" type="button">Check payment status</button></div>' : ''}
                ${fundingInstructionsVisible(this) ? '' : this.literal(renderFundingAccount(this))}
                <div class="zkapi-guides">${this.renderWithdrawalStatusLink()}</div>
            </div>`;
            if (address && zkapiClient.isNativeEthFunding && resumingDeposit) {
                return `<div class="zkapi-stack">
                    <section class="zkapi-figure-block" aria-label="Saved deposit">
                        <p class="zkapi-balance-caption">Saved deposit</p>
                        <p class="zkapi-balance-amount">${zkapiClient.formatMoney(pendingDeposit.amount)}</p>
                        <p class="zkapi-meta">Check its payment status before continuing. The amount is unchanged.</p>
                    </section>
                    ${this.renderOutcome()}
                    <div class="zkapi-actions">${this.busy ? this.renderProgress(this.status) : `<button id="zkapi-check-deposit-btn" class="${pendingDeposit.phase === 'retry_exact' ? 'zkapi-secondary-button' : 'zkapi-primary-button'}" type="button">Check payment status</button>
                        ${pendingDeposit.phase === 'retry_exact' ? '<button id="zkapi-retry-deposit-btn" class="zkapi-primary-button" type="button">Review fees for saved retry</button>' : ''}`}</div>
                    ${this.literal(renderFundingAccount(this))}
                    <div class="zkapi-guides">${this.renderWithdrawalStatusLink()}</div>
                </div>`;
            }
            // A definitely unsubmitted canceled draft has already been cleared.
            // Any remaining SDK plan still needs its ordinary recovery path.
            const depositAmount = resumingDeposit
                ? (zkapiClient.isNativeEthFunding ? zkapiClient.formatMoney(pendingDeposit.amount).replace(/^\$/, '') : zkapiClient.formatBillingAmount(pendingDeposit.amount))
                : this.depositAmount
                    ?? zkapiClient.suggestedDeposit.toFixed(zkapiClient.suggestedDeposit < 0.01 ? 6 : 2);
            const mainnet = zkapiClient.isMainnetFunding;
            const demoMintEnabled = zkapiClient.config?.funding?.demo_mint_enabled;
            const helper = zkapiClient.isNativeEthFunding ? '' : mainnet
                ? 'USDC on Ethereum'
                : demoMintEnabled
                    ? 'Sepolia testnet · demo billing tokens are provided when needed'
                    : 'Install MetaMask to get started';
            return `
                <div class="zkapi-stack">
                    <section class="zkapi-section zkapi-deposit" aria-label="Add funds">
                        ${zkapiClient.isNativeEthFunding ? '' : `<div class="zkapi-figure-row">
                            <div class="zkapi-figure"><span aria-hidden="true">$</span><input id="zkapi-deposit-amount" inputmode="decimal" aria-label="Deposit amount" ${this.outcome?.field === 'deposit' ? 'aria-invalid="true" aria-describedby="zkapi-deposit-error"' : ''} size="4" value="${this.escapeHtml(depositAmount)}" ${resumingDeposit ? 'readonly' : ''} /></div>
                            <label class="zkapi-balance-caption" for="zkapi-deposit-amount">${resumingDeposit ? 'Saved deposit' : 'Deposit'}</label>
                        </div>`}
                        ${helper ? `<p class="zkapi-helper">${helper}</p>` : ''}
                        ${resumingDeposit && !this.busy ? '<p class="zkapi-note">Before resuming, check MetaMask for a pending transaction.</p>' : ''}
                        ${this.renderOutcome()}
                        ${this.busy && this.journeyKind === 'deposit'
                            ? this.renderJourney(this.currentJourney('deposit', { message: this.status }))
                            : `<div class="zkapi-actions">
                            ${this.busy
                                ? this.renderProgress(this.status || 'Waiting for MetaMask…')
                                : this.startingAfterInit
                                    ? '<button id="zkapi-deposit-btn" class="zkapi-primary-button w-full" type="button" disabled><span class="zkapi-pill-spinner" aria-hidden="true"></span>Getting ready…</button>'
                                    : `<button id="zkapi-deposit-btn" class="zkapi-primary-button w-full" type="button">${resumingDeposit ? 'Resume with MetaMask' : 'Continue with MetaMask'}</button>`}
                        </div>`}
                    </section>
                    <div class="zkapi-guides">
                        ${address ? '<p class="zkapi-note">Your saved deposit keeps its original amount. Continue only when you are ready to submit it.</p>' : fundingSetupGuide({ mainnet, demoMintEnabled, nativeEth: zkapiClient.isNativeEthFunding, open: fundingSetup?.open })}
                        ${privateBalanceGuide('billing', this.privateBalanceHelpOpen?.billing)}
                        ${this.renderWithdrawalStatusLink()}
                    </div>
                </div>`;
        }

        const claimed = Boolean(zkapiClient.noteExpiryClaim);
        const available = claimed ? 0 : note.current_balance;
        const expired = privateBalanceExpired(note);
        const spent = Math.max(0, Number(note.deposit_amount) - Number(note.current_balance));
        const percent = claimed ? 0 : this.progressPercent(note);
        const withdrawing = !claimed && zkapiClient.withdrawalBlocksChat;
        const withdrawalPhase = zkapiClient.activeWithdrawal?.phase;
        // Describe saved work beside its recovery action, not as a readiness badge.
        const withdrawingLine = ['submitted', 'late_submitted'].includes(withdrawalPhase) ? 'A withdrawal was submitted. Check its status before using this balance.'
            : withdrawalPhase === 'dropped_or_pending' ? 'The withdrawal has no receipt yet. Open it to check or resubmit.'
            : withdrawalPhase === 'awaiting_wallet' ? 'MetaMask may still be open. Open the withdrawal to check it.'
            : withdrawalPhase === 'ambiguous' ? 'MetaMask did not return a transaction. Open the withdrawal to check it.'
            : 'Withdrawal paused. This balance is reserved and cannot be used for chat. Open the withdrawal to review the network fee and next step.';
        return `
            <div class="zkapi-stack">
                <div class="zkapi-balance-card">
                    <div class="zkapi-balance-top">
                        <div>
                            <p class="zkapi-balance-caption">${withdrawing ? 'Reserved for withdrawal' : 'Available'}</p>
                            <p class="zkapi-balance-amount">${zkapiClient.formatMoney(available)}</p>
                            ${zkapiClient.isNativeEthFunding ? `<p class="zkapi-balance-eth">${this.escapeHtml(zkapiClient.formatBillingAmount(available))} ETH</p>` : ''}
                        </div>

                    </div>
                    <div class="zkapi-bar"><div class="zkapi-bar-fill" style="width:${percent}%"></div></div>
                    <div class="zkapi-balance-foot"><span>${claimed ? 'Claimed after expiry' : `${zkapiClient.formatMoney(spent)} used of ${zkapiClient.formatMoney(note.deposit_amount)}`}</span><span class="inline-flex items-center gap-1"><span data-zkapi-balance-expiry>${privateBalanceExpiryLabel(zkapiClient, note.expiry_ts)}</span>${privateBalanceHelpButton('modal', 'expiry', this.privateBalanceHelpOpen?.expiry)}</span></div>
                    ${privateBalanceHelpContent('modal', 'expiry', this.privateBalanceHelpOpen?.expiry)}
                </div>
                ${claimed ? '<p class="zkapi-helper">After expiry, the original deposit was paid to the service treasury. No refund was made.</p>' : `<div data-private-balance-expired-notice ${expired ? '' : 'hidden'}><p class="zkapi-note">This private balance has expired. You can still try withdrawing while it remains unclaimed.</p></div>`}
                ${this.renderOutcome()}
                ${withdrawing ? `<p class="zkapi-note">${withdrawingLine}</p>` : ''}
                <div class="zkapi-actions">
                    ${this.busy ? this.renderProgress(this.status || 'Working…') : `
                    ${claimed ? '' : withdrawing ? '<button id="zkapi-continue-withdrawal-btn" class="zkapi-primary-button" type="button">Review withdrawal</button>' : '<button id="zkapi-withdraw-view-btn" class="zkapi-secondary-button" type="button">Withdraw</button>'}
                    <button id="zkapi-refresh-btn" class="zkapi-secondary-button" type="button">Refresh</button>
                    ${claimed ? '<button id="zkapi-archive-expired-balance-btn" class="zkapi-primary-button" type="button">Start a new balance</button>' : ''}
                    ${zkapiClient.config?.funding?.demo_mint_enabled ? '<button id="zkapi-mint-token-btn" class="zkapi-secondary-button" type="button">Get 10 test ZKAPI</button>' : ''}`}
                </div>
                ${address ? this.literal(renderFundingAccount(this)) : ''}
                <div class="zkapi-guides">${privateBalanceGuide('billing', this.privateBalanceHelpOpen?.billing)}${this.renderWithdrawalStatusLink()}</div>
            </div>`;
    }

    shouldShowClaimedBalance() {
        if (!zkapiClient.noteExpiryClaim || this.busy) return false;
        const prepared = zkapiClient.config?.prepared_withdrawal;
        return !zkapiClient.activeLateWithdrawal && !prepared?.transaction_hash
            && !['submitted', 'dropped_or_pending', 'awaiting_wallet', 'ambiguous'].includes(prepared?.phase);
    }

    dismissWithdrawal() {
        if (this.busy) return;
        this.withdrawalSubmitGeneration = (this.withdrawalSubmitGeneration || 0) + 1;
        this.withdrawalConfirmation = null;
        if (this.withdrawEntry === 'balance' && !zkapiClient.config?.prepared_withdrawal) {
            this.view = 'balance';
            this.render();
        } else this.close();
    }

    withdrawalInputReady() {
        if (this.walletMethodReady === false || this.startingAfterInit || this.busy || this.withdrawalPreflightBusy
            || (this.withdrawMode === 'escape' && escapeNeedsSettlement())) return false;
        if (getWalletMethod() === 'address') {
            try { withdrawalDestination(this); } catch { return false; }
        }
        return withdrawalFeeReady(this);
    }

    withdrawalReviewScope() {
        let destination = null;
        if (getWalletMethod() === 'address') {
            try { destination = withdrawalDestination(this); } catch { return null; }
        }
        return JSON.stringify([zkapiClient.note?.note_id, zkapiClient.note?.current_balance,
            this.withdrawMode, getWalletMethod(), destination, getWalletMethod() === 'metamask' ? this.withdrawalFees?.quote?.address : null,
            zkapiClient.config?.prepared_withdrawal?.operation_id, this.withdrawalEscapeIntent]);
    }

    requestWithdrawal() {
        if (!this.isOpen || this.view !== 'withdraw' || this.canOpen?.() === false || !this.withdrawalInputReady()) return;
        // A saved withdrawal has already crossed this point. Continuing it
        // must not suggest that its server reservation can still be cancelled.
        if (zkapiClient.config?.prepared_withdrawal && !this.withdrawalEscapeIntent) return this.submitWithdrawal();
        this.withdrawalConfirmation = this.withdrawalReviewScope();
        this.render();
        this.overlay?.querySelector('#zkapi-withdraw-review-back')?.focus();
    }

    confirmWithdrawal() {
        const reviewed = this.withdrawalConfirmation;
        this.withdrawalConfirmation = null;
        if (!reviewed || reviewed !== this.withdrawalReviewScope() || !this.withdrawalInputReady()) {
            this.render();
            return;
        }
        return this.submitWithdrawal();
    }

    async submitWithdrawal() {
        if (this.view !== 'withdraw' || this.canOpen?.() === false || this.walletMethodReady === false || this.startingAfterInit || this.withdrawalPreflightBusy || this.busy) return;
        // Validate before any server-side reservation or chat settlement.
        let destination;
        if (getWalletMethod() === 'address') {
            try { destination = withdrawalDestination(this); } catch { return; }
        }
        const reviewedScope = this.withdrawalReviewScope();
        const mode = this.withdrawMode;
        const escapeIntent = this.withdrawalEscapeIntent;
        const noteId = zkapiClient.note?.note_id;
        const submitGeneration = this.withdrawalSubmitGeneration || 0;
        // Check before settling chat access or asking the server to close a note.
        {
            const reviewed = this.withdrawalFees?.quote;
            this.withdrawalPreflightBusy = true;
            let ready;
            try {
                const checking = refreshWithdrawalFees(this, { force: true });
                this.render();
                ready = await checking;
            } finally { this.withdrawalPreflightBusy = false; }
            if (!ready || !this.isOpen || this.view !== 'withdraw' || submitGeneration !== (this.withdrawalSubmitGeneration || 0) || this.canOpen?.() === false) { if (this.isOpen) this.render(); return; }
            if (reviewedScope !== this.withdrawalReviewScope()) {
                this.outcome = { tone: 'info', message: 'Withdrawal details changed. Review them before continuing.', view: this.view };
                this.render();
                return;
            }
            if (!reviewed || BigInt(this.withdrawalFees.quote.feeReserveWei) > BigInt(reviewed.feeReserveWei)) {
                this.outcome = { tone: 'info', message: 'Network fees changed. Review the updated reserve before continuing.', view: this.view };
                this.render();
                return;
            }
        }
        // A render or cross-tab refresh while the provider/settlement is
        // awaited cannot change the operation the person just chose.
        const reviewedFunding = this.withdrawalFees?.quote;
        return this.run(async (report) => {
            if (noteId == null || Number(zkapiClient.note?.note_id) !== Number(noteId)) {
                throw new Error('The private balance changed. Reopen Withdraw before starting another withdrawal.');
            }
            if (reviewedScope !== this.withdrawalReviewScope()) {
                throw new Error('Withdrawal details changed. Review them before continuing.');
            }
            if (escapeIntent) await assertWithdrawalEscapeAvailable(escapeIntent);
            if (mode === 'escape') await assertEscapeReady();
            else await settlePrivateAccess(report);
            if (noteId == null || Number(zkapiClient.note?.note_id) !== Number(noteId)) {
                throw new Error('The private balance changed. Reopen Withdraw before starting another withdrawal.');
            }
            const options = escapeIntent
                ? { destination: escapeIntent.destination, expectedWithdrawalOperationId: escapeIntent.operationId }
                : destination ? { destination } : {};
            if (getWalletMethod() === 'metamask') options.reviewedFunding = reviewedFunding;
            const result = await zkapiClient.withdraw(mode, report, options);
            this.recordWithdrawalOutcome(result);
        }, {
            kind: mode === 'escape' ? 'escape' : 'withdraw',
            title: mode === 'escape' ? 'Starting account recovery' : 'Returning your balance',
            phase: 'settling',
            blocksSend: true
        });
    }

    recordWithdrawalOutcome(result) {
        // A closed vault alone does not prove a payout. The SDK returns this
        // event only after matching the receipt to the saved note/destination.
        if (result?.status === 'closed' && result.event?.destination
            && result.event.finalBalance != null) {
            this.withdrawalCompleted = true;
            this.withdrawalOutcomePending = false;
            this.view = 'withdrawals';
            this.setStatus('Withdrawal confirmed. Funds sent to your saved wallet address.');
        } else if (result?.status === 'closed') {
            this.withdrawalCompleted = false;
            this.withdrawalOutcomePending = true;
            this.view = 'withdrawals';
            this.setStatus('The private balance is closed. Check Payment history for its payment status.');
        } else if (result?.status === 'pending_withdrawal' && Number(result.deadline) > 0) {
            this.setStatus(`Escape started. Finalize after ${new Date(result.deadline * 1000).toLocaleString()}.`);
        }
    }

    formatWithdrawalAmount(amount) {
        const dollars = zkapiClient.formatMoney(amount);
        return zkapiClient.isNativeEthFunding && (!dollars || /^[—–-]$/.test(dollars.trim()))
            ? `${zkapiClient.formatBillingAmount(amount)} ETH` : dollars;
    }

    renderWithdrawal() {
        if (this.shouldShowClaimedBalance()) return this.renderBalance();
        if (zkapiClient.noteExpiryClaim) {
            const awaitingWallet = zkapiClient.config?.prepared_withdrawal?.phase === 'awaiting_wallet';
            return `<div class="zkapi-stack">
                <p class="zkapi-note">This balance was claimed after expiry. No refund was made. You can still check the earlier withdrawal request.</p>
                <div class="zkapi-actions">
                    <button id="zkapi-sync-withdrawal-btn" class="zkapi-primary-button" type="button" ${this.busy ? 'disabled' : ''}>Check transaction</button>
                    ${awaitingWallet ? `<button id="zkapi-recover-withdrawal-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Recover withdrawal</button>` : ''}
                    <button id="zkapi-back-balance-btn" class="zkapi-quiet-button" type="button" ${this.busy ? 'disabled' : ''}>Back to balance</button>
                </div>
            </div>`;
        }
        const note = zkapiClient.note;
        const withdrawal = zkapiClient.withdrawal;
        const prepared = zkapiClient.config?.prepared_withdrawal;
        const lateWithdrawal = zkapiClient.activeLateWithdrawal;
        if (!note && withdrawal?.phase !== 'pending') {
            return zkapiClient.withdrawals.length
                ? this.renderWithdrawalRecords()
                : '<p class="zkapi-helper">There is no active private balance to withdraw.</p>';
        }

        if (lateWithdrawal) {
            const needsAttention = Boolean(lateWithdrawal.error)
                || lateWithdrawal.status === 'receipt_mismatch';
            return `
                <div class="zkapi-stack">
                    <section class="zkapi-figure-block">
                        <p class="zkapi-balance-caption">${needsAttention ? 'Withdrawal needs attention' : 'Checking submitted withdrawal'}</p>
                        <p class="${needsAttention ? 'zkapi-outcome' : 'zkapi-helper'}" ${needsAttention ? 'data-tone="error"' : ''}>${this.escapeHtml(needsAttention
                            ? lateWithdrawal.error || 'The saved receipt did not match this withdrawal. Recheck the vault state.'
                            : 'A MetaMask window returned after this tab changed. The transaction is saved, and only this balance is paused until Ethereum confirms it.')}</p>
                    </section>
                    <div class="zkapi-actions">
                        <button id="zkapi-sync-withdrawal-btn" class="zkapi-primary-button" type="button" ${this.busy ? 'disabled' : ''}>${needsAttention ? 'Recheck vault state' : 'Check transaction'}</button>
                        <button id="zkapi-back-balance-btn" class="zkapi-quiet-button" type="button" ${this.busy ? 'disabled' : ''}>Back to balance</button>
                    </div>
                </div>`;
        }

        if (withdrawal?.phase === 'pending') {
            const deadline = Number(withdrawal.challengeDeadline || 0);
            const ready = deadline > 0 && Date.now() >= deadline * 1000;
            return `
                <div class="zkapi-stack">
                    <section class="zkapi-figure-block">
                        <p class="zkapi-balance-caption">Escape hatch · ${this.escapeHtml(zkapiClient.escapePeriodBadge())} safety window</p>
                        <p class="zkapi-balance-amount" data-zkapi-escape-countdown>${ready ? 'The safety window is complete.' : `Finalize in ${zkapiClient.formatExpiry(deadline)}.`}</p>
                        <p class="zkapi-meta">To ${this.escapeHtml(zkapiClient.compact(withdrawal.destination, 9))}${deadline ? ` · ready ${this.escapeHtml(new Date(deadline * 1000).toLocaleString())}` : ''}</p>
                    </section>
                    <div class="zkapi-actions">
                        <button id="zkapi-finalize-btn" class="zkapi-primary-button" type="button" ${!ready || this.busy ? 'disabled' : ''}>${ready ? 'Finalize in MetaMask' : `Finalize in ${zkapiClient.formatExpiry(deadline)}`}</button>
                        <button id="zkapi-sync-withdrawal-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Check on-chain status</button>
                    </div>
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
        const availableEscape = availableWithdrawalEscape();
        const selectedEscape = sameWithdrawalEscape(this.withdrawalEscapeIntent, availableEscape);
        if (!selectedEscape) this.withdrawalEscapeIntent = null;
        if (preparedMode) this.withdrawMode = selectedEscape ? 'escape' : preparedMode;
        const amount = note?.current_balance ?? prepared?.public_inputs?.final_balance;
        const amountKnown = amount != null && /^\d+$/.test(String(amount));
        const displayAmount = amountKnown ? this.formatWithdrawalAmount(amount) : '';
        const figure = (caption, meta = '') => `<section class="zkapi-figure-block">
            <p class="zkapi-balance-caption">${caption}</p>
            ${amountKnown ? `<p data-withdraw-amount class="zkapi-balance-amount">${this.escapeHtml(displayAmount)}</p>` : '<p class="zkapi-helper">Checking your remaining balance…</p>'}
            ${amountKnown && zkapiClient.isNativeEthFunding && !displayAmount.endsWith(' ETH') ? `<p class="zkapi-balance-eth">${this.escapeHtml(zkapiClient.formatBillingAmount(amount))} ETH</p>` : ''}
            ${meta ? `<p class="zkapi-meta">${meta}</p>` : ''}
        </section>`;
        const busyJourney = this.busy && ['withdraw', 'escape'].includes(this.journeyKind);
        const restoring = this.walletMethodReady === false || this.startingAfterInit;
        if (this.withdrawalConfirmation && this.withdrawalConfirmation !== this.withdrawalReviewScope()) this.withdrawalConfirmation = null;
        if (this.withdrawalConfirmation && !busyJourney) {
            return `<div class="zkapi-stack">
                ${figure('You withdraw', getWalletMethod() === 'address' ? `To ${this.escapeHtml(zkapiClient.compact(withdrawalDestination(this), 9))}` : 'To your MetaMask account')}
                <p class="zkapi-note">${this.withdrawMode === 'mutual'
                    ? 'Once the server approves this withdrawal, it can’t be cancelled and this balance can’t be used for chat.'
                    : `Starting the escape hatch makes this balance unavailable for chat. Return after ${zkapiClient.escapePeriodPhrase()} to finish. Each step has a network fee.`}</p>
                <p class="zkapi-helper">${this.withdrawMode === 'mutual' ? 'Closing this window afterward does not cancel the withdrawal.' : 'You can cancel now without starting the withdrawal.'}</p>
                ${this.withdrawalFees?.loading ? '<p class="zkapi-helper" role="status">Checking available ETH…</p>' : ''}
                <div class="zkapi-actions"><button id="zkapi-withdraw-review-confirm" class="zkapi-primary-button" type="button" ${this.withdrawalInputReady() ? '' : 'disabled'}>Continue</button>
                <button id="zkapi-withdraw-review-back" class="zkapi-quiet-button" type="button">Cancel</button></div>
            </div>`;
        }
        // Once the work has started — in this tab, or before a reload that
        // left a saved withdrawal — the page is the same: the amount, where
        // it goes, the steps, and one row of actions. A reload changes only
        // whether the current step is running or waiting for Continue.
        if (busyJourney || prepared) {
            const escapeRun = this.withdrawMode === 'escape';
            let journey = busyJourney
                ? this.currentJourney(this.journeyKind, { message: this.status })
                : this.currentJourney(escapeRun ? 'escape' : 'withdraw', { persistedPhase: selectedEscape ? 'reserving' : prepared?.phase, failed: this.statusError });
            const notice = restoring ? 'Checking Ethereum for the latest saved status. This can take a little while. Nothing new will be sent until you choose Continue.' : !prepared ? ''
                : droppedOrPending ? 'No receipt yet. It may still be pending, or MetaMask may have dropped it. Check again, or resubmit it with its original nonce.'
                : submitted ? 'Your withdrawal has been submitted and is waiting to be confirmed on Ethereum.'
                : awaitingWallet ? 'MetaMask may still be open. Check it, or recover the request if its window closed.'
                : ambiguous ? 'We couldn’t confirm whether your withdrawal went through. Check its status before trying again.'
                : selectedEscape ? `Continue to prepare the escape proof. After it confirms, wait ${zkapiClient.escapePeriodPhrase()}, then return here to finalize.`
                : prepared.phase === 'reserving' ? 'Paused before MetaMask. Continue when you’re ready.'
                : clearanceReserved ? 'Nothing has been sent yet.'
                : 'The proof is ready. Nothing has been sent yet.';
            const destination = prepared?.destination
                ? zkapiClient.compact(prepared.destination, 9)
                : getWalletMethod() === 'metamask' ? 'your MetaMask account' : 'your wallet address';
            const methodName = escapeRun ? `Escape hatch · ${zkapiClient.escapePeriodPhrase()} wait` : 'Mutual close';
            if (restoring) {
                const current = journey.steps.find(step => ['active', 'waiting', 'paused', 'error'].includes(step.state));
                journey = { ...journey, steps: journey.steps.map(step => step === current
                    ? { ...step, label: 'Checking saved withdrawal', state: 'active' } : step) };
            }
            const cancelable = !restoring && prepared && !submissionActive && !clearanceReserved && !selectedEscape && canCancelPreparedWithdrawal();
            // Cancel says what it does: a plan nothing has been sent for is
            // dropped; anything else only closes the dialog — the work stays
            // saved and this page comes back when the dialog is reopened.
            const dismiss = cancelable
                ? '<button id="zkapi-cancel-withdrawal-btn" class="zkapi-quiet-button" type="button">Cancel</button>'
                : `<button id="zkapi-withdraw-dismiss-btn" class="zkapi-quiet-button" type="button" ${this.busy ? 'disabled' : ''}>Close</button>`;
            const primary = this.busy || restoring
                ? `<button id="zkapi-withdraw-btn" class="zkapi-primary-button" type="button" disabled><span class="zkapi-pill-spinner" aria-hidden="true"></span><span data-zkapi-busy-label>${walletMethodText(restoring ? 'Checking saved withdrawal…' : this.busyLabel(journey))}</span></button>`
                : submissionActive
                    ? `<button id="zkapi-sync-withdrawal-btn" class="${submitted ? 'zkapi-quiet-button' : 'zkapi-primary-button'}" type="button">${submitted ? 'Check now' : 'Check transaction'}</button>`
                    : prepared && !clearanceReserved && !selectedEscape && !cancelable
                        ? '<button id="zkapi-sync-withdrawal-btn" class="zkapi-primary-button" type="button">Check transaction</button>'
                        : `<button id="zkapi-withdraw-btn" class="zkapi-primary-button" type="button" ${this.withdrawalInputReady() ? '' : 'disabled'}>${selectedEscape ? `Start ${zkapiClient.escapePeriodLabel()} escape` : 'Continue in MetaMask'}</button>`;
            const secondary = this.busy || restoring ? '' : [
                droppedOrPending && prepared?.replacement_available ? `<button id="zkapi-retry-dropped-withdrawal-btn" class="zkapi-secondary-button" type="button">Resubmit</button>` : '',
                awaitingWallet ? `<button id="zkapi-recover-withdrawal-btn" class="zkapi-secondary-button" type="button">Recover withdrawal</button>` : '',
                ambiguous ? `<button id="zkapi-retry-withdrawal-btn" class="zkapi-secondary-button" type="button">Try again in MetaMask</button>` : ''
            ].join('');
            // Recovery choices that change what happens to the balance stay
            // one step away, not stacked under the one action that matters.
            const options = !this.busy && !restoring && availableEscape
                ? fundingDisclosure({ key: 'withdraw-options', label: 'Other options', open: Boolean(this.privateBalanceHelpOpen?.['withdraw-options']),
                    body: `<div class="zkapi-options">
                        ${availableEscape ? `<div class="zkapi-option"><p class="zkapi-note">${selectedEscape ? 'Go back to the mutual close, co-signed by the zkAPI server.' : `If the zkAPI server can’t finish this close, the escape hatch recovers this balance after a ${zkapiClient.escapePeriodPhrase()} safety window.`}</p><button id="zkapi-use-escape-btn" class="zkapi-secondary-button" type="button">${selectedEscape ? 'Use mutual close' : 'Use escape hatch'}</button></div>` : ''}
                    </div>` })
                : '';
            return `
                <div class="zkapi-stack">
                    ${figure('Amount to withdraw', `To ${this.escapeHtml(destination)} · ${this.escapeHtml(methodName)}`)}
                    ${this.renderJourney(journey, { detail: busyJourney ? '' : notice })}
                    ${prepared && clearanceReserved && !submissionActive && !busyJourney ? '<p class="zkapi-note">This withdrawal can’t be cancelled. Close saves your progress.</p>' : ''}
                    ${this.renderOutcome()}
                    ${!submissionActive && !busyJourney ? this.literal(renderWithdrawalFees(this)) : ''}
                    <div class="zkapi-actions">${primary}${secondary}${dismiss}</div>
                    ${options ? `<div class="zkapi-guides">${options}</div>` : ''}
                </div>`;
        }

        const address = getWalletMethod() === 'address';
        return `
            <div class="zkapi-stack zkapi-withdraw-form">
                ${this.literal(renderWalletMethod(this))}
                ${figure('You withdraw', address ? '' : 'To your MetaMask account. MetaMask pays the network fee.')}
                ${address ? this.literal(renderFundingAccount(this, { rows: false })) : ''}
                <fieldset class="zkapi-choices" ${this.busy ? 'disabled' : ''}>
                    <legend class="zkapi-balance-caption">Withdrawal method</legend>
                    <label class="zkapi-choice ${this.withdrawMode === 'mutual' ? 'selected' : ''}">
                        <input type="radio" name="zkapi-withdraw-mode" value="mutual" ${this.withdrawMode === 'mutual' ? 'checked' : ''} />
                        <span><strong>Mutual close</strong><small>Withdraw with the zkAPI server’s approval.</small></span>
                    </label>
                    <label class="zkapi-choice ${this.withdrawMode === 'escape' ? 'selected' : ''}">
                        <input type="radio" name="zkapi-withdraw-mode" value="escape" ${this.withdrawMode === 'escape' ? 'checked' : ''} />
                        <span><strong>Escape hatch</strong><small>If the server isn’t responding, you can withdraw yourself. It takes ${zkapiClient.escapePeriodPhrase()} to finish.</small></span>
                    </label>
                </fieldset>
                ${this.literal(renderWithdrawalFees(this))}
                ${this.withdrawMode === 'escape' && escapeNeedsSettlement()
                    ? '<p class="zkapi-note" role="status">Your previous chat balance must finish updating before escape is available. This needs the temporary-key service. If it is down, keep this browser data and retry when it returns.</p><button id="zkapi-settle-before-escape" class="zkapi-secondary-button" type="button">Update chat balance</button>'
                    : activeLease ? '<p data-active-lease-notice class="zkapi-note">Your open chat key settles first.</p>' : ''}
                ${this.renderOutcome()}
                <div class="zkapi-actions">
                    ${restoring
                        ? '<button id="zkapi-withdraw-btn" class="zkapi-primary-button" type="button" disabled><span class="zkapi-pill-spinner" aria-hidden="true"></span>Checking wallet…</button>'
                        : `<button id="zkapi-withdraw-btn" class="zkapi-primary-button" type="button" ${this.withdrawalInputReady() ? '' : 'disabled'}>Continue</button>`}
                    <button id="zkapi-withdraw-dismiss-btn" class="zkapi-quiet-button" type="button">Cancel</button>
                </div>

            </div>`;
    }

    /** Markup that must reach the page as written. The view body's copy
     *  is adapted for Send ETH (walletMethodText); the method control and
     *  the funding section name MetaMask and addresses literally. Outside
     *  dialogMarkup (tests, direct calls) the markup is returned as is. */
    literal(html) {
        if (!html || !this.literalSlots) return html;
        this.literalSlots.push(html);
        return `<!--zkapi-literal-${this.literalSlots.length - 1}-->`;
    }

    /** The dialog's markup for the current view. Pure apart from the
     *  presentation caches the view renderers keep. */
    dialogMarkup(fundingSetup = null) {
        this.literalSlots = [];
        try { return this.buildDialogMarkup(fundingSetup); } finally { this.literalSlots = null; }
    }

    buildDialogMarkup(fundingSetup) {
        const title = this.view === 'withdraw'
            ? this.withdrawalConfirmation ? 'Confirm withdrawal' : 'Withdraw'
            : this.view === 'withdrawals'
                ? 'Payment history'
                : 'Private balance';
        let body;
        if (this.view === 'withdrawals') {
            body = `<p class="zkapi-lede">Deposits and withdrawals saved in this browser</p>${this.renderWithdrawalRecords()}`;
        } else if (this.view === 'withdraw') {
            body = this.renderWithdrawal();
        } else {
            // The signer is a choice only while choosing how to add funds.
            const pending = zkapiClient.config?.pending_deposit;
            const choosing = !zkapiClient.note && !this.depositBalanceRefreshPending
                && (!pending || ['prepared', 'retry_exact'].includes(pending.phase));
            body = this.depositInMotion() ? this.renderBalance(fundingSetup)
                : `${this.literal(renderDepositAmount(this))}${this.literal(renderWalletMethod(this, { choose: choosing }))}${fundingInstructionsVisible(this) ? this.literal(renderFundingAccount(this)) : ''}${this.renderBalance(fundingSetup)}`;
        }
        return `
            <div role="dialog" aria-modal="true" aria-labelledby="zkapi-payment-title" class="${MODAL_CLASSES}${this.view === 'withdraw' ? ' zkapi-withdraw-dialog' : ''}">
                <div class="zkapi-dialog-head">
                    ${this.view === 'withdrawals' ? '<button id="zkapi-history-back" class="zkapi-dialog-close" type="button" aria-label="Back to private balance"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m14 6-6 6 6 6"/></svg></button>' : ''}
                    <h2 id="zkapi-payment-title" class="zkapi-dialog-title">${title}</h2>
                    <button id="zkapi-payment-close" class="zkapi-dialog-close" type="button" aria-label="Close" ${this.busy || this.startingAfterInit || (this.view === 'withdraw' && this.walletMethodReady === false) ? 'hidden' : ''}>
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
                    </button>
                </div>
                <div data-funding-scroll class="zkapi-dialog-scroll">
                    ${walletMethodText(body).replace(/<!--zkapi-literal-(\d+)-->/g, (_, index) => this.literalSlots[Number(index)] ?? '')}
                </div>
            </div>`;
    }

    render() {
        if (!this.overlay || this.canOpen?.() === false) return;
        // Never swap the dialog out from under a press. A button replaced
        // between pointerdown and pointerup gets no click, so a background
        // refresh (price, reconcile, focus) turned one click into two.
        if (this.pointerPressed) { this.renderDeferred = true; return; }
        this.renderDeferred = false;
        this.syncConfirmedDepositBalance();
        if (this.outcome?.view && this.outcome.view !== this.view) this.outcome = null;
        if (this.view === 'withdraw' && this.shouldShowClaimedBalance()) this.view = 'balance';
        const restored = currentWalletModalRestore(this, getWalletMethod());
        const fundingSetup = restored ? { open: restored.setup, scrollTop: restored.scroll } : captureFundingSetupView(this.overlay);
        const markup = this.dialogMarkup(fundingSetup);
        // Rendering restores the saved withdrawal mode before we quote it.
        void refreshWithdrawalFees(this);
        if (markup === this.renderedMarkup && this.overlay.firstElementChild) {
            // Nothing a person can see changed: keep the live nodes, and with
            // them focus, hover, selection and anything half-typed.
            syncWalletFlows(this);
            this.rememberRunningModal();
            return;
        }
        this.disposeFundingDisclosures?.();
        // Read before the swap: the glide below starts from this height, even
        // when a render lands in the middle of the previous glide.
        const previousHeight = this.isOpen ? this.overlay.querySelector?.('.zkapi-dialog')?.getBoundingClientRect?.().height || 0 : 0;
        const walletView = restored ? { scroll: restored.scroll } : captureWalletView(this);
        const disclosureView = captureFundingDisclosureView(this.overlay);
        const helpFocus = capturePrivateBalanceHelpFocus(this.overlay);
        this.overlay.innerHTML = markup;
        this.renderedMarkup = markup;
        const page = this.pageKey();
        const pageChanged = Boolean(this.renderedPage) && this.renderedPage !== page;
        this.renderedPage = page;

        this.disclosureAnimating = false;
        this.disclosureRefreshPending = false;
        attachWalletMethodControls(this);
        if (getWalletMethod() === 'address') {
            // Local recovery replays stored signed bytes. It does not request a
            // new wallet signature or offer an unsupported fee replacement.
            this.overlay.querySelectorAll('#zkapi-retry-dropped-deposit-btn, #zkapi-retry-dropped-withdrawal-btn, [data-retry-dropped-finalization], [data-retry-dropped-background-withdrawal]').forEach(button => { button.hidden = true; });
        }

        this.disposeFundingDisclosures = attachFundingDisclosures(this.overlay, (key, open) => {
            if (key === 'history') this.historyOpen = open;
            else if (key !== 'setup') (this.privateBalanceHelpOpen ||= {})[key] = open;
            this.rememberRunningModal();
        }, animating => this.handleDisclosureMotion(animating));
        attachPrivateBalanceHelp(this.overlay, this);
        restorePrivateBalanceHelpFocus(this.overlay, helpFocus);
        restoreFundingSetupView(this.overlay, fundingSetup);
        restoreFundingDisclosureView(this.overlay, disclosureView);
        restoreWalletView(this, walletView);
        finishWalletModalRestore(this, { hydrating: isFundingViewHydrating(this), method: getWalletMethod() });
        const layoutAnimation = this.glideDialogHeight(previousHeight);
        if (pageChanged) this.fadeInPage();
        revealWithdrawalTopUp(this, layoutAnimation);
        this.rememberRunningModal();
        attachWithdrawalFees(this);
        this.overlay.querySelector('#zkapi-payment-close')?.addEventListener('click', () => this.close());
        const depositInput = this.overlay.querySelector('#zkapi-deposit-amount');
        // The figure grows with what is typed, like a number, not a field.
        const fitDeposit = () => {
            if (depositInput?.style) depositInput.style.width = `${Math.max(3, String(depositInput.value || '').length + 0.5)}ch`;
        };
        fitDeposit();
        depositInput?.addEventListener('input', () => {
            this.depositAmount = depositInput.value;
            this.rememberRunningModal();
            if (this.outcome?.field === 'deposit') {
                depositInput.removeAttribute('aria-invalid');
                depositInput.removeAttribute('aria-describedby');
                this.overlay.querySelector('#zkapi-deposit-error')?.remove();
                this.outcome = null;
            }
            fitDeposit();
        });
        this.overlay.querySelector('#zkapi-deposit-btn')?.addEventListener('click', () => {
            // Capture the edited amount before run() marks the modal busy and
            // re-renders it with the suggested default value.
            const amount = this.overlay.querySelector('[data-funding-amount]')?.value ?? depositInput?.value ?? this.fundingInputAmount ?? this.depositAmount;
            return this.startDeposit(amount);
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
            if (result?.status === 'confirmed') this.recordDepositConfirmation(result);
            else this.setStatus('Your deposit is not confirmed yet. If MetaMask shows a pending transaction, wait for it to finish.');
        }, { kind: 'deposit', title: 'Checking deposit', phase: 'syncing', blocksSend: true }));
        this.overlay.querySelector('#zkapi-recover-deposit-btn')?.addEventListener('click', () => this.run(async (report) => {
            await zkapiClient.recoverUnknownDeposit(report);
        }, { kind: 'deposit', title: 'Recovering wallet request', phase: 'syncing', blocksSend: true }));
        this.overlay.querySelector('#zkapi-retry-deposit-btn')?.addEventListener('click', () => {
            if (getWalletMethod() === 'address') return this.prepareAddressDepositRetry();
            if (!globalThis.confirm('Only try again if MetaMask is closed and Check payment status still finds no deposit. This asks MetaMask to submit the same saved deposit again.')) return;
            return this.run(async (report) => {
                const result = await zkapiClient.retryUnknownDeposit(report);
                this.depositAmount = null;
                this.recordDepositConfirmation(result);
            }, { kind: 'deposit', title: 'Retrying deposit', phase: 'wallet', blocksSend: true });
        });
        this.overlay.querySelector('#zkapi-retry-dropped-deposit-btn')?.addEventListener('click', () => {
            if (!globalThis.confirm('Resubmit the exact same deposit with its original account nonce? MetaMask may charge a replacement gas fee, but only one transaction at that nonce can execute.')) return;
            return this.run(async (report) => {
                const result = await zkapiClient.retryDroppedDeposit(report);
                this.depositAmount = null;
                this.recordDepositConfirmation(result);
            }, { kind: 'deposit', title: 'Replacing pending deposit', phase: 'wallet', blocksSend: true });
        });
        this.overlay.querySelectorAll('[data-view-current-deposit]').forEach(button => {
            button.addEventListener('click', () => { this.view = 'balance'; this.render(); });
        });
        this.overlay.querySelector('#zkapi-mint-token-btn')?.addEventListener('click', () => this.run(async (report) => {
            await zkapiClient.mintDemoTokens('10', report);
        }, { kind: 'token', title: 'Getting test ZKAPI', phase: 'wallet' }));
        this.overlay.querySelector('#zkapi-refresh-btn')?.addEventListener('click', () => this.run(async (report) => {
            report('Updating balance…', 'syncing');
            await zkapiClient.refresh();
            await zkapiClient.syncExpiryHistory();
            this.setStatus('Balance updated.');
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
        this.overlay.querySelectorAll('#zkapi-withdraw-view-btn, #zkapi-continue-withdrawal-btn').forEach(button => button.addEventListener('click', () => {
            this.view = 'withdraw';
            this.withdrawEntry = 'balance';
            this.withdrawConfirmed = false;
            this.render();
        }));
        this.overlay.querySelector('#zkapi-deposit-dismiss-btn')?.addEventListener('click', () => { if (!this.busy) this.close(); });
        this.overlay.querySelector('#zkapi-withdraw-dismiss-btn')?.addEventListener('click', () => this.dismissWithdrawal());
        this.overlay.querySelector('#zkapi-settle-before-escape')?.addEventListener('click', () => this.run(report => settlePrivateAccess(report), { kind: 'settlement', title: 'Updating chat balance', phase: 'settling' }));
        this.overlay.querySelector('#zkapi-history-back')?.addEventListener('click', () => { this.view = 'balance'; this.render(); });
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
        this.overlay.querySelector('#zkapi-use-escape-btn')?.addEventListener('click', () => {
            if (this.busy) return;
            const available = availableWithdrawalEscape();
            if (!available) { this.render(); return; }
            this.withdrawalEscapeIntent = sameWithdrawalEscape(this.withdrawalEscapeIntent, available) ? null : available;
            this.withdrawMode = this.withdrawalEscapeIntent ? 'escape' : 'mutual';
            this.clearTransientOutcome();
            this.render();
        });
        const withdrawButton = this.overlay.querySelector('#zkapi-withdraw-btn');
        this.overlay.querySelector('[data-funding-withdrawal-destination]')?.addEventListener('input', () => {
            if (withdrawButton) withdrawButton.disabled = !this.withdrawalInputReady();
        });
        withdrawButton?.addEventListener('click', () => this.requestWithdrawal());
        this.overlay.querySelector('#zkapi-withdraw-review-confirm')?.addEventListener('click', () => this.confirmWithdrawal());
        this.overlay.querySelector('#zkapi-withdraw-review-back')?.addEventListener('click', () => {
            this.withdrawalConfirmation = null;
            this.render();
            this.overlay.querySelector('#zkapi-withdraw-btn')?.focus();
        });
        this.overlay.querySelector('#zkapi-cancel-withdrawal-btn')?.addEventListener('click', () => this.run(async (report) => {
            await zkapiClient.cancelPreparedWithdrawal(report);
            this.view = 'balance';
        }, { kind: 'withdraw-sync', title: 'Canceling withdrawal', phase: 'syncing' }));
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
                this.recordWithdrawalOutcome(result);
            }, { kind: 'withdraw', title: 'Retrying withdrawal', phase: 'wallet', blocksSend: true });
        });
        this.overlay.querySelector('#zkapi-retry-dropped-withdrawal-btn')?.addEventListener('click', () => {
            if (!globalThis.confirm('Resubmit the exact same withdrawal with its original account nonce? MetaMask may charge a replacement gas fee, but only one transaction at that nonce can execute.')) return;
            return this.run(async (report) => {
                const result = await zkapiClient.retryDroppedWithdrawal(report);
                this.recordWithdrawalOutcome(result);
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
            this.recordWithdrawalOutcome(result);
        }, { kind: 'escape-finalize', title: 'Finishing account recovery', phase: 'wallet', blocksSend: true }));
        this.overlay.querySelectorAll('[data-finalize-withdrawal]').forEach(button => {
            button.addEventListener('click', () => this.run(async (report) => {
                const result = await zkapiClient.finalizeEscape(button.dataset.finalizeWithdrawal, report);
                this.recordWithdrawalOutcome(result);
            }, { kind: 'escape-finalize', title: 'Finishing withdrawal', phase: 'wallet', withdrawalRecordId: button.dataset.finalizeWithdrawal }));
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
                    this.recordWithdrawalOutcome(result);
                }, { kind: 'escape-finalize', title: 'Retrying finalization', phase: 'wallet', withdrawalRecordId: button.dataset.retryFinalization });
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
                    this.recordWithdrawalOutcome(result);
                }, { kind: 'escape-finalize', title: 'Replacing finalization', phase: 'wallet', withdrawalRecordId: button.dataset.retryDroppedFinalization });
            });
        });
        this.overlay.querySelectorAll('[data-retry-dropped-background-withdrawal]').forEach(button => {
            button.addEventListener('click', () => {
                if (!globalThis.confirm('Resubmit this saved background withdrawal with its original account nonce? MetaMask may charge a replacement gas fee, but only one transaction at that nonce can execute.')) return;
                return this.run(async (report) => {
                    const result = await zkapiClient.retryDroppedBackgroundWithdrawal(
                        button.dataset.retryDroppedBackgroundWithdrawal,
                        report
                    );
                    this.recordWithdrawalOutcome(result);
                }, {
                    kind: 'withdraw',
                    title: 'Replacing background withdrawal',
                    withdrawalRecordId: button.dataset.retryDroppedBackgroundWithdrawal,
                    phase: 'wallet'
                });
            });
        });
        this.overlay.querySelectorAll('[data-withdraw-background]').forEach(button => {
            button.addEventListener('click', () => this.run(async (report) => {
                const result = await zkapiClient.withdrawBackground(button.dataset.withdrawBackground, report);
                this.recordWithdrawalOutcome(result);
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
