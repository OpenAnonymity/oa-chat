// The host's judgment of a sponsored (ERC-4337) operation
// (services/sponsoredOperation.mjs), against a complete signed operation that
// Foundry produced (test/fixtures/zkapi-sponsored-vectors.json: upstream's
// transit vectors, independent of every SDK encoder), and against the
// refusals of everything an operation can get wrong.
//
// What is pinned:
//   - the operation hash, the transit account and the initCode this module
//     computes equal the vectors' (the formulas are computed again here, not
//     imported from the SDK);
//   - the vector's own signed close is accepted for the withdrawal it belongs
//     to, and nothing else is: another payee, owner, note, mode, paymaster,
//     EntryPoint, fee cap, call, gas, signature or concession is refused with
//     its own code;
//   - finalization and collection operations are judged by their own rules.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet, getBytes } from 'ethers';
import vectors from '../fixtures/zkapi-sponsored-vectors.json' with { type: 'json' };
import { concessionV1 } from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import leafBoundV2 from '../../chat/zkapi/versioning/adapters/leafBoundV2.mjs';
import { noteBoundV1 } from '../../chat/zkapi/versioning/adapters/noteBoundV1.mjs';
import {
    SponsoredOperationError, concessionConfirmed, deriveTransitAccount, expectedInitCode, judgeSponsoredOperation,
    readSponsoredPins, sponsoredOperationHash
} from '../../chat/zkapi/services/sponsoredOperation.mjs';

const V = vectors;
const C = V.close;
const OWNER_KEY = V.owner_private_key;
const profile = concessionV1.callProfile;
const hex = value => `0x${BigInt(value).toString(16)}`;
const word = value => BigInt(value).toString(16).padStart(64, '0');
const low = value => String(value).toLowerCase();

const trusted = () => ({
    gasless: {
        entry_point_address: V.entry_point,
        withdrawal_paymaster_address: V.paymaster,
        withdrawal_account_factory_address: V.factory,
        account_creation_code: V.account_creation_code,
        account_creation_code_keccak256: V.account_creation_code_keccak256,
        bundler_url: 'https://bundler.example/rpc',
        policy: { max_sponsored_cost_wei: V.policy.max_sponsored_cost, flat_fee_wei: V.policy.flat_fee_wei,
            min_escape_net_wei: V.policy.min_escape_net_wei, escapes_enabled: true },
        fee_ceilings: { max_fee_wei: V.policy.max_fee_ceiling, priority_fee_wei: V.policy.priority_fee_ceiling }
    }
});
const pins = readSponsoredPins(trusted());
const context = (overrides = {}) => ({
    pins, vault: V.vault, chainId: V.chain_id, owner: V.owner, profile, entryPoint: V.entry_point, ...overrides
});

// The vector's operation in the unpacked JSON form eth_sendUserOperation takes.
function vectorOperation() {
    const initCode = C.init_code;
    return {
        sender: C.sender,
        nonce: hex(C.nonce),
        factory: initCode.slice(0, 42),
        factoryData: `0x${initCode.slice(42)}`,
        callData: C.call_data,
        callGasLimit: hex(C.call_gas_limit),
        verificationGasLimit: hex(C.verification_gas_limit),
        preVerificationGas: hex(C.pre_verification_gas),
        maxFeePerGas: hex(C.max_fee_per_gas),
        maxPriorityFeePerGas: hex(C.max_priority_fee_per_gas),
        paymaster: V.paymaster,
        paymasterVerificationGasLimit: hex(C.paymaster_verification_gas_limit),
        paymasterPostOpGasLimit: hex(C.paymaster_post_op_gas_limit),
        paymasterData: `0x${BigInt(C.fee_cap_wei).toString(16).padStart(24, '0')}`,
        signature: C.signature
    };
}

const authorization = (extra = {}) => ({
    kind: 'withdrawal', destination: V.payee, mode: 'mutual', noteId: Number(C.note_id),
    sponsored: { feeCapWei: C.fee_cap_wei, maxCostWei: C.max_cost }, ...extra
});

