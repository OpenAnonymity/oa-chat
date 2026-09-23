// Lightweight model-tier seam for trusted, locally bundled compositions.
// Consumers must await live pricing before issuing access; cached and heuristic
// ticket costs remain useful for presentation during catalog loading.
export {
    getTicketCost, ensureModelTiersReady, initModelTiers, onModelTiersUpdate
} from './services/modelTiers.js';
