import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('public API exposes only the documented application factory and constants', () => {
    const source = read('chat/publicApi.js');
    assert.match(source, /export \{ createChatApp \}/);
    assert.match(source, /EXTENSION_API_VERSION/);
    assert.match(source, /SLOT_NAMES/);
    assert.doesNotMatch(source, /\bChatApp\b|ExtensionHost|ExtensionSlotRegistry|accountService|ticketStore/);
});

test('standalone public startup injects no extensions', () => {
    const source = read('chat/standalone.js');
    assert.match(source, /createChatApp\(\)/);
    assert.doesNotMatch(source, /extensions\s*:/);
});

test('core startup never awaits optional extension mounting', () => {
    const source = read('chat/app.js');
    assert.match(source, /void this\.extensionHost\.mountAll/);
    assert.doesNotMatch(source, /await this\.extensionHost\.mountAll/);
});

test('commercial extensions receive redacted ticket-count updates without wallet records', () => {
    const source = read('chat/app.js');
    const contextStart = source.indexOf('createExtensionContext()');
    const contextEnd = source.indexOf('detectInitialLinkContext()', contextStart);
    const context = source.slice(contextStart, contextEnd);

    assert.match(context, /tickets:\s*Object\.freeze/);
    assert.match(context, /window\.addEventListener\('tickets-updated', notify\)/);
    assert.match(context, /accountService\.subscribe\(notify\)/);
    assert.match(context, /storageManager\.init\(\)\.then/);
    assert.match(context, /if \(!active \|\| !ready\) return/);
    assert.match(context, /getMembershipTicketToolsSnapshot/);
    assert.match(context, /toExtensionTicketSnapshot/);
    assert.match(context, /publishPreparedTicketUpdate/);
    assert.match(context, /releasePreparedTicketPublication/);
    assert.match(context, /registerTicketManagement/);
    assert.match(context, /registerShortageHandler/);
    assert.match(source, /toExtensionTicketShortage/);
    assert.match(context, /closeAccount:\s*\(\) => this\.accountModal\?\.handleCloseAttempt\?\.\(\)/);
    assert.match(source, /return Object\.freeze\(\{ publicKey: data\.public_key, keyId: computedKeyId \}\);\s*\}\s*registerTicketManagementAction/);
    assert.match(source, /Object\.hasOwn\(data, 'key_id'\) && advertisedKeyId !== computedKeyId/);
    assert.doesNotMatch(context, /getTickets\(|peekTicket|finalized_ticket|signature|nonce/);
});

test('paid preparation publishes the aggregate ticket count only after durable completion', () => {
    const preparer = read('chat/application/entitlementTicketPreparer.js');
    const store = read('chat/services/ticketStore.js');

    assert.match(preparer, /emitUpdate:\s*false/);
    assert.match(preparer, /skipBroadcast:\s*true/);
    assert.match(preparer, /skipSync:\s*true/);
    assert.match(preparer, /ticketUpdateDeferred:\s*true/);
    assert.match(preparer, /pending\.phase = 'ready-to-publish'/);
    const publicationStart = preparer.indexOf('async publishPreparedTicketUpdate(result)');
    assert.ok(publicationStart >= 0);
    assert.ok(
        preparer.indexOf('this.ticketStore.addTickets(missingTickets', publicationStart) > publicationStart,
        'staged ticket material must enter the live wallet only through the explicit publication seam'
    );
    assert.match(preparer, /expectedAccountId/);
    assert.match(preparer, /oa-entitlement-publication-v1/);
    assert.match(preparer, /publicationObserved:\s*true/);
    assert.match(store, /publishUpdate\(options = \{\}\)/);
    assert.match(store, /Object\.hasOwn\(options, 'expectedAccountId'\)/);
});

