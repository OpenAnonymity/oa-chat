import test from 'node:test';
import assert from 'node:assert/strict';
import Sidebar, { fitSessionRowHeight } from '../../chat/components/Sidebar.js';

const items = types => types.map(type => ({ type }));
const history = items(['header', 'session', 'session', 'spacer', 'header', ...Array(30).fill('session'), 'end-spacer']);

function rowEdges(list, rowHeight) {
    const edges = [];
    let y = 0;
    for (const item of list) {
        if (item.type === 'end-spacer') break;
        y += item.type === 'spacer' ? 12 : rowHeight;
        if (item.type !== 'spacer') edges.push(y);
    }
    return edges;
}

test('fitted rows end exactly on the list edge at any window height', () => {
    for (const available of [317, 355, 600, 612, 833, 1000]) {
        const height = fitSessionRowHeight(history, available);
        assert.ok(Math.abs(height - 36) <= 3.6, `height ${height} stays within 10% at ${available}`);
        assert.ok(rowEdges(history, height).some(edge => Math.abs(edge - available) < 0.01), `a row edge meets ${available}`);
    }
});

test('rows keep their base height when nothing would be cut', () => {
    assert.equal(fitSessionRowHeight(history, 300), 36); // edge already on a row
    assert.equal(fitSessionRowHeight(history, 80), 36); // edge inside the group gap
    assert.equal(fitSessionRowHeight(items(['header', 'session', 'end-spacer']), 500), 36); // all fits
    assert.equal(fitSessionRowHeight(history, 0), 36);
    assert.equal(fitSessionRowHeight([], 400), 36);
});

test('fitting gives up rather than distorting rows by more than 10%', () => {
    // A single row in a 50px area would need 50px rows.
    assert.equal(fitSessionRowHeight(items(['header', 'session', 'session']), 50), 36);
});

test('starred chats stay in their date group', () => {
    const day = 24 * 60 * 60 * 1000;
    const sessions = [
        { id: 'a', updatedAt: Date.now() },
        { id: 'b', updatedAt: Date.now() - 3 * day, starred: true },
        { id: 'c', updatedAt: Date.now() - 60000, starred: true }
    ];
    const sidebar = Object.create(Sidebar.prototype);
    sidebar.app = { hasActiveSessionListCriteria: () => false, state: { hasMoreSessions: false } };
    const list = sidebar.buildListItems(sessions);
    assert.deepEqual(list.map(item => item.type === 'session' ? item.session.id : item.label || item.type),
        ['Today', 'a', 'c', 'spacer', 'Previous 7 Days', 'b', 'end-spacer']);
});

test('rows fit once on first history and then stay put through resizes', () => {
    const props = new Map();
    const list = { style: { setProperty: (k, v) => props.set(k, v) } };
    const scrollArea = { clientHeight: 0 };
    let disconnected = false;
    const sidebar = Object.create(Sidebar.prototype);
    Object.assign(sidebar, {
        app: { elements: { sessionsList: list, sessionsScrollArea: scrollArea } },
        virtualState: { enabled: false },
        rowHeight: 36,
        rowFitDone: false,
        rowFitObserver: { disconnect: () => { disconnected = true; } },
        listItems: history,
        updateScrollFade() {}
    });

    sidebar.applyRowFit(); // collapsed sidebar: nothing to measure yet
    assert.equal(sidebar.rowFitDone, false);

    scrollArea.clientHeight = 612;
    sidebar.applyRowFit();
    const fitted = sidebar.rowHeight;
    assert.notEqual(fitted, 36);
    assert.equal(props.get('--session-row-h'), `${fitted}px`);
    assert.equal(disconnected, true);

    scrollArea.clientHeight = 450; // user shrinks the window
    sidebar.applyRowFit();
    assert.equal(sidebar.rowHeight, fitted);
});
