import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    explainZkapiError, isRetiringErrorCode, isDepositsClosed, isForeignWalletRefusal, isIndexerLag,
    isPreviousWithdrawalOpen, pendingDepositMessage, versionRefusalMessage, zkapiErrorMessage, INDEXER_LAG_MESSAGE
} from '../../chat/zkapi/services/zkapiErrorCopy.mjs';
import { installActiveVersion, resetActiveVersionForTests } from '../../chat/zkapi/versioning/activeVersion.mjs';
import { activatedRegistry, partialRevertRegistry, resolvedTable, validRegistry } from './_registryFixtures.mjs';

test('indexer lag is recognised by code or by the SDK wording, and told plainly', () => {
    const byCode = Object.assign(new Error('The zkAPI indexer is still catching up with the latest vault root. Try again in a few seconds.'), { code: 'indexer_root_lag' });
    const byText = new Error('The zkAPI indexer is still catching up with the latest vault root. Try again in a few seconds.');
    assert.ok(isIndexerLag(byCode));
    assert.ok(isIndexerLag(byText));
    assert.equal(zkapiErrorMessage(byText), INDEXER_LAG_MESSAGE);
    assert.match(INDEXER_LAG_MESSAGE, /Nothing was lost/);
    assert.match(INDEXER_LAG_MESSAGE, /within a minute/);
    assert.doesNotMatch(INDEXER_LAG_MESSAGE, /—/);

    explainZkapiError(byText);
    assert.equal(byText.message, INDEXER_LAG_MESSAGE);
    assert.equal(byText.code, 'indexer_root_lag');
});

test('other errors pass through untouched', () => {
    const error = Object.assign(new Error('insufficient funds'), { shortMessage: 'insufficient funds' });
    assert.equal(explainZkapiError(error), error);
    assert.equal(error.message, 'insufficient funds');
    assert.equal(zkapiErrorMessage(null, 'fallback'), 'fallback');
});

test('only saved, possibly submitted deposits turn a confirmation interruption into recovery copy', () => {
    const failure = Object.assign(new Error('RPC connection lost'), { broadcastPossible: true, transactionStage: 'receipt' });
    for (const phase of ['submitted', 'dropped_or_pending', 'awaiting_wallet', 'ambiguous']) {
        assert.match(pendingDepositMessage(failure, { phase }), /Check payment status before trying again/);
    }
    assert.equal(pendingDepositMessage(failure, null), null);
    assert.equal(pendingDepositMessage(failure, { phase: 'prepared' }), null);
    assert.equal(pendingDepositMessage(new Error('The mined deposit did not match this browser’s durable private note.'), { phase: 'submitted' }), null);
    assert.equal(pendingDepositMessage({ ...failure, broadcastPossible: false }, { phase: 'submitted' }), null);
    assert.equal(pendingDepositMessage({ ...failure, transactionReceipt: { status: '0x0' } }, { phase: 'submitted' }), null);
    assert.match(pendingDepositMessage(new Error('Timed out waiting for transaction 0xabc.'), { phase: 'submitted' }), /not yet confirmed/);
});

// ---------------------------------------------------------------------------
// Protocol versions
// ---------------------------------------------------------------------------

// activatedRegistry(): v1 exit-only (the previous version), v2 active.
const TABLE = resolvedTable(activatedRegistry(), 'mainnet');
const [V1, V2, ...EXTRA] = TABLE;
const SDK_REFUSAL = id => new Error(`This browser contains a wallet for ${id}. Switch back to that deployment before using or withdrawing it.`);
const selection = (version, overrides = {}) => ({
    version, reason: 'no_runtime_note', slotOwner: null, open: {}, credits: {}, foreignDeploymentId: null,
    depositBlock: null, draftDiscarded: false, slotKind: 'empty', ...overrides
});
const install = (version, overrides) => installActiveVersion({ table: TABLE, version, selection: selection(version, overrides) });
const FORBIDDEN = /nullifier|vault|circuit|deployment|manifest|note #|0x[0-9a-f]{8}/i;

test('the four version codes are recognised wherever the SDK or the host puts them', () => {
    assert.ok(isDepositsClosed(Object.assign(new Error('x'), { code: 'deposits_closed' })));
    assert.ok(!isDepositsClosed(new Error('deposits_closed')));
    assert.ok(isPreviousWithdrawalOpen(Object.assign(new Error('x'), { code: 'previous_withdrawal_open' })));
    assert.ok(isPreviousWithdrawalOpen(Object.assign(new Error('x'), { code: 'deposits_closed', data: { gateCode: 'previous_withdrawal_open' } })));
    for (const error of [
        Object.assign(new Error('x'), { code: 'deployment_retiring' }),
        Object.assign(new Error('x'), { status: 410, cause: { code: 'deployment_retiring' } }),
        Object.assign(new Error('x'), { data: { error: { code: 'deployment_retiring' } } })
    ]) assert.ok(isRetiringErrorCode(error));
    assert.ok(isForeignWalletRefusal(SDK_REFUSAL('anything-1')));
    assert.ok(!isForeignWalletRefusal(new Error('insufficient funds')));
    for (const check of [isDepositsClosed, isPreviousWithdrawalOpen, isRetiringErrorCode, isForeignWalletRefusal]) {
        for (const value of [null, undefined, 'text', 0, {}]) assert.equal(check(value), false);
    }
});

