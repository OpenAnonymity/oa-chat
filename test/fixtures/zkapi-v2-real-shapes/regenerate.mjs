// Person-run generator of the real-shape fixtures next to this file.
//
//     node test/fixtures/zkapi-v2-real-shapes/regenerate.mjs <zkapi checkout or its sdk directory> [options]
//
//   --out <dir>      write there instead of next to this script
//   --check          write nothing; exit 1 when a committed file differs
//   --legacy <dir>   the installed legacy SDK's `sdk` directory (default: this
//                    repository's node_modules/@openanonymity/zkapi-browser-sdk/sdk)
//
// It drives the REAL revision 3 (0.2.0) modules of the SDK passed as the
// argument, in plain Node, over this repository's in-memory IndexedDB
// (test/zkapi/_fakeIndexedDb.mjs), with the clock frozen, and writes only
// DATA: no SDK code is copied into the repository, and no SDK script or git
// command is ever run. Run it again, review the diff and commit the result
// when the pinned SDK revision moves; README.md says which fields are
// hand-seeded and which the SDK emitted.
//
// Nothing here is a secret. Every private field of a seeded note, plan or
// journal carries a SECRET- marker, so a test can prove a reader never
// forwards one; hosts, addresses and keys are the SDK's own placeholders.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeEnvironment, createFakeStorage } from '../../zkapi/_fakeIndexedDb.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const url = file => pathToFileURL(file).href;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = name => {
    const index = args.indexOf(name);
    if (index < 0) return null;
    return args.splice(index, 2)[1] ?? null;
};
const check = args.includes('--check');
if (check) args.splice(args.indexOf('--check'), 1);
const outDir = path.resolve(flag('--out') || HERE);
const legacyArgument = flag('--legacy');
const sdkArgument = args.find(argument => !argument.startsWith('--'));
if (!sdkArgument) {
    console.error('usage: node regenerate.mjs <zkapi checkout or its sdk directory> [--out dir] [--check] [--legacy dir]');
    process.exit(2);
}

