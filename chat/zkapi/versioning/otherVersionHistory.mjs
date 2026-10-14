// Payment history of the protocol versions this build did not load
// (docs/ZKAPI_VERSIONING.md, "5.4 The shared wallet database").
//
// Why the host reads it. Every list a loaded SDK builds (deposits,
// withdrawals, expiry history) is filtered by that SDK's own deployment id, so
// the records of every other version sit in the shared wallet database and are
// shown by no build. No SDK read can serve them either: the unfiltered
// `readBrowserWalletSnapshot(null)` WRITES (it back-fills deposit rows), and
// an SDK build is only available after the version choice. This module reads
// the database itself, and only reads it:
//
//   readOtherVersionHistory  versionless open that can never create or
//                            upgrade anything, ONE readonly transaction over
//                            the deposit and withdrawal stores, bounded by a
//                            deadline, connection closed before returning.
//                            Never reads the runtime slot (note secrets,
//                            plans, journals) or the archives (note states,
//                            and the request journals and evidence of newer
//                            SDKs, which hold proofs): nothing shown comes
//                            from them, so none of it is loaded. The stores
//                            are read with a cursor and each stored record is
//                            reduced through the allowlist as it arrives, so
//                            no more than one raw record (note state, plan,
//                            proof) is ever held, never the whole store.
//   projectOtherHistory      pure. Raw stored records in, display rows out, by
//                            an explicit allowlist (below). The raw records
//                            hold private state; only the rows leave.
//   deriveExpiryRecords      pure port of the SDK's zkapiExpiryHistory.mjs
//                            (the newer rule: a credited escape closed the
//                            note too).
//   rowsAt                   the rows as they read at a moment: expiry rows
//                            appear when a deadline passes without a re-read.
//
// Amounts are in the unit of the ROW's own version (its adapter's `billing`).
// A row says whether that is the very unit the loaded SDK's money formatter
// reads (`version.sameUnitAsLoaded`); only then may a dollar figure come from
// that formatter, so a version that counts in another unit can never be
// priced as if it counted in the loaded one.
//
// Deposit back-fill is NOT ported. Both SDKs back-fill deposit rows from the
// notes they find on every read of their own deployment, so a deployment that
// was ever loaded has its rows; a note whose deployment was never loaded by a
// build that writes deposit rows has no row here.
//
// No SDK import. Results are memory-only: note ids, destinations and hashes tie
// this browser to public notes, so callers must never log them, put them in a
// URL or send them anywhere. Rows are frozen and carry no action: another
// deployment's note ids repeat across vaults, so a row must never be able to
// start an operation on the loaded one.
import { versionForDeployment } from './registryModel.mjs';
import { getAdapter } from './adapters/index.mjs';
import {
    createDeadline, getFactory, isOpenWithdrawalRecord, isUnclaimedPayoutCredit, openExistingDatabase, requestResult,
    transactionComplete
} from './walletHoldings.mjs';

// The store names of the SDK's wallet database (sdk/services/browserWalletStore.js).
// The drift test reads them back from a database written by every installed
// store.
const WITHDRAWAL_STORE = 'withdrawals';
const DEPOSIT_STORE = 'deposits';

/**
 * Rows kept per kind (deposit, withdrawal, expiry), newest first. A
 * withdrawal row that needs attention (open, an unclaimed credit, an alert)
 * is kept whatever its age and counts toward the limit first.
 */
export const HISTORY_ROW_LIMIT = 100;
/** The read deadline, in milliseconds. */
export const HISTORY_READ_TIMEOUT_MS = 2000;
/** What a deployment this build has no table row for is called. */
export const UNKNOWN_VERSION_LABEL = 'Earlier version';

/**
 * The stored deposit-row fields this module reads, and those it knows and
 * deliberately does not use. A field of a stored row in neither list is one a
 * newer SDK added: the drift guard in test/zkapi/zkapi-other-version-history
 * fails until it is classified here.
 */
export const DEPOSIT_ROW_FIELDS = Object.freeze({
    read: Object.freeze([
        'deploymentId', 'noteId', 'amount', 'expiryTs', 'status', 'createdAt', 'confirmedAt', 'transactionHash',
        'expiryClaim', 'feeWei', 'gasUsed', 'effectiveGasPrice', 'fundingAddress', 'receiptBlockNumber',
        'receiptBlockHash'
    ]),
    ignored: Object.freeze(['recordId', 'type', 'operationId'])
});

