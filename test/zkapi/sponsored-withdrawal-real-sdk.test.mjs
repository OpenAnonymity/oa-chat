// Sponsored (gasless) withdrawals through the host's Send Ethereum signer,
// driven by the REAL successor client and runtime over the SDK's own scripted
// chain and bundler (its test helpers, imported from the package directory;
// nothing of the SDK is copied here).
//
// What this pins that the unit tests cannot: that the SDK's actual calls (its
// operation bytes, its personal_sign of the hash, its sends and its status
// reads) are accepted by the host's judgment when they are the confirmed
// withdrawal, and refused, with nothing reaching the bundler, when they are
// not. The operation is whatever the SDK built; the host's verdict is computed
// again by services/sponsoredOperation.mjs.
//
// Skipped unless a successor SDK is installed under its registry alias or
// unpacked at ZKAPI_V2_SDK_DIR.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';
import { AddressFundingProvider } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import { readSponsoredPins } from '../../chat/zkapi/services/sponsoredOperation.mjs';
import { concessionV1 } from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { concessionV2 } from '../../chat/zkapi/versioning/adapters/concessionV2.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

// The SDK's helpers read protocol fixtures from outside its `sdk/` directory,
// which an installed package does not ship: an unpacked repository has both.
const hasHelpers = root => fs.existsSync(path.join(root, 'sdk/test/helpers/fake-bundler.mjs'))
    && fs.existsSync(path.join(root, 'protocol/contracts/test/fixtures/transit-vectors.json'));

function successorRoot() {
    if (process.env.ZKAPI_V2_SDK_DIR) {
        const root = path.resolve(process.env.ZKAPI_V2_SDK_DIR);
        return hasHelpers(root) ? root : null;
    }
    const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'deployments/zkapi/registry.json'), 'utf8'));
    for (const row of registry.versions) {
        if (row.sdk.alias === '@openanonymity/zkapi-browser-sdk') continue;
        const root = path.join(repoRoot, 'node_modules', row.sdk.alias);
        if (hasHelpers(root)) return root;
    }
    return null;
}

const ROOT = successorRoot();
const skip = ROOT ? false : 'no successor SDK with its test helpers is installed (registry alias, or ZKAPI_V2_SDK_DIR)';

let sdk = null;
if (ROOT) {
    const load = relative => import(pathToFileURL(path.join(ROOT, relative)).href);
    const harness = await load('sdk/test/helpers/request-archive-harness.mjs');
    globalThis.indexedDB = harness.memoryIndexedDb();
    globalThis.window = Object.assign(new EventTarget(), { location: { hostname: 'localhost' } });
    const storage = new Map();
    globalThis.localStorage = {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key)
    };
    globalThis.zkapiWallet = (await load('sdk/wallet.js')).default;
    const [store, runtimeModule, clientModule, fake, secp, profile] = await Promise.all([
        load('sdk/services/browserWalletStore.js'), load('sdk/services/browserWalletRuntime.js'),
        load('sdk/services/zkapiClient.js'), load('sdk/test/helpers/fake-bundler.mjs'),
        load('sdk/test/helpers/secp256k1.mjs'), load('sdk/test/helpers/deployed-profile.mjs')
    ]);
    sdk = { harness, storage, store, runtime: runtimeModule.default, ZkapiClient: clientModule.ZkapiClient, fake, secp,
        deployedProfile: profile.deployedProfile };
}

const CHAIN_ID = 11155111;
const OWNER_KEY = 0xa11ce0n;
const PAYEE = `0x${'9a'.repeat(20)}`;
const NOTE_ID = 7;
const GWEI = 10n ** 9n;
const low = value => String(value).toLowerCase();
const wei = units => BigInt(units) * GWEI;
const DEPLOYMENT_ID = 'zkapi-native-eth-sepolia-concession-v1-fixture';

function memoryStore() {
    const data = new Map();
    return { data, load: async scope => structuredClone(data.get(scope) ?? null),
        async save(scope, envelope, { createOnly = false } = {}) {
            if (createOnly && data.has(scope)) throw new Error('exists');
            data.set(scope, structuredClone(envelope));
        } };
}

function locks() {
    const tails = new Map();
    return { request(name, options, callback) {
        const before = tails.get(name) || Promise.resolve();
        const run = before.then(() => callback({ name }));
        tails.set(name, run.catch(() => {}));
        return run;
    } };
}

