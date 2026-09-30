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
}

export function needsWithdrawalFees(owner) {
    const prepared = zkapiClient.config?.prepared_withdrawal;
    return owner.isOpen && owner.view === 'withdraw' && getWalletMethod() === 'address'
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
    } catch {
        state.error = 'Couldn’t check the fee or available ETH. Check your connection and try again.';
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
    const heading = '<p class="zkapi-balance-caption">ETH for the network fee</p>';
    const explanation = '<p class="zkapi-note">Paid by your Send ETH address, separately from your private balance.</p>';
    if (!quote) return `<section class="zkapi-withdrawal-fees" aria-label="Withdrawal network fee">${heading}${explanation}
        <p class="zkapi-helper" role="status">${state?.error || 'Checking the fee reserve and available ETH…'}</p>
        ${state?.error ? '<button data-withdrawal-fee-refresh class="zkapi-secondary-button" type="button">Check again</button>' : ''}</section>`;
    const short = BigInt(quote.shortfallWei) > 0n;
    return `<section class="zkapi-withdrawal-fees" aria-label="Withdrawal network fee">${heading}${explanation}
        <dl class="zkapi-funding-breakdown"><div><dt>${quote.mode === 'escape' ? 'Reserve for both transactions' : 'Fee reserve to start'}</dt><dd>${amount(quote.feeReserveWei)}</dd></div>
        <div><dt>Already available</dt><dd>${amount(quote.balanceWei, false)}</dd></div></dl>
        <details class="zkapi-note"><summary>About this reserve</summary><p>A conservative reserve, not a charge. The exact fee is calculated after preparation; unused ETH stays at this address.${quote.mode === 'escape' ? ' Finalizing later needs a second transaction. Fees may change during the wait.' : ''}</p></details>
        <p class="zkapi-helper" role="status">${state.error ? escape(state.error) : state.loading ? 'Updating fee and balance…' : short ? `Add ${amount(quote.shortfallWei)} to continue.` : 'Enough ETH available to start.'}</p>
        ${short ? `<p class="zkapi-note">Send the additional ETH on ${escape(zkapiClient.networkName())} to this fee-paying address:</p>
        <div class="zkapi-funding-address"><div class="zkapi-funding-address-value" role="textbox" aria-readonly="true" tabindex="0" aria-label="Fee-paying address">${escape(quote.address)}</div>
        <button data-withdrawal-fee-copy class="zkapi-secondary-button" type="button">Copy</button></div>` : ''}
        <button data-withdrawal-fee-refresh class="zkapi-quiet-button" type="button" ${state.loading || owner.busy ? 'disabled' : ''}>${short ? 'Check for ETH' : 'Refresh fee'}</button>
    </section>`;
}

export function attachWithdrawalFees(owner) {
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
