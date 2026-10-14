import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { chatDB } from '../../db.js';
import { addressFundingWallet } from '../services/addressFundingProvider.mjs';
import { AddressDepositFlow } from '../services/addressDepositFlow.mjs';
import { DepositAmount } from '../services/depositAmount.mjs';
import { renderFundingPaymentQr } from './FundingPaymentQr.js';
import { renderFundingProgress } from './FundingProgress.js';
import { getWalletMethod, setWalletMethod, prepareWalletMethod, walletMethodActionBusy } from '../services/walletMethod.mjs';
import { canQuotePendingAddressDeposit, formatFundingAmount, fundingEthAmount, fundingDestination } from '../services/addressFunding.js';

// -- Protocol versions --------------------------------------------------------
// The facade boot attaches to the SDK client answers whether a deposit may
// start here. Without it (single-version builds, tests) nothing restricts a
// deposit; a facade that is present but cannot answer fails closed. This file
// gains no imports for it: it is evaluated by tests with its import lines
// removed.

function depositGate() {
    let facade = null;
    try { facade = zkapiClient.oaVersioning || null; } catch { facade = null; }
    if (!facade || typeof facade.depositGate !== 'function') return null;
    try {
        const gate = facade.depositGate();
        return gate && typeof gate === 'object' ? gate : { canStart: false, canResume: false, code: null };
    } catch { return { canStart: false, canResume: false, code: null }; }
}

// May a deposit start here, or (with a saved one) be finished? A closed
// version creates no draft, quote or flow, whatever the person types.
function depositAllowed(hasSaved = false) {
    const gate = depositGate();
    return gate === null || gate.canStart === true || (gate.canResume === true && hasSaved === true);
}

// The ETH left at the funding address of a previous version, from local facts
// first. Offered only on a build with more than one version, and only when the
// page has the helpers for it (`ui.rescue`, the funding-address module).
function retiredRescue() {
    try {
        const facade = zkapiClient.oaVersioning;
        if (!facade || facade.multiVersion !== true) return null;
        const rescue = facade.ui?.rescue;
        return rescue && typeof rescue.listRetiredScopes === 'function' ? rescue : null;
    } catch { return null; }
}

export function refreshWalletView(owner, { immediate = false } = {}) {
    if (!owner.isOpen || owner.fundingBusy || globalThis.document?.activeElement?.type === 'password') return;
    // Background address/quote updates share the modal's disclosure queue.
    // Explicit edits still hide stale transfer instructions immediately.
    if (!immediate && owner.disclosureAnimating) {
        owner.disclosureRefreshPending = true;
        return;
    }
    owner.render();
}

function amountFlow(owner) {
    return getWalletMethod() === 'address' ? owner.fundingFlow : owner.depositAmountFlow;
}

// The amount flow's error is shown once. After a failed Deposit the owner
// echoes it (AccountModal outcome, WelcomePanel error) next to the action and
// carries the input's aria-describedby target, so the flow's own copy yields.
function ownerEchoesFlowError(owner, flow) {
    const message = flow?.error;
    return Boolean(message) && (owner.outcome?.message === message || owner.error === message);
}

export function stopFundingFlow(owner, { preserveAmount = false } = {}) {
    const selected = amountFlow(owner);
    if (preserveAmount) {
        owner.sharedDepositIntent = selected?.intent && !selected.dirty ? selected.intent : null;
        owner.preferDepositInput = true;
    } else {
        owner.sharedDepositIntent = null;
        owner.preferDepositInput = false;
        owner.fundingInputAmount = null;
        owner.fundingInputCurrency = null;
    }
    owner.depositAmountFlow?.stop();
    owner.depositAmountFlow = null;
    clearTimeout(owner.fundingEditTimer);
    owner.fundingFlow?.stop();
    owner.fundingFlow = null;
    stopFundingStatus(owner);
    owner.fundingStatus = null;
    owner.fundingHelpOpen = null;
    owner.disposeFundingHelp?.();
    owner.disposeFundingHelp = null;
    // A balance read at a previous version's address is a moment's answer.
    owner.retiredScopes = undefined;
    owner.retiredChecks = null;
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
        if (!owner.busy && !owner.fundingBusy) refreshWalletView(owner);
        if (current()) poll.timer = setTimeout(check, 5000);
    };
    void check();
}

function canFund(owner) {
    const pending = zkapiClient.config?.pending_deposit;
    // Welcome hands all saved work to the balance dialog. Only the SDK can
    // declare a saved deposit definitely unsubmitted and safe to quote again.
    const quotableSaved = !owner.resumeSavedDeposit && canQuotePendingAddressDeposit();
    return getWalletMethod() === 'address' && owner.isOpen && !owner.depositBalanceRefreshPending && !zkapiClient.note
        && (!pending || quotableSaved) && !['withdraw', 'withdrawals'].includes(owner.view)
        && owner.step !== 'success' && owner.walletMethodReady !== false
        && depositAllowed(Boolean(pending));
}

export function isFundingViewHydrating(owner) {
    if (!canFund(owner) || addressFundingWallet.migrationRequired || owner.fundingError) return false;
    const flow = owner.fundingFlow;
    return !flow?.error && !flow?.fee && !flow?.displayQuote;
}

function canSelectAmount(owner) {
    return !zkapiClient.note && !owner.depositBalanceRefreshPending
        && !['withdraw', 'withdrawals'].includes(owner.view) && !['success', 'redeeming'].includes(owner.step)
        && depositAllowed(Boolean(zkapiClient.config?.pending_deposit));
}

function suggestedAmount(owner) {
    const suggested = zkapiClient.suggestedDeposit ?? 10;
    return owner.fundingInputAmount ?? owner.depositAmount ?? owner.fundingUsdAmount
        ?? suggested.toFixed(suggested < 0.01 ? 6 : 2);
}

