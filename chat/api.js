// OpenRouter API integration
//
// Direct-to-provider architecture: all inference requests (completions, streaming)
// go directly from the user's browser to OpenRouter over HTTPS. No OA system (org,
// station, verifier) is in the inference data path. The ephemeral API key carries no
// user identity binding -- OpenRouter sees inference traffic from an anonymous
// ephemeral key with no way to identify the user behind it.
import networkProxy from './services/networkProxy.js';
import { consumeSseBody } from './services/inference/sseStream.js';
import {
    cancelAndroidNativeInferenceJob,
    isAndroidNativeInferenceAvailable,
    pollAndroidNativeInferenceJob,
    startAndroidNativeInferenceJob
} from './services/androidNativeInferenceTransport.js';
import { getDefaultModelConfig } from './services/modelConfig.js';
import { resolveModelDisplayName } from './services/modelNames.js';
import apiKeyStore from './services/apiKeyStore.js';
import { loadModelCatalog, saveModelCatalog } from './services/modelCatalogCache.js';
import { normalizeOpenRouterModelProviders, resolveProviderFromModelId } from './services/providerRegistry.js';
import { DEFAULT_REASONING_EFFORT, normalizeReasoningEffort } from './services/reasoningConfig.js';

const OPENROUTER_BACKEND_ID = 'openrouter';
const TITLE_SUMMARY_MODEL_ID = 'google/gemini-3.1-flash-lite-preview';
const TITLE_SUMMARY_MAX_INPUT_CHARS = 4000;

// System prompt to prepend to all conversations
// Modify this function to change the default AI behavior
// Use template literals (backticks) for multi-line prompts
// This is a function so dynamic values (like date) are evaluated per request
const getSystemPrompt = (modelId) => `
You are ${modelId ? `${modelId}, ` : ''}a highly capable, thoughtful, and precise assistant. Your goal is to deeply understand the user's intent, ask clarifying questions when needed, think step-by-step through complex problems, provide clear, and direct answers, and proactively anticipate helpful follow-up information. Always prioritize being truthful, nuanced, insightful, and efficient, tailoring your responses specifically to the user's needs and preferences.  It is important to be concise: keep answers brief and to the point, but without losing important details.

Formatting Rules:
- Use Markdown for lists, tables, and styling.
- Use \`\`\`code fences\`\`\` for all code blocks.
- Format file names, paths, and function names with \`inline code\` backticks.
- For all mathematical expressions, you must use \\(...\\) for inline math and \\[...\\] for block math. Use multi-line block math for complex equations.

Current date: ${new Date().toLocaleDateString()}.
`.trim();

// To disable system prompt, return an empty string:
// const getSystemPrompt = () => '';
// Example:
// const getSystemPrompt = () => `You are a helpful AI assistant.

function hasPdfContent(messages = []) {
    return messages.some((message) => {
        if (!Array.isArray(message?.content)) return false;
        return message.content.some((part) => {
            const filename = part?.file?.filename || '';
            const fileData = part?.file?.file_data || '';
            return part?.type === 'file' && (
                /\.pdf$/i.test(filename) ||
                (typeof fileData === 'string' && fileData.startsWith('data:application/pdf'))
            );
        });
    });
}

function applyPdfFileParserPlugin(body, messages = []) {
    if (!hasPdfContent(messages)) return;
    body.plugins = [
        {
            id: 'file-parser',
            pdf: {
                engine: 'mistral-ocr'
            }
        }
    ];
}

export class OpenRouterAPI {
    constructor(options = {}) {
        this.options = options;
        this.networkTransport = options.networkTransport || networkProxy;
        this.baseUrl = 'https://openrouter.ai/api/v1';

        // Load display name overrides from centralized config
        const defaults = getDefaultModelConfig();
        this.displayNameOverrides = { ...defaults.displayNameOverrides };
    }


    // Request-scoped leases isolate concurrent title/completion calls. Products
    // own credential acquisition, budget policy and cleanup, not SSE parsing.
    async withRequestAccess(token, options, operation) {
        const access = this.options.acquireRequestAccess
            ? await this.options.acquireRequestAccess(token, options)
            : this.defaultRequestAccess(token);
        try {
            if (options.signal?.aborted) {
                const error = new DOMException('The operation was aborted.', 'AbortError');
                error.isCancelled = true;
                throw error;
            }
            const request = Object.create(this);
            request._requestAccess = access;
            request.baseUrl = access.baseUrl;
            return await operation(request, access.apiKey || token);
        } catch (error) {
            this.options.onRequestError?.(error);
            throw error;
        } finally {
            try {
                await access.release?.();
            } finally {
                // Refresh errors cannot turn a successful response into failure.
                try { await this.options.onRequestFinished?.(); } catch { /* best effort */ }
            }
        }
    }

    defaultRequestAccess(token) {
        const key = token || this.getApiKey();
        if (!key) throw new Error('No API key available. Please obtain an API key first.');
        return {
            apiKey: key,
            baseUrl: this.baseUrl,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
        };
    }

    prepareRequestBody(body, access) {
        return this.options.prepareRequestBody
            ? this.options.prepareRequestBody(body, { access, model: this.getModelBudgetMetadata(body.model) })
            : body;
    }

    prepareFetchOptions(access, init) {
        return {
            ...init,
            headers: access.headers,
            ...(init.body ? { body: JSON.stringify(this.prepareRequestBody(JSON.parse(init.body), access)) } : {})
        };
    }

    fetchWithRetry(access, url, init, config) {
        return this.networkTransport.fetchWithRetry(url, this.prepareFetchOptions(access, init), {
            ...config,
            proxyConfig: access.proxyConfig || config?.proxyConfig
        });
    }

    fetchWithRetryJson(access, url, init, config) {
        return this.networkTransport.fetchWithRetryJson(url, this.prepareFetchOptions(access, init), {
            ...config,
            proxyConfig: access.proxyConfig || config?.proxyConfig
        });
    }

