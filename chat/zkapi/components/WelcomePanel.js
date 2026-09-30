import { attachFundingDisclosures } from './FundingDisclosures.js';
import { showSurface, hideSurface } from '../../ui/uiMotion.js';
import { hasConversationParam } from '../../services/conversationLink.js';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { depositOperationId, isWalletCancellation, resetCanceledDeposit } from '../services/canceledDeposit.mjs';
import { readWelcomeModalIntent, writeWelcomeModalIntent } from '../services/welcomeModalIntent.mjs';
import { attachWalletModalRestoreCancellation, cancelWalletModalRestore, currentWalletModalRestore, finishWalletModalRestore } from './WalletModalView.js';
import { captureFundingSetupView, fundingSetupGuide, restoreFundingSetupView } from './FundingSetupGuide.js';
import { addressFundingWallet } from '../services/addressFundingProvider.mjs';
import { runAddressAction } from '../services/addressFunding.js';
import { isIndexerLag, pendingDepositMessage, zkapiErrorMessage } from '../services/zkapiErrorCopy.mjs';
import { getWalletMethod, initWalletClient, prepareWalletMethod, setWalletMethod, subscribeWalletMethod, walletMethodText } from '../services/walletMethod.mjs';
import { attachWalletMethodControls, captureWalletView, refreshWalletView, renderDepositAmount, prepareDepositAmount, renderFundingAccount, renderWalletMethod, restoreWalletView, stopFundingFlow, isFundingViewHydrating } from './WalletMethodControls.js';

const DISMISSED_KEY = 'zkapi-oa-welcome-dismissed';
const MODAL_CLASSES = 'rounded-2xl border border-border shadow-lg flex flex-col zkapi-welcome-dialog';

export default class WelcomePanel {
    constructor(app) {
        this.app = app;
        this.overlay = document.getElementById('welcome-panel');
        attachWalletModalRestoreCancellation(this);
        const rememberView = () => queueMicrotask(() => this.rememberRunningModal());
        this.overlay?.addEventListener?.('scroll', rememberView, true);
        this.overlay?.addEventListener?.('toggle', rememberView, true);
        this.isOpen = false;
        this.step = 'welcome';
        this.busy = false;
        this.status = '';
        this.error = '';
        this.notice = '';
        this.depositAmount = null;
        this.depositBalanceRefreshPending = false;
        this.confirmedDepositNoteId = null;
        this.fundingDestination = null;
        this.fundingError = '';
        const renderFundingUpdate = () => refreshWalletView(this);
        this.fundingUnsubscribe = addressFundingWallet.subscribe(renderFundingUpdate);
        this.methodUnsubscribe = subscribeWalletMethod(renderFundingUpdate);
        this.returnFocusEl = null;
        this.escapeHandler = null;
        this.unsubscribe = zkapiClient.subscribe((_snapshot, detail) => {
            if (detail?.reason === 'clock') return;
            const wasRefreshing = this.depositBalanceRefreshPending;
            this.syncConfirmedDepositBalance();
            if (this.isOpen && zkapiClient.hasNote && !this.busy && (this.step !== 'success' || (wasRefreshing && !this.depositBalanceRefreshPending))) {
                this.step = 'success';
                this.render();
            }
        });
    }

    async init() {
        if (!this.overlay) return;
        try {
            await initWalletClient();
        } catch {
            // The modal still explains how to reconnect to the daemon.
        }
        if (this.shouldShow()) this.open();
    }

    shouldShow() {
        if (this.app.accountModal?.isOpen || this.app.accountModal?.readRunningModal?.()) return false;
        if (readWelcomeModalIntent()) return true;
        return !zkapiClient.hasNote
            && localStorage.getItem(DISMISSED_KEY) !== 'true'
            && !hasConversationParam(window.location.search);
    }

