export const ZKAPI_THEME_APPLIED_KEY = 'oa-zkapi-default-theme-applied-v1';
export const THEME_PREFERENCE_KEY = 'oa-theme-preference';

/** zkAPI starts in EF purple. The theme itself is shared — changing it in
 * either mode changes both — so this runs once per browser: the first time
 * zkAPI is used, and only if the person has never chosen a theme. Returns
 * whether the theme was set. */
export function applyZkapiDefaultTheme(storage, manager) {
    try {
        if (!storage || !manager || storage.getItem(ZKAPI_THEME_APPLIED_KEY)) return false;
        storage.setItem(ZKAPI_THEME_APPLIED_KEY, '1');
        if (storage.getItem(THEME_PREFERENCE_KEY)) return false;
        manager.setPreference('purple');
        return true;
    } catch {
        return false;
    }
}
