import AccountModal from '../../components/AccountModal.js';
import { ETHEREUM_MARK, OA_MARK } from './paymentModeMarks.js';
import WelcomePanel from '../../components/WelcomePanel.js';
import ZkapiAccountModal from '../components/AccountModal.js';
import PaymentModeRightPanel from '../components/PaymentModeRightPanel.js';
import { createZkapiUi } from './createZkapiUi.js';
import { applyZkapiModeClass } from '../services/zkapiModeClass.js';

/** Keep the payment choice in the toolbar and funding in the System Panel. */
export function createPaymentModeUi(runtime) {
    const zkUi = createZkapiUi(runtime);
    let app;
    let privateBalance;
    let modeControl;

    function renderControls() {
        if (!app || !modeControl) return;
        const mode = runtime.getMode();
        // zkAPI has its own colour axis: while the current chat pays with
        // zkAPI the shared Light/Dark choice resolves to purple / night.
        applyZkapiModeClass(document.documentElement, mode);
        const busy = runtime.isModeLocked();
        modeControl.setAttribute('aria-busy', runtime.isSwitching() ? 'true' : 'false');
        for (const button of modeControl.querySelectorAll('[data-payment-mode]')) {
            button.setAttribute('aria-pressed', String(button.dataset.paymentMode === mode));
            button.disabled = busy;
            // No app tooltip: the toolbar clips overflow, so one drawn below
            // the control showed as a stray hairline on hover. The native
            // title names the icon; the busy case is explained by the composer.
            delete button.dataset.tooltip;
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
            // Icons, not words: OA's square for tickets, the Ethereum diamond
            // for zkAPI. The name lives in aria-label and a native title (the
            // toolbar clips the app tooltip; a title is never clipped).
            modeControl.innerHTML = `<button type="button" id="payment-mode-tickets" data-payment-mode="tickets" aria-pressed="false" aria-label="OA tickets" title="OA tickets">${OA_MARK}</button><button type="button" id="payment-mode-zkapi" data-payment-mode="zkapi" aria-pressed="false" aria-label="zkAPI" title="zkAPI">${ETHEREUM_MARK}</button>`;
            modeControl.addEventListener('click', async event => {
                const button = event.target.closest('[data-payment-mode]');
                if (!button || button.disabled) return;
                try {
                    await runtime.changeMode(button.dataset.paymentMode);
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
