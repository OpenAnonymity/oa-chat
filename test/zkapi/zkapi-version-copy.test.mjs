import assert from 'node:assert/strict';
import test from 'node:test';
import {
    COPY_KEYS,
    OPERATOR_TEXT_LIMIT,
    boundedOperatorText,
    copyTokens,
    escapeHtml,
    formatLocalDateTime,
    gateCopyKey,
    gateOffersReload,
    safeOperatorText,
    serviceCopyKey,
    upgradeBannerKey,
    versionCopy,
    versionCopyText,
    versionName
} from '../../chat/zkapi/versioning/copy.mjs';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { chooseZkapiVersion } from '../../chat/zkapi/versioning/versionLoader.mjs';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import {
    NOW_MS,
    activatedRegistry,
    normalizedSnapshot,
    resolvedTable,
    threeVersionRegistry
} from './_registryFixtures.mjs';

// Every CopyKey of the copy table, in table order.
const EXPECTED_KEYS = [
    'pill', 'help.title', 'help.current', 'help.previous', 'banner.available', 'banner.soon', 'banner.tier7',
    'banner.tier3', 'banner.tier1', 'banner.overdue', 'deposits.closed', 'deposits.closed.started',
    'deposits.blocked.previous', 'deposits.blocked.unreadable', 'deposits.blocked.foreign',
    'deposits.blocked.retired', 'deposits.blocked.stale', 'send.closed', 'send.largerKey', 'reload.otherTab',
    'reload.busy', 'upgrade.review', 'upgrade.review.fee', 'upgrade.destination.connected',
    'upgrade.destination.newAddress', 'upgrade.destination.other', 'upgrade.withdrawn', 'upgrade.deposit',
    'upgrade.done', 'draft.cleared', 'unsent.explain', 'unsent.cancel', 'previous.open', 'previous.credit',
    'service.paused', 'admission.closed', 'near_expiry', 'legacy.unreachable', 'unavailable', 'discard.loop',
    'service.paused.unreachable', 'service.paused.changed', 'service.paused.untrusted', 'service.paused.incompatible',
    'service.paused.contract', 'service.check', 'service.stillPaused', 'near.balance', 'setAside.near',
    'exit.settlement', 'exit.concede.zero', 'exit.concede.bound', 'exit.bound', 'exit.proofWait',
    'exit.releasePending', 'exit.frozen', 'exit.device', 'exit.device.label', 'exit.rpc', 'payout.alert',
    'payout.alert.badge', 'payout.credited', 'payout.notice', 'kit.never', 'kit.unsaved', 'kit.stale',
    'operator.reference', 'abandon.zero', 'abandon.dust', 'abandon.dustNoPrice', 'abandon.chain',
    'abandon.irreversible', 'abandon.link', 'abandon.linkZero', 'held.label', 'held.unreachable', 'held.summary'
];
// The keys a revision 3 balance adds, so a sweep can tell them apart. The
// held-balance keys are about any version whose service did not start, and
// read none of the exit tokens.
const PROTOCOL_KEYS = EXPECTED_KEYS.slice(EXPECTED_KEYS.indexOf('discard.loop') + 1)
    .filter(key => !key.startsWith('held.'));

const TOKENS = { N: 2, F: 1, closeBy: 'Nov 18, 2026, 3:00 PM', expiry: 'Nov 21, 2026, 12:00 AM' };
// P (the other version) and R (where a reload goes) are distinct from N and F
// on purpose: a text that read the wrong token would show the wrong number.
const ALL_TOKENS = {
    ...TOKENS, P: 3, R: 4, message: 'Back at noon.', amount: '$0.50', reload: 1, blocked: 0, sepolia: 1
};
// The tokens of the exit facts and the balance. None carries a unit word in
// capitals: a unit arrives through `eth`, built by the caller, so a template
// that spelled one would show in the sweeps below. V is distinct from N, F, P
// and R for the same reason P and R are.
const EXIT_TOKENS = {
    V: 5, until: 'Nov 20, 2026, 9:00 AM', escapeAt: 'Nov 21, 2026, 4:00 PM', exitBy: 'Nov 18, 2026, 3:00 PM',
    setAsideBy: 'Nov 19, 2026, 6:00 PM', bound: '$0.25', retryIn: 4, limit: '$1.00', eth: '0.00014 ether',
    destination: '0x1234…cdef', count: 3, reference: 7, retired: 1
};

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

test('every CopyKey has copy, and nothing else does', () => {
    assert.deepEqual([...COPY_KEYS].sort(), [...EXPECTED_KEYS].sort());
    assert.ok(Object.isFrozen(COPY_KEYS));
    for (const key of EXPECTED_KEYS) {
        assert.ok(versionCopy(key, { ...ALL_TOKENS, ...EXIT_TOKENS }).length > 0, key);
    }
    assert.ok(PROTOCOL_KEYS.length >= 30);
});

test('the canonical text of the copy table', () => {
    // In these sentences the "other" version is F and a reload goes to N.
    const t = { ...TOKENS, P: 1, R: 2 };
    const expected = {
        'pill': 'Version 1',
        'help.title': 'About versions',
        'help.current': 'Your balance is on version 1, the latest version.',
        'help.previous': 'Your balance is on version 1. It keeps working, but new deposits go to version 2, '
            + 'and a balance can\u2019t move between versions. To upgrade, withdraw your balance and deposit again.',
        'banner.available': 'Version 2 is available. Your balance is on version 1 and keeps working until '
            + `${t.expiry}. You can upgrade any time before ${t.closeBy}: withdraw your balance, then deposit again.`,
        'banner.soon': `Upgrade to version 2 by ${t.closeBy}. Your balance is on version 1. It keeps working `
            + 'until then. Withdraw your balance, then deposit again.',
        'banner.tier7': `7 days left to upgrade. Withdraw by ${t.closeBy}.`,
        'banner.tier3': `3 days left to upgrade. Withdraw by ${t.closeBy}.`,
        'banner.tier1': 'Less than a day left to upgrade. Withdraw now to get your unused balance back.',
        'banner.overdue': 'Upgrade now. Withdrawals can take a while to confirm. '
            + `After ${t.expiry}, the service treasury can claim your full original deposit, and nothing is refunded.`,
        'deposits.closed': 'Deposits moved to version 2. This page is on version 1, which no longer accepts new deposits.',
        'deposits.closed.started': 'Your saved deposit can still be finished here.',
        'deposits.blocked.previous': 'A withdrawal from version 1 is still finishing. Open version 1 to finish it, '
            + 'then come back to deposit.',
        'deposits.blocked.unreadable': 'We could not read your saved balance. Reload to try again. Nothing was changed.',
        'deposits.blocked.stale': 'Reload to update before depositing.',
        'send.closed': 'Version 1 no longer accepts deposits. Reload to continue in version 2.',
        'reload.otherTab': 'This browser\u2019s balance moved to version 2 in another tab. Reload to keep going. '
            + 'Nothing is lost; your balance is saved in this browser.',
        'upgrade.review.fee': 'Withdrawing is an Ethereum transaction and its network fee can be large. If your '
            + 'balance is small, the fee may cost more than you would get back; your wallet shows the fee before '
            + 'you confirm. You can also keep using your balance until it expires.',
        'upgrade.withdrawn': 'Withdrawal confirmed. Your balance is back in your wallet. '
            + 'Reload to deposit into version 2.',
        'upgrade.deposit': 'Your balance is withdrawn. Deposit to finish upgrading to version 2.',
        'upgrade.done': 'Upgrade complete. Your balance is on version 2.',
        'draft.cleared': 'Cleared an unused deposit quote. Nothing was spent.',
        'near_expiry': 'This balance is about to expire. Withdraw it now. New chats are paused so nothing is '
            + 'left unsettled.',
        'unavailable': 'zkAPI could not start in this tab. Reload to try again. Your balance is saved in this browser.',
        'discard.loop': 'Close other open tabs of this app, then reload.'
    };
    for (const [key, text] of Object.entries(expected)) {
        assert.equal(versionCopy(key, t), text, key);
    }
});

