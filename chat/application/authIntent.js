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
    getPaymentMode = null,
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
    // Username switches can be refused while an old ceremony is running.
    // Retain that intent until the modal accepts it so a reload can retry it.
    const deferUsernameIntentClear = intent === USERNAME_AUTH_INTENT && accountModal?.openForUsername;
    if (!deferUsernameIntentClear) clearAuthenticationIntent(locationImpl, historyImpl);

    // Google and username are the ways in to a Tickets account. Only the
    // landing's own zkAPI entry chooses zkAPI; a mode this browser remembers
    // from an earlier zkAPI visit must not follow the person into their
    // account.
    if (typeof changePaymentMode === 'function' && getPaymentMode?.() === 'zkapi') {
        try {
            await changePaymentMode('tickets');
        } catch (error) {
            console.warn('Tickets could not be selected on arrival:', error);
        }
    }

    let account = accountService.getState();
    const hasExplicitIdentity = intent === GOOGLE_AUTH_INTENT || !!username;
    const matchesIntent = accountMatchesAuthenticationIntent(account, intent, username);
    if (
        account?.accountId &&
        matchesIntent &&
        account.sessionVerified === true &&
        account.status === 'unlocked'
    ) {
        if (deferUsernameIntentClear) clearAuthenticationIntent(locationImpl, historyImpl);
        return Object.freeze({ handled: true, action: 'continue' });
    }

    const clearPreviousAccount = account?.accountId && hasExplicitIdentity && !matchesIntent;
    if (completionToken && accountModal?.openForOAuthCompletion) {
        // The waiting surface must own the entire transition: clearing an old
        // account notifies subscribers and can otherwise expose the login form.
        accountModal.openForOAuthCompletion(intent, completionToken, null, {
            beforeComplete: clearPreviousAccount
                ? () => accountService.clearLocalAccount()
                : null
        });
        return Object.freeze({ handled: true, action: 'complete' });
    }

    if (intent === USERNAME_AUTH_INTENT && accountModal?.openForUsername) {
        // Own the waiting surface before clearing the old account: its
        // subscriber otherwise opens a second sign-in form and drops the handoff.
        let cleanup;
        let blocked = false;
        accountModal.openForUsername(username, null, {
            autoContinue: true,
            ...(clearPreviousAccount ? { onBlocked: () => { blocked = true; }, beforeContinue: () => {
                cleanup = accountService.clearLocalAccount();
                return cleanup;
            } } : {})
        });
        if (blocked) return Object.freeze({ handled: true, action: 'blocked' });
        clearAuthenticationIntent(locationImpl, historyImpl);
        // Keep account-scoped startup behind cleanup, but never behind the
        // native passkey prompt. The modal presents cleanup failures.
        if (cleanup) await cleanup;
        return Object.freeze({
            handled: true,
            action: clearPreviousAccount || account?.sessionVerified !== true ? 'sign-in' : 'unlock'
        });
    }

    if (clearPreviousAccount) {
        await accountService.clearLocalAccount();
        account = accountService.getState();
    }

    accountModal?.open?.();
    return Object.freeze({
        handled: true,
        action: account?.sessionVerified === true ? 'unlock' : 'sign-in'
    });
}
