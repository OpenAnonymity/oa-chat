// Guided upgrade and deposits-closed views (docs/ZKAPI_VERSIONING.md,
// "Upgrade UX").
//
// Pure string renderers: no DOM, no storage, no clock, no facade import. The
// account dialog owns state and handlers; it hands this module a VersionState
// (versioning/versionState.mjs) plus a few presentation facts and gets markup
// back, composed into `zkapiClient.oaVersioning.ui` by versioning/ui.js.
//
// Every wallet step stays the dialog's own, existing one: the withdrawal is the
// existing withdrawal markup (`ctx.withdrawalHtml`, whose button is
// `#zkapi-withdraw-btn`), and the deposit is the dialog's ordinary fund flow.
// This module only narrates the steps, explains what each costs and links the
// person to the next one. It never signs, deposits, withdraws or reloads; its
// buttons carry `data-zkapi-version-action` hooks that the dialog turns into
// facade calls on a click.
//
// DOM hooks, stable for tests and CSS:
//   [data-zkapi-upgrade-view]                 root of the upgrade view
//   [data-upgrade-step="withdraw|reload|deposit"]
//   input[name="zkapi-upgrade-destination"]   values connected|new-address|other
//   [data-zkapi-version-action="upgrade|reload|open-previous|claim-credit|cancel-unsent|dismiss"]
// Additive hooks: [data-upgrade-stage], [data-zkapi-deposits-closed],
// [data-zkapi-gate-code], [data-upgrade-new-address] (explicit address
// creation), [data-upgrade-reload], [data-upgrade-gas],
// [data-upgrade-blocked="previous"] (another version's withdrawal, with its
// "Open version N" button) and [data-zkapi-closed-previous] (see below).
// [data-zkapi-balance-held] (with [data-zkapi-held-text]) is the view of a
// balance this browser holds and the page cannot read (`state.held`); see
// renderHeldBalanceView.
//
// Presentation facts the dialog passes besides the state (all optional):
// `withdrawalConfirmed` and `previewReason` (what ui.facts() reads, so a
// reload's words claim only what is certain; "Withdrawal confirmed" is said
// only for `withdrawalConfirmed === true`, never for a missing fact),
// `outcomeHtml` (the dialog's own one-line result of the last button, trusted
// markup), `unsentCleared` (the unfinished deposit was just discarded; the
// state catches up a moment later) and `draftClearedHere` (the person did
// that, so the reload's words do not say again that a quote was cleared).
//
// A view that says another version's unfinished withdrawal in full marks that
// paragraph `data-zkapi-closed-previous`; the dialog reads the mark, not an
// assumption, to decide whether its own `previous` banner would only repeat it.
import { upgradeStepStates } from '../versioning/upgradeFlow.mjs';
import {
    copyTokens, escapeHtml, gateCopyKey, gateOffersReload, upgradeBannerKey, versionCopy
} from '../versioning/copy.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const STAGES = new Set(['idle', 'review', 'withdrawing', 'confirming', 'ready_to_switch', 'deposit', 'done', 'blocked']);
// Blocked reasons whose withdrawal markup still has something to act on. A
// claimed balance, an unsent plan or a started deposit have nothing to withdraw.
const WITHDRAWABLE_BLOCKS = new Set(['expired', 'open_withdrawal', 'in_flight']);
const CHECK_MARK = '<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"/></svg>';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Words that belong to these two views alone. Shared version copy stays in
// versioning/copy.mjs; these are the sentences with no other home.
// ---------------------------------------------------------------------------

