import React, { useState, useEffect } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '../../../shared/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../../shared/components/ui/collapsible';

/**
 * Ticket Visualization Component
 * Shows the Inference ticket details with blinding/unblinding animation
 */
export const TicketVisualization = ({ ticketUsed }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showUnblinded, setShowUnblinded] = useState(false);

  useEffect(() => {
    if (ticketUsed && isOpen) {
      // Animate from blinded to unblinded after a delay
      const timer = setTimeout(() => {
        setShowUnblinded(true);
      }, 1000);
      return () => clearTimeout(timer);
    } else {
      setShowUnblinded(false);
    }
  }, [ticketUsed, isOpen]);

  if (!ticketUsed) {
    return null;
  }

  return (
    <div className="p-4 border-b border-black dark:border-gray-600">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="border-2 border-black dark:border-white rounded-lg bg-gray-200 dark:bg-gray-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)]">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between p-3 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800 font-mono font-medium rounded-lg"
            >
              <span className="text-xs font-bold flex items-center gap-2">
                🎫 INFERENCE TICKET #{ticketUsed.index}
              </span>
              {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          </CollapsibleTrigger>
          
          <CollapsibleContent className="px-3 pb-3">
            <div className="space-y-3 mt-2">
              {/* Blinded Request */}
              <div className={`transition-all duration-500 ${showUnblinded ? 'opacity-50' : 'opacity-100'}`}>
                <div className="text-xs font-mono font-bold text-gray-600 dark:text-gray-300 mb-1">
                  1. Blinded Request (Client-side):
                </div>
                <div className="text-xs font-mono text-black dark:text-white bg-gray-100 dark:bg-gray-800 p-2 rounded border border-gray-300 dark:border-gray-600 break-all">
                  {ticketUsed.blinded_request}
                </div>
              </div>

              {/* Arrow Animation */}
              <div className="flex justify-center">
                <div className={`text-2xl transition-all duration-500 ${showUnblinded ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}`}>
                  ↓
                </div>
              </div>

              {/* Signed Response */}
              <div className={`transition-all duration-500 ${showUnblinded ? 'opacity-100' : 'opacity-50'}`}>
                <div className="text-xs font-mono font-bold text-gray-600 dark:text-gray-300 mb-1">
                  2. Signed Response (Server-side):
                </div>
                <div className="text-xs font-mono text-black dark:text-white bg-gray-100 dark:bg-gray-800 p-2 rounded border border-gray-300 dark:border-gray-600 break-all">
                  {ticketUsed.signed_response}
                </div>
              </div>

              {/* Arrow Animation */}
              <div className="flex justify-center">
                <div className={`text-2xl transition-all duration-500 ${showUnblinded ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}`}>
                  ↓
                </div>
              </div>

              {/* Finalized Ticket */}
              <div className={`transition-all duration-500 ${showUnblinded ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}`}>
                <div className="text-xs font-mono font-bold text-green-600 dark:text-green-400 mb-1 flex items-center gap-1">
                  <span>✓</span>
                  3. Finalized Ticket (Unblinded):
                </div>
                <div className="text-xs font-mono text-black dark:text-white bg-green-100 dark:bg-green-900 p-2 rounded border-2 border-green-500 break-all">
                  {ticketUsed.finalized_ticket}
                </div>
              </div>

              <div className="text-xs font-mono text-gray-500 dark:text-gray-400 text-center pt-2 border-t border-gray-300 dark:border-gray-600">
                <span>
                  This ticket was used to authenticate your API key request,{' '}
                  <strong className="text-black dark:text-white">
                    no one has ever seen
                  </strong>{' '}
                  this unblinded ticket before this request was sent.
                </span>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  );
};

