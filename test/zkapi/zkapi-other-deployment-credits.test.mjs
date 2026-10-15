// Other deployments' credits: a payout another version's contract credited,
// as the LOADED SDK reports it (config.other_deployment_credits), reaches the
// person and never closes deposits.
//
// The holdings read of the shared wallet database is the other source of the
// same fact, and it is the one the rest of the suite feeds. The SDK's own list
// is what a page falls back on when that read failed, or has not caught up
// with what the SDK just saw, so these tests give the state derivation NO
// holdings facts and let the credit arrive only through the SDK's list, as the
// real revision 3 emits it (snake_case, the amount a JS number).
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVersionNotices } from '../../chat/zkapi/components/VersionNotices.js';
import concessionV1 from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { installActiveVersion, resetActiveVersionForTests } from '../../chat/zkapi/versioning/activeVersion.mjs';
import { createZkapiVersioning } from '../../chat/zkapi/versioning/index.js';
import { chooseZkapiVersion } from '../../chat/zkapi/versioning/versionLoader.mjs';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import { createFakeStorage } from './_fakeIndexedDb.mjs';
import { NOW_MS, activatedRegistry, mutated, resolvedTable } from './_registryFixtures.mjs';

const NETWORK = 'mainnet';
// v1 is the closed legacy version (exit-only, with a deposit target), v2 the
// concession version that takes deposits.
const TABLE = resolvedTable(activatedRegistry(), NETWORK);
const [V1, V2] = TABLE;
const CHAIN = 1;

// A credit as the SDK lists it in config.other_deployment_credits.
const credit = (version, noteId, overrides = {}) => ({
    deployment_id: version.deploymentId,
    record_id: `${version.deploymentId}:${CHAIN}:${version.vault.toLowerCase()}:${noteId}`,
    note_id: noteId,
    chain_id: CHAIN,
    contract_address: version.vault.toLowerCase(),
    destination: `0x${'34'.repeat(20)}`,
    credited_amount: 800000,
    ...overrides
});

// What the loaded concession SDK's adapter makes of them.
const reported = credits => concessionV1.normalizeSnapshot({
    config: { other_deployment_credits: credits }, wallet: null, withdrawals: [], deposits: [], runtime: null
}, { nowMs: NOW_MS });

function selectionFor(version, overrides = {}) {
    return {
        version, reason: 'no_runtime_note', slotOwner: null, open: {}, credits: {}, foreignDeploymentId: null,
        depositBlock: null, draftDiscarded: false, slotKind: 'empty', ...overrides
    };
}

function derive({ credits = [], facts = {}, snapshot = reported(credits), active = V2, table = TABLE } = {}) {
    return deriveVersionState({
        table, active, target: table.find(row => row.status === 'active') || null,
        selection: selectionFor(active, facts), snapshot, intent: null, previewSelection: null, now: NOW_MS,
        busy: false, admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false,
        adapter: getAdapter(active.adapter)
    });
}

const noticesOf = (state, surface = 'dialog') => buildVersionNotices(state, {
    surface, now: NOW_MS, table: TABLE, formatAmount: units => `${units}`
}).notices;
const textOf = notice => notice.paragraphs.map(paragraph => paragraph.text).join(' ');

test('wiring:other-deployment-credits a credit only the loaded SDK reports is claimable from its version and is not a deposit block', () => {
    // The adapter reads the SDK's own shape, amount (a number) included.
    const snapshot = reported([credit(V1, 5)]);
    assert.equal(snapshot.otherDeploymentCredits.length, 1);
    assert.equal(snapshot.otherDeploymentCredits[0].deploymentId, V1.deploymentId);
    assert.equal(snapshot.otherDeploymentCredits[0].creditedAmount, '800000');

    // The holdings read knows of nothing (no facts at all): the credit is
    // there, to be claimed from the version that owns it.
    const state = derive({ snapshot });
    assert.equal(state.phase, 'claim-previous-credit');
    assert.deepEqual(state.previous, { versionId: 'v1', openWithdrawals: 0, credits: 1, canOpen: true, closeByTs: null });
    // It never closes deposits: money waiting is not an unfinished withdrawal.
    assert.deepEqual(state.gate, { canStart: true, canResume: false, code: null, successor: null });
    assert.equal(state.depositsOpen, true);
    assert.deepEqual(state.notices, []);

    // Without the SDK's report there is nothing to claim: the credit is what
    // moved the phase.
    const none = derive({ credits: [] });
    assert.equal(none.phase, 'current');
    assert.equal(none.previous, null);
});

