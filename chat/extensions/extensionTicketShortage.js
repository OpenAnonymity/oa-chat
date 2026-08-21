function normalizeTicketCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.ceil(count) : 0;
}

/** Return only aggregate ticket counts that are safe for an extension to observe. */
export function toExtensionTicketShortage(budget = {}) {
    return Object.freeze({
        availableTickets: normalizeTicketCount(budget.availableTickets),
        requiredTickets: normalizeTicketCount(budget.requiredTickets)
    });
}
