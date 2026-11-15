/**
 * Zero data retention (ZDR) routing for OpenRouter requests.
 *
 * When the person turns ZDR on, every OpenRouter request must reach only
 * endpoints whose provider has a zero data retention policy. OpenRouter's
 * `provider.zdr: true` alone still admits "Safety Retention" endpoints when
 * account or guardrail settings allow them, and there is no request field
 * that excludes those. So each request also carries `provider.only`: the
 * endpoint slugs that serve this exact model with ZDR and without safety
 * retention, taken from OpenRouter's public ZDR endpoint list.
 *
 * Fail closed: when ZDR is on and the list has not loaded, or the model has
 * no eligible provider, the request is refused before it leaves the browser.
 * It never falls back to ordinary routing.
 */

export const ZDR_ENDPOINTS_URL = 'https://openrouter.ai/api/v1/endpoints/zdr';
export const ZDR_SETTING_KEY = 'zeroDataRetention';
// Backends whose requests go through OpenRouterAPI.prepareRequestBody.
export const ZDR_BACKEND_IDS = Object.freeze(['openrouter', 'zkapi']);

export class ZdrUnavailableError extends Error {
    constructor(message, { modelId = null, reason = 'model' } = {}) {
        super(message);
        this.name = 'ZdrUnavailableError';
        this.code = 'zdr_unavailable';
        this.reason = reason;
        this.modelId = modelId;
        // Not a transient failure: retrying the same request cannot succeed.
        this.isRetryable = false;
    }
}

/** Model id without variant suffixes such as `:online` or `:thinking`. */
export function baseModelId(modelId) {
    return String(modelId || '').trim().split(':')[0];
}

function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

/** Keep the full routing slug; stripping a region broadens routing. */
export function providerSlugForEndpoint(entry) {
    return firstString(entry?.tag, entry?.provider_slug, entry?.slug).toLowerCase();
}

function endpointModelId(entry) {
    return baseModelId(firstString(
        entry?.model_id,
        typeof entry?.model === 'string' ? entry.model : '',
        entry?.model?.id,
        entry?.model_slug,
        entry?.canonical_slug
    ));
}

/**
 * Builds model id → eligible full endpoint slugs from the ZDR endpoint list.
 * Every listed endpoint in a model/provider group must explicitly state
 * `safety_retention: false` and none may state `zdr: false`. A missing or
 * unexpected retention policy excludes the group, including mixed regions.
 */
export function parseZdrEndpoints(payload) {
    const entries = Array.isArray(payload) ? payload
        : Array.isArray(payload?.data) ? payload.data
            : Array.isArray(payload?.data?.endpoints) ? payload.data.endpoints
                : null;
    if (!entries) throw new Error('Invalid zero data retention endpoint list');
    const byModel = new Map();
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const modelId = endpointModelId(entry);
        const endpoint = providerSlugForEndpoint(entry);
        // A display name is not an endpoint identifier; never guess a route.
        if (!modelId || !endpoint) continue;
        const provider = endpoint.split('/')[0];
        if (!byModel.has(modelId)) byModel.set(modelId, new Map());
        const groups = byModel.get(modelId);
        if (!groups.has(provider)) groups.set(provider, { eligible: true, endpoints: new Set() });
        const group = groups.get(provider);
        group.endpoints.add(endpoint);
        // One retaining, unknown, or conflicting row vetoes the whole group,
        // regardless of row order. This also avoids broad prefix matches.
        if (entry.safety_retention !== false || entry.zdr === false) group.eligible = false;
    }
    const catalog = new Map();
    for (const [modelId, groups] of byModel) {
        const endpoints = [...groups.values()].filter(group => group.eligible)
            .flatMap(group => [...group.endpoints]).sort();
        if (endpoints.length) catalog.set(modelId, endpoints);
    }
    return catalog;
}

/**
 * Returns a copy of `body` restricted to ZDR providers, or throws.
 * Existing provider preferences are kept; an existing `only` list is
 * narrowed, never widened. Model fallbacks (`models`) are removed because a
 * fallback model's providers were not checked.
 */
export function applyZeroDataRetention(body, { enabled, catalog }) {
    if (!enabled) return body;
    const modelId = baseModelId(body?.model);
    if (!(catalog instanceof Map)) {
        throw new ZdrUnavailableError(
            'Zero data retention is on, but the list of zero data retention providers has not loaded. Your message wasn\'t sent.',
            { modelId, reason: 'catalog' });
    }
    let providers = catalog.get(modelId) || [];
    const existing = body.provider && typeof body.provider === 'object' ? body.provider : {};
    if (Array.isArray(existing.only)) {
        const allowed = existing.only.map(value => String(value).trim().toLowerCase()).filter(Boolean);
        providers = providers.filter(endpoint => allowed.some(slug =>
            endpoint === slug || endpoint.startsWith(`${slug}/`)));
    }
    if (!providers.length) {
        throw new ZdrUnavailableError(
            'This model has no zero data retention providers. Choose a model with a ZDR endpoint, or turn off Zero data retention. Your message wasn\'t sent.',
            { modelId, reason: 'model' });
    }
    const { models: _fallbackModels, ...rest } = body;
    return {
        ...rest,
        provider: {
            ...existing,
            zdr: true,
            data_collection: 'deny',
            only: providers
        }
    };
}

/**
 * App-wide state: the person's choice and the loaded endpoint list.
 * The choice is stored with the other chat settings (not synced).
 */
