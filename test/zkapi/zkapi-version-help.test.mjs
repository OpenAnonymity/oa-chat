import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import { NOW_MS, activatedRegistry, normalizedSnapshot, resolvedTable } from './_registryFixtures.mjs';
import { createDocument, keyEvent, MiniEvent } from './_miniDom.mjs';

// The protocol-version pill of the balance dialog and its `?`
// (docs/ZKAPI_VERSIONING.md, "Upgrade UX"): what the pill and the help say
// for every registry row (the current row v4, protocol 0.4, is shown as
// "zkAPI v0.2"; the older rows keep their own names), that the `?` is a real
// disclosure button, and that it opens and closes the way the dialog's other
// help does. The dialog is the real AccountModal with the page's real version
// helpers (versioning/ui.js), rendered into the small DOM of _miniDom.mjs.

// A document the dialog can render into. The small DOM bubbles events through
// elements; the document's own listeners (the help's outside click and its
// capturing Escape) are kept here and called around each dispatch.
const document = createDocument();
const documentListeners = [];
document.addEventListener = (type, listener, capture = false) => {
    documentListeners.push({ type, listener, capture: capture === true || capture?.capture === true });
};
document.removeEventListener = (type, listener, capture = false) => {
    const wanted = capture === true || capture?.capture === true;
    const at = documentListeners.findIndex(entry => entry.type === type && entry.listener === listener && entry.capture === wanted);
    if (at >= 0) documentListeners.splice(at, 1);
};
const storage = new Map();
const webStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: key => { storage.delete(key); }
};
globalThis.localStorage = webStorage;
globalThis.sessionStorage = webStorage;
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', href: 'http://localhost/', reload() {} };
globalThis.window.addEventListener = () => {};
globalThis.window.removeEventListener = () => {};
globalThis.window.dispatchEvent = () => {};
globalThis.document = document;

const { default: zkapiClient } = await import('@openanonymity/zkapi-browser-sdk/client');
const { default: AccountModal } = await import('../../chat/zkapi/components/AccountModal.js');
const { createVersionUi } = await import('../../chat/zkapi/versioning/ui.js');
const { renderVersionBadge } = await import('../../chat/zkapi/components/VersionNotices.js');

// -- Dispatch, as a browser would ---------------------------------------------

function dispatch(target, event) {
    event.target = target;
    // The small DOM's events have no stopImmediatePropagation; the help's
    // capturing Escape uses it to keep the dialog's own Escape from running.
    event.stopImmediatePropagation = () => { event.propagationStopped = true; };
    for (const entry of documentListeners.filter(item => item.type === event.type && item.capture)) {
        if (!event.propagationStopped) entry.listener(event);
    }
    if (event.propagationStopped) return event;
    target.dispatchEvent(event);
    for (const entry of documentListeners.filter(item => item.type === event.type && !item.capture)) {
        if (!event.propagationStopped) entry.listener(event);
    }
    return event;
}

// A click (mouse or tap) on an element: its own listeners, then the document's.
function click(element) {
    return dispatch(element, new MiniEvent('click'));
}

// A key pressed on the focused element. A real <button> turns Enter (on
// keydown) and Space (on keyup) into a click unless a handler prevented it:
// that native activation is modelled here only for <button> elements, so the
// test passes only while the `?` is one.
function press(element, key) {
    const down = dispatch(element, keyEvent('keydown', key));
    const up = dispatch(element, keyEvent('keyup', key));
    const activates = element.tagName === 'button' && element.type === 'button' && !element.disabled;
    if (activates && key === 'Enter' && !down.defaultPrevented) click(element);
    if (activates && key === ' ' && !up.defaultPrevented && !down.defaultPrevented) click(element);
}

// -- States -----------------------------------------------------------------------

const DAY = 86_400;
const NOW_S = Math.floor(NOW_MS / 1000);
const TABLE = resolvedTable(activatedRegistry(), 'mainnet');
const [V1, V2] = TABLE;