function ensureDepositAmount(owner) {
    if (getWalletMethod() === 'address') return ensureFundingFlow(owner);
    if (!canSelectAmount(owner) || zkapiClient.config?.pending_deposit || owner.depositAmountFlow) return;
    const flow = new DepositAmount({ client: zkapiClient, changed: () => {
        if (owner.depositAmountFlow !== flow || !owner.isOpen) return;
        if (flow.intent && owner.fundingInputAmount == null && !flow.dirty) syncFundingInput(owner, flow.intent);
        if (!owner.busy && !owner.fundingBusy) refreshWalletView(owner);
    } });
    owner.depositAmountFlow = flow;
    const starting = flow.start(suggestedAmount(owner), owner.fundingInputCurrency || 'usd', { initialIntent: owner.sharedDepositIntent });
    flow.startEdit = flow.editGeneration;
    flow.starting = starting.finally(() => { flow.starting = null; });
}

// Resolve and validate the selected principal before any wallet authorization.
// A display-only currency/method switch must never reprice an existing intent.
export async function prepareDepositAmount(owner) {
    // Before any quote: a quote saves a draft that pins this version.
    if (!depositAllowed(Boolean(zkapiClient.config?.pending_deposit))) {
        throw new Error(depositGate()?.code === 'reload_required'
            ? 'This page is out of date. Reload to continue.'
            : 'This version no longer accepts new deposits.');
    }
    ensureDepositAmount(owner);
    const flow = amountFlow(owner);
    if (!flow) throw new Error('The deposit amount is still loading. Try again shortly.');
    if (flow.starting && flow.startEdit === flow.editGeneration) {
        await flow.starting;
        if (flow.error) throw new Error(flow.error);
    }
    if (amountFlow(owner) !== flow || owner.isOpen === false || !flow.running) {
        throw new Error('The deposit amount changed. Review it before continuing.');
    }
    if (!flow.intent || flow.dirty) {
        clearTimeout(owner.fundingEditTimer);
        owner.fundingEditTimer = null;
        if (!await flow.setAmount(suggestedAmount(owner), owner.fundingInputCurrency || 'usd', { check: false })) {
            throw new Error(flow.error || 'Check the deposit amount before continuing.');
        }
    }
    if (amountFlow(owner) !== flow || owner.isOpen === false || !flow.running || flow.dirty) {
        throw new Error('The deposit amount changed. Review it before continuing.');
    }
    return flow.intent.ethAmount;
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
    if (owner.fundingFlow) {
        // A flow the deposit gate closed is final only until the gate allows
        // a deposit again: the flow re-reads the gate itself and restarts
        // with the amount it last asked for, so a state change that reopens
        // deposits does not wait for the person to reopen this view. Called on
        // every pass; it changes nothing while the gate still refuses.
        const closed = owner.fundingFlow;
        if (closed.closed && typeof closed.reopenIfAllowed === 'function') {
            Promise.resolve(closed.reopenIfAllowed()).catch(() => {});
        }
        return;
    }
    const flow = new AddressDepositFlow({
        wallet: addressFundingWallet, client: zkapiClient,
        store: {
            read: scope => chatDB.getSetting(`oa-eth-deposit:${scope}`),
            write: (scope, value) => chatDB.updateSettings([{ key: `oa-eth-deposit:${scope}`, value }]),
            compareAndSwap: (scope, expected, value) => chatDB.compareAndSetSetting(`oa-eth-deposit:${scope}`, expected, value)
        },
        changed: event => {
            if (amountFlow(owner) !== flow || !owner.isOpen) return;
            owner.fundingStatus = flow.status;
            if (flow.intent && owner.fundingInputAmount == null && !flow.dirty) syncFundingInput(owner, flow.intent);
            // Expiry immediately disables Deposit, including during a stalled
            // RPC. Keep the last transfer estimate and open details in place.
            if (event?.expired) owner.render();
            else if (!owner.busy && !owner.fundingBusy) refreshWalletView(owner);
        }
    });
    owner.fundingFlow = flow;
    void flow.start(suggestedAmount(owner), owner.fundingInputCurrency || 'usd', {
        initialIntent: owner.sharedDepositIntent, preferInput: owner.preferDepositInput
    });
}

export function renderWalletMethod(owner) {
    const local = getWalletMethod() === 'address';
    const locked = owner.busy || owner.fundingBusy || walletMethodActionBusy() || owner.walletMethodReady === false || addressFundingWallet.hasPendingTransaction;
    // Authentication does not select a signer or replace its durable request.
    // A saved pending transaction must not lock users out of API recovery.
    const accessLocked = owner.busy || owner.fundingBusy || walletMethodActionBusy() || owner.walletMethodReady === false;
    return `<section class="zkapi-wallet-method" aria-label="Wallet method">
        <div class="zkapi-wallet-method-options" role="group" aria-label="How to transact">
            <button type="button" data-wallet-method="metamask" aria-pressed="${!local}" ${locked ? 'disabled' : ''}>MetaMask</button>
            <button type="button" data-wallet-method="address" aria-pressed="${local}" ${locked ? 'disabled' : ''}>Send Ethereum</button>
        </div>
        ${Number(zkapiClient.config?.funding?.chain_id) === 11155111 ? `<button type="button" data-funding-testnet-password class="zkapi-quiet-button" ${accessLocked ? 'disabled' : ''}>${zkapiClient.testnetAuthenticated ? 'Change Sepolia password' : 'Enter Sepolia password'}</button>` : ''}
        ${owner.fundingError ? `<p class="zkapi-funding-error" role="alert">${owner.escapeHtml(owner.fundingError)}</p>` : ''}
    </section>`;
}

function fundingUsdValue(value) {
    let usd = null;
    // ETH stays exact. USD is only a current reference value; native accounting
    // uses whole gwei, so discard sub-gwei dust for this approximate display.
    if (/^\d+$/.test(String(value))) {
        try {
            const formatted = zkapiClient.formatMoney((BigInt(value) / 1_000_000_000n).toString());
            if (formatted && formatted !== '—') usd = formatted;
        } catch { /* A price outage must not hide the exact ETH amount. */ }
    }
    return usd;
}

export function renderFundingWei(owner, value) {
    const usd = fundingUsdValue(value);
    return `${owner.escapeHtml(formatFundingAmount(value, 18))} ETH${usd ? ` <span>(≈ ${owner.escapeHtml(usd)})</span>` : ''}`;
}

