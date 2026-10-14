// Build switches and the state that survives them
// (chat/zkapi/versioning/switchProtocol.mjs).
//
// Pins: the one-shot hint round trip and its validation, the loop guard that
// consuming a hint can never reset, the stale dialog view rewrite, the upgrade
// intent and its expiry, and that every storage failure resolves to the safe
// answer instead of an exception or an unbounded reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    LOOP_WINDOW_MS, MAX_DISCARDS_PER_WINDOW, MAX_SWITCHES_PER_WINDOW, SWITCH_HINT_KEY, SWITCH_HINT_MAX_AGE_MS,
    SWITCH_LOG_KEY, SWITCH_REASONS, SWITCH_VIEWS, UPGRADE_INTENT_KEY, UPGRADE_INTENT_TTL_MS, UPGRADE_STAGES,
    canDiscard, clearUpgradeIntent, consumeVersionSwitch, noteDiscard, readUpgradeIntent, recordDiscard,
    requestVersionSwitch, writeUpgradeIntent
} from '../../chat/zkapi/versioning/switchProtocol.mjs';
import { createFakeStorage } from './_fakeIndexedDb.mjs';

const NOW = 1_800_000_000_000;
const RUNNING_MODAL_KEY = 'oa-zkapi-running-modal';
const TABLE = [
    { id: 'v1', status: 'exit-only' },
    { id: 'v2', status: 'active' },
    { id: 'v0', status: 'retired' }
];

function reloader() {
    const calls = [];
    return { calls, reload: () => { calls.push(1); } };
}

const request = (overrides = {}) => ({
    reason: 'upgrade_withdrawn', view: 'fund', prefer: null, from: 'v1', canReload: true, now: NOW, ...overrides
});

// ------------------------------------------------------------------ the hint

