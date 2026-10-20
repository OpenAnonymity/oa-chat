// What this host will let leave the browser as a sponsored withdrawal.
//
// A sponsored (gasless) withdrawal pays its network fee out of the payout
// through an ERC-4337 operation: the vault call runs inside a user operation
// sent from a transit account S, the connected account signs the operation's
// hash with personal_sign, and a bundler includes it. The browser-held key of
// the Send Ethereum method signs without a prompt, so this module judges the
// operation itself, independently of the SDK that built it (nothing here
// imports the SDK, and every encoding is computed again with ethers).
//
// The signer sees only a 32-byte hash when it is asked to sign, so it cannot
// judge the operation then. It judges it at the one place the signature can
// leave the browser, `eth_sendUserOperation`, against what the person
// confirmed (the authorization of the running action). Whatever is signed and
// not sent is inert: the signature is only a signature of an operation hash.
//
// An operation is accepted only when ALL of these hold:
//
//   - the EntryPoint and the paymaster are the pinned ones, and the operation
//     carries no paymaster data beyond the 12-byte fee cap the person
//     accepted (at most `feeCapWei`, else the pinned flat fee);
//   - its sender is the transit account CREATE2-derived from the pinned
//     factory and creation code, the pinned vault, paymaster and EntryPoint,
//     THIS browser address as owner and the payee the person confirmed;
//   - its initCode is empty or exactly factory.createAccount(owner, payee);
//   - its call data is account.withdraw(bytes) and the inner bytes are:
//       close / escape  a vault exit whose chain, vault, note, kind and proof
//                       words are those of the profile's call profile, whose
//                       destination word is the transit account, whose note
//                       is the confirmed one and whose concession is within
//                       what was confirmed (the same rules as a transaction);
//       finalize        the vault's finalization of the confirmed note;
//       collect         nothing (a forward of the transit account's balance);
//   - the prefund (every gas limit times maxFeePerGas) and both fee fields are
//     within the paymaster's pinned policy and fee ceilings;
//   - its signature recovers, over the EIP-191 digest of the hash computed
//     here, to this browser address.
//
// Pure: no DOM, no storage, no clock, no network.
import { AbiCoder, getAddress, getCreate2Address, getBytes, keccak256, verifyMessage } from 'ethers';
import { withdrawalCallNoteId } from '../versioning/callFields.mjs';
import {
    SPONSORED_CONCESSION_REFUSAL, SPONSORED_COST_REFUSAL, SPONSORED_COST_SHOWN_REFUSAL, SPONSORED_FEE_REFUSAL,
    SPONSORED_REFUSAL_MESSAGE
} from '../versioning/sponsored.mjs';

export { SPONSORED_REFUSAL_MESSAGE };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^0x[0-9a-fA-F]+$/;
const UINT128_LIMIT = 1n << 128n;
const UINT256_LIMIT = 1n << 256n;
const MAX_CALL_DATA_BYTES = 8192;
const MAX_CREATION_CODE_BYTES = 24_576;
const coder = AbiCoder.defaultAbiCoder();

/** Every refusal of this module carries a code; none carries operation bytes. */
export class SponsoredOperationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SponsoredOperationError';
        this.code = code;
    }
}

function refuse(code, message = SPONSORED_REFUSAL_MESSAGE) {
    throw new SponsoredOperationError(code, message);
}

const lower = value => String(value ?? '').toLowerCase();
const strip = value => lower(value).replace(/^0x/, '');
const word = value => value.toString(16).padStart(64, '0');
const sameAddress = (left, right) => ADDRESS.test(left || '') && ADDRESS.test(right || '') && lower(left) === lower(right);

function address(value, label) {
    if (typeof value !== 'string' || !ADDRESS.test(value)) refuse('address', `${label} is not an address.`);
    try {
        return getAddress(value).toLowerCase();
    } catch {
        return refuse('address', `${label} is not an address.`);
    }
}

function quantity(value, label, limit = UINT256_LIMIT) {
    if (typeof value === 'bigint' && value >= 0n && value < limit) return value;
    if (typeof value !== 'string' || !QUANTITY.test(value)) refuse('quantity', `${label} is not a quantity.`);
    const parsed = BigInt(value);
    if (parsed >= limit) refuse('quantity', `${label} is out of range.`);
    return parsed;
}

