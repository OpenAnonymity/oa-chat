import test from 'node:test';
import assert from 'node:assert/strict';
import BillingModal from '../../chat/components/BillingModal.js';
import AccountModal from '../../chat/components/AccountModal.js';

test('billing modal formats the server-provided amount and interval', () => {
    const modal = Object.create(BillingModal.prototype);
    const label = modal.formatPrice({ unit_amount: 3500, currency: 'usd', interval: 'month' });
    assert.match(label, /35/);
    assert.match(label, /month/);
});

test('billing modal source contains no hard-coded Premium dollar price', () => {
    const source = `${BillingModal.prototype.render}\n${BillingModal.prototype.formatPrice}`;
    assert.equal(source.includes('$35'), false);
});

test('billing modal describes 300-ticket full periods without exposing server allowance counters', () => {
    const source = String(BillingModal.prototype.render);
    assert.match(source, /privacy-preserving tickets per full monthly period/);
    assert.match(source, /first payment and ticket allowance are prorated/);
    assert.equal(source.includes('Current paid allowance'), false);
    assert.equal(source.includes('Paid batches ready'), false);
    assert.equal(source.includes('500'), false);
});

test('billing modal maps failures to privacy-safe copy instead of displaying raw server errors', () => {
    const modal = Object.create(BillingModal.prototype);
    assert.equal(
        modal.safeErrorMessage({ code: 'BILLING_AUTH_REQUIRED', message: 'server secret' }, 'fallback'),
        'Sign in to your OA account to continue.'
    );
    assert.equal(
        modal.safeErrorMessage({ code: 'UNKNOWN', message: 'server secret' }, 'fallback'),
        'fallback'
    );
});

function renderBilling(snapshot) {
    const modal = Object.create(BillingModal.prototype);
    modal.isOpen = true;
    modal.overlay = {
        innerHTML: '',
        querySelector() { return null; }
    };
    modal.snapshot = snapshot;
    modal.busy = null;
    modal.error = null;
    modal.escape = value => String(value ?? '');
    modal.render();
    return modal.overlay.innerHTML;
}

test('ticket-pack UI renders server-provided $7 and 50-ticket values only for eligible subscribers', () => {
    const plan = {
        unit_amount: 3500,
        currency: 'usd',
        interval: 'month',
        tickets_per_period: 300,
        ticket_pack: { unit_amount: 700, currency: 'usd', tickets: 50 }
    };
    const eligible = renderBilling({
        plan,
        status: {
            premium_active: true,
            subscription: { status: 'active', cancel_at_period_end: true },
            available_batches: 0,
            ticket_pack: { eligible: true, can_purchase: true, state: 'ready', ticket_count: 50 }
        }
    });
    assert.match(eligible, /Buy 50 tickets/);
    assert.match(eligible, /\$7/);
    assert.match(eligible, /billing-topup-btn/);

    const ineligible = renderBilling({
        plan,
        status: {
            premium_active: false,
            subscription: { status: 'none' },
            ticket_pack: { eligible: false, can_purchase: false, state: 'ineligible', ticket_count: 50 }
        }
    });
    assert.equal(ineligible.includes('Buy 50 tickets'), false);

    const unavailable = renderBilling({
        plan: { ...plan, ticket_pack: null },
        status: {
            premium_active: true,
            subscription: { status: 'trialing' },
            ticket_pack: { eligible: true, can_purchase: true, state: 'ready', ticket_count: 50 }
        }
    });
    assert.equal(unavailable.includes('Buy 50 tickets'), false);
});

test('pending or claimable ticket packs replace the purchase control', () => {
    const plan = {
        unit_amount: 3500,
        currency: 'usd',
        interval: 'month',
        tickets_per_period: 300,
        ticket_pack: { unit_amount: 700, currency: 'usd', tickets: 50 }
    };
    const status = state => ({
        premium_active: true,
        subscription: { status: 'active' },
        ticket_pack: {
            eligible: true,
            can_purchase: false,
            state,
            ticket_count: 50
        }
    });

    const checkoutPending = renderBilling({ plan, status: status('checkout_pending') });
    assert.match(checkoutPending, /id="billing-topup-btn"/);
    assert.match(checkoutPending, /Continue ticket-pack Checkout/);
    assert.match(checkoutPending, /waiting for payment or confirmation/);

    const claimable = renderBilling({ plan, status: status('claimable') });
    assert.equal(claimable.includes('id="billing-topup-btn"'), false);
    assert.match(claimable, /billing-topup-prepare-btn/);
});

test('adaptive sidebar label follows account presence without requiring a paid subscription', () => {
    const attributes = new Map();
    const label = { textContent: '' };
    const tabButton = {
        dataset: {},
        title: '',
        setAttribute(name, value) { attributes.set(name, value); },
        querySelector(selector) { return selector === '[data-account-nav-label]' ? label : null; }
    };
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById(id) { return id === 'account-tab-btn' ? tabButton : null; }
    };
    const modal = Object.create(AccountModal.prototype);

    try {
        modal.accountState = {};
        modal.updateTabIndicator();
        assert.equal(label.textContent, 'Upgrade');
        assert.equal(attributes.get('aria-controls'), 'billing-modal');

        modal.accountState = { accountId: 'alpha', sessionVerified: false };
        modal.updateTabIndicator();
        assert.equal(label.textContent, 'Account');
        assert.equal(attributes.get('aria-controls'), 'account-modal');

        modal.accountState = { accountId: 'alpha', sessionVerified: true };
        modal.updateTabIndicator();
        assert.equal(label.textContent, 'Account');
        assert.equal(tabButton.dataset.status, 'logged-in');
    } finally {
        globalThis.document = originalDocument;
    }
});

