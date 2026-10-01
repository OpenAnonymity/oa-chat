/** Explicit production relay selection; independent of verifier-bypass demos. */
export function productionProxyUrl(raw = '') {
    if (!raw) return '';
    let url;
    try { url = new URL(raw); } catch { throw new Error('OA_PROXY_URL must be an exact root WSS origin'); }
    if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('OA_PROXY_URL must be an exact root WSS origin');
    }
    return url.toString();
}
