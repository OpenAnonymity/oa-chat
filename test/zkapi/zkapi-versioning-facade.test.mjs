// The runtime facade (chat/zkapi/versioning/index.js): gates, state,
// subscriptions, the switch request, the upgrade intent and the small session
// facts. The SDK is a recorded fake; the version table, adapters and state
// derivation are the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZkapiVersioning, isVersioningActive, REMINDER_KEY } from '../../chat/zkapi/versioning/index.js';
import { chooseZkapiVersion } from '../../chat/zkapi/versioning/versionLoader.mjs';
import { installActiveVersion, resetActiveVersionForTests } from '../../chat/zkapi/versioning/activeVersion.mjs';
import { SWITCH_HINT_KEY, SWITCH_LOG_KEY, UPGRADE_INTENT_KEY } from '../../chat/zkapi/versioning/switchProtocol.mjs';
import { createFakeStorage } from './_fakeIndexedDb.mjs';
import {
    activatedRegistry, mutated, partialRevertRegistry, resolvedTable, stuckEscapeNotice, validRegistry
} from './_registryFixtures.mjs';

const NETWORK = 'sepolia';
const NOW = Date.parse('2026-11-15T12:00:00Z');
const DAY = 86_400_000;
const TABLE = resolvedTable(activatedRegistry(), NETWORK);
const [V1, V2] = TABLE;
const expirySeconds = days => Math.floor((NOW + days * DAY) / 1000);

