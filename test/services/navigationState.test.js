import test from 'node:test';
import assert from 'node:assert/strict';
import { readNavigationSelection, saveNavigationSelection, restoreNavigationSelection } from '../../chat/services/navigationState.js';

function storage(seed = []) {
    const values = new Map(seed);
    return { values, getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('New Chat replaces an inherited conversation and stays blank through billing returns', async () => {
    const tab = storage([['oa-current-session', 'older-conversation']]);
    saveNavigationSelection(null, tab);
    assert.equal(tab.getItem('oa-current-session'), null);
    for (const search of ['', '?billing=topup_success&session_id=cs_test_x', '?billing=cancelled', '?billing=portal_return']) {
        const result = await restoreNavigationSelection({ storage: tab, search,
            loadSession: () => { throw new Error('blank chat must not hydrate older history'); } });
        assert.equal(result.kind, 'new-chat');
    }
});

test('conversation navigation round-trips without adding chat identifiers to billing URLs', async () => {
    const tab = storage();
    saveNavigationSelection('original-conversation', tab);
    const other = storage([...tab.values]);
    saveNavigationSelection('different-window', other);
    const loaded = [];
    const result = await restoreNavigationSelection({ storage: tab, search: '?billing=success',
        loadSession: async id => { loaded.push(id); return true; } });
    assert.deepEqual(loaded, ['original-conversation']);
    assert.equal(result.sessionId, 'original-conversation');
});

test('explicit deep links bypass saved selection and missing conversations restore New Chat', async () => {
    const tab = storage();
    saveNavigationSelection('deleted', tab);
    assert.equal(await restoreNavigationSelection({ storage: tab, search: '?s=explicit',
        loadSession: () => { throw new Error('ordinary link routing must resolve this'); } }), null);
    assert.equal((await restoreNavigationSelection({ storage: tab, loadSession: async () => false })).kind, 'new-chat');
    assert.equal(tab.getItem('oa-current-session'), null);
});

test('legacy, malformed, and unavailable storage are safe', () => {
    assert.equal(readNavigationSelection(storage([['oa-current-session', 'legacy']])).sessionId, 'legacy');
    assert.equal(readNavigationSelection(storage([['oa-chat-navigation-v1', '{']])), null);
    const unavailable = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.equal(readNavigationSelection(unavailable), null);
    assert.doesNotThrow(() => saveNavigationSelection(null, unavailable));
});
