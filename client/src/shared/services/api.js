/**
 * API Service for LLM Router Backend
 * 
 * Clean implementation for backend v2.4 - Phase 5 refactor.
 * No legacy compatibility - uses new session-first architecture only.
 */

import axios from 'axios';

// Base URL for the API - should be configurable via environment variables
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || '';

// Create axios instance with default config
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000, // 30 seconds timeout
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add request interceptor for logging
api.interceptors.request.use((config) => {
  console.log(`[API] ${config.method?.toUpperCase()} ${config.url}`, config.data);
  return config;
});

// Add response interceptor for error handling
api.interceptors.response.use(
  (response) => {
    console.log(`[API] Response:`, response.data);
    return response;
  },
  (error) => {
    console.error(`[API] Error:`, error.response?.data || error.message);
    return Promise.reject(error);
  }
);

/**
 * Helper function to handle session expiration errors consistently
 */
const handleSessionExpiration = (error) => {
  if (error.response?.status === 410) {
    const errorData = error.response.data;
    console.log('410 Error data from axios:', errorData);
    console.log('Full error object:', error.response);
    
    // For 410 status, assume session expired regardless of response format
    // This handles cases where the response parsing fails
    const sessionExpiredError = new Error('Session has expired. Please create a new session for better privacy.');
    sessionExpiredError.isSessionExpired = true;
    sessionExpiredError.action = 'create_new_session';
    sessionExpiredError.statusCode = 410;
    
    // Try to extract more specific message if available
    try {
      const detail = errorData?.detail || errorData;
      if (detail && (detail.error === 'session_expired' || errorData?.error === 'session_expired')) {
        const message = detail.message || errorData?.message;
        if (message) {
          sessionExpiredError.message = message;
        }
        const action = detail.action || errorData?.action;
        if (action) {
          sessionExpiredError.action = action;
        }
      }
    } catch (parseError) {
      console.warn('Failed to parse 410 response details, using defaults:', parseError);
    }
    
    throw sessionExpiredError;
  }
};

/**
 * API Service class
 */
class APIService {
  /**
   * Get available providers and models
   */
  async getProviders() {
    try {
      const response = await api.get('/api/providers');
      return response.data.providers;
    } catch (error) {
      throw new Error(`Failed to get providers: ${error.response?.data?.detail || error.message}`);
    }
  }

