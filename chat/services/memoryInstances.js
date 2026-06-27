const unsupportedMemoryEditorLlmClient = {
    async createChatCompletion() {
        throw new Error('Memory editor storage instance does not support LLM operations.');
    },
    async streamChatCompletion() {
        throw new Error('Memory editor storage instance does not support LLM operations.');
    }
};

let memoryBankInstance = null;
let nanomemBrowserModulePromise = null;

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

async function runAbortable(operation, options = {}) {
    const { signal = null } = options || {};
    throwIfAborted(signal);
    const result = await operation(signal);
    throwIfAborted(signal);
    return result;
}

async function loadNanomemBrowser(signal = null) {
    throwIfAborted(signal);
    nanomemBrowserModulePromise ||= import('../nanomem/browser.js');
    const module = await nanomemBrowserModulePromise;
    throwIfAborted(signal);
    return module;
}

async function getMemoryBank(signal = null) {
    throwIfAborted(signal);
    if (!memoryBankInstance) {
        const { createMemoryBank } = await loadNanomemBrowser(signal);
        throwIfAborted(signal);
        memoryBankInstance = createMemoryBank({
            storage: 'indexeddb',
            llmClient: unsupportedMemoryEditorLlmClient,
            model: 'gpt-4o-mini'
        });
    }
    throwIfAborted(signal);
    return memoryBankInstance;
}

async function withMemoryBank(signal, operation) {
    const bank = await getMemoryBank(signal);
    throwIfAborted(signal);
    const result = await operation(bank);
    throwIfAborted(signal);
    return result;
}

const memoryBank = {
    init: async (options = {}) => withMemoryBank(options?.signal, (bank) => bank.init()),
    pruneExpired: async (options = {}) => withMemoryBank(options?.signal, (bank) => bank.pruneExpired()),
    exportOmf: async (options = {}) => withMemoryBank(options?.signal, (bank) => bank.exportOmf()),
    previewOmfImport: async (doc, options = {}) => withMemoryBank(options?.signal, (bank) => bank.previewOmfImport(doc, options)),
    importOmf: async (doc, options = {}) => withMemoryBank(options?.signal, (bank) => bank.importOmf(doc, options)),
    storage: {
        read: async (path, options = {}) => withMemoryBank(options?.signal, (bank) => bank.storage.read(path)),
        write: async (path, content, options = {}) => withMemoryBank(options?.signal, (bank) => bank.storage.write(path, content)),
        delete: async (path, options = {}) => withMemoryBank(options?.signal, (bank) => bank.storage.delete(path)),
        exists: async (path, options = {}) => withMemoryBank(options?.signal, (bank) => bank.storage.exists(path)),
        search: async (query, options = {}) => withMemoryBank(options?.signal, (bank) => bank.storage.search(query)),
        ls: async (dirPath, options = {}) => withMemoryBank(options?.signal, (bank) => bank.storage.ls(dirPath)),
        getTree: async (options = {}) => withMemoryBank(options?.signal, (bank) => bank.storage.getTree()),
        rebuildTree: async (options = {}) => withMemoryBank(options?.signal, (bank) => bank.storage.rebuildTree()),
        exportAll: async (options = {}) => withMemoryBank(options?.signal, (bank) => bank.storage.exportAll()),
        clear: async (options = {}) => withMemoryBank(options?.signal, (bank) => bank.storage.clear())
    }
};

const memoryFileSystem = {
    init: (options = {}) => runAbortable((signal) => memoryBank.init({ signal }), options),
    read: (path, options = {}) => runAbortable((signal) => memoryBank.storage.read(path, { signal }), options),
    write: (path, content, options = {}) => runAbortable((signal) => memoryBank.storage.write(path, content, { signal }), options),
    delete: (path, options = {}) => runAbortable((signal) => memoryBank.storage.delete(path, { signal }), options),
    exists: (path, options = {}) => runAbortable((signal) => memoryBank.storage.exists(path, { signal }), options),
    search: (query, options = {}) => runAbortable((signal) => memoryBank.storage.search(query, { signal }), options),
    ls: (dirPath, options = {}) => runAbortable((signal) => memoryBank.storage.ls(dirPath, { signal }), options),
    getTree: (options = {}) => runAbortable((signal) => memoryBank.storage.getTree({ signal }), options),
    rebuildTree: (options = {}) => runAbortable((signal) => memoryBank.storage.rebuildTree({ signal }), options),
    pruneExpired: (options = {}) => runAbortable((signal) => memoryBank.pruneExpired({ signal }), options),
    exportAll: async (options = {}) => {
        const { signal = null } = options || {};
        throwIfAborted(signal);
        const records = await memoryBank.storage.exportAll({ signal });
        throwIfAborted(signal);
        return records.map((record) => ({
            ...record,
            l0: record.oneLiner || ''
        }));
    },
    clear: (options = {}) => runAbortable((signal) => memoryBank.storage.clear({ signal }), options)
};

export default memoryFileSystem;
export { memoryBank, memoryFileSystem };
