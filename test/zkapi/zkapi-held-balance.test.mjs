// A balance this browser holds and the page cannot read.
//
// A version's SDK did not start (its operator did not answer), while the
// host's own read of the wallet database says the slot holds a note of that
// version. The SDK's snapshot then has no note, which every surface used to
// read as an empty balance ("$0.00", "Add funds", "Deposits moved"). These
// tests pin the state that says what is true (`held`, the phase
// `balance-unreachable`, `service_unreachable` where a verdict said `no_note`),
// the words, what is and is not offered, that no operator address or SDK text
// reaches the page, and that nothing changes when the SDK started, the slot is
// empty or the build has one version.
//
// The state derivation, the adapters, the facade and the UI helpers are the
// real ones. The wallet database is the fake IndexedDB written by the REAL
// legacy wallet store and read by the REAL boot probe; the client is a stand-in
// that holds exactly what the real legacy client held when its manifest
// answered 503 (test/fixtures/zkapi-legacy-start-failed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createZkapiVersioning, zkapiVersioning } from '../../chat/zkapi/versioning/index.js';
import { createVersionUi } from '../../chat/zkapi/versioning/ui.js';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import { deriveUpgradeStage } from '../../chat/zkapi/versioning/upgradeFlow.mjs';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { chooseZkapiVersion, selectZkapiVersion } from '../../chat/zkapi/versioning/versionLoader.mjs';
import { installActiveVersion, resetActiveVersionForTests } from '../../chat/zkapi/versioning/activeVersion.mjs';
import { copyTokens, versionCopyText } from '../../chat/zkapi/versioning/copy.mjs';
import {
    buildVersionNotices, handleVersionAction, patchVersionNotices, renderVersionBanner, renderVersionBadge
} from '../../chat/zkapi/components/VersionNotices.js';
import { renderBalanceExtras } from '../../chat/zkapi/components/BalanceExtras.js';
import {
    renderDepositsClosedView, renderHeldBalanceView, renderUpgradeView
} from '../../chat/zkapi/components/UpgradeView.js';
import { explainZkapiError, versionRefusalMessage, zkapiErrorMessage } from '../../chat/zkapi/services/zkapiErrorCopy.mjs';
import { createZkapiChatRuntimeCore } from '../../chat/zkapi/services/zkapiChatRuntimeCore.mjs';
import { deriveZkapiUxState } from '../../chat/zkapi/services/zkapiUxState.mjs';
import { createDocument } from './_miniDom.mjs';
import { createFakeEnvironment, createFakeStorage } from './_fakeIndexedDb.mjs';
import {
    NOW_MS, activatedRegistry, normalizedSnapshot, partialRevertRegistry, resolvedTable, validRegistry
} from './_registryFixtures.mjs';

const NETWORK = 'mainnet';
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const DAY = 86_400;
// v1 is exit-only with a deposit target, v2 is the target.
const TABLE = resolvedTable(activatedRegistry(), NETWORK);
const [V1, V2] = TABLE;
const FIXTURE = JSON.parse(fs.readFileSync(
    new URL('../fixtures/zkapi-legacy-start-failed/client.json', import.meta.url), 'utf8'
));
const OPERATOR_TRACES = /zkapi-operator\.invalid|config\.json|\(503\)|HTTP 503|https?:\/\//i;

function selectionFor(version, overrides = {}) {
    return {
        version, reason: 'runtime_holds_note', slotOwner: version.id, open: {}, credits: {},
        foreignDeploymentId: null, depositBlock: null, draftDiscarded: false, slotKind: 'note', ...overrides
    };
}

// What the facade's own verdict says for a snapshot with no note.
const NO_NOTE = Object.freeze({ available: false, kind: null, blockedBy: 'no_note' });

function derive(overrides = {}) {
    const active = overrides.active || V1;
    return deriveVersionState({
        table: TABLE,
        active,
        target: TABLE.find(row => row.status === 'active') || null,
        selection: selectionFor(active),
        snapshot: normalizedSnapshot(),
        intent: null,
        previewSelection: null,
        now: NOW_MS,
        busy: false,
        admissionClosed: false,
        buildClosed: false,
        configBlock: false,
        unreachable: false,
        adapter: getAdapter(active.adapter),
        ...overrides
    });
}

const noteSnapshot = (days = 20, overrides = {}) => normalizedSnapshot({
    hasNote: true,
    expiryTs: NOW_SECONDS + days * DAY,
    deadlines: [{ source: 'slot', expiryTs: NOW_SECONDS + days * DAY }],
    ...overrides
});

// The one state every other test starts from: v1, exit-only, start failed.
const held = (overrides = {}) => derive({ initFailed: true, abandon: NO_NOTE, ...overrides });

const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

test('a balance the page holds and cannot read is held, not empty, and offers nothing that needs the SDK', () => {
    const state = held();
    assert.deepEqual(state.held, { unreachable: true });
    assert.equal(state.holding, 'previous');
    assert.equal(state.phase, 'balance-unreachable');
    assert.deepEqual(state.upgrade, { available: false, canStart: false, blockedBy: 'service_unreachable', stage: 'idle' });
    assert.deepEqual(state.abandon, { available: false, kind: null, blockedBy: 'service_unreachable' });
    // Deposits are closed on this version, with its successor named.
    assert.deepEqual(state.gate, {
        canStart: false, canResume: false, code: 'deposits_closed', successor: { id: 'v2', label: 'Version 2' }
    });
    assert.equal(state.depositsOpen, false);
    // Nothing is claimed about the balance: no deadline, no amount, no records.
    assert.equal(state.show, true);
    assert.equal(state.expiryTs, null);
    assert.equal(state.closeByTs, null);
    assert.equal(state.reminderTier, null);
    assert.equal(state.exit, null);
    assert.equal(state.previous, null);
    assert.equal(state.unsent, false);
    assert.deepEqual(state.payouts, { credited: 0, alerts: 0 });
    assert.deepEqual(state.reload, { required: false, canReload: true, reason: null, targetId: null });
    // JSON-plain and stable, so it can be part of a change signature.
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
    // A verdict that offered to give the balance up (it had a note to look at)
    // is no more believed here than any other fact about a snapshot that has
    // nothing in it, and says why.
    assert.deepEqual(held({ abandon: { available: true, kind: 'zero', blockedBy: null } }).abandon,
        { available: false, kind: null, blockedBy: 'service_unreachable' });
    // No verdict computed is none shown.
    assert.equal(held({ abandon: null }).abandon, null);
});

test('the same facts with a started SDK that reads no note stay the empty balance they were', () => {
    for (const initFailed of [false, undefined]) {
        const state = derive({ initFailed, abandon: NO_NOTE });
        assert.equal(state.held, null);
        assert.equal(state.holding, 'none');
        assert.equal(state.phase, 'current');
        assert.deepEqual(state.upgrade, { available: false, canStart: false, blockedBy: null, stage: 'idle' });
        assert.deepEqual(state.abandon, NO_NOTE);
    }
});

