/**
 * One account-session transport for browser and Electron.
 *
 * Browser sessions use SuperTokens' HttpOnly cookie mode. Electron sessions
 * use the same SuperTokens recipe in header mode, but the SDK and tokens live
 * in the isolated preload/main boundary and are never exposed to this page.
 */

import { ORG_API_BASE } from './orgEndpoints.js';
import { SuperTokens, Session } from '../vendor/supertokens-session.js';

const isElectron = typeof window !== 'undefined' && window.electronAPI?.isElectron === true;

function normalizeAccountSessionUrl(input) {
    const value = typeof Request !== 'undefined' && input instanceof Request
        ? input.url
        : String(input);
    const url = new URL(value, window.location.href);
    const orgUrl = new URL(ORG_API_BASE);
    const isAccountPath =
        url.pathname === '/auth' ||
        url.pathname.startsWith('/auth/') ||
        url.pathname === '/api/billing' ||
        url.pathname.startsWith('/api/billing/');

    if (url.origin !== orgUrl.origin || !isAccountPath) {
        throw new TypeError('Account session requests are restricted to org account APIs');
    }

    return url.toString();
}

function isAccountSessionUrl(input) {
    try {
        normalizeAccountSessionUrl(input);
        return true;
    } catch {
        return false;
    }
}

class SessionService {
    constructor() {
        this.initialized = false;
        this.initializing = null;
        this.expiredListeners = new Set();
        this.unsubscribeElectron = null;
    }

    async init() {
        if (this.initialized) return;
        if (this.initializing) return this.initializing;

        this.initializing = this._initialize();
        try {
            await this.initializing;
            this.initialized = true;
        } finally {
            this.initializing = null;
        }
    }

    async _initialize() {
        if (isElectron) {
            const bridge = window.electronAPI;
            if (
                typeof bridge.authSessionInit !== 'function' ||
                typeof bridge.authSessionFetch !== 'function'
            ) {
                throw new Error('Secure Electron session bridge is unavailable');
            }
            await bridge.authSessionInit(ORG_API_BASE);
            if (typeof bridge.onAuthSessionExpired === 'function') {
                this.unsubscribeElectron = bridge.onAuthSessionExpired(() => {
                    this._notifyExpired();
                });
            }
            return;
        }

        SuperTokens.init({
            appInfo: {
                appName: 'Open Anonymity',
                apiDomain: ORG_API_BASE,
                websiteDomain: window.location.origin,
                apiBasePath: '/auth',
                websiteBasePath: '/auth',
            },
            recipeList: [
                Session.init({
                    tokenTransferMethod: 'cookie',
                    override: {
                        functions: (originalImplementation) => ({
                            ...originalImplementation,
                            shouldDoInterceptionBasedOnUrl: (
                                toCheckUrl,
                                apiDomain,
                                sessionTokenBackendDomain
                            ) => (
                                isAccountSessionUrl(toCheckUrl) &&
                                originalImplementation.shouldDoInterceptionBasedOnUrl(
                                    toCheckUrl,
                                    apiDomain,
                                    sessionTokenBackendDomain
                                )
                            ),
                        }),
                    },
                    onHandleEvent: (event) => {
                        if (
                            event.action === 'UNAUTHORISED' &&
                            event.sessionExpiredOrRevoked
                        ) {
                            this._notifyExpired();
                        }
                    },
                }),
            ],
        });
    }

    onSessionExpired(listener) {
        this.expiredListeners.add(listener);
        return () => this.expiredListeners.delete(listener);
    }

    _notifyExpired() {
        for (const listener of this.expiredListeners) {
            try {
                const result = listener();
                result?.catch?.((error) => {
                    console.warn('[SessionService] Async expiry listener failed:', error);
                });
            } catch (error) {
                console.warn('[SessionService] Expiry listener failed:', error);
            }
        }
    }

    async fetch(input, init = {}) {
        await this.init();
        const authUrl = normalizeAccountSessionUrl(input);
        if (!isElectron) {
            return window.fetch(authUrl, init);
        }

        const signal = init.signal;
        if (signal?.aborted) {
            throw new DOMException('The operation was aborted', 'AbortError');
        }

        const request = {
            method: init.method,
            headers: Array.from(new Headers(init.headers || {}).entries()),
            body: init.body ?? null,
            credentials: init.credentials,
        };
        const requestId = crypto.randomUUID();
        let rejectForAbort = null;
        const abortPromise = new Promise((_, reject) => {
            rejectForAbort = reject;
        });
        const abortRequest = () => {
            window.electronAPI.authSessionAbort?.(requestId);
            rejectForAbort(new DOMException('The operation was aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', abortRequest, { once: true });

        let serialized;
        try {
            const fetchPromise = window.electronAPI.authSessionFetch(
                authUrl,
                request,
                requestId
            );
            serialized = signal
                ? await Promise.race([fetchPromise, abortPromise])
                : await fetchPromise;
        } catch (error) {
            if (signal?.aborted) {
                throw new DOMException('The operation was aborted', 'AbortError');
            }
            throw error;
        } finally {
            signal?.removeEventListener('abort', abortRequest);
        }

        return new Response(serialized.body, {
            status: serialized.status,
            statusText: serialized.statusText,
            headers: serialized.headers,
        });
    }

    async doesSessionExist() {
        await this.init();
        return isElectron
            ? window.electronAPI.authSessionExists()
            : Session.doesSessionExist();
    }

    async attemptRefreshingSession() {
        await this.init();
        return isElectron
            ? window.electronAPI.authSessionRefresh()
            : Session.attemptRefreshingSession();
    }

    async verifySession() {
        if (await this.doesSessionExist()) return true;
        return this.attemptRefreshingSession();
    }

    async signOut() {
        await this.init();
        if (isElectron) {
            await window.electronAPI.authSessionSignOut();
        } else {
            await Session.signOut();
        }
    }
}

const sessionService = new SessionService();

export { SessionService };
export default sessionService;
