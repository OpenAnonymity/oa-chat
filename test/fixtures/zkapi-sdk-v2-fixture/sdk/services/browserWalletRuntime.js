// FIXTURE: stand-in for sdk/services/browserWalletRuntime.js (zkapi 0.2.0, 82c8504).
//
// The real module's public surface by name: every instance method of
// BrowserWalletRuntime is a stub that records its call in the shared log
// (zkapiClient.fixtureCalls and browserWalletRuntime.fixtureCalls are the same
// array). The few methods that give the module its place in the bundle graph
// are functional over the fixture store: init, reload, commit, notify. The
// member lists are pinned against the real class by verify-exports.mjs.
import { beginBrowserSdkInitialization } from '../configure.js';
import {
    createWalletChannel,
    readBrowserWallet,
    requestPersistentStorage,
    withBrowserWalletLock,
    writeBrowserWallet
} from './browserWalletStore.js';
import { defineRecordedMethods, fixtureCallLog, recordCall } from './fixtureSupport.js';

class BrowserWalletHttpError extends Error {
    constructor(message, status, code, data = null) {
        super(message);
        this.name = 'BrowserWalletHttpError';
        this.status = status;
        this.code = code;
        this.data = data;
    }
}

class BrowserWalletRuntime extends EventTarget {
    constructor() {
        super();
        this.worker = null;
        this.browserConfig = null;
        this.manifest = null;
        this.config = null;
        this.runtime = null;
        this.withdrawals = [];
        this.deposits = [];
        this.otherDeploymentWithdrawals = [];
        this.otherDeploymentCredits = [];
        this.requestArchive = [];
        this.settlementFailures = 0;
        this.activeLease = null;
        this.initialized = false;
        this.initPromise = null;
        this.manifestUrl = null;
        this.manifestSelectionProblem = null;
        this.manifestProblem = null;
        this.nativeVaultCheck = null;
        this.startupRecovery = null;
        this.startupRecoveryController = null;
        this.leasePromise = null;
        this.leasePromiseSession = null;
        this.leasePromiseSpendingLimitUsd = null;
        this.leaseAbortController = null;
        this.leaseWaiterCount = 0;
        this.leaseProgressListeners = new Set();
        this.lastLeaseProgress = null;
        this.retirementPromise = null;
        this.requestProverWarmup = null;
        this.settlementTimer = null;
        this.legacyMigrationInProgress = false;
        this.channel = null;
        this.ownerId = 'fixture-tab-owner';
        Object.defineProperty(this, 'fixtureCalls', { value: fixtureCallLog(), enumerable: false });
    }

    async init() {
        recordCall('runtime', 'init', []);
        beginBrowserSdkInitialization();
        if (this.initPromise) return this.initPromise;
        const pending = (async () => {
            await withBrowserWalletLock(null, () => this.reload());
            this.channel ||= createWalletChannel(null, () => {});
            await requestPersistentStorage();
            this.initialized = true;
            return this.snapshot();
        })();
        this.initPromise = pending;
        pending.catch(() => {
            if (this.initPromise === pending) this.initPromise = null;
        });
        return pending;
    }

    async reload() {
        recordCall('runtime', 'reload', []);
        this.runtime = await readBrowserWallet();
        return this.runtime;
    }

    async commit(next) {
        recordCall('runtime', 'commit', [next]);
        this.runtime = await writeBrowserWallet({ ...this.runtime, ...next });
        this.notify();
        return this.runtime;
    }

    notify() {
        recordCall('runtime', 'notify', []);
        this.channel?.postMessage({ updatedAt: this.runtime?.updatedAt ?? 0 });
        this.dispatchEvent(new Event('change'));
    }

    snapshot() {
        recordCall('runtime', 'snapshot', []);
        return {
            config: this.config,
            runtime: this.runtime,
            withdrawals: [...this.withdrawals],
            deposits: [...this.deposits]
        };
    }
}

