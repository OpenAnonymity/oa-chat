// What the runtime facade does for a revision 3 (concession) SDK and for the
// other things a versioned page holds: the refusals an attempt was handed
// (waits, near expiry, a device that is not the newest, a paused service), the
// service check, the exit kit's saved flag, giving up an empty balance, the
// other versions' payment history, and the version UI helpers that compose
// them.
//
// The facade, the UI helpers, the state derivation, the adapters and the
// notice builder are the real ones. The SDK is a recorded fake whose snapshots
// and errors are the ones the real revision 3 SDK emitted
// (test/fixtures/zkapi-v2-real-shapes); the clock is that fixture's own frozen
// instant, so no test reads Date.now() against a committed instant.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createZkapiVersioning } from '../../chat/zkapi/versioning/index.js';
import { createVersionUi } from '../../chat/zkapi/versioning/ui.js';
import { chooseZkapiVersion } from '../../chat/zkapi/versioning/versionLoader.mjs';
import { installActiveVersion, resetActiveVersionForTests } from '../../chat/zkapi/versioning/activeVersion.mjs';
import { UPGRADE_INTENT_KEY } from '../../chat/zkapi/versioning/switchProtocol.mjs';
import { projectOtherHistory } from '../../chat/zkapi/versioning/otherVersionHistory.mjs';
import { explainZkapiError } from '../../chat/zkapi/services/zkapiErrorCopy.mjs';
import { buildVersionNotices } from '../../chat/zkapi/components/VersionNotices.js';
import { createDocument } from './_miniDom.mjs';
import { createFakeStorage } from './_fakeIndexedDb.mjs';
import { NOW_MS, activatedRegistry, mutated, resolvedTable, validRegistry } from './_registryFixtures.mjs';

const NETWORK = 'mainnet';
const FIXTURE = JSON.parse(fs.readFileSync(
    new URL('../fixtures/zkapi-v2-real-shapes/snapshots.json', import.meta.url), 'utf8'
));
const NOW = FIXTURE.generatedAtMs;
assert.equal(NOW, NOW_MS, 'the fixture clock is the registry fixtures clock');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW_SECONDS = Math.floor(NOW / 1000);
// v1 is the legacy family (exit-only, with a deposit target), v2 the
// concession family (the deposit target).
const TABLE = resolvedTable(activatedRegistry(), NETWORK);
const [V1, V2] = TABLE;
const SINGLE = resolvedTable(validRegistry(), NETWORK);
// The caller says the attempt acted on the balance in the wallet slot. An
// error carries no balance of its own, and a refusal given no such statement
// is only held for a minute.
const SLOT = Object.freeze({ slot: true });

// -- Fakes ---------------------------------------------------------------------

// ETH at $3000 with 8 feed decimals: $1.00 is 333,334 gwei (rounded up), so
// 200,000 gwei is $0.60 exactly.
const QUOTE = {
    asset: 'native_eth', units_per_eth: 1_000_000_000, chain_id: 1, feed_address: `0x${'ab'.repeat(20)}`,
    decimals: 8, round_id: '77', answer: '300000000000', updated_at: NOW_SECONDS - 100, expires_at: NOW_SECONDS + 4400
};

function sdkError(name) {
    const { name: errorName, status, code, data, message } = FIXTURE.errors[name];
    return Object.assign(new Error(message), { name: errorName, status, code, data: structuredClone(data) });
}

function fakeClient(version, { scenario = null, wallet, config = {}, quote = QUOTE, exportKit = true } = {}) {
    const real = scenario ? structuredClone(FIXTURE.scenarios[scenario]) : null;
    const listeners = new Set();
    const funding = { contract_address: version.vault, chain_id: version.chainId };
    const client = {
        initialized: true,
        lastError: null,
        isNativeEthFunding: true,
        config: real
            ? { ...real.clientSnapshot.config, funding: { ...real.clientSnapshot.config.funding, ...funding }, ...config }
            : { funding, request_charge_cap: 50_000, ...config },
        wallet: wallet !== undefined ? wallet : real ? real.clientSnapshot.wallet : null,
        withdrawals: real ? real.clientSnapshot.withdrawals : [],
        deposits: real ? real.clientSnapshot.deposits : [],
        activities: [],
        noteExpiryClaim: null,
        calls: { refresh: 0, exported: [] },
        get nativePriceQuote() { return quote; },
        get note() { return this.wallet?.note || null; },
        snapshot() {
            return { config: this.config, wallet: this.wallet, withdrawals: this.withdrawals,
                deposits: this.deposits, activities: this.activities };
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        emit() { for (const listener of [...listeners]) listener(this.snapshot(), { reason: 'update' }); },
        subscriberCount: () => listeners.size,
        // $3000 per ETH; 1,000,000 gwei is $3.00.
        formatMoney(units) { return `$${(Number(units) / 1e9 * 3000).toFixed(2)}`; },
        formatBillingAmount(units) { return String(Number(units) / 1e9); },
        async refresh() { this.calls.refresh += 1; }
    };
    if (exportKit) {
        client.exportExitKit = async function exportExitKit(passphrase) {
            client.calls.exported.push(passphrase);
            return '{"format":"zkapi-exit-kit-v1"}';
        };
    }
    return { client, real };
}

// The wallet status of a note, as the proof worker reports it.
const noteWallet = (balance, { noteId = 5, days = 20 } = {}) => ({
    has_note: true, pending_request: false,
    note: { note_id: noteId, current_balance: balance, expiry_ts: NOW_SECONDS + days * 86_400, deposit_amount: 5_000_000 }
});

function setup(t, {
    loaded = 'v2', table = TABLE, scenario = null, wallet, config, quote, exportKit, slot,
    attach = {}, facadeOptions = {}, now = NOW, network = NETWORK
} = {}) {
    resetActiveVersionForTests();
    const version = table.find(row => row.id === loaded);
    installActiveVersion({
        table, version,
        selection: chooseZkapiVersion({
            table, slotKind: 'note',
            holdings: [{ deploymentId: version.deploymentId, runtime: true, withdrawals: [], credits: [] }]
        })
    });
    const clock = { now };
    const timers = new Map();
    let timerId = 0;
    const session = createFakeStorage();
    const local = createFakeStorage();
    const facade = createZkapiVersioning({
        buildTable: table, network, now: () => clock.now, sessionStorage: session, localStorage: local,
        reload() {},
        setTimer: (callback, delay) => { timerId += 1; timers.set(timerId, { callback, delay }); return timerId; },
        clearTimer: id => timers.delete(id),
        ...facadeOptions
    });
    const { client, real } = fakeClient(version, { scenario, wallet, config, quote, exportKit });
    const service = { checks: 0, failure: null, hold: null };
    const runtime = {
        runtime: slot !== undefined ? slot : real ? real.runtime : null,
        manifest: { deployment_id: version.deploymentId },
        activeLease: null,
        config: { request_charge_cap: 50_000 },
        async assertServiceAvailable() {
            service.checks += 1;
            if (service.hold) await service.hold;
            if (service.failure) throw service.failure;
        }
    };
    facade.attach({ client, runtime, integrity: 'ok', ui: null, ...attach });
    t.after(() => { facade.resetForTests(); resetActiveVersionForTests(); });
    return { facade, client, runtime, service, clock, timers, session, local, version, table };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

// `promise`'s answer, or a failure after half a second: a facade that waited
// for something that never answers must fail a test, not hang it.
function answered(promise) {
    let timer;
    const limit = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('the facade is still waiting')), 500);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// -- What wakes the holdings watcher -----------------------------------------------

// The watcher re-reads the shared wallet database when the adapter's reading
// moved. A revision 3 reading carries facts that move with every settled chat
// (the exit kit's state sequence, a lock re-based onto the next state, the
// freshness and bound of a request in flight); the adapter names them, and
// the facade fingerprints what is left.
function wakeCounter(h) {
    let wakes = 0;
    h.facade.watch.onTrigger(() => { wakes += 1; });
    h.client.emit();
    wakes = 0;
    return () => wakes;
}

const exitOf = h => ({ ...h.client.config.exit });
const withExit = (h, change) => { h.client.config = { ...h.client.config, exit: change(exitOf(h)) }; };

test('settled chats, a request in flight and a re-based lock do not wake the holdings watcher', t => {
    const chats = setup(t, { scenario: 'kit_out_of_date' });
    const chatWakes = wakeCounter(chats);
    for (let chat = 0; chat < 5; chat += 1) {
        withExit(chats, exit => ({ ...exit, exit_kit: { ...exit.exit_kit, state_seq: exit.exit_kit.state_seq + 1 } }));
        chats.client.emit();
    }
    assert.equal(chatWakes(), 0, 'five settled chats');

    const flight = setup(t, { scenario: 'kit_out_of_date' });
    const flightWakes = wakeCounter(flight);
    const inFlight = FIXTURE.scenarios.unresolved_request_settlement_wait.clientSnapshot.config;
    flight.client.config = { ...flight.client.config, unresolved_requests: inFlight.unresolved_requests };
    withExit(flight, exit => ({ ...exit, state_fresh: false, bound_at_state: '1000000', escape_at: inFlight.exit.escape_at }));
    flight.client.emit();
    flight.client.config = { ...flight.client.config, unresolved_requests: [] };
    withExit(flight, exit => ({ ...exit, state_fresh: true, bound_at_state: '0', escape_at: null }));
    flight.client.emit();
    assert.equal(flightWakes(), 0, 'a request that starts and settles');

    const lock = setup(t, { scenario: 'mutual_lock_with_ownership_proof' });
    const lockWakes = wakeCounter(lock);
    withExit(lock, exit => ({ ...exit, lock: { ...exit.lock, since: exit.lock.since + 60_000 } }));
    lock.client.emit();
    assert.equal(lockWakes(), 0, 'a lock re-based onto the next state');
});

test('the facts a fresh load depends on still wake the holdings watcher, once per change', t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    const wakes = wakeCounter(h);
    let at = wakes();
    withExit(h, exit => ({ ...exit, exit_kit: { ...exit.exit_kit, exported_seq: exit.exit_kit.state_seq, out_of_date: false } }));
    h.client.emit();
    assert.equal(wakes() - at, 1, 'the exit kit is exported');
    at = wakes();
    h.client.config = { ...h.client.config, other_deployment_withdrawals: [
        { deployment_id: 'other', record_id: 'r-1', note_id: 3, mode: 'mutual', phase: 'parked' }] };
    h.client.emit();
    assert.equal(wakes() - at, 1, 'another deployment holds an unfinished withdrawal');
    at = wakes();
    h.client.emit();
    assert.equal(wakes() - at, 0, 'an event that changes nothing');
    h.client.wallet = { has_note: false, pending_request: false, note: null };
    h.runtime.runtime = null;
    h.client.emit();
    assert.equal(wakes() - at, 1, 'the slot note is gone');
});

test('an adapter with no narrowing is fingerprinted whole, as before', t => {
    // The legacy family has no per-chat facts.
    const h = setup(t, { loaded: 'v1', wallet: noteWallet(1_000_000, { days: 20 }) });
    const wakes = wakeCounter(h);
    h.client.emit();
    assert.equal(wakes(), 0);
    h.client.wallet = noteWallet(1_000_000, { days: 25 });
    h.client.emit();
    assert.equal(wakes(), 1, 'a changed expiry');
});

