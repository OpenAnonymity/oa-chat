// The steps a zkAPI chat took to secure a request, kept on the message
// once the response starts. Pure: a pending presentation in, the part
// worth keeping out.

/** What of a security presentation is worth keeping on the message once the
 *  response starts: the category, the steps as they ended, the note, and a
 *  summary without the "sending your message…" tail. Null for anything that
 *  is not a security trace. */
export function snapshotAccessTrace(presentation) {
    if (!presentation || presentation.mode !== 'security') return null;
    const steps = (Array.isArray(presentation.steps) ? presentation.steps : [])
        .map(step => ({ id: String(step?.id ?? ''), label: String(step?.label ?? ''), state: String(step?.state ?? 'upcoming') }));
    return {
        category: String(presentation.category || 'Private access'),
        summary: String(presentation.current || '').split(' · ')[0] || String(presentation.category || 'Private access'),
        phase: String(presentation.progressPhase || ''),
        steps,
        note: String(presentation.note || '')
    };
}

/** The trace as it is kept once the response has started: whatever the
 *  last presentation showed, the work finished — every step complete,
 *  the summary in the past tense. */
export function completeAccessTrace(trace) {
    if (!trace) return null;
    const done = {
        'Private access': 'Private access secured',
        'Refreshing private access': 'Private access refreshed',
        'Finishing previous chat': 'Previous chat finished',
        'Private access recovery': 'Private access recovered'
    };
    return {
        ...trace,
        phase: 'ready',
        summary: done[trace.category] || trace.summary,
        steps: trace.steps.map(step => ({ ...step, state: 'complete' }))
    };
}

/** A request can pass through more than one stage before the model answers
 *  — finishing the previous chat's key, then securing private access. Each
 *  stage is kept once, by category, in the order it appeared; a later
 *  report for the same stage replaces the earlier one. */
export function upsertAccessStage(stages, trace) {
    if (!trace) return stages;
    const list = Array.isArray(stages) ? stages : [];
    const index = list.findIndex(stage => stage.category === trace.category);
    if (index === -1) list.push(trace); else list[index] = trace;
    return list;
}

/** The stages as rendered: always a list (older messages kept a single
 *  object), and once the response has started, all finished. */
export function keptAccessStages(value, finished = true) {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    const stages = list.filter(stage => stage && Array.isArray(stage.steps) && stage.steps.length > 0);
    return finished ? stages.map(completeAccessTrace) : stages;
}