test('other errors keep their words even with a version installed', t => {
    t.after(() => resetActiveVersionForTests());
    install(V2);
    const error = Object.assign(new Error('insufficient funds'), { shortMessage: 'insufficient funds' });
    assert.equal(versionRefusalMessage(error), null);
    assert.equal(zkapiErrorMessage(error), 'insufficient funds');
    assert.equal(explainZkapiError(error).message, 'insufficient funds');
    for (const value of [null, undefined, 'x', 42]) assert.equal(versionRefusalMessage(value), null);
});

test('a closed version says where deposits went, in plain words', t => {
    t.after(() => resetActiveVersionForTests());
    install(V1);
    const sdk = Object.assign(new Error('This deployment no longer accepts new deposits. Existing balances and deposits already started can still be completed, recovered and withdrawn.'),
        { code: 'deposits_closed', status: 409 });
    assert.equal(zkapiErrorMessage(sdk), 'Deposits moved to version 2. This page is on version 1, which no longer accepts new deposits.');
    assert.doesNotMatch(zkapiErrorMessage(sdk), FORBIDDEN);
    explainZkapiError(sdk);
    assert.equal(sdk.message, 'Deposits moved to version 2. This page is on version 1, which no longer accepts new deposits.');
    assert.equal(sdk.code, 'deposits_closed', 'the code survives, so callers can still branch on it');
    assert.equal(explainZkapiError(sdk).message, sdk.message, 'rewriting is idempotent');

    // The host's own error carries the gate code it was refused for.
    const retiredSlot = Object.assign(new Error('x'), { code: 'deposits_closed', data: { gateCode: 'foreign_runtime' } });
    assert.match(zkapiErrorMessage(retiredSlot), /This browser holds a saved balance that this page can’t open/);
    const unreadable = Object.assign(new Error('x'), { code: 'deposits_closed', data: { gateCode: 'holdings_unreadable' } });
    assert.equal(zkapiErrorMessage(unreadable), 'We could not read your saved balance. Reload to try again. Nothing was changed.');
    const stale = Object.assign(new Error('x'), { code: 'deposits_closed', data: { gateCode: 'stale_build' } });
    assert.equal(zkapiErrorMessage(stale), 'Reload to update before depositing.');
    // The balance moved to another version in another tab: the reload notice's words.
    const moved = Object.assign(new Error('x'), { code: 'deposits_closed', data: { gateCode: 'reload_required' } });
    assert.equal(zkapiErrorMessage(moved),
        'This browser’s balance changed in another tab. Reload to keep going. Nothing is lost; your balance is saved in this browser.');
    assert.doesNotMatch(zkapiErrorMessage(moved), FORBIDDEN);

    // On a page with no version context (no table: nothing to tell apart) the
    // SDK's own words stand, exactly as they did before versions existed.
    resetActiveVersionForTests();
    assert.equal(zkapiErrorMessage(Object.assign(new Error('x'), { code: 'deposits_closed' })), 'x');
    assert.equal(versionRefusalMessage(Object.assign(new Error('x'), { code: 'deposits_closed' })), null);
});

test('another version’s unfinished withdrawal names it, or says "another version"', t => {
    t.after(() => resetActiveVersionForTests());
    const error = Object.assign(new Error('x'), { code: 'deposits_closed', data: { gateCode: 'previous_withdrawal_open' } });
    install(V2, { open: { v1: [{ recordId: 'r', noteId: 1, mode: 'mutual', phase: 'closed_unconfirmed', expiryTs: null }] } });
    assert.equal(zkapiErrorMessage(error),
        'A withdrawal from version 1 is still finishing. Open version 1 to finish it, then come back to deposit.');
    // While this page's own balance holds the wallet it can not be opened.
    resetActiveVersionForTests();
    install(V2, { slotOwner: 'v2', reason: 'runtime_holds_note', slotKind: 'note',
        open: { v1: [{ recordId: 'r', noteId: 1, mode: 'mutual', phase: 'closed_unconfirmed', expiryTs: null }] } });
    assert.match(zkapiErrorMessage(error), /withdraw your current balance first, then open version 1/);
    resetActiveVersionForTests();
    install(V2);
    assert.equal(zkapiErrorMessage(Object.assign(new Error('x'), { code: 'previous_withdrawal_open' })),
        'A withdrawal from another version is still finishing. Finish it first, then come back to deposit.');
});

