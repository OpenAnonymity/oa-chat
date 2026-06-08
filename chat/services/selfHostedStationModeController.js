import { PREF_KEYS } from './preferencesStore.js';
import accountService from './accountService.js';
import ticketClient from './ticketClient.js';
import stationVerifier from './verifier.js';
import networkProxy from './networkProxy.js';
import shareModals from '../components/ShareModals.js';
import { chatDB } from '../db.js';

const TOAST_MESSAGES = {
    modeEnabled: 'Self-hosted station mode enabled. Org features are disabled.',
    modeDisabled: 'Self-hosted station mode disabled. Org features are enabled.',
    shareLinksUnavailable: 'Share links are unavailable in self-hosted station mode.',
    shareUnavailable: 'Sharing is unavailable in self-hosted station mode.',
    shareImportUnavailable: 'Share import is unavailable in self-hosted station mode.'
};

const MODE_TOGGLE_TOAST_DURATION_MS = 4000;

class SelfHostedStationModeController {
    constructor(app) {
        this.app = app;
        this.enabled = ticketClient.isSelfHostedStationModeEnabled();
        this.stationUrl = ticketClient.getSelfHostedStationBaseUrl();
        this.installMethodGuards();
    }

    isEnabled() {
        return !!this.enabled;
    }

    isOrgFeaturesDisabled() {
        return this.isEnabled();
    }

    refreshStationUrl() {
        this.stationUrl = ticketClient.getSelfHostedStationBaseUrl();
        return this.stationUrl;
    }

    applyUiState() {
        this.refreshStationUrl();

        const accountBtn = document.getElementById('account-tab-btn');
        if (accountBtn) {
            accountBtn.classList.toggle('hidden', this.isOrgFeaturesDisabled());
        }

        if (this.isOrgFeaturesDisabled()) {
            this.app.accountModal?.close?.();
            if (shareModals.currentModal) {
                shareModals.cleanup();
            }
        }

        this.app.accountModal?.updateTabIndicator?.();
        this.app.updateShareButtonUI();
    }

    handlePreferenceChange(key, value) {
        if (key === PREF_KEYS.selfHostedStationMode) {
            void this.handleModeChange(!!value, { notify: true }).catch((error) => {
                console.warn('Failed to update self-hosted station mode:', error);
            });
            return true;
        }

        if (key === PREF_KEYS.selfHostedStationUrl) {
            this.refreshStationUrl();
            if (this.app.rightPanel) {
                this.app.rightPanel.renderTopSectionOnly();
            }
            return true;
        }

        return false;
    }

    async initAccountServiceIfAllowed(options = {}) {
        const {
            deferAutoUnlock = false,
            warningContext = null
        } = options;

        if (this.isOrgFeaturesDisabled()) {
            return;
        }

        try {
            await accountService.init();
            if (deferAutoUnlock) {
                if (typeof requestIdleCallback === 'function') {
                    requestIdleCallback(() => accountService.maybeAutoUnlock());
                } else {
                    setTimeout(() => accountService.maybeAutoUnlock(), 800);
                }
            } else {
                accountService.maybeAutoUnlock();
            }
        } catch (error) {
            if (warningContext) {
                console.warn(`Account init failed ${warningContext}:`, error);
            } else {
                console.warn('Account init failed:', error);
            }
        }
    }

    async handleModeChange(enabled, options = {}) {
        const { notify = false } = options;
        const normalizedEnabled = !!enabled;
        const wasEnabled = this.enabled;

        this.enabled = normalizedEnabled;
        this.refreshStationUrl();
        this.applyUiState();

        if (this.app.sidebar) {
            this.app.renderSessions();
        }

        if (this.enabled) {
            stationVerifier.stopBroadcastCheck();
            try {
                await networkProxy.updateSettings(
                    { enabled: false },
                    { allowDisableDuringActiveRequests: true }
                );
            } catch (error) {
                console.warn('Failed to disable proxy for self-hosted station mode:', error);
            }
        } else {
            this.app.initVerifier();
            await this.initAccountServiceIfAllowed({
                warningContext: 'after disabling self-hosted mode'
            });
        }

        if (notify && wasEnabled !== this.enabled) {
            this.app.showToast(
                this.enabled ? TOAST_MESSAGES.modeEnabled : TOAST_MESSAGES.modeDisabled,
                'success',
                MODE_TOGGLE_TOAST_DURATION_MS
            );
        }
    }

