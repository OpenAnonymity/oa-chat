import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after, afterEach } from 'node:test';
import vm from 'node:vm';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import { versionRefusalMessage } from '../../chat/zkapi/services/zkapiErrorCopy.mjs';
import { SWITCH_HINT_KEY, UPGRADE_INTENT_KEY } from '../../chat/zkapi/versioning/switchProtocol.mjs';
import {
    NOW_MS, activatedRegistry, mutated, normalizedSnapshot, resolvedTable, stuckEscapeNotice, validRegistry
} from './_registryFixtures.mjs';
import { isUnclaimedPayoutCredit } from '../../chat/zkapi/versioning/walletHoldings.mjs';
import { availableWithdrawalEscape } from '../../chat/zkapi/services/withdrawalRecovery.mjs';
import { installActiveVersion, resetActiveVersionForTests } from '../../chat/zkapi/versioning/activeVersion.mjs';
import { createDocument as createMiniDocument } from './_miniDom.mjs';

// The balance dialog, the funding controls and the welcome with a version
// facade attached (docs/ZKAPI_VERSIONING.md, "Upgrade UX"). The facade here is
// a hand-built stand-in over states derived by the real deriveVersionState, so
// these tests pin where the dialog puts the version UI, what it refuses to
// start, and what a click calls. The words themselves are the helpers'
// (copy.mjs, UpgradeView), pinned in their own tests.

const storage = new Map();
const sessionStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: key => { storage.delete(key); }
};
globalThis.localStorage = sessionStorage;
globalThis.sessionStorage = sessionStorage;
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', href: 'http://localhost/', reload() { globalThis.location.reloads = (globalThis.location.reloads || 0) + 1; } };
globalThis.window.location = globalThis.location;
globalThis.window.addEventListener = () => {};
globalThis.window.dispatchEvent = () => {};
globalThis.document = {
    activeElement: null,
    documentElement: { dataset: {}, removeAttribute() {}, setAttribute() {} },
    getElementById: () => null,
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

const { default: zkapiClient } = await import('@openanonymity/zkapi-browser-sdk/client');
const { default: AccountModal } = await import('../../chat/zkapi/components/AccountModal.js');
const { default: WelcomePanel } = await import('../../chat/zkapi/components/WelcomePanel.js');
const controls = await import('../../chat/zkapi/components/WalletMethodControls.js');
const { renderUpgradeView, renderDepositsClosedView } = await import('../../chat/zkapi/components/UpgradeView.js');
const { addressFundingWallet } = await import('../../chat/zkapi/services/addressFundingProvider.mjs');
const { AddressDepositFlow } = await import('../../chat/zkapi/services/addressDepositFlow.mjs');
const createZkapiVersioningModule = await import('../../chat/zkapi/versioning/index.js');
const { getWalletMethod, setWalletMethod } = await import('../../chat/zkapi/services/walletMethod.mjs');
addressFundingWallet.store = { load: async () => null, save: async () => {}, keys: async () => [] };
addressFundingWallet.createChannel = () => null;

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

const DAY = 86_400;
const NOW_S = Math.floor(NOW_MS / 1000);
const TABLE = resolvedTable(activatedRegistry(), 'mainnet');
const [V1, V2] = TABLE;
// The review step writes `withdrawing`; only a withdrawal the facade saw end
// with payout evidence makes it `withdrawn`.
const WITHDRAWING_INTENT = { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawing', since: NOW_MS - 1000 };
const WITHDRAWN_INTENT = { ...WITHDRAWING_INTENT, stage: 'withdrawn' };
// The words of a markup, tags and entities dropped.
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, ' ').replace(/\s+/g, ' ').trim();
const PREVIEW_V2 = { version: V2, reason: 'no_runtime_note', slotOwner: null, open: {}, credits: {}, foreignDeploymentId: null,
    depositBlock: null, draftDiscarded: false, slotKind: 'empty' };

function selectionFor(version, overrides = {}) {
    return { version, reason: 'runtime_holds_note', slotOwner: version.id, open: {}, credits: {}, foreignDeploymentId: null,
        depositBlock: null, draftDiscarded: false, slotKind: 'note', ...overrides };
}

function derive(overrides = {}) {
    const active = overrides.active || V1;
    return deriveVersionState({
        table: TABLE, active, target: V2, selection: selectionFor(active), snapshot: normalizedSnapshot(), intent: null,
        previewSelection: null, now: NOW_MS, busy: false, admissionClosed: false, buildClosed: false, configBlock: false,
        unreachable: false, adapter: getAdapter(active.adapter), ...overrides
    });
}

const noteSnapshot = (expirySeconds, extra = {}) => normalizedSnapshot({
    hasNote: true, expiryTs: expirySeconds, deadlines: [{ source: 'slot', expiryTs: expirySeconds }], ...extra
});

// v1 (exit-only) holder of a balance with `days` days left.
const holder = (days = 20, overrides = {}) => derive({ snapshot: noteSnapshot(NOW_S + days * DAY), ...overrides });
// v1 with nothing held, deposits closed, successor v2.
const emptyClosed = (overrides = {}) => derive({ selection: selectionFor(V1, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }), ...overrides });

// ---------------------------------------------------------------------------
// A facade and the helpers it carries
// ---------------------------------------------------------------------------

const NOTICE_OF_PHASE = { current: 'gate', 'reload-required': 'reload', 'finish-previous-withdrawal': 'previous' };

function helpers(extra = {}) {
    const calls = { patch: [] };
    const ui = {
        badge: (state, options) => (state.show
            ? `<span data-zkapi-version-badge data-surface="${options.surface}">${state.current.label}</span><button id="zkapi-modal-version-help-toggle" data-zkapi-help="version" aria-expanded="${options.helpOpen}">?</button>`
            : ''),
        // Marked the way the real banner marks its notices (by id), so the
        // dialog can tell which of them a view says in full.
        banner: (state, options) => (state.phase === 'current' && state.gate.canStart
            ? '' : `<div data-zkapi-version-banner="${options.surface}" data-phase="${state.phase}"><div data-zkapi-version-notice="${NOTICE_OF_PHASE[state.phase] || 'upgrade'}"><button type="button" data-zkapi-version-action="upgrade">Upgrade balance</button></div></div>`),
        patch: (root, state, options) => { calls.patch.push({ root, state, options }); return { needsRender: ui.needsRender === true }; },
        help: () => ({ title: 'About versions', body: 'Your balance is on version 1.' }),
        upgradeView: renderUpgradeView,
        depositsClosedView: renderDepositsClosedView,
        protocolNotices: () => '',
        // The composed helpers' member (versioning/ui.js): the welcome reaches
        // the rewrite of a version refusal only through it.
        refusalMessage: error => versionRefusalMessage(error) || null,
        ...extra
    };
    return { ui, calls };
}

// `confirmed`: what the facade says about the upgrade's withdrawal (the
// payout-evidence fact the words are gated on): true or false through the
// helpers' `facts()`, absent when left out (a facade that cannot say).
function facadeFor(state, { ui = helpers().ui, selection = selectionFor(V1), target = V2, active = V1, gate = state.gate, confirmed } = {}) {
    if (confirmed !== undefined) ui.facts = () => ({ withdrawalConfirmed: confirmed });
    const calls = [];
    const busy = new Set();
    const listeners = new Set();
    const facade = {
        multiVersion: true,
        state: () => state,
        depositGate: () => gate,
        ui,
        table: TABLE,
        target,
        active,
        selection,
        calls,
        busy,
        listeners,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        registerBusy(provider) { busy.add(provider); return () => busy.delete(provider); },
        beginUpgrade() { calls.push('begin'); },
        endUpgrade() { calls.push('end'); },
        requestSwitch(options) { calls.push(['switch', options]); return { ok: true }; },
        discardUnsentDeposit: async () => { calls.push('discard'); return { discarded: true }; },
        abandonUpgrade() { calls.push('abandon'); return true; },
        acknowledgeReminder(tier) { calls.push(['ack', tier]); }
    };
    return facade;
}

// ---------------------------------------------------------------------------
// Fixture: a modal over the real client singleton
// ---------------------------------------------------------------------------

function overlayMock() {
    const writes = [];
    const selectors = new Map();
    const overlay = {
        writes,
        selectors,
        classList: { add() {}, remove() {} },
        set innerHTML(value) { writes.push(value); overlay.html = value; },
        get innerHTML() { return overlay.html || ''; },
        querySelector: selector => selectors.get(selector) ?? null,
        querySelectorAll: selector => selectors.get(`all:${selector}`) ?? [],
        contains: () => false,
        addEventListener() {}
    };
    return overlay;
}

function fixture(t, { note = null, config = {}, facade = null, view = 'balance', withdrawals = [], deposits = [] } = {}) {
    const original = {
        wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawals: zkapiClient.withdrawals,
        deposits: zkapiClient.deposits, withdrawal: zkapiClient.withdrawal, oaVersioning: zkapiClient.oaVersioning
    };
    Object.assign(zkapiClient, {
        wallet: { has_note: Boolean(note), note },
        config: { funding: { chain_id: 1, billing_asset: 'native_eth', billing_unit: 'gwei', native_asset_wei_per_unit: '1000000000',
            contract_address: `0x${'4'.repeat(40)}` }, ...config },
        withdrawals, deposits, withdrawal: null
    });
    if (facade) zkapiClient.oaVersioning = facade;
    else delete zkapiClient.oaVersioning;
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, { busy: false, fundingBusy: false, isOpen: true, view, status: '', statusError: false,
        withdrawMode: 'mutual', privateBalanceHelpOpen: {}, overlay: overlayMock() });
    t.after(() => {
        stopOwner(modal);
        Object.assign(zkapiClient, original);
        if (original.oaVersioning === undefined) delete zkapiClient.oaVersioning;
        storage.clear();
    });
    return { modal, facade };
}

const aNote = (days = 20) => ({ note_id: 7, deposit_amount: 2_000_000, current_balance: 1_500_000, expiry_ts: Math.floor(Date.now() / 1000) + days * DAY });
const hooks = html => ({
    badge: /data-zkapi-version-badge/.test(html),
    banner: /data-zkapi-version-banner/.test(html),
    upgrade: /data-zkapi-upgrade-view/.test(html),
    closed: /data-zkapi-deposits-closed/.test(html)
});

// ---------------------------------------------------------------------------
// Fail open
// ---------------------------------------------------------------------------

test('without a facade every render is today’s dialog: no version hooks, deposits offered', t => {
    const noNote = fixture(t);
    const empty = noNote.modal.renderBalance();
    assert.match(empty, /id="zkapi-deposit-btn"|Continue with MetaMask/);
    assert.deepEqual(hooks(empty), { badge: false, banner: false, upgrade: false, closed: false });
    assert.doesNotMatch(empty, /zkapi-version|data-upgrade|deposits wait/i);
    zkapiClient.wallet = { has_note: true, note: aNote() };
    const held = noNote.modal.renderBalance();
    assert.deepEqual(hooks(held), { badge: false, banner: false, upgrade: false, closed: false });
    assert.match(held, /id="zkapi-withdraw-view-btn"/);
    assert.match(held, /data-zkapi-balance-expiry>[^<]*<\/span><button id="zkapi-modal-expiry-help-toggle"/);
    // A history list with a return pending keeps the lines it has always had.
    zkapiClient.withdrawals = [{ recordId: 'r', mode: 'mutual', phase: 'submitted_unconfirmed', finalBalance: 1 }];
    assert.match(noNote.modal.renderWithdrawalRecords(), /so you can keep chatting normally\.<\/p>/);
    zkapiClient.wallet = { has_note: false, note: null };
    assert.match(noNote.modal.renderWithdrawalRecords(), /You can add a new private balance while a return is pending\./);
    assert.doesNotMatch(noNote.modal.renderWithdrawalRecords(), /wait until this finishes/);
});

test('a dormant (single-version) facade renders byte-for-byte what no facade renders', t => {
    const f = fixture(t, { note: aNote() });
    const without = [f.modal.renderBalance(), f.modal.renderWithdrawal(), f.modal.renderWithdrawalRecords()];
    zkapiClient.wallet = { has_note: false, note: null };
    const withoutEmpty = f.modal.renderBalance();
    const dormant = { multiVersion: false, state: () => null, depositGate: () => ({ canStart: true, canResume: false, code: null, successor: null }),
        ui: null, table: [], target: null, active: V1, selection: null, subscribe: () => () => {}, registerBusy: () => () => {} };
    zkapiClient.oaVersioning = dormant;
    zkapiClient.wallet = { has_note: true, note: zkapiClient.wallet.note || aNote() };
    zkapiClient.wallet.note = without.length ? zkapiClient.wallet.note : null;
    // Same note object for both renders.
    const note = aNote();
    zkapiClient.wallet = { has_note: true, note };
    delete zkapiClient.oaVersioning;
    const a = [f.modal.renderBalance(), f.modal.renderWithdrawal(), f.modal.renderWithdrawalRecords()];
    zkapiClient.oaVersioning = dormant;
    const b = [f.modal.renderBalance(), f.modal.renderWithdrawal(), f.modal.renderWithdrawalRecords()];
    assert.deepEqual(b, a);
    zkapiClient.wallet = { has_note: false, note: null };
    delete zkapiClient.oaVersioning;
    const c = f.modal.renderBalance();
    zkapiClient.oaVersioning = dormant;
    assert.equal(f.modal.renderBalance(), c);
    assert.equal(c, withoutEmpty);
});

test('a facade that cannot answer closes deposits instead of opening them', t => {
    const broken = { multiVersion: true, state() { throw new Error('boom'); }, depositGate() { throw new Error('boom'); }, ui: null };
    const f = fixture(t, { facade: broken });
    const html = f.modal.renderBalance();
    assert.doesNotMatch(html, /id="zkapi-deposit-btn"|Continue with MetaMask/);
    assert.match(html, /data-zkapi-deposits-closed/);
});

// ---------------------------------------------------------------------------
// The balance card: pill, banner, help
// ---------------------------------------------------------------------------

test('the pill sits beside the readiness pill, never between the expiry label and its help toggle', t => {
    const state = holder(20);
    const f = fixture(t, { note: aNote(), facade: facadeFor(state) });
    const html = f.modal.renderBalance();
    const top = html.indexOf('zkapi-balance-top');
    const pill = html.indexOf('data-zkapi-version-badge');
    const readiness = html.indexOf('data-private-balance-readiness');
    const foot = html.indexOf('zkapi-balance-foot');
    assert.ok(top < pill && pill < foot, 'in the card header');
    assert.ok(Math.abs(pill - readiness) < 700, 'next to the readiness pill');
    assert.match(html, /data-zkapi-balance-expiry>[^<]*<\/span><button id="zkapi-modal-expiry-help-toggle"/);
    // Its explanation is a help panel of the card, closed until asked for.
    assert.match(html, /id="zkapi-modal-version-help" data-zkapi-help-content="version" hidden/);
    assert.match(html, /Your balance is on version 1\./);
    // The surface is the dialog's and the toggle's state is the owner's.
    assert.match(html, /data-surface="dialog"/);
    f.modal.privateBalanceHelpOpen = { version: true };
    assert.match(f.modal.renderBalance(), /aria-expanded="true"/);
    assert.match(f.modal.renderBalance(), /id="zkapi-modal-version-help" data-zkapi-help-content="version" >/);
});

test('the banner follows the balance card and precedes the expired notice, as static text', t => {
    const state = holder(5);
    const f = fixture(t, { note: aNote(5), facade: facadeFor(state) });
    const html = f.modal.renderBalance();
    const card = html.indexOf('zkapi-balance-foot');
    const banner = html.indexOf('data-zkapi-version-banner="dialog"');
    const expired = html.indexOf('data-private-balance-expired-notice');
    assert.ok(card < banner && banner < expired);
    assert.doesNotMatch(html.slice(banner, banner + 400), /aria-live|role="status"|role="alert"/);
});

test('no pill without a second live version, but a closed gate is still explained', t => {
    const single = { ...holder(20), show: false };
    const f = fixture(t, { note: aNote(), facade: facadeFor({ ...single, phase: 'upgrade-soon' }) });
    const html = f.modal.renderBalance();
    assert.deepEqual({ badge: hooks(html).badge, banner: hooks(html).banner }, { badge: false, banner: true });
});

// ---------------------------------------------------------------------------
// Deposits closed and the unsent plan
// ---------------------------------------------------------------------------

test('a closed version with no balance replaces Add funds with the closed view', t => {
    const state = emptyClosed();
    assert.equal(state.gate.code, 'deposits_closed');
    const f = fixture(t, { facade: facadeFor(state) });
    const html = f.modal.renderBalance();
    assert.deepEqual(hooks(html), { badge: false, banner: false, upgrade: false, closed: true });
    assert.doesNotMatch(html, /zkapi-deposit-btn|zkapi-deposit-amount|Continue with MetaMask|Add funds/);
    assert.match(html, /data-zkapi-gate-code="deposits_closed"/);
    assert.match(html, /Payment history/);
    // Nothing offers a reload that would re-select this build.
    assert.doesNotMatch(html, /data-zkapi-version-action="reload"/);
});

test('Reload appears once a fresh load would pick the version that takes deposits', t => {
    const state = emptyClosed({ previewSelection: PREVIEW_V2 });
    assert.equal(state.reload.required, true);
    const f = fixture(t, { facade: facadeFor(state) });
    const html = f.modal.renderBalance();
    assert.match(html, /data-zkapi-version-action="reload"/);
    assert.match(html, /Reload to deposit into version 2/);
    // The composite banner repeats nothing the closed view already says.
    assert.deepEqual(hooks(html).banner, false);
});

test('an unsent plan on a closed version offers to cancel it, and no reload until it is gone', t => {
    const state = derive({
        snapshot: normalizedSnapshot({ hasUnsentPrepared: true, hasPendingDeposit: true }),
        selection: selectionFor(V1, { reason: 'runtime_holds_note', slotKind: 'unsent_prepared' })
    });
    assert.equal(state.unsent, true);
    assert.equal(state.gate.canResume, false);
    const f = fixture(t, { facade: facadeFor(state), config: { pending_deposit: { phase: 'prepared', amount: '5000000' } } });
    const html = f.modal.renderBalance();
    assert.match(html, /data-zkapi-version-action="cancel-unsent"/);
    assert.match(html, /never sent/);
    assert.doesNotMatch(html, /data-zkapi-version-action="reload"|Resume with MetaMask|zkapi-deposit-btn/);
    // The same plan once the discard was seen: Reload, not Cancel.
    const after = derive({ selection: selectionFor(V1, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }), previewSelection: PREVIEW_V2 });
    f.modal.renderedVersion = undefined;
    zkapiClient.oaVersioning = facadeFor(after);
    zkapiClient.config.pending_deposit = null;
    assert.match(f.modal.renderBalance(), /data-zkapi-version-action="reload"/);
});

test('a deposit that already started is finished here, on the closed version', t => {
    const state = derive({
        snapshot: normalizedSnapshot({ hasPendingDeposit: true }),
        selection: selectionFor(V1, { reason: 'runtime_holds_note', slotKind: 'pending_deposit' })
    });
    assert.deepEqual([state.gate.canStart, state.gate.canResume], [false, true]);
    const f = fixture(t, { facade: facadeFor(state), config: { pending_deposit: { phase: 'prepared', amount: '5000000' } } });
    const html = f.modal.renderBalance();
    assert.doesNotMatch(html, /data-zkapi-deposits-closed/);
    assert.match(html, /Resume with MetaMask|Saved deposit/);
    // A submitted one shows the ordinary recovery view.
    zkapiClient.config.pending_deposit = { phase: 'submitted', amount: '5000000' };
    assert.match(f.modal.renderBalance(), /Deposit submitted/);
});

test('with the helpers still loading, a closed version offers no deposit and says so', t => {
    const f = fixture(t, { facade: facadeFor(emptyClosed(), { ui: null }) });
    const html = f.modal.renderBalance();
    assert.match(html, /data-zkapi-deposits-closed/);
    assert.match(html, /no longer accepts new deposits/);
    assert.doesNotMatch(html, /zkapi-deposit-btn|Continue with MetaMask/);
});

// ---------------------------------------------------------------------------
// The upgrade view
// ---------------------------------------------------------------------------

function upgradeFixture(t, stateOverrides = {}, options = {}) {
    const state = holder(20, { viewOpen: true, ...stateOverrides });
    const f = fixture(t, { note: aNote(20), view: 'upgrade', facade: facadeFor(state), ...options });
    return { ...f, state };
}

test('the review step: steps, fee disclosure, destination, and the existing withdraw button', t => {
    const f = upgradeFixture(t);
    assert.equal(f.state.upgrade.stage, 'review');
    const html = f.modal.renderUpgrade();
    assert.match(html, /data-zkapi-upgrade-view/);
    assert.deepEqual([...html.matchAll(/data-upgrade-step="(\w+)"/g)].map(match => match[1]), ['withdraw', 'reload', 'deposit']);
    assert.match(html, /network fee can be large/);
    assert.match(html, /name="zkapi-upgrade-destination" value="connected" checked/);
    // The embedded withdrawal is the existing one: same button, no set-aside,
    // no method fieldset, and the confirmation says what follows.
    assert.match(html, /id="zkapi-withdraw-btn"/);
    assert.doesNotMatch(html, /zkapi-park-withdrawal-btn|name="zkapi-withdraw-mode"|Withdrawal method/);
    assert.match(html, /deposit again to finish upgrading/);
    assert.equal((html.match(/id="zkapi-back-balance-btn"/g) || []).length, 1);
});

test('the method choice returns where escape is the person’s own choice', t => {
    const f = upgradeFixture(t);
    f.modal.withdrawMode = 'escape';
    assert.match(f.modal.renderUpgrade(), /name="zkapi-withdraw-mode"/);
});

test('the upgrade’s withdrawal narrates under the upgrade’s name, an ordinary one under its own', t => {
    const f = upgradeFixture(t);
    assert.equal(f.modal.currentJourney('withdraw', { message: 'Waiting for MetaMask…' }).category, 'Upgrading your balance');
    assert.equal(f.modal.currentJourney('deposit', { message: '' }).category, 'Adding your balance');
    f.modal.view = 'withdraw';
    assert.equal(f.modal.currentJourney('withdraw', { message: '' }).category, 'Withdrawal');
});

test('Send Ethereum offers a new funding address only where the page can create one, and only on click', t => {
    const f = upgradeFixture(t);
    setWalletMethod('address');
    t.after(() => setWalletMethod('metamask'));
    // No helper to create one: a typed address is the only choice.
    let html = f.modal.renderUpgrade();
    assert.doesNotMatch(html, /value="new-address"/);
    assert.match(html, /value="other" checked/);
    assert.match(html, /data-funding-withdrawal-destination/);
    // With the helper: offered, not created.
    let created = 0;
    f.facade.ui.rescue = { createScopedFundingProvider: () => ({ ensureAddress: async () => { created++; return `0x${'7'.repeat(40)}`; } }) };
    html = f.modal.renderUpgrade();
    assert.match(html, /value="new-address" checked/);
    assert.match(html, /data-upgrade-new-address/);
    assert.match(html, /Only this browser holds its key/);
    assert.equal(created, 0, 'rendering never creates custody');
});

test('creating the address is one explicit gesture, and what it returns is the destination', async t => {
    const f = upgradeFixture(t);
    setWalletMethod('address');
    t.after(() => setWalletMethod('metamask'));
    const address = `0x${'7'.repeat(40)}`;
    const seen = [];
    f.facade.ui.rescue = { createScopedFundingProvider: version => { seen.push(version.id); return { ensureAddress: async () => address }; } };
    f.modal.render = () => {};
    await f.modal.createUpgradeAddress();
    assert.deepEqual(seen, ['v2']);
    assert.equal(f.modal.fundingDestination, address);
    assert.match(f.modal.renderUpgrade(), new RegExp(`data-upgrade-new-address-value readonly[^>]*value="${address}"`));
    assert.equal(f.modal.fundingBusy, false);
    // A failure shows, creates nothing, and leaves the page usable.
    f.modal.upgradeDestination = { choice: 'new-address' };
    f.facade.ui.rescue = { createScopedFundingProvider: () => ({ ensureAddress: async () => { throw new Error('Storage is unavailable.'); } }) };
    await f.modal.createUpgradeAddress();
    assert.equal(f.modal.upgradeAddressError, 'Storage is unavailable.');
    assert.match(f.modal.renderUpgrade(), /Storage is unavailable\./);
});

test('the upgrade will not start toward an address that was not created or typed', t => {
    const f = upgradeFixture(t);
    setWalletMethod('address');
    t.after(() => setWalletMethod('metamask'));
    f.facade.ui.rescue = { createScopedFundingProvider: () => ({ ensureAddress: async () => `0x${'7'.repeat(40)}` }) };
    f.modal.render = () => {};
    assert.match(f.modal.upgradeDestinationRefusal(), /Create the new funding address first/);
    f.modal.upgradeDestination = { choice: 'other', typed: 'not an address' };
    f.modal.fundingDestination = 'not an address';
    assert.match(f.modal.upgradeDestinationRefusal(), /valid Ethereum/);
    const good = `0x${'8'.repeat(40)}`;
    f.modal.upgradeDestination = { choice: 'other', typed: good };
    f.modal.fundingDestination = good;
    assert.equal(f.modal.upgradeDestinationRefusal(), '');
    // MetaMask has no destination to refuse.
    setWalletMethod('metamask');
    f.modal.upgradeDestination = {};
    assert.equal(f.modal.upgradeDestinationRefusal(), '');
});

test('an upgrade withdrawal that is submitted shows its confirmation wait, not a form', t => {
    // The transaction is out; the SDK is waiting to see it confirmed.
    const state = derive({
        snapshot: normalizedSnapshot({ hasOpenWithdrawal: true }),
        selection: selectionFor(V1, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }),
        withdrawalPhase: 'submitted_unconfirmed', viewOpen: true
    });
    const f = { ...fixture(t, { view: 'upgrade', facade: facadeFor(state),
        withdrawals: [{ recordId: 'r1', mode: 'mutual', phase: 'submitted_unconfirmed', finalBalance: 1_500_000 }] }), state };
    assert.equal(f.state.upgrade.stage, 'confirming');
    const html = f.modal.renderUpgrade();
    assert.match(html, /data-upgrade-stage="confirming"/);
    assert.match(html, /waiting for Ethereum to confirm/);
    assert.match(html, /data-sync-withdrawal="r1"/, 'the existing status check stays reachable');
});

test('after the withdrawal, Reload is the step, and it follows the facade’s canReload', t => {
    const ready = emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2, viewOpen: true });
    assert.equal(ready.upgrade.stage, 'ready_to_switch');
    const f = fixture(t, { view: 'upgrade', facade: facadeFor(ready, { confirmed: true }) });
    let html = f.modal.renderUpgrade();
    assert.match(html, /data-upgrade-stage="ready_to_switch"/);
    assert.match(html, /data-zkapi-version-action="reload"(?![^>]*disabled)/);
    assert.match(html, /Withdrawal confirmed/);
    assert.doesNotMatch(html, /id="zkapi-withdraw-btn"/);
    // Work in flight: the same button, disabled, with the reason beside it.
    zkapiClient.oaVersioning = facadeFor({ ...ready, reload: { ...ready.reload, canReload: false } }, { confirmed: true });
    html = f.modal.renderUpgrade();
    assert.match(html, /data-zkapi-version-action="reload" disabled/);
    assert.match(html, /Finish the current step first/);
    // While the dialog itself is working it never offers the button.
    zkapiClient.oaVersioning = facadeFor(ready, { confirmed: true });
    f.modal.busy = true;
    assert.match(f.modal.renderUpgrade(), /data-zkapi-version-action="reload" disabled/);
});

test('Send Ethereum users are told leftover ETH is still theirs before they reload', t => {
    const ready = emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2, viewOpen: true });
    const f = fixture(t, { view: 'upgrade', facade: facadeFor(ready) });
    assert.doesNotMatch(f.modal.renderUpgrade(), /data-upgrade-leftover/);
    setWalletMethod('address');
    t.after(() => setWalletMethod('metamask'));
    assert.match(f.modal.renderUpgrade(), /ETH left at this version’s funding address is still yours/);
    // The fee note is for the steps before the withdrawal, not after it.
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: `0x${'2'.repeat(40)}`, pending: null, migrationRequired: false };
    const owner = ownerOf({ view: 'upgrade', upgradeStage: 'review' });
    assert.match(controls.renderFundingAccount(owner), /send it to this address from your own wallet first/);
    owner.upgradeStage = 'ready_to_switch';
    assert.doesNotMatch(controls.renderFundingAccount(owner), /send it to this address from your own wallet first/);
});

