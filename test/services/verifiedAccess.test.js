import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildExplicitlyVerifiedOpenRouterSharePayload,
    clearUnsafeOpenRouterCouncilAccess,
    clearUnverifiedOpenRouterAccess,
    hasExplicitVerifierApproval,
    hasExplicitVerifierApprovalForAccessInfo,
    hasUsableVerifierApproval,
    LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS
} from '../../chat/services/inference/verifiedAccess.js';

test('only an explicit verified proof approves a persisted OpenRouter key', () => {
    assert.equal(hasExplicitVerifierApproval({
        apiKeyInfo: { verifierSubmitKeyProof: { status: 'verified' } }
    }), true);
    assert.equal(hasExplicitVerifierApproval({
        apiKeyInfo: { verifierSubmitKeyProof: { status: 'pending' } }
    }), false);
    assert.equal(hasExplicitVerifierApproval({
        apiKeyInfo: { verifierSubmitKeyProof: { status: 'unverified' } }
    }), false);
    assert.equal(hasExplicitVerifierApproval({ apiKeyInfo: {} }), false);
    assert.equal(hasExplicitVerifierApprovalForAccessInfo({
        verifierSubmitKeyProof: { status: 'verified' }
    }), true);
    assert.equal(hasExplicitVerifierApprovalForAccessInfo({
        verifierSubmitKeyProof: { status: 'pending' }
    }), false);
});

test('loopback bypass proofs are usable only under an explicit local policy', () => {
    const session = {
        apiKeyInfo: {
            verifierSubmitKeyProof: { status: LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS }
        }
    };

    assert.equal(hasExplicitVerifierApproval(session), false);
    assert.equal(hasExplicitVerifierApprovalForAccessInfo(session.apiKeyInfo), false);
    assert.equal(hasUsableVerifierApproval(session), false);
    assert.equal(hasUsableVerifierApproval(session, { allowLocalBypass: true }), true);
});

test('the OpenRouter share boundary excludes local bypass access', () => {
    const bypassedAccess = {
        key: 'local-child-secret',
        stationId: 'local-station',
        verifierSubmitKeyProof: { status: LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS }
    };
    const verifiedAccess = {
        ...bypassedAccess,
        verifierSubmitKeyProof: { status: 'verified' }
    };

    assert.equal(buildExplicitlyVerifiedOpenRouterSharePayload(bypassedAccess), null);
    assert.equal(
        buildExplicitlyVerifiedOpenRouterSharePayload(verifiedAccess)?.token,
        'local-child-secret'
    );
});

test('persisted loopback-bypass keys are retained locally and removed elsewhere', () => {
    const buildSession = () => ({
        inferenceBackend: 'openrouter',
        apiKey: 'local-child',
        apiKeyInfo: {
            verifierSubmitKeyProof: { status: LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS }
        },
        expiresAt: '2026-08-05T00:00:00.000Z'
    });
    const localSession = buildSession();
    const nonLocalSession = buildSession();

    assert.equal(clearUnverifiedOpenRouterAccess(localSession, {
        allowLocalBypass: true,
        now: () => Date.parse('2026-08-04T00:00:00.000Z')
    }), false);
    assert.equal(localSession.apiKey, 'local-child');

    assert.equal(clearUnverifiedOpenRouterAccess(nonLocalSession, {
        allowLocalBypass: false,
        now: () => Date.parse('2026-08-04T00:00:00.000Z')
    }), true);
    assert.equal(nonLocalSession.apiKey, null);
});

test('persisted Council bypass keys and raw mappings are removed outside loopback', () => {
    const session = {
        inferenceBackend: 'openrouter',
        councilAccess: {
            primary: {
                apiKey: 'local-lane-child',
                apiKeyInfo: {
                    verifierSubmitKeyProof: { status: LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS }
                },
                expiresAt: '2026-08-05T00:00:00.000Z'
            }
        },
        ephemeralKeyMappings: {
            'local-lane-id': { underlyingKeyId: 'local-lane-child' }
        }
    };

    assert.equal(clearUnsafeOpenRouterCouncilAccess(session, {
        allowLocalBypass: false,
        now: () => Date.parse('2026-08-04T00:00:00.000Z')
    }), true);
    assert.equal(session.councilAccess, undefined);
    assert.equal(session.ephemeralKeyMappings, undefined);
});

