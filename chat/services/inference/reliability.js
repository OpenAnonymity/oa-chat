// Client recovery policy, not provider guarantees. Heartbeats prove transport
// activity, not generation progress. All state stays in this browser.
export const INFERENCE_TIMING = Object.freeze({
    warningMs: 45000, connectionMs: 120000, idleMs: 180000,
    outputMs: 600000, pollMs: 1000
});

export function inferenceError(code, message) {
    return Object.assign(new Error(message), { code, retryable: false, isStreamError: true });
}

export function waitForSignal(operation, signal) {
    if (!signal) return Promise.resolve(operation);
    return new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason || new DOMException('Request stopped', 'AbortError'));
        if (signal.aborted) {
            Promise.resolve(operation).catch(() => {});
            aborted();
            return;
        }
        signal.addEventListener('abort', aborted, { once: true });
        Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
}

export function discardResponseBody(body) {
    // A broken relay's cancel promise must not block error reporting or retry.
    try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* already locked/closed */ }
}

export function createInferenceWatchdog({ signal, onHealth, timing = {}, now = Date.now } = {}) {
    const policy = { ...INFERENCE_TIMING, ...timing };
    const controller = new AbortController();
    const started = now();
    let activityAt = started, outputAt = started, opened = false, health = null;
    const publish = value => {
        if (value?.kind === health?.kind) return;
        health = value;
        try { onHealth?.(value); } catch { /* status UI cannot break transport */ }
    };
    const abort = () => controller.abort(signal.reason || new DOMException('Request stopped', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setInterval(() => {
        if (controller.signal.aborted) return;
        const elapsed = now() - started, silence = now() - activityAt;
        let error;
        if (!opened && elapsed >= policy.connectionMs) {
            error = inferenceError('INFERENCE_CONNECTION_TIMEOUT', 'The provider did not open a response in time. Please retry.');
        } else if (opened && silence >= policy.idleMs) {
            error = inferenceError('INFERENCE_IDLE_TIMEOUT', 'The response timed out after prolonged silence. Provider progress is unknown. Any partial answer has been kept. Please retry.');
        } else if (opened && now() - outputAt >= policy.outputMs) {
            error = inferenceError('INFERENCE_OUTPUT_TIMEOUT', 'The connection stayed open but no model output arrived for 10 minutes. Please retry.');
        }
        if (error) controller.abort(error);
        else if (silence >= policy.warningMs) publish({ kind: 'silence', message: 'Taking longer than usual. No data received for 45 seconds; still waiting for a response.' });
    }, policy.pollMs);
    return {
        signal: controller.signal,
        wait: operation => waitForSignal(operation, controller.signal),
        opened() { opened = true; activityAt = now(); outputAt = now(); publish(null); },
        activity() { activityAt = now(); publish(null); },
        output() { outputAt = now(); activityAt = outputAt; publish(null); },
        dispose() { clearInterval(timer); signal?.removeEventListener('abort', abort); publish(null); }
    };
}

export function isRetryableInferenceError(error) {
    if (error?.retryable === false || error?.isCancelled || error?.name === 'AbortError' || error?.isStreamError) return false;
    if (error?.status) return [408, 429, 500, 502, 503, 504].includes(Number(error.status));
    return error?.name === 'TypeError' || /Failed to fetch|NetworkError/i.test(error?.message || '');
}

export async function readInferenceErrorBody(response, signal) {
    if (!response.body?.getReader) return waitForSignal(response.json().catch(() => ({})), signal);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
        while (text.length < 65536) {
            const { done, value } = await waitForSignal(reader.read(), signal);
            if (done) break;
            text += decoder.decode(value, { stream: true });
        }
        try { return JSON.parse(text + decoder.decode()); } catch { return {}; }
    } finally {
        discardResponseBody(reader);
        reader.releaseLock();
    }
}
