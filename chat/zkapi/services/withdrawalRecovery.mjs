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

// Whether the balance (and, when one is named, the prepared withdrawal) the
// person was looking at is still the one in the wallet. The strict identity
// check above is for the "Use escape instead" choice, which only applies to an
// unsubmitted mutual plan; this one is for a withdrawal about to start, in any
// mode and phase, so it asks only the two questions that matter there:
//
//   - the note in the slot, the note the client displays and the note the
//     person chose are all one note, and
//   - when the person's choice was made on a prepared withdrawal, that same
//     operation is still the prepared one.
//
// It runs under the SDK's wallet lock on a fresh read, after the caller's
// settlement and wallet-connection waits, so it covers the longest part of the
// window in which another tab can replace either. Whatever follows (the SDK's
// own preparation) is the SDK's to guard.
async function assertNoteUnchanged(expected, { client, runtime, withWalletLock }) {
    // A missing id must never read as note 0.
    const idOf = value => {
        const id = typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : null;
        return Number.isSafeInteger(id) && id >= 0 ? id : null;
    };
    const noteId = idOf(expected.noteId);
    const changed = () => Object.assign(new Error(
        'This private balance changed in another tab. Reload and check it before withdrawing.'
    ), { code: 'withdrawal_note_changed' });
    if (noteId === null) throw changed();
    await runtime.init();
    // As the SDK does itself before taking its lock: this tab's startup
    // recovery and any private key still being issued must not queue ahead of
    // the exit. Both are journaled and resume later.
    if (typeof runtime.preemptForExit === 'function') runtime.preemptForExit({ requests: true });
    return withWalletLock(runtime.manifest.deployment_id, async () => {
        await runtime.reload();
        const state = runtime.runtime;
        if (idOf(state?.state?.note_id) !== noteId || idOf(client.note?.note_id) !== noteId) throw changed();
        if (expected.operationId != null && state.preparedWithdrawal?.operationId !== expected.operationId) throw changed();
    });
}

// Selecting escape never prepares a proof or transacts. Continue rechecks the
// durable state; the SDK then owns preparation and locked cross-tab validation.
//
// `expected` is either the identity of an unsubmitted mutual plan
// (availableWithdrawalEscape: no `kind`), checked strictly as before, or
// `{kind: 'note', noteId, operationId|null}`, checked by assertNoteUnchanged.
export async function assertWithdrawalEscapeAvailable(expected, {
    client = zkapiClient, runtime = walletRuntime, withWalletLock = withBrowserWalletLock
} = {}) {
    if (expected?.kind === 'note') return assertNoteUnchanged(expected, { client, runtime, withWalletLock });
    await runtime.init();
    return withWalletLock(runtime.manifest.deployment_id, async () => {
        await runtime.reload();
        if (!sameWithdrawalEscape(expected, availableWithdrawalEscape({ client, runtime }))) {
            throw new Error('This saved withdrawal changed. Check its status before choosing the escape hatch again.');
        }
    });
}