async function exists(file) {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

let SDK = path.resolve(sdkArgument);
if (!await exists(path.join(SDK, 'services/browserWalletRuntime.js'))) SDK = path.join(SDK, 'sdk');
if (!await exists(path.join(SDK, 'services/browserWalletRuntime.js'))) {
    console.error(`${sdkArgument} is neither a zkapi checkout nor its sdk directory.`);
    process.exit(2);
}
const LEGACY_SDK = path.resolve(legacyArgument
    || path.join(REPO, 'node_modules/@openanonymity/zkapi-browser-sdk/sdk'));

// ---------------------------------------------------------------------------
// The clock. A fixed instant, not the wall clock: the output is reproducible
// and every instant in it is relative to this one. It is 2026-11-15T12:00:00Z,
// the same anchor as test/zkapi/_registryFixtures.mjs.
// ---------------------------------------------------------------------------

const GENERATED_AT_MS = Date.UTC(2026, 10, 15, 12, 0, 0);
const NOW_S = GENERATED_AT_MS / 1000;
const RealDate = Date;
class FrozenDate extends RealDate {
    constructor(...parts) {
        if (parts.length === 0) super(GENERATED_AT_MS);
        else super(...parts);
    }

    static now() {
        return GENERATED_AT_MS;
    }
}
globalThis.Date = FrozenDate;

// Timers inside the SDK are unref'd AbortSignal timeouts; keep the loop alive
// while an awaited promise depends on them.
const keepAlive = setInterval(() => {}, 1_000);

// ---------------------------------------------------------------------------
// Identity of what is generated against
// ---------------------------------------------------------------------------

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SOURCE_FILES = ['services/browserWalletRuntime.js', 'services/browserWalletStore.js', 'services/zkapiClient.js',
    'services/zkapiExitPolicy.mjs', 'services/zkapiRequestArchive.mjs', 'services/zkapiExpiryHistory.mjs',
    'services/zkapiNativeEth.mjs', 'services/zkapiRequestCompat.mjs', 'services/zkapiExitKit.mjs'];
const assetManifest = JSON.parse(await fs.readFile(path.join(SDK, 'assets/manifest.json'), 'utf8'));
const checkoutVersion = await fs.readFile(path.join(SDK, '..', 'VERSION'), 'utf8').then(text => text.trim(), () => null);
const SOURCE = {
    sdkVersion: checkoutVersion,
    circuitId: assetManifest.circuitId,
    setupId: assetManifest.setupId,
    sourceRevision: assetManifest.sourceRevision ?? null,
    files: Object.fromEntries(await Promise.all(SOURCE_FILES.map(async file => [file,
        sha256(await fs.readFile(path.join(SDK, file)))])))
};

// ---------------------------------------------------------------------------
// Identifiers. They line up with test/zkapi/_registryFixtures.mjs, so a test
// can resolve these deployments through the host's activated fixture
// registry: CURRENT is its second version (concession-v1, slot 2), PREVIOUS
// the shipped note-bound one, RETIRED a deployment no row names.
// ---------------------------------------------------------------------------

const CURRENT = 'zkapi-native-eth-mainnet-concession-v1-fixture-v2c';
const PREVIOUS = 'zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930';
const RETIRED = 'zkapi-native-eth-mainnet-note-bound-v1-retired-fixture';
const VAULT = { current: `0x${'22'.repeat(20)}`, previous: '0x4386FDbdA35D995beB3BF8625118Ec5982ec81fe',
    retired: `0x${'66'.repeat(20)}` };
const DESTINATION = `0x${'34'.repeat(20)}`;
const ORIGIN = 'https://zkapi-v2c-mainnet.example.test';
const hash = digit => `0x${digit.repeat(64)}`;
const SECRET = name => `SECRET-${name}`;

// ---------------------------------------------------------------------------
// Environment: fake IndexedDB, Web Locks and storage; stubbed network and
// proof worker. The SDK is imported only after this is in place.
// ---------------------------------------------------------------------------

const env = createFakeEnvironment();
env.install({ broadcast: false });
globalThis.localStorage = createFakeStorage();
globalThis.sessionStorage = createFakeStorage();
globalThis.location = new URL('https://host.example/app/');
globalThis.window = Object.assign(new EventTarget(), {
    location: globalThis.location, localStorage: globalThis.localStorage, setInterval, clearInterval, setTimeout, clearTimeout
});

const shipped = JSON.parse(await fs.readFile(path.join(SDK, 'assets/config/mainnet.json'), 'utf8'));
const { deployment_status: _placeholder, ...shippedPins } = shipped.trusted_deployment;
const PROFILE = {
    ...shipped,
    deployment_manifest_url: `${ORIGIN}/config.json`,
    allowed_deployment_manifest_urls: [`${ORIGIN}/config.json`],
    trusted_deployment: {
        ...shippedPins,
        deployment_id: CURRENT,
        contract_address: VAULT.current,
        deploy_block: 1_000_002,
        protocol_server_url: ORIGIN,
        indexer_url: ORIGIN,
        state_signing_key: {
            x: '0x25a4453190e930f9716eebcab165170706d31d1b3969d106a50d7ae374a23d61',
            y: '0x1b0f74306dfce1371752a0d7c7d27359c398b8305798492fd1095074c0639953'
        },
        clearance_signing_key: {
            x: '0x2b8dc190013bb10de72398ca462027f21b7a35eb6cb957b9319d76bd3c3c1b7d',
            y: '0xa6744dc1bc99bf78b29d6e76db2a0b5598c79d1ce2377b9044aa9dc323dd963'
        },
        verifier_url: 'https://verifier.example.test'
    }
};
const T = PROFILE.trusted_deployment;
const SETTLEMENT_WINDOW = T.settlement_window_seconds;

const servedManifest = () => ({
    protocol_version: 2, proof_backend: 'groth16_bn254',
    proof_setup: { circuit_id: T.circuit_id, setup_id: T.setup_id,
        request_proving_key_sha256: T.request_proving_key_sha256,
        withdrawal_proving_key_sha256: T.withdrawal_proving_key_sha256 },
    deployment_id: T.deployment_id, contract_address: T.contract_address, chain_id: T.chain_id,
    protocol_server_url: T.protocol_server_url, indexer_url: T.indexer_url, billing_asset: T.billing_asset,
    billing_unit: T.billing_unit, native_asset_wei_per_unit: T.native_asset_wei_per_unit,
    native_price_feed_address: T.native_price_feed_address, native_price_feed_decimals: T.native_price_feed_decimals,
    native_price_max_age_seconds: T.native_price_max_age_seconds, rpc_url: T.rpc_url, billing_token_address: null,
    request_charge_cap: T.request_charge_cap, state_signing_key: T.state_signing_key,
    clearance_signing_key: T.clearance_signing_key, models: ['model-a'],
    privacy_mode: { openrouter_inference_base: T.openrouter_inference_base, verifier_url: T.verifier_url }
});

const net = { manifest: 'ok', evidence: null };
const never = () => new Promise(() => {});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const word = value => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
globalThis.fetch = async (target, init = {}) => {
    const address = String(target);
    if (address.endsWith('/browser-config.json')) return json(PROFILE);
    if (address.endsWith('/config.json')) {
        if (net.manifest === 'missing') return new Response('', { status: 404 });
        if (net.manifest === 'hang') return never();
        if (net.manifest === 'changed') return json({ ...servedManifest(), state_signing_key: { x: '0x1', y: '0x2' } });
        if (net.manifest === 'legacy') {
            const legacy = servedManifest();
            legacy.proof_setup.circuit_id = 'zkapi-v2-note-bound-v1';
            return json(legacy);
        }
        return json(servedManifest());
    }
    if (address.includes('/v1/tree/snapshot')) return json({ next_note_id: 8 });
    if (/\/v2\/nullifiers\/[^/]+\/evidence$/.test(address) && net.evidence) return json(net.evidence);
    if (address.startsWith(T.rpc_url)) {
        const { method } = JSON.parse(init.body);
        if (method === 'eth_chainId') return json({ jsonrpc: '2.0', id: 1, result: `0x${Number(T.chain_id).toString(16)}` });
        return json({ jsonrpc: '2.0', id: 1, result: word(0) });
    }
    return never();
};
const WORKER_ANSWERS = {
    identity: () => ({ circuit_id: T.circuit_id, setup_id: T.setup_id }),
    withdrawalNullifier: () => '0x5234',
    successorNullifier: () => '0x6234',
    verifyRequest: () => true,
    treePath: () => ({ active_root: '0x0', note_id: 7, siblings: Array.from({ length: 32 }, () => '0x0'), source: 'indexer' })
};
globalThis.Worker = class {
    constructor() { this.listeners = {}; }

    addEventListener(type, listener) { this.listeners[type] = listener; }

    postMessage({ id, operation }) {
        const answer = WORKER_ANSWERS[operation];
        const result = answer ? answer() : {};
        queueMicrotask(() => this.listeners.message?.({ data: { id, result } }));
    }
};

const { configureBrowserSdk } = await import(url(path.join(SDK, 'configure.js')));
configureBrowserSdk({
    configUrl: 'https://host.example/zkapi/v2c/browser-config.json',
    workerUrl: 'https://host.example/zkapi/v2c/assets/zkapiWasmWorker.js'
});
const { BrowserWalletRuntime } = await import(url(path.join(SDK, 'services/browserWalletRuntime.js')));
const { ZkapiClient } = await import(url(path.join(SDK, 'services/zkapiClient.js')));
const store = await import(url(path.join(SDK, 'services/browserWalletStore.js')));
const exitPolicy = await import(url(path.join(SDK, 'services/zkapiExitPolicy.mjs')));
const requestArchive = await import(url(path.join(SDK, 'services/zkapiRequestArchive.mjs')));
const expiryHistory = await import(url(path.join(SDK, 'services/zkapiExpiryHistory.mjs')));
const nativeEth = await import(url(path.join(SDK, 'services/zkapiNativeEth.mjs')));
const requestCompat = await import(url(path.join(SDK, 'services/zkapiRequestCompat.mjs')));

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

const DAY = 86_400;
const DB_NAME = 'zkapi-browser-wallet-v1';
// Inside this repository every runtime wait is short: the stubbed operator
// either answers at once or never.
const FAST_TIMING = () => ({ callTimeoutMs: 150, recoveryBudgetMs: 400, operatorCallTimeoutMs: 400, exitProofValiditySeconds: 10_800 });

// A note state as the SDK's wasm emits it; only the identity fields the
// snapshot and the exit rules read are meaningful, secrets are markers.
function noteState(changes = {}) {
    return {
        protocol_version: 2, chain_id: T.chain_id, contract_address: VAULT.current, note_id: 7,
        secret_s: SECRET('secret_s'), deposit_amount: 5_000_000, expiry_ts: NOW_S + 14 * DAY, current_balance: 4_200_000,
        balance_blinding: SECRET('balance_blinding'), current_commitment_x: '0x1', current_commitment_y: '0x2',
        current_anchor: '0x1234', is_genesis: false, state_signature: { r: '0x1', s: '0x2' }, prev_anchor: '0x1233',
        bound_at_state: 0,
        deposit_path: { active_root: '0x51', siblings: Array.from({ length: 32 }, (_, index) => `0x${index + 1}`) },
        ...changes
    };
}

const requestJournal = (id, createdAtMs) => ({
    nullifier: '0x5234', client_request_id: id, created_at_ms: createdAtMs,
    prepared_request: { client_request_id: id, public_inputs: { request_time: Math.floor(createdAtMs / 1000) },
        proof: SECRET('request-proof') },
    user_rerandomization: SECRET('rerandomization')
});

const depositReceipt = (noteId, createdAt) => ({
    operationId: `deposit-op-${noteId}`, createdAt, confirmedAt: createdAt + 90_000, transactionHash: hash('a'),
    fundingAddress: `0x${'11'.repeat(20)}`, receiptBlockHash: hash('b'), receiptBlockNumber: 1_000_100 + noteId,
    feeWei: '2100000000000', gasUsed: '100000', effectiveGasPrice: '21000000'
});

// A withdrawal record as the SDK's runtime stores it, built from the fields
// its own code sets on the path to that phase. `state`, plans and nullifiers
// are what the snapshot strips; they carry markers.
function withdrawalRecord(changes) {
    const deploymentId = changes.deploymentId || CURRENT;
    const vault = deploymentId === CURRENT ? VAULT.current : deploymentId === PREVIOUS ? VAULT.previous : VAULT.retired;
    const noteId = changes.noteId;
    return {
        recordId: `${deploymentId}:1:${vault.toLowerCase()}:${noteId}`,
        deploymentId, chainId: 1, contractAddress: vault, mode: 'escape', phase: 'closed_unconfirmed',
        destination: DESTINATION, finalBalance: 4_000_000, createdAt: GENERATED_AT_MS - 3 * DAY * 1000, revision: 1,
        state: noteState({ note_id: noteId, contract_address: vault, expiry_ts: NOW_S + 10 * DAY }),
        withdrawalNullifier: SECRET('withdrawal-nullifier'),
        ...changes
    };
}

// Reset the shared wallet database through its own connection (the store
// module caches one, so the fake cannot simply be dropped).
async function resetWalletDatabase() {
    const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 3);
        request.onupgradeneeded = () => {
            for (const [name, options] of [['runtime', undefined], ['archives', { keyPath: 'archiveId' }],
                ['withdrawals', { keyPath: 'recordId' }], ['deposits', { keyPath: 'recordId' }]]) {
                if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, options);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const names = [...database.objectStoreNames];
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(names, 'readwrite');
        for (const name of names) transaction.objectStore(name).clear();
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
    });
    database.close();
}

