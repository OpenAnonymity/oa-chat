import SharedRightPanel from '../../components/RightPanel.js';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { getZkapiExperience, renderZkapiPanelExperience } from './ZkapiStateExperience.js';
import { formatModelBudgetUsd, getModelBudget } from '../services/zkapiModelBudget.mjs';
import { onModelTiersUpdate } from '../../publicModelTierApi.js';
import { formatEstimatedCost, formatUsageTokens } from '../services/modelPricing.mjs';
import {
    attachPrivateBalanceHelp, capturePrivateBalanceHelpFocus, privateBalanceExpiryLabel,
    privateBalanceExpired, privateBalanceHelpButton, privateBalanceHelpContent,
    restorePrivateBalanceHelpFocus, updatePrivateBalanceExpiryState
} from './PrivateBalanceHelp.js';

/**
 * OA's System Panel with its ticket purchase/redemption section replaced by
 * zkAPI private-note billing. The ephemeral-key, proxy, and activity UI below
 * that seam stays on the upstream OA implementation.
 */
export default class RightPanel extends SharedRightPanel {
    constructor(app) {
        super(app);
        this.zkapiUnsubscribe = zkapiClient.subscribe((_snapshot, detail) => {
            this.handleZkapiChange(detail);
        });
        this.zkapiClockUnsubscribe = zkapiClient.subscribeClock(() => {
            this.handleZkapiClock();
        });
        this.usageEstimateUpdateTimer = null;
        this.modelBudgetUnsubscribe = onModelTiersUpdate(() => this.updateUsageEstimate());
    }

    handleZkapiChange(detail = {}) {
        // Keep this defensive guard even though clocks use a separate channel:
        // an accidental legacy emitChange('clock') must never rebuild the UI.
        if (detail.reason === 'clock') {
            this.handleZkapiClock();
            return;
        }
        this.loadSessionData();
    }

    handleZkapiClock() {
        const expiry = document.querySelector('#right-panel [data-zkapi-note-expiry]');
        if (expiry && zkapiClient.note) {
            expiry.textContent = privateBalanceExpiryLabel(zkapiClient, zkapiClient.note.expiry_ts);
        }
        updatePrivateBalanceExpiryState(document.querySelector('#right-panel'), zkapiClient.note);
    }

    onRuntimePresentationChange() {
        const transition = this.app.integration?.getTransition?.();
        const signature = JSON.stringify([
            transition?.phase || null, transition?.sessionId || null,
            transition?.message || null, transition?.title || null,
            this.currentSession?.model || this.app.state?.pendingModelName || null,
            this.app.reasoningEnabled ?? true
        ]);
        if (this.runtimePresentationSignature === signature) return;
        this.runtimePresentationSignature = signature;
        this.renderTopSectionOnly();
    }

    renderTopSectionOnly() {
        const helpFocus = capturePrivateBalanceHelpFocus(document.querySelector('#right-panel'));
        const existingExperienceDisclosure = document.querySelector('#right-panel .zkapi-panel-experience--disclosure');
        const experienceWasOpen = existingExperienceDisclosure
            ? Boolean(existingExperienceDisclosure.open)
            : Boolean(this.zkapiDisclosureOpen);
        super.renderTopSectionOnly();

        const experienceDisclosure = document.querySelector('#right-panel .zkapi-panel-experience--disclosure');
        if (experienceDisclosure) {
            experienceDisclosure.open = experienceWasOpen;
            this.zkapiDisclosureOpen = experienceDisclosure.open;
            experienceDisclosure.addEventListener('toggle', () => {
                this.zkapiDisclosureOpen = experienceDisclosure.open;
            });
        } else {
            this.zkapiDisclosureOpen = false;
        }

        restorePrivateBalanceHelpFocus(document.querySelector('#right-panel'), helpFocus);
    }

    loadSessionData() {
        const session = this.currentSession;
        const lease = zkapiClient.activeLease;
        const ownsLease = !!session && lease?.session_id === session.id;
        const accessInfo = session
            ? this.app.services.inference.getAccessInfo(session)
            : null;

        // OA persists its raw key on the chat. zkAPI deliberately persists
        // only the chat binding and keeps the real child key in memory.
        this.apiKey = ownsLease ? accessInfo?.token || session.id : null;
        this.apiKeyInfo = ownsLease ? {
            ...(accessInfo?.info || {}),
            stationId: lease.station_id || accessInfo?.info?.stationId || null,
            clientRequestId: lease.client_request_id,
            spendingLimitUsd: lease.spending_limit_usd
        } : null;
        this.expiresAt = ownsLease
            ? new Date(Number(lease.expires_at) * 1000).toISOString()
            : null;
        this.networkLogs = this.app.services.networkLogger.getAllLogs();
        this.previousLogCount = this.networkLogs.length;
        this.startExpirationTimer();
        this.renderTopSectionOnly();
        this.updateStatusIndicator();

        requestAnimationFrame(() => this.scrollToBottomInstant());
    }