  /**
   * Initialize a new empty session
   * @param {number} userId - User identifier
   * @returns {Promise} Session initialization response
   */
  async initializeSession(userId) {
    try {
      const payload = {
        user_id: userId
      };

      const response = await api.post('/api/web/initialize-session', payload);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to initialize session: ${error.response?.data?.detail || error.message}`);
    }
  }

  /**
   * Update session models
   * @param {string} sessionId - Session identifier
   * @param {Array} selectedModels - Array of "provider/model" strings
   * @returns {Promise} Session update response
   */
  async updateSessionModels(sessionId, selectedModels) {
    try {
      const payload = {
        session_id: sessionId,
        selected_models: selectedModels
      };

      const response = await api.put('/api/web/session/models', payload);
      return response.data;
    } catch (error) {
      handleSessionExpiration(error);
      throw new Error(`Failed to update session models: ${error.response?.data?.detail || error.message}`);
    }
  }

  /**
   * Send a message using the session's bound endpoint
   * @param {string} sessionId - Session identifier
   * @param {string} prompt - User message
   * @param {number} userId - User identifier
   * @param {boolean} streaming - Whether to use streaming response
   * @param {boolean} isMultiTurn - Whether to include conversation history
   * @param {Array} conversationHistory - Previous messages in the conversation
   * @param {boolean} stateless - Whether to use single-turn mode
   * @param {Object} privacySettings - Privacy feature settings {piiRemoval, obfuscate, decoy}
   * @returns {Promise} LLM response
   */
  async sendMessage(sessionId, prompt, userId, streaming = true, isMultiTurn = false, conversationHistory = null, stateless = false, privacySettings = {}) {
    if (streaming) {
      return this.sendMessageStreaming(sessionId, prompt, userId, isMultiTurn, conversationHistory, stateless, privacySettings);
    } else {
      return this.sendMessageNonStreaming(sessionId, prompt, userId, isMultiTurn, conversationHistory, stateless, privacySettings);
    }
  }

  /**
   * Send a message with streaming response
   */
  async sendMessageStreaming(sessionId, prompt, userId, isMultiTurn = false, conversationHistory = null, stateless = false, privacySettings = {}) {
    try {
      const payload = {
        session_id: sessionId,
        prompt: prompt,
        user_id: userId,
        streaming: true,
        is_multi_turn: isMultiTurn,
        conversation_history: conversationHistory,
        stateless: stateless,
        
        // Privacy features
        pii_removal: privacySettings.piiRemoval || false,
        obfuscate: privacySettings.obfuscate || false,
        decoy: privacySettings.decoy || false
      };

      const response = await fetch(`${API_BASE_URL}/api/web/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      // Handle session expired (410 Gone)
      if (response.status === 410) {
        console.log('Got 410 response, handling session expiration');
        
        // For 410 status, assume session expired and create appropriate error
        const sessionExpiredError = new Error('Session has expired. Please create a new session for better privacy.');
        sessionExpiredError.isSessionExpired = true;
        sessionExpiredError.action = 'create_new_session';
        sessionExpiredError.statusCode = 410;
        
        // Try to get more specific message from response
        try {
          const errorData = await response.json();
          console.log('410 Response data:', errorData);
          
          const detail = errorData.detail || errorData;
          const message = detail?.message || errorData?.message;
          
          if (message) {
            sessionExpiredError.message = message;
          }
          
          const action = detail?.action || errorData?.action;
          if (action) {
            sessionExpiredError.action = action;
          }
        } catch (parseError) {
          console.warn('Could not parse 410 response JSON, using default message:', parseError);
        }
        
        throw sessionExpiredError;
      }

      // Handle other HTTP errors
      if (!response.ok) {
        // Try to parse error response for better error messages
        try {
          const errorData = await response.json();
          if (errorData.detail) {
            throw new Error(errorData.detail);
          } else if (errorData.message) {
            throw new Error(errorData.message);
          } else {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
        } catch (parseError) {
          // If we can't parse the error response, fall back to generic message
          throw new Error(`HTTP error! status: ${response.status}`);
        }
      }

      // Return a stream reader for the frontend to handle
      return {
        reader: response.body.getReader(),
        decoder: new TextDecoder(),
        async *[Symbol.asyncIterator]() {
          let buffer = '';
          try {
            while (true) {
              const { done, value } = await this.reader.read();
              if (done) break;
              
              buffer += this.decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop(); // Keep incomplete line in buffer
              
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
                    console.warn('Failed to parse SSE data:', data);
                  }
                }
              }
            }
          } finally {
            this.reader.releaseLock();
          }
        }
      };
    } catch (error) {
      // Re-throw session expiration errors as-is
      if (error.isSessionExpired) {
        console.log('Re-throwing session expiration error:', error.message);
        throw error;
      }
      
      // Handle other error types
      if (error.response?.status === 404) {
        throw new Error('Session not found. Please create a new session first.');
      }
      
      console.error('Streaming error details:', error);
      throw new Error(`Failed to send streaming message: ${error.message}`);
    }
  }

  /**
   * Send a message with non-streaming response
   */
  async sendMessageNonStreaming(sessionId, prompt, userId, isMultiTurn = false, conversationHistory = null, stateless = false, privacySettings = {}) {
    try {
      const payload = {
        session_id: sessionId,
        prompt: prompt,
        user_id: userId,
        streaming: false,
        is_multi_turn: isMultiTurn,
        conversation_history: conversationHistory,
        stateless: stateless,
        
        // Privacy features
        pii_removal: privacySettings.piiRemoval || false,
        obfuscate: privacySettings.obfuscate || false,
        decoy: privacySettings.decoy || false
      };

      const response = await api.post('/api/web/generate', payload);
      return response.data;
    } catch (error) {
      handleSessionExpiration(error);
      
      if (error.response?.status === 404) {
        throw new Error('Session not found. Please create a new session first.');
      }
      throw new Error(`Failed to send message: ${error.response?.data?.detail || error.message}`);
    }
  }

  /**
   * Get session information
   * @param {string} sessionId - Session identifier
   * @returns {Promise} Session information
   */
  async getSessionInfo(sessionId) {
    try {
      const response = await api.get(`/api/web/session/${sessionId}`);
      return response.data;
    } catch (error) {
      handleSessionExpiration(error);
      throw new Error(`Failed to get session info: ${error.response?.data?.detail || error.message}`);
    }
  }

  /**
   * End a session and clean up resources
   * @param {string} sessionId - Session identifier
   * @returns {Promise} Success confirmation
   */
  async endSession(sessionId) {
    try {
      await api.post('/api/web/end-session', { session_id: sessionId });
      return { success: true };
    } catch (error) {
      throw new Error(`Failed to end session: ${error.response?.data?.detail || error.message}`);
    }
  }

  /**
   * Health check
   * @returns {Promise} Health status
   */
  async healthCheck() {
    try {
      const response = await api.get('/api/health');
      return response.data;
    } catch (error) {
      throw new Error(`Health check failed: ${error.response?.data?.detail || error.message}`);
    }
  }

  /**
   * Get session-specific endpoint list
   * @param {string} sessionId - Session identifier
   * @returns {Promise} Session-specific proxy endpoints data
   */
  async getSessionEndpoints(sessionId) {
    try {
      const response = await api.get(`/api/web/session/${sessionId}/endpoints`);
      return response.data;
    } catch (error) {
      handleSessionExpiration(error);
      throw new Error(`Failed to get session endpoints: ${error.response?.data?.detail || error.message}`);
    }
  }

  /**
   * Choose an endpoint for the session (random or specific)
   * @param {string} sessionId - Session identifier
   * @param {string} endpointId - Optional specific endpoint ID, if null will choose randomly
   * @returns {Promise} Endpoint selection response
   */
  async chooseSessionEndpoint(sessionId, endpointId = null) {
    try {
      const payload = endpointId ? { endpoint_id: endpointId } : {};
      const response = await api.post(`/api/web/session/${sessionId}/choose-endpoint`, payload);
      return response.data;
    } catch (error) {
      handleSessionExpiration(error);
      throw new Error(`Failed to choose session endpoint: ${error.response?.data?.detail || error.message}`);
    }
  }

  /**
   * Connect to session (trigger endpoint selection)
   * @param {string} sessionId - Session identifier
   * @returns {Promise} Connection response
   */
  async connectSession(sessionId) {
    try {
      const response = await api.post('/api/web/connect', { session_id: sessionId });
      return response.data;
    } catch (error) {
      handleSessionExpiration(error);
      throw new Error(`Failed to connect session: ${error.response?.data?.detail || error.message}`);
    }
  }
}

// Export singleton instance
export default new APIService(); 