    getModelBudgetMetadata(modelId) {
        const baseId = String(modelId || '').split(':')[0];
        return this.getCachedModels().find(model => model.id === baseId) || null;
    }

    sendCompletionStrict(messages, modelId, token, options = {}) {
        return this.withRequestAccess(token, options, request =>
            request._sendCompletionStrict(messages, modelId, token, options));
    }

    generateSessionTitle(prompt, token, options = {}) {
        if (!this.extractTextContent(prompt).trim()) return Promise.resolve('');
        return this.withRequestAccess(token, options, request =>
            request._generateSessionTitle(prompt, token, options));
    }

    streamCompletion(messages, modelId, token, onChunk, onTokenUpdate, files = [], searchEnabled = false, abortController = null, onStreamOpen = null, onReasoningChunk = null, reasoningEnabled = true, reasoningEffort = DEFAULT_REASONING_EFFORT, onAccessProgress = null) {
        return this.withRequestAccess(token, {
            signal: abortController?.signal,
            onProgress: onAccessProgress
        }, request => request._streamCompletion(messages, modelId, token, onChunk,
            onTokenUpdate, files, searchEnabled, abortController, onStreamOpen,
            onReasoningChunk, reasoningEnabled, reasoningEffort));
    }

    // Get API key - only use ticket-based key
    getApiKey() {
        const key = apiKeyStore.getApiKey();
        if (!key) return null;
        if (apiKeyStore.isExpired()) return null;
        return key;
    }

    getCachedModels() {
        const cachedModels = loadModelCatalog(OPENROUTER_BACKEND_ID);
        if (!Array.isArray(cachedModels)) {
            return [];
        }
        return normalizeOpenRouterModelProviders(cachedModels).map(model => ({
            ...model,
            name: this.getDisplayName(model.id, model.name, model.provider)
        }));
    }

