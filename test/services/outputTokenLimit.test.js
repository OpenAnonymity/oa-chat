import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOutputTokenLimit } from '../../chat/services/inference/outputTokenLimit.js';

test('generation defaults to exactly 30,000 tokens without changing the input', () => {
    const messages = [{ role: 'user', content: 'question' }];
    const body = { model: 'test/model', messages, reasoning: { effort: 'high' } };
    const result = applyOutputTokenLimit(body);
    assert.equal(result.max_tokens, 30000);
    assert.equal(result.messages, messages);
    assert.equal(result.reasoning, body.reasoning);
    assert.equal(body.max_tokens, undefined);
});

test('smaller title, model and composed budget limits take precedence', () => {
    assert.equal(applyOutputTokenLimit({ max_tokens: 24 }).max_tokens, 24);
    assert.equal(applyOutputTokenLimit({ max_tokens: 65536 }).max_tokens, 30000);
    assert.equal(applyOutputTokenLimit({}, { top_provider: { max_completion_tokens: 8192 } }).max_tokens, 8192);
    assert.equal(applyOutputTokenLimit({ max_tokens: 65536 }, null, 24).max_tokens, 24);
    assert.equal(applyOutputTokenLimit({ max_tokens: 512 }, null, 30000).max_tokens, 512);
});

test('alternate output parameter is preserved without adding a conflicting parameter', () => {
    assert.deepEqual(applyOutputTokenLimit({ max_completion_tokens: 65536 }), { max_completion_tokens: 30000 });
    assert.deepEqual(applyOutputTokenLimit({ max_completion_tokens: 256 }), { max_completion_tokens: 256 });
});
