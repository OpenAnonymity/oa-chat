import { waitForSignal, discardResponseBody } from './reliability.js';
/**
 * Consume an SSE response incrementally, matching OA Chat's browser transport.
 * `onLine` runs as soon as each complete line arrives; the response is never
 * buffered into a single string or JSON value. Async handlers are awaited so
 * that a slow first-line setup cannot be overtaken by later stream deltas.
 * Returning `false` from `onLine` marks a terminal SSE event and cancels the
 * reader without waiting for the server to close the HTTP response. The
 * optional getSettled callback supplies the current completion-tail promise.
 * Race it only against a read, never against an async line handler: cancelling
 * during a handler drops unread chunks already queued by the transport.
 * An already-queued read wins even when the tail has elapsed. Drain those chunks
 * first, then stop when a read would wait for new data. Output in that queue can
 * disarm the old tail, so ask for the current promise on every read.
 */
export async function consumeSseBody(body, onLine, { signal, onActivity, getSettled } = {}) {
    if (!body?.getReader) {
        throw new Error('The inference response did not include a readable stream.');
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const tailEnd = Symbol('completion tail ended');

    try {
        while (true) {
            const read = reader.read();
            const settled = getSettled?.();
            // Keep read first: both promises can already be fulfilled when a
            // slow handler resumes, and buffered events must win that tie.
            const result = await waitForSignal(settled ? Promise.race([read, settled.then(() => tailEnd)]) : read, signal);
            if (result === tailEnd) {
                discardResponseBody(reader);
                break;
            }
            const { done, value } = result;
            if (done) break;

            if (value?.byteLength) onActivity?.();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (await waitForSignal(onLine(line.replace(/\r$/, '')), signal) === false) {
                    discardResponseBody(reader);
                    return;
                }
            }
        }

        buffer += decoder.decode();
        if (buffer && await waitForSignal(onLine(buffer.replace(/\r$/, '')), signal) === false) {
            discardResponseBody(reader);
        }
    } catch (error) {
        discardResponseBody(reader);
        throw error;
    } finally {
        reader.releaseLock?.();
    }
}
