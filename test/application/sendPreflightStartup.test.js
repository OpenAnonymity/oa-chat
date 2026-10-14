import test from 'node:test';
import assert from 'node:assert/strict';

// The send preflight on a freshly loaded page: it must not queue behind
// start-up work that cannot change its answer (the previous-version ticket
// move, a second download of the model catalog).

function installBrowser() {
    const keys = ['window', 'location', 'localStorage', 'sessionStorage', 'document', 'fetch', 'requestAnimationFrame'];
    const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const events = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    const location = { href: 'http://localhost/', hostname: 'localhost', origin: 'http://localhost', search: '', pathname: '/' };
    const values = {
        window: { ...events, location, localStorage: storage, sessionStorage: storage },
        location, localStorage: storage, sessionStorage: storage,
        document: { ...events, querySelector: () => null, getElementById: () => null,
            documentElement: { classList: { contains: () => false }, dataset: {} } },
        fetch: async () => { throw new Error('These preflight tests must never use the network.'); },
        requestAnimationFrame: callback => callback()
    };
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    return () => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    };
}

const restoreImport = installBrowser();
const { default: preferencesStore } = await import('../../chat/services/preferencesStore.js');
const getPreference = preferencesStore.getPreference;
preferencesStore.getPreference = async () => false;
const { ChatApp } = await import('../../chat/app.js');
const { default: ticketClient } = await import('../../chat/services/ticketClient.js');
preferencesStore.getPreference = getPreference;
restoreImport();

function deferred() {
    let resolve;
    const promise = new Promise(value => { resolve = value; });
    return { promise, resolve };
}

function preflightHarness() {
    return Object.assign(Object.create(ChatApp.prototype), {
        runtime: {},
        features: { tickets: true },
        signInPolicy: { required: false },
        memoryFeatureEnabled: false,
        memoryMode: false,
        reasoningEnabled: false,
        isCouncilModeActive: () => false,
        getFreshInferenceTicketRequirement: async () => ({ tickets: 1, label: 'Model one' }),
        showToast: () => assert.fail('A covered turn must not raise a notice'),
        notifyTicketShortage: async () => assert.fail('A covered turn is not a shortage')
    });
}

function withTicketClient(overrides, run) {
    const originals = Object.fromEntries(Object.keys(overrides).map(key => [key, ticketClient[key]]));
    Object.assign(ticketClient, overrides);
    return Promise.resolve().then(run).finally(() => { Object.assign(ticketClient, originals); });
}

test('a wallet that covers the turn never waits for the previous-version ticket move', async () => {
    const app = preflightHarness();
    await withTicketClient({
        getTicketCount: () => 3,
        getHeldTicketCount: () => 0,
        isLegacyTransferRunning: () => true,
        awaitLegacyTransfer: async () => assert.fail('A covered turn must not queue behind the ticket move')
    }, async () => {
        assert.equal(await app.preflightTurnTicketBudget({ id: 'one', model: 'Model one' }, 'Hello'), true);
    });
});

test('a shortage waits for the running move and rechecks the balance it delivered', async () => {
    const app = preflightHarness();
    let balance = 0;
    let waited = 0;
    await withTicketClient({
        getTicketCount: () => balance,
        getHeldTicketCount: () => 0,
        isLegacyTransferRunning: () => true,
        awaitLegacyTransfer: async () => { waited += 1; balance = 3; }
    }, async () => {
        assert.equal(await app.preflightTurnTicketBudget({ id: 'one', model: 'Model one' }, 'Hello'), true);
    });
    assert.equal(waited, 1);
});

test('a shortage with no move in flight is reported without waiting', async () => {
    const app = preflightHarness();
    const notices = [];
    let shortage = null;
    app.showToast = message => { notices.push(message); };
    app.notifyTicketShortage = async budget => { shortage = budget; return { retry: false }; };
    await withTicketClient({
        getTicketCount: () => 0,
        getHeldTicketCount: () => 0,
        isLegacyTransferRunning: () => false,
        awaitLegacyTransfer: async () => assert.fail('Nothing is moving, so nothing is awaited')
    }, async () => {
        assert.equal(await app.preflightTurnTicketBudget({ id: 'one', model: 'Model one' }, 'Hello'), false);
    });
    assert.equal(shortage?.sufficient, false);
    assert.equal(shortage?.requiredTickets, 1);
    assert.equal(notices.length, 1);
});

