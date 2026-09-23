import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { paragraphBreakBefore } from '../../chat/services/streamSegments.js';

test('a resumed segment starts on its own paragraph', () => {
    assert.equal(paragraphBreakBefore('## Title', "I'll look up both."), "\n\n## Title");
    assert.equal(paragraphBreakBefore('Next thought', 'First thought.'), '\n\nNext thought');
    assert.equal(paragraphBreakBefore('## Title', 'Already broken.\n'), '## Title');
    assert.equal(paragraphBreakBefore('## Title', 'Already broken.\n\n  '), '## Title');
    assert.equal(paragraphBreakBefore('First ever', ''), 'First ever');
});

test('the API applies the break only when the stream switches between reasoning and content', () => {
    const api = fs.readFileSync(path.join(process.cwd(), 'chat/api.js'), 'utf8');
    assert.match(api, /if \(lastDeltaKind === 'content'\) \{\n\s*reasoningContent = paragraphBreakBefore\(reasoningContent, accumulatedReasoning\);/);
    assert.match(api, /if \(lastDeltaKind === 'reasoning'\) \{\n\s*content = paragraphBreakBefore\(content, accumulatedContent\);/);
});
