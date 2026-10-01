import test from 'node:test';
import assert from 'node:assert/strict';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import AccountModal from '../../chat/zkapi/components/AccountModal.js';
import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import { addressFundingWallet } from '../../chat/zkapi/services/addressFundingProvider.mjs';

function setup(t, { config = {}, note = null, withdrawal = null, failInit = false, canRestore, canOpen, savedModal, savedWelcome = false, blockedStorage = false, withdrawals = [], earlySnapshot = false } = {}) {
    const original = { config: zkapiClient.config, wallet: zkapiClient.wallet, withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals };
    const oldDocument = globalThis.document;
    const oldWindow = globalThis.window;
    const classes = new Set(['hidden']);
    const overlay = { innerHTML: '', classList: { add: c => classes.add(c), remove: c => classes.delete(c) } };
    const listeners = new Set();
    globalThis.document = {
        activeElement: null,
        getElementById: id => id === 'account-modal' ? overlay : null,
        addEventListener: (_, fn) => listeners.add(fn),
        removeEventListener: (_, fn) => listeners.delete(fn)
    };
    const storage = new Map(savedModal ? [['oa-zkapi-running-modal', JSON.stringify(savedModal)]] : []);
    if (savedWelcome) storage.set('oa-zkapi-welcome-modal', JSON.stringify({ open: true, method: 'metamask' }));
    globalThis.window = { addEventListener() {}, sessionStorage: {
        getItem(key) { if (blockedStorage) throw new Error('Storage blocked'); return storage.get(key) ?? null; },
        setItem(key, value) { if (blockedStorage) throw new Error('Storage blocked'); storage.set(key, value); },
        removeItem(key) { if (blockedStorage) throw new Error('Storage blocked'); storage.delete(key); }
    } };
    // A fresh page: the SDK has read nothing until its first refresh.
    Object.assign(zkapiClient, { config: null, wallet: { note: null }, withdrawal: null, withdrawals: [] });
    let loaded;
    const loading = new Promise(resolve => { loaded = resolve; });
    let subscriber;
    t.mock.method(zkapiClient, 'subscribe', fn => { subscriber = fn; return () => {}; });
    t.mock.method(zkapiClient, 'subscribeClock', () => () => {});
    t.mock.method(zkapiClient, 'init', async () => {
        if (earlySnapshot) {
            // The SDK reads the saved wallet first and publishes it, then
            // keeps init() running while it checks the chain.
            await Promise.resolve();
            Object.assign(zkapiClient, { config, wallet: { note }, withdrawal, withdrawals });
            subscriber?.({}, { reason: 'runtime' });
        }
        await loading;
        Object.assign(zkapiClient, { config, wallet: { note }, withdrawal, withdrawals });
        if (failInit) throw new Error('Refresh unavailable');
    });
    const refresh = t.mock.method(zkapiClient, 'refresh', async () => {});
    const mutations = ['deposit', 'withdraw', 'finalizeEscape'].map(name => t.mock.method(zkapiClient, name, () => {
        throw new Error('Restoring the modal must not submit wallet requests');
    }));
    t.mock.method(AccountModal.prototype, 'render', () => {});
    t.mock.method(AccountModal.prototype, 'updateTabIndicator', () => {});
    t.after(() => {
        Object.assign(zkapiClient, original);
        globalThis.document = oldDocument;
        globalThis.window = oldWindow;
    });
    const modal = new AccountModal({}, { ...(canRestore ? { canRestore } : {}), ...(canOpen ? { canOpen } : {}) });
    return { modal, classes, refresh, mutations, storage, notify: () => subscriber({}, { reason: 'refresh' }),
        load: async () => { loaded(); await new Promise(resolve => setImmediate(resolve)); } };
}

