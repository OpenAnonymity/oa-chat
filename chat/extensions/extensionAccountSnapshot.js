const EXPOSED_ACCOUNT_STATUSES = new Set(['none', 'locked', 'unlocked', 'busy']);

/** Return only the non-secret account state promised to extensions. */
export function toExtensionAccountSnapshot(state = {}) {
    return Object.freeze({
        isReady: state.isReady === true,
        // True once the restore attempt has settled, whichever way: only then
        // does "no account" mean signed out rather than still loading.
        authBootstrapComplete: state.authBootstrapComplete === true,
        accountId: state.accountId || null,
        sessionVerified: state.sessionVerified === true,
        accountScopeReady: state.accountScopeReady === true,
        ticketSyncReady: state.ticketSyncReady === true,
        status: EXPOSED_ACCOUNT_STATUSES.has(state.status) ? state.status : 'none'
    });
}
