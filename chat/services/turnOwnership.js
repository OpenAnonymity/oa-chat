/**
 * Which tab owns a reply that is being written.
 *
 * A turn's assistant row is persisted while it streams, so any tab showing
 * the chat can paint it from storage. The saved streaming flags alone cannot
 * say whether the tab that is writing it is still alive. The owner holds an
 * origin-wide shared Web Lock for the session while the turn runs; the browser
 * releases it when the turn settles or the owner's page goes away (reload,
 * close, crash). Other tabs probe it to tell "answering in another tab" from
 * "nobody is writing this any more".
 *
 * Never blocks the turn: acquisition is scheduled without awaiting it, and a tab
 * without Web Locks simply cannot tell (OWNERSHIP_UNKNOWN).
 */

export const OWNERSHIP_ELSEWHERE = 'elsewhere';
export const OWNERSHIP_NONE = 'none';
export const OWNERSHIP_UNKNOWN = 'unknown';

const TURN_LOCK_PREFIX = 'oa-turn:';

function lockManager() {
    const locks = globalThis.navigator?.locks;
    return locks && typeof locks.request === 'function' ? locks : null;
}

export function turnLockName(sessionId) {
    return `${TURN_LOCK_PREFIX}${sessionId}`;
}

/**
 * Hold the session's turn lock for as long as this tab is writing its reply.
 * Returns the release function. Shared writers coexist. Acquisition queues
 * behind a transient exclusive probe/watch instead of silently losing ownership;
 * the request pipeline never waits for that grant.
 */
export function holdTurn(sessionId) {
    const locks = lockManager();
    if (!locks || !sessionId) return () => {};
    let release = () => {};
    const released = new Promise(resolve => { release = resolve; });
    try {
        locks.request(turnLockName(sessionId), { mode: 'shared' }, () => released).catch(() => {});
    } catch {
        // Restricted contexts can expose Web Locks but reject their use.
    }
    return () => release();
}

/**
 * Whether another tab is writing this session's reply right now.
 * Resolves to OWNERSHIP_ELSEWHERE, OWNERSHIP_NONE or OWNERSHIP_UNKNOWN.
 */
export async function probeTurnOwnership(sessionId) {
    const locks = lockManager();
    if (!locks || !sessionId) return OWNERSHIP_UNKNOWN;
    try {
        // An exclusive grant means no writer remains; shared owners cannot be displaced.
        return await locks.request(turnLockName(sessionId), { mode: 'exclusive', ifAvailable: true },
            lock => (lock ? OWNERSHIP_NONE : OWNERSHIP_ELSEWHERE));
    } catch {
        return OWNERSHIP_UNKNOWN;
    }
}

/**
 * Resolves once the tab writing this session's reply releases it (the turn
 * settled, or that page went away). Resolves at once when nobody holds it.
 * Abort the signal to stop waiting (the chat was switched or re-rendered).
 */
export async function whenTurnReleased(sessionId, signal = null) {
    const locks = lockManager();
    if (!locks || !sessionId) return false;
    if (signal?.aborted) return false;
    try {
        await locks.request(turnLockName(sessionId), { mode: 'exclusive', signal: signal || undefined }, () => undefined);
        return !signal?.aborted;
    } catch {
        return false;
    }
}
