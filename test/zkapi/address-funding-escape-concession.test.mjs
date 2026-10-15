// Send Ethereum and the escapes of the concession protocol, end to end: what
// the action authorizes (runAddressAction) against the calldata the SDK
// prepares (the signer's validateCall, through its real signing path).
//
// The failure these pin: the SDK may turn a requested mutual close into an
// escape (service unreachable or refusing, a deadline too near, a nullifier
// already used) and may concede the bound of a chat that is still settling.
// The signer used to refuse both after the SDK had released its escape proof
// and set its exit lock, so a retry repeated the refusal. A conversion or a
// concession is now signed exactly when it is within what the person was
// shown before choosing, and never otherwise.
//
// Calldata comes from two places. The GOLDEN calldata below is produced by
// Foundry `cast calldata` from the vault revision 3 signatures (upstream
// sdk/test/fixtures/vault-calldata-golden.json), independent of any SDK
// encoder; words are replaced to vary balance and concession. When a
// successor SDK is installed under its registry alias (or ZKAPI_V2_SDK_DIR
// names an unpacked one) every case also runs with its real encoders and
// recovery-context builder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { afterEach, beforeEach, mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Transaction, Wallet, getAddress } from 'ethers';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import { AddressFundingProvider, addressFundingWallet, CONCESSION_UNCONFIRMED_MESSAGE } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import { runAddressAction } from '../../chat/zkapi/services/addressFunding.js';

// The wallet-paid fee review that precedes a withdrawal action (the host's own,
// covered by address-funding-actions): a funded one, so these tests are about
// what the authorization carries.
beforeEach(() => {
    fundedBudget = mock.method(addressFundingWallet, 'getWithdrawalFeeBudget', async () => ({ shortfallWei: '0', feeReserveWei: '0' }));
});
afterEach(() => fundedBudget?.mock.restore());
let fundedBudget = null;
import { concessionV1 } from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { noteBoundV1 } from '../../chat/zkapi/versioning/adapters/noteBoundV1.mjs';
import { installActiveVersion, resetActiveVersionForTests } from '../../chat/zkapi/versioning/activeVersion.mjs';

const GOLDEN_ESCAPE = '0xa38d62aa00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000aa36a7000000000000000000000000590df9abbfb21074016daa486c771ae0af729ee230644e72e131a029b85045b68181585d2833e84879b9709143e1f593f000000000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000013000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000150000000000000000000000000000000000000000000000000000000000000015000000000000000000000000000000000000000000000000001fffffffffffff0000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000002a5c6b0e9f1d3b7a8c4e2f6a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f2a3b4c0000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000006b49fc3000000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000100000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';
// Golden word layout of an exit (after the selector): 1 chain id, 2 vault,
// 8 note id, 9 final balance, 10 destination, 11 nullifier, 12 kind, 13 next
// nullifier, 14 conceded.
const GOLDEN = { chainId: 11155111, vault: '0x590df9abbfb21074016daa486c771ae0af729ee2',
    noteId: 0x15, destination: '0x2222222222222222222222222222222222222222' };
const GOLDEN_BALANCE = 0x1fffffffffffffn;
const GOLDEN_CONCEDED = 100n;

const KEY = `0x${'11'.repeat(32)}`;
const OWN = new Wallet(KEY).address.toLowerCase();
const DEPLOYMENT = 'zkapi-native-eth-sepolia-concession-v1-fixture';
const NATIVE = { billing_asset: 'native_eth', billing_unit: 'gwei', native_asset_wei_per_unit: '1000000000', demo_billing_token_address: null };
const hex = value => `0x${value.toString(16)}`;
const wordOf = value => BigInt(value).toString(16).padStart(64, '0');
const addressWord = address => address.slice(2).toLowerCase().padStart(64, '0');

function withWord(calldata, index, value) {
    const body = calldata.slice(2).toLowerCase();
    const selector = body.slice(0, 8);
    const words = body.slice(8).match(/.{64}/g);
    words[index] = typeof value === 'string' ? value : wordOf(value);
    return `0x${selector}${words.join('')}`;
}

// -------------------------------------------------------------- calldata sources

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function successorRoot() {
    if (process.env.ZKAPI_V2_SDK_DIR) return path.resolve(process.env.ZKAPI_V2_SDK_DIR);
    const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'deployments/zkapi/registry.json'), 'utf8'));
    for (const row of registry.versions) {
        const root = path.join(repoRoot, 'node_modules', row.sdk.alias);
        if (row.sdk.alias !== '@openanonymity/zkapi-browser-sdk' && fs.existsSync(path.join(root, 'sdk/wallet.js'))) return root;
    }
    return null;
}

// What an exit looks like to the signer for one source of calldata.
//   encode(mode, { finalBalance, conceded }) -> { data, recovery } for the golden
//   note, with the same recovery context the SDK emits for a submission.
function goldenSource() {
    return {
        name: 'golden calldata',
        async build(mode, { finalBalance = GOLDEN_BALANCE, conceded = GOLDEN_CONCEDED } = {}) {
            let data = withWord(GOLDEN_ESCAPE, 9, finalBalance);
            if (mode === 'escape') data = withWord(data, 14, conceded);
            else {
                // The mutual layout: selector 72cd2e44, kind 1, no successor,
                // no concession.
                data = `0x72cd2e44${data.slice(10)}`;
                data = withWord(withWord(withWord(data, 12, 1), 13, 0), 14, 0);
            }
            return { data, finalBalance: BigInt(finalBalance), conceded: mode === 'escape' ? BigInt(conceded) : 0n };
        }
    };
}

