const PARALLEL_COMPLETION_STATUS_MESSAGES = new Set([
    'First opinions ready.',
    'One model responded.',
    'Responses ready.'
]);

export function getCouncilDisplayState(council = {}) {
    const stage1Entries = Array.isArray(council.stage1) ? council.stage1 : [];
    const synthesis = council.synthesis || null;
    const hasSynthesis = !!synthesis;
    const rawStatusMessage = typeof council.statusMessage === 'string'
        ? council.statusMessage.trim()
        : '';
    const hasPendingStage1 = stage1Entries.some((entry) => entry.status === 'pending' || entry.status === 'running');
    const suppressLegacyParallelStatus = !hasSynthesis
        && !hasPendingStage1
        && PARALLEL_COMPLETION_STATUS_MESSAGES.has(rawStatusMessage);
    const explicitStatusMessage = suppressLegacyParallelStatus ? '' : rawStatusMessage;
    const statusMessage = explicitStatusMessage || (hasPendingStage1 ? 'Waiting for responses...' : '');

    const synthesisStatus = synthesis?.status || null;
    const stage1Summary = '';

    return {
        statusMessage,
        stage1Summary,
        hasPendingStage1,
        hasSynthesis,
        synthesisStatus
    };
}
