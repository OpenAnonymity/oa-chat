import { buildChatMessagesFromRequest, buildResponseSkeleton, finalizeResponse, estimateTokenUsage } from '../responseUtils.js';

const DEFAULT_WEBLLM_MODULE_PATH = '/local_inference/vendor/webllm/web-llm.js';

let modulePath = DEFAULT_WEBLLM_MODULE_PATH;
let loaderOverride = null;
let modulePromise = null;
let appConfigOverride = null;

const engineState = {
    engine: null,
    modelId: null,
    loadingPromise: null,
    loadingModelId: null
};

function resolveWebLLMGlobal() {
    if (globalThis.webllm) return globalThis.webllm;
    if (globalThis.WebLLM) return globalThis.WebLLM;
    if (globalThis.mlc?.webllm) return globalThis.mlc.webllm;
    return null;
}

async function loadWebLLMModule() {
    if (modulePromise) return modulePromise;

    modulePromise = (async () => {
        const globalModule = resolveWebLLMGlobal();
        if (globalModule) return globalModule;
        if (loaderOverride) {
            const loaded = await loaderOverride();
            return loaded?.default || loaded;
        }
        if (!modulePath) {
            throw new Error('WebLLM module path is not configured.');
        }
        const baseUrl = typeof document !== 'undefined' ? (document.baseURI || window.location.href) : import.meta.url;
        const moduleUrl = new URL(modulePath, baseUrl).toString();
        const imported = await import(moduleUrl);
        return imported?.default || imported;
    })();

    return modulePromise;
}

function extractModelList(webllmModule) {
    if (!webllmModule) return [];
    const appConfig = appConfigOverride || webllmModule.prebuiltAppConfig || webllmModule.prebuiltAppConfig?.default;
    const modelList = appConfig?.model_list || webllmModule.prebuiltModelList || [];
    return Array.isArray(modelList) ? modelList : [];
}

function resolveAppConfig(webllmModule) {
    return appConfigOverride || webllmModule.prebuiltAppConfig || webllmModule.prebuiltAppConfig?.default;
}

function resolveModelType(webllmModule, model) {
    const rawType = model?.model_type;
    if (rawType === undefined || rawType === null) return 'llm';
    if (typeof rawType === 'string') return rawType.toLowerCase();
    if (typeof rawType === 'number') {
        const modelTypeEnum = webllmModule?.ModelType;
        if (modelTypeEnum && modelTypeEnum[rawType]) {
            return String(modelTypeEnum[rawType]).toLowerCase();
        }
        if (rawType === 1) return 'embedding';
        if (rawType === 2) return 'vlm';
        return 'llm';
    }
    return String(rawType).toLowerCase();
}

function normalizeUsage(usage, inputText, outputText) {
    if (!usage) {
        return estimateTokenUsage(inputText, outputText);
    }

    const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? null;
    const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? null;
    const totalTokens = usage.total_tokens ?? (inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null);

    if (inputTokens === null || outputTokens === null || totalTokens === null) {
        return estimateTokenUsage(inputText, outputText);
    }

    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens
    };
}

async function loadEngine(modelId, { emitStatus } = {}) {
    if (!modelId) {
        throw new Error('A model id is required to initialize WebLLM.');
    }

    if (engineState.engine && engineState.modelId === modelId) {
        return engineState.engine;
    }

    if (engineState.loadingPromise && engineState.loadingModelId === modelId) {
        return engineState.loadingPromise;
    }

    const webllm = await loadWebLLMModule();
    const isReload = !!engineState.engine;

    const initProgressCallback = (progress) => {
        if (!emitStatus) return;
        emitStatus({
            type: 'model.load.progress',
            modelId,
            progress: typeof progress?.progress === 'number' ? progress.progress : null,
            text: progress?.text || progress?.message || ''
        });
    };

    emitStatus?.({ type: 'model.load.start', modelId, mode: isReload ? 'reload' : 'load' });

    engineState.loadingModelId = modelId;
    engineState.loadingPromise = (async () => {
        try {
            if (!engineState.engine || typeof engineState.engine.reload !== 'function') {
                engineState.engine = await webllm.CreateMLCEngine(modelId, {
                    initProgressCallback,
                    appConfig: appConfigOverride || undefined
                });
            } else {
                await engineState.engine.reload(modelId, {
                    initProgressCallback,
                    appConfig: appConfigOverride || undefined
                });
            }
            engineState.modelId = modelId;
            emitStatus?.({ type: 'model.load.ready', modelId });
            return engineState.engine;
        } catch (error) {
            emitStatus?.({ type: 'model.load.error', modelId, error }); 
            throw error;
        } finally {
            engineState.loadingPromise = null;
            engineState.loadingModelId = null;
        }
    })();

    return engineState.loadingPromise;
}