// A started SDK runtime over a wallet seeded through the store's own write
// functions, then re-read by the runtime's own reload().
async function seededRuntime({ manifest = 'ok', slot = null, receipt = null, archive = [], records = [] } = {}) {
    await resetWalletDatabase();
    net.manifest = manifest;
    net.evidence = null;
    const runtime = new BrowserWalletRuntime();
    runtime.exitTiming = FAST_TIMING;
    await runtime.init();
    await store.commitBrowserWallet({ deploymentId: CURRENT, billingAsset: 'native_eth', ...(slot || {}) },
        { requestArchive: archive, depositConfirmation: receipt });
    for (const record of records) await store.putBrowserWithdrawal(record);
    await runtime.reload();
    return runtime;
}

// The snapshot the host's adapters read: a real ZkapiClient holding the
// runtime's own snapshot (the facade adds the runtime slot, kept apart here).
function clientView(runtime, withNote) {
    const snapshot = runtime.snapshot();
    const state = runtime.runtime.state;
    const client = new ZkapiClient();
    client.config = snapshot.config;
    // The proof worker's walletStatus() is wasm; this is its shape, seeded.
    client.wallet = withNote && state ? {
        has_note: true, pending_request: false,
        note: { note_id: state.note_id, deposit_amount: state.deposit_amount, current_balance: state.current_balance,
            expiry_ts: state.expiry_ts, is_genesis: state.is_genesis }
    } : { has_note: false, pending_request: false, note: null };
    client.withdrawals = snapshot.withdrawals;
    client.deposits = snapshot.deposits;
    client.initialized = true;
    return { clientSnapshot: client.snapshot(), runtime: runtime.runtime };
}

// ---------------------------------------------------------------------------
// Scenarios: the whole client snapshot, as a host adapter receives it
// ---------------------------------------------------------------------------

const scenarios = {};
async function scenario(name, description, options, build = null) {
    const runtime = await seededRuntime(options);
    scenarios[name] = { description, ...clientView(runtime, true) };
    if (build) await build(runtime, scenarios[name]);
}

// The exit lock and kinds are built by the SDK's own policy functions.
const escapeLock = () => exitPolicy.recordReleasedProof(
    exitPolicy.newExitLock({ noteId: 7, anchor: '0x1234', mode: 'escape', now: NOW_S - 30 }),
    { kind: exitPolicy.WITHDRAWAL_KIND.escape, validUntil: NOW_S + 10_800, conceded: 0, nullifier: '0x5234', at: NOW_S - 30 });
const mutualLockWithOwnership = () => exitPolicy.recordReleasedProof(
    exitPolicy.newExitLock({ noteId: 7, anchor: '0x1234', mode: 'mutual', now: NOW_S - 30 }),
    { kind: exitPolicy.WITHDRAWAL_KIND.ownership, validUntil: NOW_S + 3_300, nullifier: '0x5234', at: NOW_S - 30 });

await scenario('service_missing', 'Exit-only: the operator manifest is not served (404). Code deployment_manifest_unavailable.',
    { manifest: 'missing', slot: { state: noteState(), stateSeq: 2 }, receipt: depositReceipt(7, GENERATED_AT_MS - 5 * DAY * 1000) });