test('the Sepolia upgrade says the test password is asked again after the reload', t => {
    const ready = emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2, viewOpen: true });
    const f = fixture(t, { view: 'upgrade', facade: facadeFor(ready), config: { funding: { chain_id: 11155111 } } });
    assert.match(f.modal.renderUpgrade(), /enter the test network password again/);
});

test('the deposit step leads the ordinary fund flow, and the done step follows it', t => {
    const intent = { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawn', since: NOW_MS - 1000 };
    const deposit = derive({ active: V2, selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }), intent });
    assert.equal(deposit.upgrade.stage, 'deposit');
    const f = fixture(t, { view: 'upgrade', facade: facadeFor(deposit, { selection: selectionFor(V2), active: V2 }) });
    let html = f.modal.renderUpgrade();
    assert.match(html, /data-upgrade-stage="deposit"/);
    assert.match(html, /Your balance is withdrawn\. Deposit to finish upgrading to version 2/);
    assert.ok(html.indexOf('data-zkapi-upgrade-view') < html.indexOf('zkapi-deposit-btn') || /Continue with MetaMask/.test(html));
    assert.doesNotMatch(html, /id="zkapi-back-balance-btn"/, 'a lead, not a view of its own');
    // The version's own banner does not say the same sentence again.
    assert.equal(hooks(html).banner, false);

    const done = derive({ active: V2, snapshot: noteSnapshot(NOW_S + 30 * DAY), intent,
        selection: selectionFor(V2) });
    assert.equal(done.upgrade.stage, 'done');
    zkapiClient.wallet = { has_note: true, note: aNote(30) };
    zkapiClient.oaVersioning = facadeFor(done, { selection: selectionFor(V2), active: V2 });
    html = f.modal.renderUpgrade();
    assert.match(html, /Upgrade complete\. Your balance is on version 2/);
    assert.match(html, /zkapi-balance-card/);
});

test('right after its own withdrawal confirmed, the upgrade view waits for the holdings read instead of leaving', t => {
    // Nothing held, no reload yet: the stage is idle for the moment.
    const gap = emptyClosed({ viewOpen: true });
    assert.equal(gap.upgrade.stage, 'idle');
    const f = fixture(t, { view: 'upgrade', facade: facadeFor(gap, { confirmed: true }) });
    assert.equal(f.modal.upgradeViewTarget(f.modal.versionContext()), 'balance', 'a stale restore still leaves');
    f.modal.withdrawalCompleted = true;
    f.modal.withdrawalCompletedAt = Date.now();
    assert.equal(f.modal.upgradeViewTarget(f.modal.versionContext()), 'upgrade');
    assert.match(f.modal.renderUpgradeContext(f.modal.versionContext(), ''), /Withdrawal confirmed\. Checking whether version 2 is ready to load/);
    // The payout is a claim: without the facade's evidence the same wait says
    // only what is happening.
    zkapiClient.oaVersioning = facadeFor(gap, { confirmed: false });
    const unproven = textOf(f.modal.renderUpgradeContext(f.modal.versionContext(), ''));
    assert.match(unproven, /Checking whether version 2 is ready to load/);
    assert.doesNotMatch(unproven, /Withdrawal confirmed/);
    zkapiClient.oaVersioning = facadeFor(gap);
    assert.doesNotMatch(textOf(f.modal.renderUpgradeContext(f.modal.versionContext(), '')), /Withdrawal confirmed/);
    // Not for long: the closed view with its reason is the better place to wait.
    f.modal.withdrawalCompletedAt = Date.now() - 60_000;
    assert.equal(f.modal.upgradeViewTarget(f.modal.versionContext()), 'balance');
    // And the next read makes Reload the step.
    zkapiClient.oaVersioning = facadeFor(emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2, viewOpen: true }));
    assert.equal(f.modal.upgradeViewTarget(f.modal.versionContext()), 'upgrade');
});

test('an upgrade view with nothing to upgrade is the balance', t => {
    const f = fixture(t, { note: aNote(), view: 'upgrade', facade: facadeFor(derive({ active: V2, snapshot: noteSnapshot(NOW_S + 20 * DAY), selection: selectionFor(V2) }), { active: V2 }) });
    assert.equal(f.modal.upgradeViewTarget(f.modal.versionContext()), 'balance');
    // Without a facade at all it is the same.
    delete zkapiClient.oaVersioning;
    assert.equal(f.modal.upgradeViewTarget(f.modal.versionContext()), 'balance');
});

test('the upgrade view reaches the facade only on the person’s opening of it', t => {
    const f = upgradeFixture(t);
    f.modal.isOpen = true;
    f.modal.syncUpgradeView();
    assert.deepEqual(f.facade.calls, ['begin']);
    f.modal.syncUpgradeView();
    assert.deepEqual(f.facade.calls, ['begin'], 'once');
    f.modal.view = 'balance';
    f.modal.syncUpgradeView();
    assert.deepEqual(f.facade.calls, ['begin', 'end']);
});

test('a facade notification renders once, not on top of the render an SDK change already did', async t => {
    const f = upgradeFixture(t);
    let renders = 0;
    f.modal.render = function render() { renders++; this.renderCount = (this.renderCount || 0) + 1; };
    f.modal.canRefreshContent = () => true;
    f.modal.updateTabIndicator = () => {};
    // The call the dialog itself caused (opening its view) is not a change.
    f.modal.versionSyncing = true;
    f.modal.handleVersionChange();
    await Promise.resolve();
    assert.equal(renders, 0);
    f.modal.versionSyncing = false;
    // A facade-only change (a boundary, a watcher event) renders.
    f.modal.handleVersionChange();
    await Promise.resolve();
    assert.equal(renders, 1);
    // The SDK's own subscription rendered in between: nothing more to do.
    f.modal.handleVersionChange();
    f.modal.render();
    await Promise.resolve();
    assert.equal(renders, 2);
    // Not while a disclosure moves: the refresh is deferred to its end.
    f.modal.disclosureAnimating = true;
    f.modal.handleVersionChange();
    await Promise.resolve();
    assert.equal(renders, 2);
    assert.equal(f.modal.disclosureRefreshPending, true);
});

// ---------------------------------------------------------------------------
// Words that were wrong across versions
// ---------------------------------------------------------------------------

test('"you can add a new balance while a return is pending" is not said where deposits wait', t => {
    const state = emptyClosed();
    const f = fixture(t, { facade: facadeFor(state), withdrawals: [{ recordId: 'r', mode: 'mutual', phase: 'submitted_unconfirmed', finalBalance: 1 }] });
    const html = f.modal.renderWithdrawalRecords();
    assert.match(html, /Version 2 deposits wait until this finishes\./);
    assert.doesNotMatch(html, /You can add a new private balance/);
    // With a balance still held, chatting is unaffected and the line is added.
    zkapiClient.wallet = { has_note: true, note: aNote() };
    const held = f.modal.renderWithdrawalRecords();
    assert.match(held, /keep chatting normally\. Version 2 deposits wait until this finishes\./);
});

test('set-aside is not offered as a way to add a balance where deposits wait', t => {
    const prepared = { mode: 'mutual', phase: 'prepared', clearance_reserved: true };
    const f = fixture(t, { note: aNote(), config: { prepared_withdrawal: prepared }, facade: facadeFor(holder(20)) });
    let html = f.modal.renderWithdrawal();
    assert.match(html, /id="zkapi-park-withdrawal-btn"[^>]*>Set aside for later</);
    assert.match(html, /Version 2 deposits wait until this finishes\./);
    assert.doesNotMatch(html, /Set aside and add a new balance/);
    // Single version: exactly the old button.
    delete zkapiClient.oaVersioning;
    html = f.modal.renderWithdrawal();
    assert.match(html, /Set aside and add a new balance/);
    assert.doesNotMatch(html, /deposits wait/);
});

// ---------------------------------------------------------------------------
// Gates: nothing is quoted, drafted or started while a deposit may not start
// ---------------------------------------------------------------------------

// Every owner a test builds is stopped when that test ends. A funding flow
// polls on a timer (and a funding status check re-arms its own), so one left
// running would keep a raw `node --test` from ever exiting (and a test run on
// its own never reaches the end-of-file hook below while its timer is alive);
// the repo runner's --test-force-exit hid that.
const OWNERS = new Set();
const stopOwner = owner => {
    try { controls.stopFundingFlow(owner); } catch { /* a stand-in owner may lack parts */ }
};
// Every flow any test started, owner or not: none may outlive its test.
const STARTED_FLOWS = new Set();
const flowStart = AddressDepositFlow.prototype.start;
AddressDepositFlow.prototype.start = function start(...args) {
    STARTED_FLOWS.add(this);
    return flowStart.apply(this, args);
};
afterEach(() => {
    for (const owner of OWNERS) stopOwner(owner);
    OWNERS.clear();
    for (const flow of STARTED_FLOWS) flow.stop?.();
    STARTED_FLOWS.clear();
});
after(() => {
    for (const owner of OWNERS) stopOwner(owner);
    AddressDepositFlow.prototype.start = flowStart;
    const left = [...STARTED_FLOWS].filter(flow => flow.running || flow.timer || flow.quoteExpiryTimer);
    assert.equal(left.length, 0, `${left.length} funding flow(s) a test started are still running`);
});

function ownerOf(overrides = {}) {
    const owner = { isOpen: true, view: 'fund', busy: false, fundingBusy: false, fundingError: '', fundingNotice: '',
        escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
        render() {}, overlay: overlayMock(), walletMethodReady: true, ...overrides };
    OWNERS.add(owner);
    return owner;
}

function spyOnQuotes(t) {
    const quotes = [];
    for (const name of ['quoteDepositUsd', 'prepareDepositQuote', 'deposit', 'prepareDeposit', 'performDeposit']) {
        if (typeof zkapiClient[name] !== 'function') continue;
        t.mock.method(zkapiClient, name, async (...args) => { quotes.push([name, ...args]); throw new Error('A closed version must not reach the SDK'); });
    }
    return quotes;
}

const tick = () => new Promise(resolve => setImmediate(resolve));
// Lets pending work run, turn by turn, until `condition` holds (or a bound is
// reached, and the caller's next assertion says what did not happen).
const untilDone = async condition => {
    for (let turns = 0; turns < 500 && !condition(); turns += 1) await tick();
};

test('a closed version creates no amount flow, quote or draft, whatever the person does', async t => {
    const closed = emptyClosed();
    const f = fixture(t, { facade: facadeFor(closed) });
    zkapiClient.config.funding.billing_asset = 'native_eth';
    const quotes = spyOnQuotes(t);
    const owner = ownerOf();
    assert.equal(controls.renderDepositAmount(owner), '', 'no amount field to type into');
    controls.attachWalletMethodControls(owner);
    await tick();
    assert.equal(owner.depositAmountFlow, undefined);
    assert.equal(owner.fundingFlow ?? null, null);
    await assert.rejects(controls.prepareDepositAmount(owner), /no longer accepts new deposits/);
    f.modal.render = () => {};
    Object.assign(f.modal, { overlay: overlayMock() });
    await f.modal.startDeposit('5');
    assert.match(f.modal.outcome.message, /no longer accepts new deposits/);
    await f.modal.submitAddressDeposit();
    await f.modal.prepareAddressDepositRetry();
    assert.deepEqual(quotes, []);
});

test('the dialog refuses a deposit by its own gate, before any SDK call, with no SDK wrapper installed', async t => {
    const f = fixture(t, { facade: facadeFor(emptyClosed()) });
    // A token deployment: nothing before run() goes through the funding
    // controls, so the only thing between the click and zkapiClient.deposit is
    // the dialog's own check (the SDK is the unwrapped legacy singleton here).
    zkapiClient.config = { ...zkapiClient.config, funding: { ...zkapiClient.config.funding, billing_asset: 'usdc', billing_unit: null } };
    assert.equal(zkapiClient.isNativeEthFunding, false);
    const quotes = spyOnQuotes(t);
    f.modal.render = () => {};
    Object.assign(f.modal, { overlay: overlayMock() });
    await f.modal.startDeposit('5');
    assert.match(f.modal.outcome.message, /no longer accepts new deposits/);
    assert.equal(f.modal.busy, false, 'no step was started');
    assert.deepEqual(quotes, []);
    // A deposit that already started is still finished here (the saved
    // amount, never a typed one) and does reach the SDK.
    zkapiClient.oaVersioning = facadeFor(derive({ snapshot: normalizedSnapshot({ hasPendingDeposit: true }),
        selection: selectionFor(V1, { reason: 'runtime_holds_note', slotKind: 'pending_deposit' }) }));
    zkapiClient.config = { ...zkapiClient.config, pending_deposit: { phase: 'submitted', amount: '5000000' } };
    f.modal.outcome = null;
    f.modal.run = async () => { quotes.push(['run']); };
    await f.modal.startDeposit('5');
    assert.deepEqual(quotes, [['run']], 'a saved deposit is handed to the SDK flow');
});

test('a tab told its balance moved in another tab shows a reload and no deposit controls', () => {
    const state = derive({
        active: V2,
        selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }),
        previewSelection: selectionFor(V1, { reason: 'runtime_holds_note' })
    });
    assert.equal(state.gate.code, 'reload_required');
    assert.equal(state.gate.canStart, false);
    const html = renderDepositsClosedView({ state, unsent: false });
    assert.match(html, /data-zkapi-gate-code="reload_required"/);
    assert.match(textOf(html), /This browser’s balance moved to version 1 in another tab\. Reload to keep going\./);
    assert.match(html, /data-zkapi-version-action="reload"/);
    // A tab that can deposit has none of it.
    const settled = derive({
        active: V2, selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' })
    });
    assert.equal(renderDepositsClosedView({ state: settled, unsent: false }), '');
});

test('the same gates hold for Send Ethereum: no funding flow is started', async t => {
    const f = fixture(t, { facade: facadeFor(emptyClosed()) });
    setWalletMethod('address');
    t.after(() => setWalletMethod('metamask'));
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: `0x${'2'.repeat(40)}`, pending: null, migrationRequired: false };
    t.mock.method(addressFundingWallet, 'getStatus', async () => ({ ethBalance: '0' }));
    const owner = ownerOf({ view: 'fund' });
    const quotes = spyOnQuotes(t);
    controls.attachWalletMethodControls(owner);
    await tick();
    assert.equal(owner.fundingFlow ?? null, null, 'ensureFundingFlow starts none');
    assert.deepEqual(quotes, []);
    // The receiving address is not shown as a place to send funds.
    const html = controls.renderFundingAccount(owner);
    assert.doesNotMatch(html, /data-funding-address\b|Copy address|Amount to deposit|data-funding-next/);
    assert.match(html, /ETH left at your funding address/);
    assert.match(html, /Return leftover ETH/);
    // A version that takes deposits shows it all again.
    zkapiClient.oaVersioning = facadeFor(derive({ active: V2, selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }) }), { active: V2 });
    assert.match(controls.renderFundingAccount(owner), /data-funding-address\b/);
    assert.equal(f.modal.view, 'balance');
});

test('a deposit that already started may still be quoted and finished', t => {
    const started = derive({ snapshot: normalizedSnapshot({ hasPendingDeposit: true }),
        selection: selectionFor(V1, { reason: 'runtime_holds_note', slotKind: 'pending_deposit' }) });
    fixture(t, { facade: facadeFor(started), config: { pending_deposit: { phase: 'prepared', amount: '5000000' } } });
    const owner = ownerOf();
    assert.match(controls.renderDepositAmount(owner), /Saved deposit amount/);
    // An unsent plan is not resumable: its amount is not offered either.
    zkapiClient.oaVersioning = facadeFor(derive({ snapshot: normalizedSnapshot({ hasPendingDeposit: true, hasUnsentPrepared: true }),
        selection: selectionFor(V1, { slotKind: 'unsent_prepared' }) }));
    assert.equal(controls.renderDepositAmount(owner), '');
});

test('the welcome starts no deposit on a closed version and is not dismissed by seeing that', async t => {
    const f = fixture(t, { facade: facadeFor(emptyClosed()) });
    const quotes = spyOnQuotes(t);
    const welcome = Object.create(WelcomePanel.prototype);
    const rendered = [];
    Object.assign(welcome, { busy: false, fundingBusy: false, isOpen: true, step: 'welcome', escapeHtml: ownerOf().escapeHtml,
        app: { accountModal: { openFunding() {}, open() {} } }, overlay: overlayMock(), render() { rendered.push(1); } });
    await welcome.fund();
    assert.match(welcome.error, /no longer accepts new deposits/);
    assert.deepEqual(quotes, []);
    // The welcome shows the closed notice in place of the deposit controls.
    const html = welcome.renderWelcome();
    assert.match(html, /data-welcome-version-closed/);
    assert.doesNotMatch(html, /welcome-fund-btn|welcome-deposit-amount|Continue with MetaMask/);
    assert.match(html, /welcome-skip-btn/, 'a way out stays');
    // Closing it is not "dismissing the welcome": it has not been seen yet.
    welcome.overlay = { classList: { add() {} }, querySelector: () => null, querySelectorAll: () => [] };
    welcome.close = WelcomePanel.prototype.close;
    globalThis.document.documentElement.setAttribute = () => {};
    welcome.versionNoticeShown = true;
    welcome.close();
    assert.equal(sessionStorage.getItem('zkapi-oa-welcome-dismissed'), null);
    assert.equal(f.modal.isOpen, true);
});

test('an open welcome follows the facade, but never renders over a step in progress', t => {
    const facade = facadeFor(emptyClosed());
    fixture(t, { facade });
    const original = zkapiClient.subscribe;
    t.after(() => { zkapiClient.subscribe = original; });
    zkapiClient.subscribe = () => () => {};
    const welcome = new WelcomePanel({});
    let renders = 0;
    welcome.render = () => { renders++; };
    assert.equal(facade.listeners.size, 1);
    const [listener] = [...facade.listeners];
    welcome.isOpen = true;
    welcome.step = 'welcome';
    listener();
    assert.equal(renders, 1);
    welcome.step = 'redeeming';
    listener();
    welcome.step = 'welcome';
    welcome.busy = true;
    listener();
    welcome.busy = false;
    welcome.isOpen = false;
    listener();
    assert.equal(renders, 1);
});

test('a closed welcome whose person closed it keeps its dismissal when deposits are open', t => {
    fixture(t, {});
    const welcome = Object.create(WelcomePanel.prototype);
    Object.assign(welcome, { busy: false, isOpen: true, overlay: { classList: { add() {} }, querySelector: () => null, querySelectorAll: () => [] },
        app: {} });
    welcome.versionNoticeShown = false;
    welcome.close();
    assert.equal(sessionStorage.getItem('zkapi-oa-welcome-dismissed'), 'true');
});

// ---------------------------------------------------------------------------
// Clock ticks
// ---------------------------------------------------------------------------

test('a clock tick patches the countdown text and never remounts the dialog', t => {
    const state = holder(5);
    const kit = helpers();
    const f = fixture(t, { note: aNote(5), facade: facadeFor(state, { ui: kit.ui }) });
    const overlay = f.modal.overlay;
    overlay.selectors.set('[data-zkapi-version-closeby], [data-zkapi-version-tier], [data-zkapi-version-badge]', { textContent: '' });
    f.modal.render = () => assert.fail('a tick must not render unless a boundary was crossed');
    f.modal.canRefreshContent = () => true;
    f.modal.handleZkapiClock(NOW_MS);
    assert.equal(kit.calls.patch.length, 1);
    assert.equal(kit.calls.patch[0].root, overlay);
    assert.equal(kit.calls.patch[0].state, state);
    assert.equal(kit.calls.patch[0].options.now, NOW_MS);
    assert.equal(overlay.writes.length, 0, 'the subtree stays mounted');
});

test('a crossed boundary renders once, and only when the dialog may', t => {
    const kit = helpers();
    kit.ui.needsRender = true;
    const f = fixture(t, { note: aNote(5), facade: facadeFor(holder(5), { ui: kit.ui }) });
    f.modal.overlay.selectors.set('[data-zkapi-version-closeby], [data-zkapi-version-tier], [data-zkapi-version-badge]', {});
    let renders = 0;
    f.modal.render = () => { renders++; };
    f.modal.canRefreshContent = () => true;
    f.modal.handleZkapiClock(NOW_MS);
    assert.equal(renders, 1);
    f.modal.busy = true;
    f.modal.handleZkapiClock(NOW_MS);
    assert.equal(renders, 1, 'not while wallet work is running');
    f.modal.busy = false;
    f.modal.disclosureAnimating = true;
    f.modal.handleZkapiClock(NOW_MS);
    assert.equal(renders, 1, 'not while a disclosure moves');
});

test('with no countdown mounted a tick computes no version state', t => {
    const kit = helpers();
    const facade = facadeFor(holder(5), { ui: kit.ui });
    let reads = 0;
    facade.state = () => { reads++; return holder(5); };
    const f = fixture(t, { note: aNote(5), facade });
    f.modal.handleZkapiClock(NOW_MS);
    assert.equal(reads, 0);
    assert.equal(kit.calls.patch.length, 0);
});

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

function buttonOverlay(actions, { inBanner = false } = {}) {
    const overlay = overlayMock();
    const buttons = actions.map(action => {
        const button = { dataset: { zkapiVersionAction: action }, handlers: {}, closest: selector => (inBanner && selector === '[data-zkapi-version-banner]' ? {} : null),
            addEventListener(type, handler) { this.handlers[type] = handler; } };
        return button;
    });
    overlay.selectors.set('all:[data-zkapi-version-action]', buttons);
    return { overlay, buttons };
}

test('the upgrade and closed views’ buttons are wired by the dialog; banner buttons are the banner’s', async t => {
    const f = upgradeFixture(t);
    const own = buttonOverlay(['reload', 'cancel-unsent']);
    f.modal.overlay = own.overlay;
    let attached = 0;
    f.facade.ui.attach = () => { attached++; };
    f.modal.attachVersionActions(f.modal.versionContext());
    assert.equal(attached, 1, 'banners are delegated by the helper');
    assert.ok(own.buttons.every(button => typeof button.handlers.click === 'function'));
    const banner = buttonOverlay(['upgrade'], { inBanner: true });
    f.modal.overlay = banner.overlay;
    f.modal.attachVersionActions(f.modal.versionContext());
    assert.equal(banner.buttons[0].handlers.click, undefined, 'not bound twice');
});

test('without the helper’s own handler the buttons call the facade, and nothing else', async t => {
    const ready = emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2, viewOpen: true });
    assert.equal(ready.reload.reason, 'upgrade_withdrawn');
    const facade = facadeFor(ready, { confirmed: true });
    const f = fixture(t, { view: 'upgrade', facade });
    const notices = [];
    const context = { surface: 'dialog', notify: text => notices.push(text), refresh() {}, dispatch: (name, detail) => notices.push([name, detail]) };
    await f.modal.runVersionAction('reload', context);
    assert.deepEqual(facade.calls.at(-1), ['switch', { reason: 'upgrade_withdrawn', view: 'fund' }]);
    await f.modal.runVersionAction('open-previous', context);
    assert.deepEqual(facade.calls.at(-1), ['switch', { reason: 'finish_previous', view: 'withdrawals' }]);
    await f.modal.runVersionAction('claim-credit', context);
    assert.deepEqual(facade.calls.at(-1), ['switch', { reason: 'claim_credit', view: 'withdrawals' }]);
    await f.modal.runVersionAction('upgrade', context);
    assert.deepEqual(notices.at(-1), ['zkapi-payment-required', { view: 'upgrade' }]);
    // No facade call starts a withdrawal, a deposit or a signature.
    assert.deepEqual(facade.calls.filter(call => Array.isArray(call)).map(call => call[0]), ['switch', 'switch', 'switch']);
});

test('a refused switch is said in words, and a busy dialog never reloads', async t => {
    const ready = emptyClosed({ previewSelection: PREVIEW_V2, viewOpen: true });
    const facade = facadeFor(ready);
    facade.requestSwitch = () => ({ ok: false, why: 'loop' });
    const f = fixture(t, { view: 'upgrade', facade });
    const notices = [];
    const context = { surface: 'dialog', notify: text => notices.push(text), refresh() {}, dispatch() {} };
    await f.modal.runVersionAction('reload', context);
    assert.deepEqual(notices, ['Close other open tabs of this app, then reload.']);
    zkapiClient.oaVersioning = facadeFor({ ...ready, reload: { ...ready.reload, canReload: false } });
    await f.modal.runVersionAction('reload', context);
    assert.equal(notices.at(-1), 'Finish the current step first.');
});

test('cancelling an unsent deposit asks the facade once, with the dialog not busy, then says so', async t => {
    const state = derive({ snapshot: normalizedSnapshot({ hasUnsentPrepared: true, hasPendingDeposit: true }),
        selection: selectionFor(V1, { slotKind: 'unsent_prepared' }) });
    const facade = facadeFor(state);
    const seenBusy = [];
    facade.discardUnsentDeposit = async () => {
        seenBusy.push([...facade.busy].some(provider => provider()));
        facade.calls.push('discard');
        return { discarded: true };
    };
    const f = fixture(t, { facade });
    f.modal.render = () => {};
    f.modal.registerBusyForTest = facade.registerBusy(() => f.modal.busy === true || f.modal.fundingBusy === true);
    const pending = f.modal.runVersionAction('cancel-unsent', { surface: 'dialog', notify: () => {}, refresh() {}, dispatch() {} });
    assert.equal(f.modal.versionActionBusy, true, 'a second click is ignored');
    await f.modal.runVersionAction('cancel-unsent', { surface: 'dialog', notify: () => {}, refresh() {}, dispatch() {} });
    await pending;
    assert.deepEqual(facade.calls.filter(call => call === 'discard'), ['discard'], 'once');
    assert.deepEqual(seenBusy, [false], 'the facade refuses while the dialog says it is busy');
    assert.equal(f.modal.versionActionBusy, false);
    assert.match(f.modal.outcome.message, /Unfinished deposit cleared/);
});

test('a helper’s own handler is used when it has one', async t => {
    const calls = [];
    const kit = helpers({ act: async (action, context) => { calls.push([action, context.surface, Boolean(context.facade), Boolean(context.state)]); return { ok: true }; } });
    const facade = facadeFor(holder(20), { ui: kit.ui });
    const f = fixture(t, { note: aNote(), facade });
    await f.modal.runVersionAction('upgrade', { surface: 'dialog', notify() {}, refresh() {}, dispatch() {} });
    assert.deepEqual(calls, [['upgrade', 'dialog', true, true]]);
});

test('the dialog registers its own busy flags and follows the facade', t => {
    const facade = facadeFor(holder(20));
    const f = fixture(t, { note: aNote(), facade });
    const originals = ['subscribe', 'subscribeClock'].map(name => [name, zkapiClient[name]]);
    t.after(() => originals.forEach(([name, value]) => { zkapiClient[name] = value; }));
    zkapiClient.subscribe = () => () => {};
    zkapiClient.subscribeClock = () => () => {};
    t.mock.method(zkapiClient, 'init', async () => ({}));
    t.mock.method(AccountModal.prototype, 'updateTabIndicator', () => {});
    const modal = new AccountModal({}, {});
    assert.equal(facade.busy.size, 1);
    const [provider] = [...facade.busy];
    assert.equal(provider(), false);
    modal.busy = true;
    assert.equal(provider(), true);
    modal.busy = false;
    modal.fundingBusy = true;
    assert.equal(provider(), true);
    assert.equal(facade.listeners.size, 1);
    assert.equal(f.modal.isOpen, true);
});

// ---------------------------------------------------------------------------
// render(): the whole dialog
// ---------------------------------------------------------------------------

