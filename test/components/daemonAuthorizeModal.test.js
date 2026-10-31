import test from 'node:test';
import assert from 'node:assert/strict';
import DaemonAuthorizeModal from '../../chat/components/DaemonAuthorizeModal.js';
import {
    bytesToBase64Url,
    daemonPublicKeyHash,
    DAEMON_INTENT_STORAGE_KEY
} from '../../chat/services/daemonAuthorization.js';

const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const POINT = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));

// The little of the DOM the dialog touches. Controls found by a selector keep
// their listeners, so a test can click them after the dialog has moved on.
function fakeElement() {
    const controls = new Map();
    const element = {
        value: '', disabled: false, dataset: {}, listeners: {},
        classList: { add() {}, remove() {} },
        style: { getPropertyValue: () => '', getPropertyPriority: () => '' },
        setAttribute() {}, removeAttribute() {}, remove() { element.removed = true; }, focus() {},
        addEventListener: (name, handler) => { element.listeners[name] = handler; },
        querySelector(selector) {
            if (selector === '#daemon-authorize-code' && !element.markup?.includes('daemon-authorize-code')) return null;
            if (!controls.has(selector)) controls.set(selector, fakeElement());
            return controls.get(selector);
        },
        querySelectorAll(selector) {
            return element.markup?.includes('daemon-device-revoke') && selector === '.daemon-device-revoke'
                ? [element.querySelector(selector)]
                : [];
        },
        set innerHTML(value) { element.markup = value; controls.clear(); },
        get innerHTML() { return element.markup; }
    };
    return element;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

// Lets WebCrypto and held promises finish: waits out the current dialog's lookup, not a clock.
let shown = null;
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
    for (let i = 0; i < 20000; i += 1) {
        if (predicate()) return;
        await turn();
    }
    throw new Error(`Never reached: ${label}; status ${shown?.session?.getState().status}`);
}
async function settle() {
    for (let i = 0; i < 5000 && shown?.session?.getState().status === 'loading'; i += 1) await turn();
    for (let i = 0; i < 5; i += 1) await turn();
}

async function withDialog(run) {
    const original = { document: globalThis.document, sessionStorage: globalThis.sessionStorage };
    const overlays = [];
    const keyListeners = new Set();
    const values = new Map();
    globalThis.document = {
        body: { appendChild: element => overlays.push(element) },
        createElement: () => fakeElement(),
        addEventListener: (_name, handler) => keyListeners.add(handler),
        removeEventListener: (_name, handler) => keyListeners.delete(handler)
    };
    Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
    });
    try {
        const timers = [];
        const subscribers = new Set();
        const held = new Map();
        const calls = [];
        const accountService = {
            state: { accountId: '1234567890123456', encryptionMode: 'LEGACY_PASSKEY' },
            loginGeneration: 1,
            getState() { return this.state; },
            subscribe: handler => { subscribers.add(handler); return () => subscribers.delete(handler); },
            notify() { subscribers.forEach(handler => handler(this.state)); },
            revealMasterKeyForDaemon: async () => new Uint8Array(32).fill(3),
            daemonAuthRequest: (route, body, options) => {
                calls.push({ route, body, options });
                const gate = held.get(route);
                if (gate) return gate.promise;
                if (route === '/auth/daemon/lookup') {
                    return daemonPublicKeyHash(POINT).then(hash => ({ clientName: 'oa-clientd', clientVersion: '1', expiresIn: 600, daemonPublicKeyHash: hash, transaction: body.transaction }));
                }
                if (route === '/auth/daemon/devices/list') return Promise.resolve({ devices: [] });
                return Promise.resolve({ success: true });
            }
        };
        const modal = new DaemonAuthorizeModal({
            accountService,
            origin: 'https://staging.test',
            setTimer: handler => { timers.push(handler); return timers.length; },
            clearTimer: () => {}
        });
        shown = modal;
        const hold = route => { const gate = deferred(); held.set(route, gate); return gate; };
        const release = route => held.delete(route);
        await run({ modal, accountService, overlays, keyListeners, timers, hold, release, calls, values });
    } finally {
        globalThis.document = original.document;
        Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: original.sessionStorage });
    }
}

const intent = letter => ({ transaction: letter.repeat(43), daemonPublicKey: POINT, savedAt: 0 });
const saved = (values, transaction) => values.set(DAEMON_INTENT_STORAGE_KEY, JSON.stringify({ transaction }));
const pressEscape = keyListeners => [...keyListeners].forEach(handler => handler({ key: 'Escape' }));

test('a device list answered after its dialog closed cannot replace a newer dialog', async () => {
    await withDialog(async ({ modal, overlays, keyListeners, hold, release }) => {
        const list = hold('/auth/daemon/devices/list');
        assert.equal(modal.openDevices(), true);
        pressEscape(keyListeners);
        release('/auth/daemon/devices/list');
        assert.equal(modal.open(intent('A')), true);
        await settle();
        const overlay = overlays.at(-1);
        assert.notEqual(overlays[0], overlay);
        assert.match(overlay.innerHTML, /Authorize this computer/);
        list.resolve({ devices: [{ id: 'old', clientVersion: '1', authorizedAt: 1 }] });
        await settle();
        assert.match(overlay.innerHTML, /Authorize this computer/);
        assert.doesNotMatch(overlay.innerHTML, /Authorized computers/);
        assert.equal(overlays[0].innerHTML, undefined, 'nor is the closed dialog drawn');
    });
});

