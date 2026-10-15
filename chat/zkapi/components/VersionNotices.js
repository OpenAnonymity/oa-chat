// Protocol-version notices for the System Panel, the balance dialog and the
// ticket panel (docs/ZKAPI_VERSIONING.md, "Upgrade UX").
//
// Pure string renderers plus one pure patch function over an Element-like
// root. Nothing here reads the facade, storage, the clock or the SDK: the
// VersionState arrives as an argument and so does everything else the words
// need (`table` for registry labels, `formatter` for dates, `retired`/`flags`
// for the facts a VersionState does not carry). `chat/zkapi/versioning/ui.js`
// binds those to the page's facade; tests pass them directly.
//
// What is shown, and why it is shown that way:
//   - the pill ("Version 1") only where a build has more than one live
//     version (`state.show`). It is amber only inside the prompt window
//   - banners from the phase and the deposit gate, never from `state.show`:
//     a lone exit-only version has no pill but a closed gate that must be
//     explained
//   - a day-0 balance gets a neutral note; the prominent button starts inside
//     the prompt window. An empty balance gets no prompt (the state says so)
//   - banners are static text: no live region, no focus theft, no layout
//     shift. A clock tick only patches text (patchVersionNotices)
//   - nothing signs, deposits, withdraws or reloads on its own: a button is
//     a user gesture, and the reload button follows the facade's canReload
//   - an operator notice that took effect (VersionState.notices, the text of a
//     stuck-escape notice that relaxed the deposit gate for a record this
//     browser holds) is an info notice on the panel and the dialog, never on
//     the ticket surface: bounded, escaped, plain text with no action
//   - the deposit step's notice can be dismissed, and dismissing it forgets
//     the upgrade (facade.abandonUpgrade), so it does not return next session
//   - a balance this browser holds but the page cannot read (`state.held`: the
//     version's SDK did not start) is one notice, `held`, with one action,
//     Reload. It stands in for every notice that would be told from a
//     snapshot with nothing in it (the closed gate, "add funds", a paused
//     service that "still lets you withdraw"), and it is not shown in ticket
//     mode, where nothing about this balance is at risk
//
// Facts about the balance itself are additive notices, never phases (the
// precedence in versionState.mjs is unchanged). Each reads only the
// VersionState; the facade holds the refusals and the clock:
//   near      the balance is about to expire: new chats are paused and a
//             withdrawal must start by a time (never mentions upgrading)
//   wait      a refused withdrawal says when it can be tried again (dialog only)
//   frozen    the balance is frozen while an earlier withdrawal can still land
//   device    another device used this balance after this browser saved it
//   payout    a withdrawal paid out less than the disclosed bound allows
//   claim     a payout is held for the person to claim from Payment history
//   setaside  a set-aside balance is close to its deadline. On the panel and
//             the dialog it also stands in for this version's own "finish the
//             previous withdrawal" notice, which would tell the same deadline
//             a second time in the words of an upgrade
//   kit       no exit kit was made, or one was made and not saved
//   abandon   an empty or very small balance on a closed version can be given
//             up; it replaces the upgrade prompt on the surfaces that carry it
// plus "Check again" on the service notice. The ticket surface carries none of
// them: it keeps only what puts funds at risk (TICKET_NOTICES).
//
// A balance this browser can not safely withdraw (another device used it
// since) is told one thing, by `device`. The notices that would send the
// person to a withdrawal that is rejected (`near`, `wait`, `frozen`) are left
// out beside it, and `device` itself has no Withdraw button.
//
// Notices whose words move with the clock (an instant that passes, a retry
// count) carry `data-zkapi-version-clock`, so a host that patches on a clock
// tick knows there is text to move without a close-by deadline on the page.
//
// Words come from versioning/copy.mjs. Version copy is HTML already (every
// token escaped); text content uses versionCopyText. The few labels below
// that copy.mjs has no key for are static and carry no operator text.
import {
    boundedOperatorText, copyTokens, escapeHtml, gateCopyKey, gateOffersReload, safeOperatorText, upgradeBannerKey,
    versionCopy, versionCopyText
} from '../versioning/copy.mjs';
import { ABANDON_WORDS, openAbandonDialog } from './AbandonDialog.js';
import { EXIT_KIT_WORDS, openExitKitDialog } from './ExitKitDialog.js';
import { privateBalanceHelpButton, versionHelpDetail } from './PrivateBalanceHelp.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const SURFACES = Object.freeze(['panel', 'dialog', 'ticket']);

const LABELS = Object.freeze({
    reload: 'Reload',
    upgradeNow: 'Upgrade now',
    upgradeBalance: 'Upgrade balance',
    continueUpgrade: 'Continue upgrade',
    dismiss: 'Dismiss',
    withdraw: 'Withdraw',
    openPayments: 'Open Payment history',
    createKit: 'Create exit kit',
    withdrawInstead: 'Withdraw instead'
});

// Tone classes shared with the existing expiry notice and readiness pill, so
// the version notices read as the same family in light and dark themes.
const NOTICE_TONES = Object.freeze({
    info: 'border-border bg-muted/50 text-muted-foreground',
    attention: 'border-amber-300/60 bg-amber-50/60 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
});
const PILL_BASE = 'zkapi-version-pill rounded-full px-2 py-0.5 text-[9px] font-medium whitespace-nowrap';
const PILL_TONES = Object.freeze({
    muted: ['bg-muted', 'text-muted-foreground'],
    amber: ['bg-amber-100', 'text-amber-800', 'dark:bg-amber-500/15', 'dark:text-amber-200']
});

// Ticket (OA) mode is a different product mode: only what puts funds at
// risk reaches it, never a neutral note or anything about chats. Operator
// notices (ids `operator-N`) are not among them: they explain a relaxation of
// the deposit gate, which ticket mode has nothing to do with.
const TICKET_NOTICES = new Set(['upgrade', 'previous', 'credit']);

// A notice that belongs where the thing it explains is: a refused
// withdrawal's wait is shown in the balance dialog, not in the System Panel.
const DIALOG_ONLY_NOTICES = new Set(['wait']);

// No registry row can carry more notices than this, so a state with more is
// not a real one; the bound keeps a hand-built state from flooding a surface.
const OPERATOR_NOTICE_LIMIT = 16;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function surfaceOf(value) {
    return SURFACES.includes(value) ? value : 'panel';
}

// ---------------------------------------------------------------------------
// Dismissals (page lifetime, memory only)
// ---------------------------------------------------------------------------

// A notice the person closed stays closed until the page reloads. Memory
// only: nothing here is persisted or synced, and a reload clears the facts
// that raised these notices anyway.
const dismissed = new Set();

/**
 * Hide a dismissible notice (`draft`, `done`, `deposit`, `payout`, and the
 * exit kit prompt) on every surface.
 */
export function dismissVersionNotice(id) {
    if (typeof id === 'string' && id) dismissed.add(id);
}

// What a dismissal is stored under. A payout alert is dismissed for the
// alerts the person saw: an alert that arrives later is a new notice, so the
// key carries the count. Any other notice is dismissed by its id.
function dismissKeyFor(noticeId, state) {
    if (noticeId === 'payout' && isRecord(state) && isRecord(state.payouts)
        && Number.isSafeInteger(state.payouts.alerts) && state.payouts.alerts > 0) {
        return `payout:${state.payouts.alerts}`;
    }
    return noticeId;
}

