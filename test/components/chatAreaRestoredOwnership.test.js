import test from 'node:test';
import assert from 'node:assert/strict';
import { createVanillaUiInterface } from '../../chat/ui/appInterface.js';
import { turnLockName } from '../../chat/services/turnOwnership.js';

// The chat area paints a reply saved mid-stream from storage. When this tab is
// not writing it, the turn lock decides what the row says: still being written
// in another tab (and repaint once that tab lets go), or interrupted with Retry.

function installGlobals(locks) {
    const keys = ['document', 'window', 'location', 'localStorage', 'sessionStorage', 'fetch', 'navigator', 'requestAnimationFrame'];
    const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    // Enough of an element for the templates' escaping (textContent in, innerHTML out).
    const element = () => ({
        text: '', html: null,
        get textContent() { return this.text; }, set textContent(value) { this.text = String(value); this.html = null; },
        get innerHTML() { return this.html ?? this.text; }, set innerHTML(value) { this.html = String(value); },
        classList: { add() {}, remove() {}, contains: () => false },
        querySelector: () => null, querySelectorAll: () => [], appendChild() {}, remove() {}, dataset: {}, style: {}
    });
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const events = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    const location = { href: 'http://localhost/', hostname: 'localhost', origin: 'http://localhost', search: '', pathname: '/' };
    const values = {
        document: { ...events, createElement: element, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            documentElement: element(), body: element() },
        window: { ...events, location, localStorage: storage, sessionStorage: storage, innerWidth: 1200, matchMedia: () => ({ matches: false }) },
        location, localStorage: storage, sessionStorage: storage,
        fetch: async () => { throw new Error('These component tests must never use the network.'); },
        navigator: { locks },
        requestAnimationFrame: callback => callback()
    };
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    return () => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    };
}