test('render reads one state, opens the upgrade view for the facade, and wires the views’ buttons', t => {
    const state = holder(20, { viewOpen: true });
    const f = fixture(t, { note: aNote(20), view: 'upgrade', facade: facadeFor(state) });
    let reads = 0;
    const facade = zkapiClient.oaVersioning;
    const read = facade.state;
    facade.state = () => { reads++; return read(); };
    const buttons = buttonOverlay(['reload']);
    f.modal.overlay = buttons.overlay;
    f.modal.render();
    assert.match(f.modal.overlay.html, /Upgrade your balance/);
    assert.match(f.modal.overlay.html, /data-zkapi-upgrade-view/);
    assert.deepEqual(facade.calls, ['begin']);
    assert.equal(reads, 1, 'one state read for the whole render, shared by every view in it');
    assert.equal(typeof buttons.buttons[0].handlers.click, 'function');
    assert.equal(f.modal.renderedVersion, undefined, 'a direct call to a view reads its own');
});

test('an upgrade view with nothing to upgrade renders as the balance and tells the facade it closed', t => {
    const state = derive({ active: V2, snapshot: noteSnapshot(NOW_S + 20 * DAY), selection: selectionFor(V2) });
    const f = fixture(t, { note: aNote(20), view: 'upgrade', facade: facadeFor(state, { active: V2 }) });
    f.modal.render();
    assert.equal(f.modal.view, 'balance');
    assert.doesNotMatch(f.modal.overlay.html, /data-zkapi-upgrade-view/);
    assert.match(f.modal.overlay.html, />Private balance</);
    const calls = zkapiClient.oaVersioning.calls;
    assert.equal(calls.filter(call => call === 'begin').length, calls.filter(call => call === 'end').length,
        'every begin is closed again');
});

test('closing the dialog closes the upgrade view for the facade', t => {
    const f = fixture(t, { note: aNote(20), view: 'upgrade', facade: facadeFor(holder(20, { viewOpen: true })) });
    f.modal.render();
    f.modal.overlay.classList = { add() {}, remove() {} };
    f.modal.close();
    assert.deepEqual(zkapiClient.oaVersioning.calls, ['begin', 'end']);
});

test('a reminder tier that was shown here is acknowledged once, for what was on screen', t => {
    const soon = holder(20 - 20 + 6, { viewOpen: false });
    assert.equal(soon.phase, 'upgrade-soon');
    assert.equal(soon.reminderTier, 3, 'tier');
    const f = fixture(t, { note: aNote(6), facade: facadeFor(soon) });
    const version = f.modal.versionContext();
    f.modal.acknowledgeShownReminder(version, false);
    assert.deepEqual(zkapiClient.oaVersioning.calls, [], 'not shown: not acknowledged');
    f.modal.acknowledgeShownReminder(version, true);
    f.modal.acknowledgeShownReminder(version, true);
    assert.deepEqual(zkapiClient.oaVersioning.calls, [['ack', 3]], 'once');
    // Nothing to remind about on a version that takes deposits.
    const target = derive({ active: V2, snapshot: noteSnapshot(NOW_S + 6 * DAY), selection: selectionFor(V2) });
    zkapiClient.oaVersioning = facadeFor(target, { active: V2 });
    f.modal.acknowledgedTier = undefined;
    f.modal.acknowledgeShownReminder(f.modal.versionContext(), true);
    assert.deepEqual(zkapiClient.oaVersioning.calls, []);
});

test('the review step says when chat keys are still settling', t => {
    const settling = holder(20, { viewOpen: true, busy: true });
    assert.equal(settling.upgrade.blockedBy, 'in_flight');
    assert.equal(settling.upgrade.stage, 'review', 'settling does not move the stage');
    const f = fixture(t, { note: aNote(20), view: 'upgrade', facade: facadeFor(settling) });
    assert.match(f.modal.renderUpgrade(), /data-upgrade-blocked="in_flight"/);
});

test('the dialog never offers test tokens, whatever the SDK could mint', t => {
    const f = fixture(t, { note: aNote(), config: { funding: { chain_id: 11155111, demo_mint_enabled: true } } });
    assert.doesNotMatch(f.modal.renderBalance(), /zkapi-mint-token-btn/);
});

// ---------------------------------------------------------------------------
// Composed with the page's real notice helpers (versioning/ui.js)
// ---------------------------------------------------------------------------

const { createVersionUi } = await import('../../chat/zkapi/versioning/ui.js');

test('the real notice helpers mount where the dialog puts them, and their patch agrees with the mount', t => {
    const state = holder(5);
    const facade = facadeFor(state);
    facade.ui = createVersionUi({ facade });
    const f = fixture(t, { note: aNote(5), facade });
    const html = f.modal.renderBalance();
    assert.match(html, /data-zkapi-version-badge-group data-zkapi-version-surface="dialog"/);
    assert.match(html, /id="zkapi-modal-version-help-toggle"/);
    assert.match(html, /id="zkapi-modal-version-help" data-zkapi-help-content="version" hidden/);
    assert.match(html, /data-zkapi-version-banner="dialog"/);
    assert.match(html, /data-zkapi-version-action="upgrade"/);
    assert.match(html, /data-zkapi-balance-expiry>[^<]*<\/span><button id="zkapi-modal-expiry-help-toggle"/);
    const card = html.indexOf('zkapi-balance-foot');
    assert.ok(card < html.indexOf('data-zkapi-version-banner="dialog"'));
    assert.ok(html.indexOf('data-zkapi-version-badge-group') < card);
    // Their patch, given a root holding exactly this markup, sees nothing to redo.
    const root = rootFrom(html);
    const result = facade.ui.patch(root, state, { now: NOW_MS });
    assert.deepEqual(result, { needsRender: false });
});

// A root with just enough of the DOM for the helpers' patch: the badge and
// banner elements found by attribute, the structure signature they wrote, and
// each notice's paragraphs.
function rootFrom(html) {
    const badge = /data-zkapi-version-badge(?:\s|>)/.test(html) ? [{ textContent: '', dataset: { zkapiVersionTone: /data-zkapi-version-tone="amber"/.test(html) ? 'amber' : 'muted' }, classList: { toggle() {} } }] : [];
    const sig = /data-zkapi-version-sig="([^"]*)"/.exec(html);
    const banner = /data-zkapi-version-banner="(\w+)"/.exec(html);
    const notices = [...html.matchAll(/data-zkapi-version-notice="(\w+)"[\s\S]*?(?=data-zkapi-version-notice=|$)/g)].map(match => ({
        dataset: { zkapiVersionNotice: match[1] },
        querySelectorAll: selector => (selector === '[data-zkapi-version-text]'
            ? [...match[0].matchAll(/data-zkapi-version-text="(\d+)"[^>]*>([^<]*)</g)].map(text => ({ textContent: text[2], dataset: {} })) : [])
    }));
    const banners = banner ? [{ dataset: { zkapiVersionBanner: banner[1], zkapiVersionSig: sig ? sig[1].replaceAll('&amp;', '&') : '' },
        querySelectorAll: selector => (selector === '[data-zkapi-version-notice]' ? notices : []), querySelector: () => null }] : [];
    return { querySelectorAll: selector => (selector === '[data-zkapi-version-badge]' ? badge : selector === '[data-zkapi-version-banner]' ? banners : []) };
}

test('a facade-attached dialog closes a lone exit-only version’s deposits with the real helpers too', t => {
    const lone = { ...emptyClosed(), show: false, target: null, gate: { canStart: false, canResume: false, code: 'deposits_closed', successor: null } };
    const facade = facadeFor(lone);
    facade.ui = createVersionUi({ facade });
    const f = fixture(t, { facade });
    const html = f.modal.renderBalance();
    assert.match(html, /data-zkapi-deposits-closed/);
    assert.doesNotMatch(html, /zkapi-deposit-btn|Continue with MetaMask/);
    assert.doesNotMatch(html, /data-zkapi-version-badge/);
});

test('buttons of the real banner reach the facade through the dialog’s own context', async t => {
    const state = emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2 });
    const facade = facadeFor(state);
    // What the real facade answers once the intent advanced on payout evidence.
    facade.flags = () => ({ draftDiscarded: false, discardLoop: false, withdrawalConfirmed: true });
    facade.ui = createVersionUi({ facade });
    const f = fixture(t, { view: 'upgrade', facade });
    // The view's reload button: the dialog hands the helper its facade and state.
    await f.modal.runVersionAction('reload', { surface: 'dialog', notify() {}, refresh() {}, dispatch() {} });
    assert.deepEqual(facade.calls.at(-1), ['switch', { reason: 'upgrade_withdrawn', view: 'fund' }]);
    // Opening the previous version, from the closed view.
    await f.modal.runVersionAction('open-previous', { surface: 'dialog', notify() {}, refresh() {}, dispatch() {} });
    assert.deepEqual(facade.calls.at(-1), ['switch', { reason: 'finish_previous', view: 'withdrawals' }]);
    // "Upgrade" from a banner opens the upgrade view of this very dialog.
    const dispatched = [];
    await f.modal.runVersionAction('upgrade', { surface: 'dialog', notify() {}, refresh() {}, dispatch: (name, detail) => dispatched.push([name, detail]) });
    assert.deepEqual(dispatched, [['zkapi-payment-required', { view: 'upgrade' }]]);
});

// ---------------------------------------------------------------------------
// Saved presentation
// ---------------------------------------------------------------------------

test('a saved dialog view is stamped with its network and version, and a stale stamp is ignored', t => {
    const f = fixture(t, { facade: facadeFor(emptyClosed()) });
    f.modal.view = 'balance';
    f.modal.isOpen = true;
    f.modal.rememberRunningModal();
    const saved = JSON.parse(storage.get('oa-zkapi-running-modal'));
    assert.equal(saved.view, 'balance');
    assert.equal(saved.versionId, 'v1');
    assert.equal(saved.network, 'mainnet');
    assert.equal(f.modal.readRunningModal()?.view, 'balance');
    // The tab moved to another version: the view of the old one is not restored.
    zkapiClient.oaVersioning = facadeFor(emptyClosed(), { active: V2 });
    assert.equal(f.modal.readRunningModal(), null);
    // An unstamped entry (an older build, or a version switch) stays valid.
    storage.set('oa-zkapi-running-modal', JSON.stringify({ view: 'fund' }));
    assert.equal(f.modal.readRunningModal()?.view, 'fund');
    // So does a stamp when there is no version context to compare it with.
    delete zkapiClient.oaVersioning;
    storage.set('oa-zkapi-running-modal', JSON.stringify({ view: 'fund', versionId: 'v9', network: 'sepolia' }));
    assert.equal(f.modal.readRunningModal()?.view, 'fund');
});

test('a single-version tab writes the view exactly as it always did', t => {
    const f = fixture(t, {});
    f.modal.view = 'fund';
    f.modal.isOpen = true;
    f.modal.rememberRunningModal();
    assert.deepEqual(Object.keys(JSON.parse(storage.get('oa-zkapi-running-modal'))).sort(),
        ['amount', 'currency', 'help', 'history', 'method', 'mode', 'scroll', 'setup', 'view']);
});

test('the upgrade view is restorable, and the welcome intent obeys the same stamp', t => {
    const f = fixture(t, { facade: facadeFor(holder(20)) });
    storage.set('oa-zkapi-running-modal', JSON.stringify({ view: 'upgrade', versionId: 'v1', network: 'mainnet' }));
    assert.equal(f.modal.readRunningModal()?.view, 'upgrade');
    const welcome = Object.assign(Object.create(WelcomePanel.prototype), { app: {} });
    // Another version's saved welcome is not this page's: only the ordinary
    // rules (no balance, not dismissed) decide, and a balance ends them.
    zkapiClient.wallet = { has_note: true, note: aNote() };
    storage.set('oa-zkapi-welcome-modal', JSON.stringify({ open: true, method: 'metamask', versionId: 'v2' }));
    assert.equal(welcome.shouldShow(), false, 'a stamp of another version is ignored');
    storage.set('oa-zkapi-welcome-modal', JSON.stringify({ open: true, method: 'metamask', versionId: 'v1' }));
    assert.equal(welcome.shouldShow(), true, 'this version’s own saved welcome is restored');
    storage.set('oa-zkapi-welcome-modal', JSON.stringify({ open: true, method: 'metamask' }));
    assert.equal(welcome.shouldShow(), true, 'an unstamped one stays valid');
});

// ---------------------------------------------------------------------------
// The funding view's own words
// ---------------------------------------------------------------------------

test('a flow a version closed is final: no retry promise, its plain error shown', t => {
    // A deposit that started may still be finished, so the funding view is up.
    const started = derive({ snapshot: normalizedSnapshot({ hasPendingDeposit: true }),
        selection: selectionFor(V1, { reason: 'runtime_holds_note', slotKind: 'pending_deposit' }) });
    fixture(t, { facade: facadeFor(started), config: { pending_deposit: { phase: 'prepared', amount: '5000000', funding_quote_available: true } } });
    setWalletMethod('address');
    t.after(() => setWalletMethod('metamask'));
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: `0x${'2'.repeat(40)}`, pending: null, migrationRequired: false };
    const retrying = ownerOf({ fundingFlow: { error: 'The estimate failed.', requestedAmount: { value: '5' }, intent: null, fee: null } });
    assert.match(controls.renderFundingAccount(retrying), /Retrying automatically/);
    const closed = ownerOf({ fundingFlow: { closed: { code: 'deposits_closed' }, error: 'This version no longer accepts new deposits.',
        requestedAmount: { value: '5' }, intent: null, fee: null, running: false } });
    const html = controls.renderFundingAccount(closed);
    assert.doesNotMatch(html, /Retrying automatically|Change the amount or switch/);
    assert.match(html, /Deposits are closed/);
    assert.match(html, /This version no longer accepts new deposits\./);
});

// ---------------------------------------------------------------------------
// Leftover ETH at a previous version's address
// ---------------------------------------------------------------------------

function rescueFixture(t) {
    const target = derive({ active: V2, selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }) });
    const calls = [];
    const rescue = {
        listRetiredScopes: async options => { calls.push(['list', options.table.length]); return [
            { versionId: 'v1', scope: `1:${V1.vault}:native-eth`, address: `0x${'5'.repeat(40)}`, pending: false, lastReturn: null, unreadable: false }
        ]; },
        checkRetiredScopeBalance: async options => { calls.push(['check', options.scope]); return { balanceWei: '2500000000000000' }; },
        sweepRetiredScope: async options => { calls.push(['sweep', options.scope, options.destination]); return { versionId: 'v1', transactionHash: `0x${'a'.repeat(64)}` }; },
        recoverRetiredScope: async options => { calls.push(['recover', options.scope]); return { status: 'confirmed' }; }
    };
    const facade = facadeFor(target, { ui: { ...helpers().ui, rescue }, active: V2, selection: selectionFor(V2) });
    fixture(t, { facade });
    setWalletMethod('address');
    t.after(() => setWalletMethod('metamask'));
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: `0x${'2'.repeat(40)}`, pending: null, migrationRequired: false };
    return { calls, rescue, facade };
}

function clickable(owner, selectorNames) {
    const buttons = {};
    for (const [selector, dataset] of selectorNames) {
        const button = { dataset, handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; } };
        owner.overlay.selectors.set(`all:${selector}`, [button]);
        buttons[selector] = button;
    }
    return buttons;
}

test('leftover ETH: local facts on open, a balance only on an explicit click, privacy first', async t => {
    const { calls } = rescueFixture(t);
    const owner = ownerOf({ view: 'fund' });
    controls.attachWalletMethodControls(owner);
    await tick();
    assert.deepEqual(calls, [['list', TABLE.length]], 'one local read, no balance');
    let html = controls.renderFundingAccount(owner);
    assert.match(html, /data-funding-retired/);
    assert.match(html, /Version 1 funding address · 0x5555…5555/);
    const privacy = html.indexOf('links it to this one there');
    const check = html.indexOf('data-funding-retired-check="v1"');
    assert.ok(privacy > 0 && check > privacy, 'the privacy sentence comes before the button');
    assert.doesNotMatch(html, /data-funding-retired-move/);
    // Rendering again (and again) reads no balance.
    controls.renderFundingAccount(owner);
    controls.renderFundingAccount(owner);
    assert.deepEqual(calls, [['list', TABLE.length]]);

    // The click.
    const buttons = clickable(owner, [['[data-funding-retired-check]', { fundingRetiredCheck: 'v1' }]]);
    owner.overlay.querySelectorAll = selector => owner.overlay.selectors.get(`all:${selector}`) ?? [];
    controls.attachWalletMethodControls(owner);
    await buttons['[data-funding-retired-check]'].handlers.click();
    assert.equal(calls.filter(call => call[0] === 'check').length, 1);
    html = controls.renderFundingAccount(owner);
    assert.match(html, /ETH at this address: 0\.0025 ETH/);
    assert.match(html, /data-funding-retired-move="v1"/);
});

test('leftover ETH: a return is signed only after the person confirms, to this browser’s address', async t => {
    const { calls } = rescueFixture(t);
    const owner = ownerOf({ view: 'fund', retiredScopes: [{ versionId: 'v1', scope: `1:${V1.vault}:native-eth`, address: `0x${'5'.repeat(40)}`, pending: false, lastReturn: null }],
        retiredChecks: { v1: { balanceWei: '2500000000000000' } } });
    const buttons = clickable(owner, [['[data-funding-retired-move]', { fundingRetiredMove: 'v1' }]]);
    const confirmations = [];
    globalThis.confirm = message => { confirmations.push(message); return false; };
    t.after(() => { delete globalThis.confirm; });
    t.mock.method(zkapiClient, 'setWalletProvider', () => {});
    t.mock.method(addressFundingWallet, 'reload', async () => {});
    t.mock.method(addressFundingWallet, 'init', async () => {});
    controls.attachWalletMethodControls(owner);
    await buttons['[data-funding-retired-move]'].handlers.click();
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0], /0\.0025 ETH/);
    assert.match(confirmations[0], /network fee comes out of that amount/);
    assert.equal(calls.some(call => call[0] === 'sweep'), false, 'declined');
    globalThis.confirm = () => true;
    await buttons['[data-funding-retired-move]'].handlers.click();
    const sweep = calls.find(call => call[0] === 'sweep');
    assert.ok(sweep);
    assert.equal(sweep[2], `0x${'2'.repeat(40)}`, 'to the funding address this browser holds now');
    assert.equal(owner.retiredChecks, null, 'the balance read before the return is dropped');
    assert.match(owner.fundingNotice, /Transfer submitted/);
});

test('leftover ETH is not offered on a single-version page or without the helpers', async t => {
    fixture(t, {});
    setWalletMethod('address');
    t.after(() => setWalletMethod('metamask'));
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: `0x${'2'.repeat(40)}`, pending: null, migrationRequired: false };
    const owner = ownerOf({ retiredScopes: [{ versionId: 'v1', scope: 'x', address: `0x${'5'.repeat(40)}` }] });
    assert.doesNotMatch(controls.renderFundingAccount(owner), /data-funding-retired/);
    zkapiClient.oaVersioning = facadeFor(holder(20));
    assert.doesNotMatch(controls.renderFundingAccount(owner), /data-funding-retired/, 'no rescue helpers on the ui');
});

// ---------------------------------------------------------------------------
// UpgradeView itself: pure, escaped, in the product's words
// ---------------------------------------------------------------------------

const everyStage = () => {
    const intent = { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawn', since: NOW_MS - 1000 };
    const withdrawing = { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawing', since: NOW_MS - 1000 };
    return {
        idle: emptyClosed({ previewSelection: null }),
        review: holder(20, { viewOpen: true }),
        withdrawing: holder(20, { snapshot: noteSnapshot(NOW_S + 20 * DAY, { hasPreparedWithdrawal: true }), viewOpen: true }),
        confirming: derive({ snapshot: normalizedSnapshot({ hasOpenWithdrawal: true }), withdrawalPhase: 'submitted_unconfirmed',
            selection: selectionFor(V1, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }) }),
        ready_to_switch: emptyClosed({ intent: withdrawing, previewSelection: PREVIEW_V2 }),
        deposit: derive({ active: V2, intent, selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }) }),
        done: derive({ active: V2, intent, snapshot: noteSnapshot(NOW_S + 30 * DAY), selection: selectionFor(V2) }),
        blocked: holder(0, { snapshot: noteSnapshot(NOW_S - 100), viewOpen: true })
    };
};

test('every stage renders the three steps, in order, with the current one marked', () => {
    for (const [stage, state] of Object.entries(everyStage())) {
        assert.equal(state.upgrade.stage, stage);
        const html = renderUpgradeView({ state, stage, funding: 'metamask', withdrawalHtml: '', destination: {}, sepolia: false });
        assert.match(html, new RegExp(`data-upgrade-stage="${stage}"`));
        assert.deepEqual([...html.matchAll(/data-upgrade-step="(\w+)"/g)].map(match => match[1]), ['withdraw', 'reload', 'deposit'], stage);
        const marks = [...html.matchAll(/data-upgrade-step="(\w+)" data-state="(\w+)"( aria-current="step")?/g)];
        assert.ok(marks.filter(mark => mark[3]).length <= 1, 'one current step at most');
    }
});

test('the steps tell where the person is', () => {
    const states = everyStage();
    const at = (stage, funding = 'metamask') => {
        const html = renderUpgradeView({ state: states[stage], stage, funding, withdrawalHtml: '' });
        return Object.fromEntries([...html.matchAll(/data-upgrade-step="(\w+)" data-state="(\w+)"/g)].map(match => [match[1], match[2]]));
    };
    assert.deepEqual(at('review'), { withdraw: 'waiting', reload: 'upcoming', deposit: 'upcoming' });
    assert.deepEqual(at('withdrawing'), { withdraw: 'active', reload: 'upcoming', deposit: 'upcoming' });
    assert.deepEqual(at('ready_to_switch'), { withdraw: 'complete', reload: 'waiting', deposit: 'upcoming' });
    assert.deepEqual(at('deposit'), { withdraw: 'complete', reload: 'complete', deposit: 'waiting' });
    assert.deepEqual(at('done'), { withdraw: 'complete', reload: 'complete', deposit: 'complete' });
});

test('the upgrade view is a string of the arguments alone and escapes what it is given', () => {
    const state = holder(20, { viewOpen: true });
    const hostile = { ...state, target: { id: 'v2', label: 'Version <img src=x onerror=alert(1)>' } };
    const html = renderUpgradeView({ state: hostile, stage: 'review', funding: 'address', withdrawalHtml: '<i data-embedded></i>',
        destination: { choice: 'other', newAddress: null, typed: '"><script>alert(1)</script>' }, sepolia: true, canCreateAddress: true });
    assert.doesNotMatch(html, /<img|<script/);
    assert.match(html, /&lt;img src=x/, 'shown as text');
    assert.match(html, /data-embedded/, 'the embedded withdrawal is passed through whole');
    // A created address that is not an address is not shown as one.
    const bad = renderUpgradeView({ state, stage: 'review', funding: 'address', withdrawalHtml: '',
        destination: { choice: 'new-address', newAddress: '"><b>x</b>' }, canCreateAddress: true });
    assert.doesNotMatch(bad, /<b>x/);
    assert.match(bad, /data-upgrade-new-address/);
    // Not a state: nothing.
    assert.equal(renderUpgradeView({}), '');
    assert.equal(renderUpgradeView(null), '');
    assert.equal(renderDepositsClosedView({ state: null }), '');
});

test('the upgrade view speaks the product’s language: no protocol vocabulary, no emoji', () => {
    const forbidden = /nullifier|vault|circuit|deployment|manifest|\bnotes?\b|note\s*#|unlinkable|untraceable|anonymous|zero.knowledge|proof\b/i;
    for (const [stage, state] of Object.entries(everyStage())) {
        for (const funding of ['metamask', 'address']) {
            const html = renderUpgradeView({ state, stage, funding, withdrawalHtml: '', destination: {}, sepolia: true, canCreateAddress: true,
                gas: { balanceWei: '0' } });
            const text = textOf(html);
            assert.equal(forbidden.test(text), false, `${stage}/${funding}: ${text}`);
            assert.equal(/\p{Extended_Pictographic}/u.test(text), false);
            assert.equal(/!/.test(text), false, 'no exclamation marks');
        }
    }
    for (const unsent of [false, true]) {
        const html = renderDepositsClosedView({ state: emptyClosed(), unsent });
        assert.equal(forbidden.test(textOf(html)), false, textOf(html));
    }
});

test('the upgrade never implies the two transactions are unlinkable', () => {
    const html = renderUpgradeView({ state: everyStage().review, stage: 'review', funding: 'metamask', withdrawalHtml: '' });
    assert.match(textOf(html), /both are public on Ethereum, and the two can be linked by address, amount and time/i);
});

test('the review step warns when the funding address has no ETH for the withdrawal fee', () => {
    const state = everyStage().review;
    const none = renderUpgradeView({ state, stage: 'review', funding: 'address', withdrawalHtml: '', destination: {}, gas: { balanceWei: '0' } });
    assert.match(none, /data-upgrade-gas/);
    const some = renderUpgradeView({ state, stage: 'review', funding: 'address', withdrawalHtml: '', destination: {}, gas: { balanceWei: '10' } });
    assert.doesNotMatch(some, /data-upgrade-gas/);
    // Unknown is not "none": a balance that was not read says nothing.
    const unknown = renderUpgradeView({ state, stage: 'review', funding: 'address', withdrawalHtml: '', destination: {}, gas: { balanceWei: null } });
    assert.doesNotMatch(unknown, /data-upgrade-gas/);
});

test('blocked upgrades say why in the words of the states table', () => {
    const base = holder(20, { viewOpen: true });
    const blocked = reason => renderUpgradeView({
        state: { ...base, upgrade: { ...base.upgrade, stage: 'blocked', blockedBy: reason, canStart: false } }, stage: 'blocked', funding: 'metamask',
        withdrawalHtml: '<div data-embedded></div>'
    });
    assert.match(blocked('pending_deposit'), /Finish your deposit first\. It can still be completed on version 1\./);
    assert.doesNotMatch(blocked('pending_deposit'), /data-embedded/, 'nothing to withdraw yet');
    assert.match(blocked('claimed'), /claimed after expiry\. No refund was made/);
    assert.match(blocked('expired'), /You can still try withdrawing while it remains unclaimed/);
    assert.match(blocked('expired'), /data-embedded/);
    assert.match(blocked('open_withdrawal'), /Finish the withdrawal that is already in progress first\. Deposits to version 2 wait until it finishes\./);
    assert.match(blocked('in_flight'), /still settling/);
    const unsent = renderUpgradeView({ state: { ...base, unsent: true, upgrade: { ...base.upgrade, stage: 'blocked', blockedBy: 'unsent_deposit' } },
        stage: 'blocked', funding: 'metamask', withdrawalHtml: '' });
    assert.match(unsent, /data-zkapi-version-action="cancel-unsent"/);
});

test('the closed view is keyed on the gate, so a lone exit-only version still explains itself', () => {
    const lone = { ...emptyClosed(), show: false, target: null, gate: { canStart: false, canResume: false, code: 'deposits_closed', successor: null } };
    const html = renderDepositsClosedView({ state: lone, unsent: false });
    assert.match(html, /data-zkapi-gate-code="deposits_closed"/);
    assert.match(html, /Deposits are closed/);
    assert.match(textOf(html), /Version 1 no longer accepts new deposits/);
    assert.doesNotMatch(html, /Deposits moved to version/);
    // An open gate has nothing to show unless a plan is unsent.
    const open = derive({ active: V2, selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }) });
    assert.equal(open.gate.canStart, true);
    assert.equal(renderDepositsClosedView({ state: open, unsent: false }), '');
    assert.match(renderDepositsClosedView({ state: open, unsent: true }), /cancel-unsent/);
});

