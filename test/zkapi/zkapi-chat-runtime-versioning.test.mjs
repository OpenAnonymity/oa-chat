// The chat lifecycle core and the protocol-version facade: the near-expiry
// chat gate, the larger-key explanation and the busy registration. Everything
// fails open without a facade, so single-version behavior is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createZkapiChatRuntimeCore } from '../../chat/zkapi/services/zkapiChatRuntimeCore.mjs';

const SINGLE_VERSION_TEXT = n => `This model requires $${n} in private balance for a new key. Choose a lower-cap model, or withdraw the remaining balance and fund a larger one.`;

function harness({ versioning, client: clientOverrides = {}, budget = { spendingLimitUsd: 3 } } = {}) {
    const toasts = [];
    const calls = { funding: 0 };
    const client = {
        activeLease: null, hasNote: true, withdrawalBlocksChat: false, note: { current_balance: 2_900_000 },
        creditsPerUsd: 1_000_000, init: async () => {},
        subscribe: () => () => {}, settleActiveLease: async () => {}, hasPendingLease: async () => false,
        ...clientOverrides
    };
    const context = {
        getSession: () => null, saveSession: async () => {}, cancelSessionWork: async () => {},
        refreshPresentation: () => {}, logLocalEvent: () => {}, setProgress: () => {},
        openFunding: () => { calls.funding += 1; },
        showToast: (...args) => toasts.push(args)
    };
    const runtime = createZkapiChatRuntimeCore({
        client,
        backend: { id: 'private', requestAccess: async () => ({}) },
        modelConfiguration: { getDefaultModelConfig: () => ({}) },
        createInferenceService: () => ({ requestAccess: async () => ({}) }),
        resolveModelBudget: async () => budget,
        ...(versioning === undefined ? {} : { versioning })
    });
    const detach = runtime.attach(context);
    return { runtime, client, context, toasts, calls, detach };
}

const args = { sessionId: 's', modelId: 'm', reasoningEnabled: true };

test('without a facade the chat gate and the larger-key text are exactly the single-version ones', async () => {
    const h = harness();
    assert.equal(await h.runtime.checkCanSend(args), false);
    assert.deepEqual(h.toasts, [[SINGLE_VERSION_TEXT('3.00'), 'error', 9000]]);
    h.client.note.current_balance = 3_000_000;
    assert.equal(await h.runtime.checkCanSend(args), true);
    h.detach();
});

test('a facade that cannot answer never stops a chat or changes its text', async () => {
    for (const versioning of [
        {},
        { sendGate: () => { throw new Error('broke'); }, state: () => { throw new Error('broke'); } },
        { sendGate: () => 'nonsense', state: () => 'nonsense' },
        { sendGate: () => null, state: () => null },
        { sendGate: () => ({ canSend: true, code: null }), state: () => ({ show: false, target: null }) }
    ]) {
        const h = harness({ versioning });
        h.client.note.current_balance = 3_000_000;
        assert.equal(await h.runtime.checkCanSend(args), true);
        h.client.note.current_balance = 2_900_000;
        assert.equal(await h.runtime.checkCanSend(args), false);
        assert.deepEqual(h.toasts, [[SINGLE_VERSION_TEXT('3.00'), 'error', 9000]]);
        h.detach();
    }
});

test('near expiry a new key is refused with the plain explanation, after the expired check', async () => {
    const gates = [];
    const versioning = { sendGate: now => { gates.push(now); return { canSend: false, code: 'near_expiry' }; } };
    const h = harness({ versioning });
    assert.equal(await h.runtime.checkCanSend(args), false);
    assert.deepEqual(h.toasts, [[
        'This balance is about to expire. Withdraw it now. New chats are paused so nothing is left unsettled.', 'error', 9000
    ]]);
    assert.equal(gates.length, 1);
    assert.ok(Math.abs(gates[0] - Date.now()) < 5000);

    // An expired balance keeps its existing path (funding), without asking.
    const expired = harness({ versioning });
    expired.client.note = { expiry_ts: Math.floor(Date.now() / 1000) - 1 };
    gates.length = 0;
    assert.equal(await expired.runtime.checkCanSend(args), false);
    assert.equal(expired.calls.funding, 1);
    assert.equal(gates.length, 0);
    assert.deepEqual(expired.toasts, []);

    // No balance: the same.
    const empty = harness({ versioning });
    empty.client.hasNote = false;
    assert.equal(await empty.runtime.checkCanSend(args), false);
    assert.equal(empty.calls.funding, 1);
    assert.equal(gates.length, 0);
});

test('a near-expiry refusal explains itself and does not open the funding dialog', async () => {
    const h = harness({ versioning: { sendGate: () => ({ canSend: false, code: 'near_expiry' }) } });
    assert.equal(await h.runtime.checkCanSend(args), false);
    assert.equal(await h.runtime.checkCanSend({ ...args, shouldOpenFunding: () => false }), false);
    assert.equal(h.calls.funding, 0, 'the person needs Withdraw, not a deposit form');
    assert.equal(h.toasts.length, 2);
});

// A key of this session, valid for ten more minutes, at the model's cap.
const liveLease = (overrides = {}) => ({
    session_id: 's', spending_limit_usd: 3, expires_at: Math.floor(Date.now() / 1000) + 600,
    retiring: false, retired: false, ...overrides
});

