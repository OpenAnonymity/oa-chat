import test from 'node:test';
import assert from 'node:assert/strict';
import markedApi from '../../chat/vendor/marked/marked.min.js';


function installBrowser() {
    const keys = ['window', 'location', 'localStorage', 'sessionStorage', 'document', 'fetch', 'requestAnimationFrame'];
    const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const events = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    const location = { href: 'http://localhost/', hostname: 'localhost', origin: 'http://localhost', search: '', pathname: '/' };
    const values = {
        window: { ...events, location, localStorage: storage, sessionStorage: storage },
        location, localStorage: storage, sessionStorage: storage,
        document: { ...events, querySelector: () => null, getElementById: () => null,
            documentElement: { classList: { contains: () => false }, dataset: {} } },
        fetch: async () => { throw new Error('These controller tests must never use the network.'); },
        requestAnimationFrame: callback => callback()
    };
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    return () => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    };
}

const restoreImport = installBrowser();
const { default: preferencesStore } = await import('../../chat/services/preferencesStore.js');
const getPreference = preferencesStore.getPreference;
preferencesStore.getPreference = async () => false;
const { ChatApp } = await import('../../chat/app.js');
preferencesStore.getPreference = getPreference;
restoreImport();

// Tapping a source link in an answer used to navigate the chat tab away,
// which ended the response that was still streaming and lost the user's place.
test('links in answers open outside the chat so a streaming reply keeps going', () => {
    const previousMarked = globalThis.marked;
    globalThis.marked = markedApi;
    try {
        const app = Object.create(ChatApp.prototype);
        app.configureMarkedRenderer();
        const external = markedApi.parse('See [the Treasury statement](https://home.treasury.gov/news) and https://example.com.');
        for (const anchor of external.match(/<a [^>]+>/g)) {
            assert.match(anchor, /target="_blank"/, anchor);
            assert.match(anchor, /rel="noopener noreferrer"/, anchor);
        }
        const local = markedApi.parse('Jump to [the top](#top) or [email](mailto:a@example.com).');
        assert.doesNotMatch(local, /target="_blank"/, 'in-page and mail links keep their default behaviour');
        assert.doesNotMatch(markedApi.parse('[bad](javascript:alert(1))'), /<a /, 'unsafe links still render as text');
    } finally {
        globalThis.marked = previousMarked;
    }
});
