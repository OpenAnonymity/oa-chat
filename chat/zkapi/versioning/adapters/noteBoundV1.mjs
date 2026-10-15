// Protocol family adapter: circuit zkapi-v2-note-bound-v1 (vault revision 1).
//
// This is today's deployment: the legacy browser SDK pinned in package.json
// (3342c95 plus the oa-chat recovery patch). An adapter is the code half of a
// registry row (deployments/zkapi/registry.json): it knows how to validate a
// reviewed profile, what a vault call looks like, which SDK methods start a
// deposit, and how to read the SDK's snapshot. Everything that differs between
// deployments of the same family stays data in the registry.
//
// Pure module: no Node built-ins, SDK imports, fetch or storage. It runs
// unchanged in the browser bundle, in plain Node and in the build scripts.
//
// The shared base functions of this file (validateBaseProfile,
// fundingFromTrustedProfile, normalizeCommonSnapshot, defaultCloseBy) are what
// concessionV1.mjs reuses; both families describe the same host-visible
// concepts (a vault, a note with an expiry, set-aside closes).

import { parseServiceBase } from '../serviceBase.mjs';

const NOTE_BOUND_CIRCUIT_ID = 'zkapi-v2-note-bound-v1';
const OPENROUTER_INFERENCE_BASE = 'https://openrouter.ai/api/v1';

// Proxy path of the legacy deployment (scripts/zkapiBuild.mjs historically
// hard-coded it). Registry validation always passes the row's own proxyPath;
// callers that predate the registry get this reviewed value.
const LEGACY_PROXY_PATH = '/zkapi-deployment/';

// Legacy lease settlement: 21,600 s deadline + 300 s lease TTL + 5 s grace is
// 21,905 s (upstream docs/migration-concession-vault.md: "Phase 0" step 7
// "Settlement" and its vault parameter table), plus about half an hour of
// margin, rounded to 6 h 35 m. The 3342c95 SDK has no native near-expiry
// refusal, and an unsettled lease in the last hours before expiry can leave a
// note that can be neither closed nor escaped in time. The host refuses new
// chat keys inside this window in multi-version builds.
const LEGACY_CHAT_CUTOFF_SECONDS = 23_700;

// Amounts of every registry row are native ETH accounted in gwei:
// validateBaseProfile pins billing_asset, billing_unit and
// native_asset_wei_per_unit for both families. The facts live with the family
// so a caller formats a row's amounts by the row's adapter, never by whichever
// SDK happens to be loaded. A family with another unit declares its own.
export const NATIVE_ETH_BILLING = Object.freeze({ asset: 'native_eth', unit: 'gwei', perEth: 1e9 });

// The smallest chat key either SDK generation issues
// (CHAT_SPENDING_TIER_USD[0]), in millionths of a dollar. It is the default
// and the upper bound of the dust threshold: a balance that cannot pay for the
// smallest key is as good as unusable. Drift tests pin it against both SDKs.
export const SMALLEST_CHAT_TIER_USD_MICROS = 1_000_000;

// An absolute ceiling, in gwei (0.005 ETH), on what may ever be given up as
// dust, whatever a price quote says. The SDKs accept any quote in (0, 1e18], so
// a depressed quote would otherwise turn a large balance into "dust" when it is
// compared in dollars alone.
export const DUST_CEILING_UNITS = 5_000_000;

export function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const asArray = value => (Array.isArray(value) ? value : []);

// ---------------------------------------------------------------------------
// Profile validation
// ---------------------------------------------------------------------------

function publicOrigin(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('[build] Deployment pins must use credential-free HTTPS origins.');
    }
    return url.origin;
}

