/**
 * Origin-wide lock for the live account-scoped settings keys.
 *
 * Every reader-modify-writer of tickets or synced preferences must use this
 * lock so an account-scope transition cannot move the keys underneath it.
 */

import { requestQueuedLock } from '../application/queuedLock.js';

const ACCOUNT_DATA_LOCK_NAME = 'oa-sync';
let localLockQueue = Promise.resolve();

export function withAccountDataLock(handler, options = {}) {
    if (
        typeof navigator !== 'undefined' &&
        navigator.locks &&
        typeof navigator.locks.request === 'function'
    ) {
        if (options.boundedQueue) {
            return requestQueuedLock(navigator.locks, ACCOUNT_DATA_LOCK_NAME, options.signal, handler, options);
        }
        return navigator.locks.request(
            ACCOUNT_DATA_LOCK_NAME,
            { mode: 'exclusive' },
            handler
        );
    }

    const run = localLockQueue.then(handler, handler);
    localLockQueue = run.catch(() => {});
    return run;
}

export const ACCOUNT_DATA_LOCK = ACCOUNT_DATA_LOCK_NAME;
