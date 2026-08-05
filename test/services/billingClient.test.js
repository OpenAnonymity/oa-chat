import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BILLING_TOPUP_RETURN_SESSION_KEY,
    BillingClient,
    isLoopbackHostname
} from '../../chat/services/billingClient.js';
import { BILLING_CHECKOUT_STORAGE_KEY } from '../../chat/services/billingState.js';

class MemoryPendingStore {
    constructor() { this.values = new Map(); }
    async get(key) { return this.values.has(key) ? structuredClone(this.values.get(key)) : null; }
    async put(value) { this.values.set(value.accountScope, structuredClone(value)); return this.get(value.accountScope); }
    async delete(key) { this.values.delete(key); }
}

function response(data, ok = true, status = 200) {
    return {
        ok,
        status,
        async text() { return JSON.stringify(data); },
        async json() { return data; }
    };
}

function makeAuth(scope = 'demo:local-test-user') {
    return {
        async resolve() {
            return { scope, headers: { 'X-OA-Demo-Account-ID': 'local-test-user-1234' }, mode: 'development' };
        },
        getKnownScope(state) { return state?.accountId ? `account:${state.accountId}` : scope; },
        subscribe() { return () => {}; }
    };
}

function memoryStorage() {
    const values = new Map();
    return {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); }
    };
}

function memoryLockManager() {
    return {
        async request(_name, _options, callback) {
            return callback();
        }
    };
}

test('billing recognizes only explicit loopback hostnames', () => {
    assert.equal(isLoopbackHostname('localhost'), true);
    assert.equal(isLoopbackHostname('127.0.0.1'), true);
    assert.equal(isLoopbackHostname('::1'), true);
    assert.equal(isLoopbackHostname('localhost.example.com'), false);
});

test('public plan request does not create or send a billing identity', async () => {
    const calls = [];
    const client = new BillingClient({
        authProvider: {
            resolve() { throw new Error('auth must not run'); },
            subscribe() { return () => {}; }
        },
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return response({
                id: 'premium_monthly', unit_amount: 3500, currency: 'usd',
                interval: 'month', tickets_per_period: 300
            });
        }
    });

    const plan = await client.getPlan();

    assert.equal(plan.unit_amount, 3500);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.Authorization, undefined);
    assert.equal(calls[0].options.headers['X-OA-Demo-Account-ID'], undefined);
    client.destroy();
});

test('Checkout stores its session under the frozen account scope and sends no account identifier', async () => {
    const storage = memoryStorage();
    const calls = [];
    const originalWindow = globalThis.window;
    globalThis.window = {
        location: {
            origin: 'https://staging.openanonymity.ai',
            assign() {}
        }
    };
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        storage,
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return response({ session_id: 'cs_test_alpha' });
        }
    });

    try {
        await client.checkout();
        const body = JSON.parse(calls[0].options.body);
        assert.deepEqual(body, { return_origin: 'https://staging.openanonymity.ai' });
        assert.equal(body.account_id, undefined);
        assert.equal(client.getCheckoutSession('account:alpha').sessionId, 'cs_test_alpha');
    } finally {
        client.destroy();
        globalThis.window = originalWindow;
    }
});

test('Checkout recovery version 3 keeps subscription and top-up sessions independent', () => {
    const storage = memoryStorage();
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        pendingStore: new MemoryPendingStore(),
        storage,
        fetchImpl: async () => response({})
    });

    client.saveCheckoutSession('cs_test_subscription', 'account:alpha', 'subscription');
    client.saveCheckoutSession('cs_test_topup', 'account:alpha', 'topup');

    assert.equal(client.getCheckoutSession('account:alpha', 'subscription').sessionId, 'cs_test_subscription');
    assert.equal(client.getCheckoutSession('account:alpha', 'topup').sessionId, 'cs_test_topup');
    assert.equal(JSON.parse(storage.getItem(BILLING_CHECKOUT_STORAGE_KEY)).version, 3);
    client.clearCheckoutSession('account:alpha', 'topup');
    assert.equal(client.getCheckoutSession('account:alpha', 'topup'), null);
    assert.equal(client.getCheckoutSession('account:alpha', 'subscription').sessionId, 'cs_test_subscription');
    client.destroy();
});

test('Checkout recovery migrates version 2 records as subscription sessions', () => {
    const storage = memoryStorage();
    storage.setItem(BILLING_CHECKOUT_STORAGE_KEY, JSON.stringify({
        version: 2,
        sessions: {
            'account:alpha': { sessionId: 'cs_test_legacy', savedAt: 123 }
        }
    }));
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        pendingStore: new MemoryPendingStore(),
        storage,
        fetchImpl: async () => response({})
    });

    assert.equal(client.getCheckoutSession('account:alpha', 'subscription').sessionId, 'cs_test_legacy');
    assert.equal(client.getCheckoutSession('account:alpha', 'topup'), null);
    client.saveCheckoutSession('cs_test_topup', 'account:alpha', 'topup');
    const migrated = JSON.parse(storage.getItem(BILLING_CHECKOUT_STORAGE_KEY));
    assert.equal(migrated.version, 3);
    assert.equal(migrated.sessions['account:alpha'].subscription.sessionId, 'cs_test_legacy');
    assert.equal(migrated.sessions['account:alpha'].topup.sessionId, 'cs_test_topup');
    client.destroy();
});

test('ticket-pack Checkout uses its dedicated endpoint and recovery kind', async () => {
    const storage = memoryStorage();
    const sessionStorage = memoryStorage();
    const pendingStore = new MemoryPendingStore();
    const calls = [];
    let redirected = '';
    const originalWindow = globalThis.window;
    globalThis.window = {
        location: {
            origin: 'https://staging.openanonymity.ai',
            assign(value) { redirected = value; }
        }
    };
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        pendingStore,
        storage,
        sessionStorage,
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return response({
                session_id: 'cs_test_topup',
                url: 'https://checkout.stripe.test/topup'
            });
        }
    });

    try {
        await client.purchaseTicketPack();
        assert.ok(calls[0].url.endsWith('/api/billing/topups/checkout'));
        assert.deepEqual(JSON.parse(calls[0].options.body), {
            return_origin: 'https://staging.openanonymity.ai'
        });
        assert.equal(client.getCheckoutSession('account:alpha', 'topup').sessionId, 'cs_test_topup');
        assert.equal(client.getCheckoutSession('account:alpha', 'subscription'), null);
        assert.equal(
            JSON.parse(sessionStorage.getItem(BILLING_TOPUP_RETURN_SESSION_KEY)).sessionId,
            'cs_test_topup'
        );
        assert.equal(redirected, 'https://checkout.stripe.test/topup');
    } finally {
        client.destroy();
        globalThis.window = originalWindow;
    }
});

