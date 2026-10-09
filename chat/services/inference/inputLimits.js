import { getSystemPrompt } from './systemPrompt.js';
import { inferenceError } from './reliability.js';

export const MAX_INFERENCE_BYTES = 32 * 1024 * 1024;
export const MAX_INFERENCE_IMAGES = 32;
export const MAX_ESTIMATED_INPUT_TOKENS = 64_000;

// A local text estimate, not the provider's tokenizer or a provider-enforced
// limit. Opaque media and provider-side OCR/search expansion cannot be counted.
export function assertEstimatedInputTokens(textChars, messageCount = 0) {
    const estimatedTokens = Math.ceil(textChars / 4) + messageCount * 8;
    if (estimatedTokens > MAX_ESTIMATED_INPUT_TOKENS) {
        throw inferenceError('INFERENCE_INPUT_TOKEN_LIMIT',
            'This conversation exceeds OA Chat’s 64,000 estimated input-token limit. Start a new chat with a short summary, or shorten the conversation and attachments. Your existing chat is kept.');
    }
    return estimatedTokens;
}

// These are OA safety limits. Provider-specific media/context limits may be lower.
export function validateInferenceInput(messages, model = {}, files = []) {
    let bytes = 0, textChars = 0, images = 0;
    const count = value => {
        if (typeof value !== 'string') return;
        if (bytes + value.length > MAX_INFERENCE_BYTES) throw inferenceError('INFERENCE_INPUT_TOO_LARGE', 'This conversation exceeds OA’s 32 MB request limit. Start a shorter chat or remove attachments.');
        bytes += new TextEncoder().encode(value).byteLength;
        if (bytes > MAX_INFERENCE_BYTES) throw inferenceError('INFERENCE_INPUT_TOO_LARGE', 'This conversation exceeds OA’s 32 MB request limit. Start a shorter chat or remove attachments.');
    };
    for (const message of messages || []) {
        const content = message.content;
        if (typeof content === 'string') { count(content); textChars += content.length; }
        else if (Array.isArray(content)) for (const part of content) {
            if (part?.type === 'text') { count(part.text); textChars += part.text?.length || 0; }
            if (part?.type === 'image_url') { images++; count(part.image_url?.url); }
            if (part?.type === 'file') count(part.file?.file_data);
            if (part?.type === 'input_audio') count(part.input_audio?.data);
        }
        // Preflight also accepts persisted messages before multimodal conversion.
        for (const file of message.files || []) {
            count(file.extractedText || file.dataUrl);
            if (file.detectedType === 'text') textChars += Math.floor((file.dataUrl?.length || 0) * 0.75);
            if (file.extractedText) textChars += file.extractedText.length;
            if (file.type?.startsWith('image/') || file.detectedType === 'image') images++;
        }
    }
    for (const file of files) {
        bytes += Math.ceil((file.size || 0) * 4 / 3);
        if (file.type?.startsWith('image/')) images++;
    }
    if (bytes > MAX_INFERENCE_BYTES) throw inferenceError('INFERENCE_INPUT_TOO_LARGE', 'This conversation exceeds OA’s 32 MB request limit. Start a shorter chat or remove attachments.');
    if (images > MAX_INFERENCE_IMAGES) throw inferenceError('INFERENCE_TOO_MANY_IMAGES', 'This conversation exceeds OA’s 32-image request limit. Start a shorter chat or remove older images.');
    const estimatedTokens = assertEstimatedInputTokens(textChars, (messages || []).length);
    const context = Number(model?.context_length);
    // Approximate text-only check; images/PDF OCR vary by provider and must not
    // be represented as an exact token count. The provider remains authoritative.
    if (context > 0 && estimatedTokens > context) {
        throw inferenceError('INFERENCE_CONTEXT_TOO_LARGE', 'This conversation’s estimated text size exceeds the model’s context limit. Start a shorter chat or choose a model with a larger context.');
    }
}

export function validateSerializedInferenceBody(body) {
    if (body.length > MAX_INFERENCE_BYTES || new TextEncoder().encode(body).byteLength > MAX_INFERENCE_BYTES) {
        throw inferenceError('INFERENCE_INPUT_TOO_LARGE', 'This conversation exceeds OA’s 32 MB request limit. Start a shorter chat or remove attachments.');
    }
}

// Composer and API preflights must reserve exactly the same system instructions
// before accepting a draft or acquiring a credential.
export function validateConversationInput(messages, model = {}, files = [], modelId = model?.id) {
    const systemPrompt = getSystemPrompt(modelId);
    validateInferenceInput(systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...messages]
        : messages, model, files);
}
