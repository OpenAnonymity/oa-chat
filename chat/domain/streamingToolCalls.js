// Accumulates OpenAI-style streamed tool-call deltas (as relayed by
// OpenRouter) into complete tool calls. Providers split a call's JSON
// arguments across many SSE chunks and identify each call by `index`
// (preferred) or `id`; both are honoured here. Arguments are capped so a
// runaway stream cannot grow memory without bound; an over-limit call is
// kept but marked invalid so the caller can show an error instead of
// executing a truncated payload.

export const MAX_TOOL_ARGUMENT_BYTES = 128 * 1024;

function utf8ByteLength(value) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).byteLength;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(value, 'utf8');
    return unescape(encodeURIComponent(value)).length;
}

export function createStreamingToolCallAccumulator(options = {}) {
    const limit = Number.isFinite(options.maxArgumentBytes) && options.maxArgumentBytes > 0
        ? Math.floor(options.maxArgumentBytes)
        : MAX_TOOL_ARGUMENT_BYTES;
    return { entries: new Map(), maxArgumentBytes: limit };
}

function findEntryKey(accumulator, delta, fallbackIndex) {
    if (Number.isInteger(delta?.index) && delta.index >= 0) return delta.index;
    if (typeof delta?.id === 'string' && delta.id) {
        for (const [key, entry] of accumulator.entries) {
            if (entry.id === delta.id) return key;
        }
    }
    return fallbackIndex;
}

/**
 * Folds one chunk's `delta.tool_calls` array into the accumulator.
 * Returns true when anything was recorded, so callers can treat the
 * chunk as output for first-token, watchdog and resend bookkeeping.
 */
export function appendStreamingToolCallDeltas(accumulator, deltas) {
    if (!accumulator?.entries || !(accumulator.entries instanceof Map) || !Array.isArray(deltas)) {
        return false;
    }

    let changed = false;
    deltas.forEach((delta, fallbackIndex) => {
        if (!delta || typeof delta !== 'object') return;
        const key = findEntryKey(accumulator, delta, fallbackIndex);
        const entry = accumulator.entries.get(key) || {
            index: key,
            id: '',
            type: 'function',
            function: { name: '', arguments: '' },
            invalidReason: null
        };

        if (typeof delta.id === 'string' && delta.id) entry.id = delta.id;
        if (typeof delta.type === 'string' && delta.type) entry.type = delta.type;
        if (typeof delta.function?.name === 'string') entry.function.name += delta.function.name;
        if (typeof delta.function?.arguments === 'string' && !entry.invalidReason) {
            const combined = entry.function.arguments + delta.function.arguments;
            if (utf8ByteLength(combined) > accumulator.maxArgumentBytes) {
                entry.invalidReason = 'Tool arguments exceeded the client limit.';
            } else {
                entry.function.arguments = combined;
            }
        }

        accumulator.entries.set(key, entry);
        changed = true;
    });

    return changed;
}

export function hasStreamingToolCalls(accumulator) {
    return !!accumulator?.entries && accumulator.entries instanceof Map && accumulator.entries.size > 0;
}

/** Returns the completed calls in index order, in provider wire shape. */
export function finalizeStreamingToolCalls(accumulator) {
    if (!accumulator?.entries || !(accumulator.entries instanceof Map)) return [];
    return Array.from(accumulator.entries.values())
        .sort((left, right) => left.index - right.index)
        .map(entry => ({
            id: entry.id || `call_${entry.index}`,
            type: entry.type || 'function',
            function: {
                name: entry.function.name,
                arguments: entry.function.arguments
            },
            ...(entry.invalidReason ? { invalidReason: entry.invalidReason } : {})
        }));
}
