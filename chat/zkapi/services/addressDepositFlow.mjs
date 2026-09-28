const positiveInteger = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const nonNegativeInteger = value => typeof value === 'string' && /^\d+$/.test(value);
const depositChanged = 'The deposit amount changed in another tab. Reopen this screen to use the saved amount.';

function formatDecimal(units, decimals) {
    const scale = 10n ** BigInt(decimals);
    const fraction = String(units % scale).padStart(decimals, '0').replace(/0+$/, '');
    return `${units / scale}${fraction ? `.${fraction}` : ''}`;
}

function ethUnits(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length > 128 || !/^(?:\d+(?:\.\d{0,9})?|\.\d{1,9})$/.test(text)) {
        throw new Error('Enter an ETH amount with up to 9 decimal places.');
    }
    const [whole, fraction = ''] = text.split('.');
    const units = BigInt(whole || '0') * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
    if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Choose a smaller positive ETH deposit amount.');
    }
    return units;
}

function cachedUsdQuote(value, price) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length > 128 || !/^\d+(?:\.\d{0,6})?$/.test(text)) {
        throw new Error('Enter a positive amount with no more than 6 decimal places.');
    }
    const [whole, fraction = ''] = text.split('.');
    const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
    // Match the SDK's nativeUnitsForUsd: six USD decimals, eight price-feed
    // decimals, and whole gwei rounded up. The SDK getter validates the price.
    const numerator = micros * 100_000_000_000n;
    const denominator = BigInt(price.answer);
    const amount = (numerator + denominator - 1n) / denominator;
    if (micros <= 0n || amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Choose a smaller positive deposit amount.');
    }
    return { amount: String(amount), ethAmount: formatDecimal(amount, 9),
        depositWei: String(amount * 1_000_000_000n), usdAmount: formatDecimal(micros, 6),
        priceUpdatedAt: price.updated_at };
}

function validateIntent(value, scope) {
    if (!value || value.version !== 1 || value.scope !== scope
        || !positiveInteger(value.amount) || !positiveInteger(value.depositWei)
        || BigInt(value.depositWei) !== BigInt(value.amount) * 1_000_000_000n
        || BigInt(value.amount) > BigInt(Number.MAX_SAFE_INTEGER)
        || !/^\d+(?:\.\d{1,9})?$/.test(value.ethAmount)
        || (!(value.usdAmount === null && ['saved-deposit', 'eth-input'].includes(value.source))
            && !/^\d+(?:\.\d{1,6})?$/.test(value.usdAmount))) {
        throw new Error('The saved deposit could not be read. Your funding address is unchanged.');
    }
    const [whole, fraction = ''] = value.ethAmount.split('.');
    if (BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0')) !== BigInt(value.amount)) {
        throw new Error('The saved ETH deposit amount does not match.');
    }
    if (value.inputCurrency !== undefined || value.inputAmount !== undefined) {
        if (!['usd', 'eth'].includes(value.inputCurrency) || typeof value.inputAmount !== 'string'
            || (value.inputCurrency === 'eth' && ethUnits(value.inputAmount) !== BigInt(value.amount))
            || (value.inputCurrency === 'usd' && (!/^\d+(?:\.\d{1,6})?$/.test(value.inputAmount)
                || !/[1-9]/.test(value.inputAmount)))) {
            throw new Error('The saved deposit input could not be read. Your funding address is unchanged.');
        }
    }
    return value;
}