/**
 * The stored withdrawal-record fields this module reads, by name. Everything
 * else on a record (the note state with its secret, the prepared plan and its
 * proof, the withdrawal nullifier, challenge evidence, the exit lock, every
 * submission id, owner and nonce, attempts and error text) is never read, and
 * a field a newer SDK adds is ignored until someone adds it here.
 * `finalizeTransactionHash(es)` and `finalizeSubmissionId` are read only for
 * the open/closed rule and the transaction link the SDK's own list shows.
 * `deviceNotNewest` and `challengeObserved` are read as booleans and nothing
 * else: they are the two names under which a build records that another
 * device used the balance's next state, and the challenge evidence stored
 * beside them is never read.
 */
export const WITHDRAWAL_RECORD_FIELDS = Object.freeze([
    'deploymentId', 'chainId', 'noteId', 'mode', 'phase', 'chainStatus', 'destination', 'finalBalance',
    'challengeDeadline', 'transactionHash', 'startBlockNumber', 'finalizedBlockNumber', 'createdAt', 'updatedAt',
    'payoutVerified', 'payoutCredited', 'creditedAmount', 'payoutClaimed', 'payoutAlert',
    'finalizeTransactionHash', 'finalizeTransactionHashes', 'finalizeSubmissionId',
    'deviceNotNewest', 'challengeObserved'
]);

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const FEE_DECIMAL = /^[1-9][0-9]{0,77}$/;
const PHASE = /^[a-z][a-z0-9_]{0,39}$/;
const CLOSED_PHASES = Object.freeze(['closed', 'closed_unconfirmed']);
const VERSION_STATUSES = Object.freeze(['active', 'exit-only', 'retired']);
// The only alert value a record carries today; anything else is not shown.
const PAYOUT_ALERT = 'concession_exceeded_bound';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * How many decimal places a billing unit has per ETH: `perEth` must be an
 * exact power of ten from 1 (whole ETH) to 1e18 (wei), else null. Not a
 * safe-integer test: 1e18 is exactly representable but not "safe", and a
 * unit finer than gwei is precisely the case this module must keep apart.
 */
export function billingDecimals(perEth) {
    if (typeof perEth !== 'number' || !Number.isFinite(perEth) || perEth < 1) return null;
    const decimals = Math.round(Math.log10(perEth));
    return decimals >= 0 && decimals <= 18 && 10 ** decimals === perEth ? decimals : null;
}

function coded(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
}

// A number or a decimal string, as a safe integer; null otherwise.
//
// Not the display-side amount text of the other modules (a decimal string, up
// to 30 digits, leading zeros read as the number they spell): a stored record
// is read the way the SDK's own store reads it, where an amount is a JS safe
// integer, so a value that would not be exact as a number is refused here
// rather than rounded, and text that is not exactly canonical digits ('007',
// '+7', '1e3') is no amount at all. The rows then print `String(number)`.
function integerValue(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
    if (typeof value === 'string' && DECIMAL.test(value)) {
        const number = Number(value);
        return Number.isSafeInteger(number) ? number : null;
    }
    return null;
}

const positiveInteger = value => {
    const number = integerValue(value);
    return number !== null && number > 0 ? number : null;
};

const hashText = value => (typeof value === 'string' && HASH.test(value) ? value.toLowerCase() : null);

// A block height as the SDK compares it: a number only.
const blockNumber = value => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

// ---------------------------------------------------------------------------
// Deposit rows: the SDK's depositRecord allowlist, ported
// ---------------------------------------------------------------------------

function sanitizedExpiryClaim(claim, amount, expiryTs) {
    if (!isRecord(claim) || !expiryTs || Number(claim.amount) !== amount
        || !HASH.test(claim.transactionHash || '') || !HASH.test(claim.blockHash || '')
        || !positiveInteger(claim.blockNumber) || !positiveInteger(claim.claimedAt)
        || Number(claim.claimedAt) < expiryTs * 1000) return null;
    return {
        transactionHash: claim.transactionHash.toLowerCase(),
        blockHash: claim.blockHash.toLowerCase(),
        blockNumber: Number(claim.blockNumber),
        claimedAt: Number(claim.claimedAt),
        amount
    };
}

// The receipt fee, only when the whole receipt set is consistent (the SDK's
// own rule), so a half-recorded receipt never prints a made-up fee.
function sanitizedFeeWei(row) {
    if (!HASH.test(row.transactionHash || '') || !ADDRESS.test(row.fundingAddress || '')
        || !HASH.test(row.receiptBlockHash || '') || !positiveInteger(row.receiptBlockNumber)
        || !['feeWei', 'gasUsed', 'effectiveGasPrice'].every(key =>
            typeof row[key] === 'string' && FEE_DECIMAL.test(row[key]))) return null;
    try {
        return BigInt(row.feeWei) === BigInt(row.gasUsed) * BigInt(row.effectiveGasPrice) ? row.feeWei : null;
    } catch {
        return null;
    }
}

