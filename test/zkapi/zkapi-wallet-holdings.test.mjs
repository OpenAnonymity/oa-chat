// The host-owned wallet holdings probe (chat/zkapi/versioning/walletHoldings.mjs).
//
// Pins: the classifier is the upstream one (cases embedded below, taken from
// the upstream holdings tests and the store's own rules) made fail-closed; the
// probe is read-only and never creates anything; databases written by the REAL
// legacy wallet store are read back correctly (schema parity); and the one
// host write, the draft discard, happens only under the wallet lock, only on a
// fresh read inside the write transaction, and only for provably unused work.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    WALLET_CHANNEL_NAME, WALLET_LOCK_NAME, classifyHoldings, describeSlot, discardDepositDraft,
    isOpenWithdrawalRecord, isUnclaimedPayoutCredit, knownSlotKeys, readWalletHoldings, slotHoldsState
} from '../../chat/zkapi/versioning/walletHoldings.mjs';
import { isUnsentPreparedDeposit } from '../../chat/zkapi/versioning/unsentDeposit.mjs';
import { resetCanceledDeposit } from '../../chat/zkapi/services/canceledDeposit.mjs';
import { createFakeEnvironment } from './_fakeIndexedDb.mjs';

const DB = 'zkapi-browser-wallet-v1';
const LEGACY = 'zkapi-native-eth-sepolia-note-bound-v1-fresh-20260930';
const OTHER = 'zkapi-native-eth-sepolia-concession-v1';
const VAULT = '0x00000000000000000000000000000000000000aa';
const DESTINATION = '0x00000000000000000000000000000000000000bb';
const NOTE_EXPIRY = 1_800_000_000;

const legacyStorePath = fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/store'));
let instance = 0;
// A fresh module instance per call: the store caches its IndexedDB connection.
async function loadLegacyStore() {
    return import(`${pathToFileURL(legacyStorePath).href}?holdings=${++instance}`);
}

async function inEnvironment(fn, options = {}) {
    const env = createFakeEnvironment();
    const restore = env.install(options);
    try {
        return await fn(env);
    } finally {
        restore();
    }
}

const noteState = (overrides = {}) => ({
    note_id: 5, deposit_amount: 100, expiry_ts: NOTE_EXPIRY, secret: 'SECRET-NOTE-MARKER', ...overrides
});
const preparedPlan = (overrides = {}) => ({
    operationId: 'op-1', createdAt: 1, phase: 'prepared', amount: 5, secret: 'SECRET-PLAN-MARKER',
    commitment: '0x01', next_note_id: 9, active_root: '0x02', zero_path: ['0x03'], ...overrides
});
const draftQuote = (overrides = {}) => ({
    operationId: 'quote-1', createdAt: 1, amount: 5, secret: 'SECRET-QUOTE-MARKER',
    commitment: '0x04', next_note_id: 9, active_root: '0x02', zero_path: ['0x03'], ...overrides
});
const withdrawalRecord = (overrides = {}) => ({
    recordId: `${LEGACY}:11155111:${VAULT}:7`, deploymentId: LEGACY, chainId: 11155111, contractAddress: VAULT,
    noteId: 7, mode: 'mutual', phase: 'parked', updatedAt: 10, ...overrides
});

// ----------------------------------------------------------------- classifier

test('slot state rule: what holds the runtime slot (upstream browserRuntimeHoldsState cases)', () => {
    for (const [slot, held] of [
        [{}, false],
        [null, false],
        [undefined, false],
        [{ version: 1, deploymentId: LEGACY, updatedAt: 5, billingAsset: 'native_eth', stateSeq: 3, exitKitExportedSeq: 2 }, false],
        [{ state: null, journal: null, pendingDeposit: null, depositQuote: null, preparedWithdrawal: null, lease: null,
            exitLock: null, lateWithdrawalAttempts: [], lateDepositAttempts: [] }, false],
        [{ lateWithdrawalAttempts: [{ status: 'closed' }, { status: 'detached' }, { status: 'reverted' },
            { status: 'challenged' }, { status: 'superseded' }, { status: 'quarantined' }],
        lateDepositAttempts: [{ status: 'confirmed' }, { status: 'reverted' }, { status: 'superseded' }] }, false],
        [{ state: noteState() }, true],
        [{ journal: { exists: true } }, true],
        [{ exitLock: { noteId: 5 } }, true],
        [{ pendingDeposit: preparedPlan() }, true],
        [{ depositQuote: draftQuote() }, true],
        [{ preparedWithdrawal: { phase: 'prepared' } }, true],
        [{ lease: { sessionId: 's' } }, true],
        [{ lateWithdrawalAttempts: [{ status: 'submitted' }] }, true],
        [{ lateDepositAttempts: [{ status: 'submitted' }] }, true],
        [{ lateWithdrawalAttempts: [{ status: 'closed' }, { status: 'pending' }] }, true]
    ]) {
        assert.equal(slotHoldsState(slot), held, JSON.stringify(slot));
    }
});

test('slot state rule is fail-closed: unknown keys, malformed containers and non-objects are held', () => {
    for (const [slot, held] of [
        [{ futureField: 'x' }, true],
        [{ futureField: 1 }, true],
        [{ futureField: true }, true],
        [{ futureField: [1] }, true],
        [{ futureField: { a: 1 } }, true],
        [{ futureField: 0 }, false],
        [{ futureField: '' }, false],
        [{ futureField: null }, false],
        [{ futureField: [] }, false],
        [{ futureField: {} }, false],
        [{ lateDepositAttempts: { status: 'submitted' } }, true],
        [{ lateWithdrawalAttempts: 'pending' }, true],
        [{ lateDepositAttempts: [null] }, true],
        [{ lateWithdrawalAttempts: [{}] }, true],
        ['a string', true],
        [42, true],
        [[], true],
        [[{ state: null }], true]
    ]) {
        assert.equal(slotHoldsState(slot), held, JSON.stringify(slot));
    }
});

test('open withdrawal rule (upstream isOpenBrowserWithdrawal cases)', () => {
    for (const [record, open] of [
        [{ phase: 'pending' }, true],
        [{ phase: 'parked' }, true],
        [{ phase: 'closed_unconfirmed' }, true],
        [{ phase: 'challenged_unconfirmed' }, true],
        [{ phase: 'submitted_unconfirmed' }, true],
        [{ phase: 'ambiguous' }, true],
        [{ phase: 'finalizing' }, true],
        [{ phase: 'restored' }, true],
        [{ phase: 'something_new' }, true],
        [{ phase: 'closed' }, false],
        [{ phase: 'closed', finalizeTransactionHashes: [] }, false],
        [{ phase: 'closed', finalizeSubmissionId: null, finalizeTransactionHash: null }, false],
        [{ phase: 'closed', finalizeSubmissionId: 'claim' }, true],
        [{ phase: 'closed', finalizeTransactionHash: `0x${'bb'.repeat(32)}` }, true],
        [{ phase: 'closed', finalizeTransactionHashes: [`0x${'cc'.repeat(32)}`] }, true],
        [null, false],
        [undefined, false]
    ]) {
        assert.equal(isOpenWithdrawalRecord(record), open, JSON.stringify(record));
    }
});

