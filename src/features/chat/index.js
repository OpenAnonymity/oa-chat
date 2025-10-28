import React, { useEffect } from 'react';
import { ChevronRight, ChevronLeft, AlertCircle, CheckCircle, X } from "lucide-react";
import { Button } from '../../shared/components/ui/button';
import { cn } from '../../shared/utils';

// Business Logic Hooks
import { useChat } from './hooks/useChat';
import { useProxyEndpoints } from './hooks/useProxyEndpoints';
import { useUI } from './hooks/useUI';
import { useModelManagement } from '../../shared/hooks/useModelManagement';
import { useTheme } from '../theme/ThemeProvider';

// Presenter Components
import {
  ThemeToggle,
  MobileHeader,
  DesktopHeader,
  ModelSelectionTags,
  PreviousSessions,
  ConnectionStatus,
  MessageList,
  ChatInput,
  ProxyEndpoints,
  NetworkInfo,
  SessionActions,
  PrivacyThinkingProcess
} from './components/ChatPresenter';

// Utility function to process escape sequences
const processTextContent = (text) => {
  if (!text) return '';
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
};

/**
 * Chat Container Component
 * Handles all business logic and coordinates between hooks and presenters
 */
const ChatContainer = () => {
  // Business Logic Hooks
  const chat = useChat();
  const modelManagement = useModelManagement();
  const ui = useUI();
  const { isDarkMode, toggleTheme } = useTheme();
  const endpoints = useProxyEndpoints(
    modelManagement.selectedModels,
    modelManagement.isConnected,
    modelManagement.currentSession
  );

  // Auto-focus input when connected (but only if user isn't selecting text)
  useEffect(() => {
    if (modelManagement.isConnected && chat.inputRef.current) {
      setTimeout(() => {
        // Only focus if user isn't selecting text or interacting with content
        const selection = window.getSelection();
        const hasSelection = selection && selection.toString().length > 0;
        const isActivelySelecting = selection && !selection.isCollapsed;
        
        if (!hasSelection && !isActivelySelecting && document.activeElement !== chat.inputRef.current) {
          chat.inputRef.current.focus();
        }
      }, 500);
    }
  }, [modelManagement.isConnected, chat.inputRef]);

  // Terminal keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ctrl+L or Cmd+L: Clear terminal (like in real terminal)
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        chat.handleShredConversation();
        return;
      }

      // Ctrl+C or Cmd+C: Clear current input (if input is focused and has content)
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && chat.inputRef.current === document.activeElement && chat.input.length > 0) {
        e.preventDefault();
        chat.clearInput();
        return;
      }

      // Ctrl+D or Cmd+D: New session (like logout in terminal)
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault();
        handleNewSession();
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Message submission logic
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (chat.input.trim() === '') return;

    // Switch back to current session if viewing previous
    chat.switchBackToCurrent();
    modelManagement.setError(null);

    // Generate connection info for this message (using same format as terminal prompt)
    const generateConnectionInfo = () => {
      if (!modelManagement.currentSession || !modelManagement.isConnected) return null;
      
      const modelName = modelManagement.currentSession.model || 'unknown';
      const endpointId = modelManagement.currentSession.endpoint_id ? String(modelManagement.currentSession.endpoint_id).slice(0, 8) : 'xxxxxxxx';
      
      // Check if this is a new connection (first message or different endpoint)
      const lastUserMessage = chat.currentSessionMessages.filter(m => m.role === 'user').pop();
      const isNewConnection = !lastUserMessage || 
                             !lastUserMessage.sessionInfo || 
                             lastUserMessage.sessionInfo.endpoint_id !== modelManagement.currentSession.endpoint_id;
      
      if (isNewConnection) {
        return `✓ ${modelName}@${endpointId}`;
      } else {
        return `${modelName.slice(0, 8)}@${endpointId.slice(0, 4)}`;
      }
    };

    const userMessage = { 
      id: Date.now(), 
      role: "user", 
      parts: [{ type: "text", text: chat.input }],
      connectionInfo: generateConnectionInfo(),
      sessionInfo: modelManagement.currentSession ? { ...modelManagement.currentSession } : null
    };
    
    chat.addMessage(userMessage);
    const currentInput = chat.input;
    chat.clearInput();

    // Start privacy processing if any privacy features are enabled
    const hasPrivacyFeatures = chat.privacySettings.piiRemoval || chat.privacySettings.obfuscate || chat.privacySettings.decoy;
    if (hasPrivacyFeatures) {
      chat.startPrivacyProcessing();
    }

    // Declare thinking animation variables in function scope
    let thinkingMessageId = null; // Track thinking message ID directly
    let thinkingBuffer = ''; // Buffer for thinking text
    let thinkingTypingInterval = null; // Typing animation interval

    try {
        let messageToSend = currentInput;
        
        if (chat.isMultiTurn && chat.currentSessionMessages.length > 0) {
          const conversationContext = chat.currentSessionMessages
            .filter(msg => msg.role === "user" || msg.role === "assistant")
            .map(msg => {
              const roleLabel = msg.role === "user" ? "User" : "Assistant";
              const content = msg.parts[0]?.text || "";
              return `${roleLabel}: ${content}`;
            })
            .join('\n\n');
          
          messageToSend = `Previous conversation:\n${conversationContext}\n\nUser: ${currentInput}`;
        }

        // Prepare conversation history for API call
        let conversationHistory = null;
        if (chat.isMultiTurn && chat.currentSessionMessages.length > 0) {
          conversationHistory = chat.currentSessionMessages
            .filter(msg => msg.role === "user" || msg.role === "assistant")
            .map(msg => ({
              role: msg.role,
              content: msg.parts[0]?.text || ""
            }));
        }

        const streamResponse = await modelManagement.sendMessage(
          messageToSend,           // prompt
          chat.isMultiTurn,        // isMultiTurn
          conversationHistory,     // conversationHistory
          chat.getStatelessMode(), // stateless  
          chat.privacySettings     // privacySettings
        );
      
      let accumulatedText = '';
      let messageProvider = modelManagement.currentSession?.provider;
      let messageModel = modelManagement.currentSession?.model;
      let assistantMessage = null;
      const assistantMessageId = Date.now() + 1;

      for await (const chunk of streamResponse) {
        
        // Handle privacy status messages
        if (chunk.type === 'privacy_status') {
          chat.addPrivacyMessage(chunk);
          continue; // Skip to next chunk
        }
        
        // Handle response starting signal (clears privacy messages)
        if (chunk.type === 'response_starting') {
          console.log('Response starting - clearing privacy messages');
          chat.clearPrivacyMessages();
          continue; // Skip to next chunk
        }
        
        // Handle obfuscation thinking messages
        if (chunk.type === 'thinking') {
          if (chunk.stage === 'start') {
            // Create the thinking message box
            thinkingMessageId = Date.now() + 0.5; // Store the ID
            const thinkingMessage = {
              id: thinkingMessageId,
              role: "thinking",
              parts: [{ type: "text", text: "" }],
              message: chunk.message,
              provider: messageProvider,
              model: messageModel
            };
            chat.addMessage(thinkingMessage);
          } else if (chunk.stage === 'deobfuscating') {
            // Update thinking message using stored ID
            if (thinkingMessageId) {
              chat.updateMessage(thinkingMessageId, (msg) => ({
                ...msg,
                message: chunk.message
              }));
            }
            
            chat.addPrivacyMessage({
              type: 'privacy_status',
              stage: 'deobfuscation',
              message: chunk.message,
              status: 'processing'
            });
          }
          continue; // Skip to next chunk
        }
        
        // Handle thinking chunks (raw response streaming)
        if (chunk.type === 'thinking_chunk' && chunk.content) {
          const deltaText = processTextContent(chunk.content);
          
          // Add to thinking buffer instead of showing immediately
          if (thinkingMessageId) {
            thinkingBuffer += deltaText;
            
            // Start typing animation if not already running
            if (!thinkingTypingInterval) {
              let displayedLength = 0;
              
              thinkingTypingInterval = setInterval(() => {
                if (displayedLength < thinkingBuffer.length) {
                  // Speed up: type multiple characters at once for better performance
                  displayedLength = Math.min(displayedLength + 3, thinkingBuffer.length);
                  const displayText = thinkingBuffer.slice(0, displayedLength);
                  
                  chat.updateMessage(thinkingMessageId, (msg) => ({
                    ...msg,
                    parts: [{ type: "text", text: displayText }],
                    provider: chunk.provider || messageProvider,
                    model: chunk.model || messageModel
                  }));
                } else if (displayedLength >= thinkingBuffer.length && thinkingBuffer.length > 0) {
                  // Typing caught up with buffer, but keep interval running for new chunks
                  // We'll clear it when final chunk arrives
                }
              }, 15); // Much faster: 15ms interval, 3 chars at once = ~200 chars/second
            }
          }
          
          if (chunk.provider) messageProvider = chunk.provider;
          if (chunk.model) messageModel = chunk.model;
          continue; // Skip to next chunk
        }
        
        // Handle session disconnection message (for single-turn mode)
        if (chunk.type === 'session_disconnected') {
          console.log('Single-turn completed - session disconnected:', chunk.message);
          
          // Trigger disconnect to update UI state
          await modelManagement.handleDisconnect();
          
          continue; // Skip to next chunk
        }
        
        // Handle endpoints refresh message (for single-turn mode)
        if (chunk.type === 'endpoints_refreshed') {
          console.log('Single-turn completed - endpoints refreshed:', chunk.message);
          console.log('New endpoints received:', chunk.new_endpoints);
          console.log('Auto-selected endpoint:', chunk.auto_selected);
          
          // First disconnect to clear old state
          await modelManagement.handleDisconnect();
          
          // If there's an auto-selected endpoint, connect to it automatically
          if (chunk.auto_selected) {
            console.log('🚀 Auto-connecting to selected endpoint for seamless continuation');
            
            // Update session state with auto-selected endpoint
            const currentSession = modelManagement.currentSession;
            modelManagement.setCurrentSession({
              ...currentSession,
              provider: chunk.auto_selected.provider,
              model: chunk.auto_selected.model,
              endpoint_id: chunk.auto_selected.endpoint_id,
              api_key_hash: chunk.auto_selected.api_key_hash,
              message: `Auto-connected to ${chunk.auto_selected.provider}:${chunk.auto_selected.model}`,
              hasEndpoints: true,
              lastUpdated: Date.now()
            });
            
            // Set connected state
            modelManagement.setIsConnected(true);
            
            console.log(`✅ Auto-connected to ${chunk.auto_selected.provider}:${chunk.auto_selected.model}`);
          }
          
          // Force immediate refresh of proxy endpoints to show new list
          setTimeout(() => {
            endpoints.forceRefresh();
          }, 100); // Small delay to let the state updates propagate
          
          continue; // Skip to next chunk
        }
        
        // Handle endpoint refresh errors
        if (chunk.type === 'endpoints_refresh_error') {
          console.error('Single-turn endpoint refresh failed:', chunk.message);
          
          // Still trigger disconnect
          await modelManagement.handleDisconnect();
          
          // Add error message to chat
          const errorMessage = {
            id: Date.now() + 2,
            role: "error",
            parts: [{ type: "text", text: chunk.message }]
          };
          chat.addMessage(errorMessage);
          
          continue; // Skip to next chunk
        }
        
        // Handle final deobfuscated response (from obfuscation thinking process)
        if (chunk.type === 'final' && chunk.content) {
          const finalText = processTextContent(chunk.content);
          
          // Clean up thinking animation
          if (thinkingTypingInterval) {
            clearInterval(thinkingTypingInterval);
            thinkingTypingInterval = null;
          }
          
          // Remove thinking message and create new assistant message (keep original UX)
          if (thinkingMessageId) {
            // Remove the thinking message first
            chat.removeMessage(thinkingMessageId);
            
            // Wait a moment, then add final message at the bottom
            setTimeout(() => {
              const finalMessage = {
                id: assistantMessageId,
                role: "assistant",
                parts: [{ type: "text", text: finalText }],
                provider: chunk.provider || messageProvider,
                model: chunk.model || messageModel
              };
              chat.addMessage(finalMessage);
            }, 200); // Small delay to let state update
            
            // Set assistantMessage so we don't create duplicates
            assistantMessage = { id: assistantMessageId };
          } else {
            // No thinking message, create new assistant message
            const finalMessage = {
              id: assistantMessageId,
              role: "assistant",
              parts: [{ type: "text", text: finalText }],
              provider: chunk.provider || messageProvider,
              model: chunk.model || messageModel
            };
            chat.addMessage(finalMessage);
            assistantMessage = finalMessage;
          }
          
          // Mark as complete
          accumulatedText = finalText;
          
          if (chunk.provider) messageProvider = chunk.provider;
          if (chunk.model) messageModel = chunk.model;
          continue; // Skip to next chunk
        }
        
        // Handle content chunks (for regular streaming)
        if (chunk.content) {
          let deltaText = '';
          
          if (chunk.type === 'delta') {
            deltaText = processTextContent(chunk.content);
          } else if (chunk.type === 'done') {
            if (!accumulatedText) {
              deltaText = processTextContent(chunk.content);
            }
          } else if (chunk.type === 'chunk') {
            // For regular chunks, the content is the actual text (not a string to parse)
            deltaText = processTextContent(chunk.content);
          }
          
          if (deltaText) {
            accumulatedText += deltaText;
            const processedText = processTextContent(accumulatedText);
            
            if (!assistantMessage) {
              assistantMessage = {
                id: assistantMessageId,
                role: "assistant",
                parts: [{ type: "text", text: processedText }],
                provider: chunk.provider || messageProvider,
                model: chunk.model || messageModel
              };
              
              chat.addMessage(assistantMessage);
            } else {
              chat.updateMessage(assistantMessageId, (msg) => ({
                ...msg,
                parts: [{ type: "text", text: processedText }],
                provider: chunk.provider || messageProvider,
                model: chunk.model || messageModel
              }));
            }
          }
          
          if (chunk.provider) messageProvider = chunk.provider;
          if (chunk.model) messageModel = chunk.model;
        }
      }

        if (!accumulatedText) {
          const errorMessage = {
            id: assistantMessageId,
            role: "error",
            parts: [{ type: "text", text: "No response received from the model" }]
          };
          chat.addMessage(errorMessage);
        }

    } catch (error) {
      console.error('Error sending message:', error);
      
      // Clean up thinking animation if there's an error
      if (thinkingTypingInterval) {
        clearInterval(thinkingTypingInterval);
      }
      
      // Handle session expiration with user-friendly message
      if (error.isSessionExpired && error.requiresNewSession) {
        // Add a system message to the chat to inform the user
        const sessionExpiredMessage = {
          id: Date.now() + 3,
          role: "system",
          parts: [{ 
            type: "text", 
            text: `🔄 ${error.message}\n\nA new session has been created automatically. You can continue your conversation.` 
          }]
        };
        chat.addMessage(sessionExpiredMessage);
        
        // Trigger session recreation with stateful mode info
        if (error.triggerSessionExpiration) {
          try {
            await error.triggerSessionExpiration(chat.isMultiTurn);
          } catch (sessionError) {
            console.error('Error during session recreation:', sessionError);
            modelManagement.setError(sessionError.message);
          }
        }
        
        // Clear the error so the user can continue
        modelManagement.setError(null);
      } else {
        modelManagement.setError(error.message);
      }
    } finally {
      // Clean up thinking animation if it's still running
      if (thinkingTypingInterval) {
        clearInterval(thinkingTypingInterval);
      }
      
      // Clear privacy processing state after completion
      if (hasPrivacyFeatures) {
        chat.clearPrivacyMessages();
      }
      
      // Only refocus if user isn't selecting text
      setTimeout(() => {
        const selection = window.getSelection();
        const hasSelection = selection && selection.toString().length > 0;
        
        if (!hasSelection && chat.inputRef.current) {
          chat.inputRef.current.focus();
        }
      }, 100);
    }
  };

  // Session management
  const handleNewSession = async () => {
    chat.startNewSession(modelManagement.currentSession);
    
    if (modelManagement.isConnected) {
      await modelManagement.handleDisconnect();
      setTimeout(() => {
        if (modelManagement.selectedModels.length > 0) {
          modelManagement.handleConnect();
        }
      }, 500);
    }
  };

  // Connection status
  const getConnectionStatus = () => {
    if (modelManagement.error) {
      return { text: `Error: ${modelManagement.error}`, icon: AlertCircle, className: "text-red-500" };
    }
    if (modelManagement.isLoading) {
      return { text: "connecting...", icon: null, className: "text-yellow-500" };
    }
    if (modelManagement.isConnected && modelManagement.currentSession) {
      return { 
        text: `connected to ${modelManagement.currentSession.provider}:${modelManagement.currentSession.model}`, 
        icon: CheckCircle, 
        className: "text-green-500" 
      };
    }
    return { text: "disconnected", icon: X, className: "text-red-500" };
  };

  const connectionStatus = getConnectionStatus();

  return (
    <div
      className="h-screen max-h-screen flex flex-col bg-white dark:bg-gray-900 transition-colors duration-200 overflow-hidden"
      onMouseMove={ui.handleMouseMove}
    >
      <ThemeToggle 
        showThemeToggle={ui.showThemeToggle}
        isDarkMode={isDarkMode}
        toggleTheme={toggleTheme}
      />
      
      <header className="border-b border-black dark:border-gray-600 p-3">
        {ui.isMobile ? (
          <MobileHeader 
            showMobileControls={ui.showMobileControls}
            setShowMobileControls={ui.setShowMobileControls}
            statusInfo={endpoints.statusInfo}
            selectedModels={modelManagement.selectedModels}
            handleToggleConnection={modelManagement.handleToggleConnection}
            handleModelChange={modelManagement.handleModelChange}
            getAvailableModels={modelManagement.getAvailableModels}
            isModelAvailable={modelManagement.isModelAvailable}
            handleConnect={modelManagement.handleConnect}
            activeEndpoint={endpoints.activeEndpoint}
            handleRemoveModel={modelManagement.handleRemoveModel}
            isConnected={modelManagement.isConnected}
          />
        ) : (
          <DesktopHeader 
            handleToggleConnection={modelManagement.handleToggleConnection}
            selectedModels={modelManagement.selectedModels}
            handleModelChange={modelManagement.handleModelChange}
            getAvailableModels={modelManagement.getAvailableModels}
            isModelAvailable={modelManagement.isModelAvailable}
            isMultiTurn={chat.isMultiTurn}
            setIsMultiTurn={chat.setIsMultiTurn}
            statusInfo={endpoints.statusInfo}
            privacySettings={chat.privacySettings}
            onPrivacyChange={chat.handlePrivacyChange}
            isConnected={modelManagement.isConnected}
          />
        )}
      </header>
      
      <ModelSelectionTags 
        selectedModels={modelManagement.selectedModels}
        handleRemoveModel={modelManagement.handleRemoveModel}
        isMobile={ui.isMobile}
      />

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Main chat area */}
        <div 
          className={cn(
            "flex flex-col overflow-hidden",
            !ui.isMobile && ui.isRightPanelVisible && "border-r border-gray-300 dark:border-gray-600"
          )}
          style={{ 
            width: ui.isMobile ? '100%' : (ui.isRightPanelVisible ? `${ui.leftPanelWidth}%` : '100%'),
            flexShrink: 0
          }}
          onClick={(e) => {
            // Only focus if clicking on empty space, not on text or interactive elements
            const selection = window.getSelection();
            const hasSelection = selection && selection.toString().length > 0;
            const isClickingOnText = e.target.tagName === 'P' || e.target.tagName === 'SPAN' || e.target.tagName === 'CODE' || e.target.tagName === 'PRE';
            
            if (!hasSelection && !isClickingOnText && chat.inputRef.current) {
              chat.inputRef.current.focus();
            }
          }}
        >
          <PreviousSessions 
            previousSessions={chat.previousSessions}
            showPreviousSessions={chat.showPreviousSessions}
            setShowPreviousSessions={chat.setShowPreviousSessions}
            loadPreviousSession={chat.loadPreviousSession}
            deletePreviousSession={chat.deletePreviousSession}
          />
          
          <ConnectionStatus 
            connectionStatus={connectionStatus}
            isMultiTurn={chat.isMultiTurn}
            returnToCurrentSession={chat.returnToCurrentSession}
          />
          
          <MessageList
            messages={chat.messages}
            isShredding={chat.isShredding}
            messagesEndRef={chat.messagesEndRef}
            input={chat.input}
            onInputChange={chat.handleInputChange}
            onSubmit={handleSubmit}
            isConnected={modelManagement.isConnected}
            isLoading={modelManagement.isLoading}
            inputRef={chat.inputRef}
            currentSession={modelManagement.currentSession}
            privacyMessages={chat.privacyMessages}
            isProcessingPrivacy={chat.isProcessingPrivacy}
          />
        </div>

        {/* Resizable Divider - Desktop only */}
        {!ui.isMobile && ui.isRightPanelVisible && (
          <div
            className="w-1 bg-gray-300 dark:bg-gray-600 cursor-col-resize hover:bg-gray-400 dark:hover:bg-gray-500 transition-colors flex items-center justify-center group relative"
            onMouseDown={ui.handlePanelResize}
          >
            <div className="absolute inset-0 -left-1 -right-1" />
          </div>
        )}

        {/* Right sidebar */}
        {((ui.isMobile && ui.isRightPanelVisible) || (!ui.isMobile && ui.isRightPanelVisible)) && (
          <div className={cn(
            "flex flex-col overflow-hidden",
            ui.isMobile ? "fixed inset-y-0 right-0 w-80 bg-white dark:bg-gray-900 z-40" : "flex-1"
          )}>
            {ui.isMobile && (
              <div className="p-3 border-b border-black dark:border-gray-600 flex items-center justify-between flex-shrink-0">
                <h2 className="text-sm font-bold text-black dark:text-white font-mono">Panel</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={ui.toggleRightPanel}
                  className="text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            )}
            
            <div className="flex-1 overflow-y-auto">
              <ProxyEndpoints 
                selectedModels={modelManagement.selectedModels}
                proxyEndpoints={endpoints.proxyEndpoints}
                activeEndpoint={endpoints.activeEndpoint}
                setActiveEndpoint={endpoints.setActiveEndpoint}
                handleConnectToSpecificEndpoint={modelManagement.handleConnectToSpecificEndpoint}
                isPreviewMode={endpoints.isPreviewMode}
              />
              
              <NetworkInfo 
                statusInfo={endpoints.statusInfo}
                selectedModels={modelManagement.selectedModels}
                isConnected={modelManagement.isConnected}
                currentSession={modelManagement.currentSession}
              />
            </div>
            
            <SessionActions 
              handleNewSession={handleNewSession}
              handleShredConversation={chat.handleShredConversation}
              currentSessionMessages={chat.currentSessionMessages}
              isViewingPreviousSession={chat.isViewingPreviousSession}
              isShredding={chat.isShredding}
              isMobile={ui.isMobile}
              toggleRightPanel={ui.toggleRightPanel}
            />
          </div>
        )}

        {/* Show panel buttons when hidden */}
        {!ui.isRightPanelVisible && (
          <>
            {!ui.isMobile && (
              <Button
                onClick={ui.toggleRightPanel}
                className="fixed top-1/2 right-4 transform -translate-y-1/2 bg-black dark:bg-white hover:bg-gray-800 dark:hover:bg-gray-200 text-white dark:text-black border-3 border-black dark:border-white font-mono font-bold shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150 z-10"
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            )}
            
            {ui.isMobile && (
              <div 
                className="fixed bottom-20 right-4 transition-opacity duration-300 z-10 group"
                onMouseEnter={() => ui.setShowMobileControls(true)}
                onMouseLeave={() => ui.setShowMobileControls(false)}
              >
                <Button onClick={ui.toggleRightPanel} className="h-4 w-4 p-0">
                  <ChevronLeft className="h-full w-full" />
                </Button>
                
                <div className={cn(
                  "absolute bottom-full right-0 mb-2 px-2 py-1 bg-black dark:bg-white text-white dark:text-black text-xs rounded whitespace-nowrap transition-opacity duration-200",
                  ui.showMobileControls ? "opacity-100" : "opacity-0 pointer-events-none"
                )}>
                  Show Panel
                </div>
              </div>
            )}
          </>
        )}

        {/* Mobile backdrop when panel is open */}
        {ui.isMobile && ui.isRightPanelVisible && (
          <div 
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-30"
            onClick={ui.toggleRightPanel}
          />
        )}
      </div>
    </div>
  );
};

// Compound Component Pattern - Export main Chat with sub-components
export const Chat = ChatContainer;

// Export individual components for flexibility
Chat.Container = ChatContainer;
Chat.ThemeToggle = ThemeToggle;
Chat.MobileHeader = MobileHeader;
Chat.DesktopHeader = DesktopHeader;
Chat.ModelSelectionTags = ModelSelectionTags;
Chat.PreviousSessions = PreviousSessions;
Chat.ConnectionStatus = ConnectionStatus;
Chat.MessageList = MessageList;
Chat.ChatInput = ChatInput;
Chat.ProxyEndpoints = ProxyEndpoints;
Chat.NetworkInfo = NetworkInfo;
Chat.SessionActions = SessionActions;

export default Chat;