test('reload opens saved deposit progress once without resubmitting', async t => {
    const f = setup(t, { config: { pending_deposit: { phase: 'submitted' } } });
    assert.equal(f.modal.isOpen, false);
    await f.load();
    assert.equal(f.modal.isOpen, true);
    assert.equal(f.modal.view, 'fund');
    assert.equal(f.classes.has('hidden'), false);
    assert.equal(f.refresh.mock.callCount(), 1);
    f.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
    f.modal.close();
    f.notify();
    f.modal.restorePendingOperation();
    assert.equal(f.modal.isOpen, false, 'background refresh must not undo dismissal');
});

test('an awaiting-wallet deposit keeps its dialog intent across repeated reloads', async t => {
    const config = { pending_deposit: { phase: 'awaiting_wallet' } };
    const first = setup(t, { config });
    await first.load();
    assert.equal(first.modal.isOpen, true);
    first.notify();
    const savedModal = JSON.parse(first.storage.get('oa-zkapi-running-modal'));
    assert.equal(savedModal.view, 'fund');
    const reloaded = setup(t, { config, savedModal });
    await reloaded.load();
    assert.equal(reloaded.modal.isOpen, true);
    assert.equal(reloaded.storage.has('oa-zkapi-running-modal'), true);
    reloaded.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
    reloaded.modal.close();
    assert.equal(reloaded.storage.has('oa-zkapi-running-modal'), false);
    reloaded.notify();
    assert.equal(reloaded.modal.isOpen, false);
});

test('a finished JS action retains dialog intent if the wallet outcome is unresolved', async t => {
    const f = setup(t);
    await f.load();
    f.modal.open('fund');
    await f.modal.run(async () => { zkapiClient.config.pending_deposit = { phase: 'awaiting_wallet' }; });
    assert.equal(f.modal.busy, false);
    assert.equal(f.storage.has('oa-zkapi-running-modal'), true);
    zkapiClient.config.pending_deposit = null;
    f.notify();
    assert.equal(f.storage.has('oa-zkapi-running-modal'), true, 'an open dialog survives completion until dismissed');
});

test('explicit dialog intent is supplied to the shell after navigation is ready', async t => {
    let navigationReady = false;
    const f = setup(t, {
        savedModal: { view: 'fund' },
        config: { pending_deposit: { phase: 'awaiting_wallet' } },
        canRestore: ({ hasSavedModal }) => navigationReady && hasSavedModal
    });
    await f.load();
    assert.equal(f.modal.isOpen, false);
    assert.equal(f.storage.has('oa-zkapi-running-modal'), true);
    navigationReady = true;
    f.modal.restorePendingOperation();
    assert.equal(f.modal.isOpen, true);
    f.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
});

for (const mode of ['mutual', 'escape']) {
    test(`reload opens saved ${mode} withdrawal in the right view`, async t => {
        const f = setup(t, { config: { prepared_withdrawal: { mode, phase: 'submitted' } }, note: { note_id: 7 } });
        await f.load();
        assert.equal(f.modal.isOpen, true);
        assert.equal(f.modal.view, 'withdraw');
        assert.equal(f.modal.withdrawMode, mode);
        f.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
    });
}

test('an escape safety window (days of waiting) does not reopen on every reload', async t => {
    const f = setup(t, { withdrawal: { phase: 'pending', mode: 'escape' } });
    await f.load();
    assert.equal(f.modal.isOpen, false);
});

test('a merely saved deposit plan does not reopen', async t => {
    for (const state of [
        { config: { pending_deposit: { phase: 'prepared' } } },
        { config: { pending_deposit: { phase: 'retry_exact' } } }
    ]) {
        const f = setup(t, state);
        await f.load();
        assert.equal(f.modal.isOpen, false, JSON.stringify(state));
    }
});

test('a tickets chat never sees saved zkAPI progress reopen', async t => {
    const f = setup(t, { config: { pending_deposit: { phase: 'submitted' } }, canRestore: () => false });
    await f.load();
    assert.equal(f.modal.isOpen, false);
});

