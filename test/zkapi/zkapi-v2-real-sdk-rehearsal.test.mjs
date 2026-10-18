// Activation-time rehearsal against the REAL successor SDK.
//
// Skipped unless a successor SDK is present: installed under its registry
// alias (node_modules/<alias>, which is what activating the row does), or
// unpacked at the directory named by ZKAPI_V2_SDK_DIR. Nothing here runs in an
// ordinary checkout, and nothing here runs a script of the SDK: only its plain
// modules are imported.
//
// Run it before a successor row is made live (docs/ZKAPI_VERSIONING.md,
// "Activate a new version"). Each test names the host behavior it rehearses
// with a `wiring:<name>` prefix.
//
//   wiring:withdrawal-operation-recheck  The host half (a recheck under the
//     wallet lock, ahead of the withdrawal) passes on any revision. The SDK
//     half, the SDK refusing a prepared withdrawal that was replaced between
//     the display and `withdraw()`, exists only in a revision carrying the
//     recovery patch of the activation. A revision without it keeps the window
//     (the SDK returned the replacement's operation id in the revision this
//     was written against), so the first test below FAILS for it: that
//     failure is the evidence that the patch is still needed. A revision
//     that passes it without any patch provides the half itself, and its row
//     still lists a registered patch that covers the behavior (an entry with
//     no files is enough: PATCH_COVERAGE in scripts/patch-zkapi-sdk.mjs),
//     because the registry check and the build accept only coverage they can
//     name, never a `not_required` verdict alone.
//   wiring:credited-payouts  The client's own claimEscapePayout, driven
//     through the host's Send Ethereum signer on a chain double.
//   wiring:ownership-proof-wait  A requested mutual close the SDK turns into
//     an escape is signed within the cap the person was shown, with the
//     recovery context the SDK itself builds.
//   legacy SDK export compatibility:  exportExitKit seals a kit, marks it exported before the
//     host has delivered it, and names its failures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import { Transaction, Wallet, getAddress } from 'ethers';
import { AddressFundingProvider } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import { assertWithdrawalEscapeAvailable } from '../../chat/zkapi/services/withdrawalRecovery.mjs';
import { concessionV1 } from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { createFakeEnvironment, createFakeStorage } from './_fakeIndexedDb.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function successorRoot() {
    if (process.env.ZKAPI_V2_SDK_DIR) {
        const root = path.resolve(process.env.ZKAPI_V2_SDK_DIR);
        return fs.existsSync(path.join(root, 'sdk/wallet.js')) ? root : null;
    }
    const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'deployments/zkapi/registry.json'), 'utf8'));
    for (const row of registry.versions) {
        if (row.sdk.alias === '@openanonymity/zkapi-browser-sdk') continue;
        const root = path.join(repoRoot, 'node_modules', row.sdk.alias);
        if (fs.existsSync(path.join(root, 'sdk/wallet.js'))) return root;
    }
    return null;
}

const root = successorRoot();
const skip = root ? false : 'no successor SDK is installed (registry alias, or ZKAPI_V2_SDK_DIR)';

const DB = 'zkapi-browser-wallet-v1';
const DEPLOYMENT = 'zkapi-native-eth-sepolia-concession-v1-rehearsal';
const VAULT = `0x${'22'.repeat(20)}`;
const DESTINATION = `0x${'44'.repeat(20)}`;
const KEY = `0x${'11'.repeat(32)}`;
const OWN = new Wallet(KEY).address.toLowerCase();
const CHAIN = 11155111;
const hex = value => `0x${value.toString(16)}`;
const word = value => BigInt(value).toString(16).padStart(64, '0');
const FUNDING = { chain_id: CHAIN, contract_address: VAULT, demo_rpc_url: 'https://rpc.example', billing_asset: 'native_eth',
    billing_unit: 'gwei', native_asset_wei_per_unit: '1000000000', demo_billing_token_address: null };

// ------------------------------------------------------------------ the SDK

