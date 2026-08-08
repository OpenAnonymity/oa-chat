import { chatDB as defaultChatDB } from '../db.js';
import { parseReasoningContent } from '../services/reasoningParser.js';
import { buildVerifierSubmitKeyProof } from './accessController.js';
import { getMessageTextContent } from '../domain/messageContent.js';
import { buildCouncilSynthesisMessages } from '../domain/councilPrompts.js';
import {
    COUNCIL_OUTPUT_SYNTHESIS,
    RESPONSE_MODE_COUNCIL,
    buildCouncilMembersForSession,
    normalizeCouncilConfig
} from '../domain/councilConfig.js';
import { findModelByNameOrId, resolveSecondaryModelNameForModels } from '../domain/modelSelection.js';
import {
    LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS,
    hasExplicitVerifierApprovalForAccessInfo,
    hasUsableVerifierApprovalForAccessInfo
} from '../services/inference/verifiedAccess.js';

const SAVE_INTERVAL_MS = 350;
const LANE_IDS = ['primary', 'secondary'];
const SYNTHESIS_LANE_ID = 'synthesis';
const SYNTHESIS_CONTEXT_MAX_CHARS = 8000;

function isAbortError(error) {
    return error?.name === 'AbortError' || error?.isCancelled || error?.message === 'AbortError';
}

function createAbortError(message = 'Request aborted') {
    const error = new Error(message);
    error.name = 'AbortError';
    error.isCancelled = true;
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw createAbortError();
    }
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
    const reasoning = result?.reasoning || message?.reasoning || message?.reasoning_details || null;
    return typeof reasoning === 'string' ? parseReasoningContent(reasoning) : null;
}