for (const state of [{}, { note: { note_id: 7 } }, { withdrawal: { phase: 'closed' } }]) {
    test(`no unfinished operation leaves the modal closed: ${JSON.stringify(state)}`, async t => {
        const f = setup(t, state);
        await f.load();
        assert.equal(f.modal.isOpen, false);
        assert.equal(f.refresh.mock.callCount(), 0);
    });
}

test('manual navigation and dismissal during loading takes precedence over restoration', async t => {
    const f = setup(t, { config: { prepared_withdrawal: { phase: 'submitted' } } });
    f.modal.open('withdrawals');
    assert.equal(f.refresh.mock.callCount(), 0, 'early open cannot capture the injected provider before manual restoration');
    f.modal.close();
    await f.load();
    assert.equal(f.modal.isOpen, false);
    assert.equal(f.modal.view, 'withdrawals');
});

test('saved progress is shown even when initialization loaded state but refresh failed', async t => {
    const f = setup(t, { config: { pending_deposit: { phase: 'submitted' } }, failInit: true });
    await f.load();
    assert.equal(f.modal.isOpen, true);
    assert.equal(f.modal.view, 'fund');
});

for (const view of ['fund', 'balance', 'withdraw', 'withdrawals']) {
    test(`reload restores running ${view} before the SDK has a transaction`, async t => {
        const f = setup(t, { savedModal: { view, mode: 'escape' } });
        f.modal.restorePendingOperation();
        assert.equal(f.modal.isOpen, false, 'wait for SDK initialization');
        await f.load();
        assert.equal(f.modal.isOpen, true);
        assert.equal(f.modal.view, view);
        assert.equal(f.modal.withdrawMode, 'escape');
        f.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
        assert.equal(f.storage.has('oa-zkapi-running-modal'), true, 'keep UI intent until the restored dialog is dismissed');
        f.modal.close();
        assert.equal(f.storage.has('oa-zkapi-running-modal'), false);
        f.notify();
        assert.equal(f.modal.isOpen, false);
    });
}

test('restoration waits for the saved chat payment mode to load', async t => {
    let eligible = false;
    const f = setup(t, { savedModal: { view: 'fund' }, canRestore: () => eligible });
    await f.load();
    assert.equal(f.modal.isOpen, false);
    eligible = true;
    f.modal.restorePendingOperation();
    assert.equal(f.modal.isOpen, true);
    f.modal.close();
    f.modal.restorePendingOperation();
    assert.equal(f.modal.isOpen, false);
});

test('reload restores an in-flight USDC approval on a prepared deposit', async t => {
    const f = setup(t, { config: { pending_deposit: { phase: 'prepared', approvals: [{ phase: 'awaiting_wallet' }] } } });
    await f.load();
    assert.equal(f.modal.isOpen, true);
    assert.equal(f.modal.view, 'fund');
    f.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
});

test('running action stores UI state and retains it on completion', async t => {
    const f = setup(t);
    await f.load();
    f.modal.open('fund');
    let complete;
    const action = f.modal.run(() => new Promise(resolve => { complete = resolve; }));
    assert.equal(JSON.parse(f.storage.get('oa-zkapi-running-modal')).view, 'fund');
    // Wallet actions re-read manual transaction ownership across tabs first.
    await new Promise(resolve => setImmediate(resolve));
    complete();
    await action;
    assert.equal(f.storage.has('oa-zkapi-running-modal'), true);
    assert.equal(f.modal.busy, false);
});

test('restricted session storage does not stop modal restoration or wallet work', async t => {
    const f = setup(t, { blockedStorage: true, config: { pending_deposit: { phase: 'submitted' } } });
    await f.load();
    assert.equal(f.modal.isOpen, true);
    let ran = false;
    await f.modal.run(async () => { ran = true; });
    assert.equal(ran, true);
    assert.equal(f.modal.busy, false);
});

test('invalid saved views are ignored', async t => {
    const f = setup(t, { savedModal: { view: 'invalid' } });
    await f.load();
    assert.equal(f.modal.isOpen, false);
});

