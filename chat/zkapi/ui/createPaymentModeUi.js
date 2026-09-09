import AccountModal from '../../components/AccountModal.js';
import WelcomePanel from '../../components/WelcomePanel.js';
import ZkapiAccountModal from '../components/AccountModal.js';
import PaymentModeRightPanel from '../components/PaymentModeRightPanel.js';
import { createZkapiUi } from './createZkapiUi.js';
import themeManager from '../../services/themeManager.js';
import { applyZkapiDefaultTheme as applyDefaultTheme } from '../services/zkapiDefaultTheme.js';

const applyZkapiDefaultTheme = () => applyDefaultTheme(globalThis.localStorage, themeManager);

/** Keep the payment choice in the toolbar and funding in the System Panel. */
export function createPaymentModeUi(runtime) {
    const zkUi = createZkapiUi(runtime);
    let app;
    let privateBalance;
    let modeControl;

    function renderControls() {
        if (!app || !modeControl) return;
        const mode = runtime.getMode();
        const busy = runtime.isModeLocked();
        modeControl.setAttribute('aria-busy', runtime.isSwitching() ? 'true' : 'false');
        for (const button of modeControl.querySelectorAll('[data-payment-mode]')) {
            button.setAttribute('aria-pressed', String(button.dataset.paymentMode === mode));
            button.disabled = busy;
            button.dataset.tooltip = busy ? 'Finish or stop the current response to switch payment methods.'
                : `Use ${button.dataset.paymentMode === 'zkapi' ? 'zkAPI' : 'tickets'} for this chat and new chats. Your history stays the same.`;
            button.removeAttribute('title');
        }
    }

    return {
        integration: { ...zkUi.integration, getMode: session => runtime.getMode(session) },
        components: {
            accountModal(facade) {
                app = facade;
                const account = new AccountModal(facade);
                // This runtime capability is invoked by zkAPI preflight. Its
                // destination must not change when the user navigates away.
                account.openFunding = () => privateBalance?.open('fund');
                return account;
            },
            welcomePanel(facade) {
                // First paint stays in chat so both methods are discoverable.
                // The existing ticket onboarding remains available on demand.
                const welcome = new WelcomePanel(facade);
                welcome.init = async () => {};
                return welcome;
            },
            rightPanel: facade => new PaymentModeRightPanel(facade)
        },
        mountShell() {
            document.getElementById('chat-toolbar').classList.add('payment-mode-toolbar');
            const panelToggle = document.getElementById('show-right-panel-btn');
            modeControl = document.createElement('div');
            modeControl.className = 'payment-mode-control';
            modeControl.setAttribute('role', 'group');
            modeControl.setAttribute('aria-label', 'Chat payment method');
            modeControl.innerHTML = '<button type="button" id="payment-mode-tickets" data-payment-mode="tickets" aria-pressed="false">Tickets</button><button type="button" id="payment-mode-zkapi" data-payment-mode="zkapi" aria-pressed="false">zkAPI</button>';
            modeControl.addEventListener('click', async event => {
                const button = event.target.closest('[data-payment-mode]');
                if (!button || button.disabled) return;
                try {
                    await runtime.changeMode(button.dataset.paymentMode);
                    if (runtime.getMode() === 'zkapi') applyZkapiDefaultTheme();
                } catch (error) { app.showToast(error.message || 'Could not switch payment method. Please try again.', 'error'); }
                renderControls();
            });
            panelToggle.before(modeControl);
            const overlay = document.createElement('div');
            overlay.id = 'payment-balance-modal';
            overlay.className = document.getElementById('account-modal').className;
            overlay.classList.add('hidden');
            document.body.append(overlay);
            // Payment selection, System Panel actions and send preflight open it.
            privateBalance = new ZkapiAccountModal(app, { triggerId: null, overlayId: 'payment-balance-modal' });
            privateBalance.updateTabIndicator = renderControls;
            renderControls();
            if (runtime.getMode() === 'zkapi') applyZkapiDefaultTheme();
        },
        presentation: {
            getPendingPresentation: (phase, progress) => runtime.getMode() === 'zkapi'
                ? zkUi.presentation.getPendingPresentation(phase, progress) : null,
            getModelPricing: (model, options) => runtime.getMode() === 'zkapi'
                ? zkUi.presentation.getModelPricing(model, options) : null,
            getSessionStatus: session => runtime.getSessionStatus(session),
            renderComposer: renderControls
        }
    };
}
