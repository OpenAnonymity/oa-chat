import { VERIFIER_URL } from '../../config.js';
import { buildVerifierSubmitKeyProof } from '../../application/accessController.js';
import { isVerifierResultUsable, isVerifierProofUsable } from '../../services/inference/verifiedAccess.js';

function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || new DOMException('Verification canceled.', 'AbortError');
}

/** The host owns station policy; the SDK still checks the lease, cap and origins. */
export function createProviderKeyVerifier(verifier, { ensureReady = async () => {} } = {}) {
    return async ({ verifierUrl, keyData, signal }) => {
        throwIfAborted(signal);
        if (verifierUrl !== (verifier.verifierUrl || VERIFIER_URL)) throw new Error('The private lease uses a different trusted verifier.');
        await ensureReady();
        throwIfAborted(signal);
        // The SDK retains the actual key only in its active lease. Do not leave
        // a second credential in OA's ticket-key retry queue after settlement.
        const result = await verifier.submitKey(keyData, { queueOnFailure: false });
        throwIfAborted(signal);
        if (!isVerifierResultUsable(result)) {
            const error = new Error(result.error?.message || 'The OA verifier did not approve this private key.');
            error.code = 'ACCESS_VERIFICATION_FAILED';
            throw error;
        }
        return buildVerifierSubmitKeyProof(result, keyData);
    };
}

/** Recheck cached lease admission on every send, including new station bans. */
export function assertPrivateLeaseVerification(lease, verifier) {
    if (!lease || verifier.isStationBanned(lease.station_id)
        || lease.verifierSubmitKeyProof?.stationId !== lease.station_id
        || !isVerifierProofUsable(lease.verifierSubmitKeyProof)) {
        const error = new Error('This private key no longer has usable station verification.');
        error.code = 'ACCESS_VERIFICATION_FAILED';
        throw error;
    }
}


/** Start only when a payment key needs verification, after shared storage opens.
 * Failed storage startup can be retried without changing any wallet state. */
export function createProviderVerifierReadiness(verifier, db) {
    let pending;
    return () => pending ||= (async () => {
        await db.init();
        await verifier.init();
        verifier.startBroadcastCheck(() => null, { immediate: false });
    })().catch(error => { pending = null; throw error; });
}
