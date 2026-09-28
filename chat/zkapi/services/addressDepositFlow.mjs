import { DepositAmount, validateIntent, withInput } from './depositAmount.mjs';

const positiveInteger = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const nonNegativeInteger = value => typeof value === 'string' && /^\d+$/.test(value);
const depositChanged = 'The deposit amount changed in another tab. Reopen this screen to use the saved amount.';

function validateFeeQuote(fee, intent, funding, address, now) {
    if (!fee || !positiveInteger(fee.expectedFeeWei) || !positiveInteger(fee.feeReserveWei)
        || !nonNegativeInteger(fee.feeBufferWei)
        || BigInt(fee.expectedFeeWei) + BigInt(fee.feeBufferWei) !== BigInt(fee.feeReserveWei)
        || String(fee.amount) !== intent.amount || String(fee.depositWei) !== intent.depositWei
        || Number(fee.chainId) !== Number(funding.chain_id)
        || String(fee.address).toLowerCase() !== address.toLowerCase()
        || String(fee.contractAddress).toLowerCase() !== funding.contract_address.toLowerCase()
        || typeof fee.operationId !== 'string' || !fee.operationId
        || typeof fee.depositCommitment !== 'string' || !fee.depositCommitment
        || !Number.isSafeInteger(fee.quotedAt) || fee.quotedAt > now
        || !Number.isSafeInteger(fee.expiresAt) || fee.expiresAt <= now
        || fee.expiresAt <= fee.quotedAt) {
        throw new Error('The deposit fee quote could not be verified. Check again before sending ETH.');
    }
    return fee;
}

// This controller only reads public chain state. It cannot sign, submit or
// recover transactions. Explicit Next handlers own those separate capabilities.
export class AddressDepositFlow extends DepositAmount {
    constructor({ wallet, client, store, changed = () => {}, now = Date.now, interval = 5_000 }) {
        super({ client, changed, now });
        Object.assign(this, { wallet, store, interval });
        this.intent = null;
        this.status = null;
        this.fee = null;
        this.error = '';
        this.ready = false;
        this.generation = 0;
        this.editGeneration = 0;
        this.checkGeneration = 0;
        this.running = false;
        this.writes = Promise.resolve();
    }

    async start(suggestedAmount = '10', currency = 'usd', { initialIntent = null, preferInput = false } = {}) {
        if (this.running) return;
        this.running = true;
        const generation = ++this.generation;
        let edit = this.editGeneration;
        this.initializing = true;
        try {
            if (!this.client.isNativeEthFunding) throw new Error('This deployment does not yet support ETH deposits.');
            const address = await this.wallet.ensureAddress();
            if (!this.running || generation !== this.generation) return;
            const funding = this.client.config.funding;
            this.address = address;
            this.scope = `${funding.chain_id}:${funding.contract_address.toLowerCase()}:${address.toLowerCase()}`;
            const saved = await this.store.read(this.scope);
            if (!this.running || generation !== this.generation) return;
            if (edit !== this.editGeneration) {
                // An edit during address/storage hydration supersedes restoration.
                edit = this.editGeneration;
                initialIntent = null;
                preferInput = true;
                suggestedAmount = this.requestedAmount?.value ?? suggestedAmount;
                currency = this.requestedAmount?.currency ?? currency;
            }
            this.initializing = false;
            const pending = this.client.config?.pending_deposit;
            if (pending) {
                const amount = String(pending.amount);
                if (!pending.funding_quote_available || !positiveInteger(amount)
                    || BigInt(amount) > BigInt(Number.MAX_SAFE_INTEGER)) {
                    throw new Error('Check the saved deposit before continuing.');
                }
                // A plan created through MetaMask may have no address-scoped
                // USD intent. The SDK principal is authoritative: never reprice
                // or replace it when changing funding methods or resuming.
                const units = BigInt(amount);
                const restored = withInput(saved?.amount === amount ? validateIntent(saved, this.scope)
                    : validateIntent({ version: 1, scope: this.scope, amount,
                        ethAmount: `${units / 1_000_000_000n}.${String(units % 1_000_000_000n).padStart(9, '0')}`,
                        depositWei: String(units * 1_000_000_000n), usdAmount: null,
                        source: 'saved-deposit', createdAt: this.now() }, this.scope));
                if (!await this.commitIntent(restored, generation, edit, saved ?? null)) return;
                this.intent = restored;
            } else if (initialIntent) {
                const selected = withInput(validateIntent({ ...initialIntent, scope: this.scope }, this.scope));
                if (!await this.commitIntent(selected, generation, edit, saved ?? null)) return;
                this.intent = selected;
                this.dirty = false;
            } else if (saved && !preferInput) {
                const restored = withInput(validateIntent(saved, this.scope));
                if (restored !== saved && !await this.commitIntent(restored, generation, edit, saved)) return;
                if (!this.running || generation !== this.generation) return;
                this.intent = restored;
            } else this.intent = null;
            if (!this.intent) await this.setAmount(suggestedAmount, currency);
            if (!this.running || generation !== this.generation) return;
            await this.check();
        } catch (error) {
            if (generation === this.generation) { this.error = error.message; this.ready = false; this.changed(); }
        } finally {
            this.initializing = false;
            if (this.running && generation === this.generation) this.schedule();
        }
    }

    stop() {
        this.clearQuoteExpiry();
        this.running = false;
        this.generation++;
        clearTimeout(this.timer);
        this.timer = null;
        this.ready = false;
    }

    invalidate() {
        this.clearQuoteExpiry();
        this.editGeneration++;
        this.dirty = true;
        this.ready = false;
        this.error = '';
        this.fee = null;
    }

