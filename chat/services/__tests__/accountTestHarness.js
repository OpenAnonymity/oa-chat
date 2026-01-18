/**
 * Account Service Test Harness
 *
 * Provides mock implementations of server APIs and WebAuthn for local testing.
 * Usage: Import in browser console or test page, then run test scenarios.
 *
 * Example:
 *   import { AccountTestHarness } from './services/__tests__/accountTestHarness.js';
 *   const harness = new AccountTestHarness();
 *   await harness.runAllTests();
 */

// ============================================================================
// MOCK SERVER
// ============================================================================

/**
 * In-memory mock server that simulates the auth backend.
 * Stores accounts, credentials, and wrapped keys.
 */
export class MockAuthServer {
    constructor() {
        this.accounts = new Map();      // accountId -> { credentials, wrappedKeys }
        this.challenges = new Map();    // challenge -> { accountId, type, expiresAt }
    }

    reset() {
        this.accounts.clear();
        this.challenges.clear();
    }

    /**
     * Generate a 16-digit numeric account ID (server-side).
     */
    generateAccountId() {
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        let id = '';
        for (const byte of bytes) {
            id += String(byte % 100).padStart(2, '0');
        }
        return id;  // 16 digits
    }

    generateChallenge() {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return bytesToBase64Url(bytes);
    }

    // POST /auth/init
    // Two modes:
    // 1. New account: no accountId provided → server generates one
    // 2. Add device: accountId provided → use existing account (for registerCurrentDevice)
    init(body = {}) {
        const accountId = body.accountId || this.generateAccountId();
        const challenge = this.generateChallenge();

        this.challenges.set(challenge, {
            accountId,
            type: 'create',
            expiresAt: Date.now() + 60000
        });

        return {
            accountId,
            challenge,
            rpId: 'localhost',
            publicKey: {
                challenge,
                rp: { id: 'localhost', name: 'Test RP' },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                timeout: 60000,
                attestation: 'none'
            }
        };
    }

    // POST /auth/register
    register(body) {
        const { accountId, credential, wrappedKeyPasskey, wrappedKeyRecovery } = body;

        if (!accountId || !credential) {
            throw new Error('Missing accountId or credential');
        }

        let account = this.accounts.get(accountId);
        if (!account) {
            account = { credentials: [], wrappedKeys: {} };
            this.accounts.set(accountId, account);
        }

        account.credentials.push({
            id: credential.id,
            rawId: credential.rawId,
            publicKey: credential.response.attestationObject, // simplified
            createdAt: Date.now()
        });

        if (wrappedKeyPasskey) {
            account.wrappedKeys[credential.id] = wrappedKeyPasskey;
        }
        if (wrappedKeyRecovery) {
            account.wrappedKeys._recovery = wrappedKeyRecovery;
        }

        return { success: true };
    }

    // POST /auth/challenge
    challenge(body) {
        const { accountId, credentialId } = body;

        if (!accountId) {
            throw new Error('Missing accountId');
        }

        const account = this.accounts.get(accountId);
        if (!account) {
            throw new Error('Account not found');
        }

        const challenge = this.generateChallenge();
        this.challenges.set(challenge, {
            accountId,
            type: 'authenticate',
            expiresAt: Date.now() + 60000
        });

        const allowCredentials = account.credentials.map(c => ({
            type: 'public-key',
            id: c.id
        }));

        return {
            challenge,
            rpId: 'localhost',
            allowCredentials,
            wrappedKeyRecovery: account.wrappedKeys._recovery,
            publicKey: {
                challenge,
                rpId: 'localhost',
                allowCredentials,
                timeout: 60000,
                userVerification: 'required'
            }
        };
    }

    // POST /auth/login
    login(body) {
        const { accountId, credentialId, assertion } = body;

        if (!accountId || !credentialId) {
            throw new Error('Missing accountId or credentialId');
        }

        const account = this.accounts.get(accountId);
        if (!account) {
            throw new Error('Account not found');
        }

        const credential = account.credentials.find(c => c.id === credentialId);
        if (!credential) {
            throw new Error('Credential not found');
        }

        // In a real server, we'd verify the assertion signature here

        return {
            success: true,
            wrappedKeyPasskey: account.wrappedKeys[credentialId],
            wrappedKeyRecovery: account.wrappedKeys._recovery
        };
    }