    open() {
        if (!this.overlay || this.isOpen) return;
        const saved = readWelcomeModalIntent();
        if (['metamask', 'address'].includes(saved?.method)) {
            try { setWalletMethod(saved.method); } catch { /* A saved transaction owns its signer. */ }
        }
        if (getWalletMethod() !== 'address' && typeof saved?.amount === 'string'
            && saved.amount.length <= 50 && /^[\d.]*$/.test(saved.amount)) {
            this.fundingInputAmount = saved.amount;
            this.depositAmount = saved.amount;
            this.fundingInputCurrency = saved.currency === 'eth' ? 'eth' : 'usd';
        }
        if (saved) {
            this.fundingHelpOpen = ['quote', 'receipt'].includes(saved.help) ? saved.help : null;
            this.restoredModalView = { setup: saved.setup === true, method: getWalletMethod(),
                scroll: Number.isFinite(saved.scroll) ? Math.max(0, saved.scroll) : 0 };
        }
        this.isOpen = true;
        this.syncConfirmedDepositBalance();
        this.step = zkapiClient.hasNote || this.depositBalanceRefreshPending ? 'success' : 'welcome';
        if (this.restoredModalView) this.restoredModalView.step = this.step;
        this.status = '';
        this.error = '';
        this.notice = '';
        this.returnFocusEl = document.activeElement;
        this.render();
        showSurface(this.overlay);
        document.documentElement.removeAttribute('data-welcome-hidden');
        this.overlay.onclick = event => { if (event.target === this.overlay && !this.busy) this.close(); };
        this.escapeHandler = event => { if (event.key === 'Escape' && !this.busy) this.close(); };
        document.addEventListener('keydown', this.escapeHandler);
    }

