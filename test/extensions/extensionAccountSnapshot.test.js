import test from 'node:test';
import assert from 'node:assert/strict';
import { toExtensionAccountSnapshot } from '../../chat/extensions/extensionAccountSnapshot.js';

test('extension account snapshots expose only the documented non-secret fields', () => {
    const snapshot = toExtensionAccountSnapshot({
        isReady: true,
        accountId: 'account-123',
        sessionVerified: true,
        accountScopeReady: true,
        ticketSyncReady: true,
        status: 'unlocked',
        credentialId: 'secret-credential',
        recoveryCode: 'secret-recovery-code',
        recoveryRequired: true,
        error: 'internal error'
    });

    assert.deepEqual(snapshot, {
        isReady: true,
        accountId: 'account-123',
        sessionVerified: true,
        accountScopeReady: true,
        ticketSyncReady: true,
        status: 'unlocked'
    });
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal('credentialId' in snapshot, false);
    assert.equal('recoveryCode' in snapshot, false);
    assert.equal('error' in snapshot, false);
});
