import { Wallet, Transaction, getAddress, getBytes, keccak256, formatEther } from 'ethers';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import browserWalletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import { browserSdkTransport } from '@openanonymity/zkapi-browser-sdk/configure';
import { bufferedGasLimit, MAX_TRANSACTION_GAS_LIMIT as MAX_GAS } from '@openanonymity/zkapi-browser-sdk/gas';
import { getActiveAdapter, getActiveVersion, getVersionTable } from '../versioning/activeVersion.mjs';
import { noteBoundV1 } from '../versioning/adapters/noteBoundV1.mjs';
import { withdrawalCallNoteId } from '../versioning/callFields.mjs';
import { createAddressFundingStore, isBrowserCustodyKey } from './addressFundingStore.mjs';
import { withWalletProviderRead } from './walletProviderAccess.mjs';
import { SPONSORED_NOT_CONFIRMED_REFUSAL } from '../versioning/sponsored.mjs';
import { SPONSORED_REFUSAL_MESSAGE, SponsoredOperationError, judgeSponsoredOperation, readSponsoredPins } from './sponsoredOperation.mjs';

const UINT256_MAX = (1n << 256n) - 1n;
const MAX_NONCE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_PRIORITY_FEE = 1_000_000n; // 0.001 gwei; also retained for existing journal validation.
const LOW_FEE_HISTORY_BLOCKS = 20;
const LOW_FEE_REWARD_PERCENTILE = 10;
const MAX_FEE_BLOCK_AGE_SECONDS = 120n;
const MAX_FEE_BLOCK_FUTURE_SECONDS = 30n;
const NATIVE_WEI_PER_UNIT = 1_000_000_000n; // The native vault's private ledger uses gwei.
const FEE_QUOTE_LIFETIME_MS = 30_000;
const KDF_ITERATIONS = 600_000;
const MAX_BACKUP_BYTES = 4 * 1024 * 1024;
const READ_METHODS = new Set([
    'eth_call', 'eth_estimateGas', 'eth_getTransactionCount', 'eth_getBalance',
    'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_blockNumber', 'eth_getTransactionByHash',
    'eth_getTransactionReceipt', 'eth_getCode', 'eth_getLogs', 'eth_gasPrice',
    'eth_maxPriorityFeePerGas', 'eth_feeHistory'
]);
// The bundler methods the sponsored transport forwards. Anything else is
// refused: it is a route to an operator's service, not a generic RPC.
const BUNDLER_METHODS = new Set(['eth_chainId', 'eth_supportedEntryPoints', 'eth_estimateUserOperationGas',
    'eth_sendUserOperation', 'eth_getUserOperationByHash', 'eth_getUserOperationReceipt',
    'rundler_maxPriorityFeePerGas', 'pimlico_getUserOperationGasPrice']);
// Signatures one sponsored action may ask for: the first, then a raise of both
// fee fields (12.5% each, within the paymaster's ceilings), then a proof that
// had to be made again. A bound, not a promise: the SDK stops long before it.
const MAX_SPONSORED_SIGNATURES = 12;
const BUNDLER_TIMEOUT_MS = 20_000;
const RECOVERY_FIELDS = new Set(['version', 'kind', 'deploymentId', 'chainId', 'contractAddress',
    'recordId', 'operationId', 'submissionId', 'generation', 'noteId', 'mode', 'destination',
    'finalBalance', 'clearanceReserved', 'withdrawalNullifier', 'amount', 'commitment']);
const HASH = /^0x[0-9a-fA-F]{64}$/;
const hex = value => `0x${value.toString(16)}`;
const word = value => uint(value, 'amount').toString(16).padStart(64, '0');
const sameAddress = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const copy = value => value == null ? value : structuredClone(value);
const bytes64 = bytes => btoa(String.fromCharCode(...bytes));
const from64 = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));
const encoder = new TextEncoder();