test('public HTML keeps Account and contains only invisible generic extension hosts', () => {
    const html = read('chat/index.html');
    const accountIndex = html.indexOf('id="account-tab-btn"');
    const sidebarSlotIndex = html.indexOf('data-oa-extension-slot="sidebar.accountActions"');
    assert.ok(accountIndex >= 0, 'public Account button must remain present');
    assert.ok(sidebarSlotIndex > accountIndex, 'sidebar slot must immediately follow Account');
    assert.doesNotMatch(html, /id="account-settings-btn"/);
    assert.match(html, /id="account-tab-btn"[\s\S]*account-control-icon/);
    assert.match(html, /id="account-tab-btn"[^>]+data-status="loading"[^>]+aria-busy="true"/);
    assert.doesNotMatch(html, /id="account-tab-btn"[^>]+disabled/);
    assert.match(html, /id="account-identity-label"[^>]*><\/span>/);
    assert.match(html, /id="account-bootstrap-status"[^>]+role="status"[^>]*>Restoring account<\/span>/);
    assert.match(html, /class="account-control-icon"[^>]+stroke-width="1\.8"[^>]+stroke-linecap="round"[^>]+stroke-linejoin="round"[^>]*>[\s\S]*?<path d="m6 9 6 6 6-6"/);
    assert.doesNotMatch(html, /account-control-icon[\s\S]{0,250}M10\.343 3\.94/);
    assert.match(html, /id="account-settings-menu"[^>]+role="menu"[^>]+hidden/);
    assert.doesNotMatch(html, /account-menu-separator/);
    assert.match(html, /placeholder="Search chats\.\.\."/);
    assert.match(html, /class="session-scroll-shell[^\"]*"[\s\S]*id="sessions-scroll-area"[\s\S]*class="session-scroll-fade"/);
    assert.doesNotMatch(html, /maximum-scale|user-scalable/);
    assert.match(html, /data-oa-extension-slot="account\.menuActions" hidden/);
    assert.match(html, /data-oa-extension-slot="sidebar\.accountActions" hidden/);
    assert.match(html, /data-oa-extension-slot="modalLayer" hidden/);
    assert.doesNotMatch(html, /upgrade-tab-btn|billing-modal|Upgrade with Stripe|subscription status/i);
});

test('account footer keeps stable full-row trigger and menu dimensions', () => {
    const styles = read('chat/styles.css');
    assert.match(styles, /\.account-nav\s*\{[^}]*padding:\s*0;/s);
    assert.match(styles, /\.account-tab-btn\s*\{[^}]*min-height:\s*3rem;[^}]*padding:\s*0\.25rem 1rem;[^}]*border:\s*0;[^}]*border-radius:\s*0;/s);
    assert.doesNotMatch(styles, /@media \(any-pointer: coarse\)\s*\{\s*\.account-tab-btn/);
    assert.match(styles, /\.account-tab-avatar\s*\{[^}]*width:\s*1\.75rem;[^}]*height:\s*1\.75rem;/s);
    assert.match(styles, /\.sidebar-main-content\s*\{[^}]*padding-bottom:\s*3\.5rem !important;/s);
    assert.match(styles, /\.account-settings-menu\s*\{[^}]*right:\s*0\.5rem;[^}]*left:\s*0\.5rem/s);
    assert.match(styles, /\.account-menu-item\s*\{[^}]*min-height:\s*2\.625rem/s);
    assert.match(styles, /\.account-tab-btn\[data-status="loading"\]\s*\{[^}]*cursor:\s*wait/s);
    assert.match(styles, /\.account-tab-btn:hover:not\(:disabled\)\s*\{/);
    assert.match(styles, /\.account-tab-btn:active:not\(:disabled\)\s*\{/);
    const pressedRow = styles.match(/\.account-tab-btn:active:not\(:disabled\)\s*\{([^}]+)\}/)?.[1];
    assert.match(pressedRow, /background-color: hsl\(var\(--color-foreground\) \/ 0\.14\)/);
    assert.doesNotMatch(pressedRow, /transform/);
    assert.match(styles, /\.account-control-icon\s*\{[^}]*transform-origin:\s*center;[^}]*transform 240ms cubic-bezier\(\.2, 0, 0, 1\)/s);
    assert.match(styles, /\.account-tab-btn\[aria-expanded="true"\] \.account-control-icon\s*\{[^}]*transform:\s*rotate\(180deg\)/s);
    assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.account-control-icon\s*\{\s*transition:\s*none/s);
});

