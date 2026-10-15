// Funding addresses of protocol versions other than the one this page loaded.
//
// A Send Ethereum funding address is scoped to one vault
// (`chain:vault:native-eth`) and every protocol version has its own vault, so
// every version has its own browser-held address. After an upgrade the previous
// version's row stays in this browser, but the page only ever shows the scope
// of the SDK it loaded. Leftover ETH at the older address would be stranded.
// This module is the way back to those scopes, under four rules:
//
//   - Discovery is local facts only (rows of the funding store). Nothing here
//     reads a balance or touches the network until the user asks for one, and
//     no function schedules, repeats or caches such a read: the address is
//     linked to the user's IP and time by the RPC provider each time it is read.
//   - A provider of another scope is sweep-only. It returns ETH and replays its
//     own sweeps; it never deposits, exits or claims, and never resumes a
//     transaction through the loaded SDK, which describes another deployment.
//     A deposit, exit or claim another build left saved is never rebroadcast
//     either, but its marker (which blocks the return of the ETH) is released
//     once the network has settled that transaction for good.
//   - Its calldata rules, deployment id and journal belong to that scope's
//     protocol version, not to the loaded one.
//   - Custody is untouched: same rows, same encryption, same Web Lock names.
//     The only new row an explicit gesture can create is the funding address of
//     another version (createScopedFundingProvider(version).ensureAddress()).
import { getAdapter } from '../versioning/adapters/index.mjs';
import { fundingDestination } from './addressFunding.js';
import { AddressFundingProvider, installedVersionContext } from './addressFundingProvider.mjs';
import { createAddressFundingStore } from './addressFundingStore.mjs';

const VAULT = /^0x[0-9a-fA-F]{40}$/;
// A syntactically valid origin that no resolver answers (RFC 2606). It lets a
// scope without a known RPC parse its context for local reads; the transport
// refuses before anything could be sent there.
const NO_RPC_URL = 'https://rpc-unavailable.invalid/';

const failure = (message, code) => Object.assign(new Error(message), { code });

// One store connection for every scope this module opens, as in the main
// provider. Created on first use, so importing this module touches no storage.
let sharedStore = null;
function defaultStore() {
    if (!sharedStore) sharedStore = createAddressFundingStore();
    return sharedStore;
}

// A transaction journal changed in this tab. Other tabs that run this scope
// (the version that owns it, still open) re-read it on the same one-shot notice
// the main provider posts; this tab holds no channel afterwards.
function announceChange(createChannel) {
    try {
        const channel = createChannel?.() ?? (globalThis.window?.BroadcastChannel
            ? new globalThis.window.BroadcastChannel('oa-zkapi-address-funding') : null);
        channel?.postMessage({ changed: true });
        channel?.close?.();
    } catch { /* An optional refresh notice; the durable journal is the authority. */ }
}

function isScopable(version) {
    return Boolean(version) && typeof version.id === 'string' && version.id !== '' && Number.isSafeInteger(version.chainId)
        && version.chainId > 0 && typeof version.vault === 'string' && VAULT.test(version.vault);
}

/** The funding-store scope of a version's native-ETH funding address (what AddressFundingProvider keys its row by). */
export function fundingScopeOf(version) {
    return isScopable(version) ? `${version.chainId}:${version.vault.toLowerCase()}:native-eth` : null;
}

function findVersion(table, scope) {
    const key = typeof scope === 'string' ? scope.toLowerCase() : '';
    const version = (Array.isArray(table) ? table : []).find(entry => fundingScopeOf(entry) === key);
    if (!version) throw failure('This funding address is not part of a known version.', 'address_scope_unknown');
    return version;
}

// The RPC of a version's own network. A retired version keeps no RPC in its
// tombstone, so its network's other versions supply the same public endpoint.
function resolveRpcUrl(version, override, table) {
    const rank = { active: 0, 'exit-only': 1 };
    const siblings = (Array.isArray(table) ? table : [])
        .filter(entry => entry && entry.id !== version.id && entry.chainId === version.chainId && entry.status in rank)
        .sort((left, right) => rank[left.status] - rank[right.status]);
    return [override, version.rpcUrl, ...siblings.map(entry => entry.rpcUrl)]
        .find(url => typeof url === 'string' && url) ?? null;
}

