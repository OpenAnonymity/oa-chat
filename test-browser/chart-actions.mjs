import ChatArea from '../chat/components/ChatArea.js';
import { buildMessageHTML } from '../chat/components/MessageTemplates.js';
import { getMessageCopyText } from '../chat/domain/chartArtifacts.js';

// Real DOM/clipboard fixture. Only synthetic values; no app boot or network.
const helpers = { processContentWithLatex: text => text, formatTime: () => '' };
const artifact = title => ({ version: 1, type: 'chart', spec: { chartType: 'bar', title,
    xLabels: ['Jan', 'Feb', 'Mar'], series: [{ name: 'Spend', values: [412, 388, 455] }], yAxisTitle: 'USD' } });
const single = { id: 'single', role: 'assistant', content: '', model: 'Test', timestamp: 1, artifacts: [artifact('Monthly spend')] };
const parallel = { id: 'parallel', role: 'assistant', content: '', model: 'Parallel', timestamp: 1,
    council: { enabled: true, currentStage: 'stage1', stage1: ['primary', 'secondary'].map((laneId, i) => ({
        laneId, label: `Response ${i + 1}`, model: `Model ${i + 1}`, response: '', status: 'complete', artifacts: [artifact(`Model ${i + 1} chart`)]
    })) } };
const rows = [single, parallel];
const area = Object.assign(Object.create(ChatArea.prototype), { app: {
    getCurrentSession: () => ({ id: 'fixture' }), data: { getSessionMessages: async () => rows },
    showToast: text => { document.querySelector('#results').textContent = text; }
} });
area.showCopySuccess = id => { document.querySelector('#results').textContent = `Copied ${id}`; };
area.animateCopyButton = button => { document.querySelector('#results').textContent = `Copied ${button.dataset.councilLaneId}`; };
document.querySelector('#fixture').innerHTML = rows.map(row => buildMessageHTML(row, helpers, [], 'Test')).join('');
const assertions = [];
for (const row of rows) {
    const el = document.querySelector(`[data-message-id="${row.id}"]`);
    const charts = el.querySelectorAll('[data-chart-copy-text]');
    if (charts.length !== (row.council ? 2 : 1)) throw new Error('Missing rendered chart');
    assertions.push({ id: row.id, charts: charts.length });
}
if (area.getMessageTextFromDOM('single') !== getMessageCopyText(single)) throw new Error('DOM copy lost chart data');
document.addEventListener('click', event => {
    const lane = event.target.closest('.copy-council-lane-btn');
    if (lane) return void area.handleCopyCouncilLane(lane.dataset.messageId, lane.dataset.councilLaneId, lane);
    const copy = event.target.closest('.copy-message-btn');
    if (copy) void area.handleCopyMessage(copy.dataset.messageId);
});
document.querySelector('#results').textContent = JSON.stringify(assertions);
document.title = 'Chart actions PASS';
