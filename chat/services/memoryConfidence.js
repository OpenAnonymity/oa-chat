export function normalizeMemoryConfidenceValue(value, fallback = 0.7) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return clampConfidence(value);
    }

    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'high' || normalized === 'strong') return 1;
    if (normalized === 'medium' || normalized === 'med' || normalized === 'moderate') return 0.7;
    if (normalized === 'low' || normalized === 'weak') return 0.3;

    const parsed = Number.parseFloat(normalized);
    if (Number.isFinite(parsed)) {
        return clampConfidence(parsed);
    }

    return clampConfidence(fallback);
}

export function getMemoryConfidenceBarCount(value) {
    const confidence = normalizeMemoryConfidenceValue(value);
    if (confidence >= 0.85) return 3;
    if (confidence >= 0.6) return 2;
    if (confidence > 0) return 1;
    return 0;
}

export function formatMemoryConfidenceLabel(value) {
    return `${Math.round(normalizeMemoryConfidenceValue(value) * 100)}%`;
}

function clampConfidence(value) {
    return Math.min(1, Math.max(0, value));
}
