// Local browser regression fixture: real controller signal, ChatArea methods,
// message template and shipped styles; synthetic text, no network or wallet.
import { ChatApp } from '../../chat/app.js';
import ChatArea from '../../chat/components/ChatArea.js';
import { buildMessageHTML } from '../../chat/components/MessageTemplates.js';
const output = document.querySelector('#result');
const stage = document.querySelector('#stage');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, text) => { if (!condition) throw new Error(text); };
const app = Object.assign(Object.create(ChatApp.prototype), {
    state: { currentSessionId: 'one' }, processContentWithLatex: text => text,
    updateActivePromptScrollSpacer() {}, updateScrollButtonVisibility() {}
});
const area = Object.assign(Object.create(ChatArea.prototype), {
    app, settledReasoningIds: new Map(), councilReasoningStreams: new Map(),
    reasoningBuffer: { content: '', messageId: null, timeout: null },
    typewriter: { interval: null, targetContent: '', displayedLength: 0, tickMs: 100, charsPerTick: 10 }
});
app.chatArea = area;
const message = { id: 'synthetic', sessionId: 'one', role: 'assistant', content: 'Here is the first part of the answer.',
    streamingTokens: 10, streamingReasoning: false, timestamp: Date.now(), model: 'Test model' };
const render = () => { stage.innerHTML = buildMessageHTML({ ...message, ...app.getStreamingReplyDisplay(message.id, 'one') },
    { processContentWithLatex: text => text, formatTime: () => '' }, [], 'Test model'); };
const line = () => stage.querySelector('.message-still-working');
const header = () => document.getElementById('reasoning-subtitle-synthetic');
let signal;
async function run() {
    signal?.dispose();
    area.stopTypewriter();
    area.settledReasoningIds.clear();
    area.councilReasoningStreams.clear();
    delete message.reasoning;
    delete message.reasoningDuration;
    app.state.currentSessionId = 'one';
    output.textContent = 'Checking one-second pause…';
    render();
    signal = app.createStillWorkingSignal(message, 'one', () => false);
    signal.arm();
    await delay(700);
    check(!line(), 'line appeared before one second');
    await delay(450);
    check(line()?.dataset.reveal === 'shown', 'line missing after one second');
    signal.clear();
    area.updateStreamingReasoning(message.id, 'Checking a source after answering.');
    check(header()?.textContent === 'Thinking...', 'first reasoning after text has no header');
    await delay(200);
    check(!line(), 'line remains during thinking');
    area.settleReasoningDisplay(message.id, 'Checking a source after answering.', 2000);
    check(header()?.textContent === 'Thought for 2s', 'header did not settle at answer');
    message.reasoning = 'Checking a source after answering.';
    message.reasoningDuration = 2000;
    app.state.currentSessionId = 'other';
    stage.innerHTML = '<p>Another chat</p>';
    signal.arm();
    await delay(1100);
    check(!line(), 'line leaked to another chat');
    app.state.currentSessionId = 'one';
    render();
    app.restoreStreamingReplyDisplays('one');
    check(line()?.dataset.reveal === 'shown', 'return to stalled chat lost the line');
    signal.dispose();
    await delay(200);
    check(!line() && app.streamingReplyDisplays.size === 0, 'completion did not remove live state');
    // First hidden reasoning after an answer needs a header with no disclosure.
    delete message.reasoning;
    render();
    area.updateWithheldReasoning(message.id, true);
    check(header()?.textContent === 'Thinking...', 'hidden reasoning has no header');
    check(!document.getElementById('reasoning-content-synthetic'), 'hidden reasoning exposes a trace');
    area.settleThinkingHeader(message.id, 3000);
    check(header()?.textContent === 'Thought for 3s', 'hidden header failed to settle');
    // Parallel uses the same header and fade implementation.
    stage.insertAdjacentHTML('beforeend', '<div data-message-id="parallel"><div class="council-response-panel" data-council-lane-id="secondary"><div class="council-response-body"></div></div></div>');
    area.updateWithheldReasoning('parallel', true, null, 'secondary');
    check(document.getElementById('reasoning-subtitle-parallel-secondary')?.textContent === 'Thinking...', 'parallel hidden header missing');
    area.updateWithheldReasoning('parallel', false, 3000, 'secondary');
    check(document.getElementById('reasoning-subtitle-parallel-secondary')?.textContent === 'Thought for 3s', 'parallel hidden header failed to settle');
    area.ensureCouncilLaneReasoningTrace('parallel', 'secondary');
    check(stage.querySelectorAll('#reasoning-parallel-secondary').length === 1, 'parallel hidden-to-visible reasoning duplicates headers');
    check(document.getElementById('reasoning-content-parallel-secondary'), 'parallel visible reasoning missing');
    output.textContent = 'PASS: delay, fade, resumed thinking, hidden thinking, chat return, cleanup and Parallel headers.';
}
document.querySelector('#run').onclick = () => run().catch(error => { output.textContent = `FAIL: ${error.message}`; signal?.dispose(); });
