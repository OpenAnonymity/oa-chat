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

    return `You are synthesizing a final answer from an LLM council.

The council has already produced anonymous draft responses to the user's request. Your job is to write one final answer for the user.

Rules:
- Do not mention model names, providers, or hidden identities.
- Treat the drafts as anonymous source material, not as items to compare.
- Combine the strongest correct points from the drafts.
- Correct mistakes, unsupported claims, or missing nuance when you can.
- If the drafts disagree, resolve the disagreement using the user's request and the evidence in the drafts.
- If the answer is uncertain, state the uncertainty plainly.
- Write only the final answer the user should read.

Original user request:
${userQuery || '[No user request provided]'}${contextSection}
Anonymous draft responses:
${responseBlocks || '[No draft responses provided]'}

Final Council Answer:`.trim();
}

export function buildCouncilSynthesisMessages(options = {}) {
    return [
        {
            role: 'user',
            content: buildCouncilSynthesisPrompt(options)
        }
    ];
}
