import React, { useState } from 'react';
import { Button } from '../../shared/components/ui/button';
import { Input } from '../../shared/components/ui/input';
import { KeyRound, AlertCircle, CheckCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useInvitationCode } from '../../shared/hooks';

/**
 * Invitation Code Input Component
 * Handles registration with invitation codes to obtain inference tickets
 */
export const InvitationCodeInput = () => {
  const { ticketCount, register, isRegistering, registrationError, registrationProgress } = useInvitationCode();
  const [invitationCode, setInvitationCode] = useState('');
  const [isExpanded, setIsExpanded] = useState(false); // Re-add the missing state

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!invitationCode.trim() || isRegistering) return;
    try {
      await register(invitationCode);
      setInvitationCode('');
    } catch (error) {
      // Error is handled in the hook, but you could add UI feedback here
      console.error('Registration failed:', error.message);
    }
  };

  return (
    <div className="space-y-3">
      {/* Collapsible Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center justify-between w-full text-sm font-mono text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800 p-2 rounded transition-colors"
      >
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4" />
          <span className="font-bold">Inference Tickets: {ticketCount}</span>
        </div>
        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {/* Registration Form - Collapsible */}
      {isExpanded && (
        <form onSubmit={handleSubmit} className="space-y-2">
        <Input
          value={invitationCode}
          onChange={(e) => setInvitationCode(e.target.value)}
          placeholder="Enter 24-char invitation code"
          maxLength={24}
          disabled={isRegistering}
          className="bg-gray-200 dark:bg-gray-700 border-3 border-black dark:border-white text-black dark:text-white placeholder:text-gray-500 dark:placeholder:text-gray-400 focus-visible:ring-0 focus-visible:ring-offset-0 font-mono text-sm shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] focus:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:focus:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] transition-shadow"
        />

        <Button
          type="submit"
          disabled={isRegistering || !invitationCode || invitationCode.trim().length !== 24}
          className="w-full bg-black dark:bg-white hover:bg-gray-800 dark:hover:bg-gray-200 text-white dark:text-black border-3 border-black dark:border-white font-mono font-bold shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150"
        >
          {isRegistering ? 'Registering...' : 'Register Code'}
        </Button>
      </form>
      )}

      {/* Registration Progress - Show when expanded */}
      {isExpanded && registrationProgress && (
        <div className="flex items-start gap-2 text-sm text-blue-600 dark:text-blue-400 font-mono">
          <div className="flex-shrink-0 mt-0.5">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
          </div>
          <div>
            <div>{registrationProgress.message}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {registrationProgress.percent}%
            </div>
          </div>
        </div>
      )}

      {/* Registration Error - Show when expanded */}
      {isExpanded && registrationError && (
        <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 font-mono">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>{registrationError}</div>
        </div>
      )}

      {/* Success Message - Show when expanded */}
      {isExpanded && !isRegistering && !registrationError && ticketCount > 0 && registrationProgress?.percent === 100 && (
        <div className="flex items-start gap-2 text-sm text-green-600 dark:text-green-400 font-mono">
          <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>Ready to request API key</div>
        </div>
      )}
    </div>
  );
};

