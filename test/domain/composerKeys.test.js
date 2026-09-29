import test from 'node:test';
import assert from 'node:assert/strict';
import { enterKeyAction } from '../../chat/domain/composerKeys.js';

test('Enter sends when nothing is streaming or pending', () => {
    assert.equal(enterKeyAction({ streaming: false, draft: 'hello', sendDisabled: false }), 'send');
    assert.equal(enterKeyAction({ streaming: false, draft: 'hello', sendDisabled: false, pendingText: null }), 'send');
});

test('Enter on an empty composer while streaming does nothing (no accidental cancel)', () => {
    assert.equal(enterKeyAction({ streaming: true, draft: '', sendDisabled: false }), 'ignore');
    assert.equal(enterKeyAction({ streaming: true, draft: '   \n', sendDisabled: false }), 'ignore');
    assert.equal(enterKeyAction({ streaming: true, draft: undefined, sendDisabled: false }), 'ignore');
});

test('a second Enter while the just-sent text is still in the composer is ignored', () => {
    assert.equal(enterKeyAction({ streaming: true, draft: 'hello there', sendDisabled: false, pendingText: 'hello there' }), 'ignore');
    assert.equal(enterKeyAction({ streaming: true, draft: 'hello there ', sendDisabled: false, pendingText: 'hello there' }), 'ignore');
    // Not yet marked streaming, but a submission is in flight: still ignored.
    assert.equal(enterKeyAction({ streaming: false, draft: 'hello there', sendDisabled: false, pendingText: 'hello there' }), 'ignore');
});

test('Enter with genuinely new text while streaming still stops the response', () => {
    assert.equal(enterKeyAction({ streaming: true, draft: 'follow-up', sendDisabled: false, pendingText: 'hello there' }), 'stop');
    assert.equal(enterKeyAction({ streaming: true, draft: 'follow-up', sendDisabled: false }), 'stop');
});

test('a disabled send control ignores Enter in every state', () => {
    assert.equal(enterKeyAction({ streaming: false, draft: 'x', sendDisabled: true }), 'ignore');
    assert.equal(enterKeyAction({ streaming: true, draft: 'x', sendDisabled: true }), 'ignore');
});
