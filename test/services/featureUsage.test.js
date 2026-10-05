import test from 'node:test';
import assert from 'node:assert/strict';
import { setFeatureUsageReporter, trackFeatureUsage } from '../../chat/services/featureUsage.js';

test('feature reporting is opt-in, fixed-code only, and fault-contained', async () => {
    const calls = [];
    setFeatureUsageReporter(null);
    assert.doesNotThrow(() => trackFeatureUsage('memory_opened'));
    try {
        setFeatureUsageReporter((...args) => calls.push(args));
        trackFeatureUsage('memory_opened', { secret: 'must not cross the boundary' });
        for (const code of ['constructor', '__proto__', 'User private prompt', {}, null]) trackFeatureUsage(code);
        assert.deepEqual(calls, [['memory_opened']]);
        setFeatureUsageReporter(() => { throw new Error('broken host'); });
        assert.doesNotThrow(() => trackFeatureUsage('memory_opened'));
        setFeatureUsageReporter(() => Promise.reject(new Error('broken async host')));
        trackFeatureUsage('memory_opened');
        await new Promise(resolve => setTimeout(resolve, 0));
    } finally { setFeatureUsageReporter(null); }
});
