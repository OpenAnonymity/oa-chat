import test from 'node:test';
import assert from 'node:assert/strict';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import AccountModal from '../../chat/zkapi/components/AccountModal.js';

function setup(t, { config = {}, note = null, withdrawal = null, failInit = false } = {}) {
    const original = { config: zkapiClient.config, wallet: zkapiClient.wallet, withdrawal: zkapiClient.withdrawal };
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
    globalThis.window = { addEventListener() {} };
    let loaded;
    const loading = new Promise(resolve => { loaded = resolve; });
    let subscriber;
    t.mock.method(zkapiClient, 'subscribe', fn => { subscriber = fn; return () => {}; });
    t.mock.method(zkapiClient, 'subscribeClock', () => () => {});
    t.mock.method(zkapiClient, 'init', async () => {
        await loading;
        Object.assign(zkapiClient, { config, wallet: { note }, withdrawal });
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
    const modal = new AccountModal({});
    return { modal, classes, refresh, mutations, notify: () => subscriber({}, { reason: 'refresh' }),
        load: async () => { loaded(); await new Promise(resolve => setImmediate(resolve)); } };
}

test('reload opens saved approval/deposit progress once without resubmitting', async t => {
    const f = setup(t, { config: { pending_deposit: { phase: 'prepared', approval: { phase: 'submitted' } } } });
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

test('escape safety-window progress reopens after reload', async t => {
    const f = setup(t, { withdrawal: { phase: 'pending', mode: 'escape' } });
    await f.load();
    assert.equal(f.modal.view, 'withdraw');
    assert.equal(f.modal.isOpen, true);
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