function selectionFor(version) {
    return { version, reason: 'runtime_holds_note', slotOwner: version.id, open: {}, credits: {}, foreignDeploymentId: null,
        depositBlock: null, draftDiscarded: false, slotKind: 'note' };
}

// A balance of `active` with 20 days left, deposits going to V2.
function holderOf(active = V1) {
    return deriveVersionState({
        table: TABLE, active, target: V2, selection: selectionFor(active),
        snapshot: normalizedSnapshot({ hasNote: true, expiryTs: NOW_S + 20 * DAY, deadlines: [{ source: 'slot', expiryTs: NOW_S + 20 * DAY }] }),
        intent: null, previewSelection: null, now: NOW_MS, busy: false, admissionClosed: false, buildClosed: false,
        configBlock: false, unreachable: false, adapter: getAdapter(active.adapter)
    });
}

// The rows of the shipped registry, as the facade's table carries them.
const REGISTRY = JSON.parse(fs.readFileSync(new URL('../../deployments/zkapi/registry.json', import.meta.url), 'utf8'));
const REAL = Object.fromEntries(REGISTRY.versions.map(row => [row.id, {
    id: row.id, label: row.label, protocolVersion: row.protocolVersion, adapter: row.adapter
}]));
const REAL_TABLE = Object.values(REAL);

// A VersionState of the shipped registry: a balance on `currentId`, deposits
// going to `targetId` (a ref, as VersionState carries it: id and label only).
function realState(currentId, targetId = 'v4', currentOverrides = {}) {
    const row = REAL[currentId];
    return {
        show: true,
        current: { id: row.id, label: row.label, protocolVersion: row.protocolVersion,
            status: currentId === targetId ? 'active' : 'exit-only', ...currentOverrides },
        target: { id: targetId, label: REAL[targetId].label },
        phase: 'current', gate: { canStart: currentId === targetId, code: currentId === targetId ? null : 'deposits_closed' }
    };
}

// The page's helpers over a facade that knows the shipped table.
const realUi = state => createVersionUi({ facade: { table: REAL_TABLE, state: () => state } });
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, ' ').replace(/\s+/g, ' ').trim();

// -- The dialog -----------------------------------------------------------------

function facadeFor(state) {
    const facade = {
        multiVersion: true, state: () => state, depositGate: () => state.gate, table: TABLE, target: V2, active: V1,
        selection: selectionFor(V1), subscribe: () => () => {}, registerBusy: () => () => {},
        beginUpgrade() {}, endUpgrade() {}, acknowledgeReminder() {}
    };
    facade.ui = createVersionUi({ facade });
    return facade;
}

function dialog(t, state = holderOf(V1)) {
    const original = {
        wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawals: zkapiClient.withdrawals,
        deposits: zkapiClient.deposits, withdrawal: zkapiClient.withdrawal, oaVersioning: zkapiClient.oaVersioning
    };
    const note = { note_id: 7, deposit_amount: 2_000_000, current_balance: 1_500_000, expiry_ts: Math.floor(Date.now() / 1000) + 20 * DAY };
    Object.assign(zkapiClient, {
        wallet: { has_note: true, note },
        config: { funding: { chain_id: 1, billing_asset: 'native_eth', billing_unit: 'gwei', native_asset_wei_per_unit: '1000000000',
            contract_address: `0x${'4'.repeat(40)}` } },
        withdrawals: [], deposits: [], withdrawal: null, oaVersioning: facadeFor(state)
    });
    const overlay = document.createElement('div');
    overlay.classList.add('zkapi-funding-overlay');
    document.body.append(overlay);
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, { busy: false, fundingBusy: false, isOpen: true, view: 'balance', status: '', statusError: false,
        withdrawMode: 'mutual', privateBalanceHelpOpen: {}, overlay, walletMethodReady: true });
    t.after(() => {
        modal.disposePrivateBalanceHelp?.();
        modal.disposeFundingDisclosures?.();
        overlay.remove();
        Object.assign(zkapiClient, original);
        if (original.oaVersioning === undefined) delete zkapiClient.oaVersioning;
        document.activeElement = document.body;
        storage.clear();
    });
    modal.render();
    return { modal, overlay };
}

