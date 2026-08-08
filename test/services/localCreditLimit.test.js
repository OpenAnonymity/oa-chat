import test from 'node:test';
import assert from 'node:assert/strict';

import { getLocalCreditLimitedMaxOutputTokens } from '../../chat/services/inference/localCreditLimit.js';

test('bounds output for a verified $0.05 OA child key', () => {
    assert.equal(getLocalCreditLimitedMaxOutputTokens({
        apiKeyInfo: {
            creditLimit: 0.05,
            verifierSubmitKeyProof: { status: 'verified' }
        }
    }), 512);
});

test('does not bound unverified or higher-credit requests', () => {
    assert.equal(getLocalCreditLimitedMaxOutputTokens({
        apiKeyInfo: {
            creditLimit: 0.05,
            verifierSubmitKeyProof: { status: 'unverified' }
        }
    }), undefined);
    assert.equal(getLocalCreditLimitedMaxOutputTokens({
        apiKeyInfo: {
            creditLimit: 1,
            verifierSubmitKeyProof: { status: 'verified' }
        }
    }), undefined);
});

test('does not trust a verified-looking detail without verified status', () => {
    assert.equal(getLocalCreditLimitedMaxOutputTokens({
        apiKeyInfo: {
            creditLimit: 0.05,
            verifierSubmitKeyProof: { detail: 'verified' }
        }
    }), undefined);
});
