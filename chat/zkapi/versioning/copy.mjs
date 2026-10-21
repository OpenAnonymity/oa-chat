// User-facing words for protocol versions and the upgrade (docs/ZKAPI_VERSIONING.md,
// "Copy and evidence rules").
//
// One table, token substitution, no markup. The rules the table keeps:
//   - product language: "Private balance", "version N"; never nullifier,
//     vault, circuit, deployment or note numbers
//   - sentence case, no emoji, curly apostrophes
//   - an upgrade is two public Ethereum transactions and is never described as
//     unlinkable
//   - operator-controlled text (the service message, a notice) is bounded to
//     280 characters, stripped of control characters and escaped; it is never
//     markup, a link or an instruction
//
// Pure module: no DOM, storage or clock. Dates arrive as epoch milliseconds
// and go through a caller-supplied formatter, so tests are timezone-stable.
//
// Tokens
//   N        the deposit target's version number ("2")
//   F        the version this page is on ("1"); in `legacy.unreachable` the
//            version that could not be reached
//   P        the OTHER version that has unfinished business (previous.open,
//            previous.credit, deposits.blocked.previous). Those templates never
//            read F, so a caller can not name the loaded version by accident
//   R        the version a reload would load (reload.otherTab)
//   V        a version named by a text that is about neither this page's
//            version nor the other one with unfinished business
//            (operator.reference)
//   FP, NP   the protocol version people are shown for F and for N ("0.2"),
//            read by the pill's help only (help.current, help.previous), which
//            then names a version the way the pill does: "zkAPI v0.2". See
//            displayProtocolVersion. Without one the help says "version F"
//   sameName flag: F and N are different versions shown under the same name
//            (help.previous then calls this page's one "an earlier build"
//            instead of printing that name twice)
//   closeBy  local date and time of the close-by instant
//   expiry   local date and time the balance expires
//   message  words for the service pause (service.paused): copyTokens fills it
//            from the service code; a caller may pass its own text
//   amount   a dollar figure (send.largerKey, payout.credited, abandon.dust)
//   reload   flag: a fresh load picks N, so the page can say "Reload to ..."
//   waiting  flag: a withdrawal here is still finishing, so deposits wait
//   blocked  flag: the version with unfinished business cannot be opened
//            until this page's own balance is withdrawn
//   sepolia  flag: the test network, where the password is asked again
//   retired  flag: the version V has been retired (operator.reference)
//   (a flag is any value that is not empty, "0" or "false")
//
// The balance's exit facts (copyTokens fills these from `state.exit`):
//   until       local date and time a frozen balance can be used again
//   escapeAt    local date and time a normal withdrawal waits for a settling chat
//   bound       the most a settling chat can take, formatted by the caller's
//               formatAmount (left out when it is zero or cannot be formatted);
//               never less than the standing bound of the balance
//   exitBy      local date and time a withdrawal must be started by
//   setAsideBy  the same, for the earliest set-aside balance
//   retryIn     whole seconds until a refused withdrawal can be tried again
//               (needs `now`)
// With `now`, an instant that has already passed is left out of until,
// escapeAt, exitBy and setAsideBy: "start the withdrawal by" a time that is
// behind the reader is worse than no time. Without a clock they are printed.
// Tokens only a caller can know (copyTokens leaves them out):
//   limit        the most a balance may be worth to be given up, formatted
//   eth          the same balance in ether, the unit word included: a template
//                never spells a unit, so it can not be misread as a count
//   destination  the address a payout goes to, shortened by the caller
//   count        how many (payout.notice)
//   reference    a note number, shown only as a reference (operator.reference).
//                Note numbers start at 0, so 0 is a reference like any other
//
// A token left out renders as nothing, and every template reads as a whole
// sentence without it (that is what the {?name}...{/name} and {!name}...{/name}
// conditionals are for); a test renders every key with every combination of
// version tokens to keep it so. Use `copyTokens(state)` rather than building
// tokens by hand: it fills P and R from the state.
//
// Two counts choose a singular: `retryIn` and `count` read as "1" give the
// derived flags `retryOne` and `countOne`, so no caller can print "1 seconds".

/**
 * @typedef {'pill'|'help.title'|'help.current'|'help.previous'|'banner.available'|'banner.soon'
 *   |'banner.tier7'|'banner.tier3'|'banner.tier1'|'banner.overdue'|'deposits.closed'
 *   |'deposits.closed.started'|'deposits.blocked.previous'|'deposits.blocked.unreadable'
 *   |'deposits.blocked.foreign'|'deposits.blocked.retired'|'deposits.blocked.stale'|'send.closed'
 *   |'send.largerKey'|'reload.otherTab'|'reload.busy'|'upgrade.review'|'upgrade.review.fee'
 *   |'upgrade.destination.connected'|'upgrade.destination.newAddress'|'upgrade.destination.other'
 *   |'upgrade.withdrawn'|'upgrade.deposit'|'upgrade.done'|'draft.cleared'|'unsent.explain'
 *   |'unsent.cancel'|'previous.open'|'previous.credit'|'service.paused'|'admission.closed'
 *   |'near_expiry'|'legacy.unreachable'|'unavailable'|'discard.loop'
 *   |'service.paused.unreachable'|'service.paused.changed'|'service.paused.untrusted'
 *   |'service.paused.incompatible'|'service.paused.contract'|'service.check'|'service.stillPaused'
 *   |'near.balance'|'setAside.near'|'exit.settlement'|'exit.concede.zero'|'exit.concede.bound'
 *   |'exit.bound'|'exit.proofWait'|'exit.releasePending'|'exit.frozen'|'exit.device'
 *   |'exit.device.label'|'exit.rpc'|'payout.alert'|'payout.alert.badge'|'payout.credited'
 *   |'payout.notice'|'kit.never'|'kit.unsaved'|'kit.stale'|'operator.reference'|'abandon.zero'
 *   |'abandon.dust'|'abandon.dustNoPrice'|'abandon.chain'|'abandon.irreversible'|'abandon.link'
 *   |'abandon.linkZero'|'held.label'|'held.unreachable'|'held.summary'} CopyKey
 */

