/**
 * Privacy Pass Provider for OA Inference Tickets
 * Direct WASM implementation without browser extension dependency
 */

class WasmDirectProvider {
    constructor() {
        this.initialized = false;
        this.wasm = null;
    }

    async initialize() {
        if (this.initialized) return true;

        try {
            console.log('Loading OA Inference Ticket WASM module...');

            // Import the WASM module dynamically
            const wasmModule = await import('../wasm/oa_inference_ticket.js');

            // Initialize the WASM - fetch and load the .wasm file
            await wasmModule.default('wasm/oa_inference_ticket_bg.wasm');

            // Store reference to WASM functions
            this.wasm = wasmModule;
            this.initialized = true;

            console.log('✅ OA Inference Ticket WASM initialized');
            return true;
        } catch (error) {
            console.error('❌ Failed to initialize WASM:', error);
            throw new Error(`WASM initialization failed: ${error.message}`);
        }
    }

    async createChallenge(issuerName, originInfo) {
        // For compatibility - WASM creates challenge internally
        return null;
    }

    async createSingleTokenRequest(publicKey, challenge) {
        await this.initialize();

        console.log('Creating token request with WASM');

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

            console.log('✅ Inference ticket request created');

            return {
                blindedRequest: blindedRequest,
                state: clientState.state
            };
        } catch (error) {
            console.error('❌ Error creating ticket request:', error);
            throw error;
        }
    }

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

            console.log('✅ Inference ticket finalized');

            return result.tokens[0];
        } catch (error) {
            console.error('❌ Error finalizing ticket:', error);
            throw error;
        }
    }

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

// Create and export singleton instance
const privacyPassProvider = new WasmDirectProvider();

export default privacyPassProvider;



