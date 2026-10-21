import { revealWithdrawalTopUp } from './WalletModalMotion.js';
import { statusIcon } from './StatusIcon.js';
import { attachWithdrawalFees, needsWithdrawalFees, refreshWithdrawalFees, renderWithdrawalFeeLine, renderWithdrawalFees, stopWithdrawalFees, withdrawalFeeReady, withdrawalFeeReceiptAmounts } from './WithdrawalFees.js';
import { fundingDisclosure, attachFundingDisclosures, captureFundingDisclosureView, restoreFundingDisclosureView } from './FundingDisclosures.js';
import { showSurface, hideSurface, revealText, motionDuration } from '../../ui/uiMotion.js';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { settlePrivateAccess } from '../services/privateAccessSettlement.js';
import { availableWithdrawalEscape, sameWithdrawalEscape, assertWithdrawalEscapeAvailable, canCancelPreparedWithdrawal, escapeNeedsSettlement, assertEscapeReady } from '../services/withdrawalRecovery.mjs';
import { ethUnits, formatSuggestedDeposit } from '../services/depositAmount.mjs';
import { depositOperationId, isWalletCancellation, resetCanceledDeposit } from '../services/canceledDeposit.mjs';
import { readWelcomeModalIntent, writeWelcomeModalIntent } from '../services/welcomeModalIntent.mjs';
import { attachWalletModalRestoreCancellation, cancelWalletModalRestore, currentWalletModalRestore, finishWalletModalRestore } from './WalletModalView.js';
import { parseTokenAmount } from '../services/tokenAmount.mjs';
import { walletErrorMessage } from '@openanonymity/zkapi-browser-sdk/wallet-error';
import { explainZkapiError, isIndexerLag, pendingDepositMessage } from '../services/zkapiErrorCopy.mjs';
import { updateZkapiBalanceControl } from './ZkapiStateExperience.js';
import { captureFundingSetupView, fundingSetupGuide, restoreFundingSetupView } from './FundingSetupGuide.js';
import { walletJourney } from '../domain/walletJourney.js';
import { addressFundingWallet } from '../services/addressFundingProvider.mjs';
import { canQuotePendingAddressDeposit, formatFundingAmount, runAddressAction, withdrawalDestination } from '../services/addressFunding.js';
import { getWalletMethod, initWalletClient, initWalletMethod, prepareWalletMethod, setWalletMethod, subscribeWalletMethod, walletMethodText } from '../services/walletMethod.mjs';
import { attachWalletMethodControls, captureWalletView, fundingInstructionsVisible, refreshWalletView, renderDepositAmount, prepareDepositAmount, renderFundingAccount, renderFundingWei, fundingUsdText, renderMetaMaskTransfer, renderWalletMethod, restoreWalletView, stopFundingFlow, isFundingViewHydrating, syncWalletFlows } from './WalletMethodControls.js';
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
const CANCELED_LINE = 'Canceled in your Ethereum wallet.';
// A submitted transaction needs nothing from the person: the SDK checks
// the chain every 15 s and on focus, and the dialog re-renders on change.
// The check button stays as a quiet fallback for a slow indexer.
// UI intent only; wallet secrets and transaction recovery remain in the SDK.
const RUNNING_MODAL_KEY = 'oa-zkapi-running-modal';
const RESTORABLE_VIEWS = ['balance', 'fund', 'withdraw', 'withdrawals', 'upgrade'];
const IN_MOTION_PHASES = ['submitted', 'awaiting_wallet', 'dropped_or_pending', 'ambiguous'];
const CONFIRMED_REFRESHING_LINE = 'Deposit confirmed and saved. Refreshing your private balance…';
const DEPOSIT_READY_LINE = 'Deposit confirmed. Your private balance is ready.';
const CONFIRMING_LINE = 'Your deposit has been submitted and is waiting to be confirmed on Ethereum.';
// Wallet work narrates in the dialog — the steps while it runs, one line
// with the outcome when it ends. No toasts: with the dialog closed, the
// right panel's activity rows carry the same words.

// -- Protocol versions ------------------------------------------------------
// Everything version-related reaches this file through the facade boot attaches
// to the SDK client (`zkapiClient.oaVersioning`): its gate, its state and the
// UI helpers on its `ui`. This module gains no imports for it (tests evaluate
// it with its import lines removed), and without a facade (single-version
// builds, tests) every helper below reads as "no versions": today's dialog.
// Stages of the upgrade that have a view of their own; the deposit and done
// stages are a lead above the ordinary fund flow.
const UPGRADE_VIEW_STAGES = ['review', 'withdrawing', 'confirming', 'ready_to_switch', 'blocked'];
const LEAD_STAGES = ['deposit', 'done'];
// The stages in which the upgrade's own withdrawal is in motion.
const WITHDRAWAL_STAGES = ['withdrawing', 'confirming'];
// The stages that embed the withdrawal's markup (the others never read it).
const EMBEDDING_STAGES = ['review', 'withdrawing', 'confirming', 'blocked'];
// How long the upgrade view waits for the version watcher's next holdings read
// after the upgrade's withdrawal ended (confirmed here, or seen closing in the
// background), before it falls back to the balance.
const UPGRADE_SETTLE_MS = 15_000;
// The notices (by id, as the version banner marks them) that a view already
// says in full, so its banner stays out of the way. A banner that holds
// anything else (a deadline, a cleared draft, a loop warning, an operator
// notice) is shown whole: a repeated sentence costs a line, a lost reminder
// can cost a balance.
// The held-balance view says its own notice (`held`) in full as well.
const CLOSED_VIEW_NOTICES = ['gate', 'unsent', 'reload', 'held'];
// The closed view marks the paragraph in which it says another version's
// unfinished withdrawal (and offers "Open version N"). Only then is the
// banner's own `previous` notice a repeat: the view says it for the gate that
// names it, and beside the deposits-moved text for an exit-only version.
const CLOSED_VIEW_PREVIOUS_MARK = 'data-zkapi-closed-previous';
const PREVIOUS_NOTICE = 'previous';
const LEAD_NOTICES = ['deposit', 'done'];
// What stands for a balance this browser holds and the page can not read (the
// version's SDK did not start) before the version helpers have arrived. The
// helpers say it in full (ui.heldBalance); this is only the one honest line.
const HELD_BALANCE_LINE = 'Your balance is still saved in this browser, but its service isn’t available right now. Reload to check again.';
const SWITCH_REFUSALS = {
    busy: 'Finish the current step first.',
    loop: 'Close other open tabs of this app, then reload.',
    no_target: 'Reload this page to continue.'
};
const LEGACY_WITHDRAWAL_SELECTORS = ['0x7fca9c82', '0x9073639b', '0xff8f5585'];

function versionFacade() {
    try { return zkapiClient.oaVersioning || null; } catch { return null; }
}

// The deposit gate, or null when nothing restricts deposits (no facade). A
// facade that is present but cannot answer fails closed.
function depositGate() {
    const facade = versionFacade();
    if (!facade || typeof facade.depositGate !== 'function') return null;
    try {
        const gate = facade.depositGate();
        return gate && typeof gate === 'object' ? gate : { canStart: false, canResume: false, code: null };
    } catch { return { canStart: false, canResume: false, code: null }; }
}

// Whether the facade says this browser holds a balance of the loaded version
// that the page can not read, because that version's SDK did not start (the
// state's `held`). Never throws; false without a facade.
function balanceHeldUnreachable() {
    try {
        const state = versionFacade()?.state?.();
        return Boolean(state) && typeof state === 'object' && state.held?.unreachable === true;
    } catch { return false; }
}

// May a deposit start, or (with a saved one) be finished here?
function depositMayStart(hasSaved = false) {
    const gate = depositGate();
    return gate === null || gate.canStart === true || (gate.canResume === true && hasSaved === true);
}

// The words for a refused deposit start. A version that stopped taking
// deposits says so; a page that is only out of date (another tab moved the
// balance: gate code reload_required) says to reload, because that version
// still takes deposits.
function depositsClosedLine({ withReload = false } = {}) {
    if (depositGate()?.code === 'reload_required') return 'This page is out of date. Reload to continue.';
    return withReload
        ? 'This version no longer accepts new deposits. Reload to continue.'
        : 'This version no longer accepts new deposits.';
}

// The network and version a tab-saved dialog view was written under. Empty
// without versioning (no facade, or a build with one live version, whose
// facade is dormant), so today's saved shape is unchanged and an entry that
// today's build wrote stays valid after versions are activated.
function versionStamp() {
    try {
        const facade = versionFacade();
        if (!facade || facade.multiVersion !== true) return {};
        const active = facade.active;
        if (!active || typeof active.id !== 'string') return {};
        const chainId = Number(active.chainId);
        const network = chainId === 1 ? 'mainnet' : chainId === 11155111 ? 'sepolia' : null;
        return network ? { network, versionId: active.id } : { versionId: active.id };
    } catch { return {}; }
}

// A saved view of another version or network is stale. An entry with no stamp
// (written before versions existed, or by a version switch) stays valid.
function stampMatches(saved) {
    if (!saved || typeof saved !== 'object') return false;
    const now = versionStamp();
    if (typeof saved.versionId === 'string' && now.versionId && saved.versionId !== now.versionId) return false;
    if (typeof saved.network === 'string' && now.network && saved.network !== now.network) return false;
    return true;
}

// Calldata selectors of the calls that leave a balance, from the installed
// protocol's call profile (the legacy three without one).
function withdrawalSelectors() {
    try {
        const profile = addressFundingWallet.signerProtocol?.().profile;
        const selectors = [...(profile?.exits || []).map(exit => exit?.selector), profile?.finalize?.selector, profile?.claim?.selector]
            .filter(selector => typeof selector === 'string' && selector)
            .map(selector => (selector.startsWith('0x') ? selector : `0x${selector}`));
        if (selectors.length) return selectors;
    } catch { /* The legacy list below. */ }
    return LEGACY_WITHDRAWAL_SELECTORS;
}

// A closed escape whose payout the payment contract could only credit (the
// address would not take it) and that no claim has delivered. This is the
// shared predicate of versioning/walletHoldings.mjs, which this file may not
// load by name; a test pins that the two agree. Such a row is "Payout held":
// it is never "returned", and it is claimed from its own row.
function holdsPayout(record) {
    return Boolean(record) && record.payoutCredited === true && record.payoutClaimed !== true
        && ['closed', 'closed_unconfirmed'].includes(record.phase);
}

// Who a withdrawal pays. A sponsored one is bound to a holding address (its
// `destination`) and names the person's address in `payout`: that is the one
// a row says. Anything else pays its destination.
function recordPayee(record) {
    if (record && record.feePayer === 'payout' && /^0x[0-9a-fA-F]{40}$/.test(record.payout || '')) return record.payout;
    return record?.destination || null;
}

// What a row of Payment history adds when there is nothing to add.
const NO_RECORD_EXTRAS = Object.freeze({
    label: null, badge: null, noteHtml: '', actionsHtml: '', hideActions: false, hideError: false
});
// The most of an SDK sentence that is shown in the dialog's own status line.
const SDK_SENTENCE_LIMIT = 500;
// Said when Send to address pays from the withdrawal and a quote of this
// withdrawal answered but cannot be planned.
const ADDRESS_WITHDRAWAL_UNPLANNED_LINE = 'Paying the network fee from this withdrawal isn’t available right now. '
    + 'Use Ethereum wallet to withdraw this balance instead.';
// Said when the page was drawn for another kind of withdrawal, or before the
// most a settling chat could cost grew: nothing starts on a figure the person
// was not shown.
const STALE_EXIT_CHOICE_LINE = 'What this withdrawal could give up has changed. Review it below, then choose again.';
// Said in place of the choice once the time a settling chat had to settle has
// passed. There is nothing left to wait for, and whatever was asked the SDK
// leaves at once as an emergency exit that gives up the whole figure.
const SETTLEMENT_PASSED_LINE = 'The time that chat had to settle has passed. A withdrawal now leaves at once, '
    + 'as an emergency exit, and gives up the most that chat could cost, even if it cost less.';
// Said when that time passed after the page was drawn with the choice: what was
// picked (waiting, or giving up nothing now) no longer happens.
const SETTLEMENT_PASSED_STALE_LINE = 'The time that chat had to settle has passed, so a withdrawal now leaves at once '
    + 'and gives up what that chat could cost. Review it below, then continue if you want to.';
// The marker of the choice fieldset the version helpers draw (ExitChoice).
const EXIT_FIELDSET_HOOK = 'data-zkapi-exit-fieldset';

// The time a settling chat has to settle (T), in epoch milliseconds, or null:
// the later of the times the state holds (a held refusal can be older than the
// standing state, and the SDK's own wait is never shorter than either).
function settlementTimeOf(state) {
    const exit = state && typeof state === 'object' ? state.exit : null;
    if (!exit || typeof exit !== 'object') return null;
    const wait = exit.wait && typeof exit.wait === 'object' && exit.wait.kind === 'settlement' ? exit.wait : null;
    const times = [exit.escapeAtMs, wait ? wait.escapeAtMs : null].filter(at => Number.isFinite(at) && at > 0);
    return times.length > 0 ? Math.max(...times) : null;
}

// Whether T is behind us. From T the SDK no longer waits for that chat and no
// longer honors "give up nothing now": a withdrawal of any kind leaves at once
// as an emergency exit that gives up the whole of what the chat could cost. A
// page that still offers to wait, or to give up nothing, would say the
// opposite of what happens. `drawnAt` is the T a page was drawn under: a wait
// that has since run out no longer carries it in the state, and the choice
// that was drawn under it is out of date all the same. A state that has
// settled has no such time. A time that is not known is not a passed one (the
// SDK then decides, and the signer holds the figure that was shown).
function settlementTimePassed(state, now, drawnAt = null) {
    if (state?.exit?.stateFresh === true) return false;
    if (drawnAt !== null && drawnAt <= now) return true;
    const at = settlementTimeOf(state);
    return at !== null && at <= now;
}

// The most a settling chat could cost by the state now: the larger of the
// figures it holds (the choice is drawn from the same two), or null.
function currentExitBound(state) {
    const exit = state && typeof state === 'object' ? state.exit : null;
    if (!exit || typeof exit !== 'object') return null;
    const figures = [exit.wait?.boundAtState, exit.boundAtState]
        .filter(value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,29})$/.test(value));
    return figures.length ? figures.reduce((best, value) => (BigInt(value) > BigInt(best) ? value : best)) : null;
}

