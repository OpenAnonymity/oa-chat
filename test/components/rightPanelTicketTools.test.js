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
    assert.match(source, /class="system-panel-ticket-trigger"/);
    assert.match(source, /Inference Tickets: <span class="font-semibold">\$\{this\.ticketCount\}<\/span>/);
    assert.doesNotMatch(source, /id="open-ticket-manager-btn"[\s\S]{0,900}d="m9 18 6-6-6-6"/);
    assert.match(source, /Manage inference tickets, \$\{ticketCount\} available/);
    assert.match(source, /aria-label="\$\{ticketSummary\.ariaLabel\}"/);
    assert.match(source, /this\.app\.openTicketManagement\?\.\(event\.currentTarget\)/);
    assert.match(source, /hasExternalTicketManager \? '' :/);
    assert.match(source, /class="oa-right-panel-access-stack"/);
    assert.match(source, /class="system-panel-divider" aria-hidden="true"/);
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
    assert.match(source, /class="system-panel-help"/);
    assert.match(source, /aria-controls="external-ticket-info-panel"/);
    assert.match(source, /aria-expanded="\$\{this\.showExternalTicketInfo \? 'true' : 'false'\}"/);
    assert.match(source, /Inference tickets provide unlinkable access to frontier AI models/);
    assert.match(source, /queries go directly to the model provider—not OA/);
    assert.match(source, /this\.updateExternalTicketInfoVisibility\(\)/);
});

function createRenderPanel(ticketCount = 100, accountState = {}) {
    const panel = createPanel(ticketCount);
    panel.app.hasTicketManagementAction = () => true;
    panel.app.services.account = { getState: () => accountState };
    panel.hasAnyAccessKey = () => Boolean(panel.apiKey);
    panel.getCouncilAccessRows = () => [];
    panel.getTicketCodeShareUrl = () => null;
    panel.generateProxySectionHTML = () => '';
    panel.escapeHtml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    panel.getKeyDisplayInfo = () => ({ displayMask: 'masked-key', hoverContentHtml: null });
    panel.getSharedKeyCount = () => 1;
    return panel;
}

test('commercial layout renders live counts, one divider and pending key details', () => {
    const panel = createRenderPanel();
    const html = panel.generateTopSectionHTML();
    assert.match(html, /system-panel-ticket-count">100<\/span>/);
    assert.match(html, /aria-label="Manage inference tickets, 100 available"/);
    assert.equal((html.match(/class="system-panel-divider"/g) || []).length, 1);
    assert.ok(html.indexOf('open-ticket-manager-btn') < html.indexOf('system-panel-divider'));
    assert.ok(html.indexOf('system-panel-divider') < html.indexOf('system-panel-key-heading'));
    assert.match(html, /Requested on message send/);
    assert.match(html, /To be assigned/);
    assert.match(html, /data-oa-extension-slot="rightPanel.ticketStatus"/);
    assert.equal((html.match(/id="verifier-attestation-btn"/g) || []).length, 1);
    assert.doesNotMatch(html, /id="renew-key-btn"/);

    panel.ticketCount = 987654;
    panel.showExternalTicketInfo = true;
    const updated = panel.generateTopSectionHTML();
    assert.match(updated, /system-panel-ticket-count">987654<\/span>/);
    assert.match(updated, /aria-expanded="true"/);
    assert.match(updated, /id="external-ticket-info-panel"[\s\S]*?aria-hidden="false"/);
});

test('commercial zero balance and active-key controls survive the layout change', () => {
    const panel = createRenderPanel(0, { accountId: 'account-1', sessionVerified: true, status: 'unlocked' });
    panel.apiKey = 'fixture-key';
    panel.apiKeyInfo = { stationId: 'fixture-station' };
    panel.timeRemaining = '02:00';
    const html = panel.generateTopSectionHTML();
    assert.match(html, /aria-label="Get inference tickets"/);
    assert.match(html, /system-panel-row-label">Get tickets<\/span>/);
    assert.match(html, /id="renew-key-btn"/);
    assert.match(html, /id="api-key-expiry"/);
    assert.match(html, /masked-key/);
    assert.match(html, /fixture-station/);
    assert.match(html, /02:00/);
    panel.isRenewingKey = true;
    assert.match(panel.generateTopSectionHTML(), /id="renew-key-btn"[\s\S]*?disabled\s*>/);
});

test('parallel keys retain per-lane attestation without a duplicate header control', () => {
    const panel = createRenderPanel();
    panel.maskCouncilAccessToken = () => 'masked-lane-key';
    panel.escapeHtmlAttribute = panel.escapeHtml;
    panel.getAccessExpiryClasses = () => '';
    panel.getAccessExpiryLabel = () => '02:00';
    const html = panel.generateCouncilAccessKeyPanelHTML([
        { id: 'lane-1', label: 'First model', access: { apiKey: 'fixture-key' } },
        { id: 'lane-2', label: 'Second model', access: null }
    ], { embedded: true });
    assert.match(html, /system-panel-row-label">Ephemeral Access Keys<\/span>/);
    assert.match(html, /data-council-attestation-lane="lane-1"/);
    assert.match(html, /Requested on message send/);
    assert.doesNotMatch(html, /id="verifier-attestation-btn"/);
    assert.doesNotMatch(panel.generateAccessKeyHeading('<unsafe>'), /<unsafe>/);
});

test('System Panel layout uses requested dimensions with theme and keyboard support', () => {
    const css = fs.readFileSync('chat/styles.css', 'utf8');
    assert.match(css, /\.system-panel-header \{[^}]*padding: 14px 12px 10px;/);
    assert.match(css, /\.system-panel-header h2 \{[^}]*font: 600 17px\/1\.2 var\(--font-sans\)/);
    assert.match(css, /\.system-panel-row \{[^}]*gap: 10px;[^}]*height: 32px;/);
    assert.match(css, /\.system-panel-row-icon \{[^}]*width: 18px;[^}]*height: 18px;/);
    assert.match(css, /\.system-panel-ticket-count \{[^}]*font-variant-numeric: tabular-nums;/);
    assert.match(css, /\.system-panel-divider \{[^}]*margin: 12px 0;[^}]*var\(--color-border\)/);
    assert.match(css, /\.system-panel-help:focus-visible/);
    assert.match(css, /\.system-panel-close:focus-visible/);
});
