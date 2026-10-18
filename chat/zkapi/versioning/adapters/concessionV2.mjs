// Revision 4 records deposits cheaply, then activates them in proved batches.
// Exits bind directly to the stored note: the tuple has 17 words, including
// packed deposit amount/expiry, and needs no Merkle path or activation.
import concessionV1, { validateConcessionProfile } from './concessionV1.mjs';
import { deepFreeze } from './noteBoundV1.mjs';

const FAMILY = Object.freeze({
    circuitId: 'zkapi-v2-concession-v2', defaultProxyPath: '/zkapi-deployment-v3/'
});

export const concessionV2 = Object.freeze({
    ...concessionV1,
    id: 'concession-v2',
    circuitId: FAMILY.circuitId,
    vaultRevision: 4,
    validateProfile(config, ctx) {
        return validateConcessionProfile(config, ctx, FAMILY, 4);
    },
    callProfile: deepFreeze({
        ...concessionV1.callProfile,
        id: 'concession-v2',
        exits: concessionV1.callProfile.exits.map(exit => ({
            ...exit,
            selector: exit.mode === 'mutual' ? '5acd3b15' : '8e110492',
            words: 27,
            bytesOffset: { word: 17, value: 576n },
            proofLength: { word: 18, value: 256n }
        }))
    }),
    recoveryEntryPoints: deepFreeze({
        client: [...concessionV1.recoveryEntryPoints.client,
            'assertDepositRetryNonceFree', 'browserDepositCheckpoint', 'depositReceiptNote',
            'findDepositNote', 'searchDepositNote'],
        runtime: [...concessionV1.recoveryEntryPoints.runtime,
            'depositRetryNonceUnknown', 'depositRetryPin', 'nextDepositSlot',
            'rememberPendingDepositSearch', 'resolvePendingDepositRetryNonce']
    }),
    normalizeSnapshot(snapshot, ctx) {
        const result = concessionV1.normalizeSnapshot(snapshot, ctx);
        const value = snapshot?.config?.activation;
        if (result.hasNote && ['activating', 'activated', 'unknown'].includes(value?.status)) {
            result.activation = {
                status: value.status,
                queuePosition: Number.isSafeInteger(value.queue_position) && value.queue_position >= 0
                    ? value.queue_position : null,
                paused: value.vault_paused === true
            };
        }
        return result;
    },
    requiredWiring: Object.freeze([...concessionV1.requiredWiring, 'deposit-activation'])
});

export default concessionV2;