/** Tests only. */
export function resetVersionNoticeDismissals() {
    dismissed.clear();
}

function isDismissed(id, options) {
    const given = options.dismissed;
    if (given instanceof Set) return given.has(id);
    if (Array.isArray(given)) return given.includes(id);
    return dismissed.has(id);
}

// ---------------------------------------------------------------------------
// The pill
// ---------------------------------------------------------------------------

function badgeModel(state) {
    if (!isRecord(state) || state.show !== true || !isRecord(state.current)) return null;
    const label = versionCopy('pill', { F: state.current.label || state.current.id });
    if (!label) return null;
    // Amber only inside the prompt window: the colour says "act", not "old".
    const amber = state.phase === 'upgrade-soon' || state.phase === 'upgrade-overdue';
    return { label, text: versionCopyText('pill', { F: state.current.label || state.current.id }), amber };
}

/**
 * The version pill and its help toggle, for the panel header or the dialog's
 * balance card. '' when the build has one live version (`state.show` false),
 * so today's DOM is untouched.
 *
 * The toggle is the shared help button (id `zkapi-{panel|modal}-version-help-toggle`,
 * `data-zkapi-help="version"`); its disclosure is `privateBalanceHelpContent(
 * scope, 'version', open, versionHelp('version', state))`, rendered by the
 * owner beside the other help panels.
 *
 * @param {object} state VersionState
 * @param {{surface?: 'panel'|'dialog', helpOpen?: boolean}} [options]
 */
export function renderVersionBadge(state, options = {}) {
    const badge = badgeModel(state);
    if (!badge) return '';
    const surface = options.surface === 'dialog' ? 'dialog' : 'panel';
    const tone = badge.amber ? 'amber' : 'muted';
    // The dialog's pills (readiness, expiry) have their own frame; the panel's
    // are utility-styled at 9px.
    const classes = [surface === 'dialog' ? 'zkapi-version-pill zkapi-pill' : PILL_BASE, ...PILL_TONES[tone]].join(' ');
    const toggle = privateBalanceHelpButton(surface === 'dialog' ? 'modal' : 'panel', 'version', options.helpOpen === true);
    return `<span class="zkapi-version-badge-group" data-zkapi-version-badge-group data-zkapi-version-surface="${surface}">`
        + `<span class="${classes}" data-zkapi-version-badge data-zkapi-version-tone="${tone}">${badge.label}</span>`
        + `${toggle}</span>`;
}

/**
 * What the `?` beside the pill opens: `{title, body}` (HTML, already escaped).
 * `kind` other than 'version' is unknown here and answers null. Without a
 * state the text is the one that is true of every multi-version build.
 */
