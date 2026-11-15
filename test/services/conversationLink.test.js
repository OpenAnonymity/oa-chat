import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CONVERSATION_PARAM,
    LEGACY_CONVERSATION_PARAM,
    hasConversationParam,
    readConversationParam,
    setConversationParam,
    deleteConversationParam,
    conversationQuery,
    normalizeConversationAddress
} from '../../chat/services/conversationLink.js';

// Fathom Analytics forwards these query parameters with every pageview
// (cdn.usefathom.com/script.js, 2026-09-30). The conversation parameter must
// stay off the list or every chat and share ID would be recorded.
const FATHOM_KEPT_QUERY_PARAMS = ['keyword', 'q', 'ref', 's', 'utm_campaign', 'utm_content', 'utm_medium',
    'utm_source', 'utm_term', 'action', 'name', 'pagename', 'tab', 'via', 'gclid', 'msclkid'];

test('the conversation parameter is not one an analytics tracker forwards', () => {
    assert.equal(CONVERSATION_PARAM, 'c');
    assert.equal(FATHOM_KEPT_QUERY_PARAMS.includes(CONVERSATION_PARAM), false);
    // The legacy spelling is exactly the collision that forced the rename.
    assert.equal(FATHOM_KEPT_QUERY_PARAMS.includes(LEGACY_CONVERSATION_PARAM), true);
});

test('both spellings are read, the current one first', () => {
    assert.equal(readConversationParam('?c=abc'), 'abc');
    assert.equal(readConversationParam('?s=abc'), 'abc');
    assert.equal(readConversationParam('?s=old&c=new'), 'new');
    assert.equal(readConversationParam('?c='), '');
    assert.equal(readConversationParam('?q=abc'), null);
    assert.equal(readConversationParam(''), null);
    assert.equal(readConversationParam(new URLSearchParams('?s=abc')), 'abc');
    for (const search of ['?c=abc', '?s=abc', '?c=', '?s=', '?view=read&s=x']) assert.equal(hasConversationParam(search), true);
    for (const search of ['', '?q=abc', '?subject=shared', '?cs=1']) assert.equal(hasConversationParam(search), false);
});

test('links are written with the current spelling only', () => {
    assert.equal(conversationQuery('01m24-vns1h'), '?c=01m24-vns1h');
    assert.equal(conversationQuery('a b'), '?c=a%20b');
    const url = new URL('https://chat.example/?s=old&view=read#billing');
    setConversationParam(url, 'new');
    assert.equal(url.toString(), 'https://chat.example/?view=read&c=new#billing');
    deleteConversationParam(url);
    assert.equal(url.search, '?view=read');
    deleteConversationParam(setConversationParam(new URL('https://chat.example/?c=x&s=y'), 'z'));
});

test('a legacy address is rewritten in place, keeping query, fragment and history state', () => {
    const calls = [];
    const state = { oaLocalSessionId: 'abc' };
    const history = { state, replaceState: (...args) => calls.push(args) };
    assert.equal(normalizeConversationAddress({ href: 'https://chat.example/?s=abc&view=read#billing' }, history), true);
    assert.deepEqual(calls, [[state, '', 'https://chat.example/?view=read&c=abc#billing']]);

    calls.length = 0;
    assert.equal(normalizeConversationAddress({ href: 'https://chat.example/?c=abc' }, history), false);
    assert.equal(normalizeConversationAddress({ href: 'https://chat.example/' }, history), false);
    assert.deepEqual(calls, []);

    // Both present: the current spelling wins and the legacy one is dropped.
    assert.equal(normalizeConversationAddress({ href: 'https://chat.example/?s=old&c=new' }, history), true);
    assert.deepEqual(calls, [[state, '', 'https://chat.example/?c=new']]);

    // Never throws: an address that cannot be parsed is left alone.
    assert.equal(normalizeConversationAddress({ href: 'not a url' }, history), false);
});
