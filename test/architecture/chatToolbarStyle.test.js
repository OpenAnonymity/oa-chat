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

test('shared screen-reader announcements stay clipped without generated utilities', () => {
    const styles = fs.readFileSync('chat/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = styles.match(/(?:^|\})\s*\.sr-only\s*\{([^}]+)\}/)?.[1];
    assert.ok(rule, 'the shared stylesheet must hide every sr-only consumer, including composer status');
    for (const declaration of [
        /position:\s*absolute\s*;/, /width:\s*1px\s*;/, /height:\s*1px\s*;/,
        /padding:\s*0\s*;/, /margin:\s*-1px\s*;/, /overflow:\s*hidden\s*;/,
        /clip-path:\s*inset\(50%\)\s*;/, /white-space:\s*nowrap\s*;/, /border:\s*0\s*;/
    ]) assert.match(rule, declaration);
    assert.doesNotMatch(rule, /display:\s*none|visibility:\s*hidden/,
        'announcements must remain available to assistive technology');
});
