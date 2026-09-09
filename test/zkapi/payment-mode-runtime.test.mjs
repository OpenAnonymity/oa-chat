import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentModeRuntimeCore, PAYMENT_MODE_PREFERENCE } from '../../chat/zkapi/services/paymentModeRuntimeCore.mjs';
import { createZkapiChatRuntimeCore } from '../../chat/zkapi/services/zkapiChatRuntimeCore.mjs';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness({ initialMode = 'tickets', settle = null, save = null, ticketError = null, zkError = null } = {}) {
    const events = [];
    const preferences = new Map();
    const sessions = new Map([
        ['ticket-chat', { id: 'ticket-chat', inferenceBackend: 'openrouter', title: 'Earlier ticket chat',
            model: 'Test model', starred: true, createdAt: 100, customPreference: { enabled: true } }],
        ['zk-chat', { id: 'zk-chat', inferenceBackend: 'zkapi', title: 'Earlier zkAPI chat',
            model: 'Test model', createdAt: 200, zkapiSessionId: 'zk-chat', apiKey: 'zk-chat',
            apiKeyInfo: { backendId: 'zkapi', sessionBound: true },
            zkapiUsageLedger: [{ id: 'old-response', estimatedCostUsd: 0.01 }] }]
    ]);
    const messages = new Map([
        ['ticket-chat', [{ id: 'ticket-message', role: 'user', content: 'Keep my history', files: [{ name: 'notes.txt' }] }]],
        ['zk-chat', [{ id: 'zk-message', role: 'assistant', content: 'Keep this answer', zkapiUsageRecorded: true }]]
    ]);
    const stored = new Map([...sessions].map(([id, session]) => [id, structuredClone(session)]));
    let selectedId = null;
    let busy = false;
    let defaultBackendId = 'openrouter';
    const client = {
        hasNote: true,
        withdrawalBlocksChat: false,
        activeLease: { session_id: 'zk-chat' },
        init: async () => {},
        subscribe: () => () => {},
        hasPendingLease: async () => false,
        async settleActiveLease() {
            events.push(['settle', this.activeLease?.session_id]);
            await settle?.();
            this.activeLease = null;
        }
    };
    const backends = new Map([
        ['openrouter', { id: 'openrouter', async requestAccess({ session }) {
            events.push(['ticket-access', session.id]);
            if (ticketError) throw ticketError;
            return { key: `ticket-key:${session.id}`, backendId: 'openrouter' };
        } }],
        ['zkapi', { id: 'zkapi', async requestAccess({ session }) {
            events.push(['zk-access', session.id]);
            if (zkError) throw zkError;
            return { key: session.id, backendId: 'zkapi', sessionBound: true };
        } }]
    ]);
    const inferenceService = {
        getDefaultBackendId: () => defaultBackendId,
        setDefaultBackendId(id) { assert.ok(backends.has(id)); defaultBackendId = id; },
        requestAccess: (session, options = {}) => backends.get(session.inferenceBackend).requestAccess({ session, ...options })
    };
    const modelConfiguration = { getDefaultModelConfig: () => ({ defaultModelId: 'test/model' }) };
    const zkRuntime = createZkapiChatRuntimeCore({ client, backend: backends.get('zkapi'),
        createInferenceService: () => inferenceService, modelConfiguration });
    const runtime = createPaymentModeRuntimeCore({ zkRuntime, inferenceService, modelConfiguration, initialMode,
        preferenceStorage: { setItem: (key, value) => preferences.set(key, value) },
        acquireVerifiedAccess: async options => {
            events.push(['ticket-verification-path', options.session.id]);
            return inferenceService.requestAccess(options.session, { signal: options.signal });
        } });
    const context = {
        getCurrentSession: () => sessions.get(selectedId) || null,
        getSession: id => sessions.get(id) || null,
        isSessionBusy: () => busy,
        refreshPresentation: () => events.push(['presentation']),
        cancelSessionWork: async id => events.push(['cancel', id]),
        logLocalEvent: () => {},
        openFunding: () => events.push(['funding']),
        showToast: (...args) => events.push(['toast', ...args]),
        setProgress: () => {},
        async saveSession(session) {
            await save?.(session);
            stored.set(session.id, structuredClone(session));
        },
        // The shared controller owns persistence/credential replacement. This
        // injected port models its durable-write contract, leaving the real
        // controller implementation to its own unit tests and the browser E2E.
        async changeSessionBackend(backendId) {
            const session = this.getCurrentSession();
            if (!session) return;
            if (session.inferenceBackend === backendId) return;
            const staged = structuredClone(session);
            await runtime.beforeBackendChange({ session: staged, previousBackendId: session.inferenceBackend, backendId });
            staged.apiKey = null;
            staged.apiKeyInfo = null;
            staged.expiresAt = null;
            staged.currentEphemeralKeyId = null;
            delete staged.councilAccess;
            staged.inferenceBackend = backendId;
            await this.saveSession(staged);
            for (const key of Object.keys(session)) delete session[key];
            Object.assign(session, staged);
        }
    };
    runtime.attach(context);
    return { runtime, client, sessions, stored, messages, preferences, events, inferenceService,
        select: id => { selectedId = id; }, setBusy: value => { busy = value; } };
}

