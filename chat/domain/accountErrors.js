/**
 * Plain words for account and passkey failures. Pure: shared by the account
 * service and the sign-in dialog, which must never show a browser's
 * DOMException text, a proxy's status line or an abort reason.
 */
// What a failed fetch says depends on the browser; none of it is for people.
const NETWORK_FAILURE_PATTERN = /failed to fetch|load failed|networkerror|network request failed|could not connect/i;
// Status text a proxy or server puts where a message should be.
const BARE_STATUS_TEXT_PATTERN = /^(?:bad gateway|internal server error|service unavailable|gateway time-?out|request failed)$/i;

/**
 * True when a request failed without saying whether it landed: a timeout, a
 * dropped connection or a server error. A sign-up that fails this way may
 * have created the account anyway.
 */
export function isAmbiguousAccountFailure(error) {
    if (!error) return false;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    if (error.name === 'TypeError' && NETWORK_FAILURE_PATTERN.test(String(error.message || ''))) return true;
    const status = Number(error.status);
    return Number.isFinite(status) && status >= 500;
}

export function toFriendlyAccountError(error) {
    if (!error) return 'Unexpected error';
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'Request timed out, please try again';
    if (error.name === 'NotAllowedError') return 'Passkey prompt was cancelled';
    if (error.code === 'ENCRYPTION_PASSKEY_NOT_AVAILABLE') return error.message;
    if (error.code === 'ACCOUNT_KEY_PERSIST_FAILED') return error.message;
    if (error.name === 'OperationError') return 'Invalid recovery code, please check and try again';
    if (error.name === 'TokenInvalidatedError') return 'Session expired, please sign in again';
    // WebAuthn failures other than a cancel carry the browser's own wording.
    if (error.name === 'InvalidStateError') return 'This device already has a passkey for this account.';
    if (error.name === 'SecurityError') return 'This browser blocked the passkey request. Please try again.';
    if (error.name === 'NotSupportedError') return 'This browser can\u2019t create a passkey here. Try another browser.';
    if (error.name === 'UnknownError' || error.name === 'ConstraintError') {
        return 'Your device couldn\u2019t finish the passkey. Please try again.';
    }
    if (error.name === 'TypeError' && NETWORK_FAILURE_PATTERN.test(String(error.message || ''))) {
        return 'Can\u2019t reach Open Anonymity. Check your connection and try again.';
    }
    const status = Number(error.status);
    if (status === 429) return 'Too many attempts. Wait a moment, then try again.';
    if ((Number.isFinite(status) && status >= 500) || BARE_STATUS_TEXT_PATTERN.test(String(error.message || '').trim())) {
        return 'Something went wrong on our side. Please try again in a moment.';
    }
    if (error.code === 'USERNAME_UNAVAILABLE' && /^username is unavailable$/i.test(String(error.message || ''))) {
        return 'That username isn\u2019t available. Try another one.';
    }
    return error.message || 'Unexpected error';
}
