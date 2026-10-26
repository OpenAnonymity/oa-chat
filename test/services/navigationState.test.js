import test from 'node:test';
import assert from 'node:assert/strict';
import { readNavigationSelection, saveNavigationSelection, restoreNavigationSelection, rememberReturnPoint,
    isConversationRestorePending } from '../../chat/services/navigationState.js';

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
    for (const search of ['?c=explicit', '?s=explicit']) {
        assert.equal(await restoreNavigationSelection({ storage: tab, search,
            loadSession: () => { throw new Error('ordinary link routing must resolve this'); } }), null);
    }
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

// iOS relaunches an evicted home-screen app as a fresh page: sessionStorage is
// empty, so the person landed on New Chat instead of the chat they had open.
test('an installed app relaunched by the system returns to the open chat and its scroll position', async () => {
    const device = storage();
    const firstLaunch = storage();
    saveNavigationSelection('swap-line-chat', firstLaunch, device);
    rememberReturnPoint('swap-line-chat', { top: 840, atBottom: false }, device, 1000);

    const relaunch = storage();
    assert.equal(isConversationRestorePending({ storage: relaunch, returnStorage: device, installed: true, now: 2000 }), true);
    const loaded = [];
    const result = await restoreNavigationSelection({ storage: relaunch, returnStorage: device, installed: true, now: 2000,
        loadSession: async id => { loaded.push(id); return true; } });
    assert.deepEqual(loaded, ['swap-line-chat']);
    assert.equal(result.sessionId, 'swap-line-chat');
    assert.deepEqual(result.scroll, { top: 840, atBottom: false });
    assert.equal(readNavigationSelection(relaunch).sessionId, 'swap-line-chat', 'the relaunched tab adopts it');
});

test('browser tabs never write or clear the device return point', () => {
    const device = storage();
    saveNavigationSelection('tab-chat', storage(), device, false);
    assert.equal(device.getItem('oa-chat-return-point-v1'), null);
    rememberReturnPoint('app-chat', null, device, 1000);
    saveNavigationSelection(null, storage(), device, false);
    assert.match(device.getItem('oa-chat-return-point-v1'), /app-chat/);
});

test('browser tabs, New Chat, stale and deleted return points still open New Chat', async () => {
    const device = storage();
    rememberReturnPoint('chat', { top: 10, atBottom: true }, device, 1000);
    const fresh = () => storage();
    const never = async () => { throw new Error('must not load'); };
    // A new browser tab is not a relaunch.
    assert.equal(await restoreNavigationSelection({ storage: fresh(), returnStorage: device, installed: false, loadSession: never }), null);
    // Older than a day.
    assert.equal(await restoreNavigationSelection({ storage: fresh(), returnStorage: device, installed: true,
        now: 1000 + 25 * 60 * 60 * 1000, loadSession: never }), null);
    // Deleted since.
    assert.equal(await restoreNavigationSelection({ storage: fresh(), returnStorage: device, installed: true, now: 2000,
        loadSession: async () => false }), null);
    // Choosing New Chat forgets the return point.
    rememberReturnPoint('chat', null, device, 1000);
    saveNavigationSelection(null, fresh(), device, true);
    assert.equal(await restoreNavigationSelection({ storage: fresh(), returnStorage: device, installed: true, now: 2000,
        loadSession: never }), null);
});