test('a remembered new-chat choice never overrides the payment mode of historical sessions', async () => {
    const h = harness({ initialMode: 'zkapi' });
    assert.equal(h.runtime.getMode(), 'zkapi');
    h.select('ticket-chat');
    assert.equal(h.runtime.getMode(), 'tickets');
    h.select('zk-chat');
    assert.equal(h.runtime.getMode(), 'zkapi');
    h.select(null);
    await h.runtime.changeMode('tickets');
    assert.equal(h.runtime.getMode(), 'tickets');
    assert.equal(h.preferences.get(PAYMENT_MODE_PREFERENCE), 'tickets');
    assert.equal(h.sessions.size, 2, 'choosing payment on the empty page does not create history');
    assert.equal(h.sessions.get('zk-chat').inferenceBackend, 'zkapi');
    assert.equal(h.events.filter(([kind]) => kind === 'settle').length, 0);
});

test('ticket features follow the owning chat and preserve preferences across mode changes', async () => {
    const h = harness({ initialMode: 'zkapi' });
    const ticketSession = h.sessions.get('ticket-chat');
    ticketSession.responseMode = 'council';
    ticketSession.councilConfig = { enabled: true, members: ['First model', 'Second model'] };
    ticketSession.memoryRetrievedContext = 'Previously approved test context';
    const preferences = structuredClone(ticketSession.councilConfig);
    for (const feature of ['memory', 'scrubber', 'council']) {
        assert.equal(h.runtime.features[feature], true, 'shared controls and services mount for ticket chats');
        assert.equal(h.runtime.supportsFeature(feature, ticketSession), true);
        assert.equal(h.runtime.supportsFeature(feature, h.sessions.get('zk-chat')), false);
        assert.equal(h.runtime.supportsFeature(feature, null), false, 'empty composer follows the default mode');
        assert.match(h.runtime.getFeatureUnavailableReason(feature, h.sessions.get('zk-chat')), /Switch to Tickets/);
        assert.equal(h.runtime.getFeatureUnavailableReason(feature, ticketSession), '');
    }
    assert.equal(h.runtime.supportsFeature('accounts', h.sessions.get('zk-chat')), true);
    h.select('ticket-chat');
    await h.runtime.changeMode('zkapi');
    assert.equal(h.runtime.supportsFeature('council', ticketSession), false);
    assert.deepEqual(ticketSession.councilConfig, preferences);
    assert.equal(ticketSession.responseMode, 'council');
    assert.equal(ticketSession.memoryRetrievedContext, 'Previously approved test context');
    await h.runtime.changeMode('tickets');
    assert.equal(h.runtime.supportsFeature('council', ticketSession), true);
    assert.deepEqual(ticketSession.councilConfig, preferences);
    assert.equal(h.runtime.supportsFeature('memory', null), true);
    assert.equal(h.events.filter(([kind]) => ['ticket-access', 'zk-access'].includes(kind)).length, 0,
        'restoring controls or preferences never acquires a key');
});

