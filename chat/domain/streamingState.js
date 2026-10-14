export function normalizePendingPhase(phase) {
    // 'thinking': the model is reasoning; the words are not shared by the provider.
    // 'reloading-tickets': an automatic reload is buying the tickets this turn needs.
    // 'skipping-used-tickets': tickets the org had already seen are being set aside.
    if (phase === 'preparing-access' || phase === 'thinking' || phase === 'reloading-tickets'
        || phase === 'skipping-used-tickets') return phase;
    return phase === 'requesting-key' || phase === 'waiting'
        ? 'requesting-key'
        : 'waiting-response';
}