test('only a failed start, a slot held for this deployment and a snapshot with no note make a held balance', () => {
    const rows = [
        ['the slot is empty', { selection: selectionFor(V1, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }) }],
        ['the slot holds only a deposit draft', { selection: selectionFor(V1, { slotKind: 'draft_only' }) }],
        ['the slot holds an unsent plan', { selection: selectionFor(V1, { slotKind: 'unsent_prepared' }) }],
        ['the slot holds a deposit in flight', { selection: selectionFor(V1, { slotKind: 'pending_deposit' }) }],
        ['the slot holds something unclassified', { selection: selectionFor(V1, { slotKind: 'other' }) }],
        ['another version holds the slot', { selection: selectionFor(V1, { slotOwner: 'v2' }) }],
        ['the slot belongs to no version this build knows', {
            selection: selectionFor(V1, { reason: 'unknown_deployment', slotOwner: null, depositBlock: 'foreign_runtime' })
        }],
        ['the page could not read the wallet', {
            selection: selectionFor(V1, { reason: 'holdings_unreadable', slotOwner: null, depositBlock: 'holdings_unreadable' })
        }],
        ['the SDK reads a note', { snapshot: noteSnapshot() }],
        ['the SDK reads a set-aside note', {
            snapshot: normalizedSnapshot({ deadlines: [{ source: 'set-aside', expiryTs: NOW_SECONDS + 5 * DAY, recordId: 'r' }] })
        }]
    ];
    for (const [name, overrides] of rows) {
        const state = derive({ initFailed: true, abandon: NO_NOTE, ...overrides });
        assert.equal(state.held, null, name);
        assert.notEqual(state.phase, 'balance-unreachable', name);
        assert.notEqual(state.upgrade.blockedBy, 'service_unreachable', name);
        assert.notEqual(state.abandon?.blockedBy, 'service_unreachable', name);
    }
    // The SDK that reads a note is the ordinary balance of an exit-only version.
    const reads = derive({ initFailed: true, snapshot: noteSnapshot() });
    assert.equal(reads.holding, 'previous');
    assert.equal(reads.upgrade.available, true);
});

test('a held balance on the deposit target is held on the current version, with nothing to move to', () => {
    // The facade's verdict for the version that takes deposits is "not
    // applicable" before it ever looks for a note.
    const state = derive({
        active: V2, initFailed: true, abandon: { available: false, kind: null, blockedBy: 'not_applicable' }
    });
    assert.deepEqual(state.held, { unreachable: true });
    assert.equal(state.holding, 'current');
    assert.equal(state.phase, 'balance-unreachable');
    // There is no upgrade from the version that takes deposits, so nothing is
    // blocked. Its deposits are closed for as long as the balance cannot be
    // read: the SDK that would start the deposit is the one that did not start.
    assert.deepEqual(state.upgrade, { available: false, canStart: false, blockedBy: null, stage: 'idle' });
    assert.deepEqual(state.gate, { canStart: false, canResume: false, code: 'holdings_unreadable', successor: null });
    assert.equal(state.depositsOpen, true);
    assert.equal(state.abandon.blockedBy, 'not_applicable');
    // The verdict that is only true because nothing could be read is renamed
    // wherever it was given.
    assert.equal(derive({ active: V2, initFailed: true, abandon: NO_NOTE }).abandon.blockedBy, 'service_unreachable');
});

test('a fresher read of the wallet decides: a balance that moved is not held, one that stayed is', () => {
    const moved = derive({
        initFailed: true,
        previewSelection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' })
    });
    assert.equal(moved.held, null);
    assert.equal(moved.holding, 'none');
    assert.equal(moved.reload.required, true);
    assert.equal(moved.phase, 'reload-required');
    // A preview that finds the same owner without a finer kind keeps the boot's.
    const stayed = derive({
        initFailed: true,
        previewSelection: selectionFor(V1, { slotKind: 'other' })
    });
    assert.deepEqual(stayed.held, { unreachable: true });
    // A preview that could not read the wallet says nothing: the boot read stands.
    const unreadable = derive({
        initFailed: true,
        previewSelection: selectionFor(V2, { reason: 'holdings_unreadable', slotOwner: null, depositBlock: 'holdings_unreadable' })
    });
    assert.deepEqual(unreadable.held, { unreachable: true });
    assert.equal(unreadable.phase, 'balance-unreachable');
});

test('a held balance comes before the phases that would speak from an empty snapshot', () => {
    // A paused service says "you can still withdraw", which is not true while
    // the SDK is not running; a closed admission and a previous version's
    // withdrawal are about a snapshot with nothing in it.
    const paused = held({ serviceRefusal: { code: 'deployment_manifest_unavailable' } });
    assert.equal(paused.phase, 'balance-unreachable');
    assert.equal(paused.service.code, 'deployment_manifest_unavailable');
    assert.equal(held({ admissionClosed: true }).phase, 'balance-unreachable');
    const withPrevious = held({
        selection: selectionFor(V1, { open: { v2: [{ recordId: 'w', noteId: 3, mode: 'escape', phase: 'pending', expiryTs: NOW_SECONDS + 3 * DAY }] } })
    });
    assert.equal(withPrevious.phase, 'balance-unreachable');
    // But a page that must reload is told that first.
    const reload = held({
        previewSelection: selectionFor(V2, { reason: 'runtime_holds_note', slotOwner: 'v2' })
    });
    assert.equal(reload.reload.required, true);
    assert.equal(reload.phase, 'reload-required');
    assert.equal(reload.held, null);
});

test('no step of an upgrade is narrated for a balance that cannot be read', () => {
    for (const viewOpen of [false, true]) {
        const state = held({ viewOpen });
        assert.equal(state.upgrade.stage, 'idle');
        assert.equal(deriveUpgradeStage({ versionState: state, viewOpen, withdrawalPhase: 'prepared' }), 'idle');
    }
    // An intent that says the withdrawal ended does not turn it into one.
    const intent = { v: 1, network: NETWORK, from: 'v1', to: 'v2', stage: 'withdrawn', since: NOW_MS - 1000 };
    assert.equal(derive({ active: V2, initFailed: true, intent }).upgrade.stage, 'idle');
    // The same facts with a started SDK keep their stage.
    assert.equal(derive({ active: V2, snapshot: noteSnapshot(), intent }).upgrade.stage, 'done');
    assert.equal(derive({ snapshot: noteSnapshot(), viewOpen: true }).upgrade.stage, 'review');
});

test('a held state is derived from the input and does not change it', () => {
    const input = {
        table: TABLE, active: V1, target: V2, selection: selectionFor(V1), snapshot: normalizedSnapshot(),
        intent: null, previewSelection: null, now: NOW_MS, busy: false, admissionClosed: false, buildClosed: false,
        configBlock: false, unreachable: false, initFailed: true, adapter: getAdapter('note-bound-v1'), abandon: NO_NOTE
    };
    const before = JSON.stringify({ ...input, adapter: null });
    const state = deriveVersionState(input);
    assert.equal(JSON.stringify({ ...input, adapter: null }), before);
    assert.deepEqual(state.held, { unreachable: true });
    // An input that is not a record is the fail-closed shape, with no held fact.
    for (const bad of [null, undefined, 'x']) assert.equal(deriveVersionState(bad).held, null);
});

// ---------------------------------------------------------------------------
// Words and notices
// ---------------------------------------------------------------------------

const HELD_WORDS = 'Your balance is still saved in this browser. Version 1’s service isn’t available right '
    + 'now, so the balance can’t be shown yet. Reload to check again. To use version 2, '
    + 'first withdraw this balance from version 1.';

test('the notice says the balance is saved, the service is not available and what version 2 needs, with Reload', () => {
    const state = held();
    for (const surface of ['panel', 'dialog']) {
        const { notices } = buildVersionNotices(state, { surface, table: TABLE });
        assert.deepEqual(notices.map(entry => entry.id), ['held'], surface);
        const [notice] = notices;
        assert.equal(notice.tone, 'attention');
        assert.deepEqual(notice.paragraphs.map(paragraph => paragraph.text), [HELD_WORDS]);
        assert.deepEqual(notice.actions.map(action => [action.action, action.label, action.disabled]),
            [['reload', 'Reload', false]]);
        assert.equal(notice.dismissible, false);
    }
    // The banner carries it, as static text with one button.
    const html = renderVersionBanner(state, { surface: 'panel', table: TABLE });
    assert.match(html, /data-zkapi-version-notice="held"/);
    assert.match(html, /data-zkapi-version-action="reload"/);
    assert.equal((html.match(/data-zkapi-version-action=/g) || []).length, 1);
    assert.equal(textOf(html).includes(HELD_WORDS), true);
    // The old story is gone: no moved deposits, no way to add funds.
    assert.doesNotMatch(textOf(html), /Deposits moved|no longer accepts|Add funds|Upgrade|Withdraw your/i);
    assert.doesNotMatch(html, /data-zkapi-version-action="check-service"/);
    assert.doesNotMatch(html, /data-zkapi-version-notice="gate"/);
    assert.doesNotMatch(html, OPERATOR_TRACES);
});