test('a request writes one validated hint and reloads; boot consumes it once', () => {
    const storage = createFakeStorage();
    const { calls, reload } = reloader();
    assert.deepEqual(requestVersionSwitch({ ...request({ reason: 'finish_previous', prefer: 'v1', from: 'v2', view: 'withdrawals' }), storage, reload }),
        { ok: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(storage.getItem(SWITCH_HINT_KEY)), {
        v: 1, at: NOW, from: 'v2', reason: 'finish_previous', view: 'withdrawals', prefer: 'v1'
    });

    const consumed = consumeVersionSwitch({ storage, table: TABLE, now: NOW + 5000 });
    assert.deepEqual(consumed, { reason: 'finish_previous', view: 'withdrawals', from: 'v2', prefer: 'v1' });
    assert.equal(storage.has(SWITCH_HINT_KEY), false);
    // The loop-guard log is a separate key and survives consuming the hint.
    assert.equal(storage.has(SWITCH_LOG_KEY), true);
    assert.equal(consumeVersionSwitch({ storage, table: TABLE, now: NOW + 5000 }), null);
});

test('view and prefer are optional', () => {
    const storage = createFakeStorage();
    requestVersionSwitch({ reason: 'moved_in_other_tab', from: 'v1', canReload: true, now: NOW, storage, reload: () => {} });
    assert.deepEqual(consumeVersionSwitch({ storage, now: NOW }),
        { reason: 'moved_in_other_tab', view: null, from: 'v1', prefer: null });
});

test('every reason and view in the fixed sets round-trips', () => {
    for (const reason of SWITCH_REASONS) {
        for (const view of [null, ...SWITCH_VIEWS]) {
            const storage = createFakeStorage();
            assert.equal(requestVersionSwitch({ ...request({ reason, view }), storage, reload: () => {} }).ok, true);
            assert.deepEqual(consumeVersionSwitch({ storage, table: TABLE, now: NOW }), { reason, view, from: 'v1', prefer: null });
        }
    }
});

test('a reason or source version outside the fixed sets is a programming error and writes nothing', () => {
    const bad = [
        { reason: 'because' }, { reason: undefined }, { reason: 'upgrade_withdrawn ' },
        { from: '' }, { from: undefined }, { from: 'v 1' }, { from: '<script>' }
    ];
    for (const change of bad) {
        const storage = createFakeStorage();
        const { calls, reload } = reloader();
        assert.throws(() => requestVersionSwitch({ ...request(change), storage, reload }),
            error => error instanceof TypeError && error.code === 'invalid_switch_request', JSON.stringify(change));
        assert.deepEqual(storage.snapshot(), {});
        assert.equal(calls.length, 0);
    }
});

// The reload button forwards whatever view the dialog is on. The dialog has
// views this protocol has no name for ('withdraw', 'upgrade'); that must not
// turn a click into a silent exception.
test('an unknown view or preferred version is dropped, never thrown, and the saved view is removed', () => {
    for (const view of ['withdraw', 'upgrade', 'balance; drop', '', 'FUND', 5, {}, [], true, undefined]) {
        const saved = JSON.stringify({ view: 'withdraw', mode: 'escape', amount: '12' });
        const storage = createFakeStorage({ initial: { [RUNNING_MODAL_KEY]: saved } });
        const { calls, reload } = reloader();
        assert.deepEqual(requestVersionSwitch({ ...request({ view }), storage, reload }), { ok: true },
            JSON.stringify(view));
        assert.equal(calls.length, 1);
        assert.equal(JSON.parse(storage.getItem(SWITCH_HINT_KEY)).view, null, JSON.stringify(view));
        // The stale-view rewrite removes the saved view instead of keeping one
        // the next build might not have.
        assert.equal(storage.has(RUNNING_MODAL_KEY), false, JSON.stringify(view));
        assert.deepEqual(consumeVersionSwitch({ storage, table: TABLE, now: NOW }),
            { reason: 'upgrade_withdrawn', view: null, from: 'v1', prefer: null });
    }
    // A prefer that is not a version id is dropped the same way; the rest of
    // the request stands.
    for (const prefer of ['', 'v1/../x', 'v'.repeat(40), 5, { id: 'v1' }, ['v1'], true]) {
        const storage = createFakeStorage();
        const { calls, reload } = reloader();
        assert.deepEqual(requestVersionSwitch({ ...request({ reason: 'finish_previous', view: 'fund', prefer }), storage, reload },
        ), { ok: true }, JSON.stringify(prefer));
        assert.equal(calls.length, 1);
        assert.deepEqual(JSON.parse(storage.getItem(SWITCH_HINT_KEY)),
            { v: 1, at: NOW, from: 'v1', reason: 'finish_previous', view: 'fund', prefer: null });
    }
    // Still refused for what is not about the view: busy, and the guard.
    const busy = createFakeStorage();
    assert.deepEqual(requestVersionSwitch({ ...request({ view: 'withdraw', canReload: false }), storage: busy, reload: () => {} }),
        { ok: false, why: 'busy' });
    assert.deepEqual(busy.snapshot(), {});
});

test('a hint that does not validate yields nothing and is still deleted', () => {
    const base = { v: 1, at: NOW, from: 'v1', reason: 'upgrade_withdrawn', view: 'fund', prefer: null };
    const stale = NOW - SWITCH_HINT_MAX_AGE_MS - 1;
    const cases = [
        ['not json', '{nope'],
        ['an array', JSON.stringify([base])],
        ['a string', JSON.stringify('v1')],
        ['wrong schema', JSON.stringify({ ...base, v: 2 })],
        ['no schema', JSON.stringify({ ...base, v: undefined })],
        ['an unknown reason', JSON.stringify({ ...base, reason: 'please' })],
        ['an unknown view', JSON.stringify({ ...base, view: 'upgrade' })],
        ['a missing view', JSON.stringify({ ...base, view: undefined })],
        ['a prefer that is not an id', JSON.stringify({ ...base, prefer: 'v1;x' })],
        ['a prefer that is not in the table', JSON.stringify({ ...base, prefer: 'v7' })],
        ['a prefer that is retired', JSON.stringify({ ...base, prefer: 'v0' })],
        ['a source that is not in the table', JSON.stringify({ ...base, from: 'v7' })],
        ['an expired hint', JSON.stringify({ ...base, at: stale })],
        ['a hint from the future', JSON.stringify({ ...base, at: NOW + 60 * 60 * 1000 })],
        ['a hint without a time', JSON.stringify({ ...base, at: undefined })],
        ['a time that is not a number', JSON.stringify({ ...base, at: 'now' })]
    ];
    for (const [name, raw] of cases) {
        const storage = createFakeStorage({ initial: { [SWITCH_HINT_KEY]: raw } });
        assert.equal(consumeVersionSwitch({ storage, table: TABLE, now: NOW }), null, name);
        assert.equal(storage.has(SWITCH_HINT_KEY), false, `${name}: deleted`);
    }
    // The boundaries themselves are fine.
    const edge = createFakeStorage({ initial: { [SWITCH_HINT_KEY]: JSON.stringify({ ...base, at: NOW - SWITCH_HINT_MAX_AGE_MS, prefer: 'v1' }) } });
    assert.equal(consumeVersionSwitch({ storage: edge, table: TABLE, now: NOW }).prefer, 'v1');
});

test('only whitelisted fields come back, and a retired source version is accepted', () => {
    const storage = createFakeStorage({ initial: { [SWITCH_HINT_KEY]: JSON.stringify({
        v: 1, at: NOW, from: 'v0', reason: 'claim_credit', view: null, prefer: 'v1', extra: '0xdeadbeef', noteId: 5
    }) } });
    assert.deepEqual(consumeVersionSwitch({ storage, table: TABLE, now: NOW }),
        { reason: 'claim_credit', view: null, from: 'v0', prefer: 'v1' });
});

test('without a table only the shapes are checked', () => {
    const storage = createFakeStorage({ initial: { [SWITCH_HINT_KEY]: JSON.stringify({
        v: 1, at: NOW, from: 'whatever', reason: 'draft_cleared', view: null, prefer: 'anything'
    }) } });
    assert.equal(consumeVersionSwitch({ storage, now: NOW }).prefer, 'anything');
});

test('the URL is never a source: location is not read', () => {
    const reads = [];
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        get() { reads.push('location'); return { search: '?prefer=v1', hash: '#prefer=v1', href: 'https://x/?prefer=v1', reload() {} }; }
    });
    try {
        const storage = createFakeStorage();
        assert.equal(consumeVersionSwitch({ storage, table: TABLE, now: NOW }), null);
        requestVersionSwitch({ ...request(), storage, reload: () => {} });
        consumeVersionSwitch({ storage, table: TABLE, now: NOW });
        recordDiscard({ storage, now: NOW });
        writeUpgradeIntent({ v: 1, network: 'sepolia', from: 'v1', to: 'v2', stage: 'withdrawing', since: NOW }, { storage });
        readUpgradeIntent({ network: 'sepolia', storage, now: NOW });
        clearUpgradeIntent({ storage });
        assert.deepEqual(reads, []);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'location', descriptor);
        else delete globalThis.location;
    }
});

