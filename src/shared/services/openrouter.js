/**
 * OpenRouter API Client
 * Direct integration with OpenRouter's API for chat completions
 */

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter API Client Class
 */
class OpenRouterClient {
  constructor() {
    this.apiKey = null;
  }

  /**
   * Set the API key for OpenRouter requests
   */
  setApiKey(apiKey) {
    this.apiKey = apiKey;
  }

  /**
   * Get the current API key
   */
  getApiKey() {
    return this.apiKey;
  }

  /**
   * Clear the stored API key
   */
  clearApiKey() {
    this.apiKey = null;
  }

  /**
   * Fetch available models from OpenRouter
   */
  async getModels() {
    try {
      const response = await fetch(`${OPENROUTER_API_BASE}/models`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.statusText}`);
      }

      const data = await response.json();
      return data.data || []; // OpenRouter returns models in data array
    } catch (error) {
      console.error('Error fetching OpenRouter models:', error);
      throw new Error(`Failed to fetch models: ${error.message}`);
    }
  }

  /**
   * Send a chat completion request to OpenRouter (streaming)
   */
  async *streamChatCompletion(model, messages, options = {}) {
    if (!this.apiKey) {
      throw new Error('API key not set. Please obtain an API key first.');
    }

    try {
      const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': window.location.origin,
          'X-Title': 'OA-Station Web Chat',
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          stream: true,
          ...options,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      // Parse SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            
            if (data === '[DONE]') {
              return;
            }

            try {
              const chunk = JSON.parse(data);
              yield chunk;
            } catch (e) {
              console.warn('Failed to parse SSE chunk:', data);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error in streamChatCompletion:', error);
      throw error;
    }
  }

  /**
   * Send a non-streaming chat completion request
   */
  async chatCompletion(model, messages, options = {}) {
    if (!this.apiKey) {
      throw new Error('API key not set. Please obtain an API key first.');
    }

    try {
      const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': window.location.origin,
          'X-Title': 'OA-Station Web Chat',
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          stream: false,
          ...options,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error in chatCompletion:', error);
      throw error;
    }
  }

  /**
   * Verify the API key by making a simple request
   */
  async verifyApiKey(content = 'Hello', maxTokens = 10) {
    if (!this.apiKey) {
      throw new Error('No API key to verify');
    }

    try {
      const startTime = Date.now();
      
      const response = await this.chatCompletion(
        'openai/gpt-3.5-turbo',
        [{ role: 'user', content: content }],
        { max_tokens: maxTokens }
      );

      const duration = Date.now() - startTime;

      return {
        valid: true,
        duration: duration,
        model: response.model,
        usage: response.usage,
        response: response.choices[0]?.message?.content || '',
        requestContent: content,
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message,
        requestContent: content,
      };
    }
  }

  // TODO: Fix OpenRouter credits API endpoint
  // The API endpoint or response format needs to be verified with OpenRouter documentation
  // Uncomment and fix when correct endpoint is confirmed
  /**
   * Get remaining credits for the authenticated user
   * Returns total credits purchased and used
   */
  // async getCredits() {
  //   if (!this.apiKey) {
  //     throw new Error('API key not set');
  //   }

  //   try {
  //     const response = await fetch(`${OPENROUTER_API_BASE}/credits`, {
  //       method: 'GET',
  //       headers: {
  //         'Authorization': `Bearer ${this.apiKey}`,
  //         'Content-Type': 'application/json',
  //       },
  //     });

  //     if (!response.ok) {
  //       const errorData = await response.json().catch(() => ({}));
  //       throw new Error(errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`);
  //     }

  //     const data = await response.json();
  //     
  //     // Calculate remaining credits
  //     const totalCredits = data.data?.total_credits || 0;
  //     const totalUsage = data.data?.total_usage || 0;
  //     const remainingCredits = totalCredits - totalUsage;

  //     return {
  //       totalCredits,
  //       totalUsage,
  //       remainingCredits,
  //       raw: data.data,
  //     };
  //   } catch (error) {
  //     console.error('Error fetching OpenRouter credits:', error);
  //     throw error;
  //   }
  // }
}

// Export singleton instance
export default new OpenRouterClient();