test('wiring:other-deployment-credits the SDK\'s list and the holdings read are one list, counted by record', () => {
    const listed = credit(V1, 5);
    const held = { recordId: listed.record_id, noteId: 5, creditedAmount: '800000', destination: null };
    // The same record from both sources is one credit.
    const same = derive({ credits: [listed], facts: { credits: { v1: [held] } } });
    assert.equal(same.previous.credits, 1);
    // Each source may know a credit the other does not.
    const union = derive({ credits: [credit(V1, 6)], facts: { credits: { v1: [held] } } });
    assert.equal(union.previous.credits, 2);
    assert.equal(union.phase, 'claim-previous-credit');
    // The read alone is still enough, as it always was.
    const readOnly = derive({ credits: [], facts: { credits: { v1: [held] } } });
    assert.equal(readOnly.previous.credits, 1);
});

test('wiring:other-deployment-credits a credit beside an unfinished withdrawal of the same version does not take its place', () => {
    const open = { recordId: 'w-1', noteId: 3, mode: 'escape', phase: 'pending', expiryTs: null };
    const state = derive({ credits: [credit(V1, 5)], facts: { open: { v1: [open] } } });
    // The withdrawal is what holds deposits and what is told first.
    assert.equal(state.phase, 'finish-previous-withdrawal');
    assert.equal(state.gate.canStart, false);
    assert.equal(state.gate.code, 'previous_withdrawal_open');
    // Both are counted for the version that holds them.
    assert.equal(state.previous.versionId, 'v1');
    assert.equal(state.previous.openWithdrawals, 1);
    assert.equal(state.previous.credits, 1);
    // And the credit by itself is not what held them.
    assert.equal(derive({ credits: [credit(V1, 5)] }).gate.canStart, true);
});

test('wiring:other-deployment-credits a credit this build cannot name, or that is this version\'s own, offers nothing', () => {
    // A deployment the build has no row for cannot be opened, so it is not
    // offered and not named, and it blocks nothing.
    const stranger = derive({ credits: [credit(V1, 5, { deployment_id: 'who-knows' })] });
    assert.equal(stranger.phase, 'current');
    assert.equal(stranger.previous, null);
    assert.equal(stranger.gate.canStart, true);
    // The loaded version's own deployment is not "another deployment".
    const own = derive({ credits: [credit(V2, 5)] });
    assert.equal(own.phase, 'current');
    assert.equal(own.previous, null);
    // A retired deployment can never be finished by any bundle.
    const retired = mutated(activatedRegistry(), registry => {
        for (const network of ['mainnet', 'sepolia']) {
            registry.versions[0].networks[network].status = 'retired';
            registry.versions[0].networks[network].retiredAt = '2027-01-01T00:00:00Z';
            registry.versions[0].networks[network].tombstone = { deploymentId: V1.deploymentId, chainId: CHAIN, vault: V1.vault };
        }
    });
    const retiredTable = resolvedTable(retired, NETWORK);
    const gone = derive({ table: retiredTable, active: retiredTable[0], credits: [credit(V1, 5)] });
    assert.equal(gone.previous, null);
    assert.equal(gone.phase, 'current');
    // A malformed entry is no credit, and does not throw.
    assert.doesNotThrow(() => derive({ credits: [null, 4, 'x', {}, { deployment_id: 7 }] }));
    assert.equal(derive({ credits: [null, 4, 'x', {}] }).previous, null);
});

