// What the System Panel, the balance dialog and the welcome say for a balance
// this browser holds and the page cannot read (zkapi-held-balance.test.mjs pins
// the state and the words). The panels are the real ones; the facade is a
// stand-in over states derived by the real derivation, carrying the real
// helpers; the client is the SDK singleton with the fields a failed start
// leaves (test/fixtures/zkapi-legacy-start-failed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { afterEach } from 'node:test';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import { createVersionUi } from '../../chat/zkapi/versioning/ui.js';
import { versionCopyText } from '../../chat/zkapi/versioning/copy.mjs';
import { NOW_MS, activatedRegistry, normalizedSnapshot, resolvedTable } from './_registryFixtures.mjs';
import { createDocument } from './_miniDom.mjs';

const stored = new Map();
const webStorage = {
    getItem: key => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)); },
    removeItem: key => { stored.delete(key); }
};
globalThis.localStorage = webStorage;
globalThis.sessionStorage = webStorage;
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', origin: 'http://localhost', href: 'http://localhost/', reload() {} };
globalThis.window.location = globalThis.location;
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.document = {
    activeElement: null,
    documentElement: { dataset: {}, removeAttribute() {}, setAttribute() {} },
    getElementById: () => null,
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
    createElement() {
        let textContent = '';
        return {
            set textContent(value) { textContent = String(value ?? ''); },
            get textContent() { return textContent; },
            get innerHTML() {
                return textContent.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
                    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
            }
        };
    }
};
globalThis.zkapiWallet = {};
const request = result => {
    const entry = {};
    queueMicrotask(() => {
        entry.result = result;
        entry.onsuccess?.({ target: entry });
    });
    return entry;
};
globalThis.indexedDB = {
    open: () => request({
        version: 4,
        close() {},
        transaction: () => ({ objectStore: () => ({
            get: () => request(undefined), put: () => request(undefined), delete: () => request(undefined)
        }) })
    })
};

const { default: zkapiClient } = await import('@openanonymity/zkapi-browser-sdk/client');
const { default: AccountModal } = await import('../../chat/zkapi/components/AccountModal.js');
const { default: RightPanel } = await import('../../chat/zkapi/components/RightPanel.js');
const { default: WelcomePanel } = await import('../../chat/zkapi/components/WelcomePanel.js');
const { getZkapiExperience } = await import('../../chat/zkapi/components/ZkapiStateExperience.js');
const { createZkapiVersioning } = await import('../../chat/zkapi/versioning/index.js');
const { installActiveVersion, resetActiveVersionForTests } = await import('../../chat/zkapi/versioning/activeVersion.mjs');
const { createFakeStorage } = await import('./_fakeIndexedDb.mjs');
// The funding wallet's own storage and tab channel are not part of these tests
// (and an open channel keeps a bare `node --test` process alive).
const { addressFundingWallet } = await import('../../chat/zkapi/services/addressFundingProvider.mjs');
addressFundingWallet.store = { load: async () => null, save: async () => {}, keys: async () => [] };
addressFundingWallet.createChannel = () => null;

// ---------------------------------------------------------------------------
// States and the facade
// ---------------------------------------------------------------------------

const DAY = 86_400;
const NOW_S = Math.floor(NOW_MS / 1000);
const TABLE = resolvedTable(activatedRegistry(), 'mainnet');
const [V1, V2] = TABLE;
const FIXTURE = JSON.parse(fs.readFileSync(
    new URL('../fixtures/zkapi-legacy-start-failed/client.json', import.meta.url), 'utf8'
));
const NO_NOTE = { available: false, kind: null, blockedBy: 'no_note' };
const TRACES = /zkapi-operator\.invalid|config\.json|\(503\)|HTTP 503/i;
const HELD_WORDS = 'Your balance is still saved in this browser. Version 1’s service isn’t available right '
    + 'now, so the balance can’t be shown yet. Reload to check again. To use version 2, '
    + 'first withdraw this balance from version 1.';
const HELD_FALLBACK = 'Your balance is still saved in this browser, but its service isn’t available right '
    + 'now. Reload to check again.';