// -- Near expiry -----------------------------------------------------------------

test('wiring:near-expiry the send gate follows the SDK flag of a revision 3 balance, and only that', t => {
    const near = setup(t, { scenario: 'near_expiry' });
    assert.deepEqual(near.facade.sendGate(NOW), { canSend: false, code: 'near_expiry' });

    // One hour farther from the deadline the SDK says the balance is not near.
    const outside = setup(t, { scenario: 'just_outside_near_expiry' });
    assert.deepEqual(outside.facade.sendGate(NOW), { canSend: true, code: null });

    // A refusal an earlier attempt was handed is never a reason to refuse a
    // chat on its own: only the SDK's current flag is.
    outside.facade.noteRefusal(sdkError('note_near_expiry'), SLOT);
    assert.equal(outside.facade.state(NOW).exit.nearExpiry, true, 'the state tells the person');
    assert.deepEqual(outside.facade.sendGate(NOW), { canSend: true, code: null });

    // No note, no gate.
    const empty = setup(t, { scenario: 'near_expiry', wallet: { has_note: false, pending_request: false, note: null } });
    empty.client.config = { ...empty.client.config, exit: null };
    assert.deepEqual(empty.facade.sendGate(NOW), { canSend: true, code: null });
});

test('the legacy host cutoff is untouched by the SDK-flag rule', t => {
    const h = setup(t, { loaded: 'v1', wallet: noteWallet(1_000_000, { days: 0.1 }) });
    // 0.1 day = 8,640 s, inside the 23,700 s cutoff.
    assert.deepEqual(h.facade.sendGate(NOW), { canSend: false, code: 'near_expiry' });
    h.client.wallet = noteWallet(1_000_000, { days: 2 });
    assert.deepEqual(h.facade.sendGate(NOW), { canSend: true, code: null });
});

// -- The service check ---------------------------------------------------------

test('wiring:service-message a refusal the snapshot does not report pauses the service until it is checked', async t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    const heard = [];
    h.facade.subscribe(state => heard.push(state.phase));
    assert.equal(h.facade.state(NOW).service, null);

    h.facade.noteRefusal(sdkError('native_vault_unverified'));
    const paused = h.facade.state(NOW);
    assert.equal(paused.phase, 'service-paused');
    assert.equal(paused.service.code, 'native_vault_unverified');
    assert.deepEqual(heard, ['service-paused']);
    // Deposits stay as the SDK enforces them: the facade does not pre-block.
    assert.equal(paused.gate.canStart, true);

    const answer = await h.facade.recheckService();
    assert.deepEqual(answer, { ok: true });
    assert.equal(h.service.checks, 1);
    assert.equal(h.client.calls.refresh, 1, 'the client re-reads');
    assert.equal(h.facade.state(NOW).service, null);
    assert.equal(h.facade.state(NOW).phase, 'current');
    assert.deepEqual(heard, ['service-paused', 'current']);
});

test('a service that is still refused stays paused, with the cause of the newest refusal', async t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    h.facade.noteRefusal(sdkError('native_vault_unverified'));
    h.service.failure = sdkError('service_unavailable');
    assert.deepEqual(await h.facade.recheckService(), { ok: false, why: 'still_unavailable' });
    assert.equal(h.facade.state(NOW).service.code, 'deployment_manifest_unavailable');

    // An error that says nothing about the service leaves what was held.
    h.service.failure = new TypeError('fetch failed');
    assert.deepEqual(await h.facade.recheckService(), { ok: false, why: 'still_unavailable' });
    assert.equal(h.facade.state(NOW).service.code, 'deployment_manifest_unavailable');
});

test('the service check is unavailable where the runtime cannot be asked, busy during wallet work, and shared', async t => {
    // Not initialized, no method, no versions: the caller offers a reload.
    const cold = setup(t, { scenario: 'kit_out_of_date' });
    cold.client.initialized = false;
    assert.deepEqual(await cold.facade.recheckService(), { ok: false, why: 'unavailable' });
    assert.equal(cold.service.checks, 0);
    const plain = setup(t, { scenario: 'kit_out_of_date' });
    delete plain.runtime.assertServiceAvailable;
    assert.deepEqual(await plain.facade.recheckService(), { ok: false, why: 'unavailable' });
    const single = setup(t, { table: SINGLE, loaded: 'v1', scenario: null });
    assert.deepEqual(await single.facade.recheckService(), { ok: false, why: 'unavailable' });
    assert.equal(single.service.checks, 0);

    const busy = setup(t, { scenario: 'kit_out_of_date' });
    busy.client.activities = [{ id: 'a', status: 'running' }];
    assert.deepEqual(await busy.facade.recheckService(), { ok: false, why: 'busy' });
    assert.equal(busy.service.checks, 0);

    // Two clicks are one check.
    const shared = setup(t, { scenario: 'kit_out_of_date' });
    let release;
    shared.service.hold = new Promise(resolve => { release = resolve; });
    const first = shared.facade.recheckService();
    const second = shared.facade.recheckService();
    await settle();
    release();
    assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
    assert.equal(shared.service.checks, 1);
    // And afterwards a new one is a new check.
    shared.service.hold = null;
    await shared.facade.recheckService();
    assert.equal(shared.service.checks, 2);
});

test('a service check that never answers is a service that is still unavailable', async t => {
    const h = setup(t, { scenario: 'kit_out_of_date', facadeOptions: { limits: { serviceCheckMs: 20 } } });
    h.service.hold = new Promise(() => {});
    assert.deepEqual(await answered(h.facade.recheckService()), { ok: false, why: 'still_unavailable' });
    // The button is not stuck: the next press asks again.
    h.service.hold = null;
    assert.deepEqual(await answered(h.facade.recheckService()), { ok: true });
    assert.equal(h.service.checks, 2);
});

test('a check that finishes after the facade was attached again changes nothing', async t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    h.facade.noteRefusal(sdkError('native_vault_unverified'));
    let release;
    h.service.hold = new Promise(resolve => { release = resolve; });
    const pending = h.facade.recheckService();
    await settle();
    h.facade.attach({ client: h.client, runtime: h.runtime, integrity: 'ok' });
    h.facade.noteRefusal(sdkError('service_mismatch'));
    release();
    await pending;
    assert.equal(h.facade.state(NOW).service.code, 'deployment_manifest_mismatch', 'the new page keeps its own latch');
});

test('the service latch ends after five minutes and arms its own boundary', t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    h.facade.subscribe(() => {});
    h.facade.noteRefusal(sdkError('service_mismatch'));
    assert.equal(h.facade.state(NOW + 5 * MINUTE - 1).service.code, 'deployment_manifest_mismatch');
    const delays = [...h.timers.values()].map(timer => timer.delay);
    assert.ok(delays.includes(5 * MINUTE + 50), 'a timer is armed for the latch end');
    assert.equal(h.facade.state(NOW + 5 * MINUTE).service, null);
});

// -- Held refusals -------------------------------------------------------------

test('wiring:ownership-proof-wait a refused withdrawal is held as a wait with its own bound and time', t => {
    const h = setup(t, { scenario: 'unresolved_request_settlement_wait' });
    assert.equal(h.facade.state(NOW).exit.wait, null, 'the snapshot alone raises no wait notice');
    h.facade.noteRefusal(sdkError('request_settlement_pending_withdraw'), SLOT);
    const { exit } = h.facade.state(NOW);
    assert.equal(exit.wait.kind, 'settlement');
    assert.equal(exit.wait.untilMs, 1794766205000);
    assert.equal(exit.wait.escapeAtMs, 1794766205000);
    assert.equal(exit.wait.boundAtState, '1000000');
    assert.equal(exit.wait.mustInitiateByMs, 1795910400000);

    // It is a facade fact: a state read later, at a time inside the wait, has it.
    assert.equal(h.facade.state(NOW + 6 * HOUR).exit.wait.kind, 'settlement');
    // And it ends at the instant the SDK gave.
    assert.equal(h.facade.state(1794766205000 + 1).exit.wait, null);
});

test('the chat shape of a settlement refusal is not a withdrawal wait', t => {
    const h = setup(t, { scenario: 'unresolved_request_settlement_wait' });
    h.facade.noteRefusal(sdkError('request_settlement_pending_chat'), SLOT);
    assert.equal(h.facade.state(NOW).exit.wait, null);
});

test('wiring:ownership-proof-wait a wait that is only an ownership proof about to expire is short', t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    h.facade.noteRefusal(sdkError('ownership_proof_wait'), SLOT);
    const { exit } = h.facade.state(NOW);
    assert.equal(exit.wait.kind, 'proof');
    assert.equal(exit.wait.untilMs, NOW + 4000);
    assert.equal(h.facade.state(NOW + 5000).exit.wait, null);
});

test('a refusal that names no end is shown for a minute, a standing fact until the note changes', t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    // The real error's instant is hours in the past: no usable end.
    h.facade.noteRefusal(sdkError('exit_release_pending'), SLOT);
    assert.equal(h.facade.state(NOW).exit.wait.kind, 'release');
    assert.equal(h.facade.state(NOW).exit.wait.untilMs, null);
    assert.equal(h.facade.state(NOW + 59 * SECOND).exit.wait.kind, 'release');
    assert.equal(h.facade.state(NOW + 60 * SECOND).exit.wait, null);

    // Near expiry and a device that is not the newest are facts about the
    // balance: no time ends them.
    h.facade.noteRefusal(sdkError('note_near_expiry'), SLOT);
    h.facade.noteRefusal(sdkError('device_not_newest_defeated'), SLOT);
    const later = h.facade.state(NOW + 2 * HOUR);
    assert.equal(later.exit.nearExpiry, true);
    assert.equal(later.exit.deviceNotNewest, true);
    // Another note in the slot ends both.
    h.client.wallet = noteWallet(1_000_000, { noteId: 9 });
    const next = h.facade.state(NOW + 2 * HOUR);
    assert.equal(next.exit.nearExpiry, false);
    assert.equal(next.exit.deviceNotNewest, false);
});

test('a lock refusal with an end is a frozen balance until that instant', t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    h.facade.noteRefusal(sdkError('exit_locked'), SLOT);
    const { exit } = h.facade.state(NOW);
    assert.deepEqual(exit.frozen, { untilMs: 1794755700000, mode: null });
    assert.equal(h.facade.state(1794755700000 + 1).exit.frozen, null);
});

