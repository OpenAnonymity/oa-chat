import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePendingPhase } from '../../chat/domain/streamingState.js';

test('normalizePendingPhase preserves key-request phase and maps later phases to waiting response', () => {
    assert.equal(normalizePendingPhase('requesting-key'), 'requesting-key');
    assert.equal(normalizePendingPhase('waiting'), 'requesting-key');
    assert.equal(normalizePendingPhase('waiting-response'), 'waiting-response');
    assert.equal(normalizePendingPhase('stream-open'), 'waiting-response');
    assert.equal(normalizePendingPhase(null), 'waiting-response');
});