test('unclaimed payout credit rule (upstream isUnclaimedPayoutCredit cases)', () => {
    const credited = { payoutCredited: true, phase: 'closed' };
    assert.equal(isUnclaimedPayoutCredit(credited), true);
    assert.equal(isUnclaimedPayoutCredit({ ...credited, phase: 'closed_unconfirmed' }), true);
    assert.equal(isUnclaimedPayoutCredit({ ...credited, phase: 'pending' }), false);
    assert.equal(isUnclaimedPayoutCredit({ ...credited, payoutClaimed: true }), false);
    assert.equal(isUnclaimedPayoutCredit({ ...credited, payoutCredited: false }), false);
    assert.equal(isUnclaimedPayoutCredit({ phase: 'closed', payoutVerified: true }), false);
    assert.equal(isUnclaimedPayoutCredit(null), false);
});

test('holdings: the runtime slot owner first, then deployments by id; null id stays visible', () => {
    const holdings = classifyHoldings({
        runtime: { deploymentId: OTHER, state: noteState({ note_id: 1 }) },
        withdrawals: [
            withdrawalRecord({ updatedAt: 1 }),
            withdrawalRecord({ recordId: 'r-null', deploymentId: null, noteId: 3, phase: 'pending', updatedAt: 2 }),
            withdrawalRecord({ recordId: 'r-closed', noteId: 8, phase: 'closed' })
        ],
        deposits: []
    });
    assert.deepEqual(holdings.map(entry => [entry.deploymentId, entry.runtime, entry.withdrawals.map(w => w.recordId)]), [
        [OTHER, true, []],
        [LEGACY, false, [`${LEGACY}:11155111:${VAULT}:7`]],
        [null, false, ['r-null']]
    ].sort((left, right) => Number(right[1]) - Number(left[1]) || String(left[0]).localeCompare(String(right[0]))));
});

test('holdings: set-aside close of a legacy deployment while another deployment holds the slot', () => {
    const holdings = classifyHoldings({
        runtime: { deploymentId: OTHER, state: noteState({ note_id: 1 }) },
        withdrawals: [withdrawalRecord()]
    });
    assert.deepEqual(holdings, [
        { deploymentId: OTHER, runtime: true, withdrawals: [], credits: [] },
        { deploymentId: LEGACY, runtime: false, credits: [], withdrawals: [{
            recordId: `${LEGACY}:11155111:${VAULT}:7`, noteId: 7, mode: 'mutual', phase: 'parked', expiryTs: null
        }] }
    ]);
});

test('holdings: empty slot, sanitized closes and finished closes are not holdings', () => {
    assert.deepEqual(classifyHoldings({ runtime: null, withdrawals: [] }), []);
    assert.deepEqual(classifyHoldings({
        runtime: { deploymentId: LEGACY, state: null },
        withdrawals: [withdrawalRecord({ phase: 'closed' })]
    }), []);
});

test('holdings: withdrawals are ordered newest first and carry only public fields', () => {
    const [entry] = classifyHoldings({
        runtime: null,
        withdrawals: [
            withdrawalRecord({ recordId: 'old', noteId: 1, updatedAt: 1, state: noteState({ note_id: 1 }),
                preparedWithdrawal: { secret: 'SECRET-PREPARED' }, proof: 'SECRET-PROOF' }),
            withdrawalRecord({ recordId: 'new', noteId: 2, updatedAt: 9, state: noteState({ note_id: 2 }) })
        ]
    });
    assert.deepEqual(entry.withdrawals.map(record => record.recordId), ['new', 'old']);
    assert.deepEqual(Object.keys(entry.withdrawals[0]).sort(),
        ['expiryTs', 'mode', 'noteId', 'phase', 'recordId']);
    assert.equal(JSON.stringify(entry).includes('SECRET'), false);
});

test('holdings: expiry comes from the deposit row, then from the record state, else null', () => {
    const holdings = classifyHoldings({
        runtime: null,
        withdrawals: [
            withdrawalRecord({ recordId: 'a', noteId: 1, state: noteState({ note_id: 1, expiry_ts: 111 }) }),
            withdrawalRecord({ recordId: 'b', noteId: 2, state: noteState({ note_id: 2, expiry_ts: 222 }) }),
            withdrawalRecord({ recordId: 'c', noteId: 3, state: null }),
            withdrawalRecord({ recordId: 'd', noteId: 4, state: noteState({ note_id: 4, expiry_ts: 0 }) }),
            withdrawalRecord({ recordId: 'e', deploymentId: OTHER, noteId: 1, state: null })
        ],
        deposits: [
            { recordId: `${LEGACY}:deposit:1`, deploymentId: LEGACY, noteId: 1, expiryTs: 999 },
            { recordId: `${LEGACY}:deposit:3`, deploymentId: LEGACY, noteId: 3, expiryTs: 333 },
            { recordId: `${OTHER}:deposit:9`, deploymentId: OTHER, noteId: 9, expiryTs: 5 },
            { recordId: 'junk', deploymentId: LEGACY, noteId: 4, expiryTs: -5 }
        ]
    });
    const byId = Object.fromEntries(holdings.flatMap(entry => entry.withdrawals).map(record => [record.recordId, record.expiryTs]));
    assert.deepEqual(byId, { a: 999, b: 222, c: 333, d: null, e: null });
});

