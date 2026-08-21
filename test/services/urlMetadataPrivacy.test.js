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

test('citation rendering contains no remote preview or favicon services', () => {
    const sources = [
        readFileSync('chat/services/urlMetadata.js', 'utf8'),
        readFileSync('chat/components/MessageTemplates.js', 'utf8')
    ].join('\n');

    assert.doesNotMatch(sources, /corsproxy\.io|allorigins\.win|icons\.duckduckgo\.com/);
    assert.doesNotMatch(sources, /fetch\s*\(/);
});
