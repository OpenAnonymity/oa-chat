/**
 * Share Encryption/Decryption using Web Crypto API (Argon2id + AES-GCM)
 */

// Argon2id parameters (OWASP recommended for 2025)
const ARGON2_MEMORY = 65536;      // 64 MB
const ARGON2_ITERATIONS = 3;       // Time cost
const ARGON2_PARALLELISM = 1;      // Single thread for consistency
const ARGON2_HASH_LENGTH = 32;     // 256 bits for AES-256

/**
 * Derive a key from password using Argon2id
 */
async function deriveKey(password, salt) {
    // Ensure hash-wasm is loaded (initHashWasm returns a promise that resolves when ready)
    if (!window.argon2id) {
        await window.initHashWasm();
    }
    
    // Argon2id returns raw bytes (Uint8Array)
    const derivedBytes = await window.argon2id({
        password,
        salt,
        parallelism: ARGON2_PARALLELISM,
        iterations: ARGON2_ITERATIONS,
        memorySize: ARGON2_MEMORY,
        hashLength: ARGON2_HASH_LENGTH,
        outputType: 'binary'
    });
    
    // Import raw bytes as AES-GCM key
    return crypto.subtle.importKey(
        'raw',
        derivedBytes,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt data with password
 * @param {Object} data - Data to encrypt (will be JSON-stringified)
 * @param {string} password - Password for encryption
 * @returns {Promise<{salt: string, iv: string, ciphertext: string}>} Base64-encoded components
 */
export async function encrypt(data, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(JSON.stringify(data));
    
    const ciphertextBuffer = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        plaintext
    );
    
    return {
        salt: btoa(String.fromCharCode(...salt)),
        iv: btoa(String.fromCharCode(...iv)),
        ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertextBuffer)))
    };
}

/**
 * Decrypt data with password
 * @param {string} salt - Base64-encoded salt
 * @param {string} iv - Base64-encoded IV
 * @param {string} ciphertext - Base64-encoded ciphertext
 * @param {string} password - Password for decryption
 * @returns {Promise<Object>} Decrypted data (parsed from JSON)
 */
export async function decrypt(salt, iv, ciphertext, password) {
    const saltBytes = Uint8Array.from(atob(salt), c => c.charCodeAt(0));
    const ivBytes = Uint8Array.from(atob(iv), c => c.charCodeAt(0));
    const ciphertextBytes = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
    
    const key = await deriveKey(password, saltBytes);
    
    const plaintextBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBytes },
        key,
        ciphertextBytes
    );
    
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(plaintextBuffer));
}
