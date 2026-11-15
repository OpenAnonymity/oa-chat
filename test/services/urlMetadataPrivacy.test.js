import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fetchUrlMetadata } from '../../chat/services/urlMetadata.js';

test('citation metadata is derived locally without automatic network requests', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error('unexpected network request');
    };

    try {
        const metadata = await fetchUrlMetadata(
            'https://private-response.example/sensitive/path?query=value'
        );
        assert.equal(fetchCalls, 0);
        assert.equal(metadata.domain, 'private-response.example');
        assert.equal(metadata.title, 'private-response.example');
        assert.equal(metadata.description, '');
        assert.equal(metadata.favicon, '');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// Site icons are the one deliberate remote load (icons.duckduckgo.com, hostname
// only, no referrer; decided 2026-10-09, see PRIVACY_MODEL.md). Everything else
// about rendering a response stays network-silent: no preview proxies, no
// fetch of cited pages, and the icon host is named in exactly one module.
test('citation rendering contains no preview proxies or fetches; the icon service is the only remote host', () => {
    const rendering = [
        readFileSync('chat/services/urlMetadata.js', 'utf8'),
        readFileSync('chat/components/MessageTemplates.js', 'utf8')
    ].join('\n');
    const icons = readFileSync('chat/services/citationIcons.js', 'utf8');

    assert.doesNotMatch(rendering, /corsproxy\.io|allorigins\.win|icons\.duckduckgo\.com/);
    assert.doesNotMatch(rendering + icons, /fetch\s*\(/);
    assert.match(icons, /https:\/\/icons\.duckduckgo\.com\/ip3\//);
    assert.match(icons, /referrerpolicy="no-referrer"/);
});