// The base URL of a deployment's service (protocol server and indexer): an
// origin, or an origin plus a plain path prefix so that two deployments can
// share one hostname (versioning/serviceBase.mjs). The origin-only rule above
// still holds for everything else the runtime reads as an origin.
function publicServiceBase(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('[build] Deployment pins must use credential-free HTTPS origins.');
    }
    if (url.pathname === '/') return url.origin;
    const parsed = parseServiceBase(value);
    if (!parsed) {
        throw new Error('[build] A deployment service URL may carry only a plain path prefix: up to three segments of '
            + 'letters, digits, dots and dashes, with no trailing slash, and not starting with v1, v2, config.json or _bundler.');
    }
    return parsed.base;
}

/**
 * Checks every protocol family shares for a reviewed host profile
 * (browser-config.json): network and chain, proving key pins, origins and
 * routes, native ETH billing and verified OA keys.
 *
 * The checks, their order and their messages are those of the former
 * scripts/zkapiBuild.mjs validateZkapiDeploymentPins, which
 * test/architecture/zkapiBuild.test.js asserts. Only the circuit id, which
 * differs per family, and the proxy path, which differs per registry row, are
 * parameters.
 *
 * ctx:
 *   network      'mainnet' | 'sepolia'
 *   files        emitted proof hashes keyed 'proofs/request.pk' etc. Omitted
 *                for static validation (a registry check before any build):
 *                then only the format of the pinned hashes is checked.
 *   circuitId    the SDK's emitted circuit id. When the key is present its
 *                value must equal the family's circuit (even when undefined);
 *                when absent the family's circuit is assumed.
 *   proxyPath    the registry row's proxyPath; defaults to the family's
 *                historical path.
 *   strict       also apply the registry's origin and inference-base rules
 *                (registry code `profile`). validateRegistry always sets it; the
 *                legacy build wrapper does not, so its accept/reject behavior
 *                is unchanged.
 */
export function validateBaseProfile(config, ctx, family) {
    const options = ctx || {};
    const pins = config?.trusted_deployment;
    if (!['mainnet', 'sepolia'].includes(options.network)
        || pins?.chain_id !== (options.network === 'mainnet' ? 1 : 11155111)) {
        throw new Error('[build] Deployment pins do not match the selected network.');
    }
    const circuitId = hasOwn(options, 'circuitId') ? options.circuitId : family.circuitId;
    if (circuitId !== family.circuitId || pins.circuit_id !== circuitId) {
        throw new Error('[build] Deployment pins do not match the SDK proof circuit.');
    }
    for (const kind of ['request', 'withdrawal']) {
        const expected = pins[`${kind}_proving_key_sha256`];
        if (!/^[a-f0-9]{64}$/.test(expected || '')
            || (options.files !== undefined && expected !== options.files?.[`proofs/${kind}.pk`])) {
            throw new Error(`[build] ${kind} proving key does not match the selected deployment pins.`);
        }
    }
    const base = publicServiceBase(pins.protocol_server_url);
    const proxyPath = options.proxyPath === undefined ? family.defaultProxyPath : options.proxyPath;
    if (publicServiceBase(pins.indexer_url) !== base
        || config.deployment_manifest_url !== `${base}/config.json`
        || JSON.stringify(config.allowed_deployment_manifest_urls) !== JSON.stringify([config.deployment_manifest_url])
        || config.deployment_api_proxy_path !== proxyPath
        || config.proving_keys_base_url !== './proofs/') {
        throw new Error('[build] Deployment manifest, proxy and proof routes must match the reviewed pins.');
    }
    if (typeof pins.deployment_id !== 'string' || !pins.deployment_id
        || !/^0x[0-9a-fA-F]{40}$/.test(pins.contract_address || '')
        || pins.billing_asset !== 'native_eth' || pins.billing_unit !== 'gwei'
        || pins.billing_token_address !== null || pins.native_asset_wei_per_unit !== '1000000000'
        || config.billing_token_symbol !== 'ETH' || config.billing_token_decimals !== 9
        || config.credits_per_usd !== null || config.require_oa_key_source !== true) {
        throw new Error('[build] Fresh deployment pins must identify a native ETH vault and verified OA keys.');
    }
    if (options.strict === true) {
        // The runtime reads rpc_url and verifier_url as origins too; a path or
        // credential in either would put a secret in a public profile.
        for (const value of [pins.rpc_url, pins.verifier_url]) {
            if (typeof value !== 'string') {
                throw new Error('[build] Deployment pins must use credential-free HTTPS origins.');
            }
            publicOrigin(value);
        }
        if (pins.openrouter_inference_base !== OPENROUTER_INFERENCE_BASE) {
            throw new Error('[build] Deployment pins must use the reviewed OpenRouter inference API.');
        }
    }
    return config;
}

