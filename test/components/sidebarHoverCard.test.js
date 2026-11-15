import test from 'node:test';
import assert from 'node:assert/strict';
import Sidebar from '../../chat/components/Sidebar.js';

function fixture(scrollWidth) {
    const card = { hidden: true, style: {}, offsetHeight: 50 };
    const input = { value: 'Weekend plans', readOnly: true, clientWidth: 200, scrollWidth };
    const row = {
        isConnected: true,
        dataset: { sessionId: 'one' },
        querySelector: () => input,
        getBoundingClientRect: () => ({ top: 100, height: 36 }),
        ownerDocument: { defaultView: { innerHeight: 800 } }
    };
    const sidebar = Object.create(Sidebar.prototype);
    Object.assign(sidebar, {
        app: {
            elements: { sidebar: { getBoundingClientRect: () => ({ right: 280 }) } },
            state: { sessionsById: new Map([['one', { updatedAt: Date.now() - 3 * 86400000 }]]) }
        },
        hoverCard: card,
        hoverCardRow: row,
        escapeHtml: title => title
    });
    return { sidebar, card, row, input };
}

for (const [description, width] of [['fully visible', 200], ['clipped', 400]]) {
    test(`a ${description} title shows its hover card and activity time`, () => {
        const { sidebar, card, row } = fixture(width);
        sidebar.showHoverCard(row);
        assert.equal(card.hidden, false);
        assert.match(card.innerHTML, /Weekend plans/);
        assert.match(card.innerHTML, /3d ago/);
    });
}

test('fully visible titles still suppress hover cards during renaming or an open menu', () => {
    const { sidebar, card, row, input } = fixture(200);
    input.readOnly = false;
    sidebar.showHoverCard(row);
    assert.equal(card.hidden, true);
    input.readOnly = true;
    sidebar.floatingMenu = {};
    sidebar.showHoverCard(row);
    assert.equal(card.hidden, true);
});
