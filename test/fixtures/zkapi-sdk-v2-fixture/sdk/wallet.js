// FIXTURE: stand-in for sdk/wallet.js (zkapi 0.2.0, branch v0.2, 4b955d9, vault revision 3).
//
// The real module is the vault ABI codec. This one exports the same names:
// the constants carry their real values, abiWord, addressWord and callData are
// the real three-line helpers, ABI lists only the selectors the host's call
// profile table pins (deposit, mutualClose, initiateEscapeWithdrawal,
// finalizeEscapeWithdrawal, claimEscapePayout), and every encoder or decoder
// fails loudly (fixture_not_implemented). A test that needs real calldata
// must supply its own layout fixture, as the host's call-profile tests do.
//
// Not exported, as in the real module: parseTokenAmount and formatTokenAmount.
// This SDK generation dropped them; the host owns them.
import { unsupportedExports } from './services/fixtureSupport.js';

const WITHDRAWAL_TUPLE = '(uint16,uint64,address,uint256,uint256,uint256,uint256,uint256,uint32,uint128,address,uint256,uint8,uint256,uint128,uint64)';
const REQUEST_TUPLE = '(uint16,uint64,address,uint256,uint256,uint256,uint64,uint128,uint256,uint256,uint256,uint256)';

const ABI = Object.freeze({
    deposit: 'c588341c',
    mutualClose: '72cd2e44',
    initiateEscapeWithdrawal: 'a38d62aa',
    finalizeEscapeWithdrawal: 'ff8f5585',
    claimEscapePayout: '88c10aee',
});

// Withdrawal proof kinds (public input 12).
const WITHDRAWAL_KIND = Object.freeze({ escape: 0, mutual: 1, ownership: 2 });
// Calldata of initiateEscapeWithdrawal and mutualClose: selector, 16 tuple
// words, the bytes offset (17 * 32), the length (256) and 8 proof words.
const WITHDRAWAL_CALLDATA_BYTES = 4 + (16 + 1 + 1 + 8) * 32;
// Execution gas the hardened vault forwards when it pushes an escape payout.
const ESCAPE_PAYOUT_GAS = 100_000;

function abiWord(value) {
    const hex = typeof value === 'string' ? value.replace(/^0x/, '') : BigInt(value).toString(16);
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length > 64) {
        throw new Error('Value cannot be encoded for the vault contract.');
    }
    return hex.padStart(64, '0');
}

function addressWord(address) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) {
        throw new Error('MetaMask returned an invalid account address.');
    }
    return abiWord(address);
}

function callData(selector, words) {
    return `0x${selector}${words.join('')}`;
}

const {
    decodeChallengeEscapeWithdrawal, decodePendingConcessions, decodePendingWithdrawals,
    decodeRaiseEscapeConcession, decodeVaultEvent, encodePendingConcessions,
    encodePendingWithdrawals, escapeConcessionRaises, escapeConcessionRecorded,
    encodeClaimEscapePayout, encodeDeposit, encodeEscapePayoutCredits, encodeFinalizeEscape,
    encodeWithdrawal, escapePeriodBadge, escapePeriodLabel, escapePeriodPhrase,
    parseEscapePayoutClaim, parseNoteDeposited, parseWithdrawalReceipt
} = unsupportedExports('wallet');

// The sponsored-withdrawal additions of branch v0.2. GASLESS_ABI is an object of selectors in the
// real module; here it fails loudly like the encoders (this host never builds sponsored calldata).
const PACKED_USER_OPERATION_TUPLE = '(address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)';
const {
    GASLESS_ABI, encodeClaimCredit, encodeCreateAccount, encodeSweep, encodeTransitWithdraw
} = unsupportedExports('wallet');

const walletCodec = Object.freeze({
    ABI,
    ESCAPE_PAYOUT_GAS,
    REQUEST_TUPLE,
    WITHDRAWAL_CALLDATA_BYTES,
    WITHDRAWAL_KIND,
    WITHDRAWAL_TUPLE,
    PACKED_USER_OPERATION_TUPLE,
    GASLESS_ABI,
    encodeClaimCredit,
    encodeCreateAccount,
    encodeSweep,
    encodeTransitWithdraw,
    decodeChallengeEscapeWithdrawal,
    decodePendingConcessions,
    decodePendingWithdrawals,
    decodeRaiseEscapeConcession,
    decodeVaultEvent,
    encodePendingConcessions,
    encodePendingWithdrawals,
    escapeConcessionRaises,
    escapeConcessionRecorded,
    abiWord,
    addressWord,
    callData,
    encodeClaimEscapePayout,
    encodeDeposit,
    encodeEscapePayoutCredits,
    encodeFinalizeEscape,
    encodeWithdrawal,
    escapePeriodBadge,
    escapePeriodLabel,
    escapePeriodPhrase,
    parseEscapePayoutClaim,
    parseNoteDeposited,
    parseWithdrawalReceipt,
});

export default walletCodec;
export {
    ABI, ESCAPE_PAYOUT_GAS, REQUEST_TUPLE, WITHDRAWAL_CALLDATA_BYTES, WITHDRAWAL_KIND, WITHDRAWAL_TUPLE,
    PACKED_USER_OPERATION_TUPLE, GASLESS_ABI, encodeClaimCredit, encodeCreateAccount, encodeSweep, encodeTransitWithdraw,
    abiWord, addressWord, callData,
    decodeChallengeEscapeWithdrawal, decodePendingConcessions, decodePendingWithdrawals,
    decodeRaiseEscapeConcession, decodeVaultEvent, encodeClaimEscapePayout, encodeDeposit,
    encodeEscapePayoutCredits, encodeFinalizeEscape, encodePendingConcessions, encodePendingWithdrawals,
    encodeWithdrawal, escapeConcessionRaises, escapeConcessionRecorded, escapePeriodBadge,
    escapePeriodLabel, escapePeriodPhrase, parseEscapePayoutClaim, parseNoteDeposited,
    parseWithdrawalReceipt
};