// --------------------------------------------------------------- refusals

test('work in flight refuses the switch and writes nothing', () => {
    for (const canReload of [false, undefined, null, 0, 'yes', 1]) {
        const storage = createFakeStorage();
        const { calls, reload } = reloader();
        assert.deepEqual(requestVersionSwitch({ ...request({ canReload }), storage, reload }), { ok: false, why: 'busy' });
        assert.deepEqual(storage.snapshot(), {});
        assert.equal(calls.length, 0);
    }
});

test('the loop guard refuses a third switch inside a minute, across simulated reloads', () => {
    // One shared storage stands for the tab's sessionStorage across reloads.
    const storage = createFakeStorage();
    const { calls, reload } = reloader();
    const go = at => requestVersionSwitch({ ...request({ now: NOW + at }), storage, reload });
    assert.equal(MAX_SWITCHES_PER_WINDOW, 2);
    assert.deepEqual(go(0), { ok: true });
    assert.notEqual(consumeVersionSwitch({ storage, table: TABLE, now: NOW + 1_000 }), null); // the reloaded page boots
    assert.deepEqual(go(10_000), { ok: true });
    assert.notEqual(consumeVersionSwitch({ storage, table: TABLE, now: NOW + 11_000 }), null);
    // Consuming did not clear the guard.
    assert.deepEqual(go(20_000), { ok: false, why: 'loop' });
    assert.equal(calls.length, 2);
    assert.equal(storage.has(SWITCH_HINT_KEY), false, 'a refused request leaves no hint behind');
    // Still refused until the first falls out of the window; then one more is allowed.
    assert.deepEqual(go(LOOP_WINDOW_MS - 1), { ok: false, why: 'loop' });
    assert.deepEqual(go(LOOP_WINDOW_MS), { ok: true });
    assert.equal(calls.length, 3);
    assert.deepEqual(go(LOOP_WINDOW_MS + 1), { ok: false, why: 'loop' });
});

