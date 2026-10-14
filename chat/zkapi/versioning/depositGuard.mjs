// "No new deposits on a version that no longer accepts them", enforced where
// the SDK would otherwise start one.
//
// The pinned legacy SDK ignores the profile's `trusted_deployment.deposits`
// flag, so a version the registry has closed would happily take a new deposit
// from any code path that reaches it. This module is one of the host's four
// layers (docs/ZKAPI_VERSIONING.md): it wraps the SDK singletons' deposit
// ENTRY POINTS so a refusal happens before any RPC call, IndexedDB write or
// wallet prompt.
//
// What is wrapped is data, not a hard-coded list, and the rule is
// deny-by-default. The adapter of the loaded version names its
// `depositEntryPoints` (methods that begin or quote a new deposit) and its
// `recoveryEntryPoints` (every other /deposit/i method that is known to be
// safe: confirmation, retry, recovery, reads). Every /deposit/i function on
// the two singletons that the adapter does NOT name as a recovery entry point
// is wrapped, whether or not it is listed as a deposit entry point, so a
// method an SDK adds or renames cannot start a deposit on a closed version
// just because nobody has classified it yet. Recovery entry points are NEVER
// wrapped, so a deposit that already started always stays completable and
// recoverable. `unclassifiedDepositMethods` is the drift detector: a
// /deposit/i method that neither list names is reported, and now means
// "wrapped by default: classify it" (the guard test runs it against the real
// SDK singletons, and boot logs the names).
//
// Wrappers are instance-level own properties on the two singletons, not a
// Proxy: `instanceof`, the EventTarget brand and every unrelated member stay
// exactly as they were, and uninstall restores the previous state.
//
// Allow rule. A call passes when the gate says new deposits may start. When
// they may not, it passes only if it continues a deposit that already
// STARTED in this wallet (a plan carrying a submission claim, hash or
// attempt; never a plan that was only prepared), for the SAME amount and the
// SAME prepared operation. A method the adapter does not classify has no
// arguments the guard can compare, so for it "continues a started deposit"
// means only that one exists: it is what lets a started deposit's own
// internal helper calls through, and nothing else (with no started deposit it
// is refused like any other entry point). The pending plan is read from
// memory (`runtime.runtime`), never through `runtime.pendingDeposit()`, which
// initializes, takes the wallet lock and may commit: a refusal must not do
// any of that.
import { isUnsentPreparedDeposit } from './unsentDeposit.mjs';
import { getActiveVersion, getSelection } from './activeVersion.mjs';
import { gateCopyKey, versionCopyText, versionName } from './copy.mjs';

const WRAPPED = new WeakMap();

