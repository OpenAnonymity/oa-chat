// Paying the network fee of a withdrawal out of the withdrawal itself.
//
// This module is what the dialog reaches through `zkapiClient.oaVersioning.
// sponsored`: whether the loaded version offers it, the app's own route to
// the relay service, a quote of the fee before anything is started, and the
// options a withdrawal is started with when the person chose it.
//
// Words. The SDK calls the relay a bundler and the contract that pays the fee
// a paymaster; the person is told about "a relay service" and "a network fee
// paid from this withdrawal". The protocol words stay in the guide.
//
// Privacy. The relay is reached only through the app's own route
// (versioning/sponsored.mjs), never directly, and it is contacted only when
// the person asks for the fee: choosing this way of paying is the click, and a
// withdrawal form that is merely opened sends nothing to it.
//
// SDK-free by rule (the facade is built before any SDK build is chosen): the
// client and runtime are handed in, and every call on them is guarded.
import { bundlerRouteUrl, profilePinsSponsored } from './sponsored.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const WEI_PER_UNIT = 1_000_000_000n; // the ledger counts gwei
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[0-9]{1,78}$/;

/**
 * Why a sponsored withdrawal is not offered, in the product's words. Every
 * refusal code of the SDK's pre-flight has a line; none names a protocol
 * object, and each ends where the person can go on: paying from the wallet.
 */
export const SPONSORED_REASON_COPY = Object.freeze({
    gasless_cost_above_cap: 'Network fees changed above the amount you approved. Check the fee again before continuing.',
    gasless_unavailable: 'Paying the network fee from this withdrawal isn’t available for this balance.',
    not_pinned: 'Paying the network fee from this withdrawal isn’t offered for this balance.',
    gasless_profile_invalid: 'Paying the network fee from this withdrawal isn’t available right now.',
    gasless_deployment_mismatch: 'Paying the network fee from this withdrawal isn’t available right now.',
    gasless_policy_mismatch: 'The fee for this withdrawal changed while it was being checked. Check it again.',
    bundler_unavailable: 'The relay service couldn’t be reached.',
    bundler_wrong_chain: 'The relay service isn’t on the right network.',
    bundler_unsupported_entry_point: 'The relay service can’t take this withdrawal.',
    bundler_url_invalid: 'The relay service isn’t set up correctly.',
    sponsorship_paused: 'The service has paused paying network fees from withdrawals for now.',
    escapes_disabled: 'The service doesn’t pay the network fee of an emergency exit.',
    escape_already_sponsored: 'The network fee of an emergency exit of this balance was already paid this way once.',
    paymaster_underfunded: 'The service can’t cover network fees right now.',
    exits_paused: 'Withdrawals are paused for now.',
    gas_above_paymaster_ceiling: 'Network fees are too high right now to pay from this withdrawal.',
    max_cost_above_policy: 'Network fees are too high right now to pay from this withdrawal.',
    payout_below_gas: 'This balance is smaller than the network fee.',
    gasless_uneconomic: 'The network fee would be more than a quarter of this withdrawal.',
    gasless_attempts_exhausted: 'This balance has used the attempts the service allows for paying the fee this way.',
    gasless_fee_above_cap: 'The service’s fee is higher than the fee that was shown.',
    gasless_estimate_above_cap: 'Network fees are too high right now to pay from this withdrawal.',
    gas_limit_out_of_range: 'Paying the network fee from this withdrawal isn’t available right now.',
    gasless_plan_mismatch: 'This withdrawal was already started another way and has to finish that way.',
    gasless_record_not_pinned: 'The service no longer pays network fees this way for this withdrawal.',
    wrong_owner_account: 'This withdrawal belongs to a different account. Connect the account that started it.',
    entry_point_hash_mismatch: 'Paying the network fee from this withdrawal isn’t available right now.',
    // What can go wrong after a sponsored withdrawal has started: the SDK's
    // errors of the run itself, in the same words.
    gasless_op_expired: 'This withdrawal took too long to send and has to be prepared again. Nothing was lost. Try again.',
    gasless_op_pending: 'This withdrawal was sent and is still being confirmed. Check it again in a moment.',
    user_op_pending: 'A withdrawal sent earlier may still be confirming. Check it again in a moment.',
    withdrawal_wallet_pending: 'This withdrawal is already being followed in this or another tab. Wait for it to finish.',
    escape_not_due: 'The safety wait of this exit isn’t over yet. Try again after it ends.',
    gasless_fee_bump_exhausted: 'Network fees rose faster than this withdrawal could follow. Try again later.',
    gasless_op_reverted: 'The network refused this withdrawal when it was sent. Check Payment history before trying again.',
    signature_rejected: 'The signature wasn’t accepted. Try again.',
    bundler_hash_mismatch: 'The relay service answered with something unexpected. Check the withdrawal in Payment history.',
    bundler_rejected: 'The relay service refused this withdrawal.',
    paymaster_time_window: 'This withdrawal is not ready to be sent yet. Try again in a moment.',
    transit_funds_waiting: 'The payout is waiting to be collected. Collect it from Payment history.',
    transit_sweep_needed: 'The payout has to be collected from Payment history.',
    transit_not_stranded: 'There is nothing to collect for the service to pay for here. Collect it with your wallet instead.',
    transit_balance_empty: 'There is nothing waiting to be collected.',
    unknown: 'Paying the network fee from this withdrawal isn’t available right now.'
});

