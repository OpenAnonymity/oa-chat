import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { addressFundingWallet } from '../services/addressFundingProvider.mjs';
import { getWalletMethod } from '../services/walletMethod.mjs';
import { renderFundingWei } from './WalletMethodControls.js';

export function withdrawalFeeScope(owner) {
    return JSON.stringify([getWalletMethod(), addressFundingWallet.address,
        zkapiClient.config?.funding?.chain_id, zkapiClient.config?.funding?.contract_address,
        zkapiClient.note?.note_id, owner.withdrawMode]);
}

export function withdrawalFeeReady(owner) {
    if (getWalletMethod() !== 'address') return true;
    const state = owner.withdrawalFees;
    return state?.scope === withdrawalFeeScope(owner) && !state.loading && !state.error
        && state.quote?.expiresAt > Date.now() && state.quote.shortfallWei === '0';
}

export function stopWithdrawalFees(owner) {
    clearTimeout(owner.withdrawalFeeTimer);
    owner.withdrawalFeeTimer = null;
    owner.withdrawalFees = null;
    owner.withdrawalFeeTopUp = null;
    owner.withdrawalTopUpReveal = null;
    owner.cancelTopUpMotion?.();
}

export function needsWithdrawalFees(owner) {
    const prepared = zkapiClient.config?.prepared_withdrawal;
    return owner.isOpen && ['balance', 'withdraw'].includes(owner.view) && getWalletMethod() === 'address'
        && zkapiClient.note && !zkapiClient.activeLateWithdrawal
        && zkapiClient.withdrawal?.phase !== 'pending'
        && !prepared?.transaction_hash
        && !['submitted', 'dropped_or_pending', 'awaiting_wallet', 'ambiguous'].includes(prepared?.phase);
}

export async function refreshWithdrawalFees(owner, { force = false } = {}) {
    if (!needsWithdrawalFees(owner) || owner.busy) return false;
    const scope = withdrawalFeeScope(owner);
    const previous = owner.withdrawalFees;
    if (previous?.scope === scope && previous.loading) return false;
    if (!force && previous?.scope === scope && (previous.error || previous.quote?.expiresAt > Date.now())) return withdrawalFeeReady(owner);
    clearTimeout(owner.withdrawalFeeTimer);
    const state = { scope, loading: true, quote: previous?.scope === scope ? previous.quote : null };
    owner.withdrawalFees = state;
    queueMicrotask(() => { if (owner.withdrawalFees === state && needsWithdrawalFees(owner)) owner.render(); });
    try {
        const quote = await addressFundingWallet.getWithdrawalFeeBudget(owner.withdrawMode);
        if (owner.withdrawalFees !== state || scope !== withdrawalFeeScope(owner) || !needsWithdrawalFees(owner)) return false;
        state.quote = quote;
        // A successful read resolves only a fee-read warning, never another
        // transaction error or an increased-fee approval requirement.
        if (owner.outcome?.withdrawalFeeIssue === 'address_fee_data') owner.clearTransientOutcome();
    } catch {
        state.error = 'Couldn’t check fees. Try again.';
    } finally {
        state.loading = false;
        if (owner.withdrawalFees === state && scope === withdrawalFeeScope(owner) && needsWithdrawalFees(owner)) {
            owner.render();
            owner.withdrawalFeeTimer = setTimeout(() => { void refreshWithdrawalFees(owner, { force: true }); }, 15_000);
            owner.withdrawalFeeTimer?.unref?.();
        }
    }
    return withdrawalFeeReady(owner);
}

// Round the receipt as a whole so its visible subtraction stays true. For a
// shortfall this recommends at most two extra micro-ETH, never too little.
// At the funded boundary use more precision rather than show a false shortfall.
export function withdrawalFeeReceiptAmounts(quote) {
    const reserve = BigInt(quote.feeReserveWei);
    const balance = BigInt(quote.balanceWei);
    let unit = 1_000_000_000_000n;
    let needed, available;
    do {
        needed = (reserve + unit - 1n) / unit * unit;
        available = balance / unit * unit;
        if (balance < reserve || available >= needed || unit === 1n) break;
        unit /= 10n;
    } while (true);
    return { needed: String(needed), available: String(available),
        shortfall: String(needed > available ? needed - available : 0n) };
}

