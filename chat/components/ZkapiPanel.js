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
import zkApiBackend, { resetEphemeralKey } from '../services/inference/backends/zkApiBackend.js';
import {
    BILLING_MODES,
    getBillingMode,
    setBillingMode,
    setCreditsPerUsd,
    creditsToUsd,
    formatUsd,
    formatCredits,
    formatCreditsUsd,
    shortenHash
} from '../services/zkapi/zkapiConfig.js';

const ETHERS_CDN = 'https://cdn.jsdelivr.net/npm/ethers@6.13.2/dist/ethers.umd.min.js';
const VAULT_ABI = [
    'function deposit(bytes32 commitment, uint128 amount, uint256[32] siblings)',
    'event NoteDeposited(uint32 indexed noteId, bytes32 indexed commitment, uint128 amount, uint64 expiryTs, uint256 newRoot)'
];
const ERC20_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];

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

function row(label, valueHtml) {
    return `<div class="flex items-start justify-between gap-3 py-1 border-b border-border/40 last:border-0">
        <span class="text-[11px] text-muted-foreground shrink-0">${esc(label)}</span>
        <span class="text-[11px] text-right break-all">${valueHtml}</span>
    </div>`;
}

const MODE_BADGE = {
    passthrough: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    ephemeral: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
};
const KIND_LABEL = {
    inference: 'inference',
    ephemeral_issue: 'key issued',
    ephemeral_settle: 'settled',
    direct_stream: 'stream'
};

class ZkapiPanel {
    constructor() {
        this.open = false;
        this.config = null;
        this.wallet = null;
        this.expanded = new Set();
        this.depositBusy = false;
        this.mount();
        zkapiLedger.subscribe(evt => this.onLedgerEvent(evt));
        this.refresh();
        // Periodic wallet refresh while open.
        setInterval(() => { if (this.open) this.refreshWallet(); }, 5000);
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
            .zk-card{border:1px solid hsl(var(--color-border));border-radius:12px;}
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
        this.render();
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
    }

    render() {
        this.drawer.innerHTML = `
            <div class="flex items-center justify-between px-4 py-3 border-b border-border" style="min-height:calc(3rem + 1px)">
                <div class="flex items-center gap-2">
                    <span class="font-semibold text-sm">zkAPI</span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">unlinkable inference + payment</span>
                </div>
                <button id="zkapi-close" class="text-muted-foreground hover:text-foreground" aria-label="Close">✕</button>
            </div>
            <div class="zk-scroll px-4 py-3 space-y-4">
                <div id="zkapi-wallet"></div>
                <div id="zkapi-deposit"></div>
                <div id="zkapi-mode"></div>
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
        this.renderModeAndInfo();
        this.renderLedger();
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
                <div class="text-2xl font-semibold tabular-nums">${formatCredits(bal)} <span class="text-sm text-muted-foreground">credits</span></div>
                <div class="text-xs text-muted-foreground mb-2">${formatUsd(creditsToUsd(bal))} · deposited ${formatCredits(dep)} (${formatUsd(creditsToUsd(dep))})</div>
                ${note ? `<div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <div>Note #${esc(note.note_id)}</div>
                    <div>${note.is_genesis ? 'genesis' : 'active chain'}</div>
                    <div class="col-span-2">expires ${esc(expiry)}</div>
                </div>` : ''}
            </div>`;
    }

