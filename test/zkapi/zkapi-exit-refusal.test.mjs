import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { serviceCopyKey } from '../../chat/zkapi/versioning/copy.mjs';
import {
    EXIT_REFUSAL_CODES,
    REFUSAL_HORIZON_MS,
    REFUSAL_SKEW_MS,
    SERVICE_REFUSAL_CODES,
    readExitRefusal,
    readServiceRefusal
} from '../../chat/zkapi/versioning/exitRefusal.mjs';

// The SDK's own error objects, recorded from the real revision 3 runtime
// (test/fixtures/zkapi-v2-real-shapes/README.md). `generatedAtMs` is the
// frozen clock the instants in them are relative to; no test here reads
// Date.now() against them.
const FIXTURE = JSON.parse(fs.readFileSync(
    new URL('../fixtures/zkapi-v2-real-shapes/snapshots.json', import.meta.url), 'utf8'
));
const NOW = FIXTURE.generatedAtMs;
const DAY_MS = 86_400_000;

function realError(name) {
    const shape = FIXTURE.errors[name];
    const error = new Error(shape.message);
    error.name = shape.name;
    if (shape.status !== null) error.status = shape.status;
    error.code = shape.code;
    if (shape.data !== null) error.data = structuredClone(shape.data);
    return error;
}

const withData = (code, data, extra = {}) => Object.assign(new Error('x'), { code, data, ...extra });

// ---------------------------------------------------------------------------
// Exit refusals
// ---------------------------------------------------------------------------

test('the exit refusal codes are exactly the six the SDK throws about exiting', () => {
    assert.deepEqual([...EXIT_REFUSAL_CODES], [
        'request_settlement_pending', 'ownership_proof_wait', 'exit_release_pending', 'exit_locked',
        'device_not_newest', 'note_near_expiry'
    ]);
    assert.ok(Object.isFrozen(EXIT_REFUSAL_CODES));
    assert.equal(REFUSAL_HORIZON_MS, 90 * DAY_MS);
});

test('wiring:ownership-proof-wait the retry instant is the delay in seconds counted from now', () => {
    const refusal = readExitRefusal(realError('ownership_proof_wait'), NOW);
    assert.deepEqual(refusal, {
        code: 'ownership_proof_wait', kind: 'proof',
        // retry_after: 4 is SECONDS.
        untilMs: NOW + 4_000,
        escapeAtMs: null, mustInitiateByMs: null, boundAtState: null, forcedEscape: null, reason: null
    });
    // A fraction of a second is kept; no delay is "retry now"; a missing or
    // negative delay is "not known".
    assert.equal(readExitRefusal(withData('ownership_proof_wait', { retry_after: 0.5 }), NOW).untilMs, NOW + 500);
    assert.equal(readExitRefusal(withData('ownership_proof_wait', { retry_after: 0 }), NOW).untilMs, NOW);
    for (const data of [{}, null, { retry_after: -1 }, { retry_after: '4' }, { retry_after: NaN }, { retry_after: 1e9 }]) {
        const read = readExitRefusal(withData('ownership_proof_wait', data), NOW);
        assert.equal(read.kind, 'proof');
        assert.equal(read.untilMs, null, JSON.stringify(data));
    }
});

