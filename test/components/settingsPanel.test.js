import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The build copies the test tree to a temp directory before running it, so
// resolve from the working directory (the repo root), like the other
// source-reading tests, never from this file's own location.
const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function settingsPanel(html) {
    const start = html.indexOf('<div id="settings-menu"');
    const end = html.indexOf('<!-- Search Toggle -->');
    assert.ok(start > -1 && end > start);
    return html.slice(start, end);
}

test('the composer gear button is unchanged by the settings panel redesign', () => {
    const html = read('chat/index.html');
    assert.match(html, /<button id="settings-btn" class="composer-more-menu-item" role="menuitem" aria-label="Settings" data-tooltip="Settings" data-tooltip-position="top">/);
    // Heroicons cog-6-tooth: the gear outline and its hub.
    assert.match(html, /id="settings-btn"[\s\S]{0,600}M10\.343 3\.94c\.09-\.542\.56-\.94 1\.11-\.94h1\.093/);
    assert.match(html, /id="settings-btn"[\s\S]{0,3000}M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z/);
    assert.ok(html.indexOf('id="settings-btn"') < html.indexOf('id="settings-menu"'));
});

function settingsDialog(html) {
    const start = html.indexOf('<div id="settings-dialog"');
    const end = html.indexOf('<template id="settings-delete-account-template">');
    assert.ok(start > -1 && end > start);
    return html.slice(start, end);
}

