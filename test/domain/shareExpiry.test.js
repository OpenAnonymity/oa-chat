import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCustomShareExpiry, SHARE_TTL_MAX_SECONDS } from '../../chat/domain/shareExpiry.js';

test('a valid custom expiry resolves to seconds', () => {
    assert.deepEqual(resolveCustomShareExpiry('3', '86400'), { ok: true, ttlSeconds: 3 * 86400 });
    assert.deepEqual(resolveCustomShareExpiry('90', 60), { ok: true, ttlSeconds: 5400 });
    assert.deepEqual(resolveCustomShareExpiry(' 12 ', '3600'), { ok: true, ttlSeconds: 12 * 3600 });
});

test('zero days is an error, not a one-day share', () => {
    const result = resolveCustomShareExpiry('0', '86400');
    assert.equal(result.ok, false);
    assert.match(result.message, /at least 1 day/);
});

test('empty, negative, fractional and non-numeric values are errors', () => {
    for (const value of ['', '   ', '-1', '1.5', 'abc', 'NaN', 'Infinity']) {
        assert.equal(resolveCustomShareExpiry(value, '86400').ok, false, `value ${JSON.stringify(value)}`);
    }
});

test('values past the 30-day ceiling are refused rather than clamped', () => {
    const result = resolveCustomShareExpiry('31', '86400');
    assert.equal(result.ok, false);
    assert.match(result.message, /at most 30 days/);
    assert.deepEqual(resolveCustomShareExpiry('30', '86400'), { ok: true, ttlSeconds: SHARE_TTL_MAX_SECONDS });
    assert.equal(resolveCustomShareExpiry('999', '3600').ok, false);
});

test('an unknown unit is an error', () => {
    assert.equal(resolveCustomShareExpiry('1', '7').ok, false);
});
