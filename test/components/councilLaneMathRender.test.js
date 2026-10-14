import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 2026-10-14: a Parallel turn whose second lane (Claude Haiku) showed its
// \(…\) as text once the turn finished. While streaming, each lane renders
// its own math; the finished message is then painted whole, and that path
// rendered math in only the first `.message-content` — the first lane.

function installGlobals() {
    const keys = ['document', 'window', 'location', 'localStorage', 'sessionStorage', 'fetch', 'navigator', 'requestAnimationFrame'];
    const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const element = () => ({
        text: '', html: null,
        get textContent() { return this.text; }, set textContent(value) { this.text = String(value); this.html = null; },
        get innerHTML() { return this.html ?? this.text; }, set innerHTML(value) { this.html = String(value); },
        classList: { add() {}, remove() {}, contains: () => false },
        querySelector: () => null, querySelectorAll: () => [], appendChild() {}, remove() {}, dataset: {}, style: {}
    });
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const events = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    const location = { href: 'http://localhost/', hostname: 'localhost', origin: 'http://localhost', search: '', pathname: '/' };
    const values = {
        document: { ...events, createElement: element, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            documentElement: element(), body: element() },
        window: { ...events, location, localStorage: storage, sessionStorage: storage, innerWidth: 1200, matchMedia: () => ({ matches: false }) },
        location, localStorage: storage, sessionStorage: storage,
        fetch: async () => { throw new Error('These component tests must never use the network.'); },
        navigator: {},
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

// A message element with one content element per lane, as the Parallel template renders.
function parallelMessage(laneCount) {
    const lanes = Array.from({ length: laneCount }, (_, index) => ({
        lane: index, matches: selector => selector === '.message-content', querySelectorAll: () => []
    }));
    return {
        lanes,
        matches: () => false,
        querySelector: selector => (selector === '.message-content' ? lanes[0] : null),
        querySelectorAll: selector => (selector === '.message-content' ? lanes : [])
    };
}

test('a finished Parallel message renders the math of every lane, not only the first', async () => {
    const restore = installGlobals();
    try {
        const { default: ChatArea } = await import('../../chat/components/ChatArea.js');
        const rendered = [];
        globalThis.renderMathInElement = root => rendered.push(root);
        try {
            const area = Object.create(ChatArea.prototype);
            const message = parallelMessage(3);
            area.renderMessageMath(message);
            assert.deepEqual(rendered.map(root => root.lane), [0, 1, 2]);
            // A bare content element renders itself once.
            rendered.length = 0;
            area.renderMessageMath(message.lanes[1]);
            assert.deepEqual(rendered.map(root => root.lane), [1]);
            area.renderMessageMath(null);
            assert.equal(rendered.length, 1);
        } finally {
            delete globalThis.renderMathInElement;
        }
    } finally {
        restore();
    }
});

test('every path that paints a whole message uses the per-lane renderer', () => {
    // From the repository root, as test/architecture/uiBoundary does: the
    // release runner bundles tests under /tmp, where import.meta.url no
    // longer points into the repository.
    const source = fs.readFileSync(path.join(process.cwd(), 'chat/components/ChatArea.js'), 'utf8');
    const start = source.indexOf('    async appendMessage(');
    const end = source.indexOf('\n    }\n', source.indexOf('this.renderMessageMath(newMessageEl);', source.indexOf('insertAdjacentHTML', start)));
    const appendMessage = source.slice(start, end);
    assert.ok(appendMessage.length > 500, 'appendMessage located');
    assert.equal((appendMessage.match(/this\.renderMessageMath\(newMessageEl\)/g) || []).length, 3);
    assert.doesNotMatch(appendMessage, /querySelector\('\.message-content'\)/);
});
