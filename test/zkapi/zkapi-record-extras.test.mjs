// Per-record extras of the payment-history rows
// (chat/zkapi/components/RecordExtras.js).
//
// Pins what the row of a withdrawal record adds about its payout and its
// device: a closed escape whose payout the payment contract only credited is
// "Payout held", never returned or sent, and is claimed from its own row; a
// close that paid less than expected keeps a persistent note and badge; a
// balance another device spent the next state of loses every button and says
// why. Records are the SDK's own shapes (test/fixtures/zkapi-v2-real-shapes);
// the claim flow runs against a scripted client whose results and record
// changes follow the SDK's claimEscapePayout, and, when a successor SDK is
// installed (or ZKAPI_V2_SDK_DIR names one), against the REAL client over a
// scripted chain.
//
// Each behavior test is titled `wiring:<name>`; the records it renders are
// real-shaped, and the clock never matters (the module has none).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import { id as keccak } from 'ethers';
import {
    RECORD_EXTRAS_WORDS, hasPayoutAlert, isDeviceNotNewestRecord, isUnclaimedPayoutCredit, recordExtras
} from '../../chat/zkapi/components/RecordExtras.js';
import { versionCopyText } from '../../chat/zkapi/versioning/copy.mjs';
import concessionV1 from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { createFakeEnvironment, createFakeStorage } from './_fakeIndexedDb.mjs';
import { createDocument } from './_miniDom.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const FIXTURES = JSON.parse(fs.readFileSync(
    new URL('../fixtures/zkapi-v2-real-shapes/snapshots.json', import.meta.url), 'utf8'));
const { scenarios } = FIXTURES;
const NOW = FIXTURES.generatedAtMs;

// ---------------------------------------------------------------- helpers

const OWN = scenarios.withdrawals_alert_credited_defeated.clientSnapshot.withdrawals;
const byNote = noteId => {
    const record = OWN.find(entry => entry.noteId === noteId);
    assert.ok(record, `fixture record ${noteId}`);
    return structuredClone(record);
};
// What the dialog shows for each of the fixture's own records.
const ALERTED = 2;       // closed, paid less than expected
const CREDITED = 3;      // closed_unconfirmed, credited by receipt, 800000
const VAULT_CREDIT = 4;  // closed, credited, amount not known
const CLAIMED = 5;       // closed, claimed by receipt
const DEFEATED = 6;      // restored, another device is newer
const SET_ASIDE = 8;     // parked mutual, near its deadline

const DESTINATION = `0x${'34'.repeat(20)}`;
const SHORT_DESTINATION = '0x3434…343434';
const hash = char => `0x${char.repeat(64)}`;
const usd = units => `$${(Number(units) / 1_000_000).toFixed(2)}`;
const noPrice = () => '—';
const explorer = value => `https://explorer.test/tx/${value}`;
const CTX = Object.freeze({ formatMoney: usd, txUrl: explorer, busy: false });

