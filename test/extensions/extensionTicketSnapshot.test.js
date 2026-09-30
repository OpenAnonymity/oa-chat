import test from 'node:test';
import assert from 'node:assert/strict';

import { toExtensionTicketSnapshot } from '../../chat/extensions/extensionTicketSnapshot.js';

test('signed-in ticket counts are not billing-ready before encrypted sync', () => {
    const pending = toExtensionTicketSnapshot(
        { ticketCount: 0, maxShareCount: 0, busy: false, tickets: ['secret'] },
        {
            accountId: 'account-123',
            isReady: true,
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
        movingTickets: 0,
        readyForAutomaticBilling: false
    });
    assert.equal('tickets' in pending, false);

    const ready = toExtensionTicketSnapshot(
        { ticketCount: 8, maxShareCount: 8, busy: false },
        {
            accountId: 'account-123',
            isReady: true,
            sessionVerified: true,
            status: 'unlocked',
            accountScopeReady: true,
            ticketSyncReady: true
        }
    );
    assert.equal(ready.readyForAutomaticBilling, true);
});

test('anonymous ticket counts become billing-ready after local storage initialization', () => {
    const tools = { ticketCount: 0, maxShareCount: 0, busy: false };
    assert.equal(
        toExtensionTicketSnapshot(tools, {
            accountId: null,
            isReady: false
        }).readyForAutomaticBilling,
        false
    );
    assert.equal(
        toExtensionTicketSnapshot(tools, {
            accountId: null,
            isReady: true
        }).readyForAutomaticBilling,
        true
    );
});

test('previous-version tickets reach extensions as a count only', () => {
    const snapshot = toExtensionTicketSnapshot(
        { ticketCount: 541, maxShareCount: 50, busy: true, movingTickets: 541, tickets: ['secret'] },
        { accountId: null, isReady: true }
    );
    assert.equal(snapshot.movingTickets, 541);
    assert.equal(toExtensionTicketSnapshot({ movingTickets: -3 }, {}).movingTickets, 0);
    assert.equal(toExtensionTicketSnapshot({ movingTickets: 'x' }, {}).movingTickets, 0);
    assert.equal('tickets' in snapshot, false);
});