test('the closed view names each reason and offers only what is true', () => {
    const closed = code => ({ ...emptyClosed(), gate: { canStart: false, canResume: false, code, successor: null } });
    const cases = {
        previous_withdrawal_open: /A withdrawal is still finishing/,
        holdings_unreadable: /could not be read/,
        foreign_runtime: /can’t be opened here/,
        stale_build: /Reload to update/,
        config_mismatch: /Reload to update/,
        version_unavailable: /unavailable in this tab/
    };
    for (const [code, pattern] of Object.entries(cases)) {
        const html = renderDepositsClosedView({ state: closed(code), unsent: false });
        assert.match(html, pattern, code);
        // A gate that ends in "Reload" has the button; one that does not has none.
        const reloadable = code !== 'previous_withdrawal_open';
        assert.equal(/data-zkapi-version-action="reload"/.test(html), reloadable, code);
    }
    // Reloading changes nothing for a retired owner, so none is offered.
    assert.doesNotMatch(renderDepositsClosedView({ state: closed('foreign_runtime'), unsent: false, retired: true }), /action="reload"/);
    // Work in flight: present, disabled, with the reason.
    const busy = renderDepositsClosedView({ state: { ...closed('stale_build'), reload: { ...closed('stale_build').reload, canReload: false } }, unsent: false });
    assert.match(busy, /data-zkapi-version-action="reload" disabled/);
    assert.match(busy, /Finish the current step first/);
    const retired = renderDepositsClosedView({ state: closed('foreign_runtime'), unsent: false, retired: true });
    assert.match(retired, /retired version/);
    assert.doesNotMatch(textOf(retired), /nothing is lost/i);
    // Another version's open withdrawal can be opened from here when the slot is free.
    const previous = { ...closed('previous_withdrawal_open'), previous: { versionId: 'v2', openWithdrawals: 1, credits: 0, canOpen: true, closeByTs: null } };
    assert.match(renderDepositsClosedView({ state: previous, unsent: false }), /data-zkapi-version-action="open-previous"/);
    const blocked = { ...previous, previous: { ...previous.previous, canOpen: false } };
    assert.doesNotMatch(renderDepositsClosedView({ state: blocked, unsent: false }), /open-previous/);
    assert.match(textOf(renderDepositsClosedView({ state: blocked, unsent: false })), /withdraw your current balance first/);
});

// ---------------------------------------------------------------------------
// Evaluated with imports removed
// ---------------------------------------------------------------------------

test('the new paths run in a vm with no imports and no facade', () => {
    const source = name => fs.readFileSync(new URL(`../../chat/zkapi/components/${name}.js`, import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\n/gm, '').replace(/export (async )?function /g, '$1function ')
        .replace(/export default class /g, 'class ');
    const client = { config: { funding: { chain_id: 1 } }, note: null, withdrawals: [], deposits: [], isNativeEthFunding: true };
    const stubs = ['fundingDisclosure', 'attachFundingDisclosures', 'captureFundingDisclosureView', 'restoreFundingDisclosureView',
        'showSurface', 'hideSurface', 'revealText', 'settlePrivateAccess', 'availableWithdrawalEscape', 'sameWithdrawalEscape',
        'assertWithdrawalEscapeAvailable', 'canCancelPreparedWithdrawal', 'ethUnits', 'depositOperationId', 'isWalletCancellation',
        'resetCanceledDeposit', 'attachWalletModalRestoreCancellation', 'cancelWalletModalRestore', 'currentWalletModalRestore',
        'finishWalletModalRestore', 'parseTokenAmount', 'walletErrorMessage', 'explainZkapiError', 'isIndexerLag', 'pendingDepositMessage',
        'updateZkapiBalanceControl', 'captureFundingSetupView', 'fundingSetupGuide', 'restoreFundingSetupView', 'walletJourney',
        'canQuotePendingAddressDeposit', 'runAddressAction', 'withdrawalDestination', 'initWalletClient', 'prepareWalletMethod',
        'setWalletMethod', 'subscribeWalletMethod', 'attachWalletMethodControls', 'captureWalletView', 'refreshWalletView',
        'renderDepositAmount', 'prepareDepositAmount', 'renderFundingAccount', 'renderFundingWei', 'renderWalletMethod',
        'restoreWalletView', 'stopFundingFlow', 'isFundingViewHydrating', 'attachPrivateBalanceHelp', 'capturePrivateBalanceHelpFocus',
        'privateBalanceExpiryLabel', 'privateBalanceExpired', 'privateBalanceGuide', 'privateBalanceHelpButton', 'privateBalanceHelpContent',
        'restorePrivateBalanceHelpFocus', 'updatePrivateBalanceExpiryState', 'zkapiErrorMessage', 'runAddressAction'];
    const context = {
        zkapiClient: client, addressFundingWallet: { pending: null, address: null, hasPendingTransaction: false },
        getWalletMethod: () => 'metamask', walletMethodText: value => value,
        readWelcomeModalIntent: () => null, writeWelcomeModalIntent() {},
        window: { sessionStorage, addEventListener() {} }, document: { activeElement: null, getElementById: () => null },
        localStorage: sessionStorage, setTimeout, clearTimeout, queueMicrotask,
        ...Object.fromEntries(stubs.map(name => [name, () => '']))
    };
    context.getWalletMethod = () => 'metamask';
    context.walletMethodText = value => value;
    const Account = vm.runInNewContext(`${source('AccountModal')}\nAccountModal;`, { ...context });
    const modal = Object.create(Account.prototype);
    Object.assign(modal, { busy: false, isOpen: true, view: 'balance', overlay: { querySelector: () => null, querySelectorAll: () => [] } });
    // None of these may throw a ReferenceError, and all of them read "no versions".
    assert.equal(modal.versionContext(), null);
    assert.equal(modal.currentVersion(), null);
    assert.equal(modal.depositsWaitLine(), '');
    assert.equal(JSON.stringify(modal.renderVersionBadge(null)), JSON.stringify({ badge: '', help: '' }));
    assert.equal(modal.renderVersionBanner(null), '');
    assert.equal(modal.renderDepositsClosed(null, null), '');
    assert.equal(modal.renderVersionLead(null), '');
    assert.equal(modal.upgradeViewTarget(null), 'balance');
    assert.equal(modal.upgradeDestinationRefusal(), '');
    modal.syncUpgradeView();
    modal.patchVersionNotices(Date.now());
    modal.attachVersionActions(null);
    modal.attachUpgradeDestination(null);
    modal.isOpen = false;
    modal.handleVersionChange();
    modal.isOpen = true;
    assert.equal(modal.readRunningModal(), null);
    // The new helper paths of the other two sources, from their own evaluation.
    const Welcome = vm.runInNewContext(`${source('WelcomePanel')}\nWelcomePanel;`, { ...context });
    const welcome = Object.create(Welcome.prototype);
    assert.equal(welcome.renderVersionClosed(), '');
    welcome.attachVersionActions();
    const evaluated = vm.runInNewContext(`${source('WalletMethodControls')}\n({ renderDepositAmount, prepareDepositAmount });`,
        { ...context, chatDB: {}, AddressDepositFlow: class {}, DepositAmount: class {}, renderFundingPaymentQr: () => '',
            renderFundingProgress: () => '', walletMethodActionBusy: () => false, canQuotePendingAddressDeposit: () => false,
            formatFundingAmount: () => '', fundingAmount: () => '', fundingEthAmount: () => '', fundingDestination: () => '' });
    assert.match(evaluated.renderDepositAmount({ isOpen: true, view: 'fund', escapeHtml: String, busy: false }), /data-funding-amount/);
});

// ---------------------------------------------------------------------------
// The guided flow across the gaps between states
// ---------------------------------------------------------------------------

const withRealHelpers = facade => { facade.ui = createVersionUi({ facade }); return facade; };

// The upgrade's own withdrawal, submitted and waiting to be confirmed.
const confirmingNow = (overrides = {}) => derive({
    snapshot: normalizedSnapshot({ hasOpenWithdrawal: true }), withdrawalPhase: 'submitted_unconfirmed', viewOpen: true,
    selection: selectionFor(V1, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }), ...overrides
});
const stageDrawn = html => /data-upgrade-stage="(\w+)"/.exec(html)?.[1] ?? null;

test('a withdrawal that ends in the background keeps the upgrade view until the holdings read arrives', t => {
    const confirming = confirmingNow();
    assert.equal(confirming.upgrade.stage, 'confirming');
    const f = fixture(t, { view: 'upgrade', facade: facadeFor(confirming),
        withdrawals: [{ recordId: 'r1', mode: 'mutual', phase: 'submitted_unconfirmed', finalBalance: 1_500_000 }] });
    f.modal.render();
    assert.equal(stageDrawn(f.modal.overlay.html), 'confirming');

    // The record closes in the SDK. Nothing is held and no read has arrived:
    // the facade's stage is idle for the moment. The view waits, with the
    // withdrawal drawn as done, and does not become the balance.
    const gap = emptyClosed({ viewOpen: true });
    assert.equal(gap.upgrade.stage, 'idle');
    zkapiClient.oaVersioning = facadeFor(gap, { confirmed: true });
    zkapiClient.withdrawals = [{ recordId: 'r1', mode: 'mutual', phase: 'closed', finalBalance: 1_500_000, payoutVerified: true }];
    f.modal.render();
    assert.equal(f.modal.view, 'upgrade');
    let html = f.modal.overlay.html;
    assert.match(html, /Withdrawal confirmed\. Checking whether version 2 is ready to load/);
    assert.deepEqual(Object.fromEntries([...html.matchAll(/data-upgrade-step="(\w+)" data-state="(\w+)"/g)].map(match => [match[1], match[2]])),
        { withdraw: 'complete', reload: 'waiting', deposit: 'upcoming' });
    // The step's own detail line is not shown for a Reload that is not there yet.
    assert.doesNotMatch(html, /Reload to open version 2/);
    assert.equal(f.modal.upgradeSettleShown, true);

    // The read arrives: Reload is the step, and the view never left.
    zkapiClient.oaVersioning = facadeFor(emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2, viewOpen: true }),
        { confirmed: true });
    f.modal.render();
    html = f.modal.overlay.html;
    assert.equal(f.modal.view, 'upgrade');
    assert.equal(stageDrawn(html), 'ready_to_switch');
    assert.match(html, /data-zkapi-version-action="reload"/);
    assert.equal(f.modal.upgradeSettleShown, false);
});

test('the wait for the holdings read is bounded, and the clock ends it', t => {
    const f = fixture(t, { view: 'upgrade', facade: facadeFor(confirmingNow()) });
    f.modal.render();
    zkapiClient.oaVersioning = facadeFor(emptyClosed({ viewOpen: true }));
    f.modal.render();
    assert.equal(f.modal.view, 'upgrade');
    f.modal.canRefreshContent = () => true;
    // Inside the bound a tick leaves the page alone.
    const written = f.modal.overlay.writes.length;
    f.modal.handleZkapiClock(Date.now());
    assert.equal(f.modal.overlay.writes.length, written);
    // Past it, the next tick hands the view to the balance, once.
    f.modal.upgradeSettleSince = Date.now() - 60_000;
    f.modal.handleZkapiClock(Date.now());
    assert.equal(f.modal.view, 'balance');
    assert.equal(f.modal.upgradeSettleShown, false);
    const after = f.modal.overlay.writes.length;
    f.modal.handleZkapiClock(Date.now());
    assert.equal(f.modal.overlay.writes.length, after, 'and no more');
});

test('a view that never watched a withdrawal in motion has nothing to wait for', t => {
    // A saved upgrade view restored over an empty wallet: straight to the balance.
    const f = fixture(t, { view: 'upgrade', facade: facadeFor(emptyClosed({ viewOpen: true })) });
    f.modal.render();
    assert.equal(f.modal.view, 'balance');
    // The same for a review step that lost its balance some other way.
    const g = fixture(t, { note: aNote(20), view: 'upgrade', facade: facadeFor(holder(20, { viewOpen: true })) });
    g.modal.render();
    assert.equal(g.modal.view, 'upgrade');
    zkapiClient.wallet = { has_note: false, note: null };
    zkapiClient.oaVersioning = facadeFor(emptyClosed({ viewOpen: true }));
    g.modal.render();
    assert.equal(g.modal.view, 'balance');
});

test('a set-aside note keeps its deadline in the dialog, where the closed view cannot say it', t => {
    // v1, no slot note, one note set aside and expiring in five days.
    const aside = derive({
        snapshot: normalizedSnapshot({ hasOpenWithdrawal: true, deadlines: [{ source: 'set-aside', expiryTs: NOW_S + 5 * DAY }] }),
        selection: selectionFor(V1, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' })
    });
    assert.equal(aside.phase, 'finish-previous-withdrawal');
    assert.equal(aside.previous.versionId, 'v1', 'this very version holds it');
    assert.equal(aside.reminderTier, 3);
    const f = fixture(t, { facade: withRealHelpers(facadeFor(aside)) });
    const html = f.modal.renderBalance();
    assert.match(html, /data-zkapi-deposits-closed/);
    assert.match(html, /data-zkapi-version-banner="dialog"/);
    assert.match(textOf(html), /3 days left to upgrade\. Withdraw by/);
    // Another version's withdrawal is what the closed view says in full.
    const other = derive({
        active: V2,
        selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty',
            open: { v1: [{ recordId: 'w1', mode: 'mutual', phase: 'parked', noteId: 7, expiryTs: NOW_S + 5 * DAY }] } })
    });
    assert.equal(other.phase, 'finish-previous-withdrawal');
    assert.equal(other.gate.code, 'previous_withdrawal_open');
    assert.notEqual(other.previous.versionId, other.current.id);
    zkapiClient.oaVersioning = withRealHelpers(facadeFor(other, { active: V2, selection: selectionFor(V2) }));
    const said = f.modal.renderBalance();
    assert.match(said, /data-zkapi-deposits-closed/);
    assert.equal(hooks(said).banner, false, 'not said twice');
});

test('a cleared draft and a loop warning are not lost behind the closed view', t => {
    const closed = emptyClosed();
    const facade = withRealHelpers(facadeFor(closed));
    facade.flags = () => ({ draftDiscarded: false, discardLoop: true });
    const f = fixture(t, { facade });
    const html = f.modal.renderBalance();
    assert.match(html, /data-zkapi-deposits-closed/);
    assert.match(html, /data-zkapi-version-notice="loop"/);
    // Nothing the closed view already says is left to show: no banner.
    facade.flags = () => ({ draftDiscarded: false, discardLoop: false });
    assert.equal(hooks(f.modal.renderBalance()).banner, false);
    // A banner this cannot read is shown rather than assumed to be repeated.
    zkapiClient.oaVersioning = facadeFor(closed, { ui: { ...helpers().ui, banner: () => '<div data-zkapi-version-banner="dialog">Something new</div>' } });
    assert.match(f.modal.renderBalance(), /Something new/);
    // So is host markup, which the closed view never says.
    zkapiClient.oaVersioning = facadeFor(closed, { ui: { ...helpers().ui, protocolNotices: () => '<p>Host</p>' } });
    assert.equal(hooks(f.modal.renderBalance()).banner, true);
});

test('the clock never renders the dialog over a banner its view left out on purpose', t => {
    // On version 2 with the upgrade's lead above a balance: the pill is
    // mounted, the "done" banner is not (the lead says it).
    const done = derive({ active: V2, intent: WITHDRAWN_INTENT, snapshot: noteSnapshot(NOW_S + 30 * DAY), selection: selectionFor(V2) });
    assert.equal(done.upgrade.stage, 'done');
    const facade = withRealHelpers(facadeFor(done, { active: V2, selection: selectionFor(V2) }));
    const f = fixture(t, { note: aNote(30), view: 'upgrade', facade });
    f.modal.render();
    assert.equal(hooks(f.modal.overlay.html).banner, false);
    assert.equal(f.modal.versionBannerSuppressed, true);
    // The DOM the render made, as the helper's patch sees it: a pill, no banner.
    const { overlay } = f.modal;
    const pill = { textContent: 'Version 2', dataset: { zkapiVersionTone: 'muted' }, classList: { toggle() {} } };
    overlay.selectors.set('[data-zkapi-version-closeby], [data-zkapi-version-tier], [data-zkapi-version-badge]', pill);
    overlay.selectors.set('[data-zkapi-version-badge]', pill);
    overlay.selectors.set('all:[data-zkapi-version-badge]', [pill]);
    let renders = 0;
    const render = f.modal.render.bind(f.modal);
    f.modal.render = () => { renders++; render(); };
    f.modal.canRefreshContent = () => true;
    for (let tick = 0; tick < 5; tick++) f.modal.handleZkapiClock(NOW_MS + tick * 1000);
    assert.equal(renders, 0, 'five ticks, no render');
    // A notice the lead does not say, raised since, is a change: it renders.
    facade.flags = () => ({ draftDiscarded: false, discardLoop: true });
    f.modal.handleZkapiClock(NOW_MS);
    assert.equal(renders, 1, 'a loop warning is not the lead’s sentence');
    assert.match(f.modal.overlay.html, /data-zkapi-version-notice="loop"/);
    facade.flags = () => ({ draftDiscarded: false, discardLoop: false });
    renders = 0;
    // A pill the state wants and the page lacks is still a change.
    overlay.selectors.delete('[data-zkapi-version-badge]');
    overlay.selectors.set('all:[data-zkapi-version-badge]', []);
    overlay.selectors.set('[data-zkapi-version-closeby], [data-zkapi-version-tier], [data-zkapi-version-badge]', {});
    f.modal.handleZkapiClock(NOW_MS);
    assert.equal(renders, 1, 'the pill the state wants is missing');
});

test('a refused button is said in the stage that offered it, and a success is not said twice', t => {
    const ready = emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2, viewOpen: true });
    const readyFacade = facadeFor(ready);
    readyFacade.flags = () => ({ draftDiscarded: false, discardLoop: false, withdrawalConfirmed: true });
    const f = fixture(t, { view: 'upgrade', facade: withRealHelpers(readyFacade) });
    f.modal.outcome = { tone: 'info', message: 'Close other open tabs of this app, then reload.', view: 'upgrade' };
    let html = f.modal.renderUpgrade();
    assert.match(html, /data-upgrade-stage="ready_to_switch"/);
    assert.match(html, /zkapi-outcome[^>]*>Close other open tabs of this app, then reload\./);
    assert.ok(html.indexOf('zkapi-outcome') < html.indexOf('id="zkapi-back-balance-btn"'));
    f.modal.outcome = { tone: 'success', message: 'Withdrawal confirmed. Funds sent to your saved wallet address.', view: 'upgrade' };
    html = f.modal.renderUpgrade();
    assert.doesNotMatch(html, /zkapi-outcome/);
    assert.match(html, /Withdrawal confirmed\. Your balance is back in your wallet/);
    // The review step's own withdrawal carries the line once.
    const review = holder(20, { viewOpen: true });
    zkapiClient.oaVersioning = facadeFor(review);
    zkapiClient.wallet = { has_note: true, note: aNote(20) };
    f.modal.outcome = { tone: 'error', message: 'The private balance changed.', view: 'upgrade' };
    assert.equal((f.modal.renderUpgrade().match(/The private balance changed\./g) || []).length, 1);
});

test('the ready step claims a confirmed withdrawal only when one was confirmed', () => {
    const textFor = (state, extra = {}) => textOf(renderUpgradeView({ state, stage: state.upgrade.stage, funding: 'metamask', withdrawalHtml: '', ...extra }));
    const confirmed = emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2 });
    assert.equal(confirmed.reload.reason, 'upgrade_withdrawn');
    assert.match(textFor(confirmed, { withdrawalConfirmed: true }), /Withdrawal confirmed\. Your balance is back in your wallet\. Reload to deposit into version 2/);
    // The claim is the facade's evidence, nothing else: a fact that is false,
    // or one nobody supplied, says only that deposits moved, whatever the
    // state's own reason is.
    for (const extra of [{ withdrawalConfirmed: false }, {}, { withdrawalConfirmed: 'true' }, { withdrawalConfirmed: 1 }]) {
        const text = textFor(confirmed, extra);
        assert.doesNotMatch(text, /Withdrawal confirmed|back in your wallet/, JSON.stringify(extra));
        assert.match(text, /Deposits moved to version 2\..*Reload to deposit into version 2/, JSON.stringify(extra));
    }
    // A bare review step was opened and the balance left some other way.
    const stale = emptyClosed({ intent: WITHDRAWING_INTENT, previewSelection: PREVIEW_V2 });
    assert.equal(stale.reload.reason, 'previous_withdrawal_finished', 'the state no longer says it either');
    const forfeited = textFor(stale, { withdrawalConfirmed: false });
    assert.doesNotMatch(forfeited, /Withdrawal confirmed|back in your wallet/);
    assert.match(forfeited, /Deposits moved to version 2\..*Reload to deposit into version 2/);
    // An unused quote that was cleared.
    const draft = derive({ selection: selectionFor(V1, { reason: 'runtime_holds_note', slotKind: 'unsent_prepared' }), previewSelection: PREVIEW_V2 });
    assert.equal(draft.reload.reason, 'draft_cleared');
    assert.equal(draft.upgrade.stage, 'ready_to_switch');
    const cleared = textFor(draft);
    assert.match(cleared, /Cleared an unused deposit quote\. Nothing was spent\./);
    assert.doesNotMatch(cleared, /Withdrawal confirmed/);
    // Done by the person here and said at the click: not said again.
    assert.doesNotMatch(textFor(draft, { draftClearedHere: true }), /Cleared an unused deposit quote/);
    // Another tab moved the balance: said so only when the read found one.
    const moved = emptyClosed({ previewSelection: { ...PREVIEW_V2, reason: 'runtime_holds_note', slotOwner: 'v2' } });
    assert.equal(moved.reload.reason, 'moved_in_other_tab');
    assert.match(textFor(moved, { previewReason: 'runtime_holds_note' }), /balance moved to version 2 in another tab/);
    assert.doesNotMatch(textFor(moved, { previewReason: 'no_runtime_note' }), /another tab/);
    assert.match(textFor(moved, { previewReason: 'no_runtime_note' }), /Deposits moved to version 2/);
    // A wallet that was empty and is now read as empty: deposits moved.
    const finished = emptyClosed({ previewSelection: PREVIEW_V2 });
    assert.equal(finished.reload.reason, 'previous_withdrawal_finished');
    assert.match(textFor(finished), /Deposits moved to version 2/);
    assert.doesNotMatch(textFor(finished), /Withdrawal confirmed/);
    // The closed view says the same for the same reasons.
    const closedText = renderDepositsClosedView({ state: draft, unsent: false });
    assert.match(textOf(closedText), /Cleared an unused deposit quote/);
    assert.doesNotMatch(textOf(renderDepositsClosedView({ state: draft, unsent: false, draftClearedHere: true })), /Cleared an unused deposit quote/);
});

test('a discarded plan is not offered again for the moment the state still says unsent', async t => {
    const state = derive({ snapshot: normalizedSnapshot({ hasUnsentPrepared: true, hasPendingDeposit: true }),
        selection: selectionFor(V1, { slotKind: 'unsent_prepared' }) });
    const facade = withRealHelpers(facadeFor(state));
    const f = fixture(t, { facade, config: { pending_deposit: { phase: 'prepared', amount: '5000000' } } });
    f.modal.render = () => {};
    assert.match(f.modal.renderBalance(), /data-zkapi-version-action="cancel-unsent"/);
    await f.modal.runVersionAction('cancel-unsent', { surface: 'dialog', notify: () => {}, refresh() {}, dispatch() {} });
    assert.equal(f.modal.unsentCleared, true);
    zkapiClient.config.pending_deposit = null;
    const html = f.modal.renderBalance();
    assert.doesNotMatch(html, /cancel-unsent/);
    assert.doesNotMatch(textOf(html), /never sent/);
    assert.match(textOf(html), /Unfinished deposit cleared\. Nothing was spent\./);
    // The upgrade view's blocked stage does the same.
    const blocked = holder(20, { snapshot: noteSnapshot(NOW_S + 20 * DAY, { hasUnsentPrepared: true }), viewOpen: true });
    const view = renderUpgradeView({ state: { ...blocked, unsent: true, upgrade: { ...blocked.upgrade, stage: 'blocked', blockedBy: 'unsent_deposit' } },
        stage: 'blocked', funding: 'metamask', withdrawalHtml: '', unsentCleared: true });
    assert.doesNotMatch(view, /cancel-unsent/);
    // Once the state says it is gone, a later plan is offered the button again.
    const next = fixture(t, { facade: facadeFor(emptyClosed()) });
    next.modal.unsentCleared = true;
    next.modal.render();
    assert.equal(next.modal.unsentCleared, false);
});

test('a disabled Reload points at the reason written beside it', () => {
    const busy = { ...emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2, viewOpen: true }) };
    busy.reload = { ...busy.reload, canReload: false };
    const ready = renderUpgradeView({ state: busy, stage: 'ready_to_switch', funding: 'metamask', withdrawalHtml: '' });
    const describedBy = /data-zkapi-version-action="reload" disabled aria-describedby="([^"]+)"/.exec(ready)?.[1];
    assert.ok(describedBy, 'the button names its reason');
    assert.match(ready, new RegExp(`id="${describedBy}"[^>]*data-upgrade-reload-hint>Finish the current step first`));
    const closed = renderDepositsClosedView({ state: { ...busy, gate: { canStart: false, canResume: false, code: 'stale_build', successor: null } }, unsent: false });
    const closedBy = /data-zkapi-version-action="reload" disabled aria-describedby="([^"]+)"/.exec(closed)?.[1];
    assert.ok(closedBy);
    assert.match(closed, new RegExp(`id="${closedBy}"`));
    assert.notEqual(describedBy, closedBy, 'one id per place');
    // An enabled one has no hint to point at.
    const enabled = renderUpgradeView({ state: emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2, viewOpen: true }),
        stage: 'ready_to_switch', funding: 'metamask', withdrawalHtml: '' });
    assert.doesNotMatch(enabled, /aria-describedby/);
});

test('without a delegating helper the banner’s buttons are wired by the dialog, and none is left dead', async t => {
    const facade = facadeFor(holder(20), { ui: { ...helpers().ui, attach: undefined } });
    const f = fixture(t, { note: aNote(), facade });
    const banner = buttonOverlay(['upgrade', 'dismiss'], { inBanner: true });
    f.modal.overlay = banner.overlay;
    f.modal.attachVersionActions(f.modal.versionContext());
    assert.ok(banner.buttons.every(button => typeof button.handlers.click === 'function'));
    // With the helper present, the banner is its own and is not bound twice.
    zkapiClient.oaVersioning = facadeFor(holder(20));
    zkapiClient.oaVersioning.ui.attach = () => {};
    const delegated = buttonOverlay(['upgrade'], { inBanner: true });
    f.modal.overlay = delegated.overlay;
    f.modal.attachVersionActions(f.modal.versionContext());
    assert.equal(delegated.buttons[0].handlers.click, undefined);
});

test('a dormant facade writes the saved view in today’s shape, so it survives the activation', t => {
    const { createZkapiVersioning } = createZkapiVersioningModule;
    const dormant = createZkapiVersioning({ buildTable: [V2], network: 'mainnet', now: () => NOW_MS,
        context: () => ({ table: [V2], version: V2, selection: null, adapter: getAdapter(V2.adapter) }) });
    assert.equal(dormant.multiVersion, false);
    assert.equal(dormant.active?.id, 'v2', 'the facade does know its version');
    const f = fixture(t, { facade: dormant });
    f.modal.view = 'fund';
    f.modal.isOpen = true;
    f.modal.rememberRunningModal();
    assert.deepEqual(Object.keys(JSON.parse(storage.get('oa-zkapi-running-modal'))).sort(),
        ['amount', 'currency', 'help', 'history', 'method', 'mode', 'scroll', 'setup', 'view']);
    // The welcome too.
    const welcome = Object.assign(Object.create(WelcomePanel.prototype), { app: {}, isOpen: true, overlay: { querySelector: () => null } });
    welcome.rememberRunningModal();
    const saved = JSON.parse(storage.get('oa-zkapi-welcome-modal'));
    assert.equal('versionId' in saved, false);
    assert.equal('network' in saved, false);
});

test('the funding view of a single-version page is exactly what it was', t => {
    fixture(t, {});
    setWalletMethod('address');
    t.after(() => setWalletMethod('metamask'));
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: `0x${'2'.repeat(40)}`, pending: null, migrationRequired: false };
    const html = controls.renderFundingAccount(ownerOf());
    assert.match(html, /<\/details>\n        <p data-funding-notice class="zkapi-helper" role="status">/);
});


// ---------------------------------------------------------------------------
// The same gaps against the real facade, state derivation and notice helpers
// ---------------------------------------------------------------------------

const { chooseZkapiVersion } = await import('../../chat/zkapi/versioning/versionLoader.mjs');