// The shared runtime under the SDK's harness with a gasless profile, a
// scripted chain and bundler, the host's signer as the connected wallet.
async function scenario({ payoutBalance = 500_000_000 } = {}) {
    const { harness, store, runtime, ZkapiClient, fake, secp, deployedProfile, storage } = sdk;
    const { DEPLOYMENT, VAULT, createHarness, depositPath, noteState, nullifierFor } = harness;
    const { BUNDLER_URL, VECTORS, attemptsKeyOf, fakeBundler, fakeGaslessChain, gaslessProfileFromVectors, logs } = fake;
    indexedDB.clear();
    storage.clear();
    for (const name of ['exitRpc', 'pinnedRpc']) delete runtime[name];
    runtime.activeLease = null;
    runtime.exitGasPrice = null;
    runtime.gaslessStatus = null;
    runtime.bundlerChainCheck = null;
    runtime.exitRpcChainCheck = null;
    const state = noteState({ current_balance: payoutBalance,
        ...(depositPath ? { deposit_path: depositPath('0x51') } : {}) });
    const gasless = gaslessProfileFromVectors({ spelling: 'profile' });
    const h = createHarness(function SharedRuntime() { return runtime; });
    h.worker.mutate = plan => { plan.proof.proof = Buffer.alloc(256, h.worker.proofs).toString('base64'); };
    h.server.clearance = body => ({ status: 'ok', withdrawal_nullifier: body.withdrawal_nullifier, signature: { r: '0x1', s: '0x2' } });
    runtime.browserConfig.trusted_deployment = {
        ...deployedProfile('sepolia').trusted_deployment, contract_address: VAULT, chain_id: CHAIN_ID,
        native_asset_wei_per_unit: '1000000000', max_pause_duration: 604_800, vault_revision: depositPath ? 3 : 4, gasless
    };
    await store.writeBrowserWallet({ deploymentId: DEPLOYMENT, billingAsset: 'native_eth', state });
    await runtime.reload();
    const chain = fakeGaslessChain({ chainId: CHAIN_ID, vault: VAULT, gasless, noteId: state.note_id, finalBalance: state.current_balance });
    runtime.exitRpc = () => chain.request;
    runtime.pinnedRpc = () => chain.request;
    const bundler = fakeBundler({ chain });

    const ownerKey = `0x${OWNER_KEY.toString(16).padStart(64, '0')}`;
    const funding = { chain_id: CHAIN_ID, contract_address: VAULT, demo_rpc_url: 'https://exit-rpc.example/rpc',
        billing_asset: 'native_eth', billing_unit: 'gwei', native_asset_wei_per_unit: '1000000000', demo_billing_token_address: null };
    const bundlerCalls = [];
    const provider = new AddressFundingProvider({
        getConfig: () => funding, store: memoryStore(), locks: locks(), createChannel: () => null,
        createWallet: () => new Wallet(ownerKey),
        protocol: () => ({ adapter: depositPath ? concessionV1 : concessionV2, deploymentId: DEPLOYMENT_ID, version: { id: depositPath ? 'v2' : 'v3' } }),
        sponsoredPins: () => readSponsoredPins(runtime.browserConfig.trusted_deployment),
        bundlerUrl: () => BUNDLER_URL,
        // The only network this signer is given is the bundler's.
        transport: async (url, init) => {
            bundlerCalls.push({ url, method: JSON.parse(init.body).method });
            return bundler.fetch(url, init);
        }
    });
    await provider.ensureAddress();
    globalThis.ethereum = provider;

    const client = new ZkapiClient();
    client.browserMode = true;
    client.config = runtime.config;
    client.wallet = { has_note: true, note: { note_id: state.note_id, current_balance: state.current_balance } };
    for (const name of ['assertBalanceNotClaimed', 'settleActiveLease']) client[name] = async () => {};
    client.refresh = async () => {
        await runtime.reload();
        const snapshot = runtime.snapshot();
        client.wallet = await runtime.walletStatus();
        client.withdrawals = snapshot.withdrawals;
        client.config = { ...runtime.config, ...snapshot.config };
        return client.snapshot();
    };
    client.connectWallet = async () => provider.address;
    client.walletAddress = provider.address;
    client.checkEscapeDestination = async destination => ({ destination, accepts: true, warning: null });
    client.recoverFailedWithdrawalSubmission = async () => null;
    client.submittedTransactionMetadata = async () => null;
    client.gaslessTimingOverrides = { receiptPollMs: 3, logPollMs: 6, resendAfterMs: 40, stopBeforeValidUntilSeconds: 60 };

    const statuses = [];
    const onStatus = message => { statuses.push(message); };
    const S = chain.transitAccount(secp.addressOf(OWNER_KEY), PAYEE);
    const nullifier = nullifierFor(state.current_anchor);
    const closeKey = attemptsKeyOf(1, { nullifier });
    const closeBundle = ({ charged = wei(5_000_000), received = wei(state.current_balance) } = {}) => (op, hash) => ({
        success: true,
        extraLogs: [
            logs.mutualClose(VAULT, { noteId: 99n, finalBalance: 1n, destination: `0x${'44'.repeat(20)}` }),
            logs.mutualClose(VAULT, { noteId: BigInt(state.note_id), nullifier: BigInt(nullifier),
                finalBalance: BigInt(state.current_balance), destination: S }),
            logs.settled(chain.paymaster, { key: closeKey, sender: S, payee: PAYEE, kind: 1n, noteId: BigInt(state.note_id), received,
                charged, owedPaid: 0n, paidOut: received - charged })
        ],
        effects: chainState => {
            chainState.noteStatus(state.note_id, 3);
            chainState.paymasterState.attempts.set(closeKey, (chainState.paymasterState.attempts.get(closeKey) ?? 0n) + 1n);
        }
    });
    const authorization = (extra = {}) => ({
        kind: 'withdrawal', destination: PAYEE, mode: 'mutual', noteId: state.note_id,
        sponsored: { feeCapWei: VECTORS.policy.flat_fee_wei }, ...extra
    });
    // The host's action around the SDK's call, as the dialog makes it.
    const withdraw = (mode, auth = authorization(), options = {}) => provider.withAuthorizedAction(auth,
        () => client.performWithdrawal(mode, onStatus, {
            destination: PAYEE, fees: 'payout', bundlerUrl: BUNDLER_URL, feeCapWei: VECTORS.policy.flat_fee_wei, ...options
        }));
    const finalizing = (record, extra = {}) => ({ kind: 'finalization', destination: PAYEE, noteId: state.note_id,
        sponsored: { feeCapWei: VECTORS.policy.flat_fee_wei }, recordId: record?.recordId, ...extra });
    const collecting = (extra = {}) => ({ kind: 'collection', destination: PAYEE,
        sponsored: { feeCapWei: VECTORS.policy.flat_fee_wei, transitAccount: S }, ...extra });
    const record = async () => (await store.listBrowserWithdrawals(DEPLOYMENT)).find(entry => entry.noteId === state.note_id);
    return { h, chain, bundler, provider, client, statuses, withdraw, authorization, finalizing, collecting, record, S, nullifier,
        closeKey, closeBundle, state, runtime, store, bundlerCalls, DEPLOYMENT, VECTORS, fake, secp };
}

