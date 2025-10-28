/**
 * OA Inference Ticket Service
 * Modular service supporting both direct WASM and browser extension implementations
 * Provides Privacy Pass cryptographic operations for anonymous authentication
 */

// Privacy Pass extension ID (Chrome) - only used for ExtensionProvider
const PRIVACY_PASS_EXTENSION_ID = 'idhgjflokkbgindmjnikbeoaihmkigld';

/**
 * Direct WASM Provider
 * Loads OA Inference Ticket WASM module directly without browser extension
 */
class WasmDirectProvider {
  constructor() {
    this.initialized = false;
    this.wasm = null;
  }

  /**
   * Initialize WASM module
   */
  async initialize() {
    if (this.initialized) return true;

    try {
      console.log('Loading OA Inference Ticket WASM module...');
      
      // Dynamically import the WASM module from src/wasm
      // This works because the files are in src/, not public/
      const wasmModule = await import('../../wasm/oa_inference_ticket.js');
      
      // Initialize the WASM - the default export is the init function
      await wasmModule.default();
      
      // Store reference to WASM functions
      this.wasm = wasmModule;
      this.initialized = true;
      
      console.log('✅ OA Inference Ticket WASM initialized (direct)');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize WASM:', error);
      throw new Error(`WASM initialization failed: ${error.message}`);
    }
  }

  /**
   * Create Privacy Pass challenge
   * For compatibility - WASM creates challenge internally
   */
  async createChallenge(issuerName, originInfo) {
    return null;
  }

  /**
   * Create a single blinded token request
   * @param {string} publicKey - Issuer's RSA public key (base64)
   * @param {string} challenge - Token challenge (unused, for compatibility)
   * @returns {Object} { blindedRequest, state }
   */
  async createSingleTokenRequest(publicKey, challenge) {
    await this.initialize();

    console.log('Creating token request with WASM (direct)');
    
    if (!publicKey) {
      throw new Error('Missing required parameter: publicKey');
    }

    try {
      // Create WWW-Authenticate header for PublicToken (RSA)
      const wwwAuthenticate = `PublicToken token-key="${publicKey}"`;
      
      const headerJson = JSON.stringify({ 
        header: wwwAuthenticate,
        error: "" 
      });

      // Call WASM token_request function
      const responseJson = await this.wasm.token_request(headerJson, 1);
      const response = JSON.parse(responseJson);
      
      // Check for errors
      if (response.error && response.error !== "") {
        throw new Error(`Token request failed: ${response.error}`);
      }
      
      // Extract client state and token request
      const clientState = response[0];
      const tokenRequestObj = response[1];
      
      if (!tokenRequestObj) {
        throw new Error('Invalid token request response from WASM');
      }
      
      // Extract blinded request
      let blindedRequest = '';
      if (typeof tokenRequestObj === 'string') {
        blindedRequest = tokenRequestObj;
      } else if (tokenRequestObj.token_request) {
        blindedRequest = tokenRequestObj.token_request;
      } else {
        throw new Error('Invalid token request format');
      }

      console.log('✅ Inference ticket request created (direct WASM)');

      return {
        blindedRequest: blindedRequest,
        state: clientState.state  // UUID string
      };
    } catch (error) {
      console.error('❌ Error creating ticket request:', error);
      throw error;
    }
  }

  /**
   * Finalize a single token (unblind)
   * @param {string} signedResponse - Signed response from server (base64)
   * @param {string} state - Client state from createSingleTokenRequest
   * @returns {string} Finalized token (base64)
   */
  async finalizeToken(signedResponse, state) {
    if (!signedResponse || !state) {
      throw new Error('Missing required parameters: signedResponse, state');
    }

    await this.initialize();

    try {
      // Prepare data for finalization
      const headerJson = JSON.stringify({ header: "", error: "" });
      const clientStateJson = JSON.stringify({ 
        state: state,
        error: "" 
      });
      const tokenResponseJson = JSON.stringify({
        token_response: signedResponse,
        error: ""
      });

      // Call WASM token_finalization function
      const resultJson = await this.wasm.token_finalization(
        headerJson,
        clientStateJson,
        tokenResponseJson
      );
      
      const result = JSON.parse(resultJson);
      
      if (!result.tokens || result.tokens.length === 0) {
        throw new Error('Token finalization failed');
      }

      console.log('✅ Inference ticket finalized (direct WASM)');

      return result.tokens[0];
    } catch (error) {
      console.error('❌ Error finalizing ticket:', error);
      throw error;
    }
  }

