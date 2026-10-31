import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createDaemonAuthorizationFlow,
    isAccountReadyForDaemon
} from '../../chat/application/daemonAuthorizationFlow.js';

const READY = { accountId: 'a', sessionVerified: true, status: 'unlocked', accountScopeReady: true, busy: false };
const INTENT = { transaction: 'T'.repeat(43), daemonPublicKey: 'k', savedAt: 0 };

function harness({ state = {}, intent = INTENT, devices = null, modalOpen = false } = {}) {
    const calls = { authorize: [], devices: 0, modalOpens: 0, cleared: [], devicesCleared: 0 };
    const listeners = {};
    const world = { state, clock: 0, tick: null };
    const modal = { isOpen: modalOpen, open: () => { calls.modalOpens += 1; modal.isOpen = true; } };
    let pendingIntent = intent;
    let pendingDevices = devices;
    const flow = createDaemonAuthorizationFlow({
        accountService: { getState: () => world.state },
        accountModal: () => modal,
        openAuthorization: value => {
            if (world.dialogBusy) return false;
            calls.authorize.push(value);
            return true;
        },
        openDevices: () => {
            if (world.dialogBusy) return false;
            calls.devices += 1;
            return true;
        },
        windowImpl: { addEventListener: (name, handler) => { listeners[name] = handler; } },
        consumeIntent: () => { const value = pendingIntent; pendingIntent = null; return value; },
        consumeDevices: () => { const value = pendingDevices; pendingDevices = null; return value; },
        clearIntent: transaction => { calls.cleared.push(transaction); },
        clearDevices: () => { calls.devicesCleared += 1; },
        now: () => world.clock,
        setIntervalImpl: handler => { world.tick = handler; return 1; },
        clearIntervalImpl: () => { world.tick = null; }
    });
    return {
        flow, calls, modal, world, listeners,
        advance(ms, next) {
            world.clock += ms;
            if (next) world.state = next;
            world.tick?.();
        },
        arrive(value) { pendingIntent = value; listeners.hashchange(); },
        arriveDevices() { pendingDevices = { savedAt: world.clock }; listeners.hashchange(); }
    };
}

test('the account is ready only when the sign-in flows have finished', () => {
    assert.equal(isAccountReadyForDaemon(READY), true);
    for (const patch of [
        { accountId: null }, { sessionVerified: false }, { status: 'locked' }, { accountScopeReady: false },
        { busy: true }, { accountHandoffPending: true }, { oauthSetupRequired: true }
    ]) {
        assert.equal(isAccountReadyForDaemon({ ...READY, ...patch }), false, JSON.stringify(patch));
    }
});

test('nothing opens before the initial account route has finished', () => {
    const { flow, calls } = harness({ state: READY });
    assert.equal(calls.authorize.length, 0);
    flow.start();
    assert.deepEqual(calls.authorize, [INTENT]);
});

test('signed in already: the dialog opens with no sign-in prompt', () => {
    const { flow, calls, world } = harness({ state: READY });
    flow.start();
    assert.equal(calls.modalOpens, 0);
    assert.equal(world.tick, null, 'stops checking');
});

test('signed out: sign-in is offered once, then the dialog follows', () => {
    const { flow, calls, modal, advance } = harness({ state: { accountId: null } });
    flow.start();
    assert.equal(calls.modalOpens, 1);
    advance(500);
    assert.equal(calls.modalOpens, 1);
    assert.equal(calls.authorize.length, 0);

    // A new account's own steps keep the dialog open while the account is ready.
    advance(500, READY);
    assert.equal(calls.authorize.length, 0);
    modal.isOpen = false;
    advance(500);
    assert.deepEqual(calls.authorize, [INTENT]);
    advance(500);
    assert.equal(calls.authorize.length, 1, 'opens once');
});

test('closing the sign-in dialog does not reopen it, and signing in later still works', () => {
    const { flow, calls, modal, advance } = harness({ state: { accountId: null } });
    flow.start();
    modal.isOpen = false;
    advance(5000);
    assert.equal(calls.modalOpens, 1);
    advance(500, READY);
    assert.equal(calls.authorize.length, 1);
});