test('holdings: unclaimed payout credits, alone and beside an open record', () => {
    const credited = withdrawalRecord({
        recordId: `${LEGACY}:11155111:${VAULT}:7`, mode: 'escape', phase: 'closed', payoutCredited: true,
        payoutVerified: false, creditedAmount: 5_000_000, destination: DESTINATION, updatedAt: 3
    });
    const credit = {
        recordId: credited.recordId, noteId: 7, chainId: 11155111, contractAddress: VAULT,
        destination: DESTINATION, creditedAmount: '5000000'
    };
    // A final credited escape holds no note: listed for its credit only.
    assert.deepEqual(classifyHoldings({ runtime: null, withdrawals: [credited] }),
        [{ deploymentId: LEGACY, runtime: false, withdrawals: [], credits: [credit] }]);
    // Awaiting finality it is both an open record and a credit.
    const [pending] = classifyHoldings({ runtime: null, withdrawals: [{ ...credited, phase: 'closed_unconfirmed' }] });
    assert.equal(pending.withdrawals.length, 1);
    assert.deepEqual(pending.credits, [credit]);
    for (const changes of [{ payoutClaimed: true }, { payoutCredited: false }, { payoutCredited: undefined }]) {
        assert.deepEqual(classifyHoldings({ runtime: null, withdrawals: [{ ...credited, ...changes }] }), [],
            JSON.stringify(changes));
    }
    // A missing credited amount stays null.
    const [unknown] = classifyHoldings({ runtime: null, withdrawals: [{ ...credited, creditedAmount: undefined }] });
    assert.equal(unknown.credits[0].creditedAmount, null);
});

test('holdings: malformed input is never read as "nothing held"', () => {
    assert.throws(() => classifyHoldings(null), error => error.code === 'holdings_unreadable');
    assert.throws(() => classifyHoldings({ runtime: null }), error => error.code === 'holdings_unreadable');
    assert.throws(() => classifyHoldings({ runtime: null, withdrawals: {} }), error => error.code === 'holdings_unreadable');
    // A slot that is not an object is held by an unknown owner.
    assert.deepEqual(classifyHoldings({ runtime: 'corrupt', withdrawals: [] }),
        [{ deploymentId: null, runtime: true, withdrawals: [], credits: [] }]);
    // A truthy non-object withdrawal record counts as open.
    const [entry] = classifyHoldings({ runtime: null, withdrawals: ['corrupt'] });
    assert.equal(entry.deploymentId, null);
    assert.equal(entry.withdrawals.length, 1);
});

test('slot kinds', () => {
    const table = [
        [null, 'empty'],
        [{}, 'empty'],
        [{ version: 1, deploymentId: LEGACY, updatedAt: 5 }, 'empty'],
        [{ lateDepositAttempts: [{ status: 'confirmed' }] }, 'empty'],
        [{ deploymentId: LEGACY, depositQuote: draftQuote() }, 'draft_only'],
        [{ deploymentId: LEGACY, pendingDeposit: preparedPlan() }, 'unsent_prepared'],
        [{ deploymentId: LEGACY, pendingDeposit: preparedPlan(), depositQuote: draftQuote() }, 'unsent_prepared'],
        [{ deploymentId: LEGACY, state: noteState() }, 'note'],
        [{ deploymentId: LEGACY, state: noteState(), pendingDeposit: preparedPlan() }, 'note'],
        [{ deploymentId: LEGACY, pendingDeposit: preparedPlan({ phase: 'submitted' }) }, 'pending_deposit'],
        [{ deploymentId: LEGACY, pendingDeposit: preparedPlan({ submissionId: 'claim' }) }, 'pending_deposit'],
        [{ deploymentId: LEGACY, pendingDeposit: preparedPlan({ transactionHash: '0x01' }) }, 'pending_deposit'],
        // A plan field this code does not know that is set: not provably unsent.
        [{ deploymentId: LEGACY, pendingDeposit: preparedPlan({ fundingQuote: { id: 1 } }) }, 'pending_deposit'],
        [{ deploymentId: LEGACY, pendingDeposit: preparedPlan({ legacyRecovery: false, transactionHashes: [] }) }, 'unsent_prepared'],
        [{ deploymentId: LEGACY, journal: { a: 1 } }, 'other'],
        [{ deploymentId: LEGACY, lease: { a: 1 }, depositQuote: draftQuote() }, 'other'],
        [{ deploymentId: LEGACY, exitLock: { noteId: 1 } }, 'other'],
        [{ deploymentId: LEGACY, lateDepositAttempts: [{ status: 'submitted' }] }, 'other'],
        [{ deploymentId: LEGACY, depositQuote: draftQuote(), futureField: 'x' }, 'other'],
        ['corrupt', 'other']
    ];
    for (const [slot, kind] of table) assert.equal(describeSlot(slot), kind, JSON.stringify(slot));
});

// ---------------------------------------------------------------- the probe

test('the probe never creates a database and leaves no connection behind', async () => {
    await inEnvironment(async env => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const result = await readWalletHoldings({ database: DB });
            assert.deepEqual(result, { holdings: [], slot: { deploymentId: null, kind: 'empty' } });
            assert.equal(env.idb.has(DB), false);
            assert.deepEqual(await env.idb.databases(), []);
            assert.equal(env.idb.connectionCount(DB), 0);
        }
        const ops = env.idb.log.map(entry => entry.op).filter(op => op !== 'open-request');
        assert.deepEqual(ops, ['upgrade-start', 'abort', 'upgrade-aborted', 'upgrade-start', 'abort', 'upgrade-aborted']);
        assert.equal(env.idb.committedWrites().length, 0);
        // The next real opener still finds nothing and creates it itself.
        const store = await loadLegacyStore();
        await store.readBrowserWallet();
        assert.equal(env.idb.version(DB), 3);
    });
});

test('schema parity: a database written by the legacy wallet store reads back through the probe', async () => {
    await inEnvironment(async env => {
        const store = await loadLegacyStore();
        // Note 5 first (its deposit row records the expiry), then set aside as a
        // record without any state, then a newer note 9 in the slot.
        await store.writeBrowserWallet({ deploymentId: LEGACY, state: noteState({ note_id: 5, expiry_ts: 1_800_000_111 }) });
        await store.putBrowserWithdrawal({
            recordId: `${LEGACY}:11155111:${VAULT}:5`, deploymentId: LEGACY, noteId: 5, mode: 'mutual', phase: 'parked',
            state: { note_id: 5, deposit_amount: 100, secret: 'SECRET-NOTE-MARKER' }
        });
        await store.writeBrowserWallet({ deploymentId: LEGACY, state: noteState({ note_id: 9, expiry_ts: 1_800_000_999 }) });
        await store.putBrowserWithdrawal({
            recordId: `${LEGACY}:11155111:${VAULT}:6`, deploymentId: LEGACY, noteId: 6, mode: 'escape', phase: 'closed'
        });

        // The store's own schema is what the probe reads.
        const dump = env.idb.dump()[DB];
        assert.equal(dump.version, 3);
        assert.deepEqual(Object.fromEntries(Object.entries(dump.stores).map(([name, spec]) => [name, spec.keyPath])),
            { archives: 'archiveId', deposits: 'recordId', runtime: null, withdrawals: 'recordId' });
        assert.ok(dump.stores.runtime.records.active, 'the slot lives under the key "active"');
        const before = env.idb.dump();
        const mark = env.idb.log.length;

        const result = await readWalletHoldings({ database: DB });
        assert.deepEqual(result, {
            holdings: [{
                deploymentId: LEGACY,
                runtime: true,
                withdrawals: [{
                    recordId: `${LEGACY}:11155111:${VAULT}:5`, noteId: 5, mode: 'mutual', phase: 'parked',
                    expiryTs: 1_800_000_111
                }],
                credits: []
            }],
            slot: { deploymentId: LEGACY, kind: 'note' }
        });
        assert.equal(JSON.stringify(result).includes('SECRET'), false);

        // Read-only: the stored bytes are identical and nothing was upgraded.
        assert.deepEqual(env.idb.dump(), before);
        const since = env.idb.log.slice(mark).map(entry => entry.op);
        assert.deepEqual(since.filter(op => !['open-request', 'open-success', 'close'].includes(op)), []);
        assert.equal(env.idb.connectionCount(DB), 1, 'only the store keeps its own connection');
    });
});

