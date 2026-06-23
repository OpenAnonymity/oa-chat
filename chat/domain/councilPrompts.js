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

    return `You are an independent reviewer comparing two anonymous draft answers to the same user request.

The user asked a question, and one or two anonymous models produced available draft answers. Read Response A and Response B fairly, critically, concisely, and with attention to evidence.

Identify what each response gets right, what each misses, and where either response is unsupported or incorrect. Then give a clear final answer to the user's original request.

Rules:
- Refer only to Response A and Response B.
- Do not mention model names, provider names, or hidden identities, even if a draft includes them.
- Be specific. Do not praise both responses generically.
- If one response is clearly stronger, say so and explain why.
- If both are incomplete, synthesize the best answer and state the missing caveats.
- If only one response is available, review it as a partial comparison and clearly state that the other response was unavailable.
- Do not assign scores, grades, or ranked lists.
- Do not use chatty phrasing like "for you" or "what you should actually use."
- Do not end with a generic follow-up offer unless the user's request explicitly asks for one.
- Keep the review concise and useful.

Original user request:
${userQuery || '[No user request provided]'}${contextSection}
Anonymous draft responses:
${responseBlocks || '[No draft responses provided]'}

Write the review and final answer now:`.trim();
}

export function buildCouncilSynthesisMessages(options = {}) {
    return [
        {
            role: 'user',
            content: buildCouncilSynthesisPrompt(options)
        }
    ];
}
