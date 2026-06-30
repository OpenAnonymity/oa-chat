// zkAPI panel — the client-side inspection + funding surface for oa-chat.
//
// A self-mounting right-side drawer (toggled by a floating button) that shows:
//   - the wallet: balance in credits + USD, note id, expiry, status
//   - billing-mode selector (pass-through / ephemeral) with privacy blurbs
//   - MetaMask funding (deposit credits on-chain), ported from the funding page
//   - a live ledger of every zkAPI request with FULL inspection (proof,
//     nullifier, anchor, commitments, usage, charge), long hashes shortened by
//     default and toggleable to full.
//
// It reuses oa-chat's Tailwind design tokens (bg-card, text-foreground,
// border-border, badges, etc.) so it looks like part of the product.

import zkapiClient from '../services/zkapi/zkapiClient.js';
import zkapiLedger from '../services/zkapi/zkapiLedger.js';
import zkApiBackend, { resetEphemeralKey, getEphemeralStatus, onEphemeralChange } from '../services/inference/backends/zkApiBackend.js';
import { describeField } from '../services/zkapi/zkapiGlossary.js';
import {
    BILLING_MODES,
    getBillingMode,
    setBillingMode,
    setCreditsPerUsd,
    getCreditsPerUsd,
    creditsToUsd,
    formatUsd,
    formatCredits,
    formatCreditsUsd,
    shortenHash
} from '../services/zkapi/zkapiConfig.js';

const ETHERS_CDN = 'https://cdn.jsdelivr.net/npm/ethers@6.13.2/dist/ethers.umd.min.js';
// 15-field WithdrawalPublicInputs tuple (matches Types.WithdrawalPublicInputs).
const WD_TUPLE = '(uint8,uint16,uint64,address,uint256,uint32,uint128,address,uint256,bool,bool,uint32,uint256,uint32,uint256)';
const VAULT_ABI = [
    'function deposit(bytes32 commitment, uint128 amount, uint256[32] siblings)',
    'function currentRoot() view returns (uint256)',
    `function mutualClose(${WD_TUPLE} inputs, bytes proof, uint256[32] siblings)`,
    `function initiateEscapeWithdrawal(${WD_TUPLE} inputs, bytes proof, uint256[32] siblings)`,
    'function finalizeEscapeWithdrawal(uint32 noteId)',
    'event NoteDeposited(uint32 indexed noteId, bytes32 indexed commitment, uint128 amount, uint64 expiryTs, uint256 newRoot)'
];
const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)'
];
const CHALLENGE_PERIOD_SECONDS = 24 * 60 * 60;
const PENDING_ESCAPE_KEY = 'zkapi-pending-escape';

let ethersPromise = null;
function loadEthers() {
    if (window.ethers) return Promise.resolve(window.ethers);
    if (ethersPromise) return ethersPromise;
    ethersPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = ETHERS_CDN;
        s.onload = () => resolve(window.ethers);
        s.onerror = () => reject(new Error('Failed to load ethers.js (needed for MetaMask deposit).'));
        document.head.appendChild(s);
    });
    return ethersPromise;
}

function toBytes32(felt) {
    return '0x' + String(felt).replace(/^0x/, '').padStart(64, '0');
}

function fmtDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A long hash rendered short, click to toggle full, with a copy button.
function hashEl(value) {
    if (value === null || value === undefined || value === '') return '<span class="text-muted-foreground">—</span>';
    const full = esc(value);
    const short = esc(shortenHash(value));
    return `<span class="zk-hash inline-flex items-center gap-1">
        <span class="zk-hash-val font-mono text-[11px] cursor-pointer hover:text-foreground" data-full="${full}" data-short="${short}" data-expanded="0" title="Click to toggle full value">${short}</span>
        <button class="zk-copy text-muted-foreground hover:text-foreground" data-copy="${full}" title="Copy" aria-label="Copy">⧉</button>
    </span>`;
}

// A detail row. Pass `infoKey` to attach a click-to-expand "?" that reveals the
// glossary explanation for that field (hidden by default).
function row(label, valueHtml, infoKey) {
    const g = infoKey ? describeField(infoKey) : null;
    const btn = g
        ? `<button class="zk-info" data-info aria-label="What is this?" title="What is this?">?</button>`
        : '';
    const desc = g
        ? `<div class="zk-info-desc hidden text-[10px] text-muted-foreground leading-relaxed bg-muted/40 border border-border/60 rounded p-2 mt-1 mb-1">
               <span class="font-semibold text-foreground">${esc(g.title)}.</span> ${esc(g.desc)}
           </div>`
        : '';
    return `<div class="zk-row flex items-start justify-between gap-3 py-1 border-b border-border/40 last:border-0">
        <span class="text-[11px] text-muted-foreground shrink-0 inline-flex items-center gap-1">${esc(label)}${btn}</span>
        <span class="text-[11px] text-right break-all">${valueHtml}</span>
    </div>${desc}`;
}

// Mode is signalled by a small colored dot inside a neutral pill (Linear-style),
// not a loud filled badge.
const MODE_DOT = {
    passthrough: '#3b82f6',
    ephemeral: '#8b5cf6'
};
const KIND_LABEL = {
    inference: 'inference',
    ephemeral_issue: 'key issued',
    ephemeral_settle: 'settled',
    direct_stream: 'stream'
};

