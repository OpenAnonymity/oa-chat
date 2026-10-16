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
const checkReasoningOrder = () => {
    const row = stage.querySelector('[data-message-id="synthetic"]');
    const model = row.querySelector('[data-assistant-model-name]');
    const trace = row.querySelector('#reasoning-synthetic');
    const answer = row.querySelector('.message-content');
    check(model && trace && answer, 'missing model, reasoning or answer');
    check(model.compareDocumentPosition(trace) & Node.DOCUMENT_POSITION_FOLLOWING,
        'reasoning appeared above the model name');
    check(trace.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
        'reasoning appeared below the answer');
    check(model.getBoundingClientRect().bottom <= trace.getBoundingClientRect().top,
        'reasoning visually overlaps the model header');
    check(trace.getBoundingClientRect().bottom <= answer.getBoundingClientRect().top,
        'reasoning visually overlaps the answer');
};
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
    checkReasoningOrder();
    await delay(200);
    check(!line(), 'line remains during thinking');
    area.settleReasoningDisplay(message.id, 'Checking a source after answering.', 2000);
    check(header()?.textContent === 'Thought for 2s', 'header did not settle at answer');
    checkReasoningOrder();
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
    checkReasoningOrder();
    check(line()?.dataset.reveal === 'shown', 'return to stalled chat lost the line');
    signal.dispose();
    await delay(200);
    check(!line() && app.streamingReplyDisplays.size === 0, 'completion did not remove live state');
    // Start a fresh synthetic turn for hidden reasoning after an answer.
    area.settledReasoningIds.clear();
    delete message.reasoning;
    render();
    area.updateWithheldReasoning(message.id, true);
    check(header()?.textContent === 'Thinking...', 'hidden reasoning has no header');
    checkReasoningOrder();
    check(!document.getElementById('reasoning-content-synthetic'), 'hidden reasoning exposes a trace');
    area.settleThinkingHeader(message.id, 3000);
    check(header()?.textContent === 'Thought for 3s', 'hidden header failed to settle');
    checkReasoningOrder();
    area.updateStreamingReasoning(message.id, 'Now showing the reasoning.');
    check(stage.querySelectorAll('#reasoning-synthetic').length === 1, 'hidden-to-visible duplicates headers');
    check(document.getElementById('reasoning-content-synthetic'), 'hidden-to-visible trace missing');
    checkReasoningOrder();
    area.settleReasoningDisplay(message.id, 'Now showing the reasoning.', 3000);
    // Late headers also work without a text bubble and preserve an access trace.
    area.settledReasoningIds.clear();
    render();
    const modelHeader = stage.querySelector('[data-assistant-header]');
    modelHeader.insertAdjacentHTML('afterend', '<div class="kept-access-trace">Private access ready</div>');
    stage.querySelector('.message-content').closest('.message-assistant').remove();
    area.updateWithheldReasoning(message.id, true);
    check(modelHeader.nextElementSibling.classList.contains('kept-access-trace'), 'access trace moved ahead of model');
    check(modelHeader.nextElementSibling.nextElementSibling.id === 'reasoning-synthetic', 'textless reply misplaced reasoning');
    area.updateStreamingReasoning(message.id, 'Reasoning without a text bubble.');
    check(modelHeader.nextElementSibling.nextElementSibling.id === 'reasoning-synthetic', 'textless replacement misplaced reasoning');
    check(document.getElementById('reasoning-content-synthetic'), 'textless visible trace missing');
    area.settleReasoningDisplay(message.id, 'Reasoning without a text bubble.', 3000);
    // Leave the screenshot in the reported state: model, brief Thought, answer.
    render();
    area.updateWithheldReasoning(message.id, false, 200);
    checkReasoningOrder();
    // Parallel uses the same header and fade implementation.
    stage.insertAdjacentHTML('beforeend', '<div data-message-id="parallel"><div class="council-response-panel" data-council-lane-id="secondary"><div class="council-response-body"></div></div></div>');
    area.updateWithheldReasoning('parallel', true, null, 'secondary');
    check(document.getElementById('reasoning-subtitle-parallel-secondary')?.textContent === 'Thinking...', 'parallel hidden header missing');
    area.updateWithheldReasoning('parallel', false, 3000, 'secondary');
    check(document.getElementById('reasoning-subtitle-parallel-secondary')?.textContent === 'Thought for 3s', 'parallel hidden header failed to settle');
    area.ensureCouncilLaneReasoningTrace('parallel', 'secondary');
    check(stage.querySelectorAll('#reasoning-parallel-secondary').length === 1, 'parallel hidden-to-visible reasoning duplicates headers');
    check(document.getElementById('reasoning-content-parallel-secondary'), 'parallel visible reasoning missing');
    output.textContent = 'PASS: delay, fade, resumed thinking, hidden thinking, chat return, cleanup, Parallel headers and model → reasoning → answer order.';
}
document.querySelector('#run').onclick = () => run().catch(error => { output.textContent = `FAIL: ${error.message}`; signal?.dispose(); });