    // POST /auth/recovery
    recovery(body) {
        const { accountId } = body;

        if (!accountId) {
            throw new Error('Missing accountId');
        }

        const account = this.accounts.get(accountId);
        if (!account) {
            throw new Error('Account not found');
        }

        return {
            wrappedKeyRecovery: account.wrappedKeys._recovery
        };
    }

    // Route handler
    handle(path, body) {
        switch (path) {
            case '/auth/init':
                return this.init(body);
            case '/auth/register':
                return this.register(body);
            case '/auth/challenge':
                return this.challenge(body);
            case '/auth/login':
                return this.login(body);
            case '/auth/recovery':
                return this.recovery(body);
            default:
                throw new Error(`Unknown path: ${path}`);
        }
    }
}

// ============================================================================
// MOCK WEBAUTHN
// ============================================================================

/**
 * Mock WebAuthn credentials manager.
 * Simulates passkey creation/authentication with PRF extension support.
 */
export class MockWebAuthn {
    constructor() {
        this.credentials = new Map();  // credentialId -> { privateKey, prfSecret }
        this.autoApprove = true;       // Set false to simulate user cancellation
    }

    reset() {
        this.credentials.clear();
    }

    generateCredentialId() {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return bytesToBase64Url(bytes);
    }

    // Simulates navigator.credentials.create()
    async create(options) {
        if (!this.autoApprove) {
            const error = new Error('User cancelled');
            error.name = 'NotAllowedError';
            throw error;
        }

        const { publicKey } = options;
        const credentialId = this.generateCredentialId();

        // Generate a deterministic PRF secret for this credential
        const prfSecret = new Uint8Array(32);
        crypto.getRandomValues(prfSecret);

        this.credentials.set(credentialId, { prfSecret });

        // Compute PRF output from the input
        const prfInput = publicKey.extensions?.prf?.eval?.first;
        const prfOutput = await this.computePrf(prfSecret, prfInput);

        // Create mock credential response
        const credential = {
            id: credentialId,
            rawId: base64UrlToBytes(credentialId),
            type: 'public-key',
            response: {
                clientDataJSON: new TextEncoder().encode(JSON.stringify({
                    type: 'webauthn.create',
                    challenge: bytesToBase64Url(new Uint8Array(publicKey.challenge)),
                    origin: 'http://localhost:8080'
                })),
                attestationObject: new Uint8Array(128) // Mock attestation
            },
            getClientExtensionResults: () => ({
                prf: {
                    results: {
                        first: prfOutput.buffer
                    }
                }
            })
        };

        return credential;
    }

    // Simulates navigator.credentials.get()
    async get(options) {
        if (!this.autoApprove) {
            const error = new Error('User cancelled');
            error.name = 'NotAllowedError';
            throw error;
        }

        const { publicKey } = options;

        // Find a matching credential
        let credentialId = null;
        let credData = null;

        if (publicKey.allowCredentials?.length > 0) {
            for (const allowed of publicKey.allowCredentials) {
                const id = typeof allowed.id === 'string'
                    ? allowed.id
                    : bytesToBase64Url(new Uint8Array(allowed.id));
                if (this.credentials.has(id)) {
                    credentialId = id;
                    credData = this.credentials.get(id);
                    break;
                }
            }
        }

        if (!credentialId) {
            const error = new Error('No matching credential found');
            error.name = 'NotFoundError';
            throw error;
        }

        // Compute PRF output
        const prfInput = publicKey.extensions?.prf?.eval?.first;
        const prfOutput = await this.computePrf(credData.prfSecret, prfInput);

        // Create mock assertion response
        const assertion = {
            id: credentialId,
            rawId: base64UrlToBytes(credentialId),
            type: 'public-key',
            response: {
                clientDataJSON: new TextEncoder().encode(JSON.stringify({
                    type: 'webauthn.get',
                    challenge: bytesToBase64Url(new Uint8Array(publicKey.challenge)),
                    origin: 'http://localhost:8080'
                })),
                authenticatorData: new Uint8Array(37), // Mock auth data
                signature: new Uint8Array(64),         // Mock signature
                userHandle: null
            },
            getClientExtensionResults: () => ({
                prf: {
                    results: {
                        first: prfOutput.buffer
                    }
                }
            })
        };

        return assertion;
    }

