import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildDemoVercelConfig } from '../../scripts/generate-demo-vercel-config.mjs';

test('demo Vercel config proxies only org API surfaces before the SPA fallback', () => {
    const config = buildDemoVercelConfig('https://mock-org.example.com', true);

    assert.equal(
        config.buildCommand,
        'OA_ORG_SAME_ORIGIN=true OA_DEMO_VERIFIER_BYPASS=true npm run build'
    );
    assert.deepEqual(config.rewrites, [
        {
            source: '/auth/:path*',
            destination: 'https://mock-org.example.com/auth/:path*'
        },
        {
            source: '/api/:path*',
            destination: 'https://mock-org.example.com/api/:path*'
        },
        {
            source: '/chat/:path*',
            destination: 'https://mock-org.example.com/chat/:path*'
        },
        { source: '/(.*)', destination: '/index.html' }
    ]);
});

test('demo Vercel config rejects insecure or path-bearing upstreams', () => {
    for (const origin of [
        'http://mock-org.example.com',
        'https://mock-org.example.com/base',
        'https://user:secret@mock-org.example.com',
        'not-a-url'
    ]) {
        assert.throws(() => buildDemoVercelConfig(origin), /exact HTTPS origin|valid HTTPS origin/);
    }
});

test('public pageview analytics never carries the account cookie', () => {
    const appSource = readFileSync('chat/app.js', 'utf8');
    const indexHtml = readFileSync('chat/index.html', 'utf8');

    assert.match(
        appSource,
        /\/chat\/v1\/analytics\/pageview[\s\S]*?credentials:\s*'omit'/
    );
    assert.doesNotMatch(indexHtml, /import\(['"]\.\/config\.js['"]\)/);
});

test('Vercel builds upload symlink targets and nanomem without Git metadata', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    const vercelIgnore = readFileSync('.vercelignore', 'utf8');

    assert.match(
        packageJson.scripts['prepare:nanomem'],
        /^if \[ -d nanomem\/src \]; then exit 0; fi;/
    );
    assert.doesNotMatch(vercelIgnore, /^!\/\.git(?:\/|$)/m);
    assert.match(vercelIgnore, /^!\/vector$/m);
    assert.match(vercelIgnore, /^!\/vector\/\*\*$/m);
    assert.match(vercelIgnore, /^!\/local_inference$/m);
    assert.match(vercelIgnore, /^!\/local_inference\/\*\*$/m);
});