// The words of a fragment: tags and entities dropped.
const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'', '&#96;': '`' };
const unescape = value => value.replace(/&(?:amp|lt|gt|quot|#39|#96);/g, match => entities[match]);
const words = html => unescape(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const buttons = html => [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map(match => ({
    recordId: unescape(/data-claim-payout="([^"]*)"/.exec(match[1])?.[1] ?? ''),
    disabled: /\sdisabled(?:\s|$)/.test(match[1]),
    text: unescape(match[2])
}));
const extrasOf = (record, ctx = CTX) => recordExtras(record, ctx);

// Every hook the dialog's other delegated handlers act on, and the version
// actions its banner buttons carry: none may appear in a row's extras.
const OTHER_HOOKS = /data-sync-withdrawal|data-finalize-withdrawal|data-withdraw-background|data-restore-withdrawal|data-retry-|data-recover-finalization|data-resolve-challenged|data-cancel-background-preparation|data-view-current-deposit|data-sync-late-withdrawal|data-zkapi-version-action|data-zkapi-history-open|\sid="/;

// ------------------------------------------------------------- the fixtures

test('the own records of the fixture are the shapes the module is written for', () => {
    assert.deepEqual(OWN.map(record => [record.noteId, record.phase]), [
        [2, 'closed'], [3, 'closed_unconfirmed'], [4, 'closed'], [5, 'closed'], [6, 'restored'], [8, 'parked']
    ]);
    // Amounts: numbers for balances the SDK computed, strings for the bound.
    assert.equal(typeof byNote(CREDITED).creditedAmount, 'number');
    assert.equal(byNote(VAULT_CREDIT).creditedAmount, null);
    assert.equal(byNote(VAULT_CREDIT).payoutCreditEvidence, 'vault_credit');
    assert.equal(typeof byNote(ALERTED).stateBalance, 'string');
    assert.equal(byNote(CLAIMED).payoutClaimEvidence, 'claim_receipt');
    assert.equal(byNote(DEFEATED).deviceNotNewest, true);
    assert.equal(byNote(DEFEATED).challengeObserved, true);
});

// ----------------------------------------------------------- credited payouts

test('wiring:credited-payouts a credited escape is held, never returned, and is claimed from its own row', () => {
    const record = byNote(CREDITED);
    const extras = extrasOf(record);
    assert.equal(extras.label, 'Payout held');
    assert.equal(extras.badge, null);
    assert.equal(extras.hideActions, false);
    assert.equal(extras.hideError, false);

    const text = words(extras.noteHtml);
    assert.match(text, /^Payout held: \$0\.80\. It could not be sent to your address, so the payment contract holds it for you\. Claim it to receive it at 0x3434…343434\./);
    // What claiming does: one transaction, the sending account pays the fee,
    // every payout of the address is paid, no service is needed.
    assert.match(text, /one transaction, and the account that sends it pays the network fee/);
    assert.match(text, /any other payout held for the same address/);
    assert.match(text, /even when the service is unavailable/);
    // The payout is not "returned" or "sent": nothing of that kind is said.
    assert.doesNotMatch(text, /\breturned\b|funds sent|sent to your wallet|all back|\bdelivered\b/i);

    // One button, for this record and no other.
    assert.deepEqual(buttons(extras.actionsHtml), [
        { recordId: record.recordId, disabled: false, text: 'Claim payout' }
    ]);
    assert.match(extras.noteHtml, /data-zkapi-record-credit/);
    assert.doesNotMatch(extras.noteHtml + extras.actionsHtml, OTHER_HOOKS);
});

test('wiring:credited-payouts an amount this browser was never told is said so, and the claim stays offered', () => {
    const record = byNote(VAULT_CREDIT);
    assert.equal(record.creditedAmount, null);
    const extras = extrasOf(record);
    const text = words(extras.noteHtml);
    assert.equal(extras.label, 'Payout held');
    // No figure, and no sentence with a hole where one would be.
    assert.match(text, /^Payout held\. It could not be sent to your address/);
    assert.doesNotMatch(text, /\$|: \./);
    assert.match(text, /The amount isn’t shown here\. The claim pays everything the payment contract holds for this address\./);
    assert.deepEqual(buttons(extras.actionsHtml).map(button => button.recordId), [record.recordId]);
});

test('wiring:credited-payouts an amount without a price is left out, not guessed, and not called unknown', () => {
    const extras = extrasOf(byNote(CREDITED), { ...CTX, formatMoney: noPrice });
    const text = words(extras.noteHtml);
    assert.match(text, /^Payout held\. It could not be sent to your address/);
    assert.doesNotMatch(text, /\$|—|unknown|isn’t shown/);
    assert.equal(buttons(extras.actionsHtml).length, 1);
    // A formatter that throws, returns a non-string or an empty string is the
    // same as no price.
    for (const formatMoney of [() => { throw new Error('no quote'); }, () => 12, () => '', () => '   ', undefined]) {
        const quiet = extrasOf(byNote(CREDITED), { ...CTX, formatMoney });
        assert.match(words(quiet.noteHtml), /^Payout held\. It could not be sent/);
    }
});

test('wiring:credited-payouts the address is shortened by the dialog, or here, and only when it is an address', () => {
    const record = byNote(CREDITED);
    assert.match(words(extrasOf(record).noteHtml), /at 0x3434…343434\./);
    assert.match(words(extrasOf(record, { ...CTX, compact: value => `<${value.slice(2, 6)}>` }).noteHtml),
        /at <3434>\./);
    // A compact that fails falls back to the module's own shortening.
    assert.match(words(extrasOf(record, { ...CTX, compact: () => { throw new Error('x'); } }).noteHtml),
        /at 0x3434…343434\./);
    // Not an address: nothing is shown as one and nothing can be claimed.
    for (const destination of [null, undefined, '', 'nowhere', `0x${'g'.repeat(40)}`, `0x${'34'.repeat(19)}`, 7]) {
        const odd = extrasOf({ ...record, destination });
        assert.doesNotMatch(words(odd.noteHtml), /\bat 0x|\bat \./, String(destination));
        assert.equal(odd.actionsHtml, '', `no claim for ${String(destination)}`);
        assert.equal(odd.label, 'Payout held');
    }
});

test('wiring:credited-payouts a claim already sent is told and linked, and the row still offers to check it', () => {
    const record = { ...byNote(CREDITED), payoutClaimTransactionHashes: [hash('b'), hash('c')] };
    const extras = extrasOf(record);
    assert.match(words(extras.noteHtml), /A claim for this payout was already sent\. Claiming again checks it before sending anything new\./);
    assert.equal(buttons(extras.actionsHtml).length, 1);
    // The link is to the newest claim the SDK remembers, once.
    const links = [...extras.noteHtml.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)];
    assert.deepEqual(links.map(match => [match[1], match[2]]), [[explorer(hash('c')), 'View claim transaction']]);
    // Without a link target the sentence stands alone.
    assert.doesNotMatch(extrasOf(record, { ...CTX, txUrl: undefined }).noteHtml, /<a\b/);
    assert.match(words(extrasOf(record, { ...CTX, txUrl: undefined }).noteHtml), /already sent/);
    // Entries that are not hashes are skipped, not linked: the newest real one wins.
    const mixed = extrasOf({ ...record, payoutClaimTransactionHashes: [hash('b'), '0xabc', null, {}] });
    assert.deepEqual([...mixed.noteHtml.matchAll(/href="([^"]*)"/g)].map(match => match[1]), [explorer(hash('b'))]);
    // Hashes that are not hashes say nothing; an empty list says nothing.
    for (const hashes of [[], ['0xabc'], [null], 'x', undefined]) {
        const quiet = extrasOf({ ...byNote(CREDITED), payoutClaimTransactionHashes: hashes });
        assert.doesNotMatch(words(quiet.noteHtml), /already sent/);
        assert.doesNotMatch(quiet.noteHtml, /<a\b/);
    }
});

test('wiring:credited-payouts the claim button follows the dialog being busy and needs a record to claim', () => {
    const record = byNote(CREDITED);
    assert.equal(buttons(extrasOf(record, { ...CTX, busy: true }).actionsHtml)[0].disabled, true);
    assert.equal(buttons(extrasOf(record, { ...CTX, busy: false }).actionsHtml)[0].disabled, false);
    // No fact about busy is not busy; any truthy value is (the row's own
    // buttons follow the same rule).
    for (const busy of [undefined, null, false, 0, '']) {
        assert.equal(buttons(extrasOf(record, { ...CTX, busy }).actionsHtml)[0].disabled, false, String(busy));
    }
    for (const busy of [true, 1, 'yes']) {
        assert.equal(buttons(extrasOf(record, { ...CTX, busy }).actionsHtml)[0].disabled, true, String(busy));
    }
    assert.equal(buttons(extrasOf(record, {}).actionsHtml)[0].disabled, false);

    // A record without an id has no claim to name: the card explains and
    // offers nothing to click.
    for (const recordId of [undefined, null, '', '   ', 7, {}]) {
        const extras = extrasOf({ ...record, recordId });
        assert.equal(extras.actionsHtml, '', String(recordId));
        assert.equal(extras.label, 'Payout held');
        assert.match(words(extras.noteHtml), /^Payout held: \$0\.80\./);
    }
});

test('wiring:credited-payouts an id that tries to leave its attribute stays text', () => {
    const hostile = '"><img src=x onerror=alert(1)>\'`&';
    const extras = extrasOf({ ...byNote(CREDITED), recordId: hostile });
    // The text is inert: the markup is one button and nothing else.
    assert.deepEqual([...extras.actionsHtml.matchAll(/<\/?([a-z]+)/g)].map(match => match[1]), ['button', 'button']);
    assert.doesNotMatch(extras.actionsHtml.replace(/data-claim-payout="[^"]*"/, ''), /onerror|<img|alert/);
    assert.deepEqual(buttons(extras.actionsHtml).map(button => button.recordId), [hostile]);
    // Operator-controlled text is not part of this row, but the figures and
    // addresses it does print are escaped like the rest.
    const loud = extrasOf(byNote(CREDITED), { ...CTX, formatMoney: () => '<b>$1</b>', compact: () => '<i>0x</i>' });
    assert.doesNotMatch(loud.noteHtml, /<b>|<i>/);
    assert.match(loud.noteHtml, /&lt;b&gt;\$1&lt;\/b&gt;/);
});

test('wiring:credited-payouts a claimed payout says where it went and links the claim, once', () => {
    const record = byNote(CLAIMED);
    const extras = extrasOf(record);
    assert.equal(extras.label, null, 'the row\'s own "Returned" is right once a claim is proven');
    assert.equal(extras.actionsHtml, '');
    assert.equal(extras.hideActions, false);
    const text = words(extras.noteHtml);
    assert.match(text, /^This payout was claimed and paid to 0x3434…343434\./);
    assert.match(text, /The claim paid \$0\.10 in total, including any other payout held for that address\./);
    assert.match(extras.noteHtml, /data-zkapi-record-claimed/);
    assert.doesNotMatch(extras.noteHtml, /data-zkapi-record-credit/);
    const links = [...extras.noteHtml.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)];
    assert.deepEqual(links.map(match => [match[1], match[2]]),
        [[explorer(record.payoutClaimTransactionHash), 'View claim transaction']]);
    assert.match(extras.noteHtml, /rel="noopener noreferrer"/);
    assert.doesNotMatch(extras.noteHtml + extras.actionsHtml, OTHER_HOOKS);
});

test('wiring:credited-payouts a credit seen to be gone has no claim to link and does not invent an amount', () => {
    const record = { ...byNote(CLAIMED), payoutClaimEvidence: 'credit_cleared', payoutClaimTransactionHash: null,
        payoutClaimedAmount: undefined };
    const extras = extrasOf(record);
    assert.match(words(extras.noteHtml), /^The payment contract no longer holds this payout, so it was already paid to 0x3434…343434\.$/);
    assert.doesNotMatch(extras.noteHtml, /<a\b/);
    // Even a hash and an amount on such a record are not shown: the evidence
    // is that the vault holds nothing, not a claim of this browser's.
    const stale = extrasOf({ ...record, payoutClaimTransactionHash: hash('d'), payoutClaimedAmount: 100000 });
    assert.doesNotMatch(stale.noteHtml, /<a\b|in total/);
});

test('wiring:credited-payouts a link is shown only for a transaction hash and an https address', () => {
    const record = byNote(CLAIMED);
    for (const value of ['0xabc', null, undefined, 12, hash('d').slice(0, 60), `${hash('d')}x`]) {
        assert.doesNotMatch(extrasOf({ ...record, payoutClaimTransactionHash: value }).noteHtml, /<a\b/, String(value));
    }
    for (const url of ['javascript:alert(1)', 'http://explorer.test/tx', '//explorer.test/x', null, 4, '']) {
        assert.doesNotMatch(extrasOf(record, { ...CTX, txUrl: () => url }).noteHtml, /<a\b/, String(url));
    }
    assert.doesNotMatch(extrasOf(record, { ...CTX, txUrl: () => { throw new Error('x'); } }).noteHtml, /<a\b/);
    assert.doesNotMatch(extrasOf(record, { ...CTX, txUrl: undefined }).noteHtml, /<a\b/);
    // The link goes to the SDK's claim hash, not to the escape's own.
    const url = /href="([^"]*)"/.exec(extrasOf(record).noteHtml)[1];
    assert.equal(url, explorer(record.payoutClaimTransactionHash));
    assert.notEqual(record.payoutClaimTransactionHash, record.finalizeTransactionHash);
});

test('wiring:credited-payouts only a closed, credited, unclaimed escape is held, and the predicate is the holdings one', () => {
    const credited = byNote(CREDITED);
    // The same predicate the normalizer lists own credits with.
    assert.equal(isUnclaimedPayoutCredit(credited), true);
    for (const patch of [{ payoutCredited: false }, { payoutCredited: undefined }, { payoutClaimed: true },
        { phase: 'pending' }, { phase: 'restored' }, { phase: 'parked' }, { phase: 'finalizing' }]) {
        const record = { ...credited, ...patch };
        assert.equal(isUnclaimedPayoutCredit(record), false, JSON.stringify(patch));
        assert.notEqual(extrasOf(record).label, 'Payout held', JSON.stringify(patch));
        assert.equal(extrasOf(record).actionsHtml, '', JSON.stringify(patch));
    }
    // A return the escape proved itself is a return: nothing is held.
    const paid = extrasOf({ ...credited, payoutCredited: false, payoutVerified: true });
    assert.deepEqual(paid, { label: null, badge: null, noteHtml: '', actionsHtml: '', hideActions: false, hideError: false });
});

// ------------------------------------------------------------- payout alert

test('wiring:payout-alert a close that paid less than expected keeps a persistent note, a badge and the figures', () => {
    const record = byNote(ALERTED);
    assert.equal(record.payoutAlert, 'concession_exceeded_bound');
    const extras = extrasOf(record);
    assert.equal(extras.badge, 'Paid less than expected');
    assert.equal(extras.label, null, 'the row still says Returned: it was paid, only less');
    assert.equal(extras.actionsHtml, '');
    assert.equal(extras.hideActions, false);
    const text = words(extras.noteHtml);
    // The notice's own words, unchanged.
    assert.equal(text.startsWith(versionCopyText('payout.alert')), true, text);
    assert.match(text, /Please report it to the service operator\./);
    // 5.00 - 1.00 = 4.00 expected at least; 3.00 paid.
    assert.match(text, /The withdrawal paid out \$3\.00\. Your balance minus your last chat’s budget was \$4\.00\./);
    assert.match(extras.noteHtml, /data-zkapi-record-alert/);
    // It never claims the money is all back.
    assert.doesNotMatch(text, /all back|nothing is lost|in full/i);
    assert.doesNotMatch(extras.noteHtml, OTHER_HOOKS);
});

test('wiring:payout-alert the figures appear only when the record\'s own numbers agree with the alert and can be priced', () => {
    const record = byNote(ALERTED);
    // The note stands, without the sentence that quotes the two amounts.
    const noFigures = extras => {
        const text = words(extras.noteHtml);
        assert.match(text, /^A withdrawal paid out less than your balance minus your last chat’s budget\./);
        assert.doesNotMatch(text, /The withdrawal paid out/);
    };
    // No price.
    noFigures(extrasOf(record, { ...CTX, formatMoney: noPrice }));
    // Missing or malformed numbers.
    for (const patch of [{ stateBalance: undefined }, { boundAtState: undefined }, { finalBalance: undefined },
        { finalBalance: -1 }, { stateBalance: 'many' }, { boundAtState: '1.5' }, { finalBalance: Number.NaN },
        { stateBalance: {} }]) {
        const extras = extrasOf({ ...record, ...patch });
        noFigures(extras);
        assert.equal(extras.badge, 'Paid less than expected', JSON.stringify(patch));
        assert.match(extras.noteHtml, /data-zkapi-record-alert/);
    }
    // Numbers that contradict the alert (paid at or above the floor, or no
    // floor) are not printed as if they explained it.
    noFigures(extrasOf({ ...record, finalBalance: 4_000_000 }));
    noFigures(extrasOf({ ...record, finalBalance: 5_000_000 }));
    noFigures(extrasOf({ ...record, boundAtState: '5000000' }));
    noFigures(extrasOf({ ...record, boundAtState: '9000000' }));
    // Two amounts that read the same once priced say nothing more.
    noFigures(extrasOf(record, { ...CTX, formatMoney: () => '$3.00' }));
    // Large amounts keep their digits (BigInt, not floating point).
    const big = extrasOf({ ...record, stateBalance: '900000000000000000000', boundAtState: '1', finalBalance: 5 },
        { ...CTX, formatMoney: units => `#${units}` });
    assert.match(words(big.noteHtml), /paid out #5\. Your balance minus your last chat’s budget was #899999999999999999999\./);
});

test('wiring:payout-alert an alert stays with a payout held or claimed, beside it and not instead of it', () => {
    const held = extrasOf({ ...byNote(CREDITED), payoutAlert: 'concession_exceeded_bound' });
    assert.equal(held.label, 'Payout held');
    assert.equal(held.badge, 'Paid less than expected');
    assert.match(held.noteHtml, /data-zkapi-record-credit/);
    assert.match(held.noteHtml, /data-zkapi-record-alert/);
    assert.equal(buttons(held.actionsHtml).length, 1);
    // Card first, then the alert.
    assert.ok(held.noteHtml.indexOf('data-zkapi-record-credit') < held.noteHtml.indexOf('data-zkapi-record-alert'));

    const claimed = extrasOf({ ...byNote(CLAIMED), payoutAlert: 'concession_exceeded_bound' });
    assert.match(claimed.noteHtml, /data-zkapi-record-claimed/);
    assert.match(claimed.noteHtml, /data-zkapi-record-alert/);
    assert.equal(claimed.actionsHtml, '');
});

test('wiring:payout-alert only the one alert value counts, and the badge is plain text', () => {
    const record = byNote(ALERTED);
    for (const value of [undefined, null, '', false, true, 'other_alert', 'CONCESSION_EXCEEDED_BOUND', 1]) {
        const extras = extrasOf({ ...record, payoutAlert: value });
        assert.equal(hasPayoutAlert({ ...record, payoutAlert: value }), false, String(value));
        assert.deepEqual(extras, { label: null, badge: null, noteHtml: '', actionsHtml: '', hideActions: false, hideError: false });
    }
    assert.equal(hasPayoutAlert(record), true);
    // The badge and label are text for the dialog to escape, not markup.
    assert.equal(extrasOf(record).badge, versionCopyText('payout.alert.badge'));
    assert.doesNotMatch(extrasOf(record).badge, /[<>&]/);
});

// -------------------------------------------------------- device not newest

test('wiring:device-not-newest a balance used on another device loses its buttons and says why, without promising a restore', () => {
    const record = byNote(DEFEATED);
    const extras = extrasOf(record);
    assert.equal(extras.label, 'Used on another device');
    assert.equal(extras.hideActions, true);
    assert.equal(extras.actionsHtml, '');
    assert.equal(extras.badge, null);
    // The SDK's own line sends the person to restore a backup this app cannot
    // open; it is replaced, not repeated.
    assert.match(record.error, /Restore the newest backup or exit kit/);
    assert.equal(extras.hideError, true);

    const text = words(extras.noteHtml);
    assert.equal(text, versionCopyText('exit.device'));
    assert.match(text, /Withdraw it from the device that used it last, or use your newest exit kit with the zkAPI companion tool\./);
    assert.match(text, /Trying here would cost network fees and be rejected\./);
    // No in-app restore is promised, and no button invites one.
    assert.doesNotMatch(text, /\brestore\b|\bimport\b|\bupload\b|use this balance|finish withdrawal/i);
    assert.match(extras.noteHtml, /data-zkapi-record-device/);
    assert.doesNotMatch(extras.noteHtml, OTHER_HOOKS);
});

test('wiring:device-not-newest either flag marks it, on a set-aside balance only', () => {
    const base = { ...byNote(SET_ASIDE), exit_deadline_near: false };
    const flagged = patch => isDeviceNotNewestRecord({ ...base, ...patch });
    assert.equal(flagged({}), false);
    assert.equal(flagged({ deviceNotNewest: true }), true);
    assert.equal(flagged({ challengeObserved: true }), true);
    assert.equal(flagged({ deviceNotNewest: true, phase: 'restored' }), true);
    for (const phase of ['closed', 'closed_unconfirmed', 'pending', 'finalizing', 'submitted_unconfirmed', 'ambiguous']) {
        assert.equal(flagged({ deviceNotNewest: true, phase }), false, phase);
        assert.equal(extrasOf({ ...base, deviceNotNewest: true, phase }).hideActions, false, phase);
    }
    // Truthy is not true: a stray string never withdraws a balance's buttons.
    for (const value of ['true', 1, {}, 'yes']) {
        assert.equal(flagged({ deviceNotNewest: value, challengeObserved: value }), false, String(value));
    }
    // A flagged mutual close that is parked loses its Withdraw button too.
    assert.equal(extrasOf({ ...base, challengeObserved: true }).hideActions, true);
    // The note, label and hidden buttons are all one decision.
    const extras = extrasOf({ ...base, deviceNotNewest: true });
    assert.deepEqual([extras.label, extras.hideActions, /data-zkapi-record-device/.test(extras.noteHtml)],
        ['Used on another device', true, true]);
});

test('wiring:device-not-newest only the SDK\'s device message is replaced; any other error stays visible', () => {
    const record = byNote(DEFEATED);
    assert.equal(extrasOf({ ...record, error: 'The wallet provider returned an invalid block number.' }).hideError, false);
    assert.equal(extrasOf({ ...record, error: null }).hideError, false);
    assert.equal(extrasOf({ ...record, error: undefined }).hideError, false);
    assert.equal(extrasOf({ ...record, error: 5 }).hideError, false);
    for (const message of [
        'The escape was defeated: another device spent this balance’s next state, so this device is not the newest. Restore the newest backup or exit kit.',
        'Another device spent this balance’s next state, so this device is not the newest. Restore the newest backup or exit kit before withdrawing.'
    ]) {
        assert.equal(extrasOf({ ...record, error: message }).hideError, true, message);
    }
    // The buttons stay hidden whatever the error says.
    assert.equal(extrasOf({ ...record, error: 'x' }).hideActions, true);
    // And an error on a balance that is not flagged is never hidden.
    assert.equal(extrasOf({ ...byNote(SET_ASIDE), error: 'Another device spent it' }).hideError, false);
});

test('a set-aside balance near its deadline that is not flagged renders exactly as it did', () => {
    const record = byNote(SET_ASIDE);
    assert.equal(record.exit_deadline_near, true);
    assert.deepEqual(extrasOf(record),
        { label: null, badge: null, noteHtml: '', actionsHtml: '', hideActions: false, hideError: false });
});

// ------------------------------------------------------- shape and contract

const EMPTY = Object.freeze({ label: null, badge: null, noteHtml: '', actionsHtml: '', hideActions: false, hideError: false });

test('the result always has the same six fields, of the same types', () => {
    const samples = [...OWN, null, undefined, 'x', 3, [], {}, { phase: 'closed' }, Object.create(null)];
    for (const sample of samples) {
        const extras = extrasOf(sample);
        assert.deepEqual(Object.keys(extras), ['label', 'badge', 'noteHtml', 'actionsHtml', 'hideActions', 'hideError']);
        assert.ok(extras.label === null || typeof extras.label === 'string');
        assert.ok(extras.badge === null || typeof extras.badge === 'string');
        assert.equal(typeof extras.noteHtml, 'string');
        assert.equal(typeof extras.actionsHtml, 'string');
        assert.equal(typeof extras.hideActions, 'boolean');
        assert.equal(typeof extras.hideError, 'boolean');
    }
    for (const sample of [null, undefined, 'x', 3, [], {}, { phase: 'closed' }]) {
        assert.deepEqual(extrasOf(sample), EMPTY);
    }
    // A fresh object each time: a caller that edits it edits nothing shared.
    const first = extrasOf(null);
    first.noteHtml = 'x';
    assert.equal(extrasOf(null).noteHtml, '');
});

test('a record and a context are only read, and the same ones give the same answer', () => {
    const deepFreeze = value => {
        if (value && typeof value === 'object') {
            Object.values(value).forEach(deepFreeze);
            Object.freeze(value);
        }
        return value;
    };
    for (const record of OWN) {
        const frozen = deepFreeze(structuredClone(record));
        const ctx = deepFreeze({ ...CTX });
        const first = recordExtras(frozen, ctx);
        assert.deepEqual(recordExtras(frozen, ctx), first);
        assert.deepEqual(first, recordExtras(structuredClone(record), { ...CTX }));
    }
    // A context that is not an object is no context.
    for (const ctx of [null, undefined, 'x', 4, []]) {
        assert.equal(buttons(recordExtras(byNote(CREDITED), ctx).actionsHtml).length, 1);
    }
});

test('hostile or half-formed records never throw and never offer a claim they could not make', () => {
    const throwing = new Proxy({}, { get() { throw new Error('boom'); } });
    assert.doesNotThrow(() => recordExtras(throwing, CTX));
    assert.deepEqual(recordExtras(throwing, CTX), EMPTY);
    assert.deepEqual(recordExtras({ get phase() { throw new Error('boom'); } }, CTX), EMPTY);

    // A context that fails while the row is composed never reveals a button a
    // balance must not have, and never invents a claim.
    const failing = { get busy() { throw new Error('boom'); }, formatMoney: usd };
    assert.doesNotThrow(() => recordExtras(byNote(CREDITED), failing));
    assert.equal(recordExtras(byNote(CREDITED), failing).actionsHtml, '');
    // A set-aside balance whose composition fails half way keeps its buttons hidden.
    const halfRead = { ...byNote(DEFEATED), get error() { throw new Error('boom'); } };
    const stillHidden = recordExtras(halfRead, CTX);
    assert.deepEqual(stillHidden, { ...EMPTY, hideActions: true });

    const pool = {
        recordId: [undefined, null, '', 'r1', `${'x'.repeat(5000)}`, '"><script>alert(1)</script>', 7, {}],
        phase: [undefined, 'closed', 'closed_unconfirmed', 'restored', 'parked', 'pending', {}, 3],
        mode: [undefined, 'escape', 'mutual', 7],
        destination: [undefined, null, DESTINATION, `0x${'AB'.repeat(20)}`, 'x', 5],
        payoutCredited: [undefined, true, false, 'true', 1],
        payoutClaimed: [undefined, true, false, 'true'],
        payoutVerified: [undefined, true, false],
        creditedAmount: [undefined, null, 0, 1, 800000, -5, 1.5, '12', '1e9', {}, Number.MAX_SAFE_INTEGER + 2, 10n ** 40n],
        payoutCreditEvidence: [undefined, null, 'receipt', 'vault_credit', 'other'],
        payoutClaimEvidence: [undefined, null, 'claim_receipt', 'credit_cleared', 'other'],
        payoutClaimTransactionHash: [undefined, null, hash('a'), 'x', {}],
        payoutClaimTransactionHashes: [undefined, [], [hash('b')], 'x', [{}]],
        payoutClaimedAmount: [undefined, null, 5, '7', -1, {}],
        payoutAlert: [undefined, 'concession_exceeded_bound', 'other'],
        finalBalance: [undefined, 0, 3_000_000, '9', -1, {}],
        stateBalance: [undefined, '5000000', 5000000, 'x', {}],
        boundAtState: [undefined, '1000000', 'x', null],
        deviceNotNewest: [undefined, true, false, 'true'],
        challengeObserved: [undefined, true, false, 1],
        error: [undefined, null, 'oops', 'Restore the newest backup or exit kit.', {}, 3]
    };
    // A deterministic sweep: every value of every field once, over varied bases.
    const bases = [{}, byNote(CREDITED), byNote(CLAIMED), byNote(ALERTED), byNote(DEFEATED)];
    let checked = 0;
    for (const base of bases) {
        for (const [field, values] of Object.entries(pool)) {
            for (const value of values) {
                const record = { ...base, [field]: value };
                const extras = recordExtras(record, CTX);
                checked += 1;
                assert.deepEqual(Object.keys(extras), Object.keys(EMPTY));
                const claims = buttons(extras.actionsHtml);
                // A claim exists only for a held payout with an id and an address.
                if (claims.length) {
                    assert.equal(claims.length, 1);
                    assert.equal(isUnclaimedPayoutCredit(record), true);
                    assert.equal(claims[0].recordId, record.recordId);
                    assert.match(record.destination, /^0x[0-9a-fA-F]{40}$/);
                    assert.equal(extras.hideActions, false);
                }
                // A flagged balance never shows a claim and always loses its buttons.
                if (isDeviceNotNewestRecord(record)) {
                    assert.equal(extras.hideActions, true);
                    assert.equal(claims.length, 0);
                } else {
                    assert.equal(extras.hideActions, false);
                }
                // Markup is structured: only the tags and attributes this module writes.
                const html = extras.noteHtml + extras.actionsHtml;
                for (const name of ['p', 'div', 'button', 'a']) {
                    assert.equal(html.split(new RegExp(`<${name}[\\s>]`)).length, html.split(`</${name}>`).length,
                        `${name} tags balance`);
                }
                for (const tag of html.matchAll(/<\/?([a-zA-Z0-9]+)((?:\s+[^<>]*)?)>/g)) {
                    assert.match(tag[1], /^(?:p|div|button|a)$/, `tag ${tag[1]}`);
                    for (const attribute of tag[2].matchAll(/\s([a-zA-Z-]+)(?:="[^"<>]*")?/g)) {
                        assert.match(attribute[1], /^(?:class|type|disabled|href|target|rel|data-claim-payout|data-zkapi-record-(?:credit|claimed|alert|device))$/,
                            `attribute ${attribute[1]}`);
                    }
                }
                assert.doesNotMatch(html, /<script|javascript:|\son[a-z]+=/i);
                assert.doesNotMatch(html, OTHER_HOOKS);
            }
        }
    }
    assert.ok(checked > 400, `checked ${checked}`);
});

test('every record the fixture holds is judged the way the adapter judges it', () => {
    // The predicates and the version state's counts come from the same facts:
    // a row that offers a claim is one the notices count, and the reverse.
    for (const [name, scenario] of Object.entries(scenarios)) {
        const snapshot = { ...scenario.clientSnapshot, runtime: scenario.runtime };
        const normalized = concessionV1.normalizeSnapshot(snapshot, { nowMs: NOW });
        const records = scenario.clientSnapshot.withdrawals;
        const claimable = records.filter(record => buttons(extrasOf(record).actionsHtml).length === 1)
            .map(record => record.recordId);
        assert.deepEqual(claimable, normalized.ownCredits.map(credit => credit.recordId), `${name}: credits`);
        assert.deepEqual(records.filter(hasPayoutAlert).map(record => record.recordId), normalized.payoutAlerts, `${name}: alerts`);
        assert.deepEqual(records.filter(record => extrasOf(record).hideActions).map(record => record.recordId),
            normalized.deviceNotNewestRecords, `${name}: flagged`);
    }
});

// --------------------------------------------------- what a browser parses

// The dialog composes a row from these strings and binds a click handler to
// each [data-claim-payout] button it finds. A parsed tree is what that handler
// sees, so the id it reads is the one the record has, whatever characters the
// id holds, and a disabled button cannot be clicked into the SDK.
test('wiring:credited-payouts the parsed row hands the click handler the record id, hostile or not, and a busy row cannot be clicked', () => {
    const hostile = '"><img src=x onerror=alert(1)>\'`&amp;<script>';
    const compose = (record, ctx) => {
        const document = createDocument();
        const row = document.createElement('section');
        document.body.append(row);
        const extras = recordExtras(record, ctx);
        row.innerHTML = `${extras.noteHtml}<div class="mt-3 flex gap-2">${extras.actionsHtml}</div>`;
        const claimed = [];
        row.querySelectorAll('[data-claim-payout]').forEach(button => {
            button.addEventListener('click', () => claimed.push(button.dataset.claimPayout));
        });
        return { row, claimed };
    };

    for (const recordId of [byNote(CREDITED).recordId, hostile]) {
        const { row, claimed } = compose({ ...byNote(CREDITED), recordId }, CTX);
        const found = row.querySelectorAll('[data-claim-payout]');
        assert.equal(found.length, 1);
        // Nothing the id contained became an element.
        assert.deepEqual(row.querySelectorAll('img').length + row.querySelectorAll('script').length, 0);
        assert.equal(found[0].tagName, 'button');
        assert.equal(found[0].type, 'button');
        found[0].click();
        assert.deepEqual(claimed, [recordId]);
    }

    const busy = compose(byNote(CREDITED), { ...CTX, busy: true });
    const button = busy.row.querySelector('[data-claim-payout]');
    assert.equal(button.disabled, true);
    button.click();
    assert.deepEqual(busy.claimed, []);

    // The notes parse into the elements that carry the hooks, once each.
    const alerted = compose({ ...byNote(CREDITED), payoutAlert: 'concession_exceeded_bound' }, CTX).row;
    assert.equal(alerted.querySelectorAll('[data-zkapi-record-credit]').length, 1);
    assert.equal(alerted.querySelectorAll('[data-zkapi-record-alert]').length, 1);
    assert.equal(compose(byNote(DEFEATED), CTX).row.querySelectorAll('[data-zkapi-record-device]').length, 1);
    assert.equal(compose(byNote(CLAIMED), CTX).row.querySelectorAll('[data-zkapi-record-claimed] a').length, 1);
});

// ---------------------------------------------------- the claim, end to end

// A client that answers claimEscapePayout the way the SDK's own does, one
// scripted step per call. The record changes of a step are the ones its
// markEscapePayoutsClaimed / rememberEscapePayoutClaim make (field names read
// from the SDK source), applied to the same record objects the dialog reads.
function scriptedClient(withdrawals, steps) {
    const client = {
        withdrawals,
        calls: [],
        statuses: [],
        async claimEscapePayout(recordId, onStatus = () => {}) {
            client.calls.push(recordId);
            const step = steps.shift();
            assert.ok(step, 'a claim nobody scripted');
            const record = client.withdrawals.find(entry => entry.recordId === recordId);
            // The SDK refuses what is not a credited escape of this wallet.
            if (!record || record.payoutCredited !== true || !['closed', 'closed_unconfirmed'].includes(record.phase)) {
                throw new Error('The vault holds no escape payout for this withdrawal.');
            }
            for (const text of step.reports || []) onStatus(text);
            step.effect?.(client.withdrawals, record);
            if (step.throws) throw step.throws;
            return step.returns;
        }
    };
    return client;
}

const markSent = (record, hashValue) => {
    record.payoutClaimTransactionHashes = [...(record.payoutClaimTransactionHashes || []), hashValue];
};
const markClaimed = (records, destination, evidence, { before = Infinity } = {}) => {
    const settled = [];
    for (const record of records) {
        if (record.destination === destination && record.payoutCredited === true && record.payoutClaimed !== true
            && Number(record.closeBlockNumber) < before) {
            Object.assign(record, { payoutClaimed: true, payoutVerified: true, payoutClaimTransactionHashes: [], ...evidence });
            settled.push(record.recordId);
        }
    }
    return settled;
};

// What the delegated click handler does: take the id from the clicked
// button's attribute, call the SDK with it, and read the rows again.
async function clickClaim(client, record, ctx = CTX) {
    const extras = recordExtras(record, ctx);
    const claims = buttons(extras.actionsHtml);
    assert.equal(claims.length, 1, 'one claim button');
    assert.equal(claims[0].disabled, false);
    return client.claimEscapePayout(claims[0].recordId, text => client.statuses.push(text));
}

test('wiring:credited-payouts the claim goes from held, to pending, to delivered, and the row follows each step', async () => {
    const records = [byNote(CREDITED)];
    const [record] = records;
    const sent = hash('c');
    const client = scriptedClient(records, [
        { // A claim that was sent and is still in the mempool.
            reports: [`The payout claim ${sent.slice(0, 8)}… is still pending. Check again after it confirms.`],
            effect: row => markSent(row.find(entry => entry.recordId === record.recordId), sent),
            returns: { status: 'pending', recordId: record.recordId, destination: record.destination, transactionHash: sent }
        },
        { // Mined: the claim receipt proves the payment.
            reports: [`Escape payout delivered to ${SHORT_DESTINATION}.`],
            effect: rows => markClaimed(rows, record.destination, {
                payoutClaimEvidence: 'claim_receipt', payoutClaimTransactionHash: sent,
                payoutClaimBlockNumber: 120, payoutClaimedAmount: 800000
            }),
            returns: { status: 'claimed', recordId: record.recordId, destination: record.destination,
                transactionHash: sent, amount: 800000n }
        }
    ]);

    // Held: a card and one button.
    let extras = recordExtras(record, CTX);
    assert.equal(extras.label, 'Payout held');
    assert.doesNotMatch(words(extras.noteHtml), /already sent/);

    // First click: the SDK reports a pending claim; the row keeps the button
    // and now says one was sent.
    const pending = await clickClaim(client, record);
    assert.equal(pending.status, 'pending');
    extras = recordExtras(record, CTX);
    assert.equal(extras.label, 'Payout held');
    assert.match(words(extras.noteHtml), /A claim for this payout was already sent\./);
    assert.match(extras.noteHtml, new RegExp(`href="${explorer(sent)}"`));
    assert.equal(buttons(extras.actionsHtml).length, 1);

    // Second click: delivered. The button and the card are gone; the row says
    // where the payout went and links the claim the SDK recorded.
    const delivered = await clickClaim(client, record);
    assert.equal(delivered.status, 'claimed');
    extras = recordExtras(record, CTX);
    assert.equal(extras.label, null);
    assert.equal(extras.actionsHtml, '');
    assert.match(words(extras.noteHtml), /^This payout was claimed and paid to 0x3434…343434\. The claim paid \$0\.80 in total/);
    assert.match(extras.noteHtml, new RegExp(`href="${explorer(sent)}"`));
    assert.deepEqual(client.calls, [record.recordId, record.recordId]);
    assert.equal(client.statuses.length, 2);
});

test('wiring:credited-payouts one claim pays every credit of an address, and a later credit keeps its own', async () => {
    const first = byNote(CREDITED);
    const second = { ...byNote(CREDITED), recordId: `${first.recordId}-b`, noteId: 9, closeBlockNumber: 105, creditedAmount: 300000 };
    const later = { ...byNote(CREDITED), recordId: `${first.recordId}-c`, noteId: 10, closeBlockNumber: 130, creditedAmount: 1 };
    const other = { ...byNote(CREDITED), recordId: `${first.recordId}-d`, noteId: 11,
        destination: `0x${'44'.repeat(20)}`, closeBlockNumber: 90 };
    const records = [first, second, later, other];
    const claimsBefore = records.map(record => buttons(recordExtras(record, CTX).actionsHtml).length);
    assert.deepEqual(claimsBefore, [1, 1, 1, 1]);

    const client = scriptedClient(records, [{
        // The claim mined in block 120 pays what the vault holds for the
        // address; a record credited in block 130 or later is not in it.
        effect: rows => markClaimed(rows, first.destination, {
            payoutClaimEvidence: 'claim_receipt', payoutClaimTransactionHash: hash('e'),
            payoutClaimBlockNumber: 120, payoutClaimedAmount: 1_100_000
        }, { before: 120 }),
        returns: { status: 'claimed', recordId: first.recordId, destination: first.destination,
            transactionHash: hash('e'), amount: 1_100_000n }
    }]);
    await clickClaim(client, first);

    const after = records.map(record => recordExtras(record, CTX));
    assert.deepEqual(after.map(extras => buttons(extras.actionsHtml).length), [0, 0, 1, 1]);
    assert.deepEqual(after.map(extras => extras.label), [null, null, 'Payout held', 'Payout held']);
    for (const extras of after.slice(0, 2)) {
        assert.match(words(extras.noteHtml), /The claim paid \$1\.10 in total, including any other payout held for that address\./);
    }
    assert.equal(client.calls.length, 1);
});

test('wiring:credited-payouts a payout somebody else delivered is shown as seen to be gone, with no link', async () => {
    const records = [byNote(VAULT_CREDIT)];
    const [record] = records;
    const client = scriptedClient(records, [{
        reports: ['The vault no longer holds this payout: it was already delivered to its destination.'],
        effect: rows => markClaimed(rows, record.destination, { payoutClaimEvidence: 'credit_cleared', payoutClaimBlockNumber: 111 }),
        returns: { status: 'claimed', recordId: record.recordId, transactionHash: null, observedBlock: 111 }
    }]);
    assert.equal(recordExtras(record, CTX).label, 'Payout held');
    await clickClaim(client, record);
    const extras = recordExtras(record, CTX);
    assert.equal(extras.label, null);
    assert.equal(extras.actionsHtml, '');
    assert.match(words(extras.noteHtml), /^The payment contract no longer holds this payout, so it was already paid to 0x3434…343434\.$/);
    assert.doesNotMatch(extras.noteHtml, /<a\b/);
});

test('wiring:credited-payouts a destination that still refuses the payout leaves the row claimable and unchanged', async () => {
    const records = [byNote(CREDITED)];
    const [record] = records;
    const refused = Object.assign(new Error('execution reverted'), { code: 'native_transfer_failed',
        shortMessage: 'The destination still does not accept ETH, so the vault keeps its payout. Try the claim again once the address can receive ETH.' });
    const client = scriptedClient(records, [{ throws: refused }, { throws: refused }]);
    const before = recordExtras(record, CTX);
    await assert.rejects(clickClaim(client, record), { code: 'native_transfer_failed' });
    assert.deepEqual(recordExtras(record, CTX), before, 'a refused claim changes nothing the row says');
    // And it can be tried again.
    await assert.rejects(clickClaim(client, record), { code: 'native_transfer_failed' });
    assert.deepEqual(client.calls, [record.recordId, record.recordId]);
    assert.equal(buttons(recordExtras(record, CTX).actionsHtml).length, 1);
});

test('wiring:credited-payouts while a claim runs the button is disabled, and only the dialog\'s own busy state does that', async () => {
    const records = [byNote(CREDITED)];
    const [record] = records;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const client = scriptedClient(records, [{ returns: { status: 'claimed', recordId: record.recordId } }]);
    const original = client.claimEscapePayout.bind(client);
    client.claimEscapePayout = async (...args) => { await gate; return original(...args); };
    const running = clickClaim(client, record);
    // The dialog re-renders with busy while the call is in flight.
    const during = recordExtras(record, { ...CTX, busy: true });
    assert.deepEqual(buttons(during.actionsHtml).map(button => button.disabled), [true]);
    assert.equal(client.calls.length, 0, 'the SDK has not been reached yet');
    release();
    await running;
    assert.equal(client.calls.length, 1);
});

// ------------------------------------------------------------ the real SDK

// The same claims against the REAL client, store and runtime of a successor
// SDK over a scripted chain, with the rows read from what the runtime itself
// publishes. Skipped unless a successor SDK is installed under its registry
// alias or unpacked at ZKAPI_V2_SDK_DIR; nothing here runs an SDK script.
function successorRoot() {
    if (process.env.ZKAPI_V2_SDK_DIR) {
        const root = path.resolve(process.env.ZKAPI_V2_SDK_DIR);
        return fs.existsSync(path.join(root, 'sdk/wallet.js')) ? root : null;
    }
    const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'deployments/zkapi/registry.json'), 'utf8'));
    for (const row of registry.versions) {
        if (row.sdk.alias === '@openanonymity/zkapi-browser-sdk') continue;
        const root = path.join(repoRoot, 'node_modules', row.sdk.alias);
        if (fs.existsSync(path.join(root, 'sdk/wallet.js'))) return root;
    }
    return null;
}