test('the gate that explains closed deposits is not said beside it, and a safety block is covered by the same Reload', () => {
    const state = held();
    assert.equal(state.gate.code, 'deposits_closed');
    const ids = buildVersionNotices(state, { surface: 'dialog', table: TABLE }).notices.map(entry => entry.id);
    assert.deepEqual(ids, ['held']);
    // A newer build's "reload to update" and a served-config mismatch have the
    // same remedy as this notice, so there is one Reload, not two.
    for (const flag of [{ buildClosed: true }, { configBlock: true }]) {
        const blocked = held(flag);
        assert.equal(blocked.phase === 'balance-unreachable' || blocked.phase === 'reload-required', true);
        const entries = buildVersionNotices(blocked, { surface: 'panel', table: TABLE }).notices;
        assert.deepEqual(entries.map(entry => entry.id), ['held']);
    }
});

test('a held balance on the deposit target says it without a newer version to use', () => {
    const state = derive({ active: V2, initFailed: true, abandon: NO_NOTE });
    const [notice] = buildVersionNotices(state, { surface: 'dialog', table: TABLE }).notices;
    assert.equal(notice.id, 'held');
    assert.equal(
        notice.paragraphs[0].text,
        'Your balance is still saved in this browser. Version 2’s service isn’t available right now, so '
        + 'the balance can’t be shown yet. Reload to check again.'
    );
});

test('the ticket surface does not carry it: nothing about this balance is at risk there', () => {
    const state = held();
    assert.deepEqual(buildVersionNotices(state, { surface: 'ticket', table: TABLE }).notices, []);
    assert.equal(renderVersionBanner(state, { surface: 'ticket', table: TABLE }), '');
});

test('no notice that needs the SDK is drawn for a held balance, whatever else the state carries', () => {
    // A hand-built state that also carries facts only a started SDK reports.
    const state = {
        ...held(),
        exit: { nearExpiry: true, mustInitiateByMs: NOW_MS + 1000, boundAtState: '100', stateFresh: false,
            escapeAtMs: null, frozen: { untilMs: NOW_MS + 5000, mode: 'x' }, deviceNotNewest: false,
            wait: { kind: 'settlement', untilMs: NOW_MS + 5000, escapeAtMs: NOW_MS + 5000, mustInitiateByMs: null, boundAtState: '5' },
            kit: { exported: false, outOfDate: true, depositPathSaved: null, unsaved: false },
            rpc: { recommended: false, wrongChain: false } },
        payouts: { credited: 1, alerts: 1 },
        setAside: { near: 1, earliestMustInitiateByMs: NOW_MS + 1000, device: 0 },
        abandon: { available: true, kind: 'zero', blockedBy: null }
    };
    const { notices } = buildVersionNotices(state, { surface: 'dialog', table: TABLE });
    assert.deepEqual(notices.map(entry => entry.id), ['held']);
    assert.equal(renderBalanceExtras(state, { canExport: true }), '');
});

test('Reload is held back while work is in flight, with the reason beside it', () => {
    const state = held({ busy: true });
    assert.equal(state.reload.canReload, false);
    const [notice] = buildVersionNotices(state, { surface: 'panel', table: TABLE }).notices;
    assert.deepEqual(notice.actions.map(action => [action.action, action.disabled, action.hint]),
        [['reload', true, 'reload.busy']]);
    const html = renderVersionBanner(state, { surface: 'panel', table: TABLE });
    assert.match(html, /data-zkapi-version-action="reload" disabled aria-describedby="zkapi-version-hint-panel-held"/);
    assert.match(html, /Finish the current step first\./);
});

test('the clock patches the notice in place and asks for a render only when its structure moves', () => {
    const document = createDocument();
    const state = held();
    const root = document.createElement('div');
    root.innerHTML = renderVersionBadge(state, { surface: 'panel' })
        + renderVersionBanner(state, { surface: 'panel', table: TABLE });
    assert.deepEqual(patchVersionNotices(root, state, { now: NOW_MS, surface: 'panel', table: TABLE }), { needsRender: false });
    // The balance became readable: the block is replaced, not patched.
    const readable = derive({ snapshot: noteSnapshot() });
    assert.deepEqual(patchVersionNotices(root, readable, { now: NOW_MS, surface: 'panel', table: TABLE }), { needsRender: true });
    // And the other way: a page that showed nothing now needs the notice.
    const empty = document.createElement('div');
    assert.deepEqual(patchVersionNotices(empty, state, { now: NOW_MS, surface: 'panel', table: TABLE }), { needsRender: true });
});

test('the pill still names the protocol version that holds the balance', () => {
    const html = renderVersionBadge(held(), { surface: 'panel' });
    assert.match(html, /data-zkapi-version-badge[^>]*>zkAPI v0\.1<\/span>/);
});

test('Reload reloads the page, and nothing in this state starts a withdrawal, an upgrade or a give-up', async () => {
    const state = held();
    const calls = { reload: 0, dispatched: [], switches: [] };
    const facade = {
        state: () => state,
        requestSwitch: input => { calls.switches.push(input); return { ok: true }; }
    };
    const answer = await handleVersionAction('reload', {
        facade, state, reload: () => { calls.reload += 1; }, dispatch: (name, detail) => calls.dispatched.push([name, detail])
    });
    assert.deepEqual(answer, { ok: true });
    // No reason to switch to another build: the same version is loaded again.
    assert.equal(calls.reload, 1);
    assert.deepEqual(calls.switches, []);
    assert.deepEqual(calls.dispatched, []);
    // A busy page refuses the reload and says why.
    const notes = [];
    const busy = await handleVersionAction('reload', {
        facade, state: { ...state, reload: { ...state.reload, canReload: false } }, reload: () => { calls.reload += 1; },
        notify: text => notes.push(text)
    });
    assert.deepEqual(busy, { ok: false, why: 'busy' });
    assert.equal(calls.reload, 1);
    assert.deepEqual(notes, ['Finish the current step first.']);
});

// ---------------------------------------------------------------------------
// The dialog's views
// ---------------------------------------------------------------------------

test('the held view says the same words, in the balance dialog and in the deposits-closed view', () => {
    const state = held();
    const view = renderHeldBalanceView({ state, table: TABLE });
    assert.match(view, /data-zkapi-balance-held/);
    assert.match(view, /<h3 class="zkapi-section-title">Saved in this browser<\/h3>/);
    assert.equal(textOf(view).includes(HELD_WORDS), true);
    assert.match(view, /data-zkapi-version-action="reload"/);
    assert.equal((view.match(/data-zkapi-version-action=/g) || []).length, 1);
    // The deposits-closed view is this view for a held balance, whatever the
    // gate says (closed for an exit-only version, closed for its own reason on
    // the target).
    assert.equal(renderDepositsClosedView({ state, unsent: false, table: TABLE }), view);
    const target = derive({ active: V2, initFailed: true, abandon: NO_NOTE });
    assert.equal(target.gate.canStart, false);
    assert.equal(renderDepositsClosedView({ state: target, unsent: false, table: TABLE }),
        renderHeldBalanceView({ state: target, table: TABLE }));
    assert.notEqual(renderDepositsClosedView({ state: target, unsent: false, table: TABLE }), '');
    // Nothing of the old story.
    for (const html of [view, renderDepositsClosedView({ state, unsent: false, table: TABLE })]) {
        assert.doesNotMatch(textOf(html), /Deposits have moved|Deposits moved|no longer accepts|Add funds|Upgrade|Withdraw/);
        assert.doesNotMatch(html, /data-zkapi-gate-code|data-upgrade-|id="zkapi-withdraw|id="zkapi-deposit/);
        assert.doesNotMatch(html, OPERATOR_TRACES);
    }
});

