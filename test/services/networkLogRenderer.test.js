import test from 'node:test';
import assert from 'node:assert/strict';

import { getActivityDescription } from '../../chat/services/networkLogRenderer.js';

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