test('a deployment that stopped starting chats points to withdrawing, not to retrying', t => {
    t.after(() => resetActiveVersionForTests());
    const error = Object.assign(new Error('Gone'), { status: 410, code: 'deployment_retiring' });
    install(V1);
    assert.equal(zkapiErrorMessage(error),
        'Version 1 is no longer starting new chats. Withdraw your balance, then deposit into version 2 to keep chatting.');
    // Nothing to tell apart: the SDK's own words (see the dormant test below).
    resetActiveVersionForTests();
    assert.equal(zkapiErrorMessage(error), 'Gone');
});

// A build with one active version (today's app) never shows a version number,
// so none of the four rewrites may name one: the SDK's words are the words.
test('a page with one active version shows the SDK’s own words for every refusal', t => {
    t.after(() => resetActiveVersionForTests());
    const single = resolvedTable(validRegistry(), 'mainnet');
    assert.equal(single.length, 1);
    const alone = { reason: 'single_version' };
    installActiveVersion({ table: single, version: single[0], selection: selection(single[0], alone) });
    const cases = [
        ['a retiring deployment', Object.assign(new Error('The deployment is no longer starting chats.'), { status: 410, code: 'deployment_retiring' })],
        ['closed deposits', Object.assign(new Error('This deployment no longer accepts new deposits.'), { code: 'deposits_closed', status: 409 })],
        ['closed deposits with a gate code', Object.assign(new Error('The SDK says so.'), { code: 'deposits_closed', data: { gateCode: 'holdings_unreadable' } })],
        ['an unfinished withdrawal', Object.assign(new Error('Another deployment has a withdrawal.'), { code: 'previous_withdrawal_open' })],
        ['a foreign wallet', SDK_REFUSAL('zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930')]
    ];
    for (const [label, error] of cases) {
        const words = error.message;
        assert.equal(versionRefusalMessage(error), null, label);
        assert.equal(zkapiErrorMessage(error), words, label);
        assert.equal(explainZkapiError(error).message, words, label);
        assert.doesNotMatch(zkapiErrorMessage(error), /\bversion \d\b/i, label);
    }
    // The indexer-lag rewrite is the SDK-independent one and is not a version
    // message: it stays on.
    assert.equal(zkapiErrorMessage(Object.assign(new Error('x'), { code: 'indexer_root_lag' })), INDEXER_LAG_MESSAGE);
    // A lone version that is not the deposit target IS versioned: it says it.
    const closedAlone = resolvedTable(partialRevertRegistry(), 'mainnet');
    assert.equal(closedAlone.length, 1);
    resetActiveVersionForTests();
    installActiveVersion({ table: closedAlone, version: closedAlone[0], selection: selection(closedAlone[0], alone) });
    assert.match(zkapiErrorMessage(Object.assign(new Error('Gone'), { status: 410, code: 'deployment_retiring' })),
        /^Version 1 is no longer starting new chats/);
    // An explicit table is judged the same way.
    assert.equal(versionRefusalMessage(cases[0][1], { table: single, active: single[0], selection: selection(single[0]) }), null);
    assert.match(versionRefusalMessage(cases[0][1], { table: TABLE, active: V1, selection: selection(V1) }), /no longer starting new chats/);
});

test('the contains-a-wallet refusal is told by what the boot-time selection said', t => {
    t.after(() => resetActiveVersionForTests());
    const v1Id = V1.deploymentId;
    // A live version holds the wallet now: it moved after this page loaded.
    install(V2, { reason: 'no_runtime_note' });
    let text = zkapiErrorMessage(SDK_REFUSAL(v1Id));
    assert.equal(text, 'This browser’s balance moved to version 1 in another tab. Reload to keep going. Nothing is lost; your balance is saved in this browser.');
    assert.doesNotMatch(text, FORBIDDEN);
    assert.ok(!text.includes(v1Id));

    // The holdings could not be read at boot: say so, and "nothing changed".
    resetActiveVersionForTests();
    install(V2, { reason: 'holdings_unreadable', depositBlock: 'holdings_unreadable' });
    text = zkapiErrorMessage(SDK_REFUSAL(v1Id));
    assert.equal(text, 'We could not read your saved balance. Reload to try again. Nothing was changed.');

    // A retired deployment holds it: retirement words, never "Nothing is lost".
    resetActiveVersionForTests();
    install(V2, { reason: 'retired_deployment', depositBlock: 'foreign_runtime' });
    text = zkapiErrorMessage(SDK_REFUSAL('zkapi-retired-deployment-x'));
    assert.match(text, /a version that has been retired and can’t be opened here/);
    assert.doesNotMatch(text, /Nothing is lost/);
    assert.doesNotMatch(text, /zkapi-retired-deployment-x/);

    // A deployment this build has no row for.
    resetActiveVersionForTests();
    install(V2, { reason: 'unknown_deployment', depositBlock: 'foreign_runtime' });
    text = zkapiErrorMessage(SDK_REFUSAL('zkapi-unknown-deployment-x'));
    assert.match(text, /This browser holds a saved balance that this page can’t open\./);
    assert.doesNotMatch(text, /Reload to keep going/);

    // The wording is rewritten in place for every surface, once.
    const refusal = SDK_REFUSAL('zkapi-unknown-deployment-x');
    explainZkapiError(refusal);
    assert.equal(refusal.message, text);
});