test('a wait that ran out is still told while the SDK reports a newer unresolved request, and then let go', t => {
    const h = setup(t, { scenario: 'unresolved_request_settlement_wait' });
    h.facade.noteRefusal(sdkError('request_settlement_pending_withdraw'), SLOT);
    const first = 1794766205000;
    const later = first + 2 * HOUR;
    assert.equal(h.facade.state(first + 10 * SECOND).exit.wait, null, 'the time the refusal gave has passed');
    // A chat sent after the refusal settles later than the one refused for,
    // and the snapshot says so a little after the first one ran out.
    withExit(h, exit => ({ ...exit, escape_at: later }));
    const during = h.facade.state(first + 30 * SECOND).exit.wait;
    assert.equal(during.kind, 'settlement');
    assert.equal(during.untilMs, later, 'the wait is as long as the newest request, never shorter');
    assert.equal(h.facade.state(later).exit.wait, null, 'and over at its instant');
    // A minute after that instant the refusal itself is forgotten: a request
    // that starts afterwards is not announced by an old refusal.
    assert.equal(h.facade.state(later + 61 * SECOND).exit.wait, null);
    withExit(h, exit => ({ ...exit, escape_at: later + 3 * HOUR }));
    assert.equal(h.facade.state(later + 62 * SECOND).exit.wait, null);
});

test('a settlement wait is dropped when the snapshot reports the request settled, and stays dropped', t => {
    const h = setup(t, { scenario: 'unresolved_request_settlement_wait' });
    const heard = [];
    h.facade.subscribe(state => heard.push(state.exit.wait?.kind ?? null));
    h.facade.noteRefusal(sdkError('request_settlement_pending_withdraw'), SLOT);
    assert.deepEqual(heard, ['settlement']);

    // The request settled: the SDK's snapshot is fresh again.
    h.client.config = {
        ...h.client.config, unresolved_requests: [],
        exit: { ...h.client.config.exit, state_fresh: true, bound_at_state: '0', escape_at: null }
    };
    h.client.emit();
    assert.equal(h.facade.state(NOW + MINUTE).exit.wait, null);
    assert.deepEqual(heard, ['settlement', null]);

    // A later request has its own time and bound, the snapshot's. The earlier
    // refusal does not come back to state them wrongly.
    h.client.config = {
        ...h.client.config,
        exit: { ...h.client.config.exit, state_fresh: false, bound_at_state: '2500000', escape_at: 1794770000000 }
    };
    h.client.emit();
    const again = h.facade.state(NOW + 2 * MINUTE).exit;
    assert.equal(again.wait, null);
    assert.equal(again.boundAtState, '2500000');
    assert.equal(again.escapeAtMs, 1794770000000);
});

test('a refusal that arrives before the snapshot has caught up is not dropped by that snapshot', t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    h.facade.noteRefusal(sdkError('request_settlement_pending_withdraw'), SLOT);
    // The snapshot still says fresh: the state ignores the wait meanwhile ...
    assert.equal(h.facade.state(NOW).exit.wait, null);
    // ... and shows it again when the snapshot catches up with the same request.
    h.client.config = {
        ...h.client.config,
        exit: { ...h.client.config.exit, state_fresh: false, bound_at_state: '1000000', escape_at: 1794766205000 }
    };
    assert.equal(h.facade.state(NOW + MINUTE).exit.wait.kind, 'settlement');
});

test('a refusal about another balance is never attached to the slot note', t => {
    const h = setup(t, {
        scenario: 'kit_out_of_date',
        wallet: noteWallet(1_000_000, { noteId: 7 })
    });
    h.client.withdrawals = [
        { recordId: 'r-slot', noteId: 7, deploymentId: V2.deploymentId, phase: 'parked', mode: 'mutual' },
        { recordId: 'r-other', noteId: 8, deploymentId: V2.deploymentId, phase: 'parked', mode: 'mutual' },
        { recordId: 'r-foreign', noteId: 7, deploymentId: 'some-other-deployment', phase: 'parked', mode: 'mutual' }
    ];
    const device = () => h.facade.state(NOW).exit.deviceNotNewest;
    const refuse = about => {
        h.facade.resetForTests();
        h.facade.attach({ client: h.client, runtime: h.runtime, integrity: 'ok' });
        h.facade.noteRefusal(sdkError('device_not_newest_defeated'), about);
        return device();
    };
    assert.equal(refuse(undefined), true, 'no named balance: told for the minute it is held');
    assert.equal(refuse({ slot: true }), true);
    assert.equal(refuse({ noteId: 7 }), true);
    assert.equal(refuse({ noteId: 8 }), false);
    assert.equal(refuse({ noteId: 'seven' }), false, 'a note that cannot be read is not the slot note');
    assert.equal(refuse({ recordId: 'r-slot' }), true, 'a record of the slot note');
    assert.equal(refuse({ recordId: 'r-other' }), false);
    assert.equal(refuse({ recordId: 'r-foreign' }), false, 'note numbers repeat across deployments');
    assert.equal(refuse({ recordId: 'r-unknown' }), false);
});

// An error carries no balance of its own. The same refusal comes back for the
// balance in the wallet slot and for a set-aside record that is finished or
// restored, so a refusal nobody tied to the slot note is only a guess.
test('a refusal that names no balance is held for a minute and never as a standing fact', t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    const heard = [];
    h.facade.subscribe(state => heard.push([state.exit.nearExpiry, state.exit.deviceNotNewest]));
    h.facade.noteRefusal(sdkError('note_near_expiry'));
    h.facade.noteRefusal(sdkError('device_not_newest_defeated'));
    const inside = h.facade.state(NOW + 59 * SECOND).exit;
    assert.equal(inside.nearExpiry, true);
    assert.equal(inside.deviceNotNewest, true);
    const after = h.facade.state(NOW + 60 * SECOND).exit;
    assert.equal(after.nearExpiry, false);
    assert.equal(after.deviceNotNewest, false);
    assert.equal(h.facade.state(NOW + 2 * HOUR).exit.deviceNotNewest, false);

    // The page says so at that instant, without another event.
    const delays = [...h.timers.values()].map(timer => timer.delay);
    assert.ok(delays.includes(60 * SECOND + 50), 'a timer is armed for the end of the hold');
    h.clock.now = NOW + 60 * SECOND + 100;
    [...h.timers.values()][0].callback();
    assert.deepEqual(heard.at(-1), [false, false]);
});

test('a statement that does not name the slot balance is no statement', t => {
    // Only `slot: true`, a note or a record that is the slot note says it.
    for (const about of [{}, { slot: false }, { slot: 'yes' }, { slot: 1 }, { noteId: null, recordId: '' }, []]) {
        const h = setup(t, { scenario: 'kit_out_of_date' });
        h.facade.noteRefusal(sdkError('device_not_newest_defeated'), about);
        assert.equal(h.facade.state(NOW + 30 * SECOND).exit.deviceNotNewest, true, JSON.stringify(about));
        assert.equal(h.facade.state(NOW + 2 * HOUR).exit.deviceNotNewest, false, JSON.stringify(about));
    }
});

test('a refusal that names no balance is not held longer because its own end is later', t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    h.facade.noteRefusal(sdkError('exit_locked'));
    assert.deepEqual(h.facade.state(NOW).exit.frozen, { untilMs: 1794755700000, mode: null });
    const settled = setup(t, { scenario: 'unresolved_request_settlement_wait' });
    settled.facade.noteRefusal(sdkError('request_settlement_pending_withdraw'));
    assert.equal(settled.facade.state(NOW).exit.wait.kind, 'settlement');
    for (const entry of [h, settled]) {
        const exit = entry.facade.state(NOW + 61 * SECOND).exit;
        assert.equal(exit.frozen, null);
        assert.equal(exit.wait, null);
    }
});

test('a refusal the caller tied to the slot balance stays until the note changes', t => {
    for (const about of [{ slot: true }, { noteId: 5 }]) {
        const h = setup(t, { scenario: 'kit_out_of_date', wallet: noteWallet(1_000_000, { noteId: 5 }) });
        h.facade.noteRefusal(sdkError('note_near_expiry'), about);
        h.facade.noteRefusal(sdkError('device_not_newest_defeated'), about);
        const later = h.facade.state(NOW + 2 * HOUR).exit;
        assert.equal(later.nearExpiry, true, JSON.stringify(about));
        assert.equal(later.deviceNotNewest, true, JSON.stringify(about));
    }
});

test('a guess neither shortens a standing fact about the balance nor outlasts its minute', t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    h.facade.noteRefusal(sdkError('device_not_newest_defeated'), SLOT);
    h.clock.now = NOW + 30 * SECOND;
    h.facade.noteRefusal(sdkError('device_not_newest_successor'));
    assert.equal(h.facade.state(NOW + 2 * HOUR).exit.deviceNotNewest, true, 'said of the slot note by an attempt on it');

    // The other way round, the attempt on the slot note makes it stand.
    const guess = setup(t, { scenario: 'kit_out_of_date' });
    guess.facade.noteRefusal(sdkError('note_near_expiry'));
    guess.clock.now = NOW + 10 * SECOND;
    guess.facade.noteRefusal(sdkError('note_near_expiry'), SLOT);
    assert.equal(guess.facade.state(NOW + 2 * HOUR).exit.nearExpiry, true);
});

test('a refusal of a set-aside record\'s action is not a fact about the live balance', t => {
    // Slot note 9 is healthy; a parked record of another note is flagged. The
    // dialog's catch path used to hand the refusal over with no balance named.
    const exit = FIXTURE.scenarios.kit_out_of_date.clientSnapshot.config.exit;
    const options = () => ({
        scenario: 'withdrawals_alert_credited_defeated', wallet: noteWallet(1_000_000, { noteId: 9 }), config: { exit }
    });
    const flagged = setup(t, options()).client.withdrawals.find(record => record.deviceNotNewest || record.challengeObserved);
    assert.ok(flagged, 'the scenario carries a flagged set-aside record');
    assert.notEqual(Number(flagged.noteId), 9);
    const context = facade => ({ facade, table: TABLE, active: V2, selection: facade.selection });

    // Told which record it was: nothing is attached to the live balance.
    const named = setup(t, options());
    explainZkapiError(sdkError('device_not_newest_defeated'), {
        ...context(named.facade), about: { recordId: flagged.recordId }
    });
    assert.equal(named.facade.state(NOW).exit.deviceNotNewest, false);
    assert.equal(named.facade.state(NOW + 2 * HOUR).exit.deviceNotNewest, false);

    // Told nothing: the facade guesses, and a guess ends by itself, so the
    // live balance is never called used elsewhere for the rest of the page.
    const unnamed = setup(t, options());
    const heard = [];
    unnamed.facade.subscribe(state => heard.push(state.exit.deviceNotNewest));
    explainZkapiError(sdkError('device_not_newest_defeated'), context(unnamed.facade));
    assert.equal(unnamed.facade.state(NOW + 59 * SECOND).exit.deviceNotNewest, true);
    unnamed.clock.now = NOW + 61 * SECOND;
    [...unnamed.timers.values()][0].callback();
    assert.equal(unnamed.facade.state(NOW + 61 * SECOND).exit.deviceNotNewest, false);
    assert.deepEqual(heard, [true, false]);
    assert.equal(unnamed.facade.state(NOW + 61 * SECOND).phase, named.facade.state(NOW).phase);
});

test('a page with one version holds nothing and tells nobody', t => {
    const h = setup(t, { table: SINGLE, loaded: 'v1', wallet: noteWallet(1_000_000) });
    let heard = 0;
    h.facade.subscribe(() => { heard += 1; });
    h.facade.noteRefusal(sdkError('native_vault_unverified'));
    h.facade.noteRefusal(sdkError('note_near_expiry'));
    h.facade.noteKitSaved(false);
    assert.equal(h.facade.state(NOW), null);
    assert.equal(heard, 0);
    assert.deepEqual(h.facade.sendGate(NOW), { canSend: true, code: null });
    // Nothing was held for a page that later becomes versioned either.
    assert.equal(h.facade.history, undefined);
});