test('schema parity: slot kinds written by the legacy store', async () => {
    await inEnvironment(async env => {
        const store = await loadLegacyStore();
        const kindOf = async () => (await readWalletHoldings({ database: DB })).slot.kind;
        assert.equal(await (async () => { await store.readBrowserWallet(); return kindOf(); })(), 'empty');
        await store.writeBrowserWallet({ deploymentId: LEGACY, depositQuote: draftQuote() });
        assert.equal(await kindOf(), 'draft_only');
        await store.writeBrowserWallet({ deploymentId: LEGACY, depositQuote: null, pendingDeposit: preparedPlan() });
        assert.equal(await kindOf(), 'unsent_prepared');
        await store.writeBrowserWallet({ deploymentId: LEGACY, pendingDeposit: preparedPlan({ phase: 'awaiting_wallet', submissionId: 's' }) });
        assert.equal(await kindOf(), 'pending_deposit');
        await store.writeBrowserWallet({ deploymentId: LEGACY, state: noteState() });
        assert.equal(await kindOf(), 'note');
        await store.writeBrowserWallet({ deploymentId: LEGACY });
        assert.equal(await kindOf(), 'empty');
        assert.equal(env.idb.handlerErrors.length, 0);
    });
});

// ------------------------------------------------------------ drift guard

// The runtime slot's keys as `sdk/test/fixtures/v2c-store-snapshot.json` of the
// successor SDK (zkapi 0.2.0, upstream revision 82c8504) records them in
// runtime.active. The fixture is a dump of what that build writes, including
// the three keys its runtime adds on commit (billingAsset, stateSeq,
// exitKitExportedSeq) that its EMPTY_RUNTIME does not list. Update this list
// when the SDK pin moves, from the new snapshot, never by hand-editing alone.
const UPSTREAM_V2C_SLOT_KEYS = [
    'version', 'deploymentId', 'state', 'journal', 'pendingDeposit', 'depositQuote', 'preparedWithdrawal',
    'exitLock', 'lease', 'lateWithdrawalAttempts', 'lateDepositAttempts', 'updatedAt', 'billingAsset',
    'stateSeq', 'exitKitExportedSeq'
];

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

// Every SDK store this checkout can run: the installed legacy package, the
// 0.2.0 stand-in fixture, and each registry alias that is installed (so the
// activation of a new version brings its real store under this guard).
function installedStores() {
    const stores = [
        { name: 'installed legacy SDK', file: legacyStorePath },
        {
            name: 'successor SDK stand-in fixture',
            file: path.join(repoRoot, 'test/fixtures/zkapi-sdk-v2-fixture/sdk/services/browserWalletStore.js')
        }
    ];
    const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'deployments/zkapi/registry.json'), 'utf8'));
    for (const row of registry.versions) {
        const file = path.join(repoRoot, 'node_modules', row.sdk.alias, 'sdk/services/browserWalletStore.js');
        if (fs.existsSync(file) && !stores.some(store => fs.realpathSync(store.file) === fs.realpathSync(file))) {
            stores.push({ name: `registry alias ${row.sdk.alias}`, file });
        }
    }
    return stores;
}

async function emptyRuntimeOf(file) {
    return inEnvironment(async () => {
        const store = await import(`${pathToFileURL(file).href}?drift=${++instance}`);
        return store.readBrowserWallet();
    });
}

test('drift guard: every field of every SDK store\'s runtime slot is one this module classifies', async () => {
    const known = knownSlotKeys();
    const classified = new Set([...known.metadata, ...known.state]);
    assert.equal(classified.size, known.metadata.length + known.state.length, 'a key has one role');

    const stores = installedStores();
    assert.ok(stores.length >= 2 && fs.existsSync(stores[0].file) && fs.existsSync(stores[1].file));
    const evidence = new Set(UPSTREAM_V2C_SLOT_KEYS);
    for (const { name, file } of stores) {
        const runtime = await emptyRuntimeOf(file);
        const keys = Object.keys(runtime);
        assert.ok(keys.includes('state') && keys.includes('depositQuote'), `${name}: read an empty runtime slot`);
        for (const key of keys) {
            assert.ok(classified.has(key), `${name}: the slot field "${key}" is not in walletHoldings.mjs. ` +
                'Classify it (METADATA_KEYS if it never holds funds or recovery state, STATE_KEYS otherwise) ' +
                'before activating this SDK: an unknown truthy field reads as held and pins every user.');
            evidence.add(key);
        }
        // An empty slot of that SDK is empty, kind and rule alike.
        assert.equal(slotHoldsState(runtime), false, name);
        assert.equal(describeSlot(runtime), 'empty', name);
    }
    // The v2c snapshot's keys, one by one.
    for (const key of UPSTREAM_V2C_SLOT_KEYS) assert.ok(classified.has(key), `v2c snapshot: ${key}`);
    // And nothing is classified on no evidence at all (a stale entry).
    for (const key of classified) assert.ok(evidence.has(key), `no SDK store has a "${key}" slot field`);
    // A full v2c-shaped slot at rest holds nothing, and one with a draft is a draft.
    const atRest = Object.fromEntries(UPSTREAM_V2C_SLOT_KEYS.map(key => [key, null]));
    Object.assign(atRest, {
        version: 1, deploymentId: LEGACY, lateWithdrawalAttempts: [], lateDepositAttempts: [], updatedAt: 1,
        billingAsset: 'native_eth', stateSeq: 3, exitKitExportedSeq: 2
    });
    assert.equal(describeSlot(atRest), 'empty');
    assert.equal(describeSlot({ ...atRest, depositQuote: draftQuote() }), 'draft_only');
    assert.equal(describeSlot({ ...atRest, exitLock: { noteId: 4, mode: 'escape' } }), 'other');
    // The guard's negative control: a field nobody classified is held.
    assert.equal(classified.has('brandNewBookkeeping'), false);
    assert.equal(slotHoldsState({ ...atRest, brandNewBookkeeping: 'x' }), true);
    assert.equal(describeSlot({ ...atRest, brandNewBookkeeping: 'x' }), 'other');
});

