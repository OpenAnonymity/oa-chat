import { DEFAULT_MEMORY_AGENT_MODEL, isAllowedConfidentialModel } from './confidentialModelConfig.js';
import { getMemoryRetrievalErrorStatus } from './memoryRetrievalError.js';

const TINFOIL_BASE_URL = 'https://inference.tinfoil.sh/v1';
const MEMORY_KEY_GRACE_MS = 60_000;

export const CONFIDENTIAL_KEY_TICKETS = 1;

function createAbortError() {
    const error = new Error('Request aborted');
    error.name = 'AbortError';
    error.isCancelled = true;
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

function getExpiresAt(keyInfo) {
    if (!keyInfo) return null;
    if (typeof keyInfo.expires_at_unix === 'number') return keyInfo.expires_at_unix * 1000;
    const raw = keyInfo.expiresAt || keyInfo.expires_at || null;
    if (!raw) return null;
    return typeof raw === 'number' ? raw * 1000 : new Date(raw).getTime();
}

export function hasValidMemoryKey(session) {
    if (!session?.memoryKey) return false;
    const expiresAt = getExpiresAt(session.memoryKeyInfo);
    if (!expiresAt || Number.isNaN(expiresAt)) return true;
    return expiresAt > (Date.now() + MEMORY_KEY_GRACE_MS);
}

export async function ensureMemoryKey(session, client, options = {}) {
    if (!session) {
        throw new Error('No session available for memory key.');
    }
    const { signal = null } = options;
    throwIfAborted(signal);

    if (hasValidMemoryKey(session)) {
        return session.memoryKey;
    }

    throwIfAborted(signal);
    if (client.getTicketCount() < CONFIDENTIAL_KEY_TICKETS) {
        return null;
    }

    const keyData = await client.requestConfidentialApiKey(CONFIDENTIAL_KEY_TICKETS, { signal });
    throwIfAborted(signal);

    session.memoryKey = keyData.key;
    session.memoryKeyInfo = keyData;
    return keyData.key;
}

export function invalidateMemoryKey(session) {
    if (!session) return;
    session.memoryKey = null;
    session.memoryKeyInfo = null;
}

export function isMemoryAuthError(error) {
    if (!error) return false;
    const status = getMemoryRetrievalErrorStatus(error);
    if (status === 401 || status === 403) return true;
    const message = String(error.message || error);
    return message.includes('401') || message.includes('403');
}

export function stripMemoryPromptUserData(text) {
    return String(text || '')
        .replace(/\[\[user_data\]\]/g, '')
        .replace(/\[\[\/user_data\]\]/g, '');
}

function resolveMemoryAgentModel(model) {
    return isAllowedConfidentialModel(model) ? String(model).trim() : DEFAULT_MEMORY_AGENT_MODEL;
}

async function loadNanomemBrowser(signal = null) {
    throwIfAborted(signal);
    const module = await import('../nanomem/browser.js');
    throwIfAborted(signal);
    return module;
}

async function createConfidentialMemoryBank({ apiKey, model, onProgress, onModelText, onToolCall, signal = null }) {
    const { createMemoryBank } = await loadNanomemBrowser(signal);
    throwIfAborted(signal);
    return createMemoryBank({
        llm: {
            apiKey,
            baseUrl: TINFOIL_BASE_URL,
            provider: 'openai'
        },
        model: resolveMemoryAgentModel(model),
        storage: 'indexeddb',
        onProgress,
        onModelText,
        onToolCall
    });
}

export async function augmentQuery({ query, conversationText, apiKey, model, onProgress, onModelText, signal }) {
    throwIfAborted(signal);
    const memoryBank = await createConfidentialMemoryBank({
        apiKey,
        model,
        onProgress,
        onModelText,
        signal
    });

    await memoryBank.init();
    throwIfAborted(signal);
    return memoryBank.augmentQuery(query, conversationText, { signal });
}

export async function retrieveAdaptive({ query, alreadyRetrievedContext, conversationText, apiKey, model, onProgress, onModelText, signal }) {
    throwIfAborted(signal);
    const memoryBank = await createConfidentialMemoryBank({
        apiKey,
        model,
        onProgress,
        onModelText,
        signal
    });

    await memoryBank.init();
    throwIfAborted(signal);
    return memoryBank.retrieveAdaptive(query, alreadyRetrievedContext, conversationText, { signal });
}

export async function augmentQueryAdaptive({ query, alreadyRetrievedContext, conversationText, apiKey, model, onProgress, onModelText, signal }) {
    throwIfAborted(signal);
    const memoryBank = await createConfidentialMemoryBank({
        apiKey,
        model,
        onProgress,
        onModelText,
        signal
    });

    await memoryBank.init();
    throwIfAborted(signal);
    return memoryBank.augmentQueryAdaptive(query, alreadyRetrievedContext, conversationText, { signal });
}

export async function importData({ input, apiKey, model, options }) {
    throwIfAborted(options?.signal);
    const memoryBank = await createConfidentialMemoryBank({
        apiKey,
        model,
        signal: options?.signal
    });

    await memoryBank.init();
    throwIfAborted(options?.signal);
    return memoryBank.importData(input, options);
}

export async function ingestMessages({ messages, apiKey, model, options }) {
    throwIfAborted(options?.signal);
    const memoryBank = await createConfidentialMemoryBank({
        apiKey,
        model,
        signal: options?.signal
    });

    await memoryBank.init();
    throwIfAborted(options?.signal);
    return memoryBank.ingest(messages, options);
}
