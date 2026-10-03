import test from 'node:test';
import assert from 'node:assert/strict';
import { chatDB } from '../../chat/db.js';

test('a message this device cannot store fails with a plain reason, keeping the browser’s', async () => {
    const db = new chatDB.constructor();
    const transaction = { error: null, objectStore: () => ({ put: () => ({}) }) };
    db.db = { transaction: () => transaction };
    db.putSessionNotingOverwrite = () => {};
    const cause = Object.assign(new Error('Error preparing Blob/File data to be stored in object store'), { name: 'UnknownError' });
    const logged = [];
    const consoleError = console.error;
    console.error = (...args) => logged.push(args);
    try {
        const saving = db.saveSessionWithMessages({ id: 'chat' }, [{ id: 'message' }]);
        // The failed put reaches the transaction before the transaction has an error.
        transaction.onerror({ target: { error: cause } });
        transaction.onabort();
        await assert.rejects(saving, error => {
            assert.equal(error.message, 'This message could not be saved on this device. Please try again.');
            assert.equal(error.cause, cause);
            return true;
        });
    } finally {
        console.error = consoleError;
    }
    assert.equal(logged[0][1], cause, 'the reason is in the console for debugging');
});