/**
 * The SDK's `config.funding` identity fields for a reviewed profile: what the
 * Send Ethereum signer needs to scope itself to the vault without the SDK
 * having initialized. Fails closed on anything not native ETH.
 */
export function fundingFromTrustedProfile(config) {
    const pins = config?.trusted_deployment;
    if (!Number.isSafeInteger(pins?.chain_id) || pins.chain_id <= 0
        || !/^0x[0-9a-fA-F]{40}$/.test(pins.contract_address || '')
        || pins.billing_asset !== 'native_eth' || pins.billing_unit !== 'gwei'
        || pins.native_asset_wei_per_unit !== '1000000000'
        || typeof pins.rpc_url !== 'string' || !pins.rpc_url) {
        throw new Error('The profile does not describe a native ETH vault.');
    }
    return {
        chain_id: pins.chain_id,
        contract_address: pins.contract_address,
        billing_asset: 'native_eth',
        billing_unit: 'gwei',
        native_asset_wei_per_unit: '1000000000',
        demo_rpc_url: pins.rpc_url
    };
}

// ---------------------------------------------------------------------------
// Snapshot normalization
// ---------------------------------------------------------------------------

/** The NormalizedSnapshot of an SDK that has nothing to report. */
export function emptyNormalizedSnapshot() {
    return {
        hasNote: false,
        expiryTs: null,
        deadlines: [],
        hasPendingDeposit: false,
        hasUnsentPrepared: false,
        hasPreparedWithdrawal: false,
        hasOpenWithdrawal: false,
        sdkDepositsClosed: false,
        service: null,
        otherDeploymentWithdrawals: [],
        otherDeploymentCredits: [],
        exit: null
    };
}

