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

test('the gear keeps what changes between prompts: Privacy, Memory, Tools', () => {
    const panel = settingsPanel(read('chat/index.html'));
    assert.match(panel, /class="hidden z-\[100\] settings-panel settings-menu-glass" role="group" aria-label="Settings"/);
    const titles = [...panel.matchAll(/class="settings-section-title">([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(titles, ['Privacy', 'Memory', 'Tools']);
    const labels = [...panel.matchAll(/settings-row-label"[^>]*>([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(labels, [
        'Scrubber model',
        'Memory', 'Always attach retrieval', 'Model', 'Memories',
        'Web search', 'Council review', 'Council model', 'Effort'
    ]);
    // Memory export/import stay with the Memory section (the ChatInput click handler dispatches on them).
    assert.match(panel, /data-action="export-memory" data-memory-requires-feature/);
    assert.match(panel, /data-action="import-memory" data-memory-requires-feature/);
    for (const id of ['tickets-import-input', 'memory-import-input']) {
        assert.match(panel, new RegExp(`<input type="file" id="${id}"`), id);
    }
    // Nothing once-and-done is left here: no data rows, no appearance, no feedback, no "All".
    assert.doesNotMatch(panel, /export-all-data|import-data|export-chats|import-history|global-import-input|Data controls|Appearance|Share feedback|>All</);
    assert.doesNotMatch(panel, /import-tickets|Import from ChatGPT/, 'tickets import lives in Billing');
    for (const id of ['scrubber-model-select', 'memory-feature-toggle', 'memory-auto-include-toggle', 'memory-agent-model-select',
        'search-setting-toggle', 'council-review-toggle', 'council-review-model-row', 'council-review-model-select', 'multi-model-synthesis-select',
        'reasoning-effort-toggle', 'composer-settings-actions']) {
        assert.match(panel, new RegExp(`id="${id}"`), id);
    }
    assert.equal((panel.match(/class="switch-toggle settings-switch switch-(?:active|inactive)"/g) || []).length, 4);
    // The Council model row is always in the panel, dimmed while review is off,
    // so flipping the switch never grows the panel under the pointer.
    assert.match(panel, /<div id="council-review-model-row" class="settings-row is-disabled">/);
    assert.match(read('chat/components/ChatInput.js'), /councilReviewModelRow\.classList\.toggle\('is-disabled', !isCouncilReviewEnabled\)/);
    assert.doesNotMatch(read('chat/components/ChatInput.js'), /councilReviewModelRow\.classList\.toggle\('hidden'/);
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
        assert.match(panel, new RegExp(`class="theme-toggle-btn reasoning-effort-btn settings-segment" data-reasoning-effort="${effort}"`), effort);
    }
    assert.match(panel, /data-reasoning-effort="xhigh"[^>]*>Max</);
    // The composer actions slot is the last section; with nothing visible in it the CSS removes it and the divider above.
    assert.match(panel, /<section id="composer-settings-actions" class="settings-section settings-section-foot composer-settings-actions"><\/section>\s*<\/div>\s*<\/div>\s*$/);
});

test('the Account dialog holds what is set once: data, appearance, feedback, account actions', () => {
    const html = read('chat/index.html');
    const dialog = settingsDialog(html);
    assert.match(dialog, /<div id="settings-dialog" class="hidden fixed inset-0 z-50 bg-black\/60 backdrop-blur-sm flex items-center justify-center p-4">/);
    assert.match(dialog, /<div role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" tabindex="-1" class="settings-dialog settings-panel">/);
    assert.match(dialog, /<h2 id="settings-dialog-title" class="account-dialog-title">Account<\/h2>/);
    assert.match(dialog, /<button id="close-settings-dialog"[^>]*aria-label="Close account"/);
    const titles = [...dialog.matchAll(/class="settings-section-title">([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(titles, ['Data controls', 'Appearance', 'Account']);
    const labels = [...dialog.matchAll(/settings-row-label"[^>]*>([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(labels, [
        'Chat history', 'ChatGPT',
        'Layout', 'Font', 'Theme',
        'Share feedback',
        'Log out of this device', 'Delete your account'
    ]);
    for (const action of ['export-chats', 'import-history', 'log-out', 'delete-account']) {
        assert.match(dialog, new RegExp(`<button type="button" data-action="${action}"[^>]*class="settings-button`), action);
    }
    assert.match(dialog, /data-action="delete-account" class="settings-button settings-button-danger">Delete</);
    // The Appearance controls keep their ids, so ChatInput binds them unchanged.
    for (const id of ['flat-mode-toggle', 'font-mode-toggle', 'theme-toggle', 'theme-effective-label']) {
        assert.match(dialog, new RegExp(`id="${id}"`), id);
        assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} exists once`);
    }
    assert.match(dialog, /data-mode="flat"[^>]*>Document</);
    assert.match(dialog, /data-mode="bubble"[^>]*>Bubbles</);
    for (const option of ['system', 'light', 'dark']) {
        assert.match(dialog, new RegExp(`data-theme-option="${option}"`), option);
    }
    assert.match(dialog, /<a href="https:\/\/forms\.gle\/HEmvxnJpN1jQC7CfA" target="_blank" rel="noopener noreferrer" class="settings-row settings-link">/);
    // The confirmation card: one sentence on what goes, cancel first.
    assert.match(html, /<template id="settings-delete-account-template">[\s\S]*Delete your account\?[\s\S]*data-delete-account="cancel"[\s\S]*data-delete-account="confirm"[^>]*>Delete account</);
    // Reached from the account menu, above Account.
    const menu = html.slice(html.indexOf('id="account-settings-menu"'), html.indexOf('id="account-logout-menu-item"'));
    assert.ok(menu.indexOf('id="account-preferences-menu-item"') < menu.indexOf('id="account-security-menu-item"'));
    assert.match(menu, /id="account-preferences-menu-item"[^>]*role="menuitem"[\s\S]*?<span>Account<\/span>/);
    // One gear on the page: the composer's. The menu row wears the person glyph.
    assert.doesNotMatch(menu.slice(0, menu.indexOf('id="account-security-menu-item"')), /M9\.594 3\.94/);
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