test('ticket-pack cancellation posts only the session and clears only terminal top-up recovery', async () => {
    const storage = memoryStorage();
    const sessionStorage = memoryStorage();
    const calls = [];
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        pendingStore: new MemoryPendingStore(),
        storage,
        sessionStorage,
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return response({
                outcome: 'cancelled',
                status: {
                    ticket_pack: { eligible: true, can_purchase: true, state: 'ready' }
                }
            });
        }
    });
    client.saveCheckoutSession('cs_test_subscription', 'account:alpha', 'subscription');
    client.saveCheckoutSession('cs_test_topup', 'account:alpha', 'topup');
    client.saveTopupReturnSession('cs_test_topup');

    const result = await client.cancelTicketPackCheckout('cs_test_topup');

    assert.equal(result.outcome, 'cancelled');
    assert.ok(calls[0].url.endsWith('/api/billing/topups/checkout/cancel'));
    assert.deepEqual(JSON.parse(calls[0].options.body), { session_id: 'cs_test_topup' });
    assert.equal(client.getCheckoutSession('account:alpha', 'topup'), null);
    assert.equal(
        client.getCheckoutSession('account:alpha', 'subscription').sessionId,
        'cs_test_subscription'
    );
    assert.equal(sessionStorage.getItem(BILLING_TOPUP_RETURN_SESSION_KEY), null);
    client.destroy();
});

test('a stale cancellation response cannot clear a newer top-up Checkout', async () => {
    const storage = memoryStorage();
    const sessionStorage = memoryStorage();
    let releaseCancellation;
    const cancellationGate = new Promise(resolve => { releaseCancellation = resolve; });
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        pendingStore: new MemoryPendingStore(),
        storage,
        sessionStorage,
        fetchImpl: async () => {
            await cancellationGate;
            return response({
                outcome: 'cancelled',
                status: { ticket_pack: { eligible: true, state: 'ready' } }
            });
        }
    });
    client.saveCheckoutSession('cs_test_old', 'account:alpha', 'topup');
    client.saveTopupReturnSession('cs_test_old');

    const cancelling = client.cancelTicketPackCheckout('cs_test_old');
    await new Promise(resolve => setTimeout(resolve, 0));
    client.saveCheckoutSession('cs_test_new', 'account:alpha', 'topup');
    client.saveTopupReturnSession('cs_test_new');
    releaseCancellation();
    await cancelling;

    assert.equal(client.getCheckoutSession('account:alpha', 'topup').sessionId, 'cs_test_new');
    assert.equal(client.getTopupReturnSession().sessionId, 'cs_test_new');
    client.destroy();
});

test('claimable status converts an idempotent cancellation into payment confirmation', async () => {
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        pendingStore: new MemoryPendingStore(),
        storage: memoryStorage(),
        fetchImpl: async () => response({
            outcome: 'cancelled',
            status: { ticket_pack: { eligible: true, state: 'claimable' } }
        })
    });
    client.saveCheckoutSession('cs_test_paid_race', 'account:alpha', 'topup');

    const result = await client.cancelTicketPackCheckout('cs_test_paid_race');

    assert.equal(result.outcome, 'payment_confirmed');
    assert.equal(client.getCheckoutSession('account:alpha', 'topup'), null);
    client.destroy();
});

test('payment-pending cancellation and request failure preserve top-up recovery', async () => {
    const storage = memoryStorage();
    let fail = false;
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        pendingStore: new MemoryPendingStore(),
        storage,
        fetchImpl: async () => fail
            ? response({ detail: { code: 'BILLING_UNAVAILABLE' } }, false, 503)
            : response({
                outcome: 'payment_pending',
                status: { ticket_pack: { eligible: true, state: 'checkout_pending' } }
            })
    });
    client.saveCheckoutSession('cs_test_pending', 'account:alpha', 'topup');

    const pending = await client.cancelTicketPackCheckout('cs_test_pending');
    assert.equal(pending.outcome, 'payment_pending');
    assert.equal(client.getCheckoutSession('account:alpha', 'topup').sessionId, 'cs_test_pending');

    fail = true;
    await assert.rejects(
        () => client.cancelTicketPackCheckout('cs_test_pending'),
        error => error.code === 'BILLING_UNAVAILABLE'
    );
    assert.equal(client.getCheckoutSession('account:alpha', 'topup').sessionId, 'cs_test_pending');
    client.destroy();
});

test('account switching aborts cancellation before local recovery can be cleared', async () => {
    let currentScope = 'account:alpha';
    let releaseRequest;
    const requestGate = new Promise(resolve => { releaseRequest = resolve; });
    const auth = {
        async resolve() {
            const scope = currentScope;
            return { scope, headers: { Authorization: `Bearer ${scope}` }, mode: 'account' };
        },
        getKnownScope() { return currentScope; },
        subscribe() { return () => {}; }
    };
    const client = new BillingClient({
        authProvider: auth,
        pendingStore: new MemoryPendingStore(),
        storage: memoryStorage(),
        fetchImpl: async () => {
            await requestGate;
            return response({
                outcome: 'cancelled',
                status: { ticket_pack: { state: 'ready' } }
            });
        }
    });
    client.saveCheckoutSession('cs_test_alpha', 'account:alpha', 'topup');

    const cancellation = client.cancelTicketPackCheckout('cs_test_alpha');
    await new Promise(resolve => setTimeout(resolve, 0));
    currentScope = 'account:beta';
    client.handleIdentityChange({ accountId: 'beta' });
    releaseRequest();

    await assert.rejects(cancellation, error => error?.name === 'AbortError');
    assert.equal(client.getCheckoutSession('account:alpha', 'topup').sessionId, 'cs_test_alpha');
    client.destroy();
});

