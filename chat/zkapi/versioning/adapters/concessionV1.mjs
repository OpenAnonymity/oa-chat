// Protocol family adapter: circuit zkapi-v2-concession-v1 (vault revision 3).
//
// The successor protocol (zkapi 0.2.0, installed under its own package alias
// when it is activated). It differs from note-bound-v1 where the host can see
// it: its exits are 26-word calls with a concession field, a payout the vault
// could not push is credited and claimed separately, deposits can be closed
// from the pinned profile, and its snapshots report service availability,
// other deployments' unfinished records and the exit rules.
//
// Pure module, same constraints as noteBoundV1.mjs.
//
// This file only describes the protocol. The host behaviors that make a
// deployment of it safe to hold (requiredWiring below) are implemented and
// listed by WIRED (wiring.mjs), so listing them is no longer what keeps a row
// of this family `pending`. It stays pending until its other gates are met:
// its SDK pins, a deployed profile, the finalized manifest hash, a recovery
// review and, for the one behavior with a half in the SDK itself, a reviewed
// recovery patch that covers it (recoveryCoverageGaps in
// scripts/zkapiRegistry.mjs).

import {
    DUST_CEILING_UNITS,
    NATIVE_ETH_BILLING,
    SMALLEST_CHAT_TIER_USD_MICROS,
    boundServiceMessage,
    deepFreeze,
    defaultCloseBy,
    fundingFromTrustedProfile,
    normalizeCommonSnapshot,
    validateBaseProfile
} from './noteBoundV1.mjs';
import { sponsoredProfileProblem } from '../sponsored.mjs';

const CONCESSION_CIRCUIT_ID = 'zkapi-v2-concession-v1';

// Default of the family's first deployment. Every registry row supplies its
// own proxyPath (the second deployment cannot share /zkapi-deployment/).
const DEFAULT_PROXY_PATH = '/zkapi-deployment-v2c/';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const asArray = value => (Array.isArray(value) ? value : []);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// The proof setups a deployment of this family may pin. One rule for every
// network: Sepolia and mainnet differ only by the values of the network itself.
//
//   mpc-1   the multi-party ceremony setup.
//   dev     the single-party development setup. Whoever generated its keys
//           (anyone holding the setup's toxic waste) can forge proofs, which
//           mints balance, defeats an honest exit and takes the deposits of
//           the vault. A vault deployed on dev keys cannot later be switched to
//           mpc-1 (the vault and its adapter pin the verifying key hashes), so
//           moving to mpc-1 is a new vault and a user migration, which is a
//           further version of the registry.
//
// The host accepts both. The limitation is the owner's accepted risk: it is
// surfaced where an operator looks (a warning per live version in the build,
// proofSetup in the build provenance, the registry check) and never blocked
// here. An SDK revision before 4b955d9 (ethereum/zkapi branch v0.2) refuses a
// development bundle for chain 1 in its own build (code
// development_setup_on_mainnet); that rule was the SDK's, not this host's, and
// the host neither bypasses nor reimplements it. 4b955d9 dropped it.
//
// A profile's allow_dev_setup field is a record the SDK's deploy flow writes
// (true for a vault it deployed on a development setup with the opt-in). Neither
// the SDK's runtime nor its build reads it, so the host ignores it too instead
// of adding a second switch beside the setup id: a profile pinning dev with
// allow_dev_setup false is accepted exactly like one with it true. What binds a
// profile to its setup is setup_id, which the bundle's own manifest must equal,
// and the pinned key hashes, which must be those of the bundle's keys.
export const CEREMONY_SETUP_ID = 'mpc-1';
export const DEVELOPMENT_SETUP_ID = 'dev';
export const ACCEPTED_SETUP_IDS = Object.freeze([CEREMONY_SETUP_ID, DEVELOPMENT_SETUP_ID]);

/**
 * What a proof setup id is: 'ceremony' (mpc-1), 'development' (dev), or null
 * for anything else, including no id at all (the legacy family's profile and
 * bundle name none). Pure; the one place the two ids are told apart, used by
 * the profile rule below, the build's warning and its provenance.
 */
