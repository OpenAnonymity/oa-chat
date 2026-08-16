function normalizeTicketCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.ceil(count) : 0;
}

export function buildTurnTicketBudget({
    availableTickets,
    inferenceTickets,
    memoryTickets,
    modelLabel = 'the selected model'
} = {}) {
    const available = normalizeTicketCount(availableTickets);
    const inference = normalizeTicketCount(inferenceTickets);
    const memory = normalizeTicketCount(memoryTickets);
    const required = inference + memory;
    const sufficient = available >= required;

    let message = '';
    if (!sufficient) {
        if (memory > 0 && inference > 0) {
            message = `Memory is on: this request needs ${required} tickets (${memory} for Memory and ${inference} for ${modelLabel}). You have ${available}.`;
        } else if (memory > 0) {
            message = `Memory is on: this request needs ${memory} ticket${memory === 1 ? '' : 's'} for Memory. You have ${available}.`;
        } else {
            message = `This request needs ${inference} ticket${inference === 1 ? '' : 's'} for ${modelLabel}. You have ${available}.`;
        }
    }

    return Object.freeze({
        availableTickets: available,
        inferenceTickets: inference,
        memoryTickets: memory,
        requiredTickets: required,
        sufficient,
        message
    });
}
