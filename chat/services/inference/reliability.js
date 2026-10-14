// Client recovery policy, not provider guarantees. Heartbeats prove transport
// activity, not generation progress. All state stays in this browser.
export const INFERENCE_TIMING = Object.freeze({
    // idleMs: no byte at all, heartbeats included, for this long means the
    // stream is dead (routers send keep-alives while a model thinks), so
    // the turn ends instead of showing a "still waiting" line.
    warningMs: 45000, connectionMs: 120000, idleMs: 45000,
    outputMs: 600000, tailMs: 5000, pollMs: 1000
});

export function inferenceError(code, message) {
    return Object.assign(new Error(message), { code, retryable: false, isStreamError: true });
}

export function waitForSignal(operation, signal) {
    if (!signal) return Promise.resolve(operation);
    return new Promise((resolve, reject) => {
        const aborted = () => {
            signal.removeEventListener('abort', aborted);
            reject(signal.reason || new DOMException('Request stopped', 'AbortError'));
        };
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
    // Set once the provider has confirmed completion (a finish reason). From
    // then on the connection is only kept for its tail (usage, [DONE]); a
    // provider that confirms completion but keeps the socket open with
    // heartbeats must not hold the chat for the whole output deadline.
    let finishedAt = null, settleTail, settled;
    const resetTail = () => { settled = new Promise(resolve => { settleTail = resolve; }); };
    resetTail();
    const tailExpired = () => finishedAt !== null && now() - finishedAt >= policy.tailMs;
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
        if (tailExpired()) settleTail();
        let error;
        if (!opened && elapsed >= policy.connectionMs) {
            error = inferenceError('INFERENCE_CONNECTION_TIMEOUT', 'The provider did not open a response in time. Please retry.');
        } else if (opened && silence >= policy.idleMs) {
            error = inferenceError('INFERENCE_IDLE_TIMEOUT', 'The provider stopped responding.');
        } else if (opened && now() - outputAt >= policy.outputMs) {
            error = inferenceError('INFERENCE_OUTPUT_TIMEOUT', 'The connection stayed open but no model output arrived for 10 minutes. Please retry.');
        }
        if (error) controller.abort(error);
        else if (silence >= policy.warningMs && policy.warningMs < policy.idleMs) {
            publish({ kind: 'silence', message: 'Taking longer than usual. Still waiting for a response.' });
        }
    }, policy.pollMs);
    return {
        signal: controller.signal,
        // Resolves when the tail after a confirmed finish has lapsed; the
        // transport then stops reading and the stream finalizes as complete.
        get settled() { return finishedAt === null ? null : settled; },
        tailExpired,
        wait: operation => waitForSignal(operation, controller.signal),
        opened() { opened = true; activityAt = now(); outputAt = now(); publish(null); },
        activity() { activityAt = now(); publish(null); },
        // Output after a finish reason means the finish was not final: the
        // tail is disarmed until the provider confirms completion again.
        output() {
            outputAt = now(); activityAt = outputAt;
            if (finishedAt !== null) { finishedAt = null; resetTail(); }
            publish(null);
        },
        finished() { if (finishedAt === null) finishedAt = now(); },
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
