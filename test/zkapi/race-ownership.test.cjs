const assert = require('node:assert/strict');
const test = require('node:test');

// Controller timeline ownership now runs against real shared ChatApp behavior
// in oa-chat/test/application/chatRuntimeOwnership.test.js. Product settlement
// and hidden-journal races run in zkapi-chat-runtime.test.mjs. These tests cover
// the remaining cross-repo request-access seam, without parsing a dead app copy.
const sharedApi = import('../../chat/publicInferenceApi.js');

function deferred() {
    let resolve;
    const promise = new Promise(value => { resolve = value; });
    return { promise, resolve };
}

test('concurrent title and response access contexts are isolated and released once each', async () => {
    const { OpenRouterAPI } = await sharedApi;
    const gate = deferred();
    const acquired = [];
    const released = [];
    const api = new OpenRouterAPI({
        acquireRequestAccess: async (sessionId, options) => {
            const id = acquired.length;
            const access = { id, baseUrl: 'https://provider.invalid/api', apiKey: `key-${id}`,
                release: async () => released.push(id) };
            acquired.push({ sessionId, options, access });
            return access;
        }
    });
    const observed = [];
    const operation = async request => {
        const access = request._requestAccess;
        await gate.promise;
        assert.equal(request._requestAccess, access);
        observed.push(access.id);
        return access.id;
    };
    const title = api.withRequestAccess('same-chat', { kind: 'title' }, operation);
    const response = api.withRequestAccess('same-chat', { kind: 'response' }, operation);
    await Promise.resolve();
    assert.equal(acquired.length, 2);
    assert.notEqual(acquired[0].access, acquired[1].access);
    assert.equal(api._requestAccess, undefined);
    gate.resolve();
    assert.deepEqual(await Promise.all([title, response]), [0, 1]);
    assert.deepEqual(observed.sort(), [0, 1]);
    assert.deepEqual(released.sort(), [0, 1]);
});

test('cancellation during acquisition releases access without starting provider inference', async () => {
    const { OpenRouterAPI } = await sharedApi;
    const gate = deferred();
    const controller = new AbortController();
    let released = 0;
    const api = new OpenRouterAPI({
        acquireRequestAccess: async (_session, options) => {
            assert.equal(options.signal, controller.signal);
            await gate.promise;
            return { baseUrl: 'https://provider.invalid', release: async () => { released += 1; } };
        }
    });
    const response = api.withRequestAccess('chat', { signal: controller.signal }, () => assert.fail('provider request must not start'));
    controller.abort();
    gate.resolve();
    await assert.rejects(response, error => error.name === 'AbortError');
    assert.equal(released, 1);
});

test('actual title and streaming wrappers forward caller cancellation and progress to acquisition', async () => {
    const { OpenRouterAPI } = await sharedApi;
    const controller = new AbortController();
    const progress = () => {};
    const calls = [];
    const api = new OpenRouterAPI({
        acquireRequestAccess: async (sessionId, options) => {
            calls.push({ sessionId, options });
            return { baseUrl: 'https://provider.invalid', apiKey: 'private-key', release: async () => {} };
        }
    });
    api._generateSessionTitle = async () => 'Test title';
    api._streamCompletion = async () => ({ completionTokens: 1 });
    await api.generateSessionTitle('Explain HTTPS', 'chat', { signal: controller.signal });
    await api.streamCompletion([], 'model', 'chat', () => {}, () => {}, [], false,
        controller, null, null, true, 'medium', progress);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.signal, controller.signal);
    assert.equal(calls[1].options.signal, controller.signal);
    assert.equal(calls[1].options.onProgress, progress);
    assert.deepEqual(calls.map(call => call.sessionId), ['chat', 'chat']);
});
