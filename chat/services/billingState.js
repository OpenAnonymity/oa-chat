export const BILLING_CHECKOUT_STORAGE_KEY = 'oa-billing-checkout-v1';
export const BILLING_CHECKOUT_INTENT_KEY = 'oa-billing-checkout-intent-v1';

export function hasBillingReturn(search = globalThis.location?.search || '') {
    try {
        return new URLSearchParams(search).has('billing');
    } catch {
        return false;
    }
}

export function hasSavedBillingCheckout(storage = globalThis.localStorage) {
    if (!storage) return false;
    try {
        const value = JSON.parse(storage.getItem(BILLING_CHECKOUT_STORAGE_KEY) || 'null');
        if (value?.version === 2 && value.sessions && typeof value.sessions === 'object') {
            return Object.values(value.sessions).some(session => Boolean(session?.sessionId));
        }
        return Boolean(value?.scope && value?.sessionId);
    } catch {
        return false;
    }
}

export function hasBillingCheckoutIntent(storage = globalThis.sessionStorage) {
    try {
        return storage?.getItem(BILLING_CHECKOUT_INTENT_KEY) === '1';
    } catch {
        return false;
    }
}

export function hasPendingBillingHandoff(options = {}) {
    return hasBillingReturn(options.search) ||
        hasSavedBillingCheckout(options.localStorage) ||
        hasBillingCheckoutIntent(options.sessionStorage);
}