test('wiring:other-deployment-credits the person is told there is a payout to claim, and where, and that deposits go on', () => {
    const state = derive({ credits: [credit(V1, 5), credit(V1, 6)] });
    for (const surface of ['dialog', 'panel']) {
        const claim = noticesOf(state, surface).find(notice => notice.id === 'credit');
        assert.ok(claim, `${surface}: the credit is told`);
        assert.match(textOf(claim), /^A payout from version 1 is ready to claim\. Open version 1 to claim it\. This does not stop new deposits\./);
        assert.deepEqual(claim.actions.map(action => action.action), ['claim-credit'], surface);
    }
    // It outranks nothing: no deposit-blocked notice sits beside it.
    assert.equal(noticesOf(state).some(notice => notice.id === 'previous'), false);
    // The ticket surface carries it too, as it does for a credit from the read.
    assert.ok(noticesOf(state, 'ticket').some(notice => notice.id === 'credit'));
    // No credit, no notice.
    assert.equal(noticesOf(derive({ credits: [] })).some(notice => notice.id === 'credit'), false);
});

// ---------------------------------------------------------------------------
// Through the facade
// ---------------------------------------------------------------------------

function pageWith(t, credits) {
    resetActiveVersionForTests();
    installActiveVersion({
        table: TABLE, version: V2,
        // The holdings read of the wallet: an empty slot and nothing else anywhere.
        selection: chooseZkapiVersion({ table: TABLE, slotKind: 'empty', holdings: [] })
    });
    const facade = createZkapiVersioning({
        buildTable: TABLE, network: NETWORK, now: () => NOW_MS,
        sessionStorage: createFakeStorage(), localStorage: createFakeStorage(),
        reload() {}, setTimer: () => 0, clearTimer() {}
    });
    const client = {
        initialized: true,
        lastError: null,
        isNativeEthFunding: true,
        config: {
            funding: { contract_address: V2.vault, chain_id: V2.chainId },
            request_charge_cap: 50_000,
            other_deployment_credits: credits
        },
        wallet: null,
        withdrawals: [],
        deposits: [],
        activities: [],
        noteExpiryClaim: null,
        get note() { return null; },
        snapshot() {
            return { config: this.config, wallet: this.wallet, withdrawals: this.withdrawals, deposits: this.deposits,
                activities: this.activities };
        },
        subscribe() { return () => {}; },
        formatMoney(units) { return `$${(Number(units) / 1e9 * 3000).toFixed(2)}`; },
        formatBillingAmount(units) { return String(Number(units) / 1e9); },
        async refresh() {}
    };
    const runtime = { runtime: null, manifest: { deployment_id: V2.deploymentId }, activeLease: null,
        config: { request_charge_cap: 50_000 }, async assertServiceAvailable() {} };
    facade.attach({ client, runtime, integrity: 'ok', ui: null });
    t.after(() => { facade.resetForTests(); resetActiveVersionForTests(); });
    return { facade, client };
}

test('wiring:other-deployment-credits the facade offers the claim from the SDK\'s own list and keeps deposits open', t => {
    const { facade } = pageWith(t, [credit(V1, 5)]);
    const state = facade.state(NOW_MS);
    assert.equal(state.phase, 'claim-previous-credit');
    assert.deepEqual(state.previous, { versionId: 'v1', openWithdrawals: 0, credits: 1, canOpen: true, closeByTs: null });
    assert.deepEqual(facade.depositGate(), { canStart: true, canResume: false, code: null, successor: null });
    const claim = buildVersionNotices(state, { surface: 'dialog', now: NOW_MS, table: TABLE }).notices
        .find(notice => notice.id === 'credit');
    assert.ok(claim);
    assert.deepEqual(claim.actions.map(action => action.action), ['claim-credit']);

    // The same page when the SDK reports nothing says nothing.
    const quiet = pageWith(t, []).facade.state(NOW_MS);
    assert.equal(quiet.phase, 'current');
    assert.equal(quiet.previous, null);
});