await scenario('service_changed', 'Exit-only: the served manifest changed a pinned key. Code deployment_manifest_mismatch.',
    { manifest: 'changed', slot: { state: noteState(), stateSeq: 2 }, receipt: depositReceipt(7, GENERATED_AT_MS - 5 * DAY * 1000) });
await scenario('service_legacy', 'Exit-only: the served manifest is the legacy circuit. Code incompatible_proof_circuit, with status 503 and exits true on an attempt.',
    { manifest: 'legacy', slot: { state: noteState(), stateSeq: 2 }, receipt: depositReceipt(7, GENERATED_AT_MS - 5 * DAY * 1000) });
await scenario('kit_never_exported', 'A healthy note whose exit kit was never exported (exported_seq null, state_seq 1).',
    { slot: { state: noteState({ current_balance: 5_000_000, is_genesis: true, prev_anchor: null }), stateSeq: 1 },
        receipt: depositReceipt(7, GENERATED_AT_MS - 1 * DAY * 1000) });
await scenario('kit_out_of_date', 'A kit exported at state 1 while the note advanced to state 3.',
    { slot: { state: noteState(), stateSeq: 3, exitKitExportedSeq: 1 }, receipt: depositReceipt(7, GENERATED_AT_MS - 5 * DAY * 1000) });
await scenario('near_expiry', 'One minute inside the near-expiry threshold (expiry minus must_initiate_by margin minus window minus 4,500 s).',
    { slot: { state: noteState({ expiry_ts: NOW_S + 43_200 + SETTLEMENT_WINDOW + 4_500 - 60 }), stateSeq: 2 },
        receipt: depositReceipt(7, GENERATED_AT_MS - 20 * DAY * 1000) });
await scenario('just_outside_near_expiry', 'One hour outside the near-expiry threshold.',
    { slot: { state: noteState({ expiry_ts: NOW_S + 43_200 + SETTLEMENT_WINDOW + 4_500 + 3_600 }), stateSeq: 2 },
        receipt: depositReceipt(7, GENERATED_AT_MS - 20 * DAY * 1000) });

{
    const state = noteState({ bound_at_state: 1_000_000 });
    const created = GENERATED_AT_MS - 600_000;
    const journal = requestRecord(state, 'req-1', created);
    await scenario('unresolved_request_settlement_wait',
        'A transmitted request the server reserved but did not settle: state_fresh false, an escape_at, a bound.',
        { slot: { state, stateSeq: 2 }, archive: [journal], receipt: depositReceipt(7, GENERATED_AT_MS - 5 * DAY * 1000) });
}
function requestRecord(state, id, createdAtMs) {
    return requestArchive.buildRequestJournalRecord({ deploymentId: CURRENT, state, journal: requestJournal(id, createdAtMs),
        disposition: 'pending', observations: [{ status: 'reserved', context: 'recovery', at: createdAtMs + 5_000 }],
        now: GENERATED_AT_MS });
}

await scenario('mutual_lock_with_ownership_proof', 'A mutual close in progress: the exit lock holds a released ownership proof.',
    { slot: { state: noteState(), stateSeq: 2, exitLock: mutualLockWithOwnership() }, receipt: depositReceipt(7, GENERATED_AT_MS - 5 * DAY * 1000) });
await scenario('escape_lock_released_proof', 'An escape in progress: a released kind-0 proof freezes the note until it expires.',
    { slot: { state: noteState(), stateSeq: 2, exitLock: escapeLock(), preparedWithdrawal: {
        operationId: 'op-escape-1', mode: 'escape', phase: 'prepared', noteId: 7, destination: DESTINATION,
        clearanceReserved: false, withdrawalNullifier: SECRET('withdrawal-nullifier'),
        public_inputs: { note_id: 7, final_balance: 4_200_000, conceded: 0, kind: 0, valid_until: NOW_S + 10_800 },
        proof: SECRET('escape-proof'), createdAt: GENERATED_AT_MS - 30_000 } },
    receipt: depositReceipt(7, GENERATED_AT_MS - 5 * DAY * 1000) });
await scenario('device_not_newest_evidence', 'Finalized defeat evidence at the current state: another device spent its successor.',
    { slot: { state: noteState(), stateSeq: 2 }, receipt: depositReceipt(7, GENERATED_AT_MS - 5 * DAY * 1000),
        archive: [requestArchive.buildRequestEvidenceRecord({ deploymentId: CURRENT, noteId: 7, anchor: '0x1234',
            nullifier: '0x5234', evidence: { transactionHash: hash('c'), blockNumber: 99 }, now: GENERATED_AT_MS })] });

await scenario('withdrawals_alert_credited_defeated',
    'No slot note; own records: an alerted close, a credited payout (receipt evidence), a credited payout (vault credit, amount unknown), a claimed credit, a defeated restored escape and a set-aside note near its deadline.',
    { records: [
        withdrawalRecord({ noteId: 2, phase: 'closed', payoutVerified: true, payoutAlert: 'concession_exceeded_bound',
            stateBalance: '5000000', concededAtInit: '0', boundAtState: '1000000', concededCurrent: '2000000',
            concededFinal: '2000000', finalBalance: 3_000_000, closeBlockNumber: 90 }),
        withdrawalRecord({ noteId: 3, phase: 'closed_unconfirmed', payoutCredited: true, payoutVerified: false,
            creditedAmount: 800_000, payoutCreditEvidence: 'receipt', finalBalance: 800_000, stateBalance: '1000000',
            concededAtInit: '200000', boundAtState: '300000', concededCurrent: '200000', concededFinal: '200000',
            closeBlockNumber: 100, lastObservedBlock: 101 }),
        withdrawalRecord({ noteId: 4, phase: 'closed', payoutCredited: true, payoutVerified: false, creditedAmount: null,
            payoutCreditEvidence: 'vault_credit', finalBalance: 500_000, closeBlockNumber: 110 }),
        withdrawalRecord({ noteId: 5, phase: 'closed', payoutCredited: true, payoutVerified: true, payoutClaimed: true,
            payoutClaimEvidence: 'claim_receipt', payoutClaimTransactionHash: hash('d'), payoutClaimBlockNumber: 120,
            payoutClaimedAmount: 100_000, creditedAmount: 100_000, finalBalance: 100_000, closeBlockNumber: 105 }),
        withdrawalRecord({ noteId: 6, phase: 'restored', chainStatus: 'active', deviceNotNewest: true,
            challengeEvidence: { transactionHash: hash('e'), blockNumber: 99, secret: SECRET('challenge-evidence') },
            error: 'The escape was defeated: another device spent this balance’s next state, so this device is not the newest. Restore the newest backup or exit kit.' }),
        withdrawalRecord({ noteId: 8, phase: 'parked', mode: 'mutual', clearanceReserved: true, finalBalance: 3_000_000,
            state: noteState({ note_id: 8, expiry_ts: NOW_S + 3 * DAY + 43_200 }) })
    ] });

