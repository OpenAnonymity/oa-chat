import { buildChatMessagesFromRequest, buildResponseSkeleton, finalizeResponse, estimateTokenUsage } from '../responseUtils.js';

function normalizeBaseUrl(baseUrl) {
    if (!baseUrl) return '';
    return baseUrl.replace(/\/+$/, '');
}

async function readSSE(response, onMessage) {
    if (!response.body) {
        throw new Error('Streaming response body is not available.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith(':')) continue;
            if (!trimmed.startsWith('data:')) continue;

            const data = trimmed.replace(/^data:\s*/, '');
            if (!data || data === '[DONE]') {
                if (data === '[DONE]') return;
                continue;
            }

            try {
                const parsed = JSON.parse(data);
                onMessage(parsed);
            } catch (error) {
                console.warn('OpenAI SSE parse error:', error);
            }
        }
    }

    const remaining = buffer.trim();
    if (remaining && remaining.startsWith('data:')) {
        const data = remaining.replace(/^data:\s*/, '');
        if (data && data !== '[DONE]') {
            try {
                const parsed = JSON.parse(data);
                onMessage(parsed);
            } catch (error) {
                console.warn('OpenAI SSE parse error:', error);
            }
        }
    }
}

function mapModelsResponse(payload, providerLabel) {
    const models = payload?.data || [];
    return models.map(model => ({
        id: model.id || model.model || model.name,
        name: model.id || model.model || model.name,
        category: 'Local models',
        provider: providerLabel || 'OpenAI-compatible',
        context_length: model.context_length || model.context_window || model.max_model_len || null
    })).filter(model => model.id);
}

function resolveHeaders(config) {
    const headers = {
        'Content-Type': 'application/json'
    };

    if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
    }

    if (config.headers) {
        Object.assign(headers, config.headers);
    }

    return headers;
}

function buildChatRequestBody(request, messages) {
    const body = {
        model: request.model,
        messages,
        temperature: request.temperature,
        top_p: request.top_p,
        stream: false
    };

    if (request.max_output_tokens) {
        body.max_tokens = request.max_output_tokens;
    }

    if (Number.isInteger(request.seed)) {
        body.seed = request.seed;
    }

    if (request.user) {
        body.user = request.user;
    }

    return body;
}