export function versionHelp(kind, state = null, options = {}) {
    if (kind !== 'version') return null;
    return versionHelpDetail(state, options);
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

// A notice: { id, tone, paragraphs: [{html, text}], actions, closeByTs, tier,
// neutral, dismissible, dismissKey, clock }. An action: { action, label, kind:
// 'primary'|'secondary', disabled, hint }. `neutral` marks the day-0 "a newer
// version exists" note, which the ticket surface never carries.
// `dismissible` notices are hidden for the page's lifetime once dismissed,
// under `dismissKey` (the id unless the notice names what was dismissed).
// `clock` marks words that change as time passes without a deadline attribute.
function notice(id, tone, paragraphs, extra = {}) {
    const kept = paragraphs.filter(paragraph => paragraph && paragraph.html);
    if (!kept.length) return null;
    return {
        id,
        tone,
        paragraphs: kept,
        actions: extra.actions || [],
        closeByTs: extra.closeByTs ?? null,
        tier: extra.tier ?? null,
        neutral: extra.neutral === true,
        dismissible: extra.dismissible === true,
        dismissKey: typeof extra.dismissKey === 'string' && extra.dismissKey ? extra.dismissKey : id,
        clock: extra.clock === true
    };
}

const plainAction = (action, label, kind = 'primary') => ({ action, label, kind, disabled: false, hint: null });
const dismissAction = () => plainAction('dismiss', LABELS.dismiss, 'secondary');

function copyParagraph(key, tokens) {
    return { html: versionCopy(key, tokens), text: versionCopyText(key, tokens) };
}

function plainParagraph(text) {
    return { html: escapeHtml(text), text };
}

function reloadAction(state) {
    const canReload = state.reload?.canReload !== false;
    return {
        action: 'reload',
        label: LABELS.reload,
        kind: 'primary',
        disabled: !canReload,
        hint: canReload ? null : 'reload.busy'
    };
}

function upgradeAction(state, kind, label) {
    return { action: 'upgrade', label, kind, disabled: false, hint: null };
}

// The close-by notice a set-aside note on THIS version uses (no upgrade
// phase applies to it, but its deadline is the same one): the reminder tier's
// text, or the neutral note when no tier has started.
function deadlineKey(state) {
    const tier = state.reminderTier;
    if (typeof tier === 'number' && Number.isFinite(tier)) {
        return upgradeBannerKey({ phase: 'upgrade-soon', reminderTier: tier });
    }
    return finite(state.closeByTs) !== null ? 'banner.available' : null;
}

function withdrawingNotice(state, tokens) {
    const stage = state.upgrade?.stage;
    if (stage !== 'withdrawing' && stage !== 'confirming') return null;
    const onward = tokens.N ? `reload to deposit into version ${tokens.N}` : 'reload to deposit into the newer version';
    const text = stage === 'confirming'
        ? `Withdrawal submitted. It is waiting to be confirmed on Ethereum. Once it is, ${onward}.`
        : `Withdrawal in progress. Once it is confirmed, ${onward}.`;
    return notice('upgrading', 'info', [plainParagraph(text)]);
}

// The words of a reload, by what is certain. A reload reason is a fact about
// the wallet DATABASE, and an empty wallet looks the same whether a
// withdrawal finished, the balance expired and was archived, or another tab
// moved it, so the text claims only what the facts prove:
//   - "Withdrawal confirmed" (upgrade.withdrawn) needs the facade to say the
//     upgrade's withdrawal ended with payout evidence
//     (`options.withdrawalConfirmed === true`, supplied by ui.js). A bare
//     "withdrawing" intent is only "the review step was opened", and a balance
//     the treasury kept, or a closure nobody could verify, would read as
//     returned. A fact that is false OR missing says only that deposits moved
//   - "moved to version R in another tab ... saved in this browser" needs the
//     fresh read to have found a balance in the wallet; a read of an EMPTY
//     wallet (`options.previewReason` 'no_runtime_note') says only that
//     deposits moved
//   - an unused deposit quote that was cleared also says why Reload matters
function reloadNotice(state, tokens, options = {}) {
    const reason = state.reload?.reason;
    const movedOn = [copyParagraph('deposits.closed', tokens)];
    let paragraphs;
    switch (reason) {
        case 'upgrade_withdrawn':
            paragraphs = options.withdrawalConfirmed === true
                ? [copyParagraph('upgrade.withdrawn', tokens)] : movedOn;
            break;
        case 'moved_in_other_tab':
            paragraphs = options.previewReason === 'no_runtime_note'
                ? movedOn : [copyParagraph('reload.otherTab', tokens)];
            break;
        case 'draft_cleared':
            paragraphs = [copyParagraph('draft.cleared', tokens), ...movedOn];
            break;
        case 'previous_withdrawal_finished':
            paragraphs = movedOn;
            break;
        default:
            paragraphs = [copyParagraph('reload.otherTab', tokens)];
            break;
    }
    return notice('reload', 'attention', paragraphs, { actions: [reloadAction(state)] });
}

function previousNotice(state, tokens) {
    const previous = state.previous;
    const own = isRecord(previous) && previous.versionId === state.current?.id;
    if (own) {
        // The holder is this very version: a note set aside here. The words
        // are the deadline's, the controls are the withdrawal list's.
        const key = deadlineKey(state);
        if (!key) return null;
        // Outside every reminder tier this is the neutral note, not an alert.
        const neutral = key === 'banner.available';
        return notice('previous', neutral ? 'info' : 'attention', [copyParagraph(key, tokens)], {
            closeByTs: finite(state.closeByTs), tier: finite(state.reminderTier), neutral
        });
    }
    const actions = [];
    if (isRecord(previous) && previous.canOpen === true && tokens.P) {
        actions.push({
            action: 'open-previous',
            label: versionCopyText('previous.open', tokens),
            kind: 'primary',
            disabled: false,
            hint: null
        });
    }
    return notice('previous', 'attention', [copyParagraph('deposits.blocked.previous', tokens)], { actions });
}

function creditNotice(state, tokens) {
    const previous = state.previous;
    const actions = [];
    if (isRecord(previous) && previous.versionId !== state.current?.id && previous.canOpen === true && tokens.P) {
        actions.push({
            action: 'claim-credit',
            label: versionCopyText('previous.open', tokens),
            kind: 'primary',
            disabled: false,
            hint: null
        });
    }
    return notice('credit', 'info', [copyParagraph('previous.credit', tokens)], { actions });
}

function upgradeNotice(state, tokens) {
    const key = upgradeBannerKey(state);
    if (!key) return null;
    const available = state.phase === 'upgrade-available';
    const paragraphs = [copyParagraph(key, tokens)];
    const actions = [];
    const blockedBy = state.upgrade?.blockedBy ?? null;
    if (blockedBy === null) {
        actions.push(available
            ? upgradeAction(state, 'secondary', LABELS.upgradeNow)
            : upgradeAction(state, 'primary', LABELS.upgradeBalance));
    } else if (blockedBy === 'in_flight') {
        // Chats are still settling: the upgrade waits, it is not refused.
        actions.push({
            ...(available ? upgradeAction(state, 'secondary', LABELS.upgradeNow)
                : upgradeAction(state, 'primary', LABELS.upgradeBalance)),
            disabled: true,
            hint: 'reload.busy'
        });
    } else if (blockedBy === 'pending_deposit') {
        // A deposit that already started finishes first, on this version.
        paragraphs.push(copyParagraph('deposits.closed.started', tokens));
    }
    return notice('upgrade', available ? 'info' : 'attention', paragraphs, {
        actions, closeByTs: finite(state.closeByTs), tier: finite(state.reminderTier), neutral: available
    });
}

function gateNotice(state, tokens, options) {
    const gate = state.gate;
    const key = gateCopyKey(gate, { retired: options.retired === true });
    if (!key) return null;
    const paragraphs = [copyParagraph(key, tokens)];
    if (gate.code === 'deposits_closed' && gate.canResume === true) {
        paragraphs.push(copyParagraph('deposits.closed.started', tokens));
    }
    const actions = [];
    const retired = options.retired === true && gate.code === 'foreign_runtime';
    if (gateOffersReload(gate.code) && !retired) actions.push(reloadAction(state));
    return notice('gate', 'attention', paragraphs, { actions });
}

// The words that name the version an operator notice is about, for its
// reference line: the registry label when the table has one, else an id of the
// form "v2". An id that is neither is left out rather than shown raw.
function referenceVersion(table, versionId) {
    const row = Array.isArray(table) ? table.find(entry => isRecord(entry) && entry.id === versionId) : null;
    const label = row && typeof row.label === 'string' ? row.label.trim() : '';
    const named = label || (typeof versionId === 'string' && /^v\d+$/i.test(versionId) ? versionId : '');
    return { named, retired: Boolean(row && row.status === 'retired') };
}

// Operator text is plain text and never markup: bounded and escaped here, and
// patched as text content. An info notice with no action, one per operator
// notice that took effect (`state.notices`, see versionState.mjs).
//
// A note number is only meaningful beside its version (numbers repeat across
// versions), so the one place it is shown is a reference line under the
// operator's own words: "Reference number N for version V". It is shown by
// PRESENCE: the first note is number 0, which is a reference like any other.
function operatorNotices(state, options = {}) {
    const given = Array.isArray(state.notices) ? state.notices : [];
    const out = [];
    for (const entry of given) {
        if (out.length >= OPERATOR_NOTICE_LIMIT) break;
        if (!isRecord(entry) || typeof entry.text !== 'string') continue;
        const text = boundedOperatorText(entry.text);
        const html = safeOperatorText(entry.text);
        if (!text || !html) continue;
        const paragraphs = [{ html, text }];
        if (Number.isSafeInteger(entry.noteId) && entry.noteId >= 0) {
            const version = referenceVersion(options.table, entry.versionId);
            const tokens = { reference: entry.noteId };
            if (version.named) tokens.V = version.named;
            if (version.retired) tokens.retired = 1;
            const reference = copyParagraph('operator.reference', tokens);
            // Flagged: it comes and goes with a note number, so the block's
            // structure does not count it (the patch reconciles it itself).
            if (reference.html) paragraphs.push({ ...reference, reference: true });
        }
        const made = notice(`operator-${out.length}`, 'info', paragraphs);
        if (made) out.push(made);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Facts about the balance
// ---------------------------------------------------------------------------

// Another device or copy used this browser's balance after it was saved
// here, so a withdrawal from this browser would cost network fees and be
// rejected. Every notice whose job is to send the person to a withdrawal
// steps aside for the explanation.
const cannotWithdrawHere = state => state.exit?.deviceNotNewest === true;

// The balance is about to expire. Said once and plainly, with the one thing
// to do. It never speaks of upgrading: the version that takes deposits has
// nothing to upgrade to, and an older version's upgrade text is the upgrade
// notice's. A balance that is about to be given up is not told to withdraw,
// and one this browser can not withdraw is told why instead (`device`).
function nearNotice(state, tokens) {
    if (state.exit?.nearExpiry !== true || state.abandon?.available === true || cannotWithdrawHere(state)) return null;
    return notice('near', 'attention', [copyParagraph('near.balance', tokens)], {
        actions: [plainAction('open-withdraw', LABELS.withdraw)], clock: true
    });
}

// A refused withdrawal's wait, in the dialog where the withdrawal is. The
// buttons stay where they are: nothing here blocks an exit.
function waitNotice(state, tokens) {
    const wait = state.exit?.wait;
    if (!isRecord(wait) || cannotWithdrawHere(state)) return null;
    const key = wait.kind === 'settlement' ? 'exit.settlement'
        : wait.kind === 'proof' ? 'exit.proofWait'
            : wait.kind === 'release' ? 'exit.releasePending' : null;
    return key ? notice('wait', 'attention', [copyParagraph(key, tokens)], { clock: true }) : null;
}

function frozenNotice(state, tokens) {
    if (!isRecord(state.exit?.frozen) || cannotWithdrawHere(state)) return null;
    return notice('frozen', 'attention', [copyParagraph('exit.frozen', tokens)], {
        actions: [plainAction('open-withdraw', LABELS.withdraw)], clock: true
    });
}

// Another device or copy used the balance after this browser saved it. The
// explanation replaces the buttons that would be rejected; no in-app restore
// is promised (there is none). There is no Withdraw button: the text says a
// withdrawal from here would be rejected, and a button beside it would invite
// exactly that. A flagged set-aside balance lives in Payment history, which
// shows the same explanation on the row, so that is the one place to go.
function deviceNotice(state, tokens) {
    const slot = state.exit?.deviceNotNewest === true;
    const records = Number.isSafeInteger(state.setAside?.device) && state.setAside.device > 0;
    if (!slot && !records) return null;
    return notice('device', 'attention', [copyParagraph('exit.device', tokens)], {
        actions: records ? [plainAction('open-payments', LABELS.openPayments)] : []
    });
}

// A payout that came in under the disclosed bound. Persistent on the record
// row too; this notice may be dismissed for the page. No toast.
function payoutNotice(state, tokens) {
    const alerts = state.payouts?.alerts;
    if (!Number.isSafeInteger(alerts) || alerts <= 0) return null;
    return notice('payout', 'attention', [copyParagraph('payout.alert', tokens)], {
        actions: [plainAction('open-payments', LABELS.openPayments), dismissAction()],
        dismissible: true,
        dismissKey: dismissKeyFor('payout', state)
    });
}

// A payout the payment contract holds for the person. It is claimed from
// Payment history; it is never "returned" or "sent".
function claimNotice(state, tokens) {
    const credited = state.payouts?.credited;
    if (!Number.isSafeInteger(credited) || credited <= 0) return null;
    return notice('claim', 'attention', [copyParagraph('payout.notice', { ...tokens, count: credited })], {
        actions: [plainAction('open-payments', LABELS.openPayments)]
    });
}

function setAsideNotice(state, tokens) {
    const near = state.setAside?.near;
    if (!Number.isSafeInteger(near) || near <= 0) return null;
    return notice('setaside', 'attention', [copyParagraph('setAside.near', tokens)], {
        actions: [plainAction('open-payments', LABELS.openPayments)], clock: true
    });
}

// The exit kit prompt: never created, or created and not saved. A kit that is
// merely older than the latest chats is the balance card's quiet row. Nothing
// is asked for a balance this browser can not exit, one about to be cleared,
// or while the page must reload first.
function kitNotice(state, tokens) {
    const exit = state.exit;
    if (!isRecord(exit) || !isRecord(exit.kit)) return null;
    if (state.phase === 'reload-required' || state.abandon?.available === true || exit.deviceNotNewest === true) return null;
    if (exit.kit.unsaved === true) {
        return notice('kit', 'attention', [copyParagraph('kit.unsaved', tokens)], {
            actions: [plainAction('export-exit-kit', LABELS.createKit)]
        });
    }
    if (exit.kit.exported !== true) {
        return notice('kit', 'info', [copyParagraph('kit.never', tokens)], {
            actions: [plainAction('export-exit-kit', LABELS.createKit), dismissAction()],
            dismissible: true
        });
    }
    return null;
}

// An empty or very small balance on a version that no longer takes deposits.
// The facade's verdict (`state.abandon`) decides; the amounts are not in the
// state, so the words say "very small" and the dialog names the figure. An
// empty balance has nothing to withdraw, so only a balance with some value is
// offered the withdrawal instead.
function abandonNotice(state, tokens) {
    const abandon = state.abandon;
    if (!isRecord(abandon) || abandon.available !== true || state.phase === 'reload-required') return null;
    const zero = abandon.kind === 'zero';
    if (!zero && abandon.kind !== 'dust') return null;
    const actions = [plainAction('abandon-open', versionCopyText(zero ? 'abandon.linkZero' : 'abandon.link'))];
    if (!zero && state.upgrade?.available === true) {
        actions.push(plainAction('upgrade', LABELS.withdrawInstead, 'secondary'));
    }
    return notice('abandon', 'info', [copyParagraph(zero ? 'abandon.zero' : 'abandon.dust', tokens)], { actions });
}

function unsentNotice(state, tokens) {
    const canClear = state.reload?.canReload !== false;
    return notice('unsent', 'attention', [copyParagraph('unsent.explain', tokens)], {
        actions: [{
            action: 'cancel-unsent',
            label: versionCopyText('unsent.cancel', tokens),
            kind: 'primary',
            disabled: !canClear,
            hint: canClear ? null : 'reload.busy'
        }]
    });
}

// The primary notice of a phase. `null` for the phases that have nothing to
// say beyond what the existing balance UI already shows (current, expired).
function phaseNotice(state, tokens, options = {}) {
    switch (state.phase) {
        case 'reload-required':
            return reloadNotice(state, tokens, options);
        case 'legacy-unreachable':
            return notice('unreachable', 'attention', [copyParagraph('legacy.unreachable', tokens)], {
                actions: [reloadAction(state)]
            });
        case 'balance-unreachable':
            // The balance is here and its service is not available: the page
            // is loaded again to find out. Nothing is offered that needs the
            // SDK that did not start (no check, no upgrade, no withdrawal).
            return notice('held', 'attention', [copyParagraph('held.unreachable', tokens)], {
                actions: [reloadAction(state)]
            });
        case 'service-paused':
            // The service answers on its own time; "Check again" asks it now
            // (and only that: the exits stay open whatever it says).
            return notice('service', 'attention', [copyParagraph('service.paused', tokens)], {
                actions: [plainAction('check-service', versionCopyText('service.check'))]
            });
        case 'admission-closed': {
            const actions = [];
            if (state.upgrade?.available === true && state.upgrade.canStart === true) {
                actions.push(upgradeAction(state, 'primary', LABELS.upgradeBalance));
            }
            // A page on the deposit target itself (a stale tab, whose
            // successor has just launched) must not be sent to "deposit into
            // version N": N is the version that stopped starting chats.
            const words = { ...tokens };
            if (words.N !== undefined && words.N === words.F) delete words.N;
            return notice('admission', 'attention', [copyParagraph('admission.closed', words)], { actions });
        }
        case 'finish-previous-withdrawal':
            return previousNotice(state, tokens);
        case 'claim-previous-credit':
            return creditNotice(state, tokens);
        case 'withdrawing':
            return withdrawingNotice(state, tokens);
        case 'upgrade-available':
        case 'upgrade-soon':
        case 'upgrade-overdue':
            return upgradeNotice(state, tokens);
        default:
            break;
    }
    // Stages that live on the deposit target, after the upgrade's withdrawal.
    const stage = state.upgrade?.stage;
    if (stage === 'deposit') {
        // The stored upgrade lives 45 days, and a person who withdrew and does
        // not mean to deposit would be shown this on every page. Dismissing it
        // forgets the upgrade (handleVersionAction).
        return notice('deposit', 'info', [copyParagraph('upgrade.deposit', tokens)], {
            actions: [upgradeAction(state, 'primary', LABELS.continueUpgrade), dismissAction()],
            dismissible: true
        });
    }
    if (stage === 'done') {
        return notice('done', 'info', [copyParagraph('upgrade.done', tokens)], {
            actions: [dismissAction()],
            dismissible: true
        });
    }
    return null;
}

// Which gate codes a primary notice already explains (so the same fact is
// not said twice). Safety blocks are always explained, except next to a
// reload notice, which is itself the instruction to refresh.
function gateCovered(primary, code) {
    if (!primary) return false;
    switch (primary.id) {
        case 'reload':
        case 'unreachable':
        case 'held':
            return true;
        case 'previous':
            return code === 'previous_withdrawal_open';
        case 'upgrade':
        case 'admission':
        case 'deposit':
        case 'abandon':
            return code === 'deposits_closed';
        default:
            return false;
    }
}

/**
 * The notices a state calls for, in display order, and a signature of their
 * structure (ids, tones, action states). Text is not part of the signature:
 * a text change is patched in place, a structural change re-renders.
 *
 * `options`: `surface`, `table` (registry labels for "version P/R"),
 * `formatter` (dates), `now` and `formatAmount` (the page's clock and money
 * words: an instant that has passed is left out of a sentence, and a bound is
 * said in the page's money), `retired` (a retired deployment holds the slot),
 * `flags` ({draftDiscarded, discardLoop}), `dismissed`, and two facts a
 * VersionState lacks that make a reload's words exact: `withdrawalConfirmed`
 * (the upgrade intent shows the withdrawal ended) and `previewReason` (what
 * the freshest read of the wallet found).
 *
 * @param {object} state VersionState
 * @returns {{notices: object[], signature: string}}
 */
export function buildVersionNotices(state, options = {}) {
    const surface = surfaceOf(options.surface);
    const empty = { notices: [], signature: '' };
    if (!isRecord(state) || !isRecord(state.gate) || !isRecord(state.current)) return empty;
    const tokens = copyTokens(state, {
        formatter: options.formatter, table: options.table, formatAmount: options.formatAmount, now: options.now
    });
    const flags = isRecord(options.flags) ? options.flags : {};
    const list = [];

    let primary = phaseNotice(state, tokens, options);
    // A balance set aside on THIS version and close to its deadline would be
    // told twice: by the previous-withdrawal notice, in the words of an
    // upgrade deadline, and by its own. The ticket surface has no
    // `setaside` notice, so it keeps the one it had.
    const setAside = setAsideNotice(state, tokens);
    let setAsidePlaced = false;
    if (setAside && surface !== 'ticket' && primary && primary.id === 'previous'
        && state.previous?.versionId === state.current.id) {
        primary = setAside;
        setAsidePlaced = true;
    }
    // Giving up an empty or very small balance replaces the upgrade prompt
    // (which would send the person to a withdrawal that costs a network fee,
    // maybe more than the balance). The ticket surface has no dialog to give
    // up from, so it keeps the upgrade prompt as it was.
    const abandon = surface === 'ticket' ? null : abandonNotice(state, tokens);
    let abandonPlaced = false;
    if (abandon && (!primary || primary.id === 'upgrade')) {
        primary = abandon;
        abandonPlaced = true;
    }
    if (primary) list.push(primary);

    // The deposit gate, when nothing above already explains it.
    if (state.gate.canStart !== true) {
        const safetyBlock = gateOffersReload(state.gate.code);
        if (!gateCovered(primary, state.gate.code) && (safetyBlock || !primary)) {
            const gate = gateNotice(state, tokens, options);
            if (gate) list.push(gate);
        }
    }
    // The balance's own facts, most urgent first. None of them is a phase.
    // A balance the page holds and can not read has none of them (they all
    // come from the SDK's snapshot, which did not start), and every action
    // they carry needs the SDK: it is said only by the `held` notice above.
    const facts = state.held?.unreachable === true ? [] : [
        nearNotice(state, tokens), waitNotice(state, tokens), frozenNotice(state, tokens),
        deviceNotice(state, tokens), payoutNotice(state, tokens), claimNotice(state, tokens),
        setAsidePlaced ? null : setAside, abandonPlaced ? null : abandon, kitNotice(state, tokens)
    ];
    facts.forEach(entry => { if (entry) list.push(entry); });
    // What the operator said about a withdrawal that is covered: the notice
    // is why a deposit may start although another version's escape is still
    // pending, so the holder it applies to is told what it says (the state
    // carries only the notices that matched a record this browser holds).
    operatorNotices(state, options).forEach(entry => list.push(entry));
    // A deposit quote or plan that was never sent, pinning this version.
    if (state.unsent === true && state.phase !== 'reload-required') {
        const unsent = unsentNotice(state, tokens);
        if (unsent) list.push(unsent);
    }
    if (flags.draftDiscarded === true && state.phase !== 'reload-required' && !isDismissed('draft', options)) {
        const draft = notice('draft', 'info', [copyParagraph('draft.cleared', tokens)], {
            actions: [dismissAction()]
        });
        if (draft) list.push(draft);
    }
    if (flags.discardLoop === true) {
        const loop = notice('loop', 'attention', [copyParagraph('discard.loop', tokens)]);
        if (loop) list.push(loop);
    }

    const visible = list.filter(entry => {
        if (entry.dismissible && (isDismissed(entry.id, options) || isDismissed(entry.dismissKey, options))) return false;
        // A refused withdrawal's wait is told where the withdrawal is.
        if (DIALOG_ONLY_NOTICES.has(entry.id) && surface !== 'dialog') return false;
        if (surface === 'ticket') {
            if (!TICKET_NOTICES.has(entry.id)) return false;
            // A neutral note is not worth a place in a different mode.
            if (entry.neutral) return false;
        }
        return true;
    });
    // The paragraph count is structure too: a patch writes text into the
    // paragraphs that exist, so one that is added or dropped is a render. A
    // reference line is the exception: patchVersionNotices adds nothing and
    // takes it away in place, so it is not counted.
    const signature = visible.map(entry => [
        entry.id, entry.tone, entry.paragraphs.filter(paragraph => paragraph.reference !== true).length,
        entry.actions.map(action => `${action.action}${action.disabled ? '!' : ''}`).join(',')
    ].join(':')).join('|');
    return { notices: visible, signature };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// What a rendered block records about its structure: its notices' signature
// and whether host markup (`extra`) follows them.
function blockSignature(signature, extra) {
    return extra ? `${signature}|+` : signature;
}

// A short digest of the host markup (FNV-1a, 32 bits), recorded beside the
// signature: a clock tick patches notice TEXT, but markup the host changed
// (an exit kit status that moved on) is not text the patch knows, so a block
// whose markup differs from what is on the page is replaced as a whole. ''
// for no markup, so a block without any carries no attribute.
function extraDigest(extra) {
    if (!extra) return '';
    let hash = 0x811c9dc5;
    for (let index = 0; index < extra.length; index += 1) {
        hash = Math.imul(hash ^ extra.charCodeAt(index), 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

// A disabled button says why in visible text (a title is no help on a phone)
// and points at it, so a screen reader hears the same reason.
function renderAction(action, hintId) {
    const kind = action.kind === 'primary' ? 'primary' : 'secondary';
    const hint = action.disabled && action.hint ? versionCopy(action.hint) : '';
    return `<button type="button" class="zkapi-version-action zkapi-version-action--${kind}"`
        + ` data-zkapi-version-action="${escapeHtml(action.action)}"`
        + `${action.disabled ? ' disabled' : ''}${hint ? ` aria-describedby="${hintId}"` : ''}>`
        + `${escapeHtml(action.label)}</button>`
        + (hint ? `<span id="${hintId}" class="zkapi-version-notice-hint">${hint}</span>` : '');
}

function renderNotice(entry, surface) {
    const classes = `zkapi-version-notice zkapi-version-notice--${entry.tone} rounded-lg border ${NOTICE_TONES[entry.tone] || NOTICE_TONES.info}`;
    const deadline = entry.closeByTs === null ? ''
        : ` data-zkapi-version-closeby="${entry.closeByTs}" data-zkapi-version-tier="${entry.tier === null ? 'none' : entry.tier}"`;
    const paragraphs = entry.paragraphs.map((paragraph, index) => (
        `<p class="zkapi-version-notice-text" data-zkapi-version-text="${index}"`
        + `${paragraph.reference === true ? ' data-zkapi-version-reference' : ''}${index === 0 ? deadline : ''}>${paragraph.html}</p>`
    )).join('');
    const hintId = `zkapi-version-hint-${surface}-${entry.id}`;
    const actions = entry.actions.length
        ? `<div class="zkapi-version-notice-actions">${entry.actions.map(action => renderAction(action, hintId)).join('')}</div>` : '';
    return `<div class="${classes}" data-zkapi-version-notice="${escapeHtml(entry.id)}" data-zkapi-version-tone="${entry.tone}"`
        + `${entry.clock ? ' data-zkapi-version-clock' : ''}>${paragraphs}${actions}</div>`;
}

/**
 * The version notices of a surface as one static block, or ''.
 *
 * Surfaces: 'panel' (System Panel), 'dialog' (balance dialog, after the
 * balance card) and 'ticket' (OA mode, where only at-risk funds reach).
 * `now` (the page's clock) and `formatAmount` (units to the page's money
 * words) are read by the words: an instant that has passed is left out of a
 * sentence, a retry is counted from `now`, and a bound is said in money. A
 * caller that passes neither gets the sentences without those parts.
 *
 * `extra` is trusted markup from the host (`ui.protocolNotices()`), placed
 * after the notices inside the same block.
 *
 * @param {object} state VersionState
 * @param {{surface?: string, now?: number, table?: object[], formatter?: Function,
 *   retired?: boolean, flags?: object, dismissed?: Set<string>|string[], extra?: string}} [options]
 */
export function renderVersionBanner(state, options = {}) {
    const surface = surfaceOf(options.surface);
    const { notices, signature } = buildVersionNotices(state, { ...options, surface });
    const extra = typeof options.extra === 'string' ? options.extra : '';
    if (!notices.length && !extra) return '';
    const digest = extraDigest(extra);
    return `<div class="zkapi-version-banner zkapi-version-banner--${surface}" data-zkapi-version-banner="${surface}"`
        + ` data-zkapi-version-sig="${escapeHtml(blockSignature(signature, extra))}"`
        + `${digest ? ` data-zkapi-version-extra="${digest}"` : ''}>`
        + `${notices.map(entry => renderNotice(entry, surface)).join('')}${extra}</div>`;
}

// ---------------------------------------------------------------------------
// Clock patch
// ---------------------------------------------------------------------------

function elements(root, selector) {
    if (!root) return [];
    if (typeof root.querySelectorAll === 'function') return [...root.querySelectorAll(selector)];
    const one = typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
    return one ? [one] : [];
}

function setIfChanged(element, text) {
    if (element && element.textContent !== text) element.textContent = text;
}

/**
 * Bring what a clock tick can change up to date, as text only.
 *
 * Nothing in the words moves with the second hand (dates are absolute), so a
 * tick changes something only when a boundary was crossed: a reminder tier,
 * the prompt window, the close-by instant, expiry. A change in structure
 * (which notices exist, their tone, their buttons) is reported as
 * `needsRender` and NOTHING is touched, so the caller replaces the markup
 * once. A change in wording alone (a new close-by after a refresh) and the
 * pill's tone are patched in place.
 *
 * @param {Element|object} root a container holding the pill and/or banners
 * @param {object} state VersionState read for this tick
 * @param {{now?: number, surface?: string, table?: object[], formatter?: Function,
 *   retired?: boolean, flags?: object, dismissed?: Set<string>|string[], extra?: string}} [options]
 * @returns {{needsRender: boolean}}
 */
export function patchVersionNotices(root, state, options = {}) {
    const outcome = { needsRender: false };
    if (!root || (typeof root.querySelectorAll !== 'function' && typeof root.querySelector !== 'function')) {
        return outcome;
    }
    const badges = elements(root, '[data-zkapi-version-badge]');
    const banners = elements(root, '[data-zkapi-version-banner]');
    const badge = badgeModel(state);
    if (Boolean(badge) !== badges.length > 0) return { needsRender: true };

    const extra = typeof options.extra === 'string' ? options.extra : '';
    if (!banners.length) {
        // Nothing mounted: a banner the state calls for needs a render.
        const wanted = buildVersionNotices(state, { ...options, surface: surfaceOf(options.surface) });
        if (wanted.notices.length || extra) return { needsRender: true };
    }
    const models = banners.map(element => {
        const surface = surfaceOf(element.dataset?.zkapiVersionBanner);
        return { element, model: buildVersionNotices(state, { ...options, surface }) };
    });
    for (const { element, model } of models) {
        // A block the state no longer calls for, or one whose notices,
        // tones or buttons differ, is replaced by the caller as a whole.
        const rendered = element.dataset?.zkapiVersionSig;
        const renderedExtra = element.dataset?.zkapiVersionExtra ?? '';
        if (blockSignature(model.signature, extra) !== rendered || (!model.notices.length && !extra)
            || extraDigest(extra) !== renderedExtra) {
            return { needsRender: true };
        }
    }

    // Every paragraph the state has must be on the page to be patched, and
    // any the page has beyond them must be a reference line. Checked before
    // anything is touched, so a render that is asked for finds the page as it
    // was.
    const holders = new Map();
    for (const { element, model } of models) {
        for (const entry of model.notices) {
            const holder = elements(element, '[data-zkapi-version-notice]')
                .find(candidate => candidate.dataset?.zkapiVersionNotice === entry.id);
            if (!holder) return { needsRender: true };
            const texts = elements(holder, '[data-zkapi-version-text]');
            if (entry.paragraphs.some((paragraph, index) => !texts[index])) return { needsRender: true };
            if (texts.slice(entry.paragraphs.length).some(extra => extra.dataset?.zkapiVersionReference === undefined)) {
                return { needsRender: true };
            }
            holders.set(entry, texts);
        }
    }

    // Structure matches: patch.
    if (badge) {
        const element = badges[0];
        const tone = badge.amber ? 'amber' : 'muted';
        setIfChanged(element, badge.text);
        if (element.dataset && element.dataset.zkapiVersionTone !== tone) {
            element.dataset.zkapiVersionTone = tone;
            const off = badge.amber ? PILL_TONES.muted : PILL_TONES.amber;
            const on = badge.amber ? PILL_TONES.amber : PILL_TONES.muted;
            for (const name of off) element.classList?.toggle?.(name, false);
            for (const name of on) element.classList?.toggle?.(name, true);
        }
    }
    for (const { model } of models) {
        for (const entry of model.notices) {
            const texts = holders.get(entry) || [];
            entry.paragraphs.forEach((paragraph, index) => {
                const target = texts[index];
                setIfChanged(target, paragraph.text);
                if (index === 0 && entry.closeByTs !== null && target.dataset) {
                    target.dataset.zkapiVersionCloseby = String(entry.closeByTs);
                    target.dataset.zkapiVersionTier = entry.tier === null ? 'none' : String(entry.tier);
                }
            });
            // A reference line the state no longer has (no note number) is
            // taken away, not left saying a number that is not there.
            texts.slice(entry.paragraphs.length).forEach(extra => {
                if (typeof extra.remove === 'function') extra.remove();
                else setIfChanged(extra, '');
            });
        }
    }
    return outcome;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function defaultDispatch(name, detail) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function'
        || typeof CustomEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent(name, { detail }));
}

function defaultReload() {
    globalThis.location?.reload?.();
}

function switchFailure(result) {
    if (result.why === 'busy') return versionCopyText('reload.busy');
    if (result.why === 'loop') return versionCopyText('discard.loop');
    return '';
}

/**
 * Do what a version button asks. Every path is one user gesture; none
 * signs, withdraws or deposits.
 *
 *   upgrade        open the upgrade view (`zkapi-payment-required`, view
 *                  'upgrade'); the dialog owns the steps
 *   reload         reload into the build the next boot selects, through the
 *                  facade (loop-guarded, refused while work is in flight);
 *                  with no switch reason a plain reload, still gated by
 *                  `reload.canReload`. `upgrade_withdrawn` is sent only
 *                  when the facade says the withdrawal ended with payout
 *                  evidence (`facts().withdrawalConfirmed === true`; a fact
 *                  that is false or unknown sends the neutral
 *                  `previous_withdrawal_finished`): it makes the facade
 *                  record "withdrawn", which the next page then tells the
 *                  person as fact
 *   open-previous  reload into the previous version to finish its withdrawal
 *   claim-credit   reload into the previous version to claim its payout
 *   cancel-unsent  discard a never-sent deposit quote or plan
 *   dismiss        hide a dismissible notice until the page reloads; the
 *                  deposit step's notice also forgets the upgrade it belongs
 *                  to (`facade.abandonUpgrade()`), so it does not return
 *   check-service  ask the service again now (`facade.recheckService()`).
 *                  A page whose runtime can not be asked reloads instead
 *                  (gated by `reload.canReload`); a service that is still
 *                  paused is said in a toast and nothing else changes
 *   open-withdraw  open the dialog's Withdraw view
 *   open-payments  open the dialog's Payment history
 *                  (both are the `zkapi-payment-required` event)
 *   export-exit-kit  the exit kit dialog (ExitKitDialog.js), through
 *                  `facade.exportExitKit`; afterwards the facade is told
 *                  whether the file's download was started
 *                  (`facade.noteKitSaved`)
 *   abandon-open   the give-up dialog (AbandonDialog.js), through
 *                  `facade.abandonPreview` and `facade.giveUpBalance`
 *
 * @param {string} action
 * @param {{facade?: object, state?: object|null, surface?: string, noticeId?: string,
 *   dispatch?: Function, reload?: Function, notify?: (text: string) => void,
 *   refresh?: () => void, withdrawalConfirmed?: boolean, doc?: Document,
 *   openExitKit?: Function, openAbandon?: Function}} [context]
 *   `withdrawalConfirmed` overrides what `facade.ui.facts()` (and, without
 *   it, `facade.flags()`) says. `doc`, `openExitKit` and `openAbandon` are
 *   for tests: the document the dialogs are placed in and their openers
 * @returns {Promise<{ok: boolean, why?: string}>}
 */
export async function handleVersionAction(action, context = {}) {
    const {
        facade = null, surface = 'panel', noticeId = null,
        dispatch = defaultDispatch, reload = defaultReload, notify = () => {}, refresh = () => {}
    } = context;
    const read = () => {
        if (isRecord(context.state)) return context.state;
        try {
            return facade && typeof facade.state === 'function' ? facade.state() : null;
        } catch {
            return null;
        }
    };
    // true / false when the facade could say whether the upgrade's withdrawal
    // ended with payout evidence, undefined when it could not. Only `true`
    // keeps the claim; the rest is the neutral reason.
    const withdrawalConfirmed = () => {
        if (typeof context.withdrawalConfirmed === 'boolean') return context.withdrawalConfirmed;
        try {
            const ui = facade ? facade.ui : null;
            const facts = ui && typeof ui.facts === 'function' ? ui.facts() : null;
            if (isRecord(facts) && typeof facts.withdrawalConfirmed === 'boolean') return facts.withdrawalConfirmed;
            // The helpers carry no facts: the facade's own flag says the same.
            const flags = facade && typeof facade.flags === 'function' ? facade.flags() : null;
            return isRecord(flags) && typeof flags.withdrawalConfirmed === 'boolean'
                ? flags.withdrawalConfirmed : undefined;
        } catch {
            return undefined;
        }
    };
    try {
        switch (action) {
            case 'upgrade':
                dispatch('zkapi-payment-required', { view: 'upgrade' });
                return { ok: true };
            case 'reload': {
                const state = read();
                if (state && state.reload && state.reload.canReload === false) {
                    notify(versionCopyText('reload.busy'));
                    return { ok: false, why: 'busy' };
                }
                let reason = state && state.reload && state.reload.required === true ? state.reload.reason : null;
                // Not shown to have ended: no withdrawal is recorded and the
                // person lands on the ordinary deposit page of the target.
                if (reason === 'upgrade_withdrawn' && withdrawalConfirmed() !== true) {
                    reason = 'previous_withdrawal_finished';
                }
                if (reason && facade && typeof facade.requestSwitch === 'function') {
                    // After an upgrade's withdrawal the next thing the person
                    // does is deposit, so the fund view is where they land;
                    // OA mode never has a dialog opened for it.
                    const view = surface !== 'ticket' && reason === 'upgrade_withdrawn' ? 'fund' : null;
                    const result = facade.requestSwitch({ reason, view });
                    if (!result.ok) {
                        const text = switchFailure(result);
                        if (text) notify(text);
                        else reload();
                    }
                    return result.ok ? result : { ok: result.why === 'no_target', why: result.why };
                }
                reload();
                return { ok: true };
            }
            case 'open-previous':
            case 'claim-credit': {
                if (!facade || typeof facade.requestSwitch !== 'function') return { ok: false, why: 'no_target' };
                const result = facade.requestSwitch({
                    reason: action === 'open-previous' ? 'finish_previous' : 'claim_credit',
                    view: surface === 'ticket' ? null : 'withdrawals'
                });
                if (!result.ok) {
                    const text = switchFailure(result);
                    if (text) notify(text);
                }
                return result;
            }
            case 'cancel-unsent': {
                if (!facade || typeof facade.discardUnsentDeposit !== 'function') return { ok: false, why: 'unavailable' };
                const result = await facade.discardUnsentDeposit();
                if (!result || result.discarded !== true) {
                    // Busy and "another tab holds the wallet" are different
                    // fixes; both are said in words a person can act on.
                    notify(versionCopyText(result?.why === 'busy' ? 'reload.busy' : 'discard.loop'));
                    return { ok: false, why: result?.why || 'failed' };
                }
                return { ok: true };
            }
            case 'dismiss':
                // The deposit step's notice outlives this page (the upgrade
                // intent is stored for 45 days): dismissing it forgets the
                // upgrade, not only this page's view of it. The page-lifetime
                // dismissal below is what hides it at once on every surface.
                if (noticeId === 'deposit' && facade && typeof facade.abandonUpgrade === 'function') {
                    try {
                        facade.abandonUpgrade();
                    } catch { /* the click still hides the notice for this page */ }
                }
                dismissVersionNotice(dismissKeyFor(noticeId, read()));
                refresh();
                return { ok: true };
            case 'check-service': {
                // Without a runtime that can be asked, the only way to learn
                // is a fresh page; never while work is in flight.
                const reloadInstead = () => {
                    const state = read();
                    if (state && state.reload && state.reload.canReload === false) {
                        notify(versionCopyText('reload.busy'));
                        return { ok: false, why: 'busy' };
                    }
                    reload();
                    return { ok: true, why: 'reloaded' };
                };
                if (!facade || typeof facade.recheckService !== 'function') return reloadInstead();
                let answer;
                try {
                    answer = await facade.recheckService();
                } catch {
                    answer = { ok: false, why: 'still_unavailable' };
                }
                if (isRecord(answer) && answer.ok === true) {
                    refresh();
                    return { ok: true };
                }
                const why = isRecord(answer) ? answer.why : null;
                if (why === 'unavailable') return reloadInstead();
                if (why === 'busy') {
                    notify(versionCopyText('reload.busy'));
                    return { ok: false, why: 'busy' };
                }
                notify(versionCopyText('service.stillPaused'));
                return { ok: false, why: 'still_unavailable' };
            }
            case 'open-withdraw':
                dispatch('zkapi-payment-required', { view: 'withdraw' });
                return { ok: true };
            case 'open-payments':
                dispatch('zkapi-payment-required', { view: 'withdrawals' });
                return { ok: true };
            case 'export-exit-kit': {
                if (!facade || typeof facade.exportExitKit !== 'function') {
                    notify(EXIT_KIT_WORDS.unavailable);
                    return { ok: false, why: 'unavailable' };
                }
                const opener = typeof context.openExitKit === 'function' ? context.openExitKit : openExitKitDialog;
                // Dialogs are numbered as they open: a dialog that was closed
                // mid-export reports only after the SDK answers, which can be
                // after a newer one saved a kit.
                kitDialogsOpened += 1;
                const opened = kitDialogsOpened;
                const dialog = opener({ exportKit: passphrase => facade.exportExitKit(passphrase), doc: context.doc });
                const outcome = await dialog.result;
                const saved = isRecord(outcome) && outcome.saved === true;
                if (saved) kitSavedBy = Math.max(kitSavedBy, opened);
                // A kit the SDK made and the person did not save is said on
                // the notice until one is: the SDK counts it as exported the
                // moment it exists, so the host remembers the rest. Only a
                // dialog that says nothing was made (`created: false`, the
                // person cancelled first) leaves the notice as it was. A late
                // "not saved" from an older dialog never overrides a newer
                // dialog's saved kit.
                const created = isRecord(outcome) && outcome.created !== false;
                const supersededBySaved = !saved && kitSavedBy > opened;
                if ((saved || created) && !supersededBySaved && typeof facade.noteKitSaved === 'function') {
                    try {
                        facade.noteKitSaved(saved);
                    } catch { /* the notice just keeps its last words */ }
                }
                refresh();
                return saved ? { ok: true } : { ok: false, why: 'not_saved' };
            }
            case 'abandon-open': {
                let preview = null;
                try {
                    preview = facade && typeof facade.abandonPreview === 'function' ? facade.abandonPreview() : null;
                } catch {
                    preview = null;
                }
                if (!preview || !facade || typeof facade.giveUpBalance !== 'function') {
                    notify(ABANDON_WORDS.unavailable);
                    refresh();
                    return { ok: false, why: 'unavailable' };
                }
                const opener = typeof context.openAbandon === 'function' ? context.openAbandon : openAbandonDialog;
                const dialog = opener({
                    preview,
                    giveUp: args => facade.giveUpBalance(args),
                    // After a give-up the facade's own state says where a
                    // reload goes; the state of the click is not read again.
                    reload: () => {
                        void handleVersionAction('reload', { facade, surface, dispatch, reload, notify, refresh });
                    },
                    doc: context.doc
                });
                const outcome = await dialog.result;
                refresh();
                return outcome && outcome.done === true ? { ok: true } : { ok: false, why: outcome?.why || 'cancelled' };
            }
            default:
                return { ok: false, why: 'unknown_action' };
        }
    } catch {
        return { ok: false, why: 'failed' };
    }
}

// How many exit kit dialogs this page has opened, and the newest one that
// started a download. Memory only.
let kitDialogsOpened = 0;
let kitSavedBy = 0;

const bound = new WeakSet();

/**
 * Wire `[data-zkapi-version-action]` buttons inside every version banner under
 * `root` by delegation on the banner element. A banner element that is kept
 * and refilled (the keyed ticket notice) is bound once.
 *
 * @param {Element} root
 * @param {{facade?: object|(() => object|null), notify?: Function, dispatch?: Function,
 *   reload?: Function, refresh?: Function}} [context]
 */
export function attachVersionNotices(root, context = {}) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    for (const banner of root.querySelectorAll('[data-zkapi-version-banner]')) {
        if (bound.has(banner)) continue;
        bound.add(banner);
        banner.addEventListener('click', event => {
            const button = event.target?.closest?.('[data-zkapi-version-action]');
            if (!button || button.disabled || (banner.contains && !banner.contains(button))) return;
            const holder = button.closest?.('[data-zkapi-version-notice]');
            const facade = typeof context.facade === 'function' ? context.facade() : context.facade;
            void handleVersionAction(button.dataset?.zkapiVersionAction, {
                facade,
                surface: banner.dataset?.zkapiVersionBanner,
                noticeId: holder?.dataset?.zkapiVersionNotice,
                notify: context.notify,
                dispatch: context.dispatch,
                reload: context.reload,
                refresh: context.refresh
            });
        });
    }
}