test('the contains-a-wallet refusal is left alone where there is nothing to switch to', t => {
    t.after(() => resetActiveVersionForTests());
    const refusal = SDK_REFUSAL('zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930');
    // SDK-default build, or no installed version.
    resetActiveVersionForTests();
    assert.equal(versionRefusalMessage(refusal), null);
    assert.match(zkapiErrorMessage(refusal), /Switch back to that deployment/);
    // A single-version build: "reload" would be a promise nothing keeps.
    const single = resolvedTable(validRegistry(), 'mainnet');
    installActiveVersion({ table: single, version: single[0], selection: selection(single[0], { reason: 'single_version' }) });
    assert.equal(versionRefusalMessage(refusal), null);
    assert.match(zkapiErrorMessage(refusal), /Switch back to that deployment/);
    assert.equal(EXTRA.length, 0);
});

test('explicit context overrides the installed one and a broken context fails to the SDK words', () => {
    const refusal = SDK_REFUSAL(V1.deploymentId);
    const text = versionRefusalMessage(refusal, { table: TABLE, active: V2, selection: selection(V2, { reason: 'holdings_unreadable' }) });
    assert.match(text, /We could not read your saved balance/);
    const throwing = { get selection() { throw new Error('x'); } };
    assert.equal(versionRefusalMessage(refusal, throwing), null);
    assert.match(zkapiErrorMessage(refusal), /Switch back to that deployment/);
});

test('the version UI helpers rewrite a foreign-wallet refusal and leave other errors alone', t => {
    t.after(() => resetActiveVersionForTests());
    // The welcome panel cannot import this module, so it asks the helpers the
    // facade carries; this is the real composition, not a stand-in.
    return import('../../chat/zkapi/versioning/ui.js').then(({ versionUi }) => {
        install(V2, { reason: 'unknown_deployment', slotKind: 'other', foreignDeploymentId: 'zkapi-some-other-deployment-0001' });
        const refusal = SDK_REFUSAL('zkapi-some-other-deployment-0001');
        const words = versionUi.refusalMessage(refusal);
        assert.equal(typeof words, 'string');
        assert.doesNotMatch(words, /zkapi-some-other-deployment-0001|This browser contains a wallet/);
        assert.doesNotMatch(words, FORBIDDEN);
        // Anything else, and anything unreadable, is null: the caller keeps its own message.
        assert.equal(versionUi.refusalMessage(new Error('insufficient funds')), null);
        for (const value of [null, undefined, 'text', 7, {}]) assert.equal(versionUi.refusalMessage(value), null);
        // A page with a lone active version (dormant) keeps the SDK's words.
        resetActiveVersionForTests();
        const single = [{ ...V2 }];
        installActiveVersion({ table: single, version: single[0], selection: selection(single[0]) });
        assert.equal(versionUi.refusalMessage(refusal), null);
    });
});

// ---------------------------------------------------------------------------
// Exit refusals and a paused service (revision 3 SDK), by the SDK's real shapes
// ---------------------------------------------------------------------------

const REAL = JSON.parse(fs.readFileSync(
    new URL('../fixtures/zkapi-v2-real-shapes/snapshots.json', import.meta.url), 'utf8'
));
const NOW = REAL.generatedAtMs;
// What the person must never be shown: engineer words, operator addresses, and
// controls the host does not offer (an exit RPC, a restore).
const SDK_JARGON = /nullifier|vault|circuit|deployment|manifest|\bnotes?\b|\bproof\b|exit rpc|restore the newest|operator\.example|https?:/i;

// The SDK's BrowserWalletHttpError as the fixtures recorded it.
function realError(name) {
    const shape = REAL.errors[name];
    const error = new Error(shape.message);
    error.name = shape.name;
    error.shortMessage = shape.message;
    if (shape.status !== null) error.status = shape.status;
    error.code = shape.code;
    if (shape.data !== null) error.data = structuredClone(shape.data);
    return error;
}