/** Drop a trailing -YYYY-MM-DD model-version suffix for a clean display name
 *  (e.g. "gpt-4o-mini-2024-07-18" -> "gpt-4o-mini"). */
function prettyModel(m) {
    return m ? String(m).replace(/-\d{4}-\d{2}-\d{2}$/, '') : '';
}

class ZkapiPanel {
    constructor() {
        this.open = false;
        this.config = null;
        this.wallet = null;
        this.expanded = new Set();
        this.depositBusy = false;
        this.withdrawBusy = false;
        this.tokenDecimals = 6; // demo token; refined from chain on connect
        this.mount();
        zkapiLedger.subscribe(evt => this.onLedgerEvent(evt));
        this.refresh();
        // Periodic wallet refresh while open.
        setInterval(() => { if (this.open) this.refreshWallet(); }, 5000);
        // Tick the escape-withdrawal + ephemeral-key countdowns every second.
        setInterval(() => {
            if (!this.open) return;
            if (this.getPendingEscape()) this.renderWithdraw();
            if (getEphemeralStatus()) this.renderEphemeral();
        }, 1000);
        // Re-render the ephemeral card immediately on issue/usage/settle.
        onEphemeralChange(() => { if (this.open) this.renderEphemeral(); });
    }

    mount() {
        const style = document.createElement('style');
        style.textContent = `
            #zkapi-fab{position:fixed;right:16px;bottom:16px;z-index:60;width:52px;height:52px;border-radius:9999px;
                display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;cursor:pointer;
                background:hsl(var(--color-primary));color:hsl(var(--color-primary-foreground));box-shadow:0 6px 20px rgba(0,0,0,.25);
                border:1px solid hsl(var(--color-border));transition:transform .15s ease;}
            #zkapi-fab:hover{transform:translateY(-2px);}
            #zkapi-fab .dot{position:absolute;top:-2px;right:-2px;width:14px;height:14px;border-radius:9999px;background:#498966;border:2px solid hsl(var(--color-background));}
            #zkapi-fab .dot.off{background:#ef4444;}
            #zkapi-drawer{position:fixed;top:0;right:0;height:100vh;width:400px;max-width:92vw;z-index:61;
                background:hsl(var(--color-background));border-left:1px solid hsl(var(--color-border));
                transform:translateX(102%);transition:transform .2s ease;display:flex;flex-direction:column;}
            #zkapi-drawer.open{transform:translateX(0);}
            #zkapi-drawer .zk-scroll{overflow-y:auto;flex:1;}
            .zk-seg{display:flex;border:1px solid hsl(var(--color-border));border-radius:8px;overflow:hidden;}
            .zk-seg button{flex:1;padding:6px 8px;font-size:12px;background:transparent;color:hsl(var(--color-muted-foreground));cursor:pointer;border:0;}
            .zk-seg button.active{background:hsl(var(--color-primary));color:hsl(var(--color-primary-foreground));}
            .zk-card{border:1px solid hsl(var(--color-border));border-radius:12px;transition:border-color .14s ease,background .14s ease;}
            .zk-entry{cursor:pointer;}
            .zk-entry:hover{background:hsl(var(--color-muted) / 0.45);border-color:hsl(var(--color-border));}
            .zk-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:9999px;
                font-size:10px;font-weight:500;line-height:1.45;letter-spacing:.02em;white-space:nowrap;
                background:hsl(var(--color-muted) / 0.7);color:hsl(var(--color-foreground));
                border:1px solid hsl(var(--color-border) / 0.55);}
            .zk-dot{width:6px;height:6px;border-radius:9999px;flex:none;}
            .zk-chev{color:hsl(var(--color-muted-foreground));font-size:9px;line-height:1;display:inline-block;
                flex:none;opacity:.55;transition:transform .15s ease;}
            .zk-chev--open{transform:rotate(90deg);}
            .zk-info{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;
                border-radius:9999px;border:1px solid hsl(var(--color-border));background:transparent;
                color:hsl(var(--color-muted-foreground));font-size:9px;line-height:1;font-weight:700;cursor:pointer;
                flex:none;padding:0;transition:background .12s ease,color .12s ease;}
            .zk-info:hover{background:hsl(var(--color-primary));color:hsl(var(--color-primary-foreground));border-color:transparent;}
            .zk-info--active{background:hsl(var(--color-primary));color:hsl(var(--color-primary-foreground));border-color:transparent;}
        `;
        document.head.appendChild(style);

        this.fab = document.createElement('button');
        this.fab.id = 'zkapi-fab';
        this.fab.innerHTML = `zk<span class="dot off" id="zkapi-fab-dot"></span>`;
        this.fab.title = 'zkAPI wallet & request inspector';
        this.fab.addEventListener('click', () => this.toggle());
        document.body.appendChild(this.fab);

        this.drawer = document.createElement('aside');
        this.drawer.id = 'zkapi-drawer';
        this.drawer.className = 'text-foreground';
        document.body.appendChild(this.drawer);

        this.drawer.addEventListener('click', e => this.handleClick(e));
        this.drawer.addEventListener('input', e => this.handleInput(e));
        this.render();
    }

