// A scroll box with more content in a direction ends in a soft edge, not a
// hard one: the last lines dissolve instead of being sliced by the box.
// The mask exists only where there is more to see, so a short trace that
// fits keeps its last line whole. CSS reads `data-scroll-fade` on the box.

const EDGE_PX = 6;

/** Recompute which edges of `el` hide more content, and stamp it. */
export function syncScrollFade(el) {
    if (!el || typeof el.scrollHeight !== 'number') return '';
    const above = el.scrollTop > EDGE_PX;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight > EDGE_PX;
    const value = above && below ? 'both' : above ? 'top' : below ? 'bottom' : '';
    if ((el.dataset.scrollFade || '') !== value) {
        if (value) el.dataset.scrollFade = value;
        else delete el.dataset.scrollFade;
    }
    return value;
}

/** Keep every matching box in sync as it scrolls. Scroll does not bubble,
 *  so this listens in the capture phase once for the whole document. */
export function watchScrollFade(root, selector) {
    if (!root?.addEventListener) return () => {};
    const onScroll = event => {
        const target = event.target;
        if (target?.matches?.(selector)) syncScrollFade(target);
    };
    root.addEventListener('scroll', onScroll, true);
    return () => root.removeEventListener('scroll', onScroll, true);
}

/** After a render, boxes may already overflow without ever having scrolled. */
export function syncAllScrollFades(root, selector) {
    root?.querySelectorAll?.(selector).forEach(syncScrollFade);
}
