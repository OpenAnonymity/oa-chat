// Client-rendered charts ("generative UI", first increment).
//
// A supported model calls the `render_chart` function with a small typed
// spec; the browser validates it here and renders it with a vendored chart
// library. The model never produces markup. The spec is stored on the
// message as a versioned artifact and is replayed to later turns as an
// assistant tool call plus a tool result, so the provider sees that the
// chart was rendered locally. Nothing in this module touches the network.

export const CHART_TOOL_NAME = 'render_chart';
export const CHART_ARTIFACT_VERSION = 1;
export const CHART_ARTIFACT_TYPE = 'chart';

export const CHART_TYPES = Object.freeze(['bar', 'line', 'pie']);
export const MAX_CHART_SERIES = 8;
export const MAX_CHART_POINTS = 500;
export const MAX_CHART_LABEL_LENGTH = 80;
export const MAX_CHART_TITLE_LENGTH = 120;
export const MAX_CHART_SPEC_BYTES = 64 * 1024;
const MAX_TOOL_CALL_ID_LENGTH = 200;

export const CHART_TOOL_SYSTEM_INSTRUCTIONS =
    'When the answer is a set of numbers that a reader would compare or follow over time ' +
    '(a trend, a breakdown, a comparison across categories), call render_chart once with the ' +
    'data instead of describing every value in prose. Keep any accompanying text short. ' +
    'Do not call render_chart for a single number, for data you would have to invent, or when ' +
    'a sentence or a short table already answers the question.';

export const RENDER_CHART_TOOL = Object.freeze({
    type: 'function',
    function: Object.freeze({
        name: CHART_TOOL_NAME,
        description: 'Render one chart in the chat from the numbers provided. Use bar for comparisons ' +
            'across categories, line for values over an ordered axis such as time, pie for shares ' +
            'of a whole (one series only).',
        parameters: Object.freeze({
            type: 'object',
            additionalProperties: false,
            required: Object.freeze(['chartType', 'title', 'xLabels', 'series']),
            properties: Object.freeze({
                chartType: Object.freeze({ type: 'string', enum: CHART_TYPES }),
                title: Object.freeze({ type: 'string', maxLength: MAX_CHART_TITLE_LENGTH,
                    description: 'Short descriptive title.' }),
                xLabels: Object.freeze({
                    type: 'array', maxItems: MAX_CHART_POINTS,
                    items: Object.freeze({ type: 'string', maxLength: MAX_CHART_LABEL_LENGTH }),
                    description: 'One label per value position, in order (dates, categories, buckets).'
                }),
                series: Object.freeze({
                    type: 'array', minItems: 1, maxItems: MAX_CHART_SERIES,
                    items: Object.freeze({
                        type: 'object',
                        additionalProperties: false,
                        required: Object.freeze(['name', 'values']),
                        properties: Object.freeze({
                            name: Object.freeze({ type: 'string', maxLength: MAX_CHART_LABEL_LENGTH }),
                            values: Object.freeze({
                                type: 'array', maxItems: MAX_CHART_POINTS,
                                items: Object.freeze({ type: 'number' }),
                                description: 'Same length as xLabels.'
                            })
                        })
                    })
                }),
                xAxisTitle: Object.freeze({ type: 'string', maxLength: MAX_CHART_LABEL_LENGTH,
                    description: 'Optional axis title or unit.' }),
                yAxisTitle: Object.freeze({ type: 'string', maxLength: MAX_CHART_LABEL_LENGTH,
                    description: 'Optional axis title or unit.' })
            })
        })
    })
});

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function utf8ByteLength(value) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).byteLength;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(value, 'utf8');
    return unescape(encodeURIComponent(value)).length;
}

function readString(value, maxLength, { required = false } = {}) {
    if (typeof value !== 'string') return required ? null : '';
    const trimmed = value.trim();
    if (required && !trimmed) return null;
    return trimmed.slice(0, maxLength);
}

function normalizeToolCallId(value) {
    if (typeof value !== 'string') return null;
    const id = value.trim();
    if (!id || id.length > MAX_TOOL_CALL_ID_LENGTH) return null;
    return id;
}

/**
 * Validates a raw spec against the shape `RENDER_CHART_TOOL` promises the
 * model. Returns `{ spec }` with a cleaned copy or `{ error }` with one
 * human-readable reason. Numbers must be finite; every series must match
 * the label count; a pie chart takes exactly one series.
 */
