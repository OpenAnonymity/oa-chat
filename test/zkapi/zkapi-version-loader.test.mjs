// Which protocol version a page loads (chat/zkapi/versioning/versionLoader.mjs).
//
// Pins the decision table rows 1 to 7 for N versions, the one-shot `prefer`
// validation, the unreadable-holdings handling, the credit handling, purity,
// and the probe -> draft discard -> re-decide orchestration (with injected
// probes and, end to end, with the real probe over the fake IndexedDB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chooseZkapiVersion, selectZkapiVersion } from '../../chat/zkapi/versioning/versionLoader.mjs';
import { canDiscard, noteDiscard, recordDiscard } from '../../chat/zkapi/versioning/switchProtocol.mjs';
import {
    getActiveAdapter, getActiveVersion, getSelection, getVersionTable, installActiveVersion, resetActiveVersionForTests
} from '../../chat/zkapi/versioning/activeVersion.mjs';
import noteBoundV1 from '../../chat/zkapi/versioning/adapters/noteBoundV1.mjs';
import concessionV1 from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { createFakeEnvironment, createFakeStorage } from './_fakeIndexedDb.mjs';

const DB = 'zkapi-browser-wallet-v1';

function version(id, ordinal, status, overrides = {}) {
    return {
        id,
        ordinal,
        label: `Version ${ordinal}`,
        adapter: ordinal === 1 ? 'note-bound-v1' : 'concession-v1',
        circuitId: `circuit-${id}`,
        vaultRevision: ordinal === 1 ? 1 : 3,
        status,
        depositsOpen: status === 'active',
        depositsClosedSince: status === 'exit-only' ? 1_700_000_000_000 : null,
        admissionClosesAt: null,
        deploymentId: `deployment-${id}`,
        chainId: 11155111,
        vault: `0x${String(ordinal).padStart(40, '0')}`,
        rpcUrl: null,
        configSha256: null,
        assetBase: ordinal === 1 ? 'zkapi/' : `zkapi/${id}/`,
        proxyPath: null,
        transition: { closeByMarginSeconds: 259200, reminderDays: [7, 3, 1], promptWindowDays: 14 },
        notices: [],
        ...overrides
    };
}

const V1_ACTIVE = version('v1', 1, 'active');
const V1_EXIT = version('v1', 1, 'exit-only');
const V2_ACTIVE = version('v2', 2, 'active');
const V2_EXIT = version('v2', 2, 'exit-only');
const V3_ACTIVE = version('v3', 3, 'active');
const V0_RETIRED = version('v0', 0, 'retired', { assetBase: null });

const TWO = [V1_EXIT, V2_ACTIVE];
const THREE = [V1_EXIT, V2_EXIT, V3_ACTIVE];

const withdrawal = (overrides = {}) => ({
    recordId: 'r1', noteId: 7, mode: 'mutual', phase: 'parked', expiryTs: 1_800_000_000, ...overrides
});
const credit = (overrides = {}) => ({
    recordId: 'c1', noteId: 8, chainId: 11155111, contractAddress: '0xabc', destination: '0xdef',
    creditedAmount: '5', ...overrides
});
const holding = (versionRow, { runtime = false, withdrawals = [], credits = [] } = {}) => ({
    deploymentId: versionRow.deploymentId, runtime, withdrawals, credits
});

// ----------------------------------------------------------------- the table

test('row 1: one live version and no tombstone is that version, whatever the holdings say', () => {
    for (const holdings of [[], null, undefined, 'garbage', [holding(V1_ACTIVE, { runtime: true })]]) {
        const selection = chooseZkapiVersion({ table: [V1_ACTIVE], holdings, prefer: 'v1' });
        assert.equal(selection.version, V1_ACTIVE);
        assert.equal(selection.reason, 'single_version');
        assert.equal(selection.depositBlock, null);
        assert.equal(selection.slotOwner, null);
        assert.equal(selection.draftDiscarded, false);
    }
    // A single live version that is already exit-only is still the answer.
    assert.equal(chooseZkapiVersion({ table: [V1_EXIT], holdings: null }).version, V1_EXIT);
    // A retired tombstone makes it a real decision again.
    assert.notEqual(chooseZkapiVersion({ table: [V1_EXIT, V0_RETIRED], holdings: [] }).reason, 'single_version');
});

test('row 2: holdings that are not a well-formed array block deposits and load the target', () => {
    const malformed = [
        null, undefined, {}, 'x', 7,
        [null],
        [{ deploymentId: 'd', runtime: 'yes', withdrawals: [] }],
        [{ deploymentId: 5, runtime: false, withdrawals: [] }],
        [{ deploymentId: 'd', runtime: false }],
        [{ deploymentId: 'd', runtime: false, withdrawals: 'x' }],
        [{ deploymentId: 'd', runtime: false, withdrawals: [], credits: 'x' }],
        // one slot cannot have two owners
        [holding(V1_EXIT, { runtime: true }), holding(V2_ACTIVE, { runtime: true })]
    ];
    for (const holdings of malformed) {
        const selection = chooseZkapiVersion({ table: TWO, holdings, prefer: 'v1' });
        assert.equal(selection.version, V2_ACTIVE, JSON.stringify(holdings));
        assert.equal(selection.reason, 'holdings_unreadable');
        assert.equal(selection.depositBlock, 'holdings_unreadable');
        assert.equal(selection.slotOwner, null);
        assert.deepEqual(selection.open, {});
        assert.deepEqual(selection.credits, {});
    }
    // No deposit target: the newest live version.
    assert.equal(chooseZkapiVersion({ table: [V1_EXIT, V2_EXIT], holdings: null }).version, V2_EXIT);
});

test('row 3: the live version that owns the slot wins, with or without prefer', () => {
    for (const prefer of [null, 'v1', 'v2', 'v9']) {
        const fromV1 = chooseZkapiVersion({
            table: TWO, prefer,
            holdings: [holding(V1_EXIT, { runtime: true, withdrawals: [withdrawal()] })]
        });
        assert.equal(fromV1.version, V1_EXIT);
        assert.equal(fromV1.reason, 'runtime_holds_note');
        assert.equal(fromV1.slotOwner, 'v1');
        assert.equal(fromV1.depositBlock, null);
        assert.equal(fromV1.foreignDeploymentId, null);
        assert.deepEqual(fromV1.open, { v1: [withdrawal()] });

        const fromV2 = chooseZkapiVersion({
            table: TWO, prefer,
            holdings: [holding(V2_ACTIVE, { runtime: true }), holding(V1_EXIT, { withdrawals: [withdrawal()] })]
        });
        assert.equal(fromV2.version, V2_ACTIVE);
        assert.equal(fromV2.slotOwner, 'v2');
        // A previous version's open withdrawal is reported for banners.
        assert.deepEqual(fromV2.open, { v1: [withdrawal()] });
    }
});

