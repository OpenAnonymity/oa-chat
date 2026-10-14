import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the vendored class, with native allocations checked for use-after-free.
// No network, browser profile, or replacement JS lifecycle implementation.
function fixture() {
    const source = fs.readFileSync(process.env.OA_LIBCURL_SOURCE || 'chat/vendor/libcurl/libcurl_full.js', 'utf8');
    const start = source.indexOf('class CurlSession {');
    const end = source.indexOf('class HTTPSession extends CurlSession', start);
    assert.ok(start >= 0 && end > start);
    const intervals = new Map(), timeouts = [], cleanedRequests = new Set();
    let timer = 0, cleaned = false, cleanupCount = 0;
    const live = ptr => { assert.equal(ptr, 1); assert.equal(cleaned, false, 'native session was already freed'); };
    const context = {
        check_loaded() {},
        _session_create: () => 1,
        _session_add_request: live, _session_remove_request: live,
        _session_perform: live, _session_get_active: ptr => { live(ptr); return 1; },
        _session_cleanup: ptr => { live(ptr); cleaned = true; cleanupCount++; },
        _request_cleanup: ptr => {
            assert.equal(cleanedRequests.has(ptr), false, 'request freed twice');
            cleanedRequests.add(ptr);
        },
        Module: { addFunction: () => 1, removeFunction() {} },
        setInterval: fn => { intervals.set(++timer, fn); return timer; },
        clearInterval: id => intervals.delete(id),
        setTimeout: fn => { timeouts.push(fn); },
    };
    vm.runInNewContext(`${source.slice(start, end)};this.Subject = CurlSession;`, context);
    return { session: new context.Subject(), intervals, cleanedRequests,
        flush: () => { while (timeouts.length) timeouts.shift()(); },
        cleanupCount: () => cleanupCount };
}

test('closing a libcurl session stops polling before native cleanup, including queued ticks', () => {
    const f = fixture(); f.session.start_request(10);
    const queuedTick = [...f.intervals.values()][0];
    f.session.close(); f.flush();
    assert.equal(f.intervals.size, 0);
    assert.doesNotThrow(queuedTick);
    assert.equal(f.cleanupCount(), 1);
});

test('close cleans every native request even though removal mutates the request list', () => {
    const f = fixture();
    for (const ptr of [10, 11, 12]) f.session.start_request(ptr);
    f.session.close(); f.flush();
    assert.deepEqual([...f.cleanedRequests], [10, 11, 12]);
    assert.equal(f.session.requests_list.length, 0);
});

test('queued request removal after session cleanup cannot free its request twice', () => {
    const f = fixture(); f.session.start_request(10);
    f.session.remove_request(10);
    f.session.close_now();
    assert.doesNotThrow(f.flush);
    assert.equal(f.cleanedRequests.size, 1);
});

test('repeated close is idempotent and a closing session rejects new requests', () => {
    const f = fixture(); f.session.start_request(10);
    f.session.close();
    assert.throws(() => f.session.start_request(11), /session has been removed/);
    f.session.close(); f.flush();
    assert.doesNotThrow(() => f.session.close());
    assert.equal(f.cleanupCount(), 1);
});

test('late cancellation during and after shutdown leaves cleanup with close', () => {
    const f = fixture(); f.session.start_request(10);
    f.session.close();
    assert.doesNotThrow(() => f.session.remove_request(10));
    f.flush();
    assert.doesNotThrow(() => f.session.remove_request(10));
    f.flush();
    assert.equal(f.cleanedRequests.size, 1);
    assert.equal(f.cleanupCount(), 1);
});
