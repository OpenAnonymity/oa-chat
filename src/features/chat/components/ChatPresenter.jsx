import React, { useState, useEffect } from 'react';
import { ChevronRight, ChevronLeft, Lock, FileText, ChevronUp, ChevronDown, Trash2, Monitor, KeyRound, Cpu, Shield, BarChart3, Fingerprint, CheckCircle, Clock, AlertTriangle, Activity, Globe, Plus, Moon, Sun, X } from 'lucide-react';
import { Button } from '../../../shared/components/ui/button';
import { Input } from '../../../shared/components/ui/input';
import { Badge } from '../../../shared/components/ui/badge';
import { Label } from '../../../shared/components/ui/label';
import { Switch } from '../../../shared/components/ui/switch';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../../shared/components/ui/collapsible';
import { cn } from '../../../shared/utils';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import NewModelSelector from '../../../shared/components/NewModelSelector';
import { MODEL_METADATA } from '../../models';

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

// Status utility functions
const getStatusIcon = (status) => {
  switch (status) {
    case "Available": return <CheckCircle className="w-3 h-3 text-blue-500" />;
    case "Active": return <CheckCircle className="w-3 h-3 text-green-500" />;
    case "Standby": return <Clock className="w-3 h-3 text-yellow-500" />;
    case "Rate Limited": return <AlertTriangle className="w-3 h-3 text-orange-500" />;
    case "Needs Refresh": return <Activity className="w-3 h-3 text-red-500" />;
    default: return <Globe className="w-3 h-3" />;
  }
};

const getUsageLoadColor = (load) => {
  switch (load) {
    case "Low": return "text-green-500 dark:text-green-400";
    case "Medium": return "text-yellow-500 dark:text-yellow-400";
    case "High": return "text-red-500 dark:text-red-400";
    case "Optimal": return "text-blue-500 dark:text-blue-400";
    default: return "text-gray-500 dark:text-gray-400";
  }
};

// Theme Toggle Component
export const ThemeToggle = ({ showThemeToggle, isDarkMode, toggleTheme }) => (
  <div className={`fixed bottom-4 right-4 transition-opacity duration-300 z-50 ${showThemeToggle ? "opacity-100" : "opacity-0"}`}>
    <Button
      size="sm"
      onClick={toggleTheme}
      className="h-10 w-10 rounded-full bg-gray-200 dark:bg-gray-700 text-black dark:text-white border-3 border-black dark:border-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150"
    >
      {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
    </Button>
  </div>
);

// Header Components
export const MobileHeader = ({ 
  showMobileControls, 
  setShowMobileControls,
  statusInfo, 
  selectedModels,
  handleToggleConnection,
  handleModelChange,
  getAvailableModels,
  isModelAvailable,
  handleConnect,
  activeEndpoint,
  handleRemoveModel,
  isConnected
}) => (
  <div className="space-y-3">
    <div className="flex items-center justify-between">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowMobileControls(!showMobileControls)}
        className="h-8 px-3 text-black dark:text-white bg-gray-200 dark:bg-gray-700 border-3 border-black dark:border-white font-mono font-medium shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150 rounded-full"
      >
        <span className="flex items-center gap-1">
          controls
          {showMobileControls ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </span>
      </Button>
      <div className="text-right text-sm text-black dark:text-white font-medium" style={{ fontFamily: "Teachers, sans-serif" }}>
        <div className="font-bold">status:</div>
        <div>
          {statusInfo.proxyCount === 0 
            ? "loading proxy count..." 
            : selectedModels.length > 0
              ? `${statusInfo.proxyCount} proxies for selected models`
              : `${statusInfo.proxyCount} proxies available`}
        </div>
        <div className="mt-1 font-bold">connection summary:</div>
        <div>{statusInfo.connectionSummary}</div>
      </div>
    </div>
    
    {showMobileControls && (
      <div className="space-y-3 border-t border-black dark:border-gray-600 pt-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleConnection}
            className="h-8 px-2 text-black dark:text-white bg-gray-200 dark:bg-gray-700 border-3 border-black dark:border-white font-mono font-medium shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150 rounded-full"
          >
            {isConnected ? 'disconnect' : 'connect'}
          </Button>
          <NewModelSelector 
            selectedModels={selectedModels} 
            onChange={handleModelChange}
            availableModels={getAvailableModels()}
            isModelAvailable={isModelAvailable}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleConnect()}
            disabled={selectedModels.length === 0}
            className="h-8 px-3 text-black dark:text-white bg-gray-200 dark:bg-gray-700 border-3 border-black dark:border-white font-mono font-medium shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150 rounded-full"
            title={activeEndpoint ? `Connect via ${activeEndpoint.name}` : 'Connect'}
          >
            {activeEndpoint ? `connect via ${activeEndpoint.name.slice(-8)}` : 'connect'}
          </Button>
        </div>
        
        {selectedModels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {selectedModels.map(modelId => {
              const model = MODEL_METADATA[modelId];
              return (
                <Badge
                  key={modelId}
                  variant="outline"
                  className="bg-gray-200 dark:bg-gray-700 text-black dark:text-white border-2 border-black dark:border-white flex items-center gap-1 px-2 py-1 font-mono text-xs font-medium shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-0.5 active:translate-y-0.5 transition-all duration-150 cursor-pointer rounded-full"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-black dark:bg-white"></span>
                  {model?.name || modelId}
                  <X 
                    className="w-3 h-3 ml-1 text-black dark:text-white cursor-pointer" 
                    onClick={() => handleRemoveModel(modelId)}
                  />
                </Badge>
              );
            })}
          </div>
        )}
      </div>
    )}
  </div>
);

