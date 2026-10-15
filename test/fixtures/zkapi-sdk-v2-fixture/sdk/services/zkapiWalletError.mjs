// FIXTURE NOTE: verbatim copy of the real SDK sdk/services/zkapiWalletError.mjs (0.2.0, branch v0.2, 4b955d9).
// EIP-1193 providers may reject with a serialized JSON-RPC object instead of
// an Error. Keep the useful message and metadata without printing the object.
export function walletErrorMessage(error, fallback = 'The wallet could not complete this request.') {
    const seen = new Set();
    const message = (value, depth = 0) => {
        if (depth > 5 || value == null) return null;
        if (typeof value === 'string') {
            const text = value.trim();
            return text && text !== '[object Object]' ? text : null;
        }
        if (typeof value !== 'object' || seen.has(value)) return null;
        seen.add(value);
        for (const field of ['shortMessage', 'message', 'reason', 'error', 'cause', 'originalError', 'data']) {
            const found = message(value[field], depth + 1);
            if (found) return found;
        }
        return null;
    };
    return message(error) || fallback;
}

export function normalizeWalletError(error, fallback) {
    if (error instanceof Error) {
        error.message = walletErrorMessage(error, fallback);
        return error;
    }
    const normalized = new Error(walletErrorMessage(error, fallback), { cause: error });
    for (const field of [
        'code', 'data', 'status', 'transactionHash', 'transactionReceipt',
        'transactionStage', 'broadcastPossible', 'withdrawalNeedsAction'
    ]) {
        if (error?.[field] != null) normalized[field] = error[field];
    }
    if (typeof error?.shortMessage === 'string' && error.shortMessage !== '[object Object]') {
        normalized.shortMessage = error.shortMessage;
    }
    return normalized;
}
