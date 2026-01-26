import { PROXY_URL } from '../config.js';
import transportHints from './inference/transportHints.js';
import preferencesStore, { PREF_KEYS } from './preferencesStore.js';
import { fetchRetry, fetchRetryJson } from './fetchRetry.js';

const DEFAULT_SETTINGS = {
    enabled: false,
    fallbackToDirect: true
};

// TLS info parsing patterns (supports both OpenSSL and mbedTLS output formats)
const TLS_PATTERNS = {
    // OpenSSL: "SSL connection using TLSv1.3 / ..."
    // mbedTLS: "mbedTLS: TLSv1.3 Handshake complete, cipher is ..."
    // Also match: "TLSv1.3 (OUT)" style output
    version: /(?:SSL connection using |mbedTLS:\s*|Using\s+)(TLS[v\s\d.]+|SSLv[\d.]+)/i,
    cipher: /(?:SSL connection using .+?[\/,]\s*|cipher(?:\s+is)?\s*[:=]?\s*)([A-Z][A-Z0-9_-]+(?:_[A-Z0-9_]+)*)/i,
    // mbedTLS: "*  subject name      : CN=provider.example"
    // OpenSSL: "* subject: CN=..."
    // Also: "server certificate:" followed by subject info
    certSubject: /\*?\s*(?:subject(?:\s+name)?|common\s+name)\s*[:=]\s*(.+)/i,
    certIssuer: /\*?\s*issuer(?:\s+name)?\s*[:=]\s*(.+)/i,
    certExpire: /\*?\s*(?:expires?|expir(?:e|y)\s*date|not\s+after)\s*[:=]?\s*(.+)/i,
    certStart: /\*?\s*(?:issued\s*on|start\s*date|not\s+before)\s*[:=]?\s*(.+)/i,
    verified: /(?:SSL (?:certificate )?verif|certificate ok|verify return|cert verify)/i,
    serverCert: /Server certificate:/i,
    alpn: /ALPN[:\s]+(?:server accepted\s+|h2\s+)?(h2|http\/1\.1|[^\s,]+)/i,
    // HTTP/2 detection (indicates TLS worked)
    http2: /\[HTTP\/2\]|http2|using HTTP\/2/i,
    // Connection established (fallback indicator that TLS worked)
    connected: /(?:Connected to|SSL connection established|Handshake complete)/i
};

class NetworkProxy {
    constructor() {
        this.eventTarget = new EventTarget();
        this.state = {
            settings: this.normalizeSettings({}),
            activeProxyUrl: null,
            ready: false,
            usingProxy: false,
            connectionVerified: false,
            fallbackActive: false,
            lastError: null,
            lastFailureAt: null,
            lastSuccessAt: null,
            initialized: false,
            transport: 'idle'
        };

        this.prefUnsubscribe = preferencesStore.onChange((key, value) => {
            if (key !== PREF_KEYS.proxySettings || !value) return;
            this.updateSettings(value, { skipPersist: true }).catch((error) => {
                console.warn('Failed to sync proxy settings from preferences:', error);
            });
        });

        this.libcurlReadyPromise = null;
        // Managed HTTPSession - closed and recreated on proxy switch
        this.httpSession = null;

        // TLS inspection state
        this.tlsInfo = {
            version: null,
            cipher: null,
            certSubject: null,
            certIssuer: null,
            certExpireDate: null,
            certStartDate: null,
            verified: false,
            alpn: null,
            lastUpdated: null,
            requestCount: 0,
            bytesEncrypted: 0,
            rawLogs: []
        };
        this.tlsInspectionEnabled = false;
        this.originalStderr = null;

        // Proxy initialization is deferred to syncWithDatabase() called by app.js
        // This avoids duplicate initialization and ensures proper sequencing
    }

    normalizeSettings(rawSettings = {}) {
        return {
            enabled: rawSettings.enabled !== undefined ? !!rawSettings.enabled : DEFAULT_SETTINGS.enabled,
            url: PROXY_URL, // Always use hardcoded URL
            fallbackToDirect: rawSettings.fallbackToDirect !== false
        };
    }