test('discards are counted in the same log, separately from switches', () => {
    const storage = createFakeStorage();
    assert.equal(MAX_DISCARDS_PER_WINDOW, 2);
    assert.deepEqual(recordDiscard({ storage, now: NOW }), { allowed: true });
    assert.deepEqual(recordDiscard({ storage, now: NOW + 1_000 }), { allowed: true });
    assert.deepEqual(recordDiscard({ storage, now: NOW + 2_000 }), { allowed: false });
    // A refused attempt is not counted: the window is measured from the allowed ones.
    assert.deepEqual(recordDiscard({ storage, now: NOW + LOOP_WINDOW_MS - 1 }), { allowed: false });
    assert.deepEqual(recordDiscard({ storage, now: NOW + LOOP_WINDOW_MS }), { allowed: true });
    // Switches have their own allowance.
    const { reload } = reloader();
    assert.deepEqual(requestVersionSwitch({ ...request({ now: NOW + 3_000 }), storage, reload }), { ok: true });
    assert.deepEqual(requestVersionSwitch({ ...request({ now: NOW + 4_000 }), storage, reload }), { ok: true });
    assert.deepEqual(requestVersionSwitch({ ...request({ now: NOW + 5_000 }), storage, reload }), { ok: false, why: 'loop' });
    // Both kinds live in one small log.
    const log = JSON.parse(storage.getItem(SWITCH_LOG_KEY));
    assert.ok(log.length <= 16);
    assert.deepEqual([...new Set(log.map(entry => entry.k))].sort(), ['discard', 'switch']);
    assert.deepEqual(Object.keys(log[0]).sort(), ['k', 't']);
});

test('canDiscard only reads: it never counts, and agrees with what recordDiscard would allow', () => {
    const inner = createFakeStorage();
    const writes = [];
    const storage = {
        getItem: key => inner.getItem(key),
        setItem(key, value) { writes.push(key); inner.setItem(key, value); },
        removeItem(key) { writes.push(key); inner.removeItem(key); }
    };
    // As often as it is asked, an empty log allows and stays empty.
    for (let index = 0; index < 5; index += 1) {
        assert.deepEqual(canDiscard({ storage, now: NOW + index }), { allowed: true });
    }
    assert.deepEqual(writes, []);
    assert.equal(inner.has(SWITCH_LOG_KEY), false);

    assert.deepEqual(noteDiscard({ storage, now: NOW + 1_000 }), { recorded: true });
    assert.deepEqual(canDiscard({ storage, now: NOW + 1_500 }), { allowed: true });
    assert.deepEqual(noteDiscard({ storage, now: NOW + 2_000 }), { recorded: true });
    // The same allowance as recordDiscard: two per window, then no more.
    assert.equal(MAX_DISCARDS_PER_WINDOW, 2);
    const full = inner.getItem(SWITCH_LOG_KEY);
    assert.deepEqual(canDiscard({ storage, now: NOW + 3_000 }), { allowed: false });
    assert.deepEqual(recordDiscard({ storage: createFakeStorage({ initial: { [SWITCH_LOG_KEY]: full } }), now: NOW + 3_000 }),
        { allowed: false });
    assert.equal(inner.getItem(SWITCH_LOG_KEY), full, 'asking changed nothing');
    // The window is measured from the recorded discards.
    assert.deepEqual(canDiscard({ storage, now: NOW + 1_000 + LOOP_WINDOW_MS - 1 }), { allowed: false });
    assert.deepEqual(canDiscard({ storage, now: NOW + 1_000 + LOOP_WINDOW_MS }), { allowed: true });

    // Switches have their own allowance and do not count here.
    const switches = createFakeStorage();
    const { reload } = reloader();
    requestVersionSwitch({ ...request({ now: NOW }), storage: switches, reload });
    requestVersionSwitch({ ...request({ now: NOW + 1 }), storage: switches, reload });
    assert.deepEqual(canDiscard({ storage: switches, now: NOW + 2 }), { allowed: true });
});

