import test from 'node:test';
import assert from 'node:assert/strict';
import Sidebar from '../../chat/components/Sidebar.js';

function classList(initial = []) {
    const values = new Set(initial);
    return {
        add(name) { values.add(name); },
        remove(name) { values.delete(name); },
        toggle(name, force) {
            if (force === true) values.add(name);
            else if (force === false) values.delete(name);
            else if (values.has(name)) values.delete(name);
            else values.add(name);
        },
        contains(name) { return values.has(name); }
    };
}

test('initial history position settles once while the bottom fade follows scroll state', () => {
    let scheduled = null;
    const shell = { classList: classList() };
    const list = {};
    const scrollArea = {
        scrollTop: 17,
        scrollHeight: 220,
        clientHeight: 100,
        closest: () => shell
    };
    const sidebar = {
        app: { elements: { sessionsList: list, sessionsScrollArea: scrollArea } },
        virtualState: { enabled: false },
        initialViewportSettled: false,
        initialViewportUserControlled: false,
        initialViewportFrame: null,
        requestAnimationFrame(callback) { scheduled = callback; return 1; },
        updateScrollFade: Sidebar.prototype.updateScrollFade
    };

    Sidebar.prototype.scheduleInitialViewportSettlement.call(sidebar, true);
    assert.equal(typeof scheduled, 'function');
    scheduled();

    assert.equal(scrollArea.scrollTop, 0);
    assert.equal(shell.classList.contains('has-more-below'), true);

    Sidebar.prototype.releaseInitialViewportSettlement.call(sidebar);

    scrollArea.scrollTop = 23;
    Sidebar.prototype.handleScroll.call({
        ...sidebar,
        virtualState: { enabled: false },
        updateScrollFade: Sidebar.prototype.updateScrollFade
    });
    assert.equal(shell.classList.contains('has-more-below'), true);

    scheduled = null;
    Sidebar.prototype.scheduleInitialViewportSettlement.call(sidebar, true);
    assert.equal(scheduled, null);
    assert.equal(scrollArea.scrollTop, 23);

    scrollArea.scrollTop = 120;
    Sidebar.prototype.handleScroll.call({
        ...sidebar,
        virtualState: { enabled: false },
        updateScrollFade: Sidebar.prototype.updateScrollFade
    });
    assert.equal(scrollArea.scrollTop, 120);
    assert.equal(shell.classList.contains('has-more-below'), false);
});