export function proofSetupKind(setupId) {
    if (setupId === CEREMONY_SETUP_ID) return 'ceremony';
    if (setupId === DEVELOPMENT_SETUP_ID) return 'development';
    return null;
}

const ACCEPTED_SETUPS_TEXT = ACCEPTED_SETUP_IDS.join(' or ');

const FAMILY = Object.freeze({ circuitId: CONCESSION_CIRCUIT_ID, defaultProxyPath: DEFAULT_PROXY_PATH });

function profileError(message) {
    return new Error(`[build] ${message}`);
}

/**
 * Validate a reviewed concession-v1 profile (browser-config.json).
 *
 * The shared base (noteBoundV1.validateBaseProfile) runs first on a deployed
 * profile; this adds what the revision 3 SDK itself requires of its pins
 * (validateTrustedProfile, assertDeployableProfile) and the host's policy:
 *
 *   - a placeholder (deployment_status not_deployed), or a top-level
 *     migration_required marker, is never a deployable profile;
 *   - vault_revision 3, exit_concession 1, clearance_ownership_proof required;
 *   - setup_id mpc-1 or dev, the same on every network (see the setup note
 *     above); anything else, or none, is refused. The profile's
 *     allow_dev_setup field means nothing to the host and is ignored. When the
 *     caller names the SDK bundle's own setup (ctx.setupId), that setup must be
 *     one of the two as well and must equal the profile's: a profile pinning
 *     one setup against a bundle built for the other is refused. Like
 *     ctx.circuitId, a key that is present must match even when its value is
 *     undefined; static registry validation passes none and checks the profile
 *     alone;
 *   - no `deposits` key: whether a version accepts deposits is derived from
 *     its registry status, never written twice (docs/ZKAPI_VERSIONING.md,
 *     "Derived values").
 */
function validateProfile(config, ctx) {
    const options = ctx || {};
    const pins = config?.trusted_deployment;
    if (config?.deployment_status === 'migration_required') {
        throw profileError('The profile still pins a legacy vault; a concession-v1 deployment is required.');
    }
    for (const status of [config?.deployment_status, pins?.deployment_status]) {
        if (status === 'not_deployed') {
            throw profileError('The profile is a placeholder: no concession-v1 vault is deployed for it.');
        }
        if (status != null && status !== 'deployed') {
            throw profileError('The profile has an unknown deployment_status.');
        }
    }
    validateBaseProfile(config, options, FAMILY);

    if (pins.vault_revision !== 3) {
        throw profileError('The profile must pin vault revision 3.');
    }
    if (pins.exit_concession !== 1) {
        throw profileError('The profile must pin a vault with the concession exit (exit_concession 1).');
    }
    if (pins.clearance_ownership_proof !== 'required') {
        throw profileError('The profile must require the ownership proof for clearances.');
    }
    // The messages do not name a network: the same profile is refused for the
    // same reason everywhere.
    if (proofSetupKind(pins.setup_id) === null) {
        throw profileError(`The profile must pin an accepted proof setup (${ACCEPTED_SETUPS_TEXT}).`);
    }
    if (hasOwn(options, 'setupId')) {
        if (proofSetupKind(options.setupId) === null) {
            throw profileError(`The SDK bundle must be built for an accepted proof setup (${ACCEPTED_SETUPS_TEXT}).`);
        }
        if (options.setupId !== pins.setup_id) {
            throw profileError(`The SDK bundle is built for the ${options.setupId} proof setup, `
                + `but the profile pins the ${pins.setup_id} proof setup.`);
        }
    }
    if (pins.deposits !== undefined) {
        throw profileError('The profile must not set deposits; the registry status derives it.');
    }
    // The legacy vault's ids contain "note-bound"; a concession deployment must
    // not reuse one (a browser keeps every deployment's wallet in one store
    // keyed by this id).
    if (/note-bound/.test(pins.deployment_id)) {
        throw profileError('The profile names a legacy deployment id.');
    }
    if (!/^[a-f0-9]{64}$/.test(pins.request_verifying_key_sha256 || '')) {
        throw profileError('The profile must pin the request verifying key hash.');
    }
    const emittedVerifyingKey = options.files?.['proofs/request.vk'];
    if (emittedVerifyingKey !== undefined && emittedVerifyingKey !== pins.request_verifying_key_sha256) {
        throw profileError('request verifying key does not match the selected deployment pins.');
    }
    if (pins.settlement_window_seconds != null
        && (!Number.isSafeInteger(pins.settlement_window_seconds) || pins.settlement_window_seconds <= 0)) {
        throw profileError('The profile has an invalid settlement_window_seconds.');
    }
    // Sponsored withdrawals (the ERC-4337 contracts of the withdrawal
    // paymaster): absent or null offers none; a pinned object must be one this
    // host can read and route (versioning/sponsored.mjs).
    const sponsoredProblem = sponsoredProfileProblem(pins.gasless);
    if (sponsoredProblem) throw profileError(sponsoredProblem);
    return config;
}

