import { useState, useEffect } from 'react';
import apiService from '../../../shared/services/api';

/**
 * Custom hook for managing proxy endpoints from the current session
 */
export const useProxyEndpoints = (selectedModels, isConnected, currentSession) => {
  const [proxyEndpoints, setProxyEndpoints] = useState([]);
  const [activeEndpoint, setActiveEndpoint] = useState(null);
  const [statusInfo, setStatusInfo] = useState({
    proxyCount: 0,
    connectionSummary: "ad-hoc messaging"
  });
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Fetch proxy endpoints from current session
  useEffect(() => {
    const fetchProxyEndpoints = async () => {
      try {
        // Get current session at the time of call to avoid stale closures
        const session = currentSession;
        
        console.log('🔄 useProxyEndpoints: fetchProxyEndpoints triggered', {
          sessionId: session?.id,
          hasEndpoints: session?.hasEndpoints,
          isConnected,
          selectedModelsLength: selectedModels.length,
          refreshTrigger
        });
        
        let data = { endpoints: [], total_count: 0, active_count: 0 };
        
        if (session && session.hasEndpoints) {
          console.log('📡 Fetching real endpoints from session:', session.id);
          try {
            data = await apiService.getSessionEndpoints(session.id);
            console.log('✅ Fetched real endpoints:', data);
          } catch (error) {
            // Handle session expiration gracefully
            if (error.isSessionExpired) {
              console.warn('Session expired while fetching endpoints:', error.message);
              // Clear endpoints and let the parent component handle session recreation
              data = { endpoints: [], total_count: 0, active_count: 0 };
            } else {
              throw error; // Re-throw other errors
            }
          }
        } else if (selectedModels.length > 0 && session) {
          console.log('Models selected but endpoints not ready yet, waiting...');
          // Models are selected but endpoints not created yet - this is temporary state
          data = { 
            endpoints: [], 
            total_count: 0, 
            active_count: 0,
            message: "Creating endpoints for selected models..."
          };
        } else {
          console.log('No models selected, no endpoints available');
          setProxyEndpoints([]);
          setActiveEndpoint(null);
          return;
        }
        
        const newEndpoints = data.endpoints || [];
        setProxyEndpoints(newEndpoints);
        
        // Handle active endpoint selection
        if (isConnected && session && session.endpoint_id) {
          // Connected mode: Find the session's active endpoint
          let sessionEndpoint = newEndpoints.find(ep => ep.id === session.endpoint_id);
          
          // If not found by ID, try to match by api_key_hash + provider + model
          if (!sessionEndpoint && session.api_key_hash) {
            sessionEndpoint = newEndpoints.find(ep => 
              ep.api_key_hash === session.api_key_hash &&
              ep.provider === session.provider &&
              ep.models_accessible === session.model
            );
            console.log('Matched endpoint by api_key_hash:', sessionEndpoint?.name);
            }
          
          if (sessionEndpoint) {
            setActiveEndpoint(sessionEndpoint);
            console.log(`Set active endpoint for connected session: ${sessionEndpoint.name} (${sessionEndpoint.id})`);
          } else {
            console.warn(`Could not find session endpoint ${session.endpoint_id} in endpoint list`);
            setActiveEndpoint(null);
          }
        } else {
          // Not connected: Clear active endpoint
          setActiveEndpoint(null);
          console.log('Not connected - cleared active endpoint');
        }
        
      } catch (error) {
        console.error('Failed to fetch proxy endpoints:', error);
        setProxyEndpoints([]);
        setActiveEndpoint(null);
      }
    };

    fetchProxyEndpoints();
    
    // Poll for endpoint updates every 30 seconds
    const interval = setInterval(fetchProxyEndpoints, 30000);
    return () => clearInterval(interval);
  }, [currentSession?.id, currentSession?.hasEndpoints, currentSession?.endpoint_id, currentSession?.lastUpdated, selectedModels.length, isConnected, refreshTrigger]);

  // Fetch stats based on current session endpoints
  useEffect(() => {
    const fetchStats = async () => {
      try {
        // Get current session at the time of call to avoid stale closures
        const session = currentSession;
        let proxyCount = 0;
        
        if (session && session.hasEndpoints) {
          try {
            const sessionData = await apiService.getSessionEndpoints(session.id);
            proxyCount = sessionData.total_count || sessionData.endpoints?.length || 0;
          } catch (error) {
            if (error.isSessionExpired) {
              console.warn('Session expired while fetching stats:', error.message);
              proxyCount = 0; // Clear proxy count for expired session
            } else {
              console.warn('Failed to get session endpoint count:', error);
            }
          }
        } else if (selectedModels.length > 0) {
          proxyCount = 0; // Will be updated when endpoints are created
        }
        
          setStatusInfo(prev => ({
            ...prev,
          proxyCount: proxyCount
          }));

      } catch (error) {
        console.warn('Failed to fetch stats:', error);
      }
    };

    fetchStats();
    // Poll for stats updates every 30 seconds
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, [selectedModels.length, currentSession?.hasEndpoints, currentSession?.id]);

  // Update status info based on current session
  useEffect(() => {
    // Get current session at the time of call to avoid stale closures
    const session = currentSession;
    
    if (session && isConnected) {
      setStatusInfo(prev => ({
        ...prev,
        connectionSummary: `session #${session.id} - ${session.provider}:${session.model}`
      }));
    } else if (session) {
      setStatusInfo(prev => ({
        ...prev,
        connectionSummary: `session #${session.id} - ready`
      }));
    } else {
      setStatusInfo(prev => ({
        ...prev,
        connectionSummary: "no active session"
      }));
    }
  }, [currentSession, isConnected]);

  const handleSetActiveEndpoint = (endpoint) => {
    setActiveEndpoint(endpoint);
    console.log(`User manually selected endpoint: ${endpoint?.name} (${endpoint?.id})`);
  };

  const forceRefresh = () => {
    console.log('🚀 forceRefresh: Forcing proxy endpoints refresh', {
      sessionId: currentSession?.id,
      currentTrigger: refreshTrigger
    });
    setRefreshTrigger(prev => prev + 1);
  };

  return {
    proxyEndpoints,
    activeEndpoint,
    statusInfo,
    setActiveEndpoint: handleSetActiveEndpoint,
    forceRefresh,
    isPreviewMode: false, // No preview mode - these are always real endpoints
    previewSessionId: null
  };
};