test('wiring:ownership-proof-wait a settlement wait carries its time in milliseconds, with the amounts as strings', () => {
    const error = realError('request_settlement_pending_withdraw');
    const refusal = readExitRefusal(error, NOW);
    assert.deepEqual(refusal, {
        code: 'request_settlement_pending', kind: 'settlement',
        // escape_at and must_initiate_by are MILLISECONDS: the same numbers, not times a thousand.
        untilMs: error.data.escape_at,
        escapeAtMs: error.data.escape_at,
        mustInitiateByMs: error.data.must_initiate_by,
        boundAtState: '1000000',
        forcedEscape: { zero: '0', bound: '1000000' },
        reason: null
    });
    assert.ok(refusal.escapeAtMs > NOW && refusal.escapeAtMs < NOW + DAY_MS);
    // The settlement time is a wait, not the lock's: both ends are the same instant.
    assert.equal(refusal.untilMs, refusal.escapeAtMs);
    // A bound the SDK wrote as a number is the same amount.
    const numeric = withData('request_settlement_pending', { ...error.data, bound_at_state: 1_000_000 });
    assert.equal(readExitRefusal(numeric, NOW).boundAtState, '1000000');
    // Not an amount: unknown, never a guess. Half a forced pair is none.
    for (const bound of ['1e6', '-5', '1.5', null, {}, 1.5]) {
        const read = readExitRefusal(withData('request_settlement_pending', { ...error.data, bound_at_state: bound }), NOW);
        assert.equal(read.boundAtState, null, String(bound));
        assert.equal(read.kind, 'settlement');
    }
    const half = withData('request_settlement_pending', { ...error.data, forced_escape: { zero: '0' } });
    assert.equal(readExitRefusal(half, NOW).forcedEscape, null);
});

test('wiring:ownership-proof-wait a settlement time in seconds is not believed', () => {
    const error = realError('request_settlement_pending_withdraw');
    // The same instant written in seconds (a unit slip): a date in January 1970.
    const slipped = withData('request_settlement_pending', {
        ...error.data, escape_at: Math.floor(error.data.escape_at / 1000),
        must_initiate_by: Math.floor(error.data.must_initiate_by / 1000)
    });
    const read = readExitRefusal(slipped, NOW);
    assert.equal(read.kind, 'settlement');
    assert.equal(read.untilMs, null);
    assert.equal(read.escapeAtMs, null);
    assert.equal(read.mustInitiateByMs, null);
    // The other direction (milliseconds read as seconds) is a date in the year
    // 58000: also not believed.
    const huge = withData('request_settlement_pending', { ...error.data, escape_at: error.data.escape_at * 1000 });
    assert.equal(readExitRefusal(huge, NOW).escapeAtMs, null);
});

test('a deadline reached between the SDK computing it and the host reading the error has just ended', () => {
    assert.equal(REFUSAL_SKEW_MS, 60_000);
    // `escape_at` a moment behind the clock: the error was thrown a little
    // before this read. It is "now", which every consumer reads as "over", and
    // not "not known", which would be a wait with no end.
    const settlement = ms => readExitRefusal(withData('request_settlement_pending', {
        escape_at: ms, must_initiate_by: NOW + DAY_MS, bound_at_state: '5'
    }), NOW);
    for (const behind of [1, 40, 1_000, REFUSAL_SKEW_MS]) {
        const read = settlement(NOW - behind);
        assert.equal(read.untilMs, NOW, `${behind} ms behind`);
        assert.equal(read.escapeAtMs, NOW, `${behind} ms behind`);
        // What is not a time is read as always.
        assert.equal(read.boundAtState, '5');
        assert.equal(read.mustInitiateByMs, NOW + DAY_MS);
    }
    assert.equal(settlement(NOW - REFUSAL_SKEW_MS - 1).untilMs, null);
    // Seconds fields (release, lock) are held to the same rule once converted.
    const lock = seconds => readExitRefusal(withData('exit_locked', { mode: 'escape', releasable_after: seconds }), NOW).untilMs;
    assert.equal(lock(NOW / 1000 - 5), NOW);
    assert.equal(lock(NOW / 1000 - 3_600), null, 'an hour behind is a stale record, not a moment ago');
    // A unit slip is never rescued by this: January 1970 is far behind.
    assert.equal(settlement(Math.floor(NOW / 1000)).untilMs, null);
    // Without a clock nothing is behind it.
    assert.equal(readExitRefusal(withData('request_settlement_pending', { escape_at: NOW - 5 }), undefined).untilMs, null);
});

