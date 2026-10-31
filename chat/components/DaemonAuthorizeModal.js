import { showSurface, hideSurface } from '../ui/uiMotion.js';
import {
    clearDaemonIntent,
    createDaemonAuthorization
} from '../services/daemonAuthorization.js';

/**
 * Asks the signed-in person to authorize a local oa-clientd daemon. Approval is
 * always a click plus the code from the terminal, then a passkey prompt. No link
 * alone can approve anything.
 */
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

const buttonBase = 'inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

class DaemonAuthorizeModal {
    constructor({ accountService, origin = globalThis.location?.origin } = {}) {
        this.accountService = accountService;
        this.origin = origin;
        this.overlay = null;
        this.session = null;
        this.codeValue = '';
    }

    get isOpen() {
        return !!this.overlay;
    }

    async open(intent) {
        if (this.overlay) return;
        const accountService = this.accountService;
        this.overlay = document.createElement('div');
        this.overlay.className = 'daemon-authorize-modal fixed inset-0 z-[10001] flex items-center justify-center bg-black/50';
        this.overlay.setAttribute('role', 'dialog');
        this.overlay.setAttribute('aria-modal', 'true');
        this.overlay.setAttribute('aria-label', 'Authorize oa-clientd');
        document.body.appendChild(this.overlay);
        showSurface(this.overlay);
        this.escapeHandler = event => {
            if (event.key === 'Escape' && this.session?.getState().status !== 'approving') this.dismiss();
        };
        document.addEventListener('keydown', this.escapeHandler);
        this.session = createDaemonAuthorization({
            intent,
            origin: this.origin,
            accountId: () => accountService.getState().accountId,
            accountSupported: () => ['PRF', 'LEGACY_PASSKEY'].includes(accountService.getState().encryptionMode),
            request: (path, body) => accountService.daemonAuthRequest(path, body),
            revealMasterKey: options => accountService.revealMasterKeyForDaemon(options),
            onChange: state => this.render(state)
        });
        this.render(this.session.getState());
        // Account changes and expiry end an idle dialog, not only the next click.
        this.accountUnsubscribe = accountService.subscribe(() => this.session?.revalidate());
        await this.session?.load();
        const expiresAt = this.session?.getState().expiresAt;
        if (expiresAt) {
            this.expiryTimer = setTimeout(() => this.session?.revalidate(), Math.max(0, expiresAt - Date.now()));
        }
    }

    close() {
        if (!this.overlay) return;
        document.removeEventListener('keydown', this.escapeHandler);
        this.accountUnsubscribe?.();
        this.accountUnsubscribe = null;
        clearTimeout(this.expiryTimer);
        hideSurface(this.overlay, { remove: true });
        this.overlay = null;
        this.session = null;
        this.codeValue = '';
        clearDaemonIntent();
    }

