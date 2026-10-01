import test from 'node:test';
import assert from 'node:assert/strict';

test('full backup round-trips the OpenZoo leCore switch', async () => {
    const originalDocument = globalThis.document;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const { chatDB } = await import('../../chat/db.js');
    const { default: preferencesStore } = await import('../../chat/services/preferencesStore.js');
    const { exportAllData } = await import('../../chat/services/globalExport.js');
    const { importFromFile } = await import('../../chat/services/globalImport.js');
    const originalDb = chatDB.db;
    const originalMethods = Object.fromEntries(['getSetting', 'saveSetting', 'getAllSessions',
        'getSessionMessages', 'collectImportedSessionKeys']
        .map(key => [key, chatDB[key]]));
    const originalPreferenceGetter = preferencesStore.getPreference;
    let exportedBlob;
    const settings = new Map([['openZooLeCoreContextRecallEnabled', true]]);
    try {
        chatDB.db = {};
        chatDB.getSetting = async key => settings.get(key);
        chatDB.saveSetting = async (key, value) => { settings.set(key, value); };
        chatDB.getAllSessions = async () => [];
        chatDB.getSessionMessages = async () => [];
        chatDB.collectImportedSessionKeys = async () => new Set();
        preferencesStore.getPreference = async () => undefined;
        globalThis.document = {
            body: { appendChild() {}, removeChild() {} },
            createElement: () => ({ click() {} })
        };
        URL.createObjectURL = blob => { exportedBlob = blob; return 'blob:oa-backup'; };
        URL.revokeObjectURL = () => {};

        assert.equal(await exportAllData(), true);
        const payload = JSON.parse(await exportedBlob.text());
        assert.equal(payload.data.preferences.openZooLeCoreContextRecallEnabled, true);
        settings.clear();
        const result = await importFromFile({ text: async () => JSON.stringify(payload) });
        assert.equal(result.success, true);
        assert.ok(result.summary.appliedPreferences.includes('openZooLeCoreContextRecallEnabled'));
        assert.equal(settings.get('openZooLeCoreContextRecallEnabled'), true);
    } finally {
        chatDB.db = originalDb;
        Object.assign(chatDB, originalMethods);
        preferencesStore.getPreference = originalPreferenceGetter;
        globalThis.document = originalDocument;
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
    }
});
