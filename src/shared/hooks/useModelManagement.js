import { useState, useEffect } from 'react';
import { MODEL_METADATA } from '../../features/models';
import apiService from '../services/api';

export const useModelManagement = () => {
  const [selectedModels, setSelectedModels] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [currentSession, setCurrentSession] = useState(null);
  const [availableProviders, setAvailableProviders] = useState({});
  const [modelMapping, setModelMapping] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isRecreatingSession, setIsRecreatingSession] = useState(false);

  // User ID - in a real app, this would come from auth context
  const userId = 1;

  // Load available providers and initialize session on mount
  useEffect(() => {
    const initialize = async () => {
      try {
        setIsLoading(true);
        
        // Load providers
        const providers = await apiService.getProviders();
        setAvailableProviders(providers);
        
        // Create mapping between frontend model IDs and backend model strings
        const mapping = {};
        
        Object.entries(MODEL_METADATA).forEach(([modelId, metadata]) => {
          const backendProvider = metadata.provider;
          
          // Check if the backend has this exact provider and model tag
          if (providers[backendProvider] && providers[backendProvider].includes(modelId)) {
            mapping[modelId] = `${backendProvider}/${modelId}`;
          }
        });
        
        setModelMapping(mapping);
        console.log('Loaded providers:', providers);
        console.log('Created model mapping:', mapping);

        // Initialize empty session immediately (session-first architecture)
        const initResponse = await apiService.initializeSession(userId);
        setCurrentSession({
          id: initResponse.session_id,
          provider: "",
          model: "",
          endpoint_id: null,
          api_key_hash: null,
          message: "Session initialized",
          hasEndpoints: false,
          lastUpdated: Date.now()
        });
        console.log('Session initialized on page load:', initResponse.session_id);
        
      } catch (error) {
        console.error('Failed to initialize:', error);
        setError(error.message);
      } finally {
        setIsLoading(false);
      }
    };

    initialize();
  }, []);

  const handleModelChange = async (newModels) => {
    setSelectedModels(newModels);
    console.log(`Models updated: Selected ${newModels.length} model(s)`);
    
    // Always update the session with new models (creates real endpoints)
    if (currentSession) {
      await handleSessionModelUpdate(newModels);
    }
  };

  const handleSessionModelUpdate = async (newModels) => {
    return await handleSessionModelUpdateWithSession(newModels, null);
  };

  const handleToggleConnection = async () => {
    if (isConnected) {
      await handleDisconnect();
    } else {
      await handleConnect();
    }
  };

  const handleConnect = async () => {
    if (selectedModels.length === 0) {
      setError('Please select at least one model');
      console.warn('No models selected - Please select at least one model');
      return;
    }

    // Get current session at call time to avoid stale closures
    const session = currentSession;
    if (!session || !session.hasEndpoints) {
      setError('No endpoints available. Please wait for models to load.');
      console.warn('No endpoints available in current session');
      return;
    }
    
    try {
      setIsLoading(true);
      setError(null);

      console.log('Connecting to random endpoint with session:', session.id);

      // Random connect to any available endpoint in the session
      const endpointChoice = await apiService.chooseSessionEndpoint(session.id, null);
      console.log('Random endpoint chosen:', endpointChoice);
      
      // Only update if we're still using the same session (avoid race conditions)
      setCurrentSession(prev => {
        if (prev && prev.id === session.id) {
          return {
            ...prev,
            provider: endpointChoice.selected_provider,
            model: endpointChoice.selected_model,
            endpoint_id: endpointChoice.endpoint_id,
            api_key_hash: endpointChoice.api_key_hash,
            message: endpointChoice.message,
            lastUpdated: Date.now()
          };
        }
        return prev; // Don't update if session changed
      });

      setIsConnected(true);
      
      console.log(`Connected: ${endpointChoice.message}`);
      console.log(`Session ID: ${session.id}`);
      console.log(`Selected endpoint ID: ${endpointChoice.endpoint_id}`);
      
    } catch (error) {
      console.error('Connection failed:', error);
      
      // Handle session expiration - but avoid infinite loops
      if (error.isSessionExpired && currentSession?.id === session.id) {
        console.warn('Session expired during connection:', error.message);
        // Don't call handleSessionExpiration here to prevent loops
        setError('Session expired. Please try again.');
        setIsConnected(false);
        return;
      }
      
      setError(error.message);
      setIsConnected(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConnectToSpecificEndpoint = async (endpoint) => {
    // Get current session at call time to avoid stale closures
    const session = currentSession;
    if (!session) {
      setError('No active session');
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      
      console.log('Connecting to specific endpoint:', endpoint.name, 'with session:', session.id);
      
      // Connect to the specific endpoint using its ID
      const endpointChoice = await apiService.chooseSessionEndpoint(session.id, endpoint.id);
      
      // Only update if we're still using the same session (avoid race conditions)
      setCurrentSession(prev => {
        if (prev && prev.id === session.id) {
          return {
            ...prev,
            provider: endpointChoice.selected_provider,
            model: endpointChoice.selected_model,
            endpoint_id: endpointChoice.endpoint_id,
            api_key_hash: endpointChoice.api_key_hash,
            message: endpointChoice.message,
            lastUpdated: Date.now()
          };
        }
        return prev; // Don't update if session changed
      });

      setIsConnected(true);
      
      console.log(`Connected to specific endpoint: ${endpointChoice.message}`);
      
    } catch (error) {
      console.error('Error connecting to specific endpoint:', error);
      
      // Handle session expiration - but avoid infinite loops
      if (error.isSessionExpired && currentSession?.id === session.id) {
        console.warn('Session expired during specific endpoint connection:', error.message);
        // Don't call handleSessionExpiration here to prevent loops
        setError('Session expired. Please try again.');
        setIsConnected(false);
        return;
      }
      
      let errorMessage = 'Unknown error occurred';
      if (error.response && error.response.data) {
        errorMessage = JSON.stringify(error.response.data);
      } else if (error.message) {
        errorMessage = error.message;
      } else {
        errorMessage = String(error);
      }
      
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setIsConnected(false);
    
    // Clear connection info but keep session and endpoints
    setCurrentSession(prev => prev ? {
      ...prev,
      provider: "",
      model: "",
      endpoint_id: null,
      api_key_hash: null,
      message: "Disconnected",
      lastUpdated: Date.now()
    } : null);
    
    setError(null);
    setIsLoading(false);
    console.log('Disconnected from endpoint');
  };

  const handleRemoveModel = async (modelId) => {
    const updatedModels = selectedModels.filter(id => id !== modelId);
    console.log(`Model removed: ${MODEL_METADATA[modelId]?.name || modelId}`);
    await handleModelChange(updatedModels);
  };

  const sendMessage = async (prompt, isMultiTurn = false, conversationHistory = null, stateless = false, privacySettings = {}) => {
    if (!currentSession) {
      throw new Error('No active session. Please connect first.');
    }

    if (!prompt || prompt.trim() === '') {
      throw new Error('Message cannot be empty.');
    }

    try {
      setIsLoading(true);
      
      const response = await apiService.sendMessage(
        currentSession.id,
        prompt.trim(),
        userId,
        true, // streaming
        isMultiTurn,
        conversationHistory,
        stateless,
        privacySettings
      );

      console.log('Message sent successfully');
      return response;
      
    } catch (error) {
      console.error('Failed to send message:', error);
      
      // Handle session expiration
      if (error.isSessionExpired) {
        console.warn('Session expired:', error.message);
        
        // Create a user-friendly error with session expiration info
        const sessionExpiredError = new Error(error.message);
        sessionExpiredError.isSessionExpired = true;
        sessionExpiredError.requiresNewSession = true;
        sessionExpiredError.triggerSessionExpiration = async (isStatefulMode) => {
          await handleSessionExpiration(isStatefulMode);
        };
        throw sessionExpiredError;
      }
      
      if (error.message.includes('Session not found')) {
        await handleDisconnect();
      }
      
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const handleSessionExpiration = async (isStatefulMode = false) => {
    try {
      console.log('🔄 Session expired - creating new session...');
      
      // Prevent multiple simultaneous session recreations
      if (isLoading || isRecreatingSession) {
        console.log('⚠️ Session recreation already in progress, skipping...');
        return;
      }
      
      setIsLoading(true);
      setIsRecreatingSession(true);
      setError(null);
      
      // Show warning for stateful mode
      if (isStatefulMode) {
        const userConfirmed = window.confirm(
          "⚠️ PRIVACY WARNING\n\n" +
          "You are using stateful mode. Recreating a session and connecting to a new endpoint with your chat history might leak privacy.\n\n" +
          "Choose:\n" +
          "• OK: Create new session here (potential privacy risk)\n" +
          "• Cancel: Create a brand new session with the bottom right button (recommended)"
        );
        
        if (!userConfirmed) {
          // User chose to cancel - they should use the new session button
          // Disconnect and clear session to disable input
          setIsConnected(false);
          setCurrentSession(null);
          setError('Session expired. Please create a new session using the bottom right button for better privacy.');
          setIsLoading(false);
          setIsRecreatingSession(false);
          return;
        }
      }
      
      // Force disconnect and clear all state
      setIsConnected(false);
      setCurrentSession(null);
      
      // Wait a bit to ensure state is cleared
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Create a new session
      console.log('🔄 Creating new session...');
      const initResponse = await apiService.initializeSession(userId);
      const newSession = {
        id: initResponse.session_id,
        provider: "",
        model: "",
        endpoint_id: null,
        api_key_hash: null,
        message: "New session created due to expiration",
        hasEndpoints: false,
        lastUpdated: Date.now()
      };
      
      console.log('✅ New session created:', newSession.id);
      setCurrentSession(newSession);
      
      // If models were previously selected, update the new session
      if (selectedModels.length > 0) {
        console.log('🔄 Applying models to new session...');
        await handleSessionModelUpdateWithSession(selectedModels, newSession);
        
        // Note: Auto-connection removed to prevent infinite loops
        // User can manually connect if needed
        setError('Session recreated. Please connect manually.');
      }
      
      console.log('✅ Session recreation complete:', newSession.id);
      
    } catch (error) {
      console.error('Failed to create new session after expiration:', error);
      setError('Failed to create new session. Please refresh the page.');
    } finally {
      setIsLoading(false);
      setIsRecreatingSession(false);
    }
  };

  const handleSessionModelUpdateWithSession = async (newModels, sessionToUse = null) => {
    const session = sessionToUse || currentSession;
    
    if (!session) {
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      if (newModels.length === 0) {
        console.log('No models selected - clearing endpoints but keeping session');
        // Keep session but clear endpoint info
        setCurrentSession(prev => ({
          ...prev,
          provider: "",
          model: "",
          endpoint_id: null,
          api_key_hash: null,
          hasEndpoints: false,
          lastUpdated: Date.now()
        }));
        setIsConnected(false);
        return;
      }

      // Convert selected model IDs to "provider/model" string format for API
      const selectedModelsForAPI = newModels.map(modelId => {
        const modelString = modelMapping[modelId];
        if (!modelString) {
          throw new Error(`No backend mapping found for model: ${modelId}`);
        }
        return modelString;
      });

      console.log('Updating session models to create real endpoints:', selectedModelsForAPI, 'for session:', session.id);

      const updateResponse = await apiService.updateSessionModels(session.id, selectedModelsForAPI);
      
      console.log('Session model update response:', updateResponse);

      // Update session to indicate it now has endpoints available
      setCurrentSession(prev => ({
        ...prev,
        hasEndpoints: updateResponse.available_endpoints > 0,
        lastUpdated: Date.now()
      }));

      // If user was connected and models changed, they need to reconnect
      if (isConnected && updateResponse.needs_disconnection) {
        setIsConnected(false);
        setCurrentSession(prev => ({
          ...prev,
          provider: "",
          model: "",
          endpoint_id: null,
          api_key_hash: null,
          message: updateResponse.message
        }));
        
        console.log(`Session disconnected: ${updateResponse.message}`);
        console.log(`${updateResponse.available_endpoints} endpoints available for new selection`);
      }

    } catch (error) {
      console.error('Error updating session models:', error);
      
      // Handle session expiration
      if (error.isSessionExpired) {
        console.warn('Session expired during model update:', error.message);
        
        // Create a user-friendly error with session expiration info
        const sessionExpiredError = new Error(error.message);
        sessionExpiredError.isSessionExpired = true;
        sessionExpiredError.requiresNewSession = true;
        sessionExpiredError.triggerSessionExpiration = async (isStatefulMode) => {
          await handleSessionExpiration(isStatefulMode);
        };
        throw sessionExpiredError;
      }
      
      setError(`Failed to update session models: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const getSessionInfo = async () => {
    if (!currentSession) {
      return null;
    }

    try {
      const sessionInfo = await apiService.getSessionInfo(currentSession.id);
      return sessionInfo;
    } catch (error) {
      console.error('Failed to get session info:', error);
      return null;
    }
  };

  // Get available models that have backend mapping
  const getAvailableModels = () => {
    return Object.keys(MODEL_METADATA).filter(modelId => modelMapping[modelId]);
  };

  // Check if a model is available in the backend
  const isModelAvailable = (modelId) => {
    return !!modelMapping[modelId];
  };

  return {
    // State
    selectedModels,
    isConnected,
    currentSession,
    availableProviders,
    modelMapping,
    isLoading,
    error,
    
    // Actions
    handleModelChange,
    handleSessionModelUpdate,
    handleToggleConnection,
    handleConnect,
    handleConnectToSpecificEndpoint,
    handleDisconnect,
    handleRemoveModel,
    sendMessage,
    getSessionInfo,
    handleSessionExpiration,
    
    // Utilities
    setError,
    getAvailableModels,
    isModelAvailable,
    
    // State setters for advanced use cases (auto-connection)
    setCurrentSession,
    setIsConnected
  };
}; 