test('both switch directions keep the same durable conversation and acquire from only the selected source', async () => {
    const h = harness();
    h.select('ticket-chat');
    const session = h.sessions.get('ticket-chat');
    const messagesBefore = structuredClone(h.messages);
    const metadataBefore = { id: session.id, title: session.title, model: session.model,
        starred: session.starred, createdAt: session.createdAt, customPreference: session.customPreference };
    assert.equal((await h.runtime.acquireAccess({ session })).backendId, 'openrouter');
    await h.runtime.changeMode('zkapi');
    assert.equal(h.stored.get(session.id).inferenceBackend, 'zkapi');
    assert.equal((await h.runtime.acquireAccess({ session })).backendId, 'zkapi');
    h.client.activeLease = { session_id: session.id };
    session.zkapiSessionId = session.id;
    session.zkapiSettleBeforeAccess = true;
    await h.runtime.changeMode('tickets');
    assert.equal(h.stored.get(session.id).inferenceBackend, 'openrouter');
    assert.equal((await h.runtime.acquireAccess({ session })).backendId, 'openrouter');
    assert.equal(h.client.activeLease, null);
    assert.equal(session.zkapiSessionId, undefined);
    assert.equal(session.zkapiSettleBeforeAccess, true, 'private recovery intent survives in ticket mode');
    assert.deepEqual(h.messages, messagesBefore);
    for (const [field, value] of Object.entries(metadataBefore)) assert.deepEqual(session[field], value);
    assert.deepEqual(h.events.filter(([kind]) => ['ticket-access', 'zk-access', 'settle'].includes(kind)),
        [['ticket-access', session.id], ['zk-access', session.id], ['settle', session.id], ['ticket-access', session.id]]);
    assert.equal(h.preferences.get(PAYMENT_MODE_PREFERENCE), 'tickets');
});

test('Tickets selection and access finish while private retirement remains pending', async () => {
    const retirement = deferred();
    const h = harness({ settle: () => retirement.promise });
    h.select('zk-chat');
    const messagesBefore = structuredClone(h.messages);
    await h.runtime.changeMode('tickets');
    assert.equal(h.stored.get('zk-chat').inferenceBackend, 'openrouter');
    assert.equal(h.preferences.get(PAYMENT_MODE_PREFERENCE), 'tickets');
    assert.equal(h.runtime.isModeLocked(), false);
    assert.equal(h.runtime.getTransition().phase, 'settling');
    assert.equal(await h.runtime.checkCanSend({ sessionId: 'zk-chat' }), true);
    await h.runtime.prepareTurn({ sessionId: 'zk-chat' });
    const session = h.sessions.get('zk-chat');
    const access = await h.runtime.acquireAccess({ session });
    assert.equal(access.backendId, 'openrouter');
    session.apiKey = access.key;
    session.apiKeyInfo = access;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.events.filter(([kind]) => kind === 'settle').length, 1);
    retirement.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.runtime.getTransition().phase, 'ready');
    assert.equal(session.apiKey, access.key, 'late private settlement cannot replace the new ticket key');
    assert.deepEqual(h.messages, messagesBefore);
    assert.equal(h.events.some(([kind]) => kind === 'cancel'), false);
});

test('failed private retirement leaves Tickets usable with durable recovery intent', async () => {
    const h = harness({ initialMode: 'zkapi', settle: () => { throw new Error('Settlement temporarily unavailable'); } });
    h.select('zk-chat');
    const before = structuredClone(h.messages);
    await h.runtime.changeMode('tickets');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.stored.get('zk-chat').inferenceBackend, 'openrouter');
    assert.equal(h.stored.get('zk-chat').zkapiSettleBeforeAccess, true);
    assert.equal(h.inferenceService.getDefaultBackendId(), 'openrouter');
    assert.equal(h.preferences.get(PAYMENT_MODE_PREFERENCE), 'tickets');
    assert.equal(h.runtime.isModeLocked(), false);
    assert.equal(h.runtime.getTransition().phase, 'error');
    await h.runtime.prepareTurn({ sessionId: 'zk-chat' });
    assert.equal((await h.runtime.acquireAccess({ session: h.sessions.get('zk-chat') })).backendId, 'openrouter');
    assert.deepEqual(h.messages, before);
});