const WORDS = Object.freeze({
    destinationLegend: 'Where your balance goes',
    createAddress: 'Create address',
    creatingAddress: 'Creating address…',
    otherLabel: 'Address that receives the withdrawal',
    gasEmpty: 'This browser’s funding address has no ETH to pay the withdrawal fee. Send some ETH to it first.',
    confirming: 'Your withdrawal was submitted and is waiting for Ethereum to confirm it. This page checks on its own. You do not need to do anything.',
    sepoliaAgain: 'After the page reloads you enter the test network password again.',
    leftoverEth: 'Any ETH left at this version’s funding address is still yours. You can return it above, or move it after you reload.',
    expired: 'This balance has expired. You can still try withdrawing while it remains unclaimed.',
    claimed: 'This balance was claimed after expiry. No refund was made.',
    inFlight: 'A chat key is still settling. Withdrawing settles it first, so this can take a moment.',
    pendingDeposit: 'Finish your deposit first. It can still be completed on {F}.',
    openWithdrawal: 'Finish the withdrawal that is already in progress first.',
    depositsWait: ' Deposits to {N} wait until it finishes.',
    nothingToUpgrade: 'There is nothing to upgrade right now.',
    checkingNext: 'Withdrawal confirmed. Checking whether {N} is ready to load…',
    checkingNextUnproven: 'Checking whether {N} is ready to load…',
    backToBalance: 'Back to balance',
    stepDetail: Object.freeze({
        review: 'Return your balance to your wallet.',
        withdrawing: 'Waiting for the withdrawal.',
        confirming: 'Waiting for Ethereum to confirm.',
        reload: 'Reload to open {N}.',
        deposit: 'Add funds to {N}.'
    }),
    // Heading of the closed view, by the reason deposits cannot start.
    closed: Object.freeze({
        deposits_closed: 'Deposits have moved',
        noTarget: 'Deposits are closed',
        unsent: 'Unfinished deposit',
        previous_withdrawal_open: 'A withdrawal is still finishing',
        holdings_unreadable: 'Your saved balance could not be read',
        foreign_runtime: 'This browser’s balance can’t be opened here',
        retired: 'This balance is from a retired version',
        config_mismatch: 'Reload to update',
        stale_build: 'Reload to update',
        version_unavailable: 'zkAPI is unavailable in this tab',
        fallback: 'Deposits are paused'
    })
});

// "version 2" after a word: the registry label with the leading word dropped.
function versionNumber(ref) {
    if (!isRecord(ref)) return '';
    const label = typeof ref.label === 'string' ? ref.label : '';
    const name = label.replace(/^\s*version\s+/i, '').trim() || (typeof ref.id === 'string' ? ref.id : '');
    const match = /^v(\d+)$/i.exec(name);
    return match ? match[1] : name;
}

function versionPhrase(ref, fallback) {
    const name = versionNumber(ref);
    return name ? `version ${escapeHtml(name)}` : fallback;
}

function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : ''));
}

// The first sentence and the rest of a text that is one or two sentences, for
// a label with a quieter second line. A text with no break keeps all in `head`.
function splitSentence(text) {
    const at = text.indexOf('. ');
    if (at < 0) return { head: text.replace(/\.$/, ''), tail: '' };
    return { head: text.slice(0, at), tail: text.slice(at + 2) };
}

function formatterOf(ctx) {
    return typeof ctx.formatter === 'function' || isRecord(ctx.formatter) ? ctx.formatter : null;
}

function tokensFor(ctx, state) {
    const tokens = copyTokens(state, { formatter: formatterOf(ctx), table: Array.isArray(ctx.table) ? ctx.table : null });
    if (ctx.sepolia === true) tokens.sepolia = 1;
    return tokens;
}

function actionButton(action, label, { primary = false, disabled = false, describedBy = '' } = {}) {
    return `<button type="button" class="${primary ? 'zkapi-primary-button' : 'zkapi-secondary-button'} w-full" data-zkapi-version-action="${action}"${disabled ? ' disabled' : ''}${disabled && describedBy ? ` aria-describedby="${describedBy}"` : ''}>${label}</button>`;
}