const LOCAL = date => date.toISOString().replace('.000Z', 'Z');
const words = (error, options = {}) => versionRefusalMessage(error, { now: NOW, formatter: LOCAL, ...options });

test('a paused service is told in the host words, by code, and only on a page with versions', t => {
    t.after(() => resetActiveVersionForTests());
    install(V2);
    const expected = {
        service_unavailable: 'The private service can’t be reached right now, so new chats and deposits are paused. You can still withdraw your balance.',
        service_mismatch: 'The private service changed in a way this page doesn’t recognize, so new chats and deposits are paused to keep your balance safe. You can still withdraw. Reload to get the latest page.',
        service_incompatible: 'The service is running an older, incompatible protocol, so new chats and deposits are paused. You can still withdraw your balance.',
        native_vault_unverified: 'We couldn’t confirm the payment contract with the network provider, so new chats and deposits are paused. You can still withdraw. Try again in a moment.'
    };
    for (const [name, text] of Object.entries(expected)) {
        const error = realError(name);
        const original = error.message;
        assert.equal(words(error), text, name);
        assert.doesNotMatch(words(error), SDK_JARGON, name);
        // Every surface says the same thing, once, and the code survives.
        explainZkapiError(error);
        assert.equal(error.message, text, name);
        assert.equal(error.shortMessage, text, name);
        assert.equal(error.code, REAL.errors[name].code, name);
        assert.equal(zkapiErrorMessage(error), text, name);
        assert.equal(explainZkapiError(error).message, text, `${name}: idempotent`);
        assert.notEqual(original, text);
    }
    // The untrusted-link pause has no recorded SDK error; its shape is the same 503.
    const untrusted = Object.assign(new Error('Withdrawals work, but ...'), {
        status: 503, code: 'deployment_manifest_untrusted', data: { exits: true }
    });
    assert.match(words(untrusted), /^This page was opened with a service link it doesn’t trust/);
    assert.doesNotMatch(words(untrusted), SDK_JARGON);

    // A page with nothing to tell apart keeps the SDK's words, every code.
    resetActiveVersionForTests();
    for (const name of Object.keys(expected)) {
        const error = realError(name);
        assert.equal(versionRefusalMessage(error), null, name);
        assert.equal(zkapiErrorMessage(error), REAL.errors[name].message, name);
    }
    const single = resolvedTable(validRegistry(), 'mainnet');
    installActiveVersion({ table: single, version: single[0], selection: selection(single[0], { reason: 'single_version' }) });
    for (const name of Object.keys(expected)) assert.equal(versionRefusalMessage(realError(name)), null, name);
});

test('the manifest codes are an AND: the code with a 503 and exits true, never the code alone', t => {
    t.after(() => resetActiveVersionForTests());
    install(V1);
    const make = (code, { status, data } = {}) => Object.assign(new Error('SDK words'), {
        code, ...(status === undefined ? {} : { status }), ...(data === undefined ? {} : { data })
    });
    for (const code of ['deployment_manifest_unavailable', 'deployment_manifest_mismatch',
        'deployment_manifest_untrusted', 'incompatible_proof_circuit']) {
        assert.ok(versionRefusalMessage(make(code, { status: 503, data: { exits: true } })), code);
        // The same code in any other shape is not "the service is paused, exits work".
        assert.equal(versionRefusalMessage(make(code)), null, `${code}: bare`);
        assert.equal(versionRefusalMessage(make(code, { status: 503 })), null, `${code}: no exits`);
        assert.equal(versionRefusalMessage(make(code, { status: 503, data: { exits: false } })), null, `${code}: exits false`);
        assert.equal(versionRefusalMessage(make(code, { status: 500, data: { exits: true } })), null, `${code}: not 503`);
        assert.equal(versionRefusalMessage(make(code, { status: '503', data: { exits: true } })), null, `${code}: text status`);
        assert.equal(versionRefusalMessage(make(code, { status: 503, data: { exits: 'true' } })), null, `${code}: text exits`);
    }
    // The installed legacy SDK's own refusal: a page that has versions (this
    // one) must still show that SDK's words for it.
    const legacy = realError('legacy_incompatible_proof_circuit');
    assert.equal(legacy.status, undefined);
    assert.equal(versionRefusalMessage(legacy), null);
    assert.equal(zkapiErrorMessage(legacy), REAL.errors.legacy_incompatible_proof_circuit.message);
    // The status may sit in `data`, and the whole refusal on a wrapped error.
    assert.ok(versionRefusalMessage(make('deployment_manifest_mismatch', { data: { status: 503, exits: true } })));
    assert.ok(versionRefusalMessage(Object.assign(new Error('wrapped'), {
        cause: make('deployment_manifest_mismatch', { status: 503, data: { exits: true } })
    })));
    // native_vault_unverified is a revision 3 name: by code, but only here.
    assert.ok(versionRefusalMessage(make('native_vault_unverified')));
});

