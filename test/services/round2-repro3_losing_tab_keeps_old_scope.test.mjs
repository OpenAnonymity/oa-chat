// Repro 3: two tabs load at once (session restore) on a browser holding a
// previous-version record. Tab W releases it first. In this tab (L) a
// pre-configure preference read had already picked the old account as data
// scope (the case previousVersionAccountRelease.test.js covers for ONE tab).
// L's own release then finds the record gone and returns false, so the
// "drop that scope and notify" branch is skipped: L's wallet bootstraps under
// the forgotten account's scope.
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatDB } from '../../chat/db.js';
import { default as accountService } from '../../chat/services/accountService.js';
import { default as syncService } from '../../chat/services/encryptedSyncService.js';

const OLD_RECORD = Object.freeze({ accountId: 'K7M39QX2HT4PW8LD', credentialId: 'b2xk', recoveryConfirmed: true, updatedAt: 1788000000000 });

test('the tab that loses release drops its forgotten wallet scope', async () => {
    const settings = new Map(Object.entries({ 'account-settings': OLD_RECORD, 'tickets-active': [{ finalized_ticket: 'old-1' }] }));
    let settingsReads = 0;
    chatDB.db = {};
    chatDB.init = async () => {};
    chatDB.getSetting = async key => {
        const value = settings.get(key);
        if (key === 'account-settings' && ++settingsReads === 2) {
            // Read #1: the pre-configure scope read. Read #2: this tab's
            // release check. Right after it, the other tab's release commits.
            settings.delete('account-settings');
        }
        return value;
    };
    chatDB.deleteSettingsIfUnchanged = async (expected, deletes) => {
        if (expected.some(({ key, value }) => JSON.stringify(settings.get(key) ?? null) !== JSON.stringify(value ?? null))) return false;
        deletes.forEach(k => settings.delete(k));
        return true;
    };
    const events = [];
    syncService.subscribe(p => events.push(p.event));

    syncService.localScopeAccountId = null;
    assert.equal(await syncService.bootstrapLocalAccountScope(), OLD_RECORD.accountId, 'pre-configure read');
    accountService.configure({ releasePreviousVersionAccounts: true });

    const walletScope = await syncService.bootstrapLocalAccountScope();   // ticketStore.init()
    console.log({ walletScope, settingsLeft: [...settings.keys()], released: accountService.releasedPreviousVersionAccount, events });
    assert.equal(settings.has('account-settings'), false, 'the record is gone (the other tab released it)');
    assert.equal(walletScope, null, 'losing tab drops forgotten scope');
    assert.ok(events.includes('account_scope_changed'), 'stores reopen under current scope');
});
