import test from 'node:test';
import assert from 'node:assert/strict';
import ChatArea from '../../chat/components/ChatArea.js';
import { getMessageCopyText, formatChartArtifactText } from '../../chat/domain/chartArtifacts.js';
import { processMessagesForApi } from '../../chat/domain/messageContent.js';
import { buildBaseSharePayload } from '../../chat/services/sharePayload.js';

const chart = (title = 'Monthly spend', value = 412) => ({ version: 1, type: 'chart', spec: {
    chartType: 'bar', title, xAxisTitle: 'Month', yAxisTitle: 'USD',
    xLabels: ['Jan', 'Feb'], series: [{ name: 'Spend', values: [value, 388.123456789] }]
} });

test('Copy on chart-only and mixed replies includes the title, units and exact data', async () => {
    for (const content of ['', 'Here is your spending.']) {
        const message = { id: 'answer', content, artifacts: [chart()] };
        const area = Object.create(ChatArea.prototype);
        area.app = { getCurrentSession: () => ({ id: 'chat' }), data: { getSessionMessages: async () => [message] } };
        area.isMessageStreamingInDOM = () => false;
        area.getMessageRawFromDOM = () => null;
        area.getMessageTextFromDOM = () => null;
        let copied, confirmed = false;
        area.copyToClipboard = text => { copied = text; return true; };
        area.showCopySuccess = () => { confirmed = true; };
        await area.handleCopyMessage('answer');
        assert.equal(copied, [content, 'Monthly spend\nValues: USD\nMonth\tSpend\nJan\t412\nFeb\t388.123456789'].filter(Boolean).join('\n\n'));
        assert.equal(confirmed, true);
    }
});

test('lane Copy uses that lane chart instead of the canonical answer', async () => {
    const message = { id: 'answer', artifacts: [chart('Other lane', 999)], council: { stage1: [
        { laneId: 'primary', response: '', artifacts: [chart('Chosen lane', 123)] }
    ] } };
    const area = Object.create(ChatArea.prototype);
    area.app = { getCurrentSession: () => ({ id: 'chat' }), data: { getSessionMessages: async () => [message] } };
    let copied;
    area.copyToClipboard = text => { copied = text; };
    area.animateCopyButton = () => {};
    await area.handleCopyCouncilLane('answer', 'primary', {});
    assert.match(copied, /Chosen lane/);
    assert.match(copied, /Jan\t123/);
    assert.doesNotMatch(copied, /Other lane|999/);
});

test('chart history becomes ordinary text for a model without tool support', () => {
    const messages = [{ role: 'assistant', content: '', artifacts: [chart()] }, { role: 'user', content: 'What changed?' }];
    const plain = processMessagesForApi(messages, 'text-only', { supportsClientTools: false });
    assert.equal(plain.length, 2);
    assert.equal(plain[0].content, formatChartArtifactText(chart()));
    assert.equal(plain[0].tool_calls, undefined);
    const capable = processMessagesForApi(messages, 'tool-model', { supportsClientTools: true });
    assert.deepEqual(capable.map(m => m.role), ['assistant', 'tool', 'user']);
});

test('share export validates each lane chart without changing the source message', () => {
    const message = { role: 'assistant', council: { stage1: [
        { artifacts: [chart()] }, { artifacts: [{ version: 1, type: 'chart', spec: { malicious: true } }] }
    ], synthesis: { artifacts: [chart('Review')] } } };
    const before = structuredClone(message);
    const shared = buildBaseSharePayload({}, [message]).messages[0];
    assert.equal(shared.council.stage1[0].artifacts.length, 1);
    assert.equal(shared.council.stage1[1].artifacts, undefined);
    assert.equal(shared.council.synthesis.artifacts[0].spec.title, 'Review');
    assert.deepEqual(message, before);
    assert.equal(getMessageCopyText({ content: 'Plain', artifacts: [{ bad: true }] }), 'Plain');
});

test('chart lane Copy starts synchronously without reading storage', async () => {
    const area = Object.create(ChatArea.prototype);
    area.app = { data: { getSessionMessages: () => { throw new Error('must not read storage'); } } };
    const text = formatChartArtifactText(chart());
    let copied = null, confirmed = false;
    area.copyToClipboard = value => { copied = value; return true; };
    area.animateCopyButton = () => { confirmed = true; };
    const pending = area.handleCopyCouncilLane('answer', 'primary', { getAttribute: name => name === 'data-chart-response-copy' ? text : null });
    assert.equal(copied, text, 'clipboard call occurs in the click turn');
    await pending;
    assert.equal(confirmed, true);
});

test('a rejected clipboard write reports failure without a success checkmark', async () => {
    const area = Object.create(ChatArea.prototype);
    let toast, confirmed = false;
    area.app = { showToast: text => { toast = text; } };
    area.copyToClipboard = () => Promise.resolve(false);
    assert.equal(await area.copyTextWithFeedback('chart', () => { confirmed = true; }), false);
    assert.equal(confirmed, false);
    assert.match(toast, /Could not copy/);
});


test('multiple charts survive Copy, sharing and tool/text history with unique replay IDs', () => {
    const artifacts = [chart('First'), chart('Second', 700)];
    artifacts.forEach(a => { a.toolCallId = 'duplicate'; });
    const message = { role: 'assistant', content: 'Both charts.', artifacts,
        council: { stage1: [{ laneId: 'primary', artifacts }], synthesis: { artifacts } } };
    const copy = getMessageCopyText(message);
    assert.match(copy, /First[\s\S]*Second[\s\S]*700/);
    const shared = buildBaseSharePayload({}, [message]).messages[0];
    assert.equal(shared.artifacts.length, 2);
    assert.equal(shared.council.stage1[0].artifacts.length, 2);
    assert.equal(shared.council.synthesis.artifacts.length, 2);
    const history = processMessagesForApi([message], 'tool-model');
    assert.deepEqual(history.map(m => m.role), ['assistant', 'tool', 'tool']);
    assert.equal(history[0].tool_calls.length, 2);
    assert.notEqual(history[1].tool_call_id, history[2].tool_call_id);
    assert.deepEqual(history[0].tool_calls.map(c => c.id), history.slice(1).map(m => m.tool_call_id));
    assert.equal(processMessagesForApi([message], 'plain', { supportsClientTools: false })[0].content, copy);
});
