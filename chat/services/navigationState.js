const NAVIGATION_KEY = 'oa-chat-navigation-v1';
const LEGACY_KEY = 'oa-current-session';

function tabStorage() {
    try { return globalThis.sessionStorage; } catch { return null; }
}

export function saveNavigationSelection(sessionId, storage = tabStorage()) {
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

export async function restoreNavigationSelection({ search = '', loadSession, storage = tabStorage() }) {
    // Explicit links retain the ordinary local/shared-link resolution path.
    if (new URLSearchParams(search).has('s')) return null;
    const selection = readNavigationSelection(storage);
    if (selection?.kind !== 'conversation') return selection;
    if (await loadSession(selection.sessionId)) return selection;
    return saveNavigationSelection(null, storage);
}