    async syncWithPreferences() {
        const stored = await preferencesStore.getPreference(PREF_KEYS.proxySettings);
        if (stored && typeof stored === 'object') {
            await this.updateSettings(stored, { skipPersist: true, silent: true });
            this.emitChange();
        }
        return this.getSettings();
    }

    getSettings() {
        return JSON.parse(JSON.stringify(this.state.settings));
    }

    getStatus() {
        return {
            enabled: this.state.settings.enabled,
            activeProxyUrl: this.state.activeProxyUrl,
            ready: this.state.ready,
            usingProxy: this.state.usingProxy,
            connectionVerified: this.state.connectionVerified,
            fallbackActive: this.state.fallbackActive,
            lastError: this.state.lastError,
            lastFailureAt: this.state.lastFailureAt,
            lastSuccessAt: this.state.lastSuccessAt,
            transport: this.state.transport,
            tlsVerified: this.tlsInfo.verified && this.tlsInfo.version !== null
        };
    }

    // === TLS Inspection Methods ===

    getTlsInfo() {
        return { ...this.tlsInfo };
    }

    resetTlsInfo() {
        this.tlsInfo = {
            version: null,
            cipher: null,
            certSubject: null,
            certIssuer: null,
            certExpireDate: null,
            certStartDate: null,
            verified: false,
            alpn: null,
            lastUpdated: null,
            requestCount: 0,
            bytesEncrypted: 0,
            rawLogs: []
        };
    }

    enableTlsInspection() {
        if (this.tlsInspectionEnabled) return;

        const libcurl = window.libcurl;
        if (!libcurl) {
            console.warn('[networkProxy] Cannot enable TLS inspection - libcurl not ready');
            return false;
        }

        // Save original stderr handler
        this.originalStderr = libcurl.stderr;

        // Hook stderr to capture TLS handshake output (silently - no console spam)
        libcurl.stderr = (text) => {
            // Parse TLS info from verbose output (don't log to console - too noisy)
            this.parseTlsOutput(text);
        };

        this.tlsInspectionEnabled = true;
        console.log('[networkProxy] TLS inspection enabled');
        return true;
    }

    disableTlsInspection() {
        if (!this.tlsInspectionEnabled) return;

        const libcurl = window.libcurl;
        if (libcurl && this.originalStderr !== null) {
            libcurl.stderr = this.originalStderr;
        }

        this.tlsInspectionEnabled = false;
        this.originalStderr = null;
        console.log('[networkProxy] TLS inspection disabled');
    }

