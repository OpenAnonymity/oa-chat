import { localInferenceService } from '../../local_inference/index.js';
import { chatDB } from '../db.js';
import ticketClient from './ticketClient.js';

const SCRUBBER_BASE_URL = 'https://inference.tinfoil.sh';
const SCRUBBER_BACKEND_ID = 'tinfoil';
const DEFAULT_SCRUBBER_MODEL = 'gpt-oss-120b';
const SCRUBBER_MODEL_SETTING_KEY = 'scrubberModel';
const CONFIDENTIAL_KEY_TICKETS_REQUIRED = 2;

const REDACT_PROMPT = [
    'Rewrite the following prompt in a privacy preserving way.',
    'Remove all PII and sensitive data.',
    'Keep the prompt\'s meaning and intention as close to the original as possible.',
    'Do not mention redaction, rewriting, or privacy preservation.',
    'Output ONLY the rewritten prompt.'
].join('\n');

const RESTORE_PROMPT = [
    'You are given:',
    '(1) the original prompt,',
    '(2) the redacted prompt,',
    '(3) a response generated from the redacted prompt.',
    'Restore as much removed PII/sensitive detail as possible into the response using ONLY the original prompt.',
    'Do not invent new facts. Do not change meaning, tone, or intent.',
    'Output ONLY the restored response.'
].join('\n');

function buildResponsesRequest({ model, instructions = '', inputText, temperature = 0.2, topP = 0.9 }) {
    return {
        model,
        instructions,
        input: [
            {
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: inputText || ''
                    }
                ]
            }
        ],
        temperature,
        top_p: topP,
        stream: false
    };
}

function wrapPrompt(prefix, content) {
    return [
        prefix,
        '',
        '```<real user prompt>',
        content || '',
        '</real user prompt>```'
    ].join('\n');
}

function wrapRestorePayload(prefix, { original, redacted, response }) {
    return [
        prefix,
        '',
        '```<original prompt>',
        original || '(empty)',
        '</original prompt>```',
        '',
        '```<redacted prompt>',
        redacted || '(empty)',
        '</redacted prompt>```',
        '',
        '```<response>',
        response || '',
        '</response>```'
    ].join('\n');
}

function extractOutputText(response) {
    if (!response) return '';
    if (typeof response.output_text === 'string') return response.output_text;
    const output = Array.isArray(response.output) ? response.output : [];
    for (const item of output) {
        const content = Array.isArray(item?.content) ? item.content : [];
        for (const part of content) {
            if (part?.type === 'output_text' && typeof part.text === 'string') {
                return part.text;
            }
        }
    }
    return '';
}

class ScrubberService {
    constructor() {
        this.models = [];
        this.modelsLoaded = false;
        this.modelsPromise = null;
        this.selectedModel = null;
    }

    async init() {
        await this.loadSelectedModel();
    }

    async ensureBackend(apiKey) {
        if (!apiKey) return;
        localInferenceService.configureBackend(SCRUBBER_BACKEND_ID, {
            baseUrl: SCRUBBER_BASE_URL,
            apiKey
        });
    }

    /**
     * Request a confidential key from org using inference tickets.
     * Delegates to ticketClient for the actual request.
     * @returns {Promise<Object>} Key data with key, expires_at, etc.
     */
    async requestConfidentialKey() {
        const ticketCount = ticketClient.getTicketCount();
        if (ticketCount < CONFIDENTIAL_KEY_TICKETS_REQUIRED) {
            throw new Error(`Not enough tickets. Need ${CONFIDENTIAL_KEY_TICKETS_REQUIRED}, have ${ticketCount}`);
        }
        return ticketClient.requestConfidentialApiKey('scrubber', CONFIDENTIAL_KEY_TICKETS_REQUIRED);
    }

    getSessionScrubberKeyInfo(session) {
        return session?.scrubberKeyInfo || null;
    }

    isScrubberKeyExpired(keyInfo) {
        if (!keyInfo) return true;
        const expiresAt = keyInfo.expiresAt || keyInfo.expires_at || keyInfo.expires_at_unix;
        if (!expiresAt) return true;
        const expiry = typeof expiresAt === 'number'
            ? new Date(expiresAt * 1000)
            : new Date(expiresAt);
        return expiry <= new Date(Date.now() + 60000);
    }

    hasValidScrubberKey(session) {
        if (!session?.scrubberKey) return false;
        return !this.isScrubberKeyExpired(this.getSessionScrubberKeyInfo(session));
    }

