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