test('unsafe Council lane keys and their raw mappings are removed on persisted-access audit', () => {
    const now = Date.parse('2026-08-02T00:00:00.000Z');
    const session = {
        inferenceBackend: 'openrouter',
        councilAccess: {
            primary: {
                apiKey: 'safe-primary',
                apiKeyInfo: {
                    stationId: 'station-safe',
                    verifierSubmitKeyProof: { status: 'verified' }
                },
                expiresAt: '2026-08-03T00:00:00.000Z'
            },
            secondary: {
                apiKey: 'unverified-secondary',
                apiKeyInfo: { verifierSubmitKeyProof: { status: 'pending' } },
                expiresAt: '2026-08-03T00:00:00.000Z'
            },
            synthesis: {
                apiKey: 'banned-synthesis',
                apiKeyInfo: {
                    stationId: 'station-banned',
                    verifierSubmitKeyProof: { status: 'verified' }
                },
                expiresAt: '2026-08-03T00:00:00.000Z'
            },
            expired: {
                apiKey: 'expired-key',
                apiKeyInfo: { verifierSubmitKeyProof: { status: 'verified' } },
                expiresAt: '2026-08-01T00:00:00.000Z'
            }
        },
        ephemeralKeyMappings: {
            safe: { underlyingKeyId: 'safe-primary' },
            unverified: { underlyingKeyId: 'unverified-secondary' },
            banned: { underlyingKeyId: 'banned-synthesis' },
            expired: { underlyingKeyId: 'expired-key' }
        }
    };

    assert.equal(clearUnsafeOpenRouterCouncilAccess(session, {
        now: () => now,
        isBanned: (accessInfo) => accessInfo?.stationId === 'station-banned'
    }), true);
    assert.deepEqual(Object.keys(session.councilAccess), ['primary']);
    assert.deepEqual(Object.keys(session.ephemeralKeyMappings), ['safe']);
});

test('persisted unverified OpenRouter keys and matching raw-key mappings are removed', () => {
    const session = {
        inferenceBackend: 'openrouter',
        apiKey: 'child-secret',
        apiKeyInfo: {
            verifierSubmitKeyProof: { status: 'pending' }
        },
        expiresAt: '2026-08-01T00:00:00.000Z',
        currentEphemeralKeyId: 'mapping-a',
        ephemeralKeyMappings: {
            'mapping-a': {
                underlyingKeyId: 'child-secret',
                backendId: 'openrouter'
            }
        }
    };

    assert.equal(clearUnverifiedOpenRouterAccess(session), true);
    assert.equal(session.apiKey, null);
    assert.equal(session.apiKeyInfo, null);
    assert.equal(session.expiresAt, null);
    assert.equal(session.currentEphemeralKeyId, null);
    assert.equal('ephemeralKeyMappings' in session, false);
});

test('verified OpenRouter keys and non-OpenRouter credentials are preserved', () => {
    const verified = {
        inferenceBackend: 'openrouter',
        apiKey: 'verified-child',
        apiKeyInfo: {
            verifierSubmitKeyProof: { status: 'verified' }
        }
    };
    const providerDirect = {
        inferenceBackend: 'provider-direct',
        apiKey: 'user-key'
    };

    assert.equal(clearUnverifiedOpenRouterAccess(verified), false);
    assert.equal(verified.apiKey, 'verified-child');
    assert.equal(clearUnverifiedOpenRouterAccess(providerDirect), false);
    assert.equal(providerDirect.apiKey, 'user-key');
});