let sdk = null;
let env = null;
if (root) {
    if (!globalThis.crypto) globalThis.crypto = webcrypto;
    env = createFakeEnvironment();
    env.install();
    globalThis.localStorage = createFakeStorage();
    globalThis.location ??= { href: 'https://app.example/', origin: 'https://app.example', search: '' };
    // The client reaches for window only to publish change events and timers.
    globalThis.window ??= { dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setInterval: () => 0, clearInterval() {} };
    globalThis.CustomEvent ??= class CustomEvent extends Event {
        constructor(type, options) { super(type); this.detail = options?.detail; }
    };
    const services = path.join(root, 'sdk/services');
    const load = file => import(pathToFileURL(file).href);
    const [store, runtimeModule, clientModule, wallet, external] = await Promise.all([
        load(path.join(services, 'browserWalletStore.js')),
        load(path.join(services, 'browserWalletRuntime.js')),
        load(path.join(services, 'zkapiClient.js')),
        load(path.join(root, 'sdk/wallet.js')),
        load(path.join(services, 'zkapiExternalTransactions.mjs'))
    ]);
    sdk = { store, BrowserWalletRuntime: runtimeModule.BrowserWalletRuntime, runtime: runtimeModule.default,
        client: clientModule.default, codec: wallet.default, externalRecoveryContext: external.externalRecoveryContext };
}

async function wipe() {
    await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB);
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
    });
    env.trace.length = 0;
}

const note = (id = 7, overrides = {}) => ({ protocol_version: 2, note_id: id, secret_s: '0xabc', deposit_amount: 5_000_000,
    current_balance: 4_000_000, expiry_ts: Math.floor(Date.now() / 1000) + 20 * 86400, current_anchor: '0x4',
    bound_at_state: 0, ...overrides });
const plan = (operationId, extra = {}) => ({ operationId, mode: 'mutual', phase: 'prepared', noteId: 7, destination: DESTINATION,
    clearanceReserved: true, withdrawalNullifier: '0x2a', public_inputs: { note_id: 7, final_balance: 4_000_000, kind: 1 }, ...extra });

// ------------------------------------------------- the operation recheck

// What a failure of the first test below means. Against a revision without the
// recovery patch of the activation it is EXPECTED: the SDK cannot refuse a
// withdrawal that was replaced after it was displayed, so no row of that
// revision may go live (the registry check and the build refuse it too, code
// recovery_patch_coverage) until a reviewed patch provides it and this test
// passes.
const SDK_HALF_MISSING = 'ACTIVATION GATE, expected on a revision without the recovery patch: this SDK revision does '
    + 'not itself refuse a prepared withdrawal that was replaced after it was displayed, so no successor row of it may go '
    + 'live until a reviewed recovery patch covers withdrawal-operation-recheck (PATCH_COVERAGE in '
    + 'scripts/patch-zkapi-sdk.mjs; an entry with no files is enough for a revision that does it itself) and this test '
    + 'passes. ';

test('wiring:withdrawal-operation-recheck the SDK refuses to prepare or claim a withdrawal replaced after it was displayed', { skip }, async () => {
    await wipe();
    const runtime = new sdk.BrowserWalletRuntime();
    runtime.manifest = { deployment_id: DEPLOYMENT };
    runtime.config = { funding: { protocol_server_url: 'https://protocol.invalid', contract_address: VAULT, chain_id: CHAIN },
        wallet_core: {}, proving_keys: { withdrawal: {} } };
    runtime.init = async () => {};
    runtime.settleActiveLease = async () => {};
    runtime.recoverPendingLocked = async () => {};
    // Anything past the identity check is the network: reaching it is a failure.
    const SENTINEL = new Error('SENTINEL: the SDK went on to prepare a replacement proof');
    const reached = [];
    runtime.treePath = async () => { reached.push('treePath'); throw SENTINEL; };
    runtime.remoteJson = async () => { reached.push('remoteJson'); throw SENTINEL; };
    runtime.worker = { call: async method => { reached.push(`worker:${method}`); throw SENTINEL; } };
    let commits = 0;
    const commit = runtime.commit.bind(runtime);
    runtime.commit = async (...args) => { commits += 1; return commit(...args); };

    // The host displays operation A...
    await sdk.store.commitBrowserWallet({ deploymentId: DEPLOYMENT, billingAsset: 'native_eth', stateSeq: 1, state: note(),
        preparedWithdrawal: plan('op-displayed') });
    await runtime.reload();
    // ...and another tab replaces it before `withdraw()` reaches the SDK.
    await sdk.store.commitBrowserWallet({ deploymentId: DEPLOYMENT, billingAsset: 'native_eth', stateSeq: 1, state: note(),
        preparedWithdrawal: plan('op-replaced', { phase: 'reserving' }) });

    const rejection = await runtime.prepareWithdrawal('mutual', DESTINATION, {
        expectedNoteId: 7, expectedWithdrawalOperationId: 'op-displayed'
    }).then(() => null, error => error);
    assert.ok(rejection, `${SDK_HALF_MISSING}prepareWithdrawal must refuse a plan other than the one that was displayed.`);
    assert.notEqual(rejection, SENTINEL,
        `${SDK_HALF_MISSING}prepareWithdrawal went on to the network instead of refusing on identity.`);
    assert.deepEqual(reached, [], `${SDK_HALF_MISSING}something past the identity check ran.`);
    assert.equal(commits, 0, `${SDK_HALF_MISSING}a replacement was reserved or committed.`);

    // The submission claim compares the identity too, after any conversion.
    const claim = await runtime.claimPreparedWithdrawalSubmission({
        operationId: 'op-displayed', noteId: 7, mode: 'mutual', destination: DESTINATION
    }).then(value => ({ value }), error => ({ error }));
    assert.ok(claim.error, `${SDK_HALF_MISSING}claimPreparedWithdrawalSubmission returned operation `
        + `${claim.value?.operationId}: the replaced plan was claimed.`);
    assert.equal((await sdk.store.readBrowserWallet()).preparedWithdrawal.operationId, 'op-replaced',
        `${SDK_HALF_MISSING}the other tab's plan was changed.`);
});