test('account view exposes upgrade and billing-management actions', () => {
    const source = String(AccountModal.prototype.renderAccountUI);
    assert.match(source, /Upgrade to Premium/);
    assert.match(source, /Manage billing/);
});

test('signed-out Checkout records one intent and opens Account', async () => {
    const modal = Object.create(BillingModal.prototype);
    let remembered = 0;
    let closed = 0;
    let accountOpened = 0;
    modal.billing = {
        checkout: async () => {
            const error = new Error('auth required');
            error.code = 'BILLING_AUTH_REQUIRED';
            throw error;
        }
    };
    modal.app = { accountModal: { open: () => { accountOpened += 1; } } };
    modal.render = () => {};
    modal.rememberCheckoutIntent = () => { remembered += 1; };
    modal.close = () => { closed += 1; };

    await modal.checkout();

    assert.equal(remembered, 1);
    assert.equal(closed, 1);
    assert.equal(accountOpened, 1);
});

test('verified account consumes Checkout intent and resumes exactly once', async () => {
    const modal = Object.create(BillingModal.prototype);
    let hasIntent = true;
    let cleared = 0;
    let opened = 0;
    let checkouts = 0;
    modal.account = { getState: () => ({ accountId: 'alpha', sessionVerified: true }) };
    modal.hasCheckoutIntent = () => hasIntent;
    modal.clearCheckoutIntent = () => { hasIntent = false; cleared += 1; };
    modal.open = () => { opened += 1; };
    modal.checkout = async () => { checkouts += 1; };

    assert.equal(modal.resumeCheckoutIntent(), true);
    assert.equal(modal.resumeCheckoutIntent(), false);
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(cleared, 1);
    assert.equal(opened, 1);
    assert.equal(checkouts, 1);
});

test('cancelling a Checkout intent consumes it before returning to Premium', () => {
    const modal = Object.create(BillingModal.prototype);
    let hasIntent = true;
    let opened = 0;
    modal.hasCheckoutIntent = () => hasIntent;
    modal.clearCheckoutIntent = () => { hasIntent = false; };
    modal.open = () => { opened += 1; };

    assert.equal(modal.cancelCheckoutIntent(), true);
    assert.equal(modal.cancelCheckoutIntent(), false);
    assert.equal(hasIntent, false);
    assert.equal(opened, 1);
});

test('cancelling account authentication clears intent and returns to Premium', async () => {
    const modal = Object.create(AccountModal.prototype);
    let cancelled = 0;
    let resumed = 0;
    modal.app = {
        billingModal: {
            hasCheckoutIntent: () => true,
            cancelCheckoutIntent: ({ reopenPremium }) => {
                assert.equal(reopenPremium, true);
                cancelled += 1;
            },
            resumeCheckoutIntent: () => { resumed += 1; }
        }
    };
    modal.isOpen = true;
    modal.overlay = { classList: { add() {} }, innerHTML: 'account' };
    modal.clearAnimationTimeouts = () => {};
    modal.returnFocusEl = null;
    modal.escapeHandler = null;
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById: () => null, removeEventListener() {} };

    try {
        modal.close();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(cancelled, 1);
        assert.equal(resumed, 0);
    } finally {
        globalThis.document = originalDocument;
    }
});

test('successful account authentication requests automatic Checkout resumption', () => {
    const modal = Object.create(AccountModal.prototype);
    let closeOptions = null;
    modal.app = { billingModal: { hasCheckoutIntent: () => true } };
    modal.close = options => { closeOptions = options; };

    assert.equal(modal.resumePremiumCheckoutIfPending(), true);
    assert.deepEqual(closeOptions, { billingHandoff: 'resume' });
});

test('successful passkey sign-in automatically resumes a pending Premium Checkout', async () => {
    const modal = Object.create(AccountModal.prototype);
    let resumed = 0;
    modal.accountState = {};
    modal.accountInputValue = '1234 5678 9012 3456';
    modal.accountService = { unlockWithPasskey: async () => true };
    modal.resumePremiumCheckoutIfPending = () => { resumed += 1; return true; };
    modal.app = { showToast() {} };

    await modal.handleAccountPasskeyUnlock();
    assert.equal(resumed, 1);
});

test('completed account creation automatically resumes a pending Premium Checkout', async () => {
    const modal = Object.create(AccountModal.prototype);
    let resumed = 0;
    modal.creationStep = 'recovery';
    modal.accountService = { completeAccountRegistration: async () => {} };
    modal.render = () => {};
    modal.resumePremiumCheckoutIfPending = () => { resumed += 1; return true; };
    modal.app = { showToast() {} };

    await modal.handleConfirmRecoverySaved();
    assert.equal(modal.creationStep, 'complete');
    assert.equal(resumed, 1);
});

test('account authentication explains the Premium continuation', () => {
    const source = String(AccountModal.prototype.renderAccountUI);
    assert.match(source, /Continue to OA Premium/);
    assert.match(source, /continue securely to Stripe Checkout/);
    assert.match(source, /Create account and continue/);
});
