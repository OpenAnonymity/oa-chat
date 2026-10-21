import test from 'node:test';
import assert from 'node:assert/strict';
import { requestTestnetPassword } from '../../chat/zkapi/components/TestnetPasswordDialog.mjs';

function fixture() {
    const element = () => ({ events: {}, attributes: {}, value: '', disabled: false,
        addEventListener(type, fn) { this.events[type] = fn; },
        setAttribute(key, value) { this.attributes[key] = value; },
        removeAttribute(key) { delete this.attributes[key]; },
        focus() { this.focused = true; } });
    const nodes = Object.fromEntries(['#zkapi-testnet-password', '[data-remember]', '[type="submit"]', '[role="alert"]', '[data-cancel]', 'form'].map(key => [key, element()]));
    const dialog = { ...element(), querySelector: key => nodes[key],
        showModal() { this.open = true; }, close() { this.open = false; }, remove() { this.removed = true; } };
    const doc = { createElement: tag => { assert.equal(tag, 'dialog'); return dialog; },
        body: { append() {} }, activeElement: { isConnected: true, focus() {} } };
    return { doc, dialog, input: nodes['#zkapi-testnet-password'], remember: nodes['[data-remember]'], error: nodes['[role="alert"]'], submit: nodes['[type="submit"]'],
        send: () => nodes.form.events.submit({ preventDefault() {} }), cancel: () => nodes['[data-cancel]'].events.click() };
}

test('password dialog keeps rejected values out of HTML and errors, then clears accepted input', async () => {
    const f = fixture();
    const seen = [];
    const pending = requestTestnetPassword({ authenticate: async value => {
        seen.push(value);
        if (seen.length === 1) throw Object.assign(new Error(`raw ${value}`), { code: 'testnet_password_required' });
    } }, f.doc);
    f.input.value = 'bad-private-password';
    await f.send();
    assert.equal(f.input.value, '');
    assert.equal(f.error.textContent, 'That password was not accepted. Try again.');
    assert.doesNotMatch(f.dialog.innerHTML + f.error.textContent, /bad-private-password/);
    assert.equal(f.submit.disabled, false);
    f.input.value = 'accepted-private-password';
    await f.send();
    await pending;
    assert.equal(f.input.value, '');
    assert.equal(f.dialog.removed, true);
    assert.equal(f.dialog.open, false);
});

test('cancel aborts an in-flight validation and discards the field immediately', async () => {
    const f = fixture();
    let finish;
    let validationSignal;
    const pending = requestTestnetPassword({ authenticate: async (_value, { signal }) => {
        validationSignal = signal;
        await new Promise(resolve => { finish = resolve; });
        signal.throwIfAborted();
    } }, f.doc);
    f.input.value = 'password-in-flight';
    const checking = f.send();
    assert.equal(f.submit.disabled, true);
    f.cancel();
    await assert.rejects(pending, { code: 'testnet_auth_canceled', isCancelled: true });
    assert.equal(validationSignal.aborted, true);
    assert.equal(f.input.value, '');
    assert.equal(f.dialog.removed, true);
    finish();
    await checking;
    assert.equal(f.error.textContent, '');
});

test('the Remember choice is shown only when storage is usable and is passed to authenticate', async () => {
    const tabOnly = fixture();
    const options = [];
    const first = requestTestnetPassword({ authenticate: async (_value, opts) => { options.push(opts); } }, tabOnly.doc);
    assert.doesNotMatch(tabOnly.dialog.innerHTML, /data-remember/);
    assert.match(tabOnly.dialog.innerHTML, /Kept only in this tab/);
    tabOnly.input.value = 'tab-only-password';
    await tabOnly.send();
    await first;
    assert.equal('remember' in options[0], false);

    const offered = fixture();
    const second = requestTestnetPassword({ remember: true, authenticate: async (_value, opts) => { options.push(opts); } }, offered.doc);
    assert.match(offered.dialog.innerHTML, /<input type="checkbox" data-remember checked \/> Remember in this browser/);
    assert.doesNotMatch(offered.dialog.innerHTML, /Kept only in this tab/);
    offered.remember.checked = false;
    offered.input.value = 'not-remembered-password';
    await offered.send();
    await second;
    assert.equal(options[1].remember, false);
    assert.equal(offered.input.value, '');
});

test('stopping the caller closes the password prompt without submitting anything', async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = requestTestnetPassword({ signal: controller.signal, authenticate: () => assert.fail('no submit') }, f.doc);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(f.dialog.removed, true);
    assert.equal(f.input.value, '');
});
