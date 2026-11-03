import ChatArea from '../chat/components/ChatArea.js';
import { buildMessageHTML } from '../chat/components/MessageTemplates.js';

// Browser regression for a chart arriving after the message row was mounted.
// Bundle this entry for a local fixture; no app boot, credentials or network.
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const helpers = { processContentWithLatex: text => text, formatTime: () => '' };
const artifact = { version: 1, type: 'chart', spec: { chartType: 'bar', title: 'Monthly spend',
    xLabels: ['Jan', 'Feb'], series: [{ name: 'Spend', values: [412, 388] }] } };
const base = { id: 'chart-layout', role: 'assistant', model: 'Test', timestamp: 1,
    reasoning: 'Compare the supplied values.', reasoningDuration: 1, streamingReasoning: false };
window.buildMessageHTML = buildMessageHTML;
const area = Object.assign(Object.create(ChatArea.prototype), {
    settledReasoningIds: new Map(),
    app: { state: { models: [] }, getCurrentSession: () => ({ model: 'Test' }),
        processContentWithLatex: helpers.processContentWithLatex, formatTime: helpers.formatTime }
});
const fixture = document.querySelector('#fixture');
const results = [];
for (const content of ['', 'Here is the comparison.']) {
    const name = content ? 'text then chart' : 'reasoning then chart without text';
    try {
        const pending = { ...base, content, streamingTokens: 0 };
        fixture.innerHTML = buildMessageHTML(pending, helpers, [], 'Test');
        const row = fixture.firstElementChild;
        const reasoning = row.querySelector('.reasoning-trace');
        area.showPendingArtifact(base.id);
        const slot = row.querySelector('[data-message-chart]');
        const placeholder = row.querySelector('.assistant-actions-anchor');
        assert(slot.parentElement === placeholder.parentElement, 'chart escaped the message content group');
        assert(slot.compareDocumentPosition(placeholder) & Node.DOCUMENT_POSITION_FOLLOWING, 'actions precede pending chart');
        const complete = { ...base, content, streamingTokens: null, artifacts: [artifact] };
        await area.finalizeStreamingMessage(complete);
        const chart = row.querySelector('[data-message-chart]');
        const actions = row.querySelector('.assistant-actions-row');
        assert(row.querySelector('.reasoning-trace') === reasoning, 'targeted completion replaced reasoning');
        assert(actions && chart.parentElement === actions.parentElement, 'chart/actions have different parents');
        assert(chart.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING, 'actions precede finished chart');
        assert(chart.getBoundingClientRect().bottom <= actions.getBoundingClientRect().top + 5, 'buttons overlap the chart');
        fixture.innerHTML = buildMessageHTML(complete, helpers, [], 'Test');
        const restoredChart = fixture.querySelector('[data-message-chart]');
        const restoredActions = fixture.querySelector('.assistant-actions-row');
        assert(restoredChart.compareDocumentPosition(restoredActions) & Node.DOCUMENT_POSITION_FOLLOWING, 'restored actions precede chart');
        results.push({ name, result: 'PASS' });
    } catch (error) { results.push({ name, result: 'FAIL', error: error.message }); }
}
document.querySelector('#results').textContent = JSON.stringify(results, null, 2);
document.title = results.every(result => result.result === 'PASS') ? 'Chart layout PASS' : 'Chart layout FAIL';
