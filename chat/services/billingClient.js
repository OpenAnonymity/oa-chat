import { ORG_API_BASE } from '../config.js';
import accountService from './accountService.js';
import privacyPassProvider from './privacyPass.js';
import ticketStore from './ticketStore.js';
import billingPendingStore from './billingPendingStore.js';
import { BILLING_CHECKOUT_STORAGE_KEY } from './billingState.js';

const DEMO_IDENTITY_KEY = 'oa-billing-demo-account-id-v1';
const CHUNK_SIZE = 10;
const FULL_PERIOD_TICKETS = 300;
const TICKET_PACK_TICKETS = 50;
const CHECKOUT_KINDS = new Set(['subscription', 'topup']);
const NORMAL_TICKET_FIELDS = new Set([
    'blinded_request',
    'signed_response',
    'finalized_ticket',
    'created_at'
]);
const FORBIDDEN_METADATA = /account|stripe|subscription|entitlement|claim/i;
const CLAIM_RESPONSE_FIELDS = new Set(['signed_responses', 'tickets_issued', 'replayed']);

export function isLoopbackHostname(hostname) {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(hostname || '').toLowerCase());
}

function isLoopbackUrl(value) {
    try {
        return isLoopbackHostname(new URL(value).hostname);
    } catch {
        return false;
    }
}

function randomIdentity() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll('-', '');
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function makeError(data, status) {
    const detail = data?.detail && typeof data.detail === 'object' ? data.detail : data;
    const error = new Error(detail?.error || data?.error || `Billing request failed (${status})`);
    error.code = detail?.code || data?.code || 'BILLING_REQUEST_FAILED';
    error.status = status;
    return error;
}

function normalizeSignedResponses(data, expectedCount) {
    if (data?.finalized_tickets || data?.finalized_ticket || data?.tickets) {
        const error = new Error('The billing server returned finalized ticket material.');
        error.code = 'BILLING_SERVER_FINALIZED_TICKETS';
        throw error;
    }
    const unexpected = Object.keys(data || {}).filter(field => !CLAIM_RESPONSE_FIELDS.has(field));
    if (unexpected.length > 0) {
        const error = new Error('The billing server returned unexpected response metadata.');
        error.code = 'BILLING_UNEXPECTED_RESPONSE_METADATA';
        throw error;
    }
    if (data?.tickets_issued !== undefined && Number(data.tickets_issued) !== expectedCount) {
        const error = new Error('The billing server reported a mismatched ticket allowance.');
        error.code = 'BILLING_INCOMPLETE_RESPONSE';
        throw error;
    }
    const source = data?.signed_responses;
    if (!Array.isArray(source) || source.length !== expectedCount) {
        const error = new Error('The billing server returned an incomplete signature batch.');
        error.code = 'BILLING_INCOMPLETE_RESPONSE';
        throw error;
    }
    const normalized = source.map(entry => {
        if (!Array.isArray(entry) || entry.length !== 2 || !Number.isInteger(entry[0]) || !entry[1]) {
            throw new Error('The billing server returned malformed signed responses.');
        }
        return [entry[0], String(entry[1])];
    }).sort((left, right) => left[0] - right[0]);
    if (normalized.some((entry, index) => entry[0] !== index)) {
        throw new Error('The billing server returned mismatched ticket indexes.');
    }
    return normalized;
}

