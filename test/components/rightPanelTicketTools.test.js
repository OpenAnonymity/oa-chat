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
        expiresAt: null,
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
    assert.match(source, /text-left text-xs font-medium/);
    assert.match(source, /Inference Tickets: <span class="font-semibold">\$\{this\.ticketCount\}<\/span>/);
    assert.doesNotMatch(source, /id="open-ticket-manager-btn"[\s\S]{0,900}d="m9 18 6-6-6-6"/);
    assert.match(source, /Manage inference tickets, \$\{ticketCount\} available/);
    assert.match(source, /aria-label="\$\{ticketSummary\.ariaLabel\}"/);
    assert.match(source, /this\.app\.openTicketManagement\?\.\(event\.currentTarget\)/);
    assert.match(source, /hasExternalTicketManager \? '' :/);
    assert.match(source, /oa-right-panel-access-stack grid gap-4 p-3/);
    assert.match(source, /oa-right-panel-ticket-summary min-w-0/);
    assert.match(source, /oa-right-panel-access-key min-w-0/);
    assert.doesNotMatch(source, /border-b border-border\/60 pb-3/);
});

test('commercial zero balance is actionable only for an unlocked account', () => {
    const panel = createPanel(0);

    const signedOut = panel.getExternalTicketSummary({});
    assert.equal(signedOut.showGetTickets, false);
    assert.equal(signedOut.ticketCount, 0);
    assert.equal(signedOut.ariaLabel, 'Manage inference tickets, 0 available');

    const signedIn = panel.getExternalTicketSummary({
        accountId: 'account-1',
        sessionVerified: true,
        status: 'unlocked'
    });
    assert.equal(signedIn.showGetTickets, true);
    assert.equal(signedIn.ariaLabel, 'Get inference tickets');
});

test('right-panel rerenders reattach commercial ticket status through the public facade', () => {
    const originalDocument = globalThis.document;
    const calls = [];
    const topSection = { innerHTML: '' };
    const panel = Object.create(RightPanel.prototype);
    panel.app = {
        refreshExtensionSlot(name) {
            calls.push(name);
            return true;
        }
    };
    panel.generateTopSectionHTML = () => '<div>updated</div>';
    panel.attachTopSectionEventListeners = () => {};
    panel.ensureLaneExpirationTimer = () => {};
    globalThis.document = {
        getElementById(id) {
            if (id !== 'right-panel-content') return null;
            return { querySelector: () => topSection };
        }
    };

    try {
        panel.renderTopSectionOnly();
        assert.equal(topSection.innerHTML, '<div>updated</div>');
        assert.deepEqual(calls, ['rightPanel.ticketStatus']);
    } finally {
        globalThis.document = originalDocument;
    }
});

test('commercial ticket launcher keeps a question-mark ticket explanation', () => {
    const source = fs.readFileSync('chat/components/RightPanel.js', 'utf8');
    assert.match(source, /id="toggle-external-ticket-info-btn"/);
    assert.match(source, /h-3\.5 w-3\.5 flex-shrink-0 items-center justify-center rounded-full/);
    assert.match(source, /aria-controls="external-ticket-info-panel"/);
    assert.match(source, /aria-expanded="\$\{this\.showExternalTicketInfo \? 'true' : 'false'\}"/);
    assert.match(source, /Inference tickets provide unlinkable access to frontier AI models/);
    assert.match(source, /queries go directly to the model provider—not OA/);
    assert.match(source, /this\.updateExternalTicketInfoVisibility\(\)/);
});
