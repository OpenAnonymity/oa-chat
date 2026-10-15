import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import { withBrowserWalletLock } from '@openanonymity/zkapi-browser-sdk/store';
import { isUnsentPreparedDeposit } from '../versioning/unsentDeposit.mjs';
import { describeSlot } from '../versioning/walletHoldings.mjs';

export function isWalletCancellation(error) {
    return [error, error?.cause, error?.data?.originalError, error?.error]
        .some(value => value?.code === 4001 || value?.code === 'ACTION_REJECTED');
}

export function depositOperationId(runtime = walletRuntime) {
    return runtime.runtime?.pendingDeposit?.operationId || null;
}

// The pinned SDK keeps a rejected, never-submitted plan for retry. Release
// only that exact unused draft, under its existing cross-tab lock. Submitted,
// ambiguous, legacy, replacement and other-tab work must retain its secrets.
export async function resetCanceledDeposit(error, expectedOperationId, {
    client = zkapiClient, runtime = walletRuntime, withWalletLock = withBrowserWalletLock
} = {}) {
    if (!isWalletCancellation(error) || error?.broadcastPossible === true
        || error?.transactionHash || error?.transactionReceipt || error?.journalRecoveryError) return false;
    if (!expectedOperationId) return !client.config?.pending_deposit;
    if (!client.browserMode) return false;
    await runtime.init();
    return withWalletLock(runtime.manifest.deployment_id, async () => {
        await runtime.reload();
        const state = runtime.runtime;
        // The rule lives in one shared module (versioning/unsentDeposit.mjs) so
        // the host's holdings probe and this release can never disagree about
        // what "never sent" means.
        if (!isUnsentPreparedDeposit(state, { expectedOperationId })) return false;
        await runtime.commit({ ...state, pendingDeposit: null });
        // No network refresh is needed to publish this locally committed result.
        // Never overwrite a different operation already observed by the client.
        if (client.config?.pending_deposit?.operation_id === expectedOperationId) {
            client.config = { ...client.config, pending_deposit: null };
        }
        return true;
    });
}

// A deposit draft or a never-sent deposit plan that pins this wallet to a
// version that no longer accepts deposits ("Cancel unfinished deposit").
//
// This is the user-confirmed counterpart of the host's boot-time discard
// (versioning/walletHoldings.mjs discardDepositDraft): the same classification,
// but through the SDK's own sanctioned write, runtime.commit, under the same
// cross-tab wallet lock, instead of a host write to the database.
//
// Releases only a slot that holds nothing but a quote draft and/or a prepared
// plan that carries no claim, hash or attempt. A started deposit, a note, a
// journal, a lease or any unfinished late attempt is never touched.
//
// @returns {Promise<boolean>} whether something was released
export async function discardUnsentDeposit({
    client = zkapiClient, runtime = walletRuntime, withWalletLock = withBrowserWalletLock
} = {}) {
    if (!client.browserMode) return false;
    await runtime.init();
    return withWalletLock(runtime.manifest.deployment_id, async () => {
        // Re-read under the lock: the decision is made on what is there now.
        await runtime.reload();
        const state = runtime.runtime;
        const kind = describeSlot(state);
        if (kind !== 'draft_only' && kind !== 'unsent_prepared') return false;
        const operationId = state.pendingDeposit?.operationId || null;
        await runtime.commit({ ...state, depositQuote: null, pendingDeposit: null });
        if (operationId && client.config?.pending_deposit?.operation_id === operationId) {
            client.config = { ...client.config, pending_deposit: null };
        }
        return true;
    });
}
