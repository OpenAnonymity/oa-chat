import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingDisclosure, revealFundingDisclosure, attachFundingDisclosures } from '../../chat/zkapi/components/FundingDisclosures.js';
import { fundingSetupGuide } from '../../chat/zkapi/components/FundingSetupGuide.js';

function fixture({ reduced = false } = {}) {
    let sequence = 0, now = 0;
    const timers = new Map(), frames = new Map(), listeners = new Map();
    const view = {
        performance: { now: () => now },
        matchMedia: () => ({ matches: reduced }),
        getComputedStyle: () => ({ getPropertyValue: name => name === '--acc-expand' ? '420ms' : '320ms' }),
        setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
        clearTimeout: id => timers.delete(id),
        requestAnimationFrame: fn => { const id = ++sequence; frames.set(id, fn); return id; },
        cancelAnimationFrame: id => frames.delete(id)
    };
    const doc = { defaultView: view, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
    const scroller = { scrollTop: 0, clientHeight: 400, scrollHeight: 1100, getBoundingClientRect: () => ({ top: 100 }) };
    const item = { ownerDocument: doc, isConnected: true, dataset: { open: 'true' }, getBoundingClientRect: () => ({ top: 300 - scroller.scrollTop, height: 600 }) };
    return { item, scroller, timers, frames, listeners,
        runTimer() { const calls = [...timers.values()]; timers.clear(); calls.forEach(t => t.fn()); },
        frame(time) { now = time; const calls = [...frames.values()]; frames.clear(); calls.forEach(fn => fn(time)); }
    };
}

test('expansion settles before scrolling to a fixed target', () => {
    const f = fixture(); revealFundingDisclosure(f.item, f.scroller);
    assert.equal([...f.timers.values()][0].delay, 420);
    assert.equal(f.scroller.scrollTop, 0);
    f.runTimer(); f.frame(420); f.frame(580);
    assert.equal(f.scroller.scrollTop, 94);
    f.frame(740);
    assert.equal(f.scroller.scrollTop, 188);
    assert.equal(f.frames.size + f.timers.size + f.listeners.size, 0);
});

test('short content already in view does not scroll', () => {
    const f = fixture(); f.item.getBoundingClientRect = () => ({ top: 200, height: 80 });
    revealFundingDisclosure(f.item, f.scroller); f.runTimer(); f.frame(420);
    assert.equal(f.scroller.scrollTop, 0);
    assert.equal(f.frames.size + f.listeners.size, 0);
});

test('manual interaction, close, rerender and disposal cancel deferred scrolling', () => {
    for (const cause of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'close', 'removed', 'dispose']) {
        const f = fixture(); const dispose = revealFundingDisclosure(f.item, f.scroller);
        if (cause === 'close') f.item.dataset.open = 'false';
        else if (cause === 'removed') f.item.isConnected = false;
        else if (cause === 'dispose') dispose();
        else f.listeners.get(cause)();
        f.runTimer(); f.frame(420); f.frame(740);
        assert.equal(f.scroller.scrollTop, 0, cause);
        assert.equal(f.frames.size + f.timers.size + f.listeners.size, 0, cause);
    }
});

test('reduced motion reveals immediately without animated scrolling', () => {
    const f = fixture({ reduced: true }); revealFundingDisclosure(f.item, f.scroller);
    assert.equal([...f.timers.values()][0].delay, 0);
    f.runTimer(); f.frame(0); f.frame(0);
    assert.equal(f.scroller.scrollTop, 188);
    assert.equal(f.frames.size + f.listeners.size, 0);
});

test('clicks change one disclosure in place and preserve history controls', () => {
    const items = ['setup', 'billing', 'history'].map(key => {
        const handlers = new Map();
        const button = { expanded: 'false', setAttribute: (_, value) => { button.expanded = value; },
            addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
        const panel = { inert: true };
        return { dataset: { fundingDisclosure: key, open: 'false' }, button, panel, handlers,
            querySelector: sel => sel === '.t-acc-head' ? button : panel };
    });
    const changes = {};
    const root = { querySelectorAll: () => items, querySelector: () => null };
    const dispose = attachFundingDisclosures(root, (key, open) => { changes[key] = open; });
    for (const i of [0, 1, 2, 2]) items[i].handlers.get('click')();
    assert.deepEqual(changes, { setup: false, billing: false, history: false });
    assert.ok(items.every(i => i.panel.inert && i.button.expanded === 'false'));
    items[2].handlers.get('click')();
    assert.equal(changes.history, true);
    assert.equal(items[2].panel.inert, false);
    dispose();
    assert.ok(items.every(i => i.handlers.size === 0));
});

test('setup stays one disclosure and distinguishes mainnet from test tokens', () => {
    const mainnet = fundingSetupGuide({ mainnet: true });
    assert.equal((mainnet.match(/data-funding-disclosure=/g) || []).length, 1);
    assert.equal((mainnet.match(/<li>/g) || []).length, 4);
    assert.match(mainnet, /USDC on Ethereum/);
    assert.match(mainnet, /same MetaMask account/);
    assert.doesNotMatch(mainnet, /Buying options|identity checks|show you the network fee/);
    const testnet = fundingSetupGuide({ mainnet: false, demoMintEnabled: true, scope: 'welcome' });
    assert.match(testnet, /No real ETH or USDC purchase/);
    assert.match(testnet, /zkapi-welcome-setup/);
    assert.doesNotMatch(testnet, /How to buy in MetaMask/);
    assert.match(fundingDisclosure({ key: 'history', label: 'Payment history', body: 'History' }), /aria-expanded="false"/);
});

function motionFixture(options) {
    const f = fixture(options);
    const handlers = new Map();
    const button = { setAttribute() {}, addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
    f.item.dataset = { fundingDisclosure: 'history', open: 'false' };
    f.item.querySelector = selector => selector === '.t-acc-head' ? button : {};
    f.root = { ownerDocument: f.item.ownerDocument, querySelectorAll: () => [f.item], querySelector: () => f.scroller };
    f.click = () => handlers.get('click')();
    return f;
}

test('history motion guards background renders through expansion and follow-up scroll', () => {
    const f = motionFixture(), motion = [];
    const dispose = attachFundingDisclosures(f.root, () => {}, active => motion.push(active));
    f.click();
    assert.deepEqual(motion, [true]);
    assert.ok([...f.timers.values()].some(timer => timer.delay > 420 + 320));
    // A second click cancels the opening hold and replaces it with the close hold.
    f.click();
    assert.equal(f.timers.size, 1);
    assert.deepEqual(motion, [true, true]);
    f.runTimer();
    assert.deepEqual(motion, [true, true, false]);
    f.click(); dispose(); f.runTimer();
    assert.deepEqual(motion, [true, true, false, true]);
    assert.equal(f.timers.size + f.frames.size + f.listeners.size, 0);
});

test('reduced motion does not defer background updates', () => {
    const f = motionFixture({ reduced: true }), motion = [];
    const dispose = attachFundingDisclosures(f.root, () => {}, active => motion.push(active));
    f.click();
    assert.deepEqual(motion, [false]);
    assert.ok([...f.timers.values()].every(timer => timer.delay === 0));
    dispose();
});
