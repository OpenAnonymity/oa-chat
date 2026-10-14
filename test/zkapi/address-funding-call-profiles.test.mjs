import assert from 'node:assert/strict';
import test from 'node:test';
import { Transaction, Wallet, getAddress } from 'ethers';
import codec from '@openanonymity/zkapi-browser-sdk/wallet';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import { AddressFundingProvider, addressFundingWallet, installedVersionContext } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import { fundingDestination, runAddressAction, withdrawalDestination } from '../../chat/zkapi/services/addressFunding.js';
import { installActiveVersion, resetActiveVersionForTests } from '../../chat/zkapi/versioning/activeVersion.mjs';
import { concessionV1 } from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { noteBoundV1 } from '../../chat/zkapi/versioning/adapters/noteBoundV1.mjs';

// Vault calldata acceptance per protocol call profile: the signer's allowlist
// is data of the loaded version's adapter. v1 behavior is pinned by
// address-funding-provider.test.mjs and must not move; this file pins the
// matrix between the two profiles, the claim call, the destination denylist
// and the closed-version deposit denial, and what a concession-family escape
// may concede: the exact confirmed amount, a disclosed cap, a mutual request
// the SDK converted (never the reverse), and the operation that was shown.
// address-funding-escape-concession.test.mjs runs the same rules end to end.

// Calldata of `cast calldata` (Foundry 1.5.1) for the vault revision 3
// signatures, upstream sdk/test/fixtures/vault-calldata-golden.json. The proof
// bytes are 0x00..0xff. Independent of any SDK encoder.
const GOLDEN = {
    mutual: '0x72cd2e44000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000010000000000000000000000004386fdbda35d995beb3bf8625118ec5982ec81fe00000000000000000000000000000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000001300000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000015000000000000000000000000000000000000000000000000000000000000000700000000000000000000000000000000000000000000000000000000001c3a900000000000000000000000005615deb798bb3e4dfa0139dfa1b3d433cc23b72f0000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ffffffffffffffff00000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000100000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff',
    escape: '0xa38d62aa00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000aa36a7000000000000000000000000590df9abbfb21074016daa486c771ae0af729ee230644e72e131a029b85045b68181585d2833e84879b9709143e1f593f000000000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000013000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000150000000000000000000000000000000000000000000000000000000000000015000000000000000000000000000000000000000000000000001fffffffffffff0000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000002a5c6b0e9f1d3b7a8c4e2f6a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f2a3b4c0000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000006b49fc3000000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000100000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff'
};
const GOLDEN_MUTUAL = { chainId: 1, vault: '0x4386fdbda35d995beb3bf8625118ec5982ec81fe', noteId: 7, finalBalance: 0x1c3a90,
    destination: '0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f' };
const GOLDEN_ESCAPE = { chainId: 11155111, vault: '0x590df9abbfb21074016daa486c771ae0af729ee2', noteId: 0x15,
    finalBalance: 0x1fffffffffffff, destination: '0x2222222222222222222222222222222222222222', conceded: 100 };

const KEY = `0x${'11'.repeat(32)}`;
const OWN = new Wallet(KEY).address.toLowerCase();
const VAULT = `0x${'22'.repeat(20)}`;
const DESTINATION = `0x${'44'.repeat(20)}`;
const V1_DEPLOYMENT = 'zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930';
const V2_DEPLOYMENT = 'zkapi-native-eth-mainnet-concession-v1-fixture';
const hex = value => `0x${value.toString(16)}`;
const NATIVE = { billing_asset: 'native_eth', billing_unit: 'gwei', native_asset_wei_per_unit: '1000000000', demo_billing_token_address: null };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function signer({ chainId = 1, vault = VAULT, protocol, depositGate, store = memoryStore(), transport } = {}) {
    const calls = [];
    const funding = { chain_id: chainId, contract_address: vault, demo_rpc_url: 'https://rpc.example', ...NATIVE };
    const provider = new AddressFundingProvider({
        getConfig: () => funding, store, locks: locks(), createChannel: () => null,
        createWallet: () => new Wallet(KEY),
        ...(protocol ? { protocol } : {}), ...(depositGate ? { depositGate } : {}),
        transport: transport ?? (async (url, options) => { calls.push(JSON.parse(options.body).method); throw new Error('unexpected RPC'); })
    });
    return { provider, calls, store, funding };
}

const v1Protocol = (deploymentId = V1_DEPLOYMENT) => () => ({ adapter: noteBoundV1, deploymentId, version: { id: 'v1' } });
const v2Protocol = (deploymentId = V2_DEPLOYMENT) => () => ({ adapter: concessionV1, deploymentId, version: { id: 'v2' } });

// A calldata value as selector plus 32-byte words, and back.
function parts(calldata) {
    const body = calldata.slice(2).toLowerCase();
    return { selector: body.slice(0, 8), words: body.slice(8).match(/.{64}/g) || [] };
}
const join = ({ selector, words }) => `0x${selector}${words.join('')}`;
const wordOf = value => BigInt(value).toString(16).padStart(64, '0');
function withWord(calldata, index, value) {
    const decoded = parts(calldata);
    decoded.words[index] = typeof value === 'string' ? value : wordOf(value);
    return join(decoded);
}
const addressWord = address => address.slice(2).toLowerCase().padStart(64, '0');

function legacyPlan(mode, { chainId = 1, vault = VAULT, destination = DESTINATION } = {}) {
    return {
        mode,
        siblings: Array(32).fill('0x0'),
        proof: { backend: 'groth16_bn254', proof: Buffer.alloc(256).toString('base64') },
        public_inputs: { protocol_version: 2, chain_id: chainId, contract_address: vault, active_root: '0x1',
            state_signing_key_x: '0x1', state_signing_key_y: '0x1', clearance_signing_key_x: '0x1', clearance_signing_key_y: '0x1',
            note_id: 7, final_balance: 1_500_000, destination, withdrawal_nullifier: '0x2a',
            has_clearance: mode === 'mutual', withdrawal_tag: '0x8' }
    };
}

const exitContext = ({ deploymentId, chainId, vault, noteId, finalBalance, destination, mode }) => ({
    version: 1, kind: 'withdrawal', deploymentId, chainId, contractAddress: vault, operationId: 'op', submissionId: 'sub',
    noteId, destination, finalBalance, mode
});
const exitAuthorization = ({ destination, noteId, mode, conceded }) => ({
    kind: 'withdrawal', destination, noteId, mode, ...(conceded === undefined ? {} : { conceded }) });

// Runs validateCall exactly as the signing path does and resolves to the
// error code of a refusal (4100 for "not authorized"), or 'accepted'.
async function verdict(provider, input, recovery, authorization, { signing = true } = {}) {
    const ctx = await provider.context();
    try {
        provider.validateCall(ctx, OWN, { from: OWN, ...input }, recovery, authorization, { signing });
        return 'accepted';
    } catch (error) { return error.code; }
}

// ---------------------------------------------------------------------------
// The v1 profile is the default and is exactly today's rules
// ---------------------------------------------------------------------------

test('without an installed version the signer uses the note-bound-v1 call profile', async () => {
    resetActiveVersionForTests();
    assert.deepEqual(installedVersionContext(), { version: null, adapter: null, table: [] });
    const { provider } = signer();
    assert.equal(provider.signerProtocol().profile, noteBoundV1.callProfile);
    assert.equal(provider.signerProtocol().deploymentId, null);
    assert.equal(provider.signerProtocol().version, null);
});

test('v1 profile: the legacy deposit, close, escape and finalize calls are accepted', async () => {
    const { provider } = signer();
    const ethAmount = 5_000_000n;
    const deposit = { to: VAULT, data: codec.encodeDeposit({ commitment: '0x123', zero_path: Array(32).fill('0x0') }, ethAmount),
        value: hex(ethAmount * 1_000_000_000n) };
    assert.equal(await verdict(provider, deposit, { version: 1, kind: 'deposit', deploymentId: 'any-string', chainId: 1,
        contractAddress: VAULT, operationId: 'op', submissionId: 'sub', amount: ethAmount.toString(), commitment: '0x123' },
    { kind: 'deposit', amount: ethAmount.toString() }), 'accepted');
    for (const mode of ['mutual', 'escape']) {
        const data = codec.encodeWithdrawal(legacyPlan(mode), mode, DESTINATION, VAULT);
        assert.equal(await verdict(provider, { to: VAULT, data },
            exitContext({ deploymentId: 'any-string', chainId: 1, vault: VAULT, noteId: 7, finalBalance: 1_500_000, destination: DESTINATION, mode }),
            exitAuthorization({ destination: DESTINATION, noteId: 7, mode })), 'accepted', mode);
    }
    assert.equal(await verdict(provider, { to: VAULT, data: codec.encodeFinalizeEscape(7) },
        { version: 1, kind: 'finalization', deploymentId: 'any-string', chainId: 1, contractAddress: VAULT, operationId: 'op',
            submissionId: 'sub', noteId: 7 }, { kind: 'finalization', noteId: 7 }), 'accepted');
});