export function validateChartSpec(value) {
    if (!isPlainObject(value)) return { error: 'The chart specification was not an object.' };

    const chartType = typeof value.chartType === 'string' ? value.chartType.trim() : '';
    if (!CHART_TYPES.includes(chartType)) return { error: `Unsupported chart type "${chartType.slice(0, 32)}".` };

    const title = readString(value.title, MAX_CHART_TITLE_LENGTH, { required: true });
    if (title === null) return { error: 'The chart needs a title.' };

    if (!Array.isArray(value.xLabels)) return { error: 'xLabels must be a list of strings.' };
    if (value.xLabels.length > MAX_CHART_POINTS) return { error: `The chart has more than ${MAX_CHART_POINTS} points.` };
    const xLabels = [];
    for (const label of value.xLabels) {
        if (typeof label !== 'string' && typeof label !== 'number') return { error: 'Every x label must be a string.' };
        xLabels.push(String(label).trim().slice(0, MAX_CHART_LABEL_LENGTH));
    }

    if (!Array.isArray(value.series) || value.series.length === 0) return { error: 'The chart needs at least one series.' };
    if (value.series.length > MAX_CHART_SERIES) return { error: `The chart has more than ${MAX_CHART_SERIES} series.` };
    if (chartType === 'pie' && value.series.length !== 1) return { error: 'A pie chart takes exactly one series.' };

    const series = [];
    for (const entry of value.series) {
        if (!isPlainObject(entry)) return { error: 'Every series must be an object.' };
        const name = readString(entry.name, MAX_CHART_LABEL_LENGTH, { required: true });
        if (name === null) return { error: 'Every series needs a name.' };
        if (!Array.isArray(entry.values)) return { error: `Series "${name}" has no values list.` };
        if (entry.values.length !== xLabels.length) {
            return { error: `Series "${name}" has ${entry.values.length} values for ${xLabels.length} labels.` };
        }
        const values = [];
        for (const raw of entry.values) {
            const number = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
            if (typeof number !== 'number' || !Number.isFinite(number)) {
                return { error: `Series "${name}" contains a value that is not a finite number.` };
            }
            values.push(number);
        }
        if (chartType === 'pie' && values.some(number => number < 0)) {
            return { error: 'A pie chart cannot show negative values.' };
        }
        series.push({ name, values });
    }
    if (xLabels.length === 0) return { error: 'The chart has no data points.' };

    const spec = { chartType, title, xLabels, series };
    const xAxisTitle = readString(value.xAxisTitle, MAX_CHART_LABEL_LENGTH);
    const yAxisTitle = readString(value.yAxisTitle, MAX_CHART_LABEL_LENGTH);
    if (xAxisTitle) spec.xAxisTitle = xAxisTitle;
    if (yAxisTitle) spec.yAxisTitle = yAxisTitle;

    if (utf8ByteLength(JSON.stringify(spec)) > MAX_CHART_SPEC_BYTES) {
        return { error: 'The chart specification is too large.' };
    }
    return { spec };
}

/** Normalizes one stored artifact; anything malformed or foreign becomes null. */
export function normalizeChartArtifact(value, options = {}) {
    if (!isPlainObject(value)) return null;
    if (value.version !== CHART_ARTIFACT_VERSION || value.type !== CHART_ARTIFACT_TYPE) return null;
    const { spec } = validateChartSpec(value.spec);
    if (!spec) return null;
    const artifact = { version: CHART_ARTIFACT_VERSION, type: CHART_ARTIFACT_TYPE, spec };
    const toolCallId = normalizeToolCallId(value.toolCallId) || normalizeToolCallId(options.fallbackToolCallId);
    if (toolCallId) artifact.toolCallId = toolCallId;
    return artifact;
}

/** Normalizes a stored list, keeping at most the first valid chart. */
export function normalizeChartArtifacts(value) {
    if (!Array.isArray(value)) return [];
    for (const entry of value) {
        const artifact = normalizeChartArtifact(entry);
        if (artifact) return [artifact];
    }
    return [];
}

export function normalizeMessageChartArtifacts(message) {
    if (!isPlainObject(message)) return message;
    if (isPlainObject(message.council)) {
        const normalizeLane = lane => {
            if (!isPlainObject(lane)) return lane;
            const copy = { ...lane };
            const charts = normalizeChartArtifacts(copy.artifacts);
            if (charts.length) copy.artifacts = charts;
            else delete copy.artifacts;
            return copy;
        };
        message.council = { ...message.council,
            ...(Array.isArray(message.council.stage1) ? { stage1: message.council.stage1.map(normalizeLane) } : {}),
            ...(message.council.synthesis ? { synthesis: normalizeLane(message.council.synthesis) } : {})
        };
    }
    const artifacts = normalizeChartArtifacts(message.artifacts);
    if (artifacts.length > 0) message.artifacts = artifacts;
    else delete message.artifacts;
    return message;
}

export function getMessageChartArtifact(message) {
    return normalizeChartArtifacts(message?.artifacts)[0] || null;
}