    parseTlsOutput(text) {
        if (!text || typeof text !== 'string') return;

        // Store raw log (keep last 50 entries)
        this.tlsInfo.rawLogs.push({ timestamp: Date.now(), text });
        if (this.tlsInfo.rawLogs.length > 50) {
            this.tlsInfo.rawLogs.shift();
        }

        let foundTlsInfo = false;

        // Parse TLS version and cipher
        const versionMatch = text.match(TLS_PATTERNS.version);
        if (versionMatch) {
            this.tlsInfo.version = versionMatch[1].trim();
            this.tlsInfo.lastUpdated = Date.now();
            foundTlsInfo = true;
        }

        const cipherMatch = text.match(TLS_PATTERNS.cipher);
        if (cipherMatch) {
            this.tlsInfo.cipher = cipherMatch[1].trim();
            foundTlsInfo = true;
        }

        // Parse certificate info
        const subjectMatch = text.match(TLS_PATTERNS.certSubject);
        if (subjectMatch) {
            this.tlsInfo.certSubject = subjectMatch[1].trim();
            foundTlsInfo = true;
        }

        const issuerMatch = text.match(TLS_PATTERNS.certIssuer);
        if (issuerMatch) {
            this.tlsInfo.certIssuer = issuerMatch[1].trim();
            foundTlsInfo = true;
        }

        const expireMatch = text.match(TLS_PATTERNS.certExpire);
        if (expireMatch) {
            this.tlsInfo.certExpireDate = expireMatch[1].trim();
        }

        const startMatch = text.match(TLS_PATTERNS.certStart);
        if (startMatch) {
            this.tlsInfo.certStartDate = startMatch[1].trim();
        }

        // Parse verification status
        if (TLS_PATTERNS.verified.test(text)) {
            this.tlsInfo.verified = true;
            foundTlsInfo = true;
        }

        // Parse ALPN protocol (HTTP/2 means TLS is working)
        const alpnMatch = text.match(TLS_PATTERNS.alpn);
        if (alpnMatch) {
            this.tlsInfo.alpn = alpnMatch[1].trim();
            foundTlsInfo = true;
        }

        // HTTP/2 detection indicates TLS is active
        if (TLS_PATTERNS.http2.test(text) && !this.tlsInfo.alpn) {
            this.tlsInfo.alpn = 'h2';
            this.tlsInfo.verified = true;
            if (!this.tlsInfo.version) {
                this.tlsInfo.version = 'TLSv1.2+'; // HTTP/2 requires at least TLS 1.2
            }
            foundTlsInfo = true;
        }

        // Connection established indicator
        if (TLS_PATTERNS.connected.test(text)) {
            this.tlsInfo.verified = true;
            this.tlsInfo.lastUpdated = Date.now();
            foundTlsInfo = true;
        }

        // Emit change if we got meaningful TLS info
        if (foundTlsInfo) {
            this.emitChange();
        }
    }

    // Track encrypted request for stats
    trackEncryptedRequest(bytesSent = 0) {
        this.tlsInfo.requestCount++;
        this.tlsInfo.bytesEncrypted += bytesSent;
    }

    // Force a fresh TLS handshake by closing current session and making a new request
    // This is only needed if user wants to re-verify TLS (normally TLS info is captured automatically)
    async verifyTls(targetUrl = transportHints.getTransportHints().tlsVerifyUrl) {
        if (!this.state.settings.enabled) {
            throw new Error('Proxy not enabled');
        }
        if (!targetUrl) {
            throw new Error('No TLS verification target configured for this backend.');
        }

        // Ensure inspection is enabled
        this.enableTlsInspection();

        // If we already have TLS info captured, just return it (no need to force new handshake)
        if (this.tlsInfo.version !== null) {
            console.debug('[networkProxy] Returning existing TLS info:', this.tlsInfo);
            return {
                success: true,
                tlsInfo: this.getTlsInfo(),
                url: targetUrl,
                cached: true
            };
        }

        // Force new connection by closing session - this will trigger fresh TLS handshake
        if (this.httpSession) {
            this.httpSession.close();
            this.httpSession = null;
        }

        // Reset TLS info for fresh capture
        this.resetTlsInfo();

        try {
            console.log('[networkProxy] Forcing new TLS handshake to:', targetUrl);

            // Re-apply proxy to create new session
            await this.ensureProxyApplied(true);

            if (!this.httpSession) {
                throw new Error('Failed to create new session');
            }

            // Make request - the new connection will trigger TLS handshake output
            const response = await this.httpSession.fetch(targetUrl, {
                method: 'HEAD',
                signal: AbortSignal.timeout(10000)
            });

            // Wait a brief moment for stderr callbacks to process
            await new Promise(resolve => setTimeout(resolve, 100));

            const tlsInfo = this.getTlsInfo();
            console.log('[networkProxy] TLS verification complete:', tlsInfo);

            return {
                success: true,
                tlsInfo,
                status: response.status,
                url: targetUrl
            };
        } catch (error) {
            console.error('[networkProxy] TLS verification failed:', error);
            return {
                success: false,
                error: error.message,
                tlsInfo: this.getTlsInfo(),
                url: targetUrl
            };
        }
    }

    emitChange() {
        const detail = {
            settings: this.getSettings(),
            status: this.getStatus()
        };
        this.eventTarget.dispatchEvent(new CustomEvent('change', { detail }));
        window.dispatchEvent(new CustomEvent('proxy-settings-changed', { detail }));
    }

