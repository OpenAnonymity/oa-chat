import test from 'node:test';
import assert from 'node:assert/strict';

const browserKeys = ['window', 'location', 'localStorage', 'sessionStorage', 'document'];
const descriptors = new Map(browserKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const storage = { getItem: () => null, setItem() {}, removeItem() {} };
const events = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
const location = { href: 'http://localhost/', hostname: 'localhost', origin: 'http://localhost', search: '', pathname: '/' };
for (const [key, value] of Object.entries({
    window: { ...events, location, localStorage: storage, sessionStorage: storage }, location,
    localStorage: storage, sessionStorage: storage,
    document: { ...events, querySelector: () => null, getElementById: () => null,
        documentElement: { classList: { contains: () => false }, dataset: {} } }
})) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { default: preferencesStore } = await import('../../chat/services/preferencesStore.js');
const getPreference = preferencesStore.getPreference;
preferencesStore.getPreference = async () => false;
const { ChatApp } = await import('../../chat/app.js');
await new Promise(resolve => setTimeout(resolve, 0));
preferencesStore.getPreference = getPreference;
for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
}

function harness() {
    return Object.assign(Object.create(ChatApp.prototype), {
        state: { currentSessionId: 'one' }, memoryFeatureEnabled: true,
        memoryWorkGeneration: 1, memoryApiOverrides: new Map(), memoryApiOverrideRevision: 0
    });
}
const messages = [{ id: 'prompt', role: 'user', content: 'Original prompt' }];

test('memory processing stays scoped to the captured chat across navigation and concurrent work', () => {
    const app = harness();
    app.setMemoryApiOverrideContent('Private memory for one', 1, 'one');
    app.setMemoryApiOverrideContent('Private memory for two', 1, 'two');
    app.state.currentSessionId = 'two';
    assert.equal(app.processMessagesWithFiles(messages, 'model', 'one').at(-1).content, 'Private memory for one');
    assert.equal(app.processMessagesWithFiles(messages, 'model', 'two').at(-1).content, 'Private memory for two');
    app.clearMemoryApiOverrideContent('one');
    assert.equal(app.getMemoryApiOverrideContent('one'), null);
    assert.equal(app.getMemoryApiOverrideContent('two'), 'Private memory for two');
    app.clearMemoryApiOverrideContent(null);
    assert.equal(app.getMemoryApiOverrideContent('two'), 'Private memory for two', 'a new unsaved chat cannot clear another chat');
});

test('late Memory changes rebuild only the owning request and detect revisions within one generation', () => {
    const app = harness();
    app.setMemoryApiOverrideContent('First revision', 1, 'one');
    const processed = app.processMessagesWithFiles(messages, 'model', 'one');
    const revision = app.getMemoryApiOverrideRevision('one');
    app.setMemoryApiOverrideContent('Unrelated context', 1, 'two');
    assert.equal(app.refreshProcessedMessagesIfMemoryOverrideChanged(processed, messages, 'model', revision, 'one').processedMessages, processed);
    app.setMemoryApiOverrideContent('Updated revision', 1, 'one');
    const refreshed = app.refreshProcessedMessagesIfMemoryOverrideChanged(processed, messages, 'model', revision, 'one');
    assert.equal(refreshed.processedMessages.at(-1).content, 'Updated revision');
    assert.notEqual(refreshed.memoryGenerationAtProcess, revision);
    app.clearMemoryApiOverrideContent('one');
    assert.equal(app.refreshProcessedMessagesIfMemoryOverrideChanged(refreshed.processedMessages, messages, 'model', refreshed.memoryGenerationAtProcess, 'one').processedMessages.at(-1).content, 'Original prompt');
});

test('a global Memory-off generation invalidates every pending private override', () => {
    const app = harness();
    app.setMemoryApiOverrideContent('Private one', 1, 'one');
    app.setMemoryApiOverrideContent('Private two', 1, 'two');
    app.memoryFeatureEnabled = false;
    app.memoryWorkGeneration += 1;
    assert.equal(app.getMemoryApiOverrideContent('one'), null);
    assert.equal(app.getMemoryApiOverrideContent('two'), null);
    assert.equal(app.memoryApiOverrides.size, 0);
    assert.equal(app.setMemoryApiOverrideContent('Late result', 1, 'one'), false);
});

test('composer refreshes preserve animated nodes and navigation cannot send into a half-loaded chat', () => {
    const app = harness();
    let writes = 0;
    let html = '';
    const attributes = new Map();
    const sendBtn = {
        dataset: {}, disabled: false,
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute: (key, value) => attributes.set(key, value),
        set innerHTML(value) { writes += 1; html = value; },
        get innerHTML() { return html; }
    };
    app.elements = { messageInput: { value: 'Next draft', disabled: false, placeholder: '' }, sendBtn };
    app.uploadedFiles = [];
    app.sendSubmissionsInFlight = new Map();
    app.exclusiveSessionMutationOwners = new Map();
    app.getSessionStreamingState = () => ({ phase: 'preparing-access' });
    let isStreaming = false;
    app.isCurrentSessionStreaming = () => isStreaming;
    app.sessionSwitchInFlight = { sessionId: 'two' };
    app.updateInputState();
    assert.equal(app.elements.messageInput.disabled, true);
    assert.equal(sendBtn.disabled, true);
    assert.equal(attributes.get('aria-label'), 'Loading selected chat');
    assert.equal(app.elements.messageInput.placeholder, 'Loading selected chat…');
    const busyMarkup = html;
    app.updateInputState();
    assert.equal(writes, 1);
    assert.equal(html, busyMarkup);
    app.sessionSwitchInFlight = null;
    isStreaming = true;
    app.updateInputState();
    assert.equal(writes, 1, 'another busy phase keeps the same animation node');
    assert.equal(app.elements.messageInput.disabled, false);
    assert.equal(sendBtn.disabled, false, 'preparation remains cancelable');
    assert.equal(attributes.get('aria-label'), 'Cancel preparation');
    app.getSessionStreamingState = () => ({ phase: 'waiting-response' });
    app.updateInputState();
    assert.equal(writes, 2);
    assert.equal(attributes.get('aria-label'), 'Stop response');
    app.updateInputState();
    assert.equal(writes, 2);
    isStreaming = false;
    app.updateInputState();
    app.updateInputState();
    assert.equal(writes, 3, 'idle button also retains its descendants');
    assert.equal(attributes.get('aria-label'), 'Send message');
});