    // Fetch available models from OpenRouter
    async fetchModels() {
        const url = `${this.baseUrl}/models`;
        const headers = {};

        try {
            // Models catalog is public data - bypass proxy to avoid blocking app startup
            // Use retry with 3 attempts for transient failures
            const { response, data } = await networkProxy.fetchWithRetryJson(
                url,
                { method: 'GET', headers },
                {
                    context: 'Model catalog',
                    maxAttempts: 3,
                    timeoutMs: 15000,
                    proxyConfig: { bypassProxy: true }
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            if (!Array.isArray(data?.data)) {
                throw new Error('Invalid model catalog response');
            }

            const formattedModels = this.formatModels(data.data);
            if (formattedModels.length === 0) {
                throw new Error('OpenRouter returned an empty model catalog');
            }

            saveModelCatalog(OPENROUTER_BACKEND_ID, formattedModels);

            return formattedModels;
        } catch (error) {
            console.error('Error fetching models from OpenRouter:', error);

            const cachedModels = this.getCachedModels();
            if (cachedModels.length > 0) {
                console.warn('Using cached model catalog for OpenRouter.');
                return cachedModels;
            }

            // Return a fallback list of models
            return this.getFallbackModels();
        }
    }

    // Get custom display name for a model, or return the default name
    getDisplayName(modelId, defaultName, providerDisplayName) {
        return resolveModelDisplayName({
            modelId,
            fallbackDisplayName: defaultName,
            providerDisplayName,
            displayNameOverrides: this.displayNameOverrides
        });
    }

    // Format models to our structure
    formatModels(models) {
        if (!Array.isArray(models)) {
            return [];
        }

        const formattedModels = models.map(model => {
            if (!model || typeof model.id !== 'string') {
                return null;
            }

            const providerName = resolveProviderFromModelId(model.id).displayName;

            // Categorize models
            let category = 'Other models';
            let categoryPriority = 5; // Default priority

            if (model.id.includes('gpt') || model.id.includes('claude') || model.id.includes('gemini')) {
                category = 'Flagship models';
                categoryPriority = 1;
            } else if (model.id.includes('llama') || model.id.includes('mistral')) {
                category = 'Best roleplay models';
                categoryPriority = 2;
            } else if (model.id.includes('code') || model.id.includes('deepseek')) {
                category = 'Best coding models';
                categoryPriority = 3;
            } else if (model.id.includes('o1')) {
                category = 'Reasoning models';
                categoryPriority = 4;
            }

            // Apply custom display name if one exists
            const defaultName = typeof model.name === 'string' && model.name.trim()
                ? model.name.trim()
                : model.id;
            const displayName = String(
                this.getDisplayName(model.id, defaultName, providerName) || defaultName
            ).trim();

            return {
                id: model.id,
                name: displayName,
                category: category,
                categoryPriority: categoryPriority,
                provider: providerName,
                context_length: model.context_length,
                pricing: model.pricing,
                top_provider: model.top_provider
            };
        }).filter(Boolean);

        // Sort by category priority first, then by pricing within each category
        return formattedModels.sort((a, b) => {
            // First sort by category priority
            if (a.categoryPriority !== b.categoryPriority) {
                return a.categoryPriority - b.categoryPriority;
            }
            // Within same category, sort by price
            const priceA = a.pricing?.prompt || 0;
            const priceB = b.pricing?.prompt || 0;
            return priceA - priceB;
        });
    }

    isReasoningDetailImage(detail) {
        if (!detail || !detail.data) {
            return false;
        }

        const mimeType = detail.mime_type || detail.content_type;
        if (mimeType && mimeType.startsWith('image/')) {
            return true;
        }

        const base64Data = typeof detail.data === 'string' ? detail.data.trim() : '';
        if (!base64Data) {
            return false;
        }

        const knownImagePrefixes = [
            'iVBORw0KGgo', // PNG
            '/9j/',        // JPEG
            'R0lGOD',      // GIF
            'UklGR',       // WebP
            'Qk0'          // BMP
        ];

        return knownImagePrefixes.some(prefix => base64Data.startsWith(prefix));
    }

    buildImageUrlFromReasoningDetail(detail) {
        const mimeType = (detail && (detail.mime_type || detail.content_type));
        const type = mimeType && mimeType.startsWith('image/') ? mimeType : 'image/png';
        return `data:${type};base64,${detail.data}`;
    }

    extractTextContent(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .map(part => {
                    if (!part) return '';
                    if (typeof part === 'string') return part;
                    if (typeof part.text === 'string') return part.text;
                    if (typeof part.content === 'string') return part.content;
                    return '';
                })
                .filter(Boolean)
                .join(' ');
        }
        if (content && typeof content.text === 'string') return content.text;
        if (content && typeof content.content === 'string') return content.content;
        return '';
    }

    // Get model-specific max_tokens (disabled - let OpenRouter use API key credits)
    // getMaxTokensForModel(modelId) {
    //     const baseModelId = typeof modelId === 'string' ? modelId.split(':')[0] : '';
    //     // Check for Opus 4.1
    //     if (baseModelId.includes('claude-opus-4.1')) {
    //         return 13333;
    //     }
    //     // Check for GPT-5 Thinking (exclude chat variants)
    //     if (
    //         baseModelId.includes('gpt-5') &&
    //         !baseModelId.endsWith('-chat')
    //     ) {
    //         return 120000;
    //     }
    //     return undefined; // Use API default for other models
    // }

    // Fallback models if API fails
    getFallbackModels() {
        return [
            { id: 'openai/gpt-5.3-chat', name: 'OpenAI: GPT-5.3 Instant', category: 'Flagship models', provider: 'OpenAI' },
            { id: 'openai/gpt-5.3', name: 'OpenAI: GPT-5.3 Thinking', category: 'Flagship models', provider: 'OpenAI' },
            { id: 'openai/gpt-5.2-chat', name: 'OpenAI: GPT-5.2 Instant', category: 'Flagship models', provider: 'OpenAI' },
            { id: 'openai/gpt-5.1-chat', name: 'OpenAI: GPT-5.1 Instant', category: 'Flagship models', provider: 'OpenAI' },
            { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5', category: 'Flagship models', provider: 'Anthropic' },
            { id: 'google/gemini-3-pro-preview', name: 'Google: Gemini 3 Pro Preview', category: 'Flagship models', provider: 'Google' },
        ];
    }

    // Send chat completion request
    async _sendCompletionStrict(messages, modelId, apiKey, options = {}) {
        const url = `${this.baseUrl}/chat/completions`;
        const headers = this._requestAccess.headers;

        const {
            context = 'Inference completion',
            maxAttempts = 3,
            timeoutMs = 0,
            signal = null,
            searchEnabled = false,
            reasoningEnabled = true,
            reasoningEffort = DEFAULT_REASONING_EFFORT
        } = options;

        let effectiveModelId = modelId;
        if (searchEnabled && !modelId.includes(':online')) {
            effectiveModelId = `${modelId}:online`;
        }

        const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort);
        const reasoningPayload = reasoningEnabled
            ? { effort: normalizedReasoningEffort }
            : null;

        // Prepend system prompt if it exists
        const systemPrompt = getSystemPrompt(effectiveModelId);
        const messagesWithSystem = systemPrompt
            ? [{ role: 'system', content: systemPrompt }, ...messages]
            : messages;

        const body = {
            model: effectiveModelId,
            messages: messagesWithSystem.map(msg => ({
                role: msg.role,
                content: msg.content
            }))
        };
        applyPdfFileParserPlugin(body, messagesWithSystem);
        if (reasoningPayload) {
            body.reasoning = reasoningPayload;
        }

        // POST is idempotent for same input - safe to retry
        // No timeout - provider manages timeouts; completions can take long
        try {
            const { response, data, text } = await this.fetchWithRetryJson(
                this._requestAccess,
                url,
                {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(body)
                },
                {
                    context,
                    maxAttempts,
                    timeoutMs,
                    signal
                }
            );

            if (window.networkLogger) {
                window.networkLogger.logRequest({
                    type: 'openrouter',
                    method: 'POST',
                    url: url,
                    status: response.status,
                    request: {
                        headers: window.networkLogger.sanitizeHeaders(headers),
                        body: body
                    },
                    response: data
                });
            }

            if (!response.ok) {
                const error = new Error(`HTTP error! status: ${response.status}`);
                error.status = response.status;
                error.responseText = text || '';
                error.data = data;
                error.responseData = data;
                throw error;
            }

            const content = data?.choices?.[0]?.message?.content;
            if (typeof content !== 'string') {
                const error = new Error('Invalid completion response');
                error.responseData = data;
                throw error;
            }

            return {
                content,
                data,
                response
            };
        } catch (error) {
            console.error('Error sending completion:', {
                name: typeof error?.name === 'string'
                    ? error.name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80)
                    : 'Error',
                code: typeof error?.code === 'string'
                    ? error.code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80)
                    : null,
                status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null
            });

            if (window.networkLogger) {
                window.networkLogger.logRequest({
                    type: 'openrouter',
                    method: 'POST',
                    url: url,
                    status: Number.isFinite(error?.status) ? error.status : 0,
                    request: {
                        headers: window.networkLogger.sanitizeHeaders(headers),
                        body: body
                    },
                    error: error.message
                });
            }

            throw error;
        }
    }

    async sendCompletion(messages, modelId, apiKey) {
        try {
            const result = await this.sendCompletionStrict(messages, modelId, apiKey);
            return result.content;
        } catch (error) {
            return `Error: ${error.message}. Using simulated response instead: This is a fallback response since the API call failed.`;
        }
    }

    async _generateSessionTitle(prompt, sessionId, options = {}) {
        const normalizedPrompt = this.extractTextContent(prompt)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, TITLE_SUMMARY_MAX_INPUT_CHARS);

        if (!normalizedPrompt) {
            return '';
        }

        const access = this._requestAccess;
        const url = `${access.baseUrl}/chat/completions`;
        const headers = access.headers;
        const titleModelId = options.modelId || this.options.titleModelId || TITLE_SUMMARY_MODEL_ID;

        const body = {
            model: titleModelId,
            messages: [
                {
                    role: 'system',
                    content: [
                        'Generate a concise chat title from the user message.',
                        'Return only the title.',
                        'Use 3 to 7 words.',
                        'No quotation marks, trailing punctuation, or prefixes like "Title:".'
                    ].join(' ')
                },
                {
                    role: 'user',
                    content: normalizedPrompt
                }
            ],
            temperature: 0.2,
            max_tokens: 24,
            reasoning: { effort: 'minimal' }
        };

        try {
            const { response, data, text } = await this.fetchWithRetryJson(
                access,
                url,
                {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body)
                },
                {
                    context: 'Session title generation',
                    maxAttempts: 2,
                    timeoutMs: options.timeoutMs || 10000,
                    signal: options.signal
                }
            );

            if (window.networkLogger) {
                window.networkLogger.logRequest({
                    type: 'openrouter',
                    method: 'POST',
                    url,
                    status: response.status,
                    request: {
                        headers: window.networkLogger.sanitizeHeaders(headers),
                        body: {
                            model: titleModelId,
                            messages: 'title generation',
                            max_tokens: body.max_tokens,
                            temperature: body.temperature
                        }
                    },
                    response: response.ok ? { titleGeneration: true } : data || text
                });
            }

            if (!response.ok) {
                const errorMessage = data?.error?.message || data?.message || `HTTP error! status: ${response.status}`;
                const error = new Error(errorMessage);
                error.status = response.status;
                error.data = data;
                throw error;
            }

            if (data?.usage && typeof options.onUsage === 'function') {
                try {
                    await options.onUsage({
                        totalTokens: Number(data.usage.total_tokens ??
                            (Number(data.usage.prompt_tokens || 0) + Number(data.usage.completion_tokens || 0))),
                        promptTokens: Number(data.usage.prompt_tokens || 0),
                        completionTokens: Number(data.usage.completion_tokens || 0),
                        cost: data.usage.cost,
                        model: data.model || titleModelId,
                        pricing: this.getModelBudgetMetadata(data.model || titleModelId)?.pricing
                            || null
                    });
                } catch (usageError) {
                    console.warn('Could not record title usage:', usageError);
                }
            }

            return data?.choices?.[0]?.message?.content || '';
        } catch (error) {
            throw error;
        }
    }

    // Stream chat completion with support for multimodal content, web search, and reasoning traces
    async _streamCompletion(messages, modelId, sessionId, onChunk, onTokenUpdate, files = [], searchEnabled = false, abortController = null, onStreamOpen = null, onReasoningChunk = null, reasoningEnabled = true, reasoningEffort = DEFAULT_REASONING_EFFORT, onAccessProgress = null) {

        // Handle web search - append :online suffix if enabled
        let effectiveModelId = modelId;
        if (searchEnabled && !modelId.includes(':online')) {
            effectiveModelId = `${modelId}:online`;
        }

        const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort);
        const reasoningPayload = reasoningEnabled
            ? { effort: normalizedReasoningEffort }
            : null;

        // Check if there are PDF files
        let hasPdfFiles = false;

        // Process files if provided
        let processedMessages = messages;
        if (files && files.length > 0) {
            try {
                const { filesToMultimodalContent } = await import('./services/fileUtils.js');
                const multimodalContent = await filesToMultimodalContent(files);

                // Check if any files are PDFs
                hasPdfFiles = files.some(file => file.type === 'application/pdf');

                // Get the last user message
                const lastUserMsg = messages[messages.length - 1];
                if (lastUserMsg && lastUserMsg.role === 'user') {
                    // Create content array with text and files
                    const contentArray = [
                        { type: 'text', text: lastUserMsg.content },
                        ...multimodalContent
                    ];

                    // Update the last message with multimodal content
                    processedMessages = [
                        ...messages.slice(0, -1),
                        { role: lastUserMsg.role, content: contentArray }
                    ];
                }
            } catch (error) {
                console.error('Error processing files:', error);
                throw new Error(`Failed to process files: ${error.message}`);
            }
        }

        const access = this._requestAccess;
        const url = `${access.baseUrl}/chat/completions`;
        const headers = access.headers;
        const throwIfStreamAborted = () => {
            if (!abortController?.signal?.aborted) return;
            const error = new DOMException('The operation was aborted.', 'AbortError');
            error.isCancelled = true;
            throw error;
        };

        let totalTokens = 0;
        let promptTokens = 0;
        let completionTokens = 0;
        let reportedCost = null;
        let modelUsed = effectiveModelId;
        const modelPricing = this.getModelBudgetMetadata(effectiveModelId)?.pricing
            || null;
        let accumulatedContent = '';
        let accumulatedReasoning = '';
        let completionFinishReason = null;
        let hasReceivedFirstToken = false;
        let citations = []; // Track citations for web search results
        const annotationsMap = new Map(); // Track annotations with deduplication by URL
        let estimatedReasoningTokens = 0; // Track reasoning tokens for cumulative display

        // Buffering for reasoning chunks to reduce UI updates
        let reasoningBuffer = '';
        let reasoningBufferTimer = null;
        let reasoningFlushPromise = Promise.resolve();
        let reasoningFlushError = null;
        const REASONING_BUFFER_DELAY = 50; // ms - flush buffer after this delay
        const REASONING_BUFFER_SIZE = 20; // chars - flush when buffer reaches this size

        // Helper to flush reasoning buffer
        const flushReasoningBuffer = () => {
            if (reasoningBufferTimer) {
                clearTimeout(reasoningBufferTimer);
                reasoningBufferTimer = null;
            }
            if (reasoningBuffer && onReasoningChunk) {
                const bufferedReasoning = reasoningBuffer;
                reasoningBuffer = '';
                reasoningFlushPromise = reasoningFlushPromise.then(async () => {
                    if (reasoningFlushError) return;
                    try {
                        await onReasoningChunk(bufferedReasoning);
                    } catch (error) {
                        reasoningFlushError = error;
                    }
                });
            }
            return reasoningFlushPromise.then(() => {
                if (reasoningFlushError) throw reasoningFlushError;
            });
        };

        // Helper to normalize URLs for deduplication (strip trailing garbage, normalize trailing slashes)
        const normalizeUrl = (url) => {
            if (!url) return url;
            // Remove trailing parentheses, brackets, quotes, and punctuation that are malformed
            let cleaned = url.replace(/[)\]}"'.,;]+$/, '');
            try {
                const parsed = new URL(cleaned);
                // Normalize: origin + pathname without trailing slash (except for root)
                let path = parsed.pathname.replace(/\/+$/, '') || '/';
                return parsed.origin + path;
            } catch {
                return cleaned.replace(/\/+$/, '');
            }
        };

        // Helper to clean URL for storage (fix malformed URLs)
        const cleanUrl = (url) => {
            if (!url) return url;
            // Remove trailing parentheses, brackets, quotes, and punctuation that are malformed
            return url.replace(/[)\]}"'.,;]+$/, '');
        };

        // Helper to add annotations with deduplication during collection
        const addAnnotations = (newAnnotations) => {
            if (!newAnnotations || !Array.isArray(newAnnotations)) return;
            newAnnotations.forEach(ann => {
                if (ann.type === 'url_citation' && ann.url) {
                    const key = normalizeUrl(ann.url);
                    if (!annotationsMap.has(key)) {
                        annotationsMap.set(key, ann);
                    }
                }
            });
        };

        // Helper to parse citations from annotations (deduplicates by URL)
        const parseCitationsFromAnnotations = (annotationsList) => {
            if (!annotationsList || !Array.isArray(annotationsList)) return [];

            // Use Map to deduplicate by normalized URL
            const citationMap = new Map();

            annotationsList
                .filter(ann => ann.type === 'url_citation' && ann.url)
                .forEach(annotation => {
                    const normalizedUrl = normalizeUrl(annotation.url);
                    // Only add if URL not already seen (keep first occurrence)
                    if (!citationMap.has(normalizedUrl)) {
                        citationMap.set(normalizedUrl, {
                            url: cleanUrl(annotation.url),
                            title: annotation.title || null,
                            content: annotation.content || null,
                            startIndex: annotation.start_index ?? annotation.startIndex ?? null,
                            endIndex: annotation.end_index ?? annotation.endIndex ?? null
                        });
                    }
                });

            // Assign sequential indices to deduplicated citations
            const citations = Array.from(citationMap.values()).map((citation, idx) => ({
                ...citation,
                index: idx + 1
            }));

            if (citations.length > 0) {
                console.log('Found web search citations:', citations.length, '(deduplicated from', annotationsList.filter(a => a.type === 'url_citation').length, 'annotations)');
            }

            return citations;
        };

        // Helper to parse citations from content (fallback for when no annotations)
        // Extracts URLs and numbered references like [1], [2] etc.
        // Uses normalizeUrl for deduplication and cleanUrl for storage
        const parseCitations = (content) => {
            const citationMap = new Map(); // Key: normalized URL, Value: citation object
            let citationIndex = 1;

            // Helper to add a URL to the map with deduplication
            const addUrl = (rawUrl, title, explicitIndex) => {
                const cleaned = cleanUrl(rawUrl);
                const normalized = normalizeUrl(rawUrl);
                if (!citationMap.has(normalized) &&
                    !cleaned.match(/\.(png|jpg|jpeg|gif|svg|css|js|ico|woff|ttf|eot)$/i) &&
                    cleaned.length < 200) {
                    citationMap.set(normalized, {
                        url: cleaned,
                        title: title || null,
                        index: explicitIndex || citationIndex++
                    });
                }
            };

            // First, look for existing numbered citations [1], [2], etc.
            const existingCitationPattern = /\[(\d+)\]/g;
            const existingNumbers = new Set();
            let match;
            while ((match = existingCitationPattern.exec(content)) !== null) {
                existingNumbers.add(parseInt(match[1]));
            }

            // Pattern 1: Markdown-style references [text](url)
            const markdownUrlPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
            while ((match = markdownUrlPattern.exec(content)) !== null) {
                addUrl(match[2], match[1], null);
            }

            // Pattern 2: References/Sources section at the end
            const referencesPattern = /(?:^|\n)(?:References?|Sources?|Citations?):?\s*\n((?:(?:\[\d+\]|\d+\.)\s*https?:\/\/[^\s]+\s*\n?)+)/gmi;
            const referencesMatch = referencesPattern.exec(content);
            if (referencesMatch) {
                const referencesSection = referencesMatch[1];
                const citationPattern = /(?:\[(\d+)\]|(\d+)\.)\s*(https?:\/\/[^\s]+)/g;
                while ((match = citationPattern.exec(referencesSection)) !== null) {
                    const num = parseInt(match[1] || match[2]);
                    addUrl(match[3], null, num);
                }
            }

            // Pattern 3: Plain URLs in the content
            const plainUrlPattern = /(?:(?:^|\n)(?:[-•*]|\d+\.?)\s+)?(https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/\/=]*))/g;
            while ((match = plainUrlPattern.exec(content)) !== null) {
                addUrl(match[1], null, null);
            }

            // If we have existing citation numbers in text but found URLs, ensure they match
            if (existingNumbers.size > 0 && citationMap.size > 0) {
                return Array.from(citationMap.values()).sort((a, b) => a.index - b.index);
            }

            return citationMap.size > 0 ? Array.from(citationMap.values()).sort((a, b) => a.index - b.index) : [];
        };

        const logStreamingRequest = (status, transport = 'web') => {
            if (!window.networkLogger) return;

            const logBody = {
                model: modelId,
                messages: messages.length + ' messages',
                stream: true,
                reasoning: reasoningPayload
            };

            window.networkLogger.logRequest({
                type: 'openrouter',
                method: 'POST',
                url: url,
                status,
                request: {
                    headers: window.networkLogger.sanitizeHeaders(headers),
                    body: logBody
                },
                response: {
                    streaming: true,
                    transport
                }
            });
        };

        const processSseLine = async (line) => {
            throwIfStreamAborted();

            // Skip empty lines
            if (line.trim() === '') return;

            // Handle SSE comments (OpenRouter processing indicators)
            if (line.startsWith(':')) {
                // These are SSE comments, we can optionally use them for UI feedback
                // For example: ": OPENROUTER PROCESSING"
                console.debug('SSE comment:', line);
                return;
            }

            if (!line.startsWith('data: ')) {
                return;
            }

            const data = line.slice(6);
            if (data === '[DONE]') return false;

            let parsed;
            try {
                parsed = JSON.parse(data);
            } catch (error) {
                console.error('Error parsing SSE chunk:', error, 'Raw line:', line);
                return;
            }

                // Check for annotations in various possible locations in the response
                // All formats use addAnnotations() which deduplicates by normalized URL

                // Format 1: Direct annotations array
                if (parsed.annotations && Array.isArray(parsed.annotations)) {
                    addAnnotations(parsed.annotations);
                }

                // Format 2: In choices[0].message.annotations (chat completions format)
                if (parsed.choices?.[0]?.message?.annotations && Array.isArray(parsed.choices[0].message.annotations)) {
                    addAnnotations(parsed.choices[0].message.annotations);
                }

                // Format 3: In choices[0].message.content[] (if content is array with annotations)
                const messageContent = parsed.choices?.[0]?.message?.content;
                if (Array.isArray(messageContent)) {
                    messageContent.forEach(item => {
                        if (item.annotations && Array.isArray(item.annotations)) {
                            addAnnotations(item.annotations);
                        }
                    });
                }

                // Format 4: /responses API format - check output[].content[].annotations[]
                if (parsed.output && Array.isArray(parsed.output)) {
                    parsed.output.forEach(output => {
                        if (output.content && Array.isArray(output.content)) {
                            output.content.forEach(contentItem => {
                                if (contentItem.annotations && Array.isArray(contentItem.annotations)) {
                                    addAnnotations(contentItem.annotations);
                                }
                            });
                        }
                    });
                }

                // Format 5: response.completed event format
                if (parsed.type === 'response.completed' && parsed.response) {
                    const output = parsed.response.output;
                    if (output && Array.isArray(output)) {
                        output.forEach(outputItem => {
                            if (outputItem.content && Array.isArray(outputItem.content)) {
                                outputItem.content.forEach(contentItem => {
                                    if (contentItem.annotations && Array.isArray(contentItem.annotations)) {
                                        addAnnotations(contentItem.annotations);
                                    }
                                });
                            }
                        });
                    }
                }

                // Check for reasoning in various possible formats
                // OpenRouter might send reasoning in different ways
                if (parsed.type === 'response.reasoning.delta' ||
                    parsed.reasoning_delta ||
                    (parsed.choices?.[0]?.delta?.reasoning)) {

                    const reasoningContent = parsed.delta ||
                                           parsed.reasoning_delta ||
                                           parsed.choices?.[0]?.delta?.reasoning || '';

                    if (reasoningContent && onReasoningChunk) {
                        hasReceivedFirstToken = true;
                        accumulatedReasoning += reasoningContent;

                        // Buffer reasoning chunks to reduce UI updates
                        reasoningBuffer += reasoningContent;

                        // Clear existing timer
                        if (reasoningBufferTimer) {
                            clearTimeout(reasoningBufferTimer);
                        }

                        // Flush buffer if it's large enough or on newline
                        if (reasoningBuffer.length >= REASONING_BUFFER_SIZE ||
                            reasoningContent.includes('\n')) {
                            await flushReasoningBuffer();
                        } else {
                            // Otherwise, set a timer to flush after delay
                            reasoningBufferTimer = setTimeout(() => {
                                // The next line or finalization surfaces the recorded
                                // callback failure without creating an unhandled rejection.
                                void flushReasoningBuffer().catch(() => {});
                            }, REASONING_BUFFER_DELAY);
                        }

                        // Update token count for reasoning (estimated)
                        estimatedReasoningTokens = Math.ceil(accumulatedReasoning.length / 4);
                        if (onTokenUpdate) {
                            await onTokenUpdate({
                                promptTokens,
                                completionTokens: estimatedReasoningTokens,
                                pricing: modelPricing,
                                model: modelUsed,
                                estimated: true,
                                isStreaming: true
                            });
                            throwIfStreamAborted();
                        }
                    }

                    // Skip normal content processing if this was a reasoning event
                    if (parsed.type === 'response.reasoning.delta') return;
                }

                // Check for mid-stream errors
                if (parsed.error) {
                    const errorMessage = parsed.error.message || 'Stream error occurred';
                    const error = new Error(errorMessage);
                    error.code = parsed.error.code;
                    error.isStreamError = true;
                    error.hasReceivedTokens = hasReceivedFirstToken;

                    // Any provider error event is terminal. Continuing would turn a
                    // truncated response into an apparently successful completion.
                    throw error;
                }

                // Handle message content delta events from reasoning API (if using separate endpoint)
                if (parsed.type === 'response.output_text.delta') {
                    const contentDelta = parsed.delta || '';
                    if (contentDelta) {
                        await flushReasoningBuffer();
                        hasReceivedFirstToken = true;
                        accumulatedContent += contentDelta;
                        await onChunk(contentDelta);
                        throwIfStreamAborted();

                        // Add reasoning tokens to content tokens for cumulative display
                        const estimatedContentTokens = Math.ceil(accumulatedContent.length / 4);
                        completionTokens = estimatedReasoningTokens + estimatedContentTokens;
                        if (onTokenUpdate) {
                            await onTokenUpdate({
                                promptTokens,
                                completionTokens,
                                pricing: modelPricing,
                                model: modelUsed,
                                estimated: true,
                                isStreaming: true
                            });
                            throwIfStreamAborted();
                        }
                    }
                    return;
                }

                const delta = parsed.choices?.[0]?.delta;
                const content = delta?.content;

                if (content) {
                    await flushReasoningBuffer();
                    hasReceivedFirstToken = true;
                    accumulatedContent += content;
                    await onChunk(content);
                    throwIfStreamAborted();

                    // Add reasoning tokens to content tokens for cumulative display
                    const estimatedContentTokens = Math.ceil(accumulatedContent.length / 4);
                    completionTokens = estimatedReasoningTokens + estimatedContentTokens;
                    if (onTokenUpdate) {
                        await onTokenUpdate({
                            promptTokens,
                            completionTokens,
                            pricing: modelPricing,
                            model: modelUsed,
                            estimated: true,
                            isStreaming: true
                        });
                        throwIfStreamAborted();
                    }
                }

                // Check for images in the delta (standard OpenRouter format)
                if (delta?.images) {
                    hasReceivedFirstToken = true;
                    await onChunk(null, { images: delta.images });
                    throwIfStreamAborted();
                }

                // Check for image data in reasoning_details (only treat recognised image payloads)
                if (delta?.reasoning_details) {
                    const imageDetails = delta.reasoning_details.filter(detail => this.isReasoningDetailImage(detail));
                    if (imageDetails.length > 0) {
                        hasReceivedFirstToken = true;
                        const images = imageDetails.map(detail => ({
                            type: 'image_url',
                            image_url: { url: this.buildImageUrlFromReasoningDetail(detail) }
                        }));
                        await onChunk(null, { images });
                        throwIfStreamAborted();
                    }
                }

                // Check for finish reason
                const finishReason = parsed.choices?.[0]?.finish_reason;
                if (finishReason) {
                    completionFinishReason = finishReason;
                }
                if (finishReason && finishReason !== 'stop') {
                    console.warn('Stream finished with reason:', finishReason);
                }

                // Check for usage info in the stream
                if (parsed.usage) {
                    promptTokens = parsed.usage.prompt_tokens || 0;
                    completionTokens = parsed.usage.completion_tokens || 0;
                    totalTokens = parsed.usage.total_tokens ?? (Number(promptTokens) + Number(completionTokens));
                    const rawUsageCost = parsed.usage.cost;
                    const usageCost = rawUsageCost === null
                        || rawUsageCost === undefined
                        || rawUsageCost === ''
                        || typeof rawUsageCost === 'boolean'
                        ? Number.NaN
                        : Number(rawUsageCost);
                    reportedCost = Number.isFinite(usageCost) && usageCost >= 0
                        ? usageCost
                        : null;


                    // Update token count with final accurate values
                    if (onTokenUpdate) {
                        await onTokenUpdate({
                            totalTokens,
                            promptTokens,
                            completionTokens,
                            cost: reportedCost,
                            pricing: modelPricing,
                            model: modelUsed,
                            isStreaming: false
                        });
                        throwIfStreamAborted();
                    }
                }

                // Check for model info
                if (parsed.model) {
                    modelUsed = parsed.model;
                }
        };

        const finalizeStreamResult = async () => {
            throwIfStreamAborted();
            // Flush any remaining reasoning buffer
            await flushReasoningBuffer();
            throwIfStreamAborted();

            // Parse citations - prefer annotations over content parsing
            if (searchEnabled) {
                const annotationsList = Array.from(annotationsMap.values());
                if (annotationsList.length > 0) {
                    // Use citations from annotations (already deduplicated during collection)
                    console.log('Processing annotations for citations:', annotationsList.length, 'unique annotations');
                    citations = parseCitationsFromAnnotations(annotationsList);
                    console.log('Parsed citations:', citations.length, 'citations');
                } else if (accumulatedContent) {
                    // Fallback to parsing from content
                    console.log('No annotations found, attempting to parse citations from content');
                    citations = parseCitations(accumulatedContent);
                    if (citations.length > 0) {
                        console.log('Parsed citations from content:', citations.length);
                    }
                }
            }

            // Return token usage data, reasoning content, and citations
            return {
                totalTokens,
                promptTokens,
                completionTokens,
                cost: reportedCost,
                pricing: modelPricing,
                model: modelUsed,
                finishReason: completionFinishReason,
                reasoning: accumulatedReasoning || null,
                citations: citations.length > 0 ? citations : null
            };
        };

        try {
            // Prepend system prompt if it exists
            const systemPrompt = getSystemPrompt(effectiveModelId);
            const messagesWithSystem = systemPrompt
                ? [{ role: 'system', content: systemPrompt }, ...processedMessages]
                : processedMessages;
            promptTokens = this.options.estimatePromptTokens?.(messagesWithSystem) || 0;
            if (onTokenUpdate) {
                await onTokenUpdate({
                    totalTokens: promptTokens,
                    promptTokens,
                    completionTokens: 0,
                    cost: null,
                    pricing: modelPricing,
                    model: effectiveModelId,
                    estimated: true,
                    isStreaming: true
                });
                throwIfStreamAborted();
            }

            // Build request body - use standard format for now
            // OpenRouter might handle reasoning internally with the same endpoint
            const requestBody = {
                model: effectiveModelId,
                messages: messagesWithSystem.map(msg => ({
                    role: msg.role,
                    content: msg.content
                })),
                stream: true,
                // Request usage information in stream
                stream_options: { include_usage: true }
            };

            // Add model-specific max_tokens if applicable (disabled - let OpenRouter use API key credits)
            // const maxTokens = this.getMaxTokensForModel(effectiveModelId);
            // if (maxTokens !== undefined) {
            //     requestBody.max_tokens = maxTokens;
            // }

            // Add PDF plugin configuration if PDFs are present
            // Default to mistral-ocr as per OpenRouter documentation
            if (hasPdfFiles || hasPdfContent(processedMessages)) {
                applyPdfFileParserPlugin(requestBody, processedMessages);
            }

            // Add reasoning parameter if enabled (OpenRouter unified reasoning API)
            // See: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
            // OpenRouter maps this across providers/models based on support.
            if (reasoningPayload) {
                requestBody.reasoning = reasoningPayload;
            }

            const fetchOptions = {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestBody)
            };
            if (abortController?.signal?.aborted) {
                const error = new DOMException('The operation was aborted.', 'AbortError');
                error.isCancelled = true;
                throw error;
            }
            if (isAndroidNativeInferenceAvailable()) {
                const nativeRequest = {
                    url,
                    method: 'POST',
                    headers,
                    body: JSON.stringify(this.prepareRequestBody(requestBody, access)),
                    debugMock: access.apiKey === 'oa-debug-stream',
                };
                const { jobId } = startAndroidNativeInferenceJob(nativeRequest);
                let afterSequence = 0;
                let streamOpened = false;
                let terminal = false;
                const cancelFromAbort = () => {
                    try {
                        cancelAndroidNativeInferenceJob(jobId);
                    } catch (cancelError) {
                        console.warn('Failed to cancel Android native inference job:', cancelError);
                    }
                };

                abortController?.signal?.addEventListener('abort', cancelFromAbort, { once: true });

                try {
                    while (!terminal) {
                        const { events } = pollAndroidNativeInferenceJob(jobId, afterSequence);
                        if (events.length === 0) {
                            await new Promise(resolve => setTimeout(resolve, 75));
                            continue;
                        }

                        for (const event of events) {
                            afterSequence = Math.max(afterSequence, Number(event.sequence || 0));

                            if (event.type === 'stream-open') {
                                if (!streamOpened) {
                                    streamOpened = true;
                                    if (typeof onStreamOpen === 'function') {
                                        await onStreamOpen();
                                    }
                                    logStreamingRequest(event.status || 200, 'android-native');
                                }
                                continue;
                            }

                            if (event.type === 'sse-line' && typeof event.line === 'string') {
                                if (await processSseLine(event.line) === false) {
                                    terminal = true;
                                }
                                continue;
                            }

                            if (event.type === 'completed') {
                                terminal = true;
                                continue;
                            }

                            if (event.type === 'cancelled') {
                                const error = new DOMException(event.message || 'The operation was aborted.', 'AbortError');
                                error.isCancelled = true;
                                throw error;
                            }

                            if (event.type === 'failed') {
                                const error = new Error(event.message || 'Stream error occurred');
                                if (event.status) {
                                    error.status = event.status;
                                }
                                if (event.code) {
                                    error.code = event.code;
                                }
                                throw error;
                            }
                        }
                    }
                } finally {
                    abortController?.signal?.removeEventListener('abort', cancelFromAbort);
                }

                return await finalizeStreamResult();
            }

            // Retry only the initial connection, not mid-stream
            // Once streaming starts, errors should surface to user
            // No timeout - provider manages timeouts; streams can take long
            const response = await this.fetchWithRetry(
                access,
                url,
                fetchOptions,
                {
                    context: 'Inference stream',
                    maxAttempts: 3,
                    timeoutMs: 0,  // No timeout - let OpenRouter manage
                    signal: abortController?.signal
                }
            );

            // Handle pre-stream errors
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errorMessage = errorData.error?.message || `HTTP error! status: ${response.status}`;
                const error = new Error(errorMessage);
                error.status = response.status;
                error.data = errorData;
                throw error;
            }

            if (typeof onStreamOpen === 'function') {
                await onStreamOpen();
            }

            logStreamingRequest(response.status, 'web');

            await consumeSseBody(response.body, processSseLine);

            return await finalizeStreamResult();
        } catch (error) {
            // Flush any remaining reasoning buffer before handling error
            try {
                await flushReasoningBuffer();
            } catch {
                // Preserve the primary stream failure. A reasoning callback failure
                // is already the primary error when it originates from a flush.
            }

            let streamError = error;
            if (!(streamError instanceof Error)) {
                const originalError = streamError;
                const message = typeof originalError === 'string'
                    ? originalError
                    : (originalError?.message || String(originalError || 'Stream error occurred'));
                streamError = new Error(message);
                if (originalError && typeof originalError === 'object') {
                    Object.assign(streamError, originalError);
                }
            }

            // Handle abort errors
            if (streamError.name === 'AbortError' || abortController?.signal?.aborted) {
                streamError.isCancelled = true;
            }

            console.error('Error streaming completion:', streamError);

            // Log failed request
            if (window.networkLogger) {
                const logBody = {
                    model: modelId,
                    messages: messages.length + ' messages',
                    stream: true,
                    reasoning: reasoningPayload
                };

                window.networkLogger.logRequest({
                    type: 'openrouter',
                    method: 'POST',
                    url: url,
                    status: streamError.status || 0,
                    request: {
                        headers: window.networkLogger.sanitizeHeaders(headers),
                        body: logBody
                    },
                    error: streamError.message,
                    isAborted: streamError.isCancelled === true // Flag user-initiated cancellation
                });
            }

            throw streamError;
        }
    }

}

// Create and export singleton
const openRouterAPI = new OpenRouterAPI();

// Also attach to window for console debugging
if (typeof window !== 'undefined') {
    window.openRouterAPI = openRouterAPI;
}

export default openRouterAPI;