const SDK_ROOT = successorRoot();
const skip = SDK_ROOT ? false : 'no successor SDK is installed (registry alias, or ZKAPI_V2_SDK_DIR)';

const DEPLOYMENT = 'zkapi-record-extras-rehearsal';
const CHAIN = 11155111;
const VAULT = `0x${'22'.repeat(20)}`;
const REAL_DESTINATION = '0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f';
const FROM = `0x${'77'.repeat(20)}`;
const CLOSE_BLOCK = 5000;
const FINAL_BALANCE = 700_000;
const FINALIZE_HASH = `0x${'f1'.repeat(32)}`;
const CLAIM_HASH = `0x${'c1'.repeat(32)}`;
const hex = value => `0x${BigInt(value).toString(16)}`;
const word = value => BigInt(value).toString(16).padStart(64, '0');
const selector = signature => keccak(signature).slice(0, 10);
const topic = signature => keccak(signature);
const SELECTORS = Object.freeze({
    credits: selector('escapePayoutCredits(address)'),
    claim: selector('claimEscapePayout(address)'),
    notes: selector('notes(uint32)')
});
const TOPICS = Object.freeze({
    raised: topic('EscapeConcessionRaised(uint32,uint256,uint128,uint128)'),
    deferred: topic('EscapePayoutDeferred(uint32,address,uint128)'),
    claimed: topic('EscapePayoutClaimed(address,uint128)'),
    finalized: topic('EscapeWithdrawalFinalized(uint32,uint256,uint128,address)')
});
const realRecordId = noteId => `${DEPLOYMENT}:${CHAIN}:${VAULT}:${noteId}`;
const NATIVE_FUNDING = { chain_id: CHAIN, contract_address: VAULT, demo_rpc_url: 'https://rpc.example',
    billing_asset: 'native_eth', billing_unit: 'gwei', native_asset_wei_per_unit: '1000000000',
    demo_billing_token_address: null };