test('v1 profile: the revision 3 exits and the payout claim are denied', async () => {
    const { provider } = signer({ chainId: 1, vault: GOLDEN_MUTUAL.vault });
    const mutual = await verdict(provider, { to: GOLDEN_MUTUAL.vault, data: GOLDEN.mutual },
        exitContext({ deploymentId: 'd', chainId: 1, vault: GOLDEN_MUTUAL.vault, noteId: 7, finalBalance: GOLDEN_MUTUAL.finalBalance,
            destination: GOLDEN_MUTUAL.destination, mode: 'mutual' }),
        exitAuthorization({ destination: GOLDEN_MUTUAL.destination, noteId: 7, mode: 'mutual' }));
    assert.equal(mutual, 4100);
    const claim = await verdict(provider, { to: GOLDEN_MUTUAL.vault, data: `0x88c10aee${addressWord(DESTINATION)}` },
        { version: 1, kind: 'escape-payout-claim', deploymentId: 'd', chainId: 1, contractAddress: GOLDEN_MUTUAL.vault,
            recordId: 'r', noteId: 7, destination: DESTINATION },
        { kind: 'payout-claim', destination: DESTINATION, recordId: 'r', noteId: 7 });
    assert.equal(claim, 4100);
});

// ---------------------------------------------------------------------------
// The concession-v1 profile
// ---------------------------------------------------------------------------

function concessionExit(mode, overrides = {}) {
    const golden = mode === 'mutual' ? GOLDEN_MUTUAL : GOLDEN_ESCAPE;
    const base = { ...golden, ...overrides };
    return {
        base,
        input: { to: base.vault, data: GOLDEN[mode] },
        recovery: exitContext({ deploymentId: V2_DEPLOYMENT, chainId: base.chainId, vault: base.vault, noteId: base.noteId,
            finalBalance: base.finalBalance, destination: base.destination, mode }),
        authorization: exitAuthorization({ destination: base.destination, noteId: base.noteId, mode,
            ...(mode === 'escape' ? { conceded: String(base.conceded) } : {}) })
    };
}

function concessionSigner(mode) {
    const { base } = concessionExit(mode);
    return signer({ chainId: base.chainId, vault: base.vault, protocol: v2Protocol() });
}

test('concession-v1 profile: the real vault revision 3 close and escape calls are accepted', async () => {
    for (const mode of ['mutual', 'escape']) {
        const { provider } = concessionSigner(mode);
        const { input, recovery, authorization } = concessionExit(mode);
        assert.equal(await verdict(provider, input, recovery, authorization), 'accepted', mode);
    }
});

test('concession-v1 profile: the legacy exit layout and selectors are denied', async () => {
    const { provider } = signer({ chainId: 1, vault: GOLDEN_MUTUAL.vault, protocol: v2Protocol() });
    for (const mode of ['mutual', 'escape']) {
        const plan = legacyPlan(mode, { vault: GOLDEN_MUTUAL.vault, destination: GOLDEN_MUTUAL.destination });
        const data = codec.encodeWithdrawal(plan, mode, GOLDEN_MUTUAL.destination, GOLDEN_MUTUAL.vault);
        assert.equal(await verdict(provider, { to: GOLDEN_MUTUAL.vault, data },
            exitContext({ deploymentId: V2_DEPLOYMENT, chainId: 1, vault: GOLDEN_MUTUAL.vault, noteId: 7, finalBalance: 1_500_000,
                destination: GOLDEN_MUTUAL.destination, mode }),
            exitAuthorization({ destination: GOLDEN_MUTUAL.destination, noteId: 7, mode })), 4100, mode);
    }
});

test('concession-v1 profile: every binding of an exit is checked', async () => {
    const wrong = `0x${'99'.repeat(20)}`;
    const cases = {
        'selector of the other mode': { mode: 'mutual', mutate: data => data.replace('0x72cd2e44', '0xa38d62aa') },
        'kind word': { mode: 'mutual', mutate: data => withWord(data, 12, 0) },
        'bytes offset': { mode: 'mutual', mutate: data => withWord(data, 16, 1504) },
        'proof length': { mode: 'mutual', mutate: data => withWord(data, 17, 255) },
        'chain id': { mode: 'mutual', mutate: data => withWord(data, 1, 5) },
        'vault': { mode: 'mutual', mutate: data => withWord(data, 2, addressWord(wrong)) },
        'note id': { mode: 'mutual', mutate: data => withWord(data, 8, 8) },
        'final balance': { mode: 'mutual', mutate: data => withWord(data, 9, GOLDEN_MUTUAL.finalBalance + 1) },
        'destination': { mode: 'mutual', mutate: data => withWord(data, 10, addressWord(wrong)) },
        'a successor nullifier on a mutual close': { mode: 'mutual', mutate: data => withWord(data, 13, 1) },
        'a concession on a mutual close': { mode: 'mutual', mutate: data => withWord(data, 14, 1) },
        'a missing successor on an escape': { mode: 'escape', mutate: data => withWord(data, 13, 0) },
        'a successor equal to the nullifier': { mode: 'escape', mutate: data => withWord(data, 13, 0x16) },
        'an unconfirmed concession': { mode: 'escape', mutate: data => withWord(data, 14, 101) },
        'a trailing word': { mode: 'escape', mutate: data => `${data}${'00'.repeat(32)}` },
        'a missing word': { mode: 'escape', mutate: data => data.slice(0, -64) }
    };
    for (const [name, { mode, mutate }] of Object.entries(cases)) {
        const { provider } = concessionSigner(mode);
        const exit = concessionExit(mode);
        const input = { ...exit.input, data: mutate(exit.input.data) };
        assert.equal(await verdict(provider, input, exit.recovery, exit.authorization), 4100, name);
    }
    // The same calls with the user's authorization changed instead.
    for (const [name, change] of Object.entries({
        'another destination': authorization => ({ ...authorization, destination: wrong }),
        'another note': authorization => ({ ...authorization, noteId: 9 })
    })) {
        const { provider } = concessionSigner('escape');
        const exit = concessionExit('escape');
        assert.equal(await verdict(provider, exit.input, exit.recovery, change(exit.authorization)), 4100, name);
    }
    // A mutual close is never signed for a person who chose escape; only the
    // other direction exists (see the conversion tests below).
    {
        const { provider } = concessionSigner('mutual');
        const exit = concessionExit('mutual');
        assert.equal(await verdict(provider, exit.input, exit.recovery, { ...exit.authorization, mode: 'escape' }), 4100,
            'the other mode');
    }
});

test('concession-v1 profile: an escape concedes exactly what the authorization confirms, and nothing by default', async () => {
    const { provider } = concessionSigner('escape');
    const exit = concessionExit('escape');
    const withoutConfirmation = { ...exit.authorization };
    delete withoutConfirmation.conceded;
    // The golden escape concedes 100. Without a confirmed amount that is refused.
    assert.equal(await verdict(provider, exit.input, exit.recovery, withoutConfirmation), 4100);
    assert.equal(await verdict(provider, exit.input, exit.recovery, { ...exit.authorization, conceded: '99' }), 4100);
    assert.equal(await verdict(provider, exit.input, exit.recovery, { ...exit.authorization, conceded: '100' }), 'accepted');
    // An escape that concedes nothing needs no confirmation.
    const zero = { ...exit.input, data: withWord(exit.input.data, 14, 0) };
    assert.equal(await verdict(provider, zero, exit.recovery, withoutConfirmation), 'accepted');
    // A malformed confirmation is an error, never a pass.
    for (const bad of ['-1', '1.5', 'many', {}]) {
        assert.notEqual(await verdict(provider, exit.input, exit.recovery, { ...exit.authorization, conceded: bad }), 'accepted');
    }
});

// ---------------------------------------------------------------------------
// A requested mutual close that the SDK turns into an escape, and what an
// escape may concede
// ---------------------------------------------------------------------------

// The golden escape concedes 100. `conceded` and `concededMax` are what the
// person was shown and confirmed before the click; a request that names neither
// is what a mutual close the SDK later turned into an escape carries.
const withoutConceded = authorization => { const { conceded: _exact, ...rest } = authorization; return rest; };

test('concession-v1: a mutual request the SDK turned into an escape is signed within the confirmed bound', async () => {
    const { provider } = concessionSigner('escape');
    const exit = concessionExit('escape');
    const asked = withoutConceded({ ...exit.authorization, mode: 'mutual' });
    const free = { ...exit.input, data: withWord(exit.input.data, 14, 0) };
    // An escape that concedes nothing needs no confirmation.
    assert.equal(await verdict(provider, free, exit.recovery, asked), 'accepted', 'a conversion that concedes nothing');
    // One that concedes needs the amount or a cap the person was shown.
    assert.equal(await verdict(provider, exit.input, exit.recovery, asked), 4100, 'unconfirmed concession');
    assert.equal(await verdict(provider, exit.input, exit.recovery, { ...asked, concededMax: '100' }), 'accepted', 'a cap that equals it');
    assert.equal(await verdict(provider, exit.input, exit.recovery, { ...asked, concededMax: '5000' }), 'accepted', 'a cap above it');
    assert.equal(await verdict(provider, exit.input, exit.recovery, { ...asked, concededMax: '99' }), 4100, 'a cap below it');
    assert.equal(await verdict(provider, exit.input, exit.recovery, { ...asked, concededMax: '0' }), 4100, 'a zero cap');
    assert.equal(await verdict(provider, exit.input, exit.recovery, { ...asked, conceded: '100' }), 'accepted', 'the exact amount');
    assert.equal(await verdict(provider, exit.input, exit.recovery, { ...asked, conceded: '99' }), 4100, 'another exact amount');
    // Both given: both must hold.
    assert.equal(await verdict(provider, exit.input, exit.recovery, { ...asked, conceded: '100', concededMax: '100' }), 'accepted');
    assert.equal(await verdict(provider, exit.input, exit.recovery, { ...asked, conceded: '100', concededMax: '99' }), 4100);
    assert.equal(await verdict(provider, exit.input, exit.recovery, { ...asked, conceded: '99', concededMax: '500' }), 4100);
    // The cap is a cap: it never lets a different destination, note or balance through.
    const wrong = `0x${'99'.repeat(20)}`;
    for (const [name, call] of Object.entries({
        'destination': { ...exit.input, data: withWord(exit.input.data, 10, addressWord(wrong)) },
        'note': { ...exit.input, data: withWord(exit.input.data, 8, 8) },
        'balance': { ...exit.input, data: withWord(exit.input.data, 9, GOLDEN_ESCAPE.finalBalance + 1) }
    })) {
        assert.equal(await verdict(provider, call, exit.recovery, { ...asked, concededMax: '1000000' }), 4100, name);
    }
});

