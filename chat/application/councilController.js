import { chatDB as defaultChatDB } from '../db.js';
import { parseReasoningContent } from '../services/reasoningParser.js';
import { persistVerifierSubmitKeyProof } from './accessController.js';
import {
    RESPONSE_MODE_COUNCIL,
    buildCouncilMembersForSession,
    normalizeCouncilConfig
} from '../domain/councilConfig.js';

const SAVE_INTERVAL_MS = 350;
const LANE_IDS = ['primary', 'secondary'];

function isAbortError(error) {
    return error?.name === 'AbortError' || error?.isCancelled || error?.message === 'AbortError';
}

function buildCouncilLabel(index) {
    return `Response ${String.fromCharCode(65 + index)}`;
}

function extractResponseContent(result) {
    if (typeof result?.content === 'string') return result.content;
    const message = result?.data?.choices?.[0]?.message;
    if (typeof message?.content === 'string') return message.content;
    return '';
}

function extractReasoning(result) {
    const message = result?.data?.choices?.[0]?.message;
    const reasoning = message?.reasoning || message?.reasoning_details || null;
    return typeof reasoning === 'string' ? parseReasoningContent(reasoning) : null;
}

function extractCitations(result) {
    const annotations = result?.data?.choices?.[0]?.message?.annotations;
    if (!Array.isArray(annotations)) return null;

    const seen = new Set();
    const citations = [];
    for (const annotation of annotations) {
        const citation = annotation?.url_citation || annotation?.citation || null;
        const url = citation?.url;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        citations.push({
            url,
            title: citation?.title || url,
            content: citation?.content || citation?.snippet || '',
            index: citations.length + 1
        });
    }
    return citations.length > 0 ? citations : null;
}

export default class CouncilController {
    constructor({ app, chatDB = defaultChatDB, inferenceService = null, ticketClient = null }) {
        this.app = app;
        this.chatDB = chatDB;
        this.inferenceService = inferenceService;
        this.ticketClient = ticketClient;
    }

    async runSendTurn(options) {
        return this.runMultiModelTurn(options);
    }

    async runRegenerateTurn(options) {
        const { session, userMessage } = options;
        if (session?.id && userMessage?.id) {
            await this.removeAssistantMessagesAfter(session.id, userMessage.id);
        }
        return this.runMultiModelTurn(options);
    }

    async removeAssistantMessagesAfter(sessionId, userMessageId) {
        const messages = await this.chatDB.getSessionMessages(sessionId);
        const userIndex = messages.findIndex((message) => message.id === userMessageId);
        if (userIndex === -1) return;
        const laterMessages = messages.slice(userIndex + 1);
        await Promise.all(
            laterMessages
                .filter((message) => message.role === 'assistant')
                .map((message) => this.chatDB.deleteMessage(message.id))
        );
        if (this.app.isViewingSession(sessionId)) {
            await this.app.chatArea?.render();
        }
    }

    resolveModelEntries(session) {
        const fallbackModelName = this.app.normalizeModelName(session?.model)
            || session?.model
            || this.inferenceService.getDefaultModelName(session);
        const normalizedConfig = normalizeCouncilConfig(session?.councilConfig, fallbackModelName);
        const requestedNames = [
            fallbackModelName,
            ...buildCouncilMembersForSession(
                { ...session, councilConfig: normalizedConfig },
                fallbackModelName
            ).filter((modelName) => modelName !== fallbackModelName)
        ].slice(0, 2);

        const entries = [];
        const seenIds = new Set();
        for (const name of requestedNames) {
            const normalizedName = this.app.normalizeModelName(name) || name;
            const modelEntry = this.app.state.models.find((model) => model.name === normalizedName)
                || this.app.state.models.find((model) => model.id === name)
                || this.app.state.models.find((model) => model.id === normalizedName);
            if (!modelEntry || seenIds.has(modelEntry.id)) continue;
            seenIds.add(modelEntry.id);
            entries.push({
                ...modelEntry,
                laneId: LANE_IDS[entries.length] || `lane-${entries.length + 1}`
            });
            if (entries.length >= 2) break;
        }

        if (entries.length === 0) {
            const fallbackEntry = this.app.getFallbackModelEntry(session);
            if (fallbackEntry) entries.push({ ...fallbackEntry, laneId: 'primary' });
        }

        return entries;
    }