/**
 * A funding-address provider for the vault of `version`, whichever version this
 * page loaded. Its configuration is the registry's (chain, vault, RPC), not the
 * SDK's, so it works while the SDK describes another deployment.
 *
 * deps (all optional): store, locks, transport, crypto, createWallet as for
 * AddressFundingProvider; `rpcUrl` to override the network's endpoint; `table`
 * to look a retired version's network up in (default: the installed table).
 * The provider's protocol, deposit gate and sweep-only mode cannot be
 * overridden.
 */
export function createScopedFundingProvider(version, deps = {}) {
    if (!isScopable(version)) throw failure('This version has no funding address.', 'address_scope_unknown');
    // Throws unknown_adapter for a row whose protocol family this build lacks:
    // a scope whose calldata cannot be judged is not signed for.
    const adapter = getAdapter(version.adapter);
    const { rpcUrl: rpcOverride, table: tableOverride, ...providerDeps } = deps;
    const rpcUrl = resolveRpcUrl(version, rpcOverride, tableOverride ?? installedVersionContext().table);
    // Registry data in the shape of the SDK's `config.funding` (the same fields
    // adapter.fundingFromProfile derives from a reviewed profile).
    const funding = Object.freeze({
        chain_id: version.chainId,
        contract_address: version.vault,
        billing_asset: 'native_eth',
        billing_unit: 'gwei',
        native_asset_wei_per_unit: '1000000000',
        demo_billing_token_address: null,
        demo_rpc_url: rpcUrl ?? NO_RPC_URL
    });
    const closed = { canStart: false, canResume: false, code: 'deposits_closed', successor: null };
    const refuse = async () => {
        throw failure('This funding address belongs to another version of the app.', 'address_scope_retired');
    };
    return new AddressFundingProvider({
        store: providerDeps.store ?? defaultStore(),
        // Another tab's notice would only trigger a local reload; no listener
        // is held for a scope this page does not run.
        createChannel: () => null,
        prepareDepositQuote: refuse,
        resumeTransaction: refuse,
        ...providerDeps,
        ...(rpcUrl ? {} : { transport: async () => {
            throw failure('The payment network for this funding address is not known to this version.', 'address_scope_rpc_unavailable');
        } }),
        getConfig: () => funding,
        protocol: () => ({ adapter, deploymentId: version.deploymentId ?? null, version }),
        depositGate: () => closed,
        sweepOnly: true
    });
}

/**
 * The funding addresses this browser holds for versions other than the loaded
 * one that no longer take deposits (exit-only or retired). Local facts only:
 * rows of the funding store, never an RPC. A scope with no saved row is not
 * listed.
 *
 * o.table     the version table (live versions and tombstones)
 * o.store     a funding store; default the shared one
 * o.activeId  id of the loaded version (default: the installed one), never listed
 * o.deps      provider deps for reading the journal (locks, crypto, ...)
 *
 * Each entry: {versionId, scope, address, pending, lastReturn} where `address`
 * is the saved address (null when its row cannot be read), `pending` whether a
 * signed transaction is saved but unacknowledged, and `lastReturn` the last
 * verified ETH return from the journal. `unreadable` is true when the row could
 * not be read or validated: the entry is still listed so nothing looks empty.
 */
export async function listRetiredScopes({ table, store, activeId, deps = {} } = {}) {
    const versions = Array.isArray(table) ? table : [];
    const loadedId = activeId ?? installedVersionContext().version?.id ?? null;
    const rows = store ?? defaultStore();
    const candidates = versions.filter(version => isScopable(version) && version.id !== loadedId && version.status !== 'active');
    if (!candidates.length) return [];
    let present = null;
    if (typeof rows.keys === 'function') {
        // One read of the key list lets absent scopes be skipped without a load.
        try { present = new Set(await rows.keys()); } catch { present = null; }
    }
    const result = [];
    for (const version of candidates) {
        const scope = fundingScopeOf(version);
        if (present && !present.has(scope)) continue;
        let envelope;
        try { envelope = await rows.load(scope); } catch {
            result.push({ versionId: version.id, scope, address: null, pending: false, lastReturn: null, unreadable: true });
            continue;
        }
        if (!envelope) continue;
        const valid = envelope.format === 'oa-address-wallet' && envelope.scope === scope
            && typeof envelope.address === 'string' && VAULT.test(envelope.address);
        const entry = { versionId: version.id, scope, address: valid ? envelope.address.toLowerCase() : null,
            pending: Boolean(envelope.pendingHash), lastReturn: null, unreadable: !valid };
        if (valid) {
            try {
                // Decrypts and validates the journal locally. Browser custody
                // needs no password; a password-locked row keeps lastReturn null.
                const provider = createScopedFundingProvider(version, { ...deps, store: rows, table: versions });
                await provider.reload();
                entry.lastReturn = provider.lastReturn;
                entry.pending = provider.hasPendingTransaction;
            } catch { entry.unreadable = true; }
        }
        result.push(entry);
    }
    return result;
}

