// zkAPI payment boot: which protocol version this tab runs, and the payment
// integration for it (docs/ZKAPI_VERSIONING.md, "Boot sequence").
//
// startup.js calls bootZkapiPayments() with NO arguments in production; every
// option below exists for tests and is never forwarded from startChatApp.
//
// Sequence (registry builds):
//
//   1  consume the one-shot version-switch hint (validated enums and ids only)
//   2  choose the version: a bounded, read-only probe of the shared wallet
//      database, unless there is nothing to choose between
//      (served-config integrity runs in parallel with 3)
//   3  load that version's SDK variant (multi-version builds)
//   4  install the choice as the page's active version
//   5  import the SDK client, runtime and store (after step 3, so facade
//      bindings are filled) and attach the versioning facade to the client.
//      A build that is not versioned starts step 7's import beside this one:
//      there is no guard to install between them, so the two waits overlap
//      instead of adding up
//   6  install the deposit guard before any UI exists (versioned builds)
//   7  import the payment adapter and create the integration with this
//      version's asset base; the version notices load beside it
//   8  start the version watcher (versioned builds)
//
// A versioned build also hands the facade two readers that are loaded on use
// and never at boot: the give-up of an empty or very small balance (SDK-bound,
// so imported when a person confirms it) and the payment history of the other
// versions (a read-only look at the shared wallet database, taken when the
// payment history is opened). A build that is not versioned has neither: the
// facade is inert there, and these are not even passed to it.
//
// "Versioned" is `isVersioningActive(table)` (versioning/index.js): more than
// one registry row, or a lone row that is not the deposit target. A build with
// no rows (sdk-default) or exactly one `active` row is today's app and runs
// none of the versioning machinery.
//
// Failure isolation. This function never throws. In a versioned build every
// wait is bounded, each step by its own limit and the whole of it by one
// overall budget (`totalMs`), so a stalled network cannot hold the page blank
// for the sum of the steps. A build that is not versioned (sdk-default, or one
// `active` row) is today's app, whose start waited for its code without a
// limit: it keeps doing so, because a slow link is not a failure and a limit
// would only turn a slow start into a ticket-only one. A failure anywhere
// resolves to `{integration: null, unavailable}` and the app starts
// ticket-only with one toast; the person's balance is untouched because the
// wallet database is only ever read here. A holdings probe that cannot answer
// is NOT an unavailability: it becomes `holdings_unreadable` (deposits blocked,
// everything else working) and boot continues. The version notices are
// optional presentation: they never delay the app past `uiMs` and attach
// themselves whenever they arrive.
//
// Static imports are SDK-free on purpose. The SDK modules are imported
// dynamically after loadVariant, because in a multi-version build the SDK
// imports of chat/zkapi resolve to facades that are only bound by then.
import { chooseZkapiVersion, selectZkapiVersion } from './versioning/versionLoader.mjs';
import { canDiscard, consumeVersionSwitch, noteDiscard, recordDiscard } from './versioning/switchProtocol.mjs';
import { installActiveVersion } from './versioning/activeVersion.mjs';
import { discardDepositDraft } from './versioning/walletHoldings.mjs';
import { verifyServedConfig } from './versioning/configIntegrity.mjs';
import { getAdapter } from './versioning/adapters/index.mjs';
import { installDepositGuard, unclassifiedDepositEntryPoints } from './versioning/depositGuard.mjs';
import { startVersionWatcher } from './versioning/versionWatcher.mjs';
import { isVersioningActive, zkapiVersioning } from './versioning/index.js';
import { versionCopyText } from './versioning/copy.mjs';
import { loadVariant as bundledLoadVariant } from './versioning/variants.js';