test('drift guard: a slot written by each SDK store is read and discarded as what it is', async () => {
    for (const { name, file } of installedStores()) {
        await inEnvironment(async env => {
            const store = await import(`${pathToFileURL(file).href}?drift=${++instance}`);
            await store.writeBrowserWallet({ deploymentId: LEGACY, depositQuote: draftQuote() });
            assert.equal((await readWalletHoldings({ database: DB })).slot.kind, 'draft_only', name);
            assert.deepEqual(await discardDepositDraft({ database: DB, expectedDeploymentId: LEGACY }),
                { discarded: true }, name);
            assert.equal(rawSlot(env).depositQuote, null, name);
            assert.equal((await readWalletHoldings({ database: DB })).slot.kind, 'empty', name);
        });
    }
});

test('a database below the current version or missing stores is read as it is, never upgraded', async () => {
    await inEnvironment(async env => {
        env.idb.seed(DB, { version: 2, stores: {
            runtime: { records: { active: { deploymentId: LEGACY, state: noteState() } } },
            withdrawals: { keyPath: 'recordId', records: { r: withdrawalRecord({ recordId: 'r' }) } }
        } });
        const before = env.idb.dump();
        const result = await readWalletHoldings({ database: DB });
        assert.equal(result.slot.kind, 'note');
        assert.equal(result.holdings[0].withdrawals[0].expiryTs, null);
        assert.deepEqual(env.idb.dump(), before);
        assert.equal(env.idb.version(DB), 2);
        assert.deepEqual(env.idb.storeNames(DB), ['runtime', 'withdrawals']);

        // A database without any of the three stores holds nothing.
        env.idb.seed('other', { version: 1, stores: { unrelated: { records: { a: 1 } } } });
        assert.deepEqual(await readWalletHoldings({ database: 'other' }),
            { holdings: [], slot: { deploymentId: null, kind: 'empty' } });
    });
});

test('probe failures reject with a code and release the connection', async () => {
    await inEnvironment(async env => {
        env.idb.seed(DB, { version: 3, stores: { runtime: {}, withdrawals: { keyPath: 'recordId' }, deposits: { keyPath: 'recordId' } } });

        env.idb.failNextOpen();
        await assert.rejects(readWalletHoldings({ database: DB }), error => error.code === 'holdings_unreadable');

        const release = env.idb.hangNextOpen();
        await assert.rejects(readWalletHoldings({ database: DB, timeoutMs: 30 }),
            error => error.code === 'holdings_timeout');
        // The connection that finally arrives is closed, not leaked.
        release();
        await env.idb.idle();
        assert.equal(env.idb.connectionCount(DB), 0);

        await assert.rejects(readWalletHoldings({ database: '' }), error => error.code === 'holdings_unreadable');
    });
    // No IndexedDB at all: the environment above is restored, and Node has none.
    assert.equal(globalThis.indexedDB, undefined);
    await assert.rejects(readWalletHoldings({ database: DB }), error => error.code === 'holdings_unreadable');
});