// One page on `active`: the real facade over the client singleton, the real
// helpers, the dialog fixture. Nothing is faked but storage and the SDK's data
// (and the clock is the machine's, as `aNote` is built on it).
const realIntent = (stage = 'withdrawn') => ({ ...WITHDRAWN_INTENT, stage, since: Date.now() - 1000 });

function realPage(t, { active = V1, selection = selectionFor(active), discardUnsent = null, ...options } = {}) {
    const f = fixture(t, options);
    const reloads = [];
    const facade = createZkapiVersioningModule.createZkapiVersioning({
        buildTable: TABLE, network: 'mainnet', now: () => Date.now(),
        context: () => ({ table: TABLE, version: active, selection, adapter: getAdapter(active.adapter) }),
        localStorage: sessionStorage, sessionStorage, reload: () => reloads.push('reload'), setTimer: () => null, clearTimer() {}
    });
    zkapiClient.oaVersioning = facade;
    facade.attach({ client: zkapiClient, runtime: { runtime: null }, ui: createVersionUi({ facade }), discardUnsent });
    t.after(() => facade.resetForTests());
    return { ...f, facade, reloads };
}

test('real facade: a withdrawal confirmed in the background is followed to Reload without leaving the steps', t => {
    const page = realPage(t, { note: aNote(20), view: 'upgrade' });
    page.modal.render();
    assert.equal(stageDrawn(page.modal.overlay.html), 'review');
    // Submitted, waiting to be confirmed. The facade hears the SDK's change
    // events, which is how it learns that a record it saw open has closed.
    Object.assign(zkapiClient, { wallet: { has_note: false, note: null },
        withdrawals: [{ recordId: 'r1', mode: 'mutual', phase: 'submitted_unconfirmed', finalBalance: 1_500_000, noteId: 7 }] });
    zkapiClient.emitChange('withdrawal');
    page.modal.render();
    assert.equal(stageDrawn(page.modal.overlay.html), 'confirming');
    // The SDK reconciles it closed, with the payout verified for the
    // upgrade's own note. Until the watcher reads the wallet the facade's
    // stage is idle; the dialog stays on the steps and says what it knows.
    zkapiClient.withdrawals = [{ recordId: 'r1', mode: 'mutual', phase: 'closed', finalBalance: 1_500_000, noteId: 7, payoutVerified: true }];
    zkapiClient.emitChange('withdrawal');
    page.modal.render();
    assert.equal(page.modal.view, 'upgrade');
    assert.equal(JSON.parse(storage.get('oa-zkapi-upgrade-v1')).stage, 'withdrawn');
    assert.match(page.modal.overlay.html, /Withdrawal confirmed\. Checking whether version 2 is ready to load/);
    // The watcher's read arrives.
    page.facade.watch.setPreview(chooseZkapiVersion({ table: TABLE, holdings: [] }));
    page.modal.render();
    assert.equal(page.modal.view, 'upgrade');
    assert.equal(stageDrawn(page.modal.overlay.html), 'ready_to_switch');
    assert.match(page.modal.overlay.html, /data-zkapi-version-action="reload"(?![^>]*disabled)/);
});

test('real facade: the clock does not rebuild a dialog whose upgrade is complete', t => {
    sessionStorage.setItem('oa-zkapi-upgrade-v1', JSON.stringify(realIntent()));
    const page = realPage(t, { active: V2, note: aNote(30), view: 'upgrade', selection: selectionFor(V2) });
    zkapiClient.config.pending_deposit = null;
    page.modal.render();
    assert.equal(stageDrawn(page.modal.overlay.html), 'done');
    let renders = 0;
    const render = page.modal.render.bind(page.modal);
    page.modal.render = () => { renders++; render(); };
    page.modal.canRefreshContent = () => true;
    // The DOM the render made, as the helper's patch reads it.
    const { overlay } = page.modal;
    const pill = { textContent: 'Version 2', dataset: { zkapiVersionTone: 'muted' }, classList: { toggle() {} } };
    overlay.selectors.set('[data-zkapi-version-closeby], [data-zkapi-version-tier], [data-zkapi-version-badge]', pill);
    overlay.selectors.set('[data-zkapi-version-badge]', pill);
    overlay.selectors.set('all:[data-zkapi-version-badge]', [pill]);
    for (let tick = 0; tick < 5; tick++) page.modal.handleZkapiClock(NOW_MS + tick * 1000);
    assert.equal(renders, 0);
});

test('real facade: a refused reload is shown, and a plan cleared here is said once', async t => {
    // Reload refused by the loop guard (two switches in the last minute).
    sessionStorage.setItem('oa-zkapi-upgrade-v1', JSON.stringify(realIntent()));
    sessionStorage.setItem('oa-zkapi-version-switch-log', JSON.stringify([{ t: Date.now() - 1000, k: 'switch' }, { t: Date.now() - 500, k: 'switch' }]));
    const page = realPage(t, { view: 'upgrade', selection: selectionFor(V1, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }) });
    page.facade.watch.setPreview(chooseZkapiVersion({ table: TABLE, holdings: [] }));
    page.modal.render();
    assert.equal(stageDrawn(page.modal.overlay.html), 'ready_to_switch');
    await page.modal.runVersionAction('reload', { surface: 'dialog', notify: text => page.modal.noticeVersionOutcome(text), refresh() {}, dispatch() {} });
    assert.deepEqual(page.reloads, []);
    page.modal.render();
    assert.match(textOf(page.modal.overlay.html), /Close other open tabs of this app, then reload\./);
});

test('real facade: cancelling an unsent plan says so once, then points at the reload', async t => {
    let discarded = 0;
    const page = realPage(t, {
        config: { pending_deposit: { phase: 'prepared', amount: '5000000', operation_id: 'op1' } },
        selection: selectionFor(V1, { reason: 'runtime_holds_note', slotKind: 'unsent_prepared' }),
        discardUnsent: async () => { discarded++; zkapiClient.config = { ...zkapiClient.config, pending_deposit: null }; return true; }
    });
    page.modal.render();
    assert.match(page.modal.overlay.html, /data-zkapi-version-action="cancel-unsent"/);
    await page.modal.runVersionAction('cancel-unsent', { surface: 'dialog', notify: text => page.modal.noticeVersionOutcome(text), refresh() {}, dispatch() {} });
    assert.equal(discarded, 1);
    page.modal.render();
    assert.doesNotMatch(page.modal.overlay.html, /cancel-unsent/, 'not offered again before the state catches up');
    assert.equal((textOf(page.modal.overlay.html).match(/Nothing was spent/g) || []).length, 1);
    // The read arrives: the reload is the step, and the cleared quote is not announced again.
    page.facade.watch.setPreview(chooseZkapiVersion({ table: TABLE, holdings: [] }));
    page.modal.render();
    const text = textOf(page.modal.overlay.html);
    assert.match(text, /Reload to deposit into version 2/);
    assert.match(page.modal.overlay.html, /data-zkapi-version-action="reload"/);
    assert.equal((text.match(/Nothing was spent/g) || []).length, 1);
});


// ---------------------------------------------------------------------------
// The words claim only what is proven, and no view is a dead end
// ---------------------------------------------------------------------------

// The SDK's change events are how the real facade learns a withdrawal record
// closed. `withdrawals` is what the client then reports.
function sdkReports(withdrawals, wallet = { has_note: false, note: null }) {
    Object.assign(zkapiClient, { wallet, withdrawals });
    zkapiClient.emitChange('withdrawal');
}

const recordOf = (phase, extra = {}) => ({ recordId: 'r1', mode: 'mutual', phase, finalBalance: 1_500_000, noteId: 7, ...extra });

async function reloadFrom(page) {
    storage.delete('oa-zkapi-version-switch-log');
    await page.modal.runVersionAction('reload', { surface: 'dialog', notify: text => page.modal.noticeVersionOutcome(text), refresh() {}, dispatch() {} });
    return storage.has(SWITCH_HINT_KEY) ? JSON.parse(storage.get(SWITCH_HINT_KEY)) : null;
}

test('real facade: a closure with no payout evidence is never told as a confirmed withdrawal, anywhere', async t => {
    const page = realPage(t, { note: aNote(20), view: 'upgrade' });
    page.modal.render();
    assert.equal(stageDrawn(page.modal.overlay.html), 'review');
    sdkReports([recordOf('submitted_unconfirmed')]);
    page.modal.render();
    assert.equal(stageDrawn(page.modal.overlay.html), 'confirming');
    // The record closes, and the SDK says its payout was not verified.
    sdkReports([recordOf('closed', { payoutVerified: false })]);
    page.modal.render();
    assert.equal(page.modal.view, 'upgrade');
    assert.equal(JSON.parse(storage.get(UPGRADE_INTENT_KEY)).stage, 'withdrawing', 'no withdrawal is recorded');
    let text = textOf(page.modal.overlay.html);
    assert.match(text, /Checking whether version 2 is ready to load/);
    assert.doesNotMatch(text, /Withdrawal confirmed|back in your wallet/);
    // The read arrives: Reload is the step, in the words true of every reload.
    page.facade.watch.setPreview(chooseZkapiVersion({ table: TABLE, holdings: [] }));
    page.modal.render();
    assert.equal(stageDrawn(page.modal.overlay.html), 'ready_to_switch');
    text = textOf(page.modal.overlay.html);
    assert.doesNotMatch(text, /Withdrawal confirmed|back in your wallet/);
    assert.match(text, /Deposits moved to version 2\..*Reload to deposit into version 2/);
    // The closed view and the welcome say the same, from the same facade.
    zkapiClient.wallet = { has_note: false, note: null };
    const balance = textOf(page.modal.renderBalance());
    assert.doesNotMatch(balance, /Withdrawal confirmed|back in your wallet/);
    const welcome = Object.create(WelcomePanel.prototype);
    Object.assign(welcome, { busy: false, fundingBusy: false, isOpen: true, step: 'welcome', escapeHtml: ownerOf().escapeHtml, overlay: overlayMock() });
    assert.doesNotMatch(textOf(welcome.renderVersionClosed()), /Withdrawal confirmed|back in your wallet/);
    // Reload sends the neutral reason: the next page is not told "withdrawn".
    const hint = await reloadFrom(page);
    assert.equal(page.reloads.length, 1);
    assert.equal(hint.reason, 'previous_withdrawal_finished');
    assert.equal(hint.view, null);
    assert.equal(JSON.parse(storage.get(UPGRADE_INTENT_KEY)).stage, 'withdrawing');
});

test('real facade: the same journey with payout evidence is told, and lands on the fund view', async t => {
    const page = realPage(t, { note: aNote(20), view: 'upgrade' });
    page.modal.render();
    sdkReports([recordOf('submitted_unconfirmed')]);
    page.modal.render();
    sdkReports([recordOf('closed', { payoutVerified: true })]);
    page.modal.render();
    assert.equal(JSON.parse(storage.get(UPGRADE_INTENT_KEY)).stage, 'withdrawn');
    page.facade.watch.setPreview(chooseZkapiVersion({ table: TABLE, holdings: [] }));
    page.modal.render();
    assert.match(textOf(page.modal.overlay.html), /Withdrawal confirmed\. Your balance is back in your wallet\. Reload to deposit into version 2/);
    zkapiClient.wallet = { has_note: false, note: null };
    assert.match(textOf(page.modal.renderBalance()), /Withdrawal confirmed\. Your balance is back in your wallet/);
    const hint = await reloadFrom(page);
    assert.equal(hint.reason, 'upgrade_withdrawn');
    assert.equal(hint.view, 'fund');
});

test('the welcome’s closed view claims a confirmed withdrawal only on the facade’s evidence', t => {
    const state = emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2 });
    assert.equal(state.reload.reason, 'upgrade_withdrawn');
    const welcomeFor = confirmed => {
        const facade = facadeFor(state, confirmed === undefined ? {} : { confirmed });
        fixture(t, { facade });
        const welcome = Object.create(WelcomePanel.prototype);
        Object.assign(welcome, { busy: false, fundingBusy: false, isOpen: true, step: 'welcome', escapeHtml: ownerOf().escapeHtml, overlay: overlayMock() });
        return textOf(welcome.renderVersionClosed());
    };
    assert.match(welcomeFor(true), /Withdrawal confirmed\. Your balance is back in your wallet\. Reload to deposit into version 2/);
    for (const confirmed of [false, undefined]) {
        const text = welcomeFor(confirmed);
        assert.doesNotMatch(text, /Withdrawal confirmed|back in your wallet/, String(confirmed));
        assert.match(text, /Deposits moved to version 2\..*Reload to deposit into version 2/, String(confirmed));
    }
    // Helpers with no facts at all (they have not loaded all of them).
    const bare = facadeFor(state, { ui: { ...helpers().ui } });
    fixture(t, { facade: bare });
    const welcome = Object.create(WelcomePanel.prototype);
    Object.assign(welcome, { busy: false, fundingBusy: false, isOpen: true, step: 'welcome', escapeHtml: ownerOf().escapeHtml, overlay: overlayMock() });
    assert.doesNotMatch(textOf(welcome.renderVersionClosed()), /Withdrawal confirmed/);
});

test('the dialog’s own switch, with no helper handler, records a withdrawal only with the facade’s evidence', async t => {
    const ready = emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2, viewOpen: true });
    const context = { surface: 'dialog', notify() {}, refresh() {}, dispatch() {} };
    for (const [confirmed, reason, view] of [[true, 'upgrade_withdrawn', 'fund'], [false, 'previous_withdrawal_finished', null], [undefined, 'previous_withdrawal_finished', null]]) {
        const facade = facadeFor(ready, confirmed === undefined ? {} : { confirmed });
        const f = fixture(t, { view: 'upgrade', facade });
        await f.modal.runVersionAction('reload', context);
        assert.deepEqual(facade.calls.at(-1), ['switch', { reason, view }], String(confirmed));
    }
});

test('a page that must reload leaves the upgrade steps for the balance, which carries the Reload', t => {
    const movedPreview = { ...PREVIEW_V2, reason: 'runtime_holds_note', slotOwner: 'v2', slotKind: 'note' };
    const moved = holder(20, { viewOpen: true, previewSelection: movedPreview });
    assert.equal(moved.reload.required, true);
    assert.equal(moved.reload.reason, 'moved_in_other_tab');
    assert.equal(moved.upgrade.stage, 'review', 'the stage alone offers a withdraw form for a balance that moved');
    const f = fixture(t, { note: aNote(20), view: 'upgrade', facade: withRealHelpers(facadeFor(moved)) });
    assert.equal(f.modal.upgradeViewTarget(f.modal.versionContext()), 'balance');
    f.modal.render();
    assert.equal(f.modal.view, 'balance');
    const html = f.modal.overlay.html;
    assert.doesNotMatch(html, /data-zkapi-upgrade-view|id="zkapi-withdraw-btn"/);
    assert.match(html, /data-zkapi-version-notice="reload"/);
    assert.match(html, /data-zkapi-version-action="reload"/);
    assert.match(textOf(html), /balance moved to version 2 in another tab/);
    // The ready step IS the reload: it keeps its view.
    const ready = emptyClosed({ intent: WITHDRAWN_INTENT, previewSelection: PREVIEW_V2, viewOpen: true });
    assert.equal(ready.upgrade.stage, 'ready_to_switch');
    zkapiClient.oaVersioning = withRealHelpers(facadeFor(ready));
    f.modal.view = 'upgrade';
    assert.equal(f.modal.upgradeViewTarget(f.modal.versionContext()), 'upgrade');
    // A review with nothing to reload still shows the steps.
    zkapiClient.oaVersioning = withRealHelpers(facadeFor(holder(20, { viewOpen: true })));
    assert.equal(f.modal.upgradeViewTarget(f.modal.versionContext()), 'upgrade');
});

// Version 2 has itself stopped taking deposits (version 3 does), and version 1
// still has a withdrawal to finish: the gate's code is deposits_closed, and the
// unfinished withdrawal is still what the person has to do.
function threeVersionState(overrides = {}, { canOpen = true } = {}) {
    const v2 = { ...V2, status: 'exit-only' };
    const v3 = { ...V2, id: 'v3', label: 'Version 3', ordinal: 3, status: 'active', deploymentId: `${V2.deploymentId}-3` };
    const table = [V1, v2, v3];
    const state = derive({
        table, active: v2, target: v3,
        selection: selectionFor(v2, { reason: canOpen ? 'no_runtime_note' : 'runtime_holds_note',
            slotOwner: canOpen ? null : 'v2', slotKind: canOpen ? 'empty' : 'note',
            open: { v1: [{ recordId: 'w1', mode: 'mutual', phase: 'parked', noteId: 7, expiryTs: NOW_S + 5 * DAY }] } }),
        snapshot: canOpen ? normalizedSnapshot() : noteSnapshot(NOW_S + 20 * DAY),
        adapter: getAdapter(v2.adapter), ...overrides
    });
    return { state, table, v2, v3 };
}

test('an exit-only version with another version’s unfinished withdrawal offers to open it, in words that say so', () => {
    const { state, table } = threeVersionState();
    assert.equal(state.gate.code, 'deposits_closed', 'the gate names the closed deposits, not the withdrawal');
    assert.equal(state.phase, 'finish-previous-withdrawal');
    assert.equal(state.previous.versionId, 'v1');
    assert.equal(state.previous.canOpen, true);
    const html = renderDepositsClosedView({ state, unsent: false, table });
    const text = textOf(html);
    assert.match(text, /Deposits moved to version 3\./);
    assert.match(text, /A withdrawal from version 1 is still finishing\. Open version 1 to finish it, then come back to deposit\./);
    assert.match(html, /data-zkapi-version-action="open-previous"[^>]*>Open version 1</);
    assert.match(html, /data-zkapi-closed-previous/);
    // The loaded version is never the one offered.
    assert.doesNotMatch(text, /Open version 2/);
    // While this page's own balance holds the slot, the way there is said, not offered.
    const held = threeVersionState({}, { canOpen: false });
    assert.equal(held.state.previous.canOpen, false);
    const heldHtml = renderDepositsClosedView({ state: held.state, unsent: false, table: held.table });
    assert.doesNotMatch(heldHtml, /open-previous/);
    assert.match(textOf(heldHtml), /To finish it, withdraw your current balance first, then open version 1\./);
    // An unsent plan replaces the gate's text: the withdrawal is still said once.
    const unsentGated = { ...state, gate: { ...state.gate, code: 'previous_withdrawal_open' }, unsent: true };
    const unsentHtml = renderDepositsClosedView({ state: unsentGated, unsent: true, table });
    assert.equal((unsentHtml.match(/A withdrawal from version 1 is still finishing/g) || []).length, 1);
    assert.match(unsentHtml, /data-zkapi-closed-previous/);
    // The gate that does name it keeps its one sentence and its button.
    const gated = { ...state, gate: { ...state.gate, code: 'previous_withdrawal_open' } };
    const gatedHtml = renderDepositsClosedView({ state: gated, unsent: false, table });
    assert.equal((gatedHtml.match(/A withdrawal from version 1 is still finishing/g) || []).length, 1);
    assert.match(gatedHtml, /open-previous/);
    assert.match(gatedHtml, /data-zkapi-closed-previous/);
});

test('the dialog suppresses its previous banner only when its closed view says that withdrawal', t => {
    const { state } = threeVersionState();
    const facade = withRealHelpers(facadeFor(state, { active: { ...V2, status: 'exit-only' }, target: undefined }));
    facade.table = threeVersionState().table;
    const f = fixture(t, { facade });
    let html = f.modal.renderBalance();
    // The closed view offers it: said once, and the banner stays out.
    assert.equal((html.match(/data-zkapi-version-action="open-previous"/g) || []).length, 1);
    assert.equal(hooks(html).banner, false);
    // A closed view that does not say it (a stand-in here) leaves the notice
    // to the banner: the person is never left with neither.
    const plain = '<section class="zkapi-section" data-zkapi-deposits-closed><p>Plain.</p></section>';
    facade.ui = { ...facade.ui, depositsClosedView: () => plain };
    html = f.modal.renderBalance();
    assert.match(html, /data-zkapi-version-notice="previous"/);
    assert.match(html, /data-zkapi-version-action="open-previous"/);
    // No helper view at all: the plain line, and the banner is the explanation.
    facade.ui = { ...facade.ui, depositsClosedView: () => '' };
    html = f.modal.renderBalance();
    assert.match(html, /data-zkapi-version-notice="previous"/);
    assert.match(html, /Reload to continue/);
});

test('the upgrade’s blocked stage offers the previous version too', () => {
    const { state, table } = threeVersionState();
    assert.equal(state.upgrade.stage, 'blocked');
    const html = renderUpgradeView({ state, stage: 'blocked', funding: 'metamask', withdrawalHtml: '', table });
    assert.match(textOf(html), /A withdrawal from version 1 is still finishing\. Open version 1 to finish it/);
    assert.match(html, /data-zkapi-version-action="open-previous"/);
    // Nothing is held here, so there is no withdrawal of this page's to embed;
    // with a balance held it is the way out, and stays.
    assert.doesNotMatch(renderUpgradeView({ state, stage: 'blocked', funding: 'metamask', withdrawalHtml: '<div data-embedded></div>', table }), /data-embedded/);
    const holding = threeVersionState({}, { canOpen: false }).state;
    assert.notEqual(holding.holding, 'none');
    assert.match(renderUpgradeView({ state: holding, stage: 'blocked', funding: 'metamask', withdrawalHtml: '<div data-embedded></div>', table }), /data-embedded/);
    // An own withdrawal in motion keeps its own words and offers nothing to open.
    const own = { ...state, upgrade: { ...state.upgrade, blockedBy: 'open_withdrawal' } };
    const ownHtml = renderUpgradeView({ state: own, stage: 'blocked', funding: 'metamask', withdrawalHtml: '', table });
    assert.doesNotMatch(ownHtml, /open-previous/);
    assert.match(textOf(ownHtml), /Finish the withdrawal that is already in progress first/);
});

test('an open welcome is not redrawn under an amount being typed or a password', t => {
    const facade = facadeFor(emptyClosed());
    fixture(t, { facade });
    const original = zkapiClient.subscribe;
    t.after(() => { zkapiClient.subscribe = original; });
    zkapiClient.subscribe = () => () => {};
    const welcome = new WelcomePanel({});
    let renders = 0;
    welcome.render = () => { renders++; };
    const [listener] = [...facade.listeners];
    welcome.isOpen = true;
    welcome.step = 'welcome';
    const focus = element => { globalThis.document.activeElement = element; };
    t.after(() => focus(null));
    const matching = selector => ({ id: 'funding-usd', matches: candidate => candidate === selector });
    // Typing: the welcome's own amount, the shared funding amount, a password.
    for (const element of [{ id: 'welcome-deposit-amount' }, { id: 'funding-usd' }, { id: 'funding-eth' },
        matching('[data-funding-amount]'), { type: 'password' }]) {
        focus(element);
        listener();
    }
    assert.equal(renders, 0, 'no render under the caret');
    // Anything else (a button, nothing focused) is a render, as before.
    focus({ id: 'welcome-fund-btn', matches: () => false });
    listener();
    focus(null);
    listener();
    assert.equal(renders, 2);
    // A step in progress is still never rendered over.
    welcome.step = 'redeeming';
    listener();
    assert.equal(renders, 2);
});

test('the deposit step’s notice can be dismissed for good, on the panel, the dialog and the fallback', async t => {
    const { resetVersionNoticeDismissals } = await import('../../chat/zkapi/components/VersionNotices.js');
    resetVersionNoticeDismissals();
    t.after(resetVersionNoticeDismissals);
    const intent = { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawn', since: NOW_MS - 1000 };
    const deposit = derive({ active: V2, selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }), intent });
    assert.equal(deposit.upgrade.stage, 'deposit');
    const facade = withRealHelpers(facadeFor(deposit, { selection: selectionFor(V2), active: V2 }));
    const f = fixture(t, { facade });
    f.modal.render = () => {};
    // On the fund view the notice carries both buttons.
    const html = f.modal.renderBalance();
    assert.match(html, /data-zkapi-version-notice="deposit"/);
    assert.match(html, /data-zkapi-version-action="upgrade">Continue upgrade</);
    assert.match(html, /data-zkapi-version-action="dismiss">Dismiss</);
    // The click: the upgrade is forgotten, and the notice goes with it.
    const context = { surface: 'dialog', notify() {}, refresh() {}, dispatch() {} };
    await f.modal.runVersionAction('dismiss', { ...context, noticeId: 'deposit' });
    assert.deepEqual(facade.calls.filter(call => call === 'abandon'), ['abandon']);
    assert.doesNotMatch(f.modal.renderBalance(), /data-zkapi-version-notice="deposit"/);
    // The "done" notice is only this page's: nothing is forgotten for it.
    await f.modal.runVersionAction('dismiss', { ...context, noticeId: 'done' });
    assert.equal(facade.calls.filter(call => call === 'abandon').length, 1);

    // A dialog whose helpers have no handler of their own: the same two things.
    const dismissed = [];
    const bare = facadeFor(deposit, { selection: selectionFor(V2), active: V2,
        ui: { ...helpers().ui, dismiss: id => dismissed.push(id) } });
    zkapiClient.oaVersioning = bare;
    await f.modal.runVersionAction('dismiss', { ...context, noticeId: 'deposit' });
    assert.deepEqual(bare.calls.filter(call => call === 'abandon'), ['abandon']);
    assert.deepEqual(dismissed, ['deposit']);
    // The reminder dismissal keeps working with no notice id.
    const soon = facadeFor(holder(6), { ui: { ...helpers().ui, dismiss: id => dismissed.push(id) } });
    zkapiClient.oaVersioning = soon;
    await f.modal.runVersionAction('dismiss', context);
    assert.deepEqual(soon.calls.filter(call => Array.isArray(call)), [['ack', 3]]);
    assert.equal(soon.calls.includes('abandon'), false);
    assert.deepEqual(dismissed, ['deposit'], 'no id, nothing to dismiss');
});

test('operator notices that relaxed the gate are told on the dialog, escaped and bounded', t => {
    const text = `Escape 7 waits on <img src=x onerror=alert(1)> & "quotes" ${'long '.repeat(80)}`;
    const table = resolvedTable(mutated(activatedRegistry(), registry => {
        registry.versions[0].networks.mainnet.notices = [stuckEscapeNotice({ noteId: 7, text: text.slice(0, 280), expiresAt: '2027-01-01T00:00:00Z' })];
    }), 'mainnet');
    const target = table.find(version => version.status === 'active');
    const state = derive({
        table, active: target, target,
        selection: selectionFor(target, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty',
            open: { v1: [{ recordId: 'r1', noteId: 7, mode: 'escape', phase: 'pending', expiryTs: null }] } }),
        snapshot: normalizedSnapshot(), adapter: getAdapter(target.adapter)
    });
    assert.equal(state.gate.canStart, true, 'the notice relaxed the gate');
    assert.equal(state.notices.length, 1);
    const facade = withRealHelpers(facadeFor(state, { selection: selectionFor(target), active: target, target }));
    facade.table = table;
    const f = fixture(t, { facade });
    const html = f.modal.renderBalance();
    assert.match(html, /data-zkapi-version-notice="operator-0"/);
    assert.doesNotMatch(html, /<img /, 'markup in operator text is text');
    assert.match(html, /Escape 7 waits on &lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quotes&quot;/);
    const shown = /data-zkapi-version-notice="operator-0"[^>]*><p [^>]*>([^<]*)</.exec(html)[1];
    assert.ok(shown.length <= 280 + 40, 'bounded (escapes may lengthen the markup, not the text)');
    // The same banner stays after the closed-view rules (nothing says it).
    assert.equal(hooks(html).banner, true);
});

// -- The funding flow reopens when the gate does ----------------------------

function addressPage(t, state, overrides = {}) {
    const facade = facadeFor(state, { selection: selectionFor(V2), active: V2, ...overrides });
    fixture(t, { facade });
    setWalletMethod('address');
    t.after(() => setWalletMethod('metamask'));
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: `0x${'2'.repeat(40)}`, pending: null, migrationRequired: false };
    t.mock.method(addressFundingWallet, 'getStatus', async () => ({ ethBalance: '0' }));
    return facade;
}

const openTarget = () => derive({ active: V2, selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }) });

