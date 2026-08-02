import test from 'node:test';
import assert from 'node:assert/strict';

function createMemoryStorage() {
    const values = new Map();
    return {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, String(value));
        }
    };
}

test('buffered reasoning callbacks stay ahead of following provider output', async () => {
    globalThis.localStorage = createMemoryStorage();
    globalThis.window = { location: { hostname: 'localhost' } };

    const [{ default: networkProxy }, { default: openRouterAPI }] = await Promise.all([
        import('../../chat/services/networkProxy.js'),
        import('../../chat/api.js')
    ]);
    const originalFetchWithRetry = networkProxy.fetchWithRetry;
    const encoder = new TextEncoder();
    const sse = [
        { choices: [{ delta: { reasoning: 'think one' } }] },
        { choices: [{ delta: { content: 'Visible one.' } }] },
        { choices: [{ delta: { reasoning: 'think two' } }] },
        { choices: [{ delta: { images: [{ image_url: { url: 'data:image/png;base64,test' } }] } }] },
        { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'think three' }] } }] },
        { choices: [{ delta: { content: 'Visible two.' } }] }
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';

    networkProxy.fetchWithRetry = async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(sse));
                controller.close();
            }
        })
    });

    const callbacks = [];
    try {
        await openRouterAPI.streamCompletion(
            [{ role: 'user', content: 'test' }],
            'anthropic/claude-test',
            'test-key',
            async (chunk, imageData) => {
                callbacks.push(chunk ? `content:${chunk}` : `image:${imageData.images.length}`);
            },
            null,
            [],
            false,
            null,
            null,
            async reasoning => {
                await new Promise(resolve => setTimeout(resolve, 1));
                callbacks.push(`reasoning:${reasoning}`);
            }
        );

        assert.deepEqual(callbacks, [
            'reasoning:think one',
            'content:Visible one.',
            'reasoning:think two',
            'image:1',
            'reasoning:think three',
            'content:Visible two.'
        ]);
    } finally {
        networkProxy.fetchWithRetry = originalFetchWithRetry;
        delete globalThis.localStorage;
        delete globalThis.window;
    }
});