// probeMs bounds each step of the wallet probe (read, discard, read again),
// integrityMs the served-config request and variantMs each load of code (the
// SDK variant and every dynamic import after it) of a VERSIONED build. uiMs is
// how long boot waits, after everything else is ready, for the optional
// version notices. totalMs is the budget for the whole boot, from entry to the
// integration: the steps are sequential, so without it the per-step limits
// would add up (probe, variant, SDK and integration each at their own limit)
// to well over a minute of blank page on a stalled connection. A step never
// gets more than what is left of the budget. A build that is not versioned
// has no probe and no integrity request, and waits for code without a limit.
const DEFAULT_TIMEOUTS = Object.freeze({
    probeMs: 2000, integrityMs: 2000, variantMs: 20_000, uiMs: 3000, totalMs: 30_000
});
const UNAVAILABLE_CODES = new Set([
    'invalid_version_table', 'variant_unavailable', 'variant_timeout', 'sdk_unavailable',
    'integration_unavailable', 'asset_base_missing', 'boot_failed'
]);

// -- Build-time facts ---------------------------------------------------------

function definedNetwork() {
    return typeof __OA_ZKAPI_NETWORK__ === 'string' ? __OA_ZKAPI_NETWORK__ : '';
}

function definedTable() {
    if (typeof __OA_ZKAPI_VERSIONS__ === 'undefined') return [];
    const table = __OA_ZKAPI_VERSIONS__;
    return Array.isArray(table) ? table : [];
}

function definedDatabase() {
    return typeof __OA_ZKAPI_WALLET_DB__ === 'string' ? __OA_ZKAPI_WALLET_DB__ : '';
}

// -- Bounded waits ------------------------------------------------------------

function bootError(code, cause) {
    const error = new Error(`zkAPI boot failed: ${code}`);
    error.bootCode = code;
    if (cause !== undefined) error.cause = cause;
    return error;
}

