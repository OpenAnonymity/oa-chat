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
    // Thinking that arrives after an answer segment (tool use) re-arms the
    // settle, so the next content chunk closes the trace again.
    assert.match(app, /streamedReasoning \+= reasoningChunk;\n(?:\s*\/\/[^\n]*\n)*\s*reasoningEndTime = null;/);
    assert.match(app, /streamedReasoning \+= reasoningChunk;\n(?:\s*\/\/[^\n]*\n)*\s*firstContentChunk = true;/);
    assert.match(council, /reasoning \+= reasoningChunk;\n(?:\s*\/\/[^\n]*\n)*\s*firstContentChunk = true;/);
});

test('reasoning that arrives after settling is ignored, and the API flushes it before content', () => {
    const chatArea = read('chat/components/ChatArea.js');
    assert.match(chatArea, /updateStreamingReasoning\(messageId, reasoning\) \{\n\s*if \(this\.settledReasoningIds\.has\(messageId\)\) \{\n\s*const settledLength = this\.settledReasoningIds\.get\(messageId\);\n\s*if \(\(reasoning\?\.length \|\| 0\) <= settledLength\) return;/, 'a tail no longer than the settled text is ignored; longer reopens the trace');
    assert.match(chatArea, /updateCouncilLaneReasoning\(messageId, laneId, reasoning\) \{\n\s*const reasoningId = [^\n]+\n\s*if \(this\.settledReasoningIds\.has\(reasoningId\)\) \{\n\s*const settledLength = this\.settledReasoningIds\.get\(reasoningId\);\n\s*if \(\(reasoning\?\.length \|\| 0\) <= settledLength\) return;/);
    assert.match(chatArea, /settleReasoningDisplay\(messageId, reasoning, reasoningDuration\) \{\n\s*this\.settledReasoningIds\.set\(messageId, reasoning\?\.length \|\| 0\);\n\s*this\.finalizeReasoningDisplay\(messageId, reasoning, reasoningDuration\);/);
    const api = read('chat/api.js');
    assert.match(api, /accumulatedContent \+= content;\n(?:\s*\/\/[^\n]*\n)*\s*flushReasoningBuffer\(\);\n\s*onChunk\(content\);/);
});

test('a finished message that streamed after thinking gets its action row (Copy, Regenerate) back', () => {
    // The message is appended while thinking, with a placeholder where the
    // actions go. Once the trace is settled, finalize takes the targeted path
    // that leaves the trace alone, so the row must be swapped in there.
    const chatArea = read('chat/components/ChatArea.js');
    assert.match(chatArea, /if \(isReasoningFinalized && !forceFullRender\) \{[\s\S]*?this\.replaceAssistantActionsRow\(messageEl, message\);/);
    assert.match(chatArea, /replaceAssistantActionsRow\(messageEl, message\) \{[\s\S]*?assistant-actions-placeholder[\s\S]*?row\.replaceWith\(fresh\)/);
});
