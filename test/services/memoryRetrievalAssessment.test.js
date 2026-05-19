import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeMemoryRetrievalAssessment,
    renderMemoryConfidenceBadgeHtml
} from '../../chat/services/memoryRetrievalAssessment.js';
import {
    formatMemoryConfidenceLabel,
    getMemoryConfidenceBarCount,
    normalizeMemoryConfidenceValue
} from '../../chat/services/memoryConfidence.js';

test('normalizeMemoryRetrievalAssessment maps invalid metadata to conservative defaults', () => {
    assert.deepEqual(normalizeMemoryRetrievalAssessment({
        retrievalConfidence: 'certain',
        coverage: 'everything',
        missingVariables: [' location ', '', 3],
        retrievalReason: '  needs location  ',
        uncertainFacts: ['maybe SF']
    }), {
        confidence: 'low',
        hasExplicitConfidence: false,
        coverage: 'none',
        missingVariables: ['location'],
        reason: 'needs location',
        uncertainFacts: ['maybe SF']
    });
});

test('renderMemoryConfidenceBadgeHtml renders only confidence', () => {
    const html = renderMemoryConfidenceBadgeHtml({
        retrievalConfidence: 'medium',
        coverage: 'partial',
        missingVariables: ['budget']
    });

    assert.match(html, /Medium confidence/);
    assert.doesNotMatch(html, /Partial coverage/);
    assert.doesNotMatch(html, /Missing: budget/);
    assert.match(html, /mem-prompt-confidence-medium/);
});

test('normalizeMemoryRetrievalAssessment preserves explicit confidence for stored drafts', () => {
    const assessment = normalizeMemoryRetrievalAssessment({
        confidence: 'high',
        coverage: 'full'
    }, {
        treatConfidenceFieldAsExplicit: true
    });

    assert.equal(assessment.hasExplicitConfidence, true);
    assert.match(renderMemoryConfidenceBadgeHtml(assessment), /High confidence/);
});

test('renderMemoryConfidenceBadgeHtml omits fallback confidence', () => {
    assert.equal(renderMemoryConfidenceBadgeHtml({
        confidence: 'low',
        coverage: 'none'
    }), '');
});

test('renderMemoryConfidenceBadgeHtml omits empty input', () => {
    assert.equal(renderMemoryConfidenceBadgeHtml(null), '');
});

test('numeric and legacy memory confidence values render stable labels and bars', () => {
    assert.equal(normalizeMemoryConfidenceValue('0.82'), 0.82);
    assert.equal(formatMemoryConfidenceLabel('0.82'), '82%');
    assert.equal(getMemoryConfidenceBarCount('0.82'), 2);
    assert.equal(formatMemoryConfidenceLabel('high'), '100%');
    assert.equal(getMemoryConfidenceBarCount('low'), 1);
});
