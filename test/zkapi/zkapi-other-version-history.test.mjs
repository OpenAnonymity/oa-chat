// Payment history of the protocol versions a build did not load
// (chat/zkapi/versioning/otherVersionHistory.mjs and
// chat/zkapi/components/OtherVersionHistory.js).
//
// Pins: the reader only reads (one readonly transaction over the deposit and
// withdrawal stores, nothing created, nothing committed, connection closed);
// what it shows equals what each SDK's own filtered reads show, proven against
// databases written by the REAL installed legacy store and against the
// committed dump of the REAL newer store (test/fixtures/zkapi-v2-real-shapes);
// nothing private leaves it (allowlist, drift guards, secret markers);
// expiry derivation is a port with parity against the installed SDK (fuzz)
// and the newer SDK's own vectors; a foreign row never carries a hook the
// dialog's delegated handlers would act on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    DEPOSIT_ROW_FIELDS, HISTORY_READ_TIMEOUT_MS, HISTORY_ROW_LIMIT, UNKNOWN_VERSION_LABEL,
    WITHDRAWAL_RECORD_FIELDS, billingDecimals, deriveExpiryRecords, projectOtherHistory, readOtherVersionHistory,
    rowsAt
} from '../../chat/zkapi/versioning/otherVersionHistory.mjs';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { isOpenWithdrawalRecord } from '../../chat/zkapi/versioning/walletHoldings.mjs';
import {
    HISTORY_WORDS, historySignature, renderHistoryItems, renderHistoryRow
} from '../../chat/zkapi/components/OtherVersionHistory.js';
import { createFakeEnvironment } from './_fakeIndexedDb.mjs';
import { activatedRegistry, resolvedTable, threeVersionRegistry } from './_registryFixtures.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const legacyStorePath = fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/store'));
const legacyExpiryPath = fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/expiry-history'));
// The installed SDK's own pure rule, the oracle of the expiry parity tests.
const legacyExpiry = await import(pathToFileURL(legacyExpiryPath).href);
const DB = 'zkapi-browser-wallet-v1';
const CHAIN = 11155111;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const DAY = 86_400_000;
const seconds = ms => Math.floor(ms / 1000);

const LEGACY = 'zkapi-native-eth-sepolia-note-bound-v1-fresh-20260930';
const CURRENT = 'zkapi-native-eth-sepolia-concession-v1-fixture-v2c';
const RETIRED = 'zkapi-native-eth-sepolia-note-bound-v1-retired-fixture';
const UNKNOWN = 'zkapi-native-eth-sepolia-some-other-deployment';
const VAULT = '0x4386fdbda35d995beb3bf8625118ec5982ec81fe';
const DESTINATION = `0x${'34'.repeat(20)}`;
const hash = char => `0x${char.repeat(64)}`;

const TABLE = Object.freeze([
    { id: 'v1', ordinal: 1, label: 'Version 1', adapter: 'note-bound-v1', status: 'exit-only', deploymentId: LEGACY, chainId: CHAIN, vault: VAULT },
    { id: 'v2', ordinal: 2, label: 'Version 2', adapter: 'concession-v1', status: 'active', deploymentId: CURRENT, chainId: CHAIN, vault: `0x${'22'.repeat(20)}` },
    { id: 'v0', ordinal: 0, label: 'Version 0', adapter: 'note-bound-v1', status: 'retired', deploymentId: RETIRED, chainId: CHAIN, vault: `0x${'66'.repeat(20)}` }
]);

async function inEnvironment(fn, options = {}) {
    const env = createFakeEnvironment();
    const restore = env.install(options);
    try {
        return await fn(env);
    } finally {
        restore();
    }
}

// Date.now held at one instant (and moved by the test): the real store stamps
// its writes with it, and fixtures must not depend on the wall clock.
async function withClock(startMs, fn) {
    const real = Date.now;
    const clock = { now: startMs };
    Date.now = () => clock.now;
    try {
        return await fn(clock);
    } finally {
        Date.now = real;
    }
}

// ------------------------------------------------------------ record factories

const depositRow = (deploymentId, noteId, overrides = {}) => ({
    recordId: `${deploymentId}:deposit:${noteId}`, type: 'deposit', deploymentId, operationId: `op-${noteId}`, noteId,
    amount: 2_000_000, expiryTs: seconds(NOW + 30 * DAY), status: 'confirmed',
    createdAt: NOW - 60 * DAY, confirmedAt: NOW - 60 * DAY + 90_000, transactionHash: hash('1'), ...overrides
});

const SECRET_FIELDS = () => ({
    state: { note_id: 1, deposit_amount: 1, secret_s: 'SECRET-secret_s', balance_blinding: 'SECRET-blinding' },
    preparedWithdrawal: { proof: 'SECRET-proof', withdrawalNullifier: 'SECRET-plan-nullifier' },
    proof: 'SECRET-proof-field',
    withdrawalNullifier: 'SECRET-withdrawal-nullifier',
    challengeEvidence: { transactionHash: hash('e'), note: 'SECRET-evidence' },
    exitLock: { mode: 'escape', secret: 'SECRET-lock' },
    startSubmissionId: 'SECRET-start-submission',
    startSubmissionFrom: 'SECRET-from',
    finalizeSubmissionOwner: 'SECRET-owner',
    transactionAttempts: [{ nonce: 'SECRET-nonce' }],
    error: 'SECRET-error'
});

const withdrawalRecord = (deploymentId, noteId, overrides = {}) => ({
    recordId: `${deploymentId}:${CHAIN}:${VAULT}:${noteId}`, deploymentId, chainId: CHAIN, contractAddress: VAULT,
    noteId, mode: 'mutual', phase: 'parked', destination: DESTINATION, finalBalance: 1_900_000,
    createdAt: NOW - 20 * DAY, updatedAt: NOW - 19 * DAY, revision: 2, ...SECRET_FIELDS(), ...overrides
});

const project = (raw, options = {}) => projectOtherHistory(
    { deposits: [], withdrawals: [], ...raw },
    { table: TABLE, loadedDeploymentId: CURRENT, nowMs: NOW, ...options }
);

const only = (result, kind, noteId) => {
    const rows = result.rows.filter(row => row.kind === kind && (noteId === undefined || row.noteId === noteId));
    assert.equal(rows.length, 1, `${kind} ${noteId}: ${JSON.stringify(result.rows.map(row => row.key))}`);
    return rows[0];
};

// ------------------------------------------------------------------ projection

test('deposit rows: the SDK\'s sanitized shape, in the unit of the row\'s own version', () => {
    const result = project({ deposits: [
        depositRow(LEGACY, 5, {
            feeWei: '2100000000000', gasUsed: '100000', effectiveGasPrice: '21000000',
            fundingAddress: `0x${'11'.repeat(20)}`, receiptBlockNumber: 12, receiptBlockHash: hash('b'),
            transactionHash: hash('A')
        })
    ] });
    assert.equal(result.truncated, false);
    const row = only(result, 'deposit', 5);
    assert.deepEqual({ ...row, version: undefined }, {
        key: 'v1:deposit:5', scope: 'v1', kind: 'deposit', at: NOW - 60 * DAY + 90_000, noteId: 5, version: undefined,
        amountUnits: '2000000', transactionHash: hash('a'), feeWei: '2100000000000',
        expiryTs: seconds(NOW + 30 * DAY), expiryState: 'open'
    });
    assert.deepEqual({ ...row.version }, {
        versionId: 'v1', label: 'Version 1', status: 'exit-only', chainId: CHAIN,
        billing: { asset: 'native_eth', unit: 'gwei', perEth: 1e9 }, sameUnitAsLoaded: true
    });
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.version));
});

// (The SDK relabels any stored row it finds as confirmed; the store never
// keeps an unconfirmed one, so refusing them is the conservative reading.)
test('deposit rows: anything the SDK\'s own sanitizer would refuse is refused', () => {
    const receipt = {
        feeWei: '2100000000000', gasUsed: '100000', effectiveGasPrice: '21000000',
        fundingAddress: `0x${'11'.repeat(20)}`, receiptBlockNumber: 12, receiptBlockHash: hash('b')
    };
    const rows = project({ deposits: [
        depositRow(LEGACY, 1),
        depositRow(LEGACY, 2, { status: 'pending' }),
        depositRow(LEGACY, 3, { status: 'failed' }),
        depositRow(LEGACY, 4, { amount: 0 }),
        depositRow(LEGACY, 5, { amount: 1.5 }),
        depositRow(LEGACY, 6, { noteId: -1 }),
        depositRow(null, 7, { deploymentId: null }),
        depositRow(LEGACY, 8, { ...receipt, feeWei: '1' }),
        depositRow(LEGACY, 9, { ...receipt, transactionHash: 'not-a-hash' }),
        depositRow(LEGACY, 10, { transactionHash: 'nope' }),
        depositRow(LEGACY, 11, { expiryTs: 0 }),
        'junk', null, 7
    ] }).rows;
    const byNote = Object.fromEntries(rows.filter(row => row.kind === 'deposit').map(row => [row.noteId, row]));
    assert.deepEqual(Object.keys(byNote).map(Number).sort((a, b) => a - b), [1, 8, 9, 10, 11]);
    assert.equal(byNote[8].feeWei, null, 'an inconsistent receipt prints no fee');
    assert.equal(byNote[9].feeWei, null);
    assert.equal(byNote[9].transactionHash, null);
    assert.equal(byNote[10].transactionHash, null);
    assert.equal(byNote[11].expiryTs, null);
    assert.equal(byNote[11].expiryState, 'none');
    // A deposit with a consistent receipt keeps its fee.
    assert.equal(project({ deposits: [depositRow(LEGACY, 1, receipt)] }).rows[0].feeWei, '2100000000000');
});

test('stored amounts: a safe integer or its canonical digits, never rounded and never guessed', () => {
    const accepted = [[2_000_000, '2000000'], ['2000000', '2000000'], [Number.MAX_SAFE_INTEGER, '9007199254740991'],
        ['9007199254740991', '9007199254740991'], [1, '1'], ['1', '1']];
    const refused = ['007', '+7', ' 7', '7 ', '1e3', '0x10', '', '-1', '1.5', 1.5, -1, 0, '0',
        '9007199254740992', Number.MAX_SAFE_INTEGER + 1, 5n, null, undefined, {}, []];
    const deposits = [...accepted.map(([amount]) => amount), ...refused].map((amount, index) => depositRow(LEGACY, index + 1, { amount }));
    const rows = project({ deposits }).rows.filter(row => row.kind === 'deposit');
    assert.deepEqual(rows.map(row => [row.noteId, row.amountUnits]).sort((left, right) => left[0] - right[0]),
        accepted.map(([, text], index) => [index + 1, text]),
        'a deposit amount is positive, and read exactly or not at all');
    // A withdrawal's balance may be zero, and is read by the same rule.
    const balances = [...accepted.map(([amount]) => amount), 0, '0', ...refused.filter(value => value !== 0 && value !== '0')];
    const withdrawals = balances.map((finalBalance, index) => withdrawalRecord(LEGACY, 100 + index, { finalBalance }));
    const shown = project({ withdrawals }).rows.filter(row => row.kind === 'withdrawal')
        .sort((left, right) => left.noteId - right.noteId).map(row => row.amountUnits);
    assert.deepEqual(shown, [...accepted.map(([, text]) => text), '0', '0', ...refused.filter(value => value !== 0 && value !== '0').map(() => null)]);
});

test('withdrawal rows: an allowlist, the SDK\'s open rule and its own link rule', () => {
    const result = project({ withdrawals: [
        withdrawalRecord(LEGACY, 6, { mode: 'mutual', phase: 'parked', transactionHash: hash('c') }),
        withdrawalRecord(LEGACY, 5, {
            mode: 'mutual', phase: 'closed', payoutVerified: true, transactionHash: hash('C'),
            createdAt: NOW - 90 * DAY
        }),
        withdrawalRecord(LEGACY, 4, {
            mode: 'escape', phase: 'closed_unconfirmed', payoutVerified: true,
            transactionHash: hash('d'), finalizeTransactionHash: hash('f')
        }),
        withdrawalRecord(LEGACY, 3, {
            mode: 'escape', phase: 'pending', challengeDeadline: seconds(NOW + DAY), transactionHash: hash('d')
        }),
        // Closed with a finalization still in flight: open to the SDK.
        withdrawalRecord(LEGACY, 2, { mode: 'mutual', phase: 'closed', finalizeSubmissionId: 'claim' })
    ] });
    const parked = only(result, 'withdrawal', 6);
    assert.deepEqual({ ...parked, version: undefined }, {
        key: 'v1:withdrawal:6', scope: 'v1', kind: 'withdrawal', at: NOW - 20 * DAY, noteId: 6, version: undefined,
        mode: 'mutual', phase: 'parked', open: true, payoutVerified: false, payoutCredited: false,
        payoutClaimed: false, payoutAlert: null, deviceNotNewest: false, amountUnits: '1900000', creditedUnits: null,
        destination: DESTINATION, challengeDeadline: null, transactionHash: hash('c')
    });
    assert.equal(only(result, 'withdrawal', 5).open, false);
    assert.equal(only(result, 'withdrawal', 5).transactionHash, hash('c'));
    // An escape's initial transaction only starts its wait: never linked.
    assert.equal(only(result, 'withdrawal', 4).transactionHash, hash('f'));
    assert.equal(only(result, 'withdrawal', 4).open, true);
    assert.equal(only(result, 'withdrawal', 3).transactionHash, null);
    assert.equal(only(result, 'withdrawal', 3).challengeDeadline, seconds(NOW + DAY));
    assert.equal(only(result, 'withdrawal', 2).open, true);
    // The rule is the walletHoldings one (a port of the SDK's), record for record.
    for (const row of result.rows.filter(entry => entry.kind === 'withdrawal')) {
        const stored = [
            withdrawalRecord(LEGACY, 6, {}), withdrawalRecord(LEGACY, 5, { phase: 'closed' }),
            withdrawalRecord(LEGACY, 4, { phase: 'closed_unconfirmed' }),
            withdrawalRecord(LEGACY, 3, { phase: 'pending' }),
            withdrawalRecord(LEGACY, 2, { phase: 'closed', finalizeSubmissionId: 'claim' })
        ].find(record => record.noteId === row.noteId);
        assert.equal(row.open, isOpenWithdrawalRecord(stored), `note ${row.noteId}`);
    }
});

