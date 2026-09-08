import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { toExtensionTicketSnapshot } from '../../chat/extensions/extensionTicketSnapshot.js';

// Log out empties the wallet on this device (the account scope is
// deactivated, the ticket store reloads as empty). Extensions that watch the
// wallet must already see the account as not billable when that happens,
// otherwise an "empty, verified" wallet opens the welcome dialog for a frame
// before the host leaves for /login.
test('logout marks the session unverified before the sync data is cleared', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'chat/services/accountService.js'), 'utf8');
    const start = source.indexOf('    async logout() {');
    assert.ok(start > -1);
    const body = source.slice(start, source.indexOf('\n    }\n', start));
    const flagsAt = body.indexOf('this.state.sessionVerified = false;');
    const notifyAt = body.indexOf('this.notify();');
    const signOutAt = body.indexOf('sessionService.signOut()');
    const clearAt = body.indexOf('syncService.deactivateAccountScope(');
    assert.ok(flagsAt > -1 && notifyAt > -1 && signOutAt > -1 && clearAt > -1);
    assert.ok(flagsAt < notifyAt && notifyAt < signOutAt && signOutAt < clearAt);
    assert.ok(body.indexOf('this.state.accountScopeReady = false;') < signOutAt);
    assert.ok(body.indexOf('this.state.ticketSyncReady = false;') < signOutAt);
});

test('an emptied wallet is not billable once the session is no longer verified', () => {
    const account = {
        isReady: true, accountId: 'a', status: 'unlocked',
        sessionVerified: false, accountScopeReady: false, ticketSyncReady: false
    };
    const snapshot = toExtensionTicketSnapshot({ ticketCount: 0, maxShareCount: 0, busy: false }, account);
    assert.equal(snapshot.readyForAutomaticBilling, false);
});