async function realSource(root) {
    globalThis.location ??= { href: 'https://app.example/', origin: 'https://app.example', search: '' };
    const wallet = (await import(pathToFileURL(path.join(root, 'sdk/wallet.js')).href)).default;
    return {
        name: 'successor SDK encoders',
        async build(mode, { finalBalance = 4_000_000n, conceded = 0n } = {}) {
            const plan = {
                mode,
                proof: { backend: 'groth16_bn254', proof: Buffer.alloc(256, 7).toString('base64') },
                public_inputs: { protocol_version: 2, chain_id: GOLDEN.chainId, contract_address: GOLDEN.vault, active_root: '0x1',
                    state_signing_key_x: '0x1', state_signing_key_y: '0x2', clearance_signing_key_x: '0x3', clearance_signing_key_y: '0x4',
                    note_id: GOLDEN.noteId, final_balance: Number(finalBalance), destination: GOLDEN.destination,
                    withdrawal_nullifier: '0x2a', kind: mode === 'mutual' ? 1 : 0,
                    next_nullifier: mode === 'mutual' ? '0x0' : '0x2b', conceded: Number(mode === 'mutual' ? 0n : conceded),
                    valid_until: 1_900_000_000 }
            };
            const data = wallet.encodeWithdrawal(plan, mode, GOLDEN.destination, GOLDEN.vault,
                mode === 'escape' ? { conceded: Number(conceded) } : {});
            return { data, finalBalance: BigInt(finalBalance), conceded: mode === 'escape' ? BigInt(conceded) : 0n,
                claim: destination => wallet.encodeClaimEscapePayout(destination) };
        }
    };
}

const sources = [goldenSource()];
const root = successorRoot();
if (root) sources.push(await realSource(root));

// ----------------------------------------------------------------------- harness

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

