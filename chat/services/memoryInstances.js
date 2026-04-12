import { createMemoryBank } from '../nanomem/browser.js';

const unsupportedMemoryEditorLlmClient = {
    async createChatCompletion() {
        throw new Error('Memory editor storage instance does not support LLM operations.');
    },
    async streamChatCompletion() {
        throw new Error('Memory editor storage instance does not support LLM operations.');
    }
};

const memoryBank = createMemoryBank({
    storage: 'indexeddb',
    llmClient: unsupportedMemoryEditorLlmClient,
    model: 'gpt-4o-mini'
});

const memoryFileSystem = {
    init: () => memoryBank.init(),
    read: (path) => memoryBank.storage.read(path),
    write: (path, content) => memoryBank.storage.write(path, content),
    delete: (path) => memoryBank.storage.delete(path),
    exists: (path) => memoryBank.storage.exists(path),
    search: (query) => memoryBank.storage.search(query),
    ls: (dirPath) => memoryBank.storage.ls(dirPath),
    getTree: () => memoryBank.storage.getTree(),
    rebuildTree: () => memoryBank.storage.rebuildTree(),
    exportAll: async () => {
        const records = await memoryBank.storage.exportAll();
        return records.map((record) => ({
            ...record,
            l0: record.oneLiner || ''
        }));
    },
    clear: () => memoryBank.storage.clear()
};

export default memoryFileSystem;
export { memoryBank, memoryFileSystem };