// An operation of this account whose call data and fields are changed, signed
// by `key` over the hash this module computes (validated against the vector).
async function signed(changes = {}, { key = OWNER_KEY } = {}) {
    const op = { ...vectorOperation(), ...changes, signature: '0x' };
    const hash = sponsoredOperationHash(op, V.entry_point, V.chain_id);
    op.signature = await new Wallet(key).signMessage(getBytes(hash));
    return op;
}

const withdrawData = inner => {
    const body = inner.replace(/^0x/, '');
    const padded = Math.ceil(body.length / 64) * 64;
    return `0x0968f264${word(32)}${word(body.length / 2)}${body.padEnd(padded, '0')}`;
};
const vaultWords = () => C.vault_calldata.slice(10).match(/.{64}/g);
const vaultCall = (selector, words) => `0x${selector}${words.join('')}`;
// The vector's mutual close, rewritten as an escape (kind 0, a successor
// nullifier, a concession): the layout the profile's escape exit names.
function escapeCall({ conceded = 0n, kind = 0n, next = 0x2bn } = {}) {
    const words = vaultWords();
    words[12] = word(kind);
    words[13] = word(next);
    words[14] = word(conceded);
    return vaultCall('a38d62aa', words);
}

const refusal = (fn, code) => assert.throws(fn, error => error instanceof SponsoredOperationError && (code === undefined || error.code === code),
    `refused${code ? ` as ${code}` : ''}`);

// ---------------------------------------------------------------------------
// Against Foundry
// ---------------------------------------------------------------------------

test('the transit account, the initCode and the operation hash equal the Foundry vectors', () => {
    assert.equal(deriveTransitAccount({ pins, vault: V.vault, owner: V.owner, payee: V.payee }), low(V.transit_account));
    assert.equal(low(C.sender), low(V.transit_account));
    assert.equal(expectedInitCode({ pins, owner: V.owner, payee: V.payee, selector: profile.sponsored.createAccount }), low(C.init_code));
    assert.equal(sponsoredOperationHash(vectorOperation(), V.entry_point, V.chain_id), C.user_op_hash);
    // The signature in the vector recovers the owner over that hash.
    assert.equal(low(new Wallet(OWNER_KEY).address), low(V.owner));
});

test('the vector\'s signed close is the only thing accepted for its withdrawal, and says what it is', () => {
    const verdict = judgeSponsoredOperation(vectorOperation(), authorization(), context());
    assert.equal(verdict.kind, 'withdrawal');
    assert.equal(verdict.mode, 'mutual');
    assert.equal(verdict.noteId, 0);
    assert.equal(verdict.hash, C.user_op_hash);
    assert.equal(verdict.transitAccount, low(V.transit_account));
    assert.equal(verdict.payee, low(V.payee));
    assert.equal(verdict.owner, low(V.owner));
    assert.equal(verdict.maxCostWei, BigInt(C.max_cost));
    assert.equal(verdict.feeCapWei, BigInt(C.fee_cap_wei));
    assert.equal(verdict.conceded, null);
});

test('a wrong protocol, pin set or action is refused before the operation is read', () => {
    const op = vectorOperation();
    refusal(() => judgeSponsoredOperation(op, authorization(), context({ profile: noteBoundV1.callProfile })), 'pins');
    refusal(() => judgeSponsoredOperation(op, authorization(), context({ pins: null })), 'pins');
    refusal(() => judgeSponsoredOperation(op, null, context()), 'authorization');
    // An action with no sponsored confirmation never lets an operation out.
    const plain = authorization();
    delete plain.sponsored;
    refusal(() => judgeSponsoredOperation(op, plain, context()), 'authorization');
    refusal(() => judgeSponsoredOperation(op, authorization({ kind: 'deposit' }), context()), 'authorization');
});

// ---------------------------------------------------------------------------
// What an operation can get wrong
// ---------------------------------------------------------------------------

