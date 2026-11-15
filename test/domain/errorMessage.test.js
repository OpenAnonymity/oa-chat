import test from 'node:test';
import assert from 'node:assert/strict';
import { getErrorMessage } from '../../chat/domain/errorMessage.js';

test('extracts text from thrown values and structured server errors', () => {
    for (const value of [
        'Service unavailable', new Error('Service unavailable'),
        { message: { detail: 'Service unavailable' } },
        { detail: { error: { message: 'Service unavailable' } } },
        { detail: [{ msg: 'Service unavailable', input: 'private input' }] }
    ]) assert.equal(getErrorMessage(value), 'Service unavailable');
    assert.equal(getErrorMessage({ detail: [{ msg: 'First' }, { msg: 'Second' }] }), 'First; Second');
});

test('unknown, empty and cyclic errors use fallback without dumping response fields', () => {
    const cyclic = { key: 'private key', tickets: ['private ticket'] };
    cyclic.message = cyclic;
    for (const value of [null, undefined, 42, false, '', '  ', [], {}, cyclic,
        { message: { input: 'private input' }, data: { key: 'private key' } }]) {
        assert.equal(getErrorMessage(value, 'Request failed'), 'Request failed');
    }
    cyclic.detail = 'Safe message';
    assert.equal(getErrorMessage(cyclic), 'Safe message');
});