test('the canonical text of the protocol keys, with and without their tokens', () => {
    const expected = [
        ['service.paused.unreachable', {}, 'The private service can’t be reached right now, so new chats and '
            + 'deposits are paused. You can still withdraw your balance.'],
        ['service.paused.changed', {}, 'The private service changed in a way this page doesn’t recognize, so new '
            + 'chats and deposits are paused to keep your balance safe. You can still withdraw. Reload to get the '
            + 'latest page.'],
        ['service.paused.untrusted', {}, 'This page was opened with a service link it doesn’t trust, so new chats '
            + 'and deposits are paused. You can still withdraw. Open the app without that link.'],
        ['service.paused.incompatible', {}, 'The service is running an older, incompatible protocol, so new chats '
            + 'and deposits are paused. You can still withdraw your balance.'],
        ['service.paused.contract', {}, 'We couldn’t confirm the payment contract with the network provider, so '
            + 'new chats and deposits are paused. You can still withdraw. Try again in a moment.'],
        ['service.check', {}, 'Check again'],
        ['service.stillPaused', {}, 'The private service is still unavailable. You can still withdraw your balance.'],
        ['near.balance', {}, 'New chats are paused because this balance is about to expire. Withdraw it to get '
            + 'the unused amount back. If it expires, the service treasury can claim it.'],
        ['near.balance', { exitBy: 'Nov 18' }, 'New chats are paused because this balance is about to expire. '
            + 'Withdraw it to get the unused amount back. Start the withdrawal by Nov 18. If it expires, the '
            + 'service treasury can claim it.'],
        ['setAside.near', {}, 'A balance you set aside is close to its deadline. Finish withdrawing it from '
            + 'Payment history. A balance that is not withdrawn before it expires can be claimed by the service '
            + 'treasury.'],
        ['setAside.near', { setAsideBy: 'Nov 19' }, 'A balance you set aside is close to its deadline. Finish '
            + 'withdrawing it from Payment history by Nov 19. A balance that is not withdrawn before it expires '
            + 'can be claimed by the service treasury.'],
        ['exit.settlement', {}, 'A recent chat may still be settling, so a normal withdrawal waits for it. You '
            + 'can wait, or leave now with an emergency exit, which takes longer to finish.'],
        ['exit.settlement', { escapeAt: 'Nov 21' }, 'A recent chat may still be settling, so a normal withdrawal '
            + 'waits for it until Nov 21. You can wait, or leave now with an emergency exit, which takes longer '
            + 'to finish.'],
        ['exit.concede.zero', { bound: '$0.25' }, 'Give up nothing now. If the service later shows that chat was '
            + 'charged, up to $0.25 may still be taken from your payout.'],
        ['exit.concede.zero', {}, 'Give up nothing now. If the service later shows that chat was charged, its '
            + 'cost may still be taken from your payout.'],
        ['exit.concede.bound', { bound: '$0.25' }, 'Give up up to $0.25 now. That chat isn’t recorded on '
            + 'Ethereum, so you may give up more than it actually cost.'],
        ['exit.bound', { bound: '$0.25' }, 'If a recent chat is still settling, a withdrawal can give up as much '
            + 'as $0.25.'],
        ['exit.bound', {}, 'If a recent chat is still settling, a withdrawal can give up part of your balance.'],
        ['exit.proofWait', { retryIn: 4 }, 'Your earlier withdrawal request is about to expire. Try again in 4 '
            + 'seconds.'],
        ['exit.proofWait', { retryIn: 1 }, 'Your earlier withdrawal request is about to expire. Try again in 1 '
            + 'second.'],
        ['exit.proofWait', {}, 'Your earlier withdrawal request is about to expire. Try again in a few seconds.'],
        ['exit.releasePending', {}, 'An earlier withdrawal attempt has expired, but the network hasn’t confirmed '
            + 'yet that it can no longer go through. Try again shortly.'],
        ['exit.frozen', { until: 'Nov 20' }, 'This balance is frozen while an earlier withdrawal can still go '
            + 'through. New chats resume after Nov 20. You can still withdraw.'],
        // No end time is no promise that it ends on its own.
        ['exit.frozen', {}, 'This balance is frozen while a withdrawal of it has started and not finished. New '
            + 'chats resume when it finishes or can no longer go through. You can still withdraw.'],
        ['exit.device', {}, 'This balance was used on another device or copy after this browser last saved it, '
            + 'so this browser can’t safely withdraw it. Withdraw it from the device that used it last, or use '
            + 'your newest exit kit with the zkAPI companion tool. Trying here would cost network fees and be '
            + 'rejected.'],
        ['exit.device.label', {}, 'Used on another device'],
        ['exit.rpc', {}, 'Keep a current exit kit so you can leave even if the service is unavailable.'],
        ['payout.alert', {}, 'A withdrawal paid out less than your balance minus your last chat’s budget. The '
            + 'payment can’t be changed. Please report it to the service operator.'],
        ['payout.alert.badge', {}, 'Paid less than expected'],
        ['payout.credited', { amount: '$0.80', destination: '0x1234…cdef' }, 'Payout held: $0.80. It could not '
            + 'be sent to your address, so the payment contract holds it for you. Claim it to receive it at '
            + '0x1234…cdef.'],
        ['payout.credited', {}, 'Payout held. It could not be sent to your address, so the payment contract '
            + 'holds it for you. Claim it to receive it.'],
        ['payout.notice', { count: 1 }, 'A payout is held for you. Open Payment history to claim it.'],
        ['payout.notice', { count: 2 }, '2 payouts are held for you. Open Payment history to claim them.'],
        ['payout.notice', {}, 'Payouts are held for you. Open Payment history to claim them.'],
        ['kit.unsaved', {}, 'Your exit kit was created but not saved. Create it again and save the file.'],
        ['kit.stale', {}, 'Your exit kit is older than your latest chats and no longer opens this balance. '
            + 'Create a new one.'],
        ['operator.reference', { reference: 7, V: 'v1' }, 'Reference number 7 for version 1.'],
        ['operator.reference', { reference: 7, V: 'v1', retired: 1 }, 'Reference number 7 for version 1, which has been retired.'],
        ['operator.reference', { reference: 7, retired: 1 }, 'Reference number 7.'],
        ['operator.reference', { reference: 7 }, 'Reference number 7.'],
        ['operator.reference', {}, ''],
        // The first note of a deployment is number 0: a reference like any other.
        ['operator.reference', { reference: 0 }, 'Reference number 0.'],
        ['operator.reference', { reference: '0', V: 'v2' }, 'Reference number 0 for version 2.'],
        ['operator.reference', { reference: 0, V: 'v1', retired: 1 }, 'Reference number 0 for version 1, which has been retired.'],
        ['operator.reference', { reference: '' }, ''],
        ['abandon.zero', { F: 1, N: 2 }, 'This balance is empty, and version 1 no longer takes deposits. Clear it '
            + 'to deposit into version 2. Nothing moves on Ethereum.'],
        ['abandon.dust', { F: 1, N: 2, amount: '$0.42', eth: '0.00014 ether', limit: '$1.00' }, 'This balance is '
            + '$0.42 (0.00014 ether), and version 1 no longer takes deposits. A withdrawal costs a network fee, '
            + 'which may be more than this balance is worth. You can give it up to deposit into version 2, or '
            + 'withdraw it instead. Only balances below $1.00 can be given up.'],
        ['abandon.dust', {}, 'This balance is very small, and this version no longer takes deposits. A '
            + 'withdrawal costs a network fee, which may be more than this balance is worth. You can give it up '
            + 'to deposit into the newer version, or withdraw it instead.'],
        ['abandon.chain', {}, 'Nothing moves on Ethereum. Your deposit stays in the service’s payment contract '
            + 'until it expires, and then the service treasury can claim it, as it could have anyway.'],
        ['abandon.irreversible', {}, 'This app can’t bring the balance back once you give it up.'],
        ['abandon.link', {}, 'Give up this balance'],
        ['abandon.linkZero', {}, 'Clear this balance']
    ];
    for (const [key, tokens, text] of expected) {
        assert.equal(versionCopy(key, tokens), text, `${key} ${JSON.stringify(tokens)}`);
    }
});

test('a page on the deposit target is never told to deposit into its own version when giving up a balance', () => {
    assert.equal(
        versionCopy('abandon.zero', { F: 2, N: 2 }),
        'This balance is empty, and version 2 no longer takes deposits. Clear it to deposit into the newer version. '
        + 'Nothing moves on Ethereum.'
    );
});

test('a balance the page holds and cannot read is saved, its service is not available, and the newer version needs it withdrawn', () => {
    // The whole explanation, with both versions named.
    assert.equal(
        versionCopy('held.unreachable', { F: 1, N: 2 }),
        'Your balance is still saved in this browser. Version 1\u2019s service isn\u2019t available right now, so the '
        + 'balance can\u2019t be shown yet. Reload to check again. To use version 2, first '
        + 'withdraw this balance from version 1.'
    );
    assert.equal(versionCopyText('held.label'), 'Saved in this browser');
    assert.equal(
        versionCopyText('held.summary'),
        'Your balance is saved in this browser, but its service isn\u2019t available right now. Reload to check again.'
    );
    // Without the version it names, a plain-words stand-in; without a newer
    // version there is nothing to "use" instead, so that sentence is gone.
    assert.equal(
        versionCopy('held.unreachable', { N: 2 }),
        'Your balance is still saved in this browser. This version\u2019s service isn\u2019t available right now, so the '
        + 'balance can\u2019t be shown yet. Reload to check again. To use version 2, first '
        + 'withdraw this balance from this version.'
    );
    for (const tokens of [{ F: 2 }, {}, { F: 2, N: 2 }]) {
        const text = versionCopy('held.unreachable', tokens);
        assert.equal(text.includes('To use version'), false, JSON.stringify(tokens));
        assert.match(text, /^Your balance is still saved in this browser\. /);
        assert.match(text, /Reload to check again\.$/);
    }
    // Every part of the three sentences the state needs is there.
    for (const tokens of [{ F: 1, N: 2 }, { F: 1 }, { N: 2 }, {}]) {
        const text = versionCopy('held.unreachable', tokens);
        assert.match(text, /saved in this browser/);
        assert.match(text, /isn\u2019t available right now/);
        assert.match(text, /Reload to check again\./);
    }
});

test('the held-balance words never promise a return that needs nothing from the person, and never name a cause', () => {
    // The start is attempted again only by a reload, so the words say reload and
    // never "when the service is back", which a person would wait for.
    for (const key of ['held.unreachable', 'held.summary']) {
        const text = versionCopy(key, ALL_TOKENS);
        assert.match(text, /Reload to check again\./, key);
        assert.equal(/will show|when the service|is back|automatically|on its own|soon/i.test(text), false, `${key}: ${text}`);
        // Whatever stopped the start is "not available" to the page: no answer, an
        // answer the page does not trust and a service on another protocol read
        // the same, and the SDK's text for any of them names the operator.
        assert.equal(/answer|respond|reach|trust|incompatible|protocol|paused/i.test(text), false, `${key}: ${text}`);
    }
});

test('the held-balance words offer nothing, say nothing was lost and name no address', () => {
    for (const key of ['held.label', 'held.unreachable', 'held.summary']) {
        const text = versionCopy(key, { ...ALL_TOKENS, ...EXIT_TOKENS });
        // No funding, no moved deposits, no claim about what is safe or kept.
        assert.equal(/add funds|deposit(?:s| into)|moved|nothing is lost|nothing was|guarantee|\bsafe\b/i.test(text), false, `${key}: ${text}`);
        // No address, no link, no technical word of the service.
        assert.equal(/https?:|www\.|\.com|\.ai|\.invalid|config\.json|\b503\b|\bHTTP\b/i.test(text), false, `${key}: ${text}`);
        // Nothing the person could press: the words are not an instruction to withdraw now.
        assert.equal(/withdraw it now|upgrade now|give up|clear this/i.test(text), false, `${key}: ${text}`);
    }
    // The one thing to do is reload, and nothing that needs the service.
    assert.match(versionCopy('held.unreachable', ALL_TOKENS), /Reload to check again\./);
});

