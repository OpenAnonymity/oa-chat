import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { canAnchorSources, setSourcePopover } from '../../chat/ui/sourcePopover.js';
import { revealSources, cancelSourceReveal, isLastSourceResponse } from '../../chat/ui/sourceReveal.js';

// Exercise the actual controller methods without booting auth/wallet services.
const source = fs.readFileSync('chat/app.js', 'utf8');
const start = source.indexOf('    toggleCitations(messageId, pointerType) {');
const end = source.indexOf('    /**\n     * Toggle scrubber', start);
function fixture() {
    const element = () => ({ attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, getAttribute(name) { return this.attrs[name]; } });
    const panel = { getBoundingClientRect: () => ({ height: 0 }) };
    const inner = { ...element(), inert: true, contains: () => false };
    const section = { ...element(), querySelector: s => s === '.t-acc-panel' ? panel : inner };
    const content = { closest: () => section };
    const toggle = { ...element(), focus: options => { toggle.focusOptions = options; } };
    const document = { getElementById: id => id === 'citations-content-test' ? content : id === 'citations-toggle-test' ? toggle : null };
    const Controller = vm.runInNewContext(`(class { ${source.slice(start, end)} })`, { document, console, revealSources, cancelSourceReveal, isLastSourceResponse, canAnchorSources, setSourcePopover });
    const app = new Controller(); app.state = { currentSessionId: 'test-chat' }; app.elements = {}; app.updateScrollButtonVisibility = () => {};
    return { app, toggle, section, inner };
}

test('Sources click and rapid reversal keep cards, chevron and accessible state together', () => {
    const h = fixture();
    for (const opening of [true, false, true, false]) {
        h.app.toggleCitations('test');
        assert.equal(h.toggle.attrs['data-open'], String(opening));
        assert.equal(h.toggle.attrs['aria-expanded'], String(opening));
        assert.equal(h.section.attrs['data-open'], String(opening));
        assert.equal(h.inner.attrs['aria-hidden'], String(!opening));
        assert.equal(h.inner.inert, !opening);
    }
});

test('opening Sources from an inline citation uses the same disclosure state', () => {
    const h = fixture(); h.app.scrollToCitation('test', '1');
    assert.equal(h.toggle.attrs['data-open'], 'true');
    assert.equal(h.toggle.attrs['aria-expanded'], 'true');
    assert.equal(h.inner.inert, false);
    h.app.toggleCitations('test');
    assert.equal(h.toggle.attrs['data-open'], 'false');
});

test('closing a focused source returns focus to the trigger without scrolling', () => {
    const h = fixture(); h.app.setCitationsOpen('test', true);
    h.inner.contains = () => true; h.app.setCitationsOpen('test', false);
    assert.equal(h.toggle.focusOptions.preventScroll, true);
    assert.equal(h.inner.inert, true);
});