// Fallbacks. Every version token has a plain-words stand-in, so a missing
// number never leaves "version" dangling: {N} falls back to "a newer version",
// {F} to "an earlier version" or "this version", {P} to "another version" and
// {R} to a sentence that does not name one.
const TEMPLATES = Object.freeze({
    // Version pill and its help. The pill is amber only inside the prompt
    // window; that is styling, not words. With no version to name there is no
    // pill text at all. A version with a protocol version is pilled as
    // "zkAPI v{FP}" (VersionNotices.js); 'pill' is the fallback for a row
    // without one. The help names versions the same way: FP/NP when known,
    // else the registry name, and never one name for two different versions.
    'pill': '{?F}Version {F}{/F}',
    'help.title': 'About versions',
    'help.current': 'Your balance is on {?FP}zkAPI v{FP}, the latest version{/FP}'
        + '{!FP}{?F}version {F}, the latest version{/F}{!F}the latest version{/F}{/FP}.',
    'help.previous': 'Your balance is on {?sameName}an earlier build{/sameName}'
        + '{!sameName}{?FP}zkAPI v{FP}{/FP}{!FP}{?F}version {F}{/F}{!F}an earlier version{/F}{/FP}{/sameName}. '
        + 'It keeps working, but new deposits go to '
        + '{?NP}{?sameName}the latest build of zkAPI v{NP}{/sameName}{!sameName}zkAPI v{NP}, the latest version{/sameName}{/NP}'
        + '{!NP}{?N}version {N}, the latest version{/N}{!N}a newer version{/N}{/NP}. '
        + 'To move your balance, withdraw it and deposit again.',

    // Upgrade banner, by time left. The dates are the user's local date and time.
    'banner.available': '{?N}Version {N}{/N}{!N}A newer version{/N} is available. Your balance is on '
        + '{?F}version {F}{/F}{!F}an earlier version{/F} and keeps working'
        + '{?expiry} until {expiry}{/expiry}. You can upgrade any time'
        + '{?closeBy} before {closeBy}{/closeBy}: withdraw your balance, then deposit again.',
    'banner.soon': 'Upgrade to {?N}version {N}{/N}{!N}the newer version{/N}{?closeBy} by {closeBy}{/closeBy}. '
        + 'Your balance is on {?F}version {F}{/F}{!F}an earlier version{/F}. '
        + 'It keeps working until then. Withdraw your balance, then deposit again.',
    'banner.tier7': '7 days left to upgrade.{?closeBy} Withdraw by {closeBy}.{/closeBy}',
    'banner.tier3': '3 days left to upgrade.{?closeBy} Withdraw by {closeBy}.{/closeBy}',
    'banner.tier1': 'Less than a day left to upgrade. Withdraw now to get your unused balance back.',
    'banner.overdue': 'Upgrade now. Withdrawals can take a while to confirm. '
        + '{?expiry}After {expiry}, the service{/expiry}{!expiry}After it expires, the service{/expiry} '
        + 'treasury can claim your full original deposit, and nothing is refunded.',

    // A version that no longer takes deposits, and the other reasons a
    // deposit cannot start.
    'deposits.closed': '{?N}Deposits moved to version {N}. This page is on '
        + '{?F}version {F}{/F}{!F}an earlier version{/F}, which no longer accepts new deposits.{/N}'
        + '{!N}{?F}Version {F}{/F}{!F}This version{/F} no longer accepts new deposits.{/N}'
        + '{?waiting}{?N} Deposits to version {N} wait until your withdrawal finishes.{/N}{/waiting}'
        + '{?reload}{?N} Reload to deposit into version {N}.{/N}{/reload}',
    'deposits.closed.started': 'Your saved deposit can still be finished here.',
    // P is the version holding the unfinished withdrawal. Without it (a
    // deployment this build has no row for) no version is named and no
    // "open" button is promised.
    'deposits.blocked.previous': 'A withdrawal from {?P}version {P}{/P}{!P}another version{/P} is still finishing.'
        + '{?blocked} To finish it, withdraw your current balance first, then open '
        + '{?P}version {P}{/P}{!P}that version{/P}.{/blocked}'
        + '{!blocked}{?P} Open version {P} to finish it, then come back to deposit.{/P}'
        + '{!P} Finish it first, then come back to deposit.{/P}{/blocked}',
    'deposits.blocked.unreadable': 'We could not read your saved balance. Reload to try again. Nothing was changed.',
    'deposits.blocked.foreign': 'This browser holds a saved balance that this page can’t open. '
        + 'Deposits are paused so nothing is overwritten. Reload to try again. Your balance is saved in this browser.',
    // Names no version on purpose: a VersionState does not say which retired
    // version holds the slot, and F (this page) and P (a live version with
    // unfinished business) are both some other version than the one retired.
    'deposits.blocked.retired': 'This browser holds a balance from a version that has been retired and can’t be '
        + 'opened here. Deposits are paused. A withdrawal that was already started can still be finished '
        + 'directly on Ethereum.',
    'deposits.blocked.stale': 'Reload to update before depositing.',

    // Sending a chat. With no deposit target the key-size line falls back to
    // the chat runtime's own plain advice (largerKeyMessage in
    // services/zkapiChatRuntimeCore.mjs).
    'send.closed': '{?F}Version {F}{/F}{!F}This version{/F} no longer accepts deposits. '
        + 'Reload to continue{?N} in version {N}{/N}.',
    'send.largerKey': 'This model requires {?amount}{amount} in private balance{/amount}'
        + '{!amount}a larger private balance{/amount} for a new key. Choose a lower-cap model, or '
        + '{?N}upgrade to version {N} to fund a larger one{/N}'
        + '{!N}withdraw the remaining balance and fund a larger one{/N}.',

    // Reloading. R is where the reload goes, which is not always N.
    'reload.otherTab': '{?R}This browser’s balance moved to version {R} in another tab.{/R}'
        + '{!R}This browser’s balance changed in another tab.{/R} Reload to keep going. '
        + 'Nothing is lost; your balance is saved in this browser.',
    'reload.busy': 'Finish the current step first.',

    // The upgrade view.
    'upgrade.review': 'Upgrading takes two Ethereum transactions: a withdrawal from '
        + '{?F}version {F}{/F}{!F}your current version{/F}, then a new deposit into '
        + '{?N}version {N}{/N}{!N}the newer version{/N}. Both are public on Ethereum, and the two can be '
        + 'linked by address, amount and time. Each has its own network fee.'
        + '{?sepolia} After the page reloads you enter the test network password again.{/sepolia}',
    'upgrade.review.fee': 'Withdrawing is an Ethereum transaction and its network fee can be large. If your '
        + 'balance is small, the fee may cost more than you would get back; your wallet shows the fee before '
        + 'you confirm. You can also keep using your balance until it expires.',
    'upgrade.destination.connected': 'My connected wallet account',
    'upgrade.destination.newAddress': 'A new funding address{?N} for version {N}{/N} in this browser. Only this '
        + 'browser holds its key, so keep this browser’s data safe.',
    'upgrade.destination.other': 'A different address that I enter',
    'upgrade.withdrawn': 'Withdrawal confirmed. Your balance is back in your wallet. '
        + 'Reload to deposit{?N} into version {N}{/N}.',
    'upgrade.deposit': 'Your balance is withdrawn. Deposit to finish upgrading{?N} to version {N}{/N}.',
    'upgrade.done': 'Upgrade complete.{?N} Your balance is on version {N}.{/N}',

    // Unfinished and previous business.
    'draft.cleared': 'Cleared an unused deposit quote. Nothing was spent.',
    'unsent.explain': 'You have an unfinished deposit that was never sent. It can’t be finished on '
        + '{?F}version {F}{/F}{!F}this version{/F}.',
    'unsent.cancel': 'Cancel unfinished deposit',
    'previous.open': 'Open {?P}version {P}{/P}{!P}another version{/P}',
    'previous.credit': 'A payout from {?P}version {P}{/P}{!P}another version{/P} is ready to claim. '
        + '{?blocked}To claim it, withdraw your current balance first, then open '
        + '{?P}version {P}{/P}{!P}that version{/P}.{/blocked}'
        + '{!blocked}Open {?P}version {P}{/P}{!P}that version{/P} to claim it.{/blocked} '
        + 'This does not stop new deposits.',

    // The service and the chat window.
    'service.paused': '{?message}{message}{/message}'
        + '{!message}Private access is paused right now. You can still withdraw your balance.{/message}',
    'admission.closed': '{?F}Version {F}{/F}{!F}This version{/F} is no longer starting new chats. '
        + 'Withdraw your balance{?N}, then deposit into version {N} to keep chatting{/N}.',
    'near_expiry': 'This balance is about to expire. Withdraw it now. New chats are paused so nothing is '
        + 'left unsettled.',
    'legacy.unreachable': '{?F}Version {F}{/F}{!F}That version{/F} could not be reached.'
        + '{?N} Return to version {N}.{/N} Nothing was changed.',
    'unavailable': 'zkAPI could not start in this tab. Reload to try again. Your balance is saved in this browser.',
    'discard.loop': 'Close other open tabs of this app, then reload.',

    // The service pause, by what the service reported. The SDK's own message
    // is never shown: it is written for an engineer and can carry an
    // operator's address. Each text says the same two things, that new chats
    // and deposits are paused and that a withdrawal still works, and says what
    // to do only when there is something to do.
    'service.paused.unreachable': 'The private service can’t be reached right now, so new chats and deposits '
        + 'are paused. You can still withdraw your balance.',
    'service.paused.changed': 'The private service changed in a way this page doesn’t recognize, so new chats '
        + 'and deposits are paused to keep your balance safe. You can still withdraw. Reload to get the latest page.',
    'service.paused.untrusted': 'This page was opened with a service link it doesn’t trust, so new chats and '
        + 'deposits are paused. You can still withdraw. Open the app without that link.',
    'service.paused.incompatible': 'The service is running an older, incompatible protocol, so new chats and '
        + 'deposits are paused. You can still withdraw your balance.',
    'service.paused.contract': 'We couldn’t confirm the payment contract with the network provider, so new chats '
        + 'and deposits are paused. You can still withdraw. Try again in a moment.',
    'service.check': 'Check again',
    'service.stillPaused': 'The private service is still unavailable. You can still withdraw your balance.',

    // A balance that is about to expire. The upgrade texts above never apply
    // here: the version that takes deposits has nothing to upgrade to.
    'near.balance': 'New chats are paused because this balance is about to expire. Withdraw it to get the '
        + 'unused amount back.{?exitBy} Start the withdrawal by {exitBy}.{/exitBy} If it expires, the service '
        + 'treasury can claim it.',
    'setAside.near': 'A balance you set aside is close to its deadline. Finish withdrawing it from Payment '
        + 'history{?setAsideBy} by {setAsideBy}{/setAsideBy}. A balance that is not withdrawn before it expires '
        + 'can be claimed by the service treasury.',

    // Leaving while a chat may still be settling, and what else can hold a
    // withdrawal back. The concession texts are required wording: the chat is
    // not recorded on Ethereum, so the person may give up more than it cost.
    'exit.settlement': 'A recent chat may still be settling, so a normal withdrawal waits for it'
        + '{?escapeAt} until {escapeAt}{/escapeAt}. You can wait, or leave now with an emergency exit, which '
        + 'takes longer to finish.',
    'exit.concede.zero': 'Give up nothing now. If the service later shows that chat was charged, '
        + '{?bound}up to {bound}{/bound}{!bound}its cost{/bound} may still be taken from your payout.',
    'exit.concede.bound': 'Give up {?bound}up to {bound}{/bound}{!bound}the most that chat could cost{/bound} '
        + 'now. That chat isn’t recorded on Ethereum, so you may give up more than it actually cost.',
    'exit.bound': 'If a recent chat is still settling, a withdrawal can give up '
        + '{?bound}as much as {bound}{/bound}{!bound}part of your balance{/bound}.',
    'exit.proofWait': 'Your earlier withdrawal request is about to expire. Try again in '
        + '{?retryIn}{retryIn} {?retryOne}second{/retryOne}{!retryOne}seconds{/retryOne}{/retryIn}'
        + '{!retryIn}a few seconds{/retryIn}.',
    'exit.releasePending': 'An earlier withdrawal attempt has expired, but the network hasn’t confirmed yet that '
        + 'it can no longer go through. Try again shortly.',
    // With an end time the wait is for an earlier withdrawal that can still
    // land. Without one (a withdrawal of this balance that was started and is
    // not finished, or one whose end the network has not confirmed) nothing
    // here expires on its own, so the text never promises that it will.
    'exit.frozen': '{?until}This balance is frozen while an earlier withdrawal can still go through. New chats '
        + 'resume after {until}.{/until}'
        + '{!until}This balance is frozen while a withdrawal of it has started and not finished. New chats '
        + 'resume when it finishes or can no longer go through.{/until} You can still withdraw.',
    'exit.device': 'This balance was used on another device or copy after this browser last saved it, so this '
        + 'browser can’t safely withdraw it. Withdraw it from the device that used it last. '
        + 'Trying here would cost network fees and be rejected.',
    'exit.device.label': 'Used on another device',
    'exit.rpc': 'Keep a current exit kit so you can leave even if the service is unavailable.',

    // Payouts. A payout the payment contract could not send is held for the
    // person and claimed separately; it is never "returned" or "sent".
    'payout.alert': 'A withdrawal paid out less than your balance minus your last chat’s budget. The payment '
        + 'can’t be changed. Please report it to the service operator.',
    'payout.alert.badge': 'Paid less than expected',
    'payout.credited': 'Payout held{?amount}: {amount}{/amount}. It could not be sent to your address, so the '
        + 'payment contract holds it for you. Claim it to receive it{?destination} at {destination}{/destination}.',
    'payout.notice': '{?countOne}A payout is{/countOne}'
        + '{!countOne}{?count}{count} payouts are{/count}{!count}Payouts are{/count}{/countOne} held for you. '
        + 'Open Payment history to claim {?countOne}it{/countOne}{!countOne}them{/countOne}.',

    // The exit kit: an encrypted file, made on request, that can move the
    // balance. Only the companion tool opens it; this app never does.
    'kit.never': 'You haven’t created an exit kit for this balance yet. An exit kit is an encrypted file that '
        + 'lets you withdraw it with the zkAPI companion tool, even if the service is unavailable. Create one '
        + 'and keep it somewhere safe.',
    'kit.unsaved': 'Your exit kit was created but not saved. Create it again and save the file.',
    'kit.stale': 'Your exit kit is older than your latest chats and no longer opens this balance. Create a new one.',

    // The one place a note number is shown, as a reference beside its version
    // (note numbers repeat across versions): the operator's own notice says
    // what to do about it.
    // `hasReference` is derived by render() from the presence of the number,
    // not from its value: a flag would read the first note, number 0, as off.
    'operator.reference': '{?hasReference}Reference number {reference}{?V} for version {V}'
        + '{?retired}, which has been retired{/retired}{/V}.{/hasReference}',

    // Giving up a zero or dust balance on a version that takes no deposits.
    // Nothing is said to be lost or kept safe beyond what is true: no funds
    // move, the deposit stays where it is, and the app cannot undo it.
    'abandon.zero': 'This balance is empty, and {?F}version {F}{/F}{!F}this version{/F} no longer takes '
        + 'deposits. Clear it to deposit into {?N}version {N}{/N}{!N}the newer version{/N}. Nothing moves '
        + 'on Ethereum.',
    'abandon.dust': 'This balance is {?amount}{amount}{/amount}{!amount}very small{/amount}{?eth} ({eth}){/eth}, '
        + 'and {?F}version {F}{/F}{!F}this version{/F} no longer takes deposits. A withdrawal costs a network '
        + 'fee, which may be more than this balance is worth. You can give it up to deposit into '
        + '{?N}version {N}{/N}{!N}the newer version{/N}, or withdraw it instead.'
        + '{?limit} Only balances below {limit} can be given up.{/limit}',
    'abandon.dustNoPrice': 'This balance is small, but its value can’t be checked because the price isn’t '
        + 'available right now. Check the price again in a moment.',
    'abandon.chain': 'Nothing moves on Ethereum. Your deposit stays in the service’s payment contract until it '
        + 'expires, and then the service treasury can claim it, as it could have anyway.',
    'abandon.irreversible': 'This app can’t bring the balance back once you give it up.',
    'abandon.link': 'Give up this balance',
    'abandon.linkZero': 'Clear this balance',

    // A balance this browser holds that the page cannot read because the
    // version's own SDK did not start. The wallet is known to hold the balance
    // (the page read it itself), so it is neither empty nor lost, and nothing
    // can be done with it until the SDK starts: no Add funds, no deposit into
    // another version (the wallet holds one balance at a time), no withdrawal
    // or give-up (all of them need the service to start). Reload is the one
    // thing to do, and it is said: nothing on the page retries the start by
    // itself, so waiting does not bring the balance back. The cause is not
    // told: whatever stopped the start (no answer, an answer the page does
    // not trust, a service on another protocol) is "not available" to this
    // page, and the SDK's own text names the operator. No address and no
    // error text of the service is ever part of these words.
    //   held.label        what stands where the amount would be
    //   held.unreachable  the whole explanation (F is the version that holds
    //                     the balance, N the version deposits go to)
    //   held.summary      the same in one sentence, for the narrow surfaces
    //                     (the chat bar, the welcome, a toast)
    'held.label': 'Saved in this browser',
    'held.unreachable': 'Your balance is still saved in this browser. '
        + '{?F}Version {F}’s service{/F}{!F}This version’s service{/F} isn’t available right now, so the '
        + 'balance can’t be shown yet. Reload to check again.'
        + '{?N} To use version {N}, first withdraw this balance from {?F}version {F}{/F}{!F}this version{/F}.{/N}',
    'held.summary': 'Your balance is saved in this browser, but its service isn’t available right now. '
        + 'Reload to check again.'
});

