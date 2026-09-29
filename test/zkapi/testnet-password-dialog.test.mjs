import test from 'node:test';
import assert from 'node:assert/strict';
import { requestTestnetPassword } from '../../chat/zkapi/components/TestnetPasswordDialog.mjs';

function fixture() {
    const element = () => ({ events: {}, attributes: {}, value: '', disabled: false,
        addEventListener(type, fn) { this.events[type] = fn; },
        setAttribute(key, value) { this.attributes[key] = value; },
        removeAttribute(key) { delete this.attributes[key]; },
        focus() { this.focused = true; } });
    const nodes = Object.fromEntries(['input', '[type="submit"]', '[role="alert"]', '[data-cancel]', 'form'].map(key => [key, element()]));
    const dialog = { ...element(), querySelector: key => nodes[key],
        showModal() { this.open = true; }, close() { this.open = false; }, remove() { this.removed = true; } };
    const doc = { createElement: tag => { assert.equal(tag, 'dialog'); return dialog; },
        body: { append() {} }, activeElement: { isConnected: true, focus() {} } };
    return { doc, dialog, input: nodes.input, error: nodes['[role="alert"]'], submit: nodes['[type="submit"]'],
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

test('stopping the caller closes the password prompt without submitting anything', async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = requestTestnetPassword({ signal: controller.signal, authenticate: () => assert.fail('no submit') }, f.doc);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(f.dialog.removed, true);
    assert.equal(f.input.value, '');
});
