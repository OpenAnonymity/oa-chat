/**
 * WebLLM Service
 * Provides utilities for loading models and generating responses using WebLLM
 */

import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm";

// Cache for loaded engines
const engineCache = new Map();

/**
 * Load (pull) a model by name
 * @param {string} modelName - Name of the model to load (e.g., "Llama-3.1-8B-Instruct-q4f32_1-MLC")
 * @param {Function} progressCallback - Optional callback to track loading progress
 * @returns {Promise<Object>} - The loaded MLCEngine instance
 */
export async function loadModel(modelName, progressCallback = null) {
    // Check if model is already loaded in cache
    if (engineCache.has(modelName)) {
        console.log(`Model ${modelName} already loaded from cache`);
        return engineCache.get(modelName);
    }

    console.log(`Loading model: ${modelName}...`);

    // Default progress callback if none provided
    const initProgressCallback = progressCallback || ((progress) => {
        console.log(`Loading progress: ${progress.text || ''} ${progress.progress ? `(${(progress.progress * 100).toFixed(1)}%)` : ''}`);
    });

    try {
        // Create and load the engine
        const engine = await CreateMLCEngine(
            modelName,
            {
                initProgressCallback: initProgressCallback
            }
        );

        // Cache the loaded engine
        engineCache.set(modelName, engine);
        console.log(`Model ${modelName} loaded successfully`);

        return engine;
    } catch (error) {
        console.error(`Failed to load model ${modelName}:`, error);
        throw new Error(`Failed to load model ${modelName}: ${error.message}`);
    }
}

/**
 * Generate a response from a model
 * @param {string} modelName - Name of the model to use
 * @param {string} prompt - User prompt/question
 * @param {string} systemPrompt - System prompt to set context (default: "You are a helpful AI assistant.")
 * @param {Function} progressCallback - Optional callback for model loading progress
 * @returns {Promise<string>} - The generated response text
 */
export async function generate(modelName, prompt, systemPrompt = "You are a helpful AI assistant.", progressCallback = null) {
    if (!modelName || !prompt) {
        throw new Error("modelName and prompt are required");
    }

    try {
        // Load the model (will use cache if already loaded)
        const engine = await loadModel(modelName, progressCallback);

        // Prepare messages
        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt }
        ];

        console.log(`Generating response for prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`);

        // Generate response
        const reply = await engine.chat.completions.create({
            messages,
            temperature: 0.7,
            max_tokens: 2048
        });

        const responseText = reply.choices[0].message.content;
        console.log(`Generated ${reply.usage.completion_tokens} tokens`);

        return responseText;
    } catch (error) {
        console.error('Generation failed:', error);
        throw new Error(`Failed to generate response: ${error.message}`);
    }
}

/**
 * Generate a response with streaming
 * @param {string} modelName - Name of the model to use
 * @param {string} prompt - User prompt/question
 * @param {string} systemPrompt - System prompt to set context
 * @param {Function} onChunk - Callback function called with each chunk of text
 * @param {Function} progressCallback - Optional callback for model loading progress
 * @returns {Promise<string>} - The complete generated response text
 */
export async function generateStream(modelName, prompt, systemPrompt = "You are a helpful AI assistant.", onChunk = null, progressCallback = null) {
    if (!modelName || !prompt) {
        throw new Error("modelName and prompt are required");
    }

    try {
        // Load the model (will use cache if already loaded)
        const engine = await loadModel(modelName, progressCallback);

        // Prepare messages
        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt }
        ];

        console.log(`Generating streaming response for prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`);

        // Generate streaming response
        const chunks = await engine.chat.completions.create({
            messages,
            temperature: 0.7,
            max_tokens: 2048,
            stream: true,
            stream_options: { include_usage: true }
        });

        let fullResponse = "";
        for await (const chunk of chunks) {
            const content = chunk.choices[0]?.delta.content || "";
            if (content) {
                fullResponse += content;
                if (onChunk) {
                    onChunk(content, fullResponse);
                }
            }
            
            // Log usage info from last chunk
            if (chunk.usage) {
                console.log(`Generated ${chunk.usage.completion_tokens} tokens`);
            }
        }

        return fullResponse;
    } catch (error) {
        console.error('Streaming generation failed:', error);
        throw new Error(`Failed to generate streaming response: ${error.message}`);
    }
}

/**
 * Unload a model from cache
 * @param {string} modelName - Name of the model to unload
 */
export function unloadModel(modelName) {
    if (engineCache.has(modelName)) {
        console.log(`Unloading model: ${modelName}`);
        engineCache.delete(modelName);
        return true;
    }
    return false;
}

/**
 * Get list of currently loaded models
 * @returns {Array<string>} - Array of loaded model names
 */
export function getLoadedModels() {
    return Array.from(engineCache.keys());
}

/**
 * Clear all cached models
 */
export function clearCache() {
    console.log(`Clearing all cached models (${engineCache.size} models)`);
    engineCache.clear();
}

