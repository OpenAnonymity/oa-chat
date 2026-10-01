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

export function renderWithdrawalFees(owner) {
    if (getWalletMethod() !== 'address') return '';
    const state = owner.withdrawalFees?.scope === withdrawalFeeScope(owner) ? owner.withdrawalFees : null;
    const quote = state?.quote;
    const escape = value => owner.escapeHtml(value);
    const amount = (value, up = true) => {
        const wei = BigInt(value);
        const unit = 1_000_000_000_000n;
        return renderFundingWei(owner, ((wei + (up ? unit - 1n : 0n)) / unit * unit).toString());
    };
    const short = quote && BigInt(quote.shortfallWei) > 0n;
    const loading = !quote && !state?.error;
    const placeholder = '<span class="zkapi-fee-placeholder" aria-label="Loading">—</span>';
    const status = state?.error ? escape(state.error) : state?.loading || loading ? 'Checking available ETH…'
        : short ? `You need ${amount(quote.shortfallWei).split(' <span>')[0]} more.` : 'You have enough ETH for the fee.';
    const expanded = short && owner.withdrawalFeeTopUp === state.scope;
    return `<section class="zkapi-withdrawal-fees" aria-label="Withdrawal network fee" aria-busy="${Boolean(state?.loading || loading)}">
        <p class="zkapi-balance-caption">ETH needed for fees</p>
        <dl class="zkapi-funding-breakdown">
            <div><dt>${owner.withdrawMode === 'escape' ? 'Needed for both steps' : 'Needed to start'}</dt><dd>${quote ? amount(quote.feeReserveWei) : placeholder}</dd></div>
            <div><dt>Available for fees</dt><dd>${quote ? amount(quote.balanceWei, false) : placeholder}</dd></div>
        </dl>
        <p class="zkapi-fee-explanation">Paid separately from your private balance. This is a fee allowance; unused ETH stays in your browser’s address.</p>
        <div class="zkapi-fee-result"><p role="status">${status}</p>
            <div class="zkapi-fee-action">${state?.error ? '<button data-withdrawal-fee-refresh class="zkapi-secondary-button" type="button">Try again</button>'
                : short ? `<button data-withdrawal-fee-topup class="zkapi-secondary-button" type="button" aria-expanded="${expanded}">${expanded ? 'Hide address' : 'Add ETH'}</button>`
                : '<button class="zkapi-secondary-button" type="button" disabled style="visibility:hidden" aria-hidden="true" tabindex="-1">Add ETH</button>'}</div>
        </div>
        ${expanded ? `<div class="zkapi-fee-topup"><p class="zkapi-note">Send ${amount(quote.shortfallWei)} on ${escape(zkapiClient.networkName())} to this address, then check again:</p>
            <div class="zkapi-funding-address"><div class="zkapi-funding-address-value" role="textbox" aria-readonly="true" tabindex="0" aria-label="Fee-paying address">${escape(quote.address)}</div>
            <button data-withdrawal-fee-copy class="zkapi-secondary-button" type="button">Copy</button></div>
            <button data-withdrawal-fee-refresh class="zkapi-quiet-button" type="button" ${state?.loading ? 'disabled' : ''}>Check for ETH</button></div>` : ''}
    </section>`;
}

export function attachWithdrawalFees(owner) {
    owner.overlay.querySelector('[data-withdrawal-fee-topup]')?.addEventListener('click', () => {
        const scope = withdrawalFeeScope(owner);
        owner.withdrawalFeeTopUp = owner.withdrawalFeeTopUp === scope ? null : scope;
        owner.render();
    });
    owner.overlay.querySelector('[data-withdrawal-fee-refresh]')?.addEventListener('click', () => {
        void refreshWithdrawalFees(owner, { force: true });
        owner.render();
    });
    owner.overlay.querySelector('[data-withdrawal-fee-copy]')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        try {
            await navigator.clipboard.writeText(owner.withdrawalFees.quote.address);
            button.textContent = 'Copied';
        } catch { button.textContent = 'Select address to copy'; }
    });
}