test('a sponsored close signed by the host key is released once, judged, and settles', { skip }, async () => {
    const s = await scenario();
    const { within } = sdk.harness;
    s.bundler.autoMine = s.closeBundle();
    const result = await within(8_000, s.withdraw('mutual'), 'a sponsored close');
    assert.equal(result.status, 'closed');
    assert.equal(low(result.transitAccount), low(s.S));
    assert.equal(low(result.payout), low(PAYOUT_FOR_PAYEE));
    // One operation reached the bundler, signed by the key of the Send Ethereum
    // address, for the account derived from it and the confirmed payee.
    assert.equal(s.bundler.sent.length, 1);
    const [{ op }] = s.bundler.sent;
    assert.equal(low(op.sender), low(s.S));
    // Nothing but the bundler was ever called through the signer's transport,
    // and the signer's own journal holds no transaction: no ETH was needed.
    assert.ok(s.bundlerCalls.length > 0);
    assert.ok(s.bundlerCalls.every(call => call.url === s.bundler.url));
    const record = (await s.store.listBrowserWithdrawals(s.DEPLOYMENT)).find(entry => entry.noteId === s.state.note_id);
    assert.equal(record.feePayer, 'payout');
    assert.equal(low(record.payout), low(PAYEE));
    assert.equal(low(record.transit.owner), low(s.provider.address));
});

