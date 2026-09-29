import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import { withBrowserWalletLock } from '@openanonymity/zkapi-browser-sdk/store';

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
        const plan = state?.pendingDeposit;
        if (!plan || plan.operationId !== expectedOperationId || state.state
            || plan.phase !== 'prepared' || plan.legacyRecovery
            || plan.submissionId || plan.submissionOwner || plan.submissionFrom
            || plan.submissionNonce != null || plan.transactionHash
            || plan.transactionHashes?.length || plan.transactionAttempts?.length
            || plan.ambiguousSubmissions?.length || plan.approvals?.length
            || state.lateDepositAttempts?.some(attempt => attempt.operationId === expectedOperationId)) return false;
        await runtime.commit({ ...state, pendingDeposit: null });
        // No network refresh is needed to publish this locally committed result.
        // Never overwrite a different operation already observed by the client.
        if (client.config?.pending_deposit?.operation_id === expectedOperationId) {
            client.config = { ...client.config, pending_deposit: null };
        }
        return true;
    });
}