test('row 3 holds for a rolled-back table: the exit-only newer version still owns its slot', () => {
    const rolledBack = [version('v1', 1, 'active'), version('v2', 2, 'exit-only')];
    const owned = chooseZkapiVersion({ table: rolledBack, holdings: [holding(rolledBack[1], { runtime: true })] });
    assert.equal(owned.version.id, 'v2');
    assert.equal(owned.reason, 'runtime_holds_note');
    assert.equal(chooseZkapiVersion({ table: rolledBack, holdings: [] }).version.id, 'v1');
});

test('row 4: a retired deployment owning the slot loads the target with deposits blocked', () => {
    const table = [V1_EXIT, V2_ACTIVE, V0_RETIRED];
    const selection = chooseZkapiVersion({
        table, prefer: 'v1',
        holdings: [holding(V0_RETIRED, { runtime: true, withdrawals: [withdrawal()] }),
            holding(V1_EXIT, { withdrawals: [withdrawal({ recordId: 'live-one' })] })]
    });
    assert.equal(selection.version, V2_ACTIVE);
    assert.equal(selection.reason, 'retired_deployment');
    assert.equal(selection.depositBlock, 'foreign_runtime');
    assert.equal(selection.slotOwner, 'v0');
    assert.equal(selection.foreignDeploymentId, V0_RETIRED.deploymentId);
    // Records of the retired deployment cannot be finished by any bundle: not reported.
    assert.deepEqual(Object.keys(selection.open), ['v1']);
});

test('row 5: an unknown owner, or one without an id, loads the target with deposits blocked', () => {
    for (const [deploymentId, foreign] of [['somebody-elses-deployment', 'somebody-elses-deployment'], [null, null]]) {
        const selection = chooseZkapiVersion({
            table: [V1_EXIT, V2_ACTIVE, V0_RETIRED], prefer: 'v1',
            holdings: [{ deploymentId, runtime: true, withdrawals: [], credits: [] }]
        });
        assert.equal(selection.version, V2_ACTIVE);
        assert.equal(selection.reason, 'unknown_deployment');
        assert.equal(selection.depositBlock, 'foreign_runtime');
        assert.equal(selection.slotOwner, null);
        assert.equal(selection.foreignDeploymentId, foreign);
    }
});

test('row 6: prefer is honored only for an empty slot and a live version with something to finish', () => {
    const open = [holding(V1_EXIT, { withdrawals: [withdrawal()] })];
    const picked = chooseZkapiVersion({ table: TWO, holdings: open, prefer: 'v1', slotKind: 'empty' });
    assert.equal(picked.version, V1_EXIT);
    assert.equal(picked.reason, 'requested_previous');
    assert.equal(picked.depositBlock, null);
    assert.equal(picked.slotOwner, null);
    assert.deepEqual(picked.open, { v1: [withdrawal()] });

    // An unclaimed credit is enough.
    const withCredit = chooseZkapiVersion({
        table: TWO, holdings: [holding(V1_EXIT, { credits: [credit()] })], prefer: 'v1'
    });
    assert.equal(withCredit.version, V1_EXIT);
    assert.equal(withCredit.reason, 'requested_previous');
    assert.deepEqual(withCredit.credits, { v1: [credit()] });

    // Nothing to finish: the target.
    assert.equal(chooseZkapiVersion({ table: TWO, holdings: [], prefer: 'v1' }).reason, 'no_runtime_note');
    // Ids that are not a live version, or not even a string, are ignored.
    for (const prefer of ['v9', 'v0', 'V1', '', ' v1', 'v1 ', null, undefined, 1, {}, ['v1'], true]) {
        const selection = chooseZkapiVersion({ table: [...TWO, V0_RETIRED], holdings: open, prefer });
        assert.equal(selection.version, V2_ACTIVE, JSON.stringify(prefer));
        assert.equal(selection.reason, 'no_runtime_note');
    }
    // Naming the version that would load anyway asks for nothing previous.
    const target = chooseZkapiVersion({ table: TWO, holdings: [holding(V2_ACTIVE, { withdrawals: [withdrawal()] })], prefer: 'v2' });
    assert.equal(target.reason, 'no_runtime_note');
    // A retired version holding records cannot be requested.
    const retiredOpen = chooseZkapiVersion({
        table: [V1_EXIT, V2_ACTIVE, V0_RETIRED], holdings: [holding(V0_RETIRED, { withdrawals: [withdrawal()] })], prefer: 'v0'
    });
    assert.equal(retiredOpen.version, V2_ACTIVE);
    assert.deepEqual(retiredOpen.open, {});
});

test('row 7: an empty slot loads the target and reports what is open elsewhere', () => {
    const selection = chooseZkapiVersion({
        table: TWO,
        holdings: [
            holding(V1_EXIT, { withdrawals: [withdrawal(), withdrawal({ recordId: 'r2', noteId: 9 })], credits: [credit()] }),
            { deploymentId: 'unknown', runtime: false, withdrawals: [withdrawal({ recordId: 'ghost' })], credits: [] }
        ]
    });
    assert.equal(selection.version, V2_ACTIVE);
    assert.equal(selection.reason, 'no_runtime_note');
    assert.equal(selection.depositBlock, null);
    assert.equal(selection.slotOwner, null);
    assert.equal(selection.foreignDeploymentId, null);
    assert.equal(selection.slotKind, 'empty');
    assert.deepEqual(selection.open, { v1: [withdrawal(), withdrawal({ recordId: 'r2', noteId: 9 })] });
    assert.deepEqual(selection.credits, { v1: [credit()] });
    // Nothing held: no keys at all.
    const nothing = chooseZkapiVersion({ table: TWO, holdings: [] });
    assert.deepEqual([nothing.open, nothing.credits], [{}, {}]);
});