{
    // Other deployments' records: the loaded deployment's runtime can neither
    // act on them nor list them, so the SDK reports them under config.
    const other = (deploymentId, noteId, changes) => withdrawalRecord({ deploymentId, noteId, ...changes });
    await scenario('other_deployments',
        'Empty slot; records of two other deployments: an open escape, a credit still awaiting finality (in both lists) and a settled credit.',
        { records: [
            other(PREVIOUS, 11, { mode: 'escape', phase: 'pending', chainStatus: 'pending_withdrawal', startBlockNumber: 50,
                state: noteState({ note_id: 11, contract_address: VAULT.previous, expiry_ts: NOW_S + 5 * DAY }) }),
            other(PREVIOUS, 12, { mode: 'mutual', phase: 'parked', clearanceReserved: true,
                state: noteState({ note_id: 12, contract_address: VAULT.previous, expiry_ts: NOW_S + 6 * DAY }) }),
            other(RETIRED, 20, { phase: 'closed_unconfirmed', payoutCredited: true, payoutVerified: false,
                creditedAmount: 1_500_000, payoutCreditEvidence: 'receipt', finalBalance: 1_500_000, closeBlockNumber: 70 }),
            other(RETIRED, 21, { phase: 'closed', payoutCredited: true, payoutVerified: false, creditedAmount: 42,
                payoutCreditEvidence: 'receipt', finalBalance: 42, closeBlockNumber: 71 })
        ] });
}

// ---------------------------------------------------------------------------
// Error shapes, from the real runtime's own code paths
// ---------------------------------------------------------------------------

const errors = {};
function recordError(name, producedBy, error, { handSeeded = false } = {}) {
    errors[name] = {
        producedBy, handSeeded,
        name: error.name, status: error.status ?? null, code: error.code ?? null, data: error.data ?? null, message: error.message
    };
}
async function capture(name, producedBy, action, options) {
    try {
        await action();
    } catch (error) {
        recordError(name, producedBy, error, options);
        return error;
    }
    throw new Error(`${name}: the SDK did not refuse`);
}

{
    let runtime = await seededRuntime({ manifest: 'missing', slot: { state: noteState(), stateSeq: 2 } });
    await capture('service_unavailable', 'runtime.assertServiceAvailable() with the manifest served as 404',
        () => runtime.assertServiceAvailable());
    runtime = await seededRuntime({ manifest: 'changed', slot: { state: noteState(), stateSeq: 2 } });
    await capture('service_mismatch', 'runtime.assertServiceAvailable() with a changed pin', () => runtime.assertServiceAvailable());
    runtime = await seededRuntime({ manifest: 'legacy', slot: { state: noteState(), stateSeq: 2 } });
    await capture('service_incompatible', 'runtime.assertServiceAvailable() with the legacy circuit served',
        () => runtime.assertServiceAvailable());
    runtime = await seededRuntime({ slot: { state: noteState(), stateSeq: 2 } });
    await capture('native_vault_unverified', 'runtime.assertServiceAvailable() while the pinned RPC cannot confirm the vault',
        () => runtime.assertServiceAvailable());
    runtime = await seededRuntime({ slot: { state: noteState({ expiry_ts: NOW_S + 43_200 + SETTLEMENT_WINDOW + 4_500 - 60 }), stateSeq: 2 } });
    await capture('note_near_expiry', 'runtime.prepareLeaseRequest() near expiry', () => runtime.prepareLeaseRequest(() => {}, null, 1));
    runtime = await seededRuntime({ slot: { state: noteState(), stateSeq: 2, exitLock: escapeLock() } });
    await capture('exit_locked', 'runtime.prepareLeaseRequest() while an exit proof is live',
        () => runtime.prepareLeaseRequest(() => {}, null, 1));
}
{
    const state = noteState({ bound_at_state: 1_000_000 });
    const record = requestRecord(state, 'req-1', GENERATED_AT_MS - 600_000);
    const runtime = await seededRuntime({ slot: { state, stateSeq: 2 }, archive: [record] });
    await capture('request_settlement_pending_chat', 'runtime.assertAnchorAcceptsRequest(state) with a reserved request archived',
        async () => runtime.assertAnchorAcceptsRequest(state));
    await capture('request_settlement_pending_withdraw', 'runtime.prepareWithdrawal(mutual) with an unresolved request at the state',
        () => runtime.prepareWithdrawal('mutual', DESTINATION));
}
{
    const state = noteState();
    const evidence = requestArchive.buildRequestEvidenceRecord({ deploymentId: CURRENT, noteId: 7, anchor: '0x1234',
        nullifier: '0x5234', evidence: { transactionHash: hash('c'), blockNumber: 99 }, now: GENERATED_AT_MS });
    const runtime = await seededRuntime({ slot: { state, stateSeq: 2 }, archive: [evidence] });
    await capture('device_not_newest_defeated', 'runtime.prepareWithdrawal(mutual) at a state with defeat evidence',
        () => runtime.prepareWithdrawal('mutual', DESTINATION));
}
{
    const runtime = await seededRuntime({ slot: { state: noteState(), stateSeq: 2 } });
    net.evidence = { public_inputs: { request_nullifier: '0x6234' }, proof: SECRET('evidence-proof') };
    await capture('device_not_newest_successor', 'runtime.staleDeviceCheckLocked(state) with verified operator evidence',
        () => runtime.staleDeviceCheckLocked(runtime.runtime.state));
    net.evidence = null;
}
{
    // A kept ownership proof that expires within seconds, as the withdrawal-only
    // marker keeps it after a cancel.
    const runtime = await seededRuntime({ slot: { state: noteState(), stateSeq: 2, preparedWithdrawal: {
        phase: 'reserving', mode: 'mutual', operationId: 'op-1', noteId: 7, destination: DESTINATION,
        withdrawalNullifier: '0x5234', clearanceReserved: true,
        ownershipProof: { public_inputs: { valid_until: NOW_S + 3, withdrawal_nullifier: '0x5234', active_root: '0x0' },
            proof: SECRET('ownership-proof') },
        createdAt: GENERATED_AT_MS } } });
    await capture('ownership_proof_wait', 'runtime.prepareWithdrawal(mutual) with a kept ownership proof about to expire',
        () => runtime.prepareWithdrawal('mutual', DESTINATION));
}
{
    // A dead escape lock, a late successor waiting at its state, finality unknown.
    const state = noteState({ bound_at_state: 1_000_000 });
    let lock = exitPolicy.newExitLock({ noteId: 7, anchor: '0x1234', mode: 'escape', now: NOW_S - 20_000 });
    lock = exitPolicy.recordReleasedProof(lock, { kind: exitPolicy.WITHDRAWAL_KIND.escape, validUntil: NOW_S - 10_000,
        conceded: 0, nullifier: '0x5234', at: NOW_S - 20_000 });
    let record = requestRecord(state, 'req-9', GENERATED_AT_MS - 30_000_000);
    record = requestArchive.mergeRequestArchiveRecord(record, { archiveId: record.archiveId, disposition: 'late_successor',
        lateResponse: { receipt: SECRET('late-response') } }, GENERATED_AT_MS);
    const runtime = await seededRuntime({ slot: { state, stateSeq: 2, exitLock: lock }, archive: [record] });
    await capture('exit_release_pending', 'runtime.prepareWithdrawal(mutual) with a dead lock and a late successor at its state',
        () => runtime.prepareWithdrawal('mutual', DESTINATION));
}
{
    // The installed legacy SDK's own refusal of a manifest of another circuit.
    // It is a plain Error with a code: no status, no data, no exits.
    globalThis.localStorage = createFakeStorage();
    const legacyConfigure = await import(url(path.join(LEGACY_SDK, 'configure.js')));
    legacyConfigure.configureBrowserSdk({ configUrl: 'https://host.example/zkapi/browser-config.json' });
    const legacy = await import(url(path.join(LEGACY_SDK, 'services/browserWalletRuntime.js')));
    const runtime = new legacy.BrowserWalletRuntime();
    const manifest = { ...servedManifest(), proof_setup: { circuit_id: 'zkapi-v2-concession-v1' } };
    let refusal = null;
    try {
        runtime.validateManifest(manifest);
    } catch (error) {
        refusal = error;
    }
    if (!refusal) throw new Error('the legacy SDK accepted a manifest of another circuit');
    errors.legacy_incompatible_proof_circuit = {
        producedBy: 'the installed legacy SDK BrowserWalletRuntime.validateManifest()', handSeeded: false,
        name: refusal.name, status: refusal.status ?? null, code: refusal.code ?? null, data: refusal.data ?? null,
        message: refusal.message
    };
}

