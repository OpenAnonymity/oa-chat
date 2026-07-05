import { normalizeMemoryRetrievalFailureReason } from './memoryRetrievalError.js';

function serializeMemoryRetrievalFailure(failure) {
    return normalizeMemoryRetrievalFailureReason(failure);
}

export function buildBaseSharePayload(session, messages, options = {}) {
    const defaultBackendId = options.defaultBackendId || '';
    return {
        version: 1,
        session: {
            title: session.title,
            model: session.model,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            searchEnabled: session.searchEnabled,
            inferenceBackend: session.inferenceBackend || defaultBackendId
        },
        messages: messages.map(m => {
            const msg = {
                role: m.role,
                content: m.content,
                timestamp: m.timestamp,
                model: m.model,
                files: m.files,
                images: m.images,
                reasoning: m.reasoning,
                reasoningDuration: m.reasoningDuration,
                tokenCount: m.tokenCount
            };

            // Preserve memory agent fields for proper rendering in shared view.
            if (m.isLocalOnly) msg.isLocalOnly = true;
            if (Array.isArray(m.agentTrace) && m.agentTrace.length > 0) {
                msg.agentTrace = m.agentTrace;
            }
            if (m.memoryRetrievalAssessment) {
                msg.memoryRetrievalAssessment = m.memoryRetrievalAssessment;
            }
            const memoryRetrievalFailure = serializeMemoryRetrievalFailure(m.memoryRetrievalFailure);
            if (memoryRetrievalFailure) {
                msg.memoryRetrievalFailure = memoryRetrievalFailure;
            }
            if (m.ciPromptDraft) {
                msg.ciPromptDraft = m.ciPromptDraft;
                // Normalize pending approval to approved for shared context
                // because recipients cannot interact with approval UI.
                const status = m.memoryApprovalPrompt?.status;
                if (status === 'approved' || status === 'pending') {
                    msg.memoryApprovalPrompt = { status: 'approved' };
                }
            }

            return msg;
        })
    };
}
