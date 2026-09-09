import assert from 'node:assert/strict';
import test from 'node:test';

import accountService, { ACCOUNT_SIGNED_OUT_EVENT } from '../../chat/services/accountService.js';
import storageEvents from '../../chat/services/storageEvents.js';

// Tabs of one browser share the ticket store through storage events but not
// the account object. A logout announces itself, and a tab holding the same
// account treats the news exactly as an expired session.
test('logging out in one tab tells the others, which drop the session for that account only', async () => {
    const originals = {
        state: { ...accountService.state },
        broadcast: storageEvents.broadcast,
        init: storageEvents.init,
        handleTokenInvalidation: accountService.handleTokenInvalidation,
        unsubscribe: accountService.signOutElsewhereUnsubscribe
    };
    const sent = [];
    let invalidated = 0;
    try {
        storageEvents.init = () => {};
        storageEvents.broadcast = (type, payload) => sent.push({ type, payload });
        accountService.handleTokenInvalidation = async () => { invalidated += 1; };
        accountService.signOutElsewhereUnsubscribe = null;

        accountService.state.accountId = 'acct-1';
        accountService.broadcastSignedOut();
        assert.deepEqual(sent, [{ type: ACCOUNT_SIGNED_OUT_EVENT, payload: { accountId: 'acct-1' } }]);

        accountService.state.accountId = null;
        accountService.broadcastSignedOut();
        assert.equal(sent.length, 1, 'nothing to announce without an account');

        // The other tab: same account, verified → invalidated; other account or already signed out → untouched.
        accountService.listenForSignOutElsewhere();
        const handlers = [...(storageEvents.handlers.get(ACCOUNT_SIGNED_OUT_EVENT) || [])];
        assert.equal(handlers.length, 1);
        const deliver = payload => handlers.forEach(fn => fn(payload));

        accountService.state.accountId = 'acct-1';
        accountService.state.sessionVerified = true;
        accountService.state.status = 'unlocked';
        deliver({ accountId: 'acct-2' });
        assert.equal(invalidated, 0);
        deliver({ accountId: 'acct-1' });
        assert.equal(invalidated, 1);

        accountService.state.sessionVerified = false;
        accountService.state.status = 'locked';
        deliver({ accountId: 'acct-1' });
        assert.equal(invalidated, 1, 'already signed out here');
    } finally {
        accountService.signOutElsewhereUnsubscribe?.();
        accountService.signOutElsewhereUnsubscribe = originals.unsubscribe;
        accountService.handleTokenInvalidation = originals.handleTokenInvalidation;
        storageEvents.broadcast = originals.broadcast;
        storageEvents.init = originals.init;
        Object.assign(accountService.state, originals.state);
    }
});
