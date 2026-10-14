import { OWNERSHIP_ELSEWHERE, OWNERSHIP_NONE } from '../services/turnOwnership.js';

/**
 * Whether a saved assistant row still carries the flags of a reply being
 * written. After a reload, or in a tab that is not writing it, those flags
 * are not evidence of a live response.
 */
export function wasReplyStreaming(message) {
    return message?.role === 'assistant' && (message.streamingPending === true
        || message.streamingReasoning === true
        || typeof message.streamingTokens === 'number');
}

const INTERRUPTED_COPY = {
    [OWNERSHIP_NONE]: {
        pending: 'The connection to this request was lost before a reply arrived. Retry sends a new request.',
        reply: 'The connection to this reply was lost before it finished. Retry sends a new request.'
    },
    unknown: {
        pending: 'This tab is no longer connected to the request; no reply was received. Check any other open tab before retrying. Retrying sends a new request.',
        reply: 'This tab is no longer connected to the response. Check any other open tab before retrying. Retrying sends a new request.'
    }
};

/**
 * Saved streaming flags are not evidence of a live response after reload.
 * Normalize only the displayed copy: another tab may still own the request.
 * This must never persist an outcome, acquire a key, or resend a prompt.
 *
 * `ownership` says what the turn lock reported for this session
 * (turnOwnership.js): OWNERSHIP_ELSEWHERE paints the row as a reply still
 * being written in another tab (no error, no Retry); OWNERSHIP_NONE means the
 * tab that was writing it is gone, so the row is an interrupted turn with
 * Retry; anything else (no Web Locks) keeps the cautious copy.
 */
export function restoredResponseForDisplay(message, isSessionStreaming, ownership = null) {
    if (isSessionStreaming || message.role !== 'assistant') return message;
    if (!wasReplyStreaming(message)) return message;

    // Council and local agent messages own their own progress/retry controls.
    // Preserve the previous render-only normalization for those workflows.
    // A pending turn is local-only too (it must stay out of model context) but
    // it is an ordinary reply that never started, so it gets the retry copy.
    if (message.council?.enabled || (message.isLocalOnly && !message.pendingTurn)
        || String(message.model || '').trim().toLowerCase() === 'memory agent') {
        return { ...message, streamingReasoning: false, streamingTokens: null };
    }

    const settled = {
        ...message,
        streamingPending: false,
        streamingPhase: null,
        streamingReasoning: false,
        streamingTokens: null,
        // Only retain stages already recorded as complete. Clearing a spinner
        // is not evidence that an unfinished verification step succeeded.
        accessTrace: (Array.isArray(message.accessTrace) ? message.accessTrace : [message.accessTrace])
            .filter(stage => Array.isArray(stage?.steps) && stage.steps.length > 0
                && stage.steps.every(step => step?.state === 'complete'))
    };
    if (!message.inferenceError && ownership === OWNERSHIP_ELSEWHERE) {
        // Still being written by the tab that holds the turn: show what has
        // arrived so far and say where the rest is coming from.
        return { ...settled, answeringElsewhere: true };
    }
    const copy = INTERRUPTED_COPY[ownership === OWNERSHIP_NONE ? OWNERSHIP_NONE : 'unknown'];
    return {
        ...settled,
        inferenceError: message.inferenceError || (message.pendingTurn ? copy.pending : copy.reply)
    };
}
