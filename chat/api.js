// OpenRouter API integration

// System prompt to prepend to all conversations
// Modify this function to change the default AI behavior
// Use template literals (backticks) for multi-line prompts
// This is a function so dynamic values (like date) are evaluated per request
const getSystemPrompt = () => `
You are a highly capable, thoughtful, and precise assistant. Your goal is to deeply understand the user's intent, ask clarifying questions when needed, think step-by-step through complex problems, provide clear, direct, and concise answers, and proactively anticipate helpful follow-up information. Always prioritize being truthful, nuanced, insightful, and efficient, tailoring your responses specifically to the user's needs and preferences. Importantly, be privacy-aware: never request user data and, when appropriate, remind users not to share sensitive information or that their inputs may be revealing their identity.

Formatting Rules:
- Use Markdown for lists, tables, and styling.
- Use \`\`\`code fences\`\`\` for all code blocks.
- Format file names, paths, and function names with \`inline code\` backticks.
- **For all mathematical expressions, you must use dollar-sign delimiters. Use $...$ for inline math and $$...$$ for block math.**

Current date: ${new Date().toLocaleDateString()}.
`.trim();

// To disable system prompt, return an empty string:
// const getSystemPrompt = () => '';
// Example:
// const getSystemPrompt = () => `You are a helpful AI assistant.
//
// Follow these guidelines:
// - Be concise and clear
// - Provide accurate information
// - Be respectful and professional`.trim();


class OpenRouterAPI {
    constructor() {
        this.baseUrl = 'https://openrouter.ai/api/v1';

        // Custom display name overrides
        // Map model ID or default name to custom display name
        this.displayNameOverrides = {
            'openai/gpt-5-chat': 'OpenAI: GPT-5 Instant',
            'openai/gpt-5': 'OpenAI: GPT-5 Thinking',
            // Add more customizations here as needed
            // Examples:
            // 'anthropic/claude-opus-4.1': 'Anthropic: Claude Opus 4.1 Extended',
            // 'google/gemini-2.5-pro': 'Google: Gemini 2.5 Pro Ultra',
        };
    }

    // Get API key - only use ticket-based key
    getApiKey() {
        try {
            const stored = localStorage.getItem('openrouter_api_key_data');
            if (stored) {
                const data = JSON.parse(stored);
                if (data.key) {
                    // Check if not expired
                    const expiryDate = new Date(data.expires_at);
                    if (expiryDate > new Date()) {
                        return data.key;
                    }
                }
            }
        } catch (error) {
            console.error('Error loading ticket-based API key:', error);
        }
        return null; // No API key available
    }

