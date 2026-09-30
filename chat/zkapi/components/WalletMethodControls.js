import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { chatDB } from '../../db.js';
import { addressFundingWallet } from '../services/addressFundingProvider.mjs';
import { AddressDepositFlow } from '../services/addressDepositFlow.mjs';
import { DepositAmount } from '../services/depositAmount.mjs';
import { renderFundingPaymentQr } from './FundingPaymentQr.js';
import { renderFundingProgress } from './FundingProgress.js';
import { motionDuration } from '../../ui/uiMotion.js';
import { getWalletMethod, setWalletMethod, prepareWalletMethod, walletMethodActionBusy } from '../services/walletMethod.mjs';
import { canQuotePendingAddressDeposit, formatFundingAmount, fundingAmount, fundingEthAmount, fundingDestination } from '../services/addressFunding.js';

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
    owner.fundingReturnOpen = false;
    owner.disposeFundingHelp?.();
    owner.disposeFundingHelp = null;
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
        && owner.step !== 'success' && owner.walletMethodReady !== false;
}

export function isFundingViewHydrating(owner) {
    if (!zkapiClient.isNativeEthFunding || !canFund(owner) || addressFundingWallet.migrationRequired || owner.fundingError) return false;
    const flow = owner.fundingFlow;
    return !flow?.error && !flow?.fee && !flow?.displayQuote;
}

