import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatApp } from '../../chat/app.js';

test('checkout toast stays above the chat while ordinary toasts follow the composer', () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const toast = { dataset: { position: 'top-center' }, style: {} };
    globalThis.window = { innerHeight: 900 };
    globalThis.document = { getElementById: id => id === 'app-toast' ? toast : { getBoundingClientRect: () => ({ top: 750 }) } };
    try {
        ChatApp.prototype.updateToastPosition.call({});
        assert.equal(toast.style.top, 'calc(env(safe-area-inset-top, 0px) + 72px)');
        assert.equal(toast.style.bottom, 'auto');
        assert.equal(toast.style.maxWidth, 'calc(100vw - 32px)');
        toast.dataset.position = 'composer'; toast.style = {};
        ChatApp.prototype.updateToastPosition.call({});
        assert.equal(toast.style.bottom, '166px');
        assert.equal(toast.style.top, undefined);
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
    }
});