test('wallet hydration never blocks switching to Tickets and a rapid private return sees its barrier', async () => {
    const hydration = deferred();
    const retirement = deferred();
    const h = harness({ initialMode: 'zkapi', settle: () => retirement.promise });
    h.select('zk-chat');
    h.client.activeLease = null;
    h.client.init = () => hydration.promise;
    let hydrated = false;
    h.client.getPendingLeaseOwner = async () => {
        assert.equal(hydrated, true, 'lease ownership cannot be checked against an unhydrated wallet');
        return 'zk-chat';
    };
    await h.runtime.changeMode('tickets');
    assert.equal(h.runtime.isModeLocked(), false);
    assert.equal(h.stored.get('zk-chat').inferenceBackend, 'openrouter');
    assert.equal(h.events.some(([kind]) => kind === 'settle'), false);
    const returning = h.runtime.changeMode('zkapi');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.runtime.getMode(), 'zkapi');
    assert.equal(h.runtime.isModeLocked(), false);
    let prepared = false;
    const preparing = h.runtime.prepareTurn({ sessionId: 'zk-chat' }).then(() => { prepared = true; });
    hydrated = true;
    hydration.resolve();
    await returning;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prepared, false);
    assert.equal(h.events.filter(([kind]) => kind === 'settle').length, 1);
    retirement.resolve();
    await preparing;
    assert.equal(prepared, true);
    assert.equal(h.events.some(([kind]) => kind === 'cancel'), false);
});

test('an expired owned lease still settles, while another chat\'s persisted lease remains untouched', async () => {
    for (const owner of ['zk-chat', 'unrelated-chat']) {
        const h = harness({ initialMode: 'zkapi' });
        h.select('zk-chat');
        h.client.activeLease = null;
        h.client.getPendingLeaseOwner = async () => owner;
        await h.runtime.changeMode('tickets');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.events.filter(([kind]) => kind === 'settle').length, owner === 'zk-chat' ? 1 : 0);
        assert.equal(h.stored.get('zk-chat').inferenceBackend, 'openrouter');
    }
});

test('a failed durable write does not advertise a changed method or persist the new default', async () => {
    const h = harness({ save: () => { throw new Error('Storage unavailable'); } });
    h.select('ticket-chat');
    h.client.hasNote = false;
    await assert.rejects(h.runtime.changeMode('zkapi'), /Storage unavailable/);
    assert.equal(h.sessions.get('ticket-chat').inferenceBackend, 'openrouter');
    assert.equal(h.inferenceService.getDefaultBackendId(), 'openrouter');
    assert.equal(h.preferences.has(PAYMENT_MODE_PREFERENCE), false);
    assert.equal(h.runtime.isSwitching(), false);
    assert.equal(h.events.some(([kind]) => kind === 'funding'), false);
});

test('selecting zkAPI opens funding for an unfunded new or historical chat without issuing keys', async () => {
    for (const sessionId of [null, 'ticket-chat']) {
        const h = harness();
        h.select(sessionId);
        h.client.hasNote = false;
        await h.runtime.changeMode('zkapi');
        assert.equal(h.runtime.getMode(), 'zkapi');
        assert.equal(h.preferences.get(PAYMENT_MODE_PREFERENCE), 'zkapi');
        assert.equal(h.events.filter(([kind]) => kind === 'funding').length, 1);
        assert.equal(h.events.some(([kind]) => ['settle', 'ticket-access', 'zk-access'].includes(kind)), false);
        if (sessionId) assert.equal(h.stored.get(sessionId).inferenceBackend, 'zkapi');
        await h.runtime.changeMode('tickets');
        assert.equal(h.events.filter(([kind]) => kind === 'funding').length, 1);
    }
});

test('funded wallets stay in chat even when they do not have an active key', async () => {
    const h = harness();
    h.client.activeLease = null;
    await h.runtime.changeMode('zkapi');
    assert.equal(h.events.some(([kind]) => kind === 'funding'), false);
});

test('wallet restoration finishes before deciding to show funding', async () => {
    const h = harness();
    const hydration = deferred();
    h.client.hasNote = false;
    h.client.init = () => hydration.promise;
    const changing = h.runtime.changeMode('zkapi');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.runtime.getMode(), 'zkapi');
    assert.equal(h.runtime.isModeLocked(), false, 'wallet loading does not trap the user in the selected mode');
    assert.equal(h.events.some(([kind]) => kind === 'funding'), false);
    h.client.hasNote = true;
    hydration.resolve();
    await changing;
    assert.equal(h.events.some(([kind]) => kind === 'funding'), false);
});