function withInput(intent) {
    if (intent.inputCurrency) return intent;
    return { ...intent, inputCurrency: intent.usdAmount === null ? 'eth' : 'usd',
        inputAmount: intent.usdAmount ?? intent.ethAmount };
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

    async start(suggestedAmount = '10', currency = 'usd') {
        if (this.running) return;
        this.running = true;
        const generation = ++this.generation;
        const edit = this.editGeneration;
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
                const restored = withInput(saved?.amount === amount ? validateIntent(saved, this.scope)
                    : validateIntent({ version: 1, scope: this.scope, amount,
                        ethAmount: `${units / 1_000_000_000n}.${String(units % 1_000_000_000n).padStart(9, '0')}`,
                        depositWei: String(units * 1_000_000_000n), usdAmount: null,
                        source: 'saved-deposit', createdAt: this.now() }, this.scope));
                if (!await this.commitIntent(restored, generation, edit, saved ?? null)) return;
                this.intent = restored;
            } else if (saved) {
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

    currentPrice() {
        // The SDK getter validates the oracle, deployment and freshness. Never
        // wait for a remote refresh during a presentation-only currency change.
        const price = this.client.nativePriceQuote;
        if (!price || !positiveInteger(String(price.answer)) || price.decimals !== 8) {
            throw new Error('The current ETH price is unavailable. Try again shortly.');
        }
        return price;
    }

    async setAmount(value, currency = 'usd', { check = true, useCachedPrice = false } = {}) {
        if (this.client.config?.pending_deposit) {
            this.ready = false;
            this.error = 'The saved deposit amount cannot change while it is in progress.';
            this.changed();
            return false;
        }
        this.requestedAmount = { value, currency };
        const edit = ++this.editGeneration;
        const generation = this.generation;
        this.ready = false;
        this.dirty = true;
        this.changingCurrency = false;
        this.error = '';
        this.fee = null;
        try {
            if (!['usd', 'eth'].includes(currency)) throw new Error('Choose USD or ETH for the deposit amount.');
            let quote;
            if (currency === 'eth') {
                const amount = ethUnits(value);
                quote = { amount: String(amount), ethAmount: formatDecimal(amount, 9),
                    depositWei: String(amount * 1_000_000_000n), usdAmount: null,
                    source: 'eth-input', priceUpdatedAt: this.client.nativePriceQuote?.updated_at };
            } else quote = useCachedPrice ? cachedUsdQuote(value, this.currentPrice())
                : await this.client.quoteDepositUsd(value);
            if (!this.running || generation !== this.generation || edit !== this.editGeneration) return false;
            const intent = validateIntent({ version: 1, scope: this.scope,
                amount: String(quote.amount), ethAmount: quote.ethAmount,
                depositWei: String(quote.depositWei), usdAmount: quote.usdAmount,
                ...(quote.source ? { source: quote.source } : {}),
                inputCurrency: currency, inputAmount: currency === 'eth' ? quote.ethAmount : quote.usdAmount,
                createdAt: this.now(), priceUpdatedAt: quote.priceUpdatedAt }, this.scope);
            // Serialize writes so an earlier slow edit cannot replace the last
            // completed intent. Publish the receiving instructions after commit.
            if (!await this.commitIntent(intent, generation, edit)) return false;
            this.intent = intent;
            this.dirty = false;
            // A currency toggle can flush the current input locally, then run
            // one background check after persisting the selected display unit.
            if (check) await this.check();
            else this.changed();
            return this.running && generation === this.generation && edit === this.editGeneration;
        } catch (error) {
            if (generation === this.generation && edit === this.editGeneration) {
                this.error = error.message; this.ready = false; this.changed();
            }
            return false;
        }
    }

    async setCurrency(currency) {
        if (!this.running || !this.intent || this.dirty || this.verifying) return false;
        const previous = this.intent;
        const generation = this.generation;
        const edit = ++this.editGeneration;
        this.ready = false;
        this.changingCurrency = true;
        this.error = '';
        try {
            if (!['usd', 'eth'].includes(currency)) throw new Error('Choose USD or ETH for the deposit amount.');
            let inputAmount = previous.ethAmount;
            if (currency === 'usd') {
                inputAmount = previous.usdAmount;
                if (inputAmount === null) {
                    const price = this.currentPrice();
                    // Round the reference display up to a USD micro so even a
                    // one-gwei principal has a positive input. This value never
                    // feeds back into the fixed ETH principal on a unit toggle.
                    const numerator = BigInt(previous.amount) * BigInt(price.answer);
                    const micros = (numerator + 100_000_000_000n - 1n) / 100_000_000_000n;
                    inputAmount = formatDecimal(micros, 6);
                }
            }
            const intent = validateIntent({ ...previous, inputCurrency: currency, inputAmount }, this.scope);
            if (!await this.commitIntent(intent, generation, edit, previous)) return false;
            this.intent = intent;
            this.changingCurrency = false;
            this.changed();
            // Balance and fee RPCs must not hold the unit button busy. Next
            // stays disabled until this fresh check completes successfully.
            void this.check();
            return this.running && generation === this.generation && edit === this.editGeneration;
        } catch (error) {
            if (generation === this.generation && edit === this.editGeneration) {
                this.error = error.message; this.ready = false; this.changed();
            }
            return false;
        } finally {
            if (generation === this.generation && edit === this.editGeneration) this.changingCurrency = false;
        }
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
        await this.store.write(this.scope, null);
        this.intent = null;
        this.ready = false;
    }
}