test('three versions: the same table generalizes', () => {
    const table = [...THREE, V0_RETIRED];
    const v1Open = holding(THREE[0], { withdrawals: [withdrawal()] });
    const v2Open = holding(THREE[1], { withdrawals: [withdrawal({ recordId: 'b', noteId: 2 })], credits: [credit()] });

    assert.equal(chooseZkapiVersion({ table, holdings: [] }).version.id, 'v3');
    assert.equal(chooseZkapiVersion({ table, holdings: [holding(THREE[0], { runtime: true })] }).version.id, 'v1');
    assert.equal(chooseZkapiVersion({ table, holdings: [holding(THREE[1], { runtime: true }), v1Open] }).version.id, 'v2');
    assert.equal(chooseZkapiVersion({ table, holdings: [holding(THREE[2], { runtime: true }), v1Open, v2Open] }).version.id, 'v3');

    const open = [v1Open, v2Open];
    assert.equal(chooseZkapiVersion({ table, holdings: open }).version.id, 'v3');
    assert.equal(chooseZkapiVersion({ table, holdings: open, prefer: 'v1' }).version.id, 'v1');
    assert.equal(chooseZkapiVersion({ table, holdings: open, prefer: 'v2' }).version.id, 'v2');
    assert.equal(chooseZkapiVersion({ table, holdings: open, prefer: 'v3' }).reason, 'no_runtime_note');
    // A version that holds nothing is not requestable.
    assert.equal(chooseZkapiVersion({ table, holdings: [v1Open], prefer: 'v2' }).reason, 'no_runtime_note');
    const all = chooseZkapiVersion({ table, holdings: open });
    assert.deepEqual(Object.keys(all.open).sort(), ['v1', 'v2']);
    assert.deepEqual(Object.keys(all.credits), ['v2']);
});

test('credits alone count as something to finish, and never block the choice', () => {
    const holdings = [holding(V1_EXIT, { credits: [credit(), credit({ recordId: 'c2', noteId: 9 })] })];
    const selection = chooseZkapiVersion({ table: TWO, holdings });
    assert.equal(selection.version, V2_ACTIVE);
    assert.equal(selection.depositBlock, null);
    assert.equal(selection.credits.v1.length, 2);
    assert.deepEqual(selection.open, {});
    // A credit-holding slot owner keeps its slot.
    const owned = chooseZkapiVersion({ table: TWO, holdings: [holding(V1_EXIT, { runtime: true, credits: [credit()] })] });
    assert.equal(owned.version, V1_EXIT);
});

test('the slot kind and discard flag pass through; unknown values are not trusted', () => {
    for (const kind of ['draft_only', 'unsent_prepared', 'pending_deposit', 'note', 'other', 'empty']) {
        assert.equal(chooseZkapiVersion({ table: TWO, holdings: [holding(V1_EXIT, { runtime: true })], slotKind: kind }).slotKind, kind);
    }
    assert.equal(chooseZkapiVersion({ table: TWO, holdings: [holding(V1_EXIT, { runtime: true })], slotKind: 'weird' }).slotKind, 'other');
    assert.equal(chooseZkapiVersion({ table: TWO, holdings: [] }).slotKind, 'empty');
    assert.equal(chooseZkapiVersion({ table: TWO, holdings: [], draftDiscarded: true }).draftDiscarded, true);
    assert.equal(chooseZkapiVersion({ table: TWO, holdings: [], draftDiscarded: 'yes' }).draftDiscarded, false);
});

test('a table no validated registry can produce is refused', () => {
    const bad = [
        undefined, null, [], 'x',
        [V0_RETIRED],
        [V1_ACTIVE, V2_ACTIVE],
        [{ ...V1_EXIT, status: 'pending' }],
        [{ ...V1_EXIT, id: '' }],
        [null]
    ];
    for (const table of bad) {
        assert.throws(() => chooseZkapiVersion({ table, holdings: [] }), error => error.code === 'invalid_version_table',
            JSON.stringify(table));
    }
});

