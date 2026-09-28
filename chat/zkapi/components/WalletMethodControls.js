import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { chatDB } from '../../db.js';
import { addressFundingWallet } from '../services/addressFundingProvider.mjs';
import { AddressDepositFlow } from '../services/addressDepositFlow.mjs';
import { getWalletMethod, setWalletMethod } from '../services/walletMethod.mjs';
import { canQuotePendingAddressDeposit, formatFundingAmount, fundingAmount, fundingEthAmount, fundingDestination } from '../services/addressFunding.js';

export function refreshWalletView(owner) {
    if (owner.isOpen && !owner.fundingBusy && globalThis.document?.activeElement?.type !== 'password') owner.render();
}

export function stopFundingFlow(owner) {
    clearTimeout(owner.fundingEditTimer);
    owner.fundingFlow?.stop();
    owner.fundingFlow = null;
    stopFundingStatus(owner);
    owner.fundingStatus = null;
}

function stopFundingStatus(owner) {
    clearTimeout(owner.fundingStatusPoll?.timer);
    owner.fundingStatusPoll = null;
}

function ensureFundingStatus(owner) {
    const eligible = () => getWalletMethod() === 'address' && owner.isOpen
        && !canFund(owner);
    if (!eligible()) { stopFundingStatus(owner); return; }
    if (owner.fundingStatusPoll) return;
    if (!addressFundingWallet.address || !addressFundingWallet.unlocked) return;
    const poll = { timer: null };
    owner.fundingStatusPoll = poll;
    owner.fundingStatus = null;
    const current = () => owner.fundingStatusPoll === poll && eligible();
    const check = async () => {
        if (!current()) return;
        try {
            const status = await addressFundingWallet.getStatus();
            if (!current()) return;
            owner.fundingStatus = status;
            owner.fundingStatusError = '';
        } catch {
            if (!current()) return;
            owner.fundingStatus = null;
            owner.fundingStatusError = 'Unable to check this address right now. Retrying…';
        }
        if (!current()) return;
        if (!owner.busy && !owner.fundingBusy) owner.render();
        if (current()) poll.timer = setTimeout(check, 5000);
    };
    void check();
}

function canFund(owner) {
    const pending = zkapiClient.config?.pending_deposit;
    // Welcome hands all saved work to the balance dialog. Only the SDK can
    // declare a saved deposit definitely unsubmitted and safe to quote again.
    const quotableSaved = !owner.resumeSavedDeposit && canQuotePendingAddressDeposit();
    return getWalletMethod() === 'address' && owner.isOpen && !zkapiClient.note
        && (!pending || quotableSaved) && !['withdraw', 'withdrawals'].includes(owner.view)
        && owner.step !== 'success' && owner.walletMethodReady !== false;
}

function ensureFundingFlow(owner) {
    if (!canFund(owner)) {
        clearTimeout(owner.fundingEditTimer);
        owner.fundingFlow?.stop();
        owner.fundingFlow = null;
        ensureFundingStatus(owner);
        return;
    }
    stopFundingStatus(owner);
    if (owner.fundingFlow) return;
    const flow = new AddressDepositFlow({
        wallet: addressFundingWallet, client: zkapiClient,
        store: {
            read: scope => chatDB.getSetting(`oa-eth-deposit:${scope}`),
            write: (scope, value) => chatDB.updateSettings([{ key: `oa-eth-deposit:${scope}`, value }])
        },
        changed: () => {
            if (owner.fundingFlow !== flow || !owner.isOpen) return;
            owner.fundingStatus = flow.status;
            if (owner.fundingUsdAmount == null && flow.intent) owner.fundingUsdAmount = flow.intent.usdAmount;
            if (!owner.busy && !owner.fundingBusy) owner.render();
        }
    });
    owner.fundingFlow = flow;
    void flow.start(owner.fundingUsdAmount || '10');
}

export function renderWalletMethod(owner) {
    const local = getWalletMethod() === 'address';
    const locked = owner.busy || owner.fundingBusy || owner.walletMethodReady === false || addressFundingWallet.hasPendingTransaction;
    return `<section class="zkapi-wallet-method" aria-label="Wallet method">
        <div class="zkapi-wallet-method-options" role="group" aria-label="How to transact">
            <button type="button" data-wallet-method="metamask" aria-pressed="${!local}" ${locked ? 'disabled' : ''}>MetaMask</button>
            <button type="button" data-wallet-method="address" aria-pressed="${local}" ${locked ? 'disabled' : ''}>Send to an address</button>
        </div>
        ${owner.fundingError ? `<p class="zkapi-funding-error" role="alert">${owner.escapeHtml(owner.fundingError)}</p>` : ''}
    </section>`;
}

