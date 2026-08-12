import test from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapOAuthSession } from '../../chat/services/accountService.js';


test('OAuth popup handoff completes through the SDK before verifying and reading', async () => {
    const calls = [];
    const expectedSession = { accountId: 'OA-ACCOUNT' };
    const completionToken = 'x'.repeat(43);

    const result = await bootstrapOAuthSession('google', completionToken, {
        completeSession: async () => {
            calls.push('complete-session');
        },
        fetchSession: async () => {
            calls.push('fetch-session');
            return expectedSession;
        },
        verifySession: async () => {
            calls.push('verify-session');
            return true;
        }
    });

    assert.equal(result, expectedSession);
    assert.deepEqual(calls, [
        'complete-session',
        'verify-session',
        'fetch-session'
    ]);
});

test('OAuth popup handoff fails closed when the SDK marker is not installed', async () => {
    await assert.rejects(
        bootstrapOAuthSession('google', 'x'.repeat(43), {
            completeSession: async () => {},
            fetchSession: async () => ({ accountId: 'OA-ACCOUNT' }),
            verifySession: async () => false
        }),
        /Google session could not be established/
    );
});

test('OAuth popup handoff rejects malformed completion tokens before use', async () => {
    let completionCalls = 0;
    await assert.rejects(
        bootstrapOAuthSession('google', 'too-short', {
            completeSession: async () => {
                completionCalls += 1;
            }
        }),
        /Google sign in completion was invalid/
    );
    assert.equal(completionCalls, 0);

    await assert.rejects(
        bootstrapOAuthSession('google', 'é'.repeat(43), {
            completeSession: async () => {
                completionCalls += 1;
            }
        }),
        /Google sign in completion was invalid/
    );
    assert.equal(completionCalls, 0);
});