    handleInput(e) {
        if (e.target.closest('#zkapi-deposit-usd')) {
            const preview = this.drawer.querySelector('#zkapi-deposit-preview');
            if (preview) preview.textContent = this.depositPreview();
        }
    }

    // --- pending-escape persistence (survives reloads) ---
    getPendingEscape() {
        try { return JSON.parse(localStorage.getItem(PENDING_ESCAPE_KEY) || 'null'); } catch (_) { return null; }
    }
    setPendingEscape(p) {
        try { localStorage.setItem(PENDING_ESCAPE_KEY, JSON.stringify(p)); } catch (_) { /* ignore */ }
    }
    clearPendingEscape() {
        try { localStorage.removeItem(PENDING_ESCAPE_KEY); } catch (_) { /* ignore */ }
    }

    toggle() {
        this.open = !this.open;
        this.drawer.classList.toggle('open', this.open);
        if (this.open) this.refresh();
    }

    async refresh() {
        await Promise.all([this.refreshConfig(), this.refreshWallet()]);
        this.render();
    }

    async refreshConfig() {
        try {
            this.config = await zkapiClient.getConfig();
            zkapiLedger.setConfig(this.config);
            if (this.config?.credits_per_usd) setCreditsPerUsd(this.config.credits_per_usd);
        } catch (err) {
            this.config = null;
        }
    }

    async refreshWallet() {
        try {
            const status = await zkapiClient.getWalletStatus();
            this.wallet = status?.note || null;
            zkapiLedger.setWallet(this.wallet);
            this.updateFabDot(true);
        } catch (err) {
            this.wallet = null;
            this.updateFabDot(false);
        }
        if (this.open) this.renderWallet();
    }

    updateFabDot(connected) {
        const dot = document.getElementById('zkapi-fab-dot');
        if (dot) dot.classList.toggle('off', !connected || !this.wallet);
    }

    onLedgerEvent(evt) {
        if (evt.type === 'wallet') { this.wallet = evt.note; this.renderWallet(); }
        if (evt.type === 'entry' || evt.type === 'clear') this.renderLedger();
    }

    handleClick(e) {
        // Click-to-expand field explanation ("?"). Toggle the glossary blurb for
        // this field; works for detail rows (desc is the row's next sibling) and
        // the ephemeral card (desc lives inside the same card).
        const infoBtn = e.target.closest('.zk-info');
        if (infoBtn) {
            e.preventDefault();
            e.stopPropagation();
            const rowEl = infoBtn.closest('.zk-row');
            let desc = null;
            if (rowEl && rowEl.nextElementSibling && rowEl.nextElementSibling.classList.contains('zk-info-desc')) {
                desc = rowEl.nextElementSibling;
            } else {
                const card = infoBtn.closest('.zk-card');
                desc = card ? card.querySelector('.zk-info-desc') : null;
            }
            if (desc) {
                desc.classList.toggle('hidden');
                infoBtn.classList.toggle('zk-info--active', !desc.classList.contains('hidden'));
            }
            return;
        }
        const hashVal = e.target.closest('.zk-hash-val');
        if (hashVal) {
            const expanded = hashVal.dataset.expanded === '1';
            hashVal.textContent = expanded ? hashVal.dataset.short : hashVal.dataset.full;
            hashVal.dataset.expanded = expanded ? '0' : '1';
            return;
        }
        const copyBtn = e.target.closest('.zk-copy');
        if (copyBtn) {
            navigator.clipboard?.writeText(copyBtn.dataset.copy).then(() => {
                copyBtn.textContent = '✓';
                setTimeout(() => { copyBtn.textContent = '⧉'; }, 1000);
            }).catch(() => {});
            return;
        }
        const entryHead = e.target.closest('[data-entry]');
        if (entryHead) {
            const id = entryHead.dataset.entry;
            if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
            this.renderLedger();
            return;
        }
        const modeBtn = e.target.closest('[data-mode]');
        if (modeBtn) {
            setBillingMode(modeBtn.dataset.mode);
            resetEphemeralKey();
            this.renderModeAndInfo();
            return;
        }
        if (e.target.closest('#zkapi-close')) { this.toggle(); return; }
        if (e.target.closest('#zkapi-refresh')) { this.refresh(); return; }
        if (e.target.closest('#zkapi-clear')) { zkapiLedger.clear(); return; }
        if (e.target.closest('#zkapi-deposit-btn')) { this.handleDeposit(); return; }
        if (e.target.closest('#zkapi-withdraw-mutual-btn')) { this.handleWithdrawMutual(); return; }
        if (e.target.closest('#zkapi-withdraw-escape-btn')) { this.handleEscapeInitiate(); return; }
        if (e.target.closest('#zkapi-escape-finalize-btn')) { this.handleEscapeFinalize(); return; }
        if (e.target.closest('#zkapi-escape-cancel-btn')) { this.clearPendingEscape(); this.renderWithdraw(); return; }
    }