// Keys whose first sentence assumes the page is NOT on the deposit target
// ("Deposits moved to version 2. This page is on version 2" would be false).
// A caller that names the same version for both gets the wording without N.
// 'admission.closed' is one: a stale tab on the deposit target that the
// gateway stopped admitting would otherwise be told to "deposit into version
// 2" about version 2 itself (the same deployment that refuses its chats).
const TARGET_DIFFERS_KEYS = new Set([
    'deposits.closed', 'send.closed', 'send.largerKey', 'admission.closed', 'abandon.zero', 'abandon.dust',
    'held.unreachable'
]);

// Tokens that hold a version's name (see versionName).
const VERSION_TOKENS = ['N', 'F', 'P', 'R', 'V'];

// The words for each service code the host can say plainly. A code that is
// not here (a new SDK code, an operator's own) gets the generic
// 'service.paused' text: the SDK's message is written for an engineer.
const SERVICE_KEY_BY_CODE = Object.freeze({
    deployment_manifest_unavailable: 'service.paused.unreachable',
    deployment_manifest_mismatch: 'service.paused.changed',
    deployment_manifest_untrusted: 'service.paused.untrusted',
    incompatible_proof_circuit: 'service.paused.incompatible',
    native_vault_unverified: 'service.paused.contract'
});

