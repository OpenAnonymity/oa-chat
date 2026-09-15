import test from 'node:test';
import assert from 'node:assert/strict';

import {
    configureAppRouteRoot,
    getAppRouteRoot,
    getShareBaseUrl,
    normalizeAppRouteRoot
} from '../../chat/services/appRoutes.js';

test('app route roots normalize mounted compositions', () => {
    assert.equal(normalizeAppRouteRoot('/chat'), '/chat/');
    assert.equal(normalizeAppRouteRoot('/'), '/');
    assert.throws(() => normalizeAppRouteRoot('chat'), /absolute path/);
    assert.throws(() => normalizeAppRouteRoot('//evil.example'), /absolute path/);
    assert.throws(() => normalizeAppRouteRoot('/chat/../admin'), /absolute path/);
    assert.throws(() => normalizeAppRouteRoot('/chat/?billing=1'), /query or fragment/);
});

test('mounted compositions generate same-origin shared-chat links', () => {
    const originalWindow = globalThis.window;
    globalThis.window = { location: { origin: 'https://commercial.example' } };
    try {
        configureAppRouteRoot('/chat');
        assert.equal(getAppRouteRoot(), '/chat/');
        assert.equal(getShareBaseUrl(), 'https://commercial.example/chat/');
    } finally {
        configureAppRouteRoot('/');
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
    }
});


test('root conversation links follow their deployment instead of crossing share backends', () => {
    const originalWindow = globalThis.window;
    try {
        configureAppRouteRoot('/');
        for (const origin of ['https://staging.openanonymity.ai', 'https://chat.openanonymity.ai', 'http://127.0.0.1:8784']) {
            globalThis.window = { location: { origin } };
            assert.equal(getShareBaseUrl(), origin + '/');
        }
        for (const origin of ['app://openanonymity.ai', 'null', 'file://', '']) {
            globalThis.window = { location: { origin } };
            assert.equal(getShareBaseUrl(), 'https://chat.openanonymity.ai');
        }
        delete globalThis.window;
        assert.equal(getShareBaseUrl(), 'https://chat.openanonymity.ai');
    } finally {
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
    }
});
