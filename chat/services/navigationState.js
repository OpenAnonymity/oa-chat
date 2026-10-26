import { hasConversationParam } from './conversationLink.js';

const NAVIGATION_KEY = 'oa-chat-navigation-v1';
const LEGACY_KEY = 'oa-current-session';
// Device-level return point for an installed web app only. iOS relaunches an
// evicted home-screen app as a fresh page with empty sessionStorage; this lets
// it reopen the chat that was open. Browser tabs never read it, so a new tab
// still starts on New Chat.
const RETURN_POINT_KEY = 'oa-chat-return-point-v1';
const RETURN_POINT_TTL_MS = 24 * 60 * 60 * 1000;

function tabStorage() {
    try { return globalThis.sessionStorage; } catch { return null; }
}

function deviceStorage() {
    try { return globalThis.localStorage; } catch { return null; }
}

export function isInstalledWebApp(windowImpl = globalThis.window) {
    try {
        return windowImpl?.navigator?.standalone === true
            || windowImpl?.matchMedia?.('(display-mode: standalone)')?.matches === true;
    } catch {
        return false;
    }
}

function normalizeScroll(scroll) {
    if (!scroll || typeof scroll !== 'object') return null;
    const top = Number(scroll.top);
    return { top: Number.isFinite(top) && top > 0 ? top : 0, atBottom: scroll.atBottom === true };
}

/** Records (or with no session id, forgets) where an installed app should reopen. */
export function rememberReturnPoint(sessionId, scroll = null, storage = deviceStorage(), now = Date.now()) {
    try {
        if (typeof sessionId !== 'string' || !sessionId) {
            storage?.removeItem(RETURN_POINT_KEY);
            return;
        }
        storage?.setItem(RETURN_POINT_KEY, JSON.stringify({ version: 1, sessionId, scroll: normalizeScroll(scroll), at: now }));
    } catch {
        // Restricted storage only costs the return point.
    }
}

function readReturnPoint(storage = deviceStorage(), now = Date.now()) {
    try {
        const point = JSON.parse(storage?.getItem(RETURN_POINT_KEY) || 'null');
        if (point?.version !== 1 || typeof point.sessionId !== 'string' || !point.sessionId) return null;
        if (!(now - Number(point.at) < RETURN_POINT_TTL_MS)) return null;
        return { sessionId: point.sessionId, scroll: normalizeScroll(point.scroll) };
    } catch {
        return null;
    }
}

export function saveNavigationSelection(sessionId, storage = tabStorage(), returnStorage = deviceStorage(),
    installed = isInstalledWebApp()) {
    const selection = typeof sessionId === 'string' && sessionId
        ? { version: 1, kind: 'conversation', sessionId }
        : { version: 1, kind: 'new-chat' };
    try {
        // The versioned record wins if a legacy write is interrupted.
        storage?.setItem(NAVIGATION_KEY, JSON.stringify(selection));
        if (selection.kind === 'conversation') storage?.setItem(LEGACY_KEY, sessionId);
        else storage?.removeItem(LEGACY_KEY);
    } catch {
        // Restricted storage must not prevent navigation or payment recovery.
    }
    // Only an installed app keeps a return point: browser tabs never write
    // a chat id to device storage (and never clear the app's).
    if (!installed) return selection;
    // Keep the scroll recorded for this same chat; anything else replaces it.
    const existing = readReturnPoint(returnStorage);
    if (selection.kind === 'conversation') {
        rememberReturnPoint(sessionId, existing?.sessionId === sessionId ? existing.scroll : null, returnStorage);
    } else {
        rememberReturnPoint(null, null, returnStorage);
    }
    return selection;
}

export function readNavigationSelection(storage = tabStorage()) {
    try {
        const raw = storage?.getItem(NAVIGATION_KEY);
        if (raw) {
            const selection = JSON.parse(raw);
            if (selection?.version === 1 && selection.kind === 'new-chat') return selection;
            if (selection?.version === 1 && selection.kind === 'conversation' &&
                typeof selection.sessionId === 'string' && selection.sessionId) return selection;
            return { version: 1, kind: 'new-chat' };
        }
        const legacy = storage?.getItem(LEGACY_KEY);
        return legacy ? { version: 1, kind: 'conversation', sessionId: legacy } : null;
    } catch {
        return null;
    }
}

export async function restoreNavigationSelection({ search = '', loadSession, storage = tabStorage(),
    returnStorage = deviceStorage(), installed = isInstalledWebApp(), now = Date.now() }) {
    // Explicit links retain the ordinary local/shared-link resolution path.
    if (hasConversationParam(search)) return null;
    const selection = readNavigationSelection(storage);
    if (!selection && installed) {
        const point = readReturnPoint(returnStorage, now);
        if (point && await loadSession(point.sessionId)) {
            return { ...saveNavigationSelection(point.sessionId, storage, returnStorage, installed), scroll: point.scroll };
        }
        return null;
    }
    if (selection?.kind !== 'conversation') return selection;
    if (await loadSession(selection.sessionId)) return selection;
    return saveNavigationSelection(null, storage, returnStorage, installed);
}

// Shared by the fast first paint and app bootstrap. Explicit links take priority
// even when this tab last selected New Chat.
export function isConversationRestorePending({ search = '', storage = tabStorage(),
    returnStorage = deviceStorage(), installed = isInstalledWebApp(), now = Date.now() } = {}) {
    if (hasConversationParam(search)) return true;
    const selection = readNavigationSelection(storage);
    if (selection) return selection.kind === 'conversation';
    return installed && Boolean(readReturnPoint(returnStorage, now));
}
