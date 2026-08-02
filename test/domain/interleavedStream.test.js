import test from 'node:test';
import assert from 'node:assert/strict';

import {
    activateStreamingReasoning,
    appendInterleavedContent,
    beginReasoningPhase,
    canFinalizeInterleavedContentInPlace,
    completeStreamingReasoning,
    createReasoningPhaseClock,
    finishReasoningPhase,
    formatReasoningDuration
} from '../../chat/domain/interleavedStream.js';

test('content remains contiguous while the provider is emitting output', () => {
    assert.deepEqual(
        appendInterleavedContent('Hello', ' world', 'content'),
        {
            content: 'Hello world',
            renderedChunk: ' world',
            startsNewSegment: false
        }
    );
});

test('content resuming after reasoning starts a new paragraph and stream segment', () => {
    assert.deepEqual(
        appendInterleavedContent('I will check that for you.', 'The direct page was empty.', 'reasoning'),
        {
            content: 'I will check that for you.\n\nThe direct page was empty.',
            renderedChunk: '\n\nThe direct page was empty.',
            startsNewSegment: true
        }
    );
});

test('an existing provider boundary is not duplicated after reasoning', () => {
    assert.equal(
        appendInterleavedContent('First paragraph.\n', '\nSecond paragraph.', 'reasoning').content,
        'First paragraph.\n\nSecond paragraph.'
    );
});

test('reasoning before the first output does not add leading whitespace', () => {
    assert.deepEqual(
        appendInterleavedContent('', 'First answer.', 'reasoning'),
        {
            content: 'First answer.',
            renderedChunk: 'First answer.',
            startsNewSegment: false
        }
    );
});

test('output inside an open code fence stays in the same render segment', () => {
    assert.deepEqual(
        appendInterleavedContent('```js\nconst value =', ' 1;\n```', 'reasoning'),
        {
            content: '```js\nconst value = 1;\n```',
            renderedChunk: ' 1;\n```',
            startsNewSegment: false
        }
    );
});

test('segmented output forces final rendering to collapse into one content bubble', () => {
    assert.equal(canFinalizeInterleavedContentInPlace(true, 1), true);
    assert.equal(canFinalizeInterleavedContentInPlace(true, 2), false);
    assert.equal(canFinalizeInterleavedContentInPlace(false, 1), false);
});

test('reasoning duration counts only active reasoning phases', () => {
    const clock = createReasoningPhaseClock();

    beginReasoningPhase(clock, 100);
    beginReasoningPhase(clock, 120);
    assert.equal(finishReasoningPhase(clock, 160), 60);
    assert.equal(finishReasoningPhase(clock, 300), 60);

    beginReasoningPhase(clock, 500);
    assert.equal(finishReasoningPhase(clock, 540), 100);
});

test('streaming reasoning flags and offsets exist only during an active phase', () => {
    const clock = createReasoningPhaseClock();
    const message = { streamingReasoning: false };

    activateStreamingReasoning(message, clock, 14, 100);
    assert.equal(message.streamingReasoning, true);
    assert.equal(message.streamingReasoningContentOffset, 14);

    assert.equal(completeStreamingReasoning(message, clock, 175), 75);
    assert.equal(message.streamingReasoning, false);
    assert.equal(message.streamingReasoningContentOffset, undefined);
    assert.equal(message.reasoningDuration, 75);
});

test('positive sub-second reasoning durations never display as zero seconds', () => {
    assert.equal(formatReasoningDuration(75), 'Thought for 1s');
    assert.equal(formatReasoningDuration(60000), 'Thought for 1m');
    assert.equal(formatReasoningDuration(65000), 'Thought for 1m 5s');
});