export function renderFundingWei(owner, value) {
    let usd = '';
    // ETH stays exact. USD is only a current reference value; native accounting
    // uses whole gwei, so discard sub-gwei dust for this approximate display.
    if (zkapiClient.isNativeEthFunding && /^\d+$/.test(String(value))) {
        try {
            const formatted = zkapiClient.formatMoney((BigInt(value) / 1_000_000_000n).toString());
            if (formatted && formatted !== '—') usd = ` <span>(≈ ${owner.escapeHtml(formatted)})</span>`;
        } catch { /* A price outage must not hide the exact ETH amount. */ }
    }
    return `${owner.escapeHtml(formatFundingAmount(value, 18))} ETH${usd}`;
}

function fundingQuoteFresh(fee) {
    return Number.isFinite(fee?.quotedAt) && Number.isFinite(fee?.expiresAt)
        && fee.quotedAt <= Date.now() && fee.expiresAt > Date.now();
}

function renderFundingReceipt(owner) {
    const noteId = zkapiClient.note?.note_id;
    const record = noteId == null ? null : zkapiClient.deposits?.find(entry => entry.status === 'confirmed'
        && entry.noteId === Number(noteId)
        && entry.fundingAddress?.toLowerCase() === addressFundingWallet.address?.toLowerCase());
    const hasFee = record && /^\d+$/.test(String(record.feeWei));
    // A newly confirmed note can render before its prefunding controller has
    // stopped. Never call that pre-transaction balance the remaining balance.
    const balance = owner.fundingFlow ? null : owner.fundingStatus?.ethBalance;
    return `${hasFee ? `<dl class="zkapi-funding-breakdown" aria-label="Confirmed deposit costs"><div><dt>Actual deposit network fee</dt><dd>${renderFundingWei(owner, record.feeWei)}</dd></div></dl>` : ''}
        <p class="zkapi-helper">Currently at this address: ${renderFundingWei(owner, balance)}</p>
        ${hasFee ? '<p class="zkapi-note">Any unused fee buffer remains here, separate from your private balance. This address may also hold ETH from other transfers. You can keep it for future fees or return it below; returning ETH also costs a network fee.</p>' : ''}`;
}