    /**
     * Ensure we have a valid API key for the given chat session.
     * Keys are stored on the session object and persisted via chatDB.
     * @param {Object} session - The current chat session object
     */
    async ensureApiKey(session) {
        if (!session) {
            throw new Error('No session available for scrubber key.');
        }

        if (this.hasValidScrubberKey(session)) {
            await this.ensureBackend(session.scrubberKey);
            return session.scrubberKey;
        }

        try {
            const keyData = await this.requestConfidentialKey();
            session.scrubberKey = keyData.key;
            session.scrubberKeyInfo = keyData;
            await chatDB.saveSession(session);
            await this.ensureBackend(keyData.key);
            return keyData.key;
        } catch (error) {
            console.error('Failed to acquire confidential key:', error);
            throw new Error(`Failed to acquire confidential key: ${error.message}`);
        }
    }

    async loadSelectedModel() {
        try {
            if (typeof chatDB !== 'undefined') {
                if (!chatDB.db && typeof chatDB.init === 'function') {
                    await chatDB.init();
                }
                const stored = await chatDB.getSetting(SCRUBBER_MODEL_SETTING_KEY);
                if (stored) {
                    this.selectedModel = stored;
                    return stored;
                }
            }
        } catch (error) {
            console.warn('Failed to load scrubber model preference:', error);
        }
        this.selectedModel = DEFAULT_SCRUBBER_MODEL;
        return this.selectedModel;
    }

    async setSelectedModel(modelId) {
        this.selectedModel = modelId || DEFAULT_SCRUBBER_MODEL;
        if (typeof chatDB !== 'undefined') {
            try {
                if (!chatDB.db && typeof chatDB.init === 'function') {
                    await chatDB.init();
                }
                await chatDB.saveSetting(SCRUBBER_MODEL_SETTING_KEY, this.selectedModel);
            } catch (error) {
                console.warn('Failed to save scrubber model preference:', error);
            }
        }
    }

    getSelectedModel() {
        return this.selectedModel || DEFAULT_SCRUBBER_MODEL;
    }

    getModeLabel() {
        return SCRUBBER_BACKEND_ID === 'tinfoil' ? 'confidential model' : 'local model';
    }

    async fetchModels(force = false) {
        if (this.modelsLoaded && !force) return this.models;
        if (this.modelsPromise && !force) return this.modelsPromise;

        this.modelsPromise = (async () => {
            // Model list endpoint is public - no API key needed
            const models = await localInferenceService.fetchModels(SCRUBBER_BACKEND_ID);
            this.models = Array.isArray(models) ? models : [];
            this.modelsLoaded = true;
            return this.models;
        })();

        return this.modelsPromise;
    }

    applyRedactionToMessages(messages, redactedText) {
        if (!Array.isArray(messages) || !redactedText) return messages;
        const updated = messages.map((msg) => ({ ...msg }));
        for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i]?.role !== 'user') continue;
            const content = updated[i].content;
            if (Array.isArray(content)) {
                const nextContent = content.map((part) => {
                    if (part?.type === 'text' || part?.type === 'input_text') {
                        return { ...part, text: redactedText };
                    }
                    return part;
                });
                updated[i].content = nextContent;
            } else {
                updated[i].content = redactedText;
            }
            break;
        }
        return updated;
    }

    async redactPrompt(text, session) {
        const inputText = typeof text === 'string' ? text : '';
        if (!inputText.trim()) {
            return { success: false, text: '' };
        }
        await this.ensureApiKey(session);

        const request = buildResponsesRequest({
            model: this.getSelectedModel(),
            instructions: '',
            inputText: wrapPrompt(REDACT_PROMPT, inputText)
        });

        const response = await localInferenceService.createResponse(request, {
            backendId: SCRUBBER_BACKEND_ID
        });

        return { success: true, text: extractOutputText(response) };
    }

    async restoreResponse({ originalPrompt, redactedPrompt, responseText, session }) {
        const original = typeof originalPrompt === 'string' ? originalPrompt : '';
        const redacted = typeof redactedPrompt === 'string' ? redactedPrompt : '';
        const responseBody = typeof responseText === 'string' ? responseText : '';
        if (!responseBody.trim()) {
            return { success: false, text: '' };
        }

        await this.ensureApiKey(session);

        const request = buildResponsesRequest({
            model: this.getSelectedModel(),
            instructions: '',
            inputText: wrapRestorePayload(RESTORE_PROMPT, {
                original,
                redacted,
                response: responseBody
            })
        });

        const response = await localInferenceService.createResponse(request, {
            backendId: SCRUBBER_BACKEND_ID
        });

        return { success: true, text: extractOutputText(response) };
    }
}

const scrubberService = new ScrubberService();

export default scrubberService;
