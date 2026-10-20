// PR31's frontier tree makes deposits immediately usable. Withdrawals bind to
// the stored leaf and pack note ID, deposit amount and expiry into word 8.
// This is a distinct ABI from the earlier proved-activation revision 4.
import concessionV1, { validateConcessionProfile } from './concessionV1.mjs';
import { deepFreeze } from './noteBoundV1.mjs';

const FAMILY = Object.freeze({
    circuitId: 'zkapi-v2-concession-v2', defaultProxyPath: '/zkapi-deployment-v4/'
});

export const leafBoundV2 = Object.freeze({
    ...concessionV1,
    id: 'leaf-bound-v2',
    circuitId: FAMILY.circuitId,
    vaultRevision: 4,
    validateProfile(config, ctx) {
        validateConcessionProfile(config, ctx, FAMILY, 4);
        const pins = config.trusted_deployment;
        if (pins.leaf_bound_exit !== 1) {
            throw new Error('[build] The profile must pin leaf-bound exits (leaf_bound_exit 1).');
        }
        for (const field of ['min_deposit_units', 'fresh_slot_gas']) {
            if (!Number.isSafeInteger(pins[field]) || pins[field] <= 0) {
                throw new Error(`[build] The profile must pin a positive ${field}.`);
            }
        }
        return config;
    },
    callProfile: deepFreeze({
        ...concessionV1.callProfile,
        id: 'leaf-bound-v2',
        fields: { ...concessionV1.callProfile.fields, packedNoteFields: true },
        exits: concessionV1.callProfile.exits.map(exit => ({
            ...exit,
            selector: exit.mode === 'mutual' ? 'bce12a6c' : '8cd67c60'
        }))
    }),
    recoveryEntryPoints: deepFreeze({
        client: [...concessionV1.recoveryEntryPoints.client, 'assertDepositLeaf', 'findBrowserDeposit'],
        runtime: [...concessionV1.recoveryEntryPoints.runtime,
            'assertDepositAmount', 'depositExpiryCandidates', 'findDepositExpiry', 'noteLeafForDeposit', 'nextDepositNoteId']
    })
});

export default leafBoundV2;