const toggleOf = overlay => overlay.querySelector('#zkapi-modal-version-help-toggle');
const panelOf = overlay => overlay.querySelector('#zkapi-modal-version-help');

// ---------------------------------------------------------------------------
// The `?` is a disclosure button
// ---------------------------------------------------------------------------

test('the version ? is a real button whose aria-controls names the rendered panel', t => {
    const { overlay } = dialog(t);
    const toggle = toggleOf(overlay);
    assert.ok(toggle, 'the toggle is rendered beside the pill');
    assert.equal(toggle.tagName, 'button');
    assert.equal(toggle.getAttribute('type'), 'button');
    assert.equal(toggle.getAttribute('data-zkapi-help'), 'version');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.getAttribute('aria-controls'), 'zkapi-modal-version-help');
    assert.ok(toggle.getAttribute('aria-label'), 'it has an accessible name');
    assert.equal(toggle.textContent, '?');
    // The 16px circle of the old tooltip, now focusable as a button.
    for (const name of ['h-4', 'w-4', 'rounded-full', 'border', 'text-[9px]']) assert.ok(toggle.classList.contains(name), name);
    assert.ok(toggle.closest('[data-zkapi-version-badge-group]'), 'beside the pill');
    // The panel it controls is in the balance card, hidden until opened.
    const panel = panelOf(overlay);
    assert.ok(panel, 'aria-controls names an element that exists');
    assert.equal(panel.getAttribute('data-zkapi-help-content'), 'version');
    assert.equal(panel.hidden, true);
    assert.ok(panel.closest('.zkapi-balance-card'));
    // No tooltip-only stand-in is left.
    assert.equal(overlay.querySelector('[role="img"]'), null);
    assert.doesNotMatch(overlay.innerHTML, /The zkAPI protocol version this balance uses/);
});

test('click or tap opens and closes the version help', t => {
    const { modal, overlay } = dialog(t);
    const toggle = toggleOf(overlay);
    click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(panelOf(overlay).hidden, false);
    assert.equal(modal.privateBalanceHelpOpen.version, true);
    assert.match(textOf(panelOf(overlay).innerHTML), /About versions/);
    assert.match(textOf(panelOf(overlay).innerHTML), /Your balance is on zkAPI v0\.1\./);
    click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(panelOf(overlay).hidden, true);
    assert.equal(modal.privateBalanceHelpOpen.version, false);
    // Opening it closes the expiry help beside it, and the other way round.
    click(overlay.querySelector('#zkapi-modal-expiry-help-toggle'));
    click(toggle);
    assert.equal(overlay.querySelector('#zkapi-modal-expiry-help').hidden, true);
    assert.equal(panelOf(overlay).hidden, false);
});

test('Enter and Space on the focused ? toggle the version help', t => {
    const { overlay } = dialog(t);
    const toggle = toggleOf(overlay);
    toggle.focus();
    press(toggle, 'Enter');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(panelOf(overlay).hidden, false);
    press(toggle, 'Enter');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(panelOf(overlay).hidden, true);
    press(toggle, ' ');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(panelOf(overlay).hidden, false);
    press(toggle, ' ');
    assert.equal(panelOf(overlay).hidden, true);
    assert.equal(document.activeElement, toggle, 'focus stays on the button');
});

