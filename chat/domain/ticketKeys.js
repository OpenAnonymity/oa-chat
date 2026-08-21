const TOKEN_KEY_ID_OFFSET = 2 + 32 + 32;
const TOKEN_KEY_ID_LENGTH = 32;

function decodeBase64Url(value) {
    const normalized = String(value || '')
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

function bytesToHex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function ticketPublicKeyId(publicKey) {
    const publicKeyBytes = decodeBase64Url(publicKey);
    if (publicKeyBytes.length === 0) {
        throw new Error('A valid ticket issuer public key is required');
    }
    const digest = await globalThis.crypto.subtle.digest('SHA-256', publicKeyBytes);
    return bytesToHex(new Uint8Array(digest));
}

export function normalizeTicketKeyId(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

export function extractTicketKeyId(finalizedTicket) {
    if (!finalizedTicket) return null;
    try {
        const tokenBytes = decodeBase64Url(finalizedTicket);
        const end = TOKEN_KEY_ID_OFFSET + TOKEN_KEY_ID_LENGTH;
        if (tokenBytes.length < end) return null;
        return bytesToHex(tokenBytes.slice(TOKEN_KEY_ID_OFFSET, end));
    } catch {
        return null;
    }
}

export function getTicketKeyId(ticket) {
    // The finalized RFC 9578 token is authoritative. Imported metadata is
    // mutable and may be stale or incorrect, so use it only for legacy records
    // whose token bytes cannot be decoded.
    return extractTicketKeyId(ticket?.finalized_ticket) ||
        normalizeTicketKeyId(ticket?.ticket_key_id);
}

export function partitionTicketsByKeyId(tickets, keyId) {
    const normalizedKeyId = normalizeTicketKeyId(keyId);
    const matching = [];
    const remaining = [];

    (Array.isArray(tickets) ? tickets : []).forEach(ticket => {
        if (normalizedKeyId && getTicketKeyId(ticket) === normalizedKeyId) {
            matching.push(ticket);
        } else {
            remaining.push(ticket);
        }
    });

    return { matching, remaining };
}

export function normalizeInvalidatedTicketKeyIds(keyIds) {
    return Array.from(new Set(
        (Array.isArray(keyIds) ? keyIds : [])
            .map(normalizeTicketKeyId)
            .filter(Boolean)
    ));
}

export function buildTicketIssuanceRequest(
    credential,
    blindedRequests,
    expectedKeyId
) {
    const normalizedKeyId = normalizeTicketKeyId(expectedKeyId);
    if (!normalizedKeyId) {
        throw new Error('A valid expected ticket key ID is required');
    }
    return {
        credential,
        blinded_requests: Array.isArray(blindedRequests) ? blindedRequests : [],
        expected_key_id: normalizedKeyId
    };
}

export function filterTicketsByInvalidatedKeyIds(tickets, keyIds) {
    const invalidated = new Set(normalizeInvalidatedTicketKeyIds(keyIds));
    if (invalidated.size === 0) {
        return Array.isArray(tickets) ? [...tickets] : [];
    }
    return (Array.isArray(tickets) ? tickets : []).filter(
        ticket => !invalidated.has(getTicketKeyId(ticket))
    );
}

export function getStructuredTicketError(data, fallbackMessage) {
    const detail = data && typeof data.detail === 'object' && data.detail !== null
        ? data.detail
        : data;
    const message = (
        (typeof data?.detail === 'string' ? data.detail : null) ||
        detail?.message ||
        detail?.error ||
        data?.message ||
        data?.error ||
        (typeof data === 'string' ? data : null) ||
        fallbackMessage
    );

    return {
        code: detail?.error_code || data?.error_code || null,
        message: typeof message === 'string' ? message : fallbackMessage,
        invalidatedKeyId: normalizeTicketKeyId(
            detail?.invalidated_key_id || data?.invalidated_key_id
        ),
        detail
    };
}
