// Version UI helpers composed for the runtime facade.
//
// Boot loads this module beside the integration and hands `versionUi` to the
// facade (`facade.attachUi`), which is how the four vm-evaluated sources
// reach them (`zkapiClient.oaVersioning?.ui?.<member>`): they cannot gain
// imports, so every helper they need hangs on this one object.
//
// The members are the renderers of components/VersionNotices.js and
// components/UpgradeView.js with the page's own facts bound in. A renderer
// takes a VersionState and options; the facts a VersionState does not carry
// (the version table for registry labels, "a retired deployment holds the
// slot", the session flags) are read from the facade here when the caller did
// not pass them, so a caller needs only the arguments below:
//
//   badge(state, {surface, helpOpen})            -> html; balance details always name the version
//   banner(state, {surface, now})                -> html, '' when nothing to say
//   patch(root, state, {now})                    -> {needsRender}
//   help(kind, state?)                           -> {title, body} | null
//   upgradeView(ctx)                             -> html
//   depositsClosedView(ctx)                      -> html
//   heldBalance(ctx)                             -> html, '' unless the state
//                                                   says `held`: what stands
//                                                   for a balance the page
//                                                   holds and cannot read
//   protocolNotices()                            -> html ('' until the
//                                                   activation change)
//
// The pieces the balance dialog places itself, each bound to the facade's
// state and money words (a caller's options win) and each total: with no
// state, no facade or an unreadable input they return '' / [] / the empty
// result, never throw, and so render nothing on a page that has no versions.
// The one exception is `recordExtras`, a pure renderer of one record: it needs
// no state, and a balance this browser cannot exit keeps its buttons hidden
// whatever else is missing:
//
//   balanceExtras(options?)       -> html   activation status and the
//                                           give-up link, under the balance
//   exitChoice(options?)          -> html   the fine print about a settling
//                                           chat and, while one holds the
//                                           balance, how to withdraw
//   readExitChoice(root, state?)  -> {choice, mode, bound, conceded,
//                                     concededMax, changed}
//   sponsoredFee(options)         -> html   the "Network fee" choice of the
//                                           withdraw form: who pays the fee,
//                                           and what is received when it is
//                                           paid from the withdrawal ('' when
//                                           the page offers no such payment)
//   recordExtras(record, ctx?)    -> {label, badge, noteHtml, actionsHtml,
//                                     hideActions, hideError} for one
//                                     payment-history row of this version
//   historyItems(ctx?)            -> [{key, at, html}] rows of the other
//                                     versions (text only: no action hooks);
//                                     `ctx.now` defaults to the clock, so a
//                                     caller that leaves it out sees the same
//                                     deadline rows the signature counts
//   historySignature(nowMs)       -> string, changes when those rows would
//
// Additive: `act(action, context)` (the one implementation of what a version
// button does), `attach(root, context)` (delegation for those buttons; the
// buttons the members above write carry the same `data-zkapi-version-action`
// hooks, so the dialog's existing delegation reaches `act` once per click),
// `dismiss(id)`, `facts()` (the two facts below, for callers that act rather
// than render) and `rescue` (the funding addresses of other versions, for
// the four vm-evaluated sources, which cannot import them).
//
// Two facts make a reload's words exact, and a VersionState does not carry
// them: `withdrawalConfirmed` (the facade says the upgrade's withdrawal ended
// WITH payout evidence, so "Withdrawal confirmed" is a fact and not a guess;
// every renderer says it only for `true`, never for a missing fact) and
// `previewReason` (what the freshest read of the wallet found). Both are read
// when the notice is rendered or the button pressed, never cached.
//
// SDK-free statically: no SDK module is in this module's import graph. The
// rescue members load `services/scopedFundingProviders.mjs` on first use,
// which is the one place here that reaches SDK-bound code, and only after
// boot has bound a variant (this module itself is loaded after that).
import {
    attachVersionNotices, dismissVersionNotice, handleVersionAction, patchVersionNotices,
    renderVersionBadge, renderVersionBanner, versionHelp
} from '../components/VersionNotices.js';
import { renderDepositsClosedView, renderHeldBalanceView, renderUpgradeView } from '../components/UpgradeView.js';
import { renderBalanceExtras } from '../components/BalanceExtras.js';
import { renderSponsoredFee } from '../components/SponsoredFee.js';
import { readExitChoice as readRenderedExitChoice, renderExitChoice } from '../components/ExitChoice.js';
import { isDeviceNotNewestRecord, recordExtras as recordExtrasFor } from '../components/RecordExtras.js';
import {
    historySignature as signatureOfHistory, renderHistoryItems
} from '../components/OtherVersionHistory.js';
import { zkapiVersioning } from './index.js';
import { readUpgradeIntent } from './switchProtocol.mjs';
import { versionRefusalMessage } from '../services/zkapiErrorCopy.mjs';