    // Compute deterministic PRF output from secret and input
    async computePrf(secret, input) {
        if (!input) {
            return null;
        }
        const inputBytes = input instanceof Uint8Array
            ? input
            : new Uint8Array(input);

        // HMAC-SHA256(secret, input) as PRF output
        const key = await crypto.subtle.importKey(
            'raw',
            secret,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const signature = await crypto.subtle.sign('HMAC', key, inputBytes);
        return new Uint8Array(signature);
    }
}

// ============================================================================
// UTILITIES
// ============================================================================

function bytesToBase64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlToBytes(input) {
    if (!input) return new Uint8Array();
    let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    const padding = base64.length % 4;
    if (padding) base64 += '='.repeat(4 - padding);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// ============================================================================
// TEST HARNESS
// ============================================================================

export class AccountTestHarness {
    constructor() {
        this.mockServer = new MockAuthServer();
        this.mockWebAuthn = new MockWebAuthn();
        this.originalFetch = null;
        this.originalCredentials = null;
        this.installed = false;
        this.testResults = [];
    }

    /**
     * Install mocks into the global environment.
     */
    install() {
        if (this.installed) return;

        // Mock fetch
        this.originalFetch = window.fetch;
        window.fetch = async (url, options = {}) => {
            const urlStr = typeof url === 'string' ? url : url.toString();

            // Extract path from URL - handles both full URLs and relative paths
            let path;
            try {
                const urlObj = new URL(urlStr);
                path = urlObj.pathname;
            } catch {
                path = urlStr;
            }

            // Only intercept /auth/* requests
            if (!path.includes('/auth/')) {
                return this.originalFetch.call(window, url, options);
            }

            // Normalize path to just /auth/*
            const authPath = path.substring(path.indexOf('/auth'));

            try {
                const body = options.body ? JSON.parse(options.body) : {};
                const data = this.mockServer.handle(authPath, body);
                return new Response(JSON.stringify(data), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (error) {
                return new Response(JSON.stringify({ error: error.message }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        };

        // Mock navigator.credentials
        this.originalCredentials = navigator.credentials;
        Object.defineProperty(navigator, 'credentials', {
            value: {
                create: (options) => this.mockWebAuthn.create(options),
                get: (options) => this.mockWebAuthn.get(options)
            },
            configurable: true
        });

        this.installed = true;
        console.log('[TestHarness] Mocks installed');
    }

    /**
     * Uninstall mocks and restore originals.
     */
    uninstall() {
        if (!this.installed) return;

        window.fetch = this.originalFetch;
        Object.defineProperty(navigator, 'credentials', {
            value: this.originalCredentials,
            configurable: true
        });

        this.installed = false;
        console.log('[TestHarness] Mocks uninstalled');
    }

    /**
     * Reset all state.
     */
    reset() {
        this.mockServer.reset();
        this.mockWebAuthn.reset();
        this.testResults = [];
    }

    /**
     * Log a test result.
     */
    log(name, passed, details = '') {
        const result = { name, passed, details };
        this.testResults.push(result);
        const icon = passed ? '✓' : '✗';
        const color = passed ? 'color: green' : 'color: red';
        console.log(`%c${icon} ${name}`, color, details);
    }

    /**
     * Run all tests.
     */
    async runAllTests() {
        console.log('\n========== ACCOUNT SERVICE TESTS ==========\n');

        this.install();
        this.reset();

        try {
            await this.testAccountCreation();
            await this.testAccountLockUnlock();
            await this.testRecoveryCodeUnlock();
            await this.testMultiDeviceRegistration();
            await this.testErrorHandling();
            await this.testRateLimiting();
            await this.testNewCreationFlow();
            await this.testPasskeyRetryWithSameNumber();
            await this.testCancelCreation();
        } catch (error) {
            console.error('Test suite error:', error);
        }

        console.log('\n========== RESULTS ==========');
        const passed = this.testResults.filter(r => r.passed).length;
        const total = this.testResults.length;
        console.log(`Passed: ${passed}/${total}`);

        this.uninstall();
        return this.testResults;
    }

    /**
     * Test account creation flow.
     */
    async testAccountCreation() {
        console.log('\n--- Account Creation ---');

        // Get the accountService (assumes it's already imported in the page)
        const accountService = (await import('../accountService.js')).default;

        // Clear any existing state
        await accountService.clearLocalAccount();
        await accountService.init();

        // Create account
        const created = await accountService.createAccount();
        this.log('Account created', created);

        const state = accountService.getState();
        this.log('Account ID generated', !!state.accountId, state.accountId);
        this.log('Credential ID stored', !!state.credentialId);
        this.log('Recovery code generated', !!state.recoveryCode, state.recoveryCode);
        this.log('Status is unlocked', state.status === 'unlocked', state.status);

        // Store for later tests
        this._testAccountId = state.accountId;
        this._testRecoveryCode = state.recoveryCode;

        // Confirm recovery code saved
        accountService.confirmRecoveryCodeSaved();
        const stateAfter = accountService.getState();
        this.log('Recovery code cleared after confirm', !stateAfter.recoveryCode);
        this.log('Recovery confirmed flag set', stateAfter.recoveryConfirmed);
    }

    /**
     * Test lock and unlock with passkey.
     */
    async testAccountLockUnlock() {
        console.log('\n--- Lock/Unlock ---');

        const accountService = (await import('../accountService.js')).default;

        // Lock the account
        accountService.lock();
        let state = accountService.getState();
        this.log('Account locked', state.status === 'locked', state.status);

        const masterKeyAfterLock = accountService.getMasterKey();
        this.log('Master key cleared on lock', !masterKeyAfterLock);

        // Unlock with passkey
        const unlocked = await accountService.unlockWithPasskey(this._testAccountId);
        state = accountService.getState();
        this.log('Account unlocked with passkey', unlocked && state.status === 'unlocked');

        const masterKey = accountService.getMasterKey();
        this.log('Master key restored', !!masterKey && masterKey.length === 32);
    }

    /**
     * Test recovery code unlock.
     */
    async testRecoveryCodeUnlock() {
        console.log('\n--- Recovery Code Unlock ---');

        const accountService = (await import('../accountService.js')).default;

        // Lock and clear credential (simulate new device)
        accountService.lock();
        accountService.state.credentialId = null;

        // Unlock with recovery code
        const unlocked = await accountService.unlockWithRecoveryCode(
            this._testAccountId,
            this._testRecoveryCode
        );

        const state = accountService.getState();
        this.log('Unlocked with recovery code', unlocked && state.status === 'unlocked');

        const masterKey = accountService.getMasterKey();
        this.log('Master key matches original', !!masterKey && masterKey.length === 32);
    }

    /**
     * Test multi-device registration.
     */
    async testMultiDeviceRegistration() {
        console.log('\n--- Multi-Device Registration ---');

        const accountService = (await import('../accountService.js')).default;

        // Simulate being unlocked via recovery, no local passkey
        accountService.state.credentialId = null;

        // Register this device
        const registered = await accountService.registerCurrentDevice();
        this.log('Device registered', registered);

        const state = accountService.getState();
        this.log('New credential ID stored', !!state.credentialId);

        // Lock and unlock with new passkey
        accountService.lock();
        const unlocked = await accountService.unlockWithPasskey(this._testAccountId);
        this.log('Unlock with new passkey', unlocked);
    }

    /**
     * Test error handling.
     */
    async testErrorHandling() {
        console.log('\n--- Error Handling ---');

        const accountService = (await import('../accountService.js')).default;

        // Test cancellation
        this.mockWebAuthn.autoApprove = false;
        const cancelled = await accountService.unlockWithPasskey('INVALID123');
        const state = accountService.getState();
        this.log('Handles passkey cancellation', !cancelled && !!state.error);
        this.mockWebAuthn.autoApprove = true;

        // Test invalid recovery code
        accountService.clearErrors();
        const badRecovery = await accountService.unlockWithRecoveryCode(
            this._testAccountId,
            'invalid-code'
        );
        this.log('Rejects invalid recovery code format', !badRecovery);

        // Test wrong recovery code (valid format, wrong words)
        await accountService.clearLocalAccount();
        await accountService.createAccount();
        accountService.lock();

        const wrongRecovery = await accountService.unlockWithRecoveryCode(
            accountService.state.accountId,
            'tuba-kemo-fila-groe-bazi'  // Wrong 5-word code
        );
        this.log('Rejects wrong recovery code', !wrongRecovery);
    }

    /**
     * Test rate limiting.
     */
    async testRateLimiting() {
        console.log('\n--- Rate Limiting ---');

        const accountService = (await import('../accountService.js')).default;

        // Clear state and create fresh account
        await accountService.clearLocalAccount();
        accountService.clearRateLimit();
        await accountService.createAccount();
        const correctRecovery = accountService.state.recoveryCode;
        accountService.lock();

        // Make several failed attempts
        for (let i = 0; i < 3; i++) {
            await accountService.unlockWithRecoveryCode(
                accountService.state.accountId,
                'wrong-code-here-test-word'
            );
        }

        // Check rate limiting kicks in with backoff
        const delay = accountService.getRateLimitDelay();
        this.log('Rate limit delay increases after failures', delay > 0, `${delay}ms delay`);

        // Verify state reflects rate limiting
        const state = accountService.getState();
        this.log('Rate limited state flag set', state.rateLimited === true);

        // Clear and verify we can still unlock with correct code
        accountService.clearRateLimit();
        const success = await accountService.unlockWithRecoveryCode(
            accountService.state.accountId,
            correctRecovery
        );
        this.log('Can unlock after rate limit cleared', success);
    }

    /**
     * Test new multi-step creation flow with client-generated ID.
     * Tests: prepareAccount → registerPasskeyForPreparedAccount →
     *        generateRecoveryForPreparedAccount → completeAccountRegistration
     */
    async testNewCreationFlow() {
        console.log('\n--- New Multi-Step Creation Flow ---');

        const accountService = (await import('../accountService.js')).default;

        // Clear any existing state
        await accountService.clearLocalAccount();
        await accountService.init();

        // Step 1: Prepare account (generates ID + master key client-side)
        const accountId = await accountService.prepareAccount();
        this.log('Step 1: prepareAccount() returns ID', !!accountId, accountId);
        this.log('Account ID is 16 digits', /^\d{16}$/.test(accountId));
        this.log('hasPendingAccount() is true', accountService.hasPendingAccount());
        this.log('getPendingAccountId() matches', accountService.getPendingAccountId() === accountId);

        // State should still be 'none' since we haven't completed registration
        let state = accountService.getState();
        this.log('Status still none during pending', state.status === 'none');

        // Step 2: Register passkey for prepared account
        const passkeySuccess = await accountService.registerPasskeyForPreparedAccount();
        this.log('Step 2: registerPasskeyForPreparedAccount() succeeds', passkeySuccess);
        this.log('pendingAccount has credential', !!accountService.pendingAccount?.credential);
        this.log('pendingAccount has prfBytes', !!accountService.pendingAccount?.prfBytes);

        // Step 3: Generate recovery code
        const recoveryCode = await accountService.generateRecoveryForPreparedAccount();
        this.log('Step 3: generateRecoveryForPreparedAccount() returns code', !!recoveryCode);
        this.log('Recovery code is 5 words', recoveryCode?.split('-').length === 5);
        this.log('pendingAccount has recoveryCode', accountService.pendingAccount?.recoveryCode === recoveryCode);

        // Store for later tests
        this._newFlowAccountId = accountId;
        this._newFlowRecoveryCode = recoveryCode;

        // Step 4: Complete registration (calls server)
        const completeSuccess = await accountService.completeAccountRegistration();
        this.log('Step 4: completeAccountRegistration() succeeds', completeSuccess);

        // Verify final state
        state = accountService.getState();
        this.log('Status is unlocked after complete', state.status === 'unlocked');
        this.log('Account ID matches', state.accountId === accountId);
        this.log('Credential ID is set', !!state.credentialId);
        this.log('hasPendingAccount() is false after complete', !accountService.hasPendingAccount());

        // Verify master key is accessible
        const masterKey = accountService.getMasterKey();
        this.log('Master key available', !!masterKey && masterKey.length === 32);

        // Verify can lock and unlock with passkey
        accountService.lock();
        const unlocked = await accountService.unlockWithPasskey(accountId);
        this.log('Can unlock with passkey after new flow', unlocked);

        // Verify can unlock with recovery code
        accountService.lock();
        const recoveryUnlock = await accountService.unlockWithRecoveryCode(accountId, recoveryCode);
        this.log('Can unlock with recovery code after new flow', recoveryUnlock);
    }

    /**
     * Test passkey retry with same account number.
     * Simulates user cancelling passkey prompt then retrying.
     */
    async testPasskeyRetryWithSameNumber() {
        console.log('\n--- Passkey Retry With Same Number ---');

        const accountService = (await import('../accountService.js')).default;

        // Clear and start fresh
        await accountService.clearLocalAccount();
        await accountService.init();

        // Step 1: Prepare account
        const accountId = await accountService.prepareAccount();
        this.log('Initial account ID generated', !!accountId);

        // Step 2: Simulate passkey cancellation
        this.mockWebAuthn.autoApprove = false;
        const firstAttempt = await accountService.registerPasskeyForPreparedAccount();
        this.log('First passkey attempt fails (user cancelled)', !firstAttempt);

        // Verify pending account is preserved
        this.log('hasPendingAccount() still true after failure', accountService.hasPendingAccount());
        this.log('Account ID unchanged', accountService.getPendingAccountId() === accountId);
        this.log('Master key still exists in pending', !!accountService.pendingAccount?.masterKey);

        // Step 3: Retry passkey registration
        this.mockWebAuthn.autoApprove = true;
        const retryAttempt = await accountService.registerPasskeyForPreparedAccount();
        this.log('Retry passkey attempt succeeds', retryAttempt);
        this.log('Account ID still matches', accountService.getPendingAccountId() === accountId);

        // Step 4: Complete the flow
        const recoveryCode = await accountService.generateRecoveryForPreparedAccount();
        this.log('Recovery code generated', !!recoveryCode);

        const completed = await accountService.completeAccountRegistration();
        this.log('Registration completed with same ID', completed);

        const state = accountService.getState();
        this.log('Final account ID matches original', state.accountId === accountId);
    }

    /**
     * Test cancellation of pending account creation.
     * Verifies cleanup of sensitive data.
     */
    async testCancelCreation() {
        console.log('\n--- Cancel Creation Flow ---');

        const accountService = (await import('../accountService.js')).default;

        // Clear and start fresh
        await accountService.clearLocalAccount();
        await accountService.init();

        // Prepare account
        const accountId = await accountService.prepareAccount();
        this.log('Account prepared', !!accountId);

        // Verify pending state exists
        const pendingMasterKey = accountService.pendingAccount?.masterKey;
        this.log('Pending master key exists', !!pendingMasterKey);

        // Cancel the creation
        accountService.cancelPendingAccount();

        // Verify cleanup
        this.log('hasPendingAccount() is false after cancel', !accountService.hasPendingAccount());
        this.log('pendingAccount is null', accountService.pendingAccount === null);

        // Verify state is back to none
        const state = accountService.getState();
        this.log('Status is none after cancel', state.status === 'none');

        // Test cancel after passkey registration
        const accountId2 = await accountService.prepareAccount();
        this.log('Second account prepared', !!accountId2);

        const passkeySuccess = await accountService.registerPasskeyForPreparedAccount();
        this.log('Passkey registered', passkeySuccess);

        // Verify more state exists now
        this.log('Pending has credential before cancel', !!accountService.pendingAccount?.credential);

        // Cancel after passkey
        accountService.cancelPendingAccount();
        this.log('hasPendingAccount() false after late cancel', !accountService.hasPendingAccount());

        // Test cancel after recovery code generation
        const accountId3 = await accountService.prepareAccount();
        await accountService.registerPasskeyForPreparedAccount();
        const recovery = await accountService.generateRecoveryForPreparedAccount();
        this.log('Full pending state exists', !!recovery && !!accountService.pendingAccount?.credential);

        accountService.cancelPendingAccount();
        this.log('All pending state cleared on final cancel', !accountService.hasPendingAccount());

        // Ensure no server-side account was created
        const state2 = accountService.getState();
        this.log('No account ID in state after cancels', !state2.accountId);
    }
}

// ============================================================================
// STANDALONE USAGE
// ============================================================================

/**
 * Quick test runner for console usage.
 * Usage: import('./services/__tests__/accountTestHarness.js').then(m => m.runTests())
 */
export async function runTests() {
    const harness = new AccountTestHarness();
    return await harness.runAllTests();
}

// Auto-expose for console debugging
if (typeof window !== 'undefined') {
    window.AccountTestHarness = AccountTestHarness;
    window.MockAuthServer = MockAuthServer;
    window.MockWebAuthn = MockWebAuthn;

    /**
     * Quick setup for console use in the main app.
     * Usage: paste this in console on /chat/:
     *   import('./services/__tests__/accountTestHarness.js').then(m => m.enableMocks())
     */
    window.enableAccountMocks = () => {
        const harness = new AccountTestHarness();
        harness.install();
        window._accountTestHarness = harness;
        console.log('%c✓ Account mocks enabled', 'color: green; font-weight: bold');
        console.log('  - Server calls now intercepted');
        console.log('  - Passkey prompts auto-approved');
        console.log('  - To disable: window._accountTestHarness.uninstall()');
        console.log('  - To reset state: window._accountTestHarness.reset()');
        return harness;
    };
}

/**
 * Enable mocks - call this after importing.
 */
export function enableMocks() {
    if (typeof window !== 'undefined' && window.enableAccountMocks) {
        return window.enableAccountMocks();
    }
    const harness = new AccountTestHarness();
    harness.install();
    return harness;
}