function canSelectAmount(owner) {
    return zkapiClient.isNativeEthFunding && !zkapiClient.note && !owner.depositBalanceRefreshPending
        && !['withdraw', 'withdrawals'].includes(owner.view) && !['success', 'redeeming'].includes(owner.step);
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
    if (owner.fundingFlow) return;
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

/** The signer choice. It is shown only where the choice decides the next
 *  action (a new deposit, a new withdrawal); once work has started the
 *  method is settled, so `choose: false` keeps only Sepolia access and any
 *  method error. */
export function renderWalletMethod(owner, { choose = true } = {}) {
    const local = getWalletMethod() === 'address';
    const locked = owner.busy || owner.fundingBusy || walletMethodActionBusy() || owner.walletMethodReady === false || addressFundingWallet.hasPendingTransaction;
    // Authentication does not select a signer or replace its durable request.
    // A saved pending transaction must not lock users out of API recovery.
    const accessLocked = owner.busy || owner.fundingBusy || walletMethodActionBusy() || owner.walletMethodReady === false;
    const password = Number(zkapiClient.config?.funding?.chain_id) === 11155111
        ? `<button type="button" data-funding-testnet-password class="zkapi-quiet-button zkapi-inline-action" ${accessLocked ? 'disabled' : ''}>${zkapiClient.testnetAuthenticated ? 'Change Sepolia password' : 'Enter Sepolia password'}</button>` : '';
    const error = owner.fundingError ? `<p class="zkapi-funding-error" role="alert">${owner.escapeHtml(owner.fundingError)}</p>` : '';
    if (!choose && !password && !error) return '';
    return `<section class="zkapi-wallet-method" aria-label="Wallet method">
        ${choose ? `<div class="zkapi-segmented" role="group" aria-label="How to pay" data-active="${local ? 'address' : 'metamask'}">
            <button type="button" data-wallet-method="metamask" aria-pressed="${!local}" ${locked ? 'disabled' : ''}>MetaMask</button>
            <button type="button" data-wallet-method="address" aria-pressed="${local}" ${locked ? 'disabled' : ''}>Send ETH</button>
        </div>` : ''}
        ${password}
        ${error}
    </section>`;
}

function fundingUsdValue(value) {
    let usd = null;
    // ETH stays exact. USD is only a current reference value; native accounting
    // uses whole gwei, so discard sub-gwei dust for this approximate display.
    if (zkapiClient.isNativeEthFunding && /^\d+$/.test(String(value))) {
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

// A cost line in the breakdown: dollars when the price is known (the exact
// ETH on hover), otherwise the exact ETH. The amount to send stands alone.
function fundingShort(owner, value) {
    const usd = fundingUsdValue(value);
    const eth = `${formatFundingAmount(value, 18)} ETH`;
    return usd ? `<span title="${owner.escapeHtml(eth)}">${owner.escapeHtml(usd)}</span>` : owner.escapeHtml(eth);
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

function fundingHelpId(owner, kind) {
    const scope = String(owner.overlay?.id || 'wallet').replace(/[^a-zA-Z0-9_-]/g, '-');
    return `zkapi-${scope}-funding-${kind}-help`;
}

// What the ETH at the funding address is, and that it can go back. The row's
// header stays one line; this opens with it.
// The QR's footprint, drawn empty. The caption keeps its line but not its words.
const QR_PLACEHOLDER = '<figure class="zkapi-funding-qr is-pending" data-funding-qr-placeholder aria-hidden="true"><span class="zkapi-funding-qr-slot"></span><figcaption>Scan to pay</figcaption></figure>';

// Deposit's place while there is nothing to deposit yet: the same disabled
// button, but not the real control (no data-funding-next), so it can never
// authorize anything.
const DEPOSIT_PLACEHOLDER = '<button class="zkapi-primary-button w-full zkapi-funding-next-pending" type="button" disabled>Deposit</button>';

// The breakdown row's place before there is a quote to break down: the same
// header, not yet openable, and not a [data-funding-help] row.
const BREAKDOWN_PLACEHOLDER = '<div class="zkapi-funding-help t-acc" data-funding-help-pending data-open="false"><button type="button" class="zkapi-funding-help-toggle t-acc-head" disabled><span class="zkapi-funding-help-label">Transaction breakdown</span><span class="t-acc-chevron"><svg class="zkapi-funding-help-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5L8 10.5L12 6.5"/></svg></span></button></div>';

const RETURN_EXPLANATION = 'This ETH isn’t in your private balance: it’s what you sent but haven’t deposited, or fee left over after a deposit. This browser holds it, so clearing the site’s data would lose it. You can return it to your wallet below.';

// A disclosure row in the dialog's own idiom (label, chevron, hairline), for
// detail that is there when wanted: the fee breakdown, the funding address,
// a leftover return. It opens with the app's Transitions.dev accordion
// (grid rows 0fr → 1fr, a blur-fade, the chevron flipping), like Payment
// history. A closed panel is inert, so nothing in it can be reached.
function fundingHelpIsOpen(owner, kind) {
    return kind === 'return' ? owner.fundingReturnOpen === true : owner.fundingHelpOpen === kind;
}

function fundingHelp(owner, kind, label, content, note = '') {
    const id = fundingHelpId(owner, kind);
    const open = fundingHelpIsOpen(owner, kind);
    return `<div class="zkapi-funding-help t-acc" data-funding-help="${kind}" data-open="${open}">
        <button id="${id}-toggle" data-funding-help-toggle type="button" class="zkapi-funding-help-toggle t-acc-head" aria-expanded="${open}" aria-controls="${id}"><span class="zkapi-funding-help-label">${label}${note ? `<span class="zkapi-guide-note">${note}</span>` : ''}</span><span class="t-acc-chevron"><svg class="zkapi-funding-help-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5L8 10.5L12 6.5"/></svg></span></button>
        <div id="${id}" data-funding-help-panel class="zkapi-funding-help-panel t-acc-panel" role="region" aria-label="${label}" ${open ? '' : 'inert'}><div class="t-acc-panel-inner"><div class="zkapi-funding-help-body">${content}</div></div></div>
    </div>`;
}

// A transfer typed by hand rounds up to a millionth of an ETH, so it can
// never fall short; the QR and the breakdown keep the exact wei.
function sendEthText(value) {
    if (!/^\d+$/.test(String(value))) return formatFundingAmount(value, 18);
    const step = 1_000_000_000_000n;
    const wei = BigInt(value);
    return formatFundingAmount(((wei + step - 1n) / step * step).toString(), 18);
}

function attachFundingHelp(owner) {
    owner.disposeFundingHelp?.();
    owner.disposeFundingHelp = null;
    const root = owner.overlay;
    const rows = [...(root.querySelectorAll?.('[data-funding-help]') || [])].map(help => ({
        help, kind: help.dataset.fundingHelp,
        button: help.querySelector('[data-funding-help-toggle]'), panel: help.querySelector('[data-funding-help-panel]')
    })).filter(row => row.button && row.panel);
    // Address hydration can render several times before these rows exist,
    // and after a reload the first render can show another row (the address
    // receipt) before the quote arrives. An open row is therefore remembered
    // by kind and only opens that row; closing the dialog or changing methods
    // clears it (stopFundingFlow).
    if (!rows.length) return;
    const view = root.ownerDocument?.defaultView;
    let motionTimer;
    const setOpen = (row, open) => {
        if (row.kind === 'return') owner.fundingReturnOpen = open;
        else owner.fundingHelpOpen = open ? row.kind : null;
        if (open) owner.fundingHelpLast = row.kind;
        // Hold background re-renders until the panel has settled: a fresh
        // render would draw the final state and cut the motion short.
        const duration = view ? Math.max(motionDuration(row.help, open ? '--acc-expand' : '--acc-collapse', 250),
            motionDuration(row.help, '--acc-chevron', 250)) : 0;
        if (duration > 0 && owner.handleDisclosureMotion) {
            view.clearTimeout(motionTimer);
            owner.handleDisclosureMotion(true);
            motionTimer = view.setTimeout(() => owner.handleDisclosureMotion(false), duration);
        }
        row.help.dataset.open = String(open);
        row.panel.inert = !open;
        row.button.setAttribute('aria-expanded', String(open));
        owner.rememberRunningModal?.();
    };
    const handlers = rows.map(row => {
        const toggle = () => setOpen(row, !fundingHelpIsOpen(owner, row.kind));
        row.button.addEventListener('click', toggle);
        return [row.button, toggle];
    });
    const escape = event => {
        if (event.key !== 'Escape') return;
        const open = rows.filter(row => fundingHelpIsOpen(owner, row.kind));
        if (!open.length) return;
        const active = root.ownerDocument?.activeElement;
        const row = open.find(entry => entry.help.contains?.(active))
            || open.find(entry => entry.kind === owner.fundingHelpLast) || open.at(-1);
        event.preventDefault();
        event.stopPropagation();
        setOpen(row, false);
        row.button.focus({ preventScroll: true });
    };
    const document = root.ownerDocument || globalThis.document;
    // Capture Escape before the enclosing dialog handles it. A later Escape
    // still closes the dialog normally.
    document?.addEventListener?.('keydown', escape, true);
    owner.disposeFundingHelp = () => {
        view?.clearTimeout(motionTimer);
        for (const [button, toggle] of handlers) button.removeEventListener('click', toggle);
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
    return `<p class="zkapi-helper">Currently at this address: ${renderFundingWei(owner, balance)}</p>
        ${hasFee ? `<dl class="zkapi-funding-breakdown" aria-label="Confirmed deposit costs"><div><dt>Actual deposit network fee</dt><dd>${renderFundingWei(owner, record.feeWei)}</dd></div></dl>
        <p class="zkapi-note">Unused fee ETH stays here, apart from your private balance, and may also hold ETH from other transfers. Keep it for future fees or return it.</p>` : ''}`;
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
    // The amount is the figure, as in the funded view: "$ 5.00  USD ⇄".
    const width = Math.max(3, String(amount ?? '').length + 0.5);
    return `<section class="zkapi-deposit-amount" aria-label="${saved ? 'Saved deposit amount' : 'Deposit amount'}">
        <label class="zkapi-balance-caption" for="funding-${currency}">${saved ? 'Saved deposit amount' : 'Amount to deposit'}</label>
        <div class="zkapi-amount-figure">${currency === 'usd' ? '<span class="zkapi-amount-prefix" aria-hidden="true">$</span>' : ''}<input data-funding-amount data-funding-${currency} id="funding-${currency}" inputmode="decimal" autocomplete="off" aria-label="Amount to add in ${label}" ${describedBy ? `aria-invalid="true" aria-describedby="${describedBy}"` : ''} style="width:${width}ch" value="${owner.escapeHtml(amount)}" ${saved ? 'readonly' : ''} ${disabled ? 'disabled' : ''} /><button data-funding-currency id="funding-currency" class="zkapi-funding-currency" type="button" aria-label="Switch amount to ${currency === 'usd' ? 'ETH' : 'USD'}" data-unit="${label}" ${disabled || saved || addressFundingWallet.hasPendingTransaction ? 'disabled' : ''}><span class="zkapi-funding-currency-unit">${label}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 4.75h10.5M11.25 2.75l2 2-2 2M13.25 11.25H2.75M4.75 9.25l-2 2 2 2"/></svg></button></div>
        ${flowError && !local ? `<p id="zkapi-amount-error" class="zkapi-funding-error" role="alert">${owner.escapeHtml(flow.error)}</p>` : ''}
    </section>`;
}

/** Whether the Send ETH instructions (amount, QR, address, Deposit) are
 *  the view's main content, rather than the funding address's receipt. */
export function fundingInstructionsVisible(owner) {
    return canFund(owner) && Boolean(zkapiClient.isNativeEthFunding);
}

const SPINNER = '<span class="zkapi-pill-spinner" aria-hidden="true"></span>';

export function renderFundingAccount(owner, { destination = true, rows = true, pending = true, receipt: receiptOnly = false } = {}) {
    if (getWalletMethod() !== 'address') return '';
    const escape = value => owner.escapeHtml(value);
    const wallet = addressFundingWallet;
    const latestReturn = wallet.lastReturn;
    const disabled = owner.busy || owner.fundingBusy ? 'disabled' : '';
    const network = zkapiClient.networkName();
    const native = zkapiClient.isNativeEthFunding;
    const token = zkapiClient.billingTokenSymbol || 'USDC';
    const flow = owner.fundingFlow;
    // Existing encrypted accounts are never overwritten. This one-time upgrade
    // is shown only for a legacy record; new accounts have no password or backup.
    if (wallet.migrationRequired) return `<section class="zkapi-funding-account">
        <p class="zkapi-helper">This browser has an existing encrypted funding address. Unlock it once to keep the same address in browser storage.</p>
        <label class="zkapi-funding-field"><span>Existing password</span><input data-funding-legacy-password type="password" autocomplete="current-password" ${disabled} /></label>
        <button data-funding-migrate class="zkapi-primary-button w-full" type="button" ${disabled}>Use this address</button>
    </section>`;
    if (!wallet.address) return `<section class="zkapi-funding-account"><p class="zkapi-helper" role="status">${escape(flow?.error || (native ? 'Preparing your address…' : 'ETH funding is not available on this deployment yet.'))}</p></section>`;
    const intent = flow?.intent;
    // receiptOnly: a deposit is under way, so the address shows as a receipt
    // (balance, return) rather than as instructions to send to it.
    const funding = !receiptOnly && canFund(owner) && native;
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
    const retrying = failed && Boolean(flow.intent || flow.requestedAmount);
    const fundingLoading = failed ? 'Estimate unavailable' : flow?.dirty ? 'Updating the ETH amount…' : flow?.fee ? 'Refreshing the network fee estimate…' : 'Estimating the deposit network fee…';
    const fundingLoadingNote = failed ? (retrying ? 'Retrying automatically. Changing the amount or its currency also starts a new estimate.' : 'Change the amount or its currency to try again.')
        : 'The amount to send appears when the estimate is ready.';
    const showFlowError = failed && !ownerEchoesFlowError(owner, flow);
    const sendUsd = fundingUsdValue(remaining);
    const sendUsdReference = `<span class="zkapi-funding-send-usd">${sendUsd ? `≈ ${escape(sendUsd)} USD` : 'USD estimate unavailable'}</span>`;
    const sendsAmount = !ready && !displayedRequiredCovered && recommendedRemaining != null && recommendedRemaining > 0n;
    const sendHeading = ready ? 'Ready to deposit' : displayedRequiredCovered ? 'Funds received' : recommendedRemaining == null ? 'Checking your funding address…' : recommendedRemaining === 0n ? 'Funds available'
        : `<span class="zkapi-funding-send-label">Send</span> <span class="zkapi-funding-send-value"><span class="zkapi-funding-send-number">${escape(sendEthText(remaining))}</span> <span>ETH${availableKnown && BigInt(available) > 0n ? ' more' : ''}</span></span>${sendUsdReference}`;
    const savedDestination = zkapiClient.config?.prepared_withdrawal?.destination || zkapiClient.withdrawal?.destination;
    // The whole address stays visible: it wraps on a narrow screen rather
    // than hiding its tail. Copy answers on the button itself (copy → check);
    // nothing else on the page moves. Only a blocked clipboard adds a line.
    const address = `<div class="zkapi-funding-address"><div id="zkapi-funding-address" data-funding-address class="zkapi-funding-address-value" role="textbox" aria-readonly="true" tabindex="0" spellcheck="false" aria-label="This browser’s receiving address">${escape(wallet.address)}</div><button data-funding-copy class="zkapi-secondary-button zkapi-copy-button" type="button" aria-label="Copy address" title="Copy address" data-copied="${owner.addressCopied ? 'true' : 'false'}"><svg class="zkapi-copy-face" data-face="copy" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.75"/><path d="M10.5 3.5v-.25A1.75 1.75 0 0 0 8.75 1.5h-5.5A1.75 1.75 0 0 0 1.5 3.25v5.5c0 .97.78 1.75 1.75 1.75h.25"/></svg><svg class="zkapi-copy-face" data-face="copied" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-6"/></svg></button><span class="zkapi-visually-hidden" role="status" data-funding-copy-status></span></div>
        <p data-funding-notice class="zkapi-helper zkapi-funding-notice" role="status">${owner.fundingNoticeScope === 'return' || (owner.fundingNoticeScope === 'pending' && wallet.hasPendingTransaction) ? '' : escape(owner.fundingNotice || '')}</p>`;
    // Said once, over the field: where the ETH comes from, where it goes and
    // on which network. The same address exists on every EVM network, and the
    // app only watches this one, so the network belongs in the sentence.
    const sendAddress = `<div class="zkapi-funding-to"><p class="zkapi-balance-caption zkapi-funding-to-head">Send from your wallet to this address on ${escape(network)}</p>${address}</div>`;
    const quoted = funding && intent && displayTotal != null && !flow.dirty;
    const qr = quoted && !flow.error && sendsAmount ? renderFundingPaymentQr({ address: wallet.address,
        chainId: Number(zkapiClient.config?.funding?.chain_id), amountWei: remaining }) : '';
    // While a transfer is still expected, the QR keeps its place even before
    // it can be drawn (first quote, a new amount, a refresh that failed), so
    // nothing under it moves when it arrives. Once the address is funded it
    // is no longer needed and the space goes with it.
    const expectsTransfer = funding && !ready && !displayedRequiredCovered && (recommendedRemaining == null || recommendedRemaining > 0n);
    const qrSlot = qr || (expectsTransfer ? QR_PLACEHOLDER : '');
    const status = ready ? 'Funds received.'
        : !availableKnown ? 'Checking balance…'
            : updating ? 'Updating fee estimate…'
                : BigInt(available) === 0n ? 'Waiting for ETH…<small>Usually arrives within a minute of sending.</small>'
                    : `${escape(sendEthText(flow.requiredRemainingWei))} ETH still needed.`;
    const breakdown = quoted ? `${renderFundingProgress({ availableWei: availableKnown ? available : null, depositWei: intent.depositWei,
            requiredFeeWei: displayFee.requiredFeeWei, feeBufferWei: displayFee.feeBufferWei, expectedFeeWei: displayFee.expectedFeeWei,
            renderAmount: value => fundingShort(owner, value) })}
        <dl class="zkapi-funding-breakdown" aria-label="Deposit cost estimate">
            <div class="zkapi-funding-total"><dt>${displayedRequiredCovered ? 'Optional buffer remaining' : 'Amount to send'}</dt><dd${remaining == null ? '' : ` title="${escape(formatFundingAmount(remaining, 18))} ETH"`}>${escape(sendEthText(remaining))} ETH${fundingUsdValue(remaining) ? ` <span>≈ ${escape(fundingUsdValue(remaining))}</span>` : ''}</dd></div>
        </dl>
        ${savedFunding ? '<p class="zkapi-note">Your saved deposit keeps its original ETH amount. Its fee estimate refreshes before you continue.</p>' : ''}` : '';
    const fundingView = !funding ? '' : quoted ? `
        <div class="zkapi-funding-pay${qrSlot ? ' has-qr' : ''}">
            ${qrSlot}
            <div class="zkapi-funding-pay-main">
                <h3 class="zkapi-funding-send-amount">${sendHeading}</h3>
                <p class="zkapi-funding-summary">Deposit ${fundingSummaryAmount(owner, intent.depositWei)} · Fee allowance ${fundingSummaryAmount(owner, displayFee.feeReserveWei)}</p>
                <p class="zkapi-funding-status" role="status">${!ready && availableKnown && !updating ? SPINNER : ''}<span>${status}</span></p>
            </div>
        </div>
        ${sendAddress}
        <button data-funding-next class="zkapi-primary-button w-full" type="button" ${disabled || !ready || wallet.hasPendingTransaction ? 'disabled' : ''}>Deposit</button>
        ${showFlowError ? `<p id="zkapi-amount-error" class="zkapi-funding-error" role="alert">${escape(flow.error)}</p>` : ''}` : `
        <div class="zkapi-funding-pay${qrSlot ? ' has-qr' : ''}">
            ${qrSlot}
            <div class="zkapi-funding-pay-main">
                <h3 class="zkapi-funding-send-amount zkapi-funding-send-pending">${fundingLoading}</h3>
                <p class="zkapi-funding-status" role="status">${failed ? '' : SPINNER}<span>${fundingLoadingNote}</span></p>
                ${balanceLine}
            </div>
        </div>
        ${sendAddress}
        ${expectsTransfer ? DEPOSIT_PLACEHOLDER : ''}
        ${showFlowError ? `<p id="zkapi-amount-error" class="zkapi-funding-error" role="alert">${escape(flow.error)}</p>` : ''}`;
    const addressBalance = owner.fundingFlow ? null : owner.fundingStatus?.ethBalance;
    // Outside the funding view a flow's balance may predate the deposit, so the
    // summary uses the same settled balance as the receipt.
    const knownBalance = funding ? (availableKnown ? available : null) : addressBalance;
    const leftover = /^\d+$/.test(String(knownBalance)) && BigInt(knownBalance) > 0n ? `${escape(sendEthText(knownBalance))} ETH` : '';
    const receipt = funding ? '' : fundingHelp(owner, 'receipt', 'Funding address',
        `${renderFundingReceipt(owner)}${address}${owner.fundingStatusError ? `<p class="zkapi-helper" role="status">${escape(owner.fundingStatusError)}</p>` : ''}`,
        /^\d+$/.test(String(addressBalance)) ? `${escape(sendEthText(addressBalance))} ETH` : '');
    const withdrawalDestination = owner.view === 'withdraw' && destination ? `<label class="zkapi-funding-field"><span>Your wallet address on ${escape(network)}</span><input id="funding-withdrawal-destination" data-funding-withdrawal-destination autocomplete="off" spellcheck="false" placeholder="0x…" value="${escape(savedDestination || owner.fundingDestination || '')}" ${savedDestination ? 'readonly' : disabled} /></label>
        <p class="zkapi-helper">${savedDestination ? 'This withdrawal keeps its saved destination.' : 'Where the withdrawal is sent. The network fee is paid from this browser’s funding address.'}</p>` : '';
    return `<section class="zkapi-funding-account${funding ? ' is-funding' : ''}" aria-label="This browser’s receiving address">
        ${fundingView}
        ${withdrawalDestination}
        ${pending && wallet.hasPendingTransaction ? `<div class="zkapi-funding-pending"><p class="zkapi-helper">Your transaction is saved. Check it to resume.</p><p class="zkapi-note">Checking resends the same signed transaction. It never creates a new payment or raises its fee.</p><button data-funding-recover class="zkapi-primary-button w-full" type="button" ${disabled}>Check saved transaction</button>${owner.fundingNoticeScope === 'pending' && owner.fundingNotice ? `<p class="zkapi-helper" role="status">${escape(owner.fundingNotice)}</p>` : ''}</div>` : ''}
        ${rows ? `<div class="zkapi-funding-rows">
            ${quoted ? fundingHelp(owner, 'quote', 'Transaction breakdown', breakdown) : expectsTransfer ? BREAKDOWN_PLACEHOLDER : ''}
            ${receipt}
            ${fundingHelp(owner, 'return', 'Return ETH to your wallet', `${latestReturn ? `<p class="zkapi-helper zkapi-funding-return-outcome" role="status">${latestReturn.status === 'confirmed'
                    ? `Last return confirmed: ${escape(formatFundingAmount(latestReturn.amount, latestReturn.asset === 'eth' ? 18 : Number(zkapiClient.config?.funding?.billing_token_decimals ?? 6)))} ${latestReturn.asset === 'eth' ? 'ETH' : escape(token)} sent to ${escape(latestReturn.destination)}.`
                    : 'Last return reverted. No funds were transferred; the network fee may still have been charged. You can review the balance and try again.'}</p>` : ''}
                <p class="zkapi-note">${RETURN_EXPLANATION}</p>
                <div class="zkapi-funding-return-fields">
                    <label class="zkapi-funding-field"><span>Your wallet address</span><input data-funding-return-destination id="funding-return-destination" autocomplete="off" spellcheck="false" placeholder="0x…" value="${escape(owner.fundingReturnDestination || '')}" ${disabled} /></label>
                    ${!native ? `<label class="zkapi-funding-field"><span>${escape(token)} amount</span><input data-funding-return-amount id="funding-return-amount" inputmode="decimal" value="${escape(owner.fundingReturnAmount || '')}" ${disabled} /></label>` : ''}
                    <label class="zkapi-funding-field zkapi-funding-field--amount"><span>Amount (ETH)</span><input data-funding-return-eth-amount id="funding-return-eth-amount" inputmode="decimal" placeholder="All" title="Leave blank to send all remaining ETH (a small fee reserve may remain). Enter an exact amount for a smart-contract recipient." value="${escape(owner.fundingReturnEthAmount || '')}" ${disabled} /></label>
                </div>
                ${owner.fundingNoticeScope === 'return' && owner.fundingNotice ? `<p class="zkapi-helper zkapi-funding-return-outcome" role="status">${escape(owner.fundingNotice)}</p>` : ''}
                <div class="zkapi-actions">${!native ? `<button data-funding-return-token class="zkapi-secondary-button" type="button" ${disabled || wallet.hasPendingTransaction ? 'disabled' : ''}>Return ${escape(token)}</button>` : ''}<button data-funding-return-eth class="zkapi-secondary-button" type="button" ${disabled || wallet.hasPendingTransaction ? 'disabled' : ''}>Return ETH</button></div>`,
                leftover ? `${leftover} at this address` : '')}
        </div>` : ''}

    </section>`;
}

const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

function motionAllowed(root) {
    const view = root?.ownerDocument?.defaultView;
    return Boolean(view && !view.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

// Transitions.dev "Tabs sliding" for the signer choice. The dialog is
// re-rendered with innerHTML, so the new control is drawn where the pill
// was (data-from, no transition), and then released to travel to the new
// choice. The two segments are equal, so the pill is pure CSS: nothing is
// measured, and it is right even while the dialog is hidden.
function playWalletMethodSwitch(owner) {
    const from = owner.walletMethodSlideFrom;
    owner.walletMethodSlideFrom = null;
    const root = owner.overlay;
    const bar = root?.querySelector?.('.zkapi-segmented');
    if (!from || !bar?.dataset || bar.dataset.active === from || !motionAllowed(root)) return;
    bar.dataset.from = from;
    void bar.offsetWidth;
    delete bar.dataset.from;
    // Address hydration renders again right away; hold those background
    // renders until the pill lands, or a fresh control would cut it short.
    const view = root.ownerDocument.defaultView;
    const duration = motionDuration(bar, '--tabs-dur', 250);
    if (duration > 0 && owner.handleDisclosureMotion) {
        view.clearTimeout(owner.walletMethodSlideTimer);
        owner.handleDisclosureMotion(true);
        owner.walletMethodSlideTimer = view.setTimeout(() => owner.handleDisclosureMotion(false), duration);
    }
    // What changes with the choice arrives softly instead of cutting in.
    let next = bar.closest?.('.zkapi-wallet-method')?.nextElementSibling;
    for (; next; next = next.nextElementSibling) {
        next.animate?.([{ opacity: 0, transform: 'translateY(4px)', filter: 'blur(2px)' }, { opacity: 1, transform: 'none', filter: 'none' }],
            { duration: 240, easing: EASE_OUT });
    }
}

// The QR fades into the place its placeholder held, once. Later renders of
// the same QR (balance polls) don't replay it.
function revealFundingQr(owner) {
    const root = owner.overlay;
    const qr = root?.querySelector?.('[data-funding-payment-qr] svg');
    const waited = owner.fundingQrPending === true;
    owner.fundingQrPending = Boolean(root?.querySelector?.('[data-funding-qr-placeholder]'));
    if (!qr || !waited || !motionAllowed(root)) return;
    qr.animate?.([{ opacity: 0, transform: 'scale(0.97)', filter: 'blur(2px)' }, { opacity: 1, transform: 'none', filter: 'none' }],
        { duration: 220, easing: EASE_OUT });
}

// USD ⇄ ETH: the arrows make a half turn (the icon lands on itself) while
// the unit swaps in with a slight blur, so the button says what it did.
function playCurrencySwitch(owner) {
    const button = owner.overlay?.querySelector?.('[data-funding-currency]');
    const unit = button?.dataset?.unit;
    const previous = owner.shownCurrencyUnit;
    owner.shownCurrencyUnit = unit ?? previous;
    if (!owner.currencySwitching || !unit || !previous || unit === previous || !motionAllowed(owner.overlay)) return;
    button.querySelector('svg')?.animate?.([{ transform: 'rotate(-180deg)' }, { transform: 'rotate(0deg)' }], { duration: 360, easing: EASE_OUT });
    button.querySelector('.zkapi-funding-currency-unit')?.animate?.([{ opacity: 0, filter: 'blur(2px)', transform: 'translateY(3px)' }, { opacity: 1, filter: 'none', transform: 'none' }],
        { duration: 220, easing: EASE_OUT });
}

// A blocked clipboard leaves the address selected for the keyboard.
function selectAddress(node) {
    if (!node) return;
    node.focus?.();
    if (typeof node.select === 'function') { node.select(); return; }
    try {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = document.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    } catch { /* The address is still focused and fully visible. */ }
}

export function attachWalletMethodControls(owner) {
    const root = owner.overlay;
    attachFundingHelp(owner);
    playWalletMethodSwitch(owner);
    playCurrencySwitch(owner);
    revealFundingQr(owner);
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
        owner.fundingNoticeScope = '';
        owner.clearTransientOutcome?.();
        stopFundingFlow(owner, { preserveAmount: true });
        // The next render starts the pill where it is now (see
        // playWalletMethodSwitch), so it slides across instead of jumping.
        owner.walletMethodSlideFrom = getWalletMethod();
        try { setWalletMethod(button.dataset.walletMethod); }
        catch (error) { owner.fundingError = error.message; }
        owner.rememberRunningModal?.();
        // Render the choice immediately. New address hydration/polling starts
        // afterward and is never part of this click's critical path.
        if (owner.isOpen) owner.render();
    }));
    for (const [name, property] of [['withdrawal-destination', 'fundingDestination'], ['return-destination', 'fundingReturnDestination'], ['return-amount', 'fundingReturnAmount'], ['return-eth-amount', 'fundingReturnEthAmount']]) {
        input(name)?.addEventListener('input', event => { owner[property] = event.target.value; });
    }
    input('amount')?.addEventListener('input', event => {
        // The figure grows with what is typed, like a number, not a field.
        if (event.target?.style) event.target.style.width = `${Math.max(3, String(event.target.value || '').length + 0.5)}ch`;
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
        owner.currencySwitching = true;
        try { await perform(async () => {
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
        }); } finally { owner.currencySwitching = false; }
        if (focusToggle && owner.isOpen && amountFlow(owner) === flow) input('currency')?.focus?.({ preventScroll: true });
    });
    on('next', () => owner.submitAddressDeposit?.());
    on('migrate', () => {
        const password = value('legacy-password');
        return perform(async () => { await addressFundingWallet.migrateLegacy(password); stopFundingFlow(owner); });
    });
    on('copy', async () => {
        try {
            await navigator.clipboard.writeText(addressFundingWallet.address);
            // Said on the button (Copy → ✓ Copied) and to assistive tech.
            owner.addressCopied = true;
            const button = input('copy');
            if (button?.dataset) button.dataset.copied = 'true';
            if (input('copy-status')) input('copy-status').textContent = 'Address copied';
            clearTimeout(owner.addressCopiedTimer);
            owner.addressCopiedTimer = setTimeout(() => {
                owner.addressCopied = false;
                const current = input('copy');
                if (current?.dataset) current.dataset.copied = 'false';
                if (input('copy-status')) input('copy-status').textContent = '';
            }, 1800);
            return;
        } catch {
            selectAddress(input('address'));
            owner.fundingNoticeScope = 'address';
            owner.fundingNotice = 'Copy the selected address with your keyboard.';
        }
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
            owner.fundingNoticeScope = 'pending';
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
    const transfer = asset => {
        const destination = value('return-destination');
        const amount = value(asset === 'eth' ? 'return-eth-amount' : 'return-amount');
        return perform(async () => {
            const to = fundingDestination(destination);
            const units = asset === 'eth' ? (amount.trim() ? fundingEthAmount(amount) : 'max') : fundingAmount(amount);
            if (!globalThis.confirm(`Send ${asset === 'eth' ? (units === 'max' ? 'remaining ETH after reserving network fees (a small balance may remain)' : `${amount} ETH`) : `${amount} ${zkapiClient.billingTokenSymbol || 'USDC'}`} to ${to} on ${zkapiClient.networkName()}?`)) return;
            const release = await prepareWalletMethod();
            try {
                const hash = await addressFundingWallet.withAuthorizedAction({ kind: 'sweep', destination: to, asset, amount: units }, () => asset === 'eth'
                    ? addressFundingWallet.transferEth(to, units) : addressFundingWallet.transferTokens(to, units));
                owner.fundingNoticeScope = 'return';
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
    on('return-token', () => transfer('token'));
    on('return-eth', () => transfer('eth'));
    // Defer hydration until the current render has attached every control.
    queueMicrotask(() => { if (owner.isOpen) ensureDepositAmount(owner); });
}

/** Keep amount quotes and address polling in step with the view when a
 *  render found nothing to redraw. */
export function syncWalletFlows(owner) {
    if (owner.isOpen) ensureDepositAmount(owner);
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
        scroll: root.querySelector('[data-funding-scroll]')?.scrollTop
    };
}

export function restoreWalletView(owner, saved) {
    if (!saved) return;
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