test('the decision is pure: no ambient state is read and inputs are not changed', () => {
    const ambient = ['location', 'localStorage', 'sessionStorage', 'indexedDB', 'document', 'window', 'fetch'];
    const reads = [];
    const saved = new Map();
    for (const name of ambient) {
        saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, {
            configurable: true,
            get() { reads.push(name); throw new Error(`chooseZkapiVersion read ${name}`); }
        });
    }
    const deepFreeze = value => {
        if (value && typeof value === 'object' && !Object.isFrozen(value)) {
            Object.freeze(value);
            Object.values(value).forEach(deepFreeze);
        }
        return value;
    };
    try {
        const table = deepFreeze([V1_EXIT, V2_ACTIVE, V0_RETIRED].map(row => structuredClone(row)));
        const holdings = deepFreeze([
            holding(table[0], { withdrawals: [withdrawal()], credits: [credit()] }),
            { deploymentId: null, runtime: false, withdrawals: [], credits: [] }
        ]);
        const first = chooseZkapiVersion({ table, holdings, prefer: 'v1' });
        const second = chooseZkapiVersion({ table, holdings, prefer: 'v1' });
        assert.deepEqual(first, second);
        // Results are copies: changing them cannot reach the holdings.
        first.open.v1[0].phase = 'tampered';
        assert.equal(holdings[0].withdrawals[0].phase, 'parked');
        for (const owner of [holding(table[0], { runtime: true }), { deploymentId: null, runtime: true, withdrawals: [], credits: [] }]) {
            chooseZkapiVersion({ table, holdings: [owner] });
        }
        chooseZkapiVersion({ table, holdings: null });
        assert.deepEqual(reads, []);
    } finally {
        for (const [name, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
});

// ------------------------------------------------------------- orchestration

function probes(sequence) {
    const calls = [];
    const results = [...sequence];
    return {
        calls,
        readHoldings: async options => {
            calls.push(options);
            const next = results.length > 1 ? results.shift() : results[0];
            if (next instanceof Error) throw next;
            if (typeof next === 'function') return next();
            return next;
        }
    };
}

const read = (holdings, kind = 'empty', deploymentId = null) => ({ holdings, slot: { deploymentId, kind } });

test('select: one live version is chosen without reading anything', async () => {
    let touched = 0;
    const selection = await selectZkapiVersion({
        table: [V1_ACTIVE], database: DB, prefer: 'v1',
        readHoldings: async () => { touched += 1; return read([]); },
        discardDraft: async () => { touched += 1; return { discarded: true }; },
        recordDiscard: () => { touched += 1; return { allowed: true }; }
    });
    assert.equal(selection.reason, 'single_version');
    assert.equal(touched, 0);
});

test('select: a database name and a bound reach the probe; the result is the decision', async () => {
    const probe = probes([read([holding(V1_EXIT, { withdrawals: [withdrawal()] })])]);
    const selection = await selectZkapiVersion({ table: TWO, database: DB, prefer: 'v1', timeoutMs: 1234, readHoldings: probe.readHoldings });
    assert.deepEqual(probe.calls, [{ database: DB, timeoutMs: 1234 }]);
    assert.equal(selection.version, V1_EXIT);
    assert.equal(selection.reason, 'requested_previous');
});

test('select: probe failures never throw and block deposits', async () => {
    const failures = [
        new Error('IDB exploded'),
        read(null),
        read([{ nonsense: true }]),
        undefined,
        'not an object',
        { holdings: 'nope', slot: {} }
    ];
    for (const failure of failures) {
        const probe = probes([failure]);
        const selection = await selectZkapiVersion({ table: TWO, database: DB, readHoldings: probe.readHoldings });
        assert.equal(selection.version, V2_ACTIVE);
        assert.equal(selection.reason, 'holdings_unreadable');
        assert.equal(selection.depositBlock, 'holdings_unreadable');
    }
    // A probe that throws synchronously and one that never answers.
    const sync = await selectZkapiVersion({ table: TWO, database: DB, readHoldings: () => { throw new Error('sync'); } });
    assert.equal(sync.reason, 'holdings_unreadable');
    const started = Date.now();
    const hung = await selectZkapiVersion({
        table: TWO, database: DB, timeoutMs: 30, readHoldings: () => new Promise(() => {})
    });
    assert.equal(hung.reason, 'holdings_unreadable');
    assert.ok(Date.now() - started < 1500);
});

test('select: a pinned draft on a non-target version is discarded and the decision is re-run', async () => {
    for (const kind of ['draft_only', 'unsent_prepared']) {
        const probe = probes([
            read([holding(V1_EXIT, { runtime: true })], kind, V1_EXIT.deploymentId),
            read([], 'empty', V1_EXIT.deploymentId)
        ]);
        const discards = [];
        const selection = await selectZkapiVersion({
            table: TWO, database: DB, readHoldings: probe.readHoldings,
            recordDiscard: () => ({ allowed: true }),
            discardDraft: async options => { discards.push(options); return { discarded: true }; }
        });
        assert.equal(selection.version, V2_ACTIVE);
        assert.equal(selection.reason, 'no_runtime_note');
        assert.equal(selection.draftDiscarded, true);
        assert.equal(selection.slotKind, 'empty');
        assert.equal(probe.calls.length, 2);
        assert.deepEqual(discards, [{ database: DB, timeoutMs: 2000, expectedDeploymentId: V1_EXIT.deploymentId }]);
    }
});

test('select: prefer still applies to the re-decision', async () => {
    const probe = probes([
        read([holding(V1_EXIT, { runtime: true, withdrawals: [withdrawal()] })], 'draft_only', V1_EXIT.deploymentId),
        read([holding(V1_EXIT, { withdrawals: [withdrawal()] })])
    ]);
    const selection = await selectZkapiVersion({
        table: TWO, database: DB, prefer: 'v1', readHoldings: probe.readHoldings,
        recordDiscard: () => ({ allowed: true }), discardDraft: async () => ({ discarded: true })
    });
    assert.equal(selection.version, V1_EXIT);
    assert.equal(selection.reason, 'requested_previous');
    assert.equal(selection.draftDiscarded, true);
});

test('select: nothing is discarded unless a non-target live version is pinned by a draft or unsent plan', async () => {
    const cases = [
        ['a started deposit', V1_EXIT, 'pending_deposit', TWO],
        ['an active note', V1_EXIT, 'note', TWO],
        ['something else', V1_EXIT, 'other', TWO],
        ['the target itself', V2_ACTIVE, 'draft_only', TWO],
        ['a retired owner', V0_RETIRED, 'draft_only', [V1_EXIT, V2_ACTIVE, V0_RETIRED]],
        ['no deposit target', V1_EXIT, 'draft_only', [V1_EXIT, V2_EXIT]]
    ];
    for (const [name, owner, kind, table] of cases) {
        let discards = 0;
        const probe = probes([read([holding(owner, { runtime: true })], kind, owner.deploymentId)]);
        const selection = await selectZkapiVersion({
            table, database: DB, readHoldings: probe.readHoldings,
            recordDiscard: () => ({ allowed: true }),
            discardDraft: async () => { discards += 1; return { discarded: true }; }
        });
        assert.equal(discards, 0, name);
        assert.equal(probe.calls.length, 1, name);
        assert.equal(selection.draftDiscarded, false, name);
    }
});

test('select: a refused or failed discard leaves the decision as it was', async () => {
    const pinned = () => read([holding(V1_EXIT, { runtime: true })], 'draft_only', V1_EXIT.deploymentId);
    const expectPinned = selection => {
        assert.equal(selection.version, V1_EXIT);
        assert.equal(selection.reason, 'runtime_holds_note');
        assert.equal(selection.draftDiscarded, false);
        assert.equal(selection.slotKind, 'draft_only');
    };

    // The loop guard says no: the discard is not even attempted.
    let attempted = 0;
    expectPinned(await selectZkapiVersion({
        table: TWO, database: DB, readHoldings: probes([pinned()]).readHoldings,
        recordDiscard: () => ({ allowed: false }),
        discardDraft: async () => { attempted += 1; return { discarded: true }; }
    }));
    assert.equal(attempted, 0);

    // Failures that say nothing about another tab (no Web Locks, an unreadable
    // database, a throw, a malformed answer) leave the first read standing: no
    // second read.
    for (const outcome of [
        async () => ({ discarded: false, why: 'no_locks' }),
        async () => ({ discarded: false, why: 'unreadable' }),
        async () => ({ discarded: false }),
        async () => { throw new Error('boom'); },
        () => { throw new Error('sync boom'); },
        async () => undefined,
        async () => ({ discarded: 'true' })
    ]) {
        const probe = probes([pinned()]);
        expectPinned(await selectZkapiVersion({
            table: TWO, database: DB, readHoldings: probe.readHoldings,
            recordDiscard: () => ({ allowed: true }), discardDraft: outcome
        }));
        assert.equal(probe.calls.length, 1);
    }

    // A lost race (lock busy, or the draft already gone) is read once more.
    // Here the slot is still pinned, so the pinned version is the answer and
    // nothing is claimed.
    for (const why of ['lock_busy', 'not_discardable']) {
        const probe = probes([pinned()]);
        expectPinned(await selectZkapiVersion({
            table: TWO, database: DB, readHoldings: probe.readHoldings,
            recordDiscard: () => ({ allowed: true }), discardDraft: async () => ({ discarded: false, why })
        }));
        assert.equal(probe.calls.length, 2, why);
    }

    // A guard that throws is a refusal too.
    expectPinned(await selectZkapiVersion({
        table: TWO, database: DB, readHoldings: probes([pinned()]).readHoldings,
        recordDiscard: () => { throw new Error('storage'); }, discardDraft: async () => ({ discarded: true })
    }));
});

test('select: after a lost discard race the slot is read once more and decided as it is', async () => {
    const pinned = read([holding(V1_EXIT, { runtime: true })], 'draft_only', V1_EXIT.deploymentId);
    for (const why of ['lock_busy', 'not_discardable']) {
        // The other tab cleared the draft: this tab goes to the target and does
        // not claim a discard it did not make.
        const probe = probes([pinned, read([], 'empty', V1_EXIT.deploymentId)]);
        const discards = [];
        const selection = await selectZkapiVersion({
            table: TWO, database: DB, readHoldings: probe.readHoldings, recordDiscard: () => ({ allowed: true }),
            discardDraft: async options => { discards.push(options); return { discarded: false, why }; }
        });
        assert.equal(selection.version, V2_ACTIVE, why);
        assert.equal(selection.reason, 'no_runtime_note', why);
        assert.equal(selection.draftDiscarded, false, why);
        assert.equal(selection.slotKind, 'empty', why);
        assert.equal(probe.calls.length, 2, why);
        assert.equal(discards.length, 1, 'one attempt: a lost race is not retried');
    }

    // The re-read decides on what is there: another tab funded version 2.
    const taken = await selectZkapiVersion({
        table: TWO, database: DB, recordDiscard: () => ({ allowed: true }),
        readHoldings: probes([pinned, read([holding(V2_ACTIVE, { runtime: true })], 'note', V2_ACTIVE.deploymentId)]).readHoldings,
        discardDraft: async () => ({ discarded: false, why: 'lock_busy' })
    });
    assert.equal(taken.version, V2_ACTIVE);
    assert.equal(taken.reason, 'runtime_holds_note');
    assert.equal(taken.draftDiscarded, false);

    // The draft became a started deposit: still version 1, and not discardable.
    const started = await selectZkapiVersion({
        table: TWO, database: DB, recordDiscard: () => ({ allowed: true }),
        readHoldings: probes([pinned, read([holding(V1_EXIT, { runtime: true })], 'pending_deposit', V1_EXIT.deploymentId)]).readHoldings,
        discardDraft: async () => ({ discarded: false, why: 'not_discardable' })
    });
    assert.equal(started.version, V1_EXIT);
    assert.equal(started.slotKind, 'pending_deposit');
    assert.equal(started.draftDiscarded, false);

    // prefer still applies to the re-decision.
    const preferred = await selectZkapiVersion({
        table: TWO, database: DB, prefer: 'v1', recordDiscard: () => ({ allowed: true }),
        readHoldings: probes([
            read([holding(V1_EXIT, { runtime: true, withdrawals: [withdrawal()] })], 'draft_only', V1_EXIT.deploymentId),
            read([holding(V1_EXIT, { withdrawals: [withdrawal()] })])
        ]).readHoldings,
        discardDraft: async () => ({ discarded: false, why: 'lock_busy' })
    });
    assert.equal(preferred.reason, 'requested_previous');
    assert.equal(preferred.draftDiscarded, false);

    // A second read that fails or is malformed keeps the first, readable, answer.
    for (const failure of [new Error('gone'), read(null), undefined]) {
        const probe = probes([pinned, failure]);
        const selection = await selectZkapiVersion({
            table: TWO, database: DB, readHoldings: probe.readHoldings, recordDiscard: () => ({ allowed: true }),
            discardDraft: async () => ({ discarded: false, why: 'lock_busy' })
        });
        assert.equal(selection.version, V1_EXIT);
        assert.equal(selection.reason, 'runtime_holds_note');
        assert.equal(selection.draftDiscarded, false);
        assert.equal(probe.calls.length, 2);
    }
});

test('select: a draft that is back after a successful discard is not reported as cleared', async () => {
    const pinned = (kind = 'draft_only') => read([holding(V1_EXIT, { runtime: true })], kind, V1_EXIT.deploymentId);
    // A pre-rollout tab recreated its draft (or plan) behind the discard.
    for (const [first, second] of [['draft_only', 'draft_only'], ['draft_only', 'unsent_prepared'], ['unsent_prepared', 'draft_only']]) {
        const probe = probes([pinned(first), pinned(second)]);
        let discards = 0;
        const selection = await selectZkapiVersion({
            table: TWO, database: DB, readHoldings: probe.readHoldings, recordDiscard: () => ({ allowed: true }),
            discardDraft: async () => { discards += 1; return { discarded: true }; }
        });
        assert.equal(selection.version, V1_EXIT, `${first} -> ${second}`);
        assert.equal(selection.reason, 'runtime_holds_note');
        assert.equal(selection.slotKind, second);
        assert.equal(selection.draftDiscarded, false, `${first} -> ${second}`);
        assert.equal(discards, 1, 'it is not discarded again in a loop');
        assert.equal(probe.calls.length, 2);
    }
    // Back as something that is not clearable (a started deposit) or owned by
    // another version: the discard did happen and is reported.
    const started = await selectZkapiVersion({
        table: TWO, database: DB, recordDiscard: () => ({ allowed: true }),
        readHoldings: probes([pinned(), pinned('pending_deposit')]).readHoldings,
        discardDraft: async () => ({ discarded: true })
    });
    assert.equal(started.version, V1_EXIT);
    assert.equal(started.slotKind, 'pending_deposit');
    assert.equal(started.draftDiscarded, true);
    const target = await selectZkapiVersion({
        table: TWO, database: DB, recordDiscard: () => ({ allowed: true }),
        readHoldings: probes([pinned(), read([holding(V2_ACTIVE, { runtime: true })], 'draft_only', V2_ACTIVE.deploymentId)]).readHoldings,
        discardDraft: async () => ({ discarded: true })
    });
    assert.equal(target.version, V2_ACTIVE);
    assert.equal(target.draftDiscarded, true, 'the target\'s own draft is not a pin');
});

// The loop guard is asked before the attempt and charged only for a discard
// that happened, so a busy lock cannot use up the allowance.
test('select: the loop guard is checked before the attempt and charged only for a discard that happened', async () => {
    const pinned = () => read([holding(V1_EXIT, { runtime: true })], 'draft_only', V1_EXIT.deploymentId);
    const run = async ({ allowed = true, outcome, sequence = [pinned(), read([])] }) => {
        const events = [];
        const selection = await selectZkapiVersion({
            table: TWO, database: DB, readHoldings: probes(sequence).readHoldings,
            canDiscard: () => { events.push('check'); return { allowed }; },
            noteDiscard: () => { events.push('charge'); return { recorded: true }; },
            discardDraft: async () => { events.push('discard'); return typeof outcome === 'function' ? outcome() : outcome; }
        });
        return { events, selection };
    };

    const done = await run({ outcome: { discarded: true } });
    assert.deepEqual(done.events, ['check', 'discard', 'charge']);
    assert.equal(done.selection.draftDiscarded, true);

    // The check says no: no attempt, no charge.
    const refused = await run({ allowed: false, outcome: { discarded: true } });
    assert.deepEqual(refused.events, ['check']);
    assert.equal(refused.selection.version, V1_EXIT);
    assert.equal(refused.selection.draftDiscarded, false);

    // Nothing that did not discard is charged.
    for (const outcome of [
        { discarded: false, why: 'lock_busy' }, { discarded: false, why: 'not_discardable' },
        { discarded: false, why: 'no_locks' }, { discarded: false, why: 'unreadable' },
        undefined, { discarded: 'true' }, () => { throw new Error('boom'); }
    ]) {
        const result = await run({ outcome, sequence: [pinned(), pinned()] });
        assert.deepEqual(result.events, ['check', 'discard'], String(outcome && JSON.stringify(outcome)));
    }

    // A guard that cannot record does not undo or hide the discard.
    const unrecorded = await selectZkapiVersion({
        table: TWO, database: DB, readHoldings: probes([pinned(), read([])]).readHoldings,
        canDiscard: () => ({ allowed: true }), noteDiscard: () => { throw new Error('quota'); },
        discardDraft: async () => ({ discarded: true })
    });
    assert.equal(unrecorded.draftDiscarded, true);
    assert.equal(unrecorded.version, V2_ACTIVE);

    // The older option: one call before the attempt, nothing afterwards.
    const legacy = [];
    const legacyResult = await selectZkapiVersion({
        table: TWO, database: DB, readHoldings: probes([pinned(), read([])]).readHoldings,
        recordDiscard: () => { legacy.push('record'); return { allowed: true }; },
        discardDraft: async () => { legacy.push('discard'); return { discarded: true }; }
    });
    assert.deepEqual(legacy, ['record', 'discard']);
    assert.equal(legacyResult.draftDiscarded, true);
    // The new pair wins when both are given.
    const both = [];
    await selectZkapiVersion({
        table: TWO, database: DB, readHoldings: probes([pinned(), read([])]).readHoldings,
        recordDiscard: () => { both.push('record'); return { allowed: true }; },
        canDiscard: () => { both.push('check'); return { allowed: true }; },
        noteDiscard: () => { both.push('charge'); return { recorded: true }; },
        discardDraft: async () => { both.push('discard'); return { discarded: true }; }
    });
    assert.deepEqual(both, ['check', 'discard', 'charge']);
});

test('select: the default guard counts discards that happened, not attempts', async () => {
    const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    try {
        const storage = createFakeStorage();
        Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true, writable: true });
        const pinned = () => read([holding(V1_EXIT, { runtime: true })], 'draft_only', V1_EXIT.deploymentId);
        const outcomes = [];
        const run = sequence => selectZkapiVersion({
            table: TWO, database: DB, readHoldings: probes(sequence).readHoldings,
            discardDraft: async () => outcomes.shift()
        });
        // Many reloads beside a busy tab: every attempt is refused, nothing is
        // charged, and the next one is still allowed.
        for (let reload = 0; reload < 6; reload += 1) {
            outcomes.push({ discarded: false, why: 'lock_busy' });
            assert.equal((await run([pinned(), pinned()])).version, V1_EXIT);
        }
        assert.equal(storage.has('oa-zkapi-version-switch-log'), false);
        assert.equal(canDiscard({ storage }).allowed, true);

        // Successful discards are charged, two per window.
        for (let index = 0; index < 2; index += 1) {
            outcomes.push({ discarded: true });
            assert.equal((await run([pinned(), read([])])).draftDiscarded, true);
        }
        assert.equal(JSON.parse(storage.getItem('oa-zkapi-version-switch-log')).length, 2);
        let attempted = 0;
        const third = await selectZkapiVersion({
            table: TWO, database: DB, readHoldings: probes([pinned()]).readHoldings,
            discardDraft: async () => { attempted += 1; return { discarded: true }; }
        });
        assert.equal(third.draftDiscarded, false);
        assert.equal(third.version, V1_EXIT);
        assert.equal(attempted, 0);
    } finally {
        if (realStorage) Object.defineProperty(globalThis, 'sessionStorage', realStorage);
        else delete globalThis.sessionStorage;
    }
});

