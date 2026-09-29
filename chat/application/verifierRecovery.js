import { buildVerifierSubmitKeyProof } from './accessController.js';
import { clearUnverifiedOpenRouterAccess, isVerifierUnavailable } from '../services/inference/verifiedAccess.js';

// A response for a retired key must never modify its replacement or another lane.
export function applyVerifierRetryResult(session, accessInfo, result) {
    let changed = false;
    const update = (key, info) => {
        if (key !== accessInfo.key || info?.stationId !== accessInfo.stationId ||
            !isVerifierUnavailable(info?.verifierSubmitKeyProof)) return;
        info.verifierSubmitKeyProof = buildVerifierSubmitKeyProof(result, info);
        changed = true;
    };
    update(session?.apiKey, session?.apiKeyInfo);
    for (const lane of Object.values(session?.councilAccess || {})) update(lane?.apiKey, lane?.apiKeyInfo);
    if (changed) clearUnverifiedOpenRouterAccess(session, { reason: 'verifier-retry-rejected' });
    return changed;
}