test('noteDiscard appends one discard entry to the shared log and keeps what is there', () => {
    const storage = createFakeStorage();
    const { reload } = reloader();
    requestVersionSwitch({ ...request({ now: NOW }), storage, reload });
    assert.deepEqual(noteDiscard({ storage, now: NOW + 500 }), { recorded: true });
    assert.deepEqual(JSON.parse(storage.getItem(SWITCH_LOG_KEY)), [{ t: NOW, k: 'switch' }, { t: NOW + 500, k: 'discard' }]);
    // The log stays small.
    for (let index = 0; index < 40; index += 1) noteDiscard({ storage, now: NOW + 1000 + index });
    assert.ok(JSON.parse(storage.getItem(SWITCH_LOG_KEY)).length <= 16);
    // Charging past the allowance is still recorded (the discard happened).
    assert.deepEqual(noteDiscard({ storage, now: NOW + 2000 }), { recorded: true });
    // A corrupt log is replaced by a valid one.
    const corrupt = createFakeStorage({ initial: { [SWITCH_LOG_KEY]: '{nope' } });
    assert.deepEqual(noteDiscard({ storage: corrupt, now: NOW }), { recorded: true });
    assert.deepEqual(JSON.parse(corrupt.getItem(SWITCH_LOG_KEY)), [{ t: NOW, k: 'discard' }]);
});

test('a corrupt log is read as empty and entries from far outside the window are ignored', () => {
    const storage = createFakeStorage({ initial: { [SWITCH_LOG_KEY]: '{not json' } });
    assert.deepEqual(recordDiscard({ storage, now: NOW }), { allowed: true });
    const poisoned = createFakeStorage({ initial: { [SWITCH_LOG_KEY]: JSON.stringify([
        { t: NOW, k: 'discard' }, { t: NOW, k: 'discard' }, null, 5, { t: 'x', k: 'discard' },
        { t: NOW - 10 * LOOP_WINDOW_MS, k: 'discard' }, { t: NOW + 10 * LOOP_WINDOW_MS, k: 'discard' }, { t: NOW, k: 'other' }
    ]) } });
    assert.deepEqual(recordDiscard({ storage: poisoned, now: NOW }), { allowed: false });
});

// ------------------------------------------------------ stale dialog views

test('the saved dialog view is rewritten to the intended view, or removed', () => {
    const saved = JSON.stringify({ view: 'withdrawals', mode: 'escape', method: 'metamask', amount: '12', scroll: 300, help: 'quote' });
    const storage = createFakeStorage({ initial: { [RUNNING_MODAL_KEY]: saved } });
    requestVersionSwitch({ ...request({ view: 'fund' }), storage, reload: () => {} });
    assert.deepEqual(JSON.parse(storage.getItem(RUNNING_MODAL_KEY)), { view: 'fund' });

    requestVersionSwitch({ ...request({ view: null, now: NOW + 1000 }), storage, reload: () => {} });
    assert.equal(storage.has(RUNNING_MODAL_KEY), false);

    // Nothing saved and no view: nothing written.
    const empty = createFakeStorage();
    requestVersionSwitch({ ...request({ view: null }), storage: empty, reload: () => {} });
    assert.equal(empty.has(RUNNING_MODAL_KEY), false);
});

test('a dialog view that cannot be rewritten does not stop the switch', () => {
    const inner = createFakeStorage();
    const storage = {
        getItem: key => inner.getItem(key),
        setItem(key, value) {
            if (key === RUNNING_MODAL_KEY) throw new Error('quota');
            inner.setItem(key, value);
        },
        removeItem: key => inner.removeItem(key)
    };
    const { calls, reload } = reloader();
    assert.deepEqual(requestVersionSwitch({ ...request(), storage, reload }), { ok: true });
    assert.equal(calls.length, 1);
});

// --------------------------------------------------------- storage failures

test('without usable storage a switch is refused and nothing throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        get() { throw new DOMException('blocked', 'SecurityError'); }
    });
    try {
        const { calls, reload } = reloader();
        assert.deepEqual(requestVersionSwitch({ ...request(), reload }), { ok: false, why: 'loop' });
        assert.equal(consumeVersionSwitch({ table: TABLE, now: NOW }), null);
        assert.deepEqual(recordDiscard({ now: NOW }), { allowed: false });
        assert.deepEqual(canDiscard({ now: NOW }), { allowed: false });
        assert.deepEqual(noteDiscard({ now: NOW }), { recorded: false });
        assert.equal(calls.length, 0);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
        else delete globalThis.sessionStorage;
    }
    // And with the property simply absent (outside a browser).
    assert.equal(typeof globalThis.sessionStorage, 'undefined');
    assert.deepEqual(requestVersionSwitch({ ...request(), reload: () => {} }), { ok: false, why: 'loop' });
    assert.equal(readUpgradeIntent({ network: 'sepolia', now: NOW }), null);
    assert.equal(writeUpgradeIntent({ v: 1, network: 'sepolia', from: 'v1', to: 'v2', stage: 'withdrawing', since: NOW }), false);
    clearUpgradeIntent();
});

