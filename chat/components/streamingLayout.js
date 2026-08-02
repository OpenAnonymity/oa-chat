export function insertStreamingContentBubble({
    groupEl,
    textBubble,
    actionAnchor
}) {
    if (actionAnchor) {
        groupEl.insertBefore(textBubble, actionAnchor);
    } else {
        groupEl.appendChild(textBubble);
    }
}

export function placeCompletedReasoningTrace({
    groupEl,
    reasoningTrace,
    firstOutputBubble,
    actionAnchor
}) {
    if (!groupEl || !reasoningTrace) return;
    if (firstOutputBubble) {
        groupEl.insertBefore(reasoningTrace, firstOutputBubble);
    } else if (actionAnchor) {
        groupEl.insertBefore(reasoningTrace, actionAnchor);
    }
}

export function seedReasoningTypewriterForPhase({
    typewriter,
    messageId,
    completedContent
}) {
    if (!typewriter) return;
    typewriter.messageId = messageId;
    typewriter.targetContent = completedContent;
    typewriter.displayedLength = completedContent.length;
}