test('with no balance in the slot a refusal has nothing to be about', t => {
    const h = setup(t, { scenario: 'withdrawals_alert_credited_defeated' });
    assert.equal(h.facade.state(NOW).exit, null);
    h.facade.noteRefusal(sdkError('device_not_newest_defeated'), SLOT);
    h.facade.noteRefusal(sdkError('request_settlement_pending_withdraw'), SLOT);
    assert.equal(h.facade.state(NOW).exit, null);
    // A note that appears later is not blamed for them.
    h.client.wallet = noteWallet(1_000_000, { noteId: 11 });
    h.client.config = { ...h.client.config, exit: FIXTURE.scenarios.kit_out_of_date.clientSnapshot.config.exit };
    const state = h.facade.state(NOW);
    assert.equal(state.exit.deviceNotNewest, false);
    assert.equal(state.exit.wait, null);
});

test('when several refusals are held a device that is not the newest is told first, then the waits', t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    h.facade.noteRefusal(sdkError('note_near_expiry'), SLOT);
    assert.equal(h.facade.state(NOW).exit.nearExpiry, true);
    h.facade.noteRefusal(sdkError('ownership_proof_wait'), SLOT);
    // The wait does not clobber near expiry: both are facts the state tells.
    const waiting = h.facade.state(NOW).exit;
    assert.equal(waiting.wait.kind, 'proof');
    assert.equal(waiting.nearExpiry, true, 'the snapshot flag would catch up, and the refusal said it first');
    h.facade.noteRefusal(sdkError('device_not_newest_successor'), SLOT);
    const device = h.facade.state(NOW).exit;
    assert.equal(device.deviceNotNewest, true);
});

test('refusals are read once per error object, from every producer, and never throw', t => {
    const h = setup(t, { scenario: 'unresolved_request_settlement_wait' });
    let heard = 0;
    h.facade.subscribe(() => { heard += 1; });
    const error = sdkError('request_settlement_pending_withdraw');
    h.facade.noteRefusal(error);
    h.facade.noteRefusal(error);
    h.facade.noteRefusal(error, { noteId: 99 });
    assert.equal(heard, 1);
    assert.equal(h.facade.state(NOW).exit.wait.kind, 'settlement', 'the second call with another note did not unset it');

    // Handing the same error over again later does not start its hold again
    // (a refusal with no end is shown for a minute from the first time).
    const later = setup(t, { scenario: 'kit_out_of_date' });
    const release = sdkError('exit_release_pending');
    const latched = sdkError('service_mismatch');
    later.facade.noteRefusal(release);
    later.facade.noteRefusal(latched);
    later.clock.now = NOW + 50 * SECOND;
    later.facade.noteRefusal(release);
    later.clock.now = NOW + 4 * MINUTE;
    later.facade.noteRefusal(latched);
    assert.equal(later.facade.state(NOW + 59 * SECOND).exit.wait.kind, 'release');
    assert.equal(later.facade.state(NOW + 61 * SECOND).exit.wait, null);
    assert.equal(later.facade.state(NOW + 5 * MINUTE + 1).service, null, 'the latch was not extended by the second reading');
    for (const value of [null, undefined, 'text', 7, {}, [], Object.create(null)]) {
        assert.doesNotThrow(() => h.facade.noteRefusal(value));
    }
    // An error with hostile getters is only an error that said nothing.
    const hostile = {};
    Object.defineProperty(hostile, 'code', { get() { throw new Error('boom'); } });
    assert.doesNotThrow(() => h.facade.noteRefusal(hostile));
    assert.equal(heard, 1);
});

test('the boundary of a wait and of a frozen balance is armed, and the page says so then', t => {
    const h = setup(t, { scenario: 'unresolved_request_settlement_wait' });
    const heard = [];
    h.facade.subscribe(state => heard.push(state.exit?.wait?.kind ?? null));
    h.facade.noteRefusal(sdkError('request_settlement_pending_withdraw'), SLOT);
    const delays = [...h.timers.values()].map(timer => timer.delay);
    assert.ok(delays.includes(1794766205000 - NOW + 50), 'the wait boundary');
    // The timer fires after the instant: the state moves without another event.
    h.clock.now = 1794766205000 + 100;
    const [timer] = [...h.timers.values()];
    timer.callback();
    assert.deepEqual(heard, ['settlement', null]);

    const frozen = setup(t, { scenario: 'escape_lock_released_proof' });
    frozen.facade.subscribe(() => {});
    assert.ok([...frozen.timers.values()].some(entry => entry.delay === 1794755700000 - NOW + 50),
        'the lock end the snapshot reports is a boundary too');
});

// -- Producers ---------------------------------------------------------------------

test('the dialog\'s error path hands the facade each refusal once, with the balance it was about', t => {
    const h = setup(t, { scenario: 'unresolved_request_settlement_wait' });
    const context = { facade: h.facade, table: TABLE, active: V2, selection: h.facade.selection };
    explainZkapiError(sdkError('device_not_newest_defeated'), { ...context, about: { noteId: 99 } });
    assert.equal(h.facade.state(NOW).exit.deviceNotNewest, false, 'about another balance');

    const error = sdkError('request_settlement_pending_withdraw');
    explainZkapiError(error, context);
    explainZkapiError(error, context);
    assert.equal(h.facade.state(NOW).exit.wait.kind, 'settlement');
    assert.match(error.message, /settling/, 'the words are rewritten as before');

    // A page with no versions is told nothing.
    const calls = [];
    const single = { noteRefusal: (...args) => calls.push(args) };
    explainZkapiError(sdkError('request_settlement_pending_withdraw'), {
        facade: single, table: SINGLE, active: SINGLE[0], selection: null
    });
    assert.deepEqual(calls, []);
});

test('the welcome panel\'s helper feeds the same facade and the same error is not counted twice', async t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    const ui = createVersionUi({ facade: h.facade });
    let heard = 0;
    h.facade.subscribe(() => { heard += 1; });
    const error = sdkError('service_unavailable');
    assert.match(ui.refusalMessage(error), /can’t be reached/);
    await settle();
    assert.equal(h.facade.state(NOW).service.code, 'deployment_manifest_unavailable');
    assert.equal(heard, 1);
    explainZkapiError(error, { facade: h.facade, table: TABLE, active: V2, selection: h.facade.selection });
    ui.refusalMessage(error);
    await settle();
    assert.equal(heard, 1);
    // A refusal about another balance is told as words, and not held for the slot note.
    const elsewhere = sdkError('device_not_newest_defeated');
    assert.match(ui.refusalMessage(elsewhere, { about: { noteId: 99 } }), /another device or copy/);
    await settle();
    assert.equal(h.facade.state(NOW).exit.deviceNotNewest, false);
    // One that names the slot balance stands, one that names nothing is a guess.
    const here = sdkError('device_not_newest_defeated');
    ui.refusalMessage(here, { about: { slot: true } });
    await settle();
    assert.equal(h.facade.state(NOW + 2 * HOUR).exit.deviceNotNewest, true);
    const guess = setup(t, { scenario: 'kit_out_of_date' });
    createVersionUi({ facade: guess.facade }).refusalMessage(sdkError('device_not_newest_defeated'));
    await settle();
    assert.equal(guess.facade.state(NOW).exit.deviceNotNewest, true);
    assert.equal(guess.facade.state(NOW + 2 * HOUR).exit.deviceNotNewest, false);
    // Anything else gets no words and no latch.
    assert.equal(ui.refusalMessage(new Error('insufficient funds')), null);
    assert.equal(ui.refusalMessage(null), null);
});

// The welcome panel asks for the words while it builds its markup, and it is
// subscribed to the facade and draws again when it hears a change. A render
// must not publish, or the panel is drawn inside its own draw.
test('the words are given inside a render and the facade is told after it, never during', async t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    const ui = createVersionUi({ facade: h.facade });
    let drawing = 0;
    let deepest = 0;
    const draws = [];
    // The panel: subscribed, and its draw asks for the words of the client's last error.
    const draw = () => {
        drawing += 1;
        deepest = Math.max(deepest, drawing);
        draws.push(ui.refusalMessage(lastError));
        drawing -= 1;
    };
    const lastError = sdkError('service_unavailable');
    h.facade.subscribe(draw);
    draw();
    assert.equal(draws.length, 1);
    assert.equal(h.facade.state(NOW).service, null, 'nothing was held while the panel was being drawn');
    await settle();
    assert.equal(h.facade.state(NOW).service.code, 'deployment_manifest_unavailable');
    assert.equal(draws.length, 2, 'the panel drew again once the facade was told');
    assert.equal(deepest, 1, 'and never inside its own draw');
    assert.match(draws[1], /can’t be reached/);
    // Drawing again is not a second refusal.
    draw();
    await settle();
    assert.equal(draws.length, 3);
});

// -- Exit kit ------------------------------------------------------------------------

test('legacy SDK export compatibility: the kit is created through the client, and a kit that was not saved is remembered for its balance', async t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    const heard = [];
    h.facade.subscribe(state => heard.push(state.exit.kit.unsaved));
    assert.equal(h.facade.canExportExitKit(), true);

    const text = await h.facade.exportExitKit('ABCDE-FGHJK-LMNPQ-RSTUV');
    assert.equal(text, '{"format":"zkapi-exit-kit-v1"}');
    assert.deepEqual(h.client.calls.exported, ['ABCDE-FGHJK-LMNPQ-RSTUV']);
    // The facade keeps neither the passphrase nor the text.
    const kept = JSON.stringify([h.facade.state(NOW), h.facade.flags()]);
    assert.doesNotMatch(kept, /ABCDE|zkapi-exit-kit-v1/);
    assert.equal(h.facade.state(NOW).exit.kit.unsaved, false, 'created is not unsaved: the dialog says what happened');

    h.facade.noteKitSaved(false);
    assert.equal(h.facade.state(NOW).exit.kit.unsaved, true);
    h.facade.noteKitSaved(false);
    assert.deepEqual(heard, [true], 'told once');
    h.facade.noteKitSaved(true);
    assert.equal(h.facade.state(NOW).exit.kit.unsaved, false);
    assert.deepEqual(heard, [true, false]);
    h.facade.noteKitSaved(true);
    assert.deepEqual(heard, [true, false]);
});

test('an unsaved kit is about one balance: another note in the slot does not inherit it', t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    h.facade.noteKitSaved(false);
    assert.equal(h.facade.state(NOW).exit.kit.unsaved, true);
    h.client.wallet = noteWallet(1_000_000, { noteId: 12 });
    assert.equal(h.facade.state(NOW).exit.kit.unsaved, false);
    // And with no balance there is no kit to be unsaved.
    h.client.wallet = { has_note: false, pending_request: false, note: null };
    h.facade.noteKitSaved(false);
    h.client.wallet = noteWallet(1_000_000, { noteId: 12 });
    assert.equal(h.facade.state(NOW).exit.kit.unsaved, false);
});

