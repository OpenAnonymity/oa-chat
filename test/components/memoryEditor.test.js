import test from 'node:test';
import assert from 'node:assert/strict';

function installDocumentStub() {
    if (globalThis.document) return;
    globalThis.document = {
        activeElement: null,
        addEventListener() {},
        removeEventListener() {},
        getElementById() {
            return null;
        },
        createElement() {
            return {
                textContent: '',
                innerHTML: ''
            };
        }
    };
}

function installMemoryEditorDocumentStub() {
    const overlay = {
        classList: {
            add() {},
            remove() {}
        },
        innerHTML: '',
        onclick: null,
        querySelector() {
            return null;
        }
    };
    globalThis.document = {
        activeElement: null,
        addEventListener() {},
        removeEventListener() {},
        getElementById(id) {
            return id === 'memory-editor-modal' ? overlay : null;
        },
        createElement() {
            return {
                textContent: '',
                innerHTML: ''
            };
        }
    };
    return overlay;
}

test('memory editor open does not initialize storage when memory is disabled', async () => {
    installMemoryEditorDocumentStub();
    const [{ default: MemoryEditor }, { default: memoryFileSystem }] = await Promise.all([
        import('../../chat/components/MemoryEditor.js'),
        import('../../chat/services/memoryInstances.js')
    ]);

    const originalInit = memoryFileSystem.init;
    let initCalls = 0;
    memoryFileSystem.init = async () => {
        initCalls += 1;
    };

    try {
        const editor = new MemoryEditor({
            memoryFeatureEnabled: false,
            showToast() {}
        });

        const opened = await editor.open();

        assert.equal(opened, false);
        assert.equal(initCalls, 0);
    } finally {
        memoryFileSystem.init = originalInit;
    }
});

test('memory editor select file does not read storage when memory is disabled', async () => {
    installMemoryEditorDocumentStub();
    const [{ default: MemoryEditor }, { default: memoryFileSystem }] = await Promise.all([
        import('../../chat/components/MemoryEditor.js'),
        import('../../chat/services/memoryInstances.js')
    ]);

    const originalRead = memoryFileSystem.read;
    let readCalls = 0;
    memoryFileSystem.read = async () => {
        readCalls += 1;
        return '# Profile';
    };

    try {
        const editor = new MemoryEditor({
            memoryFeatureEnabled: false,
            showToast() {}
        });

        await editor._selectFile('personal/profile.md');

        assert.equal(readCalls, 0);
        assert.equal(editor.selectedPath, null);
    } finally {
        memoryFileSystem.read = originalRead;
    }
});

test('memory editor backfill cleanup does not refresh memory files when memory is disabled', async () => {
    installMemoryEditorDocumentStub();
    const { default: MemoryEditor } = await import('../../chat/components/MemoryEditor.js');

    const editor = new MemoryEditor({
        memoryFeatureEnabled: false,
        showToast() {}
    });
    let loadCalls = 0;
    editor._loadFileTree = async () => {
        loadCalls += 1;
    };

    await editor._refreshFilesAfterBackfillIfAllowed(true);

    assert.equal(loadCalls, 0);
});

test('memory editor backfill cleanup aborts if memory is disabled during refresh', async () => {
    installMemoryEditorDocumentStub();
    const [{ default: MemoryEditor }, { default: memoryFileSystem }] = await Promise.all([
        import('../../chat/components/MemoryEditor.js'),
        import('../../chat/services/memoryInstances.js')
    ]);

    const originalExportAll = memoryFileSystem.exportAll;
    let exportCalls = 0;
    let sawAbortSignal = false;

    try {
        const app = {
            memoryFeatureEnabled: true,
            showToast() {}
        };
        const editor = new MemoryEditor(app);
        editor.files = [{ path: 'personal/existing.md', l0: 'Existing' }];
        memoryFileSystem.exportAll = async (options = {}) => {
            exportCalls += 1;
            sawAbortSignal = !!options.signal;
            app.memoryFeatureEnabled = false;
            editor.handleMemoryFeatureDisabled();
            return [{ path: 'personal/new.md', oneLiner: 'New' }];
        };

        await editor._refreshFilesAfterBackfillIfAllowed(true);

        assert.equal(exportCalls, 1);
        assert.equal(sawAbortSignal, true);
        assert.deepEqual(editor.files, [{ path: 'personal/existing.md', l0: 'Existing' }]);
    } finally {
        memoryFileSystem.exportAll = originalExportAll;
    }
});

test('memory editor save does not write when memory is disabled before storage mutation', async () => {
    installDocumentStub();
    const [{ default: MemoryEditor }, { default: memoryFileSystem }] = await Promise.all([
        import('../../chat/components/MemoryEditor.js'),
        import('../../chat/services/memoryInstances.js')
    ]);

    const originalWrite = memoryFileSystem.write;
    let writeCalls = 0;
    memoryFileSystem.write = async () => {
        writeCalls += 1;
    };

    try {
        const app = {
            memoryFeatureEnabled: true,
            showToast() {}
        };
        const editor = new MemoryEditor(app);
        editor.selectedPath = 'personal/profile.md';
        editor.editorContent = '# Profile';
        editor.isDirty = true;

        let featureChecks = 0;
        editor._isMemoryFeatureEnabled = () => {
            featureChecks += 1;
            return featureChecks === 1;
        };

        await editor._saveFile();

        assert.equal(writeCalls, 0);
    } finally {
        memoryFileSystem.write = originalWrite;
    }
});
