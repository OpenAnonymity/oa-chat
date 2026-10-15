import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import concessionV1 from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { COPY_KEYS, versionCopyText } from '../../chat/zkapi/versioning/copy.mjs';
import { readExitRefusal, readServiceRefusal } from '../../chat/zkapi/versioning/exitRefusal.mjs';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import {
    NOW_MS, normalizedSnapshot, resolvedTable, threeVersionRegistry
} from './_registryFixtures.mjs';
import { MiniEvent, createDocument } from './_miniDom.mjs';

const {
    attachVersionNotices, buildVersionNotices, dismissVersionNotice, handleVersionAction, patchVersionNotices,
    renderVersionBadge, renderVersionBanner, resetVersionNoticeDismissals
} = await import('../../chat/zkapi/components/VersionNotices.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The notices of the protocol-version facts about a balance, driven by the
// REAL snapshots and errors the SDK emitted (test/fixtures/zkapi-v2-real-shapes)
// through the real adapter and the real VersionState derivation. `generatedAtMs`
// is the frozen clock: every `now` here is that instant plus an offset.

const FIXTURE = JSON.parse(fs.readFileSync(
    new URL('../fixtures/zkapi-v2-real-shapes/snapshots.json', import.meta.url), 'utf8'
));
const GENERATED = FIXTURE.generatedAtMs;
assert.equal(GENERATED, NOW_MS);
const SECOND = 1000;

// threeVersionRegistry(): v1 and v2 exit-only, v3 active (a concession version).
// v2 is the closed concession version with a deposit target; v3 takes deposits.
const TABLE = resolvedTable(threeVersionRegistry(), 'mainnet');
const [, CLOSED, LIVE] = TABLE;
const FORMAT = date => date.toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
// 1 gwei per micro-unit: "$0.10" for 1000000, so the money words are exact.
const MONEY = units => `$${(Number(units) / 1e7).toFixed(2)}`;

function selectionFor(version, overrides = {}) {
    return {
        version, reason: 'runtime_holds_note', slotOwner: version.id, open: {}, credits: {}, foreignDeploymentId: null,
        depositBlock: null, draftDiscarded: false, slotKind: 'note', ...overrides
    };
}

const scenario = name => {
    const { clientSnapshot, runtime } = FIXTURE.scenarios[name];
    return { ...clientSnapshot, runtime };
};
const normalized = name => concessionV1.normalizeSnapshot(scenario(name), { nowMs: GENERATED });

function derive({ active = LIVE, snapshot = normalizedSnapshot(), now = GENERATED, ...rest } = {}) {
    return deriveVersionState({
        table: TABLE,
        active,
        target: TABLE.find(row => row.status === 'active') || null,
        selection: selectionFor(active),
        snapshot,
        intent: null,
        previewSelection: null,
        now,
        busy: false,
        admissionClosed: false,
        buildClosed: false,
        configBlock: false,
        unreachable: false,
        adapter: getAdapter(active.adapter),
        ...rest
    });
}

const error = (name, now = GENERATED) => {
    const shape = FIXTURE.errors[name];
    return readExitRefusal(Object.assign(new Error(shape.message || name), {
        code: shape.code, status: shape.status, data: shape.data
    }), now);
};

const OPTIONS = { table: TABLE, formatter: FORMAT, formatAmount: MONEY, now: GENERATED };
const noticesOf = (state, surface = 'dialog', options = {}) =>
    buildVersionNotices(state, { ...OPTIONS, surface, ...options }).notices;
const idsOf = (state, surface = 'dialog', options = {}) => noticesOf(state, surface, options).map(entry => entry.id);
const noticeOf = (state, id, surface = 'dialog', options = {}) =>
    noticesOf(state, surface, options).find(entry => entry.id === id);
const textOf = entry => entry.paragraphs.map(paragraph => paragraph.text).join(' ');
const actionsOf = entry => entry.actions.map(action => action.action);

const freshDismissals = () => resetVersionNoticeDismissals();

// ---------------------------------------------------------------------------
// A facade and the page's context for the buttons
// ---------------------------------------------------------------------------

function facadeWith(overrides = {}) {
    const calls = [];
    const facade = {
        calls,
        state: () => overrides.state ?? null,
        requestSwitch: arg => { calls.push(['switch', arg]); return overrides.switch || { ok: true }; },
        abandonUpgrade: () => { calls.push(['abandonUpgrade']); },
        ...overrides.members
    };
    if (overrides.recheck !== undefined) {
        facade.recheckService = async () => {
            calls.push(['recheck']);
            if (overrides.recheck instanceof Error) throw overrides.recheck;
            return overrides.recheck;
        };
    }
    return facade;
}

function context(overrides = {}) {
    const events = { dispatched: [], notices: [], reloads: 0, refreshes: 0 };
    return {
        events,
        context: {
            surface: 'dialog',
            dispatch: (name, detail) => events.dispatched.push([name, detail]),
            notify: text => events.notices.push(text),
            reload: () => { events.reloads += 1; },
            refresh: () => { events.refreshes += 1; },
            ...overrides
        }
    };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

test('wiring:service-message the service pause is said in the host’s words by code and never in the SDK’s', () => {
    freshDismissals();
    const expected = {
        service_missing: 'service.paused.unreachable',
        service_changed: 'service.paused.changed',
        service_legacy: 'service.paused.incompatible'
    };
    for (const [name, key] of Object.entries(expected)) {
        const state = derive({ snapshot: normalized(name) });
        assert.equal(state.phase, 'service-paused', name);
        const service = noticeOf(state, 'service');
        assert.equal(textOf(service), versionCopyText(key), name);
        // The SDK's own message is written for an engineer and names the operator's manifest.
        assert.doesNotMatch(textOf(service), /manifest|operator|deployment/i, name);
        assert.deepEqual(actionsOf(service), ['check-service']);
        assert.equal(service.actions[0].label, versionCopyText('service.check'));
        assert.equal(service.tone, 'attention');
    }
    // An error the snapshot does not show: the vault could not be verified.
    const refused = readServiceRefusal(Object.assign(new Error('x'), {
        code: FIXTURE.errors.native_vault_unverified.code, status: 503, data: { exits: true }
    }));
    assert.deepEqual(refused, { code: 'native_vault_unverified' });
    const state = derive({ snapshot: normalized('kit_out_of_date'), serviceRefusal: refused });
    assert.equal(textOf(noticeOf(state, 'service')), versionCopyText('service.paused.contract'));
    // A code the host has no words for is the generic text, still without the SDK's.
    const unknown = derive({ snapshot: normalizedSnapshot({ service: { available: false, code: 'something_new', message: 'SDK-TEXT' } }) });
    assert.equal(textOf(noticeOf(unknown, 'service')), versionCopyText('service.paused'));
    assert.doesNotMatch(textOf(noticeOf(unknown, 'service')), /SDK-TEXT/);
    // The exits are never taken away: nothing here is disabled.
    for (const action of noticeOf(unknown, 'service').actions) assert.equal(action.disabled, false);
});

test('wiring:service-message "Check again" asks the service, and only that', async () => {
    freshDismissals();
    const state = derive({ snapshot: normalized('service_changed') });

    // The service is back: the page is told to redraw, nothing else.
    let facade = facadeWith({ state, recheck: { ok: true } });
    let page = context();
    assert.deepEqual(await handleVersionAction('check-service', { facade, ...page.context }), { ok: true });
    assert.deepEqual(facade.calls, [['recheck']]);
    assert.equal(page.events.refreshes, 1);
    assert.deepEqual(page.events.notices, []);
    assert.equal(page.events.reloads, 0);

    // Still paused: said in words, and nothing moves.
    facade = facadeWith({ state, recheck: { ok: false, why: 'still_unavailable' } });
    page = context();
    assert.deepEqual(await handleVersionAction('check-service', { facade, ...page.context }), { ok: false, why: 'still_unavailable' });
    assert.deepEqual(page.events.notices, [versionCopyText('service.stillPaused')]);
    assert.equal(page.events.reloads, 0);

    // A runtime that can not be asked: a fresh page is the way to learn.
    facade = facadeWith({ state, recheck: { ok: false, why: 'unavailable' } });
    page = context();
    assert.deepEqual(await handleVersionAction('check-service', { facade, ...page.context }), { ok: true, why: 'reloaded' });
    assert.equal(page.events.reloads, 1);

    // A facade with no way to ask at all.
    facade = facadeWith({ state });
    page = context();
    assert.equal((await handleVersionAction('check-service', { facade, ...page.context })).ok, true);
    assert.equal(page.events.reloads, 1);

    // Busy: never a reload while work is in flight, whichever way it is said.
    const busyState = { ...state, reload: { ...state.reload, canReload: false } };
    facade = facadeWith({ state: busyState });
    page = context();
    assert.deepEqual(await handleVersionAction('check-service', { facade, ...page.context }), { ok: false, why: 'busy' });
    assert.equal(page.events.reloads, 0);
    assert.deepEqual(page.events.notices, [versionCopyText('reload.busy')]);
    facade = facadeWith({ state, recheck: { ok: false, why: 'busy' } });
    page = context();
    assert.deepEqual(await handleVersionAction('check-service', { facade, ...page.context }), { ok: false, why: 'busy' });

    // A facade that throws is a service that is still paused.
    facade = facadeWith({ state, recheck: new Error('boom') });
    page = context();
    assert.deepEqual(await handleVersionAction('check-service', { facade, ...page.context }), { ok: false, why: 'still_unavailable' });
});

// ---------------------------------------------------------------------------
// About to expire
// ---------------------------------------------------------------------------

test('wiring:near-expiry a balance about to expire pauses chats, says when to withdraw by, and never speaks of upgrading', async () => {
    freshDismissals();
    const state = derive({ snapshot: normalized('near_expiry') });
    const near = noticeOf(state, 'near');
    assert.ok(near);
    assert.equal(near.tone, 'attention');
    assert.equal(textOf(near), 'New chats are paused because this balance is about to expire. Withdraw it to get the unused '
        + `amount back. Start the withdrawal by ${FORMAT(new Date(1794770345000))}. If it expires, the service treasury can claim it.`);
    assert.doesNotMatch(textOf(near), /upgrad|newer version|deposit again/i);
    assert.deepEqual(actionsOf(near), ['open-withdraw']);
    assert.equal(near.actions[0].label, 'Withdraw');

    // The SDK's flag, not a clock rule: one hour farther from the deadline is not near.
    assert.equal(noticeOf(derive({ snapshot: normalized('just_outside_near_expiry') }), 'near'), undefined);

    // The instant has passed: the sentence reads whole without it.
    const late = noticeOf(derive({ snapshot: normalized('near_expiry'), now: 1794770345000 + SECOND }), 'near', 'dialog',
        { now: 1794770345000 + SECOND });
    assert.doesNotMatch(textOf(late), /Start the withdrawal by/);
    assert.match(textOf(late), /Withdraw it to get the unused amount back\. If it expires/);

    // On the version that takes deposits there is nothing to upgrade to; on a closed one the upgrade
    // notice is its own and the near notice is still not about upgrading.
    const closed = derive({ active: CLOSED, snapshot: normalized('near_expiry') });
    assert.ok(noticeOf(closed, 'upgrade'));
    assert.doesNotMatch(textOf(noticeOf(closed, 'near')), /upgrad/i);

    // The button opens the Withdraw view.
    const page = context();
    assert.deepEqual(await handleVersionAction('open-withdraw', { facade: facadeWith({ state }), ...page.context }), { ok: true });
    assert.deepEqual(page.events.dispatched, [['zkapi-payment-required', { view: 'withdraw' }]]);
});

test('wiring:near-expiry a chat key refused for it is a near balance before the snapshot says so', () => {
    freshDismissals();
    const snapshot = normalized('kit_out_of_date');
    assert.equal(noticeOf(derive({ snapshot }), 'near'), undefined);
    const refused = derive({ snapshot, exitRefusal: error('note_near_expiry') });
    assert.ok(noticeOf(refused, 'near'));
});

test('a set-aside balance on this version is told once, by its own notice, and the ticket keeps the notice it had', () => {
    freshDismissals();
    // The closed version holds the set-aside balance itself: the previous-withdrawal notice would say the
    // same deadline in the words of an upgrade ("Less than a day left to upgrade").
    const state = derive({ active: CLOSED, snapshot: normalized('withdrawals_alert_credited_defeated') });
    assert.equal(state.phase, 'finish-previous-withdrawal');
    assert.equal(state.previous.versionId, CLOSED.id);
    assert.ok(state.setAside.near > 0);
    for (const surface of ['panel', 'dialog']) {
        const ids = idsOf(state, surface);
        assert.equal(ids[0], 'setaside', `${surface}: ${ids.join()}`);
        assert.equal(ids.includes('previous'), false, surface);
        assert.equal(ids.includes('gate'), false, `${surface}: the closed-deposits gate is not said a second time`);
        assert.doesNotMatch(textOf(noticeOf(state, 'setaside', surface)), /upgrad/i);
    }
    // Funds at risk on the ticket surface: its notice is unchanged, and it never carries `setaside`.
    assert.deepEqual(idsOf(state, 'ticket'), ['previous']);

    // Another version's unfinished withdrawal is not this one's: both notices stay.
    const records = normalized('withdrawals_alert_credited_defeated');
    const other = derive({
        active: CLOSED,
        snapshot: {
            ...normalized('kit_never_exported'),
            otherDeploymentWithdrawals: normalized('other_deployments').otherDeploymentWithdrawals,
            otherDeploymentCredits: [],
            setAsideNear: records.setAsideNear
        }
    });
    assert.equal(other.phase, 'finish-previous-withdrawal');
    assert.notEqual(other.previous.versionId, CLOSED.id);
    assert.ok(other.setAside.near > 0);
    assert.deepEqual(idsOf(other, 'dialog').filter(id => ['previous', 'setaside'].includes(id)), ['previous', 'setaside']);

    // Without a balance near its deadline the previous-withdrawal notice is as it was.
    const calm = derive({ active: CLOSED, snapshot: { ...records, setAsideNear: [] } });
    assert.equal(calm.setAside.near, 0);
    assert.equal(calm.phase, 'finish-previous-withdrawal');
    assert.equal(calm.previous.versionId, CLOSED.id);
    assert.equal(idsOf(calm, 'dialog')[0], 'previous');
    assert.equal(idsOf(calm, 'dialog').includes('setaside'), false);
});

test('set-aside balances close to their deadline have their own notice, which opens Payment history', async () => {
    freshDismissals();
    const state = derive({ snapshot: normalized('withdrawals_alert_credited_defeated') });
    const setAside = noticeOf(state, 'setaside');
    assert.ok(setAside);
    assert.equal(textOf(setAside), 'A balance you set aside is close to its deadline. Finish withdrawing it from Payment history'
        + ` by ${FORMAT(new Date(1795003200000))}. A balance that is not withdrawn before it expires can be claimed by the service treasury.`);
    assert.deepEqual(actionsOf(setAside), ['open-payments']);
    const page = context();
    await handleVersionAction('open-payments', { facade: facadeWith({ state }), ...page.context });
    assert.deepEqual(page.events.dispatched, [['zkapi-payment-required', { view: 'withdrawals' }]]);
    // Nothing near: no notice.
    assert.equal(noticeOf(derive({ snapshot: normalized('kit_out_of_date') }), 'setaside'), undefined);
});

// ---------------------------------------------------------------------------
// Waits, locks and other devices
// ---------------------------------------------------------------------------

test('wiring:ownership-proof-wait a refused withdrawal says when it can be tried again, in the dialog, and blocks nothing', () => {
    freshDismissals();
    // The proof wait counts seconds from the refusal.
    const proof = derive({ snapshot: normalized('kit_never_exported'), exitRefusal: error('ownership_proof_wait') });
    const wait = noticeOf(proof, 'wait', 'dialog', { now: GENERATED });
    assert.equal(textOf(wait), 'Your earlier withdrawal request is about to expire. Try again in 4 seconds.');
    assert.equal(wait.tone, 'attention');
    assert.deepEqual(wait.actions, [], 'no button is taken away or added: the withdrawal button stays where it is');
    assert.equal(textOf(noticeOf(proof, 'wait', 'dialog', { now: GENERATED + 3 * SECOND })), 'Your earlier withdrawal request is about to expire. Try again in 1 second.');
    assert.equal(textOf(noticeOf(proof, 'wait', 'dialog', { now: GENERATED + 4 * SECOND })), 'Your earlier withdrawal request is about to expire. Try again in a few seconds.');

    // The settlement wait names when a normal withdrawal can go ahead, and the emergency exit.
    const settlement = derive({ snapshot: normalized('unresolved_request_settlement_wait'), exitRefusal: error('request_settlement_pending_withdraw') });
    assert.equal(textOf(noticeOf(settlement, 'wait')), 'A recent chat may still be settling, so a normal withdrawal waits for it '
        + `until ${FORMAT(new Date(1794766205000))}. You can wait, or leave now with an emergency exit, which takes longer to finish.`);

    // The release wait never mentions an exit RPC or what the person can do about the network.
    const release = derive({ snapshot: normalized('kit_never_exported'), exitRefusal: error('exit_release_pending') });
    assert.equal(textOf(noticeOf(release, 'wait')), versionCopyText('exit.releasePending'));
    assert.doesNotMatch(textOf(noticeOf(release, 'wait')), /rpc|endpoint|provider/i);

    // The wait is the dialog's: the withdrawal is made there.
    for (const state of [proof, settlement, release]) {
        assert.deepEqual(idsOf(state, 'dialog').filter(id => id === 'wait'), ['wait']);
        assert.equal(idsOf(state, 'panel').includes('wait'), false);
        assert.equal(idsOf(state, 'ticket').includes('wait'), false);
    }
    // A wait that ran out is not shown.
    assert.equal(noticeOf(derive({ snapshot: normalized('kit_never_exported'), exitRefusal: error('ownership_proof_wait'), now: GENERATED + 5 * SECOND }),
        'wait', 'dialog', { now: GENERATED + 5 * SECOND }), undefined);
});

test('a frozen balance is told how long, can still be withdrawn, and the words do not promise an end that is not known', async () => {
    freshDismissals();
    const state = derive({ snapshot: normalized('mutual_lock_with_ownership_proof') });
    const frozen = noticeOf(state, 'frozen');
    assert.ok(frozen);
    assert.match(textOf(frozen), /You can still withdraw\.$/);
    assert.deepEqual(actionsOf(frozen), ['open-withdraw']);
    assert.doesNotMatch(textOf(frozen), /resume after undefined|NaN|null/);
    // A lock the snapshot dates: the sentence carries the date.
    const dated = derive({ snapshot: normalized('escape_lock_released_proof') });
    assert.equal(/resume after /.test(textOf(noticeOf(dated, 'frozen'))) || /when it finishes/.test(textOf(noticeOf(dated, 'frozen'))), true);
    // Not frozen: no notice.
    assert.equal(noticeOf(derive({ snapshot: normalized('kit_out_of_date') }), 'frozen'), undefined);
});

test('wiring:device-not-newest a balance another device used is explained, not offered for a withdrawal that would be rejected', async () => {
    freshDismissals();
    const state = derive({ snapshot: normalized('device_not_newest_evidence') });
    const device = noticeOf(state, 'device');
    assert.ok(device);
    assert.equal(textOf(device), versionCopyText('exit.device'));
    assert.match(textOf(device), /another device or copy/);
    assert.match(textOf(device), /zkAPI companion tool/);
    // No in-app restore is promised: there is none.
    assert.doesNotMatch(textOf(device), /restore|import|recover/i);
    // The text says a withdrawal from here would be rejected, so it has no Withdraw button beside it.
    assert.deepEqual(actionsOf(device), []);
    assert.doesNotMatch(renderVersionBanner(state, { ...OPTIONS, surface: 'dialog' }), /open-withdraw/);
    // It is not also nudged to create a kit: this browser's copy is the older state.
    assert.equal(noticeOf(state, 'kit'), undefined);

    // Flagged records in Payment history: that is where the button goes.
    const records = derive({ snapshot: normalized('withdrawals_alert_credited_defeated') });
    assert.deepEqual(actionsOf(noticeOf(records, 'device')), ['open-payments']);
    // The slot flagged AND records flagged: the records still have their one place to go, and still
    // no Withdraw.
    const both = { ...records, exit: { ...(records.exit || state.exit), deviceNotNewest: true } };
    assert.deepEqual(actionsOf(noticeOf(both, 'device')), ['open-payments']);

    // A refused attempt flags the balance before the snapshot does.
    const refusal = error('device_not_newest_defeated');
    const refused = derive({ snapshot: normalized('kit_out_of_date'), exitRefusal: refusal });
    assert.ok(noticeOf(refused, 'device'));
    assert.equal(noticeOf(derive({ snapshot: normalized('kit_out_of_date') }), 'device'), undefined);
});

test('a balance this browser can not withdraw is not also told to withdraw it, by any other notice', () => {
    freshDismissals();
    const flagged = state => ({ ...state, exit: { ...state.exit, deviceNotNewest: true } });
    // About to expire AND used elsewhere: the explanation, and no "Withdraw it to get the unused amount back".
    const near = derive({ snapshot: normalized('device_not_newest_evidence'), exitRefusal: error('note_near_expiry') });
    assert.equal(near.exit.nearExpiry, true);
    assert.equal(near.exit.deviceNotNewest, true);
    assert.deepEqual(idsOf(near, 'dialog'), ['device']);
    assert.deepEqual(idsOf(near, 'panel'), ['device']);
    // The same balance that is not flagged still has its near notice and its button.
    assert.ok(noticeOf(derive({ snapshot: normalized('near_expiry') }), 'near'));
    // A frozen balance and a refused withdrawal's wait say "you can still withdraw" and "try again".
    const lock = derive({ snapshot: normalized('mutual_lock_with_ownership_proof'), exitRefusal: error('ownership_proof_wait') });
    assert.deepEqual(idsOf(lock, 'dialog').filter(id => ['frozen', 'wait', 'device'].includes(id)), ['wait', 'frozen']);
    assert.deepEqual(idsOf(flagged(lock), 'dialog').filter(id => ['frozen', 'wait', 'device'].includes(id)), ['device']);
    // Nothing on the page that is flagged offers a Withdraw button.
    for (const state of [near, flagged(lock), flagged(derive({ snapshot: normalized('near_expiry') }))]) {
        for (const surface of ['panel', 'dialog']) {
            assert.doesNotMatch(renderVersionBanner(state, { ...OPTIONS, surface }), /data-zkapi-version-action="open-withdraw"/, surface);
        }
    }
});

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

test('wiring:payout-alert a payout that came in under its bound is a persistent notice, dismissed for the page and never a toast', async () => {
    freshDismissals();
    const state = derive({ snapshot: normalized('withdrawals_alert_credited_defeated') });
    assert.equal(state.payouts.alerts, 1);
    const payout = noticeOf(state, 'payout');
    assert.ok(payout);
    assert.equal(payout.tone, 'attention');
    assert.equal(textOf(payout), versionCopyText('payout.alert'));
    assert.deepEqual(actionsOf(payout), ['open-payments', 'dismiss']);
    assert.equal(payout.dismissible, true);

    // Dismissing hides it on every surface that carries it, and says nothing.
    const page = context({ noticeId: 'payout' });
    const facade = facadeWith({ state });
    assert.deepEqual(await handleVersionAction('dismiss', { facade, state, ...page.context }), { ok: true });
    assert.deepEqual(page.events.notices, [], 'no toast');
    assert.equal(page.events.refreshes, 1);
    for (const surface of ['panel', 'dialog']) assert.equal(noticeOf(state, 'payout', surface), undefined, surface);

    // An alert that arrives later is a new notice, not the one that was dismissed.
    const more = { ...state, payouts: { ...state.payouts, alerts: 2 } };
    assert.ok(noticeOf(more, 'payout'));
    // Nothing alerted: no notice.
    assert.equal(noticeOf(derive({ snapshot: normalized('kit_out_of_date') }), 'payout'), undefined);
    freshDismissals();
    assert.ok(noticeOf(state, 'payout'), 'a reloaded page shows it again');
});

test('wiring:credited-payouts a payout the contract holds is "held", to be claimed from Payment history, never returned or sent', async () => {
    freshDismissals();
    const state = derive({ snapshot: normalized('withdrawals_alert_credited_defeated') });
    assert.equal(state.payouts.credited, 2);
    const claim = noticeOf(state, 'claim');
    assert.ok(claim);
    assert.equal(textOf(claim), '2 payouts are held for you. Open Payment history to claim them.');
    assert.doesNotMatch(textOf(claim), /returned|sent|refund/i);
    assert.deepEqual(actionsOf(claim), ['open-payments']);
    // One is singular.
    const one = { ...state, payouts: { credited: 1, alerts: 0 } };
    assert.equal(textOf(noticeOf(one, 'claim')), 'A payout is held for you. Open Payment history to claim it.');
    // Not dismissible: it is money waiting.
    assert.equal(noticeOf(one, 'claim').dismissible, false);
    const page = context({ noticeId: 'claim' });
    await handleVersionAction('dismiss', { facade: facadeWith({ state: one }), state: one, ...page.context });
    assert.ok(noticeOf(one, 'claim'), 'a dismissal does not hide it');
    freshDismissals();
});

test('wiring:other-deployment-withdrawals an operator notice shows its reference number beside its version, and note 0 is a reference', () => {
    freshDismissals();
    // The state carries `notices` from the real derivation (test/zkapi/zkapi-version-state.test.mjs);
    // one is placed by hand here only for the field this test is about, whose shape is the state's.
    const base = derive({ snapshot: normalized('kit_out_of_date') });
    const withNotice = (entry, extra = {}) => ({ ...base, notices: [entry], ...extra });

    const seven = noticeOf(withNotice({ versionId: 'v1', text: 'Finish the escape with the contract directly.', noteId: 7 }), 'operator-0', 'panel');
    assert.deepEqual(seven.paragraphs.map(paragraph => paragraph.text), [
        'Finish the escape with the contract directly.',
        'Reference number 7 for version 1.'
    ]);
    // Note 0 is the first note and a valid reference.
    const zero = noticeOf(withNotice({ versionId: 'v1', text: 'Finish it directly.', noteId: 0 }), 'operator-0', 'panel');
    assert.equal(zero.paragraphs.length, 2);
    assert.equal(zero.paragraphs[1].text, 'Reference number 0 for version 1.');
    // No note number: the operator's words alone, as before.
    const bare = noticeOf(withNotice({ versionId: 'v1', text: 'Finish it directly.', noteId: null }), 'operator-0', 'panel');
    assert.equal(bare.paragraphs.length, 1);
    const missing = noticeOf(withNotice({ versionId: 'v1', text: 'Finish it directly.' }), 'operator-0', 'panel');
    assert.equal(missing.paragraphs.length, 1);
    // A value that is not a note number is not a reference.
    for (const noteId of [-1, 1.5, '7', Number.NaN, {}, true]) {
        assert.equal(noticeOf(withNotice({ versionId: 'v1', text: 'x', noteId }), 'operator-0', 'panel').paragraphs.length, 1, String(noteId));
    }
    // A version this table does not know is not named by its raw id.
    const unknown = noticeOf(withNotice({ versionId: '8f3a-uuid', text: 'x', noteId: 3 }), 'operator-0', 'panel');
    assert.equal(unknown.paragraphs[1].text, 'Reference number 3.');
    // A retired version is called one.
    const retiredTable = TABLE.map(row => (row.id === 'v1' ? { ...row, status: 'retired' } : row));
    const retired = noticeOf(withNotice({ versionId: 'v1', text: 'x', noteId: 3 }), 'operator-0', 'panel', { table: retiredTable });
    assert.equal(retired.paragraphs[1].text, 'Reference number 3 for version 1, which has been retired.');
    // The operator's text and the reference are plain text, escaped, never markup.
    const html = renderVersionBanner(withNotice({ versionId: 'v1', text: '<b>Do this</b>', noteId: 4 }), { ...OPTIONS, surface: 'panel' });
    assert.doesNotMatch(html, /<b>/);
    assert.match(html, /Reference number 4 for version 1\./);
    // Never on the ticket surface, as before.
    assert.equal(idsOf(withNotice({ versionId: 'v1', text: 'x', noteId: 1 }), 'ticket').some(id => id.startsWith('operator')), false);
});

// ---------------------------------------------------------------------------
// The exit kit
// ---------------------------------------------------------------------------

test('wiring:exit-kit a balance with no kit, or one that was made and not saved, is asked for one; a stale kit is not a notice', () => {
    freshDismissals();
    const never = derive({ snapshot: normalized('kit_never_exported') });
    const kit = noticeOf(never, 'kit');
    assert.ok(kit);
    assert.equal(kit.tone, 'info');
    assert.equal(textOf(kit), versionCopyText('kit.never'));
    assert.deepEqual(actionsOf(kit), ['export-exit-kit', 'dismiss']);
    assert.equal(kit.actions[0].label, 'Create exit kit');

    // Created and not saved: attention, not dismissible (the SDK counts it exported).
    const unsaved = derive({ snapshot: normalized('kit_out_of_date'), kitUnsaved: true });
    const warning = noticeOf(unsaved, 'kit');
    assert.equal(warning.tone, 'attention');
    assert.equal(textOf(warning), versionCopyText('kit.unsaved'));
    assert.deepEqual(actionsOf(warning), ['export-exit-kit']);
    assert.equal(warning.dismissible, false);

    // A kit that is merely older than the latest chats is the balance card's row, not a banner.
    const stale = derive({ snapshot: normalized('kit_out_of_date') });
    assert.equal(stale.exit.kit.exported, true);
    assert.equal(stale.exit.kit.outOfDate, true);
    assert.equal(noticeOf(stale, 'kit'), undefined);

    // Dismissing the "never created" prompt hides it for the page; it does not hide the "not saved" one.
    dismissVersionNotice('kit');
    assert.equal(noticeOf(never, 'kit'), undefined);
    assert.ok(noticeOf(unsaved, 'kit'));
    freshDismissals();
});

test('wiring:exit-kit the button opens the dialog and tells the facade what became of the file', async () => {
    freshDismissals();
    const state = derive({ snapshot: normalized('kit_never_exported') });
    const run = async (outcome, members = {}) => {
        const calls = [];
        const facade = facadeWith({
            state,
            members: {
                exportExitKit: async passphrase => { calls.push(['export', passphrase]); return 'KIT'; },
                noteKitSaved: saved => { calls.push(['noteKitSaved', saved]); },
                ...members
            }
        });
        const page = context();
        let opened = null;
        const result = await handleVersionAction('export-exit-kit', {
            facade,
            ...page.context,
            openExitKit: options => {
                opened = options;
                return { close() {}, result: Promise.resolve(outcome) };
            }
        });
        return { calls, result, opened, page };
    };

    // Saved: the facade learns the kit is saved, and the page redraws.
    let ran = await run({ saved: true, created: true });
    assert.deepEqual(ran.result, { ok: true });
    assert.deepEqual(ran.calls, [['noteKitSaved', true]]);
    assert.equal(ran.page.events.refreshes, 1);
    // The dialog's export is the facade's, with the passphrase as given.
    assert.equal(await ran.opened.exportKit('PASS-PHRASE'), 'KIT');
    assert.deepEqual(ran.calls.at(-1), ['export', 'PASS-PHRASE']);

    // Created and not saved: said, so the notice keeps asking this page session.
    ran = await run({ saved: false, created: true });
    assert.deepEqual(ran.result, { ok: false, why: 'not_saved' });
    assert.deepEqual(ran.calls, [['noteKitSaved', false]]);

    // Cancelled before anything was made: nothing to say.
    ran = await run({ saved: false, created: false });
    assert.deepEqual(ran.result, { ok: false, why: 'not_saved' });
    assert.deepEqual(ran.calls, []);

    // A dialog that reports only whether the file was saved (no word on whether a kit was made) is
    // taken at its word: not saved is said, saved is said.
    ran = await run({ saved: false });
    assert.deepEqual(ran.result, { ok: false, why: 'not_saved' });
    assert.deepEqual(ran.calls, [['noteKitSaved', false]]);
    ran = await run({ saved: true });
    assert.deepEqual(ran.calls, [['noteKitSaved', true]]);

    // A dialog that gave no answer at all says nothing, and the click is not an error.
    ran = await run(null);
    assert.deepEqual(ran.result, { ok: false, why: 'not_saved' });
    assert.deepEqual(ran.calls, []);

    // A facade that can not tell is not an error, and neither is one that throws.
    ran = await run({ saved: true, created: true }, { noteKitSaved: undefined });
    assert.deepEqual(ran.result, { ok: true });
    ran = await run({ saved: true, created: true }, { noteKitSaved: () => { throw new Error('x'); } });
    assert.deepEqual(ran.result, { ok: true });

    // A client with no way to make a kit says so and opens nothing.
    const page = context();
    let opened = false;
    const none = await handleVersionAction('export-exit-kit', {
        facade: facadeWith({ state }), ...page.context, openExitKit: () => { opened = true; }
    });
    assert.deepEqual(none, { ok: false, why: 'unavailable' });
    assert.equal(opened, false);
    assert.deepEqual(page.events.notices, ['This browser can’t create an exit kit.']);
});

test('wiring:exit-kit the real dialog, driven end to end through the button', async () => {
    freshDismissals();
    const doc = createDocument();
    const calls = [];
    const facade = facadeWith({
        state: derive({ snapshot: normalized('kit_never_exported') }),
        members: {
            exportExitKit: async passphrase => {
                calls.push(['export', passphrase]);
                return JSON.stringify({
                    format: 'zkapi-exit-kit-v1',
                    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: 'vUKxt2x70xzwmSNJ1ALPYQ==' },
                    cipher: { name: 'AES-256-GCM', iv: '+p8NzqNzsBFTamwD' },
                    ciphertext: 'U21leLs1D/1QFvelUBItpURd3EXycAzPcY0vXGm8BSDhClc3rmyL6DSKbfCy8wp2BqO2iZjZ'
                });
            },
            noteKitSaved: saved => calls.push(['noteKitSaved', saved])
        }
    });
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = blob => { calls.push(['url', blob.size > 0]); return 'blob:real'; };
    URL.revokeObjectURL = () => {};
    const originalCreateElement = doc.createElement.bind(doc);
    doc.createElement = tag => {
        const element = originalCreateElement(tag);
        if (tag === 'a') element.click = () => calls.push(['download', element.download]);
        return element;
    };
    try {
        const page = context();
        const pending = handleVersionAction('export-exit-kit', { facade, doc, ...page.context });
        const dialog = doc.body.querySelector('[data-zkapi-exit-kit-dialog]');
        assert.ok(dialog);
        const passphrase = dialog.querySelector('[data-zkapi-kit-passphrase]').textContent;
        const input = dialog.querySelector('[data-zkapi-kit-retype]');
        input.value = passphrase;
        input.dispatchEvent(new MiniEvent('input'));
        dialog.querySelector('[data-zkapi-kit-action="create"]').click();
        await new Promise(resolve => setImmediate(resolve));
        dialog.querySelector('[data-zkapi-kit-action="save"]').click();
        dialog.querySelector('[data-zkapi-kit-action="done"]').click();
        assert.deepEqual(await pending, { ok: true });
        assert.deepEqual(calls.map(call => call[0]), ['export', 'url', 'download', 'noteKitSaved']);
        assert.equal(calls[0][1], passphrase);
        assert.equal(calls[3][1], true);
        assert.match(calls[2][1], /^oa-chat-exit-kit-\d{4}-\d{2}-\d{2}\.json$/);
    } finally {
        URL.createObjectURL = originalCreate;
        URL.revokeObjectURL = originalRevoke;
    }
});

test('wiring:exit-kit a dialog that closes late does not undo a kit that a newer dialog saved', async () => {
    freshDismissals();
    const state = derive({ snapshot: normalized('kit_never_exported') });
    const told = [];
    const facade = facadeWith({
        state,
        members: { exportExitKit: async () => 'KIT', noteKitSaved: saved => told.push(saved) }
    });
    // The first dialog was closed mid-export: it reports only when the SDK answers.
    let answerFirst;
    const first = handleVersionAction('export-exit-kit', {
        facade, ...context().context,
        openExitKit: () => ({ close() {}, result: new Promise(resolve => { answerFirst = resolve; }) })
    });
    // A second one is opened and saves a kit meanwhile.
    const second = await handleVersionAction('export-exit-kit', {
        facade, ...context().context,
        openExitKit: () => ({ close() {}, result: Promise.resolve({ saved: true, created: true }) })
    });
    assert.deepEqual(second, { ok: true });
    assert.deepEqual(told, [true]);
    // The first one's late answer is "created, not saved": true of its own kit, not of the balance.
    answerFirst({ saved: false, created: true });
    assert.deepEqual(await first, { ok: false, why: 'not_saved' });
    assert.deepEqual(told, [true], 'the page is not told the kit is unsaved');

    // The other order is as it was: a later dialog that does not save is "not saved".
    const third = await handleVersionAction('export-exit-kit', {
        facade, ...context().context,
        openExitKit: () => ({ close() {}, result: Promise.resolve({ saved: false, created: true }) })
    });
    assert.deepEqual(third, { ok: false, why: 'not_saved' });
    assert.deepEqual(told, [true, false]);
});

// ---------------------------------------------------------------------------
// Giving up a balance
// ---------------------------------------------------------------------------

const ZERO_VERDICT = { available: true, kind: 'zero', blockedBy: null };
const DUST_VERDICT = { available: true, kind: 'dust', blockedBy: null };

test('an empty or very small balance on a closed version is offered to be given up instead of an upgrade', async () => {
    freshDismissals();
    const snapshot = normalized('kit_never_exported');
    const withUpgrade = derive({ active: CLOSED, snapshot });
    assert.deepEqual(idsOf(withUpgrade, 'dialog').slice(0, 1), ['upgrade']);

    const zero = derive({ active: CLOSED, snapshot, abandon: ZERO_VERDICT });
    assert.equal(zero.abandon.available, true);
    const clear = noticeOf(zero, 'abandon');
    assert.equal(clear.tone, 'info');
    assert.equal(textOf(clear), 'This balance is empty, and version 2 no longer takes deposits. Clear it to deposit into '
        + 'version 3. Nothing moves on Ethereum.');
    assert.deepEqual(actionsOf(clear), ['abandon-open'], 'an empty balance has nothing to withdraw instead');
    assert.equal(clear.actions[0].label, 'Clear this balance');
    // It replaces the upgrade prompt, and the closed-deposits gate is not said a second time.
    assert.deepEqual(idsOf(zero, 'dialog'), ['abandon']);
    assert.deepEqual(idsOf(zero, 'panel'), ['abandon']);
    // The exit kit of a balance that is about to be cleared is not asked for.
    assert.equal(noticeOf(zero, 'kit'), undefined);

    const dust = derive({ active: CLOSED, snapshot, abandon: DUST_VERDICT });
    const give = noticeOf(dust, 'abandon');
    assert.equal(textOf(give), 'This balance is very small, and version 2 no longer takes deposits. A withdrawal costs a network '
        + 'fee, which may be more than this balance is worth. You can give it up to deposit into version 3, or withdraw it instead.');
    assert.deepEqual(actionsOf(give), ['abandon-open', 'upgrade']);
    assert.deepEqual(give.actions.map(action => action.label), ['Give up this balance', 'Withdraw instead']);
    assert.equal(give.actions[1].kind, 'secondary');
    assert.equal(noticeOf(dust, 'upgrade'), undefined, 'the upgrade notice is hidden while giving up is on offer');
    assert.deepEqual(idsOf(dust, 'dialog'), ['abandon']);

    // The ticket surface has no dialog to give up from, so it never carries the give-up notice. With
    // this balance's own deadline out of the reminders the upgrade note is the neutral one, and that
    // surface carries no neutral note: nothing here puts funds at risk.
    assert.equal(withUpgrade.phase, 'upgrade-soon');
    assert.deepEqual(idsOf(withUpgrade, 'ticket'), ['upgrade']);
    assert.equal(dust.phase, 'upgrade-available');
    assert.deepEqual(idsOf(dust, 'ticket'), []);

    // A verdict that says no leaves the upgrade as it was.
    const blocked = derive({ active: CLOSED, snapshot, abandon: { available: false, kind: null, blockedBy: 'not_dust' } });
    assert.deepEqual(idsOf(blocked, 'dialog'), idsOf(withUpgrade, 'dialog'));
    assert.equal(noticeOf(blocked, 'abandon'), undefined);

    // A balance that is about to be given up is not also told to withdraw before it expires.
    const expiring = derive({ active: CLOSED, snapshot: normalized('near_expiry'), abandon: DUST_VERDICT });
    assert.equal(expiring.exit.nearExpiry, true);
    assert.deepEqual(idsOf(expiring, 'dialog'), ['abandon']);
    assert.ok(noticeOf(derive({ active: CLOSED, snapshot: normalized('near_expiry') }), 'near'), 'without the verdict it is');

    // While the page must reload first, nothing is offered: the verdict was about a page out of date.
    const moved = derive({
        active: CLOSED, snapshot, abandon: DUST_VERDICT, previewSelection: selectionFor(LIVE, { reason: 'runtime_holds_note' })
    });
    assert.equal(moved.phase, 'reload-required');
    assert.deepEqual(idsOf(moved, 'dialog'), ['reload']);
});

test('another version’s unfinished business is not hidden by an empty balance here', () => {
    freshDismissals();
    // This browser holds an empty balance on the closed version, and another version still has
    // withdrawals open: the previous-version notice stays first, and the give-up notice is added to
    // it, not put in its place.
    const snapshot = {
        ...normalized('kit_never_exported'),
        otherDeploymentWithdrawals: normalized('other_deployments').otherDeploymentWithdrawals,
        otherDeploymentCredits: []
    };
    const state = derive({ active: CLOSED, snapshot, abandon: ZERO_VERDICT });
    assert.equal(state.phase, 'finish-previous-withdrawal');
    assert.equal(state.abandon.available, true);
    for (const surface of ['panel', 'dialog']) {
        assert.deepEqual(idsOf(state, surface), ['previous', 'abandon'], surface);
    }
    // The ticket surface keeps the previous version's notice, which is what puts funds at risk there.
    assert.deepEqual(idsOf(state, 'ticket'), ['previous']);
    // And the same balance without the verdict is the same page minus the give-up.
    assert.deepEqual(idsOf(derive({ active: CLOSED, snapshot }), 'dialog').filter(id => id !== 'kit'), ['previous']);
});

test('the "Give up" buttons: a missing preview says so, and the dialog is given the facade’s answer to ask with', async () => {
    freshDismissals();
    const state = derive({ active: CLOSED, snapshot: normalized('kit_never_exported'), abandon: DUST_VERDICT });
    const preview = {
        kind: 'dust', noteId: 4, balanceUnits: '140000', limitUnits: '333334', balanceUsdMicros: 420000,
        limitUsdMicros: 1000000, expiryMs: null, currentLabel: 'Version 2', targetLabel: 'Version 3'
    };

    // No preview (the verdict changed since the page drew): nothing opens.
    let page = context();
    let opened = false;
    let facade = facadeWith({ state, members: { abandonPreview: () => null, giveUpBalance: async () => ({ done: true }) } });
    assert.deepEqual(await handleVersionAction('abandon-open', {
        facade, ...page.context, openAbandon: () => { opened = true; }
    }), { ok: false, why: 'unavailable' });
    assert.equal(opened, false);
    assert.deepEqual(page.events.notices, ['This balance can’t be given up right now.']);
    assert.equal(page.events.refreshes, 1);

    // A facade without the action at all.
    page = context();
    assert.deepEqual(await handleVersionAction('abandon-open', {
        facade: facadeWith({ state }), ...page.context, openAbandon: () => { opened = true; }
    }), { ok: false, why: 'unavailable' });
    assert.equal(opened, false);

    // With a preview: the dialog gets it, and "give up" is the facade's own, with the arguments as given.
    const asked = [];
    facade = facadeWith({
        state,
        members: {
            abandonPreview: () => preview,
            giveUpBalance: async args => { asked.push(args); return { done: true, kind: 'dust' }; }
        }
    });
    page = context();
    let options = null;
    const result = await handleVersionAction('abandon-open', {
        facade, ...page.context,
        openAbandon: given => {
            options = given;
            return { close() {}, result: Promise.resolve({ done: true, kind: 'dust', why: null }) };
        }
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(options.preview, preview);
    assert.deepEqual(await options.giveUp({ noteId: 4, balanceUnits: '140000' }), { done: true, kind: 'dust' });
    assert.deepEqual(asked, [{ noteId: 4, balanceUnits: '140000' }]);
    assert.equal(page.events.refreshes, 1);

    // A dialog that ended without giving up says why it ended.
    for (const [outcome, expected] of [
        [{ done: false, kind: null, why: 'lock_busy' }, { ok: false, why: 'lock_busy' }],
        [{ done: false, kind: null, why: null }, { ok: false, why: 'cancelled' }]
    ]) {
        const closing = await handleVersionAction('abandon-open', {
            facade, ...context().context, openAbandon: () => ({ close() {}, result: Promise.resolve(outcome) })
        });
        assert.deepEqual(closing, expected);
    }
});

test('after a give-up, "Reload" goes where the facade says, not where the page stood when it was clicked', async () => {
    freshDismissals();
    const stale = derive({ active: CLOSED, snapshot: normalized('kit_never_exported'), abandon: DUST_VERDICT });
    assert.equal(stale.reload.required, false);
    // What the facade says once the balance is gone: reload into the version that takes deposits.
    const after = { ...stale, reload: { required: true, canReload: true, reason: 'previous_withdrawal_finished', targetId: 'v3' } };
    const facade = facadeWith({
        state: after,
        members: {
            abandonPreview: () => ({ kind: 'dust', noteId: 1, balanceUnits: '5', limitUnits: '9', balanceUsdMicros: null,
                limitUsdMicros: null, expiryMs: null, currentLabel: 'Version 2', targetLabel: 'Version 3' }),
            giveUpBalance: async () => ({ done: true, kind: 'dust' })
        }
    });
    const page = context();
    await handleVersionAction('abandon-open', {
        facade, state: stale, ...page.context,
        openAbandon: options => {
            options.reload();
            return { close() {}, result: Promise.resolve({ done: true, kind: 'dust', why: null }) };
        }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(facade.calls.filter(call => call[0] === 'switch'),
        [['switch', { reason: 'previous_withdrawal_finished', view: null }]]);
    assert.equal(page.events.reloads, 0, 'it went through the facade’s guarded switch, not a bare reload');
});

test('the real give-up dialog, driven end to end through the button', async () => {
    freshDismissals();
    const doc = createDocument();
    const asked = [];
    const facade = facadeWith({
        state: derive({ active: CLOSED, snapshot: normalized('kit_never_exported'), abandon: ZERO_VERDICT }),
        members: {
            abandonPreview: () => ({ kind: 'zero', noteId: 2, balanceUnits: '0', limitUnits: null, balanceUsdMicros: 0,
                limitUsdMicros: null, expiryMs: null, currentLabel: 'Version 2', targetLabel: 'Version 3' }),
            giveUpBalance: async args => { asked.push(args); return { done: true, kind: 'zero' }; }
        }
    });
    const page = context();
    const pending = handleVersionAction('abandon-open', { facade, doc, ...page.context });
    const dialog = doc.body.querySelector('[data-zkapi-abandon-dialog]');
    assert.ok(dialog);
    dialog.querySelector('[data-zkapi-abandon-action="confirm"]').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(asked, [{ noteId: 2, balanceUnits: '0' }]);
    dialog.querySelector('[data-zkapi-abandon-action="close"]').click();
    assert.deepEqual(await pending, { ok: true });
});

// ---------------------------------------------------------------------------
// Where each notice goes
// ---------------------------------------------------------------------------

test('panel placement: every notice reaches the panel and the dialog, the wait only the dialog, the ticket none of them', () => {
    freshDismissals();
    // Everything at once: a lock that freezes the balance, a refused withdrawal that has to wait, a
    // payout that came in short, payouts that are held, a set-aside balance close to its deadline, a
    // balance another device used, and a kit that was never made.
    const records = normalized('withdrawals_alert_credited_defeated');
    const loaded = derive({
        snapshot: {
            ...normalized('mutual_lock_with_ownership_proof'),
            ownCredits: records.ownCredits,
            payoutAlerts: records.payoutAlerts,
            setAsideNear: records.setAsideNear,
            deviceNotNewestRecords: records.deviceNotNewestRecords
        },
        exitRefusal: error('ownership_proof_wait')
    });
    const everyId = ['wait', 'frozen', 'device', 'payout', 'claim', 'setaside', 'kit'];
    const dialog = idsOf(loaded, 'dialog');
    for (const id of everyId) assert.ok(dialog.includes(id), `${id} on the dialog: ${dialog.join()}`);
    const panel = idsOf(loaded, 'panel');
    for (const id of everyId.filter(id => id !== 'wait')) assert.ok(panel.includes(id), `${id} on the panel: ${panel.join()}`);
    assert.equal(panel.includes('wait'), false);
    assert.deepEqual(idsOf(loaded, 'ticket'), [], 'the ticket surface carries none of them');
    // Near, in its own state.
    const near = derive({ snapshot: normalized('near_expiry') });
    assert.ok(idsOf(near, 'panel').includes('near'));
    assert.ok(idsOf(near, 'dialog').includes('near'));
    assert.equal(idsOf(near, 'ticket').includes('near'), false);
});

test('whatever the state, the ticket surface holds only what put funds at risk before', () => {
    freshDismissals();
    const allowed = new Set(['upgrade', 'previous', 'credit']);
    for (const name of Object.keys(FIXTURE.scenarios)) {
        for (const active of [CLOSED, LIVE]) {
            const state = derive({ active, snapshot: normalized(name) });
            for (const id of idsOf(state, 'ticket')) assert.ok(allowed.has(id), `${name}/${active.id}: ${id}`);
            for (const surface of ['panel', 'dialog']) {
                // Every notice has an id of its own.
                const ids = idsOf(state, surface);
                assert.equal(new Set(ids).size, ids.length, `${name}/${active.id}/${surface}: ${ids.join()}`);
            }
        }
    }
});

test('a build with one protocol family, and a v1 page, show none of the new notices', () => {
    freshDismissals();
    const legacy = derive({
        active: TABLE[0],
        snapshot: normalizedSnapshot({ hasNote: true, expiryTs: Math.floor(GENERATED / 1000) + 20 * 86_400,
            deadlines: [{ source: 'slot', expiryTs: Math.floor(GENERATED / 1000) + 20 * 86_400 }] })
    });
    assert.equal(legacy.exit, null);
    const fresh = new Set(['near', 'wait', 'frozen', 'device', 'payout', 'claim', 'setaside', 'kit', 'abandon']);
    for (const surface of ['panel', 'dialog', 'ticket']) {
        for (const id of idsOf(legacy, surface)) assert.equal(fresh.has(id), false, `${surface}: ${id}`);
    }
    // And the unavailable state, which has every new key empty: it says the page could not start and
    // none of the notices about a balance.
    const unavailable = deriveVersionState({});
    assert.equal(unavailable.exit, null);
    assert.equal(unavailable.abandon, null);
    assert.deepEqual(unavailable.payouts, { credited: 0, alerts: 0 });
    assert.equal(unavailable.setAside.near, 0);
    for (const surface of ['panel', 'dialog', 'ticket']) {
        for (const id of idsOf(unavailable, surface)) assert.equal(fresh.has(id), false, `${surface}: ${id}`);
    }
});

// ---------------------------------------------------------------------------
// Structure, signatures and the clock patch
// ---------------------------------------------------------------------------

test('notices whose words move with the clock say so, and the others do not', () => {
    freshDismissals();
    const records = normalized('withdrawals_alert_credited_defeated');
    const everything = derive({
        snapshot: {
            ...normalized('mutual_lock_with_ownership_proof'),
            ownCredits: records.ownCredits, payoutAlerts: records.payoutAlerts,
            setAsideNear: records.setAsideNear, deviceNotNewestRecords: records.deviceNotNewestRecords
        },
        exitRefusal: error('ownership_proof_wait')
    });
    const near = derive({ snapshot: normalized('near_expiry') });
    const marked = new Set();
    const unmarked = new Set();
    for (const state of [everything, near]) {
        const root = mount(renderVersionBanner(state, { ...OPTIONS, surface: 'dialog' }));
        for (const holder of root.querySelectorAll('[data-zkapi-version-notice]')) {
            const id = holder.getAttribute('data-zkapi-version-notice');
            (holder.hasAttribute('data-zkapi-version-clock') ? marked : unmarked).add(id);
        }
    }
    assert.deepEqual([...marked].sort(), ['frozen', 'near', 'setaside', 'wait']);
    for (const id of ['device', 'payout', 'claim', 'kit']) assert.ok(unmarked.has(id), id);
    // It names words that move: a wait is counted from the clock and goes when it runs out.
    const wait = mount(renderVersionBanner(everything, { ...OPTIONS, surface: 'dialog' }));
    assert.equal(wait.querySelector('[data-zkapi-version-notice="wait"]').hasAttribute('data-zkapi-version-clock'), true);
    // The attribute is not structure: a block with and without it has the same signature.
    assert.equal(buildVersionNotices(near, { ...OPTIONS, surface: 'dialog' }).signature, 'near:attention:1:open-withdraw|kit:info:1:export-exit-kit,dismiss');
});

test('the signature is structure only: text that moves with the clock does not change it, a new notice does', () => {
    freshDismissals();
    const state = derive({ snapshot: normalized('kit_never_exported'), exitRefusal: error('ownership_proof_wait') });
    const first = buildVersionNotices(state, { ...OPTIONS, surface: 'dialog', now: GENERATED });
    const later = buildVersionNotices(state, { ...OPTIONS, surface: 'dialog', now: GENERATED + 2 * SECOND });
    assert.notEqual(textOf(first.notices[0]), textOf(later.notices[0]), 'the countdown moved');
    assert.equal(first.signature, later.signature);
    assert.match(first.signature, /^wait:attention:1:\|kit:info:1:export-exit-kit,dismiss$/);

    // A notice that is added or dropped, or whose buttons change, is a different block.
    const without = buildVersionNotices(derive({ snapshot: normalized('kit_never_exported') }), { ...OPTIONS, surface: 'dialog' });
    assert.notEqual(without.signature, first.signature);
    const unsaved = buildVersionNotices(derive({ snapshot: normalized('kit_never_exported'), kitUnsaved: true }), { ...OPTIONS, surface: 'dialog' });
    assert.notEqual(unsaved.signature, without.signature, 'the tone changed with the kit being unsaved');
    // A reference line comes and goes with a note number and is reconciled by the patch itself, so it
    // is not structure: the same block with and without one has the same signature.
    const base = derive({ snapshot: normalized('kit_out_of_date') });
    const one = buildVersionNotices({ ...base, notices: [{ versionId: 'v1', text: 'x', noteId: null }] }, { ...OPTIONS, surface: 'panel' });
    const two = buildVersionNotices({ ...base, notices: [{ versionId: 'v1', text: 'x', noteId: 3 }] }, { ...OPTIONS, surface: 'panel' });
    assert.equal(one.notices[0].paragraphs.length, 1);
    assert.equal(two.notices[0].paragraphs.length, 2);
    assert.equal(one.signature, two.signature);
});

// What the page holds on a surface: the pill beside the banner (the patch reconciles both).
function mount(html) {
    const doc = createDocument();
    const root = doc.createElement('div');
    root.innerHTML = html;
    doc.body.append(root);
    return root;
}

const mountedBlock = (state, options) => mount(`${renderVersionBadge(state, { surface: options.surface === 'dialog' ? 'dialog' : 'panel' })}`
    + `${renderVersionBanner(state, options)}`);

test('a clock tick patches the words of a notice in place and renders nothing when the structure is the same', () => {
    freshDismissals();
    const state = derive({ snapshot: normalized('kit_never_exported'), exitRefusal: error('ownership_proof_wait') });
    const options = { ...OPTIONS, surface: 'dialog', now: GENERATED };
    const root = mountedBlock(state, options);
    const read = () => root.querySelector('[data-zkapi-version-notice="wait"] [data-zkapi-version-text]').textContent;
    assert.equal(read(), 'Your earlier withdrawal request is about to expire. Try again in 4 seconds.');

    assert.deepEqual(patchVersionNotices(root, state, { ...options, now: GENERATED + 2 * SECOND }), { needsRender: false });
    assert.equal(read(), 'Your earlier withdrawal request is about to expire. Try again in 2 seconds.');

    // A new notice is a render, and nothing was touched on the way to saying so.
    const richer = derive({ snapshot: normalized('kit_never_exported'), exitRefusal: error('ownership_proof_wait'), kitUnsaved: true });
    assert.deepEqual(patchVersionNotices(root, richer, { ...options, now: GENERATED + 2 * SECOND }), { needsRender: true });
    assert.equal(read(), 'Your earlier withdrawal request is about to expire. Try again in 2 seconds.');
    // So is one that is gone.
    const gone = derive({ snapshot: normalized('kit_out_of_date') });
    assert.deepEqual(patchVersionNotices(root, gone, options), { needsRender: true });
});

test('an operator notice’s reference line is added by a render, changed in place and taken away in place', () => {
    freshDismissals();
    const base = derive({ snapshot: normalized('kit_out_of_date') });
    const withNotice = entry => ({ ...base, notices: [entry] });
    const options = { ...OPTIONS, surface: 'panel' };
    const words = root => root.querySelectorAll('[data-zkapi-version-notice="operator-0"] [data-zkapi-version-text]')
        .map(node => node.textContent);

    // Drawn with a note number, then the number changes: the line is patched where it is.
    const root = mountedBlock(withNotice({ versionId: 'v1', text: 'Finish it directly.', noteId: 7 }), options);
    assert.deepEqual(words(root), ['Finish it directly.', 'Reference number 7 for version 1.']);
    assert.ok(root.querySelector('[data-zkapi-version-reference]'));
    assert.deepEqual(patchVersionNotices(root, withNotice({ versionId: 'v1', text: 'Finish it directly.', noteId: 9 }), options),
        { needsRender: false });
    assert.deepEqual(words(root), ['Finish it directly.', 'Reference number 9 for version 1.']);

    // The state stops carrying one: the line goes, so no number is left on the page that the state
    // does not have. Nothing is rendered again for it.
    assert.deepEqual(patchVersionNotices(root, withNotice({ versionId: 'v1', text: 'Finish it directly.', noteId: null }), options),
        { needsRender: false });
    assert.deepEqual(words(root), ['Finish it directly.']);
    assert.equal(root.querySelector('[data-zkapi-version-reference]'), null);

    // Drawn without one, and one appears: only a render can add a line, and nothing is touched on the way.
    const bare = mountedBlock(withNotice({ versionId: 'v1', text: 'Finish it directly.', noteId: null }), options);
    assert.deepEqual(patchVersionNotices(bare, withNotice({ versionId: 'v1', text: 'Changed.', noteId: 4 }), options),
        { needsRender: true });
    assert.deepEqual(words(bare), ['Finish it directly.'], 'a render that is asked for finds the page as it was');
    assert.equal(patchVersionNotices(bare, withNotice({ versionId: 'v1', text: 'Changed.', noteId: null }), options).needsRender, false);
    assert.deepEqual(words(bare), ['Changed.']);

    // Another notice that is not a reference line, left over on the page, is a render.
    const extra = mountedBlock(withNotice({ versionId: 'v1', text: 'Two.', noteId: null }), options);
    const holder = extra.querySelector('[data-zkapi-version-notice="operator-0"]');
    holder.innerHTML = `${holder.innerHTML}<p class="zkapi-version-notice-text" data-zkapi-version-text="1">stray</p>`;
    assert.equal(patchVersionNotices(extra, withNotice({ versionId: 'v1', text: 'Two.', noteId: null }), options).needsRender, true);
});

test('host markup that changed re-renders the block, though no notice did', () => {
    freshDismissals();
    const state = derive({ snapshot: normalized('kit_never_exported') });
    const options = { ...OPTIONS, surface: 'panel' };
    const first = renderVersionBanner(state, { ...options, extra: '<p data-host>Exit kit: never</p>' });
    assert.match(first, /data-zkapi-version-sig="kit:info:1:export-exit-kit,dismiss\|\+"/, 'the legacy marker is kept');
    const digest = /data-zkapi-version-extra="([0-9a-z]+)"/.exec(first);
    assert.ok(digest, 'and a short digest of the markup is recorded');
    assert.ok(digest[1].length <= 7);

    const root = mount(`${renderVersionBadge(state, { surface: 'panel' })}${first}`);
    assert.deepEqual(patchVersionNotices(root, state, { ...options, extra: '<p data-host>Exit kit: never</p>' }), { needsRender: false });
    assert.deepEqual(patchVersionNotices(root, state, { ...options, extra: '<p data-host>Exit kit: created</p>' }), { needsRender: true });
    assert.deepEqual(patchVersionNotices(root, state, options), { needsRender: true }, 'markup that went away');

    // Same markup, same digest; other markup, another.
    const again = renderVersionBanner(state, { ...options, extra: '<p data-host>Exit kit: never</p>' });
    assert.equal(/data-zkapi-version-extra="([^"]+)"/.exec(again)[1], digest[1]);
    const other = renderVersionBanner(state, { ...options, extra: '<p data-host>Exit kit: created</p>' });
    assert.notEqual(/data-zkapi-version-extra="([^"]+)"/.exec(other)[1], digest[1]);
    // No markup: no attribute at all, as before.
    assert.doesNotMatch(renderVersionBanner(state, options), /data-zkapi-version-extra/);
    // A block rendered without host markup, now asked to carry some: a render.
    const bare = mountedBlock(state, options);
    assert.deepEqual(patchVersionNotices(bare, state, { ...options, extra: '<p data-host>x</p>' }), { needsRender: true });
});

test('the buttons of the new notices reach the actions through the banner’s own delegation', async () => {
    freshDismissals();
    const state = derive({ snapshot: normalized('withdrawals_alert_credited_defeated') });
    const root = mountedBlock(state, { ...OPTIONS, surface: 'dialog' });
    const page = context();
    attachVersionNotices(root, {
        facade: facadeWith({ state }), notify: page.context.notify, dispatch: page.context.dispatch,
        reload: page.context.reload, refresh: page.context.refresh
    });
    const payoutButtons = root.querySelectorAll('[data-zkapi-version-notice="payout"] [data-zkapi-version-action]');
    assert.deepEqual(payoutButtons.map(button => button.getAttribute('data-zkapi-version-action')), ['open-payments', 'dismiss']);
    payoutButtons[0].click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(page.events.dispatched, [['zkapi-payment-required', { view: 'withdrawals' }]]);
    // Dismissing goes through the same place, under the notice that holds the button.
    payoutButtons[1].click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.events.refreshes, 1);
    assert.equal(noticeOf(state, 'payout'), undefined);
    freshDismissals();
});

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const FORBIDDEN = /nullifier|vault|circuit|deployment|manifest|\bnotes?\b|note\s*#|#\s*\d|unlinkable|untraceable|anonymous|zero.knowledge|proof\b|escape hatch|mutual close|nothing is lost/i;

test('vocabulary: every notice, in every state, is plain words with no jargon, no unit shouting and no live region', () => {
    freshDismissals();
    const states = [];
    for (const name of Object.keys(FIXTURE.scenarios)) {
        for (const active of [CLOSED, LIVE]) states.push(derive({ active, snapshot: normalized(name) }));
    }
    const snapshot = normalized('kit_never_exported');
    for (const refusal of ['ownership_proof_wait', 'request_settlement_pending_withdraw', 'exit_release_pending',
        'exit_locked', 'device_not_newest_defeated', 'note_near_expiry']) {
        states.push(derive({ snapshot, exitRefusal: error(refusal) }));
    }
    states.push(derive({ active: CLOSED, snapshot, abandon: ZERO_VERDICT }));
    states.push(derive({ active: CLOSED, snapshot, abandon: DUST_VERDICT }));
    states.push(derive({ snapshot, kitUnsaved: true }));
    states.push({ ...derive({ snapshot }), notices: [{ versionId: 'v1', text: 'Finish it directly.', noteId: 0 }] });
    let checked = 0;
    for (const state of states) {
        for (const surface of ['panel', 'dialog']) {
            for (const entry of buildVersionNotices(state, { ...OPTIONS, surface }).notices) {
                const words = [textOf(entry), ...entry.actions.map(action => action.label)].join(' ');
                const where = `${entry.id}: ${words}`;
                assert.equal(FORBIDDEN.test(words), false, where);
                assert.equal(/!/.test(words), false, `${where}: exclamation`);
                assert.equal(/'/.test(words), false, `${where}: straight apostrophe`);
                assert.equal(/\p{Extended_Pictographic}/u.test(words), false, `${where}: emoji`);
                assert.equal(/\s{2,}|\s[.,;:?]/.test(words), false, `${where}: spacing`);
                assert.equal(/\b[A-Z]{3,}\b/.test(words), false, `${where}: shouting`);
                assert.equal(/[{}]/.test(words), false, `${where}: a token was left`);
                assert.equal(/undefined|NaN|\bnull\b/.test(words), false, `${where}: a missing value was printed`);
                checked += 1;
            }
            const html = renderVersionBanner(state, { ...OPTIONS, surface });
            // Banners are static text: no live region, no focus theft.
            assert.doesNotMatch(html, /aria-live|role="(?:status|alert)"|\bautofocus\b|tabindex/);
            assert.doesNotMatch(html, /0x[0-9a-f]{8}/i);
        }
    }
    assert.ok(checked > 60, `${checked} notices were checked`);
    // The copy keys the notices read are all in the shipped table.
    for (const key of ['near.balance', 'exit.settlement', 'exit.proofWait', 'exit.releasePending', 'exit.frozen',
        'exit.device', 'payout.alert', 'payout.notice', 'setAside.near', 'kit.never', 'kit.unsaved', 'abandon.zero',
        'abandon.dust', 'abandon.link', 'abandon.linkZero', 'service.check', 'service.stillPaused', 'operator.reference']) {
        assert.ok(COPY_KEYS.includes(key), key);
    }
});

test('unknown actions and a facade that is missing never throw into the page', async () => {
    freshDismissals();
    for (const action of ['check-service', 'open-withdraw', 'open-payments', 'export-exit-kit', 'abandon-open', 'nope']) {
        const page = context();
        const result = await handleVersionAction(action, { facade: null, ...page.context });
        assert.equal(typeof result.ok, 'boolean', action);
    }
    assert.deepEqual(await handleVersionAction('nope', {}), { ok: false, why: 'unknown_action' });
    // A facade whose members throw.
    const hostile = {
        state() { throw new Error('x'); },
        recheckService() { throw new Error('x'); },
        exportExitKit() { throw new Error('x'); },
        abandonPreview() { throw new Error('x'); },
        giveUpBalance() { throw new Error('x'); }
    };
    for (const action of ['check-service', 'abandon-open']) {
        const page = context();
        const result = await handleVersionAction(action, { facade: hostile, ...page.context });
        assert.equal(typeof result.ok, 'boolean', action);
    }
});

test('styling: every class the new notices use is one the app ships', () => {
    freshDismissals();
    const css = ['chat/tailwind.generated.css', 'chat/zkapi/zkapi.css', 'chat/styles.css']
        .map(file => fs.readFileSync(path.join(repoRoot, file), 'utf8')).join('\n');
    const escape = name => name.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
    const classes = new Set();
    const states = [
        derive({ snapshot: normalized('withdrawals_alert_credited_defeated') }),
        derive({ snapshot: normalized('near_expiry') }),
        derive({ snapshot: normalized('mutual_lock_with_ownership_proof') }),
        derive({ snapshot: normalized('kit_never_exported'), kitUnsaved: true }),
        derive({ active: CLOSED, snapshot: normalized('kit_never_exported'), abandon: DUST_VERDICT }),
        derive({ snapshot: normalized('service_changed') })
    ];
    for (const state of states) {
        const html = renderVersionBanner(state, { ...OPTIONS, surface: 'dialog' });
        for (const match of html.matchAll(/class="([^"]*)"/g)) match[1].split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
    }
    assert.ok(classes.size >= 6);
    // The tone and the surface are written into the class name as a hook (the look itself comes from
    // the utility classes beside it): a closed list, so a misspelt class anywhere else still fails.
    const hooks = new Set(['zkapi-version-notice--info', 'zkapi-version-notice--attention', 'zkapi-version-banner--panel']);
    for (const name of classes) {
        if (hooks.has(name)) continue;
        assert.ok(css.includes(`.${name}`) || css.includes(`.${escape(name)}`), `class ${name} is not in the shipped stylesheets`);
    }
});
