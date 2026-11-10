import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CHART_TOOL_NAME,
    CHART_TYPES,
    MAX_CHART_POINTS,
    MAX_CHART_SERIES,
    RENDER_CHART_TOOL,
    createChartArtifactFromToolCall,
    createChartArtifactTranscript,
    extractChartArtifactsFromToolCalls,
    applyChartToolResult,
    MAX_CHARTS_PER_MESSAGE,
    getMessageChartArtifact,
    modelSupportsClientTools,
    normalizeChartArtifacts,
    normalizeMessageChartArtifacts,
    validateChartSpec
} from '../../chat/domain/chartArtifacts.js';

const GOOD = {
    chartType: 'bar', title: 'Monthly spend', xLabels: ['Jan', 'Feb', 'Mar'],
    series: [{ name: 'Spend', values: [12, 18, 9] }], yAxisTitle: 'USD'
};
const call = (args, extra = {}) => ({ id: 'call_1', type: 'function', function: { name: CHART_TOOL_NAME, arguments: args }, ...extra });

test('the advertised schema and the validator agree on types, enums and limits', () => {
    const parameters = RENDER_CHART_TOOL.function.parameters;
    assert.equal(RENDER_CHART_TOOL.function.name, CHART_TOOL_NAME);
    assert.deepEqual(parameters.required, ['chartType', 'title', 'xLabels', 'series']);
    assert.deepEqual(parameters.properties.chartType.enum, CHART_TYPES);
    assert.equal(parameters.properties.series.maxItems, MAX_CHART_SERIES);
    assert.equal(parameters.properties.xLabels.maxItems, MAX_CHART_POINTS);
    assert.equal(parameters.additionalProperties, false);
    assert.ok(Object.isFrozen(parameters.properties));
});

test('a well-formed spec is accepted and cleaned', () => {
    const { spec, error } = validateChartSpec({ ...GOOD, title: '  Monthly spend  ', xLabels: ['Jan', 2024, 'Mar'] });
    assert.equal(error, undefined);
    assert.deepEqual(spec, { chartType: 'bar', title: 'Monthly spend', xLabels: ['Jan', '2024', 'Mar'],
        series: [{ name: 'Spend', values: [12, 18, 9] }], yAxisTitle: 'USD' });
});

test('numeric strings are read as numbers; anything non-finite is refused', () => {
    assert.deepEqual(validateChartSpec({ ...GOOD, series: [{ name: 'S', values: ['1', '2.5', 3] }] }).spec.series[0].values, [1, 2.5, 3]);
    for (const bad of [[1, 'x', 3], [1, undefined, 3], [1, Infinity, 3], [1, NaN, 3], [1, '', 3]]) {
        assert.match(validateChartSpec({ ...GOOD, series: [{ name: 'S', values: bad }] }).error, /not a finite number/);
    }
});

test('each structural rule is enforced with its own reason', () => {
    const cases = [
        [null, /not an object/],
        [{ ...GOOD, chartType: 'radar' }, /Unsupported chart type/],
        [{ ...GOOD, title: '' }, /needs a title/],
        [{ ...GOOD, xLabels: 'Jan' }, /xLabels must be a list/],
        [{ ...GOOD, xLabels: [{}, 'b', 'c'] }, /x label must be a string/],
        [{ ...GOOD, series: [] }, /at least one series/],
        [{ ...GOOD, series: Array.from({ length: MAX_CHART_SERIES + 1 }, () => ({ name: 's', values: [1, 2, 3] })) }, /more than/],
        [{ ...GOOD, series: [{ name: '', values: [1, 2, 3] }] }, /needs a name/],
        [{ ...GOOD, series: [{ name: 'S', values: [1, 2] }] }, /2 values for 3 labels/],
        [{ ...GOOD, chartType: 'pie', series: [{ name: 'A', values: [1, 2, 3] }, { name: 'B', values: [1, 2, 3] }] }, /exactly one series/],
        [{ ...GOOD, chartType: 'pie', series: [{ name: 'A', values: [1, -2, 3] }] }, /negative/],
        [{ ...GOOD, xLabels: [], series: [{ name: 'S', values: [] }] }, /no data points/],
        [{ ...GOOD, xLabels: Array(MAX_CHART_POINTS + 1).fill('x'), series: [{ name: 'S', values: Array(MAX_CHART_POINTS + 1).fill(1) }] }, /more than/]
    ];
    for (const [input, pattern] of cases) assert.match(validateChartSpec(input).error, pattern, JSON.stringify(input).slice(0, 80));
});

test('unknown fields are dropped rather than stored', () => {
    const { spec } = validateChartSpec({ ...GOOD, html: '<script>', onclick: 'x', series: [{ name: 'S', values: [1, 2, 3], color: 'red' }] });
    assert.deepEqual(Object.keys(spec).sort(), ['chartType', 'series', 'title', 'xLabels', 'yAxisTitle']);
    assert.deepEqual(Object.keys(spec.series[0]), ['name', 'values']);
});

