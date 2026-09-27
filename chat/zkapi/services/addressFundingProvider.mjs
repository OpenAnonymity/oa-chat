import { Wallet, Transaction, getAddress, keccak256 } from 'ethers';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { browserSdkTransport } from '@openanonymity/zkapi-browser-sdk/configure';
import { MAX_TRANSACTION_GAS_LIMIT as MAX_GAS } from '@openanonymity/zkapi-browser-sdk/gas';
import { createAddressFundingStore, isBrowserCustodyKey } from './addressFundingStore.mjs';

const UINT256_MAX = (1n << 256n) - 1n;
const MAX_NONCE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_GAS_PRICE = 300_000_000_000n;
const MAX_TRANSACTION_FEE = 20_000_000_000_000_000n; // 0.02 ETH; no automatic fee escalation.
const MIN_PRIORITY_FEE = 1_000_000n; // 0.001 gwei; retain a tip when the RPC suggests zero.
const NATIVE_WEI_PER_UNIT = 1_000_000_000n; // The native vault's private ledger uses gwei.
const FEE_QUOTE_LIFETIME_MS = 60_000;
const KDF_ITERATIONS = 600_000;
const MAX_BACKUP_BYTES = 4 * 1024 * 1024;
const READ_METHODS = new Set([
    'eth_call', 'eth_estimateGas', 'eth_getTransactionCount', 'eth_getBalance',
    'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_blockNumber', 'eth_getTransactionByHash',
    'eth_getTransactionReceipt', 'eth_getCode', 'eth_getLogs', 'eth_gasPrice',
    'eth_maxPriorityFeePerGas', 'eth_feeHistory'
]);
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
function publicPending(entry) {
    if (!entry) return null;
    return { hash: entry.hash, transaction: copy(entry.transaction), context: copy(entry.context), kind: entry.kind };
}

/** Browser-owned EIP-1193 signer. Only ensureAddress creates custody; no RPC,
 * initialization or status read signs transactions. Web Locks serialize custody
 * and nonce changes across tabs. The SDK owns private-note state/finality. */
