import test from 'node:test';
import assert from 'node:assert/strict';
import { mountZkapiShell } from '../../chat/zkapi/components/ZkapiShell.js';

function fixture() {
    const nodes = new Map();
    const node = id => {
        const value = {
            id, dataset: {}, style: {}, attributes: {}, controls: [], disabled: false,
            classList: { add() {} },
            setAttribute(name, data) { this.attributes[name] = data; },
            querySelectorAll() { return this.controls; },
            remove() { this.removals = (this.removals || 0) + 1; nodes.delete(id); }
        };
        nodes.set(id, value);
        return value;
    };
    const balance = node('account-tab-btn');
    const footer = node('account-nav');
    const panelToggle = node('show-right-panel-btn');
    let moves = 0;
    panelToggle.before = element => { moves += 1; assert.equal(element, balance); };
    const memory = node('memory-context-toggle');
    const settings = node('memory-settings-section');
    settings.controls = [{ disabled: false }];
    const theme = node('theme-toggle');
    const ticketRow = { style: {} };
    const ticketButton = { parentElement: ticketRow, disabled: false };
    const doc = {
        getElementById: id => nodes.get(id) || null,
        querySelectorAll: selector => selector === '[data-action="import-tickets"]' ? [ticketButton] : []
    };
    return { doc, balance, footer, memory, settings, theme, ticketRow, ticketButton, moves: () => moves };
}

test('product shell moves the existing balance button once and removes the inert footer', () => {
    const state = fixture();
    const handler = () => {};
    state.balance.onclick = handler;
    const mounted = mountZkapiShell(state.doc);
    assert.equal(mounted, state.balance);
    assert.equal(state.moves(), 1);
    assert.equal(state.footer.removals, 1);
    assert.equal(state.balance.onclick, handler, 'moving preserves the modal click handler');
    assert.match(state.balance.innerHTML, /data-private-balance-label/);

    state.balance.innerHTML = 'live $2.00 and animated status';
    mountZkapiShell(state.doc);
    assert.equal(state.moves(), 1);
    assert.equal(state.footer.removals, 1);
    assert.equal(state.balance.innerHTML, 'live $2.00 and animated status', 'repeat mount cannot reset live state');
});

test('product-only controls become inaccessible while normal OA settings stay intact', () => {
    const state = fixture();
    mountZkapiShell(state.doc);
    assert.equal(state.memory.disabled, true);
    assert.equal(state.memory.inert, true);
    assert.equal(state.settings.controls[0].disabled, true);
    assert.equal(state.ticketButton.disabled, true);
    assert.equal(state.ticketRow.hidden, true);
    assert.equal(state.theme.disabled, false);
    assert.equal(state.theme.hidden, undefined);
});
