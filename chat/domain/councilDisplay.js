const PARALLEL_STATUS_MESSAGES_TO_HIDE_AFTER_STAGE1 = new Set([
    'First opinions ready.',
    'One model responded.',
    'Responses ready.',
    'Waiting for responses...'
]);

export function getCouncilDisplayState(council = {}) {
    const stage1Entries = Array.isArray(council.stage1) ? council.stage1 : [];
    const synthesis = council.synthesis || null;
    const hasSynthesis = !!synthesis;
    const synthesisStatus = synthesis?.status || null;
    const rawStatusMessage = typeof council.statusMessage === 'string'
        ? council.statusMessage.trim()
        : '';
    const hasPendingStage1 = stage1Entries.some((entry) => entry.status === 'pending' || entry.status === 'running');
    const suppressPendingStage1Status = rawStatusMessage === 'Waiting for responses...'
        && hasPendingStage1;
    const suppressLegacyParallelStatus = !hasSynthesis
        && !hasPendingStage1
        && PARALLEL_STATUS_MESSAGES_TO_HIDE_AFTER_STAGE1.has(rawStatusMessage);
    const suppressNormalSynthesisStatus = ['running', 'complete', 'partial'].includes(synthesisStatus);
    const explicitStatusMessage = suppressPendingStage1Status || suppressLegacyParallelStatus || suppressNormalSynthesisStatus
        ? ''
        : rawStatusMessage;
    const statusMessage = explicitStatusMessage;

    const stage1Summary = '';

    return {
        statusMessage,
        stage1Summary,
        hasPendingStage1,
        hasSynthesis,
        synthesisStatus
    };
}