test('a restoring account gets time before sign-in is offered', () => {
    const restoring = { accountId: 'a', sessionVerified: false, status: 'locked' };
    const { flow, calls, advance } = harness({ state: restoring });
    flow.start();
    advance(500);
    assert.equal(calls.modalOpens, 0);
    advance(3000);
    assert.equal(calls.modalOpens, 1);
});

test('an intent past its lifetime is dropped, not shown', () => {
    const { flow, calls, world, advance } = harness({ state: { accountId: null } });
    flow.start();
    advance(16 * 60 * 1000, READY);
    assert.equal(calls.authorize.length, 0);
    assert.deepEqual(calls.cleared, [INTENT.transaction]);
    assert.equal(world.tick, null);
});

test('a link opened in a tab already on the app is picked up', () => {
    const { flow, calls, arrive, arriveDevices } = harness({ state: READY, intent: null });
    flow.start();
    assert.equal(calls.authorize.length, 0);
    arrive({ ...INTENT, savedAt: 1 });
    assert.equal(calls.authorize.length, 1);
    arriveDevices();
    assert.equal(calls.devices, 1);
});

test('the devices view needs the same ready account', () => {
    const { flow, calls, advance } = harness({ state: { accountId: null }, intent: null, devices: { savedAt: 0 } });
    flow.start();
    assert.equal(calls.devices, 0);
    assert.equal(calls.modalOpens, 1);
    calls.modalOpens = 0;
    advance(500, READY);
    assert.equal(calls.devices, 0, 'waits for the sign-in dialog');
});

test('a request stays pending while an approval runs, then opens once', () => {
    const { flow, calls, world, arrive, advance } = harness({ state: READY, intent: null });
    flow.start();
    world.dialogBusy = true;
    const newer = { ...INTENT, transaction: 'N'.repeat(43), savedAt: 0 };
    arrive(newer);
    advance(500);
    assert.equal(calls.authorize.length, 0);
    assert.equal(flow.pending().intent, newer);
    assert.equal(calls.cleared.length, 0, 'the saved request is kept');
    world.dialogBusy = false;
    advance(500);
    assert.deepEqual(calls.authorize, [newer]);
    assert.equal(world.tick, null);
    advance(500);
    assert.equal(calls.authorize.length, 1);
});

test('the newest of several waiting requests wins', () => {
    const { flow, calls, world, arrive, advance } = harness({ state: READY, intent: null });
    flow.start();
    world.dialogBusy = true;
    arrive({ ...INTENT, transaction: 'A'.repeat(43), savedAt: 0 });
    const last = { ...INTENT, transaction: 'B'.repeat(43), savedAt: 0 };
    arrive(last);
    world.dialogBusy = false;
    advance(500);
    assert.deepEqual(calls.authorize, [last]);
});

test('the devices request is cleared only once the list took it, and it expires', () => {
    const shown = harness({ state: READY, intent: null, devices: { savedAt: 0 } });
    shown.world.dialogBusy = true;
    shown.flow.start();
    assert.equal(shown.calls.devicesCleared, 0);
    assert.ok(shown.flow.pending().devices);
    shown.world.dialogBusy = false;
    shown.advance(500);
    assert.equal(shown.calls.devices, 1);
    assert.equal(shown.calls.devicesCleared, 1);

    const late = harness({ state: { accountId: null }, intent: null, devices: { savedAt: 0 } });
    late.flow.start();
    late.modal.isOpen = false;
    late.advance(16 * 60 * 1000, READY);
    assert.equal(late.calls.devices, 0);
    assert.equal(late.calls.devicesCleared, 1);
});

test('after a same-tab sign-in a saved devices request opens for whichever account arrives', () => {
    const { flow, calls, modal, advance } = harness({ state: { accountId: null }, intent: null, devices: { savedAt: 0 } });
    flow.start();
    assert.equal(calls.modalOpens, 1, 'signed out: sign-in comes first');
    assert.equal(calls.devices, 0);
    modal.isOpen = false;
    advance(500, READY);
    assert.equal(calls.devices, 1);
});
