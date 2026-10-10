import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual controller methods without booting auth/wallet services.
const source = fs.readFileSync('chat/app.js', 'utf8');
const start = source.indexOf('    toggleCitations(messageId) {');
const end = source.indexOf('    /**\n     * Toggle scrubber', start);
function fixture() {
    const attrs = {}, classes = new Set(['hidden']);
    const content = { classList: { contains: name => classes.has(name), remove: name => classes.delete(name),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name) } };
    const toggle = { setAttribute: (name, value) => { attrs[name] = value; } };
    const document = { getElementById: id => id === 'citations-content-test' ? content : id === 'citations-toggle-test' ? toggle : null };
    const Controller = vm.runInNewContext(`(class { ${source.slice(start, end)} })`, { document, console });
    const app = new Controller(); app.updateScrollButtonVisibility = () => {};
    return { app, attrs, classes };
}

test('Sources click and rapid reversal keep the chevron and accessible state together', () => {
    const h = fixture();
    for (const opening of [true, false, true, false]) {
        h.app.toggleCitations('test');
        assert.equal(h.attrs['data-open'], String(opening));
        assert.equal(h.attrs['aria-expanded'], String(opening));
        assert.equal(h.classes.has('hidden'), !opening);
    }
});

test('opening Sources from an inline citation updates the same chevron state', () => {
    const h = fixture(); h.app.scrollToCitation('test', '1');
    assert.equal(h.attrs['data-open'], 'true');
    assert.equal(h.attrs['aria-expanded'], 'true');
    assert.equal(h.classes.has('hidden'), false);
    h.app.toggleCitations('test');
    assert.equal(h.attrs['data-open'], 'false');
});