    render() {
        this.drawer.innerHTML = `
            <div class="flex items-center justify-between px-4 py-3 border-b border-border" style="min-height:calc(3rem + 1px)">
                <div class="flex items-center gap-2">
                    <span class="font-semibold text-sm">zkAPI</span>
                    <span class="text-[10px] leading-none px-2 py-1 rounded-md bg-muted text-muted-foreground">unlinkable inference + payment</span>
                </div>
                <button id="zkapi-close" class="text-muted-foreground hover:text-foreground" aria-label="Close">✕</button>
            </div>
            <div class="zk-scroll px-4 py-3 space-y-4">
                <div id="zkapi-wallet"></div>
                <div id="zkapi-deposit"></div>
                <div id="zkapi-withdraw"></div>
                <div id="zkapi-mode"></div>
                <div id="zkapi-ephemeral"></div>
                <div id="zkapi-ledger-wrap">
                    <div class="flex items-center justify-between mb-2">
                        <span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Request inspector</span>
                        <div class="flex items-center gap-2">
                            <button id="zkapi-refresh" class="text-[11px] text-muted-foreground hover:text-foreground">Refresh</button>
                            <button id="zkapi-clear" class="text-[11px] text-muted-foreground hover:text-foreground">Clear</button>
                        </div>
                    </div>
                    <div id="zkapi-ledger" class="space-y-2"></div>
                </div>
            </div>`;
        this.renderWallet();
        this.renderDeposit();
        this.renderWithdraw();
        this.renderModeAndInfo();
        this.renderEphemeral();
        this.renderLedger();
    }

    /**
     * Mode-2 ephemeral-key status card: shows the active short-lived key, a live
     * expiry countdown, and the usage accumulated so far (settled in one shot
     * when the key expires). Hidden when there's no active key.
     */
    renderEphemeral() {
        const el = this.drawer.querySelector('#zkapi-ephemeral');
        if (!el) return;
        const s = getEphemeralStatus();
        if (!s) { el.innerHTML = ''; return; }
        const remainMs = Math.max(0, s.expiresAtMs - Date.now());
        const secs = Math.ceil(remainMs / 1000);
        const usd = s.accumCostUsd || 0;
        const credits = Math.max(0, Math.ceil(usd * getCreditsPerUsd()));
        const pct = s.ttlSeconds ? Math.max(0, Math.min(100, (remainMs / (s.ttlSeconds * 1000)) * 100)) : 0;
        const expiring = secs <= 10;
        const g = describeField('ephemeral_key');
        el.innerHTML = `
            <div class="zk-card p-3 space-y-2">
                <div class="flex items-center justify-between">
                    <span class="text-xs font-medium inline-flex items-center gap-1">
                        Ephemeral key
                        <button class="zk-info" data-info data-info-key="ephemeral_key" aria-label="What is this?" title="What is this?">?</button>
                    </span>
                    <span class="text-[11px] ${expiring ? 'text-red-500' : 'text-status-success'} tabular-nums">
                        ${secs > 0 ? `expires in ${secs}s` : 'expired — settling…'}
                    </span>
                </div>
                <div class="h-1 rounded bg-muted overflow-hidden">
                    <div class="h-full ${expiring ? 'bg-red-500' : 'bg-primary'}" style="width:${pct}%;transition:width .5s linear"></div>
                </div>
                <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <div>${s.requestCount} request${s.requestCount === 1 ? '' : 's'} on this key</div>
                    <div class="text-right">accrued ${formatCredits(credits)} cr · ${formatUsd(usd)}</div>
                    <div class="col-span-2">key ${hashEl(s.keyHash)}</div>
                </div>
                <div class="zk-info-desc hidden text-[10px] text-muted-foreground leading-relaxed bg-muted/40 border border-border/60 rounded p-2">
                    <span class="font-semibold text-foreground">${esc(g.title)}.</span> ${esc(g.desc)}
                </div>
            </div>`;
    }

    renderWallet() {
        const el = this.drawer.querySelector('#zkapi-wallet');
        if (!el) return;
        if (!this.config && !this.wallet) {
            el.innerHTML = `<div class="zk-card p-4 text-sm text-muted-foreground">
                Cannot reach the zkAPI client daemon at <span class="font-mono text-[11px]">${esc(zkapiClient.base)}</span>.
                Start the integrated stack, then click Refresh.</div>`;
            return;
        }
        const note = this.wallet;
        const bal = note?.current_balance ?? 0;
        const dep = note?.deposit_amount ?? 0;
        const connected = !!note;
        const expiry = note?.expiry_ts ? new Date(note.expiry_ts * 1000).toLocaleString() : '—';
        el.innerHTML = `
            <div class="zk-card p-4">
                <div class="flex items-center justify-between mb-1">
                    <span class="text-xs text-muted-foreground">Balance</span>
                    <span class="inline-flex items-center gap-1 text-[11px] ${connected ? 'text-status-success' : 'text-red-500'}">
                        <span class="breathing-dot ${connected ? 'status-active' : 'status-inactive'}" style="width:8px;height:8px;display:inline-block;border-radius:9999px;background:${connected ? '#498966' : '#ef4444'}"></span>
                        ${connected ? 'Funded note' : 'No active note'}
                    </span>
                </div>
                <div class="text-2xl font-semibold tabular-nums">${formatUsd(creditsToUsd(bal))} <span class="text-sm font-normal text-muted-foreground">≈ ${this.creditsToTokens(bal).toLocaleString('en-US', { maximumFractionDigits: 2 })} ZKAPI</span></div>
                <div class="text-xs text-muted-foreground mb-2">${formatCredits(bal)} credits · deposited ${formatUsd(creditsToUsd(dep))} (1 ZKAPI = $1)</div>
                ${note ? `<div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <div>Note #${esc(note.note_id)}</div>
                    <div>${note.is_genesis ? 'genesis' : 'active chain'}</div>
                    <div class="col-span-2">expires ${esc(expiry)}</div>
                </div>` : ''}
            </div>`;
    }