let sdk = null;
let env = null;
if (SDK_ROOT) {
    if (!globalThis.crypto) globalThis.crypto = webcrypto;
    env = createFakeEnvironment();
    env.install();
    globalThis.localStorage = createFakeStorage();
    globalThis.location ??= { href: 'https://app.example/', origin: 'https://app.example', search: '' };
    globalThis.window ??= { dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setInterval: () => 0, clearInterval() {} };
    globalThis.CustomEvent ??= class CustomEvent extends Event {
        constructor(type, options) { super(type); this.detail = options?.detail; }
    };
    const services = path.join(SDK_ROOT, 'sdk/services');
    const load = file => import(pathToFileURL(file).href);
    const [store, runtimeModule, clientModule, wallet] = await Promise.all([
        load(path.join(services, 'browserWalletStore.js')),
        load(path.join(services, 'browserWalletRuntime.js')),
        load(path.join(services, 'zkapiClient.js')),
        load(path.join(SDK_ROOT, 'sdk/wallet.js'))
    ]);
    globalThis.zkapiWallet = wallet.default;
    sdk = { store, runtime: runtimeModule.default, ZkapiClient: clientModule.ZkapiClient };
}

function finalizeReceipt({ credited, noteId = 7, destination = REAL_DESTINATION, amount = FINAL_BALANCE,
    hashValue = FINALIZE_HASH, blockNumber = CLOSE_BLOCK } = {}) {
    return {
        transactionHash: hashValue, blockNumber: hex(blockNumber), status: '0x1',
        logs: [
            ...(credited ? [{ address: VAULT, topics: [TOPICS.deferred, `0x${word(noteId)}`, `0x${word(destination)}`],
                data: `0x${word(amount)}`, removed: false }] : []),
            { address: VAULT, topics: [TOPICS.finalized, `0x${word(noteId)}`],
                data: `0x${word(99)}${word(amount)}${word(destination)}`, removed: false }
        ]
    };
}

