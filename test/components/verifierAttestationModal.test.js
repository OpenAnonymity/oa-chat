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
    assert.equal(presentation.summaryTitle, 'Key issuance chain verified');
});