    renderDeposit() {
        const el = this.drawer.querySelector('#zkapi-deposit');
        if (!el) return;
        el.innerHTML = `
            <details class="zk-card p-3" ${this.wallet ? '' : 'open'}>
                <summary class="text-xs font-medium cursor-pointer flex items-center gap-2">
                    <span>💳 Fund wallet via MetaMask</span>
                </summary>
                <div class="mt-3 space-y-2">
                    <label class="text-[11px] text-muted-foreground">Amount (credits — 1,000,000 = $1.00)</label>
                    <input id="zkapi-deposit-amount" type="number" value="5000000" min="1"
                        class="w-full px-2 py-1.5 text-sm rounded-md border border-border bg-background"/>
                    <button id="zkapi-deposit-btn" class="w-full px-3 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
                        Deposit with MetaMask
                    </button>
                    <div id="zkapi-deposit-status" class="text-[11px] text-muted-foreground"></div>
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

    renderEntry(e) {
        const expanded = this.expanded.has(e.id);
        const badge = MODE_BADGE[e.mode] || MODE_BADGE.passthrough;
        const chargeTxt = e.chargeApplied != null
            ? `${formatCredits(e.chargeApplied)} cr · ${formatUsd(creditsToUsd(e.chargeApplied))}`
            : '—';
        const head = `
            <div class="flex items-center justify-between gap-2 cursor-pointer" data-entry="${e.id}">
                <div class="flex items-center gap-2 min-w-0">
                    <span class="text-[10px] px-1.5 py-0.5 rounded ${badge}">${esc(e.mode)}:${esc(KIND_LABEL[e.kind] || e.kind)}</span>
                    <span class="text-[11px] truncate">${esc(e.model || '')}</span>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                    ${e.error ? `<span class="text-[10px] text-red-500">error</span>` : `<span class="text-[11px] font-medium">${chargeTxt}</span>`}
                    <span class="text-muted-foreground text-[10px]">${expanded ? '▾' : '▸'}</span>
                </div>
            </div>`;
        if (!expanded) {
            return `<div class="zk-card p-2.5">${head}</div>`;
        }
        return `<div class="zk-card p-2.5 space-y-2">${head}${this.renderEntryDetail(e)}</div>`;
    }

    renderEntryDetail(e) {
        if (e.error) {
            return `<div class="text-[11px] text-red-500 break-all">${esc(e.error)}</div>`;
        }
        const u = e.usage || {};
        const sections = [];

        // Billing
        sections.push(this.section('Billing', [
            row('Charge', `${formatCredits(e.chargeApplied)} cr · ${formatUsd(creditsToUsd(e.chargeApplied))}`),
            row('Remaining balance', e.remainingBalance != null ? formatCreditsUsd(e.remainingBalance) : '—'),
            u.cost != null ? row('Provider cost', formatUsd(u.cost)) : '',
            (u.prompt_tokens != null || u.completion_tokens != null) ? row('Tokens', `${u.prompt_tokens || 0} in / ${u.completion_tokens || 0} out / ${u.total_tokens || 0} total`) : '',
            e.latencyMs != null ? row('Latency', `${e.latencyMs} ms`) : ''
        ]));

        // Auth & proof (what the client computed/sent)
        sections.push(this.section('Authentication & proof', [
            row('Request nullifier', hashEl(e.requestNullifier)),
            row('Payload hash', hashEl(e.payloadHash)),
            row('Solvency bound', e.solvencyBound != null ? formatCreditsUsd(e.solvencyBound) : '—'),
            row('Active root', hashEl(e.activeRoot)),
            row('State sig epoch', e.stateSigEpoch ?? '—'),
            row('Proof backend', esc(e.runtimeProofBackend || '—')),
            e.merkleSiblingsCount != null ? row('Merkle siblings', `${e.merkleSiblingsCount}`) : ''
        ]));

        // Next state (server-signed)
        sections.push(this.section('Next state (server-signed)', [
            row('Next anchor', hashEl(e.nextAnchor)),
            row('Next commitment x', hashEl(e.nextCommitmentX)),
            row('Next commitment y', hashEl(e.nextCommitmentY)),
            row('Blind delta (srv)', hashEl(e.blindDeltaSrv)),
            row('Next state sig epoch', e.nextStateSigEpoch ?? '—'),
            row('Response hash', hashEl(e.responseHash))
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

    async handleDeposit() {
        if (this.depositBusy) return;
        this.depositBusy = true;
        try {
            const amount = parseInt(this.drawer.querySelector('#zkapi-deposit-amount')?.value || '0', 10);
            if (!amount || amount <= 0) { this.setDepositStatus('Enter a positive amount.', true); return; }

            const ethers = await loadEthers();
            if (!window.ethereum) { this.setDepositStatus('No browser wallet detected. Install MetaMask.', true); return; }

            const overview = await zkapiClient.getDemoOverview();
            const funding = overview?.funding || {};
            const vault = funding.contract_address;
            const token = funding.demo_billing_token_address;
            const wantChain = Number(funding.chain_id);
            if (!vault || !token) { this.setDepositStatus('Daemon is missing demo chain config (vault/token). Start it with --demo-* flags.', true); return; }

            this.setDepositStatus('Preparing commitment…');
            const prep = await zkapiClient.prepareDeposit(amount);

            this.setDepositStatus('Connecting wallet…');
            const provider = new ethers.BrowserProvider(window.ethereum);
            await provider.send('eth_requestAccounts', []);
            const net = await provider.getNetwork();
            if (Number(net.chainId) !== wantChain) {
                await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + wantChain.toString(16) }] });
            }
            const signer = await provider.getSigner();

            const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
            this.setDepositStatus('Approving the vault… confirm in MetaMask.');
            await (await erc20.approve(vault, BigInt(amount))).wait();

            const vaultContract = new ethers.Contract(vault, VAULT_ABI, signer);
            this.setDepositStatus('Depositing… confirm in MetaMask.');
            const commitment = toBytes32(prep.commitment);
            const siblings = prep.zero_path.map(s => BigInt(s));
            const receipt = await (await vaultContract.deposit(commitment, BigInt(amount), siblings)).wait();

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
            this.setDepositStatus(`Note #${noteId} active. Balance updated.`);
            await this.refreshWallet();
        } catch (err) {
            this.setDepositStatus(`Deposit failed: ${err.shortMessage || err.message || err}`, true);
        } finally {
            this.depositBusy = false;
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
