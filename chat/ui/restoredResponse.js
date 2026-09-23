/**
 * Saved streaming flags are not evidence of a live response after reload.
 * Normalize only the displayed copy: another tab may still own the request.
 * This must never persist an outcome, acquire a key, or resend a prompt.
 */
export function restoredResponseForDisplay(message, isSessionStreaming) {
    if (isSessionStreaming || message.role !== 'assistant') return message;
    const wasStreaming = message.streamingPending === true
        || message.streamingReasoning === true
        || typeof message.streamingTokens === 'number';
    if (!wasStreaming) return message;

    // Council and local agent messages own their own progress/retry controls.
    // Preserve the previous render-only normalization for those workflows.
    if (message.council?.enabled || message.isLocalOnly
        || String(message.model || '').trim().toLowerCase() === 'memory agent') {
        return { ...message, streamingReasoning: false, streamingTokens: null };
    }

    return {
        ...message,
        streamingPending: false,
        streamingPhase: null,
        streamingReasoning: false,
        streamingTokens: null,
        // Only retain stages already recorded as complete. Clearing a spinner
        // is not evidence that an unfinished verification step succeeded.
        accessTrace: (Array.isArray(message.accessTrace) ? message.accessTrace : [message.accessTrace])
            .filter(stage => Array.isArray(stage?.steps) && stage.steps.length > 0
                && stage.steps.every(step => step?.state === 'complete')),
        inferenceError: message.inferenceError
            || 'This tab is no longer connected to the response. Check any other open tab before retrying. Retrying sends a new request.'
    };
}