test('a deposit settled during initialization preserves its open result through reload', async t => {
    const f = setup(t, { savedModal: { view: 'fund' }, note: { note_id: 7 } });
    await f.load();
    assert.equal(f.modal.isOpen, true);
    assert.equal(f.storage.has('oa-zkapi-running-modal'), true);
    f.notify();
    assert.equal(f.storage.has('oa-zkapi-running-modal'), true);
});

for (const phase of ['reserving', 'prepared', 'retry_exact', 'awaiting_wallet', 'submitted', 'ambiguous', 'dropped_or_pending']) {
    test(`withdrawal reload restores ${phase} without a tab marker or resubmission`, async t => {
        const f = setup(t, { config: { prepared_withdrawal: { phase, mode: 'mutual' } }, note: { note_id: 7 } });
        await f.load();
        assert.equal(f.modal.isOpen, true);
        assert.equal(f.modal.view, 'withdraw');
        f.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
    });
}
for (const phase of ['submitted_unconfirmed', 'finalizing', 'awaiting_wallet']) {
    test(`reload restores background withdrawal ${phase} in history`, async t => {
        const f = setup(t, { withdrawals: [{ recordId: 'old', phase }] });
        await f.load();
        assert.equal(f.modal.isOpen, true);
        assert.equal(f.modal.view, 'withdrawals');
        f.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
    });
}
for (const phase of ['closed', 'closed_unconfirmed', 'pending']) {
    test(`background withdrawal ${phase} does not continually reopen`, async t => {
        const f = setup(t, { withdrawals: [{ recordId: 'old', phase }] });
        await f.load();
        assert.equal(f.modal.isOpen, false);
    });
}
test('background updates wait while a disclosure is animating', async t => {
    const f = setup(t);
    await f.load();
    f.modal.open('balance');
    const rendered = f.modal.render.mock.callCount();
    f.modal.disclosureAnimating = true;
    f.notify();
    assert.equal(f.modal.render.mock.callCount(), rendered);
    assert.equal(f.modal.disclosureRefreshPending, true);
    f.modal.close();
    assert.equal(f.modal.disclosureRefreshPending, false);
});

test('queued disclosure refresh preserves a deposit input focused during the animation', async t => {
    const f = setup(t);
    await f.load();
    f.modal.open('fund');
    f.modal.handleDisclosureMotion(true);
    f.notify();
    const rendered = f.modal.render.mock.callCount();
    document.activeElement = { id: 'zkapi-deposit-amount' };
    f.modal.handleDisclosureMotion(false);
    assert.equal(f.modal.render.mock.callCount(), rendered);
    assert.equal(f.modal.disclosureRefreshPending, true);
    document.activeElement = null;
    f.modal.handleDisclosureMotion(false);
    assert.equal(f.modal.render.mock.callCount(), rendered + 1);
    assert.equal(f.modal.disclosureRefreshPending, false);
});

test('an idle deposit plan does not hide a background withdrawal on reload', async t => {
    const f = setup(t, { config: { pending_deposit: { phase: 'prepared' } }, withdrawals: [{ phase: 'submitted_unconfirmed' }] });
    await f.load();
    assert.equal(f.modal.isOpen, true);
    assert.equal(f.modal.view, 'withdrawals');
    f.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
});

