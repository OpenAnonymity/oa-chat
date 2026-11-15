// Presentation only: these follow-ups belong to a phone, in Safari or a Home Screen app.
// A narrow browser window, touch laptop or Electron app must keep its layout.
const queries = ['(max-width: 767px)', '(pointer: coarse)'];
const attribute = 'data-phone-app-panels';
export const PHONE_APP_LAYOUT_CHANGE = 'oa-phone-app-layout-change';

export function isPhoneAppLayout(view = globalThis.window) {
    if (!view || view.electronAPI?.isElectron || view.location?.protocol === 'app:') return false;
    const phone = Number.isFinite(view.innerWidth) && view.innerWidth < 768;
    const screenSide = Math.min(view.screen?.width || Infinity, view.screen?.height || Infinity);
    const touch = view.navigator?.maxTouchPoints > 0
        && view.matchMedia?.('(pointer: coarse)')?.matches === true;
    return phone && screenSide < 768 && touch;
}

export function watchPhoneAppLayout({ view = globalThis.window, root = globalThis.document?.documentElement } = {}) {
    if (!view || !root) return () => {};
    const update = () => {
        const active = isPhoneAppLayout(view);
        if (root.hasAttribute(attribute) !== active) {
            root.toggleAttribute(attribute, active);
            view.dispatchEvent?.(new Event(PHONE_APP_LAYOUT_CHANGE));
        }
    };
    const media = queries.map(query => view.matchMedia?.(query)).filter(Boolean);
    for (const query of media) query.addEventListener?.('change', update);
    update();
    return () => {
        for (const query of media) query.removeEventListener?.('change', update);
        root.removeAttribute(attribute);
    };
}
