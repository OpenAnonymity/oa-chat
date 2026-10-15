// Keeps a long-lived tab honest about the shared wallet while versions exist
// side by side (docs/ZKAPI_VERSIONING.md, "The watcher and `stale_build`").
//
// Two jobs, both read-mostly and both fail-safe:
//
//   Holdings. Another tab can change what the wallet database holds (it
//   finishes a withdrawal, deposits, cancels a draft). On focus, on becoming
//   visible, on a message on the SDK's wallet channel and whenever the SDK's
//   own snapshot changes (debounced) this re-reads the database with the
//   read-only probe, decides what a fresh load WOULD pick, and hands that
//   preview to the facade. The facade turns it into "reload required",
//   "ready to switch" and so on. The probe never creates or upgrades
//   anything; this module never writes the wallet slot except through
//   discardDepositDraft (the single documented exception) and only for a
//   deposit draft or a never-sent plan that pins a version which no longer
//   accepts deposits.
//
//   Build status. A newer deployment may have moved deposits to another
//   version while this tab was open. /build.json (no-store, no credentials,
//   independent of the update toast's dismissal) is compared with the loaded
//   bundle; if it says deposits moved, or that the loaded version is no longer
//   `active`, new deposits are latched off ("Reload to update before
//   depositing"). The latch is RESTRICT-ONLY: it never reopens anything, a
//   failed fetch changes nothing, started deposits and every exit stay
//   untouched, and only a reload clears it.
//
// Every effect (focus and visibility targets, the channel, fetch, timers, the
// loop guard) is injectable. The channel is receive-only: this module never
// posts.
import { chooseZkapiVersion } from './versionLoader.mjs';
import { discardDepositDraft, readWalletHoldings, WALLET_CHANNEL_NAME } from './walletHoldings.mjs';
import { recordDiscard as recordDiscardAttempt } from './switchProtocol.mjs';

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_BUILD_POLL_MS = 5 * 60 * 1000;
const DEFAULT_BUILD_TIMEOUT_MS = 10_000;
// A discard that found the wallet lock busy is tried again shortly, a few
// times per pinned draft. The loop guard caps how many discards the host makes
// per minute; a retry of a pin it already counted wrote nothing and is not
// another one (see `retryDiscard`).
const DISCARD_RETRY_MS = 10_000;
const MAX_DISCARD_RETRIES = 6;
const DISCARDABLE_SLOT_KINDS = new Set(['draft_only', 'unsent_prepared']);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a fetched /build.json says new deposits on the loaded bundle should
 * be refused. Restrict-only: it answers "latch" or "leave alone", never
 * "reopen". Pure.
 *
 * Latches when the fetched build (for the same network)
 *   names a deposit target that differs from the loaded bundle's, or
 *   no longer lists the loaded version as `active` while the bundle says it is.
 * Everything else, including a missing or malformed document, a different
 * network and a build with no zkAPI section, leaves deposits alone: an
 * unrelated deploy must not close anyone's deposits.
 *
 * @param {{build: unknown, network?: string, loaded: {id: string, status: string}|null,
 *   target: {id: string}|null}} input
 * @returns {boolean}
 */
export function buildClosesDeposits({ build, network = '', loaded, target } = {}) {
    if (!isRecord(build) || !isRecord(build.zkapi)) return false;
    const zkapi = build.zkapi;
    if (typeof zkapi.network === 'string' && network && zkapi.network !== network) return false;
    if (!isRecord(loaded) || typeof loaded.id !== 'string') return false;

    const fetchedTarget = typeof zkapi.depositTarget === 'string' && zkapi.depositTarget ? zkapi.depositTarget : null;
    if (fetchedTarget !== null && fetchedTarget !== (target ? target.id : null)) return true;

    if (loaded.status === 'active' && Array.isArray(zkapi.versions)) {
        const listed = zkapi.versions.find(entry => isRecord(entry) && entry.id === loaded.id);
        if (!listed || listed.status !== 'active') return true;
    }
    return false;
}

function bounded(promise, timeoutMs) {
    let timer = null;
    const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    });
    deadline.catch(() => {});
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function defaultFetchBuild({ baseURI, fetchImpl = globalThis.fetch } = {}) {
    return async () => {
        if (typeof fetchImpl !== 'function') return null;
        const base = baseURI || globalThis.document?.baseURI || globalThis.location?.href;
        if (!base) return null;
        const response = await fetchImpl(new URL('build.json', base).href, {
            cache: 'no-store',
            credentials: 'omit',
            headers: { 'cache-control': 'no-cache', pragma: 'no-cache' }
        });
        if (!response || response.ok !== true) return null;
        return response.json();
    };
}

function defaultCreateChannel(name) {
    return typeof globalThis.BroadcastChannel === 'function' ? new globalThis.BroadcastChannel(name) : null;
}