function decimal(value, label) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === 'string' && /^[0-9]{1,78}$/.test(value)) return BigInt(value);
    return refuse('quantity', `${label} is not an amount.`);
}

function hexBytes(value, label, maxBytes) {
    if (typeof value !== 'string' || !HEX.test(value)) refuse('bytes', `${label} is not hex bytes.`);
    if ((value.length - 2) / 2 > maxBytes) refuse('bytes', `${label} is too long.`);
    return lower(value);
}

// ---------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------

/**
 * The gasless contracts a profile pins, parsed by this host (the SDK parses
 * the same object for itself), or null when the profile pins none. A pinned
 * object that is malformed throws: a host that cannot read it must not sign
 * for it.
 */
export function readSponsoredPins(trusted) {
    const gasless = trusted?.gasless;
    if (gasless == null || typeof gasless !== 'object') return null;
    if (trusted?.deployment_status === 'not_deployed'
        || (gasless.deployment_status != null && gasless.deployment_status !== 'deployed')) return null;
    const creationCode = hexBytes(gasless.account_creation_code, 'account_creation_code', MAX_CREATION_CODE_BYTES);
    if (creationCode.length < 4) refuse('pins', 'The account creation code is empty.');
    if (lower(gasless.account_creation_code_keccak256) !== keccak256(creationCode)) {
        refuse('pins', 'The account creation code does not hash to its pinned keccak256.');
    }
    const policy = gasless.policy || {};
    const ceilings = gasless.fee_ceilings || {};
    return Object.freeze({
        entryPoint: address(gasless.entry_point_address, 'entry_point_address'),
        paymaster: address(gasless.withdrawal_paymaster_address, 'withdrawal_paymaster_address'),
        factory: address(gasless.withdrawal_account_factory_address, 'withdrawal_account_factory_address'),
        creationCode,
        bundlerUrl: typeof gasless.bundler_url === 'string' && gasless.bundler_url ? gasless.bundler_url : null,
        maxSponsoredCostWei: decimal(policy.max_sponsored_cost_wei ?? 0, 'policy.max_sponsored_cost_wei'),
        flatFeeWei: decimal(policy.flat_fee_wei ?? 0, 'policy.flat_fee_wei'),
        maxFeeCeilingWei: decimal(ceilings.max_fee_wei ?? 0, 'fee_ceilings.max_fee_wei'),
        priorityFeeCeilingWei: decimal(ceilings.priority_fee_wei ?? 0, 'fee_ceilings.priority_fee_wei')
    });
}

// ---------------------------------------------------------------------------
// The encodings, computed again here
// ---------------------------------------------------------------------------

/**
 * The transit account S: CREATE2 from the factory, salt zero, of the pinned
 * creation code followed by abi.encode(entryPoint, vault, paymaster, owner,
 * payee).
 */
export function deriveTransitAccount({ pins, vault, owner, payee }) {
    const constructorArguments = [pins.entryPoint, address(vault, 'vault'), pins.paymaster,
        address(owner, 'owner'), address(payee, 'payee')].map(value => word(BigInt(value))).join('');
    const initCodeHash = keccak256(`${pins.creationCode}${constructorArguments}`);
    return getCreate2Address(getAddress(pins.factory), `0x${'0'.repeat(64)}`, initCodeHash).toLowerCase();
}

/**
 * The operation's initCode on first use: factory ‖ createAccount(owner,
 * payee). `selector` is the call profile's `sponsored.createAccount`.
 */
export function expectedInitCode({ pins, owner, payee, selector }) {
    if (!/^[0-9a-f]{8}$/.test(selector || '')) refuse('profile', 'This protocol has no sponsored withdrawals.');
    return `0x${strip(pins.factory)}${selector}${word(BigInt(address(owner, 'owner')))}${word(BigInt(address(payee, 'payee')))}`;
}

const u128 = (value, label) => quantity(value, label, UINT128_LIMIT).toString(16).padStart(32, '0');