test('storage that fails to read or write is a refusal, never a reload or an exception', () => {
    const readFails = createFakeStorage({ failReads: true });
    const { calls, reload } = reloader();
    assert.deepEqual(requestVersionSwitch({ ...request(), storage: readFails, reload }), { ok: false, why: 'loop' });
    assert.equal(consumeVersionSwitch({ storage: readFails, table: TABLE, now: NOW }), null);
    assert.deepEqual(recordDiscard({ storage: readFails, now: NOW }), { allowed: false });
    // The guard that cannot be read cannot be evaluated: no discard, nothing recorded.
    assert.deepEqual(canDiscard({ storage: readFails, now: NOW }), { allowed: false });
    assert.deepEqual(noteDiscard({ storage: readFails, now: NOW }), { recorded: false });

    const writeFails = createFakeStorage({ failWrites: true });
    assert.deepEqual(requestVersionSwitch({ ...request(), storage: writeFails, reload }), { ok: false, why: 'loop' });
    assert.deepEqual(recordDiscard({ storage: writeFails, now: NOW }), { allowed: false });
    assert.deepEqual(noteDiscard({ storage: writeFails, now: NOW }), { recorded: false });
    // Readable but not writable: the check is read-only, so it cannot know. The
    // discard it allows only clears a draft or never-sent plan (re-verified
    // under the wallet lock) and the page load is the only trigger, so this is
    // bounded by the person reloading; the failed charge is reported, not hidden.
    assert.deepEqual(canDiscard({ storage: writeFails, now: NOW }), { allowed: true });
    assert.equal(calls.length, 0);

    // The hint is stored but the log is not: the hint is withdrawn again.
    const inner = createFakeStorage();
    const logFails = {
        getItem: key => inner.getItem(key),
        setItem(key, value) {
            if (key === SWITCH_LOG_KEY) throw new Error('quota');
            inner.setItem(key, value);
        },
        removeItem: key => inner.removeItem(key)
    };
    assert.deepEqual(requestVersionSwitch({ ...request(), storage: logFails, reload }), { ok: false, why: 'loop' });
    assert.equal(inner.has(SWITCH_HINT_KEY), false);
    assert.equal(calls.length, 0);
});

test('a reload that throws withdraws the hint', () => {
    const storage = createFakeStorage();
    const result = requestVersionSwitch({ ...request(), storage, reload: () => { throw new Error('no location'); } });
    assert.deepEqual(result, { ok: false, why: 'busy' });
    assert.equal(storage.has(SWITCH_HINT_KEY), false);
});

test('a hint that cannot be deleted stops being honored when it ages out', () => {
    const inner = createFakeStorage();
    requestVersionSwitch({ ...request(), storage: inner, reload: () => {} });
    const stuck = {
        getItem: key => inner.getItem(key),
        setItem: (key, value) => inner.setItem(key, value),
        removeItem() { throw new Error('read only'); }
    };
    assert.notEqual(consumeVersionSwitch({ storage: stuck, table: TABLE, now: NOW + 1000 }), null);
    assert.equal(consumeVersionSwitch({ storage: stuck, table: TABLE, now: NOW + SWITCH_HINT_MAX_AGE_MS + 1 }), null);
});

// ------------------------------------------------------------ upgrade intent

const intent = (overrides = {}) => ({
    v: 1, network: 'sepolia', from: 'v1', to: 'v2', stage: 'withdrawing', since: NOW, ...overrides
});

test('upgrade intent round trip stores exactly its six fields', () => {
    const storage = createFakeStorage();
    assert.equal(writeUpgradeIntent({ ...intent(), noteId: 5, amount: '10', destination: '0xabc' }, { storage }), true);
    assert.deepEqual(JSON.parse(storage.getItem(UPGRADE_INTENT_KEY)), intent());
    assert.deepEqual(readUpgradeIntent({ network: 'sepolia', storage, now: NOW + 1000 }), intent());
    // A later stage replaces it.
    writeUpgradeIntent(intent({ stage: 'withdrawn' }), { storage });
    assert.equal(readUpgradeIntent({ network: 'sepolia', storage, now: NOW + 1000 }).stage, 'withdrawn');
    clearUpgradeIntent({ storage });
    assert.equal(storage.has(UPGRADE_INTENT_KEY), false);
    assert.equal(readUpgradeIntent({ network: 'sepolia', storage, now: NOW }), null);
});

