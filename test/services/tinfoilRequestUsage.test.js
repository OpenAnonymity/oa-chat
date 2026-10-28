import test from 'node:test';
import assert from 'node:assert/strict';
import tinfoil from '../../local_inference/backends/tinfoilBackend.js';
import { createOpenAICompatibleBackend } from '../../local_inference/backends/httpOpenAIBackend.js';
import { createConfidentialMemoryClient } from '../../chat/services/memoryBridge.js';
import { setFeatureUsageReporter } from '../../chat/services/featureUsage.js';

const request = { model: 'synthetic-model', input: 'private synthetic prompt' };
const memoryRequest = { model: 'synthetic-model', messages: [{ role: 'user', content: 'private synthetic prompt' }] };
const completion = () => Response.json({ choices: [{ message: { content: 'private synthetic answer' } }] });
const stream = () => new Response('data: {"choices":[{"delta":{"content":"private synthetic answer"}}]}\n\ndata: [DONE]\n\n');

test('Tinfoil reports each completed call once, never models, errors or other providers', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    setFeatureUsageReporter((...args) => calls.push(args));
    try {
        tinfoil.configure({ apiKey: 'synthetic-secret' });
        globalThis.fetch = async () => Response.json({ data: [{ id: 'synthetic-model' }] });
        await tinfoil.fetchModels();
        assert.deepEqual(calls, []);
        globalThis.fetch = async () => completion();
        await tinfoil.createResponse(request);
        await tinfoil.createResponse(request);
        const other = createOpenAICompatibleBackend({ id: 'other', baseUrl: 'https://example.invalid' });
        await other.createResponse(request);
        assert.deepEqual(calls, [['tinfoil_request_completed'], ['tinfoil_request_completed']]);
        globalThis.fetch = async () => stream();
        await tinfoil.streamResponse(request, { onEvent() {} });
        assert.equal(calls.length, 3);
        globalThis.fetch = async () => new Response('', { status: 402 });
        await assert.rejects(tinfoil.createResponse(request));
        globalThis.fetch = async () => new Response(new ReadableStream({
            start(controller) { controller.error(new DOMException('cancelled', 'AbortError')); }
        }));
        await assert.rejects(tinfoil.streamResponse(request));
        assert.equal(calls.length, 3);
        globalThis.fetch = async () => completion();
        setFeatureUsageReporter(() => { throw new Error('analytics failure'); });
        await tinfoil.createResponse(request);
    } finally {
        globalThis.fetch = originalFetch;
        setFeatureUsageReporter(null);
        tinfoil.configure({ apiKey: null });
    }
});

test('Memory uses its existing retrying client and counts individual successful calls', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    setFeatureUsageReporter((...args) => calls.push(args));
    try {
        const client = await createConfidentialMemoryClient('synthetic-secret');
        let attempts = 0;
        globalThis.fetch = async (url, options) => {
            assert.equal(url, 'https://inference.tinfoil.sh/v1/chat/completions');
            assert.equal(options.headers.Authorization, 'Bearer synthetic-secret');
            return ++attempts === 1 ? new Response('', { status: 503 }) : completion();
        };
        await client.createChatCompletion(memoryRequest);
        assert.equal(attempts, 2);
        assert.deepEqual(calls, [['tinfoil_request_completed']]);
        globalThis.fetch = async () => stream();
        await client.streamChatCompletion(memoryRequest);
        assert.equal(calls.length, 2);
        globalThis.fetch = async () => new Response('', { status: 401 });
        await assert.rejects(client.createChatCompletion(memoryRequest));
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(client.streamChatCompletion({ ...memoryRequest, signal: controller.signal }));
        await assert.rejects(createConfidentialMemoryClient('synthetic-secret', controller.signal));
        assert.equal(calls.length, 2);
        assert.ok(calls.every(args => args.length === 1 && args[0] === 'tinfoil_request_completed'));
    } finally {
        globalThis.fetch = originalFetch;
        setFeatureUsageReporter(null);
    }
});