test('the held-balance text takes its versions from the state and never names the target as the holder', () => {
    const table = resolvedTable(activatedRegistry(), 'mainnet');
    const [v1, v2] = table;
    const held = deriveVersionState({
        table, active: v1, target: v2,
        selection: { version: v1, reason: 'runtime_holds_note', slotOwner: 'v1', open: {}, credits: {},
            foreignDeploymentId: null, depositBlock: null, draftDiscarded: false, slotKind: 'note' },
        snapshot: normalizedSnapshot(), intent: null, previewSelection: null, now: NOW_MS, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false, initFailed: true,
        adapter: getAdapter(v1.adapter)
    });
    assert.equal(held.phase, 'balance-unreachable');
    assert.equal(
        versionCopyText('held.unreachable', copyTokens(held)),
        'Your balance is still saved in this browser. Version 1\u2019s service isn\u2019t available right now, so the '
        + 'balance can\u2019t be shown yet. Reload to check again. To use version 2, first '
        + 'withdraw this balance from version 1.'
    );
    // On the deposit target there is no other version to move to.
    const onTarget = deriveVersionState({
        table, active: v2, target: v2,
        selection: { version: v2, reason: 'runtime_holds_note', slotOwner: 'v2', open: {}, credits: {},
            foreignDeploymentId: null, depositBlock: null, draftDiscarded: false, slotKind: 'note' },
        snapshot: normalizedSnapshot(), intent: null, previewSelection: null, now: NOW_MS, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false, initFailed: true,
        adapter: getAdapter(v2.adapter)
    });
    assert.equal(onTarget.phase, 'balance-unreachable');
    assert.equal(
        versionCopyText('held.unreachable', copyTokens(onTarget)),
        'Your balance is still saved in this browser. Version 2\u2019s service isn\u2019t available right now, so the '
        + 'balance can\u2019t be shown yet. Reload to check again.'
    );
});

test('the required sentences of the protocol texts are there, and the words that would mislead are not', () => {
    // The concession sentence is required wording whenever the option to
    // give up the bound is offered.
    assert.match(versionCopy('exit.concede.bound', EXIT_TOKENS), /isn’t recorded on Ethereum/);
    assert.match(versionCopy('exit.concede.bound', EXIT_TOKENS), /give up more than it actually cost/);
    // Nothing the app cannot do: it never opens a kit, restores one or sets an exit RPC.
    for (const key of ['exit.device', 'exit.releasePending', 'exit.rpc', 'kit.never', 'kit.unsaved', 'kit.stale']) {
        const text = versionCopy(key, EXIT_TOKENS);
        assert.equal(/\brestore|\bRPC\b|\bimport\b|\bsettings?\b/i.test(text), false, `${key}: ${text}`);
    }
    assert.match(versionCopy('exit.device', {}), /zkAPI companion tool/);
    // A held payout is neither returned nor sent, and an alert is never an apology.
    assert.equal(/returned|your wallet/i.test(versionCopy('payout.credited', EXIT_TOKENS)), false);
    assert.match(versionCopy('payout.credited', EXIT_TOKENS), /Payout held/);
    // Giving up a balance never claims more than is true.
    for (const key of ['abandon.zero', 'abandon.dust', 'abandon.dustNoPrice', 'abandon.chain', 'abandon.irreversible']) {
        const text = versionCopy(key, { ...ALL_TOKENS, ...EXIT_TOKENS });
        assert.equal(/nothing is lost|safe|guarantee|refund/i.test(text.replace('to keep your balance safe', '')), false,
            `${key}: ${text}`);
    }
    // Near expiry never sends the person to an upgrade: the target has none.
    for (const key of ['near.balance', 'near_expiry']) {
        assert.equal(/upgrade/i.test(versionCopy(key, { ...ALL_TOKENS, ...EXIT_TOKENS })), false, key);
    }
});

test('no template spells a unit: amounts and units arrive only through tokens', () => {
    // Every token is a neutral lower-case word, so any unit in the output is
    // template text. (The all-caps sweep below catches the same words with
    // real values; this one catches "wei", "gwei" and a dollar sign too.)
    const neutral = {};
    for (const name of ['N', 'F', 'P', 'R', 'V', 'closeBy', 'expiry', 'message', 'amount', 'until', 'escapeAt',
        'exitBy', 'setAsideBy', 'bound', 'retryIn', 'limit', 'eth', 'destination', 'count', 'reference']) {
        neutral[name] = 'sample';
    }
    for (const flag of ['reload', 'waiting', 'blocked', 'sepolia', 'retired']) neutral[flag] = 1;
    for (const key of COPY_KEYS) {
        const text = versionCopy(key, neutral);
        assert.equal(/\bETH\b|\bg?wei\b|\bUSD\b|\bdollars?\b|\$/i.test(text), false, `${key}: ${text}`);
    }
});

test('the host words of every service code fit the operator-text bound whole', () => {
    for (const key of ['service.paused.unreachable', 'service.paused.changed', 'service.paused.untrusted',
        'service.paused.incompatible', 'service.paused.contract']) {
        const words = versionCopyText(key);
        assert.ok(words.length > 0 && words.length < 280, `${key}: ${words.length}`);
        // Carried by the message token they are unchanged (no cut, no escaping).
        assert.equal(versionCopyText('service.paused', { message: words }), words, key);
        assert.equal(versionCopy('service.paused', { message: words }), words, key);
    }
});

test('serviceCopyKey maps exactly the codes the host can explain', () => {
    assert.equal(serviceCopyKey('deployment_manifest_unavailable'), 'service.paused.unreachable');
    assert.equal(serviceCopyKey('deployment_manifest_mismatch'), 'service.paused.changed');
    assert.equal(serviceCopyKey('deployment_manifest_untrusted'), 'service.paused.untrusted');
    assert.equal(serviceCopyKey('incompatible_proof_circuit'), 'service.paused.incompatible');
    assert.equal(serviceCopyKey('native_vault_unverified'), 'service.paused.contract');
    for (const code of ['something_new', '', null, undefined, 7, {}, 'toString', 'constructor', '__proto__']) {
        assert.equal(serviceCopyKey(code), null, String(code));
    }
});

test('the deposits-closed text adds the reload sentence only when asked', () => {
    assert.equal(versionCopy('deposits.closed', TOKENS).includes('Reload'), false);
    assert.equal(
        versionCopy('deposits.closed', { ...TOKENS, reload: 1 }),
        'Deposits moved to version 2. This page is on version 1, which no longer accepts new deposits. '
        + 'Reload to deposit into version 2.'
    );
    // No target at all: it still reads correctly, without a version to point to.
    assert.equal(
        versionCopy('deposits.closed', { F: 1, reload: 1 }),
        'Version 1 no longer accepts new deposits.'
    );
});

test('the deposits-closed text can say deposits wait for a withdrawal', () => {
    assert.equal(
        versionCopy('deposits.closed', { ...TOKENS, waiting: 1 }),
        'Deposits moved to version 2. This page is on version 1, which no longer accepts new deposits. '
        + 'Deposits to version 2 wait until your withdrawal finishes.'
    );
    assert.equal(versionCopy('deposits.closed', { F: 1, waiting: 1 }), 'Version 1 no longer accepts new deposits.');
});

test('the service text accepts the operator message under its SDK names', () => {
    for (const name of ['message', 'text', 'serviceMessage', 'detail']) {
        assert.equal(versionCopyText('service.paused', { [name]: 'Back at noon.' }), 'Back at noon.', name);
    }
    assert.equal(versionCopyText('service.paused', { text: 'Second', message: 'First' }), 'First');
});

test('the previous-withdrawal text distinguishes "open it" from "withdraw first"', () => {
    assert.equal(
        versionCopy('deposits.blocked.previous', { P: 1, blocked: 1 }),
        'A withdrawal from version 1 is still finishing. To finish it, withdraw your current balance first, '
        + 'then open version 1.'
    );
    assert.equal(
        versionCopy('deposits.blocked.previous', {}),
        'A withdrawal from another version is still finishing. Finish it first, then come back to deposit.'
    );
    assert.equal(
        versionCopy('deposits.blocked.previous', { blocked: 1 }),
        'A withdrawal from another version is still finishing. To finish it, withdraw your current balance first, '
        + 'then open that version.'
    );
    assert.match(versionCopy('previous.credit', { P: 1 }), /Open version 1 to claim it\. This does not stop new deposits\./);
    assert.match(versionCopy('previous.credit', { P: 1, blocked: 1 }), /withdraw your current balance first, then open version 1\./);
    assert.equal(versionCopy('previous.open', { P: 1 }), 'Open version 1');
    assert.equal(versionCopy('previous.open', {}), 'Open another version');
    assert.equal(
        versionCopy('previous.credit', {}),
        'A payout from another version is ready to claim. Open that version to claim it. '
        + 'This does not stop new deposits.'
    );
});

test('the texts about another version read P and never the loaded version', () => {
    for (const key of ['previous.open', 'previous.credit', 'deposits.blocked.previous']) {
        // F and N are the loaded version and the target: not this sentence's business.
        assert.equal(versionCopy(key, { F: 2, N: 3 }), versionCopy(key, {}), key);
        const named = versionCopy(key, { F: 2, N: 3, P: 1 });
        assert.match(named, /version 1/, key);
        assert.equal(/version [23]/.test(named), false, key);
    }
});

test('the reload text names where the reload goes, not the deposit target', () => {
    assert.equal(
        versionCopy('reload.otherTab', { N: 2, R: 1 }),
        'This browser\u2019s balance moved to version 1 in another tab. Reload to keep going. '
        + 'Nothing is lost; your balance is saved in this browser.'
    );
    // No R: no version is named at all (never N, which is a different question).
    assert.equal(
        versionCopy('reload.otherTab', { N: 2 }),
        'This browser\u2019s balance changed in another tab. Reload to keep going. '
        + 'Nothing is lost; your balance is saved in this browser.'
    );
});