test('the held view is empty for a balance the page can read, and Reload waits while work is in flight', () => {
    assert.equal(renderHeldBalanceView({ state: derive({ snapshot: noteSnapshot() }) }), '');
    for (const bad of [null, undefined, {}, { state: null }, { state: 'x' }]) assert.equal(renderHeldBalanceView(bad), '');
    // Not held: the closed view is what it was.
    const closed = derive({ selection: selectionFor(V1, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }) });
    assert.match(renderDepositsClosedView({ state: closed, unsent: false, table: TABLE }), /Deposits have moved/);
    const busy = renderHeldBalanceView({ state: held(), table: TABLE, busy: true });
    assert.match(busy, /data-zkapi-version-action="reload" disabled aria-describedby="zkapi-held-reload-hint"/);
    assert.match(busy, /id="zkapi-held-reload-hint"[^>]*>Finish the current step first\./);
});

test('an upgrade view asked for a held balance is the held view, not the first step of an upgrade', () => {
    const state = held();
    for (const stage of ['review', 'withdrawing', 'confirming', 'ready_to_switch', 'blocked', 'idle']) {
        const html = renderUpgradeView({ state, stage, table: TABLE, withdrawalHtml: '<button id="zkapi-withdraw-btn">x</button>' });
        assert.equal(html, renderHeldBalanceView({ state, table: TABLE }), stage);
        assert.doesNotMatch(html, /zkapi-withdraw-btn|data-zkapi-upgrade-view|data-upgrade-step/);
    }
    // A blocked view that is asked for by the verdict alone says why.
    const blocked = { ...state, held: null, upgrade: { ...state.upgrade, stage: 'blocked' } };
    const html = renderUpgradeView({ state: blocked, stage: 'blocked', table: TABLE });
    assert.match(html, /data-upgrade-blocked="service_unreachable"/);
    assert.equal(textOf(html).includes(HELD_WORDS), true);
});

// ---------------------------------------------------------------------------
// The version UI helpers and the words of an error
// ---------------------------------------------------------------------------

function startErrors() {
    const start = Object.assign(new Error(FIXTURE.errors.start.message), { name: FIXTURE.errors.start.name });
    const refresh = Object.assign(new Error(FIXTURE.errors.refresh.message), {
        name: FIXTURE.errors.refresh.name, status: FIXTURE.errors.refresh.status
    });
    return { start, refresh };
}

test('an error is told in plain words only when the facade says it is what stopped the start', () => {
    const { start, refresh } = startErrors();
    const facade = { isStartFailure: error => error === start || error === refresh };
    const summary = versionCopyText('held.summary');
    assert.equal(versionRefusalMessage(start, { facade }), summary);
    assert.equal(versionRefusalMessage(refresh, { facade }), summary);
    assert.equal(versionRefusalMessage(new Error('Something else broke'), { facade }), null);
    // A cause is looked through; a non-error and a facade that cannot answer are "not that".
    assert.equal(versionRefusalMessage(Object.assign(new Error('wrapped'), { cause: start }), { facade: {
        isStartFailure: error => error.cause === start
    } }), summary);
    assert.equal(versionRefusalMessage('text', { facade }), null);
    assert.equal(versionRefusalMessage(start, { facade: null }), null);
    assert.equal(versionRefusalMessage(start, { facade: {} }), null);
    assert.equal(versionRefusalMessage(start, { facade: { isStartFailure() { throw new Error('x'); } } }), null);
    // The words carry no address and no SDK text.
    assert.doesNotMatch(summary, OPERATOR_TRACES);
    // explainZkapiError rewrites the error the way it does every other state.
    const explained = explainZkapiError(start, { facade });
    assert.equal(explained, start);
    assert.equal(start.message, summary);
});

test('the other protocol-version errors keep their own words beside the held one', () => {
    const facade = { isStartFailure: () => true };
    const retiring = Object.assign(new Error('retiring'), { code: 'deployment_retiring' });
    assert.equal(versionRefusalMessage(retiring, { facade, table: TABLE, active: V2, selection: selectionFor(V2) })
        .includes('no longer starting new chats'), true);
});

test('the UX state tells a failed start in plain words when the balance is held, and in the SDK’s words otherwise', () => {
    const { start } = startErrors();
    const snapshot = { ...FIXTURE.client.snapshot, lastError: start, activities: [] };
    const summary = versionCopyText('held.summary');
    const withHeld = deriveZkapiUxState({ snapshot, version: held(), now: NOW_MS });
    assert.equal(withHeld.primary.phase, 'error');
    assert.equal(withHeld.primary.title, 'Private balance unavailable');
    assert.equal(withHeld.primary.detail, summary);
    assert.equal(withHeld.composerPrimary.detail, summary);
    assert.equal(withHeld.balancePrimary.detail, summary);
    assert.doesNotMatch(JSON.stringify(withHeld.primary), OPERATOR_TRACES);
    // Without the fact (a build with one version, or a start that failed with
    // nothing held) the SDK's message is what it always was.
    for (const version of [null, undefined, derive({ initFailed: false }), derive({ initFailed: true, snapshot: noteSnapshot() })]) {
        const plain = deriveZkapiUxState({ snapshot, version, now: NOW_MS });
        assert.equal(plain.primary.detail, start.message);
    }
});

// ---------------------------------------------------------------------------
// The facade, end to end over a real wallet database and the real legacy store
// ---------------------------------------------------------------------------

const DB = 'zkapi-browser-wallet-v1';
const legacyStorePath = fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/store'));
let storeInstance = 0;
const loadLegacyStore = () => import(`${pathToFileURL(legacyStorePath).href}?held=${++storeInstance}`);

// ETH at $3000: $1.00 is 333,334 gwei.
const QUOTE = {
    asset: 'native_eth', units_per_eth: 1_000_000_000, chain_id: 1, feed_address: `0x${'ab'.repeat(20)}`,
    decimals: 8, round_id: '77', answer: '300000000000', updated_at: NOW_SECONDS - 100, expires_at: NOW_SECONDS + 4400
};