function claimReceipt({ destination = REAL_DESTINATION, amount = FINAL_BALANCE, blockNumber = CLOSE_BLOCK + 20,
    hashValue = CLAIM_HASH } = {}) {
    return {
        transactionHash: hashValue, blockNumber: hex(blockNumber), status: '0x1',
        logs: [{ address: VAULT, topics: [TOPICS.claimed, `0x${word(destination)}`], data: `0x${word(amount)}`, removed: false }]
    };
}

function scriptedChain() {
    const chain = { head: CLOSE_BLOCK + 10, finalized: CLOSE_BLOCK - 10, credits: new Map(), receipts: new Map(),
        transactions: new Map(), raises: [], claimRevert: null, sent: [], calls: [] };
    chain.provider = {
        async request({ method, params = [] }) {
            chain.calls.push({ method, params: structuredClone(params) });
            if (method === 'eth_chainId') return hex(CHAIN);
            if (method === 'eth_blockNumber') return hex(chain.head);
            if (method === 'eth_getBlockByNumber') return { number: hex(chain.finalized) };
            if (method === 'eth_getTransactionReceipt') return structuredClone(chain.receipts.get(params[0]) ?? null);
            if (method === 'eth_getTransactionByHash') return structuredClone(chain.transactions.get(params[0]) ?? null);
            if (method === 'eth_getLogs') {
                const [{ address, topics, fromBlock, toBlock }] = params;
                assert.equal(address, VAULT);
                assert.deepEqual(topics, [TOPICS.raised, `0x${word(7)}`]);
                return chain.raises.filter(log => BigInt(log.blockNumber) >= BigInt(fromBlock)
                    && BigInt(log.blockNumber) <= BigInt(toBlock));
            }
            if (method === 'eth_call') {
                const [{ to, data }] = params;
                assert.equal(to, VAULT);
                if (data.startsWith(SELECTORS.notes)) return `0x${[0, 0, 0, 3].map(word).join('')}`;
                if (data.startsWith(SELECTORS.credits)) return `0x${word(chain.credits.get(`0x${data.slice(-40)}`) ?? 0)}`;
                throw new Error(`unexpected eth_call ${data.slice(0, 10)}`);
            }
            if (method === 'eth_estimateGas') {
                if (chain.claimRevert) throw { code: 3, message: 'execution reverted', data: chain.claimRevert };
                return '0x9c40';
            }
            if (method === 'eth_sendTransaction') {
                chain.sent.push(structuredClone(params[0]));
                const destination = `0x${params[0].data.slice(-40)}`;
                const amount = chain.credits.get(destination) ?? 0;
                chain.credits.set(destination, 0);
                chain.receipts.set(CLAIM_HASH, claimReceipt({ destination, amount, blockNumber: chain.head + 1 }));
                return CLAIM_HASH;
            }
            throw new Error(`unexpected RPC ${method}`);
        }
    };
    return chain;
}

