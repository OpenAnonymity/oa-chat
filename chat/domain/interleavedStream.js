const PARAGRAPH_BREAK = '\n\n';

export function canSplitInterleavedContent(content) {
    const currentContent = typeof content === 'string' ? content : '';
    const fences = currentContent.match(/(?:^|\n)[\t ]*(?:`{3,}|~{3,})/g) || [];
    return fences.length % 2 === 0;
}

export function canFinalizeInterleavedContentInPlace(reasoningFinalized, contentBubbleCount) {
    return !!reasoningFinalized && Number(contentBubbleCount) <= 1;
}

export function createReasoningPhaseClock() {
    return {
        active: false,
        startedAt: null,
        durationMs: 0
    };
}

export function beginReasoningPhase(clock, now = Date.now()) {
    if (!clock || clock.active) return clock;
    clock.active = true;
    clock.startedAt = Number(now);
    return clock;
}

export function finishReasoningPhase(clock, now = Date.now()) {
    if (!clock) return 0;
    if (clock.active) {
        const finishedAt = Number(now);
        const startedAt = Number(clock.startedAt);
        if (Number.isFinite(finishedAt) && Number.isFinite(startedAt)) {
            clock.durationMs += Math.max(0, finishedAt - startedAt);
        }
        clock.active = false;
        clock.startedAt = null;
    }
    return clock.durationMs;
}

export function activateStreamingReasoning(message, clock, contentOffset, now = Date.now()) {
    beginReasoningPhase(clock, now);
    if (message) {
        message.streamingReasoning = true;
        message.streamingReasoningContentOffset = Number.isInteger(contentOffset)
            ? contentOffset
            : null;
    }
    return clock;
}

export function completeStreamingReasoning(message, clock, now = Date.now()) {
    const durationMs = finishReasoningPhase(clock, now);
    if (message) {
        message.streamingReasoning = false;
        delete message.streamingReasoningContentOffset;
        if (durationMs > 0) {
            message.reasoningDuration = durationMs;
        }
    }
    return durationMs;
}

export function formatReasoningDuration(durationMs) {
    const duration = Number(durationMs);
    if (!Number.isFinite(duration) || duration <= 0) return '';

    const seconds = Math.max(1, Math.round(duration / 1000));
    if (seconds < 60) return `Thought for ${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds === 0
        ? `Thought for ${minutes}m`
        : `Thought for ${minutes}m ${remainingSeconds}s`;
}

/**
 * Appends a provider content delta while preserving a visible boundary when
 * output resumes after a reasoning phase.
 */
export function appendInterleavedContent(content, chunk, previousEventType) {
    const currentContent = typeof content === 'string' ? content : '';
    const nextChunk = typeof chunk === 'string' ? chunk : '';
    const startsNewSegment = previousEventType === 'reasoning' &&
        currentContent.length > 0 &&
        canSplitInterleavedContent(currentContent);
    const needsParagraphBreak = startsNewSegment &&
        !/\s$/.test(currentContent) &&
        !/^\s/.test(nextChunk);
    const renderedChunk = `${needsParagraphBreak ? PARAGRAPH_BREAK : ''}${nextChunk}`;

    return {
        content: currentContent + renderedChunk,
        renderedChunk,
        startsNewSegment
    };
}
