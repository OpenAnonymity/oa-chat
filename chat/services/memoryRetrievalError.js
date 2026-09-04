const FALLBACK_MEMORY_FAILURE_CONTENT = 'No added memory. Sending original prompt.';
const MEMORY_RETRIEVAL_FAILURE_COPY = Object.freeze({
    auth: {
        title: 'Memory access will refresh',
        detail: 'Try again if you need memory context for this message.'
    },
    rate_limit: {
        title: 'Memory is busy',
        detail: 'Try again after a short wait if you need memory context.'
    },
    service: {
        title: 'Memory is temporarily unavailable',
        detail: 'Try again later if you need memory context.'
    },
    request: {
        title: 'Memory could not be added',
        detail: 'Your message was sent without memory context.'
    },
    timeout: {
        title: 'Memory lookup took too long',
        detail: 'Check your connection and try again if you need memory context.'
    },
    network: {
        title: 'Connection issue',
        detail: 'Check your connection and try again if you need memory context.'
    },
    storage: {
        title: 'Memory storage needs attention',
        detail: 'Check site storage permissions if this keeps happening.'
    },
    runtime: {
        title: 'Memory setup needs a reload',
        detail: 'Reload the app and try again if you need memory context.'
    },
    unknown: {
        title: 'Memory context was skipped',
        detail: 'Try again if you need memory context for this message.'
    }
});

function createMemoryRetrievalReason(kind) {
    const copy = MEMORY_RETRIEVAL_FAILURE_COPY[kind] || MEMORY_RETRIEVAL_FAILURE_COPY.unknown;
    return {
        kind: MEMORY_RETRIEVAL_FAILURE_COPY[kind] ? kind : 'unknown',
        title: copy.title,
        detail: copy.detail
    };
}

export function getMemoryRetrievalErrorStatus(error) {
    const candidates = [
        error?.status,
        error?.statusCode,
        error?.response?.status,
        error?.response?.statusCode,
        error?.cause?.status,
        error?.cause?.statusCode,
        error?.cause?.response?.status,
        error?.cause?.response?.statusCode
    ];
    for (const value of candidates) {
        const status = Number(value);
        if (Number.isInteger(status) && status >= 100 && status <= 599) {
            return status;
        }
    }
    const message = String(error?.message || error || '');
    const match = message.match(/\b([1-5][0-9]{2})\b/);
    return match ? Number(match[1]) : null;
}

function getErrorTextForClassification(error) {
    return [
        error?.name,
        error?.code,
        error?.type,
        error?.message,
        error?.cause?.name,
        error?.cause?.code,
        error?.cause?.type,
        error?.cause?.message
    ]
        .filter((value) => typeof value === 'string' && value.trim())
        .join(' ')
        .toLowerCase();
}

export function describeMemoryRetrievalError(error) {
    const status = getMemoryRetrievalErrorStatus(error);
    const text = getErrorTextForClassification(error);

    if (status === 401 || status === 403) {
        return createMemoryRetrievalReason('auth');
    }

    if (status === 429) {
        return createMemoryRetrievalReason('rate_limit');
    }

    if (status >= 500) {
        return createMemoryRetrievalReason('service');
    }

    if (status >= 400) {
        return createMemoryRetrievalReason('request');
    }

    if (/\b(timeout|timed out|etimedout|aborterror)\b/.test(text)) {
        return createMemoryRetrievalReason('timeout');
    }

    if (/\b(failed to fetch|networkerror|network error|econnreset|enotfound|econnrefused|network|fetch failed)\b/.test(text)) {
        return createMemoryRetrievalReason('network');
    }

    if (/\b(indexeddb|quota|storage|database|transaction)\b/.test(text)) {
        return createMemoryRetrievalReason('storage');
    }

    if (/\b(module|import|nanomem|memorybank|memory bank)\b/.test(text)) {
        return createMemoryRetrievalReason('runtime');
    }

    return createMemoryRetrievalReason('unknown');
}

export function normalizeMemoryRetrievalFailureReason(failure) {
    if (!failure || typeof failure !== 'object') return null;
    return createMemoryRetrievalReason(failure.kind);
}

export function createMemoryRetrievalFailure(error) {
    return {
        content: FALLBACK_MEMORY_FAILURE_CONTENT,
        reason: describeMemoryRetrievalError(error)
    };
}

export function isExplicitMemoryRetrievalCancellation(error, signal = null) {
    return signal?.aborted === true
        || error?.isCancelled === true;
}
