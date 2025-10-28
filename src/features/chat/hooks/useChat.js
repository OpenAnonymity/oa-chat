import { useState, useEffect, useRef } from 'react';

/**
 * Custom hook for chat functionality
 * Handles messages, input, sessions, and chat flow with single/multi-turn modes
 */
export const useChat = () => {
  // Core chat state
  const [messages, setMessages] = useState([]);
  const [currentSessionMessages, setCurrentSessionMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isShredding, setIsShredding] = useState(false);
  const [previousSessions, setPreviousSessions] = useState([]);
  const [showPreviousSessions, setShowPreviousSessions] = useState(false);
  const [isViewingPreviousSession, setIsViewingPreviousSession] = useState(false);
  const [viewedSessionId, setViewedSessionId] = useState(null);
  const [isMultiTurn, setIsMultiTurn] = useState(false);
  
  // Privacy settings state
  const [privacySettings, setPrivacySettings] = useState({
    piiRemoval: false,
    obfuscate: false,
    decoy: false
  });
  
  // Privacy status messages state (replacing fake decoy animation)
  const [privacyMessages, setPrivacyMessages] = useState([]);
  const [isProcessingPrivacy, setIsProcessingPrivacy] = useState(false);

  const inputRef = useRef(null);

  // Auto-scroll to bottom when messages change
  const messagesEndRef = useRef(null);
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, privacyMessages, isProcessingPrivacy]);

  // Handlers
  const handleInputChange = (e) => {
    setInput(e.target.value);
  };

  // Privacy settings handler
  const handlePrivacyChange = (setting, value) => {
    setPrivacySettings(prev => ({
      ...prev,
      [setting]: value
    }));
  };

  // Privacy status message handlers
  const addPrivacyMessage = (message) => {
    setPrivacyMessages(prev => [...prev, { ...message, id: Date.now() + Math.random() }]);
  };

  const clearPrivacyMessages = () => {
    setPrivacyMessages([]);
    setIsProcessingPrivacy(false);
  };

  const startPrivacyProcessing = () => {
    setIsProcessingPrivacy(true);
    setPrivacyMessages([]);
  };

  const addMessage = (message) => {
    setMessages(prev => [...prev, message]);
    setCurrentSessionMessages(prev => [...prev, message]);
  };

  const updateMessage = (messageId, updater) => {
    const updateFn = (prev) => prev.map(msg => 
      msg.id === messageId ? updater(msg) : msg
    );
    setMessages(updateFn);
    setCurrentSessionMessages(updateFn);
  };

  const removeMessage = (messageId) => {
    const removeFn = (prev) => prev.filter(msg => msg.id !== messageId);
    setMessages(removeFn);
    setCurrentSessionMessages(removeFn);
  };

  const clearInput = () => setInput('');

  const handleShredConversation = () => {
    setIsShredding(true);
    setTimeout(() => {
      if (isViewingPreviousSession && viewedSessionId) {
        setPreviousSessions((prev) => prev.filter((s) => s.id !== viewedSessionId));
        setIsViewingPreviousSession(false);
        setViewedSessionId(null);
        setMessages(currentSessionMessages);
      } else {
        setMessages([]);
        setCurrentSessionMessages([]);
      }
      setIsShredding(false);
    }, 1500);
  };

  const loadPreviousSession = (session) => {
    setMessages(JSON.parse(JSON.stringify(session.messages)));
    setIsViewingPreviousSession(true);
    setViewedSessionId(session.id);
    setShowPreviousSessions(false);
  };

  const returnToCurrentSession = () => {
    if (isViewingPreviousSession) {
      setMessages(currentSessionMessages);
      setIsViewingPreviousSession(false);
      setViewedSessionId(null);
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
        }
      }, 100);
    }
    if (showPreviousSessions) {
      setShowPreviousSessions(false);
    }
  };

  const deletePreviousSession = (sessionId) => {
    setPreviousSessions((prev) => prev.filter((s) => s.id !== sessionId));
  };

  const startNewSession = (currentSession) => {
    if (currentSessionMessages.length > 0) {
      const newSession = {
        id: Date.now().toString(),
        messages: JSON.parse(JSON.stringify(currentSessionMessages)),
        timestamp: new Date(),
        sessionInfo: currentSession ? { ...currentSession } : null,
        isMultiTurn: isMultiTurn
      };
      setPreviousSessions((prev) => [newSession, ...prev]);
    }
    
    setMessages([]);
    setCurrentSessionMessages([]);
    setIsViewingPreviousSession(false);
    setViewedSessionId(null);
  };

  const switchBackToCurrent = () => {
    if (isViewingPreviousSession) {
      setMessages(currentSessionMessages);
      setIsViewingPreviousSession(false);
      setViewedSessionId(null);
    }
  };



  // Toggle between single-turn and multi-turn modes
  const toggleMultiTurn = () => {
    setIsMultiTurn(prev => !prev);
  };

  // Get the stateless parameter for API calls
  const getStatelessMode = () => {
    return !isMultiTurn; // Single-turn = stateless, Multi-turn = stateful
  };

  return {
    // State
    messages,
    currentSessionMessages,
    input,
    isShredding,
    previousSessions,
    showPreviousSessions,
    isViewingPreviousSession,
    viewedSessionId,
    isMultiTurn,
    inputRef,
    messagesEndRef,
    
    // Privacy state
    privacySettings,
    privacyMessages,
    isProcessingPrivacy,

    // Setters
    setShowPreviousSessions,
    setIsMultiTurn,

    // Actions
    handleInputChange,
    handlePrivacyChange,
    addMessage,
    updateMessage,
    removeMessage,
    clearInput,
    handleShredConversation,
    loadPreviousSession,
    returnToCurrentSession,
    deletePreviousSession,
    startNewSession,
    switchBackToCurrent,
    toggleMultiTurn,
    
    // Privacy actions
    addPrivacyMessage,
    clearPrivacyMessages,
    startPrivacyProcessing,
    
    // Utility functions
    getStatelessMode,
  };
};