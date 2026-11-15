import test from 'node:test';
import assert from 'node:assert/strict';
import AccountModal from '../../chat/zkapi/components/AccountModal.js';

// A button replaced between pointerdown and pointerup receives no click.
// Background refreshes used to rebuild the dialog under the press, so the
// first Continue after a reload was lost.
function modalWith(extra = {}) {
    const modal = Object.create(AccountModal.prototype);
    let writes = 0;
    const overlay = { firstElementChild: {}, querySelector: () => null, querySelectorAll: () => [],
        get innerHTML() { return this.html || ''; }, set innerHTML(value) { writes++; this.html = value; } };
    Object.assign(modal, { overlay, view: 'withdraw', isOpen: false, ...extra });
    return { modal, writes: () => writes };
}

test('a render during a press waits for the press to land', () => {
    const { modal, writes } = modalWith({ pointerPressed: true });
    modal.dialogMarkup = () => assert.fail('nothing is built while a press is down');
    modal.render();
    assert.equal(writes(), 0);
    assert.equal(modal.renderDeferred, true);
});

test('a render that would draw the same markup keeps the live nodes', () => {
    const { modal, writes } = modalWith({ renderedMarkup: '<div>same</div>' });
    modal.dialogMarkup = () => '<div>same</div>';
    modal.rememberRunningModal = () => {};
    modal.render();
    assert.equal(writes(), 0, 'focus, hover and typed text stay on the existing nodes');
});


// Transitions.dev "Card resize": a render that changes the dialog's height
// glides from the old height instead of jumping.
function glideModal({ height, reduced = false }) {
    const animations = [];
    const scroll = { style: {} };
    const panel = { getBoundingClientRect: () => ({ height }), querySelector: () => scroll,
        animate(frames, options) { const glide = { frames, options }; animations.push(glide); return glide; } };
    const modal = Object.create(AccountModal.prototype);
    modal.overlay = { querySelector: selector => selector === '.zkapi-dialog' ? panel : null };
    const previous = globalThis.window;
    globalThis.window = { matchMedia: () => ({ matches: reduced }) };
    return { modal, animations, scroll, restore: () => { globalThis.window = previous; } };
}

test('a render that changes the dialog height glides from the old height', () => {
    const f = glideModal({ height: 620 });
    try {
        f.modal.glideDialogHeight(440);
        assert.equal(f.animations.length, 1);
        assert.deepEqual(f.animations[0].frames, [{ height: '440px' }, { height: '620px' }]);
        assert.equal(f.animations[0].options.easing, 'cubic-bezier(0.22, 1, 0.36, 1)');
        assert.equal(f.scroll.style.overflowY, 'hidden', 'no scrollbar flashes mid-glide');
        f.animations[0].onfinish();
        assert.equal(f.scroll.style.overflowY, '');
    } finally { f.restore(); }
});

for (const [name, options, from] of [['same height', { height: 440 }, 441], ['first render', { height: 440 }, 0], ['reduced motion', { height: 620, reduced: true }, 440]]) {
    test(`no glide for ${name}`, () => {
        const f = glideModal(options);
        try {
            f.modal.glideDialogHeight(from);
            assert.equal(f.animations.length, 0);
        } finally { f.restore(); }
    });
}