test('a funding flow the gate closed starts again when a render finds the gate open', async t => {
    addressPage(t, openTarget());
    const reopened = [];
    const closedFlow = { closed: { code: 'deposits_closed' }, running: false, stop() {}, reopenIfAllowed: async () => { reopened.push('reopen'); return true; } };
    const owner = ownerOf({ view: 'fund', fundingFlow: closedFlow });
    controls.attachWalletMethodControls(owner);
    await tick();
    assert.deepEqual(reopened, ['reopen']);
    assert.equal(owner.fundingFlow, closedFlow, 'the flow is reopened, not replaced');
    // A flow that is not closed is left alone, and so is one that cannot reopen.
    closedFlow.closed = null;
    controls.attachWalletMethodControls(owner);
    await tick();
    assert.deepEqual(reopened, ['reopen']);
    const without = ownerOf({ view: 'fund', fundingFlow: { closed: { code: 'deposits_closed' }, stop() {} } });
    controls.attachWalletMethodControls(without);
    await tick();
    assert.ok(without.fundingFlow, 'nothing throws, nothing is dropped');
    // A failure to reopen is the flow's own to show; the render path never throws.
    const failing = ownerOf({ view: 'fund', fundingFlow: { closed: { code: 'deposits_closed' }, stop() {}, reopenIfAllowed: async () => { throw new Error('x'); } } });
    controls.attachWalletMethodControls(failing);
    await tick();
    assert.ok(failing.fundingFlow);
});

test('the real flow reopens only on an explicit allow, and a closed gate still drops it', async t => {
    const gate = { canStart: false, canResume: false, code: 'deposits_closed', successor: null };
    const facade = addressPage(t, openTarget());
    facade.depositGate = () => gate;
    const flow = new AddressDepositFlow({ wallet: addressFundingWallet, client: zkapiClient, store: {}, depositGate: () => facade.depositGate() });
    flow.requestedAmount = { value: '7', currency: 'usd' };
    const starts = [];
    flow.start = async (...args) => { starts.push(args); flow.closed = null; };
    flow.close({ gateCode: 'deposits_closed' });
    assert.ok(flow.closed);
    const owner = ownerOf({ view: 'fund', fundingFlow: flow });
    // The gate is closed: the page's own check drops the flow, nothing starts.
    controls.attachWalletMethodControls(owner);
    await tick();
    assert.deepEqual(starts, []);
    assert.equal(owner.fundingFlow ?? null, null);
    // A render the gate's reopening reaches before anything dropped the flow:
    // it starts again with the amount it last asked for.
    const held = ownerOf({ view: 'fund', fundingFlow: flow });
    flow.close({ gateCode: 'deposits_closed' });
    facade.depositGate = () => ({ canStart: true, canResume: false, code: null, successor: null });
    controls.attachWalletMethodControls(held);
    await tick();
    assert.deepEqual(starts, [['7', 'usd']]);
    assert.equal(held.fundingFlow, flow);
    assert.equal(flow.closed, null);
});

test('a saved transaction of another version that the network settled is said, by how it ended', async t => {
    const { calls, rescue } = rescueFixture(t);
    const cases = {
        confirmed: /The saved transaction from the other version finished\. This address can now return its ETH\./,
        reverted: /was reverted by the network\. No funds were transferred; the network fee may still have been charged\. This address can now return its ETH\./,
        replaced: /was replaced and will not be sent\. This address can now return its ETH\./
    };
    for (const [finalState, pattern] of Object.entries(cases)) {
        rescue.recoverRetiredScope = async options => { calls.push(['recover', options.scope]); return { transactionHash: `0x${'a'.repeat(64)}`, status: 'released', kind: 'deposit', finalState }; };
        const owner = ownerOf({ view: 'fund', retiredScopes: [{ versionId: 'v1', scope: `1:${V1.vault}:native-eth`, address: `0x${'5'.repeat(40)}`, pending: true, lastReturn: null }] });
        const buttons = clickable(owner, [['[data-funding-retired-recover]', { fundingRetiredRecover: 'v1' }]]);
        t.mock.method(addressFundingWallet, 'reload', async () => {});
        t.mock.method(addressFundingWallet, 'init', async () => {});
        controls.attachWalletMethodControls(owner);
        await buttons['[data-funding-retired-recover]'].handlers.click();
        assert.match(owner.fundingNotice, pattern, finalState);
        assert.doesNotMatch(owner.fundingNotice, /Waiting for final network confirmation|Saved transaction checked/);
        assert.equal(owner.retiredScopes, undefined, 'the list is read again');
    }
});

test('the welcome of a page with one active version shows the SDK’s message untouched', async t => {
    // Today's app: the facade is attached (dormant) and carries no helpers, and
    // the lone row is `active`. Whatever the SDK last said is shown as it said it.
    const single = resolvedTable(validRegistry(), 'mainnet');
    const dormant = { multiVersion: false, state: () => null, depositGate: () => ({ canStart: true, canResume: false, code: null, successor: null }),
        ui: null, table: [], target: null, active: single[0], selection: null, subscribe: () => () => {}, registerBusy: () => () => {} };
    fixture(t, { facade: dormant });
    const { installActiveVersion, resetActiveVersionForTests } = await import('../../chat/zkapi/versioning/activeVersion.mjs');
    installActiveVersion({ table: single, version: single[0], selection: { ...selectionFor(single[0]), reason: 'single_version', slotOwner: null, slotKind: 'empty' } });
    t.after(() => resetActiveVersionForTests());
    const welcome = Object.assign(Object.create(WelcomePanel.prototype), { escapeHtml: ownerOf().escapeHtml });
    const deployment = 'zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930';
    const messages = [
        `This browser contains a wallet for ${deployment}. Switch back to that deployment to continue.`,
        'The zkAPI indexer is still catching up with the latest vault root. Try again in a few seconds.',
        'This deployment no longer accepts new deposits.',
        'Gone'
    ];
    for (const message of messages) {
        zkapiClient.lastError = Object.assign(new Error(message), { shortMessage: 'a shorter message', code: 'deposits_closed' });
        const html = welcome.renderWelcome();
        // The raw message, escaped, exactly as the welcome always showed it: not the
        // short one, not the indexer wording, not a rewrite.
        assert.ok(html.includes(`Payment service: ${welcome.escapeHtml(message)}</p>`), message);
        assert.doesNotMatch(html, /Nothing was lost|moved to version|Version 1 no longer|a shorter message/);
    }
    // Helpers that do not know the refusal change nothing either.
    zkapiClient.oaVersioning = { ...dormant, ui: { refusalMessage: () => null } };
    zkapiClient.lastError = new Error('The payment service is unreachable.');
    assert.match(welcome.renderWelcome(), /Payment service: The payment service is unreachable\./);
    zkapiClient.lastError = null;
    assert.doesNotMatch(welcome.renderWelcome(), /Payment service:/);
});

test('the welcome rewrites an SDK wallet refusal that names a deployment id', async t => {
    const deploymentId = 'zkapi-native-eth-sepolia-hostile-wallet-id-0001';
    const raw = `This browser contains a wallet for ${deploymentId}. Switch back to that deployment to continue.`;
    fixture(t, { facade: facadeFor(emptyClosed()) });
    // Boot installs the active version and its selection before any UI exists;
    // the refusal copy reads that context (modules are shared across tests).
    const { installActiveVersion, resetActiveVersionForTests } = await import('../../chat/zkapi/versioning/activeVersion.mjs');
    const selection = selectionFor(V1, { reason: 'unknown_deployment', slotOwner: null, slotKind: 'other' });
    installActiveVersion({ table: TABLE, version: V1, selection });
    t.after(() => resetActiveVersionForTests());
    const welcome = Object.assign(Object.create(WelcomePanel.prototype), { escapeHtml: ownerOf().escapeHtml });
    // A lastError that is not a version refusal keeps its own message...
    zkapiClient.lastError = Object.assign(new Error('The payment service is unreachable.'), { code: 'network_error' });
    assert.match(welcome.renderWelcome(), /Payment service: The payment service is unreachable\./);
    // ...and the foreign-wallet refusal never echoes the raw deployment id.
    zkapiClient.lastError = Object.assign(new Error(raw), { code: 'wallet_deployment_mismatch' });
    const html = welcome.renderWelcome();
    assert.doesNotMatch(html, new RegExp(deploymentId));
    assert.doesNotMatch(html, /This browser contains a wallet for/);
    assert.match(html, /Payment service: /);
});

test('a stale page is told to reload, not that its version stopped taking deposits', async t => {
    // reload_required closes the gate for a tab another tab moved on from; the
    // version itself still accepts deposits, so the refusal must not claim otherwise.
    const gate = { canStart: false, canResume: false, code: 'reload_required', successor: null };
    const f = fixture(t, { facade: facadeFor(emptyClosed(), { gate }) });
    const quotes = spyOnQuotes(t);
    f.modal.render = () => {};
    Object.assign(f.modal, { overlay: overlayMock() });
    await f.modal.startDeposit('5');
    assert.match(f.modal.outcome.message, /This page is out of date\. Reload to continue\./);
    assert.doesNotMatch(f.modal.outcome.message, /no longer accepts/);
    const welcome = Object.assign(Object.create(WelcomePanel.prototype), {
        busy: false, fundingBusy: false, isOpen: true, step: 'welcome', escapeHtml: ownerOf().escapeHtml,
        app: { accountModal: { openFunding() {}, open() {} } }, overlay: overlayMock(), render() {}
    });
    await welcome.fund();
    assert.match(welcome.error, /This page is out of date\. Reload to continue\./);
    await assert.rejects(controls.prepareDepositAmount(ownerOf()), /This page is out of date/);
    assert.deepEqual(quotes, []);
});

// ---------------------------------------------------------------------------
// Protocol revision 3 in the dialog
// ---------------------------------------------------------------------------
//
// What the dialog mounts from the version helpers (the exit kit row and the
// give-up link under the balance, the fine print and the choice about a
// settling chat in Withdraw, a row's payout and device words in Payment
// history), what it asks the facade and the SDK for, in which order, and what
// it refuses to act on. The facade, the helpers, the adapters and the state
// derivation are the real ones, over the real client singleton whose fields
// are one scenario the revision 3 SDK recorded (test/fixtures/zkapi-v2-real-shapes).

const SHAPES = JSON.parse(fs.readFileSync(new URL('../fixtures/zkapi-v2-real-shapes/snapshots.json', import.meta.url), 'utf8'));
const SHAPES_NOW = SHAPES.generatedAtMs;
// The machine's clock, kept so a test that builds two pages (each pinning the
// clock) or moves it itself always leaves the real one behind.
const REAL_DATE_NOW = Date.now;
const { default: walletRuntime } = await import('@openanonymity/zkapi-browser-sdk/runtime');

// The clock is the fixture's own, so no committed instant is read against the
// machine's. `useSingleton` is the page's own facade (what an error is told to
// when the dialog explains it), installed as the version this page loaded.
function shapesPage(t, scenario, { view = 'balance', active = V2, withdrawals, deposits, noHelpers = false, helpers = null,
    useSingleton = false } = {}) {
    const real = structuredClone(SHAPES.scenarios[scenario]);
    Date.now = () => SHAPES_NOW;
    t.after(() => { Date.now = REAL_DATE_NOW; });
    const snapshot = real.clientSnapshot;
    const f = fixture(t, { note: snapshot.wallet?.note || null, config: snapshot.config, view,
        withdrawals: withdrawals ?? snapshot.withdrawals, deposits: deposits ?? snapshot.deposits });
    let facade;
    if (useSingleton) {
        installActiveVersion({ table: TABLE, version: active, selection: selectionFor(active) });
        t.after(() => resetActiveVersionForTests());
        facade = createZkapiVersioningModule.zkapiVersioning;
    } else {
        facade = createZkapiVersioningModule.createZkapiVersioning({
            buildTable: TABLE, network: 'mainnet', now: () => Date.now(),
            context: () => ({ table: TABLE, version: active, selection: selectionFor(active), adapter: getAdapter(active.adapter) }),
            localStorage: sessionStorage, sessionStorage, reload() {}, setTimer: () => null, clearTimer() {}
        });
    }
    zkapiClient.oaVersioning = facade;
    facade.attach({ client: zkapiClient, runtime: { runtime: real.runtime },
        ui: noHelpers ? null : (helpers || createVersionUi({ facade })) });
    t.after(() => facade.resetForTests());
    return { ...f, facade, snapshot, real };
}

const bodyOf = html => {
    const root = createMiniDocument().createElement('div');
    root.innerHTML = html;
    return root;
};

// -- The balance card ---------------------------------------------------------

test('the exit kit row sits under the card and the banner, and its button is the helpers’ own', async t => {
    zkapiClient.exportExitKit = async () => '{"kit":true}';
    t.after(() => { delete zkapiClient.exportExitKit; });
    const page = shapesPage(t, 'kit_never_exported');
    const html = page.modal.renderBalance();
    const positions = ['zkapi-balance-foot', 'data-zkapi-version-banner="dialog"', 'data-zkapi-balance-extras',
        'data-private-balance-expired-notice'].map(marker => html.indexOf(marker));
    assert.ok(positions.every(position => position >= 0), `all four are drawn: ${positions}`);
    assert.deepEqual([...positions].sort((left, right) => left - right), positions, 'card, banner, extras, expiry notice');
    assert.match(html, /data-zkapi-kit-row data-kit-state="never"/);
    // Wired by the dialog's own delegation (outside the banner), once.
    const root = bodyOf(html);
    const row = root.querySelector('[data-zkapi-balance-extras] [data-zkapi-version-action="export-exit-kit"]');
    assert.ok(row);
    assert.equal(row.closest('[data-zkapi-version-banner]'), null, 'outside the banner');
    // A click is one call of the helper's action, which opens the dialog of the
    // exit kit with the facade's export.
    const opened = [];
    const dialogs = [];
    const result = await page.modal.runVersionAction('export-exit-kit', {
        surface: 'dialog', notify() {}, refresh() {}, dispatch() {},
        openExitKit: options => { dialogs.push(options); opened.push('opened'); return { result: Promise.resolve({ saved: true }) }; }
    });
    assert.deepEqual(opened, ['opened']);
    assert.equal(typeof dialogs[0].exportKit, 'function');
    assert.equal(await dialogs[0].exportKit('ABCDE-ABCDE-ABCDE-ABCDE'), '{"kit":true}');
    assert.equal(result, undefined, 'the dialog does not need an answer');
});

test('a balance that has been claimed, or a page with no helpers, has no exit kit row', t => {
    zkapiClient.exportExitKit = async () => '{}';
    t.after(() => { delete zkapiClient.exportExitKit; });
    const claimed = shapesPage(t, 'kit_never_exported', { deposits: [{ recordId: 'd', deploymentId: 'x', noteId: 7,
        status: 'confirmed', amount: 5_000_000, expiryTs: 1, expiryClaim: { amount: 5_000_000, claimedAt: 1_100_000,
            transactionHash: `0x${'ab'.repeat(32)}`, blockNumber: 12, blockHash: `0x${'ef'.repeat(32)}` } }] });
    assert.ok(zkapiClient.noteExpiryClaim, 'the SDK reads the balance as claimed');
    const claimedHtml = claimed.modal.renderBalance();
    assert.match(claimedHtml, /Claimed after expiry/);
    assert.doesNotMatch(claimedHtml, /data-zkapi-balance-extras|data-zkapi-kit-row/);
    // The helpers have not loaded: the balance is the one a page without
    // versions draws, with nothing the helpers would have written.
    const early = shapesPage(t, 'kit_never_exported', { noHelpers: true });
    const html = early.modal.renderBalance();
    assert.doesNotMatch(html, /data-zkapi-balance-extras|data-zkapi-version-banner|data-zkapi-kit-row/);
    delete zkapiClient.oaVersioning;
    assert.equal(early.modal.renderBalance(), html);
});

test('a balance that can be given up says so in the card and the banner, and giving up is asked of the facade', async t => {
    const state = derive({
        snapshot: noteSnapshot(NOW_S + 20 * DAY), abandon: { available: true, kind: 'dust', blockedBy: null }
    });
    assert.equal(state.abandon?.available, true, 'the state offers it');
    const calls = [];
    const facade = withRealHelpers(facadeFor(state));
    Object.assign(facade, {
        abandonPreview: () => ({ kind: 'dust', noteId: 7, balanceUnits: '300000', limitUnits: '333334', balanceUsdMicros: 900_000,
            limitUsdMicros: 1_000_000, expiryMs: NOW_MS + 20 * DAY * 1000, currentLabel: 'Version 1', targetLabel: 'Version 2' }),
        giveUpBalance: async args => { calls.push(['giveUp', args]); return { done: true, kind: 'dust' }; }
    });
    const f = fixture(t, { note: aNote(20), facade });
    const html = f.modal.renderBalance();
    assert.match(html, /data-zkapi-abandon-row/);
    assert.match(html, /data-zkapi-version-notice="abandon"/);
    assert.equal((html.match(/data-zkapi-version-action="abandon-open"/g) || []).length, 2, 'the notice and the link');
    // The link opens the helpers' dialog with the facade's preview, and its
    // confirmation is the facade's give-up with what the preview named.
    const dialogs = [];
    await f.modal.runVersionAction('abandon-open', {
        surface: 'dialog', notify() {}, refresh() {}, dispatch() {},
        openAbandon: options => { dialogs.push(options); return { result: Promise.resolve({ done: false, why: 'cancelled' }) }; }
    });
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].preview.noteId, 7);
    await dialogs[0].giveUp({ noteId: dialogs[0].preview.noteId, balanceUnits: dialogs[0].preview.balanceUnits });
    assert.deepEqual(calls, [['giveUp', { noteId: 7, balanceUnits: '300000' }]]);
    // While the dialog is working the buttons are disabled.
    f.modal.busy = true;
    assert.match(f.modal.renderBalance(), /data-zkapi-version-action="abandon-open" disabled/);
});

// -- Withdraw -----------------------------------------------------------------

const RADIOS = 'input[name="zkapi-withdraw-concede"]';
const concedeValues = root => root.querySelectorAll(RADIOS).map(input => input.value);
const concedeChecked = root => root.querySelectorAll(RADIOS).find(input => input.checked)?.value ?? null;

test('while a chat settles, Withdraw says the most it could cost and offers the choice, waiting first', t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    assert.equal(page.facade.state(SHAPES_NOW).exit.boundAtState, '1000000');
    const html = page.modal.renderWithdrawal();
    const root = bodyOf(html);
    const fine = root.querySelector('[data-zkapi-exit-bound]');
    assert.equal(fine.dataset.bound, '1000000');
    assert.equal(root.querySelector('[data-zkapi-exit-choice]').dataset.zkapiExitMode, 'mutual');
    assert.deepEqual(concedeValues(root), ['wait', 'zero', 'bound']);
    assert.equal(concedeChecked(root), 'wait', 'never preselects giving something up');
    // It sits between the method and the confirmation.
    assert.ok(html.indexOf('name="zkapi-withdraw-mode"') < html.indexOf('data-zkapi-exit-choice'));
    assert.ok(html.indexOf('data-zkapi-exit-choice') < html.indexOf('id="zkapi-withdraw-confirm"'));
    // Not a way to give up silently: the figure is said with its ether beside it.
    assert.match(textOf(html), /0\.001 ETH/);
    // The upgrade's embedded withdrawal says the same.
    assert.match(page.modal.renderWithdrawal({ upgrade: true }), /data-zkapi-exit-choice/);
    // An emergency exit never waits, so it has no such choice and starts on
    // the one that gives up nothing now.
    page.modal.withdrawMode = 'escape';
    const escape = bodyOf(page.modal.renderWithdrawal());
    assert.equal(escape.querySelector('[data-zkapi-exit-choice]').dataset.zkapiExitMode, 'escape');
    assert.deepEqual(concedeValues(escape), ['zero', 'bound']);
    assert.equal(concedeChecked(escape), 'zero');
});

test('with nothing settling there is no fine print, and a page without helpers draws Withdraw as it did', t => {
    const quiet = shapesPage(t, 'kit_never_exported', { view: 'withdraw' });
    const html = quiet.modal.renderWithdrawal();
    assert.doesNotMatch(html, /data-zkapi-exit-choice|zkapi-withdraw-concede/);
    delete zkapiClient.oaVersioning;
    assert.equal(quiet.modal.renderWithdrawal(), html);
    // The same wait with no helpers loaded: nothing of theirs.
    const early = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw', noHelpers: true });
    assert.doesNotMatch(early.modal.renderWithdrawal(), /data-zkapi-exit-choice|zkapi-withdraw-concede/);
});

test('a withdrawal already prepared shows the fine print and no choice: its method is fixed', t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    zkapiClient.config = { ...zkapiClient.config, prepared_withdrawal: { mode: 'mutual', phase: 'prepared',
        note_id: 7, destination: `0x${'a'.repeat(40)}`, transaction_hash: null, clearance_reserved: true } };
    const root = bodyOf(page.modal.renderWithdrawal());
    assert.equal(root.querySelector('[data-zkapi-exit-bound]').dataset.bound, '1000000');
    assert.equal(root.querySelector('[data-zkapi-exit-fieldset]'), null);
    assert.deepEqual(concedeValues(root), []);
    // Once its transaction is submitted nothing is signed again, so there is
    // nothing to disclose either.
    zkapiClient.config = { ...zkapiClient.config, prepared_withdrawal: { ...zkapiClient.config.prepared_withdrawal,
        phase: 'submitted', transaction_hash: `0x${'ab'.repeat(32)}` } };
    assert.doesNotMatch(page.modal.renderWithdrawal(), /data-zkapi-exit-choice/);
});

// The withdrawal the dialog starts, against the real service modules with only
// the network and the wallet stood in for. `prepared` is a withdrawal plan
// the SDK saved earlier (an unsubmitted mutual close in the browser's slot).
function startable(t, page, { prepared = false } = {}) {
    const events = [];
    const destination = `0x${'b'.repeat(40)}`;
    const previous = { browserMode: zkapiClient.browserMode, manifest: walletRuntime.manifest,
        runtime: walletRuntime.runtime, preempt: walletRuntime.preemptForExit, config: zkapiClient.config };
    zkapiClient.browserMode = prepared;
    walletRuntime.manifest = { deployment_id: 'dialog-test' };
    walletRuntime.runtime = { state: { note_id: 7 }, lateWithdrawalAttempts: [],
        preparedWithdrawal: prepared ? { operationId: 'withdraw-7', noteId: 7, phase: 'reserving', mode: 'mutual', destination } : null };
    if (prepared) {
        zkapiClient.config = { ...zkapiClient.config,
            prepared_withdrawal: { note_id: 7, phase: 'reserving', mode: 'mutual', destination } };
    }
    // The newer runtime pre-empts queued work before its lock; the legacy one
    // has no such method, and the check must work with either.
    walletRuntime.preemptForExit = () => { events.push('preempt'); };
    t.after(() => {
        Object.assign(zkapiClient, { browserMode: previous.browserMode, config: previous.config });
        Object.assign(walletRuntime, { manifest: previous.manifest, runtime: previous.runtime });
        if (previous.preempt === undefined) delete walletRuntime.preemptForExit;
        else walletRuntime.preemptForExit = previous.preempt;
    });
    t.mock.method(addressFundingWallet, 'init', async () => {});
    t.mock.method(addressFundingWallet, 'reload', async () => {});
    t.mock.method(zkapiClient, 'init', async () => {});
    t.mock.method(zkapiClient, 'settleActiveLease', async () => { events.push('settle'); });
    t.mock.method(zkapiClient, 'connectWallet', async () => { events.push('connect'); return `0x${'c'.repeat(40)}`; });
    t.mock.method(walletRuntime, 'init', async () => { events.push('init'); });
    t.mock.method(walletRuntime, 'reload', async () => { events.push('reload'); });
    const withdrawals = [];
    t.mock.method(zkapiClient, 'withdraw', async (mode, report, options) => {
        events.push('withdraw');
        withdrawals.push({ mode, options });
        return { status: 'submitted' };
    });
    const runs = [];
    const run = page.modal.run.bind(page.modal);
    page.modal.run = async (action, details, attempt) => { runs.push({ details, attempt }); return run(action, details, attempt); };
    return { events, withdrawals, runs, destination };
}

// The page as the person sees it: Withdraw drawn into a real tree, which is
// what the choice is read back from.
function drawWithdraw(page) {
    page.modal.view = 'withdraw';
    const root = bodyOf(page.modal.renderWithdrawal());
    page.modal.overlay = root;
    return root;
}

test('wiring:withdrawal-operation-recheck the balance and plan are re-verified after settling and connecting, right before the SDK starts', async t => {
    const page = shapesPage(t, 'kit_never_exported', { view: 'withdraw' });
    assert.equal(page.facade.operationRecheckRequired(), true);
    const started = startable(t, page);
    drawWithdraw(page);
    await page.modal.submitWithdrawal();
    // Settle, then the wallet's account and network prompts, then the check
    // under the wallet lock (initialized before it, pre-empted, re-read), then
    // the SDK.
    assert.deepEqual(started.events, ['settle', 'connect', 'init', 'preempt', 'reload', 'withdraw']);
    assert.equal(started.withdrawals[0].mode, 'mutual');
    assert.equal(started.withdrawals[0].options, undefined, 'nothing of its own is asked of the SDK');
    // Nothing else was claimed: no bound was shown, so none is named.
    assert.deepEqual(Object.keys(started.runs[0].details).sort(), ['blocksSend', 'kind', 'phase', 'title']);
    assert.deepEqual(started.runs[0].attempt, { about: { noteId: 7 } });
});

test('wiring:withdrawal-operation-recheck a balance that changed after the click never reaches the SDK', async t => {
    const page = shapesPage(t, 'kit_never_exported', { view: 'withdraw' });
    const started = startable(t, page);
    drawWithdraw(page);
    // Another tab replaced the balance in the slot between the click and the
    // check (the client still shows the one the person chose).
    walletRuntime.reload.mock.mockImplementation(async () => {
        started.events.push('reload');
        walletRuntime.runtime = { ...walletRuntime.runtime, state: { note_id: 8 } };
    });
    await page.modal.submitWithdrawal();
    assert.deepEqual(started.events, ['settle', 'connect', 'init', 'preempt', 'reload']);
    assert.equal(started.withdrawals.length, 0, 'the SDK was not asked');
    assert.match(page.modal.status, /changed in another tab/);
    assert.equal(page.modal.statusError, true);
});

test('wiring:withdrawal-operation-recheck a page without the behavior asks nothing more than it ever did', async t => {
    // No facade at all.
    const noFacade = shapesPage(t, 'kit_never_exported', { view: 'withdraw' });
    delete zkapiClient.oaVersioning;
    const a = startable(t, noFacade);
    await noFacade.modal.submitWithdrawal();
    assert.deepEqual(a.events, ['settle', 'withdraw'], 'no wallet connection, no initialization, no lock, no re-read');
    assert.equal(a.withdrawals[0].options, undefined);
    assert.deepEqual(Object.keys(a.runs[0].details).sort(), ['blocksSend', 'kind', 'phase', 'title']);
    // A page whose protocol does not list the behavior (the legacy family).
    const legacy = shapesPage(t, 'kit_never_exported', { view: 'withdraw', active: V1 });
    assert.equal(legacy.facade.operationRecheckRequired(), false);
    const b = startable(t, legacy);
    await legacy.modal.submitWithdrawal();
    assert.deepEqual(b.events, ['settle', 'withdraw']);
});

