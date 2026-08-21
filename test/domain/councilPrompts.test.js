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

test('buildCouncilSynthesisPrompt asks for concise anonymous review', () => {
    const prompt = buildCouncilSynthesisPrompt({
        userQuery: 'Which answer is better?',
        responses: [
            { model: 'Model A', response: 'Answer one.' },
            { model: 'Model B', response: 'Answer two.' }
        ]
    });

    assert.match(prompt, /independent reviewer/i);
    assert.match(prompt, /one or two anonymous models produced available draft answers/i);
    assert.match(prompt, /Read Response A and Response B/i);
    assert.match(prompt, /Briefly compare the drafts/i);
    assert.match(prompt, /material differences, errors, missing caveats, and useful synthesis/i);
    assert.match(prompt, /concise final answer/i);
    assert.match(prompt, /Do not mention model names, provider names, or hidden identities/i);
    assert.match(prompt, /If one response is clearly stronger/i);
    assert.match(prompt, /Do not assign scores, grades, or ranked lists/i);
    assert.match(prompt, /Do not use chatty phrasing/i);
    assert.match(prompt, /Keep the review concise and useful/i);
    assert.match(prompt, /Write the review and final answer now:/);
    assert.doesNotMatch(prompt, /paper submissions/i);
    assert.doesNotMatch(prompt, /Council review and final take:/);
    assert.doesNotMatch(prompt, /Council review:/);
    assert.doesNotMatch(prompt, /Final take for you/i);
    assert.doesNotMatch(prompt, /Best combined answer/i);
    assert.doesNotMatch(prompt, /STAGE 2/i);
    assert.doesNotMatch(prompt, /Peer Rankings/i);
    assert.doesNotMatch(prompt, /ranking inputs/i);
    assert.doesNotMatch(prompt, /numerical scoring/i);
    assert.doesNotMatch(prompt, /Chairman/i);
    assert.doesNotMatch(prompt, /Model A|Model B/);
});

test('buildCouncilSynthesisPrompt supports partial draft availability', () => {
    const prompt = buildCouncilSynthesisPrompt({
        userQuery: 'Summarize the decision.',
        responses: [
            { model: 'OpenAI: GPT', response: 'Use the blue wire.' }
        ]
    });

    assert.match(prompt, /one or two anonymous models produced available draft answers/i);
    assert.match(prompt, /If only one response is available/);
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
