import test from 'node:test';
import assert from 'node:assert/strict';
import AccountModal from '../../chat/components/AccountModal.js';

function fixture(t, error) {
    const previous = globalThis.document;
    const modal = Object.create(AccountModal.prototype);
    const calls = [];
    let currentInput = null;
    modal.accountState = { error };
    modal.accountService = { clearErrors() {
        calls.push(['clear', modal.usernameInputValue]);
        modal.accountState.error = null;
        // The account subscription synchronously replaces the input subtree.
        currentInput = {
            value: modal.usernameInputValue,
            focus() { calls.push(['focus']); },
            setSelectionRange(...args) { calls.push(['selection', ...args]); }
        };
    } };
    globalThis.document = { getElementById: id => id === 'account-username-input' ? currentInput : null };
    t.after(() => { globalThis.document = previous; });
    return { modal, calls, currentInput: () => currentInput };
}

test('editing a username error preserves text, focus and backward selection after synchronous replacement', t => {
    const f = fixture(t, 'Enter a username to continue.');
    f.modal.handleUsernameInput({ target: {
        value: 'alice-updated', selectionStart: 2, selectionEnd: 6, selectionDirection: 'backward'
    } });
    assert.equal(f.currentInput().value, 'alice-updated');
    assert.equal(f.modal.accountState.error, null);
    assert.deepEqual(f.calls, [['clear', 'alice-updated'], ['focus'], ['selection', 2, 6, 'backward']]);
    f.modal.handleUsernameInput({ target: { value: 'alice-updated-more', selectionStart: 18, selectionEnd: 18 } });
    assert.equal(f.modal.usernameInputValue, 'alice-updated-more');
    assert.equal(f.calls.length, 3, 'later keystrokes do not rerender an already valid field');
});

test('username editing does not hide provider, passkey or general connection errors', t => {
    const f = fixture(t, null);
    for (const error of ['Google sign-in could not finish.', 'Passkey request timed out.', 'Network unavailable.', null]) {
        f.modal.accountState.error = error;
        f.modal.handleUsernameInput({ target: { value: 'new-name' } });
        assert.equal(f.modal.usernameInputValue, 'new-name');
        assert.equal(f.modal.accountState.error, error);
        assert.deepEqual(f.calls, []);
    }
});

test('IME composition preserves its live field until a committed input event', t => {
    const f = fixture(t, 'Username must be 3–32 characters.');
    f.modal.handleUsernameInput({ isComposing: true, target: { value: 'a' } });
    assert.deepEqual(f.calls, []);
    assert.equal(f.modal.usernameInputValue, 'a');
    assert.equal(f.modal.accountState.error, 'Username must be 3–32 characters.');
    f.modal.handleUsernameInput({ isComposing: false, target: { value: 'alice', selectionStart: 5, selectionEnd: 5, selectionDirection: 'none' } });
    assert.equal(f.modal.accountState.error, null);
    assert.deepEqual(f.calls, [['clear', 'alice'], ['focus'], ['selection', 5, 5, 'none']]);
});

test('editing still succeeds for inputs without a selection API', t => {
    const f = fixture(t, 'That username is unavailable.');
    assert.doesNotThrow(() => f.modal.handleUsernameInput({ target: { value: 'another-name' } }));
    assert.deepEqual(f.calls, [['clear', 'another-name'], ['focus']]);
});

test('Enter confirms IME text without submitting; a subsequent regular Enter submits once', t => {
    const previous = globalThis.document;
    const input = {};
    globalThis.document = { getElementById: id => id === 'account-username-input' ? input : null };
    t.after(() => { globalThis.document = previous; });
    const modal = Object.create(AccountModal.prototype);
    let submits = 0;
    let prevented = 0;
    modal.handleAccountContinue = () => { submits += 1; };
    modal.attachEventListeners();
    const enter = { key: 'Enter', preventDefault() { prevented += 1; } };
    input.onkeydown({ ...enter, isComposing: true });
    input.onkeydown({ ...enter, isComposing: false, keyCode: 229 });
    assert.equal(submits, 0);
    assert.equal(prevented, 0, 'native composition confirmation is allowed');
    input.onkeydown({ ...enter, isComposing: false, keyCode: 13 });
    assert.equal(submits, 1);
    assert.equal(prevented, 1, 'normal submit prevents duplicate form handling');
});