function creditedRecord(noteId, overrides = {}) {
    return { recordId: realRecordId(noteId), deploymentId: DEPLOYMENT, chainId: CHAIN, contractAddress: VAULT,
        mode: 'escape', phase: 'closed', chainStatus: 'closed', noteId, destination: REAL_DESTINATION,
        finalBalance: FINAL_BALANCE, payoutCredited: true, payoutVerified: false, creditedAmount: FINAL_BALANCE,
        payoutCreditEvidence: 'receipt', closeBlockNumber: CLOSE_BLOCK, createdAt: NOW - 86_400_000, updatedAt: NOW,
        ...overrides };
}

async function realScenario(records) {
    indexedDB.clear?.();
    await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase('zkapi-browser-wallet-v1');
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
    });
    sdk.runtime.manifest = { deployment_id: DEPLOYMENT };
    sdk.runtime.config = { funding: NATIVE_FUNDING };
    sdk.runtime.browserConfig = { trusted_deployment: { vault_revision: 2 } };
    sdk.runtime.init = async () => sdk.runtime.snapshot();
    for (const record of records) await sdk.store.putBrowserWithdrawal(record);
    await sdk.runtime.reload();
    const chain = scriptedChain();
    globalThis.ethereum = chain.provider;
    const client = new sdk.ZkapiClient();
    client.browserMode = true;
    client.config = sdk.runtime.config;
    client.connectWallet = async () => FROM;
    client.refresh = async () => {
        await sdk.runtime.reload();
        client.withdrawals = sdk.runtime.snapshot().withdrawals;
        return client.snapshot();
    };
    await client.refresh();
    // The rows the dialog reads: the public records the runtime publishes.
    const rows = () => sdk.runtime.snapshot().withdrawals;
    const row = noteId => rows().find(entry => entry.noteId === noteId);
    return { chain, client, rows, row };
}

