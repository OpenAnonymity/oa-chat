/**
 * Station API Client
 * Handles authentication and API key provisioning from the station backend
 * Integrates with Privacy Pass WASM module for cryptographic operations
 */

import axios from 'axios';
import { createPrivacyPassProvider } from './privacyPass.js';

// Organization API URL for discovering available stations
const ORG_API_BASE = process.env.REACT_APP_ORG_URL || 'https://org.openanonymity.ai';

// Fallback station URL if org discovery fails
const FALLBACK_STATION_URL = process.env.REACT_APP_STATION_URL || '';

// Privacy Pass provider preference: 'wasm' (default) or 'extension'
// Set to 'extension' if you want to use the browser extension instead
const PRIVACY_PASS_PROVIDER = process.env.REACT_APP_PRIVACY_PASS_PROVIDER || 'wasm';

/**
 * Station API Client Class
 */
class StationClient {
  constructor() {
    console.log('🚀 Initializing StationClient');
    // Use modular Privacy Pass provider (defaults to direct WASM)
    this.ppExtension = createPrivacyPassProvider(PRIVACY_PASS_PROVIDER);
    this.tickets = this.loadTickets();
    this.currentTicketIndex = 0;
    this.selectedStationUrl = null; // Track which station was selected
    this.selectedStationName = null;
    console.log(`📊 StationClient ready with ${this.tickets.length} tickets`);
  }

  /**
   * Fetch list of online stations from the org server
   */
  async getOnlineStations() {
    try {
      console.log('🔍 Fetching online stations from org...');
      const response = await axios.get(`${ORG_API_BASE}/api/v2/online`, {
        timeout: 5000,
      });

      const stations = Object.entries(response.data).map(([name, info]) => ({
        name,
        url: info.url,
        models: info.models || [],
        lastSeenSecondsAgo: info.last_seen_seconds_ago,
      }));

      console.log(`✅ Found ${stations.length} online stations:`, stations.map(s => s.name));
      return stations;
    } catch (error) {
      console.error('❌ Failed to fetch online stations:', error.message);
      return [];
    }
  }

  /**
   * Randomly select a station from the available ones
   */
  selectRandomStation(stations) {
    if (!stations || stations.length === 0) {
      console.log('⚠️  No stations available, using fallback');
      return {
        name: 'fallback-station',
        url: FALLBACK_STATION_URL,
      };
    }

    // Truly random selection using crypto.getRandomValues for better randomness
    const randomIndex = crypto.getRandomValues(new Uint32Array(1))[0] % stations.length;
    const selected = stations[randomIndex];
    
    console.log(`🎲 Randomly selected station: ${selected.name} (${randomIndex + 1}/${stations.length})`);
    console.log(`📍 Station URL: ${selected.url}`);
    
    this.selectedStationUrl = selected.url;
    this.selectedStationName = selected.name;
    
    return selected;
  }

  /**
   * Load tickets from localStorage
   */
  loadTickets() {
    try {
      const stored = localStorage.getItem('inference_tickets');
      const tickets = stored ? JSON.parse(stored) : [];
      console.log(`📥 Loaded ${tickets.length} tickets from localStorage`);
      return tickets;
    } catch (error) {
      console.error('❌ Error loading tickets:', error);
      return [];
    }
  }

