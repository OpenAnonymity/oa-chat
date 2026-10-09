export function normalizePendingPhase(phase) {
    // 'thinking': the model is reasoning but the provider keeps the words.
    if (phase === 'preparing-access' || phase === 'thinking') return phase;
    return phase === 'requesting-key' || phase === 'waiting'
        ? 'requesting-key'
        : 'waiting-response';
}