// ---------------------------------------------------------------------------
// The wallet database, as the real store leaves it after a history that spans
// three deployments, plus the SDK's own public views of it
// ---------------------------------------------------------------------------

await resetWalletDatabase();
const DB_NOTES = [];
{
    const slotFor = (deploymentId, vault, noteId, balance, expiry, stateSeq = 1) => ({
        deploymentId, billingAsset: 'native_eth', stateSeq,
        state: noteState({ note_id: noteId, contract_address: vault, deposit_amount: 2_000_000, current_balance: balance,
            expiry_ts: expiry })
    });
    const committed = async (deploymentId, vault, noteId, balance, expiry, createdAt, hashDigit, extra = {}) => {
        await store.commitBrowserWallet({ ...slotFor(deploymentId, vault, noteId, balance, expiry), ...extra }, {
            depositConfirmation: { ...depositReceipt(noteId, createdAt), transactionHash: hash(hashDigit) }
        });
    };

    // PREVIOUS (legacy vault): a returned close, a set-aside note, an expiry
    // claim and an expired note nobody claimed.
    await committed(PREVIOUS, VAULT.previous, 5, 1_900_000, NOW_S - 20 * DAY, GENERATED_AT_MS - 60 * DAY * 1000, '1', {
        preparedWithdrawal: { mode: 'mutual', phase: 'submitted', noteId: 5, destination: DESTINATION,
            withdrawalNullifier: '0x2a', proof: [SECRET('proof')], clearanceReserved: true } });
    const detached = await store.detachBrowserClosedWithdrawal({
        recordId: `${PREVIOUS}:1:${VAULT.previous.toLowerCase()}:5`, deploymentId: PREVIOUS, chainId: 1,
        contractAddress: VAULT.previous, mode: 'mutual', noteId: 5, destination: DESTINATION, finalBalance: 1_900_000,
        transactionHash: hash('c'), closeBlockNumber: 120, payoutVerified: true,
        createdAt: GENERATED_AT_MS - 59 * DAY * 1000, closedAt: GENERATED_AT_MS - 58 * DAY * 1000 });
    await store.updateBrowserWithdrawal(detached.withdrawal.recordId, { phase: 'closed', chainStatus: 'closed',
        payoutVerified: true, closedAt: GENERATED_AT_MS - 57 * DAY * 1000, closeBlockNumber: 120, finalizedBlockNumber: 150,
        lastObservedBlock: 151 }, { sanitize: true });
    DB_NOTES.push({ deploymentId: PREVIOUS, noteId: 5, story: 'deposit, close returned, record sanitized' });

    await committed(PREVIOUS, VAULT.previous, 6, 3_000_000, NOW_S + 6 * DAY, GENERATED_AT_MS - 20 * DAY * 1000, '2', {
        preparedWithdrawal: { mode: 'mutual', phase: 'prepared', noteId: 6, destination: DESTINATION, clearanceReserved: true,
            operationId: 'op-6', withdrawalNullifier: '0x2a', proof: SECRET('proof'),
            clearance: { signature: SECRET('clearance-signature'), withdrawal_nullifier: '0x2a' } } });
    await store.parkBrowserWithdrawal({ recordId: `${PREVIOUS}:1:${VAULT.previous.toLowerCase()}:6`, deploymentId: PREVIOUS,
        chainId: 1, contractAddress: VAULT.previous, mode: 'mutual', phase: 'parked', noteId: 6, destination: DESTINATION,
        finalBalance: 3_000_000, createdAt: GENERATED_AT_MS - 19 * DAY * 1000 });
    DB_NOTES.push({ deploymentId: PREVIOUS, noteId: 6, story: 'deposit, close set aside (parked), still open' });

    await committed(PREVIOUS, VAULT.previous, 7, 500_000, NOW_S - 30 * DAY, GENERATED_AT_MS - 70 * DAY * 1000, '3');
    await store.recordBrowserExpiryClaims(PREVIOUS, [{ noteId: 7, amount: 2_000_000, transactionHash: hash('f'),
        blockHash: hash('9'), blockNumber: 777, claimedAt: (NOW_S - 29 * DAY) * 1000 }]);
    await store.archiveBrowserWallet('expiry-claimed', 7);
    DB_NOTES.push({ deploymentId: PREVIOUS, noteId: 7, story: 'deposit, expired, claimed by the treasury, archived' });

    await committed(PREVIOUS, VAULT.previous, 8, 400_000, NOW_S - 10 * DAY, GENERATED_AT_MS - 50 * DAY * 1000, '4');
    await store.archiveBrowserWallet('closed', 8);
    DB_NOTES.push({ deploymentId: PREVIOUS, noteId: 8, story: 'deposit, expired, no claim and no close' });

    // CURRENT: a credited escape, an alert, a claim, and the slot note.
    await store.putBrowserWithdrawal(withdrawalRecord({ noteId: 3, phase: 'closed_unconfirmed', payoutCredited: true,
        payoutVerified: false, creditedAmount: 800_000, payoutCreditEvidence: 'receipt', finalBalance: 800_000,
        stateBalance: '1000000', concededAtInit: '200000', boundAtState: '300000', concededCurrent: '200000',
        concededFinal: '200000', closeBlockNumber: 100, lastObservedBlock: 101, chainStatus: 'closed',
        startBlockNumber: 90, finalizedBlockNumber: 95, transactionHash: hash('5') }));
    await store.putBrowserWithdrawal(withdrawalRecord({ noteId: 4, phase: 'closed', payoutCredited: true,
        payoutVerified: true, payoutClaimed: true, payoutClaimEvidence: 'claim_receipt', payoutClaimTransactionHash: hash('d'),
        payoutClaimBlockNumber: 120, payoutClaimedAmount: 100_000, creditedAmount: 100_000, finalBalance: 100_000,
        closeBlockNumber: 105, chainStatus: 'closed', transactionHash: hash('6') }));
    await store.putBrowserWithdrawal(withdrawalRecord({ noteId: 2, phase: 'closed', payoutVerified: true,
        payoutAlert: 'concession_exceeded_bound', stateBalance: '5000000', concededAtInit: '0', boundAtState: '1000000',
        concededFinal: '2000000', finalBalance: 3_000_000, closeBlockNumber: 90, chainStatus: 'closed',
        transactionHash: hash('7') }));
    await store.putBrowserWithdrawal(withdrawalRecord({ noteId: 6, phase: 'restored', chainStatus: 'active',
        deviceNotNewest: true, challengeEvidence: { transactionHash: hash('e'), blockNumber: 99 } }));
    await committed(CURRENT, VAULT.current, 9, 1_800_000, NOW_S + 20 * DAY, GENERATED_AT_MS - 2 * DAY * 1000, '8', { stateSeq: 3 });
    // A request journal and challenge evidence: proofs that the history must
    // never read (their archive ids carry the two prefixes).
    await store.putBrowserRequestArchive([
        requestRecord(noteState({ note_id: 9, contract_address: VAULT.current, current_anchor: '0x7777' }), 'req-history',
            GENERATED_AT_MS - 3_600_000),
        requestArchive.buildRequestEvidenceRecord({ deploymentId: CURRENT, noteId: 9, anchor: '0x7777', nullifier: '0x8888',
            evidence: { transactionHash: hash('c'), blockNumber: 99, secret: SECRET('evidence') }, now: GENERATED_AT_MS })
    ], { deploymentId: CURRENT });

    // RETIRED (a deployment no registry row names): one returned note.
    await store.putBrowserWithdrawal(withdrawalRecord({ deploymentId: RETIRED, noteId: 1, mode: 'mutual', phase: 'closed',
        payoutVerified: true, finalBalance: 77_000, chainStatus: 'closed', transactionHash: hash('2') }));
}