async function openScope({ scope, table, deps }) {
    const version = findVersion(table, scope);
    const provider = createScopedFundingProvider(version, { ...deps, table });
    await provider.reload();
    if (!provider.exists) throw failure('This browser has no funding address for that version.', 'address_missing');
    return { version, provider };
}

/**
 * The ETH balance, in wei, at the funding address of `scope`. One explicit
 * request to the network (chain id, balance, chain id), made only when this
 * function is called; call it from a user gesture and never on a timer. The
 * RPC provider sees the address and the time of the request, and can join it
 * to this browser's other requests: the user is told so before the check.
 */
export async function checkRetiredScopeBalance({ scope, table, deps = {} } = {}) {
    const { provider } = await openScope({ scope, table, deps });
    const status = await provider.getStatus();
    if (!status.address || !/^\d+$/.test(String(status.ethBalance))) {
        throw failure('The balance of this funding address could not be read.', 'address_balance_unavailable');
    }
    return { balanceWei: String(status.ethBalance) };
}

/**
 * Returns all ETH at the funding address of `scope` to `destination`: one
 * signed, journaled transfer of the whole balance less its own fee, through the
 * same path as "Return leftover ETH". An explicit user action; the destination
 * must be an address of the user's choosing (a wallet, or the funding address of
 * the loaded version). It is never a registered vault, never the scope's own
 * address, never the zero address. Resolves to {transactionHash}; the sweep is
 * confirmed later by recoverRetiredScope.
 */
export async function sweepRetiredScope({ scope, table, destination, deps = {} } = {}) {
    const { version, provider } = await openScope({ scope, table, deps });
    if (!provider.unlocked) {
        throw failure('This funding address needs its backup password before it can return ETH.', 'address_locked');
    }
    const funding = (await provider.context()).funding;
    const vaults = (Array.isArray(table) ? table : []).map(entry => entry?.vault).filter(vault => typeof vault === 'string');
    // Not fundingDestination's default list: the loaded version's own funding
    // address is a legitimate target here. Registered vaults never are.
    const to = fundingDestination(destination, funding, { denied: vaults });
    if (to.toLowerCase() === String(provider.state.address).toLowerCase()) {
        throw failure('Choose a different address to receive this ETH.', 'address_invalid');
    }
    const transactionHash = await provider.withAuthorizedAction(
        { kind: 'sweep', destination: to, asset: 'eth', amount: 'max' },
        () => provider.transferEth(to, 'max'));
    announceChange(deps.createChannel);
    return { versionId: version.id, transactionHash };
}

/**
 * Checks, and if the network does not know it rebroadcasts, the saved sweep of
 * `scope`: the only transaction a funding address of another version may
 * replay. An explicit action (it reads the network). Resolves to
 * {transactionHash, status: 'pending'|'confirmed'|'reverted'} or null when
 * nothing is saved.
 *
 * A saved deposit, exit or claim started by another version's build is never
 * rebroadcast or resumed from here. Its receipt (or, with none, the address's
 * finalized transaction count) is read, and its marker released once the
 * network has settled it for good, so the ETH at the address can be returned:
 * {transactionHash, status: 'released', kind, finalState:
 * 'confirmed'|'reverted'|'replaced'}. While its receipt is not final it
 * resolves to {transactionHash, status: 'pending'}; a transaction the network
 * has not seen and no nonce has displaced rejects with address_scope_retired
 * (only that build can finish it).
 */
export async function recoverRetiredScope({ scope, table, deps = {} } = {}) {
    const { provider } = await openScope({ scope, table, deps });
    const outcome = (await provider.recoverPending()) ?? null;
    if (outcome) announceChange(deps.createChannel);
    return outcome;
}
