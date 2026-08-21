import test from 'node:test';
import assert from 'node:assert/strict';

import networkLogger from '../../chat/services/networkLogger.js';

test('redacts inference tickets even when a request may roll back', () => {
    const headers = networkLogger.sanitizeHeaders({
        Authorization: 'InferenceTicket token=still-usable-after-rollback'
    });

    assert.equal(headers.Authorization, 'InferenceTicket [REDACTED]');
});

test('redacts bearer tokens without retaining prefixes or suffixes', () => {
    const headers = networkLogger.sanitizeHeaders({
        authorization: 'Bearer child-secret-value'
    });

    assert.equal(headers.authorization, 'Bearer [REDACTED]');
});

test('log entries redact nested child keys without mutating the response', () => {
    const response = {
        key: 'child-secret-value',
        key_hash: 'safe-hash',
        nested: { api_key: 'nested-secret' }
    };

    const entry = networkLogger.logRequest({
        type: 'api-key',
        method: 'POST',
        status: 200,
        response
    });

    assert.equal(entry.response.key, '[REDACTED]');
    assert.equal(entry.response.key_hash, 'safe-hash');
    assert.equal(entry.response.nested.api_key, '[REDACTED]');
    assert.equal(response.key, 'child-secret-value');
});

test('log sink retains only inference metadata and redacts prompt and response content', () => {
    const request = {
        headers: { Authorization: 'Bearer ek-oa-v1-secret' },
        body: {
            model: 'openai/test-model',
            messages: [
                { role: 'system', content: 'private system text' },
                { role: 'user', content: 'private user prompt' }
            ]
        }
    };
    const response = {
        id: 'request-123',
        model: 'openai/test-model',
        usage: { prompt_tokens: 12, completion_tokens: 8 },
        choices: [{
            message: {
                role: 'assistant',
                content: 'private answer',
                reasoning: 'private chain of thought',
                reasoning_details: [{ text: 'private reasoning detail' }],
                annotations: [{ url: 'https://private.example/path' }],
                images: [{ image_url: { url: 'data:image/png;base64,private-image' } }]
            }
        }]
    };

    const entry = networkLogger.logRequest({
        type: 'openrouter',
        method: 'POST',
        status: 200,
        request,
        response
    });

    assert.equal(entry.request.headers.Authorization, 'Bearer [REDACTED]');
    assert.equal(entry.request.body.model, 'openai/test-model');
    assert.equal(entry.request.body.messages.length, 2);
    assert.equal(entry.request.body.messages[1].content, '[REDACTED]');
    assert.deepEqual(entry.response, {
        id: 'request-123',
        model: 'openai/test-model',
        usage: { prompt_tokens: 12, completion_tokens: 8 }
    });
    assert.doesNotMatch(
        JSON.stringify(entry),
        /private system text|private user prompt|private answer|private chain of thought|private reasoning detail|private\.example|private-image/
    );
    assert.equal(request.body.messages[1].content, 'private user prompt');
    assert.equal(response.choices[0].message.content, 'private answer');
});

test('log sink redacts ticket issuance material even when callers forget', () => {
    const entry = networkLogger.logRequest({
        type: 'ticket',
        method: 'POST',
        status: 200,
        request: {
            body: {
                credential: 'invite-secret',
                blinded_requests: [[0, 'blind-secret']]
            }
        },
        response: {
            signed_responses: [[0, 'signature-secret']],
            detail: {
                failed_ticket: {
                    preview: 'TICKETSECRET-prefix'
                }
            }
        },
        error: new Error('private prompt Bearer ek-oa-v1-secret failed')
    });

    const serialized = JSON.stringify(entry);
    assert.doesNotMatch(serialized, /invite-secret|blind-secret|signature-secret|ek-oa-v1-secret/);
    assert.equal(entry.request.body.credential, '[REDACTED]');
    assert.deepEqual(entry.response.signed_responses, ['[REDACTED]']);
    assert.equal(entry.response.signed_responses.length, 1);
    assert.equal(entry.response.detail.failed_ticket.preview, '[REDACTED]');
    assert.equal(entry.error, 'Request failed');
    assert.doesNotMatch(serialized, /private prompt/);
});

test('log sink parses JSON strings before redaction and drops opaque bodies', () => {
    const jsonEntry = networkLogger.logRequest({
        type: 'openrouter',
        request: {
            body: JSON.stringify({
                model: 'openai/test',
                messages: [{ role: 'user', content: 'string-body prompt' }]
            })
        },
        response: JSON.stringify({
            choices: [{ message: { content: 'string-body answer' } }]
        })
    });
    const opaqueEntry = networkLogger.logRequest({
        type: 'unknown',
        request: { body: 'opaque-private-body' },
        response: 'opaque-private-response'
    });

    assert.equal(jsonEntry.request.body.model, 'openai/test');
    assert.equal(jsonEntry.request.body.messages[0].content, '[REDACTED]');
    assert.deepEqual(jsonEntry.response, {});
    assert.doesNotMatch(JSON.stringify(jsonEntry), /string-body prompt|string-body answer/);
    assert.equal(opaqueEntry.request.body, '[REDACTED]');
    assert.equal(opaqueEntry.response, '[REDACTED]');
});
