import test from 'node:test';
import assert from 'node:assert/strict';
import { renderVerifierAvailability } from '../../chat/components/verifierAvailability.js';
import { getActivityDescription, getStatusDotClass } from '../../chat/services/networkLogRenderer.js';

test('persistent warning uses text as well as an orange dot and never promises recovery', () => {
    const html = renderVerifierAvailability({ verifierSubmitKeyProof: { status: 'verifier-unavailable' } });
    assert.match(html, /role="status"/);
    assert.match(html, /verifier-availability-dot/);
    assert.match(html, /verification is retried/);
    assert.doesNotMatch(html, /shortly|verified successfully/);
    assert.equal(renderVerifierAvailability({ verifierSubmitKeyProof: { status: 'verified' } }), '');
    assert.equal(renderVerifierAvailability(null), '');
});

test('outage timeline uses warning color and distinguishes delivery from verification', () => {
    const log = { type: 'verification', url: 'https://verifier.example/submit_key', status: 'verifier-unavailable', detail: 'verifier-unavailable' };
    assert.equal(getStatusDotClass(log.status), 'bg-amber-500');
    assert.match(getActivityDescription(log), /chat continues/);
    assert.match(getActivityDescription(log, true), /unverified key/);
    assert.doesNotMatch(getActivityDescription(log, true), /<a|key is rejected/);
});

test('recent attestation and exhausted retries have distinct truthful messages', () => {
    const info = { recentlyAttested: true, verifierSubmitKeyProof: { status: 'verifier-unavailable', detail: 'recently_attested_outage' } };
    assert.match(renderVerifierAvailability(info), /because this station was recently attested/);
    info.verifierSubmitKeyProof.detail = 'verification_retry_exhausted';
    const html = renderVerifierAvailability(info);
    assert.match(html, /Verification retries stopped/);
    assert.doesNotMatch(html, /will retry|is retried/);
});