test('server ready status clears expired Checkout recovery but preserves a pending top-up import', async () => {
    const storage = memoryStorage();
    const pendingStore = new MemoryPendingStore();
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        pendingStore,
        storage,
        fetchImpl: async () => response({
            ticket_pack: { eligible: true, can_purchase: true, state: 'ready', ticket_count: 50 },
            plan: { ticket_pack: { tickets: 50 } }
        })
    });
    client.saveCheckoutSession('cs_test_expired', 'account:alpha', 'topup');

    await client.getStatus({ force: true });
    assert.equal(client.getCheckoutSession('account:alpha', 'topup'), null);

    client.saveCheckoutSession('cs_test_claim', 'account:alpha', 'topup');
    await pendingStore.put({
        accountScope: 'account:alpha',
        source: 'topup',
        claimRef: 'a'.repeat(64),
        targetCount: 50
    });
    const status = await client.getStatus({ force: true });
    assert.equal(status.ticket_pack.state, 'claiming');
    assert.equal(client.getCheckoutSession('account:alpha', 'topup').sessionId, 'cs_test_claim');
    assert.ok(await pendingStore.get('account:alpha'));
    client.destroy();
});

test('a stale ready status response cannot clear a newer top-up Checkout', async () => {
    let releaseStatus;
    const statusGate = new Promise(resolve => { releaseStatus = resolve; });
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        pendingStore: new MemoryPendingStore(),
        storage: memoryStorage(),
        fetchImpl: async () => {
            await statusGate;
            return response({
                ticket_pack: { eligible: true, can_purchase: true, state: 'ready' },
                plan: { ticket_pack: { tickets: 50 } }
            });
        }
    });
    client.saveCheckoutSession('cs_test_old', 'account:alpha', 'topup');

    const loading = client.getStatus({ force: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    client.saveCheckoutSession('cs_test_new', 'account:alpha', 'topup');
    releaseStatus();
    await loading;

    assert.equal(client.getCheckoutSession('account:alpha', 'topup').sessionId, 'cs_test_new');
    client.destroy();
});

test('terminal ineligible status clears only the matching disabled-feature recovery', async () => {
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        pendingStore: new MemoryPendingStore(),
        storage: memoryStorage(),
        fetchImpl: async () => response({
            ticket_pack: { eligible: false, can_purchase: false, state: 'ineligible' },
            plan: { ticket_pack: null }
        })
    });
    client.saveCheckoutSession('cs_test_disabled', 'account:alpha', 'topup');

    await client.getStatus({ force: true });

    assert.equal(client.getCheckoutSession('account:alpha', 'topup'), null);
    client.destroy();
});

test('a pending-claim storage failure cannot clear Checkout recovery', async () => {
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        pendingStore: { async get() { throw new Error('IndexedDB unavailable'); } },
        storage: memoryStorage(),
        fetchImpl: async () => response({
            ticket_pack: { eligible: true, can_purchase: true, state: 'ready' },
            plan: { ticket_pack: { tickets: 50 } }
        })
    });
    client.saveCheckoutSession('cs_test_preserved', 'account:alpha', 'topup');

    await client.getStatus({ force: true });

    assert.equal(client.getCheckoutSession('account:alpha', 'topup').sessionId, 'cs_test_preserved');
    client.destroy();
});

test('a local unimported top-up blocks another browser purchase', async () => {
    const pendingStore = new MemoryPendingStore();
    await pendingStore.put({
        accountScope: 'account:alpha',
        source: 'topup',
        claimRef: 'a'.repeat(64),
        targetCount: 50
    });
    let called = false;
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        pendingStore,
        fetchImpl: async () => { called = true; return response({}); }
    });

    await assert.rejects(
        () => client.purchaseTicketPack(),
        error => error.code === 'BILLING_TOPUP_PENDING'
    );
    assert.equal(called, false);
    client.destroy();
});

test('an account switch during the local top-up check prevents Checkout creation', async () => {
    let currentScope = 'account:alpha';
    let releasePending;
    let checkoutCalled = false;
    const pendingGate = new Promise(resolve => { releasePending = resolve; });
    const auth = {
        async resolve() {
            const scope = currentScope;
            return { scope, headers: { Authorization: `Bearer ${scope}` }, mode: 'account' };
        },
        getKnownScope() { return currentScope; },
        subscribe() { return () => {}; }
    };
    const client = new BillingClient({
        authProvider: auth,
        pendingStore: {
            async get() { await pendingGate; return null; }
        },
        fetchImpl: async () => {
            checkoutCalled = true;
            return response({});
        }
    });

    const checkout = client.purchaseTicketPack();
    await new Promise(resolve => setTimeout(resolve, 0));
    currentScope = 'account:beta';
    client.handleIdentityChange({ accountId: 'beta' });
    releasePending();

    await assert.rejects(checkout, error => error.name === 'AbortError');
    assert.equal(checkoutCalled, false);
    client.destroy();
});

test('an account switch during Checkout prevents redirect and preserves per-account recovery', async () => {
    const storage = memoryStorage();
    let currentScope = 'account:alpha';
    let releaseCheckout;
    let redirected = false;
    const checkoutGate = new Promise(resolve => { releaseCheckout = resolve; });
    const auth = {
        async resolve() {
            const scope = currentScope;
            return { scope, headers: { Authorization: `Bearer ${scope}` }, mode: 'account' };
        },
        getKnownScope() { return currentScope; },
        subscribe() { return () => {}; }
    };
    const originalWindow = globalThis.window;
    globalThis.window = {
        location: {
            origin: 'https://staging.openanonymity.ai',
            assign() { redirected = true; }
        }
    };
    const client = new BillingClient({
        authProvider: auth,
        storage,
        fetchImpl: async () => {
            await checkoutGate;
            return response({
                session_id: 'cs_test_alpha',
                url: 'https://checkout.stripe.test/alpha'
            });
        }
    });

    try {
        const checkout = client.checkout();
        await new Promise(resolve => setTimeout(resolve, 0));
        currentScope = 'account:beta';
        client.handleIdentityChange({ accountId: 'beta' });
        releaseCheckout();

        await assert.rejects(checkout, error => error.name === 'AbortError');
        assert.equal(redirected, false);
        assert.equal(client.getCheckoutSession('account:alpha'), null);
        assert.equal(client.getCheckoutSession('account:beta'), null);
    } finally {
        client.destroy();
        globalThis.window = originalWindow;
    }
});

test('saved Checkout confirmation resumes after reload for the same local account', async () => {
    const storage = memoryStorage();
    const scope = 'demo:local-test-user';
    const client = new BillingClient({
        authProvider: {
            ...makeAuth(scope),
            hasKnownIdentity() { return true; }
        },
        storage,
        fetchImpl: async url => {
            assert.ok(url.endsWith('/api/billing/status'));
            return response({ available_batches: 1, plan: { tickets_per_period: 300 } });
        }
    });
    client.saveCheckoutSession('cs_test_saved', scope);

    const status = await client.resumeSavedCheckout({ pollMs: 1 });

    assert.equal(status.available_batches, 1);
    assert.equal(client.getCheckoutSession(scope), null);
    client.destroy();
});

