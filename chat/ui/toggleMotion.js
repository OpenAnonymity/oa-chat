// Only animate a real switch state change after interaction. Hydration and
// freshly rendered controls settle immediately, without an initial off bounce.
export function syncToggleMotion(button, { interacted = false, initial = false } = {}) {
    const thumb = button?.querySelector?.('.switch-toggle-indicator');
    if (!thumb) return;
    const on = button.getAttribute('aria-checked') === 'true';
    const previous = button.getAttribute('data-on');
    button.classList.add('t-toggle');
    thumb.classList.add('t-toggle-thumb');
    if (!initial && interacted && previous !== null && previous !== String(on)) button.classList.add('is-init');
    button.setAttribute('data-on', String(on));
}

export function installToggleMotion(root) {
    const view = root?.ownerDocument?.defaultView;
    if (!view?.MutationObserver) return () => {};
    const interacted = new WeakSet();
    const initialize = node => {
        if (node.matches?.('.switch-toggle[role="switch"]')) syncToggleMotion(node, { initial: true });
        for (const button of node.querySelectorAll?.('.switch-toggle[role="switch"]') || []) syncToggleMotion(button, { initial: true });
    };
    initialize(root);
    const intent = event => {
        if (event.type === 'keydown' && ![' ', 'Enter'].includes(event.key)) return;
        const button = event.target.closest?.('.switch-toggle[role="switch"]');
        if (button && !button.disabled) interacted.add(button);
    };
    root.addEventListener('pointerdown', intent, true);
    root.addEventListener('keydown', intent, true);
    const observer = new view.MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'attributes') {
                if (record.target.matches('.switch-toggle[role="switch"]')) syncToggleMotion(record.target, { interacted: interacted.has(record.target) });
            } else for (const node of record.addedNodes) if (node.nodeType === 1) initialize(node);
        }
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-checked'] });
    return () => {
        observer.disconnect();
        root.removeEventListener('pointerdown', intent, true);
        root.removeEventListener('keydown', intent, true);
    };
}