test('wiring:credited-payouts the real client\'s claim turns the published record from held to delivered', { skip }, async () => {
    const { chain, client, row } = await realScenario([
        creditedRecord(7),
        creditedRecord(8, { phase: 'closed_unconfirmed', creditedAmount: 300_000, finalBalance: 300_000 }),
        creditedRecord(9, { destination: `0x${'44'.repeat(20)}`, creditedAmount: 1 })
    ]);
    chain.credits.set(REAL_DESTINATION, FINAL_BALANCE + 300_000);

    // As published, before the claim: held, with the claim offered.
    for (const noteId of [7, 8, 9]) {
        const extras = recordExtras(row(noteId), CTX);
        assert.equal(extras.label, 'Payout held', `note ${noteId}`);
        assert.deepEqual(buttons(extras.actionsHtml).map(button => button.recordId), [realRecordId(noteId)]);
    }

    // The click: the button's own id goes to the client.
    const claim = buttons(recordExtras(row(7), CTX).actionsHtml)[0];
    const statuses = [];
    const result = await client.claimEscapePayout(claim.recordId, text => statuses.push(text));
    assert.equal(result.status, 'claimed');
    assert.equal(result.transactionHash, CLAIM_HASH);
    assert.equal(chain.sent.length, 1);
    assert.equal(chain.sent[0].data, `${SELECTORS.claim}${word(REAL_DESTINATION)}`);

    // After: the address's two records are delivered and say where the claim
    // is; the other address's record is still held.
    for (const noteId of [7, 8]) {
        const extras = recordExtras(row(noteId), CTX);
        assert.equal(extras.label, null, `note ${noteId}`);
        assert.equal(extras.actionsHtml, '');
        assert.match(words(extras.noteHtml), /^This payout was claimed and paid to 0x5615…23b72f\./);
        assert.match(words(extras.noteHtml), /The claim paid \$1\.00 in total/);
        assert.match(extras.noteHtml, new RegExp(`href="${explorer(CLAIM_HASH)}"`));
    }
    assert.equal(recordExtras(row(9), CTX).label, 'Payout held');
    assert.deepEqual(client.creditedEscapePayouts.map(entry => entry.noteId), [9]);

    // Asked again, the SDK says it is delivered and sends nothing.
    assert.equal((await client.claimEscapePayout(realRecordId(7))).status, 'claimed');
    assert.equal(chain.sent.length, 1);
});

test('wiring:credited-payouts the real client reports a payout that was already delivered as gone, with no claim', { skip }, async () => {
    const { chain, client, row } = await realScenario([creditedRecord(7, { creditedAmount: null,
        payoutCreditEvidence: 'vault_credit', phase: 'closed_unconfirmed' })]);
    chain.credits.set(REAL_DESTINATION, 0);
    assert.equal(recordExtras(row(7), CTX).label, 'Payout held');
    assert.match(words(recordExtras(row(7), CTX).noteHtml), /The amount isn’t shown here/);
    const result = await client.claimEscapePayout(realRecordId(7));
    assert.equal(result.status, 'claimed');
    assert.equal(result.transactionHash, null);
    assert.equal(chain.sent.length, 0, 'nothing was sent: the vault held nothing');
    const extras = recordExtras(row(7), CTX);
    assert.equal(row(7).payoutClaimEvidence, 'credit_cleared');
    assert.equal(extras.label, null);
    assert.match(words(extras.noteHtml), /^The payment contract no longer holds this payout/);
    assert.doesNotMatch(extras.noteHtml, /<a\b/);
});