test('another EntryPoint, paymaster, payee, owner or factory is refused', async () => {
    const op = vectorOperation();
    refusal(() => judgeSponsoredOperation(op, authorization(), context({ entryPoint: `0x${'ab'.repeat(20)}` })), 'entry_point');
    refusal(() => judgeSponsoredOperation({ ...op, paymaster: `0x${'cd'.repeat(20)}` }, authorization(), context()), 'paymaster');
    // The payee the person confirmed is part of the account's address: a call
    // that pays another address is another account.
    refusal(() => judgeSponsoredOperation(op, authorization({ destination: `0x${'ee'.repeat(20)}` }), context()), 'sender');
    refusal(() => judgeSponsoredOperation(op, authorization(), context({ owner: `0x${'ef'.repeat(20)}` })), 'sender');
    // An initCode that creates the account with another owner or payee.
    const forged = await signed({ factoryData: `0x${op.factoryData.slice(2).replace(V.owner.slice(2).toLowerCase(), 'ab'.repeat(20))}` });
    refusal(() => judgeSponsoredOperation(forged, authorization(), context()), 'init_code');
    const otherFactory = await signed({ factory: `0x${'12'.repeat(20)}` });
    refusal(() => judgeSponsoredOperation(otherFactory, authorization(), context()), 'init_code');
});

test('a fee above the one shown, a cost above the policy and a fee above the ceilings are refused', async () => {
    const op = vectorOperation();
    // The paymaster data is the fee cap the person accepted.
    const dearer = await signed({ paymasterData: `0x${(BigInt(C.fee_cap_wei) + 1n).toString(16).padStart(24, '0')}` });
    refusal(() => judgeSponsoredOperation(dearer, authorization(), context()), 'fee_cap');
    // No cap was named: the pinned flat fee is the limit.
    const noCap = authorization();
    delete noCap.sponsored.feeCapWei;
    assert.equal(judgeSponsoredOperation(op, noCap, context()).kind, 'withdrawal');
    refusal(() => judgeSponsoredOperation(dearer, noCap, context()), 'fee_cap');
    const tooShort = await signed({ paymasterData: '0x00' });
    refusal(() => judgeSponsoredOperation(tooShort, authorization(), context()), 'paymaster_data');
    // The prefund is every gas limit times maxFeePerGas.
    const costly = await signed({ maxFeePerGas: hex(BigInt(V.policy.max_fee_ceiling)), callGasLimit: hex(2_000_000_000n) });
    refusal(() => judgeSponsoredOperation(costly, authorization(), context()), 'max_cost');
    const withinPolicyAboveShown = await signed({ callGasLimit: hex(BigInt(C.call_gas_limit) + 100_000n) });
    refusal(() => judgeSponsoredOperation(withinPolicyAboveShown, authorization(), context()), 'max_cost');
    const above = await signed({ maxFeePerGas: hex(BigInt(V.policy.max_fee_ceiling) + 1n) });
    refusal(() => judgeSponsoredOperation(above, authorization({ sponsored: { feeCapWei: C.fee_cap_wei } }), context()), 'fee_ceiling');
    const tip = await signed({ maxPriorityFeePerGas: hex(BigInt(V.policy.priority_fee_ceiling) + 1n) });
    refusal(() => judgeSponsoredOperation(tip, authorization({ sponsored: { feeCapWei: C.fee_cap_wei } }), context()), 'fee_ceiling');
    const inverted = await signed({ maxPriorityFeePerGas: hex(BigInt(C.max_fee_per_gas) + 1n) });
    refusal(() => judgeSponsoredOperation(inverted, authorization({ sponsored: { feeCapWei: C.fee_cap_wei } }), context()), 'fee_ceiling');
});

