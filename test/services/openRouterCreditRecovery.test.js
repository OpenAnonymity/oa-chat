import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithOpenRouterCreditRecovery, parseOutputAffordability } from '../../chat/services/inference/openRouterCreditRecovery.js';
import { isAccessCreditExhaustedError } from '../../chat/application/accessController.js';

const url = 'https://openrouter.ai/api/v1/chat/completions';
const message = 'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 54775.';
const init = { method: 'POST', headers: { Authorization: 'Bearer test-key' }, body: JSON.stringify({ model: 'test/model', messages: [], stream: true }) };
const rejection = (text = message, source, headers = {}) => new Response(JSON.stringify({
    error: { message: text, metadata: source ? { limit_source: source } : undefined }
}), { status: 402, headers });

test('screenshot failure retries once on the same credential with affordable output', async () => {
    const calls = [];
    const success = new Response('data: [DONE]\n');
    const result = await fetchWithOpenRouterCreditRecovery(async (target, request, config) => {
        calls.push({ target, request, config });
        return calls.length === 1 ? rejection() : success;
    }, url, init, { signal: new AbortController().signal });
    assert.equal(result, success);
    assert.equal(success.bodyUsed, false);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].request.headers, init.headers);
    assert.equal(calls[1].target, url);
    assert.equal(JSON.parse(calls[1].request.body).max_tokens, 49297);
    assert.equal(JSON.parse(init.body).max_tokens, undefined);
});

test('a repeated affordability failure is returned intact without more ticket spending', async () => {
    let calls = 0;
    const result = await fetchWithOpenRouterCreditRecovery(async () => { calls++; return rejection(); }, url, init);
    assert.equal(calls, 2);
    const data = await result.json();
    assert.equal(data.error.message, message);
    assert.equal(isAccessCreditExhaustedError({ status: 402, data }), false);
});

test('product-supplied output limits are never increased or overwritten by body preparation', async () => {
    for (const field of ['max_tokens', 'max_completion_tokens']) {
        let calls = 0;
        await fetchWithOpenRouterCreditRecovery(async (target, request) => {
            if (++calls === 1) return rejection();
            assert.equal(JSON.parse(request.body)[field], 99);
            return new Response();
        }, url, { ...init, body: JSON.stringify({ [field]: 100 }) });
    }
});

test('zero affordability, malformed errors and other providers are not replayed', async () => {
    for (const [target, response] of [
        [url, rejection(message.replace('54775', '0'))],
        [url, new Response('unparseable', { status: 402 })],
        ['https://other.test/v1/chat/completions', rejection()],
        [url, rejection(message, 'unknown_future_limit')],
        [url, new Response('data: {"error":{"code":402}}\n')]
    ]) {
        let calls = 0;
        assert.equal(await fetchWithOpenRouterCreditRecovery(async () => { calls++; return response; }, target, init), response);
        assert.equal(calls, 1);
        assert.equal(response.bodyUsed, false);
    }
});

test('in-flight budget waits use the same key and stop after two retries', async () => {
    let calls = 0;
    const result = await fetchWithOpenRouterCreditRecovery(async () => {
        calls++;
        return rejection('Busy', 'openrouter_in_flight_budget', { 'Retry-After': '0' });
    }, url, init);
    assert.equal(calls, 3);
    assert.equal(result.status, 402);
});

test('a long provider wait is surfaced instead of shortened', async () => {
    let calls = 0;
    await fetchWithOpenRouterCreditRecovery(async () => {
        calls++;
        return rejection('Busy', 'openrouter_in_flight_budget', { 'Retry-After': '60' });
    }, url, init);
    assert.equal(calls, 1);
});

test('cancellation interrupts settlement wait and prevents another request', async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = fetchWithOpenRouterCreditRecovery(async () => {
        calls++;
        return rejection('Busy', 'openrouter_in_flight_budget', { 'Retry-After': '30' });
    }, url, init, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(calls, 1);
});

test('only exhausted keys qualify for ticket rotation', () => {
    for (const source of ['openrouter_credits', 'openrouter_in_flight_budget', 'unknown_limit']) {
        assert.equal(isAccessCreditExhaustedError({ status: 402, message: 'Insufficient credits',
            data: { error: { metadata: { limit_source: source } } } }), false);
    }
    assert.equal(isAccessCreditExhaustedError({ status: 402, message,
        data: { error: { metadata: { limit_source: 'openrouter_key_limit' } } } }), false);
    assert.equal(isAccessCreditExhaustedError({ status: 402, message: 'Insufficient credits' }), true);
    assert.equal(isAccessCreditExhaustedError({ status: 402, message: message.replace('54775', '0') }), true);
    assert.equal(isAccessCreditExhaustedError({ status: 402,
        data: { error: { metadata: { limit_source: 'openrouter_key_limit' } } } }), true);
    assert.equal(isAccessCreditExhaustedError({ status: 429, message }), false);
});

test('affordability parser rejects malformed or inconsistent amounts', () => {
    assert.deepEqual(parseOutputAffordability(message.replace('65536', '65,536').replace('54775', '54,775')),
        { requested: 65536, affordable: 54775 });
    for (const text of [null, 'credits', message.replace('54775', '65536'), message.replace('54775', '-1')]) {
        assert.equal(parseOutputAffordability(text), null);
    }
});
