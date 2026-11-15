/**
 * Ticket usage log
 *
 * A per-day count of tickets spent on inference, kept so the Account usage
 * chart can show history that outlives the monthly ticket expiry. Expiry
 * removes that month's spent tickets from the archive (see the
 * TICKET_KEY_INVALIDATED branch of TicketStore.consumeTickets), so the
 * archive alone cannot answer "how many tickets did I use in March".
 *
 * The log holds dates and counts only: no ticket values, key ids, models or
 * times of day. It is local, account-scoped (switched with the account like
 * `tickets-leases`), never synced and never sent anywhere. Shares are not
 * usage and are not recorded.
 */

export const TICKET_USAGE_KEY = 'tickets-usage-daily';
export const TICKET_USAGE_VERSION = 1;
// About ten years of days; older entries are dropped first.
export const TICKET_USAGE_MAX_DAYS = 3660;

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar day ("YYYY-MM-DD") of a Date, ISO string or epoch ms. */
export function localDayKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

function positiveCount(value) {
    const count = Math.floor(Number(value));
    return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function trimDays(days) {
    const keys = Object.keys(days);
    if (keys.length <= TICKET_USAGE_MAX_DAYS) return days;
    const keep = keys.sort().slice(-TICKET_USAGE_MAX_DAYS);
    return Object.fromEntries(keep.map(key => [key, days[key]]));
}

/** Accepts anything read from storage; returns a well-formed log. */
export function normalizeTicketUsageLog(value) {
    const source = value && typeof value === 'object' && value.days && typeof value.days === 'object'
        ? value.days
        : {};
    const days = {};
    for (const [key, count] of Object.entries(source)) {
        if (!DAY_KEY_PATTERN.test(key)) continue;
        const n = positiveCount(count);
        if (n > 0) days[key] = n;
    }
    return {
        version: TICKET_USAGE_VERSION,
        backfilled: value?.backfilled === true,
        days: trimDays(days)
    };
}

/** Adds `count` tickets to the local day of `at`. */
export function addTicketUsage(log, count, at = new Date()) {
    const normalized = normalizeTicketUsageLog(log);
    const n = positiveCount(count);
    const key = localDayKey(at);
    if (n === 0 || !key) return normalized;
    return {
        ...normalized,
        days: trimDays({ ...normalized.days, [key]: (normalized.days[key] || 0) + n })
    };
}

/**
 * One-time seed from the spent-ticket archive that exists when the log is
 * first used. Days already in the log keep the larger of the two counts so a
 * repeated or late backfill never double counts.
 */
export function backfillTicketUsage(log, archivedTickets) {
    const normalized = normalizeTicketUsageLog(log);
    if (normalized.backfilled) return normalized;
    const fromArchive = {};
    for (const ticket of Array.isArray(archivedTickets) ? archivedTickets : []) {
        const key = ticket?.consumed_at ? localDayKey(ticket.consumed_at) : null;
        if (key) fromArchive[key] = (fromArchive[key] || 0) + 1;
    }
    const days = { ...normalized.days };
    for (const [key, count] of Object.entries(fromArchive)) {
        days[key] = Math.max(days[key] || 0, count);
    }
    return { ...normalized, backfilled: true, days: trimDays(days) };
}

/** Frozen, date-ordered `[{ day: 'YYYY-MM-DD', count }]` for extensions. */
export function toTicketUsageHistory(log) {
    const { days } = normalizeTicketUsageLog(log);
    return Object.freeze(Object.keys(days).sort().map(day => Object.freeze({ day, count: days[day] })));
}