// ---------------------------------------------------------------------------
// Snapshot normalization
// ---------------------------------------------------------------------------
//
// Units. The SDK mixes seconds and milliseconds, and the normalized names keep
// them apart. Everything read here from `config.exit`, from a set-aside record
// (`expiry`, `must_initiate_by`) or from a lock is epoch MILLISECONDS and is
// named `...Ms` (or documented as such); the deadlines the common normalizer
// builds and `note.expiry_ts` are SECONDS. Amounts are decimal strings of
// gwei: the SDK writes JS numbers for credited amounts and strings for bounds,
// and both are accepted.
//
// Secrets. The facade merges the in-memory runtime slot (note state included)
// into the snapshot it hands to normalizeSnapshot. Only booleans, ids, times,
// counts and amount strings leave this module; no raw field is copied, and
// `config.exit.exit_rpc_url` (an operator-chosen URL that may embed a key) is
// read as nothing at all.

function nonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringOrNull(value) {
    return typeof value === 'string' && value ? value : null;
}

// An epoch-millisecond instant, as exit deadlines are written, or null.
//
// The SDK writes whole milliseconds (seconds times 1000). A value in seconds
// stays below the lower bound until the year 5138 and one in microseconds is
// above the upper bound, so a unit slip in a later SDK reads as "not known"
// and never as a 1970 or a year 58000 date that a deadline notice would then
// print or arm a timer for. A negative, fractional or non-numeric value is the
// same "not known".
const MIN_EPOCH_MS = 1e11;
const MAX_EPOCH_MS = 1e14;

function epochMilliseconds(value) {
    return Number.isSafeInteger(value) && value >= MIN_EPOCH_MS && value <= MAX_EPOCH_MS ? value : null;
}

// An amount in gwei as a decimal string: whole and not negative, from a safe
// integer, a bigint or digits. Anything else is "not known", never a guess.
function amountString(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    if (typeof value === 'bigint') return value >= 0n ? String(value) : null;
    if (typeof value === 'string' && /^[0-9]{1,30}$/.test(value)) return String(BigInt(value));
    return null;
}

// Machine words the SDK writes (service codes, lock modes). Operator text is
// never one of these; a value that is not word-shaped is "no code".
const MACHINE_WORD = /^[a-z][a-z0-9_]{0,63}$/;

function machineWord(value) {
    return typeof value === 'string' && MACHINE_WORD.test(value) ? value : null;
}

// A record id; the empty string when it is missing, so a count of records
// stays honest even for a malformed entry. Callers never offer an action for ''.
function recordIdOf(record) {
    return typeof record.recordId === 'string' ? record.recordId : '';
}

function normalizeService(service) {
    if (!isRecord(service)) return null;
    return {
        available: service.available === true,
        code: machineWord(service.code),
        message: boundServiceMessage(service.message)
    };
}

function normalizeOtherWithdrawal(record) {
    return {
        deploymentId: stringOrNull(record.deployment_id),
        recordId: stringOrNull(record.record_id),
        noteId: nonNegativeInteger(record.note_id),
        mode: stringOrNull(record.mode),
        phase: stringOrNull(record.phase)
    };
}

