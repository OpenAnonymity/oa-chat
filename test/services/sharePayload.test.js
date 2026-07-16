import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseSharePayload } from '../../chat/services/sharePayload.js';

test('buildBaseSharePayload preserves safe memory retrieval failure metadata', () => {
    const payload = buildBaseSharePayload({
        title: 'Memory test',
        model: 'memory agent',
        createdAt: '2026-07-02T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:01.000Z'
    }, [{
        role: 'assistant',
        content: 'Memory context was not added this time. Sending without it.',
        timestamp: '2026-07-02T00:00:01.000Z',
        model: 'memory agent',
        isLocalOnly: true,
        memoryRetrievalFailure: {
            kind: 'timeout',
            title: 'Timeout https://example.invalid?api_key=secret',
            detail: 'prompt=do not share',
            rawBody: '{"prompt":"do not share"}',
            url: 'https://example.invalid?api_key=secret'
        }
    }], {
        defaultBackendId: 'openrouter'
    });

    assert.equal(payload.session.inferenceBackend, 'openrouter');
    assert.deepEqual(payload.messages[0].memoryRetrievalFailure, {
        kind: 'timeout',
        title: 'Memory lookup took too long',
        detail: 'Check your connection and try again if you need memory context.'
    });
    assert.equal('rawBody' in payload.messages[0].memoryRetrievalFailure, false);
    assert.equal('url' in payload.messages[0].memoryRetrievalFailure, false);
});

test('buildBaseSharePayload normalizes pending memory approval for shared views', () => {
    const payload = buildBaseSharePayload({}, [{
        role: 'assistant',
        content: 'Memory context ready.',
        model: 'memory agent',
        ciPromptDraft: {
            status: 'pending',
            fullPrompt: 'context'
        },
        memoryApprovalPrompt: {
            status: 'pending'
        }
    }]);

    assert.deepEqual(payload.messages[0].memoryApprovalPrompt, { status: 'approved' });
});

test('buildBaseSharePayload serializes council response mode and config for shared imports', () => {
    const payload = buildBaseSharePayload({
        title: 'Shared council chat',
        model: 'OpenAI: GPT-5 Instant',
        responseMode: 'council',
        councilConfig: {
            enabled: true,
            members: ['OpenAI: GPT-5 Instant', 'Anthropic: Claude Sonnet'],
            synthesisModel: 'Google: Gemini Flash',
            outputMode: 'council',
            reviewEnabled: true
        }
    }, []);

    assert.equal(payload.session.responseMode, 'council');
    assert.deepEqual(payload.session.councilConfig, {
        enabled: true,
        members: ['OpenAI: GPT-5 Instant', 'Anthropic: Claude Sonnet'],
        synthesisModel: 'Google: Gemini Flash',
        outputMode: 'council',
        reviewEnabled: true
    });
});
