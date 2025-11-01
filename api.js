// OpenRouter API integration
class OpenRouterAPI {
    constructor() {
        this.apiKey = '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';
        this.baseUrl = 'https://openrouter.ai/api/v1';
    }

    // Fetch available models from OpenRouter
    async fetchModels() {
        try {
            const response = await fetch(`${this.baseUrl}/models`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'HTTP-Referer': window.location.origin,
                    'X-Title': 'OpenRouter Chat Clone'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            return this.formatModels(data.data);
        } catch (error) {
            console.error('Error fetching models from OpenRouter:', error);
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
    async sendCompletion(messages, modelId) {
        try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'HTTP-Referer': window.location.origin,
                    'X-Title': 'OpenRouter Chat Clone',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: modelId,
                    messages: messages.map(msg => ({
                        role: msg.role,
                        content: msg.content
                    }))
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            return data.choices[0]?.message?.content || 'No response received';
        } catch (error) {
            console.error('Error sending completion:', error);
            return `Error: ${error.message}. Using simulated response instead: This is a fallback response since the API call failed.`;
        }
    }

    // Stream chat completion (for future implementation)
    async streamCompletion(messages, modelId, onChunk) {
        try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'HTTP-Referer': window.location.origin,
                    'X-Title': 'OpenRouter Chat Clone',
                    'Content-Type': 'application/json'
                },
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
                            }
                        } catch (e) {
                            console.error('Error parsing chunk:', e);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error streaming completion:', error);
            throw error;
        }
    }
}

// Export for use in app.js
const openRouterAPI = new OpenRouterAPI();

