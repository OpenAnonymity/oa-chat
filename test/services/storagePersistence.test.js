import test from 'node:test';
import assert from 'node:assert/strict';
import storageManager from '../../chat/services/storageManager.js';

// Persistent-storage status is read and kept on this device only; nothing is
// sent anywhere. These tests replace navigator.storage with a stub.

function stubStorage(t, { persisted = false, grant = false } = {}) {
    const calls = { persisted: 0, persist: 0 };
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const previousWindow = globalThis.window;
    const state = { persisted, grant };
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            storage: {
                persisted: async () => { calls.persisted += 1; return state.persisted; },
                persist: async () => { calls.persist += 1; if (state.grant) state.persisted = true; return state.grant; }
            }
        }
    });
    globalThis.window = new EventTarget();
    const saved = {
        persistence: storageManager.persistence,
        installListenerAdded: storageManager.installListenerAdded
    };
    storageManager.persistence = null;
    storageManager.installListenerAdded = false;
    t.after(() => {
        if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
        else delete globalThis.navigator;
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
        Object.assign(storageManager, saved);
    });
    return { calls, state };
}

test('a declined request is remembered as not persistent', async t => {
    const { calls } = stubStorage(t, { persisted: false, grant: false });
    assert.equal(storageManager.getPersistence(), null);
    assert.equal(await storageManager.ensurePersistentStorage(), false);
    assert.equal(storageManager.getPersistence(), false);
    assert.equal(calls.persist, 1);
});

test('an existing grant is read without asking again', async t => {
    const { calls } = stubStorage(t, { persisted: true });
    assert.equal(await storageManager.ensurePersistentStorage(), true);
    assert.equal(storageManager.getPersistence(), true);
    assert.equal(calls.persist, 0);
});

test('refreshing reads the current grant and never requests one', async t => {
    const { calls, state } = stubStorage(t, { persisted: false });
    assert.equal(await storageManager.refreshPersistence(), false);
    state.persisted = true;
    assert.equal(await storageManager.refreshPersistence(), true);
    assert.equal(storageManager.getPersistence(), true);
    assert.equal(calls.persist, 0);
});

test('installing the app asks once more, and only when not already persistent', async t => {
    const { calls } = stubStorage(t, { persisted: false, grant: true });
    storageManager.persistence = false;
    storageManager.listenForInstall();
    globalThis.window.dispatchEvent(new Event('appinstalled'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.persist, 1);
    assert.equal(storageManager.getPersistence(), true);

    globalThis.window.dispatchEvent(new Event('appinstalled'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.persist, 1);
});

test('browsers without the Storage API report unknown, not declined', async t => {
    stubStorage(t);
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    assert.equal(await storageManager.ensurePersistentStorage(), false);
    assert.equal(storageManager.getPersistence(), null);
    assert.equal(await storageManager.refreshPersistence(), null);
});