test('concession-v1: an escape the person chose is held to the same cap and exact amount', async () => {
    const { provider } = concessionSigner('escape');
    const exit = concessionExit('escape');
    const chosen = withoutConceded(exit.authorization);
    assert.equal(chosen.mode, 'escape');
    assert.equal(await verdict(provider, exit.input, exit.recovery, chosen), 4100);
    assert.equal(await verdict(provider, exit.input, exit.recovery, { ...chosen, concededMax: '100' }), 'accepted');
    assert.equal(await verdict(provider, exit.input, exit.recovery, { ...chosen, concededMax: '99' }), 4100);
    // A malformed cap or amount is an error, never a pass.
    for (const bad of ['-1', '1.5', 'many', {}, '0x', '1e2']) {
        assert.notEqual(await verdict(provider, exit.input, exit.recovery, { ...chosen, concededMax: bad }), 'accepted', `cap ${JSON.stringify(bad)}`);
        assert.notEqual(await verdict(provider, exit.input, exit.recovery, { ...chosen, conceded: bad }), 'accepted', `exact ${JSON.stringify(bad)}`);
    }
});

test('a mutual close is converted to an escape only by a protocol that has a concession field', async () => {
    // The concession family: accepted (above). The legacy family has no such
    // field and no conversion: its escape is signed only for an escape request.
    const { provider } = signer({ protocol: v1Protocol() });
    const escape = codec.encodeWithdrawal(legacyPlan('escape'), 'escape', DESTINATION, VAULT);
    const context = exitContext({ deploymentId: V1_DEPLOYMENT, chainId: 1, vault: VAULT, noteId: 7, finalBalance: 1_500_000,
        destination: DESTINATION, mode: 'escape' });
    assert.equal(await verdict(provider, { to: VAULT, data: escape }, context,
        exitAuthorization({ destination: DESTINATION, noteId: 7, mode: 'escape' })), 'accepted');
    assert.equal(await verdict(provider, { to: VAULT, data: escape }, context,
        exitAuthorization({ destination: DESTINATION, noteId: 7, mode: 'mutual' })), 4100);
    // The caps are not read by it either: they neither widen nor narrow it.
    assert.equal(await verdict(provider, { to: VAULT, data: escape }, context,
        { ...exitAuthorization({ destination: DESTINATION, noteId: 7, mode: 'escape' }), concededMax: '0', conceded: '7' }), 'accepted');
    assert.equal(await verdict(provider, { to: VAULT, data: escape }, context,
        { ...exitAuthorization({ destination: DESTINATION, noteId: 7, mode: 'mutual' }), concededMax: '1000000' }), 4100);
});

test('an escape is never converted into a mutual close, in either family', async () => {
    const { provider } = concessionSigner('mutual');
    const mutual = concessionExit('mutual');
    assert.equal(await verdict(provider, mutual.input, mutual.recovery, { ...mutual.authorization, mode: 'escape' }), 4100);
    assert.equal(await verdict(provider, mutual.input, mutual.recovery, { ...mutual.authorization, mode: 'escape', concededMax: '1000' }), 4100);
    const legacy = signer({ protocol: v1Protocol() });
    const data = codec.encodeWithdrawal(legacyPlan('mutual'), 'mutual', DESTINATION, VAULT);
    const context = exitContext({ deploymentId: V1_DEPLOYMENT, chainId: 1, vault: VAULT, noteId: 7, finalBalance: 1_500_000,
        destination: DESTINATION, mode: 'mutual' });
    assert.equal(await verdict(legacy.provider, { to: VAULT, data }, context,
        exitAuthorization({ destination: DESTINATION, noteId: 7, mode: 'escape' })), 4100);
});

test('the operation the person looked at is the operation signed', async () => {
    const concession = concessionSigner('escape');
    const exit = concessionExit('escape');
    const names = { ...exit.authorization };
    assert.equal(await verdict(concession.provider, exit.input, exit.recovery, { ...names, operationId: 'op' }), 'accepted');
    assert.equal(await verdict(concession.provider, exit.input, exit.recovery, { ...names, operationId: 'a-replacement' }), 4100);
    for (const bad of [123, {}, [], true, '']) {
        assert.equal(await verdict(concession.provider, exit.input, exit.recovery, { ...names, operationId: bad }), 4100,
            `operation ${JSON.stringify(bad)}`);
    }
    // Absent: nothing to compare, exactly as before.
    assert.equal(await verdict(concession.provider, exit.input, exit.recovery, names), 'accepted');
    // The same rule on a mutual close of either family.
    const mutual = concessionExit('mutual');
    const mutualSigner = concessionSigner('mutual');
    assert.equal(await verdict(mutualSigner.provider, mutual.input, mutual.recovery, { ...mutual.authorization, operationId: 'op' }), 'accepted');
    assert.equal(await verdict(mutualSigner.provider, mutual.input, mutual.recovery, { ...mutual.authorization, operationId: 'other' }), 4100);
    const legacy = signer({ protocol: v1Protocol() });
    const data = codec.encodeWithdrawal(legacyPlan('mutual'), 'mutual', DESTINATION, VAULT);
    const context = exitContext({ deploymentId: V1_DEPLOYMENT, chainId: 1, vault: VAULT, noteId: 7, finalBalance: 1_500_000,
        destination: DESTINATION, mode: 'mutual' });
    const base = exitAuthorization({ destination: DESTINATION, noteId: 7, mode: 'mutual' });
    assert.equal(await verdict(legacy.provider, { to: VAULT, data }, context, { ...base, operationId: 'op' }), 'accepted');
    assert.equal(await verdict(legacy.provider, { to: VAULT, data }, context, { ...base, operationId: 'other' }), 4100);
});

test('the claim, finalization and deposit calls do not read the withdrawal fields', async () => {
    const { provider } = signer({ protocol: v2Protocol() });
    const claim = claimCall();
    for (const extra of [{}, { concededMax: '0' }, { conceded: '5', operationId: 'whatever' }]) {
        assert.equal(await verdict(provider, claim.input, claim.recovery, { ...claim.authorization, ...extra }), 'accepted', JSON.stringify(extra));
    }
    // And the binding of the claim stays exactly as pinned above.
    assert.equal(await verdict(provider, claim.input, claim.recovery, { ...claim.authorization, destination: `0x${'77'.repeat(20)}` }), 4100);
    const finalize = { to: VAULT, data: codec.encodeFinalizeEscape(7) };
    const finalizeContext = { version: 1, kind: 'finalization', deploymentId: V2_DEPLOYMENT, chainId: 1, contractAddress: VAULT,
        operationId: 'op', submissionId: 'sub', noteId: 7 };
    assert.equal(await verdict(provider, finalize, finalizeContext, { kind: 'finalization', noteId: 7, concededMax: '9' }), 'accepted');
    assert.equal(await verdict(provider, finalize, finalizeContext, { kind: 'finalization', noteId: 8 }), 4100);
});

test('concession-v1 profile: deposit and finalization keep their unchanged layouts', async () => {
    const { provider } = signer({ protocol: v2Protocol() });
    const amount = 5_000_000n;
    const deposit = { to: VAULT, data: codec.encodeDeposit({ commitment: '0x123', zero_path: Array(32).fill('0x0') }, amount),
        value: hex(amount * 1_000_000_000n) };
    const depositContext = { version: 1, kind: 'deposit', deploymentId: V2_DEPLOYMENT, chainId: 1, contractAddress: VAULT,
        operationId: 'op', submissionId: 'sub', amount: amount.toString(), commitment: '0x123' };
    assert.equal(await verdict(provider, deposit, depositContext, { kind: 'deposit', amount: amount.toString() }), 'accepted');
    assert.equal(await verdict(provider, { to: VAULT, data: codec.encodeFinalizeEscape(7) },
        { version: 1, kind: 'finalization', deploymentId: V2_DEPLOYMENT, chainId: 1, contractAddress: VAULT, operationId: 'op',
            submissionId: 'sub', noteId: 7 }, { kind: 'finalization', noteId: 7 }), 'accepted');
});

// ---------------------------------------------------------------------------
// The payout claim
// ---------------------------------------------------------------------------

function claimCall(overrides = {}) {
    const destination = overrides.destination ?? DESTINATION;
    return {
        input: { to: VAULT, data: `0x88c10aee${addressWord(destination)}`, ...(overrides.input ?? {}) },
        recovery: { version: 1, kind: 'escape-payout-claim', deploymentId: V2_DEPLOYMENT, chainId: 1, contractAddress: VAULT,
            recordId: 'record-1', noteId: 7, destination, ...(overrides.recovery ?? {}) },
        authorization: { kind: 'payout-claim', destination, recordId: 'record-1', noteId: 7, ...(overrides.authorization ?? {}) }
    };
}