// Privacy Controls Component
export const PrivacyControls = ({ privacySettings, onPrivacyChange, isMultiTurn }) => (
  <div className="flex items-center gap-3 border-l border-gray-400 dark:border-gray-600 pl-4">
    <div className="flex items-center gap-2">
      <Shield className="w-3 h-3 text-gray-500 dark:text-gray-400" />
      <span className="text-xs text-black dark:text-white font-mono font-medium">Privacy:</span>
    </div>
    
    <div className="flex items-center gap-3">
      {/* PII Removal */}
      <div className="flex items-center gap-1">
        <Switch
          id="pii-removal-switch"
          checked={privacySettings.piiRemoval}
          onCheckedChange={(checked) => onPrivacyChange('piiRemoval', checked)}
          className="data-[state=checked]:bg-green-600 dark:data-[state=checked]:bg-green-500 data-[state=unchecked]:bg-gray-300 dark:data-[state=unchecked]:bg-gray-600 scale-75"
        />
        <Label
          htmlFor="pii-removal-switch"
          className={`text-xs font-mono font-medium whitespace-nowrap cursor-pointer ${
            privacySettings.piiRemoval ? 'text-green-600 dark:text-green-400 font-bold' : 'text-gray-500 dark:text-gray-400'
          }`}
        >
          PII
        </Label>
      </div>

      {/* Obfuscation */}
      <div className="flex items-center gap-1">
        <Switch
          id="obfuscation-switch"
          checked={privacySettings.obfuscate}
          onCheckedChange={(checked) => onPrivacyChange('obfuscate', checked)}
          className="data-[state=checked]:bg-blue-600 dark:data-[state=checked]:bg-blue-500 data-[state=unchecked]:bg-gray-300 dark:data-[state=unchecked]:bg-gray-600 scale-75"
        />
        <Label
          htmlFor="obfuscation-switch"
          className={`text-xs font-mono font-medium whitespace-nowrap cursor-pointer ${
            privacySettings.obfuscate ? 'text-blue-600 dark:text-blue-400 font-bold' : 'text-gray-500 dark:text-gray-400'
          }`}
        >
          Obf
        </Label>
      </div>

      {/* Decoy Generation - only for single-turn */}
      <div className="flex items-center gap-1">
        <Switch
          id="decoy-switch"
          checked={privacySettings.decoy && !isMultiTurn}
          onCheckedChange={(checked) => onPrivacyChange('decoy', checked)}
          disabled={isMultiTurn}
          className="data-[state=checked]:bg-purple-600 dark:data-[state=checked]:bg-purple-500 data-[state=unchecked]:bg-gray-300 dark:data-[state=unchecked]:bg-gray-600 disabled:opacity-50 scale-75"
        />
        <Label
          htmlFor="decoy-switch"
          className={`text-xs font-mono font-medium whitespace-nowrap cursor-pointer ${
            privacySettings.decoy && !isMultiTurn ? 'text-purple-600 dark:text-purple-400 font-bold' : 'text-gray-500 dark:text-gray-400'
          } ${isMultiTurn ? 'opacity-50' : ''}`}
        >
          Decoy
        </Label>
      </div>
    </div>
  </div>
);

