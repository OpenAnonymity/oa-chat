/**
 * URL Metadata Service
 * Derives and caches display-safe metadata without contacting the cited origin
 * or any third-party preview/favicon service.
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
 * Derives local metadata for a URL. Citation and response URLs are sensitive
 * inference output, so rendering them must not create automatic network traffic.
 * @param {string} url - The URL to fetch metadata for
 * @returns {Promise<Object>} Metadata object with title, description, favicon, domain
 */
async function fetchUrlMetadata(url) {
    // Check cache first
    if (metadataCache.has(url)) {
        return metadataCache.get(url);
    }

    const domain = extractDomain(url);

    const metadata = {
        title: domain,
        description: '',
        favicon: '',
        domain: domain,
        url: url
    };
    ensureCacheSize();
    metadataCache.set(url, metadata);
    return metadata;
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
        favicon: '',
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