    close() {
        if (!this.isOpen || this.busy) return;
        this.clearTransientOutcome();
        this.isOpen = false;
        cancelWalletModalRestore(this);
        writeWelcomeModalIntent(null);
        stopFundingFlow(this);
        this.disposeFundingDisclosures?.();
        localStorage.setItem(DISMISSED_KEY, 'true');
        hideSurface(this.overlay, { clear: true });
        document.documentElement.setAttribute('data-welcome-hidden', 'true');
        if (this.escapeHandler) document.removeEventListener('keydown', this.escapeHandler);
        this.escapeHandler = null;
        this.returnFocusEl?.focus?.();
        this.returnFocusEl = null;
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    rememberRunningModal() {
        if (!this.isOpen) return;
        const amount = this.fundingInputAmount ?? this.depositAmount;
        const scroll = this.restoredModalView?.scroll ?? this.overlay?.querySelector?.('[data-funding-scroll]')?.scrollTop ?? 0;
        writeWelcomeModalIntent({ open: true, method: getWalletMethod(),
            amount: typeof amount === 'string' && amount.length <= 50 && /^[\d.]*$/.test(amount) ? amount : null,
            currency: this.fundingInputCurrency === 'eth' ? 'eth' : 'usd', help: this.fundingHelpOpen || null,
            setup: this.overlay?.querySelector?.('[data-funding-setup-details]')?.dataset.open === 'true',
            scroll: Number.isFinite(scroll) ? scroll : 0 });
    }

    setStatus(message) {
        this.status = message;
        const element = this.overlay?.querySelector('[data-welcome-status]');
        if (element) element.textContent = walletMethodText(message);
    }

    syncConfirmedDepositBalance() {
        if (this.depositBalanceRefreshPending && zkapiClient.note
            && Number(zkapiClient.note.note_id) === this.confirmedDepositNoteId) {
            this.depositBalanceRefreshPending = false;
            this.confirmedDepositNoteId = null;
        }
    }

    clearTransientOutcome() {
        clearTimeout(this.noticeTimer);
        this.noticeTimer = null;
        this.notice = '';
        this.error = '';
        this.status = '';
    }

    async fund() {
        if (this.busy || this.fundingBusy || this.depositBalanceRefreshPending) return;
        cancelWalletModalRestore(this);
        // The balance dialog owns every durable deposit phase, including a
        // prepared plan that never reached the signer. Never reprice it here.
        if (zkapiClient.config?.pending_deposit) return this.resumeSavedDeposit();
        this.clearTransientOutcome();
        let operationId = depositOperationId();
        const amount = this.overlay.querySelector('[data-funding-amount]')?.value
            ?? this.overlay.querySelector('#welcome-deposit-amount')?.value ?? this.fundingInputAmount;
        this.depositAmount = amount;
        let selectedDeposit = amount;
        if (getWalletMethod() !== 'address' && zkapiClient.isNativeEthFunding) {
            if (this.fundingInputAmount !== amount) {
                this.depositAmountFlow?.invalidate();
                this.sharedDepositIntent = null;
                this.fundingInputAmount = amount;
            }
            this.fundingBusy = true;
            this.render();
            try { selectedDeposit = await prepareDepositAmount(this); }
            catch (error) { this.error = error.message; return; }
            finally { this.fundingBusy = false; if (this.isOpen) this.render(); }
        }
        this.busy = true;
        this.step = 'redeeming';
        this.status = 'Connecting to MetaMask…';
        this.error = '';
        this.notice = '';
        this.render();
        let releaseWalletMethod;
        try {
            releaseWalletMethod = await prepareWalletMethod();
            const report = message => {
                operationId = depositOperationId() || operationId;
                this.setStatus(message);
            };
            const flow = this.fundingFlow;
            const action = async () => {
                const deposit = getWalletMethod() === 'address' ? this.fundingDepositIntent.ethAmount
                    : selectedDeposit;
                const result = getWalletMethod() === 'address'
                    ? await zkapiClient.deposit(deposit, report,
                        { preparedOperationId: this.fundingDepositIntent.preparedOperationId })
                    : await zkapiClient.deposit(deposit, report);
                this.depositBalanceRefreshPending = result?.balanceRefreshPending === true;
                this.confirmedDepositNoteId = this.depositBalanceRefreshPending ? Number(result.noteId) : null;
                this.syncConfirmedDepositBalance();
                if (this.depositBalanceRefreshPending) this.app.accountModal.recordDepositConfirmation?.(result);
                if (flow) await flow.complete();
                stopFundingFlow(this);
                this.fundingUsdAmount = null;
                this.fundingInputAmount = null;
                this.fundingInputCurrency = null;
            };
            if (getWalletMethod() === 'address') await runAddressAction(this, { kind: 'deposit', phase: 'wallet' }, report, action);
            else await action();
            this.step = 'success';
            this.status = '';
            this.render();
        } catch (error) {
            this.step = 'welcome';
            const rejected = isWalletCancellation(error) && !error?.transactionHash && error?.broadcastPossible !== true;
            if (rejected && getWalletMethod() === 'metamask') {
                try {
                    if (await resetCanceledDeposit(error, operationId)) {
                        stopFundingFlow(this);
                        this.depositAmount = null;
                        this.fundingNotice = '';
                        this.fundingError = '';
                    }
                } catch { /* Keep saved recovery if local cleanup fails. */ }
            }
            const pending = pendingDepositMessage(error, zkapiClient.config?.pending_deposit);
            this.notice = pending || (rejected ? 'Deposit canceled.' : isIndexerLag(error) ? zkapiErrorMessage(error) : '');
            if (error?.code === 'address_wait_stopped') this.fundingNotice = error.message;
            this.error = this.notice || error?.code === 'address_wait_stopped' ? '' : error.shortMessage || error.message || String(error);
            if (rejected) {
                const notice = this.notice;
                this.noticeTimer = setTimeout(() => {
                    if (this.notice !== notice) return;
                    this.notice = '';
                    if (this.isOpen && !this.busy) this.render();
                }, 7000);
                this.noticeTimer?.unref?.();
            }
            this.render();
        } finally {
            releaseWalletMethod?.();
            this.busy = false;
            this.render();
        }
    }

    async submitAddressDeposit() { return this.fund(); }

    resumeSavedDeposit() {
        if (this.busy || this.fundingBusy) return;
        this.close();
        this.app.accountModal.openFunding();
    }

    renderWelcome(fundingSetup = null) {
        const suggested = zkapiClient.suggestedDeposit;
        const daemonError = zkapiClient.lastError?.message;
        const pendingDeposit = zkapiClient.config?.pending_deposit;
        return `
            <div data-funding-scroll role="dialog" aria-modal="true" aria-labelledby="welcome-title" class="${MODAL_CLASSES}" style="width:464px;max-width:94vw;padding:28px">
                <div class="text-center">
                    <div class="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background shadow-sm">
                        <svg class="h-5 w-5 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 0h10.5A2.25 2.25 0 0 1 19.5 12.75v6A2.25 2.25 0 0 1 17.25 21H6.75a2.25 2.25 0 0 1-2.25-2.25v-6a2.25 2.25 0 0 1 2.25-2.25Z"/></svg>
                    </div>
                    <h2 id="welcome-title" class="mt-4 text-lg font-semibold text-foreground">Welcome to oa-chat!</h2>
                    <p class="mt-1 text-xs text-muted-foreground">by <a class="underline underline-offset-2 hover:text-foreground" href="https://openanonymity.ai/" target="_blank" rel="noopener noreferrer">The Open Anonymity Project</a></p>
                </div>
                <div class="mt-6 rounded-xl border border-border bg-muted/20 p-4">
                    <p class="text-sm font-medium text-foreground">Private access, funded with your wallet</p>
                    <p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">OA Chat uses a private prepaid balance for access. Deposit once, then chat normally. Each chat reuses one bounded ephemeral key for its title, response, and follow-ups.</p>
                </div>
                ${renderDepositAmount(this)}
                ${renderWalletMethod(this, { scope: 'welcome' })}
                ${renderFundingAccount(this)}
                ${getWalletMethod() === 'address' ? '' : `<div class="mt-4">${fundingSetupGuide({ mainnet: zkapiClient.isMainnetFunding, demoMintEnabled: zkapiClient.config?.funding?.demo_mint_enabled, nativeEth: zkapiClient.isNativeEthFunding, open: fundingSetup?.open, scope: 'welcome' })}</div>`}
                ${pendingDeposit ? `<p class="mt-4 text-sm text-foreground">Saved deposit: ${this.escapeHtml(zkapiClient.formatMoney(pendingDeposit.amount))}</p><p class="mt-1 text-xs text-muted-foreground">Your original amount and progress are saved. Continue to check or resume this deposit.</p>` : getWalletMethod() === 'address' || zkapiClient.isNativeEthFunding ? '' : `<label class="mt-4 block">
                    <span class="text-xs font-medium text-foreground">Starting balance</span>
                    <div class="mt-1.5 flex h-10 items-center rounded-lg border border-input bg-background px-3 input-focus-clean">
                        <span class="text-sm text-muted-foreground">$</span>
                        <input id="welcome-deposit-amount" class="min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground outline-none" inputmode="decimal" value="${this.escapeHtml(this.depositAmount ?? suggested.toFixed(suggested < 0.01 ? 6 : 2))}" />
                    </div>
                </label>`}
                ${daemonError ? `<p class="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">Payment service: ${this.escapeHtml(daemonError)}</p>` : ''}
                ${this.error ? `<p class="mt-3 text-xs text-destructive">${this.escapeHtml(walletMethodText(this.error))}</p>` : ''}
                ${this.notice ? `<p class="mt-3 text-xs text-muted-foreground" role="status">${this.escapeHtml(walletMethodText(this.notice))}</p>` : ''}
                ${pendingDeposit ? '<button id="welcome-resume-deposit-btn" class="zkapi-primary-button mt-5 w-full" type="button">Continue saved deposit</button>' : getWalletMethod() === 'address' ? '' : `<button id="welcome-fund-btn" class="zkapi-primary-button mt-5 w-full" type="button" ${addressFundingWallet.pending ? 'disabled' : ''}>${walletMethodText('Continue with MetaMask')}</button>`}
                <button id="welcome-skip-btn" class="btn-ghost-hover mt-2 w-full rounded-lg px-3 py-2 text-xs text-muted-foreground hover:text-foreground" type="button">Not now</button>
                <p class="mt-4 text-center text-[10px] leading-relaxed text-muted-foreground/70">The note secret and chat history stay on this device.</p>
            </div>`;
    }

    renderProgress() {
        return `
            <div data-funding-scroll role="dialog" aria-modal="true" class="${MODAL_CLASSES}" style="width:464px;max-width:94vw;padding:32px;overflow:auto;max-height:90vh">
                <div class="mx-auto h-8 w-8 rounded-full border-2 border-muted border-t-blue-600 animate-spin"></div>
                <h2 class="mt-5 text-center text-base font-semibold text-foreground">Preparing private access</h2>
                <p data-welcome-status class="mt-2 text-center text-xs leading-relaxed text-muted-foreground">${this.escapeHtml(walletMethodText(this.status))}</p>
                ${renderFundingAccount(this)}
                <div class="mt-5 h-1 overflow-hidden rounded-full bg-muted"><div class="zkapi-progress-indeterminate h-full rounded-full bg-blue-600"></div></div>
                <p class="mt-4 text-center text-[10px] text-muted-foreground/70">${getWalletMethod() === 'address' ? 'Your funding transactions are saved in this browser.' : 'Keep this tab open while MetaMask confirmations are pending.'}</p>
            </div>`;
    }

    renderSuccess() {
        this.syncConfirmedDepositBalance();
        const refreshing = this.depositBalanceRefreshPending;
        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}" style="width:420px;max-width:94vw;padding:32px">
                <div class="mx-auto flex h-10 w-10 items-center justify-center rounded-full badge-status-success">
                    <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5"/></svg>
                </div>
                <h2 class="mt-4 text-center text-lg font-semibold text-foreground">${refreshing ? 'Deposit confirmed' : 'You’re ready to chat'}</h2>
                ${refreshing ? '<p class="mt-2 text-center text-sm text-muted-foreground" role="status">Refreshing your private balance…</p>' : `<p class="mt-2 text-center text-sm text-muted-foreground">Private balance: <strong class="text-foreground">${zkapiClient.formatMoney(zkapiClient.note?.current_balance)}</strong></p>`}
                <p class="mt-3 text-center text-xs leading-relaxed text-muted-foreground">${refreshing ? 'Your deposit is saved in this browser. Check its balance from <strong>Private balance</strong> in the top-right toolbar.' : 'Everything else works like OA Chat. Payment state is available from <strong>Private balance</strong> in the top-right toolbar.'}</p>
                <button id="welcome-start-btn" class="zkapi-primary-button mt-6 w-full" type="button">${refreshing ? 'Done' : 'Start chatting'}</button>
            </div>`;
    }

    render() {
        if (!this.overlay) return;
        this.disposeFundingDisclosures?.();
        const restored = currentWalletModalRestore(this, getWalletMethod());
        const walletView = restored ? { scroll: restored.scroll } : captureWalletView(this);
        const fundingSetup = restored ? { open: restored.setup, scrollTop: restored.scroll } : captureFundingSetupView(this.overlay);
        this.overlay.innerHTML = this.step === 'redeeming'
            ? this.renderProgress()
            : this.step === 'success'
                ? this.renderSuccess()
                : this.renderWelcome(fundingSetup);
        this.disposeFundingDisclosures = attachFundingDisclosures(this.overlay, () => this.rememberRunningModal());
        restoreFundingSetupView(this.overlay, fundingSetup);
        attachWalletMethodControls(this);
        restoreWalletView(this, walletView);
        finishWalletModalRestore(this, { hydrating: isFundingViewHydrating(this), method: getWalletMethod() });
        this.rememberRunningModal();
        this.overlay.querySelector('#welcome-deposit-amount')?.addEventListener('input', event => {
            this.depositAmount = event.target.value;
            this.rememberRunningModal();
        });
        this.overlay.querySelector('#welcome-fund-btn')?.addEventListener('click', () => this.fund());
        this.overlay.querySelector('#welcome-resume-deposit-btn')?.addEventListener('click', () => this.resumeSavedDeposit());
        this.overlay.querySelector('#welcome-skip-btn')?.addEventListener('click', () => this.close());
        this.overlay.querySelector('#welcome-start-btn')?.addEventListener('click', () => {
            this.close();
            setTimeout(() => this.app.elements.messageInput?.focus(), 100);
        });
    }
}
