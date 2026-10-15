import test from 'node:test';
import assert from 'node:assert/strict';
import { placeSessionMenu } from '../../chat/components/Sidebar.js';

const viewport = { width: 1280, height: 800 };
const size = { width: 175, height: 290 };
const button = top => ({ top, bottom: top + 36, left: 180, right: 216 });

test('a row menu opens below its button when it fits', () => {
    const place = placeSessionMenu(button(100), size, viewport);
    assert.equal(place.side, 'bottom');
    assert.equal(place.top, 140);
    assert.equal(place.left, 216 - 175);
    assert.equal(place.maxHeight, null);
});

test('a row menu near the bottom flips above its button', () => {
    const place = placeSessionMenu(button(640), size, viewport);
    assert.equal(place.side, 'top');
    assert.equal(place.top, 640 - 4 - 290);
    assert.equal(place.maxHeight, null);
});

test('it stays below while it still fits, even close to the edge', () => {
    // 800 - 8 margin - 4 gap - 290 = 498 is the lowest button bottom that fits.
    assert.equal(placeSessionMenu({ top: 462, bottom: 498, right: 216 }, size, viewport).side, 'bottom');
    assert.equal(placeSessionMenu({ top: 463, bottom: 499, right: 216 }, size, viewport).side, 'top');
});

test('a window too short for either side uses the roomier side and scrolls', () => {
    const short = { width: 1280, height: 320 };
    const place = placeSessionMenu(button(200), size, short);
    assert.equal(place.side, 'top');
    assert.equal(place.maxHeight, 200 - 4 - 8);
    assert.equal(place.top, 8);
});

test('the menu never runs off the left or right edge', () => {
    assert.equal(placeSessionMenu({ top: 100, bottom: 136, right: 60 }, size, viewport).left, 8);
    assert.equal(placeSessionMenu({ top: 100, bottom: 136, right: 1400 }, size, viewport).left, 1280 - 8 - 175);
});

test('keyboard menu opening focuses the first action; pointer opening preserves focus', async () => {
    const { default: Sidebar } = await import('../../chat/components/Sidebar.js');
    const opened = [];
    let focuses = 0;
    const doc = { body: { appendChild(menu) { menu.isConnected = true; opened.push(menu); } }, querySelectorAll: () => [], defaultView: {} };
    const template = { cloneNode() {
        const names = new Set(['hidden']);
        return { ownerDocument: doc, classList: { add: x => names.add(x), remove: x => names.delete(x), contains: x => names.has(x) },
            addEventListener() {}, removeAttribute() {}, querySelector: () => ({ focus() { focuses++; } }) };
    } };
    const row = { querySelector: () => template, toggleAttribute() {} };
    const button = { ownerDocument: doc, dataset: { sessionId: 'synthetic' }, closest: () => row, setAttribute() {} };
    const sidebar = Object.create(Sidebar.prototype);
    sidebar.positionFloatingMenu = () => {};
    sidebar.openSessionMenu(button, { focusMenu: true });
    assert.equal(focuses, 1);
    assert.equal(opened[0].classList.contains('session-menu--floating'), true);
    sidebar.openSessionMenu(button, { focusMenu: false });
    assert.equal(focuses, 1);
});

test('hiding the sidebar closes its detached menu before the sidebar becomes inert', async () => {
    const { readFile } = await import('node:fs/promises');
    const { runInNewContext } = await import('node:vm');
    const source = await readFile(new URL('../../chat/app.js', import.meta.url), 'utf8');
    const method = source.slice(source.indexOf('    hideSidebar(options = {}) {'), source.indexOf('    showSidebar(options = {}) {'));
    const order = [];
    const app = { sidebar: { closeAllMenus: () => order.push('close') }, elements: { sidebar: {
        classList: { add() {}, remove() {}, contains: () => false }, set inert(value) { if (value) order.push('inert'); }
    } }, isMobileView: () => true, setSidebarClosingAttribute() {}, setSidebarHiddenAttribute() {}, updateWideModeButtonVisibility() {}, updateToolbarDivider() {} };
    const hide = runInNewContext(`({${method}}).hideSidebar`, { clearTimeout() {}, setTimeout() {}, SIDEBAR_CLOSE_DURATION_MS: 0 });
    hide.call(app, { persist: false, predictToolbar: false });
    assert.deepEqual(order, ['close', 'inert']);
});