test('signed-in Account uses the compact identity and disclosure treatment', () => {
    const styles = read('chat/styles.css');
    const accountModal = read('chat/components/AccountModal.js');
    assert.match(styles, /\.account-compact-dialog\s*\{[^}]*max-width:\s*23rem[^}]*padding:\s*1rem/s);
    assert.match(styles, /\.account-compact-row:hover:not\(:disabled\)\s*\{[^}]*background:/s);
    assert.match(styles, /\.account-compact-row:active:not\(:disabled\)\s*\{[^}]*transform:\s*scale\(0\.985\)/s);
    assert.match(styles, /\.account-compact-chevron\s*\{[^}]*width:\s*1\.125rem;[^}]*height:\s*1\.125rem;[^}]*transition:\s*transform 240ms cubic-bezier\(\.2, 0, 0, 1\)/s);
    assert.match(styles, /\.account-compact-row\[aria-expanded="true"\] \.account-compact-chevron\s*\{[^}]*rotate\(180deg\)/s);
    assert.match(styles, /\.account-compact-detail\s*\{[^}]*grid-template-rows:\s*0fr;[^}]*opacity:\s*0;[^}]*grid-template-rows 240ms cubic-bezier\(\.2, 0, 0, 1\)/s);
    assert.match(styles, /\.account-compact-detail\[data-open="true"\]\s*\{[^}]*grid-template-rows:\s*1fr;[^}]*opacity:\s*1/s);
    assert.match(styles, /\.account-compact-detail-clip\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden/s);
    assert.match(accountModal, /id="account-passkey-details-btn"[^>]+aria-expanded="\$\{this\.passkeyDetailsOpen\}"/);
    assert.match(accountModal, /class="account-compact-chevron"[^>]+viewBox="0 0 24 24"[^>]+stroke-linecap="round"[^>]+stroke-linejoin="round"[^>]*><path d="m6 9 6 6 6-6"/);
    assert.match(accountModal, /id="account-clear-btn" class="account-compact-row"/);
});

test('session history ends above the account row with an intentional continuation cue', () => {
    const styles = read('chat/styles.css');
    const sidebar = read('chat/components/Sidebar.js');
    assert.match(styles, /\.session-scroll-fade\s*\{[^}]*linear-gradient/s);
    assert.match(styles, /\.session-scroll-fade\s*\{[^}]*backdrop-filter:\s*blur\(2px\)/s);
    assert.match(styles, /\.session-scroll-fade\s*\{[^}]*mask-image:\s*linear-gradient/s);
    assert.match(styles, /\.session-list-end-spacer\s*\{[^}]*height:\s*40px/s);
    assert.match(styles, /\.session-scroll-shell\.has-more-below \.session-scroll-fade\s*\{[^}]*opacity:\s*1/s);
    assert.doesNotMatch(styles, /\.session-initially-clipped/);
    assert.match(sidebar, /const END_SPACER_HEIGHT = 40/);
    assert.match(sidebar, /scheduleInitialViewportSettlement/);
    assert.match(sidebar, /releaseInitialViewportSettlement/);
    assert.doesNotMatch(sidebar, /session-initially-clipped/);
    assert.match(sidebar, /items\.push\(\{ type: 'end-spacer' \}\)/);
    assert.match(sidebar, /class="session-list-end-spacer" aria-hidden="true"/);
});

test('public UI and startup have no billing presentation dependency', () => {
    const ui = read('chat/ui/vanilla/VanillaChatUi.js');
    const appInterface = read('chat/ui/appInterface.js');
    assert.doesNotMatch(ui, /BillingModal|billingClient|services\.billing/);
    assert.doesNotMatch(appInterface, /billingModal|\bbilling\b/);
    assert.equal(fs.existsSync(path.join(root, 'chat/components/BillingModal.js')), false);
    assert.equal(fs.existsSync(path.join(root, 'chat/services/billingClient.js')), false);
});

test('empty extension hosts have no visible footprint', () => {
    const styles = read('chat/styles.css');
    assert.match(styles, /\[data-oa-extension-slot\]\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('the right-panel ticket status is an invisible generic extension slot', () => {
    const host = read('chat/extensions/extensionHost.js');
    const panel = read('chat/components/RightPanel.js');
    assert.match(host, /RIGHT_PANEL_TICKET_STATUS:\s*'rightPanel\.ticketStatus'/);
    assert.match(panel, /data-oa-extension-slot="\$\{SLOT_NAMES\.RIGHT_PANEL_TICKET_STATUS\}" hidden/);
    assert.match(panel, /refreshExtensionSlot\?\.\(SLOT_NAMES\.RIGHT_PANEL_TICKET_STATUS\)/);
    assert.doesNotMatch(panel, /extensionSlots/);
    assert.doesNotMatch(panel, /Payment received|private tickets ready|Checkout canceled/);
});

test('commercial account slot is omitted from account creation and recovery flows', () => {
    const source = read('chat/components/AccountModal.js');
    assert.match(source, /dialog &&[\s\S]*!isCreationFlow &&[\s\S]*this\.recoveryStep === 'idle' &&[\s\S]*state\.authBootstrapComplete !== false/);
});
