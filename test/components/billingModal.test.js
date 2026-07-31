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