test('a client that cannot make a kit says so, and so does a page with no versions', async t => {
    const legacy = setup(t, { loaded: 'v1', exportKit: false, wallet: noteWallet(1_000_000) });
    assert.equal(legacy.facade.canExportExitKit(), false);
    await assert.rejects(legacy.facade.exportExitKit('x'), error => error.code === 'exit_kit_unavailable');
    const single = setup(t, { table: SINGLE, loaded: 'v1', scenario: null });
    single.client.exportExitKit = async () => 'kit';
    assert.equal(single.facade.canExportExitKit(), false);
    await assert.rejects(single.facade.exportExitKit('x'), error => error.code === 'exit_kit_unavailable');
});

// -- Money words ----------------------------------------------------------------------

test('amounts are said in the page\'s money, else ETH, else not at all', t => {
    const h = setup(t, { scenario: 'kit_out_of_date' });
    assert.equal(h.facade.formatAmount('1000000'), '$3.00');
    assert.equal(h.facade.formatAmount(1_000_000), '$3.00');
    // No price: the client says a dash, and the unit is ETH.
    h.client.formatMoney = () => '—';
    assert.equal(h.facade.formatAmount('1000000'), '0.001 ETH');
    h.client.formatMoney = () => '';
    assert.equal(h.facade.formatAmount('1000000'), '0.001 ETH');
    h.client.isNativeEthFunding = false;
    assert.equal(h.facade.formatAmount('1000000'), '', 'not an amount of ETH: nothing is guessed');
    h.client.formatMoney = () => { throw new Error('no price'); };
    assert.equal(h.facade.formatAmount('1000000'), '');
    assert.equal(h.facade.formatAmount(null), '');
    assert.equal(h.facade.formatAmount(undefined), '');
});

// -- The operation recheck is a revision 3 behavior -------------------------------------

test('wiring:withdrawal-operation-recheck only a versioned page of a family that lists it re-verifies', t => {
    assert.equal(setup(t, { loaded: 'v2', scenario: 'kit_out_of_date' }).facade.operationRecheckRequired(), true);
    assert.equal(setup(t, { loaded: 'v1', wallet: noteWallet(1) }).facade.operationRecheckRequired(), false);
    assert.equal(setup(t, { table: SINGLE, loaded: 'v1', wallet: noteWallet(1) }).facade.operationRecheckRequired(), false,
        'a page with one version has the request path it always had');
    const unattached = createZkapiVersioning({ buildTable: TABLE, network: NETWORK });
    resetActiveVersionForTests();
    assert.equal(unattached.operationRecheckRequired(), false);
});

// -- Giving up a balance -----------------------------------------------------------------

function abandonSetup(t, { balance = 0, abandonNote, registry = null, wallet, ...rest } = {}) {
    const calls = [];
    const answers = [];
    const note = abandonNote || (async args => {
        calls.push(args);
        return answers.length ? answers.shift() : { done: true, kind: balance === 0 ? 'zero' : 'dust' };
    });
    const table = registry ? resolvedTable(registry, NETWORK) : TABLE;
    const h = setup(t, {
        loaded: 'v1', table, wallet: wallet !== undefined ? wallet : noteWallet(balance),
        attach: { abandonNote: note }, ...rest
    });
    return { ...h, calls, answers };
}

test('an empty balance on a closed version is offered for clearing, with what the person will be shown', t => {
    const h = abandonSetup(t, { balance: 0 });
    const state = h.facade.state(NOW);
    assert.deepEqual(state.abandon, { available: true, kind: 'zero', blockedBy: null });
    assert.deepEqual(h.facade.abandonPreview(), {
        kind: 'zero', noteId: 5, balanceUnits: '0', limitUnits: null, balanceUsdMicros: 0, limitUsdMicros: null,
        expiryMs: (NOW_SECONDS + 20 * 86_400) * 1000, currentLabel: 'Version 1', targetLabel: 'Version 2'
    });
});

test('a very small balance is dust below the smaller of one chat key and the absolute ceiling', t => {
    const h = abandonSetup(t, { balance: 200_000 });
    assert.deepEqual(h.facade.state(NOW).abandon, { available: true, kind: 'dust', blockedBy: null });
    assert.deepEqual(h.facade.abandonPreview(), {
        kind: 'dust', noteId: 5, balanceUnits: '200000', limitUnits: '333334',
        balanceUsdMicros: 600_000, limitUsdMicros: 1_000_002,
        expiryMs: (NOW_SECONDS + 20 * 86_400) * 1000, currentLabel: 'Version 1', targetLabel: 'Version 2'
    });
    // At or above one chat key it is worth using or withdrawing.
    h.client.wallet = noteWallet(333_334);
    assert.deepEqual(h.facade.state(NOW).abandon, { available: false, kind: null, blockedBy: 'not_dust' });
    assert.equal(h.facade.abandonPreview(), null);
    // Without a price a balance that may pay for a chat is not guessed at:
    // only what is below the charge cap (no chat key can be issued for it)
    // is dust, and the rest asks for the price.
    const unpriced = abandonSetup(t, { balance: 40_000, quote: null });
    assert.deepEqual(unpriced.facade.state(NOW).abandon, { available: true, kind: 'dust', blockedBy: null });
    assert.deepEqual(unpriced.facade.abandonPreview(), {
        kind: 'dust', noteId: 5, balanceUnits: '40000', limitUnits: '50000', balanceUsdMicros: null, limitUsdMicros: null,
        expiryMs: (NOW_SECONDS + 20 * 86_400) * 1000, currentLabel: 'Version 1', targetLabel: 'Version 2'
    });
    unpriced.client.wallet = noteWallet(60_000);
    assert.deepEqual(unpriced.facade.state(NOW).abandon, { available: false, kind: null, blockedBy: 'price_unknown' });
});

test('the registry\'s numbers and kill switch bound what is offered', t => {
    const lower = abandonSetup(t, {
        balance: 200_000,
        registry: mutated(activatedRegistry(), registry => {
            registry.versions[0].transition.dustThresholdUsdMicros = 100_000;
        })
    });
    // $0.10 is 33,334 gwei but the charge cap (50,000) is the floor of the limit.
    assert.deepEqual(lower.facade.state(NOW).abandon, { available: false, kind: null, blockedBy: 'not_dust' });
    const off = abandonSetup(t, {
        balance: 0,
        registry: mutated(activatedRegistry(), registry => { registry.versions[0].transition.abandonEnabled = false; })
    });
    assert.deepEqual(off.facade.state(NOW).abandon, { available: false, kind: null, blockedBy: 'disabled' });
    assert.equal(off.facade.abandonPreview(), null);
});

test('the family that was not reviewed for it, and a page that cannot act, offer nothing', async t => {
    const concession = setup(t, {
        loaded: 'v2', scenario: 'kit_out_of_date', attach: { abandonNote: async () => ({ done: true, kind: 'zero' }) }
    });
    assert.equal(concession.facade.state(NOW).abandon.blockedBy, 'not_applicable');
    assert.equal(concession.facade.abandonPreview(), null);

    // Boot gave the facade nothing to act with: an action that could not run
    // is not shown.
    const noAction = setup(t, { loaded: 'v1', wallet: noteWallet(0) });
    assert.deepEqual(noAction.facade.state(NOW).abandon, { available: false, kind: null, blockedBy: 'not_applicable' });
    assert.deepEqual(await noAction.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: false, why: 'unavailable' });

    // A page with one version has no state at all.
    const calls = [];
    const single = setup(t, {
        table: SINGLE, loaded: 'v1', wallet: noteWallet(0), attach: { abandonNote: async args => { calls.push(args); return { done: true }; } }
    });
    assert.equal(single.facade.state(NOW), null);
    assert.equal(single.facade.abandonPreview(), null);
    assert.deepEqual(await single.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: false, why: 'unavailable' });
    assert.deepEqual(calls, []);
});

test('everything the strict check refuses on is a reason the offer is withdrawn', t => {
    const parked = { recordId: 'r', noteId: 9, phase: 'parked', mode: 'mutual', expiry: NOW + DAY, deploymentId: V1.deploymentId };
    const cases = [
        ['an unsettled request journal', h => { h.runtime.runtime = { state: { note_id: 5 }, journal: { id: 'j' } }; }, 'in_flight'],
        ['an unsettled chat key lease', h => { h.runtime.runtime = { state: { note_id: 5 }, lease: { id: 'l' } }; }, 'in_flight'],
        ['this tab\'s own key', h => { h.runtime.activeLease = { id: 'tab' }; }, 'in_flight'],
        ['a key the SDK reports', h => { h.client.config = { ...h.client.config, active_lease: { id: 'k' } }; }, 'in_flight'],
        ['a prepared withdrawal', h => { h.client.config = { ...h.client.config, prepared_withdrawal: { operationId: 'w' } }; }, 'open_withdrawal'],
        ['an open withdrawal record', h => { h.client.withdrawals = [parked]; }, 'open_withdrawal'],
        ['a started deposit', h => { h.client.config = { ...h.client.config, pending_deposit: { phase: 'submitted', amount: 5 } }; }, 'pending_deposit'],
        ['a treasury claim', h => { h.client.noteExpiryClaim = { transactionHash: '0x1' }; }, 'claimed'],
        ['no balance', h => { h.client.wallet = { has_note: false, pending_request: false, note: null }; }, 'no_note']
    ];
    for (const [name, mutate, expected] of cases) {
        const h = abandonSetup(t, { balance: 0 });
        assert.equal(h.facade.state(NOW).abandon.available, true, `${name}: offered before`);
        mutate(h);
        const { abandon } = h.facade.state(NOW);
        assert.deepEqual(abandon, { available: false, kind: null, blockedBy: expected }, name);
        assert.equal(h.facade.abandonPreview(), null, name);
    }
});

test('giving up is refused while work is in flight, for another balance, and twice', async t => {
    const h = abandonSetup(t, { balance: 200_000 });
    // Wallet work in flight: not asked.
    h.client.activities = [{ id: 'a', status: 'running' }];
    assert.deepEqual(await h.facade.giveUpBalance({ noteId: 5, balanceUnits: '200000' }), { done: false, why: 'busy' });
    h.client.activities = [];
    // The balance moved since the confirmation was shown.
    assert.deepEqual(await h.facade.giveUpBalance({ noteId: 5, balanceUnits: '199999' }), { done: false, why: 'changed' });
    assert.deepEqual(await h.facade.giveUpBalance({ noteId: 6, balanceUnits: '200000' }), { done: false, why: 'changed' });
    assert.deepEqual(await h.facade.giveUpBalance({}), { done: false, why: 'changed' });
    assert.deepEqual(h.calls, []);

    // A click while the first is still working is refused, and the page
    // counts as busy meanwhile (no reload in the middle of the write).
    const resolvers = [];
    const slow = abandonSetup(t, {
        balance: 200_000,
        abandonNote: () => new Promise(resolve => { resolvers.push(resolve); })
    });
    const first = slow.facade.giveUpBalance({ noteId: 5, balanceUnits: '200000' });
    await settle();
    // A second request that were started would never answer in this test, so
    // it is raced against a short wait: a refusal comes back at once.
    const waiting = Symbol('still working');
    const second = await Promise.race([
        slow.facade.giveUpBalance({ noteId: 5, balanceUnits: '200000' }),
        new Promise(resolve => setTimeout(() => resolve(waiting), 25))
    ]);
    assert.deepEqual(second, { done: false, why: 'busy' });
    assert.equal(resolvers.length, 1, 'the service was asked once');
    assert.equal(slow.facade.state(NOW).reload.canReload, false);
    resolvers[0]({ done: true, kind: 'dust' });
    assert.deepEqual(await first, { done: true, kind: 'dust' });
    assert.equal(slow.facade.state(NOW).reload.canReload, true);
});

