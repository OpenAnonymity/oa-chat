import test from 'node:test';
import assert from 'node:assert/strict';
import { insertStreamingContentBubble } from '../../chat/components/streamingLayout.js';

test('first streamed answer text renders before an existing reasoning trace', () => {
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
        existingContentCount: 0,
        startsNewSegment: false,
        reasoningTrace,
        actionAnchor
    });

    assert.deepEqual(children, [textBubble, reasoningTrace, actionAnchor]);
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
        existingContentCount: 1,
        startsNewSegment: true,
        reasoningTrace,
        actionAnchor
    });

    assert.deepEqual(children, [priorAnswer, reasoningTrace, resumedAnswer, actionAnchor]);
});
