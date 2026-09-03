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

test('history hides a clipped bottom row whenever scrolling returns to the top boundary', () => {
    let scheduled = null;
    const shell = { classList: classList() };
    const completeRow = { classList: classList(), getBoundingClientRect: () => ({ top: 10, bottom: 46 }) };
    const clippedRow = { classList: classList(), getBoundingClientRect: () => ({ top: 82, bottom: 118 }) };
    const rows = [completeRow, clippedRow];
    const list = {
        querySelectorAll(selector) {
            if (selector === '.chat-session') return rows;
            if (selector === '.session-initially-clipped') {
                return rows.filter(row => row.classList.contains('session-initially-clipped'));
            }
            return [];
        }
    };
    const scrollArea = {
        scrollTop: 17,
        scrollHeight: 220,
        clientHeight: 100,
        getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
        closest: () => shell
    };
    const sidebar = {
        app: { elements: { sessionsList: list, sessionsScrollArea: scrollArea } },
        virtualState: { enabled: false },
        initialViewportSettled: false,
        initialViewportUserControlled: false,
        initialViewportFrame: null,
        requestAnimationFrame(callback) { scheduled = callback; return 1; },
        applyInitialViewportGuard: Sidebar.prototype.applyInitialViewportGuard,
        updateScrollFade: Sidebar.prototype.updateScrollFade
    };

    Sidebar.prototype.scheduleInitialViewportSettlement.call(sidebar, true);
    assert.equal(typeof scheduled, 'function');
    scheduled();

    assert.equal(scrollArea.scrollTop, 0);
    assert.equal(completeRow.classList.contains('session-initially-clipped'), false);
    assert.equal(clippedRow.classList.contains('session-initially-clipped'), true);
    assert.equal(shell.classList.contains('has-more-below'), true);

    Sidebar.prototype.releaseInitialViewportGuard.call(sidebar);
    assert.equal(clippedRow.classList.contains('session-initially-clipped'), true);

    scrollArea.scrollTop = 23;
    Sidebar.prototype.handleScroll.call({
        ...sidebar,
        virtualState: { enabled: false },
        updateScrollFade: Sidebar.prototype.updateScrollFade
    });
    assert.equal(clippedRow.classList.contains('session-initially-clipped'), false);

    scheduled = null;
    Sidebar.prototype.scheduleInitialViewportSettlement.call(sidebar, true);
    assert.equal(scheduled, null);
    assert.equal(scrollArea.scrollTop, 23);

    scrollArea.scrollTop = 0;
    Sidebar.prototype.handleScroll.call({
        ...sidebar,
        virtualState: { enabled: false },
        updateScrollFade: Sidebar.prototype.updateScrollFade
    });
    assert.equal(clippedRow.classList.contains('session-initially-clipped'), true);

    scrollArea.scrollTop = 120;
    Sidebar.prototype.handleScroll.call({
        ...sidebar,
        virtualState: { enabled: false },
        updateScrollFade: Sidebar.prototype.updateScrollFade
    });
    assert.equal(scrollArea.scrollTop, 120);
    assert.equal(clippedRow.classList.contains('session-initially-clipped'), false);
    assert.equal(shell.classList.contains('has-more-below'), false);
});
