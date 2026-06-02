import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildAnonymousResponseBlocks,
    buildCouncilSynthesisMessages,
    buildCouncilSynthesisPrompt
} from '../../chat/domain/councilPrompts.js';

test('buildAnonymousResponseBlocks labels responses without model identities', () => {
    const blocks = buildAnonymousResponseBlocks([
        { model: 'OpenAI: GPT', response: 'Use the blue wire.' },
        { model: 'Anthropic: Claude', response: 'Use the red wire.' }
    ]);

    assert.match(blocks, /Response A:\nUse the blue wire\./);
    assert.match(blocks, /Response B:\nUse the red wire\./);
    assert.doesNotMatch(blocks, /OpenAI|Anthropic|GPT|Claude/);
});

test('buildCouncilSynthesisPrompt excludes review-stage language', () => {
    const prompt = buildCouncilSynthesisPrompt({
        userQuery: 'Which answer is better?',
        responses: [
            { model: 'Model A', response: 'Answer one.' },
            { model: 'Model B', response: 'Answer two.' }
        ]
    });

    assert.match(prompt, /Final Council Answer:/);
    assert.doesNotMatch(prompt, /\b(rank|ranking|review|score|scoring)\b/i);
    assert.doesNotMatch(prompt, /STAGE 2/i);
    assert.doesNotMatch(prompt, /Peer Rankings/i);
    assert.doesNotMatch(prompt, /Chairman/i);
    assert.doesNotMatch(prompt, /Model A|Model B/);
});

test('buildCouncilSynthesisMessages returns a user message with optional context', () => {
    const messages = buildCouncilSynthesisMessages({
        userQuery: 'Summarize the decision.',
        conversationContext: 'Earlier assistant answer that became shared context.',
        responses: [
            { response: 'Draft A.' },
            { response: 'Draft B.' }
        ]
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.match(messages[0].content, /Relevant conversation context:/);
    assert.match(messages[0].content, /Earlier assistant answer/);
    assert.match(messages[0].content, /Response A:\nDraft A\./);
    assert.match(messages[0].content, /Response B:\nDraft B\./);
});