test('the payout claim is accepted only for the saved record and its own destination', async () => {
    const { provider } = signer({ protocol: v2Protocol() });
    const ok = claimCall();
    assert.equal(await verdict(provider, ok.input, ok.recovery, ok.authorization), 'accepted');
    const other = `0x${'77'.repeat(20)}`;
    const denied = {
        'another destination in the calldata': claimCall({ input: { data: `0x88c10aee${addressWord(other)}` } }),
        'another destination authorized': claimCall({ authorization: { destination: other } }),
        'another destination in the record': claimCall({ recovery: { destination: other } }),
        'a withdrawal authorization': claimCall({ authorization: { kind: 'withdrawal' } }),
        'a deposit recovery kind': claimCall({ recovery: { kind: 'deposit' } }),
        'another record': claimCall({ authorization: { recordId: 'record-2' } }),
        'no record': claimCall({ recovery: { recordId: undefined } }),
        'another note': claimCall({ authorization: { noteId: 8 } }),
        'ETH attached': claimCall({ input: { value: '0x1' } }),
        'an extra word': claimCall({ input: { data: `0x88c10aee${addressWord(DESTINATION)}${'00'.repeat(32)}` } }),
        'no word': claimCall({ input: { data: '0x88c10aee' } }),
        'another vault': claimCall({ input: { to: `0x${'55'.repeat(20)}` } })
    };
    for (const [name, call] of Object.entries(denied)) {
        assert.equal(await verdict(provider, call.input, call.recovery, call.authorization), 4100, name);
    }
});

test('a protocol without credited payouts neither authorizes nor signs a claim', async () => {
    const { provider } = signer({ protocol: v1Protocol() });
    await assert.rejects(provider.withAuthorizedAction({ kind: 'payout-claim', destination: DESTINATION }, async () => {}),
        { code: 4100 });
    const call = claimCall();
    assert.equal(await verdict(provider, call.input, { ...call.recovery, deploymentId: V1_DEPLOYMENT }, call.authorization), 4100);
});

// ---------------------------------------------------------------------------
// Deployment pin and closed-version deposit gate
// ---------------------------------------------------------------------------

test('with a version installed a call to be signed must name that version\'s deployment', async () => {
    const { provider } = signer({ protocol: v1Protocol() });
    const data = codec.encodeWithdrawal(legacyPlan('mutual'), 'mutual', DESTINATION, VAULT);
    const context = deploymentId => exitContext({ deploymentId, chainId: 1, vault: VAULT, noteId: 7, finalBalance: 1_500_000,
        destination: DESTINATION, mode: 'mutual' });
    const authorization = exitAuthorization({ destination: DESTINATION, noteId: 7, mode: 'mutual' });
    assert.equal(await verdict(provider, { to: VAULT, data }, context(V1_DEPLOYMENT), authorization), 'accepted');
    assert.equal(await verdict(provider, { to: VAULT, data }, context(V2_DEPLOYMENT), authorization), 4100);
    // A saved entry keeps the structural check only (the SDK compares the
    // deployment again when it resumes the entry): re-reading a journal this
    // signer wrote can never fail over a deployment string.
    assert.equal(await verdict(provider, { to: VAULT, data }, context(V2_DEPLOYMENT), authorization, { signing: false }), 'accepted');
    assert.equal(await verdict(provider, { to: VAULT, data }, { ...context(V1_DEPLOYMENT), deploymentId: '' }, authorization, { signing: false }), 4100);
});

function depositCall(amount = 5_000_000n) {
    return { input: { to: VAULT, data: codec.encodeDeposit({ commitment: '0x123', zero_path: Array(32).fill('0x0') }, amount),
        value: hex(amount * 1_000_000_000n) },
    recovery: { version: 1, kind: 'deposit', deploymentId: V1_DEPLOYMENT, chainId: 1, contractAddress: VAULT, operationId: 'op',
        submissionId: 'sub', amount: amount.toString(), commitment: '0x123' },
    authorization: { kind: 'deposit', amount: amount.toString() } };
}

test('a closed version refuses a new deposit signature but keeps its journal valid', async () => {
    const gates = [];
    const closed = { canStart: false, canResume: false, code: 'deposits_closed', successor: { id: 'v2', label: 'Version 2' } };
    let gate = { canStart: true, canResume: false, code: null, successor: null };
    const { provider } = signer({ protocol: v1Protocol(), depositGate: () => { gates.push(gate); return gate; } });
    const call = depositCall();
    assert.equal(await verdict(provider, call.input, call.recovery, call.authorization), 'accepted');
    gate = closed;
    assert.equal(await verdict(provider, call.input, call.recovery, call.authorization), 'deposits_closed');
    // Re-validating a saved journal entry never consults the gate.
    const before = gates.length;
    assert.equal(await verdict(provider, call.input, call.recovery, call.authorization, { signing: false }), 'accepted');
    assert.equal(gates.length, before);
    // A deposit that already started may resume.
    gate = { ...closed, canResume: true };
    assert.equal(await verdict(provider, call.input, call.recovery, call.authorization), 'accepted');
    // Anything other than an explicit allow is a refusal, including the falsy
    // and non-object answers a careless gate could return.
    for (const unexpected of [{}, { canStart: 'yes' }, { canStart: 1, canResume: 1 }, false, 0, '', true, 'allow', [], NaN]) {
        gate = unexpected;
        assert.equal(await verdict(provider, call.input, call.recovery, call.authorization), 'deposits_closed', String(JSON.stringify(unexpected)));
    }
    gate = null;
    assert.equal(await verdict(provider, call.input, call.recovery, call.authorization), 'accepted', 'no gate is no restriction');
    gate = undefined;
    assert.equal(await verdict(provider, call.input, call.recovery, call.authorization), 'accepted', 'an undefined answer is no gate either');
});

test('a gate that throws refuses; the refusal carries the closed error shape and ids only', async () => {
    const { provider } = signer({ protocol: v1Protocol(), depositGate: () => { throw new Error('gate failed'); } });
    const call = depositCall();
    const ctx = await provider.context();
    assert.throws(() => provider.validateCall(ctx, OWN, { from: OWN, ...call.input }, call.recovery, call.authorization, { signing: true }),
        error => error.code === 'deposits_closed' && error.status === 409 && error.data.gateCode === null
            && error.data.versionId === 'v1' && !/gate failed/.test(error.message));
});

test('validateCall signs by default: a caller that omits the flag gets the signing-boundary policy', async () => {
    const closed = { canStart: false, canResume: false, code: 'deposits_closed', successor: null };
    const { provider } = signer({ protocol: v1Protocol(), depositGate: () => closed });
    const call = depositCall();
    const ctx = await provider.context();
    const validate = (recovery, ...options) => provider.validateCall(ctx, OWN, { from: OWN, ...call.input }, recovery,
        call.authorization, ...options);
    // The closed-version gate applies to a call validated with no flag, with an empty options object...
    assert.throws(() => validate(call.recovery), { code: 'deposits_closed' });
    assert.throws(() => validate(call.recovery, {}), { code: 'deposits_closed' });
    // ...and only an explicit false (an already signed journal entry) skips it.
    assert.doesNotThrow(() => validate(call.recovery, { signing: false }));

    // So does the deployment pin: another deployment's recovery context is refused by default.
    const pinned = signer({ protocol: v1Protocol() }).provider;
    const wrongDeployment = { ...call.recovery, deploymentId: V2_DEPLOYMENT };
    assert.throws(() => pinned.validateCall(ctx, OWN, { from: OWN, ...call.input }, wrongDeployment, call.authorization),
        { code: 4100 });
    assert.doesNotThrow(() => pinned.validateCall(ctx, OWN, { from: OWN, ...call.input }, wrongDeployment, call.authorization,
        { signing: false }));
});

test('re-reading a saved journal applies no signing-only policy, whatever the gate and deployment say today', async () => {
    const open = { canStart: true, canResume: false, code: null, successor: null };
    let gate = open;
    const h = signingHarness({ protocol: v1Protocol(), depositGate: () => gate });
    await h.provider.ensureAddress();
    const call = depositCall();
    const hash = await h.provider.withAuthorizedAction(call.authorization,
        () => h.provider.request({ method: 'eth_sendTransaction', params: [{ from: OWN, ...call.input }], zkapiRecovery: call.recovery }));
    assert.equal(h.rpc.sent.length, 1);

    // A later page: deposits are closed and its deployment id differs from the one the entry was signed for.
    gate = { canStart: false, canResume: false, code: 'deposits_closed', successor: { id: 'v2', label: 'Version 2' } };
    const later = new AddressFundingProvider({ getConfig: () => h.funding, store: h.store, locks: locks(), createChannel: () => null,
        protocol: v1Protocol('zkapi-another-deployment'), depositGate: () => gate, transport: async () => assert.fail('no RPC') });
    await later.init();
    assert.equal(later.address, OWN);
    assert.equal(later.pending.hash, hash);
    const record = await later.read(await later.context(), true);
    assert.equal(record.transactions.length, 1);
    assert.equal(record.pending, hash);
});