test('select: after a discard the second read can fail or show another owner', async () => {
    const pinned = read([holding(V1_EXIT, { runtime: true })], 'unsent_prepared', V1_EXIT.deploymentId);
    const common = {
        table: TWO, database: DB, recordDiscard: () => ({ allowed: true }), discardDraft: async () => ({ discarded: true })
    };
    const failed = await selectZkapiVersion({ ...common, readHoldings: probes([pinned, new Error('gone')]).readHoldings });
    assert.equal(failed.reason, 'holdings_unreadable');
    assert.equal(failed.depositBlock, 'holdings_unreadable');
    assert.equal(failed.draftDiscarded, true);

    // Another tab funded version 2 in the meantime.
    const taken = await selectZkapiVersion({
        ...common,
        readHoldings: probes([pinned, read([holding(V2_ACTIVE, { runtime: true })], 'note', V2_ACTIVE.deploymentId)]).readHoldings
    });
    assert.equal(taken.version, V2_ACTIVE);
    assert.equal(taken.reason, 'runtime_holds_note');
    assert.equal(taken.draftDiscarded, true);
});

// ------------------------------------------- end to end over the fake database

const legacyStorePath = fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/store'));
let instance = 0;
const loadLegacyStore = () => import(`${pathToFileURL(legacyStorePath).href}?loader=${++instance}`);

