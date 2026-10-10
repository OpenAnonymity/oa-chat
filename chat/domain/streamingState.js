export function normalizePendingPhase(phase) {
    // 'thinking': the model is reasoning; the words are not shared by the provider.
    if (phase === 'preparing-access' || phase === 'thinking') return phase;
    return phase === 'requesting-key' || phase === 'waiting'
        ? 'requesting-key'
        : 'waiting-response';
}
