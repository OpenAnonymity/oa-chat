import test from 'node:test';
import assert from 'node:assert/strict';
import { citationIconHtml } from '../../chat/services/citationIcons.js';

test('citation site icons use only bundled assets and validate domain boundaries', () => {
    assert.match(citationIconHtml('https://platform.openai.com/docs'), /src="img\/openai.svg"/);
    for (const url of ['https://openai.com.evil.test/', 'https://notopenai.com/', 'javascript:alert(1)', 'data:image/svg+xml,x', '<bad>', 'https://example.org/']) {
        const html = citationIconHtml(url);
        assert.match(html, /<svg/);
        assert.doesNotMatch(html, /<img|https?:|onerror|javascript:/);
    }
});
