import React, { useState, useEffect } from 'react';
import { Ticket, ArrowRight, CheckCircle, KeyRound } from 'lucide-react';
import { useInvitationCode } from '../../../shared/hooks';
import stationClient from '../../../shared/services/station';

/**
 * Animated Ticket Visualization Component
 * Shows the current ticket and animates the transformation process
 */
export const AnimatedTicketVisualization = ({ 
  onRequestApiKey, 
  isRequesting, 
  ticketUsed 
}) => {
  const { ticketCount } = useInvitationCode();
  const [currentTicket, setCurrentTicket] = useState(null);
  const [showFinalized, setShowFinalized] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [ticketIndex, setTicketIndex] = useState(0);

  // Load the next ticket
  useEffect(() => {
    const loadNextTicket = () => {
      // Get all tickets to show the next one
      const tickets = stationClient.tickets;
      if (tickets && tickets.length > 0) {
        // Find the next unused ticket
        const nextUnused = tickets.findIndex(t => !t.used);
        if (nextUnused !== -1) {
          setCurrentTicket(tickets[nextUnused]);
          setTicketIndex(nextUnused);
        } else {
          setCurrentTicket(null);
        }
      }
    };

    loadNextTicket();
    // Reset state when ticket count changes
    setShowFinalized(false);
    setIsTransitioning(false);
  }, [ticketCount, ticketUsed]);

  const handleRequestApiKey = async () => {
    if (!currentTicket || isRequesting) return;

    try {
      // Start the animation
      setIsTransitioning(true);
      
      // Wait a bit for the animation to start
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Show the finalized version
      setShowFinalized(true);
      
      // Wait for the transformation animation
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Actually request the API key
      await onRequestApiKey();
      
      // Success - reset for next ticket
      setTimeout(() => {
        setShowFinalized(false);
        setIsTransitioning(false);
        // Trigger reload of next ticket
        const loadNext = () => {
          const tickets = stationClient.tickets;
          if (tickets && tickets.length > 0) {
            const nextUnused = tickets.findIndex(t => !t.used);
            if (nextUnused !== -1) {
              setCurrentTicket(tickets[nextUnused]);
              setTicketIndex(nextUnused);
            } else {
              setCurrentTicket(null);
            }
          }
        };
        loadNext();
      }, 500);
    } catch (error) {
      // On error, still reset and reload next ticket
      console.error('Error requesting API key:', error);
      setTimeout(() => {
        setShowFinalized(false);
        setIsTransitioning(false);
        // Reload next ticket even on error
        const loadNext = () => {
          const tickets = stationClient.tickets;
          if (tickets && tickets.length > 0) {
            const nextUnused = tickets.findIndex(t => !t.used);
            if (nextUnused !== -1) {
              setCurrentTicket(tickets[nextUnused]);
              setTicketIndex(nextUnused);
            } else {
              setCurrentTicket(null);
            }
          }
        };
        loadNext();
      }, 500);
    }
  };

  const formatTicketData = (data) => {
    if (!data) return '';
    // Show first and last 20 characters
    if (data.length > 50) {
      return `${data.substring(0, 20)}...${data.substring(data.length - 20)}`;
    }
    return data;
  };

  if (!currentTicket && ticketCount === 0) {
    return null;
  }

  return (
    <div className="p-4 border-b border-black dark:border-gray-600 bg-gray-50 dark:bg-gray-800">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs text-black dark:text-white font-bold font-mono flex items-center gap-2">
            <Ticket className="w-3 h-3" />
            NEXT INFERENCE TICKET
          </h3>
          <span className="text-xs font-mono text-gray-500 dark:text-gray-400">
            #{ticketIndex + 1} of {ticketCount}
          </span>
        </div>

        {currentTicket ? (
          <div className="space-y-3">
            <div className="relative">
              {!showFinalized ? (
                <div
                  className={`space-y-2 transition-all duration-500 ${
                    isTransitioning ? 'opacity-50 scale-95' : 'opacity-100 scale-100'
                  }`}
                >
                  <div className="text-xs font-mono text-gray-600 dark:text-gray-400 mb-1">
                    Signed Response (from server):
                  </div>
                  <div className="bg-white dark:bg-gray-900 border-2 border-dashed border-gray-400 dark:border-gray-600 rounded p-2 font-mono text-xs break-all">
                    {formatTicketData(currentTicket.signed_response)}
                  </div>
                </div>
              ) : (
                <div
                  className={`space-y-2 transition-all duration-500 ${
                    showFinalized ? 'opacity-100 scale-100' : 'opacity-0 scale-110'
                  }`}
                >
                  <div className="text-xs font-mono text-green-600 dark:text-green-400 mb-1 flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" />
                    Finalized Token (ready to use):
                  </div>
                  <div className="bg-green-50 dark:bg-green-900/20 border-2 border-green-500 dark:border-green-400 rounded p-2 font-mono text-xs break-all text-green-700 dark:text-green-300">
                    {formatTicketData(currentTicket.finalized_ticket)}
                  </div>
                </div>
              )}
            </div>

            {/* Request Button */}
            <button
              onClick={handleRequestApiKey}
              disabled={isRequesting || isTransitioning}
              className={`
                w-full flex items-center justify-center gap-2 px-3 py-2 rounded
                font-mono text-xs font-bold transition-all
                ${isTransitioning 
                  ? 'bg-blue-500 text-white border-2 border-blue-600' 
                  : 'bg-black dark:bg-white text-white dark:text-black border-3 border-black dark:border-white shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)]'
                }
                ${isRequesting ? 'opacity-50 cursor-not-allowed' : 'hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)]'}
              `}
            >
              <KeyRound className="w-3 h-3" />
              {isRequesting ? 'Requesting...' : isTransitioning ? 'Transforming...' : 'Use This Ticket'}
            </button>

            {/* Ticket Status */}
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-gray-500 dark:text-gray-400">
                Status:
              </span>
              <span className={`
                ${currentTicket.used 
                  ? 'text-red-500 dark:text-red-400' 
                  : 'text-green-500 dark:text-green-400'
                }
              `}>
                {currentTicket.used ? 'Used' : 'Available'}
              </span>
            </div>
          </div>
        ) : (
          <div className="text-center py-4 text-xs font-mono text-gray-500 dark:text-gray-400">
            No tickets available
          </div>
        )}
      </div>
    </div>
  );
};
