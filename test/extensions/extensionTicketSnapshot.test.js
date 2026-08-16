import test from 'node:test';
import assert from 'node:assert/strict';

import { toExtensionTicketSnapshot } from '../../chat/extensions/extensionTicketSnapshot.js';

test('signed-in ticket counts are not billing-ready before encrypted sync', () => {
    const pending = toExtensionTicketSnapshot(
        { ticketCount: 0, maxShareCount: 0, busy: false, tickets: ['secret'] },
        {
            accountId: 'account-123',
            sessionVerified: true,
            status: 'unlocked',
            accountScopeReady: true,
            ticketSyncReady: false
        }
    );
    assert.deepEqual(pending, {
        ticketCount: 0,
        maxShareCount: 0,
        busy: false,
        readyForAutomaticBilling: false
    });
    assert.equal('tickets' in pending, false);

    const ready = toExtensionTicketSnapshot(
        { ticketCount: 8, maxShareCount: 8, busy: false },
        {
            accountId: 'account-123',
            sessionVerified: true,
            status: 'unlocked',
            accountScopeReady: true,
            ticketSyncReady: true
        }
    );
    assert.equal(ready.readyForAutomaticBilling, true);
});

test('anonymous ticket counts become billing-ready after local storage initialization', () => {
    assert.equal(toExtensionTicketSnapshot(
        { ticketCount: 0, maxShareCount: 0, busy: false },
        { accountId: null }
    ).readyForAutomaticBilling, true);
});
