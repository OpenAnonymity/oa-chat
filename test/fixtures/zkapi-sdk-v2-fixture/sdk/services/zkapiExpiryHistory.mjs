// FIXTURE: names of sdk/services/zkapiExpiryHistory.mjs (zkapi 0.2.0, 82c8504).
import { unsupportedExports } from './fixtureSupport.js';

export const EXPIRED_CLAIMED_TOPIC = '0x5534ce4a9fb7fe545375064cc186660ac10ba2152cb1592b29b244d2fe169ae4';

export const {
    deriveExpiryRecords, readFinalizedExpiryClaims
} = unsupportedExports('expiry-history');