test('late funding checks cannot open over another chat or a newer payment choice', async () => {
    for (const nextAction of ['navigate', 'navigation-pending', 'tickets', 'zkapi-again']) {
        const h = harness();
        const hydration = deferred();
        h.select('ticket-chat');
        h.client.hasNote = false;
        h.client.activeLease = null;
        h.client.init = () => hydration.promise;
        const first = h.runtime.changeMode('zkapi');
        await new Promise(resolve => setImmediate(resolve));
        let second;
        if (nextAction === 'navigate') h.select('zk-chat');
        else if (nextAction === 'navigation-pending') h.setBusy(true);
        else if (nextAction === 'tickets') {
            // The empty composer changes the default without retiring a chat key.
            h.select(null);
            await h.runtime.changeMode('tickets');
        } else second = h.runtime.changeMode('zkapi');
        hydration.resolve();
        await Promise.all([first, second]);
        assert.equal(h.events.filter(([kind]) => kind === 'funding').length, nextAction === 'zkapi-again' ? 1 : 0);
    }
});

test('a wallet loading failure keeps the successful selection and reports a balance-check error', async () => {
    const h = harness();
    h.select('ticket-chat');
    h.client.init = async () => { throw new Error('Wallet offline'); };
    await h.runtime.changeMode('zkapi');
    assert.equal(h.stored.get('ticket-chat').inferenceBackend, 'zkapi');
    assert.equal(h.preferences.get(PAYMENT_MODE_PREFERENCE), 'zkapi');
    assert.equal(h.events.some(([kind]) => kind === 'funding'), false);
    assert.match(h.events.find(([kind]) => kind === 'toast')[1], /zkAPI selected.*could not be checked/);
});

test('busy chat and invalid mode requests cannot trigger settlement, acquisition, or preference writes', async () => {
    const h = harness();
    h.select('zk-chat');
    h.setBusy(true);
    await assert.rejects(h.runtime.changeMode('tickets'), /Finish or stop/);
    h.setBusy(false);
    await assert.rejects(h.runtime.changeMode('automatic'), /Choose Tickets or zkAPI/);
    assert.equal(h.preferences.size, 0);
    assert.equal(h.events.some(([kind]) => ['settle', 'ticket-access', 'zk-access'].includes(kind)), false);
    assert.equal(h.sessions.get('zk-chat').inferenceBackend, 'zkapi');
});

test('ticket acquisition and zkAPI payment failures are surfaced without falling back or changing modes', async () => {
    const ticketError = new Error('No tickets remain');
    const zkError = new Error('Private balance is insufficient');
    const h = harness({ ticketError, zkError });
    for (const [id, expected] of [['ticket-chat', ticketError], ['zk-chat', zkError]]) {
        h.select(id);
        const session = h.sessions.get(id);
        await assert.rejects(h.runtime.acquireAccess({ session }), error => error === expected);
    }
    assert.deepEqual(h.events.filter(([kind]) => ['ticket-access', 'zk-access'].includes(kind)),
        [['ticket-access', 'ticket-chat'], ['zk-access', 'zk-chat']]);
    assert.equal(h.preferences.size, 0);
    assert.equal(h.sessions.get('ticket-chat').inferenceBackend, 'openrouter');
    assert.equal(h.sessions.get('zk-chat').inferenceBackend, 'zkapi');
});

test('preflight and usage follow the request owner even while another payment mode is selected', async () => {
    const h = harness();
    h.select('zk-chat');
    h.client.hasNote = false;
    assert.equal(await h.runtime.checkCanSend({ sessionId: 'ticket-chat' }), true);
    assert.equal(await h.runtime.checkCanSend({ sessionId: 'zk-chat' }), false);
    assert.equal(h.events.filter(([kind]) => kind === 'funding').length, 1);
    h.select('ticket-chat');
    await h.runtime.recordUsage({ sessionId: 'ticket-chat', requestId: 'ticket-answer', usage: { cost: 0.03 } });
    assert.equal(h.sessions.get('ticket-chat').zkapiUsageLedger, undefined);
    await h.runtime.recordUsage({ sessionId: 'zk-chat', requestId: 'zk-answer', usage: { cost: 0.04 } });
    assert.ok(h.stored.get('zk-chat').zkapiUsageLedger.some(entry => entry.id === 'zk-answer'));
    const before = h.events.filter(([kind]) => kind === 'settle').length;
    await h.runtime.prepareTurn({ sessionId: 'ticket-chat' });
    assert.equal(h.events.filter(([kind]) => kind === 'settle').length, before);
});