test('wiring:withdrawal-operation-recheck the host recheck catches the same replacement under the wallet lock, on any revision', { skip }, async () => {
    await wipe();
    const runtime = new sdk.BrowserWalletRuntime();
    runtime.manifest = { deployment_id: DEPLOYMENT };
    runtime.init = async () => {};
    const client = { browserMode: true, note: { note_id: 7 }, config: {} };
    const deps = { client, runtime, withWalletLock: sdk.store.withBrowserWalletLock };
    const expected = { kind: 'note', noteId: 7, operationId: 'op-displayed' };

    await sdk.store.commitBrowserWallet({ deploymentId: DEPLOYMENT, billingAsset: 'native_eth', stateSeq: 1, state: note(),
        preparedWithdrawal: plan('op-displayed') });
    await runtime.reload();
    await assertWithdrawalEscapeAvailable(expected, deps);

    await sdk.store.commitBrowserWallet({ deploymentId: DEPLOYMENT, billingAsset: 'native_eth', stateSeq: 1, state: note(),
        preparedWithdrawal: plan('op-replaced', { phase: 'reserving' }) });
    await assert.rejects(assertWithdrawalEscapeAvailable(expected, deps), { code: 'withdrawal_note_changed' });
    await assertWithdrawalEscapeAvailable({ ...expected, operationId: 'op-replaced' }, deps);

    await sdk.store.commitBrowserWallet({ deploymentId: DEPLOYMENT, billingAsset: 'native_eth', stateSeq: 1, state: note(8) });
    await assert.rejects(assertWithdrawalEscapeAvailable({ kind: 'note', noteId: 7 }, deps), { code: 'withdrawal_note_changed' });
});

// ---------------------------------------------------- the host signer

function memoryStore() {
    const data = new Map();
    return { data, load: async scope => structuredClone(data.get(scope) ?? null),
        async save(scope, envelope, { createOnly = false } = {}) {
            if (createOnly && data.has(scope)) throw new Error('exists');
            data.set(scope, structuredClone(envelope));
        } };
}

