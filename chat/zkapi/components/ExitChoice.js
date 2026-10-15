// What a withdrawal can cost when a recent chat is still settling, and the
// choice the person has (docs/ZKAPI_VERSIONING.md, section 7, "Upgrade UX").
//
// A chat is not recorded on Ethereum while it settles. An emergency exit
// proves the balance as of the last state the browser holds, so it can give up
// part of the balance that the settling chat may or may not have used. The SDK
// enforces the rules; this module only makes them readable and records what
// the person chose:
//
//   - whenever a settling chat could cost something (`exit.boundAtState` > 0)
//     a quiet fine-print line says the most it could be, and the number that
//     was shown is carried in `data-bound`. That number is the cap the Send
//     Ethereum signer later accepts (the person authorized "up to that")
//   - when the balance is known to be waiting on a settling chat, the
//     choices depend on the kind of withdrawal that is selected:
//       normal withdrawal   wait (the default, never anything else on its own),
//                           leave now giving up nothing now, or leave now
//                           giving up the bound
//       emergency exit      leave now giving up nothing now (the default) or
//                           leave now giving up the bound. An emergency exit
//                           never waits for a chat to settle, so offering
//                           "wait" there would say the opposite of what
//                           happens
//   - the `bound` choice carries the sentence the protocol requires: the chat
//     is not recorded on Ethereum, so the person may give up more than it cost
//   - from the time the chat had to settle (`exit.escapeAtMs`, or a held
//     settlement wait's own, while the state is not known to have settled) the
//     SDK no longer waits for it and no longer honors "give up nothing now": a
//     withdrawal of any kind leaves at once and gives up the whole figure.
//     There is then nothing to choose, so the fine print stands alone with one
//     sentence saying what a withdrawal does now. The figure is still carried
//     in `data-bound`: the signer holds the withdrawal to it
//
// Pure string renderer plus a pure reader over an Element-like root. No
// facade, no storage, no clock of its own: the VersionState, the page's money
// formatter and the instant to judge "has passed" by (`ctx.now`) arrive as
// arguments. A caller that gives no instant has nothing known to have passed.
//
// DOM hooks: [data-zkapi-exit-choice] (container, with data-zkapi-exit-mode
// mutual|escape: the kind of withdrawal the markup was written for),
// [data-zkapi-exit-bound][data-bound] (the fine print; `data-bound` is gwei),
// fieldset [data-zkapi-exit-fieldset] with radios
// input[name="zkapi-withdraw-concede"] values wait|zero|bound (no `wait` in an
// emergency exit); after the settlement time [data-zkapi-exit-settled] wraps
// the fine print and [data-zkapi-exit-settlement-passed] carries the sentence
// (the dialog's own compensation for a state it was handed past that time uses
// the same two hooks and no longer fires: this module never draws the choice
// then).
import { copyTokens, escapeHtml, versionCopy } from '../versioning/copy.mjs';
import { formatEthUnits } from '../versioning/abandonNote.mjs';

export const CONCEDE_FIELD = 'zkapi-withdraw-concede';
const CHOICES = Object.freeze(['wait', 'zero', 'bound']);

export const EXIT_CHOICE_WORDS = Object.freeze({
    legend: 'How to withdraw',
    legendExit: 'What to give up',
    // The settlement paragraph of an emergency exit. The shared one says a
    // normal withdrawal waits and offers the emergency exit as the other way,
    // which would read backwards for a person who already chose it.
    exitIntro: 'A recent chat may still be settling. An emergency exit leaves now, before it has settled, '
        + 'so choose what to give up for that chat.',
    wait: 'Wait for it to settle',
    waitDetail: 'Use the normal withdrawal. It goes through once the chat has settled{?escapeAt}, from {escapeAt}{/escapeAt}.',
    zero: 'Leave now and give up nothing now',
    bound: 'Leave now and give up {bound}',
    boundUnknown: 'Leave now and give up the most that chat could cost',
    // Said in place of the choice once the time the chat had to settle has
    // passed. Waiting, and giving up nothing now, no longer exist.
    passed: 'The time that chat had to settle has passed. A withdrawal now leaves at once, '
        + 'as an emergency exit, and gives up the most that chat could cost, even if it cost less.'
});

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// An unknown or missing kind of withdrawal reads as the normal one, the
// product's default.
const modeOf = ctx => (ctx.mode === 'escape' ? 'escape' : 'mutual');
const AMOUNT = /^(?:0|[1-9][0-9]{0,29})$/;