test('a refused chat key near expiry says what the send gate says, and never an upgrade', t => {
    t.after(() => resetActiveVersionForTests());
    install(V2);
    const text = words(realError('note_near_expiry'));
    assert.equal(text, 'This balance is about to expire. Withdraw it now. New chats are paused so nothing is left unsettled.');
    assert.doesNotMatch(text, /upgrade|version/i);
});

test('a withdrawal that waits for a chat says until when, in local time, and what the choice is', t => {
    t.after(() => resetActiveVersionForTests());
    install(V2);
    const error = realError('request_settlement_pending_withdraw');
    const text = words(error);
    assert.equal(
        text,
        `A recent chat may still be settling, so a normal withdrawal waits for it until ${LOCAL(new Date(error.data.escape_at))}. `
        + 'You can wait, or leave now with an emergency exit, which takes longer to finish.'
    );
    assert.doesNotMatch(text, SDK_JARGON);
    // Milliseconds: the instant is the one in the data, not a thousand times it.
    assert.match(text, /2026-11-15T/);
    // A time that is not believable is not printed: the sentence is whole without it.
    const garbled = Object.assign(realError('request_settlement_pending_withdraw'), {
        data: { ...error.data, escape_at: Math.floor(error.data.escape_at / 1000) }
    });
    assert.equal(
        words(garbled),
        'A recent chat may still be settling, so a normal withdrawal waits for it. You can wait, or leave now '
        + 'with an emergency exit, which takes longer to finish.'
    );
    // The chat-time shape of the same code is not about exiting: the SDK's words stand.
    const chat = realError('request_settlement_pending_chat');
    assert.equal(versionRefusalMessage(chat, { now: NOW }), null);
    assert.equal(zkapiErrorMessage(chat), REAL.errors.request_settlement_pending_chat.message);
});

test('an ownership-proof wait says how many seconds, from the delay and not from a date', t => {
    t.after(() => resetActiveVersionForTests());
    install(V2);
    assert.equal(words(realError('ownership_proof_wait')),
        'Your earlier withdrawal request is about to expire. Try again in 4 seconds.');
    const one = Object.assign(realError('ownership_proof_wait'), { data: { retry_after: 1 } });
    assert.equal(words(one), 'Your earlier withdrawal request is about to expire. Try again in 1 second.');
    const unknown = Object.assign(realError('ownership_proof_wait'), { data: null });
    assert.equal(words(unknown), 'Your earlier withdrawal request is about to expire. Try again in a few seconds.');
    assert.doesNotMatch(words(realError('ownership_proof_wait')), SDK_JARGON);
});

test('an ownership-proof wait counts down from when the error was first read, not from each render', t => {
    t.after(() => resetActiveVersionForTests());
    install(V2);
    const error = Object.assign(realError('ownership_proof_wait'), { data: { retry_after: 30 } });
    // The toast path reads it at the moment of the failure ...
    assert.match(words(error, { now: NOW }), /Try again in 30 seconds\.$/);
    // ... and the panel rebuilds the same words on every later render.
    assert.match(words(error, { now: NOW + 25_000 }), /Try again in 5 seconds\.$/);
    assert.match(words(error, { now: NOW + 29_001 }), /Try again in 1 second\.$/);
    // Once the wait is over the count is not repeated: it says "a few seconds".
    assert.match(words(error, { now: NOW + 40_000 }), /Try again in a few seconds\.$/);
    // Another error is its own countdown from its own first read.
    const next = Object.assign(realError('ownership_proof_wait'), { data: { retry_after: 30 } });
    assert.match(words(next, { now: NOW + 25_000 }), /Try again in 30 seconds\.$/);
    // Through explainZkapiError and zkapiErrorMessage as well: the instant the
    // dialog first read is the one the panel counts from.
    const dialog = Object.assign(realError('ownership_proof_wait'), { data: { retry_after: 12 } });
    const facade = { noteRefusal() {} };
    explainZkapiError(dialog, { facade, now: NOW });
    assert.match(dialog.message, /Try again in 12 seconds\.$/);
    assert.match(words(dialog, { now: NOW + 7_000 }), /Try again in 5 seconds\.$/);
});

