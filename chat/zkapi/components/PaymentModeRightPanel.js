import TicketRightPanel from '../../components/RightPanel.js';
import ZkapiRightPanel from './RightPanel.js';
import { deriveZkapiUxState } from '../services/zkapiUxState.mjs';
import { attachZkapiSettlementActions, renderZkapiPanelExperience } from './ZkapiStateExperience.js';

export default class PaymentModeRightPanel extends ZkapiRightPanel {
    getAttestationVerifier() {
        return this.isTicketMode() || !this.providerVerifier
            ? super.getAttestationVerifier() : this.providerVerifier;
    }

    isTicketMode() {
        return this.app.integration.getMode(this.currentSession) === 'tickets';
    }

    handleZkapiChange(detail) {
        if (this.isTicketMode()) this.updateBackgroundClosingNotice();
        else super.handleZkapiChange(detail);
    }

    loadSessionData() {
        return this.isTicketMode()
            ? TicketRightPanel.prototype.loadSessionData.call(this)
            : super.loadSessionData();
    }

    generateFundingSectionHTML() {
        return this.isTicketMode()
            ? `${TicketRightPanel.prototype.generateFundingSectionHTML.call(this)}
                <div id="zkapi-ticket-closing-notice" class="zkapi-closing-notice px-3 pb-3" role="status" aria-live="polite" aria-atomic="true" ${this.closingNoticeShown() ? '' : 'hidden'}>
                    ${this.backgroundClosingNoticeHTML()}
                </div>`
            : this.zkapiFundingSectionHTML();
    }

    zkapiFundingSectionHTML() {
        // Back in zkAPI: any earlier close's waiting window is over.
        clearTimeout(this.closingNoticeTimer);
        this.closingNoticeTimer = null;
        this.closingSince = null;
        return super.generateFundingSectionHTML();
    }

    fundingSectionIncludesAccessKey() {
        return this.isTicketMode()
            ? TicketRightPanel.prototype.fundingSectionIncludesAccessKey.call(this)
            : super.fundingSectionIncludesAccessKey();
    }

    isClosingPreviousChat() {
        return ['settling', 'waiting', 'error'].includes(this.app.integration.getTransition?.()?.phase);
    }

    /** Switching to Tickets closes the zkAPI chat key in the background,
     *  usually in well under a second. Saying so for that long reads as a
     *  bubble that flashes and vanishes, so the notice waits a moment and
     *  shows only if closing takes longer (a failure shows at once). */
    closingNoticeShown() {
        const phase = this.app.integration.getTransition?.()?.phase;
        if (!this.isClosingPreviousChat()) {
            clearTimeout(this.closingNoticeTimer);
            this.closingNoticeTimer = null;
            this.closingSince = null;
            return false;
        }
        if (phase === 'error') return true;
        const delay = this.closingNoticeDelayMs ?? 700;
        const now = Date.now();
        this.closingSince ??= now;
        const waited = now - this.closingSince;
        if (waited >= delay) return true;
        if (!this.closingNoticeTimer) {
            this.closingNoticeTimer = setTimeout(() => {
                this.closingNoticeTimer = null;
                this.updateBackgroundClosingNotice();
            }, delay - waited);
            this.closingNoticeTimer?.unref?.();
        }
        return false;
    }

    backgroundClosingNoticeHTML() {
        const state = deriveZkapiUxState({ transition: this.app.integration.getTransition?.() });
        if (!state.closingPrimary) return '';
        return renderZkapiPanelExperience({
            ...state,
            panelPrimary: {
                ...state.closingPrimary,
                detail: state.closingPrimary.tone === 'error'
                    ? `${state.closingPrimary.detail} You can keep using Tickets.`
                    : 'You can keep using Tickets.'
            }
        });
    }

    updateBackgroundClosingNotice() {
        // Settlement events must not remount ticket forms or ephemeral-key
        // controls. Only this keyed notice changes as the private key closes.
        const notice = document.getElementById('zkapi-ticket-closing-notice');
        if (!notice) return;
        const hidden = !this.closingNoticeShown();
        if (notice.hidden !== hidden) notice.hidden = hidden;
        const html = this.backgroundClosingNoticeHTML();
        if (notice.innerHTML !== html) {
            notice.innerHTML = html;
            attachZkapiSettlementActions(notice, this.app);
        }
    }

    getMissingApiKeyStatus() {
        return this.isTicketMode()
            ? TicketRightPanel.prototype.getMissingApiKeyStatus.call(this)
            : super.getMissingApiKeyStatus();
    }

    handleRenewApiKey() {
        return this.isTicketMode()
            ? TicketRightPanel.prototype.handleRenewApiKey.call(this)
            : super.handleRenewApiKey();
    }

    applyInvitationCodeFromLink(...args) {
        return TicketRightPanel.prototype.applyInvitationCodeFromLink.call(this, ...args);
    }

    onRuntimePresentationChange() {
        const mode = this.app.integration.getMode();
        if (this.paymentMode !== mode) {
            this.paymentMode = mode;
            this.currentSession = this.app.getCurrentSession();
            this.loadSessionData();
        }
        if (mode === 'zkapi') super.onRuntimePresentationChange();
        else this.updateBackgroundClosingNotice();
    }
}