test('the call must be account.withdraw of a vault exit for this note, to the transit account, within what was confirmed', async () => {
    // Not withdraw(bytes), and not canonically encoded.
    refusal(() => judgeSponsoredOperation({ ...vectorOperation(), callData: `0x12345678${C.call_data.slice(10)}` }, authorization(), context()), 'call');
    refusal(() => judgeSponsoredOperation({ ...vectorOperation(), callData: `${C.call_data}00` }, authorization(), context()), 'call');
    const shifted = `0x0968f264${word(64)}${C.call_data.slice(10 + 64)}`;
    refusal(() => judgeSponsoredOperation({ ...vectorOperation(), callData: shifted }, authorization(), context()), 'call');

    // One word of the vault call changed, signed properly, so the content
    // rule is what refuses: another chain, vault, note, destination, kind.
    const words = vaultWords();
    const closeWith = async (index, value) => {
        const changed = [...words];
        changed[index] = typeof value === 'string' ? value : word(value);
        return signed({ callData: withdrawData(vaultCall('72cd2e44', changed)) });
    };
    const expectRefused = async (index, value, code, auth = authorization()) => {
        const op = await closeWith(index, value);
        refusal(() => judgeSponsoredOperation(op, auth, context()), code);
    };
    await expectRefused(1, V.chain_id + 1, 'call');
    await expectRefused(2, '0'.repeat(24) + 'ab'.repeat(20), 'call');
    await expectRefused(8, 5, 'note');
    await expectRefused(10, '0'.repeat(24) + low(V.payee).slice(2), 'call'); // the payee itself, not its transit account
    await expectRefused(12, 0, 'call'); // a close that claims the escape's kind
    await expectRefused(13, 7, 'call'); // a close that names a successor
    await expectRefused(14, 9, 'call'); // a close that concedes
    // The balance was confirmed in the chat, not here: only the note, mode and
    // concession are bound by the authorization.
    assert.equal(judgeSponsoredOperation(await closeWith(9, 123_456), authorization(), context()).kind, 'withdrawal');
    // A note the person did not choose.
    const op = vectorOperation();
    refusal(() => judgeSponsoredOperation(op, authorization({ noteId: 3 }), context()), 'note');
    // A mutual close was asked for and an escape was signed: only the SDK's
    // own conversion is allowed (below); an escape asked for and a close
    // signed never is.
    refusal(() => judgeSponsoredOperation(op, authorization({ mode: 'escape' }), context()), 'mode');
});


test('an escape is accepted for what the person was shown: exact, capped, or nothing; a converted close likewise', async () => {
    const escape = amount => signed({ callData: withdrawData(escapeCall({ conceded: amount })) });
    const none = await escape(0n);
    const some = await escape(100n);
    const asked = (extra = {}) => authorization({ mode: 'escape', ...extra });
    // Nothing was confirmed: nothing may be given up.
    assert.equal(judgeSponsoredOperation(none, asked(), context()).conceded, 0n);
    refusal(() => judgeSponsoredOperation(some, asked(), context()), 'concession');
    // The exact amount shown, and a cap.
    assert.equal(judgeSponsoredOperation(some, asked({ conceded: '100' }), context()).conceded, 100n);
    refusal(() => judgeSponsoredOperation(some, asked({ conceded: '99' }), context()), 'concession');
    refusal(() => judgeSponsoredOperation(some, asked({ conceded: '101' }), context()), 'concession');
    assert.equal(judgeSponsoredOperation(some, asked({ concededMax: '150' }), context()).conceded, 100n);
    refusal(() => judgeSponsoredOperation(some, asked({ concededMax: '99' }), context()), 'concession');
    // Both: both must hold.
    refusal(() => judgeSponsoredOperation(some, asked({ conceded: '100', concededMax: '50' }), context()), 'concession');
    // The refusal says what happened in words a person can act on, and no bytes.
    try {
        judgeSponsoredOperation(some, asked(), context());
        assert.fail('expected a refusal');
    } catch (error) {
        assert.match(error.message, /give up more of your balance than you were shown, so nothing was sent/);
        assert.doesNotMatch(error.message, /0x[0-9a-f]{8}/i);
    }
    // A mutual close the SDK turned into an escape is allowed, a close that
    // asked for an escape is not (mode check above), and an escape of another
    // kind word, a missing successor or a non-escape selector never is.
    assert.equal(judgeSponsoredOperation(none, authorization({ mode: 'mutual' }), context()).mode, 'escape');
    const noSuccessor = await signed({ callData: withdrawData(escapeCall({ next: 0n })) });
    refusal(() => judgeSponsoredOperation(noSuccessor, asked(), context()), 'call');
    const successorIsOwn = await signed({ callData: withdrawData(escapeCall({ next: BigInt(C.nullifier) })) });
    refusal(() => judgeSponsoredOperation(successorIsOwn, asked(), context()), 'call');
    const wrongKind = await signed({ callData: withdrawData(escapeCall({ kind: 1n })) });
    refusal(() => judgeSponsoredOperation(wrongKind, asked(), context()), 'call');
});

