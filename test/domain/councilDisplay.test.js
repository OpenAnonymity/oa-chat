import test from 'node:test';
import assert from 'node:assert/strict';
import { getCouncilDisplayState } from '../../chat/domain/councilDisplay.js';

test('parallel council display omits aggregate waiting row while lanes are pending', () => {
    const display = getCouncilDisplayState({
        currentStage: 'stage1',
        statusMessage: 'Waiting for responses...',
        stage1: [
            { label: 'Response A', status: 'pending' },
            { label: 'Response B', status: 'pending' }
        ],
        synthesis: null
    });

    assert.equal(display.statusMessage, '');
    assert.equal(display.stage1Summary, '');
});

test('finished parallel council display suppresses legacy completion status', () => {
    const display = getCouncilDisplayState({
        currentStage: 'complete',
        statusMessage: 'First opinions ready.',
        stage1: [
            { label: 'Response A', status: 'complete' },
            { label: 'Response B', status: 'complete' }
        ],
        synthesis: null
    });

    assert.equal(display.statusMessage, '');
    assert.equal(display.stage1Summary, '');
});

test('cancelled synthesis display keeps stop status without canonical-context note', () => {
    const display = getCouncilDisplayState({
        currentStage: 'complete',
        statusMessage: 'Stopped after first opinions.',
        canonicalStage1Label: 'Response A',
        canonicalModel: 'OpenAI: GPT',
        stage1: [
            { label: 'Response A', status: 'complete' },
            { label: 'Response B', status: 'complete' }
        ],
        synthesis: {
            status: 'cancelled'
        }
    });

    assert.equal(display.statusMessage, 'Stopped after first opinions.');
    assert.equal(display.stage1Summary, '');
});

test('skipped synthesis display keeps failure status without canonical-context note', () => {
    const display = getCouncilDisplayState({
        currentStage: 'complete',
        statusMessage: 'No model responses completed.',
        stage1: [
            { label: 'Response A', status: 'error' },
            { label: 'Response B', status: 'error' }
        ],
        synthesis: {
            status: 'skipped'
        }
    });

    assert.equal(display.statusMessage, 'No model responses completed.');
    assert.equal(display.stage1Summary, '');
});

test('running synthesis display omits aggregate status row', () => {
    const display = getCouncilDisplayState({
        currentStage: 'synthesis',
        statusMessage: 'Waiting for response',
        stage1: [
            { label: 'Response A', status: 'complete' },
            { label: 'Response B', status: 'complete' }
        ],
        synthesis: {
            status: 'running'
        }
    });

    assert.equal(display.statusMessage, '');
    assert.equal(display.stage1Summary, '');
});

test('completed synthesis display omits aggregate status row', () => {
    const display = getCouncilDisplayState({
        currentStage: 'complete',
        statusMessage: 'Council answer ready.',
        stage1: [
            { label: 'Response A', status: 'complete' },
            { label: 'Response B', status: 'complete' }
        ],
        synthesis: {
            status: 'complete'
        }
    });

    assert.equal(display.statusMessage, '');
    assert.equal(display.stage1Summary, '');
});