async function withEnvironment(fn, options = {}) {
    const env = createFakeEnvironment();
    const restore = env.install(options);
    try {
        return await fn(env);
    } finally {
        restore();
    }
}

const draft = () => ({ operationId: 'quote-1', createdAt: 1, amount: 5, secret: 'SECRET', commitment: '0x1', next_note_id: 9, active_root: '0x2', zero_path: [] });
const plan = () => ({ ...draft(), phase: 'prepared' });

test('end to end: the real probe and discard clear a pinned draft, once per allowance', async () => {
    await withEnvironment(async env => {
        const store = await loadLegacyStore();
        const storage = createFakeStorage();
        const options = { table: TWO, database: DB, recordDiscard: () => recordDiscard({ storage }) };

        await store.writeBrowserWallet({ deploymentId: V1_EXIT.deploymentId, depositQuote: draft() });
        const first = await selectZkapiVersion(options);
        assert.equal(first.version, V2_ACTIVE);
        assert.equal(first.reason, 'no_runtime_note');
        assert.equal(first.draftDiscarded, true);
        assert.equal(env.idb.read(DB, 'runtime', 'active').depositQuote, null);

        // Nothing to discard now.
        const second = await selectZkapiVersion(options);
        assert.equal(second.draftDiscarded, false);
        assert.equal(second.reason, 'no_runtime_note');

        // A stale tab keeps re-creating its plan: two discards per minute, then no more.
        await store.writeBrowserWallet({ deploymentId: V1_EXIT.deploymentId, pendingDeposit: plan() });
        assert.equal((await selectZkapiVersion(options)).draftDiscarded, true);
        await store.writeBrowserWallet({ deploymentId: V1_EXIT.deploymentId, pendingDeposit: plan() });
        const third = await selectZkapiVersion(options);
        assert.equal(third.draftDiscarded, false);
        assert.equal(third.version, V1_EXIT);
        assert.equal(third.slotKind, 'unsent_prepared');
        assert.notEqual(env.idb.read(DB, 'runtime', 'active').pendingDeposit, null);
    });
});

