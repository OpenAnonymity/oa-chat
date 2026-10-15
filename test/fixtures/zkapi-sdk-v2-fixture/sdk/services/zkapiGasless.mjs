// FIXTURE: names of sdk/services/zkapiGasless.mjs (zkapi 0.2.0, ethereum/zkapi branch v0.2, 4b955d9).
// The sponsored (gasless, ERC-4337) withdrawal helpers. This host never asks for the
// sponsored path (fees: 'wallet' is the SDK's default), so nothing here is implemented:
// primitive constants carry their real values, every other name fails loudly.
import { unsupportedExports } from './fixtureSupport.js';

export const CANONICAL_ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
export const CANONICAL_SENDER_CREATOR = '0xEFC2c1444eBCC4Db75e7613d20C6a62fF67A167C';
export const ENTRY_POINT_V070_CODEHASH = '0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58';
export const FEE_BUMP_DENOMINATOR = 1000n;
export const FEE_BUMP_NUMERATOR = 1125n;
export const FEE_REPLACEMENT_MIN_PERCENT = 10n;
export const KIND = Object.freeze({ close: 1, escape: 2, finalize: 3, forward: 4 });
export const KIND_NAMES = Object.freeze(['close', 'escape', 'finalize', 'forward']);
export const MAX_ATTEMPTS = 3n;
export const PACKED_USER_OPERATION_TUPLE = '(address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)';
export const SENDER_CREATOR_V070_CODEHASH = '0x283c9d14378f5f4c4e24045b87d621d48443fa5b4af7dd7180a599b3756a7689';
export const UNECONOMIC_FRACTION_PERCENT = 25n;

// Functions, and the constants whose real value is an object built from other modules.
export const {
    BUNDLER_RPC_ERRORS, ENTRY_POINT_ERRORS, FORWARD_NONCE_KEY, GASLESS_MESSAGES, GASLESS_TIMING,
    GAS_POLICY_SCALARS, attemptsKey, availabilityVerdict, buildUserOperation, bumpFees,
    bundlerClient, bundlerUrl, chargeFor, checkEstimate, decodeAddressWord, decodeBool,
    decodeDepositInfo, decodeEntryPointRevert, decodeGasPolicy, decodePolicy, decodeQuote,
    decodeWord, dryRunError, eip191Digest, emittedUserOpHash, encodeAttempts, encodeBalanceOf,
    encodeCallCap, encodeChargeFor, encodeCredits, encodeEscapeNotePlusOne, encodeEscapeSponsored,
    encodeGetAddress, encodeGetDepositInfo, encodeGetNonce, encodeGetUserOpHash, encodeHandleOps,
    encodeKeyFor, encodeOwed, encodePackedUserOperation, encodeQuote, encodeStranded,
    encodeTransitAccount, gasFields, gaslessAmounts, gaslessError, gaslessPins,
    handleOpsCalldataBytes, journalValue, lim070PreVerificationGas, maxCostWei, nonceKeyFor,
    normalizeGasPolicy, packNonce, packUserOperation, parseAccountCreated, parseCollected,
    parseCreditClaimed, parseEscapeInitiationOwed, parsePayoutCredited, parseSettled,
    parseSponsorshipFailed, parseStranded, parseUserOperationEvent, parseUserOperationRevertReason,
    preVerificationGasFor, referencePreVerificationGas, sameGasPolicy, selectFees, settlementOf,
    toBigInt, transitAccountAddress, transitInitCode, unpackNonce, userOpHash,
    userOperationFromJson, userOperationJson, userOperationReceiptTransactionHash, weiString
} = unsupportedExports('gasless');