    /** Credits for a USD amount (1 credit = 1 micro-USD). */
    usdToCredits(usd) {
        return Math.max(0, Math.round((Number(usd) || 0) * getCreditsPerUsd()));
    }

    /** How many whole ZKAPI tokens MetaMask will move for `credits` base units. */
    creditsToTokens(credits) {
        const dec = this.tokenDecimals ?? 6;
        return (Number(credits) || 0) / Math.pow(10, dec);
    }

    depositPreview() {
        const usd = Number(this.drawer.querySelector('#zkapi-deposit-usd')?.value || 0);
        const credits = this.usdToCredits(usd);
        const tokens = this.creditsToTokens(credits);
        return `${formatUsd(usd)} = ${tokens.toLocaleString('en-US', { maximumFractionDigits: 6 })} ZKAPI · ${formatCredits(credits)} credits`;
    }

    renderDeposit() {
        const el = this.drawer.querySelector('#zkapi-deposit');
        if (!el) return;
        el.innerHTML = `
            <details class="zk-card p-3" ${this.wallet ? '' : 'open'}>
                <summary class="text-xs font-medium cursor-pointer">💳 Fund wallet via MetaMask</summary>
                <div class="mt-3 space-y-2">
                    <label class="text-[11px] text-muted-foreground">Deposit amount (USD)</label>
                    <div class="flex items-center gap-2">
                        <span class="text-sm text-muted-foreground">$</span>
                        <input id="zkapi-deposit-usd" type="number" value="5" min="0" step="0.01"
                            class="w-full px-2 py-1.5 text-sm rounded-md border border-border bg-background"/>
                    </div>
                    <div id="zkapi-deposit-preview" class="text-[11px] text-muted-foreground">${this.depositPreview()}</div>
                    <button id="zkapi-deposit-btn" class="w-full px-3 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
                        Deposit with MetaMask
                    </button>
                    <div id="zkapi-deposit-status" class="text-[11px] text-muted-foreground"></div>
                </div>
            </details>`;
    }

    renderWithdraw() {
        const el = this.drawer.querySelector('#zkapi-withdraw');
        if (!el) return;
        const pending = this.getPendingEscape();
        if (!this.wallet && !pending) { el.innerHTML = ''; return; }
        const bal = this.wallet?.current_balance ?? 0;

        // An escape-in-progress takes over the section until finalized.
        if (pending) {
            const now = Math.floor(Date.now() / 1000);
            const ready = now >= pending.deadline;
            const remaining = Math.max(0, pending.deadline - now);
            el.innerHTML = `
                <div class="zk-card p-3 space-y-2">
                    <div class="text-xs font-medium">⏳ Escape withdrawal in progress</div>
                    <div class="text-[11px] text-muted-foreground">Note #${esc(pending.noteId)} · ${formatCreditsUsd(pending.finalBalance)} to ${esc(shortenHash(pending.destination))}</div>
                    <div class="text-[11px] ${ready ? 'text-status-success' : 'text-muted-foreground'}">
                        ${ready ? 'Challenge window elapsed — ready to finalize.' : `Finalize available in ${fmtDuration(remaining)} (24h challenge window).`}
                    </div>
                    <button id="zkapi-escape-finalize-btn" ${ready ? '' : 'disabled'}
                        class="w-full px-3 py-2 text-sm rounded-md ${ready ? 'bg-primary text-primary-foreground hover:opacity-90' : 'bg-muted text-muted-foreground cursor-not-allowed'}">
                        Finalize escape withdrawal
                    </button>
                    <button id="zkapi-escape-cancel-btn" class="w-full text-[11px] text-muted-foreground hover:text-foreground">Forget this pending escape</button>
                    <div id="zkapi-withdraw-status" class="text-[11px] text-muted-foreground"></div>
                </div>`;
            return;
        }

        el.innerHTML = `
            <details class="zk-card p-3">
                <summary class="text-xs font-medium cursor-pointer">💸 Withdraw (close note)</summary>
                <div class="mt-3 space-y-2">
                    <div class="text-[11px] text-muted-foreground">Pays your unspent ${formatCreditsUsd(bal)} back to you; the spent amount goes to the operator. Closes the note.</div>
                    <label class="text-[11px] text-muted-foreground">Destination (defaults to your connected wallet)</label>
                    <input id="zkapi-withdraw-dest" type="text" placeholder="0x… (leave blank for your wallet)"
                        class="w-full px-2 py-1.5 text-[11px] font-mono rounded-md border border-border bg-background"/>
                    <button id="zkapi-withdraw-mutual-btn" class="w-full px-3 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
                        Withdraw (mutual close — instant)
                    </button>
                    <button id="zkapi-withdraw-escape-btn" class="w-full px-3 py-2 text-sm rounded-md border border-border hover:bg-muted">
                        Escape hatch (unilateral, 24h)
                    </button>
                    <div class="text-[10px] text-muted-foreground">Mutual close asks the server for a clearance signature and settles immediately. The escape hatch needs no server but opens a 24-hour challenge window before you can finalize.</div>
                    <div id="zkapi-withdraw-status" class="text-[11px] text-muted-foreground"></div>
                </div>
            </details>`;
    }

