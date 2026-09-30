/** Return only aggregate wallet state that is safe for extensions to observe. */
export function toExtensionTicketSnapshot(tools = {}, account = {}) {
    const ticketCount = Math.max(0, Number(tools.ticketCount || 0));
    const maxShareCount = Math.max(0, Number(tools.maxShareCount || 0));
    const signedIn = Boolean(account.accountId);
    const accountTicketsReady = account.isReady === true && (
        !signedIn || (
            account.sessionVerified === true &&
            account.status === 'unlocked' &&
            account.accountScopeReady === true &&
            account.ticketSyncReady === true
        )
    );
    return Object.freeze({
        ticketCount,
        maxShareCount,
        busy: tools.busy === true,
        // Previous-version tickets waiting to move or moving (a count only).
        movingTickets: Number.isFinite(Number(tools.movingTickets)) ? Math.max(0, Math.floor(Number(tools.movingTickets))) : 0,
        readyForAutomaticBilling: accountTicketsReady
    });
}