export const DesktopHeader = ({ 
  handleToggleConnection,
  selectedModels,
  handleModelChange,
  getAvailableModels,
  isModelAvailable,
  isMultiTurn,
  setIsMultiTurn,
  statusInfo,
  privacySettings,
  onPrivacyChange,
  isConnected
}) => (
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={handleToggleConnection}
        className="h-8 px-3 text-black dark:text-white bg-gray-200 dark:bg-gray-700 border-3 border-black dark:border-white font-mono font-medium shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150 rounded-full"
      >
        {isConnected ? 'disconnect' : 'connect'}
      </Button>

      <NewModelSelector 
        selectedModels={selectedModels} 
        onChange={handleModelChange}
        availableModels={getAvailableModels()}
        isModelAvailable={isModelAvailable}
      />

      <div className="flex items-center gap-2 border-l border-gray-400 dark:border-gray-600 pl-4">
        <Label
          htmlFor="multi-turn-switch"
          className={`text-xs sans-serif font-medium whitespace-nowrap cursor-pointer ${
            !isMultiTurn ? 'text-black dark:text-white font-bold' : 'text-gray-500 dark:text-gray-400'
          }`}
        >
          Single-Turn
        </Label>
        <Switch
          id="multi-turn-switch"
          checked={isMultiTurn}
          onCheckedChange={setIsMultiTurn}
          className="data-[state=checked]:bg-black dark:data-[state=checked]:bg-white data-[state=unchecked]:bg-gray-300 dark:data-[state=unchecked]:bg-gray-600"
        />
        <Label
          htmlFor="multi-turn-switch"
          className={`text-xs sans-serif font-medium whitespace-nowrap cursor-pointer ${
            isMultiTurn ? 'text-black dark:text-white font-bold' : 'text-gray-500 dark:text-gray-400'
          }`}
        >
          Multi-Turn
        </Label>
      </div>

      <PrivacyControls 
        privacySettings={privacySettings}
        onPrivacyChange={onPrivacyChange}
        isMultiTurn={isMultiTurn}
      />
    </div>

    <div className="text-right text-sm text-black dark:text-white font-medium" style={{ fontFamily: "Teachers, sans-serif" }}>
      <div className="font-bold">status:</div>
      <div>
        {statusInfo.proxyCount === 0 
          ? "loading proxy count..." 
          : selectedModels.length > 0
            ? `${statusInfo.proxyCount} proxies for selected models`
            : `${statusInfo.proxyCount} proxies available`}
      </div>
      <div className="mt-1 font-bold">connection summary:</div>
      <div>{statusInfo.connectionSummary}</div>
    </div>
  </div>
);

// Model Selection Tags
export const ModelSelectionTags = ({ selectedModels, handleRemoveModel, isMobile }) => {
  if (selectedModels.length === 0 || isMobile) return null;

  return (
    <div className="flex flex-wrap gap-2 p-3 border-b border-black dark:border-gray-600">
      {selectedModels.map(modelId => {
        const model = MODEL_METADATA[modelId];
        return (
          <Badge
            key={modelId}
            variant="outline"
            className="bg-gray-200 dark:bg-gray-700 text-black dark:text-white border-3 border-black dark:border-white flex items-center gap-1 px-2 py-1 font-mono font-medium shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-0.5 active:translate-y-0.5 transition-all duration-150 cursor-pointer rounded-full"
          >
            <span className="w-2 h-2 rounded-full bg-black dark:bg-white"></span>
            {model?.name || modelId}
            <X 
              className="w-3 h-3 ml-1 text-black dark:text-white cursor-pointer" 
              onClick={() => handleRemoveModel(modelId)}
            />
          </Badge>
        );
      })}
    </div>
  );
};

