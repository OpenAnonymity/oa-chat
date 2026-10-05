import test from 'node:test';
import assert from 'node:assert/strict';
import { setFeatureUsageReporter, trackFeatureUsage, trackSettingChange, FEATURE_USAGE_EVENTS } from '../../chat/services/featureUsage.js';

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


test('setting events classify defaults without exposing setting values or accepting unknown settings', () => {
    const calls = [];
    setFeatureUsageReporter((...args) => calls.push(args));
    try {
        trackSettingChange('theme', 'system', 'dark');
        trackSettingChange('theme', 'dark', 'light');
        trackSettingChange('theme', 'light', 'system');
        trackSettingChange('search', true, false);
        trackSettingChange('reasoning', 'medium', 'high');
        assert.deepEqual(calls, [
            ['settings_changed'], ['setting_theme_away'],
            ['settings_changed'], ['setting_theme_other'],
            ['settings_changed'], ['setting_theme_back'],
            ['settings_changed'], ['setting_search_away'],
            ['settings_changed'], ['setting_reasoning_away']
        ]);
        for (const [code] of calls) assert.equal(typeof FEATURE_USAGE_EVENTS[code], 'string');
        calls.length = 0;
        trackSettingChange('theme', 'dark', 'dark');
        trackSettingChange('theme', 'system', 'private arbitrary value');
        trackSettingChange('memory_saving', false, 'true');
        trackSettingChange('constructor', false, true);
        trackSettingChange({}, false, true);
        trackSettingChange('model', 'private model', 'another model');
        assert.deepEqual(calls, []);
        setFeatureUsageReporter(() => { throw new Error('analytics unavailable'); });
        assert.doesNotThrow(() => trackSettingChange('theme', 'system', 'dark'));
    } finally { setFeatureUsageReporter(null); }
});
