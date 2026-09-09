// Plain-language copy for zkAPI errors that are expected states, not
// faults. The SDK's wording is accurate but assumes the reader knows what
// an indexer or a vault root is.

/** The indexer (which reads the vault from Ethereum) has not yet seen the
 *  block a proof must be built against. It catches up on its own; the SDK
 *  has already waited about ten seconds before giving up. */
export const INDEXER_LAG_MESSAGE = 'zkAPI is still reading your latest transaction from Ethereum, so your balance can’t be proven against it yet. Nothing was lost. This usually clears within a minute of the transaction confirming — wait, then try again.';

export function isIndexerLag(error) {
    return error?.code === 'indexer_root_lag'
        || /indexer is still catching up/i.test(error?.message || error?.shortMessage || '');
}

/** Rewrites a caught error's message in place so every surface — toast,
 *  activity log, panel — says the same clear thing. Returns the error. */
export function explainZkapiError(error) {
    if (error && typeof error === 'object' && isIndexerLag(error)) {
        try {
            error.message = INDEXER_LAG_MESSAGE;
            if ('shortMessage' in error) error.shortMessage = INDEXER_LAG_MESSAGE;
            error.code = 'indexer_root_lag';
        } catch { /* frozen error: the message getters below still apply */ }
    }
    return error;
}

export function zkapiErrorMessage(error, fallback = 'The wallet could not complete this request.') {
    if (isIndexerLag(error)) return INDEXER_LAG_MESSAGE;
    return error?.shortMessage || error?.message || fallback;
}