test('near expiry a follow-up that reuses its live key is not refused and does not ask the gate', async () => {
    const gates = [];
    const versioning = { sendGate: now => { gates.push(now); return { canSend: false, code: 'near_expiry' }; } };
    const h = harness({ versioning, client: { activeLease: liveLease() } });
    assert.equal(await h.runtime.checkCanSend(args), true);
    assert.deepEqual(h.toasts, [], 'the person is not told chats are paused while theirs works');
    assert.equal(gates.length, 0, 'no new key, so nothing to protect');
    // Reusing a key also skips the balance check, as it always has.
    h.client.note.current_balance = 100;
    assert.equal(await h.runtime.checkCanSend(args), true);
    assert.equal(gates.length, 0);
    h.detach();
});

test('near expiry every send that would open a key is refused, once, whatever the lease', async () => {
    const cases = {
        'no key at all': {},
        'the key of another chat': { activeLease: liveLease({ session_id: 'someone-else' }) },
        'a key whose cap is not this model\'s': { activeLease: liveLease({ spending_limit_usd: 1 }) },
        'a key about to lapse': { activeLease: liveLease({ expires_at: Math.floor(Date.now() / 1000) + 30 }) },
        'a key that is closing': { activeLease: liveLease({ retiring: true }) },
        'a key already closed': { activeLease: liveLease({ retired: true }) }
    };
    for (const [label, client] of Object.entries(cases)) {
        const gates = [];
        const versioning = { sendGate: now => { gates.push(now); return { canSend: false, code: 'near_expiry' }; } };
        const h = harness({ versioning, client });
        assert.equal(await h.runtime.checkCanSend(args), false, label);
        assert.equal(h.toasts.length, 1, label);
        assert.match(h.toasts[0][0], /about to expire/, label);
        assert.equal(gates.length, 1, `${label}: asked once`);
        h.detach();
    }
});

test('near expiry with no model to price, a live key of the session is kept and no key is opened', async () => {
    const gates = [];
    const versioning = { sendGate: () => { gates.push(1); return { canSend: false, code: 'near_expiry' }; } };
    const withKey = harness({ versioning, client: { activeLease: liveLease() } });
    assert.equal(await withKey.runtime.checkCanSend({ sessionId: 's' }), true);
    assert.equal(gates.length, 0);
    const without = harness({ versioning });
    assert.equal(await without.runtime.checkCanSend({ sessionId: 's' }), false);
    assert.equal(gates.length, 1);
    assert.match(without.toasts[0][0], /about to expire/);
    withKey.detach();
    without.detach();
});

test('outside the cutoff the gate changes nothing, with or without a key to reuse', async () => {
    const open = { sendGate: () => ({ canSend: true, code: null }) };
    for (const client of [{}, { activeLease: liveLease() }, { activeLease: liveLease({ spending_limit_usd: 1 }) }]) {
        const h = harness({ versioning: open, client });
        h.client.note.current_balance = 3_000_000;
        assert.equal(await h.runtime.checkCanSend(args), true);
        assert.deepEqual(h.toasts, []);
        h.detach();
    }
    // The larger-key refusal is still the single-version one for a new key.
    const h = harness({ versioning: open });
    assert.equal(await h.runtime.checkCanSend(args), false);
    assert.deepEqual(h.toasts, [[SINGLE_VERSION_TEXT('3.00'), 'error', 9000]]);
    h.detach();
});

test('with a newer version to move to, the larger-key text says so', async () => {
    const state = {
        show: true,
        current: { id: 'v1', label: 'Version 1', status: 'exit-only' },
        target: { id: 'v2', label: 'Version 2' }
    };
    const h = harness({ versioning: { state: () => state, table: [] } });
    assert.equal(await h.runtime.checkCanSend(args), false);
    assert.deepEqual(h.toasts, [[
        'This model requires $3.00 in private balance for a new key. Choose a lower-cap model, '
        + 'or upgrade to version 2 to fund a larger one.', 'error', 9000
    ]]);
    h.detach();
});

test('on the deposit target itself the larger-key text is the single-version one', async () => {
    const state = {
        show: true,
        current: { id: 'v2', label: 'Version 2', status: 'active' },
        target: { id: 'v2', label: 'Version 2' }
    };
    const h = harness({ versioning: { state: () => state, table: [] } });
    assert.equal(await h.runtime.checkCanSend(args), false);
    assert.deepEqual(h.toasts, [[SINGLE_VERSION_TEXT('3.00'), 'error', 9000]]);
    h.detach();
});

test('a settling chat key is reported as work in flight, and unregistered on detach', async () => {
    const providers = new Set();
    const versioning = {
        registerBusy(provider) { providers.add(provider); return () => providers.delete(provider); }
    };
    let release;
    const settle = new Promise(resolve => { release = resolve; });
    const h = harness({ versioning, client: {
        activeLease: { session_id: 'previous' },
        settleActiveLease: async () => { await settle; }
    } });
    assert.equal(providers.size, 1);
    const [busy] = providers;
    assert.equal(busy(), false);
    h.runtime.onNewChat({ sessionId: 'previous' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(busy(), true, 'settlement in progress');
    release();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(busy(), false);
    h.detach();
    assert.equal(providers.size, 0);
});

test('a facade whose registration throws does not break attaching', () => {
    const h = harness({ versioning: { registerBusy() { throw new Error('broke'); } } });
    assert.doesNotThrow(() => h.detach());
});