function selectionFor(version, overrides = {}) {
    return {
        version, reason: 'runtime_holds_note', slotOwner: version.id, open: {}, credits: {},
        foreignDeploymentId: null, depositBlock: null, draftDiscarded: false, slotKind: 'note', ...overrides
    };
}

function derive(overrides = {}) {
    const active = overrides.active || V1;
    return deriveVersionState({
        table: TABLE, active, target: V2, selection: selectionFor(active), snapshot: normalizedSnapshot(),
        intent: null, previewSelection: null, now: NOW_MS, busy: false, admissionClosed: false, buildClosed: false,
        configBlock: false, unreachable: false, adapter: getAdapter(active.adapter), ...overrides
    });
}

const held = (overrides = {}) => derive({ initFailed: true, abandon: NO_NOTE, ...overrides });
const noteSnapshot = (days = 20) => normalizedSnapshot({
    hasNote: true, expiryTs: NOW_S + days * DAY, deadlines: [{ source: 'slot', expiryTs: NOW_S + days * DAY }]
});

function facadeFor(state, { withUi = true } = {}) {
    const facade = {
        multiVersion: true,
        table: TABLE,
        target: V2,
        active: V1,
        selection: selectionFor(V1),
        state: () => state,
        depositGate: () => state.gate,
        flags: () => ({ draftDiscarded: false, discardLoop: false, admissionClosed: false, staleBuild: false,
            configMismatch: false, withdrawalConfirmed: false }),
        subscribe: () => () => {},
        registerBusy: () => () => {},
        requestSwitch() { return { ok: true }; },
        // The real facade answers from the errors its client held; this one
        // says the client's current error is the start's.
        isStartFailure: error => state.held?.unreachable === true && Boolean(error) && error === zkapiClient.lastError,
        ui: null
    };
    if (withUi) facade.ui = createVersionUi({ facade });
    return facade;
}

const escapeHtml = value => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

// What the client holds after its start failed: no config, no wallet, and the
// error that stopped it.
function failedStart(t, { note = null } = {}) {
    const original = {
        config: zkapiClient.config, wallet: zkapiClient.wallet, withdrawal: zkapiClient.withdrawal,
        withdrawals: zkapiClient.withdrawals, deposits: zkapiClient.deposits, activities: zkapiClient.activities,
        lastError: zkapiClient.lastError, loading: zkapiClient.loading, oaVersioning: zkapiClient.oaVersioning
    };
    const error = Object.assign(new Error(FIXTURE.errors.start.message), { name: FIXTURE.errors.start.name });
    Object.assign(zkapiClient, {
        config: null, wallet: note ? { has_note: true, note } : null, withdrawal: null, withdrawals: [], deposits: [],
        activities: [], lastError: note ? null : error, loading: false
    });
    t.after(() => {
        Object.assign(zkapiClient, original);
        if (original.oaVersioning === undefined) delete zkapiClient.oaVersioning;
        stored.clear();
    });
    return error;
}

// What the client holds after a quiet refresh that the host answered with its
// own page (fixture: pageAnsweredRefresh): the start error is gone, `config` and
// `wallet` are text, and nothing started.
function pageAnswered(t) {
    const error = failedStart(t);
    const answered = FIXTURE.pageAnsweredRefresh;
    Object.assign(zkapiClient, {
        lastError: answered.lastError, config: structuredClone(answered.config), wallet: structuredClone(answered.wallet),
        withdrawals: [...answered.withdrawals], deposits: [...answered.deposits]
    });
    return error;
}

// ---------------------------------------------------------------------------
// The System Panel
// ---------------------------------------------------------------------------

function renderPanel() {
    const panel = Object.create(RightPanel.prototype);
    panel.currentSession = { id: 'new-chat' };
    panel.privateBalanceHelpOpen = {};
    panel.app = { integration: {
        getTransition: () => null,
        getSessionUsageSummary: () => ({ hasEstimate: false, estimatedCostUsd: 0, promptTokens: 0, completionTokens: 0 })
    } };
    panel.escapeHtml = escapeHtml;
    return { panel, html: panel.billingSectionHTML() };
}