test('withdrawal rows: credited payouts and alerts come only from the record flags', () => {
    const result = project({ withdrawals: [
        withdrawalRecord(CURRENT, 3, {
            mode: 'escape', phase: 'closed_unconfirmed', payoutCredited: true, payoutVerified: false,
            creditedAmount: 800_000, payoutCreditEvidence: 'receipt'
        }),
        withdrawalRecord(CURRENT, 4, {
            mode: 'escape', phase: 'closed', payoutCredited: true, payoutVerified: true, payoutClaimed: true,
            creditedAmount: 100_000, payoutClaimTransactionHash: hash('d')
        }),
        withdrawalRecord(CURRENT, 5, {
            mode: 'escape', phase: 'closed', payoutCredited: true, payoutVerified: false,
            creditedAmount: null, payoutCreditEvidence: 'vault_credit'
        }),
        withdrawalRecord(CURRENT, 6, { mode: 'escape', phase: 'closed', payoutVerified: true, payoutAlert: 'concession_exceeded_bound' }),
        withdrawalRecord(CURRENT, 7, { mode: 'escape', phase: 'closed', payoutVerified: true, payoutAlert: 'SECRET-other-alert' })
    ] }, { loadedDeploymentId: LEGACY });
    const credited = only(result, 'withdrawal', 3);
    assert.equal(credited.payoutCredited, true);
    assert.equal(credited.payoutClaimed, false);
    assert.equal(credited.creditedUnits, '800000');
    assert.equal(only(result, 'withdrawal', 4).payoutClaimed, true);
    assert.equal(only(result, 'withdrawal', 5).creditedUnits, null);
    assert.equal(only(result, 'withdrawal', 6).payoutAlert, 'concession_exceeded_bound');
    assert.equal(only(result, 'withdrawal', 7).payoutAlert, null);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('only rows of other deployments: the loaded one is excluded, an unknown loaded id gives none', () => {
    const raw = {
        deposits: [depositRow(LEGACY, 1), depositRow(CURRENT, 1), depositRow(RETIRED, 1)],
        withdrawals: [withdrawalRecord(LEGACY, 1), withdrawalRecord(CURRENT, 1), withdrawalRecord(RETIRED, 1)]
    };
    const scopes = result => [...new Set(result.rows.map(row => row.scope))].sort();
    assert.deepEqual(scopes(project(raw, { loadedDeploymentId: CURRENT })), ['v0', 'v1']);
    assert.deepEqual(scopes(project(raw, { loadedDeploymentId: LEGACY })), ['v0', 'v2']);
    for (const loadedDeploymentId of [UNKNOWN, '', null, undefined, 7]) {
        assert.deepEqual(project(raw, { loadedDeploymentId }), { rows: [], truncated: false },
            `loaded ${String(loadedDeploymentId)}`);
    }
    assert.deepEqual(project(raw, { table: null }), { rows: [], truncated: false });
    assert.deepEqual(project(raw, { table: [] }), { rows: [], truncated: false });
});

test('labels: live, exit-only and retired versions are named, unknown ones are "Earlier version" without amounts', () => {
    const raw = {
        deposits: [depositRow(LEGACY, 1), depositRow(CURRENT, 1), depositRow(RETIRED, 1), depositRow(UNKNOWN, 1)],
        withdrawals: [
            withdrawalRecord(UNKNOWN, 2, { phase: 'closed', payoutVerified: true, transactionHash: hash('c') }),
            withdrawalRecord(null, 3, { deploymentId: null, phase: 'closed', payoutVerified: true,
                recordId: 'orphan', transactionHash: hash('c') })
        ]
    };
    const table = [...TABLE, { id: 'v9', ordinal: 9, label: 'Version 9', adapter: 'concession-v1', status: 'active',
        deploymentId: 'zkapi-loaded', chainId: CHAIN, vault: VAULT }];
    const rows = project(raw, { loadedDeploymentId: 'zkapi-loaded', table }).rows;
    const versionOfScope = scope => {
        const found = rows.filter(row => row.scope === scope);
        assert.ok(found.length > 0, scope);
        return { ...found[0].version, billing: undefined, sameUnitAsLoaded: undefined };
    };
    const known = { billing: undefined, sameUnitAsLoaded: undefined };
    assert.deepEqual(versionOfScope('v1'), { versionId: 'v1', label: 'Version 1', status: 'exit-only', chainId: CHAIN, ...known });
    assert.deepEqual(versionOfScope('v2'), { versionId: 'v2', label: 'Version 2', status: 'active', chainId: CHAIN, ...known });
    assert.deepEqual(versionOfScope('v0'), { versionId: 'v0', label: 'Version 0', status: 'retired', chainId: CHAIN, ...known });
    assert.equal(rows.some(row => row.scope === 'v9'), false, 'the loaded version is not "other"');
    const unknown = rows.filter(row => row.version.versionId === null);
    assert.equal(unknown.length, 3);
    for (const row of unknown) {
        assert.equal(row.version.label, UNKNOWN_VERSION_LABEL);
        assert.equal(row.version.status, 'unknown');
        assert.equal(row.version.chainId, null);
        assert.equal(row.version.billing, null);
        assert.equal(row.version.sameUnitAsLoaded, false, 'a deployment with no unit is never the loaded one');
        assert.equal(row.amountUnits, null, 'no amount for a deployment this build has no unit for');
        assert.equal(row.transactionHash, null, 'and no explorer link');
        if (row.kind === 'deposit') assert.equal(row.feeWei, null);
        assert.match(row.key, /^earlier-[0-9a-z]+:(deposit|withdrawal):\d+$/);
    }
    // A deployment id and a missing one are different unknowns, and two
    // unknown deployments never share a key.
    const keys = rows.map(row => row.key);
    assert.equal(new Set(keys).size, keys.length);
    const other = project({ deposits: [depositRow(UNKNOWN, 1), depositRow('zkapi-another-unknown', 1)] }).rows;
    assert.notEqual(other[0].key, other[1].key);
});

test('a treasury claim shows its expiry row, keeps the deposit and hides that note\'s withdrawal rows', () => {
    const expiryTs = seconds(NOW - 10 * DAY);
    const claim = {
        transactionHash: hash('f'), blockHash: hash('9'), blockNumber: 777, claimedAt: NOW - 9 * DAY, amount: 2_000_000
    };
    const result = project({
        deposits: [
            depositRow(LEGACY, 7, { expiryTs, expiryClaim: claim }),
            depositRow(LEGACY, 8, { expiryTs }),
            // The same note id on another deployment is another note.
            depositRow(RETIRED, 7, { expiryTs })
        ],
        withdrawals: [
            withdrawalRecord(LEGACY, 7, { phase: 'parked' }),
            withdrawalRecord(LEGACY, 8, { phase: 'parked' }),
            withdrawalRecord(RETIRED, 7, { phase: 'parked' })
        ]
    });
    const claimed = result.rows.find(row => row.key === 'v1:expiry:7');
    assert.equal(result.rows.filter(row => row.key === 'v1:expiry:7').length, 1);
    assert.equal(claimed.key, 'v1:expiry:7');
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.at, NOW - 9 * DAY);
    assert.equal(claimed.claimAmountUnits, '2000000');
    assert.equal(claimed.claimTransactionHash, hash('f'));
    assert.equal(result.rows.find(row => row.key === 'v1:deposit:8').expiryState, 'open');
    assert.deepEqual(result.rows.filter(row => row.kind === 'deposit' && row.scope === 'v1').map(row => row.noteId).sort(), [7, 8]);
    assert.equal(result.rows.find(row => row.key === 'v1:deposit:7').expiryState, 'claimed');
    // v1's note 7 withdrawal is hidden, v0's note 7 and v1's note 8 are not.
    const withdrawalKeys = result.rows.filter(row => row.kind === 'withdrawal').map(row => row.key).sort();
    assert.deepEqual(withdrawalKeys, ['v0:withdrawal:7', 'v1:withdrawal:8']);
    // An unclaimed expired deposit is "expired" at `nowMs` and not before.
    assert.equal(project({ deposits: [depositRow(LEGACY, 8, { expiryTs })] }).rows.filter(r => r.kind === 'expiry')[0].status, 'expired');
    assert.equal(project({ deposits: [depositRow(LEGACY, 8, { expiryTs })] }, { nowMs: NOW - 11 * DAY }).rows
        .filter(r => r.kind === 'expiry').length, 0);
    assert.equal(project({ deposits: [depositRow(LEGACY, 8, { expiryTs })] }, { nowMs: undefined }).rows
        .filter(r => r.kind === 'expiry').length, 0, 'without a clock nothing reads as expired');
});

test('an escape that closed the note, credited or verified, keeps its deposit from reading as expired', () => {
    const expiryTs = seconds(NOW - DAY);
    const cases = [
        [{ mode: 'escape', phase: 'closed', payoutCredited: true, payoutVerified: false, creditedAmount: 5 }, 'settled'],
        [{ mode: 'escape', phase: 'closed_unconfirmed', payoutVerified: true }, 'settled'],
        [{ mode: 'mutual', phase: 'closed', payoutVerified: true }, 'settled'],
        [{ mode: 'escape', phase: 'pending', chainStatus: 'pending_withdrawal', startBlockNumber: 10, finalizedBlockNumber: 12 }, 'settled'],
        [{ mode: 'escape', phase: 'pending', chainStatus: 'pending_withdrawal', startBlockNumber: 10, finalizedBlockNumber: 9 }, 'open'],
        [{ mode: 'escape', phase: 'closed', payoutVerified: false }, 'open'],
        [{ mode: 'mutual', phase: 'parked', payoutVerified: true }, 'open']
    ];
    for (const [changes, expiryState] of cases) {
        const result = project({
            deposits: [depositRow(LEGACY, 3, { expiryTs })],
            withdrawals: [withdrawalRecord(LEGACY, 3, changes)]
        });
        assert.equal(only(result, 'deposit', 3).expiryState, expiryState, JSON.stringify(changes));
        assert.equal(result.rows.some(row => row.kind === 'expiry'), expiryState === 'open', JSON.stringify(changes));
    }
});

test('explorer links use the row\'s own chain: a record that names another chain is not linked', () => {
    const result = project({
        deposits: [depositRow(LEGACY, 1, { transactionHash: hash('1') })],
        withdrawals: [
            withdrawalRecord(LEGACY, 2, { phase: 'closed', payoutVerified: true, transactionHash: hash('2') }),
            withdrawalRecord(LEGACY, 3, { phase: 'closed', payoutVerified: true, transactionHash: hash('3'), chainId: 1 }),
            withdrawalRecord(LEGACY, 4, { phase: 'closed', payoutVerified: true, transactionHash: hash('4'), chainId: undefined })
        ]
    });
    assert.equal(only(result, 'withdrawal', 2).transactionHash, hash('2'));
    assert.equal(only(result, 'withdrawal', 3).transactionHash, null);
    assert.equal(only(result, 'withdrawal', 4).transactionHash, hash('4'));
    assert.equal(only(result, 'deposit', 1).version.chainId, CHAIN);
});

test('one row per note: the newest record of a note wins, junk records are ignored', () => {
    const result = project({ withdrawals: [
        withdrawalRecord(LEGACY, 5, { phase: 'parked', updatedAt: 100, recordId: 'older' }),
        withdrawalRecord(LEGACY, 5, { phase: 'closed', payoutVerified: true, updatedAt: 200, recordId: 'newer' }),
        withdrawalRecord(LEGACY, 6, { noteId: null }),
        withdrawalRecord(LEGACY, 7, { noteId: -3 }),
        'junk', null, 3, []
    ] });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].phase, 'closed');
});

test('what is not a list of records is refused, not read as "no history"', () => {
    const options = { table: TABLE, loadedDeploymentId: CURRENT, nowMs: NOW };
    for (const raw of [null, undefined, 'x', {}, { deposits: [] }, { withdrawals: [] },
        { deposits: {}, withdrawals: [] }, { deposits: [], withdrawals: 'x' }]) {
        assert.throws(() => projectOtherHistory(raw, options), error => error.code === 'history_unreadable',
            JSON.stringify(raw));
    }
});

test('rows come out newest first with a stable order, frozen, and exactly the documented keys', () => {
    const result = project({
        deposits: [depositRow(LEGACY, 1, { confirmedAt: 1000 }), depositRow(LEGACY, 2, { confirmedAt: 3000 }),
            depositRow(LEGACY, 3, { confirmedAt: 2000, createdAt: null })],
        withdrawals: [withdrawalRecord(LEGACY, 1, { createdAt: 2500 }), withdrawalRecord(LEGACY, 2, { createdAt: undefined, updatedAt: 500 })]
    });
    assert.deepEqual(result.rows.map(row => row.key), [
        'v1:deposit:2', 'v1:withdrawal:1', 'v1:deposit:3', 'v1:deposit:1', 'v1:withdrawal:2'
    ]);
    assert.ok(result.rows.every(row => Object.isFrozen(row)));
    const keysOf = kind => Object.keys(result.rows.find(row => row.kind === kind)).sort();
    assert.deepEqual(keysOf('deposit'), ['amountUnits', 'at', 'expiryState', 'expiryTs', 'feeWei', 'key', 'kind',
        'noteId', 'scope', 'transactionHash', 'version']);
    assert.deepEqual(keysOf('withdrawal'), ['amountUnits', 'at', 'challengeDeadline', 'creditedUnits',
        'destination', 'deviceNotNewest', 'key', 'kind', 'mode', 'noteId', 'open', 'payoutAlert', 'payoutClaimed',
        'payoutCredited', 'payoutVerified', 'phase', 'scope', 'transactionHash', 'version']);
});

test('nothing private leaves the projection: every field outside the allowlist is a marker that never appears', () => {
    const marker = (record, allowed) => Object.fromEntries(Object.entries(record)
        .map(([key, value]) => [key, allowed.has(key) ? value : `SECRET-${key}`]));
    const markedDeposit = record => marker(record, new Set(DEPOSIT_ROW_FIELDS.read));
    const markedWithdrawal = record => marker(record, new Set(WITHDRAWAL_RECORD_FIELDS));
    const raw = {
        deposits: [markedDeposit(depositRow(LEGACY, 5, { futureField: 'x', fundingAddress: `0x${'11'.repeat(20)}` }))],
        withdrawals: [
            markedWithdrawal(withdrawalRecord(LEGACY, 5, { phase: 'closed', payoutVerified: true, futureSecret: 'z' })),
            markedWithdrawal(withdrawalRecord(RETIRED, 6, { mode: 'escape', phase: 'closed', payoutVerified: true }))
        ],
        // Keys the reader never asks for are not read, whatever they hold.
        runtime: { state: { secret_s: 'SECRET-slot' } },
        archives: [{ state: { secret_s: 'SECRET-archive' } }, { archiveId: 'request-journal:x', journal: 'SECRET-proof' }]
    };
    const result = projectOtherHistory(raw, { table: TABLE, loadedDeploymentId: CURRENT, nowMs: NOW });
    assert.deepEqual(result.rows.map(row => row.key).sort(), ['v0:withdrawal:6', 'v1:deposit:5', 'v1:withdrawal:5']);
    const text = JSON.stringify(result);
    assert.equal(/SECRET/.test(text), false, text);
    assert.equal(/futureSecret|futureField|SECRET-slot/.test(text), false);
});

// ----------------------------------------------------- units of other versions

test('billingDecimals: an exact power of ten from 1 to 1e18, nothing else', () => {
    assert.deepEqual([1, 1e3, 1e6, 1e9, 1e12, 1e18].map(billingDecimals), [0, 3, 6, 9, 12, 18]);
    // The finest unit is the one a "safe integer" test would refuse.
    assert.equal(Number.isSafeInteger(1e18), false);
    for (const bad of [0, -1, 3, 10.5, 999_999_999, 1e19, 1e-3, Number.NaN, Infinity, '1e9', null, undefined, {}]) {
        assert.equal(billingDecimals(bad), null, String(bad));
    }
});