/** Only models whose catalog entry declares tool support are offered the tool. */
export function modelSupportsClientTools(model) {
    return Array.isArray(model?.supported_parameters) && model.supported_parameters.includes('tools');
}

export function getChartToolCallId(artifact, index = 0) {
    return normalizeToolCallId(artifact?.toolCallId) || `chart_${index}`;
}

/** Turns one completed tool call into `{ artifact }` or `{ error }`. */
export function createChartArtifactFromToolCall(toolCall) {
    if (!isPlainObject(toolCall) || !isPlainObject(toolCall.function)) return { artifact: null, error: 'The model sent a malformed tool call.' };
    if (toolCall.function.name !== CHART_TOOL_NAME) return { artifact: null, error: `The model called an unknown tool "${String(toolCall.function.name).slice(0, 40)}".` };
    if (typeof toolCall.invalidReason === 'string' && toolCall.invalidReason) return { artifact: null, error: toolCall.invalidReason };

    let parsed;
    try {
        parsed = JSON.parse(typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments : '');
    } catch {
        return { artifact: null, error: 'The chart data was not valid JSON.' };
    }
    const { spec, error } = validateChartSpec(parsed);
    if (!spec) return { artifact: null, error };
    const artifact = { version: CHART_ARTIFACT_VERSION, type: CHART_ARTIFACT_TYPE, spec };
    const toolCallId = normalizeToolCallId(toolCall.id);
    if (toolCallId) artifact.toolCallId = toolCallId;
    return { artifact, error: null };
}

/**
 * Picks the chart from a response's tool calls. One chart per response:
 * a second call is reported as an error rather than silently dropped, so the
 * person sees that the model tried to do more than the client supports.
 */
export function extractChartArtifactFromToolCalls(toolCalls) {
    const calls = Array.isArray(toolCalls) ? toolCalls.filter(call => call && typeof call === 'object') : [];
    if (calls.length === 0) return { artifact: null, error: null };
    if (calls.length > 1) return { artifact: null, error: 'The model tried to render more than one chart in a single response.' };
    return createChartArtifactFromToolCall(calls[0]);
}

/**
 * The two wire messages that replay a rendered chart to a later turn.
 * The assistant turn carries the original call; the tool turn says the
 * client rendered it, so the model does not try to describe it again.
 */
export function createChartArtifactTranscript(artifact, index = 0) {
    const toolCallId = getChartToolCallId(artifact, index);
    return [
        {
            role: 'assistant',
            content: null,
            tool_calls: [{
                id: toolCallId,
                type: 'function',
                function: { name: CHART_TOOL_NAME, arguments: JSON.stringify(artifact.spec) }
            }]
        },
        {
            role: 'tool',
            tool_call_id: toolCallId,
            name: CHART_TOOL_NAME,
            content: `Rendered a ${artifact.spec.chartType} chart titled "${artifact.spec.title}" in the chat.`
        }
    ];
}

/** Plain-text table for clipboard and models that cannot accept tool history. */
export function formatChartArtifactText(value) {
    const artifact = normalizeChartArtifact(value);
    if (!artifact) return '';
    const { spec } = artifact;
    const cell = value => String(value).replace(/[\t\r\n]+/g, ' ');
    const rows = [
        [spec.xAxisTitle || 'Category', ...spec.series.map(series => series.name)],
        ...spec.xLabels.map((label, index) => [label, ...spec.series.map(series => series.values[index])])
    ];
    return [spec.title, spec.yAxisTitle ? `Values: ${spec.yAxisTitle}` : '',
        rows.map(row => row.map(cell).join('\t')).join('\n')].filter(Boolean).join('\n');
}

export function getMessageCopyText(message) {
    const text = typeof message?.content === 'string' ? message.content : '';
    const chart = formatChartArtifactText(getMessageChartArtifact(message));
    return [text, chart].filter(part => part.trim()).join('\n\n');
}

/** Shared by single replies, multi-model lanes, and Quick Ask. */
export function applyChartToolResult(message, toolCalls) {
    delete message.pendingArtifact;
    const { artifact, error } = extractChartArtifactFromToolCalls(toolCalls);
    if (artifact) {
        message.artifacts = [artifact];
        delete message.clientToolError;
        return { hasVisibleOutput: true, error: null };
    }
    delete message.artifacts;
    if (error) {
        const prefix = message.content?.trim() ? `${message.content.trim()}\n\n` : '';
        message.content = `${prefix}*The chart could not be shown: ${error}*`;
        message.clientToolError = error;
        return { hasVisibleOutput: true, error };
    }
    delete message.clientToolError;
    return { hasVisibleOutput: false, error: null };
}
