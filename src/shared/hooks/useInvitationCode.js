/**
 * Custom hook for handling invitation code registration
 */

import { useState, useCallback, useEffect } from 'react';
import stationClient from '../services/station';

export const useInvitationCode = () => {
  const [isRegistering, setIsRegistering] = useState(false);
  const [registrationError, setRegistrationError] = useState(null);
  const [registrationProgress, setRegistrationProgress] = useState(null);
  const [ticketCount, setTicketCount] = useState(0);

  // Update ticket count on mount and after registration
  const updateTicketCount = useCallback(() => {
    const count = stationClient.getTicketCount();
    console.log('🎫 useInvitationCode: Updating ticket count:', count);
    setTicketCount(count);
  }, []);

  // Initialize ticket count
  useEffect(() => {
    updateTicketCount();
  }, [updateTicketCount]);

  // Listen for API key changes to update ticket count
  useEffect(() => {
    const handleApiKeyChange = () => {
      // The store now drives state, but we still need to update ticket count
      updateTicketCount();
    };
    
    const handleApiKeyCleared = () => {
      updateTicketCount();
    };

    const onTicketsUpdated = () => {
      updateTicketCount();
    };
    
    // These events are dispatched from the apiKeyStore and station client now
    window.addEventListener('apikey-changed', handleApiKeyChange);
    window.addEventListener('apikey-cleared', handleApiKeyCleared);
    window.addEventListener('tickets-updated', onTicketsUpdated);
    
    return () => {
      window.removeEventListener('apikey-changed', handleApiKeyChange);
      window.removeEventListener('apikey-cleared', handleApiKeyCleared);
      window.removeEventListener('tickets-updated', onTicketsUpdated);
    };
  }, [updateTicketCount]);

  /**
   * Register with an invitation code
   */
  const register = useCallback(async (invitationCode) => {
    setIsRegistering(true);
    setRegistrationError(null);
    setRegistrationProgress({ message: 'Starting registration...', percent: 0 });

    try {
      const result = await stationClient.alphaRegister(
        invitationCode,
        (message, percent) => {
          setRegistrationProgress({ message, percent });
        }
      );

      setRegistrationProgress({ message: 'Success!', percent: 100 });
      updateTicketCount();

      return result;
    } catch (error) {
      setRegistrationError(error.message);
      throw error;
    } finally {
      setIsRegistering(false);
      // Clear progress after a delay
      setTimeout(() => {
        setRegistrationProgress(null);
      }, 2000);
    }
  }, [updateTicketCount]);

  /**
   * Clear all tickets
   */
  const clearTickets = useCallback(() => {
    stationClient.clearTickets();
    updateTicketCount();
  }, [updateTicketCount]);

  return {
    // State
    isRegistering,
    registrationError,
    registrationProgress,
    ticketCount,
    hasTickets: ticketCount > 0,

    // Actions
    register,
    clearTickets,
    updateTicketCount,
  };
};