defineRecordedMethods(BrowserWalletRuntime.prototype, 'runtime', {
    async: `
    init initialize loadBrowserConfig loadServedManifest assertServiceAvailable recoverOnStartup
    directJson discardClosedDepositDraftLocked assertWorkerBundle refreshExitCost
    saveRequestObservations reload commit getDepositHistory rememberExpiryClaims walletStatus
    hasPendingLease getPendingLeaseOwner remoteFetch remoteFetchRaw remoteJson treePath
    nextDepositPath prepareDepositQuote prepareDeposit refreshPendingDeposit pendingDeposit
    claimPendingDepositSubmission claimPendingDepositReplacement
    rememberPendingDepositSubmissionMetadata rememberPendingDepositTransaction
    markPendingDepositRetryable markPendingDepositMissingReceipts
    releasePendingDepositReplacementClaim markPendingDepositAmbiguous markPendingDepositUnknown
    authorizePendingDepositRetry resolvePendingDepositSlotConflict confirmDeposit
    verifiedDepositPath nativeBillingQuote prepareLeaseRequest verifyLease requestLeaseWithRetry
    requestLeaseWithQuoteRecovery vaultWord recoverStaleRootRequest nullifierServerStatus
    issueLease waitForLeasePromise ensureLease retireRequest retireActiveLease settleActiveLease
    settleSessionLease installRecoveredResponse successorRefusal recoverPending
    recoverUnacceptedNativeQuote recoverPendingLocked recoverPendingJournalLocked
    installFinalizedNullifierLocked recoverArchivedRequestsLocked acquireEphemeralKey
    exitRpcEstimateGas exitLowExpiry exitCall exitRecoveryPassLocked lostEpsilonCharge
    exitCurrentRoot rebuildExitPath exitPathLocked staleDeviceCheckLocked exitAdvisoryWarnings
    exitChainStatus noteStatusAtFinality releaseExitLockLocked installLateSuccessorsLocked
    cancelExit exitBeforeBroadcast prepareWithdrawal prepareExitLocked exitRetireLeaseLocked
    prepareMutualCloseLocked requestClearanceLocked prepareEscapeLocked generateOwnershipProof
    backgroundClearance exportExitKit verifyDeploymentForDeposit
    claimPreparedWithdrawalSubmission rememberPreparedWithdrawalSubmissionMetadata
    claimPreparedWithdrawalReplacement rememberPreparedWithdrawalTransaction
    currentLateWithdrawalAttempts updateLateWithdrawalAttempt transferLateWithdrawalAttempt
    releaseBackgroundWithdrawalStartSubmission resolveLateChallengedWithdrawalAttempt
    markPreparedWithdrawalRetryable markPreparedWithdrawalMissingReceipts
    markPreparedWithdrawalAmbiguous releasePreparedWithdrawalReplacementClaim
    authorizePreparedWithdrawalRetry clearPreparedWithdrawal
    recoverPreparedWithdrawalSubmissionClaim markPreparedWithdrawalUnknown
    resolveChallengedPreparedEscape detachEscapeWithdrawal detachClosedWithdrawal
    repairUnsubmittedBackgroundWithdrawal resolveBackgroundWithdrawalForRetry
    prepareBackgroundWithdrawal claimBackgroundWithdrawalSubmission
    rememberBackgroundWithdrawalSubmissionMetadata markBackgroundWithdrawalAmbiguous
    releaseBackgroundWithdrawalSubmission cancelBackgroundWithdrawalPreparation
    rememberBackgroundWithdrawalTransaction parkPreparedWithdrawal updateWithdrawal
    currentPreparedWithdrawal currentWithdrawal currentWithdrawals
    claimBackgroundWithdrawalStartReplacement claimWithdrawalFinalization
    claimWithdrawalFinalizationReplacement rememberWithdrawalFinalization
    rememberWithdrawalFinalizationSubmissionMetadata releaseWithdrawalFinalization
    markWithdrawalFinalizationMissingReceipts releaseWithdrawalFinalizationReplacementClaim
    markWithdrawalFinalizationAmbiguous markWithdrawalFinalizationUnknown
    resolveChallengedWithdrawalFinalization authorizeWithdrawalFinalizationRetry
    restoreWithdrawal archiveNote`.split(/\s+/).filter(Boolean),
    sync: `
    selectedManifestUrl rememberManifestUrl pinnedManifest startPinnedRpcChecks checkNativeVault
    serviceStatus preemptForExit deploymentProxyUrl validateManifest validateTrustedProfile
    validateManifestTrust depositsClosed depositsClosedError vaultCapabilities buildClientConfig
    snapshot requestArchiveSummary exitSummary exitCostWarningAt archiveKey archivedRequestsAt
    tryRequestJournalRecord notify prewarmRequestProver canQuotePendingDeposit
    depositSubmissionMatches leaseBudget assertAnchorAcceptsRequest addLeaseProgressListener
    reportLeaseProgress scheduleSettlement installArchiveUpdates exitTiming
    operatorCallTimeoutMs settlementWindowSeconds pinnedRpc exitRpc exitRpcOnVaultChain
    noteExitRpcChain walletOnVaultChain getExitRpcUrl setExitRpcUrl exitRecordsAt
    exitLockedError lateSuccessorsAt reusablePlan settlementPendingError clearanceAnswerAt
    withdrawalProvingKey decoratePlan validateExistingWithdrawal assertOwnershipProof
    withdrawalRecordId backgroundWithdrawalIdentity`.split(/\s+/).filter(Boolean)
});

const browserWalletRuntime = new BrowserWalletRuntime();
export { BrowserWalletHttpError, BrowserWalletRuntime };
export default browserWalletRuntime;
