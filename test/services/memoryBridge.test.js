import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureMemoryKey } from '../../chat/services/memoryBridge.js';

test('ensureMemoryKey does not redeem a key when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    let requestCount = 0;
    const session = {};
    const client = {
        getTicketCount: () => 1,
        requestConfidentialApiKey: async () => {
            requestCount += 1;
            return { key: 'secret-key' };
        }
    };

    await assert.rejects(
        () => ensureMemoryKey(session, client, { signal: controller.signal }),
        (error) => error?.name === 'AbortError'
    );

    assert.equal(requestCount, 0);
    assert.equal(session.memoryKey, undefined);
});

test('ensureMemoryKey does not store a key when the signal aborts during redemption', async () => {
    const controller = new AbortController();
    let capturedOptions = null;
    const session = {};
    const client = {
        getTicketCount: () => 1,
        requestConfidentialApiKey: async (ticketCount, options) => {
            capturedOptions = options;
            assert.equal(ticketCount, 1);
            controller.abort();
            return { key: 'secret-key', expires_at_unix: 9999999999 };
        }
    };

    await assert.rejects(
        () => ensureMemoryKey(session, client, { signal: controller.signal }),
        (error) => error?.name === 'AbortError'
    );

    assert.equal(capturedOptions?.signal, controller.signal);
    assert.equal(session.memoryKey, undefined);
    assert.equal(session.memoryKeyInfo, undefined);
});