test('concessionConfirmed is the transaction signer\'s rule', () => {
    assert.equal(concessionConfirmed(0n, {}), true);
    assert.equal(concessionConfirmed(1n, {}), false);
    assert.equal(concessionConfirmed(5n, { conceded: '5' }), true);
    assert.equal(concessionConfirmed(5n, { concededMax: '5' }), true);
    assert.equal(concessionConfirmed(6n, { concededMax: '5' }), false);
    assert.equal(concessionConfirmed(5n, { conceded: '5', concededMax: '4' }), false);
    assert.throws(() => concessionConfirmed(0n, { conceded: 'many' }), SponsoredOperationError);
});

test('a finalization names the confirmed note and nothing else; a collection carries no vault call', async () => {
    const finalizing = (extra = {}) => ({ kind: 'finalization', destination: V.payee, noteId: 7,
        sponsored: { feeCapWei: C.fee_cap_wei, maxCostWei: C.max_cost }, ...extra });
    const finalizeOf = note => signed({ callData: withdrawData(`0xff8f5585${word(note)}`) });
    const verdict = judgeSponsoredOperation(await finalizeOf(7), finalizing(), context());
    assert.equal(verdict.kind, 'finalization');
    assert.equal(verdict.mode, 'finalize');
    assert.equal(verdict.noteId, 7);
    // Another note than the confirmed one, no note confirmed, an extra word,
    // a close offered as a finalization, a finalization offered as a close.
    const other = await finalizeOf(8);
    refusal(() => judgeSponsoredOperation(other, finalizing(), context()), 'note');
    refusal(() => judgeSponsoredOperation(other, finalizing({ noteId: null }), context()), 'note');
    const padded = await signed({ callData: withdrawData(`0xff8f5585${word(7)}${word(0)}`) });
    refusal(() => judgeSponsoredOperation(padded, finalizing(), context()), 'call');
    refusal(() => judgeSponsoredOperation(vectorOperation(), finalizing(), context()), 'call');
    refusal(() => judgeSponsoredOperation(other, authorization(), context()), 'call');

    // A collection is the account's withdraw of nothing, from the account the
    // record names.
    const collecting = (extra = {}) => ({ kind: 'collection', destination: V.payee,
        sponsored: { feeCapWei: C.fee_cap_wei, maxCostWei: C.max_cost, transitAccount: V.transit_account }, ...extra });
    const collection = await signed({ callData: withdrawData('0x') });
    const collected = judgeSponsoredOperation(collection, collecting(), context());
    assert.equal(collected.kind, 'collection');
    assert.equal(collected.mode, 'collect');
    assert.equal(collected.noteId, null);
    assert.equal(collected.transitAccount, low(V.transit_account));
    // Another account than the record's, or any call at all.
    const otherAccount = collecting();
    otherAccount.sponsored.transitAccount = `0x${'31'.repeat(20)}`;
    refusal(() => judgeSponsoredOperation(collection, otherAccount, context()), 'sender');
    refusal(() => judgeSponsoredOperation(other, collecting(), context()), 'call');
});

