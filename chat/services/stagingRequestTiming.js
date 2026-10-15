// STAGING EXPERIMENT: exclude this revision from production, even disabled.
// Only explicitly enabled web test sessions have a sink. No content/IDs enter records.
const enabled = typeof __OA_STAGING_TIMING__ !== 'undefined' && __OA_STAGING_TIMING__;
const roots = new WeakMap();
let sink = null;
const fields = ['preparation_ms', 'access_ms', 'verification_ms', 'provider_dispatch_ms', 'response_headers_ms',
    'first_reasoning_ms', 'first_answer_ms', 'first_visible_answer_ms'];
const round = value => Math.round(Math.max(0, Math.min(3600000, value)) / 10) * 10;
export function setStagingTimingSink(value) { if (enabled) sink = typeof value === 'function' ? value : null; }

// Exported for deterministic tests; never reads a prompt, credential, session or user.
export function createTimingRecorder({ start, model = null, mode = 'ticket', lane = 'single', now = () => performance.now(), visible = () => false }) {
    const values = Object.fromEntries(fields.map(name => [name, null]));
    let outcome = 'not_sent', end = null, key = 'unknown', acquisitionAttempted = false;
    const spans = new Map();
    return {
        setModel(value) { if (typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,100}$/.test(value)) model = value; },
        setKey(value) { if (value === 'reused' && acquisitionAttempted) return; if (['new', 'reused', 'unknown'].includes(value)) key = value; },
        acquiring() { acquisitionAttempted = true; },
        setVisible(check) { visible = check; },
        mark(name) { if (name === 'provider_dispatch_ms' && values.preparation_ms === null && end === null) values.preparation_ms = round(now() - start); if (end === null && fields.includes(name) && values[name] === null) values[name] = round(now() - start); },
        begin(name) { if (name === 'access_ms' && values.preparation_ms === null && end === null) values.preparation_ms = round(now() - start); if (end === null && ['access_ms', 'verification_ms'].includes(name) && !spans.has(name)) spans.set(name, now()); },
        end(name) { if (end === null && spans.has(name)) { values[name] = (values[name] || 0) + now() - spans.get(name); spans.delete(name); } },
        answer() { this.mark('first_answer_ms'); },
        rendered() { try { if (visible()) this.mark('first_visible_answer_ms'); } catch {} },
        outcome(value) { if (end !== null) return; outcome = value; if (value === 'complete' || value === 'cancelled') this.settle(value); },
        settle(value) { if (end !== null) return; for (const name of [...spans.keys()]) this.end(name); outcome = value; end = now(); },
        record(fallback) {
            if (end === null) this.settle(fallback === 'cancelled' || (fallback === 'error' && outcome === 'not_sent') ? fallback : outcome);
            if (!model) return null;
            return { v: 1, model, platform: 'web', mode, key, outcome, lane, elapsed_ms: round(end - start), ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value === null ? null : round(value)])) };
        }
    };
}

export function startRequestTiming(signal, options = {}) {
    if (!enabled || !sink || !signal || roots.has(signal)) return;
    try { roots.set(signal, { start: performance.now(), options, records: new Map() }); return true; } catch {}
}
export function requestTiming(signal, laneId = 'single', model = null) {
    if (!enabled) return null;
    try {
        const root = roots.get(signal);
        if (!root) return null;
        if (!root.records.has(laneId)) {
            if (root.records.size >= 8) return null;
            root.records.set(laneId, createTimingRecorder({ ...root.options, start: root.start,
                lane: laneId === 'single' ? 'single' : laneId === 'synthesis' ? 'synthesis' : 'parallel' }));
        }
        const record = root.records.get(laneId);
        if (model) record.setModel(model);
        return record;
    } catch { return null; }
}
export function hasRequestTiming(signal) { return enabled && roots.has(signal); }
export function finishRequestTiming(signal, fallback = 'not_sent') {
    if (!enabled) return;
    const root = roots.get(signal);
    if (!root) return;
    roots.delete(signal);
    for (const timing of root.records.values()) {
        try { const value = timing.record(signal.aborted ? 'cancelled' : fallback); if (value) sink?.(value); } catch {}
    }
}

// Keep display callbacks in their original order. First visible answer means the
// app's text-render callback completed in the selected, visible chat, not paint time.
export function timingCallbacks(timing, onChunk, onOpen, onReasoning) {
    if (!timing) return { onChunk, onOpen, onReasoning };
    return {
        onChunk: async (chunk, ...rest) => {
            if (typeof chunk === 'string' && chunk.trim()) timing.answer();
            const result = await onChunk?.(chunk, ...rest);
            if (typeof chunk === 'string' && chunk.trim()) timing.rendered();
            return result;
        },
        onOpen: (...args) => { timing.mark('response_headers_ms'); return onOpen?.(...args); },
        onReasoning: (chunk, meta) => {
            if ((typeof chunk === 'string' && chunk.trim()) || meta?.withheld) timing.mark('first_reasoning_ms');
            return onReasoning?.(chunk, meta);
        }
    };
}

// Conservative display acknowledgement; no text content is returned or exported.
export function timingTextVisible(app, sessionId, messageId, laneId = null) {
    try {
        if (document.visibilityState !== 'visible' || !app.isViewingSession(sessionId)) return false;
        const row = document.querySelector(`[data-message-id="${messageId}"]`);
        const container = laneId ? app.chatArea?.getCouncilLaneBody(messageId, laneId) : row;
        const content = container?.querySelector(laneId ? '.council-lane-content' : '.message-content');
        if (!content?.textContent?.trim() || content.closest('[hidden], [aria-hidden="true"]')) return false;
        if (content.checkVisibility && !content.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
        const rect = content.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    } catch { return false; }
}
