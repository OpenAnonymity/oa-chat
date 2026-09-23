import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { recoverInterruptedPrivateAccess } from './privateLeaseRecovery.mjs';

function waitForCaller(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const cancel = () => reject(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
}

// Keep recovery shared by New Chat, renewal, deletion and withdrawal. A proof
// left by failed issuance must be reconciled before the SDK can settle it.
export function createPrivateAccessSettlement({ client, recover, timeoutMs = 30_000 }) {
    let pending = null;
    return async function settle(onStatus, { sessionId = null, signal, expectedOwner = true } = {}) {
        if (signal?.aborted) throw signal.reason;
        if (pending) {
            const previous = pending;
            await waitForCaller(previous.waiting, signal);
            if (previous.sessionId === sessionId) return;
            return settle(onStatus, { sessionId, signal, expectedOwner });
        }
        const controller = new AbortController();
        const cancel = () => controller.abort(signal.reason);
        signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => controller.abort(new Error(
            'Private access could not finish in time. Your recovery record is saved. Retry when the temporary-key service is available.'
        )), timeoutMs);
        const checkCanceled = () => { if (controller.signal.aborted) throw controller.signal.reason; };
        const work = Promise.resolve().then(async () => {
            checkCanceled();
            await client.init();
            checkCanceled();
            if (client.browserMode) {
                await recover({ sessionId, signal: controller.signal,
                    onProgress: (_phase, message) => onStatus?.(message) });
            }
            checkCanceled();
            // Daemon's ordinary New Chat settlement has always been global;
            // its API cannot implement the SDK's expected-owner operation.
            // Mode changes and renewal retain the fail-closed scoped behavior.
            const scopedId = client.browserMode || expectedOwner ? sessionId : null;
            const result = await client.settleActiveLease(onStatus, scopedId ? { sessionId: scopedId } : {});
            // The pinned SDK's scoped settlement can return successfully for
            // an ownerless issuance journal. Never mistake that for clearance.
            if (scopedId && typeof client.hasPendingLease === 'function' && await client.hasPendingLease()) {
                const owner = await client.getPendingLeaseOwner();
                if (!owner || owner === sessionId) {
                    throw new Error('Private access still needs recovery. Your recovery record is saved. Retry when the temporary-key service is available.');
                }
            }
            return result;
        });
        let abortWait;
        const canceled = new Promise((_, reject) => {
            abortWait = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', abortWait, { once: true });
        });
        const entry = { sessionId, waiting: Promise.race([work, canceled]) };
        pending = entry;
        // Timing out releases the caller, never the SDK's wallet mutation.
        // Until that mutation exits, another caller observes the same failure
        // instead of piling up work behind the wallet lock.
        const release = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            controller.signal.removeEventListener('abort', abortWait);
            if (pending === entry) pending = null;
        };
        work.then(release, release);
        return entry.waiting;
    };
}

export const settlePrivateAccess = createPrivateAccessSettlement({
    client: zkapiClient, recover: recoverInterruptedPrivateAccess
});
