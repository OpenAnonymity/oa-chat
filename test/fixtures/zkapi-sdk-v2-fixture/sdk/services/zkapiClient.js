// FIXTURE: stand-in for sdk/services/zkapiClient.js (zkapi 0.2.0, 82c8504).
//
// The real module's public surface by name. Every instance method of
// ZkapiClient is a stub that records its call (see fixtureSupport.js), except
// subscribe, subscribeClock, emitChange, emitClock and snapshot, which are the
// real logic, and the simple state getters, which follow the real ones
// (activeWithdrawal omits the late-attempt fallback; expiryHistory and
// nativePriceQuote are inert). A test can therefore drive the singleton the way
// the host's tests drive the real one: assign config, wallet or withdrawals,
// then subscribe. The member lists are pinned against the real class by
// verify-exports.mjs. The constructor does not read localStorage.
//
// Like the real module it publishes the singleton as globalThis.zkapiClient
// at evaluation time: one SDK per page.
import { beginBrowserSdkInitialization } from '../configure.js';
import browserWalletRuntime from './browserWalletRuntime.js';
import { defineRecordedMethods, fixtureCallLog, recordCall } from './fixtureSupport.js';

const DISPLAY_HELPERS = [
    'formatMoney', 'formatBillingAmount', 'formatExpiry', 'compact', 'networkName',
    'escapePeriodLabel', 'escapePeriodPhrase', 'escapePeriodBadge'
];

class ZkapiClient extends EventTarget {
    constructor() {
        super();
        this.config = null;
        this.wallet = null;
        this.walletAddress = null;
        this.withdrawal = null;
        this.withdrawals = [];
        this.deposits = [];
        this.challengePeriodSeconds = 24 * 60 * 60;
        this.loading = false;
        this.lastError = null;
        this.initialized = false;
        this.initPromise = null;
        this.refreshTimer = null;
        this.clockTimer = null;
        this.browserMode = true;
        this.activities = [];
        this.activitySequence = 0;
        this.withdrawPromise = null;
        this.withdrawPromiseKey = null;
        this.finalizePromise = null;
        this.finalizePromiseKey = null;
        this.depositPromise = null;
        this.depositPromiseKey = null;
        this.backgroundReconciliationPromise = null;
        this.visibilityHandler = null;
        // FIXTURE-ONLY, non-enumerable so Object.keys(client) equals the real
        // class's field list: the shared call log, the wallet provider set by
        // setWalletProvider, and extra headers acquireInferenceAccess adds to
        // the real header set (for allowlist tests).
        Object.defineProperty(this, 'fixtureCalls', { value: fixtureCallLog(), enumerable: false });
        Object.defineProperty(this, 'fixtureAccessHeaders', { value: {}, writable: true, enumerable: false });
        Object.defineProperty(this, 'walletProviderOverride', { value: null, writable: true, enumerable: false });
    }

    async init() {
        recordCall('client', 'init', []);
        beginBrowserSdkInitialization();
        if (this.initPromise) return this.initPromise;
        this.initPromise = (async () => {
            await browserWalletRuntime.init();
            this.initialized = true;
            return this.snapshot();
        })().catch((error) => {
            this.lastError = error;
            this.initPromise = null;
            this.emitChange('error');
            throw error;
        });
        return this.initPromise;
    }

    async refresh() {
        recordCall('client', 'refresh', []);
        return this.snapshot();
    }

    setWalletProvider(provider = null) {
        recordCall('client', 'setWalletProvider', [provider]);
        if (provider !== null && (typeof provider !== 'object' || typeof provider.request !== 'function')) {
            throw new TypeError('The wallet provider must implement EIP-1193 request().');
        }
        this.walletProviderOverride = provider;
        return this.snapshot();
    }

