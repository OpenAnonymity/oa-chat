const KEY = 'oa-zkapi-welcome-modal';

export function readWelcomeModalIntent() {
    try {
        const saved = JSON.parse(globalThis.window?.sessionStorage?.getItem(KEY) || 'null');
        return saved?.open === true ? saved : null;
    } catch { return null; }
}

export function writeWelcomeModalIntent(value) {
    try {
        if (value) globalThis.window?.sessionStorage?.setItem(KEY, JSON.stringify(value));
        else globalThis.window?.sessionStorage?.removeItem(KEY);
    } catch { /* Optional tab presentation state never blocks wallet work. */ }
}