test('a version upgrade by another tab never waits on the probe', async () => {
    await inEnvironment(async env => {
        const store = await loadLegacyStore();
        await store.writeBrowserWallet({ deploymentId: LEGACY, state: noteState() });
        // The upgrade is requested while the probe's transaction is in flight.
        const probe = readWalletHoldings({ database: DB });
        const upgrade = new Promise((resolve, reject) => {
            const request = env.idb.forTab('newer-build').open(DB, 4);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const [result, connection] = await Promise.all([probe, upgrade]);
        assert.equal(result.slot.kind, 'note');
        assert.equal(connection.version, 4);
        connection.close();
    });
});

// ----------------------------------------------------------------- discarding

async function legacySlot(env, fields) {
    const store = await loadLegacyStore();
    await store.writeBrowserWallet({ deploymentId: LEGACY, ...fields });
    return store;
}

const rawSlot = env => env.idb.read(DB, 'runtime', 'active');

test('discard clears a deposit draft under the wallet lock and touches nothing else', async () => {
    await inEnvironment(async env => {
        await legacySlot(env, {
            depositQuote: draftQuote(),
            lateWithdrawalAttempts: [{ status: 'closed', recordId: 'x' }],
            lateDepositAttempts: [{ status: 'confirmed', operationId: 'old' }]
        });
        const before = rawSlot(env);
        const otherStores = env.idb.dump()[DB].stores;
        env.trace.length = 0;
        const result = await discardDepositDraft({ database: DB });
        assert.deepEqual(result, { discarded: true });
        const after = rawSlot(env);
        assert.deepEqual(Object.keys(after), Object.keys(before));
        assert.equal(after.depositQuote, null);
        assert.ok(after.updatedAt > before.updatedAt);
        const { depositQuote: _a, updatedAt: _b, ...restAfter } = after;
        const { depositQuote: _c, updatedAt: _d, ...restBefore } = before;
        assert.deepEqual(restAfter, restBefore);
        assert.equal(after.version, 1);
        // The other stores did not change.
        const stores = env.idb.dump()[DB].stores;
        for (const name of ['withdrawals', 'deposits', 'archives']) assert.deepEqual(stores[name], otherStores[name]);
        // One runtime-only commit, strictly inside the lock, then a change message.
        assert.deepEqual(env.trace.map(entry => entry.type), ['lock-acquire', 'idb-commit', 'lock-release', 'channel-post']);
        assert.deepEqual(env.trace[1].stores, ['runtime']);
        assert.deepEqual(env.trace[1].writes, [{ store: 'runtime', op: 'put', key: 'active' }]);
        assert.equal(env.trace[0].name, WALLET_LOCK_NAME);
        assert.equal(env.trace[3].name, WALLET_CHANNEL_NAME);
        assert.deepEqual(env.trace[3].data, { updatedAt: after.updatedAt });
        assert.equal(env.idb.connectionCount(DB), 1, 'the discard closes its connection');
        assert.equal(env.channels.openCount(WALLET_CHANNEL_NAME), 0);
        // And a probe now sees an empty slot.
        assert.equal((await readWalletHoldings({ database: DB })).slot.kind, 'empty');
    });
});

test('discard clears a never-sent prepared plan and its draft, nothing more', async () => {
    await inEnvironment(async env => {
        await legacySlot(env, { pendingDeposit: preparedPlan(), depositQuote: draftQuote() });
        const before = rawSlot(env);
        assert.deepEqual(await discardDepositDraft({ database: DB, expectedDeploymentId: LEGACY }), { discarded: true });
        const after = rawSlot(env);
        assert.equal(after.pendingDeposit, null);
        assert.equal(after.depositQuote, null);
        assert.deepEqual(Object.keys(after), Object.keys(before));
        assert.equal(after.deploymentId, LEGACY);
    });
});

test('discard does not add fields the slot never had', async () => {
    await inEnvironment(async env => {
        env.idb.seed(DB, { version: 3, stores: {
            runtime: { records: { active: { version: 1, deploymentId: LEGACY, pendingDeposit: preparedPlan(), updatedAt: 5 } } },
            withdrawals: { keyPath: 'recordId' }, deposits: { keyPath: 'recordId' }, archives: { keyPath: 'archiveId' }
        } });
        assert.deepEqual(await discardDepositDraft({ database: DB }), { discarded: true });
        const after = rawSlot(env);
        assert.deepEqual(Object.keys(after), ['version', 'deploymentId', 'pendingDeposit', 'updatedAt']);
        assert.equal(after.pendingDeposit, null);
    });
});

const REFUSED_SLOTS = {
    'a started plan: phase submitted': { pendingDeposit: preparedPlan({ phase: 'submitted' }) },
    'a started plan: phase ambiguous': { pendingDeposit: preparedPlan({ phase: 'ambiguous' }) },
    'a started plan: phase awaiting_wallet': { pendingDeposit: preparedPlan({ phase: 'awaiting_wallet' }) },
    'a started plan: phase retry_exact': { pendingDeposit: preparedPlan({ phase: 'retry_exact' }) },
    'a started plan: legacyRecovery': { pendingDeposit: preparedPlan({ legacyRecovery: true }) },
    'a started plan: submissionId': { pendingDeposit: preparedPlan({ submissionId: 'claim' }) },
    'a started plan: submissionOwner': { pendingDeposit: preparedPlan({ submissionOwner: 'tab' }) },
    'a started plan: submissionFrom': { pendingDeposit: preparedPlan({ submissionFrom: '0xabc' }) },
    'a started plan: submissionNonce zero': { pendingDeposit: preparedPlan({ submissionNonce: 0 }) },
    'a started plan: transactionHash': { pendingDeposit: preparedPlan({ transactionHash: '0x123' }) },
    'a started plan: transactionHashes': { pendingDeposit: preparedPlan({ transactionHashes: ['0x123'] }) },
    'a started plan: transactionAttempts': { pendingDeposit: preparedPlan({ transactionAttempts: [{ hash: '0x1' }] }) },
    'a started plan: ambiguousSubmissions': { pendingDeposit: preparedPlan({ ambiguousSubmissions: [{}] }) },
    'a started plan: approvals': { pendingDeposit: preparedPlan({ approvals: [{}] }) },
    'a plan with a field this code does not know': { pendingDeposit: preparedPlan({ somethingNew: { id: 1 } }) },
    'a late attempt for the same operation': {
        pendingDeposit: preparedPlan(), lateDepositAttempts: [{ operationId: 'op-1', status: 'confirmed' }]
    },
    'an unfinished late deposit attempt': {
        depositQuote: draftQuote(), lateDepositAttempts: [{ operationId: 'z', status: 'submitted' }]
    },
    'an unfinished late withdrawal attempt': {
        depositQuote: draftQuote(), lateWithdrawalAttempts: [{ status: 'submitted' }]
    },
    'an active note': { state: noteState(), depositQuote: draftQuote() },
    'a request journal': { journal: { nullifier: '0x1' }, depositQuote: draftQuote() },
    'a lease': { lease: { sessionId: 's' }, depositQuote: draftQuote() },
    'a prepared withdrawal': { preparedWithdrawal: { phase: 'prepared' }, depositQuote: draftQuote() },
    'an exit lock': { exitLock: { noteId: 5 }, depositQuote: draftQuote() },
    'an unknown slot field': { futureField: 'x', depositQuote: draftQuote() },
    'an unknown slot field that is empty': { futureField: null, depositQuote: draftQuote() }
};

for (const [name, fields] of Object.entries(REFUSED_SLOTS)) {
    test(`discard refuses ${name}`, async () => {
        await inEnvironment(async env => {
            env.idb.seed(DB, { version: 3, stores: {
                runtime: { records: { active: { version: 1, deploymentId: LEGACY, updatedAt: 5, ...fields } } },
                withdrawals: { keyPath: 'recordId' }, deposits: { keyPath: 'recordId' }, archives: { keyPath: 'archiveId' }
            } });
            const before = env.idb.dump();
            const result = await discardDepositDraft({ database: DB });
            assert.deepEqual(result, { discarded: false, why: 'not_discardable' });
            assert.deepEqual(env.idb.dump(), before);
            assert.equal(env.idb.committedWrites().length, 0);
            assert.equal(env.channels.posted.length, 0);
        });
    });
}

test('discard refuses a slot of another version, another owner, or no owner', async () => {
    await inEnvironment(async env => {
        const seed = slot => env.idb.seed(DB, { version: 3, stores: {
            runtime: { records: { active: slot } }, withdrawals: { keyPath: 'recordId' }, deposits: { keyPath: 'recordId' }
        } });
        seed({ version: 2, deploymentId: LEGACY, depositQuote: draftQuote() });
        assert.equal((await discardDepositDraft({ database: DB })).why, 'not_discardable');
        seed({ version: 1, deploymentId: null, depositQuote: draftQuote() });
        assert.equal((await discardDepositDraft({ database: DB })).why, 'not_discardable');
        seed({ version: 1, depositQuote: draftQuote() });
        assert.equal((await discardDepositDraft({ database: DB })).why, 'not_discardable');
        seed({ version: 1, deploymentId: LEGACY, depositQuote: draftQuote() });
        assert.equal((await discardDepositDraft({ database: DB, expectedDeploymentId: OTHER })).why, 'not_discardable');
        assert.equal(env.idb.committedWrites().length, 0);
        assert.deepEqual(await discardDepositDraft({ database: DB, expectedDeploymentId: LEGACY }), { discarded: true });
    });
});

test('discard needs Web Locks and the lock to be free', async () => {
    await inEnvironment(async env => {
        await legacySlot(env, { depositQuote: draftQuote() });
        const before = env.idb.dump();
        const mark = env.idb.log.length;

        // Another tab (or the SDK) holds the wallet lock.
        let release;
        const hold = new Promise(resolve => { release = resolve; });
        const holder = env.locks.forTab('other-tab').request(WALLET_LOCK_NAME, () => hold);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(await discardDepositDraft({ database: DB }), { discarded: false, why: 'lock_busy' });
        assert.deepEqual(env.idb.dump(), before);
        assert.equal(env.idb.committedWrites().length > 0, true, 'the setup write only');
        assert.equal(env.idb.log.slice(mark).some(entry => entry.op === 'commit'), false);
        release();
        await holder;

        // Free again: the same call now writes.
        assert.deepEqual(await discardDepositDraft({ database: DB }), { discarded: true });
    });
    await inEnvironment(async env => {
        await legacySlot(env, { depositQuote: draftQuote() });
        const before = env.idb.dump();
        const mark = env.idb.log.length;
        assert.deepEqual(await discardDepositDraft({ database: DB }), { discarded: false, why: 'no_locks' });
        assert.deepEqual(await discardDepositDraft({ database: DB, locks: {} }), { discarded: false, why: 'no_locks' });
        assert.deepEqual(env.idb.dump(), before);
        assert.equal(env.idb.log.slice(mark).length, 0, 'without Web Locks the database is not even opened');
    }, { locks: false });
});

test('discard re-verifies under the lock: a claim made while waiting wins', async () => {
    await inEnvironment(async env => {
        const store = await legacySlot(env, { pendingDeposit: preparedPlan() });
        // The probe would have called this an unsent plan. Before the lock is
        // granted another tab claims the submission.
        const racing = {
            async request(name, options, callback) {
                await store.writeBrowserWallet({
                    deploymentId: LEGACY,
                    pendingDeposit: preparedPlan({ phase: 'awaiting_wallet', submissionId: 'claim', submissionOwner: 'tab-b' })
                });
                return env.locks.request(name, options, callback);
            }
        };
        const result = await discardDepositDraft({ database: DB, locks: racing });
        assert.deepEqual(result, { discarded: false, why: 'not_discardable' });
        assert.equal(rawSlot(env).pendingDeposit.submissionId, 'claim');
        assert.equal(env.channels.posted.length, 0);
    });
});

test('discard reports unreadable storage and never throws', async () => {
    await inEnvironment(async env => {
        await legacySlot(env, { depositQuote: draftQuote() });
        env.idb.failNextOpen();
        assert.deepEqual(await discardDepositDraft({ database: DB }), { discarded: false, why: 'unreadable' });
        const release = env.idb.hangNextOpen();
        assert.deepEqual(await discardDepositDraft({ database: DB, timeoutMs: 30 }), { discarded: false, why: 'unreadable' });
        release();
        await env.idb.idle();
        assert.equal(env.idb.connectionCount(DB), 1);
        assert.deepEqual(await discardDepositDraft({ database: '' }), { discarded: false, why: 'unreadable' });
        assert.deepEqual(await discardDepositDraft(), { discarded: false, why: 'unreadable' });
        // A database that does not exist: nothing to discard, nothing created.
        assert.deepEqual(await discardDepositDraft({ database: 'missing-db' }), { discarded: false, why: 'not_discardable' });
        assert.equal(env.idb.has('missing-db'), false);
        assert.equal(env.idb.committedWrites().filter(write => write.store === 'runtime').length, 1, 'the setup write only');
    });
});

test('discard posts through a given channel and leaves it open', async () => {
    await inEnvironment(async env => {
        await legacySlot(env, { depositQuote: draftQuote() });
        const posted = [];
        const channel = { postMessage: message => posted.push(message), close() { throw new Error('must not be closed'); } };
        assert.deepEqual(await discardDepositDraft({ database: DB, channel }), { discarded: true });
        assert.equal(posted.length, 1);
        assert.equal(posted[0].updatedAt, rawSlot(env).updatedAt);
        assert.equal(env.channels.posted.length, 0);
        // A throwing channel does not undo or fail the committed write.
        await legacySlot(env, { depositQuote: draftQuote({ operationId: 'again' }) });
        const broken = { postMessage() { throw new Error('closed'); } };
        assert.deepEqual(await discardDepositDraft({ database: DB, channel: broken }), { discarded: true });
    });
});

// ------------------------------------------------- the shared unsent predicate

// The predicate as canceledDeposit.mjs states it, copied here so that the
// parity below keeps meaning something after canceledDeposit.mjs starts
// importing the shared module.
function referenceUnsent(state, expectedOperationId) {
    const plan = state?.pendingDeposit;
    if (!plan || plan.operationId !== expectedOperationId || state.state
        || plan.phase !== 'prepared' || plan.legacyRecovery
        || plan.submissionId || plan.submissionOwner || plan.submissionFrom
        || plan.submissionNonce != null || plan.transactionHash
        || plan.transactionHashes?.length || plan.transactionAttempts?.length
        || plan.ambiguousSubmissions?.length || plan.approvals?.length
        || state.lateDepositAttempts?.some(attempt => attempt.operationId === expectedOperationId)) return false;
    return true;
}

// What the live canceledDeposit.mjs decides for the same slot: it releases the
// plan (commits pendingDeposit: null) exactly when it considers it unsent.
async function liveVerdict(slot, expectedOperationId) {
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001, broadcastPossible: false });
    const runtime = {
        manifest: { deployment_id: 'deployment' }, runtime: structuredClone(slot),
        async init() {}, async reload() {}, async commit(next) { this.runtime = next; }
    };
    const client = { browserMode: true, config: { pending_deposit: null } };
    return resetCanceledDeposit(rejection, expectedOperationId, {
        client, runtime, withWalletLock: async (scope, callback) => callback()
    });
}