test('a private retry for another chat cannot cancel the old owner now using Tickets', async () => {
    let attempts = 0;
    const h = harness({ settle: () => {
        if (++attempts === 1) throw new Error('Try later');
    } });
    h.select('zk-chat');
    await h.runtime.changeMode('tickets');
    await new Promise(resolve => setImmediate(resolve));
    const ticketSession = h.sessions.get('zk-chat');
    ticketSession.apiKey = (await h.runtime.acquireAccess({ session: ticketSession })).key;
    h.select('ticket-chat');
    await h.runtime.changeMode('zkapi');
    await h.runtime.prepareTurn({ sessionId: 'ticket-chat' });
    assert.equal(attempts, 2);
    assert.equal(h.events.some(([kind]) => kind === 'cancel'), false);
    assert.equal(ticketSession.apiKey, 'ticket-key:zk-chat');
    assert.equal(ticketSession.inferenceBackend, 'openrouter');
});

test('a reloaded ticket chat retains owner-scoped retirement intent on returning to zkAPI', async () => {
    const retirement = deferred();
    const h = harness({ settle: () => retirement.promise });
    const session = h.sessions.get('zk-chat');
    Object.assign(session, { inferenceBackend: 'openrouter', apiKey: 'new-ticket-key',
        apiKeyInfo: { backendId: 'openrouter' }, zkapiSettleBeforeAccess: true });
    delete session.zkapiSessionId;
    h.select('zk-chat');
    await h.runtime.changeMode('zkapi');
    assert.equal(h.stored.get(session.id).zkapiSettleBeforeAccess, true);
    assert.equal(session.apiKey, null);
    let prepared = false;
    const preparing = h.runtime.prepareTurn({ sessionId: session.id }).then(() => { prepared = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prepared, false, 'the restored same-owner key must close before new private access');
    retirement.resolve();
    await preparing;
    assert.equal(h.events.filter(([kind]) => kind === 'settle').length, 1);
    assert.equal(h.events.some(([kind]) => kind === 'cancel'), false);
});

test('a wallet hydration failure cannot reject the successful Tickets selection', async () => {
    const h = harness({ initialMode: 'zkapi' });
    h.select('zk-chat');
    h.client.init = async () => { throw new Error('Wallet offline'); };
    await h.runtime.changeMode('tickets');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.runtime.getMode(), 'tickets');
    assert.equal(h.runtime.isModeLocked(), false);
    assert.equal(h.runtime.getTransition().phase, 'error');
    assert.equal((await h.runtime.acquireAccess({ session: h.sessions.get('zk-chat') })).backendId, 'openrouter');
});


test('a failed mode save keeps the private chat intact while its registered retirement still gates reuse', async () => {
    const retirement = deferred();
    const h = harness({ initialMode: 'zkapi', settle: () => retirement.promise,
        save: () => { throw new Error('Storage unavailable'); } });
    h.select('zk-chat');
    const before = structuredClone(h.sessions.get('zk-chat'));
    await assert.rejects(h.runtime.changeMode('tickets'), /Storage unavailable/);
    assert.deepEqual(h.sessions.get('zk-chat'), before);
    assert.deepEqual(h.stored.get('zk-chat'), before);
    assert.equal(h.inferenceService.getDefaultBackendId(), 'zkapi');
    assert.equal(h.preferences.has(PAYMENT_MODE_PREFERENCE), false);
    assert.equal(h.runtime.isModeLocked(), false);
    let prepared = false;
    const preparing = h.runtime.prepareTurn({ sessionId: 'zk-chat' }).then(() => { prepared = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prepared, false);
    retirement.resolve();
    await preparing;
    assert.equal(h.events.some(([kind]) => kind === 'cancel'), false);
});