    onSessionChange(session) {
        this.currentSession = session;
        this.loadSessionData();
    }

    onModelSelectionChange() {
        const session = this.app.getCurrentSession();
        // Navigation has its own full panel update. Refresh only the selected
        // chat's budget here, preserving help, focus and key controls.
        if (session?.id !== this.currentSession?.id) return;
        this.currentSession = session;
        this.updateUsageEstimate();
    }

    usageEstimateView() {
        const summary = this.app.integration?.getSessionUsageSummary?.(this.currentSession);
        const cost = summary?.hasEstimate ? Number(summary.estimatedCostUsd || 0) : null;
        const lease = zkapiClient.activeLease;
        const ownsLease = this.currentSession?.id && lease?.session_id === this.currentSession.id;
        let spendingLimitUsd = ownsLease ? Number(lease.spending_limit_usd) : null;
        if (!ownsLease) {
            const reference = this.currentSession?.model || this.app.state?.pendingModelName;
            const model = this.app.state?.models?.find(entry => entry.id === reference || entry.name === reference);
            const modelId = model?.id || (reference?.includes('/') ? reference : null)
                || (!reference ? this.app.getDefaultModelId?.() : null);
            if (modelId) {
                try { spendingLimitUsd = getModelBudget(modelId, this.app.reasoningEnabled ?? true).spendingLimitUsd; }
                catch { /* Unreviewed tiers must not display a fabricated cap. */ }
            }
        }
        return {
            visible: Boolean(this.currentSession && summary?.hasEstimate),
            costLabel: formatEstimatedCost(cost) || '$0.00',
            tokenLabel: `${formatUsageTokens(summary?.promptTokens || 0)} in · ${formatUsageTokens(summary?.completionTokens || 0)} out`,
            keyLimitLabel: formatModelBudgetUsd(spendingLimitUsd)
        };
    }

    updateUsageEstimate() {
        if (this.usageEstimateUpdateTimer) {
            clearTimeout(this.usageEstimateUpdateTimer);
            this.usageEstimateUpdateTimer = null;
        }
        const card = document.querySelector('#right-panel [data-chat-usage-estimate]');
        if (!card) return;
        const view = this.usageEstimateView();
        card.classList.toggle('hidden', !view.visible);
        const cost = card.querySelector('[data-chat-usage-cost]');
        const tokens = card.querySelector('[data-chat-usage-tokens]');
        const keyLimit = card.querySelector('[data-chat-usage-key-limit]');
        if (cost) cost.textContent = view.costLabel;
        if (tokens) tokens.textContent = view.tokenLabel;
    }

    scheduleUsageEstimateUpdate() {
        if (this.usageEstimateUpdateTimer) return;
        this.usageEstimateUpdateTimer = setTimeout(() => {
            this.usageEstimateUpdateTimer = null;
            this.updateUsageEstimate();
        }, 300);
    }

