/**
 * Whether a modal dialog is showing. While one is up (Log in, Account,
 * Welcome, the memory editor, a host dialog in the modal layer) it owns the
 * keyboard: typing must not land in the composer behind it, and Enter must
 * not send a message from a page the person cannot see.
 *
 * Every modal surface in the app marks its dialog aria-modal="true"; hidden
 * ones have no layout boxes, so the check is the accessibility tree itself
 * rather than a list of components to keep in sync.
 */
export function hasOpenModalDialog(documentImpl = globalThis.document) {
    const dialogs = documentImpl?.querySelectorAll?.('[aria-modal="true"]') || [];
    for (const dialog of dialogs) {
        if (typeof dialog.getClientRects !== 'function') return true;
        if (dialog.getClientRects().length > 0) return true;
    }
    return false;
}
