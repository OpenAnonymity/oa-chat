import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import { withBrowserWalletLock } from '@openanonymity/zkapi-browser-sdk/store';

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error('Private access recovery was stopped.');
    error.name = 'AbortError';
    error.isCancelled = true;
    throw error;
}

function pendingReceiptError() {
    const error = new Error('The private key usage receipt is still being finalized. Try settling again shortly.');
    error.code = 'lease_pending';
    error.status = 409;
    return error;
}

function pendingRecoveryError() {
    const error = new Error('Private access recovery is still pending. Your saved request has been kept. Try again shortly.');
    error.code = 'private_access_recovery_pending';
    error.status = 409;
    return error;
}

/**
 * Finish a request left provisioning when temporary-key issuance was interrupted.
 * Provisioning needs an exact replay before retirement. A replay interrupted
 * before local ownership is recorded also needs SDK recovery here: its scoped
 * settlement deliberately skips journals with no owning chat. Keep every step
 * in its existing wallet lock; only verified SDK recovery may clear the journal.
 */
export function createPrivateLeaseRecovery({
    runtime = walletRuntime,
    withWalletLock = withBrowserWalletLock,
    now = Date.now,
    retryOptions = { maxWaitMs: 15_000, maxAttempts: 2 }
} = {}) {
    return async function recoverInterruptedPrivateAccess({
        signal = null,
        onProgress = () => {},
        sessionId = null
    } = {}) {
        throwIfAborted(signal);
        await runtime.init();
        throwIfAborted(signal);
        return withWalletLock(runtime.manifest.deployment_id, async () => {
            // A canceled lock waiter must never resume issuance later. Reload
            // here because another tab may have completed or replaced its key.
            throwIfAborted(signal);
            await runtime.reload();
            throwIfAborted(signal);
            if (runtime.activeLease || !runtime.runtime?.journal) return false;

            const owner = runtime.runtime.lease;
            if (sessionId && owner?.sessionId && owner.sessionId !== sessionId) return false;
            const ownershipDeadline = Number(owner?.settle_after || owner?.expires_at);
            if (owner && owner.ownerId !== runtime.ownerId
                && ownershipDeadline > Math.floor(now() / 1000)) {
                if (!owner.sessionId) throw pendingReceiptError();
                return false;
            }

            const request = runtime.runtime.journal.prepared_request;
            if (!request?.client_request_id) throw pendingRecoveryError();
            const recoverOwnerlessRequest = async () => {
                let installed;
                try {
                    installed = await runtime.recoverPendingLocked({ retireLostKey: true, onProgress, signal });
                } catch (error) {
                    throwIfAborted(signal);
                    if (error.status === 404) throw pendingRecoveryError();
                    throw error;
                }
                if (!installed || runtime.runtime.journal) throw pendingReceiptError();
                return true;
            };
            let status;
            try {
                status = await runtime.remoteJson(
                    `${runtime.config.funding.protocol_server_url}/v2/openrouter/leases/${encodeURIComponent(request.client_request_id)}`,
                    { signal }
                );
            } catch (error) {
                throwIfAborted(signal);
                // A missing lease may have a consumed nullifier or withdrawal
                // reservation. The SDK must reconcile that evidence; a scoped
                // settlement cannot see an ownerless journal on its own.
                if (error.status === 404) {
                    if (!owner?.sessionId) return recoverOwnerlessRequest();
                    return false;
                }
                throw error;
            }
            throwIfAborted(signal);
            if (status.status !== 'provisioning') {
                if (owner?.sessionId) return false;
                if (status.status === 'active' || status.status === 'finalized') {
                    return recoverOwnerlessRequest();
                }
                throw pendingRecoveryError();
            }

            onProgress('settling', 'Finishing interrupted private access…');
            const lease = await runtime.requestLeaseWithRetry(request, onProgress, signal, retryOptions);
            throwIfAborted(signal);
            await runtime.verifyLease(
                lease,
                request.public_inputs.solvency_bound,
                request.client_request_id,
                onProgress,
                signal
            );
            throwIfAborted(signal);
            // Never assign or persist the returned credential. This key exists
            // solely to close the original request and recover its balance.
            const retired = await runtime.retireRequest(
                request.client_request_id, request, signal, retryOptions
            );
            throwIfAborted(signal);
            if (retired.status !== 'finalized') throw pendingReceiptError();
            // The SDK has no cancellation parameter for receipt installation.
            // Once started, allow its signed state transition to commit while
            // retaining the lock, even if the UI stops waiting in the meantime.
            const installed = await runtime.installRecoveredResponse(request.client_request_id, onProgress);
            if (!installed) throw pendingReceiptError();
            return true;
        });
    };
}

export const recoverInterruptedPrivateAccess = createPrivateLeaseRecovery();
