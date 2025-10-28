/**
 * Simplified OA Chat Component
 * Direct integration with OpenRouter API - no sessions or proxy endpoints
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Lock, Send, Trash2, Moon, Sun, Plus } from 'lucide-react';
import { Button } from '../../shared/components/ui/button';
import { Input } from '../../shared/components/ui/input';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css'; // Ensure KaTeX CSS is loaded

import { useTheme } from '../theme/ThemeProvider';
import { useApiKey, useInvitationCode, useLocalStorage } from '../../shared/hooks';
import { useOAChat } from './hooks/useOAChat';
import { useChat } from './hooks/useChat';
// import apiKeyStore from '../../shared/hooks/apiKeyStore'; // TODO: Uncomment when credits API is fixed
// import { openRouterClient } from '../../shared/services';

import { InvitationCodeInput } from '../auth/InvitationCodeInput';
import { ApiKeyPanel } from './components/ApiKeyPanel';
import { TicketVisualization } from './components/TicketVisualization';
import { AnimatedTicketVisualization } from './components/AnimatedTicketVisualization';
import { OAModelSelector } from '../../shared/components/OAModelSelector';
import { PreviousSessions } from './components/ChatPresenter';

/**
 * Main Chat Container Component
 */
export const OAChat = () => {
  const { isDarkMode, toggleTheme } = useTheme();
  const [selectedModel, setSelectedModel] = useState('openai/gpt-4o');
  const [input, setInput] = useState('');
  const [isRightPanelVisible, setIsRightPanelVisible] = useState(true);
  const [showThemeToggle, setShowThemeToggle] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useLocalStorage('rightPanelWidth', 380); // Extracted to hook
  const [isResizing, setIsResizing] = useState(false);
  
  const inputRef = useRef(null);
  const messagesEndRef = useRef(null);
  const containerRef = useRef(null);
  
  const { 
    apiKey, 
    hasApiKey, 
    ticketUsed,
    verifyApiKey,
    requestNewApiKey,
    isLoading: isRequestingKey
  } = useApiKey();
  
  const { hasTickets, ticketCount, updateTicketCount } = useInvitationCode();
  const [localTicketCount, setLocalTicketCount] = useState(ticketCount);

  const chat = useChat();
  const oaChat = useOAChat(apiKey, selectedModel);

  // Sync local ticket count with the hook's value
  useEffect(() => {
    setLocalTicketCount(ticketCount);
  }, [ticketCount]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.messages]);

  // Update ticket count whenever hasApiKey changes or ticketCount changes in the hook
  useEffect(() => {
    updateTicketCount();
  }, [hasApiKey, ticketCount, updateTicketCount]);

  // Handle mouse move for theme toggle visibility
  const handleMouseMove = () => {
    setShowThemeToggle(true);
    const timer = setTimeout(() => setShowThemeToggle(false), 3000);
    return () => clearTimeout(timer);
  };

  // Handle resize
  const handleMouseDown = (e) => {
    e.preventDefault();
    setIsResizing(true);
  };

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  const handleMouseMoveResize = useCallback((e) => {
    if (!isResizing || !containerRef.current) return;
    
    const containerRect = containerRef.current.getBoundingClientRect();
    const newWidth = containerRect.right - e.clientX;
    
    // Set min/max width constraints
    const minWidth = 280;
    const maxWidth = 600;
    
    if (newWidth >= minWidth && newWidth <= maxWidth) {
      setRightPanelWidth(newWidth);
    }
  }, [isResizing, containerRef]);

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMoveResize);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      
      return () => {
        document.removeEventListener('mousemove', handleMouseMoveResize);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';
      };
    }
  }, [isResizing, handleMouseMoveResize, handleMouseUp]);

  /**
   * Process text content (handle escape sequences and LaTeX normalization)
   */
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
   * Normalize LaTeX delimiters for remark-math
   * Converts \(...\) to $...$ and \[...\] to $$...$$
   */
  const normalizeLatex = (text) => {
    if (!text) return '';
    return text
      .replace(/\\\((.*?)\\\)/g, '$$$1$$')  // Inline: \(...\) → $...$
      .replace(/\\\[(.*?)\\\]/gs, '$$$$$$$$1$$$$$$'); // Block: \[...\] → $$...$$
  };

  /**
   * Handle message submission
   */
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!input.trim()) return;
    if (!hasApiKey) {
      chat.addMessage({
        id: Date.now(),
        role: 'error',
        parts: [{ type: 'text', text: 'Please request an API key first' }]
      });
      return;
    }

    // Add user message
    const userMessage = {
      id: Date.now(),
      role: 'user',
      parts: [{ type: 'text', text: input }],
    };
    chat.addMessage(userMessage);
    
    const currentInput = input;
    setInput('');

    try {
      // Get conversation history for multi-turn
      const history = chat.isMultiTurn ? oaChat.getConversationHistory() : [];
      
      // Send message via OA Chat
      const stream = await oaChat.sendMessage(currentInput, history);
      
      // Process streaming response
      const assistantMessageId = Date.now() + 1;
      chat.addMessage({
        id: assistantMessageId,
        role: 'assistant',
        parts: [{ type: 'text', text: '' }],
        model: selectedModel,
      });

      let accumulatedText = '';
      for await (const chunk of stream) {
        if (chunk.choices && chunk.choices[0]?.delta?.content) {
          accumulatedText += chunk.choices[0].delta.content;
          chat.updateMessage(assistantMessageId, (msg) => ({
            ...msg,
            parts: [{ type: 'text', text: accumulatedText }],
          }));
        }
      }

      if (!accumulatedText) {
        chat.updateMessage(assistantMessageId, (msg) => ({
          ...msg,
          role: 'error',
          parts: [{ type: 'text', text: 'No response received from the model' }],
        }));
      }

      // TODO: Uncomment when OpenRouter credits API is fixed
      // Fetch updated credits after message completes
      // apiKeyStore.fetchCredits().catch(err => {
      //   console.log('Failed to fetch credits after message:', err);
      // });

    } catch (error) {
      console.error('Error sending message:', error);
      chat.addMessage({
        id: Date.now() + 2,
        role: 'error',
        parts: [{ type: 'text', text: `Error: ${error.message}` }],
      });
    }
  };

  /**
   * Handle API key verification
   */
  const handleVerifyApiKey = async (content = 'Hello', maxTokens = 10) => {
    try {
      const result = await verifyApiKey(content, maxTokens);
      return result;
    } catch (error) {
      return { valid: false, error: error.message };
    }
  };

  return (
    <div 
      ref={containerRef}
      className="h-screen max-h-screen flex flex-col bg-white dark:bg-gray-900 transition-colors duration-200 overflow-hidden"
      onMouseMove={handleMouseMove}
    >
      {/* Theme Toggle */}
      <div className={`fixed bottom-4 right-4 transition-opacity duration-300 z-50 ${showThemeToggle ? "opacity-100" : "opacity-0"}`}>
        <Button
          size="sm"
          onClick={toggleTheme}
          className="h-10 w-10 rounded-full bg-gray-200 dark:bg-gray-700 text-black dark:text-white border-3 border-black dark:border-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]"
        >
          {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </Button>
      </div>

      {/* Header */}
      <header className="border-b border-black dark:border-gray-600 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm font-mono font-bold text-black dark:text-white">
              OA Chat
            </span>
            <div className="ml-4">
              <OAModelSelector 
                value={selectedModel}
                onChange={setSelectedModel}
                disabled={!hasApiKey}
              />
            </div>
          </div>
          
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsRightPanelVisible(!isRightPanelVisible)}
            className="text-black dark:text-white"
          >
            {isRightPanelVisible ? 'Hide Panel' : 'Show Panel'}
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Main Chat Area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4">
            {chat.messages.length === 0 && !hasApiKey ? (
              <div className="flex flex-col items-center justify-center h-full font-mono">
                <div className="border-b-2 border-black dark:border-white w-16 mb-6"></div>
                <Lock className="w-8 h-8 mb-4 text-black dark:text-white" />
                <p className="text-black dark:text-white text-sm font-mono mb-2">
                  Chat Anonymously
                </p>
                <p className="text-gray-500 dark:text-gray-400 text-xs font-mono">
                  Register with invitation code → Request API key from a proxy node → Start chatting
                </p>
                <div className="border-b-2 border-black dark:border-white w-16 mt-6"></div>
              </div>
            ) : (
              <div className="space-y-3">
                {chat.messages.map((message) => (
                  <div key={message.id} className="flex flex-col text-sm">
                    {message.role === 'user' && (
                      <div className="flex text-gray-800 dark:text-gray-300">
                        <span className="text-green-600 dark:text-green-400 mr-2">$</span>
                        <span className="flex-1 whitespace-pre-wrap font-mono break-words">
                          {processTextContent(message.parts[0]?.text || '')}
                        </span>
                      </div>
                    )}
                    
                    {message.role === 'assistant' && (
                      <div className="text-gray-900 dark:text-gray-200 break-words">
                        <ReactMarkdown
                          className="markdown-content font-mono text-sm prose prose-sm max-w-none dark:prose-invert break-words"
                          remarkPlugins={[remarkGfm, remarkMath]}
                          rehypePlugins={[rehypeHighlight, rehypeKatex]}
                          components={{
                            p: ({children}) => <p className="whitespace-pre-wrap mb-2 last:mb-0 break-words">{children}</p>,
                            code: ({className, children, ...props}) => {
                              const match = /language-(\w+)/.exec(className || '');
                              return match ? (
                                <code className={className} {...props}>{children}</code>
                              ) : (
                                <code className="bg-gray-200 dark:bg-gray-700 px-1 py-0.5 rounded text-sm break-words" {...props}>
                                  {children}
                                </code>
                              );
                            },
                            pre: ({children}) => (
                              <pre className="bg-gray-100 dark:bg-gray-800 p-3 rounded-md overflow-x-auto mb-2 break-words">
                                {children}
                              </pre>
                            ),
                          }}
                        >
                          {normalizeLatex(message.parts[0]?.text || '')}
                        </ReactMarkdown>
                      </div>
                    )}
                    
                    {message.role === 'error' && (
                      <div className="text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">
                        {processTextContent(message.parts[0]?.text || '')}
                      </div>
                    )}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Input Area */}
          <div className="p-4 border-t border-black dark:border-gray-600">
            <form onSubmit={handleSubmit} className="flex items-center gap-3">
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={!hasApiKey ? "Request API key to start..." : "Type your message..."}
                disabled={!hasApiKey || oaChat.isLoading}
                className="bg-gray-200 dark:bg-gray-700 border-3 border-black dark:border-white text-black dark:text-white placeholder:text-gray-500 dark:placeholder:text-gray-400 focus-visible:ring-0 focus-visible:ring-offset-0 font-mono shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] focus:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:focus:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] transition-shadow rounded-lg"
              />
              <Button
                type="submit"
                disabled={!hasApiKey || !input.trim() || oaChat.isLoading}
                className="bg-black dark:bg-white hover:bg-gray-800 dark:hover:bg-gray-200 text-white dark:text-black border-3 border-black dark:border-white font-mono font-bold shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]"
              >
                <Send className="w-4 h-4" />
              </Button>
            </form>
          </div>
        </div>

        {/* Right Sidebar */}
        {isRightPanelVisible && (
          <>
            {/* Resize Handle */}
            <div
              className={`relative w-1.5 cursor-col-resize flex-shrink-0 group transition-all ${
                isResizing 
                  ? 'bg-blue-500 w-2' 
                  : 'bg-gray-300 dark:bg-gray-700 hover:bg-gray-400 dark:hover:bg-gray-600 hover:w-2'
              }`}
              onMouseDown={handleMouseDown}
              title="Drag to resize panel"
            >
              {/* Visual indicator */}
              <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 my-4">
                <div className="h-full flex flex-col justify-center space-y-1">
                  <div className="w-1 h-1 bg-gray-500 dark:bg-gray-400 rounded-full" />
                  <div className="w-1 h-1 bg-gray-500 dark:bg-gray-400 rounded-full" />
                  <div className="w-1 h-1 bg-gray-500 dark:bg-gray-400 rounded-full" />
                </div>
              </div>
            </div>
            
            {/* Panel Content */}
            <div 
              style={{ width: `${rightPanelWidth}px` }}
              className="border-l border-black dark:border-gray-600 flex flex-col overflow-hidden flex-shrink-0"
            >
              <div className="flex-1 overflow-y-auto">
              {/* Invitation Code Input - Always shown to allow adding more tickets */}
              <div className="p-4 border-b border-black dark:border-gray-600">
                <InvitationCodeInput />
              </div>

              {/* Animated Ticket Visualization - Show when no API key and tickets are available */}
              {!hasApiKey && hasTickets && (
                <AnimatedTicketVisualization 
                  onRequestApiKey={requestNewApiKey}
                  isRequesting={isRequestingKey}
                  ticketUsed={ticketUsed}
                />
              )}

              {/* No Tickets Info Panel - Show when no API key and no tickets */}
              {!hasApiKey && !hasTickets && (
                <div className="p-4 border-b border-black dark:border-gray-600">
                  <div className="border-2 border-dashed border-gray-400 dark:border-gray-600 rounded-lg p-4 text-center">
                    <p className="text-xs font-mono text-gray-500 dark:text-gray-400">
                      You have no inference tickets.
                    </p>
                    <p className="text-xs font-mono text-gray-500 dark:text-gray-400 mt-2">
                      Use an invitation code to get tickets first!
                    </p>
                  </div>
                </div>
              )}

              {/* API Key Panel */}
              {hasApiKey && (
                <ApiKeyPanel 
                  ticketUsed={ticketUsed}
                  onVerifyClick={handleVerifyApiKey}
                />
              )}

              {/* Static Ticket Visualization - Show after API key obtained */}
              {ticketUsed && hasApiKey && (
                <TicketVisualization ticketUsed={ticketUsed} />
              )}

              {/* Previous Sessions */}
              <PreviousSessions
                previousSessions={chat.previousSessions}
                showPreviousSessions={chat.showPreviousSessions}
                setShowPreviousSessions={chat.setShowPreviousSessions}
                loadPreviousSession={chat.loadPreviousSession}
                deletePreviousSession={chat.deletePreviousSession}
              />

              {/* Session Actions */}
              <div className="p-4 space-y-3 border-t border-black dark:border-gray-600">
                <Button
                  onClick={() => chat.startNewSession(null)}
                  className="w-full bg-black dark:bg-white hover:bg-gray-800 dark:hover:bg-gray-200 text-white dark:text-black border-3 border-black dark:border-white font-mono font-bold"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  New Session
                </Button>
                
                {chat.messages.length > 0 && (
                  <Button
                    variant="outline"
                    onClick={chat.handleShredConversation}
                    className="w-full border-3 border-black dark:border-white text-black dark:text-white bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 font-mono font-bold"
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Clear Chat
                  </Button>
                )}
              </div>
            </div>
          </div>
          </>
        )}
      </div>
    </div>
  );
};

export default OAChat;

