// FIXTURE: names of sdk/services/zkapiExitKit.mjs (zkapi 0.2.0, 82c8504).
import { unsupportedExports } from './fixtureSupport.js';

export const EXIT_KIT_FORMAT = 'zkapi-exit-kit-v1';
export const EXIT_KIT_PBKDF2_ITERATIONS = 600_000;
export const EXIT_KIT_MIN_PASSPHRASE_LENGTH = 10;

export const {
    buildExitKitPayload, openExitKit, sealExitKit
} = unsupportedExports('exit-kit');