    billingSectionHTML() {
        const note = zkapiClient.note;
        const claimed = Boolean(note && zkapiClient.noteExpiryClaim);
        const expired = privateBalanceExpired(note);
        const pendingDeposit = zkapiClient.config?.pending_deposit;
        const balance = note && !claimed ? zkapiClient.formatMoney(note.current_balance) : '$0.00';
        const used = note
            ? zkapiClient.formatMoney(Math.max(0, Number(note.deposit_amount || 0) - Number(note.current_balance || 0)))
            : '$0.00';
        const percent = note?.deposit_amount && !claimed
            ? Math.max(0, Math.min(100, Number(note.current_balance) / Number(note.deposit_amount) * 100))
            : 0;
        const hasError = !!zkapiClient.lastError;
        const openWithdrawals = zkapiClient.openWithdrawals;
        const lateWithdrawals = zkapiClient.unresolvedLateWithdrawals;
        const withdrawalRecoveryCount = openWithdrawals.length + lateWithdrawals.length;
        const withdrawalStatusLabel = (() => {
            const lateAttention = lateWithdrawals.filter(attempt =>
                attempt.error || attempt.status === 'receipt_mismatch').length;
            if (lateAttention) {
                return `${lateAttention} need${lateAttention === 1 ? 's' : ''} attention`;
            }
            if (lateWithdrawals.length) return `${lateWithdrawals.length} checking`;
            const challengeChecks = openWithdrawals.filter(record =>
                ['challenged_unconfirmed', 'recovery_unconfirmed'].includes(record.phase)).length;
            if (challengeChecks) return `${challengeChecks} confirming`;
            const attention = openWithdrawals.filter(record => record.error
                || record.phase === 'ambiguous'
                || (record.chainStatus === 'active'
                    && !['challenged_unconfirmed', 'recovery_unconfirmed', 'parked', 'restored'].includes(record.phase))).length;
            if (attention) return `${attention} need${attention === 1 ? 's' : ''} attention`;
            const ready = openWithdrawals.filter(record => ['parked', 'restored'].includes(record.phase)
                || record.mode === 'escape'
                && record.phase === 'pending'
                && Number(record.challengeDeadline || 0) * 1000 <= Date.now()).length;
            if (ready) return `${ready} ready`;
            const waiting = openWithdrawals.filter(record => record.phase !== 'closed_unconfirmed');
            if (waiting.length) return `${waiting.length} waiting`;
            return `${openWithdrawals.length} returned`;
        })();
        const usage = this.usageEstimateView();
        const experience = getZkapiExperience(this.app, this.currentSession?.id);
        const experienceHtml = experience.closingPrimary
            ? renderZkapiPanelExperience({
                ...experience,
                proposal: 'quiet',
                panelPrimary: experience.closingPrimary,
                showComposer: true
            }, value => this.escapeHtml(value))
            : '';
        const actionableState = ['withdrawal', 'escape-wait', 'deposit-recovery']
            .includes(experience.primary.phase);
        const statusBadge = claimed ? 'claimed' : experience.primary.tone === 'error'
            ? 'attention'
            : experience.primary.busy
                ? experience.primary.compact
                : actionableState
                    ? experience.primary.compact
                : expired ? 'expired' : note
                    ? 'ready'
                    : 'not funded';
        // While a step runs the pill is a spinner; the words go to the toast
        // over the chat bar, where a sentence fits.
        const badgeBusy = !claimed && !hasError && experience.primary.busy && experience.primary.tone !== 'error';

        return `
            <div class="p-3">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5">
                        <svg class="h-3.5 w-3.5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m3-9.5C15 7.12 13.66 6 12 6S9 7.12 9 8.5 10.34 11 12 11s3 1.12 3 2.5S13.66 16 12 16s-3-1.12-3-2.5M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>
                        <span class="text-xs font-medium">Private balance: <span class="font-semibold">${balance}</span></span>
                        ${privateBalanceHelpButton('panel', 'billing', this.privateBalanceHelpOpen?.billing)}
                    </div>
                    <span ${note && !claimed && !hasError && !experience.primary.busy && !actionableState && experience.primary.tone !== 'error' ? 'data-private-balance-readiness' : ''} class="max-w-[8.5rem] truncate rounded-full px-2 py-0.5 text-[9px] font-medium ${claimed || badgeBusy ? 'bg-muted text-muted-foreground' : hasError || experience.primary.tone === 'error' ? 'bg-destructive/10 text-destructive' : actionableState || expired ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200' : note ? 'badge-status-success' : 'bg-muted text-muted-foreground'}">${claimed ? 'claimed' : hasError ? 'unavailable' : badgeBusy ? `<span class="zkapi-pill-spinner" role="img" aria-label="${this.escapeHtml(statusBadge)}"></span>` : this.escapeHtml(statusBadge)}</span>
                </div>
                ${privateBalanceHelpContent('panel', 'billing', this.privateBalanceHelpOpen?.billing)}
                <div class="mt-3 h-1 overflow-hidden rounded-full bg-muted"><div class="zkapi-panel-bar-fill h-full rounded-full transition-all" style="width:${percent}%"></div></div>
                <div class="mt-2 flex items-center justify-between text-[10px] text-muted-foreground"><span>${claimed ? 'Claimed after expiry' : `${used} used`}</span><span class="inline-flex items-center gap-1"><span ${note ? 'data-zkapi-note-expiry' : ''}>${note ? privateBalanceExpiryLabel(zkapiClient, note.expiry_ts) : pendingDeposit ? 'Deposit in progress' : 'Fund with MetaMask to chat'}</span>${note ? privateBalanceHelpButton('panel', 'expiry', this.privateBalanceHelpOpen?.expiry) : ''}</span></div>
                ${note ? privateBalanceHelpContent('panel', 'expiry', this.privateBalanceHelpOpen?.expiry) : ''}
                <div data-chat-usage-estimate class="mt-2 rounded-md bg-muted/50 px-2 py-1.5 ${usage.visible ? '' : 'hidden'}" title="Running model-usage estimate. OpenRouter's reported cost is used when available; zkAPI settlement is final.">
                    <div class="flex items-center justify-between gap-2 text-[10px]"><span class="text-muted-foreground">Estimated this chat</span><strong data-chat-usage-cost class="font-medium text-foreground">${this.escapeHtml(usage.costLabel)}</strong></div>
                    <div class="mt-1 flex items-center justify-between gap-2 text-[9px] text-muted-foreground"><span data-chat-usage-tokens>${this.escapeHtml(usage.tokenLabel)}</span></div>
                </div>
                ${experienceHtml}
                ${withdrawalRecoveryCount ? `<button id="zkapi-panel-withdrawals" class="btn-ghost-hover mt-2 flex w-full items-center justify-between rounded-md bg-muted/40 px-2.5 py-2 text-[10px] text-muted-foreground transition-colors" type="button"><span>Payment history</span><strong class="font-medium text-foreground">${withdrawalStatusLabel}</strong></button>` : ''}
                <div class="mt-3 grid ${note && !claimed ? 'grid-cols-2' : 'grid-cols-1'} gap-1.5">
                    <button id="zkapi-panel-fund" class="btn-ghost-hover inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-xs font-medium shadow-sm transition-all">${note ? 'Balance details' : pendingDeposit ? 'Deposit status' : 'Fund with MetaMask'}</button>
                    ${note && !claimed ? '<button id="zkapi-panel-withdraw" class="btn-ghost-hover inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-xs font-medium shadow-sm transition-all">Withdraw</button>' : ''}
                </div>
                ${hasError ? `<p class="mt-2 text-[10px] leading-snug text-destructive">${this.escapeHtml(zkapiClient.lastError.message)}</p>` : ''}
            </div>
        `;
    }

