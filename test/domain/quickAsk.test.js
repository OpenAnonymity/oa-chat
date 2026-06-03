import test from 'node:test';
import assert from 'node:assert/strict';
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
