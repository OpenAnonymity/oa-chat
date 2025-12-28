/**
 * URL Metadata Service
 * Fetches and caches metadata (title, description, favicon) for URLs.
 */

// In-memory cache for URL metadata
const metadataCache = new Map();
const MAX_CACHE_SIZE = 500;

/**
 * Ensures cache doesn't exceed max size by removing oldest entry if needed.
 */
function ensureCacheSize() {
    if (metadataCache.size >= MAX_CACHE_SIZE) {
        const firstKey = metadataCache.keys().next().value;
        metadataCache.delete(firstKey);
    }
}

/**
 * Extracts domain name from a URL.
 * @param {string} url - The URL to extract from
 * @returns {string} The domain name
 */
function extractDomain(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.replace('www.', '');
    } catch (e) {
        return url;
    }
}

/**
 * Fetches metadata for a URL using a CORS proxy.
 * Falls back to basic metadata if fetch fails.
 * @param {string} url - The URL to fetch metadata for
 * @returns {Promise<Object>} Metadata object with title, description, favicon, domain
 */
async function fetchUrlMetadata(url) {
    // Check cache first
    if (metadataCache.has(url)) {
        return metadataCache.get(url);
    }

    const domain = extractDomain(url);

    // Default metadata
    const defaultMetadata = {
        title: domain,
        description: url,
        favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=32`,
        domain: domain,
        url: url
    };

    try {
        // Try multiple approaches for better performance
        // First, try a faster approach using a simple HEAD request for basic info
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500); // 1.5 second timeout

        // Use cors-anywhere alternative or allorigins as fallback
        const proxies = [
            `https://corsproxy.io/?${encodeURIComponent(url)}`,
            `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`
        ];

        let response;
        let html = '';
        let usedProxy = null;

        // Try proxies in order until one works
        for (const proxyUrl of proxies) {
            try {
                response = await fetch(proxyUrl, {
                    signal: controller.signal,
                    headers: {
                        'Accept': 'text/html',
                        'User-Agent': 'Mozilla/5.0 (compatible; LinkPreview/1.0)'
                    }
                });

                if (response.ok) {
                    if (proxyUrl.includes('allorigins')) {
                        const data = await response.json();
                        html = data.contents;
                    } else {
                        html = await response.text();
                    }
                    usedProxy = proxyUrl;
                    break;
                }
            } catch (e) {
                // Try next proxy
                continue;
            }
        }

        clearTimeout(timeoutId);

        if (!html) {
            throw new Error('All proxies failed');
        }

        // Parse HTML to extract metadata
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Extract title
        let title = doc.querySelector('meta[property="og:title"]')?.content ||
                   doc.querySelector('meta[name="twitter:title"]')?.content ||
                   doc.querySelector('title')?.textContent ||
                   domain;

        // Extract description
        let description = doc.querySelector('meta[property="og:description"]')?.content ||
                         doc.querySelector('meta[name="twitter:description"]')?.content ||
                         doc.querySelector('meta[name="description"]')?.content ||
                         '';

        // Extract favicon - always use Google's favicon service for consistency
        // This is more reliable than trying to parse from HTML
        let favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

        const metadata = {
            title: title.trim().substring(0, 100),
            description: description.trim().substring(0, 200),
            favicon: favicon,
            domain: domain,
            url: url
        };

        // Cache the result
        ensureCacheSize();
        metadataCache.set(url, metadata);

        return metadata;
    } catch (error) {
        console.debug('Failed to fetch metadata for', url, error.message);
        // Cache the default metadata to avoid repeated failed requests
        ensureCacheSize();
        metadataCache.set(url, defaultMetadata);
        return defaultMetadata;
    }
}

/**
 * Fetches metadata for multiple URLs in parallel.
 * @param {Array<string>} urls - Array of URLs to fetch metadata for
 * @returns {Promise<Array<Object>>} Array of metadata objects
 */
async function fetchMultipleUrlMetadata(urls) {
    const promises = urls.map(url => fetchUrlMetadata(url));
    return await Promise.all(promises);
}

/**
 * Clears the metadata cache.
 */
function clearMetadataCache() {
    metadataCache.clear();
}

/**
 * Gets metadata from cache synchronously (no fetch).
 * @param {string} url - The URL to look up
 * @returns {Object|null} Cached metadata or null if not cached
 */
function getFromCache(url) {
    return metadataCache.get(url) || null;
}

/**
 * Adds metadata to cache directly (for pre-populating from citation data).
 * @param {string} url - The URL to cache
 * @param {Object} metadata - Metadata object with title, description, favicon, domain
 */
function addToCache(url, metadata) {
    if (!url || !metadata) return;
    ensureCacheSize();
    metadataCache.set(url, {
        title: metadata.title || extractDomain(url),
        description: metadata.description || '',
        favicon: metadata.favicon || `https://www.google.com/s2/favicons?domain=${extractDomain(url)}&sz=32`,
        domain: metadata.domain || extractDomain(url),
        url: url
    });
}

export {
    fetchUrlMetadata,
    fetchMultipleUrlMetadata,
    clearMetadataCache,
    extractDomain,
    getFromCache,
    addToCache
};

