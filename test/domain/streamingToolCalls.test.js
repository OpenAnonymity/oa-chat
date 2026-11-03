import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_TOOL_ARGUMENT_BYTES,
    appendStreamingToolCallDeltas,
    createStreamingToolCallAccumulator,
    finalizeStreamingToolCalls,
    hasStreamingToolCalls
} from '../../chat/domain/streamingToolCalls.js';

const ARGUMENTS = '{"type":"bar","title":"Monthly spend","series":[{"name":"Spend","values":[12,18,9]}],"xLabels":["Jan","Feb","Mar"]}';

// Splits a string into random-length pieces: the shape a provider's SSE
// argument fragments really arrive in. Seeded so a failure is reproducible.
function rechunk(text, seed) {
    let state = seed >>> 0;
    const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
    const pieces = [];
    let at = 0;
    while (at < text.length) {
        const size = 1 + Math.floor(next() * 9);
        pieces.push(text.slice(at, at + size));
        at += size;
    }
    return pieces;
}

test('an empty accumulator reports no calls and finalizes to an empty list', () => {
    const accumulator = createStreamingToolCallAccumulator();
    assert.equal(hasStreamingToolCalls(accumulator), false);
    assert.deepEqual(finalizeStreamingToolCalls(accumulator), []);
    assert.equal(appendStreamingToolCallDeltas(accumulator, undefined), false);
    assert.equal(appendStreamingToolCallDeltas(accumulator, [null, 'junk']), false);
});

test('argument fragments reassemble byte for byte at every random chunking', () => {
    for (let seed = 1; seed <= 200; seed++) {
        const accumulator = createStreamingToolCallAccumulator();
        const pieces = rechunk(ARGUMENTS, seed);
        pieces.forEach((piece, i) => {
            const delta = { index: 0, function: { arguments: piece } };
            if (i === 0) Object.assign(delta, { id: 'call_1', type: 'function', function: { name: 'render_chart', arguments: piece } });
            assert.equal(appendStreamingToolCallDeltas(accumulator, [delta]), true);
        });
        const [call] = finalizeStreamingToolCalls(accumulator);
        assert.equal(call.id, 'call_1');
        assert.equal(call.function.name, 'render_chart');
        assert.equal(call.function.arguments, ARGUMENTS, `seed ${seed}`);
        assert.equal(JSON.parse(call.function.arguments).type, 'bar');
    }
});

test('a name split across chunks concatenates and parallel calls keep index order', () => {
    const accumulator = createStreamingToolCallAccumulator();
    appendStreamingToolCallDeltas(accumulator, [
        { index: 1, id: 'call_b', function: { name: 'render_', arguments: '{"b' } },
        { index: 0, id: 'call_a', function: { name: 'render_chart', arguments: '{"a' } }
    ]);
    appendStreamingToolCallDeltas(accumulator, [
        { index: 1, function: { name: 'cards', arguments: '":1}' } },
        { index: 0, function: { arguments: '":1}' } }
    ]);
    const calls = finalizeStreamingToolCalls(accumulator);
    assert.deepEqual(calls.map(call => [call.id, call.function.name, call.function.arguments]), [
        ['call_a', 'render_chart', '{"a":1}'],
        ['call_b', 'render_cards', '{"b":1}']
    ]);
});

test('a provider that omits index is matched by id, then by position', () => {
    const accumulator = createStreamingToolCallAccumulator();
    appendStreamingToolCallDeltas(accumulator, [{ id: 'call_x', function: { name: 'render_chart', arguments: '{"x"' } }]);
    appendStreamingToolCallDeltas(accumulator, [{ id: 'call_x', function: { arguments: ':1}' } }]);
    appendStreamingToolCallDeltas(accumulator, [{ function: { arguments: '' } }]);
    const calls = finalizeStreamingToolCalls(accumulator);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.arguments, '{"x":1}');
});

test('a missing id gets a stable synthetic one', () => {
    const accumulator = createStreamingToolCallAccumulator();
    appendStreamingToolCallDeltas(accumulator, [{ index: 3, function: { name: 'render_chart', arguments: '{}' } }]);
    assert.equal(finalizeStreamingToolCalls(accumulator)[0].id, 'call_3');
});

test('arguments past the byte cap mark the call invalid and stop growing', () => {
    const accumulator = createStreamingToolCallAccumulator({ maxArgumentBytes: 16 });
    appendStreamingToolCallDeltas(accumulator, [{ index: 0, function: { name: 'render_chart', arguments: '0123456789' } }]);
    appendStreamingToolCallDeltas(accumulator, [{ index: 0, function: { arguments: '0123456789' } }]);
    appendStreamingToolCallDeltas(accumulator, [{ index: 0, function: { arguments: 'more' } }]);
    const [call] = finalizeStreamingToolCalls(accumulator);
    assert.equal(call.function.arguments, '0123456789');
    assert.match(call.invalidReason, /exceeded/);
});

test('the byte cap counts UTF-8 bytes, not code units', () => {
    const accumulator = createStreamingToolCallAccumulator({ maxArgumentBytes: 7 });
    appendStreamingToolCallDeltas(accumulator, [{ index: 0, function: { name: 'f', arguments: '€€' } }]);
    assert.equal(finalizeStreamingToolCalls(accumulator)[0].invalidReason, undefined);
    appendStreamingToolCallDeltas(accumulator, [{ index: 0, function: { arguments: '€' } }]);
    assert.match(finalizeStreamingToolCalls(accumulator)[0].invalidReason, /exceeded/);
    assert.equal(createStreamingToolCallAccumulator().maxArgumentBytes, MAX_TOOL_ARGUMENT_BYTES);
});
