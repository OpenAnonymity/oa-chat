import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

test('public chat source does not contain the private billing implementation', () => {
    const forbidden = [
        'chat/components/BillingModal.js',
        'chat/services/billingClient.js',
        'chat/services/billingPendingStore.js',
        'chat/services/billingState.js'
    ];
    forbidden.forEach(relative => assert.equal(fs.existsSync(path.join(root, relative)), false));

    const entry = fs.readFileSync(path.join(root, 'chat/standalone.js'), 'utf8');
    assert.match(entry, /createChatApp\(\)/);
    assert.doesNotMatch(entry, /extensions\s*:/);
});

test('public API exports the app entry and versioned extension names only', () => {
    const source = fs.readFileSync(path.join(root, 'chat/publicApi.js'), 'utf8');
    assert.match(source, /createChatApp/);
    assert.match(source, /EXTENSION_API_VERSION/);
    assert.match(source, /SLOT_NAMES/);
    assert.doesNotMatch(source, /Billing|Stripe|Checkout/);
});