const webllmBackend = {
    id: 'webllm',
    label: 'WebLLM',
    defaultModelId: 'Llama-3.1-8B-Instruct-q4f32_1-MLC',
    defaultModelName: 'Llama 3.1 8B Instruct (q4f32) - WebLLM',
    configure({ loader, modulePath: newPath, appConfig } = {}) {
        if (typeof loader === 'function') {
            loaderOverride = loader;
            modulePromise = null;
        }
        if (typeof newPath === 'string') {
            modulePath = newPath;
            modulePromise = null;
        }
        if (appConfig) {
            appConfigOverride = appConfig;
        }
    },
    async fetchModels() {
        try {
            const webllm = await loadWebLLMModule();
            const modelList = extractModelList(webllm);

            if (modelList.length === 0) {
                throw new Error('No WebLLM models available.');
            }

            return modelList.map(model => ({
                id: model.model_id || model.id || model.name,
                name: model.model_id || model.name || model.id,
                category: 'Local models',
                provider: model.provider || 'WebLLM',
                context_length: model.context_length || model.context_size || model.context_window || null,
                vram_required_MB: model.vram_required_MB || null,
                low_resource_required: model.low_resource_required || false,
                model_lib: model.model_lib || null,
                model_type: resolveModelType(webllm, model)
            }));
        } catch (error) {
            console.warn('WebLLM: unable to load model list, using fallback.', error);
            return [
                {
                    id: webllmBackend.defaultModelId,
                    name: webllmBackend.defaultModelName,
                    category: 'Local models',
                    provider: 'WebLLM'
                }
            ];
        }
    },
    async prepareModel(modelId, options = {}) {
        if (!modelId) {
            throw new Error('A model id is required to prepare WebLLM.');
        }
        await loadEngine(modelId, { emitStatus: options.emitStatus });
        return true;
    },
    async clearModelCache(modelId) {
        if (!modelId) {
            throw new Error('A model id is required to clear cache.');
        }
        const webllm = await loadWebLLMModule();
        const appConfig = resolveAppConfig(webllm);
        if (typeof webllm.deleteModelAllInfoInCache !== 'function') {
            throw new Error('WebLLM cache helpers are not available.');
        }
        await webllm.deleteModelAllInfoInCache(modelId, appConfig);
        return true;
    },
    async clearAllModelCache() {
        const webllm = await loadWebLLMModule();
        const appConfig = resolveAppConfig(webllm);
        if (typeof webllm.deleteModelAllInfoInCache !== 'function') {
            throw new Error('WebLLM cache helpers are not available.');
        }
        const modelList = appConfig?.model_list || [];
        const seen = new Set();
        const failed = [];

        for (const model of modelList) {
            const modelId = model.model_id || model.id || null;
            if (!modelId || seen.has(modelId)) continue;
            seen.add(modelId);
            try {
                await webllm.deleteModelAllInfoInCache(modelId, appConfig);
            } catch (error) {
                failed.push({ modelId, error });
            }
        }

        return { cleared: seen.size - failed.length, failed };
    },
    async createEmbedding(request, options = {}) {
        const engine = await loadEngine(request.model, { emitStatus: options.emitStatus });
        const embeddingRequest = {
            model: request.model,
            input: request.input
        };

        if (request.encoding_format) {
            embeddingRequest.encoding_format = request.encoding_format;
        }

        return engine.embeddings.create(embeddingRequest);
    },
    async createResponse(request, options = {}) {
        const messages = buildChatMessagesFromRequest(request, { systemPrompt: options.systemPrompt || '' });
        const inputText = messages.map(message => message.content).join('\n');
        const response = buildResponseSkeleton(request);
        const engine = await loadEngine(request.model, { emitStatus: options.emitStatus });

        const completion = await engine.chat.completions.create({
            messages,
            temperature: request.temperature,
            top_p: request.top_p,
            max_tokens: request.max_output_tokens ?? undefined,
            seed: Number.isInteger(request.seed) ? request.seed : undefined,
            stream: false
        });

        const outputText = completion?.choices?.[0]?.message?.content || '';
        const usage = normalizeUsage(completion?.usage, inputText, outputText);
        return finalizeResponse(response, outputText, usage);
    },
    async streamResponse(request, options = {}) {
        const messages = buildChatMessagesFromRequest(request, { systemPrompt: options.systemPrompt || '' });
        const inputText = messages.map(message => message.content).join('\n');
        const response = buildResponseSkeleton(request);
        const engine = await loadEngine(request.model, { emitStatus: options.emitStatus });

        if (options.signal?.aborted) {
            const error = new Error('Generation cancelled.');
            error.isCancelled = true;
            throw error;
        }

        const stream = await engine.chat.completions.create({
            messages,
            temperature: request.temperature,
            top_p: request.top_p,
            max_tokens: request.max_output_tokens ?? undefined,
            seed: Number.isInteger(request.seed) ? request.seed : undefined,
            stream: true,
            stream_options: { include_usage: true }
        });

        let outputText = '';
        let usage = null;
        let sequence = 0;

        const outputItem = {
            id: `item_${response.id}`,
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: []
        };

        const contentPart = {
            type: 'output_text',
            text: '',
            annotations: []
        };

        const emitEvent = (event) => {
            if (typeof options.onEvent === 'function') {
                options.onEvent(event);
            }
        };

        emitEvent({
            type: 'response.in_progress',
            sequence_number: sequence++,
            response
        });

        emitEvent({
            type: 'response.output_item.added',
            sequence_number: sequence++,
            output_index: 0,
            item: outputItem
        });

        emitEvent({
            type: 'response.content_part.added',
            sequence_number: sequence++,
            item_id: outputItem.id,
            output_index: 0,
            content_index: 0,
            part: contentPart
        });

        try {
            for await (const chunk of stream) {
                if (options.signal?.aborted) {
                    if (typeof engine.interruptGenerate === 'function') {
                        engine.interruptGenerate();
                    }
                    const error = new Error('Generation cancelled.');
                    error.isCancelled = true;
                    throw error;
                }

                const delta = chunk?.choices?.[0]?.delta?.content || '';
                if (delta) {
                    outputText += delta;
                    emitEvent({
                        type: 'response.output_text.delta',
                        sequence_number: sequence++,
                        item_id: outputItem.id,
                        output_index: 0,
                        content_index: 0,
                        delta,
                        logprobs: null,
                        obfuscation: null
                    });
                }

                if (chunk?.usage) {
                    usage = normalizeUsage(chunk.usage, inputText, outputText);
                }
            }
        } catch (error) {
            if (error?.isCancelled) {
                throw error;
            }
            throw error;
        }

        contentPart.text = outputText;
        emitEvent({
            type: 'response.output_text.done',
            sequence_number: sequence++,
            item_id: outputItem.id,
            output_index: 0,
            content_index: 0,
            text: outputText
        });

        emitEvent({
            type: 'response.content_part.done',
            sequence_number: sequence++,
            item_id: outputItem.id,
            output_index: 0,
            content_index: 0,
            part: contentPart
        });

        outputItem.status = 'completed';
        outputItem.content = [contentPart];

        emitEvent({
            type: 'response.output_item.done',
            sequence_number: sequence++,
            output_index: 0,
            item_id: outputItem.id,
            item: outputItem
        });

        const finalUsage = usage || normalizeUsage(null, inputText, outputText);
        const finalResponse = finalizeResponse(response, outputText, finalUsage, outputItem);

        emitEvent({
            type: 'response.completed',
            sequence_number: sequence++,
            response: finalResponse
        });

        return finalResponse;
    }
};

export default webllmBackend;