/**
 * The copy key that explains a service pause with this code, or null when the
 * code has no plain words of its own (then 'service.paused' says it
 * generically).
 */
export function serviceCopyKey(code) {
    return typeof code === 'string' && hasOwn(SERVICE_KEY_BY_CODE, code) ? SERVICE_KEY_BY_CODE[code] : null;
}

/** Every key `versionCopy` knows, for consumers that enumerate (tests, docs). */
export const COPY_KEYS = Object.freeze(Object.keys(TEMPLATES));

export const OPERATOR_TEXT_LIMIT = 280;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Text safety
// ---------------------------------------------------------------------------

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/`/g, '&#96;');
}

// Control characters (including line and paragraph separators), runs of
// whitespace and anything past the limit. An ellipsis marks a cut and counts
// toward the limit, so the result never exceeds `limit` UTF-16 units. A cut
// never splits a surrogate pair.
function boundText(value, limit = OPERATOR_TEXT_LIMIT) {
    if (typeof value !== 'string') return '';
    const text = value
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length <= limit) return text;
    let end = limit - 1;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * Operator-controlled text (service message, a notice's text) made safe to
 * place in HTML: bounded, control characters removed, escaped. Always plain
 * text; callers never link it or act on it.
 */
export function safeOperatorText(value) {
    return escapeHtml(boundText(value));
}

/** The same bound without escaping, for contexts that set text content. */
export function boundedOperatorText(value) {
    return boundText(value);
}

// ---------------------------------------------------------------------------
// Names and dates
// ---------------------------------------------------------------------------

/**
 * The part of a version's name the templates put after "version": "2" for the
 * label "Version 2", the id "v2" or the number 2. Accepts a {id, label} or a
 * plain string. A name that is neither is kept as it is ("Mercury").
 */
export function versionName(version) {
    const label = typeof version === 'string' ? version
        : isRecord(version) && typeof version.label === 'string' ? version.label : '';
    const id = isRecord(version) && typeof version.id === 'string' ? version.id : '';
    const stripped = label.replace(/^\s*version\s+/i, '').trim() || id.trim();
    // "v2" is an id, not a name: it reads as "2" after the word "version".
    const match = /^v(\d+)$/i.exec(stripped);
    return match ? match[1] : stripped;
}

// The protocol version people are SHOWN for a registry row, where it differs
// from the row's own `protocolVersion`. UI words only: the row's id,
// `protocolVersion`, adapter, routes, stored records, the build and every
// protocol check keep their values. One entry per display decision:
//   v4  the current PR31 version (active on Sepolia; protocolVersion "0.4",
//       adapter leaf-bound-v2) is shown as "zkAPI v0.2" by product decision
//       (October 2026), on every network that serves the row. The older
//       rows keep their own names: v1 "zkAPI v0.1", v2 "zkAPI v0.2", v3
//       "zkAPI v0.3"; where v2 and v4 meet (a version 2 balance whose
//       deposits moved to v4) the help says "an earlier build" rather than
//       print one name for both (`sameName`).
// An entry applies only while BOTH the id and the registry protocolVersion
// match, so a later edit of that row ends the override instead of renaming a
// different protocol. Not a registry field on purpose: nothing but these
// words reads it.
const DISPLAY_PROTOCOL_VERSIONS = Object.freeze([
    Object.freeze({ id: 'v4', protocolVersion: '0.4', display: '0.2' })
]);

/**
 * The protocol version people are shown for a version ({id, protocolVersion},
 * a ResolvedVersion or VersionState.current): the display override above
 * when one applies, else the row's `protocolVersion`; '' when it has none.
 * The pill prints "zkAPI v" before it.
 */
export function displayProtocolVersion(version) {
    if (!isRecord(version)) return '';
    const protocol = typeof version.protocolVersion === 'string' ? version.protocolVersion.trim() : '';
    if (!protocol) return '';
    const id = typeof version.id === 'string' ? version.id : '';
    const override = DISPLAY_PROTOCOL_VERSIONS.find(entry => entry.id === id && entry.protocolVersion === protocol);
    return override ? override.display : protocol;
}

const DEFAULT_DATE_OPTIONS = Object.freeze({
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
});

/**
 * Local date AND time of an epoch-millisecond instant. Legacy expiries round
 * up to UTC midnight, so a date alone is an evening hour or the wrong day in
 * many time zones.
 *
 * `formatter` is a function (Date) => string or an Intl.DateTimeFormat-like
 * object with `format`. Without one the runtime's locale and zone are used.
 * Returns '' for an unusable instant or a formatter that fails, which the
 * templates treat as "no date".
 */
export function formatLocalDateTime(epochMs, formatter = null) {
    if (typeof epochMs !== 'number' || !Number.isFinite(epochMs) || epochMs <= 0) return '';
    const date = new Date(epochMs);
    if (Number.isNaN(date.getTime())) return '';
    try {
        let text;
        if (typeof formatter === 'function') text = formatter(date);
        else if (formatter && typeof formatter.format === 'function') text = formatter.format(date);
        else text = date.toLocaleString(undefined, DEFAULT_DATE_OPTIONS);
        return typeof text === 'string' ? text : '';
    } catch {
        return '';
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const CONDITIONAL = /\{([?!])([A-Za-z][A-Za-z0-9]*)\}([\s\S]*?)\{\/\2\}/g;
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

// Tokens come from arbitrary callers: only plain scalars are kept, strings are
// bounded and control characters removed. N, F, P and R are version names; a
// caller may pass a whole label ("Version 2") or an id ("v2").
function readTokens(tokens) {
    const out = Object.create(null);
    if (!isRecord(tokens)) return out;
    for (const name of Object.keys(tokens)) {
        const value = tokens[name];
        if (typeof value === 'string') out[name] = boundText(value);
        else if (typeof value === 'number' && Number.isFinite(value)) out[name] = String(value);
        else if (typeof value === 'boolean') out[name] = value ? '1' : '';
    }
    for (const name of VERSION_TOKENS) {
        if (name in out) out[name] = versionName(out[name]);
    }
    return out;
}

// A flag is on for any non-empty value other than "0" and "false".
function isOn(tokens, name) {
    if (!(name in tokens)) return false;
    const value = tokens[name].trim();
    return value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

function tidy(text) {
    return text.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}

/**
 * The text for a key. The result is HTML-safe: every token value is escaped,
 * so it can be placed in element content or a quoted attribute as is. Use
 * `versionCopyText` where text content is set directly.
 *
 * An unknown key renders as an empty string: a copy typo must never break the
 * dialog a user needs to withdraw from.
 *
 * @param {CopyKey} key
 * @param {Record<string, string|number|boolean>} [tokens]
 * @returns {string}
 */
export function versionCopy(key, tokens = {}) {
    return render(key, tokens, escapeHtml);
}

/** As `versionCopy` but unescaped, for `textContent`, `title` set by property, and toasts. */
export function versionCopyText(key, tokens = {}) {
    return render(key, tokens, value => value);
}

function render(key, tokens, encode) {
    if (typeof key !== 'string' || !hasOwn(TEMPLATES, key)) return '';
    const values = readTokens(tokens);
    if (key === 'service.paused' && !('message' in values)) {
        // The operator's words may arrive under the name the SDK field has.
        for (const alias of ['text', 'serviceMessage', 'detail']) {
            if (alias in values) { values.message = values[alias]; break; }
        }
    }
    // The same version named as both "moved to" and "this page is on" is
    // not a move: say it without N.
    if (TARGET_DIFFERS_KEYS.has(key) && 'N' in values && values.N !== '' && values.N === values.F) {
        delete values.N;
    }
    // A count of one chooses the singular; a caller passes the number only.
    if (values.retryIn === '1') values.retryOne = '1';
    if (values.count === '1') values.countOne = '1';
    // A reference number is present, not "on": 0 is the first note's number.
    // A caller-supplied `hasReference` is never believed.
    delete values.hasReference;
    if ('reference' in values && values.reference !== '') values.hasReference = '1';
    // Conditionals first, on the template only: a token value that happens to
    // look like template syntax is inserted afterwards and never re-read. A
    // conditional may hold others of a different name, so resolve until none
    // is left (templates nest at most three deep: the help).
    let resolved = TEMPLATES[key];
    for (let pass = 0; pass < 4; pass += 1) {
        const next = resolved.replace(CONDITIONAL, (match, sign, name, inner) => (
            isOn(values, name) === (sign === '?') ? inner : ''));
        if (next === resolved) break;
        resolved = next;
    }
    const text = resolved.replace(PLACEHOLDER, (match, name) => (name in values ? encode(values[name]) : ''));
    return tidy(text);
}

// ---------------------------------------------------------------------------
// Helpers that tie VersionState to the table
// ---------------------------------------------------------------------------

// A version ref with its registry protocol version: the ref's own, else the
// table row's of the same id (VersionState.target carries only id and label).
function withProtocol(version, table) {
    if (typeof version.protocolVersion === 'string' && version.protocolVersion.trim()) return version;
    const row = Array.isArray(table) ? table.find(entry => isRecord(entry) && entry.id === version.id) : null;
    return row && typeof row.protocolVersion === 'string'
        ? { id: version.id, protocolVersion: row.protocolVersion } : version;
}

// The registry label of a version id, when the caller passed the table; the
// id alone otherwise (versionName reads "v2" as "2").
function namedById(id, table) {
    const row = Array.isArray(table) ? table.find(entry => isRecord(entry) && entry.id === id) : null;
    return { id, label: row && typeof row.label === 'string' ? row.label : '' };
}

/**
 * The tokens a VersionState supplies, for every key at once:
 *   N        the deposit target
 *   F        the version this page is on
 *   P        the other version with unfinished business (`state.previous`),
 *            left out when there is none or it is this very version; the
 *            previous.* and deposits.blocked.previous texts read only this,
 *            so with `previous: null` they say "another version" instead of
 *            pointing at the loaded one
 *   R        the version a reload would load (`state.reload.targetId`)
 *   closeBy, expiry  formatted local date and time
 *   message  the service message
 *   reload   flag: a fresh load picks the target
 *   waiting  flag: a withdrawal here is still finishing
 *   blocked  flag: the previous version cannot be opened while this page
 *            holds the slot
 *   message  the host's words for the service pause, chosen by the service
 *            code (serviceCopyKey). The SDK's own message is never a token:
 *            it is written for an engineer, and a service without a code the
 *            table knows gets the generic wording
 *   until, escapeAt, exitBy, setAsideBy  local dates of the exit facts; with
 *            `options.now`, one that has already passed is left out
 *   bound    the most a settling chat can take, through `formatAmount`; the
 *            larger of the refused attempt's bound and the standing one
 *   retryIn  whole seconds until a refused withdrawal may be retried
 *            (`options.now`)
 *   FP, NP   the protocol versions people are shown for F and N
 *            (displayProtocolVersion): F's from `state.current` as the pill
 *            reads it, N's from `table` by id when the ref (`state.target`)
 *            carries none
 *   sameName flag: F and N are different versions with the same FP/NP
 * Missing values are left out so the templates fall back to their plainer
 * wording.
 *
 * `state` carries ids for `previous` and `reload`, not labels. Pass `table`
 * (the ResolvedVersion list) so P and R use registry labels; without it the id
 * is read as a name, which is right for the "v1", "v2" ids of the registry.
 *
 * @param {object} state VersionState
 * @param {{formatter?: Function|object, table?: object[],
 *   formatAmount?: (units: string) => string, now?: number}} [options]
 *   `formatAmount` turns an amount in gwei (a decimal string) into the words
 *   the page uses for money; without one no `bound` is given.
 */
export function copyTokens(state, options) {
    const { formatter = null, table = null, formatAmount = null, now = null } = isRecord(options) ? options : {};
    const tokens = {};
    if (!isRecord(state)) return tokens;
    const current = isRecord(state.current) ? state.current : null;
    const target = isRecord(state.target) ? state.target : null;
    const name = (token, version) => {
        const value = versionName(version);
        if (value) tokens[token] = value;
    };
    if (target) name('N', target);
    if (current) name('F', current);
    // The names the pill shows (its help reads these). This page's version
    // is read from the state alone, as the pill reads it; the target is a ref
    // with no protocol version, so its table row supplies one.
    const shownF = current ? displayProtocolVersion(current) : '';
    const shownN = target ? displayProtocolVersion(withProtocol(target, table)) : '';
    if (shownF) tokens.FP = shownF;
    if (shownN) tokens.NP = shownN;
    if (shownF && shownN && shownF === shownN && current.id !== target.id) tokens.sameName = 1;
    const previousId = isRecord(state.previous) && typeof state.previous.versionId === 'string'
        ? state.previous.versionId : '';
    if (previousId && previousId !== current?.id) name('P', namedById(previousId, table));
    const reload = isRecord(state.reload) ? state.reload : null;
    const reloadId = reload && reload.required === true && typeof reload.targetId === 'string' ? reload.targetId : '';
    if (reloadId) name('R', namedById(reloadId, table));

    // Flags the state already knows.
    if (reloadId && target && reloadId === target.id) tokens.reload = 1;
    if (isRecord(state.upgrade) && state.upgrade.blockedBy === 'open_withdrawal') tokens.waiting = 1;
    if (isRecord(state.previous) && state.previous.canOpen === false && previousId !== current?.id) {
        tokens.blocked = 1;
    }
    const closeBy = formatLocalDateTime(state.closeByTs, formatter);
    if (closeBy) tokens.closeBy = closeBy;
    const expiry = formatLocalDateTime(state.expiryTs, formatter);
    if (expiry) tokens.expiry = expiry;
    const serviceKey = isRecord(state.service) ? serviceCopyKey(state.service.code) : null;
    if (serviceKey) tokens.message = versionCopyText(serviceKey);

    // The balance's exit facts.
    const exit = isRecord(state.exit) ? state.exit : null;
    if (exit) {
        const frozen = isRecord(exit.frozen) ? exit.frozen : null;
        const wait = isRecord(exit.wait) ? exit.wait : null;
        const until = upcomingDate(frozen?.untilMs, formatter, now);
        if (until) tokens.until = until;
        const escapeAt = upcomingDate(wait?.escapeAtMs, formatter, now);
        if (escapeAt) tokens.escapeAt = escapeAt;
        const exitBy = upcomingDate(exit.mustInitiateByMs, formatter, now);
        if (exitBy) tokens.exitBy = exitBy;
        // The larger of the refused attempt's bound and the standing one. A
        // state built from an older refusal can carry a smaller figure than
        // the balance now has, and a disclosure must never say less than the
        // most that can be given up.
        const bound = formattedAmount(largerAmount(wait?.boundAtState, exit.boundAtState), formatAmount);
        if (bound) tokens.bound = bound;
        if (wait && wait.kind === 'proof' && typeof wait.untilMs === 'number' && typeof now === 'number'
            && Number.isFinite(wait.untilMs) && Number.isFinite(now) && wait.untilMs > now) {
            tokens.retryIn = Math.ceil((wait.untilMs - now) / 1000);
        }
    }
    const setAside = isRecord(state.setAside) ? state.setAside : null;
    const setAsideBy = upcomingDate(setAside?.earliestMustInitiateByMs, formatter, now);
    if (setAsideBy) tokens.setAsideBy = setAsideBy;
    return tokens;
}

// The local date and time of an instant, or '' once it has passed. A clock is
// what makes "passed" knowable: without one the instant is printed as it is.
function upcomingDate(epochMs, formatter, now) {
    const clock = typeof now === 'number' && Number.isFinite(now) ? now : null;
    if (clock !== null && !(typeof epochMs === 'number' && epochMs > clock)) return '';
    return formatLocalDateTime(epochMs, formatter);
}

// An amount of gwei as a canonical decimal string (the SDK writes bounds as
// strings and some balances as numbers), or null.
function amountText(units) {
    const text = typeof units === 'number' && Number.isSafeInteger(units) && units >= 0 ? String(units) : units;
    return typeof text === 'string' && /^[0-9]{1,30}$/.test(text) ? String(BigInt(text)) : null;
}

// The largest of the amounts that are amounts, or null.
function largerAmount(...values) {
    let best = null;
    for (const value of values) {
        const text = amountText(value);
        if (text !== null && (best === null || BigInt(text) > BigInt(best))) best = text;
    }
    return best;
}

// An amount of gwei (decimal string) as words, or '' when it is zero, not an
// amount, or the caller's formatter fails. A bound of zero is nothing to
// disclose, and an empty figure must not read as "up to .".
function formattedAmount(units, formatAmount) {
    if (typeof formatAmount !== 'function') return '';
    const text = amountText(units);
    if (text === null || BigInt(text) === 0n) return '';
    try {
        const formatted = formatAmount(text);
        return typeof formatted === 'string' ? formatted.trim() : '';
    } catch {
        return '';
    }
}

/**
 * The banner text key for an upgrade phase, from the reminder tier, or null
 * when the phase is not an upgrade prompt. A tier a registry row defines
 * beyond 7/3/1 maps to the nearest of those at or above it.
 */
export function upgradeBannerKey(state) {
    if (!isRecord(state)) return null;
    switch (state.phase) {
        case 'upgrade-available':
            return 'banner.available';
        case 'upgrade-overdue':
            return 'banner.overdue';
        case 'upgrade-soon': {
            const tier = state.reminderTier;
            if (typeof tier !== 'number' || !Number.isFinite(tier)) return 'banner.soon';
            if (tier <= 0) return 'banner.overdue';
            if (tier <= 1) return 'banner.tier1';
            if (tier <= 3) return 'banner.tier3';
            if (tier <= 7) return 'banner.tier7';
            return 'banner.soon';
        }
        default:
            return null;
    }
}

/**
 * The explanation for a closed deposit gate, or null when deposits can
 * start. `retired` selects the retirement wording for a foreign slot owner
 * (Selection.reason === 'retired_deployment'); it never says "Nothing is lost".
 * `reload_required` (the balance moved to another version in another tab) is
 * told in the reload notice's own words, `reload.otherTab`.
 */
export function gateCopyKey(gate, options) {
    const retired = isRecord(options) && options.retired === true;
    if (!isRecord(gate) || gate.canStart === true) return null;
    switch (gate.code) {
        case 'deposits_closed': return 'deposits.closed';
        case 'previous_withdrawal_open': return 'deposits.blocked.previous';
        case 'holdings_unreadable': return 'deposits.blocked.unreadable';
        case 'foreign_runtime': return retired ? 'deposits.blocked.retired' : 'deposits.blocked.foreign';
        case 'config_mismatch':
        case 'stale_build': return 'deposits.blocked.stale';
        case 'reload_required': return 'reload.otherTab';
        case 'version_unavailable': return 'unavailable';
        default: return 'unavailable';
    }
}

// The gate codes whose explanation ends in "Reload": a plain reload is the
// whole remedy (nothing is selected differently), so a button is offered for
// them. `deposits_closed` is not here: it only asks for a reload when a fresh
// load would pick another version, and that is the reload notice. Kept next to
// gateCopyKey so the two stay in step.
const RELOAD_GATE_CODES = new Set([
    'holdings_unreadable', 'foreign_runtime', 'config_mismatch', 'stale_build', 'version_unavailable'
]);

/** Whether a closed gate with this code is remedied by a plain reload. */
export function gateOffersReload(code) {
    return RELOAD_GATE_CODES.has(code);
}
