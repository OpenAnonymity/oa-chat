/**
 * Simplified chat hook for direct API integration
 * No sessions, no proxy endpoints - just direct API calls
 */

import { useState, useCallback } from 'react';
import { openRouterClient } from '../../../shared/services';

export const useOAChat = (apiKey, selectedModel) => {
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Send a message via OA Chat
   */
  const sendMessage = useCallback(async (userMessage, conversationHistory = []) => {
    if (!apiKey) {
      throw new Error('No API key available. Please request one first.');
    }

    if (!selectedModel) {
      throw new Error('No model selected. Please select a model first.');
    }

    setIsLoading(true);
    setError(null);

    try {
      // Prepare messages for API
      const apiMessages = conversationHistory.length > 0 
        ? conversationHistory 
        : [{ role: 'user', content: userMessage }];

      // If we have history, append the new message
      if (conversationHistory.length > 0) {
        apiMessages.push({ role: 'user', content: userMessage });
      }

      // Stream the response
      const stream = openRouterClient.streamChatCompletion(
        selectedModel,
        apiMessages
      );

      return stream;

    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, selectedModel]);

  /**
   * Add a message to the conversation
   */
  const addMessage = useCallback((message) => {
    setMessages(prev => [...prev, message]);
  }, []);

  /**
   * Update a message in the conversation
   */
  const updateMessage = useCallback((messageId, updater) => {
    setMessages(prev => prev.map(msg => 
      msg.id === messageId ? updater(msg) : msg
    ));
  }, []);

  /**
   * Clear all messages
   */
  const clearMessages = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  /**
   * Get conversation history in API format
   */
  const getConversationHistory = useCallback(() => {
    return messages
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .map(msg => ({
        role: msg.role,
        content: msg.parts?.[0]?.text || msg.content || '',
      }));
  }, [messages]);

  return {
    messages,
    isLoading,
    error,
    sendMessage,
    addMessage,
    updateMessage,
    clearMessages,
    getConversationHistory,
  };
};

