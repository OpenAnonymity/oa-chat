import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildZkapiAssets, resolveZkapiNetwork, zkapiBuildProvenance } from '../../scripts/zkapiBuild.mjs';

test('zkAPI network selection is explicit and rejects ambiguous build settings', () => {
    assert.equal(resolveZkapiNetwork({}), '');
    assert.equal(resolveZkapiNetwork({ OA_ZKAPI_NETWORK: 'sepolia' }), 'sepolia');
    assert.equal(resolveZkapiNetwork({ OA_ZKAPI_NETWORK: 'mainnet' }), 'mainnet');
    for (const value of ['true', 'false', 'ethereum', ' mainnet', 'https://untrusted.test']) {
        assert.throws(() => resolveZkapiNetwork({ OA_ZKAPI_NETWORK: value }), /OA_ZKAPI_NETWORK/);
    }
});

test('a ticket-only build removes stale SDK source and assets without loading a worker', async t => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-ticket-build-'));
    t.after(() => fs.rm(outDir, { recursive: true, force: true }));
    await fs.mkdir(path.join(outDir, 'zkapi'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'zkapi/browser-config.json'), 'stale mainnet config');
    const result = await buildZkapiAssets({ network: '', outDir, build() { throw new Error('SDK build must stay disabled'); } });
    assert.equal(result, null);
    await assert.rejects(fs.stat(path.join(outDir, 'zkapi')), { code: 'ENOENT' });
});

test('zkAPI provenance refuses floating or local SDK dependencies', async t => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-sdk-pin-'));
    t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
    for (const resolved of ['file:../zkapi', 'git+https://github.com/example/sdk.git#main', 'https://registry.example/sdk.tgz']) {
        await fs.writeFile(path.join(repoRoot, 'package-lock.json'), JSON.stringify({ packages: {
            'node_modules/@openanonymity/zkapi-browser-sdk': { version: '0.2.0', resolved }
        } }));
        await assert.rejects(zkapiBuildProvenance({ network: 'sepolia', repoRoot, outDir: repoRoot }), /immutable Git commit/);
    }
});
