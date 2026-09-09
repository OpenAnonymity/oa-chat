import { getTicketCost } from '../../publicModelTierApi.js';

// Reviewed against staging OA's existing child-key financial envelopes. These
// are public spending buckets, never a disclosure of the user's exact balance.
// A new ticket tier requires an explicit budget review rather than interpolation.
export const TICKET_TIER_BUDGET_USD = Object.freeze({
    1: 1,
    2: 1,
    3: 2,
    5: 3,
    8: 2,
    25: 4.5,
    100: 6
});

export function spendingLimitUsdForTicketCost(ticketCost) {
    if (!Number.isSafeInteger(ticketCost)
        || !Object.hasOwn(TICKET_TIER_BUDGET_USD, ticketCost)) {
        const error = new Error('A private-key budget is not configured for this model tier. Choose another model or try again later.');
        error.code = 'unsupported_model_budget';
        throw error;
    }
    return TICKET_TIER_BUDGET_USD[ticketCost];
}

/** Uses OA's exact live assignment, variant and reasoning fallback rules. */
export function getModelBudget(modelId, reasoningEnabled = false) {
    const ticketCost = getTicketCost(modelId, reasoningEnabled);
    return { ticketCost, spendingLimitUsd: spendingLimitUsdForTicketCost(ticketCost) };
}

export function formatModelBudgetUsd(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return new Intl.NumberFormat(undefined, {
        style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2
    }).format(amount);
}