test('wiring:withdrawal-operation-recheck the prepared withdrawal the person chose is the one that is checked and signed', async t => {
    const page = shapesPage(t, 'kit_never_exported', { view: 'withdraw' });
    const started = startable(t, page, { prepared: true });
    // The person chose the emergency exit on the saved close.
    const intent = availableWithdrawalEscape();
    assert.equal(intent.operationId, 'withdraw-7');
    page.modal.withdrawalEscapeIntent = intent;
    page.modal.withdrawMode = 'escape';
    drawWithdraw(page);
    await page.modal.submitWithdrawal();
    // The strict check of the chosen plan first (as it always was), then the
    // settlement (its own recovery pass reads the wallet in a browser), then
    // the wallet connection, then the note-and-operation check, then the SDK.
    assert.deepEqual(started.events, ['init', 'reload', 'init', 'reload', 'settle', 'connect',
        'init', 'preempt', 'reload', 'withdraw']);
    assert.equal(started.runs[0].details.operationId, 'withdraw-7', 'the signer is bound to the operation shown');
    assert.equal(started.runs[0].details.kind, 'escape');
    assert.deepEqual(started.withdrawals[0], { mode: 'escape',
        options: { destination: started.destination, expectedWithdrawalOperationId: 'withdraw-7' } });
    // Another operation in the slot when the check runs: nothing is started.
    const again = shapesPage(t, 'kit_never_exported', { view: 'withdraw' });
    const second = startable(t, again, { prepared: true });
    again.modal.withdrawalEscapeIntent = intent;
    again.modal.withdrawMode = 'escape';
    drawWithdraw(again);
    let reads = 0;
    walletRuntime.reload.mock.mockImplementation(async () => {
        reads += 1;
        // The strict check and the settlement's recovery pass still see the
        // plan; by the check right before the SDK another tab has replaced it.
        if (reads === 3) walletRuntime.runtime = { ...walletRuntime.runtime,
            preparedWithdrawal: { ...walletRuntime.runtime.preparedWithdrawal, operationId: 'withdraw-replaced' } };
    });
    await again.modal.submitWithdrawal();
    assert.equal(second.withdrawals.length, 0);
    assert.match(again.modal.status, /changed in another tab/);
});

test('what the person chose about a settling chat is what the signer is told, and the figure is the one shown', async t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    const started = startable(t, page);
    const root = drawWithdraw(page);
    assert.equal(concedeChecked(root), 'wait');
    // Waiting (the default): a normal withdrawal, capped by what was disclosed.
    await page.modal.submitWithdrawal();
    let { details } = started.runs.at(-1);
    assert.equal(details.concededMax, '1000000');
    assert.equal('conceded' in details, false);
    assert.equal(details.kind, 'withdraw');
    assert.deepEqual(started.withdrawals.at(-1), { mode: 'mutual', options: undefined });
    // Leaving now giving up nothing now: an emergency exit that concedes
    // exactly nothing, whatever method was selected.
    page.modal.overlay.querySelector('input[value="zero"]').click();
    assert.deepEqual(page.modal.exitChoice, { choice: 'zero', bound: '1000000', noteId: '7' },
        'kept for the redraws a refresh causes, for this balance and this figure');
    page.modal.render();
    assert.equal(concedeChecked(page.modal.overlay), 'zero');
    await page.modal.submitWithdrawal();
    ({ details } = started.runs.at(-1));
    assert.equal(details.kind, 'escape');
    assert.equal(details.conceded, '0');
    assert.equal('concededMax' in details, false);
    assert.deepEqual(started.withdrawals.at(-1), { mode: 'escape', options: { concede: 'zero' } });
    // The attempt spent the choice: what is drawn next starts from the default.
    assert.equal(page.modal.exitChoice, null);
    assert.equal(concedeChecked(page.modal.overlay), 'wait');
    // Leaving now giving up what was disclosed: exactly that.
    page.modal.overlay.querySelector('input[value="bound"]').click();
    await page.modal.submitWithdrawal();
    ({ details } = started.runs.at(-1));
    assert.equal(details.kind, 'escape');
    assert.equal(details.conceded, '1000000');
    assert.deepEqual(started.withdrawals.at(-1), { mode: 'escape', options: { concede: 'bound' } });
    // A selection that is not acted on is forgotten with the visit.
    page.modal.overlay.querySelector('input[value="bound"]').click();
    assert.deepEqual(page.modal.exitChoice, { choice: 'bound', bound: '1000000', noteId: '7' });
    page.modal.close();
    assert.equal(page.modal.exitChoice, null);
});

test('a page drawn for something else, or before the figure grew, is drawn again and nothing starts on it', async t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    const started = startable(t, page);
    drawWithdraw(page);
    // Another method was selected since the markup was drawn.
    page.modal.withdrawMode = 'escape';
    const draws = [];
    page.modal.render = () => { draws.push('render'); };
    assert.equal(page.modal.submitWithdrawal(), undefined);
    assert.deepEqual(draws, ['render']);
    assert.equal(started.runs.length, 0);
    assert.equal(started.withdrawals.length, 0);
    assert.match(page.modal.outcome.message, /has changed\. Review it below, then choose again\./);
    assert.equal(page.modal.outcome.tone, 'error');
    // The most a chat could cost grew after the page was drawn: the person
    // never saw that figure, so they did not authorize it.
    page.modal.withdrawMode = 'mutual';
    page.modal.outcome = null;
    zkapiClient.config = { ...zkapiClient.config, exit: { ...zkapiClient.config.exit, bound_at_state: '2000000' } };
    zkapiClient.emitChange('update');
    assert.equal(page.facade.state(SHAPES_NOW).exit.boundAtState, '2000000');
    assert.equal(page.modal.submitWithdrawal(), undefined);
    assert.equal(draws.length, 2);
    assert.equal(started.runs.length, 0);
    assert.match(page.modal.outcome.message, /has changed/);
    // Drawn again, it shows the new figure and starts on it.
    page.modal.render = AccountModal.prototype.render;
    drawWithdraw(page);
    assert.equal(page.modal.overlay.querySelector('[data-zkapi-exit-bound]').dataset.bound, '2000000');
    await page.modal.submitWithdrawal();
    assert.equal(started.runs.at(-1).details.concededMax, '2000000');
});

// The instant the settling chat's own time (T) comes, from the state the
// dialog was drawn from.
const settlementTimeOf = page => page.facade.state(SHAPES_NOW).exit.escapeAtMs;

test('once the time a settling chat had to settle has passed, Withdraw offers no waiting and no giving up nothing, and says what a withdrawal does', async t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    const at = settlementTimeOf(page);
    assert.ok(at > SHAPES_NOW, 'the fixture settles later than its clock');
    // The last moment before it: the choice, as always.
    Date.now = () => at - 1;
    assert.deepEqual(concedeValues(bodyOf(page.modal.renderWithdrawal())), ['wait', 'zero', 'bound']);
    assert.doesNotMatch(page.modal.renderWithdrawal(), /data-zkapi-exit-settlement-passed/);
    // From it (at or after, as the SDK reads it): nothing to wait for, and the
    // figure shown is still the number the signer is later held to.
    for (const now of [at, at + 60_000]) {
        Date.now = () => now;
        for (const mode of ['mutual', 'escape']) {
            page.modal.withdrawMode = mode;
            const html = page.modal.renderWithdrawal();
            const root = bodyOf(html);
            assert.equal(root.querySelector('[data-zkapi-exit-bound]').dataset.bound, '1000000');
            assert.equal(root.querySelector('[data-zkapi-exit-fieldset]'), null, `${mode}: no choice`);
            assert.deepEqual(concedeValues(root), [], `${mode}: no radio at all`);
            const said = textOf(root.querySelector('[data-zkapi-exit-settlement-passed]').innerHTML);
            assert.match(said, /The time that chat had to settle has passed\. A withdrawal now leaves at once, as an emergency exit, and gives up the most that chat could cost, even if it cost less\./);
            // The words of waiting would say the opposite of what happens.
            assert.doesNotMatch(textOf(html), /waits for it|Wait for it to settle|Give up nothing now/);
            // The sentence sits with the fine print, before the confirmation.
            assert.ok(html.indexOf('data-zkapi-exit-bound') < html.indexOf('data-zkapi-exit-settlement-passed'));
            assert.ok(html.indexOf('data-zkapi-exit-settlement-passed') < html.indexOf('id="zkapi-withdraw-confirm"'));
        }
    }
});

test('after the settling chat\'s time the dialog starts the withdrawal on the figure it showed, and nothing on a choice that no longer exists', async t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    const at = settlementTimeOf(page);
    const started = startable(t, page);
    Date.now = () => at + 1;
    page.modal.withdrawMode = 'mutual';
    drawWithdraw(page);
    await page.modal.submitWithdrawal();
    // No radio was drawn, so nothing was forced: the normal withdrawal, capped
    // by the figure that was disclosed (the SDK concedes it at once now).
    const { details } = started.runs.at(-1);
    assert.equal(details.kind, 'withdraw');
    assert.equal(details.concededMax, '1000000');
    assert.equal('conceded' in details, false);
    assert.deepEqual(started.withdrawals.at(-1), { mode: 'mutual', options: undefined });
});

test('a page drawn before the settling chat\'s time is not acted on after it, unless the person chose to give up the figure', async t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    const at = settlementTimeOf(page);
    const started = startable(t, page);
    drawWithdraw(page);
    // The default (waiting) was drawn at a time when it meant something.
    assert.equal(concedeChecked(page.modal.overlay), 'wait');
    Date.now = () => at;
    assert.equal(page.modal.submitWithdrawal(), undefined);
    assert.equal(started.runs.length, 0, 'nothing started');
    assert.equal(started.withdrawals.length, 0);
    assert.equal(page.modal.outcome.tone, 'error');
    assert.match(page.modal.outcome.message, /The time that chat had to settle has passed, so a withdrawal now leaves at once and gives up what that chat could cost\./);
    assert.doesNotMatch(page.modal.outcome.message, /has changed\. Review it below, then choose again\./);
    // The redraw is the page of the new situation: no radio, the sentence.
    assert.deepEqual(concedeValues(page.modal.overlay), []);
    assert.ok(page.modal.overlay.querySelector('[data-zkapi-exit-settlement-passed]'));
    // Giving up nothing now was drawn before it too, and is no longer a thing.
    Date.now = () => at - 1000;
    page.modal.outcome = null;
    page.modal.render();
    page.modal.overlay.querySelector('input[value="zero"]').click();
    assert.equal(page.modal.exitChoice?.choice, 'zero');
    Date.now = () => at;
    assert.equal(page.modal.submitWithdrawal(), undefined);
    assert.equal(started.withdrawals.length, 0);
    assert.equal(page.modal.exitChoice, null, 'the pick is not carried over');
    // Giving up the figure was chosen in so many words and is still exactly
    // what happens: it is acted on.
    Date.now = () => at - 1000;
    page.modal.outcome = null;
    page.modal.render();
    page.modal.overlay.querySelector('input[value="bound"]').click();
    Date.now = () => at + 5;
    await page.modal.submitWithdrawal();
    assert.equal(started.runs.at(-1).details.conceded, '1000000');
    assert.deepEqual(started.withdrawals.at(-1), { mode: 'escape', options: { concede: 'bound' } });
});

test('the settling chat\'s time passing while the chat key settles stops a waiting withdrawal before the SDK is asked', async t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    const at = settlementTimeOf(page);
    const started = startable(t, page);
    // The chat key's settlement takes until after that time.
    zkapiClient.settleActiveLease.mock.mockImplementation(async () => {
        started.events.push('settle');
        Date.now = () => at + 1;
    });
    drawWithdraw(page);
    assert.equal(concedeChecked(page.modal.overlay), 'wait');
    await page.modal.submitWithdrawal();
    assert.equal(started.withdrawals.length, 0, 'the SDK was not asked');
    assert.ok(!started.events.includes('withdraw'));
    assert.match(page.modal.status, /The time that chat had to settle has passed/);
    assert.equal(page.modal.statusError, true);
    // Giving up nothing now is just as much a thing of the past.
    Date.now = () => at - 1000;
    const nothing = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    const third = startable(t, nothing);
    zkapiClient.settleActiveLease.mock.mockImplementation(async () => {
        third.events.push('settle');
        Date.now = () => at + 1;
    });
    drawWithdraw(nothing);
    nothing.modal.overlay.querySelector('input[value="zero"]').click();
    await nothing.modal.submitWithdrawal();
    assert.equal(third.withdrawals.length, 0);
    assert.match(nothing.modal.status, /The time that chat had to settle has passed/);
    // The same lapse is no reason to stop a person who chose to give up the figure.
    Date.now = () => at - 1000;
    const again = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    const second = startable(t, again);
    zkapiClient.settleActiveLease.mock.mockImplementation(async () => {
        second.events.push('settle');
        Date.now = () => at + 1;
    });
    drawWithdraw(again);
    again.modal.overlay.querySelector('input[value="bound"]').click();
    await again.modal.submitWithdrawal();
    assert.deepEqual(second.withdrawals.at(-1), { mode: 'escape', options: { concede: 'bound' } });
});

// A refusal of a normal withdrawal, as the SDK throws it (real shape), with
// the time it names moved to `escapeAtMs`.
function settlementRefusal(escapeAtMs) {
    const real = SHAPES.errors.request_settlement_pending_withdraw;
    const data = structuredClone(real.data);
    data.escape_at = escapeAtMs;
    return Object.assign(new Error(real.message), { name: real.name, status: real.status, code: real.code, data });
}

test('a choice drawn under a time that was held only by a refusal is out of date once that time passed, though the state no longer carries it', async t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    const at = settlementTimeOf(page);
    // A snapshot that does not say whether the state settled, and no time:
    // the refusal of the earlier attempt is what knows it.
    zkapiClient.config = { ...zkapiClient.config, exit: { ...zkapiClient.config.exit, state_fresh: null, escape_at: null } };
    zkapiClient.emitChange('update');
    page.facade.noteRefusal(settlementRefusal(at), { slot: true });
    assert.equal(page.facade.state(SHAPES_NOW).exit.wait?.kind, 'settlement');
    const started = startable(t, page);
    drawWithdraw(page);
    page.modal.render();
    assert.deepEqual(concedeValues(page.modal.overlay), ['wait', 'zero', 'bound']);
    assert.equal(page.modal.overlay.querySelector('[data-zkapi-exit-offered]').getAttribute('data-zkapi-settles-at'), String(at));
    // The time comes (to the millisecond); the held wait is over and the
    // state says nothing.
    Date.now = () => at;
    assert.equal(page.facade.state(at).exit.wait, null);
    assert.equal(page.facade.state(at).exit.escapeAtMs, null);
    assert.equal(page.modal.submitWithdrawal(), undefined);
    assert.equal(started.runs.length, 0);
    assert.equal(started.withdrawals.length, 0);
    assert.match(page.modal.outcome.message, /The time that chat had to settle has passed/);
});

test('a choice drawn when the state named no time is out of date once the state names one that has passed', async t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    const at = settlementTimeOf(page);
    zkapiClient.config = { ...zkapiClient.config, exit: { ...zkapiClient.config.exit, escape_at: null } };
    zkapiClient.emitChange('update');
    assert.equal(page.facade.state(SHAPES_NOW).exit.escapeAtMs, null);
    const started = startable(t, page);
    drawWithdraw(page);
    page.modal.render();
    assert.deepEqual(concedeValues(page.modal.overlay), ['wait', 'zero', 'bound']);
    assert.equal(page.modal.overlay.querySelector('[data-zkapi-exit-offered]'), null, 'no time to draw it under');
    // The state learns its time, and it is this very moment.
    zkapiClient.config = { ...zkapiClient.config, exit: { ...zkapiClient.config.exit, escape_at: at } };
    zkapiClient.emitChange('update');
    Date.now = () => at;
    assert.equal(page.modal.submitWithdrawal(), undefined);
    assert.equal(started.withdrawals.length, 0);
    assert.match(page.modal.outcome.message, /The time that chat had to settle has passed/);
    // A moment earlier the same page is acted on.
    page.modal.outcome = null;
    Date.now = () => at - 1;
    drawWithdraw(page);
    page.modal.render();
    await page.modal.submitWithdrawal();
    assert.equal(started.withdrawals.length, 1);
});

test('only a settlement wait carries a settlement time: another kind of wait with a time does not end the choice', t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    zkapiClient.config = { ...zkapiClient.config, exit: { ...zkapiClient.config.exit, escape_at: null } };
    zkapiClient.emitChange('update');
    // A state the helpers cannot derive (only a settlement wait has the time),
    // to pin that the dialog does not read one from anywhere else.
    const real = page.facade.state(SHAPES_NOW);
    page.facade.state = () => ({ ...real, exit: { ...real.exit, escapeAtMs: null,
        wait: { kind: 'release', untilMs: SHAPES_NOW + 60_000, escapeAtMs: SHAPES_NOW - 1000, mustInitiateByMs: null,
            boundAtState: '1000000' } } });
    const html = page.modal.renderWithdrawal();
    assert.deepEqual(concedeValues(bodyOf(html)), ['wait', 'zero', 'bound']);
    assert.doesNotMatch(html, /data-zkapi-exit-settlement-passed/);
});

test('a chat that settled before the click is no settlement time that passed: the choice drawn for it still means what it says', async t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    const at = settlementTimeOf(page);
    const started = startable(t, page);
    drawWithdraw(page);
    page.modal.render();
    assert.equal(concedeChecked(page.modal.overlay), 'wait');
    // The service says the chat settled: the state is fresh and nothing can be
    // given up. The clock is past the time that was drawn.
    zkapiClient.config = { ...zkapiClient.config, exit: { ...zkapiClient.config.exit, state_fresh: true, bound_at_state: '0', escape_at: null } };
    zkapiClient.emitChange('update');
    Date.now = () => at + 1;
    await page.modal.submitWithdrawal();
    assert.equal(started.withdrawals.length, 1, 'started');
    assert.equal(started.withdrawals[0].mode, 'mutual');
    assert.equal(started.runs[0].details.concededMax, '1000000', 'the figure that was shown is the cap');
});

test('the later of the times the state holds is the settlement time, so a refusal for a later request keeps the choice', async t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    const at = settlementTimeOf(page);
    // The standing time is behind the clock; a held refusal names a later one.
    const later = at + 3_600_000;
    zkapiClient.config = { ...zkapiClient.config, exit: { ...zkapiClient.config.exit, escape_at: SHAPES_NOW - 60_000 } };
    zkapiClient.emitChange('update');
    page.facade.noteRefusal(settlementRefusal(later), { slot: true });
    const state = page.facade.state(SHAPES_NOW);
    assert.equal(state.exit.escapeAtMs, SHAPES_NOW - 60_000);
    assert.equal(state.exit.wait.escapeAtMs, later);
    drawWithdraw(page);
    page.modal.render();
    assert.deepEqual(concedeValues(page.modal.overlay), ['wait', 'zero', 'bound']);
    assert.equal(page.modal.overlay.querySelector('[data-zkapi-exit-offered]').getAttribute('data-zkapi-settles-at'), String(later));
});

test('giving up the figure is chosen for that figure exactly: a figure that shrank is drawn again before anything is prepared', async t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    const started = startable(t, page);
    drawWithdraw(page);
    page.modal.render();
    page.modal.overlay.querySelector('input[value="bound"]').click();
    assert.equal(page.modal.exitChoice?.choice, 'bound');
    // One of the unresolved chats settled: the most that is left is smaller.
    zkapiClient.config = { ...zkapiClient.config, exit: { ...zkapiClient.config.exit, bound_at_state: '600000' } };
    zkapiClient.emitChange('update');
    assert.equal(page.facade.state(SHAPES_NOW).exit.boundAtState, '600000');
    assert.equal(page.modal.submitWithdrawal(), undefined);
    assert.equal(started.runs.length, 0, 'nothing was prepared');
    assert.equal(started.withdrawals.length, 0);
    assert.match(page.modal.outcome.message, /has changed\. Review it below, then choose again\./);
    assert.equal(page.modal.exitChoice, null);
    // Redrawn with the smaller figure, and chosen again, it goes through.
    drawWithdraw(page);
    page.modal.render();
    assert.equal(page.modal.overlay.querySelector('[data-zkapi-exit-bound]').dataset.bound, '600000');
    page.modal.overlay.querySelector('input[value="bound"]').click();
    await page.modal.submitWithdrawal();
    assert.equal(started.runs.at(-1).details.conceded, '600000');
    // Giving up nothing now, or waiting, is not chosen for the figure: a
    // smaller one is no reason to stop.
    zkapiClient.config = { ...zkapiClient.config, exit: { ...zkapiClient.config.exit, bound_at_state: '300000' } };
    zkapiClient.emitChange('update');
    await page.modal.submitWithdrawal();
    assert.equal(started.runs.at(-1).details.concededMax, '600000');
});

test('the figure moving while the chat key settles stops the withdrawal before the SDK is asked, for each way of leaving', async t => {
    const cases = [
        { pick: 'bound', after: '600000', moved: true },
        { pick: 'bound', after: '2000000', moved: true },
        { pick: 'zero', after: '2000000', moved: true },
        { pick: 'wait', after: '2000000', moved: true },
        { pick: 'zero', after: '600000', moved: false },
        { pick: 'wait', after: '600000', moved: false }
    ];
    for (const { pick, after, moved } of cases) {
        const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
        const started = startable(t, page);
        zkapiClient.settleActiveLease.mock.mockImplementation(async () => {
            started.events.push('settle');
            zkapiClient.config = { ...zkapiClient.config, exit: { ...zkapiClient.config.exit, bound_at_state: after } };
            zkapiClient.emitChange('update');
        });
        drawWithdraw(page);
        page.modal.render();
        page.modal.overlay.querySelector(`input[value="${pick}"]`).click();
        await page.modal.submitWithdrawal();
        const label = `${pick} then ${after}`;
        assert.equal(started.withdrawals.length, moved ? 0 : 1, label);
        if (moved) assert.match(page.modal.status, /has changed\. Review it below, then choose again\./, label);
    }
});

test('the figure the state holds is the larger of the two it keeps, as the choice is drawn from them', async t => {
    for (const [waiting, standing] of [['2000000', '1000000'], ['500000', '1000000']]) {
        const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
        const started = startable(t, page);
        const real = page.facade.state(SHAPES_NOW);
        page.facade.state = () => ({ ...real, exit: { ...real.exit, boundAtState: standing,
            wait: { kind: 'settlement', untilMs: SHAPES_NOW + 600_000, escapeAtMs: SHAPES_NOW + 600_000,
                mustInitiateByMs: null, boundAtState: waiting } } });
        const larger = BigInt(waiting) > BigInt(standing) ? waiting : standing;
        drawWithdraw(page);
        page.modal.render();
        assert.equal(page.modal.overlay.querySelector('[data-zkapi-exit-bound]').dataset.bound, larger);
        page.modal.overlay.querySelector('input[value="bound"]').click();
        await page.modal.submitWithdrawal();
        assert.equal(started.withdrawals.length, 1, `${waiting} over ${standing}`);
        assert.equal(started.runs[0].details.conceded, larger);
    }
});

test('a choice to give something up is kept for its own balance and its own figure, and for the stay in Withdraw only', async t => {
    const page = shapesPage(t, 'unresolved_request_settlement_wait', { view: 'withdraw' });
    startable(t, page);
    drawWithdraw(page);
    await page.modal.submitWithdrawal();
    page.modal.view = 'withdraw';
    page.modal.render();
    page.modal.overlay.querySelector('input[value="bound"]').click();
    assert.deepEqual(page.modal.exitChoice, { choice: 'bound', bound: '1000000', noteId: '7' });
    page.modal.render();
    assert.equal(concedeChecked(page.modal.overlay), 'bound', 'a refresh redraws what was picked');
    // Another balance with the same figure (a chat tier's budget repeats): the
    // pick was not made for it.
    zkapiClient.wallet = { ...zkapiClient.wallet, note: { ...zkapiClient.wallet.note, note_id: 9 } };
    assert.equal(concedeChecked(bodyOf(page.modal.renderWithdrawal())), 'wait', 'a direct draw does not restore it');
    page.modal.render();
    assert.equal(page.modal.exitChoice, null, 'a redraw forgets a pick made for another balance');
    zkapiClient.wallet = { ...zkapiClient.wallet, note: { ...zkapiClient.wallet.note, note_id: 7 } };
    page.modal.render();
    assert.equal(concedeChecked(page.modal.overlay), 'wait');
    // Leaving Withdraw and coming back starts from the default again.
    page.modal.overlay.querySelector('input[value="bound"]').click();
    assert.equal(page.modal.exitChoice?.choice, 'bound');
    page.modal.view = 'balance';
    page.modal.render();
    assert.equal(page.modal.exitChoice, null);
    page.modal.view = 'withdraw';
    page.modal.render();
    assert.equal(concedeChecked(page.modal.overlay), 'wait');
});

// What the revision 3 client says about a held exit lock: it blocks chat
// (the installed legacy client has no such rule).
function lockBlocksChat(t) {
    Object.defineProperty(zkapiClient, 'withdrawalBlocksChat', {
        configurable: true,
        get() {
            return !!this.activeLateWithdrawal || !!this.config?.prepared_withdrawal || !!this.config?.exit?.lock
                || ['prepared', 'submitted', 'pending'].includes(this.withdrawal?.phase);
        }
    });
    t.after(() => { delete zkapiClient.withdrawalBlocksChat; });
}

test('a balance held by an exit lock with no withdrawal of its own is said once, frozen, and not also "needs attention" with "no transaction is moving"', t => {
    lockBlocksChat(t);
    const page = shapesPage(t, 'mutual_lock_with_ownership_proof');
    assert.equal(zkapiClient.withdrawalBlocksChat, true, 'the client holds chat');
    assert.equal(zkapiClient.activeWithdrawal, null, 'no plan and no transaction of its own');
    const html = page.modal.renderBalance();
    assert.match(html, /data-zkapi-version-notice="frozen"/);
    const words = textOf(html);
    assert.match(words, /frozen/i);
    assert.doesNotMatch(words, /Needs attention|No transaction is moving|ready to finish withdrawing/);
    // The pill is the notice's own word, in the quiet tone.
    const pill = bodyOf(html).querySelectorAll('.zkapi-balance-top .zkapi-pill').at(-1);
    assert.equal(textOf(pill.innerHTML), 'frozen');
    assert.doesNotMatch(pill.className, /amber/);
    // The Withdraw button is still there: the exit stays available.
    assert.match(html, /id="zkapi-withdraw-view-btn"/);
});

test('a prepared plan keeps its own words beside the frozen notice: finishing it is what comes next', t => {
    lockBlocksChat(t);
    const page = shapesPage(t, 'escape_lock_released_proof');
    assert.equal(zkapiClient.activeWithdrawal?.phase, 'prepared');
    const html = page.modal.renderBalance();
    assert.match(html, /data-zkapi-version-notice="frozen"/);
    assert.match(textOf(html), /No transaction is moving\. This balance is ready to finish withdrawing\./);
    assert.match(textOf(html), /Needs attention/);
});

test('a held lock does not hide the words of a transaction that is moving, or of a page whose frozen notice is not drawn', t => {
    lockBlocksChat(t);
    // A submitted transaction keeps its own line and pill.
    const submitted = shapesPage(t, 'mutual_lock_with_ownership_proof');
    zkapiClient.config = { ...zkapiClient.config, prepared_withdrawal: { mode: 'mutual', phase: 'submitted', note_id: 7,
        destination: `0x${'a'.repeat(40)}`, transaction_hash: `0x${'ab'.repeat(32)}` } };
    const html = submitted.modal.renderBalance();
    assert.match(textOf(html), /Your withdrawal transaction was submitted\. Check its status before using this balance\./);
    assert.match(textOf(html), /Submitted/);
    assert.doesNotMatch(html, /data-zkapi-version-notice="frozen"[\s\S]*frozen<\/span>/);
    // Without the helpers there is no notice to stand in for the words.
    const early = shapesPage(t, 'mutual_lock_with_ownership_proof', { noHelpers: true });
    const plain = textOf(early.modal.renderBalance());
    assert.match(plain, /Needs attention/);
    assert.match(plain, /No transaction is moving\. This balance is ready to finish withdrawing\./);
});

