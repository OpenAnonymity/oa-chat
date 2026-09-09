import TicketRightPanel from '../../components/RightPanel.js';
import ZkapiRightPanel from './RightPanel.js';

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
                <div id="zkapi-ticket-closing-notice" class="px-3 pb-3" ${this.isClosingPreviousChat() ? '' : 'hidden'}>
                    <section class="zkapi-panel-experience zkapi-panel-experience--quiet" role="status" aria-live="polite" aria-atomic="true">
                        <div class="zkapi-panel-state-heading">
                            <span class="zkapi-state-spinner" aria-hidden="true"></span>
                            <div><strong>Closing previous chat</strong><p>You can keep using Tickets.</p></div>
                        </div>
                    </section>
                </div>`
            : super.generateFundingSectionHTML();
    }

    fundingSectionIncludesAccessKey() {
        return this.isTicketMode()
            ? TicketRightPanel.prototype.fundingSectionIncludesAccessKey.call(this)
            : super.fundingSectionIncludesAccessKey();
    }

    isClosingPreviousChat() {
        return ['settling', 'waiting'].includes(this.app.integration.getTransition?.()?.phase);
    }

    updateBackgroundClosingNotice() {
        // Settlement events must not remount ticket forms or ephemeral-key
        // controls. Only this keyed notice changes as the private key closes.
        const notice = document.getElementById('zkapi-ticket-closing-notice');
        if (!notice) return;
        const hidden = !this.isClosingPreviousChat();
        if (notice.hidden !== hidden) notice.hidden = hidden;
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