const PAYOUT_FOR_PAYEE = PAYEE;

test('a withdrawal confirmed for another payee, note or mode releases nothing', { skip }, async () => {
    const { within } = sdk.harness;
    for (const [label, extra] of [
        ['another payee', { destination: `0x${'ee'.repeat(20)}` }],
        ['another note', { noteId: NOTE_ID + 1 }],
        ['another mode', { mode: 'escape' }]
    ]) {
        const s = await scenario();
        s.bundler.autoMine = s.closeBundle();
        await assert.rejects(within(8_000, s.withdraw('mutual', s.authorization(extra)), label),
            error => /not authorized by the selected withdrawal|continue the withdrawal/.test(error.message || error.shortMessage || ''),
            label);
        assert.equal(s.bundler.sent.length, 0, `${label}: no operation reached the bundler`);
    }
});

test('a sponsored fee above the one that was shown is refused before the bundler', { skip }, async () => {
    const { within } = sdk.harness;
    const s = await scenario();
    s.bundler.autoMine = s.closeBundle();
    // The SDK is told the flat fee is acceptable up to 1 wei more than the
    // action confirmed; the host holds it to what it confirmed.
    const confirmed = s.authorization({ sponsored: { feeCapWei: '1' } });
    await assert.rejects(within(8_000, s.withdraw('mutual', confirmed, { feeCapWei: s.VECTORS.policy.flat_fee_wei }), 'dearer fee'),
        error => /fee .*above|not sent|authorized/i.test(error.message || error.shortMessage || ''));
    assert.equal(s.bundler.sent.length, 0);
});

test('a sponsored escape, its finalization after the deadline and a collection are each judged and released', { skip }, async () => {
    const { within } = sdk.harness;
    const s = await scenario();
    const { logs, attemptsKeyOf } = s.fake;
    const NOTE = s.state.note_id;
    const escapeKey = attemptsKeyOf(2, { noteId: NOTE });
    const deadline = Math.floor(Date.now() / 1_000) - 10;
    const balance = BigInt(s.state.current_balance);
    s.bundler.autoMine = () => ({
        success: true,
        extraLogs: [
            logs.escapeInitiated(s.harnessVault ?? sdk.harness.VAULT, { noteId: BigInt(NOTE), nullifier: BigInt(s.nullifier),
                finalBalance: balance, destination: s.S, challengeDeadline: BigInt(deadline) }),
            logs.escapeInitiationOwed(s.chain.paymaster, { sender: s.S, noteId: BigInt(NOTE), owedWei: wei(4_000_000) }),
            logs.settled(s.chain.paymaster, { key: escapeKey, sender: s.S, payee: PAYEE, kind: 2n, noteId: BigInt(NOTE),
                received: 0n, charged: wei(4_000_000), owedPaid: 0n, paidOut: 0n })
        ],
        effects: chainState => {
            chainState.noteStatus(NOTE, 2);
            chainState.setPending(NOTE, { nullifier: BigInt(s.nullifier), finalBalance: balance, destination: s.S,
                challengeDeadline: BigInt(deadline), stateBalance: balance, conceded: 0n, nextNullifier: 0x5n });
            chainState.paymasterState.owed.set(s.S, wei(4_000_000));
            chainState.paymasterState.escapeNotePlusOne.set(s.S, BigInt(NOTE) + 1n);
            chainState.paymasterState.escapeSponsored.set(NOTE, true);
        }
    });
    // An escape that concedes nothing: nothing was confirmed to give up.
    const started = await within(8_000, s.withdraw('escape', s.authorization({ mode: 'escape' })), 'a sponsored escape');
    assert.equal(started.status, 'pending_withdrawal');
    assert.equal(s.bundler.sent.length, 1);
    const saved = await s.record();
    assert.equal(saved.mode, 'escape');
    assert.equal(saved.feePayer, 'payout');

    // The finalization is another operation, judged by the finalization rule,
    // and an action that confirmed another note releases nothing.
    const finalizeKey = attemptsKeyOf(3, { noteId: NOTE });
    s.bundler.autoMine = () => ({
        success: true,
        extraLogs: [
            logs.escapeFinalized(sdk.harness.VAULT, { noteId: BigInt(NOTE), nullifier: BigInt(s.nullifier), finalBalance: balance, destination: s.S }),
            logs.settled(s.chain.paymaster, { key: finalizeKey, sender: s.S, payee: PAYEE, kind: 3n, noteId: BigInt(NOTE),
                received: balance * GWEI, charged: wei(3_000_000), owedPaid: wei(4_000_000),
                paidOut: balance * GWEI - wei(7_000_000) })
        ],
        effects: chainState => {
            chainState.noteStatus(NOTE, 3);
            chainState.vaultState.pending.delete(NOTE);
            chainState.paymasterState.owed.set(s.S, 0n);
            chainState.paymasterState.escapeNotePlusOne.set(s.S, 0n);
        }
    });
    const sentBefore = s.bundler.sent.length;
    await assert.rejects(within(8_000, s.provider.withAuthorizedAction(s.finalizing(saved, { noteId: NOTE + 1 }),
        () => s.client.finalizeEscape(saved.recordId, () => {})), 'another note'),
        error => /not authorized by the selected withdrawal/.test(error.message || error.shortMessage || ''));
    assert.equal(s.bundler.sent.length, sentBefore, 'nothing was released for another note');
    const finalized = await within(8_000, s.provider.withAuthorizedAction(s.finalizing(saved),
        () => s.client.finalizeEscape(saved.recordId, () => {})), 'a sponsored finalization');
    assert.equal(finalized.status, 'closed');
    assert.equal(s.bundler.sent.length, sentBefore + 1);
    assert.equal(globalThis.ethereum.hasPendingTransaction, false, 'no transaction was signed: no ETH was needed');
});