/**
 * Start the watcher.
 *
 * @param {object} options
 * @param {object} options.facade       the versioning facade (zkapiVersioning)
 * @param {object[]} options.table      the build's version table
 * @param {string} options.database     the shared wallet database name
 * @param {Function} [options.readHoldings]  readWalletHoldings
 * @param {Function} [options.discardDraft]  discardDepositDraft
 * @param {Function} [options.fetchBuild]    () => Promise<object|null>
 * @param {Function} [options.recordDiscard] () => {allowed: boolean}
 * @param {string}  [options.network]   the build's network (build.json check)
 * @param {object}  [options.windowTarget]    focus events
 * @param {object}  [options.documentTarget]  visibilitychange events
 * @param {Function} [options.createChannel]  (name) => BroadcastChannel|null
 * @param {Function} [options.setTimer] [options.clearTimer]
 * @param {number}  [options.debounceMs] [options.probeTimeoutMs] [options.buildPollMs]
 * @returns {() => void} stop
 */
export function startVersionWatcher({
    facade,
    table,
    database,
    readHoldings = readWalletHoldings,
    discardDraft = discardDepositDraft,
    fetchBuild = null,
    recordDiscard = () => recordDiscardAttempt(),
    network = '',
    baseURI,
    windowTarget = globalThis.window || null,
    documentTarget = globalThis.document || null,
    createChannel = defaultCreateChannel,
    setTimer = (...args) => globalThis.setTimeout(...args),
    clearTimer = timer => globalThis.clearTimeout(timer),
    debounceMs = DEFAULT_DEBOUNCE_MS,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    buildPollMs = DEFAULT_BUILD_POLL_MS,
    buildTimeoutMs = DEFAULT_BUILD_TIMEOUT_MS
} = {}) {
    if (!facade || typeof facade !== 'object' || !isRecord(facade.watch)) {
        throw new TypeError('The version watcher needs the versioning facade.');
    }
    if (!Array.isArray(table) || typeof database !== 'string' || !database) {
        throw new TypeError('The version watcher needs the version table and the wallet database name.');
    }
    const readBuild = typeof fetchBuild === 'function' ? fetchBuild : defaultFetchBuild({ baseURI });

    let running = true;
    let debounceTimer = null;
    let retryTimer = null;
    let buildTimer = null;
    let probing = false;
    let probeAgain = false;
    let checkingBuild = false;
    let latched = false;
    let discardRetries = 0;
    // The current pinned draft has been counted against the loop guard. It
    // is cleared when a discard succeeds or the pin goes away.
    let pinCounted = false;
    const cleanups = [];

    function schedule() {
        if (!running) return;
        if (debounceTimer !== null) clearTimer(debounceTimer);
        debounceTimer = setTimer(() => {
            debounceTimer = null;
            void probe();
        }, debounceMs);
        debounceTimer?.unref?.();
    }

    // What a fresh load would pick. `prefer` is the loaded id when this tab
    // was opened on a previous version to finish its work, exactly the hint the
    // boot selection honored, so the preview does not tell that tab to reload
    // away from the build it was opened on.
    function preferred() {
        const selection = facade.selection;
        const active = facade.active;
        return selection?.reason === 'requested_previous' && active ? active.id : null;
    }

    async function readOnce() {
        try {
            const result = await bounded(
                Promise.resolve().then(() => readHoldings({ database, timeoutMs: probeTimeoutMs })),
                probeTimeoutMs + 250
            );
            if (isRecord(result) && Array.isArray(result.holdings)) {
                return { holdings: result.holdings, slot: isRecord(result.slot) ? result.slot : {} };
            }
        } catch { /* unreadable: decided below */ }
        return null;
    }

    function preview(read) {
        const prefer = preferred();
        if (!read) return chooseZkapiVersion({ table, holdings: null, prefer });
        return chooseZkapiVersion({
            table, holdings: read.holdings, prefer,
            slotKind: typeof read.slot.kind === 'string' ? read.slot.kind : undefined
        });
    }

    // The slot is pinned to a version that no longer takes deposits by
    // something that holds no funds. The boot selection tries to clear it; this
    // is the retry for when the wallet lock was busy then.
    function pinnedByDraft(selection, read) {
        if (!read || !DISCARDABLE_SLOT_KINDS.has(read.slot.kind)) return false;
        const target = facade.target;
        return selection.reason === 'runtime_holds_note' && target !== null
            && selection.version.id !== target.id;
    }

    async function retryDiscard(selection, read) {
        // The loop guard exists to stop two builds trading discard-and-recreate
        // writes (a pre-rollout tab re-creating its draft every few seconds).
        // It is charged ONCE per pinned draft, before the first attempt: each
        // discard that succeeds ends the pin and the next one is charged
        // again, so the number of successful discards per window is still
        // capped. Retrying the same pin because the lock was busy wrote
        // nothing, so charging every retry would tell a person whose other tab
        // is merely mid-settlement to "close other tabs".
        if (!pinCounted) {
            let allowed = false;
            try {
                allowed = recordDiscard()?.allowed === true;
            } catch {
                allowed = false;
            }
            if (!allowed) {
                facade.watch.noteDiscardLoop(true);
                return null;
            }
            pinCounted = true;
        }
        facade.watch.noteDiscardLoop(false);
        let outcome = null;
        try {
            outcome = await bounded(Promise.resolve().then(() => discardDraft({
                database,
                timeoutMs: probeTimeoutMs,
                expectedDeploymentId: selection.version.deploymentId
            })), probeTimeoutMs + 250);
        } catch {
            outcome = null;
        }
        if (outcome?.discarded === true) {
            // That pin is gone. Whatever shows up next is a new one, counted
            // and retried afresh.
            pinCounted = false;
            discardRetries = 0;
            facade.watch.noteDraftDiscarded();
            return readOnce();
        }
        // Another tab holds the lock right now: look again in a moment.
        if (outcome?.why === 'lock_busy' && discardRetries < MAX_DISCARD_RETRIES && retryTimer === null && running) {
            discardRetries += 1;
            retryTimer = setTimer(() => {
                retryTimer = null;
                void probe();
            }, DISCARD_RETRY_MS);
            retryTimer?.unref?.();
        }
        return null;
    }

    async function probe() {
        if (!running) return;
        if (probing) {
            probeAgain = true;
            return;
        }
        probing = true;
        try {
            let read = await readOnce();
            if (!running) return;
            let selection = preview(read);
            if (pinnedByDraft(selection, read)) {
                const after = await retryDiscard(selection, read);
                if (!running) return;
                if (after) {
                    read = after;
                    selection = preview(read);
                }
            } else if (read) {
                // A readable wallet that nothing pins any more (another tab
                // cleared the draft): a later draft is a new pin, counted and
                // retried afresh. An unreadable read says nothing either way.
                pinCounted = false;
                discardRetries = 0;
            }
            facade.watch.setPreview(selection);
        } catch {
            // A decision that cannot be made leaves the last preview in place.
        } finally {
            probing = false;
            if (probeAgain && running) {
                probeAgain = false;
                schedule();
            }
        }
    }

    async function checkBuild() {
        if (!running || latched || checkingBuild) return;
        checkingBuild = true;
        try {
            const build = await bounded(Promise.resolve().then(() => readBuild()), buildTimeoutMs);
            if (!running || latched) return;
            const loaded = facade.active;
            const closes = buildClosesDeposits({
                build,
                network,
                loaded: loaded ? { id: loaded.id, status: loaded.status } : null,
                target: facade.target
            });
            if (closes) {
                latched = true;
                facade.watch.latchStaleBuild();
            }
        } catch {
            // No answer is not an answer: nothing changes.
        } finally {
            checkingBuild = false;
        }
    }

    function listen(target, type, handler) {
        if (!target || typeof target.addEventListener !== 'function') return;
        target.addEventListener(type, handler);
        cleanups.push(() => {
            try { target.removeEventListener(type, handler); } catch { /* already gone */ }
        });
    }

    const onFocus = () => schedule();
    const onVisibility = () => {
        if (documentTarget?.visibilityState === 'hidden') return;
        schedule();
        void checkBuild();
    };
    listen(windowTarget, 'focus', onFocus);
    listen(documentTarget, 'visibilitychange', onVisibility);

    // Receive-only: the SDK's own channel announces every wallet commit.
    let channel = null;
    try {
        channel = createChannel(WALLET_CHANNEL_NAME);
    } catch {
        channel = null;
    }
    if (channel) {
        const onMessage = () => schedule();
        if (typeof channel.addEventListener === 'function') channel.addEventListener('message', onMessage);
        else channel.onmessage = onMessage;
        cleanups.push(() => {
            try {
                if (typeof channel.removeEventListener === 'function') channel.removeEventListener('message', onMessage);
                else channel.onmessage = null;
                channel.close?.();
            } catch { /* already closed */ }
        });
    }

    // The SDK's snapshot changed (or a probe was asked for).
    if (typeof facade.watch.onTrigger === 'function') {
        const stopTrigger = facade.watch.onTrigger(() => schedule());
        cleanups.push(stopTrigger);
    }

    buildTimer = setTimer(function poll() {
        if (!running) return;
        if (documentTarget?.visibilityState !== 'hidden') void checkBuild();
        buildTimer = setTimer(poll, buildPollMs);
        buildTimer?.unref?.();
    }, buildPollMs);
    buildTimer?.unref?.();

    return function stopVersionWatcher() {
        if (!running) return;
        running = false;
        for (const timer of [debounceTimer, retryTimer, buildTimer]) {
            if (timer !== null) clearTimer(timer);
        }
        debounceTimer = null;
        retryTimer = null;
        buildTimer = null;
        while (cleanups.length) cleanups.pop()();
    };
}
