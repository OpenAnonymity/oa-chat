import test from 'node:test';
import assert from 'node:assert/strict';

import { getActivityDescription, getActivityIcon } from '../../chat/services/networkLogRenderer.js';

function pendingVerification(detail = '') {
    return getActivityDescription({
        type: 'verification',
        url: 'https://verifier2.openanonymity.ai/submit_key',
        method: 'POST',
        status: 'pending',
        detail,
        response: {}
    }, true);
}

test('pending verifier activity describes fail-closed key handling', () => {
    for (const detail of ['', 'ownership_check_error', 'rate_limited']) {
        const description = pendingVerification(detail);
        assert.match(description, /stayed inactive and was discarded/);
        assert.match(description, /later send can request and verify a new key/i);
        assert.doesNotMatch(description, /continue sending|automatically retry/i);
    }
});


test('verifier shields show success checks only for completed successful verification', () => {
    const url = 'https://verifier2.openanonymity.ai/submit_key';
    assert.match(getActivityIcon({ url, type: 'verification', status: 200 }), /t-success-check/);
    for (const status of ['pending', 0, 400, 503]) {
        const icon = getActivityIcon({ url, type: 'verification', status });
        assert.match(icon, /verifier-status-icon/);
        assert.doesNotMatch(icon, /t-success-check/);
    }
    assert.doesNotMatch(getActivityIcon({ url, type: 'verification', status: 200, isAborted: true }), /t-success-check/);
    for (const detail of ['key_near_expiry', 'verifier_unreachable_uncertified', 'ownership_check_error', 'rate_limited', 'other_failure']) {
        const icon = getActivityIcon({ url, type: 'verification', status: 200, detail });
        assert.match(icon, /text-amber-600/);
        assert.doesNotMatch(icon, /t-success-check/);
    }
    for (const detail of ['invalid_verifier_response', 'verifier_approval_binding_mismatch']) {
        const icon = getActivityIcon({ url, type: 'verification', status: 200, detail });
        assert.match(icon, /text-red-600/);
        assert.doesNotMatch(icon, /t-success-check/);
    }
    assert.doesNotMatch(getActivityIcon({ url, type: 'verification', status: 200, response: { status: 'rejected' } }), /t-success-check/);
});
