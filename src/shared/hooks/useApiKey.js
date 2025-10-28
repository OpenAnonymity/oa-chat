/**
 * Custom hook for managing OpenRouter API key lifecycle
 */

import { useState, useEffect, useCallback } from 'react';
import stationClient from '../services/station';
import openRouterClient from '../services/openrouter';
import apiKeyStore from './apiKeyStore'; // Import the new store

export const useApiKey = () => {
  const [storeState, setStoreState] = useState(apiKeyStore.getInitialState());

  useEffect(() => {
    const handleStoreChange = () => {
      setStoreState(apiKeyStore.getState());
    };

    apiKeyStore.subscribe(handleStoreChange);
    // Load initial state from localStorage
    apiKeyStore.loadApiKey();

    return () => {
      apiKeyStore.unsubscribe(handleStoreChange);
    };
  }, []);

  const { apiKey, apiKeyInfo, expiresAt, ticketUsed } = storeState;

  const [timeRemaining, setTimeRemaining] = useState(null);
  const [isExpired, setIsExpired] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Update time remaining countdown
  useEffect(() => {
    if (!expiresAt) {
      setTimeRemaining(null);
      setIsExpired(false);
      return;
    }

    // Parse expiration time as UTC
    const expiryDate = new Date(expiresAt);
    
    // Verify it's a valid date
    if (isNaN(expiryDate.getTime())) {
      console.error('Invalid expiration date:', expiresAt);
      setTimeRemaining('Invalid date');
      return;
    }

    const updateTimeRemaining = () => {
      // Get current time in UTC
      const now = new Date();
      const diff = expiryDate - now;

      if (diff <= 0) {
        setIsExpired(true);
        setTimeRemaining('Expired');
        clearApiKey();
      } else {
        setIsExpired(false);
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        const seconds = Math.floor((diff % 60000) / 1000);
        
        // Format based on time remaining
        if (hours > 0) {
          setTimeRemaining(`${hours}h ${minutes}m`);
        } else if (minutes > 0) {
          setTimeRemaining(`${minutes}m ${seconds}s`);
        } else {
          setTimeRemaining(`${seconds}s`);
        }
      }
    };

    updateTimeRemaining();
    const interval = setInterval(updateTimeRemaining, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  /**
   * Request a new API key from the station
   */
  const requestNewApiKey = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await stationClient.requestApiKey();
      apiKeyStore.setApiKey(result);
      return result;
    } catch (error) {
      setError(error.message);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Verify the current API key
   */
  const verifyApiKey = useCallback(async (content = 'Hello', maxTokens = 10) => {
    if (!apiKey) {
      throw new Error('No API key to verify');
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await openRouterClient.verifyApiKey(content, maxTokens);
      return result;
    } catch (error) {
      setError(error.message);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  /**
   * Clear the current API key
   */
  const clearApiKey = useCallback(() => {
    apiKeyStore.clearApiKey();
  }, []);

  /**
   * Renew API key (request a new one)
   */
  const renewApiKey = useCallback(async () => {
    clearApiKey();
    return await requestNewApiKey();
  }, [clearApiKey, requestNewApiKey]);

  return {
    // State
    apiKey,
    apiKeyInfo,
    expiresAt,
    timeRemaining,
    isExpired,
    isLoading,
    error,
    ticketUsed,
    hasApiKey: !!apiKey,

    // Actions
    requestNewApiKey,
    verifyApiKey,
    clearApiKey,
    renewApiKey,
  };
};

