import test from 'node:test';
import assert from 'node:assert/strict';
import AccountModal from '../../chat/zkapi/components/AccountModal.js';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { renderZkapiComposerStatus } from '../../chat/zkapi/components/ZkapiStateExperience.js';

function depositModal() {
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, {
        view: 'balance', busy: false, status: '', statusError: false,
        privateBalanceHelpOpen: {}, journeyKind: null, journeyLast: null,
        overlay: { querySelector: () => null },
        escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
        render() {}, renderWithdrawalStatusLink: () => ''
    });
    return modal;
}

test('deposit parser rejects alternate number syntax and unsafe precision before wallet work', () => {
    for (const value of ['1e3', '0x10', '+2', '1,000', 'Infinity', 'NaN', '0.0000001', '9007199254.740992']) {
        const modal = depositModal();
        modal.run = () => assert.fail(`wallet work started for ${value}`);
        modal.startDeposit(value);
        assert.equal(modal.outcome?.field, 'deposit', value);
        assert.equal(modal.depositAmount, value, 'the user can correct the original input');
    }
});

test('smallest unit and maximum safe amount retain exact input through the SDK boundary', async t => {
    const received = [];
    t.mock.method(zkapiClient, 'deposit', async amount => { received.push(amount); });
    for (const value of ['0.000001', '9007199254.740991', ' 2.50 ']) {
        const modal = depositModal();
        modal.setStatus = () => {};
        modal.run = action => action(() => {});
        await modal.startDeposit(value);
        assert.equal(modal.depositAmount, null, 'successful submission clears the editable amount');
    }
    assert.deepEqual(received, ['0.000001', '9007199254.740991', ' 2.50 ']);
});

test('background balance render retains invalid amount and associated error', t => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config };
    Object.assign(zkapiClient, { wallet: { note: null }, config: { funding: { chain_id: 1 } } });
    t.after(() => Object.assign(zkapiClient, original));
    const modal = depositModal();
    modal.run = () => assert.fail('invalid input must not reach wallet');
    modal.startDeposit('0');
    for (let refresh = 0; refresh < 3; refresh += 1) {
        const html = modal.renderBalance();
        assert.match(html, /id="zkapi-deposit-amount"[^>]*aria-invalid="true"[^>]*aria-describedby="zkapi-deposit-error"[^>]*value="0"/);
        assert.match(html, /id="zkapi-deposit-error" role="alert"[^>]*>Enter an amount greater than zero\./);
    }
});

test('pending submitted deposits never expose a fresh-deposit action or editable amount', t => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config };
    t.after(() => Object.assign(zkapiClient, original));
    for (const phase of ['submitted', 'awaiting_wallet', 'ambiguous', 'dropped_or_pending']) {
        Object.assign(zkapiClient, { wallet: { note: null }, config: { funding: {}, pending_deposit: { phase, amount: 2_000_000 } } });
        const html = depositModal().renderBalance();
        assert.doesNotMatch(html, /id="zkapi-deposit-(?:amount|btn)"/, phase);
        assert.match(html, /id="zkapi-check-deposit-btn"/, phase);
    }
});

function toastHarness(t) {
    const previous = globalThis.document;
    let toast = null;
    let dialogOpen = false;
    let mode = 'zkapi';
    const calls = [];
    globalThis.document = { getElementById(id) {
        if (id === 'app-toast') return toast;
        if (id === 'payment-balance-modal' && dialogOpen) return { classList: { contains: () => false } };
        return null;
    } };
    const app = {
        integration: { getMode: () => mode },
        showToast(text) { toast = { textContent: text }; calls.push(text); },
        clearToast() { calls.push('clear'); toast = null; }
    };
    const element = { dataset: {}, removeAttribute() {} };
    const render = (phase = 'requesting', busy = true) => renderZkapiComposerStatus(element, app, {
        proposal: 'quiet', showComposer: false,
        primary: { phase, busy, tone: 'working', compact: phase === 'closing' ? 'Closing previous chat' : 'Requesting private key' }
    });
    t.after(() => { mode = 'tickets'; render(); globalThis.document = previous; });
    return { render, calls, setMode: value => { mode = value; }, setDialog: value => { dialogOpen = value; },
        replaceToast: value => { toast = { textContent: value }; }, text: () => toast?.textContent };
}

test('OA mode preserves unrelated result toasts while clearing ownership of old phase notifications', t => {
    const h = toastHarness(t);
    h.render();
    h.replaceToast('Account unlocked');
    h.setMode('tickets');
    h.render('closing');
    assert.equal(h.text(), 'Account unlocked');
    assert.deepEqual(h.calls, ['Requesting private key']);
    h.setMode('zkapi');
    h.render();
    assert.deepEqual(h.calls, ['Requesting private key', 'Requesting private key'], 'a later operation can announce the same phase again');
});

test('opening the balance dialog removes duplicate phase toast and closing restores ongoing status', t => {
    const h = toastHarness(t);
    h.render();
    h.setDialog(true);
    h.render();
    assert.equal(h.text(), undefined);
    h.setDialog(false);
    h.render();
    assert.equal(h.text(), 'Requesting private key');
    h.render('ready', false);
    assert.equal(h.text(), undefined);
    assert.deepEqual(h.calls, ['Requesting private key', 'clear', 'Requesting private key', 'clear']);
});

test('every active zkAPI phase stays quiet in OA ticket mode', t => {
    const h = toastHarness(t);
    h.setMode('tickets');
    for (const phase of ['requesting', 'queued', 'closing', 'wallet', 'confirming', 'proof']) h.render(phase);
    assert.deepEqual(h.calls, []);
});
