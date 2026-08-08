import { memoryBank } from './memoryInstances.js';

const SUPPORTED_OMF_VERSIONS = ['1.0'];

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

async function runAbortable(operation, signal) {
    throwIfAborted(signal);
    const result = await operation();
    throwIfAborted(signal);
    return result;
}

function createAbortableStorage(signal) {
    const storage = memoryBank.storage;
    return {
        read: (path) => runAbortable(() => storage.read(path, { signal }), signal),
        write: (path, content) => runAbortable(() => storage.write(path, content, { signal }), signal),
        delete: (path) => runAbortable(() => storage.delete(path, { signal }), signal),
        exists: (path) => runAbortable(() => storage.exists(path, { signal }), signal),
        search: (query) => runAbortable(() => storage.search(query, { signal }), signal),
        ls: (dirPath) => runAbortable(() => storage.ls(dirPath, { signal }), signal),
        getTree: () => runAbortable(() => storage.getTree({ signal }), signal),
        rebuildTree: () => runAbortable(() => storage.rebuildTree({ signal }), signal),
        exportAll: () => runAbortable(() => storage.exportAll({ signal }), signal),
        clear: () => runAbortable(() => storage.clear({ signal }), signal)
    };
}

async function loadNanomemBrowser() {
    return import('../nanomem/browser.js');
}

export function validateOmf(doc) {
    if (!doc || typeof doc !== 'object') {
        return { valid: false, error: 'Not a valid JSON object' };
    }
    if (!doc.omf) {
        return { valid: false, error: 'Missing "omf" version field. Is this an OMF file?' };
    }
    if (!SUPPORTED_OMF_VERSIONS.includes(String(doc.omf))) {
        return {
            valid: false,
            error: `Unsupported OMF version "${doc.omf}". Supported: ${SUPPORTED_OMF_VERSIONS.join(', ')}`
        };
    }
    if (!Array.isArray(doc.memories)) {
        return { valid: false, error: 'Missing or invalid "memories" array' };
    }
    for (let index = 0; index < doc.memories.length; index += 1) {
        const memory = doc.memories[index];
        if (!memory || typeof memory !== 'object') {
            return { valid: false, error: `Memory item at index ${index} is not an object` };
        }
        if (!memory.content || typeof memory.content !== 'string' || !memory.content.trim()) {
            return { valid: false, error: `Memory item at index ${index} has empty or missing "content"` };
        }
    }
    return { valid: true };
}

export async function readOmfFile(file) {
    return JSON.parse(await file.text());
}

export async function previewOmfImport(doc, options = {}) {
    const { signal = null, ...importOptions } = options || {};
    throwIfAborted(signal);
    await memoryBank.init({ signal });
    throwIfAborted(signal);
    const { previewOmfImport: previewOmfImportWithStorage } = await loadNanomemBrowser();
    throwIfAborted(signal);
    return previewOmfImportWithStorage(createAbortableStorage(signal), doc, importOptions);
}

export async function importOmf(doc, options = {}) {
    const { signal = null, ...importOptions } = options || {};
    throwIfAborted(signal);
    await memoryBank.init({ signal });
    throwIfAborted(signal);
    const { importOmf: importOmfWithStorage } = await loadNanomemBrowser();
    throwIfAborted(signal);
    return importOmfWithStorage(createAbortableStorage(signal), doc, importOptions);
}