    onChange(callback) {
        const handler = (event) => callback(event.detail);
        this.eventTarget.addEventListener('change', handler);
        return () => this.eventTarget.removeEventListener('change', handler);
    }

    async initialize() {
        if (this.state.initialized) {
            return;
        }

        this.state.initialized = true;

        if (this.state.settings.enabled) {
            await this.ensureProxyApplied().catch((error) => {
                this.state.lastError = error;
            });
        }

        this.emitChange();
    }

    async saveSettings(settings) {
        // Only persist enabled and fallbackToDirect (URL is hardcoded)
        await preferencesStore.savePreference(PREF_KEYS.proxySettings, {
            enabled: settings.enabled,
            fallbackToDirect: settings.fallbackToDirect
        });
    }

    getActiveProxyUrl(settings = this.state.settings) {
        if (!settings.enabled) return null;
        return PROXY_URL;
    }

    async updateSettings(partial, options = {}) {
        const wasEnabled = this.state.settings.enabled;
        this.state.settings = this.normalizeSettings({ ...this.state.settings, ...partial });

        if (!options.skipPersist) {
            await this.saveSettings(this.state.settings);
        }

        if (this.state.settings.enabled) {
            // Force reconnect if proxy was just enabled
            const force = !wasEnabled;
            await this.ensureProxyApplied(force).catch((error) => {
                this.state.lastError = error;
            });
        } else {
            // Proxy disabled - close session and reset state
            if (this.httpSession) {
                this.httpSession.close();
                this.httpSession = null;
            }
            this.state.activeProxyUrl = null;
            this.state.usingProxy = false;
            this.state.ready = false;
        }

        if (!options.silent) {
            this.emitChange();
        }

        return this.getSettings();
    }

    async ensureProxyApplied(force = false) {
        if (!this.state.settings.enabled) {
            return;
        }
        const url = this.getActiveProxyUrl();
        if (!url) {
            throw new Error('Relay not configured');
        }

        try {
            console.debug('[networkProxy] Ensuring proxy is applied, url:', url);
            const libcurl = await this.ensureLibcurlReady();

            console.debug('[networkProxy] Got libcurl:', {
                exists: !!libcurl,
                type: typeof libcurl,
                ready: libcurl?.ready,
                hasSetWebsocket: typeof libcurl?.set_websocket,
                hasFetch: typeof libcurl?.fetch,
                keys: libcurl ? Object.keys(libcurl).slice(0, 10) : []
            });

            if (!libcurl) {
                throw new Error('libcurl.js object is not available after initialization');
            }

            if (typeof libcurl.set_websocket !== 'function') {
                console.error('[networkProxy] libcurl object:', libcurl);
                console.error('[networkProxy] libcurl properties:', Object.keys(libcurl));
                throw new Error('libcurl.js is loaded but set_websocket function is unavailable');
            }

            const needsReconnect = force || this.state.activeProxyUrl !== url;
            if (needsReconnect) {
                console.log('[networkProxy] Setting websocket to:', url);

                // Enable TLS inspection BEFORE creating session (to capture first handshake)
                this.enableTlsInspection();
                this.resetTlsInfo();

                // Close existing session to force new connections through new proxy
                if (this.httpSession) {
                    console.log('[networkProxy] Closing existing HTTPSession');
                    this.httpSession.close();
                    this.httpSession = null;
                }

                // Reset transport and set new proxy URL
                libcurl.transport = 'wisp';
                libcurl.set_websocket(url);

                // Create new session that will use the new proxy URL
                this.httpSession = new libcurl.HTTPSession();
                console.log('[networkProxy] Created new HTTPSession for proxy:', url);

                this.state.activeProxyUrl = url;
                this.state.usingProxy = false;
                this.state.connectionVerified = false;
            }

            this.state.ready = true;
            this.state.fallbackActive = false;
            this.state.lastError = null;

            // Verify connection with lightweight test (non-blocking)
            if (needsReconnect || !this.state.connectionVerified) {
                // Run verification in background - don't block user actions
                this.verifyConnection().catch(e => {
                    console.warn('[networkProxy] Background verification failed:', e.message);
                });
            }

            console.debug('[networkProxy] Proxy ready');
        } catch (error) {
            console.error('[networkProxy] Failed to apply proxy:', error);
            this.state.ready = false;
            this.state.activeProxyUrl = null;
            throw error;
        } finally {
            this.emitChange();
        }
    }

