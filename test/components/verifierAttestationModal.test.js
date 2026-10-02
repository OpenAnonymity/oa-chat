import test from 'node:test';
import assert from 'node:assert/strict';

import { VerifierAttestationModal } from '../../chat/components/VerifierAttestationModal.js';

test('local verifier bypass is presented as development-only and never verified', () => {
    const modal = new VerifierAttestationModal();
    const presentation = modal.getZeroTrustPresentation({
        submitKeyProof: { status: 'local-loopback-bypass' }
    });

    assert.equal(presentation.localLoopbackBypass, true);
    assert.equal(presentation.summaryTone, 'warn');
    assert.equal(presentation.summaryTitle, 'Local verifier bypass active');
    assert.match(presentation.summaryBody, /without production verifier approval/i);
    assert.match(presentation.summaryBody, /not marked verified/i);
    assert.doesNotMatch(presentation.summaryTitle, /chain verified/i);
});

test('verified access retains the normal attestation presentation', () => {
    const modal = new VerifierAttestationModal();
    const presentation = modal.getZeroTrustPresentation({
        submitKeyProof: { status: 'verified' }
    });

    assert.equal(presentation.localLoopbackBypass, false);
    assert.equal(presentation.summaryTone, 'success');
    assert.equal(presentation.summaryTitle, 'Key issuance verification');
});

test('an outage key never gets a verified-chain summary even when broadcast is healthy', () => {
    const presentation = new VerifierAttestationModal().getZeroTrustPresentation({
        submitKeyProof: { status: 'verifier-unavailable' }, stationVerifiedInBroadcast: true
    });
    assert.equal(presentation.summaryTone, 'warn');
    assert.equal(presentation.summaryTitle, 'Key not verified');
    assert.match(presentation.summaryBody, /have not been verified/);
});

test('payment modal uses its verifier context and returns to the ticket verifier afterward', async () => {
    const modal = new VerifierAttestationModal();
    const requests = [];
    const ticket = { verifierUrl: 'https://verifier2.openanonymity.ai', getAttestation: async () => { requests.push('tickets'); return {}; } };
    const payment = { verifierUrl: 'https://verifier-production-20260917.openanonymity.ai', getAttestation: async () => { requests.push('payments'); return {}; } };
    modal.configureServices({ verifier: ticket });
    modal.render = modal.setupEventListeners = () => {};
    modal.verifyAttestation = modal.collectZeroTrustEvidence = async () => ({});
    modal.context = { verifier: payment };
    await modal.fetchAndVerifyAttestation();
    assert.equal(modal.verifier, payment);
    assert.equal(modal.services.verifier, ticket, 'ticket services are never replaced');
    modal.context = null;
    await modal.fetchAndVerifyAttestation();
    assert.deepEqual(requests, ['payments', 'tickets']);
});