function normalizeOtherCredit(record) {
    return {
        deploymentId: stringOrNull(record.deployment_id),
        recordId: stringOrNull(record.record_id),
        noteId: nonNegativeInteger(record.note_id),
        chainId: nonNegativeInteger(record.chain_id),
        contractAddress: stringOrNull(record.contract_address),
        destination: stringOrNull(record.destination),
        creditedAmount: amountString(record.credited_amount)
    };
}

function normalizeLock(lock) {
    if (!isRecord(lock)) return null;
    return {
        mode: machineWord(lock.mode),
        sinceMs: epochMilliseconds(lock.since),
        released: nonNegativeInteger(lock.released) ?? 0,
        proofsReleased: nonNegativeInteger(lock.exit_proofs_released) ?? 0,
        // Set only while an exit proof is outstanding.
        releasableAfterMs: epochMilliseconds(lock.releasable_after)
    };
}

// The exit rules at the slot note's state (BrowserWalletRuntime.exitSummary),
// from local data. Each flag fails toward the restrictive reading: a kit
// counts as current only when the SDK says it is not out of date, the deposit
// path counts as saved only when the SDK says so, and an unknown freshness
// stays null rather than becoming true.
function normalizeExit(exit) {
    if (!isRecord(exit)) return null;
    const kit = isRecord(exit.exit_kit) ? exit.exit_kit : null;
    const kitOutOfDate = kit === null || kit.out_of_date !== false;
    return {
        mustInitiateBy: epochMilliseconds(exit.must_initiate_by),
        nearExpiry: exit.near_expiry === true,
        lockHeld: isRecord(exit.lock),
        kitOutOfDate,
        rpcRecommended: exit.exit_rpc_recommended === true,
        boundAtState: amountString(exit.bound_at_state),
        stateFresh: typeof exit.state_fresh === 'boolean' ? exit.state_fresh : null,
        escapeAt: epochMilliseconds(exit.escape_at),
        deviceNotNewest: exit.device_not_newest === true,
        lock: normalizeLock(exit.lock),
        kit: {
            stateSeq: nonNegativeInteger(kit?.state_seq),
            exportedSeq: nonNegativeInteger(kit?.exported_seq),
            outOfDate: kitOutOfDate
        },
        depositPathSaved: exit.deposit_path_saved === true,
        rpcWrongChain: exit.exit_rpc_wrong_chain === true,
        costWarning: isRecord(exit.exit_cost_warning)
    };
}

// Whether this device may still exit a set-aside record: it was defeated by a
// newer state (`challengeObserved`, the SDK strips the evidence itself) or
// flagged `deviceNotNewest` when it was restored. Matched by record, never by
// expiry seconds.
const isDeviceFlagged = record => record.deviceNotNewest === true || record.challengeObserved === true;

// An escape whose payout the vault credited and this browser has not seen
// delivered. Same predicate as walletHoldings.isUnclaimedPayoutCredit, applied
// to snapshot entries.
const isUnclaimedCredit = record => record.payoutCredited === true && record.payoutClaimed !== true
    && (record.phase === 'closed' || record.phase === 'closed_unconfirmed');

function normalizeOwnCredit(record) {
    const evidence = record.payoutCreditEvidence;
    return {
        recordId: recordIdOf(record),
        noteId: nonNegativeInteger(record.noteId),
        // null for evidence `vault_credit`: the vault holds the credit but no
        // receipt told this browser the amount.
        creditedAmount: amountString(record.creditedAmount),
        evidence: evidence === 'receipt' || evidence === 'vault_credit' ? evidence : null
    };
}

// Earliest deadline first; a record with no usable deadline last.
function byDeadline(left, right) {
    const first = left.mustInitiateByMs;
    const second = right.mustInitiateByMs;
    if (first !== second) {
        if (first === null) return 1;
        if (second === null) return -1;
        return first - second;
    }
    return left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0;
}