test('a stale high preview is repriced before any reload or shortage dialog', async () => {
    const app = preflightHarness();
    const refreshes = [];
    app.getFreshInferenceTicketRequirement = async (_session, options) => {
        refreshes.push(options.refreshPricing);
        return { tickets: options.refreshPricing ? 1 : 5, label: 'Model one' };
    };
    await withTicketClient({ getTicketCount: () => 3, getHeldTicketCount: () => 0,
        isLegacyTransferRunning: () => false }, async () => {
        assert.equal(await app.preflightTurnTicketBudget({ id: 'one' }, 'Hello'), true);
    });
    assert.deepEqual(refreshes, [false, true]);
});

test('failed authoritative shortage pricing cannot trigger an automatic purchase', async () => {
    const app = preflightHarness();
    const notices = [];
    app.showToast = text => notices.push(text);
    app.getFreshInferenceTicketRequirement = async (_session, options) => {
        if (options.refreshPricing) throw Object.assign(new Error('offline'), { code: 'MODEL_TIER_CONFIG_UNAVAILABLE' });
        return { tickets: 5, label: 'Model one' };
    };
    await withTicketClient({ getTicketCount: () => 3, getHeldTicketCount: () => 0,
        isLegacyTransferRunning: () => false }, async () => {
        assert.equal(await app.preflightTurnTicketBudget({ id: 'one' }, 'Hello'), false);
    });
    assert.deepEqual(notices, ['Ticket pricing is temporarily unavailable. Please try again.']);
});

