// The address of a conversation is `/?c=<id>`: a chat saved in this browser,
// or a share (the same parameter, see checkForUrlSession in app.js).
//
// `c` replaced `s` on 2026-09-30 for the Fathom Analytics install. Fathom's
// tracker forwards a fixed allow-list of query parameters with every pageview
// and `s` is on it (WordPress uses it for search), so every conversation and
// share ID would have been recorded. `c` is not on the list. `s` is still
// read so links made before the rename, and by native apps that have not
// caught up, keep opening; such an address is rewritten to `c` on arrival.
export const CONVERSATION_PARAM = 'c';
export const LEGACY_CONVERSATION_PARAM = 's';

function paramsOf(search) {
    if (search instanceof URLSearchParams) return search;
    return new URLSearchParams(typeof search === 'string' ? search : '');
}

/** True when the address names a conversation, even with an empty value. */
export function hasConversationParam(search = '') {
    const params = paramsOf(search);
    return params.has(CONVERSATION_PARAM) || params.has(LEGACY_CONVERSATION_PARAM);
}

/** The conversation ID in the address (`''` for `?c=`), or null when absent. */
export function readConversationParam(search = '') {
    const params = paramsOf(search);
    if (params.has(CONVERSATION_PARAM)) return params.get(CONVERSATION_PARAM);
    if (params.has(LEGACY_CONVERSATION_PARAM)) return params.get(LEGACY_CONVERSATION_PARAM);
    return null;
}

/** Point `url` at a conversation, replacing either spelling. Mutates `url`. */
export function setConversationParam(url, id) {
    url.searchParams.delete(LEGACY_CONVERSATION_PARAM);
    url.searchParams.set(CONVERSATION_PARAM, id);
    return url;
}

/** Remove the conversation from `url`, whichever spelling it used. Mutates `url`. */
export function deleteConversationParam(url) {
    url.searchParams.delete(CONVERSATION_PARAM);
    url.searchParams.delete(LEGACY_CONVERSATION_PARAM);
    return url;
}

/** The query string for a link to `id`, ready to append to a base URL. */
export function conversationQuery(id) {
    return `?${CONVERSATION_PARAM}=${encodeURIComponent(String(id))}`;
}

/**
 * Rewrite a legacy `?s=` address to `?c=` in place, keeping the rest of the
 * query, the fragment, and the history state. Runs at startup before any
 * pageview is reported. Returns true when the address changed.
 */
export function normalizeConversationAddress(
    locationImpl = globalThis.location,
    historyImpl = globalThis.history
) {
    try {
        const url = new URL(locationImpl.href);
        if (!url.searchParams.has(LEGACY_CONVERSATION_PARAM)) return false;
        const id = url.searchParams.get(LEGACY_CONVERSATION_PARAM);
        url.searchParams.delete(LEGACY_CONVERSATION_PARAM);
        if (!url.searchParams.has(CONVERSATION_PARAM)) url.searchParams.set(CONVERSATION_PARAM, id);
        historyImpl.replaceState(historyImpl.state ?? null, '', url.toString());
        return true;
    } catch {
        return false;
    }
}
