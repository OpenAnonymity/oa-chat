import { DepositAmount, validateIntent, withInput } from './depositAmount.mjs';

const positiveInteger = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const nonNegativeInteger = value => typeof value === 'string' && /^\d+$/.test(value);
const depositChanged = 'The deposit amount changed in another tab. Reopen this screen to use the saved amount.';
const depositsClosedMessage = 'This version no longer accepts new deposits.';
// A page that is only stale (another tab moved the balance) is told to reload;
// its version still takes deposits.
const staleMessage = 'This page is out of date. Reload to continue.';
const REFUSED_GATE = Object.freeze({ canStart: false, canResume: false, code: null, successor: null });

// The refusal a version that stopped accepting deposits answers with: the SDK's
// own (409 deposits_closed) or the host guard's. Both carry this code. This is
// the same code check as zkapiErrorCopy.isDepositsClosed, kept local so this
// module imports nothing beyond depositAmount.mjs.
const isDepositsClosed = error => error?.code === 'deposits_closed';

function validateFeeQuote(fee, intent, funding, address, now) {
    if (!fee || !positiveInteger(fee.expectedFeeWei) || !positiveInteger(fee.requiredFeeWei) || !positiveInteger(fee.feeReserveWei)
        || !nonNegativeInteger(fee.feeBufferWei)
        || BigInt(fee.expectedFeeWei) > BigInt(fee.requiredFeeWei)
        || BigInt(fee.requiredFeeWei) + BigInt(fee.feeBufferWei) !== BigInt(fee.feeReserveWei)
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
// recover transactions. Explicit Deposit handlers own those separate capabilities.
//
// A version that no longer accepts deposits ends the flow instead of polling it:
// every quote would ask the SDK to prepare a plan, and a prepared plan is saved
// in the browser wallet. `closed` is then set (null otherwise) with the reason
// and the version that takes deposits; `error` carries plain text for views
// that do not read it. A closed flow answers verifyReady with that reason, and
// reopenIfAllowed() starts it again once the gate explicitly allows a deposit.
export class AddressDepositFlow extends DepositAmount {
    // `depositGate` answers whether a deposit may start or resume here. Without
    // versioning there is none and nothing changes.
    constructor({ wallet, client, store, changed = () => {}, now = Date.now, interval = 5_000,
        depositGate = () => client?.oaVersioning?.depositGate?.() ?? null }) {
        super({ client, changed, now });
        Object.assign(this, { wallet, store, interval, depositGate });
        this.closed = null;
        this.intent = null;
        this.status = null;
        this.fee = null;
        this.displayQuote = null;
        this.error = '';
        this.ready = false;
        this.generation = 0;
        this.editGeneration = 0;
        this.checkGeneration = 0;
        this.running = false;
        this.writes = Promise.resolve();
    }

    // The installed gate's refusal when it allows neither a new nor a resumed
    // deposit, else null. Only an explicit allow passes an installed gate: null
    // or undefined (no gate, no versioning) or an object carrying canStart or
    // canResume === true. Anything else (false, 0, '', a malformed object, a
    // throwing gate) is a refusal, and a refusal is always a non-null object.
    gateRefusal() {
        try {
            const gate = this.depositGate?.();
            if (gate === null || gate === undefined) return null;
            if (typeof gate === 'object' && (gate.canStart === true || gate.canResume === true)) return null;
            return typeof gate === 'object'
                ? { canStart: false, canResume: false,
                    code: typeof gate.code === 'string' ? gate.code : null, successor: gate.successor ?? null }
                : { ...REFUSED_GATE };
        } catch { return { ...REFUSED_GATE }; }
    }

    // Ends the flow in its closed state. Cancels the timers and invalidates any
    // read still in flight, so nothing can quote, save or re-enable Deposit.
    close({ gateCode = null, versionId = null, successorId = null, closedSince = null } = {}, message = depositsClosedMessage) {
        this.stop();
        this.closed = { code: 'deposits_closed', gateCode, versionId, successorId, closedSince };
        this.error = message;
        this.fee = null;
        this.displayQuote = null;
        this.changed();
    }

    // True once the gate has closed the flow. The refusal is an object or null
    // (never falsy-but-refused), so only exactly null leaves the flow running.
    closeIfRefused() {
        const gate = this.gateRefusal();
        if (gate === null) return false;
        this.close({ gateCode: gate.code ?? null, successorId: gate.successor?.id ?? null },
            gate.code === 'reload_required' ? staleMessage : depositsClosedMessage);
        return true;
    }

    // Starts a closed flow again, but only when the gate now explicitly allows a
    // deposit to start or resume: `closed` is then cleared (synchronously, before
    // the returned promise settles) and start() runs with the amount this flow
    // last asked for. A gate that is still closed, and a flow that is not
    // closed, change nothing. Resolves to whether the flow was restarted.
    //
    // A gate can close for a reason that passes (another tab's withdrawal
    // settles, a refreshed build): the host calls this when its version state
    // changes instead of tearing the flow down and building a new one.
    async reopenIfAllowed() {
        if (!this.closed || this.running) return false;
        if (this.gateRefusal() !== null) return false;
        const starting = this.start(this.requestedAmount?.value, this.requestedAmount?.currency);
        // start() runs up to its first await synchronously: it has cleared
        // `closed`, or closed the flow again if the gate changed in between.
        const reopened = this.closed === null;
        await starting;
        return reopened;
    }

    // What verifyReady answers with once the flow is closed: the closed reason
    // itself, in the shape of the host's own deposits_closed refusal, so every
    // error surface words it like any other closed deposit.
    closedRefusal() {
        const { gateCode = null, versionId = null, successorId = null, closedSince = null } = this.closed;
        return Object.assign(new Error(this.error || depositsClosedMessage), { code: 'deposits_closed', status: 409,
            data: { gateCode, versionId, successorId, closedSince } });
    }

    async start(suggestedAmount = '10', currency = 'usd', { initialIntent = null, preferInput = false } = {}) {
        if (this.running) return;
        this.closed = null;
        // Before any address, amount or quote work: a closed version needs none.
        if (this.closeIfRefused()) return;
        this.running = true;
        const generation = ++this.generation;
        let edit = this.editGeneration;
        this.initializing = true;
        try {
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
        this.displayQuote = null;
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
        this.displayQuote = null;
        const result = await super.setAmount(...args);
        // A refused USD quote leaves only its message behind. When the gate is
        // what refused it, end the flow rather than retry on the poll cadence.
        if (!result && this.error && this.running) this.closeIfRefused();
        return result;
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
                if (this.closeIfRefused()) return;
                // A failed amount quote (price oracle or RPC outage) is retried
                // on the poll cadence like the fee check, whether it was the
                // first quote or an edit; check() skips a dirty flow, so without
                // this a failed edit stayed on "Updating the ETH amount…" for
                // good. An in-progress edit has no error and is left alone.
                if (this.requestedAmount && (!this.intent || (this.dirty && this.error))) {
                    await this.setAmount(this.requestedAmount.value, this.requestedAmount.currency);
                } else await this.check();
            } finally { if (this.running) this.schedule(); }
        }, this.interval);
    }

    async check({ forceQuote = false, explicit = false } = {}) {
        if (!this.running || !this.intent || this.dirty || this.changingCurrency || (this.verifying && !explicit)) return;
        if (this.closeIfRefused()) return;
        const generation = this.generation;
        const edit = this.editGeneration;
        const intent = this.intent;
        const check = ++this.checkGeneration;
        try {
            const fresh = this.fee && this.fee.expiresAt > this.now();
            if (this.fee && !fresh) {
                // Expiry revokes deposit authorization. Retain the last public
                // transfer estimate for display while its replacement loads.
                this.clearQuoteExpiry();
                this.fee = null;
                this.ready = false;
                this.changed({ expired: true });
            }
            const [statusResult, feeResult] = await Promise.allSettled([
                this.wallet.getStatus(),
                !forceQuote && fresh && this.fee.expiresAt - this.now() > Math.min(10_000, this.interval * 2) ? this.fee : this.wallet.getDepositFeeQuote(intent, {
                    isCurrent: () => this.running && generation === this.generation && edit === this.editGeneration
                        && intent === this.intent && check === this.checkGeneration
                })
            ]);
            if (!this.running || generation !== this.generation || edit !== this.editGeneration
                || intent !== this.intent || check !== this.checkGeneration) return;
            const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
            if (!nonNegativeInteger(status?.ethBalance)) {
                this.status = null;
                throw new Error('The address balance could not be checked.');
            }
            // A quote failure must not hide a successfully checked public
            // balance. Showing funds never grants signing readiness on its own.
            this.status = status;
            this.checkedAt = this.now();
            if (feeResult.status === 'rejected') throw feeResult.reason;
            const fee = validateFeeQuote(feeResult.value, intent, this.client.config.funding, this.address, this.now());
            this.fee = fee;
            this.displayQuote = fee;
            this.scheduleQuoteExpiry(fee);
            this.error = '';
            this.ready = !this.wallet.hasPendingTransaction
                && BigInt(status.ethBalance) >= BigInt(intent.depositWei) + BigInt(fee.requiredFeeWei);
        } catch (error) {
            if (generation !== this.generation || edit !== this.editGeneration || check !== this.checkGeneration) return;
            if (isDepositsClosed(error)) {
                // Final, not transient: no retry, and no further quote attempt
                // that could prepare a plan on a version that refuses deposits.
                this.close({ gateCode: error.data?.gateCode ?? 'deposits_closed', versionId: error.data?.versionId ?? null,
                    successorId: error.data?.successorId ?? null, closedSince: error.data?.closedSince ?? null },
                typeof error.message === 'string' && error.message ? error.message : depositsClosedMessage);
                return;
            }
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

    get requiredWei() {
        return this.intent && this.fee ? (BigInt(this.intent.depositWei) + BigInt(this.fee.requiredFeeWei)).toString() : null;
    }

    get requiredRemainingWei() {
        const required = this.requiredWei;
        if (required == null || !nonNegativeInteger(this.status?.ethBalance)) return null;
        const remaining = BigInt(required) - BigInt(this.status.ethBalance);
        return (remaining > 0n ? remaining : 0n).toString();
    }

    get remainingWei() {
        const total = this.totalWei;
        if (total == null || !nonNegativeInteger(this.status?.ethBalance)) return null;
        const remaining = BigInt(total) - BigInt(this.status.ethBalance);
        return (remaining > 0n ? remaining : 0n).toString();
    }

    async verifyReady() {
        // A closed flow's reason is the answer, not "wait for more ETH".
        if (this.closed) throw this.closedRefusal();
        if (!this.running || !this.intent || !this.ready || !this.fee || this.verifying || this.changingCurrency) throw new Error('Wait until enough ETH has arrived, then choose Deposit.');
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
            const availableFee = BigInt(this.status.ethBalance) - BigInt(intent.depositWei);
            const currentLimit = BigInt(this.fee.feeReserveWei);
            const feeLimit = [displayedLimit, availableFee, currentLimit].reduce((minimum, value) => value < minimum ? value : minimum);
            if (BigInt(this.fee.requiredFeeWei) > feeLimit) {
                throw new Error('Network fees changed. Review the updated amount, then choose Deposit again.');
            }
            return { ...intent, preparedOperationId: this.fee.operationId,
                depositCommitment: this.fee.depositCommitment,
                feeLimitWei: feeLimit.toString(), feeQuoteExpiresAt: this.fee.expiresAt };
        } finally { this.verifying = false; }
    }

    complete() {
        const intent = this.intent;
        const scope = this.scope;
        this.stop();
        this.intent = null;
        this.fee = null;
        this.displayQuote = null;
        // The SDK has already durably confirmed the deposit. Clearing this
        // optional amount preference must neither turn that success into an
        // error nor erase a newer draft another tab has saved in the meantime.
        void this.writes.catch(() => {}).then(async () => {
            if (intent && typeof this.store.compareAndSwap === 'function') {
                await this.store.compareAndSwap(scope, intent, null);
            }
        }).catch(() => { /* A stale amount preference never authorizes another deposit. */ });
    }
}
