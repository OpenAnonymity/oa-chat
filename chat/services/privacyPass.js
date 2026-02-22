/**
 * Privacy Pass Provider for OA Inference Tickets
 * Pure JS implementation using @cloudflare/privacypass-ts (RFC 9578).
 */

import { publicVerif, TokenChallenge } from '../vendor/privacypass-ts/privacypass-ts.min.js';

const { Client, BlindRSAMode } = publicVerif;

function b64urlEncode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

class PrivacyPassProvider {
    constructor() {
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return true;
        this.initialized = true;
        console.log('✅ Privacy Pass provider ready (pure JS, no WASM)');
        return true;
    }

    async createChallenge() {
        return null;
    }

    async createSingleTokenRequest(publicKeyB64) {
        await this.initialize();

        if (!publicKeyB64) throw new Error('Missing required parameter: publicKey');

        const pubKeyBytes = b64urlDecode(publicKeyB64);

        // TokenChallenge fields: the only field that matters is the token type
        // (0x0002 = Blind RSA). issuerName is required by the library (min 1
        // byte) but the server does not validate the challenge -- it only
        // processes the raw TokenRequest/TokenResponse blind signature blobs.
        // redemptionContext is empty (0 bytes) and originInfo is omitted,
        // meaning the ticket carries no extra information beyond the blind
        // signature itself. No metadata, no identity, no session binding.
        const challenge = new TokenChallenge(
            0x0002,
            "if you found this, email hi@openanonymity.ai with code OA-BLIND-2026 -- we need you :D",
            new Uint8Array(0)
        );

        const client = new Client(BlindRSAMode.PSS);
        const tokenRequest = await client.createTokenRequest(challenge, pubKeyBytes);
        const blindedRequest = b64urlEncode(tokenRequest.serialize());

        return { blindedRequest, state: client };
    }

    async finalizeToken(signedResponseB64, client) {
        if (!signedResponseB64 || !client) {
            throw new Error('Missing required parameters: signedResponse, state');
        }

        const responseBytes = b64urlDecode(signedResponseB64);
        const tokenResponse = publicVerif.TokenResponse.deserialize(responseBytes);
        const token = await client.finalize(tokenResponse);

        return b64urlEncode(token.serialize());
    }

    async checkAvailability() {
        try {
            await this.initialize();
            return true;
        } catch (error) {
            console.log('Privacy Pass not available:', error.message);
            return false;
        }
    }
}

const privacyPassProvider = new PrivacyPassProvider();
export default privacyPassProvider;
