import test from 'node:test';
import assert from 'node:assert/strict';
import {
    COUNCIL_OUTPUT_PARALLEL,
    COUNCIL_OUTPUT_SYNTHESIS,
    areCouncilConfigsEqual,
    buildDefaultCouncilConfig,
    normalizeCouncilConfig
} from '../../chat/domain/councilConfig.js';

test('buildDefaultCouncilConfig defaults synthesis model to the primary model', () => {
    assert.deepEqual(buildDefaultCouncilConfig('OpenAI: GPT'), {
        enabled: false,
        members: ['OpenAI: GPT'],
        synthesisModel: 'OpenAI: GPT',
        outputMode: COUNCIL_OUTPUT_PARALLEL,
        reviewEnabled: false
    });
});

test('normalizeCouncilConfig preserves synthesis model and disables review by default', () => {
    const config = normalizeCouncilConfig({
        enabled: true,
        members: ['OpenAI: GPT', 'Anthropic: Claude'],
        synthesisModel: 'Google: Gemini'
    }, 'OpenAI: GPT');

    assert.deepEqual(config, {
        enabled: true,
        members: ['OpenAI: GPT', 'Anthropic: Claude'],
        synthesisModel: 'Google: Gemini',
        outputMode: COUNCIL_OUTPUT_PARALLEL,
        reviewEnabled: false
    });
});

test('normalizeCouncilConfig preserves parallel output mode', () => {
    const config = normalizeCouncilConfig({
        enabled: true,
        members: ['OpenAI: GPT', 'Anthropic: Claude'],
        synthesisModel: 'Google: Gemini',
        outputMode: COUNCIL_OUTPUT_PARALLEL
    }, 'OpenAI: GPT');

    assert.equal(config.outputMode, COUNCIL_OUTPUT_PARALLEL);
});

test('normalizeCouncilConfig migrates legacy council output mode to synthesis', () => {
    const config = normalizeCouncilConfig({
        enabled: true,
        members: ['OpenAI: GPT', 'Anthropic: Claude'],
        outputMode: 'council'
    }, 'OpenAI: GPT');

    assert.equal(config.outputMode, COUNCIL_OUTPUT_SYNTHESIS);
    assert.equal(config.reviewEnabled, true);
});

test('normalizeCouncilConfig preserves duplicate members for same-model Parallel lanes', () => {
    const config = normalizeCouncilConfig({
        enabled: true,
        members: ['OpenAI: GPT', 'OpenAI: GPT'],
        outputMode: COUNCIL_OUTPUT_PARALLEL
    }, 'OpenAI: GPT');

    assert.deepEqual(config.members, ['OpenAI: GPT', 'OpenAI: GPT']);
});

test('normalizeCouncilConfig migrates legacy chairmanModel to synthesisModel', () => {
    const config = normalizeCouncilConfig({
        enabled: true,
        members: ['OpenAI: GPT', 'Anthropic: Claude'],
        chairmanModel: 'Anthropic: Claude'
    }, 'OpenAI: GPT');

    assert.equal(config.synthesisModel, 'Anthropic: Claude');
    assert.equal(config.outputMode, COUNCIL_OUTPUT_PARALLEL);
    assert.equal(config.reviewEnabled, false);
});

test('areCouncilConfigsEqual detects synthesis model changes', () => {
    assert.equal(
        areCouncilConfigsEqual(
            { enabled: true, members: ['A', 'B'], synthesisModel: 'A' },
            { enabled: true, members: ['A', 'B'], synthesisModel: 'B' }
        ),
        false
    );
});

test('areCouncilConfigsEqual detects output mode changes', () => {
    assert.equal(
        areCouncilConfigsEqual(
            { enabled: true, members: ['A', 'B'], synthesisModel: 'A', outputMode: COUNCIL_OUTPUT_SYNTHESIS },
            { enabled: true, members: ['A', 'B'], synthesisModel: 'A', outputMode: COUNCIL_OUTPUT_PARALLEL }
        ),
        false
    );
});