// What a reload is for, by what is certain: the words of the version notice
// (VersionNotices.js, `reloadNotice`) for the same reasons.
//   - "Withdrawal confirmed ... back in your wallet" needs the facade to say
//     the upgrade's withdrawal ended WITH payout evidence
//     (`withdrawalConfirmed === true`). A balance that expired and was
//     archived, one the treasury claimed and a closure the SDK could not
//     verify all leave the same empty wallet, so a fact that is false or
//     missing says only that deposits moved
//   - "moved to version R in another tab" needs the fresh read to have found a
//     balance in the wallet (`previewReason` is not 'no_runtime_note')
//   - an unused deposit quote that was cleared says so
function reloadWords(state, ctx, tokens) {
    const movedOn = versionCopy('deposits.closed', tokens);
    switch (state.reload?.reason) {
        case 'upgrade_withdrawn':
            return ctx.withdrawalConfirmed === true ? versionCopy('upgrade.withdrawn', tokens) : movedOn;
        case 'moved_in_other_tab':
            return ctx.previewReason === 'no_runtime_note' ? movedOn : versionCopy('reload.otherTab', tokens);
        case 'draft_cleared':
            // Not twice: a discard the person made here was said at the click.
            return ctx.draftClearedHere === true ? movedOn : `${versionCopy('draft.cleared', tokens)} ${movedOn}`;
        default:
            // 'previous_withdrawal_finished', and any reason this does not
            // know: what is true of every reload to the version that takes
            // deposits.
            return movedOn;
    }
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

// `marks` is the stage whose progress the marks draw (the step list of a
// withdrawal that just ended is the one of "ready to switch"); the detail line
// under the current step is always the real stage's.
function renderSteps(stage, tokens, marks = stage) {
    const current = stage === 'withdrawing' || stage === 'confirming' ? 'active' : 'waiting';
    const details = {
        withdraw: { review: WORDS.stepDetail.review, withdrawing: WORDS.stepDetail.withdrawing, confirming: WORDS.stepDetail.confirming },
        reload: { ready_to_switch: fill(WORDS.stepDetail.reload, { N: tokens.N ? `version ${escapeHtml(tokens.N)}` : 'the newer version' }) },
        deposit: { deposit: fill(WORDS.stepDetail.deposit, { N: tokens.N ? `version ${escapeHtml(tokens.N)}` : 'the newer version' }) }
    };
    return `<ol class="zkapi-steps-list" data-zkapi-upgrade-steps aria-label="Upgrade steps">${upgradeStepStates(marks).map(step => {
        const visual = step.state === 'done' ? 'complete' : step.state === 'current' ? current : 'upcoming';
        const detail = step.state === 'current' ? details[step.id]?.[stage] || '' : '';
        return `<li class="zkapi-step" data-upgrade-step="${step.id}" data-state="${visual}"${step.state === 'current' ? ' aria-current="step"' : ''}>
            <span class="zkapi-step-mark" aria-hidden="true">${visual === 'complete' ? CHECK_MARK : ''}</span>
            <span class="zkapi-step-text"><span class="zkapi-step-label">${escapeHtml(step.label)}</span>${detail ? `<small class="zkapi-step-detail">${detail}</small>` : ''}</span>
        </li>`;
    }).join('')}</ol>`;
}

function renderHeading(tokens) {
    return `<h3 class="zkapi-steps-title">${tokens.N ? `Upgrade to version ${escapeHtml(tokens.N)}` : 'Upgrade your balance'}</h3>`;
}

// What the person picks for where the withdrawal lands. MetaMask has one
// answer (the connected account, the SDK's default). Send Ethereum needs a
// typed address, or the funding address of the new version in this browser,
// which is only ever created by an explicit click.
function renderDestination(ctx, tokens) {
    const funding = ctx.funding === 'address' ? 'address' : 'metamask';
    if (funding === 'metamask') {
        return `<fieldset class="zkapi-section zkapi-choices" data-upgrade-destination>
            <legend class="zkapi-section-title">${WORDS.destinationLegend}</legend>
            <label class="zkapi-choice selected"><input type="radio" name="zkapi-upgrade-destination" value="connected" checked />
                <span><strong>${versionCopy('upgrade.destination.connected')}</strong></span></label>
        </fieldset>`;
    }
    const destination = isRecord(ctx.destination) ? ctx.destination : {};
    const canCreate = ctx.canCreateAddress === true;
    const newAddress = typeof destination.newAddress === 'string' && ADDRESS.test(destination.newAddress)
        ? destination.newAddress : null;
    let choice = destination.choice === 'new-address' || destination.choice === 'other' ? destination.choice : '';
    if (!choice || (choice === 'new-address' && !canCreate && !newAddress)) choice = canCreate ? 'new-address' : 'other';
    const busy = ctx.busy === true;
    const created = versionCopy('upgrade.destination.newAddress', tokens);
    const parts = splitSentence(created);
    const typed = typeof destination.typed === 'string' ? destination.typed : '';
    const newAddressBody = !newAddress
        ? `<button type="button" class="zkapi-secondary-button w-full" data-upgrade-new-address${busy || ctx.creatingAddress === true ? ' disabled' : ''}>${ctx.creatingAddress === true ? WORDS.creatingAddress : WORDS.createAddress}</button>${ctx.addressError ? `<p class="zkapi-funding-error" role="alert">${escapeHtml(ctx.addressError)}</p>` : ''}`
        : `<div class="zkapi-funding-address"><input data-upgrade-new-address-value readonly aria-label="New funding address${tokens.N ? ` for version ${escapeHtml(tokens.N)}` : ''}" value="${escapeHtml(newAddress)}" /></div>`;
    return `<fieldset class="zkapi-section zkapi-choices" data-upgrade-destination ${busy ? 'disabled' : ''}>
        <legend class="zkapi-section-title">${WORDS.destinationLegend}</legend>
        ${canCreate || newAddress ? `<label class="zkapi-choice ${choice === 'new-address' ? 'selected' : ''}"><input type="radio" name="zkapi-upgrade-destination" value="new-address" ${choice === 'new-address' ? 'checked' : ''} />
            <span><strong>${parts.head}</strong>${parts.tail ? `<small>${parts.tail}</small>` : ''}</span></label>` : ''}
        <label class="zkapi-choice ${choice === 'other' ? 'selected' : ''}"><input type="radio" name="zkapi-upgrade-destination" value="other" ${choice === 'other' ? 'checked' : ''} />
            <span><strong>${versionCopy('upgrade.destination.other')}</strong></span></label>
    </fieldset>
    ${choice === 'new-address' ? newAddressBody : `<label class="zkapi-funding-field">${WORDS.otherLabel}<input id="funding-withdrawal-destination" data-funding-withdrawal-destination autocomplete="off" spellcheck="false" placeholder="0x…" value="${escapeHtml(typed)}" ${busy ? 'disabled' : ''} /></label>`}`;
}

// A disabled Reload says why in text beside it, and the button points at it,
// so a screen reader hears the reason with the button.
const HINT_IDS = Object.freeze({
    upgrade: 'zkapi-upgrade-reload-hint', closed: 'zkapi-closed-reload-hint', held: 'zkapi-held-reload-hint'
});

function renderReload(state, ctx) {
    const canReload = state.reload?.canReload === true && ctx.busy !== true;
    return `<div class="zkapi-actions" data-upgrade-reload>
        ${actionButton('reload', 'Reload', { primary: true, disabled: !canReload, describedBy: HINT_IDS.upgrade })}
        ${canReload ? '' : `<p id="${HINT_IDS.upgrade}" class="zkapi-note" data-upgrade-reload-hint>${versionCopy('reload.busy')}</p>`}
    </div>`;
}

function backButton(withdrawalHtml) {
    // The embedded withdrawal markup already ends in this button.
    if (typeof withdrawalHtml === 'string' && withdrawalHtml.includes('id="zkapi-back-balance-btn"')) return '';
    return `<button id="zkapi-back-balance-btn" class="zkapi-quiet-button" type="button">${WORDS.backToBalance}</button>`;
}

function embed(withdrawalHtml) {
    return typeof withdrawalHtml === 'string' && withdrawalHtml
        ? `<div data-zkapi-upgrade-withdrawal>${withdrawalHtml}</div>` : '';
}

// Whether the page is waiting on an unfinished withdrawal of ANOTHER version
// (the loaded version's own set-aside note is a deadline, not this).
function finishesOtherVersion(state) {
    const previous = isRecord(state.previous) ? state.previous : null;
    return state.phase === 'finish-previous-withdrawal' && previous !== null
        && typeof previous.versionId === 'string' && previous.versionId !== ''
        && previous.versionId !== state.current?.id;
}

// "Open version P": only where the slot is free for that version to load.
function openPreviousButton(state, ctx, tokens) {
    const previous = isRecord(state.previous) ? state.previous : null;
    if (!previous || previous.canOpen !== true || !tokens.P) return '';
    return actionButton('open-previous', versionCopy('previous.open', tokens), { primary: true, disabled: ctx.busy === true });
}

// Why an upgrade cannot start, in the words of 5.5.
function renderBlocked(state, ctx, tokens) {
    const reason = state.upgrade?.blockedBy;
    if (reason === 'service_unreachable') {
        return `<p class="zkapi-helper" data-upgrade-blocked="service_unreachable">${versionCopy('held.unreachable', tokens)}</p>`;
    }
    if (reason === 'claimed') return `<p class="zkapi-helper" data-upgrade-blocked="claimed">${WORDS.claimed}</p>`;
    if (reason === 'expired' || state.phase === 'expired') return `<p class="zkapi-note zkapi-note--attention" data-upgrade-blocked="expired">${WORDS.expired}</p>`;
    if (reason === 'unsent_deposit' || state.unsent === true) {
        // Just discarded here: the state catches up with the next holdings
        // read, and the dialog's own result line says it was cleared. Offering
        // the button again for that moment would be a second, refused click.
        if (ctx.unsentCleared === true) return '';
        return `<div data-upgrade-blocked="unsent">${renderUnsent(state, ctx, tokens)}</div>`;
    }
    if (reason === 'pending_deposit') {
        return `<p class="zkapi-note" data-upgrade-blocked="pending_deposit">${fill(WORDS.pendingDeposit, { F: versionPhrase(state.current, 'this version') })}</p>`;
    }
    // Another version's unfinished withdrawal: it is that build that finishes
    // it, so the way there is offered here as well as in the closed view.
    if (reason !== 'open_withdrawal' && finishesOtherVersion(state)) {
        return `<div data-upgrade-blocked="previous"><p class="zkapi-note">${versionCopy('deposits.blocked.previous', tokens)}</p>${openPreviousButton(state, ctx, tokens)}</div>`;
    }
    if (reason === 'open_withdrawal' || state.phase === 'finish-previous-withdrawal') {
        const waits = tokens.N ? fill(WORDS.depositsWait, { N: `version ${escapeHtml(tokens.N)}` }) : '';
        return `<p class="zkapi-note" data-upgrade-blocked="open_withdrawal">${WORDS.openWithdrawal}${waits}</p>`;
    }
    if (reason === 'in_flight') return `<p class="zkapi-note" data-upgrade-blocked="in_flight">${WORDS.inFlight}</p>`;
    return '';
}

// A deposit quote or never-sent plan that pins this version: the only way out
// is to clear it (a user gesture), then reload into the version that takes
// deposits. The reload button only exists once a fresh load would pick it.
function renderUnsent(state, ctx, tokens) {
    const reload = state.reload?.required === true;
    return `<p class="zkapi-note zkapi-note--attention">${versionCopy('unsent.explain', tokens)}</p>
        ${reload ? '' : actionButton('cancel-unsent', versionCopy('unsent.cancel'), { primary: true, disabled: ctx.busy === true })}
        ${reload ? renderReload(state, ctx) : ''}`;
}

// ---------------------------------------------------------------------------
// A balance the page cannot read
// ---------------------------------------------------------------------------

// The state says this browser holds a balance of the loaded version and that
// version's SDK did not start (versioning/versionState.mjs, `held`).
const isHeld = state => isRecord(state.held) && state.held.unreachable === true;

/**
 * What stands for the balance when this browser holds one that the page cannot
 * read: the service of its version was not available when the page started.
 * It says three things (the balance is saved here, the service is not
 * available, what using the newer version needs) and offers one action,
 * Reload. It has no "Add funds", no withdrawal and no upgrade, because every
 * one of them needs the SDK that did not start and would fail; it names no
 * address and shows no error of the service.
 *
 * The one view for the balance dialog and the deposits-closed view, so the two
 * cannot say different things. '' when the state does not say `held`.
 *
 * @param {{state: object, busy?: boolean, table?: object[], formatter?: Function|object}} ctx
 * @returns {string}
 */
export function renderHeldBalanceView(ctx) {
    const input = isRecord(ctx) ? ctx : {};
    const state = isRecord(input.state) ? input.state : null;
    if (!state || !isHeld(state)) return '';
    const tokens = tokensFor(input, state);
    const canReload = state.reload?.canReload === true && input.busy !== true;
    const hint = canReload ? ''
        : `<p id="${HINT_IDS.held}" class="zkapi-note" data-upgrade-reload-hint>${versionCopy('reload.busy')}</p>`;
    return `<section class="zkapi-section" data-zkapi-balance-held aria-label="${versionCopy('held.label')}">
        <h3 class="zkapi-section-title">${versionCopy('held.label')}</h3>
        <p class="zkapi-helper" data-zkapi-held-text>${versionCopy('held.unreachable', tokens)}</p>
        <div class="zkapi-actions">
            ${actionButton('reload', 'Reload', { primary: true, disabled: !canReload, describedBy: HINT_IDS.held })}
            ${hint}
        </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// The upgrade view
// ---------------------------------------------------------------------------

/**
 * @param {{state: object, stage: string, funding: 'metamask'|'address', withdrawalHtml: string,
 *   destination: {choice: string, newAddress: string|null, typed?: string}, sepolia: boolean,
 *   busy?: boolean, withdrawn?: boolean, table?: object[], formatter?: Function|object,
 *   canCreateAddress?: boolean, creatingAddress?: boolean, addressError?: string,
 *   gas?: {balanceWei: string|null}, withdrawalConfirmed?: boolean, previewReason?: string,
 *   outcomeHtml?: string, unsentCleared?: boolean, draftClearedHere?: boolean}} ctx
 * @returns {string}
 */
export function renderUpgradeView(ctx) {
    const input = isRecord(ctx) ? ctx : {};
    const state = isRecord(input.state) ? input.state : null;
    if (!state) return '';
    // No step of an upgrade can run while the balance cannot be read; a
    // caller that asks for one anyway (a restored view) is told why.
    if (isHeld(state)) return renderHeldBalanceView(input);
    const stage = STAGES.has(input.stage) ? input.stage : STAGES.has(state.upgrade?.stage) ? state.upgrade.stage : 'idle';
    const tokens = tokensFor(input, state);
    const withdrawalHtml = typeof input.withdrawalHtml === 'string' ? input.withdrawalHtml : '';
    let body = '';
    // Whether the existing withdrawal markup is part of this render.
    let embedded = ['review', 'withdrawing', 'confirming'].includes(stage);

    if (stage === 'review') {
        const leadKey = upgradeBannerKey(state);
        const gasEmpty = input.funding === 'address' && input.gas && String(input.gas.balanceWei) === '0';
        body = `${leadKey ? `<p class="zkapi-helper" data-upgrade-lead>${versionCopy(leadKey, tokens)}</p>` : ''}
            <p class="zkapi-note" data-upgrade-review>${versionCopy('upgrade.review', tokens)}</p>
            <p class="zkapi-note" data-upgrade-fee>${versionCopy('upgrade.review.fee')}</p>
            ${state.upgrade?.blockedBy === 'in_flight' ? `<p class="zkapi-note" data-upgrade-blocked="in_flight">${WORDS.inFlight}</p>` : ''}
            ${renderDestination(input, tokens)}
            ${gasEmpty ? `<p class="zkapi-note zkapi-note--attention" data-upgrade-gas role="status">${WORDS.gasEmpty}</p>` : ''}
            ${embed(withdrawalHtml)}`;
    } else if (stage === 'withdrawing') {
        body = embed(withdrawalHtml);
    } else if (stage === 'confirming') {
        body = `<p class="zkapi-note" data-upgrade-confirming role="status">${WORDS.confirming}</p>${embed(withdrawalHtml)}`;
    } else if (stage === 'ready_to_switch') {
        // "Withdrawal confirmed" only where the facade has the payout evidence:
        // a reload also follows a cleared quote, another tab's move, an
        // archived balance and a closure nobody could verify.
        body = `<p class="zkapi-helper" data-upgrade-withdrawn role="status">${reloadWords(state, input, tokens)}</p>
            ${input.funding === 'address' ? `<p class="zkapi-note" data-upgrade-leftover>${WORDS.leftoverEth}</p>` : ''}
            ${input.sepolia === true ? `<p class="zkapi-note">${WORDS.sepoliaAgain}</p>` : ''}
            ${renderReload(state, input)}`;
    } else if (stage === 'deposit') {
        body = `<p class="zkapi-helper" data-upgrade-deposit role="status">${versionCopy('upgrade.deposit', tokens)}</p>`;
    } else if (stage === 'done') {
        body = `<p class="zkapi-helper" data-upgrade-done role="status">${versionCopy('upgrade.done', tokens)}</p>`;
    } else if (stage === 'blocked') {
        // Another version's withdrawal with nothing held here has no withdrawal
        // of this page's to show (its markup would only say there is no note).
        const nothingHere = finishesOtherVersion(state) && state.holding === 'none';
        const withdrawable = !nothingHere && (WITHDRAWABLE_BLOCKS.has(state.upgrade?.blockedBy)
            || (state.upgrade?.blockedBy == null && ['expired', 'finish-previous-withdrawal'].includes(state.phase)));
        body = `${renderBlocked(state, input, tokens)}${withdrawable ? embed(withdrawalHtml) : ''}`;
        embedded = withdrawable;
    } else if (input.withdrawn === true) {
        // This dialog just saw the withdrawal confirmed; the next step has not
        // been worked out yet. Said as what is happening, not as "nothing".
        // "Withdrawal confirmed" is a payout claim: said only when the facade
        // has the evidence, as in the ready step below.
        const checking = input.withdrawalConfirmed === true ? WORDS.checkingNext : WORDS.checkingNextUnproven;
        body = `<p class="zkapi-helper" data-upgrade-withdrawn role="status">${fill(checking, { N: tokens.N ? `version ${escapeHtml(tokens.N)}` : 'the newer version' })}</p>`;
    } else {
        body = `<p class="zkapi-helper" data-upgrade-nothing>${WORDS.nothingToUpgrade}</p>`;
    }
    // The deposit and done stages are a short lead above the ordinary fund
    // flow, not a view of their own: no back button there. Every other view
    // ends in one, the embedded withdrawal's own when it has it.
    const lead = stage === 'deposit' || stage === 'done';
    const back = lead ? '' : backButton(embedded ? withdrawalHtml : '');
    // The result of the last button (a refused reload, a cleared plan) in the
    // stages that do not embed the withdrawal, whose markup carries its own.
    const outcome = !embedded && !lead && typeof input.outcomeHtml === 'string' ? input.outcomeHtml : '';
    // A withdrawal that has just ended and whose next step is still being
    // worked out is drawn with its first step done.
    const marks = stage === 'idle' && input.withdrawn === true ? 'ready_to_switch' : stage;
    return `<section class="zkapi-stack" data-zkapi-upgrade-view data-upgrade-stage="${stage}" aria-label="Upgrade your balance">
        <div class="zkapi-section">
            ${renderHeading(tokens)}
            ${renderSteps(stage, tokens, marks)}
        </div>
        ${body}
        ${outcome}
        ${lead ? '' : back}
    </section>`;
}

// ---------------------------------------------------------------------------
// The deposits-closed view
// ---------------------------------------------------------------------------

/**
 * What replaces the "Add funds" form when this page may not start a deposit.
 * Keyed on the gate (not on `state.show`): a lone exit-only version has
 * `show: false` and a closed gate with no successor.
 *
 * @param {{state: object, unsent: boolean, retired?: boolean, busy?: boolean,
 *   table?: object[], formatter?: Function|object}} ctx
 * @returns {string}
 */
export function renderDepositsClosedView(ctx) {
    const input = isRecord(ctx) ? ctx : {};
    const state = isRecord(input.state) ? input.state : null;
    if (!state) return '';
    // A balance the page cannot read is not "deposits moved" and not a gate
    // to explain: nothing can be deposited or moved until its service is back.
    if (isHeld(state)) return renderHeldBalanceView(input);
    const gate = isRecord(state.gate) ? state.gate : {};
    // A plan that was just discarded here is no longer unsent for this view,
    // whatever the state still says for the moment before it is read again.
    const unsent = input.unsent === true && input.unsentCleared !== true;
    if (gate.canStart === true && !unsent) return '';
    const tokens = tokensFor(input, state);
    const retired = input.retired === true;
    const code = typeof gate.code === 'string' ? gate.code : '';
    const headingKey = retired && code === 'foreign_runtime' ? 'retired' : code;
    let heading = unsent ? WORDS.closed.unsent : WORDS.closed[headingKey] || WORDS.closed.fallback;
    if (!unsent && headingKey === 'deposits_closed') {
        heading = tokens.N ? WORDS.closed.deposits_closed : WORDS.closed.noTarget;
    }
    const key = unsent ? null : gateCopyKey(gate, { retired });
    // A fresh load that would pick another version, or a gate whose remedy is
    // simply to load again (never for a retired owner: a reload changes nothing).
    const reload = state.reload?.required === true
        || (gateOffersReload(code) && !(retired && code === 'foreign_runtime') && !unsent);
    const previous = isRecord(state.previous) ? state.previous : null;
    // Another version's unfinished withdrawal is this view's business whether
    // it is what closed the gate (previous_withdrawal_open) or the loaded
    // version is itself exit-only (deposits_closed takes precedence in the
    // gate, and the withdrawal is still what the person has to finish).
    const waitsOnPrevious = code === 'previous_withdrawal_open' || finishesOtherVersion(state);
    const openPrevious = previous !== null && previous.canOpen === true && waitsOnPrevious;
    let text = '';
    if (unsent) text = `<p class="zkapi-note zkapi-note--attention" data-upgrade-unsent>${versionCopy('unsent.explain', tokens)}</p>`;
    else if (key === 'deposits.closed' && state.reload?.required === true) {
        // Deposits moved and a reload is the way there: the reload's own words
        // (a cleared quote, another tab's move, a confirmed withdrawal).
        text = `<p class="zkapi-helper">${reloadWords(state, input, tokens)}</p>`;
    } else if (key === 'deposits.blocked.previous') {
        text = `<p class="zkapi-helper" data-zkapi-closed-previous>${versionCopy(key, tokens)}</p>`;
    } else if (key) text = `<p class="zkapi-helper">${versionCopy(key, tokens)}</p>`;
    // The gate's own text names the previous version's withdrawal only when
    // that is the gate (and nothing replaced it, as an unsent plan does);
    // otherwise it is said beside the gate's text, in the words that say
    // whether it can be opened from here.
    if (key !== 'deposits.blocked.previous' && finishesOtherVersion(state)) {
        text += `<p class="zkapi-note" data-zkapi-closed-previous>${versionCopy('deposits.blocked.previous', tokens)}</p>`;
    }
    if (gate.canResume === true) text += `<p class="zkapi-note">${versionCopy('deposits.closed.started')}</p>`;
    let actions = '';
    if (unsent && !reload) actions += actionButton('cancel-unsent', versionCopy('unsent.cancel'), { primary: true, disabled: input.busy === true });
    if (openPrevious) actions += openPreviousButton(state, input, tokens);
    if (reload) {
        const canReload = state.reload?.canReload === true && input.busy !== true;
        actions += actionButton('reload', 'Reload', { primary: true, disabled: !canReload, describedBy: HINT_IDS.closed });
        if (!canReload) actions += `<p id="${HINT_IDS.closed}" class="zkapi-note" data-upgrade-reload-hint>${versionCopy('reload.busy')}</p>`;
    }
    return `<section class="zkapi-section" data-zkapi-deposits-closed data-zkapi-gate-code="${escapeHtml(code || 'unsent')}" aria-label="Deposits unavailable">
        <h3 class="zkapi-section-title">${escapeHtml(heading)}</h3>
        ${text}
        ${actions ? `<div class="zkapi-actions">${actions}</div>` : ''}
    </section>`;
}