function normalizeSnapshot(snapshot, ctx) {
    // Set-aside records that sit near their deadline. They are collected from
    // the entries the common normalizer lists as set-aside, so a record is
    // judged by exactly the rule that gives it a deadline (open, set aside,
    // not the slot note, with an expiry), and a device-flagged record, which
    // cannot be exited here, is never nudged toward a withdrawal.
    const near = [];
    const annotate = record => {
        const deviceFlagged = isDeviceFlagged(record);
        if (record.exit_deadline_near === true && !deviceFlagged) {
            near.push({
                recordId: recordIdOf(record),
                mustInitiateByMs: epochMilliseconds(record.must_initiate_by),
                expiryMs: epochMilliseconds(record.expiry)
            });
        }
        return { recordId: recordIdOf(record) || null, deviceFlagged };
    };
    const result = normalizeCommonSnapshot(snapshot, concessionV1.sweepablePhases, { annotate });
    const config = isRecord(snapshot) && isRecord(snapshot.config) ? snapshot.config : {};
    const records = isRecord(snapshot) ? asArray(snapshot.withdrawals).filter(isRecord) : [];
    const sweepable = new Set(concessionV1.sweepablePhases);

    result.sdkDepositsClosed = config.deposits === 'closed';
    result.service = normalizeService(config.service);
    result.otherDeploymentWithdrawals = asArray(config.other_deployment_withdrawals)
        .filter(isRecord).map(normalizeOtherWithdrawal);
    result.otherDeploymentCredits = asArray(config.other_deployment_credits)
        .filter(isRecord).map(normalizeOtherCredit);
    result.exit = normalizeExit(config.exit);
    result.ownCredits = records.filter(isUnclaimedCredit).map(normalizeOwnCredit);
    result.payoutAlerts = records.filter(record => record.payoutAlert === 'concession_exceeded_bound').map(recordIdOf);
    result.deviceNotNewestRecords = records.filter(record => sweepable.has(record.phase) && isDeviceFlagged(record))
        .map(recordIdOf);
    result.setAsideNear = near.sort(byDeadline);
    result.unresolvedRequests = asArray(config.unresolved_requests).length;
    return result;
}

// What the holdings watcher compares between SDK changes. The watcher re-reads
// the shared wallet database when this changes, and that read is only worth
// making when something a fresh load decides on may have moved. A few facts of
// a reading move with every settled chat, or only while one is in flight, and
// decide nothing: the exit kit's state sequence, the instant a lock was
// re-based onto the new state, the freshness, bound and earliest escape time
// of an unresolved request, the count of those requests, and the exit cost
// warning (which follows the balance). They are display facts, read from the
// state when it is rendered; fingerprinting them would read the database after
// every chat.
//
// A fact is left out only by being named here. Anything else, including a key
// added to the reading later, stays in, so a new field costs at most one extra
// read and can never cost a missed one. Pure; returns a new object.
const PER_CHAT_EXIT_KEYS = Object.freeze(['boundAtState', 'stateFresh', 'escapeAt', 'costWarning']);

function watchFacts(reading) {
    if (!isRecord(reading)) return reading;
    const facts = { ...reading };
    delete facts.unresolvedRequests;
    if (isRecord(reading.exit)) {
        const exit = { ...reading.exit };
        for (const key of PER_CHAT_EXIT_KEYS) delete exit[key];
        if (isRecord(exit.lock)) {
            exit.lock = { ...exit.lock };
            delete exit.lock.sinceMs;
        }
        if (isRecord(exit.kit)) {
            exit.kit = { ...exit.kit };
            delete exit.kit.stateSeq;
            delete exit.kit.exportedSeq;
        }
        facts.exit = exit;
    }
    return facts;
}

// ---------------------------------------------------------------------------
// Call profile and entry points
// ---------------------------------------------------------------------------