test('a page on the deposit target is never told deposits moved to its own version', () => {
    assert.equal(
        versionCopy('deposits.closed', { N: 2, F: 2, reload: 1 }),
        'Version 2 no longer accepts new deposits.'
    );
    assert.equal(versionCopy('send.closed', { N: 2, F: 2 }), 'Version 2 no longer accepts deposits. Reload to continue.');
    assert.equal(
        versionCopy('send.largerKey', { N: 2, F: 2, amount: '$0.50' }),
        'This model requires $0.50 in private balance for a new key. Choose a lower-cap model, '
        + 'or withdraw the remaining balance and fund a larger one.'
    );
    // Different versions keep the sentence.
    assert.match(versionCopy('deposits.closed', { N: 2, F: 1 }), /^Deposits moved to version 2\./);
});

test('a stale tab on the deposit target is never told to deposit into the version that stopped admitting it', () => {
    // 410 deployment_retiring on the page that IS the deposit target: the
    // sentence must not read "Version 2 ... deposit into version 2".
    const own = 'Version 2 is no longer starting new chats. Withdraw your balance.';
    assert.equal(versionCopy('admission.closed', { N: 2, F: 2 }), own);
    assert.equal(versionCopyText('admission.closed', { N: 'v2', F: 'Version 2' }), own);
    // The same holds through the state's own tokens.
    const table = resolvedTable(activatedRegistry(), 'mainnet');
    const [v1, v2] = table;
    const stateOn = active => deriveVersionState({
        table, active, target: v2, adapter: getAdapter(active.adapter), now: NOW_MS,
        selection: chooseZkapiVersion({ table, holdings: [] }), snapshot: normalizedSnapshot(),
        intent: null, previewSelection: null, busy: false, admissionClosed: true, buildClosed: false,
        configBlock: false, unreachable: false
    });
    assert.equal(versionCopy('admission.closed', copyTokens(stateOn(v2))), own);
    // A page on the previous version keeps the way forward.
    assert.equal(
        versionCopy('admission.closed', copyTokens(stateOn(v1))),
        'Version 1 is no longer starting new chats. Withdraw your balance, then deposit into version 2 to keep chatting.'
    );
    // Without a target nothing is promised either.
    assert.equal(versionCopy('admission.closed', { F: 1 }), 'Version 1 is no longer starting new chats. Withdraw your balance.');
});

test('the larger-key text finishes the sentence the chat runtime starts', () => {
    assert.equal(
        versionCopy('send.largerKey', { N: 2, amount: '$0.50' }),
        'This model requires $0.50 in private balance for a new key. Choose a lower-cap model, '
        + 'or upgrade to version 2 to fund a larger one.'
    );
    assert.equal(
        versionCopy('send.largerKey', { N: 2 }),
        'This model requires a larger private balance for a new key. Choose a lower-cap model, '
        + 'or upgrade to version 2 to fund a larger one.'
    );
    // No target to upgrade to: the advice the chat runtime has always given.
    assert.equal(
        versionCopy('send.largerKey', { amount: '$0.50' }),
        'This model requires $0.50 in private balance for a new key. Choose a lower-cap model, '
        + 'or withdraw the remaining balance and fund a larger one.'
    );
});

