export const REASONING_EFFORTS = Object.freeze([
    'low',
    'medium',
    'high',
    'xhigh'
]);

export const DEFAULT_REASONING_EFFORT = 'medium';

export function normalizeReasoningEffort(effort) {
    if (typeof effort !== 'string') {
        return DEFAULT_REASONING_EFFORT;
    }

    const normalized = effort.trim().toLowerCase();
    if (REASONING_EFFORTS.includes(normalized)) {
        return normalized;
    }

    return DEFAULT_REASONING_EFFORT;
}