test('a payout stranded in the transit account is collected through a judged forward', { skip }, async () => {
    const { within } = sdk.harness;
    const s = await scenario();
    const { logs, attemptsKeyOf } = s.fake;
    const NOTE = s.state.note_id;
    const { word } = s.fake;
    const vaultFailed = `0xc3076dea${word(0x20)}${word(4)}${'61a83aab'.padEnd(64, '0')}`;
    s.bundler.autoMine = () => ({
        success: false,
        revertReason: vaultFailed,
        extraLogs: [
            logs.sponsorshipFailed(s.chain.paymaster, { key: s.closeKey, sender: s.S, kind: 1n, noteId: BigInt(NOTE), actualGasCost: 10n ** 15n }),
            logs.stranded(s.chain.paymaster, s.S)
        ],
        effects: chainState => {
            chainState.noteStatus(NOTE, 3);
            chainState.setBalance(s.S, wei(s.state.current_balance));
            chainState.paymasterState.stranded.set(s.S, true);
        }
    });
    const closed = await within(8_000, s.withdraw('mutual'), 'a close that reverted');
    assert.equal(closed.fundsWaitingInTransit, true);
    const saved = await s.record();
    const forwardKey = attemptsKeyOf(4, { sender: s.S });
    s.bundler.autoMine = () => ({
        success: true,
        extraLogs: [logs.settled(s.chain.paymaster, { key: forwardKey, sender: s.S, payee: PAYEE, kind: 4n, noteId: 0xffffffffn,
            received: wei(s.state.current_balance), charged: wei(300_000), owedPaid: 0n,
            paidOut: wei(s.state.current_balance) - wei(300_000) })],
        effects: chainState => { chainState.setBalance(s.S, 0n); chainState.paymasterState.stranded.set(s.S, false); }
    });
    // A collection confirmed for another account's record releases nothing.
    const before = s.bundler.sent.length;
    await assert.rejects(within(8_000, s.provider.withAuthorizedAction(
        s.collecting({ sponsored: { feeCapWei: s.VECTORS.policy.flat_fee_wei, transitAccount: `0x${'31'.repeat(20)}` } }),
        () => s.client.collectTransitBalance(saved.recordId, () => {})), 'another account'),
        error => /not authorized by the selected withdrawal/.test(error.message || error.shortMessage || ''));
    assert.equal(s.bundler.sent.length, before);
    const collected = await within(8_000, s.provider.withAuthorizedAction(s.collecting(),
        () => s.client.collectTransitBalance(saved.recordId, () => {})), 'a collection');
    assert.equal(collected.status, 'collected');
    assert.equal(s.bundler.sent.length, before + 1);
});
