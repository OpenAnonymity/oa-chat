/**
 * Encryption-only passkeys.
 *
 * Identity authentication is handled by OAuth/email. WebAuthn is used locally
 * only to evaluate the PRF extension and derive an AES-GCM key that wraps the
 * account master key. The WebAuthn assertion is never sent to or verified by
 * the OA server.
 */

const PRF_SALT_ID = 'oa-account-key-v1';
const PRF_INPUT = new TextEncoder().encode(
    'openanonymity.ai/account-master-key/v1'
);
const WRAPPER_AAD = new TextEncoder().encode(
    'openanonymity.ai/account-master-key-wrapper/v1'
);
const WRAPPER_VERSION = 1;
const MASTER_KEY_LENGTH = 32;

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function base64UrlToBytes(input) {
    let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    const padding = base64.length % 4;
    if (padding) base64 += '='.repeat(4 - padding);
    return base64ToBytes(base64);
}

function randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
}

function getPrfResult(credential) {
    const extensionResults = credential?.getClientExtensionResults?.();
    const output = extensionResults?.prf?.results?.first;
    return output ? new Uint8Array(output) : null;
}

function prfWasEnabled(credential) {
    const extensionResults = credential?.getClientExtensionResults?.();
    return extensionResults?.prf?.enabled === true || !!getPrfResult(credential);
}

async function requestPrf(credentialIds) {
    const publicKey = {
        challenge: randomBytes(32),
        allowCredentials: credentialIds.map(id => ({
            id: base64UrlToBytes(id),
            type: 'public-key'
        })),
        userVerification: 'required',
        timeout: 60000,
        extensions: {
            prf: {
                eval: {
                    first: PRF_INPUT
                }
            }
        }
    };
    const credential = await navigator.credentials.get({ publicKey });
    const prfBytes = getPrfResult(credential);
    if (!credential || !prfBytes) {
        throw new Error(
            'This passkey did not provide an encryption key. Use a PRF-capable passkey.'
        );
    }
    return { credential, prfBytes };
}

async function importWrappingKey(prfBytes) {
    return crypto.subtle.importKey(
        'raw',
        prfBytes,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
    );
}

function encodeWrappedKey(payload) {
    return bytesToBase64(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodeWrappedKey(payload) {
    const bytes = base64ToBytes(payload);
    return JSON.parse(new TextDecoder().decode(bytes));
}

async function wrapMasterKey(masterKey, prfBytes) {
    const wrappingKey = await importWrappingKey(prfBytes);
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv,
            additionalData: WRAPPER_AAD
        },
        wrappingKey,
        masterKey
    );
    return encodeWrappedKey({
        algorithm: 'AES-GCM',
        ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
        iv: bytesToBase64(iv),
        prfSaltId: PRF_SALT_ID,
        version: WRAPPER_VERSION
    });
}

async function unwrapMasterKey(wrappedKey, prfBytes) {
    const payload = decodeWrappedKey(wrappedKey);
    if (
        payload?.algorithm !== 'AES-GCM' ||
        payload?.prfSaltId !== PRF_SALT_ID ||
        payload?.version !== WRAPPER_VERSION
    ) {
        throw new Error('Unsupported encrypted key format');
    }

    const wrappingKey = await importWrappingKey(prfBytes);
    const plaintext = await crypto.subtle.decrypt(
        {
            name: 'AES-GCM',
            iv: base64ToBytes(payload.iv),
            additionalData: WRAPPER_AAD
        },
        wrappingKey,
        base64ToBytes(payload.ciphertext)
    );
    const masterKey = new Uint8Array(plaintext);
    if (masterKey.length !== MASTER_KEY_LENGTH) {
        masterKey.fill(0);
        throw new Error('Invalid account master key');
    }
    return masterKey;
}

export function isEncryptionPasskeySupported() {
    return typeof window !== 'undefined' &&
        !!window.PublicKeyCredential &&
        !!navigator.credentials;
}

/**
 * Create a resident PRF-capable credential and wrap the supplied master key.
 *
 * Some authenticators confirm PRF support during create() without returning a
 * PRF result. In that case a follow-up get() evaluates the PRF, as required by
 * WebAuthn Level 3.
 */
export async function createEncryptionKeyWrapper(
    masterKey,
    userEmail,
    existingCredentialIds = []
) {
    if (!isEncryptionPasskeySupported()) {
        throw new Error('Passkeys are not supported in this browser');
    }
    if (!(masterKey instanceof Uint8Array) || masterKey.length !== MASTER_KEY_LENGTH) {
        throw new Error('Invalid account master key');
    }
    const passkeyUsername = typeof userEmail === 'string'
        ? userEmail.trim()
        : '';
    if (!passkeyUsername) {
        throw new Error('Sign in again so OA can label the passkey with your email');
    }

    const credential = await navigator.credentials.create({
        publicKey: {
            challenge: randomBytes(32),
            rp: {
                name: 'Open Anonymity'
            },
            user: {
                id: randomBytes(32),
                name: passkeyUsername,
                displayName: passkeyUsername
            },
            pubKeyCredParams: [
                { type: 'public-key', alg: -7 },
                { type: 'public-key', alg: -257 }
            ],
            authenticatorSelection: {
                residentKey: 'required',
                requireResidentKey: true,
                userVerification: 'required'
            },
            excludeCredentials: existingCredentialIds.map(id => ({
                id: base64UrlToBytes(id),
                type: 'public-key'
            })),
            attestation: 'none',
            timeout: 60000,
            extensions: {
                prf: {
                    eval: {
                        first: PRF_INPUT
                    }
                }
            }
        }
    });

    if (!credential || !prfWasEnabled(credential)) {
        throw new Error(
            'This passkey does not support encrypted data. Choose a PRF-capable passkey.'
        );
    }

    let prfBytes = getPrfResult(credential);
    if (!prfBytes) {
        ({ prfBytes } = await requestPrf([credential.id]));
    }

    try {
        return {
            credentialId: credential.id,
            operation: 'INITIALIZE',
            type: 'PASSKEY',
            version: WRAPPER_VERSION,
            wrappedKey: await wrapMasterKey(masterKey, prfBytes)
        };
    } finally {
        prfBytes.fill(0);
    }
}

/**
 * Prompt for one of the keyring credentials and unwrap the account master key.
 */
export async function unlockEncryptionKeyring(wrappers) {
    const passkeyWrappers = (wrappers || []).filter(wrapper =>
        wrapper?.type === 'PASSKEY' &&
        typeof wrapper?.credentialId === 'string' &&
        typeof wrapper?.wrappedKey === 'string'
    );
    if (passkeyWrappers.length === 0) {
        throw new Error('No encryption passkey is registered for this account');
    }

    const { credential, prfBytes } = await requestPrf(
        passkeyWrappers.map(wrapper => wrapper.credentialId)
    );
    try {
        const wrapper = passkeyWrappers.find(
            candidate => candidate.credentialId === credential.id
        );
        if (!wrapper) {
            throw new Error('The selected passkey is not registered for this account');
        }
        return {
            credentialId: credential.id,
            masterKey: await unwrapMasterKey(wrapper.wrappedKey, prfBytes)
        };
    } finally {
        prfBytes.fill(0);
    }
}

export const ENCRYPTION_KEY_FORMAT = Object.freeze({
    prfSaltId: PRF_SALT_ID,
    version: WRAPPER_VERSION
});