test('a tool call becomes an artifact, and every failure is a readable error', () => {
    const { artifact, error } = createChartArtifactFromToolCall(call(JSON.stringify(GOOD)));
    assert.equal(error, null);
    assert.equal(artifact.version, 1);
    assert.equal(artifact.type, 'chart');
    assert.equal(artifact.toolCallId, 'call_1');
    assert.equal(artifact.spec.title, 'Monthly spend');

    assert.match(createChartArtifactFromToolCall(call('{"chartType":')).error, /not valid JSON/);
    assert.match(createChartArtifactFromToolCall(call('{}')).error, /Unsupported chart type/);
    assert.match(createChartArtifactFromToolCall(call('{}', { invalidReason: 'Tool arguments exceeded the client limit.' })).error, /exceeded/);
    assert.match(createChartArtifactFromToolCall({ id: 'x', type: 'function', function: { name: 'render_html', arguments: '{}' } }).error, /unknown tool "render_html"/);
    assert.match(createChartArtifactFromToolCall('nope').error, /malformed/);
});

test('multiple charts preserve valid siblings and report malformed and excess calls', () => {
    assert.deepEqual(extractChartArtifactsFromToolCalls([]), { artifacts: [], error: null });
    const calls = [call(JSON.stringify(GOOD)), call('bad JSON'), call(JSON.stringify({ ...GOOD, title: 'Second' }))];
    const message = { content: '', pendingArtifact: 'chart' };
    applyChartToolResult(message, calls);
    assert.deepEqual(message.artifacts.map(a => a.spec.title), ['Monthly spend', 'Second']);
    assert.match(message.content, /Some charts could not be shown: Chart 2:.*not valid JSON/);
    assert.equal(message.pendingArtifact, undefined);
    const allValid = extractChartArtifactsFromToolCalls([calls[0], calls[2]]);
    assert.equal(allValid.artifacts.length, 2);
    assert.equal(allValid.error, null);
    const excess = extractChartArtifactsFromToolCalls(Array(MAX_CHARTS_PER_MESSAGE + 1).fill(calls[0]));
    assert.equal(excess.artifacts.length, MAX_CHARTS_PER_MESSAGE);
    assert.match(excess.error, /remaining charts/);
    const invalid = { content: '' };
    applyChartToolResult(invalid, [null, call('{}')]);
    assert.match(invalid.content, /The chart could not be shown/);
    assert.equal(invalid.artifacts, undefined);
});

test('stored artifacts are normalized, foreign types dropped, and valid charts kept in order', () => {
    const chart = { version: 1, type: 'chart', spec: GOOD, toolCallId: 'call_9' };
    assert.deepEqual(normalizeChartArtifacts([{ version: 1, type: 'html', source: '<p>' }, { version: 2, type: 'chart', spec: GOOD }, chart, chart]).map(a => a.toolCallId), ['call_9', 'call_9']);
    assert.deepEqual(normalizeChartArtifacts('junk'), []);
    const message = { role: 'assistant', content: 'x', artifacts: [{ version: 1, type: 'chart', spec: { ...GOOD, chartType: 'nope' } }] };
    normalizeMessageChartArtifacts(message);
    assert.equal('artifacts' in message, false);
    assert.equal(getMessageChartArtifact({ artifacts: [chart] }).spec.title, 'Monthly spend');
    assert.equal(getMessageChartArtifact({}), null);
});

test('the transcript replays the call and a tool result with a stable id', () => {
    const [assistant, tool] = createChartArtifactTranscript({ version: 1, type: 'chart', spec: GOOD }, 4);
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.content, null);
    assert.equal(assistant.tool_calls[0].id, 'chart_4');
    assert.equal(assistant.tool_calls[0].function.name, CHART_TOOL_NAME);
    assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), GOOD);
    assert.equal(tool.role, 'tool');
    assert.equal(tool.tool_call_id, 'chart_4');
    assert.match(tool.content, /Rendered a bar chart titled "Monthly spend"/);
    assert.equal(createChartArtifactTranscript({ version: 1, type: 'chart', spec: GOOD, toolCallId: 'call_z' })[0].tool_calls[0].id, 'call_z');
});

test('only catalog entries that declare tools are offered the chart tool', () => {
    assert.equal(modelSupportsClientTools({ supported_parameters: ['tools', 'temperature'] }), true);
    assert.equal(modelSupportsClientTools({ supported_parameters: ['temperature'] }), false);
    assert.equal(modelSupportsClientTools({}), false);
    assert.equal(modelSupportsClientTools(null), false);
});


test('missing line/bar values retain their positions; all-missing charts and incomplete pies fail', () => {
    for (const chartType of ['line', 'bar']) {
        const input = { ...GOOD, chartType, series: [{ name: 'High', values: [9, 7, 5] }, { name: 'Low', values: [null, 2, null] }] };
        const { spec } = validateChartSpec(input);
        assert.deepEqual(spec.series[1].values, [null, 2, null]);
        assert.deepEqual(normalizeChartArtifacts([{ version: 1, type: 'chart', spec }])[0].spec, spec);
        assert.deepEqual(JSON.parse(createChartArtifactTranscript({ spec })[0].tool_calls[0].function.arguments), spec);
    }
    assert.match(validateChartSpec({ ...GOOD, series: [{ name: 'Missing', values: [null, null, null] }] }).error, /no available numeric values/);
    assert.match(validateChartSpec({ ...GOOD, chartType: 'pie', series: [{ name: 'Shares', values: [1, null, 3] }] }).error, /not a finite number/);
    assert.ok(validateChartSpec({ ...GOOD, chartType: 'line', series: [
        { name: 'Known', values: [0, 2, 3] }, { name: 'Missing', values: [null, null, null] }
    ] }).spec);
});