function fundingSummaryAmount(owner, value) {
    const usd = fundingUsdValue(value);
    return usd ? `≈ ${owner.escapeHtml(usd)}` : `${owner.escapeHtml(formatFundingAmount(value, 18))} ETH`;
}

function intentCurrency(intent) {
    return intent?.inputCurrency || (intent?.usdAmount === null ? 'eth' : 'usd');
}

function intentInputAmount(intent) {
    return intent?.inputAmount ?? (intentCurrency(intent) === 'eth' ? intent?.ethAmount : intent?.usdAmount);
}

function syncFundingInput(owner, intent) {
    owner.fundingInputCurrency = intentCurrency(intent);
    owner.fundingInputAmount = intentInputAmount(intent);
    owner.fundingUsdAmount = intent.usdAmount;
}

function fundingQuoteFresh(fee) {
    return Number.isFinite(fee?.quotedAt) && Number.isFinite(fee?.expiresAt)
        && fee.quotedAt <= Date.now() && fee.expiresAt > Date.now();
}

function fundingHelp(owner, kind, heading, content, summary = '') {
    const scope = String(owner.overlay?.id || 'wallet').replace(/[^a-zA-Z0-9_-]/g, '-');
    const id = `zkapi-${scope}-funding-${kind}-help`;
    const open = owner.fundingHelpOpen === kind;
    const quote = kind === 'quote';
    const label = quote ? 'Transaction breakdown' : 'Funding address details';
    const toggle = `<button id="${id}-toggle" data-funding-help-toggle type="button" class="zkapi-funding-help-toggle${quote ? ' zkapi-funding-breakdown-toggle' : ''}" aria-label="${label}" aria-expanded="${open}" aria-controls="${id}">${quote ? 'Transaction breakdown <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' : '?'}</button>`;
    return `<div class="zkapi-funding-help" data-funding-help="${kind}">
        <div class="zkapi-funding-heading">
            <h3 class="${quote ? 'zkapi-funding-send-amount' : ''}">${heading}</h3>
            ${quote ? '' : toggle}
        </div>
        ${summary}
        ${quote ? toggle : ''}
        <div id="${id}" data-funding-help-panel class="zkapi-funding-help-panel" role="region" aria-label="${label}" ${open ? '' : 'hidden'}>${content}</div>
    </div>`;
}

