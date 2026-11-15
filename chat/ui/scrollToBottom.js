// Keep reversal of the existing fade interruptible. One timer per button;
// repeated scroll events must not create a queue of stale hide callbacks.
const pendingHides = new WeakMap();

export function setScrollButtonVisible(button, visible) {
    if (!button) return;
    const pending = pendingHides.get(button);
    if (visible) {
        clearTimeout(pending);
        pendingHides.delete(button);
        if (button.classList.contains('hidden')) {
            button.classList.remove('hidden');
            void button.offsetWidth;
        }
        button.classList.add('visible');
    } else if (!button.classList.contains('hidden') && pending === undefined) {
        button.classList.remove('visible');
        pendingHides.set(button, setTimeout(() => {
            pendingHides.delete(button);
            button.classList.add('hidden');
        }, 200));
    }
}

// A smooth scroll may be interrupted or chase a growing response forever.
// Stop waiting on manual input, a different chat, reaching bottom or a deadline.
export function waitForScrollBottom(element, onComplete, { isCurrent = () => true, timeoutMs = 1500 } = {}) {
    let finished = false;
    let timer;
    let elapsed = 0;
    const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        inputs.forEach(type => element?.removeEventListener(type, finish));
        onComplete();
    };
    const check = () => {
        elapsed += 100;
        if (!element?.isConnected || !isCurrent()
            || element.scrollHeight - element.scrollTop - element.clientHeight < 10
            || elapsed >= timeoutMs) {
            finish();
            return;
        }
        timer = setTimeout(check, 100);
    };
    inputs.forEach(type => element?.addEventListener(type, finish, { passive: true }));
    // Allow the first smooth-scroll frame to start before checking position.
    timer = setTimeout(check, 100);
    return finish;
}
