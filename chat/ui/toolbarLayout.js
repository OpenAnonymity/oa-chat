const CONTROL_CLEARANCE = 12;

// Floating controls need clear gutters on both sides of the transcript.
export function canFloatToolbar({ viewportWidth, contentLeft, contentRight, controls }) {
    if (viewportWidth < 768 || !(contentRight > contentLeft)) return false;
    return controls.every(({ left, right }) => right <= left ||
        right + CONTROL_CLEARANCE <= contentLeft ||
        left - CONTROL_CLEARANCE >= contentRight);
}

export function updateToolbarBackdrop({ toolbar, messagesContainer, widthDelta = 0 }) {
    if (!toolbar || !messagesContainer) return;
    // Panel changes can start before their first measured frame. Cover the
    // transcript now; resize observation then follows the actual animation.
    if (widthDelta !== 0) {
        toolbar.classList.remove('toolbar-wide');
        return;
    }
    const view = toolbar.ownerDocument.defaultView;
    const content = messagesContainer.getBoundingClientRect();
    const style = view.getComputedStyle(messagesContainer);
    const floats = canFloatToolbar({
        viewportWidth: view.innerWidth,
        contentLeft: content.left + (parseFloat(style.paddingLeft) || 0),
        contentRight: content.right - (parseFloat(style.paddingRight) || 0),
        controls: Array.from(toolbar.children, group => group.getBoundingClientRect())
    });
    toolbar.classList.toggle('toolbar-wide', floats);
}

export function watchToolbarLayout({ toolbar, messagesContainer, chatArea }) {
    const update = () => updateToolbarBackdrop({ toolbar, messagesContainer });
    const Observer = toolbar?.ownerDocument.defaultView.ResizeObserver;
    if (!toolbar || !messagesContainer || !Observer) return () => {};
    const observer = new Observer(update);
    // Watch the actual groups, including controls inserted by commercial UI,
    // so a payment switch, Share label, or font change updates the threshold.
    for (const node of new Set([toolbar, ...toolbar.children, messagesContainer, chatArea])) {
        if (node) observer.observe(node);
    }
    update();
    return () => observer.disconnect();
}
