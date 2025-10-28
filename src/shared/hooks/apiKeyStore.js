/**
 * Simple centralized store for API key state.
 * This avoids prop drilling and complex event handling for state synchronization.
 */
import openRouterClient from '../services/openrouter';

let state = {
  apiKey: null,
  apiKeyInfo: null,
  expiresAt: null,
  ticketUsed: null,
  credits: null, // OpenRouter credits info
};

const listeners = new Set();

const apiKeyStore = {
  subscribe(listener) {
    listeners.add(listener);
    return () => this.unsubscribe(listener);
  },

  unsubscribe(listener) {
    listeners.delete(listener);
  },

  getState() {
    return state;
  },

  getInitialState() {
    // On initial load, state is empty until loadApiKey is called
    return {
      apiKey: null,
      apiKeyInfo: null,
      expiresAt: null,
      ticketUsed: null,
      credits: null,
    };
  },

  loadApiKey() {
    try {
      const saved = localStorage.getItem('openrouter_api_key_info');
      if (saved) {
        const parsed = JSON.parse(saved);
        const expiryDate = new Date(parsed.expires_at);
        
        if (expiryDate > new Date()) {
          state = {
            apiKey: parsed.key,
            apiKeyInfo: parsed,
            expiresAt: parsed.expires_at,
            ticketUsed: parsed.ticket_used,
          };
          openRouterClient.setApiKey(parsed.key);
        } else {
          localStorage.removeItem('openrouter_api_key_info');
          this.clearApiKey(false); // don't notify yet
        }
      }
    } catch (error) {
      console.error('Error loading saved API key:', error);
      this.clearApiKey(false); // don't notify yet
    }
    this.notify();
  },

  setApiKey(apiKeyData) {
    state = {
      apiKey: apiKeyData.key,
      apiKeyInfo: apiKeyData,
      expiresAt: apiKeyData.expires_at,
      ticketUsed: apiKeyData.ticket_used,
    };

    openRouterClient.setApiKey(apiKeyData.key);
    localStorage.setItem('openrouter_api_key_info', JSON.stringify(apiKeyData));
    this.notify();
    // Dispatch event for components that still rely on it (like useInvitationCode)
    window.dispatchEvent(new CustomEvent('apikey-changed'));
  },

  clearApiKey(shouldNotify = true) {
    state = {
      apiKey: null,
      apiKeyInfo: null,
      expiresAt: null,
      ticketUsed: null,
      credits: null,
    };
    openRouterClient.clearApiKey();
    localStorage.removeItem('openrouter_api_key_info');
    if (shouldNotify) {
      this.notify();
      // Dispatch event for components that still rely on it (like useInvitationCode)
      window.dispatchEvent(new CustomEvent('apikey-cleared'));
    }
  },

  // TODO: Uncomment when OpenRouter credits API is fixed
  /**
   * Fetch and update OpenRouter credits
   */
  // async fetchCredits() {
  //   if (!state.apiKey) {
  //     return null;
  //   }

  //   try {
  //     const credits = await openRouterClient.getCredits();
  //     state.credits = credits;
  //     this.notify();
  //     return credits;
  //   } catch (error) {
  //     console.error('Error fetching credits:', error);
  //     return null;
  //   }
  // },

  /**
   * Update credits in state
   */
  // setCredits(credits) {
  //   state.credits = credits;
  //   this.notify();
  // },

  notify() {
    for (const listener of listeners) {
      listener();
    }
  },
};

export default apiKeyStore;
