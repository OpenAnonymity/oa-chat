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

test('settings panel: five sections, one row grammar, every control the app drives', () => {
    const panel = settingsPanel(read('chat/index.html'));
    assert.match(panel, /class="hidden z-\[100\] settings-panel settings-menu-glass" role="group" aria-label="Settings"/);
    const titles = [...panel.matchAll(/class="settings-section-title">([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(titles, ['Data controls', 'Privacy', 'Memory', 'Tools', 'Appearance']);
    const labels = [...panel.matchAll(/settings-row-label"[^>]*>([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(labels, [
        'All', 'Chat history', 'ChatGPT',
        'Scrubber model',
        'Memory', 'Always attach retrieval', 'Model', 'Data',
        'Web search', 'Council review', 'Council model', 'Thinking effort',
        'Layout', 'Font', 'Theme',
        'Share feedback'
    ]);
    // Data actions the ChatInput click handler dispatches on.
    for (const action of ['export-all-data', 'import-data', 'export-chats', 'import-history', 'export-memory', 'import-memory']) {
        assert.match(panel, new RegExp(`<button type="button" data-action="${action}"[^>]*class="settings-button"`), action);
    }
    assert.doesNotMatch(panel, /import-tickets|Import from ChatGPT/, 'tickets import lives in Account now');
    assert.match(panel, /data-action="export-memory" data-memory-requires-feature/);
    assert.match(panel, /data-action="import-memory" data-memory-requires-feature/);
    // Hidden file inputs the handlers click.
    for (const id of ['global-import-input', 'tickets-import-input', 'memory-import-input']) {
        assert.match(panel, new RegExp(`<input type="file" id="${id}"`), id);
    }
    // Ids the JS looks up.
    for (const id of ['scrubber-model-select', 'memory-feature-toggle', 'memory-auto-include-toggle', 'memory-agent-model-select',
        'search-setting-toggle', 'council-review-toggle', 'council-review-model-row', 'council-review-model-select', 'multi-model-synthesis-select',
        'reasoning-effort-toggle', 'flat-mode-toggle', 'font-mode-toggle', 'theme-toggle', 'theme-effective-label', 'composer-settings-actions']) {
        assert.match(panel, new RegExp(`id="${id}"`), id);
    }
    // Switches are the blue iOS-style toggle; segmented controls keep their
    // data attributes and drop the sliding indicator.
    assert.equal((panel.match(/class="switch-toggle settings-switch switch-(?:active|inactive)"/g) || []).length, 4);
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
        assert.match(panel, new RegExp(`class="theme-toggle-btn reasoning-effort-btn settings-segment" data-reasoning-effort="${effort}"`), effort);
    }
    assert.match(panel, /data-reasoning-effort="xhigh"[^>]*>Max</);
    assert.match(panel, /data-mode="flat"[^>]*>Document</);
    assert.match(panel, /data-mode="bubble"[^>]*>Bubbles</);
    for (const option of ['system', 'light', 'dark']) {
        assert.match(panel, new RegExp(`data-theme-option="${option}"`), option);
    }
    assert.match(panel, /<a href="https:\/\/forms\.gle\/HEmvxnJpN1jQC7CfA" target="_blank" rel="noopener noreferrer" class="settings-row settings-link">/);
    assert.ok(panel.indexOf('Share feedback') > panel.indexOf('id="theme-toggle"'), 'feedback is the last row');
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