/** The error every refused deposit entry point rejects with. */
export class DepositsClosedError extends Error {
    /**
     * @param {string} [message]
     * @param {{versionId?: string|null, successorId?: string|null,
     *   closedSince?: number|null, gateCode?: string|null}} [data]
     */
    constructor(message = 'This version no longer accepts new deposits.', data = {}) {
        super(message);
        this.name = 'DepositsClosedError';
        this.code = 'deposits_closed';
        this.status = 409;
        this.data = {
            versionId: data.versionId ?? null,
            successorId: data.successorId ?? null,
            closedSince: data.closedSince ?? null,
            gateCode: data.gateCode ?? null
        };
    }
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The gate is read on every call. A gate that throws or returns something that
// is not a gate closes deposits: the only way through is an explicit
// `canStart === true`.
function readGate(getGate) {
    try {
        const gate = getGate();
        if (isRecord(gate)) return gate;
    } catch { /* closed below */ }
    return { canStart: false, canResume: false, code: 'version_unavailable', successor: null };
}

// Decimal text with at most `decimals` fraction digits as a safe integer, or
// null. The SDK parses deposit amounts the same way (`parseUnits`).
function decimalToUnits(value, decimals) {
    const match = new RegExp(`^(\\d+)(?:\\.(\\d{0,${decimals}}))?$`).exec(String(value).trim());
    if (!match) return null;
    const units = BigInt(match[1]) * 10n ** BigInt(decimals)
        + BigInt((match[2] || '').padEnd(decimals, '0') || '0');
    return units <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(units) : null;
}

// What a call asks for, in the pending plan's units. `amount: null` means the
// call carries no amount that is comparable with a plan (a USD price quote);
// NaN means it carries one that cannot be read, which never matches.
function readRequest(side, name, args, client) {
    const none = { amount: null, operationId: null };
    if (side === 'runtime') {
        if (name === 'prepareDeposit') {
            const options = isRecord(args[1]) ? args[1] : {};
            return { amount: Number(args[0]), operationId: options.preparedOperationId ?? null };
        }
        if (name === 'prepareDepositQuote') return { amount: Number(args[0]), operationId: null };
        return none;
    }
    // Client entry points take a decimal text in the funding asset's unit:
    // gwei for native ETH (every deployment this host ships), six decimals for
    // a token deployment. Before the SDK has a configuration there is nothing
    // to say otherwise, so native ETH is assumed.
    let decimals = 9;
    try {
        if (client?.config?.funding && client.isNativeEthFunding !== true) decimals = 6;
    } catch { /* keep the native unit */ }
    const parsed = () => {
        const units = decimalToUnits(args[0], decimals);
        return units === null ? Number.NaN : units;
    };
    if (name === 'deposit' || name === 'performDeposit') {
        const options = isRecord(args[2]) ? args[2] : {};
        return { amount: parsed(), operationId: options.preparedOperationId ?? null };
    }
    if (name === 'prepareDepositQuote') return { amount: parsed(), operationId: null };
    // quoteDepositUsd(usd) and anything unknown: a price read, no plan fields.
    return none;
}

// Whether the call continues a deposit that already started.
function continuesStartedDeposit(runtime, request) {
    const slot = runtime?.runtime;
    const pending = isRecord(slot) && isRecord(slot.pendingDeposit) ? slot.pendingDeposit : null;
    if (pending === null) return false;
    // A plan that was only prepared holds no funds and no chain footprint. It
    // is not something a closed version should finish.
    if (isUnsentPreparedDeposit(slot)) return false;
    if (request.amount !== null && Number(request.amount) !== Number(pending.amount)) return false;
    if (request.operationId !== null && request.operationId !== undefined
        && request.operationId !== pending.operationId) {
        return false;
    }
    return true;
}

// The slot belongs to a deployment this build retired. A reload cannot change
// that, so the refusal must not tell the person to try again (the generic
// foreign-runtime wording ends in "Reload to try again").
function slotOwnerRetired() {
    try {
        return getSelection()?.reason === 'retired_deployment';
    } catch {
        return false;
    }
}

function refusal(gate, version) {
    const successor = isRecord(gate.successor) ? gate.successor : null;
    const key = gateCopyKey({ ...gate, canStart: false }, { retired: slotOwnerRetired() }) || 'deposits.closed';
    const tokens = {};
    const successorName = successor ? versionName(successor) : '';
    const loadedName = version ? versionName(version) : '';
    if (successorName) tokens.N = successorName;
    if (loadedName) tokens.F = loadedName;
    return new DepositsClosedError(versionCopyText(key, tokens) || undefined, {
        versionId: version?.id ?? null,
        successorId: successor?.id ?? null,
        closedSince: Number.isFinite(version?.depositsClosedSince) ? version.depositsClosedSince : null,
        gateCode: typeof gate.code === 'string' ? gate.code : null
    });
}

function listed(entryPoints, side) {
    const names = entryPoints?.[side];
    return Array.isArray(names) ? names.filter(name => typeof name === 'string' && name) : [];
}

/**
 * Wrap the deposit entry points of the two SDK singletons: every name in
 * `adapter.depositEntryPoints`, and every other `/deposit/i` function the
 * singleton has (own or inherited, never a getter) that
 * `adapter.recoveryEntryPoints` does not name.
 *
 * @param {{client: object, runtime: object, adapter: object,
 *   getGate: () => object, version?: object|null}} options
 *   `adapter.depositEntryPoints` is `{client: string[], runtime: string[]}`,
 *   `adapter.recoveryEntryPoints` the same shape (optional: without it every
 *   `/deposit/i` function is wrapped). `getGate` returns the facade's
 *   DepositGate on every call. `version` defaults to the installed active
 *   version (error data and copy only).
 * @returns {() => void} uninstall (tests, hot reload). The function also has a
 *   `wrapped` property `{client: string[], runtime: string[]}` naming the
 *   methods it guarded.
 */
export function installDepositGuard({ client, runtime, adapter, getGate, version } = {}) {
    if (!client || typeof client !== 'object') throw new TypeError('The deposit guard needs the SDK client.');
    if (!runtime || typeof runtime !== 'object') throw new TypeError('The deposit guard needs the SDK runtime.');
    if (!adapter || !isRecord(adapter.depositEntryPoints)) {
        throw new TypeError('The deposit guard needs an adapter that names its deposit entry points.');
    }
    if (typeof getGate !== 'function') throw new TypeError('The deposit guard needs a gate reader.');

    const restorers = [];
    const wrapped = { client: [], runtime: [] };
    const targets = { client, runtime };

    for (const side of ['client', 'runtime']) {
        const target = targets[side];
        const recovery = new Set(listed(adapter.recoveryEntryPoints, side));
        // The listed entry points always (in the adapter's order), then every
        // other deposit-named function that is not a known-safe recovery or
        // read method. A name listed as BOTH is an adapter mistake and is
        // guarded: the refusal is the safe side of that conflict.
        const explicit = listed(adapter.depositEntryPoints, side);
        const names = [...explicit];
        for (const name of depositMethodNames(target)) {
            if (!recovery.has(name) && !explicit.includes(name)) names.push(name);
        }
        for (const name of names) {
            let original;
            try {
                original = target[name];
            } catch {
                // A getter that throws is not a method; nothing to wrap.
                continue;
            }
            // A method this SDK generation does not have needs no guard; the
            // drift test catches a rename (the new name is unclassified).
            if (typeof original !== 'function') continue;
            // Never wrap twice: a second install over the same singleton
            // keeps one wrapper per method.
            if (WRAPPED.has(original)) continue;

            const own = Object.getOwnPropertyDescriptor(target, name);
            const guarded = function guardedDepositEntryPoint(...args) {
                let refused = null;
                try {
                    const gate = readGate(getGate);
                    if (gate.canStart !== true
                        && !continuesStartedDeposit(runtime, readRequest(side, name, args, client))) {
                        refused = refusal(gate, version ?? getActiveVersion());
                    }
                } catch {
                    // Anything unexpected while deciding closes the entry
                    // point; the person sees the same plain refusal.
                    refused = new DepositsClosedError(undefined, { gateCode: 'version_unavailable' });
                }
                if (refused) return Promise.reject(refused);
                return original.apply(this === undefined ? target : this, args);
            };
            WRAPPED.set(guarded, original);
            Object.defineProperty(target, name, {
                value: guarded, writable: true, configurable: true, enumerable: false
            });
            restorers.push(() => {
                if (target[name] !== guarded) return;
                if (own) Object.defineProperty(target, name, own);
                else delete target[name];
            });
            wrapped[side].push(name);
        }
    }

    const uninstall = () => {
        while (restorers.length) restorers.pop()();
    };
    uninstall.wrapped = wrapped;
    return uninstall;
}

/**
 * Names of the `/deposit/i` methods on `target` (own or inherited, excluding
 * Object and EventTarget), sorted. Getters are never read.
 *
 * @param {object} target an SDK client or runtime
 * @returns {string[]}
 */
export function depositMethodNames(target) {
    const names = new Set();
    const stop = new Set([Object.prototype]);
    if (typeof EventTarget === 'function') stop.add(EventTarget.prototype);
    for (let object = target; object && !stop.has(object); object = Object.getPrototypeOf(object)) {
        for (const name of Object.getOwnPropertyNames(object)) {
            if (name === 'constructor' || !/deposit/i.test(name)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(object, name);
            if (descriptor && typeof descriptor.value === 'function') names.add(name);
        }
    }
    return [...names].sort();
}

/**
 * The drift detector: `/deposit/i` methods of `target` that are named in
 * neither list. The guard wraps such a method anyway (deny by default), so
 * this reports what is refused on a closed version without having been
 * decided: a new SDK method that starts a deposit should be listed as a
 * deposit entry point, and one that only reads or recovers must be listed as
 * recovery so it is never refused.
 *
 * @param {object} target an SDK client or runtime
 * @param {{guarded?: string[], recovery?: string[]}} lists
 * @returns {string[]}
 */
export function unclassifiedDepositMethods(target, { guarded = [], recovery = [] } = {}) {
    const known = new Set([...guarded, ...recovery]);
    return depositMethodNames(target).filter(name => !known.has(name));
}

/**
 * `unclassifiedDepositMethods` for both singletons against an adapter's data.
 *
 * @param {{client: object, runtime: object, adapter: object}} options
 * @returns {{client: string[], runtime: string[]}}
 */
export function unclassifiedDepositEntryPoints({ client, runtime, adapter }) {
    const lists = side => ({
        guarded: listed(adapter?.depositEntryPoints, side),
        recovery: listed(adapter?.recoveryEntryPoints, side)
    });
    return {
        client: unclassifiedDepositMethods(client, lists('client')),
        runtime: unclassifiedDepositMethods(runtime, lists('runtime'))
    };
}
