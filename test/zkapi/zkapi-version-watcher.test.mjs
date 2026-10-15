// The long-lived tab's watcher: holdings re-probes, the restrict-only
// stale-build latch and the draft-discard retry. Every effect is injected:
// manual timers, fake focus/visibility targets, a fake channel, recorded
// probes and a recorded /build.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClosesDeposits, startVersionWatcher } from '../../chat/zkapi/versioning/versionWatcher.mjs';
import { createZkapiVersioning } from '../../chat/zkapi/versioning/index.js';
import { chooseZkapiVersion } from '../../chat/zkapi/versioning/versionLoader.mjs';
import { installActiveVersion, resetActiveVersionForTests } from '../../chat/zkapi/versioning/activeVersion.mjs';
import { readWalletHoldings } from '../../chat/zkapi/versioning/walletHoldings.mjs';
import { createFakeEnvironment, createFakeStorage } from './_fakeIndexedDb.mjs';
import { activatedRegistry, resolvedTable } from './_registryFixtures.mjs';

const NETWORK = 'sepolia';
const DB = 'zkapi-browser-wallet-fresh-20260930-sepolia-v1';
const NOW = Date.parse('2026-11-15T12:00:00Z');
const NOTE_EXPIRY = Math.floor(NOW / 1000) + 30 * 86_400;
const TABLE = resolvedTable(activatedRegistry(), NETWORK);
const [V1, V2] = TABLE;
const DEBOUNCE = 500;
const POLL = 5 * 60 * 1000;

// The fake database answers in macrotasks; a probe, a discard and a second
// probe need a few dozen of them to settle.
const flush = async (rounds = 60) => {
    for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setImmediate(resolve));
};

function manualTimers() {
    let now = 0;
    let sequence = 0;
    const timers = new Map();
    return {
        setTimer(callback, delay) {
            sequence += 1;
            timers.set(sequence, { at: now + delay, callback });
            return sequence;
        },
        clearTimer(id) { timers.delete(id); },
        async advance(ms) {
            const target = now + ms;
            for (;;) {
                const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
                    .sort((left, right) => left[1].at - right[1].at)[0];
                if (!next) break;
                now = next[1].at;
                timers.delete(next[0]);
                next[1].callback();
                await flush();
            }
            now = target;
            await flush();
        },
        pending: () => timers.size
    };
}

function fakeTarget(extra = {}) {
    const listeners = new Map();
    return {
        ...extra,
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(handler);
        },
        removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
        dispatch(type) { for (const handler of [...(listeners.get(type) || [])]) handler({ type }); },
        listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0)
    };
}

function fakeChannel() {
    const channel = fakeTarget();
    channel.posted = [];
    channel.closed = false;
    channel.postMessage = message => channel.posted.push(message);
    channel.close = () => { channel.closed = true; };
    channel.emit = () => channel.dispatch('message');
    return channel;
}

const noteSlot = deploymentId => ({
    version: 1, deploymentId, updatedAt: 5, state: { note_id: 5, expiry_ts: NOTE_EXPIRY, secret: 'SECRET' }
});
const draftSlot = deploymentId => ({
    version: 1, deploymentId, updatedAt: 5,
    depositQuote: { operationId: 'q', createdAt: 1, amount: 5, secret: 'SECRET', commitment: '0x01', next_note_id: 9, active_root: '0x02', zero_path: [] }
});
const withdrawalOf = (version, overrides = {}) => ({
    recordId: `${version.deploymentId}:7`, deploymentId: version.deploymentId, noteId: 7, mode: 'mutual',
    phase: 'closed_unconfirmed', updatedAt: 10, ...overrides
});

function seedWallet(env, { slot = null, withdrawals = [] } = {}) {
    env.idb.seed(DB, { version: 3, stores: {
        runtime: slot ? { records: { active: slot } } : {},
        withdrawals: { keyPath: 'recordId', records: Object.fromEntries(withdrawals.map(record => [record.recordId, record])) },
        deposits: { keyPath: 'recordId' }
    } });
}

