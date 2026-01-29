import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeResponsesRequest,
    messagesToResponsesInput,
    buildChatMessagesFromRequest,
    buildResponseSkeleton,
    finalizeResponse,
    normalizeEmbeddingRequest
} from '../responseUtils.js';

test('normalizeResponsesRequest: string input becomes message item', () => {
    const request = normalizeResponsesRequest({ model: 'test-model', input: 'Hello' });

    assert.equal(request.input.length, 1);
    assert.equal(request.input[0].type, 'message');
    assert.equal(request.input[0].role, 'user');
    assert.equal(request.input[0].content[0].type, 'input_text');
    assert.equal(request.input[0].content[0].text, 'Hello');
});

test('messagesToResponsesInput: maps multimodal content', () => {
    const input = messagesToResponsesInput([
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Hi' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
            ]
        }
    ]);

    assert.equal(input.length, 1);
    assert.equal(input[0].content.length, 2);
    assert.equal(input[0].content[0].type, 'input_text');
    assert.equal(input[0].content[1].type, 'input_image');
});

test('buildChatMessagesFromRequest: combines system prompt and instructions', () => {
    const request = normalizeResponsesRequest({
        model: 'test-model',
        instructions: 'Follow the instructions.',
        input: [{
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Ping' }]
        }]
    });

    const messages = buildChatMessagesFromRequest(request, { systemPrompt: 'System base' });

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.ok(messages[0].content.includes('System base'));
    assert.ok(messages[0].content.includes('Follow the instructions.'));
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].content, 'Ping');
});

test('finalizeResponse: sets completed status and output', () => {
    const request = normalizeResponsesRequest({ model: 'test-model', input: 'Hi' });
    const response = buildResponseSkeleton(request);
    const finalized = finalizeResponse(response, 'Hello');

    assert.equal(finalized.status, 'completed');
    assert.equal(finalized.output[0].type, 'message');
    assert.equal(finalized.output[0].content[0].text, 'Hello');
});

test('normalizeEmbeddingRequest: accepts text alias', () => {
    const request = normalizeEmbeddingRequest({ model: 'embed-model', text: 'Embed me' });
    assert.equal(request.model, 'embed-model');
    assert.equal(request.input, 'Embed me');
});
