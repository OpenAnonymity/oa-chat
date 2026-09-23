// The composer keeps its DOM identity. FLIP animates only its position, leaving
// transcript geometry unchanged for the existing prompt/scroll anchoring logic.
const arrivals = new WeakMap();

export function cancelChatArrival(container) {
    const arrival = container && arrivals.get(container);
    arrival?.cleanup();
}

// New notifications use the docked destination, never a moving animation frame.
export function getChatArrivalDestination(container) {
    return container && arrivals.get(container)?.destination;
}

export function leaveChatArrival(container, { animate = true } = {}) {
    cancelChatArrival(container);
    const welcome = container?.querySelector('.welcome-landing');
    const stage = container?.closest?.('#chat-stage');
    const composer = stage?.querySelector('#input-card');
    if (!welcome || !composer) return;
    const view = container.ownerDocument.defaultView;
    const reduced = view.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduced || !composer.animate) {
        welcome.remove();
        return;
    }

    const before = composer.getBoundingClientRect();
    const brand = welcome.getBoundingClientRect();
    const main = stage.closest('main');
    const mainRect = main.getBoundingClientRect();
    welcome.remove();
    const after = composer.getBoundingClientRect();
    welcome.classList.add('chat-arrival-outgoing');
    welcome.setAttribute('aria-hidden', 'true');
    welcome.inert = true;
    Object.assign(welcome.style, {
        top: `${brand.top - mainRect.top}px`, left: `${brand.left - mainRect.left}px`,
        width: `${brand.width}px`, height: `${brand.height}px`
    });
    main.appendChild(welcome);

    // Transitions.dev position-change ease, 500ms emphasis and 400ms reveal.
    const easing = 'cubic-bezier(.22, 1, .36, 1)';
    const animations = [
        composer.animate([
            { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)` },
            { transform: 'translate(0, 0)' }
        ], { duration: 500, easing }),
        welcome.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'none' }],
            { duration: 200, fill: 'forwards' }),
        container.animate([{ opacity: 0 }, { opacity: 1 }],
            { duration: 400, delay: 100, fill: 'backwards', easing })
    ];
    const cleanup = () => {
        for (const animation of animations) animation.cancel();
        welcome.remove();
        view.removeEventListener('resize', cleanup);
        view.visualViewport?.removeEventListener('resize', cleanup);
        arrivals.delete(container);
    };
    arrivals.set(container, { cleanup, destination: after });
    view.addEventListener('resize', cleanup, { once: true });
    view.visualViewport?.addEventListener('resize', cleanup, { once: true });
    Promise.all(animations.map(animation => animation.finished)).then(() => {
        if (arrivals.get(container)?.cleanup === cleanup) cleanup();
    }, () => {}); // Cancellation is normal when changing chats or resizing.
}
