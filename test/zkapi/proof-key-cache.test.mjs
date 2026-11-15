import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';

const sdkRoot = path.dirname(fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/package.json')));
const source = await fs.readFile(path.join(sdkRoot, 'sdk/services/zkapiWasmWorker.js'), 'utf8');
const good = new TextEncoder().encode('pinned current circuit proving key');
const stale = new TextEncoder().encode('previous circuit proving key');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const descriptor = { url: 'https://example.test/zkapi/proofs/request.pk', sha256: digest(good) };

function worker(fetch) {
    const context = vm.createContext({ fetch, URL, Uint8Array, crypto: webcrypto,
        self: { addEventListener() {} } });
    vm.runInContext(source
        .replace(/^import[\s\S]*?from '\.\.\/wasm\/zkapi_browser\.js';/, '')
        .replaceAll('import.meta.url', JSON.stringify('https://example.test/zkapi/assets/zkapiWasmWorker.js')), context);
    return context;
}

function response(bytes, status = 200) {
    return { ok: status >= 200 && status < 300, status,
        async arrayBuffer() { return bytes.slice().buffer; } };
}

test('a stale proof cache is refreshed once and only pinned bytes are returned', async () => {
    const calls = [];
    const context = worker(async (url, init) => {
        calls.push({ url, ...init });
        return response(init.cache === 'reload' ? good : stale);
    });
    assert.deepEqual(await context.loadProvingKey(descriptor), good);
    assert.deepEqual(calls, [
        { url: `${descriptor.url}?sha256=${descriptor.sha256}`, cache: 'force-cache', credentials: 'omit' },
        { url: `${descriptor.url}?sha256=${descriptor.sha256}`, cache: 'reload', credentials: 'omit' }
    ]);
    await context.loadProvingKey(descriptor);
    assert.equal(calls.length, 2, 'a successfully verified key remains resident');
});

test('a network integrity mismatch remains blocked and does not poison the next attempt', async () => {
    let calls = 0;
    const context = worker(async () => response(++calls <= 2 ? stale : good));
    await assert.rejects(context.loadProvingKey(descriptor), /SHA-256 integrity check/);
    assert.equal(calls, 2, 'retry count is bounded');
    assert.deepEqual(await context.loadProvingKey(descriptor), good);
    assert.equal(calls, 3);
});

test('changed proof pins select separate cache URLs while preserving other query parameters', async () => {
    const urls = [];
    const context = worker(async url => {
        urls.push(url);
        return response(urls.length === 1 ? good : stale);
    });
    const url = `${descriptor.url}?asset=request&sha256=obsolete`;
    await context.loadProvingKey({ url, sha256: descriptor.sha256.toUpperCase() });
    await context.loadProvingKey({ url, sha256: digest(stale) });
    assert.deepEqual(urls, [
        `${descriptor.url}?asset=request&sha256=${descriptor.sha256}`,
        `${descriptor.url}?asset=request&sha256=${digest(stale)}`
    ]);
});

test('concurrent key loads share their fetch and verified bytes', async () => {
    let calls = 0;
    let finish;
    const context = worker(async () => {
        calls++;
        return new Promise(resolve => { finish = resolve; });
    });
    const first = context.loadProvingKey(descriptor);
    const second = context.loadProvingKey(descriptor);
    finish(response(good));
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, good);
    assert.equal(a, b);
    assert.equal(calls, 1);
});

test('HTTP failures never reach proof decoding and can be retried later', async () => {
    let calls = 0;
    const context = worker(async () => response(good, ++calls === 1 ? 404 : 200));
    await assert.rejects(context.loadProvingKey(descriptor), /Unable to load proving key \(404\)/);
    assert.deepEqual(await context.loadProvingKey(descriptor), good);
    assert.equal(calls, 2);
});
