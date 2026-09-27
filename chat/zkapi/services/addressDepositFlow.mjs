const positiveInteger = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);

function validateIntent(value, scope) {
    if (!value || value.version !== 1 || value.scope !== scope
        || !positiveInteger(value.amount) || !positiveInteger(value.depositWei)
        || BigInt(value.depositWei) !== BigInt(value.amount) * 1_000_000_000n
        || BigInt(value.amount) > BigInt(Number.MAX_SAFE_INTEGER)
        || !/^\d+(?:\.\d{1,9})?$/.test(value.ethAmount)
        || !/^\d+(?:\.\d{1,6})?$/.test(value.usdAmount)) {
        throw new Error('The saved deposit could not be read. Your funding address is unchanged.');
    }
    const [whole, fraction = ''] = value.ethAmount.split('.');
    if (BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0')) !== BigInt(value.amount)) {
        throw new Error('The saved ETH deposit amount does not match.');
    }
    return value;
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
            this.scope = `${funding.chain_id}:${funding.contract_address.toLowerCase()}:${address.toLowerCase()}`;
            const saved = await this.store.read(this.scope);
            if (!this.running || generation !== this.generation) return;
            this.intent = saved ? validateIntent(saved, this.scope) : null;
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
    }

    async setAmount(usd) {
        this.requestedUsd = usd;
        const edit = ++this.editGeneration;
        const generation = this.generation;
        this.ready = false;
        this.dirty = true;
        this.error = '';
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

    async check() {
        if (!this.running || !this.intent || this.dirty) return;
        const generation = this.generation;
        const edit = this.editGeneration;
        const intent = this.intent;
        try {
            const [status, fee] = await Promise.all([this.wallet.getStatus(), this.wallet.getDepositFeeQuote()]);
            if (!this.running || generation !== this.generation || edit !== this.editGeneration || intent !== this.intent) return;
            if (!positiveInteger(String(fee.feeReserveWei))) throw new Error('Network fees could not be estimated.');
            this.status = status;
            this.fee = fee;
            this.checkedAt = this.now();
            this.error = '';
            this.ready = !this.wallet.hasPendingTransaction
                && BigInt(status.ethBalance) >= BigInt(intent.depositWei) + BigInt(fee.feeReserveWei);
        } catch (error) {
            if (generation !== this.generation || edit !== this.editGeneration) return;
            this.error = error.message;
            this.ready = false;
        }
        this.changed();
    }

    get totalWei() {
        return this.intent && this.fee ? (BigInt(this.intent.depositWei) + BigInt(this.fee.feeReserveWei)).toString() : null;
    }

    async verifyReady() {
        if (!this.running || !this.intent || !this.ready) throw new Error('Wait until the ETH has arrived before choosing Next.');
        const intent = this.intent;
        const edit = this.editGeneration;
        const saved = await this.store.read(this.scope);
        if (!saved || JSON.stringify(saved) !== JSON.stringify(intent)) {
            this.ready = false;
            throw new Error('The deposit amount changed in another tab. Reopen this screen to use the saved amount.');
        }
        await this.check();
        if (!this.ready || intent !== this.intent || edit !== this.editGeneration) {
            throw new Error(this.error || 'The address needs more ETH to cover the deposit and current network fees.');
        }
        return { ...intent };
    }

    async complete() {
        await this.store.write(this.scope, null);
        this.intent = null;
        this.ready = false;
    }
}