// One stored deposit row as the SDK's depositRecordMap would sanitize it, or
// null. Only confirmed rows are stored; pending and failed attempts are
// projected from the runtime slot by the SDK and are not history of another
// version.
function depositFrom(row) {
    if (!isRecord(row) || row.status !== 'confirmed') return null;
    const deploymentId = typeof row.deploymentId === 'string' && row.deploymentId ? row.deploymentId : null;
    const noteId = integerValue(row.noteId);
    const amount = positiveInteger(row.amount);
    if (!deploymentId || noteId === null || amount === null) return null;
    const expiryTs = positiveInteger(row.expiryTs);
    const expiryClaim = sanitizedExpiryClaim(row.expiryClaim, amount, expiryTs);
    return {
        recordId: `${deploymentId}:deposit:${noteId}`,
        deploymentId,
        noteId,
        amount,
        expiryTs,
        status: 'confirmed',
        createdAt: positiveInteger(row.createdAt),
        confirmedAt: positiveInteger(row.confirmedAt),
        transactionHash: hashText(row.transactionHash),
        feeWei: sanitizedFeeWei(row),
        ...(expiryClaim ? { expiryClaim } : {})
    };
}

// ---------------------------------------------------------------------------
// Withdrawal records: an allowlist projection
// ---------------------------------------------------------------------------

function withdrawalFrom(record) {
    if (!isRecord(record)) return null;
    const noteId = integerValue(record.noteId);
    if (noteId === null) return null;
    const mode = record.mode === 'escape' || record.mode === 'mutual' ? record.mode : null;
    // What the SDK's own list links: an escape's initial transaction only
    // starts its wait, so the link is the finalization; a mutual close links
    // its one transaction. A closed record's finalize hashes are removed by
    // the store's own sanitizing, so a closed escape usually has none.
    const transactionHash = mode === 'escape' ? hashText(record.finalizeTransactionHash)
        : hashText(record.transactionHash);
    return {
        deploymentId: typeof record.deploymentId === 'string' && record.deploymentId ? record.deploymentId : null,
        chainId: positiveInteger(record.chainId),
        noteId,
        mode,
        phase: typeof record.phase === 'string' && PHASE.test(record.phase) ? record.phase : null,
        chainStatus: typeof record.chainStatus === 'string' && PHASE.test(record.chainStatus) ? record.chainStatus : null,
        open: isOpenWithdrawalRecord(record),
        destination: typeof record.destination === 'string' && ADDRESS.test(record.destination)
            ? record.destination.toLowerCase() : null,
        finalBalance: integerValue(record.finalBalance),
        challengeDeadline: positiveInteger(record.challengeDeadline),
        transactionHash,
        startBlockNumber: blockNumber(record.startBlockNumber),
        finalizedBlockNumber: blockNumber(record.finalizedBlockNumber),
        createdAt: positiveInteger(record.createdAt),
        updatedAt: positiveInteger(record.updatedAt),
        payoutVerified: record.payoutVerified === true,
        payoutCredited: record.payoutCredited === true,
        payoutClaimed: record.payoutClaimed === true,
        // The SDK writes a JS number (null for evidence it could not read).
        creditedAmount: integerValue(record.creditedAmount),
        payoutAlert: record.payoutAlert === PAYOUT_ALERT ? PAYOUT_ALERT : null,
        // The build that kept this record found that another device or copy
        // had already used the balance's next state, so it cannot finish
        // this withdrawal from here. That build writes the boolean
        // `deviceNotNewest` next to the evidence (never read here), and its
        // runtime summary calls the same fact `challengeObserved`. Strict
        // booleans, as the version adapter reads the same two fields.
        deviceNotNewest: record.deviceNotNewest === true || record.challengeObserved === true
    };
}

// ---------------------------------------------------------------------------
// Expiry history: port of zkapiExpiryHistory.deriveExpiryRecords
// ---------------------------------------------------------------------------

const integer = value => Number.isSafeInteger(value) && value >= 0;
const seconds = value => integer(value) && value > 0 && value * 1000 <= 8.64e15;