    installMethodGuards() {
        this.wrapMethod('checkForUrlSession', (original) => async (...args) => {
            if (!this.isOrgFeaturesDisabled()) {
                return original(...args);
            }

            const params = new URLSearchParams(window.location.search);
            const sessionId = params.get('s');
            if (!sessionId) {
                return original(...args);
            }

            const normalizedInput = this.app.normalizeId(sessionId);
            let localSessionById = this.app.state.sessions.find(
                (session) => this.app.normalizeId(session.id) === normalizedInput
            );

            if (!localSessionById) {
                const directSession = await chatDB.getSession(sessionId);
                if (directSession && this.app.normalizeId(directSession.id) === normalizedInput) {
                    localSessionById = directSession;
                    this.app.insertSessionIntoList(directSession);
                }
            }

            if (localSessionById) {
                await this.app.switchSession(localSessionById.id);
                return;
            }

            window.history.replaceState({}, '', window.location.pathname);
            this.app.showToast(TOAST_MESSAGES.shareLinksUnavailable, 'error');
        });

        this.wrapMethod('checkForShareUpdates', (original) => async (shareId, existingSession) => {
            if (this.isOrgFeaturesDisabled()) {
                await this.app.switchSession(existingSession.id);
                return;
            }
            return original(shareId, existingSession);
        });

        this.wrapMethod('verifySharedAccess', (original) => async (sharedAccess) => {
            if (this.isOrgFeaturesDisabled()) {
                return null;
            }
            return original(sharedAccess);
        });

        this.wrapMethod('importSharedSessionWithData', (original) => async (shareId, encryptedData) => {
            if (this.isOrgFeaturesDisabled()) {
                this.app.showToast(TOAST_MESSAGES.shareImportUnavailable, 'error');
                return;
            }
            return original(shareId, encryptedData);
        });

        this.wrapMethod('importSharedSession', (original) => async (shareId) => {
            if (this.isOrgFeaturesDisabled()) {
                this.app.showToast(TOAST_MESSAGES.shareImportUnavailable, 'error');
                return;
            }
            return original(shareId);
        });

        this.wrapMethod('shareCurrentSession', (original) => async (...args) => {
            if (this.isOrgFeaturesDisabled()) {
                this.app.showToast(TOAST_MESSAGES.shareUnavailable, 'error');
                return null;
            }
            return original(...args);
        });

        this.wrapMethod('shareCurrentSessionWithSettings', (original) => async (...args) => {
            if (this.isOrgFeaturesDisabled()) {
                this.app.showToast(TOAST_MESSAGES.shareUnavailable, 'error');
                return null;
            }
            return original(...args);
        });

        this.wrapMethod('deleteCurrentSessionShare', (original) => async (...args) => {
            if (this.isOrgFeaturesDisabled()) {
                this.app.showToast(TOAST_MESSAGES.shareUnavailable, 'error');
                return;
            }
            return original(...args);
        });

        this.wrapMethod('showShareManagementModal', (original) => async (...args) => {
            if (this.isOrgFeaturesDisabled()) {
                this.app.showToast(TOAST_MESSAGES.shareUnavailable, 'error');
                return;
            }
            return original(...args);
        });

        this.wrapMethod('updateShareButtonUI', (original) => () => {
            if (this.isOrgFeaturesDisabled()) {
                const btn = this.app.elements?.shareBtn;
                if (!btn) return;
                btn.classList.add('hidden');
                btn.classList.remove('flex');
                return;
            }
            return original();
        });

        this.wrapMethod('initVerifier', (original) => () => {
            if (this.isOrgFeaturesDisabled()) {
                stationVerifier.stopBroadcastCheck();
                return;
            }
            return original();
        });
    }

    wrapMethod(methodName, createWrappedMethod) {
        const original = this.app[methodName];
        if (typeof original !== 'function') {
            return;
        }

        const boundOriginal = original.bind(this.app);
        this.app[methodName] = createWrappedMethod(boundOriginal);
    }
}

export default SelfHostedStationModeController;
