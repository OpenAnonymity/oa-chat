/** Return only aggregate wallet state that is safe for extensions to observe. */
export function toExtensionTicketSnapshot(tools = {}, account = {}) {
    const ticketCount = Math.max(0, Number(tools.ticketCount || 0));
    const maxShareCount = Math.max(0, Number(tools.maxShareCount || 0));
    const signedIn = Boolean(account.accountId);
    const accountTicketsReady = !signedIn || (
        account.sessionVerified === true &&
        account.status === 'unlocked' &&
        account.accountScopeReady === true &&
        account.ticketSyncReady === true
    );
    return Object.freeze({
        ticketCount,
        maxShareCount,
        busy: tools.busy === true,
        readyForAutomaticBilling: accountTicketsReady
    });
}
