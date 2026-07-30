/**
 * Origin-wide lock for the live account-scoped settings keys.
 *
 * Every reader-modify-writer of tickets or synced preferences must use this
 * lock so an account-scope transition cannot move the keys underneath it.
 */

const ACCOUNT_DATA_LOCK_NAME = 'oa-sync';
let localLockQueue = Promise.resolve();

export function withAccountDataLock(handler) {
    if (
        typeof navigator !== 'undefined' &&
        navigator.locks &&
        typeof navigator.locks.request === 'function'
    ) {
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