test('giving up hands the service the shown note and balance and what the rows say about the limits', async t => {
    let holder = null;
    const h = abandonSetup(t, {
        balance: 200_000,
        registry: mutated(activatedRegistry(), registry => {
            registry.versions[0].transition.dustThresholdUsdMicros = 750_000;
        }),
        abandonNote: async args => {
            holder.calls.push(args);
            // What the service's archive does to the slot.
            holder.client.wallet = { has_note: false, pending_request: false, note: null };
            return { done: true, kind: 'dust' };
        }
    });
    holder = h;
    const heard = [];
    h.facade.subscribe(state => heard.push(state.abandon.blockedBy));
    let woken = 0;
    h.facade.watch.onTrigger(() => { woken += 1; });
    const done = await h.facade.giveUpBalance({ noteId: 5, balanceUnits: '200000' });
    assert.deepEqual(done, { done: true, kind: 'dust' });
    assert.deepEqual(h.calls, [{
        expectedNoteId: 5,
        expectedBalanceUnits: '200000',
        expectedDeploymentId: V1.deploymentId,
        supported: true,
        enabled: true,
        thresholdUsdMicros: 750_000,
        smallestTierUsdMicros: 1_000_000,
        ceilingUnits: 5_000_000
    }]);
    assert.equal(woken, 1, 'the holdings watcher re-reads the wallet once');
    assert.deepEqual(heard, ['no_note'], 'and the page hears that there is no balance to give up');
});

test('a give-up that is done forgets the upgrade, so no "Upgrade complete" is told', async t => {
    const h = abandonSetup(t, { balance: 0 });
    h.facade.beginUpgrade();
    h.facade.endUpgrade();
    const stored = JSON.parse(h.local.getItem(UPGRADE_INTENT_KEY));
    assert.deepEqual([stored.from, stored.to, stored.stage], ['v1', 'v2', 'withdrawing'], 'an upgrade was started from this balance');
    assert.deepEqual(await h.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: true, kind: 'zero' });
    assert.equal(h.local.getItem(UPGRADE_INTENT_KEY), null);
    assert.equal(h.facade.upgradeStage(), 'idle');
});

test('a refusal or a failure of the service is final for the click and is reported as it came', async t => {
    const h = abandonSetup(t, { balance: 0 });
    h.answers.push({ done: false, why: 'lock_busy' });
    assert.deepEqual(await h.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: false, why: 'lock_busy' });
    h.answers.push({ done: false });
    assert.deepEqual(await h.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: false, why: 'failed' });
    h.answers.push('nonsense');
    assert.deepEqual(await h.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: false, why: 'failed' });
    h.answers.push({ done: 'yes' });
    assert.deepEqual(await h.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: false, why: 'failed' });

    // A service that throws is a failure, and the facade can try again.
    const broken = abandonSetup(t, { balance: 0, abandonNote: async () => { throw new Error('chunk failed'); } });
    assert.deepEqual(await broken.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: false, why: 'failed' });
    assert.deepEqual(await broken.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: false, why: 'failed' });
    // The service's own kind is what is reported when it names one.
    const named = abandonSetup(t, { balance: 0, abandonNote: async () => ({ done: true, kind: 'dust' }) });
    assert.deepEqual(await named.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: true, kind: 'dust' });
});

test('a give-up that never answers is a failed give-up, finishes its follow-up when it does, and frees the page', async t => {
    let finish;
    const h = abandonSetup(t, {
        balance: 0,
        facadeOptions: { limits: { abandonMs: 30 } },
        abandonNote: () => new Promise(resolve => { finish = resolve; })
    });
    h.facade.beginUpgrade();
    h.facade.endUpgrade();
    let woken = 0;
    h.facade.watch.onTrigger(() => { woken += 1; });
    assert.deepEqual(await answered(h.facade.giveUpBalance({ noteId: 5, balanceUnits: '0' })), { done: false, why: 'failed' });
    assert.equal(h.facade.state(NOW).reload.canReload, true, 'the page is not busy for good');
    assert.equal(woken, 0);
    // The write did finish after all: the follow-up is the same as for one that
    // answered in time.
    finish({ done: true, kind: 'zero' });
    await settle();
    assert.equal(woken, 1);
    assert.equal(h.local.getItem(UPGRADE_INTENT_KEY), null);
});

test('the exact balance is never part of what subscribers are woken for', t => {
    const h = abandonSetup(t, { balance: 200_000 });
    let heard = 0;
    h.facade.subscribe(() => { heard += 1; });
    // Chats spend the balance; the verdict stays "dust".
    for (const balance of [190_000, 180_000, 150_000, 100_000]) {
        h.client.wallet = noteWallet(balance);
        h.client.emit();
    }
    assert.equal(heard, 0);
    // Crossing the line is a change.
    h.client.wallet = noteWallet(400_000);
    h.client.emit();
    assert.equal(heard, 1);
});

// -- The other versions' payment history ----------------------------------------------------

const row = (key, overrides = {}) => Object.freeze({
    key, scope: 'v1', kind: 'deposit', at: NOW - DAY, noteId: 3,
    version: { versionId: 'v1', label: 'Version 1', status: 'exit-only', chainId: 1, billing: null, sameUnitAsLoaded: true },
    amountUnits: '5000000', transactionHash: null, feeWei: null, expiryTs: NOW_SECONDS + 86_400, expiryState: 'none',
    ...overrides
});

function historySetup(t, { readHistory, ...rest } = {}) {
    const reads = [];
    const reader = readHistory || (async () => ({ rows: [row('v1:deposit:3')], truncated: false }));
    const h = setup(t, {
        scenario: 'kit_out_of_date',
        attach: { readHistory: () => { reads.push(1); return reader(); } },
        ...rest
    });
    return { ...h, reads };
}

test('a page with one version has no history member and never calls the reader', async t => {
    let calls = 0;
    const single = setup(t, {
        table: SINGLE, loaded: 'v1', wallet: noteWallet(1),
        attach: { readHistory: async () => { calls += 1; return { rows: [], truncated: false }; } }
    });
    assert.equal(single.facade.history, undefined);
    assert.deepEqual(createVersionUi({ facade: single.facade }).historyItems(), []);
    assert.equal(createVersionUi({ facade: single.facade }).historySignature(NOW), '');
    assert.equal(calls, 0);
});

test('history reads are shared, reused for ten seconds, and read again when the wallet moved', async t => {
    const h = historySetup(t);
    const { history } = h.facade;
    assert.equal(history.status(), 'idle');
    assert.deepEqual(history.rows(), []);

    const first = history.ensureFresh();
    const second = history.ensureFresh();
    assert.equal(history.status(), 'loading');
    await Promise.all([first, second]);
    assert.equal(h.reads.length, 1, 'two callers share one read');
    assert.equal(history.status(), 'ready');
    assert.equal(history.rows().length, 1);

    await history.ensureFresh();
    assert.equal(h.reads.length, 1, 'a recent read stands');
    h.clock.now = NOW + 9 * SECOND;
    await history.ensureFresh();
    assert.equal(h.reads.length, 1);
    h.clock.now = NOW + 10 * SECOND;
    await history.ensureFresh();
    assert.equal(h.reads.length, 2, 'ten seconds is stale');

    history.invalidate();
    await history.ensureFresh();
    assert.equal(h.reads.length, 3, 'invalidated');

    // The watcher's news that the wallet moved invalidates, and reads nothing itself.
    const before = h.reads.length;
    h.facade.watch.setPreview(chooseZkapiVersion({ table: TABLE, holdings: [] }));
    assert.equal(h.reads.length, before);
    await history.ensureFresh();
    assert.equal(h.reads.length, before + 1);
});

test('subscribers hear about history only when a read changed what is shown', async t => {
    const sets = [
        [row('v1:deposit:3')],
        [row('v1:deposit:3')],                                // the same rows, new objects
        [row('v1:deposit:3'), row('v1:withdrawal:3', { kind: 'withdrawal' })],
        []
    ];
    const h = historySetup(t, { readHistory: async () => ({ rows: sets.shift(), truncated: false }) });
    const states = [];
    h.facade.subscribe(state => states.push(JSON.stringify(state)));
    const { history } = h.facade;
    const read = async () => { history.invalidate(); await history.ensureFresh(); };
    await read();
    assert.equal(states.length, 1);
    await read();
    assert.equal(states.length, 1, 'an identical projection is not news');
    await read();
    assert.equal(states.length, 2);
    await read();
    assert.equal(states.length, 3);
    // The notification was the history's: the state itself did not move.
    assert.equal(new Set(states).size, 1);
});

test('a history read that never answers is an unreadable history, and the next one is a new read', async t => {
    let reads = 0;
    const h = historySetup(t, {
        facadeOptions: { limits: { historyMs: 20 } },
        readHistory: () => { reads += 1; return reads === 1 ? new Promise(() => {}) : Promise.resolve({ rows: [], truncated: false }); }
    });
    await answered(h.facade.history.ensureFresh());
    assert.equal(h.facade.history.status(), 'unreadable');
    h.clock.now += 11 * SECOND;
    await answered(h.facade.history.ensureFresh());
    assert.equal(h.facade.history.status(), 'ready');
});

test('a history that could not be read is unknown, never empty, and is tried again', async t => {
    const outcomes = [
        () => ({ rows: [row('v1:deposit:3')], truncated: false }),
        () => { throw Object.assign(new Error('timed out'), { code: 'history_timeout' }); },
        () => { throw Object.assign(new Error('unreadable'), { code: 'history_unreadable' }); },
        () => 'garbage',
        () => ({ rows: [], truncated: false })
    ];
    const h = historySetup(t, { readHistory: async () => outcomes.shift()() });
    const heard = [];
    h.facade.subscribe(() => heard.push(h.facade.history.status()));
    const { history } = h.facade;
    const next = async () => { h.clock.now += 11 * SECOND; await history.ensureFresh(); return history.status(); };

    assert.equal(await next(), 'ready');
    assert.equal(history.rows().length, 1);
    assert.equal(await next(), 'unreadable');
    assert.equal(history.rows().length, 1, 'the last good rows stay: nothing is invented');
    assert.equal(await next(), 'unreadable');
    assert.equal(await next(), 'unreadable', 'a result that is not a list of rows is unreadable');
    assert.equal(await next(), 'ready');
    assert.deepEqual(history.rows(), []);
    assert.deepEqual(heard, ['ready', 'unreadable', 'ready'], 'told when the outcome changed');
});