// Gwei as a canonical decimal string, or null.
function amountText(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    return typeof value === 'string' && AMOUNT.test(value) ? value : null;
}

// An instant in epoch milliseconds, or null.
function instant(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// The time a settling chat has to settle, or null: the later of the standing
// time of the state and a held settlement wait's own (a refusal can be older
// than the standing state, and the SDK's own wait is never shorter than
// either). Only a settlement wait carries one; a wait for a proof or for a
// release names an instant that is about something else.
function settlementTime(exit) {
    const wait = isRecord(exit.wait) && exit.wait.kind === 'settlement' ? exit.wait : null;
    const times = [instant(exit.escapeAtMs), wait ? instant(wait.escapeAtMs) : null].filter(at => at !== null);
    return times.length ? Math.max(...times) : null;
}

// Whether that time is behind `now`. A state that has settled has none, a
// clock that is not a number knows nothing, and a time that is not known is
// not a passed one (the SDK then decides, and the signer holds the figure
// that was shown).
function settlementPassed(exit, now) {
    if (exit.stateFresh === true) return false;
    if (typeof now !== 'number' || !Number.isFinite(now)) return false;
    const at = settlementTime(exit);
    return at !== null && at <= now;
}

function larger(...values) {
    let best = null;
    for (const value of values) {
        const text = amountText(value);
        if (text !== null && (best === null || BigInt(text) > BigInt(best))) best = text;
    }
    return best;
}

// The page's money words for an amount, with the ether figure beside it
// (a dollar figure alone depends on a price quote). Never throws; '' when the
// amount can not be said at all.
function amountWords(units, formatAmount) {
    let money = '';
    if (typeof formatAmount === 'function') {
        try {
            const text = formatAmount(units);
            money = typeof text === 'string' ? text.trim() : '';
        } catch {
            money = '';
        }
    }
    const eth = formatEthUnits(units);
    if (money && eth && !/\beth\b/i.test(money)) return `${money} (${eth} ETH)`;
    if (money) return money;
    return eth ? `${eth} ETH` : '';
}

function fill(template, tokens) {
    // `{?name}...{/name}` keeps its inside only when the token is present.
    const kept = template.replace(/\{\?(\w+)\}([\s\S]*?)\{\/\1\}/g, (match, name, inner) => (tokens[name] ? inner : ''));
    return kept.replace(/\{(\w+)\}/g, (match, name) => (tokens[name] ? escapeHtml(tokens[name]) : ''));
}

// What the state calls for, or null when no fine print is due.
function model(state, ctx) {
    if (!isRecord(state) || !isRecord(state.exit)) return null;
    const exit = state.exit;
    const wait = isRecord(exit.wait) ? exit.wait : null;
    const bound = larger(wait?.boundAtState, exit.boundAtState);
    if (bound === null || BigInt(bound) === 0n) return null;
    const settling = exit.stateFresh === false || wait?.kind === 'settlement';
    // `passed`: the choice would be offered, and the time to settle is behind
    // us, so there is nothing left to choose.
    const offer = settling && ctx.offerChoice !== false;
    return { bound, settling, offer, passed: offer && settlementPassed(exit, ctx.now) };
}

/**
 * The fine print and, while a settling chat holds the balance, the choice.
 * '' when no settling chat can cost anything.
 *
 * `ctx`:
 *   formatter, table, now  as for copyTokens (dates, labels, the clock). `now`
 *                          is also what "the time to settle has passed" is
 *                          judged by: without it nothing has passed
 *   formatAmount           (gwei string) => money words; the ether figure is
 *                          added beside it here
 *   mode                   'mutual' (default) or 'escape': the kind of
 *                          withdrawal that is selected. An emergency exit
 *                          never waits, so it has no `wait` choice and starts
 *                          on `zero`
 *   choice, choiceBound    the person's earlier selection and the bound it
 *                          was made against. `zero` and `bound` are restored
 *                          only for the same bound; the default (`wait`, or
 *                          `zero` in an emergency exit) is never anything
 *                          else on its own
 *   offerChoice: false     the withdrawal's mode is already fixed (a prepared
 *                          withdrawal), so only the fine print is shown
 *   disabled               the dialog is working
 *
 * @param {object} state VersionState
 * @param {object} [ctx]
 * @returns {string}
 */
export function renderExitChoice(state, ctx = {}) {
    const options = isRecord(ctx) ? ctx : {};
    const read = model(state, options);
    if (read === null) return '';
    const mode = modeOf(options);
    const boundWords = amountWords(read.bound, options.formatAmount);
    const tokens = copyTokens(state, {
        formatter: options.formatter, table: options.table, now: options.now,
        formatAmount: () => boundWords
    });
    // The fine print: always, and the number it shows is the one carried.
    const finePrint = `<p class="zkapi-note zkapi-exit-bound" data-zkapi-exit-bound data-bound="${read.bound}">`
        + `${versionCopy('exit.bound', tokens)}</p>`;
    const fineOnly = `<div class="zkapi-exit-choice" data-zkapi-exit-choice data-zkapi-exit-mode="${mode}">${finePrint}</div>`;
    if (!read.offer) return fineOnly;
    if (read.passed) {
        // The choice would have been drawn, and no longer exists: the fine
        // print and the one sentence, in one container.
        return `<div class="zkapi-exit-choice" data-zkapi-exit-settled>${fineOnly}`
            + `<p class="zkapi-note" data-zkapi-exit-settlement-passed>${escapeHtml(EXIT_CHOICE_WORDS.passed)}</p></div>`;
    }

    // The default is the choice that gives up nothing now and, in a normal
    // withdrawal, changes nothing about the withdrawal itself.
    const fallback = mode === 'escape' ? 'zero' : 'wait';
    const restored = options.choice === 'zero' || options.choice === 'bound'
        ? (String(options.choiceBound ?? '') === read.bound ? options.choice : fallback)
        : fallback;
    const disabled = options.disabled === true;
    // The row of the checked radio is styled by the stylesheet (`:has(:checked)`),
    // not by a class written here: a class would stay on the row that was
    // chosen at render time after the person picks another.
    const option = (value, title, detail) => (
        `<label class="zkapi-choice">`
        + `<input type="radio" name="${CONCEDE_FIELD}" value="${value}"${restored === value ? ' checked' : ''} />`
        + `<span><strong>${title}</strong><small>${detail}</small></span></label>`
    );
    const boundTitle = boundWords
        ? fill(EXIT_CHOICE_WORDS.bound, { bound: boundWords }) : escapeHtml(EXIT_CHOICE_WORDS.boundUnknown);
    const escaping = mode === 'escape';
    const settlement = escaping ? escapeHtml(EXIT_CHOICE_WORDS.exitIntro) : versionCopy('exit.settlement', tokens);
    const waitOption = escaping ? ''
        : option('wait', escapeHtml(EXIT_CHOICE_WORDS.wait), fill(EXIT_CHOICE_WORDS.waitDetail, { escapeAt: tokens.escapeAt || '' }));
    return `<div class="zkapi-exit-choice" data-zkapi-exit-choice data-zkapi-exit-mode="${mode}">${finePrint}`
        + `<fieldset class="zkapi-section zkapi-choices zkapi-exit-fieldset" data-zkapi-exit-fieldset${disabled ? ' disabled' : ''}>`
        + `<legend class="zkapi-section-title">${escapeHtml(escaping ? EXIT_CHOICE_WORDS.legendExit : EXIT_CHOICE_WORDS.legend)}</legend>`
        + `<p class="zkapi-note" data-zkapi-exit-settlement>${settlement}</p>`
        + waitOption
        + option('zero', escapeHtml(EXIT_CHOICE_WORDS.zero), versionCopy('exit.concede.zero', tokens))
        + option('bound', boundTitle, versionCopy('exit.concede.bound', tokens))
        + '</fieldset></div>';
}

function all(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    try {
        return [...root.querySelectorAll(selector)];
    } catch {
        return [];
    }
}

function attribute(element, name) {
    if (!element) return null;
    if (typeof element.getAttribute === 'function') {
        const value = element.getAttribute(name);
        if (value !== null && value !== undefined) return String(value);
    }
    return null;
}

/**
 * What the person chose, read back from the rendered markup.
 *
 *   choice       'wait' | 'zero' | 'bound', or null when no fieldset was shown
 *   mode         'mutual' | 'escape': the kind of withdrawal the markup was
 *                written for, or null when there is no markup. A caller whose
 *                withdrawal is of the other kind has an out-of-date page and
 *                re-renders instead of acting on it
 *   bound        the bound the fine print showed (gwei string), or null
 *   conceded     exact amount to concede: '0' for `zero`, the bound for
 *                `bound`, else null
 *   concededMax  for `wait` (or no fieldset), the most a conversion or an
 *                immediate protocol concession may take: the shown bound.
 *                null when none was shown (the concession word must be 0)
 *   changed      the state's own bound is now larger than the one the person
 *                saw. The caller re-renders instead of acting on it
 *
 * The bound is read from what was DISPLAYED, never from the state: a figure
 * the person did not see is not a figure they authorized. A choice that needs
 * a bound the markup does not carry falls back to `wait`, which gives up
 * nothing now and does not change the kind of withdrawal (in an emergency
 * exit, which has no `wait` button, the protocol's own default of giving up
 * nothing now applies).
 *
 * @param {Element|object} root a container of the rendered choice
 * @param {object} [state] VersionState, to detect a bound that grew
 */
export function readExitChoice(root, state = null) {
    const holder = all(root, '[data-zkapi-exit-bound]')[0] || null;
    const bound = amountText(attribute(holder, 'data-bound'));
    // The container is a descendant of the root, or the root itself.
    const container = all(root, '[data-zkapi-exit-choice]')[0]
        || (attribute(root, 'data-zkapi-exit-choice') !== null ? root : null);
    const rendered = attribute(container, 'data-zkapi-exit-mode');
    const mode = rendered === 'escape' || rendered === 'mutual' ? rendered : null;
    const radios = all(root, `input[name="${CONCEDE_FIELD}"]`);
    const current = isRecord(state) && isRecord(state.exit)
        ? larger(state.exit.wait?.boundAtState, state.exit.boundAtState) : null;
    const changed = bound !== null && current !== null && BigInt(current) > BigInt(bound);
    if (!radios.length) {
        return { choice: null, mode, bound, conceded: null, concededMax: bound, changed };
    }
    const picked = radios.find(radio => radio.checked === true);
    let value = picked ? String(picked.value) : 'wait';
    if (!CHOICES.includes(value)) value = 'wait';
    if ((value === 'zero' || value === 'bound') && bound === null) value = 'wait';
    if (value === 'zero') return { choice: 'zero', mode, bound, conceded: '0', concededMax: null, changed };
    if (value === 'bound') return { choice: 'bound', mode, bound, conceded: bound, concededMax: null, changed };
    return { choice: 'wait', mode, bound, conceded: null, concededMax: bound, changed };
}
