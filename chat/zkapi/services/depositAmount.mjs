const positiveInteger = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);

function formatDecimal(units, decimals) {
    const scale = 10n ** BigInt(decimals);
    const fraction = String(units % scale).padStart(decimals, '0').replace(/0+$/, '');
    return `${units / scale}${fraction ? `.${fraction}` : ''}`;
}

export function ethUnits(value) {
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

export function validateIntent(value, scope) {
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

export function withInput(intent) {
    if (intent.inputCurrency) return intent;
    return { ...intent, inputCurrency: intent.usdAmount === null ? 'eth' : 'usd',
        inputAmount: intent.usdAmount ?? intent.ethAmount };
}

// Amount selection has no wallet/provider or storage capability. USD reads use
// the SDK's validated oracle; display toggles retain the exact integer principal.
export class DepositAmount {
    constructor({ client, changed = () => {}, now = Date.now }) {
        Object.assign(this, { client, changed, now });
        this.intent = null;
        this.error = '';
        this.generation = 0;
        this.editGeneration = 0;
        this.running = false;
    }

    async start(value = '10', currency = 'usd', { initialIntent = null } = {}) {
        this.running = true;
        this.generation++;
        const funding = this.client.config?.funding;
        this.scope = `${funding?.chain_id}:${funding?.contract_address?.toLowerCase()}`;
        if (initialIntent) {
            this.intent = withInput(validateIntent({ ...initialIntent, scope: this.scope }, this.scope));
            this.dirty = false;
            this.changed();
        } else await this.setAmount(value, currency);
    }

    stop() { this.running = false; this.generation++; }

    invalidate() {
        this.editGeneration++;
        this.dirty = true;
        this.ready = false;
        this.error = '';
        this.fee = null;
    }

    async commitIntent(_intent, generation, edit) {
        return this.running && generation === this.generation && edit === this.editGeneration;
    }

    async check() { this.changed(); }

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

}
