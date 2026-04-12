import { createMemoryBank, stripUserDataTags } from '../nanomem/browser.js';
import { DEFAULT_MEMORY_AGENT_MODEL, isAllowedConfidentialModel } from './confidentialModelConfig.js';

const TINFOIL_BASE_URL = 'https://inference.tinfoil.sh/v1';
const MEMORY_KEY_GRACE_MS = 60_000;

export const CONFIDENTIAL_KEY_TICKETS = 2;

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

export async function ensureMemoryKey(session, client) {
    if (!session) {
        throw new Error('No session available for memory key.');
    }
    if (hasValidMemoryKey(session)) {
        return session.memoryKey;
    }

    if (client.getTicketCount() < CONFIDENTIAL_KEY_TICKETS) {
        return null;
    }

    const keyData = await client.requestConfidentialApiKey(CONFIDENTIAL_KEY_TICKETS);
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
    if (error.status === 401 || error.status === 403) return true;
    const message = String(error.message || error);
    return message.includes('401') || message.includes('403');
}

export function stripMemoryPromptUserData(text) {
    return stripUserDataTags(text);
}

function resolveMemoryAgentModel(model) {
    return isAllowedConfidentialModel(model) ? String(model).trim() : DEFAULT_MEMORY_AGENT_MODEL;
}

function createConfidentialMemoryBank({ apiKey, model, onProgress, onModelText, onToolCall }) {
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

export async function augmentQuery({ query, conversationText, apiKey, model, onProgress, onModelText }) {
    const memoryBank = createConfidentialMemoryBank({
        apiKey,
        model,
        onProgress,
        onModelText
    });

    await memoryBank.init();
    return memoryBank.augmentQuery(query, conversationText);
}

export async function importData({ input, apiKey, model, options }) {
    const memoryBank = createConfidentialMemoryBank({
        apiKey,
        model
    });

    await memoryBank.init();
    return memoryBank.importData(input, options);
}

export async function ingestMessages({ messages, apiKey, model, options }) {
    const memoryBank = createConfidentialMemoryBank({
        apiKey,
        model
    });

    await memoryBank.init();
    return memoryBank.ingest(messages, options);
}
