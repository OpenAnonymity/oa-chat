import test from 'node:test';
import assert from 'node:assert/strict';
import networkProxy from '../../chat/services/networkProxy.js';

async function fixture(run) {
    // Use a separate instance-shaped object; do not change the shared singleton.
    const proxy = Object.create(Object.getPrototypeOf(networkProxy));
    proxy.activeRequestCount = 2;
    proxy.emitChange = () => {};
    await run(proxy);
}

for (const ending of ['cancel', 'error', 'complete', 'signal']) {
    test(`relay ${ending} releases only its own active count and unlocks its reader`, { timeout: 1000 }, () => fixture(async proxy => {
        let upstream, cancelled = 0;
        const body = new ReadableStream({ start(c) { upstream = c; }, cancel() { cancelled++; return new Promise(() => {}); } });
        const controller = new AbortController();
        const response = proxy.wrapResponseForTracking(new Response(body), controller.signal);
        const reader = response.body.getReader();
        const pending = reader.read();
        await Promise.resolve(); // enter the upstream pull before cancellation
        await Promise.resolve();
        if (ending === 'cancel') {
            await reader.cancel();
            assert.equal((await pending).done, true);
        } else if (ending === 'signal') {
            controller.abort();
            await assert.rejects(pending, { name: 'AbortError' });
        } else if (ending === 'error') {
            upstream.error(new Error('Synthetic relay failure'));
            await assert.rejects(pending, /Synthetic relay failure/);
        } else {
            upstream.close();
            assert.equal((await pending).done, true);
        }
        assert.equal(proxy.activeRequestCount, 1, 'the other request stays active');
        assert.equal(body.locked, false);
        if (ending === 'cancel' || ending === 'signal') assert.equal(cancelled, 1);
        controller.abort();
        assert.equal(proxy.activeRequestCount, 1, 'cleanup is idempotent');
    }));
}

test('tracking preserves bytes and does not read ahead without demand', () => fixture(async proxy => {
    const response = proxy.wrapResponseForTracking(new Response('synthetic body'));
    assert.equal(proxy.activeRequestCount, 2);
    assert.equal(await response.text(), 'synthetic body');
    assert.equal(proxy.activeRequestCount, 1);
}));

test('Stop during proxy startup releases the request and late readiness cannot send it', async () => {
    const proxy = Object.create(Object.getPrototypeOf(networkProxy));
    proxy.state = { settings: { enabled: true, fallbackToDirect: false }, transport: 'proxy' };
    proxy.activeRequestCount = 0;
    proxy.emitChange = () => {};
    let ready, sent = 0;
    proxy.ensureProxyApplied = () => new Promise(resolve => { ready = resolve; });
    proxy.fetchThroughProxy = async () => { sent++; return new Response('late'); };
    const controller = new AbortController();
    const pending = proxy.fetch('https://example.invalid/key', { signal: controller.signal });
    assert.equal(proxy.activeRequestCount, 1);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(proxy.activeRequestCount, 0);
    ready();
    await Promise.resolve();
    assert.equal(sent, 0);
    assert.equal(proxy.state.settings.fallbackToDirect, false);
    assert.equal(proxy.state.transport, 'proxy');
});
