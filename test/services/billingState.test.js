import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BILLING_CHECKOUT_INTENT_KEY,
    BILLING_CHECKOUT_STORAGE_KEY,
    hasPendingBillingHandoff
} from '../../chat/services/billingState.js';

function storageWith(entries = {}) {
    return {
        getItem(key) {
            return Object.hasOwn(entries, key) ? entries[key] : null;
        }
    };
}

test('billing return query suppresses generic onboarding', () => {
    assert.equal(hasPendingBillingHandoff({
        search: '?billing=success&session_id=cs_test_example',
        localStorage: storageWith(),
        sessionStorage: storageWith()
    }), true);
});

test('saved checkout recovery suppresses onboarding after return parameters clear', () => {
    assert.equal(hasPendingBillingHandoff({
        search: '',
        localStorage: storageWith({
            [BILLING_CHECKOUT_STORAGE_KEY]: JSON.stringify({
                version: 2,
                sessions: { 'demo:example': { sessionId: 'cs_test_example' } }
            })
        }),
        sessionStorage: storageWith()
    }), true);
});

test('version 3 top-up checkout recovery suppresses onboarding independently', () => {
    assert.equal(hasPendingBillingHandoff({
        search: '',
        localStorage: storageWith({
            [BILLING_CHECKOUT_STORAGE_KEY]: JSON.stringify({
                version: 3,
                sessions: {
                    'account:example': {
                        topup: { sessionId: 'cs_test_topup' }
                    }
                }
            })
        }),
        sessionStorage: storageWith()
    }), true);
});

test('account checkout intent suppresses onboarding while authentication opens', () => {
    assert.equal(hasPendingBillingHandoff({
        search: '',
        localStorage: storageWith(),
        sessionStorage: storageWith({ [BILLING_CHECKOUT_INTENT_KEY]: '1' })
    }), true);
});

test('empty or malformed billing state does not suppress onboarding', () => {
    assert.equal(hasPendingBillingHandoff({
        search: '',
        localStorage: storageWith({ [BILLING_CHECKOUT_STORAGE_KEY]: '{broken' }),
        sessionStorage: storageWith()
    }), false);
});
