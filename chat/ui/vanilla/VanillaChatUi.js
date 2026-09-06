import RightPanel from '../../components/RightPanel.js';
import MessageNavigation from '../../components/MessageNavigation.js';
import Sidebar from '../../components/Sidebar.js';
import ChatArea from '../../components/ChatArea.js';
import ChatInput from '../../components/ChatInput.js';
import ModelPicker from '../../components/ModelPicker.js';
import ChatHistoryImportModal from '../../components/ChatHistoryImportModal.js';
import AccountModal from '../../components/AccountModal.js';
import MemoryEditor from '../../components/MemoryEditor.js';
import WelcomePanel from '../../components/WelcomePanel.js';
import ThanksPanel from '../../components/ThanksPanel.js';
import InPageFind from '../../components/InPageFind.js';
import shareModals from '../../components/ShareModals.js';
import { buildTypingIndicator, configureMessageTemplateServices } from '../../components/MessageTemplates.js';
import { createVanillaUiInterface } from '../appInterface.js';
import { updateDetailedPendingIndicator } from '../../components/PendingIndicator.js';
import { normalizePendingPhase } from '../../domain/streamingState.js';
import ticketClient from '../../services/ticketClient.js';
import networkLogger from '../../services/networkLogger.js';
import networkProxy from '../../services/networkProxy.js';
import inferenceService from '../../services/inference/inferenceService.js';
import stationVerifier from '../../services/verifier.js';
import shareService from '../../services/shareService.js';
import accountService from '../../services/accountService.js';
import syncService from '../../services/encryptedSyncService.js';

export default class VanillaChatUi {
    constructor(app, options = {}) {
        this.app = app;
        this.componentFactories = options.components || {};
        this.shellMount = options.mountShell || null;
        this.interfaces = createVanillaUiInterface(app, {
            ticketClientImpl: ticketClient,
            networkLoggerImpl: networkLogger,
            networkProxyImpl: networkProxy,
            inferenceServiceImpl: app.inferenceService || inferenceService,
            verifierServiceImpl: stationVerifier,
            shareServiceImpl: shareService,
            accountServiceImpl: accountService,
            syncServiceImpl: syncService,
            ...options
        });
        this.components = null;
        this.shareModals = shareModals;
        this.shareModals.configureServices?.(this.interfaces.componentApp.services);
        configureMessageTemplateServices(this.interfaces.componentApp.services);
    }

    mountShell() {
        if (this.components) {
            return this.components;
        }

        const componentApp = this.interfaces.componentApp;
        const createComponent = (name, Component, facade = componentApp) => {
            const factory = this.componentFactories[name];
            return typeof factory === 'function' ? factory(facade) : new Component(facade);
        };
        this.components = {
            inPageFind: new InPageFind(),
            sidebar: new Sidebar(this.interfaces.sidebar),
            chatArea: new ChatArea(componentApp),
            chatInput: new ChatInput(componentApp),
            modelPicker: new ModelPicker(this.interfaces.modelPicker),
            chatHistoryImportModal: new ChatHistoryImportModal(componentApp),
            accountModal: createComponent('accountModal', AccountModal),
            memoryEditor: new MemoryEditor(componentApp),
            welcomePanel: createComponent('welcomePanel', WelcomePanel),
            thanksPanel: new ThanksPanel(componentApp),
            rightPanel: createComponent('rightPanel', RightPanel)
        };
        this.components.rightPanel.mount();
        this.shellMount?.();
        return this.components;
    }

    mountMessageNavigation() {
        if (!this.components) {
            throw new Error('Cannot mount message navigation before shell components.');
        }
        if (!this.components.messageNavigation) {
            this.components.messageNavigation = new MessageNavigation(this.interfaces.componentApp);
        }
        return this.components.messageNavigation;
    }

    buildTypingIndicator(...args) {
        return buildTypingIndicator(...args);
    }

    updatePendingIndicator(indicator, phase, progress = null) {
        if (!indicator) return;
        const normalizedPhase = normalizePendingPhase(phase);
        const presenter = this.interfaces.componentApp.services.presentation;
        const presentation = presenter?.getPendingPresentation?.(normalizedPhase, progress);
        if (presentation) {
            updateDetailedPendingIndicator(indicator, presentation, normalizedPhase);
            return;
        }
        if (indicator.dataset.phase === normalizedPhase) return;
        indicator.dataset.phase = normalizedPhase;
        const label = indicator.querySelector('.pending-response-label');
        if (label) {
            label.textContent = normalizedPhase === 'waiting-response'
                ? 'Waiting for response' : 'Requesting ephemeral key';
            label.classList.add('pending-response-streaming');
        }
    }
}
