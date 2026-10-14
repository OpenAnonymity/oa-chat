import { isSpentTicketRefusal } from './networkLogRenderer.js';

/** Collapse adjacent select/refusal pairs only; never hide unrelated failures.
 * Input/output are newest first. Raw logs and ticket processing stay untouched. */
function isSpentKeyCheck(log) {
    if (log?.type !== 'api-key' || log.method !== 'POST' || log.isAborted || log.error
        || !isSpentTicketRefusal(log.status, log.response)) return false;
    try { return new URL(log.url).pathname === '/api/request_key'; } catch { return false; }
}

export function groupSpentTicketChecks(logs, previousRows = []) {
    const chronological = [...logs].reverse();
    const previousByCheck = new Map(previousRows
        .filter(row => row.action === 'ticket-sweep-summary')
        .map(row => [row.lastCheckLogId, row]));
    const rows = [];
    function appendCheck(refusal, selection = refusal) {
        let group = rows.at(-1);
        if (group?.action === 'ticket-sweep-summary'
            && group.sessionId === refusal.sessionId && group.url === refusal.url) {
            group.spentTicketChecks++;
        } else {
            group = {
                id: selection.id, timestamp: selection.timestamp,
                sessionId: refusal.sessionId, type: 'local', method: 'LOCAL',
                action: 'ticket-sweep-summary', status: 'ticket-cleanup', url: refusal.url,
                request: {}, response: {}, spentTicketChecks: 1
            };
            rows.push(group);
        }
        const previous = previousByCheck.get(refusal.id);
        if (previous && previous.sessionId === group.sessionId && previous.url === group.url) {
            // Preserve expansion while old raw entries roll out of the bounded
            // memory log. Overlap, not session alone, identifies the same run.
            group.id = previous.id;
            group.timestamp = previous.timestamp;
        }
        group.lastCheckTimestamp = refusal.timestamp;
        group.lastCheckLogId = refusal.id;
    }
    for (let index = 0; index < chronological.length; index++) {
        const selection = chronological[index];
        const refusal = chronological[index + 1];
        // The bounded raw log may have dropped just the oldest selection.
        if (index === 0 && isSpentKeyCheck(selection)) {
            appendCheck(selection);
            continue;
        }
        const pair = selection.type === 'local' && selection.method === 'LOCAL'
            && selection.action === 'ticket-select' && selection.status === 200
            && !selection.isAborted && !selection.error && isSpentKeyCheck(refusal)
            && refusal.sessionId === selection.sessionId;
        if (!pair) { rows.push({ ...selection }); continue; }
        appendCheck(refusal, selection);
        index++;
    }
    return rows.reverse();
}

export function groupActivityTimeline(logs, previousRows = []) {
    return groupVerificationRetries(groupSpentTicketChecks(logs, previousRows));
}

/** Presentation only: retain raw memory logs and the verifier's retry behavior. */
export function groupVerificationRetries(logs) {
    const rows = [];
    let previousKey = null;
    for (const log of [...logs].reverse()) {
        const keyHash = log.request?.key_hash;
        const stationId = log.request?.station_id;
        const canGroup = log.type === 'verification'
            && log.status === 'verifier-unavailable'
            && log.detail === 'verifier-unavailable'
            && !log.isAborted && !log.error
            && Object.keys(log.response || {}).length === 0
            && /^[a-f0-9]{16}$/i.test(keyHash || '')
            && typeof stationId === 'string' && stationId.length > 0;
        const key = canGroup ? JSON.stringify([
            log.sessionId, log.url, log.method, stationId, keyHash
        ]) : null;
        const previous = rows.at(-1);
        if (key && key === previousKey) {
            // Keep the first row's ID/time so expansion and chronology stay stable.
            previous.verificationChecks = (previous.verificationChecks || 1) + 1;
            previous.lastCheckTimestamp = log.timestamp;
        } else {
            rows.push({ ...log });
        }
        // Any intervening activity, including recovery or refusal, starts a new row.
        previousKey = key;
    }
    return rows.reverse();
}
