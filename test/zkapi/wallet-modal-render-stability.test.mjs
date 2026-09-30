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

