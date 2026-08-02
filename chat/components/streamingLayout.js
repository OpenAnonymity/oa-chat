import { shouldInsertInitialContentBeforeReasoning } from '../domain/interleavedStream.js';

export function insertStreamingContentBubble({
    groupEl,
    textBubble,
    existingContentCount,
    startsNewSegment,
    reasoningTrace,
    actionAnchor
}) {
    if (shouldInsertInitialContentBeforeReasoning(
        existingContentCount > 0,
        startsNewSegment,
        !!reasoningTrace
    )) {
        groupEl.insertBefore(textBubble, reasoningTrace);
    } else if (actionAnchor) {
        groupEl.insertBefore(textBubble, actionAnchor);
    } else {
        groupEl.appendChild(textBubble);
    }
}
