import test from 'node:test';
import assert from 'node:assert/strict';

// Client-rendered tools (charts, cards): the OpenRouter client must advertise
// them only when asked, reassemble streamed calls, round-trip earlier tool
// turns, and treat a tool-only reply as an answer rather than an empty stream.

function installBrowser() {
    const keys = ['window', 'location', 'localStorage', 'sessionStorage', 'document', 'fetch', 'requestAnimationFrame'];
    const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const events = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    const location = { href: 'http://localhost/', hostname: 'localhost', origin: 'http://localhost', search: '', pathname: '/' };
    const values = {
        window: { ...events, location, localStorage: storage, sessionStorage: storage },
        location, localStorage: storage, sessionStorage: storage,
        document: { ...events, querySelector: () => null, getElementById: () => null, activeElement: null,
            documentElement: { classList: { contains: () => false }, dataset: {} } },
        fetch: async () => { throw new Error('These tests must never use the network.'); },
        requestAnimationFrame: callback => callback()
    };
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    return () => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    };
}

const restore = installBrowser();
const { default: api } = await import('../../chat/api.js');
restore();

const CHART_TOOL = { type: 'function', function: { name: 'render_chart', description: 'Render a chart.', parameters: { type: 'object' } } };
const sse = events => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');

function withFakeTransport(body, { onRequest } = {}) {
    const options = api.options;
    const transport = api.networkTransport;
    api.options = { acquireRequestAccess: async () => ({ apiKey: 'synthetic', baseUrl: 'https://fake.invalid', release: async () => {} }) };
    api.networkTransport = { fetchWithRetry: async (_url, init) => {
        onRequest?.(JSON.parse(init.body));
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    } };
    return () => { api.options = options; api.networkTransport = transport; };
}

function stream(messages, onChunk, clientToolOptions) {
    return api.streamCompletion(messages, 'test/model', 'token', onChunk, null, [], false, null, null, null,
        false, 'medium', null, null, null, clientToolOptions);
}

test('tools, tool_choice and the tool instructions are sent only when client tools are passed', async () => {
    const restoreBrowser = installBrowser();
    const bodies = [];
    const done = withFakeTransport(sse([{ choices: [{ delta: { content: 'plain' }, finish_reason: 'stop' }] }, '[DONE]']), { onRequest: body => bodies.push(body) });
    try {
        await stream([{ role: 'user', content: 'hi' }], () => {}, { tools: [CHART_TOOL], systemInstructions: 'Use render_chart for numbers.' });
        await stream([{ role: 'user', content: 'hi' }], () => {}, null);
        await stream([{ role: 'user', content: 'hi' }], () => {}, { tools: [] });
        assert.deepEqual(bodies[0].tools, [CHART_TOOL]);
        assert.equal(bodies[0].tool_choice, 'auto');
        assert.match(bodies[0].messages[0].content, /Use render_chart for numbers\.$/);
        for (const body of bodies.slice(1)) {
            assert.equal('tools' in body, false);
            assert.equal('tool_choice' in body, false);
            assert.doesNotMatch(body.messages[0].content, /render_chart/);
        }
    } finally { done(); restoreBrowser(); }
});

test('a streamed tool call is reassembled, announced once, and counts as the answer', async () => {
    const restoreBrowser = installBrowser();
    const chunks = [];
    const done = withFakeTransport(sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'render_', arguments: '{"type":"bar",' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'chart', arguments: '"series":[]}' } }] }, finish_reason: 'tool_calls' }] },
        { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
        '[DONE]'
    ]));
    try {
        const result = await stream([{ role: 'user', content: 'chart it' }], (chunk, extra) => { chunks.push([chunk, extra]); }, { tools: [CHART_TOOL] });
        assert.equal(result.finishReason, 'tool_calls');
        assert.deepEqual(result.toolCalls, [{ id: 'call_1', type: 'function', function: { name: 'render_chart', arguments: '{"type":"bar","series":[]}' } }]);
        assert.equal(result.totalTokens, 10);
        assert.deepEqual(chunks.filter(([, extra]) => extra?.toolCallPending), [[null, { toolCallPending: true }]]);
    } finally { done(); restoreBrowser(); }
});

test('a text-only reply still reports an empty toolCalls list', async () => {
    const restoreBrowser = installBrowser();
    const done = withFakeTransport(sse([{ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }, '[DONE]']));
    try {
        const result = await stream([{ role: 'user', content: 'hi' }], () => {}, { tools: [CHART_TOOL] });
        assert.deepEqual(result.toolCalls, []);
    } finally { done(); restoreBrowser(); }
});

test('earlier assistant tool calls and tool results round-trip on the wire', async () => {
    const restoreBrowser = installBrowser();
    let body = null;
    const done = withFakeTransport(sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']), { onRequest: parsed => { body = parsed; } });
    try {
        const priorCall = { id: 'call_old', type: 'function', function: { name: 'render_chart', arguments: '{"type":"line"}' } };
        await stream([
            { role: 'user', content: 'chart it' },
            { role: 'assistant', content: '', tool_calls: [priorCall] },
            { role: 'tool', tool_call_id: 'call_old', name: 'render_chart', content: 'Rendered locally.' },
            { role: 'user', content: 'make it a line chart' }
        ], () => {}, { tools: [CHART_TOOL] });
        const [, user, assistant, tool, next] = body.messages;
        assert.deepEqual(Object.keys(user).sort(), ['content', 'role']);
        assert.deepEqual(assistant.tool_calls, [priorCall]);
        assert.equal(tool.role, 'tool');
        assert.equal(tool.tool_call_id, 'call_old');
        assert.equal(tool.name, 'render_chart');
        assert.deepEqual(Object.keys(next).sort(), ['content', 'role']);
    } finally { done(); restoreBrowser(); }
});

test('a transport failure after partial tool arguments has already announced output to the resend policy', async () => {
    const restoreBrowser = installBrowser();
    const encoder = new TextEncoder();
    const options = api.options;
    const transport = api.networkTransport;
    api.options = { acquireRequestAccess: async () => ({ apiKey: 'synthetic', baseUrl: 'https://fake.invalid', release: async () => {} }) };
    let sent = false;
    api.networkTransport = { fetchWithRetry: async () => new Response(new ReadableStream({
        pull(controller) {
            if (!sent) {
                sent = true;
                controller.enqueue(encoder.encode(sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_p', function: { name: 'render_chart', arguments: '{"ty' } }] } }] }])));
                return;
            }
            controller.error(Object.assign(new Error('transport failed'), { status: 503 }));
        }
    }), { headers: { 'Content-Type': 'text/event-stream' } }) };
    const announcements = [];
    try {
        await assert.rejects(stream([{ role: 'user', content: 'chart it' }], (chunk, extra) => { announcements.push([chunk, extra]); }, { tools: [CHART_TOOL] }),
            error => /transport failed/.test(error?.message));
        // app.js treats a toolCallPending announcement as output, which is what
        // keeps the resend policy from silently replaying a started generation.
        assert.deepEqual(announcements, [[null, { toolCallPending: true }]]);
    } finally { api.options = options; api.networkTransport = transport; restoreBrowser(); }
});