test('the signature must be this address\'s over exactly these bytes', async () => {
    const op = vectorOperation();
    // Not signed, signed by someone else, signed for other bytes.
    refusal(() => judgeSponsoredOperation({ ...op, signature: '0x' }, authorization(), context()), 'signature');
    const stranger = await signed({}, { key: `0x${'22'.repeat(32)}` });
    refusal(() => judgeSponsoredOperation(stranger, authorization(), context()), 'signature');
    const afterTheFact = { ...op, callGasLimit: hex(BigInt(C.call_gas_limit) - 1n) };
    refusal(() => judgeSponsoredOperation(afterTheFact, authorization(), context()), 'signature');
    // Garbage in any field is a refusal, never a throw of another kind.
    for (const broken of [{ nonce: 'seven' }, { sender: '0x12' }, { callData: '0xzz' }, { paymasterData: 5 },
        { callGasLimit: `0x${'f'.repeat(33)}` }, { signature: 12 }]) {
        refusal(() => judgeSponsoredOperation({ ...op, ...broken }, authorization(), context()));
    }
    refusal(() => judgeSponsoredOperation(null, authorization(), context()), 'shape');
    refusal(() => judgeSponsoredOperation([], authorization(), context()), 'shape');
});

test('the pins are read strictly: a profile that pins nothing, or pins it badly, signs nothing', () => {
    assert.equal(readSponsoredPins({}), null);
    assert.equal(readSponsoredPins({ gasless: null }), null);
    assert.equal(readSponsoredPins({ deployment_status: 'not_deployed', gasless: trusted().gasless }), null);
    assert.equal(readSponsoredPins({ gasless: { ...trusted().gasless, deployment_status: 'pending' } }), null);
    assert.equal(pins.entryPoint, low(V.entry_point));
    assert.equal(pins.bundlerUrl, 'https://bundler.example/rpc');
    assert.equal(pins.maxSponsoredCostWei, BigInt(V.policy.max_sponsored_cost));
    assert.throws(() => readSponsoredPins({ gasless: { ...trusted().gasless, entry_point_address: '0x12' } }), SponsoredOperationError);
    assert.throws(() => readSponsoredPins({ gasless: { ...trusted().gasless, account_creation_code_keccak256: `0x${'00'.repeat(32)}` } }),
        SponsoredOperationError);
    assert.throws(() => readSponsoredPins({ gasless: { ...trusted().gasless, account_creation_code: '0xzz' } }), SponsoredOperationError);
});


test('leaf-bound sponsored calls use the packed note identity and reject overflow or another note', async () => {
    const leafProfile = leafBoundV2.callProfile;
    const packed = (7n << 192n) | (1000n << 64n) | 1800000010n;
    for (const mode of ['mutual', 'escape']) {
        const words = vaultWords();
        words[8] = word(packed);
        words[12] = word(mode === 'mutual' ? 1n : 0n);
        words[13] = word(mode === 'mutual' ? 0n : 0x2bn);
        const selector = leafProfile.exits.find(exit => exit.mode === mode).selector;
        const auth = authorization({ noteId: 7, mode, conceded: '0' });
        const make = fields => signed({ callData: withdrawData(vaultCall(selector, fields)) });
        const op = await make(words);
        assert.equal(judgeSponsoredOperation(op, auth, context({ profile: leafProfile })).noteId, 7);
        refusal(() => judgeSponsoredOperation(op, { ...auth, noteId: 8 }, context({ profile: leafProfile })), 'note');
        for (const bad of [(8n << 192n) | 1800000010n, packed | (1n << 224n), 7n]) {
            const altered = [...words]; altered[8] = word(bad);
            const invalid = await make(altered);
            refusal(() => judgeSponsoredOperation(invalid, auth, context({ profile: leafProfile })), 'note');
        }
        refusal(() => judgeSponsoredOperation(op, auth, context()), 'call');
    }
});