test('wiring:ownership-proof-wait a pending release and a lock carry seconds, read as milliseconds', () => {
    // The recorded release time is already past at the frozen clock: the wait
    // is over as far as the instant goes, and only the facts that are still
    // true remain.
    const release = readExitRefusal(realError('exit_release_pending'), NOW);
    assert.equal(release.kind, 'release');
    assert.equal(release.untilMs, null);
    assert.equal(release.mustInitiateByMs, 1795910400 * 1000);
    assert.equal(release.reason, 'note_status_unknown');
    // The same error a little earlier: the instant is `releasable_after` seconds, times a thousand.
    const earlier = readExitRefusal(realError('exit_release_pending'), 1794734900 * 1000 - 5_000);
    assert.equal(earlier.untilMs, 1794734900 * 1000);

    const locked = readExitRefusal(realError('exit_locked'), NOW);
    assert.deepEqual(locked, {
        code: 'exit_locked', kind: 'locked', untilMs: 1794755700 * 1000,
        escapeAtMs: null, mustInitiateByMs: null, boundAtState: null, forcedEscape: null, reason: 'proof_live'
    });
    // A lock with no end yet (`releasable_after: null`) has no instant.
    const open = withData('exit_locked', { mode: 'mutual', released: 1, releasable_after: null, reason: 'held' });
    assert.equal(readExitRefusal(open, NOW).untilMs, null);
    // Seconds written in milliseconds (x1000) land beyond the horizon: null.
    const slipped = withData('exit_locked', { mode: 'escape', releasable_after: 1794755700 * 1000 });
    assert.equal(readExitRefusal(slipped, NOW).untilMs, null);
});

test('every instant is kept only inside now..now+90d, and an unreadable clock keeps none', () => {
    const at = ms => readExitRefusal(withData('request_settlement_pending', { escape_at: ms }), NOW).escapeAtMs;
    assert.equal(at(NOW), NOW, 'now itself is a wait that is just ending');
    assert.equal(at(NOW + REFUSAL_HORIZON_MS), NOW + REFUSAL_HORIZON_MS);
    // Behind the clock by more than the skew is not believed (a unit slip is
    // a date in 1970), however near it is.
    assert.equal(at(NOW - REFUSAL_SKEW_MS - 1), null);
    assert.equal(at(NOW + REFUSAL_HORIZON_MS + 1), null);
    for (const value of [0, -5, NaN, Infinity, '1794766205000', null, {}, [], 1e300]) {
        assert.equal(at(value), null, String(value));
    }
    for (const clock of [undefined, null, NaN, Infinity, '1794744000000']) {
        const read = readExitRefusal(realError('request_settlement_pending_withdraw'), clock);
        assert.equal(read.kind, 'settlement', `${clock}: the kind survives`);
        assert.equal(read.untilMs, null, String(clock));
        assert.equal(read.escapeAtMs, null, String(clock));
        assert.equal(read.mustInitiateByMs, null, String(clock));
        // What is not a time is still read.
        assert.equal(read.boundAtState, '1000000', String(clock));
        assert.equal(readExitRefusal(realError('ownership_proof_wait'), clock).untilMs, null, String(clock));
    }
});

test('the refusals that carry no time are still refusals', () => {
    const near = readExitRefusal(realError('note_near_expiry'), NOW);
    assert.deepEqual(near, {
        code: 'note_near_expiry', kind: 'near', untilMs: null, escapeAtMs: null, mustInitiateByMs: null,
        boundAtState: null, forcedEscape: null, reason: null
    });
    for (const name of ['device_not_newest_defeated', 'device_not_newest_successor']) {
        const read = readExitRefusal(realError(name), NOW);
        assert.equal(read.kind, 'device', name);
        assert.equal(read.untilMs, null, name);
    }
    assert.equal(readExitRefusal(realError('device_not_newest_defeated'), NOW).reason, 'defeated');
    assert.equal(readExitRefusal(realError('device_not_newest_successor'), NOW).reason, null);
});

test('the chat shape of request_settlement_pending is not an exit refusal', () => {
    assert.equal(readExitRefusal(realError('request_settlement_pending_chat'), NOW), null);
    assert.equal(readExitRefusal(withData('request_settlement_pending', null), NOW), null);
    assert.equal(readExitRefusal(withData('request_settlement_pending', {}), NOW), null);
    // Present but not a time: still the withdrawal shape, with no instant.
    assert.equal(readExitRefusal(withData('request_settlement_pending', { escape_at: null }), NOW).kind, 'settlement');
});