const PARITY_SLOTS = (() => {
    const plan = (overrides = {}) => ({ phase: 'prepared', operationId: 'original', secret: 's', ...overrides });
    const slot = (planOverrides, slotOverrides = {}) => ({
        pendingDeposit: plan(planOverrides), journal: { private: 'keep' }, depositQuote: { secret: 'keep' }, ...slotOverrides
    });
    return [
        ['an unused plan', slot()],
        ['an unused plan with a draft and settled late attempts', slot({}, {
            lateDepositAttempts: [{ operationId: 'older', status: 'confirmed' }, { operationId: 'another', status: 'submitted' }]
        })],
        ['phase submitted', slot({ phase: 'submitted' })],
        ['phase ambiguous', slot({ phase: 'ambiguous' })],
        ['phase awaiting_wallet', slot({ phase: 'awaiting_wallet' })],
        ['phase retry_exact', slot({ phase: 'retry_exact' })],
        ['another operation', slot({ operationId: 'other-tab' })],
        ['legacyRecovery', slot({ legacyRecovery: true })],
        ['submissionId', slot({ submissionId: 'claim' })],
        ['submissionOwner', slot({ submissionOwner: 'tab' })],
        ['submissionFrom', slot({ submissionFrom: '0xabc' })],
        ['submissionNonce 0', slot({ submissionNonce: 0 })],
        ['submissionNonce null', slot({ submissionNonce: null })],
        ['transactionHash', slot({ transactionHash: '0x123' })],
        ['transactionHashes', slot({ transactionHashes: ['0x123'] })],
        ['empty transactionHashes', slot({ transactionHashes: [] })],
        ['transactionAttempts', slot({ transactionAttempts: [{ hash: '0x123' }] })],
        ['ambiguousSubmissions', slot({ ambiguousSubmissions: [{}] })],
        ['approvals', slot({ approvals: [{}] })],
        ['an active note', slot({}, { state: { secret: 'active-note' } })],
        ['a late attempt for the operation', slot({}, { lateDepositAttempts: [{ operationId: 'original' }] })],
        ['a settled late attempt for the operation', slot({}, {
            lateDepositAttempts: [{ operationId: 'original', status: 'confirmed' }]
        })],
        ['no plan', { pendingDeposit: null, depositQuote: { secret: 'keep' } }],
        ['no plan field at all', { depositQuote: { secret: 'keep' } }],
        ['an empty slot', {}]
    ];
})();

