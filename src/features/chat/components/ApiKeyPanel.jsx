import React, { useState } from 'react'; // removed useEffect for now
import { Button } from '../../../shared/components/ui/button';
import { Badge } from '../../../shared/components/ui/badge';
import { Input } from '../../../shared/components/ui/input';
import { 
  KeyRound, 
  Eye, 
  EyeOff, 
  Clock, 
  CheckCircle, 
  AlertTriangle,
  RefreshCw,
  TestTube,
  Trash2,
  ChevronDown,
  ChevronUp,
  // DollarSign // TODO: Uncomment when credits feature is enabled
} from 'lucide-react';
import { useApiKey, useInvitationCode } from '../../../shared/hooks';
// import apiKeyStore from '../../../shared/hooks/apiKeyStore'; // TODO: Uncomment when credits feature is enabled

/**
 * API Key Panel Component
 * Displays OpenRouter API key information, expiration, and management options
 */
export const ApiKeyPanel = ({ ticketUsed, onVerifyClick }) => {
  const {
    apiKey,
    apiKeyInfo,
    timeRemaining,
    isExpired,
    isLoading,
    error,
    hasApiKey,
    requestNewApiKey,
    renewApiKey,
    clearApiKey,
  } = useApiKey();
  
  const { hasTickets } = useInvitationCode();

  const [showKey, setShowKey] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifyContent, setVerifyContent] = useState('Hello');
  const [showVerifyInput, setShowVerifyInput] = useState(false);
  // const [credits, setCredits] = useState(null); // TODO: Uncomment when credits API is fixed
  // const [isLoadingCredits, setIsLoadingCredits] = useState(false);

  // TODO: Uncomment when OpenRouter credits API is fixed
  // Fetch credits when component mounts and API key exists
  // useEffect(() => {
  //   if (hasApiKey && apiKey) {
  //     fetchCredits();
  //   }
  // }, [hasApiKey, apiKey]);

  // const fetchCredits = async () => {
  //   setIsLoadingCredits(true);
  //   try {
  //     const creditsData = await apiKeyStore.fetchCredits();
  //     setCredits(creditsData);
  //   } catch (error) {
  //     console.error('Error fetching credits:', error);
  //   } finally {
  //     setIsLoadingCredits(false);
  //   }
  // };

  const handleRequestKey = async () => {
    try {
      await requestNewApiKey();
    } catch (error) {
      console.error('Failed to request API key:', error);
    }
  };

  const handleRenewKey = async () => {
    try {
      await renewApiKey();
    } catch (error) {
      console.error('Failed to renew API key:', error);
    }
  };

  const handleVerify = async () => {
    setIsVerifying(true);
    setVerifyResult(null);
    
    try {
      const result = await onVerifyClick(verifyContent, 50); // Allow more tokens for custom content
      setVerifyResult(result);
    } catch (error) {
      setVerifyResult({ valid: false, error: error.message });
    } finally {
      setIsVerifying(false);
    }
  };

  const maskApiKey = (key) => {
    if (!key) return '';
    return `${key.slice(0, 12)}...${key.slice(-8)}`;
  };

  return (
    <div className="p-4 border-b border-black dark:border-gray-600">
      <div className="border-2 border-black dark:border-white rounded-lg p-3 bg-gray-200 dark:bg-gray-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)]">
        <h3 className="text-xs text-black dark:text-white font-bold mb-3 font-mono flex items-center gap-2">
          <KeyRound className="w-3 h-3" />
          OPENROUTER API KEY
        </h3>

        {!hasApiKey ? (
          <div className="space-y-3">
            <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
              No API key provisioned
            </div>
            {/* Only show button if no tickets - otherwise AnimatedTicketVisualization handles it */}
            {!hasTickets && (
              <Button
                onClick={handleRequestKey}
                disabled={isLoading}
                className="w-full bg-black dark:bg-white hover:bg-gray-800 dark:hover:bg-gray-200 text-white dark:text-black border-3 border-black dark:border-white font-mono font-bold shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150"
              >
                {isLoading ? 'Requesting...' : 'Request API Key'}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {/* API Key Display */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-gray-600 dark:text-gray-300">Key:</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowKey(!showKey)}
                  className="h-auto p-1 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  {showKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </Button>
              </div>
              <div className="text-xs font-mono text-black dark:text-white break-all bg-gray-100 dark:bg-gray-800 p-2 rounded border border-gray-300 dark:border-gray-600">
                {showKey ? apiKey : maskApiKey(apiKey)}
              </div>
            </div>

            {/* Expiration Info */}
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-gray-600 dark:text-gray-300 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Expires in:
              </span>
              <Badge
                variant={isExpired ? "destructive" : "default"}
                className={`text-xs font-mono ${
                  isExpired 
                    ? 'bg-red-500 text-white' 
                    : 'bg-green-500 text-black'
                }`}
              >
                {timeRemaining || 'Loading...'}
              </Badge>
            </div>

            {/* TODO: Uncomment when OpenRouter credits API is fixed */}
            {/* Credits Info */}
            {/* <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-gray-600 dark:text-gray-300 flex items-center gap-1">
                <DollarSign className="w-3 h-3" />
                Credits Remaining:
              </span>
              {isLoadingCredits ? (
                <Badge className="text-xs font-mono bg-gray-400 text-white">
                  Loading...
                </Badge>
              ) : credits ? (
                <Badge
                  variant="default"
                  className={`text-xs font-mono ${
                    credits.remainingCredits < 1 
                      ? 'bg-red-500 text-white' 
                      : credits.remainingCredits < 5
                      ? 'bg-yellow-500 text-black'
                      : 'bg-blue-500 text-white'
                  }`}
                >
                  ${credits.remainingCredits.toFixed(2)}
                </Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={fetchCredits}
                  className="h-auto p-1 text-xs font-mono text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200"
                >
                  Check
                </Button>
              )}
            </div> */}

            {/* Key Name */}
            {apiKeyInfo?.name && (
              <div className="text-xs font-mono text-gray-600 dark:text-gray-300">
                Name: {apiKeyInfo.name}
              </div>
            )}

            {/* Station Info */}
            {apiKeyInfo?.station_name && (
              <div className="text-xs font-mono text-gray-600 dark:text-gray-300 flex items-center gap-1">
                <span className="text-blue-600 dark:text-blue-400">🏢</span>
                Station: {apiKeyInfo.station_name}
              </div>
            )}

            {/* Action Buttons */}
            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerify}
                disabled={isVerifying || isExpired}
                className="border-2 border-black dark:border-white text-black dark:text-white bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 font-mono text-xs font-bold shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-0.5 active:translate-y-0.5 transition-all duration-150"
              >
                <TestTube className="w-3 h-3 mr-1" />
                {isVerifying ? 'Testing...' : 'Verify'}
              </Button>
              
              <Button
                variant="outline"
                size="sm"
                onClick={handleRenewKey}
                disabled={isLoading}
                className="border-2 border-black dark:border-white text-black dark:text-white bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 font-mono text-xs font-bold shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-0.5 active:translate-y-0.5 transition-all duration-150"
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                Renew
              </Button>
              
              <Button
                variant="outline"
                size="sm"
                onClick={clearApiKey}
                disabled={isLoading}
                className="border-2 border-red-600 dark:border-red-400 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 font-mono text-xs font-bold shadow-[3px_3px_0px_0px_rgba(220,38,38,1)] dark:shadow-[3px_3px_0px_0px_rgba(248,113,113,1)] hover:shadow-[1px_1px_0px_0px_rgba(220,38,38,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(248,113,113,1)] active:shadow-[0px_0px_0px_0px_rgba(220,38,38,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(248,113,113,1)] active:translate-x-0.5 active:translate-y-0.5 transition-all duration-150"
              >
                <Trash2 className="w-3 h-3 mr-1" />
                Remove
              </Button>
            </div>

            {/* Custom Verify Content */}
            <div className="space-y-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowVerifyInput(!showVerifyInput)}
                className="w-full text-xs font-mono text-gray-600 dark:text-gray-400 hover:text-black dark:hover:text-white flex items-center justify-between"
              >
                <span>Customize verification message</span>
                {showVerifyInput ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </Button>
              
              {showVerifyInput && (
                <div className="space-y-2">
                  <Input
                    type="text"
                    value={verifyContent}
                    onChange={(e) => {
                      setVerifyContent(e.target.value);
                      setVerifyResult(null); // Clear previous result when content changes
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isVerifying && !isExpired) {
                        handleVerify();
                      }
                    }}
                    placeholder="Enter custom verification message..."
                    className="text-xs font-mono bg-gray-200 dark:bg-gray-700 border-2 border-black dark:border-white"
                  />
                  <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                    Tip: Try asking a simple question to test the API response
                  </div>
                </div>
              )}
            </div>

            {/* Verification Request Details */}
            {(isVerifying || verifyResult) && (
              <div className="space-y-2">
                {/* Request Being Sent */}
                <div className="text-xs font-mono p-2 rounded border border-gray-400 bg-gray-100 dark:bg-gray-800 overflow-hidden">
                  <div className="font-bold mb-1">📤 Verification Request:</div>
                  <div className="ml-2 space-y-1">
                    <div className="flex flex-wrap items-start">
                      <span className="text-gray-600 dark:text-gray-400 flex-shrink-0">URL:</span>
                      <span className="ml-1 break-all">https://openrouter.ai/api/v1/chat/completions</span>
                    </div>
                    <div className="flex items-start">
                      <span className="text-gray-600 dark:text-gray-400 flex-shrink-0">Model:</span>
                      <span className="ml-1">openai/gpt-3.5-turbo</span>
                    </div>
                    <div><span className="text-gray-600 dark:text-gray-400">Headers:</span></div>
                    <div className="ml-2 text-xs space-y-0.5">
                      <div className="break-all">Authorization: Bearer {maskApiKey(apiKey)}</div>
                      <div className="break-all">HTTP-Referer: {window.location.origin}</div>
                      <div>X-Title: OA-Station-WebApp</div>
                    </div>
                    <div><span className="text-gray-600 dark:text-gray-400">Body:</span></div>
                    <div className="ml-2 bg-black/5 dark:bg-white/5 p-1 rounded overflow-x-auto">
                      <pre className="text-[10px]">{JSON.stringify({
                        model: 'openai/gpt-3.5-turbo',
                        messages: [{ role: 'user', content: verifyContent }],
                        max_tokens: 50
                      }, null, 2)}</pre>
                    </div>
                  </div>
                </div>

                {/* Verification Result */}
                {verifyResult && (
                  <div className={`text-xs font-mono p-2 rounded border ${
                    verifyResult.valid 
                      ? 'bg-green-100 dark:bg-green-900 border-green-500 text-green-800 dark:text-green-200'
                      : 'bg-red-100 dark:bg-red-900 border-red-500 text-red-800 dark:text-red-200'
                  }`}>
                    <div className="flex items-start gap-1">
                      {verifyResult.valid ? (
                        <CheckCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                      ) : (
                        <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="w-full">
                        {verifyResult.valid ? (
                          <div>
                            <div className="font-bold">✓ API Key Valid</div>
                            <div className="mt-1 space-y-1">
                              <div>Response time: {verifyResult.duration}ms</div>
                              {verifyResult.usage && (
                                <div>Tokens used: {verifyResult.usage.total_tokens}</div>
                              )}
                              {verifyResult.requestContent && verifyResult.requestContent !== 'Hello' && (
                                <div className="mt-2">
                                  <div className="text-gray-600 dark:text-gray-400">Your message:</div>
                                  <div className="bg-black/5 dark:bg-white/5 p-1 rounded">
                                    "{verifyResult.requestContent}"
                                  </div>
                                </div>
                              )}
                              {verifyResult.response && (
                                <div className="mt-2">
                                  <div className="text-gray-600 dark:text-gray-400">Response:</div>
                                  <div className="bg-black/5 dark:bg-white/5 p-1 rounded mt-1">
                                    "{verifyResult.response}"
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className="font-bold">✗ Verification Failed</div>
                            <div className="mt-1">{verifyResult.error}</div>
                            {verifyResult.requestContent && verifyResult.requestContent !== 'Hello' && (
                              <div className="mt-2">
                                <div className="text-gray-600 dark:text-gray-400 text-xs">Attempted with:</div>
                                <div className="bg-black/5 dark:bg-white/5 p-1 rounded text-xs">
                                  "{verifyResult.requestContent}"
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Error Display */}
            {error && (
              <div className="text-xs font-mono text-red-600 dark:text-red-400 flex items-start gap-1">
                <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                <div>{error}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