    snapshot() {
        recordCall('client', 'snapshot', []);
        return {
            config: this.config,
            wallet: this.wallet,
            walletAddress: this.walletAddress,
            withdrawal: this.withdrawal,
            withdrawals: this.withdrawals.map(record => ({ ...record })),
            deposits: this.deposits.map(record => ({ ...record })),
            challengePeriodSeconds: this.challengePeriodSeconds,
            loading: this.loading,
            lastError: this.lastError,
            initialized: this.initialized,
            activities: this.activities.map(activity => ({ ...activity }))
        };
    }

    subscribe(listener) {
        recordCall('client', 'subscribe', [listener]);
        const handler = (event) => listener(this.snapshot(), event.detail);
        this.addEventListener('change', handler);
        return () => this.removeEventListener('change', handler);
    }

    subscribeClock(listener) {
        recordCall('client', 'subscribeClock', [listener]);
        const handler = (event) => listener(event.detail);
        this.addEventListener('clock', handler);
        return () => this.removeEventListener('clock', handler);
    }

    emitClock() {
        recordCall('client', 'emitClock', []);
        this.dispatchEvent(new CustomEvent('clock', { detail: { now: Date.now() } }));
    }

    emitChange(reason = 'update') {
        recordCall('client', 'emitChange', [reason]);
        this.dispatchEvent(new CustomEvent('change', { detail: { reason } }));
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('zkapi-state-changed', {
                detail: { reason, snapshot: this.snapshot() }
            }));
        }
    }

    /**
     * The access shape and header set of the real client's key lease: same
     * fields, same four headers (x-title is 'zkAPI' in this SDK generation).
     */
    async acquireInferenceAccess(sessionId, options = {}) {
        recordCall('client', 'acquireInferenceAccess', [sessionId, options]);
        const apiKey = 'fixture-ephemeral-key';
        return {
            mode: 'ephemeral-key',
            apiKey,
            baseUrl: 'https://openrouter.ai/api/v1',
            spendingLimitUsd: Number(options.spendingLimitUsd) || 1,
            headers: {
                authorization: `Bearer ${apiKey}`,
                'content-type': 'application/json',
                'http-referer': globalThis.location?.origin || 'https://fixture.invalid',
                'x-title': 'zkAPI',
                ...this.fixtureAccessHeaders
            },
            release: () => {}
        };
    }

    get ethereum() {
        return this.walletProviderOverride || globalThis.ethereum;
    }

    get walletProviderBusy() { return false; }

    get isNativeEthFunding() {
        return this.config?.funding?.billing_asset === 'native_eth';
    }

    get nativePriceQuote() { return null; }

    get creditsPerUsd() { return Number.NaN; }

    get hasNote() {
        return !!this.wallet?.has_note && !!this.wallet?.note;
    }

    get note() {
        return this.wallet?.note || null;
    }

    get noteExpiryClaim() {
        if (this.note?.note_id == null) return null;
        return this.deposits.find(record => record.status === 'confirmed'
            && record.noteId === Number(this.note.note_id))?.expiryClaim || null;
    }

    get expiryHistory() { return []; }

    get requestMode() {
        return 'direct_openrouter';
    }

    get isDirectMode() {
        return this.requestMode === 'direct_openrouter';
    }

    get suggestedDeposit() {
        return 5;
    }

    get billingTokenSymbol() {
        return 'ETH';
    }

    get isMainnetFunding() {
        return Number(this.config?.funding?.chain_id) === 1;
    }

    get activeLease() {
        const lease = this.config?.active_lease;
        return lease && Number(lease.expires_at) * 1000 > Date.now() ? lease : null;
    }

    get activeLateWithdrawal() {
        const noteId = this.note?.note_id;
        if (noteId == null) return null;
        return (this.config?.late_withdrawal_attempts || []).find(attempt =>
            Number(attempt.note_id) === Number(noteId)) || null;
    }

    get withdrawalBlocksChat() {
        return !!this.activeLateWithdrawal
            || !!this.config?.prepared_withdrawal
            || !!this.config?.exit?.lock
            || ['prepared', 'submitted', 'pending'].includes(this.withdrawal?.phase);
    }

    get activeWithdrawal() {
        return this.config?.prepared_withdrawal || this.withdrawal || null;
    }

    get openWithdrawals() {
        return this.withdrawals.filter(record => record.phase !== 'closed'
            || record.finalizeTransactionHash
            || record.finalizeSubmissionId);
    }

    get unresolvedLateWithdrawals() {
        return [...(this.config?.late_withdrawal_attempts || [])];
    }

    get withdrawalRecoveryCount() {
        return this.openWithdrawals.length + this.unresolvedLateWithdrawals.length;
    }

    get creditedEscapePayouts() {
        return this.withdrawals.filter(record => record.payoutCredited === true
            && record.payoutClaimed !== true
            && ['closed_unconfirmed', 'closed'].includes(record.phase));
    }

    get testnetAuthenticated() { return false; }
}