test('Escape closes the version help and returns focus to the ?, before the dialog', t => {
    const { modal, overlay } = dialog(t);
    let dialogClosed = 0;
    // The dialog's own Escape (bubbling, on the document) must not run.
    document.addEventListener('keydown', event => { if (event.key === 'Escape') dialogClosed += 1; });
    t.after(() => documentListeners.splice(documentListeners.findIndex(entry => entry.type === 'keydown' && !entry.capture), 1));
    const toggle = toggleOf(overlay);
    click(toggle);
    // Focus moved into the panel's text (a reader selecting it) or elsewhere
    // in the dialog: Escape still closes and puts focus back on the `?`.
    overlay.querySelector('.zkapi-balance-amount').focus();
    const escape = dispatch(overlay.querySelector('.zkapi-balance-amount'), keyEvent('keydown', 'Escape'));
    assert.equal(escape.defaultPrevented, true);
    assert.equal(panelOf(overlay).hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(modal.privateBalanceHelpOpen.version, false);
    assert.equal(document.activeElement, toggle);
    assert.equal(dialogClosed, 0, 'the first Escape closes the help, not the dialog');
    // With nothing open, Escape is the dialog's again.
    dispatch(toggle, keyEvent('keydown', 'Escape'));
    assert.equal(dialogClosed, 1);
});

test('a click outside closes the version help; a click inside its panel does not', t => {
    const { modal, overlay } = dialog(t);
    const toggle = toggleOf(overlay);
    click(toggle);
    click(panelOf(overlay).querySelector('p'));
    assert.equal(panelOf(overlay).hidden, false, 'reading the panel keeps it open');
    click(overlay.querySelector('.zkapi-balance-amount'));
    assert.equal(panelOf(overlay).hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(modal.privateBalanceHelpOpen.version, false);
});

test('the open version help, and focus on its ?, survive a re-render', t => {
    const { modal, overlay } = dialog(t);
    click(toggleOf(overlay));
    toggleOf(overlay).focus();
    // Something else on the page changes: the dialog draws itself again.
    modal.renderedMarkup = null;
    modal.render();
    const toggle = toggleOf(overlay);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(panelOf(overlay).hidden, false);
    assert.equal(document.activeElement, toggle, 'focus is restored to the new button');
    // And the new button is wired: it closes what it opened.
    click(toggle);
    assert.equal(panelOf(overlay).hidden, true);
    assert.equal(modal.privateBalanceHelpOpen.version, false);
    modal.renderedMarkup = null;
    modal.render();
    assert.equal(toggleOf(overlay).getAttribute('aria-expanded'), 'false');
    assert.equal(panelOf(overlay).hidden, true);
});

// ---------------------------------------------------------------------------
// What the pill and its help say, by registry row
// ---------------------------------------------------------------------------

test('the shipped registry keeps v4 at protocol 0.4: the zkAPI v0.2 name is display only', () => {
    assert.deepEqual(REGISTRY.versions.map(row => [row.id, row.label, row.protocolVersion]),
        [['v1', 'Version 1', '0.1'], ['v2', 'Version 2', '0.2'], ['v3', 'Version 3', '0.3'], ['v4', 'Version 4', '0.4']]);
    // No display field was added to a row.
    for (const row of REGISTRY.versions) {
        assert.equal(Object.keys(row).some(key => /display/i.test(key)), false, row.id);
    }
});

test('the current balance (v4) is pilled and explained as zkAPI v0.2, never as version 4', () => {
    const state = realState('v4');
    const ui = realUi(state);
    const badge = ui.badge(state, { surface: 'dialog' });
    assert.match(badge, /data-zkapi-version-badge[^>]*>zkAPI v0\.2<\/span>/);
    assert.doesNotMatch(badge, /A new version is available/);
    const help = ui.help('version', state);
    assert.equal(help.title, 'About versions');
    assert.equal(help.body, 'Your balance is on zkAPI v0.2, the latest version.');
    assert.doesNotMatch(`${badge} ${help.body}`, /version 4|\bv4\b|0\.4/i);
});

test('older balances keep their own names, and the help says where new deposits go', () => {
    const v1 = realState('v1');
    const v1Help = realUi(v1).help('version', v1).body;
    assert.match(realUi(v1).badge(v1, { surface: 'dialog' }), />zkAPI v0\.1<\/span>/);
    assert.equal(v1Help, 'Your balance is on zkAPI v0.1. It keeps working, but new deposits go to zkAPI v0.2, '
        + 'the latest version. To move your balance, withdraw it and deposit again.');
    const v3 = realState('v3');
    assert.match(realUi(v3).badge(v3, { surface: 'dialog' }), />zkAPI v0\.3<\/span>/);
    assert.match(realUi(v3).help('version', v3).body, /^Your balance is on zkAPI v0\.3\. .*new deposits go to zkAPI v0\.2, the latest version\./);
    for (const state of [v1, v3]) {
        assert.doesNotMatch(realUi(state).help('version', state).body, /version 4|\bv4\b|0\.4/i);
    }
});

test('version 2 and the current version share a name: the help calls the older one an earlier build', () => {
    const v2 = realState('v2');
    const ui = realUi(v2);
    // Version 2 keeps its accurate name.
    assert.match(ui.badge(v2, { surface: 'dialog' }), />zkAPI v0\.2<\/span>/);
    const body = ui.help('version', v2).body;
    assert.equal(body, 'Your balance is on an earlier build. It keeps working, but new deposits go to the latest build '
        + 'of zkAPI v0.2. To move your balance, withdraw it and deposit again.');
    // One name is never said of two versions in the same explanation.
    assert.equal(body.match(/zkAPI v0\.2/g).length, 1);
    assert.doesNotMatch(body, /version 4|\bv4\b|0\.4/i);
});

test('without a protocol version the pill and help fall back to the registry name; without a state, to the general text', () => {
    const state = realState('v1', 'v4', { protocolVersion: null });
    const ui = realUi(state);
    assert.match(ui.badge(state, { surface: 'dialog' }), />Version 1<\/span>/);
    assert.match(ui.help('version', state).body, /^Your balance is on version 1\. It keeps working, but new deposits go to zkAPI v0\.2/);
    const current = realState('v1', 'v1', { protocolVersion: null });
    assert.equal(realUi(current).help('version', current).body, 'Your balance is on version 1, the latest version.');
    // No version context at all: what is true of every build.
    const general = createVersionUi({ facade: null }).help('version', null);
    assert.match(general.body, /stays on the version it was deposited into/);
});

// ---------------------------------------------------------------------------
// The pill's casing
// ---------------------------------------------------------------------------

test('the version pill is printed as written: zkAPI v0.2, not capitalized by CSS', () => {
    // Comments blanked (same length), so positions and brace depth are exact.
    const css = fs.readFileSync(new URL('../../chat/zkapi/zkapi.css', import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, comment => ' '.repeat(comment.length));
    const rule = selector => {
        const at = css.search(new RegExp(`(^|\\n)${selector.replace(/[.-]/g, '\\$&')}\\s*\\{`));
        assert.ok(at >= 0, `${selector} rule`);
        // Top level: not inside an at-rule (an unclosed @media would scope it).
        const before = css.slice(0, at);
        assert.equal(before.split('{').length - before.split('}').length, 0, `${selector} is a top-level rule`);
        const start = css.indexOf('{', at);
        return { at, body: css.slice(start + 1, css.indexOf('}', start)) };
    };
    const pill = rule('.zkapi-pill');
    const version = rule('.zkapi-version-pill');
    // The other pills keep their look.
    assert.match(pill.body, /text-transform:\s*capitalize/);
    // The version pill turns it off, after .zkapi-pill at the same specificity.
    assert.match(version.body, /text-transform:\s*none/);
    assert.ok(version.at > pill.at, 'later in the cascade than .zkapi-pill');
    // The dialog's pill carries both classes, and its text is the product name.
    const html = renderVersionBadge(realState('v4'), { surface: 'dialog' });
    assert.match(html, /class="zkapi-version-pill zkapi-pill[^"]*"[^>]*>zkAPI v0\.2</);
});
