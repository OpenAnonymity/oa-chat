import test from 'node:test';
import assert from 'node:assert/strict';
import { prerenderInitialChat } from '../../chat/ui/initialChat.js';
import { isConversationRestorePending, saveNavigationSelection } from '../../chat/services/navigationState.js';

function fixture() {
    const values = new Map();
    const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const container = { dataset: {}, childElementCount: 0, innerHTML: '' };
    return { storage, container, loadTemplate: async () => ({ buildEmptyState: () => 'welcome' }) };
}

test('reload and explicit shared/local links do not prerender a new chat', async () => {
    const f = fixture();
    saveNavigationSelection('conversation', f.storage);
    await prerenderInitialChat(f);
    assert.equal(f.container.innerHTML, '');
    // Versioned state is authoritative even when the legacy write was interrupted.
    f.storage.removeItem('oa-current-session');
    assert.equal(isConversationRestorePending(f), true);
    await prerenderInitialChat(f);
    assert.equal(f.container.innerHTML, '');
    saveNavigationSelection(null, f.storage);
    await prerenderInitialChat({ ...f, search: '?s=shared' });
    assert.equal(f.container.innerHTML, '');
});

test('genuinely new chats and explicit New Chat selection retain fast centered welcome', async () => {
    const f = fixture();
    await prerenderInitialChat(f);
    assert.equal(f.container.innerHTML, 'welcome');
    saveNavigationSelection(null, f.storage);
    f.storage.setItem('oa-current-session', 'stale-legacy');
    assert.equal(isConversationRestorePending(f), false);
});

test('a late template import cannot overwrite mounted app, restored messages, or navigation', async () => {
    for (const change of [f => { f.container.dataset.chatBootstrapped = 'true'; },
        f => { f.container.childElementCount = 1; f.container.innerHTML = 'conversation'; },
        f => saveNavigationSelection('conversation', f.storage)]) {
        const f = fixture();
        let release;
        const loading = prerenderInitialChat({ ...f, loadTemplate: () => new Promise(resolve => { release = resolve; }) });
        change(f);
        const before = f.container.innerHTML;
        release({ buildEmptyState: () => 'welcome' });
        await loading;
        assert.equal(f.container.innerHTML, before);
    }
});

test('the mounted chat area does not render New Chat while navigation is restoring', async t => {
    const { default: ChatArea } = await import('../../chat/components/ChatArea.js');
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: () => ({ textContent: '', get innerHTML() { return this.textContent; } }) };
    t.after(() => { globalThis.document = previousDocument; });
    const container = { innerHTML: '', querySelector: () => null };
    const area = Object.create(ChatArea.prototype);
    Object.assign(area, {
        app: { restoringInitialConversation: true, getCurrentSession: () => null, elements: { messagesContainer: container } },
        renderGeneration: 0, reasoningBuffer: {}, typewriter: {},
        shouldPreserveQuickAskWindowForRender: () => false,
        hideQuickAskPopover() {}, closeQuickAskWindow() {}, clearAllCouncilReasoningStreams() {},
        attachDownloadHandler() {}
    });
    await area.render();
    assert.equal(container.innerHTML, '');
    area.app.restoringInitialConversation = false;
    await area.render();
    assert.match(container.innerHTML, /welcome-landing/);
});