    ensureCouncilAccessContainer(session) {
        if (!session.councilAccess || typeof session.councilAccess !== 'object') {
            session.councilAccess = {};
        }
        return session.councilAccess;
    }

    getLaneAccess(session, laneId) {
        const lane = session?.councilAccess?.[laneId];
        return lane && typeof lane === 'object' ? lane : null;
    }

    setLaneAccess(session, laneId, accessInfo = {}) {
        const container = this.ensureCouncilAccessContainer(session);
        const token = accessInfo.key || accessInfo.token || accessInfo.apiKey || null;
        container[laneId] = {
            apiKey: token,
            apiKeyInfo: accessInfo.apiKeyInfo || accessInfo.info || accessInfo,
            expiresAt: accessInfo.expiresAt || accessInfo.expires_at || accessInfo.apiKeyInfo?.expiresAt || null,
            modelId: accessInfo.modelId || null,
            ticketsConsumed: accessInfo.ticketsConsumed || accessInfo.tickets_consumed || accessInfo.ticketsUsed?.length || null,
            updatedAt: Date.now()
        };
        return container[laneId];
    }

    clearLaneAccess(session, laneId) {
        const container = this.ensureCouncilAccessContainer(session);
        container[laneId] = {
            apiKey: null,
            apiKeyInfo: null,
            expiresAt: null,
            modelId: null,
            updatedAt: Date.now()
        };
    }

    isLaneAccessExpired(laneAccess) {
        if (!laneAccess?.apiKey) return true;
        if (!laneAccess.expiresAt) return true;
        return new Date(laneAccess.expiresAt) <= new Date();
    }

    buildLaneSession(session, laneId) {
        const laneAccess = this.getLaneAccess(session, laneId);
        return {
            ...session,
            apiKey: laneAccess?.apiKey || null,
            apiKeyInfo: laneAccess?.apiKeyInfo || null,
            expiresAt: laneAccess?.expiresAt || null
        };
    }

    getTicketCostForEntry(entry) {
        if (!entry?.id) return 1;
        if (typeof this.app.getTicketCost === 'function') {
            return this.app.getTicketCost(entry.id, this.app.reasoningEnabled);
        }
        return 1;
    }

    calculateCouncilTicketRequirement(entries) {
        return entries.reduce((total, entry) => total + this.getTicketCostForEntry(entry), 0);
    }

    needsFreshLaneAccess(session, entry) {
        const laneAccess = this.getLaneAccess(session, entry.laneId);
        return !(laneAccess?.apiKey && laneAccess.modelId === entry.id && !this.isLaneAccessExpired(laneAccess));
    }