test('a failed subscription recovery does not block saved top-up recovery', async () => {
    const storage = memoryStorage();
    const scope = 'account:alpha';
    const calls = [];
    const client = new BillingClient({
        authProvider: {
            ...makeAuth(scope),
            hasKnownIdentity() { return true; }
        },
        pendingStore: new MemoryPendingStore(),
        storage,
        fetchImpl: async (url, options = {}) => {
            calls.push(url);
            if (url.endsWith('/api/billing/status')) {
                return response({
                    available_batches: 0,
                    ticket_pack: { eligible: true, state: 'checkout_pending' },
                    plan: { tickets_per_period: 300, ticket_pack: { tickets: 50 } }
                });
            }
            if (url.endsWith('/api/billing/checkout/complete')) {
                return response({ detail: { code: 'BILLING_NO_ENTITLEMENT' } }, false, 409);
            }
            if (url.endsWith('/api/billing/topups/checkout/complete')) {
                return response({ status: {
                    available_batches: 0,
                    ticket_pack: {
                        eligible: true,
                        can_purchase: false,
                        state: 'claimable',
                        ticket_count: 50,
                        claim_ref: 'b'.repeat(64)
                    },
                    plan: { tickets_per_period: 300, ticket_pack: { tickets: 50 } }
                }});
            }
            throw new Error(`Unexpected request: ${url}`);
        }
    });
    client.saveCheckoutSession('cs_test_subscription', scope, 'subscription');
    client.saveCheckoutSession('cs_test_topup', scope, 'topup');

    const status = await client.resumeSavedCheckout({ timeoutMs: 0 });

    assert.equal(status.ticket_pack.state, 'claimable');
    assert.equal(calls.some(url => url.endsWith('/api/billing/checkout/complete')), true);
    assert.equal(calls.some(url => url.endsWith('/api/billing/topups/checkout/complete')), true);
    assert.equal(client.getCheckoutSession(scope, 'subscription').sessionId, 'cs_test_subscription');
    assert.equal(client.getCheckoutSession(scope, 'topup'), null);
    client.destroy();
});

test('expired top-up recovery stops after terminal ready status without completing', async () => {
    const storage = memoryStorage();
    const scope = 'account:alpha';
    const calls = [];
    const client = new BillingClient({
        authProvider: makeAuth(scope),
        pendingStore: new MemoryPendingStore(),
        storage,
        fetchImpl: async url => {
            calls.push(url);
            return response({
                ticket_pack: {
                    eligible: true,
                    can_purchase: true,
                    state: 'ready',
                    ticket_count: 50
                },
                plan: { ticket_pack: { tickets: 50 } }
            });
        }
    });
    client.saveCheckoutSession('cs_test_expired_return', scope, 'topup');

    const result = await client.reconcileCheckout('cs_test_expired_return', {
        kind: 'topup',
        pollMs: 1,
        timeoutMs: 5
    });

    assert.equal(result, null);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith('/api/billing/status'));
    assert.equal(client.getCheckoutSession(scope, 'topup'), null);
    client.destroy();
});

test('top-up reconciliation uses its completion endpoint without clearing subscription recovery', async () => {
    const storage = memoryStorage();
    const scope = 'account:alpha';
    const calls = [];
    const client = new BillingClient({
        authProvider: makeAuth(scope),
        pendingStore: new MemoryPendingStore(),
        storage,
        fetchImpl: async (url, options = {}) => {
            calls.push({ url, options });
            if (url.endsWith('/api/billing/topups/checkout/complete')) {
                return response({
                    status: {
                        ticket_pack: {
                            eligible: true,
                            can_purchase: false,
                            state: 'claimable',
                            ticket_count: 50,
                            claim_ref: 'b'.repeat(64)
                        },
                        plan: { ticket_pack: { tickets: 50 } }
                    }
                });
            }
            throw new Error(`Unexpected request: ${url}`);
        }
    });
    client.saveCheckoutSession('cs_test_subscription', scope, 'subscription');

    const status = await client.reconcileCheckout('cs_test_topup', {
        kind: 'topup',
        timeoutMs: 0
    });

    assert.equal(status.ticket_pack.state, 'claimable');
    assert.ok(calls[0].url.endsWith('/api/billing/topups/checkout/complete'));
    assert.deepEqual(JSON.parse(calls[0].options.body), { session_id: 'cs_test_topup' });
    assert.equal(client.getCheckoutSession(scope, 'topup'), null);
    assert.equal(client.getCheckoutSession(scope, 'subscription').sessionId, 'cs_test_subscription');
    client.destroy();
});

test('Checkout recovery is scoped and an account switch aborts without clearing it', async () => {
    let currentScope = 'account:alpha';
    let releaseStatus;
    const statusGate = new Promise(resolve => { releaseStatus = resolve; });
    const auth = {
        async resolve() {
            const scope = currentScope;
            return { scope, headers: { Authorization: `Bearer ${scope}` }, mode: 'account' };
        },
        getKnownScope() { return currentScope; },
        subscribe() { return () => {}; }
    };
    const client = new BillingClient({
        authProvider: auth,
        storage: memoryStorage(),
        fetchImpl: async url => {
            assert.ok(url.endsWith('/api/billing/status'));
            await statusGate;
            return response({ available_batches: 0, plan: {} });
        }
    });

    const reconciliation = client.reconcileCheckout('cs_test_alpha', { pollMs: 1000 });
    await new Promise(resolve => setTimeout(resolve, 0));
    currentScope = 'account:beta';
    client.handleIdentityChange({ accountId: 'beta' });
    releaseStatus();

    await assert.rejects(reconciliation, error => error.name === 'AbortError');
    assert.equal(client.getCheckoutSession('account:alpha').sessionId, 'cs_test_alpha');
    assert.equal(client.getCheckoutSession('account:beta'), null);
    client.destroy();
});

