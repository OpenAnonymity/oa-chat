const BRIDGE_NAME = 'oaAndroidInferenceNative';

function getBridge() {
    if (typeof window === 'undefined') return null;
    const bridge = window[BRIDGE_NAME];
    if (!bridge) return null;
    return bridge;
}

function parseJsonResult(rawResult) {
    if (rawResult == null) {
        return null;
    }

    try {
        return JSON.parse(String(rawResult));
    } catch (error) {
        console.error('Failed to parse Android native inference payload:', error, rawResult);
        return null;
    }
}

export function isAndroidNativeInferenceAvailable() {
    return !!getBridge();
}

export function startAndroidNativeInferenceJob(request) {
    const bridge = getBridge();
    if (!bridge || typeof bridge.startJob !== 'function') {
        throw new Error('Android native inference bridge is unavailable.');
    }

    const result = parseJsonResult(bridge.startJob(JSON.stringify(request)));
    if (!result) {
        throw new Error('Android native inference bridge returned an invalid start response.');
    }
    if (result.error) {
        throw new Error(result.error);
    }
    if (!result.jobId) {
        throw new Error('Android native inference bridge did not return a job id.');
    }
    return result;
}

export function pollAndroidNativeInferenceJob(jobId, afterSequence) {
    const bridge = getBridge();
    if (!bridge || typeof bridge.pollEvents !== 'function') {
        throw new Error('Android native inference bridge is unavailable.');
    }

    const result = parseJsonResult(
        bridge.pollEvents(
            JSON.stringify({
                jobId,
                afterSequence,
            })
        )
    );

    if (!result) {
        throw new Error('Android native inference bridge returned an invalid poll response.');
    }
    if (result.error) {
        throw new Error(result.error);
    }

    return {
        events: Array.isArray(result.events) ? result.events : [],
        terminal: result.terminal === true,
    };
}

export function cancelAndroidNativeInferenceJob(jobId) {
    const bridge = getBridge();
    if (!bridge || typeof bridge.cancelJob !== 'function') {
        return;
    }

    const rawResult = bridge.cancelJob(
        JSON.stringify({
            jobId,
        })
    );
    const result = parseJsonResult(rawResult);
    if (result?.error) {
        throw new Error(result.error);
    }
}