// The pieces of the unpacked JSON operation (the shape eth_sendUserOperation
// takes), validated, with the packed fields the hash is computed over.
function unpack(op) {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) refuse('shape', 'The operation is not an object.');
    const hasFactory = op.factory != null && op.factory !== '0x';
    const factory = hasFactory ? address(op.factory, 'factory') : null;
    const factoryData = hasFactory ? hexBytes(op.factoryData ?? '0x', 'factoryData', 1024) : null;
    const initCode = hasFactory ? `0x${strip(factory)}${strip(factoryData)}` : '0x';
    const callData = hexBytes(op.callData, 'callData', MAX_CALL_DATA_BYTES);
    const paymasterData = hexBytes(op.paymasterData ?? '0x', 'paymasterData', 64);
    const fields = {
        sender: address(op.sender, 'sender'),
        nonce: quantity(op.nonce, 'nonce'),
        initCode,
        callData,
        callGasLimit: quantity(op.callGasLimit, 'callGasLimit', UINT128_LIMIT),
        verificationGasLimit: quantity(op.verificationGasLimit, 'verificationGasLimit', UINT128_LIMIT),
        preVerificationGas: quantity(op.preVerificationGas, 'preVerificationGas'),
        maxFeePerGas: quantity(op.maxFeePerGas, 'maxFeePerGas', UINT128_LIMIT),
        maxPriorityFeePerGas: quantity(op.maxPriorityFeePerGas, 'maxPriorityFeePerGas', UINT128_LIMIT),
        paymaster: address(op.paymaster, 'paymaster'),
        paymasterVerificationGasLimit: quantity(op.paymasterVerificationGasLimit, 'paymasterVerificationGasLimit', UINT128_LIMIT),
        paymasterPostOpGasLimit: quantity(op.paymasterPostOpGasLimit, 'paymasterPostOpGasLimit', UINT128_LIMIT),
        paymasterData,
        signature: hexBytes(op.signature ?? '0x', 'signature', 4096)
    };
    return fields;
}

/**
 * UserOperationLib.hash of EntryPoint v0.7.0: keccak256(abi.encode(
 * keccak256(abi.encode(sender, nonce, keccak(initCode), keccak(callData),
 * accountGasLimits, preVerificationGas, gasFees, keccak(paymasterAndData))),
 * entryPoint, chainId)).
 */
export function sponsoredOperationHash(op, entryPoint, chainId) {
    return hashOf(unpack(op), entryPoint, chainId);
}