    generateFundingSectionHTML() {
        return this.billingSectionHTML();
    }

    fundingSectionIncludesAccessKey() {
        return false;
    }

    getMissingApiKeyStatus() {
        const transition = this.app.integration?.getTransition?.();
        if (transition?.phase === 'settling' || transition?.phase === 'waiting') {
            return {
                label: 'Closing previous chat key',
                badge: 'Settling',
                badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200'
            };
        }
        if (transition?.phase === 'ready') {
            return {
                label: 'Previous key closed · fresh key requested on send',
                badge: 'Ready',
                badgeClass: 'badge-status-success'
            };
        }
        if (transition?.phase === 'error') {
            return {
                label: 'Previous key could not be closed',
                badge: 'Action needed',
                badgeClass: 'bg-destructive/10 text-destructive'
            };
        }
        return { label: 'Key created when you send', badge: 'Ready', badgeClass: 'badge-status-success' };
    }

    attachTopSectionEventListeners() {
        // Preserve OA's ephemeral-key, verifier, and network-proxy controls.
        super.attachTopSectionEventListeners();
        attachPrivateBalanceHelp(document.querySelector('#right-panel'), this);
        document.getElementById('zkapi-panel-fund')?.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('zkapi-payment-required', {
                detail: { view: zkapiClient.note ? 'balance' : 'fund' }
            }));
        });
        document.getElementById('zkapi-panel-withdraw')?.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('zkapi-payment-required', {
                detail: { view: 'withdraw' }
            }));
        });
        document.getElementById('zkapi-panel-withdrawals')?.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('zkapi-payment-required', {
                detail: { view: 'withdrawals' }
            }));
        });
    }

    async handleRenewApiKey() {
        if (this.isRenewingKey || !this.currentSession) return;
        const session = this.currentSession;
        const reservation = this.app.beginSessionMutation(session.id, { exclusive: true });
        if (!reservation) return;
        this.isRenewingKey = true;
        this.renderTopSectionOnly();
        try {
            this.app.services.inference.clearAccessInfo(session);
            await this.app.data.saveSession(session);
            await this.app.acquireAndSetAccess(session);
            this.loadSessionData();
        } catch (error) {
            this.app.showToast?.(error.message || 'Could not refresh the private key.', 'error');
        } finally {
            this.isRenewingKey = false;
            this.app.endSessionMutation(session.id, reservation);
            this.renderTopSectionOnly();
        }
    }

    applyInvitationCodeFromLink() {
        this.app.accountModal?.open?.('fund');
    }

    destroy() {
        if (this.usageEstimateUpdateTimer) clearTimeout(this.usageEstimateUpdateTimer);
        this.usageEstimateUpdateTimer = null;
        this.zkapiUnsubscribe?.();
        this.zkapiUnsubscribe = null;
        this.zkapiClockUnsubscribe?.();
        this.zkapiClockUnsubscribe = null;
        this.modelBudgetUnsubscribe?.();
        this.modelBudgetUnsubscribe = null;
        super.destroy();
    }
}
