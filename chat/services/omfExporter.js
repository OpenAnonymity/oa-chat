import { memoryBank } from './memoryInstances.js';
import { saveWithConfirmation } from './globalExport.js';

function createAbortError() {
    const error = new Error('Request aborted');
    error.name = 'AbortError';
    error.isCancelled = true;
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

export async function buildOmfExport(options = {}) {
    const { signal = null } = options || {};
    throwIfAborted(signal);
    await memoryBank.init({ signal });
    throwIfAborted(signal);
    const result = await memoryBank.exportOmf({ signal });
    throwIfAborted(signal);
    return result;
}

export async function exportMemoriesAsOmf(options = {}) {
    const { signal = null } = options || {};
    const omfDoc = await buildOmfExport({ signal });
    throwIfAborted(signal);
    const jsonString = JSON.stringify(omfDoc, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const filename = `memories-${new Date().toISOString().replace(/[:.]/g, '-')}.omf.json`;
    throwIfAborted(signal);
    const result = await saveWithConfirmation(blob, filename);
    throwIfAborted(signal);
    return result;
}