function hashOf(fields, entryPoint, chainId) {
    const accountGasLimits = `0x${u128(fields.verificationGasLimit, 'verificationGasLimit')}${u128(fields.callGasLimit, 'callGasLimit')}`;
    const gasFees = `0x${u128(fields.maxPriorityFeePerGas, 'maxPriorityFeePerGas')}${u128(fields.maxFeePerGas, 'maxFeePerGas')}`;
    const paymasterAndData = `0x${strip(fields.paymaster)}${u128(fields.paymasterVerificationGasLimit, 'paymasterVerificationGasLimit')}`
        + `${u128(fields.paymasterPostOpGasLimit, 'paymasterPostOpGasLimit')}${strip(fields.paymasterData)}`;
    const inner = keccak256(coder.encode(
        ['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
        [fields.sender, fields.nonce, keccak256(fields.initCode), keccak256(fields.callData), accountGasLimits,
            fields.preVerificationGas, gasFees, keccak256(paymasterAndData)]
    ));
    return keccak256(coder.encode(['bytes32', 'address', 'uint256'], [inner, address(entryPoint, 'EntryPoint'), BigInt(chainId)]));
}

// account.withdraw(bytes): selector, offset 0x20, length n, n bytes padded with
// zeros to a word boundary; nothing else. Returns the inner bytes ('0x' when empty).
function decodeTransitWithdraw(callData, selector) {
    const body = strip(callData);
    if (!/^[0-9a-f]{8}$/.test(selector || '') || body.length < 8 + 128 || body.slice(0, 8) !== selector) refuse('call', 'The operation does not call the transit account’s withdraw.');
    if (BigInt(`0x${body.slice(8, 72)}`) !== 32n) refuse('call', 'The operation’s call data is not canonically encoded.');
    const length = BigInt(`0x${body.slice(72, 136)}`);
    if (length > BigInt(MAX_CALL_DATA_BYTES)) refuse('call', 'The operation’s call data is too long.');
    const bytes = Number(length);
    const padded = Math.ceil(bytes / 32) * 32;
    if (body.length !== 136 + padded * 2) refuse('call', 'The operation’s call data is not canonically encoded.');
    const data = body.slice(136, 136 + bytes * 2);
    if (/[^0]/.test(body.slice(136 + bytes * 2))) refuse('call', 'The operation’s call data is not canonically encoded.');
    return `0x${data}`;
}

// ---------------------------------------------------------------------------
// The concession a call carries, as confirmed (the same rule as a transaction)
// ---------------------------------------------------------------------------

/**
 * Whether `conceded` (an escape's concession word, gwei) is within what the
 * person confirmed. The authorization carries either or both of
 *   conceded      the exact amount
 *   concededMax   a cap
 * With both, both must hold. With neither the escape concedes nothing.
 */
export function concessionConfirmed(conceded, authorization) {
    const exact = authorization.conceded == null ? null : decimal(authorization.conceded, 'conceded amount');
    const cap = authorization.concededMax == null ? null : decimal(authorization.concededMax, 'conceded cap');
    if (exact === null && cap === null) return conceded === 0n;
    return (exact === null || conceded === exact) && (cap === null || conceded <= cap);
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * Judge one sponsored operation about to be sent. Returns what it is
 * ({ kind, hash, transitAccount, noteId, mode, payee, maxCostWei, feeCapWei,
 * conceded }) and throws a SponsoredOperationError for anything else.
 *
 * `context`:
 *   pins         readSponsoredPins(...) of the loaded profile
 *   vault        the vault address
 *   chainId      the vault's chain
 *   owner        this browser address (the transit account's owner and signer)
 *   profile      the call profile of the loaded protocol family
 *   entryPoint   the EntryPoint the bundler call names
 * `authorization` is the running action's (kind 'withdrawal', 'finalization'
 * or 'collection'); `authorization.destination` is the payee and
 * `authorization.sponsored` carries `feeCapWei` and, optionally,
 * `maxCostWei`.
 */
export function judgeSponsoredOperation(rawOperation, authorization, context) {
    const { pins, vault, chainId, owner, profile, entryPoint } = context;
    if (!pins || !profile?.sponsored) return refuse('pins', 'This version has no sponsored withdrawals.');
    if (!authorization || typeof authorization !== 'object' || !authorization.sponsored
        || typeof authorization.sponsored !== 'object') return refuse('authorization');
    if (!sameAddress(entryPoint, pins.entryPoint)) refuse('entry_point');
    const payee = address(authorization.destination, 'payee');
    const own = address(owner, 'owner');
    const op = unpack(rawOperation);

    // The paymaster and the fee the person accepted.
    if (!sameAddress(op.paymaster, pins.paymaster)) refuse('paymaster');
    if (strip(op.paymasterData).length !== 24) refuse('paymaster_data');
    const feeCap = BigInt(`0x${strip(op.paymasterData)}`);
    const accepted = authorization.sponsored.feeCapWei == null ? pins.flatFeeWei : decimal(authorization.sponsored.feeCapWei, 'feeCapWei');
    if (feeCap > accepted) refuse('fee_cap', SPONSORED_FEE_REFUSAL);

    // The transit account, and how it comes to exist.
    const transitAccount = deriveTransitAccount({ pins, vault, owner: own, payee });
    if (!sameAddress(op.sender, transitAccount)) refuse('sender');
    if (op.initCode !== '0x'
        && op.initCode !== expectedInitCode({ pins, owner: own, payee, selector: profile.sponsored.createAccount })) refuse('init_code');

    // What it calls.
    const inner = decodeTransitWithdraw(op.callData, profile.sponsored.transitWithdraw);
    const kind = authorization.kind;
    let noteId = null;
    let mode = null;
    let conceded = null;
    const normalized = strip(inner);
    const selector = normalized.slice(0, 8);
    const words = normalized.slice(8).match(/.{1,64}/g) || [];
    const wordUint = index => {
        if (!/^[0-9a-f]{64}$/.test(words[index] || '')) refuse('call', 'The operation’s call is not a whole number of words.');
        return BigInt(`0x${words[index]}`);
    };
    const wordAddress = index => {
        if (!/^0{24}[a-f0-9]{40}$/.test(words[index] || '')) refuse('call', 'The operation’s call names an invalid address.');
        return `0x${words[index].slice(24)}`;
    };
    const exactWords = count => normalized.length === 8 + count * 64;
    if (kind === 'withdrawal') {
        const exit = (profile?.exits || []).find(entry => entry.selector === selector);
        const { fields } = profile || {};
        if (!exit || !fields || !exactWords(exit.words)) refuse('call');
        noteId = withdrawalCallNoteId(fields, wordUint);
        if (noteId === null) refuse('note');
        mode = exit.mode;
        if (wordUint(fields.chainId) !== BigInt(chainId) || !sameAddress(wordAddress(fields.vault), vault)
            || !sameAddress(wordAddress(fields.destination), transitAccount)
            || wordUint(exit.kind.word) !== exit.kind.value
            || wordUint(exit.bytesOffset.word) !== exit.bytesOffset.value
            || wordUint(exit.proofLength.word) !== exit.proofLength.value
            || exit.zeroWords.some(index => wordUint(index) !== 0n)
            || exit.nonZeroWords.some(index => wordUint(index) === 0n || wordUint(index) === wordUint(fields.nullifier))) refuse('call');
        if (authorization.noteId != null && decimal(authorization.noteId, 'note') !== noteId) refuse('note');
        // The mode the person chose is the mode sent, except that a requested
        // mutual close may have become an escape (never the other way).
        if (authorization.mode && authorization.mode !== mode
            && !(exit.concededWord !== null && authorization.mode === 'mutual' && mode === 'escape')) refuse('mode');
        if (exit.concededWord !== null) {
            conceded = wordUint(exit.concededWord);
            if (!concessionConfirmed(conceded, authorization)) refuse('concession', SPONSORED_CONCESSION_REFUSAL);
        }
    } else if (kind === 'finalization') {
        const finalize = profile?.finalize;
        if (!finalize || selector !== finalize.selector || !exactWords(finalize.words)) refuse('call');
        noteId = wordUint(finalize.noteIdWord);
        if (authorization.noteId == null || decimal(authorization.noteId, 'note') !== noteId) refuse('note');
        mode = 'finalize';
    } else if (kind === 'collection') {
        if (normalized !== '') refuse('call');
        const expected = authorization.sponsored.transitAccount;
        if (expected != null && !sameAddress(expected, transitAccount)) refuse('sender');
        mode = 'collect';
    } else {
        refuse('authorization');
    }

    // The money. Every gas limit times the fee cap is what the paymaster
    // reserves; it must stay within the policy it pinned and what was shown.
    const gas = op.callGasLimit + op.verificationGasLimit + op.preVerificationGas
        + op.paymasterVerificationGasLimit + op.paymasterPostOpGasLimit;
    const maxCostWei = gas * op.maxFeePerGas;
    if (pins.maxSponsoredCostWei > 0n && maxCostWei > pins.maxSponsoredCostWei) refuse('max_cost', SPONSORED_COST_REFUSAL);
    if (authorization.sponsored.maxCostWei != null && maxCostWei > decimal(authorization.sponsored.maxCostWei, 'maxCostWei')) {
        refuse('max_cost', SPONSORED_COST_SHOWN_REFUSAL);
    }
    if (pins.maxFeeCeilingWei > 0n && op.maxFeePerGas > pins.maxFeeCeilingWei) refuse('fee_ceiling');
    if (pins.priorityFeeCeilingWei > 0n && op.maxPriorityFeePerGas > pins.priorityFeeCeilingWei) refuse('fee_ceiling');
    if (op.maxPriorityFeePerGas > op.maxFeePerGas) refuse('fee_ceiling');

    // Signed by this browser address, over exactly these bytes.
    const hash = hashOf(op, pins.entryPoint, chainId);
    if (!/^0x[0-9a-f]{130}$/.test(op.signature)) refuse('signature', 'The operation is not signed.');
    let signer;
    try {
        signer = verifyMessage(getBytes(hash), op.signature).toLowerCase();
    } catch {
        return refuse('signature', 'The operation’s signature is not valid.');
    }
    if (signer !== own) refuse('signature', 'The operation was not signed by this payment address.');

    return { kind, hash, transitAccount, noteId: noteId === null ? null : Number(noteId), mode, payee, owner: own,
        maxCostWei, feeCapWei: feeCap, conceded };
}
