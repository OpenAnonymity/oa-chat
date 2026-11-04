import test from 'node:test';
import assert from 'node:assert/strict';

const restore = (() => {
    const keys = ['window', 'localStorage', 'document'];
    const prior = new Map(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const events = { addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { ...events, location: { hostname: 'localhost', origin: 'http://localhost', search: '' }, localStorage: storage } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { ...events, querySelector: () => null, getElementById: () => null, documentElement: { classList: { contains: () => false }, dataset: {} } } });
    return () => { for (const [k, d] of prior) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } };
})();
const { createMessagesFromPayload } = await import('../../chat/services/shareService.js');
restore();

test('imported share messages keep only valid chart artifacts', () => {
    const spec = { chartType: 'line', title: 'T', xLabels: ['a'], series: [{ name: 's', values: [1] }] };
    let n = 0;
    const [good, bad, none] = createMessagesFromPayload([
        { role: 'assistant', content: 'x', artifacts: [{ version: 1, type: 'chart', spec }, { version: 1, type: 'chart', spec: { ...spec, title: 'Second' } }] },
        { role: 'assistant', content: 'y', artifacts: [{ version: 1, type: 'html', source: '<p>' }, 'junk'] },
        { role: 'user', content: 'z' }
    ], 'session-1', () => `id-${++n}`);
    assert.deepEqual(good.artifacts, [{ version: 1, type: 'chart', spec }, { version: 1, type: 'chart', spec: { ...spec, title: 'Second' } }]);
    assert.equal(good.sessionId, 'session-1');
    assert.equal('artifacts' in bad, false);
    assert.equal('artifacts' in none, false);
});