function confirmedClaim(deposit) {
    const claim = deposit.expiryClaim;
    return claim && seconds(deposit.expiryTs) && integer(claim.amount) && claim.amount > 0
        && claim.amount === deposit.amount && integer(claim.blockNumber)
        && HASH.test(claim.transactionHash || '') && HASH.test(claim.blockHash || '')
        && integer(claim.claimedAt) && claim.claimedAt >= deposit.expiryTs * 1000
        && claim.claimedAt <= 8.64e15 ? claim : null;
}

// A withdrawal of the same note that closed it for good, or an escape whose
// finalization the chain already reached: either way expiry can no longer take
// the balance, so "expired" would be a false alarm. A credited escape counts
// (the vault holds its payout for the destination).
function settlesExpiry(record) {
    return ((record.payoutVerified === true || record.payoutCredited === true)
            && CLOSED_PHASES.includes(record.phase))
        || (record.mode === 'escape' && record.chainStatus === 'pending_withdrawal'
            && integer(record.startBlockNumber) && record.startBlockNumber > 0
            && integer(record.finalizedBlockNumber) && record.finalizedBlockNumber >= record.startBlockNumber);
}

const sameNote = (deposit, record) => record.deploymentId === deposit.deploymentId
    && record.noteId === deposit.noteId;

/**
 * The SDK's expiry records for `deposits` (rows shaped as the SDK keeps them:
 * recordId, deploymentId, noteId, amount, expiryTs, status, expiryClaim) and
 * `withdrawals` (deploymentId, noteId, mode, phase, payoutVerified,
 * payoutCredited, chainStatus, startBlockNumber, finalizedBlockNumber).
 * Same rule, same fields and same output as the SDK's function minus the
 * `detail` sentence; the parity test fuzzes it against the installed SDK and
 * replays the vectors of the newer one.
 */
export function deriveExpiryRecords(deposits = [], withdrawals = [], nowMs = Number.NaN) {
    return deposits.flatMap(deposit => {
        if (deposit.status !== 'confirmed' || !seconds(deposit.expiryTs)) return [];
        const claim = confirmedClaim(deposit);
        if (!claim && (!Number.isFinite(nowMs) || deposit.expiryTs * 1000 > nowMs
            || withdrawals.some(record => sameNote(deposit, record) && settlesExpiry(record)))) return [];
        return [{
            recordId: `${deposit.recordId}:expiry`, type: 'expiry',
            status: claim ? 'claimed' : 'expired', deploymentId: deposit.deploymentId,
            noteId: deposit.noteId, expiryTs: deposit.expiryTs,
            createdAt: claim?.claimedAt ?? deposit.expiryTs * 1000,
            amount: claim?.amount ?? null, claimedAt: claim?.claimedAt ?? null,
            transactionHash: claim?.transactionHash ?? null,
            blockHash: claim?.blockHash ?? null, blockNumber: claim?.blockNumber ?? null
        }];
    });
}

// ---------------------------------------------------------------------------
// Versions and keys
// ---------------------------------------------------------------------------

