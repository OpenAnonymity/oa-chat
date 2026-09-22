import { waitForSignal, discardResponseBody } from './reliability.js';
/**
 * Consume an SSE response incrementally, matching OA Chat's browser transport.
 * `onLine` runs as soon as each complete line arrives; the response is never
 * buffered into a single string or JSON value. Async handlers are awaited so
 * that a slow first-line setup cannot be overtaken by later stream deltas.
 * Returning `false` from `onLine` marks a terminal SSE event and cancels the
 * reader without waiting for the server to close the HTTP response.
 */
export async function consumeSseBody(body, onLine, { signal, onActivity } = {}) {
    if (!body?.getReader) {
        throw new Error('The inference response did not include a readable stream.');
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await waitForSignal(reader.read(), signal);
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
