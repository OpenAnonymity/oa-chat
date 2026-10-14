// Recompute the fixture SDK's derived asset data after editing any file it
// pins, or verify that it is current (exit 1 when it is not):
//
//   node test/fixtures/zkapi-sdk-v2-fixture/refresh-assets.mjs           rewrite
//   node test/fixtures/zkapi-sdk-v2-fixture/refresh-assets.mjs --check   verify only
//
// Derived data, in dependency order:
//   1. the proving and verifying key hashes of sdk/assets/proofs/*;
//   2. those three hashes, written into trusted_deployment of every
//      sdk/assets/config/<network>.json (nothing else in them is touched);
//   3. sdk/assets/manifest.json: the hash of each of the nine artifacts
//      the SDK build verifies (ASSET_MANIFEST_FILES), the circuit and setup
//      read from the wasm glue the way readBundleIdentity does.
//
// This is a script, not a module: it has no exports and nothing imports it.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ASSET_MANIFEST_FILES,
    ASSET_MANIFEST_SCHEMA,
    NETWORKS
} from './sdk/build.mjs';
import { browser_circuit_id, browser_setup_id, initSync } from './sdk/wasm/zkapi_browser.js';

// A stand-in for the upstream source revision the real manifest records.
const SOURCE_REVISION = '0123456789abcdef0123456789abcdef01234567';

const sdkRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sdk');
const check = process.argv.includes('--check');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = relative => fs.readFileSync(path.join(sdkRoot, relative));

const keyHashes = {
    request_proving_key_sha256: digest(read('assets/proofs/request.pk')),
    withdrawal_proving_key_sha256: digest(read('assets/proofs/withdrawal.pk')),
    request_verifying_key_sha256: digest(read('assets/proofs/request.vk'))
};

const outputs = new Map();
for (const network of NETWORKS) {
    const relative = `assets/config/${network}.json`;
    const config = JSON.parse(read(relative).toString('utf8'));
    Object.assign(config.trusted_deployment, keyHashes);
    outputs.set(relative, Buffer.from(`${JSON.stringify(config, null, 2)}\n`));
}

initSync({ module: read('wasm/zkapi_browser_bg.wasm') });
const files = {};
for (const relative of ASSET_MANIFEST_FILES) files[relative] = digest(outputs.get(relative) || read(relative));
const manifest = {
    schema: ASSET_MANIFEST_SCHEMA,
    circuitId: browser_circuit_id(),
    setupId: browser_setup_id(),
    sourceRevision: SOURCE_REVISION,
    files
};
outputs.set('assets/manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

const stale = [];
for (const [relative, bytes] of outputs) {
    const current = fs.existsSync(path.join(sdkRoot, relative)) ? read(relative) : null;
    if (current && current.equals(bytes)) continue;
    stale.push(relative);
    if (!check) fs.writeFileSync(path.join(sdkRoot, relative), bytes);
}

for (const [name, hash] of Object.entries(keyHashes)) console.log(`${name} ${hash}`);
for (const relative of ASSET_MANIFEST_FILES) console.log(`sdk/${relative} ${files[relative]}`);
if (stale.length) {
    console.log(`${check ? 'STALE' : 'updated'}: ${stale.map(relative => `sdk/${relative}`).join(', ')}`);
    if (check) process.exitCode = 1;
} else {
    console.log('current');
}