test('the upgrade review is honest about publicity and about the test network', () => {
    const text = versionCopy('upgrade.review', { N: 2, F: 1 });
    assert.match(text, /two Ethereum transactions/);
    assert.match(text, /public on Ethereum/);
    assert.match(text, /can be linked by address, amount and time/);
    assert.match(text, /network fee/);
    assert.equal(/test network/.test(text), false);
    assert.match(versionCopy('upgrade.review', { N: 2, F: 1, sepolia: 1 }), /enter the test network password again/);
    assert.equal(/test network/.test(versionCopy('upgrade.review', { N: 2, F: 1, sepolia: 0 })), false);
    assert.equal(/test network/.test(versionCopy('upgrade.review', { N: 2, F: 1, sepolia: 'false' })), false);
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

test('N, F, P and R accept numbers, ids and whole labels', () => {
    for (const [n, f] of [[2, 1], ['2', '1'], ['Version 2', 'Version 1'], ['version 2', 'VERSION 1'], ['v2', 'V1']]) {
        assert.equal(versionCopy('help.previous', { N: n, F: f }), versionCopy('help.previous', { N: 2, F: 1 }));
        assert.equal(versionCopy('previous.open', { P: f }), 'Open version 1');
        assert.equal(versionCopy('reload.otherTab', { R: n }), versionCopy('reload.otherTab', { R: 2 }));
    }
    // A plain id string reads as its number, like the {id} form does.
    assert.equal(versionCopy('send.largerKey', { N: 'v2' }), versionCopy('send.largerKey', { N: 2 }));
    assert.match(versionCopy('send.largerKey', { N: 'v2' }), /upgrade to version 2 to fund/);
    assert.equal(versionName('v2'), '2');
    assert.equal(versionName('V10'), '10');
    assert.equal(versionName('Version v3'), '3');
    assert.equal(versionName({ id: 'v3', label: 'v3' }), '3');
    // Only a bare "v<digits>" is an id; anything else is a name and stays as is.
    assert.equal(versionName('v2c'), 'v2c');
    assert.equal(versionName('v'), 'v');
    assert.equal(versionName('Version 2 (beta)'), '2 (beta)');
    assert.equal(versionName({ id: 'v3', label: 'Version 3' }), '3');
    assert.equal(versionName({ id: 'v3', label: '' }), '3');
    assert.equal(versionName({ id: 'v3' }), '3');
    assert.equal(versionName('Version 12'), '12');
    assert.equal(versionName({ id: 'mercury', label: 'Mercury' }), 'Mercury');
    assert.equal(versionName(null), '');
});

test('a missing date falls back to wording that does not need it', () => {
    assert.equal(
        versionCopy('banner.available', { N: 2, F: 1 }),
        'Version 2 is available. Your balance is on version 1 and keeps working. '
        + 'You can upgrade any time: withdraw your balance, then deposit again.'
    );
    assert.equal(
        versionCopy('banner.soon', { N: 2, F: 1 }),
        'Upgrade to version 2. Your balance is on version 1. It keeps working until then. '
        + 'Withdraw your balance, then deposit again.'
    );
    assert.equal(versionCopy('banner.tier7'), '7 days left to upgrade.');
    assert.equal(
        versionCopy('banner.overdue', { F: 1 }),
        'Upgrade now. Withdrawals can take a while to confirm. After it expires, the service treasury can claim '
        + 'your full original deposit, and nothing is refunded.'
    );
});

test('flags are on for any value but empty, 0 and false', () => {
    const withFlag = value => versionCopy('deposits.closed', { N: 2, F: 1, reload: value });
    for (const on of [1, '1', 'yes', true, 'true']) assert.match(withFlag(on), /Reload to deposit/, String(on));
    for (const off of [0, '0', '', 'false', 'FALSE', false, undefined, null]) {
        assert.equal(/Reload to deposit/.test(withFlag(off)), false, String(off));
    }
});

test('unknown keys and unusable tokens render quietly', () => {
    assert.equal(versionCopy('no.such.key', TOKENS), '');
    assert.equal(versionCopy(undefined), '');
    // A pill with no version to name has no text, not a bare "Version".
    assert.equal(versionCopy('pill', null), '');
    assert.equal(versionCopy('pill', 'F'), '');
    assert.equal(versionCopy('pill', { F: { toString() { return 'x'; } } }), '');
    assert.equal(versionCopy('pill', { F: Number.NaN }), '');
    assert.equal(versionCopy('pill', { F: 3 }), 'Version 3');
    // Names that would reach the prototype are plain missing tokens.
    assert.equal(versionCopy('pill', { __proto__: { F: 9 } }), '');
    assert.equal(versionCopy('pill', JSON.parse('{"__proto__": {"F": 9}, "F": 4}')), 'Version 4');
    assert.equal(versionCopy('constructor'), '');
    assert.equal(versionCopy('__proto__'), '');
    assert.equal(versionCopy('toString'), '');
});

// ---------------------------------------------------------------------------
// Words we do not use, and the tone
// ---------------------------------------------------------------------------

function renderedEverywhere() {
    const variants = [
        {}, TOKENS, ALL_TOKENS, { ...ALL_TOKENS, blocked: 1, reload: 0, sepolia: 0 },
        { F: 1 }, { N: 2 }, { P: 1 }, { R: 2 }, { F: 'Version 3', N: 'Version 4', expiry: 'x' },
        EXIT_TOKENS, { ...ALL_TOKENS, ...EXIT_TOKENS, retired: 1 }, { V: 'v2', reference: 12, retryIn: 1, count: 1 },
        { until: 'x', bound: 'x', limit: 'x' }, { eth: 'x', destination: 'x', amount: 'x' }
    ];
    const out = [];
    for (const key of COPY_KEYS) {
        for (const tokens of variants) out.push({ key, text: versionCopy(key, tokens) });
    }
    return out;
}

test('forbidden vocabulary never reaches the user', () => {
    const forbidden = /nullifier|vault|circuit|deployment|manifest|\bnotes?\b|note\s*#|#\s*\d|unlinkable|untraceable|anonymous|zero.knowledge|proof\b|escape hatch|mutual close/i;
    for (const { key, text } of renderedEverywhere()) {
        assert.equal(forbidden.test(text), false, `${key}: ${text}`);
    }
});

test('the upgrade never claims to be private or unlinkable', () => {
    for (const key of ['upgrade.review', 'upgrade.withdrawn', 'upgrade.deposit', 'upgrade.done', 'banner.available',
        'banner.soon', 'banner.overdue', 'help.previous']) {
        assert.equal(/unlink|untrace|hidden|private upgrade|anonymous/i.test(versionCopy(key, ALL_TOKENS)), false, key);
    }
});

test('sentence case, calm punctuation, no emoji, curly apostrophes', () => {
    for (const { key, text } of renderedEverywhere()) {
        if (!text) continue;
        assert.equal(/\p{Extended_Pictographic}/u.test(text), false, `${key}: emoji`);
        assert.equal(/!/.test(text), false, `${key}: exclamation`);
        assert.equal(/'/.test(text), false, `${key}: straight apostrophe`);
        assert.equal(/\s{2,}/.test(text), false, `${key}: double space`);
        assert.equal(/\s[.,;:]/.test(text), false, `${key}: space before punctuation`);
        assert.equal(text, text.trim(), `${key}: untrimmed`);
        // Every sentence starts with a capital letter, a digit or the product name.
        const sentences = text.split(/(?<=[.?])\s+/);
        for (const sentence of sentences) {
            assert.match(sentence, /^(?:[A-Z0-9]|zkAPI)/, `${key}: "${sentence}"`);
        }
        // No shouting (ETH aside, which no copy uses).
        assert.equal(/\b[A-Z]{3,}\b/.test(text), false, `${key}: all caps`);
    }
});

test('no template carries markup of its own', () => {
    for (const { key, text } of renderedEverywhere()) {
        assert.equal(/[<>&"]/.test(text) && key !== 'service.paused', false, `${key}: ${text}`);
    }
});

test('errors and retirement never say nothing is lost unless it is true', () => {
    assert.equal(/nothing is lost/i.test(versionCopy('deposits.blocked.retired', { F: 1 })), false);
    assert.equal(/nothing is lost/i.test(versionCopy('deposits.blocked.foreign')), false);
    assert.equal(/nothing is lost/i.test(versionCopy('legacy.unreachable', { F: 1, N: 2 })), false);
    assert.match(versionCopy('reload.otherTab', { R: 2 }), /Nothing is lost; your balance is saved in this browser\./);
});

// Every key, with every combination of the version tokens, the flags, the
// dates and the amount. Distinct numbers per token, so an assertion can tell
// "version 3" (P) from "version 1" (F).
function everyCombination(visit) {
    const versionTokens = [['N', 2], ['F', 1], ['P', 3], ['R', 4]];
    const flags = ['reload', 'waiting', 'blocked', 'sepolia'];
    const extras = [['closeBy', 'Nov 18, 2026, 3:00 PM'], ['expiry', 'Nov 21, 2026, 12:00 AM'], ['amount', '$0.50']];
    const pick = (list, mask) => list.filter((entry, index) => mask & (1 << index));
    for (const key of COPY_KEYS) {
        for (let versionMask = 0; versionMask < 16; versionMask += 1) {
            for (let flagMask = 0; flagMask < 16; flagMask += 1) {
                for (let extraMask = 0; extraMask < 8; extraMask += 1) {
                    const tokens = {};
                    for (const [name, value] of pick(versionTokens, versionMask)) tokens[name] = value;
                    for (const name of pick(flags, flagMask)) tokens[name] = 1;
                    for (const [name, value] of pick(extras, extraMask)) tokens[name] = value;
                    visit(key, tokens, versionCopy(key, tokens));
                }
            }
        }
    }
    // The exit tokens, each present or absent, on the protocol keys that read
    // them, with and without the version names. The older keys ignore these
    // tokens (checked once, with every one present).
    const exitTokens = Object.entries(EXIT_TOKENS);
    const withVersions = [{}, { F: 1, N: 2 }];
    for (const key of COPY_KEYS) {
        const all = (1 << exitTokens.length) - 1;
        const masks = PROTOCOL_KEYS.includes(key) ? [...Array(all + 1).keys()] : [all];
        for (const mask of masks) {
            for (const base of withVersions) {
                const tokens = { ...base };
                exitTokens.forEach(([name, value], index) => {
                    if (mask & (1 << index)) tokens[name] = value;
                });
                visit(key, tokens, versionCopy(key, tokens));
            }
        }
    }
}

test('no combination of missing tokens leaves a dangling "version" or a stray brace', () => {
    // A singular "version" is followed by one of the numbers above or is
    // introduced by a plain-words stand-in ("another version").
    const standIn = /(?:another|earlier|newer|latest|this|that|current|a|the)\s+version$/i;
    // A clause never ends on a bare preposition, which is what a missing
    // version name used to leave behind ("deposit into.").
    const hanging = /\b(?:to|into|from|on|in|by|until|before|of)\s*(?:[.,;:?]|$)/i;
    let rendered = 0;
    everyCombination((key, tokens, text) => {
        rendered += 1;
        const where = `${key} ${JSON.stringify(tokens)}: "${text}"`;
        assert.equal(/[{}]/.test(text), false, where);
        assert.equal(/\s{2,}|\s[.,;:?]/.test(text), false, where);
        assert.equal(hanging.test(text), false, where);
        const word = /\bversion\b/gi;
        let match;
        while ((match = word.exec(text)) !== null) {
            const before = text.slice(0, match.index + match[0].length);
            const after = text.slice(match.index + match[0].length);
            assert.ok(/^\s+[1-5]\b/.test(after) || standIn.test(before), `dangling version in ${where}`);
        }
    });
    const exitMasks = 1 << Object.keys(EXIT_TOKENS).length;
    assert.ok(rendered > COPY_KEYS.length * 16 * 16 * 8 - 1 + PROTOCOL_KEYS.length * 2 * exitMasks);
});

test('the version-naming texts never print a number they were not given', () => {
    // Each token reaches only the keys that document it: F is never read by the
    // other-version texts, R only by the reload text.
    const reads = {
        N: ['help.previous', 'banner.available', 'banner.soon', 'deposits.closed', 'send.closed', 'send.largerKey',
            'upgrade.review', 'upgrade.destination.newAddress', 'upgrade.withdrawn', 'upgrade.deposit',
            'upgrade.done', 'admission.closed', 'legacy.unreachable', 'abandon.zero', 'abandon.dust',
            'held.unreachable'],
        F: ['pill', 'help.current', 'help.previous', 'banner.available', 'banner.soon', 'deposits.closed',
            'send.closed', 'upgrade.review', 'unsent.explain', 'admission.closed', 'legacy.unreachable',
            'abandon.zero', 'abandon.dust', 'held.unreachable'],
        P: ['deposits.blocked.previous', 'previous.open', 'previous.credit'],
        R: ['reload.otherTab'],
        // The reference number of an operator notice, and nothing else, names
        // a version that is neither this page's nor the one with unfinished
        // business.
        V: ['operator.reference']
    };
    const numberOf = { N: '2', F: '1', P: '3', R: '4', V: '5' };
    for (const key of COPY_KEYS) {
        for (const [token, number] of Object.entries(numberOf)) {
            // `reference` is the one other token a key needs before it says
            // anything at all (operator.reference is empty without it).
            const text = versionCopy(key, { [token]: number, blocked: 1, reload: 1, waiting: 1, reference: 7 });
            const printed = new RegExp(`\\bversion ${number}\\b`, 'i').test(text);
            assert.equal(printed, reads[token].includes(key), `${key} with only ${token}`);
        }
    }
});

// ---------------------------------------------------------------------------
// Operator text
// ---------------------------------------------------------------------------

test('operator text is escaped, bounded and never markup', () => {
    const hostile = '<img src=x onerror="alert(1)"> <a href="https://evil.example">click</a> & \'quote\' `tick`';
    const html = versionCopy('service.paused', { message: hostile });
    assert.equal(/[<>"']/.test(html), false);
    assert.equal(/`/.test(html), false);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /&amp;/);
    assert.match(html, /&#39;quote&#39;/);
    // As text content it is the same words, unescaped.
    assert.equal(versionCopyText('service.paused', { message: hostile }), hostile);
    assert.equal(safeOperatorText(hostile), html);
    assert.equal(boundedOperatorText(hostile), hostile);
});

test('operator text is cut to 280 characters, including the cut mark', () => {
    assert.equal(OPERATOR_TEXT_LIMIT, 280);
    const exact = 'a'.repeat(280);
    assert.equal(versionCopyText('service.paused', { message: exact }), exact);
    const long = 'b'.repeat(500);
    const cut = versionCopyText('service.paused', { message: long });
    assert.equal(cut.length, 280);
    assert.ok(cut.endsWith('\u2026'));
    assert.equal(cut, `${'b'.repeat(279)}\u2026`);
    // Never in the middle of a surrogate pair.
    const emoji = '\u{1F600}'; // two UTF-16 units
    const text = `${'c'.repeat(278)}${emoji}${emoji}`;
    const bounded = boundedOperatorText(text);
    assert.ok(bounded.length <= 280);
    assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])/.test(bounded), false);
    assert.equal(/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(bounded), false);
    // Escaping happens after the cut, so entities are never split.
    const amps = versionCopy('service.paused', { message: '&'.repeat(400) });
    assert.equal(amps, `${'&amp;'.repeat(279)}\u2026`);
});

test('operator text loses control characters and layout', () => {
    const text = 'Line one\nLine two\r\n\u0000\u0007\u2028tab\there\u200b  end';
    assert.equal(boundedOperatorText(text), 'Line one Line two tab here\u200b end');
    assert.equal(versionCopyText('service.paused', { message: '   \n\t ' }), 'Private access is paused right now. You can still withdraw your balance.');
    assert.equal(boundedOperatorText(null), '');
    assert.equal(boundedOperatorText({ toString() { return 'x'; } }), '');
});

test('a token value that looks like template syntax is inserted verbatim', () => {
    const value = '{?F}{F}{/F}{message}{!N}x{/N}';
    assert.equal(versionCopyText('service.paused', { message: value }), value);
    assert.equal(
        versionCopyText('banner.tier7', { closeBy: '{?F}by{/F}' }),
        '7 days left to upgrade. Withdraw by {?F}by{/F}.'
    );
});

test('every string token is escaped in the HTML-safe form', () => {
    const html = versionCopy('banner.tier7', { closeBy: '<b>Nov 18</b>' });
    assert.equal(html, '7 days left to upgrade. Withdraw by &lt;b&gt;Nov 18&lt;/b&gt;.');
    assert.equal(versionCopy('pill', { F: '<script>' }), 'Version &lt;script&gt;');
    assert.equal(escapeHtml(`<>&"'\``), '&lt;&gt;&amp;&quot;&#39;&#96;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(5), '5');
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test('dates show local date and time through the supplied formatter', () => {
    const instant = Date.UTC(2026, 10, 18, 15, 0);
    const fn = date => date.toISOString().replace('T', ' ').slice(0, 16);
    assert.equal(formatLocalDateTime(instant, fn), '2026-11-18 15:00');
    const intl = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
    assert.equal(formatLocalDateTime(instant, intl), 'Nov 18, 2026, 7:00 AM');
    // The default is the runtime's locale and zone, with date and time.
    assert.match(formatLocalDateTime(instant), /2026/);
    assert.match(formatLocalDateTime(instant), /\d:\d\d/);
});

test('an unusable instant or a failing formatter gives no date, which the copy tolerates', () => {
    for (const value of [null, undefined, NaN, Infinity, 0, -1, '1700000000000', {}, 8.64e15 + 1]) {
        assert.equal(formatLocalDateTime(value, () => 'x'), '', String(value));
    }
    assert.equal(formatLocalDateTime(1_700_000_000_000, () => { throw new Error('locale'); }), '');
    assert.equal(formatLocalDateTime(1_700_000_000_000, () => 42), '');
    assert.equal(formatLocalDateTime(1_700_000_000_000, { format() { throw new Error('x'); } }), '');
});

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

test('copyTokens builds the tokens a VersionState supplies', () => {
    const state = {
        current: { id: 'v1', label: 'Version 1', status: 'exit-only' },
        target: { id: 'v2', label: 'Version 2' },
        closeByTs: Date.UTC(2026, 10, 18, 15, 0),
        expiryTs: Date.UTC(2026, 10, 21, 0, 0),
        service: { message: 'Paused.', code: null },
        previous: { versionId: 'v3', openWithdrawals: 1, credits: 0, canOpen: true, closeByTs: null }
    };
    const formatter = date => date.toISOString().slice(0, 16);
    // F stays the loaded version; the other version is P, for every key at once.
    // The SDK's own service message is not a token: the words come from the code.
    assert.deepEqual(copyTokens(state, { formatter }), {
        N: '2', F: '1', P: '3', closeBy: '2026-11-18T15:00', expiry: '2026-11-21T00:00'
    });
    // The retired `previous` option is ignored, not honored: F is never rewritten.
    assert.deepEqual(copyTokens(state, { formatter, previous: true }), copyTokens(state, { formatter }));
    // The flags the state already knows.
    const flagged = copyTokens({
        ...state,
        reload: { required: true, canReload: true, reason: 'moved_in_other_tab', targetId: 'v2' },
        upgrade: { available: true, canStart: false, blockedBy: 'open_withdrawal', stage: 'blocked' },
        previous: { versionId: 'v3', openWithdrawals: 1, credits: 0, canOpen: false, closeByTs: null }
    }, { formatter });
    assert.equal(flagged.reload, 1);
    assert.equal(flagged.waiting, 1);
    assert.equal(flagged.blocked, 1);
    assert.equal(flagged.R, '2');
    // A reload to some other version is not "reload to deposit": the flag is
    // off and R names that version.
    const unflagged = copyTokens({
        ...state,
        reload: { required: true, canReload: true, reason: 'moved_in_other_tab', targetId: 'v9' },
        upgrade: { available: true, canStart: true, blockedBy: null, stage: 'idle' },
        previous: { versionId: 'v3', openWithdrawals: 1, credits: 0, canOpen: true, closeByTs: null }
    }, { formatter });
    assert.equal('reload' in unflagged, false);
    assert.equal('waiting' in unflagged, false);
    assert.equal('blocked' in unflagged, false);
    assert.equal(unflagged.R, '9');
    // No reload required: no R, whatever targetId says.
    assert.equal('R' in copyTokens({ ...state, reload: { required: false, targetId: 'v2' } }), false);
    assert.deepEqual(
        copyTokens({ ...state, closeByTs: null, expiryTs: null, service: null, target: null, previous: null }, { formatter }),
        { F: '1' }
    );
    assert.deepEqual(copyTokens(null), {});
    assert.deepEqual(copyTokens(undefined, { formatter }), {});
    // A set-aside-only holder: "previous" is this very version, which is not
    // another version, so P is left out.
    assert.equal('P' in copyTokens({
        ...state, previous: { versionId: 'v1', openWithdrawals: 1, credits: 0, canOpen: false, closeByTs: null }
    }), false);
});

test('copyTokens words a service pause by its code and never by the SDK message', () => {
    const paused = (code, message = 'Withdrawals work, but https://operator.example/config.json (404)') => ({
        current: { id: 'v2', label: 'Version 2', status: 'active' }, target: { id: 'v2', label: 'Version 2' },
        service: { message, code }
    });
    const expected = {
        deployment_manifest_unavailable: 'service.paused.unreachable',
        deployment_manifest_mismatch: 'service.paused.changed',
        deployment_manifest_untrusted: 'service.paused.untrusted',
        incompatible_proof_circuit: 'service.paused.incompatible',
        native_vault_unverified: 'service.paused.contract'
    };
    for (const [code, key] of Object.entries(expected)) {
        const tokens = copyTokens(paused(code));
        assert.equal(tokens.message, versionCopyText(key), code);
        // The notice's text is the host's sentence, whole.
        assert.equal(versionCopyText('service.paused', tokens), versionCopyText(key), code);
        assert.doesNotMatch(versionCopyText('service.paused', tokens), /operator\.example|404|manifest/i, code);
    }
    // An unknown code, or none, is the generic sentence. The operator's text is not shown.
    for (const code of ['something_new', null, undefined]) {
        const tokens = copyTokens(paused(code));
        assert.equal('message' in tokens, false, String(code));
        assert.equal(
            versionCopyText('service.paused', tokens),
            'Private access is paused right now. You can still withdraw your balance.'
        );
    }
    assert.equal('message' in copyTokens({ ...paused(null), service: null }), false);
});

test('copyTokens formats the exit facts: dates through the formatter, the bound through formatAmount', () => {
    const formatter = date => date.toISOString().slice(0, 16);
    const at = Date.UTC(2026, 10, 20, 9, 0);
    const state = {
        current: { id: 'v2', label: 'Version 2', status: 'active' },
        target: { id: 'v2', label: 'Version 2' },
        exit: {
            nearExpiry: true, mustInitiateByMs: Date.UTC(2026, 10, 18, 15, 0), boundAtState: '250000',
            stateFresh: false, escapeAtMs: Date.UTC(2026, 10, 19, 1, 0),
            frozen: { untilMs: at, mode: 'escape' }, deviceNotNewest: false,
            wait: {
                kind: 'settlement', untilMs: Date.UTC(2026, 10, 19, 1, 0), escapeAtMs: Date.UTC(2026, 10, 19, 1, 0),
                mustInitiateByMs: null, boundAtState: '1000000'
            },
            kit: { exported: true, outOfDate: false, depositPathSaved: true, unsaved: false },
            rpc: { recommended: false, wrongChain: false }
        },
        setAside: { near: 1, earliestMustInitiateByMs: Date.UTC(2026, 10, 22, 6, 0), device: 0 }
    };
    const calls = [];
    const formatAmount = units => { calls.push(units); return `<${units}>`; };
    const tokens = copyTokens(state, { formatter, formatAmount });
    assert.deepEqual(tokens, {
        N: '2', F: '2', until: '2026-11-20T09:00', escapeAt: '2026-11-19T01:00', exitBy: '2026-11-18T15:00',
        // The wait's own bound is the one that was refused, not the standing one.
        bound: '<1000000>', setAsideBy: '2026-11-22T06:00'
    });
    assert.deepEqual(calls, ['1000000']);
    // Without a wait the standing bound of the state is the one shown.
    const standing = copyTokens({ ...state, exit: { ...state.exit, wait: null } }, { formatter, formatAmount });
    assert.equal(standing.bound, '<250000>');
    assert.equal('escapeAt' in standing, false);
    // Nothing to disclose, or nothing to disclose it with: no bound token.
    assert.equal('bound' in copyTokens({ ...state, exit: { ...state.exit, wait: null, boundAtState: '0' } },
        { formatter, formatAmount }), false);
    assert.equal('bound' in copyTokens(state, { formatter }), false);
    assert.equal('bound' in copyTokens(state, { formatter, formatAmount: () => '' }), false);
    assert.equal('bound' in copyTokens(state, { formatter, formatAmount: () => { throw new Error('x'); } }), false);
    assert.equal('bound' in copyTokens(state, { formatter, formatAmount: () => 42 }), false);
    // A bound that is not an amount is never handed to the formatter.
    calls.length = 0;
    copyTokens({ ...state, exit: { ...state.exit, wait: { ...state.exit.wait, boundAtState: '1e9' }, boundAtState: null } },
        { formatter, formatAmount });
    assert.deepEqual(calls, []);
    // No exit facts, no set-aside facts: none of these tokens.
    assert.deepEqual(copyTokens({ ...state, exit: null, setAside: null }, { formatter, formatAmount }), { N: '2', F: '2' });
});

test('copyTokens gives the retry delay of an ownership-proof wait from the clock it is given', () => {
    const now = Date.UTC(2026, 10, 15, 12, 0, 0);
    const state = untilMs => ({
        current: { id: 'v2', label: 'Version 2' },
        exit: {
            wait: { kind: 'proof', untilMs, escapeAtMs: null, mustInitiateByMs: null, boundAtState: null },
            mustInitiateByMs: null, boundAtState: null, frozen: null
        }
    });
    assert.equal(copyTokens(state(now + 4_000), { now }).retryIn, 4);
    assert.equal(copyTokens(state(now + 3_001), { now }).retryIn, 4, 'rounded up: never promise sooner than it is');
    assert.equal(copyTokens(state(now + 1), { now }).retryIn, 1);
    // Over, or no clock: no number (the text says "a few seconds").
    assert.equal('retryIn' in copyTokens(state(now), { now }), false);
    assert.equal('retryIn' in copyTokens(state(now - 1_000), { now }), false);
    assert.equal('retryIn' in copyTokens(state(now + 4_000)), false);
    assert.equal('retryIn' in copyTokens(state(null), { now }), false);
    // Only a proof wait has a delay.
    const settlement = state(now + 4_000);
    settlement.exit.wait.kind = 'settlement';
    assert.equal('retryIn' in copyTokens(settlement, { now }), false);
    assert.equal(
        versionCopyText('exit.proofWait', copyTokens(state(now + 1_000), { now })),
        'Your earlier withdrawal request is about to expire. Try again in 1 second.'
    );
});

test('a note number is a reference whatever its value, and a caller cannot fake the flag', () => {
    // Note numbers start at 0; a flag reading would hide the first note's.
    assert.equal(versionCopyText('operator.reference', { reference: 0 }), 'Reference number 0.');
    assert.equal(versionCopy('operator.reference', { reference: false }), '', 'a flag value is not a number');
    assert.equal(versionCopyText('operator.reference', { reference: null }), '');
    // The presence flag is derived: handing it in changes nothing.
    assert.equal(versionCopyText('operator.reference', { hasReference: 1 }), '');
    assert.equal(versionCopyText('operator.reference', { reference: 4, hasReference: 0 }), 'Reference number 4.');
    // Other flag semantics are unchanged: "0" and "false" are still off.
    assert.equal(versionCopyText('exit.proofWait', { retryIn: 0 }),
        'Your earlier withdrawal request is about to expire. Try again in a few seconds.');
    assert.equal(versionCopyText('payout.notice', { count: 0 }), 'Payouts are held for you. Open Payment history to claim them.');
});

test('with a clock, an instant that has passed is never printed as a deadline', () => {
    const formatter = date => date.toISOString().slice(0, 16).replace('T', ' ');
    const now = Date.UTC(2026, 10, 15, 12, 0, 0);
    const HOUR = 3_600_000;
    const state = ({ exitBy, setAsideBy, until, escapeAt }) => ({
        current: { id: 'v2', label: 'Version 2' },
        exit: {
            nearExpiry: true, mustInitiateByMs: exitBy, boundAtState: null, frozen: { untilMs: until, mode: 'escape' },
            wait: { kind: 'settlement', untilMs: escapeAt, escapeAtMs: escapeAt, mustInitiateByMs: null, boundAtState: null }
        },
        setAside: { near: 1, earliestMustInitiateByMs: setAsideBy, device: 0 }
    });
    const behind = state({ exitBy: now - HOUR, setAsideBy: now - 2 * HOUR, until: now - 1, escapeAt: now });
    const printed = copyTokens(behind, { formatter, now });
    for (const name of ['exitBy', 'setAsideBy', 'until', 'escapeAt']) assert.equal(name in printed, false, name);
    // The sentences are whole without them.
    assert.equal(versionCopyText('near.balance', printed),
        'New chats are paused because this balance is about to expire. Withdraw it to get the unused amount back. '
        + 'If it expires, the service treasury can claim it.');
    assert.equal(versionCopyText('setAside.near', printed),
        'A balance you set aside is close to its deadline. Finish withdrawing it from Payment history. A balance '
        + 'that is not withdrawn before it expires can be claimed by the service treasury.');
    // Still ahead: printed, one millisecond ahead included.
    const ahead = copyTokens(state({ exitBy: now + 1, setAsideBy: now + HOUR, until: now + 2 * HOUR, escapeAt: now + 3 * HOUR }),
        { formatter, now });
    assert.deepEqual(
        { exitBy: ahead.exitBy, setAsideBy: ahead.setAsideBy, until: ahead.until, escapeAt: ahead.escapeAt },
        { exitBy: '2026-11-15 12:00', setAsideBy: '2026-11-15 13:00', until: '2026-11-15 14:00', escapeAt: '2026-11-15 15:00' }
    );
    // Without a clock nothing can be said to have passed: as before.
    const noClock = copyTokens(behind, { formatter });
    assert.equal(noClock.exitBy, '2026-11-15 11:00');
    assert.equal(noClock.setAsideBy, '2026-11-15 10:00');
    // A clock that is not a number is no clock.
    for (const bad of [NaN, Infinity, '1794744000000', null]) {
        assert.equal(copyTokens(behind, { formatter, now: bad }).exitBy, '2026-11-15 11:00', String(bad));
    }
});

test('the bound a disclosure shows is never less than the standing one', () => {
    const formatAmount = units => `<${units}>`;
    const state = (waitBound, standing) => ({
        current: { id: 'v2', label: 'Version 2' },
        exit: {
            boundAtState: standing, frozen: null, mustInitiateByMs: null,
            wait: waitBound === undefined ? null
                : { kind: 'settlement', untilMs: null, escapeAtMs: null, mustInitiateByMs: null, boundAtState: waitBound }
        }
    });
    // A refusal older than the chat that is unresolved now carries a smaller bound.
    assert.equal(copyTokens(state('1000', '1000000'), { formatAmount }).bound, '<1000000>');
    // The refusal's bound is the larger one: it is shown.
    assert.equal(copyTokens(state('1000000', '1000'), { formatAmount }).bound, '<1000000>');
    // Equal, or only one of them: that one.
    assert.equal(copyTokens(state('7', '7'), { formatAmount }).bound, '<7>');
    assert.equal(copyTokens(state(undefined, '250000'), { formatAmount }).bound, '<250000>');
    assert.equal(copyTokens(state(null, '250000'), { formatAmount }).bound, '<250000>');
    assert.equal(copyTokens(state('250000', null), { formatAmount }).bound, '<250000>');
    // Compared as numbers, not as text, and past the safe-integer range.
    assert.equal(copyTokens(state('9', '10'), { formatAmount }).bound, '<10>');
    assert.equal(
        copyTokens(state('900000000000000000000', '1000000000000000000000'), { formatAmount }).bound,
        '<1000000000000000000000>'
    );
    // A figure that is not an amount never wins, nor reaches the formatter.
    const calls = [];
    const spy = units => { calls.push(units); return units; };
    assert.equal(copyTokens(state('1e99', '5'), { formatAmount: spy }).bound, '5');
    assert.equal(copyTokens(state('-1', '5'), { formatAmount: spy }).bound, '5');
    assert.deepEqual(calls, ['5', '5']);
    // Both nothing: no bound.
    assert.equal('bound' in copyTokens(state('0', '0'), { formatAmount }), false);
});

test('copyTokens names P and R by registry label when given the table', () => {
    const state = {
        current: { id: 'v3', label: 'Version 3', status: 'active' },
        target: { id: 'v3', label: 'Version 3' },
        previous: { versionId: 'v2c', openWithdrawals: 1, credits: 0, canOpen: true, closeByTs: null },
        reload: { required: true, canReload: true, reason: 'moved_in_other_tab', targetId: 'v1x' }
    };
    const table = [{ id: 'v1x', label: 'Version 1' }, { id: 'v2c', label: 'Version 2' }, { id: 'v3', label: 'Version 3' }];
    assert.deepEqual(
        { P: copyTokens(state, { table }).P, R: copyTokens(state, { table }).R },
        { P: '2', R: '1' }
    );
    // Without it the id is the name (the registry's "v1" and "v2" read as numbers).
    assert.deepEqual({ P: copyTokens(state).P, R: copyTokens(state).R }, { P: 'v2c', R: 'v1x' });
    // A table without the row, or a hostile one, is the same as no table.
    assert.equal(copyTokens(state, { table: [] }).P, 'v2c');
    assert.equal(copyTokens(state, { table: 'nope' }).P, 'v2c');
    assert.equal(copyTokens(state, { table: [null, 7, { id: 'v2c', label: 9 }] }).P, 'v2c');
});

test('the helpers tolerate options that are not objects', () => {
    const state = { current: { id: 'v1', label: 'Version 1' }, target: { id: 'v2', label: 'Version 2' } };
    for (const options of [null, undefined, 0, 'x', [], true]) {
        assert.doesNotThrow(() => copyTokens(state, options), String(options));
        assert.deepEqual(copyTokens(state, options), { N: '2', F: '1' });
        assert.doesNotThrow(() => gateCopyKey({ canStart: false, code: 'foreign_runtime' }, options), String(options));
        assert.equal(gateCopyKey({ canStart: false, code: 'foreign_runtime' }, options), 'deposits.blocked.foreign');
    }
    assert.equal(gateCopyKey({ canStart: false, code: 'foreign_runtime' }, { retired: true }), 'deposits.blocked.retired');
    // Only a real `true` selects the retirement wording.
    assert.equal(gateCopyKey({ canStart: false, code: 'foreign_runtime' }, { retired: 'yes' }), 'deposits.blocked.foreign');
});

// ---------------------------------------------------------------------------
// Through the state: the default call must name the right version
// ---------------------------------------------------------------------------

const TABLE = resolvedTable(activatedRegistry(), 'mainnet');
const [V1, V2] = TABLE;
const OPEN_ESCAPE = { recordId: 'r1', noteId: 7, mode: 'escape', phase: 'pending', expiryTs: null };
const holding = (version, extra = {}) => ({
    deploymentId: version.deploymentId, runtime: false, withdrawals: [], credits: [], ...extra
});

function stateFrom({ table = TABLE, active, holdings, preview = null, snapshot = normalizedSnapshot(), ...rest }) {
    const selection = rest.selection || chooseZkapiVersion({ table, holdings });
    return deriveVersionState({
        table,
        active,
        target: table.find(version => version.status === 'active') || null,
        selection,
        snapshot,
        intent: null,
        previewSelection: preview,
        now: NOW_MS,
        busy: false,
        admissionClosed: false,
        buildClosed: false,
        configBlock: false,
        unreachable: false,
        adapter: getAdapter(active.adapter),
        ...rest
    });
}

const textFor = (key, state, options) => versionCopyText(key, copyTokens(state, options));

test('a version-2 tab with a version-1 withdrawal open names version 1, never itself', () => {
    const state = stateFrom({ active: V2, holdings: [holding(V1, { withdrawals: [OPEN_ESCAPE] })] });
    assert.equal(state.current.id, 'v2');
    assert.equal(state.previous.versionId, 'v1');
    assert.equal(state.previous.canOpen, true);
    assert.equal(gateCopyKey(state.gate), 'deposits.blocked.previous');
    // The plain default call, as a view would make it.
    assert.equal(textFor('previous.open', state), 'Open version 1');
    assert.equal(
        textFor('deposits.blocked.previous', state),
        'A withdrawal from version 1 is still finishing. Open version 1 to finish it, then come back to deposit.'
    );
    // The button for a credit names the same version.
    assert.equal(textFor('previous.credit', state).includes('version 2'), false);
    assert.match(textFor('previous.credit', state), /Open version 1 to claim it\./);
    // And the loaded version is still version 2 for the keys that are about it.
    assert.equal(textFor('pill', state), 'Version 2');
    assert.match(textFor('help.current', state), /on version 2, the latest version\./);
});

test('while this page holds the balance, the previous version is named but cannot be opened', () => {
    const state = stateFrom({
        active: V2,
        holdings: [holding(V2, { runtime: true }), holding(V1, { withdrawals: [OPEN_ESCAPE] })],
        snapshot: normalizedSnapshot({ hasNote: true, expiryTs: Math.floor(NOW_MS / 1000) + 20 * 86_400 })
    });
    assert.equal(state.previous.versionId, 'v1');
    assert.equal(state.previous.canOpen, false);
    assert.equal(
        textFor('deposits.blocked.previous', state),
        'A withdrawal from version 1 is still finishing. To finish it, withdraw your current balance first, '
        + 'then open version 1.'
    );
});

test('a deployment with no registry row blocks deposits without naming any version', () => {
    const state = stateFrom({
        active: V2,
        holdings: [],
        snapshot: normalizedSnapshot({
            otherDeploymentWithdrawals: [{ deploymentId: 'zkapi-unknown', recordId: 'r', noteId: 1, mode: 'escape', phase: 'pending' }]
        })
    });
    assert.equal(state.gate.code, 'previous_withdrawal_open');
    assert.equal(state.previous, null);
    const text = textFor('deposits.blocked.previous', state);
    assert.equal(text, 'A withdrawal from another version is still finishing. Finish it first, then come back to deposit.');
    assert.equal(/version 2/.test(text), false);
    // The button has nothing to point at, and says so rather than pointing at the page itself.
    assert.equal(textFor('previous.open', state), 'Open another version');
});

test('a reload to another version than the deposit target names that version', () => {
    // The boot probe timed out, so version 2 loaded with deposits blocked. A
    // later probe finds a version-1 balance in the slot: the reload goes to 1.
    const boot = chooseZkapiVersion({ table: TABLE, holdings: null });
    const preview = chooseZkapiVersion({ table: TABLE, holdings: [holding(V1, { runtime: true })] });
    const state = stateFrom({ active: V2, selection: boot, preview });
    assert.equal(state.reload.required, true);
    assert.equal(state.reload.targetId, 'v1');
    assert.equal(state.target.id, 'v2');
    assert.equal(
        textFor('reload.otherTab', state),
        'This browser’s balance moved to version 1 in another tab. Reload to keep going. '
        + 'Nothing is lost; your balance is saved in this browser.'
    );
    // Reloading does not go to the deposit target, so it must not promise that.
    assert.equal(copyTokens(state).reload, undefined);
    assert.equal(textFor('deposits.closed', state, {}).includes('Reload to deposit'), false);
});

test('with three versions the reload text names the slot owner, not the newest version', () => {
    const table = resolvedTable(threeVersionRegistry(), 'mainnet');
    const [one, two, three] = table;
    assert.deepEqual(table.map(version => version.status), ['exit-only', 'exit-only', 'active']);
    const boot = chooseZkapiVersion({ table, holdings: null });
    const preview = chooseZkapiVersion({ table, holdings: [holding(two, { runtime: true })] });
    const state = stateFrom({ table, active: three, selection: boot, preview });
    assert.equal(state.target.id, 'v3');
    assert.equal(state.reload.targetId, 'v2');
    assert.match(textFor('reload.otherTab', state), /moved to version 2 in another tab/);
    assert.equal(/version 3/.test(textFor('reload.otherTab', state)), false);
    // A holder of version 1 with an open withdrawal on version 2: P is 2.
    const other = stateFrom({
        table, active: three, holdings: [holding(two, { withdrawals: [OPEN_ESCAPE] }), holding(one)]
    });
    assert.equal(other.previous.versionId, 'v2');
    assert.equal(textFor('previous.open', other), 'Open version 2');
});

test('the retirement text never names a version it cannot know', () => {
    // A retired deployment holds the slot, so the target loaded and deposits
    // are paused; a live version 1 also has a withdrawal open. Neither the
    // loaded version 2 nor the live version 1 is the retired one.
    const retired = chooseZkapiVersion({
        table: TABLE,
        holdings: [
            { deploymentId: 'zkapi-retired-long-ago', runtime: true, withdrawals: [], credits: [] },
            holding(V1, { withdrawals: [OPEN_ESCAPE] })
        ]
    });
    assert.equal(retired.depositBlock, 'foreign_runtime');
    const state = stateFrom({ active: V2, selection: retired });
    assert.equal(state.gate.code, 'foreign_runtime');
    assert.equal(copyTokens(state).P, '1');
    for (const key of [gateCopyKey(state.gate), gateCopyKey(state.gate, { retired: true })]) {
        const text = textFor(key, state);
        assert.ok(text.length > 0, key);
        assert.equal(/version \d/.test(text), false, `${key}: ${text}`);
    }
    assert.match(textFor('deposits.blocked.retired', state), /a balance from a version that has been retired/);
});

test('a loaded version that is its own "previous" is not offered as another version', () => {
    // A holder of only a set-aside note on the closed version: the action is
    // Withdraw or Restore here, and no "open another version" is implied.
    const state = stateFrom({
        active: V1,
        holdings: [holding(V1, { runtime: true })],
        snapshot: normalizedSnapshot({
            deadlines: [{ source: 'set-aside', expiryTs: Math.floor(NOW_MS / 1000) + 20 * 86_400 }],
            hasOpenWithdrawal: true
        })
    });
    assert.equal(state.previous?.versionId, 'v1');
    assert.equal('P' in copyTokens(state), false);
    assert.equal(textFor('previous.open', state), 'Open another version');
});

test('upgrade.done and the other upgrade texts name the target from the state', () => {
    const onTarget = stateFrom({ active: V2, holdings: [] });
    assert.equal(textFor('upgrade.done', onTarget), 'Upgrade complete. Your balance is on version 2.');
    assert.equal(textFor('upgrade.deposit', onTarget), 'Your balance is withdrawn. Deposit to finish upgrading to version 2.');
    const noTarget = copyTokens({ current: { id: 'v1', label: 'Version 1' }, target: null });
    assert.equal(versionCopyText('upgrade.done', noTarget), 'Upgrade complete.');
    assert.equal(versionCopyText('upgrade.deposit', noTarget), 'Your balance is withdrawn. Deposit to finish upgrading.');
    assert.equal(
        versionCopyText('upgrade.withdrawn', noTarget),
        'Withdrawal confirmed. Your balance is back in your wallet. Reload to deposit.'
    );
});

test('a banner key follows the phase and the reminder tier', () => {
    const key = (phase, reminderTier = null) => upgradeBannerKey({ phase, reminderTier });
    assert.equal(key('upgrade-available'), 'banner.available');
    assert.equal(key('upgrade-soon'), 'banner.soon');
    assert.equal(key('upgrade-soon', 7), 'banner.tier7');
    assert.equal(key('upgrade-soon', 5), 'banner.tier7');
    assert.equal(key('upgrade-soon', 3), 'banner.tier3');
    assert.equal(key('upgrade-soon', 2), 'banner.tier3');
    assert.equal(key('upgrade-soon', 1), 'banner.tier1');
    assert.equal(key('upgrade-soon', 10), 'banner.soon');
    assert.equal(key('upgrade-soon', 0), 'banner.overdue');
    assert.equal(key('upgrade-overdue', 0), 'banner.overdue');
    for (const phase of ['current', 'expired', 'withdrawing', 'reload-required', 'service-paused', undefined]) {
        assert.equal(key(phase), null, String(phase));
    }
    assert.equal(upgradeBannerKey(null), null);
});

test('a gate code maps to its explanation', () => {
    const gate = code => ({ canStart: code === null, canResume: false, code, successor: null });
    assert.equal(gateCopyKey(gate(null)), null);
    assert.equal(gateCopyKey(gate('deposits_closed')), 'deposits.closed');
    assert.equal(gateCopyKey(gate('previous_withdrawal_open')), 'deposits.blocked.previous');
    // The balance moved to another version in another tab: the reload notice's words.
    assert.equal(gateCopyKey(gate('reload_required')), 'reload.otherTab');
    assert.equal(gateCopyKey(gate('reload_required'), { retired: true }), 'reload.otherTab');
    assert.equal(gateCopyKey(gate('holdings_unreadable')), 'deposits.blocked.unreadable');
    assert.equal(gateCopyKey(gate('foreign_runtime')), 'deposits.blocked.foreign');
    assert.equal(gateCopyKey(gate('foreign_runtime'), { retired: true }), 'deposits.blocked.retired');
    assert.equal(gateCopyKey(gate('stale_build')), 'deposits.blocked.stale');
    assert.equal(gateCopyKey(gate('config_mismatch')), 'deposits.blocked.stale');
    assert.equal(gateCopyKey(gate('version_unavailable')), 'unavailable');
    assert.equal(gateCopyKey(gate('something_new')), 'unavailable');
    assert.equal(gateCopyKey(undefined), null);
    // Every key a gate can name has copy.
    for (const code of ['deposits_closed', 'previous_withdrawal_open', 'holdings_unreadable', 'foreign_runtime',
        'stale_build', 'config_mismatch', 'version_unavailable']) {
        assert.ok(versionCopy(gateCopyKey(gate(code)), TOKENS).length > 0, code);
    }
});

test('a reload is offered for exactly the gates whose remedy is to load again', () => {
    const gate = code => ({ canStart: false, canResume: false, code, successor: null });
    for (const code of ['holdings_unreadable', 'foreign_runtime', 'config_mismatch', 'stale_build', 'version_unavailable']) {
        assert.equal(gateOffersReload(code), true, code);
        // The words of these gates tell the person to reload.
        assert.match(versionCopy(gateCopyKey(gate(code)), ALL_TOKENS), /Reload/, code);
    }
    // deposits_closed asks for a reload only when a fresh load would pick
    // another version (the reload notice); another version's withdrawal is
    // finished by opening it; reload_required is that notice itself.
    for (const code of ['deposits_closed', 'previous_withdrawal_open', 'reload_required', 'something_new', '', null, undefined]) {
        assert.equal(gateOffersReload(code), false, String(code));
    }
});