// A short, stable tag for a deployment this build has no row for, so two such
// deployments never share a row key.
function shortHash(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

// The unit a version's amounts are counted in, from its adapter's own data. A
// unit is only taken when it is wholly known: an asset, a unit name and a
// power-of-ten count per ETH. Anything else leaves amounts unknown.
function billingOf(entry, adapterFor) {
    try {
        const billing = adapterFor(entry.adapter).billing;
        if (isRecord(billing) && typeof billing.asset === 'string' && typeof billing.unit === 'string'
            && billingDecimals(billing.perEth) !== null) {
            return Object.freeze({ asset: billing.asset, unit: billing.unit, perEth: billing.perEth });
        }
    } catch { /* an adapter this build does not know: its amounts stay unknown */ }
    return null;
}

function sameBilling(left, right) {
    return left !== null && right !== null && left.asset === right.asset && left.unit === right.unit
        && left.perEth === right.perEth;
}

// The version a deployment id belongs to, as a row carries it.
//
// `billing` is the unit its amounts are in, taken from the row's own adapter
// and never from whichever SDK happens to be loaded; it is null (and every
// amount of the row null) for a deployment this build has no table row for, or
// whose adapter declares no unit.
//
// `sameUnitAsLoaded` says that unit is exactly `loadedBilling`, the unit the
// loaded SDK's money formatter reads. It is the only licence to price the
// row's amounts with that formatter: a version that counts in another unit
// would otherwise be priced as if it counted in the loaded one, off by the
// ratio of the two units. Unknown on either side is "no".
function describeVersion(table, deploymentId, loadedBilling, adapterFor) {
    const entry = versionForDeployment(table, deploymentId);
    if (!entry) {
        return Object.freeze({
            versionId: null, label: UNKNOWN_VERSION_LABEL, status: 'unknown', chainId: null, billing: null,
            sameUnitAsLoaded: false
        });
    }
    const billing = billingOf(entry, adapterFor);
    return Object.freeze({
        versionId: typeof entry.id === 'string' && entry.id ? entry.id : null,
        label: typeof entry.label === 'string' && entry.label ? entry.label : UNKNOWN_VERSION_LABEL,
        status: VERSION_STATUSES.includes(entry.status) ? entry.status : 'unknown',
        chainId: positiveInteger(entry.chainId),
        billing,
        sameUnitAsLoaded: sameBilling(billing, loadedBilling)
    });
}

// What row keys of a deployment's rows start with: its version id, or a
// short tag of the deployment id when no version names it.
const scopeOf = (version, deploymentId) => version.versionId || `earlier-${shortHash(deploymentId || '')}`;

function isKnownLoaded(table, loadedDeploymentId) {
    return typeof loadedDeploymentId === 'string' && loadedDeploymentId.length > 0
        && Array.isArray(table) && versionForDeployment(table, loadedDeploymentId) !== null;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const unitsOrNull = (version, value) => (version.billing && value !== null && value !== undefined
    ? String(value) : null);

function expiryStateOf(deposit, claimed, settled) {
    if (claimed) return 'claimed';
    if (!seconds(deposit.expiryTs)) return 'none';
    return settled ? 'settled' : 'open';
}

// Newest first; the "older payments not shown" line always sorts last; equal
// dates fall back to the key so the order is the same on every read.
const byNewest = (left, right) => (left.kind === 'omitted') - (right.kind === 'omitted')
    || right.at - left.at || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);

// A withdrawal row a person may still have to act on or be told about: one the
// SDK counts as open (an unfinished or set-aside balance, or a close still
// being finalized), a payout the contract credited and nobody claimed, or a
// payout that paid out less than expected. No cap may drop one of these in
// favour of an older closed payment.
const needsAttention = row => row.open === true || row.payoutAlert !== null || isUnclaimedPayoutCredit(row);

// At most HISTORY_ROW_LIMIT rows of one kind, newest first, except that the
// rows `isPriority` names are always kept and take their places ahead of the
// rest (so a person with more than the limit of rows needing attention sees
// all of them, and nothing else). `cut` says some row was left out.
function capRows(rows, isPriority) {
    if (rows.length <= HISTORY_ROW_LIMIT) return { kept: rows, cut: false };
    const priority = rows.filter(isPriority);
    const room = Math.max(0, HISTORY_ROW_LIMIT - priority.length);
    const rest = rows.filter(row => !isPriority(row)).slice(0, room);
    const kept = [...priority, ...rest];
    return { kept, cut: kept.length < rows.length };
}

// What a list that was cut says about itself. A row, not a flag beside the
// list: the renderer only ever receives rows, and a truncated list that reads
// as complete is a silent drop. It names no version and carries no action.
const OMITTED_ROW = Object.freeze({
    key: 'history:omitted',
    scope: 'history',
    kind: 'omitted',
    at: 0,
    noteId: null,
    version: Object.freeze({
        versionId: null, label: '', status: 'unknown', chainId: null, billing: null, sameUnitAsLoaded: false
    })
});

/**
 * Display rows for every deployment other than the loaded one.
 *
 * @param {{withdrawals: object[], deposits: object[]}} raw  the stored records
 *   (only these two lists are read; any other key is ignored, and never
 *   copied)
 * @param {{table: object[], loadedDeploymentId: string, nowMs?: number,
 *   adapterFor?: (id: string) => object}} context
 *   `table` is the runtime version table; `loadedDeploymentId` the deployment
 *   whose rows the loaded SDK already shows. Without a loaded deployment the
 *   table knows, nothing can be said about what is "other", so no rows.
 *   `nowMs` decides which unclaimed deposits read as expired; without it none
 *   do (rowsAt adds them later). `adapterFor` resolves a table row's adapter
 *   (the shipped adapters by default); it is how a test gives a version a
 *   unit of its own.
 * @returns {{rows: object[], truncated: boolean}} Rows are frozen, newest
 *   first, at most HISTORY_ROW_LIMIT per kind. Within a kind, rows that need
 *   attention (an open or set-aside withdrawal, an unclaimed credit, an alert)
 *   are kept ahead of closed ones, whatever their age, so a cap never drops
 *   one. When any row was left out, `truncated` is true and the list ends with
 *   an `omitted` row.
 *   deposit     {key, scope, kind, at, noteId, version, amountUnits,
 *                transactionHash, feeWei, expiryTs, expiryState}
 *   withdrawal  {key, scope, kind, at, noteId, version, mode, phase, open,
 *                payoutVerified, payoutCredited, payoutClaimed, payoutAlert,
 *                deviceNotNewest, amountUnits, creditedUnits, destination,
 *                challengeDeadline, transactionHash}
 *   expiry      {key, scope, kind, at, noteId, version, status, expiryTs,
 *                claimAmountUnits, claimTransactionHash}
 *   omitted     {key, scope, kind, at: 0, noteId: null, version}
 *   `version` is {versionId, label, status, chainId, billing,
 *   sameUnitAsLoaded}. `at` is epoch milliseconds (0 when the record has no
 *   date), `expiryTs` and `challengeDeadline` are seconds, units are decimal
 *   strings of the row's billing unit (null for an unknown version).
 *   `expiryState` is claimed, settled (a withdrawal closed the note), open (it
 *   can still expire) or none. `deviceNotNewest` is true for an unfinished
 *   withdrawal that its own build found another device had already used: this
 *   browser cannot safely continue it.
 */
export function projectOtherHistory(raw, context = {}) {
    if (!isRecord(raw) || !Array.isArray(raw.withdrawals) || !Array.isArray(raw.deposits)) {
        throw coded('history_unreadable', 'Payment history needs a list of deposits and a list of withdrawals.');
    }
    if (!isKnownLoaded(context.table, context.loadedDeploymentId)) return { rows: [], truncated: false };
    const collector = createCollector(context.loadedDeploymentId);
    for (const stored of raw.deposits) collector.addDeposit(stored);
    for (const stored of raw.withdrawals) collector.addWithdrawal(stored);
    return rowsFrom(collector, context);
}

// What a projection keeps of the stored records: allowlisted copies of the
// deposit and withdrawal records of OTHER deployments, nothing else. Every
// stored record goes through its allowlist the moment it is handed in and the
// raw object is dropped, so a caller that streams a store holds one raw record
// at a time and the private state of the rest never sits in memory beside it.
function createCollector(loadedDeploymentId) {
    const deposits = new Map();
    const withdrawals = [];
    return {
        deposits,
        withdrawals,
        addDeposit(stored) {
            const deposit = depositFrom(stored);
            if (deposit && deposit.deploymentId !== loadedDeploymentId) deposits.set(deposit.recordId, deposit);
        },
        addWithdrawal(stored) {
            const withdrawal = withdrawalFrom(stored);
            if (withdrawal && withdrawal.deploymentId !== loadedDeploymentId) withdrawals.push(withdrawal);
        }
    };
}

// The display rows of what a collector holds. `context` is projectOtherHistory's.
function rowsFrom({ deposits, withdrawals }, { table, loadedDeploymentId, nowMs, adapterFor = getAdapter }) {
    // The unit the loaded SDK's money formatter reads: the loaded version's own
    // adapter data, the same source every row's unit comes from.
    const loadedBilling = billingOf(versionForDeployment(table, loadedDeploymentId), adapterFor);
    const versions = new Map();
    const versionOf = deploymentId => {
        if (!versions.has(deploymentId)) {
            const version = describeVersion(table, deploymentId, loadedBilling, adapterFor);
            versions.set(deploymentId, { version, scope: scopeOf(version, deploymentId) });
        }
        return versions.get(deploymentId);
    };
    const keyOf = (scope, kind, noteId) => `${scope}:${kind}:${noteId}`;

    // Expiry first: a verified treasury claim also hides that exact note's
    // withdrawal rows, as the SDK's own list does for the loaded deployment.
    const depositList = [...deposits.values()];
    const expiries = deriveExpiryRecords(depositList, withdrawals, nowMs);
    const claimedNotes = new Set(depositList.filter(deposit => confirmedClaim(deposit))
        .map(deposit => `${deposit.deploymentId}\u0000${deposit.noteId}`));

    const depositRows = depositList.map(deposit => {
        const { version, scope } = versionOf(deposit.deploymentId);
        const noteKey = `${deposit.deploymentId}\u0000${deposit.noteId}`;
        const settled = withdrawals.some(record => sameNote(deposit, record) && settlesExpiry(record));
        return Object.freeze({
            key: keyOf(scope, 'deposit', deposit.noteId),
            scope,
            kind: 'deposit',
            at: deposit.confirmedAt ?? deposit.createdAt ?? 0,
            noteId: deposit.noteId,
            version,
            amountUnits: unitsOrNull(version, deposit.amount),
            // No chain, no explorer link; no unit, no fee.
            transactionHash: version.chainId !== null ? deposit.transactionHash : null,
            feeWei: version.billing ? deposit.feeWei : null,
            expiryTs: deposit.expiryTs,
            expiryState: expiryStateOf(deposit, claimedNotes.has(noteKey), settled)
        });
    });

    const newestWithdrawal = new Map();
    for (const record of withdrawals) {
        const noteKey = `${record.deploymentId}\u0000${record.noteId}`;
        if (claimedNotes.has(noteKey)) continue;
        const previous = newestWithdrawal.get(noteKey);
        if (!previous || (record.updatedAt ?? 0) >= (previous.updatedAt ?? 0)) newestWithdrawal.set(noteKey, record);
    }
    const withdrawalRows = [...newestWithdrawal.values()].map(record => {
        const { version, scope } = versionOf(record.deploymentId);
        // The explorer of the row's own chain: a record that names another
        // chain than its table row is not linked at all.
        const linkable = version.chainId !== null && (record.chainId === null || record.chainId === version.chainId);
        return Object.freeze({
            key: keyOf(scope, 'withdrawal', record.noteId),
            scope,
            kind: 'withdrawal',
            at: record.createdAt ?? record.updatedAt ?? 0,
            noteId: record.noteId,
            version,
            mode: record.mode,
            phase: record.phase,
            open: record.open,
            payoutVerified: record.payoutVerified,
            payoutCredited: record.payoutCredited,
            payoutClaimed: record.payoutClaimed,
            payoutAlert: record.payoutAlert,
            // Only an unfinished record can be "not newest": a closed one has
            // nothing left to continue.
            deviceNotNewest: record.deviceNotNewest && !CLOSED_PHASES.includes(record.phase),
            amountUnits: unitsOrNull(version, record.finalBalance),
            creditedUnits: unitsOrNull(version, record.creditedAmount),
            destination: record.destination,
            challengeDeadline: record.challengeDeadline,
            transactionHash: linkable ? record.transactionHash : null
        });
    });

    const expiryRows = expiries.map(expiry => {
        const { version, scope } = versionOf(expiry.deploymentId);
        const claimed = expiry.status === 'claimed';
        return Object.freeze({
            key: keyOf(scope, 'expiry', expiry.noteId),
            scope,
            kind: 'expiry',
            at: expiry.createdAt,
            noteId: expiry.noteId,
            version,
            status: expiry.status,
            expiryTs: expiry.expiryTs,
            claimAmountUnits: claimed ? unitsOrNull(version, expiry.amount) : null,
            claimTransactionHash: claimed && version.chainId !== null ? expiry.transactionHash : null
        });
    });

    const capped = [
        capRows(depositRows.sort(byNewest), () => false),
        capRows(withdrawalRows.sort(byNewest), needsAttention),
        capRows(expiryRows.sort(byNewest), () => false)
    ];
    const truncated = capped.some(entry => entry.cut);
    const rows = capped.flatMap(entry => entry.kept).sort(byNewest);
    return { rows: truncated ? [...rows, OMITTED_ROW] : rows, truncated };
}

/**
 * The rows as they read at `nowMs`. A projection is a snapshot of the
 * database; time passes without a re-read, and an unclaimed deposit whose
 * deadline has since passed gains its "expiry deadline passed" row here.
 * Nothing is removed: a stored row stays what it was (a claim or a close
 * arrives only with a re-read). Without a finite `nowMs` the rows are
 * returned as they are.
 */
export function rowsAt(rows, nowMs) {
    if (!Array.isArray(rows)) return [];
    const valid = rows.filter(row => isRecord(row) && typeof row.key === 'string');
    if (!Number.isFinite(nowMs)) return valid;
    const present = new Set(valid.filter(row => row.kind === 'expiry').map(row => `${row.scope}:${row.noteId}`));
    const added = [];
    for (const row of valid) {
        if (row.kind !== 'deposit' || row.expiryState !== 'open' || !seconds(row.expiryTs)) continue;
        if (row.expiryTs * 1000 > nowMs || present.has(`${row.scope}:${row.noteId}`)) continue;
        added.push(Object.freeze({
            key: `${row.scope}:expiry:${row.noteId}`,
            scope: row.scope,
            kind: 'expiry',
            at: row.expiryTs * 1000,
            noteId: row.noteId,
            version: row.version,
            status: 'expired',
            expiryTs: row.expiryTs,
            claimAmountUnits: null,
            claimTransactionHash: null
        }));
    }
    return added.length ? [...valid, ...added].sort(byNewest) : valid;
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

function historyError(error) {
    if (error?.code === 'history_unreadable' || error?.code === 'history_timeout') return error;
    if (error?.code === 'holdings_timeout') {
        return coded('history_timeout', 'Reading the payment history timed out.', error);
    }
    return coded('history_unreadable', 'The payment history could not be read.', error);
}

// Hands each record of `store` to `take`, one at a time, through a cursor.
// The raw record is not kept: `take` reduces it through its allowlist and the
// next one replaces it, so a store of other versions' notes, plans and proofs
// is never in memory as a whole (a getAll would put every record there at
// once). Settles when the cursor is exhausted. Stops at once, without reading
// on, when the reader was abandoned (its deadline passed).
function streamStore(store, take, lifecycle) {
    return new Promise((resolve, reject) => {
        let request;
        try {
            request = store.openCursor();
        } catch (error) {
            reject(error);
            return;
        }
        request.onerror = () => reject(request.error || coded('history_unreadable', 'IndexedDB request failed.'));
        request.onsuccess = () => {
            try {
                const cursor = request.result;
                if (cursor === null || cursor === undefined || lifecycle.abandoned) {
                    resolve();
                    return;
                }
                if (typeof cursor.continue !== 'function') {
                    throw coded('history_unreadable', 'The saved wallet returned unexpected records.');
                }
                take(cursor.value);
                cursor.continue();
            } catch (error) {
                reject(error);
            }
        };
    });
}

// Reads both stores inside one readonly transaction into `collector`. Both
// cursors are opened before anything is awaited, in the one turn the
// transaction is active in.
async function readStores(connection, names, collector, lifecycle) {
    const transaction = connection.transaction(names, 'readonly');
    const complete = transactionComplete(transaction);
    const has = name => names.includes(name);
    await Promise.all([
        has(WITHDRAWAL_STORE)
            ? streamStore(transaction.objectStore(WITHDRAWAL_STORE), stored => collector.addWithdrawal(stored), lifecycle)
            : null,
        has(DEPOSIT_STORE)
            ? streamStore(transaction.objectStore(DEPOSIT_STORE), stored => collector.addDeposit(stored), lifecycle)
            : null
    ]);
    await complete;
}

/**
 * Read the payment history of every deployment but the loaded one.
 *
 * Never creates the database or a store, never changes a version, never
 * writes, takes no wallet lock, closes its connection before returning and
 * gives up after `timeoutMs`. A missing database or store reads as empty.
 * When the loaded deployment is not one `table` names, nothing is opened.
 *
 * @param {{database: string, table: object[], loadedDeploymentId: string,
 *   indexedDB?: IDBFactory, timeoutMs?: number, now?: () => number}} options
 * @returns {Promise<{rows: object[], truncated: boolean}>} See
 *   projectOtherHistory. Rejects with code `history_unreadable` or
 *   `history_timeout`; callers treat the history as unknown, never as empty.
 */
export async function readOtherVersionHistory({
    database, table, loadedDeploymentId, indexedDB: factoryOption, timeoutMs = HISTORY_READ_TIMEOUT_MS, now = Date.now
} = {}) {
    if (typeof database !== 'string' || !database) {
        throw coded('history_unreadable', 'A wallet database name is required.');
    }
    if (!isKnownLoaded(table, loadedDeploymentId)) return { rows: [], truncated: false };
    let deadline = null;
    const lifecycle = { abandoned: false };
    let connection = null;
    try {
        const factory = getFactory(factoryOption);
        deadline = createDeadline(timeoutMs);
        connection = await Promise.race([openExistingDatabase(factory, database, lifecycle), deadline.promise]);
        if (!connection) return { rows: [], truncated: false };
        const names = [WITHDRAWAL_STORE, DEPOSIT_STORE].filter(name => connection.objectStoreNames.contains(name));
        if (!names.length) return { rows: [], truncated: false };
        const collector = createCollector(loadedDeploymentId);
        await Promise.race([readStores(connection, names, collector, lifecycle), deadline.promise]);
        return rowsFrom(collector, { table, loadedDeploymentId, nowMs: Number(now()) });
    } catch (error) {
        throw historyError(error);
    } finally {
        deadline?.cancel();
        lifecycle.abandoned = true;
        if (connection) {
            try { connection.close(); } catch { /* already closed */ }
        }
    }
}
