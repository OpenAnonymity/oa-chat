import test from 'node:test';
import assert from 'node:assert/strict';
import {
    describeMemoryRetrievalError,
    createMemoryRetrievalFailure,
    isExplicitMemoryRetrievalCancellation
} from '../../chat/services/memoryRetrievalError.js';

test('describeMemoryRetrievalError classifies network failures with calm user copy and no raw error text', () => {
    const error = new TypeError('Failed to fetch https://example.invalid?api_key=secret prompt=private');

    const detail = describeMemoryRetrievalError(error);

    assert.equal(detail.kind, 'network');
    assert.equal(detail.title, 'Connection issue');
    assert.doesNotMatch(detail.detail, /secret|private|example\.invalid/i);
    assert.doesNotMatch(`${detail.title} ${detail.detail}`, /failed|error|rejected|unexpected/i);
});

test('describeMemoryRetrievalError classifies auth failures with a non-scary key refresh note', () => {
    const detail = describeMemoryRetrievalError({ status: 403, message: 'Forbidden' });

    assert.equal(detail.kind, 'auth');
    assert.equal(detail.title, 'Memory access will refresh');
    assert.match(detail.detail, /try again/i);
    assert.doesNotMatch(`${detail.title} ${detail.detail}`, /rejected|invalid|unauthorized|forbidden/i);
});

test('describeMemoryRetrievalError classifies wrapped timeout causes', () => {
    const detail = describeMemoryRetrievalError({
        message: 'fetch failed',
        cause: {
            code: 'ETIMEDOUT'
        }
    });

    assert.equal(detail.kind, 'timeout');
    assert.equal(detail.title, 'Memory lookup took too long');
});

test('describeMemoryRetrievalError reads nested response status codes', () => {
    const detail = describeMemoryRetrievalError({
        response: {
            statusCode: 502
        }
    });

    assert.equal(detail.kind, 'service');
    assert.equal(detail.title, 'Memory is temporarily unavailable');
    assert.doesNotMatch(detail.detail, /HTTP 502/);
});

test('describeMemoryRetrievalError reads wrapped cause status shapes', () => {
    assert.equal(describeMemoryRetrievalError({
        cause: {
            statusCode: 503
        }
    }).detail, 'Try again later if you need memory context.');

    assert.equal(describeMemoryRetrievalError({
        cause: {
            response: {
                status: 401
            }
        }
    }).kind, 'auth');

    assert.equal(describeMemoryRetrievalError({
        cause: {
            response: {
                statusCode: 502
            }
        }
    }).detail, 'Try again later if you need memory context.');
});

test('createMemoryRetrievalFailure preserves generic fallback copy with safe reason metadata', () => {
    const failure = createMemoryRetrievalFailure({
        status: 500,
        responseText: '{"prompt":"do not leak this","error":"upstream crashed"}'
    });

    assert.equal(
        failure.content,
        'Memory context was not added this time. Sending without it.'
    );
    assert.deepEqual(failure.reason, {
        kind: 'service',
        title: 'Memory is temporarily unavailable',
        detail: 'Try again later if you need memory context.'
    });
    assert.doesNotMatch(JSON.stringify(failure), /do not leak this|upstream crashed/);
});

test('isExplicitMemoryRetrievalCancellation does not treat provider AbortError as user cancellation', () => {
    const timeoutAbort = new Error('The operation was aborted by a timeout');
    timeoutAbort.name = 'AbortError';

    assert.equal(isExplicitMemoryRetrievalCancellation(timeoutAbort, { aborted: false }), false);
    assert.equal(isExplicitMemoryRetrievalCancellation(timeoutAbort, { aborted: true }), true);
    assert.equal(isExplicitMemoryRetrievalCancellation({ isCancelled: true }, { aborted: false }), true);
    assert.equal(isExplicitMemoryRetrievalCancellation({ name: 'AbortError', aborted: true }, { aborted: false }), false);
});