test('a send before the catalog has loaded shares the page-load download instead of starting another', async () => {
    const restore = installBrowser();
    const previousFetch = globalThis.fetch;
    // Only the pricing map may be fetched here; a second catalog download must not happen.
    globalThis.fetch = async url => {
        assert.match(String(url), /\/chat\/model-tickets$/);
        return new Response(JSON.stringify({ 'model-one': 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
        const load = deferred();
        let models = [];
        const app = Object.assign(Object.create(ChatApp.prototype), {
            reasoningEnabled: false,
            councilController: null,
            modelsLoadPromise: load.promise,
            isCouncilModeActive: () => false,
            getModelsForSession: () => models,
            normalizeModelName: value => value,
            getFallbackModelEntry: () => null,
            getTicketCost: (modelId, reasoning) => (modelId === 'model-one' && reasoning === false ? 1 : assert.fail(`Unexpected price lookup for ${modelId}`)),
            inferenceService: {
                getAccessToken: () => null,
                isAccessExpired: () => false,
                getDefaultModelName: () => 'Model one',
                fetchModels: () => assert.fail('The catalog is already downloading; a send must not download it again')
            }
        });
        const session = { id: 'one', model: 'Model one', inferenceBackend: 'ticket' };
        const pending = app.getFreshInferenceTicketRequirement(session);
        await Promise.resolve();
        models = [{ id: 'model-one', name: 'Model one' }];
        load.resolve();
        assert.deepEqual(await pending, { tickets: 1, label: 'Model one' });
    } finally {
        globalThis.fetch = previousFetch;
        restore();
    }
});

test('loadModels publishes its in-flight download and clears it once the catalog has landed', async () => {
    const restore = installBrowser();
    try {
        const gate = deferred();
        const app = Object.assign(Object.create(ChatApp.prototype), {
            state: { currentSessionId: null, models: [], modelsVersion: 0 },
            getCurrentSession: () => null,
            filterDisabledModels: catalog => catalog,
            inferenceService: { getDefaultBackendId: () => 'ticket', fetchModels: () => gate.promise }
        });
        const loading = app.loadModels();
        assert.equal(app.modelsLoadPromise, loading);
        assert.equal(app.state.modelsLoading, true);
        gate.resolve([{ id: 'model-one', name: 'Model one' }]);
        await loading;
        assert.equal(app.modelsLoadPromise, null);
        assert.deepEqual(app.state.models, [{ id: 'model-one', name: 'Model one' }]);
        assert.equal(app.state.modelsLoading, false);
    } finally {
        restore();
    }
});

// The ticket price at send: the preflight uses the live map the tab holds
// (no request before the message is accepted); a shortage found at the key
// request, after the price rose, goes to the same reload-or-offers path and
// keeps the prompt in the chat with Retry.

test('the budget check uses the price the tab holds and makes no request before the message is accepted', async () => {
    const restore = installBrowser();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async url => assert.fail(`No request before the message is accepted (${url})`);
    try {
        const app = Object.assign(Object.create(ChatApp.prototype), {
            reasoningEnabled: false,
            councilController: null,
            isCouncilModeActive: () => false,
            getModelsForSession: () => [{ id: 'model-one', name: 'Model one' }],
            normalizeModelName: value => value,
            getFallbackModelEntry: () => null,
            getTicketCost: () => 1,
            inferenceService: { getAccessToken: () => null, isAccessExpired: () => false, getDefaultModelName: () => 'Model one',
                fetchModels: () => assert.fail('The catalog is loaded') }
        });
        // The live map was loaded by the earlier test in this file (the page-load fetch).
        assert.deepEqual(await app.getFreshInferenceTicketRequirement({ id: 'one', model: 'Model one', inferenceBackend: 'ticket' }),
            { tickets: 1, label: 'Model one' });
    } finally {
        globalThis.fetch = previousFetch;
        restore();
    }
});

test('a key-request shortage reaches the shortage handler with the reload hook, and a shortage nobody covers is announced', async () => {
    const restore = installBrowser();
    try {
        const source = (await import('node:fs')).readFileSync('chat/app.js', 'utf8');
        const start = source.indexOf('    async acquireAndSetAccess(');
        const method = source.slice(start, source.indexOf('\n    toggleCitations(', start));
        assert.match(method, /onTicketShortage: shortage => this\.handleAcquisitionTicketShortage\(session, shortage, controller\.signal\)/);
        // The send keeps the prompt on a shortage instead of posting an error bubble.
        const send = source.slice(source.indexOf('    async sendCapturedMessage('), source.indexOf('\n    async ', source.indexOf('    async sendCapturedMessage(') + 20));
        const shortage = send.indexOf("error?.code === 'TICKET_SHORTAGE'");
        assert.ok(shortage > 0);
        assert.ok(shortage < send.indexOf('await this.discardPendingTurn(pendingTurn);', send.indexOf('} catch (error) {')));
        assert.match(send, /await this\.keepPendingTurnForTicketShortage\(pendingTurn, error, session\);/);

        const notified = [];
        const app = Object.assign(Object.create(ChatApp.prototype), {
            ticketShortageHandler: async (shortage, hooks) => { notified.push([shortage, hooks]); return { retry: false }; }
        });
        const result = await app.notifyTicketShortage({ availableTickets: 6, requiredTickets: 9, sufficient: false }, { onReloadStarted: () => {} });
        assert.deepEqual(result, { retry: false });
        assert.deepEqual(notified[0][0], { availableTickets: 6, requiredTickets: 9 });
        assert.equal(typeof notified[0][1].onReloadStarted, 'function');
    } finally {
        restore();
    }
});

test('the pending reply says tickets are reloading while an automatic reload runs', async () => {
    const restore = installBrowser();
    try {
        const { default: VanillaChatUi } = await import('../../chat/ui/vanilla/VanillaChatUi.js');
        const label = { textContent: 'Requesting ephemeral key', classList: { add() {} } };
        const indicator = { dataset: { phase: 'requesting-key', pendingSessionId: 'one' }, querySelector: selector => selector === '.pending-response-label' ? label : null };
        const ui = Object.assign(Object.create(VanillaChatUi.prototype), { interfaces: { componentApp: { services: {} } } });
        const app = Object.assign(Object.create(ChatApp.prototype), {
            ui,
            sessionStreamingStates: new Map([['one', { isStreaming: true, abortController: null, phase: 'requesting-key' }]])
        });
        document.querySelector = selector => selector.includes('data-pending-session-id="one"') ? indicator : null;
        app.showTicketReloadPending('one');
        assert.equal(label.textContent, 'Reloading tickets…');
        assert.equal(app.getSessionStreamingState('one').phase, 'reloading-tickets');
        // The granted key moves the label on as before.
        ui.updatePendingIndicator(indicator, 'waiting-response');
        assert.equal(label.textContent, 'Waiting for response');
    } finally {
        restore();
    }
});

test('a shortage after the prompt is in the chat keeps it and leaves the reply interrupted with Retry', async () => {
    const restore = installBrowser();
    const { chatDB } = await import('../../chat/db.js');
    const originalSave = chatDB.saveMessage;
    const saved = [];
    chatDB.saveMessage = async message => { saved.push({ ...message }); };
    try {
        const appended = [];
        const app = Object.assign(Object.create(ChatApp.prototype), {
            state: { currentSessionId: 'one' },
            chatArea: { appendMessage: async message => { appended.push(message); } }
        });
        const turn = { id: 'turn-1', sessionId: 'one', role: 'assistant', content: '', streamingPending: true, streamingPhase: 'requesting-key', isLocalOnly: true, pendingTurn: true };
        const error = Object.assign(new Error('Not enough tickets for Model one. Need 9, but only 6 available.'), { code: 'TICKET_SHORTAGE' });
        await app.keepPendingTurnForTicketShortage(turn, error, { id: 'one' });
        assert.equal('pendingTurn' in turn, false);
        assert.equal(turn.streamingPending, false);
        assert.equal(turn.streamingPhase, null);
        assert.equal(turn.isLocalOnly, true);
        assert.equal(turn.content, '');
        assert.equal(turn.inferenceError, 'Not enough tickets for Model one. Need 9, but only 6 available. Get tickets, then retry.');
        assert.equal(saved.length, 1);
        assert.deepEqual(appended, [turn]);
    } finally {
        chatDB.saveMessage = originalSave;
        restore();
    }
});

test('late reload hooks after Stop cannot update the stopped chat', async () => {
    const restore = installBrowser();
    try {
        const controller = new AbortController();
        let reloadLabels = 0, notices = 0;
        const app = Object.assign(Object.create(ChatApp.prototype), {
            showTicketReloadPending: () => { reloadLabels++; },
            showToast: () => { notices++; },
            isViewingSession: () => true,
            notifyTicketShortage: async (_budget, hooks) => {
                assert.equal(hooks.signal, controller.signal);
                controller.abort();
                hooks.onReloadStarted();
                return { retry: false };
            }
        });
        await assert.rejects(app.handleAcquisitionTicketShortage({ id: 'one' }, {
            requiredTickets: 5, availableTickets: 1, label: 'Model one'
        }, controller.signal), error => error.isCancelled === true);
        assert.equal(reloadLabels, 0);
        assert.equal(notices, 0);
    } finally { restore(); }
});

// The web build requires sign-in. On a freshly loaded page the account is
// still verifying its session, activating its wallet scope and running its
// first encrypted sync. A send in that window waits for this tab's own work
// (spinner showing, Stop cancels) and is never dropped with a notice; a wallet
// that already covers the turn does not wait for the sync at all.

const { default: accountService } = await import('../../chat/services/accountService.js');

function withAccountState(patch, run) {
    const previous = { ...accountService.state };
    const previousKeys = [accountService.cryptoKey, accountService.syncDerivationKey, accountService.syncIdKey, accountService.syncInitializationInFlight];
    // Unlocked: the status is derived from the keys this tab holds.
    accountService.cryptoKey = patch.status === 'none' ? null : {};
    accountService.syncDerivationKey = patch.status === 'none' ? null : {};
    accountService.syncIdKey = patch.status === 'none' ? null : {};
    Object.assign(accountService.state, {
        isReady: true, authBootstrapComplete: true, accountId: '1234567890123456', status: 'unlocked',
        sessionVerified: true, accountScopeReady: true, ticketSyncReady: true, accountHandoffPending: false, busy: false,
        ...patch
    });
    return Promise.resolve().then(run).finally(() => {
        Object.assign(accountService.state, previous);
        [accountService.cryptoKey, accountService.syncDerivationKey, accountService.syncIdKey, accountService.syncInitializationInFlight] = previousKeys;
    });
}

function signedInHarness() {
    const app = preflightHarness();
    app.signInPolicy = { required: true };
    app.getPaymentMode = () => 'tickets';
    app.accountModal = { open: () => assert.fail('A signed-in account must not be sent to the Log in dialog') };
    app.accountReadyPromise = Promise.resolve();
    return app;
}

test('a send while the wallet scope is still activating waits for it instead of being dropped', async () => {
    const app = signedInHarness();
    let reconciled = 0;
    accountService.reconcileSharedAccount = async () => { reconciled += 1; };
    await withAccountState({ accountScopeReady: false, ticketSyncReady: false }, () => withTicketClient({
        getTicketCount: () => 3, getHeldTicketCount: () => 0, isLegacyTransferRunning: () => false
    }, async () => {
        let settled = false;
        const pending = app.preflightTurnTicketBudget({ id: 'one', model: 'Model one' }, 'Hello').then(result => { settled = true; return result; });
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(settled, false, 'the send is still waiting for the scope, not dropped');
        accountService.setState({ accountScopeReady: true });
        assert.equal(await pending, true);
    }));
    delete accountService.reconcileSharedAccount;
    assert.equal(reconciled, 1);
});

test('a wallet that covers the turn never waits for the first encrypted sync', async () => {
    const app = signedInHarness();
    accountService.reconcileSharedAccount = async () => {};
    try {
        await withAccountState({ ticketSyncReady: false }, () => withTicketClient({
            getTicketCount: () => 3, getHeldTicketCount: () => 0, isLegacyTransferRunning: () => false
        }, async () => {
            const result = await Promise.race([
                app.preflightTurnTicketBudget({ id: 'one', model: 'Model one' }, 'Hello'),
                new Promise(resolve => setTimeout(() => resolve('waited'), 50))
            ]);
            assert.equal(result, true);
        }));
    } finally { delete accountService.reconcileSharedAccount; }
});

test('a shortage during start-up waits for the first sync and rechecks the wallet it delivered', async () => {
    const app = signedInHarness();
    accountService.reconcileSharedAccount = async () => {};
    let balance = 0;
    try {
        await withAccountState({ ticketSyncReady: false }, () => withTicketClient({
            getTicketCount: () => balance, getHeldTicketCount: () => 0, isLegacyTransferRunning: () => false
        }, async () => {
            let settled = false;
            const pending = app.preflightTurnTicketBudget({ id: 'one', model: 'Model one' }, 'Hello').then(result => { settled = true; return result; });
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(settled, false);
            balance = 3;
            accountService.setState({ ticketSyncReady: true });
            assert.equal(await pending, true);
        }));
    } finally { delete accountService.reconcileSharedAccount; }
});

test('a start-up wait that runs out still reports the loading notice, never a shortage dialog', async () => {
    const app = signedInHarness();
    const notices = [];
    app.showToast = message => { notices.push(message); };
    app.waitForAccountState = async () => accountService.getState();
    accountService.reconcileSharedAccount = async () => {};
    try {
        await withAccountState({ accountScopeReady: false }, () => withTicketClient({
            getTicketCount: () => 3, getHeldTicketCount: () => 0, isLegacyTransferRunning: () => false
        }, async () => {
            assert.equal(await app.preflightTurnTicketBudget({ id: 'one', model: 'Model one' }, 'Hello'), false);
        }));
    } finally { delete accountService.reconcileSharedAccount; }
    assert.deepEqual(notices, ['Your inference tickets are still loading. Try again shortly.']);
});

test('Stop during the start-up wait cancels the send', async () => {
    const app = signedInHarness();
    accountService.reconcileSharedAccount = async () => {};
    const controller = new AbortController();
    try {
        await withAccountState({ accountScopeReady: false }, () => withTicketClient({
            getTicketCount: () => 3, getHeldTicketCount: () => 0, isLegacyTransferRunning: () => false
        }, async () => {
            const pending = app.preflightTurnTicketBudget({ id: 'one', model: 'Model one' }, 'Hello', { signal: controller.signal });
            await new Promise(resolve => setTimeout(resolve, 10));
            controller.abort();
            await assert.rejects(pending, error => error.isCancelled === true);
        }));
    } finally { delete accountService.reconcileSharedAccount; }
});

test('a signed-out page still gets the Log in dialog, with no waiting', async () => {
    const app = signedInHarness();
    let opened = 0;
    app.accountModal = { open: () => { opened += 1; } };
    accountService.reconcileSharedAccount = async () => {};
    try {
        await withAccountState({ accountId: null, status: 'none', sessionVerified: false, accountScopeReady: false, ticketSyncReady: false }, async () => {
            assert.equal(await app.preflightTurnTicketBudget({ id: 'one', model: 'Model one' }, 'Hello'), false);
        });
    } finally { delete accountService.reconcileSharedAccount; }
    assert.equal(opened, 1);
});