function fail(message, code = 'address_funding_error') { return Object.assign(new Error(message), { code }); }
function uint(value, label, maximum = UINT256_MAX) {
    if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value))
        && !(typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value))) throw fail(`Invalid ${label}.`);
    const result = BigInt(value);
    if (result < 0n || result > maximum) throw fail(`Invalid ${label}.`);
    return result;
}
function feeQuantity(value, maximum = UINT256_MAX) {
    // JSON-RPC quantities must be bounded hexadecimal strings, including zero.
    if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)) throw fail('Invalid network fee data.');
    return uint(value, 'network fee data', maximum);
}
function lowPriorityFee(history, blockNumber, baseFee) {
    const count = Number(blockNumber + 1n < BigInt(LOW_FEE_HISTORY_BLOCKS) ? blockNumber + 1n : BigInt(LOW_FEE_HISTORY_BLOCKS));
    if (!history || typeof history !== 'object'
        || !Array.isArray(history.reward) || history.reward.length !== count
        || !Array.isArray(history.baseFeePerGas) || history.baseFeePerGas.length !== count + 1
        || !Array.isArray(history.gasUsedRatio) || history.gasUsedRatio.length !== count
        || feeQuantity(history.oldestBlock, MAX_NONCE) + BigInt(count) - 1n !== blockNumber) throw fail('Invalid network fee history.');
    const bases = history.baseFeePerGas.map(value => feeQuantity(value));
    if (bases[count - 1] !== baseFee) throw fail('Mismatched network fee history.');
    const rewards = [];
    for (let index = 0; index < count; index += 1) {
        const row = history.reward[index];
        const ratio = history.gasUsedRatio[index];
        if (!Array.isArray(row) || row.length !== 1 || typeof ratio !== 'number'
            || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw fail('Invalid network fee history.');
        const reward = feeQuantity(row[0]);
        if (ratio === 0 && reward !== 0n) throw fail('Invalid empty-block reward.');
        // Empty blocks report zero rewards but provide no evidence of low bids.
        if (ratio > 0) rewards.push(reward);
    }
    if (!rewards.length) return MIN_PRIORITY_FEE;
    rewards.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const middle = Math.floor(rewards.length / 2);
    const median = rewards.length % 2 ? rewards[middle] : (rewards[middle - 1] + rewards[middle]) / 2n;
    return median < MIN_PRIORITY_FEE ? MIN_PRIORITY_FEE : median;
}
function address(value) {
    try {
        const result = getAddress(value);
        if (/^0x0{40}$/i.test(result)) throw new Error();
        return result.toLowerCase();
    } catch { throw fail('Enter a valid, nonzero Ethereum address.', 'address_invalid'); }
}
function aad(envelope) {
    if (envelope.version === 2) return encoder.encode(JSON.stringify([envelope.format, envelope.version,
        envelope.scope, envelope.address, envelope.backedUp, envelope.pendingHash, envelope.custody, envelope.keyId]));
    return encoder.encode(JSON.stringify([envelope.format, envelope.version, envelope.scope,
        envelope.address, envelope.backedUp, envelope.pendingHash, envelope.salt, envelope.iterations]));
}

// Whether `conceded` (the escape's concession word, gwei) is within what the
// person confirmed. The authorization carries either or both of:
//   conceded     the exact amount (a plan that already exists, or a forced
//                escape the person chose to concede)
//   concededMax  a cap: the largest amount a settling chat could still cost,
//                disclosed before the click, for an escape the SDK may
//                convert or force and whose amount is only known at proof time
// With both, both must hold. With neither the escape concedes nothing. A
// malformed value throws instead of passing.
function concessionConfirmed(conceded, authorization) {
    const exact = authorization.conceded == null ? null : uint(authorization.conceded, 'conceded amount');
    const cap = authorization.concededMax == null ? null : uint(authorization.concededMax, 'conceded cap');
    if (exact === null && cap === null) return conceded === 0n;
    return (exact === null || conceded === exact) && (cap === null || conceded <= cap);
}

// Said when the SDK has prepared an emergency exit that gives up more than the
// person was shown and confirmed, or anything at all when no figure was shown.
// The signer never reads the SDK's saved plan to decide what was agreed to (it
// records what the SDK proved, not what anyone confirmed), so a plan that is
// continued after a reload, once the figure on screen has fallen away, or that
// was proved again at a larger figure than the one shown, is stopped here,
// before anything is signed or sent. The way on is one the dialog has: start
// the withdrawal again, which shows what it gives up before it goes ahead.
// The words do not name a button: the SDK takes a refusal coded 4100 for a
// send that never reached the network and clears an escape plan that reserved
// no clearance itself, before these words are restored, so by the time they
// are read there is usually no unfinished withdrawal left to cancel. Plain
// words; code 4100 as for every refusal of the signer, so the SDK still counts
// it as sent to no one.
export const CONCESSION_UNCONFIRMED_MESSAGE = 'This emergency exit would give up more of your balance than you were shown, '
    + 'so nothing was sent. Start the withdrawal again from the beginning to see what it gives up.';

// The concession a call to the vault carries, read from its calldata the same
// way validateCall reads it: the word the profile's escape exit names, as a
// bigint. Null for any call that is not an exit of a profile that concedes.
function calldataConcession(profile, data) {
    if (typeof data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(data)) return null;
    const normalized = data.toLowerCase();
    const exit = profile.exits.find(entry => entry.selector === normalized.slice(2, 10));
    if (!exit || exit.concededWord === null || normalized.length !== 10 + exit.words * 64) return null;
    const words = normalized.slice(10).match(/.{1,64}/g) || [];
    try { return uint(`0x${words[exit.concededWord] || ''}`, 'conceded amount'); } catch { return null; }
}

const sameNote = (left, right) => left != null && right != null && String(left) === String(right);
// How many accepted escapes a provider remembers for the page session.
const MAX_ACCEPTED_CONCESSIONS = 16;

function publicPending(entry) {
    if (!entry) return null;
    return { hash: entry.hash, transaction: copy(entry.transaction), context: copy(entry.context), kind: entry.kind };
}

function lastReturn(record) {
    for (let index = (record?.transactions.length ?? 0) - 1; index >= 0; index--) {
        const entry = record.transactions[index];
        if (entry.kind === 'sweep' && entry.outcome) {
            return { transactionHash: entry.hash, status: entry.outcome.status,
                destination: entry.authorization.destination, asset: entry.authorization.asset,
                amount: entry.authorization.amount };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Installed protocol version
// ---------------------------------------------------------------------------
//
// Which vault calls the signer accepts follows the protocol family of the
// version the page loaded (its adapter's call profile). Boot installs that
// version once (versioning/activeVersion.mjs, SDK-free). A page that never
// installs one (the SDK-default build, a build without versioning, any test)
// reads null and runs with the note-bound-v1 profile, which is exactly the
// profile this signer always had.

const NO_VERSION = Object.freeze({ version: null, adapter: null, table: Object.freeze([]) });

/** The installed version, its protocol adapter and the version table. All empty without versioning. */
export function installedVersionContext() {
    const version = getActiveVersion();
    if (!version) return NO_VERSION;
    // getActiveAdapter throws unknown_adapter for a row this build cannot
    // judge. That propagates: a protocol whose calls are unknown is not signed.
    return { version, adapter: getActiveAdapter(), table: getVersionTable() };
}

// The default signer follows the page's version and its deposit gate. The gate
// is the facade boot attaches to the SDK client (zkapiClient.oaVersioning);
// reading it through the client keeps this module free of the facade's imports.
const installedProtocol = () => {
    const { version, adapter } = installedVersionContext();
    return { adapter, deploymentId: version?.deploymentId ?? null, version };
};
const installedDepositGate = () => zkapiClient.oaVersioning?.depositGate?.() ?? null;

// The gasless contracts the loaded profile pins, read by this host (null when
// it pins none or the page has no profile). A profile this host cannot read is
// "none": nothing is signed for it.
function installedSponsoredPins() {
    try { return readSponsoredPins(browserWalletRuntime.browserConfig?.trusted_deployment); } catch { return null; }
}
// The same-origin route of the loaded version's bundler (the facade computes
// it from the version table). null: sponsored withdrawals are not offered here.
const installedBundlerUrl = () => {
    try { return zkapiClient.oaVersioning?.sponsored?.bundlerUrl?.() ?? null; } catch { return null; }
};

function depositsClosedError(gate, version) {
    const error = fail(gate?.code === 'reload_required'
        ? 'This page is out of date. Reload to continue. Nothing was sent.'
        : 'This version no longer accepts new deposits. Nothing was sent.', 'deposits_closed');
    error.status = 409;
    error.data = { gateCode: gate?.code ?? null, versionId: version?.id ?? null,
        successorId: gate?.successor?.id ?? null, closedSince: version?.depositsClosedSince ?? null };
    return error;
}

/** Browser-owned EIP-1193 signer. Only ensureAddress creates custody; no RPC,
 * initialization or status read signs transactions. Web Locks serialize custody
 * and nonce changes across tabs. The SDK owns private-note state/finality.
 *
 * Options beyond the transports and stores:
 *   protocol     () => {adapter, deploymentId, version}: whose call profile and
 *                deployment id this scope signs for. Default: the page's version.
 *   depositGate  () => DepositGate|null: whether a deposit may start or resume.
 *                Default: the facade boot attaches to the SDK client.
 *   sweepOnly    a provider for a scope other than the loaded version's: it can
 *                return ETH and replay its own sweeps, and release another
 *                build's saved transaction once the network has settled it for
 *                good (never resume or rebroadcast it), nothing else. */
export class AddressFundingProvider {
    constructor({
        getConfig = () => zkapiClient.config?.funding,
        transport = browserSdkTransport,
        store = createAddressFundingStore(),
        locks = globalThis.navigator?.locks,
        crypto = globalThis.crypto,
        createWallet = () => Wallet.createRandom(),
        prepareDepositQuote = null,
        resumeTransaction = record => zkapiClient.resumeExternalTransaction(record),
        createChannel = () => globalThis.window?.BroadcastChannel
            ? new globalThis.window.BroadcastChannel('oa-zkapi-address-funding') : null,
        protocol = installedProtocol,
        depositGate = installedDepositGate,
        sweepOnly = false,
        sponsoredPins = installedSponsoredPins,
        bundlerUrl = installedBundlerUrl
    } = {}) {
        Object.assign(this, { getConfig, transport, store, locks, crypto, createWallet, prepareDepositQuote, resumeTransaction, createChannel,
            protocol, depositGate, sweepOnly, sponsoredPins, bundlerUrl });
        this.prepareDepositQuote = prepareDepositQuote || ((ethAmount, options, { isCurrent } = {}) =>
            withWalletProviderRead(zkapiClient, this, () => zkapiClient.prepareDepositQuote(ethAmount, options), { isCurrent }));
        this.state = { exists: false, unlocked: false, backedUp: false, address: null, pending: null, migrationRequired: false };
        // operationId -> { noteId, conceded }: escapes this page session has
        // accepted for signing (see continuedAuthorization). Memory only.
        this.acceptedConcessions = new Map();
        this.listeners = new Set();
        this.session = null;
        this.action = null;
        this.channel = null;
        this.rpcId = 0;
        this.initialized = false;
    }

    get exists() { return this.state.exists; }
    get unlocked() { return this.state.unlocked; }
    get backedUp() { return this.state.backedUp; }
    get address() { return this.state.backedUp ? this.state.address : null; }
    get pending() { return copy(this.state.pending); }
    get lastReturn() { return copy(this.state.lastReturn ?? null); }
    get migrationRequired() { return Boolean(this.state.migrationRequired); }
    get hasPendingTransaction() { return Boolean(this.state.pending); }
    get waiting() { return Boolean(this.action); }

    async init() {
        if (!this.initialized) {
            this.initialized = true;
            try {
                this.channel = this.createChannel();
                if (this.channel) this.channel.onmessage = () => { void this.reload().catch(() => this.lock()); };
            } catch { /* Durable writes and Web Locks own exclusion, notices do not. */ }
        }
        // The selected provider is installed before SDK initialization supplies config.
        if (await this.getConfig()) await this.reload();
        return this;
    }

    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    notify() {
        for (const listener of this.listeners) {
            try { listener({ ...copy(this.state), address: this.address, waiting: this.waiting }); } catch { /* UI cannot undo persistence. */ }
        }
    }
    changed() {
        this.notify();
        try { this.channel?.postMessage({ changed: true }); } catch { /* Optional refresh notice. */ }
    }
    lock() { this.session = null; this.state.unlocked = false; this.notify(); }

    async context() {
        const funding = await this.getConfig();
        if (!funding) throw fail('Payment settings are not ready. Try again in a moment.', 'address_not_ready');
        const chainId = uint(funding.chain_id, 'payment network', MAX_NONCE);
        if (!chainId) throw fail('Invalid payment network.');
        const vault = address(funding.contract_address);
        if (funding.billing_asset !== 'native_eth' || funding.billing_unit !== 'gwei'
            || uint(funding.native_asset_wei_per_unit, 'native payment scale') !== NATIVE_WEI_PER_UNIT) {
            throw fail('The native ETH payment settings are invalid.', 'address_native_config');
        }
        let rpc;
        try { rpc = new URL(funding.demo_rpc_url, globalThis.location?.href); } catch { throw fail('The payment network is unavailable.'); }
        if (rpc.username || rpc.password || (rpc.protocol !== 'https:'
            && !(rpc.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname)))) {
            throw fail('The payment network connection must use HTTPS.');
        }
        return { funding, chainId, vault, weiPerUnit: NATIVE_WEI_PER_UNIT,
            rpc: rpc.href, scope: `${chainId}:${vault}:native-eth` };
    }

    async locked(ctx, callback, action = false) {
        if (!this.locks?.request) throw fail('This browser needs Web Locks support to safely manage a payment address.', 'address_storage');
        return this.locks.request(`oa-zkapi-address:${action ? 'action:' : ''}${ctx.scope}`,
            { mode: 'exclusive', ...(action ? { ifAvailable: true } : {}) }, lock => {
                if (action && !lock) throw fail('Another tab is using this payment address. Wait for that action to finish.', 'address_busy');
                return callback();
            });
    }

    // The call profile and deployment id this scope signs for. Without an
    // installed version that is the legacy profile and no deployment pin.
    signerProtocol() {
        const { adapter, deploymentId, version } = this.protocol();
        return { profile: adapter?.callProfile ?? noteBoundV1.callProfile, deploymentId: deploymentId ?? null, version: version ?? null };
    }

    // Throws unless a deposit may start (or an already started one may resume)
    // on this version. Only an explicit allow from an installed gate passes: a
    // gate that fails, or answers false, 0, '' or anything that is not an object
    // carrying canStart/canResume === true, refuses. Only no gate at all (null
    // or undefined: no versioning) is no restriction. Applies to new signatures
    // only: a deposit already in the journal stays valid whatever the gate says
    // today.
    assertDepositMayStart() {
        let gate = null;
        let allowed = false;
        try {
            gate = this.depositGate?.() ?? null;
            allowed = gate === null
                || (typeof gate === 'object' && (gate.canStart === true || gate.canResume === true));
        } catch {
            gate = { canStart: false, canResume: false, code: null };
            allowed = false;
        }
        if (allowed) return;
        throw depositsClosedError(gate, this.signerProtocol().version);
    }

    validateEnvelope(envelope, ctx) {
        try {
            if (!envelope || envelope.format !== 'oa-address-wallet' || ![1, 2].includes(envelope.version)
                || envelope.scope !== ctx.scope
                || address(envelope.address) !== envelope.address
                || typeof envelope.backedUp !== 'boolean'
                || !(envelope.pendingHash === null || HASH.test(envelope.pendingHash))
                || from64(envelope.iv).length !== 12
                || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > MAX_BACKUP_BYTES
                || from64(envelope.ciphertext).length < 16) throw new Error();
            if (envelope.version === 1 && (envelope.iterations !== KDF_ITERATIONS || from64(envelope.salt).length !== 16)) throw new Error();
            if (envelope.version === 2 && (envelope.custody !== 'browser' || envelope.backedUp !== true
                || from64(envelope.keyId).length !== 16 || !isBrowserCustodyKey(envelope.browserKey))) {
                throw fail('The saved payment-address key is missing or damaged. Keep this browser data intact.', 'address_browser_key');
            }
        } catch (error) {
            if (error.code === 'address_browser_key') throw error;
            throw fail('Saved payment-address data is invalid or belongs to another payment network.', 'address_backup_invalid');
        }
    }

    async deriveKey(password, salt) {
        if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
            throw fail('Use a password with at least 12 characters for your encrypted payment-address backup.', 'address_password');
        }
        if (!this.crypto?.subtle) throw fail('Secure browser encryption is unavailable.', 'address_storage');
        const base = await this.crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
        return this.crypto.subtle.deriveKey({ name: 'PBKDF2', salt: from64(salt), iterations: KDF_ITERATIONS, hash: 'SHA-256' },
            base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    async decrypt(envelope, key, ctx) {
        this.validateEnvelope(envelope, ctx);
        let record;
        try {
            const clear = await this.crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(envelope.iv), additionalData: aad(envelope) }, key, from64(envelope.ciphertext));
            record = JSON.parse(new TextDecoder().decode(clear));
        } catch {
            if (envelope.version === 2) throw fail('The saved payment-address key cannot read this browser’s wallet data. Keep the data intact.', 'address_browser_key');
            throw fail('The password is incorrect or the encrypted backup is damaged.', 'address_unlock');
        }
        this.validateRecord(record, envelope, ctx);
        return record;
    }

    validateRecord(record, envelope, ctx) {
        try {
            if (record.version !== 1 || record.scope !== ctx.scope || !HASH.test(record.privateKey)
                || !sameAddress(new Wallet(record.privateKey).address, envelope.address)
                || record.address !== envelope.address || record.backedUp !== envelope.backedUp
                || !Array.isArray(record.transactions) || (record.pending ?? null) !== envelope.pendingHash) throw new Error();
            uint(record.highestNonce, 'saved nonce', MAX_NONCE + 1n);
            const hashes = new Set();
            for (const entry of record.transactions) {
                const transaction = Transaction.from(entry.raw);
                // Existing backups contain legacy transactions. Their signed
                // bytes remain recoverable; only new transactions use type 2.
                const feeCap = transaction.type === 0 ? transaction.gasPrice : transaction.maxFeePerGas;
                const totalFee = uint(feeCap, 'saved fee price') * transaction.gasLimit;
                const supportedFees = transaction.type === 0 || (transaction.type === 2
                    && transaction.maxPriorityFeePerGas >= MIN_PRIORITY_FEE
                    && transaction.maxPriorityFeePerGas <= feeCap
                    && transaction.accessList?.length === 0);
                if (!transaction.isSigned() || transaction.hash !== entry.hash || hashes.has(entry.hash)
                    || !sameAddress(transaction.from, record.address) || transaction.chainId !== ctx.chainId
                    || transaction.nonce !== Number(uint(entry.transaction.nonce, 'saved nonce', MAX_NONCE))
                    || !sameAddress(transaction.to, entry.transaction.to)
                    || transaction.data !== entry.transaction.data || transaction.value !== BigInt(entry.transaction.value)
                    || transaction.gasLimit !== BigInt(entry.transaction.gas) || !supportedFees
                    || transaction.gasLimit < 21_000n || transaction.gasLimit > MAX_GAS || feeCap <= 0n
                    || totalFee + transaction.value > UINT256_MAX
                    || (entry.authorization?.kind === 'deposit' && entry.authorization.feeLimitWei != null
                        && totalFee > uint(entry.authorization.feeLimitWei, 'authorized fee'))
                    || BigInt(transaction.nonce) >= BigInt(record.highestNonce)) throw new Error();
                // A saved entry was signed under an earlier policy: only its
                // structure is judged. Present-policy checks (deposit gate,
                // deployment pin) are for a call about to be signed.
                this.validateCall(ctx, record.address, entry.transaction, entry.context, entry.authorization, { signing: false });
                if (entry.outcome != null) {
                    if (entry.kind !== 'sweep' || entry.acknowledged !== true || record.pending === entry.hash
                        || !['confirmed', 'reverted'].includes(entry.outcome.status)
                        || !HASH.test(entry.outcome.blockHash || '')) throw new Error();
                    uint(entry.outcome.blockNumber, 'return receipt block', MAX_NONCE);
                }
                hashes.add(entry.hash);
            }
            if (record.pending && !hashes.has(record.pending)) throw new Error();
        } catch { throw fail('Saved payment-address recovery data is damaged. Keep this browser data intact.', 'address_storage_invalid'); }
    }

    async read(ctx, requireUnlocked = false) {
        let envelope;
        try { envelope = await this.store.load(ctx.scope); }
        catch (error) {
            this.session = null;
            this.state = { exists: true, unlocked: false, backedUp: false, address: null, pending: null, migrationRequired: false };
            throw error;
        }
        if (!envelope) {
            this.session = null;
            this.state = { exists: false, unlocked: false, backedUp: false, address: null, pending: null, migrationRequired: false };
            if (requireUnlocked) throw fail('Create or restore a payment address first.', 'address_missing');
            return null;
        }
        // Failed decryption must also discard a formerly usable cached session.
        this.state = { exists: true, unlocked: false, backedUp: false, address: null, pending: null,
            migrationRequired: envelope.version === 1 };
        try { this.validateEnvelope(envelope, ctx); } catch (error) { this.session = null; throw error; }
        let record = null;
        try {
            if (envelope.version === 2) {
                record = await this.decrypt(envelope, envelope.browserKey, ctx);
                this.session = { scope: ctx.scope, custody: 'browser', keyId: envelope.keyId, key: envelope.browserKey };
            } else if (this.session?.scope === ctx.scope && this.session.salt === envelope.salt) {
                record = await this.decrypt(envelope, this.session.key, ctx);
            } else this.session = null;
        } catch (error) { this.session = null; throw error; }
        const entry = record?.transactions.find(item => item.hash === record.pending);
        this.state = { exists: true, unlocked: Boolean(record), backedUp: envelope.backedUp,
            address: envelope.address, migrationRequired: envelope.version === 1,
            lastReturn: lastReturn(record),
            pending: entry ? publicPending(entry) : envelope.pendingHash ? { hash: envelope.pendingHash, locked: true } : null };
        if (requireUnlocked && !record) throw fail('Unlock your payment address with its backup password first.', 'address_locked');
        return record;
    }

    async save(ctx, record, session = this.session, { createOnly = false } = {}) {
        if (!session || session.scope !== ctx.scope) throw fail('Unlock your payment address first.', 'address_locked');
        const browserCustody = session.custody === 'browser';
        const envelope = { format: 'oa-address-wallet', version: browserCustody ? 2 : 1, scope: ctx.scope, address: record.address,
            backedUp: record.backedUp, pendingHash: record.pending,
            ...(browserCustody ? { custody: 'browser', keyId: session.keyId, browserKey: session.key }
                : { salt: session.salt, iterations: KDF_ITERATIONS }),
            iv: bytes64(this.crypto.getRandomValues(new Uint8Array(12))) };
        const ciphertext = new Uint8Array(await this.crypto.subtle.encrypt({ name: 'AES-GCM', iv: from64(envelope.iv), additionalData: aad(envelope) }, session.key, encoder.encode(JSON.stringify(record))));
        // Avoid spread/argument-size limits for transaction journals.
        let encoded = '';
        for (const byte of ciphertext) encoded += String.fromCharCode(byte);
        envelope.ciphertext = btoa(encoded);
        if (JSON.stringify(envelope).length > MAX_BACKUP_BYTES) throw fail('The payment-address journal is full. Keep this browser data intact.', 'address_storage');
        try { await this.store.save(ctx.scope, envelope, { createOnly }); } catch { throw fail('The payment address or transaction could not be saved. No new transaction was sent.', 'address_storage'); }
        this.session = session;
        this.state = { exists: true, unlocked: true, backedUp: record.backedUp, address: record.address, migrationRequired: !browserCustody,
            lastReturn: lastReturn(record),
            pending: publicPending(record.transactions.find(entry => entry.hash === record.pending)) };
        this.changed();
        return envelope;
    }

    async reload() {
        if (!await this.getConfig()) return this.pending;
        const ctx = await this.context();
        await this.locked(ctx, () => this.read(ctx));
        this.notify();
        return this.pending;
    }

    async browserSession(ctx) {
        if (!this.crypto?.subtle) throw fail('Secure browser encryption is unavailable.', 'address_storage');
        const key = await this.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        return { scope: ctx.scope, custody: 'browser', keyId: bytes64(this.crypto.getRandomValues(new Uint8Array(16))), key };
    }

    async ensureAddress() {
        const ctx = await this.context();
        return this.locked(ctx, async () => {
            if (await this.store.load(ctx.scope)) {
                await this.read(ctx);
                if (this.migrationRequired) throw fail('This address was saved with a password. Convert the existing address once before continuing.', 'address_migration_required');
                this.notify();
                return this.address;
            }
            const session = await this.browserSession(ctx);
            const wallet = await this.createWallet();
            const record = { version: 1, scope: ctx.scope, address: address(wallet.address), privateKey: wallet.privateKey,
                backedUp: true, pending: null, highestNonce: '0', transactions: [] };
            await this.save(ctx, record, session, { createOnly: true });
            return this.address;
        });
    }

    // Only pre-existing v1 records need their old password once. Migration
    // changes the encryption wrapper, never the address or transaction journal.
    async migrateLegacy(password) {
        const ctx = await this.context();
        return this.locked(ctx, async () => {
            const envelope = await this.store.load(ctx.scope);
            if (!envelope) throw fail('The saved payment address is missing. Keep this browser data intact.', 'address_missing');
            this.validateEnvelope(envelope, ctx);
            if (envelope.version === 2) {
                await this.read(ctx, true);
                this.notify();
                return this.address;
            }
            const key = await this.deriveKey(password, envelope.salt);
            const record = await this.decrypt(envelope, key, ctx);
            const session = await this.browserSession(ctx);
            record.backedUp = true;
            await this.save(ctx, record, session);
            return this.address;
        });
    }

    async create(password) {
        const ctx = await this.context();
        return this.locked(ctx, async () => {
            if (await this.store.load(ctx.scope)) throw fail('This browser already has a payment address. Unlock it or restore its backup.', 'address_exists');
            const salt = bytes64(this.crypto.getRandomValues(new Uint8Array(16)));
            const key = await this.deriveKey(password, salt);
            const wallet = await this.createWallet();
            const record = { version: 1, scope: ctx.scope, address: address(wallet.address), privateKey: wallet.privateKey,
                backedUp: false, pending: null, highestNonce: '0', transactions: [] };
            const envelope = await this.save(ctx, record, { scope: ctx.scope, salt, key });
            return { address: record.address, backup: JSON.stringify(envelope) };
        });
    }

    async unlock(password) {
        const ctx = await this.context();
        return this.locked(ctx, async () => {
            const envelope = await this.store.load(ctx.scope);
            this.validateEnvelope(envelope, ctx);
            if (envelope.version === 2) {
                await this.read(ctx, true);
                this.notify();
                return this.address;
            }
            const key = await this.deriveKey(password, envelope.salt);
            await this.decrypt(envelope, key, ctx);
            this.session = { scope: ctx.scope, salt: envelope.salt, key };
            await this.read(ctx, true);
            this.notify();
            return this.address;
        });
    }

    async markBackedUp() {
        const ctx = await this.context();
        return this.locked(ctx, async () => {
            const record = await this.read(ctx, true);
            record.backedUp = true;
            await this.save(ctx, record);
            return record.address;
        });
    }

    async exportBackup(password) {
        const ctx = await this.context();
        return this.locked(ctx, async () => {
            const envelope = await this.store.load(ctx.scope);
            this.validateEnvelope(envelope, ctx);
            if (envelope.version === 2) throw fail('This payment address is stored only in this browser.', 'address_browser_only');
            const key = await this.deriveKey(password, envelope.salt);
            await this.decrypt(envelope, key, ctx);
            return JSON.stringify(envelope);
        });
    }

    async restoreBackup(serialized, password) {
        const ctx = await this.context();
        if (typeof serialized !== 'string' || serialized.length > MAX_BACKUP_BYTES) throw fail('Choose a valid encrypted payment-address backup.', 'address_backup_invalid');
        let envelope;
        try { envelope = JSON.parse(serialized); } catch { throw fail('Choose a valid encrypted payment-address backup.', 'address_backup_invalid'); }
        this.validateEnvelope(envelope, ctx);
        if (envelope.version !== 1) throw fail('Choose a legacy encrypted payment-address backup.', 'address_backup_invalid');
        const key = await this.deriveKey(password, envelope.salt);
        const imported = await this.decrypt(envelope, key, ctx);
        return this.locked(ctx, async () => {
            const existing = await this.store.load(ctx.scope);
            if (existing) {
                if (!sameAddress(existing.address, imported.address) || existing.salt !== envelope.salt) {
                    throw fail('This browser already has a different payment address or password. Restore in a separate browser profile to preserve both.', 'address_exists');
                }
                // An older downloaded backup must never replace a newer signed journal.
                await this.decrypt(existing, key, ctx);
                this.session = { scope: ctx.scope, salt: existing.salt, key };
                await this.read(ctx, true);
            } else {
                imported.backedUp = true;
                await this.save(ctx, imported, { scope: ctx.scope, salt: envelope.salt, key });
            }
            this.notify();
            return this.address;
        });
    }

    async rpc(ctx, method, params = []) {
        const id = ++this.rpcId;
        const controller = new AbortController();
        let timer;
        try {
            return await Promise.race([(async () => {
                const response = await this.transport(ctx.rpc, {
                    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
                    signal: controller.signal
                });
                if (!response.ok) throw new Error();
                const payload = await response.json();
                if (!payload || payload.id !== id || payload.jsonrpc !== '2.0' || payload.error || !Object.hasOwn(payload, 'result')) throw new Error();
                return payload.result;
            })(), new Promise((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Error()); }, 20_000);
            })]);
        } catch {
            // Provider errors can echo signed transactions or private call data.
            throw fail('The payment network could not complete this request. Check your connection and try again.', 'address_rpc_error');
        } finally { clearTimeout(timer); }
    }

    async assertChain(ctx) {
        if (uint(await this.rpc(ctx, 'eth_chainId'), 'RPC network') !== ctx.chainId) throw fail('The payment network connection is on the wrong chain.', 'wrong_network');
    }

    async transactionFees(ctx, gasLimit, approvedFeeLimit = null) {
        return (await this.transactionFeeQuote(ctx, gasLimit, approvedFeeLimit)).fees;
    }

    async transactionFeeQuote(ctx, gasLimit, approvedFeeLimit = null) {
        gasLimit = uint(gasLimit, 'gas limit', MAX_GAS);
        if (gasLimit < 21_000n) throw fail('Invalid transaction gas limit.');
        let baseFee;
        let maxPriorityFeePerGas;
        // Retry the read pair once: an RPC replica can briefly lag the latest
        // block. Each attempt still validates the full, anchored fee history.
        // This never retries signing or broadcasting a transaction.
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const block = await this.rpc(ctx, 'eth_getBlockByNumber', ['latest', false]);
                const blockNumber = feeQuantity(block?.number, MAX_NONCE);
                const timestamp = feeQuantity(block?.timestamp, MAX_NONCE);
                baseFee = feeQuantity(block?.baseFeePerGas);
                const history = await this.rpc(ctx, 'eth_feeHistory', [hex(BigInt(LOW_FEE_HISTORY_BLOCKS)), hex(blockNumber), [LOW_FEE_REWARD_PERCENTILE]]);
                maxPriorityFeePerGas = lowPriorityFee(history, blockNumber, baseFee);
                const now = BigInt(Math.floor(Date.now() / 1000));
                if (timestamp + MAX_FEE_BLOCK_AGE_SECONDS < now || timestamp > now + MAX_FEE_BLOCK_FUTURE_SECONDS) throw fail('Stale network fee history.');
                break;
            } catch {
                if (attempt === 1) throw this.paymentFailure('address_fee_data');
            }
        }
        // EIP-1559 bounds a full block's base-fee increase to 12.5%, with
        // a one-wei minimum. Low pricing uses recent low bids and only 25%
        // base-fee headroom. The user's quoted allowance, rather than a fixed
        // ETH or gas-price ceiling, limits a deposit's authorized fee.
        const nextBaseFee = baseFee + (baseFee / 8n || 1n);
        const minimumFee = nextBaseFee + maxPriorityFeePerGas;
        const lowBaseFee = (baseFee * 5n + 3n) / 4n;
        const desiredFee = (lowBaseFee > nextBaseFee ? lowBaseFee : nextBaseFee) + maxPriorityFeePerGas;
        // Reject impossible transaction arithmetic, without imposing a market
        // price ceiling. BigInt keeps every intermediate calculation exact.
        if (desiredFee * gasLimit > UINT256_MAX) throw this.paymentFailure('address_fee_data');
        // A quote already reserves price headroom. Let that approved buffer
        // cover modest fee/gas changes instead of demanding a fresh reserve
        // on every send. Never spend more than its total allowance.
        const feeCap = approvedFeeLimit == null ? desiredFee
            : uint(approvedFeeLimit, 'authorized fee') / gasLimit;
        if (feeCap < minimumFee) throw this.paymentFailure('address_fee_quote_changed');
        const maxFeePerGas = desiredFee < feeCap ? desiredFee : feeCap;
        return { fees: { type: 2, maxFeePerGas, maxPriorityFeePerGas }, minimumFeePerGas: minimumFee,
            expectedFeePerGas: baseFee + maxPriorityFeePerGas };
    }

    // The refusal of an escape whose concession was not confirmed. As with the
    // payment failures below, the SDK finishes its own bookkeeping for a refused
    // send before its generic wallet copy could replace the words, so they are
    // restored over it when the action ends (the error's identity is kept).
    concessionRefusal() {
        const error = fail(CONCESSION_UNCONFIRMED_MESSAGE, 4100);
        if (this.action) this.action.failure = { error, message: CONCESSION_UNCONFIRMED_MESSAGE };
        return error;
    }

    paymentFailure(code, requirement = null) {
        let message;
        if (code === 'address_insufficient_eth') {
            const network = requirement.chainId === 1 ? 'Ethereum Mainnet'
                : requirement.chainId === 11155111 ? 'Sepolia' : `chain ${requirement.chainId}`;
            message = `This browser needs ${formatEther(requirement.shortfallWei)} ETH more to cover this transaction and fees. Send it to ${requirement.address} on ${network}, then retry the action. Nothing was sent.`;
        } else if (code === 'address_fee_data') {
            message = 'Unable to check Ethereum fees. Check your connection and try again. Nothing was sent.';
        } else if (code === 'address_fee_quote_changed') {
            message = 'Network fees changed. Review the fee allowance and try again. Nothing was sent.';
        } else throw fail('Unsupported payment failure.');
        const error = fail(message, code);
        if (requirement) error.fundingRequirement = copy(requirement);
        // The SDK must finish its own pre-broadcast recovery bookkeeping before
        // we restore this public-only explanation over its generic wallet copy.
        // Retain object identity so an unrelated later error is never replaced.
        if (this.action) this.action.failure = { error, message };
        return error;
    }

    // Before server clearance/proof preparation, exact calldata does not exist.
    // Budget the supported transaction ceiling, explicitly as a reserve rather
    // than an exact fee. This reads public chain data only and never closes a note.
    async getWithdrawalFeeBudget(mode = 'mutual') {
        if (!['mutual', 'escape'].includes(mode)) throw fail('Invalid withdrawal method.');
        const ctx = await this.context();
        await this.reload();
        const own = this.address;
        if (!own || !this.unlocked) throw fail('Your payment address is not available in this browser.');
        if (this.hasPendingTransaction) throw fail('Check your saved transaction before withdrawing.');
        await this.assertChain(ctx);
        const { fees } = await this.transactionFeeQuote(ctx, MAX_GAS);
        const balance = uint(await this.rpc(ctx, 'eth_getBalance', [own, 'pending']), 'ETH balance');
        await this.assertChain(ctx);
        const transactionFeeWei = MAX_GAS * fees.maxFeePerGas;
        // An escape needs a second, explicit transaction after the safety window.
        const reserve = transactionFeeWei * (mode === 'escape' ? 2n : 1n);
        uint(reserve, 'withdrawal reserve');
        return { address: own, chainId: Number(ctx.chainId), mode,
            balanceWei: balance.toString(), feeReserveWei: reserve.toString(),
            transactionFeeWei: transactionFeeWei.toString(),
            shortfallWei: (reserve > balance ? reserve - balance : 0n).toString(),
            expiresAt: Date.now() + FEE_QUOTE_LIFETIME_MS };
    }

    async getDepositFeeQuote(intent, { isCurrent = () => true } = {}) {
        const ctx = await this.context();
        // Quoting asks the SDK for a prepared plan, and a prepared plan is saved
        // in the browser wallet. A version that no longer accepts deposits must
        // not leave one behind, so it is refused before the SDK is reached.
        this.assertDepositMayStart();
        await this.reload();
        const own = this.address;
        if (!own || !this.unlocked) throw fail('Create or restore a payment address first.', 'address_missing');
        const amount = uint(intent?.amount, 'deposit amount', MAX_NONCE);
        const depositWei = uint(intent?.depositWei, 'deposit ETH');
        if (!amount || depositWei !== amount * ctx.weiPerUnit || typeof intent.ethAmount !== 'string') {
            throw fail('The deposit amount could not be quoted.', 'address_fee_quote_invalid');
        }
        await this.assertChain(ctx);
        const prepared = await this.prepareDepositQuote(intent.ethAmount, { from: own }, { isCurrent });
        if (!prepared || typeof prepared.operationId !== 'string' || !prepared.operationId || prepared.operationId.length > 256
            || uint(prepared.amount, 'prepared deposit amount') !== amount
            || uint(prepared.depositWei, 'prepared deposit ETH') !== depositWei
            || uint(prepared.chainId, 'prepared deposit network') !== ctx.chainId
            || !sameAddress(prepared.contractAddress, ctx.vault)) {
            throw fail('The prepared deposit does not match this payment address.', 'address_fee_quote_invalid');
        }
        // Validation is pure: this synthetic read-only context grants no signer
        // permission and cannot enter the durable transaction journal.
        const transaction = this.validateCall(ctx, own, prepared.transaction, {
            version: 1, kind: 'deposit', deploymentId: this.signerProtocol().deploymentId ?? 'fee-quote',
            chainId: Number(ctx.chainId), contractAddress: ctx.vault,
            operationId: prepared.operationId, submissionId: 'fee-quote', amount: amount.toString(), commitment: prepared.commitment
        }, { kind: 'deposit', amount: amount.toString() }, { signing: true });
        const input = { from: own, to: transaction.to, data: transaction.data, value: hex(transaction.value) };
        // A new funding address has no ETH yet. Override only its simulated
        // balance; contract code/storage, sender identity and payable value all
        // remain real. Unsupported state overrides fail closed, without a guess.
        const overrides = { [own]: { balance: hex(UINT256_MAX) } };
        await this.rpc(ctx, 'eth_call', [input, 'pending', overrides]);
        const estimate = uint(await this.rpc(ctx, 'eth_estimateGas', [input, 'pending', overrides]), 'transaction gas', MAX_GAS);
        if (estimate < 21_000n) throw fail('Invalid transaction gas estimate.');
        const gasLimit = BigInt(bufferedGasLimit(estimate));
        const { fees, expectedFeePerGas, minimumFeePerGas } = await this.transactionFeeQuote(ctx, gasLimit);
        const expectedFeeWei = estimate * expectedFeePerGas;
        // Ethereum requires the full gas-limit liability up front. Keep that
        // current requirement separate from optional extra price headroom.
        const requiredFeeWei = gasLimit * minimumFeePerGas;
        const feeReserveWei = gasLimit * fees.maxFeePerGas;
        uint(depositWei + feeReserveWei, 'deposit and network fee');
        await this.assertChain(ctx);
        const quotedAt = Date.now();
        return { operationId: prepared.operationId, depositCommitment: prepared.commitment, address: own,
            amount: amount.toString(), depositWei: depositWei.toString(), chainId: Number(ctx.chainId), contractAddress: ctx.vault,
            expectedFeeWei: expectedFeeWei.toString(), requiredFeeWei: requiredFeeWei.toString(),
            feeBufferWei: (feeReserveWei - requiredFeeWei).toString(),
            feeReserveWei: feeReserveWei.toString(), estimatedGas: estimate.toString(), gasLimit: gasLimit.toString(),
            maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
            reserveKind: 'estimated_transaction', feePolicy: 'low',
            quotedAt, expiresAt: quotedAt + FEE_QUOTE_LIFETIME_MS };
    }

    /** The only gate between a requested vault call and a signature. Whether the
     * call is accepted follows the call profile of this scope's protocol family
     * (CallProfile, versioning/adapters): selectors, calldata length, the words
     * that bind chain, vault, note, amount and destination, and the rules that
     * differ per family. `signing` is true for a call that may be signed and
     * false when an already signed journal entry is re-validated: policy that is
     * about the present (a version that stopped accepting deposits, the
     * deployment pin) applies to the former only, so closing a version can never
     * make a saved journal unreadable. It defaults to true, so a caller that
     * forgets the flag gets the strict, signing-boundary policy; the one caller
     * that re-reads saved entries (validateRecord) passes false explicitly. */
    validateCall(ctx, own, input, recovery, authorization, { signing = true } = {}) {
        if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['from', 'to', 'data', 'value', 'nonce', 'gas', 'chainId'].includes(key))) {
            throw fail('Unsupported payment transaction fields.', 4200);
        }
        if (!sameAddress(address(input.from), own)) throw fail('The transaction belongs to a different payment address.', 4100);
        if (input.chainId != null && uint(input.chainId, 'transaction network') !== ctx.chainId) throw fail('Transaction network mismatch.', 'wrong_network');
        const to = address(input.to);
        const value = uint(input.value ?? 0, 'ETH value');
        const data = input.data ?? '0x';
        if (typeof data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(data) || data.length > 65_538) throw fail('Invalid transaction call data.', 4200);
        const normalized = data.toLowerCase();
        const selector = normalized.slice(2, 10);
        const words = normalized.slice(10).match(/.{1,64}/g) || [];
        const wordUint = index => uint(`0x${words[index] || ''}`, 'transaction field');
        const wordAddress = index => {
            if (!/^0{24}[a-f0-9]{40}$/.test(words[index] || '')) throw fail('Invalid transaction address.', 4200);
            return address(`0x${words[index].slice(24)}`);
        };
        const deny = () => { throw fail('This transaction was not authorized by the selected wallet action.', 4100); };
        const exactWords = count => normalized.length === 10 + count * 64;
        if (!authorization) deny();
        if (authorization.kind === 'sweep') {
            if (!sameAddress(address(authorization.destination), to) && authorization.asset === 'eth') deny();
            if (authorization.asset === 'eth') {
                if (normalized !== '0x' || value !== uint(authorization.amount, 'ETH amount')) deny();
            } else deny();
            return { to, value, data: normalized };
        }
        const { profile, deploymentId } = this.signerProtocol();
        if (signing && authorization.kind === 'deposit') this.assertDepositMayStart();
        const nativeDeposit = sameAddress(to, ctx.vault) && selector === profile.deposit.selector;
        // A call to be signed must carry the recovery context of the deployment
        // this scope belongs to. A saved entry keeps the structural check only:
        // the SDK compares its deployment again when it resumes the entry, and a
        // journal this signer wrote itself must never become unreadable over it.
        if ((!nativeDeposit && value !== 0n) || !recovery || recovery.version !== 1
            || typeof recovery.deploymentId !== 'string' || !recovery.deploymentId
            || (signing && deploymentId !== null && recovery.deploymentId !== deploymentId)
            || uint(recovery.chainId, 'recovery network') !== ctx.chainId
            || !sameAddress(recovery.contractAddress, ctx.vault)
            || Object.keys(recovery).some(key => !RECOVERY_FIELDS.has(key))) deny();
        if (sameAddress(to, ctx.vault)) {
            const exit = profile.exits.find(entry => entry.selector === selector);
            if (selector === profile.deposit.selector) {
                if (authorization.kind !== 'deposit' || recovery.kind !== 'deposit' || !exactWords(profile.deposit.words)
                    || !recovery.operationId || !recovery.submissionId
                    || wordUint(1) !== uint(authorization.amount, 'deposit amount')
                    || wordUint(1) !== uint(recovery.amount, 'recovery amount')
                    || wordUint(0) !== uint(recovery.commitment, 'commitment')
                    || !wordUint(1) || value !== wordUint(1) * ctx.weiPerUnit) deny();
                if ((authorization.preparedOperationId != null || authorization.depositCommitment != null
                    || authorization.feeLimitWei != null)) {
                    if (typeof authorization.preparedOperationId !== 'string' || !authorization.preparedOperationId
                        || authorization.preparedOperationId !== recovery.operationId
                        || uint(authorization.depositCommitment, 'authorized commitment') !== wordUint(0)
                        || !uint(authorization.feeLimitWei, 'authorized fee')) deny();
                }
            } else if (exit) {
                const { fields } = profile;
                const noteId = withdrawalCallNoteId(fields, wordUint);
                if (noteId === null) deny();
                if (authorization.kind !== 'withdrawal' || !['withdrawal', 'background-withdrawal', 'background-replacement'].includes(recovery.kind)
                    || !exactWords(exit.words) || !recovery.operationId || !recovery.submissionId
                    || wordUint(fields.chainId) !== ctx.chainId || wordAddress(fields.vault) !== ctx.vault
                    || noteId !== uint(recovery.noteId, 'note')
                    || wordUint(fields.finalBalance) !== uint(recovery.finalBalance, 'withdrawal amount')
                    || wordAddress(fields.destination) !== address(authorization.destination)
                    || wordAddress(fields.destination) !== address(recovery.destination)
                    || wordUint(exit.kind.word) !== exit.kind.value
                    || wordUint(exit.bytesOffset.word) !== exit.bytesOffset.value
                    || wordUint(exit.proofLength.word) !== exit.proofLength.value
                    || recovery.mode !== exit.mode
                    // The mode the person chose is the mode signed, with one
                    // exception that only a protocol with a concession field
                    // has: the SDK turns a requested mutual close into an
                    // escape when the service cannot or will not clear it
                    // (a protocol that concedes nothing converts nothing).
                    // The other direction never happens and is refused.
                    || (authorization.mode && authorization.mode !== recovery.mode
                        && !(exit.concededWord !== null && authorization.mode === 'mutual' && recovery.mode === 'escape'))
                    || (authorization.noteId != null && uint(authorization.noteId, 'note') !== noteId)
                    // The operation the person looked at is the operation
                    // signed (set only where a prepared withdrawal's
                    // identity is known).
                    || (authorization.operationId != null && authorization.operationId !== recovery.operationId)
                    // Family rules. A mutual close publishes no successor and
                    // concedes nothing; an escape names a successor nullifier
                    // that differs from the note's own (and concedes no more
                    // than the person confirmed, judged below).
                    || exit.zeroWords.some(index => wordUint(index) !== 0n)
                    || exit.nonZeroWords.some(index => wordUint(index) === 0n || wordUint(index) === wordUint(fields.nullifier))) deny();
                // The concession is judged last, once every other rule holds:
                // a call that is wrong in any other way gets the generic words,
                // and only a call that is right in all of them but the amount is
                // told what the amount is and what to do.
                if (exit.concededWord !== null && !concessionConfirmed(wordUint(exit.concededWord), authorization)) {
                    throw this.concessionRefusal();
                }
            } else if (selector === profile.finalize.selector) {
                if (authorization.kind !== 'finalization' || recovery.kind !== 'finalization' || !exactWords(profile.finalize.words)
                    || !recovery.operationId || !recovery.submissionId
                    || wordUint(profile.finalize.noteIdWord) !== uint(authorization.noteId, 'note')
                    || wordUint(profile.finalize.noteIdWord) !== uint(recovery.noteId, 'note')) deny();
            } else if (profile.claim && selector === profile.claim.selector) {
                // Delivers a payout the vault credited because its destination
                // refused ETH. It moves nothing private: the vault pays the
                // credited address, so the destination is bound to both the
                // user's authorization and the SDK's saved record.
                const { claim } = profile;
                if (authorization.kind !== claim.authorizationKind || recovery.kind !== claim.recoveryKind
                    || !exactWords(claim.words)
                    || typeof recovery.recordId !== 'string' || !recovery.recordId
                    || wordAddress(claim.destinationWord) !== address(authorization.destination)
                    || wordAddress(claim.destinationWord) !== address(recovery.destination)
                    || (authorization.recordId != null && authorization.recordId !== recovery.recordId)
                    || (authorization.noteId != null && (recovery.noteId == null
                        || uint(authorization.noteId, 'note') !== uint(recovery.noteId, 'note')))) deny();
            } else deny();
        } else deny();
        return { to, value, data: normalized };
    }

    // Continuing an escape that concedes.
    //
    // An escape's concession is fixed when the SDK proves it, so a person who
    // chose to give up an amount is shown it once, before the first attempt, and
    // the signer holds the call to that confirmation. An attempt may still stop
    // before anything is signed (a fee shortfall, a lost connection) and be
    // repeated. A repeat that names no concession of its own is therefore held
    // to the concession of the attempt the signer already accepted for the same
    // operation and note, and to nothing else. Two places remember it:
    //
    //   - the journal: the amount of a transaction this signer already signed
    //     for the operation (survives a reload and another tab), and
    //   - this page session: the amount of a call it accepted for signing
    //     before it stopped.
    //
    // An attempt that was refused leaves neither, so repeating a refused action
    // without its bound is refused again and the person has to confirm what is
    // being given up. The SDK's saved plan is never consulted: it records what
    // the SDK proved, not what anyone confirmed.
    //
    // The amount found is a CAP, not an exact value. A plan that another tab or
    // a later attempt proved again at a smaller concession gives up less than
    // the person confirmed, and a repeat of the same operation is not refused
    // for that; one that concedes more is. Where both sources know an amount
    // the cap is the smaller one: neither the journal (the latest signed, of
    // any tab) nor this page's memory (the latest accepted) can say which is
    // the person's most recent confirmation, and the smaller can only refuse
    // more, never let more through.
    continuedAuthorization(authorization, transactionData, recovery, record) {
        if (authorization?.kind !== 'withdrawal' || authorization.conceded != null || authorization.concededMax != null) {
            return authorization;
        }
        const operationId = recovery?.operationId;
        const { profile } = this.signerProtocol();
        if (typeof operationId !== 'string' || !operationId || calldataConcession(profile, transactionData) === null) {
            return authorization;
        }
        const known = [];
        const entries = Array.isArray(record?.transactions) ? record.transactions : [];
        for (let index = entries.length - 1; index >= 0; index--) {
            const entry = entries[index];
            if (entry?.kind !== 'withdrawal' || entry.authorization?.kind !== 'withdrawal'
                || entry.context?.operationId !== operationId || !sameNote(entry.context.noteId, recovery.noteId)) continue;
            const signed = calldataConcession(profile, entry.transaction?.data);
            // The latest entry of the operation that carries a readable amount.
            if (signed !== null) { known.push(signed); break; }
        }
        const accepted = this.acceptedConcessions.get(operationId);
        if (accepted && sameNote(accepted.noteId, recovery.noteId)) known.push(accepted.conceded);
        if (!known.length) return authorization;
        const cap = known.reduce((least, amount) => amount < least ? amount : least);
        return { ...authorization, concededMax: cap.toString() };
    }

    // Called once validateCall has accepted a withdrawal: its concession is now
    // one the signer will hold a repeat of the same operation to.
    rememberAcceptedConcession(authorization, transactionData, recovery) {
        if (authorization?.kind !== 'withdrawal' || typeof recovery?.operationId !== 'string' || !recovery.operationId) return;
        const conceded = calldataConcession(this.signerProtocol().profile, transactionData);
        if (conceded === null) return;
        this.acceptedConcessions.delete(recovery.operationId);
        this.acceptedConcessions.set(recovery.operationId, { noteId: recovery.noteId, conceded });
        while (this.acceptedConcessions.size > MAX_ACCEPTED_CONCESSIONS) {
            this.acceptedConcessions.delete(this.acceptedConcessions.keys().next().value);
        }
    }

    // The authorization as the journal keeps it. For an exit of a protocol that
    // concedes it records what was signed and not only what was asked: the mode
    // actually signed (the request, when the SDK turned a mutual close into an
    // escape, is kept as `requestedMode`) and the exact amount conceded. A
    // build that does not know the conversion and cap rules (an older tab, a
    // rolled-back page) re-reads every saved entry with the one rule it has,
    // "the mode authorized is the mode signed and the concession is the amount
    // authorized", and judges a damaged journal fatal for the whole address. An
    // entry written in that shape is read the same by every build. Anything
    // that is not such an exit is saved exactly as given.
    journaledAuthorization(authorization, transactionData, recovery) {
        const saved = copy(authorization);
        if (authorization?.kind !== 'withdrawal') return saved;
        const conceded = calldataConcession(this.signerProtocol().profile, transactionData);
        if (conceded === null) return saved;
        if (saved.mode && recovery?.mode && saved.mode !== recovery.mode) {
            saved.requestedMode = saved.mode;
            saved.mode = recovery.mode;
        }
        saved.conceded = conceded.toString();
        return saved;
    }

    async withAuthorizedAction(authorization, callback) {
        const ctx = await this.context();
        if (this.action) throw fail('A payment-address action is already running.', 'address_busy');
        const { profile } = this.signerProtocol();
        const kinds = ['deposit', 'withdrawal', 'finalization', 'recovery', 'sweep'];
        // Only a protocol with credited payouts has a claim to authorize.
        if (profile.claim) kinds.push(profile.claim.authorizationKind);
        // Only a protocol with sponsored withdrawals has a collection (a
        // forward of the balance a transit account holds).
        if (profile.sponsored) kinds.push('collection');
        if (!kinds.includes(authorization?.kind) || typeof callback !== 'function') throw fail('Choose a wallet action first.', 4100);
        // A funding address of another version only returns its ETH. It never
        // deposits, exits or claims for a vault this page did not load.
        if (this.sweepOnly && !['sweep', 'recovery'].includes(authorization.kind)) {
            throw fail('This funding address belongs to another version of the app. It can only return its ETH here.', 'address_scope_retired');
        }
        return this.locked(ctx, async () => {
            await this.locked(ctx, async () => {
                const record = await this.read(ctx, true);
                if (!record.backedUp) throw fail('Save your encrypted address backup before funding or spending.', 'address_backup_required');
                if (record.pending && authorization.kind !== 'recovery') throw fail('Recover the saved transaction before starting another wallet action.', 'address_transaction_pending');
            });
            this.action = { authorization: copy(authorization), scope: ctx.scope, sends: 0, sponsoredSignatures: 0 };
            this.notify();
            try { return await callback(); }
            catch (error) {
                if (this.action.failure?.error === error) {
                    error.message = this.action.failure.message;
                    error.shortMessage = this.action.failure.message;
                }
                throw error;
            } finally { this.action = null; this.notify(); }
        }, true);
    }

    async broadcast(ctx, entry) {
        try {
            await this.assertChain(ctx);
            const returned = await this.rpc(ctx, 'eth_sendRawTransaction', [entry.raw]);
            if (String(returned).toLowerCase() !== entry.hash) throw new Error();
        } catch { /* Durable signed bytes and their derived hash survive ambiguous network results. */ }
        return entry.hash;
    }

    async send(input, recovery, overrideAuthorization = null) {
        const ctx = await this.context();
        if (!this.action || this.action.scope !== ctx.scope) throw fail('Choose and confirm a wallet action before sending.', 4100);
        this.action.failure = null;
        if (overrideAuthorization) throw fail('The return transaction differs from the authorized wallet action.', 4100);
        return this.locked(ctx, async () => {
            const record = await this.read(ctx, true);
            const maxEthReturn = this.action.authorization.kind === 'sweep'
                && this.action.authorization.asset === 'eth' && this.action.authorization.amount === 'max';
            // The max path starts with a zero-value EOA simulation and resolves
            // its amount below from the same fee quote used for signing.
            let authorization = maxEthReturn ? { ...this.action.authorization, amount: '0' } : this.action.authorization;
            if (record.pending) throw fail('Recover the saved transaction before starting another.', 'address_transaction_pending');
            if (authorization.kind === 'recovery') throw fail('Recovery can only replay the exact transaction already saved.', 4100);
            authorization = this.continuedAuthorization(authorization, input.data, recovery, record);
            const transaction = this.validateCall(ctx, record.address, input, recovery, authorization, { signing: true });
            this.rememberAcceptedConcession(authorization, transaction.data, recovery);
            if (maxEthReturn && await this.rpc(ctx, 'eth_getCode', [transaction.to, 'pending']) !== '0x') {
                throw fail('Choose an exact ETH amount when returning funds to a contract account.', 'address_sweep_contract');
            }
            const maximumSends = 1;
            if (this.action.sends >= maximumSends) throw fail('This action has reached its transaction limit. Check its saved status.', 4100);
            await this.assertChain(ctx);
            const networkNonce = uint(await this.rpc(ctx, 'eth_getTransactionCount', [record.address, 'pending']), 'transaction nonce', MAX_NONCE);
            const nonce = input.nonce == null ? networkNonce : uint(input.nonce, 'transaction nonce', MAX_NONCE);
            if (nonce !== networkNonce || nonce < BigInt(record.highestNonce)) {
                throw fail('The network nonce conflicts with your saved transactions. Recover their status before retrying.', 'address_nonce');
            }
            const estimateInput = { from: record.address, to: transaction.to, data: transaction.data, value: hex(transaction.value) };
            await this.rpc(ctx, 'eth_call', [estimateInput, 'pending']);
            const estimate = uint(await this.rpc(ctx, 'eth_estimateGas', [estimateInput]), 'transaction gas', MAX_GAS);
            if (estimate < 21_000n) throw fail('Invalid transaction gas estimate.');
            const gasLimit = maxEthReturn ? 21_000n : input.gas == null ? (estimate * 120n + 99n) / 100n : uint(input.gas, 'gas limit', MAX_GAS);
            if (gasLimit < estimate || gasLimit > MAX_GAS) throw fail('The gas limit is outside the allowed range.', 'transaction_gas_limit_exceeded');
            const approvedFeeLimit = authorization.kind === 'deposit' || authorization.kind === 'withdrawal' ? authorization.feeLimitWei : null;
            const { fees, minimumFeePerGas } = await this.transactionFeeQuote(ctx, gasLimit, approvedFeeLimit);
            let reserve = fees.maxFeePerGas * gasLimit;
            if (authorization.kind === 'deposit' && authorization.feeLimitWei != null
                && (reserve > uint(authorization.feeLimitWei, 'authorized fee')
                    || (authorization.feeQuoteExpiresAt != null && BigInt(Date.now()) >= uint(authorization.feeQuoteExpiresAt, 'quote expiry', MAX_NONCE)))) {
                throw this.paymentFailure('address_fee_quote_changed');
            }
            const balance = uint(await this.rpc(ctx, 'eth_getBalance', [record.address, 'pending']), 'ETH balance');
            const insufficient = (required, requiredFee = reserve) => this.paymentFailure('address_insufficient_eth', {
                address: record.address, chainId: Number(ctx.chainId), balanceWei: balance.toString(),
                feeReserveWei: requiredFee.toString(), requiredWei: required.toString(),
                shortfallWei: (required - balance).toString()
            });
            if (authorization.kind === 'deposit' && balance < transaction.value + reserve) {
                const minimumReserve = gasLimit * minimumFeePerGas;
                const minimumRequired = uint(transaction.value + minimumReserve, 'transaction value and network fee');
                if (balance < minimumRequired) throw insufficient(minimumRequired, minimumReserve);
                // The extra buffer is optional. Fit the signed maximum fee to
                // available ETH without reducing principal or gas execution room.
                fees.maxFeePerGas = (balance - transaction.value) / gasLimit;
                reserve = fees.maxFeePerGas * gasLimit;
            }
            if (maxEthReturn) {
                if (balance <= reserve) throw insufficient(reserve + 1n);
                transaction.value = balance - reserve;
                authorization = { ...this.action.authorization, amount: transaction.value.toString() };
            }
            const required = uint(transaction.value + reserve, 'transaction value and network fee');
            if (balance < required) throw insufficient(required);
            await this.assertChain(ctx);
            // Balance/network reads may themselves be slow. Expiry must still
            // hold at the signing boundary, not only at the earlier fee read.
            if (authorization.kind === 'deposit' && authorization.feeQuoteExpiresAt != null
                && BigInt(Date.now()) >= uint(authorization.feeQuoteExpiresAt, 'quote expiry', MAX_NONCE)) {
                throw this.paymentFailure('address_fee_quote_changed');
            }
            const raw = await new Wallet(record.privateKey).signTransaction({ ...transaction,
                chainId: ctx.chainId, nonce: Number(nonce), gasLimit, ...fees });
            const hash = keccak256(raw).toLowerCase();
            const entry = { hash, raw, kind: authorization.kind,
                authorization: this.journaledAuthorization(authorization, transaction.data, recovery), context: copy(recovery),
                transaction: { from: record.address, to: transaction.to, data: transaction.data,
                    value: hex(transaction.value), nonce: hex(nonce), gas: hex(gasLimit), chainId: hex(ctx.chainId) } };
            record.transactions.push(entry);
            record.highestNonce = (nonce + 1n).toString();
            record.pending = hash;
            await this.save(ctx, record); // Nothing is broadcast until IDB transaction completion.
            this.action.sends += 1;
            return this.broadcast(ctx, entry);
        });
    }

    async acknowledgeTransaction(hash) {
        const ctx = await this.context();
        return this.locked(ctx, async () => {
            const record = await this.read(ctx, true);
            const entry = record.transactions.find(item => item.hash === String(hash).toLowerCase());
            if (!entry || entry.kind === 'sweep') throw fail('The saved transaction cannot be acknowledged by this wallet action.', 4100);
            if (record.pending !== entry.hash) return; // A late SDK acknowledgment must not clear a successor.
            record.pending = null;
            entry.acknowledged = true;
            await this.save(ctx, record);
        });
    }

    async recoverPending() {
        return this.withAuthorizedAction({ kind: 'recovery' }, async () => {
            const ctx = await this.context();
            const entry = await this.locked(ctx, async () => {
                const record = await this.read(ctx, true);
                return copy(record.transactions.find(item => item.hash === record.pending));
            });
            if (!entry) return null;
            // Resuming a deposit, exit or claim belongs to the SDK build that
            // started it. Replaying its bytes from another version's page would
            // leave that build's records unaware, so nothing is sent from here.
            // Its saved marker may still be released once the network has
            // settled the transaction for good (releaseForeignPending).
            if (this.sweepOnly && entry.kind !== 'sweep') return this.releaseForeignPending(ctx, entry);
            await this.assertChain(ctx);
            await this.broadcast(ctx, entry);
            if (entry.kind === 'sweep') return this.checkSweep(ctx, entry);
            // The SDK validates original claims and persists the transaction hash
            // before calling acknowledgeTransaction. A failed callback retains it.
            return this.resumeTransaction({ transaction: copy(entry.transaction), hash: entry.hash, context: copy(entry.context) });
        });
    }

    // A sweep-only scope whose journal holds a deposit, exit or claim of another
    // SDK build that nobody acknowledged. Only that build may resume it, and
    // nothing here rebroadcasts it or calls an SDK. Its saved marker blocks every
    // later action of the scope though, including returning the ETH, and a build
    // that can no longer be opened would strand the funds behind it. So the
    // marker is released once the network has settled the transaction for good:
    //   - its receipt sits in a finalized block (confirmed or reverted), or
    //   - it has no receipt but the sender's finalized transaction count has
    //     passed its nonce: another transaction took that nonce, so this one
    //     can never be mined (replaced or dropped).
    // Anything less is left saved. Releasing clears `pending` and marks the entry
    // acknowledged, as the SDK's own acknowledgement would: that build's later
    // acknowledgeTransaction is a no-op (the hash is no longer pending) and its
    // receipt reads are unaffected, the entry stays in the journal.
    // Resolves to {transactionHash, status: 'released', kind, finalState} with
    // finalState 'confirmed'|'reverted'|'replaced', or {transactionHash,
    // status: 'pending'} while its receipt is not final yet. A transaction the
    // network has not seen and that no nonce has displaced is only that build's
    // to finish: address_scope_retired, as before.
    async releaseForeignPending(ctx, entry) {
        await this.assertChain(ctx);
        const receipt = await this.rpc(ctx, 'eth_getTransactionReceipt', [entry.hash]);
        let finalState;
        if (receipt) {
            if (receipt.transactionHash?.toLowerCase() !== entry.hash || !HASH.test(receipt.blockHash || '')
                || !['0x0', '0x1'].includes(receipt.status)) throw fail('The network returned an invalid receipt.');
            const receiptBlock = uint(receipt.blockNumber, 'receipt block', MAX_NONCE);
            const block = await this.rpc(ctx, 'eth_getBlockByNumber', [hex(receiptBlock), false]);
            const finalized = await this.rpc(ctx, 'eth_getBlockByNumber', ['finalized', false]);
            if (block?.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()
                || !finalized || uint(finalized.number, 'finalized block') < receiptBlock) {
                return { transactionHash: entry.hash, status: 'pending' };
            }
            finalState = receipt.status === '0x1' ? 'confirmed' : 'reverted';
        } else {
            const used = uint(await this.rpc(ctx, 'eth_getTransactionCount', [entry.transaction.from, 'finalized']),
                'finalized transaction count', MAX_NONCE + 1n);
            if (used <= uint(entry.transaction.nonce, 'saved nonce', MAX_NONCE)) {
                throw fail('This transaction was started in another version of the app. Finish it there.', 'address_scope_retired');
            }
            finalState = 'replaced';
        }
        await this.assertChain(ctx);
        await this.locked(ctx, async () => {
            const record = await this.read(ctx, true);
            // A tab that acknowledged it meanwhile has already released it.
            if (record.pending === entry.hash) {
                record.pending = null;
                record.transactions.find(item => item.hash === entry.hash).acknowledged = true;
                await this.save(ctx, record);
            }
        });
        return { transactionHash: entry.hash, status: 'released', kind: entry.kind, finalState };
    }

    async checkSweep(ctx, entry) {
        await this.assertChain(ctx);
        const receipt = await this.rpc(ctx, 'eth_getTransactionReceipt', [entry.hash]);
        if (!receipt) return { transactionHash: entry.hash, status: 'pending' };
        if (receipt.transactionHash?.toLowerCase() !== entry.hash || !HASH.test(receipt.blockHash || '')
            || !['0x0', '0x1'].includes(receipt.status)) throw fail('The network returned an invalid sweep receipt.');
        const block = await this.rpc(ctx, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
        const finalized = await this.rpc(ctx, 'eth_getBlockByNumber', ['finalized', false]);
        if (block?.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()
            || !finalized || uint(finalized.number, 'finalized block') < uint(receipt.blockNumber, 'receipt block')) {
            return { transactionHash: entry.hash, status: 'pending' };
        }
        await this.assertChain(ctx);
        await this.locked(ctx, async () => {
            const record = await this.read(ctx, true);
            if (record.pending === entry.hash) {
                record.pending = null;
                const saved = record.transactions.find(item => item.hash === entry.hash);
                saved.acknowledged = true;
                // Keep the verified terminal result across a close/reload,
                // atomically with releasing this transaction's pending slot.
                saved.outcome = { status: receipt.status === '0x1' ? 'confirmed' : 'reverted',
                    blockHash: receipt.blockHash.toLowerCase(), blockNumber: receipt.blockNumber };
                await this.save(ctx, record);
            }
        });
        return { transactionHash: entry.hash, status: receipt.status === '0x1' ? 'confirmed' : 'reverted' };
    }

    async transferEth(destination, amount) {
        const ctx = await this.context();
        const recipient = address(destination);
        const auth = this.action?.authorization;
        if (auth?.kind !== 'sweep' || auth.asset !== 'eth' || address(auth.destination) !== recipient
            || String(auth.amount) !== String(amount)) throw fail('Confirm the exact ETH return amount and destination first.', 4100);
        const value = amount === 'max' ? 0n : uint(amount, 'ETH amount');
        if (!value && amount !== 'max') throw fail('Enter a positive ETH amount.');
        return this.send({ from: this.address, to: recipient, data: '0x', value: hex(value) }, null);
    }

    async getStatus() {
        const ctx = await this.context();
        await this.reload();
        const snapshot = { ...copy(this.state), address: this.address, chainId: Number(ctx.chainId),
            assetKind: 'native_eth', tokenSymbol: 'ETH', tokenDecimals: 9 };
        if (!this.address) return snapshot;
        await this.assertChain(ctx);
        const eth = uint(await this.rpc(ctx, 'eth_getBalance', [this.address, 'latest']), 'ETH balance');
        await this.assertChain(ctx);
        return { ...snapshot, tokenBalance: (eth / ctx.weiPerUnit).toString(), ethBalance: eth.toString() };
    }


    // -----------------------------------------------------------------------
    // Sponsored withdrawals (ERC-4337)
    // -----------------------------------------------------------------------
    //
    // The SDK asks this provider for two things on that path and nothing else:
    //   personal_sign   the 32-byte hash of an operation, to be signed by this
    //                   address (the owner of the transit account), and
    //   zkapiBundler    the bundler it talks to, when the provider has one.
    // Both exist only for a protocol whose call profile has `sponsored`, a
    // profile that pins the gasless contracts, and a same-origin route to the
    // bundler. Neither does anything outside a running, authorized action that
    // carries `sponsored`: a signature is only ever made for the person's
    // confirmed withdrawal, and an operation only ever leaves the browser when
    // judgeSponsoredOperation (sponsoredOperation.mjs) accepts it against that
    // confirmation. The hash itself cannot be judged when it is signed; the
    // signature is inert until the operation it signs is sent, and the send is
    // the gate.

    sponsoredContext() {
        const { profile } = this.signerProtocol();
        if (!profile.sponsored) return null;
        let pins = null;
        try { pins = this.sponsoredPins(); } catch { pins = null; }
        const url = this.bundlerUrl();
        if (!pins || typeof url !== 'string' || !url) return null;
        return { profile, pins, url };
    }

    get zkapiBundler() {
        // Read by the SDK for every sponsored call; undefined is "no host
        // transport", and then this provider signs nothing for it either.
        return this.sponsoredContext() ? this.sponsoredTransport : undefined;
    }

    get sponsoredTransport() {
        if (!this.sponsoredTransportObject) {
            this.sponsoredTransportObject = Object.freeze({
                // The SDK uses `request` (a JSON-RPC style client) when it is
                // present; sendUserOperation is what marks the object a
                // bundler transport.
                request: ({ method, params = [] } = {}) => this.bundlerRequest(method, params),
                sendUserOperation: (operation, entryPoint) => this.bundlerRequest('eth_sendUserOperation', [operation, entryPoint])
            });
        }
        return this.sponsoredTransportObject;
    }

    sponsoredRefusal(message = SPONSORED_REFUSAL_MESSAGE, code = 4100) {
        return fail(message, code);
    }

    async signSponsored(params) {
        const ctx = await this.context();
        const action = this.action;
        const sponsored = this.sponsoredContext();
        if (!sponsored || !action || action.scope !== ctx.scope || !action.authorization?.sponsored) {
            throw this.sponsoredRefusal('Choose and confirm a sponsored withdrawal before signing.');
        }
        if (!Array.isArray(params) || params.length !== 2 || typeof params[0] !== 'string' || !HASH.test(params[0])
            || typeof params[1] !== 'string') {
            throw this.sponsoredRefusal('Only the hash of a sponsored operation can be signed here.');
        }
        if (action.sponsoredSignatures >= MAX_SPONSORED_SIGNATURES) {
            throw this.sponsoredRefusal('This action has reached its signature limit. Check its saved status.');
        }
        return this.locked(ctx, async () => {
            const record = await this.read(ctx, true);
            if (!sameAddress(params[1], record.address)) throw this.sponsoredRefusal('The signature was asked of a different payment address.');
            // personal_sign of the 32 raw bytes: the EIP-191 digest the transit
            // account verifies. Nothing else is ever signed through this path.
            const signature = await new Wallet(record.privateKey).signMessage(getBytes(params[0]));
            action.sponsoredSignatures = (action.sponsoredSignatures || 0) + 1;
            return signature.toLowerCase();
        });
    }

    async bundlerRequest(method, params) {
        const sponsored = this.sponsoredContext();
        if (!sponsored) throw Object.assign(fail('Sponsored withdrawals are not available here.', 'bundler_unavailable'));
        if (typeof method !== 'string' || !BUNDLER_METHODS.has(method) || !Array.isArray(params)) {
            throw this.sponsoredRefusal('This relay request is not available.', 'bundler_method');
        }
        if (method === 'eth_sendUserOperation') await this.assertSponsoredSend(params, sponsored);
        return this.bundlerCall(sponsored.url, method, params);
    }

    // The gate: judge the operation about to be sent against the running
    // action. A send with no action is refused too: the SDK re-sends a
    // journaled operation from its background checks, and that is not an
    // action the person confirmed. Starting the same withdrawal again from the
    // dialog is, and is judged then.
    async assertSponsoredSend(params, sponsored) {
        const ctx = await this.context();
        const action = this.action;
        if (!action || action.scope !== ctx.scope || !action.authorization?.sponsored) {
            throw this.sponsoredRefusal(SPONSORED_NOT_CONFIRMED_REFUSAL);
        }
        if (params.length !== 2 || typeof params[1] !== 'string') throw this.sponsoredRefusal();
        const record = await this.locked(ctx, () => this.read(ctx, true));
        try {
            judgeSponsoredOperation(params[0], action.authorization, {
                pins: sponsored.pins, vault: ctx.vault, chainId: ctx.chainId, owner: record.address,
                profile: sponsored.profile, entryPoint: params[1]
            });
        } catch (error) {
            if (error instanceof SponsoredOperationError) {
                // The words are the SDK-visible reason, with no operation bytes.
                throw this.sponsoredRefusal(error.message, 4100);
            }
            throw this.sponsoredRefusal();
        }
    }

    async bundlerCall(url, method, params) {
        const id = ++this.rpcId;
        const controller = new AbortController();
        let timer;
        let payload;
        try {
            payload = await Promise.race([(async () => {
                const response = await this.transport(url, {
                    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: controller.signal
                });
                if (!response.ok) throw new Error('http');
                return response.json();
            })(), new Promise((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, BUNDLER_TIMEOUT_MS);
            })]);
        } catch {
            throw Object.assign(fail('The relay service could not be reached. Nothing was sent.', 'bundler_unavailable'), { name: 'TimeoutError' });
        } finally { clearTimeout(timer); }
        if (!payload || payload.jsonrpc !== '2.0' || payload.id !== id) {
            throw Object.assign(fail('The relay service answered with an unexpected response.', 'bundler_unavailable'));
        }
        if (payload.error && typeof payload.error === 'object') {
            // The bundler's refusal is data the SDK reads (the AA code, ERC-7769's
            // codes): pass its numbers and text on, never an object it controls.
            const error = new Error(String(payload.error.message ?? 'The bundler refused the request.').slice(0, 500));
            error.rpcCode = Number.isSafeInteger(payload.error.code) ? payload.error.code : null;
            if (payload.error.data !== undefined) error.data = payload.error.data;
            throw error;
        }
        return payload.result;
    }

    async request({ method, params = [], zkapiRecovery } = {}) {
        const ctx = await this.context();
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
            await this.reload();
            if (method === 'eth_requestAccounts' && (!this.unlocked || !this.address)) {
                throw fail('Create or unlock your payment address and save its encrypted backup first.', 4100);
            }
            return this.address ? [this.address] : [];
        }
        if (method === 'eth_chainId') { await this.assertChain(ctx); return hex(ctx.chainId); }
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
            if (uint(params[0]?.chainId, 'payment network') !== ctx.chainId) throw fail('Use this payment address on its configured network.', 'wrong_network');
            await this.assertChain(ctx);
            return null;
        }
        if (method === 'wallet_watchAsset') return false;
        if (method === 'personal_sign') return this.signSponsored(params);
        if (method === 'eth_sendTransaction') {
            if (!Array.isArray(params) || params.length !== 1) throw fail('Exactly one transaction is required.', 4200);
            try {
                return await this.send(params[0], zkapiRecovery);
            } catch (error) {
                // send() throws only before broadcast. The SDK recognizes 4100
                // as definitely not submitted and retains a retryable note plan.
                // Once signed bytes are saved, broadcast() always returns their
                // hash, including on a lost/rejected RPC response.
                const rejection = Object.assign(fail(error.message, 4100), { addressCode: error.code });
                if (this.action?.failure?.error === error) {
                    this.action.failure.error = rejection;
                    if (error.fundingRequirement) rejection.fundingRequirement = copy(error.fundingRequirement);
                }
                throw rejection;
            }
        }
        if (!READ_METHODS.has(method)) throw fail('This Ethereum operation is unavailable for the payment address.', 4200);
        await this.assertChain(ctx);
        const result = await this.rpc(ctx, method, params);
        // Only an explicit recovery action may rebroadcast an SDK-acknowledged
        // transaction that the RPC cannot see. Plain receipt/status reads never send.
        if (method === 'eth_getTransactionReceipt' && !result && this.action?.authorization.kind === 'recovery') {
            const entry = await this.locked(ctx, async () => {
                const record = await this.read(ctx, true);
                return copy(record.transactions.find(item => item.hash === String(params[0]).toLowerCase()));
            });
            if (entry) await this.broadcast(ctx, entry);
        }
        return result;
    }
}

export function createAddressFundingProvider(options) { return new AddressFundingProvider(options); }
export const addressFundingWallet = new AddressFundingProvider();
export default addressFundingWallet;