// The legacy client in the state the fixture recorded, with the means to fail
// its start, to fail a refresh and to come back with the balance readable.
function legacyClient(version) {
    const listeners = new Set();
    const errors = startErrors();
    const client = {
        initialized: FIXTURE.client.initialized,
        browserMode: FIXTURE.client.browserMode,
        lastError: null,
        config: FIXTURE.client.snapshot.config,
        wallet: FIXTURE.client.snapshot.wallet,
        withdrawals: [],
        deposits: [],
        activities: [],
        noteExpiryClaim: null,
        errors,
        get nativePriceQuote() { return this.initialized ? QUOTE : null; },
        snapshot() {
            return { ...FIXTURE.client.snapshot, config: this.config, wallet: this.wallet, withdrawals: this.withdrawals,
                deposits: this.deposits, activities: this.activities, lastError: this.lastError, initialized: this.initialized };
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        emit(reason) { for (const listener of [...listeners]) listener(this.snapshot(), { reason }); },
        // The legacy client attempts its start once and replays the rejection
        // (the same error object) to every later caller.
        init() {
            return this.initialized ? Promise.resolve(this.snapshot()) : Promise.reject(errors.start);
        },
        failStart() { this.lastError = errors.start; this.emit('error'); },
        failRefresh() { this.lastError = errors.refresh; this.emit('error'); },
        // A refresh that a host answers with its own page (see the fixture's
        // pageAnsweredRefresh): it succeeds, clears the error and does not
        // start the client.
        answerWithPage() {
            const answered = FIXTURE.pageAnsweredRefresh;
            this.lastError = answered.lastError;
            this.config = structuredClone(answered.config);
            this.wallet = structuredClone(answered.wallet);
            this.withdrawals = [...answered.withdrawals];
            this.deposits = [...answered.deposits];
            this.emit('runtime');
        },
        // The operator answers on the next load: the SDK starts, binds the
        // runtime to the deployment it reached, and reads the note.
        recover(balance, runtime = null) {
            if (runtime) runtime.manifest = { deployment_id: version.deploymentId };
            this.initialized = true;
            this.browserMode = true;
            this.lastError = null;
            this.config = { funding: { contract_address: version.vault, chain_id: version.chainId }, request_charge_cap: 50_000 };
            this.wallet = {
                has_note: true, pending_request: false,
                note: { note_id: 7, current_balance: balance, deposit_amount: 12_000_000, expiry_ts: NOW_SECONDS + 20 * DAY }
            };
            this.emit('runtime');
        }
    };
    return client;
}

// A page that booted over a wallet holding a note of version 1: the REAL
// store writes it, the REAL probe reads it, and the facade is attached to a
// client whose operator did not answer.
async function withHeldPage(balance, callback, { table = TABLE, abandon = true, started = false, holder = 'v1' } = {}) {
    const environment = createFakeEnvironment();
    const restore = environment.install();
    resetActiveVersionForTests();
    let facade = null;
    try {
        const store = await loadLegacyStore();
        const version = table.find(row => row.id === holder);
        await store.writeBrowserWallet({
            deploymentId: version.deploymentId,
            state: { note_id: 7, deposit_amount: 12_000_000, current_balance: balance,
                expiry_ts: NOW_SECONDS + 20 * DAY, secret: 'SECRET-NOTE-MARKER' }
        });
        const selection = await selectZkapiVersion({ table, database: DB });
        installActiveVersion({ table, version: selection.version, selection });
        const clock = { now: NOW_MS };
        const calls = { abandon: [], reloads: 0 };
        facade = createZkapiVersioning({
            buildTable: table, network: NETWORK, now: () => clock.now,
            sessionStorage: createFakeStorage(), localStorage: createFakeStorage(),
            reload: () => { calls.reloads += 1; },
            setTimer: () => 0, clearTimer: () => {}
        });
        const client = legacyClient(selection.version);
        const runtime = { runtime: null, manifest: null };
        if (started) client.recover(balance, runtime);
        facade.attach({
            client, runtime, integrity: 'ok', ui: createVersionUi({ facade }),
            ...(abandon ? { abandonNote: async args => { calls.abandon.push(args); return { done: true, kind: 'dust' }; } } : {})
        });
        return await callback({ facade, client, runtime, selection, clock, calls, version: selection.version, table });
    } finally {
        facade?.resetForTests();
        resetActiveVersionForTests();
        restore();
    }
}

// 10,000,000 gwei is $30 (above the dust line), 100,000 is $0.30, 0 is empty.
const HOLDERS = [['above the dust line', 10_000_000, null], ['dust', 100_000, 'dust'], ['zero', 0, 'zero']];

for (const [name, balance, kind] of HOLDERS) {
    test(`a ${name} legacy balance whose operator is down is held, never empty, and nothing is offered`, async () => {
        await withHeldPage(balance, async ({ facade, client, selection, calls }) => {
            // What the boot probe really said.
            assert.equal(selection.reason, 'runtime_holds_note');
            assert.equal(selection.slotKind, 'note');
            assert.equal(selection.slotOwner, 'v1');
            // The start has not failed yet: nothing is claimed.
            assert.equal(facade.state(NOW_MS).held, null);
            client.failStart();
            const state = facade.state(NOW_MS);
            assert.deepEqual(state.held, { unreachable: true });
            assert.equal(state.holding, 'previous');
            assert.equal(state.phase, 'balance-unreachable');
            assert.deepEqual(state.upgrade, { available: false, canStart: false, blockedBy: 'service_unreachable', stage: 'idle' });
            assert.deepEqual(state.abandon, { available: false, kind: null, blockedBy: 'service_unreachable' });
            assert.deepEqual(facade.depositGate(), {
                canStart: false, canResume: false, code: 'deposits_closed', successor: { id: 'v2', label: 'Version 2' }
            });

            // Nothing that needs the SDK is offered, and asking for it does nothing.
            assert.equal(facade.abandonPreview(), null);
            assert.deepEqual(await facade.giveUpBalance({ noteId: 7, balanceUnits: String(balance) }),
                { done: false, why: 'unavailable' });
            assert.deepEqual(calls.abandon, []);
            assert.equal(facade.upgradeStage(), 'idle');

            // The dialog and the panel say the one honest thing.
            const ui = facade.ui;
            const dialog = ui.banner(state, { surface: 'dialog', now: NOW_MS });
            const panel = ui.banner(state, { surface: 'panel', now: NOW_MS });
            for (const html of [dialog, panel, ui.heldBalance({ state }), ui.depositsClosedView({ state, unsent: false })]) {
                assert.equal(textOf(html).includes(HELD_WORDS), true);
                assert.doesNotMatch(textOf(html), /Deposits moved|Deposits have moved|Add funds|Upgrade/);
                assert.doesNotMatch(html, OPERATOR_TRACES);
            }
            assert.equal(ui.banner(state, { surface: 'ticket', now: NOW_MS }), '');
            assert.equal(ui.balanceExtras({ state }), '');

            // The SDK's own words never reach the page, whichever error it holds.
            assert.equal(ui.refusalMessage(client.errors.start), versionCopyText('held.summary'));
            assert.equal(ui.refusalMessage(new Error('Unrelated failure')), null);
            // An error the client never held is not its failure to start.
            assert.equal(ui.refusalMessage(client.errors.refresh), null);
            client.failRefresh();
            assert.equal(ui.refusalMessage(client.errors.refresh), versionCopyText('held.summary'));
        });
    });
}

test('the error a refresh replaces the start error with is told the same way', async () => {
    await withHeldPage(10_000_000, async ({ facade, client }) => {
        client.failStart();
        client.failRefresh();
        // The page's state does not depend on which error the client holds.
        assert.deepEqual(facade.state(NOW_MS).held, { unreachable: true });
        assert.equal(facade.isStartFailure(client.errors.start), true);
        assert.equal(facade.isStartFailure(client.errors.refresh), true);
        assert.equal(facade.isStartFailure(Object.assign(new Error('x'), { cause: client.errors.start })), true);
        assert.equal(facade.isStartFailure(new Error('Unable to load https://zkapi-operator.invalid/config.json (503).')), false,
            'the same words from another error object are not the client’s failure');
        assert.equal(facade.isStartFailure(null), false);
        assert.equal(facade.isStartFailure('text'), false);
        // The error that the toast, the status line and the panel hold.
        const toast = { error: client.errors.refresh };
        explainZkapiError(toast.error, { facade });
        assert.equal(toast.error.message, versionCopyText('held.summary'));
    });
});

test('subscribers hear the failure of the start and the return of the balance', async () => {
    await withHeldPage(100_000, async ({ facade, client, runtime }) => {
        const heard = [];
        facade.subscribe(state => heard.push(state.phase));
        client.failStart();
        assert.deepEqual(heard, ['balance-unreachable']);
        // The same state again is not announced, whether the client holds the
        // error of a later refresh or none at all while a retry is under way.
        client.failRefresh();
        assert.deepEqual(heard, ['balance-unreachable']);
        client.answerWithPage();
        assert.deepEqual(heard, ['balance-unreachable']);
        client.recover(100_000, runtime);
        assert.equal(heard.length, 2);
        assert.notEqual(heard[1], 'balance-unreachable');
        assert.equal(facade.state(NOW_MS).held, null);
        assert.equal(facade.isStartFailure(client.errors.start), false, 'no balance is held any more');
    });
});

test('the balance is the ordinary one once the service is back, and equal to a page that started', async () => {
    for (const [, balance, kind] of HOLDERS) {
        await withHeldPage(balance, async ({ facade, client, runtime }) => {
            client.failStart();
            assert.equal(facade.state(NOW_MS).phase, 'balance-unreachable');
            client.recover(balance, runtime);
            const recovered = facade.state(NOW_MS);
            assert.equal(recovered.held, null);
            assert.equal(recovered.holding, 'previous');
            if (kind) {
                assert.deepEqual(recovered.abandon, { available: true, kind, blockedBy: null });
                assert.equal(recovered.upgrade.available, true);
            } else {
                assert.equal(recovered.upgrade.canStart, true);
                assert.equal(recovered.phase, 'upgrade-available');
            }
            // A page whose operator answered from the start has the same state.
            await withHeldPage(balance, async ({ facade: control }) => {
                assert.deepEqual(control.state(NOW_MS), recovered);
                assert.equal(control.state(NOW_MS).held, null);
            }, { started: true });
        });
    }
});

test('a page that holds nothing, and a page with one version, are not told about a held balance', async () => {
    // An empty slot: the same failed start is only an unavailable service.
    const environment = createFakeEnvironment();
    const restore = environment.install();
    resetActiveVersionForTests();
    try {
        const selection = await selectZkapiVersion({ table: TABLE, database: DB });
        assert.equal(selection.reason, 'no_runtime_note');
        installActiveVersion({ table: TABLE, version: selection.version, selection });
        const facade = createZkapiVersioning({
            buildTable: TABLE, network: NETWORK, now: () => NOW_MS,
            sessionStorage: createFakeStorage(), localStorage: createFakeStorage(), setTimer: () => 0, clearTimer: () => {}
        });
        const client = legacyClient(selection.version);
        facade.attach({ client, runtime: { runtime: null, manifest: null }, integrity: 'ok', ui: null });
        client.failStart();
        const state = facade.state(NOW_MS);
        assert.equal(state.held, null);
        assert.equal(state.holding, 'none');
        assert.notEqual(state.phase, 'balance-unreachable');
        assert.equal(facade.isStartFailure(client.errors.start), false);
        assert.equal(versionRefusalMessage(client.errors.start, { facade }), null);
        facade.resetForTests();
    } finally {
        resetActiveVersionForTests();
        restore();
    }

    // One live version, deposit target: today's page. No state, no helpers.
    const single = resolvedTable(validRegistry(), NETWORK);
    const alone = createZkapiVersioning({
        buildTable: single, network: NETWORK, now: () => NOW_MS,
        sessionStorage: createFakeStorage(), localStorage: createFakeStorage(), setTimer: () => 0, clearTimer: () => {}
    });
    resetActiveVersionForTests();
    installActiveVersion({ table: single, version: single[0], selection: selectionFor(single[0], { reason: 'single_version', slotOwner: null, slotKind: 'empty' }) });
    try {
        const client = legacyClient(single[0]);
        alone.attach({ client, runtime: { runtime: null, manifest: null }, integrity: 'ok' });
        client.failStart();
        assert.equal(alone.state(NOW_MS), null);
        assert.equal(alone.ui, null);
        assert.equal(alone.isStartFailure(client.errors.start), false);
        assert.deepEqual(alone.depositGate(), { canStart: true, canResume: false, code: null, successor: null });
        assert.equal(versionRefusalMessage(client.errors.start, { facade: alone }), null);
    } finally {
        alone.resetForTests();
        resetActiveVersionForTests();
    }
});

test('a lone exit-only version has no probe to know a balance by, so its failed start reads as it did', async () => {
    const lone = resolvedTable(partialRevertRegistry(), NETWORK);
    assert.equal(lone.filter(row => row.status !== 'retired').length, 1);
    resetActiveVersionForTests();
    const selection = selectionFor(lone[0], { reason: 'single_version', slotOwner: null, slotKind: 'empty' });
    installActiveVersion({ table: lone, version: lone[0], selection });
    const facade = createZkapiVersioning({
        buildTable: lone, network: NETWORK, now: () => NOW_MS,
        sessionStorage: createFakeStorage(), localStorage: createFakeStorage(), setTimer: () => 0, clearTimer: () => {}
    });
    try {
        const client = legacyClient(lone[0]);
        facade.attach({ client, runtime: { runtime: null, manifest: null }, integrity: 'ok', ui: null });
        client.failStart();
        const state = facade.state(NOW_MS);
        assert.equal(state.held, null);
        assert.equal(state.holding, 'none');
        assert.equal(state.gate.code, 'deposits_closed');
    } finally {
        facade.resetForTests();
        resetActiveVersionForTests();
    }
});

test('the page-wide error words use the same facade: a toast for the failed start is the plain sentence', async () => {
    // The singleton is what zkapiErrorMessage asks, so it is attached for this one.
    await (async () => {
        const environment = createFakeEnvironment();
        const restore = environment.install();
        resetActiveVersionForTests();
        try {
            const store = await loadLegacyStore();
            await store.writeBrowserWallet({
                deploymentId: V1.deploymentId,
                state: { note_id: 7, deposit_amount: 12_000_000, current_balance: 10_000_000,
                    expiry_ts: NOW_SECONDS + 20 * DAY, secret: 'SECRET-NOTE-MARKER' }
            });
            const selection = await selectZkapiVersion({ table: TABLE, database: DB });
            installActiveVersion({ table: TABLE, version: selection.version, selection });
            const client = legacyClient(selection.version);
            zkapiVersioning.attach({ client, runtime: { runtime: null, manifest: null }, integrity: 'ok',
                storage: createFakeStorage() });
            // Without a build table the singleton reads the installed one.
            client.failStart();
            assert.equal(zkapiVersioning.multiVersion, true);
            const message = zkapiErrorMessage(client.errors.start, 'The wallet could not complete this request.');
            assert.equal(message, versionCopyText('held.summary'));
            assert.doesNotMatch(message, OPERATOR_TRACES);
            // An error that is not the client's keeps its own words.
            assert.equal(zkapiErrorMessage(new Error('Network down'), 'fallback'), 'Network down');
        } finally {
            zkapiVersioning.resetForTests();
            resetActiveVersionForTests();
            restore();
        }
    })();
});

test('copyTokens names the version that holds the balance and the one deposits go to', () => {
    const tokens = copyTokens(held());
    assert.equal(tokens.F, '1');
    assert.equal(tokens.N, '2');
    assert.equal('P' in tokens, false);
    assert.equal('R' in tokens, false);
});

// ---------------------------------------------------------------------------
// A failed start is remembered until the client says it started
// ---------------------------------------------------------------------------

const noOperatorText = value => assert.doesNotMatch(JSON.stringify(value), OPERATOR_TRACES);

test('a refresh that a host answers with its own page leaves the balance held, not empty', async () => {
    for (const [name, balance] of HOLDERS) {
        await withHeldPage(balance, async ({ facade, client, calls }) => {
            const heard = [];
            facade.subscribe(state => heard.push(state.phase));
            client.failStart();
            const before = facade.state(NOW_MS);
            assert.deepEqual(before.held, { unreachable: true }, name);
            assert.deepEqual(heard, ['balance-unreachable'], name);

            // What the real client holds after the balance dialog's quiet
            // refresh on a host that serves its page for any path: no error,
            // a "config" and a "wallet" that are text, and not started.
            client.answerWithPage();
            assert.equal(client.initialized, false);
            assert.equal(client.lastError, null);
            const after = facade.state(NOW_MS);
            assert.deepEqual(after, before, name);
            assert.deepEqual(after.held, { unreachable: true }, name);
            assert.equal(after.phase, 'balance-unreachable', name);
            assert.equal(after.holding, 'previous', name);
            assert.equal(after.upgrade.blockedBy, 'service_unreachable', name);
            assert.equal(after.abandon.blockedBy, 'service_unreachable', name);
            // Said once: the same state is not announced again.
            assert.deepEqual(heard, ['balance-unreachable'], name);

            // Nothing is offered, and the words are still the held ones.
            assert.equal(facade.abandonPreview(), null, name);
            assert.deepEqual(await facade.giveUpBalance({ noteId: 7, balanceUnits: String(balance) }),
                { done: false, why: 'unavailable' }, name);
            assert.deepEqual(calls.abandon, [], name);
            const ui = facade.ui;
            for (const html of [
                ui.banner(after, { surface: 'panel', now: NOW_MS }), ui.banner(after, { surface: 'dialog', now: NOW_MS }),
                ui.heldBalance({ state: after }), ui.depositsClosedView({ state: after, unsent: false })
            ]) {
                assert.equal(textOf(html).includes(HELD_WORDS), true, name);
                assert.doesNotMatch(textOf(html), /Deposits moved|Deposits have moved|Add funds|Upgrade/, name);
            }
        });
    }
});

test('the error that stopped the start is still told in plain words after a refresh cleared it', async () => {
    await withHeldPage(10_000_000, async ({ facade, client }) => {
        client.failStart();
        client.answerWithPage();
        assert.equal(facade.isStartFailure(client.errors.start), true);
        assert.equal(facade.ui.refusalMessage(client.errors.start), versionCopyText('held.summary'));
        // An error the client never held is still not its failure to start.
        assert.equal(facade.isStartFailure(new Error('Unrelated failure')), false);
        // A later failure of a refresh joins it, and the page-answered refresh
        // after that changes nothing again.
        client.failRefresh();
        client.answerWithPage();
        assert.equal(facade.isStartFailure(client.errors.refresh), true);
        assert.deepEqual(facade.state(NOW_MS).held, { unreachable: true });
    });
});

test('a client that started is not a failed start, whatever it reports or reads afterwards', async () => {
    await withHeldPage(100_000, async ({ facade, client, runtime }) => {
        client.failStart();
        client.answerWithPage();
        assert.deepEqual(facade.state(NOW_MS).held, { unreachable: true });
        // The service came back and the SDK started.
        client.recover(100_000, runtime);
        assert.equal(facade.state(NOW_MS).held, null);
        // An error it reports now is the error of a started client.
        client.lastError = client.errors.refresh;
        client.emit('error');
        assert.equal(facade.state(NOW_MS).held, null);
        assert.equal(facade.isStartFailure(client.errors.refresh), false);
        // A started client that reads no note (the balance left in another
        // tab) is the empty balance the facade always said, not the start that
        // failed before it.
        client.lastError = null;
        client.wallet = { has_note: false, note: null };
        client.emit('runtime');
        const empty = facade.state(NOW_MS);
        assert.equal(empty.held, null);
        assert.notEqual(empty.phase, 'balance-unreachable');
        assert.equal(empty.upgrade.blockedBy === 'service_unreachable', false);
    });
});

test('a client that started and was then reset is a start in progress, not the failure it had', async () => {
    await withHeldPage(100_000, async ({ facade, client, runtime }) => {
        client.failStart();
        assert.deepEqual(facade.state(NOW_MS).held, { unreachable: true });
        client.recover(100_000, runtime);
        assert.equal(facade.state(NOW_MS).held, null);
        // Reset: nothing initialized, nothing read, no error.
        Object.assign(client, { initialized: false, config: null, wallet: null, lastError: null });
        client.emit('runtime');
        assert.equal(facade.state(NOW_MS).held, null);
        assert.equal(facade.isStartFailure(client.errors.start), false);
    });
});

test('a facade attached to another client does not carry the failure of the first', async () => {
    await withHeldPage(100_000, async ({ facade, client, selection }) => {
        client.failStart();
        client.answerWithPage();
        assert.deepEqual(facade.state(NOW_MS).held, { unreachable: true });
        // A client that never started and never failed is a start in progress.
        const fresh = legacyClient(selection.version);
        facade.attach({ client: fresh, runtime: { runtime: null, manifest: null }, integrity: 'ok', ui: createVersionUi({ facade }) });
        assert.equal(facade.state(NOW_MS).held, null);
        assert.notEqual(facade.state(NOW_MS).phase, 'balance-unreachable');
        assert.equal(facade.isStartFailure(client.errors.start), false);
        // A page-answered refresh alone is not a failure either.
        fresh.answerWithPage();
        assert.equal(facade.state(NOW_MS).held, null);
        // And its own failure is its own.
        fresh.failStart();
        assert.deepEqual(facade.state(NOW_MS).held, { unreachable: true });
        assert.equal(facade.isStartFailure(fresh.errors.start), true);
        assert.equal(facade.isStartFailure(client.errors.start), false);
    });
});

test('a previous version that failed to start stays unreachable through a refresh that cleared the error', () => {
    // The page was asked to open version 1 for its unfinished withdrawal (the
    // wallet slot is empty); its SDK could not start.
    const selection = chooseZkapiVersion({
        table: TABLE, prefer: 'v1',
        holdings: [{ deploymentId: V1.deploymentId, runtime: false, credits: [],
            withdrawals: [{ recordId: 'w1', noteId: 3, mode: 'escape', phase: 'pending', expiryTs: NOW_SECONDS + 3 * DAY }] }]
    });
    assert.equal(selection.reason, 'requested_previous');
    resetActiveVersionForTests();
    installActiveVersion({ table: TABLE, version: selection.version, selection });
    const facade = createZkapiVersioning({
        buildTable: TABLE, network: NETWORK, now: () => NOW_MS,
        sessionStorage: createFakeStorage(), localStorage: createFakeStorage(), setTimer: () => 0, clearTimer: () => {}
    });
    try {
        const client = legacyClient(selection.version);
        facade.attach({ client, runtime: { runtime: null, manifest: null }, integrity: 'ok', ui: null });
        assert.notEqual(facade.state(NOW_MS).phase, 'legacy-unreachable');
        client.failStart();
        assert.equal(facade.state(NOW_MS).phase, 'legacy-unreachable');
        client.answerWithPage();
        assert.equal(client.lastError, null);
        assert.equal(facade.state(NOW_MS).phase, 'legacy-unreachable');
        // Not a held balance: the slot is empty, and nothing here is saved "in this browser" as a note.
        assert.equal(facade.state(NOW_MS).held, null);
    } finally {
        facade.resetForTests();
        resetActiveVersionForTests();
    }
});

test('the deposit target holding a balance it cannot read has its deposits closed, with Reload as the remedy', async () => {
    await withHeldPage(10_000_000, async ({ facade, client, runtime, version }) => {
        assert.equal(version.id, 'v2');
        assert.deepEqual(facade.depositGate(), { canStart: true, canResume: false, code: null, successor: null });
        client.failStart();
        const closed = { canStart: false, canResume: false, code: 'holdings_unreadable', successor: null };
        assert.deepEqual(facade.depositGate(), closed);
        // Held through a refresh that cleared the error, and with the held words.
        client.answerWithPage();
        assert.deepEqual(facade.depositGate(), closed);
        const state = facade.state(NOW_MS);
        assert.deepEqual(state.held, { unreachable: true });
        assert.equal(state.holding, 'current');
        assert.deepEqual(buildVersionNotices(state, { surface: 'dialog', table: TABLE }).notices.map(entry => entry.id), ['held']);
        // A deposit attempt is refused with a plain sentence, not the held one's
        // "Reload" button's twin: the gate's own words.
        const refused = Object.assign(new Error('closed'), { code: 'deposits_closed', data: { gateCode: 'holdings_unreadable' } });
        assert.equal(versionRefusalMessage(refused, { facade, table: TABLE, active: V2, selection: selectionFor(V2) }),
            versionCopyText('deposits.blocked.unreadable'));
        // The balance is readable again and deposits are what they were.
        client.recover(10_000_000, runtime);
        assert.deepEqual(facade.depositGate(), { canStart: true, canResume: false, code: null, successor: null });
    }, { holder: 'v2' });
});

test('a held balance only restricts the gate: every other reason keeps its own code', () => {
    // On the target, a served-config mismatch, a stale build and a previous
    // version's open withdrawal each close the gate for their own reason.
    assert.equal(derive({ active: V2, initFailed: true, configBlock: true }).gate.code, 'config_mismatch');
    assert.equal(derive({ active: V2, initFailed: true, buildClosed: true }).gate.code, 'stale_build');
    const blocked = derive({
        active: V2, initFailed: true,
        selection: selectionFor(V2, { open: { v1: [{ recordId: 'w', noteId: 3, mode: 'escape', phase: 'pending', expiryTs: NOW_SECONDS + 3 * DAY }] } })
    });
    assert.deepEqual(blocked.held, { unreachable: true });
    assert.equal(blocked.gate.code, 'previous_withdrawal_open');
    // The exit-only version's own reason stays, and nothing is held without the fact.
    assert.equal(derive({ initFailed: true }).gate.code, 'deposits_closed');
    assert.equal(derive({ active: V2 }).gate.canStart, true);
    assert.equal(derive({ active: V2, initFailed: false, snapshot: noteSnapshot() }).gate.canStart, true);
});

// ---------------------------------------------------------------------------
// What a send says when the start failed over a held balance
// ---------------------------------------------------------------------------

function chatRuntime(client, versioning, extra = {}) {
    return createZkapiChatRuntimeCore({
        client,
        backend: { id: 'private', requestAccess: async () => ({}) },
        modelConfiguration: { getDefaultModelConfig: () => ({ defaultModelId: 'model' }) },
        createInferenceService: ({ backends }) => ({ requestAccess: (session, options) => backends[0].requestAccess({ ...options, session }) }),
        versioning,
        ...extra
    });
}

test('a send over a held balance is refused in plain words, with no operator address', async () => {
    await withHeldPage(10_000_000, async ({ facade, client }) => {
        client.failStart();
        assert.deepEqual(facade.state(NOW_MS).held, { unreachable: true });
        const runtime = chatRuntime(client, facade);
        // The SDK replays the error that stopped its start to every caller.
        const raw = client.errors.start;
        assert.match(raw.message, /zkapi-operator\.invalid/);
        await assert.rejects(runtime.checkCanSend({ sessionId: 'next' }), error => {
            assert.equal(error, raw, 'the same error, reworded once');
            assert.equal(error.message, versionCopyText('held.summary'));
            noOperatorText(error.message);
            return true;
        });
        // A later send, after the host answered a refresh with its page, says the same.
        client.answerWithPage();
        await assert.rejects(runtime.checkCanSend({ sessionId: 'next' }), { message: versionCopyText('held.summary') });
    });
});

test('closing a chat key over a held balance says the same, and the transition carries no operator address', async () => {
    await withHeldPage(10_000_000, async ({ facade, client }) => {
        client.failStart();
        const runtime = chatRuntime(client, facade);
        // First thing that asks the SDK to start on this page: the settlement
        // that needs it (nothing reworded the error before).
        assert.match(client.errors.start.message, /zkapi-operator\.invalid/);
        await assert.rejects(runtime.retireSessionAccess('next'), error => {
            assert.equal(error.message, versionCopyText('held.summary'));
            return true;
        });
        assert.equal(runtime.getTransition().phase, 'error');
        assert.equal(runtime.getTransition().message, versionCopyText('held.summary'));
        noOperatorText(runtime.getTransition().message);
    });
});

test('a settlement that has to start the SDK again says the same, whichever call raised the failure', async () => {
    await withHeldPage(10_000_000, async ({ facade, client }) => {
        client.failStart();
        // The start call itself answers; the settlement's own start (a retry
        // that fails with an error of its own) is what raises the failure.
        client.init = async () => {};
        const raised = Object.assign(new Error(FIXTURE.errors.refresh.message), { name: FIXTURE.errors.refresh.name });
        const runtime = chatRuntime(client, facade, {
            settleAccess: async () => {
                // The client reports the new failure to its subscribers before it throws.
                client.lastError = raised;
                client.emit('error');
                throw raised;
            }
        });
        await assert.rejects(runtime.retireSessionAccess('next'), error => {
            assert.equal(error, raised);
            assert.equal(error.message, versionCopyText('held.summary'));
            return true;
        });
        assert.equal(runtime.getTransition().message, versionCopyText('held.summary'));
        // An error the settlement raises for another reason is left as it was.
        const refused = Object.assign(new Error('The key service refused: balance too small'), { code: 'balance_too_small' });
        const other = chatRuntime(client, facade, { settleAccess: async () => { throw refused; } });
        await assert.rejects(other.retireSessionAccess('next'), { message: 'The key service refused: balance too small' });
    });
});

test('an error of the start that is not the held balance’s failure keeps the SDK’s words', async () => {
    await withHeldPage(10_000_000, async ({ facade, client }) => {
        client.failStart();
        // A refusal the version words would reword on any other surface; it
        // came from the start but is not what stopped this client, so the
        // SDK's own text stands for it.
        const other = Object.assign(new Error('Retiring: the SDK’s own text'), { code: 'deployment_retiring' });
        client.init = () => Promise.reject(other);
        const runtime = chatRuntime(client, facade);
        await assert.rejects(runtime.checkCanSend({ sessionId: 'next' }), error => {
            assert.equal(error, other);
            assert.equal(error.message, 'Retiring: the SDK’s own text');
            return true;
        });
        // The page's other surfaces do reword it: only the start leaves it be.
        assert.notEqual(explainZkapiError(Object.assign(new Error('x'), { code: 'deployment_retiring' }), { facade }).message, 'x');
    });
});

test('a send says what the SDK said when no balance is held, and when the page has no facade', async () => {
    await withHeldPage(10_000_000, async ({ client }) => {
        client.failStart();
        // No facade at all (a build with one version): the SDK's words.
        const bare = chatRuntime(client, null);
        await assert.rejects(bare.checkCanSend({ sessionId: 'next' }), { message: FIXTURE.errors.start.message });
        // A facade that does not know the start failure (a stand-in) says nothing either.
        const unaware = chatRuntime(client, { isStartFailure: () => false });
        await assert.rejects(unaware.checkCanSend({ sessionId: 'next' }), { message: FIXTURE.errors.start.message });
        const throwing = chatRuntime(client, { isStartFailure() { throw new Error('x'); } });
        await assert.rejects(throwing.checkCanSend({ sessionId: 'next' }), { message: FIXTURE.errors.start.message });
    });
    // An empty slot: the same failed start is only an unavailable service, in
    // the SDK's own words, even with the page's facade.
    const environment = createFakeEnvironment();
    const restore = environment.install();
    resetActiveVersionForTests();
    let facade = null;
    try {
        const selection = await selectZkapiVersion({ table: TABLE, database: DB });
        installActiveVersion({ table: TABLE, version: selection.version, selection });
        facade = createZkapiVersioning({
            buildTable: TABLE, network: NETWORK, now: () => NOW_MS,
            sessionStorage: createFakeStorage(), localStorage: createFakeStorage(), setTimer: () => 0, clearTimer: () => {}
        });
        const client = legacyClient(selection.version);
        facade.attach({ client, runtime: { runtime: null, manifest: null }, integrity: 'ok', ui: null });
        client.failStart();
        const runtime = chatRuntime(client, facade);
        await assert.rejects(runtime.checkCanSend({ sessionId: 'next' }), { message: FIXTURE.errors.start.message });
    } finally {
        facade?.resetForTests();
        resetActiveVersionForTests();
        restore();
    }
});

// ---------------------------------------------------------------------------
// The chat bar says it when the client no longer holds the error
// ---------------------------------------------------------------------------

test('the UX state keeps saying a held balance is unavailable after the client cleared its error', () => {
    const answered = FIXTURE.pageAnsweredRefresh;
    const snapshot = { config: answered.config, wallet: answered.wallet, withdrawal: null, withdrawals: [],
        deposits: [], activities: [], lastError: null, initialized: false, loading: false };
    const summary = versionCopyText('held.summary');
    const state = deriveZkapiUxState({ snapshot, version: held(), now: NOW_MS });
    assert.equal(state.primary.phase, 'error');
    assert.equal(state.primary.title, 'Private balance unavailable');
    assert.equal(state.primary.detail, summary);
    assert.equal(state.primary.blocksSend, true);
    assert.equal(state.composerPrimary.detail, summary);
    assert.equal(state.balancePrimary.detail, summary);
    // Without the fact an unfunded wallet is what it was: nothing is invented.
    for (const version of [null, undefined, derive({ initFailed: false })]) {
        const plain = deriveZkapiUxState({ snapshot, version, now: NOW_MS });
        assert.equal(plain.primary.phase, 'unfunded');
        assert.equal(plain.primary.title, 'Add funds to start chatting');
    }
});
