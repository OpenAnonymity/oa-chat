import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildLocalSessionTitle,
    buildSessionConversationSearchText,
    buildSessionSearchIndexFields,
    buildSessionTitleSearchText,
    cleanGeneratedSessionTitle,
    getSearchableMessageText,
    normalizeSessionSearchText
} from '../../chat/domain/sessionSearch.js';

test('buildLocalSessionTitle trims whitespace and caps fallback titles', () => {
    assert.equal(buildLocalSessionTitle('   hello   world   '), 'hello world');
    assert.equal(buildLocalSessionTitle(''), 'New Chat');
    assert.equal(
        buildLocalSessionTitle('abcdefghijklmnopqrstuvwxyz', { fallbackLength: 10 }),
        'abcdefghij...'
    );
});

test('session search text helpers normalize multiline content', () => {
    assert.equal(buildSessionTitleSearchText('a\n\n b\t c'), 'a b c');
    assert.equal(normalizeSessionSearchText([{ text: 'hello\n' }, { content: 'world' }]), 'hello world');
});

test('getSearchableMessageText only indexes persisted user and assistant messages', () => {
    assert.equal(getSearchableMessageText({ role: 'user', content: 'hello' }), 'hello');
    assert.equal(getSearchableMessageText({ role: 'assistant', content: 'hi' }), 'hi');
    assert.equal(getSearchableMessageText({ role: 'system', content: 'hidden' }), '');
    assert.equal(getSearchableMessageText({ role: 'assistant', content: 'local', isLocalOnly: true }), '');
});

test('buildSessionConversationSearchText keeps first segment and most recent bounded context', () => {
    const messages = [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'middle message' },
        { role: 'user', content: 'latest message' }
    ];
    assert.equal(
        buildSessionConversationSearchText(messages, { maxChars: 28, maxMessageChars: 100 }),
        'first message\nlatest message'
    );
});

test('buildSessionSearchIndexFields accepts deterministic clock for tests', () => {
    assert.deepEqual(
        buildSessionSearchIndexFields([{ role: 'user', content: 'hello' }], { now: () => 123 }),
        { conversationSearchText: 'hello', conversationSearchIndexedAt: 123 }
    );
});

test('cleanGeneratedSessionTitle removes prefixes, quotes, punctuation, and truncates at word boundary', () => {
    assert.equal(cleanGeneratedSessionTitle('Title: "A useful chat title!"'), 'A useful chat title');
    assert.equal(
        cleanGeneratedSessionTitle('A very long generated session title that should stop cleanly', { maxLength: 30 }),
        'A very long generated'
    );
    assert.equal(cleanGeneratedSessionTitle('...'), '');
});
