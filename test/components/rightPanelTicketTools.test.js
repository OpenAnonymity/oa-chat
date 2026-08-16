import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import RightPanel from '../../chat/components/RightPanel.js';

function createPanel(ticketCount = 5) {
    const panel = Object.create(RightPanel.prototype);
    panel.ticketCount = ticketCount;
    panel.isImporting = false;
    panel.isSplitting = false;
    panel.isRegistering = false;
    panel.renderTopSectionOnly = () => {};
    panel.loadNextTicket = () => {};
    panel.getTicketCodeShareUrl = code => `https://chat.example/tickets/${code}`;
    panel.app = {
        services: {
            tickets: {
                getTicketCount: () => panel.ticketCount,
                async splitTickets(count) {
                    panel.ticketCount -= count;
                    return { code: 'A'.repeat(24), ticketsConsumed: count };
                }
            }
        },
        showToast() {}
    };
    return panel;
}

test('membership ticket snapshot exposes counts and no wallet material', () => {
    const snapshot = createPanel(7).getMembershipTicketToolsSnapshot();
    assert.deepEqual(snapshot, {
        ticketCount: 7,
        maxShareCount: 7,
        busy: false
    });
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal('tickets' in snapshot, false);
    assert.equal('accountId' in snapshot, false);
});

test('membership share reuses split behavior and returns only the share result', async () => {
    const panel = createPanel(5);
    const result = await panel.splitTicketsForMembership(3);

    assert.deepEqual(result, {
        code: 'A'.repeat(24),
        ticketsConsumed: 3,
        shareUrl: `https://chat.example/tickets/${'A'.repeat(24)}`
    });
    assert.equal(panel.ticketCount, 2);
    await assert.rejects(() => panel.splitTicketsForMembership(3), /at most 2 tickets/);
});

test('right panel renders ticket transfer controls only through Membership', () => {
    const source = fs.readFileSync('chat/components/RightPanel.js', 'utf8');
    assert.match(source, /const showLegacyTicketTools = false/);
    assert.match(source, /showGuestAccessCode && this\.showInvitationForm/);
});