  /**
   * Save tickets to localStorage
   */
  saveTickets(tickets) {
    try {
      localStorage.setItem('inference_tickets', JSON.stringify(tickets));
      this.tickets = tickets;
      this.currentTicketIndex = 0;
      console.log(`💾 Saved ${tickets.length} tickets to localStorage`);
      
      // Verify it was saved
      const verification = localStorage.getItem('inference_tickets');
      if (verification) {
        console.log(`✅ Verified: ${JSON.parse(verification).length} tickets in localStorage`);
      }

      // Notify app about ticket updates
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('tickets-updated'));
      }
    } catch (error) {
      console.error('❌ Error saving tickets:', error);
      if (error.name === 'QuotaExceededError') {
        console.error('⚠️  localStorage quota exceeded - tickets too large!');
      }
    }
  }

  /**
   * Get the next available (unused) ticket
   */
  getNextTicket() {
    if (!this.tickets || this.tickets.length === 0) {
      return null;
    }

    // Find the next unused ticket
    const unusedTickets = this.tickets.filter(t => !t.used);
    
    if (unusedTickets.length === 0) {
      console.log('❌ No unused tickets available');
      return null;
    }

    // Return the first unused ticket
    const ticket = unusedTickets[0];
    console.log(`🎫 Using ticket ${this.tickets.indexOf(ticket) + 1}/${this.tickets.length}`);
    return ticket;
  }

  /**
   * Get unused ticket count
   */
  getTicketCount() {
    if (!this.tickets) return 0;
    // Return count of unused tickets only
    return this.tickets.filter(t => !t.used).length;
  }

  /**
   * Clear all tickets
   */
  clearTickets() {
    this.tickets = [];
    this.currentTicketIndex = 0;
    localStorage.removeItem('inference_tickets');
    console.log('🗑️  All tickets cleared');
    // Notify app about ticket updates
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('tickets-updated'));
    }
  }

  /**
   * Mark first N tickets as used (utility for fixing stuck tickets)
   */
  markFirstNTicketsAsUsed(count) {
    if (!this.tickets || this.tickets.length === 0) {
      console.log('❌ No tickets to mark');
      return;
    }

    const actualCount = Math.min(count, this.tickets.length);
    for (let i = 0; i < actualCount; i++) {
      this.tickets[i].used = true;
      this.tickets[i].used_at = new Date().toISOString();
    }
    
    this.saveTickets(this.tickets);
    console.log(`✅ Marked first ${actualCount} tickets as used`);
    console.log(`📊 Remaining unused tickets: ${this.getTicketCount()}`);
    
    return this.getTicketCount();
  }

  /**
   * Get detailed ticket stats
   */
  getDetailedTicketStats() {
    if (!this.tickets || this.tickets.length === 0) {
      return { total: 0, used: 0, unused: 0 };
    }

    const used = this.tickets.filter(t => t.used).length;
    const unused = this.tickets.filter(t => !t.used).length;

    return {
      total: this.tickets.length,
      used,
      unused,
      tickets: this.tickets.map((t, i) => ({
        index: i,
        used: t.used,
        used_at: t.used_at,
        created_at: t.created_at
      }))
    };
  }

  /**
   * Register with invitation code and obtain inference tickets
   * Uses Privacy Pass extension for proper blinding/unblinding
   */
  async alphaRegister(invitationCode, progressCallback) {
    console.log('=== Starting alphaRegister ===');
    console.log('Invitation code:', invitationCode);
    console.log('Org API Base URL:', ORG_API_BASE);
    
    try {
      // Step 1: Validate invitation code format
      if (progressCallback) progressCallback('Validating invitation code...', 5);
      
      if (!invitationCode || invitationCode.length !== 24) {
        throw new Error('Invalid invitation code format (must be 24 characters)');
      }

      // Step 2: Extract ticket count from invitation code
      const suffix = invitationCode.slice(20, 24);
      const ticketCount = parseInt(suffix, 16);
      
      if (isNaN(ticketCount) || ticketCount === 0) {
        throw new Error('Invalid invitation code: unable to determine ticket count');
      }

      // Step 3: Check if Privacy Pass provider is available
      if (progressCallback) progressCallback('Initializing Privacy Pass...', 10);
      
      console.log('Checking Privacy Pass provider:', this.ppExtension);
      const hasProvider = await this.ppExtension.checkAvailability();
      console.log('Privacy Pass provider available:', hasProvider);
      
      if (!hasProvider) {
        throw new Error(
          'Privacy Pass is not available. Please check your configuration.'
        );
      }

      // Step 4: Get public key from station (matching Python code)
      if (progressCallback) progressCallback('Getting issuer public key...', 20);
      
      let publicKey;
      try {
        const keyResponse = await axios.get(
          `${ORG_API_BASE}/api/ticket/issue/public-key`
        );
        console.log('Public key response:', keyResponse.data);
        publicKey = keyResponse.data.public_key;
        
        if (!publicKey) {
          console.error('No public key in response:', keyResponse.data);
          throw new Error('Station did not return public key');
        }
        console.log('Got public key:', publicKey);
      } catch (error) {
        console.error('Failed to fetch public key:', error);
        console.error('Error details:', error.response?.data || error.message);
        
        // Check if it's a CORS issue
        if (error.message && error.message.includes('Network Error')) {
          throw new Error(`CORS error: Cannot reach org server at ${ORG_API_BASE}. Make sure the server allows cross-origin requests.`);
        }
        throw new Error(`Failed to get public key: ${error.message}`);
      }

      // Step 5: Use extension to create indexed blinded token requests
      // This matches the Python code which creates individual blinded requests with indices
      if (progressCallback) progressCallback(`Blinding ${ticketCount} tickets...`, 25);
      
      // Create challenge matching Python: TokenChallenge.create("oa-station", ["oa-station-api"])
      const challenge = await this.ppExtension.createChallenge("oa-station", ["oa-station-api"]);
      
      // Create blinded requests with indices (matching Python format)
      const indexedBlindedRequests = [];
      const clientStates = [];
      
      for (let i = 0; i < ticketCount; i++) {
        console.log(`Creating blinded request ${i} with publicKey: ${publicKey}, challenge: ${challenge}`);
        try {
          const result = await this.ppExtension.createSingleTokenRequest(
            publicKey, 
            challenge
          );
          console.log(`Token request result for ${i}:`, result);
          const { blindedRequest, state } = result;
          indexedBlindedRequests.push([i, blindedRequest]);
          clientStates.push([i, state]);
        } catch (error) {
          console.error(`Failed to create blinded request ${i}:`, error);
          throw error;
        }
        
        // Show progress for large batches
        if (i > 0 && i % Math.max(1, Math.floor(ticketCount / 20)) === 0) {
          const progressPct = 25 + Math.floor((i / ticketCount) * 20);
          if (progressCallback) {
            progressCallback(`Blinding tickets... (${i}/${ticketCount})`, progressPct);
          }
        }
      }

      // Step 6: Send indexed blinded requests to alpha-register (matching Python exactly)
      if (progressCallback) progressCallback('Sending blinded tickets to server for signing...', 50);
      
      const signResponse = await axios.post(
        `${ORG_API_BASE}/api/alpha-register`,
        {
          credential: invitationCode,
          blinded_requests: indexedBlindedRequests  // Array of [index, request] tuples
        },
        {
          timeout: Math.max(120000, ticketCount * 50),
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );

      // Step 7: Parse indexed signed responses (matching Python format)
      if (progressCallback) progressCallback('Signed tickets received...', 70);
      
      const indexedSignedResponses = signResponse.data.signed_responses;
      
      if (!indexedSignedResponses || indexedSignedResponses.length === 0) {
        throw new Error('Station did not return signed responses');
      }

      // Create mapping of index -> signed_response (matching Python)
      const responseMap = {};
      indexedSignedResponses.forEach(([idx, signedResp]) => {
        responseMap[idx] = signedResp;
      });

      // Step 8: Unblind responses to get final tickets (matching Python)
      if (progressCallback) progressCallback('Unblinding tickets...', 75);
      
      const tickets = [];
      const progressInterval = Math.max(1, Math.floor(clientStates.length / 10));
      
      for (let i = 0; i < clientStates.length; i++) {
        const [idx, state] = clientStates[i];
        
        if (!(idx in responseMap)) {
          throw new Error(`Missing signed response for ticket index ${idx}`);
        }
        
        const signedResponse = responseMap[idx];
        const blindedRequest = indexedBlindedRequests[idx][1];
        
        // Finalize (unblind) the token
        const finalizedTicket = await this.ppExtension.finalizeToken(signedResponse, state);
        
        tickets.push({
          blinded_request: blindedRequest,
          signed_response: signedResponse,
          finalized_ticket: finalizedTicket,
          used: false,
          used_at: null,
          created_at: new Date().toISOString(),
        });
        
        // Show progress for large batches
        if (i > 0 && i % progressInterval === 0) {
          const progressPct = 75 + Math.floor((i / clientStates.length) * 15);
          if (progressCallback) {
            progressCallback(`Unblinding tickets... (${i}/${clientStates.length})`, progressPct);
          }
        }
      }

      // Step 9: Save tickets
      if (progressCallback) progressCallback('Saving tickets...', 90);

      this.saveTickets(tickets);

      if (progressCallback) progressCallback('Registration complete!', 100);

      return {
        success: true,
        tickets_issued: tickets.length,
        credential: invitationCode,
        expires_at: signResponse.data.expires_at,
      };

    } catch (error) {
      console.error('Alpha register error:', error);
      
      if (error.response) {
        throw new Error(error.response.data?.detail || error.response.data?.message || 'Server error during registration');
      } else if (error.request) {
        throw new Error('No response from station server. Please check connection.');
      } else {
        throw error;
      }
    }
  }

  /**
   * Request a temporary OpenRouter API key using an inference ticket
   */
  async requestApiKey(name = 'OA-Station-WebApp-Key') {
    let ticket = null;  // Declare outside try block so catch can access it
    
    try {
      ticket = this.getNextTicket();
      
      if (!ticket) {
        throw new Error('No inference tickets available. Please register with an invitation code first.');
      }

      console.log('Requesting API key with ticket:', {
        index: ticket.index,
        hasTicket: !!ticket.finalized_ticket
      });

      // Dynamically select a station from available ones
      const onlineStations = await this.getOnlineStations();
      const selectedStation = this.selectRandomStation(onlineStations);

      console.log(`🔑 Requesting API key from: ${selectedStation.name}`);

      const response = await axios.post(
        `${selectedStation.url}/api/v2/request_key`,
        {
          name: name,
          // credit_limit and duration_limit use server defaults
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `InferenceTicket token=${ticket.finalized_ticket}`,
            // 'HTTP-Referer': 'https://openanonymity.ai', // TODO: Enable when needed for station tracking
          },
          timeout: 30000,
        }
      );

      // ✅ SUCCESS - Mark ticket as used
      this.markTicketAsUsed(ticket);

      const data = response.data;

      return {
        key: data.key,
        name: data.name,
        credit_limit: data.credit_limit,
        duration_minutes: data.duration_minutes,
        expires_at: data.expires_at,
        station_name: this.selectedStationName, // Include which station provided the key
        station_url: this.selectedStationUrl,
        ticket_used: {
          blinded_request: ticket.blinded_request,
          signed_response: ticket.signed_response,
          finalized_ticket: ticket.finalized_ticket,
        }
      };

    } catch (error) {
      console.error('Request API key error:', error);
      
      // Check if this is a double-spending error
      const errorDetail = error.response?.data?.detail || '';
      if (errorDetail.includes('double-spending') || errorDetail.includes('already spent')) {
        console.log('⚠️  Double-spending detected - marking ticket as used');
        // Mark ticket as used even on double-spending error
        if (ticket) {
          this.markTicketAsUsed(ticket);
        }
        throw new Error('This ticket was already used. Please try again with next ticket.');
      }
      
      if (error.response?.status === 401) {
        // Also mark as used if server rejected it
        if (ticket) {
          this.markTicketAsUsed(ticket);
        }
        throw new Error('Invalid or expired inference ticket. Please register again.');
      } else if (error.response?.status === 503) {
        throw new Error('Provisioning service not available. Please contact administrator.');
      } else if (error.response) {
        throw new Error(error.response.data?.detail || 'Failed to provision API key');
      } else if (error.request) {
        throw new Error('No response from station server');
      } else {
        throw error;
      }
    }
  }

  /**
   * Mark a ticket as used in localStorage
   */
  markTicketAsUsed(ticket) {
    if (!ticket || !this.tickets) return;

    // Find the ticket in our array by matching the finalized_ticket
    const ticketIndex = this.tickets.findIndex(
      t => t.finalized_ticket === ticket.finalized_ticket
    );

    if (ticketIndex !== -1) {
      // Mark as used
      this.tickets[ticketIndex].used = true;
      this.tickets[ticketIndex].used_at = new Date().toISOString();
      
      // Save to localStorage (also emits tickets-updated)
      this.saveTickets(this.tickets);
      
      console.log(`✅ Marked ticket ${ticketIndex + 1}/${this.tickets.length} as used`);
      console.log(`📊 Remaining tickets: ${this.tickets.filter(t => !t.used).length}`);

      // Extra notify (harmless):
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('tickets-updated'));
      }
    } else {
      console.warn('⚠️  Could not find ticket to mark as used');
    }
  }

  /**
   * Get station health status
   * Uses the last selected station or fallback
   */
  async getHealth() {
    const stationUrl = this.selectedStationUrl || FALLBACK_STATION_URL;
    try {
      const response = await axios.get(`${stationUrl}/api/health`, {
        timeout: 5000,
      });
      return response.data;
    } catch (error) {
      throw new Error('Station server unreachable');
    }
  }

  /**
   * Get info about the currently selected station
   */
  getSelectedStationInfo() {
    return {
      name: this.selectedStationName,
      url: this.selectedStationUrl,
    };
  }
}

// Export singleton instance
const stationClient = new StationClient();

// Make available in console for debugging (development only)
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  window.stationClient = stationClient;
  console.log('💡 Debug: window.stationClient available in console');
  console.log('   Try: stationClient.getDetailedTicketStats()');
  console.log('   Try: stationClient.markFirstNTicketsAsUsed(5)');
}

export default stationClient;