test('a reader that throws at once is an unreadable history', async t => {
    const h = historySetup(t, { readHistory: () => { throw new Error('no database'); } });
    await h.facade.history.ensureFresh();
    assert.equal(h.facade.history.status(), 'unreadable');
});

test('a read that finishes after the facade was reset or attached again is discarded', async t => {
    let release;
    const h = historySetup(t, {
        readHistory: () => new Promise(resolve => { release = () => resolve({ rows: [row('v1:deposit:3')], truncated: false }); })
    });
    const pending = h.facade.history.ensureFresh();
    await settle();
    h.facade.attach({ client: h.client, runtime: h.runtime, integrity: 'ok', readHistory: async () => ({ rows: [], truncated: false }) });
    assert.equal(h.facade.history.status(), 'idle');
    release();
    await pending;
    assert.deepEqual(h.facade.history.rows(), []);
    assert.equal(h.facade.history.status(), 'idle');
});

test('history is in the change signature through the UI helpers, and carries no time', async t => {
    const h = historySetup(t);
    const ui = createVersionUi({ facade: h.facade });
    h.facade.attachUi(ui);
    const before = h.facade.history.signature(NOW);
    await h.facade.history.ensureFresh();
    const after = h.facade.history.signature(NOW);
    assert.notEqual(before, after);
    assert.equal(h.facade.history.signature(NOW + 3 * HOUR), after, 'a clock tick alone changes nothing');
    assert.match(ui.historySignature(NOW), /^1:/);
});

// -- The version UI helpers ---------------------------------------------------------------------

function uiSetup(t, options) {
    const h = setup(t, options);
    const ui = createVersionUi({ facade: h.facade });
    h.facade.attachUi(ui);
    return { ...h, ui };
}

function mount(html) {
    const document = createDocument();
    const root = document.createElement('div');
    root.innerHTML = html;
    return root;
}

test('the balance extras never expose legacy SDK exit-kit state', t => {
    for (const exportKit of [false, true]) {
        const h = uiSetup(t, { scenario: 'kit_never_exported', exportKit });
        assert.equal(h.ui.balanceExtras(), '');
        h.facade.noteKitSaved(false);
        assert.equal(h.ui.balanceExtras(), '');
    }
});

test('the give-up link is a version action of the balance card', t => {
    const h = uiSetup(t, { loaded: 'v1', wallet: noteWallet(0), attach: { abandonNote: async () => ({ done: true, kind: 'zero' }) } });
    const root = mount(h.ui.balanceExtras());
    const link = root.querySelector('[data-zkapi-abandon-row] button');
    assert.equal(link.getAttribute('data-zkapi-version-action'), 'abandon-open');
});

test('wiring:ownership-proof-wait the withdraw view states the bound in the page\'s money and reads the choice back', t => {
    const h = uiSetup(t, { scenario: 'unresolved_request_settlement_wait' });
    const html = h.ui.exitChoice({ mode: 'mutual', now: NOW });
    const root = mount(html);
    const bound = root.querySelector('[data-zkapi-exit-bound]');
    assert.equal(bound.getAttribute('data-bound'), '1000000');
    // The bound is said in the page's money, with the ether figure beside it.
    assert.match(bound.textContent, /\$3\.00/);
    assert.match(bound.textContent, /0\.001 ETH/);

    // The default never gives anything up; the cap is the number that was shown.
    const defaults = h.ui.readExitChoice(root);
    assert.equal(defaults.choice, 'wait');
    assert.equal(defaults.conceded, null);
    assert.equal(defaults.concededMax, '1000000');
    assert.equal(defaults.bound, '1000000');
    assert.equal(defaults.changed, false);

    const radios = root.querySelectorAll('input[name="zkapi-withdraw-concede"]');
    const pick = value => radios.forEach(radio => { radio.checked = radio.value === value; });
    pick('bound');
    assert.deepEqual({ ...h.ui.readExitChoice(root) }, {
        choice: 'bound', mode: 'mutual', bound: '1000000', conceded: '1000000', concededMax: null, changed: false
    });
    pick('zero');
    assert.equal(h.ui.readExitChoice(root).conceded, '0');

    // A bound that grew since it was shown is not authorized.
    h.client.config = { ...h.client.config, exit: { ...h.client.config.exit, bound_at_state: '2000000' } };
    assert.equal(h.ui.readExitChoice(root).changed, true);
    // Nothing owed, nothing shown.
    const calm = uiSetup(t, { scenario: 'kit_out_of_date' });
    assert.equal(calm.ui.exitChoice({ now: NOW }), '');
    assert.deepEqual(createVersionUi({ facade: null }).readExitChoice(root), {
        choice: null, mode: null, bound: null, conceded: null, concededMax: null, changed: false
    });
});

test('the notices say a held wait with its bound in the page\'s money', t => {
    const h = uiSetup(t, { scenario: 'unresolved_request_settlement_wait' });
    h.facade.noteRefusal(sdkError('request_settlement_pending_withdraw'), SLOT);
    const html = h.ui.banner(h.facade.state(NOW), { surface: 'dialog', now: NOW });
    const root = mount(html);
    const wait = root.querySelector('[data-zkapi-version-notice="wait"]');
    assert.ok(wait, 'the wait is told in the dialog');
    assert.equal(h.ui.banner(h.facade.state(NOW), { surface: 'panel', now: NOW })
        .includes('data-zkapi-version-notice="wait"'), false, 'and only there');
    // The ticket surface carries none of the balance facts.
    assert.equal(h.ui.banner(h.facade.state(NOW), { surface: 'ticket', now: NOW }), '');
});

