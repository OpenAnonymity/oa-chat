const PROVIDERS = {
    openai: { displayName: 'OpenAI', asset: 'img/openai.svg' },
    anthropic: { displayName: 'Anthropic', asset: 'img/claude.svg' },
    google: { displayName: 'Google', asset: 'img/gemini.svg' },
    'meta-llama': { displayName: 'Meta', asset: 'img/meta.svg' },
    mistralai: { displayName: 'Mistral', asset: 'img/mistral.svg' },
    deepseek: { displayName: 'DeepSeek', asset: 'img/deepseek.svg' },
    cohere: { displayName: 'Cohere', asset: 'img/cohere.ico' },
    perplexity: { displayName: 'Perplexity', asset: 'img/perplexity.png' },
    qwen: { displayName: 'Qwen', asset: 'img/qwen.svg' },
    alibaba: { displayName: 'Qwen', asset: 'img/qwen.svg' },
    nvidia: { displayName: 'Nvidia', asset: 'img/nvidia.svg' },
    openrouter: { displayName: 'OpenRouter', asset: 'img/openrouter.svg' },
    'x-ai': { displayName: 'xAI', asset: 'img/xai.svg' },
    'z-ai': { displayName: 'Z.ai', asset: 'img/zai.svg' },
    minimax: { displayName: 'MiniMax', asset: 'img/minimax.svg' },
    moonshotai: { displayName: 'Moonshot AI', asset: 'img/moonshot.svg' },
    nousresearch: { displayName: 'Nous Research', asset: 'img/nousresearch.svg' },
    amazon: { displayName: 'AWS', asset: 'img/aws.svg' },
    tencent: { displayName: 'Tencent', asset: 'img/tencent.svg' },
    'bytedance-seed': { displayName: 'ByteDance', asset: 'img/bytedance.svg' },
    bytedance: { displayName: 'ByteDance', asset: 'img/bytedance.svg' },
    microsoft: { displayName: 'Microsoft', asset: 'img/microsoft.svg' },
    'ibm-granite': { displayName: 'IBM', asset: 'img/ibm.svg' },
    ai21: { displayName: 'AI21', asset: 'img/ai21.svg' },
    'aion-labs': { displayName: 'AionLabs', asset: 'img/aionlabs.svg' },
    'arcee-ai': { displayName: 'Arcee AI', asset: 'img/arcee.svg' },
    xiaomi: { displayName: 'Xiaomi', asset: 'img/xiaomi.svg' },
    stepfun: { displayName: 'StepFun', asset: 'img/stepfun.svg' },
    relace: { displayName: 'Relace', asset: 'img/relace.svg' },
    morph: { displayName: 'Morph', asset: 'img/morph.svg' },
    liquid: { displayName: 'Liquid', asset: 'img/liquid.svg' },
    inflection: { displayName: 'Inflection', asset: 'img/inflection.svg' },
    inception: { displayName: 'Inception', asset: 'img/inception.svg' },
    baidu: { displayName: 'Baidu', asset: 'img/baidu.svg' },
    upstage: { displayName: 'Upstage', asset: 'img/upstage.svg' }
};

const VALID_PROVIDER_SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const DISPLAY_NAME_TO_SLUG = new Map();
for (const [slug, provider] of Object.entries(PROVIDERS)) {
    const key = provider.displayName.toLowerCase();
    if (!DISPLAY_NAME_TO_SLUG.has(key)) {
        DISPLAY_NAME_TO_SLUG.set(key, slug);
    }
}

function unknownProvider() {
    return { slug: null, displayName: 'Unknown' };
}

function humanizeSlug(slug) {
    return slug
        .replace(/[-_]+/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function resolveSlug(slug) {
    if (!VALID_PROVIDER_SLUG.test(slug)) {
        return unknownProvider();
    }

    const registeredProvider = PROVIDERS[slug];
    const humanizedDisplayName = humanizeSlug(slug);
    const displayNameCollides = DISPLAY_NAME_TO_SLUG.has(humanizedDisplayName.toLowerCase());

    return {
        slug,
        displayName: registeredProvider?.displayName
            || (displayNameCollides ? `${humanizedDisplayName} (${slug})` : humanizedDisplayName)
    };
}

export function resolveProvider(value) {
    if (typeof value !== 'string') {
        return unknownProvider();
    }

    const candidate = value.trim();
    const displayNameSlug = DISPLAY_NAME_TO_SLUG.get(candidate.toLowerCase());
    return resolveSlug(displayNameSlug || candidate);
}

export function resolveProviderFromModelId(modelId) {
    if (typeof modelId !== 'string') {
        return unknownProvider();
    }

    const author = modelId.split('/', 1)[0];
    return resolveSlug(author.startsWith('~') ? author.slice(1) : author);
}

export function getProviderAsset(displayName) {
    const { slug } = resolveProvider(displayName);
    return slug ? PROVIDERS[slug]?.asset || null : null;
}
