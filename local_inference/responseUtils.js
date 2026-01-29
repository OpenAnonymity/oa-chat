function generateId(prefix) {
    const safePrefix = prefix || 'resp';
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return `${safePrefix}_${globalThis.crypto.randomUUID()}`;
    }
    const random = Math.random().toString(36).slice(2, 10);
    return `${safePrefix}_${Date.now().toString(36)}_${random}`;
}

function normalizeContentPart(part) {
    if (typeof part === 'string' || typeof part === 'number' || typeof part === 'boolean') {
        return { type: 'input_text', text: String(part) };
    }

    if (!part || typeof part !== 'object') {
        return { type: 'input_text', text: '' };
    }

    if (part.type === 'input_text' || part.type === 'output_text') {
        const text = part.text !== undefined && part.text !== null ? String(part.text) : '';
        return { type: part.type, text };
    }

    if (part.type === 'text') {
        const text = part.text !== undefined && part.text !== null ? String(part.text) : '';
        return { type: 'input_text', text };
    }

    if (part.type === 'input_image' || part.type === 'image_url') {
        const url = typeof part.image_url === 'string'
            ? part.image_url
            : (part.image_url?.url || part.url || '');
        return {
            type: 'input_image',
            image_url: { url },
            detail: part.detail || part.image_url?.detail || null
        };
    }

    if (part.type === 'input_file' || part.type === 'file') {
        const file = part.file || part.file_data || null;
        return {
            type: 'input_file',
            file,
            file_id: part.file_id || null
        };
    }

    return { type: part.type, ...part };
}

function normalizeMessageContent(content) {
    if (Array.isArray(content)) {
        return content.map(normalizeContentPart);
    }

    if (typeof content === 'string') {
        return [{ type: 'input_text', text: content }];
    }

    if (content && typeof content === 'object' && content.type) {
        return [normalizeContentPart(content)];
    }

    return [{ type: 'input_text', text: '' }];
}

function normalizeInputItem(item) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        return {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: String(item) }]
        };
    }

    if (!item || typeof item !== 'object') {
        return null;
    }

    if (item.type === 'message' || item.role) {
        return {
            id: item.id || undefined,
            type: 'message',
            role: item.role || 'user',
            content: normalizeMessageContent(item.content)
        };
    }

    return item;
}

export function normalizeResponsesRequest(request = {}) {
    if (!request || typeof request !== 'object') {
        throw new Error('Responses request must be an object.');
    }

    const normalized = { ...request };
    const input = normalized.input ?? normalized.messages;

    if (typeof input === 'string') {
        normalized.input = [{
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: input }]
        }];
    } else if (Array.isArray(input)) {
        normalized.input = input.map(normalizeInputItem).filter(Boolean);
    } else {
        normalized.input = [];
    }

    if (!normalized.model && normalized.model_id) {
        normalized.model = normalized.model_id;
    }

    if (!normalized.instructions && typeof normalized.system === 'string') {
        normalized.instructions = normalized.system;
    }

    if (!normalized.instructions && typeof normalized.system_prompt === 'string') {
        normalized.instructions = normalized.system_prompt;
    }

    normalized.stream = !!normalized.stream;
    normalized.temperature = typeof normalized.temperature === 'number' ? normalized.temperature : 1;
    normalized.top_p = typeof normalized.top_p === 'number' ? normalized.top_p : 1;
    normalized.max_output_tokens = normalized.max_output_tokens ?? normalized.max_tokens ?? null;
    normalized.metadata = normalized.metadata || null;
    normalized.tools = Array.isArray(normalized.tools) ? normalized.tools : [];
    normalized.tool_choice = normalized.tool_choice || null;
    normalized.parallel_tool_calls = normalized.parallel_tool_calls ?? false;
    normalized.truncation = normalized.truncation || 'disabled';
    normalized.reasoning = normalized.reasoning || null;
    normalized.text = normalized.text || null;
    normalized.user = normalized.user || null;

    return normalized;
}

