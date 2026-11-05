/**
 * Zero data retention (ZDR) routing for OpenRouter requests.
 *
 * When the person turns ZDR on, every OpenRouter request must reach only
 * endpoints whose provider has a zero data retention policy. OpenRouter's
 * `provider.zdr: true` alone still admits "Safety Retention" endpoints when
 * account or guardrail settings allow them, and there is no request field
 * that excludes those. So each request also carries `provider.only`: the
 * providers that serve this exact model with ZDR and without safety
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

/**
 * The provider identifier OpenRouter accepts in `provider.only`. Endpoint
 * tags look like `amazon-bedrock` or `amazon-bedrock/us-east-1`; the slug is
 * the part before the slash. The display name is a fallback only.
 */
export function providerSlugForEndpoint(entry) {
    const tag = firstString(entry?.tag, entry?.provider_slug, entry?.slug);
    if (tag) return tag.split('/')[0].toLowerCase();
    return firstString(entry?.provider_name, typeof entry?.provider === 'string' ? entry.provider : '', entry?.provider?.name);
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
 * Builds model id → eligible provider slugs from the ZDR endpoint list.
 * An endpoint counts only when it states `safety_retention: false`; a missing
 * or unexpected value is treated as retention (excluded), so a format change
 * hides models rather than admitting a retaining endpoint.
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
        if (entry.safety_retention !== false) continue;
        if (entry.zdr === false) continue;
        const modelId = endpointModelId(entry);
        const provider = providerSlugForEndpoint(entry);
        if (!modelId || !provider) continue;
        if (!byModel.has(modelId)) byModel.set(modelId, new Set());
        byModel.get(modelId).add(provider);
    }
    return new Map([...byModel].map(([modelId, providers]) => [modelId, [...providers].sort()]));
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
    if (Array.isArray(existing.only) && existing.only.length) {
        const allowed = new Set(existing.only.map(value => String(value).toLowerCase()));
        providers = providers.filter(provider => allowed.has(provider.toLowerCase()));
    }
    if (!providers.length) {
        throw new ZdrUnavailableError(
            'This model has no zero data retention providers. Choose a model with a shield, or turn off Zero data retention. Your message wasn\'t sent.',
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
class ZeroDataRetentionState {
    constructor() {
        this.enabled = false;
        this.catalog = null;
        this.loadPromise = null;
        this.listeners = new Set();
        this.settingsStore = null;
        this.fetchJson = null;
    }

    configure({ settingsStore, fetchJson } = {}) {
        if (settingsStore) this.settingsStore = settingsStore;
        if (fetchJson) this.fetchJson = fetchJson;
    }

    async restore() {
        try {
            const saved = await this.settingsStore?.getSetting?.(ZDR_SETTING_KEY);
            this.enabled = saved === true;
        } catch {
            this.enabled = false;
        }
        this.notify();
        // Shields need the list even while the switch is off.
        this.ensureCatalog().catch(() => {});
        return this.enabled;
    }

    isEnabled() {
        return this.enabled;
    }

    async setEnabled(enabled) {
        this.enabled = enabled === true;
        this.notify();
        try { await this.settingsStore?.saveSetting?.(ZDR_SETTING_KEY, this.enabled); } catch { /* setting stays in memory */ }
        if (this.enabled) this.ensureCatalog().catch(() => {});
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
        return applyZeroDataRetention(body, { enabled: this.enabled, catalog: this.catalog });
    }

    /**
     * Pre-send check for the UI, before any ticket is spent. Loads the list
     * if needed. Returns null when sending may proceed, or the error.
     */
    async checkModel(modelId, backendId = 'openrouter') {
        if (!this.enabled || !ZDR_BACKEND_IDS.includes(backendId)) return null;
        try {
            await this.ensureCatalog();
        } catch {
            return new ZdrUnavailableError(
                'Zero data retention is on, but the list of zero data retention providers couldn\'t load. Your message wasn\'t sent.',
                { modelId, reason: 'catalog' });
        }
        if (this.supportsModel(modelId)) return null;
        return new ZdrUnavailableError(
            'This model has no zero data retention providers. Choose a model with a shield, or turn off Zero data retention. Your message wasn\'t sent.',
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