test('a pending release and a lock are told without an exit RPC the host does not have', t => {
    t.after(() => resetActiveVersionForTests());
    install(V2);
    const release = realError('exit_release_pending');
    assert.match(release.message, /exit RPC/, 'the SDK sentence does name one');
    const releaseWords = words(release);
    assert.equal(releaseWords, 'An earlier withdrawal attempt has expired, but the network hasn’t confirmed yet that '
        + 'it can no longer go through. Try again shortly.');
    assert.doesNotMatch(releaseWords, /RPC/);

    const locked = realError('exit_locked');
    // `releasable_after` is in SECONDS on this error.
    const until = LOCAL(new Date(locked.data.releasable_after * 1000));
    assert.equal(words(locked), `This balance is frozen while an earlier withdrawal can still go through. New chats resume after ${until}. You can still withdraw.`);
    // A lock with no end does not expire on its own: the words never say that
    // it will (a withdrawal that was started and not finished is the usual cause).
    const open = Object.assign(realError('exit_locked'), { data: { mode: 'mutual', released: 1, releasable_after: null, reason: 'held' } });
    assert.equal(words(open), 'This balance is frozen while a withdrawal of it has started and not finished. New chats resume when it finishes or can no longer go through. You can still withdraw.');
    assert.doesNotMatch(words(open), /expire/i);
});

test('a device that is not the newest is told what to do instead, with no restore button promised', t => {
    t.after(() => resetActiveVersionForTests());
    install(V2);
    for (const name of ['device_not_newest_defeated', 'device_not_newest_successor']) {
        const text = words(realError(name));
        assert.match(text, /can’t safely withdraw it/, name);
        assert.match(text, /zkAPI companion tool/, name);
        assert.doesNotMatch(text, /restore|backup/i, name);
        assert.doesNotMatch(text, SDK_JARGON, name);
    }
});

test('exit refusals are left to the SDK on a page with nothing to tell apart', t => {
    t.after(() => resetActiveVersionForTests());
    for (const name of ['note_near_expiry', 'exit_locked', 'request_settlement_pending_withdraw',
        'device_not_newest_defeated', 'ownership_proof_wait', 'exit_release_pending']) {
        const error = realError(name);
        assert.equal(versionRefusalMessage(error, { now: NOW }), null, name);
        assert.equal(explainZkapiError(error).message, REAL.errors[name].message, name);
    }
});

test('explainZkapiError tells the facade about a refusal first, with the error as it came', t => {
    t.after(() => resetActiveVersionForTests());
    install(V2);
    const calls = [];
    const facade = { noteRefusal(error) { calls.push({ error, message: error.message, code: error.code }); } };
    const error = realError('ownership_proof_wait');
    const original = error.message;
    assert.equal(explainZkapiError(error, { facade, now: NOW }), error, 'the same object comes back');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].error, error);
    assert.equal(calls[0].message, original, 'noted before the wording is replaced');
    assert.equal(calls[0].code, 'ownership_proof_wait');
    assert.notEqual(error.message, original);
    // Every error on a page with versions is offered (the facade decides what
    // it keeps); the indexer-lag rewrite is not a refusal.
    explainZkapiError(realError('service_unavailable'), { facade });
    explainZkapiError(Object.assign(new Error('insufficient funds'), { shortMessage: 'insufficient funds' }), { facade });
    assert.equal(calls.length, 3);
    explainZkapiError(Object.assign(new Error('The zkAPI indexer is still catching up.'), { code: 'indexer_root_lag' }), { facade });
    assert.equal(calls.length, 3);
    // Not an object: nothing to note, nothing thrown.
    for (const value of [null, undefined, 'text', 7]) assert.doesNotThrow(() => explainZkapiError(value, { facade }));
    assert.equal(calls.length, 3);
});

test('a caller that knows which balance an attempt was about says so, and only then is the facade told', t => {
    t.after(() => resetActiveVersionForTests());
    install(V2);
    const calls = [];
    const facade = { noteRefusal(...args) { calls.push(args); } };
    const plain = realError('device_not_newest_successor');
    explainZkapiError(plain, { facade, now: NOW });
    // Exactly the one-argument call every other path makes.
    assert.deepEqual(calls[0], [plain]);
    assert.equal(calls[0].length, 1);

    const restore = realError('device_not_newest_successor');
    explainZkapiError(restore, { facade, now: NOW, about: { recordId: 'r-7', noteId: 7, ignored: 'x' } });
    assert.equal(calls[1][0], restore);
    assert.deepEqual(calls[1][1], { noteId: 7, recordId: 'r-7' });
    explainZkapiError(realError('exit_locked'), { facade, now: NOW, about: { recordId: 'r-8' } });
    assert.deepEqual(calls[2][1], { noteId: null, recordId: 'r-8' });
    // Anything that does not name a balance is no context at all.
    for (const about of [null, undefined, {}, 'r-7', 7, [], { noteId: '7' }, { noteId: 1.5 }, { recordId: '' }, { recordId: 7 }]) {
        calls.length = 0;
        explainZkapiError(realError('exit_locked'), { facade, now: NOW, about });
        assert.equal(calls[0].length, 1, JSON.stringify(about));
    }
});