defineRecordedMethods(ZkapiClient.prototype, 'client', {
    strings: DISPLAY_HELPERS,
    async: `
    init enableBrowserMode reconcileBrowserWithdrawalsOnLoad reconcileBrowserWalletInBackground
    refresh refreshEthUsdPrice quoteDepositUsd prepareDepositQuote acquireInferenceAccess
    syncExpiryHistory archiveClaimedBalance assertBalanceNotClaimed ensureNetwork
    assertFundingChain connectWallet readContractUint loadChallengePeriod waitForReceipt
    submittedTransactionMetadata acknowledgeExternalTransactionReceipt resumeExternalTransaction
    sendContractTransaction readDepositReceiptMetadata refreshConfirmedBrowserDeposit
    confirmBrowserDepositReceipt readBrowserNote recoverBrowserDeposit recoverUnknownDeposit
    prepareDepositRetry retryUnknownDeposit retryDroppedDeposit deposit assertDepositMayStart
    performDeposit withdraw performWithdrawal recoverFailedWithdrawalSubmission
    recoverUnknownWithdrawal retryUnknownWithdrawal retryDroppedWithdrawal withdrawBackground
    cancelBackgroundWithdrawalPreparation performBackgroundWithdrawal
    retryDroppedBackgroundWithdrawal settleActiveLease hasPendingLease getPendingLeaseOwner
    syncLateWithdrawalAttempts syncWithdrawal browserWithdrawalStateFinality
    finalizedEscapeChallenge browserWithdrawalCloseFinality browserRevertedReceiptFinality
    browserTransactionNonceConsumed browserDepositNonceConsumed
    browserDepositSlotConflictFinality syncEscapeWithdrawals parkPreparedWithdrawal
    cancelPreparedWithdrawal exportExitKit restoreWithdrawal recoverUnknownFinalization
    resolveChallengedFinalization retryUnknownFinalization retryDroppedFinalization
    finalizeEscape performFinalizeEscape escapePayoutMatch escapeConcessionRaisesFor
    readEscapePayoutCredit observedEscapePayoutCredit claimEscapePayout
    creditedEscapePayoutRecord performClaimEscapePayout unclaimedEscapeCredits
    rememberEscapePayoutClaim recordEscapePayoutClaim recordClearedEscapePayout
    markEscapePayoutsClaimed checkEscapeDestination confirmMinedWithdrawalStatus
    readBrowserWithdrawalStatus confirmBrowserWithdrawal ensureTestnetAccess`.split(/\s+/).filter(Boolean),
    sync: `
    setWalletProvider detachWalletEvents attachWalletEvents snapshot runtimeStateSignature
    beginActivity updateActivity completeActivity failActivity cancelActivity subscribe
    subscribeClock emitClock emitChange rememberWithdrawal formatMoney formatBillingAmount
    formatExpiry compact networkName chainParameters externalRecoveryContext setExitRpcUrl
    payoutMatchFields escapePayoutClaimed escapePeriodLabel escapePeriodPhrase escapePeriodBadge`
        .split(/\s+/).filter(Boolean)
});

const zkapiClient = new ZkapiClient();
globalThis.zkapiClient = zkapiClient;

export { ZkapiClient };
export default zkapiClient;
