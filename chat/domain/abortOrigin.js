import { getErrorMessage } from './errorMessage.js';

// Who ended a request. The person's Stop (and closing or deleting the chat)
// aborts the reply's own controller; everything else that surfaces as an
// "abort" came from below it: the relay closing a session, a browser or
// desktop transport giving up, a fetch timeout. Those are failures, not Stops.

const TRANSPORT_ABORT_TEXT = /\b(?:operation was aborted|request aborted|signal is aborted|aborted without reason|the user aborted a request)\b/i;

/** An abort-shaped failure (by name or by the transport's words). */
export function isAbortShaped(error) {
    if (!error) return false;
    return error.name === 'AbortError' || TRANSPORT_ABORT_TEXT.test(String(error.message || ''));
}

/**
 * True for an abort that this reply did not ask for. Call only where the
 * reply's own signal was not aborted (the caller checks that first).
 */
export function isTransportAbort(error) {
    if (!error || error.isCancelled === true || error.isUserAbort === true) return false;
    return error.isTransportAbort === true || isAbortShaped(error);
}

/** 'stop' when the reply's own signal ended it, 'transport' for an abort from below, else null. */
export function abortOrigin(error, signal = null) {
    if (signal?.aborted || error?.isCancelled === true || error?.isUserAbort === true) return 'stop';
    return isTransportAbort(error) ? 'transport' : null;
}

/**
 * The reply line for a key request that failed (not stopped). A transport
 * abort or timeout reads as what it was; the org's own messages are kept.
 * Key requests are not resent automatically: a retry could spend tickets.
 */
export function accessFailureText(error) {
    if (isTransportAbort(error) || error?.code === 'REQUEST_TIMEOUT' || error?.isTimeout === true) {
        return "Couldn't get an access key: the connection closed before the key arrived. Try again.";
    }
    const message = getErrorMessage(error, '').trim();
    return message || "Couldn't get an access key. Try again.";
}