test('every stage is accepted, anything else is not', () => {
    for (const stage of UPGRADE_STAGES) {
        const storage = createFakeStorage();
        assert.equal(writeUpgradeIntent(intent({ stage }), { storage }), true, stage);
    }
    const invalid = [
        { stage: 'done' }, { stage: '' }, { stage: undefined }, { v: 2 }, { v: undefined }, { network: '' },
        { network: 'main net' }, { from: '' }, { to: '' }, { from: 'v2' }, { to: 'v/2' }, { since: 0 },
        { since: -5 }, { since: 'now' }, { since: NaN }
    ];
    for (const change of invalid) {
        const storage = createFakeStorage();
        assert.equal(writeUpgradeIntent(intent(change), { storage }), false, JSON.stringify(change));
        assert.equal(storage.has(UPGRADE_INTENT_KEY), false);
    }
    assert.equal(writeUpgradeIntent(null, { storage: createFakeStorage() }), false);
    assert.equal(writeUpgradeIntent('x', { storage: createFakeStorage() }), false);
});

test('upgrade intent expires after 45 days, is network scoped and survives other readers', () => {
    const storage = createFakeStorage();
    writeUpgradeIntent(intent(), { storage });
    assert.equal(UPGRADE_INTENT_TTL_MS, 45 * 24 * 60 * 60 * 1000);
    assert.notEqual(readUpgradeIntent({ network: 'sepolia', storage, now: NOW + UPGRADE_INTENT_TTL_MS }), null);
    assert.equal(readUpgradeIntent({ network: 'sepolia', storage, now: NOW + UPGRADE_INTENT_TTL_MS + 1 }), null);
    // Another network's page does not see it, and does not delete it.
    assert.equal(readUpgradeIntent({ network: 'mainnet', storage, now: NOW }), null);
    assert.notEqual(readUpgradeIntent({ network: 'sepolia', storage, now: NOW }), null);
    // An expired one is left as it is: reading never writes.
    assert.equal(readUpgradeIntent({ network: 'sepolia', storage, now: NOW + UPGRADE_INTENT_TTL_MS * 2 }), null);
    assert.equal(storage.has(UPGRADE_INTENT_KEY), true);
    // Dated in the future beyond clock skew: not trusted.
    const future = createFakeStorage({ initial: { [UPGRADE_INTENT_KEY]: JSON.stringify(intent({ since: NOW + 24 * 60 * 60 * 1000 })) } });
    assert.equal(readUpgradeIntent({ network: 'sepolia', storage: future, now: NOW }), null);
});

test('a stored intent that does not validate reads as none', () => {
    for (const raw of ['{nope', '[]', '"x"', 'null', JSON.stringify({ ...intent(), stage: 'hacked' }),
        JSON.stringify({ ...intent(), from: 'v1', to: 'v1' }), JSON.stringify({ ...intent(), v: 3 })]) {
        const storage = createFakeStorage({ initial: { [UPGRADE_INTENT_KEY]: raw } });
        assert.equal(readUpgradeIntent({ network: 'sepolia', storage, now: NOW }), null, raw);
    }
    assert.equal(readUpgradeIntent({ network: undefined, storage: createFakeStorage(), now: NOW }), null);
});

test('upgrade intent storage failures are tolerated', () => {
    const readFails = createFakeStorage({ failReads: true });
    assert.equal(readUpgradeIntent({ network: 'sepolia', storage: readFails, now: NOW }), null);
    const writeFails = createFakeStorage({ failWrites: true });
    assert.equal(writeUpgradeIntent(intent(), { storage: writeFails }), false);
    assert.doesNotThrow(() => clearUpgradeIntent({ storage: writeFails }));
});

// ---------------------------------------------------------------- not synced

test('none of these keys can reach account sync or any other service module', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const keys = [SWITCH_HINT_KEY, SWITCH_LOG_KEY, UPGRADE_INTENT_KEY];
    const servicesDir = path.join(root, 'chat/services');
    const files = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(full);
        }
    };
    walk(servicesDir);
    assert.ok(files.some(file => file.endsWith('preferencesStore.js')), 'the preference store is scanned');
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        for (const key of keys) assert.equal(source.includes(key), false, `${key} in ${path.relative(root, file)}`);
    }
});