    /** Lists this account's authorized daemons, each with a Revoke button. */
    async openDevices() {
        if (this.overlay) return;
        this.overlay = document.createElement('div');
        this.overlay.className = 'daemon-authorize-modal fixed inset-0 z-[10001] flex items-center justify-center bg-black/50';
        this.overlay.setAttribute('role', 'dialog');
        this.overlay.setAttribute('aria-modal', 'true');
        this.overlay.setAttribute('aria-label', 'Authorized computers');
        document.body.appendChild(this.overlay);
        showSurface(this.overlay);
        // The list is this account's; another account must not act on it.
        const listedFor = this.accountService.getState().accountId;
        this.accountUnsubscribe = this.accountService.subscribe(state => {
            if (state.accountId !== listedFor) this.close();
        });
        this.escapeHandler = event => {
            if (event.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this.escapeHandler);
        await this.renderDevices();
    }

    async renderDevices(error = null) {
        let devices = [];
        let loadFailed = false;
        try {
            devices = (await this.accountService.daemonAuthRequest('/auth/daemon/devices/list', {})).devices || [];
        } catch {
            loadFailed = true;
        }
        if (!this.overlay) return;
        const rows = devices.map(device => `
            <li class="flex items-center justify-between gap-3">
                <span class="text-sm text-foreground">oa-clientd ${escapeHtml(device.clientVersion)}${device.platform ? ` on ${escapeHtml(device.platform)}` : ''}<span class="block text-xs text-muted-foreground">Authorized ${escapeHtml(new Date(device.authorizedAt * 1000).toLocaleString())}</span></span>
                <button class="daemon-device-revoke ${buttonBase} bg-muted/60 text-foreground hover:bg-muted" data-device="${escapeHtml(device.id)}">Revoke</button>
            </li>`).join('');
        const empty = loadFailed ? 'The list could not be loaded.' : 'No computers are authorized.';
        this.overlay.innerHTML = `
            <div class="bg-background border border-border rounded-xl shadow-2xl max-w-md w-full mx-4 p-5 space-y-4">
                <h2 class="text-base font-semibold text-foreground">Authorized computers</h2>
                ${rows ? `<ul class="space-y-3">${rows}</ul>` : `<p class="text-sm text-muted-foreground">${empty}</p>`}
                <p class="text-xs text-muted-foreground">Revoking stops a computer syncing. It can still spend tickets it already holds.</p>
                ${error ? `<p class="text-sm text-red-600 dark:text-red-400" role="alert">${escapeHtml(error)}</p>` : ''}
                <div class="flex justify-end"><button class="daemon-authorize-close ${buttonBase} bg-muted/60 text-foreground hover:bg-muted">Close</button></div>
            </div>`;
        this.overlay.querySelector('.daemon-authorize-close').addEventListener('click', () => this.close());
        this.overlay.querySelectorAll('.daemon-device-revoke').forEach(button => {
            button.addEventListener('click', async () => {
                button.disabled = true;
                let failure = null;
                try {
                    await this.accountService.daemonAuthRequest(`/auth/daemon/devices/${encodeURIComponent(button.dataset.device)}`, null, { method: 'DELETE' });
                } catch {
                    failure = 'That computer could not be revoked. Try again.';
                }
                await this.renderDevices(failure);
            });
        });
    }

    // Leaving the dialog without a choice declines, so a request never lingers.
    dismiss() {
        const session = this.session;
        if (session && ['review', 'loading'].includes(session.getState().status)) void session.decline();
        this.close();
    }

    terminalMessage(state) {
        switch (state.status) {
        case 'done':
            return ['oa-clientd is authorized', 'You can close this tab and return to your terminal. Your tickets are syncing to that computer.'];
        case 'declined':
            return ['Authorization declined', 'Nothing was sent. You can close this tab.'];
        case 'expired':
            return ['This request expired', 'Nothing was sent. Run oa-clientd login in your terminal to start again.'];
        case 'failed':
            return ['Authorization failed', state.error || 'Nothing was sent. Run oa-clientd login in your terminal to start again.'];
        }
        return null;
    }

    render(state) {
        if (!this.overlay) return;
        const input = this.overlay.querySelector('#daemon-authorize-code');
        if (input) this.codeValue = input.value;
        const terminal = this.terminalMessage(state);
        const card = 'bg-background border border-border rounded-xl shadow-2xl max-w-md w-full mx-4 p-5 space-y-4';
        if (terminal) {
            this.overlay.innerHTML = `
                <div class="${card}">
                    <h2 class="text-base font-semibold text-foreground">${escapeHtml(terminal[0])}</h2>
                    <p class="text-sm text-muted-foreground">${escapeHtml(terminal[1])}</p>
                    <div class="flex justify-end">
                        <button class="daemon-authorize-close ${buttonBase} bg-muted/60 text-foreground hover:bg-muted">Close</button>
                    </div>
                </div>`;
            this.overlay.querySelector('.daemon-authorize-close').addEventListener('click', () => this.close());
            return;
        }
        if (state.status === 'loading') {
            this.overlay.innerHTML = `<div class="${card}"><p class="text-sm text-muted-foreground">Checking the request from your terminal…</p></div>`;
            return;
        }
        const details = state.details || {};
        const busy = state.status === 'approving';
        const client = [details.clientName, details.clientVersion].filter(Boolean).join(' ');
        this.overlay.innerHTML = `
            <div class="${card}">
                <h2 class="text-base font-semibold text-foreground">Authorize this computer?</h2>
                <p class="text-sm text-muted-foreground"><span class="font-medium text-foreground">${escapeHtml(client)}</span>${details.platform ? ` on ${escapeHtml(details.platform)}` : ''} is asking to use your inference tickets.</p>
                <ul class="text-sm text-muted-foreground list-disc pl-5 space-y-1">
                    <li>It gets a copy of your wallet's encryption key, sealed so that only it can open it. OA cannot read it.</li>
                    <li>It can spend your tickets for models you ask it to use. It can never buy anything.</li>
                    <li>End it with oa-clientd logout, or from any signed-in browser at <span class="font-mono">#oa-daemon-devices</span>. That stops it syncing, but it can still spend tickets it already holds, so spend or move your tickets if you lose this computer.</li>
                </ul>
                ${details.sameNetwork === false ? '<p class="text-sm text-amber-700 dark:text-amber-400">This request came from a different network than this browser. Only continue if you started it yourself, for example over SSH.</p>' : ''}
                <label class="block text-sm font-medium text-foreground" for="daemon-authorize-code">Enter the code from your terminal</label>
                <input id="daemon-authorize-code" class="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm tracking-widest text-foreground" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16" placeholder="XXXX-XXXX" ${busy ? 'disabled' : ''} value="${escapeHtml(this.codeValue)}">
                ${state.error ? `<p class="text-sm text-red-600 dark:text-red-400" role="alert">${escapeHtml(state.error)}</p>` : ''}
                <div class="flex justify-end gap-2">
                    <button class="daemon-authorize-decline ${buttonBase} bg-muted/60 text-foreground hover:bg-muted" ${busy ? 'disabled' : ''}>Decline</button>
                    <button class="daemon-authorize-approve ${buttonBase} bg-foreground text-background hover:opacity-90" ${busy ? 'disabled' : ''}>${busy ? 'Waiting for passkey…' : 'Approve with passkey'}</button>
                </div>
            </div>`;
        const field = this.overlay.querySelector('#daemon-authorize-code');
        const approve = () => {
            const code = field.value.trim();
            if (code.length >= 8) void this.session?.approve(code);
        };
        this.overlay.querySelector('.daemon-authorize-approve').addEventListener('click', approve);
        this.overlay.querySelector('.daemon-authorize-decline').addEventListener('click', () => this.dismiss());
        if (!busy) field.focus();
    }
}

export default DaemonAuthorizeModal;
