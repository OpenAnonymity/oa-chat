import test from 'node:test';
import assert from 'node:assert/strict';
import { setScrollButtonVisible, waitForScrollBottom } from '../../chat/ui/scrollToBottom.js';

function button() {
    const classes = new Set(['hidden']);
    return { offsetWidth: 40, classList: {
        contains: value => classes.has(value), add: value => classes.add(value), remove: value => classes.delete(value)
    } };
}

test('show reverses an unfinished hide without a stale timer hiding the button', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const el = button();
    setScrollButtonVisible(el, true);
    setScrollButtonVisible(el, false);
    t.mock.timers.tick(100);
    setScrollButtonVisible(el, true);
    t.mock.timers.tick(1000);
    assert.equal(el.classList.contains('hidden'), false);
    assert.equal(el.classList.contains('visible'), true);
});

test('repeated hide checks do not postpone completion or queue more timers', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const el = button();
    setScrollButtonVisible(el, true);
    setScrollButtonVisible(el, false);
    for (let i = 0; i < 10; i++) { t.mock.timers.tick(20); setScrollButtonVisible(el, false); }
    assert.equal(el.classList.contains('hidden'), true);
    setScrollButtonVisible(el, true);
    t.mock.timers.tick(1000);
    assert.equal(el.classList.contains('hidden'), false);
});

function scroller() {
    const el = new EventTarget();
    return Object.assign(el, { isConnected: true, scrollTop: 0, scrollHeight: 2000, clientHeight: 600 });
}

for (const action of ['bottom', 'wheel', 'touchstart', 'pointerdown', 'keydown', 'detached', 'session', 'timeout', 'cancel']) {
    test(`scroll wait releases after ${action} and completes only once`, t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const el = scroller();
        let current = true, completed = 0;
        const cancel = waitForScrollBottom(el, () => completed++, { isCurrent: () => current });
        t.mock.timers.tick(100);
        assert.equal(completed, 0);
        if (action === 'bottom') el.scrollTop = 1400;
        else if (action === 'detached') el.isConnected = false;
        else if (action === 'session') current = false;
        else if (action === 'cancel') cancel();
        else if (action !== 'timeout') el.dispatchEvent(new Event(action));
        // Tick separately to model successive timer turns.
        for (let i = 0; i < (action === 'timeout' ? 14 : 1); i++) t.mock.timers.tick(100);
        assert.equal(completed, 1);
        cancel(); el.dispatchEvent(new Event('wheel')); t.mock.timers.tick(5000);
        assert.equal(completed, 1);
    });
}
