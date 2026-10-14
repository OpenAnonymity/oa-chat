// Whether a wallet slot holds a prepared deposit plan that was never sent.
//
// This is the rule that releases a rejected deposit plan
// (chat/zkapi/services/canceledDeposit.mjs). It lives in this one pure module
// so the host probe (walletHoldings.mjs), the deposit guard and
// canceledDeposit.mjs all share a single definition. A plan is "unsent" only
// when nothing in it can mean "a wallet prompt was opened or a transaction may
// exist": the SDK commits the submission claim (submissionId, submissionOwner,
// ...) under the wallet lock BEFORE the wallet prompt, so a plan without any
// claim, hash or attempt has no chain footprint. Discarding anything else
// could destroy the secret of a note whose deposit was actually broadcast.
//
// Pure: no SDK, IndexedDB, storage or network access.

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {object|null} slot the stored runtime slot (what the SDK calls
 *   `runtime.runtime`).
 * @param {{expectedOperationId?: string}} [options] The operation the caller
 *   believes it is releasing. When given, the plan must carry exactly that id
 *   (canceledDeposit.mjs passes the id it saw before taking the lock, so a
 *   replacement written by another tab is never released). When omitted the
 *   plan's own id is used for the late-attempt check below.
 * @returns {boolean} true only for a provably unsent prepared plan. Malformed
 *   input returns false (never released).
 */
export function isUnsentPreparedDeposit(slot, { expectedOperationId } = {}) {
    if (!isObject(slot)) return false;
    const plan = slot.pendingDeposit;
    if (!isObject(plan)) return false;
    const operationId = expectedOperationId === undefined || expectedOperationId === null
        ? plan.operationId : expectedOperationId;
    // A plan without a usable operation id cannot be matched to a late attempt
    // or to the caller's expectation, so it is never "provably unsent".
    if (typeof operationId !== 'string' || !operationId) return false;
    if (plan.operationId !== operationId) return false;
    if (slot.state) return false;
    if (plan.phase !== 'prepared' || plan.legacyRecovery) return false;
    if (plan.submissionId || plan.submissionOwner || plan.submissionFrom) return false;
    if (plan.submissionNonce != null || plan.transactionHash) return false;
    if (plan.transactionHashes?.length || plan.transactionAttempts?.length) return false;
    if (plan.ambiguousSubmissions?.length || plan.approvals?.length) return false;
    const attempts = slot.lateDepositAttempts;
    if (attempts !== undefined && attempts !== null) {
        // A stored value that is not an array, or an entry that is not an
        // object, is malformed: either means "do not release", and neither may
        // throw.
        if (!Array.isArray(attempts)) return false;
        for (const attempt of attempts) {
            if (!isObject(attempt) || attempt.operationId === operationId) return false;
        }
    }
    return true;
}