    async reconnect() {
        this.state.connectionVerified = false;
        return this.ensureProxyApplied(true);
    }

    async verifyConnection() {
        console.log('[networkProxy] Verifying proxy connection...');
        // Use example.com for ultra-lightweight verification (~1KB response)
        // TLS info is captured from actual inference requests, not this test
        const testUrl = 'https://example.com/';

        if (!this.httpSession) {
            throw new Error('HTTPSession not initialized');
        }

        try {
            const startTime = Date.now();
            const response = await this.httpSession.fetch(testUrl, {
                method: 'HEAD', // HEAD is even lighter - no body
                signal: AbortSignal.timeout(5000)
            });
            const duration = Date.now() - startTime;

            // Any HTTP response means proxy is working
            console.log('[networkProxy] ✅ Proxy verified in', duration + 'ms');
            this.state.connectionVerified = true;
            this.state.usingProxy = true;
            this.emitChange();
            return true;
        } catch (error) {
            const msg = error.message || '';

            // Error 18 (partial file) or 56 (recv failure) = proxy connected but response incomplete
            // This still means the proxy IS working
            if (msg.includes('error code 18') || msg.includes('error code 56')) {
                console.log('[networkProxy] ⚠️ Proxy connected (partial response) - assuming OK');
                this.state.connectionVerified = true;
                this.state.usingProxy = true;
                this.emitChange();
                return true;
            }

            // Error 7 = couldn't connect at all
            console.error('[networkProxy] ❌ Proxy verification failed:', msg);
            this.state.connectionVerified = false;
            this.state.usingProxy = false;
            this.state.lastError = error;
            this.emitChange();
            throw new Error(`Proxy not reachable: ${msg}`);
        }
    }

    async ensureLibcurlReady() {
        if (typeof window === 'undefined') {
            throw new Error('libcurl is only available in the browser.');
        }

        // Check if already ready
        if (window.libcurl && window.libcurl.ready) {
            this.enableTlsInspection();
            return window.libcurl;
        }

        // Trigger lazy loading if not started
        if (window.initLibcurl) {
            window.initLibcurl();
        }

        // Use the promise from index.html
        if (!window.libcurlReadyPromise) {
            throw new Error('libcurlReadyPromise not found');
        }

        console.debug('[networkProxy] Loading libcurl...');
        const libcurl = await window.libcurlReadyPromise;

        if (libcurl && !window.libcurl) {
            window.libcurl = libcurl;
        }

        this.enableTlsInspection();
        return libcurl || window.libcurl;
    }