// The SDK's own public views of that database, per deployment: the oracle
// the host's history reader is compared with. Reading is not free of effect:
// the SDK back-fills a deposit row for every note it finds in a record or an
// archive. The dump is taken after those reads, which is the state of a
// database whose deployments were each loaded once.
const sdkViews = {};
for (const deploymentId of [CURRENT, PREVIOUS, RETIRED]) {
    const snapshot = await store.readBrowserWalletSnapshot(deploymentId);
    sdkViews[deploymentId] = {
        deposits: snapshot.deposits,
        expiryRecords: expiryHistory.deriveExpiryRecords(snapshot.deposits, snapshot.withdrawals, GENERATED_AT_MS),
        otherDeploymentWithdrawals: snapshot.otherDeploymentWithdrawals,
        otherDeploymentCredits: snapshot.otherDeploymentCredits,
        withdrawalIds: snapshot.withdrawals.map(record => record.recordId)
    };
}
const walletDump = env.idb.dump()[DB_NAME];

// ---------------------------------------------------------------------------
// Oracle vectors: the SDK's own functions over seeded inputs
// ---------------------------------------------------------------------------

function mulberry32(seed) {
    let value = seed >>> 0;
    return () => {
        value = (value + 0x6d2b79f5) | 0;
        let t = Math.imul(value ^ (value >>> 15), 1 | value);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const random = mulberry32(0x0a11ce);
const pick = list => list[Math.floor(random() * list.length)];

const expiryVectors = [];
for (let index = 0; index < 100; index += 1) {
    const deployments = ['D1', 'D2'];
    const deposits = [];
    const withdrawals = [];
    const notes = 1 + Math.floor(random() * 3);
    for (let noteId = 1; noteId <= notes; noteId += 1) {
        const deploymentId = pick(deployments);
        const expiryTs = NOW_S + pick([-100 * DAY, -3_600, -1, 0, 1, 3_600, 100 * DAY]);
        const amount = pick([5, 1_000, 2_000_000]);
        const claimAt = expiryTs * 1000 + pick([-5, 0, 5, 86_400_000]);
        const claim = random() < 0.25 ? {
            transactionHash: hash('a'), blockHash: hash('b'), blockNumber: pick([5, 0]), claimedAt: claimAt,
            amount: pick([amount, amount, amount + 1])
        } : null;
        deposits.push({
            recordId: `${deploymentId}:deposit:${noteId}`, deploymentId, noteId, amount, expiryTs,
            status: pick(['confirmed', 'confirmed', 'confirmed', 'pending']),
            ...(claim ? { expiryClaim: claim } : {})
        });
        const records = Math.floor(random() * 3);
        for (let record = 0; record < records; record += 1) {
            withdrawals.push({
                deploymentId: pick([deploymentId, deploymentId, pick(deployments)]), noteId,
                mode: pick(['mutual', 'escape']),
                phase: pick(['closed', 'closed_unconfirmed', 'pending', 'parked', 'restored']),
                payoutVerified: random() < 0.4, payoutCredited: random() < 0.25,
                chainStatus: pick(['closed', 'pending_withdrawal', 'active']),
                startBlockNumber: pick([0, 5, 10]), finalizedBlockNumber: pick([undefined, 4, 5, 20])
            });
        }
    }
    const nowMs = GENERATED_AT_MS + pick([0, -DAY * 1000, 40 * DAY * 1000]);
    const output = expiryHistory.deriveExpiryRecords(deposits, withdrawals, nowMs);
    expiryVectors.push({ nowMs, deposits, withdrawals, output });
}

const QUOTES = [
    ['$3,000 ETH', { answer: '300000000000', decimals: 8 }],
    ['$20,000 ETH', { answer: '2000000000000', decimals: 8 }],
    ['$200,000 ETH', { answer: '20000000000000', decimals: 8 }],
    ['$300 ETH', { answer: '30000000000', decimals: 8 }],
    ['answer 1', { answer: '1', decimals: 8 }],
    ['answer 1e6', { answer: '1000000', decimals: 8 }],
    ['answer 1e18', { answer: '1000000000000000000', decimals: 8 }],
    ['6 decimals', { answer: '3000000000', decimals: 6 }],
    ['18 decimals', { answer: '3000000000000000000000', decimals: 18 }]
];
const nativeUnitsVectors = [];
for (const [label, quote] of QUOTES) {
    for (const usd of ['0.01', '0.15', '0.5', '1', '2', '3', '4.5', '6', '1.000001', '100']) {
        let output = null;
        let error = null;
        try {
            output = String(nativeEth.nativeUnitsForUsd(usd, quote));
        } catch (cause) {
            error = cause.message;
        }
        nativeUnitsVectors.push({ label, quote, usd, output, error });
    }
}
const nativeUsdVectors = [];
for (const [label, quote] of QUOTES) {
    for (const units of ['0', '1', '999', '1000000', '5000000', '333333334', '1000000000', '9007199254740991']) {
        let output = null;
        let error = null;
        try {
            output = String(nativeEth.nativeUsdMicros(units, quote));
        } catch (cause) {
            error = cause.message;
        }
        nativeUsdVectors.push({ label, quote, units, output, error });
    }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

// Indented JSON with arrays of scalars on one line (a note's 32 path siblings
// would otherwise take 34 lines each), and `vectors` lists with one entry per
// line: the files stay reviewable in a diff.
const replacer = (key, value) => (typeof value === 'bigint' ? value.toString() : value);
const SCALAR = '(?:"(?:[^"\\\\\\n]|\\\\.)*"|-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?|true|false|null)';
const SCALAR_ARRAY = new RegExp(`\\[\\n\\s*(${SCALAR}(?:,\\n\\s*${SCALAR})*)\\n\\s*\\]`, 'g');
const compact = text => text.replace(SCALAR_ARRAY, (match, items) => `[${items.replace(/,\n\s*/g, ', ')}]`);
const serialize = value => `${compact(JSON.stringify(value, replacer, 2))}\n`;
function serializeVectors(value, listKeys) {
    const lines = ['{'];
    const keys = Object.keys(value);
    keys.forEach((key, index) => {
        const comma = index < keys.length - 1 ? ',' : '';
        if (listKeys.includes(key)) {
            lines.push(`  ${JSON.stringify(key)}: [`);
            value[key].forEach((entry, position) => lines.push(
                `    ${JSON.stringify(entry, replacer)}${position < value[key].length - 1 ? ',' : ''}`));
            lines.push(`  ]${comma}`);
        } else {
            lines.push(`  ${JSON.stringify(key)}: ${compact(JSON.stringify(value[key], replacer, 2)).replace(/\n/g, '\n  ')}${comma}`);
        }
    });
    lines.push('}');
    return `${lines.join('\n')}\n`;
}
const deployments = { current: CURRENT, previous: PREVIOUS, retired: RETIRED };

const FILES = {
    'snapshots.json': serialize({
        generatedAtMs: GENERATED_AT_MS,
        source: SOURCE,
        deployments,
        settlementWindowSeconds: SETTLEMENT_WINDOW,
        scenarios,
        errors
    }),
    'oracle-vectors.json': serializeVectors({
        generatedAtMs: GENERATED_AT_MS,
        source: SOURCE,
        chatSpendingTierUsd: [...requestCompat.CHAT_SPENDING_TIER_USD],
        nativeUnitsPerEth: String(nativeEth.NATIVE_UNITS_PER_ETH),
        deriveExpiryRecords: expiryVectors,
        nativeUnitsForUsd: nativeUnitsVectors,
        nativeUsdMicros: nativeUsdVectors
    }, ['deriveExpiryRecords', 'nativeUnitsForUsd', 'nativeUsdMicros']),
    'wallet-db-v2.json': serialize({
        generatedAtMs: GENERATED_AT_MS,
        source: SOURCE,
        databaseName: DB_NAME,
        deployments,
        vaults: VAULT,
        notes: DB_NOTES,
        dump: walletDump,
        sdkViews
    })
};

clearInterval(keepAlive);
let drift = false;
for (const [name, text] of Object.entries(FILES)) {
    const target = path.join(outDir, name);
    if (check) {
        const current = await fs.readFile(target, 'utf8').catch(() => null);
        if (current !== text) {
            drift = true;
            console.error(`${name} differs from a fresh generation`);
        }
        continue;
    }
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(target, text);
    console.log(`wrote ${path.relative(process.cwd(), target)} (${text.length} bytes)`);
}
if (check) {
    console.log(drift ? 'the committed fixtures are out of date' : 'the committed fixtures are current');
    process.exit(drift ? 1 : 0);
}
process.exit(0);