test('a refusal is held against the balance it was about: the shown one, or none of the set-aside ones', async t => {
    const OWN = SHAPES.scenarios.withdrawals_alert_credited_defeated.clientSnapshot.withdrawals;
    const refusal = () => Object.assign(new Error(SHAPES.errors.device_not_newest_successor.message), {
        name: SHAPES.errors.device_not_newest_successor.name, status: 409, code: 'device_not_newest',
        data: structuredClone(SHAPES.errors.device_not_newest_successor.data)
    });
    // A set-aside record is finished, restored or claimed: its refusal says
    // nothing about the balance in the wallet.
    const aside = shapesPage(t, 'kit_never_exported', { view: 'withdrawals', withdrawals: structuredClone(OWN), useSingleton: true });
    assert.equal(aside.facade.state(SHAPES_NOW).exit.deviceNotNewest, false);
    const restored = OWN.find(record => record.noteId === 6);
    t.mock.method(zkapiClient, 'restoreWithdrawal', async () => { throw refusal(); });
    await aside.modal.run(async () => { await zkapiClient.restoreWithdrawal(restored.recordId); }, { kind: 'withdraw-sync', title: 'Restoring balance' },
        { about: { recordId: restored.recordId } });
    assert.equal(aside.facade.state(SHAPES_NOW).exit.deviceNotNewest, false, 'not attached to the live balance');
    // The same refusal of the live balance is the live balance's.
    aside.facade.resetForTests();
    const live = shapesPage(t, 'kit_never_exported', { view: 'withdraw', useSingleton: true });
    const started = startable(t, live);
    drawWithdraw(live);
    zkapiClient.withdraw.mock.mockImplementation(async () => { throw refusal(); });
    await live.modal.submitWithdrawal();
    assert.equal(started.runs[0].attempt.about.noteId, 7);
    assert.equal(live.facade.state(SHAPES_NOW).exit.deviceNotNewest, true);
    // And what the person reads is the product's sentence, not the SDK's.
    assert.match(live.modal.status, /used on another device|used .* after this browser|can’t safely withdraw/i);
});

// -- Payment history rows -------------------------------------------------------

const ownRecords = () => structuredClone(SHAPES.scenarios.withdrawals_alert_credited_defeated.clientSnapshot.withdrawals);
const rowOf = (html, noteId) => {
    const match = new RegExp(`<section[^>]*data-withdrawal-record="[^"]*:${noteId}"[\\s\\S]*?</section>`).exec(html);
    assert.ok(match, `a row for note ${noteId}`);
    return match[0];
};

test('a payout the payment contract holds is "Payout held" on its row, with its claim, and never "returned"', t => {
    const page = shapesPage(t, 'withdrawals_alert_credited_defeated', { view: 'withdrawals' });
    const html = page.modal.renderWithdrawalRecords();
    const credited = rowOf(html, 3);
    assert.match(credited, />Payout held</);
    assert.match(textOf(credited), /Payout held: \$?[\d.]+|Payout held: 0\.0008 ETH/);
    assert.match(credited, /data-zkapi-record-credit/);
    const claim = bodyOf(credited).querySelector('[data-claim-payout]');
    assert.ok(claim);
    assert.match(claim.dataset.claimPayout, /:3$/);
    assert.equal(claim.disabled, false);
    // It is not a payout verified, so it is not told as one.
    assert.doesNotMatch(credited, /returned to|Funds are in your wallet|Balance closed|Payment not verified|badge-status-success/);
    assert.match(textOf(credited), /Withdrawal · Escape hatch/);
    // The one whose amount this browser was never told still offers the claim.
    const unknown = rowOf(html, 4);
    assert.match(unknown, />Payout held</);
    assert.match(textOf(unknown), /The amount isn’t shown here/);
    assert.ok(bodyOf(unknown).querySelector('[data-claim-payout]'));
    // One already delivered says where, and offers nothing to claim.
    const delivered = rowOf(html, 5);
    assert.match(delivered, /data-zkapi-record-claimed/);
    assert.equal(bodyOf(delivered).querySelector('[data-claim-payout]'), null);
    // While the dialog works the claim cannot be clicked.
    page.modal.busy = true;
    assert.equal(bodyOf(rowOf(page.modal.renderWithdrawalRecords(), 3)).querySelector('[data-claim-payout]').disabled, true);
});

test('a close that paid out less than disclosed keeps its note and badge, without a toast, as the person last saw it', t => {
    const page = shapesPage(t, 'withdrawals_alert_credited_defeated', { view: 'withdrawals' });
    const alerted = rowOf(page.modal.renderWithdrawalRecords(), 2);
    assert.match(alerted, /data-zkapi-record-badge[^>]*>Paid less than expected</);
    assert.match(alerted, /data-zkapi-record-alert/);
    assert.match(textOf(alerted), /The payment can’t be changed\. Please report it to the service operator\./);
    // It is still a payout that was paid: the row does not call it unverified.
    assert.match(alerted, />Returned</);
    // The two pills sit together, the status first.
    assert.ok(alerted.indexOf('>Returned<') < alerted.indexOf('data-zkapi-record-badge'));
});

test('a balance another device used shows why, and none of the buttons its row would have', t => {
    const page = shapesPage(t, 'withdrawals_alert_credited_defeated', { view: 'withdrawals' });
    const html = page.modal.renderWithdrawalRecords();
    const flagged = rowOf(html, 6);
    assert.match(flagged, />Used on another device</);
    assert.match(flagged, /data-zkapi-record-device/);
    assert.doesNotMatch(flagged, /data-restore-withdrawal|data-sync-withdrawal|data-finalize-withdrawal|data-withdraw-background|data-retry-|data-recover-finalization|data-cancel-background-preparation|<button/);
    // The SDK's own sentence tells the person to restore a backup this app
    // cannot open: the row's own words replace it.
    assert.doesNotMatch(flagged, /Restore the newest backup or exit kit/);
    // Another row of the same list is untouched.
    assert.match(rowOf(html, 8), /data-withdraw-background|Check status/);
    // Without the helpers the SDK refuses it anyway, and the row is the row
    // it was (the page has no words for it yet).
    const early = shapesPage(t, 'withdrawals_alert_credited_defeated', { view: 'withdrawals', noHelpers: true });
    assert.match(rowOf(early.modal.renderWithdrawalRecords(), 6), /data-restore-withdrawal|Use this balance|Finish withdrawal/);
});

test('a page of the legacy protocol draws Payment history rows exactly as it always did', t => {
    const records = [
        { recordId: 'returned', mode: 'mutual', phase: 'closed', payoutVerified: true, finalBalance: 1_500_000,
            destination: `0x${'12'.repeat(20)}`, transactionHash: `0x${'ab'.repeat(32)}`, createdAt: 1_700_000_000_000 },
        { recordId: 'pending', mode: 'escape', phase: 'pending', chainStatus: 'pending_withdrawal', finalBalance: 1_000_000,
            challengeDeadline: Math.floor(NOW_MS / 1000) + DAY, createdAt: 1_700_000_100_000 },
        { recordId: 'parked', mode: 'mutual', phase: 'parked', finalBalance: 700_000, createdAt: 1_700_000_200_000 },
        { recordId: 'closed-unverified', mode: 'mutual', phase: 'closed', finalBalance: 700_000, createdAt: 1_700_000_300_000 }
    ];
    const rows = html => [...html.matchAll(/<section[^>]*data-withdrawal-record="[^"]*"[\s\S]*?<\/section>/g)].map(match => match[0]);
    // The row is the same with the helpers, a facade and without either.
    const withHelpers = shapesPage(t, 'kit_never_exported', { view: 'withdrawals', withdrawals: records, deposits: [], active: V1 });
    const drawn = rows(withHelpers.modal.renderWithdrawalRecords());
    assert.equal(drawn.length, records.length);
    delete zkapiClient.oaVersioning;
    assert.deepEqual(rows(withHelpers.modal.renderWithdrawalRecords()), drawn);
    // And nothing of a payout or a device is in them.
    assert.doesNotMatch(drawn.join(''), /Payout held|data-claim-payout|data-zkapi-record|Used on another device|Paid less/);
});

test('the row’s own "Payout held" and the shared predicate agree on every record', () => {
    const modal = Object.create(AccountModal.prototype);
    const cases = [];
    for (const phase of ['closed', 'closed_unconfirmed', 'parked', 'restored', 'pending', 'finalizing']) {
        for (const payoutCredited of [true, false, undefined]) {
            for (const payoutClaimed of [true, false, undefined]) {
                for (const payoutVerified of [true, false]) cases.push({ phase, payoutCredited, payoutClaimed, payoutVerified });
            }
        }
    }
    for (const record of cases) {
        const held = modal.withdrawalRecordLabel(record) === 'Payout held';
        assert.equal(held, isUnclaimedPayoutCredit(record), JSON.stringify(record));
    }
});

// -- The claim ------------------------------------------------------------------

test('claiming a payout is one explicit gesture on its row, for that record, and says how it ended', async t => {
    const page = shapesPage(t, 'withdrawals_alert_credited_defeated', { view: 'withdrawals' });
    const credited = ownRecords().find(record => record.noteId === 3);
    const calls = [];
    zkapiClient.claimEscapePayout = async (recordId, report) => {
        calls.push(recordId);
        report('Checking the payout the vault holds for this address…');
        return { status: 'claimed', recordId, destination: credited.destination, transactionHash: `0x${'cd'.repeat(32)}`, amount: 800_000 };
    };
    t.after(() => { delete zkapiClient.claimEscapePayout; });
    const runs = [];
    const run = page.modal.run.bind(page.modal);
    page.modal.run = (action, details, attempt) => { runs.push({ details, attempt }); return run(action, details, attempt); };
    // Wired by the dialog from the row's button, through a real render.
    const root = bodyOf('');
    page.modal.overlay = root;
    page.modal.render();
    const button = root.querySelector('[data-claim-payout]');
    assert.ok(button, 'the dialog drew the row');
    button.click();
    // The claim runs through the dialog's own flow; wait for how it ended.
    await untilDone(() => page.modal.outcome?.tone === 'success');
    assert.deepEqual(calls, [credited.recordId]);
    assert.deepEqual(runs[0].details, { kind: 'payout-claim', title: 'Claiming payout', phase: 'wallet',
        withdrawalRecordId: credited.recordId, blocksSend: false });
    assert.deepEqual(runs[0].attempt, { about: { recordId: credited.recordId } });
    assert.equal(page.modal.status, 'Payout claimed and paid to 0x3434…343434.');
    assert.equal(page.modal.outcome.tone, 'success');
    // The claim goes through the funding scope's signer as its own kind.
    assert.equal(runs[0].details.kind, 'payout-claim');
});

test('a claim that is sent and still confirming is information, and one that fails keeps the SDK’s words', async t => {
    const page = shapesPage(t, 'withdrawals_alert_credited_defeated', { view: 'withdrawals' });
    const credited = ownRecords().find(record => record.noteId === 3);
    let answer = { status: 'pending', recordId: credited.recordId, destination: credited.destination, transactionHash: `0x${'cd'.repeat(32)}` };
    zkapiClient.claimEscapePayout = async () => {
        if (answer instanceof Error) throw answer;
        return answer;
    };
    t.after(() => { delete zkapiClient.claimEscapePayout; });
    await page.modal.claimPayout(credited.recordId);
    assert.match(page.modal.status, /still confirming/);
    assert.equal(page.modal.outcome.tone, 'info');
    answer = Object.assign(new Error('The destination still does not accept ETH, so the vault keeps its payout.'),
        { code: 'native_transfer_failed', shortMessage: 'The destination still does not accept ETH, so the vault keeps its payout.' });
    await page.modal.claimPayout(credited.recordId);
    assert.equal(page.modal.statusError, true);
    assert.match(page.modal.status, /still does not accept ETH/);
    // No record, no claim: nothing is asked of the SDK for an empty id.
    answer = { status: 'claimed' };
    const before = page.modal.status;
    assert.equal(page.modal.claimPayout(''), undefined);
    assert.equal(page.modal.claimPayout(null), undefined);
    assert.equal(page.modal.status, before);
});

test('a version without payouts to claim says so and asks nothing', async t => {
    const page = shapesPage(t, 'withdrawals_alert_credited_defeated', { view: 'withdrawals' });
    assert.equal(typeof zkapiClient.claimEscapePayout, 'undefined');
    await page.modal.claimPayout('some-record');
    assert.equal(page.modal.statusError, true);
    assert.match(page.modal.status, /no payout to claim/);
});

// -- What a closed withdrawal says ------------------------------------------------

test('a close whose payout was only credited is not told as sent, and says where to claim it', t => {
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, { view: 'withdraw', busy: false, overlay: { querySelector: () => null, querySelectorAll: () => [] } });
    const event = { destination: `0x${'12'.repeat(20)}`, finalBalance: 1_000_000n };
    modal.recordWithdrawalOutcome({ status: 'closed', event, payoutCredited: true });
    assert.equal(modal.withdrawalCompleted, false);
    assert.equal(modal.withdrawalOutcomePending, true);
    assert.equal(modal.view, 'withdrawals');
    assert.doesNotMatch(modal.status, /Withdrawal confirmed|Funds sent|returned/);
    assert.match(modal.status, /held for you\. Claim it from Payment history\./);
    // The upgrade stays on its own steps.
    modal.view = 'upgrade';
    modal.recordWithdrawalOutcome({ status: 'closed', event, payoutCredited: true });
    assert.equal(modal.view, 'upgrade');
    // A close that was paid is still told as paid.
    modal.view = 'withdraw';
    modal.recordWithdrawalOutcome({ status: 'closed', event });
    assert.equal(modal.withdrawalCompleted, true);
    assert.equal(modal.status, 'Withdrawal confirmed. Funds sent to your saved wallet address.');
});

test('an emergency exit that was started carries the SDK’s warning about its destination, as text', () => {
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, { view: 'withdraw', busy: false });
    const deadline = Math.floor(NOW_MS / 1000) + DAY;
    modal.recordWithdrawalOutcome({ status: 'pending_withdrawal', deadline,
        destinationWarning: 'This address did not accept a plain ETH transfer. <b>Prefer an ordinary account.</b>' });
    assert.match(modal.status, /^Escape started\. Finalize after .*\. This address did not accept a plain ETH transfer\./);
    modal.outcome = { message: modal.status, tone: 'info', view: 'withdraw' };
    // Said as text: the dialog escapes the sentence like every other.
    modal.escapeHtml = value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    assert.doesNotMatch(modal.renderOutcome(), /<b>/);
    // Nothing is said when the SDK found nothing, and an enormous one is cut.
    modal.recordWithdrawalOutcome({ status: 'pending_withdrawal', deadline });
    assert.doesNotMatch(modal.status, /did not accept/);
    modal.recordWithdrawalOutcome({ status: 'pending_withdrawal', deadline, destinationWarning: 'x'.repeat(10_000) });
    assert.ok(modal.status.length < 700);
});

test('a row whose helper fails still hides the buttons of a balance this browser cannot exit', t => {
    const page = shapesPage(t, 'withdrawals_alert_credited_defeated', { view: 'withdrawals' });
    const ui = createVersionUi({ facade: page.facade });
    ui.recordExtras = () => { throw new Error('the helper failed'); };
    page.facade.attachUi(ui);
    const html = page.modal.renderWithdrawalRecords();
    // The flagged row has no buttons; nothing else was added to any row.
    assert.doesNotMatch(rowOf(html, 6), /data-restore-withdrawal|data-sync-withdrawal|<button/);
    assert.match(rowOf(html, 8), /data-withdraw-background|data-sync-withdrawal|data-restore-withdrawal|<button/);
    assert.doesNotMatch(html, /data-claim-payout/, 'a claim needs the helper that knows the record');
    // The same failure for a helper that returns nonsense.
    ui.recordExtras = () => 'not an object';
    assert.doesNotMatch(rowOf(page.modal.renderWithdrawalRecords(), 6), /data-restore-withdrawal/);
});

test('the notice buttons that only navigate work without the helpers’ own handler', async t => {
    const state = holder(20);
    const f = fixture(t, { note: aNote(20), facade: facadeFor(state, { ui: { ...helpers().ui, act: undefined } }) });
    const seen = [];
    const context = { surface: 'dialog', notify() {}, refresh() {}, dispatch: (name, detail) => seen.push([name, detail]) };
    const version = f.modal.versionContext();
    assert.deepEqual(await f.modal.fallbackVersionAction('open-withdraw', version, context), { ok: true });
    assert.deepEqual(await f.modal.fallbackVersionAction('open-payments', version, context), { ok: true });
    assert.deepEqual(seen, [['zkapi-payment-required', { view: 'withdraw' }], ['zkapi-payment-required', { view: 'withdrawals' }]]);
    // The ones that need a dialog of the helpers are not invented here.
    assert.deepEqual(await f.modal.fallbackVersionAction('export-exit-kit', version, context), { ok: false, why: 'unknown_action' });
    assert.deepEqual(await f.modal.fallbackVersionAction('abandon-open', version, context), { ok: false, why: 'unknown_action' });
    assert.equal(seen.length, 2);
    // Through the dialog's own button wiring the same navigation lands on the view.
    const views = [];
    f.modal.goToView = view => views.push(view);
    await f.modal.runVersionAction('open-withdraw', { surface: 'dialog', notify() {}, refresh() {},
        dispatch: (name, detail) => f.modal.goToView(detail.view) });
    assert.deepEqual(views, ['withdraw']);
});

test('the new paths of the dialog run in a vm with no imports and no facade, and read "no versions"', () => {
    const source = fs.readFileSync(new URL('../../chat/zkapi/components/AccountModal.js', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\n/gm, '').replace(/export default class /g, 'class ');
    const noop = () => '';
    const client = { config: { funding: { chain_id: 1 } }, note: { note_id: 7 }, withdrawals: [], deposits: [], expiryHistory: [],
        isNativeEthFunding: true, formatMoney: () => '—', compact: value => String(value),
        connectWallet() { throw new Error('no wallet is asked'); } };
    const names = ['fundingDisclosure', 'attachFundingDisclosures', 'captureFundingDisclosureView', 'restoreFundingDisclosureView',
        'showSurface', 'hideSurface', 'revealText', 'settlePrivateAccess', 'availableWithdrawalEscape', 'sameWithdrawalEscape',
        'canCancelPreparedWithdrawal', 'ethUnits', 'depositOperationId', 'isWalletCancellation', 'resetCanceledDeposit',
        'attachWalletModalRestoreCancellation', 'cancelWalletModalRestore', 'currentWalletModalRestore', 'finishWalletModalRestore',
        'parseTokenAmount', 'walletErrorMessage', 'explainZkapiError', 'isIndexerLag', 'pendingDepositMessage',
        'updateZkapiBalanceControl', 'captureFundingSetupView', 'fundingSetupGuide', 'restoreFundingSetupView', 'walletJourney',
        'canQuotePendingAddressDeposit', 'withdrawalDestination', 'initWalletClient', 'prepareWalletMethod', 'setWalletMethod',
        'subscribeWalletMethod', 'attachWalletMethodControls', 'captureWalletView', 'refreshWalletView', 'renderDepositAmount',
        'prepareDepositAmount', 'renderFundingAccount', 'renderFundingWei', 'renderWalletMethod', 'restoreWalletView',
        'stopFundingFlow', 'isFundingViewHydrating', 'attachPrivateBalanceHelp', 'capturePrivateBalanceHelpFocus',
        'privateBalanceExpiryLabel', 'privateBalanceExpired', 'privateBalanceGuide', 'privateBalanceHelpButton',
        'privateBalanceHelpContent', 'restorePrivateBalanceHelpFocus', 'updatePrivateBalanceExpiryState'];
    const calls = [];
    const context = {
        zkapiClient: client, addressFundingWallet: { pending: null }, getWalletMethod: () => 'metamask', walletMethodText: value => value,
        readWelcomeModalIntent: () => null, writeWelcomeModalIntent() {}, window: { sessionStorage, addEventListener() {} },
        document: { activeElement: null, getElementById: () => null }, setTimeout, clearTimeout, queueMicrotask,
        ...Object.fromEntries(names.map(name => [name, noop])),
        runAddressAction: async (owner, details, report, action) => action(),
        assertWithdrawalEscapeAvailable: async expected => { calls.push(['assert', expected]); }
    };
    const Account = vm.runInNewContext(`${source}\nAccountModal;`, context);
    const modal = Object.create(Account.prototype);
    Object.assign(modal, { busy: false, isOpen: true, view: 'withdrawals', withdrawMode: 'mutual',
        overlay: { querySelector: () => null, querySelectorAll: () => [] } });
    // No facade: each is empty, and none throws a ReferenceError.
    assert.equal(modal.refreshOtherVersionHistory(), undefined);
    assert.equal(JSON.stringify(modal.otherVersionPayments()), '[]');
    assert.equal(modal.otherVersionHistorySignature(), '');
    assert.equal(modal.expiryHistorySignature(), '');
    assert.equal(modal.renderBalanceExtras(null), '');
    assert.equal(modal.renderExitChoice(null), '');
    assert.equal(modal.operationRecheckRequired(), false);
    assert.deepEqual(JSON.parse(JSON.stringify(modal.recordExtras({ recordId: 'r' }))),
        { label: null, badge: null, noteHtml: '', actionsHtml: '', hideActions: false, hideError: false });
    assert.deepEqual({ ...modal.readExitChoice() }, { stale: false, choice: null, conceded: null, concededMax: null, bound: null });
    assert.equal(modal.openHistoryVersion('v1', 'finish_previous'), null);
    modal.attachHistoryOpen();
    assert.equal(modal.paymentTransactionUrl(`0x${'ab'.repeat(32)}`), `https://etherscan.io/tx/0x${'ab'.repeat(32)}`);
    assert.equal(modal.withdrawalRecordLabel({ phase: 'closed_unconfirmed', payoutCredited: true }), 'Payout held');
    // And a withdrawal starts exactly as before: nothing is re-verified.
    let details = null;
    modal.run = async (action, given) => { details = given; await action(() => {}); };
    client.withdraw = async () => ({ status: 'submitted' });
    return modal.submitWithdrawal().then(() => {
        assert.deepEqual(calls, []);
        assert.deepEqual(Object.keys(details).sort(), ['blocksSend', 'kind', 'phase', 'title']);
    });
});

// -- The edges of the row's extras -----------------------------------------------

test('a record that says its payout was verified and also held is held: the dialog never reads it as returned', t => {
    const page = shapesPage(t, 'withdrawals_alert_credited_defeated', { view: 'withdrawals' });
    const odd = ownRecords().find(record => record.noteId === 3);
    // The SDK never writes this combination; the row does not depend on that.
    odd.payoutVerified = true;
    zkapiClient.withdrawals = [odd];
    const row = rowOf(page.modal.renderWithdrawalRecords(), 3);
    assert.match(row, />Payout held</);
    assert.doesNotMatch(row, /returned to|Funds are in your wallet|badge-status-success/);
});

test('the second pill of a row sits with its status, and a helper’s buttons share the row’s own buttons', t => {
    const page = shapesPage(t, 'withdrawals_alert_credited_defeated', { view: 'withdrawals' });
    const row = bodyOf(rowOf(page.modal.renderWithdrawalRecords(), 2));
    const badge = row.querySelector('[data-zkapi-record-badge]');
    const status = row.querySelector('[data-background-progress]').parentNode;
    assert.equal(badge.parentNode, status.parentNode, 'one column of pills');
    assert.equal(badge.parentNode.children.length, 2);
    assert.equal(badge.parentNode.children[0], status);
    // A row that is still open keeps its own buttons, and a helper's join them
    // in the same flex row (a closed row gets one of its own).
    const ui = createVersionUi({ facade: page.facade });
    const real = ui.recordExtras.bind(ui);
    ui.recordExtras = (record, context) => ({ ...real(record, context),
        actionsHtml: `<button type="button" data-extra-action="${record.recordId}">Extra</button>` });
    page.facade.attachUi(ui);
    zkapiClient.withdrawals = [{ recordId: 'open-1', mode: 'escape', phase: 'ambiguous', finalBalance: 1_000_000,
        destination: `0x${'12'.repeat(20)}`, createdAt: 1_700_000_000_000 }];
    const open = bodyOf(page.modal.renderWithdrawalRecords());
    const extra = open.querySelector('[data-extra-action="open-1"]');
    assert.ok(extra);
    assert.ok(open.querySelector('[data-retry-finalization="open-1"]'), 'its own button is still there');
    assert.equal(extra.parentNode, open.querySelector('[data-retry-finalization="open-1"]').parentNode);
    zkapiClient.withdrawals = [{ recordId: 'closed-1', mode: 'escape', phase: 'closed', payoutVerified: true,
        finalBalance: 1_000_000, destination: `0x${'12'.repeat(20)}`, createdAt: 1_700_000_000_000 }];
    const closed = bodyOf(page.modal.renderWithdrawalRecords());
    assert.equal(closed.querySelector('[data-extra-action="closed-1"]').parentNode.className, 'mt-3 flex gap-2');
});

test('wiring:withdrawal-operation-recheck a withdrawal of a legacy page names no operation to its signer', async t => {
    // The prepared-withdrawal choice exists on the legacy protocol too. The
    // operation is bound only where the behavior is.
    const page = shapesPage(t, 'kit_never_exported', { view: 'withdraw', active: V1 });
    assert.equal(page.facade.operationRecheckRequired(), false);
    const started = startable(t, page, { prepared: true });
    page.modal.withdrawalEscapeIntent = availableWithdrawalEscape();
    page.modal.withdrawMode = 'escape';
    drawWithdraw(page);
    await page.modal.submitWithdrawal();
    assert.deepEqual(Object.keys(started.runs[0].details).sort(), ['blocksSend', 'kind', 'phase', 'title']);
    assert.deepEqual(started.events, ['init', 'reload', 'init', 'reload', 'settle', 'withdraw']);
    assert.deepEqual(started.withdrawals[0], { mode: 'escape',
        options: { destination: started.destination, expectedWithdrawalOperationId: 'withdraw-7' } });
});

// Every button of a row that acts on one withdrawal record tells the facade
// which record it acted on, so a refusal of a set-aside balance is never held
// against the balance in the wallet.
test('each button that acts on one record says which record, and nothing on the live balance', async t => {
    const destination = `0x${'12'.repeat(20)}`;
    const hash = char => `0x${char.repeat(64)}`;
    const base = { destination, finalBalance: 1_000_000, createdAt: 1_700_000_000_000 };
    const cases = [
        ['data-finalize-withdrawal', { recordId: 'finalize', mode: 'escape', phase: 'pending', challengeDeadline: 1, chainStatus: 'pending_withdrawal' }],
        ['data-sync-withdrawal', { recordId: 'sync', mode: 'mutual', phase: 'parked', backgroundWithdrawalReady: false }],
        ['data-recover-finalization', { recordId: 'recover', mode: 'escape', phase: 'awaiting_wallet' }],
        ['data-retry-finalization', { recordId: 'retry', mode: 'escape', phase: 'ambiguous' }],
        ['data-retry-dropped-finalization', { recordId: 'replace', mode: 'escape', phase: 'finalizing', chainStatus: 'pending_withdrawal',
            finalizeSubmissionOutcome: 'receipt_missing', finalizeTransactionHashes: [hash('a')],
            finalizeAttempts: [{ hash: hash('a'), from: destination, nonce: 3 }] }],
        ['data-retry-dropped-background-withdrawal', { recordId: 'background-replace', mode: 'mutual', phase: 'submitted_unconfirmed',
            chainStatus: 'active', startRecoveryPending: true, startSubmissionId: 'sub', startSubmissionFrom: destination, startSubmissionNonce: 4 }],
        ['data-cancel-background-preparation', { recordId: 'cancel', mode: 'mutual', phase: 'parked', backgroundPreparationCancelable: true }],
        ['data-resolve-challenged-finalization', { recordId: 'resolve', mode: 'escape', phase: 'finalizing', chainStatus: 'active',
            finalizeSubmissionId: 'sub' }],
        ['data-withdraw-background', { recordId: 'withdraw', mode: 'mutual', phase: 'parked', backgroundWithdrawalReady: true }],
        ['data-restore-withdrawal', { recordId: 'restore', mode: 'escape', phase: 'restored' }]
    ];
    const page = shapesPage(t, 'withdrawals_alert_credited_defeated', { view: 'withdrawals',
        withdrawals: cases.map(([, record]) => ({ ...base, ...record })) });
    const realConfirm = globalThis.confirm;
    globalThis.confirm = () => true;
    t.after(() => { globalThis.confirm = realConfirm; });
    const root = bodyOf('');
    page.modal.overlay = root;
    page.modal.render();
    const runs = [];
    page.modal.run = (action, details, attempt) => { runs.push({ details, attempt }); return Promise.resolve(); };
    for (const [attribute, record] of cases) {
        const button = root.querySelector(`[${attribute}="${record.recordId}"]`);
        assert.ok(button, `${attribute} is offered for ${record.recordId}`);
        runs.length = 0;
        button.click();
        assert.equal(runs.length, 1, attribute);
        assert.deepEqual(runs[0].attempt, { about: { recordId: record.recordId } }, attribute);
    }
});