function fakeClient() {
    const listeners = new Set();
    return {
        initialized: true, lastError: null, config: null, wallet: null, withdrawals: [], deposits: [], activities: [],
        snapshot() {
            return { config: this.config, wallet: this.wallet, withdrawals: this.withdrawals,
                deposits: this.deposits, activities: this.activities };
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        emit() { for (const listener of [...listeners]) listener(this.snapshot(), { reason: 'update' }); }
    };
}

// loaded: 'v1' (exit-only) or 'v2' (the deposit target).
function harness(t, { loaded = 'v2', slotReason = null, slotKind, probe = null, discard = null, build = null,
    allowDiscard = () => ({ allowed: true }), seed = {} } = {}) {
    const env = createFakeEnvironment();
    t.after(env.install());
    seedWallet(env, seed);
    resetActiveVersionForTests();
    t.after(resetActiveVersionForTests);
    const version = loaded === 'v1' ? V1 : V2;
    const selection = slotReason
        ? { ...chooseZkapiVersion({ table: TABLE, holdings: [] }), version, reason: slotReason, slotOwner: null }
        : chooseZkapiVersion({
            table: TABLE, slotKind,
            holdings: [{ deploymentId: version.deploymentId, runtime: true, withdrawals: [], credits: [] }]
        });
    installActiveVersion({ table: TABLE, version, selection });
    const client = fakeClient();
    const facade = createZkapiVersioning({
        buildTable: TABLE, network: NETWORK, now: () => NOW, sessionStorage: createFakeStorage(), localStorage: createFakeStorage()
    });
    // An initialized SDK that reached this version's own deployment.
    client.config = { funding: { contract_address: version.vault, chain_id: version.chainId } };
    facade.attach({
        client, runtime: { runtime: null, manifest: { deployment_id: version.deploymentId } }, integrity: 'ok'
    });
    t.after(() => facade.resetForTests());
    const timers = manualTimers();
    const windowTarget = fakeTarget();
    const documentTarget = fakeTarget({ visibilityState: 'visible' });
    const channel = fakeChannel();
    const calls = { probe: 0, discard: [], build: 0, record: 0 };
    const stop = startVersionWatcher({
        facade,
        table: TABLE,
        database: DB,
        readHoldings: probe ? async options => { calls.probe += 1; return probe(options); }
            : async options => { calls.probe += 1; return readWalletHoldings({ ...options, indexedDB: env.idb }); },
        discardDraft: async options => {
            calls.discard.push(options);
            return discard ? discard(options, calls.discard.length) : { discarded: false, why: 'not_discardable' };
        },
        fetchBuild: async () => { calls.build += 1; return typeof build === 'function' ? build(calls.build) : build; },
        recordDiscard: () => { calls.record += 1; return allowDiscard(calls.record); },
        network: NETWORK,
        windowTarget,
        documentTarget,
        createChannel: () => channel,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        debounceMs: DEBOUNCE,
        probeTimeoutMs: 50,
        buildPollMs: POLL
    });
    t.after(stop);
    return { env, facade, client, timers, windowTarget, documentTarget, channel, calls, stop };
}

// ------------------------------------------------------------ re-probes

test('focus re-probes after the debounce, once for a burst of events', async t => {
    const h = harness(t);
    assert.equal(h.facade.previewSelection(), null);
    h.windowTarget.dispatch('focus');
    h.windowTarget.dispatch('focus');
    h.documentTarget.dispatch('visibilitychange');
    await h.timers.advance(DEBOUNCE - 1);
    assert.equal(h.calls.probe, 0, 'not before the debounce');
    await h.timers.advance(1);
    assert.equal(h.calls.probe, 1, 'one probe for the whole burst');
    const preview = h.facade.previewSelection();
    assert.equal(preview.version.id, 'v2');
    assert.equal(preview.reason, 'no_runtime_note');
    assert.deepEqual(h.env.idb.committedWrites(), [], 'the watcher never writes');
});

test('a hidden page does not probe, a visible one does', async t => {
    const h = harness(t);
    h.documentTarget.visibilityState = 'hidden';
    h.documentTarget.dispatch('visibilitychange');
    await h.timers.advance(DEBOUNCE * 2);
    assert.equal(h.calls.probe, 0);
    h.documentTarget.visibilityState = 'visible';
    h.documentTarget.dispatch('visibilitychange');
    await h.timers.advance(DEBOUNCE);
    assert.equal(h.calls.probe, 1);
});

test('a message on the SDK wallet channel re-probes, and the watcher never posts', async t => {
    const h = harness(t);
    h.channel.emit();
    await h.timers.advance(DEBOUNCE);
    assert.equal(h.calls.probe, 1);
    assert.deepEqual(h.channel.posted, []);
});

test('an SDK snapshot change re-probes; an unchanged snapshot does not', async t => {
    const h = harness(t);
    // The baseline was read when the facade attached.
    h.client.emit();
    h.client.emit();
    await h.timers.advance(DEBOUNCE);
    assert.equal(h.calls.probe, 0, 'the normalized snapshot did not change');
    h.client.wallet = { has_note: true, note: { note_id: 5, expiry_ts: NOTE_EXPIRY } };
    h.client.emit();
    h.client.emit();
    await h.timers.advance(DEBOUNCE);
    assert.equal(h.calls.probe, 1, 'one probe for the change, none for its repeat');
    h.client.activities = [{ id: 'a1', status: 'running', kind: 'access' }];
    h.client.emit();
    await h.timers.advance(DEBOUNCE);
    assert.equal(h.calls.probe, 1, 'a change the adapter does not read is not a holdings change');
});

test('another tab moving the balance to the closed version makes this tab say reload', async t => {
    const h = harness(t, { loaded: 'v2' });
    seedWallet(h.env, { slot: noteSlot(V1.deploymentId) });
    h.windowTarget.dispatch('focus');
    await h.timers.advance(DEBOUNCE);
    const preview = h.facade.previewSelection();
    assert.equal(preview.version.id, 'v1');
    assert.equal(preview.reason, 'runtime_holds_note');
    const state = h.facade.state(NOW);
    assert.equal(state.phase, 'reload-required');
    assert.deepEqual({ ...state.reload, canReload: undefined }, {
        required: true, canReload: undefined, reason: 'moved_in_other_tab', targetId: 'v1'
    });
});

test('finishing the previous withdrawal elsewhere makes the previous-version tab say reload', async t => {
    const h = harness(t, { loaded: 'v1', slotReason: 'requested_previous', seed: { withdrawals: [withdrawalOf(V1)] } });
    // While the withdrawal is open the tab stays on the build that can finish it.
    h.windowTarget.dispatch('focus');
    await h.timers.advance(DEBOUNCE);
    assert.equal(h.facade.previewSelection().version.id, 'v1', 'the hint is honored by the preview');
    assert.equal(h.facade.state(NOW).reload.required, false);
    // Another tab finishes it: nothing is held, a fresh load picks the target.
    seedWallet(h.env, { slot: null, withdrawals: [withdrawalOf(V1, { phase: 'closed' })] });
    h.channel.emit();
    await h.timers.advance(DEBOUNCE);
    assert.equal(h.facade.previewSelection().version.id, 'v2');
    const state = h.facade.state(NOW);
    assert.equal(state.reload.required, true);
    assert.equal(state.reload.reason, 'previous_withdrawal_finished');
});

test('an unreadable or hung probe becomes holdings_unreadable and never throws', async t => {
    const failing = harness(t, { probe: async () => { throw new Error('IndexedDB broke'); } });
    failing.windowTarget.dispatch('focus');
    await failing.timers.advance(DEBOUNCE);
    assert.equal(failing.facade.previewSelection().reason, 'holdings_unreadable');

    const hung = harness(t, { probe: () => new Promise(() => {}) });
    hung.windowTarget.dispatch('focus');
    hung.timers.advance(DEBOUNCE);
    // The deadline is a real timer (probeTimeoutMs + 250).
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(hung.facade.previewSelection().reason, 'holdings_unreadable');
});

test('the preview is given the slot kind the probe classified', async t => {
    const h = harness(t, { loaded: 'v1', seed: { slot: draftSlot(V1.deploymentId) } });
    h.windowTarget.dispatch('focus');
    await h.timers.advance(DEBOUNCE);
    assert.equal(h.facade.previewSelection().slotKind, 'draft_only');
});

// --------------------------------------------------------- stale build latch

const closedBuild = {
    zkapi: { network: NETWORK, depositTarget: 'v3', versions: [{ id: 'v2', status: 'exit-only' }, { id: 'v3', status: 'active' }] }
};

test('buildClosesDeposits is restrict-only and ignores unrelated builds', () => {
    const loaded = { id: 'v2', status: 'active' };
    const target = { id: 'v2' };
    const same = { zkapi: { network: NETWORK, depositTarget: 'v2', versions: [{ id: 'v1', status: 'exit-only' }, { id: 'v2', status: 'active' }] } };
    const cases = [
        ['the same build', same, false],
        ['another deposit target', closedBuild, true],
        ['the loaded version no longer active, no target', { zkapi: { network: NETWORK, depositTarget: null, versions: [{ id: 'v2', status: 'exit-only' }] } }, true],
        ['the loaded version missing from a build that lists versions', { zkapi: { network: NETWORK, depositTarget: null, versions: [{ id: 'v1', status: 'active' }] } }, true],
        ['a null deposit target and the loaded version still active', { zkapi: { network: NETWORK, depositTarget: null, versions: [{ id: 'v2', status: 'active' }] } }, false],
        ['another network', { zkapi: { network: 'mainnet', depositTarget: 'v9', versions: [] } }, false],
        ['no zkapi section', { hash: 'abc' }, false],
        ['malformed zkapi section', { zkapi: 'nope' }, false],
        ['not an object', 'text', false],
        ['null', null, false],
        ['versions that is not a list', { zkapi: { network: NETWORK, depositTarget: null, versions: 'x' } }, false]
    ];
    for (const [label, build, expected] of cases) {
        assert.equal(buildClosesDeposits({ build, network: NETWORK, loaded, target }), expected, label);
    }
    // A loaded exit-only version is not told by the "still active" rule.
    assert.equal(buildClosesDeposits({
        build: { zkapi: { network: NETWORK, depositTarget: 'v2', versions: [{ id: 'v1', status: 'exit-only' }] } },
        network: NETWORK, loaded: { id: 'v1', status: 'exit-only' }, target: { id: 'v2' }
    }), false);
    // The first rule on its own: for a loaded exit-only version the "still
    // active" rule does not apply, so a changed deposit target is the only
    // evidence there is (the sepolia case: a fresh build names v3).
    assert.equal(buildClosesDeposits({
        build: { zkapi: { network: 'sepolia', depositTarget: 'v3', versions: [{ id: 'v1', status: 'exit-only' }] } },
        network: 'sepolia', loaded: { id: 'v1', status: 'exit-only' }, target: { id: 'v2' }
    }), true);
    // ...and a build with no target at all says nothing about it.
    assert.equal(buildClosesDeposits({
        build: { zkapi: { network: 'sepolia', depositTarget: null, versions: [{ id: 'v1', status: 'exit-only' }] } },
        network: 'sepolia', loaded: { id: 'v1', status: 'exit-only' }, target: { id: 'v2' }
    }), false);
    assert.equal(buildClosesDeposits({ build: same, network: NETWORK, loaded: null, target }), false);
    // Rollback: the target moved back.
    assert.equal(buildClosesDeposits({
        build: { zkapi: { network: NETWORK, depositTarget: 'v1', versions: [] } }, network: NETWORK, loaded, target
    }), true);
});

test('the watcher latches stale_build from a restrict-only /build.json diff and never unlatches', async t => {
    const h = harness(t, { loaded: 'v2', build: call => (call === 1 ? closedBuild : { zkapi: { network: NETWORK, depositTarget: 'v2', versions: [{ id: 'v2', status: 'active' }] } }) });
    assert.equal(h.facade.depositGate().canStart, true);
    await h.timers.advance(POLL);
    assert.equal(h.calls.build, 1);
    const gate = h.facade.depositGate();
    assert.equal(gate.canStart, false);
    assert.equal(gate.code, 'stale_build');
    assert.equal(h.facade.flags().staleBuild, true);
    // Only a reload clears it: later polls do not even ask again.
    await h.timers.advance(POLL * 3);
    assert.equal(h.calls.build, 1);
    assert.equal(h.facade.depositGate().code, 'stale_build');
});

test('a started deposit stays completable and exits stay untouched under the latch', async t => {
    const h = harness(t, { loaded: 'v2', build: closedBuild });
    h.client.config = { pending_deposit: { phase: 'submitted', transaction_hash: `0x${'11'.repeat(32)}`, amount: 5 } };
    await h.timers.advance(POLL);
    const gate = h.facade.depositGate();
    assert.equal(gate.canStart, false);
    assert.equal(gate.canResume, true);
    // Chat is not a deposit.
    assert.deepEqual(h.facade.sendGate(NOW), { canSend: true, code: null });
});

test('an unrelated deploy, a failing fetch and a hidden tab leave deposits alone', async t => {
    const unrelated = harness(t, { build: { hash: 'new-hash', zkapi: { network: NETWORK, depositTarget: 'v2', versions: [{ id: 'v1', status: 'exit-only' }, { id: 'v2', status: 'active' }] } } });
    await unrelated.timers.advance(POLL * 2);
    assert.equal(unrelated.calls.build, 2);
    assert.equal(unrelated.facade.depositGate().canStart, true);

    const failing = harness(t, { build: () => { throw new Error('offline'); } });
    await failing.timers.advance(POLL * 2);
    assert.equal(failing.facade.depositGate().canStart, true);

    const hidden = harness(t, { build: closedBuild });
    hidden.documentTarget.visibilityState = 'hidden';
    await hidden.timers.advance(POLL * 2);
    assert.equal(hidden.calls.build, 0, 'no background polling for a hidden tab');
    hidden.documentTarget.visibilityState = 'visible';
    hidden.documentTarget.dispatch('visibilitychange');
    await hidden.timers.advance(0);
    assert.equal(hidden.calls.build, 1, 'becoming visible checks at once');
    assert.equal(hidden.facade.depositGate().code, 'stale_build');
});

test('the build check does not depend on the update toast', async t => {
    // No toast, hash, or app object exists in this harness; the latch is the
    // watcher's own and fires from /build.json alone.
    const h = harness(t, { build: closedBuild });
    await h.timers.advance(POLL);
    assert.equal(h.facade.depositGate().code, 'stale_build');
});

// ---------------------------------------------------------- discard retry

test('a draft pinning the closed version is cleared when the lock frees, and the preview moves on', async t => {
    let attempt = 0;
    const h = harness(t, {
        loaded: 'v1', slotKind: 'draft_only', seed: { slot: draftSlot(V1.deploymentId) },
        discard: (options, count) => {
            attempt = count;
            if (count === 1) return { discarded: false, why: 'lock_busy' };
            // The write happens through the injected function: emulate it.
            seedWallet(h.env, { slot: null });
            return { discarded: true };
        }
    });
    h.windowTarget.dispatch('focus');
    await h.timers.advance(DEBOUNCE);
    assert.equal(attempt, 1);
    assert.equal(h.calls.discard[0].expectedDeploymentId, V1.deploymentId);
    assert.equal(h.facade.previewSelection().version.id, 'v1', 'still pinned while the lock is busy');
    assert.equal(h.facade.flags().draftDiscarded, false);
    // The retry is scheduled by the watcher itself (a few seconds later).
    await h.timers.advance(10_000 + DEBOUNCE);
    assert.equal(attempt, 2);
    assert.equal(h.facade.flags().draftDiscarded, true);
    assert.equal(h.facade.previewSelection().version.id, 'v2');
    assert.equal(h.facade.state(NOW).reload.reason, 'draft_cleared');
});

test('a pinned draft is counted against the loop guard once, before its first attempt', async t => {
    const h = harness(t, {
        loaded: 'v1', seed: { slot: draftSlot(V1.deploymentId) },
        discard: () => ({ discarded: false, why: 'lock_busy' })
    });
    h.windowTarget.dispatch('focus');
    await h.timers.advance(DEBOUNCE);
    assert.equal(h.calls.record, 1);
    assert.equal(h.calls.discard.length, 1);
});

// A busy wallet lock means another tab is mid-operation, not that two builds
// are trading writes. Nothing was written, so it must not use up the budget
// that exists to catch a draft that keeps coming back.
test('a lock that stays busy retries a few times without ever raising the close-other-tabs notice', async t => {
    const h = harness(t, {
        loaded: 'v1', seed: { slot: draftSlot(V1.deploymentId) },
        discard: () => ({ discarded: false, why: 'lock_busy' }),
        // The guard would refuse from its third count on.
        allowDiscard: count => ({ allowed: count <= 2 })
    });
    h.windowTarget.dispatch('focus');
    await h.timers.advance(DEBOUNCE);
    for (let step = 0; step < 8; step += 1) {
        await h.timers.advance(10_000 + DEBOUNCE);
        assert.equal(h.facade.flags().discardLoop, false, `after retry ${step + 1}`);
    }
    assert.equal(h.calls.discard.length, 7, 'one attempt and six retries, then it stops');
    assert.equal(h.calls.record, 1, 'counted once for the pin, not once per retry');
    assert.equal(h.facade.flags().discardLoop, false);
    assert.equal(h.facade.previewSelection().version.id, 'v1', 'still pinned: the person has the cancel button');
});

test('a draft that keeps coming back is refused on the third discard, and the notice is raised', async t => {
    const h = harness(t, {
        loaded: 'v1', seed: { slot: draftSlot(V1.deploymentId) },
        allowDiscard: count => ({ allowed: count <= 2 }),
        discard: () => {
            // The write succeeded, and a pre-rollout tab put its draft right back.
            seedWallet(h.env, { slot: draftSlot(V1.deploymentId) });
            return { discarded: true };
        }
    });
    for (let round = 0; round < 4; round += 1) {
        h.windowTarget.dispatch('focus');
        await h.timers.advance(DEBOUNCE);
    }
    assert.equal(h.calls.discard.length, 2, 'two successful discards, then the guard refuses');
    assert.ok(h.calls.record >= 3, 'each new pin is counted again, so the cap on successful discards holds');
    assert.equal(h.facade.flags().discardLoop, true);
});

test('a pin that went away is forgotten: the next draft is a new pin with its own count', async t => {
    const h = harness(t, {
        loaded: 'v1', seed: { slot: draftSlot(V1.deploymentId) },
        discard: () => ({ discarded: false, why: 'lock_busy' })
    });
    h.windowTarget.dispatch('focus');
    await h.timers.advance(DEBOUNCE);
    assert.equal(h.calls.record, 1);
    // Another tab cleared the draft; the watcher sees a clean wallet.
    seedWallet(h.env, { slot: null });
    await h.timers.advance(10_000 + DEBOUNCE);
    assert.equal(h.calls.discard.length, 1);
    // A different draft appears later.
    seedWallet(h.env, { slot: draftSlot(V1.deploymentId) });
    h.windowTarget.dispatch('focus');
    await h.timers.advance(DEBOUNCE);
    assert.equal(h.calls.record, 2);
    assert.equal(h.calls.discard.length, 2);
});

test('when the loop guard refuses, nothing is discarded and the loop notice is raised', async t => {
    const h = harness(t, {
        loaded: 'v1', seed: { slot: draftSlot(V1.deploymentId) }, allowDiscard: () => ({ allowed: false })
    });
    h.windowTarget.dispatch('focus');
    await h.timers.advance(DEBOUNCE);
    assert.equal(h.calls.discard.length, 0);
    assert.equal(h.facade.flags().discardLoop, true);
    assert.equal(h.facade.previewSelection().version.id, 'v1');
});

test('only a draft or never-sent plan on a non-target version is ever discarded', async t => {
    const cases = [
        ['a note on the closed version', { slot: noteSlot(V1.deploymentId) }],
        ['a started deposit', { slot: { version: 1, deploymentId: V1.deploymentId, updatedAt: 5,
            pendingDeposit: { operationId: 'o', phase: 'submitted', amount: 5, submissionId: 'claim', transactionHash: '0x1' } } }],
        ['a draft on the deposit target', { slot: draftSlot(V2.deploymentId) }],
        ['an empty wallet', {}]
    ];
    for (const [label, seed] of cases) {
        const h = harness(t, { loaded: 'v1', seed });
        h.windowTarget.dispatch('focus');
        await h.timers.advance(DEBOUNCE);
        assert.equal(h.calls.discard.length, 0, label);
        assert.equal(h.calls.record, 0, label);
    }
});

// --------------------------------------------------------------- lifecycle

test('stop removes every listener and timer', async t => {
    const h = harness(t);
    assert.ok(h.windowTarget.listenerCount() > 0);
    assert.ok(h.documentTarget.listenerCount() > 0);
    assert.ok(h.channel.listenerCount() > 0);
    h.windowTarget.dispatch('focus');
    h.stop();
    assert.equal(h.windowTarget.listenerCount(), 0);
    assert.equal(h.documentTarget.listenerCount(), 0);
    assert.equal(h.channel.listenerCount(), 0);
    assert.equal(h.channel.closed, true);
    assert.equal(h.timers.pending(), 0);
    await h.timers.advance(POLL * 2);
    assert.equal(h.calls.probe, 0);
    assert.equal(h.calls.build, 0);
    h.stop();
});

test('the watcher needs the facade, the table and the database', () => {
    assert.throws(() => startVersionWatcher({ table: TABLE, database: DB }), /facade/);
    assert.throws(() => startVersionWatcher({ facade: { watch: {} }, table: 'x', database: DB }), /table/);
    assert.throws(() => startVersionWatcher({ facade: { watch: {} }, table: TABLE, database: '' }), /database/);
});
