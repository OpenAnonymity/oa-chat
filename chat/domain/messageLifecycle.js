/**
 * One explicit lifecycle per assistant reply, derived from the flags the send
 * pipeline already writes (streamingPending, streamingTokens, streamingReasoning,
 * inferenceError). Rendering asks this module instead of re-deriving the state
 * from individual flags, so every view agrees on when a reply has ended.
 *
 *   pending      sent, nothing received yet
 *   streaming    text or reasoning arriving (here or in another tab)
 *   complete     finished normally
 *   interrupted  ended early with partial output (stop, lost connection)
 *   error        ended with no usable output
 */
export const MESSAGE_STATE = Object.freeze({
    PENDING: 'pending',
    STREAMING: 'streaming',
    COMPLETE: 'complete',
    INTERRUPTED: 'interrupted',
    ERROR: 'error'
});

export function messageLifecycleState(message) {
    if (!message || message.role !== 'assistant') return MESSAGE_STATE.COMPLETE;
    if (message.answeringElsewhere === true) return MESSAGE_STATE.STREAMING;
    if (message.streamingPending === true) return MESSAGE_STATE.PENDING;
    if (message.streamingReasoning === true || typeof message.streamingTokens === 'number') {
        return MESSAGE_STATE.STREAMING;
    }
    if (message.inferenceError) {
        const hasOutput = Boolean(String(message.content || '').trim()
            || String(message.reasoning || '').trim()
            || message.images?.length);
        return hasOutput ? MESSAGE_STATE.INTERRUPTED : MESSAGE_STATE.ERROR;
    }
    return MESSAGE_STATE.COMPLETE;
}

/** Copy, Retry and the rest belong to a reply that has ended, however it ended. */
export function replyHasEnded(message) {
    const state = messageLifecycleState(message);
    return state === MESSAGE_STATE.COMPLETE
        || state === MESSAGE_STATE.INTERRUPTED
        || state === MESSAGE_STATE.ERROR;
}