// Whether the figure the person was shown (`shown`, gwei) no longer is the
// state's. A figure that grew was never seen. Giving up the figure is chosen
// for that figure exactly (the signer holds the withdrawal to it), so for that
// choice a figure that shrank is out of date as well: the SDK would give up
// the smaller one and the signer would refuse it after the work was done.
function exitFigureMoved(state, choice, shown) {
    const current = currentExitBound(state);
    if (current === null || typeof shown !== 'string') return false;
    return choice === 'bound' ? current !== shown : BigInt(current) > BigInt(shown);
}

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
        // Who pays the network fee of the withdrawal in front of the person
        // ('wallet' unless they chose 'payout') and the last quote for it.
        // Nothing is asked of the relay until they choose to pay from the
        // withdrawal; a form that is only opened sends nothing.
        this.sponsoredChoice = 'wallet';
        this.sponsoredQuote = null;
        this.sponsoredSeq = 0;
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
        // The dialog's own busy flags are what a version reload must wait for.
        // The facade's state moves on snapshot changes, watcher events and
        // tier boundaries, never per clock tick: re-render on those.
        const facade = versionFacade();
        this.unregisterBusy = facade?.registerBusy?.(() => this.busy === true || this.fundingBusy === true) ?? null;
        this.versionUnsubscribe = facade?.subscribe?.(() => this.handleVersionChange()) ?? null;
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
            // A start that failed while this browser holds a balance the page
            // can not read is told by the balance (its notice, in plain
            // words): the SDK's message names the service's address.
            this.fundingError = balanceHeldUnreachable() ? '' : error.message;
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

    handleVersionChange() {
        // The upgrade view is opened or closed inside render(); the facade
        // answers that change synchronously and render() reads fresh state.
        if (this.versionSyncing || !this.isOpen) return;
        this.updateTabIndicator();
        // Another version's payments are read again only while they are on
        // screen (the facade coalesces and rate-limits the read). Asked here,
        // on a change the facade announced, and never from a render.
        if (this.view === 'withdrawals' || this.historyOpen) this.refreshOtherVersionHistory();
        // An SDK change moves the facade's state and this dialog's own
        // subscription in the same breath: one render serves both.
        const rendered = this.renderCount || 0;
        queueMicrotask(() => {
            if (!this.isOpen || (this.renderCount || 0) !== rendered || !this.canRefreshContent()) return;
            if (this.disclosureAnimating) this.disclosureRefreshPending = true;
            else this.render();
        });
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
                    scroll: Number.isFinite(scroll) ? scroll : 0,
                    ...versionStamp()
                }));
            } else {
                window.sessionStorage?.removeItem(RUNNING_MODAL_KEY);
            }
        } catch { /* Restricted storage must not block wallet work. */ }
    }

    readRunningModal() {
        try {
            const saved = JSON.parse(window.sessionStorage?.getItem(RUNNING_MODAL_KEY) || 'null');
            return RESTORABLE_VIEWS.includes(saved?.view) && stampMatches(saved) ? saved : null;
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
        if (!saved && stampMatches(readWelcomeModalIntent()) && !withdrawalNeedsRecovery && !backgroundNeedsRecovery) {
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
            this.open(withdrawalSelectors().includes(selector) ? 'withdraw' : 'fund');
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
        if (!this.isOpen) {
            this.returnFocusEl = document.activeElement;
            // A choice about a settling chat belongs to the visit it was made
            // in: a dialog opened later starts from the default again.
            this.exitChoice = null;
        }
        this.view = view;
        this.isOpen = true;
        this.renderedMarkup = null;
        this.renderedPage = null;
        // Cancel on a new withdrawal goes back where it came from.
        this.withdrawEntry = null;
        this.withdrawConfirmed = false;
        this.withdrawalConfirmation = null;
        this.upgradeStageSeen = null;
        this.upgradeSettleSince = 0;
        // Preserve explicit dialog intent even while idle or after completion.
        // Only dismissal removes it; reopening never submits a transaction.
        this.rememberRunningModal();
        this.clearTransientOutcome();
        this.status = '';
        this.statusError = false;
        this.render();
        this.refreshOtherVersionHistory();
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
        this.syncUpgradeView();
        this.upgradeStageSeen = null;
        this.upgradeSettleSince = 0;
        this.upgradeSettleShown = false;
        this.unsentCleared = false;
        this.draftClearedHere = false;
        this.exitChoice = null;
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
        // A version that stopped taking deposits starts no quote, draft or
        // wallet request; a deposit already started stays completable.
        if (!depositMayStart(Boolean(pending))) {
            this.outcome = { tone: 'error', message: depositsClosedLine(), view: this.view };
            this.render();
            return;
        }
        // Validate before run() or the SDK can open a wallet request.
        try {
            if (!pending && !String(amount ?? '').trim()) throw new Error('Enter an amount to deposit.');
            // Saved SDK amounts are already in billing units; never parse
            // their USD display or reprice a native deposit during recovery.
            const parsed = pending ? BigInt(pending.amount) : this.fundingInputCurrency === 'eth' ? ethUnits(amount) : parseTokenAmount(amount);
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
        if (!pending) {
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
        }, { kind: 'deposit', title: 'Adding funds', phase: 'wallet', message: 'Connecting to your Ethereum wallet…', blocksSend: true });
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
                if (busyLabel) busyLabel.textContent = walletMethodText(busyLabel.hasAttribute?.('data-zkapi-deposit-wait') ? this.depositWaitLabel(journey) : this.busyLabel(journey));
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
        const journey = walletJourney({
            kind,
            message,
            persistedPhase: persistedPhase || (kind === 'deposit' ? zkapiClient.config?.pending_deposit?.phase : ''),
            last: this.journeyKind === kind ? this.journeyLast : null,
            failed,
            hasLease: Boolean(zkapiClient.activeLease),
            addressFunding: getWalletMethod() === 'address',
            escapePeriod: typeof zkapiClient.escapePeriodPhrase === 'function' ? zkapiClient.escapePeriodPhrase() : ''
        });
        // A withdrawal the upgrade view embeds is the first step of an upgrade
        // and is called that; the same journey elsewhere keeps its own name.
        if (this.view === 'upgrade' && kind !== 'deposit') journey.category = 'Upgrading your balance';
        return journey;
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
        return journey?.steps?.some(step => step.state === 'waiting') ? 'Waiting for your Ethereum wallet…'
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
        // Both methods end the same way: the steps, then one quiet line that
        // says what is happening. No disabled button, no dead Close.
        return `
            <div class="zkapi-stack">
                <section class="zkapi-figure-block" aria-label="Deposit in progress">
                    <p class="zkapi-balance-caption">Deposit</p>
                    ${amount ? `<p class="zkapi-balance-amount">${this.escapeHtml(amount)}</p>` : ''}
                </section>
                ${this.renderJourney(journey)}
                <p class="zkapi-funding-wait zkapi-deposit-wait" role="status"><span class="zkapi-pill-spinner" aria-hidden="true"></span><span data-zkapi-busy-label data-zkapi-deposit-wait>${walletMethodText(this.depositWaitLabel(journey))}</span></p>
                ${address ? this.literal(renderFundingAccount(this, { receipt: true })) : ''}
                <div class="zkapi-guides">${this.renderWithdrawalStatusLink()}</div>
            </div>`;
    }

    /** The deposit's quiet line: the current step, or the wait for the chain. */
    depositWaitLabel(journey) {
        const current = journey?.steps?.find(step => ['active', 'waiting', 'paused'].includes(step.state));
        if (!current) return 'Depositing…';
        if (current.id === 'chain') return 'Waiting for Ethereum · usually under a minute';
        return current.label;
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
        this.patchVersionNotices(now);
        this.settleUpgradeView();

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
                setText(finalizeButton, ready ? walletMethodText('Finalize in your Ethereum wallet') : `Finalize in ${remaining}`);
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

    // The version notices' countdown text moves on the clock channel like the
    // expiry label: text only, nothing remounted. The helper says when a tier or
    // the expiry was crossed, which is the one reason to render again. Without
    // a mounted countdown there is nothing to patch and no state to compute.
    patchVersionNotices(now) {
        if (!this.overlay?.querySelector?.('[data-zkapi-version-closeby], [data-zkapi-version-tier], [data-zkapi-version-badge]')) return;
        const version = this.currentVersion();
        if (!version?.ui || typeof version.ui.patch !== 'function') return;
        let result = null;
        try { result = version.ui.patch(this.overlay, version.state, { now, surface: 'dialog' }); } catch { result = null; }
        if (result?.needsRender === true && this.bannerWithheld(version)) result = { needsRender: false };
        if (result?.needsRender === true && !this.busy && !this.disclosureAnimating && this.canRefreshContent()) this.render();
    }

    // A banner this render left out on purpose (the view says it in full) is
    // not a banner the state "calls for and the page lacks": the helper's patch
    // cannot tell the two apart and would ask for a new render on every tick.
    // What the state calls for now is read again: a notice the view does not
    // say (a loop warning that was raised since) and a pill that appeared or
    // went are changes, and still render.
    bannerWithheld(version) {
        if (this.versionBannerSuppressed !== true) return false;
        if (this.overlay?.querySelector?.('[data-zkapi-version-banner]')) return false;
        try {
            const html = String(version.ui.banner?.(version.state, { surface: 'dialog', now: Date.now() }) || '');
            if (html && !this.bannerIsRepeated(version, html, this.versionBannerRepeated === true,
                this.versionBannerSaysPrevious === true)) return false;
        } catch { return false; }
        const mounted = Boolean(this.overlay?.querySelector?.('[data-zkapi-version-badge]'));
        let wanted = mounted;
        try {
            if (typeof version.ui.badge === 'function') {
                wanted = String(version.ui.badge(version.state, { surface: 'dialog' }) || '') !== '';
            }
        } catch { wanted = mounted; }
        return wanted === mounted;
    }

    // The upgrade view's wait for a holdings read is bounded. Once the bound
    // has passed the view has nothing more to say and the balance takes over;
    // nothing else would render it, a quiet page makes no change events.
    settleUpgradeView() {
        if (this.upgradeSettleShown !== true || this.upgradeSettling()) return;
        if (this.busy || this.disclosureAnimating || !this.canRefreshContent()) return;
        this.render();
    }

    /** The facade, its state and its UI helpers, or null when this page has no
     *  version context to show (single-version builds, tests). */
    versionContext() {
        const facade = versionFacade();
        if (!facade || facade.multiVersion !== true || typeof facade.state !== 'function') return null;
        let state = null;
        try { state = facade.state(); } catch { state = null; }
        if (!state || typeof state !== 'object') return null;
        // Read at render time: the helpers can arrive after the first paint.
        return { facade, state, ui: facade.ui && typeof facade.ui === 'object' ? facade.ui : null };
    }

    // One state per render: render() reads it once and every view of that
    // render shares it. A direct call to a view method reads its own.
    currentVersion() {
        return this.renderedVersion !== undefined ? this.renderedVersion : this.versionContext();
    }

    // The upgrade view is on while the dialog shows it. The facade learns that
    // here (never from inside its own notification), so its stage can be
    // `review` and the upgrade intent starts only on the person's own gesture.
    syncUpgradeView() {
        const facade = versionFacade();
        const want = this.isOpen === true && this.view === 'upgrade';
        if (want === Boolean(this.upgradeViewOpen)) return;
        this.upgradeViewOpen = want;
        if (!facade) return;
        this.versionSyncing = true;
        try { if (want) facade.beginUpgrade?.(); else facade.endUpgrade?.(); }
        catch { /* Presentation only. */ }
        finally { this.versionSyncing = false; }
    }

    // The view the upgrade view really is, for the stage the page is at: the
    // steps of the withdrawal have a view of their own; the deposit step is the
    // ordinary fund flow under the upgrade's lead; anything else has no upgrade
    // to show and falls back to the balance.
    upgradeViewTarget(version) {
        if (!version?.ui || typeof version.ui.upgradeView !== 'function') return 'balance';
        const stage = version.state.upgrade?.stage;
        // A page that must reload (the balance moved in another tab, an
        // unused quote was cleared) has no upgrade to walk through: the review
        // form and its withdraw button would be a dead end that explains
        // nothing. The balance carries the reload notice and its button. Only
        // the ready step IS the reload.
        if (version.state.reload?.required === true && stage !== 'ready_to_switch') return 'balance';
        if (UPGRADE_VIEW_STAGES.includes(stage) || LEAD_STAGES.includes(stage)) return 'upgrade';
        // The moment after the upgrade's withdrawal ended: the holdings read
        // that makes Reload the next step is still on its way.
        if (stage === 'idle' && this.upgradeSettling()) return 'upgrade';
        return 'balance';
    }

    // The facade's stage is `idle` between the withdrawal's record closing and
    // the watcher's next holdings read (which makes Reload the next step).
    // Only a withdrawal this view watched end is that gap: a stage that was
    // never in motion (a stale restore, a balance that left some other way)
    // has nothing to wait for. The wait is bounded.
    upgradeSettling() {
        if (this.view !== 'upgrade') return false;
        const now = Date.now();
        // Confirmed by this very dialog.
        if (this.withdrawalCompleted === true && now - Number(this.withdrawalCompletedAt || 0) < UPGRADE_SETTLE_MS) return true;
        // Seen closing in the background (a confirmation the SDK reconciled).
        const since = Number(this.upgradeSettleSince || 0);
        return since > 0 && now - since < UPGRADE_SETTLE_MS;
    }

    // What the upgrade view last drew, from the state of this render: the one
    // thing `upgradeSettling` needs that the state alone does not say. Runs
    // once per render, before the view is decided.
    noteUpgradeStage(version) {
        if (this.view !== 'upgrade') {
            this.upgradeStageSeen = null;
            this.upgradeSettleSince = 0;
            return;
        }
        const stage = version?.state?.upgrade?.stage;
        if (stage === 'idle') {
            // Nothing is held any more and the withdrawal was in motion: it ended.
            if (!this.upgradeSettleSince && WITHDRAWAL_STAGES.includes(this.upgradeStageSeen)
                && version.state.holding === 'none') {
                this.upgradeSettleSince = Date.now();
            }
            return;
        }
        this.upgradeStageSeen = stage || null;
        this.upgradeSettleSince = 0;
    }

    // The pill and its explanation. The pill carries the help toggle; the
    // panel it opens sits beside the other help panels of the balance card.
    renderVersionBadge(version) {
        if (!version?.ui || typeof version.ui.badge !== 'function') return { badge: '', help: '' };
        try {
            // The `?` is the shared help button (`data-zkapi-help="version"`):
            // attachPrivateBalanceHelp opens and closes the panel below like
            // the expiry help (click, Enter/Space, outside click, Escape back
            // to the button), and the open state is this dialog's, so a
            // re-render keeps it.
            const open = Boolean(this.privateBalanceHelpOpen?.version);
            const badge = String(version.ui.badge(version.state, { surface: 'dialog', helpOpen: open }) || '');
            if (!badge.includes('data-zkapi-help="version"')) return { badge, help: '' };
            let detail = null;
            try { detail = version.ui.help?.('version', version.state) ?? null; } catch { detail = null; }
            return { badge, help: privateBalanceHelpContent('modal', 'version', open, detail) };
        } catch { return { badge: '', help: '' }; }
    }

    // The notices the version has for this dialog (static text, no live
    // region). A view that already says the same thing in full (the deposits
    // closed view, the upgrade view's own lead) passes `repeated`, and the
    // banner then stays out when every notice in it is one that view says.
    renderVersionBanner(version, { repeated = false, saysPrevious = false } = {}) {
        if (!version?.ui || typeof version.ui.banner !== 'function') return '';
        let html = '';
        try { html = String(version.ui.banner(version.state, { surface: 'dialog', now: Date.now() }) || ''); }
        catch { return ''; }
        if (html && this.bannerIsRepeated(version, html, repeated, saysPrevious)) {
            this.versionBannerSuppressed = true;
            this.versionBannerRepeated = repeated === true;
            this.versionBannerSaysPrevious = saysPrevious === true;
            return '';
        }
        return html;
    }

    // Whether the view this banner would sit in already says all it holds. The
    // banner is read, not assumed from a phase: a set-aside note's deadline
    // shares a phase with the "withdrawal still finishing" notice the closed
    // view does repeat, and only the first of them is a reminder to lose. The
    // view's own markup says what it says (`saysPrevious`): a closed view that
    // does not offer another version's withdrawal leaves that notice to the
    // banner.
    bannerIsRepeated(version, html, repeated, saysPrevious = false) {
        const lead = this.leadShown(version);
        if (!repeated && !lead) return false;
        const state = version.state;
        // Host markup (the activation change's notices) is never repeated.
        try {
            const extra = typeof version.ui.protocolNotices === 'function' ? version.ui.protocolNotices() : '';
            if (typeof extra === 'string' && extra) return false;
        } catch { /* nothing extra */ }
        const covered = new Set();
        if (repeated) {
            for (const id of CLOSED_VIEW_NOTICES) covered.add(id);
            // Another version's withdrawal, said (and openable) in the view.
            // This version's own set-aside note is never that: its deadline is
            // the banner's.
            if (saysPrevious && state.previous?.versionId !== state.current?.id) covered.add(PREVIOUS_NOTICE);
        }
        if (lead) for (const id of LEAD_NOTICES) covered.add(id);
        const ids = [...html.matchAll(/data-zkapi-version-notice="([^"]+)"/g)].map(match => match[1]);
        // A banner this cannot read is shown: it is the safe way to be wrong.
        return ids.length > 0 && ids.every(id => covered.has(id));
    }

    // A reminder tier the person was just shown here is not shown to them again
    // as a toast. Per viewer, once per tier, and only for what was on screen.
    acknowledgeShownReminder(version, shown) {
        const tier = version?.state?.reminderTier;
        if (!shown || !this.isOpen || !Number.isFinite(tier) || tier === this.acknowledgedTier) return;
        if (!String(version.state.phase || '').startsWith('upgrade-')) return;
        this.acknowledgedTier = tier;
        try { version.facade.acknowledgeReminder?.(tier); } catch { /* A per-viewer convenience. */ }
    }

    // The deposit and done stages seen from the upgrade view: the steps and
    // the stage's one sentence, above the ordinary fund flow.
    leadShown(version) {
        return this.view === 'upgrade' && LEAD_STAGES.includes(version?.state?.upgrade?.stage);
    }

    renderVersionLead(version) {
        return this.leadShown(version) ? this.renderUpgradeContext(version, '') : '';
    }

    // The two facts a VersionState does not carry that make a reload's words
    // exact (ui.facts(): the intent says the withdrawal ended; what the
    // freshest read of the wallet found). Read when rendered, never cached.
    versionFacts(version) {
        const facts = {};
        try {
            const read = typeof version?.ui?.facts === 'function' ? version.ui.facts() : null;
            if (read && typeof read.withdrawalConfirmed === 'boolean') facts.withdrawalConfirmed = read.withdrawalConfirmed;
            if (read && typeof read.previewReason === 'string') facts.previewReason = read.previewReason;
        } catch { /* The words stay general. */ }
        return facts;
    }

    // `outcome`: the dialog's one-line result of the last button, for the
    // stages whose markup does not embed the withdrawal (which carries it).
    renderUpgradeContext(version, withdrawalHtml, { outcome = '' } = {}) {
        if (!version?.ui || typeof version.ui.upgradeView !== 'function') return '';
        const state = version.state;
        const destination = this.upgradeDestination || {};
        const choice = this.upgradeDestinationChoice(version);
        let sepolia = false;
        try { sepolia = Number(zkapiClient.config?.funding?.chain_id) === 11155111; } catch { sepolia = false; }
        const balanceWei = this.fundingStatus && /^\d+$/.test(String(this.fundingStatus.ethBalance)) ? String(this.fundingStatus.ethBalance) : null;
        try {
            return String(version.ui.upgradeView({
                state, stage: state.upgrade.stage, funding: getWalletMethod() === 'address' ? 'address' : 'metamask',
                withdrawalHtml, sepolia,
                // What is submitted is what is shown: with nothing typed here
                // yet, the address field shows the one the dialog already holds.
                destination: { choice, newAddress: destination.newAddress || null,
                    typed: typeof destination.typed === 'string' ? destination.typed : choice === 'other' ? String(this.fundingDestination || '') : '' },
                busy: this.busy === true || this.fundingBusy === true || this.versionActionBusy === true,
                withdrawn: this.upgradeSettling(),
                table: version.facade.table,
                canCreateAddress: this.canCreateUpgradeAddress(version),
                creatingAddress: this.upgradeAddressBusy === true,
                addressError: this.upgradeAddressError || '',
                gas: { balanceWei },
                outcomeHtml: outcome,
                unsentCleared: this.unsentCleared === true,
                draftClearedHere: this.draftClearedHere === true,
                ...this.versionFacts(version)
            }) || '');
        } catch { return ''; }
    }

    /** What replaces "Add funds" when this page may not start a deposit; ''
     *  when it may (or when a deposit is already started and finishable). */
    renderDepositsClosed(version, pendingDeposit) {
        const gate = depositGate();
        if (gate === null || gate.canStart === true || (gate.canResume === true && Boolean(pendingDeposit))) return '';
        let closed = '';
        let helped = false;
        if (version?.ui && typeof version.ui.depositsClosedView === 'function') {
            try {
                closed = String(version.ui.depositsClosedView({
                    state: version.state, unsent: version.state.unsent === true,
                    retired: version.facade.selection?.reason === 'retired_deployment',
                    busy: this.busy === true || this.fundingBusy === true || this.versionActionBusy === true,
                    table: version.facade.table,
                    unsentCleared: this.unsentCleared === true,
                    draftClearedHere: this.draftClearedHere === true,
                    ...this.versionFacts(version)
                }) || '');
            } catch { closed = ''; }
            helped = closed !== '';
        }
        // Before the helpers arrive nothing may offer a deposit that cannot start.
        if (!closed) closed = `<section class="zkapi-section" data-zkapi-deposits-closed aria-label="Deposits unavailable"><p class="zkapi-helper">${depositsClosedLine({ withReload: true })}</p></section>`;
        // The banner stays out only for what the closed view really said: the
        // plain line above says none of it.
        const banner = this.renderVersionBanner(version, {
            repeated: helped, saysPrevious: helped && closed.includes(CLOSED_VIEW_PREVIOUS_MARK)
        });
        return `<div class="zkapi-stack">
            ${banner}${closed}
            ${this.renderOutcome()}
            ${this.busy ? this.renderProgress(this.status || 'Working…') : ''}
            ${this.renderWithdrawalStatusLink()}
        </div>`;
    }

    /** "Version N deposits wait until this finishes." Only where a deposit
     *  here is held back by an unfinished withdrawal, and never without a
     *  version to name. */
    depositsWaitLine() {
        const gate = depositGate();
        if (!gate || gate.canStart === true || !['deposits_closed', 'previous_withdrawal_open'].includes(gate.code)) return '';
        const label = typeof this.currentVersion()?.state?.target?.label === 'string'
            ? this.currentVersion().state.target.label.trim() : '';
        return label ? `${label} deposits wait until this finishes.` : '';
    }

    // -- Upgrade destination ------------------------------------------------

    canCreateUpgradeAddress(version) {
        return typeof version?.ui?.rescue?.createScopedFundingProvider === 'function' && Boolean(version?.facade?.target);
    }

    // What the destination controls show as picked: the person's choice, else
    // the funding address of the new version when this page can create one.
    upgradeDestinationChoice(version) {
        const choice = this.upgradeDestination?.choice;
        if (choice === 'new-address' || choice === 'other') return choice;
        return this.canCreateUpgradeAddress(version) ? 'new-address' : 'other';
    }

    // The address that receives the upgrade's withdrawal, as typed or created.
    // Nothing is created without the person's click on "Create address".
    applyUpgradeDestination(version) {
        const destination = this.upgradeDestination || {};
        this.fundingDestination = this.upgradeDestinationChoice(version) === 'new-address'
            ? destination.newAddress || '' : typeof destination.typed === 'string' ? destination.typed : '';
    }

    async createUpgradeAddress() {
        const version = this.versionContext();
        const rescue = version?.ui?.rescue;
        const target = version?.facade?.target;
        if (this.busy || this.fundingBusy || !this.canCreateUpgradeAddress(version)) return;
        this.fundingBusy = true;
        this.upgradeAddressBusy = true;
        this.upgradeAddressError = '';
        this.render();
        try {
            // The helper may hand the provider back directly or lazily.
            const provider = await rescue.createScopedFundingProvider(target);
            const created = await provider.ensureAddress();
            const address = typeof created === 'string' ? created : created?.address;
            if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) throw new Error('The address could not be created.');
            this.upgradeDestination = { ...(this.upgradeDestination || {}), choice: 'new-address', newAddress: address };
            this.fundingDestination = address;
        } catch (error) {
            this.upgradeAddressError = error?.shortMessage || error?.message || 'The address could not be created.';
        } finally {
            this.fundingBusy = false;
            this.upgradeAddressBusy = false;
            if (this.isOpen) this.render();
        }
    }

    // -- Version buttons ----------------------------------------------------

    // Buttons the version views carry (data-zkapi-version-action). The notices'
    // own buttons are wired by the banner's delegation (ui.attach); the ones in
    // the upgrade and deposits-closed views are wired here. Both end in the
    // same place: a facade call on the person's own click. Without a helper
    // that delegates (the helpers have not loaded, or lack it), the banner's
    // buttons are wired here as well, so none of them is ever dead.
    attachVersionActions(version) {
        if (!version || !this.overlay?.querySelectorAll) return;
        const context = {
            surface: 'dialog',
            notify: text => this.noticeVersionOutcome(text),
            refresh: () => { if (this.isOpen && !this.busy) this.render(); },
            dispatch: (name, detail) => { if (name === 'zkapi-payment-required') this.goToView(detail?.view || 'fund'); }
        };
        let delegated = false;
        if (typeof version.ui?.attach === 'function') {
            try { version.ui.attach(this.overlay, context); delegated = true; } catch { /* The buttons below still work. */ }
        }
        this.overlay.querySelectorAll('[data-zkapi-version-action]').forEach(button => {
            const holder = button.closest?.('[data-zkapi-version-banner]');
            if (holder && delegated) return;
            const noticeId = button.closest?.('[data-zkapi-version-notice]')?.dataset?.zkapiVersionNotice;
            button.addEventListener('click', () => {
                void this.runVersionAction(button.dataset.zkapiVersionAction, noticeId ? { ...context, noticeId } : context);
            });
        });
    }

    noticeVersionOutcome(text) {
        if (!text) return;
        this.outcome = { message: text, tone: 'info', view: this.view };
        if (this.isOpen && !this.busy) this.render();
    }

    // Open a view of the dialog that is already open, or open it.
    goToView(view) {
        if (!this.isOpen) { this.open(view); return; }
        this.clearTransientOutcome();
        this.view = view;
        this.render();
        if (view === 'withdrawals') this.refreshOtherVersionHistory();
    }

    // Ask the facade to read the payments of the other versions, if this page
    // has any (it has none without versions to tell apart, and the facade then
    // has no `history`). Called when the dialog opens, when Payment history
    // opens and when the facade says something changed while it is showing,
    // never from a render. The facade coalesces the reads; a read that fails
    // is "unknown" to it, never an error here.
    refreshOtherVersionHistory() {
        try {
            const history = versionFacade()?.history;
            if (history && typeof history.ensureFresh === 'function') void history.ensureFresh();
        } catch { /* Presentation only. */ }
    }

    // The payments of the other versions, as rows to merge into Payment
    // history ([{key, at, html}]), or none. They are text: they carry none of
    // the handlers this dialog binds (sync, finalize, restore, retry,
    // withdraw), because their record numbers belong to another contract and
    // would act on this one. The one button they may carry opens that version.
    otherVersionPayments(version = this.currentVersion()) {
        const ui = version?.ui;
        if (typeof ui?.historyItems !== 'function') return [];
        try {
            const items = ui.historyItems({
                dateText: timestamp => this.paymentDate(timestamp),
                txUrl: (hash, chainId) => this.paymentTransactionUrl(hash, chainId),
                previous: version.state?.previous,
                // This version's own balance holds the wallet: another version
                // cannot be opened until it is withdrawn. Said only when known.
                slotHeld: typeof version.state?.holding === 'string' && version.state.holding !== 'none',
                now: Date.now()
            });
            return Array.isArray(items)
                ? items.filter(item => item && typeof item === 'object' && typeof item.html === 'string') : [];
        } catch { return []; }
    }

    // What the dialog says about another version's payments changes when that
    // list does (a read that changed a row, a deadline that passed): part of
    // the history's own signature, so the clock re-draws it once.
    otherVersionHistorySignature() {
        try {
            const ui = versionFacade()?.ui;
            const signature = typeof ui?.historySignature === 'function' ? ui.historySignature(Date.now()) : '';
            return typeof signature === 'string' ? signature : '';
        } catch { return ''; }
    }

    // "Open version P" on a row of another version's payments: one delegated
    // handler on the overlay, bound once. It reloads into that version through
    // the facade (which refuses while work is in flight), landing on Payment
    // history, where its own rows have their own buttons.
    attachHistoryOpen() {
        const overlay = this.overlay;
        if (!overlay || typeof overlay.addEventListener !== 'function' || this.historyOpenBoundTo === overlay) return;
        this.historyOpenBoundTo = overlay;
        overlay.addEventListener('click', event => {
            const button = event?.target?.closest?.('[data-zkapi-history-open]');
            if (!button || button.disabled) return;
            this.openHistoryVersion(button.dataset?.zkapiHistoryOpen, button.dataset?.zkapiHistoryReason);
        });
    }

    openHistoryVersion(versionId, reason) {
        if (typeof versionId !== 'string' || !versionId) return null;
        const facade = versionFacade();
        if (!facade || typeof facade.requestSwitch !== 'function') return null;
        let result = null;
        try {
            result = facade.requestSwitch({
                reason: reason === 'claim_credit' ? 'claim_credit' : 'finish_previous',
                view: 'withdrawals',
                prefer: versionId
            });
        } catch { result = null; }
        const text = SWITCH_REFUSALS[result?.why];
        if (text) this.noticeVersionOutcome(text);
        return result;
    }

    async runVersionAction(action, context) {
        const version = this.versionContext();
        if (!version || this.versionActionBusy) return;
        const discarding = action === 'cancel-unsent';
        if (discarding) {
            // Not fundingBusy: the facade refuses a discard while the dialog
            // says it is busy. This flag only keeps the buttons from a second click.
            this.versionActionBusy = true;
            if (this.isOpen) this.render();
        }
        try {
            const result = typeof version.ui?.act === 'function'
                ? await version.ui.act(action, { facade: version.facade, state: version.state, ...context })
                : await this.fallbackVersionAction(action, version, context);
            if (discarding && result?.ok === true) {
                // The state reads "unsent" until the next holdings read: the
                // button is not offered again for that moment. The person did
                // this here and was told so; the reload's own words do not
                // say it a second time.
                this.unsentCleared = true;
                this.draftClearedHere = true;
                this.noticeVersionOutcome('Unfinished deposit cleared. Nothing was spent.');
            }
        } catch { /* A button must never throw into the page. */ }
        finally {
            if (discarding) {
                this.versionActionBusy = false;
                if (this.isOpen) this.render();
            }
        }
    }

    // The buttons' meaning when the page has no `ui.act`: the same facade
    // calls, so a dialog without the notice helpers still gets out of a
    // closed version.
    async fallbackVersionAction(action, version, context) {
        const { facade, state } = version;
        const refused = result => {
            const text = SWITCH_REFUSALS[result?.why];
            if (text) context.notify(text);
            return result;
        };
        switch (action) {
            case 'upgrade':
                context.dispatch('zkapi-payment-required', { view: 'upgrade' });
                return { ok: true };
            // Navigation only: the other new buttons (a service check, the exit
            // kit, giving up a balance) need the helpers' own dialogs, and
            // exist only where those helpers wrote them.
            case 'open-withdraw':
                context.dispatch('zkapi-payment-required', { view: 'withdraw' });
                return { ok: true };
            case 'open-payments':
                context.dispatch('zkapi-payment-required', { view: 'withdrawals' });
                return { ok: true };
            case 'reload': {
                if (state.reload?.canReload === false) { context.notify(SWITCH_REFUSALS.busy); return { ok: false, why: 'busy' }; }
                let reason = state.reload?.required === true ? state.reload.reason : null;
                if (!reason) { globalThis.location?.reload?.(); return { ok: true }; }
                // "The withdrawal ended" is recorded for the next page to tell
                // as fact: only with the facade's payout evidence, never for a
                // fact that is false or missing.
                if (reason === 'upgrade_withdrawn' && this.versionFacts(version).withdrawalConfirmed !== true) {
                    reason = 'previous_withdrawal_finished';
                }
                return refused(facade.requestSwitch({ reason, view: reason === 'upgrade_withdrawn' ? 'fund' : null }));
            }
            case 'open-previous':
                return refused(facade.requestSwitch({ reason: 'finish_previous', view: 'withdrawals' }));
            case 'claim-credit':
                return refused(facade.requestSwitch({ reason: 'claim_credit', view: 'withdrawals' }));
            case 'cancel-unsent': {
                const result = await facade.discardUnsentDeposit();
                if (result?.discarded !== true) {
                    context.notify(result?.why === 'busy' ? SWITCH_REFUSALS.busy : SWITCH_REFUSALS.loop);
                    return { ok: false, why: result?.why || 'failed' };
                }
                return { ok: true };
            }
            case 'dismiss':
                // The deposit step's notice outlives the page (the upgrade
                // intent is stored for 45 days): dismissing it forgets the
                // upgrade. Every dismissal is also the page-lifetime one the
                // other surfaces share, so the notice does not come back.
                if (context.noticeId === 'deposit') {
                    try { facade.abandonUpgrade?.(); } catch { /* The click still hides the notice. */ }
                }
                if (typeof context.noticeId === 'string' && context.noticeId) {
                    try { version.ui?.dismiss?.(context.noticeId); } catch { /* A convenience. */ }
                }
                if (Number.isFinite(state.reminderTier)) facade.acknowledgeReminder?.(state.reminderTier);
                context.refresh();
                return { ok: true };
            default:
                return { ok: false, why: 'unknown_action' };
        }
    }

    // `about` ({noteId} or {recordId}) names the balance the attempt was
    // about, so a refusal of a set-aside record is never held against the
    // balance in the wallet slot (and one of the slot note is held for it).
    async run(action, activityDetails = null, { about = null } = {}) {
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
        this.status = activityDetails?.message || 'Waiting for your Ethereum wallet…';
        this.statusError = false;
        // Deposits and withdrawals show their steps; other work shows a line.
        this.journeyKind = ['deposit', 'withdraw', 'escape'].includes(activityDetails?.kind) ? activityDetails.kind : null;
        this.journeyLast = null;
        this.backgroundProgress = activityDetails?.withdrawalRecordId
            ? { recordId: activityDetails.withdrawalRecordId, phase: 'preparing',
                ...(activityDetails.kind === 'payout-claim' ? { kind: 'payout-claim' } : {}) } : null;
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
            if (about) explainZkapiError(error, { about });
            else explainZkapiError(error);
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
        // The success screen names the fee left at the funding address, so
        // read it once (the funding poll has stopped with the deposit).
        this.depositLeftoverWei = null;
        this.depositDoneShown = false;
        if (getWalletMethod() === 'address') {
            Promise.resolve().then(() => addressFundingWallet.getStatus()).then(status => {
                if (!/^\d+$/.test(String(status?.ethBalance))) return;
                this.depositLeftoverWei = String(status.ethBalance);
                if (this.isOpen && !this.busy) this.render();
            }).catch(() => { /* No leftover line is better than a wrong one. */ });
        }
        this.depositBalanceRefreshPending = result?.balanceRefreshPending === true;
        this.confirmedDepositNoteId = this.depositBalanceRefreshPending ? Number(result.noteId) : null;
        this.syncConfirmedDepositBalance();
        this.view = 'balance';
        this.setStatus(this.depositBalanceRefreshPending ? CONFIRMED_REFRESHING_LINE : DEPOSIT_READY_LINE);
    }

    async submitAddressDeposit() {
        if (this.depositBalanceRefreshPending) return;
        if (!depositMayStart(Boolean(zkapiClient.config?.pending_deposit))) {
            this.outcome = { tone: 'error', message: depositsClosedLine(), view: this.view };
            this.render();
            return;
        }
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
        if (!depositMayStart(Boolean(zkapiClient.config?.pending_deposit))) {
            this.outcome = { tone: 'error', message: depositsClosedLine(), view: this.view };
            this.render();
            return;
        }
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
        return this.backgroundProgress.phase === 'wallet' ? 'Waiting for your Ethereum wallet'
            : this.backgroundProgress.phase === 'confirming' ? 'Confirming transaction'
                : this.backgroundProgress.kind === 'payout-claim' ? 'Claiming payout' : 'Preparing withdrawal';
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
            // A payout the payment contract holds is not a payout returned.
            if (holdsPayout(record)) return 'Payout held';
            return record.payoutVerified === true ? 'Returned' : 'Balance closed';
        }
        if (record.backgroundPreparationCancelable) return 'Preparation incomplete';
        if (record.mode === 'escape' && record.chainStatus === 'active'
            && (record.finalizeTransactionHash || record.finalizeSubmissionId)) {
            return 'Escape challenged';
        }
        if (record.startSubmissionId) return record.startSubmissionOutcome === 'ambiguous'
            ? 'Status unknown' : 'Waiting for your Ethereum wallet';
        if (record.phase === 'submitted_unconfirmed') return 'Transaction · checking';
        if (record.phase === 'recovery_unconfirmed') return 'Checking balance';
        if (record.phase === 'challenged_unconfirmed') return record.mode === 'escape'
            ? 'Challenge · confirming' : 'Checking balance';
        if (record.finalizeTransactionHash) return 'Transaction submitted';
        if (record.finalizeSubmissionId && record.phase === 'ambiguous') return 'Status unknown';
        if (record.finalizeSubmissionId) return 'Waiting for your Ethereum wallet';
        if (record.phase === 'restored') return 'Balance restored';
        if (record.phase === 'parked') return 'Ready to withdraw';
        if (record.phase === 'finalizing') return 'Transaction submitted';
        if (record.phase === 'awaiting_wallet') return 'Waiting for your Ethereum wallet';
        if (record.phase === 'ambiguous') return 'Status unknown';
        const deadline = Number(record.challengeDeadline || 0);
        if (!deadline) return 'Checking status';
        return deadline && Date.now() >= deadline * 1000
            ? 'Ready to finalize'
            : `Ready in ${zkapiClient.formatExpiry(deadline)}`;
    }

    // What one row of Payment history adds for its payout (a payout the
    // payment contract holds, a payout that came in under what was disclosed)
    // and for its device (a balance another device used since), from the
    // version helpers. A page without them adds nothing: a record of the
    // legacy protocol has no such facts either way. The text fields are
    // plain words and the two html fields are safe markup; the helper never
    // writes a hook that another handler of this dialog acts on.
    recordExtras(record, version = this.currentVersion()) {
        const ui = version?.ui;
        if (typeof ui?.recordExtras !== 'function') return NO_RECORD_EXTRAS;
        try {
            const extras = ui.recordExtras(record, {
                formatMoney: units => this.formatWithdrawalAmount(units),
                compact: address => zkapiClient.compact(address, 6),
                txUrl: hash => this.paymentTransactionUrl(hash),
                busy: this.busy === true,
                method: getWalletMethod() === 'address' ? 'address' : 'metamask'
            });
            if (extras && typeof extras === 'object') return { ...NO_RECORD_EXTRAS, ...extras };
        } catch { /* The fallback below. */ }
        // Nothing is added, but a balance this browser can not exit keeps its
        // buttons hidden: the SDK would refuse each of them after costing a
        // network fee.
        const flagged = ['parked', 'restored'].includes(record?.phase)
            && (record.deviceNotNewest === true || record.challengeObserved === true);
        return flagged ? { ...NO_RECORD_EXTRAS, hideActions: true } : NO_RECORD_EXTRAS;
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

    // `chainId` is the network the transaction was made on: this page's by
    // default, a row of another version's own (which may sit on another
    // network, or on one that is not known, which has no link).
    paymentTransactionUrl(hash, chainId = zkapiClient.config?.funding?.chain_id) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) return null;
        const network = Number(chainId);
        const origin = network === 1 ? 'https://etherscan.io'
            : network === 11155111 ? 'https://sepolia.etherscan.io' : null;
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
            : record.pendingPhase === 'awaiting_wallet' ? 'Waiting for your Ethereum wallet'
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
        const own = zkapiClient.expiryHistory.map(record => `${record.recordId}:${record.status}`).join('|');
        // The other versions' rows change the list when a read changes one or
        // a deadline passes; a page without them has no such part, and its
        // signature is its own records alone.
        const others = this.otherVersionHistorySignature();
        return others ? `${own}#${others}` : own;
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
        // The payments of other versions are rows of the list, in date order,
        // and nothing else: they are not this version's withdrawals, so they
        // never count as a return pending or a withdrawal to check.
        const version = this.currentVersion();
        const other = this.otherVersionPayments(version);
        if (!records.length && !lateAttempts.length && !deposits.length && !other.length) {
            return `<div class="zkapi-stack"><p class="zkapi-helper">Your deposits and withdrawals will appear here.</p>${inline ? '' : '<div class="zkapi-actions"><button id="zkapi-back-balance-btn" class="zkapi-quiet-button" type="button">Back to balance</button></div>'}</div>`;
        }
        const payments = [...deposits.map(record => ({ type: 'deposit', record })),
            ...expiries.map(record => ({ type: 'expiry', record })),
            ...records.map(record => ({ type: 'withdrawal', record })),
            ...other.map(item => ({ type: 'foreign', record: { at: Number(item.at) || 0 }, html: item.html }))];
        const timestamp = ({ record }) => Number(record.confirmedAt || record.createdAt || record.updatedAt || record.at || 0);
        payments.sort((left, right) => timestamp(right) - timestamp(left));
        const hasSelectedNote = Boolean(zkapiClient.note);
        const hasPendingDeposit = Boolean(zkapiClient.config?.pending_deposit);
        const hasPendingReturn = lateAttempts.length > 0
            || records.some(record => !['closed', 'closed_unconfirmed'].includes(record.phase));
        // Where a deposit here waits for the return to finish (a version that
        // no longer takes deposits, or one with a withdrawal still open), the
        // line that says new balances are fine would not be true.
        const depositsWait = hasPendingReturn ? this.depositsWaitLine() : '';
        return `
            <div class="zkapi-stack zkapi-records">
                ${inline ? '' : this.renderOutcome()}
                ${expiries.some(record => record.status === 'expired') ? `<button id="zkapi-check-expiry-payments-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Check expiry payments</button>` : ''}
                ${hasPendingReturn ? (hasSelectedNote ? `<p class="zkapi-note">These withdrawals run separately from your current private balance, so you can keep chatting normally.${depositsWait ? ` ${this.escapeHtml(depositsWait)}` : ''}</p>` : depositsWait ? `<p class="zkapi-note">${this.escapeHtml(depositsWait)}</p>` : '<p class="zkapi-note">You can add a new private balance while a return is pending.</p>') : ''}
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
                    ${payments.map(({ type, record, html }) => {
                        if (type === 'deposit') return this.renderDepositRecord(record);
                        if (type === 'expiry') return this.renderExpiryRecord(record);
                        if (type === 'foreign') return html;
                        const deadline = Number(record.challengeDeadline || 0);
                        const ready = deadline > 0 && Date.now() >= deadline * 1000;
                        const closed = ['closed', 'closed_unconfirmed'].includes(record.phase);
                        // A payout the payment contract only holds is never "returned",
                        // whatever else the record says. What a row adds for its payout
                        // or its device comes from the version helpers; a record of the
                        // legacy protocol has nothing of either, so its row is as it was.
                        const held = holdsPayout(record);
                        const returned = closed && record.payoutVerified === true && !held;
                        const extras = this.recordExtras(record, version);
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
                                        <p class="zkapi-record-title">${closed && !returned && !held ? 'Balance closed' : `Withdrawal · ${record.mode === 'escape' ? 'Escape hatch' : 'Mutual close'}`}</p>
                                        <p class="zkapi-record-sub">${closed && !returned && !held ? 'Payment not verified' : `${zkapiClient.formatMoney(record.finalBalance)} ${returned ? 'returned to' : ['parked', 'restored'].includes(record.phase) ? 'set aside · to' : '· to'} ${recordPayee(record) ? zkapiClient.compact(recordPayee(record), 6) : 'your saved destination'}`}</p>
                                        <p class="zkapi-record-date">${this.escapeHtml(this.paymentDate(record.createdAt))}</p>
                                    </div>
                                     ${extras.badge ? '<div class="flex shrink-0 flex-col items-end gap-1">' : ''}<span class="zkapi-record-status" data-tone="${returned ? 'success' : 'neutral'}" ${record.mode === 'escape' && open && deadline && record.phase === 'pending' ? `data-zkapi-withdrawal-countdown="${deadline}" data-record-id="${this.escapeHtml(record.recordId)}" data-record-phase="pending"` : ''}>${progressLabel ? '<span class="zkapi-pill-spinner" aria-hidden="true"></span>' : ''}<span data-background-progress="${this.escapeHtml(record.recordId)}" ${progressLabel ? 'role="status"' : ''}>${this.escapeHtml(progressLabel || extras.label || (parkedNeedsCheck ? 'Checking balance' : this.withdrawalRecordLabel(record)))}</span></span>${extras.badge ? `<span class="zkapi-record-status" data-tone="attention" data-zkapi-record-badge>${this.escapeHtml(extras.badge)}</span></div>` : ''}
                                </div>
                                ${returned && record.phase === 'closed_unconfirmed' ? '<p class="zkapi-record-line">Funds are in your wallet. Network confirmation continues automatically; no action is needed.</p>' : ''}
                                ${closed && transactionUrl ? `<a class="zkapi-record-link" href="${this.escapeHtml(transactionUrl)}" target="_blank" rel="noopener noreferrer">View transaction</a>` : ''}
                                ${record.phase === 'submitted_unconfirmed' ? '<p class="zkapi-record-line">This withdrawal is being checked in the background. Your current balance is unchanged.</p>' : ['challenged_unconfirmed', 'recovery_unconfirmed'].includes(record.phase) ? `<p class="zkapi-record-line">${record.mode === 'escape' ? 'The challenge is being confirmed in the background.' : 'Checking the previous withdrawal’s on-chain status.'} Your current balance is unchanged.</p>` : challengedFinalization ? '<p class="zkapi-record-line">The escape was challenged. Do not retry finalization. Check any submitted transaction, or close the old Ethereum wallet prompt before restoring this balance.</p>' : record.error && !extras.hideError ? `<p class="zkapi-record-line" data-tone="error">${this.escapeHtml(record.error)}</p>` : ''}${extras.noteHtml}
                                ${open && !extras.hideActions ? `<div class="zkapi-record-actions">
                                    ${record.mode === 'escape' && record.phase === 'pending' ? `<button data-finalize-withdrawal="${this.escapeHtml(record.recordId)}" class="zkapi-primary-button" type="button" ${!ready || this.busy ? 'disabled' : ''}>${ready ? 'Finalize' : `Ready in ${zkapiClient.formatExpiry(deadline)}`}</button>` : ''}
                                    ${parkedNeedsCheck || (record.mode === 'escape' && (unresolvedFinalization || ['finalizing', 'awaiting_wallet', 'ambiguous'].includes(record.phase))) || ['submitted_unconfirmed', 'challenged_unconfirmed', 'recovery_unconfirmed', 'closed_unconfirmed'].includes(record.phase) ? `<button data-sync-withdrawal="${this.escapeHtml(record.recordId)}" class="zkapi-primary-button" type="button" ${this.busy ? 'disabled' : ''}>Check status</button>` : ''}
                                    ${record.mode === 'escape' && record.phase === 'awaiting_wallet' && !challengedFinalization ? `<button data-recover-finalization="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Prompt closed</button>` : ''}
                                    ${record.mode === 'escape' && record.phase === 'ambiguous' && !challengedFinalization ? `<button data-retry-finalization="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Retry transaction</button>` : ''}
                                    ${record.mode === 'escape' && finalizationReplacement && !challengedFinalization ? `<button data-retry-dropped-finalization="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Replace transaction</button>` : ''}
                                    ${backgroundStartReplacement ? `<button data-retry-dropped-background-withdrawal="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Replace transaction</button>` : ''}
                                    ${record.backgroundPreparationCancelable ? `<button data-cancel-background-preparation="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Cancel preparation</button>` : ''}
                                    ${record.mode === 'escape' && challengedFinalization && record.finalizeSubmissionId && !record.finalizeTransactionHash ? `<button data-resolve-challenged-finalization="${this.escapeHtml(record.recordId)}" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>I closed the Ethereum wallet prompt</button>` : ''}
                                    ${backgroundReady ? `<button data-withdraw-background="${this.escapeHtml(record.recordId)}" class="zkapi-primary-button" type="button" ${this.busy ? 'disabled' : ''}>Withdraw ${zkapiClient.formatMoney(record.finalBalance)}</button>` : record.mode !== 'mutual' && ['restored', 'parked'].includes(record.phase) && !unresolvedFinalization ? `<button data-restore-withdrawal="${this.escapeHtml(record.recordId)}" data-withdrawal-only="${withdrawalOnly}" class="zkapi-primary-button" type="button" ${hasSelectedNote || hasPendingDeposit || this.busy ? 'disabled' : ''}>${withdrawalOnly ? 'Finish withdrawal' : 'Use this balance'}</button>` : ''}${extras.actionsHtml}
                                </div>` : extras.actionsHtml ? `<div class="zkapi-record-actions">${extras.actionsHtml}</div>` : ''}
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
        // Null without a facade: every version line below then renders as ''.
        const version = this.currentVersion();
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
            // A balance this browser holds and the page can not read is neither
            // empty nor something to add funds to: the one view says so.
            const heldView = this.renderHeldBalance(version);
            if (heldView) return heldView;
            if (pendingDeposit && ['submitted', 'dropped_or_pending', 'awaiting_wallet', 'ambiguous'].includes(pendingDeposit.phase)) {
                const pendingDetail = pendingDeposit.phase === 'submitted' ? CONFIRMING_LINE
                    : pendingDeposit.phase === 'dropped_or_pending' ? 'No receipt yet. It may still be pending, or your Ethereum wallet may have dropped it.'
                    : pendingDeposit.phase === 'awaiting_wallet' ? 'Your Ethereum wallet may still be open in this or another tab.'
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
                    pendingDeposit.phase === 'ambiguous' ? `<button id="zkapi-retry-deposit-btn" class="zkapi-secondary-button" type="button">${address ? 'Review fees for saved retry' : 'Try again in your Ethereum wallet'}</button>` : ''
                ].join('');
                return `
                    <div class="zkapi-stack">${this.renderVersionBanner(version)}
                        <section class="zkapi-figure-block" aria-label="Deposit in progress">
                            <p class="zkapi-balance-caption">Deposit</p>
                            <p class="zkapi-balance-amount">${zkapiClient.formatMoney(pendingDeposit.amount)}</p>
                        </section>
                        ${this.renderJourney(pendingJourney, { detail: this.busy ? '' : pendingDetail })}
                        ${this.renderOutcome()}
                        ${this.busy
                            ? `<p class="zkapi-funding-wait zkapi-deposit-wait" role="status"><span class="zkapi-pill-spinner" aria-hidden="true"></span><span data-zkapi-busy-label data-zkapi-deposit-wait>${walletMethodText(this.depositWaitLabel(pendingJourney))}</span></p>`
                            : `<div class="zkapi-actions">${primary}${secondary}<button id="zkapi-deposit-dismiss-btn" class="zkapi-quiet-button" type="button">Close</button></div>`}
                        ${address ? this.literal(renderFundingAccount(this)) : ''}
                        <div class="zkapi-guides">${this.renderWithdrawalStatusLink()}</div>
                    </div>`;
            }
            if (this.depositInMotion()) return this.renderDepositInMotion(address);
            const resumingDeposit = pendingDeposit
                && ['prepared', 'retry_exact'].includes(pendingDeposit.phase);
            // A version that no longer takes deposits (and has none started
            // that can finish here) has no Add funds form, whatever the method.
            const closedView = this.renderDepositsClosed(version, pendingDeposit);
            if (closedView) return closedView;
            if (address && (!pendingDeposit || canQuotePendingAddressDeposit())) return `<div class="zkapi-stack">${this.renderVersionBanner(version)}
                ${this.renderOutcome()}
                ${this.busy ? this.renderProgress(this.status) : pendingDeposit?.phase === 'retry_exact' ? '<p class="zkapi-note">This retry keeps the original deposit transaction. If its network fee cannot be estimated, check the saved payment status first.</p><div class="zkapi-actions"><button id="zkapi-check-deposit-btn" class="zkapi-secondary-button" type="button">Check payment status</button></div>' : ''}
                ${fundingInstructionsVisible(this) ? '' : this.literal(renderFundingAccount(this))}
                <div class="zkapi-guides">${this.renderWithdrawalStatusLink()}</div>
            </div>`;
            if (address && resumingDeposit) {
                return `<div class="zkapi-stack">${this.renderVersionBanner(version)}
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
                ? zkapiClient.formatMoney(pendingDeposit.amount).replace(/^\$/, '')
                : this.depositAmount
                    ?? formatSuggestedDeposit(zkapiClient.suggestedDeposit);
            const mainnet = zkapiClient.isMainnetFunding;
            return `
                <div class="zkapi-stack">${this.renderVersionBanner(version)}
                    <section class="zkapi-section zkapi-deposit" aria-label="Add funds">
                        ${resumingDeposit ? `<div class="zkapi-figure-row"><p class="zkapi-balance-amount">${this.escapeHtml(zkapiClient.formatMoney(pendingDeposit.amount))}</p><p class="zkapi-balance-caption">Saved deposit</p></div>` : ''}
                        ${resumingDeposit && !this.busy ? '<p class="zkapi-note">Before resuming, check your Ethereum wallet for a pending transaction.</p>' : ''}
                        ${!resumingDeposit && !this.busy ? this.literal(renderMetaMaskTransfer(this)) : ''}
                        ${this.renderOutcome()}
                        ${this.busy && this.journeyKind === 'deposit'
                            ? this.renderJourney(this.currentJourney('deposit', { message: this.status }))
                            : `<div class="zkapi-actions">
                            ${this.busy
                                ? this.renderProgress(this.status || 'Waiting for your Ethereum wallet…')
                                : this.startingAfterInit
                                    ? '<button id="zkapi-deposit-btn" class="zkapi-primary-button w-full" type="button" disabled><span class="zkapi-pill-spinner" aria-hidden="true"></span>Getting ready…</button>'
                                    : `<button id="zkapi-deposit-btn" class="zkapi-primary-button w-full" type="button">${resumingDeposit ? 'Resume with Ethereum wallet' : 'Continue with Ethereum wallet'}</button>`}
                        </div>`}
                    </section>
                    <div class="zkapi-guides">
                        ${address ? '<p class="zkapi-note">Your saved deposit keeps its original amount. Continue only when you are ready to submit it.</p>' : fundingSetupGuide({ mainnet, open: fundingSetup?.open })}
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
            : withdrawalPhase === 'awaiting_wallet' ? 'Your Ethereum wallet may still be open. Open the withdrawal to check it.'
            : withdrawalPhase === 'ambiguous' ? 'Your Ethereum wallet did not return a transaction. Open the withdrawal to check it.'
            : 'Withdrawal paused. This balance is reserved and cannot be used for chat. Open the withdrawal to review the network fee and next step.';
        // Right after a deposit: one confirmation and Start chatting. It is
        // shown once (closing the dialog clears the outcome); View balance or
        // reopening shows the balance as usual.
        if (this.outcome?.tone === 'success' && this.outcome.message === DEPOSIT_READY_LINE && !this.busy && !claimed && !withdrawing) {
            const leftoverWei = this.depositLeftoverWei;
            let leftover = '';
            if (/^\d+$/.test(String(leftoverWei))) {
                try {
                    const usd = zkapiClient.formatMoney((BigInt(leftoverWei) / 1_000_000_000n).toString());
                    if (usd && usd !== '—' && Number(String(usd).replace(/[^0-9.]/g, '')) >= 0.005) leftover = usd;
                } catch { /* Leave the line out rather than guess. */ }
            }
            return `<div class="zkapi-stack">
                <section class="zkapi-deposit-done" role="status" aria-live="polite">
                    <span class="zkapi-done-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path pathLength="1" d="M6.5 12.5l3.6 3.6 7.4-8.2"/></svg></span>
                    <p class="zkapi-done-title">${this.escapeHtml(zkapiClient.formatMoney(note.deposit_amount))} added to your private balance</p>
                    ${leftover ? `<p class="zkapi-done-sub">${this.escapeHtml(leftover)} network fee left over · saved for your next deposit</p>` : ''}
                </section>
                <div class="zkapi-done-actions">
                    <button id="zkapi-done-start-btn" class="zkapi-primary-button w-full" type="button">Start chatting</button>
                    <button id="zkapi-done-balance-btn" class="zkapi-quiet-button" type="button">View balance</button>
                </div>
            </div>`;
        }
        // A balance held by an exit lock with no withdrawal of its own (no
        // prepared plan, no transaction) has its own notice: frozen, and until
        // when. That notice is the one statement; "needs attention" and "no
        // transaction is moving, ready to finish withdrawing" beside it would
        // talk of a withdrawal that is not there. A prepared plan keeps its
        // own words: finishing it is what the person does next.
        const banner = this.renderVersionBanner(version);
        const frozenSaid = !claimed && zkapiClient.withdrawalBlocksChat && !zkapiClient.activeWithdrawal
            && banner.includes('data-zkapi-version-notice="frozen"');
        // The version pill sits beside the readiness pill, never in the footer
        // between the expiry label and its help toggle.
        const pill = this.renderVersionBadge(version);
        return `
            <div class="zkapi-stack">
                <div class="zkapi-balance-card">
                    <div class="zkapi-balance-top">
                        <div>
                            <p class="zkapi-balance-caption">${withdrawing ? 'Reserved for withdrawal' : 'Available'}</p>
                            <p class="zkapi-balance-amount">${zkapiClient.formatMoney(available)}</p>
                            <p class="zkapi-balance-eth">${this.escapeHtml(zkapiClient.formatBillingAmount(available))} ETH</p>
                        </div>
                        ${pill.badge}
                    </div>
                    <div class="zkapi-bar"><div class="zkapi-bar-fill" style="width:${percent}%"></div></div>
                    <div class="zkapi-balance-foot"><span>${claimed ? 'Claimed after expiry' : `${zkapiClient.formatMoney(spent)} used of ${zkapiClient.formatMoney(note.deposit_amount)}`}</span><span class="inline-flex items-center gap-1"><span data-zkapi-balance-expiry>${privateBalanceExpiryLabel(zkapiClient, note.expiry_ts)}</span>${privateBalanceHelpButton('modal', 'expiry', this.privateBalanceHelpOpen?.expiry)}</span></div>
                    ${privateBalanceHelpContent('modal', 'expiry', this.privateBalanceHelpOpen?.expiry)}${pill.help}
                </div>${banner}${claimed ? '' : this.renderBalanceExtras(version)}
                ${claimed ? '<p class="zkapi-helper">After expiry, the original deposit was paid to the service treasury. No refund was made.</p>' : `<div data-private-balance-expired-notice ${expired ? '' : 'hidden'}><p class="zkapi-note">This private balance has expired. You can still try withdrawing while it remains unclaimed.</p></div>`}
                ${this.renderOutcome()}
                ${withdrawing && !frozenSaid ? `<p class="zkapi-note">${withdrawingLine}</p>` : ''}
                <div class="zkapi-actions">
                    ${this.busy ? this.renderProgress(this.status || 'Working…') : `
                    ${claimed ? '' : withdrawing ? '<button id="zkapi-continue-withdrawal-btn" class="zkapi-primary-button" type="button">Review withdrawal</button>' : '<button id="zkapi-withdraw-view-btn" class="zkapi-secondary-button" type="button">Withdraw</button>'}
                    <button id="zkapi-refresh-btn" class="zkapi-secondary-button" type="button">Refresh</button>
                    ${claimed ? '<button id="zkapi-archive-expired-balance-btn" class="zkapi-primary-button" type="button">Start a new balance</button>' : ''}`}
                </div>
                ${address ? this.literal(renderFundingAccount(this)) : ''}
                <div class="zkapi-guides">${privateBalanceGuide('billing', this.privateBalanceHelpOpen?.billing)}${this.renderWithdrawalStatusLink()}</div>
            </div>`;
    }

    // The view of a balance this browser holds and the page can not read: the
    // version's SDK did not start (the state's `held`), so there is no note to
    // draw and "Add funds", a withdrawal and an upgrade would all be dead ends.
    // The helpers say it in full (ui.heldBalance, the same words as the
    // deposits-closed view); before they arrive one plain line stands in. The
    // version banner stays out when the view says what its notice says. ''
    // when the state does not say `held`.
    renderHeldBalance(version) {
        if (version?.state?.held?.unreachable !== true) return '';
        let held = '';
        if (typeof version.ui?.heldBalance === 'function') {
            try {
                held = String(version.ui.heldBalance({
                    state: version.state, busy: this.busy === true || this.fundingBusy === true || this.versionActionBusy === true,
                    table: version.facade.table, ...this.versionFacts(version)
                }) || '');
            } catch { held = ''; }
        }
        const helped = held !== '';
        if (!helped) held = `<section class="zkapi-section" data-zkapi-balance-held aria-label="Saved balance"><p class="zkapi-helper">${this.escapeHtml(HELD_BALANCE_LINE)}</p></section>`;
        return `<div class="zkapi-stack">
            ${this.renderVersionBanner(version, { repeated: helped })}${held}
            ${this.renderOutcome()}
            ${this.busy ? this.renderProgress(this.status || 'Working…') : ''}
            ${this.renderWithdrawalStatusLink()}
        </div>`;
    }

    // What sits under the balance card besides the balance: the exit kit's
    // quiet status row and, for an empty or very small balance on a version
    // that no longer takes deposits, the way to give it up. Both are buttons
    // of the version helpers (`data-zkapi-version-action`), wired with the
    // other version buttons; the helper decides whether there is anything to
    // say and writes nothing for a page without versions.
    renderBalanceExtras(version) {
        const ui = version?.ui;
        if (typeof ui?.balanceExtras !== 'function') return '';
        try {
            return String(ui.balanceExtras({
                state: version.state, busy: this.busy === true || this.fundingBusy === true
            }) || '');
        } catch { return ''; }
    }

    // The upgrade view: the withdrawal, in the upgrade's words, between the
    // steps above and the choices of where it goes. The deposit and done
    // stages are the same view's lead above the ordinary fund flow.
    renderUpgrade(fundingSetup = null) {
        const version = this.currentVersion();
        if (!version) return this.renderBalance(fundingSetup);
        const stage = version.state.upgrade?.stage;
        if (LEAD_STAGES.includes(stage)) {
            return `${this.renderVersionLead(version)}${this.renderBalance(fundingSetup)}`;
        }
        // A refusal (reload while work is in flight, a plan that cannot be
        // cleared) has to be seen in the stage that offered the button. A
        // success is the stage's own sentence already.
        const outcome = this.outcome?.tone === 'success' ? '' : this.renderOutcome();
        const withdrawalHtml = EMBEDDING_STAGES.includes(stage) ? this.renderWithdrawal({ upgrade: true }) : '';
        return this.renderUpgradeContext(version, withdrawalHtml, { outcome }) || this.renderBalance(fundingSetup);
    }

    attachUpgradeDestination(version) {
        if (this.view !== 'upgrade' || !version || !this.overlay?.querySelectorAll) return;
        this.overlay.querySelectorAll('input[name="zkapi-upgrade-destination"]').forEach(input => {
            input.addEventListener('change', () => {
                this.upgradeDestination = { ...(this.upgradeDestination || {}), choice: input.value };
                this.applyUpgradeDestination(version);
                this.render();
            });
        });
        // What is typed is kept apart from the created address, so switching
        // between the two never loses either.
        this.overlay.querySelector('[data-funding-withdrawal-destination]')?.addEventListener('input', event => {
            this.upgradeDestination = { ...(this.upgradeDestination || {}), typed: event.target.value };
        });
        this.overlay.querySelector('[data-upgrade-new-address]')?.addEventListener('click', () => { void this.createUpgradeAddress(); });
    }

    // Why the upgrade's withdrawal cannot start yet, or ''. Checked before the
    // active chat key is settled so nothing slow runs for a request that
    // cannot go anywhere. A saved plan keeps the destination it was prepared with.
    upgradeDestinationRefusal() {
        if (this.view !== 'upgrade' || getWalletMethod() !== 'address') return '';
        if (zkapiClient.config?.prepared_withdrawal?.destination || zkapiClient.withdrawal?.destination) return '';
        const version = this.versionContext();
        if (!version) return '';
        const destination = this.upgradeDestination || {};
        if (this.upgradeDestinationChoice(version) === 'new-address') {
            if (!destination.newAddress) return 'Create the new funding address first, or enter another address.';
            this.fundingDestination = destination.newAddress;
        }
        try { withdrawalDestination(this); } catch (error) { return error.message; }
        return '';
    }

    shouldShowClaimedBalance() {
        if (!zkapiClient.noteExpiryClaim || this.busy) return false;
        const prepared = zkapiClient.config?.prepared_withdrawal;
        return !zkapiClient.activeLateWithdrawal && !prepared?.transaction_hash
            && !['submitted', 'dropped_or_pending', 'awaiting_wallet', 'ambiguous'].includes(prepared?.phase);
    }

    // The fine print about a chat that is still settling and, while one holds
    // the balance, the choice of how to leave (the version helpers write both;
    // '' when no settling chat can cost anything, and on a page without them).
    // `offerChoice: false` when the withdrawal's method is already fixed. Once
    // the time that chat had to settle has passed there is no choice to offer:
    // waiting, and giving up nothing now, no longer exist, so the fine print
    // stands alone with one plain sentence saying what a withdrawal does now.
    renderExitChoice(version, { offerChoice = true } = {}) {
        const ui = version?.ui;
        if (typeof ui?.exitChoice !== 'function') return '';
        try {
            const now = Date.now();
            const noteId = this.exitChoiceNoteId();
            // A choice is restored for the balance and the figure it was made for.
            const remembered = noteId !== '' && this.exitChoice?.noteId === noteId ? this.exitChoice : null;
            const draw = offered => String(ui.exitChoice({
                state: version.state,
                mode: this.withdrawMode === 'escape' ? 'escape' : 'mutual',
                offerChoice: offered,
                choice: remembered?.choice,
                choiceBound: remembered?.bound,
                disabled: this.busy === true || this.fundingBusy === true,
                now
            }) || '');
            const html = draw(offerChoice);
            if (html.includes(EXIT_FIELDSET_HOOK)) {
                if (settlementTimePassed(version.state, now)) {
                    return `<div class="zkapi-exit-choice" data-zkapi-exit-settled>${draw(false)}`
                        + `<p class="zkapi-note" data-zkapi-exit-settlement-passed>${this.escapeHtml(SETTLEMENT_PASSED_LINE)}</p></div>`;
                }
                // The choice is drawn under this time, and the markup says so:
                // what is read back at the click is what the person was shown.
                const settlesAt = settlementTimeOf(version.state);
                if (settlesAt !== null) {
                    return `<div class="zkapi-exit-choice" data-zkapi-exit-offered data-zkapi-settles-at="${settlesAt}">${html}</div>`;
                }
            }
            return html;
        } catch { return ''; }
    }

    // What the person chose about a chat that is still settling, read back from
    // what the page drew. A figure the person was not shown is not one they
    // authorized, so everything is taken from the markup, and a page that is
    // out of date for the withdrawal at hand (another method selected, the
    // most a chat could cost grew since it was drawn, or the time it had to
    // settle passed so that waiting and giving up nothing no longer exist) is
    // `stale`: it is drawn again and nothing starts on it.
    //   choice       'wait' | 'zero' | 'bound' | null (no choice was offered)
    //   conceded     the exact amount a forced emergency exit gives up
    //   concededMax  the most an exit the SDK converts or forces may give up
    //   afterSettlement  (only with `stale`) the settlement time passed
    readExitChoice() {
        const none = { stale: false, choice: null, conceded: null, concededMax: null, bound: null };
        const version = this.currentVersion();
        const ui = version?.ui;
        if (typeof ui?.readExitChoice !== 'function') return none;
        try {
            const read = ui.readExitChoice(this.overlay, version.state);
            if (!read || typeof read !== 'object') return none;
            const wanted = this.withdrawMode === 'escape' ? 'escape' : 'mutual';
            if ((read.mode === 'escape' || read.mode === 'mutual') && read.mode !== wanted) return { ...none, stale: true };
            if (read.changed === true) return { ...none, stale: true };
            const text = value => (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,29})$/.test(value) ? value : null);
            const choice = ['wait', 'zero', 'bound'].includes(read.choice) ? read.choice : null;
            // Drawn before the settlement time, picked after it: the SDK would
            // give up the whole figure at once, which is neither of these.
            // Giving up the figure is what `bound` says, so it stands.
            if ((choice === 'wait' || choice === 'zero')
                && settlementTimePassed(version.state, Date.now(), this.drawnSettlementTime())) {
                return { ...none, stale: true, afterSettlement: true };
            }
            if (exitFigureMoved(version.state, choice, text(read.bound))) return { ...none, stale: true };
            return { stale: false, choice, conceded: text(read.conceded), concededMax: text(read.concededMax), bound: text(read.bound) };
        } catch {
            // Nothing was confirmed: the signer then allows no concession.
            return none;
        }
    }

    // The balance a remembered choice belongs to. Two balances can show the
    // same figure (it is the budget of a chat tier), and giving something up is
    // chosen for the balance in front of the person, never carried to another.
    exitChoiceNoteId() {
        const id = zkapiClient.note?.note_id;
        return id === null || id === undefined ? '' : String(id);
    }

    // A forced exit's choice is kept across the redraws a refresh causes, for
    // the balance and the bound it was made against only (the helper restores
    // it that way), and until the person leaves Withdraw.
    rememberExitChoice() {
        const read = this.readExitChoice();
        const noteId = this.exitChoiceNoteId();
        this.exitChoice = (read.choice === 'zero' || read.choice === 'bound') && read.bound !== null && noteId !== ''
            ? { choice: read.choice, bound: read.bound, noteId } : null;
    }

    // Whether a withdrawal must be re-verified under the wallet lock right
    // before it starts: a page with versions to tell apart whose protocol says
    // so. Everywhere else the request path is exactly what it was.
    operationRecheckRequired() {
        try {
            const facade = versionFacade();
            return Boolean(facade && facade.multiVersion === true && typeof facade.operationRecheckRequired === 'function'
                && facade.operationRecheckRequired() === true);
        } catch { return false; }
    }

    // The settlement time the choice on screen was drawn under, read back from
    // the markup, or null (no choice drawn, or no time was known).
    drawnSettlementTime() {
        try {
            const holder = this.overlay?.querySelector?.('[data-zkapi-exit-offered]');
            const value = holder?.getAttribute?.('data-zkapi-settles-at');
            return typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : null;
        } catch { return null; }
    }

    // Whether the time the settling chat had to settle has passed, by the
    // facade's current state, the time the page was drawn under and the
    // clock. False on a page without versions.
    settlementPassedNow(drawnAt = null) {
        try {
            return settlementTimePassed(this.versionContext()?.state, Date.now(), drawnAt);
        } catch { return false; }
    }

    // Whether the figure the person was shown is no longer the state's.
    exitFigureMovedNow(choice, shown) {
        if (typeof shown !== 'string') return false;
        try {
            return exitFigureMoved(this.versionContext()?.state, choice, shown);
        } catch { return false; }
    }

    // -- Paying the network fee from the withdrawal -----------------------------
    // The facade's `sponsored` answers whether this version has it and quotes
    // it (versioning/sponsoredFees.mjs). The dialog keeps only the choice and
    // the last quote; the markup is the helpers' (ui.sponsoredFee).

    sponsoredApi() {
        try {
            const sponsored = versionFacade()?.sponsored;
            return sponsored && typeof sponsored.supported === 'function' && sponsored.supported() ? sponsored : null;
        } catch { return null; }
    }

    // Send to address pays a new withdrawal's network fee from the withdrawal
    // (an operation the browser-held key signs and the service's relay sends,
    // so that key needs no ETH and nothing is connected), with no wallet
    // choice: in the withdraw form, for a balance whose version pins a
    // reviewed sponsorship. Everywhere else Send to address keeps its funding
    // address route exactly as before: a version without one (mainnet
    // version 1, the earlier Sepolia versions), the upgrade's own withdrawal,
    // and every saved plan, which continues the way it was prepared.
    addressPayoutOnly() {
        return getWalletMethod() === 'address' && this.view === 'withdraw' && Boolean(this.sponsoredApi());
    }

    // Who pays the network fee of a new withdrawal: the withdrawal itself
    // where addressPayoutOnly(), otherwise the person's own choice (the
    // wallet first).
    sponsoredChoiceNow() {
        return this.addressPayoutOnly() || this.sponsoredChoice === 'payout' ? 'payout' : 'wallet';
    }

    // What a quote is for: the balance, how it leaves and who is paid. A quote
    // of anything else is not this form's.
    sponsoredKeyFor(mode) {
        let noteId = '';
        let destination = '';
        try { noteId = zkapiClient.note?.note_id ?? ''; } catch { noteId = ''; }
        if (getWalletMethod() === 'address') {
            try { destination = withdrawalDestination(this); } catch { destination = ''; }
        }
        const method = getWalletMethod();
        const owner = method === 'address' ? addressFundingWallet.address : zkapiClient.walletAddress;
        return JSON.stringify([noteId, zkapiClient.note?.current_balance, mode, method, owner || '', destination]).toLowerCase();
    }

    sponsoredViewState(mode) {
        const key = this.sponsoredKeyFor(mode);
        const held = this.sponsoredQuote;
        const current = held && held.key === key ? held : null;
        return { choice: this.sponsoredChoiceNow(), status: current?.status || 'idle', quote: current?.quote || null, key };
    }

    // The fee choice for the form in front of the person: '' where there is
    // nothing to choose (no such payment here, a plan that is already
    // bound to how its fee is paid, the work already running, an upgrade).
    // Send to address has no choice to make there, only its fee to show
    // (addressPayoutOnly); a balance whose version pins no sponsorship keeps
    // its old form, which never had this section.
    renderSponsoredFee({ prepared = null, submissionActive = false, showJourney = false, upgrade = false } = {}) {
        if (upgrade || submissionActive || (showJourney && !prepared) || (prepared && prepared.fee_payer !== 'payout')) return '';
        if (!this.sponsoredApi()) return '';
        const ui = versionFacade()?.ui;
        if (typeof ui?.sponsoredFee !== 'function') return '';
        try {
            const view = this.sponsoredViewState(this.withdrawMode);
            return String(ui.sponsoredFee({
                choice: prepared ? 'payout' : view.choice, status: view.status, quote: view.quote, busy: this.busy === true,
                locked: Boolean(prepared),
                // Send to address draws only "Paid from this withdrawal": a new
                // payout-only form, or a saved payout plan of that method.
                method: this.addressPayoutOnly() || (prepared && getWalletMethod() === 'address') ? 'address' : 'metamask',
                mode: this.withdrawMode,
                format: units => this.formatWithdrawalAmount(units)
            }) || '');
        } catch { return ''; }
    }

    // Send to address asks for its fee on Continue: the form itself sends
    // nothing, and the quote is for the destination that was typed. True when
    // Continue would ask now (a valid destination, nothing asked yet for
    // exactly this withdrawal); the review follows only a quote that answered.
    addressQuoteOnContinue() {
        if (!this.addressPayoutOnly() || zkapiClient.config?.prepared_withdrawal) return false;
        if (this.walletMethodReady === false || this.startingAfterInit || this.busy || this.withdrawalPreflightBusy
            || (this.withdrawMode === 'escape' && escapeNeedsSettlement())) return false;
        try { withdrawalDestination(this); } catch { return false; }
        return this.sponsoredViewState(this.withdrawMode).status === 'idle';
    }

    // Whether the form's Continue does something: opens the review, or (Send
    // to address) checks the fee first.
    withdrawalContinueReady() {
        return this.withdrawalInputReady() || this.addressQuoteOnContinue();
    }

    // Continue on Send to address: ask for the fee of this withdrawal, then
    // open its review once the answer is in for the same form. The person
    // still confirms there; nothing is sent on the quote.
    async reviewAfterAddressQuote() {
        const mode = this.withdrawMode;
        await this.refreshSponsoredQuote(mode);
        // A quote is held for one balance, signer and destination: one typed
        // or changed meanwhile reads as not asked yet, and stays on the form.
        if (!this.isOpen || this.view !== 'withdraw' || this.withdrawMode !== mode || !this.addressPayoutOnly()) return;
        if (this.sponsoredViewState(mode).status !== 'ready') return;
        this.requestWithdrawal();
    }

    // One explicit gesture: choosing to pay from the withdrawal asks the relay
    // what it would cost (on Send to address, Continue is that gesture). A
    // later answer for another form (another mode, another balance) is dropped.
    async refreshSponsoredQuote(mode = this.withdrawMode) {
        const api = this.sponsoredApi();
        if (!api || this.busy) return;
        if (getWalletMethod() === 'address') {
            // A destination that is not valid is refused here, before the
            // relay is asked anything or a key is made for it.
            try { withdrawalDestination(this); } catch (error) {
                this.sponsoredQuote = null;
                this.outcome = { tone: 'error', message: error?.message || 'Enter a valid Ethereum withdrawal address.', view: this.view };
                if (this.isOpen) this.render();
                return;
            }
        }
        let key = this.sponsoredKeyFor(mode);
        const method = getWalletMethod();
        const noteId = zkapiClient.note?.note_id;
        const balance = zkapiClient.note?.current_balance;
        // The destination the quote asks about, read once: the cache key below
        // is rebased only onto this same destination.
        let typed = null;
        if (method === 'address') { try { typed = withdrawalDestination(this); } catch { typed = null; } }
        const sequence = this.sponsoredSeq = (Number(this.sponsoredSeq) || 0) + 1;
        this.sponsoredQuote = { key, status: 'loading', quote: null };
        this.render();
        // Work for a form that changed while this waited (another signer,
        // balance or destination) is dropped, not filed under the new form.
        const stale = () => {
            if (sequence !== this.sponsoredSeq || method !== getWalletMethod() || mode !== this.withdrawMode
                || noteId !== zkapiClient.note?.note_id || balance !== zkapiClient.note?.current_balance) return true;
            if (method !== 'address') return false;
            let now = null;
            try { now = withdrawalDestination(this); } catch { now = null; }
            return !now || now.toLowerCase() !== String(typed || '').toLowerCase();
        };
        const drop = () => {
            // Only this request's own "Checking…" is cleared; a newer one stays.
            if (sequence === this.sponsoredSeq) {
                this.sponsoredQuote = null;
                if (this.isOpen) this.render();
            }
        };
        let quote;
        try {
            let owner = null;
            let destination = null;
            if (method === 'address') {
                destination = typed;
                // The key this browser holds signs the operation and owns
                // its holding address; it needs no ETH. A person who never
                // used this method has none yet: this gesture makes it.
                owner = addressFundingWallet.address || await addressFundingWallet.ensureAddress() || null;
            } else {
                // The account that signs it owns the holding address, so it
                // must be the connected one; this is the choice's own prompt.
                owner = await zkapiClient.connectWallet();
                destination = zkapiClient.config?.prepared_withdrawal?.payout || null;
            }
            if (stale()) return drop();
            // Making the key (or connecting MetaMask) can populate its owner
            // for the first time; nothing else in the key moved.
            key = this.sponsoredKeyFor(mode);
            quote = await api.quote({ mode, destination, owner,
                ...(getWalletMethod() === 'address' ? { provider: addressFundingWallet } : {}) });
        } catch (error) {
            quote = { available: false, reason: 'unknown',
                text: walletErrorMessage(error) || 'Paying the network fee from this withdrawal isn’t available right now.' };
        }
        if (stale() || key !== this.sponsoredKeyFor(mode)) return drop();
        this.sponsoredQuote = { key, status: quote?.available === true ? 'ready' : 'unavailable', quote };
        if (this.isOpen) this.render();
    }

    // How this withdrawal's fee is paid, decided when it starts. null: from
    // the wallet, as every withdrawal always was. A plan the SDK already bound
    // to a holding address continues that way. Otherwise a person who chose
    // to pay from the withdrawal needs a quote of what is about to start; a
    // form whose quote is for something else is drawn again, not acted on.
    sponsoredPlanFor(mode) {
        const prepared = zkapiClient.config?.prepared_withdrawal;
        const api = this.sponsoredApi();
        if (prepared?.fee_payer === 'payout') {
            const view = this.sponsoredViewState(mode);
            // Continue within the deployment policy, including plans saved
            // by a build that treated its fee estimate as an exact cap.
            const plan = api?.plan?.(view.status === 'ready' ? view.quote
                : { available: true, flatFeeWei: prepared.flat_fee_cap_wei });
            if (!plan) return { refused: 'Paying the network fee from this withdrawal isn’t available right now.' };
            return { options: plan.options, bounds: plan.sponsored };
        }
        // A saved wallet-paid plan (of either method) continues as it started.
        if (prepared) return null;
        // Send to address pays from the withdrawal where addressPayoutOnly()
        // and never falls back to its funding address there; a balance whose
        // version pins no sponsorship keeps that route (null) as before.
        const address = this.addressPayoutOnly();
        if (!address && (this.sponsoredChoice !== 'payout' || !api)) return null;
        const view = this.sponsoredViewState(mode);
        if (view.status !== 'ready' || !view.quote) {
            return { refused: 'The network fee has to be checked for this withdrawal first. Review it below, then continue.' };
        }
        const plan = api.plan(view.quote);
        if (!plan) return { refused: address ? ADDRESS_WITHDRAWAL_UNPLANNED_LINE : 'Paying the network fee from this withdrawal isn’t available right now. You can pay it from your wallet instead.' };
        return { options: plan.options, bounds: plan.sponsored };
    }

    // The words after a sponsored withdrawal that ended. Said from the
    // result's own figures; none is guessed.
    sponsoredOutcomeLine(result) {
        const amounts = result && typeof result.amounts === 'object' ? result.amounts : null;
        const units = value => (typeof value === 'string' && /^[0-9]{1,40}$/.test(value) ? (BigInt(value) / 1_000_000_000n).toString() : null);
        const fee = amounts ? units(amounts.chargedWei) : null;
        const feeText = fee !== null ? this.formatWithdrawalAmount(fee) : '';
        return feeText && !/^[—–-]$/.test(feeText.trim()) ? ` The network fee, ${feeText}, was paid from the withdrawal.` : '';
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
        const sponsored = this.sponsoredPlanFor(this.withdrawMode);
        if (sponsored) return !sponsored.refused;
        return withdrawalFeeReady(this);
    }

    withdrawalReviewScope() {
        let destination = null;
        if (getWalletMethod() === 'address') {
            try { destination = withdrawalDestination(this); } catch { return null; }
        }
        const sponsored = this.sponsoredPlanFor(this.withdrawMode);
        return JSON.stringify([zkapiClient.note?.note_id, zkapiClient.note?.current_balance,
            this.withdrawMode, getWalletMethod(), destination, getWalletMethod() === 'metamask' ? zkapiClient.walletAddress || this.withdrawalFees?.quote?.address : null,
            zkapiClient.config?.prepared_withdrawal?.operation_id, this.withdrawalEscapeIntent,
            sponsored ? [this.sponsoredKeyFor(this.withdrawMode), sponsored.options, sponsored.bounds, sponsored.refused] : 'wallet']);
    }

    requestWithdrawal() {
        if (!this.isOpen || this.view !== 'withdraw' || this.canOpen?.() === false) return;
        // Send to address: the fee of this withdrawal first, then its review.
        if (this.addressQuoteOnContinue()) {
            void this.reviewAfterAddressQuote();
            return;
        }
        if (!this.withdrawalInputReady()) return;
        // A saved withdrawal has already crossed this point. Continuing it
        // must not suggest that its server reservation can still be cancelled.
        if (zkapiClient.config?.prepared_withdrawal && !this.withdrawalEscapeIntent) return this.submitWithdrawal();
        // What was chosen about a settling chat is drawn on this page, which
        // the review replaces: read it now, and carry it to the confirmed
        // submit. A page that is out of date is drawn again, not acted on.
        const exit = this.readExitChoice();
        if (exit.stale) {
            this.exitChoice = null;
            this.outcome = {
                tone: 'error', view: this.view,
                message: exit.afterSettlement ? SETTLEMENT_PASSED_STALE_LINE : STALE_EXIT_CHOICE_LINE
            };
            this.render();
            return;
        }
        this.reviewedExit = { exit, drawnAt: this.drawnSettlementTime() };
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
        let mode = this.withdrawMode;
        const escapeIntent = this.withdrawalEscapeIntent;
        const noteId = zkapiClient.note?.note_id;
        const submitGeneration = this.withdrawalSubmitGeneration || 0;
        const preparedOperationId = zkapiClient.config?.prepared_withdrawal?.operation_id || null;
        const refusal = this.upgradeDestinationRefusal();
        if (refusal) {
            this.outcome = { tone: 'error', message: refusal, view: this.view };
            this.render();
            return undefined;
        }
        // What the person was shown about a settling chat, and chose. A page
        // that is out of date is drawn again instead of acted on.
        const carried = this.reviewedExit;
        this.reviewedExit = null;
        const exit = carried?.exit ?? this.readExitChoice();
        const drawnAt = carried ? carried.drawnAt : this.drawnSettlementTime();
        if (exit.stale) {
            // What was picked is not what would happen: it is chosen again
            // from the redrawn page, never carried over.
            this.exitChoice = null;
            this.outcome = {
                tone: 'error', view: this.view,
                message: exit.afterSettlement ? SETTLEMENT_PASSED_STALE_LINE : STALE_EXIT_CHOICE_LINE
            };
            this.render();
            return undefined;
        }
        // Leaving now, before the chat has settled, is an emergency exit
        // whichever method was selected; the choice also says what it gives up.
        const forced = exit.choice === 'zero' || exit.choice === 'bound';
        if (forced) mode = 'escape';
        // How the network fee is paid: from the withdrawal when the person
        // chose that and was shown its fee for exactly this one.
        const sponsored = this.sponsoredPlanFor(mode);
        if (sponsored?.refused) {
            this.outcome = { tone: 'error', message: sponsored.refused, view: this.view };
            const payout = this.sponsoredChoiceNow() === 'payout';
            if (payout) this.sponsoredQuote = null;
            this.render();
            if (payout) void this.refreshSponsoredQuote(mode);
            return undefined;
        }
        // A choice is spent by the attempt it started: whatever is drawn next
        // (another balance with the same figure, a retry) starts from the
        // default again, and giving something up is chosen every time.
        this.exitChoice = null;
        const recheck = this.operationRecheckRequired();
        const details = {
            kind: mode === 'escape' ? 'escape' : 'withdraw',
            title: mode === 'escape' ? 'Starting account recovery' : 'Returning your balance',
            phase: 'settling',
            blocksSend: true
        };
        // The signer holds the transaction to these: the exact amount of a
        // forced exit, or the most a conversion or an immediate concession may
        // take (the bound that was disclosed). Neither is named when no bound
        // was shown, and the exit then concedes nothing.
        if (exit.conceded !== null) details.conceded = exit.conceded;
        if (exit.concededMax !== null) details.concededMax = exit.concededMax;
        // The prepared withdrawal the person looked at, where it is known.
        if (recheck && escapeIntent?.operationId) details.operationId = escapeIntent.operationId;
        // The bounds of a sponsored fee, which the signer holds the operation to.
        if (sponsored) details.sponsored = sponsored.bounds;
        // The balance this attempt is about, so a refusal of it is held for it.
        const aboutNote = noteId != null && /^[0-9]+$/.test(String(noteId)) ? Number(noteId) : null;
        const attempt = Number.isSafeInteger(aboutNote) ? { about: { noteId: aboutNote } } : {};

        // Check before settling chat access or asking the server to close a note.
        if (!sponsored) {
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
            if (sponsored && reviewedScope !== this.withdrawalReviewScope()) {
                this.sponsoredQuote = null;
                throw new Error('Your balance changed while the chat settled. Check the withdrawal fee and review the amount again.');
            }
            if (recheck) {
                // The wallet may ask for an account or a network here, which
                // can take as long as the person likes. Ask it first (the SDK
                // asks again, and is answered at once), then re-verify the
                // balance and the prepared withdrawal under the wallet lock,
                // as the last step before the SDK takes over.
                if (typeof zkapiClient.connectWallet === 'function') await zkapiClient.connectWallet();
                await assertWithdrawalEscapeAvailable({
                    kind: 'note', noteId, operationId: escapeIntent?.operationId ?? null
                });
            }
            // The settling chat's time can pass while the chat key settles or
            // the wallet is asked, which can take as long as the person likes.
            // Waiting, or giving up nothing now, was what they chose; the SDK
            // would give up the whole figure at once. The last look before it.
            if ((exit.choice === 'wait' || exit.choice === 'zero') && this.settlementPassedNow(drawnAt)) {
                throw new Error(SETTLEMENT_PASSED_STALE_LINE);
            }
            // Or the figure it was drawn with can have moved in the meantime
            // (another chat settled, or a new one started).
            if (this.exitFigureMovedNow(exit.choice, exit.bound)) throw new Error(STALE_EXIT_CHOICE_LINE);
            const base = escapeIntent
                ? { destination: escapeIntent.destination, expectedWithdrawalOperationId: escapeIntent.operationId }
                : destination ? { destination } : {};
            if (preparedOperationId && !base.expectedWithdrawalOperationId) base.expectedWithdrawalOperationId = preparedOperationId;
            // A sponsored withdrawal pays no wallet fee: no reserve was reviewed.
            if (!sponsored && getWalletMethod() === 'metamask') base.reviewedFunding = reviewedFunding;
            const options = sponsored ? { ...base, ...sponsored.options } : base;
            const result = await zkapiClient.withdraw(mode, report, forced ? { ...options, concede: exit.choice } : options);
            // Done with this withdrawal's fee choice: the next one starts
            // from the wallet again, as giving something up is.
            this.sponsoredChoice = 'wallet';
            this.sponsoredQuote = null;
            this.recordWithdrawalOutcome(result);
        }, details, attempt);
    }

    recordWithdrawalOutcome(result) {
        // A sponsored withdrawal can end with the payout held at the service's
        // contract (the address would not accept it) or waiting at the holding
        // address; both are said before the ordinary "confirmed".
        if (result?.paymasterCredited === true || result?.fundsWaitingInTransit === true) {
            this.withdrawalCompleted = false;
            this.withdrawalOutcomePending = true;
            this.view = this.view === 'upgrade' ? 'upgrade' : 'withdrawals';
            this.setStatus(result.paymasterCredited === true
                ? `Withdrawal closed. The payout could not be sent to the address, so it is held for you. Claim it from Payment history.${this.sponsoredOutcomeLine(result)}`
                : 'Withdrawal closed. The payout is waiting to be collected. Collect it from Payment history.');
            return;
        }
        if (result?.status === 'collected') {
            this.withdrawalCompleted = true;
            this.withdrawalCompletedAt = Date.now();
            this.withdrawalOutcomePending = false;
            this.setStatus(`Payout collected and sent to your address.${this.sponsoredOutcomeLine(result)}`);
            return;
        }
        // A close whose payout the payment contract could only credit (the
        // address would not take it) is not a payout sent: it is claimed from
        // Payment history. Checked first, because that close names its
        // destination and balance like any other.
        if (result?.status === 'closed' && result.payoutCredited === true) {
            this.withdrawalCompleted = false;
            this.withdrawalOutcomePending = true;
            this.view = this.view === 'upgrade' ? 'upgrade' : 'withdrawals';
            this.setStatus('Withdrawal closed. The payout could not be sent to your address, so it is held for you. Claim it from Payment history.');
        } else if (result?.status === 'closed' && result.event?.destination
            && result.event.finalBalance != null) {
            // A closed vault alone does not prove a payout. The SDK returns this
            // event only after matching the receipt to the saved note/destination.
            this.withdrawalCompleted = true;
            this.withdrawalCompletedAt = Date.now();
            this.withdrawalOutcomePending = false;
            // An upgrade stays on its own steps: the next one is Reload.
            this.view = this.view === 'upgrade' ? 'upgrade' : 'withdrawals';
            this.setStatus(`Withdrawal confirmed. Funds sent to your saved wallet address.${result.userOpHash ? this.sponsoredOutcomeLine(result) : ''}`);
        } else if (result?.status === 'closed') {
            this.withdrawalCompleted = false;
            this.withdrawalOutcomePending = true;
            this.view = this.view === 'upgrade' ? 'upgrade' : 'withdrawals';
            this.setStatus('The private balance is closed. Check Payment history for its payment status.');
        } else if (result?.status === 'pending_withdrawal' && Number(result.deadline) > 0) {
            // The SDK checked the destination before proving: an address that
            // will not take the payout (a contract that refuses ETH) is only
            // credited, and the person is told now, while it is still a
            // choice they can see. Its words are the SDK's, shown escaped.
            const warning = typeof result.destinationWarning === 'string'
                ? result.destinationWarning.trim().slice(0, SDK_SENTENCE_LIMIT) : '';
            this.setStatus(`Escape started. Finalize after ${new Date(result.deadline * 1000).toLocaleString()}.${warning ? ` ${warning}` : ''}`);
        }
    }

    // The outcome of a payout claim: delivered, or sent and still confirming.
    // Anything else was already said by the claim's own status lines.
    recordPayoutClaim(result) {
        if (result?.status === 'claimed') {
            const destination = typeof result.destination === 'string' && /^0x[0-9a-fA-F]{40}$/.test(result.destination)
                ? zkapiClient.compact(result.destination, 6) : '';
            this.setStatus(destination ? `Payout claimed and paid to ${destination}.` : 'Payout claimed.');
        } else if (result?.status === 'pending') {
            this.withdrawalOutcomePending = true;
            this.setStatus('The payout claim was sent and is still confirming. Check again after it confirms.');
        }
    }

    // Deliver a payout the payment contract holds for a closed escape's
    // address. One explicit gesture on that row; the account that sends it
    // pays the fee. Needs no service and no operator.
    claimPayout(recordId) {
        if (typeof recordId !== 'string' || !recordId) return undefined;
        return this.run(async (report) => {
            if (typeof zkapiClient.claimEscapePayout !== 'function') {
                throw new Error('This version has no payout to claim.');
            }
            const result = await zkapiClient.claimEscapePayout(recordId, report);
            this.recordPayoutClaim(result);
        }, {
            kind: 'payout-claim', title: 'Claiming payout', phase: 'wallet',
            withdrawalRecordId: recordId, blocksSend: false
        }, { about: { recordId } });
    }

    formatWithdrawalAmount(amount) {
        const dollars = zkapiClient.formatMoney(amount);
        return (!dollars || /^[—–-]$/.test(dollars.trim()))
            ? `${zkapiClient.formatBillingAmount(amount)} ETH` : dollars;
    }

    // `upgrade` is the withdrawal as the upgrade view embeds it: the same
    // steps and the same button (#zkapi-withdraw-btn), with the choices that
    // only matter to someone staying on this version left out.
    renderWithdrawal({ upgrade = false } = {}) {
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
            // "There is no active private note" would be false: the balance is
            // saved here and the version that holds it did not start.
            const heldView = this.renderHeldBalance(this.currentVersion());
            if (heldView) return heldView;
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
                            : 'An Ethereum wallet window returned after this tab changed. The transaction is saved, and only this balance is paused until Ethereum confirms it.')}</p>
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
                        <p class="zkapi-meta">To ${this.escapeHtml(zkapiClient.compact(recordPayee(withdrawal) || withdrawal.destination, 9))}${deadline ? ` · ready ${this.escapeHtml(new Date(deadline * 1000).toLocaleString())}` : ''}</p>
                    </section>
                    <div class="zkapi-actions">
                        <button id="zkapi-finalize-btn" class="zkapi-primary-button" type="button" ${!ready || this.busy ? 'disabled' : ''}>${ready ? 'Finalize in your Ethereum wallet' : `Finalize in ${zkapiClient.formatExpiry(deadline)}`}</button>
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
        // Versions: the way to leave while a chat settles, who pays the network
        // fee, and the method line of an upgrade (mutual close is the way out of
        // one; the escape hatch is shown only where the server cannot clear it).
        const showJourney = Boolean(this.busy && ['withdraw', 'escape'].includes(this.journeyKind)) || Boolean(prepared);
        const showMethod = !upgrade || Boolean(availableEscape) || this.withdrawMode === 'escape' || preparedMode === 'escape';
        const depositsWait = this.depositsWaitLine();
        const exitChoice = submissionActive ? ''
            : this.renderExitChoice(this.currentVersion(), { offerChoice: !showJourney });
        const sponsoredFee = this.renderSponsoredFee({ prepared, submissionActive, showJourney, upgrade });
        const figure = (caption, meta = '') => `<section class="zkapi-figure-block">
            <p class="zkapi-balance-caption">${caption}</p>
            ${amountKnown ? `<p data-withdraw-amount class="zkapi-balance-amount">${this.escapeHtml(displayAmount)}</p>` : '<p class="zkapi-helper">Checking your remaining balance…</p>'}
            ${amountKnown && !displayAmount.endsWith(' ETH') ? `<p class="zkapi-balance-eth">${this.escapeHtml(zkapiClient.formatBillingAmount(amount))} ETH</p>` : ''}
            ${meta ? `<p class="zkapi-meta">${meta}</p>` : ''}
        </section>`;
        const busyJourney = this.busy && ['withdraw', 'escape'].includes(this.journeyKind);
        const restoring = this.walletMethodReady === false || this.startingAfterInit;
        if (this.withdrawalConfirmation && this.withdrawalConfirmation !== this.withdrawalReviewScope()) this.withdrawalConfirmation = null;
        if (this.withdrawalConfirmation && !busyJourney) {
            // Review, like a wallet's: what leaves, where it goes, what the
            // network takes, then one button that names the amount.
            const escapeReview = this.withdrawMode === 'escape';
            const to = getWalletMethod() === 'address'
                ? `<span class="zkapi-transfer-address">${this.escapeHtml(zkapiClient.compact(withdrawalDestination(this), 9))}</span>`
                : 'Your Ethereum wallet account';
            const feeQuote = this.withdrawalFees?.quote;
            const payoutQuote = this.sponsoredChoiceNow() === 'payout' && this.sponsoredApi()
                ? this.sponsoredViewState(this.withdrawMode).quote : null;
            const feeWei = payoutQuote?.available ? String(BigInt(payoutQuote.maxCostWei) + BigInt(payoutQuote.flatFeeWei) + BigInt(payoutQuote.creditSurchargeWei || '0'))
                : feeQuote ? withdrawalFeeReceiptAmounts(feeQuote).needed : null;
            const feeUsd = feeWei ? fundingUsdText(feeWei) : null;
            const feeText = feeWei ? `${payoutQuote ? 'about' : 'up to'} ${this.escapeHtml(feeUsd || `${formatFundingAmount(feeWei, 18)} ETH`)}` : '—';
            const row = (label, value) => `<div class="zkapi-transfer-row"><span class="zkapi-transfer-label">${label}</span><span class="zkapi-transfer-value">${value}</span><span class="zkapi-transfer-control"></span></div>`;
            const amountText = amountKnown ? this.escapeHtml(displayAmount) : '';
            const receivedWei = payoutQuote?.available ? escapeReview ? payoutQuote.estimatedReceivedWei : payoutQuote.minimumReceivedWei : null;
            const receivedText = receivedWei != null ? this.escapeHtml(fundingUsdText(receivedWei) || `${formatFundingAmount(receivedWei, 18)} ETH`) : amountText;
            return `<div class="zkapi-stack zkapi-withdraw-review">
                <div class="zkapi-transfer">
                    ${row('You withdraw', amountKnown ? `<span data-withdraw-amount>${amountText}</span>` : '<span class="zkapi-transfer-muted">Checking…</span>')}
                    ${row('To', to)}
                    ${row(escapeReview ? 'Network fees' : 'Network fee', `${feeText}${escapeReview ? ' <small>· two steps</small>' : ''}`)}
                    ${row('You receive', amountKnown ? `${payoutQuote ? 'about ' : ''}<b>${receivedText}</b>` : '—')}
                </div>
                ${payoutQuote ? '<p class="zkapi-note">The fee is paid from this withdrawal. No ETH is needed in your signing account. Estimates may change before signing.</p>' : ''}
                <p class="zkapi-note">${!escapeReview
                    ? 'Once the server approves it, it can’t be cancelled, and this balance can’t be used for chat. Closing this window afterward does not cancel the withdrawal.'
                    : `Starting the escape hatch makes this balance unavailable for chat. Return after ${zkapiClient.escapePeriodPhrase()} to finish. Each step has a network fee. You can go back now without starting it.`}</p>
                ${!payoutQuote && this.withdrawalFees?.loading ? '<p class="zkapi-helper" role="status">Checking available ETH…</p>' : ''}
                ${upgrade ? '<p class="zkapi-note">Withdrawing closes this private balance; you deposit again to finish upgrading.</p>' : ''}
                <div class="zkapi-actions zkapi-withdraw-actions"><button id="zkapi-withdraw-review-confirm" class="zkapi-primary-button w-full" type="button" ${this.withdrawalInputReady() ? '' : 'disabled'}>${escapeReview ? 'Start escape hatch' : amountKnown ? `Withdraw ${amountText}` : 'Withdraw'}</button>
                <button id="zkapi-withdraw-review-back" class="zkapi-quiet-button" type="button">Back</button></div>
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
                : droppedOrPending ? 'No receipt yet. It may still be pending, or your Ethereum wallet may have dropped it. Check again, or resubmit it with its original nonce.'
                : submitted ? 'Your withdrawal has been submitted and is waiting to be confirmed on Ethereum.'
                : awaitingWallet ? 'Your Ethereum wallet may still be open. Check it, or recover the request if its window closed.'
                : ambiguous ? 'We couldn’t confirm whether your withdrawal went through. Check its status before trying again.'
                : selectedEscape ? `Continue to prepare the escape proof. After it confirms, wait ${zkapiClient.escapePeriodPhrase()}, then return here to finalize.`
                : prepared.phase === 'reserving' ? 'Paused before the Ethereum wallet prompt. Continue when you’re ready.'
                : clearanceReserved ? 'Nothing has been sent yet.'
                : 'The proof is ready. Nothing has been sent yet.';
            const recipient = prepared?.fee_payer === 'payout' ? prepared.payout : prepared?.destination;
            const destination = recipient
                ? zkapiClient.compact(recipient, 9)
                : getWalletMethod() === 'metamask' ? 'your Ethereum wallet account' : 'your wallet address';
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
                        : `<button id="zkapi-withdraw-btn" class="zkapi-primary-button" type="button" ${this.withdrawalInputReady() ? '' : 'disabled'}>${selectedEscape ? `Start ${zkapiClient.escapePeriodLabel()} escape` : 'Continue in your Ethereum wallet'}</button>`;
            const secondary = this.busy || restoring ? '' : [
                droppedOrPending && prepared?.replacement_available ? `<button id="zkapi-retry-dropped-withdrawal-btn" class="zkapi-secondary-button" type="button">Resubmit</button>` : '',
                awaitingWallet ? `<button id="zkapi-recover-withdrawal-btn" class="zkapi-secondary-button" type="button">Recover withdrawal</button>` : '',
                ambiguous ? `<button id="zkapi-retry-withdrawal-btn" class="zkapi-secondary-button" type="button">Try again in your Ethereum wallet</button>` : ''
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
                    ${exitChoice}
                    ${prepared && clearanceReserved && !submissionActive && !busyJourney ? '<p class="zkapi-note">This withdrawal can’t be cancelled. Close saves your progress.</p>' : ''}
                    ${this.renderOutcome()}
                    ${!submissionActive && !busyJourney && prepared?.fee_payer !== 'payout' ? this.literal(renderWithdrawalFees(this)) : ''}
                    ${prepared?.fee_payer === 'payout' && !busyJourney ? sponsoredFee : ''}
                    <div class="zkapi-actions">${primary}${secondary}${dismiss}</div>
                    ${options ? `<div class="zkapi-guides">${options}</div>` : ''}
                </div>`;
        }

        const address = getWalletMethod() === 'address';
        const escapeForm = this.withdrawMode === 'escape';
        const account = zkapiClient.walletAddress ? ` <span class="zkapi-transfer-address">${this.escapeHtml(zkapiClient.compact(zkapiClient.walletAddress, 6))}</span>` : '';
        // A wallet's send screen: how much, to where, the network fee,
        // Continue. The escape hatch is a quiet link; almost nobody needs it.
        return `
            <div class="zkapi-stack zkapi-withdraw-form">
                ${this.literal(renderWalletMethod(this))}
                ${figure('You withdraw')}
                ${address ? this.literal(renderFundingAccount(this, { rows: false })) : `<div class="zkapi-withdraw-to"><span class="zkapi-balance-caption">To</span><p class="zkapi-withdraw-account">Your Ethereum wallet account${account}</p></div>`}
                ${this.sponsoredChoiceNow() === 'payout' && this.sponsoredApi() ? '' : this.literal(renderWithdrawalFeeLine(this))}
                ${upgrade ? '<p class="zkapi-note">Withdrawing closes this private balance; you deposit again to finish upgrading.</p>' : ''}
                ${exitChoice}${sponsoredFee}
                ${escapeForm ? `<p class="zkapi-note zkapi-withdraw-escape-note">Escape hatch: withdraw without the server’s approval. It takes ${zkapiClient.escapePeriodPhrase()} and two network fees: one to start, one to finish.</p>` : ''}
                ${escapeForm && escapeNeedsSettlement()
                    ? '<p class="zkapi-note" role="status">Your previous chat balance must finish updating before escape is available. This needs the temporary-key service. If it is down, keep this browser data and retry when it returns.</p><button id="zkapi-settle-before-escape" class="zkapi-secondary-button" type="button">Update chat balance</button>'
                    : activeLease ? '<p data-active-lease-notice class="zkapi-note">Your open chat key settles first.</p>' : ''}
                ${this.renderOutcome()}
                <div class="zkapi-actions zkapi-withdraw-actions">
                    ${restoring
                        ? '<button id="zkapi-withdraw-btn" class="zkapi-primary-button w-full" type="button" disabled><span class="zkapi-pill-spinner" aria-hidden="true"></span>Checking wallet…</button>'
                        : `<button id="zkapi-withdraw-btn" class="zkapi-primary-button w-full" type="button" ${this.withdrawalContinueReady() ? '' : 'disabled'}>Continue</button>`}
                    <button id="zkapi-withdraw-dismiss-btn" class="zkapi-quiet-button" type="button">Cancel</button>
                </div>
                ${showMethod || escapeForm ? `<p class="zkapi-withdraw-escape"><button id="zkapi-withdraw-mode-toggle" class="zkapi-text-link" type="button" ${this.busy ? 'disabled' : ''}>${escapeForm ? 'Use the normal withdrawal instead' : 'Server not responding? Use the escape hatch'}</button></p>` : ''}
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
                : this.view === 'upgrade'
                    ? 'Upgrade your balance'
                    : 'Private balance';
        let body;
        if (this.view === 'withdrawals') {
            body = `<p class="zkapi-lede">Deposits and withdrawals saved in this browser</p>${this.renderWithdrawalRecords()}`;
        } else if (this.view === 'withdraw') {
            body = this.renderWithdrawal();
        } else if (this.view === 'upgrade') {
            body = this.renderUpgrade(fundingSetup);
        } else {
            // The signer is a choice only while choosing how to add funds.
            const pending = zkapiClient.config?.pending_deposit;
            const choosing = !zkapiClient.note && !this.depositBalanceRefreshPending
                && (!pending || ['prepared', 'retry_exact'].includes(pending.phase));
            // A balance the page can not read has no funding to choose a method
            // for: the controls above the view would offer what it can not do.
            const balanceHeld = this.currentVersion()?.state?.held?.unreachable === true;
            body = this.depositInMotion() || balanceHeld ? this.renderBalance(fundingSetup)
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
        // Versions: the facade learns the upgrade view is open, then the page
        // reads one state for this whole render. An upgrade view with nothing
        // to upgrade (a stale restore, a stage that moved on) is the balance.
        this.renderCount = (this.renderCount || 0) + 1;
        this.versionBannerSuppressed = false;
        this.syncUpgradeView();
        let version = this.versionContext();
        this.noteUpgradeStage(version);
        if (this.view === 'upgrade' && this.upgradeViewTarget(version) !== 'upgrade') {
            this.view = 'balance';
            this.syncUpgradeView();
            version = this.versionContext();
            this.noteUpgradeStage(version);
        }
        // Giving something up is chosen for the withdrawal in front of the
        // person: leaving Withdraw (or the upgrade that embeds it), or another
        // balance coming into the slot, forgets the pick, so what is drawn
        // next starts from the default again.
        if (this.exitChoice && ((this.view !== 'withdraw' && this.view !== 'upgrade')
            || this.exitChoice.noteId !== this.exitChoiceNoteId())) {
            this.exitChoice = null;
        }
        // Drawn on the wait for the next holdings read, which has a bound.
        this.upgradeSettleShown = this.view === 'upgrade' && version?.state?.upgrade?.stage === 'idle';
        // A discard is "just done" only until the state stops saying unsent;
        // its words are not repeated for as long as the reload that follows it
        // is the state's own reason.
        if (version?.state?.unsent !== true) {
            this.unsentCleared = false;
            const reload = version?.state?.reload;
            if (!(reload?.required === true && reload.reason === 'draft_cleared')) this.draftClearedHere = false;
        }
        this.disposeFundingDisclosures?.();
        const restored = currentWalletModalRestore(this, getWalletMethod());
        const fundingSetup = restored ? { open: restored.setup, scrollTop: restored.scroll } : captureFundingSetupView(this.overlay);
        // The version snapshot and stage the markup of this render reads.
        this.renderedVersion = version;
        this.upgradeStage = this.view === 'upgrade' ? version?.state?.upgrade?.stage ?? null : null;
        let markup;
        try {
            markup = this.dialogMarkup(fundingSetup);
        } finally {
            this.renderedVersion = undefined;
        }
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
        this.acknowledgeShownReminder(version, /data-zkapi-version-banner|data-zkapi-upgrade-view/.test(markup));

        this.disclosureAnimating = false;
        this.disclosureRefreshPending = false;
        attachWalletMethodControls(this);
        if (getWalletMethod() === 'address') {
            // Local recovery replays stored signed bytes. It does not request a
            // new wallet signature or offer an unsupported fee replacement.
            this.overlay.querySelectorAll('#zkapi-retry-dropped-deposit-btn, #zkapi-retry-dropped-withdrawal-btn, [data-retry-dropped-finalization], [data-retry-dropped-background-withdrawal]').forEach(button => { button.hidden = true; });
        }

        this.disposeFundingDisclosures = attachFundingDisclosures(this.overlay, (key, open) => {
            if (key === 'history') {
                this.historyOpen = open;
                // Opening Payment history is when the other versions' payments
                // are read (the facade coalesces the reads).
                if (open) this.refreshOtherVersionHistory();
            } else if (key !== 'setup') (this.privateBalanceHelpOpen ||= {})[key] = open;
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
        this.attachVersionActions(version);
        this.attachUpgradeDestination(version);
        this.attachHistoryOpen();
        this.overlay.querySelectorAll('input[name="zkapi-withdraw-concede"]').forEach(input => {
            input.addEventListener('change', () => this.rememberExitChoice());
        });
        this.overlay.querySelectorAll('[data-claim-payout]').forEach(button => {
            button.addEventListener('click', () => this.claimPayout(button.dataset.claimPayout));
        });
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
            else this.setStatus('Your deposit is not confirmed yet. If your Ethereum wallet shows a pending transaction, wait for it to finish.');
        }, { kind: 'deposit', title: 'Checking deposit', phase: 'syncing', blocksSend: true }));
        this.overlay.querySelector('#zkapi-recover-deposit-btn')?.addEventListener('click', () => this.run(async (report) => {
            await zkapiClient.recoverUnknownDeposit(report);
        }, { kind: 'deposit', title: 'Recovering wallet request', phase: 'syncing', blocksSend: true }));
        this.overlay.querySelector('#zkapi-retry-deposit-btn')?.addEventListener('click', () => {
            if (getWalletMethod() === 'address') return this.prepareAddressDepositRetry();
            if (!globalThis.confirm('Only try again if your Ethereum wallet is closed and Check payment status still finds no deposit. This asks your Ethereum wallet to submit the same saved deposit again.')) return;
            return this.run(async (report) => {
                const result = await zkapiClient.retryUnknownDeposit(report);
                this.depositAmount = null;
                this.recordDepositConfirmation(result);
            }, { kind: 'deposit', title: 'Retrying deposit', phase: 'wallet', blocksSend: true });
        });
        this.overlay.querySelector('#zkapi-retry-dropped-deposit-btn')?.addEventListener('click', () => {
            if (!globalThis.confirm('Resubmit the exact same deposit with its original account nonce? Your Ethereum wallet may charge a replacement gas fee, but only one transaction at that nonce can execute.')) return;
            return this.run(async (report) => {
                const result = await zkapiClient.retryDroppedDeposit(report);
                this.depositAmount = null;
                this.recordDepositConfirmation(result);
            }, { kind: 'deposit', title: 'Replacing pending deposit', phase: 'wallet', blocksSend: true });
        });
        this.overlay.querySelectorAll('[data-view-current-deposit]').forEach(button => {
            button.addEventListener('click', () => { this.view = 'balance'; this.render(); });
        });
        this.overlay.querySelector('#zkapi-done-start-btn')?.addEventListener('click', () => { if (!this.busy) this.close(); });
        this.overlay.querySelector('#zkapi-done-balance-btn')?.addEventListener('click', () => {
            if (this.busy) return;
            this.clearTransientOutcome();
            this.render();
        });
        // The check draws once, not on every background re-render.
        const doneCheck = this.overlay.querySelector('.zkapi-done-check');
        if (doneCheck && !this.depositDoneShown) {
            this.depositDoneShown = true;
            if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
                doneCheck.animate?.([{ transform: 'scale(0.8)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
                doneCheck.querySelector('path')?.animate?.([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 360, delay: 140, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' });
            }
        }
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
        this.overlay.querySelector('#zkapi-withdraw-mode-toggle')?.addEventListener('click', () => {
            if (this.busy) return;
            this.withdrawMode = this.withdrawMode === 'escape' ? 'mutual' : 'escape';
            this.clearTransientOutcome();
            this.render();
            // Send to address asks again on its own Continue, not here.
            if (!this.addressPayoutOnly() && this.sponsoredChoice === 'payout') void this.refreshSponsoredQuote(this.withdrawMode);
        });
        this.overlay.querySelectorAll('input[name="zkapi-withdraw-mode"]').forEach(input => {
            input.addEventListener('change', () => {
                this.withdrawMode = input.value;
                this.render();
                // A quote is for one way of leaving: ask again for this one
                // (Send to address asks on its own Continue).
                if (!this.addressPayoutOnly() && this.sponsoredChoice === 'payout') void this.refreshSponsoredQuote(this.withdrawMode);
            });
        });
        this.overlay.querySelectorAll('input[name="zkapi-sponsored-fee"]').forEach(input => {
            input.addEventListener('change', () => {
                if (this.busy) return;
                this.sponsoredChoice = input.value === 'payout' ? 'payout' : 'wallet';
                this.withdrawalConfirmation = null;
                stopWithdrawalFees(this);
                if (this.sponsoredChoice === 'payout') void this.refreshSponsoredQuote();
                else this.render();
            });
        });
        this.overlay.querySelector('[data-zkapi-sponsored-retry]')?.addEventListener('click', () => {
            if (!this.busy) void this.refreshSponsoredQuote();
        });
        const confirm = this.overlay.querySelector('#zkapi-withdraw-confirm');
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
            if (withdrawButton) withdrawButton.disabled = !this.withdrawalContinueReady();
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
            if (!globalThis.confirm('Only retry if your Ethereum wallet is closed and Check transaction still shows this balance as active. A previously broadcast transaction could otherwise use gas twice.')) return;
            return this.run(async (report) => {
                const result = await zkapiClient.retryUnknownWithdrawal(report);
                this.recordWithdrawalOutcome(result);
            }, { kind: 'withdraw', title: 'Retrying withdrawal', phase: 'wallet', blocksSend: true });
        });
        this.overlay.querySelector('#zkapi-retry-dropped-withdrawal-btn')?.addEventListener('click', () => {
            if (!globalThis.confirm('Resubmit the exact same withdrawal with its original account nonce? Your Ethereum wallet may charge a replacement gas fee, but only one transaction at that nonce can execute.')) return;
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
            const url = versionFacade()?.sponsored?.bundlerUrl?.();
            const result = await zkapiClient.finalizeEscape(report, undefined,
                zkapiClient.withdrawal?.feePayer === 'payout' && url ? { bundlerUrl: url } : undefined);
            this.recordWithdrawalOutcome(result);
        }, { kind: 'escape-finalize', title: 'Finishing account recovery', phase: 'wallet', blocksSend: true }));
        this.overlay.querySelectorAll('[data-finalize-withdrawal]').forEach(button => {
            button.addEventListener('click', () => this.run(async (report) => {
                // A sponsored escape finishes through the service's relay too:
                // always the app's own route to it.
                const url = versionFacade()?.sponsored?.bundlerUrl?.();
                const finalizing = zkapiClient.withdrawals.find(entry => entry.recordId === button.dataset.finalizeWithdrawal);
                const sponsoredRecord = finalizing?.feePayer === 'payout' && url;
                const result = await zkapiClient.finalizeEscape(button.dataset.finalizeWithdrawal, report,
                    sponsoredRecord ? { bundlerUrl: url } : undefined);
                this.recordWithdrawalOutcome(result);
            }, { kind: 'escape-finalize', title: 'Finishing withdrawal', phase: 'wallet', withdrawalRecordId: button.dataset.finalizeWithdrawal },
            { about: { recordId: button.dataset.finalizeWithdrawal } }));
        });
        // The payout a sponsored withdrawal left at its holding address: the
        // service's sponsored collection first (no ETH needed), or one
        // transaction from the wallet.
        this.overlay.querySelectorAll('[data-collect-transit]').forEach(button => {
            button.addEventListener('click', () => {
                const recordId = button.dataset.collectTransit;
                const url = versionFacade()?.sponsored?.bundlerUrl?.();
                return this.run(async (report) => {
                    const result = await zkapiClient.collectTransitBalance(recordId, report, url ? { bundlerUrl: url } : {});
                    this.recordWithdrawalOutcome(result);
                }, { kind: 'transit-collect', title: 'Collecting payout', phase: 'wallet', withdrawalRecordId: recordId, blocksSend: false },
                { about: { recordId } });
            });
        });
        this.overlay.querySelectorAll('[data-sweep-transit]').forEach(button => {
            button.addEventListener('click', () => {
                const recordId = button.dataset.sweepTransit;
                return this.run(async (report) => {
                    const result = await zkapiClient.sweepTransit(recordId, report);
                    if (result?.status === 'swept') this.setStatus('Payout collected and sent to your address.');
                }, { kind: 'transit-sweep', title: 'Collecting payout', phase: 'wallet', withdrawalRecordId: recordId, blocksSend: false },
                { about: { recordId } });
            });
        });
        this.overlay.querySelectorAll('[data-claim-gasless-credit]').forEach(button => {
            button.addEventListener('click', () => {
                const recordId = button.dataset.claimGaslessCredit;
                const record = zkapiClient.withdrawals.find(entry => entry.recordId === recordId);
                const payee = recordPayee(record);
                if (!payee) return undefined;
                return this.run(async (report) => {
                    const result = await zkapiClient.claimGaslessCredit(payee, report);
                    if (result?.status === 'claimed') this.setStatus('Payout claimed and sent to your address.');
                }, { kind: 'transit-claim', title: 'Claiming payout', phase: 'wallet', withdrawalRecordId: recordId, blocksSend: false },
                { about: { recordId } });
            });
        });
        this.overlay.querySelectorAll('[data-sync-withdrawal]').forEach(button => {
            button.addEventListener('click', () => this.run(async (report) => {
                await zkapiClient.syncEscapeWithdrawals(report, button.dataset.syncWithdrawal);
            }, { kind: 'withdraw-sync', title: 'Checking withdrawal', phase: 'syncing' },
            { about: { recordId: button.dataset.syncWithdrawal } }));
        });
        this.overlay.querySelectorAll('[data-recover-finalization]').forEach(button => {
            button.addEventListener('click', () => this.run(async (report) => {
                await zkapiClient.recoverUnknownFinalization(
                    button.dataset.recoverFinalization,
                    report
                );
            }, { kind: 'withdraw-sync', title: 'Recovering wallet request', phase: 'syncing' },
            { about: { recordId: button.dataset.recoverFinalization } }));
        });
        this.overlay.querySelectorAll('[data-resolve-challenged-finalization]').forEach(button => {
            button.addEventListener('click', () => {
                if (!globalThis.confirm('Confirm that the old Ethereum wallet prompt is closed. This only releases the local prompt marker; no transaction will be sent.')) return;
                return this.run(async (report) => {
                    await zkapiClient.resolveChallengedFinalization(
                        button.dataset.resolveChallengedFinalization,
                        report
                    );
                }, { kind: 'withdraw-sync', title: 'Releasing old wallet prompt', phase: 'syncing' },
                { about: { recordId: button.dataset.resolveChallengedFinalization } });
            });
        });
        this.overlay.querySelectorAll('[data-retry-finalization]').forEach(button => {
            button.addEventListener('click', () => {
                if (!globalThis.confirm('Only retry if your Ethereum wallet is closed and Check transaction still shows this escape as pending. A previously broadcast transaction could otherwise use gas twice.')) return;
                return this.run(async (report) => {
                    const result = await zkapiClient.retryUnknownFinalization(
                        button.dataset.retryFinalization,
                        report
                    );
                    this.recordWithdrawalOutcome(result);
                }, { kind: 'escape-finalize', title: 'Retrying finalization', phase: 'wallet', withdrawalRecordId: button.dataset.retryFinalization },
                { about: { recordId: button.dataset.retryFinalization } });
            });
        });
        this.overlay.querySelectorAll('[data-retry-dropped-finalization]').forEach(button => {
            button.addEventListener('click', () => {
                if (!globalThis.confirm('Resubmit the exact same finalization with its original account nonce? Your Ethereum wallet may charge a replacement gas fee, but only one transaction at that nonce can execute.')) return;
                return this.run(async (report) => {
                    const result = await zkapiClient.retryDroppedFinalization(
                        button.dataset.retryDroppedFinalization,
                        report
                    );
                    this.recordWithdrawalOutcome(result);
                }, { kind: 'escape-finalize', title: 'Replacing finalization', phase: 'wallet', withdrawalRecordId: button.dataset.retryDroppedFinalization },
                { about: { recordId: button.dataset.retryDroppedFinalization } });
            });
        });
        this.overlay.querySelectorAll('[data-retry-dropped-background-withdrawal]').forEach(button => {
            button.addEventListener('click', () => {
                if (!globalThis.confirm('Resubmit this saved background withdrawal with its original account nonce? Your Ethereum wallet may charge a replacement gas fee, but only one transaction at that nonce can execute.')) return;
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
                }, { about: { recordId: button.dataset.retryDroppedBackgroundWithdrawal } });
            });
        });
        this.overlay.querySelectorAll('[data-withdraw-background]').forEach(button => {
            button.addEventListener('click', () => this.run(async (report) => {
                const result = await zkapiClient.withdrawBackground(button.dataset.withdrawBackground, report);
                this.recordWithdrawalOutcome(result);
            }, { kind: 'withdraw', title: 'Withdrawing set-aside balance', phase: 'preparing', blocksSend: false,
                withdrawalRecordId: button.dataset.withdrawBackground },
            { about: { recordId: button.dataset.withdrawBackground } }));
        });
        this.overlay.querySelectorAll('[data-cancel-background-preparation]').forEach(button => {
            button.addEventListener('click', () => this.run(async report => {
                await zkapiClient.cancelBackgroundWithdrawalPreparation(button.dataset.cancelBackgroundPreparation, report);
            }, { kind: 'withdraw-sync', title: 'Canceling preparation', phase: 'syncing', blocksSend: false },
            { about: { recordId: button.dataset.cancelBackgroundPreparation } }));
        });
        this.overlay.querySelectorAll('[data-restore-withdrawal]').forEach(button => {
            button.addEventListener('click', () => this.run(async (report) => {
                await zkapiClient.restoreWithdrawal(button.dataset.restoreWithdrawal, report);
                this.view = button.dataset.withdrawalOnly === 'true' ? 'withdraw' : 'balance';
            }, { kind: 'withdraw-sync', title: 'Restoring balance', phase: 'syncing' },
            { about: { recordId: button.dataset.restoreWithdrawal } }));
        });
    }
}
