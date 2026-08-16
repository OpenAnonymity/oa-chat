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

test('ticket share links stay on the environment and app path that issued them', () => {
    const panel = createPanel();
    delete panel.getTicketCodeShareUrl;
    const code = 'A'.repeat(24);

    assert.equal(
        panel.getTicketCodeShareUrl(code, {
            origin: 'https://oa-billing-demo.vercel.app',
            pathname: '/chat/'
        }),
        `https://oa-billing-demo.vercel.app/chat/?tickets=${code}`
    );
    assert.equal(
        panel.getTicketCodeShareUrl(code, {
            origin: 'https://chat.openanonymity.ai',
            pathname: '/'
        }),
        `https://chat.openanonymity.ai/?tickets=${code}`
    );
});

test('ticket-code redemption errors distinguish used and wrong-environment codes', () => {
    const panel = createPanel();

    assert.equal(
        panel.getTicketCodeRegistrationError(new Error('Code already used')),
        'This ticket code was already redeemed.'
    );
    assert.match(
        panel.getTicketCodeRegistrationError(new Error('Code not found or expired')),
        /different OA environment/
    );
});

test('right panel renders ticket transfer controls only through Membership', () => {
    const source = fs.readFileSync('chat/components/RightPanel.js', 'utf8');
    assert.match(source, /const showLegacyTicketTools = false/);
    assert.match(source, /showGuestAccessCode && this\.showInvitationForm/);
});

test('commercial ticket management replaces right-panel redemption with one compact launcher', () => {
    const source = fs.readFileSync('chat/components/RightPanel.js', 'utf8');
    assert.match(source, /hasExternalTicketManager/);
    assert.match(source, /id="open-ticket-manager-btn"/);
    assert.match(source, /rounded-lg px-0 text-left text-xs/);
    assert.match(source, /Manage inference tickets, \$\{this\.ticketCount\} available/);
    assert.match(source, /this\.app\.openTicketManagement\?\.\(event\.currentTarget\)/);
    assert.match(source, /hasExternalTicketManager \? '' :/);
});

test('commercial ticket launcher keeps a question-mark ticket explanation', () => {
    const source = fs.readFileSync('chat/components/RightPanel.js', 'utf8');
    assert.match(source, /id="toggle-external-ticket-info-btn"/);
    assert.match(source, /aria-controls="external-ticket-info-panel"/);
    assert.match(source, /aria-expanded="\$\{this\.showExternalTicketInfo \? 'true' : 'false'\}"/);
    assert.match(source, /Inference tickets provide unlinkable access to frontier AI models/);
    assert.match(source, /queries go directly to the model provider—not OA/);
    assert.match(source, /this\.updateExternalTicketInfoVisibility\(\)/);
});
