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