// Seconds since the epoch: a positive safe integer given as a number or a
// plain decimal string. Anything else (booleans, objects, fractions) is not a
// date the host will act on.
function positiveSeconds(value) {
    const number = typeof value === 'number' ? value
        : typeof value === 'string' && /^[0-9]{1,16}$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
    const number = typeof value === 'number' ? value
        : typeof value === 'string' && /^[0-9]{1,16}$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

// Operator-controlled text (the exit-only service message) is bounded and
// stripped of control characters here as well as escaped at render time. It is
// never treated as markup, a link or an instruction. This is the snapshot
// field's bound (empty text is null, a cut has no ellipsis); the words the
// person reads are bounded again by versioning/copy.mjs, whose
// OPERATOR_TEXT_LIMIT is the same 280 (both are pinned by tests).
export const SERVICE_MESSAGE_LIMIT = 280;

export function boundServiceMessage(value) {
    if (typeof value !== 'string') return null;
    const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (text.length <= SERVICE_MESSAGE_LIMIT) return text;
    // Never cut a surrogate pair in half.
    let end = SERVICE_MESSAGE_LIMIT;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return text.slice(0, end);
}

/**
 * Whether an entry of the SDK snapshot's withdrawal list can still hold, return
 * or pay out a note: every record except a finalized close with no
 * finalization in flight. Same rule as the SDK store's isOpenBrowserWithdrawal,
 * applied to snapshot entries: an entry that is not an object is ignored
 * (false), unlike walletHoldings.isOpenWithdrawalRecord, which keeps any
 * truthy record of the raw wallet database as open.
 */
function isOpenSnapshotWithdrawal(record) {
    if (!isRecord(record)) return false;
    if (record.phase !== 'closed') return true;
    const hashes = Array.isArray(record.finalizeTransactionHashes) ? record.finalizeTransactionHashes
        : record.finalizeTransactionHash ? [record.finalizeTransactionHash] : [];
    return Boolean(record.finalizeSubmissionId || hashes.length);
}

// The note in the runtime slot. The client snapshot carries the wallet status
// (`wallet.note`); BrowserWalletRuntime.snapshot() carries the raw state.
function slotNote(snapshot) {
    const wallet = snapshot.wallet;
    if (isRecord(wallet) && wallet.has_note && isRecord(wallet.note)) {
        return { noteId: nonNegativeInteger(wallet.note.note_id), expiryTs: positiveSeconds(wallet.note.expiry_ts) };
    }
    const state = isRecord(snapshot.runtime) ? snapshot.runtime.state : null;
    if (isRecord(state)) {
        return { noteId: nonNegativeInteger(state.note_id), expiryTs: positiveSeconds(state.expiry_ts) };
    }
    return null;
}

// Deposit history rows carry each note's expiry, including set-aside notes
// (the store derives a row from every withdrawal record's state). The SDK
// strips the note state from withdrawal records in its snapshots, so this is
// where a set-aside note's deadline comes from.
function depositExpiryIndex(rows) {
    const index = new Map();
    for (const row of asArray(rows)) {
        if (!isRecord(row)) continue;
        const noteId = nonNegativeInteger(row.noteId);
        const expiryTs = positiveSeconds(row.expiryTs);
        if (noteId === null || expiryTs === null) continue;
        const key = `${row.deploymentId ?? ''}\u0000${noteId}`;
        // An earlier deadline is the safe answer if rows ever disagree.
        if (!index.has(key) || index.get(key) > expiryTs) index.set(key, expiryTs);
    }
    return index;
}

// A second source for a deadline that already has a deposit-row expiry is only
// believed while it is within an order of magnitude of that row. Every real
// note expires within weeks of its deposit, so a candidate that is ten times
// too early is a unit change (seconds read as milliseconds) or garbage, and
// taking the earliest of the sources would turn it into a 1970 "overdue"
// deadline that overrides the valid one.
const MAX_DEADLINE_DISAGREEMENT = 10;

// The deadline (seconds) of one set-aside record, or null. Always a positive
// safe integer: every candidate is checked to be one before it counts.
function recordExpiry(record, index) {
    const noteId = nonNegativeInteger(record.noteId);
    let joined = null;
    if (noteId !== null) {
        const row = index.get(`${record.deploymentId ?? ''}\u0000${noteId}`);
        if (row !== undefined) joined = row;
    }
    const others = [];
    // Revision 3 snapshots add the deadline to set-aside records
    // (milliseconds). A value under one second floors to 0, which is not a
    // deadline and must never compete with a real one.
    const direct = positiveSeconds(record.expiry);
    if (direct !== null) {
        const seconds = Math.floor(direct / 1000);
        if (seconds > 0) others.push(seconds);
    }
    // A raw store record still carries its note state.
    const state = isRecord(record.state) ? positiveSeconds(record.state.expiry_ts) : null;
    if (state !== null) others.push(state);

    const candidates = joined === null ? others
        : others.filter(seconds => seconds * MAX_DEADLINE_DISAGREEMENT >= joined);
    if (joined !== null) candidates.push(joined);
    // An earlier deadline is the safe answer if believable sources disagree.
    return candidates.length ? Math.min(...candidates) : null;
}

// Whether the displayed pending deposit is a prepared plan that was never
// sent. This is a display hint derived from the public snapshot; the
// authoritative predicate (isUnsentPreparedDeposit on the raw runtime slot,
// chat/zkapi/versioning/unsentDeposit.mjs) decides every discard. A raw runtime
// in the snapshot can only move the answer toward "started".
function isUnsentPlan(config, rawRuntime) {
    const pending = config.pending_deposit;
    if (!isRecord(pending) || pending.phase !== 'prepared') return false;
    if (pending.transaction_hash || asArray(pending.transaction_hashes).length
        || pending.replacement_available === true || asArray(config.late_deposit_attempts).length) return false;
    const raw = isRecord(rawRuntime) && isRecord(rawRuntime.pendingDeposit) ? rawRuntime.pendingDeposit : null;
    if (raw && (raw.submissionId || raw.submissionOwner || raw.submissionFrom || raw.submissionNonce != null
        || raw.transactionHash || asArray(raw.transactionHashes).length || asArray(raw.transactionAttempts).length
        || asArray(raw.ambiguousSubmissions).length || asArray(raw.approvals).length || raw.legacyRecovery)) return false;
    return true;
}

// One set-aside deadline entry. A family that reports more about a record
// than its expiry passes `annotate(record)`; the fields it returns are added
// beside `source` and `expiryTs`, never over them. Without an annotator the
// entry is exactly {source, expiryTs}, as before.
function setAsideDeadline(record, expiryTs, annotate) {
    const deadline = { source: 'set-aside', expiryTs };
    if (annotate === null) return deadline;
    let extra = null;
    try {
        extra = annotate(record);
    } catch {
        // An annotator is host code; the normalizer must never throw.
        extra = null;
    }
    if (isRecord(extra)) {
        for (const key of Object.keys(extra)) {
            if (!hasOwn(deadline, key)) deadline[key] = extra[key];
        }
    }
    return deadline;
}

/**
 * The fields of NormalizedSnapshot both families derive the same way from a
 * client snapshot (ZkapiClient.snapshot()) or a runtime snapshot
 * (BrowserWalletRuntime.snapshot()). The fields only revision 3 SDKs report
 * (service, other-deployment records, exit, the deposits flag) stay at their
 * empty values here; concessionV1.mjs fills them in.
 *
 * `options.annotate(record) -> object|null` lets a family add fields to the
 * set-aside deadline entry of a record (the concession family adds the record
 * id and whether this device may still exit it). The legacy family passes
 * none, so its entries are untouched.
 *
 * Unknown or malformed input never throws and never invents a note: it yields
 * the empty snapshot, which shows no prompt and unlocks nothing.
 */
export function normalizeCommonSnapshot(snapshot, sweepablePhases, options) {
    const result = emptyNormalizedSnapshot();
    if (!isRecord(snapshot)) return result;
    const annotate = isRecord(options) && typeof options.annotate === 'function' ? options.annotate : null;
    const config = isRecord(snapshot.config) ? snapshot.config : {};
    const note = slotNote(snapshot);
    const records = asArray(snapshot.withdrawals).filter(isRecord);

    result.hasNote = note !== null;
    result.expiryTs = note ? note.expiryTs : null;
    if (note && note.expiryTs !== null) result.deadlines.push({ source: 'slot', expiryTs: note.expiryTs });

    const sweepable = new Set(sweepablePhases);
    const index = depositExpiryIndex(snapshot.deposits);
    const slotDeployment = isRecord(snapshot.runtime) ? snapshot.runtime.deploymentId ?? null : null;
    const setAside = [];
    for (const record of records) {
        if (!isOpenSnapshotWithdrawal(record) || !sweepable.has(record.phase)) continue;
        const recordNote = nonNegativeInteger(record.noteId);
        const sameDeployment = record.deploymentId == null || slotDeployment == null
            || record.deploymentId === slotDeployment;
        // The slot note is already listed; a record of the same note must not
        // appear twice under another source.
        if (note && note.noteId !== null && recordNote === note.noteId && sameDeployment) continue;
        const expiryTs = recordExpiry(record, index);
        if (expiryTs !== null) setAside.push(setAsideDeadline(record, expiryTs, annotate));
    }
    setAside.sort((left, right) => left.expiryTs - right.expiryTs);
    result.deadlines.push(...setAside);

    result.hasPendingDeposit = isRecord(config.pending_deposit) || asArray(config.late_deposit_attempts).length > 0;
    result.hasUnsentPrepared = isUnsentPlan(config, snapshot.runtime);
    result.hasPreparedWithdrawal = isRecord(config.prepared_withdrawal);
    // Unfinished late withdrawal attempts are withdrawals in flight too.
    result.hasOpenWithdrawal = records.some(isOpenSnapshotWithdrawal)
        || asArray(config.late_withdrawal_attempts).length > 0;
    return result;
}

/**
 * Close-by instant (epoch ms) for a note expiring at `expiryTsSeconds`: the
 * expiry minus the version's transition margin. Null when either input is not
 * usable, which the caller treats as "no deadline to remind about".
 */
export function defaultCloseBy(expiryTsSeconds, version) {
    const expiry = positiveSeconds(expiryTsSeconds);
    const margin = version?.transition?.closeByMarginSeconds;
    if (expiry === null || !Number.isSafeInteger(margin) || margin < 0 || margin >= expiry) return null;
    return (expiry - margin) * 1000;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const FAMILY = Object.freeze({ circuitId: NOTE_BOUND_CIRCUIT_ID, defaultProxyPath: LEGACY_PROXY_PATH });

// Vault calldata the host's Send Ethereum signer may sign. Word indexes count
// 32-byte ABI words after the 4-byte selector. Verified against the installed
// legacy SDK's wallet.js encoders (encodeDeposit, encodeWithdrawal,
// encodeFinalizeEscape) by test/zkapi/zkapi-snapshot-adapters.test.mjs:
//
//   deposit      commitment, amount, 32 path words                      34 words
//   mutual close 14-word public tuple, bytes offset (47 * 32 = 1504),
//                32 Merkle siblings, proof length 256, 8 proof words     56 words
//   escape       the same layout, selector 9073639b
//   finalize     note id                                                 1 word
//
// Tuple words: 0 version, 1 chain id, 2 vault, 3 active root, 4-7 signing
// keys, 8 note id, 9 final balance, 10 destination, 11 withdrawal nullifier,
// 12 has_clearance (1 for a mutual close, 0 for an escape), 13 withdrawal tag.
// The deposit's commitment is word 0 and its amount word 1 in every family.
const callProfile = deepFreeze({
    id: 'note-bound-v1',
    deposit: { selector: 'c588341c', words: 34 },
    exits: [
        {
            mode: 'mutual', selector: '7fca9c82', words: 56,
            kind: { word: 12, value: 1n },
            bytesOffset: { word: 14, value: 1504n },
            proofLength: { word: 47, value: 256n },
            zeroWords: [], nonZeroWords: [], concededWord: null
        },
        {
            mode: 'escape', selector: '9073639b', words: 56,
            kind: { word: 12, value: 0n },
            bytesOffset: { word: 14, value: 1504n },
            proofLength: { word: 47, value: 256n },
            zeroWords: [], nonZeroWords: [], concededWord: null
        }
    ],
    fields: { chainId: 1, vault: 2, noteId: 8, finalBalance: 9, destination: 10, nullifier: 11 },
    finalize: { selector: 'ff8f5585', words: 1, noteIdWord: 0 },
    claim: null
});

// SDK methods whose names mention a deposit, split by what the host does with
// them (installDepositGuard). depositEntryPoints start a new
// deposit and are refused on a version that no longer accepts them.
// recoveryEntryPoints are every other such method: recovery, confirmation,
// bookkeeping and reads. They are never wrapped, so a deposit that already
// started always stays completable and recoverable. Enumerated from the
// pinned 3342c95 client and runtime classes; the guard's drift test fails if a
// new /deposit/i method appears without being listed in one of the two.
const depositEntryPoints = deepFreeze({
    client: ['deposit', 'performDeposit', 'prepareDepositQuote', 'quoteDepositUsd'],
    runtime: ['prepareDeposit', 'prepareDepositQuote']
});

const recoveryEntryPoints = deepFreeze({
    client: [
        'browserDepositNonceConsumed', 'browserDepositSlotConflictFinality', 'confirmBrowserDepositReceipt',
        'prepareDepositRetry', 'readDepositReceiptMetadata', 'recoverBrowserDeposit', 'recoverUnknownDeposit',
        'refreshConfirmedBrowserDeposit', 'resumeExternalTransaction', 'retryDroppedDeposit', 'retryUnknownDeposit'
    ],
    runtime: [
        'authorizePendingDepositRetry', 'canQuotePendingDeposit', 'claimPendingDepositReplacement',
        'claimPendingDepositSubmission', 'confirmDeposit', 'depositSubmissionMatches', 'getDepositHistory',
        'markPendingDepositAmbiguous', 'markPendingDepositMissingReceipts', 'markPendingDepositRetryable',
        'markPendingDepositUnknown', 'nextDepositPath', 'pendingDeposit', 'refreshPendingDeposit',
        'releasePendingDepositReplacementClaim', 'rememberPendingDepositSubmissionMetadata',
        'rememberPendingDepositTransaction', 'resolvePendingDepositSlotConflict'
    ]
});

// The give-up action of this family: zero or dust balances of an exit-only
// version may be cleared. `supported` is a review verdict, not a capability:
// the 3342c95 store's archive drops exactly the keys the host's strict verdict
// requires to be absent before it runs, and keeps the note state and the
// deposit history row. Both numbers are family data so a registry row can only
// tighten them (transition.dustThresholdUsdMicros).
const ABANDON = deepFreeze({
    supported: true,
    smallestChatTierUsdMicros: SMALLEST_CHAT_TIER_USD_MICROS,
    dustCeilingUnits: DUST_CEILING_UNITS
});

export const noteBoundV1 = Object.freeze({
    id: 'note-bound-v1',
    circuitId: NOTE_BOUND_CIRCUIT_ID,
    vaultRevision: 1,
    billing: NATIVE_ETH_BILLING,
    abandon: ABANDON,

    validateProfile(config, ctx) {
        return validateBaseProfile(config, ctx, FAMILY);
    },

    fundingFromProfile(config) {
        return fundingFromTrustedProfile(config);
    },

    callProfile,
    depositEntryPoints,
    recoveryEntryPoints,

    // A set-aside note is still live on-chain and the vault sweeps it at its
    // expiry whether or not anyone is looking: 'parked' (a close set aside)
    // and 'restored' (an escape the operator defeated, so the note is active
    // again). A started escape cannot be swept (upstream
    // docs/migration-concession-vault.md, "What the deployed vaults do"), so
    // those phases carry no deadline. These records' expiries are reminded
    // about besides the slot note's.
    sweepablePhases: Object.freeze(['parked', 'restored']),

    // The 3342c95 SDK ignores trusted_deployment.deposits and reports nothing
    // about service, other deployments or exit rules, so every one of those
    // fields stays empty and the host enforces what it needs itself.
    normalizeSnapshot(snapshot, ctx) {
        return normalizeCommonSnapshot(snapshot, noteBoundV1.sweepablePhases);
    },

    closeBy(expiryTsSeconds, version) {
        return defaultCloseBy(expiryTsSeconds, version);
    },

    chatCutoffSeconds: LEGACY_CHAT_CUTOFF_SECONDS,
    requiredWiring: Object.freeze([]),
    requiresManifestSha256: false
});

export default noteBoundV1;
