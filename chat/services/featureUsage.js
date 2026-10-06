import { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS } from './reasoningConfig.js';

// Built-in defaults, not a person's saved defaults. Values stay in the browser.
const SETTINGS = Object.freeze({
    memory_saving: { label: 'Memory saving', defaultValue: false, values: [false, true] },
    memory_replies: { label: 'Memory in replies', defaultValue: false, values: [false, true] },
    memory_auto_include: { label: 'Memory auto include', defaultValue: false, values: [false, true] },
    parallel: { label: 'Parallel mode', defaultValue: false, values: [false, true] },
    council: { label: 'Council review', defaultValue: false, values: [false, true] },
    search: { label: 'Web search', defaultValue: true, values: [false, true] },
    reasoning: { label: 'Reasoning effort', defaultValue: DEFAULT_REASONING_EFFORT, values: REASONING_EFFORTS },
    theme: { label: 'Theme', defaultValue: 'system', values: ['system', 'light', 'dark'] }
});
const DIRECTIONS = Object.freeze({
    away: 'away from default',
    back: 'back to default',
    other: 'between custom choices'
});
const settingEvents = Object.fromEntries(Object.entries(SETTINGS).flatMap(([key, setting]) =>
    Object.entries(DIRECTIONS)
        .filter(([direction]) => direction !== 'other' || setting.values.length > 2)
        .map(([direction, label]) => [`setting_${key}_${direction}`, `Settings: ${setting.label} - ${label}`])
));

// Optional host integration. The standalone app has no reporter or network calls.
// Only fixed event codes cross this boundary; never accept event properties.
export const FEATURE_USAGE_EVENTS = Object.freeze({
    app_active: 'App active',
    payment_selected_oa: 'Payment selected: OA',
    payment_selected_zkapi: 'Payment selected: zkAPI',
    default_changed: 'Default changed',
    settings_changed: 'Settings changed',
    ...settingEvents,
    memory_enabled: 'Memory enabled',
    memory_disabled: 'Memory disabled',
    memory_opened: 'Memory panel opened',
    memory_started: 'Memory retrieval started',
    memory_completed: 'Memory retrieval completed',
    scrubber_started: 'Tab Tab started',
    scrubber_completed: 'Tab Tab completed',
    parallel_started: 'Parallel run started',
    parallel_completed: 'Parallel run completed',
    council_started: 'Council review started',
    council_completed: 'Council review completed'
});

let reporter = null;

export function setFeatureUsageReporter(nextReporter) {
    reporter = typeof nextReporter === 'function' ? nextReporter : null;
}

export function trackFeatureUsage(code) {
    if (typeof code !== 'string' || !Object.hasOwn(FEATURE_USAGE_EVENTS, code)) return;
    try {
        // Hosts must return synchronously. Contain a rejected promise too so a
        // faulty integration cannot interrupt a chat action.
        const result = reporter?.(code);
        if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch { /* Analytics must never affect the feature. */ }
}

// Call only for explicit user actions, after the existing update succeeds.
// Imports, hydration, sync and automatic dependent changes must not call this.
export function trackSettingChange(setting, previous, next) {
    if (typeof setting !== 'string' || !Object.hasOwn(SETTINGS, setting)) return;
    const definition = SETTINGS[setting];
    if (!definition.values.includes(previous) || !definition.values.includes(next) || previous === next) return;
    const direction = next === definition.defaultValue ? 'back'
        : previous === definition.defaultValue ? 'away' : 'other';
    trackFeatureUsage('settings_changed');
    if (direction === 'away') trackFeatureUsage('default_changed');
    trackFeatureUsage(`setting_${setting}_${direction}`);
}
