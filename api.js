// OpenRouter API integration
class OpenRouterAPI {
    constructor() {
        this.baseUrl = 'https://openrouter.ai/api/v1';
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
                        console.log('Using ticket-based API key');
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
            
            // Log successful request
            if (window.networkLogger) {
                window.networkLogger.logRequest({
                    type: 'openrouter',
                    method: 'GET',
                    url: url,
                    status: response.status,
                    request: { headers: window.networkLogger.sanitizeHeaders(headers) },
                    response: { data: data.data ? `${data.data.length} models` : data }
                });
            }

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return this.formatModels(data.data);
        } catch (error) {
            console.error('Error fetching models from OpenRouter:', error);
            
            // Log failed request
            if (window.networkLogger) {
                window.networkLogger.logRequest({
                    type: 'openrouter',
                    method: 'GET',
                    url: url,
                    status: 0,
                    request: { headers: window.networkLogger.sanitizeHeaders(headers) },
                    error: error.message
                });
            }
            
            // Return a fallback list of models
            return [
                { name: 'GPT-5 Chat', id: 'openrouter/gpt-5-chat', category: 'OpenRouter', provider: 'OpenRouter' },
                { name: 'GPT-4o', id: 'openai/gpt-4o', category: 'OpenAI', provider: 'OpenAI' },
                { name: 'GPT-4', id: 'openai/gpt-4', category: 'OpenAI', provider: 'OpenAI' },
                { name: 'GPT-3.5 Turbo', id: 'openai/gpt-3.5-turbo', category: 'OpenAI', provider: 'OpenAI' },
                { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus', category: 'Flagship models', provider: 'Anthropic' },
                { id: 'anthropic/claude-3-sonnet', name: 'Claude 3 Sonnet', category: 'Flagship models', provider: 'Anthropic' },
                { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku', category: 'Flagship models', provider: 'Anthropic' },
            ];
        }
    }

    // Format models to our structure
    formatModels(models) {
        const formattedModels = models.map(model => {
            // Extract provider from model ID (e.g., "openai/gpt-4" -> "OpenAI")
            const provider = model.id.split('/')[0];
            const providerName = this.capitalizeProvider(provider);
            
            // Categorize models
            let category = 'Other models';
            if (model.id.includes('gpt') || model.id.includes('claude') || model.id.includes('gemini')) {
                category = 'Flagship models';
            } else if (model.id.includes('llama') || model.id.includes('mistral')) {
                category = 'Best roleplay models';
            } else if (model.id.includes('code') || model.id.includes('deepseek')) {
                category = 'Best coding models';
            } else if (model.id.includes('o1')) {
                category = 'Reasoning models';
            }

            return {
                id: model.id,
                name: model.name || model.id,
                category: category,
                provider: providerName,
                context_length: model.context_length,
                pricing: model.pricing
            };
        });

        // Sort by popularity/pricing
        return formattedModels.sort((a, b) => {
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
        const body = {
            model: modelId,
            messages: messages.map(msg => ({
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

    // Stream chat completion
    async streamCompletion(messages, modelId, apiKey, onChunk, onTokenUpdate) {
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
        
        let totalTokens = 0;
        let promptTokens = 0;
        let completionTokens = 0;
        let modelUsed = modelId;
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    model: modelId,
                    messages: messages.map(msg => ({
                        role: msg.role,
                        content: msg.content
                    })),
                    stream: true
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            // Log the streaming request
            if (window.networkLogger) {
                window.networkLogger.logRequest({
                    type: 'openrouter',
                    method: 'POST',
                    url: url,
                    status: response.status,
                    request: { 
                        headers: window.networkLogger.sanitizeHeaders(headers),
                        body: { model: modelId, messages: messages.length + ' messages', stream: true }
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
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(data);
                            const content = parsed.choices[0]?.delta?.content;
                            if (content) {
                                onChunk(content);
                                // Estimate tokens during streaming (rough approximation: 1 token ≈ 4 chars)
                                completionTokens = Math.ceil(content.length / 4);
                                if (onTokenUpdate) {
                                    onTokenUpdate({ 
                                        completionTokens, 
                                        isStreaming: true 
                                    });
                                }
                            }
                            
                            // Check for usage info in the stream
                            if (parsed.usage) {
                                totalTokens = parsed.usage.total_tokens || 0;
                                promptTokens = parsed.usage.prompt_tokens || 0;
                                completionTokens = parsed.usage.completion_tokens || 0;
                            }
                            
                            // Check for model info
                            if (parsed.model) {
                                modelUsed = parsed.model;
                            }
                        } catch (e) {
                            console.error('Error parsing chunk:', e);
                        }
                    }
                }
            }
            
            // Return token usage data
            return {
                totalTokens,
                promptTokens,
                completionTokens,
                model: modelUsed
            };
        } catch (error) {
            console.error('Error streaming completion:', error);
            
            // Log failed request
            if (window.networkLogger) {
                window.networkLogger.logRequest({
                    type: 'openrouter',
                    method: 'POST',
                    url: url,
                    status: 0,
                    request: { 
                        headers: window.networkLogger.sanitizeHeaders(headers),
                        body: { model: modelId, messages: messages.length + ' messages', stream: true }
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