test('wiring:credited-payouts a record row gets what the helper says, in the page\'s money', t => {
    const h = uiSetup(t, { scenario: 'withdrawals_alert_credited_defeated' });
    const credited = h.client.withdrawals.find(record => record.payoutCredited === true && record.payoutClaimed !== true);
    const extras = h.ui.recordExtras(credited, {});
    assert.equal(extras.label, 'Payout held');
    assert.match(extras.actionsHtml, /data-claim-payout="/);
    assert.equal(extras.hideActions, false);
    // 800,000 gwei, in the page's money unless the caller brings its own.
    assert.match(extras.noteHtml, /\$2\.40/);
    const theirs = h.ui.recordExtras(credited, { formatMoney: () => 'SIX EUROS' });
    assert.match(theirs.noteHtml, /SIX EUROS/);

    const flagged = h.client.withdrawals.find(record => record.deviceNotNewest === true);
    const device = h.ui.recordExtras(flagged, {});
    assert.equal(device.hideActions, true);
    assert.match(device.noteHtml, /data-zkapi-record-device/);

    const alerted = h.client.withdrawals.find(record => record.payoutAlert === 'concession_exceeded_bound');
    assert.match(h.ui.recordExtras(alerted, {}).noteHtml, /data-zkapi-record-alert/);

    // The renderer needs no facade: a row's device state hides its buttons
    // whatever else is missing, and a plain record says nothing.
    const bare = createVersionUi({ facade: null });
    assert.equal(bare.recordExtras(flagged, {}).hideActions, true);
    assert.deepEqual({ ...bare.recordExtras({ recordId: 'r', phase: 'closed', noteId: 1 }, {}) }, {
        label: null, badge: null, noteHtml: '', actionsHtml: '', hideActions: false, hideError: false
    });
});

test('other versions\' rows are text: no action of this version\'s dialog is reachable from them', async t => {
    const raw = {
        deposits: [{
            recordId: 'x', deploymentId: V1.deploymentId, noteId: 3, amount: 5_000_000, expiryTs: NOW_SECONDS + 3 * 86_400,
            status: 'confirmed', createdAt: NOW - 5 * DAY, confirmedAt: NOW - 5 * DAY + 1000
        }],
        withdrawals: [{
            recordId: 'w', deploymentId: V1.deploymentId, noteId: 4, mode: 'mutual', phase: 'parked', chainId: 1,
            finalBalance: 1_000_000, createdAt: NOW - 2 * DAY, updatedAt: NOW - DAY,
            state: { secret_s: 'SECRET-HISTORY-MARKER' }
        }]
    };
    const projected = projectOtherHistory(raw, { table: TABLE, loadedDeploymentId: V2.deploymentId, nowMs: NOW });
    const h = uiSetup(t, {
        scenario: 'kit_out_of_date',
        attach: { readHistory: async () => projected }
    });
    assert.deepEqual(h.ui.historyItems(), [], 'nothing is read until asked for');
    await h.facade.history.ensureFresh();
    const items = h.ui.historyItems({ now: NOW, dateText: ms => `at ${ms}`, txUrl: () => null });
    assert.equal(items.length, 2);
    const html = items.map(item => item.html).join('');
    assert.doesNotMatch(html, /SECRET-HISTORY-MARKER/);
    for (const hook of ['data-sync-withdrawal', 'data-finalize-withdrawal', 'data-withdraw-background', 'data-restore-withdrawal',
        'data-retry-', 'data-cancel-background-preparation', 'data-view-current-deposit', 'data-claim-payout']) {
        assert.equal(html.includes(hook), false, hook);
    }
    assert.match(html, /data-other-version-record="v1:withdrawal:4"/);
    assert.ok(items.every(item => Number.isFinite(item.at)));
    assert.match(html, /Unfinished in version 1/);
    // In the page's money (0.005 ETH at $3000 a coin), unless the caller
    // brings its own.
    assert.match(html, /\+\$15\.00 added to private balance/);
    const theirs = h.ui.historyItems({ now: NOW, formatMoney: () => '15 FAKE' }).map(item => item.html).join('');
    assert.match(theirs, /\+15 FAKE added to private balance/);
    // This version's own balance holds the wallet, so the other version
    // cannot be opened yet, and the row says why instead of offering a button.
    assert.match(html, /First withdraw or finish the balance on this version, then open version 1\./);
    assert.doesNotMatch(html, /data-zkapi-history-open/);
});

test('without a time of its own the deadline rows are drawn at the clock\'s, which is what the signature counts', async t => {
    const deposit = row('v1:deposit:3', { expiryState: 'open', expiryTs: NOW_SECONDS + 3600 });
    const h = uiSetup(t, {
        scenario: 'kit_out_of_date',
        attach: { readHistory: async () => ({ rows: [deposit], truncated: false }) }
    });
    await h.facade.history.ensureFresh();
    const said = items => items.map(item => item.html).join('');
    const later = NOW + 2 * HOUR;
    assert.doesNotMatch(said(h.ui.historyItems({ now: NOW })), /Expiry deadline passed/);
    assert.match(said(h.ui.historyItems({ now: later })), /Expiry deadline passed/);
    assert.notEqual(h.ui.historySignature(later), h.ui.historySignature(NOW), 'the crossing is a change');

    // A caller that leaves the time out is drawn at the clock's: the same
    // rows the signature already counted, not a list that never changes.
    t.mock.timers.enable({ apis: ['Date'], now: later });
    assert.match(said(h.ui.historyItems()), /Expiry deadline passed/);
    assert.match(said(h.ui.historyItems({ now: Number.NaN })), /Expiry deadline passed/);
    assert.match(said(h.ui.historyItems({})), /Expiry deadline passed/);
    assert.equal(h.ui.historySignature(), h.ui.historySignature(later));
    assert.equal(h.ui.historySignature(Number.NaN), h.ui.historySignature(later));
    // A time the caller gives still wins.
    assert.doesNotMatch(said(h.ui.historyItems({ now: NOW })), /Expiry deadline passed/);
});

test('the way into the other version is a button only when the state says it can be opened', async t => {
    const raw = {
        deposits: [],
        withdrawals: [{
            recordId: 'w', deploymentId: V1.deploymentId, noteId: 4, mode: 'mutual', phase: 'parked', chainId: 1,
            finalBalance: 1_000_000, createdAt: NOW - 2 * DAY, updatedAt: NOW - DAY
        }]
    };
    const projected = projectOtherHistory(raw, { table: TABLE, loadedDeploymentId: V2.deploymentId, nowMs: NOW });
    // No balance here: the wallet is free.
    const h = uiSetup(t, {
        wallet: null, slot: null, attach: { readHistory: async () => projected }
    });
    h.facade.watch.setPreview({
        ...chooseZkapiVersion({ table: TABLE, holdings: [] }),
        open: { v1: [{ recordId: 'w', noteId: 4, mode: 'mutual', phase: 'parked', expiryTs: NOW_SECONDS + 3 * 86_400 }] }
    });
    await h.facade.history.ensureFresh();
    assert.equal(h.facade.state(NOW).previous.canOpen, true);
    const html = h.ui.historyItems({ now: NOW }).map(item => item.html).join('');
    const button = mount(html).querySelector('[data-zkapi-history-open]');
    assert.equal(button.getAttribute('data-zkapi-history-open'), 'v1');
    assert.equal(button.getAttribute('data-zkapi-history-reason'), 'finish_previous');
    assert.equal(button.getAttribute('data-sync-withdrawal'), null);
    assert.doesNotMatch(html, /First withdraw or finish/);
});

test('the history helpers are inert without a facade or history', () => {
    const ui = createVersionUi({ facade: null });
    assert.deepEqual(ui.historyItems({}), []);
    assert.equal(ui.historySignature(NOW), '');
    const hollow = createVersionUi({ facade: { history: null } });
    assert.deepEqual(hollow.historyItems(), []);
    assert.equal(hollow.historySignature(NOW), '');
    const hostile = createVersionUi({ facade: { get history() { throw new Error('x'); } } });
    assert.deepEqual(hostile.historyItems(), []);
});

// -- Reset ----------------------------------------------------------------------------------------

test('resetForTests forgets every refusal, latch, flag, read and verdict the facade held', async t => {
    const h = historySetup(t);
    h.facade.noteRefusal(sdkError('native_vault_unverified'));
    h.facade.noteRefusal(sdkError('request_settlement_pending_withdraw'));
    h.facade.noteKitSaved(false);
    await h.facade.history.ensureFresh();
    assert.ok(h.facade.state(NOW).service);
    assert.equal(h.facade.history.rows().length, 1);

    h.facade.resetForTests();
    assert.equal(h.facade.state(NOW)?.service ?? null, null, 'reset alone forgets the latch');
    assert.equal(h.facade.history.status(), 'idle');
    assert.deepEqual(h.facade.history.rows(), []);
    // Attached again with the same client, as a fresh page would be.
    h.facade.attach({ client: h.client, runtime: h.runtime, integrity: 'ok' });
    const state = h.facade.state(NOW);
    assert.equal(state.service, null);
    assert.equal(state.exit.wait, null);
    assert.equal(state.exit.kit.unsaved, false);
    assert.equal(h.facade.history.status(), 'idle');
    assert.deepEqual(h.facade.history.rows(), []);
    // The same error objects are read again on a fresh page.
    h.facade.noteRefusal(sdkError('native_vault_unverified'));
    assert.equal(h.facade.state(NOW).service.code, 'native_vault_unverified');
});

// -- The fixture pipeline ---------------------------------------------------------------------------

// Whole snapshots the revision 3 SDK emitted, through the real facade, state
// derivation and notice builder: what the dialog would say for each situation.
const NOTICE_IDS = {
    service_missing: ['service'],
    service_changed: ['service'],
    service_legacy: ['service'],
    kit_never_exported: [],
    kit_out_of_date: [],
    near_expiry: ['near'],
    just_outside_near_expiry: [],
    unresolved_request_settlement_wait: [],
    mutual_lock_with_ownership_proof: ['frozen'],
    escape_lock_released_proof: ['frozen'],
    device_not_newest_evidence: ['device'],
    withdrawals_alert_credited_defeated: ['device', 'payout', 'claim', 'setaside'],
    other_deployments: ['previous']
};
const PHASES = {
    service_missing: 'service-paused',
    service_changed: 'service-paused',
    service_legacy: 'service-paused',
    escape_lock_released_proof: 'withdrawing',
    other_deployments: 'finish-previous-withdrawal'
};

for (const name of Object.keys(NOTICE_IDS)) {
    test(`pipeline: ${name} reads as the dialog should say it`, t => {
        const h = setup(t, { scenario: name });
        const state = h.facade.state(NOW);
        assert.equal(state.phase, PHASES[name] || 'current');
        const { notices } = buildVersionNotices(state, {
            surface: 'dialog', now: NOW, table: TABLE, formatAmount: units => h.facade.formatAmount(units)
        });
        assert.deepEqual(notices.map(notice => notice.id), NOTICE_IDS[name]);
        const text = notices.map(notice => notice.paragraphs.map(paragraph => paragraph.text).join(' ')).join('\n');
        // What the SDK said in its own words (an operator URL, an engineer's
        // sentence) never reaches the person.
        assert.doesNotMatch(text, /deployment manifest|Unable to load|https?:\/\//i);
        assert.doesNotMatch(JSON.stringify(state), /SECRET-/, 'no private field reaches the state');
        // The ticket surface carries none of the balance's facts.
        const ticket = buildVersionNotices(state, { surface: 'ticket', now: NOW, table: TABLE });
        assert.deepEqual(ticket.notices.map(notice => notice.id).filter(id => id !== 'previous'), []);
    });
}

test('wiring:payout-alert a payout under the disclosed bound is a standing note on its row and a notice that can be dismissed', t => {
    const h = uiSetup(t, { scenario: 'withdrawals_alert_credited_defeated' });
    const state = h.facade.state(NOW);
    assert.equal(state.payouts.alerts, 1);
    const { notices } = buildVersionNotices(state, { surface: 'dialog', now: NOW, table: TABLE });
    const payout = notices.find(notice => notice.id === 'payout');
    assert.deepEqual(payout.actions.map(action => action.action), ['open-payments', 'dismiss']);
    // The row keeps the note and the badge whatever happens to the notice.
    const record = h.client.withdrawals.find(entry => entry.payoutAlert === 'concession_exceeded_bound');
    const extras = h.ui.recordExtras(record, {});
    assert.equal(extras.badge, 'Paid less than expected');
    assert.match(extras.noteHtml, /data-zkapi-record-alert/);
    assert.equal(extras.hideActions, false, 'a payment is not a reason to hide anything');
});

test('wiring:device-not-newest a balance another device used is explained, and is not a withdrawal in motion', t => {
    // A set-aside balance flagged by the SDK: the row says so and carries no
    // button, and the page does not read as "withdrawing" because of it.
    const set = uiSetup(t, { scenario: 'withdrawals_alert_credited_defeated' });
    const flagged = set.client.withdrawals.find(entry => entry.deviceNotNewest === true);
    assert.equal(set.ui.recordExtras(flagged, {}).hideActions, true);
    const state = set.facade.state(NOW);
    assert.equal(state.setAside.device, 1);
    assert.notEqual(state.phase, 'withdrawing');
    const { notices } = buildVersionNotices(state, { surface: 'dialog', now: NOW, table: TABLE });
    assert.deepEqual(notices.find(notice => notice.id === 'device').actions.map(action => action.action), ['open-payments']);

    // The slot balance: one explanation, and no button that would be rejected
    // after costing a network fee.
    const slot = setup(t, { scenario: 'device_not_newest_evidence' });
    const told = buildVersionNotices(slot.facade.state(NOW), { surface: 'dialog', now: NOW, table: TABLE });
    const device = told.notices.find(notice => notice.id === 'device');
    assert.deepEqual(device.actions, []);
    assert.equal(told.notices.some(notice => ['near', 'wait', 'frozen', 'kit'].includes(notice.id)), false);
    // And the SDK's refusal at the attempt says the same thing, held the same way.
    const attempt = setup(t, { scenario: 'kit_out_of_date' });
    attempt.facade.noteRefusal(sdkError('device_not_newest_successor'), SLOT);
    assert.equal(attempt.facade.state(NOW).exit.deviceNotNewest, true);
});

test('wiring:other-deployment-withdrawals another deployment\'s unfinished withdrawal holds new deposits', t => {
    const h = setup(t, { scenario: 'other_deployments' });
    assert.deepEqual(h.facade.depositGate(), {
        canStart: false, canResume: false, code: 'previous_withdrawal_open', successor: null
    });
    const state = h.facade.state(NOW);
    assert.equal(state.phase, 'finish-previous-withdrawal');
    assert.equal(state.previous.versionId, 'v1');
    assert.equal(state.previous.openWithdrawals, 2);
});

test('pipeline: the facts of each scenario are the state\'s, in milliseconds', t => {
    const near = setup(t, { scenario: 'near_expiry' }).facade.state(NOW);
    assert.equal(near.exit.mustInitiateByMs, 1794770345000);
    const lock = setup(t, { scenario: 'escape_lock_released_proof' }).facade.state(NOW);
    assert.deepEqual(lock.exit.frozen, { untilMs: 1794755700000, mode: 'escape' });
    const credits = setup(t, { scenario: 'withdrawals_alert_credited_defeated' }).facade.state(NOW);
    assert.deepEqual(credits.payouts, { credited: 2, alerts: 1 });
    assert.deepEqual(credits.setAside, { near: 1, earliestMustInitiateByMs: 1795003200000, device: 1 });
    const other = setup(t, { scenario: 'other_deployments' }).facade.state(NOW);
    assert.equal(other.previous.versionId, 'v1');
    assert.equal(other.previous.openWithdrawals, 2);
});

test('pipeline: a settling chat is a wait only once a withdrawal was refused for it', t => {
    const h = setup(t, { scenario: 'unresolved_request_settlement_wait' });
    const quiet = buildVersionNotices(h.facade.state(NOW), { surface: 'dialog', now: NOW, table: TABLE });
    assert.equal(quiet.notices.some(notice => notice.id === 'wait'), false);
    h.facade.noteRefusal(sdkError('request_settlement_pending_withdraw'), SLOT);
    const told = buildVersionNotices(h.facade.state(NOW), {
        surface: 'dialog', now: NOW, table: TABLE, formatAmount: units => h.facade.formatAmount(units)
    });
    const wait = told.notices.find(notice => notice.id === 'wait');
    assert.ok(wait);
    const text = wait.paragraphs.map(paragraph => paragraph.text).join(' ');
    assert.match(text, /settling/);
});
