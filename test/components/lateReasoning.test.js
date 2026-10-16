import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the actual send/regenerate callbacks with a deterministic provider and
// storage fixture. The packaged Electron test separately covers their DOM.
const source = fs.readFileSync('chat/app.js', 'utf8');
const callbacks = [...source.matchAll(/async \(reasoningChunk, meta\) => \{([\s\S]*?)\n                    \},\n                    (retryReasoningEnabled|submission.reasoningEnabled)/g)];
assert.equal(callbacks.length, 2);
for (const [index, match] of callbacks.entries()) {
    const label = index === 0 ? 'regenerate' : 'send';
    function fixture(firstChunkReceived = true, visible = true) {
        const saved = [], rendered = [], appended = [];
        const context = vm.createContext({
            stopped: false, turnStopped() { return context.stopped; },
            stillWorking: { clear() {} }, streamOpenedAt: null,
            firstChunkReceived, reasoningStartTime: null, reasoningEndTime: 123,
            firstContentChunk: false, streamedReasoning: '', streamedContent: 'Partial answer.',
            streamingMessage: { id: 'test', content: '', streamingReasoning: false },
            streamingMessageId: 'test', session: { id: 'session' }, typingId: null,
            chatDB: { async saveMessage(message) { saved.push(structuredClone(message)); } },
            markPendingTurnStarted() {}, isViewingSession() { return visible; },
            chatArea: { async appendMessage(message) { appended.push(structuredClone(message)); }, updateStreamingReasoning(id, text) { rendered.push({ id, text }); } },
        });
        const run = vm.runInContext(`(async (reasoningChunk, meta) => {${match[1]}\n})`, context);
        return { context, run, saved, rendered, appended };
    }
    test(`${label}: reasoning after answer starts the phase without appending a duplicate message`, async () => {
        const f = fixture(); await f.run('Checking the answer.');
        assert.ok(f.context.reasoningStartTime > 0);
        assert.equal(f.context.reasoningEndTime, null);
        assert.equal(f.context.streamingMessage.streamingReasoning, true);
        assert.equal(f.saved.at(-1).reasoning, 'Checking the answer.');
        assert.equal(f.saved.at(-1).content, 'Partial answer.');
        assert.equal(f.saved.at(-1).streamingReasoning, true);
        assert.equal(f.appended.length, 0);
        assert.equal(f.rendered.at(-1).text, 'Checking the answer.');
        await f.run(' Still checking.');
        assert.equal(f.context.streamedReasoning, 'Checking the answer. Still checking.');
    });
    test(`${label}: hidden session persists a newly active phase without updating the visible chat`, async () => {
        const f = fixture(true, false); await f.run('Background reasoning.');
        assert.equal(f.saved.at(-1).streamingReasoning, true);
        assert.equal(f.saved.at(-1).content, 'Partial answer.');
        assert.equal(f.rendered.length, 0); assert.equal(f.appended.length, 0);
    });
    test(`${label}: reasoning before answer still appends once; empty chunks do not start thinking`, async () => {
        const f = fixture(false); await f.run(''); assert.equal(f.saved.length, 0);
        await f.run('First thought.'); await f.run(' More.');
        assert.equal(f.appended.length, 1); assert.equal(f.context.firstChunkReceived, true);
        assert.equal(f.context.streamedReasoning, 'First thought. More.');
    });
    test(`${label}: late reasoning after Stop cannot save or repaint the preserved answer`, async () => {
        const f = fixture();
        f.context.stopped = true;
        await f.run('Late reasoning.');
        assert.equal(f.saved.length, 0);
        assert.equal(f.rendered.length, 0);
        assert.equal(f.appended.length, 0);
        assert.equal(f.context.reasoningStartTime, null);
    });
}
