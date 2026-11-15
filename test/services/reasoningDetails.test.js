import test from 'node:test';
import assert from 'node:assert/strict';
import { hasWithheldReasoning, reasoningTextFromDetails } from '../../chat/services/reasoningParser.js';

test('reasoningTextFromDetails reads the words out of structured reasoning_details, in order', () => {
    assert.equal(reasoningTextFromDetails([
        { type: 'reasoning.text', text: 'The post links ', format: 'xai-responses-v1', index: 0 },
        { type: 'reasoning.encrypted', data: 'opaque' },
        { type: 'reasoning.summary', summary: 'two videos.' },
        { type: 'reasoning.text', text: null },
        { text: 'untyped tail' },
        null,
        'junk'
    ]), 'The post links two videos.untyped tail');
    assert.equal(reasoningTextFromDetails([{ type: 'reasoning.encrypted', data: 'opaque' }]), '');
    assert.equal(reasoningTextFromDetails(undefined), '');
    assert.equal(reasoningTextFromDetails('not a list'), '');
});

test('hasWithheldReasoning is true only for wordless reasoning entries', () => {
    assert.equal(hasWithheldReasoning([{ type: 'reasoning.encrypted', data: 'opaque' }]), true);
    assert.equal(hasWithheldReasoning([{ type: 'reasoning.text', text: 'shown' }]), false);
    assert.equal(hasWithheldReasoning([{ type: 'reasoning.summary', summary: 'shown' }]), false);
    assert.equal(hasWithheldReasoning([{ type: 'image', data: 'iVBORw0KGgo' }]), false);
    assert.equal(hasWithheldReasoning([]), false);
    assert.equal(hasWithheldReasoning(null), false);
});