// A chain double behind the host's own signer: reads answer from `chain`, a
// raw transaction is recorded, and a receipt exists once one was sent.
function signerWithChain(chain = {}) {
    const sent = [];
    const calls = [];
    const state = { credit: 123_456n, receipt: 'reverted', ...chain };
    const transport = async (url, options) => {
        const request = JSON.parse(options.body);
        calls.push(request.method);
        let result;
        switch (request.method) {
        case 'eth_chainId': result = hex(CHAIN); break;
        case 'eth_blockNumber': result = '0x100'; break;
        case 'eth_getTransactionCount': result = '0x0'; break;
        case 'eth_getBalance': result = '0xde0b6b3a7640000'; break;
        case 'eth_estimateGas': result = '0x186a0'; break;
        case 'eth_gasPrice': result = '0x3b9aca00'; break;
        case 'eth_getCode': result = '0x'; break;
        case 'eth_call': result = `0x${word(state.credit)}`; break;
        case 'eth_getBlockByNumber': result = { number: '0x100', hash: `0x${'77'.repeat(32)}`, baseFeePerGas: '0x1dcd6500',
            timestamp: hex(Math.floor(Date.now() / 1000)) }; break;
        case 'eth_feeHistory': {
            const count = 20;
            result = { oldestBlock: hex(0x100 - count + 1), baseFeePerGas: Array(count + 1).fill('0x1dcd6500'),
                gasUsedRatio: Array(count).fill(0.5), reward: Array.from({ length: count }, () => ['0x5f5e100']) };
            break;
        }
        case 'eth_sendRawTransaction': sent.push(request.params[0]); result = Transaction.from(request.params[0]).hash; break;
        case 'eth_getTransactionReceipt': {
            const raw = sent.find(value => Transaction.from(value).hash === request.params[0]);
            // A reverted receipt ends the SDK's wait deterministically; the
            // test is about what reached the signer, not about settlement.
            result = raw ? { transactionHash: request.params[0], status: '0x0', blockNumber: '0x101',
                blockHash: `0x${'88'.repeat(32)}`, from: OWN, to: VAULT, logs: [], gasUsed: '0x5208',
                cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', transactionIndex: '0x0', type: '0x2' } : null;
            break;
        }
        case 'eth_getTransactionByHash': result = null; break;
        default: throw new Error(`unexpected RPC ${request.method}`);
        }
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) };
    };
    const provider = new AddressFundingProvider({
        getConfig: () => FUNDING, store: memoryStore(), locks: globalThis.navigator.locks, createChannel: () => null,
        createWallet: () => new Wallet(KEY), transport,
        protocol: () => ({ adapter: concessionV1, deploymentId: DEPLOYMENT, version: { id: 'v2' } })
    });
    return { provider, sent, calls, state };
}

test('wiring:credited-payouts the client claims a credited payout through the host signer under its own recovery context', { skip }, async () => {
    await wipe();
    const { provider, sent } = signerWithChain();
    await provider.ensureAddress();
    sdk.runtime.manifest = { deployment_id: DEPLOYMENT };
    sdk.runtime.config = { funding: FUNDING };
    sdk.runtime.init = async () => {};
    const record = { recordId: `${DEPLOYMENT}:${CHAIN}:${VAULT}:7`, deploymentId: DEPLOYMENT, chainId: CHAIN, contractAddress: VAULT,
        noteId: 7, mode: 'escape', phase: 'closed_unconfirmed', destination: DESTINATION, payoutCredited: true,
        creditedAmount: 123_456, payoutCreditEvidence: 'receipt', payoutVerified: false, finalBalance: 123_456,
        transactionHash: `0x${'aa'.repeat(32)}`, finalizedBlockNumber: 50, updatedAt: 10 };
    await sdk.store.putBrowserWithdrawal(record);
    sdk.client.config = { funding: FUNDING };
    sdk.client.browserMode = true;
    sdk.client.setWalletProvider(provider);

    const statuses = [];
    const authorization = { kind: 'payout-claim', destination: getAddress(DESTINATION), recordId: record.recordId, noteId: 7 };
    const outcome = await provider.withAuthorizedAction(authorization,
        () => sdk.client.claimEscapePayout(record.recordId, text => statuses.push(text))).then(() => null, error => error);

    // The claim reached the signer, passed its allowlist, was saved under the
    // claim kind and broadcast; the chain double then reverted it.
    assert.equal(sent.length, 1, 'exactly one transaction was signed');
    const signed = Transaction.from(sent[0]);
    assert.equal(signed.to.toLowerCase(), VAULT);
    assert.equal(signed.value, 0n);
    assert.equal(signed.data, sdk.codec.encodeClaimEscapePayout(DESTINATION));
    const journal = await provider.read(await provider.context(), true);
    assert.deepEqual(journal.transactions.map(entry => [entry.kind, entry.context.kind]), [['payout-claim', 'escape-payout-claim']]);
    assert.ok(outcome, 'the reverted double ends the claim with an error, not a success');
    assert.match(String(outcome.message), /reverted/i);
    assert.ok(statuses.some(text => /submitted/i.test(text)), 'the SDK reported the submission');
});

