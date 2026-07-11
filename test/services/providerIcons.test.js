import test from 'node:test';
import assert from 'node:assert/strict';
import { getProviderIcon } from '../../chat/services/providerIcons.js';

test('known providers use local assets', () => {
    const xai = getProviderIcon('xAI');
    assert.equal(xai.hasIcon, true);
    assert.match(xai.html, /src="img\/xai\.svg"/);
    assert.doesNotMatch(xai.html, /https?:\/\//);
});

test('OpenRouter uses a self-hosted asset', () => {
    const icon = getProviderIcon('OpenRouter');
    assert.match(icon.html, /src="img\/openrouter\.(svg|png)"/);
    assert.doesNotMatch(icon.html, /openrouter\.ai/);
});

test('catalog provider aliases resolve to canonical local assets', () => {
    const expectedAssets = new Map([
        ['Z.ai', 'zai'],
        ['moonshotai', 'moonshot'],
        ['amazon', 'aws'],
        ['ibm-granite', 'ibm'],
        ['bytedance-seed', 'bytedance'],
        ['Arcee AI', 'arcee'],
        ['Xiaomi', 'xiaomi'],
        ['Upstage', 'upstage']
    ]);

    for (const [provider, filename] of expectedAssets) {
        const icon = getProviderIcon(provider);
        assert.equal(icon.hasIcon, true, `${provider} should have an icon`);
        assert.match(icon.html, new RegExp(`src="img/${filename}\\.svg"`));
    }
});

test('unknown and malformed providers use escaped neutral badges', () => {
    assert.deepEqual(getProviderIcon('Future Lab').hasIcon, false);
    assert.match(getProviderIcon('Future Lab').html, />F<\/span>/);
    assert.match(getProviderIcon('<script>').html, />S<\/span>/);
    assert.match(getProviderIcon('').html, />A<\/span>/);

    const hostileClasses = getProviderIcon('xAI', 'w-4" data-injected="true');
    assert.match(hostileClasses.html, /w-4&quot; data-injected=&quot;true/);
    assert.doesNotMatch(hostileClasses.html, /class="w-4" data-injected=/);
});

test('image markup includes a local failure fallback', () => {
    const icon = getProviderIcon('xAI');
    assert.match(icon.html, /data-provider-icon/);
    assert.match(icon.html, /data-provider-icon-fallback/);
    assert.doesNotMatch(icon.html, /onerror=/);
});

test('one capture-phase listener reveals the fallback after an image error', () => {
    const originalDocument = globalThis.document;
    const listeners = [];
    globalThis.document = {
        addEventListener(type, handler, capture) {
            listeners.push({ type, handler, capture });
        }
    };

    try {
        getProviderIcon('xAI');
        getProviderIcon('OpenRouter');
        assert.equal(listeners.length, 1);
        assert.equal(listeners[0].type, 'error');
        assert.equal(listeners[0].capture, true);

        const fallback = {
            hidden: true,
            matches: selector => selector === '[data-provider-icon-fallback]'
        };
        const image = {
            hidden: false,
            matches: selector => selector === 'img[data-provider-icon]',
            nextElementSibling: fallback
        };
        listeners[0].handler({ target: image });

        assert.equal(image.hidden, true);
        assert.equal(fallback.hidden, false);
    } finally {
        if (originalDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = originalDocument;
        }
    }
});
