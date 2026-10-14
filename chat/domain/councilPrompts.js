const RESPONSE_LABEL_PREFIX = 'Response';

function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function buildResponseLabel(index) {
    return `${RESPONSE_LABEL_PREFIX} ${String.fromCharCode(65 + index)}`;
}

export function buildAnonymousResponseBlocks(responses = []) {
    return responses
        .map((entry, index) => {
            const response = normalizeText(entry?.response || entry?.content || '');
            if (!response) return null;
            const label = buildResponseLabel(index);
            return `${label}:\n${response}`;
        })
        .filter(Boolean)
        .join('\n\n');
}

export function buildCouncilSynthesisPrompt(options = {}) {
    const userQuery = normalizeText(options.userQuery);
    const conversationContext = normalizeText(options.conversationContext);
    const responseBlocks = buildAnonymousResponseBlocks(options.responses);

    const contextSection = conversationContext
        ? `\nRelevant conversation context:\n${conversationContext}\n`
        : '';

    return `You summarize and compare anonymous responses to the same user request.

Summarize the main points of each available response, then explain their meaningful agreements and differences in conclusions, reasoning, assumptions, or coverage. Focus on what matters to the original request.

Rules:
- Refer to the responses as Response A and Response B. Do not mention model names, provider names, or hidden identities, even if a response includes them.
- Identify factual errors, unsupported claims, missing caveats, and relevant tradeoffs directly. State uncertainty when the available evidence does not resolve a disagreement.
- Let the evidence determine how much attention each response needs. Do not force equal praise or criticism, invent differences, or treat conflicting claims as equally credible.
- Focus on helping the user understand the responses. Do not routinely declare an overall winner or write a separate replacement answer to the original request.
- If only one response is available, summarize it and note relevant limitations. State that the other response was unavailable and a comparison is not possible.
- Do not assign scores, grades, or ranked lists.
- Keep the summary and comparison concise and specific. Avoid generic praise, chatty phrasing, and generic follow-up offers.

Original user request:
${userQuery || '[No user request provided]'}${contextSection}
Anonymous draft responses:
${responseBlocks || '[No draft responses provided]'}

Write the summary and comparison now:`.trim();
}

export function buildCouncilSynthesisMessages(options = {}) {
    return [
        {
            role: 'user',
            content: buildCouncilSynthesisPrompt(options)
        }
    ];
}
