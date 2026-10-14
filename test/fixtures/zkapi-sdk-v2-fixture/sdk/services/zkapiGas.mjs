// FIXTURE NOTE: verbatim copy of the real SDK sdk/services/zkapiGas.mjs (0.2.0, 82c8504).
// EIP-7825 rejects any Ethereum transaction whose gas limit exceeds 2^24,
// even when the block gas limit itself is higher. Keep the wallet-provided
// estimate comfortably padded, but never create a transaction the network
// cannot accept.
export const MAX_TRANSACTION_GAS_LIMIT = 1n << 24n;

const GAS_MARGIN_NUMERATOR = 12n;
const GAS_MARGIN_DENOMINATOR = 10n;
const GAS_FIXED_PADDING = 50_000n;

export function bufferedGasLimit(estimate) {
    const value = typeof estimate === 'bigint' ? estimate : BigInt(estimate);
    if (value <= 0n) throw new Error('The wallet returned an invalid gas estimate.');
    const buffered = value * GAS_MARGIN_NUMERATOR / GAS_MARGIN_DENOMINATOR + GAS_FIXED_PADDING;
    if (buffered > MAX_TRANSACTION_GAS_LIMIT) {
        const error = new Error('The simulated transaction exceeds Ethereum’s per-transaction gas limit. Nothing was submitted.');
        error.code = 'transaction_gas_limit_exceeded';
        throw error;
    }
    return `0x${buffered.toString(16)}`;
}

// The gas limit an exit is submitted with when the wallet provider's
// simulation refuses it (design §6.4 E4.5: that simulation is advisory). An
// escape costs about 0.55–0.62M gas and a mutual close about 0.40–0.45M.
export const EXIT_FALLBACK_GAS_LIMIT = 1_000_000n;