    async requestLaneAccess(session, entry, typingId) {
        const ticketsRequired = Math.max(1, this.getTicketCostForEntry(entry));
        const availableTickets = this.ticketClient.getTicketCount();
        if (availableTickets < ticketsRequired) {
            throw new Error(`Not enough tickets for ${entry.name}. Need ${ticketsRequired}, but only ${availableTickets} available.`);
        }

        const accessLabel = this.inferenceService.getAccessLabel(session);
        if (this.app.floatingPanel) {
            this.app.floatingPanel.showMessage(`Acquiring ${accessLabel} for ${entry.name}...`, 'info');
        }

        if (typeof window !== 'undefined' && window.networkLogger) {
            window.networkLogger.setCurrentSession(session.id);
        }

        let result = null;
        let retries = 0;
        const maxRetries = Math.min(availableTickets, ticketsRequired + 10);
        while (retries < maxRetries) {
            try {
                result = await this.inferenceService.requestAccess(session, { ticketsRequired });
                break;
            } catch (error) {
                if (error.code === 'TICKET_USED') {
                    retries += 1;
                    this.app.showToast?.('Ticket already used, trying next available');
                    continue;
                }
                console.error('Failed to acquire council lane access:', error);
                throw error;
            }
        }
        if (!result) {
            throw new Error('All available tickets were already spent');
        }

        if (typingId) {
            try {
                this.app.advancePendingStateAfterAccessGranted(session.id, typingId);
            } catch (error) {
                console.warn('Pending-state update after access grant failed:', error);
            }
        }

        const laneSession = {
            ...session,
            apiKey: null,
            apiKeyInfo: null,
            expiresAt: null
        };
        this.inferenceService.setAccessInfo(laneSession, result);

        const verifier = this.inferenceService.getVerificationAdapter(session);
        if (verifier?.supports) {
            const laneInfo = this.inferenceService.getAccessInfo(laneSession);
            const verifyResult = await this.inferenceService.verifyAccess(session, laneInfo?.info);
            persistVerifierSubmitKeyProof(laneSession, verifyResult);

            if (verifyResult?.status === 'rejected') {
                const errorMsg = verifyResult.error?.message || 'Verification failed';
                if (verifyResult.bannedStation) {
                    const banned = verifyResult.bannedStation;
                    throw new Error(`Station ${banned.stationId} is banned: ${banned.reason || 'Unknown reason'}`);
                }
                throw new Error(`Key verification failed: ${errorMsg}`);
            }

            if (verifyResult?.status === 'unverified') {
                console.warn('Council lane key verification unverified, continuing without verification');
            }

            this.inferenceService.setCurrentAccess(session, laneInfo?.info);
        }

        const laneAccess = this.setLaneAccess(session, entry.laneId, {
            key: laneSession.apiKey,
            apiKeyInfo: laneSession.apiKeyInfo,
            expiresAt: laneSession.expiresAt,
            modelId: entry.id,
            ticketsConsumed: result.ticketsConsumed || result.tickets_consumed || result.ticketsUsed?.length || ticketsRequired
        });
        await this.chatDB.saveSession(session);

        if (this.app.floatingPanel) {
            this.app.floatingPanel.showMessage(`Successfully acquired ${accessLabel}!`, 'success', 2000);
        }
        return laneAccess;
    }

    async ensureLaneAccess(session, entry, typingId) {
        const laneAccess = this.getLaneAccess(session, entry.laneId);
        if (laneAccess?.apiKey && laneAccess.modelId === entry.id && !this.isLaneAccessExpired(laneAccess)) {
            return laneAccess;
        }
        return this.requestLaneAccess(session, entry, typingId);
    }

    async ensureAccessForEntries(session, entries, typingId) {
        const ticketsRequired = Math.max(1, this.calculateCouncilTicketRequirement(entries));
        const freshEntries = entries.filter((entry) => this.needsFreshLaneAccess(session, entry));
        const freshTicketCost = freshEntries.reduce((total, entry) => total + this.getTicketCostForEntry(entry), 0);
        const availableTickets = this.ticketClient.getTicketCount();
        if (freshTicketCost > availableTickets) {
            throw new Error(`Not enough tickets for multi-model response. Need ${freshTicketCost}, but only ${availableTickets} available.`);
        }
        for (const entry of entries) {
            await this.ensureLaneAccess(session, entry, typingId);
        }
        return ticketsRequired;
    }

    buildAssistantMessage({ session, entries, initialPendingPhase, ticketsRequired = null }) {
        const now = Date.now();
        return {
            id: this.app.generateId(),
            sessionId: session.id,
            role: 'assistant',
            content: '',
            timestamp: now,
            model: 'LLM Council',
            tokenCount: null,
            streamingTokens: 0,
            streamingReasoning: false,
            streamingPending: false,
            streamingPhase: initialPendingPhase,
            council: {
                enabled: true,
                mode: RESPONSE_MODE_COUNCIL,
                currentStage: 'stage1',
                statusMessage: 'Collecting first opinions...',
                stage1: entries.map((entry, index) => ({
                    label: buildCouncilLabel(index),
                    model: entry.name,
                    modelId: entry.id,
                    status: 'pending',
                    response: ''
                })),
                errors: [],
                canonicalStage1Label: buildCouncilLabel(0),
                canonicalModel: entries[0]?.name || null,
                chairmanModel: normalizeCouncilConfig(session.councilConfig, session.model).chairmanModel || null,
                ticketsRequired,
                startedAt: now
            }
        };
    }