// Several app tabs restored at once all read the same pinned draft and race to
// clear it; one wins the wallet lock. The others must not keep acting on the
// stale read (they would load the old build, with the slot already empty).
test('end to end: concurrent tabs over one database all end on the target, one claims the discard', async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (const stagger of [0, 1, 3]) {
        await withEnvironment(async env => {
            const store = await loadLegacyStore();
            await store.writeBrowserWallet({ deploymentId: V1_EXIT.deploymentId, depositQuote: draft() });
            const committedBefore = env.idb.committedWrites().length;
            // Each tab has its own sessionStorage, so its own loop guard.
            const tabs = [0, 1, 2].map(() => {
                const storage = createFakeStorage();
                return {
                    storage,
                    options: {
                        table: TWO, database: DB,
                        canDiscard: () => canDiscard({ storage }), noteDiscard: () => noteDiscard({ storage })
                    }
                };
            });
            const results = await Promise.all(tabs.map(async (tab, index) => {
                if (stagger) await wait(index * stagger);
                return selectZkapiVersion(tab.options);
            }));
            for (const [index, selection] of results.entries()) {
                assert.equal(selection.version, V2_ACTIVE, `tab ${index} (stagger ${stagger})`);
                assert.equal(selection.reason, 'no_runtime_note', `tab ${index} (stagger ${stagger})`);
                assert.equal(selection.slotKind, 'empty', `tab ${index}`);
                assert.equal(selection.depositBlock, null);
            }
            // Exactly one tab did the clearing and is the only one that says so.
            assert.equal(results.filter(selection => selection.draftDiscarded).length, 1, `stagger ${stagger}`);
            assert.equal(env.idb.read(DB, 'runtime', 'active').depositQuote, null);
            assert.equal(env.idb.committedWrites().length - committedBefore, 1, 'one discard commit in all');
            // Only the tab that wrote is charged; the others keep their allowance.
            const charged = tabs.map(tab => tab.storage.has('oa-zkapi-version-switch-log'));
            assert.equal(charged.filter(Boolean).length, 1);
        });
    }
});

test('end to end: a busy wallet lock that is not a discard leaves the draft pinned and the tab on its version', async () => {
    await withEnvironment(async env => {
        const store = await loadLegacyStore();
        await store.writeBrowserWallet({ deploymentId: V1_EXIT.deploymentId, depositQuote: draft() });
        const storage = createFakeStorage();
        const options = {
            table: TWO, database: DB,
            canDiscard: () => canDiscard({ storage }), noteDiscard: () => noteDiscard({ storage })
        };
        // Another tab's SDK is mid-mutation under the wallet lock.
        let release;
        const hold = new Promise(resolve => { release = resolve; });
        const holder = env.locks.forTab('sdk-tab').request('zkapi-wallet:active-runtime', () => hold);
        await new Promise(resolve => setImmediate(resolve));
        const busy = await selectZkapiVersion(options);
        // The re-read still shows the pin, so it is the answer; nothing was claimed or charged.
        assert.equal(busy.version, V1_EXIT);
        assert.equal(busy.reason, 'runtime_holds_note');
        assert.equal(busy.slotKind, 'draft_only');
        assert.equal(busy.draftDiscarded, false);
        assert.notEqual(env.idb.read(DB, 'runtime', 'active').depositQuote, null);
        assert.equal(storage.has('oa-zkapi-version-switch-log'), false);

        release();
        await holder;
        const free = await selectZkapiVersion(options);
        assert.equal(free.version, V2_ACTIVE);
        assert.equal(free.draftDiscarded, true);
        assert.equal(env.idb.read(DB, 'runtime', 'active').depositQuote, null);
    });
});

test('end to end: a started deposit, a note and the target version are never touched', async () => {
    await withEnvironment(async env => {
        const store = await loadLegacyStore();
        const storage = createFakeStorage();
        const options = { table: TWO, database: DB, recordDiscard: () => recordDiscard({ storage }) };
        const cases = [
            [V1_EXIT, { pendingDeposit: { ...plan(), phase: 'awaiting_wallet', submissionId: 'claim' } }, 'pending_deposit', V1_EXIT],
            [V1_EXIT, { state: { note_id: 5, deposit_amount: 10, expiry_ts: 1_800_000_000 } }, 'note', V1_EXIT],
            [V2_ACTIVE, { depositQuote: draft() }, 'draft_only', V2_ACTIVE]
        ];
        for (const [owner, fields, kind, expected] of cases) {
            await store.writeBrowserWallet({ deploymentId: owner.deploymentId, ...fields });
            const before = env.idb.read(DB, 'runtime', 'active');
            const selection = await selectZkapiVersion(options);
            assert.equal(selection.version, expected, kind);
            assert.equal(selection.reason, 'runtime_holds_note', kind);
            assert.equal(selection.slotKind, kind);
            assert.equal(selection.draftDiscarded, false, kind);
            assert.deepEqual(env.idb.read(DB, 'runtime', 'active'), before, kind);
            await store.writeBrowserWallet({ deploymentId: owner.deploymentId });
        }
        assert.equal(storage.has('oa-zkapi-version-switch-log'), false, 'no discard was even counted');
    });
});