// Resolves with `promise` or rejects at the deadline. The abandoned promise's
// late rejection is absorbed so it never surfaces as an unhandled rejection.
function withDeadline(promise, ms, code) {
    let timer = null;
    const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(bootError(code)), ms);
    });
    deadline.catch(() => {});
    Promise.resolve(promise).catch(() => {});
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// A monotonic millisecond clock for the boot budget. Wall-clock jumps must not
// stretch or cut it.
function monotonicMs() {
    const performance = globalThis.performance;
    return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

// Resolves when `promise` settles or after `ms`, whichever is first, and never
// rejects: for work whose outcome the caller does not depend on.
function waitAtMost(promise, ms) {
    let timer = null;
    const elapsed = new Promise(resolve => {
        timer = setTimeout(resolve, Number.isFinite(ms) && ms > 0 ? ms : 0);
    });
    return Promise.race([Promise.resolve(promise).catch(() => {}), elapsed]).finally(() => clearTimeout(timer));
}

// -- Default dynamic imports --------------------------------------------------

async function defaultImportSdk() {
    const [client, runtime, store] = await Promise.all([
        import('@openanonymity/zkapi-browser-sdk/client'),
        import('@openanonymity/zkapi-browser-sdk/runtime'),
        import('@openanonymity/zkapi-browser-sdk/store')
    ]);
    return { client: client.default, runtime: runtime.default, store };
}

function defaultImportIntegration() {
    return import('./index.js');
}

function defaultImportUi() {
    return import('./versioning/ui.js');
}

function defaultImportCanceledDeposit() {
    return import('./services/canceledDeposit.mjs');
}

// SDK-bound (it imports the client, the runtime and the store), so it is
// reached only when a person confirms giving up a balance, long after the
// variant is bound.
function defaultImportAbandonedNote() {
    return import('./services/abandonedNote.mjs');
}

// SDK-free, but needed only when the payment history is opened.
function defaultReadHistory(args) {
    return import('./versioning/otherVersionHistory.mjs').then(module => module.readOtherVersionHistory(args));
}

// -- Pieces -------------------------------------------------------------------

function integrationUrls(assetBase, baseURI) {
    return {
        configUrl: new URL(`${assetBase}browser-config.json`, baseURI).href,
        workerUrl: new URL(`${assetBase}assets/zkapiWasmWorker.js`, baseURI).href
    };
}

function createIntegration(createZkapiPaymentIntegration, urls, transport) {
    if (typeof createZkapiPaymentIntegration !== 'function') throw bootError('integration_unavailable');
    const integration = createZkapiPaymentIntegration({
        ...urls,
        mode: 'browser',
        ...(typeof transport === 'function' ? { transport } : {})
    });
    if (!integration || typeof integration !== 'object') throw bootError('integration_unavailable');
    return integration;
}

async function selectVersion({ table, database, prefer, timeouts, readHoldings, discardDraft, storage }) {
    const probeMs = timeouts.probeMs;
    try {
        // One probe, an optional draft discard and a second probe at most,
        // each bounded by `probeMs`; the outer deadline is one budget for the
        // three of them (so a slow but working database, whose discard has
        // already committed, is not cut off before the re-read that reports
        // it) and covers a discard or lock wait that never answers.
        return await withDeadline(selectZkapiVersion({
            table,
            database,
            prefer,
            timeoutMs: probeMs,
            readHoldings,
            discardDraft,
            // Boot charges the loop guard only for a discard that happened: a
            // refused or lock-busy attempt must not use up the allowance.
            canDiscard: () => canDiscard({ storage }),
            noteDiscard: () => noteDiscard({ storage })
        }), probeMs * 3 + 250, 'selection_timeout');
    } catch (error) {
        // A table no validated registry can produce is a build bug.
        if (error?.code === 'invalid_version_table') throw bootError('invalid_version_table', error);
        // Anything else: the database could not be read in time. Boot goes on
        // with the load target and deposits blocked (holdings_unreadable).
        return chooseZkapiVersion({ table, holdings: null, prefer });
    }
}

function warnUnclassified(client, runtime, adapter) {
    try {
        const drift = unclassifiedDepositEntryPoints({ client, runtime, adapter });
        if (drift.client.length || drift.runtime.length) {
            // Method names only; never state. The drift test in
            // test/zkapi/zkapi-deposit-guard.test.mjs fails on this when the
            // suite runs. These methods ARE guarded (deny by default); the
            // line asks for them to be classified, so a read-only one is not
            // refused.
            console.warn('[zkapi] Deposit methods not classified by the adapter (guarded by default):',
                [...drift.client, ...drift.runtime].join(', '));
        }
    } catch { /* diagnostics only */ }
}

// -- Boot ---------------------------------------------------------------------

async function boot(options) {
    const {
        network = definedNetwork(),
        table = definedTable(),
        database = definedDatabase(),
        baseURI = globalThis.document?.baseURI,
        transport,
        readHoldings,
        discardDraft,
        locks,
        loadVariant = bundledLoadVariant,
        importSdk = defaultImportSdk,
        importIntegration = defaultImportIntegration,
        importUi = defaultImportUi,
        importCanceledDeposit = defaultImportCanceledDeposit,
        importAbandonedNote = defaultImportAbandonedNote,
        readHistory = defaultReadHistory,
        verifyConfig = verifyServedConfig,
        startWatcher = startVersionWatcher,
        fetchBuild,
        storage,
        reload,
        now,
        facade = zkapiVersioning
    } = options;
    const timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts || {}) };
    if (!Number.isFinite(timeouts.totalMs) || timeouts.totalMs <= 0) timeouts.totalMs = DEFAULT_TIMEOUTS.totalMs;
    // What is left of the overall budget. Every wait for code is bounded by its
    // own limit AND by this, so the sequential steps cannot add up past it.
    const startedAt = monotonicMs();
    const remaining = () => Math.max(0, timeouts.totalMs - (monotonicMs() - startedAt));
    const stepLimit = () => Math.min(timeouts.variantMs, remaining());

    // Loading code in a versioned build is bounded like every other pre-app
    // wait. A build that is not versioned is today's app, which waited for its
    // code without a limit; it is passed `bounded: false` (below).
    const loading = (run, code, { bounded = true } = {}) => (bounded
        ? withDeadline(Promise.resolve().then(() => run()), stepLimit(), code)
        : Promise.resolve().then(() => run()));

    // 0. sdk-default (no registry): today's startup, unchanged, with the same
    // unbounded wait for the payment code.
    if (!Array.isArray(table) || table.length === 0) {
        if (!network) return { integration: null };
        let loaded;
        try {
            loaded = await loading(importIntegration, 'integration_unavailable', { bounded: false });
        } catch (error) {
            throw bootError('integration_unavailable', error);
        }
        const { createZkapiPaymentIntegration } = loaded || {};
        const assetBase = new URL('./zkapi/', baseURI);
        const integration = createIntegration(createZkapiPaymentIntegration, {
            configUrl: new URL('browser-config.json', assetBase).href,
            workerUrl: new URL('assets/zkapiWasmWorker.js', assetBase).href
        }, transport);
        return { integration };
    }

    // The probe, the integrity check, the deposit guard and the watcher exist
    // exactly when the build is versioning-active (versioning/index.js): there
    // is something to tell apart (a second row, a retired tombstone whose notes
    // may remain) or something closed (a lone row that is not the deposit
    // target). A lone `exit-only` row is NOT dormant: the pinned legacy SDK
    // ignores the profile's deposits flag, so the guard is what stops a new
    // deposit into a vault the registry closed.
    const versioned = isVersioningActive(table);
    const bounded = versioned;

    // 1. The one-shot switch hint. Failure to read it is "no hint".
    let hint = null;
    try {
        hint = consumeVersionSwitch({ storage, table, now });
    } catch {
        hint = null;
    }
    const prefer = hint ? hint.prefer : null;

    // 2. Version selection.
    const discard = typeof discardDraft === 'function' ? discardDraft
        : locks ? args => discardDepositDraft({ ...args, locks }) : undefined;
    const selection = await selectVersion({
        table, database, prefer, timeouts, readHoldings, discardDraft: discard, storage
    });
    const version = selection.version;
    if (typeof version.assetBase !== 'string' || !version.assetBase) throw bootError('asset_base_missing');
    const adapter = getAdapter(version.adapter);

    // Served-config integrity runs while the variant loads.
    const integrity = versioned
        ? withDeadline(
            Promise.resolve().then(() => verifyConfig(version, { timeoutMs: timeouts.integrityMs, baseURI })),
            timeouts.integrityMs + 250, 'integrity_timeout'
        ).catch(() => 'unverified')
        : Promise.resolve('unverified');

    // 3. The SDK variant for that version.
    try {
        await loading(() => loadVariant(version.id), 'variant_timeout', { bounded });
    } catch (error) {
        // `no_variants`: this build has one SDK and nothing to bind.
        if (error?.code !== 'no_variants') {
            throw bootError(error?.bootCode === 'variant_timeout' ? 'variant_timeout' : 'variant_unavailable', error);
        }
    }

    // 4. The choice becomes the page's active version.
    installActiveVersion({ table, version, selection });

    // 5. The SDK, then the facade on its client. Without versioning there is
    // no guard to install before the integration module is evaluated, so its
    // import starts now, in the same tick: the two chunk graphs download
    // together (today's startup fetched them as one) instead of one after the
    // other. Nothing reads the facade while the module evaluates; the
    // components read it when they render, after createIntegration below.
    const sdkImport = loading(importSdk, 'sdk_unavailable', { bounded });
    let integrationImport = null;
    if (!versioned) {
        integrationImport = loading(importIntegration, 'integration_unavailable', { bounded });
        // Awaited at step 7; if the SDK import fails first this is absorbed.
        integrationImport.catch(() => {});
    }
    let sdk;
    try {
        sdk = await sdkImport;
    } catch (error) {
        throw bootError('sdk_unavailable', error);
    }
    const { client, runtime, store } = sdk || {};
    if (!client || !runtime) throw bootError('sdk_unavailable');

    facade.attach({
        client,
        runtime,
        // The version notices are optional presentation and arrive below.
        ui: null,
        integrity: await integrity,
        reload,
        storage,
        discardUnsent: async () => {
            const canceled = await importCanceledDeposit();
            const released = await canceled.discardUnsentDeposit({
                client, runtime, withWalletLock: store?.withBrowserWalletLock
            });
            if (released === true) {
                // Publish the committed change to the SDK's own subscribers.
                try { await client.refresh?.({ quiet: true }); } catch { /* it re-reads on its own timer */ }
            }
            return released === true;
        },
        // Only a build with versions to tell apart has anything to give up or
        // to show the history of.
        ...(versioned ? {
            // The SDK singletons are this build's own (bound by the variant),
            // and the service refuses unless the loaded version's family and
            // the registry row allow it (the facade passes both).
            abandonNote: async args => {
                const module = await importAbandonedNote();
                return module.giveUpBalance({ client, runtime, store, ...(locks ? { locks } : {}), ...args });
            },
            readHistory: () => readHistory({ database, table, loadedDeploymentId: version.deploymentId })
        } : {})
    });
    client.oaVersioning = facade;

    // The version UI helpers may import SDK-bound modules, so they come after
    // the variant is bound; they load beside the payment adapter rather than
    // before it. A dormant build shows none and does not fetch them. Their
    // failure costs the notices, never the payments, and they attach
    // themselves whenever they arrive (the facade tells its subscribers).
    let notices = Promise.resolve();
    if (versioned) {
        notices = loading(importUi, 'ui_unavailable').then(
            loaded => {
                if (loaded?.versionUi && typeof facade.attachUi === 'function') facade.attachUi(loaded.versionUi);
            },
            () => { console.warn('[zkapi] The version notices could not load.'); }
        );
    }

    // 6. The deposit guard, before any UI can start a deposit.
    if (versioned) {
        installDepositGuard({ client, runtime, adapter, getGate: () => facade.depositGate() });
        warnUnclassified(client, runtime, adapter);
    }

    // 7. The payment adapter for this version's assets.
    let createZkapiPaymentIntegration;
    try {
        ({ createZkapiPaymentIntegration } = await (integrationImport
            || loading(importIntegration, 'integration_unavailable', { bounded })));
    } catch (error) {
        throw bootError('integration_unavailable', error);
    }
    const integration = createIntegration(
        createZkapiPaymentIntegration, integrationUrls(version.assetBase, baseURI), transport
    );

    // The notices are almost always in by now. Wait a little for them so the
    // first render has them, but never past `uiMs` or the overall budget.
    await waitAtMost(notices, Math.min(timeouts.uiMs, remaining()));

    // 8. The watcher, last: nothing it does matters before the UI exists.
    if (versioned) {
        try {
            startWatcher({
                facade, table, database, readHoldings, discardDraft: discard, fetchBuild, network, baseURI,
                // The same loop-guard log the boot discard counted against.
                recordDiscard: () => recordDiscard({ storage })
            });
        } catch {
            console.warn('[zkapi] The version watcher could not start.');
        }
    }
    return { integration };
}

/**
 * Boot zkAPI payments for this tab. Never throws.
 *
 * @param {object} [options] Test seams only; production passes none.
 * @returns {Promise<{integration: {runtime: object, ui: object}|null,
 *   unavailable?: {code: string, message: string}}>}
 */
export async function bootZkapiPayments(options = {}) {
    try {
        return await boot(options || {});
    } catch (error) {
        const raw = typeof error?.bootCode === 'string' ? error.bootCode : 'boot_failed';
        const code = UNAVAILABLE_CODES.has(raw) ? raw : 'boot_failed';
        // The code only: errors can carry wallet context.
        console.warn('[zkapi] Private payments could not start:', code);
        return {
            integration: null,
            unavailable: { code, message: versionCopyText('unavailable') }
        };
    }
}

export default bootZkapiPayments;
