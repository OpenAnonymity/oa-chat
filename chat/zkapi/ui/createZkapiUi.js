import AccountModal from '../components/AccountModal.js';
import WelcomePanel from '../components/WelcomePanel.js';
import RightPanel from '../components/RightPanel.js';
import { renderZkapiComposerStatus, updateZkapiBalanceControl } from '../components/ZkapiStateExperience.js';
import { derivePendingIndicatorPresentation } from '../domain/streamingState.js';
import { formatModelPricing, formatExactTokenPricing } from '../services/modelPricing.mjs';
import { formatModelBudgetUsd, getModelBudget } from '../services/zkapiModelBudget.mjs';
import { mountZkapiShell } from '../components/ZkapiShell.js';

/** Compose payment surfaces with the shared OA renderer. No shared UI source is
 * copied or patched by the build, and no wallet material enters the chat UI API. */
export function createZkapiUi(runtime) {
    let componentApp = null;
    const capture = (app, Component) => {
        componentApp = app;
        return new Component(app);
    };
    const integration = {
        getTransition: () => runtime.getTransition?.() || null,
        getSessionUsageSummary: session => runtime.getSessionUsageSummary?.(session) || null
    };
    return {
        integration,
        mountShell() {
            const balance = mountZkapiShell(document, () => componentApp);
            if (balance && componentApp) updateZkapiBalanceControl(balance, componentApp);
        },
        components: {
            accountModal: app => capture(app, AccountModal),
            welcomePanel: app => capture(app, WelcomePanel),
            rightPanel: app => capture(app, RightPanel)
        },
        presentation: {
            getPendingPresentation(phase, progress) {
                const paymentPhase = phase === 'preparing-access'
                    ? progress?.kind === 'settlement' ? 'settling-previous' : 'requesting-key'
                    : phase;
                return derivePendingIndicatorPresentation(paymentPhase, progress);
            },
            getModelPricing(model, { reasoningEnabled = componentApp?.reasoningEnabled ?? true } = {}) {
                let budget;
                try { budget = getModelBudget(model?.id, reasoningEnabled); }
                catch {
                    return {
                        label: 'Private-key budget unavailable',
                        description: 'A private-key budget has not been configured for this model tier. Choose another model.'
                    };
                }
                const limit = formatModelBudgetUsd(budget.spendingLimitUsd);
                const rates = formatModelPricing(model?.pricing) || 'Pricing unavailable';
                return {
                    balanceBadgeLabel: `≥ ${limit}`,
                    balanceBadgeTooltip: `Requires a private balance of at least ${limit} for a new key. Only actual usage is deducted.`,
                    label: rates,
                    description: formatExactTokenPricing(model?.pricing)
                        || 'The provider did not publish token pricing for this model.'
                };
            },
            getSessionStatus: session => runtime.getSessionStatus?.(session) || null,
            renderComposer() {
                if (!componentApp) return;
                let status = document.getElementById('zkapi-composer-status');
                if (!status) {
                    const actions = document.querySelector('.composer-bottom-actions');
                    if (actions) {
                        status = document.createElement('div');
                        status.id = 'zkapi-composer-status';
                        status.className = 'hidden';
                        status.setAttribute('aria-live', 'off');
                        actions.before(status);
                    }
                }
                renderZkapiComposerStatus(status, componentApp);
                const balanceButton = document.getElementById('account-tab-btn');
                if (balanceButton) updateZkapiBalanceControl(balanceButton, componentApp);
            }
        }
    };
}

export default createZkapiUi;