    clearQuoteExpiry() {
        clearTimeout(this.quoteExpiryTimer);
        this.quoteExpiryTimer = null;
    }

    scheduleQuoteExpiry(fee) {
        this.clearQuoteExpiry();
        const generation = this.generation;
        const expire = () => {
            if (!this.running || generation !== this.generation || this.fee !== fee) return;
            const remaining = fee.expiresAt - this.now();
            if (remaining > 0) {
                this.quoteExpiryTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
                return;
            }
            this.quoteExpiryTimer = null;
            this.fee = null;
            this.ready = false;
            this.changed({ expired: true });
        };
        this.quoteExpiryTimer = setTimeout(expire, Math.max(0, Math.min(fee.expiresAt - this.now(), 2_147_483_647)));
    }

    async setAmount(...args) {
        this.clearQuoteExpiry();
        return super.setAmount(...args);
    }

    async commitIntent(intent, generation, edit, expected) {
        const current = () => this.running && generation === this.generation && edit === this.editGeneration;
        const write = this.writes.catch(() => {}).then(async () => {
            if (!current()) return false;
            if (expected !== undefined) {
                // Display changes and legacy migration must compare and write
                // inside one storage transaction, not race another tab's edit.
                if (typeof this.store.compareAndSwap !== 'function') {
                    throw new Error('Safe deposit storage is unavailable. Reopen this screen to try again.');
                }
                if (await this.store.compareAndSwap(this.scope, expected, intent) !== true) throw new Error(depositChanged);
            } else await this.store.write(this.scope, intent);
            return current();
        });
        this.writes = write;
        return write;
    }

    schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(async () => {
            try {
                if (!this.intent && this.requestedAmount) await this.setAmount(this.requestedAmount.value, this.requestedAmount.currency);
                else await this.check();
            } finally { if (this.running) this.schedule(); }
        }, this.interval);
    }

    async check({ forceQuote = false, explicit = false } = {}) {
        if (!this.running || !this.intent || this.dirty || this.changingCurrency || (this.verifying && !explicit)) return;
        const generation = this.generation;
        const edit = this.editGeneration;
        const intent = this.intent;
        const check = ++this.checkGeneration;
        try {
            const fresh = this.fee && this.fee.expiresAt > this.now();
            if (this.fee && !fresh) {
                // Hide expired payment instructions before a replacement RPC;
                // a stalled network read must not leave the old QR actionable.
                this.clearQuoteExpiry();
                this.fee = null;
                this.ready = false;
                this.changed({ expired: true });
            }
            const [status, result] = await Promise.all([
                this.wallet.getStatus(),
                !forceQuote && fresh ? this.fee : this.wallet.getDepositFeeQuote(intent, {
                    isCurrent: () => this.running && generation === this.generation && edit === this.editGeneration
                        && intent === this.intent && check === this.checkGeneration
                })
            ]);
            if (!this.running || generation !== this.generation || edit !== this.editGeneration
                || intent !== this.intent || check !== this.checkGeneration) return;
            if (!nonNegativeInteger(status?.ethBalance)) throw new Error('The address balance could not be checked.');
            const fee = validateFeeQuote(result, intent, this.client.config.funding, this.address, this.now());
            this.status = status;
            this.fee = fee;
            this.scheduleQuoteExpiry(fee);
            this.checkedAt = this.now();
            this.error = '';
            this.ready = !this.wallet.hasPendingTransaction
                && BigInt(status.ethBalance) >= BigInt(intent.depositWei) + BigInt(fee.feeReserveWei);
        } catch (error) {
            if (generation !== this.generation || edit !== this.editGeneration || check !== this.checkGeneration) return;
            this.error = error.message;
            this.ready = false;
            this.fee = null;
            this.clearQuoteExpiry();
        }
        this.changed();
    }

    get totalWei() {
        return this.intent && this.fee ? (BigInt(this.intent.depositWei) + BigInt(this.fee.feeReserveWei)).toString() : null;
    }

    get remainingWei() {
        const total = this.totalWei;
        if (total == null || !nonNegativeInteger(this.status?.ethBalance)) return null;
        const remaining = BigInt(total) - BigInt(this.status.ethBalance);
        return (remaining > 0n ? remaining : 0n).toString();
    }

    async verifyReady() {
        if (!this.running || !this.intent || !this.ready || !this.fee || this.verifying || this.changingCurrency) throw new Error('Wait until the ETH has arrived before choosing Next.');
        const intent = this.intent;
        const edit = this.editGeneration;
        const displayedLimit = BigInt(this.fee.feeReserveWei);
        this.verifying = true;
        try {
            const verifyStoredIntent = async () => {
                const saved = await this.store.read(this.scope);
                if (!saved || JSON.stringify(saved) !== JSON.stringify(intent)) {
                    this.ready = false;
                    throw new Error(depositChanged);
                }
            };
            await verifyStoredIntent();
            await this.check({ forceQuote: true, explicit: true });
            await verifyStoredIntent();
            if (!this.running || !this.ready || intent !== this.intent || edit !== this.editGeneration) {
                throw new Error(this.error || 'The address needs more ETH to cover the deposit and current network fees.');
            }
            if (BigInt(this.fee.feeReserveWei) > displayedLimit) {
                throw new Error('Network fees changed. Review the updated amount, then choose Next again.');
            }
            return { ...intent, preparedOperationId: this.fee.operationId,
                depositCommitment: this.fee.depositCommitment,
                feeLimitWei: this.fee.feeReserveWei, feeQuoteExpiresAt: this.fee.expiresAt };
        } finally { this.verifying = false; }
    }

    async complete() {
        this.clearQuoteExpiry();
        await this.store.write(this.scope, null);
        this.intent = null;
        this.ready = false;
    }
}