function fakeClient(version) {
    const listeners = new Set();
    return {
        initialized: false, lastError: null,
        config: { funding: { contract_address: version.vault, chain_id: version.chainId } },
        wallet: null, withdrawals: [], deposits: [], activities: [], noteExpiryClaim: null,
        snapshot() {
            return { config: this.config, wallet: this.wallet, withdrawals: this.withdrawals,
                deposits: this.deposits, activities: this.activities };
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        emit(reason = 'update') { for (const listener of [...listeners]) listener(this.snapshot(), { reason }); },
        subscriberCount: () => listeners.size
    };
}

const noteOf = days => ({ has_note: true, note: { note_id: 5, expiry_ts: expirySeconds(days) } });

function setup(t, { loaded = 'v2', selection, table = TABLE, clock = { now: NOW }, facadeOptions = {} } = {}) {
    resetActiveVersionForTests();
    const version = table.find(row => row.id === loaded);
    const chosen = selection || chooseZkapiVersion({
        table,
        holdings: [{ deploymentId: version.deploymentId, runtime: true, withdrawals: [], credits: [] }],
        slotKind: 'note'
    });
    installActiveVersion({ table, version, selection: chosen });
    const session = createFakeStorage();
    const local = createFakeStorage();
    const reloads = [];
    const timers = new Map();
    let timerId = 0;
    const facade = createZkapiVersioning({
        buildTable: table, network: NETWORK, now: () => clock.now, sessionStorage: session, localStorage: local,
        reload: () => reloads.push(clock.now),
        setTimer: (callback, delay) => { timerId += 1; timers.set(timerId, { callback, delay }); return timerId; },
        clearTimer: id => timers.delete(id),
        ...facadeOptions
    });
    const client = fakeClient(version);
    const runtime = { runtime: null, manifest: { deployment_id: version.deploymentId } };
    facade.attach({ client, runtime, integrity: 'ok', ui: { marker: 'ui' } });
    t.after(() => { facade.resetForTests(); resetActiveVersionForTests(); });
    return { facade, client, runtime, session, local, reloads, timers, clock, version, table };
}

// ------------------------------------------------------------------- gates

test('the deposit target is open and the exit-only version is closed with its successor', t => {
    const target = setup(t, { loaded: 'v2' });
    assert.deepEqual(target.facade.depositGate(), { canStart: true, canResume: false, code: null, successor: null });
    const closed = setup(t, { loaded: 'v1' });
    assert.deepEqual(closed.facade.depositGate(), {
        canStart: false, canResume: false, code: 'deposits_closed', successor: { id: 'v2', label: 'Version 2' }
    });
});

test('canResume mirrors a STARTED pending deposit and never an unsent plan', t => {
    const h = setup(t, { loaded: 'v1' });
    h.client.config = { ...h.client.config, pending_deposit: { phase: 'submitted', transaction_hash: `0x${'11'.repeat(32)}`, amount: 5 } };
    assert.equal(h.facade.depositGate().canResume, true);
    h.client.config = { ...h.client.config, pending_deposit: { phase: 'prepared', amount: 5 } };
    assert.equal(h.facade.depositGate().canResume, false, 'a prepared plan with no claim was never sent');
    h.client.config = { ...h.client.config, pending_deposit: null };
    assert.equal(h.facade.depositGate().canResume, false);
});

test('the in-memory slot makes a prepared plan with a claim a started deposit', t => {
    const h = setup(t, { loaded: 'v1' });
    h.client.config = { ...h.client.config, pending_deposit: { phase: 'prepared', amount: 5 } };
    h.runtime.runtime = { pendingDeposit: { operationId: 'o', phase: 'prepared', amount: 5, submissionId: 'claim' } };
    assert.equal(h.facade.depositGate().canResume, true);
});

test('the gate is derived from what this tab and the preview know', t => {
    const h = setup(t, { loaded: 'v2' });
    // Another tab started an escape on the closed version: deposits wait.
    h.facade.watch.setPreview({
        ...chooseZkapiVersion({ table: TABLE, holdings: [] }),
        open: { v1: [{ recordId: 'r', noteId: 7, mode: 'escape', phase: 'pending', expiryTs: expirySeconds(3) }] }
    });
    const gate = h.facade.depositGate();
    assert.equal(gate.canStart, false);
    assert.equal(gate.code, 'previous_withdrawal_open');
});

test('a tab told its balance moved in another tab takes no new deposit until it reloads', t => {
    const h = setup(t, { loaded: 'v2' });
    assert.equal(h.facade.depositGate().canStart, true);
    // A fresh read finds a note held by the closed version: another tab moved it.
    h.facade.watch.setPreview(chooseZkapiVersion({
        table: TABLE,
        holdings: [{ deploymentId: V1.deploymentId, runtime: true, withdrawals: [], credits: [] }],
        slotKind: 'note'
    }));
    const state = h.facade.state(NOW);
    assert.equal(state.reload.required, true);
    assert.equal(state.reload.reason, 'moved_in_other_tab');
    assert.deepEqual(h.facade.depositGate(), { canStart: false, canResume: false, code: 'reload_required', successor: null });
    // Restrict-only: a started deposit here is still finishable.
    h.client.config = { ...h.client.config, pending_deposit: { phase: 'submitted', transaction_hash: `0x${'11'.repeat(32)}`, amount: 5 } };
    assert.deepEqual(h.facade.depositGate(), { canStart: false, canResume: true, code: 'reload_required', successor: null });
    // The next read says the wallet is empty again: nothing moved, nothing is required.
    h.facade.watch.setPreview(chooseZkapiVersion({ table: TABLE, holdings: [], slotKind: 'empty' }));
    assert.equal(h.facade.state(NOW).reload.required, false);
    assert.equal(h.facade.depositGate().canStart, true);
});

test('a closed version told to reload keeps its own, more specific gate code', t => {
    const h = setup(t, { loaded: 'v1' });
    h.facade.watch.setPreview(chooseZkapiVersion({ table: TABLE, holdings: [], slotKind: 'empty' }));
    assert.equal(h.facade.state(NOW).reload.required, true);
    assert.equal(h.facade.depositGate().code, 'deposits_closed');
});

test('the identity of the deployment the SDK reached is checked after its first init', t => {
    const ok = setup(t, { loaded: 'v2' });
    ok.client.initialized = true;
    assert.equal(ok.facade.depositGate().canStart, true);

    const mismatch = setup(t, { loaded: 'v2' });
    mismatch.client.initialized = true;
    mismatch.runtime.manifest = { deployment_id: 'some-other-deployment' };
    const gate = mismatch.facade.depositGate();
    assert.equal(gate.canStart, false);
    assert.equal(gate.code, 'config_mismatch');
    // It is a latch: fixing the field later does not reopen deposits.
    mismatch.runtime.manifest = { deployment_id: V2.deploymentId };
    assert.equal(mismatch.facade.depositGate().code, 'config_mismatch');

    const wrongVault = setup(t, { loaded: 'v2' });
    wrongVault.client.initialized = true;
    wrongVault.client.config = { funding: { contract_address: V1.vault, chain_id: V2.chainId } };
    assert.equal(wrongVault.facade.depositGate().code, 'config_mismatch');

    const before = setup(t, { loaded: 'v2' });
    before.runtime.manifest = { deployment_id: 'some-other-deployment' };
    assert.equal(before.facade.depositGate().canStart, true, 'not judged before the SDK initialized');
});

test('the integrity result from boot closes deposits only on a mismatch', t => {
    for (const [integrity, canStart] of [['ok', true], ['unverified', true], ['mismatch', false]]) {
        resetActiveVersionForTests();
        const h = setup(t, { loaded: 'v2' });
        h.facade.attach({ client: h.client, runtime: h.runtime, integrity });
        assert.equal(h.facade.depositGate().canStart, canStart, integrity);
    }
});

test('a snapshot that cannot be read never makes the gates throw', t => {
    const h = setup(t, { loaded: 'v2' });
    h.client.snapshot = () => { throw new Error('snapshot broke'); };
    assert.equal(h.facade.depositGate().canStart, true);
    assert.deepEqual(h.facade.sendGate(NOW), { canSend: true, code: null });
    assert.ok(h.facade.state(NOW));
    h.facade.noteSignal('deployment_retiring');
    assert.equal(h.facade.state(NOW).phase, 'admission-closed');
});

// --------------------------------------------------------------- send gate

test('near expiry a new key is refused on a version with a chat cutoff only', t => {
    const cutoffSeconds = 23_700;
    const h = setup(t, { loaded: 'v1' });
    h.client.wallet = { has_note: true, note: { note_id: 5, expiry_ts: Math.floor(NOW / 1000) + cutoffSeconds + 60 } };
    assert.deepEqual(h.facade.sendGate(NOW), { canSend: true, code: null });
    h.client.wallet = { has_note: true, note: { note_id: 5, expiry_ts: Math.floor(NOW / 1000) + cutoffSeconds - 1 } };
    assert.deepEqual(h.facade.sendGate(NOW), { canSend: false, code: 'near_expiry' });
    // Exactly at the boundary the key is refused.
    h.client.wallet = { has_note: true, note: { note_id: 5, expiry_ts: Math.floor(NOW / 1000) + cutoffSeconds } };
    assert.deepEqual(h.facade.sendGate(NOW), { canSend: false, code: 'near_expiry' });
    // No note, no gate.
    h.client.wallet = null;
    assert.deepEqual(h.facade.sendGate(NOW), { canSend: true, code: null });

    // The next generation has a native rule and no host cutoff.
    const v2 = setup(t, { loaded: 'v2' });
    v2.client.wallet = { has_note: true, note: { note_id: 5, expiry_ts: Math.floor(NOW / 1000) + 60 } };
    assert.deepEqual(v2.facade.sendGate(NOW), { canSend: true, code: null });
});

// The facade of today's app has a version INSTALLED (boot installs the lone
// row) and no facade-level gate: the 23,700 s cutoff of the legacy adapter
// must never reach a note of a build with one active version.
test('a lone active version, installed and attached, never refuses a chat near expiry', t => {
    const single = resolvedTable(validRegistry(), NETWORK);
    const h = setup(t, { loaded: 'v1', table: single });
    assert.equal(isVersioningActive(single), false);
    assert.equal(h.facade.multiVersion, false);
    for (const seconds of [3600, 60, 1, 23_700 - 1]) {
        h.client.wallet = { has_note: true, note: { note_id: 5, expiry_ts: Math.floor(NOW / 1000) + seconds } };
        assert.deepEqual(h.facade.sendGate(NOW), { canSend: true, code: null }, `${seconds} s left`);
    }
    assert.deepEqual(h.facade.depositGate(), { canStart: true, canResume: false, code: null, successor: null });
    assert.equal(h.facade.state(NOW), null);
});

test('a single-version or unattached facade never refuses a chat', t => {
    const single = createZkapiVersioning({ buildTable: resolvedTable(validRegistry(), NETWORK), network: NETWORK });
    assert.deepEqual(single.sendGate(NOW), { canSend: true, code: null });
    resetActiveVersionForTests();
    const unattached = createZkapiVersioning({ buildTable: TABLE, network: NETWORK });
    assert.deepEqual(unattached.sendGate(NOW), { canSend: true, code: null });
    assert.ok(t);
});

// ------------------------------------------------------------------ state

test('state composes the version, the snapshot and the preview', t => {
    const h = setup(t, { loaded: 'v1' });
    h.client.wallet = noteOf(40);
    const state = h.facade.state(NOW);
    assert.equal(state.show, true);
    assert.equal(state.current.id, 'v1');
    assert.equal(state.target.id, 'v2');
    assert.equal(state.holding, 'previous');
    assert.equal(state.phase, 'upgrade-available');
    assert.equal(state.upgrade.available, true);
    assert.equal(state.expiryTs, (expirySeconds(40)) * 1000);
    assert.equal(h.facade.upgradeStage(), 'idle');
    assert.equal(h.facade.multiVersion, true);
    assert.equal(h.facade.active.id, 'v1');
    assert.equal(h.facade.target.id, 'v2');
    assert.equal(h.facade.table.length, 2);
    assert.deepEqual(h.facade.ui, { marker: 'ui' });
    // The signer's destination rule is addressFunding.js's alone; the facade
    // keeps no second statement of it.
    assert.equal('deniedDestinations' in h.facade, false);
});

test('the state carries the operator text of a notice that relaxed the gate', t => {
    const noticeTable = resolvedTable(mutated(activatedRegistry(), registry => {
        registry.versions[0].networks.sepolia.notices = [stuckEscapeNotice({
            noteId: 7, expiresAt: '2027-01-01T00:00:00Z', text: 'Your <escape> is held up & will finish.'
        })];
    }), NETWORK);
    const h = setup(t, { loaded: 'v2', table: noticeTable });
    assert.deepEqual(h.facade.state(NOW).notices, []);
    const heard = [];
    h.facade.subscribe(state => heard.push(state.notices));
    h.facade.watch.setPreview({
        ...chooseZkapiVersion({ table: noticeTable, holdings: [] }),
        open: { v1: [{ recordId: 'r', noteId: 7, mode: 'escape', phase: 'pending', expiryTs: expirySeconds(3) }] }
    });
    assert.equal(h.facade.depositGate().canStart, true, 'the notice relaxed the gate');
    const { notices } = h.facade.state(NOW);
    // The note number travels with the text: it is the reference line's, and
    // the one place a note number is shown (beside its version).
    assert.deepEqual(notices, [{ versionId: 'v1', text: 'Your <escape> is held up & will finish.', noteId: 7 }]);
    assert.deepEqual(heard.at(-1), notices, 'subscribers get it with the state change');
    // Expired: the gate closes again and the text goes with it.
    h.clock.now = Date.parse('2027-01-02T00:00:00Z');
    assert.equal(h.facade.depositGate().code, 'previous_withdrawal_open');
    assert.deepEqual(h.facade.state(h.clock.now).notices, []);
});

test('claimed balances and running activities are reflected', t => {
    const h = setup(t, { loaded: 'v1' });
    h.client.wallet = noteOf(40);
    h.client.noteExpiryClaim = { transactionHash: '0x1' };
    assert.equal(h.facade.state(NOW).upgrade.blockedBy, 'claimed');
    h.client.noteExpiryClaim = null;
    h.client.activities = [{ id: 'a', status: 'running' }];
    assert.equal(h.facade.state(NOW).reload.canReload, false);
    assert.equal(h.facade.state(NOW).upgrade.blockedBy, 'in_flight');
});

// ------------------------------------------------------------- subscriptions

test('subscribers hear about snapshot changes and watcher events, never about the clock', t => {
    const h = setup(t, { loaded: 'v1' });
    const seen = [];
    const unsubscribe = h.facade.subscribe(state => seen.push(state.phase));
    h.client.emit('clock');
    h.client.emit('update');
    assert.deepEqual(seen, [], 'nothing changed');
    h.client.wallet = noteOf(40);
    h.client.emit('wallet');
    assert.deepEqual(seen, ['upgrade-available']);
    h.client.emit('wallet');
    assert.deepEqual(seen, ['upgrade-available'], 'unchanged state is not repeated');
    h.facade.watch.setPreview({ ...chooseZkapiVersion({ table: TABLE, holdings: [] }) });
    assert.deepEqual(seen, ['upgrade-available', 'reload-required']);
    unsubscribe();
    h.client.wallet = noteOf(5);
    h.client.emit('wallet');
    assert.equal(seen.length, 2);
});

test('subscribers hear when the watcher raises a session flag, although the state did not move', t => {
    const h = setup(t, { loaded: 'v2' });
    const seen = [];
    h.facade.subscribe(() => seen.push(h.facade.flags()));
    h.facade.watch.noteDiscardLoop(true);
    assert.equal(seen.length, 1, 'a discard loop is something to tell the person');
    assert.equal(seen[0].discardLoop, true);
    h.facade.watch.noteDiscardLoop(true);
    assert.equal(seen.length, 1, 'unchanged is not repeated');
    h.facade.watch.noteDraftDiscarded();
    assert.equal(seen.length, 2);
    assert.equal(seen[1].draftDiscarded, true);
    h.facade.watch.noteDraftDiscarded();
    assert.equal(seen.length, 2);
    h.facade.watch.noteDiscardLoop(false);
    assert.equal(seen.length, 3);
    assert.equal(seen[2].discardLoop, false);
    assert.equal(seen[2].draftDiscarded, true);
});

test('the session flags are plain booleans of the fixed set', t => {
    const h = setup(t, { loaded: 'v1' });
    assert.deepEqual(h.facade.flags(), {
        draftDiscarded: false, discardLoop: false, admissionClosed: false, staleBuild: false,
        configMismatch: false, withdrawalConfirmed: false
    });
    h.facade.watch.latchStaleBuild();
    h.facade.noteSignal('deployment_retiring');
    const flags = h.facade.flags();
    assert.equal(flags.staleBuild, true);
    assert.equal(flags.admissionClosed, true);
    for (const value of Object.values(flags)) assert.equal(typeof value, 'boolean');
});

test('the intent advancing to withdrawn is itself heard, although the state did not move', t => {
    const h = upgradeInProgress(t);
    // The record closed without evidence and the wallet is already empty.
    closeRecord(h, { recordId: 'w1', noteId: 5, payoutVerified: false });
    const seen = [];
    h.facade.subscribe(() => seen.push(h.facade.flags().withdrawalConfirmed));
    h.client.withdrawals = [{ recordId: 'w1', noteId: 5, phase: 'closed', payoutVerified: true, updatedAt: 3 }];
    h.client.emit('withdrawal');
    assert.deepEqual(seen, [true]);
});

test('the next reminder boundary is armed once and crossing it notifies', t => {
    const h = setup(t, { loaded: 'v1' });
    // Close-by is 3 days before expiry: expiry in 40 days puts it 37 days out.
    h.client.wallet = noteOf(40);
    h.client.emit('wallet');
    const phases = [];
    h.facade.subscribe(state => phases.push(`${state.phase}:${state.reminderTier}`));
    assert.equal(h.timers.size, 1, 'one timer for the earliest boundary');
    const [{ callback, delay }] = [...h.timers.values()];
    // The earliest boundary ahead is the start of the 14-day prompt window.
    assert.equal(delay, (37 - 14) * DAY + 50);
    h.clock.now += (37 - 14) * DAY + 50;
    h.timers.clear();   // a fired timer is gone
    callback();
    assert.deepEqual(phases, ['upgrade-soon:null']);
    assert.equal(h.timers.size, 1, 'the next boundary is armed');
});

test('the boundary timer is cancelled with the last subscriber', t => {
    const h = setup(t, { loaded: 'v1' });
    h.client.wallet = noteOf(40);
    const unsubscribe = h.facade.subscribe(() => {});
    assert.equal(h.timers.size, 1);
    unsubscribe();
    assert.equal(h.timers.size, 0);
});

// ---------------------------------------------------------------- switching

test('a switch request leaves a validated hint and reloads once', t => {
    const h = setup(t, { loaded: 'v1' });
    const result = h.facade.requestSwitch({ reason: 'moved_in_other_tab', view: 'balance' });
    assert.deepEqual(result, { ok: true });
    assert.equal(h.reloads.length, 1);
    assert.deepEqual(JSON.parse(h.session.getItem(SWITCH_HINT_KEY)), {
        v: 1, at: NOW, from: 'v1', reason: 'moved_in_other_tab', view: 'balance', prefer: null
    });
});

test('a switch is refused while work is in flight, in a loop, or for a malformed request', t => {
    const h = setup(t, { loaded: 'v1' });
    const unregister = h.facade.registerBusy(() => true);
    assert.deepEqual(h.facade.requestSwitch({ reason: 'moved_in_other_tab' }), { ok: false, why: 'busy' });
    unregister();
    h.client.activities = [{ id: 'a', status: 'running' }];
    assert.deepEqual(h.facade.requestSwitch({ reason: 'moved_in_other_tab' }), { ok: false, why: 'busy' });
    h.client.activities = [];
    assert.equal(h.reloads.length, 0);

    assert.equal(h.facade.requestSwitch({ reason: 'moved_in_other_tab' }).ok, true);
    assert.equal(h.facade.requestSwitch({ reason: 'moved_in_other_tab' }).ok, true);
    assert.deepEqual(h.facade.requestSwitch({ reason: 'moved_in_other_tab' }), { ok: false, why: 'loop' });
    assert.equal(h.reloads.length, 2);
    assert.ok(h.session.getItem(SWITCH_LOG_KEY));

    assert.deepEqual(h.facade.requestSwitch({ reason: 'not-a-reason' }), { ok: false, why: 'no_target' });

    // A view this build does not know is never carried into the hint or the
    // saved dialog view, whether the switch protocol refuses it or drops it.
    const odd = setup(t, { loaded: 'v1' });
    const result = odd.facade.requestSwitch({ reason: 'moved_in_other_tab', view: '<script>' });
    assert.ok(result.ok === true || result.why === 'no_target', JSON.stringify(result));
    const hint = odd.session.getItem(SWITCH_HINT_KEY);
    if (hint !== null) assert.equal(JSON.parse(hint).view, null);
    assert.equal(odd.session.has('oa-zkapi-running-modal'), false);
});

test('a busy provider that throws counts as busy, and a provider can be unregistered', t => {
    const h = setup(t, { loaded: 'v1' });
    const unregister = h.facade.registerBusy(() => { throw new Error('provider broke'); });
    assert.equal(h.facade.requestSwitch({ reason: 'moved_in_other_tab' }).why, 'busy');
    unregister();
    assert.equal(h.facade.requestSwitch({ reason: 'moved_in_other_tab' }).ok, true);
});

test('finishing the previous version names it from the state; nothing to open is no_target', t => {
    const selection = {
        ...chooseZkapiVersion({ table: TABLE, holdings: [] }),
        open: { v1: [{ recordId: 'r', noteId: 7, mode: 'mutual', phase: 'closed_unconfirmed', expiryTs: expirySeconds(5) }] }
    };
    const h = setup(t, { loaded: 'v2', selection });
    assert.deepEqual(h.facade.requestSwitch({ reason: 'finish_previous', view: 'withdrawals' }), { ok: true });
    assert.equal(JSON.parse(h.session.getItem(SWITCH_HINT_KEY)).prefer, 'v1');

    const none = setup(t, { loaded: 'v2' });
    assert.deepEqual(none.facade.requestSwitch({ reason: 'finish_previous' }), { ok: false, why: 'no_target' });
});

test('without an installed version there is nothing to switch to', () => {
    resetActiveVersionForTests();
    const facade = createZkapiVersioning({ buildTable: TABLE, network: NETWORK });
    assert.deepEqual(facade.requestSwitch({ reason: 'moved_in_other_tab' }), { ok: false, why: 'no_target' });
});

// ---------------------------------------------------------- upgrade intent

const storedIntent = h => JSON.parse(h.local.getItem(UPGRADE_INTENT_KEY));

test('the upgrade intent follows what this tab observes the SDK do', t => {
    const h = setup(t, { loaded: 'v1' });
    h.client.wallet = noteOf(40);
    h.client.emit('wallet');
    assert.equal(h.local.getItem(UPGRADE_INTENT_KEY), null, 'looking at the banner starts nothing');

    h.facade.beginUpgrade();
    assert.deepEqual(storedIntent(h), { v: 1, network: NETWORK, from: 'v1', to: 'v2', stage: 'withdrawing', since: NOW });
    assert.equal(h.facade.upgradeStage(), 'review');

    // The withdrawal becomes an open record, then finishes with payout
    // evidence for the note the upgrade started from.
    h.client.withdrawals = [{ recordId: 'w1', phase: 'closed_unconfirmed', noteId: 5, updatedAt: 1 }];
    h.client.emit('withdrawal');
    assert.equal(storedIntent(h).stage, 'withdrawing');
    assert.equal(h.facade.upgradeStage(), 'confirming');
    assert.equal(h.facade.flags().withdrawalConfirmed, false);
    h.client.wallet = null;
    h.client.withdrawals = [{ recordId: 'w1', phase: 'closed', noteId: 5, payoutVerified: true, updatedAt: 2 }];
    h.clock.now += 60_000;
    h.client.emit('withdrawal');
    assert.deepEqual(storedIntent(h), {
        v: 1, network: NETWORK, from: 'v1', to: 'v2', stage: 'withdrawn', since: NOW + 60_000
    });
    assert.equal(h.facade.flags().withdrawalConfirmed, true);
});

// What takes a record from open to closed for the upgrade: a verified payout
// of the note the upgrade view was opened on, observed by this tab.
function upgradeInProgress(t, { noteDays = 40, ...options } = {}) {
    const h = setup(t, { loaded: 'v1', ...options });
    h.client.wallet = noteOf(noteDays);
    h.client.emit('wallet');
    h.facade.beginUpgrade();
    return h;
}

function closeRecord(h, record, { wallet = null } = {}) {
    h.client.withdrawals = [{ ...record, phase: 'closed_unconfirmed', updatedAt: 1 }];
    h.client.emit('withdrawal');
    h.client.wallet = wallet;
    h.client.withdrawals = [{ ...record, phase: 'closed', updatedAt: 2 }];
    h.clock.now += 60_000;
    h.client.emit('withdrawal');
}

test('a record that closes WITHOUT payout evidence never advances the intent or confirms a withdrawal', t => {
    for (const evidence of [{ payoutVerified: false }, {}, { payoutVerified: 'true' }, { payoutVerified: 1 }]) {
        const h = upgradeInProgress(t);
        closeRecord(h, { recordId: 'w1', noteId: 5, ...evidence });
        assert.equal(storedIntent(h).stage, 'withdrawing', JSON.stringify(evidence));
        assert.equal(h.facade.flags().withdrawalConfirmed, false);
        // The wallet is empty and the fresh read lands on the target: the
        // words are the neutral ones, never "back in your wallet".
        h.facade.watch.setPreview(chooseZkapiVersion({ table: TABLE, holdings: [] }));
        const state = h.facade.state(h.clock.now);
        assert.equal(state.reload.required, true);
        assert.equal(state.reload.reason, 'previous_withdrawal_finished', JSON.stringify(evidence));
        // Reloading records nothing either.
        assert.equal(h.facade.requestSwitch({ reason: state.reload.reason, view: 'fund' }).ok, true);
        assert.equal(storedIntent(h).stage, 'withdrawing');
    }
});

test('the evidence arriving later on the same closed record is taken', t => {
    const h = upgradeInProgress(t);
    closeRecord(h, { recordId: 'w1', noteId: 5, payoutVerified: false });
    assert.equal(storedIntent(h).stage, 'withdrawing');
    // The SDK adds the matching receipt to the record it already closed.
    h.client.withdrawals = [{ recordId: 'w1', noteId: 5, phase: 'closed', payoutVerified: true, updatedAt: 3 }];
    h.clock.now += 1000;
    h.client.emit('withdrawal');
    assert.equal(storedIntent(h).stage, 'withdrawn');
    assert.equal(h.facade.flags().withdrawalConfirmed, true);
});

test('a record of some other note does not advance the upgrade, whatever its payout evidence', t => {
    const h = upgradeInProgress(t);
    // A parked note closed from Payment history while the slot note is held.
    closeRecord(h, { recordId: 'parked', noteId: 9, payoutVerified: true }, { wallet: noteOf(40) });
    assert.equal(storedIntent(h).stage, 'withdrawing');
    assert.equal(h.facade.flags().withdrawalConfirmed, false);
    // Even with the slot empty afterwards: the id the upgrade started from decides.
    h.client.wallet = null;
    h.client.emit('wallet');
    assert.equal(storedIntent(h).stage, 'withdrawing');
    // A record of the same number from another deployment is another note.
    closeRecord(h, { recordId: 'foreign', noteId: 5, payoutVerified: true, deploymentId: 'some-other-deployment' });
    assert.equal(storedIntent(h).stage, 'withdrawing');
    // The upgrade's own note does.
    closeRecord(h, { recordId: 'own', noteId: 5, payoutVerified: true, deploymentId: V1.deploymentId });
    assert.equal(storedIntent(h).stage, 'withdrawn');
});

test('with no slot note captured only a wallet that now holds nothing is attributed to the upgrade', t => {
    // The upgrade view was opened for a set-aside note: there is no slot note
    // id to match, so the closure counts only when nothing else is held.
    const parked = { recordId: 'p1', noteId: 3, phase: 'parked', expiry: expirySeconds(30) * 1000, updatedAt: 1 };
    const make = () => {
        const h = setup(t, { loaded: 'v1' });
        h.client.withdrawals = [parked];
        h.client.emit('withdrawal');
        h.facade.beginUpgrade();
        assert.equal(storedIntent(h).stage, 'withdrawing');
        return h;
    };
    const alone = make();
    alone.client.withdrawals = [{ ...parked, phase: 'closed_unconfirmed', updatedAt: 2 }];
    alone.client.emit('withdrawal');
    alone.client.withdrawals = [{ ...parked, phase: 'closed', payoutVerified: true, updatedAt: 3 }];
    alone.client.emit('withdrawal');
    assert.equal(storedIntent(alone).stage, 'withdrawn');

    // The same closure with a slot note still held is not the upgrade's.
    const held = make();
    held.client.wallet = noteOf(40);
    held.client.withdrawals = [{ ...parked, phase: 'closed_unconfirmed', updatedAt: 2 }];
    held.client.emit('withdrawal');
    held.client.withdrawals = [{ ...parked, phase: 'closed', payoutVerified: true, updatedAt: 3 }];
    held.client.emit('withdrawal');
    assert.equal(storedIntent(held).stage, 'withdrawing');
    assert.equal(held.facade.flags().withdrawalConfirmed, false);

    // ... and neither is it while another record is still open.
    const other = make();
    const second = { recordId: 'p2', noteId: 4, phase: 'parked', expiry: expirySeconds(30) * 1000, updatedAt: 1 };
    other.client.withdrawals = [parked, second];
    other.client.emit('withdrawal');
    other.client.withdrawals = [{ ...parked, phase: 'closed', payoutVerified: true, updatedAt: 3 }, second];
    other.client.emit('withdrawal');
    assert.equal(storedIntent(other).stage, 'withdrawing');
});

test('a closure seen for the first time on this page is not a withdrawal this tab observed', t => {
    // An old closed record with a verified payout (a previous, unrelated
    // withdrawal) is in the snapshot from the start of the page.
    const h = setup(t, { loaded: 'v1' });
    h.client.wallet = noteOf(40);
    h.client.withdrawals = [{ recordId: 'old', noteId: 5, phase: 'closed', payoutVerified: true, updatedAt: 1 }];
    h.client.emit('wallet');
    h.facade.beginUpgrade();
    h.client.wallet = null;
    h.client.emit('wallet');
    assert.equal(storedIntent(h).stage, 'withdrawing');
    assert.equal(h.facade.flags().withdrawalConfirmed, false);
});

test('empty holdings alone never advance the intent', t => {
    const h = setup(t, { loaded: 'v1' });
    h.client.wallet = noteOf(40);
    h.facade.beginUpgrade();
    h.client.wallet = null;
    h.client.emit('wallet');
    assert.equal(storedIntent(h).stage, 'withdrawing', 'a forfeited or archived balance is not a withdrawal');
});

test('a re-opened view keeps a later stage; beginning again does not rewind it', t => {
    const h = setup(t, { loaded: 'v1' });
    h.client.wallet = noteOf(40);
    h.facade.beginUpgrade();
    h.local.setItem(UPGRADE_INTENT_KEY, JSON.stringify({ ...storedIntent(h), stage: 'withdrawn' }));
    h.facade.beginUpgrade();
    assert.equal(storedIntent(h).stage, 'withdrawn');
});

test('on the target, a withdrawn intent becomes depositing, and done clears it', t => {
    resetActiveVersionForTests();
    const local = createFakeStorage();
    local.setItem(UPGRADE_INTENT_KEY, JSON.stringify({ v: 1, network: NETWORK, from: 'v1', to: 'v2', stage: 'withdrawn', since: NOW - 1000 }));
    const h = setup(t, { loaded: 'v2', selection: chooseZkapiVersion({ table: TABLE, holdings: [] }),
        facadeOptions: { localStorage: local } });
    h.local = local;
    assert.equal(h.facade.upgradeStage(), 'deposit');
    h.client.config = { ...h.client.config, pending_deposit: { phase: 'submitted', transaction_hash: `0x${'22'.repeat(32)}`, amount: 9 } };
    h.client.emit('runtime');
    assert.equal(storedIntent(h).stage, 'depositing');

    h.client.config = { ...h.client.config, pending_deposit: null };
    h.client.wallet = noteOf(60);
    h.client.emit('runtime');
    assert.equal(h.local.getItem(UPGRADE_INTENT_KEY), null, 'the stored intent is retired');
    assert.equal(h.facade.upgradeStage(), 'done', 'this page still shows the finished upgrade');
});

test('markWithdrawn records the intent the reload will continue, only on evidence', t => {
    // No evidence at all (nothing observed, no stored intent): nothing is written.
    const bare = setup(t, { loaded: 'v1' });
    bare.facade.markWithdrawn();
    assert.equal(bare.local.getItem(UPGRADE_INTENT_KEY), null);

    // A bare `withdrawing` intent (the review step was opened) is not evidence.
    const opened = upgradeInProgress(t);
    opened.client.wallet = null;
    opened.facade.markWithdrawn();
    assert.equal(storedIntent(opened).stage, 'withdrawing');

    // The stored intent already proves it: the reload keeps it (and its stage).
    const proven = setup(t, { loaded: 'v1' });
    proven.local.setItem(UPGRADE_INTENT_KEY, JSON.stringify({
        v: 1, network: NETWORK, from: 'v1', to: 'v2', stage: 'withdrawn', since: NOW - 1000
    }));
    proven.facade.markWithdrawn();
    assert.deepEqual(storedIntent(proven), { v: 1, network: NETWORK, from: 'v1', to: 'v2', stage: 'withdrawn', since: NOW });

    // This page observed the verified closure but the write failed then: the
    // retry here records it.
    const failing = createFakeStorage();
    const retried = upgradeInProgress(t, { facadeOptions: { localStorage: failing } });
    failing.failWrites = true;
    closeRecord(retried, { recordId: 'w1', noteId: 5, payoutVerified: true });
    failing.failWrites = false;
    assert.equal(JSON.parse(failing.getItem(UPGRADE_INTENT_KEY)).stage, 'withdrawing');
    retried.facade.markWithdrawn();
    assert.equal(JSON.parse(failing.getItem(UPGRADE_INTENT_KEY)).stage, 'withdrawn');
});

test('the upgrade switch calls markWithdrawn only when the stored intent already proves the withdrawal', t => {
    const spied = h => {
        const calls = [];
        const original = h.facade.markWithdrawn;
        h.facade.markWithdrawn = (...args) => { calls.push('markWithdrawn'); return original.apply(h.facade, args); };
        return calls;
    };
    const switchHint = h => JSON.parse(h.session.getItem(SWITCH_HINT_KEY));

    // No intent at all: the switch happens, nothing is recorded.
    const none = setup(t, { loaded: 'v1' });
    const noneCalls = spied(none);
    assert.equal(none.facade.requestSwitch({ reason: 'upgrade_withdrawn', view: 'fund' }).ok, true);
    assert.deepEqual(noneCalls, []);
    assert.equal(none.local.getItem(UPGRADE_INTENT_KEY), null);
    assert.equal(switchHint(none).reason, 'upgrade_withdrawn');

    // A bare intent (the review step was opened): the same, and it stays bare.
    const bare = upgradeInProgress(t);
    const bareCalls = spied(bare);
    assert.equal(bare.facade.requestSwitch({ reason: 'upgrade_withdrawn', view: 'fund' }).ok, true);
    assert.deepEqual(bareCalls, []);
    assert.equal(storedIntent(bare).stage, 'withdrawing');

    // Proven by a verified closure this page observed: it is called, and the
    // intent stays what it was.
    const proven = upgradeInProgress(t);
    closeRecord(proven, { recordId: 'w1', noteId: 5, payoutVerified: true });
    const calls = spied(proven);
    assert.equal(proven.facade.requestSwitch({ reason: 'upgrade_withdrawn', view: 'fund' }).ok, true);
    assert.deepEqual(calls, ['markWithdrawn']);
    assert.equal(storedIntent(proven).stage, 'withdrawn');
    assert.equal(switchHint(proven).reason, 'upgrade_withdrawn');

    // An intent for some other pair of versions proves nothing about this page.
    const other = setup(t, { loaded: 'v1' });
    other.local.setItem(UPGRADE_INTENT_KEY, JSON.stringify({
        v: 1, network: NETWORK, from: 'v0', to: 'v2', stage: 'withdrawn', since: NOW - 1000
    }));
    const otherCalls = spied(other);
    other.facade.requestSwitch({ reason: 'upgrade_withdrawn' });
    assert.deepEqual(otherCalls, []);
    assert.equal(storedIntent(other).from, 'v0');
});

test('markWithdrawn is not written when the switch is refused as busy', t => {
    const h = upgradeInProgress(t);
    closeRecord(h, { recordId: 'w1', noteId: 5, payoutVerified: true });
    h.local.setItem(UPGRADE_INTENT_KEY, JSON.stringify({ ...storedIntent(h), stage: 'withdrawn', since: 1 }));
    const before = h.local.getItem(UPGRADE_INTENT_KEY);
    h.facade.registerBusy(() => true);
    assert.equal(h.facade.requestSwitch({ reason: 'upgrade_withdrawn' }).ok, false);
    assert.equal(h.local.getItem(UPGRADE_INTENT_KEY), before);
});

test('the intent is version ids and a stage only, and storage failures change nothing', t => {
    const h = setup(t, { loaded: 'v1', facadeOptions: { localStorage: createFakeStorage({ failWrites: true, failReads: true }) } });
    h.client.wallet = noteOf(40);
    h.facade.beginUpgrade();
    assert.equal(h.facade.upgradeStage(), 'review');
    h.facade.markWithdrawn();
    assert.ok(h.facade.state(NOW));
    const intent = createFakeStorage();
    const ok = setup(t, { loaded: 'v1', facadeOptions: { localStorage: intent } });
    ok.client.wallet = noteOf(40);
    ok.facade.beginUpgrade();
    const stored = JSON.parse(intent.getItem(UPGRADE_INTENT_KEY));
    assert.deepEqual(Object.keys(stored).sort(), ['from', 'network', 'since', 'stage', 'to', 'v']);
});

test('upgrade bookkeeping is inert off a version that can still take deposits', t => {
    const h = setup(t, { loaded: 'v2' });
    h.client.wallet = noteOf(40);
    h.facade.beginUpgrade();
    assert.equal(h.local.getItem(UPGRADE_INTENT_KEY), null);
});

// An upgrade that is on the deposit page (stage `deposit`) and not wanted.
function depositStage(t, { stage = 'withdrawn', facadeOptions = {} } = {}) {
    resetActiveVersionForTests();
    const local = createFakeStorage();
    local.setItem(UPGRADE_INTENT_KEY, JSON.stringify({ v: 1, network: NETWORK, from: 'v1', to: 'v2', stage, since: NOW - 1000 }));
    const h = setup(t, {
        loaded: 'v2', selection: chooseZkapiVersion({ table: TABLE, holdings: [] }),
        facadeOptions: { localStorage: local, ...facadeOptions }
    });
    h.local = local;
    return h;
}

test('a withdrawn intent that the person does not want can be dismissed for good', t => {
    const h = depositStage(t);
    assert.equal(h.facade.upgradeStage(), 'deposit');
    const seen = [];
    h.facade.subscribe(state => seen.push(state.upgrade.stage));
    // endUpgrade is the view closing: it neither clears the intent nor is it
    // anything on a page that never opened the view.
    h.facade.endUpgrade();
    assert.equal(h.facade.upgradeStage(), 'deposit');
    assert.ok(h.local.getItem(UPGRADE_INTENT_KEY));

    assert.equal(h.facade.abandonUpgrade(), true);
    assert.equal(h.local.getItem(UPGRADE_INTENT_KEY), null, 'it does not come back on the next page');
    assert.equal(h.facade.upgradeStage(), 'idle');
    assert.deepEqual(seen, ['idle'], 'the notice surfaces are told');
    // Nothing re-creates it: not the SDK changing, not a started deposit, not
    // the upgrade bookkeeping.
    h.client.config = { ...h.client.config, pending_deposit: { phase: 'submitted', transaction_hash: `0x${'22'.repeat(32)}`, amount: 9 } };
    h.client.emit('runtime');
    h.client.wallet = noteOf(60);
    h.client.emit('runtime');
    h.facade.markWithdrawn();
    h.facade.beginUpgrade();
    h.facade.requestSwitch({ reason: 'upgrade_withdrawn' });
    assert.equal(h.local.getItem(UPGRADE_INTENT_KEY), null);
    assert.equal(h.facade.upgradeStage(), 'idle');
    // A second dismissal has nothing to forget.
    assert.equal(h.facade.abandonUpgrade(), false);
});

test('a dismissed upgrade stays dismissed on this page even when storage refuses the removal', t => {
    const h = depositStage(t);
    h.local.failWrites = true;
    assert.equal(h.facade.upgradeStage(), 'deposit');
    assert.equal(h.facade.abandonUpgrade(), true);
    assert.equal(h.facade.upgradeStage(), 'idle');
    assert.equal(h.facade.state(NOW).upgrade.stage, 'idle');
    assert.equal(h.facade.flags().withdrawalConfirmed, false);
});

test('abandoning is for the persisted intent of this network and forgets what the page noted', t => {
    // A bare intent on the closed version: dismissing it forgets the captured
    // note too, so a later closure is not attributed to a dismissed upgrade.
    const h = upgradeInProgress(t);
    assert.equal(h.facade.abandonUpgrade(), true);
    assert.equal(h.local.getItem(UPGRADE_INTENT_KEY), null);
    closeRecord(h, { recordId: 'w1', noteId: 5, payoutVerified: true });
    assert.equal(h.local.getItem(UPGRADE_INTENT_KEY), null, 'nothing is written for a dismissed upgrade');
    h.facade.markWithdrawn();
    assert.equal(h.local.getItem(UPGRADE_INTENT_KEY), null);

    // An explicit new start is a new upgrade, not a revival.
    h.client.wallet = noteOf(40);
    h.client.emit('wallet');
    h.facade.beginUpgrade();
    assert.equal(storedIntent(h).stage, 'withdrawing');

    // Another network's intent is not this page's to dismiss.
    resetActiveVersionForTests();
    const local = createFakeStorage();
    local.setItem(UPGRADE_INTENT_KEY, JSON.stringify({ v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawn', since: NOW - 1000 }));
    const other = setup(t, { loaded: 'v2', facadeOptions: { localStorage: local } });
    assert.equal(other.facade.abandonUpgrade(), false);
    assert.ok(local.getItem(UPGRADE_INTENT_KEY));

    // Not versioned at all: nothing to do.
    resetActiveVersionForTests();
    const SINGLE = resolvedTable(validRegistry(), NETWORK);
    const dormant = createZkapiVersioning({ buildTable: SINGLE, network: NETWORK });
    assert.equal(dormant.abandonUpgrade(), false);
});

// ------------------------------------------------------------ small facts

test('a retiring deployment closes admission for the session, and only that signal does', t => {
    const h = setup(t, { loaded: 'v1' });
    h.client.wallet = noteOf(40);
    h.facade.noteSignal('something_else');
    assert.notEqual(h.facade.state(NOW).phase, 'admission-closed');
    assert.equal(h.facade.flags().admissionClosed, false);
    h.facade.noteSignal('deployment_retiring');
    assert.equal(h.facade.state(NOW).phase, 'admission-closed');
    assert.equal(h.facade.flags().admissionClosed, true);
});

test('reminder acknowledgements are per version and tolerate storage failure', t => {
    const h = setup(t, { loaded: 'v1' });
    assert.equal(h.facade.lastReminderTier(), null);
    h.facade.acknowledgeReminder(7);
    assert.equal(h.facade.lastReminderTier(), 7);
    h.facade.acknowledgeReminder(3);
    assert.equal(h.facade.lastReminderTier(), 3);
    assert.deepEqual(JSON.parse(h.local.getItem(REMINDER_KEY)), { v: 1, tiers: { 'sepolia:v1': 3 } });
    for (const bad of [-1, Number.NaN, 'x', null]) h.facade.acknowledgeReminder(bad);
    assert.equal(h.facade.lastReminderTier(), 3);
    // Tier 0 (close-by passed) is a tier like another.
    h.facade.acknowledgeReminder(0);
    assert.equal(h.facade.lastReminderTier(), 0);
});

test('the reminder tier is remembered in memory when storage refuses reads and writes', t => {
    // Quota or restricted mode: without a page memo every later state change
    // would announce the same tier again.
    const broken = setup(t, { loaded: 'v1', facadeOptions: { localStorage: createFakeStorage({ failWrites: true, failReads: true }) } });
    assert.equal(broken.facade.lastReminderTier(), null);
    broken.facade.acknowledgeReminder(7);
    assert.equal(broken.facade.lastReminderTier(), 7);
    broken.facade.acknowledgeReminder(3);
    assert.equal(broken.facade.lastReminderTier(), 3);
    for (const bad of [-1, Number.NaN, 'x', null]) broken.facade.acknowledgeReminder(bad);
    assert.equal(broken.facade.lastReminderTier(), 3);

    // Writes refused but reads work: the page's own tier and the stored one
    // combine, the more urgent (lower) winning, so neither is repeated.
    const readOnly = createFakeStorage({
        initial: { [REMINDER_KEY]: JSON.stringify({ v: 1, tiers: { 'sepolia:v1': 7 } }) }
    });
    const half = setup(t, { loaded: 'v1', facadeOptions: { localStorage: readOnly } });
    assert.equal(half.facade.lastReminderTier(), 7);
    readOnly.failWrites = true;
    half.facade.acknowledgeReminder(3);
    assert.equal(half.facade.lastReminderTier(), 3);
    assert.equal(JSON.parse(readOnly.getItem(REMINDER_KEY)).tiers['sepolia:v1'], 7, 'nothing was stored');

    // Another tab acknowledged a more urgent tier than this page did.
    readOnly.failWrites = false;
    readOnly.setItem(REMINDER_KEY, JSON.stringify({ v: 1, tiers: { 'sepolia:v1': 1 } }));
    assert.equal(half.facade.lastReminderTier(), 1);

    // No localStorage object at all (a restricted browsing context).
    const none = setup(t, { loaded: 'v1', facadeOptions: { localStorage: null } });
    assert.equal(none.facade.lastReminderTier(), null);
    none.facade.acknowledgeReminder(7);
    assert.equal(none.facade.lastReminderTier(), 7);

    // Per version: another version's tier is not this one's.
    const selection = chooseZkapiVersion({ table: TABLE, holdings: [] });
    resetActiveVersionForTests();
    installActiveVersion({ table: TABLE, version: V2, selection });
    assert.equal(none.facade.lastReminderTier(), null);
    none.facade.acknowledgeReminder(3);
    assert.equal(none.facade.lastReminderTier(), 3);
    resetActiveVersionForTests();
    installActiveVersion({ table: TABLE, version: V1, selection });
    assert.equal(none.facade.lastReminderTier(), 7);
});

test('discarding an unsent deposit runs the supplied discard, refuses while busy, and wakes the watcher', async t => {
    const h = setup(t, { loaded: 'v1' });
    const triggers = [];
    h.facade.watch.onTrigger(() => triggers.push('probe'));
    let calls = 0;
    h.facade.attach({ client: h.client, runtime: h.runtime, integrity: 'ok', discardUnsent: async () => { calls += 1; return true; } });

    h.client.activities = [{ id: 'a', status: 'running' }];
    assert.deepEqual(await h.facade.discardUnsentDeposit(), { discarded: false, why: 'busy' });
    assert.equal(calls, 0);
    h.client.activities = [];
    assert.deepEqual(await h.facade.discardUnsentDeposit(), { discarded: true });
    assert.equal(calls, 1);
    assert.ok(triggers.includes('probe'));

    h.facade.attach({ client: h.client, runtime: h.runtime, integrity: 'ok', discardUnsent: async () => false });
    assert.deepEqual(await h.facade.discardUnsentDeposit(), { discarded: false, why: 'not_discardable' });
    h.facade.attach({ client: h.client, runtime: h.runtime, integrity: 'ok', discardUnsent: async () => { throw new Error('boom'); } });
    assert.deepEqual(await h.facade.discardUnsentDeposit(), { discarded: false, why: 'failed' });
    h.facade.attach({ client: h.client, runtime: h.runtime, integrity: 'ok' });
    assert.deepEqual(await h.facade.discardUnsentDeposit(), { discarded: false, why: 'unavailable' });
});

test('re-attaching releases the previous client subscription', t => {
    const h = setup(t, { loaded: 'v1' });
    assert.equal(h.client.subscriberCount(), 1);
    h.facade.attach({ client: h.client, runtime: h.runtime, integrity: 'ok' });
    assert.equal(h.client.subscriberCount(), 1);
    h.facade.resetForTests();
    assert.equal(h.client.subscriberCount(), 0);
});

test('draft discards recorded by boot show through flags', t => {
    const selection = { ...chooseZkapiVersion({ table: TABLE, holdings: [] }), draftDiscarded: true };
    const h = setup(t, { loaded: 'v2', selection });
    assert.equal(h.facade.flags().draftDiscarded, true);
    assert.equal(h.facade.flags().discardLoop, false);
    h.facade.watch.noteDiscardLoop(true);
    assert.equal(h.facade.flags().discardLoop, true);
    h.facade.watch.noteDiscardLoop(false);
    assert.equal(h.facade.flags().discardLoop, false);
});

test('the version UI helpers are offered only while versioning is active', t => {
    const h = setup(t, { loaded: 'v2' });
    assert.deepEqual(h.facade.ui, { marker: 'ui' });
    resetActiveVersionForTests();
    const single = createZkapiVersioning({ buildTable: resolvedTable(validRegistry(), NETWORK), network: NETWORK });
    single.attach({ client: fakeClient(V2), runtime: {}, ui: { marker: 'ui' } });
    assert.equal(single.ui, null);
    assert.equal(single.state(), null);
});

// -------------------------------------------- what the facade holds for the page

test('an unsaved exit kit is part of what subscribers compare, even when the state did not move', t => {
    const h = setup(t, { loaded: 'v2' });
    h.client.wallet = noteOf(40);
    const states = [];
    h.facade.subscribe(state => states.push(JSON.stringify(state)));
    h.facade.noteKitSaved(false);
    assert.equal(states.length, 1, 'told that a kit was not saved');
    h.facade.noteKitSaved(false);
    assert.equal(states.length, 1, 'once');
    h.facade.noteKitSaved(true);
    assert.equal(states.length, 2);
    // A legacy snapshot has no exit summary, so the state itself is the same
    // each time: the notification is the flag's.
    assert.equal(new Set(states).size, 1);
});

test('the other versions\' history is part of what subscribers compare', async t => {
    const row = Object.freeze({ key: 'v1:deposit:3', kind: 'deposit', at: NOW, version: { versionId: 'v1' } });
    let rows = [row];
    const h = setup(t, { loaded: 'v2' });
    h.facade.attach({
        client: h.client, runtime: h.runtime, integrity: 'ok', ui: { marker: 'ui' },
        readHistory: async () => ({ rows, truncated: false })
    });
    const heard = [];
    h.facade.subscribe(() => heard.push(h.facade.history.rows().length));
    await h.facade.history.ensureFresh();
    assert.deepEqual(heard, [1]);
    // The same projection read again is not news; a changed one is.
    h.facade.history.invalidate();
    rows = [{ ...row }];
    await h.facade.history.ensureFresh();
    assert.deepEqual(heard, [1]);
    h.facade.history.invalidate();
    rows = [row, { ...row, key: 'v1:withdrawal:3', kind: 'withdrawal' }];
    await h.facade.history.ensureFresh();
    assert.deepEqual(heard, [1, 2]);
});

test('a page with one version keeps none of what a versioned page holds', async t => {
    resetActiveVersionForTests();
    const single = resolvedTable(validRegistry(), NETWORK);
    const version = single[0];
    installActiveVersion({
        table: single, version,
        selection: chooseZkapiVersion({
            table: single, slotKind: 'note',
            holdings: [{ deploymentId: version.deploymentId, runtime: true, withdrawals: [], credits: [] }]
        })
    });
    let reads = 0;
    const facade = createZkapiVersioning({ buildTable: single, network: NETWORK, now: () => NOW });
    t.after(() => { facade.resetForTests(); resetActiveVersionForTests(); });
    const client = fakeClient(version);
    client.wallet = noteOf(40);
    facade.attach({
        client, runtime: {}, integrity: 'ok',
        abandonNote: async () => { reads += 1; return { done: true }; },
        readHistory: async () => { reads += 1; return { rows: [] }; }
    });
    assert.equal(facade.history, undefined, 'no history member');
    assert.equal(facade.state(NOW), null);
    facade.noteRefusal(Object.assign(new Error('x'), { code: 'note_near_expiry' }));
    facade.noteKitSaved(false);
    assert.equal(facade.operationRecheckRequired(), false);
    assert.equal(facade.abandonPreview(), null);
    assert.deepEqual(await facade.giveUpBalance({ noteId: 5, balanceUnits: '0' }), { done: false, why: 'unavailable' });
    assert.deepEqual(await facade.recheckService(), { ok: false, why: 'unavailable' });
    await assert.rejects(facade.exportExitKit('x'), error => error.code === 'exit_kit_unavailable');
    assert.equal(reads, 0);
    // The facade of a single version does not even subscribe to the SDK.
    assert.equal(client.subscriberCount(), 0);
});

test('resetting forgets what the page held, with no client attached again', t => {
    const h = setup(t, { loaded: 'v2' });
    h.client.wallet = noteOf(40);
    h.facade.noteKitSaved(false);
    h.facade.noteRefusal(Object.assign(new Error('paused'), {
        status: 503, code: 'deployment_manifest_unavailable', data: { exits: true }
    }));
    assert.equal(h.facade.state(NOW).service.code, 'deployment_manifest_unavailable');
    h.facade.resetForTests();
    assert.equal(h.facade.state(NOW)?.service ?? null, null);
    assert.equal(h.facade.history.status(), 'idle');
});

// ------------------------------------------------- what counts as versioned

test('versioning is active unless the table is empty or exactly one deposit target', () => {
    const row = (id, status) => ({ id, status });
    const cases = [
        ['no table', null, false],
        ['not an array', 'v1', false],
        ['an empty table (sdk-default)', [], false],
        ['one active row (today)', [row('v1', 'active')], false],
        ['one exit-only row (successor pending)', [row('v1', 'exit-only')], true],
        ['a lone tombstone', [row('v0', 'retired')], true],
        ['a status this build does not know', [row('v1', 'weird')], true],
        ['two live rows', [row('v1', 'exit-only'), row('v2', 'active')], true],
        ['two exit-only rows', [row('v1', 'exit-only'), row('v2', 'exit-only')], true],
        ['one active row and a tombstone', [row('v2', 'active'), row('v1', 'retired')], true],
        ['rows that are not records are ignored', [null, 7, row('v1', 'active')], false]
    ];
    for (const [label, table, expected] of cases) {
        assert.equal(isVersioningActive(table), expected, label);
    }
    // The registry fixtures say the same.
    assert.equal(isVersioningActive(resolvedTable(validRegistry(), NETWORK)), false);
    assert.equal(isVersioningActive(resolvedTable(partialRevertRegistry(), NETWORK)), true);
    assert.equal(isVersioningActive(TABLE), true);
});

test('a lone exit-only version closes deposits with no successor, and fails closed before it is installed', t => {
    const LONE = resolvedTable(partialRevertRegistry(), NETWORK);
    assert.equal(LONE.length, 1);
    resetActiveVersionForTests();
    const facade = createZkapiVersioning({
        buildTable: LONE, network: NETWORK, now: () => NOW,
        sessionStorage: createFakeStorage(), localStorage: createFakeStorage()
    });
    assert.equal(facade.multiVersion, true);
    assert.deepEqual(facade.depositGate(), { canStart: false, canResume: false, code: 'version_unavailable', successor: null });

    installActiveVersion({
        table: LONE, version: LONE[0],
        selection: chooseZkapiVersion({ table: LONE, holdings: [] })
    });
    t.after(() => { facade.resetForTests(); resetActiveVersionForTests(); });
    facade.attach({ client: fakeClient(LONE[0]), runtime: { runtime: null }, integrity: 'ok' });
    assert.deepEqual(facade.depositGate(), { canStart: false, canResume: false, code: 'deposits_closed', successor: null });
    const state = facade.state(NOW);
    assert.equal(state.gate.code, 'deposits_closed');
    assert.equal(state.show, false);
    assert.equal(state.depositsOpen, false);
    assert.equal(state.target, null);
    // A started deposit can still be finished there.
    facade.attach({
        client: Object.assign(fakeClient(LONE[0]), {
            config: { pending_deposit: { phase: 'submitted', transaction_hash: `0x${'11'.repeat(32)}`, amount: 5 } }
        }),
        runtime: { runtime: null }, integrity: 'ok'
    });
    assert.equal(facade.depositGate().canResume, true);
    assert.equal(facade.depositGate().canStart, false);
});

test('a single-version page does not subscribe to SDK changes at all', t => {
    resetActiveVersionForTests();
    const SINGLE = resolvedTable(validRegistry(), NETWORK);
    installActiveVersion({
        table: SINGLE, version: SINGLE[0], selection: chooseZkapiVersion({ table: SINGLE, holdings: [] })
    });
    const facade = createZkapiVersioning({ buildTable: SINGLE, network: NETWORK, now: () => NOW });
    t.after(() => { facade.resetForTests(); resetActiveVersionForTests(); });
    const client = fakeClient(SINGLE[0]);
    facade.attach({ client, runtime: {}, integrity: 'ok' });
    assert.equal(client.subscriberCount(), 0, 'no listener means no snapshot copy per SDK change');
    assert.deepEqual(facade.depositGate(), { canStart: true, canResume: false, code: null, successor: null });
    assert.equal(facade.state(), null);
    assert.equal(facade.multiVersion, false);
});

// ------------------------------------------------- the version notices arrive

test('the version notices can arrive after attach, and subscribers hear about it', t => {
    const h = setup(t, { loaded: 'v2', facadeOptions: {} });
    h.facade.attach({ client: h.client, runtime: h.runtime, integrity: 'ok' });
    assert.equal(h.facade.ui, null);
    const seen = [];
    h.facade.subscribe(state => seen.push(state));
    assert.equal(h.facade.attachUi({ marker: 'late' }), true);
    assert.deepEqual(h.facade.ui, { marker: 'late' });
    assert.equal(seen.length, 1, 'the state did not move, but what can be rendered did');
    // Not a record: refused, nothing changes, nobody is told.
    for (const bad of [null, undefined, 'ui', 7, () => {}]) assert.equal(h.facade.attachUi(bad), false);
    assert.deepEqual(h.facade.ui, { marker: 'late' });
    assert.equal(seen.length, 1);
});

test('the version notices are refused before there is a client, and never offered to a dormant page', () => {
    resetActiveVersionForTests();
    const fresh = createZkapiVersioning({ buildTable: TABLE, network: NETWORK });
    assert.equal(fresh.attachUi({ marker: 'ui' }), false);
    assert.equal(fresh.ui, null);

    const SINGLE = resolvedTable(validRegistry(), NETWORK);
    const dormant = createZkapiVersioning({ buildTable: SINGLE, network: NETWORK });
    dormant.attach({ client: fakeClient(SINGLE[0]), runtime: {} });
    assert.equal(dormant.attachUi({ marker: 'ui' }), true, 'taken, but...');
    assert.equal(dormant.ui, null, '...a dormant page offers none');
});

// -------------------------------------------- fail-closed branches, pinned

test('a loaded version whose adapter this build lacks is "unavailable", not a normally computed gate', t => {
    // The deposit TARGET with an adapter id no build contains: computing the
    // gate with no adapter would open it.
    const broken = TABLE.map(row => (row.id === 'v2' ? { ...row, adapter: 'no-such-adapter' } : row));
    resetActiveVersionForTests();
    installActiveVersion({
        table: broken, version: broken.find(row => row.id === 'v2'),
        selection: chooseZkapiVersion({ table: broken, holdings: [] })
    });
    const facade = createZkapiVersioning({ buildTable: broken, network: NETWORK, now: () => NOW });
    t.after(() => { facade.resetForTests(); resetActiveVersionForTests(); });
    facade.attach({ client: fakeClient(V2), runtime: {}, integrity: 'ok' });
    assert.deepEqual(facade.depositGate(), { canStart: false, canResume: false, code: 'version_unavailable', successor: null });
    assert.equal(facade.state(NOW), null);
    assert.equal(facade.multiVersion, true);
});

test('a state derivation that throws closes deposits instead of opening them', t => {
    resetActiveVersionForTests();
    const adapter = {
        get sweepablePhases() { throw new Error('adapter data is broken'); },
        chatCutoffSeconds: null
    };
    const facade = createZkapiVersioning({
        buildTable: TABLE, network: NETWORK, now: () => NOW,
        context: () => ({
            table: TABLE, version: V2, adapter,
            selection: chooseZkapiVersion({ table: TABLE, holdings: [] })
        })
    });
    // The deposit target would normally be open.
    assert.deepEqual(facade.depositGate(), { canStart: false, canResume: false, code: 'version_unavailable', successor: null });
    assert.equal(facade.state(NOW), null);
    // Chat is never a deposit: it stays available.
    assert.deepEqual(facade.sendGate(NOW), { canSend: true, code: null });
    assert.ok(t);
});

// ----------------------------------------- gwei amount text, one per module

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

// A top-level function of a source file, and the single-line constants it
// names, rebuilt on their own. These normalizers are private to their modules
// (the display ones are deliberately separate from the facade's), so the way
// to pin what each one does is to run the source that ships. A function that
// is renamed, moved or inlined fails here by name.
function sourceFunction(file, name, constants = []) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
    assert.notEqual(start, -1, `${file} has no top-level function ${name}`);
    const end = source.indexOf('\n}\n', start);
    const lines = constants.map(constant => {
        const match = source.match(new RegExp(`^const ${constant} = .*;$`, 'm'));
        assert.ok(match, `${file} has no one-line constant ${constant}`);
        return match[0];
    });
    return new Function(`${lines.join('\n')}\n${source.slice(start, end + 3)}\nreturn ${name};`)();
}

// Built on first use, so a function that moved fails the tests below and not
// the loading of this whole file.
let amountSources = null;
function amountCopies() {
    amountSources ??= {
        facade: sourceFunction('chat/zkapi/versioning/index.js', 'amountText'),
        versionState: sourceFunction('chat/zkapi/versioning/versionState.mjs', 'amountString'),
        exitRefusal: sourceFunction('chat/zkapi/versioning/exitRefusal.mjs', 'amountString'),
        concession: sourceFunction('chat/zkapi/versioning/adapters/concessionV1.mjs', 'amountString'),
        copy: sourceFunction('chat/zkapi/versioning/copy.mjs', 'amountText'),
        recordExtras: sourceFunction('chat/zkapi/components/RecordExtras.js', 'unitsText'),
        exitChoice: sourceFunction('chat/zkapi/components/ExitChoice.js', 'amountText', ['AMOUNT'])
    };
    return amountSources;
}

// What reads digits for a balance to be given up (the dialog's own check).
function giveUpAmountPattern() {
    const source = fs.readFileSync(path.join(repoRoot, 'chat/zkapi/components/AbandonDialog.js'), 'utf8');
    const match = source.match(/^const AMOUNT = (.*);$/m);
    assert.ok(match, 'AbandonDialog.js keeps its AMOUNT pattern on one line');
    return new Function(`return ${match[1]};`)();
}

// Normalizers that canonicalize what they are given (the display side), and
// the two that refuse anything but the exact digits the SDK writes.
const CANONICALIZING = ['versionState', 'exitRefusal', 'concession', 'copy', 'recordExtras'];
const EXACT = ['facade', 'exitChoice'];

test('amount text: every copy agrees on every value the SDK emits, and on what is not an amount', () => {
    // The SDK writes safe integers and canonical decimal strings (u64 range at most).
    const agreed = [
        [0, '0'], [1, '1'], [50_000, '50000'], [Number.MAX_SAFE_INTEGER, '9007199254740991'],
        ['0', '0'], ['5', '5'], ['50000', '50000'], ['9007199254740991', '9007199254740991'],
        ['9999999999999999999', '9999999999999999999'], ['18446744073709551615', '18446744073709551615'],
        // Not amounts at all.
        [Number.MAX_SAFE_INTEGER + 1, null], [-1, null], [1.5, null], [Number.NaN, null], [Infinity, null],
        ['', null], ['-1', null], ['+7', null], [' 7', null], ['7 ', null], ['1.5', null], ['1e3', null],
        ['0x10', null], ['abc', null], [null, null], [undefined, null], [{}, null], [[], null], [true, null], [-5n, null]
    ];
    for (const [name, copy] of Object.entries(amountCopies())) {
        for (const [input, expected] of agreed) {
            assert.equal(copy(input), expected, `${name}(${typeof input === 'bigint' ? `${input}n` : JSON.stringify(input)})`);
        }
    }
});

test('amount text: the copies differ on leading zeros, on width and on bigint, and each keeps its own rule', () => {
    const copies = amountCopies();
    const run = (names, input) => names.map(name => copies[name](input));
    // Leading zeros. The display side reads them as the number they spell; the
    // two that compare or confirm an amount refuse text that is not exactly
    // what the SDK writes.
    for (const input of ['007', '00', '000000000000000000000001']) {
        assert.deepEqual(run(CANONICALIZING, input), CANONICALIZING.map(() => String(BigInt(input))), input);
        assert.deepEqual(run(EXACT, input), EXACT.map(() => null), input);
    }
    // Width. The facade's (and the give-up dialog's) rule is 20 digits, a
    // 64-bit amount; every other copy takes up to 30; none takes 31.
    const wide = '9'.repeat(25);
    assert.equal(copies.facade(wide), null);
    for (const name of Object.keys(copies).filter(name => name !== 'facade')) {
        assert.equal(copies[name](wide), wide, name);
        assert.equal(copies[name]('9'.repeat(30)), '9'.repeat(30), name);
        assert.equal(copies[name]('9'.repeat(31)), null, name);
    }
    assert.equal(copies.facade('9'.repeat(20)), '9'.repeat(20));
    assert.equal(copies.facade('9'.repeat(21)), null);
    // A bigint is something only code inside this app can hold (JSON has
    // none): three copies read a non-negative one, the rest call it unknown.
    const reads = ['facade', 'concession', 'recordExtras'];
    for (const name of Object.keys(copies)) {
        assert.equal(copies[name](5n), reads.includes(name) ? '5' : null, name);
    }
});

test('amount text: the give-up dialog and the facade read the same digits for a balance', () => {
    const samples = ['0', '5', '50000', '9'.repeat(20), '9'.repeat(21), '007', '00', '+7', ' 7', '1e3', '', '-1', '1.5', '0x10'];
    const pattern = giveUpAmountPattern();
    const { facade } = amountCopies();
    for (const text of samples) {
        assert.equal(pattern.test(text), facade(text) === text, JSON.stringify(text));
    }
});
