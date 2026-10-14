import TicketRightPanel from '../../components/RightPanel.js';
import ZkapiRightPanel from './RightPanel.js';
import { deriveZkapiUxState } from '../services/zkapiUxState.mjs';
import { attachZkapiSettlementActions, renderZkapiPanelExperience } from './ZkapiStateExperience.js';
import { attachVersionNotices } from './VersionNotices.js';

export default class PaymentModeRightPanel extends ZkapiRightPanel {
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
                <div id="zkapi-ticket-closing-notice" class="px-3 pb-3" role="status" aria-live="polite" aria-atomic="true" ${this.isClosingPreviousChat() ? '' : 'hidden'}>
                    ${this.backgroundClosingNoticeHTML()}
                </div>${this.upgradeNoticeSlotHTML()}`
            : super.generateFundingSectionHTML();
    }

    // The protocol-version reminder of a zkAPI balance, shown while the
    // current chat pays with tickets. Keyed like the closing notice above: its
    // slot exists whenever the build has versions (hidden when empty), so a
    // later change only patches it and never remounts the ticket controls.
    // Static text, no live region: a reminder is not an announcement. A build
    // with one version renders no slot, so today's ticket panel is unchanged.
    upgradeNoticeBannerHTML(now = Date.now()) {
        const view = this.versionView(now);
        if (!view) return '';
        try {
            return view.ui.banner?.(view.state, { surface: 'ticket', now }) || '';
        } catch {
            return '';
        }
    }

    upgradeNoticeSlotHTML() {
        if (!this.versionFacade()) return '';
        const html = this.upgradeNoticeBannerHTML();
        // What the slot holds, to tell a real change from the browser's own
        // re-serialization of the same markup.
        this.renderedUpgradeNotice = html;
        return `<div id="zkapi-upgrade-notice" class="px-3 pb-3" ${html ? '' : 'hidden'}>${html}</div>`;
    }

    updateUpgradeNotice() {
        // No lookup at all without versions: the keyed closing notice is the
        // only element this panel's tests and ticket mode ever resolve.
        if (!this.versionFacade()) return;
        const notice = document.getElementById('zkapi-upgrade-notice');
        if (!notice) return;
        const html = this.upgradeNoticeBannerHTML();
        const hidden = !html;
        if (notice.hidden !== hidden) notice.hidden = hidden;
        if (html !== this.renderedUpgradeNotice) {
            this.renderedUpgradeNotice = html;
            notice.innerHTML = html;
            attachVersionNotices(notice, this.versionActionContext());
        }
    }

    versionSurface() {
        return this.isTicketMode() ? 'ticket' : 'panel';
    }

    handleVersionChange() {
        if (this.isTicketMode()) this.updateUpgradeNotice();
        else super.handleVersionChange();
    }

    refreshVersionNotices() {
        if (this.isTicketMode()) this.updateUpgradeNotice();
        else super.refreshVersionNotices();
    }

    fundingSectionIncludesAccessKey() {
        return this.isTicketMode()
            ? TicketRightPanel.prototype.fundingSectionIncludesAccessKey.call(this)
            : super.fundingSectionIncludesAccessKey();
    }

    isClosingPreviousChat() {
        return ['settling', 'waiting', 'error'].includes(this.app.integration.getTransition?.()?.phase);
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
        const hidden = !this.isClosingPreviousChat();
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
