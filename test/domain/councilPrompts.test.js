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

test('buildCouncilSynthesisPrompt asks for evidence-led summary and comparison', () => {
    const prompt = buildCouncilSynthesisPrompt({
        userQuery: 'Explain the tradeoffs.',
        responses: [
            { model: 'Model A', response: 'Answer one.' },
            { model: 'Model B', response: 'Answer two.' }
        ]
    });

    assert.match(prompt, /Summarize the main points of each available response/i);
    assert.match(prompt, /meaningful agreements and differences/i);
    assert.match(prompt, /conclusions, reasoning, assumptions, or coverage/i);
    assert.match(prompt, /Identify factual errors, unsupported claims, missing caveats, and relevant tradeoffs directly/i);
    assert.match(prompt, /State uncertainty when the available evidence does not resolve a disagreement/i);
    assert.match(prompt, /Let the evidence determine how much attention each response needs/i);
    assert.match(prompt, /Do not force equal praise or criticism, invent differences, or treat conflicting claims as equally credible/i);
    assert.match(prompt, /Do not routinely declare an overall winner or write a separate replacement answer/i);
    assert.match(prompt, /Do not mention model names, provider names, or hidden identities/i);
    assert.match(prompt, /Do not assign scores, grades, or ranked lists/i);
    assert.match(prompt, /Keep the summary and comparison concise and specific/i);
    assert.match(prompt, /Write the summary and comparison now:/);
    assert.doesNotMatch(prompt, /balanced|clearly stronger|synthesize the best answer|concise final answer/i);
    assert.doesNotMatch(prompt, /stronger, better, or superior overall/i);
    assert.doesNotMatch(prompt, /Peer Rankings|ranking inputs|Chairman/i);
    assert.doesNotMatch(prompt, /Model A|Model B/);
});

test('buildCouncilSynthesisPrompt supports partial draft availability', () => {
    const prompt = buildCouncilSynthesisPrompt({
        userQuery: 'Summarize the decision.',
        responses: [
            { model: 'OpenAI: GPT', response: 'Use the blue wire.' }
        ]
    });

    assert.match(prompt, /If only one response is available/);
    assert.match(prompt, /summarize it and note relevant limitations/i);
    assert.match(prompt, /other response was unavailable and a comparison is not possible/i);
    assert.match(prompt, /Response A:\nUse the blue wire\./);
    assert.doesNotMatch(prompt, /Response B:/);
    assert.doesNotMatch(prompt, /OpenAI|GPT/);
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
