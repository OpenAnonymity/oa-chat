// Shared service identities for trusted, locally bundled product compositions.
// This is separate from the redacted, unprivileged commercial extension context.
export const RUNTIME_API_VERSION = 1;
export { default as networkProxy } from './services/networkProxy.js';
export { default as networkLogger } from './services/networkLogger.js';
export { default as preferencesStore, PREF_KEYS } from './services/preferencesStore.js';
export {
    getFileType, getFileIconSvg, getExtensionFromMimeType, validateFile,
    fileToBase64, extractDocxText, fileToMultimodalContent,
    filesToMultimodalContent, formatFileSize, downloadAllChats
} from './services/fileUtils.js';
export {
    resolveProvider, resolveProviderFromModelId, resolveProviderFromModelReference,
    normalizeOpenRouterModelProviders, getProviderAsset
} from './services/providerRegistry.js';
export { loadModelCatalog, saveModelCatalog } from './services/modelCatalogCache.js';
export * as modelConfiguration from './services/modelConfig.js';
export { standardizeModelDisplayName, resolveModelDisplayName } from './services/modelNames.js';
export { REASONING_EFFORTS, DEFAULT_REASONING_EFFORT, normalizeReasoningEffort } from './services/reasoningConfig.js';