export function renderFundingAccount(owner) {
    if (getWalletMethod() !== 'address') return '';
    const escape = value => owner.escapeHtml(value);
    const wallet = addressFundingWallet;
    const disabled = owner.busy || owner.fundingBusy ? 'disabled' : '';
    const network = zkapiClient.networkName();
    const native = zkapiClient.isNativeEthFunding;
    const token = zkapiClient.billingTokenSymbol || 'USDC';
    const flow = owner.fundingFlow;
    // Existing encrypted accounts are never overwritten. This one-time upgrade
    // is shown only for a legacy record; new accounts have no password or backup.
    if (wallet.migrationRequired) return `<section class="zkapi-funding-account">
        <p class="zkapi-helper">This browser has an existing encrypted funding address. Unlock it once to keep the same address in browser storage.</p>
        <label class="zkapi-funding-field">Existing password<input data-funding-legacy-password type="password" autocomplete="current-password" ${disabled} /></label>
        <button data-funding-migrate class="zkapi-primary-button" type="button" ${disabled}>Use this address</button>
    </section>`;
    if (!wallet.address) return `<section class="zkapi-funding-account"><p class="zkapi-helper" role="status">${escape(flow?.error || (native ? 'Preparing your address…' : 'ETH funding is not available on this deployment yet.'))}</p></section>`;
    const intent = flow?.intent;
    const funding = canFund(owner) && native;
    const savedFunding = funding && Boolean(zkapiClient.config?.pending_deposit);
    const freshQuote = fundingQuoteFresh(flow?.fee);
    const remaining = flow?.remainingWei;
    const available = flow?.status?.ethBalance;
    const availableKnown = /^\d+$/.test(String(available));
    const additionalRequired = /^\d+$/.test(String(remaining)) ? BigInt(remaining) : null;
    const ready = flow?.ready && freshQuote;
    const savedDestination = zkapiClient.config?.prepared_withdrawal?.destination || zkapiClient.withdrawal?.destination;
    const address = `<div class="zkapi-funding-address"><input data-funding-address readonly aria-label="Funding address" value="${escape(wallet.address)}" /><button data-funding-copy class="zkapi-secondary-button" type="button">Copy</button></div>`;
    const amountControl = savedFunding && !intent
        ? '<p class="zkapi-helper" role="status">Loading your saved deposit…</p>'
        : savedFunding && intent.usdAmount === null
            ? `<dl class="zkapi-funding-breakdown" aria-label="Saved deposit amount"><div><dt>Saved deposit</dt><dd>${renderFundingWei(owner, intent.depositWei)}</dd></div></dl>`
            : `<label class="zkapi-funding-field">Amount to add to your wallet (USD)<div class="zkapi-funding-usd"><span aria-hidden="true">$</span><input data-funding-usd id="funding-usd" inputmode="decimal" autocomplete="off" aria-label="Amount to add in USD" value="${escape(savedFunding ? intent?.usdAmount ?? '' : owner.fundingUsdAmount ?? intent?.usdAmount ?? '10')}" ${savedFunding ? 'readonly' : ''} ${disabled} /></div></label>`;
    return `<section class="zkapi-funding-account" aria-label="Funding address">
        ${funding ? `${amountControl}
        ${savedFunding ? '<p class="zkapi-note">Your saved deposit keeps its original ETH amount. The network fee estimate refreshes before you continue.</p>' : ''}
        ${intent && flow.totalWei && !flow.dirty && freshQuote ? `<h3>${additionalRequired == null ? 'Checking your funding address…' : additionalRequired === 0n ? 'Funds available' : `Send ${escape(formatFundingAmount(remaining, 18))} ETH${availableKnown && BigInt(available) > 0n ? ' more' : ''}`}</h3>
        <p class="zkapi-helper">On <strong>${escape(network)}</strong> to this address:</p>${address}
        <dl class="zkapi-funding-breakdown" aria-label="Deposit cost estimate">
            <div><dt>Amount added to private balance</dt><dd>${renderFundingWei(owner, intent.depositWei)}</dd></div>
            <div><dt>Estimated network fee</dt><dd>${renderFundingWei(owner, flow.fee.expectedFeeWei)}</dd></div>
            <div><dt>Additional fee buffer</dt><dd>${renderFundingWei(owner, flow.fee.feeBufferWei)}</dd></div>
            ${availableKnown && BigInt(available) > 0n ? `<div><dt>Available toward this deposit</dt><dd>− ${renderFundingWei(owner, BigInt(available) > BigInt(flow.totalWei) ? flow.totalWei : available)}</dd></div>` : ''}
            <div class="zkapi-funding-total"><dt>Total ETH to send</dt><dd>${renderFundingWei(owner, remaining)}</dd></div>
        </dl>
        <p class="zkapi-note">Low network fee. Confirmation may take longer.</p>
        <p class="zkapi-note">This estimate refreshes automatically and is checked again when you click Next. The buffer covers changes in network fees; any unused ETH stays at this address. Your sending wallet charges its own transfer fee separately.</p>
        <p class="zkapi-helper" role="status">${ready ? 'Funds available. Choose Next to add the ETH to your private balance.' : `Checking for funds… Currently at this address: ${escape(formatFundingAmount(available, 18))} ETH.`}</p>
        <button data-funding-next class="zkapi-primary-button" type="button" ${disabled || !ready || wallet.hasPendingTransaction ? 'disabled' : ''}>Next</button>` : `<p class="zkapi-helper" role="status">${flow?.dirty ? 'Updating the ETH amount…' : flow?.fee ? 'Refreshing the network fee estimate…' : 'Estimating the deposit network fee…'}</p>${address}`}
        ${flow?.error ? `<p class="zkapi-funding-error" role="alert">${escape(flow.error)}</p>` : ''}
        <p class="zkapi-note">Your wallet holds ETH. Its USD value changes with the ETH price. Progress is saved in this browser.</p>`
        : `<h3>Your funding address</h3><p class="zkapi-helper">${escape(network)}</p>${address}
        ${renderFundingReceipt(owner)}
        <p class="zkapi-note">New transactions use low network fees and may take longer to confirm.</p>
        ${owner.fundingStatusError ? `<p class="zkapi-helper" role="status">${escape(owner.fundingStatusError)}</p>` : ''}`}
        ${owner.view === 'withdraw' ? `<label class="zkapi-funding-field">Withdrawal destination on ${escape(network)}<input id="funding-withdrawal-destination" data-funding-withdrawal-destination autocomplete="off" spellcheck="false" placeholder="0x…" value="${escape(savedDestination || owner.fundingDestination || '')}" ${savedDestination ? 'readonly' : disabled} /></label><p class="zkapi-note">${savedDestination ? 'This withdrawal keeps its saved destination.' : 'Choose an address you control. Your funding address pays the network fee.'}</p>` : ''}
        ${wallet.hasPendingTransaction ? `<div class="zkapi-funding-pending"><p class="zkapi-helper">Your transaction is saved. Check it to resume.</p><button data-funding-recover class="zkapi-primary-button" type="button" ${disabled}>Check saved transaction</button></div>` : ''}
        <details data-funding-details="return"><summary>Return funds held at this address</summary>
            <p class="zkapi-note">These public funds are separate from your private wallet balance. Keep enough ETH here to pay withdrawal fees. New transfers use low network fees and may take longer to confirm.</p>
            <label class="zkapi-funding-field">Destination on ${escape(network)}<input data-funding-return-destination id="funding-return-destination" autocomplete="off" spellcheck="false" placeholder="0x…" value="${escape(owner.fundingReturnDestination || '')}" ${disabled} /></label>
            ${!native ? `<label class="zkapi-funding-field">${escape(token)} amount<input data-funding-return-amount id="funding-return-amount" inputmode="decimal" value="${escape(owner.fundingReturnAmount || '')}" ${disabled} /></label>` : ''}
            <label class="zkapi-funding-field">ETH amount (optional)<input data-funding-return-eth-amount id="funding-return-eth-amount" inputmode="decimal" placeholder="Leave blank for remaining ETH" value="${escape(owner.fundingReturnEthAmount || '')}" ${disabled} /></label>
            <p class="zkapi-note">Enter an exact amount for a smart-contract recipient. A small fee reserve may remain after returning all ETH to a regular account.</p>
            <div class="zkapi-actions">${!native ? `<button data-funding-return-token class="zkapi-secondary-button" type="button" ${disabled}>Send ${escape(token)}</button>` : ''}<button data-funding-return-eth class="zkapi-secondary-button" type="button" ${disabled}>Send ETH</button></div>
        </details>
        <p data-funding-notice class="zkapi-helper" role="status">${escape(owner.fundingNotice || '')}</p>
    </section>`;
}