function extractCitations(result) {
    if (Array.isArray(result?.citations) && result.citations.length > 0) {
        return result.citations;
    }

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

function extractTokenCount(result) {
    return result?.totalTokens
        || result?.total_tokens
        || result?.usage?.total_tokens
        || result?.usage?.totalTokens
        || result?.data?.usage?.total_tokens
        || result?.data?.usage?.totalTokens
        || null;
}

function truncateFromStart(text, maxChars = SYNTHESIS_CONTEXT_MAX_CHARS) {
    if (!text || text.length <= maxChars) return text || '';
    return text.slice(text.length - maxChars);
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
        const { session, userMessage, preserveLocalOnlyMessages = false } = options;
        if (session?.id && userMessage?.id) {
            await this.removeAssistantMessagesAfter(session.id, userMessage.id, { preserveLocalOnlyMessages });
        }
        return this.runMultiModelTurn(options);
    }

    async runRegenerateLaneTurn({
        session,
        assistantMessageId,
        laneId,
        userMessage,
        searchEnabled,
        abortController,
        initialPendingPhase
    }) {
        throwIfAborted(abortController?.signal || null);
        if (!session?.id || !assistantMessageId || !laneId) return null;

        if (!Array.isArray(this.app.state.models) || this.app.state.models.length === 0) {
            await this.app.loadModels();
        }

        const messages = await this.chatDB.getSessionMessages(session.id);
        const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId);
        if (assistantIndex === -1) return null;

        const assistantMessage = messages[assistantIndex];
        if (assistantMessage?.role !== 'assistant' || !Array.isArray(assistantMessage?.council?.stage1)) {
            return null;
        }
        if (assistantMessage.council.synthesis) {
            throw new Error('Per-model regenerate is available in Parallel mode before Council review.');
        }

        const stageEntry = this.getStage1EntryByLaneId(assistantMessage, laneId);
        if (!stageEntry) {
            throw new Error('Could not find that Parallel response.');
        }
        const selectedLaneWasCanonical = assistantMessage.council.canonicalStage1Label === stageEntry.label;

        const entries = this.resolveModelEntries(session);
        const entry = this.resolveEntryForStage1Entry(session, stageEntry, entries);
        if (!entry?.id || !entry?.name) {
            throw new Error('Could not resolve the model for that Parallel response.');
        }

        this.assertSufficientTicketsForEntries(session, [entry], `${entry.name} response`);

        const priorMessages = messages
            .slice(0, assistantIndex)
            .filter((message) => !message.isLocalOnly);
        const sanitizedMessages = this.app.sanitizeMessagesForApi(
            this.buildLaneConversationMessages(priorMessages, entry, entries)
        );

        stageEntry.status = 'pending';
        stageEntry.response = '';
        stageEntry.error = null;
        stageEntry.reasoning = null;
        stageEntry.reasoningDuration = null;
        stageEntry.streamingReasoning = false;
        stageEntry.streamingTokens = null;
        stageEntry.citations = null;
        stageEntry.startedAt = Date.now();
        stageEntry.completedAt = null;
        stageEntry.cancelledAt = null;
        assistantMessage.council.currentStage = 'stage1';
        assistantMessage.council.statusMessage = null;
        assistantMessage.council.errors = (assistantMessage.council.errors || [])
            .filter((error) => error?.laneId !== laneId && error?.model !== stageEntry.model);
        assistantMessage.streamingPhase = initialPendingPhase || 'waiting-response';
        assistantMessage.streamingTokens = null;
        assistantMessage.timestamp = Date.now();
        this.refreshStage1CanonicalResponse(assistantMessage);
        await this.saveAndRender(assistantMessage, session, { skipSessionsRender: true });

        try {
            await this.ensureAccessForEntries(session, [entry], null, abortController?.signal || null);
            stageEntry.status = 'running';
            await this.saveAndRender(assistantMessage, session, { skipSessionsRender: true });

            const result = await this.sendLaneCompletion({
                session,
                entry,
                sanitizedMessages,
                searchEnabled,
                abortController,
                typingId: null,
                streamTarget: {
                    assistantMessage,
                    laneState: stageEntry,
                    persistProgress: () => this.persistStreamingMessageSnapshot(assistantMessage)
                }
            });
            stageEntry.response = extractResponseContent(result);
            stageEntry.reasoning = extractReasoning(result);
            stageEntry.reasoningDuration = result?.reasoningDuration || null;
            stageEntry.streamingReasoning = false;
            stageEntry.streamingTokens = null;
            stageEntry.citations = extractCitations(result);
            stageEntry.status = 'complete';
            stageEntry.completedAt = Date.now();
            stageEntry.error = null;
            this.refreshStage1CanonicalResponse(
                assistantMessage,
                selectedLaneWasCanonical ? stageEntry.label : null
            );
        } catch (error) {
            stageEntry.streamingReasoning = false;
            stageEntry.streamingTokens = null;
            if (this.app.chatArea && this.app.isViewingSession(session.id)) {
                this.app.chatArea.clearCouncilLaneReasoning?.(assistantMessage.id, laneId, {
                    label: isAbortError(error) ? 'Reasoning stopped' : 'Reasoning interrupted'
                });
            }
            if (isAbortError(error)) {
                stageEntry.status = 'cancelled';
                stageEntry.cancelledAt = Date.now();
            } else {
                stageEntry.status = 'error';
                stageEntry.error = error?.message || 'Request failed';
                assistantMessage.council.errors.push({
                    laneId,
                    model: stageEntry.model,
                    message: stageEntry.error
                });
            }
            this.refreshStage1CanonicalResponse(assistantMessage);
        }

        assistantMessage.council.completedAt = Date.now();
        assistantMessage.streamingPhase = null;
        assistantMessage.streamingTokens = null;
        await this.saveAndRender(assistantMessage, session);
        await this.app.recomputeSessionCouncilTranscriptHint?.(session);
        if (stageEntry.status === 'complete') {
            this.app.triggerPostTurnMemoryExtraction?.(session);
        }
        return assistantMessage;
    }

    async removeAssistantMessagesAfter(sessionId, userMessageId, options = {}) {
        const { preserveLocalOnlyMessages = false } = options;
        const messages = await this.chatDB.getSessionMessages(sessionId);
        const userIndex = messages.findIndex((message) => message.id === userMessageId);
        if (userIndex === -1) return;
        const laterMessages = messages.slice(userIndex + 1);
        const messagesToDelete = laterMessages
            .filter((message) => message.role === 'assistant')
            .filter((message) => !(preserveLocalOnlyMessages && message.isLocalOnly));
        await Promise.all(
            messagesToDelete.map((message) => this.chatDB.deleteMessage(message.id))
        );
        const deletedIds = new Set(messagesToDelete.map((message) => message.id));
        const remainingMessages = messages.filter((message) => !deletedIds.has(message.id));
        const session = this.app.state?.sessionsById?.get(sessionId)
            || this.app.state?.sessions?.find((entry) => entry.id === sessionId)
            || await this.chatDB.getSession?.(sessionId)
            || null;
        await this.app.recomputeSessionCouncilTranscriptHint?.(session, remainingMessages);
        if (this.app.isViewingSession(sessionId)) {
            await this.app.chatArea?.render();
        }
    }

    findModelEntry(modelNameOrId) {
        if (!modelNameOrId || !Array.isArray(this.app.state.models)) return null;
        return findModelByNameOrId(
            this.app.state.models,
            modelNameOrId,
            (candidate) => this.app.normalizeModelName(candidate)
        );
    }

    resolvePrimaryModelName(session) {
        const requestedModelName = this.app.normalizeModelName(session?.model)
            || session?.model
            || this.inferenceService.getDefaultModelName(session);
        const requestedEntry = this.findModelEntry(requestedModelName);
        if (requestedEntry?.name) {
            return requestedEntry.name;
        }
        const fallbackEntry = typeof this.app.getFallbackModelEntry === 'function'
            ? this.app.getFallbackModelEntry(session)
            : null;
        return fallbackEntry?.name || requestedModelName;
    }

    resolveModelEntries(session) {
        const fallbackModelName = this.resolvePrimaryModelName(session);
        const normalizedConfig = normalizeCouncilConfig(session?.councilConfig, fallbackModelName);
        const configuredMembers = buildCouncilMembersForSession(
            { ...session, councilConfig: normalizedConfig },
            fallbackModelName
        );
        const requestedNames = [
            fallbackModelName
        ];
        if (configuredMembers.length >= 2) {
            requestedNames.push(configuredMembers[1]);
        } else if (configuredMembers[0] && configuredMembers[0] !== fallbackModelName) {
            requestedNames.push(configuredMembers[0]);
        }

        const entries = [];
        for (const name of requestedNames) {
            const modelEntry = this.findModelEntry(name);
            if (!modelEntry) continue;
            entries.push({
                ...modelEntry,
                laneId: LANE_IDS[entries.length] || `lane-${entries.length + 1}`
            });
            if (entries.length >= 2) break;
        }

        if (entries.length > 0 && entries.length < 2 && Array.isArray(this.app.state.models)) {
            const fallbackSecondaryName = resolveSecondaryModelNameForModels({
                models: this.app.state.models,
                primaryModelName: entries[0]?.name || fallbackModelName,
                normalizeModelName: (modelName) => this.app.normalizeModelName?.(modelName)
            });
            const fallbackSecondaryEntry = this.findModelEntry(fallbackSecondaryName);
            if (fallbackSecondaryEntry?.id) {
                entries.push({
                    ...fallbackSecondaryEntry,
                    laneId: LANE_IDS[entries.length] || `lane-${entries.length + 1}`
                });
            }
        }

        if (entries.length > 0 && entries.length < 2 && Array.isArray(this.app.state.models)) {
            for (const modelEntry of this.app.state.models) {
                if (!modelEntry?.id || !modelEntry?.name) continue;
                entries.push({
                    ...modelEntry,
                    laneId: LANE_IDS[entries.length] || `lane-${entries.length + 1}`
                });
                if (entries.length >= 2) break;
            }
        }

        if (entries.length === 0) {
            const fallbackEntry = this.app.getFallbackModelEntry(session);
            if (fallbackEntry) entries.push({ ...fallbackEntry, laneId: 'primary' });
        }

        return entries;
    }

    resolveSynthesisEntry(session, stageEntries = []) {
        const fallbackModelName = this.resolvePrimaryModelName(session)
            || stageEntries[0]?.name
            || this.inferenceService.getDefaultModelName(session);
        const normalizedConfig = normalizeCouncilConfig(session?.councilConfig, fallbackModelName);
        const requestedModel = normalizedConfig.synthesisModel || fallbackModelName;
        const modelEntry = this.findModelEntry(requestedModel)
            || this.findModelEntry(fallbackModelName)
            || stageEntries[0]
            || (typeof this.app.getFallbackModelEntry === 'function' ? this.app.getFallbackModelEntry(session) : null);
        return modelEntry
            ? { ...modelEntry, laneId: SYNTHESIS_LANE_ID }
            : null;
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
        const verifier = this.inferenceService.getVerificationAdapter?.(session);
        const keyInfo = accessInfo.apiKeyInfo || accessInfo.info || accessInfo;
        const usableProof = hasUsableVerifierApprovalForAccessInfo(keyInfo, {
            allowLocalBypass: verifier?.allowsLocalBypass?.() === true
        });
        if (token && verifier?.supports && !usableProof) {
            throw new Error('Refusing to persist a Council lane key without verifier approval or an explicit loopback bypass.');
        }
        container[laneId] = {
            apiKey: token,
            apiKeyInfo: keyInfo,
            expiresAt: accessInfo.expiresAt || accessInfo.expires_at || accessInfo.apiKeyInfo?.expiresAt || null,
            modelId: accessInfo.modelId || null,
            ticketsConsumed: accessInfo.ticketsConsumed ?? accessInfo.tickets_consumed ?? accessInfo.ticketsUsed?.length ?? null,
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

    isLaneAccessVerified(session, laneAccess) {
        const verifier = this.inferenceService.getVerificationAdapter?.(session);
        if (!verifier?.supports) return true;
        return hasUsableVerifierApprovalForAccessInfo(laneAccess?.apiKeyInfo, {
            allowLocalBypass: verifier.allowsLocalBypass?.() === true
        });
    }

    isLaneAccessUsable(session, laneAccess, entry = null) {
        if (!laneAccess?.apiKey) return false;
        if (!this.isLaneAccessVerified(session, laneAccess)) return false;
        if (this.isLaneAccessExpired(laneAccess)) return false;
        if (this.isLaneAccessBanned(session, laneAccess)) return false;
        return true;
    }

    getBannedLaneAccessInfo(session, laneAccess) {
        if (!laneAccess?.apiKeyInfo) return null;
        const verifier = this.inferenceService.getVerificationAdapter?.(session);
        if (!verifier?.supports) return null;
        if (!hasExplicitVerifierApprovalForAccessInfo(laneAccess.apiKeyInfo)) return null;
        const accessId = typeof verifier.getAccessId === 'function'
            ? verifier.getAccessId(laneAccess.apiKeyInfo)
            : null;
        if (!accessId) return null;

        const stationState = typeof verifier.getAccessState === 'function'
            ? verifier.getAccessState(accessId)
            : null;
        const isBannedInCache = typeof verifier.isAccessBanned === 'function'
            ? verifier.isAccessBanned(accessId)
            : false;
        if (!stationState?.banned && !isBannedInCache) return null;

        const broadcastData = typeof verifier.getLastBroadcastData === 'function'
            ? verifier.getLastBroadcastData()
            : null;
        const bannedInfo = broadcastData?.banned_stations?.find((station) => station.station_id === accessId);
        return {
            stationId: accessId,
            reason: stationState?.banReason || bannedInfo?.reason || 'Unknown',
            bannedAt: stationState?.bannedAt || bannedInfo?.banned_at || null
        };
    }

    isLaneAccessBanned(session, laneAccess) {
        return !!this.getBannedLaneAccessInfo(session, laneAccess);
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

    getFreshEntriesForAccess(session, entries) {
        entries.forEach((entry) => this.seedPrimaryLaneAccessFromSession(session, entry));
        return entries.filter((entry) => this.needsFreshLaneAccess(session, entry));
    }

    calculateFreshTicketRequirement(session, entries) {
        return this.getFreshEntriesForAccess(session, entries)
            .reduce((total, entry) => total + this.getTicketCostForEntry(entry), 0);
    }

    assertSufficientTicketsForEntries(session, entries, label = 'selected model responses') {
        const freshTicketCost = this.calculateFreshTicketRequirement(session, entries);
        const availableTickets = this.ticketClient.getTicketCount();
        if (freshTicketCost > availableTickets) {
            throw new Error(`Not enough tickets for ${label}. Need ${freshTicketCost}, but only ${availableTickets} available.`);
        }
        return freshTicketCost;
    }

    needsFreshLaneAccess(session, entry) {
        const laneAccess = this.getLaneAccess(session, entry.laneId);
        return !this.isLaneAccessUsable(session, laneAccess, entry);
    }

    seedPrimaryLaneAccessFromSession(session, entry) {
        if (entry?.laneId !== 'primary') return null;
        const laneAccess = this.getLaneAccess(session, 'primary');
        if (this.isLaneAccessUsable(session, laneAccess, entry)) {
            return laneAccess;
        }
        if (!session?.apiKey || this.inferenceService.isAccessExpired(session)) {
            return null;
        }
        const accessInfo = this.inferenceService.getAccessInfo(session);
        if (!accessInfo?.token) {
            return null;
        }
        const accessModelId = this.resolveAccessModelId(accessInfo.info || session.apiKeyInfo || null);
        if (accessModelId !== entry.id) {
            return null;
        }
        if (this.isLaneAccessBanned(session, {
            apiKey: accessInfo.token,
            apiKeyInfo: accessInfo.info || session.apiKeyInfo || null,
            expiresAt: accessInfo.expiresAt || session.expiresAt || null,
            modelId: entry.id
        })) {
            return null;
        }
        return this.setLaneAccess(session, 'primary', {
            key: accessInfo.token,
            apiKeyInfo: accessInfo.info || session.apiKeyInfo || null,
            expiresAt: accessInfo.expiresAt || session.expiresAt || null,
            modelId: entry.id,
            ticketsConsumed: 0
        });
    }

    seedSessionAccessFromPrimaryLane(session) {
        const laneAccess = this.getLaneAccess(session, 'primary');
        if (!this.isLaneAccessUsable(session, laneAccess)) {
            return null;
        }

        const accessInfo = {
            ...(laneAccess.apiKeyInfo || {}),
            key: laneAccess.apiKey,
            token: laneAccess.apiKey,
            expiresAt: laneAccess.expiresAt || laneAccess.apiKeyInfo?.expiresAt || laneAccess.apiKeyInfo?.expires_at || null,
            modelId: laneAccess.modelId || laneAccess.apiKeyInfo?.modelId || laneAccess.apiKeyInfo?.model_id || null
        };

        this.inferenceService.setAccessInfo(session, accessInfo);
        const verifier = this.inferenceService.getVerificationAdapter?.(session);
        const shouldSetVerifierCurrentAccess = !verifier?.supports ||
            hasExplicitVerifierApprovalForAccessInfo(accessInfo);
        if (shouldSetVerifierCurrentAccess &&
            typeof this.inferenceService.setCurrentAccess === 'function') {
            this.inferenceService.setCurrentAccess(session, accessInfo);
        }
        return laneAccess;
    }

    resolveAccessModelId(accessInfo) {
        const modelName = accessInfo?.modelId
            || accessInfo?.model_id
            || accessInfo?.requestedModelId
            || accessInfo?.requested_model_id
            || accessInfo?.modelName
            || accessInfo?.model
            || null;
        if (!modelName) return null;
        const normalizedName = this.app.normalizeModelName(modelName) || modelName;
        const modelEntry = this.app.state.models.find((model) => model.name === modelName)
            || this.app.state.models.find((model) => model.id === modelName)
            || this.app.state.models.find((model) => model.name === normalizedName)
            || this.app.state.models.find((model) => model.id === normalizedName);
        return modelEntry?.id || null;
    }

    async requestLaneAccess(session, entry, typingId, signal = null) {
        throwIfAborted(signal);
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
            throwIfAborted(signal);
            try {
                result = await this.inferenceService.requestAccess(session, {
                    ticketsRequired,
                    ...(signal ? { signal } : {})
                });
                break;
            } catch (error) {
                if (isAbortError(error) || signal?.aborted) {
                    throw error;
                }
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
        throwIfAborted(signal);

        if (typingId) {
            try {
                this.app.advancePendingStateAfterAccessGranted(session.id, typingId);
            } catch (error) {
                console.warn('Pending-state update after access grant failed:', error);
            }
        }

        let approvedAccessInfo = { ...result };
        const verifier = this.inferenceService.getVerificationAdapter?.(session);
        if (verifier?.supports) {
            let verifyResult;
            const allowsLocalBypass = verifier.allowsLocalBypass?.() === true;
            if (allowsLocalBypass) {
                verifyResult = {
                    status: LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS,
                    detail: 'explicit_loopback_development'
                };
            } else {
                try {
                    verifyResult = await this.inferenceService.verifyAccess(session, approvedAccessInfo);
                } catch (error) {
                    verifyResult = { status: 'rejected', error };
                }
            }
            const proof = buildVerifierSubmitKeyProof(verifyResult, approvedAccessInfo);

            if (!allowsLocalBypass && verifyResult?.status !== 'verified') {
                if (verifyResult.bannedStation) {
                    const banned = verifyResult.bannedStation;
                    throw new Error(`Station ${banned.stationId} is banned: ${banned.reason || 'Unknown reason'}`);
                }
                const detail = verifyResult?.detail ||
                    verifyResult?.data?.detail ||
                    verifyResult?.error?.message ||
                    'verification_not_confirmed';
                if (verifyResult?.status === 'pending') {
                    throw new Error(`Key verification pending: ${detail}. The Council lane key was not activated.`);
                }
                if (verifyResult?.status === 'unverified') {
                    throw new Error(`Key verification required: ${detail}. The Council lane key was not activated.`);
                }
                throw new Error(`Key verification failed: ${detail}`);
            }

            approvedAccessInfo = {
                ...approvedAccessInfo,
                verifierSubmitKeyProof: proof
            };
            if (!allowsLocalBypass) {
                this.inferenceService.setCurrentAccess(session, approvedAccessInfo);
            }
        }

        const laneAccess = this.setLaneAccess(session, entry.laneId, {
            key: approvedAccessInfo.key || approvedAccessInfo.token || approvedAccessInfo.apiKey || null,
            apiKeyInfo: approvedAccessInfo,
            expiresAt: approvedAccessInfo.expiresAt || approvedAccessInfo.expires_at || null,
            modelId: entry.id,
            ticketsConsumed: result.ticketsConsumed || result.tickets_consumed || result.ticketsUsed?.length || ticketsRequired
        });
        await this.chatDB.saveSession(session);

        if (this.app.floatingPanel) {
            this.app.floatingPanel.showMessage(`Successfully acquired ${accessLabel}!`, 'success', 2000);
        }
        return laneAccess;
    }

    async ensureLaneAccess(session, entry, typingId, signal = null) {
        throwIfAborted(signal);
        this.seedPrimaryLaneAccessFromSession(session, entry);
        const laneAccess = this.getLaneAccess(session, entry.laneId);
        if (this.isLaneAccessUsable(session, laneAccess, entry)) {
            return laneAccess;
        }
        if (laneAccess?.apiKey && this.isLaneAccessBanned(session, laneAccess)) {
            this.clearLaneAccess(session, entry.laneId);
            await this.chatDB.saveSession(session);
        }
        return this.requestLaneAccess(session, entry, typingId, signal);
    }

    async ensureAccessForEntries(session, entries, typingId, signal = null) {
        throwIfAborted(signal);
        const ticketsRequired = Math.max(1, this.calculateCouncilTicketRequirement(entries));
        this.assertSufficientTicketsForEntries(session, entries);
        for (const entry of entries) {
            await this.ensureLaneAccess(session, entry, typingId, signal);
        }
        return ticketsRequired;
    }

    buildAssistantMessage({ session, entries, synthesisEntry = null, initialPendingPhase, ticketsRequired = null }) {
        const now = Date.now();
        const normalizedCouncilConfig = normalizeCouncilConfig(session.councilConfig, session.model);
        return {
            id: this.app.generateId(),
            sessionId: session.id,
            role: 'assistant',
            content: '',
            timestamp: now,
            model: synthesisEntry ? 'Council' : 'Parallel',
            tokenCount: null,
            streamingTokens: 0,
            streamingReasoning: false,
            streamingPending: false,
            streamingPhase: initialPendingPhase,
            council: {
                enabled: true,
                mode: RESPONSE_MODE_COUNCIL,
                currentStage: 'stage1',
                statusMessage: 'Waiting for responses...',
                stage1: entries.map((entry, index) => ({
                    label: buildCouncilLabel(index),
                    laneId: entry.laneId,
                    model: entry.name,
                    modelId: entry.id,
                    status: 'pending',
                    response: '',
                    reasoning: null,
                    reasoningDuration: null,
                    streamingReasoning: false,
                    streamingTokens: null,
                    citations: null,
                    error: null
                })),
                errors: [],
                canonicalStage1Label: buildCouncilLabel(0),
                canonicalModel: entries[0]?.name || null,
                synthesis: synthesisEntry ? {
                    model: synthesisEntry.name,
                    modelId: synthesisEntry.id,
                    status: 'waiting',
                    response: '',
                    reasoning: null,
                    reasoningDuration: null,
                    streamingReasoning: false,
                    streamingTokens: null,
                    citations: null,
                    error: null,
                    fallbackUsed: false
                } : null,
                synthesisModel: synthesisEntry?.name || normalizedCouncilConfig.synthesisModel || null,
                outputMode: normalizedCouncilConfig.outputMode,
                reviewEnabled: false,
                ticketsRequired,
                startedAt: now
            }
        };
    }

    async saveAndRender(message, session, options = {}) {
        if (message?.council?.enabled) {
            await this.app.markSessionHasCouncilTranscript?.(session, { persist: true });
        }
        await this.chatDB.saveMessage(message);
        await this.app.refreshSessionConversationSearchText(session, null, { persist: true });
        if (this.app.chatArea && this.app.isViewingSession(session.id)) {
            await this.app.chatArea.appendMessage(message);
        }
        if (!options.skipSessionsRender) {
            this.app.renderSessions();
        }
    }

    persistStreamingMessageSnapshot(message) {
        if (!message?.id) return;
        this.chatDB.saveMessage(message).catch((error) => {
            console.debug('Unable to persist streaming council snapshot:', error);
        });
    }

    buildSynthesisConversationContext(sanitizedMessages = []) {
        const priorMessages = sanitizedMessages.slice(0, -1);
        const transcript = priorMessages
            .map((message) => {
                const text = getMessageTextContent(message?.content).trim();
                if (!text) return null;
                const role = message.role === 'assistant'
                    ? 'Assistant'
                    : message.role === 'user'
                        ? 'User'
                        : message.role || 'Message';
                return `${role}: ${text}`;
            })
            .filter(Boolean)
            .join('\n\n');
        return truncateFromStart(transcript);
    }

    buildSynthesisResponses(stageEntries = []) {
        return stageEntries
            .filter((entry) => entry?.status === 'complete' && typeof entry.response === 'string' && entry.response.trim())
            .map((entry) => ({
                label: entry.label,
                response: entry.response
            }));
    }

    getStage1EntryForLane(message, entry, entries = []) {
        const stageEntries = Array.isArray(message?.council?.stage1)
            ? message.council.stage1
            : [];
        if (stageEntries.length === 0) return null;

        const laneIndex = entries.findIndex((candidate) => candidate.laneId === entry.laneId);
        const laneLabel = laneIndex >= 0 ? buildCouncilLabel(laneIndex) : null;
        return stageEntries.find((stageEntry) => stageEntry.laneId === entry.laneId)
            || stageEntries.find((stageEntry) => stageEntry.label === laneLabel)
            || stageEntries.find((stageEntry) => stageEntry.modelId === entry.id)
            || stageEntries.find((stageEntry) => stageEntry.model === entry.name)
            || null;
    }

    getStage1EntryByLaneId(message, laneId) {
        const stageEntries = Array.isArray(message?.council?.stage1)
            ? message.council.stage1
            : [];
        if (!laneId || stageEntries.length === 0) return null;
        return stageEntries.find((stageEntry) => stageEntry.laneId === laneId)
            || stageEntries.find((stageEntry) => stageEntry.label === laneId)
            || null;
    }

    resolveEntryForStage1Entry(session, stageEntry, entries = []) {
        const laneId = stageEntry?.laneId || 'primary';
        const catalogEntry = this.findModelEntry(stageEntry?.modelId)
            || this.findModelEntry(stageEntry?.model)
            || entries.find((entry) => entry.laneId === laneId)
            || null;
        if (catalogEntry?.id && catalogEntry?.name) {
            return { ...catalogEntry, laneId };
        }
        return {
            id: stageEntry?.modelId || stageEntry?.model || session?.model || null,
            name: stageEntry?.model || stageEntry?.modelId || session?.model || null,
            laneId
        };
    }

    refreshStage1CanonicalResponse(message, preferredLabel = null) {
        const stageEntries = Array.isArray(message?.council?.stage1)
            ? message.council.stage1
            : [];
        const completed = stageEntries.filter((entry) => entry?.status === 'complete' && entry.response);
        const existingLabel = message?.council?.canonicalStage1Label || null;
        const canonical = completed.find((entry) => entry.label === preferredLabel)
            || completed.find((entry) => entry.label === existingLabel)
            || completed[0]
            || null;

        if (!canonical) {
            message.content = '';
            message.model = 'Parallel';
            message.citations = null;
            if (message.scrubber) {
                message.scrubber.redactedResponse = '';
            }
            return null;
        }

        message.content = canonical.response;
        message.model = canonical.model;
        message.citations = canonical.citations || null;
        message.council.canonicalStage1Label = canonical.label;
        message.council.canonicalModel = canonical.model;
        if (message.scrubber) {
            message.scrubber.redactedResponse = canonical.response;
        }
        return canonical;
    }

    buildLaneConversationMessages(messages = [], entry, entries = []) {
        return messages
            .map((message) => {
                if (message?.role !== 'assistant' || !Array.isArray(message?.council?.stage1)) {
                    return message;
                }

                const synthesis = message.council.synthesis;
                if ((synthesis?.status === 'complete' || synthesis?.status === 'partial') && synthesis.response) {
                    return {
                        ...message,
                        content: synthesis.response,
                        model: 'Council'
                    };
                }

                const stageEntry = this.getStage1EntryForLane(message, entry, entries);
                if (stageEntry?.status === 'complete' && stageEntry.response) {
                    return {
                        ...message,
                        content: stageEntry.response,
                        model: stageEntry.model || entry.name
                    };
                }

                return null;
            })
            .filter(Boolean);
    }

    async runSynthesisCompletion({
        session,
        synthesisEntry,
        sanitizedMessages,
        userMessage,
        stageEntries,
        abortController,
        typingId = null,
        streamTarget = null
    }) {
        const userQuery = getMessageTextContent(userMessage?.content).trim()
            || getMessageTextContent(sanitizedMessages[sanitizedMessages.length - 1]?.content).trim();
        const messages = buildCouncilSynthesisMessages({
            userQuery,
            conversationContext: this.buildSynthesisConversationContext(sanitizedMessages),
            responses: this.buildSynthesisResponses(stageEntries)
        });
        return this.sendLaneMessagesCompletion({
            session,
            entry: synthesisEntry,
            messages,
            searchEnabled: false,
            abortController,
            typingId,
            streamTarget
        });
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
            const normalizedCouncilConfig = normalizeCouncilConfig(session?.councilConfig, session?.model || entries[0]?.name || null);
            const shouldRunSynthesis = normalizedCouncilConfig.outputMode === COUNCIL_OUTPUT_SYNTHESIS;
            const synthesisEntry = shouldRunSynthesis ? this.resolveSynthesisEntry(session, entries) : null;
            const accessEntries = synthesisEntry ? [...entries, synthesisEntry] : entries;

            this.assertSufficientTicketsForEntries(session, accessEntries);
            const ticketsRequired = Math.max(1, this.calculateCouncilTicketRequirement(accessEntries));

            const messages = await this.chatDB.getSessionMessages(session.id);
            const filteredMessages = messages.filter((message) => !message.isLocalOnly);
            const sanitizedMessages = this.app.sanitizeMessagesForApi(filteredMessages);
            const laneSanitizedMessages = new Map(entries.map((entry) => [
                entry.laneId,
                this.app.sanitizeMessagesForApi(this.buildLaneConversationMessages(filteredMessages, entry, entries))
            ]));

            assistantMessage = this.buildAssistantMessage({ session, entries, synthesisEntry, initialPendingPhase, ticketsRequired });
            if (scrubberOriginalPrompt && scrubberRedactedPrompt) {
                assistantMessage.scrubber = this.app.createAssistantScrubberMetadata({
                    originalPrompt: scrubberOriginalPrompt,
                    redactedPrompt: scrubberRedactedPrompt,
                    hasScrubberContext: this.app.hasScrubberContext(filteredMessages)
                });
            }

            await this.saveAndRender(assistantMessage, session);

            await this.ensureAccessForEntries(session, entries, typingId, abortController?.signal || null);

            if (userMessage?.id) {
                this.app.generateSessionTitleIfNeeded(session.id, userMessage.id, {
                    accessSession: this.buildLaneSession(session, 'primary')
                }).catch(error => {
                    console.debug('Session title generation failed:', error);
                });
            }

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
                        sanitizedMessages: laneSanitizedMessages.get(entry.laneId) || sanitizedMessages,
                        searchEnabled,
                        abortController,
                        typingId: null,
                        streamTarget: {
                            assistantMessage,
                            laneState: stageEntry,
                            persistProgress: () => this.persistStreamingMessageSnapshot(assistantMessage)
                        }
                    });
                    stageEntry.response = extractResponseContent(result);
                    stageEntry.reasoning = extractReasoning(result);
                    stageEntry.reasoningDuration = result?.reasoningDuration || null;
                    stageEntry.streamingReasoning = false;
                    stageEntry.streamingTokens = null;
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
                        stageEntry.streamingReasoning = false;
                        stageEntry.streamingTokens = null;
                        return;
                    }
                    stageEntry.status = 'error';
                    stageEntry.error = error?.message || 'Request failed';
                    stageEntry.streamingReasoning = false;
                    stageEntry.streamingTokens = null;
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
                await this.app.recomputeSessionCouncilTranscriptHint?.(session);
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
                if (assistantMessage.scrubber) {
                    assistantMessage.scrubber.redactedResponse = canonical.response;
                }

                if (!wasCancelled && synthesisEntry && assistantMessage.council.synthesis) {
                    assistantMessage.council.currentStage = 'synthesis';
                    assistantMessage.council.statusMessage = 'Waiting for response';
                    assistantMessage.council.synthesis.status = 'running';
                    await persistProgress(true);

                    try {
                        await this.ensureAccessForEntries(session, [synthesisEntry], null, abortController?.signal || null);
                        const synthesisResult = await this.runSynthesisCompletion({
                            session,
                            synthesisEntry,
                            sanitizedMessages,
                            userMessage,
                            stageEntries: assistantMessage.council.stage1,
                            abortController,
                            typingId: null,
                            streamTarget: {
                                assistantMessage,
                                laneState: assistantMessage.council.synthesis,
                                persistProgress: () => this.persistStreamingMessageSnapshot(assistantMessage)
                            }
                        });
                        const synthesisResponse = extractResponseContent(synthesisResult);
                        if (!synthesisResponse) {
                            throw new Error('Council synthesis returned an empty response.');
                        }
                        const synthesisCitations = extractCitations(synthesisResult);
                        const synthesisStatus = completed.length === entries.length ? 'complete' : 'partial';
                        const synthesisReasoning = extractReasoning(synthesisResult);
                        assistantMessage.content = synthesisResponse;
                        assistantMessage.model = 'Council';
                        assistantMessage.reasoning = synthesisReasoning;
                        assistantMessage.reasoningDuration = synthesisResult?.reasoningDuration || null;
                        assistantMessage.tokenCount = extractTokenCount(synthesisResult);
                        assistantMessage.citations = synthesisCitations || null;
                        assistantMessage.council.synthesis = {
                            model: synthesisEntry.name,
                            modelId: synthesisEntry.id,
                            status: synthesisStatus,
                            response: synthesisResponse,
                            reasoning: synthesisReasoning,
                            reasoningDuration: synthesisResult?.reasoningDuration || null,
                            streamingReasoning: false,
                            streamingTokens: null,
                            citations: synthesisCitations,
                            error: null,
                            fallbackUsed: false,
                            completedAt: Date.now()
                        };
                        assistantMessage.council.statusMessage = null;
                        if (assistantMessage.scrubber) {
                            assistantMessage.scrubber.redactedResponse = synthesisResponse;
                        }
                    } catch (error) {
                        if (isAbortError(error)) {
                            assistantMessage.council.synthesis.status = 'cancelled';
                            assistantMessage.council.synthesis.cancelledAt = Date.now();
                            assistantMessage.council.synthesis.streamingReasoning = false;
                            assistantMessage.council.synthesis.streamingTokens = null;
                            assistantMessage.council.statusMessage = 'Stopped after first opinions.';
                        } else {
                            const errorMessage = error?.message || 'Council synthesis failed.';
                            assistantMessage.content = canonical.response;
                            assistantMessage.model = canonical.model;
                            assistantMessage.citations = canonical.citations || null;
                            assistantMessage.council.synthesis = {
                                model: synthesisEntry.name,
                                modelId: synthesisEntry.id,
                                status: 'error',
                                response: '',
                                reasoning: assistantMessage.council.synthesis.reasoning || null,
                                reasoningDuration: assistantMessage.council.synthesis.reasoningDuration || null,
                                streamingReasoning: false,
                                streamingTokens: null,
                                error: errorMessage,
                                fallbackUsed: true,
                                fallbackLabel: canonical.label,
                                fallbackModel: canonical.model,
                                completedAt: Date.now()
                            };
                            assistantMessage.council.errors.push({
                                model: synthesisEntry.name,
                                stage: 'synthesis',
                                message: errorMessage
                            });
                            assistantMessage.council.statusMessage = `Council synthesis failed. Continuing from ${canonical.label}.`;
                            if (assistantMessage.scrubber) {
                                assistantMessage.scrubber.redactedResponse = canonical.response;
                            }
                        }
                    }
                } else if (wasCancelled) {
                    assistantMessage.council.statusMessage = 'Stopped after partial responses.';
                } else {
                    assistantMessage.council.statusMessage = null;
                }
            } else {
                assistantMessage.content = 'All selected models failed to respond.';
                assistantMessage.model = shouldRunSynthesis ? 'Council' : 'Parallel';
                assistantMessage.council.statusMessage = 'No model responses completed.';
                assistantMessage.isLocalOnly = true;
                if (assistantMessage.council.synthesis) {
                    assistantMessage.council.synthesis.status = 'skipped';
                    assistantMessage.council.synthesis.error = 'No model responses completed.';
                }
            }
            assistantMessage.council.currentStage = 'complete';
            assistantMessage.council.completedAt = Date.now();
            assistantMessage.streamingTokens = null;
            assistantMessage.streamingPhase = null;

            await persistProgress(true);
            if (assistantMessage.citations && assistantMessage.citations.length > 0) {
                this.app.enrichCitationsAndUpdateUI(assistantMessage);
            }
            if (completed.length > 0) {
                this.app.triggerPostTurnMemoryExtraction(session);
            }
        } catch (error) {
            if (typingId) this.app.removeTypingIndicator(typingId);
            if (isAbortError(error)) {
                if (assistantMessage?.id) {
                    await this.chatDB.deleteMessage(assistantMessage.id);
                    await this.app.refreshSessionConversationSearchText(session, null, { persist: true });
                    await this.app.recomputeSessionCouncilTranscriptHint?.(session);
                    if (this.app.chatArea && this.app.isViewingSession(session.id)) {
                        await this.app.chatArea.render();
                    }
                }
                return;
            }
            console.error('Error running Parallel/Council turn:', error);
            if (userMessage?.id) {
                await this.app.clearSessionTitleGenerationPending(session.id);
            }
            if (assistantMessage) {
                const errorMessage = error?.message || 'Request failed';
                assistantMessage.content = assistantMessage.content || 'Sorry, I encountered an error while processing the selected model request.';
                assistantMessage.council.statusMessage = 'Model request failed.';
                if (Array.isArray(assistantMessage.council?.stage1)) {
                    assistantMessage.council.stage1.forEach((entry) => {
                        if (entry.status === 'pending' || entry.status === 'running' || entry.status === 'waiting') {
                            entry.status = 'error';
                            entry.error = errorMessage;
                        }
                    });
                }
                assistantMessage.council.currentStage = 'complete';
                assistantMessage.council.completedAt = Date.now();
                assistantMessage.streamingTokens = null;
                assistantMessage.streamingPhase = null;
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
        hasRetriedAfterCredit = false,
        streamTarget = null
    }) {
        const processedMessages = this.app.processMessagesWithFiles(sanitizedMessages, entry.id);
        return this.sendLaneMessagesCompletion({
            session,
            entry,
            messages: processedMessages,
            searchEnabled,
            abortController,
            typingId,
            hasRetriedAfterCredit,
            streamTarget
        });
    }

    async sendLaneMessagesCompletion({
        session,
        entry,
        messages,
        searchEnabled,
        abortController,
        typingId = null,
        hasRetriedAfterCredit = false,
        streamTarget = null
    }) {
        const laneSession = this.buildLaneSession(session, entry.laneId);
        try {
            if (typeof this.inferenceService.streamCompletion === 'function') {
                try {
                    return await this.streamLaneMessagesCompletion({
                        session,
                        entry,
                        laneSession,
                        messages,
                        searchEnabled,
                        abortController,
                        streamTarget
                    });
                } catch (error) {
                    if (!this.isStreamingUnsupportedError(error)) {
                        throw error;
                    }
                }
            }

            return await this.sendLaneMessagesStrictCompletion({
                entry,
                laneSession,
                messages,
                searchEnabled,
                abortController
            });
        } catch (error) {
            if (!hasRetriedAfterCredit && this.app.isAccessCreditExhaustedError(error)) {
                this.clearLaneAccess(session, entry.laneId);
                await this.chatDB.saveSession(session);
                await this.requestLaneAccess(session, entry, typingId, abortController?.signal || null);
                return this.sendLaneMessagesCompletion({
                    session,
                    entry,
                    messages,
                    searchEnabled,
                    abortController,
                    typingId,
                    hasRetriedAfterCredit: true,
                    streamTarget
                });
            }
            throw error;
        }
    }

    isStreamingUnsupportedError(error) {
        const message = typeof error?.message === 'string' ? error.message : '';
        return /streamCompletion|streaming/i.test(message)
            && /not implemented|not supported|does not support/i.test(message);
    }

    async sendLaneMessagesStrictCompletion({
        entry,
        laneSession,
        messages,
        searchEnabled,
        abortController
    }) {
        return this.inferenceService.sendCompletionStrict(
            messages,
            entry.id,
            laneSession,
            {
                context: entry.laneId === SYNTHESIS_LANE_ID
                    ? `Council synthesis (${entry.name})`
                    : `Parallel response (${entry.name})`,
                signal: abortController?.signal || null,
                searchEnabled,
                reasoningEnabled: this.app.reasoningEnabled,
                reasoningEffort: this.app.reasoningEffort
            }
        );
    }

    async streamLaneMessagesCompletion({
        session,
        entry,
        laneSession,
        messages,
        searchEnabled,
        abortController,
        streamTarget = null
    }) {
        const laneState = streamTarget?.laneState || null;
        const assistantMessage = streamTarget?.assistantMessage || null;
        const persistProgress = typeof streamTarget?.persistProgress === 'function'
            ? streamTarget.persistProgress
            : null;
        const laneId = entry.laneId || null;
        let content = '';
        let reasoning = '';
        let streamingTokenCount = 0;
        let reasoningStartTime = null;
        let reasoningEndTime = null;
        let firstContentChunk = true;
        let lastPersistAt = 0;

        const markRunning = () => {
            if (!laneState) return;
            if (laneState.status === 'pending' || laneState.status === 'waiting') {
                laneState.status = 'running';
            }
            laneState.startedAt = laneState.startedAt || Date.now();
        };
        const persistSnapshot = (force = false) => {
            if (!persistProgress) return;
            const now = Date.now();
            if (!force && now - lastPersistAt < SAVE_INTERVAL_MS) return;
            lastPersistAt = now;
            persistProgress();
        };
        const updateContent = () => {
            if (!assistantMessage?.id || !laneId) return;
            if (this.app.chatArea && this.app.isViewingSession(session.id)) {
                this.app.chatArea.updateCouncilLaneContent(assistantMessage.id, laneId, content);
            }
        };
        const updateReasoning = () => {
            if (!assistantMessage?.id || !laneId) return;
            if (this.app.chatArea && this.app.isViewingSession(session.id)) {
                this.app.chatArea.updateCouncilLaneReasoning(assistantMessage.id, laneId, reasoning);
            }
        };
        const updateReasoningDuration = (duration) => {
            if (!assistantMessage?.id || !laneId) return;
            if (this.app.chatArea && this.app.isViewingSession(session.id)) {
                this.app.chatArea.updateCouncilLaneReasoningSubtitleToDuration(assistantMessage.id, laneId, duration);
            }
        };

        let tokenData;
        try {
            tokenData = await this.inferenceService.streamCompletion(
                messages,
                entry.id,
                laneSession,
                (chunk) => {
                    markRunning();
                    if (!chunk) return;
                    content += chunk;
                    if (laneState) {
                        laneState.response = content;
                        laneState.streamingTokens = Math.ceil(content.length / 4);
                    }
                    if (firstContentChunk && reasoningStartTime && reasoning.length > 0) {
                        firstContentChunk = false;
                        reasoningEndTime = Date.now();
                        const reasoningDuration = reasoningEndTime - reasoningStartTime;
                        if (laneState) {
                            laneState.reasoningDuration = reasoningDuration;
                        }
                        updateReasoningDuration(reasoningDuration);
                    }
                    updateContent();
                    persistSnapshot();
                },
                (tokenUpdate) => {
                    streamingTokenCount = tokenUpdate?.completionTokens || streamingTokenCount || 0;
                },
                [],
                searchEnabled,
                abortController,
                () => {
                    markRunning();
                    persistSnapshot(true);
                },
                (reasoningChunk) => {
                    markRunning();
                    if (!reasoningChunk) return;
                    if (!reasoningStartTime) {
                        reasoningStartTime = Date.now();
                    }
                    reasoning += reasoningChunk;
                    if (laneState) {
                        laneState.reasoning = reasoning;
                        laneState.streamingReasoning = true;
                    }
                    updateReasoning();
                    persistSnapshot();
                },
                this.app.reasoningEnabled,
                this.app.reasoningEffort
            );
        } catch (error) {
            if (laneState) {
                laneState.streamingReasoning = false;
                laneState.streamingTokens = null;
            }
            if (assistantMessage?.id && laneId && this.app.chatArea && this.app.isViewingSession(session.id)) {
                this.app.chatArea.clearCouncilLaneReasoning?.(assistantMessage.id, laneId, {
                    label: isAbortError(error) ? 'Reasoning stopped' : 'Reasoning interrupted'
                });
            }
            persistSnapshot(true);
            throw error;
        }

        if (laneState) {
            laneState.response = content;
            laneState.reasoning = tokenData.reasoning || reasoning || null;
            laneState.streamingReasoning = false;
            laneState.streamingTokens = null;
            if (laneState.reasoning && reasoningStartTime) {
                const finalReasoningEndTime = reasoningEndTime || Date.now();
                laneState.reasoningDuration = finalReasoningEndTime - reasoningStartTime;
            }
        }
        if (assistantMessage?.id && laneId && laneState?.reasoning && this.app.chatArea && this.app.isViewingSession(session.id)) {
            this.app.chatArea.finalizeCouncilLaneReasoning(
                assistantMessage.id,
                laneId,
                laneState.reasoning,
                laneState.reasoningDuration
            );
        }
        persistSnapshot(true);

        return {
            content,
            totalTokens: tokenData.totalTokens,
            promptTokens: tokenData.promptTokens,
            completionTokens: tokenData.completionTokens || streamingTokenCount || null,
            usage: {
                total_tokens: tokenData.totalTokens,
                prompt_tokens: tokenData.promptTokens,
                completion_tokens: tokenData.completionTokens || streamingTokenCount || null
            },
            model: tokenData.model || entry.id,
            reasoning: tokenData.reasoning || reasoning || null,
            reasoningDuration: laneState?.reasoningDuration || null,
            citations: tokenData.citations || null,
            data: {
                choices: [
                    {
                        message: {
                            content,
                            reasoning: tokenData.reasoning || reasoning || null,
                            annotations: tokenData.citations || null
                        }
                    }
                ],
                usage: {
                    total_tokens: tokenData.totalTokens,
                    prompt_tokens: tokenData.promptTokens,
                    completion_tokens: tokenData.completionTokens || streamingTokenCount || null
                }
            }
        };
    }
}
