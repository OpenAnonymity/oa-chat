export function normalizePendingPhase(phase) {
    return phase === 'requesting-key' || phase === 'waiting'
        ? 'requesting-key'
        : 'waiting-response';
}