function harness(protocol = () => ({ adapter: concessionV1, deploymentId: DEPLOYMENT, version: { id: 'v2' } })) {
    const rpc = { calls: [], sent: [], nonce: '0x0', balance: '0xde0b6b3a7640000', gas: '0x186a0',
        baseFee: '0x1dcd6500', priorityFee: '0x5f5e100', latest: '0x100', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` };
    const funding = { chain_id: GOLDEN.chainId, contract_address: GOLDEN.vault, demo_rpc_url: 'https://rpc.example', ...NATIVE };
    const feeHistory = () => {
        const count = 20;
        return { oldestBlock: hex(BigInt(rpc.latest) - BigInt(count) + 1n), baseFeePerGas: Array(count + 1).fill(rpc.baseFee),
            gasUsedRatio: Array(count).fill(0.5), reward: Array.from({ length: count }, () => [rpc.priorityFee]) };
    };
    const transport = async (url, options) => {
        const request = JSON.parse(options.body);
        rpc.calls.push(request.method);
        let result;
        if (request.method === 'eth_chainId') result = hex(GOLDEN.chainId);
        else if (request.method === 'eth_getTransactionCount') result = rpc.nonce;
        else if (request.method === 'eth_getBalance') result = rpc.balance;
        else if (request.method === 'eth_estimateGas') result = rpc.gas;
        else if (request.method === 'eth_call') result = '0x';
        else if (request.method === 'eth_feeHistory') result = feeHistory();
        else if (request.method === 'eth_getBlockByNumber') result = { number: rpc.latest, hash: `0x${'77'.repeat(32)}`, baseFeePerGas: rpc.baseFee, timestamp: rpc.timestamp };
        else if (request.method === 'eth_getCode') result = '0x';
        else if (request.method === 'eth_sendRawTransaction') { rpc.sent.push(request.params[0]); result = Transaction.from(request.params[0]).hash; }
        else assert.fail(`Unexpected RPC ${request.method}`);
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) };
    };
    const store = memoryStore();
    const provider = new AddressFundingProvider({ getConfig: () => funding, store, locks: locks(),
        createChannel: () => null, createWallet: () => new Wallet(KEY), protocol, transport });
    return { provider, rpc, funding, store, protocol };
}

// What the SDK emits for a submission of an exit (externalRecoveryContext).
const recoveryFor = (mode, built, { operationId = 'op-1' } = {}) => ({
    version: 1, kind: 'withdrawal', deploymentId: DEPLOYMENT, chainId: GOLDEN.chainId, contractAddress: GOLDEN.vault,
    operationId, submissionId: 'sub-1', noteId: GOLDEN.noteId, mode, destination: GOLDEN.destination,
    finalBalance: Number(built.finalBalance), clearanceReserved: mode === 'mutual', withdrawalNullifier: '0x2a'
});
const authorizationFor = (mode, extra = {}) => ({ kind: 'withdrawal', destination: getAddress(GOLDEN.destination), mode,
    noteId: GOLDEN.noteId, ...extra });

// Sign through the provider's real path (authorize, validate, quote, sign,
// persist, broadcast) and answer 'signed' or the refusal's code.
async function attempt(h, built, recovery, authorization) {
    await h.provider.ensureAddress();
    const sentBefore = h.rpc.sent.length;
    try {
        await h.provider.withAuthorizedAction(authorization, () => h.provider.request({ method: 'eth_sendTransaction',
            params: [{ from: OWN, to: GOLDEN.vault, data: built.data }], zkapiRecovery: recovery }));
        assert.equal(h.rpc.sent.length, sentBefore + 1, 'a signed call is broadcast once');
        return 'signed';
    } catch (error) {
        assert.equal(h.rpc.sent.length, sentBefore, 'a refused call is never broadcast');
        return error.code;
    }
}

for (const source of sources) {
    const suffix = ` [${source.name}]`;

    test(`wiring:ownership-proof-wait a requested mutual close is signed as asked${suffix}`, async () => {
        const h = harness();
        const built = await source.build('mutual');
        assert.equal(await attempt(h, built, recoveryFor('mutual', built), authorizationFor('mutual')), 'signed');
    });

    test(`wiring:ownership-proof-wait a mutual close turned into an escape that concedes nothing is signed${suffix}`, async () => {
        const h = harness();
        const built = await source.build('escape', { conceded: 0n });
        const recovery = recoveryFor('escape', built);
        // The click said mutual. The SDK says escape, concession 0.
        assert.equal(await attempt(h, built, recovery, authorizationFor('mutual')), 'signed');
        // The same call under the legacy protocol's profile is not a call it knows.
        const legacy = harness(() => ({ adapter: noteBoundV1, deploymentId: DEPLOYMENT, version: { id: 'v1' } }));
        assert.equal(await attempt(legacy, built, recovery, authorizationFor('mutual')), 4100);
    });

    test(`wiring:ownership-proof-wait a conversion or forced escape that concedes is signed only within the disclosed bound${suffix}`, async () => {
        const conceded = 300_000n;
        const built = await source.build('escape', { finalBalance: 3_700_000n, conceded });
        const recovery = recoveryFor('escape', built);
        const bound = conceded.toString();
        const cases = [
            // [label, authorization, expected]
            ['converted, bound disclosed and equal', authorizationFor('mutual', { concededMax: bound }), 'signed'],
            ['converted, a larger bound disclosed', authorizationFor('mutual', { concededMax: '5000000' }), 'signed'],
            ['converted, no bound disclosed', authorizationFor('mutual'), 4100],
            ['converted, bound one below', authorizationFor('mutual', { concededMax: String(conceded - 1n) }), 4100],
            ['converted, bound zero', authorizationFor('mutual', { concededMax: '0' }), 4100],
            ['forced, exact amount confirmed', authorizationFor('escape', { conceded: bound }), 'signed'],
            ['forced, another exact amount', authorizationFor('escape', { conceded: String(conceded - 1n) }), 4100],
            ['forced, a bound that covers it', authorizationFor('escape', { concededMax: bound }), 'signed'],
            ['forced, nothing confirmed', authorizationFor('escape'), 4100],
            ['exact above the bound', authorizationFor('escape', { conceded: bound, concededMax: String(conceded - 1n) }), 4100]
        ];
        for (const [label, authorization, expected] of cases) {
            const h = harness();
            assert.equal(await attempt(h, built, recovery, authorization), expected, label);
        }
    });

    test(`wiring:ownership-proof-wait an escape above the bound is refused before any transaction is built${suffix}`, async () => {
        const h = harness();
        const built = await source.build('escape', { finalBalance: 3_699_999n, conceded: 300_001n });
        const outcome = await attempt(h, built, recoveryFor('escape', built), authorizationFor('mutual', { concededMax: '300000' }));
        assert.equal(outcome, 4100);
        // Only reads that precede validation happened; nothing was quoted or signed.
        assert.equal(h.rpc.calls.includes('eth_estimateGas'), false);
        assert.equal(h.rpc.calls.includes('eth_sendRawTransaction'), false);
    });

    test(`wiring:ownership-proof-wait a replaced operation or note is never signed${suffix}`, async () => {
        const built = await source.build('escape', { conceded: 0n });
        const recovery = recoveryFor('escape', built, { operationId: 'op-replacement' });
        assert.equal(await attempt(harness(), built, recovery, authorizationFor('escape', { operationId: 'op-shown' })), 4100);
        assert.equal(await attempt(harness(), built, recovery, authorizationFor('escape', { operationId: 'op-replacement' })), 'signed');
        assert.equal(await attempt(harness(), built, recoveryFor('escape', built), authorizationFor('escape', { noteId: GOLDEN.noteId + 1 })), 4100);
    });

    test(`wiring:credited-payouts the claim of a credited payout and the finalization of its escape are signed${suffix}`, async () => {
        const built = await source.build('escape', { conceded: 0n });
        const claimData = built.claim ? built.claim(GOLDEN.destination) : `0x88c10aee${addressWord(GOLDEN.destination)}`;
        const claimRecovery = { version: 1, kind: 'escape-payout-claim', deploymentId: DEPLOYMENT, chainId: GOLDEN.chainId,
            contractAddress: GOLDEN.vault, recordId: `${DEPLOYMENT}:${GOLDEN.chainId}:${GOLDEN.vault}:${GOLDEN.noteId}`,
            noteId: GOLDEN.noteId, destination: GOLDEN.destination };
        const claimAuthorization = { kind: 'payout-claim', destination: getAddress(GOLDEN.destination),
            recordId: claimRecovery.recordId, noteId: GOLDEN.noteId };
        const h = harness();
        assert.equal(await attempt(h, { data: claimData }, claimRecovery, claimAuthorization), 'signed');
        // Another payout destination is never delivered by this record.
        const other = harness();
        assert.equal(await attempt(other, { data: claimData }, { ...claimRecovery, destination: `0x${'77'.repeat(20)}` }, claimAuthorization), 4100);

        const finalizeData = `0xff8f5585${wordOf(GOLDEN.noteId)}`;
        const finalizeRecovery = { version: 1, kind: 'finalization', deploymentId: DEPLOYMENT, chainId: GOLDEN.chainId,
            contractAddress: GOLDEN.vault, operationId: 'fin-1', submissionId: 'fin-sub', noteId: GOLDEN.noteId };
        assert.equal(await attempt(harness(), { data: finalizeData }, finalizeRecovery, { kind: 'finalization', noteId: GOLDEN.noteId }), 'signed');
        assert.equal(await attempt(harness(), { data: finalizeData }, finalizeRecovery, { kind: 'finalization', noteId: GOLDEN.noteId + 1 }), 4100);
    });
}

// ---------------------------------------------- action and signer, joined

async function actionAuthorization(t, { plan, details }) {
    const originals = { config: zkapiClient.config, withdrawals: zkapiClient.withdrawals, withdrawal: zkapiClient.withdrawal,
        wallet: zkapiClient.wallet, runtime: walletRuntime.runtime };
    const walletState = addressFundingWallet.state;
    t.after(() => {
        Object.assign(zkapiClient, originals);
        walletRuntime.runtime = originals.runtime;
        addressFundingWallet.state = walletState;
        resetActiveVersionForTests();
    });
    // What the client shows of a saved plan (its public summary).
    const prepared = plan ? { mode: plan.mode, phase: plan.phase, note_id: plan.noteId, destination: GOLDEN.destination } : null;
    Object.assign(zkapiClient, { config: { funding: { chain_id: GOLDEN.chainId, contract_address: GOLDEN.vault, ...NATIVE },
        prepared_withdrawal: prepared }, withdrawal: null, withdrawals: [], wallet: { note: { note_id: GOLDEN.noteId } } });
    walletRuntime.runtime = { preparedWithdrawal: plan };
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: `0x${'12'.repeat(20)}`, pending: null };
    const row = { id: 'v2', ordinal: 2, label: 'Version 2', adapter: 'concession-v1', circuitId: 'zkapi-v2-concession-v1',
        vaultRevision: 3, status: 'active', depositsOpen: true, depositsClosedSince: null, admissionClosesAt: null,
        deploymentId: DEPLOYMENT, chainId: GOLDEN.chainId, vault: GOLDEN.vault, rpcUrl: 'https://rpc.example', configSha256: null,
        assetBase: 'zkapi/v2c/', proxyPath: '/zkapi-deployment-v2c/', transition: {}, notices: [] };
    resetActiveVersionForTests();
    installActiveVersion({ table: [row], version: row, selection: { version: row, reason: 'single_version' } });
    const seen = [];
    t.mock.method(addressFundingWallet, 'withAuthorizedAction', async (authorization, action) => {
        seen.push(authorization);
        return action();
    });
    await runAddressAction({ fundingDestination: GOLDEN.destination, withdrawMode: 'mutual' },
        { phase: 'wallet', ...details }, () => {}, async () => {});
    return seen[0];
}

// The same browser after a reload: a signer with nothing in memory over the
// same saved journal and the same network.
function reopened(h) {
    return { ...h, provider: new AddressFundingProvider({ getConfig: () => h.funding, store: h.store, locks: locks(),
        createChannel: () => null, createWallet: () => new Wallet(KEY), protocol: h.protocol, transport: h.provider.transport }) };
}

// The page, with a signer that really signs. `act(details)` is the person's
// click: runAddressAction builds the authorization, the real provider
// authorizes the action with it, and the action is the SDK asking the provider
// to send `built` under `recovery`.
function pageWithSigner(t, { harness: h, built, recovery, plan = null }) {
    const originals = { config: zkapiClient.config, withdrawals: zkapiClient.withdrawals, withdrawal: zkapiClient.withdrawal,
        wallet: zkapiClient.wallet, runtime: walletRuntime.runtime };
    const walletState = addressFundingWallet.state;
    t.after(() => {
        Object.assign(zkapiClient, originals);
        walletRuntime.runtime = originals.runtime;
        addressFundingWallet.state = walletState;
        resetActiveVersionForTests();
    });
    const prepared = plan ? { mode: plan.mode, phase: plan.phase, note_id: plan.noteId, destination: GOLDEN.destination } : null;
    Object.assign(zkapiClient, { config: { funding: { chain_id: GOLDEN.chainId, contract_address: GOLDEN.vault, ...NATIVE },
        prepared_withdrawal: prepared }, withdrawal: null, withdrawals: [], wallet: { note: { note_id: GOLDEN.noteId } } });
    // What the SDK has saved. The action must never read it for a concession.
    walletRuntime.runtime = { preparedWithdrawal: plan };
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: `0x${'12'.repeat(20)}`, pending: null };
    const row = { id: 'v2', ordinal: 2, label: 'Version 2', adapter: 'concession-v1', circuitId: 'zkapi-v2-concession-v1',
        vaultRevision: 3, status: 'active', depositsOpen: true, depositsClosedSince: null, admissionClosesAt: null,
        deploymentId: DEPLOYMENT, chainId: GOLDEN.chainId, vault: GOLDEN.vault, rpcUrl: 'https://rpc.example', configSha256: null,
        assetBase: 'zkapi/v2c/', proxyPath: '/zkapi-deployment-v2c/', transition: {}, notices: [] };
    resetActiveVersionForTests();
    installActiveVersion({ table: [row], version: row, selection: { version: row, reason: 'single_version' } });
    const authorizations = [];
    let current = h;
    t.mock.method(addressFundingWallet, 'withAuthorizedAction', (authorization, action) => {
        authorizations.push(authorization);
        return current.provider.withAuthorizedAction(authorization, action);
    });
    const act = (details, { as = h, call = built, context = recovery } = {}) => {
        current = as;
        return runAddressAction({ fundingDestination: GOLDEN.destination, withdrawMode: 'mutual' }, { phase: 'wallet', ...details },
            () => {}, () => as.provider.request({ method: 'eth_sendTransaction',
                params: [{ from: OWN, to: GOLDEN.vault, data: call.data }], zkapiRecovery: context }));
    };
    return { act, authorizations };
}

for (const source of sources) {
    const suffix = ` [${source.name}]`;

    test(`wiring:ownership-proof-wait a refused escape is not signed when the action is repeated without its bound${suffix}`, async t => {
        // A recent chat settled after the person was shown the bound: the SDK
        // proved an escape that concedes more than what they saw.
        const built = await source.build('escape', { finalBalance: 3_700_000n, conceded: 300_000n });
        const recovery = recoveryFor('escape', built, { operationId: 'op-escape' });
        const h = harness();
        await h.provider.ensureAddress();
        const plan = { mode: 'escape', phase: 'prepared', operationId: 'op-escape', noteId: GOLDEN.noteId,
            concededAtInit: '300000', public_inputs: { note_id: GOLDEN.noteId, conceded: 300_000 } };
        const { act, authorizations } = pageWithSigner(t, { harness: h, built, recovery, plan });

        await assert.rejects(act({ kind: 'withdraw', concededMax: '100' }), { code: 4100 });
        // Repeating the action without a bound, or naming only the operation,
        // is not a way round the refusal, though the SDK's plan is saved and
        // carries exactly this concession.
        await assert.rejects(act({ kind: 'withdraw' }), { code: 4100 });
        await assert.rejects(act({ kind: 'withdraw', operationId: 'op-escape' }), { code: 4100 });
        await assert.rejects(act({ kind: 'escape' }), { code: 4100 });
        for (const authorization of authorizations.slice(1)) {
            assert.equal(authorization.conceded, undefined, 'the action does not fill an amount from the saved plan');
            assert.equal(authorization.concededMax, undefined);
        }
        assert.equal(h.rpc.sent.length, 0);

        // A reload: the same browser with nothing in memory, over the same journal.
        const reloaded = reopened(h);
        await reloaded.provider.init();
        await assert.rejects(act({ kind: 'withdraw' }, { as: reloaded }), { code: 4100 });
        assert.equal(h.rpc.sent.length, 0);

        // The person is shown the bound that now applies and confirms it.
        const hash = await act({ kind: 'withdraw', concededMax: '300000' }, { as: reloaded });
        assert.equal(h.rpc.sent.length, 1);
        assert.equal(Transaction.from(h.rpc.sent[0]).hash, hash);
    });

    test(`wiring:ownership-proof-wait an escape the signer already signed is continued at no more than that amount${suffix}`, async t => {
        const built = await source.build('escape', { finalBalance: 3_750_000n, conceded: 250_000n });
        const recovery = recoveryFor('escape', built, { operationId: 'op-escape' });
        const h = harness();
        await h.provider.ensureAddress();
        const { act, authorizations } = pageWithSigner(t, { harness: h, built, recovery });

        const first = await act({ kind: 'withdraw', concededMax: '250000', operationId: 'op-escape' });
        await h.provider.acknowledgeTransaction(first);
        h.rpc.nonce = '0x1';
        // After a reload, a repeat of the same operation named by nothing but
        // the click: the journal alone carries the amount it was signed at.
        const next = reopened(h);
        await next.provider.init();
        const second = await act({ kind: 'withdraw' }, { as: next });
        assert.equal(Transaction.from(h.rpc.sent[1]).hash, second);
        assert.equal(authorizations.at(-1).conceded, undefined, 'the action itself still names no amount');
        const record = await next.provider.read(await next.provider.context(), true);
        assert.equal(record.transactions[1].authorization.conceded, '250000', 'the journal states the amount it was held to');
        assert.equal(record.transactions[1].authorization.mode, 'escape');
        await next.provider.acknowledgeTransaction(second);
        h.rpc.nonce = '0x2';

        // The SDK proved the operation again at a larger concession: not that
        // amount. (The recovery context is the larger call's own, so the
        // concession is the only thing that differs from the one signed.)
        const larger = await source.build('escape', { finalBalance: 3_749_999n, conceded: 250_001n });
        await assert.rejects(act({ kind: 'withdraw' },
            { as: next, call: larger, context: recoveryFor('escape', larger, { operationId: 'op-escape' }) }), { code: 4100 });
        // Another operation's escape of the same size is not it either.
        await assert.rejects(act({ kind: 'withdraw' }, { as: next, context: recoveryFor('escape', built, { operationId: 'op-other' }) }),
            { code: 4100 });
        assert.equal(h.rpc.sent.length, 2);

        // Proved again at a smaller concession it gives up less than the person
        // confirmed: signed, and the journal states the smaller amount.
        const smaller = await source.build('escape', { finalBalance: 3_750_001n, conceded: 249_999n });
        const third = await act({ kind: 'withdraw' },
            { as: next, call: smaller, context: recoveryFor('escape', smaller, { operationId: 'op-escape' }) });
        assert.equal(Transaction.from(h.rpc.sent[2]).hash, third);
        const after = await next.provider.read(await next.provider.context(), true);
        assert.equal(after.transactions[2].authorization.conceded, '249999');
        assert.equal(after.transactions[2].authorization.concededMax, '250000');
    });
}

test('wiring:ownership-proof-wait a fresh withdrawal action authorizes a conversion only through the disclosed bound', async t => {
    const authorization = await actionAuthorization(t, { plan: null,
        details: { kind: 'withdraw', concededMax: '300000' } });
    assert.equal(authorization.concededMax, '300000');
    assert.equal(authorization.conceded, undefined);
    const source = goldenSource();
    const within = await source.build('escape', { finalBalance: 3_700_000n, conceded: 300_000n });
    assert.equal(await attempt(harness(), within, recoveryFor('escape', within), authorization), 'signed');
    const over = await source.build('escape', { finalBalance: 3_699_999n, conceded: 300_001n });
    assert.equal(await attempt(harness(), over, recoveryFor('escape', over), authorization), 4100);
});

// ------------------- a concession nobody confirmed is refused in words that say what to do

// The refusal itself, not only its code.
async function refusalOf(h, built, recovery, authorization) {
    await h.provider.ensureAddress();
    const sentBefore = h.rpc.sent.length;
    try {
        await h.provider.withAuthorizedAction(authorization, () => h.provider.request({ method: 'eth_sendTransaction',
            params: [{ from: OWN, to: GOLDEN.vault, data: built.data }], zkapiRecovery: recovery }));
    } catch (error) {
        assert.equal(h.rpc.sent.length, sentBefore, 'a refused call is never broadcast');
        return error;
    }
    return assert.fail('the call was signed');
}
const GENERIC_DENIAL = 'This transaction was not authorized by the selected wallet action.';

// The saved plan of an emergency exit as the SDK keeps it (the real shape from
// the fixtures, with the concession the SDK's own plan decoration records
// beside the public input: concededAtInit, boundAtState, stateBalance, decision).
function concedingPlan(conceded, { operationId = 'op-escape' } = {}) {
    const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/zkapi-v2-real-shapes/snapshots.json', import.meta.url), 'utf8'));
    const real = structuredClone(fixture.scenarios.escape_lock_released_proof.runtime.preparedWithdrawal);
    const balance = real.public_inputs.final_balance + real.public_inputs.conceded;
    return { ...real, operationId, destination: GOLDEN.destination,
        public_inputs: { ...real.public_inputs, final_balance: balance - Number(conceded), conceded: Number(conceded) },
        stateBalance: String(balance), concededAtInit: String(conceded), boundAtState: String(conceded),
        decision: { rule: 'E4', conceded: String(conceded) } };
}

for (const source of sources) {
    const suffix = ` [${source.name}]`;

    test(`wiring:ownership-proof-wait a concession that was not confirmed is refused in plain words, and only that refusal${suffix}`, async () => {
        const conceded = 300_000n;
        const built = await source.build('escape', { finalBalance: 3_700_000n, conceded });
        const recovery = recoveryFor('escape', built);
        const bound = conceded.toString();
        // Everything that leaves a concession unconfirmed says the same thing.
        const unconfirmed = [
            ['nothing named', authorizationFor('escape')],
            ['a conversion, no bound', authorizationFor('mutual')],
            ['a bound one below', authorizationFor('escape', { concededMax: String(conceded - 1n) })],
            ['a bound of nothing', authorizationFor('mutual', { concededMax: '0' })],
            ['another exact amount', authorizationFor('escape', { conceded: String(conceded - 1n) })],
            ['an exact amount above its cap', authorizationFor('escape', { conceded: bound, concededMax: String(conceded - 1n) })]
        ];
        for (const [label, authorization] of unconfirmed) {
            const error = await refusalOf(harness(), built, recovery, authorization);
            assert.equal(error.code, 4100, label);
            assert.equal(error.message, CONCESSION_UNCONFIRMED_MESSAGE, label);
        }
        // Any other reason for a refusal keeps the generic words, even when the
        // concession is not confirmed either: "cancel it and start again" would
        // be advice for the wrong problem.
        const other = [
            ['another operation', authorizationFor('escape', { operationId: 'op-shown' })],
            ['another operation, the amount confirmed', authorizationFor('escape', { concededMax: bound, operationId: 'op-shown' })],
            ['another note', authorizationFor('escape', { noteId: GOLDEN.noteId + 1 })],
            ['another destination', { ...authorizationFor('escape'), destination: getAddress(`0x${'77'.repeat(20)}`) }]
        ];
        for (const [label, authorization] of other) {
            const error = await refusalOf(harness(), built, recovery, authorization);
            assert.equal(error.code, 4100, label);
            assert.equal(error.message, GENERIC_DENIAL, label);
        }
        // The SDK may put its own wallet copy over a refused send's words before
        // the action ends; the explanation is restored over it (the error's
        // identity is kept), as it is for the payment failures.
        const replaced = harness();
        await replaced.provider.ensureAddress();
        const overwritten = await replaced.provider.withAuthorizedAction(authorizationFor('escape'), async () => {
            try {
                await replaced.provider.request({ method: 'eth_sendTransaction',
                    params: [{ from: OWN, to: GOLDEN.vault, data: built.data }], zkapiRecovery: recovery });
            } catch (failure) {
                failure.message = 'The wallet could not complete this request.';
                failure.shortMessage = 'The wallet could not complete this request.';
                throw failure;
            }
        }).catch(failure => failure);
        assert.equal(overwritten.message, CONCESSION_UNCONFIRMED_MESSAGE);
        assert.equal(overwritten.shortMessage, CONCESSION_UNCONFIRMED_MESSAGE);
        assert.equal(overwritten.code, 4100);
        // A refusal for any other reason is not given these words.
        const unrelated = await replaced.provider.withAuthorizedAction(authorizationFor('escape', { operationId: 'op-shown' }), async () => {
            try {
                await replaced.provider.request({ method: 'eth_sendTransaction',
                    params: [{ from: OWN, to: GOLDEN.vault, data: built.data }], zkapiRecovery: recovery });
            } catch (failure) {
                failure.message = 'The wallet could not complete this request.';
                throw failure;
            }
        }).catch(failure => failure);
        assert.equal(unrelated.message, 'The wallet could not complete this request.');
        // A concession that was confirmed is signed, with no complaint.
        assert.equal(await attempt(harness(), built, recovery, authorizationFor('escape', { concededMax: bound })), 'signed');
        // The same call under the legacy protocol's profile is not a call it knows: its words are unchanged.
        const legacy = harness(() => ({ adapter: noteBoundV1, deploymentId: DEPLOYMENT, version: { id: 'v1' } }));
        const error = await refusalOf(legacy, built, recovery, authorizationFor('escape'));
        assert.equal(error.message, GENERIC_DENIAL);
    });

    test(`wiring:ownership-proof-wait a prepared emergency exit continued after a reload with no bound to name is refused in plain words, and starting the withdrawal again goes through${suffix}`, async t => {
        // The SDK's saved plan concedes 300000. The page was reloaded, and the
        // state's bound has since dropped to nothing, so no figure is shown and
        // the dialog names none (nothing in `details`): the action is a bare
        // continue. The plan is the SDK's record of what it proved, not of what
        // anyone agreed to, so it is never read for a cap.
        const built = await source.build('escape', { finalBalance: 3_700_000n, conceded: 300_000n });
        const recovery = recoveryFor('escape', built, { operationId: 'op-escape' });
        const plan = concedingPlan(300_000, { operationId: 'op-escape' });
        assert.equal(plan.public_inputs.conceded, 300_000, 'the plan carries the concession as a public input');
        assert.equal(plan.concededAtInit, '300000');
        const h = harness();
        await h.provider.ensureAddress();
        const { act, authorizations } = pageWithSigner(t, { harness: h, built, recovery, plan });

        const reloaded = reopened(h);
        await reloaded.provider.init();
        for (const details of [{ kind: 'escape' }, { kind: 'withdraw' }, { kind: 'escape', operationId: 'op-escape' }]) {
            await assert.rejects(act(details, { as: reloaded }), error => {
                assert.equal(error.code, 4100);
                assert.equal(error.message, CONCESSION_UNCONFIRMED_MESSAGE);
                return true;
            });
        }
        assert.equal(h.rpc.sent.length, 0, 'nothing was signed or sent');
        for (const authorization of authorizations) {
            assert.equal(authorization.conceded, undefined, 'the action does not fill an amount from the saved plan');
            assert.equal(authorization.concededMax, undefined);
        }
        // The refusal left nothing behind that a repeat could lean on.
        await assert.rejects(act({ kind: 'escape' }, { as: reloaded }), { message: CONCESSION_UNCONFIRMED_MESSAGE });
        assert.equal(h.rpc.sent.length, 0);

        // What the words say to do: start the withdrawal again and see what it
        // gives up. An exit that gives up nothing is signed with nothing named.
        const fresh = await source.build('escape', { finalBalance: 4_000_000n, conceded: 0n });
        const hash = await act({ kind: 'escape' },
            { as: reloaded, call: fresh, context: recoveryFor('escape', fresh, { operationId: 'op-restarted' }) });
        assert.equal(Transaction.from(h.rpc.sent[0]).hash, hash);
        assert.equal(h.rpc.sent.length, 1);
    });
}

test('wiring:ownership-proof-wait the refusal says what happened and what to do, in the product’s own words', () => {
    const text = CONCESSION_UNCONFIRMED_MESSAGE;
    assert.match(text, /emergency exit/);
    assert.match(text, /nothing was sent/i);
    // It names a step that exists whatever the SDK did with its saved plan:
    // no button is named (the plan is usually already cleared when it is read).
    assert.match(text, /start the withdrawal again/i);
    assert.doesNotMatch(text, /\bcancel|\bbutton|\bclick|\btap\b/i);
    // The vocabulary of the rest of the product (copy.mjs): no protocol words,
    // no exclamation mark, a curly apostrophe if any, one plain paragraph.
    assert.doesNotMatch(text, /nullifier|vault|circuit|deployment|manifest|\bnotes?\b|proof\b|escape hatch|mutual close|unlinkable|nothing is lost|backup|restore/i);
    assert.doesNotMatch(text, /!|'|\p{Extended_Pictographic}|\s{2,}|[{}]|undefined|\bnull\b/u);
    assert.doesNotMatch(text, /\b[A-Z]{3,}\b/);
    // The SDK reads a wallet rejection from the words of a failed send: these
    // must not look like one, or the dialog would say "canceled" and nothing else.
    assert.doesNotMatch(text, /(?:user|wallet).*(?:reject|denied|cancel)|request rejected/i);
    assert.ok(text.length < 280, 'short enough for a toast and the dialog’s status line');
    assert.notEqual(text, GENERIC_DENIAL);
});

// ---------------------------------------------- what the SDK does before the words are read

// The SDK reads a refusal coded 4100 as a send that never reached the network
// and, for an escape that reserved no clearance, clears its unsubmitted plan
// itself before the host restores its words over the SDK's generic copy. So the
// dialog redraws with no prepared withdrawal, and a sentence that told the
// person to cancel it would name a button that is not there. This drives the
// SDK's own failure handler with the signer's real refusal.
const handlers = [{ name: 'installed SDK', client: zkapiClient, runtime: walletRuntime }];
if (root) {
    const services = path.join(root, 'sdk/services');
    const load = file => import(pathToFileURL(path.join(services, file)).href);
    const [clientModule, runtimeModule] = await Promise.all([load('zkapiClient.js'), load('browserWalletRuntime.js')]);
    handlers.push({ name: 'successor SDK', client: clientModule.default, runtime: runtimeModule.default });
}

for (const { name, client, runtime } of handlers) {
    test(`wiring:ownership-proof-wait the SDK clears the unsubmitted escape before the refusal is read, so the words name no cancel button [${name}]`, async t => {
        const built = await goldenSource().build('escape', { finalBalance: 3_700_000n, conceded: 300_000n });
        const recovery = recoveryFor('escape', built, { operationId: 'op-escape' });
        const h = harness();
        await h.provider.ensureAddress();
        const run = async (plan, { cleared }) => {
            const calls = [];
            let sdkWords = null;
            t.mock.method(runtime, 'snapshot', () => ({ runtime: { preparedWithdrawal: plan } }));
            t.mock.method(runtime, 'releaseBackgroundWithdrawalStartSubmission', async () => ({ location: null }));
            t.mock.method(runtime, 'clearPreparedWithdrawal', async () => { calls.push('clearPreparedWithdrawal'); });
            t.mock.method(client, 'rememberWithdrawal', value => { calls.push(['rememberWithdrawal', value]); });
            t.mock.method(client, 'refresh', async () => { calls.push('refresh'); });
            const failure = await h.provider.withAuthorizedAction(authorizationFor('escape'), async () => {
                try {
                    await h.provider.request({ method: 'eth_sendTransaction',
                        params: [{ from: OWN, to: GOLDEN.vault, data: built.data }], zkapiRecovery: recovery });
                } catch (error) {
                    // What the SDK's send path does with a refusal coded 4100.
                    error.transactionStage = 'send';
                    error.broadcastPossible = false;
                    await client.recoverFailedWithdrawalSubmission({ mode: 'escape', error, submittedHash: null,
                        submission: { submissionId: 'sub-1', operationId: 'op-escape', clearanceReserved: false },
                        submissionMetadata: null, from: OWN });
                    // What the SDK leaves behind, before the host restores its words.
                    sdkWords = error.shortMessage;
                    throw error;
                }
            }).catch(error => error);
            assert.equal(failure.code, 4100);
            assert.equal(h.rpc.sent.length, 0, 'nothing was signed or sent');
            // The SDK put its own copy over the refusal first; the host's words
            // are what the person reads once the action has ended.
            assert.equal(typeof sdkWords, 'string');
            assert.notEqual(sdkWords, CONCESSION_UNCONFIRMED_MESSAGE);
            assert.equal(failure.message, CONCESSION_UNCONFIRMED_MESSAGE);
            assert.equal(failure.shortMessage, CONCESSION_UNCONFIRMED_MESSAGE);
            assert.equal(calls.includes('clearPreparedWithdrawal'), cleared);
            for (const method of ['snapshot', 'releaseBackgroundWithdrawalStartSubmission', 'clearPreparedWithdrawal']) runtime[method].mock.restore();
            for (const method of ['rememberWithdrawal', 'refresh']) client[method].mock.restore();
            return calls;
        };
        // An emergency exit that reserved no clearance: the SDK drops its plan,
        // so there is nothing to cancel and the person starts again.
        const calls = await run(concedingPlan(300_000, { operationId: 'op-escape' }), { cleared: true });
        assert.deepEqual(calls, ['clearPreparedWithdrawal', ['rememberWithdrawal', null], 'refresh']);
        assert.doesNotMatch(CONCESSION_UNCONFIRMED_MESSAGE, /\bcancel/i);
        // One that did reserve it keeps its plan, which is then listed with its
        // own cancel button: "start again from the beginning" is a step there too.
        await run({ ...concedingPlan(300_000, { operationId: 'op-escape' }), clearanceReserved: true }, { cleared: false });
    });
}