test('end to end: an unreadable database, a hung open and no Web Locks', async () => {
    await withEnvironment(async env => {
        const store = await loadLegacyStore();
        await store.writeBrowserWallet({ deploymentId: V1_EXIT.deploymentId, depositQuote: draft() });
        const options = { table: TWO, database: DB, timeoutMs: 40, recordDiscard: () => ({ allowed: true }) };

        env.idb.failNextOpen();
        const failed = await selectZkapiVersion(options);
        assert.equal(failed.reason, 'holdings_unreadable');

        const release = env.idb.hangNextOpen();
        const hung = await selectZkapiVersion(options);
        assert.equal(hung.reason, 'holdings_unreadable');
        assert.equal(hung.depositBlock, 'holdings_unreadable');
        release();
        await env.idb.idle();
        assert.notEqual(env.idb.read(DB, 'runtime', 'active').depositQuote, null, 'nothing was discarded');
    });
    await withEnvironment(async env => {
        const store = await loadLegacyStore();
        await store.writeBrowserWallet({ deploymentId: V1_EXIT.deploymentId, depositQuote: draft() });
        // Without Web Locks the draft stays and the user keeps the older version.
        const selection = await selectZkapiVersion({ table: TWO, database: DB, recordDiscard: () => ({ allowed: true }) });
        assert.equal(selection.version, V1_EXIT);
        assert.equal(selection.slotKind, 'draft_only');
        assert.equal(selection.draftDiscarded, false);
        assert.notEqual(env.idb.read(DB, 'runtime', 'active').depositQuote, null);
    }, { locks: false });
});

test('end to end: a single live version never opens the database', async () => {
    await withEnvironment(async env => {
        const selection = await selectZkapiVersion({ table: [V1_ACTIVE], database: DB });
        assert.equal(selection.reason, 'single_version');
        assert.equal(env.idb.log.length, 0);
    });
});

test('select: the default loop guard is the session log, and refuses without storage', async () => {
    const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    try {
        const storage = createFakeStorage();
        Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true, writable: true });
        let discards = 0;
        const pinned = () => read([holding(V1_EXIT, { runtime: true })], 'draft_only', V1_EXIT.deploymentId);
        const run = () => selectZkapiVersion({
            table: TWO, database: DB, readHoldings: probes([pinned(), read([])]).readHoldings,
            discardDraft: async () => { discards += 1; return { discarded: true }; }
        });
        assert.equal((await run()).draftDiscarded, true);
        assert.equal(storage.has('oa-zkapi-version-switch-log'), true);
        assert.equal(discards, 1);
        // Storage that cannot be read: the guard cannot be evaluated, so no discard.
        storage.failReads = true;
        const refused = await run();
        assert.equal(refused.draftDiscarded, false);
        assert.equal(refused.version, V1_EXIT);
        assert.equal(discards, 1);
    } finally {
        if (realStorage) Object.defineProperty(globalThis, 'sessionStorage', realStorage);
        else delete globalThis.sessionStorage;
    }
});

// ------------------------------------------------------------ active version

test('active version: nothing installed reads as the single legacy default', () => {
    resetActiveVersionForTests();
    assert.equal(getActiveVersion(), null);
    assert.equal(getActiveAdapter(), null);
    assert.equal(getSelection(), null);
    assert.deepEqual(getVersionTable(), []);
});

test('active version: install, read, copy semantics and reset', t => {
    t.after(resetActiveVersionForTests);
    resetActiveVersionForTests();
    const table = [V1_EXIT, V2_ACTIVE, V0_RETIRED];
    const selection = chooseZkapiVersion({ table, holdings: [] });
    installActiveVersion({ table, version: V2_ACTIVE, selection });
    assert.equal(getActiveVersion(), V2_ACTIVE);
    assert.equal(getSelection(), selection);
    assert.equal(getActiveAdapter(), concessionV1);
    assert.deepEqual(getVersionTable().map(row => row.id), ['v1', 'v2', 'v0']);
    // The table handed out is a copy: reordering it cannot reach the page's table.
    getVersionTable().reverse();
    table.length = 0;
    assert.deepEqual(getVersionTable().map(row => row.id), ['v1', 'v2', 'v0']);
    // The same version may refresh its selection; another version cannot take over.
    const refreshed = { ...selection, draftDiscarded: true };
    installActiveVersion({ table: getVersionTable(), version: V2_ACTIVE, selection: refreshed });
    assert.equal(getSelection(), refreshed);
    assert.throws(() => installActiveVersion({ table: getVersionTable(), version: V1_EXIT, selection }),
        error => error.code === 'invalid_active_version');
    assert.equal(getActiveVersion(), V2_ACTIVE);
    resetActiveVersionForTests();
    installActiveVersion({ table: [V1_EXIT, V2_ACTIVE], version: V1_EXIT, selection });
    assert.equal(getActiveAdapter(), noteBoundV1);
    resetActiveVersionForTests();
    assert.equal(getActiveVersion(), null);
});

test('active version: bad installs are refused and leave nothing installed', t => {
    t.after(resetActiveVersionForTests);
    resetActiveVersionForTests();
    const selection = { reason: 'single_version' };
    for (const options of [
        undefined,
        {},
        { table: [], version: V1_EXIT, selection },
        { table: [V1_EXIT], version: null, selection },
        { table: [V1_EXIT], version: { adapter: 'note-bound-v1' }, selection },
        { table: [V1_EXIT], version: V2_ACTIVE, selection },
        { table: [V1_EXIT], version: V1_EXIT, selection: null }
    ]) {
        assert.throws(() => installActiveVersion(options), error => error.code === 'invalid_active_version');
        assert.equal(getActiveVersion(), null);
    }
});

test('active version: a row naming an adapter this build lacks fails on use, not silently', t => {
    t.after(resetActiveVersionForTests);
    resetActiveVersionForTests();
    const stranger = version('v9', 9, 'active', { adapter: 'from-the-future' });
    installActiveVersion({ table: [stranger], version: stranger, selection: { reason: 'single_version' } });
    assert.equal(getActiveVersion(), stranger);
    assert.throws(() => getActiveAdapter(), error => error.code === 'unknown_adapter');
    assert.throws(() => getActiveAdapter(), error => error.code === 'unknown_adapter');
});
