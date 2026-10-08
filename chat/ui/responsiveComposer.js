// Layout-only state. Never clone the composer or its stateful controls.
export function isKeyboardViewport({ width, layoutHeight, height, scale = 1, editing }) {
    return width < 768 && editing && Math.abs(scale - 1) < 0.05
        && layoutHeight - height > 120;
}

export function setupResponsiveComposer({ input, onScrub }) {
    if (!input?.ownerDocument?.defaultView) return () => {};
    const doc = input.ownerDocument;
    const view = doc.defaultView;
    const root = doc.documentElement;
    const card = doc.getElementById('input-card');
    const menu = doc.getElementById('settings-menu');
    const button = doc.getElementById('settings-btn');
    const section = doc.getElementById('compact-composer-actions');
    const memory = doc.getElementById('memory-context-toggle');
    const mode = doc.getElementById('chat-mode-toggle');
    const send = doc.getElementById('send-btn');
    const scrub = doc.getElementById('compact-scrub-btn');
    if (!card || !menu || !button || !section || !memory || !mode || !send || !scrub) return () => {};

    let compact;
    const updateWidth = () => {
        const next = card.getBoundingClientRect().width < 560;
        if (next === compact) return;
        compact = next;
        root.dataset.composerCompact = String(compact);
        section.hidden = !compact;
        if (compact) {
            doc.getElementById('compact-memory-slot').append(memory);
            doc.getElementById('compact-mode-slot').append(mode);
        } else {
            send.before(memory, mode);
        }
        button.setAttribute('aria-label', compact ? 'More options' : 'Settings');
        button.setAttribute('data-tooltip', compact ? 'More options' : 'Settings');
    };
    let viewportFrame = null;
    let disposed = false;
    let previousViewport = {};
    const updateViewport = () => {
        viewportFrame = null;
        if (disposed) return;
        const viewport = view.visualViewport;
        const editing = doc.activeElement === input;
        const keyboard = isKeyboardViewport({
            width: view.innerWidth, layoutHeight: view.innerHeight,
            height: viewport?.height || view.innerHeight,
            scale: viewport?.scale || 1, editing
        });
        const height = `${viewport?.height || view.innerHeight}px`;
        const top = `${viewport?.offsetTop || 0}px`;
        if (keyboard !== previousViewport.keyboard) root.toggleAttribute('data-composer-keyboard', keyboard);
        if (height !== previousViewport.height) root.style.setProperty('--composer-viewport-height', height);
        if (top !== previousViewport.top) root.style.setProperty('--composer-viewport-top', top);
        previousViewport = { keyboard, height, top };
    };
    const scheduleViewport = () => {
        if (!disposed && viewportFrame === null) viewportFrame = view.requestAnimationFrame(updateViewport);
    };
    // A settings panel can dismiss via outside click or Escape as well as its button.
    const menuObserver = new MutationObserver(() => {
        button.setAttribute('aria-expanded', String(!menu.classList.contains('hidden')));
    });
    menuObserver.observe(menu, { attributes: true, attributeFilter: ['class'] });
    const resize = new ResizeObserver(updateWidth);
    resize.observe(card);
    view.addEventListener('resize', scheduleViewport);
    view.visualViewport?.addEventListener('resize', scheduleViewport);
    view.visualViewport?.addEventListener('scroll', scheduleViewport);
    doc.addEventListener('focusin', scheduleViewport);
    const afterBlur = scheduleViewport;
    doc.addEventListener('focusout', afterBlur);
    scrub.addEventListener('click', onScrub);
    updateWidth();
    updateViewport();
    return () => {
        disposed = true;
        if (viewportFrame !== null) view.cancelAnimationFrame(viewportFrame);
        resize.disconnect();
        menuObserver.disconnect();
        view.removeEventListener('resize', scheduleViewport);
        view.visualViewport?.removeEventListener('resize', scheduleViewport);
        view.visualViewport?.removeEventListener('scroll', scheduleViewport);
        doc.removeEventListener('focusin', scheduleViewport);
        doc.removeEventListener('focusout', afterBlur);
        scrub.removeEventListener('click', onScrub);
    };
}
