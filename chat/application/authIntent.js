const GOOGLE_AUTH_INTENT = 'google';
const USERNAME_AUTH_INTENT = 'username';
// Not a sign-in: the landing page's zkAPI entry. The chat opens in zkAPI
// mode (no account needed) and offers to fund the private balance.
const ZKAPI_INTENT = 'zkapi';
const AUTHENTICATION_INTENTS = new Set([
    GOOGLE_AUTH_INTENT,
    USERNAME_AUTH_INTENT,
    ZKAPI_INTENT
]);

function normalizeUsername(value) {
    return String(value || '').normalize('NFKC').trim().toLowerCase();
}

export function getAuthenticationIntent(locationImpl = globalThis.location) {
    const params = new URLSearchParams(locationImpl?.search || '');
    const intent = params.get('auth');
    return AUTHENTICATION_INTENTS.has(intent) ? intent : null;
}

export function getUsernameAuthenticationValue(locationImpl = globalThis.location) {
    const params = new URLSearchParams(locationImpl?.search || '');
    if (params.get('auth') !== USERNAME_AUTH_INTENT) return null;
    const fragment = new URLSearchParams((locationImpl?.hash || '').replace(/^#/, ''));
    return normalizeUsername(fragment.get('username'));
}

// The landing page runs the provider popup itself (it has the click) and
// hands the one-time completion token over in the fragment, which never
// reaches a server. Present only for `?auth=google` arrivals that began there.
const OAUTH_COMPLETION_FRAGMENT_KEY = 'oauth';
const OAUTH_COMPLETION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function getOAuthCompletionToken(locationImpl = globalThis.location) {
    const params = new URLSearchParams(locationImpl?.search || '');
    if (params.get('auth') !== GOOGLE_AUTH_INTENT) return null;
    const fragment = new URLSearchParams((locationImpl?.hash || '').replace(/^#/, ''));
    const token = fragment.get(OAUTH_COMPLETION_FRAGMENT_KEY) || '';
    return OAUTH_COMPLETION_TOKEN_PATTERN.test(token) ? token : null;
}

export function accountMatchesAuthenticationIntent(account, intent, username = null) {
    if (!account?.accountId) return false;
    if (intent === GOOGLE_AUTH_INTENT) {
        return account.googleLinked === true && !normalizeUsername(account.username);
    }
    if (intent === USERNAME_AUTH_INTENT) {
        const requestedUsername = normalizeUsername(username);
        return !!requestedUsername && normalizeUsername(account.username) === requestedUsername;
    }
    return false;
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
    const fragmentKey = intent === USERNAME_AUTH_INTENT
        ? 'username'
        : intent === GOOGLE_AUTH_INTENT
            ? OAUTH_COMPLETION_FRAGMENT_KEY
            : null;
    if (fragmentKey) {
        const fragment = new URLSearchParams(hash.replace(/^#/, ''));
        if (fragment.has(fragmentKey)) {
            fragment.delete(fragmentKey);
            hash = fragment.toString() ? `#${fragment.toString()}` : '';
        }
    }
    const search = params.toString();
    const target = `${locationImpl?.pathname || '/'}${search ? `?${search}` : ''}${hash}`;
    historyImpl?.replaceState?.(historyImpl?.state ?? null, '', target);
    return true;
}

export async function routeAuthenticationIntent({
    accountService,
    accountModal,
    changePaymentMode = null,
    locationImpl = globalThis.location,
    historyImpl = globalThis.history
}) {
    const intent = getAuthenticationIntent(locationImpl);
    if (!intent) return Object.freeze({ handled: false, action: 'none' });
    if (intent === ZKAPI_INTENT) {
        clearAuthenticationIntent(locationImpl, historyImpl);
        if (typeof changePaymentMode !== 'function') {
            // A build without zkAPI: the arrival is an ordinary visit.
            return Object.freeze({ handled: false, action: 'none' });
        }
        await accountService.waitForAuthBootstrap();
        try {
            // Selecting zkAPI also runs the send preflight, which opens the
            // funding dialog when the private balance is empty.
            await changePaymentMode(ZKAPI_INTENT);
        } catch (error) {
            console.warn('zkAPI could not be selected on arrival:', error);
        }
        return Object.freeze({ handled: true, action: 'zkapi' });
    }
    const username = intent === USERNAME_AUTH_INTENT
        ? getUsernameAuthenticationValue(locationImpl)
        : null;
    const completionToken = intent === GOOGLE_AUTH_INTENT
        ? getOAuthCompletionToken(locationImpl)
        : null;

    await accountService.waitForAuthBootstrap();
    clearAuthenticationIntent(locationImpl, historyImpl);

    let account = accountService.getState();
    const hasExplicitIdentity = intent === GOOGLE_AUTH_INTENT || !!username;
    const matchesIntent = accountMatchesAuthenticationIntent(account, intent, username);
    if (
        account?.accountId &&
        matchesIntent &&
        account.sessionVerified === true &&
        account.status === 'unlocked'
    ) {
        return Object.freeze({ handled: true, action: 'continue' });
    }

    if (account?.accountId && hasExplicitIdentity && !matchesIntent) {
        await accountService.clearLocalAccount();
        account = accountService.getState();
    }

    if (intent === USERNAME_AUTH_INTENT && accountModal?.openForUsername) {
        // Do not hold the rest of Chat initialization behind a native prompt.
        accountModal.openForUsername(username, null, { autoContinue: true });
    } else if (completionToken && accountModal?.openForOAuthCompletion) {
        // Google already happened on the landing page: finish the session
        // behind a spinner instead of asking for the same click again.
        accountModal.openForOAuthCompletion(intent, completionToken);
        return Object.freeze({ handled: true, action: 'complete' });
    } else {
        accountModal?.open?.();
    }
    return Object.freeze({
        handled: true,
        action: account?.sessionVerified === true ? 'unlock' : 'sign-in'
    });
}
