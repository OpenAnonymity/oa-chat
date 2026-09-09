import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// A deploy can leave a browser holding a cached 404 for a bundle URL (the
// CDN in front of staging stamps 404s with a four-hour browser TTL). The
// page must recover by itself: retry the bundle once under a fresh URL,
// and say so if that fails, rather than sit on the loading placeholder.
const read = relative => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

test('both bundle scripts retry once under a fresh URL and then explain themselves', () => {
    const html = read('chat/index.html');
    assert.match(html, /window\.__oaRetryBundle = function \(failed\)/);
    assert.match(html, /'r=' \+ Date\.now\(\)/, 'the retry URL differs from the cached one');
    assert.match(html, /tries >= 1/, 'exactly one retry');
    assert.match(html, /oa-chat could not load\./);
    const moduleTags = [...html.matchAll(/<script type="module" src="[^"]+"([^>]*)>/g)];
    assert.equal(moduleTags.length, 2);
    for (const [, attrs] of moduleTags) assert.match(attrs, /onerror="window\.__oaRetryBundle\(this\)"/);
    // The build rewrites these tags; it must keep the handler.
    assert.match(read('scripts/build.mjs'), /<script type="module" src="\$\{scriptPath\}" onerror="window\.__oaRetryBundle\(this\)"><\/script>/);
    // The helper is defined before the first bundle tag runs.
    assert.ok(html.indexOf('window.__oaRetryBundle = function') < html.indexOf('<!-- BUNDLE:PRELUDE -->'));
});
