import { isVerifierUnavailable } from '../services/inference/verifiedAccess.js';

export function renderVerifierAvailability(accessInfo) {
    const proof = accessInfo?.verifierSubmitKeyProof;
    if (!isVerifierUnavailable(proof)) return '';
    const exhausted = proof.detail === 'verification_retry_exhausted';
    const title = exhausted ? 'Verification incomplete' : 'Verifier temporarily unavailable';
    const message = exhausted
        ? 'Verification retries stopped. This key is still unverified.'
        : accessInfo.recentlyAttested === true
            ? 'Chat continues because this station was recently attested. Key verification will retry in the background.'
            : 'Chat continues while key verification is retried in the background.';
    return `<div class="verifier-availability-warning" role="status">
        <span class="verifier-availability-dot" aria-hidden="true"></span>
        <span><strong>${title}</strong><br>${message}</span>
    </div>`;
}
