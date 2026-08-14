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
        this.interfaces = createVanillaUiInterface(app, {
            ticketClientImpl: ticketClient,
            networkLoggerImpl: networkLogger,
            networkProxyImpl: networkProxy,
            inferenceServiceImpl: inferenceService,
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
        this.components = {
            inPageFind: new InPageFind(),
            sidebar: new Sidebar(this.interfaces.sidebar),
            chatArea: new ChatArea(componentApp),
            chatInput: new ChatInput(componentApp),
            modelPicker: new ModelPicker(this.interfaces.modelPicker),
            chatHistoryImportModal: new ChatHistoryImportModal(componentApp),
            accountModal: new AccountModal(componentApp),
            memoryEditor: new MemoryEditor(componentApp),
            welcomePanel: new WelcomePanel(componentApp),
            thanksPanel: new ThanksPanel(componentApp),
            rightPanel: new RightPanel(componentApp)
        };
        this.components.rightPanel.mount();
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
}