test('the code is read from the error, its data, its cause and a nested error object', () => {
    const data = { retry_after: 3 };
    const expected = readExitRefusal(withData('ownership_proof_wait', data), NOW);
    assert.equal(expected.untilMs, NOW + 3_000);
    const shapes = [
        // the error's own code
        Object.assign(new Error('x'), { code: 'ownership_proof_wait', data }),
        // the code in the data, beside its fields
        Object.assign(new Error('x'), { code: 'http_error', data: { code: 'ownership_proof_wait', retry_after: 3 } }),
        // a wrapped error
        Object.assign(new Error('x'), { cause: Object.assign(new Error('y'), { code: 'ownership_proof_wait', data }) }),
        // an error object nested in the response body
        Object.assign(new Error('x'), { data: { error: { code: 'ownership_proof_wait', data } } }),
        // a plain object
        { code: 'ownership_proof_wait', data }
    ];
    for (const [index, shape] of shapes.entries()) {
        assert.deepEqual(readExitRefusal(shape, NOW), expected, `shape ${index}`);
    }
});

test('anything else is not a refusal, and nothing an error carries makes the reader throw', () => {
    for (const value of [null, undefined, 'exit_locked', 7, true, [], () => {}]) {
        assert.equal(readExitRefusal(value, NOW), null, String(value));
    }
    for (const code of ['deposits_closed', 'previous_withdrawal_open', 'indexer_root_lag', 'toString', '__proto__',
        'constructor', '', null, 7, {}]) {
        assert.equal(readExitRefusal({ code }, NOW), null, String(code));
    }
    const hostile = [
        { get code() { throw new Error('getter'); } },
        { code: 'exit_locked', get data() { throw new Error('getter'); } },
        new Proxy({}, { get() { throw new Error('proxy'); }, has() { throw new Error('proxy'); } }),
        { code: 'exit_locked', data: { get releasable_after() { throw new Error('getter'); } } }
    ];
    for (const error of hostile) {
        assert.doesNotThrow(() => readExitRefusal(error, NOW));
        assert.doesNotThrow(() => readServiceRefusal(error));
    }
});

test('fields that sit on the error itself, and not in its data, are not read', () => {
    // Another library's error can carry a `reason` or an `escape_at` of its own.
    const foreign = Object.assign(new Error('x'), { code: 'device_not_newest', reason: 'insufficient_funds' });
    assert.equal(readExitRefusal(foreign, NOW).reason, null);
    const flat = Object.assign(new Error('x'), { code: 'ownership_proof_wait', retry_after: 3 });
    assert.equal(readExitRefusal(flat, NOW).untilMs, null);
    assert.equal(readExitRefusal(Object.assign(new Error('x'), { code: 'request_settlement_pending', escape_at: NOW + 1000 }), NOW), null);
});

test('a refusal carries only its facts: no message, no operator data, no secrets', () => {
    const error = withData('request_settlement_pending', {
        escape_at: NOW + 60_000, must_initiate_by: NOW + 120_000, bound_at_state: '5', forced_escape: { zero: '0', bound: '5' },
        clearance_error_code: 'secret_code', successor_nullifier: '0xSECRET-nullifier', exit_rpc_url: 'https://user:key@rpc.example/'
    }, { message: 'Set your own exit RPC at https://operator.example/config.json' });
    const read = readExitRefusal(error, NOW);
    const text = JSON.stringify(read);
    assert.deepEqual(Object.keys(read).sort(), [
        'boundAtState', 'code', 'escapeAtMs', 'forcedEscape', 'kind', 'mustInitiateByMs', 'reason', 'untilMs'
    ]);
    assert.doesNotMatch(text, /SECRET|secret_code|operator\.example|rpc\.example|user:key/);
    // A reason that is not a machine word is dropped.
    const reason = withData('exit_locked', { reason: 'Visit <b>https://x.example</b>' });
    assert.equal(readExitRefusal(reason, NOW).reason, null);
});