    async fetch(resource, init = {}, config = {}) {
        const preferProxy = config.bypassProxy ? false : this.state.settings.enabled;
        const forceProxy = !!config.forceProxy;

        const url = typeof resource === 'string' ? resource : resource.url;
        console.log('[networkProxy.fetch] Request to:', url?.substring(0, 100), 'preferProxy:', preferProxy);

        if (!preferProxy) {
            console.log('[networkProxy.fetch] Using direct fetch (proxy disabled)');
            this.state.transport = 'direct';
            // Don't set fallbackActive here - this is an intentional bypass, not a failure fallback
            // Use credentials: 'omit' to prevent third-party cookie storage
            return fetch(resource, { ...init, credentials: 'omit' });
        }

        try {
            await this.ensureProxyApplied();

            // Double-check that session is available after initialization
            if (!this.httpSession) {
                throw new Error('HTTPSession not available after initialization');
            }

            console.log('[networkProxy.fetch] 🔐 Using HTTPSession.fetch (encrypted via proxy) for:', url?.substring(0, 100));
            const startTime = Date.now();

            // Auto-enable verbose mode for inference requests to capture TLS info
            // This ensures users see the inference provider certificate, not internal test endpoints
            const captureHost = transportHints.shouldCaptureTlsForUrl(url);
            const certSubject = this.tlsInfo.certSubject?.toLowerCase() || '';
            const needsTlsCapture = !!captureHost && !certSubject.includes(captureHost.toLowerCase());
            const fetchInit = (config.inspectTls || needsTlsCapture) ? { ...init, _libcurl_verbose: 1 } : init;
            const response = await this.httpSession.fetch(resource, fetchInit);
            const duration = Date.now() - startTime;
            console.log('[networkProxy.fetch] ✅ HTTPSession.fetch succeeded in', duration + 'ms', 'status:', response.status);

            // Track encrypted request
            const bodySize = init?.body?.length || init?.body?.byteLength || 0;
            this.trackEncryptedRequest(bodySize);

            // Mark connection as verified on successful request (lazy verification)
            if (!this.state.connectionVerified) {
                console.log('[networkProxy] ✅ Proxy verified via first real request');
            }
            this.state.connectionVerified = true;
            this.state.usingProxy = true;
            this.state.fallbackActive = false;
            this.state.transport = 'proxy';
            this.state.lastSuccessAt = Date.now();
            this.state.lastError = null;
            this.emitChange();
            return response;
        } catch (error) {
            console.error('[networkProxy.fetch] HTTPSession.fetch failed:', error);
            this.state.usingProxy = false;
            this.state.connectionVerified = false;
            this.state.lastFailureAt = Date.now();
            this.state.lastError = error;
            this.state.transport = 'direct';

            if (forceProxy || !this.state.settings.fallbackToDirect) {
                this.emitChange();
                throw error;
            }

            // Silently disable proxy and auto-retry with direct fetch
            // Use synchronous state update to avoid race conditions with parallel requests
            console.warn('[networkProxy.fetch] Proxy failed, silently disabling and retrying direct:', url?.substring(0, 100));
            this.state.settings.enabled = false;
            this.state.fallbackActive = true;
            await this.saveSettings(this.state.settings);
            this.emitChange();
            // Use credentials: 'omit' to prevent third-party cookie storage
            return fetch(resource, { ...init, credentials: 'omit' });
        }
    }

    /**
     * Fetch with automatic retry using this proxy's transport.
     * Combines networkProxy.fetch with retry logic from fetchRetry.
     * 
     * @param {string|Request} url - URL or Request object
     * @param {RequestInit} [init={}] - Fetch options
     * @param {Object} [config={}] - Retry and proxy configuration
     * @param {Object} [config.proxyConfig] - Config passed to networkProxy.fetch (e.g., { bypassProxy: true })
     * @param {number} [config.maxAttempts] - Max retry attempts
     * @param {number} [config.timeoutMs] - Timeout per request
     * @param {string} [config.context] - Context for error messages
     * @returns {Promise<Response>} The HTTP response
     */
    async fetchWithRetry(url, init = {}, config = {}) {
        const { proxyConfig, ...retryConfig } = config;
        return fetchRetry(url, init, {
            ...retryConfig,
            fetchFn: this.fetch.bind(this),
            fetchConfig: proxyConfig
        });
    }

    /**
     * Fetch with retry and JSON parsing using this proxy's transport.
     * 
     * @param {string|Request} url - URL or Request object
     * @param {RequestInit} [init={}] - Fetch options
     * @param {Object} [config={}] - Retry and proxy configuration
     * @returns {Promise<{response: Response, data: any, text: string}>}
     */
    async fetchWithRetryJson(url, init = {}, config = {}) {
        const { proxyConfig, ...retryConfig } = config;
        return fetchRetryJson(url, init, {
            ...retryConfig,
            fetchFn: this.fetch.bind(this),
            fetchConfig: proxyConfig
        });
    }
}

const networkProxy = new NetworkProxy();
window.networkProxy = networkProxy;

// Module initialization - libcurl is managed by index.html

export default networkProxy;
