import { slideTabs } from '../../ui/uiMotion.js';
import AccountModal from '../../components/AccountModal.js';
import { ETHEREUM_MARK, OA_MARK } from './paymentModeMarks.js';
import WelcomePanel from '../../components/WelcomePanel.js';
import ZkapiAccountModal from '../components/AccountModal.js';
import PaymentModeRightPanel from '../components/PaymentModeRightPanel.js';
import { createZkapiUi } from './createZkapiUi.js';
import { applyZkapiModeClass } from '../services/zkapiModeClass.js';
import { getZkapiExperience, renderZkapiComposerStatus } from '../components/ZkapiStateExperience.js';

/** Keep the payment choice in the toolbar and funding in the System Panel. */
export function createPaymentModeUi(runtime) {
    const zkUi = createZkapiUi(runtime);
    let app;
    let privateBalance;
    let modeControl;

    function renderSettlementComposer() {
        if (!app) return;
        const showSettlement = runtime.getMode() === 'zkapi'
            && ['settling', 'waiting', 'error'].includes(runtime.getTransition?.()?.phase);
        let status = document.getElementById('zkapi-composer-status');
        if (!status && showSettlement) {
            const actions = document.querySelector('.composer-bottom-actions');
            if (actions) {
                status = document.createElement('div');
                status.id = 'zkapi-composer-status';
                status.setAttribute('aria-live', 'off');
                actions.before(status);
            }
        }
        if (!status) return;
        const state = getZkapiExperience(app);
        renderZkapiComposerStatus(status, app, {
            ...state,
            showComposer: showSettlement,
            composerPrimary: showSettlement ? state.closingPrimary
                : { ...state.composerPrimary, busy: false },
            balancePrimary: { ...state.balancePrimary, busy: false }
        });
    }

    function renderControls() {
        if (!app || !modeControl) return;
        const pill = modeControl.querySelector('.t-tabs-pill');
        const previous = pill ? { width: pill.style.width, transform: pill.style.transform } : null;
        const mode = runtime.getMode();
        // zkAPI has its own colour axis: while the current chat pays with
        // zkAPI the shared Light/Dark choice resolves to purple / night.
        applyZkapiModeClass(document.documentElement, mode);
        const busy = runtime.isModeLocked();
        modeControl.setAttribute('aria-busy', runtime.isSwitching() ? 'true' : 'false');
        for (const button of modeControl.querySelectorAll('[data-payment-mode]')) {
            button.setAttribute('aria-pressed', String(button.dataset.paymentMode === mode));
            button.disabled = busy;
        }
        slideTabs(modeControl, previous);
        privateBalance?.restorePendingOperation();
        renderSettlementComposer();
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
            const toolbarAnchor = document.getElementById('chat-toolbar-panel-space');
            modeControl = document.createElement('div');
            modeControl.className = 'payment-mode-control';
            modeControl.setAttribute('role', 'group');
            modeControl.setAttribute('aria-label', 'Chat payment method');
            // Visible names distinguish the two methods; hover explains each one.
            // Portaled tooltips sit below the switch and extend left without clipping.
            modeControl.innerHTML = `<button type="button" id="payment-mode-tickets" data-payment-mode="tickets" aria-pressed="false" aria-label="OA tickets" data-info-tooltip="The Open Anonymity Project">${OA_MARK}<span class="payment-mode-label">OA</span></button><button type="button" id="payment-mode-zkapi" data-payment-mode="zkapi" aria-pressed="false" aria-label="zkAPI" data-info-tooltip="Ethereum Foundation zkAPI">${ETHEREUM_MARK}<span class="payment-mode-label">zkAPI</span></button>`;
            modeControl.addEventListener('click', async event => {
                const button = event.target.closest('[data-payment-mode]');
                if (!button || button.disabled) return;
                try {
                    await runtime.changeMode(button.dataset.paymentMode);
                } catch (error) { app.showToast(error.message || 'Could not switch payment method. Please try again.', 'error'); }
                renderControls();
            });
            toolbarAnchor.before(modeControl);
            window.addEventListener('resize', () => slideTabs(modeControl));
            const overlay = document.createElement('div');
            overlay.id = 'payment-balance-modal';
            overlay.className = document.getElementById('account-modal').className;
            overlay.classList.add('hidden');
            document.body.append(overlay);
            // Payment selection, System Panel actions and send preflight open it.
            privateBalance = new ZkapiAccountModal(app, {
                triggerId: null,
                overlayId: 'payment-balance-modal',
                // Saved wallet progress reopens after a reload only while the
                // current chat pays with zkAPI; a tickets chat never sees it.
                canRestore: () => !app.restoringInitialConversation && runtime.getMode() === 'zkapi'
            });
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