// ---------------------------------------------------------------------------
// Service refusals
// ---------------------------------------------------------------------------

test('wiring:service-message the four manifest codes are an AND with a 503 and exits true', () => {
    const manifest = SERVICE_REFUSAL_CODES.filter(code => code !== 'native_vault_unverified');
    assert.deepEqual(manifest, [
        'deployment_manifest_unavailable', 'deployment_manifest_mismatch', 'deployment_manifest_untrusted',
        'incompatible_proof_circuit'
    ]);
    for (const code of manifest) {
        assert.deepEqual(readServiceRefusal(withData(code, { exits: true }, { status: 503 })), { code }, code);
        // Each half alone is not it.
        assert.equal(readServiceRefusal(withData(code, { exits: true })), null, `${code}: no status`);
        assert.equal(readServiceRefusal(withData(code, { exits: true }, { status: 500 })), null, `${code}: not 503`);
        assert.equal(readServiceRefusal(withData(code, null, { status: 503 })), null, `${code}: no data`);
        assert.equal(readServiceRefusal(withData(code, {}, { status: 503 })), null, `${code}: no exits`);
        assert.equal(readServiceRefusal(withData(code, { exits: false }, { status: 503 })), null, `${code}: exits false`);
        assert.equal(readServiceRefusal(withData(code, { exits: 1 }, { status: 503 })), null, `${code}: exits 1`);
        assert.equal(readServiceRefusal(withData(code, { exits: true }, { status: '503' })), null, `${code}: text status`);
        assert.equal(readServiceRefusal({ code }), null, `${code}: bare`);
    }
});

test('wiring:service-message the SDK\'s recorded errors map to the codes the host has words for', () => {
    const expected = {
        service_unavailable: 'deployment_manifest_unavailable',
        service_mismatch: 'deployment_manifest_mismatch',
        service_incompatible: 'incompatible_proof_circuit',
        native_vault_unverified: 'native_vault_unverified'
    };
    for (const [name, code] of Object.entries(expected)) {
        const read = readServiceRefusal(realError(name));
        assert.deepEqual(read, { code }, name);
        assert.ok(serviceCopyKey(read.code), `${code} has words`);
        // A service refusal is not an exit refusal.
        assert.equal(readExitRefusal(realError(name), NOW), null, name);
    }
    // Every code this module names has words of its own.
    for (const code of SERVICE_REFUSAL_CODES) assert.ok(serviceCopyKey(code), code);
});

test('wiring:service-message the legacy SDK\'s own incompatible_proof_circuit is not a paused service', () => {
    const legacy = realError('legacy_incompatible_proof_circuit');
    assert.equal(legacy.status, undefined, 'the legacy error has no status');
    assert.equal(legacy.data, undefined, 'and no exits flag');
    assert.equal(readServiceRefusal(legacy), null);
    assert.equal(readExitRefusal(legacy, NOW), null);
});

test('wiring:service-message native_vault_unverified is a revision 3 name and matches by its code', () => {
    assert.deepEqual(readServiceRefusal({ code: 'native_vault_unverified' }), { code: 'native_vault_unverified' });
    assert.deepEqual(readServiceRefusal(withData('x', { code: 'native_vault_unverified' })), { code: 'native_vault_unverified' });
    assert.deepEqual(
        readServiceRefusal(Object.assign(new Error('w'), { cause: { code: 'native_vault_unverified' } })),
        { code: 'native_vault_unverified' }
    );
});

test('a service refusal carries only its code, however the error is dressed', () => {
    const error = withData('deployment_manifest_unavailable', {
        exits: true, detail: 'Unable to load https://operator.example/config.json (404)'
    }, { status: 503, message: 'https://operator.example/config.json' });
    const read = readServiceRefusal(error);
    assert.deepEqual(read, { code: 'deployment_manifest_unavailable' });
    assert.doesNotMatch(JSON.stringify(read), /operator\.example/);
    for (const value of [null, undefined, 'x', 7, [], {}]) assert.equal(readServiceRefusal(value), null);
});
