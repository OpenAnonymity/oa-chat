import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_PRODUCTION_ORG_ORIGIN,
    DEFAULT_PRODUCTION_WEBAUTHN_RELAY_URL,
    normalizePublicOrigin,
    normalizeWebAuthnRelayUrl,
    resolveBuildOrgOrigin,
    resolveBuildWebAuthnRelayUrl
} from '../../scripts/buildConfig.mjs';

test('oa-org build origin accepts exact HTTPS origins and loopback HTTP', () => {
    assert.equal(
        normalizePublicOrigin('https://org.staging.openanonymity.ai/'),
        'https://org.staging.openanonymity.ai'
    );
    assert.equal(normalizePublicOrigin('http://localhost:8005'), 'http://localhost:8005');
    assert.equal(resolveBuildOrgOrigin({}), null);
    assert.equal(DEFAULT_PRODUCTION_ORG_ORIGIN, 'https://org.openanonymity.ai');
});

test('WebAuthn relay build setting accepts one exact HTTPS page', () => {
    assert.equal(
        normalizeWebAuthnRelayUrl('https://oa-staging-main.vercel.app/passkey-relay.html'),
        'https://oa-staging-main.vercel.app/passkey-relay.html'
    );
    assert.equal(
        resolveBuildWebAuthnRelayUrl({}),
        DEFAULT_PRODUCTION_WEBAUTHN_RELAY_URL
    );
});

test('WebAuthn relay build setting rejects insecure or ambiguous destinations', () => {
    for (const value of [
        'http://oa-staging-main.vercel.app/passkey-relay.html',
        'https://user@example.com/passkey-relay.html',
        'https://oa-staging-main.vercel.app/',
        'https://oa-staging-main.vercel.app/passkey-relay.html?next=elsewhere',
        'https://oa-staging-main.vercel.app/passkey-relay.html#fragment',
        'not a URL'
    ]) {
        assert.throws(() => normalizeWebAuthnRelayUrl(value), /OA_WEBAUTHN_RELAY_URL/);
    }
});

test('oa-org build origin rejects paths, credentials, and insecure remote origins', () => {
    for (const value of [
        'https://user@example.com',
        'https://org.example.com/path',
        'https://org.example.com?mode=staging',
        'http://org.example.com',
        'not a URL'
    ]) {
        assert.throws(() => normalizePublicOrigin(value), /OA_ORG_ORIGIN/);
    }
});