function signingHarness(options = {}) {
    const rpc = { calls: [], sent: [], chain: '0x1', nonce: '0x0', balance: '0xde0b6b3a7640000', gas: '0x186a0',
        baseFee: '0x1dcd6500', priorityFee: '0x5f5e100', latest: '0x100', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` };
    const feeHistory = () => {
        const count = 20;
        return { oldestBlock: hex(BigInt(rpc.latest) - BigInt(count) + 1n), baseFeePerGas: Array(count + 1).fill(rpc.baseFee),
            gasUsedRatio: Array(count).fill(0.5), reward: Array.from({ length: count }, () => [rpc.priorityFee]) };
    };
    const transport = async (url, requestOptions) => {
        const request = JSON.parse(requestOptions.body);
        rpc.calls.push(request.method);
        let result;
        if (request.method === 'eth_chainId') result = rpc.chain;
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
    return { ...signer({ ...options, transport }), rpc };
}

test('a closed version signs no deposit and sends nothing; its saved deposit still recovers', async () => {
    let gate = { canStart: true, canResume: false, code: null, successor: null };
    const h = signingHarness({ protocol: v1Protocol(), depositGate: () => gate });
    await h.provider.ensureAddress();
    const call = depositCall();
    const send = () => h.provider.withAuthorizedAction(call.authorization,
        () => h.provider.request({ method: 'eth_sendTransaction', params: [{ from: OWN, ...call.input }], zkapiRecovery: call.recovery }));
    const hash = await send();
    assert.equal(h.rpc.sent.length, 1);
    assert.equal(Transaction.from(h.rpc.sent[0]).hash, hash);
    await h.provider.acknowledgeTransaction(hash);

    gate = { canStart: false, canResume: false, code: 'deposits_closed', successor: { id: 'v2', label: 'Version 2' } };
    const callsBefore = h.rpc.calls.length;
    await assert.rejects(send(), { code: 4100, addressCode: 'deposits_closed' });
    assert.equal(h.rpc.calls.length, callsBefore, 'refused before any RPC');
    assert.equal(h.rpc.sent.length, 1);
    // The journal holds the earlier deposit; reading it again is unaffected.
    const restored = new AddressFundingProvider({ getConfig: () => h.funding, store: h.store, locks: locks(), createChannel: () => null,
        protocol: v1Protocol(), depositGate: () => gate, transport: async () => assert.fail('no RPC') });
    await restored.init();
    assert.equal(restored.address, OWN);
    const record = await restored.read(await restored.context(), true);
    assert.equal(record.transactions.length, 1);
    // Quoting is refused too, before the SDK would be asked to prepare a plan.
    let prepared = 0;
    const quoting = new AddressFundingProvider({ getConfig: () => h.funding, store: h.store, locks: locks(), createChannel: () => null,
        protocol: v1Protocol(), depositGate: () => gate, transport: async () => assert.fail('no RPC'),
        prepareDepositQuote: async () => { prepared += 1; } });
    await assert.rejects(quoting.getDepositFeeQuote({ amount: '5000000', depositWei: '5000000000000000', ethAmount: '0.005' }),
        { code: 'deposits_closed', status: 409 });
    assert.equal(prepared, 0);
});

test('a version signs exits and sweeps for its own scope even when it no longer accepts deposits', async () => {
    const gate = { canStart: false, canResume: false, code: 'deposits_closed', successor: null };
    const h = signingHarness({ protocol: v1Protocol(), depositGate: () => gate });
    await h.provider.ensureAddress();
    const data = codec.encodeWithdrawal(legacyPlan('mutual'), 'mutual', DESTINATION, VAULT);
    const hash = await h.provider.withAuthorizedAction(exitAuthorization({ destination: DESTINATION, noteId: 7, mode: 'mutual' }),
        () => h.provider.request({ method: 'eth_sendTransaction', params: [{ from: OWN, to: VAULT, data }],
            zkapiRecovery: exitContext({ deploymentId: V1_DEPLOYMENT, chainId: 1, vault: VAULT, noteId: 7, finalBalance: 1_500_000,
                destination: DESTINATION, mode: 'mutual' }) }));
    assert.equal(h.rpc.sent.length, 1);
    assert.equal(Transaction.from(h.rpc.sent[0]).hash, hash);
});

test('the signer signs a payout claim through the real signing path under concession-v1', async () => {
    const h = signingHarness({ protocol: v2Protocol() });
    await h.provider.ensureAddress();
    const call = claimCall();
    const hash = await h.provider.withAuthorizedAction(call.authorization,
        () => h.provider.request({ method: 'eth_sendTransaction', params: [{ from: OWN, ...call.input }], zkapiRecovery: call.recovery }));
    const signed = Transaction.from(h.rpc.sent[0]);
    assert.equal(signed.hash, hash);
    assert.equal(signed.to.toLowerCase(), VAULT);
    assert.equal(signed.value, 0n);
    assert.equal(signed.data, call.input.data);
    // The journal remembers it as a claim and it survives a restart.
    const restored = new AddressFundingProvider({ getConfig: () => h.funding, store: h.store, locks: locks(), createChannel: () => null,
        protocol: v2Protocol(), transport: async () => assert.fail('no RPC') });
    await restored.init();
    assert.equal(restored.pending.hash, hash);
    assert.equal(restored.pending.kind, 'payout-claim');
    // The same bytes in a journal read under the other profile are damaged data, never trusted.
    const other = new AddressFundingProvider({ getConfig: () => h.funding, store: h.store, locks: locks(), createChannel: () => null,
        protocol: v1Protocol(), transport: async () => assert.fail('no RPC') });
    await assert.rejects(other.init(), { code: 'address_storage_invalid' });
});

// ---------------------------------------------------------------------------
// Destination denylist
// ---------------------------------------------------------------------------

const FUNDING = { chain_id: 1, contract_address: VAULT };

test('without versions the destination rules are unchanged', () => {
    resetActiveVersionForTests();
    const own = addressFundingWallet.state;
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: DESTINATION, pending: null };
    try {
        assert.equal(fundingDestination(DESTINATION, FUNDING), DESTINATION, 'a single version does not deny its own funding address');
        for (const bad of [`0x${'0'.repeat(40)}`, VAULT, 'not an address']) {
            assert.throws(() => fundingDestination(bad, FUNDING), undefined, bad);
        }
    } finally { addressFundingWallet.state = own; }
});

test('an explicit denylist replaces the registry list; the funding contract always applies', () => {
    const vaultTwo = `0x${'66'.repeat(20)}`;
    assert.throws(() => fundingDestination(vaultTwo, FUNDING, { denied: [vaultTwo.toLowerCase()] }));
    assert.equal(fundingDestination(vaultTwo, FUNDING, { denied: [] }), getAddress(vaultTwo));
    assert.throws(() => fundingDestination(VAULT, FUNDING, { denied: [] }));
});

const NOW = '2026-11-15T00:00:00.000Z';
function versionRow(overrides) {
    return { id: 'v1', ordinal: 1, label: 'Version 1', adapter: 'note-bound-v1', circuitId: 'zkapi-v2-note-bound-v1', vaultRevision: 1,
        status: 'exit-only', depositsOpen: false, depositsClosedSince: Date.parse(NOW), admissionClosesAt: null,
        deploymentId: V1_DEPLOYMENT, chainId: 1, vault: VAULT, rpcUrl: 'https://rpc.example', configSha256: null,
        assetBase: 'zkapi/', proxyPath: '/zkapi-deployment/', transition: { closeByMarginSeconds: 259200, reminderDays: [7, 3, 1], promptWindowDays: 14 },
        notices: [], ...overrides };
}

const TOMBSTONE_VAULT = `0x${'aa'.repeat(20)}`;
const V2_VAULT = `0x${'bb'.repeat(20)}`;
function table() {
    return [
        versionRow(),
        versionRow({ id: 'v2', ordinal: 2, label: 'Version 2', adapter: 'concession-v1', circuitId: 'zkapi-v2-concession-v1',
            vaultRevision: 3, status: 'active', depositsOpen: true, depositsClosedSince: null, deploymentId: V2_DEPLOYMENT,
            vault: V2_VAULT, assetBase: 'zkapi/v2c/', proxyPath: '/zkapi-deployment-v2c/' }),
        versionRow({ id: 'v0', ordinal: 0, status: 'retired', deploymentId: 'old', vault: TOMBSTONE_VAULT, rpcUrl: null, assetBase: null,
            proxyPath: null })
    ];
}

function install(versionId) {
    resetActiveVersionForTests();
    const rows = table();
    installActiveVersion({ table: rows, version: rows.find(row => row.id === versionId),
        selection: { version: rows.find(row => row.id === versionId), reason: 'single_version' } });
    return rows;
}

test('with versions installed a destination is never a registered vault, live or retired', t => {
    t.after(resetActiveVersionForTests);
    install('v1');
    const funding = { ...FUNDING, contract_address: VAULT };
    for (const vault of [VAULT, V2_VAULT, TOMBSTONE_VAULT]) {
        assert.throws(() => fundingDestination(vault, funding), /vault contract/, vault);
    }
    assert.equal(fundingDestination(DESTINATION, funding), DESTINATION);
});

test('with versions installed this browser\'s own funding address is refused as a typed destination', t => {
    t.after(resetActiveVersionForTests);
    const original = addressFundingWallet.state;
    t.after(() => { addressFundingWallet.state = original; });
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: DESTINATION, pending: null };
    install('v1');
    assert.throws(() => fundingDestination(DESTINATION, FUNDING), /funding address/);
    // The address of the other version's scope is a legitimate target.
    assert.equal(fundingDestination(`0x${'12'.repeat(20)}`, FUNDING), getAddress(`0x${'12'.repeat(20)}`));
    // A caller that knows better can still target it.
    assert.equal(fundingDestination(DESTINATION, FUNDING, { denied: [] }), DESTINATION);
});

test('a saved withdrawal destination stays completable even when it is this browser\'s funding address', t => {
    const originals = { config: zkapiClient.config, withdrawals: zkapiClient.withdrawals, withdrawal: zkapiClient.withdrawal };
    const walletState = addressFundingWallet.state;
    t.after(() => {
        Object.assign(zkapiClient, originals);
        addressFundingWallet.state = walletState;
        resetActiveVersionForTests();
    });
    install('v1');
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: DESTINATION, pending: null };
    Object.assign(zkapiClient, { config: { funding: FUNDING }, withdrawal: null,
        withdrawals: [{ recordId: 'saved-1', destination: DESTINATION, noteId: 7, mode: 'escape' }] });
    assert.equal(withdrawalDestination({ fundingDestination: null }, 'saved-1'), DESTINATION);
    assert.throws(() => withdrawalDestination({ fundingDestination: DESTINATION }), /funding address/);
});

// ---------------------------------------------------------------------------
// Installed version drives the default signer
// ---------------------------------------------------------------------------

test('the page\'s installed version selects the call profile and deployment pin', async t => {
    t.after(resetActiveVersionForTests);
    install('v2');
    const { provider } = signer({ chainId: 1, vault: GOLDEN_MUTUAL.vault });
    const context = provider.signerProtocol();
    assert.equal(context.profile.id, 'concession-v1');
    assert.equal(context.deploymentId, V2_DEPLOYMENT);
    const { input, recovery, authorization } = concessionExit('mutual');
    assert.equal(await verdict(provider, input, recovery, authorization), 'accepted');
    // v1's selectors are denied under it.
    const legacy = codec.encodeWithdrawal(legacyPlan('mutual', { vault: GOLDEN_MUTUAL.vault }), 'mutual', DESTINATION, GOLDEN_MUTUAL.vault);
    assert.equal(await verdict(provider, { to: GOLDEN_MUTUAL.vault, data: legacy },
        exitContext({ deploymentId: V2_DEPLOYMENT, chainId: 1, vault: GOLDEN_MUTUAL.vault, noteId: 7, finalBalance: 1_500_000,
            destination: DESTINATION, mode: 'mutual' }), exitAuthorization({ destination: DESTINATION, noteId: 7, mode: 'mutual' })), 4100);
});

test('runAddressAction authorizes the payout claim only under a protocol that has one', async t => {
    const originals = { config: zkapiClient.config, withdrawals: zkapiClient.withdrawals, withdrawal: zkapiClient.withdrawal,
        wallet: zkapiClient.wallet };
    const walletState = addressFundingWallet.state;
    t.after(() => {
        Object.assign(zkapiClient, originals);
        addressFundingWallet.state = walletState;
        resetActiveVersionForTests();
    });
    Object.assign(zkapiClient, { config: { funding: FUNDING }, withdrawal: null, wallet: { note: { note_id: 7 } },
        withdrawals: [{ recordId: 'credited-1', destination: DESTINATION, noteId: 7, mode: 'escape', payoutCredited: true }] });
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: `0x${'12'.repeat(20)}`, pending: null };
    const authorizations = [];
    t.mock.method(addressFundingWallet, 'withAuthorizedAction', async (authorization, action) => {
        authorizations.push(authorization);
        return action();
    });
    const owner = { fundingDestination: null, withdrawMode: 'mutual' };

    resetActiveVersionForTests();
    await assert.rejects(runAddressAction(owner, { kind: 'payout-claim', phase: 'wallet', withdrawalRecordId: 'credited-1' }, () => {},
        async () => assert.fail('no claim exists in the legacy protocol')), /no payout to claim/);

    install('v2');
    await runAddressAction(owner, { kind: 'payout-claim', phase: 'wallet', withdrawalRecordId: 'credited-1' }, () => {}, async () => {});
    assert.deepEqual(authorizations, [{ kind: 'payout-claim', destination: DESTINATION, recordId: 'credited-1', noteId: 7 }]);
    await assert.rejects(runAddressAction(owner, { kind: 'payout-claim', phase: 'wallet', withdrawalRecordId: 'missing' }, () => {},
        async () => assert.fail('unknown record')), /Choose the payout/);

    // An escape carries a confirmed concession only when the caller supplies one.
    authorizations.length = 0;
    owner.fundingDestination = `0x${'45'.repeat(20)}`;
    await runAddressAction(owner, { kind: 'escape', phase: 'wallet' }, () => {}, async () => {});
    await runAddressAction(owner, { kind: 'escape', phase: 'wallet', conceded: 250 }, () => {}, async () => {});
    assert.deepEqual(authorizations, [
        { kind: 'withdrawal', destination: owner.fundingDestination, mode: 'escape', noteId: 7 },
        { kind: 'withdrawal', destination: owner.fundingDestination, mode: 'escape', noteId: 7, conceded: '250' }
    ]);
});

// What a withdrawal action authorizes. The signer refuses anything else, so
// this is where the number the person confirmed meets the calldata.
async function withdrawalAuthorizations(t, { profile, plan = undefined, details }) {
    const originals = { config: zkapiClient.config, withdrawals: zkapiClient.withdrawals, withdrawal: zkapiClient.withdrawal,
        wallet: zkapiClient.wallet, runtime: walletRuntime.runtime };
    const walletState = addressFundingWallet.state;
    t.after(() => {
        Object.assign(zkapiClient, originals);
        walletRuntime.runtime = originals.runtime;
        addressFundingWallet.state = walletState;
        resetActiveVersionForTests();
    });
    Object.assign(zkapiClient, { config: { funding: FUNDING }, withdrawal: null, wallet: { note: { note_id: 7 } }, withdrawals: [] });
    walletRuntime.runtime = plan === undefined ? null : { preparedWithdrawal: plan };
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: `0x${'12'.repeat(20)}`, pending: null };
    if (profile) install(profile); else resetActiveVersionForTests();
    const authorizations = [];
    t.mock.method(addressFundingWallet, 'withAuthorizedAction', async (authorization, action) => {
        authorizations.push(authorization);
        return action();
    });
    const owner = { fundingDestination: `0x${'45'.repeat(20)}`, withdrawMode: 'mutual' };
    await runAddressAction(owner, { phase: 'wallet', ...details }, () => {}, async () => {});
    return authorizations;
}

const savedEscape = (overrides = {}) => ({ mode: 'escape', phase: 'prepared', operationId: 'op-escape', noteId: 7,
    concededAtInit: '300000', public_inputs: { note_id: 7, conceded: 300000 }, ...overrides });

test('a withdrawal action carries the cap, the exact amount and the operation the caller names', async t => {
    const [authorization] = await withdrawalAuthorizations(t, { profile: 'v2',
        details: { kind: 'withdraw', concededMax: 250000, operationId: 'op-shown' } });
    assert.deepEqual(authorization, { kind: 'withdrawal', destination: `0x${'45'.repeat(20)}`, mode: 'mutual', noteId: 7,
        concededMax: '250000', operationId: 'op-shown' });
    const [exact] = await withdrawalAuthorizations(t, { profile: 'v2',
        details: { kind: 'escape', conceded: 0, concededMax: 10, operationId: 'op-shown' } });
    assert.deepEqual(exact, { kind: 'withdrawal', destination: `0x${'45'.repeat(20)}`, mode: 'escape', noteId: 7,
        conceded: '0', concededMax: '10', operationId: 'op-shown' });
    // The legacy protocol: identical to what it always produced.
    const [legacy] = await withdrawalAuthorizations(t, { profile: null, details: { kind: 'withdraw' } });
    assert.deepEqual(legacy, { kind: 'withdrawal', destination: `0x${'45'.repeat(20)}`, mode: 'mutual', noteId: 7 });
});

test('a withdrawal action names a concession only when its caller does; the SDK\'s saved plan is never read for one', async t => {
    const continuing = { kind: 'withdraw', withdrawalRecordId: undefined };
    const run = options => withdrawalAuthorizations(t, { profile: 'v2', details: continuing, ...options }).then(list => list[0]);
    const named = authorization => ({ conceded: authorization.conceded, concededMax: authorization.concededMax });
    // A saved escape plan that concedes 300000, and the same for the same
    // operation named by the caller: still nothing is confirmed on its behalf.
    // (A repeat of an operation is held to its own earlier acceptance by the
    // signer, not by this function: see continuedAuthorization below.)
    assert.deepEqual(named(await run({ plan: savedEscape() })), { conceded: undefined, concededMax: undefined });
    assert.deepEqual(named(await run({ plan: savedEscape(), details: { ...continuing, operationId: 'op-escape' } })),
        { conceded: undefined, concededMax: undefined });
    assert.deepEqual(named(await run({ plan: savedEscape({ concededAtInit: '0', public_inputs: { note_id: 7, conceded: 0 } }) })),
        { conceded: undefined, concededMax: undefined });
    assert.deepEqual(named(await run({ plan: null })), { conceded: undefined, concededMax: undefined });
    // What the caller names is what is authorized, as text, and nothing else is added.
    assert.deepEqual(named(await run({ plan: savedEscape(), details: { ...continuing, concededMax: 1000000 } })),
        { conceded: undefined, concededMax: '1000000' });
    assert.deepEqual(named(await run({ plan: savedEscape(), details: { ...continuing, conceded: 5 } })),
        { conceded: '5', concededMax: undefined });
    // The legacy protocol has none of it.
    const [legacy] = await withdrawalAuthorizations(t, { profile: null, plan: savedEscape(), details: continuing });
    assert.equal(Object.hasOwn(legacy, 'conceded'), false);
    assert.equal(Object.hasOwn(legacy, 'concededMax'), false);
});

test('an escape converted from a mutual request, within its disclosed cap, is signed and journaled', async t => {
    const { base } = concessionExit('escape');
    const harness = () => {
        const h = signingHarness({ chainId: base.chainId, vault: base.vault, protocol: v2Protocol() });
        h.rpc.chain = `0x${base.chainId.toString(16)}`;
        return h;
    };
    const h = harness();
    await h.provider.ensureAddress();
    const exit = concessionExit('escape');
    const authorization = { ...withoutConceded(exit.authorization), mode: 'mutual', concededMax: '100', operationId: 'op' };
    const hash = await h.provider.withAuthorizedAction(authorization,
        () => h.provider.request({ method: 'eth_sendTransaction', params: [{ from: OWN, ...exit.input }], zkapiRecovery: exit.recovery }));
    assert.equal(h.rpc.sent.length, 1);
    assert.equal(Transaction.from(h.rpc.sent[0]).hash, hash);
    assert.equal(Transaction.from(h.rpc.sent[0]).data, exit.input.data);

    // The saved entry is read back by a later page with the same rules, and
    // the SDK resumes it under its recovery context.
    const restored = new AddressFundingProvider({ getConfig: () => h.funding, store: h.store, locks: locks(), createChannel: () => null,
        protocol: v2Protocol(), transport: async () => assert.fail('no RPC') });
    await restored.init();
    assert.equal(restored.pending.hash, hash);
    assert.equal(restored.pending.kind, 'withdrawal');
    const record = await restored.read(await restored.context(), true);
    // The journal keeps what was signed: the mode actually signed (the request
    // is kept beside it) and the exact amount, with the cap that was disclosed.
    const [saved] = record.transactions;
    assert.equal(saved.authorization.mode, 'escape');
    assert.equal(saved.authorization.requestedMode, 'mutual');
    assert.equal(saved.authorization.conceded, String(GOLDEN_ESCAPE.conceded));
    assert.equal(saved.authorization.concededMax, '100');
    assert.equal(saved.authorization.operationId, 'op');
    assert.equal(saved.context.mode, 'escape');
    // A build without the conversion and cap rules (an older tab, a page that
    // was rolled back) judges every saved entry by one rule. It must accept
    // this one, or the whole address would read as damaged.
    assert.equal(predatingRuleAccepts(saved), true);

    // Above the cap: refused before any RPC and nothing is signed.
    const dearer = harness();
    await dearer.provider.ensureAddress();
    const callsBefore = dearer.rpc.calls.length;
    await assert.rejects(dearer.provider.withAuthorizedAction({ ...authorization, concededMax: '99' },
        () => dearer.provider.request({ method: 'eth_sendTransaction', params: [{ from: OWN, ...exit.input }], zkapiRecovery: exit.recovery })),
    { code: 4100 });
    assert.equal(dearer.rpc.sent.length, 0);
    assert.equal(dearer.rpc.calls.length, callsBefore, 'no network call after the refusal');
});

// The one rule a build that predates the conversion and cap rules applies to a
// saved withdrawal of a protocol that concedes: the authorized mode is the mode
// that was signed, and the concession is exactly the amount authorized (none
// authorized means nothing conceded). It ignores every other authorization key.
function predatingRuleAccepts(entry, profile = concessionV1.callProfile) {
    const { selector, words } = parts(entry.transaction.data);
    const exit = profile.exits.find(item => item.selector === selector);
    const conceded = BigInt(`0x${words[exit.concededWord]}`);
    const authorized = entry.authorization.conceded == null ? 0n : BigInt(entry.authorization.conceded);
    return (!entry.authorization.mode || entry.authorization.mode === entry.context.mode) && conceded === authorized;
}

// ---------------------------------------------------------------------------
// Continuing an escape that concedes
// ---------------------------------------------------------------------------

// A signing provider for the golden escape (concedes 100), one page of it. A
// second provider over the same store and RPC is "the same browser after a
// reload": nothing in memory, the journal intact.
function escapeSigner() {
    const exit = concessionExit('escape');
    const h = signingHarness({ chainId: exit.base.chainId, vault: exit.base.vault, protocol: v2Protocol() });
    h.rpc.chain = hex(exit.base.chainId);
    const page = () => new AddressFundingProvider({ getConfig: () => h.funding, store: h.store, locks: locks(),
        createChannel: () => null, protocol: v2Protocol(), transport: h.provider.transport });
    // The authorization of a mutual request the SDK turned into this escape,
    // with whatever the caller names.
    const asked = (named = {}) => ({ ...withoutConceded(exit.authorization), mode: 'mutual', ...named });
    const sign = (provider, authorization, { data = exit.input.data, recovery = exit.recovery } = {}) =>
        provider.withAuthorizedAction(authorization, () => provider.request({ method: 'eth_sendTransaction',
            params: [{ from: OWN, ...exit.input, data }], zkapiRecovery: recovery }));
    return { exit, h, page, asked, sign };
}

test('a refused escape is refused again when the action is repeated without its bound, in this page and after a reload', async () => {
    const { exit, h, page, asked, sign } = escapeSigner();
    await h.provider.ensureAddress();
    // The disclosed bound is below what the SDK proved: refused, nothing signed.
    await assert.rejects(sign(h.provider, asked({ concededMax: '99' })), { code: 4100 });
    // Repeating the action without a bound is not a way round it.
    await assert.rejects(sign(h.provider, asked()), { code: 4100 });
    await assert.rejects(sign(h.provider, withoutConceded(exit.authorization)), { code: 4100 });
    await assert.rejects(sign(h.provider, asked({ operationId: 'op' })), { code: 4100 });
    assert.equal(h.rpc.sent.length, 0);
    // The same after a reload: a refusal leaves nothing to resume from.
    const next = page();
    await next.init();
    await assert.rejects(sign(next, asked()), { code: 4100 });
    assert.equal(h.rpc.sent.length, 0);
    // The person confirms what is given up: only then is it signed.
    const hash = await sign(next, asked({ concededMax: '100' }));
    assert.equal(h.rpc.sent.length, 1);
    assert.equal(Transaction.from(h.rpc.sent[0]).hash, hash);
});

test('a repeat of an escape this signer already signed is held to no more than the amount it signed', async () => {
    const { exit, h, page, asked, sign } = escapeSigner();
    await h.provider.ensureAddress();
    const first = await sign(h.provider, asked({ concededMax: '100' }));
    await h.provider.acknowledgeTransaction(first);
    h.rpc.nonce = '0x1';
    // The same operation, the same note, no bound named (a replacement or a
    // repeat): signed, and the journal states the exact amount it was held to.
    const second = await sign(h.provider, asked());
    assert.equal(h.rpc.sent.length, 2);
    assert.equal(Transaction.from(h.rpc.sent[1]).hash, second);
    await h.provider.acknowledgeTransaction(second);
    h.rpc.nonce = '0x2';
    const record = await h.provider.read(await h.provider.context(), true);
    assert.equal(record.transactions[1].authorization.conceded, '100');
    assert.equal(record.transactions[1].authorization.concededMax, '100', 'the hold is a cap, kept beside the amount');
    assert.equal(predatingRuleAccepts(record.transactions[1]), true);

    // A larger amount (the plan was proved again at a bigger concession),
    // another operation and another note are not that confirmation.
    const dearer = withWord(exit.input.data, 14, 101);
    await assert.rejects(sign(h.provider, asked(), { data: dearer }), { code: 4100 });
    await assert.rejects(sign(h.provider, asked(), { recovery: { ...exit.recovery, operationId: 'op-another' } }), { code: 4100 });
    // The same operation id on another note (every field of that call is
    // consistent with that note): the amount signed for this one is not its.
    const otherNote = exit.base.noteId + 1;
    await assert.rejects(sign(h.provider, asked({ noteId: otherNote }),
        { data: withWord(exit.input.data, 8, otherNote), recovery: { ...exit.recovery, noteId: otherNote } }), { code: 4100 });
    assert.equal(h.rpc.sent.length, 2);

    // After a reload the journal alone carries it.
    const next = page();
    await next.init();
    const third = await sign(next, asked());
    assert.equal(Transaction.from(h.rpc.sent[2]).hash, third);
    // A caller that names its own bound is judged by that bound, as always.
    await next.acknowledgeTransaction(third);
    h.rpc.nonce = '0x3';
    await assert.rejects(sign(next, asked({ concededMax: '99' })), { code: 4100 });
});

test('a repeat that concedes less than the signer accepted is signed; the hold follows the most recent amount down', async () => {
    const { exit, h, page, asked, sign } = escapeSigner();
    await h.provider.ensureAddress();
    const first = await sign(h.provider, asked({ concededMax: '100' }));
    await h.provider.acknowledgeTransaction(first);
    h.rpc.nonce = '0x1';

    // The plan was proved again and now concedes 40: the person gives up less
    // than they confirmed, so a repeat that names no bound is signed.
    const lower = withWord(exit.input.data, 14, 40);
    const second = await sign(h.provider, asked(), { data: lower });
    assert.equal(h.rpc.sent.length, 2);
    assert.equal(Transaction.from(h.rpc.sent[1]).hash, second);
    await h.provider.acknowledgeTransaction(second);
    h.rpc.nonce = '0x2';
    const record = await h.provider.read(await h.provider.context(), true);
    // The journal states what was signed, and the cap it was held to.
    assert.equal(record.transactions[1].authorization.conceded, '40');
    assert.equal(record.transactions[1].authorization.concededMax, '100');
    assert.equal(predatingRuleAccepts(record.transactions[1]), true);

    // The most recent amount is the hold from here on: back at 100 (what the
    // person confirmed first) is refused until they confirm it again, in this
    // page and after a reload alike.
    await assert.rejects(sign(h.provider, asked()), { code: 4100 });
    const next = page();
    await next.init();
    await assert.rejects(sign(next, asked()), { code: 4100 });
    assert.equal(h.rpc.sent.length, 2);
    const third = await sign(next, asked({ concededMax: '100' }));
    assert.equal(Transaction.from(h.rpc.sent[2]).hash, third);
});

test('the hold is the smaller of the journal and this page\'s memory, never the larger', async () => {
    const { exit, h, asked, sign } = escapeSigner();
    await h.provider.ensureAddress();
    const first = await sign(h.provider, asked({ concededMax: '100' }));
    await h.provider.acknowledgeTransaction(first);
    h.rpc.nonce = '0x1';
    // The journal says 100. This page then accepts a call that concedes 40 and
    // stops before signing (no ETH): its memory says 40.
    h.rpc.balance = '0x0';
    const lower = withWord(exit.input.data, 14, 40);
    await assert.rejects(sign(h.provider, asked(), { data: lower }), { code: 4100, addressCode: 'address_insufficient_eth' });
    h.rpc.balance = '0xde0b6b3a7640000';
    // 100 is within the journal and above the memory: not signed.
    await assert.rejects(sign(h.provider, asked()), { code: 4100 });
    assert.equal(h.rpc.sent.length, 1);
    // 40 is within both: signed.
    const second = await sign(h.provider, asked(), { data: lower });
    assert.equal(Transaction.from(h.rpc.sent[1]).hash, second);
});

test('an attempt that stopped after validation, before anything was signed, is continued in the same page only', async () => {
    const { h, asked, sign } = escapeSigner();
    await h.provider.ensureAddress();
    // No ETH to pay for the transaction: the call was accepted, nothing was signed.
    h.rpc.balance = '0x0';
    await assert.rejects(sign(h.provider, asked({ concededMax: '100' })), { code: 4100, addressCode: 'address_insufficient_eth' });
    assert.equal(h.rpc.sent.length, 0);
    h.rpc.balance = '0xde0b6b3a7640000';
    // Funded, repeated without a bound, in the same page: held to what was accepted.
    const hash = await sign(h.provider, asked());
    assert.equal(Transaction.from(h.rpc.sent[0]).hash, hash);

    // The same stop followed by a reload: memory is gone and nothing was
    // signed, so the person confirms again. Nothing is resumed from a plan.
    const other = escapeSigner();
    await other.h.provider.ensureAddress();
    other.h.rpc.balance = '0x0';
    await assert.rejects(other.sign(other.h.provider, other.asked({ concededMax: '100' })), { code: 4100, addressCode: 'address_insufficient_eth' });
    other.h.rpc.balance = '0xde0b6b3a7640000';
    const reloaded = other.page();
    await reloaded.init();
    await assert.rejects(other.sign(reloaded, other.asked()), { code: 4100 });
    assert.equal(other.h.rpc.sent.length, 0);
    await other.sign(reloaded, other.asked({ concededMax: '100' }));
    assert.equal(other.h.rpc.sent.length, 1);
});

test('only accepted escapes are remembered, a bounded number of them', async () => {
    const { exit, h, asked, sign } = escapeSigner();
    await h.provider.ensureAddress();
    await assert.rejects(sign(h.provider, asked({ concededMax: '99' })), { code: 4100 });
    assert.equal(h.provider.acceptedConcessions.size, 0, 'a refusal is not remembered');
    h.rpc.balance = '0x0';
    for (let index = 0; index < 20; index += 1) {
        const recovery = { ...exit.recovery, operationId: `op-${index}` };
        await assert.rejects(sign(h.provider, asked({ concededMax: '100' }), { recovery }), { code: 4100 });
    }
    assert.equal(h.provider.acceptedConcessions.size, 16);
    assert.deepEqual([...h.provider.acceptedConcessions.keys()].slice(0, 2), ['op-4', 'op-5'], 'the oldest are dropped');
});

test('a protocol that concedes nothing is untouched: the journal keeps the authorization exactly as given', async () => {
    // The legacy family and a concession-family mutual close have no
    // concession to hold anything to.
    const legacy = signingHarness({ protocol: v1Protocol() });
    await legacy.provider.ensureAddress();
    const data = codec.encodeWithdrawal(legacyPlan('mutual'), 'mutual', DESTINATION, VAULT);
    const context = exitContext({ deploymentId: V1_DEPLOYMENT, chainId: 1, vault: VAULT, noteId: 7, finalBalance: 1_500_000,
        destination: DESTINATION, mode: 'mutual' });
    const authorization = { ...exitAuthorization({ destination: DESTINATION, noteId: 7, mode: 'mutual' }), operationId: 'op' };
    const hash = await legacy.provider.withAuthorizedAction(authorization, () => legacy.provider.request({
        method: 'eth_sendTransaction', params: [{ from: OWN, to: VAULT, data }], zkapiRecovery: context }));
    assert.equal(Transaction.from(legacy.rpc.sent[0]).hash, hash);
    const record = await legacy.provider.read(await legacy.provider.context(), true);
    assert.deepEqual(record.transactions[0].authorization, authorization);
    assert.equal(legacy.provider.acceptedConcessions.size, 0);

    const exit = concessionExit('mutual');
    const successor = signingHarness({ chainId: exit.base.chainId, vault: exit.base.vault, protocol: v2Protocol() });
    successor.rpc.chain = hex(exit.base.chainId);
    await successor.provider.ensureAddress();
    await successor.provider.withAuthorizedAction(exit.authorization, () => successor.provider.request({
        method: 'eth_sendTransaction', params: [{ from: OWN, ...exit.input }], zkapiRecovery: exit.recovery }));
    const saved = await successor.provider.read(await successor.provider.context(), true);
    assert.deepEqual(saved.transactions[0].authorization, exit.authorization);
    assert.equal(successor.provider.acceptedConcessions.size, 0);
});

test('an entry in the shape an earlier build of the rule wrote is still read, and recovered, by this one', async () => {
    const { exit, h, page, asked, sign } = escapeSigner();
    await h.provider.ensureAddress();
    const hash = await sign(h.provider, asked({ concededMax: '100', operationId: 'op' }));
    // Rewrite the saved entry as it was kept before the journal recorded what
    // was signed: the request's mode and the cap, no exact amount.
    const ctx = await h.provider.context();
    await h.provider.locked(ctx, async () => {
        const record = await h.provider.read(ctx, true);
        const [entry] = record.transactions;
        entry.authorization = { ...asked({ concededMax: '100', operationId: 'op' }) };
        await h.provider.save(ctx, record);
    });
    // The rule that older shape was written under accepts it...
    const next = page();
    await next.init();
    assert.equal(next.pending.hash, hash);
    const record = await next.read(await next.context(), true);
    assert.equal(record.transactions[0].authorization.mode, 'mutual');
    assert.equal(record.transactions[0].authorization.conceded, undefined);
    // ...and the build before the conversion rule would not have: that is why
    // the journal now keeps the signed mode and the exact amount.
    assert.equal(predatingRuleAccepts(record.transactions[0]), false);
    assert.equal(exit.recovery.mode, 'escape');
});

test('the default signer reads the facade the host attaches for its deposit gate', async t => {
    const h = signer({ protocol: v1Protocol() });
    const call = depositCall();
    delete zkapiClient.oaVersioning;
    t.after(() => { delete zkapiClient.oaVersioning; });
    // Without a facade: no restriction, exactly as before versioning.
    const plain = new AddressFundingProvider({ getConfig: () => h.funding, store: h.store, locks: locks(), createChannel: () => null,
        protocol: v1Protocol(), transport: async () => assert.fail('no RPC') });
    assert.equal(await verdict(plain, call.input, call.recovery, call.authorization), 'accepted');
    zkapiClient.oaVersioning = { depositGate: () => ({ canStart: false, canResume: false, code: 'foreign_runtime', successor: null }) };
    assert.equal(await verdict(plain, call.input, call.recovery, call.authorization), 'deposits_closed');
    zkapiClient.oaVersioning = { depositGate: () => ({ canStart: true, canResume: false, code: null, successor: null }) };
    assert.equal(await verdict(plain, call.input, call.recovery, call.authorization), 'accepted');
});

// The shipped adapters must keep naming profiles of the shape consumed here.
test('adapter call profiles carry every field the signer reads', () => {
    for (const adapter of [noteBoundV1, concessionV1]) {
        const profile = adapter.callProfile;
        assert.equal(profile.id, adapter.id);
        assert.match(profile.deposit.selector, /^[0-9a-f]{8}$/);
        for (const exit of profile.exits) {
            assert.equal(typeof exit.kind.value, 'bigint');
            assert.equal(typeof exit.bytesOffset.value, 'bigint');
            assert.equal(typeof exit.proofLength.value, 'bigint');
            assert.ok(Array.isArray(exit.zeroWords) && Array.isArray(exit.nonZeroWords));
        }
        assert.ok(profile.finalize.selector);
    }
});