    async saveAndRender(message, session, options = {}) {
        await this.chatDB.saveMessage(message);
        await this.app.refreshSessionConversationSearchText(session, null, { persist: true });
        if (this.app.chatArea && this.app.isViewingSession(session.id)) {
            await this.app.chatArea.appendMessage(message);
        }
        if (!options.skipSessionsRender) {
            this.app.renderSessions();
        }
    }

    async runMultiModelTurn({
        session,
        userMessage,
        searchEnabled,
        abortController,
        initialPendingPhase,
        scrubberOriginalPrompt = null,
        scrubberRedactedPrompt = null
    }) {
        let typingId = null;
        let assistantMessage = null;

        try {
            if (!Array.isArray(this.app.state.models) || this.app.state.models.length === 0) {
                await this.app.loadModels();
            }

            const entries = this.resolveModelEntries(session);
            if (entries.length === 0) {
                await this.app.addMessage('assistant', 'No models are available right now. Please add a model and try again.', { isLocalOnly: true });
                return;
            }

            typingId = this.app.isViewingSession(session.id)
                ? this.app.showTypingIndicator('LLM Council', initialPendingPhase)
                : null;

            const ticketsRequired = await this.ensureAccessForEntries(session, entries, typingId);

            if (typingId) {
                this.app.removeTypingIndicator(typingId);
                typingId = null;
            }

            if (userMessage?.id) {
                this.app.generateSessionTitleIfNeeded(session.id, userMessage.id, {
                    accessSession: this.buildLaneSession(session, 'primary')
                }).catch(error => {
                    console.debug('Session title generation failed:', error);
                });
            }

            const messages = await this.chatDB.getSessionMessages(session.id);
            const filteredMessages = messages.filter((message) => !message.isLocalOnly);
            const sanitizedMessages = this.app.sanitizeMessagesForApi(filteredMessages);

            assistantMessage = this.buildAssistantMessage({ session, entries, initialPendingPhase, ticketsRequired });
            if (scrubberOriginalPrompt && scrubberRedactedPrompt) {
                assistantMessage.scrubber = this.app.createAssistantScrubberMetadata({
                    originalPrompt: scrubberOriginalPrompt,
                    redactedPrompt: scrubberRedactedPrompt,
                    hasScrubberContext: this.app.hasScrubberContext(filteredMessages)
                });
            }

            await this.saveAndRender(assistantMessage, session);

            let lastSaveAt = 0;
            const persistProgress = async (force = false) => {
                const now = Date.now();
                if (!force && now - lastSaveAt < SAVE_INTERVAL_MS) return;
                lastSaveAt = now;
                await this.saveAndRender(assistantMessage, session, { skipSessionsRender: !force });
            };

            await Promise.all(entries.map(async (entry, index) => {
                const stageEntry = assistantMessage.council.stage1[index];
                try {
                    const result = await this.sendLaneCompletion({
                        session,
                        entry,
                        sanitizedMessages,
                        searchEnabled,
                        abortController,
                        typingId: null
                    });
                    stageEntry.response = extractResponseContent(result);
                    stageEntry.reasoning = extractReasoning(result);
                    stageEntry.citations = extractCitations(result);
                    stageEntry.status = 'complete';
                    stageEntry.completedAt = Date.now();
                    if (index === 0) {
                        assistantMessage.content = stageEntry.response;
                        assistantMessage.model = entry.name;
                        assistantMessage.citations = stageEntry.citations || null;
                        if (assistantMessage.scrubber) {
                            assistantMessage.scrubber.redactedResponse = stageEntry.response;
                        }
                    }
                    await persistProgress();
                } catch (error) {
                    if (isAbortError(error)) {
                        stageEntry.status = 'cancelled';
                        stageEntry.cancelledAt = Date.now();
                        return;
                    }
                    stageEntry.status = 'error';
                    stageEntry.error = error?.message || 'Request failed';
                    assistantMessage.council.errors.push({
                        model: entry.name,
                        message: stageEntry.error
                    });
                    await persistProgress();
                }
            }));

            const completed = assistantMessage.council.stage1.filter((entry) => entry.status === 'complete' && entry.response);
            const wasCancelled = abortController?.signal?.aborted === true;
            if (wasCancelled && completed.length === 0) {
                await this.chatDB.deleteMessage(assistantMessage.id);
                await this.app.refreshSessionConversationSearchText(session, null, { persist: true });
                if (this.app.chatArea && this.app.isViewingSession(session.id)) {
                    await this.app.chatArea.render();
                }
                return;
            }

            if (completed.length > 0) {
                const canonical = completed[0];
                assistantMessage.content = canonical.response;
                assistantMessage.model = canonical.model;
                assistantMessage.citations = canonical.citations || null;
                assistantMessage.council.canonicalStage1Label = canonical.label;
                assistantMessage.council.canonicalModel = canonical.model;
                if (wasCancelled) {
                    assistantMessage.council.statusMessage = 'Stopped after partial responses.';
                } else {
                    assistantMessage.council.statusMessage = completed.length > 1
                        ? 'First opinions ready.'
                        : 'One model responded.';
                }
            } else {
                assistantMessage.content = 'All selected models failed to respond.';
                assistantMessage.model = 'LLM Council';
                assistantMessage.council.statusMessage = 'No model responses completed.';
                assistantMessage.isLocalOnly = true;
            }
            assistantMessage.council.currentStage = 'complete';
            assistantMessage.council.completedAt = Date.now();
            assistantMessage.streamingTokens = null;
            assistantMessage.streamingPhase = null;

            await persistProgress(true);
            if (assistantMessage.citations && assistantMessage.citations.length > 0) {
                this.app.enrichCitationsAndUpdateUI(assistantMessage);
            }
            this.app.triggerPostTurnMemoryExtraction(session);
        } catch (error) {
            if (typingId) this.app.removeTypingIndicator(typingId);
            if (isAbortError(error)) return;
            console.error('Error running multi-model turn:', error);
            if (userMessage?.id) {
                await this.app.clearSessionTitleGenerationPending(session.id);
            }
            if (assistantMessage) {
                assistantMessage.content = assistantMessage.content || 'Sorry, I encountered an error while processing the multi-model request.';
                assistantMessage.council.statusMessage = 'Multi-model request failed.';
                assistantMessage.isLocalOnly = true;
                await this.saveAndRender(assistantMessage, session);
            } else {
                await this.app.addMessage('assistant', `**Error:** ${error.message}`, { isLocalOnly: true });
            }
        }
    }

    async sendLaneCompletion({
        session,
        entry,
        sanitizedMessages,
        searchEnabled,
        abortController,
        typingId = null,
        hasRetriedAfterCredit = false
    }) {
        const processedMessages = this.app.processMessagesWithFiles(sanitizedMessages, entry.id);
        const laneSession = this.buildLaneSession(session, entry.laneId);
        try {
            return await this.inferenceService.sendCompletionStrict(
                processedMessages,
                entry.id,
                laneSession,
                {
                    context: `Multi-model response (${entry.name})`,
                    signal: abortController?.signal || null,
                    searchEnabled,
                    reasoningEnabled: this.app.reasoningEnabled,
                    reasoningEffort: this.app.reasoningEffort
                }
            );
        } catch (error) {
            if (!hasRetriedAfterCredit && this.app.isAccessCreditExhaustedError(error)) {
                this.clearLaneAccess(session, entry.laneId);
                await this.chatDB.saveSession(session);
                await this.requestLaneAccess(session, entry, typingId);
                return this.sendLaneCompletion({
                    session,
                    entry,
                    sanitizedMessages,
                    searchEnabled,
                    abortController,
                    typingId,
                    hasRetriedAfterCredit: true
                });
            }
            throw error;
        }
    }
}
