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
