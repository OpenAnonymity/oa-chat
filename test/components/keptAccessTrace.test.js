import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotAccessTrace, buildKeptAccessTrace } from '../../chat/components/PendingIndicator.js';

const ready = {
    mode: 'security', kind: 'access', category: 'Private access',
    current: 'Private access secured · sending your message…',
    description: 'Private access secured. Sending your message.',
    progressPhase: 'ready',
    steps: [{ id: 'check', label: 'Check unfinished private activity', state: 'complete' }, { id: 'verify', label: 'Verify with Open Anonymity', state: 'complete' }],
    note: 'A zero-knowledge proof is exchanged for a time-limited, spending-capped key used only by this chat.'
};

test('a security presentation is kept as its category, steps, note and a summary without the sending tail', () => {
    const trace = snapshotAccessTrace(ready);
    assert.equal(trace.summary, 'Private access secured');
    assert.equal(trace.category, 'Private access');
    assert.equal(trace.phase, 'ready');
    assert.deepEqual(trace.steps.map(step => step.state), ['complete', 'complete']);
    assert.match(trace.note, /zero-knowledge/);
});

test('only security presentations are kept', () => {
    assert.equal(snapshotAccessTrace(null), null);
    assert.equal(snapshotAccessTrace({ mode: 'simple', current: 'Waiting for response' }), null);
});

test('the kept trace renders the same disclosure as the pending one, collapsed and at rest', () => {
    const html = buildKeptAccessTrace(snapshotAccessTrace(ready), 'msg-1');
    assert.match(html, /class="pending-response-line kept-access-trace"/);
    assert.match(html, /<details class="pending-security-trace" data-pending-security-trace-id="access-msg-1"/);
    assert.doesNotMatch(html, /<details[^>]* open/);
    assert.doesNotMatch(html, /pending-response-streaming/);
    assert.match(html, />Private access secured</);
    assert.equal((html.match(/data-state="complete"/g) || []).length, 2);
    assert.match(html, /Verify with Open Anonymity/);
    assert.equal(buildKeptAccessTrace(null, 'msg-2'), '');
});

test('once the message exists the trace is kept finished, whatever step the last report was on', async () => {
    const { completeAccessTrace } = await import('../../chat/domain/accessTrace.js');
    const halfway = snapshotAccessTrace({ mode: 'security', category: 'Finishing previous chat', current: 'Closing the previous chat key…', progressPhase: 'settling',
        steps: [{ id: 'close', label: 'Close previous chat key', state: 'active' }, { id: 'usage', label: 'Confirm final usage', state: 'upcoming' }], note: 'n' });
    const kept = completeAccessTrace(halfway);
    assert.equal(kept.summary, 'Previous chat finished');
    assert.equal(kept.phase, 'ready');
    assert.deepEqual(kept.steps.map(s => s.state), ['complete', 'complete']);
    assert.equal(completeAccessTrace(null), null);
});

test('with thinking present the steps open inside the thinking disclosure, not as a second one', async () => {
    const { buildKeptAccessTraceInline } = await import('../../chat/components/PendingIndicator.js');
    const html = buildKeptAccessTraceInline([snapshotAccessTrace(ready)]);
    assert.match(html, /^<div class="kept-access-inline"/);
    assert.doesNotMatch(html, /<details/);
    assert.match(html, /pending-security-category">Private access secured</);
    assert.equal((html.match(/data-state="complete"/g) || []).length, 2);
});

test('a turn that finished the previous chat and then secured access keeps both stages, in order, finished', async () => {
    const { upsertAccessStage, keptAccessStages } = await import('../../chat/domain/accessTrace.js');
    const { buildKeptAccessTraceInline, buildKeptAccessTrace } = await import('../../chat/components/PendingIndicator.js');
    const settling = snapshotAccessTrace({ mode: 'security', category: 'Finishing previous chat', current: 'Closing the previous chat key…', progressPhase: 'settling',
        steps: [{ id: 'close', label: 'Close previous chat key', state: 'active' }, { id: 'usage', label: 'Confirm final usage', state: 'upcoming' }], note: '' });
    const stages = upsertAccessStage([], settling);
    // a later report of the same stage replaces it; a new stage appends
    upsertAccessStage(stages, { ...settling, current: 'Confirming final usage…' });
    upsertAccessStage(stages, snapshotAccessTrace({ ...ready, current: 'Generating a zero-knowledge funding proof…', progressPhase: 'proving', steps: [{ id: 'check', label: 'Check', state: 'complete' }, { id: 'proof', label: 'Proof', state: 'active' }] }));
    assert.deepEqual(stages.map(s => s.category), ['Finishing previous chat', 'Private access']);

    const pending = keptAccessStages(stages, false);
    assert.equal(pending[1].steps[1].state, 'active', 'still pending: shown as it is');
    const kept = keptAccessStages(stages, true);
    assert.deepEqual(kept.map(s => s.summary), ['Previous chat finished', 'Private access secured']);
    assert.ok(kept.every(s => s.steps.every(step => step.state === 'complete')));

    const inline = buildKeptAccessTraceInline(kept);
    assert.equal((inline.match(/class="kept-access-stage"/g) || []).length, 2);
    assert.ok(inline.indexOf('Previous chat finished') < inline.indexOf('Private access secured'));
    const own = buildKeptAccessTrace(kept, 'm');
    assert.match(own, /<summary[^>]*aria-label="Private access secured"/, 'the disclosure is named by the last stage');
    assert.deepEqual(keptAccessStages(snapshotAccessTrace(ready)).length, 1, 'older messages kept one object');
});
