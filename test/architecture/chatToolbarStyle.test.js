import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('chat toolbar has no visible conversation separator', () => {
    const html = fs.readFileSync('chat/index.html', 'utf8');
    const styles = fs.readFileSync('chat/styles.css', 'utf8');
    const app = fs.readFileSync('chat/app.js', 'utf8');

    assert.equal(html.includes('mobile-toolbar-divider'), false);
    assert.equal(styles.includes('.chat-toolbar.toolbar-divider-visible'), false);
    assert.equal(app.includes("classList.toggle('toolbar-divider-visible'"), false);
});
