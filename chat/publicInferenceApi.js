// Public, UI-independent composition surface. Keep product integrations out of
// private backend/controller modules so upstream refactors remain internal.
export { OpenRouterAPI } from './api.js';
export { createInferenceService } from './services/inference/inferenceService.js';
export { acquireSessionAccess, acquireVerifiedAccess } from './application/accessController.js';
export { consumeSseBody } from './services/inference/sseStream.js';
