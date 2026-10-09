import test from 'node:test';
import assert from 'node:assert/strict';
import { citationIconHtml, citationIconUrl, ICON_SERVICE } from '../../chat/services/citationIcons.js';

test('shipped providers keep bundled icons, with domain boundaries intact', () => {
    assert.equal(citationIconUrl('https://platform.openai.com/docs'), 'img/openai.svg');
    assert.match(citationIconHtml('https://platform.openai.com/docs'), /src="img\/openai.svg"/);
    for (const url of ['https://openai.com.evil.test/', 'https://notopenai.com/']) {
        assert.doesNotMatch(citationIconUrl(url), /img\//);
    }
});

test('other sites load their icon from the icon service by hostname only, with a local fallback', () => {
    assert.equal(citationIconUrl('https://Example.org/private/path?q=secret#frag'), `${ICON_SERVICE}example.org.ico`);
    const html = citationIconHtml('https://example.org/private/path?q=secret');
    assert.match(html, /<img class="citation-site-icon" src="https:\/\/icons\.duckduckgo\.com\/ip3\/example\.org\.ico"/);
    assert.match(html, /referrerpolicy="no-referrer"/);
    assert.match(html, /onerror="this\.style\.display='none';this\.nextElementSibling\.style\.display='';"/);
    assert.match(html, /<svg style="display:none" class="citation-site-icon"/);
    assert.doesNotMatch(html, /private|secret/);
});

test('invalid or non-http sources get only the local website symbol', () => {
    for (const url of ['javascript:alert(1)', 'data:image/svg+xml,x', '<bad>', '', 'ftp://example.org/']) {
        const html = citationIconHtml(url);
        assert.equal(citationIconUrl(url), '');
        assert.match(html, /^<svg class="citation-site-icon"/);
        assert.doesNotMatch(html, /<img|https?:|onerror|javascript:/);
    }
});
