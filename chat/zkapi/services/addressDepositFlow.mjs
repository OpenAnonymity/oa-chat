const positiveInteger = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const nonNegativeInteger = value => typeof value === 'string' && /^\d+$/.test(value);

function validateIntent(value, scope) {
    if (!value || value.version !== 1 || value.scope !== scope
        || !positiveInteger(value.amount) || !positiveInteger(value.depositWei)
        || BigInt(value.depositWei) !== BigInt(value.amount) * 1_000_000_000n
        || BigInt(value.amount) > BigInt(Number.MAX_SAFE_INTEGER)
        || !/^\d+(?:\.\d{1,9})?$/.test(value.ethAmount)
        || (!(value.usdAmount === null && value.source === 'saved-deposit')
            && !/^\d+(?:\.\d{1,6})?$/.test(value.usdAmount))) {
        throw new Error('The saved deposit could not be read. Your funding address is unchanged.');
    }
    const [whole, fraction = ''] = value.ethAmount.split('.');
    if (BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0')) !== BigInt(value.amount)) {
        throw new Error('The saved ETH deposit amount does not match.');
    }
    return value;
}

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
export class AddressDepositFlow {
    constructor({ wallet, client, store, changed = () => {}, now = Date.now, interval = 5_000 }) {
        Object.assign(this, { wallet, client, store, changed, now, interval });
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

    async start(suggestedUsd = '10') {
        if (this.running) return;
        this.running = true;
        const generation = ++this.generation;
        try {
            if (!this.client.isNativeEthFunding) throw new Error('This deployment does not yet support ETH deposits.');
            const address = await this.wallet.ensureAddress();
            if (!this.running || generation !== this.generation) return;
            const funding = this.client.config.funding;
            this.address = address;
            this.scope = `${funding.chain_id}:${funding.contract_address.toLowerCase()}:${address.toLowerCase()}`;
            const saved = await this.store.read(this.scope);
            if (!this.running || generation !== this.generation) return;
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
                const restored = saved?.amount === amount ? validateIntent(saved, this.scope)
                    : validateIntent({ version: 1, scope: this.scope, amount,
                        ethAmount: `${units / 1_000_000_000n}.${String(units % 1_000_000_000n).padStart(9, '0')}`,
                        depositWei: String(units * 1_000_000_000n), usdAmount: null,
                        source: 'saved-deposit', createdAt: this.now() }, this.scope);
                await this.store.write(this.scope, restored);
                if (!this.running || generation !== this.generation) return;
                this.intent = restored;
            } else this.intent = saved ? validateIntent(saved, this.scope) : null;
            if (!this.intent) await this.setAmount(suggestedUsd);
            if (!this.running || generation !== this.generation) return;
            await this.check();
        } catch (error) {
            if (generation === this.generation) { this.error = error.message; this.ready = false; this.changed(); }
        } finally {
            if (this.running && generation === this.generation) this.schedule();
        }
    }

    stop() {
        this.running = false;
        this.generation++;
        clearTimeout(this.timer);
        this.timer = null;
        this.ready = false;
    }

    invalidate() {
        this.editGeneration++;
        this.dirty = true;
        this.ready = false;
        this.error = '';
        this.fee = null;
    }

    async setAmount(usd) {
        if (this.client.config?.pending_deposit) {
            this.ready = false;
            this.error = 'The saved deposit amount cannot change while it is in progress.';
            this.changed();
            return;
        }
        this.requestedUsd = usd;
        const edit = ++this.editGeneration;
        const generation = this.generation;
        this.ready = false;
        this.dirty = true;
        this.error = '';
        this.fee = null;
        try {
            const quote = await this.client.quoteDepositUsd(usd);
            if (!this.running || generation !== this.generation || edit !== this.editGeneration) return;
            const intent = validateIntent({ version: 1, scope: this.scope,
                amount: String(quote.amount), ethAmount: quote.ethAmount,
                depositWei: String(quote.depositWei), usdAmount: quote.usdAmount,
                createdAt: this.now(), priceUpdatedAt: quote.priceUpdatedAt }, this.scope);
            // Serialize writes so an earlier slow edit cannot replace the last
            // completed intent. Publish the receiving instructions after commit.
            this.writes = this.writes.catch(() => {}).then(() => this.store.write(this.scope, intent));
            await this.writes;
            if (!this.running || generation !== this.generation || edit !== this.editGeneration) return;
            this.intent = intent;
            this.dirty = false;
            await this.check();
        } catch (error) {
            if (generation === this.generation && edit === this.editGeneration) {
                this.error = error.message; this.ready = false; this.changed();
            }
        }
    }

    schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(async () => {
            try {
                if (!this.intent && this.requestedUsd != null) await this.setAmount(this.requestedUsd);
                else await this.check();
            } finally { if (this.running) this.schedule(); }
        }, this.interval);
    }

    async check({ forceQuote = false, explicit = false } = {}) {
        if (!this.running || !this.intent || this.dirty || (this.verifying && !explicit)) return;
        const generation = this.generation;
        const edit = this.editGeneration;
        const intent = this.intent;
        const check = ++this.checkGeneration;
        try {
            const fresh = this.fee && this.fee.expiresAt > this.now();
            const [status, result] = await Promise.all([
                this.wallet.getStatus(),
                !forceQuote && fresh ? this.fee : this.wallet.getDepositFeeQuote(intent)
            ]);
            if (!this.running || generation !== this.generation || edit !== this.editGeneration
                || intent !== this.intent || check !== this.checkGeneration) return;
            if (!nonNegativeInteger(status?.ethBalance)) throw new Error('The address balance could not be checked.');
            const fee = validateFeeQuote(result, intent, this.client.config.funding, this.address, this.now());
            this.status = status;
            this.fee = fee;
            this.checkedAt = this.now();
            this.error = '';
            this.ready = !this.wallet.hasPendingTransaction
                && BigInt(status.ethBalance) >= BigInt(intent.depositWei) + BigInt(fee.feeReserveWei);
        } catch (error) {
            if (generation !== this.generation || edit !== this.editGeneration || check !== this.checkGeneration) return;
            this.error = error.message;
            this.ready = false;
            this.fee = null;
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
        if (!this.running || !this.intent || !this.ready || !this.fee || this.verifying) throw new Error('Wait until the ETH has arrived before choosing Next.');
        const intent = this.intent;
        const edit = this.editGeneration;
        const displayedLimit = BigInt(this.fee.feeReserveWei);
        this.verifying = true;
        try {
            const verifyStoredIntent = async () => {
                const saved = await this.store.read(this.scope);
                if (!saved || JSON.stringify(saved) !== JSON.stringify(intent)) {
                    this.ready = false;
                    throw new Error('The deposit amount changed in another tab. Reopen this screen to use the saved amount.');
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
        await this.store.write(this.scope, null);
        this.intent = null;
        this.ready = false;
    }
}
