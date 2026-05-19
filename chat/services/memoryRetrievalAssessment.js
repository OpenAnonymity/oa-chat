const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);
const COVERAGE_LEVELS = new Set(['full', 'partial', 'none']);

const CONFIDENCE_LABELS = {
    high: 'High confidence',
    medium: 'Medium confidence',
    low: 'Low confidence'
};

export function normalizeMemoryRetrievalAssessment(source = {}, options = {}) {
    const rawConfidence = source?.confidence ?? source?.retrievalConfidence;
    const confidence = normalizeStringEnum(
        rawConfidence,
        CONFIDENCE_LEVELS,
        'low'
    );
    const hasExplicitConfidence = source?.hasExplicitConfidence === true
        || isValidConfidence(source?.retrievalConfidence)
        || (options.treatConfidenceFieldAsExplicit === true && isValidConfidence(source?.confidence));
    const coverage = normalizeStringEnum(
        source?.coverage,
        COVERAGE_LEVELS,
        'none'
    );

    return {
        confidence,
        hasExplicitConfidence,
        coverage,
        missingVariables: normalizeStringList(source?.missingVariables),
        reason: normalizeNullableString(source?.reason ?? source?.retrievalReason),
        uncertainFacts: normalizeStringList(source?.uncertainFacts)
    };
}

export function renderMemoryConfidenceBadgeHtml(source) {
    if (!source) return '';
    const assessment = normalizeMemoryRetrievalAssessment(source);
    if (!assessment.hasExplicitConfidence) return '';
    const reasonTitle = assessment.reason ? ` title="${escapeHtml(assessment.reason)}"` : '';
    return `<span class="mem-prompt-confidence mem-prompt-confidence-${assessment.confidence}"${reasonTitle}>${escapeHtml(CONFIDENCE_LABELS[assessment.confidence])}</span>`;
}

function isValidConfidence(value) {
    return CONFIDENCE_LEVELS.has(normalizeString(value));
}

function normalizeStringEnum(value, allowed, fallback) {
    const normalized = normalizeString(value);
    return allowed.has(normalized) ? normalized : fallback;
}

function normalizeString(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeStringList(value) {
    return Array.isArray(value)
        ? value
            .filter((item) => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 4)
        : [];
}

function normalizeNullableString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
