import test from 'node:test';
import assert from 'node:assert/strict';
import { revealWithdrawalTopUp } from '../../chat/zkapi/components/WalletModalMotion.js';

function fixture({ reduced = false, top = 400, bottom = 650 } = {}) {
    const calls = [], listeners = new Map();
    const copy = { focus: options => calls.push(['focus', options]) };
    const panel = { style: {}, dataset: { open: 'true' }, offsetWidth: 300,
        ownerDocument: { defaultView: { matchMedia: () => ({ matches: reduced }) } },
        querySelector: () => copy,
        getBoundingClientRect: () => ({ top, bottom, height: bottom - top }) };
    const scroll = { scrollTop: 50, scrollHeight: 1000, clientHeight: 400,
        getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: type => listeners.delete(type),
        scrollTo: options => calls.push(['scroll', options]) };
    const root = { querySelector: selector => selector === '.zkapi-fee-topup' ? panel : scroll };
    const owner = { isOpen: true, view: 'withdraw', overlay: root, withdrawalFees: { scope: 'a' },
        withdrawalFeeTopUp: 'a', withdrawalTopUpReveal: { scope: 'a' } };
    let finish;
    const animation = { finished: new Promise(resolve => { finish = resolve; }) };
    return { owner, calls, listeners, animation, finish, panel };
}
const tick = () => Promise.resolve();

test('Add ETH waits for layout, then smoothly reveals only the missing controls', async () => {
    const f = fixture(); revealWithdrawalTopUp(f.owner, f.animation);
    assert.deepEqual(f.calls, [['focus', { preventScroll: true }]]);
    f.finish(); await tick();
    assert.deepEqual(f.calls[1], ['scroll', { top: 208, behavior: 'smooth' }]);
    assert.equal(f.owner.withdrawalTopUpReveal, null);
    assert.equal(f.listeners.size, 0);
    revealWithdrawalTopUp(f.owner); await tick();
    assert.equal(f.calls.length, 2, 'a quote refresh does not replay the reveal');
});

test('already visible controls never cause scrolling', async () => {
    const f = fixture({ top: 150, bottom: 450 }); revealWithdrawalTopUp(f.owner); await tick();
    assert.equal(f.calls.some(([type]) => type === 'scroll'), false);
});

test('a tall section starts at its amount, not its footer', async () => {
    const f = fixture({ top: 400, bottom: 1000 }); revealWithdrawalTopUp(f.owner); await tick();
    assert.deepEqual(f.calls[1], ['scroll', { top: 342, behavior: 'smooth' }]);
});

test('reduced motion uses immediate visibility and immediate scrolling', async () => {
    const f = fixture({ reduced: true }); revealWithdrawalTopUp(f.owner); await tick();
    assert.equal(f.panel.style.transition, undefined);
    assert.deepEqual(f.calls[1], ['scroll', { top: 208, behavior: 'instant' }]);
});

for (const reason of ['wheel', 'keydown', 'pointerdown', 'close', 'scope', 'rerender']) {
    test(`pending reveal does not scroll after ${reason}`, async () => {
        const f = fixture(); revealWithdrawalTopUp(f.owner, f.animation);
        if (f.listeners.has(reason)) f.listeners.get(reason)();
        else if (reason === 'close') f.owner.isOpen = false;
        else if (reason === 'scope') f.owner.withdrawalFees.scope = 'b';
        else f.owner.overlay.querySelector = () => ({});
        f.finish(); await tick();
        assert.equal(f.calls.some(([type]) => type === 'scroll'), false);
    });
}

test('rerender transfers the intent without refocusing or letting the old render scroll', async () => {
    const f = fixture(); revealWithdrawalTopUp(f.owner, f.animation);
    revealWithdrawalTopUp(f.owner); await tick();
    f.finish(); await tick();
    assert.equal(f.calls.filter(([type]) => type === 'focus').length, 1);
    assert.equal(f.calls.filter(([type]) => type === 'scroll').length, 1);
});

test('a replacement copy control inherits only current focus during background rendering', async t => {
    const { captureWalletView, restoreWalletView } = await import('../../chat/zkapi/components/WalletMethodControls.js');
    const beforeDocument = globalThis.document;
    t.after(() => { globalThis.document = beforeDocument; });
    const f = fixture();
    const oldCopy = { matches: selector => selector === '[data-withdrawal-fee-copy]' };
    const newCopy = { focus: options => f.calls.push(['restored-focus', options]) };
    globalThis.document = { activeElement: oldCopy };
    f.owner.overlay.contains = node => node === oldCopy;
    const saved = captureWalletView(f.owner);
    const oldPanel = f.panel;
    const newPanel = { ...oldPanel, querySelector: () => newCopy };
    revealWithdrawalTopUp(f.owner, f.animation);
    const oldQuery = f.owner.overlay.querySelector;
    f.owner.overlay.querySelector = selector => selector === '.zkapi-fee-topup' ? newPanel
        : selector === '[data-withdrawal-fee-copy]' ? newCopy : oldQuery(selector);
    globalThis.document.activeElement = {};
    restoreWalletView(f.owner, saved);
    revealWithdrawalTopUp(f.owner); await tick();
    f.finish(); await tick();
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'restored-focus'), [['restored-focus', { preventScroll: true }]]);
    assert.equal(f.calls.filter(([kind]) => kind === 'scroll').length, 1);
    // After the user moves elsewhere, future renders must not reclaim focus.
    const other = captureWalletView(f.owner);
    restoreWalletView(f.owner, other);
    assert.equal(f.calls.filter(([kind]) => kind === 'restored-focus').length, 1);
});
