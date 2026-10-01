import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchRetrieval, transform } from '../../../chat/services/inference/lecoreContextOptimizer.js';
import { processMessagesForApi } from '../../../chat/domain/messageContent.js';

test('leCore cascade keeps exact, ambiguity, margin, refine and abstain behavior', () => {
    const docs = [
        'smooth a bumpy surface mesh by laplacian averaging',
        'fluid solver with pressure projection',
        'render an image with adaptive path tracing',
        'denoise a noisy render with joint bilateral filtering',
        'okapi bm25 lexical ranking over documents'
    ];
    const exact = dispatchRetrieval('adaptive path tracing', docs);
    assert.equal(exact.stage, 'exact');
    assert.equal(exact.ranked[0][0], 2);
    const ambiguous = dispatchRetrieval('adaptive path tracing', [...docs, 'adaptive path tracing again']);
    assert.notEqual(ambiguous.stage, 'exact');
    const dense = dispatchRetrieval('fluid solver pressure', docs);
    assert.equal(dense.stage, 'dense');
    assert.equal(dense.ranked[0][0], 1);
    const refine = dispatchRetrieval('render image', docs, { tau: 1 });
    assert.equal(refine.stage, 'refine');
    assert.equal(refine.ranked[0][0], 2);
    const abstain = dispatchRetrieval('purple monkey dishwasher', docs);
    assert.equal(abstain.stage, 'abstain');
    assert.deepEqual(abstain.ranked, []);
    assert.deepEqual(dispatchRetrieval('render image', docs, { tau: 1 }), refine);
});

function longHistory() {
    const history = [
        { role: 'system', content: 'Retain system guidance.' },
        { role: 'developer', content: 'Retain developer guidance.' }
    ];
    for (let index = 0; index < 14; index++) {
        history.push({ role: 'user', content: `User turn ${index}. ${'background '.repeat(85)}` });
        history.push({ role: 'assistant', content: `Assistant turn ${index}. ${'context '.repeat(95)}` });
    }
    history[4].content = `Thermal aperture calibration project: ${'thermal aperture calibration '.repeat(30)}`;
    history[5].content = `The agreed thermal aperture calibration uses a reference image. ${'thermal aperture calibration '.repeat(20)}`;
    history.at(-2).content = 'What was the thermal aperture calibration discussed earlier?';
    return history;
}

test('transform keeps source objects in causal order, instructions, matched exchange and recent turns', () => {
    const history = longHistory();
    const result = transform(history);
    assert.equal(result.metadata.applied, true);
    assert.deepEqual(result.metadata.retrievedIndices, [4, 5]);
    assert.strictEqual(result.messages[0], history[0]);
    assert.strictEqual(result.messages[1], history[1]);
    assert.strictEqual(result.messages[2], history[4]);
    assert.strictEqual(result.messages[3], history[5]);
    assert.deepEqual(result.messages.slice(-8), history.slice(-8));
    assert.ok(result.metadata.optimizedChars < result.metadata.originalChars);
    const sourcePositions = result.messages.map(message => history.indexOf(message));
    assert.deepEqual(sourcePositions, [...sourcePositions].sort((a, b) => a - b));
});

test('short, multimodal, broad and unrelated queries pass through unchanged', () => {
    const short = [{ role: 'user', content: 'Hello' }];
    assert.strictEqual(transform(short).messages, short);
    const multimodal = longHistory();
    multimodal[3] = { role: 'assistant', content: [{ type: 'text', text: 'hello' }] };
    assert.strictEqual(transform(multimodal).messages, multimodal);
    const broad = longHistory();
    broad.at(-2).content = 'Summarize everything in our conversation';
    assert.strictEqual(transform(broad).messages, broad);
    const decisions = longHistory();
    decisions.at(-2).content = 'Which project decisions did we make across this chat?';
    assert.strictEqual(transform(decisions).messages, decisions);
    decisions.at(-2).content = 'What were the key decisions?';
    assert.strictEqual(transform(decisions).messages, decisions);
    const unrelated = longHistory();
    unrelated.at(-2).content = 'What is the purple monkey dishwasher protocol?';
    assert.strictEqual(transform(unrelated).messages, unrelated);
});

test('historical text attachments survive later long-chat questions', () => {
    const history = longHistory();
    history[4].files = [{
        name: 'staff.txt', detectedType: 'text',
        dataUrl: `data:text/plain;base64,${Buffer.from('All staff must complete identity verification.').toString('base64')}`
    }];
    const processed = processMessagesForApi(history, 'test/model');
    assert.match(processed[4].content, /--- File: staff\.txt ---/);
    const result = transform(processed);
    assert.equal(result.metadata.reason, 'inlined_attachment');
    assert.strictEqual(result.messages, processed);
});
