import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildChatMarkdown,
    downloadChatAsMarkdown,
    getMarkdownFilename
} from '../../chat/services/chatMarkdownExport.js';

test('buildChatMarkdown preserves conversation text and replaces media with readable placeholders', () => {
    const markdown = buildChatMarkdown({ title: 'Trip planning' }, [
        {
            role: 'user',
            content: 'What is shown here?',
            files: [
                { name: 'map.png', type: 'image/png', dataUrl: 'data:image/png;base64,secret' },
                { name: 'notes.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,secret' }
            ]
        },
        {
            role: 'assistant',
            content: '**A walking route.**',
            images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,secret' } }]
        }
    ]);

    assert.equal(markdown, `# Trip planning

## User

What is shown here?

[User image: map.png]

[User attachment: notes.pdf]

## Assistant

**A walking route.**

[Model response image]
`);
    assert.doesNotMatch(markdown, /base64|data:image|data:application/);
});

test('buildChatMarkdown handles structured content, system messages, and empty output', () => {
    const markdown = buildChatMarkdown({ title: 'Structured\nchat' }, [
        { role: 'system', content: { text: 'Follow the rules.' } },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Describe this' },
                { type: 'image_url', image_url: { url: 'https://example.com/private.png' } }
            ]
        },
        { role: 'assistant', content: '' }
    ]);

    assert.equal(markdown, `# Structured chat

## System

Follow the rules.

## User

Describe this

[User image]

## Assistant

[No text content]
`);
    assert.doesNotMatch(markdown, /example\.com/);
});

test('getMarkdownFilename creates a readable safe markdown filename', () => {
    assert.equal(getMarkdownFilename('  Launch / plan: v2?  '), 'Launch-plan-v2.md');
    assert.equal(getMarkdownFilename(''), 'Untitled Chat.md');
});

test('downloadChatAsMarkdown downloads a UTF-8 markdown blob and cleans up the object URL', async () => {
    const calls = [];
    const anchor = {
        href: '',
        download: '',
        click: () => calls.push('click')
    };
    const documentRef = {
        createElement: tag => {
            assert.equal(tag, 'a');
            return anchor;
        },
        body: {
            appendChild: node => calls.push(['append', node]),
            removeChild: node => calls.push(['remove', node])
        }
    };
    const urlRef = {
        createObjectURL: blob => {
            calls.push(['create', blob]);
            return 'blob:markdown-export';
        },
        revokeObjectURL: url => calls.push(['revoke', url])
    };

    const result = downloadChatAsMarkdown(
        { title: 'Readable chat' },
        [{ role: 'user', content: 'Hello' }],
        { documentRef, urlRef, BlobCtor: Blob }
    );
    const blob = calls.find(call => Array.isArray(call) && call[0] === 'create')[1];

    assert.equal(anchor.href, 'blob:markdown-export');
    assert.equal(anchor.download, 'Readable chat.md');
    assert.equal(blob.type, 'text/markdown;charset=utf-8');
    assert.equal(await blob.text(), result.markdown);
    assert.deepEqual(calls.slice(1), [
        ['append', anchor],
        'click',
        ['remove', anchor],
        ['revoke', 'blob:markdown-export']
    ]);
});