// The hint a refusal ends with. Send to address has no wallet to fall back on
// (its fee is paid from the withdrawal only), so its fee line drops this hint
// and points at the Ethereum wallet method instead (components/SponsoredFee.js).
export const SPONSORED_WALLET_HINT = ' You can pay the network fee from your wallet instead.';
const KEEP_WALLET = SPONSORED_WALLET_HINT;
// Refusals that are about a withdrawal already started, or that a wallet
// cannot cure: the hint would be wrong.
const NO_WALLET_HINT = new Set(['gasless_plan_mismatch', 'gasless_record_not_pinned', 'wrong_owner_account',
    'gasless_cost_above_cap',
    'gasless_policy_mismatch', 'exits_paused', 'gasless_op_expired', 'gasless_op_pending', 'user_op_pending',
    'withdrawal_wallet_pending', 'escape_not_due', 'gasless_fee_bump_exhausted', 'gasless_op_reverted', 'signature_rejected',
    'bundler_hash_mismatch', 'paymaster_time_window', 'transit_funds_waiting', 'transit_sweep_needed',
    'transit_not_stranded', 'transit_balance_empty']);

/** Whether paying with a wallet could get past this refusal (it is not about
 *  a withdrawal already started or a cause a wallet cannot cure). */
export function walletCanCureRefusal(reason) {
    const key = typeof reason === 'string' && Object.hasOwn(SPONSORED_REASON_COPY, reason) ? reason : 'unknown';
    return !NO_WALLET_HINT.has(key);
}

/** The line for a refusal reason of the SDK (always one; unknown codes read as unavailable). */
export function sponsoredReasonText(reason) {
    const key = typeof reason === 'string' && Object.hasOwn(SPONSORED_REASON_COPY, reason) ? reason : 'unknown';
    const text = SPONSORED_REASON_COPY[key];
    return NO_WALLET_HINT.has(key) ? text : `${text}${KEEP_WALLET}`;
}

function weiString(value) {
    if (typeof value === 'bigint' && value >= 0n) return value.toString();
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    if (typeof value === 'string' && DECIMAL.test(value)) return BigInt(value).toString();
    return null;
}

