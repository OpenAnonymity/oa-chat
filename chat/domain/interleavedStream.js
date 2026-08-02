const PARAGRAPH_BREAK = '\n\n';

export function canSplitInterleavedContent(content) {
    const currentContent = typeof content === 'string' ? content : '';
    const fences = currentContent.match(/(?:^|\n)[\t ]*(?:`{3,}|~{3,})/g) || [];
    return fences.length % 2 === 0;
}

export function canFinalizeInterleavedContentInPlace(reasoningFinalized, contentBubbleCount) {
    return !!reasoningFinalized && Number(contentBubbleCount) <= 1;
}

export function shouldInsertInitialContentBeforeReasoning(
    hasExistingContent,
    startsNewSegment,
    hasReasoningTrace
) {
    return !hasExistingContent && !startsNewSegment && !!hasReasoningTrace;
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