test('a facade that throws, or that cannot note, never breaks the error path', t => {
    t.after(() => resetActiveVersionForTests());
    install(V2);
    const error = realError('exit_locked');
    const throwing = { noteRefusal() { throw new Error('facade exploded'); } };
    assert.doesNotThrow(() => explainZkapiError(error, { facade: throwing, now: NOW }));
    assert.match(error.message, /^This balance is frozen/);
    for (const facade of [null, {}, { noteRefusal: 'nope' }]) {
        assert.doesNotThrow(() => explainZkapiError(realError('exit_locked'), { facade }), String(facade));
    }
});

test('a page with nothing to tell apart never calls the facade, so its request path is unchanged', t => {
    t.after(() => resetActiveVersionForTests());
    const calls = [];
    const facade = { noteRefusal(error) { calls.push(error); } };
    // No installed version.
    explainZkapiError(realError('exit_locked'), { facade, now: NOW });
    // One active version.
    const single = resolvedTable(validRegistry(), 'mainnet');
    installActiveVersion({ table: single, version: single[0], selection: selection(single[0], { reason: 'single_version' }) });
    explainZkapiError(realError('exit_locked'), { facade, now: NOW });
    explainZkapiError(realError('legacy_incompatible_proof_circuit'), { facade, now: NOW });
    assert.deepEqual(calls, []);
});

test('the installed facade is the default, and the welcome panel path words the same refusals', t => {
    t.after(() => resetActiveVersionForTests());
    return import('../../chat/zkapi/versioning/ui.js').then(({ versionUi }) => {
        install(V2);
        assert.match(versionUi.refusalMessage(realError('service_unavailable')), /^The private service can’t be reached/);
        assert.match(versionUi.refusalMessage(realError('exit_locked')), /^This balance is frozen/);
        assert.equal(versionUi.refusalMessage(realError('legacy_incompatible_proof_circuit')), null);
        assert.equal(versionUi.refusalMessage(new Error('insufficient funds')), null);
    });
});

// -- Sponsored withdrawals -------------------------------------------------------

test('a sponsored withdrawal\'s errors are told in the product\'s words, the signer\'s own sentence alone', async () => {
    const { sponsoredRefusalMessage, explainZkapiError, zkapiErrorMessage } = await import('../../chat/zkapi/services/zkapiErrorCopy.mjs');
    const { SPONSORED_FEE_REFUSAL, SPONSORED_REFUSAL_MESSAGE } = await import('../../chat/zkapi/versioning/sponsored.mjs');
    const gasless = (code, extra = {}) => Object.assign(new Error('The bundler refused eth_sendUserOperation: AA25 invalid account nonce'),
        { name: 'ZkapiGaslessError', code, ...extra });
    // The SDK wraps a refusal of the host transport in its own sentence.
    const wrapped = Object.assign(new Error(`The bundler refused eth_sendUserOperation: ${SPONSORED_FEE_REFUSAL}`),
        { name: 'ZkapiGaslessError', code: 'bundler_rejected' });
    assert.equal(sponsoredRefusalMessage(wrapped), SPONSORED_FEE_REFUSAL);
    assert.equal(zkapiErrorMessage(wrapped), SPONSORED_FEE_REFUSAL);
    const plain = Object.assign(new Error(`Something: ${SPONSORED_REFUSAL_MESSAGE}`), { code: 4100 });
    assert.equal(sponsoredRefusalMessage(plain), SPONSORED_REFUSAL_MESSAGE);
    // A code of the SDK's, told in words with no protocol names.
    for (const code of ['gasless_op_expired', 'paymaster_underfunded', 'bundler_unavailable', 'escape_not_due', 'gasless_op_reverted']) {
        const text = sponsoredRefusalMessage(gasless(code));
        assert.ok(text, code);
        assert.doesNotMatch(text, /bundler|paymaster|user operation|4337|AA\d\d|0x[0-9a-f]{8}/i, `${code}: ${text}`);
    }
    // The error is reworded in place, like the other expected states.
    const error = gasless('gasless_op_expired');
    assert.equal(explainZkapiError(error), error);
    assert.match(error.message, /took too long to send and has to be prepared again/);
    // Anything that is not one is left alone, and so is a code from another family.
    assert.equal(sponsoredRefusalMessage(new Error('The wallet could not do that.')), null);
    assert.equal(sponsoredRefusalMessage(Object.assign(new Error('nope'), { code: 'bundler_unavailable' })), null);
    assert.equal(sponsoredRefusalMessage(null), null);
    assert.equal(sponsoredRefusalMessage('text'), null);
    assert.equal(sponsoredRefusalMessage(Object.assign(new Error('x'), { name: 'ZkapiGaslessError', code: 'some_new_code' })), null);
});
