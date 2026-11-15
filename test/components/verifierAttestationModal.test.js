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

test('late payment attestation cannot overwrite a reopened ticket dialog', async () => {
    const modal = new VerifierAttestationModal();
    let finishPayment;
    const payment = { getAttestation: () => new Promise(resolve => { finishPayment = resolve; }) };
    const ticket = { getAttestation: async () => ({ origin: 'ticket' }) };
    modal.configureServices({ verifier: ticket });
    modal.render = modal.setupEventListeners = () => {};
    modal.verifyAttestation = async value => value;
    modal.collectZeroTrustEvidence = async ({ verifier }) => ({ origin: verifier === payment ? 'payment' : 'ticket' });
    modal.context = { verifier: payment };
    const previous = modal.fetchAndVerifyAttestation();
    // close() invalidates the load; model the next open with its own context.
    modal.isOpen = true;
    modal.close();
    modal.isOpen = true;
    modal.context = { verifier: ticket };
    await modal.fetchAndVerifyAttestation();
    finishPayment({ origin: 'payment' });
    await previous;
    assert.equal(modal.attestation.origin, 'ticket');
    assert.equal(modal.verification.origin, 'ticket');
    assert.equal(modal.zeroTrustEvidence.origin, 'ticket');
    assert.equal(modal.verifier, ticket);
});

test('attestation evidence cannot reuse submit-key logs from another verifier', () => {
    const modal = new VerifierAttestationModal();
    modal.configureServices({ verifier: { verifierUrl: 'https://ticket.example' }, networkLogger: {
        getAllLogs: () => [{ type: 'verification', url: 'https://ticket.example/submit_key',
            status: 200, request: { station_id: 'same-id' }, response: { status: 'verified', key_hash: '1234' } }]
    } });
    modal.context = { verifier: { verifierUrl: 'https://payment.example' } };
    const evidence = modal.extractSubmitKeyOwnershipEvidence({ stationId: 'same-id' }, { apiKeyHashPrefix16: '1234' });
    assert.equal(evidence.found, false);
    assert.equal(evidence.ownership_passed, false);
});