// Previous Sessions Component
export const PreviousSessions = ({ 
  previousSessions, 
  showPreviousSessions, 
  setShowPreviousSessions,
  loadPreviousSession,
  deletePreviousSession
}) => {
  if (previousSessions.length === 0) return null;

  return (
    <Collapsible open={showPreviousSessions} onOpenChange={setShowPreviousSessions}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-between p-2 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800 border-b border-black dark:border-gray-600 font-mono font-medium"
        >
          <span className="flex items-center gap-2">
            <FileText className="w-4 h-4" />
            Previous Sessions ({previousSessions.length})
          </span>
          {showPreviousSessions ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-b border-black dark:border-gray-600">
        <div className="p-3 space-y-2 max-h-40 overflow-y-auto">
          {previousSessions.map((session) => (
            <div
              key={session.id}
              className="flex items-center justify-between p-2 bg-gray-200 dark:bg-gray-700 border-3 border-black dark:border-white shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] transition-all duration-150 rounded-lg"
            >
              <button
                onClick={() => loadPreviousSession(session)}
                className="flex-1 text-left text-sm text-black dark:text-white hover:text-gray-700 dark:hover:text-gray-300 font-mono font-medium"
              >
                <div className="font-bold">
                  {session.messages.length > 0 && session.messages[0]?.parts?.[0]?.text
                    ? session.messages[0].parts[0].text.substring(0, 50) + "..."
                    : "Empty session"}
                </div>
                <div className="text-xs text-gray-600 dark:text-gray-400">
                  {session.timestamp.toLocaleString()}
                </div>
              </button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => deletePreviousSession(session.id)}
                className="text-black dark:text-white hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 p-1"
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

// Connection Status
export const ConnectionStatus = ({ 
  connectionStatus, 
  isMultiTurn, 
  returnToCurrentSession 
}) => (
  <div 
    className="p-3 border-b border-black dark:border-gray-600 flex items-center justify-between cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
    onClick={returnToCurrentSession}
  >
    <div className="flex items-center gap-2">
      {connectionStatus.icon && (
        <connectionStatus.icon className={`w-4 h-4 ${connectionStatus.className}`} />
      )}
      <span className={`text-sm ${connectionStatus.className} font-mono font-medium`} style={{ fontFamily: "Teachers, sans-serif" }}>
        {connectionStatus.text}
      </span>
      <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded border ${
        isMultiTurn 
          ? 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 border-blue-300 dark:border-blue-700' 
          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-600'
      }`}>
        {isMultiTurn ? 'MULTI' : 'SINGLE'}
      </span>
    </div>
    <ChevronRight className="w-4 h-4 text-black dark:text-white" />
  </div>
);

// Privacy Thinking Process Component (o3-style animations)
const PrivacyThinkingProcess = ({ privacyMessages, isProcessingPrivacy }) => {
  const [visibleChars, setVisibleChars] = useState({});
  const [completedMessages, setCompletedMessages] = useState(new Set());

  // Typing animation effect for each message
  useEffect(() => {
    const intervals = [];
    
    privacyMessages.forEach((message, index) => {
      if (!completedMessages.has(message.id) && message.status !== 'processing') {
        const messageText = message.message;
        let charIndex = 0;
        
        const typeInterval = setInterval(() => {
          setVisibleChars(prev => ({
            ...prev,
            [message.id]: charIndex
          }));
          
          charIndex++;
          if (charIndex > messageText.length) {
            clearInterval(typeInterval);
            setCompletedMessages(prev => new Set([...prev, message.id]));
          }
        }, 30); // Typing speed - 30ms per character for better readability
        
        intervals.push(typeInterval);
      }
    });

    // Cleanup function to clear all intervals
    return () => {
      intervals.forEach(clearInterval);
    };
  }, [privacyMessages, completedMessages]);

  // Reset state when privacy processing starts
  useEffect(() => {
    if (isProcessingPrivacy && privacyMessages.length === 0) {
      setVisibleChars({});
      setCompletedMessages(new Set());
    }
  }, [isProcessingPrivacy, privacyMessages.length]);

  if (!isProcessingPrivacy && privacyMessages.length === 0) {
    return null;
  }

  return (
    <div className="my-3 space-y-2">
      {/* Processing initialization */}
      {isProcessingPrivacy && privacyMessages.length === 0 && (
        <div className="flex items-center gap-2 text-sm animate-fade-in">
          <span className="text-green-600 dark:text-green-400 mr-1">&gt;&gt;</span>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse-slow"></div>
            <span className="text-blue-600 dark:text-blue-400 font-mono animate-fade-in-blur">
              🔒 Initializing privacy features...
            </span>
          </div>
        </div>
      )}

      {/* Privacy messages with o3-style animations */}
      {privacyMessages.map((message, index) => (
        <div
          key={message.id}
          className="flex items-start gap-2 text-sm animate-slide-in-fade"
          style={{
            animationDelay: `${index * 200}ms`,
            opacity: message.status === 'processing' ? 1 : undefined
          }}
        >
          <span className="text-green-600 dark:text-green-400 mr-1">&gt;&gt;</span>
          
          <div className="flex items-center gap-2 flex-1">
            {/* Status indicator */}
            <div className={`w-2 h-2 rounded-full transition-all duration-300 ${
              message.status === 'completed' ? 'bg-green-500 animate-pulse-once' :
              message.status === 'processing' ? 'bg-blue-500 animate-pulse-slow' :
              message.status === 'skipped' ? 'bg-gray-400' :
              'bg-yellow-500'
            }`}></div>
            
            {/* Message text with typing animation */}
            <span className={`font-mono transition-all duration-200 ${
              message.status === 'completed' ? 'text-green-600 dark:text-green-400' :
              message.status === 'processing' ? 'text-blue-600 dark:text-blue-400' :
              message.status === 'skipped' ? 'text-gray-500 dark:text-gray-400' :
              'text-gray-500 dark:text-gray-400'
            }`}>
              {message.status === 'processing' ? (
                <span className="animate-fade-in-blur">
                  {message.message}
                  <span className="inline-block w-1 h-4 bg-current ml-1 animate-blink"></span>
                </span>
              ) : (
                <span>
                  {message.message.slice(0, visibleChars[message.id] || 0)}
                  {!completedMessages.has(message.id) && (
                    <span className="inline-block w-1 h-4 bg-current ml-1 animate-blink"></span>
                  )}
                </span>
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
};

// Message List
export const MessageList = ({ messages, isShredding, messagesEndRef, input, onInputChange, onSubmit, isConnected, isLoading, inputRef, currentSession, privacyMessages, isProcessingPrivacy }) => {
  console.log('MessageList render:', { messagesLength: messages?.length, isConnected, input });
  
  // Generate connection info for terminal-like display
  const getCurrentConnectionInfo = (isFirstConnect = false) => {
    if (!currentSession || !isConnected) return '';
    
    const modelName = currentSession.model || 'unknown';
    const endpointId = currentSession.endpoint_id ? String(currentSession.endpoint_id).slice(0, 8) : 'xxxxxxxx'; // First 8 characters
    
    if (isFirstConnect) {
      return `${modelName}@${endpointId}`;
    } else {
      // Shortened version for subsequent prompts
      return `${modelName.slice(0, 8)}@${endpointId.slice(0, 4)}`;
    }
  };

  // Check if this is a new session/endpoint compared to last message
  const isNewConnection = () => {
    if (!messages || messages.length === 0) return true;
    if (!currentSession || !currentSession.endpoint_id) return true;
    
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    
    // If no previous user message, this is definitely a new connection
    if (!lastUserMessage || !lastUserMessage.sessionInfo) return true;
    
    // Only consider it a new connection if the endpoint actually changed
    return lastUserMessage.sessionInfo.endpoint_id !== currentSession.endpoint_id;
  };
  
  if (!messages || messages.length === 0) {
    if (!isConnected) {
      // Show only welcome message when not connected
      return (
        <div className="flex-1 flex flex-col items-center justify-center font-mono">
          <div className="border-b-2 border-black dark:border-white w-16 mb-6"></div>
          <Lock className="w-8 h-8 mb-4 text-black dark:text-white" />
          <p className="text-black dark:text-white text-sm font-mono mb-2">begin your private conversation</p>
          <p className="text-gray-500 dark:text-gray-400 text-xs font-mono">
            encrypted • anonymous • ephemeral
          </p>
          <div className="border-b-2 border-black dark:border-white w-16 mt-6"></div>
        </div>
      );
    } else {
      // Show terminal input when connected but no messages yet
      return (
        <div className="flex-1 flex flex-col overflow-hidden font-mono">
          <div className="p-4">
            <form onSubmit={onSubmit} className="flex items-center gap-2">
              {/* Connection info for first connect */}
              {getCurrentConnectionInfo(true) && (
                <span className="text-green-600 dark:text-green-400 text-sm font-mono">
                  ✓ {getCurrentConnectionInfo(true)}
                </span>
              )}
              <span className="text-green-600 dark:text-green-400 text-lg font-semibold">$</span>
              <Input
                ref={inputRef}
                value={input || ''}
                onChange={onInputChange}
                placeholder="type your message..."
                className="flex-1 bg-transparent border-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 p-0 h-auto text-gray-800 dark:text-gray-300 placeholder:text-gray-500 dark:placeholder:text-gray-500 text-sm font-mono"
                disabled={isShredding || isLoading}
                autoFocus
              />
              <Button type="submit" className="hidden">
                Send
              </Button>
            </form>
          </div>
        </div>
      );
    }
  }
  
  return (
    <div className="flex-1 flex flex-col overflow-hidden font-mono">
      <div className="flex-1 overflow-y-auto p-4 space-y-3 chat-container">

              {messages.map((message, index) => (
          <div
            key={message.id}
            className={`flex flex-col text-sm ${isShredding ? "opacity-50 blur-sm" : ""} transition-all duration-300`}
          >
            {message.role === "user" && (
              <div className="flex text-gray-800 dark:text-gray-300">
                {/* Show stored connection info from when message was created */}
                {message.connectionInfo && (
                  <span className="text-green-600 dark:text-green-400 text-sm font-mono mr-1">
                    {message.connectionInfo}
                  </span>
                )}
                <span className="text-green-600 dark:text-green-400 mr-2">$</span>
                <span className="flex-1 whitespace-pre-wrap font-mono break-words">
                  {processTextContent(message.parts[0]?.text || "")}
                </span>
              </div>
            )}
          {message.role === "assistant" && (
            <div className="text-gray-900 dark:text-gray-200 break-words">
              {message.parts.map((part, i) => {
                if (part.type === "text") {
                  return (
                    <ReactMarkdown
                      key={i}
                      className="markdown-content font-mono text-sm prose prose-sm max-w-none dark:prose-invert break-words"
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeHighlight, rehypeKatex]}
                      components={{
                        p: ({children}) => <p className="whitespace-pre-wrap mb-2 last:mb-0 break-words">{children}</p>,
                        br: () => <br />,
                        hr: () => (
                          <div className="my-4 flex items-center justify-center">
                            <div className="border-b-2 border-black dark:border-white w-32"></div>
                          </div>
                        ),
                        code: ({className, children, ...props}) => {
                          const match = /language-(\w+)/.exec(className || '');
                          return match ? (
                            <code className={className} {...props}>
                              {children}
                            </code>
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
                        div: ({children, ...props}) => (
                          <div className="break-words" {...props}>
                            {children}
                          </div>
                        ),
                      }}
                    >
                      {part.text}
                    </ReactMarkdown>
                  );
                }
                return null;
              })}
            </div>
          )}
          {message.role === "error" && (
            <div className="text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">
              Error: {processTextContent(message.parts[0]?.text || "")}
            </div>
          )}
          {message.role === "system" && (
            <div className="text-blue-600 dark:text-blue-400 whitespace-pre-wrap break-words text-center py-2">
              {processTextContent(message.parts[0]?.text || "")}
            </div>
          )}
          {message.role === "thinking" && (
            <div className="my-3 space-y-2">
              {/* O3-style thinking animation matching privacy messages */}
              <div className="flex items-start gap-2 text-sm animate-slide-in-fade">
                <span className="text-green-600 dark:text-green-400 mr-1">&gt;&gt;</span>
                
                <div className="flex items-center gap-2 flex-1">
                  {/* Status indicator - animated dots */}
                  <div className="flex items-center">
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse mr-1"></div>
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse mr-1" style={{animationDelay: '0.2s'}}></div>
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" style={{animationDelay: '0.4s'}}></div>
                  </div>
                  
                  {/* Message text */}
                  <span className="text-blue-600 dark:text-blue-400 font-mono">
                    {message.message || "🤔 Processing raw response:"}
                  </span>
                </div>
              </div>
              
              {/* Thinking content with typing animation */}
              {message.parts[0]?.text && (
                <div className="flex items-start gap-2 text-sm ml-6">
                  <span className="text-gray-600 dark:text-gray-400 font-mono animate-fade-in-blur">
                    {processTextContent(message.parts[0]?.text)}
                    <span className="inline-block w-1 h-4 bg-gray-400 ml-1 animate-blink"></span>
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {/* Privacy Status Messages - Inline with messages, like ChatGPT o1 thinking */}
      {(isProcessingPrivacy || (privacyMessages && privacyMessages.length > 0)) && (
        <PrivacyThinkingProcess 
          privacyMessages={privacyMessages}
          isProcessingPrivacy={isProcessingPrivacy}
        />
      )}

      {/* Terminal input form - show at bottom when there are messages */}
        {messages.length > 0 && (
          <form onSubmit={onSubmit} className="flex items-center gap-2">
            {/* Show connection info - full if new connection, shortened if continuing */}
            {(() => {
              const isNewConn = isNewConnection();
              const connectionInfo = getCurrentConnectionInfo(isNewConn);
              if (!connectionInfo) return null;
              
              return (
                <span className="text-green-600 dark:text-green-400 text-sm font-mono">
                  {isNewConn ? `✓ ${connectionInfo}` : connectionInfo}
                </span>
              );
            })()}
            <span className="text-green-600 dark:text-green-400 text-lg font-semibold">$</span>
            <Input
              ref={inputRef}
              value={input}
              onChange={onInputChange}
              placeholder={
                !isConnected 
                  ? "connect to start chatting..." 
                  : "type your message..."
              }
              className="flex-1 bg-transparent border-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 p-0 h-auto text-gray-800 dark:text-gray-300 placeholder:text-gray-500 dark:placeholder:text-gray-500 text-sm font-mono"
              disabled={isShredding || !isConnected || isLoading}
              autoFocus
            />
            <Button type="submit" className="hidden">
              Send
            </Button>
          </form>
        )}
      
      <div ref={messagesEndRef} />
    </div>
  </div>
  );
};

// Chat Input (now integrated into MessageList for terminal-style interface)
export const ChatInput = React.forwardRef(({ 
  input, 
  onInputChange, 
  onSubmit, 
  isConnected, 
  isLoading, 
  isShredding, 
  isMultiTurn 
}, ref) => (
  <div className="p-4 border-t border-black dark:border-gray-600">
    {!isConnected && (
      <div className="mb-3 p-2 bg-yellow-100 dark:bg-yellow-900 border border-yellow-500 rounded text-yellow-800 dark:text-yellow-200 text-xs font-mono">
        Please select models and connect to start chatting
      </div>
    )}
    <form onSubmit={onSubmit} className="flex items-center gap-3">
      <Input
        ref={ref}
        value={input}
        onChange={onInputChange}
        placeholder={
          !isConnected 
            ? "Connect to start chatting..." 
            : isMultiTurn 
              ? "Type your message (multi-turn conversation)..." 
              : "Type your message (single turn)..."
        }
        className="bg-gray-200 dark:bg-gray-700 border-3 border-black dark:border-white text-black dark:text-white placeholder:text-gray-500 dark:placeholder:text-gray-400 focus-visible:ring-0 focus-visible:ring-offset-0 font-mono shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] focus:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:focus:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] transition-shadow rounded-lg"
        disabled={isShredding || !isConnected || isLoading}
      />
      <Button
        type="submit"
        disabled={!input.trim() || isShredding || !isConnected || isLoading}
        className="bg-black dark:bg-white hover:bg-gray-800 dark:hover:bg-gray-200 text-white dark:text-black border-3 border-black dark:border-white font-mono font-bold shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150"
      >
        {isLoading ? "..." : "Send"}
      </Button>
    </form>
  </div>
));

ChatInput.displayName = 'ChatInput';

// Helper function to check if an endpoint is active
const isEndpointActive = (activeEndpoint, endpoint) => {
  const isActiveById = activeEndpoint?.id === endpoint.id;
  const isActiveByHash = activeEndpoint?.api_key_hash === endpoint.api_key_hash && 
          activeEndpoint?.provider === endpoint.provider &&
                         activeEndpoint?.models_accessible === endpoint.models_accessible;
  
  return isActiveById || isActiveByHash;
};

// Sidebar Components
export const ProxyEndpoints = ({ 
  selectedModels, 
  proxyEndpoints, 
  activeEndpoint, 
  setActiveEndpoint, 
  handleConnectToSpecificEndpoint,
  isPreviewMode = false // Deprecated - always false now
}) => (
  <div className="p-4 border-b border-black dark:border-gray-600">
    <div className="border-2 border-black dark:border-white rounded-lg p-3 bg-gray-200 dark:bg-gray-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)]">
      <h3 className="text-xs text-black dark:text-white font-bold mb-3 font-mono flex items-center gap-2">
        <KeyRound className="w-3 h-3" />
        PROXY ENDPOINTS
      </h3>
      
      <div className="space-y-2">
        {selectedModels.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
            Select models to see available proxy endpoints
          </div>
        ) : proxyEndpoints.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
            Creating endpoints for selected models...
          </div>
        ) : (
          proxyEndpoints.map((endpoint) => (
            <button
              key={endpoint.id}
              onClick={() => {
                setActiveEndpoint(endpoint);
                handleConnectToSpecificEndpoint(endpoint);
              }}
              className={cn(
                "w-full text-left p-2.5 border-2 rounded-md transition-all duration-150 font-mono text-xs",
                "hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] dark:hover:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.3)]",
                isEndpointActive(activeEndpoint, endpoint)
                  ? "bg-black dark:bg-white text-white dark:text-black border-black dark:border-white shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)]"
                  : "bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-black dark:text-white",
              )}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-bold flex items-center gap-1.5">
                  {isEndpointActive(activeEndpoint, endpoint) ? (
                    <Monitor className="w-3.5 h-3.5 text-green-400 dark:text-green-500" />
                  ) : (
                    <KeyRound className="w-3.5 h-3.5" />
                  )}
                  endpoint-{endpoint.name.replace('endpoint-', '').slice(0, 6)}
                </span>
                <Badge
                  variant={isEndpointActive(activeEndpoint, endpoint) ? "default" : "secondary"}
                  className={cn(
                    "px-1.5 py-0.5 text-[10px] h-auto flex items-center gap-1",
                    isEndpointActive(activeEndpoint, endpoint)
                      ? "bg-green-500 text-black"
                      : "bg-gray-300 dark:bg-gray-600 text-black dark:text-white",
                  )}
                >
                  {getStatusIcon(endpoint.status)}
                  {endpoint.status.toUpperCase()}
                </Badge>
              </div>
              <div className="text-[11px] space-y-1">
                <div className="flex items-center gap-1.5">
                  <Cpu className="w-3 h-3 text-gray-500 dark:text-gray-400" />
                  <span className="text-gray-600 dark:text-gray-300">Provider:</span> {endpoint.provider}
                </div>
                <div className="flex items-center gap-1.5">
                  <Shield className="w-3 h-3 text-gray-500 dark:text-gray-400" />
                  <span className="text-gray-600 dark:text-gray-300">Access:</span> {endpoint.models_accessible}
                </div>
                <div className="flex items-center gap-1.5">
                  <BarChart3 className="w-3 h-3 text-gray-500 dark:text-gray-400" />
                  <span className="text-gray-600 dark:text-gray-300">Usage:</span>
                  <span className={getUsageLoadColor(endpoint.usage_load)}>{endpoint.usage_load}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Fingerprint className="w-3 h-3 text-gray-500 dark:text-gray-400" />
                  <span className="text-gray-600 dark:text-gray-300">Key:</span>
                  <span className="text-gray-500 dark:text-gray-400">{endpoint.api_key_hash}</span>
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  </div>
);

export const NetworkInfo = ({ statusInfo, selectedModels, isConnected, currentSession }) => {
  const getCurrentModelName = () => {
    if (currentSession) {
      const modelMetadata = MODEL_METADATA[currentSession.model];
      const displayName = modelMetadata ? modelMetadata.name : currentSession.model;
      return `${currentSession.provider}:${displayName}`;
    }
    if (selectedModels.length === 0) return "no model";
    if (selectedModels.length === 1) {
      const model = MODEL_METADATA[selectedModels[0]];
      return model?.name || selectedModels[0];
    }
    return `${selectedModels.length} models`;
  };

  return (
    <>
      <div className="p-4 border-b border-black dark:border-gray-600">
        <div className="border-2 border-black dark:border-white rounded-lg p-3 bg-gray-200 dark:bg-gray-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)]">
          <h3 className="text-xs text-black dark:text-white font-bold mb-3 font-mono flex items-center gap-2">
            <Activity className="w-3 h-3" />
            PROXY NETWORK
          </h3>
          <div className="text-xs text-black dark:text-white space-y-1 font-mono">
            <div className="flex justify-between">
              <span>available proxies:</span>
              <span className="text-green-500">
                {statusInfo.proxyCount === 0 ? "..." : statusInfo.proxyCount}
              </span>
            </div>
            <div className="flex justify-between">
              <span>selected models:</span>
              <span className="text-blue-500">{selectedModels.length}</span>
            </div>
            <div className="flex justify-between">
              <span>connection:</span>
              <span className={isConnected ? "text-green-500" : "text-red-500"}>
                {isConnected ? "active" : "inactive"}
              </span>
            </div>
            <div className="flex justify-between">
              <span>session status:</span>
              <span className="text-green-500">
                {currentSession ? "bound" : "pending"}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="p-4 border-b border-black dark:border-gray-600">
        <div className="border-2 border-black dark:border-white rounded-lg p-3 bg-gray-200 dark:bg-gray-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)]">
          <h3 className="text-xs text-black dark:text-white font-bold mb-3 font-mono flex items-center gap-2">
            <Globe className="w-3 h-3" />
            SESSION INFO
          </h3>
          <div className="text-xs text-black dark:text-white space-y-1 font-mono">
            <div className="flex justify-between">
              <span>model:</span>
              <span className="text-blue-500 truncate ml-2">
                {getCurrentModelName() || "none"}
              </span>
            </div>
            <div className="flex justify-between">
              <span>session id:</span>
              <span className="text-gray-500">
                {currentSession?.session_id ? `#${currentSession.session_id}` : "none"}
              </span>
            </div>
            <div className="flex justify-between">
              <span>tokens used:</span>
              <span className="text-green-500">-</span>
            </div>
            <div className="flex justify-between">
              <span>encryption:</span>
              <span className="text-green-500">TLS</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export const SessionActions = ({ 
  handleNewSession, 
  handleShredConversation,
  currentSessionMessages,
  isViewingPreviousSession,
  isShredding,
  isMobile,
  toggleRightPanel
}) => (
  <div className="p-4 space-y-3 flex-shrink-0 border-t border-black dark:border-gray-600">
    <Button
      onClick={handleNewSession}
      className="w-full bg-black dark:bg-white hover:bg-gray-800 dark:hover:bg-gray-200 text-white dark:text-black border-3 border-black dark:border-white font-mono font-bold shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150"
    >
      <Plus className="w-4 h-4 mr-2" />
      New Session
    </Button>

    {(currentSessionMessages.length > 0 || isViewingPreviousSession) && (
      <Button
        variant="outline"
        onClick={handleShredConversation}
        disabled={isShredding}
        className="w-full border-3 border-black dark:border-white text-black dark:text-white bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 font-mono font-bold shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150"
      >
        <Trash2 className="w-4 h-4 mr-2" />
        {isShredding ? "Shredding..." : "Shred Conversation"}
      </Button>
    )}

    {!isMobile && (
      <Button
        variant="outline"
        onClick={toggleRightPanel}
        className="w-full border-3 border-black dark:border-white text-black dark:text-white bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 font-mono font-bold shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150"
      >
        Hide Panel
      </Button>
    )}
  </div>
);

// Export PrivacyThinkingProcess component for use in main chat
export { PrivacyThinkingProcess };