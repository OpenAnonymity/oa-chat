const GOOGLE_AUTH_INTENT = 'google';

export function getAuthenticationIntent(locationImpl = globalThis.location) {
    const params = new URLSearchParams(locationImpl?.search || '');
    return params.get('auth') === GOOGLE_AUTH_INTENT
        ? GOOGLE_AUTH_INTENT
        : null;
}

export function clearAuthenticationIntent(
    locationImpl = globalThis.location,
    historyImpl = globalThis.history
) {
    const params = new URLSearchParams(locationImpl?.search || '');
    if (!params.has('auth')) return false;
    params.delete('auth');
    const search = params.toString();
    const target = `${locationImpl?.pathname || '/chat/'}${search ? `?${search}` : ''}${locationImpl?.hash || ''}`;
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

    accountModal?.open?.();
    return Object.freeze({
        handled: true,
        action: account?.sessionVerified === true ? 'unlock' : 'sign-in'
    });
}