for (const view of ['fund', 'withdraw', 'withdrawals']) {
    test(`an idle ${view} dialog survives repeated reloads until explicitly dismissed`, async t => {
        const f = setup(t);
        await f.load();
        f.modal.open(view);
        f.modal.fundingInputAmount = '12.34';
        f.modal.fundingInputCurrency = 'usd';
        f.modal.fundingHelpOpen = 'quote';
        f.modal.historyOpen = true;
        f.modal.fundingDestination = '0xprivate-user-destination';
        f.modal.rememberRunningModal();
        const saved = JSON.parse(f.storage.get('oa-zkapi-running-modal'));
        assert.equal(saved.view, view);
        assert.equal(saved.help, 'quote');
        assert.equal(JSON.stringify(saved).includes('destination'), false);
        const second = setup(t, { savedModal: saved });
        await second.load();
        assert.equal(second.modal.isOpen, true);
        assert.equal(second.modal.view, view);
        assert.equal(second.modal.fundingInputAmount, '12.34');
        assert.equal(second.modal.fundingHelpOpen, 'quote');
        const third = setup(t, { savedModal: JSON.parse(second.storage.get('oa-zkapi-running-modal')) });
        await third.load();
        assert.equal(third.modal.view, view);
        assert.equal(third.modal.isOpen, true);
        third.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
        third.modal.close();
        assert.equal(third.storage.has('oa-zkapi-running-modal'), false);
    });
}

test('MetaMask cancellation clears an unused SDK draft and expires its notice after seven seconds', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = setup(t);
    await f.load();
    f.modal.open('fund');
    f.modal.overlay.querySelector = () => null;
    t.mock.method(zkapiClient, 'emitChange', () => {});
    const original = { runtime: walletRuntime.runtime, manifest: walletRuntime.manifest, browserMode: zkapiClient.browserMode };
    t.after(() => { walletRuntime.runtime = original.runtime; walletRuntime.manifest = original.manifest; zkapiClient.browserMode = original.browserMode; });
    zkapiClient.browserMode = true;
    walletRuntime.manifest = { deployment_id: 'test' };
    walletRuntime.runtime = { pendingDeposit: null };
    t.mock.method(walletRuntime, 'init', async () => {});
    t.mock.method(walletRuntime, 'reload', async () => {});
    t.mock.method(walletRuntime, 'commit', async state => { walletRuntime.runtime = state; });
    f.modal.fundingInputAmount = '12';
    f.modal.depositAmount = '12';
    await f.modal.run(async report => {
        walletRuntime.runtime.pendingDeposit = { operationId: 'new', phase: 'prepared', secret: 'unused' };
        zkapiClient.config.pending_deposit = { operation_id: 'new', phase: 'prepared', amount: 12000000 };
        report('Confirm in MetaMask');
        throw Object.assign(new Error('Canceled'), { code: 4001, broadcastPossible: false });
    }, { kind: 'deposit' });
    assert.equal(walletRuntime.runtime.pendingDeposit, null);
    assert.equal(zkapiClient.config.pending_deposit, null);
    assert.equal(f.modal.depositAmount, null);
    assert.equal(f.modal.fundingInputAmount, null);
    assert.equal(f.modal.outcome.message, 'Deposit canceled.');
    t.mock.timers.tick(6999);
    assert.ok(f.modal.outcome);
    t.mock.timers.tick(1);
    assert.equal(f.modal.outcome, null);
    assert.equal(f.modal.status, '');
});

for (const phase of ['reserving', 'prepared', 'awaiting_wallet', 'ambiguous', 'submitted']) {
    test(`a stale Welcome view cannot hide ${phase} withdrawal recovery after reload`, async t => {
        const f = setup(t, { savedWelcome: true,
            config: { prepared_withdrawal: { phase, mode: 'mutual' } }, note: { note_id: 7 } });
        await f.load();
        assert.equal(f.modal.isOpen, true);
        assert.equal(f.modal.view, 'withdraw');
        assert.equal(f.storage.has('oa-zkapi-welcome-modal'), false);
        f.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
    });
}

for (const record of [
    { phase: 'ambiguous' },
    { phase: 'pending', finalizeSubmissionId: 'saved-finalization' },
    { phase: 'parked', startSubmissionId: 'saved-start' },
    { phase: 'parked', backgroundPreparationCancelable: true }
]) {
    test(`fresh tab restores unresolved background withdrawal ${JSON.stringify(record)}`, async t => {
        const f = setup(t, { withdrawals: [record], savedWelcome: true });
        await f.load();
        assert.equal(f.modal.isOpen, true);
        assert.equal(f.modal.view, 'withdrawals');
        assert.equal(f.storage.has('oa-zkapi-welcome-modal'), false);
        f.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
    });
}

