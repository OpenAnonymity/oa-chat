import test from 'node:test';
import assert from 'node:assert/strict';
import { leaveChatArrival, cancelChatArrival, getChatArrivalDestination } from '../../chat/ui/chatArrival.js';
import { positionAppToast } from '../../chat/ui/toastPosition.js';

function fixture({ reduced = false, empty = true } = {}) {
    const animations = [];
    const listeners = new Map();
    const view = { matchMedia: () => ({ matches: reduced }),
        addEventListener: (name, fn) => listeners.set(name, fn),
        removeEventListener: name => listeners.delete(name) };
    const animate = (frames, options) => {
        let finish;
        const animation = { frames, options, cancelled: false,
            finished: new Promise(resolve => { finish = resolve; }),
            cancel() { this.cancelled = true; }, finish: () => finish() };
        animations.push(animation);
        return animation;
    };
    const welcome = { attached: empty, style: {}, classList: { add() {} },
        setAttribute() {}, remove() { this.attached = false; this.overlay = false; },
        getBoundingClientRect: () => ({ top: 200, left: 100, width: 600, height: 60 }), animate };
    const main = { getBoundingClientRect: () => ({ top: 20, left: 50 }),
        appendChild(node) { node.overlay = true; } };
    const composer = { draft: 'Keep this draft', animate,
        getBoundingClientRect: () => ({ top: welcome.attached ? 300 : 600, left: 100 }) };
    const stage = { querySelector: selector => selector === '#input-card' ? composer : null, closest: () => main };
    const container = { ownerDocument: { defaultView: view }, animate,
        querySelector: () => welcome.attached ? welcome : null, closest: () => stage };
    return { container, composer, welcome, animations, listeners };
}

test('first message moves the same composer and removes the brand after motion', async () => {
    const f = fixture(); leaveChatArrival(f.container);
    assert.equal(f.composer.draft, 'Keep this draft');
    assert.equal(f.animations[0].frames[0].transform, 'translate(0px, -300px)');
    assert.equal(f.welcome.inert, true);
    assert.equal(f.welcome.overlay, true);
    assert.equal(getChatArrivalDestination(f.container).top, 600);
    f.animations.forEach(animation => animation.finish());
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.welcome.overlay, false);
    assert.equal(f.listeners.size, 0);
    assert.equal(getChatArrivalDestination(f.container), undefined);
});

test('reduced motion and non-user arrivals dock without animation', () => {
    for (const options of [{ reduced: true }, {}]) {
        const f = fixture(options);
        leaveChatArrival(f.container, { animate: Boolean(options.reduced) });
        assert.equal(f.animations.length, 0);
        assert.equal(f.welcome.attached, false);
    }
});

test('existing conversations do not replay arrival motion', () => {
    const f = fixture({ empty: false }); leaveChatArrival(f.container);
    assert.equal(f.animations.length, 0);
});

test('a new toast during first-send motion uses the final docked position', () => {
    const f = fixture();
    leaveChatArrival(f.container);
    f.composer.getBoundingClientRect = () => ({ top: 350 }); // Moving animation frame.
    const toast = { dataset: {}, style: {}, offsetHeight: 40 };
    positionAppToast(toast, {
        document: { getElementById: id => id === 'input-card' ? f.composer : f.container },
        window: { innerHeight: 900 }
    });
    assert.equal(toast.style.top, '544px'); // Destination 600 minus gap and toast.
    cancelChatArrival(f.container);
});

test('new chat and resizing cancel old animation and clear the outgoing brand', () => {
    for (const resize of [false, true]) {
        const f = fixture(); leaveChatArrival(f.container);
        if (resize) f.listeners.get('resize')(); else cancelChatArrival(f.container);
        assert.ok(f.animations.every(animation => animation.cancelled));
        assert.equal(f.welcome.overlay, false);
        assert.equal(f.listeners.size, 0);
        cancelChatArrival(f.container);
    }
});
