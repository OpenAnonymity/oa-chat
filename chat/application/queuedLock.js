// Only waiting for ownership is timed out. Once acquired, the caller owns
// cancellation and must retain the lock through any durable commit in flight.
export async function requestQueuedLock(manager, name, signal, execute, options = {}) {
    const controller = new AbortController();
    const setTimer = options.setTimeoutImpl || globalThis.setTimeout;
    const clearTimer = options.clearTimeoutImpl || globalThis.clearTimeout;
    const onAbort = () => controller.abort();
    let timedOut = false;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimer(() => {
        timedOut = true;
        controller.abort();
    }, options.timeoutMs ?? 30_000);
    const cleanup = () => {
        clearTimer(timer);
        signal?.removeEventListener('abort', onAbort);
    };
    try {
        return await manager.request(name, { mode: 'exclusive', signal: controller.signal }, () => {
            cleanup();
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            return execute();
        });
    } catch (error) {
        if (!signal?.aborted && timedOut) {
            const timeout = new Error('Another window is still preparing tickets. You can resume safely.');
            timeout.code = 'ENTITLEMENT_LOCK_TIMEOUT';
            throw timeout;
        }
        throw error;
    } finally {
        cleanup();
    }
}
