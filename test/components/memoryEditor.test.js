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

test('unsupported payment mode blocks Memory editor and backfill without accessing storage or keys', async () => {
    installMemoryEditorDocumentStub();
    const [{ default: MemoryEditor }, { default: memoryFileSystem }] = await Promise.all([
        import('../../chat/components/MemoryEditor.js'),
        import('../../chat/services/memoryInstances.js')
    ]);
    const originalInit = memoryFileSystem.init;
    let initCalls = 0;
    let ticketOperations = 0;
    const toasts = [];
    memoryFileSystem.init = async () => { initCalls += 1; };
    try {
        const editor = new MemoryEditor({
            memoryFeatureEnabled: true,
            supportsFeature: () => false,
            getFeatureUnavailableReason: () => 'Memory needs a separate ticket key.',
            beginFeatureOperation: () => { ticketOperations += 1; },
            showToast: message => toasts.push(message)
        });
        assert.equal(await editor.open(), false);
        await editor._startBackfill();
        assert.equal(initCalls, 0);
        assert.equal(ticketOperations, 0);
        assert.ok(toasts.every(message => message === 'Memory needs a separate ticket key.'));
    } finally {
        memoryFileSystem.init = originalInit;
    }
});

test('backfill reserves its captured owner before scanning and keeps the reservation after closing', async () => {
    installMemoryEditorDocumentStub();
    const { default: MemoryEditor } = await import('../../chat/components/MemoryEditor.js');
    const owner = { id: 'ticket-owner', inferenceBackend: 'openrouter' };
    let finishCalls = 0;
    let resolveCandidates;
    const candidates = new Promise(resolve => { resolveCandidates = resolve; });
    const controller = new AbortController();
    const operation = { controller, signal: controller.signal, sessionId: owner.id };
    const editor = new MemoryEditor({
        memoryFeatureEnabled: true,
        getCurrentSession: () => owner,
        beginFeatureOperation(feature, session) {
            assert.equal(feature, 'memory');
            assert.equal(session, owner);
            return operation;
        },
        finishFeatureOperation(actual) { assert.equal(actual, operation); finishCalls += 1; },
        showToast() {}
    });
    editor.isOpen = true;
    editor._collectBackfillCandidates = () => candidates;
    const work = editor._startBackfill();
    assert.equal(editor.backfillState, 'running');
    editor.close();
    assert.equal(editor.backfillState, 'running');
    assert.equal(controller.signal.aborted, false);
    assert.equal(finishCalls, 0);
    resolveCandidates([]);
    await work;
    assert.equal(finishCalls, 1);
    assert.equal(editor.backfillState, null);
});

test('export and import work with Memory off; everything else in the editor still refuses', async () => {
    installDocumentStub();
    const [{ default: MemoryEditor }] = await Promise.all([import('../../chat/components/MemoryEditor.js')]);
    const toasts = [];
    const app = { memoryFeatureEnabled: false, showToast(message) { toasts.push(message); } };
    const editor = new MemoryEditor(app);

    // A plain operation refuses and says why.
    assert.equal(editor._beginMemoryOperation(), null);
    assert.deepEqual(toasts, ['Memory is off in settings.']);
    assert.equal(await editor.open(), false);

    // Moving memories in or out is allowed: the store is the person's data.
    const operation = editor._beginMemoryOperation({ allowWhileOff: true });
    assert.ok(operation);
    assert.equal(editor._isMemoryOperationActive(operation), true);
    assert.doesNotThrow(() => editor._assertMemoryOperationActive(operation));
    // Turning the feature off mid-way (a new generation) still aborts it.
    editor.handleMemoryFeatureDisabled();
    assert.equal(editor._isMemoryOperationActive(operation), false);
});
