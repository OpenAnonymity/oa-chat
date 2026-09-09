const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function classList(initial = []) {
    const values = new Set(initial);
    return {
        add(...names) { names.forEach(name => values.add(name)); },
        remove(...names) { names.forEach(name => values.delete(name)); },
        toggle(name, enabled) {
            if (enabled === undefined) {
                if (values.has(name)) values.delete(name);
                else values.add(name);
                return values.has(name);
            }
            if (enabled) values.add(name);
            else values.delete(name);
            return enabled;
        },
        contains(name) { return values.has(name); }
    };
}

function button(sessionId = '') {
    const attributes = new Map();
    return {
        dataset: { sessionId },
        classList: classList(),
        disabled: false,
        isConnected: true,
        setAttribute(name, value) { attributes.set(name, String(value)); },
        removeAttribute(name) { attributes.delete(name); },
        getAttribute(name) { return attributes.get(name) ?? null; }
    };
}

test('Continue and both edit-save entry points acknowledge the action synchronously', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../chat/components/ChatArea.js'), 'utf8');
    const continueStart = source.indexOf("const continueBtn = e.target.closest('.continue-message-btn')");
    const continueEnd = source.indexOf("const memoryApprovalBtn", continueStart);
    const continueHandler = source.slice(continueStart, continueEnd);
    const saveStart = source.indexOf("const confirmEditBtn = e.target.closest('.confirm-edit-btn')");
    const saveEnd = source.indexOf("const forkBtn", saveStart);
    const saveHandler = source.slice(saveStart, saveEnd);
    const keyboardStart = source.indexOf("if ((e.metaKey || e.ctrlKey) && e.key === 'Enter'");
    const keyboardEnd = source.indexOf("} else if (e.key === 'Escape')", keyboardStart);
    const keyboardHandler = source.slice(keyboardStart, keyboardEnd);

    for (const handler of [continueHandler, saveHandler, keyboardHandler]) {
        const busyStart = handler.indexOf('setMessageActionBusy');
        const awaitedAction = handler.indexOf('await this.app.');
        const busyEnd = handler.lastIndexOf('setMessageActionBusy');
        assert.ok(busyStart >= 0 && awaitedAction > busyStart && busyEnd > awaitedAction);
    }
    assert.match(source, /button\.disabled = busy/);
    assert.match(source, /button\.setAttribute\('aria-busy', 'true'\)/);
    assert.match(source, /button\.removeAttribute\('aria-busy'\)/);
});

test('single-chat deletion keeps a compact busy row until deletion resolves', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../../chat/components/Sidebar.js'), 'utf8');
    const isolatedSource = source
        .replace(/^import .*;\n/gm, '')
        .replace('export default class Sidebar', 'class Sidebar')
        .concat('\nSidebar;');
    const Sidebar = vm.runInNewContext(isolatedSource, { console });

    const progress = { classList: classList(['hidden']) };
    const starButton = button('session-a');
    const menuButton = button('session-a');
    const deleteButton = button('session-a');
    const rowAttributes = new Map();
    const row = {
        dataset: { sessionId: 'session-a', deleting: 'false' },
        setAttribute(name, value) { rowAttributes.set(name, String(value)); },
        getAttribute(name) { return rowAttributes.get(name) ?? null; },
        querySelector(selector) {
            if (selector === '.session-delete-progress') return progress;
            if (selector === '.delete-session-action') return deleteButton;
            return null;
        },
        querySelectorAll(selector) {
            if (selector === '.session-star-btn, .session-menu-btn') return [starButton, menuButton];
            return [];
        }
    };
    const listeners = new Map();
    const list = {
        addEventListener(name, listener) { listeners.set(name, listener); },
        querySelectorAll(selector) {
            if (selector === '.chat-session') return [row];
            if (selector === '.session-menu') return [];
            return [];
        }
    };
    let finishDelete;
    const deletion = new Promise(resolve => { finishDelete = resolve; });
    const sidebar = Object.create(Sidebar.prototype);
    sidebar.app = {
        elements: { sessionsList: list },
        deleteSession: () => deletion
    };
    sidebar.listenersAttached = false;
    sidebar.deletingSessionIds = new Set();
    sidebar.ensureEventListeners();

    const event = {
        stopPropagation() {},
        target: {
            closest(selector) {
                return selector === '.delete-session-action' ? deleteButton : null;
            }
        }
    };
    const action = listeners.get('click')(event);

    assert.equal(sidebar.deletingSessionIds.has('session-a'), true);
    assert.equal(row.dataset.deleting, 'true');
    assert.equal(row.getAttribute('aria-busy'), 'true');
    assert.equal(progress.classList.contains('hidden'), false);
    assert.equal(deleteButton.disabled, true);
    assert.equal(deleteButton.getAttribute('aria-busy'), 'true');
    assert.equal(starButton.disabled, true);
    assert.equal(menuButton.disabled, true);

    finishDelete();
    await action;

    assert.equal(sidebar.deletingSessionIds.has('session-a'), false);
    assert.equal(row.dataset.deleting, 'false');
    assert.equal(row.getAttribute('aria-busy'), 'false');
    assert.equal(progress.classList.contains('hidden'), true);
    assert.equal(deleteButton.disabled, false);
    assert.equal(deleteButton.getAttribute('aria-busy'), 'false');
    assert.equal(starButton.disabled, false);
    assert.equal(menuButton.disabled, false);
});
