import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The model's thinking always precedes its answer. The client must show it
// that way too: the first content chunk settles the trace (full text, no
// "Thinking..." indicator, duration in the header), and nothing that arrives
// later may reopen it. These read the sources because ChatArea needs a DOM.
const read = relative => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

test('the first content chunk settles the reasoning trace on every streaming path', () => {
    const app = read('chat/app.js');
    const settles = app.match(/this\.chatArea\.settleReasoningDisplay\(/g) || [];
    assert.ok(settles.length >= 3, `send and regenerate paths settle at first content (found ${settles.length})`);
    assert.doesNotMatch(app, /updateReasoningSubtitleToDuration\(/, 'subtitle-only updates leave the typewriter and indicator running');
    const council = read('chat/application/councilController.js');
    assert.match(council, /settleCouncilLaneReasoning\(assistantMessage\.id, laneId, reasoning, duration\)/);
});

test('reasoning that arrives after settling is ignored, and the API flushes it before content', () => {
    const chatArea = read('chat/components/ChatArea.js');
    assert.match(chatArea, /updateStreamingReasoning\(messageId, reasoning\) \{\n\s*if \(this\.settledReasoningIds\.has\(messageId\)\) return;/);
    assert.match(chatArea, /updateCouncilLaneReasoning\(messageId, laneId, reasoning\) \{\n\s*const reasoningId = [^\n]+\n\s*if \(this\.settledReasoningIds\.has\(reasoningId\)\) return;/);
    assert.match(chatArea, /settleReasoningDisplay\(messageId, reasoning, reasoningDuration\) \{\n\s*this\.settledReasoningIds\.add\(messageId\);\n\s*this\.finalizeReasoningDisplay\(messageId, reasoning, reasoningDuration\);/);
    const api = read('chat/api.js');
    assert.match(api, /accumulatedContent \+= content;\n(?:\s*\/\/[^\n]*\n)*\s*flushReasoningBuffer\(\);\n\s*onChunk\(content\);/);
});
