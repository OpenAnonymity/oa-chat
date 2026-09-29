import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import { withBrowserWalletLock } from '@openanonymity/zkapi-browser-sdk/store';

// The public SDK summary omits submission ownership and proof data. Check the
// local journal before offering a mode change and expose only its identity.
function unsubmittedWithdrawalIdentity({ client, runtime }, mode) {
    const state = runtime.runtime;
    const plan = state?.preparedWithdrawal;
    const displayed = client.config?.prepared_withdrawal;
    const noteId = plan?.noteId ?? plan?.public_inputs?.note_id;
    if (!client.browserMode || !plan?.operationId || plan.mode !== mode
        || !['reserving', 'prepared'].includes(plan.phase)
        || displayed?.mode !== mode || displayed.transaction_hash
        || Number(noteId) !== Number(state.state?.note_id)
        || Number(noteId) !== Number(client.note?.note_id)
        || Number(noteId) !== Number(displayed.note_id)
        || !plan.destination || plan.destination.toLowerCase() !== displayed.destination?.toLowerCase()
        || plan.legacyRecovery || plan.submissionNonceJournalRequired
        || plan.submissionId || plan.submissionOwner || plan.submissionFrom
        || plan.submissionNonce != null || plan.transactionHash
        || plan.transactionHashes?.length || plan.transactionAttempts?.length
        || plan.ambiguousSubmissions?.length || plan.ambiguousReplacements?.length
        || state.lateWithdrawalAttempts?.some(attempt => Number(attempt.noteId) === Number(noteId)
            && !['closed', 'detached', 'reverted', 'challenged', 'superseded', 'quarantined'].includes(attempt.status))) return null;
    return { operationId: plan.operationId, noteId: Number(noteId), destination: plan.destination.toLowerCase() };
}

export function availableWithdrawalEscape({ client = zkapiClient, runtime = walletRuntime } = {}) {
    return unsubmittedWithdrawalIdentity({ client, runtime }, 'mutual');
}

export function canCancelPreparedWithdrawal({ client = zkapiClient, runtime = walletRuntime } = {}) {
    if (!client.browserMode) return true;
    return Boolean(unsubmittedWithdrawalIdentity({ client, runtime }, 'escape'))
        && runtime.runtime.preparedWithdrawal.clearanceReserved !== true;
}

export function sameWithdrawalEscape(left, right) {
    return Boolean(left && right && left.operationId === right.operationId
        && left.noteId === right.noteId && left.destination === right.destination);
}

// Selecting escape never prepares a proof or transacts. Continue rechecks the
// durable state; the SDK then owns preparation and locked cross-tab validation.
export async function assertWithdrawalEscapeAvailable(expected, {
    client = zkapiClient, runtime = walletRuntime, withWalletLock = withBrowserWalletLock
} = {}) {
    await runtime.init();
    return withWalletLock(runtime.manifest.deployment_id, async () => {
        await runtime.reload();
        if (!sameWithdrawalEscape(expected, availableWithdrawalEscape({ client, runtime }))) {
            throw new Error('This saved withdrawal changed. Check its status before choosing the escape hatch again.');
        }
    });
}