// Vault revision 3 calldata the host's signer may sign. Word indexes count
// 32-byte ABI words after the 4-byte selector. Verified against the revision 3
// SDK's wallet.js encoders (sdk/wallet.js ABI, WITHDRAWAL_TUPLE,
// WITHDRAWAL_CALLDATA_BYTES, encodeWithdrawal, encodeClaimEscapePayout) and
// against the Foundry golden calldata in the upstream sdk/test/fixtures:
//
//   deposit      commitment, amount, 32 path words                      34 words
//   mutual close 16-word public tuple, bytes offset (17 * 32 = 544),
//                proof length 256, 8 proof words                         26 words
//   escape       the same layout, selector a38d62aa
//   finalize     note id                                                 1 word
//   claim        escapePayoutCredits destination                         1 word
//
// Tuple words: 0 version, 1 chain id, 2 vault, 3 active root, 4-7 signing
// keys, 8 note id, 9 final balance, 10 destination, 11 withdrawal nullifier,
// 12 kind (1 mutual, 0 escape), 13 next nullifier, 14 conceded, 15 valid_until.
//
// Rules the table cannot express by position alone:
//   - A mutual close must publish no successor and concede nothing: the
//     exit's zeroWords [13, 14] are all zero.
//   - An escape must name a successor nullifier: every nonZeroWords entry
//     must be non-zero AND differ from the word at fields.nullifier (the
//     encoder refuses a successor equal to the nullifier).
//   - An escape's conceded amount (concededWord) must equal the amount the
//     user confirmed in the authorization.
//
// The deposit's commitment is word 0 and its amount word 1, as in every family
// (the legacy family follows them with the note's 32 sibling words).
const callProfile = deepFreeze({
    id: 'concession-v1',
    // deposit(bytes32 commitment, uint128 amount): the vault appends the leaf
    // itself (the one-permutation tree revision), so no Merkle path travels.
    deposit: { selector: '56d2e1ea', words: 2 },
    exits: [
        {
            mode: 'mutual', selector: '72cd2e44', words: 26,
            kind: { word: 12, value: 1n },
            bytesOffset: { word: 16, value: 544n },
            proofLength: { word: 17, value: 256n },
            zeroWords: [13, 14], nonZeroWords: [], concededWord: null
        },
        {
            mode: 'escape', selector: 'a38d62aa', words: 26,
            kind: { word: 12, value: 0n },
            bytesOffset: { word: 16, value: 544n },
            proofLength: { word: 17, value: 256n },
            zeroWords: [], nonZeroWords: [13], concededWord: 14
        }
    ],
    fields: { chainId: 1, vault: 2, noteId: 8, finalBalance: 9, destination: 10, nullifier: 11 },
    finalize: { selector: 'ff8f5585', words: 1, noteIdWord: 0 },
    // claimEscapePayout(destination): anyone may send it, the vault pays the
    // destination. The SDK's recovery context kind is escape-payout-claim; the
    // host authorizes it under its own `payout-claim` kind.
    claim: { selector: '88c10aee', words: 1, destinationWord: 0, recoveryKind: 'escape-payout-claim', authorizationKind: 'payout-claim' },
    // A withdrawal whose network fee is paid out of its payout through an
    // ERC-4337 user operation sent from a transit account (the SDK's
    // `fees: 'payout'`). The two selectors are the calls the signer may see
    // inside such an operation: account.withdraw(bytes), which carries the
    // vault call, and factory.createAccount(owner, payee), the operation's
    // initCode on first use. services/sponsoredOperation.mjs judges an
    // operation with these and the exits above; a family without this key
    // has no sponsored withdrawals.
    sponsored: { version: 1, transitWithdraw: '0968f264', createAccount: '133572ba' }
});

// Same classification rule as noteBoundV1.mjs, enumerated from the revision 3
// client and runtime classes (0.2.0 @4b955d9; the 82c8504 snapshot had two
// fewer runtime names, listed below). The SDK also refuses closed deposits
// natively (assertDepositMayStart, honorsDepositsFlag); the host guard stays
// installed so the refusal has one error shape in every version.
const depositEntryPoints = deepFreeze({
    client: ['deposit', 'performDeposit', 'prepareDepositQuote', 'quoteDepositUsd'],
    runtime: ['prepareDeposit', 'prepareDepositQuote']
});

