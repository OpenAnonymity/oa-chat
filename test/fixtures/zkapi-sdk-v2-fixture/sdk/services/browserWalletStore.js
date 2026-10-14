// FIXTURE: stand-in for sdk/services/browserWalletStore.js (zkapi 0.2.0, 82c8504).
//
// The declaration lines, the lock literal and the channel literal below are the
// real store's, character for character: the host's wallet database rename
// plugin pins this file's SHA-256, rewrites the DB_NAME declaration and asserts
// DB_VERSION, the lock name and the channel name. Do not reformat them. The
// small functional core (open, read, write, lock, channel) is real so a bundle
// can be exercised over a fake IndexedDB; every other export fails loudly.
import { unsupportedExports } from './fixtureSupport.js';

const DB_NAME = 'zkapi-browser-wallet-v1';
// Never bump: older builds must keep opening this shared same-origin database
// (they are the legacy exit route for notes in an older immutable vault).
// Request-archive records reuse the existing 'archives' store instead.
const DB_VERSION = 3;
const RUNTIME_STORE = 'runtime';
const ARCHIVE_STORE = 'archives';
const WITHDRAWAL_STORE = 'withdrawals';
const DEPOSIT_STORE = 'deposits';
const RUNTIME_KEY = 'active';

const EMPTY_RUNTIME = Object.freeze({
    version: 1,
    deploymentId: null,
    state: null,
    journal: null,
    pendingDeposit: null,
    depositQuote: null,
    preparedWithdrawal: null,
    exitLock: null,
    lease: null,
    lateWithdrawalAttempts: [],
    lateDepositAttempts: [],
    updatedAt: 0
});

let databasePromise = null;
let fallbackLock = Promise.resolve();

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    });
}

function openDatabase() {
    if (databasePromise) return databasePromise;
    let opening;
    opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(RUNTIME_STORE)) {
                database.createObjectStore(RUNTIME_STORE);
            }
            if (!database.objectStoreNames.contains(ARCHIVE_STORE)) {
                database.createObjectStore(ARCHIVE_STORE, { keyPath: 'archiveId' });
            }
            if (!database.objectStoreNames.contains(WITHDRAWAL_STORE)) {
                database.createObjectStore(WITHDRAWAL_STORE, { keyPath: 'recordId' });
            }
            if (!database.objectStoreNames.contains(DEPOSIT_STORE)) {
                database.createObjectStore(DEPOSIT_STORE, { keyPath: 'recordId' });
            }
        };
        request.onsuccess = () => {
            const database = request.result;
            database.onversionchange = () => {
                if (databasePromise === opening) databasePromise = null;
                database.close();
            };
            resolve(database);
        };
        request.onerror = () => {
            if (databasePromise === opening) databasePromise = null;
            reject(request.error || new Error('Unable to open the browser wallet database.'));
        };
        request.onblocked = () => {
            if (databasePromise === opening) databasePromise = null;
            reject(new Error('A different tab is blocking the browser wallet upgrade.'));
        };
    });
    databasePromise = opening;
    return opening;
}

function normalizeRuntime(value) {
    return {
        ...EMPTY_RUNTIME,
        ...(value || {}),
        version: 1
    };
}

/** The runtime slot, normalized. Same read as the real store. */
export async function readBrowserWallet() {
    const database = await openDatabase();
    const transaction = database.transaction(RUNTIME_STORE, 'readonly');
    const value = await requestResult(transaction.objectStore(RUNTIME_STORE).get(RUNTIME_KEY));
    await transactionDone(transaction);
    return normalizeRuntime(value);
}

/** FIXTURE: replace the runtime slot (the real store routes through commitBrowserWallet). */
export async function writeBrowserWallet(next) {
    const database = await openDatabase();
    const transaction = database.transaction(RUNTIME_STORE, 'readwrite');
    const runtime = normalizeRuntime({ ...next, updatedAt: Date.now() });
    transaction.objectStore(RUNTIME_STORE).put(runtime, RUNTIME_KEY);
    await transactionDone(transaction);
    return runtime;
}

export async function requestPersistentStorage() {
    if (!navigator.storage?.persist) return false;
    try {
        if (await navigator.storage.persisted?.()) return true;
        return await navigator.storage.persist();
    } catch {
        return false;
    }
}

/** Serialize all wallet mutations across tabs. */
export async function withBrowserWalletLock(deploymentId, operation) {
    // The selected runtime uses one same-origin IndexedDB key. All deployment
    // manifests therefore share one mutation lock; deployment-scoped locks
    // could otherwise overwrite each other from separate tabs.
    const lockName = 'zkapi-wallet:active-runtime';
    if (navigator.locks?.request) {
        return navigator.locks.request(lockName, { mode: 'exclusive' }, operation);
    }
    const previous = fallbackLock;
    let release;
    fallbackLock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
        return await operation();
    } finally {
        release();
    }
}

export function createWalletChannel(deploymentId, onChange) {
    if (typeof BroadcastChannel === 'undefined') return { postMessage() {}, close() {} };
    const channel = new BroadcastChannel('zkapi-wallet:active-runtime');
    channel.addEventListener('message', (event) => onChange?.(event.data));
    return channel;
}

export const PARK_REQUIRES_CLEARANCE_MESSAGE = 'Only a balance whose cooperative close the server granted can be set aside. Withdraw this balance first: its escape needs nothing from the server.';

// Everything else the real store exports (see the policy in fixtureSupport.js).
export const {
    archiveBrowserWallet, assertBrowserBackgroundWithdrawalAvailable,
    authorizeBrowserWithdrawalFinalizationRetry, browserRuntimeHoldsState, browserWalletHoldings,
    browserWalletPayoutCredits, claimBrowserBackgroundWithdrawalSubmission,
    claimBrowserWithdrawalFinalization, claimBrowserWithdrawalFinalizationReplacement,
    claimBrowserWithdrawalStartReplacement, commitBrowserWallet, detachBrowserClosedWithdrawal,
    detachBrowserEscapeWithdrawal, isBrowserBackgroundWithdrawalPreparationCancelable,
    isOpenBrowserWithdrawal, isUnclaimedPayoutCredit, listBrowserRequestArchive,
    listBrowserWithdrawals, markBrowserBackgroundWithdrawalAmbiguous,
    markBrowserWithdrawalFinalizationAmbiguous, markBrowserWithdrawalFinalizationMissingReceipts,
    parkBrowserWithdrawal, preparedWithdrawalParkable, projectBrowserDeposits,
    putBrowserRequestArchive, putBrowserWithdrawal, readBrowserWalletHoldings,
    readBrowserWalletPayoutCredits, readBrowserWalletSnapshot, recordBrowserExpiryClaims,
    releaseBrowserBackgroundWithdrawalSubmission, releaseBrowserWithdrawalFinalization,
    releaseBrowserWithdrawalFinalizationReplacementClaim, releaseBrowserWithdrawalStartSubmission,
    rememberBrowserBackgroundWithdrawalMetadata, rememberBrowserBackgroundWithdrawalTransaction,
    rememberBrowserWithdrawalFinalization, rememberBrowserWithdrawalFinalizationSubmissionMetadata,
    repairBrowserUnsubmittedBackgroundWithdrawal, resolveBrowserBackgroundWithdrawalForRetry,
    resolveBrowserChallengedFinalization, restoreBrowserWithdrawal,
    saveBrowserBackgroundWithdrawalPlan, transferBrowserLateWithdrawalAttempt,
    updateBrowserWithdrawal
} = unsupportedExports('store');