// One exclusive holder per name (the "other tab"), shared probes and waits.
function otherTabLocks() {
    const exclusive = new Map(); // name -> release()
    const waiters = new Map();   // name -> [resolve]
    const log = [];
    return {
        log,
        hold(name) { exclusive.set(name, () => { exclusive.delete(name); (waiters.get(name) || []).splice(0).forEach(fn => fn()); }); },
        release(name) { exclusive.get(name)?.(); },
        waiting(name) { return (waiters.get(name) || []).length; },
        request(name, options, callback) {
            log.push({ name, mode: options.mode, ifAvailable: options.ifAvailable === true });
            const taken = exclusive.has(name);
            if (options.ifAvailable) return Promise.resolve().then(() => callback(taken ? null : { name, mode: options.mode }));
            if (!taken) return Promise.resolve().then(() => callback({ name, mode: options.mode }));
            return new Promise((resolve, reject) => {
                const grant = () => resolve(callback({ name, mode: options.mode }));
                waiters.set(name, [...(waiters.get(name) || []), grant]);
                options.signal?.addEventListener('abort', () => {
                    waiters.set(name, (waiters.get(name) || []).filter(fn => fn !== grant));
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            });
        }
    };
}

async function mountedArea({ locks, messages, streaming = false }) {
    const { default: ChatArea } = await import('../../chat/components/ChatArea.js');
    const container = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [], scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
    const session = { id: 'chat', model: 'Test' };
    const repaints = [];
    const app = {
        state: { currentSessionId: 'chat', models: [], sessionsById: new Map([['chat', session]]) },
        elements: { messagesContainer: container },
        getCurrentSession: () => session,
        isCurrentSessionStreaming: () => streaming,
        getCurrentSessionStreamingPhase: () => 'requesting-key',
        getSessionPendingProgress: () => null,
        renderMessages: async () => { repaints.push(Date.now()); },
        processContentWithLatex: value => String(value || ''),
        formatTime: () => '',
        getMessageTemplateOptions: () => ({}),
        detachStalePromptSlideUpEffect() {},
        persistCouncilLayoutHintFromMessages: () => null,
        updateCouncilLayoutMode() {},
        getPromptSlideUpMessageIdForSession: () => null,
        restorePromptSlideUpEffectForSession: () => false,
        restoreSessionScrollPosition: () => false,
        updateActivePromptScrollSpacer() {},
        scrollChatAreaToBottomInstant() {},
        saveCurrentSessionScrollPosition() {},
        updateScrollButtonVisibility() {},
        updateToolbarDivider() {},
        messageNavigation: null,
        editingMessageId: null,
        restoringInitialConversation: false
    };
    // `messages` may be a list of snapshots, served one per read.
    const snapshots = Array.isArray(messages[0]) ? [...messages] : null;
    const reads = [];
    const chatDBImpl = { getSessionMessages: async () => {
        const snapshot = snapshots ? (snapshots.length > 1 ? snapshots.shift() : snapshots[0]) : messages;
        reads.push(snapshot);
        return snapshot.map(message => structuredClone(message));
    } };
    const { componentApp } = createVanillaUiInterface(app, { chatDBImpl });
    const area = Object.create(ChatArea.prototype);
    Object.assign(area, {
        app: componentApp,
        renderGeneration: 0, reasoningBuffer: {}, typewriter: {},
        shouldPreserveQuickAskWindowForRender: () => false,
        hideQuickAskPopover() {}, closeQuickAskWindow() {}, clearAllCouncilReasoningStreams() {},
        attachDownloadHandler() {}, detachQuickAskWindowForRender: () => null, restoreQuickAskWindowAfterRender() {},
        renderLatex() {}, setupCitationCarouselScroll() {}, initializeEditForm() {}
    });
    return { area, container, repaints, app, reads };
}

const prompt = { id: 'prompt', sessionId: 'chat', role: 'user', content: 'Question', timestamp: 1 };
const placeholder = { id: 'reply', sessionId: 'chat', role: 'assistant', content: '', model: 'Test', timestamp: 2,
    streamingPending: true, streamingPhase: 'requesting-key', streamingTokens: 0 };

test('a reply another tab is writing is painted as answering elsewhere, and repainted once that tab lets go', async t => {
    const locks = otherTabLocks();
    const restore = installGlobals(locks);
    t.after(restore);
    locks.hold(turnLockName('chat'));
    const { area, container, repaints } = await mountedArea({ locks, messages: [prompt, placeholder] });
    await area.render();
    assert.match(container.innerHTML, /Answering in another tab/);
    assert.doesNotMatch(container.innerHTML, /Retry response|no longer connected|connection to this reply/);
    assert.deepEqual(locks.log.map(entry => [entry.mode, entry.ifAvailable]), [['shared', true], ['shared', false]],
        'one probe, then a wait for the release; nothing exclusive from a tab that is not writing');
    assert.equal(locks.waiting(turnLockName('chat')), 1);
    assert.equal(repaints.length, 0);
    locks.release(turnLockName('chat'));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(repaints.length, 1, 'the chat is re-read once the other tab settled the reply');
    assert.equal(locks.waiting(turnLockName('chat')), 0);
});

test('a reply nobody is writing any more is an interrupted turn with Retry, and nothing waits', async t => {
    const locks = otherTabLocks();
    const restore = installGlobals(locks);
    t.after(restore);
    const { area, container, repaints } = await mountedArea({ locks, messages: [prompt, placeholder] });
    await area.render();
    assert.match(container.innerHTML, /The connection to this reply was lost before it finished\. Retry sends a new request\./);
    assert.match(container.innerHTML, /Retry response/);
    assert.doesNotMatch(container.innerHTML, /Answering in another tab|other open tab/);
    assert.deepEqual(locks.log.map(entry => entry.mode), ['shared']);
    assert.equal(locks.waiting(turnLockName('chat')), 0);
    assert.equal(repaints.length, 0);
});

test('a wait from an earlier paint is dropped by the next one, and never fires once this tab writes the reply itself', async t => {
    const locks = otherTabLocks();
    const restore = installGlobals(locks);
    t.after(restore);
    locks.hold(turnLockName('chat'));
    const mounted = await mountedArea({ locks, messages: [prompt, placeholder] });
    await mounted.area.render();
    assert.equal(locks.waiting(turnLockName('chat')), 1);
    await mounted.area.render();
    assert.equal(locks.waiting(turnLockName('chat')), 1, 'the first wait was abandoned, the second stands');
    // This tab now writes in the chat: the row is live here, the lock is not consulted.
    mounted.app.isCurrentSessionStreaming = () => true;
    const probes = locks.log.length;
    await mounted.area.render();
    assert.equal(locks.log.length, probes, 'no probe while this tab streams');
    assert.doesNotMatch(mounted.container.innerHTML, /Answering in another tab|Retry response/);
    assert.equal(locks.waiting(turnLockName('chat')), 0, 'the earlier wait was dropped');
    locks.release(turnLockName('chat'));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(mounted.repaints.length, 0);
});

test('a snapshot taken while the turn was still finishing is re-read before a free lock paints it as interrupted', async t => {
    const locks = otherTabLocks();
    const restore = installGlobals(locks);
    t.after(restore);
    const settled = { ...placeholder, content: 'Finished just now', streamingPending: false, streamingTokens: null };
    const { area, container, reads } = await mountedArea({ locks, messages: [[prompt, placeholder], [prompt, settled]] });
    await area.render();
    assert.equal(reads.length, 2, 'read again once the lock said nobody is writing');
    assert.match(container.innerHTML, /Finished just now/);
    assert.doesNotMatch(container.innerHTML, /Retry response|connection to this reply|Answering in another tab/);
});

test('a chat with only settled replies never touches the lock', async t => {
    const locks = otherTabLocks();
    const restore = installGlobals(locks);
    t.after(restore);
    const settled = { ...placeholder, content: 'Done', streamingPending: false, streamingTokens: null };
    const { area, container, reads } = await mountedArea({ locks, messages: [prompt, settled] });
    await area.render();
    assert.match(container.innerHTML, /Done/);
    assert.deepEqual(locks.log, []);
    assert.equal(reads.length, 1);
});