function validateClaimRef(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function resolveClaimContext(status, pending, plan) {
    const source = pending
        ? (pending.source || 'subscription')
        : (
            ['claimable', 'claiming'].includes(status?.ticket_pack?.state)
                ? 'topup'
                : 'subscription'
        );
    if (source === 'topup') {
        const claimRef = pending?.claimRef || status?.ticket_pack?.claim_ref;
        const targetCount = Number(pending?.targetCount ?? status?.ticket_pack?.ticket_count);
        const planCount = Number(plan?.ticket_pack?.tickets ?? TICKET_PACK_TICKETS);
        if (!validateClaimRef(claimRef) || targetCount !== TICKET_PACK_TICKETS || planCount !== TICKET_PACK_TICKETS) {
            const error = new Error('Billing status returned an invalid ticket-pack allowance.');
            error.code = 'BILLING_ALLOWANCE_INVALID';
            throw error;
        }
        return { source, claimRef, targetCount };
    }
    if (source !== 'subscription') {
        const error = new Error('Saved billing recovery has an unsupported source.');
        error.code = 'BILLING_ALLOWANCE_INVALID';
        throw error;
    }
    const target = Number(pending?.targetCount ?? status?.next_claim_ticket_count);
    const fullPeriod = Number(
        status?.plan?.tickets_per_period ?? plan?.tickets_per_period ?? FULL_PERIOD_TICKETS
    );
    if (!Number.isInteger(target) || target < 1) {
        const error = new Error('Billing status did not provide the next private ticket allowance.');
        error.code = 'BILLING_ALLOWANCE_UNAVAILABLE';
        throw error;
    }
    if (!Number.isInteger(fullPeriod) || fullPeriod !== FULL_PERIOD_TICKETS || target > fullPeriod) {
        const error = new Error('Billing status returned an invalid private ticket allowance.');
        error.code = 'BILLING_ALLOWANCE_INVALID';
        throw error;
    }
    return { source, claimRef: null, targetCount: target };
}

function validateNormalTicket(ticket) {
    const fields = Object.keys(ticket || {});
    if (fields.length !== NORMAL_TICKET_FIELDS.size ||
        fields.some(field => !NORMAL_TICKET_FIELDS.has(field) || FORBIDDEN_METADATA.test(field)) ||
        !ticket.blinded_request || !ticket.signed_response || !ticket.finalized_ticket || !ticket.created_at) {
        throw new Error('A prepared ticket contained unexpected billing metadata.');
    }
    return ticket;
}

function yieldToBrowser() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

export class BillingAuthProvider {
    constructor(options = {}) {
        this.accountService = options.accountService || accountService;
        this.storage = options.storage || globalThis.localStorage;
        this.orgBase = (options.orgBase || ORG_API_BASE).replace(/\/+$/, '');
    }

    getAccountState() {
        return this.accountService?.getState?.() || {};
    }

    isDemoAllowed() {
        return typeof window !== 'undefined' &&
            isLoopbackHostname(window.location?.hostname) &&
            isLoopbackUrl(this.orgBase);
    }

    getDemoIdentity({ create = false } = {}) {
        if (!this.isDemoAllowed() || !this.storage) return '';
        let value = String(this.storage.getItem(DEMO_IDENTITY_KEY) || '').trim();
        if (!value && create) {
            value = randomIdentity();
            this.storage.setItem(DEMO_IDENTITY_KEY, value);
        }
        return value;
    }

    async resolve({ createDemo = false } = {}) {
        let state = this.getAccountState();
        if (state.accountId) {
            let token = this.accountService?.getAccessToken?.() || null;
            if (!token && this.accountService?.refreshAccessToken) {
                await this.accountService.refreshAccessToken().catch(() => null);
                state = this.getAccountState();
                token = this.accountService?.getAccessToken?.() || null;
            }
            if (!token) {
                const error = new Error('Unlock your OA account before managing Premium.');
                error.code = 'BILLING_AUTH_REQUIRED';
                throw error;
            }
            return {
                scope: `account:${state.accountId}`,
                headers: { Authorization: `Bearer ${token}` },
                mode: 'account'
            };
        }
        const demoIdentity = this.getDemoIdentity({ create: createDemo });
        if (demoIdentity) {
            return {
                scope: `demo:${demoIdentity}`,
                headers: { 'X-OA-Demo-Account-ID': demoIdentity },
                mode: 'development'
            };
        }
        const error = new Error('An OA account is required to manage Premium.');
        error.code = 'BILLING_AUTH_REQUIRED';
        throw error;
    }

    subscribe(listener) {
        return this.accountService?.subscribe?.(listener) || (() => {});
    }

    hasKnownIdentity() {
        return !!this.getAccountState().accountId || !!this.getDemoIdentity();
    }

    getKnownScope(state = this.getAccountState()) {
        if (state?.accountId) return `account:${state.accountId}`;
        const demoIdentity = this.getDemoIdentity();
        return demoIdentity ? `demo:${demoIdentity}` : null;
    }
}

export class BillingClient {
    constructor(options = {}) {
        this.baseUrl = (options.baseUrl || ORG_API_BASE).replace(/\/+$/, '');
        this.fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
        this.auth = options.authProvider || new BillingAuthProvider({
            accountService: options.accountService,
            storage: options.storage,
            orgBase: this.baseUrl
        });
        this.pendingStore = options.pendingStore || billingPendingStore;
        this.privacyPass = options.privacyPass || privacyPassProvider;
        this.ticketStore = options.ticketStore || ticketStore;
        this.storage = options.storage || globalThis.localStorage;
        this.lockManager = options.lockManager || globalThis.navigator?.locks || null;
        this.listeners = new Set();
        this.status = null;
        this.plan = null;
        this.progress = null;
        this.activeScope = null;
        this.activeController = null;
        this.checkoutScope = null;
        this.checkoutController = null;
        this.identityGeneration = 0;
        this.identityScope = this.auth.getKnownScope?.() || null;
        this.autoProcessedScopes = new Set();
        this.unsubscribeAccount = this.auth.subscribe(state => this.handleIdentityChange(state));
    }

    destroy() {
        this.activeController?.abort();
        this.checkoutController?.abort();
        this.unsubscribeAccount?.();
        this.listeners.clear();
    }

    subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        this.listeners.add(listener);
        listener(this.snapshot());
        return () => this.listeners.delete(listener);
    }

    snapshot() {
        return { plan: this.plan, status: this.status, progress: this.progress };
    }

    publish() {
        const snapshot = this.snapshot();
        this.listeners.forEach(listener => listener(snapshot));
    }

    handleIdentityChange(state = null) {
        const nextScope = this.auth.getKnownScope?.(state || undefined) || null;
        if (nextScope === this.identityScope) return;
        this.activeController?.abort();
        this.checkoutController?.abort();
        this.activeController = null;
        this.checkoutController = null;
        this.activeScope = null;
        this.checkoutScope = null;
        this.identityGeneration += 1;
        this.identityScope = nextScope;
        this.status = null;
        this.progress = null;
        this.publish();
        if (nextScope) {
            queueMicrotask(() => {
                void this.resumeKnownBilling().catch(() => {});
            });
        }
    }

    async request(path, options = {}) {
        const headers = { Accept: 'application/json', ...(options.headers || {}) };
        if (options.auth !== false) {
            const auth = options.authContext || await this.auth.resolve({ createDemo: options.createDemo === true });
            Object.assign(headers, auth.headers);
        }
        let body = options.body;
        if (body && typeof body !== 'string') {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(body);
        }
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method: options.method || (body ? 'POST' : 'GET'),
            headers,
            body,
            credentials: 'omit',
            signal: options.signal
        });
        const text = await response.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
        if (!response.ok) throw makeError(data, response.status);
        return data;
    }

    async getPlan({ force = false } = {}) {
        if (this.plan && !force) return this.plan;
        this.plan = await this.request('/api/billing/plan', { auth: false });
        this.publish();
        return this.plan;
    }

    assertIdentityContext(auth, signal, generation = this.identityGeneration) {
        const knownScope = this.auth.getKnownScope?.() || null;
        if (signal?.aborted || generation !== this.identityGeneration || knownScope !== auth.scope) {
            throw new DOMException('Billing identity changed', 'AbortError');
        }
    }

    async getStatus({ force = false, createDemo = false, authContext = null, signal = undefined } = {}) {
        if (this.status && !force) return this.status;
        const generation = this.identityGeneration;
        const auth = authContext || await this.auth.resolve({ createDemo });
        this.assertIdentityContext(auth, signal, generation);
        const status = await this.request('/api/billing/status', {
            authContext: auth,
            signal
        });
        this.assertIdentityContext(auth, signal, generation);
        const pending = await this.pendingStore.get(auth.scope).catch(() => null);
        this.assertIdentityContext(auth, signal, generation);
        if (pending?.source === 'topup' && status?.ticket_pack) {
            status.ticket_pack = {
                ...status.ticket_pack,
                can_purchase: false,
                state: 'claiming',
                ticket_count: Number(pending.targetCount || status.ticket_pack.ticket_count),
                claim_ref: pending.claimRef || status.ticket_pack.claim_ref || null
            };
        }
        this.status = status;
        this.plan = status.plan || this.plan;
        this.publish();
        return status;
    }

    async checkout() {
        const generation = this.identityGeneration;
        const auth = await this.auth.resolve({ createDemo: true });
        this.assertIdentityContext(auth, undefined, generation);
        const result = await this.request('/api/billing/checkout', {
            method: 'POST',
            authContext: auth,
            body: { return_origin: window.location.origin }
        });
        this.assertIdentityContext(auth, undefined, generation);
        if (result.session_id) this.saveCheckoutSession(result.session_id, auth.scope, 'subscription');
        if (result.url) window.location.assign(result.url);
        return result;
    }

    async purchaseTicketPack() {
        const generation = this.identityGeneration;
        const auth = await this.auth.resolve({ createDemo: false });
        this.assertIdentityContext(auth, undefined, generation);
        const pending = await this.pendingStore.get(auth.scope);
        this.assertIdentityContext(auth, undefined, generation);
        if (pending?.source === 'topup') {
            const error = new Error('Finish importing the current ticket pack before buying another.');
            error.code = 'BILLING_TOPUP_PENDING';
            throw error;
        }
        const result = await this.request('/api/billing/topups/checkout', {
            method: 'POST',
            authContext: auth,
            body: { return_origin: window.location.origin }
        });
        this.assertIdentityContext(auth, undefined, generation);
        if (result.session_id) this.saveCheckoutSession(result.session_id, auth.scope, 'topup');
        if (result.url) window.location.assign(result.url);
        return result;
    }

    async portal() {
        const generation = this.identityGeneration;
        const auth = await this.auth.resolve({ createDemo: true });
        this.assertIdentityContext(auth, undefined, generation);
        const result = await this.request('/api/billing/portal', {
            method: 'POST',
            authContext: auth,
            body: { return_origin: window.location.origin }
        });
        this.assertIdentityContext(auth, undefined, generation);
        if (result.url) window.location.assign(result.url);
        return result;
    }

    saveCheckoutSession(sessionId, scope, kind = 'subscription') {
        if (!this.storage || !sessionId || !scope || !CHECKOUT_KINDS.has(kind)) return;
        const state = this.readCheckoutSessions();
        state.sessions[scope] ||= {};
        state.sessions[scope][kind] = { sessionId, savedAt: Date.now() };
        this.storage.setItem(BILLING_CHECKOUT_STORAGE_KEY, JSON.stringify(state));
    }

    getCheckoutSession(scope, kind = 'subscription') {
        const value = this.readCheckoutSessions().sessions[scope]?.[kind];
        return value ? { ...value, scope, kind } : null;
    }

    readCheckoutSessions() {
        const empty = { version: 3, sessions: {} };
        if (!this.storage) return empty;
        try {
            const value = JSON.parse(this.storage.getItem(BILLING_CHECKOUT_STORAGE_KEY) || 'null');
            if (value?.version === 3 && value.sessions && typeof value.sessions === 'object') {
                return value;
            }
            if (value?.version === 2 && value.sessions && typeof value.sessions === 'object') {
                return {
                    version: 3,
                    sessions: Object.fromEntries(
                        Object.entries(value.sessions)
                            .filter(([, session]) => session?.sessionId)
                            .map(([scope, session]) => [scope, { subscription: session }])
                    )
                };
            }
            if (value?.scope && value?.sessionId) {
                return {
                    version: 3,
                    sessions: {
                        [value.scope]: {
                            subscription: { sessionId: value.sessionId, savedAt: value.savedAt }
                        }
                    }
                };
            }
        } catch {
            // Replace malformed local recovery metadata on the next save.
        }
        return empty;
    }

    clearCheckoutSession(scope = null, kind = null) {
        if (!this.storage) return;
        if (!scope) {
            this.storage.removeItem(BILLING_CHECKOUT_STORAGE_KEY);
            return;
        }
        const state = this.readCheckoutSessions();
        if (kind && CHECKOUT_KINDS.has(kind)) {
            delete state.sessions[scope]?.[kind];
            if (Object.keys(state.sessions[scope] || {}).length === 0) delete state.sessions[scope];
        } else {
            delete state.sessions[scope];
        }
        if (Object.keys(state.sessions).length === 0) {
            this.storage.removeItem(BILLING_CHECKOUT_STORAGE_KEY);
        } else {
            this.storage.setItem(BILLING_CHECKOUT_STORAGE_KEY, JSON.stringify(state));
        }
    }

    discardKnownCheckout(kind) {
        const scope = this.auth.getKnownScope?.() || null;
        if (scope) this.clearCheckoutSession(scope, kind);
    }

    async resumeSavedCheckout(options = {}) {
        if (!this.auth.hasKnownIdentity?.()) return null;
        const auth = await this.auth.resolve({ createDemo: false });
        let result = null;
        let firstError = null;
        for (const kind of ['subscription', 'topup']) {
            const saved = this.getCheckoutSession(auth.scope, kind);
            if (saved?.sessionId) {
                try {
                    result = await this.reconcileCheckout(saved.sessionId, {
                        ...options,
                        kind,
                        authContext: auth
                    });
                } catch (error) {
                    if (error?.name === 'AbortError') throw error;
                    firstError ||= error;
                }
            }
        }
        if (!result && firstError) throw firstError;
        return result;
    }

    async reconcileCheckout(sessionId, options = {}) {
        if (this.checkoutController) return this.checkoutController.promise;
        const controller = new AbortController();
        if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        const work = this.reconcileCheckoutWithController(sessionId, controller, options);
        controller.promise = work;
        this.checkoutController = controller;
        try {
            return await work;
        } finally {
            if (this.checkoutController === controller) {
                this.checkoutController = null;
                this.checkoutScope = null;
            }
        }
    }

    async reconcileCheckoutWithController(sessionId, controller, options) {
        const auth = options.authContext || await this.auth.resolve({ createDemo: true });
        const kind = CHECKOUT_KINDS.has(options.kind) ? options.kind : 'subscription';
        const generation = this.identityGeneration;
        this.checkoutScope = auth.scope;
        const assertActive = () => {
            this.assertIdentityContext(auth, controller.signal, generation);
            if (this.checkoutScope !== auth.scope) {
                throw new DOMException('Billing identity changed', 'AbortError');
            }
        };
        assertActive();
        this.saveCheckoutSession(sessionId, auth.scope, kind);
        const started = Date.now();
        const timeoutMs = options.timeoutMs ?? 80_000;
        while (Date.now() - started < timeoutMs) {
            assertActive();
            const status = await this.getStatus({
                force: true,
                authContext: auth,
                signal: controller.signal
            }).catch(error => {
                if (error?.name === 'AbortError') throw error;
                return null;
            });
            const ready = kind === 'topup'
                ? ['claimable', 'claiming'].includes(status?.ticket_pack?.state)
                : Number(status?.available_batches || 0) > 0;
            if (ready) {
                this.clearCheckoutSession(auth.scope, kind);
                return status;
            }
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(resolve, options.pollMs ?? 2000);
                controller.signal.addEventListener('abort', () => {
                    clearTimeout(timeout);
                    reject(new DOMException('Aborted', 'AbortError'));
                }, { once: true });
            });
        }
        assertActive();
        const completePath = kind === 'topup'
            ? '/api/billing/topups/checkout/complete'
            : '/api/billing/checkout/complete';
        const complete = await this.request(completePath, {
            method: 'POST',
            authContext: auth,
            body: { session_id: sessionId },
            signal: controller.signal
        });
        assertActive();
        this.status = complete.status;
        this.clearCheckoutSession(auth.scope, kind);
        this.publish();
        return this.status;
    }

    async getPendingClaim() {
        const auth = await this.auth.resolve({ createDemo: true });
        return this.pendingStore.get(auth.scope);
    }

    async resumeKnownBilling(options = {}) {
        if (!this.auth.hasKnownIdentity?.()) return null;
        return this.automaticallyPrepareOneBatch(options);
    }

    async prepareOneBatch(options = {}) {
        if (this.activeController) return this.activeController.promise;
        const controller = new AbortController();
        if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        const work = this.prepareOneBatchWithController(controller, options);
        controller.promise = work;
        this.activeController = controller;
        try {
            return await work;
        } finally {
            if (this.activeController === controller) this.activeController = null;
        }
    }

    assertAuthContext(auth, signal) {
        this.assertIdentityContext(auth, signal);
        if (this.activeScope !== auth.scope) {
            throw new DOMException('Billing identity changed', 'AbortError');
        }
    }

    async prepareOneBatchWithController(controller, options) {
        await this.ticketStore.init?.();
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const auth = options.authContext || await this.auth.resolve({ createDemo: true });
        this.activeScope = auth.scope;
        this.assertAuthContext(auth, controller.signal);

        const execute = async () => {
            this.assertAuthContext(auth, controller.signal);
            // Re-read both server allowance and local recovery state only after the
            // cross-tab lock is held.
            const status = await this.getStatus({
                force: true,
                authContext: auth,
                signal: controller.signal
            });
            this.assertAuthContext(auth, controller.signal);
            const existing = await this.pendingStore.get(auth.scope);
            const hasTopup = ['claimable', 'claiming'].includes(status?.ticket_pack?.state);
            if (!existing && Number(status.available_batches || 0) < 1 && !hasTopup) {
                if (options.allowNoEntitlement) return null;
                const error = new Error('No paid Premium ticket batch is available.');
                error.code = 'BILLING_NO_ENTITLEMENT';
                throw error;
            }
            const claimContext = resolveClaimContext(status, existing, this.plan);
            return this.runPreparation(auth, controller.signal, options.onProgress, claimContext);
        };

        const lockName = `oa-billing-claim-v1:${await sha256(auth.scope)}`;
        if (this.lockManager?.request) {
            return this.lockManager.request(
                lockName,
                { mode: 'exclusive', signal: controller.signal },
                execute
            );
        }
        if (typeof window !== 'undefined') {
            const error = new Error('This browser cannot safely coordinate Premium ticket preparation across tabs.');
            error.code = 'BILLING_BROWSER_LOCK_UNAVAILABLE';
            throw error;
        }
        return execute();
    }

    async runPreparation(auth, signal, onProgress, claimContext) {
        const { source, claimRef, targetCount } = claimContext;
        const updateProgress = (phase, completed, total = targetCount) => {
            this.progress = { phase, completed, total, accountScope: auth.scope, source };
            onProgress?.(this.progress);
            this.publish();
        };
        const assertActive = () => {
            this.assertAuthContext(auth, signal);
        };

        let pending = await this.pendingStore.get(auth.scope);
        if (!pending) {
            const publicKey = await this.fetchPublicKey(signal);
            pending = {
                accountScope: auth.scope,
                source,
                claimRef,
                issuerFingerprint: await sha256(publicKey),
                targetCount,
                generatedCount: 0,
                requests: [],
                signedResponses: null,
                finalizedTickets: [],
                finalizedCount: 0,
                phase: 'generating',
                createdAt: new Date().toISOString()
            };
            pending = await this.pendingStore.put(pending);
        }
        const pendingSource = pending.source || 'subscription';
        if (pending.targetCount !== targetCount || pending.accountScope !== auth.scope ||
            pendingSource !== source || (source === 'topup' && pending.claimRef !== claimRef)) {
            throw new Error('Saved billing claim does not match this account or plan.');
        }

        if (!pending.signedResponses) {
            const currentPublicKey = await this.fetchPublicKey(signal);
            if (await sha256(currentPublicKey) !== pending.issuerFingerprint) {
                throw new Error('The OA ticket issuer changed. The saved private batch was not submitted.');
            }
            while (pending.generatedCount < targetCount) {
                assertActive();
                const end = Math.min(pending.generatedCount + CHUNK_SIZE, targetCount);
                for (let index = pending.generatedCount; index < end; index += 1) {
                    const created = await this.privacyPass.createSingleTokenRequest(currentPublicKey);
                    pending.requests.push({
                        index,
                        blindedRequest: created.blindedRequest,
                        serializedState: created.serializedState || this.privacyPass.serializeState(created.state, currentPublicKey)
                    });
                }
                pending.generatedCount = end;
                pending.phase = 'generating';
                pending = await this.pendingStore.put(pending);
                updateProgress('generating', end);
                await yieldToBrowser();
            }
            const roundTrip = await this.pendingStore.get(auth.scope);
            if (!roundTrip || roundTrip.requests?.length !== targetCount ||
                roundTrip.requests.some((request, index) => request.index !== index || !request.blindedRequest || !request.serializedState)) {
                throw new Error('Private ticket preparation was not saved completely.');
            }
            assertActive();
            updateProgress('claiming', 0);
            const claimBody = {
                blinded_requests: roundTrip.requests.map(request => [request.index, request.blindedRequest])
            };
            if (source === 'topup') claimBody.claim_ref = claimRef;
            let claim;
            try {
                claim = await this.request('/api/billing/tickets/claim', {
                    method: 'POST',
                    authContext: auth,
                    body: claimBody,
                    signal
                });
            } catch (error) {
                if (source === 'topup' && error?.code === 'BILLING_NO_ENTITLEMENT') {
                    await this.pendingStore.delete(auth.scope);
                    this.progress = null;
                    this.status = null;
                    this.publish();
                }
                throw error;
            }
            pending.signedResponses = normalizeSignedResponses(claim, targetCount);
            pending.phase = 'signed';
            pending = await this.pendingStore.put(pending);
        }

        const signedMap = new Map(pending.signedResponses.map(entry => [entry[0], entry[1]]));
        while ((pending.finalizedCount || 0) < targetCount) {
            assertActive();
            const start = pending.finalizedCount || 0;
            const end = Math.min(start + CHUNK_SIZE, targetCount);
            for (let index = start; index < end; index += 1) {
                const request = pending.requests[index];
                const signedResponse = signedMap.get(index);
                const finalized = await this.privacyPass.finalizeToken(signedResponse, request.serializedState);
                pending.finalizedTickets[index] = validateNormalTicket({
                    blinded_request: request.blindedRequest,
                    signed_response: signedResponse,
                    finalized_ticket: finalized,
                    created_at: new Date().toISOString()
                });
            }
            pending.finalizedCount = end;
            pending.phase = 'finalizing';
            pending = await this.pendingStore.put(pending);
            updateProgress('finalizing', end);
            await yieldToBrowser();
        }

        assertActive();
        const before = this.ticketStore.getCount();
        await this.ticketStore.addTickets(
            pending.finalizedTickets.map(validateNormalTicket),
            { requireDurable: true }
        );
        const wallet = this.ticketStore.getTickets();
        const archive = this.ticketStore.getArchiveTickets?.() || [];
        const walletValues = new Set(
            [...wallet, ...archive].map(ticket => ticket.finalized_ticket)
        );
        if (!pending.finalizedTickets.every(ticket => walletValues.has(ticket.finalized_ticket))) {
            throw new Error('Prepared tickets were not imported into the local wallet.');
        }
        const after = this.ticketStore.getCount();
        pending.phase = 'imported';
        pending.walletCountBefore = before;
        pending.walletCountAfter = after;
        await this.pendingStore.put(pending);
        await this.pendingStore.delete(auth.scope);
        this.progress = null;
        this.assertAuthContext(auth, signal);
        this.status = await this.getStatus({ force: true, authContext: auth, signal });
        this.publish();
        return { ticketsAdded: Math.max(0, after - before), totalActive: after };
    }

    async fetchPublicKey(signal) {
        const response = await this.fetchImpl(`${this.baseUrl}/api/ticket/issue/public-key`, {
            headers: { Accept: 'application/json' },
            credentials: 'omit',
            signal
        });
        const data = await response.json();
        if (!response.ok || !data.public_key) throw new Error('Unable to load the OA ticket issuer public key.');
        return data.public_key;
    }

    async automaticallyPrepareOneBatch(options = {}) {
        const auth = await this.auth.resolve({ createDemo: true });
        if (this.autoProcessedScopes.has(auth.scope)) return null;
        const result = await this.prepareOneBatch({
            ...options,
            authContext: auth,
            allowNoEntitlement: true
        });
        if (result) this.autoProcessedScopes.add(auth.scope);
        return result;
    }
}

const billingClient = new BillingClient();
export default billingClient;