test('a row is in the loaded unit only when both adapters say it is: another unit is kept apart, unknown is "no"', () => {
    const szabo = Object.freeze({ asset: 'native_eth', unit: 'szabo', perEth: 1e6 });
    const raw = { deposits: [depositRow(LEGACY, 1, { amount: 2_000 }), depositRow(CURRENT, 1, { amount: 2_000 }),
        depositRow(RETIRED, 1, { amount: 2_000 }), depositRow(UNKNOWN, 1, { amount: 2_000 })] };
    // `concession-v1` rows count in szabo, `note-bound-v1` rows in gwei.
    const concessionInSzabo = id => (id === 'concession-v1' ? { billing: szabo } : getAdapter(id));
    const unitOf = (result, scope) => {
        const row = result.rows.find(entry => entry.scope === scope);
        return { billing: row.version.billing ? { ...row.version.billing } : null, same: row.version.sameUnitAsLoaded,
            amountUnits: row.amountUnits };
    };
    const gwei = { asset: 'native_eth', unit: 'gwei', perEth: 1e9 };

    // The shipped adapters: both count in gwei.
    const shipped = project(raw, { loadedDeploymentId: CURRENT });
    assert.deepEqual(unitOf(shipped, 'v1'), { billing: gwei, same: true, amountUnits: '2000' });
    assert.deepEqual(unitOf(shipped, 'v0'), { billing: gwei, same: true, amountUnits: '2000' });
    assert.equal(shipped.rows.find(row => row.version.versionId === null).version.sameUnitAsLoaded, false);

    // The loaded version counts in szabo: gwei rows are not "the loaded unit",
    // and the amounts stay what the store holds, in their own unit.
    const loadedSzabo = project(raw, { loadedDeploymentId: CURRENT, adapterFor: concessionInSzabo });
    assert.deepEqual(unitOf(loadedSzabo, 'v1'), { billing: gwei, same: false, amountUnits: '2000' });
    assert.deepEqual(unitOf(loadedSzabo, 'v0'), { billing: gwei, same: false, amountUnits: '2000' });

    // The loaded version counts in gwei: the szabo row is not it, its gwei
    // sibling is.
    const rowSzabo = project(raw, { loadedDeploymentId: LEGACY, adapterFor: concessionInSzabo });
    assert.deepEqual(unitOf(rowSzabo, 'v2'), { billing: { ...szabo }, same: false, amountUnits: '2000' });
    assert.deepEqual(unitOf(rowSzabo, 'v0'), { billing: gwei, same: true, amountUnits: '2000' });

    // The loaded version's own unit is unknown (its adapter cannot be read):
    // nothing can be called the same unit, though each row keeps its own.
    const blind = id => { if (id === 'concession-v1') throw new Error('no adapter'); return getAdapter(id); };
    const unknownLoaded = project(raw, { loadedDeploymentId: CURRENT, adapterFor: blind });
    assert.deepEqual(unitOf(unknownLoaded, 'v1'), { billing: gwei, same: false, amountUnits: '2000' });

    // A unit NAME alone proves nothing: the same name counted at another
    // number of units per ETH is another unit, and so is another asset.
    const gweiAtSzabo = { asset: 'native_eth', unit: 'gwei', perEth: 1e6 };
    const otherAsset = { asset: 'erc20', unit: 'gwei', perEth: 1e9 };
    for (const billing of [gweiAtSzabo, otherAsset]) {
        const result = project(raw, { loadedDeploymentId: CURRENT, adapterFor: id => (id === 'note-bound-v1' ? { billing } : getAdapter(id)) });
        assert.deepEqual(unitOf(result, 'v1'), { billing: { ...billing }, same: false, amountUnits: '2000' }, JSON.stringify(billing));
    }

    // A unit that is not wholly known is no unit, and its amounts are unknown.
    for (const billing of [{ asset: 'native_eth', unit: 'x', perEth: 3 }, { asset: 'native_eth', unit: 'x', perEth: 0 },
        { asset: 'native_eth', unit: 'x', perEth: '1e9' }, { asset: 'native_eth', unit: 'x', perEth: 1e19 },
        { asset: 'native_eth', perEth: 1e9 }, { unit: 'gwei', perEth: 1e9 }, null, undefined]) {
        const result = project(raw, { loadedDeploymentId: CURRENT, adapterFor: id => (id === 'note-bound-v1' ? { billing } : getAdapter(id)) });
        const row = result.rows.find(entry => entry.scope === 'v1');
        assert.deepEqual([row.version.billing, row.version.sameUnitAsLoaded, row.amountUnits], [null, false, null],
            JSON.stringify(billing));
    }
    // The finest unit is a unit.
    const wei = { asset: 'native_eth', unit: 'wei', perEth: 1e18 };
    const weiRows = project({ deposits: [depositRow(LEGACY, 1)] }, {
        loadedDeploymentId: CURRENT, adapterFor: id => (id === 'note-bound-v1' ? { billing: wei } : getAdapter(id))
    });
    assert.deepEqual({ ...weiRows.rows[0].version.billing }, wei);
    assert.equal(weiRows.rows[0].version.sameUnitAsLoaded, false);
});

// ------------------------------------------------ a balance another device used

test('a record its own build found "not newest" is projected as such, from its two booleans only', () => {
    const evidenceHash = hash('e');
    const result = project({ withdrawals: [
        withdrawalRecord(CURRENT, 1, { mode: 'escape', phase: 'restored', deviceNotNewest: true }),
        withdrawalRecord(CURRENT, 2, { mode: 'escape', phase: 'parked', challengeObserved: true }),
        // The evidence object beside the flag (every record here carries one)
        // never raises it, and a malformed flag does not either.
        withdrawalRecord(CURRENT, 3, { mode: 'escape', phase: 'restored' }),
        withdrawalRecord(CURRENT, 4, { mode: 'escape', phase: 'restored', deviceNotNewest: 'true' }),
        withdrawalRecord(CURRENT, 5, { mode: 'escape', phase: 'restored', deviceNotNewest: 1, challengeObserved: {} }),
        // A closed record has nothing left to continue.
        withdrawalRecord(CURRENT, 6, { mode: 'escape', phase: 'closed', payoutVerified: true, deviceNotNewest: true }),
        withdrawalRecord(CURRENT, 7, { mode: 'escape', phase: 'closed_unconfirmed', payoutCredited: true,
            creditedAmount: 5, challengeObserved: true })
    ] }, { loadedDeploymentId: LEGACY });
    const flagged = Object.fromEntries(result.rows.map(row => [row.noteId, row.deviceNotNewest]));
    assert.deepEqual(flagged, { 1: true, 2: true, 3: false, 4: false, 5: false, 6: false, 7: false });
    assert.equal(JSON.stringify(result).includes(evidenceHash), false, 'the evidence is not copied');
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    assert.equal(WITHDRAWAL_RECORD_FIELDS.includes('deviceNotNewest')
        && WITHDRAWAL_RECORD_FIELDS.includes('challengeObserved'), true);
    assert.equal(WITHDRAWAL_RECORD_FIELDS.includes('challengeEvidence'), false);
});

test('the newer store\'s own flagged record arrives flagged, and only that one', async () => {
    const fixture = JSON.parse(fs.readFileSync(
        path.join(repoRoot, 'test/fixtures/zkapi-v2-real-shapes/wallet-db-v2.json'), 'utf8'));
    const stored = Object.values(fixture.dump.stores.withdrawals.records).filter(record => record.deviceNotNewest === true);
    assert.equal(stored.length, 1, 'the committed dump holds one record its build flagged');
    assert.ok(stored[0].challengeEvidence, 'and it keeps its evidence beside the flag');
    const table = resolvedTable(activatedRegistry(), 'mainnet');
    await inEnvironment(async env => {
        env.idb.seed(fixture.databaseName, fixture.dump);
        const read = async loadedDeploymentId => readOtherVersionHistory({
            database: fixture.databaseName, table, loadedDeploymentId, now: () => fixture.generatedAtMs, indexedDB: env.idb
        });
        // Loaded: the older version. The newer build's records are foreign.
        const result = await read(fixture.deployments.previous);
        const flagged = result.rows.filter(row => row.kind === 'withdrawal' && row.deviceNotNewest);
        assert.deepEqual(flagged.map(row => [row.scope, row.noteId, row.phase]), [['v2', stored[0].noteId, 'restored']]);
        assert.equal(JSON.stringify(result).includes(stored[0].challengeEvidence.transactionHash), false);
        // Loaded: the newer version. Nothing of the older one is flagged.
        const reverse = await read(fixture.deployments.current);
        assert.equal(reverse.rows.some(row => row.deviceNotNewest === true), false);
    });
});

// -------------------------------------------------------------------- the reader