export function normalizeEmbeddingRequest(request = {}) {
    if (!request || typeof request !== 'object') {
        throw new Error('Embedding request must be an object.');
    }

    const normalized = { ...request };
    normalized.model = normalized.model || normalized.model_id || normalized.modelId || null;

    if (normalized.input === undefined) {
        if (normalized.text !== undefined) {
            normalized.input = normalized.text;
        } else if (normalized.texts !== undefined) {
            normalized.input = normalized.texts;
        } else {
            normalized.input = '';
        }
    }

    return normalized;
}

export function messagesToResponsesInput(messages = []) {
    if (!Array.isArray(messages)) return [];
    return messages.map(message => ({
        type: 'message',
        role: message.role || 'user',
        content: normalizeMessageContent(message.content)
    }));
}

function contentPartsToText(parts) {
    if (!Array.isArray(parts)) return '';
    const textChunks = [];
    for (const part of parts) {
        if (!part) continue;
        if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
            if (part.text) textChunks.push(part.text);
            continue;
        }
        if (part.type === 'input_image' || part.type === 'image_url') {
            textChunks.push('[Image omitted]');
            continue;
        }
        if (part.type === 'input_file' || part.type === 'file') {
            textChunks.push('[File omitted]');
            continue;
        }
    }
    return textChunks.join('\n');
}

export function buildChatMessagesFromRequest(request, options = {}) {
    const messages = [];
    const systemPrompt = options.systemPrompt || '';
    const instructions = request.instructions || '';
    const combinedSystem = [systemPrompt, instructions].filter(Boolean).join('\n\n').trim();

    if (combinedSystem) {
        messages.push({ role: 'system', content: combinedSystem });
    }

    const inputItems = Array.isArray(request.input) ? request.input : [];

    for (const item of inputItems) {
        if (!item) continue;
        if (item.type === 'message' || item.role) {
            const role = item.role || 'user';
            const text = contentPartsToText(item.content);
            messages.push({ role: role === 'developer' ? 'system' : role, content: text });
            continue;
        }

        if (item.type === 'function_call_output') {
            const outputText = item.output || item.content || '';
            messages.push({ role: 'tool', content: outputText });
        }
    }

    return messages;
}

export function buildResponseSkeleton(request) {
    const createdAt = Math.floor(Date.now() / 1000);

    return {
        id: generateId('resp'),
        object: 'response',
        created_at: createdAt,
        status: 'in_progress',
        error: null,
        incomplete_details: null,
        model: request.model,
        output: [],
        usage: null,
        metadata: request.metadata || null,
        background: request.background || false,
        completed_at: null,
        instructions: request.instructions || null,
        max_output_tokens: request.max_output_tokens ?? null,
        parallel_tool_calls: request.parallel_tool_calls ?? false,
        previous_response_id: request.previous_response_id || null,
        reasoning: request.reasoning || null,
        temperature: request.temperature ?? 1,
        text: request.text || null,
        tool_choice: request.tool_choice || null,
        tools: request.tools || [],
        top_p: request.top_p ?? 1,
        truncation: request.truncation || 'disabled',
        user: request.user || null
    };
}

export function createOutputItem(text, index = 0) {
    return {
        id: generateId('item'),
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
            {
                type: 'output_text',
                text: text || '',
                annotations: []
            }
        ],
        output_index: index
    };
}

export function finalizeResponse(response, outputText, usage = null, outputItem = null) {
    const finalItem = outputItem || createOutputItem(outputText || '', 0);
    return {
        ...response,
        status: 'completed',
        completed_at: Math.floor(Date.now() / 1000),
        output: [finalItem],
        usage: usage || response.usage || null
    };
}

export function estimateTokenUsage(inputText, outputText) {
    const estimate = (text) => {
        if (!text) return 0;
        return Math.max(1, Math.ceil(text.length / 4));
    };

    const inputTokens = estimate(inputText);
    const outputTokens = estimate(outputText);

    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
    };
}
