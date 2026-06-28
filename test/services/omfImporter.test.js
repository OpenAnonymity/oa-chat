import test from 'node:test';
import assert from 'node:assert/strict';

test('importOmf honors an already-aborted signal before initializing memory storage', async () => {
    const [{ importOmf }, { memoryBank }] = await Promise.all([
        import('../../chat/services/omfImporter.js'),
        import('../../chat/services/memoryInstances.js')
    ]);

    const originalInit = memoryBank.init;
    const originalImportOmf = memoryBank.importOmf;
    let initCalls = 0;
    let importCalls = 0;
    memoryBank.init = async () => {
        initCalls += 1;
    };
    memoryBank.importOmf = async () => {
        importCalls += 1;
        return {};
    };

    const controller = new AbortController();
    controller.abort();

    try {
        await assert.rejects(
            () => importOmf({ version: '1.0', memories: [] }, { signal: controller.signal }),
            (error) => error?.name === 'AbortError'
        );

        assert.equal(initCalls, 0);
        assert.equal(importCalls, 0);
    } finally {
        memoryBank.init = originalInit;
        memoryBank.importOmf = originalImportOmf;
    }
});