const recoveryEntryPoints = deepFreeze({
    client: [
        'assertDepositMayStart', 'browserDepositNonceConsumed', 'browserDepositSlotConflictFinality',
        'confirmBrowserDepositReceipt', 'prepareDepositRetry', 'readDepositReceiptMetadata', 'recoverBrowserDeposit',
        'recoverUnknownDeposit', 'refreshConfirmedBrowserDeposit', 'resumeExternalTransaction', 'retryDroppedDeposit',
        'retryUnknownDeposit'
    ],
    runtime: [
        'authorizePendingDepositRetry', 'canQuotePendingDeposit', 'claimPendingDepositReplacement',
        'claimPendingDepositSubmission', 'completeConfirmedDeposit', 'confirmDeposit', 'confirmedDepositFor',
        'depositSubmissionMatches', 'depositsClosed',
        'depositsClosedError', 'discardClosedDepositDraftLocked', 'getDepositHistory', 'markPendingDepositAmbiguous',
        'markPendingDepositMissingReceipts', 'markPendingDepositRetryable', 'markPendingDepositUnknown',
        'nextDepositPath', 'pendingDeposit', 'refreshPendingDeposit', 'releasePendingDepositReplacementClaim',
        'rememberPendingDepositSubmissionMetadata', 'rememberPendingDepositTransaction',
        'resolvePendingDepositSlotConflict', 'verifiedDepositPath', 'verifyDeploymentForDeposit'
    ]
});

// What the upstream SDK README makes mandatory for a host of this protocol (the
// service message, credited payouts, payout alert, device_not_newest, the
// near-expiry and settlement waits, other deployments' records), plus the exit
// kit and exit RPC it recommends and this host requires. Short stable names;
// wiring.mjs lists the ones the host implements (all of them), and
// registryModel.mjs refuses a live row of this family for any that it does not.
const requiredWiring = Object.freeze([
    'service-message',               // exit-only: show config.service.message, block deposits and chats
    'credited-payouts',              // payouts the vault credited: show as credited, claimEscapePayout
    'payout-alert',                  // payoutAlert concession_exceeded_bound
    'device-not-newest',             // device_not_newest: restore the newest backup or exit kit
    'near-expiry',                   // note_near_expiry and config.exit.near_expiry
    'ownership-proof-wait',          // ownership_proof_wait, exit_release_pending, request_settlement_pending
    'exit-kit',                      // exportExitKit after a deposit and when out of date
    'withdrawal-operation-recheck',  // re-verify the displayed prepared withdrawal under the wallet lock
    'other-deployment-withdrawals',  // config.other_deployment_withdrawals blocks deposits
    'other-deployment-credits'       // config.other_deployment_credits claimable from that build
]);

// The give-up action stays off for this family until it has its own recovery
// review. The 0.2.0 store's archive also supersedes the note's request-journal
// archives and drops the exit lock, billing asset, state sequence and exit-kit
// mark, none of which the host's verdict has been reviewed against. The two
// numbers are data so that review only has to flip `supported`.
const ABANDON = deepFreeze({
    supported: false,
    smallestChatTierUsdMicros: SMALLEST_CHAT_TIER_USD_MICROS,
    dustCeilingUnits: DUST_CEILING_UNITS
});

export const concessionV1 = Object.freeze({
    id: 'concession-v1',
    circuitId: CONCESSION_CIRCUIT_ID,
    vaultRevision: 3,
    billing: NATIVE_ETH_BILLING,
    abandon: ABANDON,

    validateProfile,

    fundingFromProfile(config) {
        return fundingFromTrustedProfile(config);
    },

    callProfile,
    depositEntryPoints,
    recoveryEntryPoints,

    // setAsideDeadlines in the SDK's runtime snapshot covers exactly these.
    sweepablePhases: Object.freeze(['parked', 'restored']),

    normalizeSnapshot,
    watchFacts,

    closeBy(expiryTsSeconds, version) {
        return defaultCloseBy(expiryTsSeconds, version);
    },

    // The SDK refuses new chats near expiry itself (note_near_expiry).
    chatCutoffSeconds: null,
    requiredWiring,
    // The registry row must carry the finalized manifest hash the profile was
    // generated from (scripts/deployment-profile.mjs --finalized).
    requiresManifestSha256: true
});

export default concessionV1;