test('wiring:ownership-proof-wait a mutual request the SDK converts to an escape is signed within the disclosed cap, with the SDK\'s own recovery context', { skip }, async () => {
    const conceded = 300_000;
    const finalBalance = 3_700_000;
    const plan = {
        mode: 'escape',
        proof: { backend: 'groth16_bn254', proof: Buffer.alloc(256, 7).toString('base64') },
        public_inputs: { protocol_version: 2, chain_id: CHAIN, contract_address: VAULT, active_root: '0x1',
            state_signing_key_x: '0x1', state_signing_key_y: '0x2', clearance_signing_key_x: '0x3', clearance_signing_key_y: '0x4',
            note_id: 7, final_balance: finalBalance, destination: DESTINATION, withdrawal_nullifier: '0x2a',
            kind: 0, next_nullifier: '0x2b', conceded, valid_until: 1_900_000_000 }
    };
    const data = sdk.codec.encodeWithdrawal(plan, 'escape', DESTINATION, VAULT, { conceded });
    // What claimPreparedWithdrawalSubmission() hands the client for this plan.
    const submission = { status: 'claimed', submissionId: 'sub-1', transactionHash: null, operationId: 'op-1', noteId: 7,
        mode: 'escape', destination: DESTINATION, finalBalance, clearanceReserved: false, withdrawalNullifier: '0x2a',
        deploymentId: DEPLOYMENT, chainId: CHAIN, contractAddress: VAULT };
    const recovery = sdk.externalRecoveryContext({ kind: 'withdrawal', submission }, FUNDING, DEPLOYMENT);
    assert.equal(recovery.mode, 'escape');

    const attempt = async authorization => {
        const { provider, sent } = signerWithChain();
        await provider.ensureAddress();
        const outcome = await provider.withAuthorizedAction(authorization, () => provider.request({
            method: 'eth_sendTransaction', params: [{ from: OWN, to: VAULT, data }], zkapiRecovery: recovery })).then(() => 'signed', error => error.code);
        assert.equal(sent.length, outcome === 'signed' ? 1 : 0);
        return outcome;
    };
    const asked = { kind: 'withdrawal', destination: getAddress(DESTINATION), mode: 'mutual', noteId: 7 };
    assert.equal(await attempt({ ...asked, concededMax: String(conceded), operationId: 'op-1' }), 'signed');
    assert.equal(await attempt(asked), 4100, 'no bound was disclosed');
    assert.equal(await attempt({ ...asked, concededMax: String(conceded - 1) }), 4100, 'a bound below the concession');
    assert.equal(await attempt({ ...asked, concededMax: String(conceded), operationId: 'op-other' }), 4100, 'another operation');
});

// ------------------------------------------------------------ the exit kit

test('legacy SDK export compatibility: exportExitKit seals a kit and marks it exported before the host delivers it, and names its failures', { skip }, async () => {
    await wipe();
    const runtime = new sdk.BrowserWalletRuntime();
    runtime.manifest = { deployment_id: DEPLOYMENT };
    runtime.browserConfig = { trusted_deployment: { deployment_id: DEPLOYMENT, chain_id: CHAIN, contract_address: VAULT } };
    runtime.init = async () => {};
    const passphrase = 'ABCDE-FGHJK-LMNPQ-RSTUV';

    // No balance: a plain error, without a code (the host words it itself).
    const none = await runtime.exportExitKit({ passphrase }).then(() => null, error => error);
    assert.ok(none instanceof Error);
    assert.equal(none.code, undefined);

    await sdk.store.commitBrowserWallet({ deploymentId: DEPLOYMENT, billingAsset: 'native_eth', stateSeq: 4, state: note() });
    await runtime.reload();
    assert.equal(runtime.runtime.exitKitExportedSeq ?? null, null, 'nothing exported yet');

    // A weak passphrase is refused before anything is committed.
    const weak = await runtime.exportExitKit({ passphrase: 'short' }).then(() => null, error => error);
    assert.equal(weak.code, 'exit_kit_passphrase_weak');
    await runtime.reload();
    assert.equal(runtime.runtime.exitKitExportedSeq ?? null, null);

    const kit = await runtime.exportExitKit({ passphrase });
    const envelope = JSON.parse(kit);
    assert.equal(envelope.format, 'zkapi-exit-kit-v1');
    assert.equal(envelope.kdf.name, 'PBKDF2');
    assert.equal(envelope.cipher.name, 'AES-256-GCM');
    assert.doesNotMatch(kit, /0xabc/, 'the note secret is not in the clear');
    // The SDK has marked it exported now, whether or not any file is saved:
    // the host treats that as "created", never as "saved".
    await runtime.reload();
    assert.equal(runtime.runtime.exitKitExportedSeq, 4);
});