/** An amount in wei as an ETH figure with at most six decimals, trailing zeros trimmed. */
export function weiToEthText(wei) {
    const text = weiString(wei);
    if (text === null) return '';
    const value = BigInt(text);
    const whole = value / 10n ** 18n;
    const fraction = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
    // Nothing but dust shows as "less than": a fee is never rounded to none.
    if (whole === 0n && fraction === '' && value > 0n) return '< 0.000001';
    return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** Wei as whole ledger units (gwei), rounded the way an amount is shown: down. */
export function weiToUnits(wei) {
    const text = weiString(wei);
    return text === null ? null : (BigInt(text) / WEI_PER_UNIT).toString();
}

/**
 * The quote of a sponsored withdrawal in the host's own shape. An unavailable
 * quote carries its code and the words for it; an available one carries the
 * amounts as decimal wei strings. Nothing of the SDK's object is passed on.
 */
export function normalizeQuote(raw, { mode } = {}) {
    if (!isRecord(raw)) return { available: false, reason: 'unknown', text: sponsoredReasonText('unknown') };
    if (raw.available !== true) {
        const reason = typeof raw.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(raw.reason) ? raw.reason : 'unknown';
        // The SDK's `gasless_unavailable` carries the cause in `data.reason`.
        const cause = isRecord(raw.data) && typeof raw.data.reason === 'string' && Object.hasOwn(SPONSORED_REASON_COPY, raw.data.reason)
            ? raw.data.reason : null;
        return { available: false, reason: cause || reason, text: sponsoredReasonText(cause || reason) };
    }
    const maxCostWei = weiString(raw.maxCost);
    const flatFeeWei = weiString(raw.flatFeeWei);
    if (maxCostWei === null || flatFeeWei === null) {
        return { available: false, reason: 'unknown', text: sponsoredReasonText('unknown') };
    }
    return {
        available: true,
        mode: mode === 'escape' ? 'escape' : 'mutual',
        payoutWei: weiString(raw.payoutWei),
        // The SDK quote supplies a close floor at its quoted fees. The host
        // displays this as an estimate because fees may change before signing.
        // An escape is charged when finished, possibly days later.
        minimumReceivedWei: weiString(raw.minimumReceivedWei),
        estimatedReceivedWei: weiString(raw.estimatedReceivedWei),
        maxCostWei,
        flatFeeWei,
        creditSurchargeWei: weiString(raw.creditSurchargeWei) || '0',
        owedWei: weiString(raw.owedWei),
        payoutHasCode: raw.payoutHasCode === true,
        transitExists: raw.transitExists === true
    };
}

// Install `provider` as the client's wallet for one read and start it in the
// same synchronous turn: the SDK captures the provider when an async method
// starts, so nothing may be awaited between the two (the host's
// withWalletProviderRead, which this SDK-free module cannot import). A client
// that is busy with another wallet action is waited for, up to thirty seconds.
async function withProvider(client, provider, read) {
    const deadline = Date.now() + 30_000;
    for (;;) {
        try {
            client.setWalletProvider(provider);
        } catch (error) {
            if (error?.code !== 'wallet_provider_busy') throw error;
            if (Date.now() >= deadline) throw new Error('The previous wallet check is still running. Try again shortly.');
            await new Promise(resolve => setTimeout(resolve, 50));
            continue;
        }
        return read();
    }
}

/**
 * What the dialog needs: `supported()`, `bundlerUrl()`, `quote(...)` and
 * `plan(...)`. `deps` supplies the attached client and runtime (getters, so a
 * facade attached late still works) and the loaded version's context.
 */
export function createSponsoredFees({ getClient, getRuntime, getContext, getOrigin = () => globalThis.location?.origin ?? null } = {}) {
    const guarded = (read, fallback = null) => { try { return read(); } catch { return fallback; } };

    function trusted() {
        return guarded(() => getRuntime?.()?.browserConfig?.trusted_deployment, null);
    }

    // The app's route to the relay for the loaded version, or null.
    function bundlerUrl() {
        const context = guarded(() => getContext?.(), null);
        const proxyPath = context?.version?.proxyPath;
        return bundlerRouteUrl(guarded(() => getOrigin?.(), null), proxyPath);
    }

    function supported() {
        try {
            const context = getContext?.();
            if (!context?.adapter?.callProfile?.sponsored) return false;
            const client = getClient?.();
            if (!client || typeof client.gaslessWithdrawalQuote !== 'function') return false;
            return profilePinsSponsored(trusted()) && bundlerUrl() !== null;
        } catch {
            return false;
        }
    }

    return Object.freeze({
        supported,
        bundlerUrl: () => (supported() ? bundlerUrl() : null),

        /**
         * Quote a sponsored withdrawal of the selected balance: reads the
         * deployment and asks the relay whether it would take it. Never
         * proves, prompts or sends. Resolves with a normalized quote and never
         * rejects. `provider` is the wallet the SDK must use for the read
         * (the Send Ethereum signer), activated for it and nothing else.
         */
        async quote({ mode = 'mutual', destination = null, owner = null, provider = null } = {}) {
            if (!supported()) return { available: false, reason: 'not_pinned', text: sponsoredReasonText('not_pinned') };
            const client = getClient();
            const account = typeof owner === 'string' && ADDRESS.test(owner) ? owner
                : typeof destination === 'string' && ADDRESS.test(destination) ? destination : null;
            try {
                const read = () => client.gaslessWithdrawalQuote(mode === 'escape' ? 'escape' : 'mutual', {
                    destination: typeof destination === 'string' && ADDRESS.test(destination) ? destination : null,
                    owner: account,
                    bundlerUrl: bundlerUrl()
                });
                // The Send Ethereum method quotes with its own provider: the
                // relay is then reached through it, never directly.
                const raw = provider ? await withProvider(client, provider, read) : await read();
                return normalizeQuote(raw, { mode });
            } catch (error) {
                const code = typeof error?.code === 'string' ? error.code : 'unknown';
                return { available: false, reason: code, text: sponsoredReasonText(code) };
            }
        },

        /**
         * The displayed quote is an estimate. Use the deployment's existing
         * policy limits so a fresh fee read or relay gas adjustment does not
         * invalidate it. Explicit values also replace an older saved quote
         * cap when this same withdrawal is continued.
         */
        plan(quote) {
            if (!isRecord(quote) || quote.available !== true || !supported()) return null;
            const pins = trusted().gasless;
            const feeCapWei = quote.flatFeeWei ?? String(pins.policy.flat_fee_wei);
            const maxCostWei = String(pins.policy.max_sponsored_cost_wei);
            const creditReserve = BigInt(pins.gas_policy.credit_gas ?? 0) * BigInt(pins.fee_ceilings.max_fee_wei);
            return {
                options: { fees: 'payout', bundlerUrl: bundlerUrl(), feeCapWei,
                    maxCostWei,
                    maxTotalFeeWei: String(BigInt(maxCostWei) + BigInt(feeCapWei) + creditReserve),
                    allowExpensiveGas: false },
                sponsored: {
                    feeCapWei,
                    maxCostWei
                }
            };
        }
    });
}
