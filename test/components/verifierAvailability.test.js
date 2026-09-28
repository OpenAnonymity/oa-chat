import test from 'node:test';
import assert from 'node:assert/strict';
import { getActivityDescription, getActivityIcon, getStatusDotClass } from '../../chat/services/networkLogRenderer.js';

test('outage timeline uses warning color and distinguishes delivery from verification', () => {
    const log = { type: 'verification', url: 'https://verifier.example/submit_key', status: 'verifier-unavailable', detail: 'verifier-unavailable' };
    assert.equal(getStatusDotClass(log.status), 'bg-amber-500');
    assert.equal(getActivityDescription(log), 'Verification not available');
    assert.match(getActivityDescription(log, true), /unverified key/);
    assert.doesNotMatch(getActivityDescription(log, true), /<a|key is rejected/);
    for (const warning of [log, { ...log, detail: undefined }, { ...log, status: 200 }]) {
        const icon = getActivityIcon(warning);
        assert.match(icon, /verifier-status-icon text-muted-foreground/);
        assert.match(icon, /<svg[^>]*>[\s\S]*<circle class="verifier-status-dot"[^>]*fill="#f59e0b"[^>]*\/><\/svg>/);
        assert.doesNotMatch(icon, /t-success-check/);
    }
    for (const state of [
        { ...log, status: 200, detail: undefined },
        { ...log, status: 'pending', detail: undefined },
        { ...log, status: 403, detail: 'invalid_verifier_response' },
        { ...log, isAborted: true }
    ]) {
        assert.doesNotMatch(getActivityIcon(state), /verifier-status-dot/);
    }
});