// Intent stages that say the upgrade's withdrawal is over (the stage a bare
// review step writes, `withdrawing`, only says one was started).
const WITHDRAWN_STAGES = new Set(['withdrawn', 'depositing']);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function definedNetwork() {
    try {
        return typeof __OA_ZKAPI_NETWORK__ === 'string' ? __OA_ZKAPI_NETWORK__ : '';
    } catch {
        return '';
    }
}

// Whether the upgrade's withdrawal ended with payout evidence. The facade
// answers (`flags().withdrawalConfirmed`): it alone knows the intent it
// advanced on evidence, the upgrade the person dismissed and the clock it
// reads. A facade without that flag (a stand-in) is answered from the stored
// intent, which only reaches `withdrawn`/`depositing` through the same rule.
// `undefined` when it cannot be known here (no network define, storage
// unreadable, no loaded version); the renderers then claim nothing.
function readWithdrawalConfirmed(facade) {
    try {
        const flags = typeof facade.flags === 'function' ? facade.flags() : null;
        if (isRecord(flags) && typeof flags.withdrawalConfirmed === 'boolean') return flags.withdrawalConfirmed;
    } catch { /* the stored intent below */ }
    try {
        const network = definedNetwork();
        const active = facade ? facade.active : null;
        if (!network || !isRecord(active) || typeof active.id !== 'string') return undefined;
        const intent = readUpgradeIntent({ network, now: Date.now() });
        return Boolean(intent && intent.from === active.id && WITHDRAWN_STAGES.has(intent.stage));
    } catch {
        return undefined;
    }
}

// The facts above, those that exist.
function readFacts(facade) {
    const facts = {};
    if (!facade) return facts;
    const confirmed = readWithdrawalConfirmed(facade);
    if (confirmed !== undefined) facts.withdrawalConfirmed = confirmed;
    try {
        const preview = typeof facade.previewSelection === 'function' ? facade.previewSelection() : null;
        if (isRecord(preview) && typeof preview.reason === 'string' && preview.reason) {
            facts.previewReason = preview.reason;
        }
    } catch { /* the reload words stay general */ }
    return facts;
}

// Facts from the facade the caller did not supply. Every read is guarded: a
// facade that cannot answer yields nothing, and the renderers then use their
// plain-words wording.
function readContext(facade) {
    const context = {};
    if (!facade) return context;
    Object.assign(context, readFacts(facade));
    try {
        const table = facade.table;
        if (Array.isArray(table) && table.length) context.table = table;
    } catch { /* labels fall back to ids */ }
    try {
        const selection = facade.selection;
        if (isRecord(selection)) context.retired = selection.reason === 'retired_deployment';
    } catch { /* not retired */ }
    try {
        const flags = typeof facade.flags === 'function' ? facade.flags() : null;
        if (isRecord(flags)) context.flags = flags;
    } catch { /* no flags */ }
    const formatAmount = amountFormatter(facade);
    if (formatAmount) context.formatAmount = formatAmount;
    return context;
}

// The facade's money words as a plain function, or null when it has none
// (a stand-in, or a page whose facade is not the real one). A bound is said
// in the page's money wherever a notice or the withdraw view states one.
function amountFormatter(facade) {
    if (!facade || typeof facade.formatAmount !== 'function') return null;
    return units => {
        try {
            const text = facade.formatAmount(units);
            return typeof text === 'string' ? text : '';
        } catch {
            return '';
        }
    };
}

// The state to render: the caller's own (the dialog derives it once per
// render and passes it), else the facade's. Null when there is none.
function stateOf(facade, options) {
    if (isRecord(options) && isRecord(options.state)) return options.state;
    if (!facade || typeof facade.state !== 'function') return null;
    try {
        const now = isRecord(options) && Number.isFinite(options.now) ? options.now : undefined;
        const state = now === undefined ? facade.state() : facade.state(now);
        return isRecord(state) ? state : null;
    } catch {
        return null;
    }
}

