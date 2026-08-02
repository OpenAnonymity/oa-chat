import test from 'node:test';
import assert from 'node:assert/strict';
import {
    insertStreamingContentBubble,
    placeCompletedReasoningTrace,
    seedReasoningTypewriterForPhase
} from '../../chat/components/streamingLayout.js';

test('answer text emitted after reasoning stays below the completed trace', () => {
    const reasoningTrace = { kind: 'reasoning' };
    const actionAnchor = { kind: 'actions' };
    const textBubble = { kind: 'answer' };
    const children = [reasoningTrace, actionAnchor];

    const groupEl = {
        insertBefore(node, anchor) {
            children.splice(children.indexOf(anchor), 0, node);
        },
        appendChild(node) {
            children.push(node);
        }
    };
    insertStreamingContentBubble({
        groupEl,
        textBubble,
        actionAnchor
    });

    assert.deepEqual(children, [reasoningTrace, textBubble, actionAnchor]);
});

test('answer text resuming after reasoning stays below the reasoning trace', () => {
    const priorAnswer = { kind: 'prior-answer' };
    const reasoningTrace = { kind: 'reasoning' };
    const actionAnchor = { kind: 'actions' };
    const resumedAnswer = { kind: 'resumed-answer' };
    const children = [priorAnswer, reasoningTrace, actionAnchor];
    const groupEl = {
        insertBefore(node, anchor) {
            children.splice(children.indexOf(anchor), 0, node);
        },
        appendChild(node) {
            children.push(node);
        }
    };

    insertStreamingContentBubble({
        groupEl,
        textBubble: resumedAnswer,
        actionAnchor
    });

    assert.deepEqual(children, [priorAnswer, reasoningTrace, resumedAnswer, actionAnchor]);
});

test('completed reasoning returns above every answer segment', () => {
    const priorAnswer = { kind: 'prior-answer' };
    const reasoningTrace = { kind: 'reasoning' };
    const resumedAnswer = { kind: 'resumed-answer' };
    const actionAnchor = { kind: 'actions' };
    const children = [priorAnswer, reasoningTrace, resumedAnswer, actionAnchor];
    const groupEl = {
        insertBefore(node, anchor) {
            children.splice(children.indexOf(node), 1);
            children.splice(children.indexOf(anchor), 0, node);
        }
    };

    placeCompletedReasoningTrace({
        groupEl,
        reasoningTrace,
        firstOutputBubble: priorAnswer,
        actionAnchor
    });

    assert.deepEqual(children, [reasoningTrace, priorAnswer, resumedAnswer, actionAnchor]);
});

test('a resumed reasoning phase preserves the already-rendered prefix', () => {
    const typewriter = {
        messageId: null,
        targetContent: '',
        displayedLength: 0
    };

    seedReasoningTypewriterForPhase({
        typewriter,
        messageId: 'message-1',
        completedContent: 'Completed first phase.'
    });

    assert.deepEqual(typewriter, {
        messageId: 'message-1',
        targetContent: 'Completed first phase.',
        displayedLength: 22
    });
});
