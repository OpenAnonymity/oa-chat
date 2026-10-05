// Optional host integration. The standalone app has no reporter or network calls.
// Only fixed event codes cross this boundary; never accept event properties.
export const FEATURE_USAGE_EVENTS = Object.freeze({
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
