import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repoRoot = process.cwd();

async function read(relativePath) {
    return fs.readFile(path.join(repoRoot, relativePath), 'utf8');
}

test('account and sync services delegate session refresh to SuperTokens', async () => {
    const [accountSource, syncSource] = await Promise.all([
        read('chat/services/accountService.js'),
        read('chat/services/syncService.js'),
    ]);

    for (const source of [accountSource, syncSource]) {
        assert.doesNotMatch(source, /\/auth\/refresh/);
        assert.doesNotMatch(source, /account-refresh-token/);
        assert.doesNotMatch(source, /Authorization['"]?\s*:/);
    }
    assert.match(accountSource, /sessionService\.signOut\(\)/);
    assert.match(syncSource, /fetchFn:\s*sessionService\.fetch\.bind\(sessionService\)/);
});

test('Electron renderer transport exposes responses without token accessors', async () => {
    const source = await read('chat/services/sessionService.js');

    assert.match(source, /electronAPI\.authSessionFetch/);
    assert.doesNotMatch(source, /getAccessToken/);
    assert.doesNotMatch(source, /st-access-token/);
    assert.doesNotMatch(source, /st-refresh-token/);
});

test('account session credentials are scoped to the org auth API', async () => {
    const [sessionSource, proxySource] = await Promise.all([
        read('chat/services/sessionService.js'),
        read('chat/services/networkProxy.js'),
    ]);

    assert.match(sessionSource, /url\.pathname === '\/auth'/);
    assert.match(sessionSource, /url\.pathname\.startsWith\('\/auth\/'\)/);
    assert.match(sessionSource, /shouldDoInterceptionBasedOnUrl/);
    assert.match(sessionSource, /normalizeAccountAuthUrl\(input\)/);
    assert.match(proxySource, /fetch\(resource, \{ \.\.\.init, credentials: 'omit' \}\)/);
});