export function attachWalletMethodControls(owner) {
    const root = owner.overlay;
    const input = name => root.querySelector(`[data-funding-${name}]`);
    const value = name => input(name)?.value || '';
    const perform = async action => {
        if (owner.busy || owner.fundingBusy) return;
        owner.fundingBusy = true;
        owner.fundingError = '';
        owner.render();
        try { await action(); }
        catch (error) { owner.fundingError = error?.shortMessage || error?.message || 'The action could not be completed.'; }
        finally { owner.fundingBusy = false; if (owner.isOpen) owner.render(); }
    };
    const on = (name, action) => input(name)?.addEventListener('click', action);
    root.querySelectorAll('[data-wallet-method]').forEach(button => button.addEventListener('click', () => perform(async () => {
        stopFundingFlow(owner);
        await setWalletMethod(button.dataset.walletMethod);
        owner.fundingUsdAmount = null;
        if (getWalletMethod() === 'address' && addressFundingWallet.address) owner.fundingStatus = await addressFundingWallet.getStatus();
    })));
    for (const [name, property] of [['withdrawal-destination', 'fundingDestination'], ['return-destination', 'fundingReturnDestination'], ['return-amount', 'fundingReturnAmount'], ['return-eth-amount', 'fundingReturnEthAmount']]) {
        input(name)?.addEventListener('input', event => { owner[property] = event.target.value; });
    }
    input('usd')?.addEventListener('input', event => {
        if (zkapiClient.config?.pending_deposit) return;
        owner.fundingUsdAmount = event.target.value;
        owner.fundingFlow?.invalidate();
        if (input('next')) input('next').disabled = true;
        clearTimeout(owner.fundingEditTimer);
        owner.fundingEditTimer = setTimeout(() => { void owner.fundingFlow?.setAmount(owner.fundingUsdAmount); }, 450);
    });
    on('next', () => owner.submitAddressDeposit?.());
    on('migrate', () => {
        const password = value('legacy-password');
        return perform(async () => { await addressFundingWallet.migrateLegacy(password); stopFundingFlow(owner); });
    });
    on('copy', async () => {
        try { await navigator.clipboard.writeText(addressFundingWallet.address); owner.fundingNotice = 'Funding address copied.'; }
        catch { input('address')?.focus(); input('address')?.select(); owner.fundingNotice = 'Copy the selected address with your keyboard.'; }
        if (input('notice')) input('notice').textContent = owner.fundingNotice;
    });
    on('recover', () => perform(async () => {
        const result = await addressFundingWallet.recoverPending();
        await zkapiClient.refresh();
        owner.fundingStatus = await addressFundingWallet.getStatus();
        owner.fundingNotice = result?.status === 'pending'
            ? 'Waiting for final network confirmation. Your transaction stays saved; check again later.'
            : 'Saved transaction checked.';
    }));
    const transfer = asset => {
        const destination = value('return-destination');
        const amount = value(asset === 'eth' ? 'return-eth-amount' : 'return-amount');
        return perform(async () => {
            const to = fundingDestination(destination);
            const units = asset === 'eth' ? (amount.trim() ? fundingEthAmount(amount) : 'max') : fundingAmount(amount);
            if (!globalThis.confirm(`Send ${asset === 'eth' ? (units === 'max' ? 'remaining ETH after reserving network fees (a small balance may remain)' : `${amount} ETH`) : `${amount} ${zkapiClient.billingTokenSymbol || 'USDC'}`} to ${to} on ${zkapiClient.networkName()}?`)) return;
            const hash = await addressFundingWallet.withAuthorizedAction({ kind: 'sweep', destination: to, asset, amount: units }, () => asset === 'eth'
                ? addressFundingWallet.transferEth(to, units) : addressFundingWallet.transferTokens(to, units));
            owner.fundingNotice = `Transfer submitted: ${hash}. Check the saved transaction before another transfer.`;
            owner.fundingStatus = await addressFundingWallet.getStatus();
        });
    };
    on('return-token', () => transfer('token'));
    on('return-eth', () => transfer('eth'));
    // Defer hydration until the current render has attached every control.
    queueMicrotask(() => { if (owner.isOpen) ensureFundingFlow(owner); });
}

