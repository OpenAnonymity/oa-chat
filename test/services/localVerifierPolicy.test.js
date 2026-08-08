import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isExplicitLoopbackHostname,
    isLocalVerifierBypassAllowed
} from '../../chat/services/inference/localVerifierPolicy.js';

function locationLike(hostname, protocol = 'http:') {
    return { hostname, protocol };
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
