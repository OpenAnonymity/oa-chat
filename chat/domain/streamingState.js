export function normalizePendingPhase(phase) {
    if (phase === 'preparing-access') return phase;
    return phase === 'requesting-key' || phase === 'waiting'
        ? 'requesting-key'
        : 'waiting-response';
}