function attachFundingHelp(owner) {
    owner.disposeFundingHelp?.();
    owner.disposeFundingHelp = null;
    const root = owner.overlay;
    const help = root.querySelector('[data-funding-help]');
    const button = root.querySelector('[data-funding-help-toggle]');
    const panel = root.querySelector('[data-funding-help-panel]');
    if (!help || !button || !panel) {
        // Address hydration can render several times before this panel exists.
        // Closing or changing methods already clears its presentation state.
        return;
    }
    if (owner.fundingHelpOpen !== help.dataset.fundingHelp) owner.fundingHelpOpen = null;
    const setOpen = open => {
        owner.fundingHelpOpen = open ? help.dataset.fundingHelp : null;
        panel.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
        owner.rememberRunningModal?.();
    };
    const toggle = () => setOpen(panel.hidden);
    const outside = event => {
        if (help.dataset.fundingHelp !== 'quote' && !panel.hidden && !help.contains(event.target)) setOpen(false);
    };
    const escape = event => {
        if (event.key !== 'Escape' || panel.hidden) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        button.focus({ preventScroll: true });
    };
    const document = root.ownerDocument || globalThis.document;
    button.addEventListener('click', toggle);
    document?.addEventListener?.('click', outside);
    // Capture Escape before the enclosing dialog handles it. A second Escape
    // still closes the dialog normally.
    document?.addEventListener?.('keydown', escape, true);
    owner.disposeFundingHelp = () => {
        button.removeEventListener('click', toggle);
        document?.removeEventListener?.('click', outside);
        document?.removeEventListener?.('keydown', escape, true);
    };
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

export function renderDepositAmount(owner) {
    if (!canSelectAmount(owner)) return '';
    const pending = zkapiClient.config?.pending_deposit;
    if (pending && (owner.resumeSavedDeposit || !['prepared', 'retry_exact'].includes(pending.phase)
        || (getWalletMethod() === 'address' && !canQuotePendingAddressDeposit())
        || !/^[1-9]\d*$/.test(String(pending.amount)))) return '';
    const flow = amountFlow(owner);
    const saved = Boolean(pending);
    let intent = flow?.intent;
    if (saved && String(intent?.amount) !== String(pending.amount)) {
        const units = BigInt(pending.amount);
        const fraction = String(units % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
        intent = { inputCurrency: 'eth', inputAmount: `${units / 1_000_000_000n}${fraction ? `.${fraction}` : ''}` };
    }
    const currency = saved ? intentCurrency(intent) : owner.fundingInputCurrency || intentCurrency(intent);
    const amount = saved ? intentInputAmount(intent) : owner.fundingInputAmount ?? intentInputAmount(intent) ?? suggestedAmount(owner);
    const disabled = owner.busy || owner.fundingBusy || owner.walletMethodReady === false;
    const label = currency.toUpperCase();
    const local = getWalletMethod() === 'address';
    // The flow's error sits under this input (MetaMask) or under the receiving
    // address (Send Ethereum); either way the input points at it.
    const flowError = !saved && flow?.error && !ownerEchoesFlowError(owner, flow) ? 'zkapi-amount-error' : '';
    const describedBy = [owner.outcome?.field === 'deposit' ? 'zkapi-deposit-error' : '', flowError].filter(Boolean).join(' ');
    return `<section class="zkapi-deposit-amount" aria-label="${saved ? 'Saved deposit amount' : 'Deposit amount'}">
        <div class="zkapi-funding-field"><label for="funding-${currency}">${saved ? 'Saved deposit amount' : 'Amount to deposit'}</label>
        <div class="zkapi-funding-amount-input">${currency === 'usd' ? '<span aria-hidden="true">$</span>' : ''}<input data-funding-amount data-funding-${currency} id="funding-${currency}" inputmode="decimal" autocomplete="off" aria-label="Amount to add in ${label}" ${describedBy ? `aria-invalid="true" aria-describedby="${describedBy}"` : ''} value="${owner.escapeHtml(amount)}" ${saved ? 'readonly' : ''} ${disabled ? 'disabled' : ''} />
        <button data-funding-currency id="funding-currency" class="zkapi-funding-currency" type="button" aria-label="Switch amount to ${currency === 'usd' ? 'ETH' : 'USD'}" ${disabled || saved || addressFundingWallet.hasPendingTransaction ? 'disabled' : ''}>${label}<span aria-hidden="true">⇄</span></button></div></div>
        ${flowError && !local ? `<p id="zkapi-amount-error" class="zkapi-funding-error" role="alert">${owner.escapeHtml(flow.error)}</p>` : ''}
    </section>`;
}

export function renderFundingAccount(owner) {
    if (getWalletMethod() !== 'address') return '';
    const escape = value => owner.escapeHtml(value);
    const wallet = addressFundingWallet;
    const latestReturn = wallet.lastReturn;
    const disabled = owner.busy || owner.fundingBusy ? 'disabled' : '';
    const network = zkapiClient.networkName();
    const flow = owner.fundingFlow;
    // Existing encrypted accounts are never overwritten. This one-time upgrade
    // is shown only for a legacy record; new accounts have no password or backup.
    if (wallet.migrationRequired) return `<section class="zkapi-funding-account">
        <p class="zkapi-helper">This browser has an existing encrypted funding address. Unlock it once to keep the same address in browser storage.</p>
        <label class="zkapi-funding-field">Existing password<input data-funding-legacy-password type="password" autocomplete="current-password" ${disabled} /></label>
        <button data-funding-migrate class="zkapi-primary-button" type="button" ${disabled}>Use this address</button>
    </section>`;
    if (!wallet.address) return `<section class="zkapi-funding-account"><p class="zkapi-helper" role="status">${escape(flow?.error || 'Preparing your address…')}</p></section>`;
    const intent = flow?.intent;
    const funding = canFund(owner);
    const savedFunding = funding && Boolean(zkapiClient.config?.pending_deposit);
    const freshQuote = fundingQuoteFresh(flow?.fee);
    // Public transfer instructions can retain their last estimate while fees
    // refresh. Only the fresh fee can authorize the separate Deposit action.
    const displayFee = flow?.fee || flow?.displayQuote;
    const displayTotal = intent && displayFee && !flow?.dirty
        ? BigInt(intent.depositWei) + BigInt(displayFee.feeReserveWei) : null;
    const displayBalance = flow?.status?.ethBalance;
    const remaining = displayTotal != null && /^\d+$/.test(String(displayBalance))
        ? String(displayTotal > BigInt(displayBalance) ? displayTotal - BigInt(displayBalance) : 0n) : null;
    const available = flow?.status?.ethBalance;
    const availableKnown = /^\d+$/.test(String(available));
    const displayedRequiredCovered = Boolean(intent && displayFee && availableKnown
        && BigInt(available) >= BigInt(intent.depositWei) + BigInt(displayFee.requiredFeeWei));
    const recommendedRemaining = /^\d+$/.test(String(remaining)) ? BigInt(remaining) : null;
    const ready = flow?.ready && freshQuote;
    const updating = Boolean(displayFee && !freshQuote);
    const balanceLine = `<p class="zkapi-helper zkapi-funding-available">Available at this address: ${availableKnown ? renderFundingWei(owner, available) : 'Checking balance…'}</p>`;
    // A failed quote is a state of its own: the heading must not keep
    // promising an update that already failed. The poll retries a quote it
    // was asked for; a saved amount that could not be restored waits for input.
    const failed = Boolean(flow?.error);
    // A flow a version closed is final: it does not retry and nothing here may
    // promise that it will.
    const closedFlow = Boolean(flow?.closed);
    const retrying = failed && !closedFlow && Boolean(flow.intent || flow.requestedAmount);
    const fundingLoading = closedFlow ? 'Deposits are closed' : failed ? 'Estimate unavailable' : flow?.dirty ? 'Updating the ETH amount…' : flow?.fee ? 'Refreshing the network fee estimate…' : 'Estimating the deposit network fee…';
    const fundingLoadingNote = closedFlow ? 'Nothing was sent.' : failed ? 'The amount and breakdown will appear once the estimate succeeds.' : 'The amount and breakdown will appear when the estimate is ready.';
    const fundingRetryHint = failed && !closedFlow ? `<p class="zkapi-note">${retrying ? 'Retrying automatically. Changing the amount or switching between USD and ETH also starts a new estimate.' : 'Change the amount or switch between USD and ETH to try again.'}</p>` : '';
    // With deposits closed and no balance, the address is not a place to send
    // funds to. Only a withdrawal (or upgrade) needs it, for its fee.
    const addressHidden = !depositAllowed(Boolean(zkapiClient.config?.pending_deposit)) && !zkapiClient.note
        && !['withdraw', 'upgrade'].includes(owner.view);
    const showFlowError = failed && !ownerEchoesFlowError(owner, flow);
    const sendUsd = fundingUsdValue(remaining);
    const sendUsdReference = `<span class="zkapi-funding-send-usd">${sendUsd ? `≈ ${escape(sendUsd)} USD` : 'USD estimate unavailable'}</span>`;
    const sendHeading = ready ? 'Ready to deposit' : displayedRequiredCovered ? 'Funds received' : recommendedRemaining == null ? 'Checking your funding address…' : recommendedRemaining === 0n ? 'Funds available'
        : `<span class="zkapi-funding-send-label">Send</span> <span class="zkapi-funding-send-value"><span class="zkapi-funding-send-number">${escape(formatFundingAmount(remaining, 18))}</span> <span>ETH${availableKnown && BigInt(available) > 0n ? ' more' : ''}</span></span>${sendUsdReference}`;
    const savedDestination = zkapiClient.config?.prepared_withdrawal?.destination || zkapiClient.withdrawal?.destination;
    const address = `<div class="zkapi-funding-address"><input data-funding-address readonly aria-label="This browser’s receiving address" value="${escape(wallet.address)}" /><button data-funding-copy class="zkapi-secondary-button" type="button">Copy address</button></div>`;
    return `<section class="zkapi-funding-account" aria-label="This browser’s receiving address">
        ${funding ? `
        ${intent && displayTotal != null && !flow.dirty ? `${fundingHelp(owner, 'quote', sendHeading, `${availableKnown ? renderFundingProgress({ availableWei: available, depositWei: intent.depositWei,
            requiredFeeWei: displayFee.requiredFeeWei, feeBufferWei: displayFee.feeBufferWei,
            renderAmount: value => renderFundingWei(owner, value) }) : balanceLine}
        <dl class="zkapi-funding-breakdown" aria-label="Deposit cost estimate">
            <div><dt>Estimated actual network fee</dt><dd>${renderFundingWei(owner, displayFee.expectedFeeWei)}</dd></div>
            <div class="zkapi-funding-total"><dt>${displayedRequiredCovered ? 'Optional buffer remaining' : 'Amount to send'}</dt><dd>${renderFundingWei(owner, remaining)}</dd></div>
        </dl>
        <p class="zkapi-note">In your own wallet, choose <strong>${escape(network)}</strong> and send ETH to this browser’s receiving address. Copy the address or scan the QR, then confirm the transfer in your wallet.</p>
        <p class="zkapi-note">Only your deposit is added to the private balance. The fee allowance includes the optional buffer; unused ETH stays at this address.</p>
        ${savedFunding ? '<p class="zkapi-note">Your saved deposit keeps its original ETH amount. The network fee estimate refreshes before you continue.</p>' : ''}
        <p class="zkapi-note">Fees are checked again when you click Deposit. Your sending wallet charges its own transfer fee separately.</p>
        <p class="zkapi-note">Your balance holds ETH. Its USD value changes with the ETH price. Keep this browser’s site data to retain access.</p>`,
        `<p class="zkapi-funding-summary">Deposit ${fundingSummaryAmount(owner, intent.depositWei)} · Fee allowance ${fundingSummaryAmount(owner, displayFee.feeReserveWei)}</p>`)}
        ${address}
        ${!flow.error && !displayedRequiredCovered && remaining != null && BigInt(remaining) > 0n ? renderFundingPaymentQr({ address: wallet.address,
            chainId: Number(zkapiClient.config?.funding?.chain_id), amountWei: remaining }) : ''}
        <p class="zkapi-helper zkapi-funding-status" role="status">${ready ? 'Funds received.'
            : !availableKnown ? 'Checking balance…'
                : updating ? 'Updating fee estimate…'
                    : BigInt(available) === 0n ? 'Waiting for ETH…'
                        : `${escape(formatFundingAmount(flow.requiredRemainingWei, 18))} ETH still needed.`}</p>
        <button data-funding-next class="zkapi-primary-button" type="button" ${disabled || !ready || wallet.hasPendingTransaction ? 'disabled' : ''}>Deposit</button>` : `${fundingHelp(owner, 'quote', fundingLoading, `${balanceLine}<p class="zkapi-note" role="status">${fundingLoadingNote}</p>`)}${address}`}
        ${showFlowError ? `<p id="zkapi-amount-error" class="zkapi-funding-error" role="alert">${escape(flow.error)}</p>` : ''}${intent && displayTotal != null && !flow.dirty ? '' : fundingRetryHint}`
        : `${fundingHelp(owner, 'receipt', addressHidden ? 'ETH left at your funding address' : 'This browser’s receiving address', renderFundingReceipt(owner))}${owner.view === 'withdraw' ? '<p class="zkapi-note">If more ETH is needed for the withdrawal fee, send it here from your own wallet. Enter your withdrawal destination below.</p>' : owner.view === 'upgrade' && ['review', 'withdrawing'].includes(owner.upgradeStage) ? '<p class="zkapi-note">If more ETH is needed for the withdrawal fee, send it to this address from your own wallet first.</p>' : ''}${addressHidden ? '' : address}
        ${owner.fundingStatusError ? `<p class="zkapi-helper" role="status">${escape(owner.fundingStatusError)}</p>` : ''}`}
        ${owner.view === 'withdraw' ? `<label class="zkapi-funding-field">Your wallet address on ${escape(network)}<input id="funding-withdrawal-destination" data-funding-withdrawal-destination autocomplete="off" spellcheck="false" placeholder="0x…" value="${escape(savedDestination || owner.fundingDestination || '')}" ${savedDestination ? 'readonly' : disabled} /></label><p class="zkapi-note">${savedDestination ? 'This withdrawal keeps its saved destination.' : 'Enter the Ethereum address in your own wallet where you want to receive the withdrawal. This browser’s receiving address pays the network fee separately.'}</p>` : ''}
        ${wallet.hasPendingTransaction ? `<div class="zkapi-funding-pending"><p class="zkapi-helper">Your transaction is saved. Check it to resume.</p><p class="zkapi-note">A check can resend the same signed transaction. It never creates a new payment or raises the saved fee. If network fees are higher, confirmation may need to wait until they fall.</p><button data-funding-recover class="zkapi-primary-button" type="button" ${disabled}>Check saved transaction</button></div>` : ''}
        <details data-funding-details="return"><summary>Return leftover ETH</summary>
            ${latestReturn ? `<p class="zkapi-helper zkapi-funding-return-outcome" role="status">${latestReturn.status === 'confirmed'
                ? `Last return confirmed: ${escape(formatFundingAmount(latestReturn.amount, 18))} ETH sent to ${escape(latestReturn.destination)}.`
                : 'Last return reverted. No funds were transferred; the network fee may still have been charged. You can review the balance and try again.'}</p>` : ''}
            <p class="zkapi-note">Use this only for extra ETH left at this browser’s receiving address. To withdraw your private balance, use Withdraw. Keep enough ETH here for that withdrawal’s network fee.</p>
            <label class="zkapi-funding-field">Destination on ${escape(network)}<input data-funding-return-destination id="funding-return-destination" autocomplete="off" spellcheck="false" placeholder="0x…" value="${escape(owner.fundingReturnDestination || '')}" ${disabled} /></label>
            <label class="zkapi-funding-field">ETH amount (optional)<input data-funding-return-eth-amount id="funding-return-eth-amount" inputmode="decimal" placeholder="Leave blank for remaining ETH" value="${escape(owner.fundingReturnEthAmount || '')}" ${disabled} /></label>
            <p class="zkapi-note">Enter an exact amount for a smart-contract recipient. A small fee reserve may remain after returning all ETH to a regular account.</p>
            <div class="zkapi-actions"><button data-funding-return-eth class="zkapi-secondary-button" type="button" ${disabled || wallet.hasPendingTransaction ? 'disabled' : ''}>Send ETH</button></div>
        </details>${renderRetiredScopes(owner)}
        <p data-funding-notice class="zkapi-helper" role="status">${escape(owner.fundingNotice || '')}</p>
    </section>`;
}

// Leftover ETH at the funding address a previous version used in this browser.
// The list is local facts; a balance is read only when the person asks, with
// the privacy sentence in front of the button; a return is signed only after
// they confirm. Without the helpers (single version, none yet) it is empty.
function renderRetiredScopes(owner) {
    const entries = Array.isArray(owner.retiredScopes) ? owner.retiredScopes : [];
    if (!entries.length || !retiredRescue()) return '';
    const escape = value => owner.escapeHtml(value);
    const table = Array.isArray(zkapiClient.oaVersioning?.table) ? zkapiClient.oaVersioning.table : [];
    const disabled = owner.busy || owner.fundingBusy || addressFundingWallet.hasPendingTransaction ? 'disabled' : '';
    const compact = value => (/^0x[0-9a-fA-F]{40}$/.test(value || '') ? `${value.slice(0, 6)}…${value.slice(-4)}` : '');
    return `<details data-funding-details="retired" data-funding-retired><summary>Leftover ETH from a previous version</summary>
        <p class="zkapi-note">Each version has its own funding address in this browser. ETH left at an older one is still yours. Checking a balance asks the network provider about that older address, which links it to this one there.</p>
        ${entries.map(entry => {
        const id = escape(entry.versionId);
        const row = table.find(version => version?.id === entry.versionId);
        const name = escape(row?.label || entry.versionId);
        const check = owner.retiredChecks?.[entry.versionId];
        const known = check && /^\d+$/.test(String(check.balanceWei));
        let body;
        if (entry.unreadable) body = '<p class="zkapi-helper">This saved address could not be read here.</p>';
        else if (entry.pending) body = `<p class="zkapi-helper">A return from this address is waiting to be confirmed.</p><button data-funding-retired-recover="${id}" class="zkapi-secondary-button" type="button" ${disabled}>Check saved transaction</button>`;
        else if (known && BigInt(check.balanceWei) > 0n) body = `<p class="zkapi-helper" role="status">ETH at this address: ${renderFundingWei(owner, check.balanceWei)}</p><button data-funding-retired-move="${id}" class="zkapi-secondary-button" type="button" ${disabled}>Move to this address</button>`;
        else if (known) body = '<p class="zkapi-helper" role="status">Nothing is left at this address.</p>';
        else body = `<button data-funding-retired-check="${id}" class="zkapi-secondary-button" type="button" ${disabled}>Check balance</button>`;
        const last = entry.lastReturn?.status === 'confirmed' ? '<p class="zkapi-note">Its last return was confirmed.</p>' : '';
        return `<section class="zkapi-stack" data-funding-retired-row="${id}">
            <p class="zkapi-helper">${name} funding address${compact(entry.address) ? ` · ${escape(compact(entry.address))}` : ''}</p>${last}${body}</section>`;
    }).join('')}
    </details>`;
}

// A transaction another version started from this address was settled for
// good by the network, so the marker that held the ETH back is gone. Said
// plainly, by how it ended; it was not sent from here.
function releasedScopeNotice(finalState) {
    const tail = ' This address can now return its ETH.';
    if (finalState === 'confirmed') return `The saved transaction from the other version finished.${tail}`;
    if (finalState === 'reverted') {
        return `The saved transaction from the other version was reverted by the network. No funds were transferred; the network fee may still have been charged.${tail}`;
    }
    if (finalState === 'replaced') return `The saved transaction from the other version was replaced and will not be sent.${tail}`;
    return `The saved transaction from the other version is settled.${tail}`;
}

// One read of local facts per open of the funding view; never a balance.
function loadRetiredScopes(owner) {
    const rescue = retiredRescue();
    if (!rescue || getWalletMethod() !== 'address' || !owner.isOpen || owner.retiredScopes !== undefined) return;
    owner.retiredScopes = null;
    const table = zkapiClient.oaVersioning.table;
    Promise.resolve().then(() => rescue.listRetiredScopes({ table })).then(list => {
        owner.retiredScopes = Array.isArray(list) ? list : [];
        if (owner.isOpen && owner.retiredScopes.length && !owner.busy && !owner.fundingBusy) refreshWalletView(owner);
    }, () => { owner.retiredScopes = []; });
}

export function attachWalletMethodControls(owner) {
    const root = owner.overlay;
    attachFundingHelp(owner);
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
    on('testnet-password', async () => {
        if (owner.busy || owner.fundingBusy) return;
        await perform(async () => {
            stopFundingFlow(owner, { preserveAmount: true });
            await zkapiClient.ensureTestnetAccess({ interactive: true, changePassword: true });
        });
        // Both busy-state renders replace the trigger. Restore focus only
        // after the final render, using the current button rather than its
        // disconnected predecessor captured by the password dialog.
        if (owner.isOpen) owner.overlay?.querySelector('[data-funding-testnet-password]')?.focus?.();
    });
    root.querySelectorAll('[data-wallet-method]').forEach(button => button.addEventListener('click', () => {
        if (owner.busy || owner.fundingBusy || walletMethodActionBusy() || owner.walletMethodReady === false) return;
        if (getWalletMethod() === button.dataset.walletMethod) return;
        owner.fundingError = '';
        owner.fundingNotice = '';
        owner.clearTransientOutcome?.();
        stopFundingFlow(owner, { preserveAmount: true });
        try { setWalletMethod(button.dataset.walletMethod); }
        catch (error) { owner.fundingError = error.message; }
        owner.rememberRunningModal?.();
        // Render the choice immediately. New address hydration/polling starts
        // afterward and is never part of this click's critical path.
        if (owner.isOpen) owner.render();
    }));
    for (const [name, property] of [['withdrawal-destination', 'fundingDestination'], ['return-destination', 'fundingReturnDestination'], ['return-eth-amount', 'fundingReturnEthAmount']]) {
        input(name)?.addEventListener('input', event => { owner[property] = event.target.value; });
    }
    input('amount')?.addEventListener('input', event => {
        if (owner.busy || owner.fundingBusy || zkapiClient.config?.pending_deposit) return;
        if (!amountFlow(owner)) ensureDepositAmount(owner);
        const currency = owner.fundingInputCurrency || intentCurrency(amountFlow(owner)?.intent);
        const amount = event.target.value;
        const flow = amountFlow(owner);
        owner.sharedDepositIntent = null;
        owner.preferDepositInput = true;
        owner.fundingInputCurrency = currency;
        owner.fundingInputAmount = amount;
        owner.rememberRunningModal?.();
        if (currency === 'usd') owner.fundingUsdAmount = amount;
        if (owner.outcome?.field === 'deposit') owner.outcome = null;
        flow?.invalidate();
        if (flow) flow.requestedAmount = { value: amount, currency };
        if (input('next')) input('next').disabled = true;
        clearTimeout(owner.fundingEditTimer);
        owner.fundingEditTimer = setTimeout(() => {
            owner.fundingEditTimer = null;
            if (amountFlow(owner) === flow && !flow?.initializing) void flow?.setAmount(amount, currency);
        }, 450);
        // Hide old payment instructions immediately, while retaining the actual
        // focused input node so typing and composition are not interrupted.
        refreshWalletView(owner, { immediate: true });
    });
    on('currency', async () => {
        if (!amountFlow(owner)) ensureDepositAmount(owner);
        const flow = amountFlow(owner);
        if (!flow || owner.busy || owner.fundingBusy || zkapiClient.config?.pending_deposit || addressFundingWallet.hasPendingTransaction) return;
        const currency = owner.fundingInputCurrency || intentCurrency(flow.intent);
        const amount = owner.fundingInputAmount ?? intentInputAmount(flow.intent) ?? '10';
        const focusToggle = globalThis.document?.activeElement === input('currency');
        clearTimeout(owner.fundingEditTimer);
        owner.fundingEditTimer = null;
        await perform(async () => {
            if (!flow.intent && owner.preferDepositInput && !flow.initializing) {
                // An explicit draft gets the same exact conversion as a settled
                // amount, even if it was typed before the first quote finished.
                if (!await flow.setAmount(amount, currency, { check: false, useCachedPrice: true })) return;
            }
            if (!flow.intent) {
                // A failed initial USD quote must not block direct ETH entry.
                // Waiting until initial restoration finishes prevents a later
                // startup default from replacing this empty user-selected draft.
                if (flow.initializing) return;
                const nextCurrency = currency === 'usd' ? 'eth' : 'usd';
                flow.invalidate();
                await flow.setAmount('', nextCurrency, { check: false, useCachedPrice: true });
                if (amountFlow(owner) === flow && owner.isOpen) {
                    owner.fundingInputCurrency = nextCurrency;
                    owner.fundingInputAmount = '';
                    flow.error = '';
                }
                return;
            }
            // Convert a just-typed draft with the loaded price. Only local
            // persistence precedes the unit change; chain reads run afterward.
            if (flow.dirty && !await flow.setAmount(amount, currency, { check: false, useCachedPrice: true })) return;
            if (amountFlow(owner) !== flow || !owner.isOpen || flow.dirty) return;
            if (await flow.setCurrency(currency === 'usd' ? 'eth' : 'usd') && amountFlow(owner) === flow && owner.isOpen) {
                syncFundingInput(owner, flow.intent);
                owner.sharedDepositIntent = flow.intent;
                owner.preferDepositInput = true;
            }
        });
        if (focusToggle && owner.isOpen && amountFlow(owner) === flow) input('currency')?.focus?.({ preventScroll: true });
    });
    on('next', () => owner.submitAddressDeposit?.());
    on('migrate', () => {
        const password = value('legacy-password');
        return perform(async () => { await addressFundingWallet.migrateLegacy(password); stopFundingFlow(owner); });
    });
    on('copy', async () => {
        try { await navigator.clipboard.writeText(addressFundingWallet.address); owner.fundingNotice = 'Receiving address copied.'; }
        catch { input('address')?.focus(); input('address')?.select(); owner.fundingNotice = 'Copy the selected address with your keyboard.'; }
        if (input('notice')) input('notice').textContent = owner.fundingNotice;
        clearTimeout(owner.fundingNoticeTimer);
        owner.fundingNoticeTimer = setTimeout(() => {
            owner.fundingNotice = '';
            if (input('notice')) input('notice').textContent = '';
        }, 7000);
    });
    on('recover', () => perform(async () => {
        const release = await prepareWalletMethod();
        try {
            const returning = addressFundingWallet.pending?.kind === 'sweep';
            const result = await addressFundingWallet.recoverPending();
            owner.fundingNotice = result?.status === 'pending'
                ? 'Waiting for final network confirmation. Your transaction stays saved; check again later. If network fees exceed its saved fee, it may need to wait until they fall.'
                : returning && result?.status === 'confirmed' ? 'Return confirmed.'
                    : returning && result?.status === 'reverted'
                        ? 'Return reverted. No funds were transferred; the network fee may still have been charged. Review the balance before trying again.'
                        : 'Saved transaction checked.';
            try {
                await zkapiClient.refresh();
                owner.fundingStatus = await addressFundingWallet.getStatus();
                owner.fundingStatusError = '';
            } catch {
                // Recovery already committed its result. A display refresh
                // failure cannot turn a verified return into a failed payment.
                owner.fundingStatus = null;
                owner.fundingStatusError = 'Transaction status is saved. Unable to refresh the balance right now; retrying…';
            }
        } finally { release?.(); }
    }));
    const transferEth = () => {
        const destination = value('return-destination');
        const amount = value('return-eth-amount');
        return perform(async () => {
            const to = fundingDestination(destination);
            const units = amount.trim() ? fundingEthAmount(amount) : 'max';
            if (!globalThis.confirm(`Send ${units === 'max' ? 'remaining ETH after reserving network fees (a small balance may remain)' : `${amount} ETH`} to ${to} on ${zkapiClient.networkName()}?`)) return;
            const release = await prepareWalletMethod();
            try {
                const hash = await addressFundingWallet.withAuthorizedAction({ kind: 'sweep', destination: to, asset: 'eth', amount: units },
                    () => addressFundingWallet.transferEth(to, units));
                owner.fundingNotice = `Transfer submitted: ${hash}. Check the saved transaction before another transfer.`;
                try {
                    owner.fundingStatus = await addressFundingWallet.getStatus();
                    owner.fundingStatusError = '';
                } catch {
                    owner.fundingStatus = null;
                    owner.fundingStatusError = 'Your transfer stays saved. Unable to refresh the balance right now; retrying…';
                }
            } finally { release?.(); }
        });
    };
    on('return-eth', transferEth);
    // Leftover ETH at a previous version's funding address. Each button is one
    // explicit gesture: a balance read, a confirmed return, a saved return's check.
    const retiredEntry = id => (owner.retiredScopes || []).find(entry => entry.versionId === id);
    const retiredTable = () => zkapiClient.oaVersioning?.table;
    root.querySelectorAll('[data-funding-retired-check]').forEach(button => button.addEventListener('click', () => {
        const rescue = retiredRescue();
        const entry = retiredEntry(button.dataset.fundingRetiredCheck);
        if (!rescue || !entry) return undefined;
        return perform(async () => {
            const result = await rescue.checkRetiredScopeBalance({ scope: entry.scope, table: retiredTable() });
            (owner.retiredChecks ||= {})[entry.versionId] = { balanceWei: String(result.balanceWei) };
        });
    }));
    root.querySelectorAll('[data-funding-retired-move]').forEach(button => button.addEventListener('click', () => {
        const rescue = retiredRescue();
        const entry = retiredEntry(button.dataset.fundingRetiredMove);
        const destination = addressFundingWallet.address;
        if (!rescue || !entry || !destination) return undefined;
        return perform(async () => {
            const known = owner.retiredChecks?.[entry.versionId]?.balanceWei;
            const amount = /^\d+$/.test(String(known)) ? `${formatFundingAmount(known, 18)} ETH` : 'the ETH';
            if (!globalThis.confirm(`Move ${amount} from this older funding address to this browser’s current funding address? The network fee comes out of that amount.`)) return;
            const release = await prepareWalletMethod();
            try {
                const result = await rescue.sweepRetiredScope({ scope: entry.scope, table: retiredTable(), destination });
                owner.fundingNotice = `Transfer submitted: ${result.transactionHash}. Check the saved transaction before another transfer.`;
                // The balance read before the return is no longer true.
                owner.retiredScopes = undefined;
                owner.retiredChecks = null;
            } finally { release?.(); }
        });
    }));
    root.querySelectorAll('[data-funding-retired-recover]').forEach(button => button.addEventListener('click', () => {
        const rescue = retiredRescue();
        const entry = retiredEntry(button.dataset.fundingRetiredRecover);
        if (!rescue || !entry) return undefined;
        return perform(async () => {
            const release = await prepareWalletMethod();
            try {
                const result = await rescue.recoverRetiredScope({ scope: entry.scope, table: retiredTable() });
                owner.fundingNotice = result?.status === 'confirmed' ? 'Return confirmed.'
                    : result?.status === 'reverted'
                        ? 'Return reverted. No funds were transferred; the network fee may still have been charged. Review the balance before trying again.'
                        : result?.status === 'released' ? releasedScopeNotice(result.finalState)
                            : result ? 'Waiting for final network confirmation. Your transaction stays saved; check again later.'
                                : 'Saved transaction checked.';
                owner.retiredScopes = undefined;
                owner.retiredChecks = null;
            } finally { release?.(); }
        });
    }));
    // Defer hydration until the current render has attached every control.
    queueMicrotask(() => {
        if (owner.isOpen) ensureDepositAmount(owner);
        loadRetiredScopes(owner);
    });
}

export function captureWalletView(owner) {
    const root = owner.overlay;
    const active = globalThis.document?.activeElement;
    return {
        id: root.contains?.(active) && active?.matches?.('input:not([type=password]), textarea, [data-funding-help-toggle], [data-funding-currency]') ? active.id : null,
        // Fee/balance callbacks may render again after the password action's
        // own completion render. Preserve only a currently focused trigger;
        // never retain this intent after focus moves to another control.
        passwordTriggerFocused: owner.isOpen && root.contains?.(active)
            && active?.matches?.('[data-funding-testnet-password]') === true,
        // Keep the actual editable node through balance refreshes. Replacing a
        // focused input between composition/typing events can lose keystrokes.
        preservedInput: root.contains?.(active) && ['funding-usd', 'funding-eth'].includes(active?.id) ? active : null,
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
            for (const name of ['aria-invalid', 'aria-describedby']) {
                const value = input.getAttribute?.(name);
                if (value != null) saved.preservedInput.setAttribute?.(name, value);
                else saved.preservedInput.removeAttribute?.(name);
            }
            if (input.readOnly) saved.preservedInput.value = input.value;
            input.replaceWith(saved.preservedInput);
            input = saved.preservedInput;
        }
        input?.focus?.({ preventScroll: true });
        if (saved.start != null) input?.setSelectionRange?.(saved.start, saved.end);
    }
    if (saved.passwordTriggerFocused && owner.isOpen) {
        owner.overlay.querySelector('[data-funding-testnet-password]')?.focus?.({ preventScroll: true });
    }
    const scroller = owner.overlay.querySelector('[data-funding-scroll]');
    if (scroller && saved.scroll != null) scroller.scrollTop = saved.scroll;
}