export function captureWalletView(owner) {
    const root = owner.overlay;
    const active = globalThis.document?.activeElement;
    return {
        id: root.contains?.(active) && active?.matches?.('input:not([type=password]), textarea') ? active.id : null,
        // Keep the actual editable node through balance refreshes. Replacing a
        // focused input between composition/typing events can lose keystrokes.
        preservedInput: root.contains?.(active) && active?.id === 'funding-usd' ? active : null,
        start: active?.selectionStart, end: active?.selectionEnd,
        scroll: root.querySelector('[data-funding-scroll]')?.scrollTop,
        details: Array.from(root.querySelectorAll?.('[data-funding-details][open]') || [], element => element.dataset.fundingDetails)
    };
}

export function restoreWalletView(owner, saved) {
    if (!saved) return;
    for (const key of saved.details || []) {
        const details = owner.overlay.querySelector(`[data-funding-details="${key}"]`);
        if (details) details.open = true;
    }
    if (saved.id) {
        let input = owner.overlay.querySelector(`#${saved.id}`);
        if (input && saved.preservedInput) {
            saved.preservedInput.disabled = input.disabled;
            saved.preservedInput.readOnly = input.readOnly;
            if (input.readOnly) saved.preservedInput.value = input.value;
            input.replaceWith(saved.preservedInput);
            input = saved.preservedInput;
        }
        input?.focus?.({ preventScroll: true });
        if (saved.start != null) input?.setSelectionRange?.(saved.start, saved.end);
    }
    const scroller = owner.overlay.querySelector('[data-funding-scroll]');
    if (scroller && saved.scroll != null) scroller.scrollTop = saved.scroll;
}