    // Fetch available models from OpenRouter
    async fetchModels() {
        const url = `${this.baseUrl}/models`;
        const headers = {
            'HTTP-Referer': window.location.origin,
            'X-Title': 'chat'
        };

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: headers
            });

            const data = await response.json();

            // Log successful request - TEMPORARILY DISABLED for model catalog
            // if (window.networkLogger) {
            //     window.networkLogger.logRequest({
            //         type: 'openrouter',
            //         method: 'GET',
            //         url: url,
            //         status: response.status,
            //         request: { headers: window.networkLogger.sanitizeHeaders(headers) },
            //         response: { data: data.data ? `${data.data.length} models` : data }
            //     });
            // }

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return this.formatModels(data.data);
        } catch (error) {
            console.error('Error fetching models from OpenRouter:', error);

            // Log failed request - TEMPORARILY DISABLED for model catalog
            // if (window.networkLogger) {
            //     window.networkLogger.logRequest({
            //         type: 'openrouter',
            //         method: 'GET',
            //         url: url,
            //         status: 0,
            //         request: { headers: window.networkLogger.sanitizeHeaders(headers) },
            //         error: error.message
            //     });
            // }

            // Return a fallback list of models
            return [
                { name: 'OpenAI: GPT-5 Instant', id: 'openai/gpt-5-chat', category: 'OpenAI', provider: 'OpenAI' },
            ];
        }
    }

    // Get custom display name for a model, or return the default name
    getDisplayName(modelId, defaultName) {
        // Check if there's a custom override for this model ID
        return this.displayNameOverrides[modelId] || defaultName;
    }

    // Format models to our structure
    formatModels(models) {
        const formattedModels = models.map(model => {
            // Extract provider from model ID (e.g., "openai/gpt-4" -> "OpenAI")
            const provider = model.id.split('/')[0];
            const providerName = this.capitalizeProvider(provider);

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
            const defaultName = model.name || model.id;
            const displayName = this.getDisplayName(model.id, defaultName);

            return {
                id: model.id,
                name: displayName,
                category: category,
                categoryPriority: categoryPriority,
                provider: providerName,
                context_length: model.context_length,
                pricing: model.pricing
            };
        });

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

    capitalizeProvider(provider) {
        const providerMap = {
            'openai': 'OpenAI',
            'anthropic': 'Anthropic',
            'google': 'Google',
            'meta-llama': 'Meta',
            'mistralai': 'Mistral',
            'deepseek': 'DeepSeek',
            'cohere': 'Cohere',
            'perplexity': 'Perplexity'
        };
        return providerMap[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
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

    // Get model-specific max_tokens
    getMaxTokensForModel(modelId) {
        // Check for Opus 4.1
        if (modelId.includes('claude-opus-4.1')) {
            return 13333;
        }
        // Check for GPT-5 Thinking (exclude chat variant)
        if (modelId.includes('gpt-5') && !modelId.includes('gpt-5-chat')) {
            return 100000;
        }
        return undefined; // Use API default for other models
    }

    // Fallback models if API fails
    getFallbackModels() {
        return [
            { id: 'openai/gpt-4', name: 'GPT-4', category: 'Flagship models', provider: 'OpenAI' },
            { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo', category: 'Flagship models', provider: 'OpenAI' },
            { id: 'openai/gpt-3.5-turbo', name: 'GPT-3.5 Turbo', category: 'Flagship models', provider: 'OpenAI' },
            { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus', category: 'Flagship models', provider: 'Anthropic' },
            { id: 'anthropic/claude-3-sonnet', name: 'Claude 3 Sonnet', category: 'Flagship models', provider: 'Anthropic' },
            { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku', category: 'Flagship models', provider: 'Anthropic' },
        ];
    }

    // Send chat completion request
    async sendCompletion(messages, modelId, apiKey) {
        const url = `${this.baseUrl}/chat/completions`;
        const key = apiKey || this.getApiKey();

        if (!key) {
            throw new Error('No API key available. Please obtain an API key first.');
        }

        const headers = {
            'Authorization': `Bearer ${key}`,
            'HTTP-Referer': window.location.origin,
            'X-Title': 'chat',
            'Content-Type': 'application/json'
        };

        // Prepend system prompt if it exists
        const systemPrompt = getSystemPrompt();
        const messagesWithSystem = systemPrompt
            ? [{ role: 'system', content: systemPrompt }, ...messages]
            : messages;

        const body = {
            model: modelId,
            messages: messagesWithSystem.map(msg => ({
                role: msg.role,
                content: msg.content
            }))
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            });

            const data = await response.json();

            // Log successful request
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
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return data.choices[0]?.message?.content || 'No response received';
        } catch (error) {
            console.error('Error sending completion:', error);

            // Log failed request
            if (window.networkLogger) {
                window.networkLogger.logRequest({
                    type: 'openrouter',
                    method: 'POST',
                    url: url,
                    status: 0,
                    request: {
                        headers: window.networkLogger.sanitizeHeaders(headers),
                        body: body
                    },
                    error: error.message
                });
            }

            return `Error: ${error.message}. Using simulated response instead: This is a fallback response since the API call failed.`;
        }
    }

    // Stream chat completion with support for multimodal content, web search, and reasoning traces
    async streamCompletion(messages, modelId, apiKey, onChunk, onTokenUpdate, files = [], searchEnabled = false, abortController = null, onReasoningChunk = null) {
        const key = apiKey || this.getApiKey();

        if (!key) {
            throw new Error('No API key available. Please obtain an API key first.');
        }

        // Handle web search - append :online suffix if enabled
        let effectiveModelId = modelId;
        if (searchEnabled && !modelId.includes(':online')) {
            effectiveModelId = `${modelId}:online`;
        }

        // Always use chat/completions endpoint
        // We'll handle reasoning SSE events if they come through
        const url = `${this.baseUrl}/chat/completions`;

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

        const headers = {
            'Authorization': `Bearer ${key}`,
            'HTTP-Referer': window.location.origin,
            'X-Title': 'chat',
            'Content-Type': 'application/json'
        };

        let totalTokens = 0;
        let promptTokens = 0;
        let completionTokens = 0;
        let modelUsed = effectiveModelId;
        let accumulatedContent = '';
        let accumulatedReasoning = '';
        let hasReceivedFirstToken = false;
        let citations = []; // Track citations for web search results
        let annotations = []; // Track annotations from OpenRouter response
        
        // Buffering for reasoning chunks to reduce UI updates
        let reasoningBuffer = '';
        let reasoningBufferTimer = null;
        const REASONING_BUFFER_DELAY = 50; // ms - flush buffer after this delay
        const REASONING_BUFFER_SIZE = 20; // chars - flush when buffer reaches this size

        // Helper to flush reasoning buffer
        const flushReasoningBuffer = () => {
            if (reasoningBuffer && onReasoningChunk) {
                onReasoningChunk(reasoningBuffer);
                reasoningBuffer = '';
            }
            if (reasoningBufferTimer) {
                clearTimeout(reasoningBufferTimer);
                reasoningBufferTimer = null;
            }
        };

        // Helper to parse citations from annotations
        const parseCitationsFromAnnotations = (annotationsList) => {
            const citationsList = [];
            let citationIndex = 1;
            
            if (!annotationsList || !Array.isArray(annotationsList)) return citationsList;
            
            // Extract url_citation annotations
            const urlCitations = annotationsList.filter(ann => ann.type === 'url_citation');
            
            if (urlCitations.length > 0) {
                console.log('Found web search citations:', urlCitations.length);
            }
            
            urlCitations.forEach(annotation => {
                citationsList.push({
                    url: annotation.url || '',
                    title: annotation.title || null,
                    content: annotation.content || null,
                    index: citationIndex++,
                    // OpenRouter uses snake_case: start_index, end_index
                    startIndex: annotation.start_index ?? annotation.startIndex ?? null,
                    endIndex: annotation.end_index ?? annotation.endIndex ?? null
                });
            });
            
            return citationsList;
        };

        // Helper to parse citations from content (fallback for when no annotations)
        // Extracts URLs and numbered references like [1], [2] etc.
        const parseCitations = (content) => {
            const citationMap = new Map();
            let citationIndex = 1;
            
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
                const url = match[2];
                if (!citationMap.has(url)) {
                    citationMap.set(url, {
                        url: url,
                        title: match[1],
                        index: citationIndex++
                    });
                }
            }
            
            // Pattern 2: References/Sources section at the end
            // Matches patterns like: [1] https://example.com or Sources: 1. https://example.com
            const referencesPattern = /(?:^|\n)(?:References?|Sources?|Citations?):?\s*\n((?:(?:\[\d+\]|\d+\.)\s*https?:\/\/[^\s]+\s*\n?)+)/gmi;
            const referencesMatch = referencesPattern.exec(content);
            if (referencesMatch) {
                const referencesSection = referencesMatch[1];
                const citationPattern = /(?:\[(\d+)\]|(\d+)\.)\s*(https?:\/\/[^\s]+)/g;
                while ((match = citationPattern.exec(referencesSection)) !== null) {
                    const url = match[3];
                    const num = parseInt(match[1] || match[2]);
                    if (!citationMap.has(url)) {
                        citationMap.set(url, {
                            url: url,
                            title: null,
                            index: num || citationIndex++
                        });
                    }
                }
            }
            
            // Pattern 3: Plain URLs in the content that look like sources
            // More conservative - only match URLs that appear to be references
            const plainUrlPattern = /(?:(?:^|\n)(?:[-•*]|\d+\.?)\s+)?(https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/\/=]*))/g;
            while ((match = plainUrlPattern.exec(content)) !== null) {
                const url = match[1];
                // Only add if not already captured and looks like a real source
                if (!citationMap.has(url) && 
                    !url.match(/\.(png|jpg|jpeg|gif|svg|css|js|ico|woff|ttf|eot)$/i) &&
                    url.length < 200) {
                    citationMap.set(url, {
                        url: url,
                        title: null,
                        index: citationIndex++
                    });
                }
            }
            
            // If we have existing citation numbers in text but found URLs, ensure they match
            if (existingNumbers.size > 0 && citationMap.size > 0) {
                // The content has numbered citations, so we found the sources
                return Array.from(citationMap.values()).sort((a, b) => a.index - b.index);
            }
            
            // Only return citations if we found some
            return citationMap.size > 0 ? Array.from(citationMap.values()).sort((a, b) => a.index - b.index) : [];
        };

        try {
            // Prepend system prompt if it exists
            const systemPrompt = getSystemPrompt();
            const messagesWithSystem = systemPrompt
                ? [{ role: 'system', content: systemPrompt }, ...processedMessages]
                : processedMessages;

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

            // Add model-specific max_tokens if applicable
            const maxTokens = this.getMaxTokensForModel(effectiveModelId);
            if (maxTokens !== undefined) {
                requestBody.max_tokens = maxTokens;
            }

            // Add PDF plugin configuration if PDFs are present
            // Default to mistral-ocr as per OpenRouter documentation
            if (hasPdfFiles) {
                requestBody.plugins = [
                    {
                        id: 'file-parser',
                        pdf: {
                            engine: 'mistral-ocr'
                        }
                    }
                ];
            }

            const fetchOptions = {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestBody)
            };

            // Add abort signal if provided
            if (abortController) {
                fetchOptions.signal = abortController.signal;
            }

            const response = await fetch(url, fetchOptions);

            // Handle pre-stream errors
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errorMessage = errorData.error?.message || `HTTP error! status: ${response.status}`;
                const error = new Error(errorMessage);
                error.status = response.status;
                error.data = errorData;
                throw error;
            }

            // Log the streaming request
            if (window.networkLogger) {
                const logBody = { model: modelId, messages: messages.length + ' messages', stream: true };

                window.networkLogger.logRequest({
                    type: 'openrouter',
                    method: 'POST',
                    url: url,
                    status: response.status,
                    request: {
                        headers: window.networkLogger.sanitizeHeaders(headers),
                        body: logBody
                    },
                    response: { streaming: true }
                });
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
                    // Skip empty lines
                    if (line.trim() === '') continue;

                    // Handle SSE comments (OpenRouter processing indicators)
                    if (line.startsWith(':')) {
                        // These are SSE comments, we can optionally use them for UI feedback
                        // For example: ": OPENROUTER PROCESSING"
                        console.debug('SSE comment:', line);
                        continue;
                    }

                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(data);

                            // Check for annotations in various possible locations in the response
                            // Format 1: Direct annotations array
                            if (parsed.annotations && Array.isArray(parsed.annotations)) {
                                console.log('Found annotations (format 1 - direct):', parsed.annotations.length);
                                annotations = annotations.concat(parsed.annotations);
                            }
                            
                            // Format 2: In choices[0].message.annotations (chat completions format)
                            if (parsed.choices?.[0]?.message?.annotations && Array.isArray(parsed.choices[0].message.annotations)) {
                                console.log('Found annotations (format 2 - choices[0].message):', parsed.choices[0].message.annotations.length);
                                annotations = annotations.concat(parsed.choices[0].message.annotations);
                            }
                            
                            // Format 3: In choices[0].message.content[] (if content is array with annotations)
                            const messageContent = parsed.choices?.[0]?.message?.content;
                            if (Array.isArray(messageContent)) {
                                messageContent.forEach(item => {
                                    if (item.annotations && Array.isArray(item.annotations)) {
                                        annotations = annotations.concat(item.annotations);
                                    }
                                });
                            }
                            
                            // Format 4: /responses API format - check output[].content[].annotations[]
                            if (parsed.output && Array.isArray(parsed.output)) {
                                parsed.output.forEach(output => {
                                    if (output.content && Array.isArray(output.content)) {
                                        output.content.forEach(contentItem => {
                                            if (contentItem.annotations && Array.isArray(contentItem.annotations)) {
                                                annotations = annotations.concat(contentItem.annotations);
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
                                                    annotations = annotations.concat(contentItem.annotations);
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
                                        flushReasoningBuffer();
                                    } else {
                                        // Otherwise, set a timer to flush after delay
                                        reasoningBufferTimer = setTimeout(flushReasoningBuffer, REASONING_BUFFER_DELAY);
                                    }
                                }

                                // Skip normal content processing if this was a reasoning event
                                if (parsed.type === 'response.reasoning.delta') continue;
                            }

                            // Check for mid-stream errors
                            if (parsed.error) {
                                const errorMessage = parsed.error.message || 'Stream error occurred';
                                const error = new Error(errorMessage);
                                error.code = parsed.error.code;
                                error.isStreamError = true;
                                error.hasReceivedTokens = hasReceivedFirstToken;

                                // Check if this is a terminal error
                                if (parsed.choices?.[0]?.finish_reason === 'error') {
                                    throw error;
                                }
                            }

                            // Handle message content delta events from reasoning API (if using separate endpoint)
                            if (parsed.type === 'response.output_text.delta') {
                                const contentDelta = parsed.delta || '';
                                if (contentDelta) {
                                    hasReceivedFirstToken = true;
                                    accumulatedContent += contentDelta;
                                    onChunk(contentDelta);

                                    completionTokens = Math.ceil(accumulatedContent.length / 4);
                                    if (onTokenUpdate) {
                                        onTokenUpdate({
                                            completionTokens,
                                            isStreaming: true
                                        });
                                    }
                                }
                                continue;
                            }

                            const delta = parsed.choices?.[0]?.delta;
                            const content = delta?.content;

                            if (content) {
                                hasReceivedFirstToken = true;
                                accumulatedContent += content;
                                onChunk(content);

                                // Improved token estimation during streaming
                                completionTokens = Math.ceil(accumulatedContent.length / 4);
                                if (onTokenUpdate) {
                                    onTokenUpdate({
                                        completionTokens,
                                        isStreaming: true
                                    });
                                }
                            }

                            // Check for images in the delta (standard OpenRouter format)
                            if (delta?.images) {
                                hasReceivedFirstToken = true;
                                onChunk(null, { images: delta.images });
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
                                    onChunk(null, { images });
                                }
                            }

                            // Check for finish reason
                            const finishReason = parsed.choices?.[0]?.finish_reason;
                            if (finishReason && finishReason !== 'stop') {
                                console.warn('Stream finished with reason:', finishReason);
                            }

                            // Check for usage info in the stream
                            if (parsed.usage) {
                                totalTokens = parsed.usage.total_tokens || 0;
                                promptTokens = parsed.usage.prompt_tokens || 0;
                                completionTokens = parsed.usage.completion_tokens || 0;


                                // Update token count with final accurate values
                                if (onTokenUpdate) {
                                    onTokenUpdate({
                                        totalTokens,
                                        promptTokens,
                                        completionTokens,
                                        isStreaming: false
                                    });
                                }
                            }

                            // Check for model info
                            if (parsed.model) {
                                modelUsed = parsed.model;
                            }
                        } catch (e) {
                            console.error('Error parsing SSE chunk:', e, 'Raw line:', line);
                            // Continue processing other chunks
                        }
                    }
                }
            }

            // Flush any remaining reasoning buffer
            flushReasoningBuffer();

            // Parse citations - prefer annotations over content parsing
            if (searchEnabled) {
                if (annotations.length > 0) {
                    // Use citations from annotations if available
                    console.log('Processing annotations for citations:', annotations.length, 'annotations');
                    citations = parseCitationsFromAnnotations(annotations);
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
                model: modelUsed,
                reasoning: accumulatedReasoning || null,
                citations: citations.length > 0 ? citations : null
            };
        } catch (error) {
            // Flush any remaining reasoning buffer before handling error
            flushReasoningBuffer();

            // Handle abort errors
            if (error.name === 'AbortError') {
                error.isCancelled = true;
            }

            console.error('Error streaming completion:', error);

            // Log failed request
            if (window.networkLogger) {
                const logBody = { model: modelId, messages: messages.length + ' messages', stream: true };

                window.networkLogger.logRequest({
                    type: 'openrouter',
                    method: 'POST',
                    url: url,
                    status: error.status || 0,
                    request: {
                        headers: window.networkLogger.sanitizeHeaders(headers),
                        body: logBody
                    },
                    error: error.message
                });
            }

            throw error;
        }
    }

}

// Export for use in app.js
const openRouterAPI = new OpenRouterAPI();

// For non-module scripts
if (typeof window !== 'undefined') {
    window.openRouterAPI = openRouterAPI;
}

