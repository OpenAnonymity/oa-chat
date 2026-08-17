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
    assert.match(context, /registerTicketManagement/);
    assert.doesNotMatch(context, /getTickets\(|peekTicket|finalized_ticket|signature|nonce/);
});

test('public HTML keeps Account and contains only invisible generic extension hosts', () => {
    const html = read('chat/index.html');
    const accountIndex = html.indexOf('id="account-tab-btn"');
    const sidebarSlotIndex = html.indexOf('data-oa-extension-slot="sidebar.accountActions"');
    assert.ok(accountIndex >= 0, 'public Account button must remain present');
    assert.ok(sidebarSlotIndex > accountIndex, 'sidebar slot must immediately follow Account');
    assert.match(html, /id="account-settings-btn"[^>]+aria-haspopup="menu"/);
    assert.match(html, /id="account-settings-menu"[^>]+role="menu"[^>]+hidden/);
    assert.match(html, /data-oa-extension-slot="account\.menuActions" hidden/);
    assert.match(html, /data-oa-extension-slot="sidebar\.accountActions" hidden/);
    assert.match(html, /data-oa-extension-slot="modalLayer" hidden/);
    assert.doesNotMatch(html, /upgrade-tab-btn|billing-modal|Upgrade with Stripe|subscription status/i);
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
    assert.match(panel, /extensionSlots\?\.refresh\?\.\(SLOT_NAMES\.RIGHT_PANEL_TICKET_STATUS\)/);
    assert.doesNotMatch(panel, /Payment received|private tickets ready|Checkout canceled/);
});

test('commercial account slot is omitted from account creation and recovery flows', () => {
    const source = read('chat/components/AccountModal.js');
    assert.match(source, /if \(dialog && !isCreationFlow && !isRecoveryFlow\)/);
});

test('custom builds constrain output deletion and support extension-owned assets', () => {
    const source = read('scripts/build.mjs');
    assert.match(source, /--out-dir must be a child directory/);
    assert.match(source, /path\.relative\(workingDirectory, outDir\)/);
    assert.match(source, /existing custom directory that was not created by this build helper/);
    assert.match(source, /\.oa-chat-build-output/);
    for (const extension of ['png', 'jpg', 'svg', 'woff', 'woff2', 'ttf']) {
        assert.match(source, new RegExp(`'\\.${extension}': 'file'`));
    }
});
