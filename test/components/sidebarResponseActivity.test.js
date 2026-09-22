import test from 'node:test';
import assert from 'node:assert/strict';
import Sidebar from '../../chat/components/Sidebar.js';
import { createSidebarInterface } from '../../chat/ui/appInterface.js';

function fixture() {
    const session = { id: 'one', title: 'A finished title', titleSource: 'generated' };
    const streaming = new Set(['one']);
    const attrs = new Map();
    const classes = new Set();
    const input = { dataset: { sessionId: 'one' }, value: 'My unfinished rename', readOnly: false,
        classList: { toggle: (name, value) => value ? classes.add(name) : classes.delete(name) },
        setAttribute: (name, value) => attrs.set(name, value), removeAttribute: name => attrs.delete(name) };
    const app = { state: { currentSessionId: null, sessionsById: new Map([['one', session]]) },
        elements: { sessionsList: { querySelectorAll: () => [input] } },
        isSessionStreaming: id => streaming.has(id) };
    const sidebar = Object.assign(Object.create(Sidebar.prototype), {
        app: createSidebarInterface(app), deletingSessionIds: new Set()
    });
    return { sidebar, app, session, streaming, input, attrs, classes };
}

test('background response keeps the existing glimmer after title generation finishes', () => {
    const f = fixture();
    assert.deepEqual(f.sidebar.getSessionTitleActivity(f.session), { generating: true, responding: true });
    f.app.state.currentSessionId = 'one';
    assert.deepEqual(f.sidebar.getSessionTitleActivity(f.session), { generating: false, responding: false });
    Object.assign(f.session, { titleSource: 'local', titleGenerationPending: true });
    assert.deepEqual(f.sidebar.getSessionTitleActivity(f.session), { generating: true, responding: false });
    f.app.state.currentSessionId = 'two';
    f.session.titleGenerationPending = false;
    assert.equal(f.sidebar.getSessionTitleActivity(f.session).generating, true);
    f.streaming.clear();
    assert.equal(f.sidebar.getSessionTitleActivity(f.session).generating, false);
});

test('stream completion patches the title without interrupting rename or other rows', () => {
    const f = fixture();
    f.sidebar.updateSessionActivity('one');
    assert.equal(f.classes.has('session-title-generating'), true);
    assert.equal(f.attrs.get('aria-description'), 'Response in progress');
    f.streaming.clear();
    f.sidebar.updateSessionActivity('different-chat');
    assert.equal(f.classes.has('session-title-generating'), true);
    f.sidebar.updateSessionActivity('one');
    assert.equal(f.classes.has('session-title-generating'), false);
    assert.equal(f.attrs.has('aria-description'), false);
    assert.equal(f.input.value, 'My unfinished rename');
    assert.equal(f.input.readOnly, false);
});

test('newly rendered rows read live state after being filtered or virtualized away', () => {
    const f = fixture();
    f.sidebar.escapeHtml = f.sidebar.escapeHtmlAttribute;
    assert.match(f.sidebar.buildSessionHTML(f.session), /session-title-generating/);
    assert.match(f.sidebar.buildSessionHTML(f.session), /aria-description="Response in progress"/);
    f.streaming.clear();
    assert.doesNotMatch(f.sidebar.buildSessionHTML(f.session), /session-title-generating|Response in progress/);
    f.streaming.add('one');
    f.sidebar.deletingSessionIds.add('one');
    assert.equal(f.sidebar.getSessionTitleActivity(f.session).responding, false);
});