test('wiring:credited-payouts a claim the real client already sent shows as sent on the published record', { skip }, async () => {
    const { chain, client, row } = await realScenario([creditedRecord(7, { payoutClaimTransactionHashes: [CLAIM_HASH] })]);
    chain.credits.set(REAL_DESTINATION, FINAL_BALANCE);
    chain.transactions.set(CLAIM_HASH, { hash: CLAIM_HASH, from: FROM, to: VAULT });
    assert.match(words(recordExtras(row(7), CTX).noteHtml), /A claim for this payout was already sent\./);
    const result = await client.claimEscapePayout(realRecordId(7));
    assert.equal(result.status, 'pending');
    assert.equal(result.transactionHash, CLAIM_HASH);
    assert.equal(chain.sent.length, 0, 'no second claim was sent');
    assert.equal(recordExtras(row(7), CTX).label, 'Payout held');
});

test('wiring:payout-alert the real client\'s close that paid less than the floor publishes the alert the row shows', { skip }, async () => {
    // A balance of 1_000_000 with a last chat budget of 100_000 pays at least
    // 900_000. The operator raised the concession to 300_000 after the escape
    // started, so the vault paid 700_000: below the floor.
    const NULLIFIER = '0x99';
    const { chain, client, row } = await realScenario([{
        recordId: realRecordId(7), deploymentId: DEPLOYMENT, chainId: CHAIN, contractAddress: VAULT, mode: 'escape',
        phase: 'finalizing', chainStatus: 'pending_withdrawal', noteId: 7, destination: REAL_DESTINATION,
        finalBalance: 1_000_000, stateBalance: '1000000', concededAtInit: '0', boundAtState: '100000',
        withdrawalNullifier: NULLIFIER, startBlockNumber: CLOSE_BLOCK - 100, lastObservedBlock: CLOSE_BLOCK - 50,
        finalizeTransactionHash: FINALIZE_HASH, finalizeTransactionHashes: [FINALIZE_HASH], createdAt: NOW, updatedAt: NOW
    }]);
    chain.raises = [{ address: VAULT, blockNumber: hex(CLOSE_BLOCK - 90), logIndex: '0x0', removed: false,
        topics: [TOPICS.raised, `0x${word(7)}`],
        data: `0x${word(NULLIFIER)}${word(300_000)}${word(700_000)}` }];
    chain.receipts.set(FINALIZE_HASH, finalizeReceipt({ credited: false, amount: 700_000 }));
    await client.syncEscapeWithdrawals(() => {});
    const published = row(7);
    assert.equal(published.payoutAlert, 'concession_exceeded_bound');
    assert.equal(published.concededFinal, '300000');
    assert.equal(published.finalBalance, 700_000);
    const extras = recordExtras(published, CTX);
    assert.equal(extras.badge, 'Paid less than expected');
    assert.equal(extras.label, null);
    assert.match(words(extras.noteHtml), /The withdrawal paid out \$0\.70\. Your balance minus your last chat’s budget was \$0\.90\./);
    assert.equal(hasPayoutAlert(published), true);
    // The payout was paid, so nothing is held and nothing can be claimed.
    assert.equal(extras.actionsHtml, '');
});

// -------------------------------------------------------------- vocabulary

const FORBIDDEN = /nullifier|vault|circuit|deployment|manifest|\bnotes?\b|note\s*#|#\s*\d|unlinkable|untraceable|anonymous|zero.knowledge|proof\b|escape hatch|mutual close|sync|reconcil|check status|confirmation continues|nothing is lost/i;

test('the words are calm and plain: no jargon, no unit words in templates, curly apostrophes', () => {
    const values = { destination: SHORT_DESTINATION, amount: '$0.80', paid: '$3.00', floor: '$4.00' };
    for (const [key, template] of Object.entries(RECORD_EXTRAS_WORDS)) {
        assert.equal(typeof template, 'string', key);
        assert.equal(FORBIDDEN.test(template), false, `${key}: ${template}`);
        assert.equal(/!/.test(template), false, `${key}: exclamation`);
        assert.equal(/'/.test(template), false, `${key}: straight apostrophe`);
        assert.equal(/\p{Extended_Pictographic}/u.test(template), false, `${key}: emoji`);
        assert.equal(/\b[A-Z]{3,}\b/.test(template), false, `${key}: unit or shouting word`);
        assert.equal(/[<>&"]/.test(template), false, `${key}: markup`);
        assert.equal(/\s{2,}|\s[.,;:]/.test(template), false, `${key}: spacing`);
        const filled = template.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? assert.fail(`${key}: unknown token ${name}`));
        assert.equal(filled, filled.trim(), key);
        for (const sentence of filled.split(/(?<=[.?])\s+/)) {
            assert.match(sentence, /^[A-Z0-9$]/, `${key}: "${sentence}"`);
        }
        assert.equal(/\b(?:to|into|from|on|in|by|until|before|of|at)\s*[.,;:?]?$/.test(filled.replace(/\.$/, '')), false, key);
    }
});

test('everything a row can say passes the same sweep, with the figures and without', () => {
    const variants = [
        CTX, { ...CTX, formatMoney: noPrice }, { ...CTX, busy: true }, { ...CTX, compact: () => '0xabcd…ef' }, {}
    ];
    const records = [...OWN, { ...byNote(CREDITED), payoutClaimTransactionHashes: [hash('c')] },
        { ...byNote(CLAIMED), payoutClaimEvidence: 'credit_cleared' }, { ...byNote(CREDITED), payoutAlert: 'concession_exceeded_bound' }];
    let seen = 0;
    for (const record of records) {
        for (const ctx of variants) {
            const extras = recordExtras(record, ctx);
            const all = [extras.label, extras.badge, words(extras.noteHtml), words(extras.actionsHtml)].filter(Boolean);
            for (const text of all) {
                seen += 1;
                assert.equal(FORBIDDEN.test(text), false, text);
                assert.equal(/!/.test(text), false, text);
                assert.equal(/'/.test(text), false, text);
                assert.equal(/\p{Extended_Pictographic}/u.test(text), false, text);
                assert.equal(/\{|\}/.test(text), false, `unfilled token: ${text}`);
                assert.equal(/\s[.,;:]|\.\./.test(text), false, text);
            }
            // The payout is never called returned or sent while it is held.
            if (extras.label === 'Payout held') {
                assert.doesNotMatch(words(extras.noteHtml), /\breturned\b|funds sent|all back|sent to your wallet/i);
            }
        }
    }
    assert.ok(seen > 40, `seen ${seen}`);
});

// ----------------------------------------------------------------- styling

test('styling: only utilities and classes the app already ships', () => {
    const css = ['chat/tailwind.generated.css', 'chat/zkapi/zkapi.css', 'chat/styles.css']
        .map(file => fs.readFileSync(path.join(repoRoot, file), 'utf8')).join('\n');
    const escape = name => name.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
    const used = new Set();
    for (const record of [...OWN, { ...byNote(CREDITED), payoutAlert: 'concession_exceeded_bound',
        payoutClaimTransactionHashes: [hash('c')] }]) {
        const extras = recordExtras(record, CTX);
        for (const [, classes] of (extras.noteHtml + extras.actionsHtml).matchAll(/class="([^"]*)"/g)) {
            classes.split(/\s+/).filter(Boolean).forEach(name => used.add(name));
        }
    }
    assert.ok(used.size >= 15, [...used].join(' '));
    for (const name of used) {
        const selector = `.${escape(name)}`;
        const present = [' ', ',', '{', ':', '\n', '.', '>'].some(next => css.includes(selector + next));
        assert.ok(present, `class "${name}" is in no stylesheet the app ships`);
    }
});

// ------------------------------------------------------------ architecture

test('the module is SDK-free, DOM-free and clock-free: two sibling imports and nothing else', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'chat/zkapi/components/RecordExtras.js'), 'utf8');
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map(match => match[1]);
    assert.deepEqual(imports.sort(), ['../versioning/copy.mjs', '../versioning/walletHoldings.mjs']);
    assert.doesNotMatch(source, /\bimport\s*\(/);
    // No platform access of any kind.
    const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /\b(?:document|window|localStorage|sessionStorage|indexedDB|navigator|fetch|XMLHttpRequest|Date|Math\.random|setTimeout|setInterval|console)\b/);
    assert.doesNotMatch(code, /\bzkapiClient\b|\bzkapiVersioning\b|\boaVersioning\b/);
});