export function renderWithdrawalFees(owner) {
    if (getWalletMethod() !== 'address') return '';
    const state = owner.withdrawalFees?.scope === withdrawalFeeScope(owner) ? owner.withdrawalFees : null;
    const quote = state?.quote;
    const receipt = quote ? withdrawalFeeReceiptAmounts(quote) : null;
    const escape = value => owner.escapeHtml(value);
    const amount = value => renderFundingWei(owner, value);
    const short = quote && BigInt(quote.shortfallWei) > 0n;
    const loading = !quote && !state?.error;
    const checking = Boolean(state?.loading || loading);
    const ready = withdrawalFeeReady(owner);
    const placeholder = '<span class="zkapi-fee-placeholder" aria-label="Loading">—</span>';
    const status = state?.error ? escape(state.error) : checking ? 'Checking available ETH…'
        : ready ? 'You have enough ETH for fees.' : !short ? 'Updating the fee estimate…' : '';
    const expanded = quote && owner.withdrawalFeeTopUp === state.scope;
    const topUpAmount = receipt ? amount(receipt.shortfall).split(' <span>')[0] : '';
    return `<section class="zkapi-withdrawal-fees" aria-label="Withdrawal network fee" aria-busy="${checking}">
        <p class="zkapi-fee-heading">ETH for network fees</p>
        <dl class="zkapi-funding-breakdown">
            <div><dt>${owner.withdrawMode === 'escape' ? 'Needed for both steps' : 'Needed to start'}</dt><dd>${receipt ? amount(receipt.needed) : placeholder}</dd></div>
            <div><dt>Already available</dt><dd>${receipt ? `<span class="zkapi-fee-minus" aria-label="minus">−</span> ${amount(receipt.available)}` : placeholder}</dd></div>
            <div class="zkapi-fee-total"><dt>${short ? 'You need to add' : 'Still needed'}</dt><dd>${receipt ? amount(receipt.shortfall) : placeholder}</dd></div>
        </dl>
        <div class="zkapi-fee-result" ${expanded ? 'hidden' : ''}><p role="status" ${ready ? 'class="zkapi-fee-covered"' : ''}>${status}</p>
            <div class="zkapi-fee-action" ${expanded ? 'hidden' : ''}>${expanded ? '' : state?.error ? '<button data-withdrawal-fee-refresh class="zkapi-secondary-button w-full" type="button">Try again</button>'
                : short ? `<button data-withdrawal-fee-topup class="zkapi-primary-button w-full" type="button" aria-expanded="${expanded}" ${checking ? 'disabled' : ''}>Add ${topUpAmount}</button>`
                : '<button class="zkapi-secondary-button w-full" type="button" disabled style="visibility:hidden" aria-hidden="true" tabindex="-1">Add ETH</button>'}</div>
        </div>
        ${expanded ? `<div class="zkapi-fee-topup t-panel-slide" data-open="true">
            <div class="zkapi-fee-send"><p class="zkapi-balance-caption">${short ? 'Send for network fees' : 'Available for network fees'}</p>
                <p class="zkapi-fee-send-amount">${amount(short ? receipt.shortfall : receipt.available)}</p>
                <p class="zkapi-helper">${escape(zkapiClient.networkName())}</p></div>
            <div><p class="zkapi-fee-address-label">${short ? 'To this address' : 'Funding address'}</p>
                <div class="zkapi-funding-address zkapi-fee-address">
                    <div class="zkapi-funding-address-value" role="textbox" aria-readonly="true" tabindex="0" aria-label="Fee-paying address">${escape(quote.address.slice(0, 22))}<wbr>${escape(quote.address.slice(22))}</div>
                    <button data-withdrawal-fee-copy class="zkapi-secondary-button zkapi-copy-button" type="button" aria-label="Copy funding address" data-copied="false">
                        <svg class="zkapi-copy-face" data-face="copy" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.75"/><path d="M10.5 3.5v-.25A1.75 1.75 0 0 0 8.75 1.5h-5.5A1.75 1.75 0 0 0 1.5 3.25v5.5c0 .97.78 1.75 1.75 1.75h.25"/></svg>
                        <svg class="zkapi-copy-face" data-face="copied" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-6"/></svg>
                    </button>
                </div>
                <p class="zkapi-fee-copy-feedback" data-withdrawal-fee-copy-status role="status"></p>
            </div>
            <div class="zkapi-fee-transfer-status"><p role="status">${status || 'Waiting for your transfer'}</p>
                <button data-withdrawal-fee-refresh class="zkapi-quiet-button" type="button" ${checking || owner.busy ? 'disabled' : ''}>${checking ? 'Checking…' : 'Check now'}</button>
            </div></div>` : ''}
    </section>`;
}

export function attachWithdrawalFees(owner) {
    owner.overlay.querySelector('[data-withdrawal-fee-topup]')?.addEventListener('click', () => {
        const scope = withdrawalFeeScope(owner);
        owner.withdrawalFeeTopUp = scope;
        owner.withdrawalTopUpReveal = { scope };
        owner.render();
    });
    owner.overlay.querySelector('[data-withdrawal-fee-refresh]')?.addEventListener('click', () => {
        void refreshWithdrawalFees(owner, { force: true });
        owner.render();
    });
    owner.overlay.querySelector('[data-withdrawal-fee-copy]')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        const feedback = owner.overlay.querySelector('[data-withdrawal-fee-copy-status]');
        const address = owner.withdrawalFees?.quote?.address;
        if (!address) return;
        try {
            await navigator.clipboard.writeText(address);
            button.dataset.copied = 'true';
            button.setAttribute('aria-label', 'Address copied');
            if (feedback) feedback.textContent = 'Address copied';
        } catch {
            if (feedback) feedback.textContent = 'Select the address above to copy it.';
        }
    });
}