test('the panel says the balance is saved, not "$0.00" and "Add funds", and shows no SDK text', t => {
    const error = failedStart(t);
    zkapiClient.oaVersioning = facadeFor(held());
    const { html } = renderPanel();
    assert.match(html, /Private balance: <span class="font-semibold">Saved in this browser<\/span>/);
    // The amount, the used line, the expiry line and the add-funds line are gone.
    assert.doesNotMatch(html, /\$0\.00 used|Add funds|Deposit in progress|data-zkapi-note-expiry/);
    assert.doesNotMatch(html.slice(0, html.indexOf('data-chat-usage-estimate')), /\$0\.00/);
    assert.doesNotMatch(html, /zkapi-panel-expiry-help-toggle|id="zkapi-panel-withdraw"/);
    // The button opens the balance, and says so.
    assert.match(html, /id="zkapi-panel-fund"[^>]*>Balance details<\/button>/);
    // The notice is the one explanation, with its one button.
    assert.match(html, /data-zkapi-version-notice="held"/);
    assert.equal(textOf(html).includes(HELD_WORDS), true);
    assert.equal((html.match(/data-zkapi-version-action=/g) || []).length, 1);
    assert.match(html, /data-zkapi-version-action="reload"/);
    // The SDK's message, which names the operator, is shown nowhere.
    assert.equal(zkapiClient.lastError, error);
    assert.doesNotMatch(html, TRACES);
    assert.doesNotMatch(html, /text-destructive">[^<]/);
    // The pill is quiet: this is not an error of the balance.
    assert.match(html, /bg-muted text-muted-foreground">unavailable<\/span>/);
    assert.doesNotMatch(html, /bg-destructive\/10/);
});

test('the panel says the same when the client has no error any more, and shows no error pill or line', t => {
    pageAnswered(t);
    assert.equal(zkapiClient.lastError, null);
    zkapiClient.oaVersioning = facadeFor(held());
    const { html } = renderPanel();
    assert.match(html, /Private balance: <span class="font-semibold">Saved in this browser<\/span>/);
    assert.doesNotMatch(html, /\$0\.00 used|Add funds|Deposit in progress|data-zkapi-note-expiry/);
    assert.match(html, /id="zkapi-panel-fund"[^>]*>Balance details<\/button>/);
    assert.match(html, /data-zkapi-version-notice="held"/);
    assert.equal(textOf(html).includes(HELD_WORDS), true);
    // The pill says "unavailable" in the quiet colors, whatever the experience says.
    assert.match(html, /bg-muted text-muted-foreground">unavailable<\/span>/);
    assert.doesNotMatch(html, />attention<|>not funded<|bg-destructive\/10|text-destructive">[^<]/);
    assert.doesNotMatch(html, TRACES);
});

test('the chat bar and the balance control say the balance is unavailable when the client has no error any more', t => {
    pageAnswered(t);
    zkapiClient.oaVersioning = facadeFor(held());
    const summary = versionCopyText('held.summary');
    const experience = getZkapiExperience({}, 'new-chat');
    assert.equal(experience.primary.phase, 'error');
    assert.equal(experience.primary.title, 'Private balance unavailable');
    assert.equal(experience.primary.detail, summary);
    assert.equal(experience.primary.blocksSend, true);
    assert.equal(experience.composerPrimary.detail, summary);
    assert.doesNotMatch(JSON.stringify(experience.primary), TRACES);
    // Without the fact the same client is an unfunded wallet.
    zkapiClient.oaVersioning = facadeFor(derive({ initFailed: false, abandon: NO_NOTE, selection: selectionFor(V1, {
        reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }) }));
    assert.equal(getZkapiExperience({}, 'new-chat').primary.phase, 'unfunded');
});

test('the panel is what it was without a facade, and for a page whose SDK started and found nothing', t => {
    const error = failedStart(t);
    delete zkapiClient.oaVersioning;
    const plain = renderPanel().html;
    // Today's panel for a failed start: an empty balance and the SDK's words.
    assert.match(plain, /Private balance: <span class="font-semibold">\$0\.00<\/span>/);
    assert.match(plain, /Add funds to chat/);
    assert.match(plain, />Add funds<\/button>/);
    assert.match(plain, /text-destructive">Unable to load https:\/\/zkapi-operator\.invalid\/config\.json \(503\)\.<\/p>/);

    // A page whose SDK started and reads an empty wallet: only the version
    // fragments differ from the page with no facade.
    zkapiClient.lastError = null;
    const baseline = renderPanel().html;
    const state = derive({ initFailed: false, abandon: NO_NOTE, selection: selectionFor(V1, { reason: 'no_runtime_note',
        slotOwner: null, slotKind: 'empty' }) });
    zkapiClient.oaVersioning = facadeFor(state);
    const { panel, html } = renderPanel();
    const pieces = panel.versionPieces();
    assert.equal(html.replace(pieces.badge, '').replace(pieces.help, '').replace(pieces.banner, ''), baseline);
    assert.match(html, /\$0\.00/);
    assert.match(html, />Add funds<\/button>/);
    assert.doesNotMatch(html, /data-zkapi-version-notice="held"/);
    assert.equal(zkapiClient.lastError, null);
    assert.equal(error.message.includes('config.json'), true, 'the error that stopped the start was there');
});

test('a balance the SDK reads is the ordinary panel, with or without a failed start in the past', t => {
    failedStart(t, { note: { note_id: 7, deposit_amount: 2_000_000, current_balance: 1_610_000,
        expiry_ts: Math.floor(Date.now() / 1000) + 86_400 } });
    zkapiClient.oaVersioning = facadeFor(derive({ initFailed: true, snapshot: noteSnapshot() }));
    const { html } = renderPanel();
    assert.doesNotMatch(html, /Saved in this browser|data-zkapi-version-notice="held"/);
    assert.match(html, /data-zkapi-note-expiry/);
    assert.match(html, />Balance details<\/button>/);
    assert.match(html, /id="zkapi-panel-withdraw"/);
});

test('the panel button opens the balance, not the add-funds view, for a held balance', t => {
    failedStart(t);
    const state = held();
    zkapiClient.oaVersioning = facadeFor(state);
    const { panel, html } = renderPanel();
    const document = createDocument();
    const root = document.createElement('div');
    root.innerHTML = html;
    const events = [];
    const original = { document: globalThis.document, dispatchEvent: globalThis.dispatchEvent };
    t.after(() => { Object.assign(globalThis, original); });
    globalThis.document = { ...original.document,
        querySelector: selector => (selector === '#right-panel' ? root : null),
        getElementById: id => root.querySelector(`#${id}`) };
    globalThis.dispatchEvent = event => events.push([event.type, event.detail]);
    const base = Object.getPrototypeOf(RightPanel.prototype);
    const attach = base.attachTopSectionEventListeners;
    base.attachTopSectionEventListeners = () => {};
    t.after(() => { base.attachTopSectionEventListeners = attach; });
    panel.attachTopSectionEventListeners();
    root.querySelector('#zkapi-panel-fund').click();
    assert.deepEqual(events, [['zkapi-payment-required', { view: 'balance' }]]);
    // And an empty balance still opens the add-funds view.
    events.length = 0;
    const empty = derive({ initFailed: false, abandon: NO_NOTE, selection: selectionFor(V1, { reason: 'no_runtime_note',
        slotOwner: null, slotKind: 'empty' }) });
    zkapiClient.oaVersioning = facadeFor(empty);
    zkapiClient.lastError = null;
    const again = renderPanel();
    const second = document.createElement('div');
    second.innerHTML = again.html;
    globalThis.document.querySelector = selector => (selector === '#right-panel' ? second : null);
    globalThis.document.getElementById = id => second.querySelector(`#${id}`);
    again.panel.attachTopSectionEventListeners();
    second.querySelector('#zkapi-panel-fund').click();
    assert.deepEqual(events, [['zkapi-payment-required', { view: 'fund' }]]);
});

// ---------------------------------------------------------------------------
// The balance dialog
// ---------------------------------------------------------------------------

function overlayMock() {
    const writes = [];
    const overlay = {
        writes,
        classList: { add() {}, remove() {} },
        set innerHTML(value) { writes.push(value); overlay.html = value; },
        get innerHTML() { return overlay.html || ''; },
        querySelector: () => null,
        querySelectorAll: () => [],
        contains: () => false,
        addEventListener() {}
    };
    return overlay;
}

function dialog(overrides = {}) {
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, {
        busy: false, fundingBusy: false, isOpen: true, view: 'balance', status: '', statusError: false,
        withdrawMode: 'mutual', privateBalanceHelpOpen: {}, overlay: overlayMock(), walletMethodReady: true,
        ...overrides
    });
    return modal;
}

test('the balance view of a held balance is the held view: no add-funds form, no closed-deposits story', t => {
    failedStart(t);
    zkapiClient.oaVersioning = facadeFor(held());
    const html = dialog().renderBalance();
    assert.match(html, /data-zkapi-balance-held/);
    assert.equal(textOf(html).includes(HELD_WORDS), true);
    assert.match(html, /<h3 class="zkapi-section-title">Saved in this browser<\/h3>/);
    assert.match(html, /data-zkapi-version-action="reload"/);
    assert.equal((html.match(/data-zkapi-version-action=/g) || []).length, 1);
    assert.doesNotMatch(html, /zkapi-deposit-btn|zkapi-deposit-amount|Continue with MetaMask|Add funds|data-zkapi-deposits-closed/);
    assert.doesNotMatch(textOf(html), /Deposits have moved|Deposits moved|no longer accepts|Upgrade|Withdraw/);
    assert.doesNotMatch(html, TRACES);
    // The notice is said once: the view carries it, the banner stays out.
    assert.doesNotMatch(html, /data-zkapi-version-banner/);
    // Payment history stays, for what other versions left in this browser.
    assert.match(html, /Payment history/);
});

test('the deposits-closed view and the balance view of a held balance are the same words', t => {
    failedStart(t);
    const state = held();
    zkapiClient.oaVersioning = facadeFor(state);
    const modal = dialog();
    const version = modal.versionContext();
    const closed = textOf(modal.renderDepositsClosed(version, null));
    const balance = textOf(modal.renderBalance());
    assert.equal(closed.includes(HELD_WORDS), true);
    assert.equal(balance.includes(HELD_WORDS), true);
    assert.match(closed, /Saved in this browser/);
    assert.doesNotMatch(closed, /Deposits have moved|Deposits are closed|Add funds/);
});

test('the dialog of a held balance on the deposit target says it too, with its deposits closed', t => {
    failedStart(t);
    const state = derive({ active: V2, initFailed: true,
        abandon: { available: false, kind: null, blockedBy: 'not_applicable' } });
    assert.equal(state.depositsOpen, true);
    assert.equal(state.gate.canStart, false);
    assert.equal(state.gate.code, 'holdings_unreadable');
    const facade = facadeFor(state);
    facade.active = V2;
    zkapiClient.oaVersioning = facade;
    const html = dialog().renderBalance();
    assert.match(html, /data-zkapi-balance-held/);
    assert.equal(textOf(html).includes('Version 2’s service isn’t available right now'), true);
    assert.doesNotMatch(html, /zkapi-deposit-btn|zkapi-deposit-amount|Continue with MetaMask|To use version/);
});

test('the balance view says the same when the client has no error any more', t => {
    pageAnswered(t);
    zkapiClient.oaVersioning = facadeFor(held());
    const html = dialog().renderBalance();
    assert.match(html, /data-zkapi-balance-held/);
    assert.equal(textOf(html).includes(HELD_WORDS), true);
    assert.doesNotMatch(html, /zkapi-deposit-btn|zkapi-deposit-amount|Continue with MetaMask|Add funds|data-zkapi-deposits-closed/);
    assert.doesNotMatch(textOf(html), /Deposits have moved|Deposits moved|no longer accepts|Upgrade/);
    assert.doesNotMatch(html, TRACES);
    // The welcome has no "Payment service" line to print (there is no error),
    // and still offers no deposit.
    const welcome = Object.create(WelcomePanel.prototype);
    Object.assign(welcome, { busy: false, fundingBusy: false, isOpen: true, step: 'welcome', escapeHtml,
        app: { accountModal: { openFunding() {}, open() {} } }, overlay: overlayMock() });
    const page = welcome.renderWelcome();
    assert.match(page, /data-zkapi-balance-held/);
    assert.doesNotMatch(page, /welcome-fund-btn|welcome-deposit-amount|Continue with MetaMask|Payment service:/);
});

test('the withdraw view of a held balance says it is saved, not that there is no note', t => {
    failedStart(t);
    zkapiClient.oaVersioning = facadeFor(held());
    const html = dialog({ view: 'withdraw' }).renderWithdrawal();
    assert.match(html, /data-zkapi-balance-held/);
    assert.doesNotMatch(html, /There is no active private note|zkapi-withdraw-btn|zkapi-withdraw-confirm/);
    assert.equal(textOf(html).includes(HELD_WORDS), true);
    // Without a facade that sentence is still the one a page says for no note.
    delete zkapiClient.oaVersioning;
    assert.match(dialog({ view: 'withdraw' }).renderWithdrawal(), /There is no active private note to withdraw\./);
});

test('before the helpers arrive one plain line stands in, and still offers nothing', t => {
    failedStart(t);
    zkapiClient.oaVersioning = facadeFor(held(), { withUi: false });
    const html = dialog().renderBalance();
    assert.match(html, /data-zkapi-balance-held/);
    assert.equal(textOf(html).includes(HELD_FALLBACK), true);
    assert.doesNotMatch(html, /zkapi-deposit-btn|Continue with MetaMask|Add funds|no longer accepts/);
    assert.doesNotMatch(html, TRACES);
});

test('the dialog draws no wallet method or funding controls above a held balance', t => {
    failedStart(t);
    zkapiClient.oaVersioning = facadeFor(held());
    const modal = dialog();
    modal.render();
    const html = modal.overlay.html;
    assert.match(html, /data-zkapi-balance-held/);
    assert.doesNotMatch(html, /data-wallet-method|Wallet method|zkapi-funding-account|data-funding-amount/);
    // With nothing held the same dialog keeps them.
    const empty = derive({ initFailed: false, abandon: NO_NOTE, selection: selectionFor(V1, { reason: 'no_runtime_note',
        slotOwner: null, slotKind: 'empty' }) });
    zkapiClient.oaVersioning = facadeFor(empty);
    zkapiClient.lastError = null;
    const other = dialog();
    other.render();
    assert.match(other.overlay.html, /data-wallet-method/);
});

test('a start that fails over a held balance leaves no SDK message in the dialog’s funding line', async t => {
    // initWalletClient() rejects with the SDK's message; the dialog stored it
    // as `fundingError`, which the wallet method controls print.
    const error = failedStart(t);
    const originals = ['subscribe', 'subscribeClock'].map(name => [name, zkapiClient[name]]);
    t.after(() => originals.forEach(([name, value]) => { zkapiClient[name] = value; }));
    zkapiClient.subscribe = () => () => {};
    zkapiClient.subscribeClock = () => () => {};
    t.mock.method(zkapiClient, 'init', async () => { throw error; });
    t.mock.method(AccountModal.prototype, 'updateTabIndicator', () => {});
    const open = [];
    t.after(() => open.forEach(modal => { modal.fundingUnsubscribe?.(); modal.methodUnsubscribe?.(); }));
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));

    zkapiClient.oaVersioning = facadeFor(held());
    const modal = new AccountModal({}, {});
    open.push(modal);
    await settle();
    assert.equal(modal.fundingError, '');
    assert.equal(modal.walletMethodReady, true);

    // Without the fact the message is stored as it always was.
    zkapiClient.oaVersioning = facadeFor(derive({ initFailed: true, snapshot: noteSnapshot() }));
    const plain = new AccountModal({}, {});
    open.push(plain);
    await settle();
    assert.equal(plain.fundingError, error.message);
});

// ---------------------------------------------------------------------------
// The welcome
// ---------------------------------------------------------------------------

test('the welcome of a held balance offers no deposit and shows no SDK text', t => {
    const error = failedStart(t);
    const state = held();
    const facade = facadeFor(state);
    zkapiClient.oaVersioning = facade;
    const welcome = Object.create(WelcomePanel.prototype);
    Object.assign(welcome, { busy: false, fundingBusy: false, isOpen: true, step: 'welcome', escapeHtml,
        app: { accountModal: { openFunding() {}, open() {} } }, overlay: overlayMock() });
    const html = welcome.renderWelcome();
    assert.match(html, /data-welcome-version-closed/);
    assert.match(html, /data-zkapi-balance-held/);
    assert.equal(textOf(html).includes(HELD_WORDS), true);
    assert.doesNotMatch(html, /welcome-fund-btn|welcome-deposit-amount|Continue with MetaMask|Deposits have moved/);
    // The "Payment service" line is the SDK's own error: here it is the plain
    // summary (the welcome asks the helpers, which know the error).
    assert.doesNotMatch(html, TRACES);
    assert.match(html, /Payment service: Your balance is saved in this browser, but its service isn\u2019t available right now\. Reload to check again\./);
    assert.equal(zkapiClient.lastError, error);
    // A way out stays.
    assert.match(html, /welcome-skip-btn/);
});

test('the welcome of a held balance on the deposit target offers no deposit either', t => {
    failedStart(t);
    const state = derive({ active: V2, initFailed: true,
        abandon: { available: false, kind: null, blockedBy: 'not_applicable' } });
    assert.equal(state.gate.canStart, false);
    const facade = facadeFor(state);
    facade.active = V2;
    zkapiClient.oaVersioning = facade;
    const welcome = Object.create(WelcomePanel.prototype);
    Object.assign(welcome, { busy: false, fundingBusy: false, isOpen: true, step: 'welcome', escapeHtml,
        app: { accountModal: { openFunding() {}, open() {} } }, overlay: overlayMock() });
    const html = welcome.renderWelcome();
    assert.match(html, /data-welcome-version-closed/);
    assert.match(html, /data-zkapi-balance-held/);
    assert.equal(textOf(html).includes('Version 2’s service isn’t available right now'), true);
    assert.doesNotMatch(html, /welcome-fund-btn|welcome-deposit-amount|Continue with MetaMask|To use version/);
    assert.doesNotMatch(html, /data-zkapi-gate-code|We could not read your saved balance/);
    assert.doesNotMatch(html, TRACES);
    // With the fact gone the same page offers the deposit it always did.
    const empty = derive({ active: V2, initFailed: false, abandon: NO_NOTE, selection: selectionFor(V2, {
        reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }) });
    const open = facadeFor(empty);
    open.active = V2;
    zkapiClient.oaVersioning = open;
    zkapiClient.lastError = null;
    assert.equal(empty.gate.canStart, true);
    assert.match(welcome.renderWelcome(), /welcome-fund-btn/);
});

// ---------------------------------------------------------------------------
// End to end: the page's own facade over a failed start
// ---------------------------------------------------------------------------

afterEach(() => { resetActiveVersionForTests(); });

test('the page’s facade drives the panel and the dialog from a real failed start', t => {
    const error = failedStart(t);
    resetActiveVersionForTests();
    installActiveVersion({ table: TABLE, version: V1, selection: selectionFor(V1) });
    const facade = createZkapiVersioning({
        buildTable: TABLE, network: 'mainnet', now: () => NOW_MS,
        sessionStorage: createFakeStorage(), localStorage: createFakeStorage(), setTimer: () => 0, clearTimer: () => {}
    });
    const listeners = new Set();
    const client = {
        initialized: false, lastError: null, config: null, wallet: null, withdrawals: [], deposits: [], activities: [],
        snapshot() { return { config: null, wallet: null, withdrawals: [], deposits: [], activities: [] }; },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    };
    facade.attach({ client, runtime: { runtime: null, manifest: null }, integrity: 'ok', ui: createVersionUi({ facade }) });
    t.after(() => facade.resetForTests());
    zkapiClient.oaVersioning = facade;
    // The start is still pending: nothing is claimed yet.
    client.lastError = null;
    assert.equal(facade.state(NOW_MS).held, null);
    client.lastError = error;
    for (const listener of listeners) listener(client.snapshot(), { reason: 'error' });

    const panel = renderPanel();
    assert.match(panel.html, /Saved in this browser/);
    assert.equal(textOf(panel.html).includes(HELD_WORDS), true);
    const modal = dialog();
    assert.equal(textOf(modal.renderBalance()).includes(HELD_WORDS), true);
    // The dialog's own error line for the failed start is the plain sentence.
    assert.equal(zkapiClient.oaVersioning.isStartFailure(error), true);
    assert.equal(versionCopyText('held.summary').includes('isn’t available'), true);
});
