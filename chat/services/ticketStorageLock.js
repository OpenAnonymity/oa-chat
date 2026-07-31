const TICKET_STORAGE_LOCK_NAME = 'oa-inference-tickets';

let fallbackQueue = Promise.resolve();

/**
 * Serialize every ticket/tombstone read-modify-write in this tab and, where
 * available, across same-origin tabs.
 */
export async function withTicketStorageLock(handler) {
    if (typeof navigator !== 'undefined' &&
        navigator.locks &&
        typeof navigator.locks.request === 'function') {
        return navigator.locks.request(
            TICKET_STORAGE_LOCK_NAME,
            { mode: 'exclusive' },
            handler
        );
    }

    const run = fallbackQueue.then(handler, handler);
    fallbackQueue = run.catch(() => {});
    return run;
}
