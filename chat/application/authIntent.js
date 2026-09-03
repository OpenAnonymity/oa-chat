const GOOGLE_AUTH_INTENT = 'google';
const USERNAME_AUTH_INTENT = 'username';
const AUTHENTICATION_INTENTS = new Set([
    GOOGLE_AUTH_INTENT,
    USERNAME_AUTH_INTENT
]);

export function getAuthenticationIntent(locationImpl = globalThis.location) {
    const params = new URLSearchParams(locationImpl?.search || '');
    const intent = params.get('auth');
    return AUTHENTICATION_INTENTS.has(intent) ? intent : null;
}

export function getUsernameAuthenticationValue(locationImpl = globalThis.location) {
    const params = new URLSearchParams(locationImpl?.search || '');
    if (params.get('auth') !== USERNAME_AUTH_INTENT) return null;
    const fragment = new URLSearchParams((locationImpl?.hash || '').replace(/^#/, ''));
    return String(fragment.get('username') || '').normalize('NFKC').trim().toLowerCase();
}

export function clearAuthenticationIntent(
    locationImpl = globalThis.location,
    historyImpl = globalThis.history
) {
    const params = new URLSearchParams(locationImpl?.search || '');
    if (!params.has('auth')) return false;
    const intent = params.get('auth');
    params.delete('auth');
    let hash = locationImpl?.hash || '';
    if (intent === USERNAME_AUTH_INTENT) {
        const fragment = new URLSearchParams(hash.replace(/^#/, ''));
        if (fragment.has('username')) {
            fragment.delete('username');
            hash = fragment.toString() ? `#${fragment.toString()}` : '';
        }
    }
    const search = params.toString();
    const target = `${locationImpl?.pathname || '/chat/'}${search ? `?${search}` : ''}${hash}`;
    historyImpl?.replaceState?.(historyImpl?.state ?? null, '', target);
    return true;
}

export async function routeAuthenticationIntent({
    accountService,
    accountModal,
    locationImpl = globalThis.location,
    historyImpl = globalThis.history
}) {
    const intent = getAuthenticationIntent(locationImpl);
    if (!intent) return Object.freeze({ handled: false, action: 'none' });
    const username = intent === USERNAME_AUTH_INTENT
        ? getUsernameAuthenticationValue(locationImpl)
        : null;

    await accountService.waitForAuthBootstrap();
    clearAuthenticationIntent(locationImpl, historyImpl);

    const account = accountService.getState();
    if (
        account?.accountId &&
        account.sessionVerified === true &&
        account.status === 'unlocked'
    ) {
        return Object.freeze({ handled: true, action: 'continue' });
    }

    if (intent === USERNAME_AUTH_INTENT && accountModal?.openForUsername) {
        // Do not hold the rest of Chat initialization behind a native prompt.
        accountModal.openForUsername(username, null, { autoContinue: true });
    } else {
        accountModal?.open?.();
    }
    return Object.freeze({
        handled: true,
        action: account?.sessionVerified === true ? 'unlock' : 'sign-in'
    });
}