export class ZeroDataRetentionState {
    constructor() {
        this.enabled = false;
        this.catalog = null;
        this.loadPromise = null;
        this.listeners = new Set();
        this.settingsStore = null;
        this.fetchJson = null;
        // Standalone API consumers have no app preference until configured.
        this.settingsReady = true;
        this.settingsError = null;
        this.restorePromise = null;
        this.preferenceRevision = 0;
        this.savePromise = Promise.resolve();
    }

    configure({ settingsStore, fetchJson } = {}) {
        if (settingsStore && settingsStore !== this.settingsStore) {
            this.settingsStore = settingsStore;
            this.preferenceRevision += 1;
            this.settingsReady = false;
            this.settingsError = null;
            this.restorePromise = null;
        }
        if (fetchJson) this.fetchJson = fetchJson;
    }

    preferenceError() {
        return new ZdrUnavailableError(
            'We couldn\'t load your Zero data retention setting, so your message wasn\'t sent. Set it in the model picker, then try again.',
            { reason: 'settings' });
    }

    restore() {
        if (this.restorePromise) return this.restorePromise;
        const revision = this.preferenceRevision;
        const store = this.settingsStore;
        this.settingsReady = false;
        const pending = (async () => {
            try {
                const saved = await store?.getSetting?.(ZDR_SETTING_KEY);
                if (revision === this.preferenceRevision) {
                    if (saved !== undefined && saved !== null && typeof saved !== 'boolean') throw this.preferenceError();
                    this.enabled = saved === true;
                    this.settingsReady = true;
                    this.settingsError = null;
                }
            } catch {
                if (revision === this.preferenceRevision) {
                    this.settingsError = this.preferenceError();
                    throw this.settingsError;
                }
            } finally {
                this.notify();
            }
            this.ensureCatalog().catch(() => {});
            return this.enabled;
        })();
        this.restorePromise = pending;
        const clear = () => { if (this.restorePromise === pending) this.restorePromise = null; };
        pending.then(clear, clear);
        return pending;
    }

    async ensureReady() {
        if (this.settingsError) throw this.settingsError;
        if (!this.settingsReady) await (this.restorePromise || this.restore());
        if (!this.settingsReady || this.settingsError) throw this.settingsError || this.preferenceError();
    }

    isReady() {
        return this.settingsReady && !this.settingsError;
    }

    isEnabled() {
        return this.enabled;
    }

    async setEnabled(enabled) {
        const choice = enabled === true;
        this.preferenceRevision += 1; // A late restore must not replace a new choice.
        this.enabled = choice;
        this.settingsReady = true;
        this.settingsError = null;
        this.notify();
        if (choice) this.ensureCatalog().catch(() => {});
        const store = this.settingsStore;
        // Serialize rapid changes so the last choice is also the saved choice.
        const save = this.savePromise.catch(() => {}).then(() => store?.saveSettings
            ? store.saveSettings([{ key: ZDR_SETTING_KEY, value: choice }])
            : store?.saveSetting?.(ZDR_SETTING_KEY, choice));
        this.savePromise = save;
        try { await save; } catch {
            const currentSetting = this.enabled ? 'on' : 'off';
            throw new ZdrUnavailableError(
                `Zero data retention is ${currentSetting}, but we couldn't save the change. Check that it is still ${currentSetting} after reloading.`,
                { reason: 'settings-save' });
        }
        return this.enabled;
    }

    hasCatalog() {
        return this.catalog instanceof Map;
    }

    /** True when the model has at least one eligible provider. */
    supportsModel(modelId) {
        return this.hasCatalog() && (this.catalog.get(baseModelId(modelId))?.length || 0) > 0;
    }

    async ensureCatalog({ force = false } = {}) {
        if (this.hasCatalog() && !force) return this.catalog;
        if (this.loadPromise) return this.loadPromise;
        if (!this.fetchJson) throw new Error('Zero data retention list is not configured');
        this.loadPromise = (async () => {
            const data = await this.fetchJson(ZDR_ENDPOINTS_URL);
            this.catalog = parseZdrEndpoints(data);
            this.notify();
            return this.catalog;
        })();
        try {
            return await this.loadPromise;
        } finally {
            this.loadPromise = null;
        }
    }

    /** Restricts an OpenRouter request body, or throws ZdrUnavailableError. */
    applyToBody(body) {
        if (!this.settingsReady || this.settingsError) throw this.settingsError || this.preferenceError();
        return applyZeroDataRetention(body, { enabled: this.enabled, catalog: this.catalog });
    }

    /**
     * Pre-send check for the UI, before any ticket is spent. Loads the list
     * if needed. Returns null when sending may proceed, or the error.
     */
    async checkModel(modelId, backendId = 'openrouter') {
        if (!ZDR_BACKEND_IDS.includes(backendId)) return null;
        try { await this.ensureReady(); } catch (error) { return error; }
        if (!this.enabled) return null;
        try {
            await this.ensureCatalog();
        } catch {
            return new ZdrUnavailableError(
                'Zero data retention is on, but the list of zero data retention providers couldn\'t load. Your message wasn\'t sent.',
                { modelId, reason: 'catalog' });
        }
        if (this.supportsModel(modelId)) return null;
        return new ZdrUnavailableError(
            'This model has no zero data retention providers. Choose a model with a ZDR endpoint, or turn off Zero data retention. Your message wasn\'t sent.',
            { modelId, reason: 'model' });
    }

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        for (const listener of this.listeners) {
            try { listener(this); } catch (error) { console.warn('ZDR listener failed:', error); }
        }
    }
}

export const zeroDataRetention = new ZeroDataRetentionState();
export default zeroDataRetention;