export function createOpenAICompatibleBackend({
    id,
    label,
    baseUrl,
    defaultModelId = 'default',
    defaultModelName = 'OpenAI-compatible',
    providerLabel = 'OpenAI-compatible',
    modelsEndpoint = '/v1/models',
    chatEndpoint = '/v1/chat/completions',
    embeddingsEndpoint = '/v1/embeddings'
} = {}) {
    const config = {
        baseUrl: normalizeBaseUrl(baseUrl || ''),
        apiKey: null,
        headers: null
    };

    const backend = {
        id,
        label,
        defaultModelId,
        defaultModelName,
        getBaseUrl() {
            return config.baseUrl;
        },
        configure(options = {}) {
            if (Object.prototype.hasOwnProperty.call(options, 'baseUrl')) {
                config.baseUrl = normalizeBaseUrl(options.baseUrl || '');
            }
            if (Object.prototype.hasOwnProperty.call(options, 'apiKey')) {
                config.apiKey = typeof options.apiKey === 'string' ? options.apiKey : null;
            }
            if (Object.prototype.hasOwnProperty.call(options, 'headers')) {
                config.headers = options.headers ? { ...options.headers } : null;
            }
        },
        async fetchModels() {
            if (!config.baseUrl) {
                return [{
                    id: defaultModelId,
                    name: defaultModelName,
                    category: 'Local models',
                    provider: providerLabel
                }];
            }

            const response = await fetch(`${config.baseUrl}${modelsEndpoint}`, {
                method: 'GET',
                headers: resolveHeaders(config)
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch models (${response.status})`);
            }

            const payload = await response.json();
            const models = mapModelsResponse(payload, providerLabel);
            return models.length > 0 ? models : [{
                id: defaultModelId,
                name: defaultModelName,
                category: 'Local models',
                provider: providerLabel
            }];
        },
        async createEmbedding(request, options = {}) {
            if (!config.baseUrl) {
                throw new Error('Embedding base URL is not configured.');
            }

            const response = await fetch(`${config.baseUrl}${embeddingsEndpoint}`, {
                method: 'POST',
                headers: resolveHeaders(config),
                body: JSON.stringify({
                    model: request.model,
                    input: request.input,
                    encoding_format: request.encoding_format,
                    user: request.user
                }),
                signal: options.signal
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errorMessage = errorData?.error?.message || `HTTP ${response.status}`;
                throw new Error(errorMessage);
            }

            return response.json();
        },
        async createResponse(request, options = {}) {
            const messages = buildChatMessagesFromRequest(request, { systemPrompt: options.systemPrompt || '' });
            const inputText = messages.map(message => message.content).join('\n');
            const responseShell = buildResponseSkeleton(request);

            const response = await fetch(`${config.baseUrl}${chatEndpoint}`, {
                method: 'POST',
                headers: resolveHeaders(config),
                body: JSON.stringify(buildChatRequestBody({ ...request, stream: false }, messages)),
                signal: options.signal
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errorMessage = errorData?.error?.message || `HTTP ${response.status}`;
                throw new Error(errorMessage);
            }

            const payload = await response.json();
            const outputText = payload?.choices?.[0]?.message?.content || '';
            const usage = payload?.usage ? {
                input_tokens: payload.usage.prompt_tokens ?? null,
                output_tokens: payload.usage.completion_tokens ?? null,
                total_tokens: payload.usage.total_tokens ?? null
            } : estimateTokenUsage(inputText, outputText);

            return finalizeResponse(responseShell, outputText, usage);
        },
        async streamResponse(request, options = {}) {
            const messages = buildChatMessagesFromRequest(request, { systemPrompt: options.systemPrompt || '' });
            const inputText = messages.map(message => message.content).join('\n');
            const responseShell = buildResponseSkeleton(request);
            let outputText = '';
            let usage = null;
            let sequence = 0;

            const outputItem = {
                id: `item_${responseShell.id}`,
                type: 'message',
                role: 'assistant',
                status: 'in_progress',
                content: []
            };

            const contentPart = {
                type: 'output_text',
                text: '',
                annotations: []
            };

            const emitEvent = (event) => {
                if (typeof options.onEvent === 'function') {
                    options.onEvent(event);
                }
            };

            emitEvent({
                type: 'response.in_progress',
                sequence_number: sequence++,
                response: responseShell
            });

            emitEvent({
                type: 'response.output_item.added',
                sequence_number: sequence++,
                output_index: 0,
                item: outputItem
            });

            emitEvent({
                type: 'response.content_part.added',
                sequence_number: sequence++,
                item_id: outputItem.id,
                output_index: 0,
                content_index: 0,
                part: contentPart
            });

            const response = await fetch(`${config.baseUrl}${chatEndpoint}`, {
                method: 'POST',
                headers: resolveHeaders(config),
                body: JSON.stringify({
                    ...buildChatRequestBody({ ...request, stream: true }, messages),
                    stream: true,
                    stream_options: { include_usage: true }
                }),
                signal: options.signal
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errorMessage = errorData?.error?.message || `HTTP ${response.status}`;
                throw new Error(errorMessage);
            }

            await readSSE(response, (payload) => {
                if (payload?.choices?.length) {
                    const delta = payload.choices[0]?.delta?.content || '';
                    if (delta) {
                        outputText += delta;
                        emitEvent({
                            type: 'response.output_text.delta',
                            sequence_number: sequence++,
                            item_id: outputItem.id,
                            output_index: 0,
                            content_index: 0,
                            delta,
                            logprobs: null,
                            obfuscation: null
                        });
                    }
                }

                if (payload?.usage) {
                    usage = {
                        input_tokens: payload.usage.prompt_tokens ?? null,
                        output_tokens: payload.usage.completion_tokens ?? null,
                        total_tokens: payload.usage.total_tokens ?? null
                    };
                }
            });

            contentPart.text = outputText;
            emitEvent({
                type: 'response.output_text.done',
                sequence_number: sequence++,
                item_id: outputItem.id,
                output_index: 0,
                content_index: 0,
                text: outputText
            });

            emitEvent({
                type: 'response.content_part.done',
                sequence_number: sequence++,
                item_id: outputItem.id,
                output_index: 0,
                content_index: 0,
                part: contentPart
            });

            outputItem.status = 'completed';
            outputItem.content = [contentPart];

            emitEvent({
                type: 'response.output_item.done',
                sequence_number: sequence++,
                output_index: 0,
                item_id: outputItem.id,
                item: outputItem
            });

            const finalUsage = usage || estimateTokenUsage(inputText, outputText);
            const finalResponse = finalizeResponse(responseShell, outputText, finalUsage, outputItem);

            emitEvent({
                type: 'response.completed',
                sequence_number: sequence++,
                response: finalResponse
            });

            return finalResponse;
        }
    };

    return backend;
}