test('the gear leads with what is set once — Appearance, Data controls, feedback — then Privacy, Memory, Tools', () => {
    const html = read('chat/index.html');
    const panel = settingsPanel(html);
    assert.match(panel, /class="hidden z-\[100\] settings-panel settings-menu-glass" role="group" aria-label="Settings"/);
    const titles = [...panel.matchAll(/class="settings-section-title">([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(titles, ['Appearance', 'Data controls', 'Privacy', 'Memory', 'Tools']);
    const labels = [...panel.matchAll(/settings-row-label"[^>]*>([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(labels, [
        'Layout', 'Font', 'Theme',
        'All', 'Chat history', 'ChatGPT', 'Memories',
        'Share feedback',
        'Scrubber model',
        'Memory', 'Always attach retrieval', 'Memory model',
        'Web search', 'Council review', 'Council model', 'Effort'
    ]);
    // Memory export/import work whether Memory is on or off: the memories
    // are the person's data either way.
    assert.doesNotMatch(panel, /data-memory-requires-feature/);
    const editor = read('chat/components/MemoryEditor.js');
    assert.match(editor, /async _handleExport\(\) \{[\s\S]*?_beginMemoryOperation\(\{ allowWhileOff: true \}\)/);
    assert.match(editor, /async importMemoryFile\(file\) \{[\s\S]*?this\.open\(\{ allowWhileOff: true \}\)[\s\S]*?_beginMemoryOperation\(\{ allowWhileOff: true \}\)/);
    const input = read('chat/components/ChatInput.js');
    for (const fn of ['handleExportMemory', 'handleImportMemory', 'processMemoryImportFile']) {
        const body = input.slice(input.indexOf(`${fn}(`), input.indexOf('\n    }\n', input.indexOf(`${fn}(`)));
        assert.doesNotMatch(body, /memoryFeatureEnabled === false/, `${fn} does not gate on the toggle`);
    }
    assert.match(panel, /<input type="file" id="tickets-import-input"/);
    // Export / Import are text actions; the pickers' file inputs sit beside them, once.
    for (const action of ['export-all-data', 'import-data', 'export-chats', 'import-history', 'export-memory', 'import-memory']) {
        assert.match(panel, new RegExp(`<button type="button" data-action="${action}"[^>]*class="settings-text-action"`), action);
    }
    for (const id of ['global-import-input', 'memory-import-input']) {
        assert.match(panel, new RegExp(`<input type="file" id="${id}"`), id);
        assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} exists once`);
    }
    // Appearance keeps its ids, so ChatInput binds the controls unchanged.
    for (const id of ['flat-mode-toggle', 'font-mode-toggle', 'theme-toggle', 'theme-effective-label']) {
        assert.match(panel, new RegExp(`id="${id}"`), id);
        assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} exists once`);
    }
    assert.match(panel, /data-mode="flat"[^>]*>Document</);
    assert.match(panel, /data-mode="bubble"[^>]*>Bubbles</);
    // Light / Dark / System everywhere. zkAPI's purple is not a fourth
    // option: it is what Light means while a chat pays with zkAPI
    // (html.zkapi-mode), and Dark there is its night complement.
    for (const option of ['system', 'light', 'dark']) {
        assert.match(panel, new RegExp(`data-theme-option="${option}"`), option);
    }
    assert.doesNotMatch(panel, /data-theme-option="purple"/);
    assert.doesNotMatch(html, /theme-purple/);
    assert.match(panel, /<section class="settings-section settings-section-feedback" aria-label="Feedback">\s*<a href="https:\/\/forms\.gle\/HEmvxnJpN1jQC7CfA" target="_blank" rel="noopener noreferrer" class="settings-row settings-link">/);
    // The gear's data actions run through SettingsDialog without a card in between.
    const dialogSource = read('chat/components/SettingsDialog.js');
    assert.match(dialogSource, /handleDataClick\(event\)/);
    for (const action of ['export-all-data', 'export-chats', 'export-memory', 'import-data', 'import-memory', 'import-history']) {
        assert.match(dialogSource, new RegExp(`case '${action}':`), `${action} handled from the gear`);
    }
});

test('what stays account-bound: Delete account, reached from Billing, into its confirmation', () => {
    const html = read('chat/index.html');
    const dialog = settingsDialog(html);
    assert.match(dialog, /<div id="settings-dialog" class="hidden fixed inset-0 z-50 bg-black\/60 backdrop-blur-sm flex items-center justify-center p-4">/);
    assert.match(dialog, /<div role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" tabindex="-1" class="settings-dialog settings-panel">/);
    // Nothing set-once is left here: no data rows, no appearance, no feedback.
    assert.doesNotMatch(dialog, /Data controls|Appearance|Share feedback|>All<|theme-toggle|global-import-input/);
    const labels = [...dialog.matchAll(/settings-row-label"[^>]*>([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(labels, ['Log out', 'Delete your account']);
    for (const action of ['log-out', 'delete-account']) {
        assert.match(dialog, new RegExp(`<button type="button" data-action="${action}"[^>]*class="settings-button`), action);
    }
    assert.match(dialog, /data-action="delete-account" class="settings-button settings-button-danger">Delete</);
    // The confirmation card: one sentence on what goes, cancel first.
    assert.match(html, /<template id="settings-delete-account-template">[\s\S]*Are you sure you want to delete your account\?[\s\S]*After deleting, all of your information will be lost[\s\S]*data-delete-account="cancel"[\s\S]*data-delete-account="confirm"[^>]*>Delete account</);
    // The account menu: the preferences item that opened this dialog is gone
    // (the core security item, also labelled Account, is a different route).
    // Deletion is a row in the commercial Billing dialog, reached through the
    // extension context.
    const menu = html.slice(html.indexOf('id="account-settings-menu"'), html.indexOf('data-oa-extension-slot="sidebar.accountActions"'));
    assert.doesNotMatch(menu, /account-preferences-menu-item|account-delete-menu-item/);
    // One gear on the page: the composer's.
    assert.doesNotMatch(menu, /M9\.594 3\.94/);
    const dialogSource = read('chat/components/SettingsDialog.js');
    assert.match(dialogSource, /openDeleteAccount\(/);
    assert.match(read('chat/app.js'), /openDeleteAccount: \(\) => this\.settingsDialog\?\.openDeleteAccount\?\.\(\)/);
    // Wired: the vanilla UI mounts it and components reach it through the facade.
    assert.match(read('chat/ui/vanilla/VanillaChatUi.js'), /settingsDialog: new SettingsDialog\(componentApp\)/);
    assert.match(read('chat/ui/appInterface.js'), /'settingsDialog',/);
    assert.match(read('chat/ui/appInterface.js'), /'deleteAllChats',/);
});

test('the Tools → Web search switch flips the same state as the composer control', () => {
    const source = read('chat/components/ChatInput.js');
    assert.match(source, /const searchSettingToggle = document\.getElementById\('search-setting-toggle'\);/);
    assert.match(source, /searchSettingToggle\.addEventListener\('click', async \(event\) => \{\s*event\.stopPropagation\(\);\s*await toggleSearch\(\);/);
    assert.match(source, /settingToggle\.classList\.toggle\('switch-active', this\.app\.searchEnabled\)/);
    assert.match(source, /const SETTINGS_MENU_WIDTH_PX = 340;/);
    assert.match(source, /const centred = btnRect\.left \+ btnRect\.width \/ 2 - width \/ 2;/);
});

test('settings panel styles: compact rows, blue switches, raised selected segment, full-width dividers', () => {
    const css = read('chat/styles.css');
    assert.match(css, /\.settings-panel\s*\{[^}]*--settings-row-h: 2rem;[^}]*--settings-control-h: 1\.75rem;[^}]*--settings-accent: #0a84ff/s);
    assert.match(css, /\.settings-section\s*\{[^}]*border-bottom: 1px solid var\(--settings-line\)/s);
    assert.match(css, /\.settings-row\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/s);
    assert.match(css, /\.settings-panel \.settings-switch\.switch-active\s*\{[^}]*background-color: var\(--settings-accent\)/s);
    assert.match(css, /\.settings-panel \.settings-segmented \.theme-toggle-indicator,\s*\.settings-panel \.settings-segmented \.display-toggle-indicator\s*\{\s*display: none;/s);
    assert.match(css, /\.settings-panel \.settings-segmented \.settings-segment\[aria-checked="true"\]\s*\{[^}]*background: var\(--settings-segment-on\)/s);
    assert.match(css, /\.settings-select::after\s*\{[^}]*rotate\(45deg\)/s);
});

test('the Delete confirmation paints above the Account card', () => {
    const css = read('chat/styles.css');
    // The card's segmented controls sit at z-index 1; the confirm layer must
    // be above them, and the card isolates its own stacking context.
    assert.match(css, /\.settings-confirm-layer \{[^}]*position: absolute;[^}]*z-index: 2;/s);
    assert.match(css, /\.settings-dialog \{[^}]*position: relative;\s*isolation: isolate;/s);
});