// Tell the facade what an attempt was refused for once the current call stack
// has unwound. The welcome panel asks for the words while it builds its markup
// and is itself subscribed to the facade: noting the refusal at once would
// publish into that render and draw the panel inside its own draw. The facade
// reads each error object once, so the redraw this causes asks again and is
// told nothing new. Never throws; a page with no versions is told nothing
// (the facade decides, and a stand-in without `noteRefusal` is not asked).
function noteRefusalAfterwards(facade, error, options) {
    try {
        if (!facade || typeof facade.noteRefusal !== 'function' || !error || typeof error !== 'object') return;
        const about = isRecord(options) && isRecord(options.about) ? options.about : null;
        Promise.resolve().then(() => {
            try {
                if (about) facade.noteRefusal(error, about);
                else facade.noteRefusal(error);
            } catch { /* the words were already given */ }
        });
    } catch { /* the words below do not depend on it */ }
}

// A clock reading the caller did not bring: the current time.
function clockOr(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

const NO_CHOICE = Object.freeze({
    choice: null, mode: null, bound: null, conceded: null, concededMax: null, changed: false
});
const NO_RECORD_EXTRAS = Object.freeze({
    label: null, badge: null, noteHtml: '', actionsHtml: '', hideActions: false, hideError: false
});

const loadScopedFundingProviders = () => import('../services/scopedFundingProviders.mjs');

// The funding addresses of other protocol versions. Every call
// is an explicit gesture's: nothing here reads a balance unasked. The module
// is loaded when first used, so composing the helpers imports no SDK code.
function createRescue(load) {
    return {
        /** A provider of another version's funding address; only `ensureAddress` is offered before it loads. */
        createScopedFundingProvider(version, deps) {
            return {
                async ensureAddress(...args) {
                    const module = await load();
                    return module.createScopedFundingProvider(version, deps).ensureAddress(...args);
                }
            };
        },
        async listRetiredScopes(options) { return (await load()).listRetiredScopes(options); },
        async checkRetiredScopeBalance(options) { return (await load()).checkRetiredScopeBalance(options); },
        async sweepRetiredScope(options) { return (await load()).sweepRetiredScope(options); },
        async recoverRetiredScope(options) { return (await load()).recoverRetiredScope(options); }
    };
}

/**
 * Compose the version UI helpers for a facade.
 *
 * @param {{facade?: object|null, protocolNotices?: () => string,
 *   loadRescue?: () => Promise<object>}} [options]
 */
export function createVersionUi({
    facade = zkapiVersioning, protocolNotices = () => '', loadRescue = loadScopedFundingProviders
} = {}) {
    // Host markup the activation change adds. Trusted: it never carries
    // operator text.
    const extraNotices = () => {
        try {
            const html = protocolNotices();
            return typeof html === 'string' ? html : '';
        } catch {
            return '';
        }
    };
    return {
        badge(state, options = {}) {
            return renderVersionBadge(state, { ...readContext(facade), ...options });
        },
        banner(state, options = {}) {
            return renderVersionBanner(state, { extra: extraNotices(), ...readContext(facade), ...options });
        },
        patch(root, state, options = {}) {
            return patchVersionNotices(root, state, { extra: extraNotices(), ...readContext(facade), ...options });
        },
        help(kind, state = undefined, options = {}) {
            let read = state;
            if (read === undefined) {
                try {
                    read = facade && typeof facade.state === 'function' ? facade.state() : null;
                } catch {
                    read = null;
                }
            }
            return versionHelp(kind, read, { ...readContext(facade), ...options });
        },
        upgradeView(context) {
            return renderUpgradeView(context);
        },
        depositsClosedView(context) {
            return renderDepositsClosedView(context);
        },
        heldBalance(context) {
            return renderHeldBalanceView(context);
        },
        protocolNotices: extraNotices,

        facts() {
            return readFacts(facade);
        },

        // -- Pieces of the balance dialog ---------------------------------------

        balanceExtras(options = {}) {
            try {
                const state = stateOf(facade, options);
                if (!state) return '';
                return renderBalanceExtras(state, isRecord(options) ? options : {});
            } catch {
                return '';
            }
        },
        exitChoice(options = {}) {
            try {
                const state = stateOf(facade, options);
                if (!state) return '';
                const given = isRecord(options) ? options : {};
                const context = { ...readContext(facade), ...given };
                return renderExitChoice(state, context);
            } catch {
                return '';
            }
        },
        sponsoredFee(options = {}) {
            try {
                const sponsored = facade ? facade.sponsored : null;
                if (!sponsored || typeof sponsored.supported !== 'function' || !sponsored.supported()) return '';
                const given = isRecord(options) ? options : {};
                const format = typeof given.format === 'function' ? given.format : amountFormatter(facade);
                return renderSponsoredFee({ ...given, ...(format ? { format } : {}) });
            } catch {
                return '';
            }
        },
        readExitChoice(root, state = undefined) {
            try {
                if (!facade) return { ...NO_CHOICE };
                return readRenderedExitChoice(root, isRecord(state) ? state : stateOf(facade, {}));
            } catch {
                return { ...NO_CHOICE };
            }
        },
        recordExtras(record, context = {}) {
            // The renderer is pure and needs no facade: a row's device state
            // must hide its buttons whatever else is missing. The facade only
            // supplies the money words the caller did not bring.
            try {
                const given = isRecord(context) ? context : {};
                const formatMoney = typeof given.formatMoney === 'function' ? given.formatMoney : amountFormatter(facade);
                return recordExtrasFor(record, formatMoney ? { ...given, formatMoney } : given);
            } catch {
                // Nothing is added, but a balance this browser cannot exit
                // keeps its buttons hidden.
                let flagged = false;
                try {
                    flagged = isDeviceNotNewestRecord(record);
                } catch { /* unreadable: not flagged here, the SDK refuses it anyway */ }
                return { ...NO_RECORD_EXTRAS, hideActions: flagged };
            }
        },
        historyItems(context = {}) {
            try {
                const history = facade ? facade.history : null;
                if (!history || typeof history.rows !== 'function') return [];
                const rows = history.rows();
                if (!Array.isArray(rows) || !rows.length) return [];
                const state = stateOf(facade, {});
                const given = isRecord(context) ? context : {};
                const formatMoney = amountFormatter(facade);
                // The presentation facts the dialog does not pass are the
                // state's: which version can be opened, and whether this
                // version's own balance holds the wallet. The time is the
                // clock's: without one the deadline rows that the signature
                // counts as a change would never be drawn.
                return renderHistoryItems(rows, {
                    ...(formatMoney ? { formatMoney } : {}),
                    ...(state ? { previous: state.previous, slotHeld: state.holding !== 'none' } : {}),
                    ...given,
                    now: clockOr(given.now)
                });
            } catch {
                return [];
            }
        },
        historySignature(nowMs) {
            try {
                const history = facade ? facade.history : null;
                if (!history || typeof history.rows !== 'function') return '';
                return signatureOfHistory(history.rows(), clockOr(nowMs));
            } catch {
                return '';
            }
        },
        /**
         * An SDK or host refusal that is a protocol-version state, in plain
         * words (no deployment ids); null for every other error. The welcome
         * panel reaches it through `zkapiClient.oaVersioning?.ui?.refusalMessage`
         * because it cannot import, and falls back to the error's own message,
         * so a page without these helpers (a dormant build) shows the SDK's
         * words exactly as before. Never throws.
         *
         * The words are returned at once. The facade holds what the refusal
         * said (a wait, a paused service) so the balance can say it as a
         * notice too, but is told only after the caller's call stack has
         * unwound: the welcome panel asks while it renders, and a render
         * must not publish. `options.about` names the balance the attempt was
         * about (see the facade's noteRefusal); without it the facade holds
         * the refusal for a minute only.
         *
         * The error that stopped a version's SDK from starting, while the
         * wallet holds a balance of that version, is one of these states too:
         * its own words can carry the operator's address, and the page says
         * the balance is saved and its service is not available instead.
         */
        refusalMessage(error, options = undefined) {
            noteRefusalAfterwards(facade, error, options);
            try {
                const given = isRecord(options) ? options : {};
                return versionRefusalMessage(error, { ...given, facade }) || null;
            } catch {
                return null;
            }
        },
        act(action, context = {}) {
            return handleVersionAction(action, { facade, ...context });
        },
        attach(root, context = {}) {
            attachVersionNotices(root, { facade: () => facade, ...context });
        },
        dismiss(id) {
            dismissVersionNotice(id);
        },
        rescue: createRescue(loadRescue)
    };
}

/** The page's helpers, bound to the page's facade. */
export const versionUi = createVersionUi();

export default versionUi;