test('a stale status response cannot be displayed after account switching', async () => {
    let currentScope = 'account:alpha';
    let releaseStatus;
    const statusGate = new Promise(resolve => { releaseStatus = resolve; });
    const auth = {
        async resolve() {
            const scope = currentScope;
            return { scope, headers: { Authorization: `Bearer ${scope}` }, mode: 'account' };
        },
        getKnownScope() { return currentScope; },
        subscribe() { return () => {}; }
    };
    const client = new BillingClient({
        authProvider: auth,
        fetchImpl: async () => {
            await statusGate;
            return response({ available_batches: 9, plan: {} });
        }
    });

    const loading = client.getStatus({ force: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    currentScope = 'account:beta';
    client.handleIdentityChange({ accountId: 'beta' });
    releaseStatus();

    await assert.rejects(loading, error => error.name === 'AbortError');
    assert.equal(client.status, null);
    client.destroy();
});

test('status cannot publish after an account switch during pending-claim lookup', async () => {
    let currentScope = 'account:alpha';
    let releasePending;
    const pendingGate = new Promise(resolve => { releasePending = resolve; });
    const auth = {
        async resolve() {
            const scope = currentScope;
            return { scope, headers: { Authorization: `Bearer ${scope}` }, mode: 'account' };
        },
        getKnownScope() { return currentScope; },
        subscribe() { return () => {}; }
    };
    const client = new BillingClient({
        authProvider: auth,
        pendingStore: {
            async get() { await pendingGate; return null; }
        },
        fetchImpl: async () => response({ available_batches: 9, plan: {} })
    });

    const loading = client.getStatus({ force: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    currentScope = 'account:beta';
    client.handleIdentityChange({ accountId: 'beta' });
    releasePending();

    await assert.rejects(loading, error => error.name === 'AbortError');
    assert.equal(client.status, null);
    client.destroy();
});

test('status keeps another top-up blocked until durable local recovery is imported', async () => {
    const pendingStore = new MemoryPendingStore();
    await pendingStore.put({
        accountScope: 'account:alpha',
        source: 'topup',
        claimRef: 'd'.repeat(64),
        targetCount: 50
    });
    const client = new BillingClient({
        authProvider: makeAuth('account:alpha'),
        pendingStore,
        fetchImpl: async () => response({
            ticket_pack: {
                eligible: true,
                can_purchase: true,
                state: 'ready',
                ticket_count: 50,
                claim_ref: null
            },
            plan: { ticket_pack: { tickets: 50 } }
        })
    });

    const status = await client.getStatus({ force: true });

    assert.equal(status.ticket_pack.can_purchase, false);
    assert.equal(status.ticket_pack.state, 'claiming');
    assert.equal(status.ticket_pack.claim_ref, 'd'.repeat(64));
    client.destroy();
});

test('automatic preparation processes at most one accumulated batch per page activation', async () => {
    const pendingStore = new MemoryPendingStore();
    const auth = makeAuth();
    auth.hasKnownIdentity = () => true;
    const client = new BillingClient({
        authProvider: auth,
        pendingStore,
        fetchImpl: async url => {
            assert.ok(url.endsWith('/api/billing/status'));
            return response({ available_batches: 3, plan: { tickets_per_period: 300 } });
        }
    });
    let prepared = 0;
    client.prepareOneBatch = async () => {
        prepared += 1;
        return { ticketsAdded: 300 };
    };

    const first = await client.automaticallyPrepareOneBatch();
    const second = await client.automaticallyPrepareOneBatch();

    assert.equal(first.ticketsAdded, 300);
    assert.equal(second, null);
    assert.equal(prepared, 1);
    client.destroy();
});

test('ticket preparation fails closed when the next allowance is missing or exceeds 300', async () => {
    for (const [nextCount, expectedCode] of [
        [undefined, 'BILLING_ALLOWANCE_UNAVAILABLE'],
        [301, 'BILLING_ALLOWANCE_INVALID']
    ]) {
        const client = new BillingClient({
            authProvider: makeAuth(),
            pendingStore: new MemoryPendingStore(),
            lockManager: memoryLockManager(),
            ticketStore: {
                async init() {},
                getCount: () => 0,
                getTickets: () => []
            },
            fetchImpl: async url => {
                assert.ok(url.endsWith('/api/billing/status'));
                return response({
                    available_batches: 1,
                    next_claim_ticket_count: nextCount,
                    plan: { tickets_per_period: 300 }
                });
            }
        });

        await assert.rejects(
            () => client.prepareOneBatch(),
            error => error.code === expectedCode
        );
        client.destroy();
    }
});

test('browser ticket preparation fails closed when Web Locks are unavailable', async () => {
    const originalWindow = globalThis.window;
    globalThis.window = {};
    const client = new BillingClient({
        authProvider: makeAuth(),
        pendingStore: new MemoryPendingStore(),
        lockManager: {},
        ticketStore: { async init() {} },
        fetchImpl: async () => response({})
    });

    try {
        await assert.rejects(
            () => client.prepareOneBatch(),
            error => error.code === 'BILLING_BROWSER_LOCK_UNAVAILABLE'
        );
    } finally {
        client.destroy();
        globalThis.window = originalWindow;
    }
});

test('one prorated paid batch is blinded, signed, finalized, and imported without billing metadata', async () => {
    const targetCount = 147;
    const pendingStore = new MemoryPendingStore();
    const wallet = [];
    const claimBodies = [];
    let statusCalls = 0;
    const client = new BillingClient({
        baseUrl: 'http://127.0.0.1:8005',
        authProvider: makeAuth(),
        pendingStore,
        lockManager: memoryLockManager(),
        privacyPass: {
            async createSingleTokenRequest(_publicKey) {
                const index = this.count || 0;
                this.count = index + 1;
                return {
                    blindedRequest: `blind-${index}`,
                    serializedState: { protocol: 'test', index }
                };
            },
            async finalizeToken(signed, state) {
                return `final-${state.index}-${signed}`;
            }
        },
        ticketStore: {
            getCount: () => wallet.length,
            getTickets: () => wallet,
            async addTickets(tickets, options) {
                assert.equal(options.requireDurable, true);
                wallet.push(...tickets);
            }
        },
        fetchImpl: async (url, options = {}) => {
            if (url.endsWith('/api/billing/status')) {
                statusCalls += 1;
                return response({
                    premium_active: true,
                    subscription: { status: 'active' },
                    available_batches: statusCalls === 1 ? 1 : 0,
                    available_tickets: statusCalls === 1 ? targetCount : 0,
                    next_claim_ticket_count: statusCalls === 1 ? targetCount : null,
                    plan: { tickets_per_period: 300 }
                });
            }
            if (url.endsWith('/api/ticket/issue/public-key')) {
                return response({ public_key: 'issuer-public-key' });
            }
            if (url.endsWith('/api/billing/tickets/claim')) {
                claimBodies.push({ body: JSON.parse(options.body), headers: options.headers });
                return response({
                    tickets_issued: targetCount,
                    signed_responses: Array.from({ length: targetCount }, (_, index) => [index, `signed-${index}`])
                });
            }
            throw new Error(`Unexpected request: ${url}`);
        }
    });

    const result = await client.prepareOneBatch();

    assert.equal(result.ticketsAdded, targetCount);
    assert.equal(wallet.length, targetCount);
    assert.equal(claimBodies.length, 1);
    assert.deepEqual(Object.keys(claimBodies[0].body), ['blinded_requests']);
    assert.equal(claimBodies[0].body.blinded_requests.length, targetCount);
    assert.equal(claimBodies[0].headers['X-OA-Demo-Account-ID'], 'local-test-user-1234');
    for (const ticket of wallet) {
        assert.deepEqual(Object.keys(ticket).sort(), [
            'blinded_request', 'created_at', 'finalized_ticket', 'signed_response'
        ]);
    }
    assert.equal(await pendingStore.get('demo:local-test-user'), null);
    client.destroy();
});

test('a referenced 50-ticket top-up cannot be replaced by an older subscription allowance', async () => {
    const claimRef = 'c'.repeat(64);
    const pendingStore = new MemoryPendingStore();
    const wallet = [];
    const claimBodies = [];
    let statusCalls = 0;
    const client = new BillingClient({
        baseUrl: 'http://127.0.0.1:8005',
        authProvider: makeAuth(),
        pendingStore,
        lockManager: memoryLockManager(),
        privacyPass: {
            count: 0,
            async createSingleTokenRequest() {
                const index = this.count++;
                return {
                    blindedRequest: `topup-blind-${index}`,
                    serializedState: { index }
                };
            },
            async finalizeToken(signed, state) {
                return `topup-final-${state.index}-${signed}`;
            }
        },
        ticketStore: {
            getCount: () => wallet.length,
            getTickets: () => wallet,
            getArchiveTickets: () => [],
            async init() {},
            async addTickets(tickets, options) {
                assert.equal(options.requireDurable, true);
                wallet.push(...tickets);
            }
        },
        fetchImpl: async (url, options = {}) => {
            if (url.endsWith('/api/billing/status')) {
                statusCalls += 1;
                return response({
                    premium_active: true,
                    subscription: { status: 'active' },
                    available_batches: 1,
                    available_tickets: 300,
                    next_claim_ticket_count: 300,
                    ticket_pack: statusCalls === 1 ? {
                        eligible: true,
                        can_purchase: false,
                        state: 'claimable',
                        ticket_count: 50,
                        claim_ref: claimRef
                    } : {
                        eligible: true,
                        can_purchase: true,
                        state: 'ready',
                        ticket_count: 50,
                        claim_ref: null
                    },
                    plan: {
                        tickets_per_period: 300,
                        ticket_pack: { tickets: 50, unit_amount: 700, currency: 'usd' }
                    }
                });
            }
            if (url.endsWith('/api/ticket/issue/public-key')) {
                return response({ public_key: 'issuer-public-key' });
            }
            if (url.endsWith('/api/billing/tickets/claim')) {
                claimBodies.push(JSON.parse(options.body));
                return response({
                    tickets_issued: 50,
                    replayed: false,
                    signed_responses: Array.from(
                        { length: 50 },
                        (_, index) => [index, `topup-signed-${index}`]
                    )
                });
            }
            throw new Error(`Unexpected request: ${url}`);
        }
    });

    const result = await client.prepareOneBatch();

    assert.equal(result.ticketsAdded, 50);
    assert.equal(wallet.length, 50);
    assert.equal(claimBodies.length, 1);
    assert.equal(claimBodies[0].claim_ref, claimRef);
    assert.equal(claimBodies[0].blinded_requests.length, 50);
    for (const ticket of wallet) {
        assert.deepEqual(Object.keys(ticket).sort(), [
            'blinded_request', 'created_at', 'finalized_ticket', 'signed_response'
        ]);
    }
    assert.equal(await pendingStore.get('demo:local-test-user'), null);
    client.destroy();
});

test('a malformed top-up reference fails closed instead of claiming an older subscription allowance', async () => {
    let generated = 0;
    let claimCalled = false;
    const client = new BillingClient({
        authProvider: makeAuth(),
        pendingStore: new MemoryPendingStore(),
        lockManager: memoryLockManager(),
        privacyPass: {
            async createSingleTokenRequest() {
                generated += 1;
                throw new Error('must not generate');
            }
        },
        ticketStore: { async init() {} },
        fetchImpl: async url => {
            if (url.endsWith('/api/billing/status')) {
                return response({
                    available_batches: 1,
                    next_claim_ticket_count: 300,
                    ticket_pack: {
                        eligible: true,
                        can_purchase: false,
                        state: 'claimable',
                        ticket_count: 50,
                        claim_ref: 'malformed'
                    },
                    plan: {
                        tickets_per_period: 300,
                        ticket_pack: { tickets: 50, unit_amount: 700, currency: 'usd' }
                    }
                });
            }
            if (url.endsWith('/api/billing/tickets/claim')) claimCalled = true;
            throw new Error(`Unexpected request: ${url}`);
        }
    });

    await assert.rejects(
        () => client.prepareOneBatch(),
        error => error.code === 'BILLING_ALLOWANCE_INVALID'
    );
    assert.equal(generated, 0);
    assert.equal(claimCalled, false);
    client.destroy();
});

test('a refunded top-up clears unrecoverable local claim state after server rejection', async () => {
    const claimRef = 'e'.repeat(64);
    const pendingStore = new MemoryPendingStore();
    let claimCalls = 0;
    const client = new BillingClient({
        baseUrl: 'http://127.0.0.1:8005',
        authProvider: makeAuth(),
        pendingStore,
        lockManager: memoryLockManager(),
        privacyPass: {
            count: 0,
            async createSingleTokenRequest() {
                const index = this.count++;
                return { blindedRequest: `blind-${index}`, serializedState: { index } };
            }
        },
        ticketStore: {
            async init() {},
            getCount: () => 0,
            getTickets: () => []
        },
        fetchImpl: async (url) => {
            if (url.endsWith('/api/billing/status')) {
                return response({
                    available_batches: 0,
                    ticket_pack: {
                        eligible: true,
                        can_purchase: false,
                        state: 'claimable',
                        ticket_count: 50,
                        claim_ref: claimRef
                    },
                    plan: { tickets_per_period: 300, ticket_pack: { tickets: 50 } }
                });
            }
            if (url.endsWith('/api/ticket/issue/public-key')) {
                return response({ public_key: 'issuer-public-key' });
            }
            if (url.endsWith('/api/billing/tickets/claim')) {
                claimCalls += 1;
                return response({
                    detail: {
                        code: 'BILLING_NO_ENTITLEMENT',
                        error: 'No paid ticket batch is available'
                    }
                }, false, 409);
            }
            throw new Error(`Unexpected request: ${url}`);
        }
    });

    await assert.rejects(
        () => client.prepareOneBatch(),
        error => error.code === 'BILLING_NO_ENTITLEMENT'
    );

    assert.equal(claimCalls, 1);
    assert.equal(await pendingStore.get('demo:local-test-user'), null);
    assert.equal(client.progress, null);
    client.destroy();
});

test('server-provided finalized tickets fail closed before wallet import', async () => {
    const pendingStore = new MemoryPendingStore();
    let imported = false;
    const client = new BillingClient({
        baseUrl: 'http://127.0.0.1:8005',
        authProvider: makeAuth(),
        pendingStore,
        lockManager: memoryLockManager(),
        privacyPass: {
            count: 0,
            async createSingleTokenRequest() {
                const index = this.count++;
                return { blindedRequest: `blind-${index}`, serializedState: { index } };
            }
        },
        ticketStore: {
            getCount: () => 0,
            getTickets: () => [],
            async addTickets() { imported = true; }
        },
        fetchImpl: async (url) => {
            if (url.endsWith('/api/billing/status')) return response({ available_batches: 1, next_claim_ticket_count: 300, plan: { tickets_per_period: 300 } });
            if (url.endsWith('/api/ticket/issue/public-key')) return response({ public_key: 'issuer-public-key' });
            return response({ finalized_tickets: ['forbidden'], signed_responses: [] });
        }
    });

    await assert.rejects(
        () => client.prepareOneBatch(),
        error => error.code === 'BILLING_SERVER_FINALIZED_TICKETS'
    );
    assert.equal(imported, false);
    assert.equal((await pendingStore.get('demo:local-test-user')).generatedCount, 300);
    client.destroy();
});

test('unexpected server metadata fails closed before wallet import', async () => {
    const pendingStore = new MemoryPendingStore();
    let imported = false;
    const client = new BillingClient({
        baseUrl: 'http://127.0.0.1:8005',
        authProvider: makeAuth(),
        pendingStore,
        lockManager: memoryLockManager(),
        privacyPass: {
            count: 0,
            async createSingleTokenRequest() {
                const index = this.count++;
                return { blindedRequest: `blind-${index}`, serializedState: { index } };
            }
        },
        ticketStore: {
            getCount: () => 0,
            getTickets: () => [],
            async addTickets() { imported = true; }
        },
        fetchImpl: async url => {
            if (url.endsWith('/api/billing/status')) return response({ available_batches: 1, next_claim_ticket_count: 300, plan: { tickets_per_period: 300 } });
            if (url.endsWith('/api/ticket/issue/public-key')) return response({ public_key: 'issuer-public-key' });
            return response({
                account_id: 'forbidden-account-link',
                signed_responses: Array.from({ length: 300 }, (_, index) => [index, `signed-${index}`])
            });
        }
    });

    await assert.rejects(
        () => client.prepareOneBatch(),
        error => error.code === 'BILLING_UNEXPECTED_RESPONSE_METADATA'
    );
    assert.equal(imported, false);
    assert.equal((await pendingStore.get('demo:local-test-user')).generatedCount, 300);
    client.destroy();
});

test('account change aborts work but leaves account-scoped recovery state untouched', async () => {
    const pendingStore = new MemoryPendingStore();
    await pendingStore.put({ accountScope: 'demo:old-user', phase: 'generating', requests: [] });
    const client = new BillingClient({
        authProvider: makeAuth(),
        pendingStore,
        fetchImpl: async () => response({})
    });
    let aborted = false;
    client.activeController = { abort() { aborted = true; } };

    client.handleIdentityChange({ accountId: 'new-user' });

    assert.equal(aborted, true);
    assert.equal((await pendingStore.get('demo:old-user')).phase, 'generating');
    client.destroy();
});

test('reload resumes finalization from the saved chunk without regenerating requests', async () => {
    const pendingStore = new MemoryPendingStore();
    const requests = Array.from({ length: 300 }, (_, index) => ({
        index,
        blindedRequest: `blind-${index}`,
        serializedState: { index }
    }));
    const signedResponses = Array.from({ length: 300 }, (_, index) => [index, `signed-${index}`]);
    const finalizedTickets = Array.from({ length: 150 }, (_, index) => ({
        blinded_request: `blind-${index}`,
        signed_response: `signed-${index}`,
        finalized_ticket: `final-${index}`,
        created_at: '2026-01-01T00:00:00.000Z'
    }));
    await pendingStore.put({
        accountScope: 'demo:local-test-user',
        issuerFingerprint: 'saved-fingerprint',
        targetCount: 300,
        generatedCount: 300,
        requests,
        signedResponses,
        finalizedTickets,
        finalizedCount: 150,
        phase: 'finalizing',
        createdAt: '2026-01-01T00:00:00.000Z'
    });
    const wallet = [];
    let generated = 0;
    let finalized = 0;
    const client = new BillingClient({
        baseUrl: 'http://127.0.0.1:8005',
        authProvider: makeAuth(),
        pendingStore,
        lockManager: memoryLockManager(),
        privacyPass: {
            async createSingleTokenRequest() { generated += 1; throw new Error('must not regenerate'); },
            async finalizeToken(_signed, state) { finalized += 1; return `final-${state.index}`; }
        },
        ticketStore: {
            getCount: () => wallet.length,
            getTickets: () => wallet,
            async addTickets(tickets) { wallet.push(...tickets); }
        },
        fetchImpl: async url => {
            if (url.endsWith('/api/billing/status')) {
                return response({
                    available_batches: 0,
                    ticket_pack: {
                        eligible: true,
                        can_purchase: false,
                        state: 'claimable',
                        ticket_count: 50,
                        claim_ref: 'f'.repeat(64)
                    },
                    plan: {
                        tickets_per_period: 300,
                        ticket_pack: { tickets: 50, unit_amount: 700, currency: 'usd' }
                    }
                });
            }
            throw new Error(`Unexpected request during finalization resume: ${url}`);
        }
    });

    const result = await client.prepareOneBatch();

    assert.equal(generated, 0);
    assert.equal(finalized, 150);
    assert.equal(result.ticketsAdded, 300);
    assert.equal(wallet.length, 300);
    client.destroy();
});

test('wallet persistence failure keeps the completed local recovery record', async () => {
    const pendingStore = new MemoryPendingStore();
    const requests = Array.from({ length: 300 }, (_, index) => ({
        index,
        blindedRequest: `blind-${index}`,
        serializedState: { index }
    }));
    await pendingStore.put({
        accountScope: 'demo:local-test-user',
        issuerFingerprint: 'saved-fingerprint',
        targetCount: 300,
        generatedCount: 300,
        requests,
        signedResponses: Array.from({ length: 300 }, (_, index) => [index, `signed-${index}`]),
        finalizedTickets: Array.from({ length: 300 }, (_, index) => ({
            blinded_request: `blind-${index}`,
            signed_response: `signed-${index}`,
            finalized_ticket: `final-${index}`,
            created_at: '2026-01-01T00:00:00.000Z'
        })),
        finalizedCount: 300,
        phase: 'finalizing',
        createdAt: '2026-01-01T00:00:00.000Z'
    });
    const client = new BillingClient({
        authProvider: makeAuth(),
        pendingStore,
        lockManager: memoryLockManager(),
        ticketStore: {
            getCount: () => 0,
            getTickets: () => [],
            async addTickets(_tickets, options) {
                assert.equal(options.requireDurable, true);
                throw new Error('IndexedDB write failed');
            }
        },
        fetchImpl: async url => {
            if (url.endsWith('/api/billing/status')) return response({ available_batches: 0, plan: {} });
            throw new Error(`Unexpected request: ${url}`);
        }
    });

    await assert.rejects(() => client.prepareOneBatch(), /IndexedDB write failed/);
    const saved = await pendingStore.get('demo:local-test-user');
    assert.equal(saved.finalizedCount, 300);
    assert.equal(saved.finalizedTickets.length, 300);
    client.destroy();
});

test('recovery accepts already-imported tickets in active or archived wallet storage', async () => {
    const pendingStore = new MemoryPendingStore();
    const requests = Array.from({ length: 300 }, (_, index) => ({
        index, blindedRequest: `blind-${index}`, serializedState: { index }
    }));
    const finalizedTickets = Array.from({ length: 300 }, (_, index) => ({
        blinded_request: `blind-${index}`,
        signed_response: `signed-${index}`,
        finalized_ticket: `final-${index}`,
        created_at: '2026-01-01T00:00:00.000Z'
    }));
    await pendingStore.put({
        accountScope: 'demo:local-test-user',
        issuerFingerprint: 'saved-fingerprint',
        targetCount: 300,
        generatedCount: 300,
        requests,
        signedResponses: Array.from({ length: 300 }, (_, index) => [index, `signed-${index}`]),
        finalizedTickets,
        finalizedCount: 300,
        phase: 'imported',
        createdAt: '2026-01-01T00:00:00.000Z'
    });
    const active = finalizedTickets.slice(1);
    const archived = [{ ...finalizedTickets[0], consumed_at: '2026-01-01T00:01:00.000Z' }];
    const client = new BillingClient({
        authProvider: makeAuth(),
        pendingStore,
        lockManager: memoryLockManager(),
        ticketStore: {
            getCount: () => active.length,
            getTickets: () => active,
            getArchiveTickets: () => archived,
            async addTickets(_tickets, options) { assert.equal(options.requireDurable, true); }
        },
        fetchImpl: async url => {
            if (url.endsWith('/api/billing/status')) return response({ available_batches: 0, plan: {} });
            throw new Error(`Unexpected request: ${url}`);
        }
    });

    const result = await client.prepareOneBatch();

    assert.equal(result.totalActive, 299);
    assert.equal(await pendingStore.get('demo:local-test-user'), null);
    assert.equal(archived.length, 1);
    client.destroy();
});

test('one frozen billing identity is used across status and claim requests', async () => {
    const base = makeAuth();
    let resolveCalls = 0;
    const auth = {
        ...base,
        async resolve() {
            resolveCalls += 1;
            return base.resolve();
        }
    };
    const pendingStore = new MemoryPendingStore();
    const wallet = [];
    const client = new BillingClient({
        authProvider: auth,
        pendingStore,
        lockManager: memoryLockManager(),
        privacyPass: {
            count: 0,
            async createSingleTokenRequest() {
                const index = this.count++;
                return { blindedRequest: `blind-${index}`, serializedState: { index } };
            },
            async finalizeToken(_signed, state) { return `final-${state.index}`; }
        },
        ticketStore: {
            getCount: () => wallet.length,
            getTickets: () => wallet,
            async addTickets(tickets) { wallet.push(...tickets); }
        },
        fetchImpl: async url => {
            if (url.endsWith('/api/billing/status')) {
                return response({
                    available_batches: wallet.length ? 0 : 1,
                    next_claim_ticket_count: wallet.length ? null : 300,
                    plan: { tickets_per_period: 300 }
                });
            }
            if (url.endsWith('/api/ticket/issue/public-key')) return response({ public_key: 'key' });
            return response({
                signed_responses: Array.from({ length: 300 }, (_, index) => [index, `signed-${index}`])
            });
        }
    });

    await client.prepareOneBatch();

    assert.equal(resolveCalls, 1);
    client.destroy();
});

test('a scope-specific browser lock covers preparation and recovery re-read', async () => {
    const calls = [];
    const lockManager = {
        async request(name, options, callback) {
            calls.push({ name, mode: options.mode, phase: 'entered' });
            const value = await callback();
            calls.push({ name, phase: 'released' });
            return value;
        }
    };
    const pendingStore = new MemoryPendingStore();
    await pendingStore.put({
        accountScope: 'demo:local-test-user',
        targetCount: 299,
        requests: [],
        signedResponses: [],
        finalizedTickets: [],
        finalizedCount: 0,
        phase: 'invalid-test-stop'
    });
    const client = new BillingClient({
        authProvider: makeAuth(),
        pendingStore,
        lockManager,
        ticketStore: { async init() {} },
        fetchImpl: async url => {
            if (url.endsWith('/api/billing/status')) return response({ available_batches: 0, plan: {} });
            throw new Error('stop after proving the lock was acquired');
        }
    });

    await assert.rejects(() => client.prepareOneBatch());
    assert.equal(calls[0].mode, 'exclusive');
    assert.match(calls[0].name, /^oa-billing-claim-v1:[0-9a-f]{64}$/);
    client.destroy();
});
