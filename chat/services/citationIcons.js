// Only bundled assets: displaying response-derived domains must not contact
// a favicon service, the cited website, or an OA metadata proxy.
const SITE_ICONS = Object.freeze({
    'openai.com': 'img/openai.svg',
    'anthropic.com': 'img/claude.ico',
    'openrouter.ai': 'img/openrouter.svg',
    'perplexity.ai': 'img/perplexity.png',
    'deepseek.com': 'img/deepseek.svg',
    'mistral.ai': 'img/mistral.svg',
    'nvidia.com': 'img/nvidia.svg',
    'x.ai': 'img/xai.svg'
});

export function citationIconHtml(url) {
    let host = '';
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') host = parsed.hostname.toLowerCase();
    } catch { /* Invalid sources receive the local generic website symbol. */ }
    const domain = Object.keys(SITE_ICONS).find(site => host === site || host.endsWith(`.${site}`));
    if (domain) return `<img class="citation-site-icon" src="${SITE_ICONS[domain]}" alt="" aria-hidden="true" loading="lazy">`;
    return '<svg class="citation-site-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6 6.5h1M9 6.5h1" stroke-linecap="round"/></svg>';
}
