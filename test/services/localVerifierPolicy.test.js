import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getVerifierBypassDetail,
    isExplicitLoopbackHostname,
    isLocalVerifierBypassAllowed
} from '../../chat/services/inference/localVerifierPolicy.js';

function locationLike(hostname, protocol = 'http:') {
    const host = hostname.includes(':') && !hostname.startsWith('[')
        ? `[${hostname}]`
        : hostname;
    return { hostname, protocol, origin: `${protocol}//${host}` };
}

test('local verifier bypass requires explicit loopback browser and org hosts', () => {
    assert.equal(isLocalVerifierBypassAllowed({
        locationLike: locationLike('127.0.0.1'),
        orgApiBase: 'http://localhost:8005'
    }), true);
    assert.equal(isLocalVerifierBypassAllowed({
        locationLike: locationLike('localhost'),
        orgApiBase: 'http://127.0.0.1:8005'
    }), true);
    assert.equal(isLocalVerifierBypassAllowed({
        locationLike: locationLike('::1'),
        orgApiBase: 'http://[::1]:8005'
    }), true);
});

test('local verifier bypass rejects non-loopback and lookalike hosts', () => {
    const cases = [
        { locationLike: locationLike('staging.openanonymity.ai'), orgApiBase: 'http://127.0.0.1:8005' },
        { locationLike: locationLike('127.0.0.1'), orgApiBase: 'https://org.openanonymity.ai' },
        { locationLike: locationLike('localhost.example.com'), orgApiBase: 'http://127.0.0.1:8005' },
        { locationLike: locationLike('127.0.0.1'), orgApiBase: 'http://127.0.0.1.example.com:8005' },
        { locationLike: locationLike('127.0.0.1', 'file:'), orgApiBase: 'http://127.0.0.1:8005' },
        { locationLike: locationLike('127.0.0.1'), orgApiBase: 'not-a-url' }
    ];

    for (const options of cases) {
        assert.equal(isLocalVerifierBypassAllowed(options), false);
    }
    assert.equal(isExplicitLoopbackHostname('127.0.0.2'), false);
});

test('disposable demo bypass requires an explicit HTTPS same-origin build', () => {
    const demoLocation = {
        hostname: 'oa-branch-demo.vercel.app',
        protocol: 'https:',
        origin: 'https://oa-branch-demo.vercel.app'
    };
    assert.equal(getVerifierBypassDetail({
        locationLike: demoLocation,
        orgApiBase: demoLocation.origin,
        demoBypassEnabled: true
    }), 'explicit_disposable_demo');
    assert.equal(isLocalVerifierBypassAllowed({
        locationLike: demoLocation,
        orgApiBase: 'https://org.openanonymity.ai',
        demoBypassEnabled: true
    }), false);
    assert.equal(isLocalVerifierBypassAllowed({
        locationLike: {
            hostname: 'chat.openanonymity.ai',
            protocol: 'https:',
            origin: 'https://chat.openanonymity.ai'
        },
        orgApiBase: 'https://chat.openanonymity.ai',
        demoBypassEnabled: true
    }), false);
    for (const hostname of [
        'openanonymity.ai',
        'www.openanonymity.ai',
        'staging.openanonymity.ai',
        'nested.preview.openanonymity.ai'
    ]) {
        const origin = `https://${hostname}`;
        assert.equal(isLocalVerifierBypassAllowed({
            locationLike: { hostname, protocol: 'https:', origin },
            orgApiBase: origin,
            demoBypassEnabled: true
        }), false);
    }
});