    renderModeAndInfo() {
        const el = this.drawer.querySelector('#zkapi-mode');
        if (!el) return;
        const mode = getBillingMode();
        const ephemeralAvailable = this.config?.ephemeral_available;
        const blurb = BILLING_MODES[mode].blurb;
        el.innerHTML = `
            <div class="space-y-2">
                <span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Billing mode</span>
                <div class="zk-seg">
                    <button data-mode="passthrough" class="${mode === 'passthrough' ? 'active' : ''}">Pass-through</button>
                    <button data-mode="ephemeral" class="${mode === 'ephemeral' ? 'active' : ''}" ${ephemeralAvailable ? '' : 'title="Server has no provisioning key"'}>Ephemeral key</button>
                </div>
                <p class="text-[11px] text-muted-foreground leading-snug">${esc(blurb)}</p>
                ${mode === 'ephemeral' && !ephemeralAvailable ? `<p class="text-[11px] text-amber-600">⚠ The server isn't configured for ephemeral keys; requests will fall back to an error. Use pass-through.</p>` : ''}
                ${this.config ? `<div class="text-[10px] text-muted-foreground">upstream: <b>${esc(this.config.upstream_kind || '—')}</b> · cap ${formatUsd(this.config.request_charge_cap_usd)} / request</div>` : ''}
            </div>`;
    }

    renderLedger() {
        const el = this.drawer.querySelector('#zkapi-ledger');
        if (!el) return;
        const entries = zkapiLedger.getEntries();
        if (!entries.length) {
            el.innerHTML = `<div class="text-[11px] text-muted-foreground py-4 text-center">No requests yet. Send a message to see the zkAPI proof, charge, and signed state.</div>`;
            return;
        }
        el.innerHTML = entries.map(e => this.renderEntry(e)).join('');
    }

    /** Charge as split-colored HTML (credits foreground, USD muted) — shared by
     *  the entry summary and the Billing detail row so the value reads identical. */
    chargeHtml(credits) {
        if (credits == null) return '—';
        return `<span class="font-medium">${formatCredits(credits)} cr</span> <span class="text-muted-foreground">· ${formatUsd(creditsToUsd(credits))}</span>`;
    }

    renderEntry(e) {
        const expanded = this.expanded.has(e.id);
        const dot = MODE_DOT[e.mode] || MODE_DOT.passthrough;
        const sub = [KIND_LABEL[e.kind] || e.kind, prettyModel(e.model)].filter(Boolean).join(' · ');
        // Chevron leads on the left (disclosure idiom) so the summary charge sits
        // flush-right in the same column as the Billing rows below.
        const head = `
            <div class="flex items-center gap-2.5 cursor-pointer" data-entry="${e.id}">
                <span class="zk-chev ${expanded ? 'zk-chev--open' : ''}">▸</span>
                <span class="zk-pill"><span class="zk-dot" style="background:${dot}"></span>${esc(e.mode)}</span>
                <span class="text-[11px] text-muted-foreground truncate flex-1 min-w-0">${esc(sub)}</span>
                <span class="shrink-0 text-[11px] tabular-nums whitespace-nowrap">${e.error ? '<span class="font-medium text-red-500">error</span>' : this.chargeHtml(e.chargeApplied)}</span>
            </div>`;
        if (!expanded) {
            return `<div class="zk-card zk-entry px-3 py-2.5" data-entry="${e.id}">${head}</div>`;
        }
        return `<div class="zk-card px-3 py-2.5 space-y-2.5">${head}${this.renderEntryDetail(e)}</div>`;
    }

    renderEntryDetail(e) {
        if (e.error) {
            return `<div class="text-[11px] text-red-500 break-all">${esc(e.error)}</div>`;
        }
        const u = e.usage || {};
        const sections = [];

        // Billing
        sections.push(this.section('Billing', [
            row('Charge', this.chargeHtml(e.chargeApplied), 'charge'),
            row('Remaining balance', e.remainingBalance != null ? formatCreditsUsd(e.remainingBalance) : '—', 'remaining_balance'),
            u.cost != null ? row('Provider cost', formatUsd(u.cost), 'cost_usd') : '',
            (u.prompt_tokens != null || u.completion_tokens != null) ? row('Tokens', `${u.prompt_tokens || 0} in / ${u.completion_tokens || 0} out / ${u.total_tokens || 0} total`, 'tokens') : '',
            u.cost_source ? row('Cost source', esc(u.cost_source), 'cost_source') : '',
            e.latencyMs != null ? row('Latency', `${e.latencyMs} ms`, 'latency') : ''
        ]));

        // Auth & proof (what the client computed/sent)
        sections.push(this.section('Authentication & proof', [
            row('Request nullifier', hashEl(e.requestNullifier), 'request_nullifier'),
            row('Payload hash', hashEl(e.payloadHash), 'payload_hash'),
            row('Solvency bound', e.solvencyBound != null ? formatCreditsUsd(e.solvencyBound) : '—', 'solvency_bound'),
            row('Active root', hashEl(e.activeRoot), 'active_root'),
            row('State sig epoch', e.stateSigEpoch ?? '—', 'state_sig_epoch'),
            e.merkleSiblingsCount != null ? row('Merkle siblings', `${e.merkleSiblingsCount}`, 'merkle_siblings') : ''
        ]));

        // Next state (server-signed)
        sections.push(this.section('Next state (server-signed)', [
            row('Next anchor', hashEl(e.nextAnchor), 'next_anchor'),
            row('Next commitment x', hashEl(e.nextCommitmentX), 'next_commitment'),
            row('Next commitment y', hashEl(e.nextCommitmentY), 'next_commitment'),
            row('Blind delta (srv)', hashEl(e.blindDeltaSrv), 'blind_delta_srv'),
            row('Next state sig epoch', e.nextStateSigEpoch ?? '—', 'next_state_sig_epoch'),
            row('Response hash', hashEl(e.responseHash), 'response_hash')
        ]));

        // Request content (collapsed raw)
        const raw = e.requestRaw ? `<details class="mt-1"><summary class="text-[11px] text-muted-foreground cursor-pointer">raw signed payload</summary><pre class="mt-1 text-[10px] whitespace-pre-wrap break-all bg-muted/30 p-2 rounded">${esc(e.requestRaw)}</pre></details>` : '';

        return sections.join('') + raw;
    }

    section(title, rows) {
        const body = rows.filter(Boolean).join('');
        if (!body) return '';
        return `<div>
            <div class="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">${esc(title)}</div>
            ${body}
        </div>`;
    }

    setDepositStatus(msg, isError = false) {
        const el = this.drawer.querySelector('#zkapi-deposit-status');
        if (el) { el.textContent = msg; el.className = `text-[11px] ${isError ? 'text-red-500' : 'text-muted-foreground'}`; }
    }

    setWithdrawStatus(msg, isError = false) {
        const el = this.drawer.querySelector('#zkapi-withdraw-status');
        if (el) { el.textContent = msg; el.className = `text-[11px] ${isError ? 'text-red-500' : 'text-muted-foreground'}`; }
    }

    /** Connect MetaMask, switch to the demo chain, and read the token decimals. */
    async connectWallet() {
        const ethers = await loadEthers();
        if (!window.ethereum) throw new Error('No browser wallet detected. Install MetaMask.');
        const overview = await zkapiClient.getDemoOverview();
        const funding = overview?.funding || {};
        const vault = funding.contract_address;
        const token = funding.demo_billing_token_address;
        const wantChain = Number(funding.chain_id);
        if (!vault) throw new Error('Daemon is missing demo chain config (vault). Start it with --demo-* flags.');
        const provider = new ethers.BrowserProvider(window.ethereum);
        await provider.send('eth_requestAccounts', []);
        const net = await provider.getNetwork();
        if (Number(net.chainId) !== wantChain) {
            await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + wantChain.toString(16) }] });
        }
        const signer = await provider.getSigner();
        const account = await signer.getAddress();
        if (token) {
            try { this.tokenDecimals = Number(await new ethers.Contract(token, ERC20_ABI, provider).decimals()); } catch (_) { /* keep default */ }
        }
        return { ethers, provider, signer, account, vault, token };
    }

    /**
     * Build the 15-field WithdrawalPublicInputs tuple for the vault call.
     * NB: the plan's `pi.destination` is a [u8;20] byte array; the on-chain
     * tuple needs the 0x address, so we pass `destination` (the address we
     * requested the withdrawal to) explicitly.
     */
    buildWithdrawTuple(pi, vault, currentRoot, destination) {
        return [
            pi.statement_type, pi.protocol_version, BigInt(pi.chain_id), vault, currentRoot,
            pi.note_id, BigInt(pi.final_balance), destination, BigInt(pi.withdrawal_nullifier),
            pi.is_genesis, pi.has_clearance, pi.state_sig_epoch, BigInt(pi.state_sig_root),
            pi.clear_sig_epoch, BigInt(pi.clear_sig_root)
        ];
    }

    async handleDeposit() {
        if (this.depositBusy) return;
        this.depositBusy = true;
        try {
            const usd = Number(this.drawer.querySelector('#zkapi-deposit-usd')?.value || 0);
            const amount = this.usdToCredits(usd); // credits == on-chain base units
            if (!amount || amount <= 0) { this.setDepositStatus('Enter a positive amount.', true); return; }

            this.setDepositStatus('Connecting wallet…');
            const { ethers, signer, vault, token } = await this.connectWallet();
            if (!token) { this.setDepositStatus('Daemon is missing the billing-token address (--demo-billing-token-address).', true); return; }

            this.setDepositStatus('Preparing commitment…');
            const prep = await zkapiClient.prepareDeposit(amount);

            const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
            this.setDepositStatus(`Approving ${formatUsd(usd)}… confirm in MetaMask.`);
            await (await erc20.approve(vault, BigInt(amount))).wait();

            const vaultContract = new ethers.Contract(vault, VAULT_ABI, signer);
            this.setDepositStatus('Depositing… confirm in MetaMask.');
            const receipt = await (await vaultContract.deposit(
                toBytes32(prep.commitment), BigInt(amount), prep.zero_path.map(s => BigInt(s))
            )).wait();

            let noteId, expiryTs;
            for (const log of receipt.logs) {
                try {
                    const parsed = vaultContract.interface.parseLog(log);
                    if (parsed && parsed.name === 'NoteDeposited') { noteId = Number(parsed.args.noteId); expiryTs = Number(parsed.args.expiryTs); break; }
                } catch (_) { /* not our event */ }
            }
            if (noteId === undefined) { this.setDepositStatus('Deposit mined but NoteDeposited not found.', true); return; }

            this.setDepositStatus(`Activating note #${noteId}…`);
            await zkapiClient.confirmDeposit({ secret: prep.secret, noteId, amount, expiryTs });
            this.setDepositStatus(`Deposited ${formatUsd(usd)} → note #${noteId} active.`);
            await this.refresh();
        } catch (err) {
            this.setDepositStatus(`Deposit failed: ${err.shortMessage || err.message || err}`, true);
        } finally {
            this.depositBusy = false;
        }
    }

    async handleWithdrawMutual() {
        if (this.withdrawBusy) return;
        this.withdrawBusy = true;
        try {
            this.setWithdrawStatus('Connecting wallet…');
            const { ethers, signer, vault, account } = await this.connectWallet();
            const destination = this.drawer.querySelector('#zkapi-withdraw-dest')?.value?.trim() || account;

            this.setWithdrawStatus('Requesting clearance + building proof…');
            const plan = await zkapiClient.withdraw({ mode: 'mutual', destination });
            const pi = plan.public_inputs;
            const vaultContract = new ethers.Contract(vault, VAULT_ABI, signer);
            const currentRoot = await vaultContract.currentRoot();
            const inputs = this.buildWithdrawTuple(pi, vault, currentRoot, destination);
            const siblings = plan.siblings.map(s => BigInt(s));

            this.setWithdrawStatus('Submitting mutualClose… confirm in MetaMask.');
            await (await vaultContract.mutualClose(inputs, '0x', siblings)).wait();
            await zkapiClient.resetWallet().catch(() => {});
            this.setWithdrawStatus(`Withdrawn ${formatCreditsUsd(pi.final_balance)} to ${shortenHash(destination)}. Note closed.`);
            await this.refresh();
        } catch (err) {
            this.setWithdrawStatus(`Withdraw failed: ${err.shortMessage || err.message || err}`, true);
        } finally {
            this.withdrawBusy = false;
        }
    }

    async handleEscapeInitiate() {
        if (this.withdrawBusy) return;
        this.withdrawBusy = true;
        try {
            this.setWithdrawStatus('Connecting wallet…');
            const { ethers, signer, vault, account } = await this.connectWallet();
            const destination = this.drawer.querySelector('#zkapi-withdraw-dest')?.value?.trim() || account;

            this.setWithdrawStatus('Building escape proof…');
            const plan = await zkapiClient.withdraw({ mode: 'escape', destination });
            const pi = plan.public_inputs;
            const vaultContract = new ethers.Contract(vault, VAULT_ABI, signer);
            const currentRoot = await vaultContract.currentRoot();
            const inputs = this.buildWithdrawTuple(pi, vault, currentRoot, destination);
            const siblings = plan.siblings.map(s => BigInt(s));

            this.setWithdrawStatus('Submitting initiateEscapeWithdrawal… confirm in MetaMask.');
            const receipt = await (await vaultContract.initiateEscapeWithdrawal(inputs, '0x', siblings)).wait();
            const block = await signer.provider.getBlock(receipt.blockNumber);
            const deadline = Number(block.timestamp) + CHALLENGE_PERIOD_SECONDS;
            this.setPendingEscape({ noteId: pi.note_id, destination: pi.destination, finalBalance: pi.final_balance, deadline });
            this.setWithdrawStatus('Escape initiated — finalize after the 24h challenge window.');
            await this.refresh();
        } catch (err) {
            this.setWithdrawStatus(`Escape failed: ${err.shortMessage || err.message || err}`, true);
        } finally {
            this.withdrawBusy = false;
        }
    }

    async handleEscapeFinalize() {
        if (this.withdrawBusy) return;
        this.withdrawBusy = true;
        try {
            const pending = this.getPendingEscape();
            if (!pending) return;
            this.setWithdrawStatus('Connecting wallet…');
            const { ethers, signer, vault } = await this.connectWallet();
            const vaultContract = new ethers.Contract(vault, VAULT_ABI, signer);
            this.setWithdrawStatus('Submitting finalizeEscapeWithdrawal… confirm in MetaMask.');
            await (await vaultContract.finalizeEscapeWithdrawal(pending.noteId)).wait();
            this.clearPendingEscape();
            await zkapiClient.resetWallet().catch(() => {});
            this.setWithdrawStatus(`Escape finalized: ${formatCreditsUsd(pending.finalBalance)} paid to ${shortenHash(pending.destination)}.`);
            await this.refresh();
        } catch (err) {
            this.setWithdrawStatus(`Finalize failed: ${err.shortMessage || err.message || err}`, true);
        } finally {
            this.withdrawBusy = false;
        }
    }
}

let panelInstance = null;
export function mountZkapiPanel() {
    if (panelInstance) return panelInstance;
    panelInstance = new ZkapiPanel();
    if (typeof window !== 'undefined') window.zkapiPanel = panelInstance;
    return panelInstance;
}

export default ZkapiPanel;
