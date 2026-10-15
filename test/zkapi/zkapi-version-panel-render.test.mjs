import assert from 'node:assert/strict';
import test from 'node:test';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { installActiveVersion, resetActiveVersionForTests } from '../../chat/zkapi/versioning/activeVersion.mjs';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import { ZKAPI_UX_PROPOSALS } from '../../chat/zkapi/services/zkapiUxState.mjs';
import { SWITCH_HINT_KEY, UPGRADE_INTENT_KEY } from '../../chat/zkapi/versioning/switchProtocol.mjs';
import {
    NOW_MS, activatedRegistry, legacyClientSnapshot, mutated, normalizedSnapshot, partialRevertRegistry,
    resolvedTable, stuckEscapeNotice, validRegistry
} from './_registryFixtures.mjs';
import { createDocument } from './_miniDom.mjs';

// The real panels with local, inert browser dependencies (as the other panel
// tests do): no provider, wallet request or persistent storage is involved.
globalThis.localStorage = globalThis.sessionStorage = {
    getItem() { return null; }, setItem() {}, removeItem() {}
};
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', origin: 'http://localhost', href: 'http://localhost/funding/' };
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.document = {
    documentElement: { dataset: {} },
    getElementById: () => null,
    querySelector: () => null,
    createElement() {
        return {
            textContent: '',
            get innerHTML() {
                return String(this.textContent ?? '')
                    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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

const notices = await import('../../chat/zkapi/components/VersionNotices.js');
const {
    attachVersionNotices, buildVersionNotices, handleVersionAction, patchVersionNotices, renderVersionBadge,
    renderVersionBanner, resetVersionNoticeDismissals, versionHelp
} = notices;
const { createVersionUi, versionUi } = await import('../../chat/zkapi/versioning/ui.js');
const { createZkapiVersioning } = await import('../../chat/zkapi/versioning/index.js');
const { default: RightPanel } = await import('../../chat/zkapi/components/RightPanel.js');
const { default: PaymentModeRightPanel } = await import('../../chat/zkapi/components/PaymentModeRightPanel.js');
const { RightPanel: TicketRightPanel } = await import('../../chat/publicApi.js');
const { updateZkapiBalanceControl } = await import('../../chat/zkapi/components/ZkapiStateExperience.js');
const { privateBalanceHelpContent } = await import('../../chat/zkapi/components/PrivateBalanceHelp.js');
const { default: zkapiClient } = await import('@openanonymity/zkapi-browser-sdk/client');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY = 86_400;
const NOW_S = Math.floor(NOW_MS / 1000);
// activatedRegistry(): v1 exit-only (the previous version), v2 active.
const TABLE = resolvedTable(activatedRegistry(), 'mainnet');
const [V1, V2] = TABLE;
const FORMAT = date => date.toISOString().replace('.000Z', 'Z');

function selectionFor(version, overrides = {}) {
    return {
        version, reason: 'runtime_holds_note', slotOwner: version.id, open: {}, credits: {},
        foreignDeploymentId: null, depositBlock: null, draftDiscarded: false, slotKind: 'note', ...overrides
    };
}

function noteSnapshot(seconds, overrides = {}) {
    return normalizedSnapshot({
        hasNote: true, expiryTs: NOW_S + seconds, deadlines: [{ source: 'slot', expiryTs: NOW_S + seconds }],
        ...overrides
    });
}

// A VersionState from the real derivation (never hand-built), v1 by default.
function derive(overrides = {}) {
    const active = overrides.active || V1;
    return deriveVersionState({
        table: overrides.table || TABLE,
        active,
        target: overrides.target === undefined ? (overrides.table || TABLE).find(row => row.status === 'active') || null
            : overrides.target,
        selection: selectionFor(active),
        snapshot: noteSnapshot(20 * DAY),
        intent: null,
        previewSelection: null,
        now: NOW_MS,
        busy: false,
        admissionClosed: false,
        buildClosed: false,
        configBlock: false,
        unreachable: false,
        adapter: getAdapter(active.adapter),
        ...overrides
    });
}

const holderWith = (seconds, overrides = {}) => derive({ snapshot: noteSnapshot(seconds), ...overrides });
const banner = (state, options = {}) => renderVersionBanner(state, {
    surface: 'panel', table: TABLE, formatter: FORMAT, ...options
});

// ---------------------------------------------------------------------------
// A small DOM over rendered markup, for the patch and the click delegation:
// the shared one (attribute selectors, dataset, textContent, classList, bubbling
// clicks), which parses what the renderers wrote.
// ---------------------------------------------------------------------------

const markupDocument = createDocument();
function parseHtml(html) {
    const root = markupDocument.createElement('div');
    root.innerHTML = html;
    return root;
}

// ---------------------------------------------------------------------------
// The facade, faked: the surface the panels and the UI helpers consume.
// ---------------------------------------------------------------------------

function fakeFacade({ state = null, selection = null, flags = {} } = {}) {
    const listeners = new Set();
    const calls = { switches: [], discards: 0, acknowledged: [], states: 0 };
    const facade = {
        multiVersion: true,
        table: TABLE,
        selection: selection || selectionFor(V1),
        current: state,
        flagValues: { draftDiscarded: false, discardLoop: false, admissionClosed: false, staleBuild: false,
            configMismatch: false, ...flags },
        reminderTier: null,
        calls,
        state() { calls.states += 1; return facade.current; },
        flags() { return facade.flagValues; },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        emit() { for (const listener of [...listeners]) listener(facade.current); },
        requestSwitch(input) { calls.switches.push(input); return facade.switchResult || { ok: true }; },
        async discardUnsentDeposit() { calls.discards += 1; return facade.discardResult || { discarded: true }; },
        lastReminderTier() { return facade.reminderTier; },
        acknowledgeReminder(tier) { calls.acknowledged.push(tier); facade.reminderTier = tier; },
        ui: null
    };
    facade.ui = createVersionUi({ facade });
    return facade;
}

const escapeHtml = value => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function installFacade(t, facade) {
    const previous = zkapiClient.oaVersioning;
    zkapiClient.oaVersioning = facade;
    t.after(() => {
        if (previous === undefined) delete zkapiClient.oaVersioning;
        else zkapiClient.oaVersioning = previous;
    });
}

function snapshotOf(overrides = {}) {
    return {
        config: { ux_proposal: 'quiet' },
        wallet: { note: {
            note_id: 7, deposit_amount: 2_000_000, current_balance: 1_610_000,
            // 24 h and 15 min, not 24 h: two renders a few milliseconds apart
            // must read the same hour, whichever way the countdown rounds.
            expiry_ts: Math.floor(Date.now() / 1000) + 86400 + 900
        } },
        withdrawal: null, withdrawals: [], activities: [], lastError: null, loading: false,
        ...overrides
    };
}

function renderPanel({ transition = null, helpOpen = {}, ...overrides } = {}) {
    Object.assign(zkapiClient, snapshotOf(overrides));
    const panel = Object.create(RightPanel.prototype);
    panel.currentSession = { id: 'new-chat' };
    panel.privateBalanceHelpOpen = helpOpen;
    panel.app = { integration: {
        getTransition: () => transition,
        getSessionUsageSummary: () => ({ hasEstimate: true, estimatedCostUsd: 0.0883,
            promptTokens: 8922, completionTokens: 3829 })
    } };
    panel.escapeHtml = escapeHtml;
    return { panel, html: panel.billingSectionHTML() };
}

// ---------------------------------------------------------------------------
// The pill
// ---------------------------------------------------------------------------

test('the pill exists only where there are versions to tell apart, and names the version held', () => {
    const state = holderWith(30 * DAY);
    const html = renderVersionBadge(state, { surface: 'panel' });
    // The pill names the zkAPI protocol version, not the registry label.
    assert.match(html, /data-zkapi-version-badge[^>]*data-zkapi-version-tone="muted"[^>]*>zkAPI v0\.1<\/span>/);
    // The `?` is a tooltip: no help toggle, nothing that opens.
    assert.match(html, /aria-label="The zkAPI protocol version this balance uses"/);
    assert.doesNotMatch(html, /data-zkapi-help=|aria-expanded|aria-controls/);
    assert.match(renderVersionBadge(state, { surface: 'dialog', helpOpen: true }), />zkAPI v0\.1<\/span>/);
    // A row without a protocol version falls back to its label.
    const unlabelled = { ...state, current: { ...state.current, protocolVersion: null } };
    assert.match(renderVersionBadge(unlabelled, { surface: 'panel' }), />Version 1<\/span>/);

    // A lone exit-only version has a closed gate but no pill (show is false).
    const lone = resolvedTable(partialRevertRegistry(), 'mainnet');
    assert.equal(lone.filter(row => row.status !== 'retired').length, 1);
    const loneState = derive({ table: lone, active: lone[0], target: null });
    assert.equal(loneState.show, false);
    assert.equal(renderVersionBadge(loneState, { surface: 'panel' }), '');
    for (const bad of [null, undefined, {}, 'x', { show: true }]) {
        assert.equal(renderVersionBadge(bad, { surface: 'panel' }), '');
    }
});

test('the pill is always muted: it names a protocol, it does not prompt', () => {
    for (const seconds of [40 * DAY, 20 * DAY, 16 * DAY, 8 * DAY, 2 * DAY]) {
        const html = renderVersionBadge(holderWith(seconds), { surface: 'panel' });
        assert.match(html, /data-zkapi-version-tone="muted"/, `${seconds / DAY} days`);
        assert.doesNotMatch(html, /bg-amber-100/);
    }
});

test('the version help says which version the balance is on, and what an upgrade is', () => {
    const previous = versionHelp('version', holderWith(30 * DAY), { table: TABLE });
    assert.equal(previous.title, 'About versions');
    assert.match(previous.body, /Your balance is on version 1\./);
    assert.match(previous.body, /new deposits go to version 2/);
    assert.match(previous.body, /withdraw your balance and deposit again/);
    const current = versionHelp('version', derive({ active: V2, selection: selectionFor(V2) }), { table: TABLE });
    assert.match(current.body, /Your balance is on version 2, the latest version\./);
    assert.equal(versionHelp('billing', holderWith(DAY)), null);
    assert.match(versionHelp('version').body, /can’t move between versions/);
    // The disclosure is the shared help content, with the state's words.
    const content = privateBalanceHelpContent('panel', 'version', true, previous);
    assert.match(content, /id="zkapi-panel-version-help" data-zkapi-help-content="version" >/);
    assert.match(content, /Your balance is on version 1\./);
});

// ---------------------------------------------------------------------------
// The banner, by phase
// ---------------------------------------------------------------------------

test('a day-0 balance gets no note at all; the prompt window brings the button', () => {
    // "A newer version is available" is not shown: the pill says which
    // protocol the balance is on and nothing asks the person to act yet.
    assert.equal(banner(holderWith(30 * DAY)), '');

    const soon = banner(holderWith(16 * DAY));
    assert.match(soon, /Upgrade to version 2 by 2026-11-28T12:00:00Z\./);
    assert.match(soon, /border-amber-300\/60 bg-amber-50\/60 text-amber-800 dark:border-amber-500\/30/);
    assert.match(soon, /zkapi-version-action--primary" data-zkapi-version-action="upgrade">Upgrade balance</);
});

test('reminder tiers use the canonical words and keep the close-by date machine-readable', () => {
    const cases = [
        [8 * DAY, 7, /^7 days left to upgrade\. Withdraw by 2026-11-20T12:00:00Z\.$/],
        [5 * DAY, 3, /^3 days left to upgrade\. Withdraw by 2026-11-17T12:00:00Z\.$/],
        [3.5 * DAY, 1, /^Less than a day left to upgrade\. Withdraw now to get your unused balance back\.$/],
        [2 * DAY, 0, /^Upgrade now\. Withdrawals can take a while to confirm\. After 2026-11-17T12:00:00Z, the service treasury can claim your full original deposit, and nothing is refunded\.$/]
    ];
    for (const [seconds, tier, pattern] of cases) {
        const state = holderWith(seconds);
        assert.equal(state.reminderTier, tier);
        const html = banner(state);
        const root = parseHtml(html);
        const text = root.querySelector('[data-zkapi-version-text="0"]');
        assert.match(text.textContent, pattern);
        assert.equal(text.dataset.zkapiVersionTier, String(tier));
        assert.equal(text.dataset.zkapiVersionCloseby, String(state.closeByTs));
    }
});

test('an empty balance, a current balance and an expired one get no upgrade prompt', () => {
    const empty = derive({ snapshot: normalizedSnapshot() });
    assert.equal(empty.upgrade.available, false);
    assert.doesNotMatch(banner(empty), /data-zkapi-version-action="upgrade"/);
    const onTarget = derive({ active: V2, selection: selectionFor(V2), snapshot: noteSnapshot(5 * DAY) });
    assert.equal(banner(onTarget), '');
    const expired = holderWith(-DAY);
    assert.equal(expired.phase, 'expired');
    assert.doesNotMatch(banner(expired), /data-zkapi-version-action="upgrade"/);
});

test('a lone exit-only version explains its closed gate without a pill or a target', () => {
    const lone = resolvedTable(partialRevertRegistry(), 'mainnet');
    const state = derive({ table: lone, active: lone[0], target: null, snapshot: normalizedSnapshot() });
    assert.equal(state.show, false);
    assert.equal(state.gate.code, 'deposits_closed');
    assert.equal(state.target, null);
    const html = banner(state, { table: lone });
    assert.match(html, /Version 1 no longer accepts new deposits\./);
    assert.doesNotMatch(html, /Deposits moved to/);
    assert.doesNotMatch(html, /data-zkapi-version-action/);
});

test('a withdrawal finishing elsewhere, a payout and an other-tab move each get their own notice', () => {
    const open = { v1: [{ recordId: 'r1', noteId: 3, mode: 'mutual', phase: 'closed_unconfirmed', expiryTs: null }] };
    // This page is on v2, v1 has an open withdrawal: open v1 to finish it.
    const previous = derive({ active: V2, selection: selectionFor(V2, { open, slotOwner: null, reason: 'no_runtime_note', slotKind: 'empty' }),
        snapshot: normalizedSnapshot() });
    assert.equal(previous.phase, 'finish-previous-withdrawal');
    assert.equal(previous.previous.canOpen, true);
    let html = banner(previous);
    assert.match(html, /A withdrawal from version 1 is still finishing\. Open version 1 to finish it, then come back to deposit\./);
    assert.match(html, /data-zkapi-version-action="open-previous">Open version 1</);

    // While this page's own balance holds the wallet, the other version can
    // not be opened: no button, and the words say to withdraw first.
    const blocked = derive({ active: V2, selection: selectionFor(V2, { open }), snapshot: noteSnapshot(20 * DAY) });
    assert.equal(blocked.previous.canOpen, false);
    html = banner(blocked);
    assert.match(html, /withdraw your current balance first, then open version 1/);
    assert.doesNotMatch(html, /data-zkapi-version-action/);

    const credits = { v1: [{ recordId: 'c1', noteId: 4, creditedAmount: '5', destination: null }] };
    const credit = derive({ active: V2, selection: selectionFor(V2, { credits, slotOwner: null, reason: 'no_runtime_note', slotKind: 'empty' }),
        snapshot: normalizedSnapshot() });
    assert.equal(credit.phase, 'claim-previous-credit');
    html = banner(credit);
    assert.match(html, /A payout from version 1 is ready to claim\. Open version 1 to claim it\. This does not stop new deposits\./);
    assert.match(html, /data-zkapi-version-action="claim-credit">Open version 1</);
});

test('a reload notice follows the reason, names where the reload goes and obeys canReload', () => {
    const preview = (version, reason, overrides = {}) => selectionFor(version, {
        reason, slotOwner: reason === 'runtime_holds_note' ? version.id : null,
        slotKind: reason === 'runtime_holds_note' ? 'note' : 'empty', ...overrides
    });
    const moved = derive({ snapshot: noteSnapshot(20 * DAY), previewSelection: preview(V2, 'runtime_holds_note') });
    assert.equal(moved.phase, 'reload-required');
    assert.equal(moved.reload.reason, 'moved_in_other_tab');
    assert.match(banner(moved), /This browser’s balance moved to version 2 in another tab\. Reload to keep going\./);
    assert.match(banner(moved), /data-zkapi-version-action="reload">Reload</);

    const withdrawn = derive({ snapshot: normalizedSnapshot(), previewSelection: preview(V2, 'no_runtime_note'),
        intent: { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawn', since: NOW_MS } });
    assert.equal(withdrawn.reload.reason, 'upgrade_withdrawn');
    assert.match(banner(withdrawn, { withdrawalConfirmed: true }),
        /Withdrawal confirmed\. Your balance is back in your wallet\. Reload to deposit into version 2\./);

    // An empty wallet with no upgrade intent could equally be an archived
    // expired balance: deposits moved, and nothing is said about a withdrawal.
    const finished = derive({ snapshot: normalizedSnapshot(), previewSelection: preview(V2, 'no_runtime_note') });
    assert.equal(finished.reload.reason, 'previous_withdrawal_finished');
    assert.match(banner(finished), /Deposits moved to version 2\. This page is on version 1, which no longer accepts new deposits\. Reload to deposit into version 2\./);
    assert.doesNotMatch(banner(finished), /Withdrawal confirmed/);

    const cleared = derive({ snapshot: normalizedSnapshot(),
        selection: selectionFor(V1, { slotKind: 'draft_only' }), previewSelection: preview(V2, 'no_runtime_note') });
    assert.equal(cleared.reload.reason, 'draft_cleared');
    assert.match(banner(cleared), /Cleared an unused deposit quote\. Nothing was spent\./);
    // The button is explained too: why Reload matters is not left unsaid.
    const clearedRoot = parseHtml(banner(cleared));
    assert.equal(clearedRoot.querySelectorAll('[data-zkapi-version-text]').length, 2);
    assert.match(clearedRoot.querySelector('[data-zkapi-version-text="1"]').textContent,
        /^Deposits moved to version 2\. This page is on version 1, which no longer accepts new deposits\. Reload to deposit into version 2\.$/);

    // Work in flight: the button exists but cannot be pressed, and says why.
    const busy = derive({ snapshot: noteSnapshot(20 * DAY), previewSelection: preview(V2, 'runtime_holds_note'), busy: true });
    assert.equal(busy.reload.canReload, false);
    const root = parseHtml(banner(busy));
    const button = root.querySelector('[data-zkapi-version-action="reload"]');
    assert.equal(button.disabled, true);
    assert.match(root.textContent, /Finish the current step first\./);
    // The reason is visible text and the button points at it.
    const hint = root.querySelector('#zkapi-version-hint-panel-reload');
    assert.equal(button.getAttribute('aria-describedby'), 'zkapi-version-hint-panel-reload');
    assert.equal(hint.textContent, 'Finish the current step first.');
});

test('retirement, foreign slots and an unreadable wallet are told apart, with no deployment ids', () => {
    const foreign = derive({ active: V2, selection: selectionFor(V2, { reason: 'unknown_deployment', slotOwner: null,
        depositBlock: 'foreign_runtime', foreignDeploymentId: 'zkapi-some-other-deployment-v9' }), snapshot: normalizedSnapshot() });
    assert.equal(foreign.gate.code, 'foreign_runtime');
    let html = banner(foreign);
    assert.match(html, /This browser holds a saved balance that this page can’t open\./);
    assert.match(html, /data-zkapi-version-action="reload"/);
    assert.doesNotMatch(html, /zkapi-some-other-deployment/);

    html = banner(foreign, { retired: true });
    assert.match(html, /a version that has been retired and can’t be opened here/);
    assert.doesNotMatch(html, /Nothing is lost/);
    assert.doesNotMatch(html, /data-zkapi-version-action="reload"/);

    const unreadable = derive({ active: V2, selection: selectionFor(V2, { reason: 'holdings_unreadable', slotOwner: null,
        depositBlock: 'holdings_unreadable' }), snapshot: normalizedSnapshot() });
    html = banner(unreadable);
    assert.match(html, /We could not read your saved balance\. Reload to try again\. Nothing was changed\./);
    assert.match(html, /data-zkapi-version-action="reload"/);

    const stale = derive({ active: V2, selection: selectionFor(V2), snapshot: normalizedSnapshot(), buildClosed: true });
    assert.match(banner(stale), /Reload to update before depositing\./);
});

test('service pause, retiring admission and an unsent plan', () => {
    // The SDK's own message (and any markup or address in it) is never shown:
    // a pause is told in the host's words, by the service code.
    const paused = derive({ snapshot: noteSnapshot(20 * DAY, { service: { available: false, message: 'Maintenance <b>now</b>' } }) });
    assert.equal(paused.phase, 'service-paused');
    let html = banner(paused);
    assert.doesNotMatch(html, /Maintenance|&lt;b&gt;|<b>/);
    assert.match(html, /Private access is paused right now\. You can still withdraw your balance\./);
    // A pause never offers to upgrade or reload: nothing about it is a version move.
    assert.doesNotMatch(html, /data-zkapi-version-action="(?:upgrade|reload|open-previous)"/);

    const coded = derive({ snapshot: noteSnapshot(20 * DAY, { service: {
        available: false, code: 'deployment_manifest_unavailable',
        message: 'Unable to load https://operator.example/config.json (404)'
    } }) });
    html = banner(coded);
    assert.match(html, /The private service can’t be reached right now, so new chats and deposits are paused\. You can still withdraw your balance\./);
    assert.doesNotMatch(html, /operator\.example|404/);
    assert.match(banner(coded, { surface: 'dialog' }), /The private service can’t be reached/);

    const long = derive({ snapshot: noteSnapshot(20 * DAY, { service: { available: false, message: 'x'.repeat(600) } }) });
    const text = parseHtml(banner(long)).querySelector('[data-zkapi-version-text="0"]').textContent;
    assert.doesNotMatch(text, /xxxx/);
    assert.ok(text.length <= 280, `bounded, got ${text.length}`);

    const closed = holderWith(20 * DAY, { admissionClosed: true });
    assert.equal(closed.phase, 'admission-closed');
    html = banner(closed);
    assert.match(html, /Version 1 is no longer starting new chats\. Withdraw your balance, then deposit into version 2 to keep chatting\./);
    assert.match(html, /data-zkapi-version-action="upgrade"/);

    const unsent = derive({ snapshot: normalizedSnapshot({ hasUnsentPrepared: true }), selection: selectionFor(V1, { slotKind: 'unsent_prepared' }) });
    assert.equal(unsent.unsent, true);
    html = banner(unsent);
    assert.match(html, /You have an unfinished deposit that was never sent\. It can’t be finished on version 1\./);
    assert.match(html, /data-zkapi-version-action="cancel-unsent">Cancel unfinished deposit</);
});

test('a started deposit finishes first; chat settling holds the upgrade without hiding it', () => {
    const started = holderWith(16 * DAY, { snapshot: noteSnapshot(16 * DAY, { hasPendingDeposit: true }) });
    assert.equal(started.upgrade.blockedBy, 'pending_deposit');
    let html = banner(started);
    assert.match(html, /Your saved deposit can still be finished here\./);
    assert.doesNotMatch(html, /data-zkapi-version-action="upgrade"/);

    const busy = holderWith(16 * DAY, { busy: true });
    assert.equal(busy.upgrade.blockedBy, 'in_flight');
    const root = parseHtml(banner(busy));
    assert.equal(root.querySelector('[data-zkapi-version-action="upgrade"]').disabled, true);
});

test('the upgrade stages: withdrawing, deposit and done', () => {
    const withdrawing = derive({ snapshot: noteSnapshot(20 * DAY, { hasPreparedWithdrawal: true }),
        intent: { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawing', since: NOW_MS } });
    assert.equal(withdrawing.phase, 'withdrawing');
    assert.match(banner(withdrawing), /Withdrawal in progress\. Once it is confirmed, reload to deposit into version 2\./);

    const deposit = derive({ active: V2, selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }),
        snapshot: normalizedSnapshot(),
        intent: { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawn', since: NOW_MS } });
    assert.equal(deposit.upgrade.stage, 'deposit');
    const html = banner(deposit);
    assert.match(html, /Your balance is withdrawn\. Deposit to finish upgrading to version 2\./);
    assert.match(html, /data-zkapi-version-action="upgrade">Continue upgrade</);

    const done = derive({ active: V2, selection: selectionFor(V2), snapshot: noteSnapshot(20 * DAY),
        intent: { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'depositing', since: NOW_MS } });
    assert.equal(done.upgrade.stage, 'done');
    resetVersionNoticeDismissals();
    assert.match(banner(done), /Upgrade complete\. Your balance is on version 2\./);
    // Dismissed once, gone on every surface until the page reloads.
    notices.dismissVersionNotice('done');
    assert.equal(banner(done), '');
    resetVersionNoticeDismissals();
});

test('session flags: a cleared draft is dismissible, a discard loop says to close other tabs', () => {
    resetVersionNoticeDismissals();
    const state = derive({ active: V2, selection: selectionFor(V2), snapshot: normalizedSnapshot() });
    const flags = { draftDiscarded: true, discardLoop: true };
    const html = banner(state, { flags });
    assert.match(html, /Cleared an unused deposit quote\. Nothing was spent\./);
    assert.match(html, /data-zkapi-version-action="dismiss">Dismiss</);
    assert.match(html, /Close other open tabs of this app, then reload\./);
    notices.dismissVersionNotice('draft');
    assert.doesNotMatch(banner(state, { flags }), /Cleared an unused/);
    resetVersionNoticeDismissals();
});

test('ticket mode shows only what puts funds at risk, never a neutral note', () => {
    const neutral = holderWith(30 * DAY);
    assert.equal(banner(neutral, { surface: 'ticket' }), '');
    assert.match(banner(holderWith(16 * DAY), { surface: 'ticket' }), /data-zkapi-version-banner="ticket"/);
    assert.match(banner(holderWith(2 * DAY), { surface: 'ticket' }), /Upgrade now\./);
    const paused = derive({ snapshot: noteSnapshot(20 * DAY, { service: {
        available: false, code: 'deployment_manifest_unavailable', message: 'Paused'
    } }) });
    assert.equal(banner(paused, { surface: 'ticket' }), '');
    assert.equal(banner(paused, { surface: 'panel' }) !== '', true);
});

test('banners never speak ids, note numbers or emoji, and are static text', () => {
    const states = [holderWith(30 * DAY), holderWith(8 * DAY), holderWith(2 * DAY),
        derive({ snapshot: noteSnapshot(20 * DAY), previewSelection: selectionFor(V2, { reason: 'runtime_holds_note' }) }),
        derive({ active: V2, selection: selectionFor(V2, { reason: 'unknown_deployment', slotOwner: null, depositBlock: 'foreign_runtime',
            foreignDeploymentId: 'zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930' }), snapshot: normalizedSnapshot() })];
    for (const state of states) {
        for (const surface of ['panel', 'dialog', 'ticket']) {
            const html = banner(state, { surface });
            assert.doesNotMatch(html, /nullifier|vault|circuit|deployment|note #|noteId|0x[0-9a-f]{8}/i);
            assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
            assert.doesNotMatch(html, /aria-live|role="(?:status|alert)"/);
            assert.doesNotMatch(html, /\bautofocus\b|tabindex/);
        }
    }
    // The upgrade is never described as unlinkable.
    assert.doesNotMatch(banner(holderWith(8 * DAY)), /unlinkable|anonymous/i);
});

test('host markup follows the notices inside the same block, and alone it is still a block', () => {
    const state = holderWith(30 * DAY);
    const html = banner(state, { extra: '<p data-protocol-notice>Exit kit out of date</p>' });
    // The day-0 note is not shown, so the host's markup stands alone.
    assert.match(html, /data-zkapi-version-sig="\|\+"/);
    assert.match(html, /data-protocol-notice/);
    const prompted = banner(holderWith(16 * DAY), { extra: '<p data-protocol-notice>Exit kit out of date</p>' });
    assert.ok(prompted.indexOf('data-zkapi-version-notice') < prompted.indexOf('data-protocol-notice'));
    const quiet = derive({ active: V2, selection: selectionFor(V2), snapshot: normalizedSnapshot() });
    assert.equal(banner(quiet), '');
    assert.match(banner(quiet, { extra: '<p>x</p>' }), /data-zkapi-version-banner="panel"[^>]*><p>x<\/p><\/div>/);
});

// ---------------------------------------------------------------------------
// The clock patch
// ---------------------------------------------------------------------------

function mounted(state, { surface = 'panel', badgeSurface = 'panel', options = {} } = {}) {
    const html = `${renderVersionBadge(state, { surface: badgeSurface })}${renderVersionBanner(state, {
        surface, table: TABLE, formatter: FORMAT, ...options })}`;
    return parseHtml(html);
}

test('a clock tick with nothing crossed changes nothing and asks for no render', () => {
    const state = holderWith(8 * DAY);
    const root = mounted(state);
    const before = root.children.map(child => child.textContent).join('|');
    const result = patchVersionNotices(root, state, { now: NOW_MS + 1000, table: TABLE, formatter: FORMAT });
    assert.deepEqual(result, { needsRender: false });
    assert.equal(root.children.map(child => child.textContent).join('|'), before);
});

test('crossing a boundary asks for one render and touches nothing', () => {
    const state = holderWith(8 * DAY);
    const root = mounted(state);
    const later = holderWith(5 * DAY);   // tier 7 -> tier 3, same structure
    const sameStructure = patchVersionNotices(root, later, { table: TABLE, formatter: FORMAT });
    // Same notice, same tone, same button: the words are patched in place.
    assert.equal(sameStructure.needsRender, false);
    assert.match(root.querySelector('[data-zkapi-version-text="0"]').textContent, /^3 days left to upgrade\./);
    assert.equal(root.querySelector('[data-zkapi-version-text="0"]').dataset.zkapiVersionTier, '3');

    const reloadState = derive({ snapshot: noteSnapshot(20 * DAY), previewSelection: selectionFor(V2, { reason: 'runtime_holds_note' }) });
    const texts = root.querySelectorAll('[data-zkapi-version-text]').map(node => node.textContent);
    const changed = patchVersionNotices(root, reloadState, { table: TABLE, formatter: FORMAT });
    assert.equal(changed.needsRender, true);
    assert.deepEqual(root.querySelectorAll('[data-zkapi-version-text]').map(node => node.textContent), texts,
        'nothing is touched when a render is asked for');
});

test('entering the prompt window re-renders; the pill never changes tone', () => {
    const outside = holderWith(20 * DAY);
    const root = mounted(outside);
    const inside = holderWith(16 * DAY);
    // Outside the window there is no note; inside it a prominent one appears.
    assert.equal(patchVersionNotices(root, inside, { table: TABLE, formatter: FORMAT }).needsRender, true);

    const matching = parseHtml(`${renderVersionBadge(outside, { surface: 'panel' })}${banner(inside)}`);
    const pill = matching.querySelector('[data-zkapi-version-badge]');
    assert.equal(pill.dataset.zkapiVersionTone, 'muted');
    const result = patchVersionNotices(matching, inside, { table: TABLE, formatter: FORMAT });
    assert.deepEqual(result, { needsRender: false });
    assert.equal(pill.dataset.zkapiVersionTone, 'muted');
    assert.equal(pill.classList.contains('bg-amber-100'), false);
    assert.equal(pill.textContent, 'zkAPI v0.1');
});

test('presence mismatches are structural: pill or banner appearing and disappearing', () => {
    const target = derive({ active: V2, selection: selectionFor(V2), snapshot: noteSnapshot(30 * DAY) });
    const empty = parseHtml('');
    assert.equal(patchVersionNotices(empty, target, {}).needsRender, true, 'a pill is called for, none mounted');
    const pillOnly = parseHtml(renderVersionBadge(target, { surface: 'panel' }));
    assert.equal(patchVersionNotices(pillOnly, target, {}).needsRender, false);
    const hidden = { ...target, show: false };
    assert.equal(patchVersionNotices(pillOnly, hidden, {}).needsRender, true, 'a pill is mounted that is no longer called for');
    assert.equal(patchVersionNotices(null, target, {}).needsRender, false);
    assert.equal(patchVersionNotices({}, target, {}).needsRender, false);
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

test('upgrade opens the upgrade view through the existing payment event, nothing else', async () => {
    const events = [];
    const facade = fakeFacade({ state: holderWith(8 * DAY) });
    const result = await handleVersionAction('upgrade', { facade, dispatch: (name, detail) => events.push([name, detail]) });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(events, [['zkapi-payment-required', { view: 'upgrade' }]]);
    assert.deepEqual(facade.calls.switches, []);
    assert.equal(facade.calls.discards, 0);
});

test('reload goes through the facade with the state’s own reason, never without canReload', async () => {
    const reloads = [];
    const moved = derive({ snapshot: noteSnapshot(20 * DAY), previewSelection: selectionFor(V2, { reason: 'runtime_holds_note' }) });
    const facade = fakeFacade({ state: moved });
    assert.deepEqual(await handleVersionAction('reload', { facade, reload: () => reloads.push('plain') }), { ok: true });
    assert.deepEqual(facade.calls.switches, [{ reason: 'moved_in_other_tab', view: null }]);
    assert.deepEqual(reloads, []);

    // After an upgrade's withdrawal the fund view is where the person lands,
    // except from OA mode.
    const withdrawn = derive({ snapshot: normalizedSnapshot(), previewSelection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }),
        intent: { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawn', since: NOW_MS } });
    const upgrade = fakeFacade({ state: withdrawn });
    await handleVersionAction('reload', { facade: upgrade, withdrawalConfirmed: true });
    assert.deepEqual(upgrade.calls.switches, [{ reason: 'upgrade_withdrawn', view: 'fund' }]);
    const ticket = fakeFacade({ state: withdrawn });
    await handleVersionAction('reload', { facade: ticket, surface: 'ticket', withdrawalConfirmed: true });
    assert.deepEqual(ticket.calls.switches, [{ reason: 'upgrade_withdrawn', view: null }]);

    // Busy: refused, said in words, nothing reloaded.
    const busy = derive({ snapshot: noteSnapshot(20 * DAY), previewSelection: selectionFor(V2, { reason: 'runtime_holds_note' }), busy: true });
    const spoken = [];
    const blocked = fakeFacade({ state: busy });
    assert.deepEqual(await handleVersionAction('reload', { facade: blocked, notify: text => spoken.push(text), reload: () => reloads.push('x') }),
        { ok: false, why: 'busy' });
    assert.deepEqual(spoken, ['Finish the current step first.']);
    assert.deepEqual(blocked.calls.switches, []);
    assert.deepEqual(reloads, []);

    // A loop is refused by the facade; the person is told, the page stays.
    const looping = fakeFacade({ state: moved });
    looping.switchResult = { ok: false, why: 'loop' };
    const loopSpoken = [];
    await handleVersionAction('reload', { facade: looping, notify: text => loopSpoken.push(text), reload: () => reloads.push('loop') });
    assert.deepEqual(loopSpoken, ['Close other open tabs of this app, then reload.']);
    assert.deepEqual(reloads, []);
});

test('a reload with no switch reason (a stale build, an unreadable wallet) is a plain reload on a click', async () => {
    const reloads = [];
    const stale = derive({ active: V2, selection: selectionFor(V2), snapshot: normalizedSnapshot(), buildClosed: true });
    const facade = fakeFacade({ state: stale });
    assert.deepEqual(await handleVersionAction('reload', { facade, reload: () => reloads.push(1) }), { ok: true });
    assert.deepEqual(reloads, [1]);
    assert.deepEqual(facade.calls.switches, []);
});

test('open-previous and claim-credit reload into the other version; cancel-unsent clears a never-sent plan', async () => {
    const facade = fakeFacade({ state: holderWith(8 * DAY) });
    await handleVersionAction('open-previous', { facade });
    await handleVersionAction('claim-credit', { facade, surface: 'ticket' });
    assert.deepEqual(facade.calls.switches, [
        { reason: 'finish_previous', view: 'withdrawals' },
        { reason: 'claim_credit', view: null }
    ]);
    assert.deepEqual(await handleVersionAction('cancel-unsent', { facade }), { ok: true });
    assert.equal(facade.calls.discards, 1);
    facade.discardResult = { discarded: false, why: 'lock_busy' };
    const spoken = [];
    const failed = await handleVersionAction('cancel-unsent', { facade, notify: text => spoken.push(text) });
    assert.equal(failed.ok, false);
    assert.deepEqual(spoken, ['Close other open tabs of this app, then reload.']);
    assert.equal((await handleVersionAction('nope', { facade })).ok, false);
});

test('the buttons are wired by delegation on the banner and ignore disabled ones', async () => {
    const state = holderWith(2 * DAY);
    const root = mounted(state);
    const events = [];
    attachVersionNotices(root, { facade: () => fakeFacade({ state }), dispatch: (name, detail) => events.push([name, detail]) });
    attachVersionNotices(root, { dispatch: () => events.push('second binding') });
    const button = root.querySelector('[data-zkapi-version-action="upgrade"]');
    button.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, [['zkapi-payment-required', { view: 'upgrade' }]], 'bound once, not twice');

    const busy = holderWith(16 * DAY, { busy: true });
    const busyRoot = mounted(busy);
    const busyEvents = [];
    attachVersionNotices(busyRoot, { facade: () => fakeFacade({ state: busy }), dispatch: (...args) => busyEvents.push(args) });
    busyRoot.querySelector('[data-zkapi-version-action="upgrade"]').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(busyEvents, []);
});

// ---------------------------------------------------------------------------
// The composed helpers (ui.js)
// ---------------------------------------------------------------------------

test('versionUi keeps its member names and fills facts the caller does not pass', () => {
    for (const name of ['badge', 'banner', 'patch', 'help', 'upgradeView', 'depositsClosedView', 'protocolNotices']) {
        assert.equal(typeof versionUi[name], 'function', name);
    }
    assert.equal(versionUi.protocolNotices(), '');
    const state = derive({ active: V2, selection: selectionFor(V2, { reason: 'unknown_deployment', slotOwner: null,
        depositBlock: 'foreign_runtime' }), snapshot: normalizedSnapshot() });
    const facade = fakeFacade({ state, selection: selectionFor(V1, { reason: 'retired_deployment' }) });
    const html = facade.ui.banner(state, { surface: 'panel', now: NOW_MS });
    assert.match(html, /that has been retired/, 'retired comes from the facade selection');
    const withFlags = fakeFacade({ state, flags: { draftDiscarded: true } });
    assert.match(withFlags.ui.banner(state, { surface: 'dialog', now: NOW_MS }), /Cleared an unused deposit quote/);
    // help without a state reads the facade's.
    const helped = fakeFacade({ state: holderWith(8 * DAY) });
    assert.match(helped.ui.help('version').body, /Your balance is on version 1\./);
    assert.match(fakeFacade({ state: null }).ui.help('version').body, /can’t move between versions/);
    // Host markup reaches the banner through protocolNotices.
    const extended = createVersionUi({ facade, protocolNotices: () => '<p data-extra>kit</p>' });
    assert.match(extended.banner(derive({ active: V2, selection: selectionFor(V2), snapshot: normalizedSnapshot() }), { surface: 'panel' }), /data-extra/);
    // A failing facade or notices hook leaves the plain renderers.
    const broken = createVersionUi({ facade: { get table() { throw new Error('x'); }, get selection() { throw new Error('x'); },
        flags() { throw new Error('x'); } }, protocolNotices: () => { throw new Error('x'); } });
    assert.match(broken.banner(holderWith(8 * DAY), { surface: 'panel' }), /7 days left/);
});

test('the rescue helpers load the funding-address module only when used', async () => {
    let loads = 0;
    const calls = [];
    const module = {
        createScopedFundingProvider: (version, deps) => ({ ensureAddress: async () => { calls.push(['ensure', version.id, deps]); return { address: '0x1' }; } }),
        listRetiredScopes: async options => { calls.push(['list', options.table.length]); return []; },
        checkRetiredScopeBalance: async options => { calls.push(['check', options.scope]); return { balanceWei: '0' }; },
        sweepRetiredScope: async options => { calls.push(['sweep', options.scope, options.destination]); return { ok: true }; },
        recoverRetiredScope: async options => { calls.push(['recover', options.scope]); return { ok: true }; }
    };
    const ui = createVersionUi({ facade: fakeFacade({ state: null }), loadRescue: async () => { loads += 1; return module; } });
    assert.equal(loads, 0, 'composing the helpers imports nothing');
    assert.deepEqual(Object.keys(ui.rescue).sort(), [
        'checkRetiredScopeBalance', 'createScopedFundingProvider', 'listRetiredScopes', 'recoverRetiredScope', 'sweepRetiredScope'
    ]);
    const provider = ui.rescue.createScopedFundingProvider(V2, { marker: 1 });
    assert.equal(loads, 0, 'building a provider is lazy as well');
    assert.deepEqual(await provider.ensureAddress(), { address: '0x1' });
    await ui.rescue.listRetiredScopes({ table: TABLE });
    await ui.rescue.checkRetiredScopeBalance({ scope: 's1' });
    await ui.rescue.sweepRetiredScope({ scope: 's1', destination: '0x2' });
    await ui.rescue.recoverRetiredScope({ scope: 's1' });
    assert.equal(loads, 5);
    assert.deepEqual(calls, [['ensure', 'v2', { marker: 1 }], ['list', 2], ['check', 's1'], ['sweep', 's1', '0x2'], ['recover', 's1']]);
});

// ---------------------------------------------------------------------------
// The System Panel
// ---------------------------------------------------------------------------

test('without a facade the panel is byte-identical to the unversioned panel', t => {
    const baseline = renderPanel().html;
    assert.doesNotMatch(baseline, /zkapi-version|data-zkapi-version|version-help/);
    // A single-version build says so, and a facade with no UI helpers yet is
    // the same page until they arrive.
    installFacade(t, { multiVersion: false, state: () => null, subscribe: () => () => {}, ui: null });
    assert.equal(renderPanel().html, baseline);
    zkapiClient.oaVersioning = { multiVersion: true, state: () => holderWith(8 * DAY), subscribe: () => () => {}, ui: null };
    assert.equal(renderPanel().html, baseline);
    zkapiClient.oaVersioning = { multiVersion: true, state: () => null, subscribe: () => () => {}, ui: versionUi };
    assert.equal(renderPanel().html, baseline);
    zkapiClient.oaVersioning = { multiVersion: true, state() { throw new Error('boom'); }, ui: versionUi };
    assert.equal(renderPanel().html, baseline);
    // Helpers that throw never take the balance down with them.
    const faulty = { badge() { throw new Error('x'); }, banner() { throw new Error('x'); }, help() { throw new Error('x'); } };
    zkapiClient.oaVersioning = { multiVersion: true, state: () => holderWith(8 * DAY), ui: faulty, subscribe: () => () => {} };
    assert.equal(renderPanel().html, baseline);
});

test('the panel carries no version pill; its banner precedes the experience', t => {
    const state = holderWith(8 * DAY);
    installFacade(t, fakeFacade({ state }));
    const baseline = (() => { delete zkapiClient.oaVersioning; return renderPanel({ helpOpen: {} }).html; })();
    const facade = fakeFacade({ state });
    zkapiClient.oaVersioning = facade;
    const { panel, html } = renderPanel({ helpOpen: {} });

    // The pill and its `?` live in balance details only.
    assert.doesNotMatch(html, /data-zkapi-version-badge|zkapi-panel-version-help/);
    const order = [
        html.indexOf('Private balance:'),
        html.indexOf('id="zkapi-panel-billing-help-toggle"'),
        html.indexOf('id="zkapi-panel-billing-help"'),
        html.indexOf('data-chat-usage-estimate'),
        html.indexOf('data-zkapi-version-banner="panel"'),
        html.indexOf('id="zkapi-panel-fund"')
    ];
    assert.ok(order.every(position => position >= 0), `all present: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'document order');
    // Removing the banner yields exactly the unversioned panel.
    const pieces = panel.versionPieces();
    assert.equal(pieces.badge, '');
    assert.equal(pieces.help, '');
    assert.ok(pieces.banner);
    assert.equal(html.replace(pieces.banner, ''), baseline);
});

test('all seven UX proposals render the same status UI beside the version notices', () => {
    for (const proposal of ZKAPI_UX_PROPOSALS) {
        delete zkapiClient.oaVersioning;
        const plain = renderPanel({ config: { ux_proposal: proposal }, transition: { phase: 'settling' } }).html;
        zkapiClient.oaVersioning = fakeFacade({ state: holderWith(8 * DAY) });
        const { panel, html: versioned } = renderPanel({ config: { ux_proposal: proposal }, transition: { phase: 'settling' } });
        assert.match(versioned, /<strong>Closing previous chat<\/strong>/);
        assert.match(versioned, /data-zkapi-settlement-action="stop"/);
        assert.match(versioned, /id="zkapi-panel-fund"/);
        // The notice sits before the proposal's own block, so removing the
        // version fragments restores the unversioned markup for every proposal.
        const pieces = panel.versionPieces();
        const stripped = versioned.replace(pieces.badge, '').replace(pieces.help, '').replace(pieces.banner, '');
        assert.equal(stripped, plain, `proposal ${proposal}`);
    }
    delete zkapiClient.oaVersioning;
});

test('the panel has no version help; the billing help keeps its own state', t => {
    installFacade(t, fakeFacade({ state: holderWith(8 * DAY) }));
    const closed = renderPanel({ helpOpen: { billing: true } }).html;
    assert.doesNotMatch(closed, /data-zkapi-help-content="version"/);
    assert.doesNotMatch(closed, /id="zkapi-panel-billing-help" data-zkapi-help-content="billing" hidden>/);
    const open = renderPanel({ helpOpen: { version: true } }).html;
    assert.doesNotMatch(open, /Your balance is on version 1\./);
});

test('a lone exit-only version shows the closed gate in the panel with no pill', t => {
    const lone = resolvedTable(partialRevertRegistry(), 'mainnet');
    const state = derive({ table: lone, active: lone[0], target: null, snapshot: normalizedSnapshot() });
    const facade = fakeFacade({ state });
    facade.table = lone;
    installFacade(t, facade);
    const { html } = renderPanel({ wallet: { note: null } });
    assert.doesNotMatch(html, /data-zkapi-version-badge/);
    assert.match(html, /Version 1 no longer accepts new deposits\./);
    assert.match(html, /id="zkapi-panel-fund"/);
});

test('facade changes remount only when what is shown changed, and never on a clock tick', t => {
    const facade = fakeFacade({ state: holderWith(30 * DAY) });
    installFacade(t, facade);
    const { panel } = renderPanel();
    const renders = [];
    panel.renderTopSectionOnly = () => { renders.push('render'); panel.billingSectionHTML(); };
    panel.billingSectionHTML();
    // Same words: nothing to do.
    panel.handleVersionChange();
    assert.deepEqual(renders, []);
    facade.current = holderWith(16 * DAY);
    panel.handleVersionChange();
    assert.deepEqual(renders, ['render']);
    panel.handleVersionChange();
    assert.deepEqual(renders, ['render'], 'rendering recorded the new baseline');
});

test('the facade is subscribed once and released on destroy', t => {
    const facade = fakeFacade({ state: holderWith(30 * DAY) });
    let subscribed = 0;
    let released = 0;
    const subscribe = facade.subscribe;
    facade.subscribe = listener => { subscribed += 1; const off = subscribe(listener); return () => { released += 1; off(); }; };
    installFacade(t, facade);
    // The real constructor does much more than this test needs; drive the
    // subscription the constructor makes through the prototype chain.
    const panel = Object.create(RightPanel.prototype);
    panel.versionUnsubscribe = zkapiClient.oaVersioning?.subscribe?.(() => panel.handleVersionChange()) || null;
    assert.equal(subscribed, 1);
    panel.versionUnsubscribe();
    assert.equal(released, 1);
});

test('clock patches are text-only; a structural change remounts at most once per window', t => {
    const facade = fakeFacade({ state: holderWith(8 * DAY) });
    installFacade(t, facade);
    const { panel, html } = renderPanel();
    const root = parseHtml(html);
    const original = globalThis.document;
    t.after(() => { globalThis.document = original; });
    globalThis.document = { ...original, querySelector: selector => (selector === '#right-panel' ? root : null) };
    const renders = [];
    panel.renderTopSectionOnly = () => renders.push('render');
    panel.handleZkapiClock(NOW_MS);
    assert.deepEqual(renders, [], 'a quiet tick changes nothing');
    const reads = facade.calls.states;
    // Reading the state is rate limited: a 1 Hz tick is mostly a no-op.
    panel.handleZkapiClock(NOW_MS + 1000);
    panel.handleZkapiClock(NOW_MS + 2000);
    assert.equal(facade.calls.states, reads, 'no state read inside the interval');
    // Another tab moved the balance: structure differs.
    facade.current = derive({ snapshot: noteSnapshot(20 * DAY), previewSelection: selectionFor(V2, { reason: 'runtime_holds_note' }) });
    panel.handleZkapiClock(NOW_MS + 6000);
    assert.deepEqual(renders, ['render']);
    // Still different (say the render did not take): one remount per window.
    panel.handleZkapiClock(NOW_MS + 12000);
    panel.handleZkapiClock(NOW_MS + 20000);
    assert.deepEqual(renders, ['render']);
    panel.handleZkapiClock(NOW_MS + 40000);
    assert.deepEqual(renders, ['render', 'render']);
});

test('a facade whose helpers arrive late renders them when it says so', t => {
    const facade = fakeFacade({ state: holderWith(8 * DAY) });
    const ui = facade.ui;
    facade.ui = null;
    installFacade(t, facade);
    const { panel, html } = renderPanel();
    assert.doesNotMatch(html, /data-zkapi-version/);
    const renders = [];
    panel.renderTopSectionOnly = () => { renders.push('render'); panel.billingSectionHTML(); };
    panel.handleVersionChange();
    assert.deepEqual(renders, [], 'nothing to show yet, nothing to remount');
    facade.ui = ui;   // attachUi
    panel.handleVersionChange();
    assert.deepEqual(renders, ['render']);
    assert.match(panel.billingSectionHTML(), /data-zkapi-version-banner="panel"/);
});

test('without a facade a clock tick never touches the document for versions', () => {
    const original = globalThis.document;
    const queries = [];
    globalThis.document = { querySelector(selector) { queries.push(selector); return null; } };
    try {
        const panel = Object.create(RightPanel.prototype);
        delete zkapiClient.oaVersioning;
        panel.handleZkapiClock();
        assert.deepEqual(queries, ['#right-panel [data-zkapi-note-expiry]', '#right-panel']);
    } finally {
        globalThis.document = original;
    }
});

test('each reminder tier is toasted once, in zkAPI mode, and never in ticket mode', t => {
    const facade = fakeFacade({ state: holderWith(8 * DAY) });
    installFacade(t, facade);
    const toasts = [];
    const { panel } = renderPanel();
    panel.app.showToast = (text, kind, ms) => toasts.push({ text, kind, ms });
    panel.renderTopSectionOnly = () => {};
    panel.handleVersionChange();
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].text, /^7 days left to upgrade\./);
    assert.equal(toasts[0].kind, 'info');
    assert.deepEqual(facade.calls.acknowledged, [7]);
    panel.handleVersionChange();
    assert.equal(toasts.length, 1, 'the same tier is not repeated');
    facade.current = holderWith(5 * DAY);
    panel.handleVersionChange();
    assert.equal(toasts.length, 2);
    assert.match(toasts[1].text, /^3 days left to upgrade\./);

    // A neutral note is never a toast.
    const quiet = fakeFacade({ state: holderWith(30 * DAY) });
    zkapiClient.oaVersioning = quiet;
    panel.handleVersionChange();
    assert.equal(toasts.length, 2);
    // OA ticket mode suppresses zkAPI toasts.
    const ticket = fakeFacade({ state: holderWith(2 * DAY) });
    zkapiClient.oaVersioning = ticket;
    panel.app.integration.getMode = () => 'tickets';
    panel.handleVersionChange();
    assert.equal(toasts.length, 2);
    assert.deepEqual(ticket.calls.acknowledged, []);
});

test('the panel clicks the banner buttons: upgrade opens the upgrade view', async t => {
    const state = holderWith(2 * DAY);
    const facade = fakeFacade({ state });
    installFacade(t, facade);
    const { panel, html } = renderPanel();
    const root = parseHtml(html);
    const original = globalThis.document;
    const events = [];
    t.after(() => { globalThis.document = original; globalThis.dispatchEvent = () => {}; });
    globalThis.document = { ...original, querySelector: selector => (selector === '#right-panel' ? root : null),
        getElementById: () => null };
    globalThis.dispatchEvent = event => events.push([event.type, event.detail]);
    globalThis.window = globalThis;
    const base = Object.getPrototypeOf(RightPanel.prototype);
    const original$ = base.attachTopSectionEventListeners;
    base.attachTopSectionEventListeners = () => {};
    t.after(() => { base.attachTopSectionEventListeners = original$; });
    panel.attachTopSectionEventListeners();
    root.querySelector('[data-zkapi-version-action="upgrade"]').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, [['zkapi-payment-required', { view: 'upgrade' }]]);
});

test('an SDK refusal that names another deployment reads plainly in the panel, by selection', t => {
    const refusal = () => new Error('This browser contains a wallet for zkapi-some-id. Switch back to that deployment before using or withdrawing it.');
    const state = derive({ active: V2, selection: selectionFor(V2, { reason: 'unknown_deployment', slotOwner: null,
        depositBlock: 'foreign_runtime' }), snapshot: normalizedSnapshot() });
    installFacade(t, fakeFacade({ state }));
    // No version installed (the SDK-default or single-version page): the
    // SDK's own words pass through exactly as they did.
    resetActiveVersionForTests();
    assert.match(renderPanel({ wallet: { note: null }, lastError: refusal() }).html, /This browser contains a wallet for zkapi-some-id/);
    // A page with versions: told in plain words, no deployment id.
    installActiveVersion({ table: TABLE, version: V2, selection: selectionFor(V2, { reason: 'unknown_deployment', slotOwner: null }) });
    t.after(() => resetActiveVersionForTests());
    const { html } = renderPanel({ wallet: { note: null }, lastError: refusal() });
    assert.doesNotMatch(html, /zkapi-some-id|Switch back to that deployment/);
    assert.match(html, /This browser holds a saved balance that this page can’t open\./);
});

// ---------------------------------------------------------------------------
// Ticket (OA) mode
// ---------------------------------------------------------------------------

function ticketPanel(mode = 'tickets') {
    const session = { id: 'ticket-chat', inferenceBackend: 'openrouter' };
    const panel = Object.create(PaymentModeRightPanel.prototype);
    panel.currentSession = session;
    panel.paymentMode = mode;
    panel.app = {
        getCurrentSession: () => session,
        integration: { getMode: () => mode, getTransition: () => null }
    };
    return panel;
}

test('ticket mode carries a keyed upgrade notice only when versions exist, and patches it in place', t => {
    t.mock.method(TicketRightPanel.prototype, 'generateFundingSectionHTML', () => '<div id="normal-ticket-controls">Tickets</div>');
    const panel = ticketPanel();

    // No facade, and a single-version facade: the ticket panel is unchanged.
    delete zkapiClient.oaVersioning;
    const plain = panel.generateFundingSectionHTML();
    assert.doesNotMatch(plain, /zkapi-upgrade-notice/);
    installFacade(t, { multiVersion: false, state: () => null, subscribe: () => () => {}, ui: versionUi });
    assert.equal(panel.generateFundingSectionHTML(), plain);

    // Versions, but nothing at risk to say: the keyed slot exists, hidden.
    const facade = fakeFacade({ state: holderWith(30 * DAY) });
    zkapiClient.oaVersioning = facade;
    let html = panel.generateFundingSectionHTML();
    assert.match(html, /id="normal-ticket-controls"/);
    assert.match(html, /id="zkapi-ticket-closing-notice"/);
    assert.match(html, /<div id="zkapi-upgrade-notice" class="px-3 pb-3" hidden><\/div>/);
    assert.ok(html.indexOf('zkapi-ticket-closing-notice') < html.indexOf('zkapi-upgrade-notice'));

    // A reminder inside the window shows, static (no live region).
    facade.current = holderWith(2 * DAY);
    html = panel.generateFundingSectionHTML();
    const slot = html.match(/<div id="zkapi-upgrade-notice"[^>]*>/)[0];
    assert.doesNotMatch(slot, /hidden|aria-live|role=/);
    assert.match(html, /data-zkapi-version-banner="ticket"/);
    assert.match(html, /Upgrade now\./);
});

test('a facade change patches the keyed ticket notice and remounts nothing', t => {
    t.mock.method(TicketRightPanel.prototype, 'generateFundingSectionHTML', () => '<div id="normal-ticket-controls">Tickets</div>');
    const facade = fakeFacade({ state: holderWith(30 * DAY) });
    installFacade(t, facade);
    const panel = ticketPanel();
    panel.generateFundingSectionHTML();   // the mounted slot is what the first render produced
    let hidden = true;
    let hiddenWrites = 0;
    let html = '';
    let htmlWrites = 0;
    const slot = {
        get hidden() { return hidden; }, set hidden(value) { hidden = value; hiddenWrites += 1; },
        get innerHTML() { return html; }, set innerHTML(value) { html = value; htmlWrites += 1; },
        querySelectorAll: () => []
    };
    const lookups = [];
    t.mock.method(document, 'getElementById', id => { lookups.push(id); return id === 'zkapi-upgrade-notice' ? slot : null; });
    panel.loadSessionData = () => assert.fail('a version change must not reload ticket access');
    panel.renderTopSectionOnly = () => assert.fail('a version change must not remount ticket controls');

    panel.handleVersionChange();
    assert.equal(hidden, true, 'a neutral note is not worth OA mode');
    assert.equal(htmlWrites, 0);
    facade.current = holderWith(2 * DAY);
    panel.handleVersionChange();
    assert.equal(hidden, false);
    assert.match(html, /data-zkapi-version-banner="ticket"/);
    assert.equal(htmlWrites, 1);
    panel.handleVersionChange();
    assert.equal(htmlWrites, 1, 'unchanged markup is not rewritten');
    facade.current = derive({ active: V2, selection: selectionFor(V2), snapshot: noteSnapshot(20 * DAY) });
    panel.handleVersionChange();
    assert.equal(hidden, true);
    assert.equal(html, '');
    assert.deepEqual([...new Set(lookups)], ['zkapi-upgrade-notice']);
});

test('zkAPI-mode panels do not look up the ticket slot, and ticket mode without versions looks up nothing', t => {
    const lookups = [];
    t.mock.method(document, 'getElementById', id => { lookups.push(id); return null; });
    delete zkapiClient.oaVersioning;
    const panel = ticketPanel();
    panel.handleVersionChange();
    panel.refreshVersionNotices();
    assert.deepEqual(lookups, []);
    // The keyed closing notice keeps its own handling.
    panel.handleZkapiChange({ reason: 'activity-update' });
    assert.deepEqual([...new Set(lookups)], ['zkapi-ticket-closing-notice']);
});

// ---------------------------------------------------------------------------
// The toolbar chip
// ---------------------------------------------------------------------------

test('the standalone chip names the version only where versions are told apart', t => {
    const button = () => {
        const attributes = new Map();
        return { dataset: {}, title: '', attributes, querySelector: () => null,
            setAttribute(name, value) { attributes.set(name, value); } };
    };
    Object.assign(zkapiClient, snapshotOf());
    const app = { integration: { getTransition: () => null }, state: {} };
    delete zkapiClient.oaVersioning;
    const plain = button();
    updateZkapiBalanceControl(plain, app);
    assert.doesNotMatch(plain.title, /Version/);
    assert.equal(plain.attributes.get('aria-label'), plain.title);

    installFacade(t, fakeFacade({ state: holderWith(8 * DAY) }));
    const versioned = button();
    updateZkapiBalanceControl(versioned, app);
    assert.equal(versioned.title, `${plain.title} · Version 1`);
    assert.equal(versioned.attributes.get('aria-label'), versioned.title);
    // A single-version build keeps the chip exactly as it was.
    zkapiClient.oaVersioning = { multiVersion: false, state: () => null };
    const single = button();
    updateZkapiBalanceControl(single, app);
    assert.equal(single.title, plain.title);
});

// ---------------------------------------------------------------------------
// What a reload may claim, and related edge cases
// ---------------------------------------------------------------------------

const MOVED_ON = /Deposits moved to version 2\. This page is on version 1, which no longer accepts new deposits\. Reload to deposit into version 2\./;
const emptyWalletPreview = () => selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' });
const intentAt = stage => ({ v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage, since: NOW_MS });

function memoryStorage(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        store,
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => { store.set(key, String(value)); },
        removeItem: key => { store.delete(key); }
    };
}

// Put a network define and a readable localStorage where ui.js reads them.
function withBrowserFacts(t, storage, network = 'mainnet') {
    const had = Object.prototype.hasOwnProperty.call(globalThis, '__OA_ZKAPI_NETWORK__');
    const previousNetwork = globalThis.__OA_ZKAPI_NETWORK__;
    const previousStorage = globalThis.localStorage;
    if (network === null) delete globalThis.__OA_ZKAPI_NETWORK__;
    else globalThis.__OA_ZKAPI_NETWORK__ = network;
    globalThis.localStorage = storage;
    t.after(() => {
        if (had) globalThis.__OA_ZKAPI_NETWORK__ = previousNetwork;
        else delete globalThis.__OA_ZKAPI_NETWORK__;
        globalThis.localStorage = previousStorage;
    });
}

test('"Withdrawal confirmed" is told only when the upgrade intent shows the withdrawal ended', () => {
    // The review step writes a bare `withdrawing` intent. A balance that then
    // expired and was archived leaves the same empty wallet as a withdrawal.
    const opened = derive({ snapshot: normalizedSnapshot(), previewSelection: emptyWalletPreview(),
        intent: intentAt('withdrawing') });
    assert.equal(opened.phase, 'reload-required');
    const unproven = banner(opened, { withdrawalConfirmed: false });
    assert.doesNotMatch(unproven, /Withdrawal confirmed|back in your wallet/);
    assert.match(unproven, MOVED_ON);

    const ended = derive({ snapshot: normalizedSnapshot(), previewSelection: emptyWalletPreview(),
        intent: intentAt('withdrawn') });
    assert.match(banner(ended, { withdrawalConfirmed: true }), /Withdrawal confirmed\. Your balance is back in your wallet\./);
    // The claim needs the proof: a caller that cannot say (the fact is
    // missing) gets the words that are true of every reload, whatever the
    // state's own reason says.
    assert.equal(ended.reload.reason, 'upgrade_withdrawn');
    for (const options of [{}, { withdrawalConfirmed: undefined }, { withdrawalConfirmed: 'yes' }, { withdrawalConfirmed: 1 }]) {
        const html = banner(ended, options);
        assert.doesNotMatch(html, /Withdrawal confirmed|back in your wallet/, JSON.stringify(options));
        assert.match(html, MOVED_ON);
    }
    // The same gate for the dialog and ticket surfaces.
    for (const surface of ['dialog', 'ticket']) {
        assert.doesNotMatch(banner(opened, { surface, withdrawalConfirmed: false }), /Withdrawal confirmed/);
    }
});

test('"moved in another tab" needs a balance found in the wallet; an empty read says only that deposits moved', () => {
    const held = derive({ snapshot: noteSnapshot(20 * DAY), previewSelection: selectionFor(V2, { reason: 'runtime_holds_note' }) });
    assert.match(banner(held, { previewReason: 'runtime_holds_note' }),
        /This browser’s balance moved to version 2 in another tab\. Reload to keep going\. Nothing is lost/);
    // This tab still holds a note in memory, but a fresh read finds the wallet
    // empty: it was withdrawn or claimed elsewhere, and "saved in this
    // browser" would be false.
    const gone = derive({ snapshot: noteSnapshot(20 * DAY), previewSelection: emptyWalletPreview() });
    assert.equal(gone.phase, 'reload-required');
    const html = banner(gone, { previewReason: 'no_runtime_note' });
    assert.doesNotMatch(html, /Nothing is lost|saved in this browser|in another tab/);
    assert.match(html, MOVED_ON);
    assert.match(html, /data-zkapi-version-action="reload"/);
});

test('a page on the deposit target never sends the person to deposit into the version that stopped chats', () => {
    const onTarget = derive({ active: V2, selection: selectionFor(V2), snapshot: noteSnapshot(20 * DAY), admissionClosed: true });
    assert.equal(onTarget.phase, 'admission-closed');
    assert.equal(onTarget.target.id, 'v2');
    const html = banner(onTarget);
    assert.match(html, /Version 2 is no longer starting new chats\. Withdraw your balance\./);
    assert.doesNotMatch(html, /deposit into version|keep chatting/);
    // The error toast and the banner agree.
    // A page on an older version still has somewhere to go.
    const older = holderWith(20 * DAY, { admissionClosed: true });
    assert.match(banner(older), /Version 1 is no longer starting new chats\. Withdraw your balance, then deposit into version 2 to keep chatting\./);
});

test('a set-aside note far from its deadline is not shown, and is never an alert or a ticket notice', () => {
    const far = derive({ snapshot: normalizedSnapshot({ hasOpenWithdrawal: true,
        deadlines: [{ source: 'set-aside', expiryTs: NOW_S + 40 * DAY }] }) });
    assert.equal(far.phase, 'finish-previous-withdrawal');
    assert.equal(far.previous.versionId, 'v1');
    // Far from its deadline it says nothing: the neutral note is not shown.
    assert.deepEqual(buildVersionNotices(far, { surface: 'panel', table: TABLE, formatter: FORMAT }).notices, []);
    assert.equal(banner(far), '');
    assert.equal(banner(far, { surface: 'ticket' }), '');

    // Inside a reminder tier it is an alert on every surface that carries it.
    const near = derive({ snapshot: normalizedSnapshot({ hasOpenWithdrawal: true,
        deadlines: [{ source: 'set-aside', expiryTs: NOW_S + 5 * DAY }] }) });
    for (const surface of ['panel', 'ticket']) {
        const [alert] = buildVersionNotices(near, { surface, table: TABLE, formatter: FORMAT }).notices;
        assert.equal(alert.id, 'previous');
        assert.equal(alert.tone, 'attention');
        assert.match(alert.paragraphs[0].text, /^3 days left to upgrade\./);
    }
});

test('a changed paragraph count is structure: the patch asks for a render instead of patching the wrong text', () => {
    const plain = derive({ snapshot: normalizedSnapshot() });
    const resumable = derive({ snapshot: normalizedSnapshot({ hasPendingDeposit: true }) });
    assert.equal(plain.gate.code, 'deposits_closed');
    assert.equal(resumable.gate.canResume, true);
    const root = mounted(plain);
    assert.equal(root.querySelectorAll('[data-zkapi-version-text]').length, 1);
    const before = root.querySelector('[data-zkapi-version-text="0"]').textContent;
    assert.deepEqual(patchVersionNotices(root, resumable, { table: TABLE, formatter: FORMAT }), { needsRender: true });
    assert.equal(root.querySelector('[data-zkapi-version-text="0"]').textContent, before, 'nothing is touched');
    // And the other way round.
    const grown = mounted(resumable);
    assert.equal(grown.querySelectorAll('[data-zkapi-version-text]').length, 2);
    assert.equal(patchVersionNotices(grown, plain, { table: TABLE, formatter: FORMAT }).needsRender, true);
    // Same count, same structure: a text patch as before.
    assert.equal(patchVersionNotices(grown, resumable, { table: TABLE, formatter: FORMAT }).needsRender, false);
});

test('the reload button records an upgrade withdrawal only when the intent shows one', async () => {
    const withdrawn = derive({ snapshot: normalizedSnapshot(), previewSelection: emptyWalletPreview(),
        intent: intentAt('withdrawn') });
    const confirmed = fakeFacade({ state: withdrawn });
    await handleVersionAction('reload', { facade: confirmed, withdrawalConfirmed: true });
    assert.deepEqual(confirmed.calls.switches, [{ reason: 'upgrade_withdrawn', view: 'fund' }]);

    // `upgrade_withdrawn` is what makes the facade record "withdrawn", which
    // the next page tells as fact: not sent without the proof.
    const unproven = fakeFacade({ state: withdrawn });
    await handleVersionAction('reload', { facade: unproven, withdrawalConfirmed: false });
    assert.deepEqual(unproven.calls.switches, [{ reason: 'previous_withdrawal_finished', view: null }]);

    // The context says nothing: the facade's own helpers are asked.
    const viaFacts = fakeFacade({ state: withdrawn });
    viaFacts.ui = { facts: () => ({ withdrawalConfirmed: false }) };
    await handleVersionAction('reload', { facade: viaFacts });
    assert.deepEqual(viaFacts.calls.switches, [{ reason: 'previous_withdrawal_finished', view: null }]);
    // Facts that cannot be read, or that say nothing: the withdrawal is not
    // shown to have ended, so none is recorded for the next page to tell.
    const throwing = fakeFacade({ state: withdrawn });
    throwing.ui = { facts() { throw new Error('x'); } };
    delete throwing.flags;
    await handleVersionAction('reload', { facade: throwing });
    assert.deepEqual(throwing.calls.switches, [{ reason: 'previous_withdrawal_finished', view: null }]);

    const unknown = fakeFacade({ state: withdrawn });
    unknown.ui = null;
    delete unknown.flags;
    await handleVersionAction('reload', { facade: unknown });
    assert.deepEqual(unknown.calls.switches, [{ reason: 'previous_withdrawal_finished', view: null }]);

    // Helpers with no facts: the facade's own flag decides, true or false.
    const flagged = fakeFacade({ state: withdrawn, flags: { withdrawalConfirmed: true } });
    flagged.ui = null;
    await handleVersionAction('reload', { facade: flagged });
    assert.deepEqual(flagged.calls.switches, [{ reason: 'upgrade_withdrawn', view: 'fund' }]);
    const unflagged = fakeFacade({ state: withdrawn, flags: { withdrawalConfirmed: false } });
    unflagged.ui = null;
    await handleVersionAction('reload', { facade: unflagged });
    assert.deepEqual(unflagged.calls.switches, [{ reason: 'previous_withdrawal_finished', view: null }]);
});

test('ui.facts reads the upgrade intent and the freshest read of the wallet, and says nothing it cannot know', t => {
    const storage = memoryStorage();
    withBrowserFacts(t, storage, null);
    const facade = fakeFacade({ state: holderWith(8 * DAY) });
    facade.active = V1;
    // No network define in this page: nothing is known, so nothing is claimed.
    assert.deepEqual(facade.ui.facts(), {});

    globalThis.__OA_ZKAPI_NETWORK__ = 'mainnet';
    const write = (stage, overrides = {}) => storage.setItem(UPGRADE_INTENT_KEY, JSON.stringify({
        v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage, since: Date.now(), ...overrides }));
    assert.deepEqual(facade.ui.facts(), { withdrawalConfirmed: false }, 'no intent');
    write('withdrawing');
    assert.equal(facade.ui.facts().withdrawalConfirmed, false, 'only the review step was opened');
    write('withdrawn');
    assert.equal(facade.ui.facts().withdrawalConfirmed, true);
    write('depositing');
    assert.equal(facade.ui.facts().withdrawalConfirmed, true);
    write('withdrawn', { from: 'v0' });
    assert.equal(facade.ui.facts().withdrawalConfirmed, false, 'an upgrade from another version');
    write('withdrawn', { network: 'sepolia' });
    assert.equal(facade.ui.facts().withdrawalConfirmed, false, 'another network');
    storage.setItem(UPGRADE_INTENT_KEY, '{not json');
    assert.equal(facade.ui.facts().withdrawalConfirmed, false);

    write('withdrawn');
    facade.previewSelection = () => emptyWalletPreview();
    assert.deepEqual(facade.ui.facts(), { withdrawalConfirmed: true, previewReason: 'no_runtime_note' });
    facade.previewSelection = () => { throw new Error('x'); };
    assert.deepEqual(facade.ui.facts(), { withdrawalConfirmed: true });
    delete facade.active;
    assert.deepEqual(facade.ui.facts(), {}, 'no loaded version');

    // The renderers use the facts without being handed them. The state's own
    // reason is `upgrade_withdrawn` in both halves: what differs is the proof.
    const ended = derive({ snapshot: normalizedSnapshot(), previewSelection: emptyWalletPreview(), intent: intentAt('withdrawn') });
    assert.equal(ended.reload.reason, 'upgrade_withdrawn');
    const withFacts = fakeFacade({ state: ended });
    withFacts.active = V1;
    write('withdrawing');
    assert.doesNotMatch(withFacts.ui.banner(ended, { surface: 'panel' }), /Withdrawal confirmed/);
    assert.match(withFacts.ui.banner(ended, { surface: 'panel' }), MOVED_ON);
    write('withdrawn');
    assert.match(withFacts.ui.banner(ended, { surface: 'panel' }), /Withdrawal confirmed/);
});

test('ui.facts takes the facade’s own answer over a stored intent the facade has dismissed', t => {
    const storage = memoryStorage();
    withBrowserFacts(t, storage, 'mainnet');
    storage.setItem(UPGRADE_INTENT_KEY, JSON.stringify({ v: 1, network: 'mainnet', from: 'v1', to: 'v2',
        stage: 'withdrawn', since: Date.now() }));
    const ended = derive({ snapshot: normalizedSnapshot(), previewSelection: emptyWalletPreview(), intent: intentAt('withdrawn') });
    const facade = fakeFacade({ state: ended, flags: { withdrawalConfirmed: false } });
    facade.active = V1;
    // The person dismissed the upgrade and storage refused the removal: the
    // facade stopped reading it, and so must the words.
    assert.equal(facade.ui.facts().withdrawalConfirmed, false);
    assert.doesNotMatch(facade.ui.banner(ended, { surface: 'panel' }), /Withdrawal confirmed/);
    assert.match(facade.ui.banner(ended, { surface: 'panel' }), MOVED_ON);
    facade.flagValues.withdrawalConfirmed = true;
    assert.equal(facade.ui.facts().withdrawalConfirmed, true);
    assert.match(facade.ui.banner(ended, { surface: 'panel' }), /Withdrawal confirmed/);
    // A facade whose flags throw falls back to the stored intent.
    facade.flags = () => { throw new Error('x'); };
    assert.equal(facade.ui.facts().withdrawalConfirmed, true);
});

test('a balance that expired after the review step was opened is never told as a confirmed withdrawal', async t => {
    // The REAL facade, the real helpers, a stored intent: the person opens the
    // upgrade review (which stores `withdrawing`) and leaves; 11 days later
    // the note has expired and been archived, and the wallet is empty.
    const local = memoryStorage();
    const session = memoryStorage();
    withBrowserFacts(t, local);
    let now = NOW_MS;
    // One clock for the facade and for the helpers that read the intent.
    t.mock.method(Date, 'now', () => now);
    let hasNote = true;
    const reloads = [];
    const listeners = new Set();
    const client = {
        initialized: true, noteExpiryClaim: null, lastError: null,
        snapshot: () => legacyClientSnapshot({ wallet: hasNote
            ? { has_note: true, pending_request: false, note: { note_id: 7, deposit_amount: 2_000_000,
                current_balance: 1_000_000, expiry_ts: NOW_S + 10 * DAY } }
            : { has_note: false, pending_request: false, note: null } }),
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        emit() { for (const listener of [...listeners]) listener(client.snapshot(), { reason: 'test' }); }
    };
    const facade = createZkapiVersioning({
        context: () => ({ table: TABLE, version: V1, selection: selectionFor(V1), adapter: getAdapter(V1.adapter) }),
        network: 'mainnet', now: () => now, setTimer: () => 0, clearTimer() {},
        reload: () => reloads.push('reload'), sessionStorage: session, localStorage: local
    });
    t.after(() => facade.resetForTests());
    facade.attach({ client, runtime: null, ui: null });
    facade.attachUi(createVersionUi({ facade }));
    facade.beginUpgrade();
    assert.equal(JSON.parse(local.getItem(UPGRADE_INTENT_KEY)).stage, 'withdrawing');
    facade.endUpgrade();

    now += 11 * 86_400_000;
    hasNote = false;
    client.emit();
    facade.watch.setPreview(emptyWalletPreview());
    const state = facade.state();
    assert.equal(state.phase, 'reload-required');
    const html = facade.ui.banner(state, { surface: 'panel' });
    assert.doesNotMatch(html, /Withdrawal confirmed|back in your wallet/);
    assert.match(html, /Deposits moved to version 2\./);
    assert.match(html, /data-zkapi-version-action="reload"/);

    // Reload: no "withdrawn" is recorded for the next page to tell.
    assert.deepEqual(await facade.ui.act('reload', { surface: 'panel', notify() {} }), { ok: true });
    assert.deepEqual(reloads, ['reload']);
    assert.equal(JSON.parse(local.getItem(UPGRADE_INTENT_KEY)).stage, 'withdrawing');
    assert.notEqual(JSON.parse(session.getItem(SWITCH_HINT_KEY)).reason, 'upgrade_withdrawn');

    // The honest path: this tab saw the withdrawal end, so the stage is
    // "withdrawn", and the person is told so and lands on the fund view.
    local.setItem(UPGRADE_INTENT_KEY, JSON.stringify({ ...intentAt('withdrawn'), since: now }));
    const confirmed = facade.ui.banner(facade.state(), { surface: 'panel' });
    assert.match(confirmed, /Withdrawal confirmed\. Your balance is back in your wallet\./);
    session.removeItem('oa-zkapi-version-switch-log');
    assert.deepEqual(await facade.ui.act('reload', { surface: 'panel', notify() {} }), { ok: true });
    const hint = JSON.parse(session.getItem(SWITCH_HINT_KEY));
    assert.equal(hint.reason, 'upgrade_withdrawn');
    assert.equal(hint.view, 'fund');
    assert.equal(JSON.parse(local.getItem(UPGRADE_INTENT_KEY)).stage, 'withdrawn');
});

test('a reminder tier is toasted once per panel even when storage cannot remember it', t => {
    const facade = fakeFacade({ state: holderWith(8 * DAY) });
    // Quota or restricted storage: nothing is ever stored.
    facade.lastReminderTier = () => null;
    facade.acknowledgeReminder = tier => { facade.calls.acknowledged.push(tier); };
    installFacade(t, facade);
    const toasts = [];
    const { panel } = renderPanel();
    panel.app.showToast = text => toasts.push(text);
    panel.renderTopSectionOnly = () => {};
    for (let index = 0; index < 5; index += 1) panel.handleVersionChange();
    assert.equal(toasts.length, 1);
    assert.match(toasts[0], /^7 days left to upgrade\./);
    // A more urgent tier is a new reminder, once.
    facade.current = holderWith(5 * DAY);
    panel.handleVersionChange();
    panel.handleVersionChange();
    assert.equal(toasts.length, 2);
    assert.match(toasts[1], /^3 days left to upgrade\./);
    // The tier is never walked backwards by a state that reads less urgent.
    facade.current = holderWith(8 * DAY);
    panel.handleVersionChange();
    assert.equal(toasts.length, 2);
    // A facade that does remember keeps deciding with the panel's memory.
    facade.lastReminderTier = () => 0;
    facade.current = holderWith(2 * DAY);
    panel.handleVersionChange();
    assert.equal(toasts.length, 2);
});

// ---------------------------------------------------------------------------
// The deposit step can be dismissed; operator notices
// ---------------------------------------------------------------------------

test('the deposit step’s notice carries a Dismiss that forgets the upgrade, and stays dismissed', async t => {
    resetVersionNoticeDismissals();
    t.after(resetVersionNoticeDismissals);
    const deposit = derive({ active: V2, selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }),
        snapshot: normalizedSnapshot(), intent: intentAt('withdrawn') });
    assert.equal(deposit.upgrade.stage, 'deposit');
    const [entry] = buildVersionNotices(deposit, { surface: 'panel', table: TABLE, formatter: FORMAT }).notices;
    assert.equal(entry.id, 'deposit');
    assert.deepEqual(entry.actions.map(action => action.action), ['upgrade', 'dismiss']);
    // The ticket surface has no deposit step to show.
    assert.deepEqual(buildVersionNotices(deposit, { surface: 'ticket', table: TABLE, formatter: FORMAT }).notices.map(item => item.id), []);

    const facade = fakeFacade({ state: deposit });
    facade.abandoned = 0;
    facade.abandonUpgrade = () => { facade.abandoned += 1; return true; };
    const root = mounted(deposit);
    attachVersionNotices(root, { facade: () => facade, refresh: () => facade.calls.refreshes = (facade.calls.refreshes || 0) + 1 });
    root.querySelector('[data-zkapi-version-action="dismiss"]').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(facade.abandoned, 1, 'the persisted upgrade is forgotten');
    assert.equal(facade.calls.refreshes, 1);
    // Gone from every surface for the life of the page, even before the state
    // catches up with the forgotten upgrade.
    assert.equal(banner(deposit), '');
    assert.equal(banner(deposit, { surface: 'dialog' }), '');

    // The "done" notice is this page's only: nothing is forgotten for it.
    resetVersionNoticeDismissals();
    await handleVersionAction('dismiss', { facade, noticeId: 'done' });
    assert.equal(facade.abandoned, 1);
    // A facade without the call, or one that throws, still hides the notice.
    resetVersionNoticeDismissals();
    const old = fakeFacade({ state: deposit });
    assert.deepEqual(await handleVersionAction('dismiss', { facade: old, noticeId: 'deposit' }), { ok: true });
    assert.equal(banner(deposit), '');
    resetVersionNoticeDismissals();
    const throwing = fakeFacade({ state: deposit });
    throwing.abandonUpgrade = () => { throw new Error('x'); };
    assert.deepEqual(await handleVersionAction('dismiss', { facade: throwing, noticeId: 'deposit' }), { ok: true });
    assert.equal(banner(deposit), '', 'the click always has its effect on this page');
});

test('the real facade forgets a dismissed deposit step, and the notice does not come back', async t => {
    resetVersionNoticeDismissals();
    t.after(resetVersionNoticeDismissals);
    const local = memoryStorage({ [UPGRADE_INTENT_KEY]: JSON.stringify({ v: 1, network: 'mainnet', from: 'v1', to: 'v2',
        stage: 'withdrawn', since: Date.now() }) });
    const session = memoryStorage();
    withBrowserFacts(t, local);
    const facade = createZkapiVersioning({
        context: () => ({ table: TABLE, version: V2,
            selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }), adapter: getAdapter(V2.adapter) }),
        network: 'mainnet', setTimer: () => 0, clearTimer() {}, sessionStorage: session, localStorage: local
    });
    t.after(() => facade.resetForTests());
    facade.attach({ client: { initialized: false, snapshot: () => legacyClientSnapshot(), subscribe: () => () => {} }, runtime: null, ui: null });
    facade.attachUi(createVersionUi({ facade }));
    assert.equal(facade.state().upgrade.stage, 'deposit');
    assert.match(facade.ui.banner(facade.state(), { surface: 'panel' }), /data-zkapi-version-action="dismiss">Dismiss</);
    assert.deepEqual(await facade.ui.act('dismiss', { surface: 'panel', noticeId: 'deposit', refresh() {} }), { ok: true });
    assert.equal(local.getItem(UPGRADE_INTENT_KEY), null, 'nothing is left for the next page');
    assert.equal(facade.state().upgrade.stage, 'idle');
    assert.equal(facade.ui.banner(facade.state(), { surface: 'panel' }), '');
});

// A registry with one operator notice on version 1, and a page on version 2
// that holds the pending escape it covers (the same shape the state tests use).
function noticeState(text, { surfaceNotices = null } = {}) {
    const table = resolvedTable(mutated(activatedRegistry(), registry => {
        registry.versions[0].networks.mainnet.notices = [stuckEscapeNotice({ noteId: 7, text, expiresAt: '2027-01-01T00:00:00Z' })];
    }), 'mainnet');
    const target = table.find(version => version.status === 'active');
    const state = derive({
        table, active: target, target,
        selection: selectionFor(target, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty',
            open: { v1: [{ recordId: 'r1', noteId: 7, mode: 'escape', phase: 'pending', expiryTs: null }] } }),
        snapshot: normalizedSnapshot()
    });
    return surfaceNotices ? { ...state, notices: surfaceNotices } : state;
}

test('an operator notice that took effect is told as an info notice on the panel and the dialog, never on tickets', () => {
    const state = noticeState('Your escape for this note will be finalized by the operator.');
    assert.equal(state.gate.canStart, true, 'the notice is why deposits are open');
    assert.deepEqual(state.notices, [{
        versionId: 'v1', text: 'Your escape for this note will be finalized by the operator.', noteId: 7
    }]);
    for (const surface of ['panel', 'dialog']) {
        const [entry, ...rest] = buildVersionNotices(state, { surface, table: TABLE, formatter: FORMAT }).notices;
        assert.deepEqual(rest, []);
        assert.equal(entry.id, 'operator-0');
        assert.equal(entry.tone, 'info');
        assert.deepEqual(entry.actions, []);
        assert.equal(entry.paragraphs[0].text, 'Your escape for this note will be finalized by the operator.');
        assert.match(banner(state, { surface }), /data-zkapi-version-notice="operator-0"/);
    }
    assert.equal(banner(state, { surface: 'ticket' }), '', 'not a ticket-mode notice');
    // Nothing took effect: nothing is said.
    assert.equal(banner(derive({ active: V2, selection: selectionFor(V2), snapshot: normalizedSnapshot() })), '');
});

test('operator text is escaped once, kept to 280 characters and never a link or markup', () => {
    const hostile = '<img src=x onerror=alert(1)> <a href="https://evil.example">click</a> &amp; "quoted" \'single\' `tick`';
    const html = banner(noticeState(hostile));
    assert.doesNotMatch(html, /<img|<a[\s>]|<[^>]*\bonerror=/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &lt;a href=&quot;https:\/\/evil\.example&quot;&gt;click&lt;\/a&gt; &amp;amp; &quot;quoted&quot; &#39;single&#39; &#96;tick&#96;/);
    // Plain text for the patch: not escaped, so textContent shows what was said.
    const [said] = buildVersionNotices(noticeState(hostile), { surface: 'panel', table: TABLE, formatter: FORMAT }).notices;
    assert.equal(said.paragraphs[0].text, hostile);

    // Bounded: the registry limits the text to 280, and a state that carries
    // more (hand-built, or from a later registry) is cut at the same bound.
    const long = noticeState('short', { surfaceNotices: [{ versionId: 'v1', text: `${'word '.repeat(200)}tail` }] });
    const [entry] = buildVersionNotices(long, { surface: 'panel', table: TABLE, formatter: FORMAT }).notices;
    assert.ok(entry.paragraphs[0].text.length <= 280, String(entry.paragraphs[0].text.length));
    assert.ok(entry.paragraphs[0].text.endsWith('…'));
    assert.equal([...entry.paragraphs[0].html.matchAll(/word/g)].length, [...entry.paragraphs[0].text.matchAll(/word/g)].length);
    // Control characters are gone, and a text with nothing left says nothing.
    const control = noticeState('short', { surfaceNotices: [{ versionId: 'v1', text: 'a\u0000b\n\u2028c' }, { versionId: 'v1', text: '\u0000 \n' }, { versionId: 'v1' }, null] });
    const texts = buildVersionNotices(control, { surface: 'panel', table: TABLE, formatter: FORMAT }).notices.map(item => item.paragraphs[0].text);
    assert.deepEqual(texts, ['a b c']);
});

test('operator notices are patched in place and a new one asks for a render', () => {
    const first = noticeState('First text.');
    const root = mounted(first);
    assert.equal(root.querySelector('[data-zkapi-version-text="0"]').textContent, 'First text.');
    // Same structure, other words: text patch.
    const changed = noticeState('First text.', { surfaceNotices: [{ versionId: 'v1', text: 'Second text.' }] });
    assert.deepEqual(patchVersionNotices(root, changed, { table: TABLE, formatter: FORMAT }), { needsRender: false });
    assert.equal(root.querySelector('[data-zkapi-version-text="0"]').textContent, 'Second text.');
    // One more notice is a structural change: nothing is touched, a render is asked for.
    const two = noticeState('x', { surfaceNotices: [{ versionId: 'v1', text: 'Second text.' }, { versionId: 'v1', text: 'Third text.' }] });
    assert.deepEqual(patchVersionNotices(root, two, { table: TABLE, formatter: FORMAT }), { needsRender: true });
    assert.equal(root.querySelector('[data-zkapi-version-text="0"]').textContent, 'Second text.');
    assert.deepEqual(buildVersionNotices(two, { surface: 'panel', table: TABLE, formatter: FORMAT }).notices.map(item => item.id),
        ['operator-0', 'operator-1']);
});

test('the System Panel carries an operator notice that took effect, and the ticket slot never does', t => {
    const said = 'Your escape for this note will be finalized by the operator.';
    const facade = fakeFacade({ state: noticeState(said) });
    installFacade(t, facade);
    const { html } = renderPanel();
    assert.match(html, /data-zkapi-version-notice="operator-0"/);
    assert.ok(html.includes(said));
    assert.equal(html.indexOf('data-zkapi-version-banner="panel"') > html.indexOf('data-chat-usage-estimate'), true);
    // OA mode: the keyed slot stays hidden and empty (an operator notice
    // explains a gate that tickets have nothing to do with).
    t.mock.method(TicketRightPanel.prototype, 'generateFundingSectionHTML', () => '<div id="normal-ticket-controls">Tickets</div>');
    const ticket = ticketPanel().generateFundingSectionHTML();
    assert.match(ticket, /<div id="zkapi-upgrade-notice" class="px-3 pb-3" hidden><\/div>/);
    assert.ok(!ticket.includes(said));
    // A notice that appears is a change the panel remounts for, once.
    const quiet = fakeFacade({ state: derive({ active: V2, selection: selectionFor(V2), snapshot: normalizedSnapshot() }) });
    installFacade(t, quiet);
    const mountedPanel = renderPanel().panel;
    mountedPanel.renderTopSectionOnly = () => { quiet.calls.remounts = (quiet.calls.remounts || 0) + 1; };
    mountedPanel.renderedVersionSignature = `${mountedPanel.versionPieces().badge}${mountedPanel.versionPieces().help}${mountedPanel.versionPieces().banner}`;
    mountedPanel.handleVersionChange();
    assert.equal(quiet.calls.remounts || 0, 0);
    quiet.current = noticeState(said);
    mountedPanel.handleVersionChange();
    assert.equal(quiet.calls.remounts, 1);
});

test('the registry fixtures stay what these tests assume', () => {
    assert.deepEqual(TABLE.map(row => [row.id, row.status]), [['v1', 'exit-only'], ['v2', 'active']]);
    assert.equal(validRegistry().versions.length, 2);
    assert.equal(stuckEscapeNotice().kind, 'stuck_escape');
});