test('the shared unsent predicate answers exactly as canceledDeposit.mjs does', async () => {
    for (const [name, slot] of PARITY_SLOTS) {
        const expected = referenceUnsent(slot, 'original');
        assert.equal(isUnsentPreparedDeposit(slot, { expectedOperationId: 'original' }), expected, name);
        assert.equal(await liveVerdict(slot, 'original'), expected, `${name} (live module)`);
    }
    // Both sides must have seen real positives and negatives.
    const verdicts = PARITY_SLOTS.map(([, slot]) => referenceUnsent(slot, 'original'));
    assert.ok(verdicts.includes(true) && verdicts.includes(false));
    // A caller expecting a different operation never matches.
    for (const [name, slot] of PARITY_SLOTS) {
        assert.equal(isUnsentPreparedDeposit(slot, { expectedOperationId: 'not-it' }), false, name);
    }
});

test('the shared unsent predicate without an expected operation uses the plan\'s own', () => {
    for (const [name, slot] of PARITY_SLOTS) {
        const own = slot.pendingDeposit?.operationId;
        assert.equal(isUnsentPreparedDeposit(slot), typeof own === 'string' ? referenceUnsent(slot, own) : false, name);
    }
    assert.equal(isUnsentPreparedDeposit({ pendingDeposit: { phase: 'prepared' } }), false);
    assert.equal(isUnsentPreparedDeposit({ pendingDeposit: { phase: 'prepared', operationId: '' } }), false);
    assert.equal(isUnsentPreparedDeposit({ pendingDeposit: { phase: 'prepared', operationId: 'x' } }, { expectedOperationId: '' }), false);
    assert.equal(isUnsentPreparedDeposit({ pendingDeposit: { phase: 'prepared', operationId: 'x' } }, { expectedOperationId: null }), true);
});

test('the shared unsent predicate refuses what the original would have thrown on', async () => {
    const malformed = [
        { pendingDeposit: { phase: 'prepared', operationId: 'original' }, lateDepositAttempts: { some: true } },
        { pendingDeposit: { phase: 'prepared', operationId: 'original' }, lateDepositAttempts: [null] },
        { pendingDeposit: { phase: 'prepared', operationId: 'original' }, lateDepositAttempts: 'x' }
    ];
    for (const slot of malformed) {
        assert.equal(isUnsentPreparedDeposit(slot, { expectedOperationId: 'original' }), false, JSON.stringify(slot));
        // The original throws instead of answering.
        assert.throws(() => referenceUnsent(slot, 'original'), TypeError);
    }
    for (const slot of [null, undefined, 'x', 5, [], { pendingDeposit: 'x' }, { pendingDeposit: [] }]) {
        assert.equal(isUnsentPreparedDeposit(slot, { expectedOperationId: 'x' }), false);
    }
});

test('a plan is only called unsent when the probe also recognizes every field it carries', () => {
    const slot = { deploymentId: LEGACY, pendingDeposit: preparedPlan() };
    assert.equal(describeSlot(slot), 'unsent_prepared');
    assert.equal(isUnsentPreparedDeposit(slot), true);
    const unknown = { deploymentId: LEGACY, pendingDeposit: preparedPlan({ somethingNew: 'x' }) };
    // The shared predicate (the original rule) still says unsent; the host's
    // write path does not act on it.
    assert.equal(isUnsentPreparedDeposit(unknown), true);
    assert.equal(describeSlot(unknown), 'pending_deposit');
});

// ------------------------------------------------------- literals vs the SDK

test('the lock and channel names are the ones the installed wallet store uses', async () => {
    const source = fs.readFileSync(legacyStorePath, 'utf8');
    assert.match(source, new RegExp(`const lockName = '${WALLET_LOCK_NAME}';`));
    assert.match(source, new RegExp(`new BroadcastChannel\\('${WALLET_CHANNEL_NAME}'\\)`));
    // And in behavior: the store's own lock is the one the host would contend with.
    await inEnvironment(async env => {
        const store = await loadLegacyStore();
        env.trace.length = 0;
        await store.withBrowserWalletLock('deployment', async () => {});
        assert.deepEqual(env.trace.map(entry => [entry.type, entry.name]),
            [['lock-acquire', WALLET_LOCK_NAME], ['lock-release', WALLET_LOCK_NAME]]);
        store.createWalletChannel('deployment', () => {}).postMessage({ updatedAt: 1 });
        assert.equal(env.channels.posted[0].name, WALLET_CHANNEL_NAME);
    });
});

test('the selection modules import no SDK and no Node builtin, only each other and the registry model', () => {
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../chat/zkapi/versioning');
    const allowed = new Set([
        './unsentDeposit.mjs', './walletHoldings.mjs', './registryModel.mjs', './switchProtocol.mjs',
        './adapters/index.mjs'
    ]);
    for (const name of ['activeVersion.mjs', 'unsentDeposit.mjs', 'walletHoldings.mjs', 'versionLoader.mjs', 'switchProtocol.mjs']) {
        const source = fs.readFileSync(path.join(directory, name), 'utf8');
        const specifiers = [...source.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1]);
        for (const specifier of specifiers) assert.ok(allowed.has(specifier), `${name} imports ${specifier}`);
        assert.equal(/\bimport\s*\(/.test(source), false, `${name} has a dynamic import`);
        assert.equal(/require\s*\(/.test(source), false, `${name} uses require`);
    }
});
