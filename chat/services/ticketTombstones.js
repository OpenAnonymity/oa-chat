const textEncoder = new TextEncoder();

function bytesToHex(bytes) {
    return Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

export async function fingerprintFinalizedTicket(ticket) {
    const finalizedTicket = typeof ticket === 'string'
        ? ticket
        : ticket?.finalized_ticket;
    if (!finalizedTicket) return null;
    const digest = await crypto.subtle.digest(
        'SHA-256',
        textEncoder.encode(finalizedTicket)
    );
    return bytesToHex(new Uint8Array(digest));
}

export async function createTicketTombstones(
    tickets,
    removedAt = new Date().toISOString()
) {
    const tombstones = await Promise.all(
        (tickets || []).map(async ticket => {
            const fingerprint = await fingerprintFinalizedTicket(ticket);
            return fingerprint
                ? { fingerprint, removed_at: removedAt }
                : null;
        })
    );
    return tombstones.filter(Boolean);
}

export function mergeTicketTombstones(existing, incoming) {
    const merged = [];
    const byFingerprint = new Map();
    for (const tombstone of [...(existing || []), ...(incoming || [])]) {
        if (!tombstone?.fingerprint) continue;
        const previous = byFingerprint.get(tombstone.fingerprint);
        if (!previous) {
            const copy = { ...tombstone };
            byFingerprint.set(tombstone.fingerprint, copy);
            merged.push(copy);
            continue;
        }
        if (
            tombstone.removed_at &&
            (!previous.removed_at ||
                tombstone.removed_at > previous.removed_at)
        ) {
            Object.assign(previous, tombstone);
        }
    }
    return merged;
}

export async function filterTicketsByTombstones(tickets, tombstones) {
    const removed = new Set(
        (tombstones || [])
            .map(tombstone => tombstone?.fingerprint)
            .filter(Boolean)
    );
    if (removed.size === 0) return [...(tickets || [])];

    const fingerprints = await Promise.all(
        (tickets || []).map(fingerprintFinalizedTicket)
    );
    return (tickets || []).filter(
        (_ticket, index) => !removed.has(fingerprints[index])
    );
}