test('a fresh tab restores a signed public ETH return without SDK or tab presentation records', async t => {
    const f = setup(t);
    await f.load();
    const state = addressFundingWallet.state;
    t.after(() => { addressFundingWallet.state = state; });
    addressFundingWallet.state = { ...state, pending: { kind: 'sweep', transaction: { data: '0x' } } };
    f.modal.restorePendingOnInit = true;
    f.modal.restorePendingOperation();
    assert.equal(f.modal.isOpen, true);
    assert.equal(f.modal.view, 'fund');
    f.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
});

test('a reload shows the saved withdrawal as soon as the wallet is read, not after startup checks the chain', async t => {
    const prepared = { phase: 'reserving', mode: 'mutual', clearance_reserved: true };
    const f = setup(t, { config: { prepared_withdrawal: prepared }, note: { note_id: 7 },
        savedModal: { view: 'withdraw', mode: 'mutual', method: 'metamask' }, earlySnapshot: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.modal.walletMethodReady, false, 'startup is still checking the chain');
    assert.equal(f.modal.isOpen, true, 'the dialog is back without waiting for it');
    assert.equal(f.modal.view, 'withdraw');
    f.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
    await f.load();
    assert.equal(f.modal.isOpen, true);
});

test('a Continue click during startup is kept and runs once the wallet is ready', async t => {
    const f = setup(t, { config: { prepared_withdrawal: { phase: 'prepared', mode: 'mutual' } }, note: { note_id: 7 },
        savedModal: { view: 'withdraw', mode: 'mutual', method: 'metamask' }, earlySnapshot: true });
    await new Promise(resolve => setImmediate(resolve));
    let calls = 0;
    const running = f.modal.run(async () => { calls++; }, null);
    assert.equal(f.modal.startingAfterInit, true, 'the click is acknowledged, not dropped');
    assert.equal(f.modal.run(async () => { calls++; }, null) instanceof Promise, true);
    assert.equal(calls, 0);
    await f.load();
    await running;
    assert.equal(calls, 1, 'one click, one action — a second click during startup is not a second action');
    assert.equal(f.modal.startingAfterInit, false);
});

for (const phase of ['reserving', 'prepared', 'submitted', 'ambiguous']) {
    test(`OA blocks saved ${phase} withdrawal intent and delayed open requests`, async t => {
        let privateMode = false;
        const f = setup(t, { savedModal: { view: 'withdraw', mode: 'mutual' },
            config: { prepared_withdrawal: { phase, mode: 'mutual' } }, note: { note_id: 7 },
            canRestore: () => privateMode, canOpen: () => privateMode });
        await f.load();
        f.modal.open('withdraw');
        f.notify();
        assert.equal(f.modal.isOpen, false);
        privateMode = true;
        f.modal.restorePendingOperation();
        assert.equal(f.modal.isOpen, true);
        assert.equal(f.modal.view, 'withdraw');
        privateMode = false;
        f.modal.busy = true;
        f.modal.close({ forModeChange: true });
        assert.equal(f.modal.isOpen, false, 'mode navigation hides even an in-flight dialog');
        assert.equal(f.modal.busy, true, 'hiding does not cancel the wallet operation');
        f.modal.busy = false;
        f.notify();
        assert.equal(f.modal.isOpen, false);
        f.mutations.forEach(mock => assert.equal(mock.mock.callCount(), 0));
    });
}

test('closing and reopening during startup cannot revive an earlier queued action', async t => {
    const f = setup(t, { config: {}, note: { note_id: 7 }, earlySnapshot: true });
    f.modal.open('withdraw');
    let calls = 0;
    const running = f.modal.run(async () => { calls++; });
    f.modal.close();
    f.modal.open('withdraw');
    await f.load();
    await running;
    assert.equal(calls, 0);
});