// Every transaction a connection to `name` opens, by store scope and mode.
async function recordTransactions(env, name, run) {
    const connection = await new Promise((resolve, reject) => {
        const request = env.idb.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const prototype = Object.getPrototypeOf(connection);
    connection.close();
    const original = prototype.transaction;
    const scopes = [];
    prototype.transaction = function recorded(names, mode, options) {
        scopes.push({ names: [].concat(names).sort(), mode: mode || 'readonly' });
        return original.call(this, names, mode, options);
    };
    try {
        return { result: await run(), scopes };
    } finally {
        prototype.transaction = original;
    }
}

const seedWallet = (env, { deposits = [], withdrawals = [], runtime = null, archives = [], version = 3 } = {}) => {
    const records = list => Object.fromEntries(list.map(record => [record.recordId ?? record.archiveId, record]));
    env.idb.seed(DB, { version, stores: {
        runtime: { records: runtime ? { active: runtime } : {} },
        archives: { keyPath: 'archiveId', records: records(archives) },
        withdrawals: { keyPath: 'recordId', records: records(withdrawals) },
        deposits: { keyPath: 'recordId', records: records(deposits) }
    } });
};

const readerOptions = (overrides = {}) => ({
    database: DB, table: TABLE, loadedDeploymentId: CURRENT, now: () => NOW, ...overrides
});

test('the reader only reads: one readonly transaction over the deposit and withdrawal stores', async () => {
    await inEnvironment(async env => {
        seedWallet(env, {
            deposits: [depositRow(LEGACY, 5), depositRow(CURRENT, 9)],
            withdrawals: [withdrawalRecord(LEGACY, 5, { phase: 'closed', payoutVerified: true })],
            runtime: { version: 1, deploymentId: CURRENT, state: { note_id: 9, secret_s: 'SECRET-slot' } },
            archives: [
                { archiveId: `${LEGACY}:6:1`, reason: 'closed', deploymentId: LEGACY, state: { secret_s: 'SECRET-archive' } },
                { archiveId: `request-journal:${LEGACY}:6:${hash('a')}`, journal: { proof: 'SECRET-proof' } },
                { archiveId: `request-evidence:${LEGACY}:6:${hash('a')}`, evidence: 'SECRET-evidence' }
            ]
        });
        const before = env.idb.dump();
        const { result, scopes } = await recordTransactions(env, DB, () => readOtherVersionHistory(readerOptions({
            indexedDB: env.idb
        })));
        assert.deepEqual(scopes, [{ names: ['deposits', 'withdrawals'], mode: 'readonly' }],
            'the slot (note secrets) and the archives (note states, request proofs) are never in scope');
        assert.deepEqual(env.idb.dump(), before, 'the database is byte-for-byte what it was');
        assert.equal(env.idb.committedWrites().length, 0);
        assert.equal(env.idb.connectionCount(DB), 0, 'the connection is closed');
        assert.equal(env.idb.version(DB), 3);
        assert.deepEqual(result.rows.map(row => row.key).sort(), ['v1:deposit:5', 'v1:withdrawal:5']);
        assert.equal(JSON.stringify(result).includes('SECRET'), false);
    });
});

// The fake's object store and cursor prototypes, read off a connection to a
// database that holds at least one withdrawal. They are what a patch must wrap
// to see how a reader gets at the stored records.
async function fakePrototypes(env, name) {
    const connection = await new Promise((resolve, reject) => {
        const request = env.idb.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const transaction = connection.transaction(['withdrawals'], 'readonly');
    const completed = new Promise(resolve => { transaction.oncomplete = resolve; });
    const store = transaction.objectStore('withdrawals');
    const cursor = await new Promise((resolve, reject) => {
        const request = store.openCursor();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    assert.ok(cursor, 'the database holds a withdrawal to read a cursor from');
    const prototypes = { storeProto: Object.getPrototypeOf(store), cursorProto: Object.getPrototypeOf(cursor) };
    await completed;
    connection.close();
    return prototypes;
}

// Watches how `run` gets at the stored records. Every getAll and openCursor is
// noted; every record a cursor lands on is handed over as a Proxy, and every
// field read through it is noted together with the record its cursor is on at
// that moment. A reader that kept raw records and looked at them later shows up
// as a read of a record its cursor had already left (`stale`).
async function traceStoreAccess(env, name, run) {
    const { storeProto, cursorProto } = await fakePrototypes(env, name);
    const events = [];
    const ids = new WeakMap();
    let counter = 0;
    const originals = { getAll: storeProto.getAll, openCursor: storeProto.openCursor, step: cursorProto._step };
    storeProto.getAll = function getAll(...args) {
        events.push({ kind: 'getAll', store: this.name });
        return originals.getAll.apply(this, args);
    };
    storeProto.openCursor = function openCursor(...args) {
        events.push({ kind: 'openCursor', store: this.name });
        return originals.openCursor.apply(this, args);
    };
    cursorProto._step = function step() {
        const result = originals.step.call(this);
        if (!ids.has(this)) { counter += 1; ids.set(this, counter); }
        const cursor = ids.get(this);
        if (result === null) {
            events.push({ kind: 'end', cursor });
            return result;
        }
        const key = this.primaryKey;
        events.push({ kind: 'land', cursor, key });
        const note = property => events.push({ kind: 'read', cursor, key, property: String(property) });
        this.value = new Proxy(this.value, {
            get(target, property, receiver) { note(property); return Reflect.get(target, property, receiver); },
            has(target, property) { note(property); return Reflect.has(target, property); },
            ownKeys(target) { note('ownKeys'); return Reflect.ownKeys(target); },
            getOwnPropertyDescriptor(target, property) {
                note(property);
                return Reflect.getOwnPropertyDescriptor(target, property);
            }
        });
        return result;
    };
    try {
        const result = await run();
        const onCursor = new Map();
        const stale = [];
        for (const event of events) {
            if (event.kind === 'land') onCursor.set(event.cursor, event.key);
            else if (event.kind === 'end') onCursor.set(event.cursor, null);
            else if (event.kind === 'read' && onCursor.get(event.cursor) !== event.key) stale.push(event);
        }
        return { result, events, stale };
    } finally {
        Object.assign(storeProto, { getAll: originals.getAll, openCursor: originals.openCursor });
        cursorProto._step = originals.step;
    }
}

test('the reader holds one raw record at a time: a cursor per store, each record reduced as it arrives', async () => {
    await inEnvironment(async env => {
        // The loaded deployment's own records are read like the rest and then left out.
        const deposits = [
            ...Array.from({ length: 7 }, (_, index) => depositRow(LEGACY, index + 1, {
                confirmedAt: NOW - (index + 1) * 60_000
            })),
            depositRow(CURRENT, 401)
        ];
        const withdrawals = [
            ...Array.from({ length: 6 }, (_, index) => withdrawalRecord(LEGACY, 100 + index, {
                phase: 'closed', payoutVerified: true, createdAt: NOW - (index + 1) * 60_000
            })),
            withdrawalRecord(RETIRED, 300, { phase: 'parked' }),
            withdrawalRecord(CURRENT, 400)
        ];
        seedWallet(env, { deposits, withdrawals });
        const stored = [...deposits, ...withdrawals];

        const trace = await traceStoreAccess(env, DB, () => readOtherVersionHistory(readerOptions({
            indexedDB: env.idb
        })));

        // Never a whole store in one answer.
        assert.deepEqual(trace.events.filter(event => event.kind === 'getAll'), [], 'no getAll');
        assert.deepEqual(trace.events.filter(event => event.kind === 'openCursor').map(event => event.store).sort(),
            ['deposits', 'withdrawals'], 'one cursor over each store');
        // Every stored record was delivered exactly once, and reduced while its cursor was on it.
        const landed = trace.events.filter(event => event.kind === 'land').map(event => event.key);
        assert.deepEqual([...landed].sort(), stored.map(record => record.recordId).sort());
        const reduced = new Set(trace.events.filter(event => event.kind === 'read').map(event => event.key));
        for (const key of landed) assert.ok(reduced.has(key), `${key} was reduced when it arrived`);
        assert.deepEqual(trace.stale, [], 'no record was looked at after its cursor had moved on');
        assert.equal(trace.events.filter(event => event.kind === 'end').length, 2, 'both cursors ran to the end');

        // And what comes out is exactly what the same records project to in one batch.
        assert.deepEqual(trace.result, project({ deposits, withdrawals }));
        assert.equal(trace.result.rows.length, 7 + 6 + 1, 'the loaded deployment is not shown');
        assert.equal(JSON.stringify(trace.result).includes('SECRET'), false);
    });
});

test('a store that answers with something that is not a cursor is unreadable, never "no history"', async () => {
    await inEnvironment(async env => {
        seedWallet(env, { deposits: [depositRow(LEGACY, 5)], withdrawals: [withdrawalRecord(LEGACY, 6)] });
        const { storeProto } = await fakePrototypes(env, DB);
        const original = storeProto.openCursor;
        storeProto.openCursor = function openCursor(...args) {
            const request = original.apply(this, args);
            // The request settles with a list, as a getAll would.
            Object.defineProperty(request, 'result', { configurable: true, get: () => [], set() {} });
            return request;
        };
        try {
            await assert.rejects(readOtherVersionHistory(readerOptions({ indexedDB: env.idb })),
                error => error.code === 'history_unreadable');
        } finally {
            storeProto.openCursor = original;
        }
        await env.idb.idle();
        assert.equal(env.idb.connectionCount(DB), 0, 'the connection is closed');
        // The same database reads normally once the store answers properly.
        assert.equal((await readOtherVersionHistory(readerOptions({ indexedDB: env.idb }))).rows.length, 2);
    });
});

test('the reader never creates the database and says "none" for a wallet that is not there', async () => {
    await inEnvironment(async env => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            assert.deepEqual(await readOtherVersionHistory(readerOptions()), { rows: [], truncated: false });
            assert.equal(env.idb.has(DB), false);
            assert.equal(env.idb.connectionCount(DB), 0);
        }
        assert.deepEqual(await env.idb.databases(), []);
        assert.equal(env.idb.committedWrites().length, 0);
        // A database without either store holds nothing, and stays as it is.
        env.idb.seed('other', { version: 1, stores: { unrelated: { records: { a: 1 } } } });
        assert.deepEqual(await readOtherVersionHistory(readerOptions({ database: 'other' })), { rows: [], truncated: false });
        assert.deepEqual(env.idb.storeNames('other'), ['unrelated']);
        assert.equal(env.idb.version('other'), 1);
        // A database below the current version is read as it is, never upgraded.
        seedWallet(env, { version: 2, deposits: [depositRow(LEGACY, 5)] });
        const result = await readOtherVersionHistory(readerOptions());
        assert.equal(result.rows.length, 1);
        assert.equal(env.idb.version(DB), 2);
    });
});

test('nothing is opened when the loaded deployment is unknown', async () => {
    await inEnvironment(async env => {
        seedWallet(env, { deposits: [depositRow(LEGACY, 5)] });
        const before = env.idb.log.length;
        for (const loadedDeploymentId of [UNKNOWN, '', null, undefined]) {
            assert.deepEqual(await readOtherVersionHistory(readerOptions({ loadedDeploymentId })),
                { rows: [], truncated: false });
        }
        assert.deepEqual(await readOtherVersionHistory(readerOptions({ table: [] })), { rows: [], truncated: false });
        assert.equal(env.idb.log.length, before, 'no open request was made');
    });
});

test('fail soft: an unopenable, blocked or slow database rejects with a code and leaks no connection', async () => {
    await inEnvironment(async env => {
        seedWallet(env, { deposits: [depositRow(LEGACY, 5)] });

        env.idb.failNextOpen();
        await assert.rejects(readOtherVersionHistory(readerOptions()), error => error.code === 'history_unreadable');

        const release = env.idb.hangNextOpen();
        await assert.rejects(readOtherVersionHistory(readerOptions({ timeoutMs: 30 })),
            error => error.code === 'history_timeout');
        release();
        await env.idb.idle();
        assert.equal(env.idb.connectionCount(DB), 0, 'a connection that arrives after the deadline is closed');

        await assert.rejects(readOtherVersionHistory(readerOptions({ database: '' })),
            error => error.code === 'history_unreadable');
        // Still readable afterwards.
        assert.equal((await readOtherVersionHistory(readerOptions())).rows.length, 1);
    });
    // No IndexedDB at all (this process has none outside the environment).
    assert.equal(globalThis.indexedDB, undefined);
    await assert.rejects(readOtherVersionHistory(readerOptions()), error => error.code === 'history_unreadable');
    assert.equal(HISTORY_READ_TIMEOUT_MS, 2000);
});

test('a version upgrade by another tab never waits on the reader', async () => {
    await inEnvironment(async env => {
        seedWallet(env, { deposits: [depositRow(LEGACY, 5)] });
        const read = readOtherVersionHistory(readerOptions({ indexedDB: env.idb }));
        const upgrade = new Promise((resolve, reject) => {
            const request = env.idb.forTab('newer-build').open(DB, 4);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const [result, connection] = await Promise.all([read, upgrade]);
        assert.equal(result.rows.length, 1);
        assert.equal(connection.version, 4);
        connection.close();
    });
});

test('caps: 100 rows per kind, newest first, and the truncation is reported', async () => {
    await inEnvironment(async env => {
        const deposits = Array.from({ length: HISTORY_ROW_LIMIT + 30 }, (_, index) => depositRow(LEGACY, index + 1, {
            confirmedAt: NOW - (index + 1) * 60_000, expiryTs: seconds(NOW + 30 * DAY)
        }));
        const withdrawals = Array.from({ length: HISTORY_ROW_LIMIT + 5 }, (_, index) => withdrawalRecord(LEGACY, 1000 + index, {
            phase: 'closed', payoutVerified: true, createdAt: NOW - (index + 1) * 60_000
        }));
        seedWallet(env, { deposits, withdrawals });
        const result = await readOtherVersionHistory(readerOptions());
        assert.equal(result.truncated, true);
        assert.equal(result.rows.filter(row => row.kind === 'deposit').length, HISTORY_ROW_LIMIT);
        assert.equal(result.rows.filter(row => row.kind === 'withdrawal').length, HISTORY_ROW_LIMIT);
        const newestDeposit = result.rows.find(row => row.kind === 'deposit');
        assert.equal(newestDeposit.noteId, 1, 'the newest deposits are the ones kept');
        const oldest = result.rows.filter(row => row.kind === 'deposit').at(-1);
        assert.equal(oldest.noteId, HISTORY_ROW_LIMIT);
        // A cut list says so, as its last row: a list that reads as complete
        // would be a silent drop.
        assert.equal(result.rows.filter(row => row.kind === 'omitted').length, 1);
        assert.equal(result.rows.at(-1).kind, 'omitted');
        // Under the cap nothing is reported.
        seedWallet(env, { deposits: deposits.slice(0, 3) });
        const small = await readOtherVersionHistory(readerOptions());
        assert.equal(small.truncated, false);
        assert.equal(small.rows.some(row => row.kind === 'omitted'), false);
    });
});

test('a cap keeps open and credited rows ahead of older closed ones, and the cut list says it was cut', () => {
    // 100 closed payments, all newer than the three rows that matter, and 5
    // closed ones older than those.
    const closed = Array.from({ length: HISTORY_ROW_LIMIT }, (_, index) => withdrawalRecord(LEGACY, 1000 + index, {
        phase: 'closed', payoutVerified: true, createdAt: NOW - (index + 1) * 60_000, updatedAt: NOW - (index + 1) * 60_000
    }));
    const old = NOW - 400 * DAY;
    const matters = [
        withdrawalRecord(LEGACY, 900, { mode: 'mutual', phase: 'parked', createdAt: old, updatedAt: old }),
        withdrawalRecord(CURRENT, 901, { mode: 'escape', phase: 'closed', payoutCredited: true, creditedAmount: 800_000,
            createdAt: old - DAY, updatedAt: old - DAY }),
        withdrawalRecord(LEGACY, 902, { mode: 'escape', phase: 'closed', payoutVerified: true,
            payoutAlert: 'concession_exceeded_bound', createdAt: old - 2 * DAY, updatedAt: old - 2 * DAY })
    ];
    const olderClosed = Array.from({ length: 5 }, (_, index) => withdrawalRecord(LEGACY, 950 + index, {
        phase: 'closed', payoutVerified: true, createdAt: old - (index + 3) * DAY, updatedAt: old - (index + 3) * DAY
    }));
    const result = project({ withdrawals: [...closed, ...matters, ...olderClosed] }, { loadedDeploymentId: RETIRED });

    const withdrawals = result.rows.filter(row => row.kind === 'withdrawal');
    assert.equal(withdrawals.length, HISTORY_ROW_LIMIT);
    for (const noteId of [900, 901, 902]) {
        assert.ok(withdrawals.some(row => row.noteId === noteId), `note ${noteId} (needs attention) is kept`);
    }
    // What went is the oldest of the closed ones, never one that matters.
    assert.equal(withdrawals.some(row => row.noteId >= 950 && row.noteId < 955), false);
    assert.equal(withdrawals.some(row => row.noteId === 1000 + HISTORY_ROW_LIMIT - 1), false,
        'the oldest of the newer closed ones makes room');
    assert.equal(withdrawals.some(row => row.noteId === 1000), true);
    assert.equal(result.truncated, true);
    // The list ends with its own account of the cut, and it is the only one.
    assert.equal(result.rows.filter(row => row.kind === 'omitted').length, 1);
    const last = result.rows.at(-1);
    assert.deepEqual({ key: last.key, kind: last.kind, at: last.at, noteId: last.noteId }, {
        key: 'history:omitted', kind: 'omitted', at: 0, noteId: null
    });
    assert.equal(last.version.versionId, null);
    assert.ok(Object.isFrozen(last));
    // Exactly at the limit nothing is cut.
    const exact = project({ withdrawals: closed }, { loadedDeploymentId: RETIRED });
    assert.equal(exact.truncated, false);
    assert.equal(exact.rows.some(row => row.kind === 'omitted'), false);
});

test('a cap never drops a row that needs attention, even when there are more of them than the limit', () => {
    const attention = Array.from({ length: HISTORY_ROW_LIMIT + 5 }, (_, index) => withdrawalRecord(LEGACY, 2000 + index, {
        phase: index % 2 ? 'parked' : 'restored', createdAt: NOW - (index + 1) * DAY, updatedAt: NOW - (index + 1) * DAY
    }));
    const closed = Array.from({ length: 3 }, (_, index) => withdrawalRecord(LEGACY, 3000 + index, {
        phase: 'closed', payoutVerified: true, createdAt: NOW + (index + 1) * DAY
    }));
    // Even though the closed ones are the newest of all.
    const result = project({ withdrawals: [...attention, ...closed] }, { loadedDeploymentId: RETIRED });
    const kept = result.rows.filter(row => row.kind === 'withdrawal');
    assert.equal(kept.length, attention.length);
    assert.equal(kept.every(row => row.noteId >= 2000 && row.noteId < 3000), true);
    assert.equal(result.truncated, true, 'the closed ones were left out and the list says so');
    assert.equal(result.rows.at(-1).kind, 'omitted');
    // With nothing but rows that need attention, nothing is left out.
    const only = project({ withdrawals: attention }, { loadedDeploymentId: RETIRED });
    assert.equal(only.truncated, false);
    assert.equal(only.rows.length, attention.length);
});

test('deposit and expiry lists are cut newest first, and the line is last even among rows with no date', () => {
    // Expiry rows of unclaimed, past-deadline deposits are a list of their own.
    const lapsed = Array.from({ length: HISTORY_ROW_LIMIT + 1 }, (_, index) => depositRow(LEGACY, 500 + index, {
        confirmedAt: NOW - 90 * DAY, expiryTs: seconds(NOW - (index + 1) * DAY)
    }));
    const expired = project({ deposits: lapsed }, { loadedDeploymentId: RETIRED });
    const expiries = expired.rows.filter(row => row.kind === 'expiry');
    assert.equal(expiries.length, HISTORY_ROW_LIMIT);
    assert.equal(expiries[0].noteId, 500, 'the most recent deadline is the first');
    assert.equal(expired.truncated, true);

    const deposits = Array.from({ length: HISTORY_ROW_LIMIT + 2 }, (_, index) => depositRow(LEGACY, index + 1, {
        confirmedAt: NOW - (index + 1) * 60_000, expiryTs: seconds(NOW + 30 * DAY)
    }));
    const undated = Array.from({ length: 3 }, (_, index) => withdrawalRecord(LEGACY, 800 + index, {
        phase: 'parked', createdAt: undefined, updatedAt: undefined
    }));
    const result = project({ deposits, withdrawals: undated }, { loadedDeploymentId: RETIRED });
    const kept = result.rows.filter(row => row.kind === 'deposit');
    assert.equal(kept.length, HISTORY_ROW_LIMIT);
    assert.deepEqual([kept[0].noteId, kept.at(-1).noteId], [1, HISTORY_ROW_LIMIT]);
    assert.equal(result.rows.filter(row => row.at === 0).length, 4, 'three undated rows and the line');
    assert.equal(result.rows.at(-1).kind, 'omitted', 'the line sorts after rows with no date');
    // Re-reading the rows at a later time keeps it last too.
    assert.equal(rowsAt(result.rows, NOW + 99 * DAY).at(-1).kind, 'omitted');
});

// ----------------------------------------------- parity with the REAL stores

let instance = 0;
// A fresh module instance per call: the store caches its IndexedDB connection.
const loadModule = async (file, tag) => import(`${pathToFileURL(file).href}?${tag}=${++instance}`);

// The SDK's own sanitizer input: note state with the three public numbers.
const noteState = (noteId, overrides = {}) => ({
    note_id: noteId, deposit_amount: 2_000_000, expiry_ts: seconds(NOW + 30 * DAY),
    secret_s: 'SECRET-secret_s', current_balance: 1_900_000, ...overrides
});

const receipt = (suffix, extras = {}) => ({
    operationId: `deposit-op-${suffix}`, transactionHash: hash(suffix), createdAt: NOW - 90 * DAY,
    confirmedAt: NOW - 90 * DAY + 90_000, feeWei: '2100000000000', gasUsed: '100000', effectiveGasPrice: '21000000',
    fundingAddress: `0x${'11'.repeat(20)}`, receiptBlockNumber: 1000, receiptBlockHash: hash('b'), ...extras
});

// A wallet written by the legacy store's own functions: deposits with
// receipts, a mutual close that was finalized (sanitized), a set-aside note, a
// treasury claim with the note archived, an expired unclaimed note, and
// another deployment's credited escape and returned note.
async function writeLegacyHistory(store, clock) {
    const write = async (deploymentId, noteId, stateOverrides, confirmation) => {
        await store.writeBrowserWallet({ deploymentId, state: noteState(noteId, stateOverrides) },
            { depositConfirmation: confirmation });
    };
    clock.now = NOW - 90 * DAY;
    await write(LEGACY, 5, { expiry_ts: seconds(NOW + 30 * DAY) }, receipt('1'));
    clock.now = NOW - 80 * DAY;
    await store.detachBrowserClosedWithdrawal({
        recordId: `${LEGACY}:${CHAIN}:${VAULT}:5`, deploymentId: LEGACY, chainId: CHAIN, contractAddress: VAULT, noteId: 5,
        mode: 'mutual', destination: DESTINATION, finalBalance: 1_900_000, closeBlockNumber: 120,
        transactionHash: hash('c'), payoutVerified: true
    });
    clock.now = NOW - 79 * DAY;
    await store.updateBrowserWithdrawal(`${LEGACY}:${CHAIN}:${VAULT}:5`,
        { phase: 'closed', finalizedBlockNumber: 150, payoutVerified: true }, { sanitize: true });

    clock.now = NOW - 60 * DAY;
    await write(LEGACY, 6, { expiry_ts: seconds(NOW + 20 * DAY) }, receipt('2'));
    await store.writeBrowserWallet({
        deploymentId: LEGACY, state: noteState(6, { expiry_ts: seconds(NOW + 20 * DAY) }),
        preparedWithdrawal: { phase: 'prepared', mode: 'mutual', operationId: 'op-6', proof: 'SECRET-proof',
            withdrawalNullifier: 'SECRET-nullifier', clearanceReserved: true }
    });
    clock.now = NOW - 59 * DAY;
    await store.parkBrowserWithdrawal({
        recordId: `${LEGACY}:${CHAIN}:${VAULT}:6`, deploymentId: LEGACY, chainId: CHAIN, contractAddress: VAULT,
        noteId: 6, mode: 'mutual', phase: 'parked', destination: DESTINATION, finalBalance: 1_800_000
    });

    clock.now = NOW - 50 * DAY;
    await write(LEGACY, 7, { expiry_ts: seconds(NOW - 10 * DAY) }, receipt('3'));
    clock.now = NOW - 9 * DAY;
    await store.recordBrowserExpiryClaims(LEGACY, [{
        noteId: 7, transactionHash: hash('f'), blockHash: hash('9'), blockNumber: 777,
        claimedAt: NOW - 9 * DAY, amount: 2_000_000
    }]);
    await store.archiveBrowserWallet('expiry-claimed', 7);
    // The old parked record of the claimed note stays in the store.
    await store.putBrowserWithdrawal({
        recordId: `${LEGACY}:${CHAIN}:${VAULT}:7`, deploymentId: LEGACY, chainId: CHAIN, contractAddress: VAULT,
        noteId: 7, mode: 'mutual', phase: 'parked', destination: DESTINATION, finalBalance: 2_000_000,
        createdAt: NOW - 40 * DAY, state: noteState(7)
    });

    clock.now = NOW - 45 * DAY;
    await write(LEGACY, 8, { expiry_ts: seconds(NOW - 5 * DAY) }, receipt('4'));
    await store.archiveBrowserWallet('closed', 8);

    clock.now = NOW - 20 * DAY;
    await write(LEGACY, 9, { expiry_ts: seconds(NOW + 40 * DAY) }, receipt('5'));
    await store.archiveBrowserWallet('closed', 9);

    // Another deployment, written by the same store (as a second build would).
    clock.now = NOW - 30 * DAY;
    await write(CURRENT, 3, { expiry_ts: seconds(NOW + 25 * DAY) }, receipt('6'));
    await store.archiveBrowserWallet('closed', 3);
    await store.putBrowserWithdrawal({
        recordId: `${CURRENT}:${CHAIN}:${hash('2').slice(0, 42)}:3`, deploymentId: CURRENT, chainId: CHAIN,
        noteId: 3, mode: 'escape', phase: 'closed_unconfirmed', destination: DESTINATION, finalBalance: 800_000,
        createdAt: NOW - 28 * DAY, payoutVerified: false, payoutCredited: true, creditedAmount: 800_000,
        payoutCreditEvidence: 'receipt', closeBlockNumber: 100, state: noteState(3)
    });
    clock.now = NOW - 100 * DAY;
    await write(RETIRED, 1, { expiry_ts: seconds(NOW + 60 * DAY) }, receipt('7'));
    await store.archiveBrowserWallet('closed', 1);
    await store.putBrowserWithdrawal({
        recordId: `${RETIRED}:${CHAIN}:${hash('3').slice(0, 42)}:1`, deploymentId: RETIRED, chainId: CHAIN,
        noteId: 1, mode: 'mutual', phase: 'closed', destination: DESTINATION, finalBalance: 77_000,
        createdAt: NOW - 99 * DAY, payoutVerified: true, transactionHash: hash('d')
    });
    clock.now = NOW;
}

const publicView = row => ({
    key: row.key, kind: row.kind, at: row.at, noteId: row.noteId,
    ...(row.kind === 'deposit' ? { amountUnits: row.amountUnits, transactionHash: row.transactionHash,
        feeWei: row.feeWei, expiryTs: row.expiryTs } : {}),
    ...(row.kind === 'withdrawal' ? { mode: row.mode, phase: row.phase, amountUnits: row.amountUnits,
        destination: row.destination, payoutVerified: row.payoutVerified, payoutCredited: row.payoutCredited,
        creditedUnits: row.creditedUnits } : {}),
    ...(row.kind === 'expiry' ? { status: row.status, expiryTs: row.expiryTs, claimAmountUnits: row.claimAmountUnits,
        claimTransactionHash: row.claimTransactionHash } : {})
});

// What the SDK's own (deployment-filtered) reads say about `deploymentId`,
// as the rows this module is expected to produce for it.
function expectedRows(sdkSnapshot, expiryRecords, scope) {
    const claimed = new Set(expiryRecords.filter(record => record.status === 'claimed').map(record => record.noteId));
    return [
        ...sdkSnapshot.deposits.filter(record => record.status === 'confirmed').map(record => ({
            key: `${scope}:deposit:${record.noteId}`, kind: 'deposit', at: record.confirmedAt || record.createdAt || 0,
            noteId: record.noteId, amountUnits: String(record.amount), transactionHash: record.transactionHash || null,
            feeWei: record.feeWei || null, expiryTs: record.expiryTs ?? null
        })),
        ...sdkSnapshot.withdrawals.filter(record => !claimed.has(record.noteId)).map(record => ({
            key: `${scope}:withdrawal:${record.noteId}`, kind: 'withdrawal', at: record.createdAt || record.updatedAt || 0,
            noteId: record.noteId, mode: record.mode, phase: record.phase,
            amountUnits: record.finalBalance == null ? null : String(record.finalBalance),
            destination: record.destination ? record.destination.toLowerCase() : null,
            payoutVerified: record.payoutVerified === true, payoutCredited: record.payoutCredited === true,
            creditedUnits: record.creditedAmount == null ? null : String(record.creditedAmount)
        })),
        ...expiryRecords.map(record => ({
            key: `${scope}:expiry:${record.noteId}`, kind: 'expiry', at: record.createdAt, noteId: record.noteId,
            status: record.status, expiryTs: record.expiryTs,
            claimAmountUnits: record.amount == null ? null : String(record.amount),
            claimTransactionHash: record.transactionHash
        }))
    ].sort((left, right) => (left.key < right.key ? -1 : 1));
}

const sorted = rows => [...rows].sort((left, right) => (left.key < right.key ? -1 : 1));

test('parity with the legacy SDK: rows equal its own deployment-filtered reads, on a database it wrote', async () => {
    await withClock(NOW, async clock => {
        await inEnvironment(async env => {
            const store = await loadModule(legacyStorePath, 'history');
            await writeLegacyHistory(store, clock);
            const dumpBefore = env.idb.dump();

            // My reads first (the SDK's own read back-fills deposit rows).
            const mine = {};
            for (const [loaded, others] of [[CURRENT, [LEGACY, RETIRED]], [LEGACY, [CURRENT]]]) {
                const result = await readOtherVersionHistory(readerOptions({
                    loadedDeploymentId: loaded, indexedDB: env.idb,
                    table: [...TABLE]
                }));
                assert.equal(result.truncated, false);
                for (const deploymentId of others) {
                    const scope = TABLE.find(version => version.deploymentId === deploymentId).id;
                    mine[deploymentId] = sorted(result.rows.filter(row => row.scope === scope).map(publicView));
                }
                assert.equal(result.rows.every(row => row.version.versionId !== null), true);
            }
            assert.deepEqual(env.idb.dump(), dumpBefore, 'reading changed nothing');
            assert.equal(JSON.stringify(Object.values(mine)).includes('SECRET'), false);

            // The SDK's views of each deployment, taken as the build that
            // loaded it would.
            for (const deploymentId of [LEGACY, CURRENT, RETIRED]) {
                const snapshot = await store.readBrowserWalletSnapshot(deploymentId);
                // The one credited escape of this scenario sits on a note whose
                // expiry is in the future, so the installed SDK's expiry rule
                // (no credited-payout clause) and the ported one agree here.
                const records = legacyExpiry.deriveExpiryRecords(snapshot.deposits, snapshot.withdrawals, NOW);
                const scope = TABLE.find(version => version.deploymentId === deploymentId).id;
                assert.ok(mine[deploymentId], `rows were read for ${deploymentId}`);
                assert.deepEqual(mine[deploymentId], expectedRows(snapshot, records, scope), deploymentId);
            }
            // The scenario really holds what the test says it does.
            const legacy = mine[LEGACY];
            assert.deepEqual(legacy.filter(row => row.kind === 'expiry').map(row => `${row.noteId}:${row.status}`).sort(),
                ['7:claimed', '8:expired']);
            assert.deepEqual(legacy.filter(row => row.kind === 'withdrawal').map(row => `${row.noteId}:${row.phase}`).sort(),
                ['5:closed', '6:parked']);
            assert.equal(legacy.filter(row => row.kind === 'deposit').length, 5);
        });
    });
});

test('the legacy SDK\'s expiry rule differs from the ported one only for a credited payout, as documented', () => {
    const deposits = [{ recordId: `${LEGACY}:deposit:3`, deploymentId: LEGACY, noteId: 3, amount: 5,
        expiryTs: seconds(NOW - DAY), status: 'confirmed' }];
    const withdrawals = [{ deploymentId: LEGACY, noteId: 3, mode: 'escape', phase: 'closed', payoutVerified: false,
        payoutCredited: true, chainStatus: 'closed' }];
    assert.deepEqual(deriveExpiryRecords(deposits, withdrawals, NOW), []);
    assert.equal(legacyExpiry.deriveExpiryRecords(deposits, withdrawals, NOW).length, 1,
        'the installed SDK has no credited-payout rule: this is the divergence the newer SDK fixed');
});

test('parity with the newer SDK: rows equal its recorded views of a database its store wrote', async () => {
    const fixture = JSON.parse(fs.readFileSync(
        path.join(repoRoot, 'test/fixtures/zkapi-v2-real-shapes/wallet-db-v2.json'), 'utf8'));
    const table = resolvedTable(activatedRegistry(), 'mainnet');
    const byId = Object.fromEntries(table.map(version => [version.id, version]));
    assert.equal(byId.v1.deploymentId, fixture.deployments.previous);
    assert.equal(byId.v2.deploymentId, fixture.deployments.current);
    // The retired deployment is one no row names: a tombstone of its own.
    const withRetired = [...table, {
        id: 'v0', ordinal: 0, label: 'Version 0', adapter: 'note-bound-v1', status: 'retired',
        deploymentId: fixture.deployments.retired, chainId: 1, vault: fixture.vaults.retired
    }];
    const scopeOf = deploymentId => withRetired.find(version => version.deploymentId === deploymentId).id;

    await inEnvironment(async env => {
        env.idb.seed(fixture.databaseName, fixture.dump);
        const before = env.idb.dump();
        for (const loaded of [fixture.deployments.current, fixture.deployments.previous]) {
            const result = await readOtherVersionHistory({
                database: fixture.databaseName, table: withRetired, loadedDeploymentId: loaded,
                now: () => fixture.generatedAtMs, indexedDB: env.idb
            });
            assert.equal(result.truncated, false);
            for (const [deploymentId, view] of Object.entries(fixture.sdkViews)) {
                if (deploymentId === loaded) {
                    assert.equal(result.rows.some(row => row.scope === scopeOf(deploymentId)), false,
                        'the loaded deployment is the SDK\'s to show');
                    continue;
                }
                const snapshot = {
                    deposits: view.deposits,
                    withdrawals: Object.values(fixture.dump.stores.withdrawals.records)
                        .filter(record => view.withdrawalIds.includes(record.recordId))
                };
                assert.deepEqual(sorted(result.rows.filter(row => row.scope === scopeOf(deploymentId)).map(publicView)),
                    expectedRows(snapshot, view.expiryRecords, scopeOf(deploymentId)), deploymentId);
            }
            assert.equal(/SECRET/.test(JSON.stringify(result)), false, 'the dump holds SECRET- markers; none leaves');
        }
        assert.deepEqual(env.idb.dump(), before);
        assert.equal(env.idb.committedWrites().length, 0);
    });
});

test('the request journals and evidence of the newer store hold proofs and are never in the read', async () => {
    const fixture = JSON.parse(fs.readFileSync(
        path.join(repoRoot, 'test/fixtures/zkapi-v2-real-shapes/wallet-db-v2.json'), 'utf8'));
    const archives = Object.keys(fixture.dump.stores.archives.records);
    assert.ok(archives.some(key => key.startsWith('request-journal:')) && archives.some(key => key.startsWith('request-evidence:')),
        'the committed dump holds both kinds of request archive');
    await inEnvironment(async env => {
        env.idb.seed(fixture.databaseName, fixture.dump);
        const { scopes } = await recordTransactions(env, fixture.databaseName, () => readOtherVersionHistory({
            database: fixture.databaseName, table: resolvedTable(activatedRegistry(), 'mainnet'),
            loadedDeploymentId: fixture.deployments.current, now: () => fixture.generatedAtMs, indexedDB: env.idb
        }));
        for (const scope of scopes) {
            assert.equal(scope.names.includes('archives'), false);
            assert.equal(scope.names.includes('runtime'), false);
            assert.equal(scope.mode, 'readonly');
        }
    });
});

// ----------------------------------------------------- allowlist drift guards

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

test('drift guard: every field of every SDK store\'s deposit row is one this module reads or knowingly ignores', async () => {
    const classified = new Set([...DEPOSIT_ROW_FIELDS.read, ...DEPOSIT_ROW_FIELDS.ignored]);
    assert.equal(classified.size, DEPOSIT_ROW_FIELDS.read.length + DEPOSIT_ROW_FIELDS.ignored.length,
        'a field has one role');
    const stores = installedStores();
    assert.ok(stores.length >= 2 && fs.existsSync(stores[0].file) && fs.existsSync(stores[1].file));
    const evidence = new Set();
    const writers = [];
    await withClock(NOW, async clock => {
        for (const { name, file } of stores) {
            await inEnvironment(async env => {
                const store = await loadModule(file, 'drift');
                clock.now = NOW - 90 * DAY;
                try {
                    await store.writeBrowserWallet({ deploymentId: LEGACY, state: noteState(5, { expiry_ts: seconds(NOW - 10 * DAY) }) },
                        { depositConfirmation: receipt('1') });
                    clock.now = NOW - 9 * DAY;
                    await store.recordBrowserExpiryClaims(LEGACY, [{
                        noteId: 5, transactionHash: hash('f'), blockHash: hash('9'), blockNumber: 777,
                        claimedAt: NOW - 9 * DAY, amount: 2_000_000
                    }]);
                } catch (error) {
                    // The package stand-in implements no deposit history: it
                    // has nothing to classify.
                    if (error?.code === 'fixture_not_implemented') return;
                    throw error;
                }
                writers.push(name);
                const row = env.idb.read(DB, 'deposits', `${LEGACY}:deposit:5`);
                assert.ok(row && row.expiryClaim, `${name}: a deposit row with receipt and claim was stored`);
                for (const key of Object.keys(row)) {
                    assert.ok(classified.has(key), `${name}: the deposit-row field "${key}" is neither read nor ` +
                        'knowingly ignored by otherVersionHistory.mjs. A new public field needs a decision (show ' +
                        'it, or list it as ignored); a private one must never be copied.');
                    evidence.add(key);
                }
                // And what it stored is what this module projects.
                const result = await readOtherVersionHistory(readerOptions({
                    loadedDeploymentId: CURRENT, indexedDB: env.idb, table: [...TABLE]
                }));
                const deposit = result.rows.find(entry => entry.kind === 'deposit');
                assert.equal(deposit.amountUnits, '2000000', name);
                assert.equal(deposit.feeWei, '2100000000000', name);
                assert.equal(result.rows.find(entry => entry.kind === 'expiry').status, 'claimed', name);
            });
        }
    });
    assert.ok(writers.includes('installed legacy SDK'), `deposit rows written by: ${writers.join(', ')}`);
    // The newer store's rows, as the committed dump holds them.
    const fixture = JSON.parse(fs.readFileSync(
        path.join(repoRoot, 'test/fixtures/zkapi-v2-real-shapes/wallet-db-v2.json'), 'utf8'));
    const newer = Object.values(fixture.dump.stores.deposits.records);
    assert.ok(newer.length >= 5);
    for (const row of newer) {
        for (const key of Object.keys(row)) {
            assert.ok(classified.has(key), `newer SDK store: the deposit-row field "${key}" is not classified`);
            evidence.add(key);
        }
    }
    // Nothing is classified on no evidence at all (a stale entry).
    for (const key of classified) assert.ok(evidence.has(key), `no SDK store keeps a deposit-row field "${key}"`);
    // The negative control: a field nobody classified is never copied.
    assert.equal(classified.has('brandNewBookkeeping'), false);
    const result = project({ deposits: [depositRow(LEGACY, 5, { brandNewBookkeeping: 'SECRET-new' })] });
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('drift guard: the store names and the request-archive prefixes are the SDKs\' own', async () => {
    for (const { name, file } of installedStores()) {
        await inEnvironment(async env => {
            const store = await loadModule(file, 'names');
            await store.readBrowserWallet();
            assert.deepEqual(env.idb.storeNames(DB), ['archives', 'deposits', 'runtime', 'withdrawals'], name);
        });
    }
    // The newer store keeps request archives under these prefixes (the
    // committed dump holds both); the reader does not ask for the archives at
    // all, and this keeps that decision visible if the keys ever move.
    const fixture = JSON.parse(fs.readFileSync(
        path.join(repoRoot, 'test/fixtures/zkapi-v2-real-shapes/wallet-db-v2.json'), 'utf8'));
    const prefixes = new Set(Object.keys(fixture.dump.stores.archives.records)
        .filter(key => /^request-/.test(key)).map(key => key.split(':')[0] + ':'));
    assert.deepEqual([...prefixes].sort(), ['request-evidence:', 'request-journal:']);
});

test('every withdrawal field the projection reads is named in the allowlist, and no row carries a private key', () => {
    const read = new Set(WITHDRAWAL_RECORD_FIELDS);
    for (const forbidden of ['state', 'preparedWithdrawal', 'proof', 'withdrawalNullifier', 'challengeEvidence',
        'exitLock', 'startSubmissionId', 'finalizeSubmissionOwner', 'transactionAttempts', 'finalizeAttempts', 'error',
        'recordId', 'contractAddress']) {
        assert.equal(read.has(forbidden), false, forbidden);
    }
    // A poison value in every allowlisted field that is not a simple scalar
    // type never produces a row value of another type.
    const poisoned = Object.fromEntries(WITHDRAWAL_RECORD_FIELDS.map(key => [key, { toString() { throw new Error(key); } }]));
    const result = project({ withdrawals: [{ ...withdrawalRecord(LEGACY, 5), ...poisoned, noteId: 5, deploymentId: LEGACY }] });
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    assert.equal(row.mode, null);
    assert.equal(row.phase, null);
    assert.equal(row.destination, null);
    assert.equal(row.amountUnits, null);
    assert.equal(row.payoutVerified, false);
});

// ---------------------------------------------------------- expiry parity

const strip = records => records.map(({ detail, ...record }) => record);

test('expiry parity: fuzzed inputs give the installed SDK\'s records field for field', () => {
    let seed = 20_261_115;
    const next = () => {
        seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    const pick = list => list[Math.floor(next() * list.length)];
    const base = 1_750_000_000_000;
    let compared = 0;
    let nonEmpty = 0;
    for (let round = 0; round < 3000; round += 1) {
        const deposits = [];
        const withdrawals = [];
        for (let noteId = 1; noteId <= 4; noteId += 1) {
            const deploymentId = pick(['D1', 'D2']);
            const expiryTs = seconds(base) + pick([-100_000, -10, -1, 0, 1, 10, 100_000]);
            const amount = pick([5, 1000, 2_000_000]);
            const claim = next() < 0.3 ? {
                transactionHash: pick([hash('a'), hash('A'), 'bad']), blockHash: pick([hash('b'), 'bad']),
                blockNumber: pick([0, 1, 777]), claimedAt: expiryTs * 1000 + pick([-5, 0, 5, 9e15]),
                amount: pick([amount, amount, amount + 1])
            } : undefined;
            deposits.push({
                recordId: `${deploymentId}:deposit:${noteId}`, deploymentId, noteId, amount,
                expiryTs: pick([expiryTs, expiryTs, 0, null]), status: pick(['confirmed', 'confirmed', 'pending']),
                ...(claim ? { expiryClaim: claim } : {})
            });
            if (next() < 0.6) {
                withdrawals.push({
                    deploymentId: pick([deploymentId, deploymentId, 'D3']), noteId, mode: pick(['mutual', 'escape']),
                    phase: pick(['closed', 'closed_unconfirmed', 'pending', 'parked']),
                    payoutVerified: next() < 0.5, payoutCredited: false,
                    chainStatus: pick(['closed', 'pending_withdrawal', 'active']),
                    startBlockNumber: pick([0, 5, 10, null]), finalizedBlockNumber: pick([undefined, null, 4, 5, 20])
                });
            }
        }
        for (const nowMs of [base, base - 2_000_000_000, Number.NaN]) {
            const mine = strip(deriveExpiryRecords(deposits, withdrawals, nowMs));
            const sdk = strip(legacyExpiry.deriveExpiryRecords(deposits, withdrawals, nowMs));
            assert.deepEqual(mine, sdk, JSON.stringify({ deposits, withdrawals, nowMs }));
            compared += 1;
            if (sdk.length) nonEmpty += 1;
        }
    }
    assert.ok(compared >= 9000 && nonEmpty > 1000, `compared ${compared}, ${nonEmpty} with records`);
});

test('expiry parity: the newer SDK\'s own vectors, including credited payouts and the escape clause', () => {
    const vectors = JSON.parse(fs.readFileSync(
        path.join(repoRoot, 'test/fixtures/zkapi-v2-real-shapes/oracle-vectors.json'), 'utf8')).deriveExpiryRecords;
    assert.ok(vectors.length >= 50);
    let credited = 0;
    let claimedEscape = 0;
    for (const [index, vector] of vectors.entries()) {
        assert.deepEqual(deriveExpiryRecords(vector.deposits, vector.withdrawals, vector.nowMs), strip(vector.output),
            `vector ${index}`);
        if (vector.withdrawals.some(record => record.payoutCredited === true)) credited += 1;
        if (vector.withdrawals.some(record => record.mode === 'escape' && record.chainStatus === 'pending_withdrawal')) claimedEscape += 1;
    }
    assert.ok(credited >= 10 && claimedEscape >= 5, `${credited} credited, ${claimedEscape} escape vectors`);
});

// --------------------------------------------------------------------- rowsAt

test('rowsAt: a deadline that passes after the read adds its expiry row, nothing is removed', () => {
    const expiryTs = seconds(NOW + 2 * DAY);
    const result = project({ deposits: [depositRow(LEGACY, 5, { expiryTs }), depositRow(LEGACY, 6, { expiryTs: seconds(NOW + 9 * DAY) })],
        withdrawals: [] });
    assert.equal(result.rows.some(row => row.kind === 'expiry'), false);
    assert.equal(rowsAt(result.rows, NOW + DAY).length, 2);
    const later = rowsAt(result.rows, NOW + 3 * DAY);
    assert.equal(later.length, 3);
    const added = later.find(row => row.kind === 'expiry');
    assert.deepEqual({ ...added, version: undefined }, {
        key: 'v1:expiry:5', scope: 'v1', kind: 'expiry', at: expiryTs * 1000, noteId: 5, version: undefined,
        status: 'expired', expiryTs, claimAmountUnits: null, claimTransactionHash: null
    });
    assert.equal(added.version, result.rows[0].version);
    // Idempotent over rows that already carry it, and the input is untouched.
    assert.equal(rowsAt(later, NOW + 3 * DAY).length, 3);
    assert.equal(result.rows.length, 2);
    // A settled or claimed deposit never gains one, nor does one without a clock.
    const settled = project({ deposits: [depositRow(LEGACY, 5, { expiryTs })],
        withdrawals: [withdrawalRecord(LEGACY, 5, { phase: 'closed', payoutVerified: true })] });
    assert.equal(rowsAt(settled.rows, NOW + 9 * DAY).filter(row => row.kind === 'expiry').length, 0);
    assert.equal(rowsAt(result.rows, Number.NaN).length, 2);
    assert.deepEqual(rowsAt(null, NOW), []);
    assert.deepEqual(rowsAt([null, 'x', { kind: 'deposit' }], NOW), []);
});

// ------------------------------------------------------------------ renderers

const usd = units => `$${(Number(units) / 1e9 * 2000).toFixed(2)}`;
const render = (row, ctx = {}) => renderHistoryRow(row, { formatMoney: usd, now: NOW, txUrl: (hashText, chainId) => `https://explorer.test/${chainId}/tx/${hashText}`,
    dateText: ms => `date ${ms}`, ...ctx });
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const rowsFor = (raw, options = {}) => project(raw, options).rows;
const rowOf = (raw, kind, noteId, options) => rowsFor(raw, options).find(row => row.kind === kind
    && (noteId === undefined || row.noteId === noteId));

test('renders a deposit like the dialog\'s own row, tagged with its version', () => {
    const row = rowOf({ deposits: [depositRow(LEGACY, 5, {
        feeWei: '2100000000000', gasUsed: '100000', effectiveGasPrice: '21000000',
        fundingAddress: `0x${'11'.repeat(20)}`, receiptBlockNumber: 12, receiptBlockHash: hash('b')
    })] }, 'deposit');
    const html = render(row);
    assert.match(html, /^<section class="rounded-lg border border-border bg-muted\/20 p-3" data-other-version-record="v1:deposit:5">/);
    const words = text(html);
    assert.match(words, /Deposit \+\$4\.00 added to private balance date \d+/);
    assert.match(words, /Actual network fee: 0\.0000021 ETH/);
    assert.match(words, /Added Version 1/);
    assert.match(html, /href="https:\/\/explorer\.test\/11155111\/tx\/0x1{64}"/);
    assert.match(html, /rel="noopener noreferrer"/);
});

test('renders each withdrawal state in plain words, never as a sync target', () => {
    const rows = {
        returned: rowOf({ withdrawals: [withdrawalRecord(LEGACY, 5, { phase: 'closed', payoutVerified: true,
            transactionHash: hash('c') })] }, 'withdrawal'),
        closed: rowOf({ withdrawals: [withdrawalRecord(LEGACY, 5, { phase: 'closed', payoutVerified: false })] }, 'withdrawal'),
        parked: rowOf({ withdrawals: [withdrawalRecord(LEGACY, 5, { phase: 'parked' })] }, 'withdrawal'),
        pending: rowOf({ withdrawals: [withdrawalRecord(LEGACY, 5, { mode: 'escape', phase: 'pending',
            challengeDeadline: seconds(NOW + DAY) })] }, 'withdrawal'),
        credit: rowOf({ withdrawals: [withdrawalRecord(CURRENT, 5, { mode: 'escape', phase: 'closed', payoutCredited: true,
            creditedAmount: 800_000 })] }, 'withdrawal', 5, { loadedDeploymentId: LEGACY }),
        creditUnknown: rowOf({ withdrawals: [withdrawalRecord(CURRENT, 5, { mode: 'escape', phase: 'closed',
            payoutCredited: true, creditedAmount: null })] }, 'withdrawal', 5, { loadedDeploymentId: LEGACY })
    };
    assert.match(text(render(rows.returned)), /^Withdrawal \$3\.80 returned to 0x3434…343434 date \d+ Returned Version 1 View transaction$/);
    assert.match(text(render(rows.closed)), /^Balance closed Payment not verified date \d+ Closed Version 1$/);
    assert.match(text(render(rows.parked)), /^Withdrawal Unfinished in version 1\. Finish it there\. date \d+ Unfinished Version 1 \$3\.80 set aside · to 0x3434…343434$/);
    assert.match(text(render(rows.pending)), /Withdrawal · Emergency exit Unfinished in version 1\. Finish it there\./);
    assert.match(text(render(rows.pending)), /Can be finalized after date \d+\./);
    assert.match(text(render(rows.credit)), /^Payout held A payout of \$1\.60 is waiting\. Claim it in version 2\. date \d+ To claim Version 2$/);
    assert.match(text(render(rows.creditUnknown)), /A payout is waiting, and its amount isn’t known here\. Claim it in version 2\./);
    for (const row of Object.values(rows)) assert.ok(row, 'every state produced a row');
});

test('renders expiry history, claimed or not, with no way to "check" it from here', () => {
    const expiryTs = seconds(NOW - 10 * DAY);
    const claim = { transactionHash: hash('f'), blockHash: hash('9'), blockNumber: 777, claimedAt: NOW - 9 * DAY, amount: 2_000_000 };
    const rows = rowsFor({ deposits: [depositRow(LEGACY, 7, { expiryTs, expiryClaim: claim }), depositRow(LEGACY, 8, { expiryTs })] });
    const claimed = render(rows.find(row => row.key === 'v1:expiry:7'));
    assert.match(text(claimed), /^Expiry claim \$4\.00 from the original deposit was paid to the service treasury\. No refund was made\./);
    assert.match(claimed, /href="https:\/\/explorer\.test\/11155111\/tx\/0xf{64}"/);
    const expired = render(rows.find(row => row.key === 'v1:expiry:8'));
    assert.match(text(expired), /^Expiry deadline passed No automatic refund\. A treasury claim hasn’t been confirmed here\. date \d+ Expired Version 1$/);
    assert.equal(/Check status|Check expiry|<button|<a /.test(expired), false);
});

test('amounts fall back to ETH when there is no price, and are absent for an unknown version', () => {
    const row = rowOf({ deposits: [depositRow(LEGACY, 5)] }, 'deposit');
    for (const formatMoney of [() => '—', () => '', () => '-', () => { throw new Error('no quote'); }, undefined]) {
        assert.match(text(renderHistoryRow(row, { formatMoney })), /\+0\.002 ETH added to private balance/);
    }
    const unknown = rowsFor({ deposits: [depositRow(UNKNOWN, 5)],
        withdrawals: [withdrawalRecord(UNKNOWN, 5, { phase: 'closed', payoutVerified: true, transactionHash: hash('c') })] });
    for (const entry of unknown) {
        const html = render(entry);
        assert.equal(/\$|ETH|<a /.test(html), false, html);
        assert.match(text(html), /Earlier version/);
    }
    assert.match(text(render(unknown.find(row => row.kind === 'deposit'))), /Added to private balance/);
    assert.match(text(render(unknown.find(row => row.kind === 'withdrawal'))), /Returned to 0x3434…343434/);
});

test('an amount or fee that is not canonical decimal digits is never printed as a number', () => {
    const base = rowOf({ deposits: [depositRow(LEGACY, 5, {
        feeWei: '2100000000000', gasUsed: '21000', effectiveGasPrice: '100000000',
        fundingAddress: DESTINATION, receiptBlockNumber: 12, receiptBlockHash: hash('b')
    })] }, 'deposit');
    assert.equal(base.amountUnits, '2000000', 'the projection writes canonical digits');
    assert.equal(base.feeWei, '2100000000000');
    const shown = overrides => text(renderHistoryRow({ ...base, ...overrides }, { formatMoney: () => '—' }));
    assert.match(shown({}), /\+0\.002 ETH added to private balance/);
    assert.match(shown({}), /Actual network fee: 0\.0000021 ETH/);
    // BigInt() alone would read each of these as a number.
    for (const bad of ['0x1e8480', '', ' 2000000', '2000000 ', '1e6', '-5', '+5', '002000000', '1.5', '1'.repeat(79)]) {
        assert.match(shown({ amountUnits: bad }), /^Deposit Added to private balance/, `amount ${JSON.stringify(bad)}`);
        assert.doesNotMatch(shown({ feeWei: bad }), /Actual network fee/, `fee ${JSON.stringify(bad)}`);
    }
    assert.match(shown({ amountUnits: '0' }), /\+0 ETH added to private balance/, 'zero is a canonical amount');
});

test('"Open version" appears only when that version is the one the state names and it can be opened', () => {
    const parked = rowOf({ withdrawals: [withdrawalRecord(LEGACY, 5, { phase: 'parked' })] }, 'withdrawal');
    const credit = rowOf({ withdrawals: [withdrawalRecord(LEGACY, 6, { mode: 'escape', phase: 'closed',
        payoutCredited: true, creditedAmount: 5 })] }, 'withdrawal');
    const canOpen = { versionId: 'v1', canOpen: true, openWithdrawals: 1, credits: 0 };

    const open = render(parked, { previous: canOpen });
    assert.match(open, /<button type="button" class="zkapi-secondary-button mt-3 w-full" data-zkapi-history-open="v1" data-zkapi-history-reason="finish_previous">Open version 1<\/button>/);
    assert.match(render(credit, { previous: canOpen }), /data-zkapi-history-reason="claim_credit">Open version 1</);

    // Another version is the named one, the version cannot be opened yet, or
    // there is no state: no button.
    for (const previous of [{ versionId: 'v2', canOpen: true }, { versionId: 'v1', canOpen: false }, null, undefined, {}]) {
        assert.equal(/<button/.test(render(parked, { previous })), false, JSON.stringify(previous));
    }
    // This version's own balance holds the wallet: the reason, not a dead end.
    const held = render(parked, { previous: { versionId: 'v1', canOpen: false }, slotHeld: true });
    assert.match(text(held), /First withdraw or finish the balance on this version, then open version 1\./);
    assert.equal(/<button/.test(held), false);
    // Nothing else is ever offered on a row: not the dialog's actions, not a sync.
    assert.equal(/<button/.test(render(rowOf({ deposits: [depositRow(LEGACY, 5)] }, 'deposit'), { previous: canOpen })), false);
});

test('a version the app can no longer open says so, with no button', () => {
    const previous = { versionId: 'v0', canOpen: true };
    const retired = rowOf({ withdrawals: [withdrawalRecord(RETIRED, 5, { phase: 'parked' })] }, 'withdrawal');
    const retiredCredit = rowOf({ withdrawals: [withdrawalRecord(RETIRED, 6, { mode: 'escape', phase: 'closed',
        payoutCredited: true, creditedAmount: 5_000_000 })] }, 'withdrawal');
    const unknown = rowOf({ withdrawals: [withdrawalRecord(UNKNOWN, 5, { phase: 'parked' })] }, 'withdrawal');
    const unknownCredit = rowOf({ withdrawals: [withdrawalRecord(UNKNOWN, 6, { mode: 'escape', phase: 'closed',
        payoutCredited: true, creditedAmount: 5_000_000 })] }, 'withdrawal');
    for (const row of [retired, retiredCredit, unknown, unknownCredit]) {
        const html = render(row, { previous, slotHeld: true });
        assert.equal(/<button|data-zkapi-history-open/.test(html), false, html);
        assert.match(text(html), /which this app can’t open anymore\./);
    }
    assert.match(text(render(retired)), /Unfinished in version 0, which this app can’t open anymore\. .* Version 0 · retired/);
    assert.match(text(render(unknown)), /Unfinished in an earlier version, which this app can’t open anymore\./);
    assert.match(text(render(retiredCredit)), /A payout of \$10\.00 is waiting in version 0, which this app can’t open anymore\./);
    assert.match(text(render(unknownCredit)), /A payout is waiting in an earlier version, which this app can’t open anymore\./);
});

test('a payout that paid less than expected is reported on its row', () => {
    const row = rowOf({ withdrawals: [withdrawalRecord(CURRENT, 5, { mode: 'escape', phase: 'closed', payoutVerified: true,
        payoutAlert: 'concession_exceeded_bound' })] }, 'withdrawal', 5, { loadedDeploymentId: LEGACY });
    assert.match(text(render(row)), /paid out less than your balance minus your last chat’s budget\. The payment can’t be changed\. Please report it to the service operator\./);
});

test('foreign rows carry no hook the dialog\'s delegated handlers act on, and only escaped text', () => {
    const hostile = '<img src=x onerror=alert(1)>"\'&`';
    const table = TABLE.map(version => (version.id === 'v1' ? { ...version, label: hostile } : version));
    const rows = project({
        deposits: [depositRow(LEGACY, 5), depositRow(LEGACY, 6, { expiryTs: seconds(NOW - DAY) })],
        withdrawals: [
            withdrawalRecord(LEGACY, 7, { phase: 'parked' }),
            withdrawalRecord(LEGACY, 8, { mode: 'escape', phase: 'pending', challengeDeadline: seconds(NOW + DAY) }),
            withdrawalRecord(LEGACY, 9, { mode: 'escape', phase: 'closed', payoutCredited: true, creditedAmount: 5 }),
            withdrawalRecord(LEGACY, 10, { phase: 'closed', payoutVerified: true, transactionHash: hash('c') }),
            withdrawalRecord(LEGACY, 11, { phase: 'closed_unconfirmed', payoutVerified: true }),
            withdrawalRecord(LEGACY, 12, { phase: 'ambiguous', finalizeSubmissionId: 'x' }),
            withdrawalRecord(LEGACY, 13, { mode: 'escape', phase: 'restored', deviceNotNewest: true })
        ]
    }, { table }).rows;
    // ... and the line a cut list ends with.
    rows.push(...project({
        withdrawals: Array.from({ length: HISTORY_ROW_LIMIT + 1 }, (_, index) => withdrawalRecord(LEGACY, 5000 + index, {
            phase: 'closed', payoutVerified: true, createdAt: NOW - (index + 1) * 60_000
        }))
    }, { table, loadedDeploymentId: RETIRED }).rows.filter(row => row.kind === 'omitted'));
    assert.ok(rows.some(row => row.deviceNotNewest === true));
    const kinds = new Set(rows.map(row => `${row.kind}`));
    assert.deepEqual([...kinds].sort(), ['deposit', 'expiry', 'omitted', 'withdrawal']);
    const ctx = {
        formatMoney: () => hostile, dateText: () => hostile, now: NOW, slotHeld: false,
        previous: { versionId: 'v1', canOpen: true },
        txUrl: (hashText) => `https://explorer.test/tx/${hashText}?a="onmouseover="x`
    };
    const forbidden = /data-sync-withdrawal|data-finalize-withdrawal|data-withdraw-background|data-restore-withdrawal|data-retry-|data-recover-finalization|data-resolve-challenged|data-cancel-background-preparation|data-view-current-deposit|data-sync-late-withdrawal|zkapi-sync-all-withdrawals-btn|zkapi-check-expiry-payments-btn|zkapi-add-new-balance-btn|zkapi-back-balance-btn|data-withdrawal-record|data-deposit-record|data-expiry-record|id="/;
    const allowedData = new Set(['data-other-version-record', 'data-zkapi-history-version', 'data-zkapi-history-open',
        'data-zkapi-history-reason', 'data-zkapi-history-omitted']);
    for (const item of renderHistoryItems(rows, ctx)) {
        assert.equal(forbidden.test(item.html), false, item.html);
        for (const [, name] of item.html.matchAll(/\s(data-[a-z-]+)=/g)) assert.ok(allowedData.has(name), name);
        for (const [, tag] of item.html.matchAll(/<([a-z]+)/g)) assert.ok(['section', 'div', 'p', 'span', 'a', 'button'].includes(tag), tag);
        // Hostile text is escaped wherever it lands: no raw tag, quote or ampersand.
        assert.equal(/<img|&(?!amp;|lt;|gt;|quot;|#39;|#96;)/.test(item.html), false, item.html);
        assert.equal(/"onmouseover=/.test(item.html), false);
        for (const [, href] of item.html.matchAll(/href="([^"]*)"/g)) assert.match(href, /^https:\/\//);
    }
    // A link that is not https never reaches the page.
    const returned = rows.find(row => row.noteId === 10);
    assert.equal(/<a /.test(renderHistoryRow(returned, { txUrl: () => 'javascript:alert(1)' })), false);
    assert.equal(/<a /.test(renderHistoryRow(returned, { txUrl: () => 'http://plain.test/' })), false);
    assert.equal(/<a /.test(renderHistoryRow(returned, {})), false);
});

test('items are {key, at, html}, newest first as given, with expiry rows read at ctx.now', () => {
    const rows = project({ deposits: [depositRow(LEGACY, 5, { expiryTs: seconds(NOW + DAY) })] }).rows;
    const items = renderHistoryItems(rows, { formatMoney: usd, now: NOW });
    assert.deepEqual(items.map(item => Object.keys(item).sort()), [['at', 'html', 'key']]);
    assert.equal(items[0].key, 'v1:deposit:5');
    assert.equal(items[0].at, NOW - 60 * DAY + 90_000);
    const later = renderHistoryItems(rows, { formatMoney: usd, now: NOW + 2 * DAY });
    assert.deepEqual(later.map(item => item.key), ['v1:expiry:5', 'v1:deposit:5']);
    assert.equal(later[0].at, seconds(NOW + DAY) * 1000);
    assert.deepEqual(renderHistoryItems(null, {}), []);
    assert.deepEqual(renderHistoryItems([{ kind: 'nonsense', key: 'x' }, null, 4], {}), []);
    assert.deepEqual(renderHistoryItems(rows, null).length, 1);
    assert.equal(renderHistoryRow(null), '');
});

test('the signature changes when rendered rows would, and on a crossed deadline, not on time passing', () => {
    const expiryTs = seconds(NOW + 2 * DAY);
    const rows = project({
        deposits: [depositRow(LEGACY, 5, { expiryTs })],
        withdrawals: [withdrawalRecord(LEGACY, 6, { phase: 'parked' })]
    }).rows;
    const base = historySignature(rows, NOW);
    assert.equal(typeof base, 'string');
    // Time that passes without crossing a deadline is not a change.
    for (const offset of [0, 1000, 60_000, DAY]) assert.equal(historySignature(rows, NOW + offset), base);
    assert.equal(historySignature(rows, undefined), base);
    // Crossing the deadline is, once.
    const crossed = historySignature(rows, NOW + 3 * DAY);
    assert.notEqual(crossed, base);
    assert.equal(historySignature(rows, NOW + 30 * DAY), crossed);
    // A re-read that changes a row is a change; an identical re-read is not.
    const same = project({
        deposits: [depositRow(LEGACY, 5, { expiryTs })], withdrawals: [withdrawalRecord(LEGACY, 6, { phase: 'parked' })]
    }).rows;
    assert.equal(historySignature(same, NOW), base);
    const changed = project({
        deposits: [depositRow(LEGACY, 5, { expiryTs })],
        withdrawals: [withdrawalRecord(LEGACY, 6, { phase: 'closed', payoutVerified: true })]
    }).rows;
    assert.notEqual(historySignature(changed, NOW), base);
    // Once the re-read has the expiry row itself, the signature carries it.
    const reread = project({ deposits: [depositRow(LEGACY, 5, { expiryTs })], withdrawals: [withdrawalRecord(LEGACY, 6, { phase: 'parked' })] },
        { nowMs: NOW + 3 * DAY }).rows;
    assert.ok(reread.some(row => row.kind === 'expiry'));
    assert.equal(historySignature([], NOW), '0:811c9dc5'.replace('811c9dc5', (0x811c9dc5).toString(36)));
    assert.equal(historySignature(null, NOW), '0:0');
    // No exact balance, no ticking time, no secret in the string.
    assert.match(base, /^\d+:[0-9a-z]+$/);
});

test('a row counted in another unit is never priced by the loaded SDK\'s formatter', () => {
    const szabo = Object.freeze({ asset: 'native_eth', unit: 'szabo', perEth: 1e6 });
    // `note-bound-v1` rows count in szabo here; the loaded version counts in gwei.
    const adapterFor = id => (id === 'note-bound-v1' ? { billing: szabo } : getAdapter(id));
    const claim = { transactionHash: hash('f'), blockHash: hash('9'), blockNumber: 777, claimedAt: NOW - 9 * DAY, amount: 2_000 };
    const expiryTs = seconds(NOW - 10 * DAY);
    const raw = {
        deposits: [depositRow(LEGACY, 5, { amount: 2_000 }), depositRow(LEGACY, 7, { amount: 2_000, expiryTs, expiryClaim: claim })],
        withdrawals: [
            withdrawalRecord(LEGACY, 6, { mode: 'mutual', phase: 'closed', payoutVerified: true, finalBalance: 1_900 }),
            withdrawalRecord(LEGACY, 8, { mode: 'mutual', phase: 'parked', finalBalance: 1_900 }),
            withdrawalRecord(RETIRED, 9, { mode: 'escape', phase: 'closed', payoutCredited: true, creditedAmount: 800 })
        ]
    };
    const rows = project(raw, { adapterFor }).rows;
    assert.equal(rows.length >= 5, true);
    const asked = [];
    const formatMoney = units => { asked.push(units); return `$${(Number(units) / 1e9 * 2000).toFixed(2)}`; };
    const words = Object.fromEntries(rows.map(row => [row.key, text(render(row, { formatMoney }))]));

    assert.deepEqual(asked, [], 'the loaded formatter is never asked about an amount of another unit');
    assert.match(words['v1:deposit:5'], /\+0\.002 ETH added to private balance/);
    assert.match(words['v1:withdrawal:6'], /0\.0019 ETH returned to/);
    assert.match(words['v1:withdrawal:8'], /0\.0019 ETH set aside/);
    assert.match(words['v1:expiry:7'], /0\.002 ETH from the original deposit was paid to the service treasury/);
    assert.match(words['v0:withdrawal:9'], /A payout of 0\.0008 ETH is waiting/);
    // What the formatter would have printed had it been asked: $0.004, off by 1000.
    assert.equal(Object.values(words).some(entry => /\$/.test(entry)), false);

    // The same unit name counted at another number of units per ETH is another
    // unit: it is read in its own, not priced as if it were gwei.
    asked.length = 0;
    const named = project({ deposits: [depositRow(LEGACY, 5, { amount: 2_000 })] }, {
        adapterFor: id => (id === 'note-bound-v1' ? { billing: { asset: 'native_eth', unit: 'gwei', perEth: 1e6 } } : getAdapter(id))
    }).rows;
    assert.match(text(render(named[0], { formatMoney })), /\+0\.002 ETH added to private balance/);
    assert.deepEqual(asked, []);

    // The same records in the loaded unit are priced by the loaded formatter.
    const same = project(raw).rows;
    const pricedWords = Object.fromEntries(same.map(row => [row.key, text(render(row, { formatMoney }))]));
    assert.match(pricedWords['v1:deposit:5'], /\+\$0\.00 added to private balance/);
    assert.deepEqual([...new Set(asked)].sort(), ['1900', '2000', '800']);
});

test('amounts of a unit that is not an amount of ETH, or not a known power of ten, are not shown', () => {
    const base = rowOf({ deposits: [depositRow(LEGACY, 5, { amount: 2_000_000 })] }, 'deposit');
    const withUnit = (billing, sameUnitAsLoaded = false) => ({ ...base, version: { ...base.version, billing, sameUnitAsLoaded } });
    const formatMoney = () => assert.fail('no formatter is asked for an amount that is not known');
    assert.match(text(render(withUnit({ asset: 'native_eth', unit: 'wei', perEth: 1e18 }))), /\+0\.000000000002 ETH added/);
    assert.match(text(render(withUnit({ asset: 'native_eth', unit: 'ether', perEth: 1 }))), /\+2000000 ETH added/);
    for (const billing of [{ asset: 'erc20', unit: 'gwei', perEth: 1e9 }, { asset: 'native_eth', unit: 'x', perEth: 3 },
        { asset: 'native_eth', unit: 'x', perEth: 1e19 }, { asset: 'native_eth', unit: 'x', perEth: '1e9' }, null]) {
        // Not even when the row says it is the loaded unit.
        for (const sameUnitAsLoaded of [false, true]) {
            const html = renderHistoryRow(withUnit(billing, sameUnitAsLoaded), { formatMoney });
            assert.match(text(html), /^Deposit Added to private balance /, JSON.stringify(billing));
            assert.equal(/ETH|\$/.test(html), false);
        }
    }
    // A row that is the loaded unit but whose price the formatter does not
    // have reads in ETH, from its own unit.
    assert.match(text(renderHistoryRow(withUnit({ asset: 'native_eth', unit: 'gwei', perEth: 1e9 }, true),
        { formatMoney: () => '—' })), /\+0\.002 ETH added/);
});

test('a balance another device used reads as such: no "finish it there", no button, no promise to finalize', () => {
    const flagged = (changes = {}, loadedDeploymentId = CURRENT) => rowOf({ withdrawals: [withdrawalRecord(LEGACY, 5, {
        mode: 'escape', phase: 'restored', deviceNotNewest: true, ...changes })] }, 'withdrawal', 5, { loadedDeploymentId });
    const row = flagged();
    assert.equal(row.deviceNotNewest, true);
    const everyWay = [
        {}, { previous: { versionId: 'v1', canOpen: true } }, { previous: { versionId: 'v1', canOpen: false } },
        { slotHeld: true, previous: { versionId: 'v1', canOpen: true } }, { previous: null }
    ];
    for (const ctx of everyWay) {
        const html = render(row, ctx);
        assert.equal(/<button|data-zkapi-history-open|data-zkapi-history-reason/.test(html), false, JSON.stringify(ctx));
        assert.equal(/Finish it there|Unfinished in/.test(text(html)), false, JSON.stringify(ctx));
        assert.match(text(html), /^Withdrawal · Emergency exit This balance was used on another device, so this browser can’t safely continue this withdrawal\. Open version 1 to see where it stands\. /);
        assert.match(text(html), /Used on another device Version 1/);
        assert.match(text(html), /\$3\.80 set aside · to 0x3434…343434/);
    }
    // The reason a version cannot be opened yet is still given.
    assert.match(text(render(row, { slotHeld: true, previous: { versionId: 'v1', canOpen: false } })),
        /First withdraw or finish the balance on this version, then open version 1\./);
    assert.equal(/First withdraw/.test(text(render(row, { slotHeld: true, previous: { versionId: 'v1', canOpen: true } }))), false);

    // It does not promise a finalization date either.
    const pending = flagged({ phase: 'pending', challengeDeadline: seconds(NOW + DAY) });
    assert.equal(pending.deviceNotNewest, true);
    assert.equal(/Can be finalized/.test(text(render(pending))), false);
    assert.match(text(render(flagged({ phase: 'parked', mode: 'mutual' }))), /^Withdrawal This balance was used on another device/);

    // A version this app cannot open says that instead of "open".
    const retired = rowOf({ withdrawals: [withdrawalRecord(RETIRED, 5, { mode: 'escape', phase: 'restored', deviceNotNewest: true })] }, 'withdrawal');
    const unknown = rowOf({ withdrawals: [withdrawalRecord(UNKNOWN, 5, { mode: 'escape', phase: 'restored', challengeObserved: true })] }, 'withdrawal');
    assert.match(text(render(retired, { previous: { versionId: 'v0', canOpen: true }, slotHeld: true })),
        /continue this withdrawal in version 0, which this app can’t open anymore\./);
    assert.match(text(render(unknown, { slotHeld: true })), /continue this withdrawal in an earlier version, which this app can’t open anymore\./);
    for (const entry of [retired, unknown]) assert.equal(/<button|Open |First withdraw/.test(render(entry, { slotHeld: true, previous: { versionId: 'v0', canOpen: true } })), false);

    // The same record without the flag is the ordinary row, with its button.
    const ordinary = flagged({ deviceNotNewest: undefined, challengeEvidence: undefined });
    assert.equal(ordinary.deviceNotNewest, false);
    const open = render(ordinary, { previous: { versionId: 'v1', canOpen: true } });
    assert.match(text(open), /Unfinished in version 1\. Finish it there\./);
    assert.match(open, /data-zkapi-history-open="v1" data-zkapi-history-reason="finish_previous"/);

    // A row that is closed is never read as one the device cannot continue,
    // whatever a hand-built row says.
    const credit = rowOf({ withdrawals: [withdrawalRecord(CURRENT, 6, { mode: 'escape', phase: 'closed',
        payoutCredited: true, creditedAmount: 800_000, deviceNotNewest: true })] }, 'withdrawal', 6, { loadedDeploymentId: LEGACY });
    assert.equal(credit.deviceNotNewest, false);
    assert.match(text(render({ ...credit, deviceNotNewest: true })), /^Payout held A payout of \$1\.60 is waiting\. Claim it in version 2\./);
});

test('a cut list ends with one quiet line, with no date, no hook and no way to ask for more', () => {
    const closed = Array.from({ length: HISTORY_ROW_LIMIT + 3 }, (_, index) => withdrawalRecord(LEGACY, 1000 + index, {
        phase: 'closed', payoutVerified: true, createdAt: NOW - (index + 1) * 60_000
    }));
    const result = project({ withdrawals: closed }, { loadedDeploymentId: RETIRED });
    assert.equal(result.truncated, true);
    const items = renderHistoryItems(result.rows, { formatMoney: usd, now: NOW, previous: { versionId: 'v1', canOpen: true } });
    assert.equal(items.length, HISTORY_ROW_LIMIT + 1);
    const last = items.at(-1);
    assert.deepEqual({ key: last.key, at: last.at }, { key: 'history:omitted', at: 0 });
    assert.equal(text(last.html), HISTORY_WORDS.omitted);
    assert.match(last.html, /^<section class="rounded-lg border border-border bg-muted\/20 p-3" data-zkapi-history-omitted="true">/);
    // It is a line, not a payment row: no hook that stands for one payment.
    assert.equal(/data-other-version-record|data-zkapi-history-(?:version|open|reason)|<button|<a |Date unavailable/.test(last.html),
        false, last.html);
    // And every payment row is still exactly one payment.
    const records = items.filter(item => /data-other-version-record=/.test(item.html));
    assert.equal(records.length, HISTORY_ROW_LIMIT);
    assert.equal(records.every(item => /data-other-version-record="v1:withdrawal:\d+"/.test(item.html)), true);
    assert.equal(items.filter(item => item.key === 'history:omitted').length, 1);
    // Nothing is said when nothing was cut.
    const whole = renderHistoryItems(project({ withdrawals: closed.slice(0, HISTORY_ROW_LIMIT) }, { loadedDeploymentId: RETIRED }).rows,
        { formatMoney: usd, now: NOW });
    assert.equal(whole.some(item => item.key === 'history:omitted'), false);
    assert.equal(whole.some(item => text(item.html).includes(HISTORY_WORDS.omitted)), false);
    // And the markup of the other rows is what it was.
    assert.equal(items[0].html, whole[0].html);
});

test('the signature also moves when only a row\'s device flag, its unit, or the cut line changes', () => {
    const signatureOf = (raw, options) => historySignature(project(raw, options).rows, NOW);
    const parked = changes => ({ withdrawals: [withdrawalRecord(LEGACY, 5, { mode: 'escape', phase: 'restored', ...changes })] });
    const base = signatureOf(parked({ deviceNotNewest: undefined, challengeEvidence: undefined }), { loadedDeploymentId: CURRENT });
    assert.notEqual(signatureOf(parked({ deviceNotNewest: true }), { loadedDeploymentId: CURRENT }), base,
        'the same record, now found "not newest", renders differently');

    // Two rows alike in everything but which note they are: the markup names
    // the row, so the signature tells them apart.
    const parkedNote = noteId => ({ withdrawals: [withdrawalRecord(LEGACY, noteId, { phase: 'parked' })] });
    assert.notEqual(signatureOf(parkedNote(5), { loadedDeploymentId: CURRENT }),
        signatureOf(parkedNote(6), { loadedDeploymentId: CURRENT }));
    // And the same row read twice is not a change.
    assert.equal(signatureOf(parkedNote(5), { loadedDeploymentId: CURRENT }),
        signatureOf(parkedNote(5), { loadedDeploymentId: CURRENT }));

    // The same amounts, now counted in a unit that is not the loaded one.
    const szabo = { asset: 'native_eth', unit: 'szabo', perEth: 1e6 };
    const deposits = { deposits: [depositRow(LEGACY, 5)] };
    const sameUnit = signatureOf(deposits, { loadedDeploymentId: CURRENT });
    const otherUnit = signatureOf(deposits, {
        loadedDeploymentId: CURRENT, adapterFor: id => (id === 'concession-v1' ? { billing: szabo } : getAdapter(id))
    });
    assert.notEqual(otherUnit, sameUnit);

    // A list that was cut.
    const closed = count => ({ withdrawals: Array.from({ length: count }, (_, index) => withdrawalRecord(LEGACY, 1000 + index, {
        phase: 'closed', payoutVerified: true, createdAt: NOW - (index + 1) * 60_000
    })) });
    const whole = project(closed(HISTORY_ROW_LIMIT), { loadedDeploymentId: RETIRED }).rows;
    const cut = project(closed(HISTORY_ROW_LIMIT + 1), { loadedDeploymentId: RETIRED }).rows;
    assert.equal(cut.length, whole.length + 1, 'one more stored, the same shown, and the line');
    assert.notEqual(historySignature(cut, NOW), historySignature(whole, NOW));
});

test('real version tables label rows the same way (resolveRuntimeTable output, three versions)', () => {
    const table = resolvedTable(threeVersionRegistry(), 'sepolia');
    const [v1, v2, v3] = table;
    const result = projectOtherHistory({
        deposits: [depositRow(v1.deploymentId, 1), depositRow(v2.deploymentId, 1), depositRow(v3.deploymentId, 1)],
        withdrawals: []
    }, { table, loadedDeploymentId: v3.deploymentId, nowMs: NOW });
    assert.deepEqual(result.rows.map(row => [row.version.versionId, row.version.status]).sort(),
        [['v1', 'exit-only'], ['v2', 'exit-only']]);
    for (const row of result.rows) {
        assert.deepEqual({ ...row.version.billing }, { asset: 'native_eth', unit: 'gwei', perEth: 1e9 });
        assert.equal(row.version.sameUnitAsLoaded, true);
    }
});

// ------------------------------------------------------- words and styling

test('vocabulary: calm plain words, curly apostrophes, no jargon, no unit words in the templates', () => {
    const forbidden = /nullifier|vault|circuit|deployment|manifest|\bnotes?\b|note\s*#|#\s*\d|unlinkable|untraceable|anonymous|zero.knowledge|proof\b|escape hatch|mutual close|sync|reconcil|check status|confirmation continues/i;
    const values = { amount: '$4.00', destination: '0x3434…343434', version: 'version 1', fee: '0.0000021 ETH',
        date: 'Nov 15, 2026', label: 'Version 1' };
    // The words of the rows added for a balance another device used and for a
    // cut list are in the table the sweep below walks.
    for (const key of ['deviceUsed', 'deviceUsedUnopenable', 'deviceBadge', 'omitted']) {
        assert.equal(typeof HISTORY_WORDS[key], 'string', key);
    }
    for (const [key, template] of Object.entries(HISTORY_WORDS)) {
        assert.equal(typeof template, 'string', key);
        assert.equal(forbidden.test(template), false, `${key}: ${template}`);
        assert.equal(/!/.test(template), false, `${key}: exclamation`);
        assert.equal(/'/.test(template), false, `${key}: straight apostrophe`);
        assert.equal(/\p{Extended_Pictographic}/u.test(template), false, `${key}: emoji`);
        assert.equal(/\b[A-Z]{3,}\b/.test(template), false, `${key}: unit or shouting word in a template`);
        assert.equal(/[<>&"]/.test(template), false, `${key}: markup`);
        assert.equal(/\s{2,}|\s[.,;:]/.test(template), false, `${key}: spacing`);
        const filled = template.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? assert.fail(`${key}: unknown token ${name}`));
        assert.equal(filled, filled.trim(), key);
        for (const sentence of filled.split(/(?<=[.?])\s+/)) {
            assert.match(sentence, /^(?:[A-Z0-9+$]|0x|version|an earlier|your)/, `${key}: "${sentence}"`);
        }
        // The two sentences that name a version never end on a bare preposition.
        assert.equal(/\b(?:to|into|from|on|in|by|until|before|of)\s*[.,;:?]?$/.test(filled.replace(/\.$/, '')), false, key);
    }
    // And the same of everything the renderers actually produce.
    const everything = rowsFor({
        deposits: [depositRow(LEGACY, 5, { expiryTs: seconds(NOW - DAY) }), depositRow(UNKNOWN, 5)],
        withdrawals: [
            withdrawalRecord(LEGACY, 6, { phase: 'parked' }),
            withdrawalRecord(LEGACY, 7, { phase: 'closed', payoutVerified: true }),
            withdrawalRecord(LEGACY, 8, { phase: 'closed' }),
            withdrawalRecord(LEGACY, 9, { mode: 'escape', phase: 'closed', payoutCredited: true, creditedAmount: 4, payoutAlert: 'concession_exceeded_bound' }),
            withdrawalRecord(RETIRED, 6, { phase: 'parked' }),
            withdrawalRecord(UNKNOWN, 7, { mode: 'escape', phase: 'closed', payoutCredited: true }),
            withdrawalRecord(LEGACY, 10, { mode: 'escape', phase: 'restored', deviceNotNewest: true }),
            withdrawalRecord(RETIRED, 11, { mode: 'escape', phase: 'restored', deviceNotNewest: true }),
            withdrawalRecord(UNKNOWN, 12, { mode: 'escape', phase: 'restored', challengeObserved: true })
        ]
    });
    everything.push(...project({
        withdrawals: Array.from({ length: HISTORY_ROW_LIMIT + 1 }, (_, index) => withdrawalRecord(LEGACY, 4000 + index, {
            phase: 'closed', payoutVerified: true, createdAt: NOW - (index + 1) * 60_000
        }))
    }, { loadedDeploymentId: RETIRED }).rows.filter(row => row.kind === 'omitted'));
    assert.ok(everything.length >= 12);
    assert.ok(everything.some(row => row.deviceNotNewest === true) && everything.some(row => row.kind === 'omitted'));
    for (const variant of [{ previous: { versionId: 'v1', canOpen: true } }, { slotHeld: true }, {}]) {
        for (const item of renderHistoryItems(everything, { formatMoney: usd, now: NOW, ...variant })) {
            const words = text(item.html);
            assert.equal(forbidden.test(words), false, words);
            assert.equal(/'/.test(words), false, words);
            assert.equal(/!/.test(words), false, words);
        }
    }
});

test('styling: only utilities and classes the app already ships', () => {
    const css = ['chat/tailwind.generated.css', 'chat/zkapi/zkapi.css', 'chat/styles.css']
        .map(file => fs.readFileSync(path.join(repoRoot, file), 'utf8')).join('\n');
    const escape = name => name.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
    const rows = rowsFor({
        deposits: [depositRow(LEGACY, 5, { feeWei: '1' })],
        withdrawals: [withdrawalRecord(LEGACY, 6, { phase: 'parked', mode: 'escape' }),
            withdrawalRecord(LEGACY, 7, { phase: 'closed', payoutVerified: true, transactionHash: hash('c') }),
            withdrawalRecord(LEGACY, 8, { phase: 'restored', mode: 'escape', deviceNotNewest: true })]
    });
    rows.push(...project({
        withdrawals: Array.from({ length: HISTORY_ROW_LIMIT + 1 }, (_, index) => withdrawalRecord(LEGACY, 6000 + index, {
            phase: 'closed', payoutVerified: true, createdAt: NOW - (index + 1) * 60_000
        }))
    }, { loadedDeploymentId: RETIRED }).rows.filter(row => row.kind === 'omitted'));
    const used = new Set();
    for (const item of renderHistoryItems(rows, { formatMoney: usd, now: NOW + 99 * DAY, previous: { versionId: 'v1', canOpen: true },
        txUrl: () => 'https://x.test/' })) {
        for (const [, classes] of item.html.matchAll(/class="([^"]*)"/g)) classes.split(/\s+/).filter(Boolean).forEach(name => used.add(name));
    }
    assert.ok(used.size > 20);
    for (const name of used) {
        const selector = `.${escape(name)}`;
        const present = [' ', ',', '{', ':', '\n', '.', '>'].some(next => css.includes(selector + next));
        assert.ok(present, `class "${name}" is in no stylesheet the app ships`);
    }
});
