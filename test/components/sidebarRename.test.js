import test from 'node:test';
import assert from 'node:assert/strict';
import Sidebar from '../../chat/components/Sidebar.js';

function makeInput(sessionId, value) {
    const classes = new Set(['cursor-pointer']);
    const row = { attrs: new Map(), setAttribute(k, v) { this.attrs.set(k, v); }, removeAttribute(k) { this.attrs.delete(k); } };
    return {
        isConnected: true, dataset: { sessionId }, value, readOnly: true,
        selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', focused: 0, selected: 0,
        classList: { add: (...n) => n.forEach(x => classes.add(x)), remove: (...n) => n.forEach(x => classes.delete(x)), contains: x => classes.has(x) },
        closest: () => row, row,
        focus(options) { this.focused++; this.focusOptions = options; }, select() { this.selected++; },
        setSelectionRange(start, end, direction) { Object.assign(this, { selectionStart: start, selectionEnd: end, selectionDirection: direction }); }
    };
}

function fixture() {
    const listeners = {};
    const inputs = { one: makeInput('one', 'Old name') };
    const list = {
        addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
        querySelector: selector => {
            if (selector.includes(':not([readonly])')) return Object.values(inputs).find(i => !i.readOnly) || null;
            const id = /data-session-id="([^"]+)"/.exec(selector)?.[1];
            return inputs[id] || null;
        },
        ownerDocument: { addEventListener() {}, defaultView: { addEventListener() {} } }
    };
    const switched = [];
    const sidebar = Object.assign(Object.create(Sidebar.prototype), {
        app: { elements: { sessionsList: list, sessionsScrollArea: null }, state: { currentSessionId: 'two', sessionsById: new Map() },
            switchSession: id => switched.push(id), isMobileView: () => false, updateSessionTitle: async () => {} },
        deletingSessionIds: new Set(), attachHoverCard() {}, hideHoverCard() {}, releaseInitialViewportSettlement() {}, closeAllMenus() {}
    });
    sidebar.ensureEventListeners();
    const fire = (type, target, extra = {}) => listeners[type].forEach(fn => fn({ target, preventDefault() { extra.prevented = true; }, stopPropagation() {}, ...extra }));
    return { sidebar, inputs, list, fire, switched };
}

test('double-clicking a title starts the inline rename', () => {
    const { inputs, fire } = fixture();
    const input = inputs.one;
    input.closest = selector => selector === '.session-title-input' ? input : input.row;
    fire('dblclick', input);
    assert.equal(input.readOnly, false);
    assert.equal(input.selected, 1);
    assert.equal(input.focused, 1);
    assert.equal(input.dataset.originalValue, 'Old name');
    assert.equal(input.row.attrs.has('data-renaming'), true);
    // A second double-click while editing leaves the edit alone.
    fire('dblclick', input);
    assert.equal(input.selected, 1);
});

test('double-tap in the phone layout does not start a rename', () => {
    const { sidebar, inputs, fire } = fixture();
    const input = inputs.one;
    input.closest = selector => selector === '.session-title-input' ? input : input.row;
    sidebar.app.isMobileView = () => true;
    fire('dblclick', input);
    assert.equal(input.readOnly, true);
});

test('double-click does not rename a chat that is being deleted', () => {
    const { sidebar, inputs, fire } = fixture();
    const input = inputs.one;
    input.closest = selector => selector === '.session-title-input' ? input : input.row;
    sidebar.deletingSessionIds.add('one');
    fire('dblclick', input);
    assert.equal(input.readOnly, true);
});

test('a list rebuild mid-rename carries the edit, value and caret to the new row', () => {
    const { sidebar, inputs } = fixture();
    const old = inputs.one;
    sidebar.startInlineEdit('one');
    old.value = 'Half typed';
    old.setSelectionRange(2, 5, 'forward');
    const edit = sidebar.captureInlineEdit();
    // The old input is read-only from here on, so a blur that Chrome fires
    // while it is still connected cannot commit "Half typed".
    assert.equal(old.readOnly, true);
    // Simulate innerHTML replacing the row.
    old.isConnected = false;
    const fresh = makeInput('one', 'Old name');
    inputs.one = fresh;
    sidebar.restoreInlineEdit(edit);
    assert.equal(fresh.readOnly, false);
    assert.equal(fresh.value, 'Half typed');
    assert.equal(fresh.dataset.originalValue, 'Old name');
    assert.deepEqual([fresh.selectionStart, fresh.selectionEnd, fresh.selectionDirection], [2, 5, 'forward']);
    assert.equal(fresh.focused, 1);
    assert.deepEqual(fresh.focusOptions, { preventScroll: true });
    assert.equal(fresh.classList.contains('cursor-text'), true);
    assert.equal(fresh.row.attrs.has('data-renaming'), true);
    // The restored row is now the one a later rebuild would capture.
    assert.deepEqual(sidebar.captureInlineEdit(), edit);
});

test('a rebuild through renderFullList keeps the edit even when blur fires while still connected', () => {
    const { sidebar, inputs, list, fire } = fixture();
    let finished = 0;
    sidebar.finishInlineEdit = async () => { finished++; };
    sidebar.syncFloatingMenu = () => {};
    sidebar.getFooterText = () => '';
    sidebar.groupSessionsByDate = () => ({});
    sidebar.app.getSessionListEmptyText = () => '';
    sidebar.escapeHtml = value => value;
    Object.defineProperty(list, 'innerHTML', { set() {
        // Chrome-style: blur dispatched before the node is detached.
        fire('blur', inputs.one);
        inputs.one.isConnected = false;
        inputs.one = makeInput('one', 'Old name');
    } });
    sidebar.startInlineEdit('one');
    inputs.one.value = 'Half typed';
    inputs.one.closest = selector => selector === '.session-title-input' ? inputs.one : inputs.one.row;
    sidebar.renderFullList([]);
    assert.equal(finished, 0);
    assert.equal(inputs.one.readOnly, false);
    assert.equal(inputs.one.value, 'Half typed');
});

test('the blur of a row that was replaced does not commit the rename', () => {
    const { sidebar, inputs, fire } = fixture();
    let finished = 0;
    sidebar.finishInlineEdit = async () => { finished++; };
    const input = inputs.one;
    input.closest = () => input;
    input.readOnly = false;
    input.isConnected = false;
    fire('blur', input);
    assert.equal(finished, 0);
    input.isConnected = true;
    fire('blur', input);
    assert.equal(finished, 1);
});

test('nothing is captured when no title is being edited', () => {
    const { sidebar } = fixture();
    assert.equal(sidebar.captureInlineEdit(), null);
    sidebar.restoreInlineEdit(null);
});
