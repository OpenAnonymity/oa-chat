import test from 'node:test';
import assert from 'node:assert/strict';
import { productionProxyUrl } from '../../scripts/proxy-build-setting.mjs';
test('production relay selection accepts WSS without enabling verifier bypass', () => {
    assert.equal(productionProxyUrl(), '');
    assert.equal(productionProxyUrl('wss://relay.example'), 'wss://relay.example/');
    for (const value of ['https://relay.example', 'ws://relay.example', 'wss://user:password@relay.example', 'wss://relay.example/path', 'wss://relay.example/?token=x', 'wss://relay.example/#x', 'bad']) {
        assert.throws(() => productionProxyUrl(value), /exact root WSS/);
    }
});