export class AddressFundingProvider {
    constructor({
        getConfig = () => zkapiClient.config?.funding,
        transport = browserSdkTransport,
        store = createAddressFundingStore(),
        locks = globalThis.navigator?.locks,
        crypto = globalThis.crypto,
        createWallet = () => Wallet.createRandom(),
        resumeTransaction = record => zkapiClient.resumeExternalTransaction(record),
        createChannel = () => globalThis.window?.BroadcastChannel
            ? new globalThis.window.BroadcastChannel('oa-zkapi-address-funding') : null
    } = {}) {
        Object.assign(this, { getConfig, transport, store, locks, crypto, createWallet, resumeTransaction, createChannel });
        this.state = { exists: false, unlocked: false, backedUp: false, address: null, pending: null, migrationRequired: false };
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
        const native = funding.billing_asset === 'native_eth';
        if (native && (funding.billing_unit !== 'gwei'
            || uint(funding.native_asset_wei_per_unit, 'native payment scale') !== NATIVE_WEI_PER_UNIT)) {
            throw fail('The native ETH payment settings are invalid.', 'address_native_config');
        }
        if (funding.billing_asset && !['native_eth', 'erc20'].includes(funding.billing_asset)) {
            throw fail('This payment asset is not supported.', 'address_native_config');
        }
        const token = native ? null : address(funding.demo_billing_token_address);
        let rpc;
        try { rpc = new URL(funding.demo_rpc_url, globalThis.location?.href); } catch { throw fail('The payment network is unavailable.'); }
        if (rpc.username || rpc.password || (rpc.protocol !== 'https:'
            && !(rpc.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname)))) {
            throw fail('The payment network connection must use HTTPS.');
        }
        return { funding, chainId, vault, token, native, weiPerUnit: native ? NATIVE_WEI_PER_UNIT : null,
            rpc: rpc.href, scope: `${chainId}:${vault}:${native ? 'native-eth' : token}` };
    }

    async locked(ctx, callback, action = false) {
        if (!this.locks?.request) throw fail('This browser needs Web Locks support to safely manage a payment address.', 'address_storage');
        return this.locks.request(`oa-zkapi-address:${action ? 'action:' : ''}${ctx.scope}`,
            { mode: 'exclusive', ...(action ? { ifAvailable: true } : {}) }, lock => {
                if (action && !lock) throw fail('Another tab is using this payment address. Wait for that action to finish.', 'address_busy');
                return callback();
            });
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
                    || transaction.gasLimit > MAX_GAS || feeCap <= 0n || feeCap > MAX_GAS_PRICE
                    || feeCap * transaction.gasLimit > MAX_TRANSACTION_FEE
                    || BigInt(transaction.nonce) >= BigInt(record.highestNonce)) throw new Error();
                this.validateCall(ctx, record.address, entry.transaction, entry.context, entry.authorization);
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

    async transactionFees(ctx, gasLimit) {
        const [block, suggestedTip] = await Promise.all([
            this.rpc(ctx, 'eth_getBlockByNumber', ['latest', false]),
            this.rpc(ctx, 'eth_maxPriorityFeePerGas')
        ]);
        let baseFee;
        let priorityFee;
        try {
            baseFee = uint(block?.baseFeePerGas, 'network base fee');
            priorityFee = uint(suggestedTip, 'network priority fee');
        } catch {
            throw fail('The payment network returned incomplete or invalid fee information. Check again before sending.', 'address_fee_data');
        }
        const maxPriorityFeePerGas = priorityFee < MIN_PRIORITY_FEE ? MIN_PRIORITY_FEE : priorityFee;
        // EIP-1559 bounds a full block's base-fee increase to 12.5%, with
        // a one-wei minimum. Reserve two base fees where the safety cap allows.
        const nextBaseFee = baseFee + (baseFee / 8n || 1n);
        const minimumFee = nextBaseFee + maxPriorityFeePerGas;
        const desiredFee = (baseFee * 2n > nextBaseFee ? baseFee * 2n : nextBaseFee) + maxPriorityFeePerGas;
        const budgetCap = MAX_TRANSACTION_FEE / gasLimit;
        const feeCap = budgetCap < MAX_GAS_PRICE ? budgetCap : MAX_GAS_PRICE;
        const maxFeePerGas = desiredFee < feeCap ? desiredFee : feeCap;
        if (maxFeePerGas < minimumFee) {
            throw fail('Ethereum fees exceed the payment-address safety limit. Try when fees are lower.', 'address_fee_limit');
        }
        return { type: 2, maxFeePerGas, maxPriorityFeePerGas };
    }

    async getDepositFeeQuote() {
        const ctx = await this.context();
        if (!ctx.native) throw fail('A native ETH vault is required for this fee quote.', 'address_native_config');
        await this.assertChain(ctx);
        // Before the user funds the address there is no prepared private-note
        // call to simulate. Reserve the signer's spending ceiling, not a fee
        // estimate for a hypothetical maximum-gas transaction. The actual send
        // still simulates, quotes fresh fees and enforces every signing cap.
        const quotedAt = Date.now();
        const feeReserveWei = MAX_TRANSACTION_FEE.toString();
        return { feeReserveWei, feeWei: feeReserveWei, reserveKind: 'transaction_fee_ceiling', chainId: Number(ctx.chainId),
            quotedAt, expiresAt: quotedAt + FEE_QUOTE_LIFETIME_MS };
    }

    validateCall(ctx, own, input, recovery, authorization) {
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
            } else if (authorization.asset === 'token') {
                if (ctx.native || !sameAddress(to, ctx.token) || value !== 0n || selector !== 'a9059cbb' || !exactWords(2)
                    || wordAddress(0) !== address(authorization.destination) || wordUint(1) !== uint(authorization.amount, 'token amount')) deny();
            } else deny();
            return { to, value, data: normalized };
        }
        const nativeDeposit = ctx.native && sameAddress(to, ctx.vault) && selector === 'c588341c';
        if ((!nativeDeposit && value !== 0n) || !recovery || recovery.version !== 1
            || typeof recovery.deploymentId !== 'string' || !recovery.deploymentId
            || uint(recovery.chainId, 'recovery network') !== ctx.chainId
            || !sameAddress(recovery.contractAddress, ctx.vault)
            || Object.keys(recovery).some(key => !RECOVERY_FIELDS.has(key))) deny();
        if (sameAddress(to, ctx.token)) {
            if (recovery.kind !== 'token' || !exactWords(2)) deny();
            if (selector === '095ea7b3') {
                if (authorization.kind !== 'deposit' || wordAddress(0) !== ctx.vault
                    || ![0n, uint(authorization.amount, 'deposit amount')].includes(wordUint(1))) deny();
            } else if (selector === '40c10f19') {
                if (!['deposit', 'token'].includes(authorization.kind) || ctx.chainId !== 11155111n
                    || ctx.funding.demo_mint_enabled !== true || wordAddress(0) !== own
                    || !wordUint(1) || wordUint(1) > uint(authorization.amount, 'test token amount')) deny();
            } else deny();
        } else if (sameAddress(to, ctx.vault)) {
            if (selector === 'c588341c') {
                if (authorization.kind !== 'deposit' || recovery.kind !== 'deposit' || !exactWords(34)
                    || !recovery.operationId || !recovery.submissionId
                    || wordUint(1) !== uint(authorization.amount, 'deposit amount')
                    || wordUint(1) !== uint(recovery.amount, 'recovery amount')
                    || wordUint(0) !== uint(recovery.commitment, 'commitment')
                    || (ctx.native && (!wordUint(1) || value !== wordUint(1) * ctx.weiPerUnit))) deny();
            } else if (['7fca9c82', '9073639b'].includes(selector)) {
                if (authorization.kind !== 'withdrawal' || !['withdrawal', 'background-withdrawal', 'background-replacement'].includes(recovery.kind)
                    || !exactWords(56) || !recovery.operationId || !recovery.submissionId
                    || wordUint(1) !== ctx.chainId || wordAddress(2) !== ctx.vault
                    || wordUint(8) !== uint(recovery.noteId, 'note') || wordUint(9) !== uint(recovery.finalBalance, 'withdrawal amount')
                    || wordAddress(10) !== address(authorization.destination) || wordAddress(10) !== address(recovery.destination)
                    || wordUint(12) !== (selector === '7fca9c82' ? 1n : 0n)
                    || wordUint(14) !== 1504n || wordUint(47) !== 256n
                    || recovery.mode !== (selector === '7fca9c82' ? 'mutual' : 'escape')
                    || (authorization.mode && authorization.mode !== recovery.mode)
                    || (authorization.noteId != null && uint(authorization.noteId, 'note') !== wordUint(8))) deny();
            } else if (selector === 'ff8f5585') {
                if (authorization.kind !== 'finalization' || recovery.kind !== 'finalization' || !exactWords(1)
                    || !recovery.operationId || !recovery.submissionId
                    || wordUint(0) !== uint(authorization.noteId, 'note') || wordUint(0) !== uint(recovery.noteId, 'note')) deny();
            } else deny();
        } else deny();
        return { to, value, data: normalized };
    }

    async withAuthorizedAction(authorization, callback) {
        const ctx = await this.context();
        if (this.action) throw fail('A payment-address action is already running.', 'address_busy');
        if (!['deposit', 'withdrawal', 'finalization', 'token', 'recovery', 'sweep'].includes(authorization?.kind)
            || typeof callback !== 'function') throw fail('Choose a wallet action first.', 4100);
        return this.locked(ctx, async () => {
            await this.locked(ctx, async () => {
                const record = await this.read(ctx, true);
                if (!record.backedUp) throw fail('Save your encrypted address backup before funding or spending.', 'address_backup_required');
                if (record.pending && authorization.kind !== 'recovery') throw fail('Recover the saved transaction before starting another wallet action.', 'address_transaction_pending');
            });
            this.action = { authorization: copy(authorization), scope: ctx.scope, sends: 0 };
            this.notify();
            try { return await callback(); } finally { this.action = null; this.notify(); }
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
            const transaction = this.validateCall(ctx, record.address, input, recovery, authorization);
            if (maxEthReturn && await this.rpc(ctx, 'eth_getCode', [transaction.to, 'pending']) !== '0x') {
                throw fail('Choose an exact ETH amount when returning funds to a contract account.', 'address_sweep_contract');
            }
            const maximumSends = authorization.kind === 'deposit' && !ctx.native ? 6 : 1;
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
            const fees = await this.transactionFees(ctx, gasLimit);
            const reserve = fees.maxFeePerGas * gasLimit;
            const balance = uint(await this.rpc(ctx, 'eth_getBalance', [record.address, 'pending']), 'ETH balance');
            if (maxEthReturn) {
                if (balance <= reserve) throw fail('This payment address needs more ETH to cover the return transaction fee.', 'address_insufficient_eth');
                transaction.value = balance - reserve;
                authorization = { ...this.action.authorization, amount: transaction.value.toString() };
            }
            if (balance < transaction.value + reserve) throw fail('Send more ETH to the payment address for Ethereum network fees.', 'address_insufficient_eth');
            await this.assertChain(ctx);
            const raw = await new Wallet(record.privateKey).signTransaction({ ...transaction,
                chainId: ctx.chainId, nonce: Number(nonce), gasLimit, ...fees });
            const hash = keccak256(raw).toLowerCase();
            const entry = { hash, raw, kind: authorization.kind, authorization: copy(authorization), context: copy(recovery),
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
            await this.assertChain(ctx);
            await this.broadcast(ctx, entry);
            if (entry.kind === 'sweep') return this.checkSweep(ctx, entry);
            // The SDK validates original claims and persists the transaction hash
            // before calling acknowledgeTransaction. A failed callback retains it.
            return this.resumeTransaction({ transaction: copy(entry.transaction), hash: entry.hash, context: copy(entry.context) });
        });
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
                record.transactions.find(item => item.hash === entry.hash).acknowledged = true;
                await this.save(ctx, record);
            }
        });
        return { transactionHash: entry.hash, status: receipt.status === '0x1' ? 'confirmed' : 'reverted' };
    }

    async transferTokens(destination, amount) {
        const ctx = await this.context();
        if (ctx.native) throw fail('This payment address uses ETH.', 'address_native_config');
        const recipient = address(destination);
        const value = uint(amount, 'token amount');
        const auth = this.action?.authorization;
        if (auth?.kind !== 'sweep' || auth.asset !== 'token' || address(auth.destination) !== recipient
            || uint(auth.amount, 'authorized amount') !== value || !value) throw fail('Confirm the exact token return amount and destination first.', 4100);
        return this.send({ from: this.address, to: ctx.token,
            data: `0xa9059cbb${recipient.slice(2).padStart(64, '0')}${word(value)}` }, null);
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
            assetKind: ctx.native ? 'native_eth' : 'erc20',
            tokenSymbol: ctx.native ? 'ETH' : String(ctx.funding.billing_token_symbol || 'USDC'),
            tokenDecimals: ctx.native ? 9 : Number(ctx.funding.billing_token_decimals ?? 6) };
        if (!this.address) return snapshot;
        await this.assertChain(ctx);
        if (ctx.native) {
            const eth = uint(await this.rpc(ctx, 'eth_getBalance', [this.address, 'latest']), 'ETH balance');
            await this.assertChain(ctx);
            return { ...snapshot, tokenBalance: (eth / ctx.weiPerUnit).toString(), ethBalance: eth.toString() };
        }
        const [tokens, eth] = await Promise.all([
            this.rpc(ctx, 'eth_call', [{ to: ctx.token, data: `0x70a08231${this.address.slice(2).padStart(64, '0')}` }, 'latest']),
            this.rpc(ctx, 'eth_getBalance', [this.address, 'latest'])
        ]);
        await this.assertChain(ctx);
        return { ...snapshot, tokenBalance: uint(tokens, 'token balance').toString(), ethBalance: uint(eth, 'ETH balance').toString() };
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
        if (method === 'eth_sendTransaction') {
            if (!Array.isArray(params) || params.length !== 1) throw fail('Exactly one transaction is required.', 4200);
            try {
                return await this.send(params[0], zkapiRecovery);
            } catch (error) {
                // send() throws only before broadcast. The SDK recognizes 4100
                // as definitely not submitted and retains a retryable note plan.
                // Once signed bytes are saved, broadcast() always returns their
                // hash, including on a lost/rejected RPC response.
                throw Object.assign(fail(error.message, 4100), { addressCode: error.code });
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
