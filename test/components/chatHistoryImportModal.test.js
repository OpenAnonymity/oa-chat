import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Import chat history wears the Account dialog's skin and, when opened from
// Account, carries a back arrow that reopens it; the X returns to chat.
const read = relative => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

test('opened from Account, the import dialog can go back to it', () => {
    const dialog = read('chat/components/SettingsDialog.js');
    assert.match(dialog, /chatHistoryImportModal\?\.open\?\.\(\{ returnTo: 'account' \}\)/);
    const modal = read('chat/components/ChatHistoryImportModal.js');
    assert.match(modal, /this\.returnTo = options\.returnTo \|\| null;/);
    assert.match(modal, /if \(back && returnTo === 'account'\) this\.app\.settingsDialog\?\.open\?\.\(\);/);
    assert.match(modal, /backBtn\.onclick = \(\) => this\.close\(\{ back: true \}\);/);
    assert.match(modal, /const backButton = this\.returnTo === 'account' \?/);
});

test('the source list is rows with a Choose file action, no subtext, and a folded how-to', () => {
    const modal = read('chat/components/ChatHistoryImportModal.js');
    assert.match(modal, /class="settings-dialog settings-panel"/);
    assert.match(modal, /<h2 id="chat-import-title" class="account-dialog-title">Import chat history<\/h2>/);
    assert.match(modal, /class="settings-text-action" data-import-pick/);
    assert.match(modal, /<span class="import-soon">Coming soon<\/span>/);
    assert.match(modal, /<details class="import-howto">\s*<summary>How to get your ChatGPT export<\/summary>/);
    assert.doesNotMatch(modal, /Supported Formats|Nothing is uploaded|More sources can be added/);
});