test('a lookup answered after its dialog was replaced stays out of the new one', async () => {
    await withDialog(async ({ modal, overlays, hold, release, values }) => {
        const lookup = hold('/auth/daemon/lookup');
        modal.open(intent('A'));
        release('/auth/daemon/lookup');
        saved(values, 'B'.repeat(43));
        assert.equal(modal.open(intent('B')), true, 'an idle dialog is replaced');
        await settle();
        const overlay = overlays.at(-1);
        const reviewed = overlay.innerHTML;
        assert.match(reviewed, /Authorize this computer/);
        lookup.resolve({ expiresIn: 1, daemonPublicKeyHash: 'wrong' });
        await settle();
        assert.equal(overlay.innerHTML, reviewed);
    });
});

test('an old expiry timer and old controls cannot touch a newer dialog', async () => {
    await withDialog(async ({ modal, overlays, timers, calls }) => {
        modal.open(intent('A'));
        await settle();
        const first = overlays[0];
        const oldApprove = first.querySelector('.daemon-authorize-approve').listeners.click;
        const oldDecline = first.querySelector('.daemon-authorize-decline').listeners.click;
        const oldTimer = timers[0];
        assert.equal(typeof oldTimer, 'function');
        modal.open(intent('B'));
        await settle();
        const overlay = overlays.at(-1);
        const reviewed = overlay.innerHTML;
        const before = calls.length;
        oldTimer();
        oldApprove();
        oldDecline();
        await settle();
        assert.equal(overlay.innerHTML, reviewed);
        assert.equal(calls.length, before);
        assert.equal(modal.isOpen, true);
    });
});

test('replacing a review declines it, and the same request is not reopened', async () => {
    await withDialog(async ({ modal, overlays, calls }) => {
        modal.open(intent('A'));
        await settle();
        assert.equal(modal.open(intent('A')), true);
        assert.equal(overlays.length, 1);
        modal.open(intent('B'));
        await settle();
        assert.deepEqual(calls.filter(call => call.route === '/auth/daemon/deny').map(call => call.body.transaction), ['A'.repeat(43)]);
        assert.equal(overlays.length, 2);
    });
});

test('during an approval a newer request waits; closing the old one keeps its saved copy', async () => {
    await withDialog(async ({ modal, overlays, hold, release, values }) => {
        saved(values, 'A'.repeat(43));
        modal.open(intent('A'));
        await settle();
        const first = overlays[0];
        first.querySelector('#daemon-authorize-code').value = 'ABCD-EFGH';
        const approve = hold('/auth/daemon/approve');
        first.querySelector('.daemon-authorize-approve').listeners.click();
        await until(() => modal.session.getState().status === 'approving', 'approving');

        saved(values, 'B'.repeat(43));
        assert.equal(modal.open(intent('B')), false, 'the running approval keeps the screen');
        assert.equal(modal.openDevices(), false);
        assert.equal(overlays.length, 1);

        approve.resolve({ success: true });
        release('/auth/daemon/approve');
        await until(() => modal.session.getState().status !== 'approving', 'approval answered');
        assert.equal(modal.session.getState().status, 'done');
        assert.match(JSON.parse(values.get(DAEMON_INTENT_STORAGE_KEY)).transaction, /^B/);

        first.querySelector('.daemon-authorize-close').listeners.click();
        assert.match(JSON.parse(values.get(DAEMON_INTENT_STORAGE_KEY)).transaction, /^B/, 'the newer request is still saved');
        assert.equal(modal.open(intent('B')), true);
        await settle();
        assert.match(overlays.at(-1).innerHTML, /Authorize this computer/);
    });
});

test('a devices list waits for an authorization dialog, but gives way to a new request', async () => {
    await withDialog(async ({ modal, overlays }) => {
        modal.open(intent('A'));
        await settle();
        assert.equal(modal.openDevices(), false);
        modal.close();
        assert.equal(modal.openDevices(), true);
        await settle();
        assert.equal(modal.openDevices(), true, 'already showing');
        assert.equal(overlays.length, 2);
        assert.equal(modal.open(intent('B')), true);
        await settle();
        assert.match(overlays.at(-1).innerHTML, /Authorize this computer/);
    });
});

test('an account change closes the device list and ends an idle authorization', async () => {
    await withDialog(async ({ modal, accountService, overlays }) => {
        modal.openDevices();
        await settle();
        accountService.state = { ...accountService.state, accountId: '9999999999999999' };
        accountService.notify();
        assert.equal(modal.isOpen, false);

        accountService.state = { ...accountService.state, accountId: '1234567890123456' };
        modal.open(intent('A'));
        await settle();
        accountService.loginGeneration += 1;
        accountService.notify();
        assert.match(overlays.at(-1).innerHTML, /Authorization failed/);
    });
});

test('a finished request leaves the saved intent, so a reload cannot reopen it', async () => {
    await withDialog(async ({ modal, overlays, values }) => {
        saved(values, 'A'.repeat(43));
        modal.open(intent('A'));
        await settle();
        const overlay = overlays[0];
        overlay.querySelector('#daemon-authorize-code').value = 'ABCD-EFGH';
        overlay.querySelector('.daemon-authorize-approve').listeners.click();
        await until(() => !['approving', 'review'].includes(modal.session.getState().status), 'approval finished');
        assert.equal(modal.session.getState().status, 'done');
        assert.equal(values.has(DAEMON_INTENT_STORAGE_KEY), false);
    });
});
