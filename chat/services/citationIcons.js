// Site icons for cited and linked hosts.
//
// Product decision, 2026-10-09: recognisable sources beat local markers, so
// icons come from DuckDuckGo's icon service again, as they did before
// 2026-08-21. The cost is explicit: rendering an answer asks
// icons.duckduckgo.com for each cited or linked hostname, so that service learns
// those hostnames and the browser's IP before the user opens anything. It never
// learns the full URL (hostname only, no referrer), and the cited site itself is
// still contacted only when the user opens the link. Preview proxies stay gone.
// Icons for the providers we ship with are bundled; a local website symbol is
// the fallback when the service has no icon or cannot be reached.
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

export const ICON_SERVICE = 'https://icons.duckduckgo.com/ip3/';

const LOCAL_SITE_SYMBOL = '<svg class="citation-site-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6 6.5h1M9 6.5h1" stroke-linecap="round"/></svg>';

// On error the image hides itself and reveals the local symbol next to it.
const ON_ERROR = "this.style.display='none';this.nextElementSibling.style.display='';";

export function citationIconHost(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.hostname.toLowerCase();
    } catch { /* Invalid sources receive the local generic website symbol. */ }
    return '';
}

// '' when the URL is not an http(s) URL; a bundled asset for shipped providers;
// otherwise the icon service URL for the hostname alone.
export function citationIconUrl(url) {
    const host = citationIconHost(url);
    if (!host) return '';
    const bundled = Object.keys(SITE_ICONS).find(site => host === site || host.endsWith(`.${site}`));
    if (bundled) return SITE_ICONS[bundled];
    return `${ICON_SERVICE}${encodeURIComponent(host)}.ico`;
}

export function citationIconHtml(url) {
    const src = citationIconUrl(url);
    if (!src) return LOCAL_SITE_SYMBOL;
    const safeSrc = src.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    return `<img class="citation-site-icon" src="${safeSrc}" alt="" aria-hidden="true" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="${ON_ERROR}">` +
        LOCAL_SITE_SYMBOL.replace('<svg ', '<svg style="display:none" ');
}
