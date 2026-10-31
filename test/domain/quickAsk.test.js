import test from 'node:test';
import assert from 'node:assert/strict';
import { processMessagesForApi } from '../../chat/domain/messageContent.js';
import {
    buildQuickAskMessages,
    buildQuickAskQuestion,
    normalizeQuickAskSelection
} from '../../chat/domain/quickAsk.js';

test('normalizeQuickAskSelection trims whitespace and bounds selected text', () => {
    assert.equal(normalizeQuickAskSelection('  Open\n\nAnonymity\tProject  '), 'Open Anonymity Project');
    assert.equal(normalizeQuickAskSelection(''), '');
    assert.equal(normalizeQuickAskSelection('abcdef', { maxChars: 4 }), 'abcd...');
});

test('buildQuickAskQuestion asks for a concise contextual explanation', () => {
    assert.equal(buildQuickAskQuestion('Privacy Pass'), 'Briefly explain "Privacy Pass" in context.');
});

test('buildQuickAskMessages appends an unsaved user question to existing context', () => {
    const baseMessages = [
        { role: 'user', content: 'Explain tickets' },
        { role: 'assistant', content: 'They use blind signatures.' }
    ];

    const result = buildQuickAskMessages(baseMessages, 'blind signatures');

    assert.deepEqual(result, [
        ...baseMessages,
        { role: 'user', content: 'Briefly explain "blind signatures" in context.' }
    ]);
    assert.equal(baseMessages.length, 2);
});

test('Quick Ask omits an earlier PDF while keeping text and normal chat attachments intact', () => {
    const history = [
        {
            role: 'user',
            content: 'Explain this paper',
            files: [
                { name: 'paper.pdf', type: 'application/pdf', detectedType: 'pdf', dataUrl: 'data:application/pdf;base64,cGRm' },
                { name: 'notes.txt', type: 'text/plain', detectedType: 'text', dataUrl: 'data:text/plain;base64,bm90ZXM=' }
            ]
        },
        { role: 'assistant', content: 'Here u is the velocity field.' }
    ];
    const originalHistory = structuredClone(history);
    const normalMessages = processMessagesForApi(history, 'openai/gpt-5.2-chat');
    const originalNormalMessages = structuredClone(normalMessages);

    const result = buildQuickAskMessages(normalMessages, 'u');

    assert.equal(result.flatMap(message => message.content).some(part => part?.type === 'file'), false);
    assert.equal(result[0].content[0].text, 'Explain this paper\n\n--- File: notes.txt ---\nnotes');
    assert.equal(result[1].content, 'Here u is the velocity field.');
    assert.equal(result[2].content, 'Briefly explain "u" in context.');
    assert.deepEqual(history, originalHistory);
    assert.deepEqual(normalMessages, originalNormalMessages);
    assert.equal(normalMessages[0].content[1].file.filename, 'paper.pdf');
    assert.deepEqual(processMessagesForApi(history, 'openai/gpt-5.2-chat'), originalNormalMessages);
});

test('Quick Ask leaves nonempty text for PDF-only turns detected by filename or MIME type', () => {
    const pdfs = [
        { filename: 'PAPER.PDF', file_data: 'https://example.test/document' },
        { filename: 'scan', file_data: 'data:application/pdf;base64,cGRm' },
        { file_data: 'data:APPLICATION/PDF,cGRm' }
    ];
    for (const pdf of pdfs) {
        const part = Object.freeze({ type: 'file', file: Object.freeze(pdf) });
        const message = Object.freeze({ role: 'user', content: Object.freeze([part]) });
        const result = buildQuickAskMessages(Object.freeze([message]), 'u');

        assert.equal(result[0].role, 'user');
        assert.equal(result[0].content.length, 1);
        assert.equal(result[0].content[0].type, 'text');
        assert.match(result[0].content[0].text, /PDF attachment omitted/);
        assert.equal(message.content[0], part);
    }
});

test('Quick Ask preserves images, other file types, and already available document text', () => {
    const text = { type: 'text', text: 'Text already extracted from a document.' };
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } };
    const otherFile = { type: 'file', file: { filename: 'clip.wav', file_data: 'data:audio/wav;base64,YXVkaW8=' } };
    const pdf = { type: 'file', file: { filename: 'paper.pdf', file_data: 'data:application/pdf;base64,cGRm' } };
    const result = buildQuickAskMessages([{ role: 'user', content: [text, image, otherFile, pdf] }], 'u');

    assert.deepEqual(result[0].content.slice(0, 3), [text, image, otherFile]);
    assert.equal(result[0].content[3].type, 'text');
});

test('Quick Ask with no selection creates no request even with PDF context', () => {
    assert.deepEqual(buildQuickAskMessages([{ role: 'user', content: [
        { type: 'file', file: { filename: 'paper.pdf' } }
    ] }], '  '), []);
});