  /**
   * Check if provider is available
   */
  async checkAvailability() {
    try {
      await this.initialize();
      return true;
    } catch (error) {
      console.log('Direct WASM not available:', error.message);
      return false;
    }
  }
}

/**
 * Browser Extension Provider
 * Uses Chrome extension for Privacy Pass operations
 */
class ExtensionProvider {
  constructor(extensionId = PRIVACY_PASS_EXTENSION_ID) {
    this.extensionId = extensionId;
    this.available = false;
    this.initialized = false;
  }

  /**
   * Check if extension is installed and available
   */
  async checkAvailability() {
    // eslint-disable-next-line no-undef
    if (typeof chrome === 'undefined' || !chrome.runtime) {
      console.log('Chrome runtime not available');
      return false;
    }

    try {
      const response = await this.sendMessage({ 
        source: 'OA_WEBAPP',
        action: 'PING' 
      });
      
      this.available = response && response.success;
      console.log('Privacy Pass extension available:', this.available);
      return this.available;
    } catch (error) {
      console.log('Privacy Pass extension not available:', error.message);
      this.available = false;
      return false;
    }
  }

  /**
   * Send message to extension
   */
  async sendMessage(message) {
    return new Promise((resolve, reject) => {
      if (!this.extensionId || this.extensionId === 'YOUR_EXTENSION_ID_HERE') {
        reject(new Error('Extension ID not configured'));
        return;
      }

      console.log(`Sending message to extension ${this.extensionId}:`, message);
      
      // eslint-disable-next-line no-undef
      chrome.runtime.sendMessage(this.extensionId, message, (response) => {
        // eslint-disable-next-line no-undef
        if (chrome.runtime.lastError) {
          // eslint-disable-next-line no-undef
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          console.log('Extension response:', response);
          resolve(response);
        }
      });
    });
  }

  /**
   * Initialize Privacy Pass WASM in extension
   */
  async initialize() {
    if (this.initialized) return true;

    const response = await this.sendMessage({
      source: 'OA_WEBAPP',
      action: 'INIT_PRIVACY_PASS'
    });

    if (!response.success) {
      throw new Error(`Extension initialization failed: ${response.error}`);
    }

    this.initialized = true;
    console.log('✅ Privacy Pass extension initialized');
    return true;
  }

  /**
   * Create Privacy Pass challenge
   */
  async createChallenge(issuerName, originInfo) {
    // WASM creates challenge internally
    return null;
  }

  /**
   * Create a single blinded token request
   */
  async createSingleTokenRequest(publicKey, challenge) {
    await this.initialize();
    
    console.log('Creating token request with extension');
    
    const response = await this.sendMessage({
      source: 'OA_WEBAPP',
      action: 'CREATE_SINGLE_TOKEN_REQUEST',
      data: {
        publicKey,
        challenge
      }
    });

    if (!response.success) {
      throw new Error(`Token request creation failed: ${response.error}`);
    }

    return {
      blindedRequest: response.data.blindedRequest,
      state: response.data.state
    };
  }

  /**
   * Finalize a single token (unblind)
   */
  async finalizeToken(signedResponse, state) {
    const response = await this.sendMessage({
      source: 'OA_WEBAPP',
      action: 'FINALIZE_SINGLE_TOKEN',
      data: {
        signedResponse,
        state
      }
    });

    if (!response.success) {
      throw new Error(`Token finalization failed: ${response.error}`);
    }

    return response.data.finalizedToken;
  }
}

/**
 * OA Inference Ticket Provider Factory
 * Returns appropriate provider based on preferences
 * 
 * @param {string} preferredProvider - 'wasm' (default) or 'extension'
 * @returns {WasmDirectProvider|ExtensionProvider}
 */
export function createPrivacyPassProvider(preferredProvider = 'wasm') {
  if (preferredProvider === 'extension') {
    console.log('📦 Using OA Inference Ticket Extension Provider');
    return new ExtensionProvider();
  }
  
  console.log('🔧 Using OA Inference Ticket Direct WASM Provider');
  return new WasmDirectProvider();
}

// Export providers for direct use if needed
export { WasmDirectProvider, ExtensionProvider };

