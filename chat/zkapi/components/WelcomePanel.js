import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { captureFundingSetupView, fundingSetupGuide, restoreFundingSetupView } from './FundingSetupGuide.js';

const DISMISSED_KEY = 'zkapi-oa-welcome-dismissed';
const MODAL_CLASSES = 'rounded-2xl border border-border shadow-lg flex flex-col zkapi-welcome-dialog';

export default class WelcomePanel {
    constructor(app) {
        this.app = app;
        this.overlay = document.getElementById('welcome-panel');
        this.isOpen = false;
        this.step = 'welcome';
        this.busy = false;
        this.status = '';
        this.error = '';
        this.depositAmount = null;
        this.returnFocusEl = null;
        this.escapeHandler = null;
        this.unsubscribe = zkapiClient.subscribe((_snapshot, detail) => {
            if (detail?.reason === 'clock') return;
            if (this.isOpen && zkapiClient.hasNote && !this.busy && this.step !== 'success') {
                this.step = 'success';
                this.render();
            }
        });
    }

    async init() {
        if (!this.overlay) return;
        try {
            await zkapiClient.init();
        } catch {
            // The modal still explains how to reconnect to the daemon.
        }
        if (this.shouldShow()) this.open();
    }

    shouldShow() {
        return !zkapiClient.hasNote
            && localStorage.getItem(DISMISSED_KEY) !== 'true'
            && !new URLSearchParams(window.location.search).has('s');
    }

    open() {
        if (!this.overlay || this.isOpen) return;
        this.isOpen = true;
        this.step = zkapiClient.hasNote ? 'success' : 'welcome';
        this.status = '';
        this.error = '';
        this.returnFocusEl = document.activeElement;
        this.render();
        this.overlay.classList.remove('hidden');
        document.documentElement.removeAttribute('data-welcome-hidden');
        this.overlay.onclick = event => { if (event.target === this.overlay && !this.busy) this.close(); };
        this.escapeHandler = event => { if (event.key === 'Escape' && !this.busy) this.close(); };
        document.addEventListener('keydown', this.escapeHandler);
    }

    close() {
        if (!this.isOpen || this.busy) return;
        this.isOpen = false;
        localStorage.setItem(DISMISSED_KEY, 'true');
        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
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

    setStatus(message) {
        this.status = message;
        const element = this.overlay?.querySelector('[data-welcome-status]');
        if (element) element.textContent = message;
    }

    async fund() {
        if (this.busy) return;
        const amount = this.overlay.querySelector('#welcome-deposit-amount')?.value;
        this.depositAmount = amount;
        this.busy = true;
        this.step = 'redeeming';
        this.status = 'Connecting to MetaMask…';
        this.error = '';
        this.render();
        try {
            await zkapiClient.deposit(amount, message => this.setStatus(message));
            this.step = 'success';
            this.status = '';
            this.render();
        } catch (error) {
            this.step = 'welcome';
            this.error = error?.code === 4001
                ? 'MetaMask canceled the transaction. No funds moved; you can safely try again.'
                : error.shortMessage || error.message || String(error);
            this.render();
        } finally {
            this.busy = false;
        }
    }

    renderWelcome(fundingSetup = null) {
        const suggested = zkapiClient.suggestedDeposit;
        const daemonError = zkapiClient.lastError?.message;
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
                    <p class="text-sm font-medium text-foreground">Private access, funded with MetaMask</p>
                    <p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">OA Chat uses a private prepaid balance for access. Deposit once, then chat normally. Each chat reuses one bounded ephemeral key for its title, response, and follow-ups.</p>
                </div>
                <div class="mt-4">${fundingSetupGuide({ mainnet: zkapiClient.isMainnetFunding, demoMintEnabled: zkapiClient.config?.funding?.demo_mint_enabled, open: fundingSetup?.open })}</div>
                <label class="mt-4 block">
                    <span class="text-xs font-medium text-foreground">Starting balance</span>
                    <div class="mt-1.5 flex h-10 items-center rounded-lg border border-input bg-background px-3 input-focus-clean">
                        <span class="text-sm text-muted-foreground">$</span>
                        <input id="welcome-deposit-amount" class="min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground outline-none" inputmode="decimal" value="${this.escapeHtml(this.depositAmount ?? suggested.toFixed(suggested < 0.01 ? 6 : 2))}" />
                    </div>
                </label>
                ${daemonError ? `<p class="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">Payment service: ${this.escapeHtml(daemonError)}</p>` : ''}
                ${this.error ? `<p class="mt-3 text-xs text-destructive">${this.escapeHtml(this.error)}</p>` : ''}
                <button id="welcome-fund-btn" class="zkapi-primary-button mt-5 w-full" type="button">Continue with MetaMask</button>
                <button id="welcome-skip-btn" class="btn-ghost-hover mt-2 w-full rounded-lg px-3 py-2 text-xs text-muted-foreground hover:text-foreground" type="button">Not now</button>
                <p class="mt-4 text-center text-[10px] leading-relaxed text-muted-foreground/70">The note secret and chat history stay on this device.</p>
            </div>`;
    }

    renderProgress() {
        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}" style="width:420px;max-width:94vw;padding:32px">
                <div class="mx-auto h-8 w-8 rounded-full border-2 border-muted border-t-blue-600 animate-spin"></div>
                <h2 class="mt-5 text-center text-base font-semibold text-foreground">Preparing private access</h2>
                <p data-welcome-status class="mt-2 text-center text-xs leading-relaxed text-muted-foreground">${this.escapeHtml(this.status)}</p>
                <div class="mt-5 h-1 overflow-hidden rounded-full bg-muted"><div class="zkapi-progress-indeterminate h-full rounded-full bg-blue-600"></div></div>
                <p class="mt-4 text-center text-[10px] text-muted-foreground/70">Keep this tab open while MetaMask confirmations are pending.</p>
            </div>`;
    }

    renderSuccess() {
        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}" style="width:420px;max-width:94vw;padding:32px">
                <div class="mx-auto flex h-10 w-10 items-center justify-center rounded-full badge-status-success">
                    <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5"/></svg>
                </div>
                <h2 class="mt-4 text-center text-lg font-semibold text-foreground">You’re ready to chat</h2>
                <p class="mt-2 text-center text-sm text-muted-foreground">Private balance: <strong class="text-foreground">${zkapiClient.formatMoney(zkapiClient.note?.current_balance)}</strong></p>
                <p class="mt-3 text-center text-xs leading-relaxed text-muted-foreground">Everything else works like OA Chat. Payment state is available from <strong>Private balance</strong> in the top-right toolbar.</p>
                <button id="welcome-start-btn" class="zkapi-primary-button mt-6 w-full" type="button">Start chatting</button>
            </div>`;
    }

    render() {
        if (!this.overlay) return;
        const fundingSetup = captureFundingSetupView(this.overlay);
        this.overlay.innerHTML = this.step === 'redeeming'
            ? this.renderProgress()
            : this.step === 'success'
                ? this.renderSuccess()
                : this.renderWelcome(fundingSetup);
        restoreFundingSetupView(this.overlay, fundingSetup);
        this.overlay.querySelector('#welcome-fund-btn')?.addEventListener('click', () => this.fund());
        this.overlay.querySelector('#welcome-skip-btn')?.addEventListener('click', () => this.close());
        this.overlay.querySelector('#welcome-start-btn')?.addEventListener('click', () => {
            this.close();
            setTimeout(() => this.app.elements.messageInput?.focus(), 100);
        });
    }
}
