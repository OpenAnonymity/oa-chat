import test from 'node:test';
import assert from 'node:assert/strict';
import { INFERENCE_TIMING, createInferenceWatchdog } from '../../chat/services/inference/reliability.js';

// 2026-10-14: 45 s with no byte at all (heartbeats count) ends the turn
// instead of showing "still waiting" for another two minutes.
test('45 seconds of total silence ends the request; no "still waiting" line first', async () => {
    assert.equal(INFERENCE_TIMING.idleMs, 45000);
    let clock = 0;
    const health = [];
    const watchdog = createInferenceWatchdog({ now: () => clock, onHealth: value => health.push(value), timing: { pollMs: 5 } });
    watchdog.opened();
    clock = 44_000;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(watchdog.signal.aborted, false);
    clock = 45_000;
    await new Promise(resolve => setTimeout(resolve, 20));
    watchdog.dispose();
    assert.equal(watchdog.signal.aborted, true);
    assert.equal(watchdog.signal.reason.code, 'INFERENCE_IDLE_TIMEOUT');
    assert.equal(watchdog.signal.reason.message, 'The provider stopped responding.');
    assert.ok(health.every(value => value?.kind !== 'silence'));
});

test('a heartbeat keeps a thinking model alive', async () => {
    let clock = 0;
    const watchdog = createInferenceWatchdog({ now: () => clock, timing: { pollMs: 5 } });
    watchdog.opened();
    for (const at of [30_000, 60_000, 90_000]) {
        clock = at;
        watchdog.activity();
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    watchdog.dispose();
    assert.equal(watchdog.signal.aborted, false);
});
