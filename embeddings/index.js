export { createEmbeddingSource, EmbeddingSource, registerEmbeddingBackend, availableEmbeddingBackends, createOpenAIEmbeddingBackend } from './embeddingService.js';
export { normalizeEmbeddingResponse } from './utils.js';
export { default as localInferenceBackend, createLocalInferenceBackend } from './backends/localInferenceBackend.js';
export { default as openAIBackend } from './backends/openaiBackend.js';
