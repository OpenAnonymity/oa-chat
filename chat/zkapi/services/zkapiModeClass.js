export const ZKAPI_MODE_CLASS = 'zkapi-mode';

/** zkAPI is a colour axis, not a theme: html.zkapi-mode makes the shared
 * Light/Dark preference resolve to EF purple / indigo night (styles.css).
 * It follows the current chat's payment mode, so switching chats or
 * payment methods switches the colours; OA chats stay OA. The pre-hydration
 * script in index.html paints the first frame from the default mode.
 * Returns whether the class changed. */
export function applyZkapiModeClass(root, mode, { requestFrame = globalThis.requestAnimationFrame } = {}) {
    if (!root?.classList) return false;
    const on = mode === 'zkapi';
    if (root.classList.contains(ZKAPI_MODE_CLASS) === on) return false;
    // Same treatment as a theme change: colours swap in one frame instead of
    // each element easing on its own schedule.
    root.classList.add('switching-theme');
    root.classList.toggle(ZKAPI_MODE_CLASS, on);
    if (typeof requestFrame === 'function') {
        requestFrame(() => requestFrame(() => root.classList.remove('switching-theme')));
    } else {
        root.classList.remove('switching-theme');
    }
    return true;
}
